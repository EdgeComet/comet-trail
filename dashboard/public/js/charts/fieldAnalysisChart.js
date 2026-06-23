import { Chart } from "../core/chart.js";
import { titledCard, cssVar, emptyMessage } from "../core/ui.js";

// Shared renderer for the field-analysis cards (Title, Description, H1, ...): a
// titled card holding one proportional segmented bar over a legend grid. Built
// once here so each field is just a config (a title + an ordered segment list)
// fed to the generic FieldAnalysisChart below.
//
// `segments` is an ordered list of { label, token, pct, count }. Bar widths come
// from flex-grow = count, so the bar self-normalizes even when the categories
// overlap and the percentages sum past 100% (see the bucketing choice).
export function segmentBar(title, segments) {
  const body = document.createElement("div");

  // Proportional bar. Zero-count categories are dropped from the bar (no phantom
  // min-width nub) but still listed in the legend below.
  const bar = document.createElement("div");
  bar.className = "analysis-bar";
  for (const s of segments) {
    if (!s.count) continue;
    const seg = document.createElement("div");
    seg.className = "analysis-seg";
    seg.style.flexGrow = String(s.count);
    seg.style.background = cssVar(s.token);
    seg.title = `${s.label}: ${s.pct}% (${s.count.toLocaleString()} URLs)`;
    bar.appendChild(seg);
  }

  // Legend grid: colored dot + label, big color-matched percentage, URL count.
  const legend = document.createElement("div");
  legend.className = "analysis-legend";
  for (const s of segments) {
    const color = cssVar(s.token);
    const item = document.createElement("div");

    const label = document.createElement("div");
    label.className = "analysis-legend-label";
    const dot = document.createElement("span");
    dot.className = "analysis-legend-dot";
    dot.style.background = color;
    const text = document.createElement("span");
    text.textContent = s.label;
    label.append(dot, text);

    const pct = document.createElement("div");
    pct.className = "analysis-legend-pct";
    pct.style.color = color;
    pct.textContent = `${s.pct}%`;

    const count = document.createElement("div");
    count.className = "analysis-legend-count";
    count.textContent = `${s.count.toLocaleString()} URLs`;

    item.append(label, pct, count);
    legend.appendChild(item);
  }

  body.append(bar, legend);
  return titledCard(title, body);
}

// Generic field-analysis chart: maps a provider's `{ total, <segment keys> }`
// payload onto a fixed, ordered segment list and renders the segmentBar. Each
// field supplies its own title + segments via a tiny subclass below — the only
// thing that varies between Title, Description, H1, ...
export class FieldAnalysisChart extends Chart {
  constructor(el, provider, { title, segments }) {
    super(el, provider);
    this._title = title;
    this._segments = segments; // [{ key, label, token }] in display order
  }

  render(d) {
    const total = d.total || 0;

    // A quiet range (no pages graded) is not an error — show a neutral note.
    if (!total) {
      this.el.replaceChildren(
        titledCard(this._title, emptyMessage("No pages crawled in this range."))
      );
      return;
    }

    const segments = this._segments.map((s) => {
      const count = d[s.key] ?? 0;
      return { label: s.label, token: s.token, count, pct: Math.round((100 * count) / total) };
    });
    this.el.replaceChildren(segmentBar(this._title, segments));
  }
}

// Title Analysis — Duplicates, Missing, Short (<30), Good (30+). Overlapping by
// design: a duplicated good-length title counts in both Duplicates and Good.
// Colors match the reference (red, orange, amber, green). Fed by
// TitleAnalysisProvider (/api/title-analysis).
const TITLE_SEGMENTS = [
  { key: "duplicates", label: "Duplicates",  token: "--error" },
  { key: "missing",    label: "Missing",     token: "--warning-strong" },
  { key: "short",      label: "Short (<30)", token: "--warning" },
  { key: "good",       label: "Good (30+)",  token: "--success" },
];

export class TitleAnalysisChart extends FieldAnalysisChart {
  constructor(el, provider) {
    super(el, provider, { title: "Title Analysis", segments: TITLE_SEGMENTS });
  }
}

// Meta Description Analysis — adds two length buckets over Title: Short (<70),
// Good (70-160, Google's sweet spot) and Too Long (>160, gets truncated). Same
// overlapping Duplicates overlay. Colors match the reference (red, orange, amber,
// lime, green). Fed by DescriptionAnalysisProvider (/api/description-analysis).
const DESCRIPTION_SEGMENTS = [
  { key: "duplicates", label: "Duplicates",      token: "--error" },
  { key: "missing",    label: "Missing",         token: "--warning-strong" },
  { key: "short",      label: "Short (<70)",     token: "--warning" },
  { key: "too_long",   label: "Too Long (>160)", token: "--lime" },
  { key: "good",       label: "Good (70-160)",   token: "--success" },
];

export class DescriptionAnalysisChart extends FieldAnalysisChart {
  constructor(el, provider) {
    super(el, provider, { title: "Meta Description Analysis", segments: DESCRIPTION_SEGMENTS });
  }
}
