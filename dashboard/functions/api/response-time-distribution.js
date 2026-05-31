// GET /api/response-time-distribution?from=<unix_ms>&to=<unix_ms>
// The paired backend for the frontend ResponseTimeProvider. Buckets crawls in
// the [from, to] window by response_time_ms into the five fixed speed bands
// (<0.5s / 0.5-1s / 1-2s / 2-5s / 5s+) and returns the per-band counts plus the
// mean. The bands are exhaustive (< 500 catches everything below the first edge,
// >= 5000 everything above the last) and response_time_ms is NOT NULL (see
// schema.sql), so every row lands in exactly one band and SUM(buckets) == total.
// Bucketing is done here rather than on the client because the client can't pull
// every response time; the same CASE-SUM histogram shape as metrics.js.
// avg_ms intentionally duplicates metrics.js's avg_response_ms — the footer needs
// it in this payload to avoid a second round-trip, and the endpoints cache apart.
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
       SUM(CASE WHEN response_time_ms <  500                              THEN 1 ELSE 0 END) AS b0,
       SUM(CASE WHEN response_time_ms >= 500  AND response_time_ms < 1000 THEN 1 ELSE 0 END) AS b1,
       SUM(CASE WHEN response_time_ms >= 1000 AND response_time_ms < 2000 THEN 1 ELSE 0 END) AS b2,
       SUM(CASE WHEN response_time_ms >= 2000 AND response_time_ms < 5000 THEN 1 ELSE 0 END) AS b3,
       SUM(CASE WHEN response_time_ms >= 5000                             THEN 1 ELSE 0 END) AS b4,
       AVG(response_time_ms)                                                                 AS avg_ms,
       COUNT(*)                                                                              AS total
     FROM crawls
     WHERE ts BETWEEN ?1 AND ?2`
  )
    .bind(from, to)
    .first();

  // An empty range yields one row whose aggregates are NULL — coerce to 0.
  return Response.json({
    buckets: [
      { key: "<0.5s",  c: row.b0 ?? 0 },
      { key: "0.5-1s", c: row.b1 ?? 0 },
      { key: "1-2s",   c: row.b2 ?? 0 },
      { key: "2-5s",   c: row.b3 ?? 0 },
      { key: "5s+",    c: row.b4 ?? 0 },
    ],
    avg_ms: row.avg_ms ?? 0,
    total: row.total ?? 0,
  });
}
