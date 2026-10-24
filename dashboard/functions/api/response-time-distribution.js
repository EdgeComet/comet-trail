// GET /api/response-time-distribution?from=<unix_ms>&to=<unix_ms>&group=all|googlebot|ai
// The paired backend for the frontend ResponseTimeProvider. Buckets crawls in
// the [from, to] window by response_time_ms into the five fixed speed bands
// (<0.5s / 0.5-1s / 1-2s / 2-5s / 5s+) and returns the per-band counts plus the
// median and 95th percentile (lib/sql.js percentileSql). The bands are
// exhaustive (< 500 catches everything below the first edge, >= 5000
// everything above the last) and response_time_ms is NOT NULL (see
// schema.sql), so every row lands in exactly one band and SUM(buckets) == total.
// Bucketing is done here rather than on the client because the client can't pull
// every response time; the same CASE-SUM histogram shape as metrics.js.
// The percentiles repeat what metrics.js and the Loading Time tab compute for
// all bots: the footer needs them for the group the card shows, in this payload.
// `group` limits everything to Googlebot Search or the AI bots (lib/sql.js
// BOT_GROUP_SQL), for the switch in the card header; all bots by default.
// Reads the same D1 database the tracking worker writes to (binding: DB).
import { handle, json, parseRange, enumParam } from "../../lib/api.js";
import { BOT_GROUP_SQL, timeRankSql, percentileSql } from "../../lib/sql.js";

export const onRequestGet = handle(async ({ env, request }) => {
  const { from, to } = parseRange(request);
  const group = enumParam(request, "group", Object.keys(BOT_GROUP_SQL), "all");

  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN response_time_ms <  500                              THEN 1 ELSE 0 END) AS b0,
       SUM(CASE WHEN response_time_ms >= 500  AND response_time_ms < 1000 THEN 1 ELSE 0 END) AS b1,
       SUM(CASE WHEN response_time_ms >= 1000 AND response_time_ms < 2000 THEN 1 ELSE 0 END) AS b2,
       SUM(CASE WHEN response_time_ms >= 2000 AND response_time_ms < 5000 THEN 1 ELSE 0 END) AS b3,
       SUM(CASE WHEN response_time_ms >= 5000                             THEN 1 ELSE 0 END) AS b4,
       ${percentileSql(0.5)}                                                                 AS median_ms,
       ${percentileSql(0.95)}                                                                AS p95_ms,
       COUNT(*)                                                                              AS total
     FROM (SELECT response_time_ms, ${timeRankSql()}
             FROM crawls
            WHERE ts BETWEEN ?1 AND ?2 AND ${BOT_GROUP_SQL[group]})`
  )
    .bind(from, to)
    .first();

  // An empty range yields one row whose aggregates are NULL — coerce to 0.
  return json({
    buckets: [
      { key: "<0.5s",  c: row.b0 ?? 0 },
      { key: "0.5-1s", c: row.b1 ?? 0 },
      { key: "1-2s",   c: row.b2 ?? 0 },
      { key: "2-5s",   c: row.b3 ?? 0 },
      { key: "5s+",    c: row.b4 ?? 0 },
    ],
    median_ms: row.median_ms ?? 0,
    p95_ms: row.p95_ms ?? 0,
    total: row.total ?? 0,
  });
});
