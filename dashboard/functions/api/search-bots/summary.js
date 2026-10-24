// GET /api/search-bots/summary?from=&to=&group=googlebot|bingbot
// Log Analyzer > Googlebot and > Bingbot, Crawl Budget tab, after EdgeComet's
// Bot Insights: how much the engine's Search crawlers (lib/sql.js
// BOT_GROUP_SQL) fetched, for the period and the one before.
//   current, previous  { requests, urls, buckets: { [verdict]: requests } }:
//                      the stat cards and Indexability Status. A request counts
//                      under the verdict of the page it got (lib/sql.js
//                      PAGE_BUCKET_SQL)
//   variants           every crawler of the engine (lib/sql.js ENGINE_SQL) that
//                      either period saw, the most requests first: requests,
//                      distinct URLs, broken answers (4xx, 5xx or none) and the
//                      median response time, with the previous period's
//                      figures in `prev`. `search` marks the Search crawlers,
//                      the ones every other card counts
//   days               the period in days, for Pages per Day
// `previous` and every `prev` are null when recorded data does not reach back
// over the whole comparison window, as on the other cards.
import { handle, json, parseRange, enumParam, firstVisitTs, previousIsComplete } from "../../../lib/api.js";
import { BOT_GROUP_SQL, ENGINE_SQL, PAGE_BUCKET_SQL, PAGE_BUCKETS, timeRankSql, percentileSql } from "../../../lib/sql.js";
import { botInfo } from "../../../../shared/bots.js";

const searchSql = (group) => `SELECT
    COUNT(*)            AS requests,
    COUNT(DISTINCT url) AS urls,
    ${PAGE_BUCKETS.map((b) => `COUNT(CASE WHEN bucket = '${b.key}' THEN 1 END) AS b_${b.key}`).join(",\n    ")}
  FROM (SELECT url, ${PAGE_BUCKET_SQL} AS bucket FROM crawls WHERE ts BETWEEN ?1 AND ?2 AND ${BOT_GROUP_SQL[group]})`;

const variantsSql = (group) => `SELECT bot_name,
    COUNT(*)              AS requests,
    COUNT(DISTINCT url)   AS urls,
    SUM(CASE WHEN status IS NULL OR status >= 400 THEN 1 ELSE 0 END) AS broken,
    ${percentileSql(0.5)} AS median
  FROM (SELECT bot_name, url, status, response_time_ms, ${timeRankSql("bot_name")}
          FROM crawls WHERE ts BETWEEN ?1 AND ?2 AND ${ENGINE_SQL[group]})
 GROUP BY bot_name`;

const NONE = { requests: 0, urls: 0, broken: 0, median: null };
const stats = (r) => ({ requests: r.requests, urls: r.urls, broken: r.broken, median: r.median });

function totals(row) {
  return {
    requests: row?.requests ?? 0,
    urls: row?.urls ?? 0,
    buckets: Object.fromEntries(PAGE_BUCKETS.map((b) => [b.key, row?.[`b_${b.key}`] ?? 0])),
  };
}

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const group = enumParam(request, "group", Object.keys(ENGINE_SQL), "googlebot");
  const read = async (from, to) => {
    const search = await env.DB.prepare(searchSql(group)).bind(from, to).first();
    const { results } = await env.DB.prepare(variantsSql(group)).bind(from, to).all();
    return { search: totals(search), variants: new Map((results ?? []).map((r) => [r.bot_name, stats(r)])) };
  };

  const [now, first] = await Promise.all([read(range.from, range.to), firstVisitTs(env)]);
  const before = previousIsComplete(range, first) ? await read(range.prevFrom, range.prevTo) : null;

  // A crawler only the previous period saw is listed too, at zero.
  const names = new Set([...now.variants.keys(), ...(before ? before.variants.keys() : [])]);
  const variants = [...names]
    .map((name) => ({
      name,
      search: botInfo(name)?.family === group,
      ...(now.variants.get(name) ?? NONE),
      prev: before ? before.variants.get(name) ?? NONE : null,
    }))
    .sort((a, b) => b.requests - a.requests || (b.prev?.requests ?? 0) - (a.prev?.requests ?? 0) || a.name.localeCompare(b.name));

  return json({ current: now.search, previous: before?.search ?? null, variants, days: Math.max(1, range.days) });
});
