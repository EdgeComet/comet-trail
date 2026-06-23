// GET /api/description-analysis?from=<unix_ms>&to=<unix_ms>
// Backs the "Meta Description Analysis" segmented bar. Same shape and overlapping
// semantics as /api/title-analysis: collapse the crawls time-machine to each
// URL's latest visit in [from, to], keep pages whose latest visit was a 200, then
// bucket their meta descriptions. Duplicates is an independent overlay (a
// duplicated good-length description counts in both duplicates and good), so the
// frontend's percentages can sum past 100% — the bar is normalized by width.
//   total       — pages graded (latest visit was a 200)
//   missing     — meta_description NULL or blank
//   duplicates  — non-blank description shared by 2+ URLs
//   short       — non-blank description shorter than 70 characters
//   good        — non-blank description 70-160 characters (Google's sweet spot)
//   too_long    — non-blank description longer than 160 characters (gets truncated)
// LENGTH counts characters on TEXT; TRIM first so whitespace neither passes the
// "present" check nor skews the length. Reads the same D1 the worker writes to.
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
       SELECT url, status, meta_description,
              ROW_NUMBER() OVER (PARTITION BY url ORDER BY ts DESC) AS rn
       FROM crawls
       WHERE ts BETWEEN ?1 AND ?2
     ),
     snap AS (
       SELECT url, meta_description AS d FROM latest WHERE rn = 1 AND status = 200
     ),
     dups AS (
       SELECT d
       FROM snap
       WHERE d IS NOT NULL AND TRIM(d) <> ''
       GROUP BY d
       HAVING COUNT(*) > 1
     )
     SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN d IS NULL OR TRIM(d) = ''         THEN 1 ELSE 0 END) AS missing,
       SUM(CASE WHEN d IN (SELECT d FROM dups)         THEN 1 ELSE 0 END) AS duplicates,
       SUM(CASE WHEN d IS NOT NULL AND TRIM(d) <> '' AND LENGTH(TRIM(d)) < 70             THEN 1 ELSE 0 END) AS short,
       SUM(CASE WHEN d IS NOT NULL AND TRIM(d) <> '' AND LENGTH(TRIM(d)) BETWEEN 70 AND 160 THEN 1 ELSE 0 END) AS good,
       SUM(CASE WHEN d IS NOT NULL AND TRIM(d) <> '' AND LENGTH(TRIM(d)) > 160            THEN 1 ELSE 0 END) AS too_long
     FROM snap`
  )
    .bind(from, to)
    .first();

  // An empty window yields one row whose aggregates are 0 / NULL — coerce to 0.
  return Response.json({
    total: row.total ?? 0,
    missing: row.missing ?? 0,
    duplicates: row.duplicates ?? 0,
    short: row.short ?? 0,
    good: row.good ?? 0,
    too_long: row.too_long ?? 0,
  });
}
