// SQL fragments shared by several endpoints. Each is a constant expression over
// the crawls columns, so it is safe to interpolate; request values are always
// bound with ?-params instead.
import { botNamesSql, isGooglebot, isBingbot, isAiBot } from "../../shared/bots.js";

// The bots behind the "All bots / Googlebot / Bingbot / AI bots" switch on a
// card (public/js/core/botGroup.js): the condition each group adds to a WHERE
// clause. Endpoints read the key with enumParam(request, "group", ...).
export const BOT_GROUP_SQL = {
  all: "1 = 1",
  googlebot: `bot_name IN ${botNamesSql(isGooglebot)}`,
  bingbot: `bot_name IN ${botNamesSql(isBingbot)}`,
  ai: `bot_name IN ${botNamesSql(isAiBot)}`,
};

// The search engines with a report of their own (Log Analyzer > Googlebot and
// > Bingbot, functions/api/search-bots/), by their group in BOT_GROUP_SQL, which
// holds the engine's Search crawlers: here, every crawler of the engine, for
// the report's Bot Variants table (shared/bots.js `engine`).
export const ENGINE_SQL = {
  googlebot: `bot_name IN ${botNamesSql((b) => b.engine === "google")}`,
  bingbot: `bot_name IN ${botNamesSql((b) => b.engine === "bing")}`,
};

// The demand on a page, which ranks the pages a report lists: Googlebot's
// visits when the report reads every bot (group "all"), and every visit when it
// reads one group only, as Log Analyzer > Googlebot > Indexability does
// through ?group=.
export const demandSql = (group) => (group === "all" ? BOT_GROUP_SQL.googlebot : "1 = 1");

// The status class of a visit, for the Status Codes tab. A NULL status (the
// origin did not answer) is a class of its own; fetch never ends on a 1xx.
export const STATUS_CLASS_SQL = `CASE
  WHEN status IS NULL THEN 'none'
  WHEN status >= 500 THEN '5xx'
  WHEN status >= 400 THEN '4xx'
  WHEN status >= 300 THEN '3xx'
  ELSE '2xx'
END`;

// Display order and labels for STATUS_CLASS_SQL.
export const STATUS_CLASSES = [
  { key: "2xx", label: "2xx" },
  { key: "3xx", label: "3xx" },
  { key: "4xx", label: "4xx" },
  { key: "5xx", label: "5xx" },
  { key: "none", label: "No response" },
];

// Response time percentiles, computed in D1 rather than in the function. The
// rows carry rn, their rank by response time, and n, how many rows share the
// partition (timeRankSql); the p-th percentile is the time at rank ceil(p * n),
// the nearest-rank method. Partitions are constant expressions too.
export function timeRankSql(partition = null) {
  const by = partition ? `PARTITION BY ${partition}` : "";
  return `ROW_NUMBER() OVER (${by} ORDER BY response_time_ms) AS rn, COUNT(*) OVER (${by}) AS n`;
}

export function percentileSql(p) {
  return `MIN(CASE WHEN rn >= ${p} * n THEN response_time_ms END)`;
}

// A request answered in this many ms or more is slow. 1 s is an edge of the
// Response Time Distribution's bands, so the share of slow requests is its
// 1-2s, 2-5s and 5s+ bars added up and the two cards agree. And it is slow on
// any site, not only under a strict budget: Lighthouse already flags a server
// that takes over 600 ms to answer a page, and Google crawls less of a site
// that answers slowly.
export const SLOW_MS = 1000;

// A visit that tells what the site serves, as opposed to a passing incident:
// no response, a 429 rate limit or a 5xx. Mirrors isStableStatus in history.js.
export const SETTLED_SQL = "(status IS NOT NULL AND status <> 429 AND status < 500)";

// ORDER BY for "the newest visit" of a page: its newest settled visit, so one
// rate-limited or failed fetch does not flip the page's verdict. An incident
// only counts when the page had no settled visit in the window.
export const NEWEST_SETTLED_SQL = "CASE WHEN status IS NULL OR status = 429 OR status >= 500 THEN 1 ELSE 0 END, ts DESC";

// Changes are found by comparing each visit with the one before it. A page's
// first visit in a period is compared with its last visit up to this long
// before the period; older than that, there is nothing to compare with.
export const CHANGE_LOOKBACK_MS = 30 * 86400000;

// One indexability verdict per visit, in the precedence the Evergreen Crawl
// uses: the status code first, then a noindex directive, then the canonical.
// NULL status (origin unreachable) counts as a server error.
export const PAGE_BUCKET_SQL = `CASE
  WHEN status IS NULL OR status >= 500 THEN 'server_error'
  WHEN status >= 400 THEN 'client_error'
  WHEN status >= 300 THEN 'redirect'
  WHEN status <> 200 THEN 'other'
  WHEN index_status = 'blocked_by_meta' THEN 'noindex'
  WHEN index_status = 'non_canonical' THEN 'canonical'
  ELSE 'indexable'
END`;

// Display order and labels for PAGE_BUCKET_SQL.
export const PAGE_BUCKETS = [
  { key: "indexable", label: "Indexable" },
  { key: "noindex", label: "Noindex" },
  { key: "canonical", label: "Canonical to other" },
  { key: "redirect", label: "Redirect 3xx" },
  { key: "client_error", label: "4xx client error" },
  { key: "server_error", label: "5xx server error" },
  { key: "other", label: "Other non-200" },
];

// Where a search bot's request went, after EdgeComet's Crawl Budget
// Allocation: valuable is an indexable page without a query string, questionable
// an indexable parameter URL (a filter, sort, page number or internal search,
// worth crawling only now and then), wasted a page Google or Bing cannot index:
// canonicalized, noindex, a redirect or an error (PAGE_BUCKET_SQL).
export const ALLOCATION_SQL = `CASE
  WHEN ${PAGE_BUCKET_SQL} <> 'indexable' THEN 'wasted'
  WHEN instr(url, '?') > 0 THEN 'questionable'
  ELSE 'valuable'
END`;

// Display order and labels for ALLOCATION_SQL.
export const ALLOCATIONS = [
  { key: "valuable", label: "Valuable" },
  { key: "questionable", label: "Questionable" },
  { key: "wasted", label: "Wasted" },
];

// The path of a URL: everything from the first "/" after scheme://host.
// substr(url, 9) skips "https://" (and "http://" plus one host character), so
// the first "/" it finds is the one that starts the path.
const PATH_SQL = `substr(url, instr(substr(url, 9), '/') + 8)`;
const REST_SQL = `substr(${PATH_SQL}, 2)`;

// Site section of a URL: its first path segment, with parameter URLs split out
// ("/c/*?" next to "/c/*"), because filter and sort URLs are where crawl goes
// to waste. The home page is "/".
export const SECTION_SQL = `CASE
  WHEN ${PATH_SQL} = '/' OR ${PATH_SQL} LIKE '/?%' THEN '/'
  ELSE '/' || CASE
      WHEN instr(${REST_SQL}, '/') > 0 AND (instr(${REST_SQL}, '?') = 0 OR instr(${REST_SQL}, '/') < instr(${REST_SQL}, '?'))
        THEN substr(${REST_SQL}, 1, instr(${REST_SQL}, '/') - 1) || '/*'
      WHEN instr(${REST_SQL}, '?') > 0 THEN substr(${REST_SQL}, 1, instr(${REST_SQL}, '?') - 1)
      ELSE ${REST_SQL}
    END
END || CASE WHEN instr(url, '?') > 0 AND ${PATH_SQL} NOT LIKE '/?%' THEN '?' ELSE '' END`;
