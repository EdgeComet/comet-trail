import { Chart } from "../core/chart.js";
import { statCard } from "./statCardGroupChart.js";

// Renders the four indexation summary metrics as a row of .stat-card tiles,
// reusing the shared statCard() builder. The cards intentionally overlap:
// Non-Indexable already contains Non-Canonical and Redirects (see the page
// subtitle and the endpoint comment for the per-URL-latest semantics).
const fmtInt = (n) => Number(n).toLocaleString();

export class IndexationSummaryChart extends Chart {
  render(d) {
    const cards = [
      { label: "Indexable",     value: fmtInt(d.indexable),     foot: "can be indexed" },
      { label: "Non-Indexable", value: fmtInt(d.non_indexable), foot: "blocked or errored" },
      { label: "Non-Canonical", value: fmtInt(d.non_canonical), foot: "point elsewhere" },
      { label: "Redirects",     value: fmtInt(d.redirects),     foot: "3xx responses" },
    ];

    const grid = document.createElement("div");
    grid.className = "stat-grid";
    for (const c of cards) grid.appendChild(statCard(c));
    this.el.replaceChildren(grid);
  }
}
