import { Chart } from "../core/chart.js";
import { titledCard, emptyMessage, fmtCompact, fmtPct } from "../core/ui.js";

// Index Status Distribution — a stack of labeled horizontal bars splitting the
// URLs crawled in the range into the four index_status outcomes, with each
// status's URL count beneath its bar. Fed by IndexStatusDistributionProvider
// (/api/index-status-distribution), which returns { rows: [{ index_status, c }] }
// (per-URL-latest within the range). Reuses the bar-list component (styles.css
// .bar-*) the status charts established.
//
// The four statuses are fixed and always shown (even at 0%) so the card keeps a
// consistent shape. label/order/colors mirror SERIES in indexStatusTrendChart.js
// so the snapshot and the trend can't drift; `key` is the raw index_status enum.
const STATUSES = [
  { key: "indexable",       label: "Indexable",     mod: "bar-fill-success" },
  { key: "non_200",         label: "Non-200",       mod: "bar-fill-warning" },
  { key: "blocked_by_meta", label: "Blocked",       mod: "bar-fill-error" },
  { key: "non_canonical",   label: "Non-canonical", mod: "bar-fill-purple" },
];

const TITLE = "Index Status Distribution";

export class IndexStatusDistributionChart extends Chart {
  render({ rows }) {
    // No data is not an error (a quiet range is normal) — neutral message, not
    // the red failure state. Mirrors statusDistributionChart's empty handling.
    if (!rows.length) {
      this.el.replaceChildren(titledCard(TITLE, emptyMessage("No indexation data in this range.")));
      return;
    }

    // Key counts by index_status name: the backend GROUP BYs, so row order is not
    // guaranteed and an absent status yields no row (read 0). The denominator is
    // the sum of the four shown statuses, so an unexpected enum value is excluded
    // from both numerator and denominator and the bars still total ~100%.
    const counts = new Map(rows.map((r) => [r.index_status, r.c]));
    let denom = 0;
    for (const s of STATUSES) denom += counts.get(s.key) ?? 0;

    const list = document.createElement("div");
    list.className = "bar-list";
    for (const s of STATUSES) list.appendChild(barRow(s, counts.get(s.key) ?? 0, denom));

    this.el.replaceChildren(titledCard(TITLE, list));
  }
}

// One bar row: label | track(fill) | value, with a "<count> URLs" line.
// A zero-count status gets an empty track (no fill node) so it reads as empty —
// .bar-fill's min-width would otherwise show a misleading nub.
function barRow(status, count, denom) {
  const pct = denom ? (count / denom) * 100 : 0;

  const row = document.createElement("div");
  row.className = "bar-row";

  const main = document.createElement("div");
  main.className = "bar-main";

  const label = document.createElement("span");
  label.className = "bar-label";
  label.textContent = status.label;

  const track = document.createElement("div");
  track.className = "bar-track";
  if (count > 0) {
    const fill = document.createElement("div");
    fill.className = `bar-fill ${status.mod}`;
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
