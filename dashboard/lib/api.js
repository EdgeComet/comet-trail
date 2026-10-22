// Shared plumbing for the Pages Functions under functions/api/.
//
// Lives outside functions/ on purpose: Pages turns every file in functions/
// into a route, while modules elsewhere are only bundled into the routes that
// import them.

const DAY_MS = 86400000;
const MAX_SPAN_DAYS = 366;

// Responses are keyed by from/to, which the frontend quantizes to 5-minute
// buckets (public/js/core/dateRange.js), so a repeat view within that bucket is
// served from the browser cache and costs no D1 reads. `private` because the
// dashboard may sit behind Cloudflare Access.
const CACHE_HEADERS = { "Cache-Control": "private, max-age=300" };

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(data) {
  return Response.json(data, { headers: CACHE_HEADERS });
}

// Wraps a handler with the error policy every endpoint shares: bad input is a
// 400 with a readable message, anything else a generic 500. A raw SQL error is
// logged, never sent to the page.
export function handle(fn) {
  return async (context) => {
    try {
      return await fn(context);
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json({ error: err.message }, { status: err.status });
      }
      // The one database error worth showing: the free plan's daily limit,
      // which lifts by itself at 00:00 UTC.
      if (/exceeded D1's free tier daily/i.test(String(err?.message))) {
        return Response.json(
          { error: "Cloudflare D1 daily free-plan limit reached; data loads again after 00:00 UTC" },
          { status: 503 }
        );
      }
      console.error("comet-trail api error:", err);
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  };
}

// Reads ?from=&to= (unix ms) and derives the comparison window: the period of
// the same length that ends where this one starts.
export function parseRange(request) {
  const params = new URL(request.url).searchParams;
  const rawFrom = params.get("from");
  const rawTo = params.get("to");
  const from = Number(rawFrom);
  const to = Number(rawTo);
  // Number(null) and Number("") are 0 (finite), so reject blanks explicitly.
  if (!rawFrom || !rawTo || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new HttpError(400, "from/to required (unix ms, from < to)");
  }
  const span = to - from;
  // The period popover allows 365 days; anything longer is a mistake that
  // would read a year of rows per chart.
  if (span > MAX_SPAN_DAYS * DAY_MS) {
    throw new HttpError(400, `The period can be at most ${MAX_SPAN_DAYS} days`);
  }
  return { from, to, span, days: Math.round(span / DAY_MS), prevFrom: from - span, prevTo: from };
}

// Timestamp of the oldest recorded visit, or null on an empty database. Reads
// one index entry (idx_crawls_ts).
export async function firstVisitTs(env) {
  const row = await env.DB.prepare("SELECT MIN(ts) AS first FROM crawls").first();
  return row?.first ?? null;
}

// A change figure is only fair when the comparison window is fully covered by
// recorded data; otherwise a half-empty previous period inflates every delta.
export function previousIsComplete(range, first) {
  return first != null && range.prevFrom >= first;
}

export function intParam(request, name, fallback, { min = 0, max = Infinity } = {}) {
  const raw = new URL(request.url).searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

export function enumParam(request, name, allowed, fallback) {
  const raw = new URL(request.url).searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!allowed.includes(raw)) throw new HttpError(400, `${name} must be one of ${allowed.join(", ")}`);
  return raw;
}

// D1 returns JSON columns as text. Parse leniently: a malformed value reads as
// an empty list rather than failing the whole response.
export function parseJsonList(text) {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
