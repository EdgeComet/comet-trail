// Evergreen Crawl > Content - the on-page tags bots received, graded per page.
//
// Every count is per URL, from the newest 200 visit in the period: the page as
// the last bot to fetch it saw it. Providers live at module scope so their
// in-memory cache survives navigating away and back.
import { globalRange } from "../core/dateRange.js";
import { Dashboard } from "../core/registry.js";
import { Provider } from "../core/provider.js";
import { reportHeader } from "../core/report.js";
import { h, fmtInt, deltaEl } from "../core/ui.js";
import { StatCardsChart } from "../charts/statCardsChart.js";
import { TitleAnalysisProvider } from "../providers/titleAnalysisProvider.js";
import { DescriptionAnalysisProvider } from "../providers/descriptionAnalysisProvider.js";
import { TitleAnalysisChart, DescriptionAnalysisChart } from "../charts/fieldAnalysisChart.js";

const summaryProvider = new Provider("contentSummary", "/api/content-summary");
const titleAnalysisProvider = new TitleAnalysisProvider();
const descriptionAnalysisProvider = new DescriptionAnalysisProvider();

// Each card counts a problem, so fewer is better.
function summaryCards(d) {
  const p = d.previous;
  const card = (label, key, foot) => ({
    label,
    value: fmtInt(d[key]),
    delta: deltaEl(d[key], p?.[key], { good: "down" }),
    foot,
  });
  return [
    card("Missing Titles", "missing_titles", "no <title> tag"),
    card("Missing Descriptions", "missing_descriptions", "no meta description"),
    card("Duplicate Titles", "duplicate_titles", "title shared with another page"),
    card("H1 Issues", "h1_issues", "missing or multiple H1"),
  ];
}

export function renderContent(outlet) {
  outlet.append(
    reportHeader({
      title: "Content",
      subtitle: "Titles, descriptions and headings as bots received them, one verdict per page.",
    })
  );

  const summary = h("div");
  const titleAnalysis = h("div", { className: "section" });
  const descriptionAnalysis = h("div", { className: "section" });
  outlet.append(summary, titleAnalysis, descriptionAnalysis);

  const dashboard = new Dashboard(globalRange);
  dashboard.add(new StatCardsChart(summary, summaryProvider, summaryCards));
  dashboard.add(new TitleAnalysisChart(titleAnalysis, titleAnalysisProvider));
  dashboard.add(new DescriptionAnalysisChart(descriptionAnalysis, descriptionAnalysisProvider));
  dashboard.start();

  return () => dashboard.destroy();
}
