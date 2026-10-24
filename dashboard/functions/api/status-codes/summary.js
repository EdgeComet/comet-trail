// GET /api/status-codes/summary?from=&to=&group=all|googlebot|ai
// Log Analyzer > Status Codes: what the selected bots got back, per exact
// status code, per status class (lib/sql.js STATUS_CLASSES) and per site
// section (lib/sql.js SECTION_SQL), for the period and the one before:
//   current, previous  { requests, classes: { [class]: { requests, urls } },
//                      gone: { requests, urls } }: the stat cards. `gone` are
//                      the 404 and 410 answers and the URLs that got one
//   codes              [{ status, requests, urls, prev }] for every code either
//                      period saw, the Breakdown table. status null is "no
//                      response"; prev is null without a fair comparison
//   sections           the busiest sections with their requests per class;
//                      `other` sums the rest
// `previous` is null when recorded data does not reach back over the whole
// comparison window, as on the other cards.
//
// One read per period. The inner query counts each URL's requests per status
// code and flags, per URL, the first row of each status class and of the
// 404/410 pair, so the outer sums give distinct URLs per class without a
// second read; a URL sits in exactly one section, so the sums add up across
// sections too.
import { handle, json, parseRange, enumParam, firstVisitTs, previousIsComplete } from "../../../lib/api.js";
import { BOT_GROUP_SQL, SECTION_SQL, STATUS_CLASS_SQL, STATUS_CLASSES } from "../../../lib/sql.js";

const TOP_SECTIONS = 10;
const GONE = "status IN (404, 410)";

const sql = (group) => `
  SELECT ${SECTION_SQL} AS section, status, ${STATUS_CLASS_SQL} AS class,
         SUM(c) AS requests, COUNT(*) AS urls, SUM(first_in_class) AS class_urls, SUM(first_gone) AS gone_urls
    FROM (
      SELECT url, status, COUNT(*) AS c,
             ROW_NUMBER() OVER (PARTITION BY url, ${STATUS_CLASS_SQL} ORDER BY status) = 1 AS first_in_class,
             CASE WHEN ${GONE} THEN ROW_NUMBER() OVER (PARTITION BY url, ${GONE} ORDER BY status) = 1 ELSE 0 END AS first_gone
        FROM crawls
       WHERE ts BETWEEN ?1 AND ?2 AND ${BOT_GROUP_SQL[group]}
       GROUP BY url, status)
   GROUP BY section, status`;

// The stat card figures and per-code counts of one period's rows.
function totals(rows) {
  const classes = Object.fromEntries(STATUS_CLASSES.map((c) => [c.key, { requests: 0, urls: 0 }]));
  const codes = new Map();
  const gone = { requests: 0, urls: 0 };
  let requests = 0;
  for (const r of rows) {
    requests += r.requests;
    classes[r.class].requests += r.requests;
    classes[r.class].urls += r.class_urls;
    const code = codes.get(r.status) ?? { status: r.status, requests: 0, urls: 0 };
    code.requests += r.requests;
    code.urls += r.urls;
    codes.set(r.status, code);
    if (r.status === 404 || r.status === 410) {
      gone.requests += r.requests;
      gone.urls += r.gone_urls;
    }
  }
  return { summary: { requests, classes, gone }, codes };
}

function sections(rows) {
  const bySection = new Map();
  for (const r of rows) {
    const s = bySection.get(r.section) ?? { section: r.section, requests: 0, ...Object.fromEntries(STATUS_CLASSES.map((c) => [c.key, 0])) };
    s.requests += r.requests;
    s[r.class] += r.requests;
    bySection.set(r.section, s);
  }
  const list = [...bySection.values()].sort((a, b) => b.requests - a.requests || a.section.localeCompare(b.section));
  const rest = list.slice(TOP_SECTIONS);
  const other = rest.length
    ? rest.reduce(
        (acc, s) => {
          for (const k of ["requests", ...STATUS_CLASSES.map((c) => c.key)]) acc[k] += s[k];
          return acc;
        },
        { sections: rest.length, requests: 0, ...Object.fromEntries(STATUS_CLASSES.map((c) => [c.key, 0])) }
      )
    : null;
  return { rows: list.slice(0, TOP_SECTIONS), other };
}

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const group = enumParam(request, "group", Object.keys(BOT_GROUP_SQL), "all");
  const SQL = sql(group);

  const [{ results }, first] = await Promise.all([env.DB.prepare(SQL).bind(range.from, range.to).all(), firstVisitTs(env)]);
  const now = totals(results ?? []);
  let before = null;
  if (previousIsComplete(range, first)) {
    const prev = await env.DB.prepare(SQL).bind(range.prevFrom, range.prevTo).all();
    before = totals(prev.results ?? []);
  }

  // Every code either period saw, in code order, "no response" last.
  const keys = new Set([...now.codes.keys(), ...(before ? before.codes.keys() : [])]);
  const codes = [...keys]
    .sort((a, b) => (a === null) - (b === null) || a - b)
    .map((status) => ({
      ...(now.codes.get(status) ?? { status, requests: 0, urls: 0 }),
      prev: before ? before.codes.get(status)?.requests ?? 0 : null,
    }));

  return json({
    current: now.summary,
    previous: before?.summary ?? null,
    codes,
    sections: sections(results ?? []),
  });
});
