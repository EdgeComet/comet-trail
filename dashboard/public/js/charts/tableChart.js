import { Chart } from "../core/chart.js";
import { h, card, dataTable, emptyMessage } from "../core/ui.js";

// A titled card holding one table. `columns` follows dataTable() in core/ui.js,
// or is a function of the data when a label depends on it; `rows(data)` picks
// the row list out of the provider's JSON; `foot(data)` is an optional line
// under the table (what the rows leave out), null for none; `compact` for a
// table in a narrow card (dataTable).
//   new TableChart(el, provider, { title, subtitle, link, columns, rows, foot, compact, empty })
export class TableChart extends Chart {
  constructor(el, provider, opts) {
    super(el, provider);
    this.opts = opts;
  }

  render(data) {
    const { title, subtitle, link, columns, rows = (d) => d.rows, foot = null, compact = false, empty = "Nothing in this period." } = this.opts;
    const list = rows(data);
    const sub = typeof subtitle === "function" ? subtitle(data) : subtitle;
    const cols = typeof columns === "function" ? columns(data) : columns;
    const body = list.length ? dataTable(cols, list, { compact }) : emptyMessage(empty);
    const note = list.length && foot ? foot(data) : null;
    this.el.replaceChildren(
      card({ title, subtitle: sub, link, flush: list.length > 0 }, body, note ? h("div", { className: "card-footer", text: note }) : null)
    );
  }
}
