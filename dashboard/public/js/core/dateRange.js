// DateRangeStore — the single source of truth for the dashboard's global
// period, plus a minimal subscriber registry (no framework).
//
// A period is either a preset ("the last N days", ending now) or a custom
// range of whole days, picked in the header's period popover (core/report.js).
// Days are UTC days, the same days the charts bucket by (core/bucketing.js).
//
// Boundaries that end "now" are quantized to a 5-minute bucket: `to` snaps down
// to a bucket edge. This keeps the provider cache key stable within a bucket (so
// repeat views hit the cache), and rolling the bucket is what refreshes the
// data. The cost is that the newest crawls show up to ~5 minutes late. A custom
// range that ends before today has fixed boundaries, so it caches for good.
const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET_MS = 5 * 60 * 1000; // matches Provider TTL_MS
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// The longest period the popover accepts; the API refuses longer ones.
export const MAX_DAYS = 365;
export const DEFAULT_DAYS = 30;

export const PRESETS = [
  { days: 1, label: "Last 24 hours", name: "24 hours", param: "24h" },
  { days: 7, label: "Last 7 days", name: "7 days", param: "7d" },
  { days: 14, label: "Last 14 days", name: "14 days", param: "14d" },
  { days: 30, label: "Last 30 days", name: "30 days", param: "30d" },
  { days: 90, label: "Last 90 days", name: "90 days", param: "90d" },
];

const nowBucket = () => Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;

// "YYYY-MM-DD" <-> unix ms of that day's 00:00 UTC.
export const dayStart = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

export class DateRangeStore {
  constructor(defaultDays = DEFAULT_DAYS) {
    this._subs = new Set();
    this.days = defaultDays; // preset length; null while a custom range is set
    this.custom = null; // { fromDay, toDay } as "YYYY-MM-DD", both inclusive
    this.minTs = null; // oldest recorded visit (main.js sets it from /api/site)
    this._range = this._compute();
  }

  // { from, to } in unix milliseconds for "the last N days", bucket-aligned.
  static rangeForDays(days) {
    const to = nowBucket();
    const from = to - days * DAY_MS;
    return { from, to };
  }

  _compute() {
    if (!this.custom) return DateRangeStore.rangeForDays(this.days);
    // A range that includes today ends now, not at a midnight still to come.
    const to = Math.min(dayStart(this.custom.toDay) + DAY_MS - 1, nowBucket());
    return { from: dayStart(this.custom.fromDay), to };
  }

  get() {
    return this._range;
  }

  // Register a listener; returns an unsubscribe function.
  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  _notify() {
    for (const fn of this._subs) fn(this._range);
  }

  // Switch to a preset and notify every subscriber.
  setDays(days) {
    this.days = days;
    this.custom = null;
    this._range = this._compute();
    this._notify();
  }

  // Switch to a custom range of whole days. Returns an error message for the
  // popover, or null once applied.
  setCustom(fromDay, toDay) {
    const error = this.validate(fromDay, toDay);
    if (error) return error;
    this.days = null;
    this.custom = { fromDay, toDay };
    this._range = this._compute();
    this._notify();
    return null;
  }

  validate(fromDay, toDay) {
    if (!DAY_RE.test(fromDay ?? "") || !DAY_RE.test(toDay ?? "")) return "Pick a start and an end date.";
    const from = dayStart(fromDay);
    const to = dayStart(toDay);
    if (Number.isNaN(from) || Number.isNaN(to)) return "Pick a start and an end date.";
    if (to < from) return "The end date is before the start date.";
    if (to > dayStart(dayOf(Date.now()))) return "The end date is in the future.";
    if ((to - from) / DAY_MS + 1 > MAX_DAYS) return `Pick at most ${MAX_DAYS} days.`;
    if (this.minTs !== null && to < dayStart(dayOf(this.minTs))) {
      return `No visit was recorded before ${dayOf(this.minTs)}.`;
    }
    return null;
  }

  // Re-quantize to now, so a view opened after the bucket rolled shows fresh
  // data instead of the window from when the app loaded.
  refresh() {
    this._range = this._compute();
  }

  // The period as it appears in the address bar (?period=...): "7d", "24h" or
  // "2026-09-01_2026-09-30". null for the default, which keeps URLs clean.
  toParam() {
    if (this.custom) return `${this.custom.fromDay}_${this.custom.toDay}`;
    if (this.days === DEFAULT_DAYS) return null;
    return PRESETS.find((p) => p.days === this.days)?.param ?? null;
  }

  // Take the period from a ?period= value without notifying: the view that
  // reads it is about to mount. An unknown or invalid value is ignored.
  applyParam(value) {
    const preset = PRESETS.find((p) => p.param === value);
    if (preset) {
      this.days = preset.days;
      this.custom = null;
    } else {
      const m = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(value ?? "");
      if (!m || this.validate(m[1], m[2])) return;
      this.days = null;
      this.custom = { fromDay: m[1], toDay: m[2] };
    }
    this._range = this._compute();
  }

  // Short name of the period for the header: "30 days" or "Custom".
  name() {
    return this.custom ? "Custom" : PRESETS.find((p) => p.days === this.days)?.name ?? `${this.days} days`;
  }
}

// The one period every page reads, so switching pages keeps the chosen range.
export const globalRange = new DateRangeStore(DEFAULT_DAYS);
