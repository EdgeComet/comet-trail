import { Chart } from "../core/chart.js";
import { h, card, badge, bucketBadge, BUCKETS, dataTable, emptyMessage, urlCell, fmtInt, fmtPct } from "../core/ui.js";

// Canonical Analysis - where the canonicals that point to another URL lead,
// and whether those targets are good. Three cards share one /api/canonical-
// analysis response (see that file for the rules):
//   CanonicalSummaryChart   pages that answered 200, by their canonical: self,
//                           to another URL (parameter and clean URLs), missing
//   CanonicalTargetsChart   the state of the targets, per kind of URL
//   CanonicalProblemsChart  the pages worth a look, most Googlebot visits first

// Target states, in the order the API sends them. Fetched targets reuse the
// Indexability table's labels and colors (core/ui.js BUCKETS).
const TARGETS = {
  indexable: { ...BUCKETS.indexable, hint: "the canonical works" },
  redirect: { ...BUCKETS.redirect, hint: "point it at the final URL" },
  error: { label: "4xx or 5xx", variant: "warning", hint: "or another non-200" },
  noindex: { ...BUCKETS.noindex, hint: "asks not to be indexed" },
  canonical: { ...BUCKETS.canonical, hint: "a chain of canonicals" },
  unknown: { label: "Not fetched", variant: "", hint: "by no bot in this period" },
  external: { label: "Other host", variant: "", hint: "or protocol: check it is intended" },
};

const targetBadge = (state) => badge(TARGETS[state].label, TARGETS[state].variant);

// A count that needs a look stands out; a zero is muted.
const num = (n, strong) => h("span", { className: strong && n > 0 ? "num-strong" : n ? "" : "muted", text: fmtInt(n) });
const plural = (n, word) => `${fmtInt(n)} ${word}${n === 1 ? "" : "s"}`;

// --- Pages by canonical -------------------------------------------------------

const SUMMARY_TITLE = "Canonical Analysis";
const SUMMARY_SUB = "pages that answered 200, by their canonical";

export class CanonicalSummaryChart extends Chart {
  render({ pages }) {
    if (!pages.total) {
      this.el.replaceChildren(card({ title: SUMMARY_TITLE, subtitle: SUMMARY_SUB }, emptyMessage("No page answered 200 in this period.")));
      return;
    }
    const { param, clean } = pages.elsewhere;
    const rows = [
      { label: "Self-canonical", mod: "bar-fill-success", n: pages.self, meta: plural(pages.self, "page") },
      { label: "To another URL", mod: "bar-fill-purple", n: param + clean, meta: `${plural(param, "parameter URL")} · ${plural(clean, "clean URL")}` },
      { label: "Missing", mod: "bar-fill-warning", n: pages.missing, meta: plural(pages.missing, "page") },
    ];
    const list = h(
      "div",
      { className: "bar-list" },
      rows.map((r) => {
        const pct = (r.n / pages.total) * 100;
        return h(
          "div",
          { className: "bar-row" },
          h(
            "div",
            { className: "bar-main" },
            h("span", { className: "bar-label", text: r.label }),
            // An empty track for a zero: .bar-fill's min-width would show a nub.
            h("div", { className: "bar-track" }, r.n ? h("div", { className: `bar-fill ${r.mod}`, style: { width: `${pct}%` } }) : null),
            h("span", { className: "bar-value", text: fmtPct(pct) })
          ),
          h("div", { className: "bar-meta" }, h("span", { text: r.meta }))
        );
      })
    );
    // Why "To another URL" can exceed the Indexability table's "Canonical to
    // other": there a noindex outranks the canonical.
    const foot = h("div", { className: "card-footer", text: "Judged by the canonical alone, so noindex pages count here too." });
    this.el.replaceChildren(card({ title: SUMMARY_TITLE, subtitle: SUMMARY_SUB, flush: true }, h("div", { className: "card-body" }, list), foot));
  }
}

// --- Where the canonicals lead ------------------------------------------------

const TARGETS_TITLE = "Where canonicals lead";
const TARGETS_SUB = "each target judged by its own newest visit";

export class CanonicalTargetsChart extends Chart {
  render({ pages, targets }) {
    if (!pages.elsewhere.param && !pages.elsewhere.clean) {
      this.el.replaceChildren(card({ title: TARGETS_TITLE, subtitle: TARGETS_SUB }, emptyMessage("No canonical points to another URL.")));
      return;
    }
    const table = dataTable(
      [
        {
          label: "Target",
          render: (t) => h("span", { className: "inline-dot" }, targetBadge(t.key), h("span", { className: "target-hint", text: TARGETS[t.key].hint })),
        },
        // Parameter URLs canonicalized to an indexable page are what filters
        // and sorts should do; everything else needs a look.
        { label: "Parameter URLs", num: true, render: (t) => num(t.param, t.key !== "indexable") },
        { label: "Clean URLs", num: true, render: (t) => num(t.clean, true) },
      ],
      targets
    );
    const foot = h("div", { className: "card-footer", text: "Parameter URLs (filters, sorts) that point to an indexable page are expected." });
    this.el.replaceChildren(card({ title: TARGETS_TITLE, subtitle: TARGETS_SUB, flush: true }, table, foot));
  }
}

// --- The pages worth a look ---------------------------------------------------

const PROBLEMS_TITLE = "Canonicals to check";
const PROBLEMS_SUB = "targets that are not indexable, and clean URLs canonicalized away; most Googlebot visits first";
const SHOWN = 8;

// The target as a link to its time machine, except one on another host.
function targetCell(r) {
  if (r.state === "external") return h("div", { className: "cell-url" }, h("span", { className: "cell-sub", title: r.target, text: r.target }));
  return urlCell(r.target);
}

const PROBLEM_COLUMNS = [
  { label: "Page", render: (r) => urlCell(r.url, r.param ? "parameter URL" : "clean URL") },
  { label: "Canonical points to", render: targetCell },
  { label: "Target", nowrap: true, render: (r) => (r.bucket ? bucketBadge(r.bucket) : targetBadge(r.state)) },
  { label: "Googlebot", num: true, render: (r) => fmtInt(r.googlebot) },
];

export class CanonicalProblemsChart extends Chart {
  constructor(el, provider) {
    super(el, provider);
    this.showAll = false;
  }

  // The card is drawn again, so the new button takes the focus.
  toggle() {
    this.showAll = !this.showAll;
    this.render(this.data);
    this.el.querySelector(".card-footer button")?.focus();
  }

  render(d) {
    this.data = d;
    const { total, rows } = d.problems;
    if (!total) {
      const none = "Every canonical that points to another URL leads to an indexable page, and comes from a parameter URL.";
      this.el.replaceChildren(card({ title: PROBLEMS_TITLE, subtitle: PROBLEMS_SUB }, emptyMessage(none)));
      return;
    }
    const shown = this.showAll ? rows : rows.slice(0, SHOWN);
    const more =
      rows.length > SHOWN
        ? h(
            "div",
            { className: "card-footer" },
            h(
              "button",
              { type: "button", className: "btn btn-ghost btn-sm", on: { click: () => this.toggle() } },
              this.showAll ? "Show fewer" : `Show all ${fmtInt(total)} pages`
            ),
            this.showAll && total > rows.length ? h("span", { className: "muted", text: ` the ${fmtInt(rows.length)} with the most Googlebot visits` }) : null
          )
        : null;
    this.el.replaceChildren(card({ title: PROBLEMS_TITLE, subtitle: PROBLEMS_SUB, flush: true }, dataTable(PROBLEM_COLUMNS, shown), more));
  }
}
