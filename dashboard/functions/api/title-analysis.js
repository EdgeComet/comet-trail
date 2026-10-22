// GET /api/title-analysis?from=<unix_ms>&to=<unix_ms>
// Backs the frontend TitleAnalysisProvider / the "Title Analysis" segmented bar.
// Collapses the crawls time-machine to each URL's latest visit in [from, to]
// (ROW_NUMBER per url, newest first), keeps pages whose latest visit was a 200,
// then buckets their titles. The buckets OVERLAP by design (see the dashboard's
// Title bucketing choice): Duplicates is an independent overlay, so a duplicated
// good-length title is counted in BOTH duplicates and good. As a result the four
// percentages the frontend derives can sum past 100% — the bar is normalized by
// segment width, not a strict partition.
//   total       — pages graded (latest visit was a 200)
//   missing     — title NULL or blank
//   duplicates  — non-blank title shared by 2+ URLs
//   short       — non-blank title shorter than 30 characters
//   good        — non-blank title 30+ characters
// LENGTH counts characters on TEXT; TRIM first so surrounding whitespace neither
// passes the "present" check nor inflates the length. Reads the same D1 the
// tracking worker writes to (binding: DB).
import { NEWEST_SETTLED_SQL } from "../../lib/sql.js";
import { handle, json, parseRange } from "../../lib/api.js";

export const onRequestGet = handle(async ({ env, request }) => {
  const { from, to } = parseRange(request);

  const row = await env.DB.prepare(
    `WITH latest AS (
       SELECT url, status, title,
              ROW_NUMBER() OVER (PARTITION BY url ORDER BY ${NEWEST_SETTLED_SQL}) AS rn
       FROM crawls
       WHERE ts BETWEEN ?1 AND ?2
     ),
     snap AS (
       SELECT url, title FROM latest WHERE rn = 1 AND status = 200
     ),
     dups AS (
       SELECT title
       FROM snap
       WHERE title IS NOT NULL AND TRIM(title) <> ''
       GROUP BY title
       HAVING COUNT(*) > 1
     )
     SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN title IS NULL OR TRIM(title) = ''       THEN 1 ELSE 0 END) AS missing,
       SUM(CASE WHEN title IN (SELECT title FROM dups)       THEN 1 ELSE 0 END) AS duplicates,
       SUM(CASE WHEN title IS NOT NULL AND TRIM(title) <> '' AND LENGTH(TRIM(title)) < 30  THEN 1 ELSE 0 END) AS short,
       SUM(CASE WHEN title IS NOT NULL AND TRIM(title) <> '' AND LENGTH(TRIM(title)) >= 30 THEN 1 ELSE 0 END) AS good
     FROM snap`
  )
    .bind(from, to)
    .first();

  // An empty window yields one row whose aggregates are 0 / NULL — coerce to 0.
  return json({
    total: row.total ?? 0,
    missing: row.missing ?? 0,
    duplicates: row.duplicates ?? 0,
    short: row.short ?? 0,
    good: row.good ?? 0,
  });
});
