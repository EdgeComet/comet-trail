// GET /api/ai/trend?from=&to=&bucket=hour|day
// AI bots by purpose next to Googlebot Search, over time: one series each for
// Googlebot, AI training crawls, AI search crawls and AI user fetches, plus
// each series' total in the previous period. Bucket size is inlined as an
// integer literal for the reason given in api/bot-activity.js.
import { handle, json, parseRange, enumParam, firstVisitTs, previousIsComplete } from "../../../lib/api.js";
import { PURPOSES, familySql, purposeSql } from "../../../../shared/bots.js";

const BUCKET_MS = { hour: 3600000, day: 86400000 };

const GROUP = `CASE WHEN ${familySql("bot_name")} = 'googlebot' THEN 'googlebot' ELSE ${purposeSql("bot_name")} END`;

const SERIES = [
  { key: "googlebot", label: "Googlebot Search" },
  ...[...PURPOSES].reverse().map((p) => ({ key: p.key, label: p.label })), // training, search, user
];

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const bucket = enumParam(request, "bucket", ["hour", "day"], "day");
  const ms = BUCKET_MS[bucket];

  const { results } = await env.DB.prepare(
    `SELECT t, series, COUNT(*) AS c FROM (
       SELECT (ts / ${ms}) * ${ms} AS t, ${GROUP} AS series FROM crawls WHERE ts BETWEEN ?1 AND ?2)
      WHERE series IS NOT NULL
      GROUP BY t, series
      ORDER BY t`
  )
    .bind(range.from, range.to)
    .all();

  let previous = null;
  if (previousIsComplete(range, await firstVisitTs(env))) {
    const prev = await env.DB.prepare(
      `SELECT series, COUNT(*) AS c FROM (SELECT ${GROUP} AS series FROM crawls WHERE ts BETWEEN ?1 AND ?2)
        WHERE series IS NOT NULL GROUP BY series`
    )
      .bind(range.prevFrom, range.prevTo)
      .all();
    previous = Object.fromEntries((prev.results ?? []).map((r) => [r.series, r.c]));
  }

  return json({ granularity: bucket, series: SERIES, rows: results ?? [], previous });
});
