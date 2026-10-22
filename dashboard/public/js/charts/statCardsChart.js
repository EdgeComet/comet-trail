import { Chart } from "../core/chart.js";
import { h, statCard } from "../core/ui.js";

// A row of stat cards. The page passes `cards(data)`, which maps the provider's
// JSON to statCard() configs, so one class serves every summary row:
//   new StatCardsChart(el, provider, (d) => [{ label, value, delta, foot, href }])
export class StatCardsChart extends Chart {
  constructor(el, provider, cards) {
    super(el, provider);
    this.cards = cards;
  }

  render(data) {
    this.el.replaceChildren(h("div", { className: "stat-grid" }, this.cards(data).map(statCard)));
  }
}
