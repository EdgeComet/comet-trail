import { Provider } from "../core/provider.js";

// Loads the per-URL-latest index_status counts for the indexation distribution
// bar list from /api/index-status-distribution. Returns
// { rows: [{ index_status, c }] }. Granularity-free (no per-day bucketing), so the
// base from/to-only behavior and `name|from|to` cache key apply unchanged.
// Bucketing into the four status rows is done in the chart.
export class IndexStatusDistributionProvider extends Provider {
  constructor() {
    super("indexStatusDistribution", "/api/index-status-distribution");
  }
}
