import { Provider } from "../core/provider.js";

// Loads the four content-quality stat-card counts for the selected window from
// /api/content-summary. from/to-only, so the base Provider cache key fits.
export class ContentSummaryProvider extends Provider {
  constructor() {
    super("content-summary", "/api/content-summary");
  }
}
