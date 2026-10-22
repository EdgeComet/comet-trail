// Dashboard entry point. Wires the theme toggle and the sidebar, reads which
// site the data belongs to, then hands navigation to the History API router:
// each sidebar link maps to a page view that paints itself into the outlet.
import { Router } from "./core/router.js";
import { globalRange } from "./core/dateRange.js";
import { icon, fmtAgo, shortUrl } from "./core/ui.js";
import { renderLogAnalyzer } from "./pages/logAnalyzer.js";
import { renderAiBots } from "./pages/aiBots.js";
import { renderIndexation } from "./pages/indexation.js";
import { renderContent } from "./pages/content.js";
import { renderChanges } from "./pages/changes.js";
import { renderPages } from "./pages/pages.js";
import { renderPage } from "./pages/page.js";
import { renderWaiting } from "./pages/waiting.js";

// --- Theme toggle: persist the choice and reflect it on <html data-theme>. ---
function initThemeToggle() {
  const root = document.documentElement;
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const dark = root.getAttribute("data-theme") !== "dark";
    if (dark) root.setAttribute("data-theme", "dark");
    else root.removeAttribute("data-theme");
    try {
      localStorage.setItem("theme", dark ? "dark" : "light");
    } catch {
      // Private mode or blocked storage: the toggle still works for this visit.
    }
    // Charts read colors from CSS variables when they render, so repaint.
    router.navigate(location.pathname + location.search);
  });
}

// Sidebar icons, from the data-icon attribute on each link.
function initNavIcons() {
  document.querySelectorAll(".nav-item[data-icon]").forEach((a) => a.prepend(icon(a.dataset.icon)));
}

// Which site is this, and has any bot visit arrived yet?
async function loadSite() {
  try {
    const res = await fetch("/api/site");
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function showSite(site) {
  const host = document.getElementById("site-host");
  const meta = document.getElementById("site-meta");
  if (!site?.last_ts) {
    host.textContent = "No data yet";
    meta.textContent = "waiting for bots";
    return;
  }
  host.textContent = site.host;
  host.title = site.host;
  meta.textContent = `last bot visit ${fmtAgo(site.last_ts)}`;
  meta.title = shortUrl(site.last_url);
}

initThemeToggle();
initNavIcons();

// The period lives in the address bar (?period=7d, ?period=2026-09-01_2026-09-30),
// so a reload or a shared link keeps it. The default (30 days) leaves no param.
function syncPeriodToUrl() {
  const params = new URLSearchParams(location.search);
  const value = globalRange.toParam();
  if (value) params.set("period", value);
  else params.delete("period");
  const qs = params.toString();
  const next = location.pathname + (qs ? `?${qs}` : "");
  if (next !== location.pathname + location.search) history.replaceState(history.state, "", next);
}

const router = new Router(document.getElementById("view-outlet"));
// Before each view: a ?period= in the URL (a reload, a shared link, back and
// forward) sets the period; otherwise the current period is written into the
// URL. Then the range is re-quantized, so a view mounted later in the session
// covers the period up to now, not up to when the app loaded.
router.beforeRender = () => {
  const fromUrl = new URLSearchParams(location.search).get("period");
  if (fromUrl) globalRange.applyParam(fromUrl);
  syncPeriodToUrl();
  globalRange.refresh();
};
globalRange.subscribe(syncPeriodToUrl);
router.bindLinks();

const site = await loadSite();
showSite(site);
// A custom range must reach the first recorded visit (core/dateRange.js validate).
globalRange.minTs = site?.first_ts ?? null;

if (site && !site.last_ts) {
  // Fresh install: every route shows how to get the first visit recorded.
  const waiting = (outlet, params) => renderWaiting(outlet, params, site);
  for (const path of ["/log-analyzer", "/ai-bots", "/indexation", "/content", "/changes", "/pages", "/page"]) {
    router.add(path, waiting, "Waiting for bots", path === "/page" ? "/pages" : path);
  }
} else {
  router
    .add("/log-analyzer", renderLogAnalyzer, "Log Analyzer")
    .add("/ai-bots", renderAiBots, "AI Bots")
    .add("/indexation", renderIndexation, "Indexation")
    .add("/content", renderContent, "Content")
    .add("/changes", renderChanges, "Changes")
    .add("/pages", renderPages, "Pages")
    .add("/page", renderPage, "Page", "/pages");
}
router.start("/log-analyzer"); // default view (also normalizes "/")
