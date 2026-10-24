// Evergreen Crawl > Changes - every change bots saw on the site, dated by the
// first visit that showed it. Nobody has to log a release: a template change,
// a plugin update or a hotfix shows up here because a bot received it.
//
// One /api/changes response feeds every card through derive(). The provider
// is shared with the change markers on other reports (core/changeMarkers.js),
// so coming here after them costs no second run of the query.
import { globalRange } from "../core/dateRange.js";
import { Dashboard } from "../core/registry.js";
import { Chart } from "../core/chart.js";
import { derive } from "../core/provider.js";
import { reportHeader } from "../core/report.js";
import { h, card, dataTable, emptyMessage, urlCell, fmtInt, fmtDate, fmtDay, fmtDateTime, fmtAgo } from "../core/ui.js";
import { diffEl } from "../core/diff.js";
import { StatCardsChart } from "../charts/statCardsChart.js";
import { TimeSeriesChart } from "../charts/timeSeriesChart.js";
import { changesProvider as provider } from "../providers/changesProvider.js";

// Chart colors per field.
const FIELD_TOKENS = {
  status: "--slate",
  title: "--blue",
  meta_description: "--cyan",
  canonical: "--violet",
  meta_robots: "--red",
  h1: "--orange",
  h2: "--amber",
  hreflangs: "--pink",
  structured_data_types: "--lime",
};

function summaryCards(d) {
  const top = Object.entries(d.totals.by_field).sort((a, b) => b[1] - a[1])[0];
  const label = (key) => d.series.series.find((s) => s.key === key)?.label ?? key;
  const biggest = d.events.length ? [...d.events].sort((a, b) => b.pages - a.pages)[0] : null;
  return [
    { label: "Changes", value: fmtInt(d.totals.changes), foot: "field changes bots received" },
    { label: "Pages changed", value: fmtInt(d.totals.pages), foot: "at least one change", href: "/pages" },
    {
      label: "Most changed field",
      value: top ? label(top[0]) : "-",
      foot: top ? `${fmtInt(top[1])} changes` : "no changes",
    },
    {
      label: "Biggest event",
      value: biggest ? `${fmtInt(biggest.pages)} pages` : "-",
      foot: biggest ? `${biggest.label}, ${fmtDay(biggest.start)}` : "no change hit many pages at once",
    },
  ];
}

// --- Change events: one field changing on many pages within days -------------

// The response holds the biggest events of each field, for the change markers;
// the card lists the biggest of them all, newest first.
const MAX_EVENTS = 8;

class EventsChart extends Chart {
  render(d) {
    const title = "Change events";
    const subtitle = "one field changed on many pages within a few days: usually a release";
    if (!d.events.length) {
      this.el.replaceChildren(card({ title, subtitle }, emptyMessage("No change reached several pages at once in this period.")));
      return;
    }
    const biggest = [...d.events].sort((a, b) => b.pages - a.pages).slice(0, MAX_EVENTS).sort((a, b) => b.start - a.start);
    const items = biggest.map((e) => {
      const when = fmtDay(e.start) === fmtDay(e.end) ? fmtDate(e.start) : `${fmtDay(e.start)} - ${fmtDate(e.end)}`;
      return h(
        "div",
        { className: "event" },
        h(
          "div",
          { className: "event-head" },
          h("span", { className: "event-field", text: e.label }),
          e.kind ? h("span", { className: "event-kind", text: e.kind }) : null,
          h("span", { className: "event-pages", text: `${fmtInt(e.pages)} pages` })
        ),
        h("div", { className: "event-when", text: `${when} · first seen as bots revisited each page` }),
        h(
          "div",
          { className: "event-example" },
          h("span", { className: "muted", text: "e.g. " }),
          urlCell(e.example.url),
          diffEl({ field: e.field, before: e.example.before, after: e.example.after, list: e.list })
        )
      );
    });
    this.el.replaceChildren(card({ title, subtitle }, h("div", { className: "events" }, items)));
  }
}

// --- Change log: the newest changes, filterable by field ----------------------

class ChangeLogChart extends Chart {
  constructor(el, provider) {
    super(el, provider);
    this.field = "all";
    this.limit = 30;
  }

  render(d) {
    this.data = d;
    const fields = d.series.series.filter((s) => d.totals.by_field[s.key]);
    const chips = h(
      "div",
      { className: "chips" },
      [{ key: "all", label: "All fields" }, ...fields].map((f) =>
        h(
          "button",
          {
            type: "button",
            className: f.key === this.field ? "chip active" : "chip",
            "aria-pressed": String(f.key === this.field),
            on: { click: () => { this.field = f.key; this.limit = 30; this.render(this.data); } },
          },
          f.label,
          h("span", { className: "chip-count", text: fmtInt(f.key === "all" ? d.totals.changes : d.totals.by_field[f.key]) })
        )
      )
    );
    const matching = d.recent.filter((c) => this.field === "all" || c.field === this.field);
    const rows = matching.slice(0, this.limit);
    const body = rows.length
      ? dataTable(
          [
            { label: "When", nowrap: true, render: (c) => h("span", { title: fmtDateTime(c.ts), text: fmtAgo(c.ts) }) },
            { label: "Page", render: (c) => urlCell(c.url) },
            { label: "Field", nowrap: true, render: (c) => c.label },
            { label: "Change", render: (c) => diffEl(c) },
            { label: "First seen by", nowrap: true, render: (c) => c.bot_name },
          ],
          rows
        )
      : emptyMessage("No changes of this kind among the newest ones.");
    const more = matching.length > rows.length
      ? h(
          "div",
          { className: "pager" },
          h("span", { text: `${fmtInt(rows.length)} of ${fmtInt(matching.length)} newest changes` }),
          h("button", { type: "button", className: "btn btn-ghost btn-sm", on: { click: () => { this.limit += 50; this.render(this.data); } } }, "Show more")
        )
      : null;
    this.el.replaceChildren(
      card(
        { title: "Change log", subtitle: "newest first", flush: true },
        h("div", { className: "table-toolbar" }, chips),
        body,
        more
      )
    );
  }
}

export function renderChanges(outlet) {
  outlet.append(
    reportHeader({
      title: "Changes",
      subtitle: "Every change bots received, dated by the first visit that showed it. No release log needed.",
    })
  );

  const summary = h("div");
  const chart = h("div", { className: "section" });
  const events = h("div", { className: "section" });
  const log = h("div", { className: "section" });
  outlet.append(summary, chart, events, log);

  const dashboard = new Dashboard(globalRange);
  dashboard.add(new StatCardsChart(summary, provider, summaryCards));
  dashboard.add(
    new TimeSeriesChart(chart, derive(provider, (d) => d.series), {
      title: "Changes per day",
      subtitle: "by field",
      type: "bar",
      height: 240,
      hideEmpty: true,
      token: (key) => FIELD_TOKENS[key] ?? "--slate",
      empty: "Bots received the same pages all period: no changes.",
    })
  );
  dashboard.add(new EventsChart(events, provider));
  dashboard.add(new ChangeLogChart(log, provider));
  dashboard.start();

  return () => dashboard.destroy();
}
