import { Chart } from "../core/chart.js";
import { card, dataTable, emptyMessage } from "../core/ui.js";

// A titled card holding one table. `columns` follows dataTable() in core/ui.js;
// `rows(data)` picks the row list out of the provider's JSON.
//   new TableChart(el, provider, { title, subtitle, link, columns, rows, empty })
export class TableChart extends Chart {
  constructor(el, provider, opts) {
    super(el, provider);
    this.opts = opts;
  }

  render(data) {
    const { title, subtitle, link, columns, rows = (d) => d.rows, empty = "Nothing in this period." } = this.opts;
    const list = rows(data);
    const sub = typeof subtitle === "function" ? subtitle(data) : subtitle;
    const body = list.length ? dataTable(columns, list) : emptyMessage(empty);
    this.el.replaceChildren(card({ title, subtitle: sub, link, flush: list.length > 0 }, body));
  }
}
