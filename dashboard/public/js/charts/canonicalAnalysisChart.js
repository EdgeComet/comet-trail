import { Chart } from "../core/chart.js";
import { titledCard, emptyMessage, fmtCompact, fmtPct } from "../core/ui.js";

// Canonical Analysis — a stack of labeled horizontal bars splitting the URLs
// crawled in the range by how they declare their canonical tag, with each
// category's URL count beneath its bar. Fed by CanonicalAnalysisProvider
// (/api/canonical-analysis), which returns { rows: [{ canonical_class, c }] }.
// Reuses the bar-list component (styles.css .bar-*) the status charts established.
//
// Scope (see api/canonical-analysis.js): only each URL's latest visit is counted,
// and only when it is status 200, so the denominator is live pages — not all
// crawled URLs — and "Missing" means a real page lacking a canonical rather than
// a redirect/error page. The self/cross split rides on the worker's index_status,
// so a blocked_by_meta page (noindex, status 200) carrying a cross-canonical reads
// as "Self" (index_status precedence makes it blocked_by_meta, not non_canonical) —
// a known, accepted edge.
//
// The three categories are fixed and always shown (even at 0%) so the card keeps a
// consistent shape; colors mirror the reference (green / purple / amber). `key` is
// the raw canonical_class value the backend emits.
const CATEGORIES = [
  { key: "self",    label: "Self-canonical",  mod: "bar-fill-success" },
  { key: "cross",   label: "Cross-canonical", mod: "bar-fill-purple" },
  { key: "missing", label: "Missing",         mod: "bar-fill-warning" },
];

const TITLE = "Canonical Analysis";

export class CanonicalAnalysisChart extends Chart {
  render({ rows }) {
    // No data is not an error (a quiet range is normal) — neutral message, not
    // the red failure state. Mirrors indexStatusDistributionChart's empty handling.
    if (!rows.length) {
      this.el.replaceChildren(titledCard(TITLE, emptyMessage("No indexation data in this range.")));
      return;
    }

    // Key counts by canonical_class: the backend GROUP BYs, so row order is not
    // guaranteed and an absent class yields no row (read 0). The denominator is
    // the sum of the three shown classes, so an unexpected value is excluded from
    // both numerator and denominator and the bars still total ~100%.
    const counts = new Map(rows.map((r) => [r.canonical_class, r.c]));
    let denom = 0;
    for (const c of CATEGORIES) denom += counts.get(c.key) ?? 0;

    const list = document.createElement("div");
    list.className = "bar-list";
    for (const c of CATEGORIES) list.appendChild(barRow(c, counts.get(c.key) ?? 0, denom));

    this.el.replaceChildren(titledCard(TITLE, list));
  }
}

// One bar row: label | track(fill) | value, with a "<count> URLs" line.
// A zero-count category gets an empty track (no fill node) so it reads as empty —
// .bar-fill's min-width would otherwise show a misleading nub.
function barRow(category, count, denom) {
  const pct = denom ? (count / denom) * 100 : 0;

  const row = document.createElement("div");
  row.className = "bar-row";

  const main = document.createElement("div");
  main.className = "bar-main";

  const label = document.createElement("span");
  label.className = "bar-label";
  label.textContent = category.label;

  const track = document.createElement("div");
  track.className = "bar-track";
  if (count > 0) {
    const fill = document.createElement("div");
    fill.className = `bar-fill ${category.mod}`;
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
  }

  const value = document.createElement("span");
  value.className = "bar-value";
  value.textContent = fmtPct(pct);

  main.append(label, track, value);

  const meta = document.createElement("div");
  meta.className = "bar-meta";
  const span = document.createElement("span");
  span.textContent = `${fmtCompact(count)} URLs`;
  meta.appendChild(span);

  row.append(main, meta);
  return row;
}
