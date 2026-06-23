// GET /api/content-summary?from=<unix_ms>&to=<unix_ms>
// The paired backend for the frontend ContentSummaryProvider. Collapses the
// crawls time-machine to each URL's latest visit inside the [from, to] window
// (ROW_NUMBER per url, newest first), keeps only pages whose latest visit was a
// 200 — a redirect or error legitimately has no title/description to grade, the
// same convention as "Pages missing a canonical" in docs/queries.md — then
// counts the four content-quality stat cards:
//   missing_titles        — latest title is NULL or blank
//   missing_descriptions  — latest meta_description is NULL or blank
//   duplicate_titles      — pages whose non-blank title is shared by 2+ URLs
//   h1_issues             — pages without exactly one H1 (zero, or several)
// Counts are distinct URLs by latest visit, NOT raw request volume. The metrics
// overlap by design: a page with no title usually has no H1 either, so it lands
// in both Missing Titles and H1 Issues. h1 is stored as a JSON array string, so
// json_array_length gives the heading count. Reads the same D1 database the
// tracking worker writes to (binding: DB).
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
       SELECT url, status, title, meta_description, h1,
              ROW_NUMBER() OVER (PARTITION BY url ORDER BY ts DESC) AS rn
       FROM crawls
       WHERE ts BETWEEN ?1 AND ?2
     ),
     snap AS (
       SELECT url, title, meta_description, h1
       FROM latest
       WHERE rn = 1 AND status = 200
     ),
     dups AS (
       SELECT title
       FROM snap
       WHERE title IS NOT NULL AND TRIM(title) <> ''
       GROUP BY title
       HAVING COUNT(*) > 1
     )
     SELECT
       SUM(CASE WHEN title IS NULL OR TRIM(title) = ''            THEN 1 ELSE 0 END) AS missing_titles,
       SUM(CASE WHEN meta_description IS NULL OR TRIM(meta_description) = '' THEN 1 ELSE 0 END) AS missing_descriptions,
       SUM(CASE WHEN title IN (SELECT title FROM dups)            THEN 1 ELSE 0 END) AS duplicate_titles,
       SUM(CASE WHEN h1 IS NULL OR h1 = '' OR json_array_length(h1) <> 1 THEN 1 ELSE 0 END) AS h1_issues
     FROM snap`
  )
    .bind(from, to)
    .first();

  // An empty window yields one row whose SUMs are all NULL — coerce to 0.
  return Response.json({
    missing_titles: row.missing_titles ?? 0,
    missing_descriptions: row.missing_descriptions ?? 0,
    duplicate_titles: row.duplicate_titles ?? 0,
    h1_issues: row.h1_issues ?? 0,
  });
}
