// GET /api/recent-visits?from=<unix_ms>&to=<unix_ms>
// The newest bot visits in the period, each with the page the bot received:
// the "log line plus the page" that makes an evergreen crawl. Reads only the
// newest rows through idx_crawls_ts.
import { handle, json, parseRange, intParam } from "../../lib/api.js";
import { familySql } from "../../../shared/bots.js";
import { PAGE_BUCKET_SQL } from "../../lib/sql.js";

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const limit = intParam(request, "limit", 12, { min: 1, max: 100 });
  const { results } = await env.DB.prepare(
    `SELECT ts, url, bot_name, ${familySql("bot_name")} AS family, status, response_time_ms,
            title, ${PAGE_BUCKET_SQL} AS bucket
       FROM crawls
      WHERE ts BETWEEN ?1 AND ?2
      ORDER BY ts DESC
      LIMIT ?3`
  )
    .bind(range.from, range.to, limit)
    .all();
  return json({ rows: results ?? [] });
});
