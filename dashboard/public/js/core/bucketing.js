// Adaptive time-bucketing — shared by any time-series chart.
//
// Charts plot one point per time bucket. The bucket size adapts to the range so
// the point density stays readable: a 7-day window buckets by hour, longer
// windows by day. This module is the SINGLE SOURCE OF TRUTH for bucket size —
// any backend that GROUPs BY a bucket must use the same BUCKET_MS values, or the
// frontend pivot will drop rows whose bucket-start isn't in bucketEdges().
//
// Buckets are UTC-aligned (floor-divide the unix-ms timestamp by the bucket
// size), matching the convention in core/dateRange.js. Charts must render the
// axis with localtime:false so labels track the same UTC boundaries.

export const BUCKET_MS = { hour: 3600000, day: 86400000 };

// Anything spanning more than ~8 days buckets by day; shorter spans by hour.
// Pure function of (from, to): the provider relies on this so its cache key can
// stay `name|from|to` without also encoding the granularity.
const HOUR_MAX_SPAN_MS = 8 * BUCKET_MS.day;

export function pickGranularity({ from, to }) {
  return to - from <= HOUR_MAX_SPAN_MS ? "hour" : "day";
}

export function bucketMs(granularity) {
  return BUCKET_MS[granularity];
}

// Ordered bucket-start timestamps covering [from, to]. Starts at the bucket that
// contains `from` (so the first, partial bucket is included) and steps by the
// bucket size while the edge is still within range. Every `t` a GROUP BY can emit
// for ts in [from, to] lands on one of these edges, so the chart can zero-fill
// gaps and keep the x-axis ordered.
export function bucketEdges({ from, to }, granularity) {
  const ms = BUCKET_MS[granularity];
  const start = Math.floor(from / ms) * ms;
  const edges = [];
  for (let t = start; t <= to; t += ms) edges.push(t);
  return edges;
}

// Tick labels and tooltip titles are UTC, like the buckets.
const DAY_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const DATE_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const TIME_FMT = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

// Explicit x-axis ticks for a bucket timeline: at most about 10, on round
// steps (every 1, 2, 3, 6, 12 or 24 hours; every 1, 2, 3, 7, 14 or 30 days)
// aligned to UTC, so labels read "15:00" or "Oct 4" and never "17:25". Hourly
// ticks that fall on midnight show the date. Billboard's own `count` spreads
// ticks evenly in time instead, which lands between buckets.
export function xAxisTicks(edges, granularity) {
  const ms = BUCKET_MS[granularity];
  const steps = granularity === "hour" ? [1, 2, 3, 6, 12, 24, 48] : [1, 2, 3, 7, 14, 30];
  const step = steps.find((s) => edges.length / s <= 10) ?? steps[steps.length - 1];
  const values = edges.filter((t) => Math.floor(t / ms) % step === 0);
  const format =
    granularity === "hour"
      ? (d) => (new Date(d).getUTCHours() === 0 ? DAY_FMT.format(new Date(d)) : TIME_FMT.format(new Date(d)))
      : (d) => DAY_FMT.format(new Date(d));
  return { values, format, outer: false };
}

// Tooltip title for a bucket: the full date, plus the hour for hourly buckets.
export function tooltipTitle(granularity) {
  return granularity === "hour"
    ? (d) => `${DATE_FMT.format(new Date(d))}, ${TIME_FMT.format(new Date(d))} UTC`
    : (d) => DATE_FMT.format(new Date(d));
}
