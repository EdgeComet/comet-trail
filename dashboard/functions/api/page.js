// GET /api/page?url=<page url>&from=<unix_ms>&to=<unix_ms>&bucket=hour|day
// Everything recorded about one URL - the time machine:
//   versions        every version of the page bots received, oldest first, with
//                   the fields that changed in it (lib/history.js)
//   changes         the same changes as a flat list
//   state           the newest version
//   last_by_family  the newest visit per bot family, and which version it saw
//   recent          the newest visits, each tagged with the version it saw
//   period          visit counts for the selected period, plus a time series
// History is built from the newest MAX_ROWS visits (`truncated` says when there
// are more); the period's counts and chart come from their own query, so they
// are exact whatever the cap. Every query reads one URL through idx_crawls_url_ts.
import { handle, json, parseRange, enumParam, HttpError } from "../../lib/api.js";
import { PAGE_BUCKET_SQL } from "../../lib/sql.js";
import { buildHistory, versionAt, isStableStatus, FIELDS } from "../../lib/history.js";
import { FAMILIES, familySql, purposeSql } from "../../../shared/bots.js";

const MAX_ROWS = 5000;
const BUCKET_MS = { hour: 3600000, day: 86400000 };

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const bucket = enumParam(request, "bucket", ["hour", "day"], "day");
  const url = new URL(request.url).searchParams.get("url");
  if (!url) throw new HttpError(400, "url required");

  const { results } = await env.DB.prepare(
    `SELECT ts, bot_name, ${familySql("bot_name")} AS family, ${purposeSql("bot_name")} AS purpose,
            status, response_time_ms, title, meta_description, canonical, hreflangs, h1, h2,
            meta_robots, meta_googlebot, structured_data_types, ${PAGE_BUCKET_SQL} AS bucket
       FROM crawls
      WHERE url = ?1
      ORDER BY ts DESC
      LIMIT ${MAX_ROWS}`
  )
    .bind(url)
    .all();

  const rows = (results ?? []).reverse();
  if (!rows.length) return json({ url, found: false });

  const { versions, changes, state } = buildHistory(rows);
  const versionOf = (r) => (isStableStatus(r.status) ? versionAt(versions, r.ts) : null);

  // Per family: the newest visit, and the newest settled one, which is the
  // version of the page that bot holds. A 503 on its last fetch does not
  // replace the page it already has.
  const newest = new Map();
  const settled = new Map();
  for (const r of rows) {
    newest.set(r.family, r);
    if (isStableStatus(r.status)) settled.set(r.family, r);
  }
  const last_by_family = FAMILIES.filter((f) => newest.has(f.key)).map((f) => {
    const r = newest.get(f.key);
    const s = settled.get(f.key) ?? null;
    return {
      family: f.key,
      label: f.label,
      bot_name: r.bot_name,
      ts: r.ts,
      status: r.status,
      bucket: r.bucket,
      version: s ? versionAt(versions, s.ts) : null,
      settled_ts: s?.ts ?? null,
      settled_bot: s?.bot_name ?? null,
    };
  });

  const recent = rows
    .slice(-25)
    .reverse()
    .map((r) => ({
      ts: r.ts,
      bot_name: r.bot_name,
      family: r.family,
      status: r.status,
      response_time_ms: r.response_time_ms,
      bucket: r.bucket,
      version: versionOf(r),
    }));

  const totals = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(ts) AS first FROM crawls WHERE url = ?1")
    .bind(url)
    .first();

  // Visits in the selected period, per family and per time bucket.
  const ms = BUCKET_MS[bucket];
  const period = await env.DB.prepare(
    `SELECT (ts / ${ms}) * ${ms} AS t, ${familySql("bot_name")} AS family, ${purposeSql("bot_name")} AS purpose, COUNT(*) AS c
       FROM crawls
      WHERE url = ?1 AND ts BETWEEN ?2 AND ?3
      GROUP BY t, family, purpose`
  )
    .bind(url, range.from, range.to)
    .all();
  const series = new Map();
  let visits = 0;
  let googlebot = 0;
  let aiUser = 0;
  let aiAll = 0;
  for (const r of period.results ?? []) {
    visits += r.c;
    if (r.family === "googlebot") googlebot += r.c;
    if (r.purpose) aiAll += r.c;
    if (r.purpose === "user") aiUser += r.c;
    const key = `${r.t}|${r.family}`;
    series.set(key, (series.get(key) ?? 0) + r.c);
  }
  const timeline = [...series].map(([key, c]) => {
    const [t, fam] = key.split("|");
    return { t: Number(t), series: fam, c };
  });

  return json({
    url,
    found: true,
    truncated: totals.n > rows.length,
    first_ts: totals.first,
    last_ts: rows[rows.length - 1].ts,
    last_bot: rows[rows.length - 1].bot_name,
    // The newest visit as it went, incident or not (state skips incidents).
    last_status: rows[rows.length - 1].status,
    last_bucket: rows[rows.length - 1].bucket,
    total_visits: totals.n,
    // Field labels and kinds, so the page lists them in one order.
    fields: FIELDS.map(({ key, label, list }) => ({ key, label, list: Boolean(list) })),
    versions,
    changes,
    state,
    last_by_family,
    recent,
    period: {
      visits,
      googlebot,
      ai_user: aiUser,
      ai_all: aiAll,
      granularity: bucket,
      series: FAMILIES,
      rows: timeline,
    },
  });
});
