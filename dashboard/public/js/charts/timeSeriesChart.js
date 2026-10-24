import { Chart } from "../core/chart.js";
import { h, card, cssVar, emptyMessage, fmtInt, deltaEl, niceTicks } from "../core/ui.js";
import { bucketEdges, partialBucket, xAxisTicks, tooltipTitle } from "../core/bucketing.js";

// A multi-series chart over time (lines or stacked bars) with a clickable top
// legend, an optional per-series summary footer, and optional change markers.
// Lines are straight, point to point: smoothing dips below zero and invents
// peaks between buckets. When the period ends inside the last bucket, the line
// into it is dashed and its tooltip says "so far", so a day that is not over
// does not read as a drop.
// The provider returns { granularity, series: [{ key, label }], rows: [{ t,
// series, c }], previous?: { [key]: count } }; empty buckets are absent and are
// zero-filled here.
//
// opts:
//   title, subtitle      card header; subtitle may be a function of the data
//   token(key)           CSS variable holding a series color
//   type                 "line" (default) | "bar" (stacked)
//   summary              true: a footer card per series with total, share, change
//   describe(key)        optional footer caption per series
//   markers(data)        optional [{ t, text, cls }] dashed vertical lines, the
//                        most important first: a line whose label would
//                        print over an earlier one's is left out
//   hideEmpty            drop series with no data in the period
//   format(v)            the y axis and tooltip format; counts by default
//   y2                   { keys, format }: series drawn as bars against a second
//                        axis at the right, e.g. the requests under two lines of
//                        response times; `format` for its ticks. Its ticks split
//                        the height as the left axis does, so both read off the
//                        same grid lines
//   gaps                 true: a bucket without a row is a gap in its line, not
//                        a zero (a median of no requests has no value). Bars
//                        on y2 still count it as zero
//   height, empty
export class TimeSeriesChart extends Chart {
  constructor(el, provider, opts) {
    super(el, provider);
    this.opts = { type: "line", summary: false, height: 300, empty: "No bot activity in this period.", ...opts };
    this._bb = null;
    // Series the user toggled off, kept across range switches.
    this._hidden = new Set();
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
    this._data = data;
    this._destroyChart();
    const { title, token, type, summary, describe, markers, height, empty, hideEmpty, format, y2, gaps } = this.opts;
    const subtitle = typeof this.opts.subtitle === "function" ? this.opts.subtitle(data) : this.opts.subtitle;
    const actions = this.actions;
    const present = new Set(data.rows.map((r) => r.series));
    const series = hideEmpty ? data.series.filter((s) => present.has(s.key)) : data.series;

    if (!data.rows.length) {
      this.el.replaceChildren(card({ title, subtitle, actions }, emptyMessage(empty)));
      return;
    }

    const edges = bucketEdges(this.range, data.granularity);
    const slot = new Map(edges.map((t, i) => [t, i]));
    const onY2 = new Set(y2?.keys ?? []);
    const main = series.filter((s) => !onY2.has(s.key));
    const right = series.filter((s) => onY2.has(s.key));
    const counts = new Map(series.map((s) => [s.key, new Array(edges.length).fill(gaps && !onY2.has(s.key) ? null : 0)]));
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
    this.el.replaceChildren(card({ title, subtitle, actions }, ...body));

    const columns = [["x", ...edges], ...series.map((s) => [s.key, ...counts.get(s.key)])];
    // Highest point on the axis: the tallest stack for bars, the tallest line
    // otherwise, over the series the legend shows. One tall series (a p95 spike)
    // would flatten the rest, so hiding it rescales the axis.
    const shown = main.filter((s) => !this._hidden.has(s.key));
    const peak = type === "bar"
      ? Math.max(...edges.map((_, i) => shown.reduce((a, s) => a + counts.get(s.key)[i], 0)))
      : Math.max(...shown.map((s) => Math.max(...counts.get(s.key))));
    const yTicks = niceTicks(peak);
    // The right axis gets as many intervals as the left, on a round step.
    const intervals = yTicks.length - 1;
    const y2Step = right.length ? niceTicks(Math.max(...right.map((s) => Math.max(...counts.get(s.key)))), intervals)[1] : 0;
    const y2Ticks = Array.from({ length: intervals + 1 }, (_, i) => i * y2Step);
    const names = Object.fromEntries(series.map((s) => [s.key, s.label]));
    // The plot is about the mount's width less the y axis, and less the right
    // axis or the right padding below.
    const plotWidth = Math.max(1, mount.clientWidth - AXIS_PX - (right.length ? AXIS_PX : 16));
    const lines = markers ? this._markerLines(markers(data), edges, plotWidth) : [];
    // Lines only: the segment into a partial last bucket is dashed. Billboard
    // dashes a segment when its end point lies after a region's start.
    const partial = type === "bar" ? null : partialBucket(edges, this.range, data.granularity);
    const regions =
      partial !== null && edges.length > 1
        ? Object.fromEntries(main.map((s) => [s.key, [{ start: edges[edges.length - 2], style: { dasharray: "4 3" } }]]))
        : {};
    const fmtY = format ?? compactTick;
    const fmtY2 = y2?.format ?? compactTick;

    this._bb = bb.generate({
      bindto: mount,
      data: {
        x: "x",
        type: type === "bar" ? "bar" : "line",
        order: null,
        columns,
        names,
        regions,
        types: Object.fromEntries(right.map((s) => [s.key, "bar"])),
        axes: Object.fromEntries(right.map((s) => [s.key, "y2"])),
        colors: Object.fromEntries(series.map((s) => [s.key, colorOf(s.key)])),
        groups: type === "bar" ? [main.map((s) => s.key)] : [],
      },
      bar: { width: { ratio: 0.7 }, radius: { ratio: 0.15 } },
      axis: {
        x: {
          type: "timeseries",
          localtime: false,
          tick: xAxisTicks(edges, data.granularity, plotWidth),
        },
        y: {
          tick: { format: fmtY, values: yTicks, outer: false },
          min: 0,
          max: yTicks[yTicks.length - 1],
          padding: { top: 0, bottom: 0 },
        },
        y2: right.length
          ? {
              show: true,
              tick: { format: fmtY2, values: y2Ticks, outer: false },
              min: 0,
              max: y2Ticks[y2Ticks.length - 1],
              padding: { top: 0, bottom: 0 },
            }
          : { show: false },
      },
      grid: { y: { show: true }, x: { lines } },
      point: { r: 0, focus: { only: true, expand: { r: 4 } } },
      line: { classes: [] },
      legend: { show: false },
      tooltip: {
        order: null,
        format: {
          title: tooltipTitle(data.granularity, partial),
          value: (v, _ratio, id) => (onY2.has(id) ? fmtInt(v) : format ? format(v) : v),
        },
      },
      size: { height },
      // The right axis brings its own room for its labels.
      padding: right.length ? {} : { right: 16 },
      transition: { duration: 0 },
    });

    for (const key of this._hidden) this._bb.hide(key);
  }

  // Marker labels stand upright along their lines, so lines closer than
  // MARKER_GAP_PX print one label over the other: keep the first of them.
  _markerLines(list, edges, plotWidth) {
    const span = Math.max(1, edges[edges.length - 1] - edges[0]);
    const gap = (MARKER_GAP_PX / plotWidth) * span;
    const lines = [];
    for (const m of list) {
      if (m.t < this.range.from || m.t > this.range.to) continue;
      if (lines.some((l) => Math.abs(l.value - m.t) < gap)) continue;
      lines.push({ value: m.t, text: m.text, class: m.cls ?? "" });
    }
    return lines;
  }

  _legend(series, colorOf) {
    const legend = h("div", { className: "bot-legend", role: "group", "aria-label": "Toggle series" });
    series.forEach((s, i) => {
      const off = this._hidden.has(s.key);
      const item = h(
        "button",
        { type: "button", className: off ? "bot-legend-item is-off" : "bot-legend-item", "aria-pressed": String(!off) },
        h("span", { className: "bot-legend-dot", style: { background: colorOf(s.key) } }),
        h("span", { text: s.label })
      );
      // Draw again rather than toggle the series in place, so the y axis
      // fits what is left; the button keeps the focus.
      item.addEventListener("click", () => {
        if (this._hidden.has(s.key)) this._hidden.delete(s.key);
        else this._hidden.add(s.key);
        this.render(this._data);
        this.el.querySelectorAll(".bot-legend-item")[i]?.focus();
      });
      legend.append(item);
    });
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

// About the height of a marker label's line of text, with its halo.
const MARKER_GAP_PX = 16;
// About the width of a y axis with its tick labels ("1.2K", "800 ms").
const AXIS_PX = 50;

function compactTick(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, "")}K` : `${v}`;
}
