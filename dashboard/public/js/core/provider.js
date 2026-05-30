// Provider — a data loader dedicated to one Chart.
//
// Each provider knows exactly one backend endpoint and caches its own results
// in a session-scoped, in-memory Map keyed by `name|from|to`. A cache hit
// returns instantly with no network; a miss (or an expired entry) AJAXes the
// endpoint and stores the result with a fresh expiry.
//
// The cache only ever hits because the date range is quantized to the same
// bucket as TTL_MS upstream (see core/dateRange.js) — without that, from/to
// would drift every millisecond and every key would be unique.
const TTL_MS = 5 * 60 * 1000; // 5 minutes — equal to the date-range bucket.

export class Provider {
  constructor(name, endpoint) {
    this.name = name; // cache-key prefix, e.g. 'metrics'
    this.endpoint = endpoint; // e.g. '/api/metrics'
    this._cache = new Map(); // key -> { data, expiresAt }; dies on page reload
  }

  _key(from, to) {
    return `${this.name}|${from}|${to}`;
  }

  // Returns the parsed JSON for this range. Cache hit (unexpired) => no network.
  async get(from, to) {
    const now = Date.now();
    const key = this._key(from, to);

    const hit = this._cache.get(key);
    if (hit && hit.expiresAt > now) return hit.data;

    const url = `${this.endpoint}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Only successes are cached, so a failed load retries cleanly next time.
    this._cache.set(key, { data, expiresAt: now + TTL_MS });
    this._prune(now);
    return data;
  }

  // Drop expired entries so the Map can't grow unbounded over a long session.
  _prune(now) {
    for (const [key, entry] of this._cache) {
      if (entry.expiresAt <= now) this._cache.delete(key);
    }
  }
}
