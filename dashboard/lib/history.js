// Turns one URL's visit rows into its history: the versions of the page bots
// received and the field-level changes between them. Used by /api/page (one
// URL, in JS) - the site-wide feed in /api/changes applies the same rules in SQL.
//
// Rules, close to EdgeComet's Page Analysis:
//   - The status code is compared between visits that got a settled answer.
//     A server error, a 429 rate limit or an unreachable origin is an incident,
//     not a change to the page: it shows in the visit log, not as a version.
//   - Content fields (title, canonical, robots, headings, ...) and the
//     indexability verdict are compared between 200 visits only, so tags that
//     vanish with an error page are not reported as changed.
//   - A change is dated by the first visit that showed the new value.
import { parseJsonList } from "./api.js";

const list = (v) => parseJsonList(v);
const joinList = (arr) => (arr.length ? arr.join(", ") : null);

export const FIELDS = [
  { key: "title", label: "Title", read: (r) => r.title || null },
  { key: "meta_description", label: "Meta description", read: (r) => r.meta_description || null },
  { key: "canonical", label: "Canonical", read: (r) => r.canonical || null },
  {
    key: "meta_robots",
    label: "Meta robots",
    read: (r) => joinList([...list(r.meta_robots), ...list(r.meta_googlebot).map((d) => `googlebot: ${d}`)]),
  },
  { key: "h1", label: "H1", list: true, read: (r) => list(r.h1) },
  { key: "h2", label: "H2", list: true, read: (r) => list(r.h2) },
  {
    key: "hreflangs",
    label: "Hreflang",
    list: true,
    read: (r) => list(r.hreflangs).map((x) => `${x.lang}: ${x.href}`),
  },
  { key: "structured_data_types", label: "Structured data", list: true, read: (r) => list(r.structured_data_types) },
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Statuses that tell what the site serves (2xx, 3xx, 4xx except 429), as
// opposed to a passing incident.
// lib/sql.js SETTLED_SQL is the same rule in SQL.
export const isStableStatus = (s) => s !== null && s !== undefined && s !== 429 && s < 500;

// Sentiment of a change, for coloring markers: losing indexability or a 2xx is
// bad, regaining it is good, anything else is neutral.
function sentiment(field, before, after) {
  if (field === "bucket") return after === "indexable" ? "good" : before === "indexable" ? "bad" : "neutral";
  if (field === "status") {
    const ok = (s) => s !== null && s >= 200 && s < 300;
    return ok(after) && !ok(before) ? "good" : ok(before) && !ok(after) ? "bad" : "neutral";
  }
  return "neutral";
}

// rows: ascending by ts, each with status, bucket and the raw content columns.
// Returns { versions, changes, state } where `state` is the newest version:
// { status, bucket, fields } with `fields` taken from the newest 200 visit.
export function buildHistory(rows) {
  const versions = [];
  const changes = [];
  let state = null;
  let last200 = null; // { bucket, fields } of the newest 200 visit so far

  for (const r of rows) {
    if (!isStableStatus(r.status)) continue; // an incident, not a version
    const fields = r.status === 200 ? Object.fromEntries(FIELDS.map((f) => [f.key, f.read(r)])) : null;
    const delta = [];

    if (state && r.status !== state.status) {
      delta.push({ field: "status", label: "Status code", before: state.status, after: r.status });
    }
    if (fields && last200) {
      // The verdict among 200 pages (noindex, canonical). A move to or from an
      // error is already told by the status change.
      if (r.bucket !== last200.bucket) {
        delta.push({ field: "bucket", label: "Indexability", before: last200.bucket, after: r.bucket });
      }
      for (const f of FIELDS) {
        if (!same(last200.fields[f.key], fields[f.key])) {
          delta.push({ field: f.key, label: f.label, list: Boolean(f.list), before: last200.fields[f.key], after: fields[f.key] });
        }
      }
    }
    if (fields) last200 = { bucket: r.bucket, fields };

    state = { status: r.status, bucket: r.bucket, fields: last200?.fields ?? null };

    if (!versions.length || delta.length) {
      for (const d of delta) {
        d.ts = r.ts;
        d.bot_name = r.bot_name;
        d.sentiment = sentiment(d.field, d.before, d.after);
        changes.push(d);
      }
      versions.push({ n: versions.length + 1, ts: r.ts, bot_name: r.bot_name, changes: delta, state });
    }
  }

  // Only incidents on record (the origin never answered properly): one version
  // that shows the newest of them.
  if (!versions.length && rows.length) {
    const newest = rows[rows.length - 1];
    state = { status: newest.status, bucket: newest.bucket, fields: null };
    versions.push({ n: 1, ts: rows[0].ts, bot_name: rows[0].bot_name, changes: [], state });
  }

  return { versions, changes, state };
}

// Which version was live at time `ts`: the newest one that started at or before
// it. Only meaningful for a settled visit; an incident got no version.
export function versionAt(versions, ts) {
  let n = 1;
  for (const v of versions) {
    if (v.ts <= ts) n = v.n;
    else break;
  }
  return n;
}
