// Small DOM helpers and formatters shared by every chart and page view.
// All text goes through textContent (never innerHTML), so values read from the
// database can't inject markup.

// Read a CSS custom property's computed value off :root, so charts (billboard,
// etc.) can pass the same palette tokens the stylesheet uses and track the theme.
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Element builder: h("a", { className: "x", href: "/y", text: "Go" }, child...).
// Known keys: className, text, style (object), dataset (object), on (event map);
// everything else becomes an attribute. Children may be nodes, strings or null.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "className") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "style") Object.assign(el.style, value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key === "on") for (const [ev, fn] of Object.entries(value)) el.addEventListener(ev, fn);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// A spinning indicator. Consumes the @keyframes spin in styles.css.
export function spinnerEl() {
  return h("div", { className: "spinner", role: "status", "aria-label": "Loading" });
}

// An inline error message (the red state, reserved for real failures).
export function errorEl(message) {
  return h("div", { className: "chart-error", role: "alert", text: `Failed to load: ${message}` });
}

// A neutral "no data" line (not the red error state) for a quiet range.
export function emptyMessage(text) {
  return h("p", { className: "empty-note", text });
}

// Card shell: header (title, optional subtitle, optional link or actions) and a
// body. `flush` drops the body padding for tables that draw their own edges.
export function card({ title, subtitle, link, actions, flush = false } = {}, ...body) {
  const header = title
    ? h(
        "div",
        { className: "card-header" },
        h(
          "div",
          { className: "card-heading" },
          h("h3", { className: "card-title", text: title }),
          subtitle ? h("span", { className: "card-subtitle", text: subtitle }) : null
        ),
        link ? h("a", { className: "card-link", href: link.href, "data-route": "", text: `${link.label} →` }) : null,
        actions ?? null
      )
    : null;
  return h(
    "div",
    { className: "card" },
    header,
    h("div", { className: flush ? "card-body-flush" : "card-body" }, ...body)
  );
}

// Titled card used by the bar-list charts: card > header + padded body.
export function titledCard(title, body) {
  return card({ title }, body);
}

// --- Formatters -------------------------------------------------------------

const NUM = new Intl.NumberFormat("en-US");

export const fmtInt = (n) => NUM.format(Math.round(Number(n) || 0));

// Compact count: 999 -> "999", 1200 -> "1.2K", 45700 -> "45.7K", 2.1M.
export function fmtCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(v));
}

// Percentage label. A small-but-nonzero slice reads "<1%", never rounding to 0%.
export function fmtPct(p) {
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}

export const fmtPct1 = (p) => `${(Number(p) || 0).toFixed(1)}%`;

export function fmtMs(ms) {
  const v = Number(ms) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}s` : `${Math.round(v)}ms`;
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const DATE_SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});

export const fmtDate = (ts) => DATE.format(new Date(ts));
export const fmtDay = (ts) => DATE_SHORT.format(new Date(ts));
export const fmtDateTime = (ts) => DATE_TIME.format(new Date(ts));

// "just now", "5 min ago", "3 h ago", "2 days ago", then a date.
export function fmtAgo(ts, now = Date.now()) {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d < 30 ? `${d} day${d === 1 ? "" : "s"} ago` : fmtDate(ts);
}

// The URL without scheme and host, which is what people scan for in a table.
export function shortUrl(url) {
  try {
    const u = new URL(url);
    return (u.pathname + u.search) || "/";
  } catch {
    return url;
  }
}

// --- Change against the previous period -------------------------------------

// Arrow + magnitude, colored by sentiment. kind "pct" compares relatively
// (+12.4%), "pp" compares percentages in points (+3.1pp), "abs" in units.
// `good` says which direction is healthy. Returns null when there is no fair
// comparison (no previous value, or a previous value of zero for "pct").
export function deltaEl(cur, prev, { kind = "pct", good = "up" } = {}) {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return null;
  let change;
  if (kind === "pct") {
    if (!prev) return null;
    change = ((cur - prev) / prev) * 100;
  } else {
    change = cur - prev;
  }
  const rounded = Math.abs(change) < 0.05 ? 0 : change;
  const unit = kind === "pct" ? "%" : kind === "pp" ? "pp" : "";
  const digits = kind === "abs" ? 0 : Math.abs(rounded) >= 100 ? 0 : 1;
  const text = `${Math.abs(rounded).toFixed(digits)}${unit}`;
  if (rounded === 0) return h("span", { className: "stat-delta", text: `0${unit}` });
  const up = rounded > 0;
  const healthy = (up && good === "up") || (!up && good === "down");
  const cls = good === "neutral" ? "stat-delta" : `stat-delta ${healthy ? "stat-delta-positive" : "stat-delta-negative"}`;
  return h("span", { className: cls, title: "vs previous period" }, up ? "↑ " : "↓ ", text);
}

// A KPI tile: label (+ optional "View →" link), big value with its change, and
// a footnote.
export function statCard({ label, value, delta = null, foot = "", href = null }) {
  return h(
    "div",
    { className: "stat-card" },
    h(
      "div",
      { className: "stat-head" },
      h("span", { className: "stat-label", text: label }),
      href ? h("a", { className: "stat-link", href, "data-route": "", text: "View →" }) : null
    ),
    h("div", { className: "stat-value-row" }, h("span", { className: "stat-value", text: value }), delta),
    foot ? h("div", { className: "stat-footnote", text: foot }) : null
  );
}

// --- Badges -----------------------------------------------------------------

export function badge(text, variant = "") {
  return h("span", { className: variant ? `badge badge-${variant}` : "badge", text });
}

export function statusBadge(status) {
  if (status === null || status === undefined) return badge("No response", "error");
  const variant = status < 300 ? "success" : status < 400 ? "info" : status < 500 ? "warning" : "error";
  return badge(String(status), variant);
}

// Indexability buckets (dashboard/lib/sql.js PAGE_BUCKET_SQL) and the visit-level
// index_status values, with their badge colors.
export const BUCKETS = {
  indexable: { label: "Indexable", variant: "success", token: "--idx-indexable" },
  noindex: { label: "Noindex", variant: "error", token: "--idx-noindex" },
  canonical: { label: "Canonical to other", variant: "violet", token: "--idx-canonical" },
  redirect: { label: "Redirect 3xx", variant: "info", token: "--idx-redirect" },
  client_error: { label: "4xx client error", variant: "warning", token: "--idx-4xx" },
  server_error: { label: "5xx server error", variant: "error", token: "--idx-5xx" },
  other: { label: "Other non-200", variant: "", token: "--slate" },
};

export function bucketBadge(bucket) {
  const b = BUCKETS[bucket] ?? { label: bucket, variant: "" };
  return badge(b.label, b.variant);
}

// --- Links ------------------------------------------------------------------

export const pageHref = (url) => `/page?url=${encodeURIComponent(url)}`;

// A URL cell: the path as a link to its page view, optional muted line below.
export function urlCell(url, sub = null) {
  return h(
    "div",
    { className: "cell-url" },
    h("a", { className: "url-link", href: pageHref(url), "data-route": "", title: url, text: shortUrl(url) }),
    sub ? h("span", { className: "cell-sub", title: sub, text: sub }) : null
  );
}

// --- Tables -----------------------------------------------------------------

// columns: [{ label, num?, render(row) -> Node|string, sortKey? }]
export function dataTable(columns, rows, { sort = null, onSort = null } = {}) {
  const head = h(
    "tr",
    {},
    columns.map((c) => {
      const sortable = Boolean(c.sortKey && onSort);
      const th = h("th", {
        className: [c.num ? "num" : "", sortable ? "sortable" : "", sort === c.sortKey && sortable ? "sorted" : ""]
          .filter(Boolean)
          .join(" "),
        text: sort === c.sortKey && sortable ? `${c.label} ↓` : c.label,
      });
      if (sortable) th.addEventListener("click", () => onSort(c.sortKey));
      return th;
    })
  );
  const body = rows.map((row) =>
    h(
      "tr",
      {},
      columns.map((c) => {
        const v = c.render(row);
        return h("td", { className: [c.num ? "num" : "", c.nowrap ? "nowrap" : ""].filter(Boolean).join(" ") }, v);
      })
    )
  );
  return h("div", { className: "table-wrap" }, h("table", { className: "data-table" }, h("thead", {}, head), h("tbody", {}, body)));
}

// A "nothing here yet" card. `items` is an optional list of steps.
export function emptyState(lead, items = []) {
  return h(
    "div",
    { className: "card empty-state" },
    h(
      "div",
      { className: "card-body" },
      h("p", { className: "empty-state-lead", text: lead }),
      items.length ? h("ul", { className: "empty-state-list" }, items.map((i) => h("li", {}, i))) : null
    )
  );
}

// Inline SVG icons (Lucide shapes, stroke = currentColor).
const ICONS = {
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  chartLine: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>',
  treePine: '<path d="m17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z"/><path d="M12 22v-3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7M19 12H5"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
};

export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name] ?? ""; // static, trusted markup from the map above
  return svg;
}

// Round axis ticks for counts: [0, step, 2*step, ...] covering `max` with
// about `count` intervals, where step is 1, 2, 2.5 or 5 times a power of ten. Billboard's own
// ticks split the range evenly and land on values like 136.4.
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  // Counts never need a step below 1 (a peak of 2 would otherwise tick 0.5).
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw));
  const ticks = [];
  for (let v = 0; v < max + step; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}
