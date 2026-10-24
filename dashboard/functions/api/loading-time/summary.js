// GET /api/loading-time/summary?from=&to=&group=all|googlebot|ai
// Log Analyzer > Loading Time: how fast the origin answered the selected bots,
// for the period and the one before.
//   current, previous  { requests, median, p95, slow }: the median and 95th
//                      percentile response time (lib/sql.js percentileSql) and
//                      the requests answered in slow_ms or more
//   sections           the busiest sections (lib/sql.js SECTION_SQL) in the
//                      period with the same figures; `other` counts the rest
//   slowest            the section with the highest median among those with
//                      at least MIN_SECTION_REQUESTS requests, so a page or two
//                      cannot rank, with `prev`, its figures before; or null
//   slow_ms            the threshold (lib/sql.js SLOW_MS)
// `previous` is null when recorded data does not reach back over the whole
// comparison window, as on the other cards.
//
// One read covering both periods. Each visit is ranked by response time
// within its period and section, and within its period: a section's
// percentiles come from the first rank, the period's from the second. Per
// section, the outer query keeps the smallest time at or past the period's
// percentile rank; the smallest of those across sections is the period's
// percentile itself.
import { handle, json, parseRange, enumParam, firstVisitTs, previousIsComplete } from "../../../lib/api.js";
import { BOT_GROUP_SQL, SECTION_SQL, SLOW_MS, timeRankSql, percentileSql } from "../../../lib/sql.js";

const TOP_SECTIONS = 10;
const MIN_SECTION_REQUESTS = 20;

// ?1 start of the read (the previous period's start, or the period's), ?2 to,
// ?3 from: visits before it belong to the previous period.
const sql = (group) => `
  SELECT period, section, COUNT(*) AS requests,
         ${percentileSql(0.5)} AS median,
         ${percentileSql(0.95)} AS p95,
         MIN(CASE WHEN rn_all >= 0.5 * n_all THEN response_time_ms END) AS period_median,
         MIN(CASE WHEN rn_all >= 0.95 * n_all THEN response_time_ms END) AS period_p95,
         SUM(CASE WHEN response_time_ms >= ${SLOW_MS} THEN 1 ELSE 0 END) AS slow
    FROM (
      SELECT period, section, response_time_ms, ${timeRankSql("period, section")},
             ROW_NUMBER() OVER (PARTITION BY period ORDER BY response_time_ms) AS rn_all,
             COUNT(*) OVER (PARTITION BY period) AS n_all
        FROM (SELECT CASE WHEN ts >= ?3 THEN 'current' ELSE 'previous' END AS period,
                     ${SECTION_SQL} AS section, response_time_ms
                FROM crawls
               WHERE ts BETWEEN ?1 AND ?2 AND ${BOT_GROUP_SQL[group]}))
   GROUP BY period, section`;

function overall(rows) {
  if (!rows.length) return { requests: 0, median: null, p95: null, slow: 0 };
  return {
    requests: rows.reduce((a, r) => a + r.requests, 0),
    median: Math.min(...rows.map((r) => r.period_median ?? Infinity)),
    p95: Math.min(...rows.map((r) => r.period_p95 ?? Infinity)),
    slow: rows.reduce((a, r) => a + r.slow, 0),
  };
}

const figures = (r) => ({ requests: r.requests, median: r.median, p95: r.p95, slow: r.slow });

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const group = enumParam(request, "group", Object.keys(BOT_GROUP_SQL), "all");
  const fair = previousIsComplete(range, await firstVisitTs(env));

  const { results } = await env.DB.prepare(sql(group))
    .bind(fair ? range.prevFrom : range.from, range.to, range.from)
    .all();
  const rows = results ?? [];
  const now = rows.filter((r) => r.period === "current");
  const before = fair ? new Map(rows.filter((r) => r.period === "previous").map((r) => [r.section, r])) : null;

  const list = now.sort((a, b) => b.requests - a.requests || a.section.localeCompare(b.section));
  const rest = list.slice(TOP_SECTIONS);
  const slowest = list
    .filter((r) => r.requests >= MIN_SECTION_REQUESTS)
    .reduce((top, r) => (!top || r.median > top.median || (r.median === top.median && r.p95 > top.p95) ? r : top), null);

  return json({
    current: overall(now),
    previous: fair ? overall([...before.values()]) : null,
    sections: {
      rows: list.slice(0, TOP_SECTIONS).map((r) => ({ section: r.section, ...figures(r) })),
      other: rest.length
        ? { sections: rest.length, requests: rest.reduce((a, r) => a + r.requests, 0), slow: rest.reduce((a, r) => a + r.slow, 0) }
        : null,
    },
    slowest: slowest && {
      section: slowest.section,
      ...figures(slowest),
      prev: before?.has(slowest.section) ? figures(before.get(slowest.section)) : null,
    },
    min_section_requests: MIN_SECTION_REQUESTS,
    slow_ms: SLOW_MS,
  });
});
