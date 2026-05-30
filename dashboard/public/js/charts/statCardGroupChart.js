import { Chart } from "../core/chart.js";

// Renders the four summary metrics as a row of .stat-card tiles, using the same
// markup as the component library (components.html). No delta is shown — these
// are point-in-time values for the selected range.
const fmtInt = (n) => Number(n).toLocaleString();
const fmtPct = (n) => `${Number(n).toFixed(1)}%`;
const fmtMs = (n) => `${Math.round(Number(n))}ms`;

export class StatCardGroupChart extends Chart {
  render(d) {
    const cards = [
      { label: "Total Requests", value: fmtInt(d.total_requests), foot: "from all bots" },
      { label: "Unique URLs", value: fmtInt(d.unique_urls), foot: "pages visited" },
      { label: "Crawl Efficiency", value: fmtPct(d.crawl_efficiency), foot: "200 responses" },
      { label: "Avg Response", value: fmtMs(d.avg_response_ms), foot: "response time" },
    ];

    const grid = document.createElement("div");
    grid.className = "stat-grid";
    for (const c of cards) grid.appendChild(statCard(c));
    this.el.replaceChildren(grid);
  }
}

function statCard({ label, value, foot }) {
  const card = document.createElement("div");
  card.className = "stat-card";

  const labelEl = document.createElement("div");
  labelEl.className = "stat-label";
  labelEl.textContent = label;

  const row = document.createElement("div");
  row.className = "stat-value-row";
  const valueEl = document.createElement("span");
  valueEl.className = "stat-value";
  valueEl.textContent = value;
  row.appendChild(valueEl);

  const footEl = document.createElement("div");
  footEl.className = "stat-footnote";
  footEl.textContent = foot;

  card.append(labelEl, row, footEl);
  return card;
}
