// GET /api/indexation?from=<unix_ms>&to=<unix_ms>
// One indexability verdict per page, from the newest settled visit in the
// period (lib/sql.js PAGE_BUCKET_SQL and NEWEST_SETTLED_SQL: one 429 or 5xx does
// not flip a page), compared with the verdict each page had in the period
// before - the evergreen crawl's automatic comparison.
//   buckets   per verdict: pages now, pages before, pages that entered and left
//             it, and the demand on its pages (Googlebot visits, AI user fetches)
//   moves     pages whose verdict changed, per from -> to pair, with the demand
//             now and up to 8 example URLs (highest demand first)
//   totals    pages now and before, newly discovered, not re-fetched
// `partial` is true when recorded data does not cover the whole previous
// period, so "before" is incomplete.
import { handle, json, parseRange, firstVisitTs, previousIsComplete } from "../../lib/api.js";
import { PAGE_BUCKET_SQL, PAGE_BUCKETS, NEWEST_SETTLED_SQL } from "../../lib/sql.js";
import { botNamesSql, isGooglebot } from "../../../shared/bots.js";

const GOOGLEBOT = botNamesSql(isGooglebot);
const AI_USER = botNamesSql((b) => b.purpose === "user");

// cur/prev: each page's verdict in the period and in the one before.
// j: every page in either period. SQLite's FULL OUTER JOIN is recent, so the
// union of a LEFT JOIN and the prev-only rows stands in for it.
const PAIRS = `
  WITH cur AS (
    SELECT url, bucket, g, a FROM (
      SELECT url, ${PAGE_BUCKET_SQL} AS bucket,
             SUM(CASE WHEN bot_name IN ${GOOGLEBOT} THEN 1 ELSE 0 END) OVER (PARTITION BY url) AS g,
             SUM(CASE WHEN bot_name IN ${AI_USER} THEN 1 ELSE 0 END) OVER (PARTITION BY url) AS a,
             ROW_NUMBER() OVER (PARTITION BY url ORDER BY ${NEWEST_SETTLED_SQL}) AS rn
        FROM crawls WHERE ts BETWEEN ?1 AND ?2)
     WHERE rn = 1
  ),
  prev AS (
    SELECT url, bucket FROM (
      SELECT url, ${PAGE_BUCKET_SQL} AS bucket,
             ROW_NUMBER() OVER (PARTITION BY url ORDER BY ${NEWEST_SETTLED_SQL}) AS rn
        FROM crawls WHERE ts BETWEEN ?3 AND ?4)
     WHERE rn = 1
  ),
  j AS (
    SELECT c.url, c.bucket AS cur, p.bucket AS prev, c.g, c.a FROM cur c LEFT JOIN prev p USING (url)
    UNION ALL
    SELECT p.url, NULL, p.bucket, 0, 0 FROM prev p WHERE p.url NOT IN (SELECT url FROM cur)
  )`;

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const binds = [range.from, range.to, range.prevFrom, range.prevTo];

  const matrix = await env.DB.prepare(
    `${PAIRS} SELECT cur, prev, COUNT(*) AS pages, SUM(g) AS g, SUM(a) AS a FROM j GROUP BY cur, prev`
  )
    .bind(...binds)
    .all();

  const samples = await env.DB.prepare(
    `${PAIRS}
     SELECT cur, prev, url FROM (
       SELECT cur, prev, url, ROW_NUMBER() OVER (PARTITION BY cur, prev ORDER BY g + a DESC, url) AS rn
         FROM j WHERE cur IS NOT NULL AND prev IS NOT NULL AND cur <> prev)
      WHERE rn <= 8`
  )
    .bind(...binds)
    .all();

  const buckets = Object.fromEntries(
    PAGE_BUCKETS.map((b) => [b.key, { key: b.key, label: b.label, pages: 0, before: 0, entered: 0, left: 0, googlebot: 0, ai_user: 0 }])
  );
  const totals = { pages: 0, before: 0, discovered: 0, not_refetched: 0 };
  const moves = [];

  for (const m of matrix.results ?? []) {
    if (m.cur) {
      const b = buckets[m.cur];
      b.pages += m.pages;
      b.googlebot += m.g ?? 0;
      b.ai_user += m.a ?? 0;
      totals.pages += m.pages;
      if (m.prev !== m.cur) b.entered += m.pages;
      if (!m.prev) totals.discovered += m.pages;
    }
    if (m.prev) {
      const b = buckets[m.prev];
      b.before += m.pages;
      totals.before += m.pages;
      if (m.prev !== m.cur) b.left += m.pages;
      if (!m.cur) totals.not_refetched += m.pages;
    }
    if (m.cur && m.prev && m.cur !== m.prev) {
      moves.push({ from: m.prev, to: m.cur, pages: m.pages, googlebot: m.g ?? 0, ai_user: m.a ?? 0, sample: [] });
    }
  }

  for (const s of samples.results ?? []) {
    const move = moves.find((m) => m.from === s.prev && m.to === s.cur);
    if (move) move.sample.push(s.url);
  }

  // Worse moves first (out of Indexable), then lateral, then better; within
  // each, the moves carrying the most demand first.
  const rank = (m) => (m.from === "indexable" ? 0 : m.to === "indexable" ? 2 : 1);
  moves.sort((x, y) => rank(x) - rank(y) || y.googlebot + y.ai_user - (x.googlebot + x.ai_user) || y.pages - x.pages);
  for (const m of moves) m.direction = ["worse", "lateral", "better"][rank(m)];

  return json({
    partial: !previousIsComplete(range, await firstVisitTs(env)),
    totals,
    buckets: Object.values(buckets).filter((b) => b.pages || b.before),
    moves,
  });
});
