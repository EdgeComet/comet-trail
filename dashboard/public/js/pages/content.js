// Evergreen Crawl > Content - titles, meta descriptions and H1s as bots
// received them, after EdgeComet's On-Page Tags report.
//
// One tab per tag (?tab=title|description|h1). Every indexable page gets one
// verdict per tag from its newest visit in the period, compared with its
// verdict in the period before, and every figure opens the pages behind it.
// One /api/content response feeds all three tabs through derive();
// /api/content-pages lists the pages behind a figure. Providers live at module
// scope so their cache survives switching tabs and navigating away and back.
import { globalRange } from "../core/dateRange.js";
import { Dashboard } from "../core/registry.js";
import { Chart } from "../core/chart.js";
import { Provider, derive } from "../core/provider.js";
import { reportHeader } from "../core/report.js";
import { h, card, badge, dataTable, emptyMessage, spinnerEl, errorEl, urlCell, deltaEl, fmtInt, fmtPct, fmtPct1 } from "../core/ui.js";
import { StatCardsChart } from "../charts/statCardsChart.js";
import { MovesChart } from "../charts/movesChart.js";

const provider = new Provider("content", "/api/content");
const pagesProvider = new Provider("contentPages", "/api/content-pages");

const TABS = {
  title: { label: "Title", noun: "title", plural: "titles", withTag: "a title" },
  description: { label: "Meta description", noun: "description", plural: "descriptions", withTag: "a description" },
  h1: { label: "H1", noun: "H1", plural: "H1s", withTag: "an H1" },
};

// Verdicts, in the precedence lib/content.js grades them in.
const VERDICTS = {
  missing: { label: "Missing", color: "var(--red)", variant: "error" },
  duplicated: { label: "Duplicated", color: "var(--orange)", variant: "warning" },
  multiple: { label: "Multiple H1s", color: "var(--violet)", variant: "violet" },
  too_long: { label: "Too long", color: "var(--amber)", variant: "" },
  too_short: { label: "Too short", color: "var(--blue)", variant: "info" },
  clean: { label: "Clean", color: "var(--green)", variant: "success" },
};

const MISSING_HINT = {
  title: "No <title>: Google writes one for the result page",
  description: "No meta description: Google picks a snippet from the page text",
  h1: "No H1: nothing on the page states what it is about",
};

function verdictHint(key, tag, limits) {
  switch (key) {
    case "missing": return MISSING_HINT[tag];
    case "duplicated": return `Another indexable page has the same ${TABS[tag].noun}, so the two compete for one query`;
    case "multiple": return "More than one H1 on the page";
    case "too_long": return `${limits.long} words or more: a sentence or a keyword list rather than a name`;
    case "too_short": return `${limits.short} words or fewer: too little to tell what the page is`;
    default: return "None of the problems above";
  }
}

function verdictLabel(key, limits) {
  if (key === "too_long") return `Too long (${limits.long}+ words)`;
  if (key === "too_short") return `Too short (1-${limits.short} words)`;
  return VERDICTS[key].label;
}

const verdictBadge = (key) => badge(VERDICTS[key]?.label ?? key, VERDICTS[key]?.variant ?? "");

// Title vs H1 buckets, in order of overlap. Only "unrelated" is a problem; a
// title that repeats its H1 word for word is a missed chance, not a defect.
const ALIGN = {
  identical: {
    label: "Title repeats the H1",
    color: "var(--amber)",
    hint: "The same words in both: the title could carry a qualifier or the brand the H1 has no room for",
  },
  near: {
    label: "Near-duplicate",
    color: "color-mix(in srgb, var(--amber) 55%, transparent)",
    hint: "Each carries at least 80% of the other's words: the same promise twice, one word swapped",
  },
  extends: {
    label: "Title extends the H1",
    color: "var(--green)",
    hint: "The title says what the H1 says and adds to it: a brand, a qualifier, a second keyword. The shape to aim for",
  },
  related: {
    label: "Same topic, other words",
    color: "color-mix(in srgb, var(--green) 55%, transparent)",
    hint: "The title carries 25-80% of the H1's words: one subject said two ways",
  },
  unrelated: {
    label: "Little shared wording",
    color: "var(--red)",
    hint: "The title carries under 25% of the H1's words: the click was made on a promise the page does not repeat, and Google may rewrite the title from the H1",
  },
  h1_missing: { label: "H1 missing", color: "var(--slate)", hint: "A title and no H1 to compare it with" },
  title_missing: {
    label: "Title missing",
    color: "color-mix(in srgb, var(--slate) 55%, var(--text-dark))",
    hint: "No title, so nothing to compare. A page with neither is counted here only",
  },
};

const CHECKS = {
  placeholder: { label: "Placeholder text", hint: "lorem ipsum, TODO or %% left in a title, description or H1" },
  soft_404: { label: "Reads as not found", hint: "answers 200, but its title or H1 says the page does not exist (a soft 404)" },
};

const FIELD_LABEL = { title: "Title", description: "Description", h1: "H1", slug: "URL slug" };

// --- Page lists (the pages behind a figure) ----------------------------------

const LIST_SIZE = 20;
const num = (n) => h("span", { className: n ? "" : "muted", text: fmtInt(n) });
const textCell = (v) => (v ? h("span", { className: "cell-text", title: v, text: v }) : h("span", { className: "muted", text: "none" }));

const PAGE_COL = { label: "Page", render: (r) => urlCell(r.url) };
const DEMAND_COLS = [
  { label: "Googlebot", num: true, render: (r) => num(r.googlebot) },
  { label: "AI user fetches", num: true, render: (r) => num(r.ai_user) },
];
const TITLE_H1_COLS = [
  PAGE_COL,
  { label: "Title", render: (r) => textCell(r.title) },
  { label: "H1", render: (r) => textCell(r.h1s[0]) },
  ...DEMAND_COLS,
];

const TAG_TEXT = { title: (r) => r.title, description: (r) => r.description, h1: (r) => r.h1s.join(" · ") };

function tagColumns(tag) {
  return [
    PAGE_COL,
    { label: TABS[tag].label, render: (r) => textCell(TAG_TEXT[tag](r)) },
    tag === "h1" ? { label: "H1s", num: true, render: (r) => num(r.h1s.length) } : null,
    { label: "Words", num: true, render: (r) => num(r.words) },
    ...DEMAND_COLS,
  ].filter(Boolean);
}

const CHECK_COLUMNS = {
  placeholder: [
    PAGE_COL,
    { label: "In", nowrap: true, render: (r) => FIELD_LABEL[r.placeholder?.field] ?? "-" },
    { label: "Text", render: (r) => textCell(r.placeholder?.value) },
    ...DEMAND_COLS,
  ],
  soft_404: TITLE_H1_COLS,
};

// A paged table of the pages behind one figure, built on demand when a figure
// is opened. Its owner keeps it while the period stays the same, so closing
// and reopening keeps the page position.
class PageList {
  constructor(range, { tag, filter, columns }) {
    this.range = range;
    this.query = { tag, filter };
    this.columns = columns;
    this.offset = 0;
    this.seq = 0;
    this.el = h("div", { className: "drill" });
    this.load();
  }

  async load() {
    const seq = ++this.seq;
    this.el.replaceChildren(spinnerEl());
    try {
      const d = await pagesProvider.get(this.range.from, this.range.to, {
        ...this.query,
        offset: String(this.offset),
        limit: String(LIST_SIZE),
      });
      if (seq === this.seq) this.render(d);
    } catch (err) {
      if (seq === this.seq) this.el.replaceChildren(errorEl(err.message));
    }
  }

  render(d) {
    this.offset = d.offset;
    if (!d.rows.length) {
      this.el.replaceChildren(emptyMessage("No pages."));
      return;
    }
    const to = d.offset + d.rows.length;
    const go = (offset) => { this.offset = offset; this.load(); };
    const pager =
      d.total > LIST_SIZE
        ? h(
            "div",
            { className: "pager" },
            h("span", { text: `${fmtInt(d.offset + 1)}-${fmtInt(to)} of ${fmtInt(d.total)} pages` }),
            h(
              "div",
              { className: "pager-buttons" },
              h("button", { type: "button", className: "btn btn-ghost btn-sm", disabled: d.offset === 0, on: { click: () => go(Math.max(0, d.offset - LIST_SIZE)) } }, "← Previous"),
              h("button", { type: "button", className: "btn btn-ghost btn-sm", disabled: to >= d.total, on: { click: () => go(d.offset + LIST_SIZE) } }, "Next →")
            )
          )
        : null;
    this.el.replaceChildren(...[dataTable(this.columns, d.rows), pager].filter(Boolean));
  }
}

// A chart whose figures open page lists. `open` is the key of the open figure;
// the list itself is kept until the period changes.
class DrillChart extends Chart {
  constructor(el, provider) {
    super(el, provider);
    this.open = null;
    this.list = null;
  }

  load(from, to) {
    if (this.range && (this.range.from !== from || this.range.to !== to)) this.list = null;
    this.range = { from, to };
    return super.load(from, to);
  }

  toggle(key) {
    this.open = this.open === key ? null : key;
    this.render(this.data);
  }

  // The list for the open figure, reused while it is the same one.
  listFor(key, spec) {
    if (!this.list || this.list.key !== key) this.list = { key, view: new PageList(this.range, spec) };
    return this.list.view.el;
  }
}

// --- Segmented bar (verdicts, title vs H1) -----------------------------------

const demandLine = (s) => `${fmtInt(s.googlebot)} Googlebot · ${fmtInt(s.ai_user)} AI fetches`;

// A titled card with one proportional bar over a legend. Each legend item
// opens the pages in its segment.
//   new SegmentsChart(el, provider, { title, subtitle, segments(d), spec(key), empty })
// segments(d) -> [{ key, label, color, hint, pages, googlebot, ai_user }]
class SegmentsChart extends DrillChart {
  constructor(el, provider, opts) {
    super(el, provider);
    this.opts = opts;
  }

  render(d) {
    this.data = d;
    const { title, subtitle, segments, spec, empty } = this.opts;
    const segs = segments(d);
    const total = segs.reduce((a, s) => a + s.pages, 0);
    if (!total) {
      this.el.replaceChildren(card({ title, subtitle }, emptyMessage(empty)));
      return;
    }
    if (this.open && !segs.some((s) => s.key === this.open && s.pages)) this.open = null;

    const bar = h(
      "div",
      { className: "analysis-bar", role: "img", "aria-label": segs.map((s) => `${s.label}: ${fmtInt(s.pages)}`).join(", ") },
      segs
        .filter((s) => s.pages)
        .map((s) =>
          h("div", {
            className: "analysis-seg",
            title: `${s.label}: ${fmtInt(s.pages)} pages (${fmtPct((s.pages / total) * 100)})`,
            style: { flexGrow: String(s.pages), background: s.color },
          })
        )
    );
    const legend = h(
      "div",
      { className: "analysis-legend" },
      segs.map((s) =>
        h(
          "button",
          {
            type: "button",
            className: `analysis-item${this.open === s.key ? " is-open" : ""}`,
            title: s.hint,
            disabled: !s.pages,
            "aria-expanded": String(this.open === s.key),
            on: { click: () => this.toggle(s.key) },
          },
          h(
            "span",
            { className: "analysis-legend-label" },
            h("span", { className: "analysis-legend-dot", style: { background: s.color } }),
            h("span", { text: s.label })
          ),
          h("span", { className: "analysis-legend-pct", text: fmtPct((s.pages / total) * 100) }),
          h("span", { className: "analysis-legend-count", text: `${fmtInt(s.pages)} page${s.pages === 1 ? "" : "s"}` }),
          s.pages ? h("span", { className: "analysis-legend-demand", text: demandLine(s) }) : null
        )
      )
    );
    const drill = this.open ? this.listFor(this.open, spec(this.open)) : null;
    this.el.replaceChildren(card({ title, subtitle }, bar, legend, drill));
  }
}

// --- Duplicate groups --------------------------------------------------------

function causeCell(row, tag) {
  const line = (strong, detail) =>
    h("div", { className: "cause" }, h("span", { className: "cause-label", text: strong }), h("span", { className: "cause-detail", text: detail }));
  switch (row.cause) {
    case "not_found":
      return line("Not-found pages", "they say they do not exist: answer 404 or 410 instead of rewriting the tag");
    case "url_variants":
      return line("URL variants", "same path, other query strings: canonicalize sort and filter URLs, number the pages of a list");
    case "template":
      return line(`Use the ${FIELD_LABEL[row.field]}`, `it differs from page to page: ${row.examples.join(" · ")}`);
    default:
      return line("No differentiator", `nothing recorded tells these pages apart: write each ${TABS[tag].noun} by hand, or merge the pages`);
  }
}

class ClustersChart extends DrillChart {
  constructor(el, provider, tag) {
    super(el, provider);
    this.tag = tag;
  }

  render(d) {
    this.data = d;
    const { tag } = this;
    const t = TABS[tag];
    const title = `Duplicate ${t.plural}`;
    const { groups, rows, other } = d.clusters;
    if (!groups) {
      this.el.replaceChildren(card({ title }, emptyMessage(`No two indexable pages share ${t.withTag}.`)));
      return;
    }
    const subtitle = `${fmtInt(groups)} group${groups === 1 ? "" : "s"}, one fix each, the most crawled first`;
    if (this.open && !rows.some((r) => r.id === this.open)) this.open = null;

    const head = h(
      "tr",
      {},
      h("th", { text: `Shared ${t.noun}` }),
      h("th", { className: "num", text: "Pages" }),
      h("th", { text: "Why, and the fix" }),
      h("th", { className: "num", text: "Googlebot" }),
      h("th", { className: "num", text: "AI user fetches" })
    );
    const body = [];
    for (const r of rows) {
      const isOpen = this.open === r.id;
      body.push(
        h(
          "tr",
          { className: isOpen ? "cluster-row is-open" : "cluster-row" },
          h(
            "td",
            {},
            h(
              "button",
              { type: "button", className: "cluster-toggle", "aria-expanded": String(isOpen), on: { click: () => this.toggle(r.id) } },
              h("span", { className: "cluster-caret", "aria-hidden": "true", text: isOpen ? "▾" : "▸" }),
              h(
                "span",
                { className: "cluster-value" },
                h("span", { className: "cell-text", title: r.value, text: r.value }),
                h("span", { className: "cell-sub", text: r.sections > 1 ? `${r.section} and ${r.sections - 1} more section${r.sections > 2 ? "s" : ""}` : r.section })
              )
            )
          ),
          h("td", { className: "num" }, h("span", { className: "num-strong", text: fmtInt(r.pages) })),
          h("td", {}, causeCell(r, tag)),
          h("td", { className: "num" }, num(r.googlebot)),
          h("td", { className: "num" }, num(r.ai_user))
        )
      );
      if (isOpen) {
        body.push(
          h(
            "tr",
            { className: "cluster-detail" },
            h("td", { colspan: "5" }, this.listFor(r.id, { tag, filter: `cluster:${r.id}`, columns: tagColumns(tag) }))
          )
        );
      }
    }
    if (other) {
      body.push(
        h(
          "tr",
          {},
          h(
            "td",
            { colspan: "5", className: "muted" },
            `and ${fmtInt(other.groups)} smaller groups: ${fmtInt(other.pages)} pages, ${fmtInt(other.googlebot)} Googlebot visits, ${fmtInt(other.ai_user)} AI user fetches`
          )
        )
      );
    }
    const table = h("div", { className: "table-wrap" }, h("table", { className: "data-table" }, h("thead", {}, head), h("tbody", {}, body)));
    this.el.replaceChildren(card({ title, subtitle, flush: true }, table));
  }
}

// --- Content checks ----------------------------------------------------------

class ChecksChart extends DrillChart {
  render(checks) {
    this.data = checks;
    if (this.open && !checks.some((c) => c.key === this.open && c.pages)) this.open = null;
    const rows = checks.map((c) => {
      const meta = CHECKS[c.key];
      const isOpen = this.open === c.key;
      const head = h(
        "button",
        {
          type: "button",
          className: `move ${c.pages ? "move-worse" : "move-better"}${isOpen ? " is-open" : ""}`,
          "aria-expanded": String(isOpen),
          disabled: !c.pages,
          on: { click: () => this.toggle(c.key) },
        },
        h("span", { className: "move-dir", text: c.pages ? "!" : "✓" }),
        h("span", { className: "move-path" }, h("strong", { text: meta.label }), h("span", { className: "muted", text: meta.hint })),
        h("span", { className: "move-pages", text: `${fmtInt(c.pages)} page${c.pages === 1 ? "" : "s"}` }),
        c.pages ? h("span", { className: "move-demand", text: `${fmtInt(c.googlebot)} Googlebot visits · ${fmtInt(c.ai_user)} AI user fetches` }) : null
      );
      const drill = isOpen
        ? h("div", { className: "check-drill" }, this.listFor(c.key, { tag: "title", filter: `check:${c.key}`, columns: CHECK_COLUMNS[c.key] }))
        : null;
      return h("div", {}, head, drill);
    });
    this.el.replaceChildren(card({ title: "Content checks", subtitle: "every indexable page, whichever tab is open" }, h("div", { className: "moves" }, rows)));
  }
}

// --- Cards and caption -------------------------------------------------------

function stripCards(tag, t) {
  const c = t.cards;
  const p = t.previous;
  const delta = (key) => deltaEl(c[key], p ? p[key] : null, { kind: "abs", good: "down" });
  const share = (n, of) => fmtPct1(of ? (n / of) * 100 : 0);
  const tab = TABS[tag];
  return [
    {
      label: "Duplicated",
      value: fmtInt(c.duplicated),
      delta: delta("duplicated"),
      foot: `${share(c.duplicated, c.present)} of ${fmtInt(c.present)} pages with ${tab.withTag}`,
    },
    tag === "h1"
      ? { label: "Multiple H1s", value: fmtInt(c.multiple), delta: delta("multiple"), foot: "more than one H1 on the page" }
      : {
          label: "Duplicate groups",
          value: fmtInt(c.groups),
          delta: delta("groups"),
          foot: c.groups ? "one fix each" : `every ${tab.noun} is unique`,
        },
    {
      label: "Missing",
      value: fmtInt(c.missing),
      delta: delta("missing"),
      foot: `${share(c.missing, c.graded)} of ${fmtInt(c.graded)} indexable pages`,
    },
    { label: "Too long", value: fmtInt(c.too_long), delta: delta("too_long"), foot: `${t.limits.long} words or more` },
  ];
}

// "524 indexable pages graded" beside the tabs, with what was left out.
class CaptionChart extends Chart {
  showLoading() {
    this.el.replaceChildren();
  }

  showError() {
    this.el.replaceChildren();
  }

  render(d) {
    const left = d.left.noindex + d.left.canonical;
    this.el.textContent = `${fmtInt(d.graded)} indexable pages graded`;
    if (left) {
      this.el.append(
        h("span", {
          className: "muted",
          title: `${fmtInt(d.left.noindex)} noindex · ${fmtInt(d.left.canonical)} canonical to another URL`,
          text: ` · ${fmtInt(left)} noindex or canonicalized left out`,
        })
      );
    }
  }
}

export function renderContent(outlet, params) {
  const tag = Object.hasOwn(TABS, params.get("tab") ?? "") ? params.get("tab") : "title";
  const tab = TABS[tag];
  const caption = h("span");
  outlet.append(
    reportHeader({
      title: "Content",
      subtitle: "Titles, meta descriptions and H1s of the indexable pages bots fetched, one verdict per page.",
      strip: {
        label: "Tag",
        tabs: Object.entries(TABS).map(([key, t]) => ({
          label: t.label,
          href: key === "title" ? "/content" : `/content?tab=${key}`,
          active: key === tag,
        })),
        trailing: caption,
      },
    })
  );

  const strip = h("div");
  const health = h("div", { className: "section" });
  const clusters = h("div", { className: "section" });
  const moves = h("div", { className: "section" });
  const alignment = tag === "description" ? null : h("div", { className: "section" });
  const checks = h("div", { className: "section" });
  outlet.append(...[strip, health, clusters, moves, alignment, checks].filter(Boolean));

  const tagData = derive(provider, (d) => d.tags[tag]);
  const dashboard = new Dashboard(globalRange);
  dashboard.add(new CaptionChart(caption, provider));
  dashboard.add(new StatCardsChart(strip, tagData, (t) => stripCards(tag, t)));
  dashboard.add(
    new SegmentsChart(health, tagData, {
      title: `${tab.label} health`,
      subtitle: "each page counted once, under the first verdict that applies, in this order",
      empty: "No indexable page answered 200 in this period.",
      segments: (t) =>
        t.verdicts.map((v) => ({
          ...v,
          label: verdictLabel(v.key, t.limits),
          color: VERDICTS[v.key].color,
          hint: verdictHint(v.key, tag, t.limits),
        })),
      spec: (key) => ({ tag, filter: `verdict:${key}`, columns: tagColumns(tag) }),
    })
  );
  dashboard.add(new ClustersChart(clusters, tagData, tag));
  dashboard.add(
    new MovesChart(moves, derive(provider, (d) => d.tags[tag].moves), {
      badge: verdictBadge,
      empty: `No ${tab.noun} change moved a page to another verdict between the two periods.`,
      foot: (m) =>
        `Pages whose own ${tab.noun} changed: ${fmtInt(m.changed)} of the ${fmtInt(m.both)} graded in both periods. ` +
        `${fmtInt(m.newly)} pages are graded only in this period, ${fmtInt(m.dropped)} only in the previous one.`,
    })
  );
  if (alignment) {
    dashboard.add(
      new SegmentsChart(alignment, derive(provider, (d) => d.alignment), {
        title: "Title vs H1",
        subtitle: "how much of the H1's wording the title repeats",
        empty: "No indexable page answered 200 in this period.",
        segments: (a) => a.buckets.map((b) => ({ ...b, ...ALIGN[b.key] })),
        spec: (key) => ({ tag, filter: `align:${key}`, columns: TITLE_H1_COLS }),
      })
    );
  }
  dashboard.add(new ChecksChart(checks, derive(provider, (d) => d.checks)));
  dashboard.start();

  return () => dashboard.destroy();
}
