import { Chart } from "../core/chart.js";
import { card, emptyMessage, fmtCompact, fmtPct } from "../core/ui.js";

// Response Time Distribution — a stack of labeled horizontal bars splitting
// crawls into five fixed speed bands by response_time_ms, with each band's
// request count beneath the bar and a footer with the median and the 95th
// percentile below the list. Fed by ResponseTimeProvider
// (/api/response-time-distribution), which returns { buckets: [{ key, c }],
// median_ms, p95_ms, total } with the bands already ordered.
// Reuses the bar-list component (styles.css .bar-*) the status chart established.
//
// Colors run a green->red speed gradient: the two fast bands green, then amber,
// orange, and red, so slow traffic stands out at a glance. This array is the sole
// source of the row labels and is paired with the backend's buckets BY INDEX
// (both are fixed, same-length, same-order), so a label can change for display
// without silently breaking the count it maps to.
// The page may put a bot group switch in the header (`actions`, core/botGroup.js).
const BANDS = [
  { label: "<0.5s",  mod: "bar-fill-success" },
  { label: "0.5-1s", mod: "bar-fill-success" },
  { label: "1-2s",   mod: "bar-fill-warning" },
  { label: "2-5s",   mod: "bar-fill-warning-strong" },
  { label: "5s+",    mod: "bar-fill-error" },
];

const TITLE = "Response Time Distribution";

// Sub-second times read in ms ("433ms"); a second or more in seconds ("1.9s").
// Guard the boundary so 999.6ms rounds to "1.0s", not "1000ms".
const fmtDuration = (ms) =>
  Math.round(ms) < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;

export class ResponseTimeChart extends Chart {
  render(data) {
    // The endpoint always returns the five fixed bands, so an array-length check
    // never fires — a quiet range is total === 0. No data is not an error;
    // mirror the status chart's neutral empty message, not the red failure state.
    if (!data.total) {
      this.el.replaceChildren(card({ title: TITLE, actions: this.actions }, emptyMessage("No requests from these bots in this period.")));
      return;
    }

    const counts = BANDS.map((_, i) => data.buckets[i]?.c ?? 0);
    // Percentages are taken against the displayed bands' own sum, so the bars
    // always total ~100% even if COUNT(*) ever diverges from the band sum.
    const denom = counts.reduce((a, c) => a + c, 0);

    const list = document.createElement("div");
    list.className = "bar-list";
    BANDS.forEach((band, i) => list.appendChild(barRow(band, counts[i], denom)));

    const footer = document.createElement("div");
    footer.className = "bar-footer";
    footer.textContent = `Median ${fmtDuration(data.median_ms)} · 95th percentile ${fmtDuration(data.p95_ms)}`;

    // One body node holding the list and the footer.
    const body = document.createElement("div");
    body.append(list, footer);

    this.el.replaceChildren(card({ title: TITLE, actions: this.actions }, body));
  }
}

// One bar row: label | track(fill) | value, with a "<count> requests" line.
// A zero-count band gets an empty track (no fill node) so it reads as empty,
// matching the reference — .bar-fill's min-width would otherwise show a nub.
function barRow(band, count, denom) {
  const pct = denom ? (count / denom) * 100 : 0;

  const row = document.createElement("div");
  row.className = "bar-row";

  const main = document.createElement("div");
  main.className = "bar-main";

  const label = document.createElement("span");
  label.className = "bar-label";
  label.textContent = band.label;

  const track = document.createElement("div");
  track.className = "bar-track";
  if (count > 0) {
    const fill = document.createElement("div");
    fill.className = `bar-fill ${band.mod}`;
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
  }

  const value = document.createElement("span");
  value.className = "bar-value";
  value.textContent = fmtPct(pct);

  main.append(label, track, value);

  const meta = document.createElement("div");
  meta.className = "bar-meta";
  const span = document.createElement("span");
  span.textContent = `${fmtCompact(count)} request${count === 1 ? "" : "s"}`;
  meta.appendChild(span);

  row.append(main, meta);
  return row;
}
