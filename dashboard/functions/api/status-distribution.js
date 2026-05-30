// GET /api/status-distribution?from=<unix_ms>&to=<unix_ms>
// The paired backend for the frontend StatusDistributionProvider. Counts crawls
// per distinct HTTP status in the [from, to] window. A NULL status (origin
// unreachable) collapses into its own group. Bucketing the codes into
// 2xx/3xx/4xx/5xx happens on the frontend (see charts/statusDistributionChart.js),
// keeping the SQL dumb — the same split-on-the-client approach as bot-activity.
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

  const { results } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS c
       FROM crawls
      WHERE ts BETWEEN ?1 AND ?2
      GROUP BY status
      ORDER BY status`
  )
    .bind(from, to)
    .all();

  return Response.json({ rows: results ?? [] });
}
