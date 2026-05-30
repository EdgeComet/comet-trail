// GET /api/bot-activity?from=<unix_ms>&to=<unix_ms>&bucket=hour|day
// Feeds the frontend BotActivityProvider. Buckets crawls by time and normalizes
// the raw bot_name into the six chart series, returning one row per
// (bucket, series) with a count. Gap-filling and column assembly happen on the
// frontend (see charts/botActivityChart.js), so empty buckets are simply absent
// here. Reads the same D1 database the tracking worker writes to (binding: DB).
//
// Bucket size is inlined as an integer literal (not a bound ?-param): binding a
// JS number can bind as REAL, which turns SQLite's integer division into float
// division and corrupts the bucket keys. The value comes from a closed
// {hour, day} set, so there is no injection surface. It must match BUCKET_MS in
// public/js/core/bucketing.js.
const BUCKET_MS = { hour: 3600000, day: 86400000 };

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const rawFrom = url.searchParams.get("from");
  const rawTo = url.searchParams.get("to");
  const bucket = url.searchParams.get("bucket");
  const from = Number(rawFrom);
  const to = Number(rawTo);

  // Reject absent/blank params too — Number(null) and Number("") are 0 (finite).
  if (rawFrom === null || rawTo === null || rawFrom === "" || rawTo === "" ||
      !Number.isFinite(from) || !Number.isFinite(to)) {
    return Response.json({ error: "from/to required (unix ms)" }, { status: 400 });
  }
  if (!Object.prototype.hasOwnProperty.call(BUCKET_MS, bucket)) {
    return Response.json({ error: "bucket must be 'hour' or 'day'" }, { status: 400 });
  }

  const ms = BUCKET_MS[bucket]; // safe integer literal, interpolated below

  const { results } = await env.DB.prepare(
    `SELECT (ts / ${ms}) * ${ms} AS t,
            CASE
              WHEN bot_name IN ('Googlebot', 'Googlebot-Smartphone') THEN 'Googlebot'
              WHEN bot_name = 'Bingbot'       THEN 'Bingbot'
              WHEN bot_name = 'GPTBot'        THEN 'GPTBot'
              WHEN bot_name = 'ClaudeBot'     THEN 'ClaudeBot'
              WHEN bot_name = 'PerplexityBot' THEN 'Perplexity'
              ELSE 'Other'
            END                                AS series,
            COUNT(*)                           AS c
       FROM crawls
      WHERE ts BETWEEN ?1 AND ?2
      GROUP BY t, series
      ORDER BY t`
  )
    .bind(from, to)
    .all();

  return Response.json({ granularity: bucket, rows: results ?? [] });
}
