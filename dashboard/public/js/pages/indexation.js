// Evergreen Crawl > Indexation - can bots index the pages they fetched, and
// what changed since the previous period?
//
// Every page gets one verdict, from the newest visit in the period, and is
// compared with its verdict in the period before: no crawl to schedule, no
// export to diff. Providers live at module scope so their in-memory cache
// survives navigating away and back.
//
// The Indexability tab of Log Analyzer > Googlebot and > Bingbot shows the same
// cards for one bot (indexationCards with a scope): each page is then judged
// by the newest visit that bot got, so a fix it has not fetched yet still
// reads as the old verdict there.
import { globalRange } from "../core/dateRange.js";
import { Dashboard } from "../core/registry.js";
import { Chart } from "../core/chart.js";
import { Provider } from "../core/provider.js";
import { reportHeader } from "../core/report.js";
import { withChangeEvents, changeMarkers } from "../core/changeMarkers.js";
import { h, card, cssVar, dataTable, bucketBadge, deltaEl, fmtInt, fmtPct1, BUCKETS } from "../core/ui.js";
import { StatCardsChart } from "../charts/statCardsChart.js";
import { MovesChart } from "../charts/movesChart.js";
import { TimeSeriesChart } from "../charts/timeSeriesChart.js";
import { CanonicalSummaryChart, CanonicalTargetsChart, CanonicalProblemsChart } from "../charts/canonicalAnalysisChart.js";

const indexationProvider = new Provider("indexation", "/api/indexation");
const trendProvider = new Provider("indexStatusTrend", "/api/index-status-trend");
const canonicalProvider = new Provider("canonicalAnalysis", "/api/canonical-analysis");

const sum = (list, key) => list.reduce((a, x) => a + x[key], 0);

// Whose visits the cards read. `group` is the endpoints' ?group= (lib/sql.js
// BOT_GROUP_SQL); `who` names the bot whose visits measure the demand on a
// page; `ai` is false when the AI user fetches are out of the scope.
const ALL_BOTS = { group: "all", who: "Googlebot", bots: "bots", ai: true };

const summaryCards = (scope) => (d) => {
  const indexable = d.buckets.find((b) => b.key === "indexable") ?? { pages: 0, before: 0 };
  const notIndexable = d.totals.pages - indexable.pages;
  const notBefore = d.totals.before - indexable.before;
  const prev = (v) => (d.partial ? null : v);
  const lost = d.moves.filter((m) => m.direction === "worse");
  const regained = d.moves.filter((m) => m.direction === "better");
  return [
    {
      label: "Indexable",
      value: fmtInt(indexable.pages),
      delta: deltaEl(indexable.pages, prev(indexable.before), { kind: "abs" }),
      foot: `${fmtPct1(d.totals.pages ? (indexable.pages / d.totals.pages) * 100 : 0)} of ${fmtInt(d.totals.pages)} pages ${scope.bots} fetched`,
    },
    {
      label: "Not indexable",
      value: fmtInt(notIndexable),
      delta: deltaEl(notIndexable, prev(notBefore), { kind: "abs", good: "down" }),
      foot: "noindex, canonicalized or not 200",
    },
    {
      label: "Lost indexability",
      value: fmtInt(sum(lost, "pages")),
      foot: `${fmtInt(sum(lost, "visits"))} ${scope.who} visits on them`,
    },
    {
      label: "Regained",
      value: fmtInt(sum(regained, "pages")),
      foot: "became indexable this period",
    },
  ];
};

// --- Verdicts day by day ----------------------------------------------------

const windowName = (days) => (days === 1 ? "24 hours" : `${days} days`);

// Change events of the fields that decide a verdict: the status code, then a
// noindex, then the canonical (lib/sql.js PAGE_BUCKET_SQL).
const verdictChanges = changeMarkers(["status", "meta_robots", "canonical"]);

// Each bar counts the pages fetched in a window as long as the period, so the
// last bar is the Indexability table. While the record is younger than the
// window, the bars count fewer days of visits and read low.
const trendSubtitle = (scope) => (d) => {
  const parts = [`pages ${scope.bots} fetched in the ${windowName(d.days)} up to each day, each by its newest visit`];
  if (d.complete_from === null) parts.push("recording started inside that window, so the bars count fewer days");
  if (verdictChanges(d).length) parts.push("dashed lines mark changes to status codes, robots tags and canonicals");
  return parts.join("; ");
};

// The marker says the bars before it count fewer days, so it only shows when
// there are such bars: not when the first bar's window is already recorded in
// full (a custom period that starts at 00:00 UTC has complete_from on it).
function windowMarkers(d) {
  if (d.complete_from === null || !d.rows.length) return [];
  const first = d.rows.reduce((min, r) => Math.min(min, r.t), Infinity);
  return d.complete_from > first ? [{ t: d.complete_from, text: `${windowName(d.days)} recorded from here` }] : [];
}

const trendMarkers = (d) => [...windowMarkers(d), ...verdictChanges(d)];

// --- One row per verdict ----------------------------------------------------

class BucketsChart extends Chart {
  constructor(el, provider, scope) {
    super(el, provider);
    this.scope = scope;
  }

  render(d) {
    const { who, ai } = this.scope;
    const total = d.totals.pages || 1;
    const table = dataTable(
      [
        {
          label: "Verdict",
          nowrap: true,
          render: (b) => h("span", { className: "inline-dot" }, h("span", { className: "bot-legend-dot", style: { background: cssVar(BUCKETS[b.key].token) } }), b.label),
        },
        { label: "Share", num: true, render: (b) => fmtPct1((b.pages / total) * 100) },
        { label: "Pages", num: true, render: (b) => fmtInt(b.pages) },
        {
          label: "Change",
          num: true,
          render: (b) =>
            d.partial
              ? h("span", { className: "muted", text: "-" })
              : h(
                  "span",
                  { className: "change-pair" },
                  h("span", { className: b.entered ? (b.key === "indexable" ? "diff-add" : "diff-del") : "muted", text: `+${fmtInt(b.entered)}` }),
                  h("span", { className: b.left ? (b.key === "indexable" ? "diff-del" : "diff-add") : "muted", text: `-${fmtInt(b.left)}` })
                ),
        },
        { label: ai ? who : `${who} visits`, num: true, render: (b) => fmtInt(b.visits) },
        ai ? { label: "AI fetches", num: true, render: (b) => fmtInt(b.ai_user) } : null,
      ].filter(Boolean),
      d.buckets
    );
    const foot = d.partial
      ? null
      : h(
          "div",
          { className: "card-footer" },
          `${fmtInt(d.totals.discovered)} pages newly fetched this period · ${fmtInt(d.totals.not_refetched)} from the previous period not fetched again`
        );
    const subtitle = ai ? "one verdict per page, from its newest visit" : `one verdict per page, from its newest ${who} visit`;
    this.el.replaceChildren(card({ title: "Indexability", subtitle, flush: true }, table, foot));
  }
}

// The Indexation cards, appended to `outlet` and added to `dashboard`, for
// every bot (Evergreen Crawl > Indexation) or for one (`scope`, as ALL_BOTS:
// Log Analyzer > Googlebot > Indexability).
export function indexationCards(outlet, dashboard, scope = ALL_BOTS) {
  const summary = h("div");
  const moves = h("div");
  const buckets = h("div");
  const trend = h("div", { className: "section" });
  const canonical = h("div");
  const targets = h("div");
  const problems = h("div", { className: "section" });
  outlet.append(summary, h("div", { className: "grid-2" }, moves, buckets), trend, h("div", { className: "chart-pair" }, canonical, targets), problems);

  const who = scope.ai ? null : scope.who;
  const charts = [
    new StatCardsChart(summary, indexationProvider, summaryCards(scope)),
    new MovesChart(moves, indexationProvider, {
      badge: bucketBadge,
      empty: `No page changed its verdict: every page ${scope.bots} fetched in both periods got the same verdict.`,
      who: scope.who,
      ai: scope.ai,
    }),
    new BucketsChart(buckets, indexationProvider, scope),
    withChangeEvents(
      new TimeSeriesChart(trend, trendProvider, {
        title: "Indexability over time",
        subtitle: trendSubtitle(scope),
        token: (key) => BUCKETS[key].token,
        type: "bar",
        markers: trendMarkers,
        hideEmpty: true,
        empty: "No page was fetched in this period.",
      })
    ),
    new CanonicalSummaryChart(canonical, canonicalProvider),
    new CanonicalTargetsChart(targets, canonicalProvider, { who }),
    new CanonicalProblemsChart(problems, canonicalProvider, { who: scope.who }),
  ];
  for (const chart of charts) {
    if (scope.group !== "all") chart.params = { ...chart.params, group: scope.group };
    dashboard.add(chart);
  }
}

export function renderIndexation(outlet) {
  outlet.append(
    reportHeader({
      title: "Indexation",
      subtitle: "Can search engines index the pages bots fetched? Judged from the page each bot received.",
    })
  );

  const dashboard = new Dashboard(globalRange);
  indexationCards(outlet, dashboard);
  dashboard.start();

  return () => dashboard.destroy();
}
