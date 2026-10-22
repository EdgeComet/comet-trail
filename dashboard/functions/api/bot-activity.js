// GET /api/bot-activity?from=<unix_ms>&to=<unix_ms>&bucket=hour|day
// Requests per bot family over time, for the Bot Activity chart, plus each
// family's total in the previous period for the change figures.
// Families come from shared/bots.js, the same catalog the collector uses.
// Gap-filling and column assembly happen on the frontend
// (charts/timeSeriesChart.js), so empty buckets are simply absent here.
//
// Bucket size is inlined as an integer literal (not a bound ?-param): binding a
// JS number can bind as REAL, which turns SQLite's integer division into float
// division and corrupts the bucket keys. The value comes from a closed
// {hour, day} set. It must match BUCKET_MS in public/js/core/bucketing.js.
import { handle, json, parseRange, enumParam, firstVisitTs, previousIsComplete } from "../../lib/api.js";
import { FAMILIES, familySql } from "../../../shared/bots.js";

const BUCKET_MS = { hour: 3600000, day: 86400000 };
const FAMILY = familySql("bot_name");

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const bucket = enumParam(request, "bucket", ["hour", "day"], "day");
  const ms = BUCKET_MS[bucket];

  const { results } = await env.DB.prepare(
    `SELECT (ts / ${ms}) * ${ms} AS t, ${FAMILY} AS series, COUNT(*) AS c
       FROM crawls
      WHERE ts BETWEEN ?1 AND ?2
      GROUP BY t, series
      ORDER BY t`
  )
    .bind(range.from, range.to)
    .all();

  let previous = null;
  if (previousIsComplete(range, await firstVisitTs(env))) {
    const prev = await env.DB.prepare(
      `SELECT ${FAMILY} AS series, COUNT(*) AS c FROM crawls WHERE ts BETWEEN ?1 AND ?2 GROUP BY series`
    )
      .bind(range.prevFrom, range.prevTo)
      .all();
    previous = Object.fromEntries((prev.results ?? []).map((r) => [r.series, r.c]));
  }

  return json({ granularity: bucket, series: FAMILIES, rows: results ?? [], previous });
});
