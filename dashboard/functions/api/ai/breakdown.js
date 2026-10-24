// GET /api/ai/breakdown?from=&to=
// Two views of the period's AI traffic, from one scan of the window:
//   providers  per AI family (ChatGPT, Claude, Perplexity, Meta AI, other AI):
//              requests per purpose
//   sections   per site section (lib/sql.js SECTION_SQL): requests for each
//              AI purpose. The top sections by volume are listed; the rest
//              are summed into one row.
import { handle, json, parseRange } from "../../../lib/api.js";
import { SECTION_SQL } from "../../../lib/sql.js";
import { FAMILIES, familySql, purposeSql } from "../../../../shared/bots.js";

const TOP_SECTIONS = 8;

const AI_FAMILIES = ["chatgpt", "claude", "perplexity", "meta", "other"];

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);

  const { results } = await env.DB.prepare(
    `SELECT family, purpose, section, COUNT(*) AS c FROM (
       SELECT url, ${familySql("bot_name")} AS family, ${purposeSql("bot_name")} AS purpose, ${SECTION_SQL} AS section
         FROM crawls WHERE ts BETWEEN ?1 AND ?2)
      WHERE purpose IS NOT NULL
      GROUP BY family, purpose, section`
  )
    .bind(range.from, range.to)
    .all();
  const rows = results ?? [];

  // Providers: summed over sections.
  const providers = AI_FAMILIES.map((key) => ({
    key,
    label: key === "other" ? "Other AI" : FAMILIES.find((f) => f.key === key).label,
    user: 0,
    search: 0,
    training: 0,
  }));
  const byKey = Object.fromEntries(providers.map((p) => [p.key, p]));
  for (const r of rows) {
    if (r.purpose && byKey[r.family]) byKey[r.family][r.purpose] += r.c;
  }

  // Sections: requests per purpose.
  const sections = new Map();
  for (const r of rows) {
    const s = sections.get(r.section) ?? { section: r.section, training: 0, search: 0, user: 0 };
    s[r.purpose] += r.c;
    sections.set(r.section, s);
  }
  const list = [...sections.values()].sort((a, b) => b.training + b.search + b.user - (a.training + a.search + a.user));
  const top = list.slice(0, TOP_SECTIONS);
  const rest = list.slice(TOP_SECTIONS);
  if (rest.length) {
    top.push(
      rest.reduce(
        (acc, s) => ({
          section: `${rest.length} other sections`,
          training: acc.training + s.training,
          search: acc.search + s.search,
          user: acc.user + s.user,
        }),
        { training: 0, search: 0, user: 0 }
      )
    );
  }

  return json({ providers: providers.filter((p) => p.user + p.search + p.training > 0), sections: top });
});
