// Change events as dashed vertical lines on a time chart, so a release sits
// next to what it did to the crawl, the verdicts or the status codes. The
// events are the ones Evergreen Crawl > Changes lists (/api/changes: one field
// changing on many pages within a few days), so every line is one you can read
// about there.
//
// changeMarkers(fields) keeps the events of those fields only (a chart of
// status codes marks status code changes), merges the events that start on
// the same day into one line, keeps the MAX_MARKERS biggest and labels each
// "Canonical, 87 pages". A line is red when most of its changes cost pages
// their indexability or their 2xx, green when they gave it back (styles.css
// .marker-bad, .marker-good).
import { changesProvider } from "../providers/changesProvider.js";
import { fmtInt } from "./ui.js";

const DAY_MS = 86400000;
// More lines than this crowd the chart and their labels run into each other.
const MAX_MARKERS = 4;
const RANK = { bad: 3, good: 2, neutral: 1 };
const toneOf = (e) => (RANK[e.tone] ? e.tone : "neutral");

// Feeds a chart its provider's response with the period's change events added
// as `events`, like core/botGroup.js withBotGroup decorates a chart:
//   dashboard.add(withChangeEvents(new TimeSeriesChart(el, provider, { markers: changeMarkers() })));
// The chart does not wait for the events. It draws as soon as its own data is
// in, and again, with the lines, once the events are. They are only asked for
// then: a D1 database runs one query at a time, so the heavy query, sent with
// the view's first requests, would hold up every card. The events take none of
// the chart's params (a bot group): a change is what the site served, to every
// bot. Events that fail to load leave the chart without lines.
export function withChangeEvents(chart) {
  const provider = chart.provider;
  chart.provider = {
    get: async (from, to, extra) => {
      const data = await provider.get(from, to, extra);
      const changes = changesProvider.peek(from, to);
      if (!changes) {
        const current = () => chart.el.isConnected && chart.range?.from === from && chart.range?.to === to;
        changesProvider.get(from, to).then(() => current() && chart.reload(), () => {});
      }
      return { ...data, events: changes?.events ?? [] };
    },
  };
  return chart;
}

// What changed, in a word or two: the field, or the codes of a status change.
const what = (e) => (e.field === "status" ? `${e.example.before} → ${e.example.after}` : e.label);

// The markers option of charts/timeSeriesChart.js. A line that merges several
// events takes the tone of the worst and names it first, with its pages, then
// the others: "Canonical, 15 pages + Title" is green because the canonicals
// came back, not because of the titles. The biggest event of a day ranks its
// line among the others.
export function changeMarkers(fields = null) {
  return (data) => {
    const days = new Map();
    for (const e of data.events ?? []) {
      if (fields && !fields.includes(e.field)) continue;
      const day = Math.floor(e.start / DAY_MS);
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(e);
    }
    return [...days.values()]
      .map((list) => {
        const [top, ...rest] = list.sort((a, b) => RANK[toneOf(b)] - RANK[toneOf(a)] || b.pages - a.pages);
        const more = rest.length === 1 ? ` + ${what(rest[0])}` : rest.length ? ` + ${rest.length} more` : "";
        return {
          t: Math.min(...list.map((e) => e.start)),
          pages: Math.max(...list.map((e) => e.pages)),
          text: `${what(top)}, ${fmtInt(top.pages)} pages${more}`,
          cls: `marker-${toneOf(top)}`,
        };
      })
      .sort((a, b) => b.pages - a.pages)
      .slice(0, MAX_MARKERS);
  };
}
