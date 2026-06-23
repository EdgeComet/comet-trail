// Content page — the SEO fields bots saw on each page.
//
// First real widget: a row of four content-quality stat cards (Missing Titles,
// Missing Descriptions, Duplicate Titles, H1 Issues) counted per-URL by latest
// 200 visit within the selected range, via the Provider -> Chart -> Dashboard
// wiring. The provider and the chosen range live at module scope so the
// in-memory cache and the active preset survive navigating away and back.
// (rangeBar mirrors indexation.js's; left as a local copy to keep this change
// to net-new wiring.)
import { DateRangeStore } from "../core/dateRange.js";
import { Dashboard } from "../core/registry.js";
import { ContentSummaryProvider } from "../providers/contentSummaryProvider.js";
import { ContentSummaryChart } from "../charts/contentSummaryChart.js";
import { TitleAnalysisProvider } from "../providers/titleAnalysisProvider.js";
import { DescriptionAnalysisProvider } from "../providers/descriptionAnalysisProvider.js";
import { TitleAnalysisChart, DescriptionAnalysisChart } from "../charts/fieldAnalysisChart.js";
import { pageHeader } from "../core/ui.js";

const PRESETS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

const summaryProvider = new ContentSummaryProvider();
const titleAnalysisProvider = new TitleAnalysisProvider();
const descriptionAnalysisProvider = new DescriptionAnalysisProvider();
let selectedDays = 30; // remembered across tab switches

// Build the preset pill row and wire each button to the date-range store.
function rangeBar(dateRange) {
  const bar = document.createElement("div");
  bar.className = "range-bar";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Date range");

  for (const { days, label } of PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "range-btn";
    btn.textContent = label;
    const active = days === selectedDays;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));

    btn.addEventListener("click", () => {
      selectedDays = days;
      bar.querySelectorAll(".range-btn").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      dateRange.setDays(days);
    });

    bar.appendChild(btn);
  }
  return bar;
}

export function renderContent(outlet) {
  outlet.append(
    pageHeader(
      "Content",
      "Content quality of pages crawled in the selected range."
    )
  );

  const dateRange = new DateRangeStore(selectedDays);
  outlet.append(rangeBar(dateRange));

  const summary = document.createElement("div");
  summary.id = "content-summary";
  outlet.append(summary);

  // Per-field analysis bars. Each is a full-width card stacked below the summary
  // with the standard 24px rhythm; all reuse the same segmentBar() renderer.
  const titleAnalysis = document.createElement("div");
  titleAnalysis.id = "content-title-analysis";
  titleAnalysis.className = "chart-section";
  outlet.append(titleAnalysis);

  const descriptionAnalysis = document.createElement("div");
  descriptionAnalysis.id = "content-description-analysis";
  descriptionAnalysis.className = "chart-section";
  outlet.append(descriptionAnalysis);

  const dashboard = new Dashboard(dateRange);
  dashboard.add(new ContentSummaryChart(summary, summaryProvider));
  dashboard.add(new TitleAnalysisChart(titleAnalysis, titleAnalysisProvider));
  dashboard.add(new DescriptionAnalysisChart(descriptionAnalysis, descriptionAnalysisProvider));
  dashboard.start(); // initial paint for the current range

  // Router teardown: detach the range subscription before the next view.
  return () => dashboard.destroy();
}
