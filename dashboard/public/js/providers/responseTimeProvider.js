import { Provider } from "../core/provider.js";

// Loads the response-time histogram for the response-time bar list from
// /api/response-time-distribution. Returns { buckets: [{ key, c }], avg_ms,
// total } with the five speed bands already ordered by the backend.
export class ResponseTimeProvider extends Provider {
  constructor() {
    super("responseTime", "/api/response-time-distribution");
  }
}
