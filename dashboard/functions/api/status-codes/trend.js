// GET /api/status-codes/trend?from=&to=&group=all|googlebot|ai&bucket=hour|day
// Responses per status class (lib/sql.js STATUS_CLASSES) over time, for the
// stacked chart on Log Analyzer > Status Codes: an outage shows as a day of
// 5xx and no response, and the crawl that falls off after it. Empty buckets
// are absent and zero-filled by charts/timeSeriesChart.js. Bucket size is
// inlined as an integer literal for the reason given in api/bot-activity.js.
import { handle, json, parseRange, enumParam } from "../../../lib/api.js";
import { BOT_GROUP_SQL, STATUS_CLASS_SQL, STATUS_CLASSES } from "../../../lib/sql.js";

const BUCKET_MS = { hour: 3600000, day: 86400000 };

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const group = enumParam(request, "group", Object.keys(BOT_GROUP_SQL), "all");
  const bucket = enumParam(request, "bucket", ["hour", "day"], "day");
  const ms = BUCKET_MS[bucket];

  const { results } = await env.DB.prepare(
    `SELECT (ts / ${ms}) * ${ms} AS t, ${STATUS_CLASS_SQL} AS series, COUNT(*) AS c
       FROM crawls
      WHERE ts BETWEEN ?1 AND ?2 AND ${BOT_GROUP_SQL[group]}
      GROUP BY t, series
      ORDER BY t`
  )
    .bind(range.from, range.to)
    .all();

  return json({ granularity: bucket, series: STATUS_CLASSES, rows: results ?? [] });
});
