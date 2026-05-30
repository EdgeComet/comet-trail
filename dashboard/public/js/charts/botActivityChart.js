import { Chart } from "../core/chart.js";
import { cssVar } from "../core/ui.js";
import { bucketEdges, xTickFormat } from "../core/bucketing.js";

// Bot Activity — a multi-series spline of crawl volume per bot over time, with a
// clickable top legend and a per-series summary footer. Fed by BotActivityProvider
// (/api/bot-activity), which returns { granularity, rows: [{ t, series, c }] }.
//
// The six series are fixed and in display order; this single list drives the
// columns, colors, legend, and footer so they can never drift out of sync.
const SERIES = [
  { key: "Googlebot", token: "--bot-googlebot" },
  { key: "Bingbot", token: "--bot-bingbot" },
  { key: "GPTBot", token: "--bot-gptbot" },
  { key: "ClaudeBot", token: "--bot-claudebot" },
  { key: "Perplexity", token: "--bot-perplexity" },
  { key: "Other", token: "--bot-other" },
];

const fmtInt = (n) => Number(n).toLocaleString();
const fmtShare = (n) => `${n.toFixed(1)}%`;
const fmtY = (v) => (v >= 1000 ? `${v / 1000}K` : `${v}`);

export class BotActivityChart extends Chart {
  constructor(el, provider) {
    super(el, provider);
    this._bb = null;
    // Series the user toggled off. Persisted on the instance so a hidden series
    // stays hidden across range switches (each switch rebuilds the whole card).
    this._hidden = new Set();
  }

  // Capture the active range so render() can build the full bucket timeline,
  // including trailing empty buckets the data doesn't cover (the flat-zero tail).
  load(from, to) {
    this._range = { from, to };
    return super.load(from, to);
  }

  // Base load() swaps in a spinner (or an error) on every load, wiping the chart
  // DOM. Destroy the billboard instance first so it can't leak d3 listeners — this
  // runs on the error path too, where render() never gets a chance to clean up.
  showLoading() {
    this._destroyChart();
    super.showLoading();
  }

  // Router teardown hook (called via Dashboard.destroy when the view unmounts):
  // drop the billboard instance so its window-resize listener doesn't outlive
  // the navigated-away page. super.destroy() invalidates any in-flight load so a
  // late-resolving fetch can't generate a new chart into the detached DOM.
  destroy() {
    super.destroy();
    this._destroyChart();
  }

  _destroyChart() {
    if (this._bb) {
      this._bb.destroy();
      this._bb = null;
    }
  }

  // Card shell shared by the chart and the empty state: a titled card with an
  // empty body the caller fills. Returns both so the caller can append into body.
  _cardShell() {
    const card = document.createElement("div");
    card.className = "card";

    const header = document.createElement("div");
    header.className = "card-header card-header-lg";
    const title = document.createElement("h3");
    title.className = "card-title-lg";
    title.textContent = "Bot Activity";
    header.appendChild(title);

    const body = document.createElement("div");
    body.className = "card-body card-body-lg";

    card.append(header, body);
    return { card, body };
  }

  render({ granularity, rows }) {
    this._destroyChart();

    // No data is not an error (a quiet range is normal) — show a neutral message,
    // not the red failure state the base Chart.showError reserves for real errors.
    if (!rows.length) {
      const { card, body } = this._cardShell();
      const msg = document.createElement("p");
      msg.className = "bot-empty";
      msg.textContent = "No bot activity in this range.";
      body.appendChild(msg);
      this.el.replaceChildren(card);
      return;
    }

    // Ordered x timeline + a value index so rows can be placed by bucket-start.
    const edges = bucketEdges(this._range, granularity);
    const slot = new Map(edges.map((t, i) => [t, i]));

    // Pivot into one zero-filled count array per series — ALWAYS all six, even if
    // a series is absent from rows, or its legend toggle would throw and its
    // footer card would vanish.
    const counts = new Map(SERIES.map((s) => [s.key, new Array(edges.length).fill(0)]));
    for (const { t, series, c } of rows) {
      const arr = counts.get(series);
      const i = slot.get(t);
      if (arr && i !== undefined) arr[i] = c;
    }

    // Card scaffold: header, then legend, chart mount, footer in the body.
    const { card, body } = this._cardShell();

    const totals = new Map(SERIES.map((s) => [s.key, sum(counts.get(s.key))]));
    const grandTotal = [...totals.values()].reduce((a, b) => a + b, 0);

    const legend = this._buildLegend();
    const mount = document.createElement("div");
    const footer = this._buildFooter(totals, grandTotal);

    body.append(legend, mount, footer);
    this.el.replaceChildren(card);

    // Render the spline. localtime:false keeps the UTC buckets and their labels
    // aligned; xTickFormat adds the hour for hourly granularity so ticks/tooltip
    // aren't ambiguous; order:null preserves the fixed SERIES order in the tooltip.
    const colors = Object.fromEntries(SERIES.map((s) => [s.key, cssVar(s.token)]));
    this._bb = bb.generate({
      bindto: mount,
      data: {
        x: "x",
        type: "spline",
        order: null,
        columns: [
          ["x", ...edges],
          ...SERIES.map((s) => [s.key, ...counts.get(s.key)]),
        ],
        colors,
      },
      axis: {
        x: {
          type: "timeseries",
          localtime: false,
          tick: { format: xTickFormat(granularity), count: 6, fit: true },
        },
        y: { tick: { format: fmtY }, min: 0, padding: { bottom: 0 } },
      },
      point: { r: 2, focus: { only: true } },
      legend: { show: false },
      size: { height: 300 },
    });

    // Re-apply any series the user had toggled off before this reload.
    for (const key of this._hidden) this._bb.hide(key);
  }

  // Custom top legend: a colored dot + label per series. Clicking toggles the
  // series on the chart and records the choice in this._hidden.
  _buildLegend() {
    const legend = document.createElement("div");
    legend.className = "bot-legend";
    legend.setAttribute("role", "group");
    legend.setAttribute("aria-label", "Toggle bot series");

    for (const s of SERIES) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "bot-legend-item";
      item.classList.toggle("is-off", this._hidden.has(s.key));
      item.setAttribute("aria-pressed", String(!this._hidden.has(s.key)));

      const dot = document.createElement("span");
      dot.className = "bot-legend-dot";
      dot.style.background = cssVar(s.token);

      const label = document.createElement("span");
      label.textContent = s.key;

      item.append(dot, label);
      item.addEventListener("click", () => {
        const off = !this._hidden.has(s.key);
        if (off) this._hidden.add(s.key);
        else this._hidden.delete(s.key);
        item.classList.toggle("is-off", off);
        item.setAttribute("aria-pressed", String(!off));
        this._bb.toggle(s.key);
      });

      legend.appendChild(item);
    }
    return legend;
  }

  // Per-series summary: total requests and share of all bot traffic. Share is
  // guarded against a zero grand total (shouldn't happen once rows is non-empty,
  // but keeps the math safe). All six always shown, so an absent series reads 0.
  _buildFooter(totals, grandTotal) {
    const footer = document.createElement("div");
    footer.className = "bot-summary";

    for (const s of SERIES) {
      const total = totals.get(s.key);
      const share = grandTotal ? (total / grandTotal) * 100 : 0;

      const card = document.createElement("div");
      card.className = "bot-summary-card";
      card.style.borderLeftColor = cssVar(s.token);

      const label = document.createElement("div");
      label.className = "bot-summary-label";
      const dot = document.createElement("span");
      dot.className = "bot-legend-dot";
      dot.style.background = cssVar(s.token);
      const name = document.createElement("span");
      name.textContent = s.key;
      label.append(dot, name);

      const row = document.createElement("div");
      row.className = "bot-summary-value-row";
      const value = document.createElement("span");
      value.className = "bot-summary-value";
      value.textContent = fmtInt(total);
      const shareEl = document.createElement("span");
      shareEl.className = "bot-summary-share";
      shareEl.textContent = fmtShare(share);
      row.append(value, shareEl);

      card.append(label, row);
      footer.appendChild(card);
    }
    return footer;
  }
}

function sum(arr) {
  let total = 0;
  for (const n of arr) total += n;
  return total;
}
