import { Provider } from "../core/provider.js";

// Loads the per-status crawl counts for the status-distribution bar list from
// /api/status-distribution. Returns { rows: [{ status, c }] }, where status may
// be null (origin unreachable). Bucketing into 2xx/3xx/… is done in the chart.
export class StatusDistributionProvider extends Provider {
  constructor() {
    super("statusDistribution", "/api/status-distribution");
  }
}
