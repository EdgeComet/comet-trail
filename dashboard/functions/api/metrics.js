// GET /api/metrics?from=<unix_ms>&to=<unix_ms>
// The four Log Analyzer stat cards, for the selected period and the period of
// the same length before it:
//   total_requests   - rows captured
//   unique_urls      - distinct URLs visited
//   crawl_efficiency - percent of requests answered with a 2xx status
//   avg_response_ms  - mean response time
// `previous` is null when recorded data does not reach back over the whole
// comparison window, so the cards show no misleading change figure.
import { handle, json, parseRange, firstVisitTs, previousIsComplete } from "../../lib/api.js";

const SQL = `SELECT
    COUNT(*)                                                          AS total_requests,
    COUNT(DISTINCT url)                                               AS unique_urls,
    CAST(SUM(CASE WHEN status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS REAL)
      / NULLIF(COUNT(*), 0) * 100                                     AS crawl_efficiency,
    AVG(response_time_ms)                                             AS avg_response_ms
  FROM crawls
  WHERE ts BETWEEN ?1 AND ?2`;

const clean = (row) => ({
  total_requests: row?.total_requests ?? 0,
  unique_urls: row?.unique_urls ?? 0,
  crawl_efficiency: row?.crawl_efficiency ?? 0,
  avg_response_ms: row?.avg_response_ms ?? 0,
});

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const first = await firstVisitTs(env);
  const current = await env.DB.prepare(SQL).bind(range.from, range.to).first();
  const previous = previousIsComplete(range, first)
    ? clean(await env.DB.prepare(SQL).bind(range.prevFrom, range.prevTo).first())
    : null;
  return json({ current: clean(current), previous });
});
