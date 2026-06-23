import { Chart } from "../core/chart.js";
import { statCard } from "./statCardGroupChart.js";

// Renders the four content-quality summary metrics as a row of .stat-card tiles,
// reusing the shared statCard() builder. Counts are per-URL by latest 200 visit
// in the selected range (see /api/content-summary). The metrics overlap by
// design — a page with no title usually has no H1 either, so it lands in both
// "Missing Titles" and "H1 Issues". statCard sets text via textContent, so the
// literal "<title>" in the footnote renders as text, not markup.
const fmtInt = (n) => Number(n).toLocaleString();

export class ContentSummaryChart extends Chart {
  render(d) {
    const cards = [
      { label: "Missing Titles",       value: fmtInt(d.missing_titles),       foot: "no <title> tag" },
      { label: "Missing Descriptions", value: fmtInt(d.missing_descriptions), foot: "no meta description" },
      { label: "Duplicate Titles",     value: fmtInt(d.duplicate_titles),     foot: "title not unique" },
      { label: "H1 Issues",            value: fmtInt(d.h1_issues),            foot: "missing or multiple H1" },
    ];

    const grid = document.createElement("div");
    grid.className = "stat-grid";
    for (const c of cards) grid.appendChild(statCard(c));
    this.el.replaceChildren(grid);
  }
}
