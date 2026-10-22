// Content grading: one verdict per page for each tag (title, meta description,
// H1), the duplicate groups behind them, the title-vs-H1 alignment and two
// page checks. Shared by /api/content (the report) and /api/content-pages (the
// pages behind one of its figures), so a list always holds exactly the pages
// its figure counted.
//
// Rules, after EdgeComet's On-Page Tags report:
//   - Graded pages are those whose newest settled visit in the period was a 200
//     and indexable. A noindex page, or one that canonicalizes elsewhere, is not
//     competing in search: sort and filter URLs legitimately share their
//     category's title.
//   - Lengths count words, splitting on everything that is not a letter or a
//     digit, so the "|" and "-" that titles are glued with are not words.
//   - A value is duplicated when two or more graded pages carry it, compared
//     trimmed, lowercased and with runs of whitespace collapsed.
//   - Each page gets one verdict per tag: the first of VERDICTS that applies, so
//     the verdicts of a tag add up to the graded pages.
import { HttpError, parseJsonList } from "./api.js";
import { NEWEST_SETTLED_SQL, SECTION_SQL } from "./sql.js";
import { botNamesSql, isGooglebot } from "../../shared/bots.js";

const GOOGLEBOT = botNamesSql(isGooglebot);
const AI_USER = botNamesSql((b) => b.purpose === "user");

// Each URL's newest settled visit in [?1, ?2], with how often Googlebot and AI
// assistants fetched it in the period. A non-200 page has no tags to grade; the
// indexability split happens in JS so the pages left out can be counted.
const SNAPSHOT_SQL = `
  SELECT url, index_status, title, meta_description, h1, ${SECTION_SQL} AS section, g, a FROM (
    SELECT url, status, index_status, title, meta_description, h1,
           SUM(CASE WHEN bot_name IN ${GOOGLEBOT} THEN 1 ELSE 0 END) OVER (PARTITION BY url) AS g,
           SUM(CASE WHEN bot_name IN ${AI_USER} THEN 1 ELSE 0 END) OVER (PARTITION BY url) AS a,
           ROW_NUMBER() OVER (PARTITION BY url ORDER BY ${NEWEST_SETTLED_SQL}) AS rn
      FROM crawls
     WHERE ts BETWEEN ?1 AND ?2)
   WHERE rn = 1 AND status = 200`;

// Per tag: how to read it, the word lines (EdgeComet's: a title or H1 of 16+
// words is a sentence or a keyword stack, a description of 50+ words is about
// twice what a result page shows, a title of 1-2 words names no page), and the
// fields that could tell two pages with the same value apart, in order of
// preference.
export const TAGS = {
  title: { read: (p) => p.title, long: 16, short: 2, by: ["h1", "slug"] },
  description: { read: (p) => p.description, long: 50, by: ["h1", "title", "slug"] },
  h1: { read: (p) => p.h1, long: 16, by: ["title", "slug"], multiple: true },
};

const FIELDS = {
  title: (p) => p.title,
  description: (p) => p.description,
  h1: (p) => p.h1,
  slug: (p) => p.slug,
};

// Verdicts in precedence order. "multiple" applies to the H1 only and
// "too_short" to the title only.
const VERDICTS = ["missing", "duplicated", "multiple", "too_long", "too_short", "clean"];

export function verdictsOf(tag) {
  const def = TAGS[tag];
  return VERDICTS.filter((v) => (v !== "multiple" || def.multiple) && (v !== "too_short" || def.short));
}

// A field tells the pages of a group apart when it has at least half as many
// distinct values as the group has pages (EdgeComet's t_diff), and always
// needs two values: in a two-page group one shared value would otherwise pass.
const DIFF_FLOOR = 0.5;
const differentiates = (distinct, present) => present > 0 && distinct >= 2 && distinct / present >= DIFF_FLOOR;

// How many duplicate groups the report lists; the rest are summed in `other`.
const CLUSTER_ROWS = 25;
const VALUE_MAX = 240;

// Title vs H1: the share of the H1's words the title repeats (cover) and of the
// title's words the H1 repeats (back). Under `align` they share almost no
// wording; at `near` and above both ways they say the same thing twice.
export const ALIGN_FLOORS = { align: 0.25, near: 0.8 };
export const ALIGN_BUCKETS = ["identical", "near", "extends", "related", "unrelated", "h1_missing", "title_missing"];

// Text nobody ships on purpose (EdgeComet's placeholder check), and the words
// of a page that tells the visitor it does not exist while answering 200. A
// bare "404" only counts at the start ("404 - Page not found"), so an article
// about fixing 404 errors is not one.
const PLACEHOLDER = [/lorem ipsum/i, /\bTODO\b/, /%%/];
const NOT_FOUND = /\bnot found\b|\bno longer available\b|\bdoes(?: not|n['’]t) exist\b|^\s*(?:error\s*)?404\b/i;

// --- Loading ------------------------------------------------------------------

const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

function toPage(r) {
  const h1s = parseJsonList(r.h1).map(text).filter(Boolean);
  let path = "/";
  try {
    path = new URL(r.url).pathname;
  } catch {
    // A malformed URL keeps "/" and groups with nothing in particular.
  }
  const segments = path.split("/").filter(Boolean);
  const title = text(r.title);
  const description = text(r.meta_description);
  const h1 = h1s[0] ?? null;
  return {
    url: r.url,
    section: r.section,
    path,
    slug: segments.length ? segments[segments.length - 1] : null,
    title,
    description,
    h1,
    h1s,
    // Each tag normalized once, for duplicate groups and for comparing the
    // periods (`h1s`: every H1, so a second one appearing is a change). The
    // report grades every page several times; on the free plan's 10 ms of CPU
    // per request this is the difference that counts.
    keys: {
      title: title && norm(title),
      description: description && norm(description),
      h1: h1 && norm(h1),
      h1s: h1s.map(norm).join("\n"),
    },
    googlebot: r.g ?? 0,
    ai_user: r.a ?? 0,
  };
}

// The graded pages of a period, and how many 200 pages were left out.
export async function loadPages(env, from, to) {
  const { results } = await env.DB.prepare(SNAPSHOT_SQL).bind(from, to).all();
  const pages = [];
  const left = { noindex: 0, canonical: 0 };
  for (const r of results ?? []) {
    if (r.index_status === "indexable") pages.push(toPage(r));
    else if (r.index_status === "blocked_by_meta") left.noindex++;
    else if (r.index_status === "non_canonical") left.canonical++;
  }
  return { pages, left };
}

// --- Grading ------------------------------------------------------------------

export const wordCount = (s) => (s ? s.match(/[\p{L}\p{N}]+/gu)?.length ?? 0 : 0);
// Values arrive trimmed (text() above); the whitespace regex only runs on the
// few that hold a double space, a tab or a line break.
const norm = (s) => (/\s\s|[^\S ]/.test(s) ? s.replace(/\s+/g, " ") : s).toLowerCase();

const byDemand = (a, b) => b.googlebot - a.googlebot || b.ai_user - a.ai_user || (a.url < b.url ? -1 : 1);

// One tag over a set of pages: each page's verdict, and the groups of pages
// that share a value.
export function gradeTag(pages, tag) {
  const def = TAGS[tag];
  const groups = new Map(); // normalized value -> pages carrying it
  for (const p of pages) {
    const key = p.keys[tag];
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const verdict = new Map(); // url -> verdict
  for (const p of pages) {
    const key = p.keys[tag];
    let out;
    if (!key) out = "missing";
    else if (groups.get(key).length > 1) out = "duplicated";
    else if (def.multiple && p.h1s.length > 1) out = "multiple";
    else {
      const words = wordCount(def.read(p));
      out = words >= def.long ? "too_long" : def.short && words <= def.short ? "too_short" : "clean";
    }
    verdict.set(p.url, out);
  }
  const dups = [...groups].filter(([, list]) => list.length > 1);
  return { verdict, dups };
}

// A short stable id for a duplicate group (FNV-1a), so the page list can ask
// for one group without sending a description back as a query parameter.
export function clusterId(tag, key) {
  let hash = 0x811c9dc5;
  const s = `${tag}:${key}`;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export const readsNotFound = (p) => Boolean((p.title && NOT_FOUND.test(p.title)) || (p.h1 && NOT_FOUND.test(p.h1)));

export function placeholderIn(p) {
  for (const field of ["title", "description", "h1"]) {
    const v = p[field];
    if (v && PLACEHOLDER.some((re) => re.test(v))) return { field, value: v };
  }
  return null;
}

// Why a group of pages carries one value, and what would tell them apart
// (EdgeComet's duplication causes, minus "duplicate pages", which needs the
// page body; CometTrail does not store it):
//   not_found          every page reads as "not found": the fix is a 404 or
//                      410 status, and new tags would only hide the problem
//   url_variants       one path under several query strings: the fix is a
//                      canonical or noindex on the variants, not new tags
//   template           another field already differs from page to page, so
//                      the template can use it (`field`, with `examples`)
//   no_differentiator  nothing recorded tells these pages apart
function causeOf(tag, pages) {
  if (pages.every(readsNotFound)) return { cause: "not_found" };
  if (!differentiates(new Set(pages.map((p) => p.path)).size, pages.length)) return { cause: "url_variants" };
  let best = null;
  for (const field of TAGS[tag].by) {
    // Measured against the whole group: an H1 that differs on the two pages
    // that have one says nothing about the eight that do not.
    const values = pages.map(FIELDS[field]).filter(Boolean);
    const distinct = new Map(values.map((v) => [norm(v), v]));
    if (!differentiates(distinct.size, pages.length)) continue;
    const share = distinct.size / pages.length;
    // Strictly greater: a tie keeps the earlier, preferred field.
    if (!best || share > best.share) best = { field, share, examples: [...distinct.values()].slice(0, 3) };
  }
  return best ? { cause: "template", field: best.field, examples: best.examples } : { cause: "no_differentiator" };
}

function sum(pages, key) {
  let n = 0;
  for (const p of pages) n += p[key];
  return n;
}

function topSection(pages) {
  const counts = new Map();
  for (const p of pages) counts.set(p.section, (counts.get(p.section) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
}

function clusterRows(tag, dups) {
  const rows = dups.map(([key, list]) => {
    const pages = [...list].sort(byDemand);
    const value = TAGS[tag].read(pages[0]);
    return {
      id: clusterId(tag, key),
      value: value.length > VALUE_MAX ? `${value.slice(0, VALUE_MAX)}…` : value,
      pages: pages.length,
      sections: new Set(pages.map((p) => p.section)).size,
      section: topSection(pages),
      googlebot: sum(pages, "googlebot"),
      ai_user: sum(pages, "ai_user"),
      ...causeOf(tag, pages),
    };
  });
  rows.sort((a, b) => b.googlebot - a.googlebot || b.ai_user - a.ai_user || b.pages - a.pages || (a.value < b.value ? -1 : 1));
  const rest = rows.slice(CLUSTER_ROWS);
  return {
    groups: rows.length,
    rows: rows.slice(0, CLUSTER_ROWS),
    other: rest.length
      ? { groups: rest.length, pages: sum(rest, "pages"), googlebot: sum(rest, "googlebot"), ai_user: sum(rest, "ai_user") }
      : null,
  };
}

// The cards on top of a tab. Every page count is one of the verdicts, so a
// card always equals its segment of the bar below it.
function cardsOf(tag, pages, graded) {
  const count = (v) => {
    let n = 0;
    for (const x of graded.verdict.values()) if (x === v) n++;
    return n;
  };
  return {
    graded: pages.length,
    present: pages.filter((p) => TAGS[tag].read(p)).length,
    duplicated: count("duplicated"),
    groups: graded.dups.length,
    missing: count("missing"),
    multiple: count("multiple"),
    too_long: count("too_long"),
  };
}

// A tag's own value, as compared between the periods.
const valueOf = (tag, p) => (tag === "h1" ? p.keys.h1s : p.keys[tag] ?? "");

// Pages whose verdict differs between the two periods, per from -> to pair,
// with the demand on them now and up to 8 example URLs (highest demand first).
// Worse = a clean page got a problem, better = a problem page became clean.
// Only a page whose own tag changed can move: "duplicated" also depends on
// which other pages bots fetched in each period, and a page should not move
// because a sibling with the same title was not fetched again.
function movesOf(tag, now, before, pages, prev) {
  const prevByUrl = new Map(prev.map((p) => [p.url, p]));
  const pairs = new Map();
  let both = 0;
  let changed = 0;
  for (const p of pages) {
    const old = prevByUrl.get(p.url);
    if (!old) continue;
    both++;
    if (valueOf(tag, p) === valueOf(tag, old)) continue;
    changed++;
    const was = before.verdict.get(p.url);
    const is = now.verdict.get(p.url);
    if (is === was) continue;
    const key = `${was}>${is}`;
    if (!pairs.has(key)) pairs.set(key, { from: was, to: is, list: [] });
    pairs.get(key).list.push(p);
  }
  const rank = (m) => (m.from === "clean" ? 0 : m.to === "clean" ? 2 : 1);
  const moves = [...pairs.values()].map((m) => ({
    from: m.from,
    to: m.to,
    direction: ["worse", "lateral", "better"][rank(m)],
    pages: m.list.length,
    googlebot: sum(m.list, "googlebot"),
    ai_user: sum(m.list, "ai_user"),
    sample: [...m.list].sort(byDemand).slice(0, 8).map((p) => p.url),
  }));
  moves.sort(
    (x, y) => rank(x) - rank(y) || y.googlebot + y.ai_user - (x.googlebot + x.ai_user) || y.pages - x.pages
  );
  return {
    moves,
    both,
    changed,
    newly: pages.length - both,
    dropped: before.verdict.size - both,
  };
}

// --- Title vs H1 --------------------------------------------------------------

// A tag's words as a set: lowercased, split on non-letters, a plural "s"
// dropped from words longer than three letters (crude, but the same on both
// sides, so "agents" meets "agent").
function tokens(s) {
  const words = s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return new Set(words.map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)));
}

// Share of `right` that `left` also carries; 1 when there is nothing to carry.
function containment(left, right) {
  if (!right.size) return 1;
  let shared = 0;
  for (const w of right) if (left.has(w)) shared++;
  return shared / right.size;
}

export function alignmentOf(p) {
  if (!p.title) return "title_missing";
  if (!p.h1) return "h1_missing";
  const t = tokens(p.title);
  const h = tokens(p.h1);
  const cover = containment(t, h);
  const back = containment(h, t);
  if (cover < ALIGN_FLOORS.align) return "unrelated";
  if (t.size === h.size && [...t].every((w) => h.has(w))) return "identical";
  if (cover >= ALIGN_FLOORS.near && back >= ALIGN_FLOORS.near) return "near";
  if (cover >= ALIGN_FLOORS.near) return "extends";
  return "related";
}

// --- Report and page lists ----------------------------------------------------

function demandOf(pages) {
  return { pages: pages.length, googlebot: sum(pages, "googlebot"), ai_user: sum(pages, "ai_user") };
}

function groupBy(pages, keyOf, keys) {
  const out = Object.fromEntries(keys.map((k) => [k, []]));
  for (const p of pages) out[keyOf(p)]?.push(p);
  return keys.map((key) => ({ key, ...demandOf(out[key]) }));
}

// Everything one tab draws. `prev` is the previous period's pages; `partial`
// withholds the card deltas when that period is not fully recorded.
export function summarizeTag(tag, pages, prev, partial) {
  const now = gradeTag(pages, tag);
  const before = gradeTag(prev, tag);
  const def = TAGS[tag];
  return {
    limits: { long: def.long, short: def.short ?? null },
    cards: cardsOf(tag, pages, now),
    previous: partial ? null : cardsOf(tag, prev, before),
    verdicts: groupBy(pages, (p) => now.verdict.get(p.url), verdictsOf(tag)),
    clusters: clusterRows(tag, now.dups),
    moves: { partial, ...movesOf(tag, now, before, pages, prev) },
  };
}

export function summarizeAlignment(pages) {
  return { floors: ALIGN_FLOORS, buckets: groupBy(pages, alignmentOf, ALIGN_BUCKETS) };
}

export function summarizeChecks(pages) {
  return [
    { key: "placeholder", ...demandOf(pages.filter((p) => placeholderIn(p))) },
    { key: "soft_404", ...demandOf(pages.filter(readsNotFound)) },
  ];
}

// The predicate behind one figure: "verdict:<key>", "cluster:<id>",
// "align:<bucket>" or "check:<key>".
export function pageFilter(pages, tag, filter) {
  const at = filter.indexOf(":");
  const kind = at > 0 ? filter.slice(0, at) : "";
  const key = filter.slice(at + 1);
  if (kind === "verdict" && verdictsOf(tag).includes(key)) {
    const { verdict } = gradeTag(pages, tag);
    return (p) => verdict.get(p.url) === key;
  }
  if (kind === "cluster" && /^[0-9a-f]{8}$/.test(key)) {
    const { dups } = gradeTag(pages, tag);
    const group = dups.find(([value]) => clusterId(tag, value) === key);
    const urls = new Set(group ? group[1].map((p) => p.url) : []);
    return (p) => urls.has(p.url);
  }
  if (kind === "align" && ALIGN_BUCKETS.includes(key)) return (p) => alignmentOf(p) === key;
  if (kind === "check" && key === "placeholder") return (p) => Boolean(placeholderIn(p));
  if (kind === "check" && key === "soft_404") return readsNotFound;
  throw new HttpError(400, "filter must be verdict:<verdict>, cluster:<id>, align:<bucket> or check:<check>");
}

export function listPages(pages, tag, filter) {
  return pages.filter(pageFilter(pages, tag, filter)).sort(byDemand);
}
