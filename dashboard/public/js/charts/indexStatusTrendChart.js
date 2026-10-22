import { Chart } from "../core/chart.js";
import { cssVar } from "../core/ui.js";
import { bucketEdges, xAxisTicks, tooltipTitle } from "../core/bucketing.js";

// Index Status Trend — a 100% stacked daily bar chart splitting each day's pages
// into the four index_status outcomes, with a clickable top legend. Fed by
// IndexStatusTrendProvider (/api/index-status-trend), which returns
// { granularity: "day", rows: [{ t, series, c }] } where series is the raw
// index_status enum and the counts are per-URL-latest within the day.
//
// The four series are fixed and in display order; this single list drives the
// columns, colors, legend, and stacking so they can never drift out of sync.
// `key` is the raw index_status value the backend emits; `label` is what the UI
// shows. index_status is never NULL, so the four always partition each bar to 100%.
const SERIES = [
  { key: "indexable",       label: "Indexable",     token: "--idx-indexable" },
  { key: "non_200",         label: "Non-200",       token: "--idx-4xx" },
  { key: "blocked_by_meta", label: "Blocked",       token: "--idx-noindex" },
  { key: "non_canonical",   label: "Non-canonical", token: "--idx-canonical" },
];

const TITLE = "Index Status Trend";

export class IndexStatusTrendChart extends Chart {
  constructor(el, provider) {
    super(el, provider);
    this._bb = null;
    // Series the user toggled off. Persisted on the instance so a hidden series
    // stays hidden across range switches (each switch rebuilds the whole card).
    this._hidden = new Set();
  }

  // Capture the active range so render() can build the full bucket timeline,
  // including trailing empty buckets the data doesn't cover.
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
  // drop the billboard instance so its window-resize listener doesn't outlive the
  // navigated-away page. super.destroy() invalidates any in-flight load so a
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
    header.className = "card-header";
    const title = document.createElement("h3");
    title.className = "card-title";
    title.textContent = TITLE;
    header.appendChild(title);

    const body = document.createElement("div");
    body.className = "card-body";

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
      msg.textContent = "No indexation data in this range.";
      body.appendChild(msg);
      this.el.replaceChildren(card);
      return;
    }

    // Ordered x timeline + a value index so rows can be placed by bucket-start.
    const edges = bucketEdges(this._range, granularity);
    const slot = new Map(edges.map((t, i) => [t, i]));

    // Pivot into one count array per series — ALWAYS all four, even if a series is
    // absent from rows, so the legend toggle and stacking can't throw. A bucket
    // that received NO rows stays null across every series (not 0): under a
    // normalized stack a 0/0 bucket would be undefined, so leaving it null makes
    // billboard skip that x slot cleanly (empty axis past the last day with data).
    const counts = new Map(SERIES.map((s) => [s.key, new Array(edges.length).fill(null)]));
    for (const { t, series, c } of rows) {
      const i = slot.get(t);
      if (i === undefined) continue;
      // First row landing in this bucket flips its whole column from null to 0 so
      // present-but-absent series read 0 (a real share) while empty days stay null.
      for (const s of SERIES) {
        const arr = counts.get(s.key);
        if (arr[i] === null) arr[i] = 0;
      }
      const arr = counts.get(series);
      if (arr) arr[i] += c;
    }

    // Card scaffold: header, then legend and chart mount in the body.
    const { card, body } = this._cardShell();
    const legend = this._buildLegend();
    const mount = document.createElement("div");
    body.append(legend, mount);
    this.el.replaceChildren(card);

    // Render the 100% stacked bars. localtime:false keeps the UTC day buckets and
    // their labels aligned; groups+stack.normalize stacks the four series to 100%;
    // data.names maps raw keys to display labels in the tooltip; order:null
    // preserves the fixed SERIES order.
    const colors = Object.fromEntries(SERIES.map((s) => [s.key, cssVar(s.token)]));
    const names = Object.fromEntries(SERIES.map((s) => [s.key, s.label]));
    this._bb = bb.generate({
      bindto: mount,
      data: {
        x: "x",
        type: "bar",
        order: null,
        groups: [SERIES.map((s) => s.key)],
        stack: { normalize: true },
        columns: [
          ["x", ...edges],
          ...SERIES.map((s) => [s.key, ...counts.get(s.key)]),
        ],
        colors,
        names,
      },
      axis: {
        x: {
          type: "timeseries",
          localtime: false,
          tick: xAxisTicks(edges, granularity),
        },
        y: { tick: { format: (v) => `${v}%` }, min: 0, padding: { bottom: 0 } },
      },
      legend: { show: false },
      tooltip: { format: { title: tooltipTitle(granularity) } },
      size: { height: 300 },
    });

    // Re-apply any series the user had toggled off before this reload.
    for (const key of this._hidden) this._bb.hide(key);
  }

  // Custom top legend: a colored dot + label per series. Clicking toggles the
  // series on the chart and records the choice in this._hidden. Display uses the
  // human label; the toggle keys off the raw index_status (s.key).
  _buildLegend() {
    const legend = document.createElement("div");
    legend.className = "bot-legend";
    legend.setAttribute("role", "group");
    legend.setAttribute("aria-label", "Toggle index status series");

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
      label.textContent = s.label;

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
}
