// GET /api/search-bots/allocation?from=&to=&group=googlebot|bingbot&bucket=hour|day
// Crawl Budget Allocation on the Efficiency tab of Log Analyzer > Googlebot
// and > Bingbot: the engine's Search requests per bucket, split into valuable,
// questionable and wasted (lib/sql.js ALLOCATION_SQL), plus each one's total in
// the previous period for the change figures. Bucket size is inlined as an
// integer literal for the reason given in api/bot-activity.js.
import { handle, json, parseRange, enumParam, firstVisitTs, previousIsComplete } from "../../../lib/api.js";
import { BOT_GROUP_SQL, ENGINE_SQL, ALLOCATION_SQL, ALLOCATIONS } from "../../../lib/sql.js";

const BUCKET_MS = { hour: 3600000, day: 86400000 };

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const group = enumParam(request, "group", Object.keys(ENGINE_SQL), "googlebot");
  const bucket = enumParam(request, "bucket", ["hour", "day"], "day");
  const ms = BUCKET_MS[bucket];
  const where = `ts BETWEEN ?1 AND ?2 AND ${BOT_GROUP_SQL[group]}`;

  const { results } = await env.DB.prepare(
    `SELECT (ts / ${ms}) * ${ms} AS t, ${ALLOCATION_SQL} AS series, COUNT(*) AS c
       FROM crawls WHERE ${where}
      GROUP BY t, series
      ORDER BY t`
  )
    .bind(range.from, range.to)
    .all();

  let previous = null;
  if (previousIsComplete(range, await firstVisitTs(env))) {
    const prev = await env.DB.prepare(`SELECT ${ALLOCATION_SQL} AS series, COUNT(*) AS c FROM crawls WHERE ${where} GROUP BY series`)
      .bind(range.prevFrom, range.prevTo)
      .all();
    previous = Object.fromEntries((prev.results ?? []).map((r) => [r.series, r.c]));
  }

  return json({ granularity: bucket, series: ALLOCATIONS, rows: results ?? [], previous });
});
