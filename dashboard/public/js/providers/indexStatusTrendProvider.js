import { Provider } from "../core/provider.js";

// Loads the index-status trend from /api/index-status-trend. Granularity is fixed
// to day server-side, so unlike BotActivityProvider this adds no `bucket` param —
// the base from/to-only behavior and `name|from|to` cache key apply unchanged.
// Returns { granularity: "day", rows: [{ t, series, c }] }.
export class IndexStatusTrendProvider extends Provider {
  constructor() {
    super("indexStatusTrend", "/api/index-status-trend");
  }
}
