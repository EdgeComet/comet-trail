// DateRangeStore — the single source of truth for the dashboard's global
// from/to window, plus a minimal subscriber registry (no framework).
//
// The range boundaries are quantized to a 5-minute bucket: `to` snaps down to a
// bucket edge and `from` is derived from it. This is deliberate — it keeps the
// provider cache key stable within a bucket (so repeat views hit the cache) and
// rolling the bucket is what naturally refreshes the data. The cost is that the
// newest crawls are not shown until the bucket rolls (up to ~5 min lag).
const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET_MS = 5 * 60 * 1000; // matches Provider TTL_MS

export class DateRangeStore {
  constructor(defaultDays = 30) {
    this._subs = new Set();
    this._range = DateRangeStore.rangeForDays(defaultDays);
  }

  // { from, to } in unix milliseconds, bucket-aligned. Matches crawls.ts.
  static rangeForDays(days) {
    const to = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
    const from = to - days * DAY_MS;
    return { from, to };
  }

  get() {
    return this._range;
  }

  // Register a listener; returns an unsubscribe function.
  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  // Recompute the range for a preset and notify every subscriber.
  setDays(days) {
    this._range = DateRangeStore.rangeForDays(days);
    for (const fn of this._subs) fn(this._range);
  }
}
