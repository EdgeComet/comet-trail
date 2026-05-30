import { Provider } from "../core/provider.js";
import { pickGranularity } from "../core/bucketing.js";

// Loads the bot-activity time series from /api/bot-activity. The only thing it
// adds over the base Provider is a `bucket` param chosen from the range width;
// the cache key stays `name|from|to` because the granularity is fully determined
// by (from, to). Returns { granularity, rows: [{ t, series, c }] }.
export class BotActivityProvider extends Provider {
  constructor() {
    super("botActivity", "/api/bot-activity");
  }

  _params(from, to) {
    return { bucket: pickGranularity({ from, to }) };
  }
}
