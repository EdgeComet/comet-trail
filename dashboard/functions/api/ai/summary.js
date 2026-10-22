// GET /api/ai/summary?from=&to=
// The four AI Bots stat cards, for the period and the one before:
//   ai_user    requests from AI assistants fetching a page live for a person
//   ai_total   requests from every AI bot (user fetches, AI search, training)
//   total      requests from every bot, for the AI share of crawl
//   ai_urls    distinct URLs AI bots fetched; all_urls distinct URLs overall
//   ai_404     AI user fetches answered 404, and how many URLs they hit
import { handle, json, parseRange, firstVisitTs, previousIsComplete } from "../../../lib/api.js";
import { botNamesSql, isAiBot } from "../../../../shared/bots.js";

const AI = botNamesSql(isAiBot);
const AI_USER = botNamesSql((b) => b.purpose === "user");

const SQL = `SELECT
    SUM(CASE WHEN bot_name IN ${AI_USER} THEN 1 ELSE 0 END) AS ai_user,
    SUM(CASE WHEN bot_name IN ${AI} THEN 1 ELSE 0 END) AS ai_total,
    COUNT(*) AS total,
    COUNT(DISTINCT CASE WHEN bot_name IN ${AI} THEN url END) AS ai_urls,
    COUNT(DISTINCT url) AS all_urls,
    SUM(CASE WHEN bot_name IN ${AI_USER} AND status = 404 THEN 1 ELSE 0 END) AS ai_404,
    COUNT(DISTINCT CASE WHEN bot_name IN ${AI_USER} AND status = 404 THEN url END) AS ai_404_urls
  FROM crawls
  WHERE ts BETWEEN ?1 AND ?2`;

const clean = (r) => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, v ?? 0]));

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const current = clean(await env.DB.prepare(SQL).bind(range.from, range.to).first());
  const previous = previousIsComplete(range, await firstVisitTs(env))
    ? clean(await env.DB.prepare(SQL).bind(range.prevFrom, range.prevTo).first())
    : null;
  return json({ current, previous });
});
