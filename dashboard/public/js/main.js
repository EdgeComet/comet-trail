// Dashboard entry point. Wires the theme toggle, builds the date-range store and
// the provider/chart pairs, hooks up the preset buttons, and boots.
import { DateRangeStore } from "./core/dateRange.js";
import { Dashboard } from "./core/registry.js";
import { MetricsProvider } from "./providers/metricsProvider.js";
import { StatCardGroupChart } from "./charts/statCardGroupChart.js";

// --- Theme toggle: persist the choice and reflect it on <html data-theme>. ---
function initThemeToggle() {
  const root = document.documentElement;
  const saved = localStorage.getItem("theme");
  if (saved === "light") root.removeAttribute("data-theme");
  else if (saved === "dark") root.setAttribute("data-theme", "dark");

  document.getElementById("theme-toggle").addEventListener("click", () => {
    const isDark = root.getAttribute("data-theme") === "dark";
    if (isDark) {
      root.removeAttribute("data-theme");
      localStorage.setItem("theme", "light");
    } else {
      root.setAttribute("data-theme", "dark");
      localStorage.setItem("theme", "dark");
    }
  });
}

// --- Date-range preset buttons -> store.setDays (store fans out to charts). ---
function initRangeButtons(dateRange) {
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".range-btn").forEach((b) => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-pressed", String(active));
      });
      dateRange.setDays(Number(btn.dataset.range));
    });
  });
}

initThemeToggle();

const dateRange = new DateRangeStore(30); // default: last 30 days
const dashboard = new Dashboard(dateRange);

dashboard.add(
  new StatCardGroupChart(document.getElementById("metrics"), new MetricsProvider())
);

initRangeButtons(dateRange);
dashboard.start(); // initial paint
