// GET /api/changes?from=<unix_ms>&to=<unix_ms>
// Every change bots saw on the site in the period, found by comparing each
// visit with the visit before it to the same URL (the rules of lib/history.js,
// applied in SQL with LAG):
//   - content fields are compared between 200 visits only,
//   - the status code between visits that got a settled answer (server errors,
//     429 rate limits and unreachable origins are incidents, not changes).
// A page's first visit in the period is compared with its last visit in the
// CHANGE_LOOKBACK_MS before the period; a page bots had not fetched for longer than that
// has nothing to compare with, so its first visit reports no change.
//
// Returns:
//   totals     changes, pages changed, per-field counts
//   series     per-day counts by field, for the chart
//   events     the biggest (day, field) groups: one field changed on many
//              pages the same day, usually a release or a CMS change
//   recent     the newest 300 changes, for the change log
import { handle, json, parseRange } from "../../lib/api.js";
import { FIELDS } from "../../lib/history.js";
import { SETTLED_SQL, CHANGE_LOOKBACK_MS } from "../../lib/sql.js";

const DAY_MS = 86400000;
const RECENT = 300;

const COLS = FIELDS.map((f) => f.key).concat(["meta_googlebot"]);
const uniqueCols = [...new Set(COLS)];
const LAGS = uniqueCols.map((c) => `LAG(${c}) OVER w AS p_${c}`).join(",\n         ");
const DIFFERS = uniqueCols.map((c) => `${c} IS NOT p_${c}`).join(" OR ");

const CONTENT_SQL = `
  WITH v AS (
    SELECT url, ts, bot_name, ${uniqueCols.join(", ")},
           LAG(ts) OVER w AS p_ts,
           ${LAGS}
      FROM crawls
     WHERE status = 200 AND ts BETWEEN ?1 AND ?2
    WINDOW w AS (PARTITION BY url ORDER BY ts)
  )
  SELECT * FROM v WHERE ts >= ?3 AND p_ts IS NOT NULL AND (${DIFFERS})`;

const STATUS_SQL = `
  WITH s AS (
    SELECT url, ts, bot_name, status,
           LAG(status) OVER w AS p_status,
           LAG(ts) OVER w AS p_ts
      FROM crawls
     WHERE ts BETWEEN ?1 AND ?2 AND ${SETTLED_SQL}
    WINDOW w AS (PARTITION BY url ORDER BY ts)
  )
  SELECT url, ts, bot_name, p_status, status FROM s
   WHERE ts >= ?3 AND p_ts IS NOT NULL AND status IS NOT p_status`;

// Rebuild the "previous visit" row from the p_ columns, so FIELDS can read it.
const previousRow = (r) => Object.fromEntries(uniqueCols.map((c) => [c, r[`p_${c}`]]));

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const binds = [range.from - CHANGE_LOOKBACK_MS, range.to, range.from];

  const [content, status] = await Promise.all([
    env.DB.prepare(CONTENT_SQL).bind(...binds).all(),
    env.DB.prepare(STATUS_SQL).bind(...binds).all(),
  ]);

  const changes = [];
  for (const r of content.results ?? []) {
    const prev = previousRow(r);
    for (const f of FIELDS) {
      const before = f.read(prev);
      const after = f.read(r);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push({ ts: r.ts, url: r.url, bot_name: r.bot_name, field: f.key, label: f.label, list: Boolean(f.list), before, after });
      }
    }
  }
  for (const r of status.results ?? []) {
    changes.push({ ts: r.ts, url: r.url, bot_name: r.bot_name, field: "status", label: "Status code", list: false, before: r.p_status, after: r.status });
  }
  changes.sort((a, b) => b.ts - a.ts);

  // Per-day counts by field, for the chart.
  const perDay = new Map();
  const byField = {};
  const pages = new Set();
  for (const c of changes) {
    const k = `${Math.floor(c.ts / DAY_MS) * DAY_MS}|${c.field}`;
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
    byField[c.field] = (byField[c.field] ?? 0) + 1;
    pages.add(c.url);
  }

  return json({
    totals: { changes: changes.length, pages: pages.size, by_field: byField },
    series: {
      granularity: "day",
      series: [{ key: "status", label: "Status code" }, ...FIELDS.map((f) => ({ key: f.key, label: f.label }))],
      rows: [...perDay].map(([k, c]) => {
        const [t, field] = k.split("|");
        return { t: Number(t), series: field, c };
      }),
    },
    events: changeEvents(changes),
    recent: changes.slice(0, RECENT),
  });
});

// What kind of change this is, so changes of one kind group into one event.
// Canonicals are told by direction (each page's own URL differs), status and
// robots by their exact values, everything else simply as "changed".
function kindOf(c) {
  if (c.field === "canonical") {
    const away = c.before === c.url && c.after !== c.url;
    const back = c.before !== c.url && c.after === c.url;
    if (away) return { key: "away", text: "now points to another URL" };
    if (back) return { key: "back", text: "points to the page itself again" };
    return { key: "other", text: "changed target" };
  }
  if (c.field === "status" || c.field === "meta_robots") return { key: JSON.stringify([c.before, c.after]), text: null };
  return { key: "changed", text: null };
}

// Releases show up as one field changing on many pages within a few days, as
// bots revisit them one by one. Changes of the same field and kind whose days
// are at most EVENT_GAP_DAYS apart form one event; the biggest events win.
const EVENT_GAP_DAYS = 2;
const MIN_EVENT_PAGES = 3;

function changeEvents(changes) {
  const byKind = new Map();
  for (const c of [...changes].reverse()) {
    const kind = kindOf(c);
    const key = `${c.field}|${kind.key}`;
    if (!byKind.has(key)) byKind.set(key, []);
    byKind.get(key).push({ ...c, kindText: kind.text });
  }

  const events = [];
  for (const list of byKind.values()) {
    let run = null;
    for (const c of list) {
      if (run && c.ts - run.end > EVENT_GAP_DAYS * DAY_MS) {
        events.push(run);
        run = null;
      }
      if (!run) run = { start: c.ts, end: c.ts, field: c.field, label: c.label, list: c.list, kind: c.kindText, example: c, urls: new Set() };
      run.end = c.ts;
      run.urls.add(c.url);
    }
    if (run) events.push(run);
  }

  return events
    .filter((e) => e.urls.size >= MIN_EVENT_PAGES)
    .sort((a, b) => b.urls.size - a.urls.size)
    .slice(0, 8)
    .sort((a, b) => b.start - a.start)
    .map((e) => ({
      start: e.start,
      end: e.end,
      field: e.field,
      label: e.label,
      list: e.list,
      kind: e.kind,
      pages: e.urls.size,
      example: { url: e.example.url, before: e.example.before, after: e.example.after },
      sample: [...e.urls].slice(0, 6),
    }));
}
