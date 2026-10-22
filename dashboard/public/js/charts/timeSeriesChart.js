import { Chart } from "../core/chart.js";
import { h, card, cssVar, emptyMessage, fmtInt, deltaEl, niceTicks } from "../core/ui.js";
import { bucketEdges, xAxisTicks, tooltipTitle } from "../core/bucketing.js";

// A multi-series chart over time (lines or stacked bars) with a clickable top
// legend, an optional per-series summary footer, and optional change markers.
// The provider returns { granularity, series: [{ key, label }], rows: [{ t,
// series, c }], previous?: { [key]: count } }; empty buckets are absent and are
// zero-filled here.
//
// opts:
//   title, subtitle      card header
//   token(key)           CSS variable holding a series color
//   type                 "spline" (default) | "bar" (stacked)
//   summary              true: a footer card per series with total, share, change
//   describe(key)        optional footer caption per series
//   markers(data)        optional [{ t, text, cls }] dashed vertical lines
//   hideEmpty            drop series with no data in the period
//   height, empty
export class TimeSeriesChart extends Chart {
  constructor(el, provider, opts) {
    super(el, provider);
    this.opts = { type: "spline", summary: false, height: 300, empty: "No bot activity in this period.", ...opts };
    this._bb = null;
    // Series the user toggled off, kept across range switches.
    this._hidden = new Set();
  }

  // Capture the active range so render() can build the full bucket timeline,
  // including trailing empty buckets the data doesn't cover.
  load(from, to) {
    this._range = { from, to };
    return super.load(from, to);
  }

  // Base load() swaps in a spinner on every load, wiping the chart DOM. Destroy
  // the billboard instance first so it can't leak d3 listeners.
  showLoading() {
    this._destroyChart();
    super.showLoading();
  }

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

  render(data) {
    this._destroyChart();
    const { title, subtitle, token, type, summary, describe, markers, height, empty, hideEmpty } = this.opts;
    const present = new Set(data.rows.map((r) => r.series));
    const series = hideEmpty ? data.series.filter((s) => present.has(s.key)) : data.series;

    if (!data.rows.length) {
      this.el.replaceChildren(card({ title, subtitle }, emptyMessage(empty)));
      return;
    }

    const edges = bucketEdges(this._range, data.granularity);
    const slot = new Map(edges.map((t, i) => [t, i]));
    const counts = new Map(series.map((s) => [s.key, new Array(edges.length).fill(0)]));
    for (const { t, series: key, c } of data.rows) {
      const arr = counts.get(key);
      const i = slot.get(t);
      if (arr && i !== undefined) arr[i] = c;
    }

    const totals = new Map(series.map((s) => [s.key, counts.get(s.key).reduce((a, b) => a + b, 0)]));
    const grand = [...totals.values()].reduce((a, b) => a + b, 0);
    const colorOf = (key) => cssVar(token(key));

    const mount = h("div");
    const body = [this._legend(series, colorOf), mount];
    if (summary) body.push(this._summary(series, totals, grand, data.previous, colorOf, describe));
    this.el.replaceChildren(card({ title, subtitle }, ...body));

    const columns = [["x", ...edges], ...series.map((s) => [s.key, ...counts.get(s.key)])];
    // Highest point on the axis: the tallest stack for bars, the tallest line otherwise.
    const peak = type === "bar"
      ? Math.max(...edges.map((_, i) => series.reduce((a, s) => a + counts.get(s.key)[i], 0)))
      : Math.max(...series.map((s) => Math.max(...counts.get(s.key))));
    const yTicks = niceTicks(peak);
    const names = Object.fromEntries(series.map((s) => [s.key, s.label]));
    const lines = markers
      ? markers(data)
          .filter((m) => m.t >= this._range.from && m.t <= this._range.to)
          .map((m) => ({ value: m.t, text: m.text, class: m.cls ?? "" }))
      : [];

    this._bb = bb.generate({
      bindto: mount,
      data: {
        x: "x",
        type: type === "bar" ? "bar" : "spline",
        order: null,
        columns,
        names,
        colors: Object.fromEntries(series.map((s) => [s.key, colorOf(s.key)])),
        groups: type === "bar" ? [series.map((s) => s.key)] : [],
      },
      bar: { width: { ratio: 0.7 }, radius: { ratio: 0.15 } },
      axis: {
        x: {
          type: "timeseries",
          localtime: false,
          tick: xAxisTicks(edges, data.granularity),
        },
        y: {
          tick: { format: compactTick, values: yTicks, outer: false },
          min: 0,
          max: yTicks[yTicks.length - 1],
          padding: { top: 0, bottom: 0 },
        },
      },
      grid: { y: { show: true }, x: { lines } },
      point: { r: 0, focus: { only: true, expand: { r: 4 } } },
      line: { classes: [] },
      legend: { show: false },
      tooltip: { order: null, format: { title: tooltipTitle(data.granularity) } },
      size: { height },
      padding: { right: 16 },
      transition: { duration: 0 },
    });

    for (const key of this._hidden) this._bb.hide(key);
  }

  _legend(series, colorOf) {
    const legend = h("div", { className: "bot-legend", role: "group", "aria-label": "Toggle series" });
    for (const s of series) {
      const off = this._hidden.has(s.key);
      const item = h(
        "button",
        { type: "button", className: off ? "bot-legend-item is-off" : "bot-legend-item", "aria-pressed": String(!off) },
        h("span", { className: "bot-legend-dot", style: { background: colorOf(s.key) } }),
        h("span", { text: s.label })
      );
      item.addEventListener("click", () => {
        const nowOff = !this._hidden.has(s.key);
        if (nowOff) this._hidden.add(s.key);
        else this._hidden.delete(s.key);
        item.classList.toggle("is-off", nowOff);
        item.setAttribute("aria-pressed", String(!nowOff));
        this._bb.toggle(s.key);
      });
      legend.append(item);
    }
    return legend;
  }

  _summary(series, totals, grand, previous, colorOf, describe) {
    return h(
      "div",
      { className: "bot-summary" },
      series.map((s) => {
        const total = totals.get(s.key);
        const share = grand ? (total / grand) * 100 : 0;
        const prev = previous ? previous[s.key] ?? 0 : null;
        return h(
          "div",
          { className: "bot-summary-card", style: { borderLeftColor: colorOf(s.key) } },
          h(
            "div",
            { className: "bot-summary-label" },
            h("span", { className: "bot-legend-dot", style: { background: colorOf(s.key) } }),
            h("span", { text: s.label })
          ),
          h(
            "div",
            { className: "bot-summary-value-row" },
            h("span", { className: "bot-summary-value", text: fmtInt(total) }),
            h("span", { className: "bot-summary-share", text: `${share.toFixed(1)}%` })
          ),
          h("div", { className: "bot-summary-delta" }, deltaEl(total, prev)),
          describe ? h("div", { className: "stat-footnote", text: describe(s.key) }) : null
        );
      })
    );
  }
}

function compactTick(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, "")}K` : `${v}`;
}
