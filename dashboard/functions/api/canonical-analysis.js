// GET /api/canonical-analysis?from=<unix_ms>&to=<unix_ms>
// The paired backend for the frontend CanonicalAnalysisProvider. Like
// api/index-status-distribution.js it collapses the crawls time-machine to each
// URL's latest visit inside the [from, to] window (ROW_NUMBER per url, newest
// first), then classifies each into how it declares its canonical tag:
//   self    - has a canonical that is not flagged non_canonical (self-referencing)
//   cross   - has a canonical that resolves elsewhere (index_status = 'non_canonical')
//   missing - no canonical tag at all
// The self/cross split reuses the worker's authoritative index_status (worker
// computeIndexStatus already resolves relative canonicals against the final URL),
// so "cross" reconciles exactly with the Index Status Distribution card's
// "Non-canonical" count.
//
// Scope: only the latest visit is classified, AND only when it is status 200
// (the filter is applied after the per-URL-latest pick, so a URL whose current
// state is a redirect/404 is dropped rather than showing a stale canonical).
// Non-200 pages carry no canonical and would otherwise inflate "missing" with
// redirects/errors, so "missing" here means a live page genuinely lacking a
// canonical. The denominator is therefore smaller than the distribution card's
// total (which also counts non_200/blocked) — that is expected.
// Reads the same D1 database the tracking worker writes to (binding: DB).
import { NEWEST_SETTLED_SQL } from "../../lib/sql.js";
import { handle, json, parseRange } from "../../lib/api.js";

export const onRequestGet = handle(async ({ env, request }) => {
  const { from, to } = parseRange(request);

  // The CASE is repeated in GROUP BY (not referenced by its alias): SQLite allows
  // the alias, but repeating it keeps the query unambiguous and matches the
  // sibling api/index-status-distribution.js style.
  const { results } = await env.DB.prepare(
    `WITH latest AS (
       SELECT url, status, canonical, index_status,
              ROW_NUMBER() OVER (PARTITION BY url ORDER BY ${NEWEST_SETTLED_SQL}) AS rn
       FROM crawls
       WHERE ts BETWEEN ?1 AND ?2
     )
     SELECT
       CASE
         WHEN canonical IS NULL OR TRIM(canonical) = '' THEN 'missing'
         WHEN index_status = 'non_canonical'            THEN 'cross'
         ELSE 'self'
       END AS canonical_class,
       COUNT(*) AS c
       FROM latest
      WHERE rn = 1 AND status = 200
      GROUP BY
       CASE
         WHEN canonical IS NULL OR TRIM(canonical) = '' THEN 'missing'
         WHEN index_status = 'non_canonical'            THEN 'cross'
         ELSE 'self'
       END`
  )
    .bind(from, to)
    .all();

  return json({ rows: results ?? [] });
});
