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

// d3/billboard time-format string for the x-axis ticks and tooltip. Hourly
// buckets need the time-of-day, otherwise every label collapses to the same day
// and the tooltip can't tell 02:00 from 20:00.
export function xTickFormat(granularity) {
  return granularity === "hour" ? "%b %d %H:%M" : "%b %d";
}
