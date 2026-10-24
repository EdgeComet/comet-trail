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
import { pickGranularity } from "./bucketing.js";

const TTL_MS = 5 * 60 * 1000; // 5 minutes — equal to the date-range bucket.

export class Provider {
  constructor(name, endpoint) {
    this.name = name; // cache-key prefix, e.g. 'metrics'
    this.endpoint = endpoint; // e.g. '/api/metrics'
    this._cache = new Map(); // key -> { data, expiresAt }; dies on page reload
    this._pending = new Map(); // key -> in-flight promise, so cards sharing a provider fetch once
  }

  _key(from, to, extra = {}) {
    const tail = Object.keys(extra).length ? `|${new URLSearchParams(extra)}` : "";
    return `${this.name}|${from}|${to}${tail}`;
  }

  // Extra query params beyond from/to. Base sends none; subclasses override to
  // add their own (e.g. a bucket granularity). Anything derived purely from
  // (from, to) needs no change to _key, since the key already varies with them.
  _params(_from, _to) {
    return {};
  }

  // Returns the parsed JSON for this range. Cache hit (unexpired) => no network.
  // `extra` carries per-call params beyond the range (a search term, a URL, a
  // bot group) and is part of the cache key.
  async get(from, to, extra = {}) {
    const now = Date.now();
    const key = this._key(from, to, extra);

    const hit = this._cache.get(key);
    if (hit && hit.expiresAt > now) return hit.data;
    if (this._pending.has(key)) return this._pending.get(key);

    const promise = this._fetch(key, from, to, extra, now);
    this._pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this._pending.delete(key);
    }
  }

  // The cached response for this range, or undefined when there is none yet:
  // for a card that draws without it first and again once it is in
  // (core/changeMarkers.js).
  peek(from, to, extra = {}) {
    const hit = this._cache.get(this._key(from, to, extra));
    return hit && hit.expiresAt > Date.now() ? hit.data : undefined;
  }

  async _fetch(key, from, to, extra, now) {
    const query = new URLSearchParams({ from, to, ...this._params(from, to), ...extra });
    const url = `${this.endpoint}?${query}`;
    const res = await fetch(url);
    if (!res.ok) {
      // The API answers errors as { error }; show that rather than a bare code.
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
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

// A provider for time series: adds the bucket size (hour or day) picked from
// the range width. The cache key needs no change, since the granularity is
// fully determined by (from, to).
export class BucketedProvider extends Provider {
  _params(from, to) {
    return { bucket: pickGranularity({ from, to }) };
  }
}

// A view onto part of another provider's response, for a card that shows one
// slice of it. Shares the parent's cache and in-flight request, so several
// cards cost one fetch.
export function derive(parent, pick) {
  return { get: async (from, to, extra) => pick(await parent.get(from, to, extra)) };
}
