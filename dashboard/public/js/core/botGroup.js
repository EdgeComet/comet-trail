// The "All bots / Googlebot / AI bots" switch, for cards that would otherwise
// blend every bot. AI bots can make half of all requests, so a status code
// that only training crawlers get (a 429 rate limit) or their slower fetches
// would read as something Googlebot got. The endpoints behind such cards take
// ?group=all|googlebot|ai (lib/sql.js BOT_GROUP_SQL).
//
// The page keeps each card's choice in a module-scope object, so it survives
// period changes and navigating away and back. The object's initial value is
// the card's default:
//   const groups = { status: "all" };
//   dashboard.add(withBotGroup(new SomeChart(el, provider), groups, "status"));
// The chart draws `this.actions` in its card header. The group travels in the
// chart's params, which are part of the provider's cache key
// (core/provider.js), so each group is fetched once and cached apart.
import { segmented } from "./ui.js";

export const BOT_GROUPS = [
  { key: "all", label: "All bots" },
  { key: "googlebot", label: "Googlebot" },
  { key: "ai", label: "AI bots" },
];

// One switch for a whole view (Log Analyzer > Status Codes and Loading Time):
// every chart on it shows the group the switch picks. Call it once the charts
// are added and before dashboard.start(), and put the switch at the end of
// the view's lead line:
//   reportHeader({ ..., filter: viewBotGroup(dashboard.charts, groups, "view") })
export function viewBotGroup(charts, state, key) {
  const apply = (group) => charts.forEach((chart) => (chart.params = { ...chart.params, group }));
  apply(state[key]);
  return segmented({
    options: BOT_GROUPS,
    value: state[key],
    label: "Bots",
    onChange: (group) => {
      state[key] = group;
      apply(group);
      charts.forEach((chart) => chart.reload());
    },
  });
}

export function withBotGroup(chart, state, key) {
  chart.params = { ...chart.params, group: state[key] };
  chart.actions = segmented({
    options: BOT_GROUPS,
    value: state[key],
    label: "Bots",
    onChange: (group) => {
      state[key] = group;
      chart.params = { ...chart.params, group };
      chart.reload();
    },
  });
  return chart;
}
