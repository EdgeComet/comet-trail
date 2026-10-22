import { Chart } from "../core/chart.js";
import { h, card, emptyMessage, urlCell, fmtInt } from "../core/ui.js";

// "Changed since the previous period": pages whose verdict moved, one row per
// from -> to pair. Rows open to show example URLs. Shown before "Show all":
// the worst moves, then the recoveries.
// The provider returns { moves, partial }, each move
// { from, to, direction: worse|lateral|better, pages, googlebot, ai_user, sample }.
//   new MovesChart(el, provider, { badge(key), empty, foot(d)? })
// `foot` returns an optional note for under the list.
const TOP_WORSE = 5;
const TOP_BETTER = 3;
const TITLE = "Changed since the previous period";

export class MovesChart extends Chart {
  constructor(el, provider, { badge, empty, foot = null }) {
    super(el, provider);
    this.badge = badge;
    this.empty = empty;
    this.foot = foot;
    this.open = new Set(); // "from>to" keys of expanded moves
    this.showAll = false;
  }

  render(d) {
    this.data = d;
    const note = this.foot ? this.foot(d) : null;
    const foot = note ? h("p", { className: "moves-foot", text: note }) : null;
    if (!d.moves.length) {
      this.el.replaceChildren(card({ title: TITLE }, emptyMessage(this.empty), foot));
      return;
    }
    const worse = d.moves.filter((m) => m.direction === "worse");
    const better = d.moves.filter((m) => m.direction === "better");
    const shown = this.showAll ? d.moves : [...worse.slice(0, TOP_WORSE), ...better.slice(0, TOP_BETTER)];
    const hidden = d.moves.length - shown.length;
    const list = h(
      "div",
      { className: "moves" },
      shown.map((m) => {
        const key = `${m.from}>${m.to}`;
        const isOpen = this.open.has(key);
        const head = h(
          "button",
          {
            type: "button",
            className: `move move-${m.direction}${isOpen ? " is-open" : ""}`,
            "aria-expanded": String(isOpen),
            on: {
              click: () => {
                if (isOpen) this.open.delete(key);
                else this.open.add(key);
                this.render(this.data);
              },
            },
          },
          h("span", { className: "move-dir", text: m.direction === "worse" ? "↓" : m.direction === "better" ? "↑" : "→" }),
          h("span", { className: "move-path" }, this.badge(m.from), h("span", { className: "move-arrow", text: "→" }), this.badge(m.to)),
          h("span", { className: "move-pages", text: `${fmtInt(m.pages)} page${m.pages === 1 ? "" : "s"}` }),
          h("span", { className: "move-demand", text: `${fmtInt(m.googlebot)} Googlebot visits · ${fmtInt(m.ai_user)} AI user fetches` })
        );
        const sample = isOpen
          ? h(
              "div",
              { className: "move-sample" },
              m.sample.map((u) => urlCell(u)),
              m.pages > m.sample.length ? h("div", { className: "diff-note", text: `and ${fmtInt(m.pages - m.sample.length)} more` }) : null
            )
          : null;
        return h("div", {}, head, sample);
      }),
      hidden > 0 || this.showAll
        ? h(
            "button",
            {
              type: "button",
              className: "btn btn-ghost btn-sm moves-more",
              on: { click: () => { this.showAll = !this.showAll; this.render(this.data); } },
            },
            this.showAll ? "Show fewer" : `Show all ${d.moves.length} moves`
          )
        : null
    );
    const sub = d.partial ? "the previous period is only partly recorded" : "worst first, with the demand on those pages now";
    this.el.replaceChildren(card({ title: TITLE, subtitle: sub }, list, foot));
  }
}
