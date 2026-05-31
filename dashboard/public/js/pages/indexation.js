// Indexation page — whether bots can index what they crawled.
//
// First real widget: a row of four summary stat cards (Indexable, Non-Indexable,
// Non-Canonical, Redirects) counted per-URL by latest visit within the selected
// range, via the Provider -> Chart -> Dashboard wiring. The provider and the
// chosen range live at module scope so the in-memory cache and the active preset
// survive navigating away and back. (rangeBar mirrors logAnalyzer.js's; left as
// a local copy to keep this change to net-new files.)
import { DateRangeStore } from "../core/dateRange.js";
import { Dashboard } from "../core/registry.js";
import { IndexationSummaryProvider } from "../providers/indexationSummaryProvider.js";
import { IndexationSummaryChart } from "../charts/indexationSummaryChart.js";
import { pageHeader } from "../core/ui.js";

const PRESETS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

const summaryProvider = new IndexationSummaryProvider();
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

export function renderIndexation(outlet) {
  outlet.append(
    pageHeader(
      "Indexation",
      "Indexation status of URLs crawled in the selected range."
    )
  );

  const dateRange = new DateRangeStore(selectedDays);
  outlet.append(rangeBar(dateRange));

  const summary = document.createElement("div");
  summary.id = "indexation-summary";
  outlet.append(summary);

  const dashboard = new Dashboard(dateRange);
  dashboard.add(new IndexationSummaryChart(summary, summaryProvider));
  dashboard.start(); // initial paint for the current range

  // Router teardown: detach the range subscription before the next view.
  return () => dashboard.destroy();
}
