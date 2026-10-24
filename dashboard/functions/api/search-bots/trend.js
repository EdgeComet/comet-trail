// GET /api/search-bots/trend?from=&to=&group=googlebot|bingbot&bucket=hour|day
// The Crawl Budget chart of Log Analyzer > Googlebot and > Bingbot: the
// requests the engine's Search crawlers made per bucket, and how many distinct
// pages they fetched in it. A page fetched twice in one bucket is one page and
// two requests, so the gap between the lines is the recrawl.
// Bucket size is inlined as an integer literal for the reason given in
// api/bot-activity.js.
import { handle, json, parseRange, enumParam } from "../../../lib/api.js";
import { BOT_GROUP_SQL, ENGINE_SQL } from "../../../lib/sql.js";

const BUCKET_MS = { hour: 3600000, day: 86400000 };

const SERIES = [
  { key: "requests", label: "Requests" },
  { key: "pages", label: "Unique pages" },
];

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const group = enumParam(request, "group", Object.keys(ENGINE_SQL), "googlebot");
  const bucket = enumParam(request, "bucket", ["hour", "day"], "day");
  const ms = BUCKET_MS[bucket];

  const { results } = await env.DB.prepare(
    `SELECT (ts / ${ms}) * ${ms} AS t, COUNT(*) AS requests, COUNT(DISTINCT url) AS pages
       FROM crawls
      WHERE ts BETWEEN ?1 AND ?2 AND ${BOT_GROUP_SQL[group]}
      GROUP BY t
      ORDER BY t`
  )
    .bind(range.from, range.to)
    .all();

  const rows = (results ?? []).flatMap((r) => [
    { t: r.t, series: "requests", c: r.requests },
    { t: r.t, series: "pages", c: r.pages },
  ]);
  return json({ granularity: bucket, series: SERIES, rows });
});
