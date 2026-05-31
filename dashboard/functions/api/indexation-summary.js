// GET /api/indexation-summary?from=<unix_ms>&to=<unix_ms>
// The paired backend for the frontend IndexationSummaryProvider. Collapses the
// crawls time-machine to each URL's latest visit inside the [from, to] window
// (ROW_NUMBER per url, newest first), then counts the four indexation stat cards:
//   indexable      — latest index_status is 'indexable'
//   non_indexable  — latest index_status is anything else (non_200 /
//                    blocked_by_meta / non_canonical); index_status is never NULL
//   non_canonical  — latest index_status is 'non_canonical'
//   redirects      — latest status is 3xx (a clean subset of non_200)
// Counts are distinct URLs by latest visit, NOT raw request volume — that is why
// "redirects" here differs from the Log Analyzer's 3xx request bar by design.
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
    `WITH latest AS (
       SELECT url, index_status, status,
              ROW_NUMBER() OVER (PARTITION BY url ORDER BY ts DESC) AS rn
       FROM crawls
       WHERE ts BETWEEN ?1 AND ?2
     )
     SELECT
       SUM(CASE WHEN index_status = 'indexable'     THEN 1 ELSE 0 END) AS indexable,
       SUM(CASE WHEN index_status <> 'indexable'    THEN 1 ELSE 0 END) AS non_indexable,
       SUM(CASE WHEN index_status = 'non_canonical' THEN 1 ELSE 0 END) AS non_canonical,
       SUM(CASE WHEN status BETWEEN 300 AND 399     THEN 1 ELSE 0 END) AS redirects
     FROM latest
     WHERE rn = 1`
  )
    .bind(from, to)
    .first();

  // An empty window yields one row whose SUMs are all NULL — coerce to 0.
  return Response.json({
    indexable: row.indexable ?? 0,
    non_indexable: row.non_indexable ?? 0,
    non_canonical: row.non_canonical ?? 0,
    redirects: row.redirects ?? 0,
  });
}
