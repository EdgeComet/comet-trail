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

  // Moved/short-link URLs that redirect (3xx). Placed early so they survive the
  // row-target cutoff in generate() and keep a visible 3xx slice (no visit boost
  // needed here — early pages already get full two-pass coverage).
  for (const p of ['/old-landing-page', '/promo/expired'])
    push(p, { kind: 'redirect', title: null, sd: [] });

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
  for (const p of ['/blog/deleted-post', '/tests/removed-test', '/products/discontinued', '/promo/2023-sale'])
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
  // Content-quality issue flags (drive the Content report's stat cards). Applied
  // before H1 is derived so a missing/duplicate title flows through to the H1.
  if (page.missingTitle) title = null;
  else if (page.dupTitle) title = page.dupTitle;
  const descTopic = titleize((page.url.split('/').pop() || 'seo').replace(/\?.*/, ''));
  let desc = `Learn about ${descTopic} with hands-on tests and examples.`;
  if (page.missingDesc) desc = null;
  else if (page.longDesc)
    desc = `A comprehensive, in-depth guide to ${descTopic}: detailed real-world examples, proven best practices, common pitfalls to avoid, and clear step-by-step instructions for developers and SEO teams who want to get every single detail exactly right the first time around.`;
  let h1 = title ? [title.replace(/ [|\-–].*$/, '')] : [];
  if (page.multiH1) h1 = [...h1, 'Secondary heading'];
  const h2 = [];
  let sd = page.sd.slice();

  switch (page.kind) {
    case 'noindex':
      metaRobots = chance(0.5) ? ['noindex', 'nofollow'] : ['noindex'];
      break;
    case 'tag':
      if (page.page > 1) canonical = `${HOST}/tag/${page.tag}`; // paginated → canonical to page 1
      break;
    case 'redirect': {
      // Moved permanently (301) most of the time, temporarily (302) sometimes.
      // Rolled per visit, so one URL yields both codes across the window.
      status = chance(0.7) ? 301 : 302;
      title = null; h1 = []; desc = null; canonical = null; sd = [];
      break;
    }
    case 'broken': {
      // Mostly 404, plus rate-limit (429), server errors (500/503), and the
      // occasional unreachable origin (NULL). 404/500 stay dominant so each code
      // keeps a visible slice. Rolled per visit, so one URL spans several codes.
      const r = random();
      status = r < 0.5 ? 404 : r < 0.65 ? 429 : r < 0.85 ? 500 : r < 0.93 ? 503 : null;
      const titles = { 404: '404 Not Found', 429: '429 Too Many Requests',
        500: '500 Server Error', 503: '503 Service Unavailable' };
      title = titles[status] ?? null;
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

  // Content-quality issues so the Content report's four stat cards have realistic
  // non-zero values: a few otherwise-indexable 200 pages missing a title, missing
  // a meta description, or carrying multiple H1s, plus a duplicate-title cluster.
  // Confined to always-200 page kinds (article/test/doc), so the status mix and
  // index_status distribution other widgets rely on stay unchanged.
  const tests = pages.filter((p) => p.kind === 'test');
  const docs = pages.filter((p) => p.kind === 'doc');
  for (const p of articles.slice(12, 16)) p.missingDesc = true;     // no meta description
  for (const p of articles.slice(19, 24)) p.longDesc = true;        // meta description over 160 chars
  for (const p of articles.slice(16, 19)) p.multiH1 = true;         // more than one H1
  for (const p of tests.slice(0, 3)) p.missingTitle = true;         // no <title> (and so no H1)
  for (const p of docs) p.dupTitle = 'Documentation | OpenSeoTest'; // docs share one title

  const now = Date.now();
  const WINDOW = 60 * 24 * 3600 * 1000; // 60 days

  const rows = [];
  while (rows.length < target) {
    for (const page of pages) {
      if (rows.length >= target) break;
      // Broken pages sit last in buildPages, so they only get first-pass coverage
      // before the row-target cutoff; boost them so 4xx/5xx land near real-world
      // proportions instead of rounding to 0%. (Redirect pages are placed early
      // and already get full coverage, so they need no boost.)
      const base = between(4, 28); // visits for this URL across the window
      const visits = page.kind === 'broken' ? base * 4 : base;
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
const byHttp = rows.reduce((m, r) => ((m[r.status ?? 'null'] = (m[r.status ?? 'null'] || 0) + 1), m), {});
console.log(`Wrote ${rows.length} rows to ${OUT}`);
console.log('index_status:', byStatus);
console.log('status:', byHttp);
