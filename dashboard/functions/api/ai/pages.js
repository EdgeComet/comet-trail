// GET /api/ai/pages?from=&to=
// The pages AI assistants opened for people in the period (AI user fetches):
//   top      the most fetched pages, with fetches per assistant family, the
//            newest status and title
//   missing  pages the assistants tried to open and got a 404: an answer that
//            pointed someone at a page that no longer exists
import { handle, json, parseRange } from "../../../lib/api.js";
import { botNamesSql, familySql } from "../../../../shared/bots.js";

const AI_USER = botNamesSql((b) => b.purpose === "user");
const LIMIT = 10;

const BASE = `
  WITH f AS (
    SELECT url, ts, status, title, ${familySql("bot_name")} AS family,
           ROW_NUMBER() OVER (PARTITION BY url ORDER BY ts DESC) AS rn
      FROM crawls
     WHERE ts BETWEEN ?1 AND ?2 AND bot_name IN ${AI_USER}
  )`;

const PER_FAMILY = `
  SUM(CASE WHEN family = 'chatgpt' THEN 1 ELSE 0 END) AS chatgpt,
  SUM(CASE WHEN family = 'claude' THEN 1 ELSE 0 END) AS claude,
  SUM(CASE WHEN family = 'perplexity' THEN 1 ELSE 0 END) AS perplexity,
  SUM(CASE WHEN family NOT IN ('chatgpt', 'claude', 'perplexity') THEN 1 ELSE 0 END) AS other`;

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);

  const top = await env.DB.prepare(
    `${BASE}
     SELECT url, COUNT(*) AS fetches, ${PER_FAMILY}, MAX(ts) AS last_ts,
            MAX(CASE WHEN rn = 1 THEN status END) AS status,
            MAX(CASE WHEN rn = 1 THEN title END) AS title
       FROM f GROUP BY url
      ORDER BY fetches DESC, url
      LIMIT ${LIMIT}`
  )
    .bind(range.from, range.to)
    .all();

  const missing = await env.DB.prepare(
    `${BASE}
     SELECT url, COUNT(*) AS fetches, ${PER_FAMILY}, MAX(ts) AS last_ts
       FROM f WHERE status = 404
      GROUP BY url
      ORDER BY fetches DESC, url
      LIMIT ${LIMIT}`
  )
    .bind(range.from, range.to)
    .all();

  return json({ top: top.results ?? [], missing: missing.results ?? [] });
});
