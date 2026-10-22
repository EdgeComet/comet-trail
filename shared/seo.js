// SEO rules shared by the collector (worker/src/index.js) and the demo seed
// (scripts/seed-demo.mjs), so demo rows follow exactly the rules real rows do.

// Splits a meta robots/googlebot content string into normalized directives:
// comma-separated, trimmed, lowercased, empties dropped. Returns [] for
// null/undefined/empty input (e.g. when no such meta tag was present).
export function parseDirectives(content) {
  if (!content) return [];
  return content
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

// Computes the page's indexation status, porting engine dom.go IndexationStatus:
//   non_200        - status is not 200
//   blocked_by_meta- meta robots/googlebot carries noindex|none (googlebot wins)
//   non_canonical  - canonical resolves to a different URL than finalUrl
//   indexable      - none of the above
// Canonical uses an EXACT .href comparison, so trailing-slash, query-param, or
// fragment differences read as non_canonical by design.
export function computeIndexStatus({ status, metaRobots, metaGooglebot, canonical, finalUrl }) {
  if (status !== 200) return 'non_200';
  const sel = metaGooglebot.length ? metaGooglebot : metaRobots; // googlebot precedence (engine)
  if (sel.includes('noindex') || sel.includes('none')) return 'blocked_by_meta';
  const c = canonical && canonical.trim();
  if (c) {
    try {
      if (new URL(c, finalUrl).href !== finalUrl) return 'non_canonical';
    } catch {
      // Malformed canonical: fail safe, don't flag.
    }
  }
  return 'indexable';
}
