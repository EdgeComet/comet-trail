// Log Analyzer > Googlebot and > Bingbot - one report per search engine
// crawler, after EdgeComet's Bot Insights: how much it crawled and what it got
// back (Crawl Budget), where that crawl went (Efficiency), and whether the
// pages it fetched can be indexed, judged by its own visits (Indexability).
//
// Both reports are this one view. The bot is the path segment after
// /log-analyzer/ and reaches every endpoint as ?group= (lib/sql.js
// BOT_GROUP_SQL): each card counts the engine's Search crawlers, desktop and
// smartphone, except Bot Variants, which lists every crawler of the engine.
// Providers live at module scope and the group is part of their cache key, so
// each bot's figures are cached apart and survive switching tabs and bots.
import { globalRange } from "../core/dateRange.js";
import { Dashboard } from "../core/registry.js";
import { Chart } from "../core/chart.js";
import { Provider, BucketedProvider } from "../core/provider.js";
import { reportHeader } from "../core/report.js";
import { withChangeEvents, changeMarkers } from "../core/changeMarkers.js";
import { h, card, cssVar, badge, bucketBadge, dataTable, emptyMessage, deltaEl, BUCKETS, fmtInt, fmtCompact, fmtPct, fmtPct1, fmtMs } from "../core/ui.js";
import { StatCardsChart } from "../charts/statCardsChart.js";
import { TimeSeriesChart } from "../charts/timeSeriesChart.js";
import { TableChart } from "../charts/tableChart.js";
import { ResponseTimeChart } from "../charts/responseTimeChart.js";
import { big, WASTE, responseTimeProvider } from "./logAnalyzer.js";
import { summaryProvider as statusProvider, BREAKDOWN_COLUMNS } from "./statusCodes.js";
import { indexationCards } from "./indexation.js";

const summaryProvider = new Provider("searchSummary", "/api/search-bots/summary");
const trendProvider = new BucketedProvider("searchTrend", "/api/search-bots/trend");
const efficiencyProvider = new Provider("searchEfficiency", "/api/search-bots/efficiency");
const allocationProvider = new BucketedProvider("searchAllocation", "/api/search-bots/allocation");

// The bots with a report, by their ?group= key, which is also their path
// segment. `search` is their family in shared/bots.js FAMILIES; `others` says
// whether the engine has crawlers outside it (shared/bots.js `engine`), for
// Bot Variants to list: Google has, Bing has not.
const BOTS = {
  googlebot: { label: "Googlebot", search: "Googlebot Search", engine: "Google", token: "--bot-googlebot", others: true },
  bingbot: { label: "Bingbot", search: "Bingbot Search", engine: "Bing", token: "--bot-bingbot", others: false },
};

const TABS = [
  { key: "budget", label: "Crawl Budget", path: "" },
  { key: "efficiency", label: "Efficiency", path: "/efficiency" },
  { key: "indexability", label: "Indexability", path: "/indexability" },
];

// Every route of the two reports, for main.js. `nav` is the sidebar link a
// tab keeps highlighted.
export const SEARCH_BOT_ROUTES = Object.entries(BOTS).flatMap(([bot, b]) =>
  TABS.map((t) => ({
    path: `/log-analyzer/${bot}${t.path}`,
    nav: `/log-analyzer/${bot}`,
    title: t.key === "budget" ? b.label : `${b.label} ${t.label}`,
    render: (outlet) => renderSearchBot(outlet, bot, t.key),
  }))
);

const pct = (part, whole) => (whole ? (part / whole) * 100 : 0);
const muted = (text) => h("span", { className: "muted", text });

// A colored dot before a label, as in the chart legends.
const dotted = (token, label) =>
  h("span", { className: "inline-dot" }, h("span", { className: "bot-legend-dot", style: { background: cssVar(token) } }), h("span", { text: label }));

// --- Crawl Budget -------------------------------------------------------------

const crawlRate = (x) => (x.urls ? x.requests / x.urls : null);

const budgetCards = (b) => ({ current: c, previous: p, days }) => [
  {
    label: "Requests",
    value: big(c.requests),
    delta: deltaEl(c.requests, p?.requests),
    foot: "desktop and smartphone",
    hint: `Requests from the ${b.label} desktop and smartphone crawlers${b.others ? `. Bot Variants lists the other ${b.engine} crawlers, which no other card counts` : ""}`,
  },
  {
    label: "Unique URLs",
    value: big(c.urls),
    delta: deltaEl(c.urls, p?.urls),
    foot: "pages fetched",
  },
  {
    label: "Pages per Day",
    value: big(Math.round(c.requests / days)),
    delta: deltaEl(c.requests / days, p && p.requests / days),
    foot: "requests on an average day",
  },
  {
    label: "Crawl Rate",
    value: crawlRate(c) === null ? "-" : crawlRate(c).toFixed(1),
    delta: deltaEl(crawlRate(c), p ? crawlRate(p) : null, { good: "neutral" }),
    foot: "requests per URL",
    hint: `How many times ${b.label} fetched a URL in the period, on average: requests divided by unique URLs`,
  },
];

// Every kind of change can move the crawl, as on the Overview's Bot Activity.
const budgetMarkers = changeMarkers();

// Indexability Status: the requests by the verdict of the page each one got.
class VerdictsChart extends Chart {
  render({ current: c, previous: p }) {
    const title = "Indexability Status";
    const subtitle = "requests by the verdict of the page each got";
    if (!c.requests) {
      this.el.replaceChildren(card({ title, subtitle }, emptyMessage("No requests from this bot in this period.")));
      return;
    }
    const rows = Object.entries(c.buckets).filter(([key, n]) => n || key !== "other");
    const list = h(
      "div",
      { className: "bar-list" },
      rows.map(([key, n]) => {
        const share = pct(n, c.requests);
        const before = p?.requests ? pct(p.buckets[key], p.requests) : null;
        return h(
          "div",
          { className: "bar-row" },
          h(
            "div",
            { className: "bar-main" },
            h("span", { className: "bar-label", text: BUCKETS[key].label }),
            // An empty track for a zero: .bar-fill's min-width would show a nub.
            h("div", { className: "bar-track" }, n ? h("div", { className: "bar-fill", style: { width: `${share}%`, background: cssVar(BUCKETS[key].token) } }) : null),
            h("span", { className: "bar-value", text: fmtPct(share) })
          ),
          h(
            "div",
            { className: "bar-meta" },
            h("span", { text: `${fmtCompact(n)} request${n === 1 ? "" : "s"}` }),
            before === null ? null : deltaEl(share, before, { kind: "pp", good: key === "indexable" ? "up" : "down" })
          )
        );
      })
    );
    this.el.replaceChildren(card({ title, subtitle }, list));
  }
}

const variantColumns = (b) => [
  { label: "Crawler", nowrap: true, render: (r) => dotted(r.search ? b.token : "--bot-other", r.name) },
  { label: "Requests", num: true, render: (r) => fmtInt(r.requests) },
  { label: "Change", num: true, render: (r) => deltaEl(r.requests, r.prev?.requests) ?? muted("-") },
  { label: "URLs", num: true, render: (r) => fmtInt(r.urls) },
  { label: "Broken", num: true, render: (r) => (r.broken ? fmtInt(r.broken) : muted("0")) },
  { label: "Median", num: true, render: (r) => (r.median === null ? muted("-") : fmtMs(r.median)) },
];

// Which crawlers the other cards count, when the table lists more than those.
function variantsFoot(d) {
  const search = d.variants.filter((r) => r.search).map((r) => r.name);
  const counted = search.length && search.length < d.variants.length ? ` The other cards count ${search.join(" and ")} only.` : "";
  return `Broken: answered 4xx, 5xx or not at all. Median: the median response time.${counted}`;
}

function budgetTab(outlet, dashboard, bot) {
  const b = BOTS[bot];
  const cards = h("div");
  const trend = h("div", { className: "section" });
  const quality = h("div");
  const time = h("div");
  const verdicts = h("div");
  const variants = h("div");
  outlet.append(cards, trend, h("div", { className: "chart-pair" }, quality, time), h("div", { className: "chart-pair" }, verdicts, variants));

  dashboard.add(new StatCardsChart(cards, summaryProvider, budgetCards(b)));
  dashboard.add(
    withChangeEvents(
      new TimeSeriesChart(trend, trendProvider, {
        title: "Crawl Budget",
        subtitle: (d) => `requests and unique pages per ${d.granularity}${budgetMarkers(d).length ? "; dashed lines mark change events" : ""}`,
        token: (key) => (key === "requests" ? b.token : "--violet"),
        markers: budgetMarkers,
        empty: `No ${b.label} requests in this period.`,
      })
    )
  );
  dashboard.add(
    new TableChart(quality, statusProvider, {
      title: "Response Quality",
      subtitle: "per status code",
      columns: BREAKDOWN_COLUMNS,
      rows: (d) => d.codes.map((c) => ({ ...c, share: pct(c.requests, d.current.requests) })),
      compact: true,
      empty: "No requests from this bot in this period.",
    })
  );
  dashboard.add(new ResponseTimeChart(time, responseTimeProvider));
  dashboard.add(new VerdictsChart(verdicts, summaryProvider));
  dashboard.add(
    new TableChart(variants, summaryProvider, {
      title: "Bot Variants",
      subtitle: `every ${b.engine} crawler`,
      columns: variantColumns(b),
      rows: (d) => d.variants,
      foot: variantsFoot,
      compact: true,
      empty: `No ${b.engine} crawler visited in this period.`,
    })
  );
}

// --- Efficiency ---------------------------------------------------------------

const efficiency = (x) => (x.requests ? (x.indexable / x.requests) * 100 : null);

// Where most of the crawl that missed an indexable page went, as a share of
// all of it, as the Overview's Crawl Efficiency card says it.
function wasteFoot(c) {
  if (!c.requests) return "no requests";
  const [key, n] = Object.keys(WASTE)
    .map((k) => [k, c.reasons[k]?.requests ?? 0])
    .reduce((top, x) => (x[1] > top[1] ? x : top));
  return n ? `${fmtPct(pct(n, c.requests))} ${WASTE[key]}` : "all indexable";
}

const sumKind = (inventory, kind) => inventory.filter((r) => r.kind === kind).reduce((a, r) => a + r.urls, 0);

const efficiencyCards = (b) => ({ current: c, previous: p, inventory, declining, overcrawled }) => {
  const unfair = "previous period not fully recorded";
  return [
    {
      label: "Crawl Efficiency",
      value: efficiency(c) === null ? "-" : fmtPct1(efficiency(c)),
      delta: deltaEl(efficiency(c), p ? efficiency(p) : null, { kind: "pp" }),
      foot: wasteFoot(c),
      hint: `Share of ${b.search} requests that received an indexable page. The footnote names where most of the rest went, as a share of all of them`,
    },
    {
      label: "New URLs Found",
      value: inventory ? fmtInt(sumKind(inventory, "new")) : "-",
      foot: inventory ? "not fetched in the previous period" : unfair,
      hint: `URLs ${b.label} fetched in this period and not in the previous one`,
    },
    {
      label: "Declining Crawl",
      value: declining ? fmtInt(declining.urls) : "-",
      foot: declining ? "URLs with half the requests or fewer" : unfair,
      hint: declining
        ? `URLs that got ${declining.from} requests or more in the previous period and half as many or fewer in this one, none at all included`
        : null,
    },
    {
      label: "Overcrawled",
      value: fmtInt(overcrawled.urls),
      foot: overcrawled.threshold === null ? "no requests" : `more than ${fmtInt(overcrawled.threshold)} requests each`,
      hint: `URLs that got more requests than 99% of the URLs ${b.label} fetched in the period`,
    },
  ];
};

const ALLOCATION = {
  valuable: { token: "--green", note: "indexable pages without parameters", good: "up" },
  questionable: { token: "--amber", note: "indexable filter, sort, page and search URLs", good: "down" },
  wasted: { token: "--red", note: "canonicalized, noindex, redirects, errors", good: "down" },
};

// Change events of the fields that decide a verdict, as on Indexation.
const verdictChanges = changeMarkers(["status", "meta_robots", "canonical"]);

// The waste reasons, in the API's order, and why each one costs crawl.
const REASONS = {
  canonical: "the page names another URL as its canonical",
  noindex: "the page asks not to be indexed",
  redirect: "each one costs a second request to reach the page",
  client_error: "missing or gone pages",
  server_error: "the origin failed or did not answer",
  other: "another answer than 200",
  param: "filters, sorts, page numbers and search: indexable, worth a visit now and then",
};

const reasonBadge = (key) => (key === "param" ? badge("Parameter URLs", "") : bucketBadge(key));

const wasteColumns = [
  {
    label: "Reason",
    render: (r) => h("span", { className: "inline-dot" }, reasonBadge(r.key), h("span", { className: "target-hint", text: REASONS[r.key] })),
  },
  { label: "Requests", num: true, render: (r) => fmtInt(r.requests) },
  { label: "Change", num: true, render: (r) => deltaEl(r.requests, r.prev?.requests, { good: "down" }) ?? muted("-") },
  { label: "Share of crawl", num: true, render: (r) => fmtPct1(r.share) },
  { label: "URLs", num: true, render: (r) => fmtInt(r.urls) },
  { label: "Change", num: true, render: (r) => deltaEl(r.urls, r.prev?.urls, { good: "down" }) ?? muted("-") },
];

function wasteRows({ current: c, previous: p }) {
  return Object.keys(REASONS)
    .map((key) => ({ key, ...c.reasons[key], share: pct(c.reasons[key].requests, c.requests), prev: p?.reasons[key] ?? null }))
    .filter((r) => r.requests || r.prev?.requests);
}

// URL Inventory: the URLs that came and went, per kind of page, after
// EdgeComet's. `good` says whether more of them is healthy.
const INVENTORY = [
  { label: "Indexable", buckets: ["indexable"], good: "up" },
  { label: "Not indexable", buckets: ["noindex", "canonical"], good: "down" },
  { label: "Redirects", buckets: ["redirect"], good: "down" },
  { label: "Errors", buckets: ["client_error", "server_error", "other"], good: "down" },
];

class InventoryChart extends Chart {
  render({ inventory }) {
    const title = "URL Inventory";
    const subtitle = "against the previous period";
    if (!inventory) {
      this.el.replaceChildren(card({ title, subtitle }, emptyMessage("The previous period is not fully recorded, so there is nothing to compare with.")));
      return;
    }
    const count = (row, kind) => inventory.filter((r) => r.kind === kind && row.buckets.includes(r.bucket)).reduce((a, r) => a + r.urls, 0);
    const rows = INVENTORY.map((row) => ({ ...row, found: count(row, "new"), lost: count(row, "lost"), returning: count(row, "returning") }));
    const table = dataTable(
      [
        { label: "Pages", nowrap: true, render: (r) => r.label },
        { label: "New", num: true, render: (r) => fmtInt(r.found) },
        { label: "Lost", num: true, render: (r) => fmtInt(r.lost) },
        { label: "Net", num: true, render: (r) => deltaEl(r.found, r.lost, { kind: "abs", good: r.good }) },
        { label: "Returning", num: true, render: (r) => fmtInt(r.returning) },
      ],
      rows,
      { compact: true }
    );
    const foot = h(
      "div",
      { className: "card-footer", text: "New: fetched in this period and not in the previous one; lost: the reverse. Each URL counts under its newest verdict in the period it was fetched." }
    );
    this.el.replaceChildren(card({ title, subtitle, flush: true }, table, foot));
  }
}

function efficiencyTab(outlet, dashboard, bot) {
  const b = BOTS[bot];
  const cards = h("div");
  const allocation = h("div", { className: "section" });
  const waste = h("div");
  const inventory = h("div");
  outlet.append(cards, allocation, h("div", { className: "grid-2-1" }, waste, inventory));

  dashboard.add(new StatCardsChart(cards, efficiencyProvider, efficiencyCards(b)));
  dashboard.add(
    withChangeEvents(
      new TimeSeriesChart(allocation, allocationProvider, {
        title: "Crawl Budget Allocation",
        subtitle: (d) =>
          `requests per ${d.granularity}${verdictChanges(d).length ? "; dashed lines mark changes to status codes, robots tags and canonicals" : ""}`,
        token: (key) => ALLOCATION[key].token,
        type: "bar",
        summary: true,
        describe: (key) => ALLOCATION[key].note,
        good: (key) => ALLOCATION[key].good,
        markers: verdictChanges,
        empty: `No ${b.label} requests in this period.`,
      })
    )
  );
  dashboard.add(
    new TableChart(waste, efficiencyProvider, {
      title: "Crawl Waste Breakdown",
      subtitle: "the requests that missed a valuable page, by reason",
      columns: wasteColumns,
      rows: wasteRows,
      foot: () => "URLs: the URLs that got that answer at least once in the period.",
      empty: `Every ${b.label} request in this period got an indexable page without parameters.`,
    })
  );
  dashboard.add(new InventoryChart(inventory, efficiencyProvider));
}

// --- View -----------------------------------------------------------------------

const LEADS = {
  budget: (b) =>
    b.others
      ? `How much ${b.search} crawled, what it got back, and which other ${b.engine} crawlers came.`
      : `How much ${b.search} crawled and what it got back, desktop and smartphone.`,
  efficiency: (b) => `Where the crawl of ${b.search} went: to pages ${b.engine} can index, to parameter URLs or to waste, and which URLs it found or dropped.`,
  indexability: (b) => `Can ${b.engine} index the pages ${b.label} fetched? Each page is judged by the newest visit ${b.label} itself got.`,
};

export function renderSearchBot(outlet, bot, tab) {
  const b = BOTS[bot];
  outlet.append(
    reportHeader({
      title: b.label,
      subtitle: LEADS[tab](b),
      strip: { label: b.label, tabs: TABS.map((t) => ({ label: t.label, href: `/log-analyzer/${bot}${t.path}`, active: t.key === tab })) },
    })
  );

  const dashboard = new Dashboard(globalRange);
  if (tab === "budget") budgetTab(outlet, dashboard, bot);
  else if (tab === "efficiency") efficiencyTab(outlet, dashboard, bot);
  else indexationCards(outlet, dashboard, { group: bot, who: b.label, bots: b.label, ai: false });
  for (const chart of dashboard.charts) chart.params = { ...chart.params, group: bot };
  dashboard.start();

  return () => dashboard.destroy();
}
