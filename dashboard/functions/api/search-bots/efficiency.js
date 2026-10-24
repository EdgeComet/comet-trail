// GET /api/search-bots/efficiency?from=&to=&group=googlebot|bingbot
// Log Analyzer > Googlebot and > Bingbot, Efficiency tab, after EdgeComet's
// Crawl Efficiency: where the engine's Search crawl went, and how its URLs
// moved against the previous period.
//   current, previous  { requests, indexable, reasons: { [key]: { requests,
//                      urls } } }: Crawl Efficiency is indexable / requests.
//                      The reasons are the Crawl Waste Breakdown: one per
//                      verdict but indexable (lib/sql.js PAGE_BUCKETS), each
//                      request under the verdict of the page it got, and
//                      `param`, the requests that went to indexable parameter
//                      URLs (ALLOCATION_SQL questionable). `urls` counts the
//                      URLs that got the reason at least once
//   inventory          [{ kind, bucket, urls }], null without a fair
//                      comparison: the URLs fetched in this period and not in
//                      the previous one (new), the reverse (lost) and in both
//                      (returning), per verdict of their newest settled visit
//                      in the period that has them (NEWEST_SETTLED_SQL)
//   declining          URLs with DECLINE_FROM requests or more in the previous
//                      period that got half as many or fewer in this one, none
//                      at all included; null without a fair comparison. Below
//                      that, 2 requests turning into 1 is noise, not a decline
//   overcrawled        { urls, threshold }: the URLs that got more requests
//                      than the 99th percentile of requests per URL, which is
//                      `threshold`
//
// Two reads of the period and the one before it, which start where the
// period does when the previous period is not fully recorded. The first
// counts requests per verdict; the second ranks the URLs.
import { handle, json, parseRange, enumParam, firstVisitTs, previousIsComplete } from "../../../lib/api.js";
import { BOT_GROUP_SQL, ENGINE_SQL, PAGE_BUCKET_SQL, PAGE_BUCKETS, NEWEST_SETTLED_SQL } from "../../../lib/sql.js";

const DECLINE_FROM = 4;

// ?1 the period's start, ?2 its end, ?3 the start of the read.
const reasonsSql = (group) => `
  SELECT ts >= ?1 AS cur, ${PAGE_BUCKET_SQL} AS bucket, instr(url, '?') > 0 AS param,
         COUNT(*) AS requests, COUNT(DISTINCT url) AS urls
    FROM crawls
   WHERE ts BETWEEN ?3 AND ?2 AND ${BOT_GROUP_SQL[group]}
   GROUP BY 1, 2, 3`;

//   v  each request, with its rank among its URL's requests in its period,
//      newest settled first
//   u  each URL: its requests now and before, and its verdict in each period
//   p  the 99th percentile of requests per URL in the period (lib/sql.js
//      percentileSql, over URLs instead of requests)
const urlsSql = (group) => `
  WITH v AS (
    SELECT url, ts >= ?1 AS cur, ${PAGE_BUCKET_SQL} AS bucket,
           ROW_NUMBER() OVER (PARTITION BY url, ts >= ?1 ORDER BY ${NEWEST_SETTLED_SQL}) AS rn
      FROM crawls
     WHERE ts BETWEEN ?3 AND ?2 AND ${BOT_GROUP_SQL[group]}
  ),
  u AS (
    SELECT SUM(cur) AS n, SUM(1 - cur) AS before,
           MAX(CASE WHEN cur = 1 AND rn = 1 THEN bucket END) AS now_bucket,
           MAX(CASE WHEN cur = 0 AND rn = 1 THEN bucket END) AS then_bucket
      FROM v GROUP BY url
  ),
  p AS (
    SELECT MIN(CASE WHEN rn >= 0.99 * total THEN n END) AS threshold FROM (
      SELECT n, ROW_NUMBER() OVER (ORDER BY n) AS rn, COUNT(*) OVER () AS total FROM u WHERE n > 0)
  )
  SELECT CASE WHEN before = 0 THEN 'new' WHEN n = 0 THEN 'lost' ELSE 'returning' END AS kind,
         CASE WHEN n > 0 THEN now_bucket ELSE then_bucket END AS bucket,
         COUNT(*) AS urls,
         SUM(CASE WHEN before >= ${DECLINE_FROM} AND n * 2 <= before THEN 1 ELSE 0 END) AS declining,
         SUM(CASE WHEN n > p.threshold THEN 1 ELSE 0 END) AS overcrawled,
         MAX(p.threshold) AS threshold
    FROM u CROSS JOIN p
   GROUP BY 1, 2`;

const REASONS = [...PAGE_BUCKETS.filter((b) => b.key !== "indexable").map((b) => b.key), "param"];

const empty = () => ({
  requests: 0,
  indexable: 0,
  reasons: Object.fromEntries(REASONS.map((key) => [key, { requests: 0, urls: 0 }])),
});

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const group = enumParam(request, "group", Object.keys(ENGINE_SQL), "googlebot");
  const fair = previousIsComplete(range, await firstVisitTs(env));
  const binds = [range.from, range.to, fair ? range.prevFrom : range.from];

  const reasons = await env.DB.prepare(reasonsSql(group)).bind(...binds).all();
  const urls = await env.DB.prepare(urlsSql(group)).bind(...binds).all();

  const current = empty();
  const previous = fair ? empty() : null;
  for (const r of reasons.results ?? []) {
    const period = r.cur ? current : previous;
    if (!period) continue;
    period.requests += r.requests;
    const key = r.bucket !== "indexable" ? r.bucket : r.param ? "param" : null;
    if (r.bucket === "indexable") period.indexable += r.requests;
    if (key) {
      period.reasons[key].requests += r.requests;
      period.reasons[key].urls += r.urls;
    }
  }

  const rows = urls.results ?? [];
  const overcrawled = {
    urls: rows.reduce((a, r) => a + r.overcrawled, 0),
    threshold: rows.find((r) => r.threshold !== null)?.threshold ?? null,
  };

  return json({
    current,
    previous,
    inventory: fair ? rows.map(({ kind, bucket, urls: n }) => ({ kind, bucket, urls: n })) : null,
    declining: fair ? { urls: rows.reduce((a, r) => a + r.declining, 0), from: DECLINE_FROM } : null,
    overcrawled,
  });
});
