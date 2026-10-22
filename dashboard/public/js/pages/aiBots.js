// Log Analyzer > AI Bots - why AI bots came, what they read, and how that
// compares with Googlebot.
//
// AI bots come for three reasons (shared/bots.js PURPOSES): to fetch a page
// live while a person asks an assistant, to build an AI search index, or to
// collect training data. User fetches are the closest thing to AI traffic a
// log can show; training crawls are collection, not visits from people.
import { globalRange } from "../core/dateRange.js";
import { Dashboard } from "../core/registry.js";
import { Chart } from "../core/chart.js";
import { Provider, BucketedProvider, derive } from "../core/provider.js";
import { reportHeader } from "../core/report.js";
import { h, card, cssVar, dataTable, emptyMessage, statusBadge, urlCell, deltaEl, fmtInt, fmtCompact, fmtPct1, fmtAgo, fmtDateTime } from "../core/ui.js";
import { StatCardsChart } from "../charts/statCardsChart.js";
import { TimeSeriesChart } from "../charts/timeSeriesChart.js";
import { TableChart } from "../charts/tableChart.js";

const summaryProvider = new Provider("aiSummary", "/api/ai/summary");
const trendProvider = new BucketedProvider("aiTrend", "/api/ai/trend");
const breakdownProvider = new Provider("aiBreakdown", "/api/ai/breakdown");
const pagesProvider = new Provider("aiPages", "/api/ai/pages");

const GROUP_TOKENS = {
  googlebot: "--bot-googlebot",
  training: "--purpose-training",
  search: "--purpose-search",
  user: "--purpose-user",
};

const GROUP_NOTES = {
  googlebot: "Google's search crawler",
  training: "collecting model training data",
  search: "building AI search indexes",
  user: "fetched live for a person",
};

const pct = (part, whole) => (whole ? (part / whole) * 100 : 0);
const big = (n) => (n >= 100000 ? fmtCompact(n) : fmtInt(n));

function summaryCards({ current: c, previous: p }) {
  const share = pct(c.ai_total, c.total);
  const prevShare = p ? pct(p.ai_total, p.total) : null;
  return [
    {
      label: "AI user fetches",
      value: big(c.ai_user),
      delta: deltaEl(c.ai_user, p?.ai_user),
      foot: `${fmtPct1(pct(c.ai_user, c.ai_total))} of AI bot traffic`,
    },
    {
      label: "AI share of crawl",
      value: fmtPct1(share),
      delta: deltaEl(share, prevShare, { kind: "pp", good: "neutral" }),
      foot: `${big(c.ai_total)} of ${big(c.total)} bot requests`,
    },
    {
      label: "Pages read by AI",
      value: big(c.ai_urls),
      delta: deltaEl(c.ai_urls, p?.ai_urls),
      foot: `${fmtPct1(pct(c.ai_urls, c.all_urls))} of all URLs bots fetched`,
      href: "/pages",
    },
    {
      label: "AI 404s",
      value: big(c.ai_404),
      delta: deltaEl(c.ai_404, p?.ai_404, { good: "down" }),
      foot: `assistants hit ${fmtInt(c.ai_404_urls)} missing URLs`,
    },
  ];
}

// --- Why each AI came: requests per purpose, per provider ---------------------

const PURPOSE_ORDER = ["user", "search", "training"];
const PURPOSE_LABELS = { user: "User fetches", search: "AI search", training: "Training" };

class ProvidersChart extends Chart {
  render(d) {
    const title = "Why each AI came";
    if (!d.providers.length) {
      this.el.replaceChildren(card({ title }, emptyMessage("No AI bot visited in this period.")));
      return;
    }
    const max = Math.max(...d.providers.map((p) => p.user + p.search + p.training));
    const legend = h(
      "div",
      { className: "bot-legend" },
      PURPOSE_ORDER.map((k) =>
        h("span", { className: "bot-legend-item", style: { cursor: "default" } }, h("span", { className: "bot-legend-dot", style: { background: cssVar(`--purpose-${k}`) } }), PURPOSE_LABELS[k])
      )
    );
    const rows = d.providers.map((p) => {
      const total = p.user + p.search + p.training;
      const bar = h(
        "div",
        { className: "stack-bar", style: { width: `${Math.max(2, (total / max) * 100)}%` } },
        PURPOSE_ORDER.filter((k) => p[k]).map((k) =>
          h("span", {
            className: "stack-seg",
            style: { flexGrow: String(p[k]), background: cssVar(`--purpose-${k}`) },
            title: `${PURPOSE_LABELS[k]}: ${fmtInt(p[k])}`,
          })
        )
      );
      return h(
        "div",
        { className: "stack-row" },
        h("div", { className: "stack-label", text: p.label }),
        h("div", { className: "stack-track" }, bar),
        h("div", { className: "stack-value", text: fmtInt(total) }),
        h(
          "div",
          { className: "stack-meta" },
          PURPOSE_ORDER.map((k) => h("span", {}, `${PURPOSE_LABELS[k]} ${fmtInt(p[k])}`))
        )
      );
    });
    this.el.replaceChildren(card({ title, subtitle: "requests by purpose" }, legend, h("div", { className: "stack-list" }, rows)));
  }
}

// --- Where each kind of bot reads: share of its requests per section ----------

class SectionsChart extends Chart {
  render(d) {
    const title = "Where each bot reads";
    if (!d.sections.length) {
      this.el.replaceChildren(card({ title }, emptyMessage("No search or AI bot visits in this period.")));
      return;
    }
    const groups = ["googlebot", "training", "search", "user"];
    const totals = Object.fromEntries(groups.map((g) => [g, d.sections.reduce((a, s) => a + s[g], 0)]));
    const cell = (s, g) => {
      const share = pct(s[g], totals[g]);
      return h(
        "div",
        { className: "heat", title: `${fmtInt(s[g])} requests` },
        h("span", { className: "heat-fill", style: { width: `${share}%`, background: cssVar(GROUP_TOKENS[g]) } }),
        h("span", { className: "heat-value", text: s[g] ? fmtPct1(share) : "-" })
      );
    };
    const table = dataTable(
      [
        { label: "Section", nowrap: true, render: (s) => h("span", { className: "mono", text: s.section }) },
        { label: "Googlebot", render: (s) => cell(s, "googlebot") },
        { label: "Training", render: (s) => cell(s, "training") },
        { label: "AI search", render: (s) => cell(s, "search") },
        { label: "User fetches", render: (s) => cell(s, "user") },
      ],
      d.sections
    );
    this.el.replaceChildren(card({ title, subtitle: "share of each group's requests by section", flush: true }, table));
  }
}

// Fetches per assistant family, as small colored counts.
function assistants(r) {
  const parts = [
    ["chatgpt", "ChatGPT"],
    ["claude", "Claude"],
    ["perplexity", "Perplexity"],
    ["other", "Other"],
  ].filter(([k]) => r[k] > 0);
  return h(
    "span",
    { className: "assistants" },
    parts.map(([k, label]) =>
      h("span", { className: "inline-dot", title: label }, h("span", { className: "bot-legend-dot", style: { background: cssVar(k === "other" ? "--bot-other" : `--bot-${k}`) } }), fmtInt(r[k]))
    )
  );
}

export function renderAiBots(outlet) {
  outlet.append(
    reportHeader({
      title: "AI Bots",
      subtitle: "Why AI bots came, what they read, and how that compares with Googlebot.",
    })
  );

  const summary = h("div");
  const trend = h("div", { className: "section" });
  const providers = h("div");
  const missing = h("div");
  const sections = h("div", { className: "section" });
  const top = h("div", { className: "section" });
  outlet.append(summary, trend, h("div", { className: "grid-2" }, providers, missing), sections, top);

  const dashboard = new Dashboard(globalRange);
  dashboard.add(new StatCardsChart(summary, summaryProvider, summaryCards));
  dashboard.add(
    new TimeSeriesChart(trend, trendProvider, {
      title: "AI bots vs Googlebot",
      subtitle: "requests by purpose",
      token: (key) => GROUP_TOKENS[key],
      summary: true,
      describe: (key) => GROUP_NOTES[key],
      empty: "No Googlebot or AI bot visits in this period.",
    })
  );
  dashboard.add(new ProvidersChart(providers, breakdownProvider));
  dashboard.add(new SectionsChart(sections, breakdownProvider));
  dashboard.add(
    new TableChart(top, derive(pagesProvider, (d) => ({ rows: d.top })), {
      title: "Pages AI assistants opened for people",
      subtitle: "AI user fetches",
      empty: "No AI assistant fetched a page for a person in this period.",
      columns: [
        { label: "Page", render: (r) => urlCell(r.url, r.title ?? "(no title)") },
        { label: "Fetches", num: true, render: (r) => fmtInt(r.fetches) },
        { label: "By", nowrap: true, render: assistants },
        { label: "Status", render: (r) => statusBadge(r.status) },
      ],
    })
  );
  dashboard.add(
    new TableChart(missing, derive(pagesProvider, (d) => ({ rows: d.missing })), {
      title: "Missing pages assistants tried to open",
      subtitle: "AI user fetches answered 404",
      empty: "No AI assistant hit a missing page in this period.",
      columns: [
        { label: "Page", render: (r) => urlCell(r.url) },
        { label: "Fetches", num: true, render: (r) => fmtInt(r.fetches) },
        { label: "By", nowrap: true, render: assistants },
        { label: "Last", nowrap: true, render: (r) => h("span", { title: fmtDateTime(r.last_ts), text: fmtAgo(r.last_ts) }) },
      ],
    })
  );
  dashboard.start();

  return () => dashboard.destroy();
}
