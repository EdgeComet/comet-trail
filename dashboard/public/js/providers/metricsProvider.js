import { Provider } from "../core/provider.js";

// Loads the four summary metrics for the stat-card group from /api/metrics.
export class MetricsProvider extends Provider {
  constructor() {
    super("metrics", "/api/metrics");
  }
}
