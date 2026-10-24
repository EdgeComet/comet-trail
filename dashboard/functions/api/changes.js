// GET /api/changes?from=<unix_ms>&to=<unix_ms>
// Every change bots saw on the site in the period, found by comparing each
// visit with the visit before it to the same URL (the rules of lib/history.js,
// applied in SQL with LAG):
//   - content fields are compared between 200 visits only,
//   - the status code between visits that got a settled answer (server errors,
//     429 rate limits and unreachable origins are incidents, not changes).
// A page's first visit in the period is compared with its last visit in the
// CHANGE_LOOKBACK_MS before the period; a page bots had not fetched for longer than that
// has nothing to compare with, so its first visit reports no change. That one
// visit per page comes through idx_crawls_url_ts, a few rows each, so the
// lookback costs about as many reads as the site has pages, not a scan of 30
// more days of visits (README, "Cloudflare free plan limits").
//
// Returns:
//   totals     changes, pages changed, per-field counts
//   series     per-day counts by field, for the chart
//   events     the biggest (day, field) groups of each field: one field
//              changed on many pages the same day, usually a release or a CMS
//              change. Its tone says what most of its changes did: "bad" cost
//              the pages their indexability or their 2xx, "good" gave it back,
//              "neutral" neither. The Changes page lists the biggest of all
//              fields; the change markers on the Overview, Indexation and
//              Status Codes charts pick the biggest of the fields they mark
//              (public/js/core/changeMarkers.js)
//   recent     the newest 300 changes, for the change log
import { handle, json, parseRange } from "../../lib/api.js";
import { FIELDS, sentiment } from "../../lib/history.js";
import { SETTLED_SQL, CHANGE_LOOKBACK_MS } from "../../lib/sql.js";

const DAY_MS = 86400000;
const RECENT = 300;

const COLS = FIELDS.map((f) => f.key).concat(["meta_googlebot"]);
const uniqueCols = [...new Set(COLS)];

// The visit's state as one JSON array: its verdict (index_status, for the
// tone of a change) and the compared columns. One LAG of the array, not one
// per column: D1 counts a read of every row in the window for each LAG, so a
// LAG per column reads the rows once per column. Two arrays differ when any of
// their values does (NULLs alike, as with IS NOT). A row whose verdict alone
// differs reports nothing: the loop below compares the fields one by one.
const STATE = `json_array(index_status, ${uniqueCols.join(", ")})`;

// LAG compares the visits inside the period (?1 to ?2). A page's first visit
// there has no LAG; its previous visit is the newest one of the lookback (?3
// up to ?1), read through idx_crawls_url_ts. COALESCE runs that lookup only
// when LAG is NULL, once a page.
const CONTENT_SQL = `
  WITH v AS (
    SELECT url, ts, bot_name, index_status, ${uniqueCols.join(", ")},
           COALESCE(LAG(${STATE}) OVER w, (
             SELECT ${STATE} FROM crawls p
              WHERE p.url = c.url AND p.ts >= ?3 AND p.ts < ?1 AND p.status = 200
              ORDER BY p.ts DESC LIMIT 1
           )) AS prev
      FROM crawls c
     WHERE status = 200 AND ts BETWEEN ?1 AND ?2
    WINDOW w AS (PARTITION BY url ORDER BY ts)
  )
  SELECT * FROM v WHERE prev IS NOT NULL AND ${STATE} IS NOT prev`;

// A settled status is never NULL, so a NULL p_status means no visit before.
const STATUS_SQL = `
  WITH s AS (
    SELECT url, ts, bot_name, status,
           COALESCE(LAG(status) OVER w, (
             SELECT p.status FROM crawls p
              WHERE p.url = c.url AND p.ts >= ?3 AND p.ts < ?1 AND ${SETTLED_SQL}
              ORDER BY p.ts DESC LIMIT 1
           )) AS p_status
      FROM crawls c
     WHERE ts BETWEEN ?1 AND ?2 AND ${SETTLED_SQL}
    WINDOW w AS (PARTITION BY url ORDER BY ts)
  )
  SELECT url, ts, bot_name, p_status, status FROM s
   WHERE p_status IS NOT NULL AND status IS NOT p_status`;

// The fields that decide the verdict of a 200 page (shared/seo.js).
const VERDICT_FIELDS = new Set(["meta_robots", "canonical"]);

// Rebuild the previous visit from its state array, so FIELDS can read it.
function previousRow(r) {
  const [indexStatus, ...values] = JSON.parse(r.prev);
  return { index_status: indexStatus, ...Object.fromEntries(uniqueCols.map((c, i) => [c, values[i]])) };
}

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const binds = [range.from, range.to, range.from - CHANGE_LOOKBACK_MS];

  const [content, status] = await Promise.all([
    env.DB.prepare(CONTENT_SQL).bind(...binds).all(),
    env.DB.prepare(STATUS_SQL).bind(...binds).all(),
  ]);

  // Each change carries its tone (lib/history.js sentiment): a new robots tag
  // or canonical takes the verdict move of its visit, a status code its move
  // to or from a 2xx. Other fields do not decide the verdict: neutral.
  const changes = [];
  for (const r of content.results ?? []) {
    const prev = previousRow(r);
    const verdict = r.index_status === prev.index_status ? "neutral" : sentiment("bucket", prev.index_status, r.index_status);
    for (const f of FIELDS) {
      const before = f.read(prev);
      const after = f.read(r);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        const tone = VERDICT_FIELDS.has(f.key) ? verdict : "neutral";
        changes.push({ ts: r.ts, url: r.url, bot_name: r.bot_name, field: f.key, label: f.label, list: Boolean(f.list), before, after, tone });
      }
    }
  }
  for (const r of status.results ?? []) {
    const tone = sentiment("status", r.p_status, r.status);
    changes.push({ ts: r.ts, url: r.url, bot_name: r.bot_name, field: "status", label: "Status code", list: false, before: r.p_status, after: r.status, tone });
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
// Kept per field, not overall: a chart marks the 4 biggest events of its own
// fields, so ten small status code changes still show on the Status Codes
// chart when bigger title and canonical events fill an overall top list. The
// Changes page lists the 8 biggest of all fields, and those are among the 8
// biggest of their field too.
const EVENTS_PER_FIELD = 8;

// The tone most of an event's changes have; neutral when none has a majority.
function majority(tones) {
  const n = tones.bad + tones.good + tones.neutral;
  return tones.bad * 2 > n ? "bad" : tones.good * 2 > n ? "good" : "neutral";
}

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
      if (!run) {
        run = { start: c.ts, end: c.ts, field: c.field, label: c.label, list: c.list, kind: c.kindText, example: c, urls: new Set(), tones: { bad: 0, good: 0, neutral: 0 } };
      }
      run.end = c.ts;
      run.urls.add(c.url);
      run.tones[c.tone] += 1;
    }
    if (run) events.push(run);
  }

  const kept = new Map();
  return events
    .filter((e) => e.urls.size >= MIN_EVENT_PAGES)
    .sort((a, b) => b.urls.size - a.urls.size)
    .filter((e) => {
      kept.set(e.field, (kept.get(e.field) ?? 0) + 1);
      return kept.get(e.field) <= EVENTS_PER_FIELD;
    })
    .sort((a, b) => b.start - a.start)
    .map((e) => ({
      start: e.start,
      end: e.end,
      field: e.field,
      label: e.label,
      list: e.list,
      kind: e.kind,
      tone: majority(e.tones),
      pages: e.urls.size,
      example: { url: e.example.url, before: e.example.before, after: e.example.after },
      sample: [...e.urls].slice(0, 6),
    }));
}
