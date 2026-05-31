// GET /api/index-status-trend?from=<unix_ms>&to=<unix_ms>
// Feeds the frontend IndexStatusTrendProvider. Buckets crawls by DAY and, within
// each day, collapses to each URL's latest visit (ROW_NUMBER per url+day, newest
// first) before counting by index_status. That per-URL-latest semantic matches
// the Indexation summary cards (see api/indexation-summary.js), so the trend's
// shares reconcile with the summary instead of being skewed by frequently
// re-crawled URLs. Returns one row per (day, index_status); gap-filling and
// column assembly happen on the frontend (charts/indexStatusTrendChart.js), so
// empty days are simply absent here. index_status is never NULL (schema.sql), so
// the four series form a clean partition that sums to 100% per bucket.
//
// Granularity is fixed to day (the chart renders daily bars), so there is no
// bucket param. The day size is inlined as an integer literal, NOT a bound
// ?-param: binding a JS number can bind as REAL, turning SQLite's integer
// division into float division and corrupting the bucket keys (same hazard noted
// in api/bot-activity.js). It must match BUCKET_MS.day in public/js/core/bucketing.js.
// Reads the same D1 database the tracking worker writes to (binding: DB).
const DAY_MS = 86400000;

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const rawFrom = url.searchParams.get("from");
  const rawTo = url.searchParams.get("to");
  const from = Number(rawFrom);
  const to = Number(rawTo);

  // Reject absent/blank params too — Number(null) and Number("") are 0 (finite).
  if (rawFrom === null || rawTo === null || rawFrom === "" || rawTo === "" ||
      !Number.isFinite(from) || !Number.isFinite(to)) {
    return Response.json({ error: "from/to required (unix ms)" }, { status: 400 });
  }

  const { results } = await env.DB.prepare(
    `WITH latest AS (
       SELECT (ts / ${DAY_MS}) * ${DAY_MS} AS t,
              index_status,
              ROW_NUMBER() OVER (
                PARTITION BY url, ts / ${DAY_MS} ORDER BY ts DESC
              ) AS rn
         FROM crawls
        WHERE ts BETWEEN ?1 AND ?2
     )
     SELECT t, index_status AS series, COUNT(*) AS c
       FROM latest
      WHERE rn = 1
      GROUP BY t, series
      ORDER BY t`
  )
    .bind(from, to)
    .all();

  return Response.json({ granularity: "day", rows: results ?? [] });
}
