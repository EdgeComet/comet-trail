// GET /api/index-status-distribution?from=<unix_ms>&to=<unix_ms>
// The paired backend for the frontend IndexStatusDistributionProvider. Collapses
// the crawls time-machine to each URL's latest visit inside the [from, to] window
// (ROW_NUMBER per url, newest first), then counts those URLs by index_status. This
// is the un-bucketed companion to api/index-status-trend.js: same per-URL-latest
// semantic, but over the whole range instead of per day, so the shares reconcile
// with the Indexation summary cards (api/indexation-summary.js) rather than being
// skewed by URLs re-crawled across many days. index_status is never NULL
// (schema.sql), so the returned rows form a clean partition of distinct URLs.
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
    `WITH latest AS (
       SELECT url, index_status,
              ROW_NUMBER() OVER (PARTITION BY url ORDER BY ts DESC) AS rn
       FROM crawls
       WHERE ts BETWEEN ?1 AND ?2
     )
     SELECT index_status, COUNT(*) AS c
       FROM latest
      WHERE rn = 1
      GROUP BY index_status`
  )
    .bind(from, to)
    .all();

  return Response.json({ rows: results ?? [] });
}
