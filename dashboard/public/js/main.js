// Dashboard entry point. Wires the theme toggle, then hands navigation to the
// History API router: each sidebar link maps to a page view that paints itself
// into the single <main> outlet. The Log Analyzer view carries the date-range
// presets and stat cards; Indexation and Content are placeholders for now.
import { Router } from "./core/router.js";
import { renderLogAnalyzer } from "./pages/logAnalyzer.js";
import { renderIndexation } from "./pages/indexation.js";
import { renderContent } from "./pages/content.js";

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

initThemeToggle();

const router = new Router(document.getElementById("view-outlet"));
router
  .add("/log-analyzer", renderLogAnalyzer, "Log Analyzer")
  .add("/indexation", renderIndexation, "Indexation")
  .add("/content", renderContent, "Content");
router.bindLinks();
router.start("/log-analyzer"); // default view (also normalizes "/")
