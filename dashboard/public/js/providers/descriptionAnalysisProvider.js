import { Provider } from "../core/provider.js";

// Loads the Meta Description Analysis bucket counts for the selected window from
// /api/description-analysis. from/to-only, so the base Provider cache key fits.
export class DescriptionAnalysisProvider extends Provider {
  constructor() {
    super("description-analysis", "/api/description-analysis");
  }
}
