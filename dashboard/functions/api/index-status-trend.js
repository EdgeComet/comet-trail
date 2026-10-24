// GET /api/index-status-trend?from=<unix_ms>&to=<unix_ms>&group=all|googlebot|bingbot|ai
// Pages per indexability verdict, day by day, for the Indexation trend chart.
// `group` reads only those bots' visits (lib/sql.js BOT_GROUP_SQL), as
// /api/indexation does; every bot by default.
// Each day counts every page bots fetched in a window as long as the selected
// period that ends with that day, once, with the verdict of its newest settled
// visit in the window (lib/sql.js PAGE_BUCKET_SQL and NEWEST_SETTLED_SQL). The
// last day's window ends at `to`, so it is the period itself and its bar is
// exactly the Indexability table (/api/indexation). A day when bots crawl many
// filter URLs adds pages to its window instead of turning a share around.
//
// One read of [from - span, to]. Each visit decides its page's verdict from the
// moment it is made until a newer visit takes over or it leaves the window,
// span later:
//   - a settled visit: until the page's next settled visit
//   - an incident (no response, 429, 5xx): until the page's next visit of any
//     kind, and only once the last settled visit before it has left the window
// SQL turns each into a +1 and a -1 for its verdict and sums them per day,
// folding the days before the period into its first day; the running total
// over at most 367 days happens here.
//
// Returns { granularity: "day", series, rows: [{ t, series, c }], days,
// complete_from }: `days` is the window length, `complete_from` the first day
// whose window starts at or after the first recorded visit (null when no day's
// does), since the bars before it count fewer days of visits.
//
// The day size is inlined as an integer literal and the bound numbers are cast
// to INTEGER: a JS number can bind as REAL, which turns SQLite's integer
// division into float division and corrupts the day keys (see bot-activity.js).
import { handle, json, parseRange, enumParam, firstVisitTs } from "../../lib/api.js";
import { BOT_GROUP_SQL, PAGE_BUCKET_SQL, PAGE_BUCKETS, SETTLED_SQL } from "../../lib/sql.js";

const DAY_MS = 86400000;

// ?1 from - span, ?2 to, ?3 span, ?4 the first day of the period.
//   v  each visit, with the page's next visit, next settled visit and last
//      settled visit before it
//   d  [start, stop): when the visit decides its page's verdict
//   e  a +1 at start and a -1 at stop. CROSS JOIN keeps the visits in the
//      outer loop: the other order reads the crawls table once per row of
//      the two-row table.
const sql = (group) => `
  WITH v AS (
    SELECT ${PAGE_BUCKET_SQL} AS bucket, ${SETTLED_SQL} AS settled, ts,
           LEAD(ts) OVER w AS next_visit,
           MIN(CASE WHEN ${SETTLED_SQL} THEN ts END) OVER (w ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING) AS next_settled,
           MAX(CASE WHEN ${SETTLED_SQL} THEN ts END) OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_settled
      FROM crawls
     WHERE ts BETWEEN ?1 AND ?2 AND ${BOT_GROUP_SQL[group]}
    WINDOW w AS (PARTITION BY url ORDER BY ts)
  ),
  d AS (
    SELECT bucket,
           CASE WHEN settled THEN ts
                ELSE MAX(ts, COALESCE(prev_settled + CAST(?3 AS INTEGER) + 1, ts)) END AS start,
           MIN(ts + CAST(?3 AS INTEGER) + 1,
               COALESCE(CASE WHEN settled THEN next_settled ELSE next_visit END, ts + CAST(?3 AS INTEGER) + 1)) AS stop
      FROM v
  ),
  e AS (
    SELECT bucket, CASE n WHEN 1 THEN start ELSE stop END AS at, n
      FROM d CROSS JOIN (SELECT 1 AS n UNION ALL SELECT -1)
     WHERE start < stop
  )
  SELECT MAX(at / ${DAY_MS} * ${DAY_MS}, CAST(?4 AS INTEGER)) AS t, bucket, SUM(n) AS n
    FROM e
   WHERE at <= ?2
   GROUP BY t, bucket`;

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const group = enumParam(request, "group", Object.keys(BOT_GROUP_SQL), "all");
  const day0 = Math.floor(range.from / DAY_MS) * DAY_MS;

  const [{ results }, first] = await Promise.all([
    env.DB.prepare(sql(group)).bind(range.from - range.span, range.to, range.span, day0).all(),
    firstVisitTs(env),
  ]);

  const changes = new Map();
  for (const r of results ?? []) {
    if (!changes.has(r.t)) changes.set(r.t, []);
    changes.get(r.t).push(r);
  }

  // The running total per verdict, read at the end of each day (at `to` on the
  // last one), when its window is [end - span, end].
  const level = new Map(PAGE_BUCKETS.map((b) => [b.key, 0]));
  const rows = [];
  let complete_from = null;
  for (let t = day0; t <= range.to; t += DAY_MS) {
    for (const r of changes.get(t) ?? []) level.set(r.bucket, level.get(r.bucket) + r.n);
    for (const [series, c] of level) if (c > 0) rows.push({ t, series, c });
    const end = Math.min(t + DAY_MS - 1, range.to);
    if (complete_from === null && first !== null && end - range.span >= first) complete_from = t;
  }

  return json({ granularity: "day", series: PAGE_BUCKETS, rows, days: range.days, complete_from });
});
