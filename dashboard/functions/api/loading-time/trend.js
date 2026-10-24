// GET /api/loading-time/trend?from=&to=&group=all|googlebot|ai&bucket=hour|day
// The selected bots' response times over time, for the Loading Time chart:
// per bucket, the median and 95th percentile response time (lib/sql.js
// percentileSql) and the requests they come from. Drawn together, they show a
// bot crawling less after the site answered slowly or not at all. Rows follow
// charts/timeSeriesChart.js ({ t, series, c }); a bucket without requests is
// absent, a gap in the time lines. Bucket size is inlined as an integer
// literal for the reason given in api/bot-activity.js.
import { handle, json, parseRange, enumParam } from "../../../lib/api.js";
import { BOT_GROUP_SQL, timeRankSql, percentileSql } from "../../../lib/sql.js";

const BUCKET_MS = { hour: 3600000, day: 86400000 };

const SERIES = [
  { key: "median", label: "Median" },
  { key: "p95", label: "95th percentile" },
  { key: "requests", label: "Requests" },
];

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const group = enumParam(request, "group", Object.keys(BOT_GROUP_SQL), "all");
  const bucket = enumParam(request, "bucket", ["hour", "day"], "day");
  const ms = BUCKET_MS[bucket];

  const { results } = await env.DB.prepare(
    `SELECT t, COUNT(*) AS requests, ${percentileSql(0.5)} AS median, ${percentileSql(0.95)} AS p95
       FROM (SELECT t, response_time_ms, ${timeRankSql("t")}
               FROM (SELECT (ts / ${ms}) * ${ms} AS t, response_time_ms
                       FROM crawls
                      WHERE ts BETWEEN ?1 AND ?2 AND ${BOT_GROUP_SQL[group]}))
      GROUP BY t
      ORDER BY t`
  )
    .bind(range.from, range.to)
    .all();

  const rows = (results ?? []).flatMap((r) => SERIES.map((s) => ({ t: r.t, series: s.key, c: r[s.key] })));
  return json({ granularity: bucket, series: SERIES, rows });
});
