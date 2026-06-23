import { Provider } from "../core/provider.js";

// Loads the Title Analysis bucket counts for the selected window from
// /api/title-analysis. from/to-only, so the base Provider cache key fits.
export class TitleAnalysisProvider extends Provider {
  constructor() {
    super("title-analysis", "/api/title-analysis");
  }
}
