// Log Analyzer > Status Codes - what the bots got back, after EdgeComet's
// Status Codes report: error answers and their change, responses per status
// class over time, every code with its URLs, the sections that answer worst,
// and the URLs that fail or redirect.
//
// One switch in the lead line picks the bots for the whole tab, Googlebot by
// default (pages/logAnalyzer.js groups.view, shared with Loading Time).
// Providers live at module scope so their cache survives switching tabs.
import { globalRange } from "../core/dateRange.js";
import { Dashboard } from "../core/registry.js";
import { Chart } from "../core/chart.js";
import { Provider, BucketedProvider, derive } from "../core/provider.js";
import { viewBotGroup } from "../core/botGroup.js";
import { withChangeEvents, changeMarkers } from "../core/changeMarkers.js";
import { h, card, dataTable, emptyMessage, segmented, deltaEl, statusBadge, urlCell, heatCell, fmtInt, fmtPct1, fmtAgo, fmtDay, fmtDateTime } from "../core/ui.js";
import { StatCardsChart } from "../charts/statCardsChart.js";
import { TimeSeriesChart } from "../charts/timeSeriesChart.js";
import { TableChart } from "../charts/tableChart.js";
import { logAnalyzerHeader, groups, big } from "./logAnalyzer.js";

const summaryProvider = new Provider("statusSummary", "/api/status-codes/summary");
const trendProvider = new BucketedProvider("statusTrend", "/api/status-codes/trend");
const urlsProvider = new Provider("statusUrls", "/api/status-codes/urls");

// Status class colors, as in the Response Status Distribution bars.
const CLASS_TOKENS = { "2xx": "--green", "3xx": "--blue", "4xx": "--amber", "5xx": "--red", none: "--slate" };

// Status code changes the site made on many pages, e.g. removed products that
// went from 404 to a redirect. Outages are not changes: their 5xx show as bars.
const statusChanges = changeMarkers(["status"]);

const pct = (part, whole) => (whole ? (part / whole) * 100 : 0);
const errors = (x) => x.classes["4xx"].requests + x.classes["5xx"].requests + x.classes.none.requests;
const serverErrors = (x) => x.classes["5xx"].requests + x.classes.none.requests;
const muted = (text) => h("span", { className: "muted", text });
const when = (ts) => h("span", { title: fmtDateTime(ts), text: fmtAgo(ts) });
const day = (ts) => h("span", { title: fmtDateTime(ts), text: fmtDay(ts) });

function summaryCards({ current: c, previous: p }) {
  return [
    {
      label: "Error Responses",
      value: big(errors(c)),
      delta: deltaEl(errors(c), p && errors(p), { good: "down" }),
      foot: `${fmtPct1(pct(errors(c), c.requests))} of ${big(c.requests)} requests`,
      hint: "Requests answered 4xx or 5xx, or not answered at all",
    },
    {
      label: "404 and 410 URLs",
      value: fmtInt(c.gone.urls),
      delta: deltaEl(c.gone.urls, p?.gone.urls, { kind: "abs", good: "down" }),
      foot: `${fmtInt(c.gone.requests)} requests to them`,
      hint: "URLs that answered 404 Not Found or 410 Gone",
    },
    {
      label: "Server Errors",
      value: big(serverErrors(c)),
      delta: deltaEl(serverErrors(c), p && serverErrors(p), { good: "down" }),
      foot: c.classes.none.requests ? `${fmtInt(c.classes.none.requests)} got no response` : "all 5xx, none unanswered",
      hint: "Requests answered 5xx, and requests the origin did not answer at all",
    },
    {
      label: "Redirects",
      value: big(c.classes["3xx"].requests),
      delta: deltaEl(c.classes["3xx"].requests, p?.classes["3xx"].requests, { good: "down" }),
      foot: `${fmtInt(c.classes["3xx"].urls)} URLs answered 3xx`,
      hint: "Requests answered with a redirect: each one costs the bot a second request to reach the page",
    },
  ];
}

// --- Breakdown: one row per status code --------------------------------------

// A code's change against the previous period. More 2xx is good, more of
// anything else is not; a code the previous period never saw is "new".
function codeChange(r) {
  if (r.prev === null) return muted("-");
  const good = r.status !== null && r.status < 300 ? "up" : "down";
  if (!r.prev) {
    const cls = good === "up" ? "stat-delta stat-delta-positive" : "stat-delta stat-delta-negative";
    return r.requests ? h("span", { className: cls, title: "not seen in the previous period", text: "new" }) : muted("-");
  }
  return deltaEl(r.requests, r.prev, { good });
}

const BREAKDOWN_COLUMNS = [
  { label: "Code", nowrap: true, render: (r) => statusBadge(r.status) },
  { label: "Requests", num: true, render: (r) => fmtInt(r.requests) },
  { label: "Share", num: true, render: (r) => fmtPct1(r.share) },
  { label: "URLs", num: true, render: (r) => fmtInt(r.urls) },
  { label: "Change", num: true, render: codeChange },
];

// --- Segments: status classes per section -------------------------------------

const SEGMENT_COLUMNS = [
  { label: "Section", nowrap: true, render: (s) => h("span", { className: "mono", text: s.section }) },
  { label: "Requests", num: true, render: (s) => fmtInt(s.requests) },
  { label: "2xx", num: true, render: (s) => fmtPct1(pct(s["2xx"], s.requests)) },
  ...["3xx", "4xx", "5xx", "none"].map((key) => ({
    label: key === "none" ? "No response" : key,
    render: (s) => heatCell(s[key], s.requests, CLASS_TOKENS[key]),
  })),
];

function segmentsFoot({ other: o }) {
  if (!o) return null;
  return `and ${fmtInt(o.sections)} smaller sections: ${fmtInt(o.requests)} requests, ${fmtPct1(pct(o["4xx"] + o["5xx"] + o.none, o.requests))} errors`;
}

// --- URL lists --------------------------------------------------------------

const aiUser = { label: "AI user fetches", num: true, render: (r) => (r.ai_user ? fmtInt(r.ai_user) : muted("0")) };
const goodCell = (r) => (r.good_ts ? h("span", { className: "inline-dot" }, statusBadge(r.good_status), day(r.good_ts)) : muted("none recorded"));

const BROKEN_HEAD = [
  { label: "Page", render: (r) => urlCell(r.url) },
  { label: "Status", nowrap: true, render: (r) => statusBadge(r.status) },
  { label: "Failed hits", num: true, render: (r) => fmtInt(r.hits) },
  { label: "Last failed", nowrap: true, render: (r) => when(r.last_ts) },
];

// The two halves of Broken URLs: the URLs whose newest answer still fails,
// and the ones that answered well again after failing (an outage, a fix).
const BROKEN = {
  failing: {
    label: "Last visit failed",
    columns: [
      ...BROKEN_HEAD,
      { label: "Failing since", nowrap: true, render: (r) => day(r.since) },
      { label: "Last good", nowrap: true, render: goodCell },
      aiUser,
    ],
    note: "Failing since: the first failure after the last good answer (2xx or 3xx) these bots got, as far back as the record goes.",
    empty: "No URL failed on its last visit by these bots.",
  },
  recovered: {
    label: "Recovered",
    columns: [...BROKEN_HEAD, { label: "Answers now", nowrap: true, render: goodCell }, aiUser],
    note: "These bots got a good answer (2xx or 3xx) after the last failure; Answers now is the newest one.",
    empty: "No URL that failed in this period answered well again.",
  },
};

class BrokenChart extends Chart {
  constructor(el, provider) {
    super(el, provider);
    this.state = "failing";
  }

  render(d) {
    this.data = d;
    const counts = { failing: d.totals.failing, recovered: d.totals.broken - d.totals.failing };
    const view = BROKEN[this.state];
    const rows = d.broken.filter((r) => r.failing === (this.state === "failing"));
    const actions = d.totals.broken
      ? segmented({
          options: Object.entries(BROKEN).map(([key, b]) => ({ key, label: `${b.label} ${fmtInt(counts[key])}` })),
          value: this.state,
          label: "Broken URLs",
          onChange: (key) => {
            this.state = key;
            this.render(this.data);
            this.el.querySelector(".segmented-btn.active")?.focus();
          },
        })
      : null;
    const subtitle = "404, 410, 5xx or no response";
    if (!d.totals.broken) {
      this.el.replaceChildren(card({ title: "Broken URLs", subtitle }, emptyMessage("No URL answered 404, 410, 5xx or nothing to these bots in this period.")));
      return;
    }
    const body = rows.length ? dataTable(view.columns, rows) : emptyMessage(view.empty);
    const foot = rows.length
      ? h("div", { className: "card-footer", text: `${listed(rows.length, counts[this.state], "URLs")}The most hit first. ${view.note}` })
      : null;
    this.el.replaceChildren(card({ title: "Broken URLs", subtitle, actions, flush: rows.length > 0 }, body, foot));
  }
}

const REDIRECT_COLUMNS = [
  { label: "Page", render: (r) => urlCell(r.url) },
  { label: "Status", nowrap: true, render: (r) => statusBadge(r.status) },
  { label: "Hits", num: true, render: (r) => fmtInt(r.hits) },
  { label: "Last hit", nowrap: true, render: (r) => when(r.last_ts) },
  { label: "AI user fetches", num: true, render: (r) => (r.ai_user ? fmtInt(r.ai_user) : muted("0")) },
];

const listed = (shown, total, noun) => (total > shown ? `The first ${fmtInt(shown)} of ${fmtInt(total)} ${noun}. ` : "");

export function renderStatusCodes(outlet) {
  const cards = h("div");
  const trend = h("div");
  const breakdown = h("div");
  const segments = h("div", { className: "section" });
  const broken = h("div", { className: "section" });
  const redirects = h("div", { className: "section" });

  const dashboard = new Dashboard(globalRange);
  dashboard.add(new StatCardsChart(cards, summaryProvider, summaryCards));
  dashboard.add(
    withChangeEvents(
      new TimeSeriesChart(trend, trendProvider, {
        title: "Response Status Codes",
        subtitle: (d) => `requests per ${d.granularity}${statusChanges(d).length ? "; dashed lines mark status code changes" : ""}`,
        token: (key) => CLASS_TOKENS[key],
        type: "bar",
        markers: statusChanges,
        hideEmpty: true,
        empty: "No requests from these bots in this period.",
      })
    )
  );
  dashboard.add(
    new TableChart(breakdown, summaryProvider, {
      title: "Breakdown",
      subtitle: "per status code",
      columns: BREAKDOWN_COLUMNS,
      rows: (d) => d.codes.map((c) => ({ ...c, share: pct(c.requests, d.current.requests) })),
      compact: true,
      empty: "No requests from these bots in this period.",
    })
  );
  dashboard.add(
    new TableChart(segments, derive(summaryProvider, (d) => d.sections), {
      title: "Segments",
      subtitle: "share of each section's requests per status class, the busiest sections first",
      columns: SEGMENT_COLUMNS,
      foot: segmentsFoot,
      empty: "No requests from these bots in this period.",
    })
  );
  dashboard.add(new BrokenChart(broken, urlsProvider));
  dashboard.add(
    new TableChart(redirects, urlsProvider, {
      title: "Redirecting URLs",
      subtitle: (d) => (d.totals.redirects ? `${fmtInt(d.totals.redirects)} URLs bots keep fetching that answer 3xx` : "URLs that answer 3xx"),
      columns: REDIRECT_COLUMNS,
      rows: (d) => d.redirects,
      foot: (d) =>
        `${listed(d.redirects.length, d.totals.redirects, "URLs")}The most hit first. ` +
        "CometTrail records the redirect but not where it leads: the target URL is not in the data.",
      empty: "No URL answered with a redirect to these bots in this period.",
    })
  );

  outlet.append(
    logAnalyzerHeader(
      "status",
      "What the bots got back: status codes over time, per code and per section, and the URLs that fail or redirect.",
      viewBotGroup(dashboard.charts, groups, "view")
    ),
    cards,
    h("div", { className: "grid-2-1" }, trend, breakdown),
    segments,
    broken,
    redirects
  );
  dashboard.start();

  return () => dashboard.destroy();
}
