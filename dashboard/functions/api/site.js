// GET /api/site
// Which site the data belongs to and whether any bot visit has arrived yet. The
// dashboard reads it once on load: the sidebar shows the host, and a fresh
// install with no rows gets the "waiting for bots" view instead of empty charts.
// Both lookups read a single index entry (idx_crawls_ts), never the table.
import { handle } from "../../lib/api.js";

export const onRequestGet = handle(async ({ env }) => {
  let last;
  try {
    last = await env.DB.prepare("SELECT url, ts FROM crawls ORDER BY ts DESC LIMIT 1").first();
  } catch (err) {
    // A database the schema was never applied to: say so, so the dashboard can
    // point at `npm run db:init` instead of failing on every chart.
    if (String(err?.message).includes("no such table")) {
      return Response.json({ host: null, last_ts: null, last_url: null, first_ts: null, schema: false });
    }
    throw err;
  }
  if (!last) return Response.json({ host: null, last_ts: null, last_url: null, first_ts: null, schema: true });

  const first = await env.DB.prepare("SELECT MIN(ts) AS ts FROM crawls").first();
  let host = null;
  try {
    host = new URL(last.url).host;
  } catch {
    host = null;
  }
  // No browser caching: this is the "is data arriving?" signal.
  return Response.json({ host, last_ts: last.ts, last_url: last.url, first_ts: first?.ts ?? null, schema: true });
});
