import { Provider } from "../core/provider.js";

// Loads the four indexation stat-card counts for the selected window from
// /api/indexation-summary. from/to-only, so the base Provider cache key fits.
export class IndexationSummaryProvider extends Provider {
  constructor() {
    super("indexation-summary", "/api/indexation-summary");
  }
}
