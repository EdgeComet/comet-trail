// GET /api/status-codes/urls?from=&to=&group=all|googlebot|ai
// The URLs behind Log Analyzer > Status Codes, as the selected bots saw them:
//   broken     URLs that answered 404, 410, 5xx or nothing in the period,
//              the most hit first, each with its failing hits, the newest one
//              and its status, and the AI user fetches on it. `failing`: its
//              newest answer (other than a 403 or 429) still fails. Those
//              have `since`, the first failing visit after the last good one
//              (2xx or 3xx, which may be before the period), and that good
//              visit when the record has one; the others have their newest
//              good visit, the one after the failures
//   redirects  URLs that answered 3xx, the most hit first. The collector does
//              not record where a redirect leads, so there is no target here
// Each list holds the first LIMIT URLs, still failing and recovered apart;
// `totals` counts them all.
//
// One read of the period, grouped per URL; the history of the listed URLs
// comes from the url index (idx_crawls_url_ts), a few rows each. A visit with
// another code (a 403, a 429 rate limit) is neither failing nor good.
import { handle, json, parseRange, enumParam } from "../../../lib/api.js";
import { BOT_GROUP_SQL } from "../../../lib/sql.js";
import { botNamesSql } from "../../../../shared/bots.js";

const AI_USER = botNamesSql((b) => b.purpose === "user");
const FAILED = "(status IS NULL OR status IN (404, 410) OR status >= 500)";
const GOOD = "(status IS NOT NULL AND status < 400)";
const REDIRECT = "(status BETWEEN 300 AND 399)";
const LIMIT = 25;

// ?1 from, ?2 to. In the subqueries on `crawls c`, the unqualified columns of
// the fragments are c's.
//   u       per URL: failing hits, newest failing and good visits in the
//           period, redirect hits, AI user fetches (any bot group)
//   ranked  each list's order, and the totals
//   hist    the newest good visit up to `to`, looked up before the period
//           when the period has none
const sql = (group) => {
  const g = BOT_GROUP_SQL[group];
  return `
  WITH u AS (
    SELECT url,
           SUM(CASE WHEN g AND failed THEN 1 ELSE 0 END) AS hits,
           MAX(CASE WHEN g AND failed THEN ts END) AS last_ts,
           MAX(CASE WHEN g AND good THEN ts END) AS good_ts,
           SUM(CASE WHEN g AND redirect THEN 1 ELSE 0 END) AS redirects,
           MAX(CASE WHEN g AND redirect THEN ts END) AS redirect_ts,
           SUM(ai) AS ai_user
      FROM (SELECT url, ts, ${g} AS g, ${FAILED} AS failed, ${GOOD} AS good, ${REDIRECT} AS redirect,
                   bot_name IN ${AI_USER} AS ai
              FROM crawls
             WHERE ts BETWEEN ?1 AND ?2)
     GROUP BY url
    HAVING hits > 0 OR redirects > 0
  ),
  r AS (
    SELECT *, hits > 0 AND last_ts > COALESCE(good_ts, 0) AS failing FROM u
  ),
  ranked AS (
    SELECT *,
           hits > 0 AND ROW_NUMBER() OVER (PARTITION BY hits > 0, failing ORDER BY hits DESC, url) <= ${LIMIT} AS broken,
           redirects > 0 AND ROW_NUMBER() OVER (PARTITION BY redirects > 0 ORDER BY redirects DESC, url) <= ${LIMIT} AS redirecting,
           SUM(hits > 0) OVER () AS broken_urls,
           SUM(failing) OVER () AS failing_urls,
           SUM(redirects > 0) OVER () AS redirect_urls
      FROM r
  ),
  hist AS (
    SELECT *,
           CASE WHEN broken THEN COALESCE(good_ts,
             (SELECT ts FROM crawls c WHERE c.url = ranked.url AND c.ts < ?1 AND ${g} AND ${GOOD} ORDER BY c.ts DESC LIMIT 1)) END AS good_any
      FROM ranked
     WHERE broken OR redirecting
  )
  SELECT url, broken, redirecting, hits, last_ts, failing, redirects, redirect_ts, ai_user,
         broken_urls, failing_urls, redirect_urls, good_any AS good_ts,
         CASE WHEN broken THEN
           (SELECT status FROM crawls c WHERE c.url = hist.url AND c.ts = hist.last_ts AND ${g} AND ${FAILED} LIMIT 1) END AS status,
         CASE WHEN good_any IS NOT NULL THEN
           (SELECT status FROM crawls c WHERE c.url = hist.url AND c.ts = hist.good_any AND ${g} AND ${GOOD} LIMIT 1) END AS good_status,
         CASE WHEN failing THEN
           (SELECT ts FROM crawls c WHERE c.url = hist.url AND c.ts > COALESCE(hist.good_any, 0) AND c.ts <= ?2 AND ${g} AND ${FAILED}
             ORDER BY c.ts LIMIT 1) END AS since,
         CASE WHEN redirecting THEN
           (SELECT status FROM crawls c WHERE c.url = hist.url AND c.ts = hist.redirect_ts AND ${g} AND ${REDIRECT} LIMIT 1) END AS redirect_status
    FROM hist`;
};

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const group = enumParam(request, "group", Object.keys(BOT_GROUP_SQL), "all");

  const { results } = await env.DB.prepare(sql(group)).bind(range.from, range.to).all();
  const rows = results ?? [];

  const broken = rows
    .filter((r) => r.broken)
    .sort((a, b) => b.hits - a.hits || a.url.localeCompare(b.url))
    .map((r) => ({
      url: r.url,
      status: r.status,
      hits: r.hits,
      last_ts: r.last_ts,
      failing: Boolean(r.failing),
      since: r.since,
      good_status: r.good_status,
      good_ts: r.good_ts,
      ai_user: r.ai_user,
    }));
  const redirects = rows
    .filter((r) => r.redirecting)
    .sort((a, b) => b.redirects - a.redirects || a.url.localeCompare(b.url))
    .map((r) => ({ url: r.url, status: r.redirect_status, hits: r.redirects, last_ts: r.redirect_ts, ai_user: r.ai_user }));

  return json({
    broken,
    redirects,
    totals: {
      broken: rows[0]?.broken_urls ?? 0,
      failing: rows[0]?.failing_urls ?? 0,
      redirects: rows[0]?.redirect_urls ?? 0,
    },
  });
});
