// Log Analyzer > Loading Time - how fast the origin answered the bots, after
// EdgeComet's Loading Time report: the median, the 95th percentile and the
// share of slow requests with their change, response times next to the crawl
// volume over time, the spread of times, the slowest sections and URLs.
//
// One switch in the lead line picks the bots for the whole tab, Googlebot by
// default (pages/logAnalyzer.js groups.view, shared with Status Codes).
// Providers live at module scope so their cache survives switching tabs.
import { globalRange } from "../core/dateRange.js";
import { Dashboard } from "../core/registry.js";
import { Provider, BucketedProvider } from "../core/provider.js";
import { viewBotGroup } from "../core/botGroup.js";
import { h, deltaEl, statusBadge, urlCell, heatCell, fmtInt, fmtMs, fmtPct1 } from "../core/ui.js";
import { StatCardsChart } from "../charts/statCardsChart.js";
import { TimeSeriesChart } from "../charts/timeSeriesChart.js";
import { TableChart } from "../charts/tableChart.js";
import { ResponseTimeChart } from "../charts/responseTimeChart.js";
import { logAnalyzerHeader, groups, big, responseTimeProvider } from "./logAnalyzer.js";

const summaryProvider = new Provider("loadingSummary", "/api/loading-time/summary");
const trendProvider = new BucketedProvider("loadingTrend", "/api/loading-time/trend");
const urlsProvider = new Provider("loadingUrls", "/api/loading-time/urls");

// The two time lines, and the requests as quiet bars behind them.
const TREND_TOKENS = { median: "--blue", p95: "--orange", requests: "--border-medium" };

const share = (x) => (x.requests ? (x.slow / x.requests) * 100 : null);
const time = (ms) => (ms === null || ms === undefined ? "-" : fmtMs(ms));

function summaryCards({ current: c, previous: p, slowest: s, slow_ms, min_section_requests: min }) {
  const limit = fmtMs(slow_ms);
  return [
    {
      label: "Median Response",
      value: time(c.median),
      delta: deltaEl(c.median, p?.median, { good: "down" }),
      foot: `of ${big(c.requests)} requests`,
      hint: "Half of the requests were answered faster than this",
    },
    {
      label: "95th Percentile",
      value: time(c.p95),
      delta: deltaEl(c.p95, p?.p95, { good: "down" }),
      foot: "5% of requests took longer",
      hint: "95% of the requests were answered faster than this: the slow tail a median hides",
    },
    {
      label: "Slow Requests",
      value: share(c) === null ? "-" : fmtPct1(share(c)),
      delta: deltaEl(share(c), p ? share(p) : null, { kind: "pp", good: "down" }),
      foot: `${fmtInt(c.slow)} took ${limit} or longer`,
      hint:
        `Share of requests the origin took ${limit} or longer to answer: the 1-2s, 2-5s and 5s+ bars of the distribution added up. ` +
        "Google crawls less of a site that answers slowly",
    },
    s
      ? {
          label: "Slowest Section",
          value: s.section,
          delta: deltaEl(s.median, s.prev?.median, { good: "down" }),
          foot: `median ${fmtMs(s.median)}, ${fmtInt(s.requests)} requests`,
          hint: `${s.section}: the highest median response time of the sections with ${min} requests or more`,
        }
      : { label: "Slowest Section", value: "-", foot: `no section with ${min} requests` },
  ];
}

const segmentColumns = (d) => [
  { label: "Section", nowrap: true, render: (s) => h("span", { className: "mono", text: s.section }) },
  { label: "Requests", num: true, render: (s) => fmtInt(s.requests) },
  { label: "Median", num: true, render: (s) => fmtMs(s.median) },
  { label: "95th percentile", num: true, render: (s) => fmtMs(s.p95) },
  { label: `${fmtMs(d.slow_ms)} or longer`, render: (s) => heatCell(s.slow, s.requests, "--orange") },
];

const URL_COLUMNS = [
  { label: "Page", render: (r) => urlCell(r.url) },
  { label: "Median", num: true, render: (r) => fmtMs(r.median) },
  { label: "95th percentile", num: true, render: (r) => fmtMs(r.p95) },
  { label: "Visits", num: true, render: (r) => fmtInt(r.visits) },
  { label: "Last status", nowrap: true, render: (r) => statusBadge(r.status) },
];

export function renderLoadingTime(outlet) {
  const cards = h("div");
  const trend = h("div");
  const distribution = h("div");
  const segments = h("div", { className: "section" });
  const slowest = h("div", { className: "section" });

  const dashboard = new Dashboard(globalRange);
  dashboard.add(new StatCardsChart(cards, summaryProvider, summaryCards));
  dashboard.add(
    new TimeSeriesChart(trend, trendProvider, {
      title: "Response Time",
      subtitle: (d) => `median and 95th percentile per ${d.granularity}, requests as bars`,
      token: (key) => TREND_TOKENS[key],
      format: fmtMs,
      y2: { keys: ["requests"] },
      gaps: true,
      empty: "No requests from these bots in this period.",
    })
  );
  dashboard.add(new ResponseTimeChart(distribution, responseTimeProvider));
  dashboard.add(
    new TableChart(segments, summaryProvider, {
      title: "Segments",
      subtitle: "response times per section, the busiest sections first",
      columns: segmentColumns,
      rows: (d) => d.sections.rows,
      foot: (d) =>
        d.sections.other
          ? `and ${fmtInt(d.sections.other.sections)} smaller sections: ${fmtInt(d.sections.other.requests)} requests, ` +
            `${fmtPct1(share(d.sections.other))} took ${fmtMs(d.slow_ms)} or longer`
          : null,
      empty: "No requests from these bots in this period.",
    })
  );
  dashboard.add(
    new TableChart(slowest, urlsProvider, {
      title: "Slowest URLs",
      subtitle: (d) => `by median, among the ${fmtInt(d.ranked)} URLs with ${d.min_visits} visits or more`,
      columns: URL_COLUMNS,
      foot: (d) => `A URL needs ${d.min_visits} visits in the period to be listed, so a slow hit or two does not put it here.`,
      empty: "No URL had enough visits from these bots in this period to rank.",
    })
  );

  outlet.append(
    logAnalyzerHeader(
      "time",
      "How fast the origin answered the bots, where it is slow, and how the crawl followed.",
      viewBotGroup(dashboard.charts, groups, "view")
    ),
    cards,
    h("div", { className: "grid-2-1" }, trend, distribution),
    segments,
    slowest
  );
  dashboard.start();

  return () => dashboard.destroy();
}
