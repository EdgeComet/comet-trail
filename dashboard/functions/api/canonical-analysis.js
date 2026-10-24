// GET /api/canonical-analysis?from=<unix_ms>&to=<unix_ms>
// Where do the canonicals that point to another URL lead, and are those targets
// good? Every page whose newest settled visit in the period answered 200
// (NEWEST_SETTLED_SQL; a redirect or an error carries no canonical) is counted
// by its canonical:
//   pages     self, missing, and elsewhere: the canonical resolves to another
//             URL. Elsewhere splits into parameter URLs (with a query string:
//             filters and sorts, where canonicalizing is expected) and clean
//             URLs (worth checking: a product canonicalized to its category).
//   targets   for each state a target can be in, how many parameter and clean
//             URLs point there. A target is judged by its own newest settled
//             visit in the period: indexable (fine), redirect, error (4xx, 5xx
//             or another non-200), noindex, canonical (it names yet another
//             URL: a chain), unknown (no bot fetched it in the period) or
//             external (another host or protocol, not looked up).
//   problems  the pages whose target is not indexable, and clean URLs
//             canonicalized away even to a good target, most Googlebot visits
//             first: `total`, and the first PROBLEM_ROWS in `rows`.
//
// Self or elsewhere follows the canonical itself, resolved against the page
// URL the way shared/seo.js computeIndexStatus does. index_status cannot say it
// for a noindex page: its noindex outranks the canonical, so a noindex page
// that names another URL is `blocked_by_meta`, not `non_canonical`.
//
// Two reads. The first scans the period once, counts the self and missing
// pages per kind of URL, and returns only the pages whose canonical may point
// elsewhere: index_status non_canonical, or noindex with a canonical that is
// not the URL itself. URL resolution runs here, over those rows only. The
// second reads the targets' own visits in the period, through
// idx_crawls_url_ts.
import { handle, json, parseRange } from "../../lib/api.js";
import { PAGE_BUCKET_SQL, NEWEST_SETTLED_SQL } from "../../lib/sql.js";
import { botNamesSql, isGooglebot } from "../../../shared/bots.js";

const GOOGLEBOT = botNamesSql(isGooglebot);
const PROBLEM_ROWS = 100;

// Target states, in display order. `fine` is the only one that needs no look.
const TARGETS = ["indexable", "redirect", "error", "noindex", "canonical", "unknown", "external"];
const STATE_OF_BUCKET = {
  indexable: "indexable",
  redirect: "redirect",
  client_error: "error",
  server_error: "error",
  other: "error",
  noindex: "noindex",
  canonical: "canonical",
};

// One row per page to check (kind 'check', with its URL and canonical), and one
// per kind and URL type for the rest (url NULL), with the page count.
const PAGES_SQL = `
  WITH latest AS (
    SELECT url, status, canonical, index_status,
           SUM(CASE WHEN bot_name IN ${GOOGLEBOT} THEN 1 ELSE 0 END) OVER (PARTITION BY url) AS g,
           ROW_NUMBER() OVER (PARTITION BY url ORDER BY ${NEWEST_SETTLED_SQL}) AS rn
      FROM crawls
     WHERE ts BETWEEN ?1 AND ?2
  ),
  pages AS (
    SELECT url, canonical, g, instr(url, '?') > 0 AS param,
           CASE
             WHEN canonical IS NULL OR TRIM(canonical) = '' THEN 'missing'
             WHEN index_status = 'non_canonical'
               OR (index_status = 'blocked_by_meta' AND canonical <> url) THEN 'check'
             ELSE 'self'
           END AS kind
      FROM latest
     WHERE rn = 1 AND status = 200
  )
  SELECT kind, param, CASE WHEN kind = 'check' THEN url END AS url,
         MAX(canonical) AS canonical, MAX(g) AS g, COUNT(*) AS pages
    FROM pages
   GROUP BY kind, param, 3`;

// The newest settled visit in the period of each target (?3: a JSON array).
const TARGETS_SQL = `
  SELECT url, ${PAGE_BUCKET_SQL} AS bucket FROM (
    SELECT url, status, index_status,
           ROW_NUMBER() OVER (PARTITION BY url ORDER BY ${NEWEST_SETTLED_SQL}) AS rn
      FROM crawls
     WHERE url IN (SELECT value FROM json_each(?3)) AND ts BETWEEN ?1 AND ?2)
   WHERE rn = 1`;

// scheme://host[:port] of a normalized http(s) URL, as lib/sql.js PATH_SQL
// finds the path: the first "/" from the 9th character on.
const originOf = (href) => href.slice(0, href.indexOf("/", 8));

// The canonical resolved against the page URL, as shared/seo.js does, or null
// when it is malformed (seo.js does not flag those either). An absolute
// canonical resolves the same from every page, so each is parsed once.
function resolver() {
  const seen = new Map();
  return (canonical, url) => {
    const c = canonical.trim();
    const absolute = /^https?:\/\//i.test(c);
    if (absolute && seen.has(c)) return seen.get(c);
    let href = null;
    try {
      href = new URL(c, url).href;
    } catch {
      // Malformed: not flagged.
    }
    if (absolute) seen.set(c, href);
    return href;
  };
}

export const onRequestGet = handle(async ({ env, request }) => {
  const { from, to } = parseRange(request);
  const { results } = await env.DB.prepare(PAGES_SQL).bind(from, to).all();

  const resolve = resolver();
  const count = () => ({ param: 0, clean: 0 });
  const pages = { total: 0, self: 0, missing: 0, elsewhere: count() };
  const elsewhere = [];
  for (const r of results ?? []) {
    pages.total += r.pages;
    const href = r.kind === "check" ? resolve(r.canonical, r.url) : null;
    if (r.kind === "missing") pages.missing += r.pages;
    else if (!href || href === r.url) pages.self += r.pages;
    else {
      pages.elsewhere[r.param ? "param" : "clean"] += 1;
      elsewhere.push({ url: r.url, param: Boolean(r.param), target: href, googlebot: r.g ?? 0 });
    }
  }

  // Targets on the page's own host and protocol are looked up; the rest are
  // `external`.
  const local = [...new Set(elsewhere.filter((p) => originOf(p.target) === originOf(p.url)).map((p) => p.target))];
  const bucketOf = new Map();
  if (local.length) {
    const found = await env.DB.prepare(TARGETS_SQL).bind(from, to, JSON.stringify(local)).all();
    for (const t of found.results ?? []) bucketOf.set(t.url, t.bucket);
  }

  const targets = Object.fromEntries(TARGETS.map((key) => [key, { key, ...count() }]));
  const problems = [];
  for (const p of elsewhere) {
    p.bucket = bucketOf.get(p.target) ?? null;
    p.state = originOf(p.target) !== originOf(p.url) ? "external" : p.bucket ? STATE_OF_BUCKET[p.bucket] : "unknown";
    targets[p.state][p.param ? "param" : "clean"] += 1;
    if (p.state !== "indexable" || !p.param) problems.push(p);
  }
  problems.sort((a, b) => b.googlebot - a.googlebot || (a.url < b.url ? -1 : 1));

  return json({
    pages,
    targets: Object.values(targets),
    problems: { total: problems.length, rows: problems.slice(0, PROBLEM_ROWS) },
  });
});
