// Log Analyzer > Overview - what the bots requested and what they received:
// volume, families, status codes, speed, and the newest visits with the page
// each one carried. Providers live at module scope so their in-memory cache
// survives navigating away and back, and so does the bot group each blended
// card shows.
//
// The report's other tabs, Status Codes and Loading Time, are views of their
// own (pages/statusCodes.js, pages/loadingTime.js) under the same header.
import { globalRange } from "../core/dateRange.js";
import { Dashboard } from "../core/registry.js";
import { Provider, BucketedProvider } from "../core/provider.js";
import { reportHeader } from "../core/report.js";
import { withBotGroup } from "../core/botGroup.js";
import { withChangeEvents, changeMarkers } from "../core/changeMarkers.js";
import { h, cssVar, fmtInt, fmtCompact, fmtPct, fmtPct1, fmtMs, fmtAgo, fmtDateTime, deltaEl, statusBadge, bucketBadge, urlCell } from "../core/ui.js";
import { StatCardsChart } from "../charts/statCardsChart.js";
import { TimeSeriesChart } from "../charts/timeSeriesChart.js";
import { TableChart } from "../charts/tableChart.js";
import { StatusDistributionChart } from "../charts/statusDistributionChart.js";
import { ResponseTimeChart } from "../charts/responseTimeChart.js";
import { StatusDistributionProvider } from "../providers/statusDistributionProvider.js";
import { ResponseTimeProvider } from "../providers/responseTimeProvider.js";

const metricsProvider = new Provider("metrics", "/api/metrics");
const botActivityProvider = new BucketedProvider("botActivity", "/api/bot-activity");
const statusDistProvider = new StatusDistributionProvider();
const recentProvider = new Provider("recentVisits", "/api/recent-visits");
// Loading Time shows the same distribution card, from the same cache.
export const responseTimeProvider = new ResponseTimeProvider();

// The bot group of each card with an "All bots / Googlebot / AI bots" switch.
// `view` is the one switch of the Status Codes and Loading Time tabs, shared
// by both, so moving between them keeps the bots. Googlebot by default: its
// errors and slow answers are the ones that cost crawling and indexing.
export const groups = { status: "all", time: "all", view: "googlebot" };

const TABS = [
  { key: "overview", label: "Overview", href: "/log-analyzer" },
  { key: "status", label: "Status Codes", href: "/log-analyzer/status-codes" },
  { key: "time", label: "Loading Time", href: "/log-analyzer/loading-time" },
];

// The header every Log Analyzer tab shares: the tabs in the strip, the tab's
// lead line and, on Status Codes and Loading Time, the bot switch.
export function logAnalyzerHeader(tab, subtitle, filter = null) {
  return reportHeader({
    title: "Log Analyzer",
    subtitle,
    filter,
    strip: { label: "Log Analyzer", tabs: TABS.map((t) => ({ label: t.label, href: t.href, active: t.key === tab })) },
  });
}

// A count for a stat card: compact from 100,000 up, so it fits the tile.
export const big = (n) => (n >= 100000 ? fmtCompact(n) : fmtInt(n));

// Where the Googlebot requests that missed an indexable page went, per verdict
// (lib/sql.js PAGE_BUCKETS). The card names the largest, as a share of all of
// Googlebot's requests. The footnote names whose crawl it is first, so a
// narrow card that cuts the rest still says that, and its words are short
// enough to fit whole on a card 160px wide (a 1100px window): "Google: 25%
// canonicalized" is 152px, where "Googlebot:" would cut the verdict. The hint
// spells it out.
const WASTE = {
  canonical: "canonicalized",
  noindex: "noindex",
  redirect: "redirects",
  client_error: "4xx errors",
  server_error: "server errors",
  other: "other codes",
};

function efficiencyFoot({ googlebot, googlebot_buckets: b }) {
  if (!googlebot) return "no Googlebot requests";
  const [key, n] = Object.keys(WASTE)
    .map((k) => [k, b[k] ?? 0])
    .reduce((top, x) => (x[1] > top[1] ? x : top));
  return `Google: ${n ? `${fmtPct((n / googlebot) * 100)} ${WASTE[key]}` : "all indexable"}`;
}

function metricCards({ current: c, previous: p }) {
  return [
    {
      label: "Total Requests",
      value: big(c.total_requests),
      delta: deltaEl(c.total_requests, p?.total_requests),
      foot: "from all bots",
    },
    {
      label: "Unique URLs",
      value: big(c.unique_urls),
      delta: deltaEl(c.unique_urls, p?.unique_urls),
      foot: "pages visited",
      href: "/pages",
    },
    {
      label: "Crawl Efficiency",
      value: c.crawl_efficiency === null ? "-" : fmtPct1(c.crawl_efficiency),
      delta: deltaEl(c.crawl_efficiency, p?.crawl_efficiency, { kind: "pp" }),
      foot: efficiencyFoot(c),
      hint: "Share of Googlebot Search requests that received an indexable page. The footnote names where most of the rest went, as a share of all of them: to canonicalized or noindex pages, redirects or errors",
    },
    {
      label: "Median Response",
      value: c.median_response_ms === null ? "-" : fmtMs(c.median_response_ms),
      delta: deltaEl(c.median_response_ms, p?.median_response_ms, { good: "down" }),
      foot: c.median_response_ms === null ? "no requests" : `95th percentile: ${fmtMs(c.p95_response_ms)}`,
      hint: "Half of the requests were answered faster than the median, 95% faster than the 95th percentile",
      href: "/log-analyzer/loading-time",
    },
  ];
}

// Every kind of change can move the crawl: a release that changes canonicals,
// robots or templates on many pages.
const activityMarkers = changeMarkers();

function botCell(row) {
  return h(
    "span",
    { className: "inline-dot" },
    h("span", { className: "bot-legend-dot", style: { background: cssVar(`--bot-${row.family}`) } }),
    h("span", { text: row.bot_name })
  );
}

const RECENT_COLUMNS = [
  { label: "When", nowrap: true, render: (r) => h("span", { title: fmtDateTime(r.ts), text: fmtAgo(r.ts) }) },
  { label: "Bot", nowrap: true, render: botCell },
  { label: "Page and the title the bot received", render: (r) => urlCell(r.url, r.title ?? "(no title)") },
  { label: "Status", nowrap: true, render: (r) => statusBadge(r.status) },
  { label: "Verdict", nowrap: true, render: (r) => bucketBadge(r.bucket) },
  { label: "Response", num: true, render: (r) => fmtMs(r.response_time_ms) },
];

export function renderLogAnalyzer(outlet) {
  outlet.append(logAnalyzerHeader("overview", "Every search and AI bot request, with the page each one received."));

  const metrics = h("div");
  const activity = h("div", { className: "section" });
  const statusDist = h("div");
  const responseTime = h("div");
  const recent = h("div", { className: "section" });
  outlet.append(metrics, activity, h("div", { className: "chart-pair" }, statusDist, responseTime), recent);

  const dashboard = new Dashboard(globalRange);
  dashboard.add(new StatCardsChart(metrics, metricsProvider, metricCards));
  dashboard.add(
    withChangeEvents(
      new TimeSeriesChart(activity, botActivityProvider, {
        title: "Bot Activity",
        subtitle: (d) => (activityMarkers(d).length ? "dashed lines mark change events" : null),
        token: (key) => `--bot-${key}`,
        summary: true,
        markers: activityMarkers,
      })
    )
  );
  dashboard.add(withBotGroup(new StatusDistributionChart(statusDist, statusDistProvider), groups, "status"));
  dashboard.add(withBotGroup(new ResponseTimeChart(responseTime, responseTimeProvider), groups, "time"));
  dashboard.add(
    new TableChart(recent, recentProvider, {
      title: "Latest bot visits",
      subtitle: "each log line carries the page the bot received",
      columns: RECENT_COLUMNS,
      link: { href: "/pages", label: "All pages" },
    })
  );
  dashboard.start();

  // Router teardown: detach the range subscription and destroy charts (billboard
  // instances hold a window-resize listener) before the next view.
  return () => dashboard.destroy();
}
