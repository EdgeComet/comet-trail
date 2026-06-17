import { Provider } from "../core/provider.js";

// Loads the per-URL-latest canonical classification for the canonical analysis
// bar list from /api/canonical-analysis. Returns
// { rows: [{ canonical_class, c }] } where canonical_class is self | cross |
// missing. Granularity-free (no per-day bucketing), so the base from/to-only
// behavior and `name|from|to` cache key apply unchanged. Bucketing into the
// three rows is done server-side; the chart just maps and renders.
export class CanonicalAnalysisProvider extends Provider {
  constructor() {
    super("canonicalAnalysis", "/api/canonical-analysis");
  }
}
