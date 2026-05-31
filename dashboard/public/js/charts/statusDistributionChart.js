import { Chart } from "../core/chart.js";
import { titledCard, emptyMessage, fmtCompact, fmtPct } from "../core/ui.js";

// Response Status Distribution — a stack of labeled horizontal bars splitting
// crawl responses into 2xx / 3xx / 4xx / 5xx, plus a gray "No response" row for
// rows whose origin was unreachable (status IS NULL). Fed by
// StatusDistributionProvider (/api/status-distribution), which returns
// { rows: [{ status, c }] }. Markup + CSS already exist as the bar-list component
// (styles.css .bar-*); this just fills it from live data.
//
// The four HTTP groups are fixed and always shown (even at 0%) so the card keeps
// a consistent shape; "No response" only appears when it actually has rows.
const GROUPS = [
  { key: "2xx", digit: 2, mod: "bar-fill-success" },
  { key: "3xx", digit: 3, mod: "bar-fill-info" },
  { key: "4xx", digit: 4, mod: "bar-fill-warning" },
  { key: "5xx", digit: 5, mod: "bar-fill-error" },
];
// Trailing group for unreachable-origin rows; default gray .bar-fill (no mod).
const NO_RESPONSE = { key: "No response", mod: "" };

const TITLE = "Response Status Distribution";

export class StatusDistributionChart extends Chart {
  render({ rows }) {
    // No data is not an error (a quiet range is normal) — neutral message, not
    // the red failure state. Mirrors botActivityChart's empty handling.
    if (!rows.length) {
      this.el.replaceChildren(titledCard(TITLE, emptyMessage("No requests in this range.")));
      return;
    }

    // Bucket each row into a group. Order matters: test status === null FIRST,
    // because Math.floor(null / 100) is 0 and would silently miscategorize it.
    const totals = new Map([...GROUPS, NO_RESPONSE].map((g) => [g.key, 0]));
    const codes = new Map(GROUPS.map((g) => [g.key, []])); // key -> [{ code, c }]
    let grandTotal = 0;

    for (const { status, c } of rows) {
      if (status === null) {
        totals.set(NO_RESPONSE.key, totals.get(NO_RESPONSE.key) + c);
        grandTotal += c;
        continue;
      }
      const group = GROUPS.find((g) => Math.floor(status / 100) === g.digit);
      if (!group) continue; // out of 2xx-5xx: not emitted by this worker, skip
      totals.set(group.key, totals.get(group.key) + c);
      codes.get(group.key).push({ code: status, c });
      grandTotal += c;
    }

    const list = document.createElement("div");
    list.className = "bar-list";

    // Always render the four HTTP groups; append No response only if it has rows.
    for (const g of GROUPS) {
      const meta = codes.get(g.key).sort((a, b) => b.c - a.c || a.code - b.code);
      list.appendChild(
        barRow(g, totals.get(g.key), grandTotal, meta.map((m) => `${m.code}: ${fmtCompact(m.c)}`))
      );
    }
    const noResp = totals.get(NO_RESPONSE.key);
    if (noResp > 0) {
      list.appendChild(
        barRow(NO_RESPONSE, noResp, grandTotal, [`unreachable: ${fmtCompact(noResp)}`])
      );
    }

    this.el.replaceChildren(titledCard(TITLE, list));
  }
}

// One bar row: label | track(fill) | value, with an optional breakdown line.
// `metaLabels` is a list of "code: count" strings; an empty list omits the meta
// element entirely so a 0% group leaves no dangling gap.
function barRow(group, total, grandTotal, metaLabels) {
  const pct = grandTotal ? (total / grandTotal) * 100 : 0;

  const row = document.createElement("div");
  row.className = "bar-row";

  const main = document.createElement("div");
  main.className = "bar-main";

  const label = document.createElement("span");
  label.className = "bar-label";
  label.textContent = group.key;

  const track = document.createElement("div");
  track.className = "bar-track";
  const fill = document.createElement("div");
  fill.className = group.mod ? `bar-fill ${group.mod}` : "bar-fill";
  fill.style.width = `${pct}%`;
  track.appendChild(fill);

  const value = document.createElement("span");
  value.className = "bar-value";
  value.textContent = fmtPct(pct);

  main.append(label, track, value);
  row.appendChild(main);

  if (metaLabels.length) {
    const meta = document.createElement("div");
    meta.className = "bar-meta";
    for (const text of metaLabels) {
      const span = document.createElement("span");
      span.textContent = text;
      meta.appendChild(span);
    }
    row.appendChild(meta);
  }

  return row;
}
