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
import { h, card, cssVar, dataTable, emptyMessage, bucketBadge, urlCell, deltaEl, fmtInt, fmtPct1, BUCKETS } from "../core/ui.js";
import { StatCardsChart } from "../charts/statCardsChart.js";
import { IndexStatusTrendProvider } from "../providers/indexStatusTrendProvider.js";
import { IndexStatusTrendChart } from "../charts/indexStatusTrendChart.js";
import { CanonicalAnalysisProvider } from "../providers/canonicalAnalysisProvider.js";
import { CanonicalAnalysisChart } from "../charts/canonicalAnalysisChart.js";

const indexationProvider = new Provider("indexation", "/api/indexation");
const trendProvider = new IndexStatusTrendProvider();
const canonicalProvider = new CanonicalAnalysisProvider();

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
      foot: "noindex, canonical elsewhere, redirect or error",
    },
    {
      label: "Lost indexability",
      value: fmtInt(sum(lost, "pages")),
      foot: `since the previous period · ${fmtInt(sum(lost, "googlebot"))} Googlebot visits on them`,
    },
    {
      label: "Regained",
      value: fmtInt(sum(regained, "pages")),
      foot: "became indexable since the previous period",
    },
  ];
}

// --- Changed since the previous period ------------------------------------

// Shown before "Show all": the worst losses, then the recoveries, as the
// product's "Changed since last crawl" card does.
const TOP_WORSE = 5;
const TOP_BETTER = 3;

class MovesChart extends Chart {
  constructor(el, provider) {
    super(el, provider);
    this.open = new Set(); // "from>to" keys of expanded moves
    this.showAll = false;
  }

  render(d) {
    this.data = d;
    const title = "Changed since the previous period";
    if (!d.moves.length) {
      this.el.replaceChildren(
        card({ title }, emptyMessage("No page changed its verdict: every page bots fetched in both periods got the same verdict."))
      );
      return;
    }
    const worse = d.moves.filter((m) => m.direction === "worse");
    const better = d.moves.filter((m) => m.direction === "better");
    const shown = this.showAll ? d.moves : [...worse.slice(0, TOP_WORSE), ...better.slice(0, TOP_BETTER)];
    const hidden = d.moves.length - shown.length;
    const list = h(
      "div",
      { className: "moves" },
      shown.map((m) => {
        const key = `${m.from}>${m.to}`;
        const isOpen = this.open.has(key);
        const head = h(
          "button",
          {
            type: "button",
            className: `move move-${m.direction}${isOpen ? " is-open" : ""}`,
            "aria-expanded": String(isOpen),
            on: {
              click: () => {
                if (isOpen) this.open.delete(key);
                else this.open.add(key);
                this.render(this.data);
              },
            },
          },
          h("span", { className: "move-dir", text: m.direction === "worse" ? "↓" : m.direction === "better" ? "↑" : "→" }),
          h("span", { className: "move-path" }, bucketBadge(m.from), h("span", { className: "move-arrow", text: "→" }), bucketBadge(m.to)),
          h("span", { className: "move-pages", text: `${fmtInt(m.pages)} page${m.pages === 1 ? "" : "s"}` }),
          h("span", { className: "move-demand", text: `${fmtInt(m.googlebot)} Googlebot visits · ${fmtInt(m.ai_user)} AI user fetches` })
        );
        const sample = isOpen
          ? h(
              "div",
              { className: "move-sample" },
              m.sample.map((u) => urlCell(u)),
              m.pages > m.sample.length ? h("div", { className: "diff-note", text: `and ${fmtInt(m.pages - m.sample.length)} more` }) : null
            )
          : null;
        return h("div", {}, head, sample);
      }),
      hidden > 0 || this.showAll
        ? h(
            "button",
            {
              type: "button",
              className: "btn btn-ghost btn-sm moves-more",
              on: { click: () => { this.showAll = !this.showAll; this.render(this.data); } },
            },
            this.showAll ? "Show fewer" : `Show all ${d.moves.length} moves`
          )
        : null
    );
    const sub = d.partial ? "the previous period is only partly recorded" : "worst first, with the demand on those pages now";
    this.el.replaceChildren(card({ title, subtitle: sub }, list));
  }
}

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
  outlet.append(summary, h("div", { className: "grid-2" }, moves, buckets), trend, h("div", { className: "chart-pair" }, canonical));

  const dashboard = new Dashboard(globalRange);
  dashboard.add(new StatCardsChart(summary, indexationProvider, summaryCards));
  dashboard.add(new MovesChart(moves, indexationProvider));
  dashboard.add(new BucketsChart(buckets, indexationProvider));
  dashboard.add(new IndexStatusTrendChart(trend, trendProvider));
  dashboard.add(new CanonicalAnalysisChart(canonical, canonicalProvider));
  dashboard.start();

  return () => dashboard.destroy();
}
