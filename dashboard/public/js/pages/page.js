// Page view (/page?url=...) - the time machine for one URL.
//
// Every bot visit stored the page the bot received, so the history of a URL is
// a list of versions: what changed, when, and which bot saw it first. The view
// also answers the evergreen-crawl question a crawler can't: which version did
// each bot last get? A fix is only done once Googlebot has fetched it.
//
// All cards read one /api/page response through derive(), so the page costs a
// single request.
import { globalRange } from "../core/dateRange.js";
import { Dashboard } from "../core/registry.js";
import { Chart } from "../core/chart.js";
import { BucketedProvider, derive } from "../core/provider.js";
import { reportHeader } from "../core/report.js";
import {
  h, card, cssVar, icon, badge, statusBadge, bucketBadge, statCard, emptyState, dataTable, emptyMessage,
  fmtInt, fmtMs, fmtAgo, fmtDate, fmtDay, fmtDateTime, shortUrl,
} from "../core/ui.js";
import { diffEl, valueEl } from "../core/diff.js";
import { TimeSeriesChart } from "../charts/timeSeriesChart.js";

const pageProvider = new BucketedProvider("page", "/api/page");

// Families whose view of the page matters enough to call out a stale version.
const WATCHED = new Set(["googlebot", "bingbot", "chatgpt", "claude", "perplexity", "meta"]);

const RANK = { bad: 3, good: 2, neutral: 1 };
const moodOf = (version) =>
  version.n === 1 ? "first" : version.changes.reduce((m, c) => (RANK[c.sentiment] > RANK[m] ? c.sentiment : m), "neutral");

function familyDot(family) {
  return h("span", { className: "bot-legend-dot", style: { background: cssVar(`--bot-${family}`) } });
}

// A settled visit's version; null means the visit was an incident (no
// response, a 429 or a 5xx) and got no page at all.
function versionBadge(n, total) {
  if (n === null || n === undefined) return badge("incident", "error");
  return n === total ? badge(`v${n} · current`, "success") : badge(`v${n} of ${total}`, "warning");
}

// The fields that differ between two version states, as change records.
function stateDiff(fields, older, newer) {
  const out = [];
  if (older.status !== newer.status) out.push({ field: "status", label: "Status code", before: older.status, after: newer.status });
  if (older.bucket !== newer.bucket) out.push({ field: "bucket", label: "Indexability", before: older.bucket, after: newer.bucket });
  for (const f of fields) {
    const a = older.fields?.[f.key] ?? null;
    const b = newer.fields?.[f.key] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: f.key, label: f.label, list: f.list, before: a, after: b });
  }
  return out;
}

// --- Summary: status, counts, and the "not seen yet" callout ----------------

class PageSummary extends Chart {
  render(d) {
    if (!d.found) {
      this.el.replaceChildren(
        emptyState("No bot has fetched this URL yet.", [
          "CometTrail records a page the first time a search or AI bot requests it.",
          "Check the address: scheme, trailing slash and query string must match exactly.",
        ])
      );
      return;
    }
    const total = d.versions.length;
    const latest = d.versions[total - 1];

    const strip = h(
      "div",
      { className: "page-strip" },
      statusBadge(d.last_status),
      bucketBadge(d.last_bucket),
      h("span", { className: "page-strip-item", title: fmtDateTime(d.last_ts) }, `Last bot visit ${fmtAgo(d.last_ts)} by ${d.last_bot}`),
      h("span", { className: "page-strip-item" }, `First recorded ${fmtDate(d.first_ts)}`),
      h("span", { className: "page-strip-item" }, `${fmtInt(d.total_visits)} visits recorded`)
    );

    const p = d.period;
    const stats = h(
      "div",
      { className: "stat-grid section" },
      statCard({ label: "Bot visits", value: fmtInt(p.visits), foot: "in this period" }),
      statCard({ label: "Googlebot visits", value: fmtInt(p.googlebot), foot: "Googlebot Search, in this period" }),
      statCard({ label: "AI user fetches", value: fmtInt(p.ai_user), foot: "opened by AI assistants for users" }),
      statCard({ label: "Versions", value: fmtInt(total), foot: `${fmtInt(d.changes.length)} changes since ${fmtDay(d.first_ts)}` })
    );

    // Bots still holding an older version: the gap a crawler can't show.
    const stale = d.last_by_family.filter((f) => WATCHED.has(f.family) && f.version !== null && f.version < latest.n);
    const callouts = stale.map((f) => {
      const seen = d.versions[f.version - 1];
      const diff = stateDiff(d.fields, seen.state, latest.state);
      return h(
        "div",
        { className: "callout callout-warning section" },
        h(
          "div",
          { className: "callout-title" },
          familyDot(f.family),
          `${f.label} has not seen the current version yet`
        ),
        h(
          "p",
          { className: "callout-text" },
          `The last page it received, ${fmtDateTime(f.settled_ts)} (${f.settled_bot}), was version ${f.version} of ${total}. ` +
            `What it still has, compared with what bots get now:`
        ),
        h(
          "div",
          { className: "kv" },
          diff.map((c) => h("div", { className: "kv-row" }, h("div", { className: "kv-key", text: c.label }), h("div", { className: "kv-val" }, diffEl(c))))
        )
      );
    });

    this.el.replaceChildren(strip, stats, ...callouts);
  }
}

// --- Time machine: every version, and the page as of the one you pick --------

class TimeMachineChart extends Chart {
  constructor(el, provider) {
    super(el, provider);
    this.selected = null; // version number; null = newest
  }

  render(d) {
    this.data = d;
    if (!d.found) {
      this.el.replaceChildren();
      return;
    }
    const n = this.selected && this.selected <= d.versions.length ? this.selected : d.versions.length;
    this.el.replaceChildren(
      card(
        {
          title: "Time machine",
          subtitle: d.truncated
            ? `${d.versions.length} versions in the newest 5,000 of ${fmtInt(d.total_visits)} visits`
            : `${d.versions.length} version${d.versions.length === 1 ? "" : "s"} recorded since ${fmtDate(d.first_ts)}`,
        },
        this._track(d, n),
        this._detail(d, n)
      )
    );
  }

  _select(n) {
    this.selected = n;
    this.render(this.data);
  }

  _track(d, selected) {
    const t0 = d.first_ts;
    const t1 = Math.max(Date.now(), d.last_ts);
    const share = (ts) => ((ts - t0) / Math.max(1, t1 - t0)) * 100;
    const pos = (ts) => `${share(ts)}%`;
    // Versions close in time would print their labels on top of each other:
    // flip every other crowded label below the line.
    let lastX = -Infinity;
    let below = false;
    const flips = d.versions.map((v) => {
      const x = share(v.ts);
      below = x - lastX < 4 ? !below : false;
      lastX = x;
      return below;
    });
    const dots = d.versions.map((v, i) =>
      h(
        "button",
        {
          type: "button",
          className: `tm-dot tm-${moodOf(v)}${v.n === selected ? " is-selected" : ""}${flips[i] ? " label-below" : ""}`,
          style: { left: pos(v.ts) },
          title: `Version ${v.n} · ${fmtDateTime(v.ts)}${v.changes.length ? " · " + v.changes.map((c) => c.label).join(", ") : " · first recorded"}`,
          "aria-label": `Version ${v.n}`,
          on: { click: () => this._select(v.n) },
        },
        h("span", { className: "tm-dot-label", text: `v${v.n}` })
      )
    );
    // Where each watched bot's last visit sits on the line.
    const seen = d.last_by_family
      .filter((f) => WATCHED.has(f.family))
      .map((f) => h("span", { className: "tm-seen", style: { left: pos(f.ts), background: cssVar(`--bot-${f.family}`) }, title: `${f.label}: last visit ${fmtDateTime(f.ts)}` }));
    return h(
      "div",
      { className: "tm" },
      h("div", { className: "tm-line" }, h("div", { className: "tm-rail" }), ...seen, ...dots),
      h("div", { className: "tm-axis" }, h("span", { text: fmtDate(t0) }), h("span", { text: "now" })),
      h(
        "div",
        { className: "tm-legend" },
        h("span", {}, h("i", { className: "tm-key tm-bad" }), "lost indexability or a 2xx"),
        h("span", {}, h("i", { className: "tm-key tm-good" }), "recovered"),
        h("span", {}, h("i", { className: "tm-key tm-neutral" }), "content change"),
        h("span", {}, h("i", { className: "tm-key tm-seen-key" }), "a bot's last visit")
      )
    );
  }

  _detail(d, n) {
    const v = d.versions[n - 1];
    const next = d.versions[n];
    const changed = new Map(v.changes.map((c) => [c.field, c]));
    const seenHere = d.last_by_family.filter((f) => f.version === n);

    const nav = h(
      "div",
      { className: "tm-nav" },
      h("button", { type: "button", className: "btn btn-ghost btn-sm", disabled: n === 1, on: { click: () => this._select(n - 1) } }, "← Older"),
      h("button", { type: "button", className: "btn btn-ghost btn-sm", disabled: n === d.versions.length, on: { click: () => this._select(n + 1) } }, "Newer →")
    );

    const lifetime = next
      ? `live ${fmtDay(v.ts)} - ${fmtDay(next.ts)}`
      : `current since ${fmtDay(v.ts)}`;

    const head = h(
      "div",
      { className: "tm-head" },
      h(
        "div",
        {},
        h("div", { className: "tm-title" }, `Version ${n} of ${d.versions.length}`, n === d.versions.length ? badge("current", "success") : null),
        h("div", { className: "tm-sub" }, `${n === 1 ? "First recorded" : "First seen"} ${fmtDateTime(v.ts)} by ${v.bot_name} · ${lifetime}`),
        seenHere.length
          ? h(
              "div",
              { className: "tm-seen-by" },
              h("span", { className: "muted", text: "Last version seen by " }),
              seenHere.map((f) => h("span", { className: "tm-chip" }, familyDot(f.family), f.label))
            )
          : null
      ),
      nav
    );

    const rows = [
      { key: "status", label: "Status code", value: v.state.status },
      { key: "bucket", label: "Indexability", value: v.state.bucket },
      ...d.fields.map((f) => ({ key: f.key, label: f.label, list: f.list, value: v.state.fields?.[f.key] ?? null })),
    ].map((row) => {
      const c = changed.get(row.key);
      return h(
        "div",
        { className: c ? `kv-row is-changed tm-${c.sentiment}` : "kv-row" },
        h("div", { className: "kv-key" }, row.label, c ? h("span", { className: "kv-flag", text: "changed" }) : null),
        h("div", { className: "kv-val" }, c ? diffEl(c) : valueEl(row.key, row.value))
      );
    });

    const note = v.state.status !== 200 && v.state.fields
      ? h("p", { className: "diff-note", text: "The page answered with an error or redirect; the tags below are from its last 200 visit." })
      : null;

    return h("div", { className: "tm-detail" }, head, note, h("div", { className: "kv" }, rows));
  }
}

// --- Tables -------------------------------------------------------------------

class LastSeenChart extends Chart {
  render(d) {
    if (!d.found) return this.el.replaceChildren();
    const total = d.versions.length;
    const table = dataTable(
      [
        { label: "Bot family", nowrap: true, render: (r) => h("span", { className: "inline-dot" }, familyDot(r.family), r.label) },
        { label: "Last visit", nowrap: true, render: (r) => h("span", { title: fmtDateTime(r.ts), text: fmtAgo(r.ts) }) },
        { label: "Bot", render: (r) => r.bot_name },
        { label: "Status", render: (r) => statusBadge(r.status) },
        { label: "Version seen", nowrap: true, render: (r) => versionBadge(r.version, total) },
      ],
      d.last_by_family
    );
    this.el.replaceChildren(card({ title: "What each bot last saw", subtitle: "newest visit per family", flush: true }, table));
  }
}

class ChangeLogChart extends Chart {
  render(d) {
    if (!d.found) return this.el.replaceChildren();
    const rows = [...d.changes].reverse();
    const body = rows.length
      ? dataTable(
          [
            { label: "Date", nowrap: true, render: (r) => h("span", { title: fmtDateTime(r.ts), text: fmtDate(r.ts) }) },
            { label: "Field", nowrap: true, render: (r) => r.label },
            { label: "Change", render: (r) => diffEl(r) },
            { label: "First seen by", nowrap: true, render: (r) => r.bot_name },
          ],
          rows
        )
      : emptyMessage("No changes recorded: every bot received the same page.");
    this.el.replaceChildren(card({ title: "All changes", subtitle: `${rows.length} since ${fmtDay(d.first_ts)}`, flush: rows.length > 0 }, body));
  }
}

class VisitLogChart extends Chart {
  render(d) {
    if (!d.found) return this.el.replaceChildren();
    const total = d.versions.length;
    const table = dataTable(
      [
        { label: "When", nowrap: true, render: (r) => h("span", { title: fmtDateTime(r.ts), text: fmtDateTime(r.ts) }) },
        { label: "Bot", nowrap: true, render: (r) => h("span", { className: "inline-dot" }, familyDot(r.family), r.bot_name) },
        { label: "Status", render: (r) => statusBadge(r.status) },
        { label: "Verdict", nowrap: true, render: (r) => bucketBadge(r.bucket) },
        { label: "Version", nowrap: true, render: (r) => versionBadge(r.version, total) },
        { label: "Response", num: true, render: (r) => fmtMs(r.response_time_ms) },
      ],
      d.recent
    );
    this.el.replaceChildren(card({ title: "Visit log", subtitle: "newest 25 visits", flush: true }, table));
  }
}

// Change markers for the visits chart: one dashed line per version.
function versionMarkers(data) {
  return data.versions
    .filter((v) => v.n > 1)
    .map((v) => ({
      t: v.ts,
      text: v.changes.length === 1 ? v.changes[0].label : `${v.changes.length} changes`,
      cls: `marker-${moodOf(v)}`,
    }));
}

export function renderPage(outlet, params) {
  const url = params.get("url");
  if (!url) {
    outlet.append(reportHeader({ title: "Page", strip: { back: { href: "/pages", label: "Pages" } } }), emptyState("Pick a page from the Pages list."));
    return null;
  }

  // Only a web address becomes a link; anything else in ?url= stays text.
  const open = /^https?:\/\//i.test(url)
    ? h("a", { className: "btn btn-ghost", href: url, target: "_blank", rel: "noopener noreferrer" }, icon("external"), "Open page")
    : null;
  outlet.append(
    reportHeader({ title: shortUrl(url), strip: { back: { href: "/pages", label: "Pages" }, title: url }, actions: open })
  );

  const summary = h("div");
  const machine = h("div", { className: "section" });
  const visits = h("div", { className: "section" });
  const lastSeen = h("div", { className: "section" });
  const changeLog = h("div", { className: "section" });
  const log = h("div", { className: "section" });
  outlet.append(summary, machine, lastSeen, visits, changeLog, log);

  const visitsView = derive(pageProvider, (d) =>
    d.found ? { ...d.period, versions: d.versions } : { granularity: "day", series: [], rows: [], versions: [] }
  );

  const charts = [
    new PageSummary(summary, pageProvider),
    new TimeMachineChart(machine, pageProvider),
    new TimeSeriesChart(visits, visitsView, {
      title: "Bot visits",
      subtitle: "dashed lines mark new versions",
      token: (key) => `--bot-${key}`,
      type: "bar",
      height: 240,
      markers: versionMarkers,
      hideEmpty: true,
      empty: "No bot visited this page in this period.",
    }),
    new LastSeenChart(lastSeen, pageProvider),
    new ChangeLogChart(changeLog, pageProvider),
    new VisitLogChart(log, pageProvider),
  ];

  const dashboard = new Dashboard(globalRange);
  for (const chart of charts) {
    chart.params = { url };
    dashboard.add(chart);
  }
  dashboard.start();
  return () => dashboard.destroy();
}
