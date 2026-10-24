// GET /api/loading-time/urls?from=&to=&group=all|googlebot|ai
// The slowest URLs for the selected bots: per URL fetched at least MIN_VISITS
// times in the period, the median and 95th percentile response time
// (lib/sql.js percentileSql), the visits and the status of the newest one.
// Ranked by the median over at least five visits, so a slow hit or two cannot
// put a page on the list.
//   rows    the slowest LIMIT URLs
//   ranked  how many URLs had enough visits to rank
// One read of the period; the newest status of the listed URLs comes from the
// url index (idx_crawls_url_ts).
import { handle, json, parseRange, enumParam } from "../../../lib/api.js";
import { BOT_GROUP_SQL, timeRankSql, percentileSql } from "../../../lib/sql.js";

const MIN_VISITS = 5;
const LIMIT = 20;

const sql = (group) => {
  const g = BOT_GROUP_SQL[group];
  return `
  WITH u AS (
    SELECT url, COUNT(*) AS visits, ${percentileSql(0.5)} AS median, ${percentileSql(0.95)} AS p95, MAX(ts) AS last_ts
      FROM (SELECT url, ts, response_time_ms, ${timeRankSql("url")}
              FROM crawls
             WHERE ts BETWEEN ?1 AND ?2 AND ${g})
     GROUP BY url
    HAVING visits >= ${MIN_VISITS}
  ),
  top AS (
    SELECT *, COUNT(*) OVER () AS ranked FROM u ORDER BY median DESC, p95 DESC, url LIMIT ${LIMIT}
  )
  SELECT url, visits, median, p95, last_ts, ranked,
         (SELECT status FROM crawls c WHERE c.url = top.url AND c.ts = top.last_ts AND ${g} LIMIT 1) AS status
    FROM top
   ORDER BY median DESC, p95 DESC, url`;
};

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const group = enumParam(request, "group", Object.keys(BOT_GROUP_SQL), "all");

  const { results } = await env.DB.prepare(sql(group)).bind(range.from, range.to).all();
  const rows = results ?? [];
  return json({
    rows: rows.map(({ ranked, ...r }) => r),
    ranked: rows[0]?.ranked ?? 0,
    min_visits: MIN_VISITS,
  });
});
