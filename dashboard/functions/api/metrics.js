// GET /api/metrics?from=<unix_ms>&to=<unix_ms>
// The paired backend for the frontend MetricsProvider. Runs ONE aggregate query
// over crawls in the [from, to] window and returns the four stat-card metrics:
//   total_requests   — rows captured
//   unique_urls      — distinct URLs visited
//   crawl_efficiency — percent of requests that returned status 200 (exactly 200)
//   avg_response_ms  — mean response time
// Reads the same D1 database the tracking worker writes to (binding: DB).
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

  const row = await env.DB.prepare(
    `SELECT
       COUNT(*)                                                   AS total_requests,
       COUNT(DISTINCT url)                                        AS unique_urls,
       CAST(SUM(CASE WHEN status = 200 THEN 1 ELSE 0 END) AS REAL)
         / NULLIF(COUNT(*), 0) * 100                              AS crawl_efficiency,
       AVG(response_time_ms)                                      AS avg_response_ms
     FROM crawls
     WHERE ts BETWEEN ?1 AND ?2`
  )
    .bind(from, to)
    .first();

  // An empty range yields one row whose aggregates are 0 or NULL — coerce NULLs.
  return Response.json({
    total_requests: row.total_requests ?? 0,
    unique_urls: row.unique_urls ?? 0,
    crawl_efficiency: row.crawl_efficiency ?? 0,
    avg_response_ms: row.avg_response_ms ?? 0,
  });
}
