// Evergreen Crawl > Indexation - can bots index the pages they fetched, and
// what changed since the previous period?
//
// Every page gets one verdict, from the newest visit in the period, and is
// compared with its verdict in the period before: no crawl to schedule, no
// export to diff. Providers live at module scope so their in-memory cache
// survives navigating away and back.
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

function summaryCards(d) {
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
      foot: `${fmtPct1(d.totals.pages ? (indexable.pages / d.totals.pages) * 100 : 0)} of ${fmtInt(d.totals.pages)} pages bots fetched`,
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
      foot: `${fmtInt(sum(lost, "googlebot"))} Googlebot visits on them`,
    },
    {
      label: "Regained",
      value: fmtInt(sum(regained, "pages")),
      foot: "became indexable this period",
    },
  ];
}

// --- Verdicts day by day ----------------------------------------------------

const windowName = (days) => (days === 1 ? "24 hours" : `${days} days`);

// Change events of the fields that decide a verdict: the status code, then a
// noindex, then the canonical (lib/sql.js PAGE_BUCKET_SQL).
const verdictChanges = changeMarkers(["status", "meta_robots", "canonical"]);

// Each bar counts the pages fetched in a window as long as the period, so the
// last bar is the Indexability table. While the record is younger than the
// window, the bars count fewer days of visits and read low.
function trendSubtitle(d) {
  const parts = [`pages bots fetched in the ${windowName(d.days)} up to each day, each by its newest visit`];
  if (d.complete_from === null) parts.push("recording started inside that window, so the bars count fewer days");
  if (verdictChanges(d).length) parts.push("dashed lines mark changes to status codes, robots tags and canonicals");
  return parts.join("; ");
}

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
  render(d) {
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
        { label: "Googlebot", num: true, render: (b) => fmtInt(b.googlebot) },
        { label: "AI fetches", num: true, render: (b) => fmtInt(b.ai_user) },
      ],
      d.buckets
    );
    const foot = d.partial
      ? null
      : h(
          "div",
          { className: "card-footer" },
          `${fmtInt(d.totals.discovered)} pages newly fetched this period · ${fmtInt(d.totals.not_refetched)} from the previous period not fetched again`
        );
    this.el.replaceChildren(card({ title: "Indexability", subtitle: "one verdict per page, from its newest visit", flush: true }, table, foot));
  }
}

export function renderIndexation(outlet) {
  outlet.append(
    reportHeader({
      title: "Indexation",
      subtitle: "Can search engines index the pages bots fetched? Judged from the page each bot received.",
    })
  );

  const summary = h("div");
  const moves = h("div");
  const buckets = h("div");
  const trend = h("div", { className: "section" });
  const canonical = h("div");
  const targets = h("div");
  const problems = h("div", { className: "section" });
  outlet.append(summary, h("div", { className: "grid-2" }, moves, buckets), trend, h("div", { className: "chart-pair" }, canonical, targets), problems);

  const dashboard = new Dashboard(globalRange);
  dashboard.add(new StatCardsChart(summary, indexationProvider, summaryCards));
  dashboard.add(
    new MovesChart(moves, indexationProvider, {
      badge: bucketBadge,
      empty: "No page changed its verdict: every page bots fetched in both periods got the same verdict.",
    })
  );
  dashboard.add(new BucketsChart(buckets, indexationProvider));
  dashboard.add(
    withChangeEvents(
      new TimeSeriesChart(trend, trendProvider, {
        title: "Indexability over time",
        subtitle: trendSubtitle,
        token: (key) => BUCKETS[key].token,
        type: "bar",
        markers: trendMarkers,
        hideEmpty: true,
        empty: "No page was fetched in this period.",
      })
    )
  );
  dashboard.add(new CanonicalSummaryChart(canonical, canonicalProvider));
  dashboard.add(new CanonicalTargetsChart(targets, canonicalProvider));
  dashboard.add(new CanonicalProblemsChart(problems, canonicalProvider));
  dashboard.start();

  return () => dashboard.destroy();
}
