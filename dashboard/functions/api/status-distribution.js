// GET /api/status-distribution?from=<unix_ms>&to=<unix_ms>&group=all|googlebot|ai
// The paired backend for the frontend StatusDistributionProvider. Counts crawls
// per distinct HTTP status in the [from, to] window. A NULL status (origin
// unreachable) collapses into its own group. Bucketing the codes into
// 2xx/3xx/4xx/5xx happens on the frontend (see charts/statusDistributionChart.js),
// keeping the SQL dumb - the same split-on-the-client approach as bot-activity.
// `group` limits the count to Googlebot Search or the AI bots (lib/sql.js
// BOT_GROUP_SQL), for the switch in the card header; all bots by default.
// Reads the same D1 database the tracking worker writes to (binding: DB).
import { handle, json, parseRange, enumParam } from "../../lib/api.js";
import { BOT_GROUP_SQL } from "../../lib/sql.js";

export const onRequestGet = handle(async ({ env, request }) => {
  const { from, to } = parseRange(request);
  const group = enumParam(request, "group", Object.keys(BOT_GROUP_SQL), "all");

  const { results } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS c
       FROM crawls
      WHERE ts BETWEEN ?1 AND ?2 AND ${BOT_GROUP_SQL[group]}
      GROUP BY status
      ORDER BY status`
  )
    .bind(from, to)
    .all();

  return json({ rows: results ?? [] });
});
