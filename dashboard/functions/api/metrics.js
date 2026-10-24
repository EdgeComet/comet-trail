// GET /api/metrics?from=<unix_ms>&to=<unix_ms>
// The four Log Analyzer stat cards, for the selected period and the period of
// the same length before it:
//   total_requests    - rows captured
//   unique_urls       - distinct URLs visited
//   crawl_efficiency  - percent of Googlebot Search requests whose own visit
//                       received an indexable page (lib/sql.js PAGE_BUCKET_SQL),
//                       as in EdgeComet: the share of Google's crawl that lands
//                       on pages it can index. null when Googlebot made none
//   googlebot         - those Googlebot Search requests, and in
//                       `googlebot_buckets` how many got each verdict, so the
//                       card can say where the rest went
//   median_response_ms, p95_response_ms
//                     - the median and 95th percentile response time
//                       (lib/sql.js percentileSql): a mean is pulled up by a
//                       few slow fetches and stands for no request
// The share of 2xx responses across all bots is the Response Status
// Distribution card (/api/status-distribution).
// `previous` is null when recorded data does not reach back over the whole
// comparison window, so the cards show no misleading change figure.
import { handle, json, parseRange, firstVisitTs, previousIsComplete } from "../../lib/api.js";
import { PAGE_BUCKET_SQL, PAGE_BUCKETS, timeRankSql, percentileSql } from "../../lib/sql.js";
import { botNamesSql, isGooglebot } from "../../../shared/bots.js";

const GOOGLEBOT = botNamesSql(isGooglebot);

// One read of the period. The inner query gives each Googlebot visit its
// verdict (NULL for every other bot) and each visit its rank by response
// time; the outer one counts them per verdict and reads the percentiles.
const SQL = `SELECT
    COUNT(*)              AS total_requests,
    COUNT(DISTINCT url)   AS unique_urls,
    ${percentileSql(0.5)} AS median_response_ms,
    ${percentileSql(0.95)} AS p95_response_ms,
    COUNT(verdict)        AS googlebot,
    ${PAGE_BUCKETS.map((b) => `COUNT(CASE WHEN verdict = '${b.key}' THEN 1 END) AS g_${b.key}`).join(",\n    ")}
  FROM (
    SELECT url, response_time_ms, ${timeRankSql()},
           CASE WHEN bot_name IN ${GOOGLEBOT} THEN ${PAGE_BUCKET_SQL} END AS verdict
      FROM crawls
     WHERE ts BETWEEN ?1 AND ?2)`;

function clean(row) {
  const googlebot = row?.googlebot ?? 0;
  const buckets = Object.fromEntries(PAGE_BUCKETS.map((b) => [b.key, row?.[`g_${b.key}`] ?? 0]));
  return {
    total_requests: row?.total_requests ?? 0,
    unique_urls: row?.unique_urls ?? 0,
    crawl_efficiency: googlebot ? (buckets.indexable / googlebot) * 100 : null,
    googlebot,
    googlebot_buckets: buckets,
    median_response_ms: row?.median_response_ms ?? null,
    p95_response_ms: row?.p95_response_ms ?? null,
  };
}

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const first = await firstVisitTs(env);
  const current = await env.DB.prepare(SQL).bind(range.from, range.to).first();
  const previous = previousIsComplete(range, first)
    ? clean(await env.DB.prepare(SQL).bind(range.prevFrom, range.prevTo).first())
    : null;
  return json({ current: clean(current), previous });
});
