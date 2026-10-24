import { Provider } from "../core/provider.js";

// Loads /api/changes: every change bots received in the period, its per-day
// counts, the change events and the newest changes. One instance for the whole
// app: the Changes page and the change markers on other reports
// (core/changeMarkers.js) share its cache and its in-flight request, so this,
// the heaviest query in the app, runs once per period however many views ask.
export const changesProvider = new Provider("changes", "/api/changes");
