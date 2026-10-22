// Pages - every URL bots fetched in the period: what the newest visit got, how
// many bots came, and how often the page changed. Each row opens the page's
// time machine. Search, filter, sort and page position live at module scope, so
// coming back from a page view lands where you left.
import { globalRange } from "../core/dateRange.js";
import { Dashboard } from "../core/registry.js";
import { Chart } from "../core/chart.js";
import { Provider } from "../core/provider.js";
import { reportHeader } from "../core/report.js";
import { h, card, icon, dataTable, emptyMessage, statusBadge, bucketBadge, urlCell, fmtInt, fmtAgo, fmtDateTime } from "../core/ui.js";

const provider = new Provider("pages", "/api/pages");
const PAGE_SIZE = 50;

const VIEWS = [
  { key: "all", label: "All pages" },
  { key: "changed", label: "Changed" },
  { key: "not_indexable", label: "Not indexable" },
  { key: "ai", label: "Opened by AI assistants" },
];

const state = { q: "", view: "all", sort: "visits", offset: 0 };

const num = (n, strong = false) => h("span", { className: strong && n > 0 ? "num-strong" : n ? "" : "muted", text: fmtInt(n) });

class PagesTable extends Chart {
  constructor(el, provider, onChange) {
    super(el, provider);
    this.onChange = onChange;
    this.search = h("input", {
      className: "input",
      type: "search",
      placeholder: "Search URLs and titles",
      value: state.q,
      "aria-label": "Search URLs and titles",
    });
    let timer = null;
    this.search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.onChange({ q: this.search.value.trim(), offset: 0 }), 250);
    });
    // The search box is built once and never re-attached, so it keeps focus
    // (and the caret) while results reload under it.
    this.chips = h("div", { className: "chips", role: "group", "aria-label": "Filter pages" });
    this.toolbar = h("div", { className: "table-toolbar" }, h("div", { className: "search-field" }, icon("search"), this.search), this.chips);
    this.body = h("div");
    this.el.replaceChildren(card({ title: "Pages bots fetched", flush: true }, this.toolbar, this.body));
  }

  // A new period starts back on the first page.
  load(from, to) {
    if (this._range && (this._range.from !== from || this._range.to !== to)) {
      state.offset = 0;
      this.params = params();
    }
    this._range = { from, to };
    return super.load(from, to);
  }

  // Keep the card (and the search box with its focus) across reloads; only the
  // table body shows the spinner.
  showLoading() {
    this.body.replaceChildren(h("div", { className: "spinner" }));
  }

  showError(message) {
    this.body.replaceChildren(h("div", { className: "chart-error", style: { padding: "0 24px" }, text: `Failed to load: ${message}` }));
  }

  render(d) {
    // The server moves an offset past the end back onto the last page.
    state.offset = d.offset;
    this.chips.replaceChildren(
      ...VIEWS.map((v) =>
        h(
          "button",
          {
            type: "button",
            className: v.key === state.view ? "chip active" : "chip",
            "aria-pressed": String(v.key === state.view),
            on: { click: () => this.onChange({ view: v.key, offset: 0 }) },
          },
          v.label,
          h("span", { className: "chip-count", text: fmtInt(d.counts[v.key]) })
        )
      )
    );

    if (!d.rows.length) {
      this.body.replaceChildren(emptyMessage(state.q ? `No page matches "${state.q}".` : "No pages in this view."));
      return;
    }

    const table = dataTable(
      [
        { label: "Page", render: (r) => urlCell(r.url, r.title ?? (r.status && r.status < 400 && r.status >= 300 ? "(redirect)" : "(no title)")), sortKey: "url" },
        { label: "Status", nowrap: true, render: (r) => statusBadge(r.status) },
        { label: "Verdict", nowrap: true, render: (r) => bucketBadge(r.bucket) },
        { label: "Visits", num: true, render: (r) => num(r.visits), sortKey: "visits" },
        { label: "Googlebot", num: true, render: (r) => num(r.googlebot), sortKey: "googlebot" },
        { label: "AI user fetches", num: true, render: (r) => num(r.ai_user), sortKey: "ai_user" },
        { label: "Changes", num: true, render: (r) => num(r.changes, true), sortKey: "changes" },
        {
          label: "Last visit",
          nowrap: true,
          sortKey: "last",
          render: (r) => h("div", { className: "cell-last", title: `${fmtDateTime(r.last_ts)} · ${r.last_bot}` }, fmtAgo(r.last_ts), h("span", { className: "cell-sub", text: r.last_bot })),
        },
      ],
      d.rows,
      { sort: state.sort, onSort: (key) => this.onChange({ sort: key, offset: 0 }) }
    );

    const from = state.offset + 1;
    const to = state.offset + d.rows.length;
    const pager = h(
      "div",
      { className: "pager" },
      h("span", { text: `${fmtInt(from)}-${fmtInt(to)} of ${fmtInt(d.total)} pages` }),
      h(
        "div",
        { className: "pager-buttons" },
        h("button", { type: "button", className: "btn btn-ghost btn-sm", disabled: state.offset === 0, on: { click: () => this.onChange({ offset: Math.max(0, state.offset - PAGE_SIZE) }) } }, "← Previous"),
        h("button", { type: "button", className: "btn btn-ghost btn-sm", disabled: to >= d.total, on: { click: () => this.onChange({ offset: state.offset + PAGE_SIZE }) } }, "Next →")
      )
    );
    this.body.replaceChildren(table, pager);
  }
}

const params = () => ({ q: state.q, view: state.view, sort: state.sort, offset: String(state.offset), limit: String(PAGE_SIZE) });

export function renderPages(outlet) {
  outlet.append(
    reportHeader({
      title: "Pages",
      subtitle: "Every URL bots fetched in the period. Open one to see each version bots received.",
    })
  );
  const mount = h("div");
  outlet.append(mount);

  const table = new PagesTable(mount, provider, (patch) => {
    Object.assign(state, patch);
    table.params = params();
    const { from, to } = globalRange.get();
    table.load(from, to);
  });
  table.params = params();

  const dashboard = new Dashboard(globalRange);
  dashboard.add(table);
  dashboard.start();
  return () => dashboard.destroy();
}
