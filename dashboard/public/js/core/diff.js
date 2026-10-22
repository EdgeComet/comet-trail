// Renders field values and before/after changes the way EdgeComet's Page
// Analysis does: removed lines marked "-" in red, added lines "+" in green, and
// for lists only the items that came or went, plus how many stayed.
import { h, BUCKETS } from "./ui.js";

const NONE = "(none)";

// Display text for one value of a tracked field.
export function formatValue(field, value) {
  if (field === "status") return value === null || value === undefined ? "No response" : String(value);
  if (field === "bucket") return BUCKETS[value]?.label ?? String(value);
  if (Array.isArray(value)) return value.length ? value.join(", ") : NONE;
  return value === null || value === undefined || value === "" ? NONE : String(value);
}

function line(sign, text) {
  return h(
    "div",
    { className: `diff-line ${sign === "-" ? "diff-del" : "diff-add"}` },
    h("span", { className: "diff-sign", text: sign }),
    h("span", { text })
  );
}

// { field, before, after, list } -> a -/+ block.
export function diffEl({ field, before, after, list = false }) {
  if (!list) {
    return h("div", { className: "diff" }, line("-", formatValue(field, before)), line("+", formatValue(field, after)));
  }
  const prev = before ?? [];
  const next = after ?? [];
  const removed = prev.filter((x) => !next.includes(x));
  const added = next.filter((x) => !prev.includes(x));
  const kept = next.length - added.length;
  const rows = [...removed.map((x) => line("-", x)), ...added.map((x) => line("+", x))];
  if (!rows.length) rows.push(h("div", { className: "diff-note", text: "reordered" }));
  if (kept > 0) rows.push(h("div", { className: "diff-note", text: `${kept} unchanged` }));
  return h("div", { className: "diff" }, rows);
}

// A value cell: lists one item per line, scalars as text.
export function valueEl(field, value) {
  if (Array.isArray(value) && value.length > 1) {
    return h("div", { className: "kv-list" }, value.map((x) => h("div", { text: x })));
  }
  const text = formatValue(field, value);
  return h("span", { className: text === NONE ? "muted" : "", text });
}
