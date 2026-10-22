// GET /api/pages?from=&to=&q=&view=all|changed|not_indexable|ai&sort=&offset=&limit=
// Every URL bots fetched in the period, one row each:
//   visits, googlebot, ai_user  requests in the period (all bots, Googlebot
//                               Search, AI assistants fetching for a user)
//   last_ts, last_bot           the newest visit
//   status, bucket, title       what that newest visit received (the newest
//                               settled visit: an incident does not set them)
//   changes                     how many visits in the period brought a page
//                               different from the visit before: content
//                               between 200 visits, status between settled
//                               visits, with the same lookback as /api/changes
// `counts` gives the size of each view for the filter chips; `total` the size of
// the filtered list, for paging. The search term matches the URL or the title.
import { handle, json, parseRange, intParam, enumParam } from "../../lib/api.js";
import { PAGE_BUCKET_SQL, NEWEST_SETTLED_SQL, SETTLED_SQL, CHANGE_LOOKBACK_MS } from "../../lib/sql.js";
import { botNamesSql, isGooglebot } from "../../../shared/bots.js";

const GOOGLEBOT = botNamesSql(isGooglebot);
const AI_USER = botNamesSql((b) => b.purpose === "user");

// Every order ends on url, so OFFSET pages never repeat or skip a row.
const SORTS = {
  visits: "visits DESC, url",
  last: "last_ts DESC, url",
  changes: "changes DESC, visits DESC, url",
  googlebot: "googlebot DESC, visits DESC, url",
  ai_user: "ai_user DESC, visits DESC, url",
  url: "url",
};

// Content columns compared between 200 visits. Scalars treat "" as missing, as
// lib/history.js does, so an empty attribute is not a change from no attribute.
const SCALARS = ["title", "meta_description", "canonical"];
const LISTS = ["meta_robots", "meta_googlebot", "h1", "h2", "hreflangs", "structured_data_types"];
const CHANGED = [
  ...SCALARS.map((c) => `NULLIF(${c}, '') IS NOT LAG(NULLIF(${c}, '')) OVER w`),
  ...LISTS.map((c) => `${c} IS NOT LAG(${c}) OVER w`),
].join(" OR ");

const BASE = `
  WITH w AS (
    SELECT url, ts, status, index_status, title, bot_name
      FROM crawls
     WHERE ts BETWEEN ?1 AND ?2
  ),
  agg AS (
    SELECT url,
           COUNT(*) AS visits,
           SUM(CASE WHEN bot_name IN ${GOOGLEBOT} THEN 1 ELSE 0 END) AS googlebot,
           SUM(CASE WHEN bot_name IN ${AI_USER} THEN 1 ELSE 0 END) AS ai_user,
           MAX(ts) AS last_ts
      FROM w
     GROUP BY url
  ),
  latest AS (
    SELECT url, status, title, bucket, bot_name AS last_bot
      FROM (SELECT url, status, title, bot_name, ${PAGE_BUCKET_SQL} AS bucket,
                   ROW_NUMBER() OVER (PARTITION BY url ORDER BY ${NEWEST_SETTLED_SQL}) AS rn
              FROM w)
     WHERE rn = 1
  ),
  ch AS (
    SELECT url, COUNT(*) AS changes FROM (
      SELECT url, ts FROM (
        SELECT url, ts, CASE WHEN LAG(ts) OVER w IS NOT NULL AND (${CHANGED}) THEN 1 ELSE 0 END AS changed
          FROM crawls
         WHERE status = 200 AND ts BETWEEN ?3 AND ?2
        WINDOW w AS (PARTITION BY url ORDER BY ts))
       WHERE changed = 1 AND ts >= ?1
      UNION
      SELECT url, ts FROM (
        SELECT url, ts, CASE WHEN LAG(ts) OVER w IS NOT NULL AND status IS NOT LAG(status) OVER w THEN 1 ELSE 0 END AS changed
          FROM crawls
         WHERE ${SETTLED_SQL} AND ts BETWEEN ?3 AND ?2
        WINDOW w AS (PARTITION BY url ORDER BY ts))
       WHERE changed = 1 AND ts >= ?1)
     GROUP BY url
  ),
  j AS (
    SELECT a.url, a.visits, a.googlebot, a.ai_user, a.last_ts,
           l.status, l.title, l.bucket, l.last_bot, COALESCE(c.changes, 0) AS changes
      FROM agg a JOIN latest l USING (url) LEFT JOIN ch c USING (url)
  )`;

const FILTER = `
  (?4 = '' OR instr(lower(url), ?4) > 0 OR instr(lower(COALESCE(title, '')), ?4) > 0)
  AND (?5 = 'all'
       OR (?5 = 'changed' AND changes > 0)
       OR (?5 = 'not_indexable' AND bucket <> 'indexable')
       OR (?5 = 'ai' AND ai_user > 0))`;

const COUNTS = `
  COUNT(*) AS n_all,
  SUM(CASE WHEN ${FILTER} THEN 1 ELSE 0 END) AS n_filtered,
  SUM(CASE WHEN changes > 0 THEN 1 ELSE 0 END) AS n_changed,
  SUM(CASE WHEN bucket <> 'indexable' THEN 1 ELSE 0 END) AS n_not_indexable,
  SUM(CASE WHEN ai_user > 0 THEN 1 ELSE 0 END) AS n_ai`;

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").trim().toLowerCase().slice(0, 200);
  const view = enumParam(request, "view", ["all", "changed", "not_indexable", "ai"], "all");
  const sort = enumParam(request, "sort", Object.keys(SORTS), "visits");
  const limit = intParam(request, "limit", 50, { min: 1, max: 200 });
  const requested = intParam(request, "offset", 0, { min: 0, max: 1000000 });
  const binds = [range.from, range.to, range.from - CHANGE_LOOKBACK_MS, q, view];

  const counts = await env.DB.prepare(`${BASE} SELECT ${COUNTS} FROM j`)
    .bind(...binds)
    .first();
  const total = counts?.n_filtered ?? 0;
  // An offset past the end (the period or filter changed under it) lands on
  // the last page instead of an empty one.
  const offset = requested >= total ? Math.max(0, Math.floor((total - 1) / limit) * limit) : requested;

  const { results } = await env.DB.prepare(
    `${BASE}
     SELECT j.* FROM j
      WHERE ${FILTER}
      ORDER BY ${SORTS[sort]}
      LIMIT ?6 OFFSET ?7`
  )
    .bind(...binds, limit, offset)
    .all();

  return json({
    rows: results ?? [],
    total,
    offset,
    counts: {
      all: counts?.n_all ?? 0,
      changed: counts?.n_changed ?? 0,
      not_indexable: counts?.n_not_indexable ?? 0,
      ai: counts?.n_ai ?? 0,
    },
  });
});
