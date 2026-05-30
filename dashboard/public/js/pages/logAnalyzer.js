// Log Analyzer page — what the bots crawled: volume, status, and speed.
//
// This is the only fully built view. It renders the date-range presets and the
// summary stat cards (the framework's Provider -> Chart -> Dashboard wiring).
// The provider and the chosen range live at module scope so the in-memory cache
// and the active preset survive navigating away and back.
import { DateRangeStore } from "../core/dateRange.js";
import { Dashboard } from "../core/registry.js";
import { MetricsProvider } from "../providers/metricsProvider.js";
import { BotActivityProvider } from "../providers/botActivityProvider.js";
import { StatCardGroupChart } from "../charts/statCardGroupChart.js";
import { BotActivityChart } from "../charts/botActivityChart.js";
import { pageHeader } from "../core/ui.js";

const PRESETS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

const metricsProvider = new MetricsProvider();
const botActivityProvider = new BotActivityProvider();
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

export function renderLogAnalyzer(outlet) {
  outlet.append(
    pageHeader("Log Analyzer", "What the bots crawled — volume, status, and speed.")
  );

  const dateRange = new DateRangeStore(selectedDays);
  outlet.append(rangeBar(dateRange));

  const metrics = document.createElement("div");
  metrics.id = "metrics";
  outlet.append(metrics);

  const botActivity = document.createElement("div");
  botActivity.id = "bot-activity";
  botActivity.style.marginTop = "24px";
  outlet.append(botActivity);

  const dashboard = new Dashboard(dateRange);
  dashboard.add(new StatCardGroupChart(metrics, metricsProvider));
  dashboard.add(new BotActivityChart(botActivity, botActivityProvider));
  dashboard.start(); // initial paint for the current range

  // Router teardown: detach the range subscription and destroy charts (the
  // billboard instance holds a window-resize listener) before the next view.
  return () => dashboard.destroy();
}
