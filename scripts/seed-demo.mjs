// Generates internally-consistent demo crawl rows for local dashboard testing.
//
//   node scripts/seed-demo.mjs [count] [outFile]
//
// `npm run dev:local` runs this to (re)generate dashboard/seed.local.sql on the
// fly, then loads it into the LOCAL D1 (Miniflare), never the remote DB. The
// .sql is a build artifact (gitignored), not committed — this script is the
// source of truth.
//
// Deterministic: a fixed RNG seed (override with SEED=<n>) means every run
// produces the same dataset, just anchored to the current time so rows stay
// recent. index_status is derived from the other fields with the SAME rules the
// worker uses (worker/src/index.js computeIndexStatus), so the dataset is
// coherent: non_200 / blocked_by_meta / non_canonical / indexable.

const TARGET = Number(process.argv[2]) || 2200;
const OUT = process.argv[3] || new URL('../dashboard/seed.local.sql', import.meta.url).pathname;
const SEED = Number(process.env.SEED) || 1337;

const HOST = 'https://openseotest.org';

// Seeded PRNG (mulberry32) so the dataset is reproducible across runs.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(SEED);

// Bots weighted roughly like real traffic: Google leads, then Bing, then AI bots.
const BOTS = [
  ['Googlebot', 26], ['Googlebot-Smartphone', 20], ['Bingbot', 12],
  ['GPTBot', 9], ['ClaudeBot', 7], ['PerplexityBot', 6], ['Applebot', 5],
  ['YandexBot', 4], ['OAI-SearchBot', 3], ['DuckDuckBot', 2],
  ['Googlebot-Image', 2], ['GoogleOther', 2], ['ChatGPT-User', 1], ['Claude-Web', 1],
];
const BOT_PICK = BOTS.flatMap(([n, w]) => Array(w).fill(n));

const rand = (n) => Math.floor(random() * n);
const pick = (arr) => arr[rand(arr.length)];
const chance = (p) => random() < p;
const between = (lo, hi) => lo + rand(hi - lo + 1);

const SLUGS = [
  'javascript-rendering-test', 'googlebot-vs-react', 'hydration-and-seo',
  'core-web-vitals-deep-dive', 'spa-crawlability', 'lazy-loading-images',
  'structured-data-guide', 'canonical-tags-explained', 'hreflang-mistakes',
  'robots-meta-directives', 'log-file-analysis', 'crawl-budget-myths',
  'ai-bots-and-seo', 'gptbot-explained', 'rendering-budget', 'edge-rendering',
  'dynamic-rendering', 'prerendering-tradeoffs', 'noscript-fallbacks',
  'meta-description-length', 'title-tag-testing', 'pagination-seo',
  'faceted-navigation', 'internal-linking', 'sitemap-best-practices',
];

// Build a catalogue of unique URLs, each with stable per-URL metadata.
function buildPages() {
  const pages = [];
  const push = (path, opts) => pages.push({ url: HOST + path, ...opts });

  push('/', { kind: 'home', title: 'OpenSeoTest - Free SEO & AI bot rendering tests',
    sd: ['WebSite', 'Organization'], intl: true });
  for (const p of ['about', 'pricing', 'contact', 'docs', 'blog', 'tests'])
    push(`/${p}`, { kind: 'section', title: `${cap(p)} - OpenSeoTest`, sd: ['WebPage'] });

  for (const s of SLUGS)
    push(`/blog/${s}`, { kind: 'article', title: `${titleize(s)} | OpenSeoTest Blog`,
      sd: ['Article', 'BreadcrumbList'], intl: chance(0.25) });

  for (const s of SLUGS.slice(0, 18))
    push(`/tests/${s}`, { kind: 'test', title: `Test: ${titleize(s)}`,
      sd: ['TechArticle', 'BreadcrumbList'] });

  for (const s of ['rendering', 'crawling', 'indexing', 'sitemaps', 'robots-txt'])
    push(`/docs/${s}`, { kind: 'doc', title: `Docs: ${cap(s)}`, sd: ['TechArticle'] });

  // Tag/category pages with ?page=N pagination → page 2+ canonicalises to page 1.
  for (const t of ['rendering', 'ai-bots', 'core-web-vitals', 'structured-data'])
    for (const pg of [1, 2, 3])
      push(`/tag/${t}${pg > 1 ? `?page=${pg}` : ''}`, { kind: 'tag', tag: t, page: pg,
        title: `${titleize(t)} articles${pg > 1 ? ` - page ${pg}` : ''}`, sd: ['CollectionPage'] });

  // Intentionally non-indexable utility pages (noindex meta).
  for (const p of ['/search?q=seo', '/cart', '/login', '/account/settings', '/admin'])
    push(p, { kind: 'noindex', title: `${cap(p.replace(/[/?].*/, '').slice(1) || 'search')} - OpenSeoTest`, sd: [] });

  // Pages that tend to be broken / flaky (drives non_200 + NULL-status rows).
  for (const p of ['/blog/deleted-post', '/old-landing-page', '/tests/removed-test', '/promo/expired'])
    push(p, { kind: 'broken', title: '', sd: [] });

  return pages;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const titleize = (s) => s.split('-').map(cap).join(' ');

// Derive index_status exactly like the worker.
function indexStatus(status, metaRobots, metaGooglebot, canonical, finalUrl) {
  if (status !== 200) return 'non_200';
  const sel = metaGooglebot.length ? metaGooglebot : metaRobots;
  if (sel.includes('noindex') || sel.includes('none')) return 'blocked_by_meta';
  if (canonical && canonical !== finalUrl) return 'non_canonical';
  return 'indexable';
}

// One visit (row) of a page by a bot at time ts. `epoch` lets evolving pages
// flip a field partway through the window (0 = early, 1 = late).
function makeRow(page, bot, ts, epoch) {
  let status = 200;
  let metaRobots = [];
  const metaGooglebot = [];
  let canonical = page.url;
  let title = page.title;
  let desc = `Learn about ${titleize((page.url.split('/').pop() || 'seo').replace(/\?.*/, ''))} with hands-on tests and examples.`;
  let h1 = title ? [title.replace(/ [|\-–].*$/, '')] : [];
  const h2 = [];
  let sd = page.sd.slice();

  switch (page.kind) {
    case 'noindex':
      metaRobots = chance(0.5) ? ['noindex', 'nofollow'] : ['noindex'];
      break;
    case 'tag':
      if (page.page > 1) canonical = `${HOST}/tag/${page.tag}`; // paginated → canonical to page 1
      break;
    case 'broken': {
      // Mostly 404, sometimes 500, occasionally origin unreachable (NULL status).
      const r = random();
      status = r < 0.6 ? 404 : r < 0.85 ? 500 : null;
      title = status === 404 ? '404 Not Found' : status === 500 ? '500 Server Error' : null;
      h1 = title ? [title] : [];
      desc = null; canonical = null; sd = [];
      break;
    }
    case 'article':
    case 'test':
      h2.push('Overview', 'How the test works', 'Results', 'Takeaways');
      break;
    case 'doc':
      h2.push('Introduction', 'Configuration', 'Examples');
      break;
    case 'home':
      h2.push('What we test', 'Latest articles', 'For developers');
      break;
  }

  // Evolving content: a slice of articles change title/H1 late in the window,
  // and one flips into noindex (status flip in the dashboard).
  if (page.evolveTitle && epoch === 1 && title) {
    title = title.replace('| OpenSeoTest Blog', '- Updated 2026 | OpenSeoTest Blog');
    h1 = [title.replace(/ [|\-–].*$/, '')];
  }
  if (page.evolveNoindex && epoch === 1) metaRobots = ['noindex'];

  const hreflangs = page.intl
    ? [{ lang: 'en', href: page.url }, { lang: 'de', href: page.url.replace(HOST, HOST + '/de') },
       { lang: 'x-default', href: page.url }]
    : [];

  // Doc/section pages occasionally set an explicit indexing googlebot directive.
  if ((page.kind === 'doc' || page.kind === 'section') && chance(0.15)) metaGooglebot.push('index', 'follow');

  let rt = between(70, 900);
  if (page.kind === 'home') rt = between(120, 400);
  if (chance(0.04)) rt = between(1500, 5200); // slow outliers
  if (status === null) rt = between(8000, 15000); // timeouts before failure

  const idx = indexStatus(status, metaRobots, metaGooglebot, canonical, page.url);

  return {
    url: page.url, status, response_time_ms: rt, title,
    meta_description: status === 200 ? desc : null,
    canonical: status === 200 ? canonical : null,
    hreflangs, h1, h2, meta_robots: metaRobots, meta_googlebot: metaGooglebot,
    structured_data_types: status === 200 ? sd : [], index_status: idx,
    bot_name: bot, ts,
  };
}

function generate(target) {
  const pages = buildPages();
  // Mark a handful of pages as evolving so time-series queries return results.
  const articles = pages.filter((p) => p.kind === 'article');
  for (const p of articles.slice(0, 8)) p.evolveTitle = true;
  for (const p of articles.slice(8, 12)) p.evolveNoindex = true;

  const now = Date.now();
  const WINDOW = 60 * 24 * 3600 * 1000; // 60 days

  const rows = [];
  while (rows.length < target) {
    for (const page of pages) {
      if (rows.length >= target) break;
      const visits = between(4, 28); // visits for this URL across the window
      const times = Array.from({ length: visits }, () => now - rand(WINDOW)).sort((a, b) => a - b);
      const evolving = page.evolveTitle || page.evolveNoindex;
      for (let vi = 0; vi < times.length; vi++) {
        if (rows.length >= target) break;
        const bot = pick(BOT_PICK);
        // Evolving pages flip on their most recent crawl only, so the two latest
        // visits differ — the case the "changed across two visits" queries detect.
        const epoch = evolving && vi === times.length - 1 ? 1 : 0;
        rows.push(makeRow(page, bot, times[vi], epoch));
      }
    }
  }
  return rows;
}

// ---- SQL emit ----
const sqlStr = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const sqlJson = (v) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
const sqlNum = (v) => (v === null || v === undefined ? 'NULL' : String(v));

function toSql(rows) {
  const cols = '(url, status, response_time_ms, title, meta_description, canonical, '
    + 'hreflangs, h1, h2, meta_robots, meta_googlebot, structured_data_types, index_status, bot_name, ts)';
  const lines = [
    `-- Demo seed for local dashboard development (${rows.length} rows).`,
    '-- GENERATED FILE — do not edit or commit. Source: scripts/seed-demo.mjs.',
    '-- Regenerated and loaded into the LOCAL D1 (Miniflare) by `npm run dev:local`.',
    '-- Idempotent: wipes the local table first, so every run gives the same dataset.',
    'BEGIN TRANSACTION;',
    'DELETE FROM crawls;',
  ];
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH).map((r) => '(' + [
      sqlStr(r.url), sqlNum(r.status), sqlNum(r.response_time_ms), sqlStr(r.title),
      sqlStr(r.meta_description), sqlStr(r.canonical), sqlJson(r.hreflangs), sqlJson(r.h1),
      sqlJson(r.h2), sqlJson(r.meta_robots), sqlJson(r.meta_googlebot),
      sqlJson(r.structured_data_types), sqlStr(r.index_status), sqlStr(r.bot_name), sqlNum(r.ts),
    ].join(', ') + ')').join(',\n  ');
    lines.push(`INSERT INTO crawls ${cols} VALUES\n  ${chunk};`);
  }
  lines.push('COMMIT;');
  return lines.join('\n');
}

const rows = generate(TARGET);
const fs = await import('node:fs');
fs.writeFileSync(OUT, toSql(rows) + '\n');
const byStatus = rows.reduce((m, r) => ((m[r.index_status] = (m[r.index_status] || 0) + 1), m), {});
console.log(`Wrote ${rows.length} rows to ${OUT}`);
console.log('index_status:', byStatus);
