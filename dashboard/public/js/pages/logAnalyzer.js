// Log Analyzer > Overview - what the bots requested and what they received:
// volume, families, status codes, speed, and the newest visits with the page
// each one carried. Providers live at module scope so their in-memory cache
// survives navigating away and back.
import { globalRange } from "../core/dateRange.js";
import { Dashboard } from "../core/registry.js";
import { Provider, BucketedProvider } from "../core/provider.js";
import { reportHeader } from "../core/report.js";
import { h, cssVar, fmtInt, fmtCompact, fmtPct1, fmtMs, fmtAgo, fmtDateTime, deltaEl, statusBadge, bucketBadge, urlCell } from "../core/ui.js";
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
const responseTimeProvider = new ResponseTimeProvider();
const recentProvider = new Provider("recentVisits", "/api/recent-visits");

const big = (n) => (n >= 100000 ? fmtCompact(n) : fmtInt(n));

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
      value: fmtPct1(c.crawl_efficiency),
      delta: deltaEl(c.crawl_efficiency, p?.crawl_efficiency, { kind: "pp" }),
      foot: "2xx responses",
    },
    {
      label: "Avg Response",
      value: fmtMs(c.avg_response_ms),
      delta: deltaEl(c.avg_response_ms, p?.avg_response_ms, { good: "down" }),
      foot: p ? `vs ${fmtMs(p.avg_response_ms)} before` : "response time",
    },
  ];
}

function botCell(row) {
  return h(
    "span",
    { className: "bot-legend-item", style: { cursor: "default" } },
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
  outlet.append(
    reportHeader({
      title: "Log Analyzer",
      subtitle: "Every search and AI bot request, with the page each one received.",
    })
  );

  const metrics = h("div");
  const activity = h("div", { className: "section" });
  const statusDist = h("div");
  const responseTime = h("div");
  const recent = h("div", { className: "section" });
  outlet.append(metrics, activity, h("div", { className: "chart-pair" }, statusDist, responseTime), recent);

  const dashboard = new Dashboard(globalRange);
  dashboard.add(new StatCardsChart(metrics, metricsProvider, metricCards));
  dashboard.add(
    new TimeSeriesChart(activity, botActivityProvider, {
      title: "Bot Activity",
      token: (key) => `--bot-${key}`,
      summary: true,
    })
  );
  dashboard.add(new StatusDistributionChart(statusDist, statusDistProvider));
  dashboard.add(new ResponseTimeChart(responseTime, responseTimeProvider));
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
