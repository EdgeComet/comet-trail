// GET /api/content?from=<unix_ms>&to=<unix_ms>
// The Content report: titles, meta descriptions and H1s of the indexable pages
// bots fetched, one verdict per page and tag, from the newest settled visit in
// the period (rules in lib/content.js). One response feeds all three tabs:
//   graded      pages graded (newest visit a 200 and indexable)
//   left        200 pages left out: noindex, or canonical to another URL
//   tags        per tag: the cards (and `previous`, the same for the period
//               before, null when it is not fully recorded), the verdicts with
//               the demand on their pages, the pages longer than search
//               results usually show (`chars`, information beside the
//               verdicts; title and description only), the duplicate groups
//               with their cause, and the verdict moves since the previous
//               period
//   alignment   title vs H1, one bucket per page
//   checks      placeholder text and pages that read as "not found"
// Two reads of the crawls table: this period and the one before.
import { handle, json, parseRange, firstVisitTs, previousIsComplete } from "../../lib/api.js";
import { TAGS, loadPages, summarizeTag, summarizeAlignment, summarizeChecks } from "../../lib/content.js";

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const [cur, prev, first] = await Promise.all([
    loadPages(env, range.from, range.to),
    loadPages(env, range.prevFrom, range.prevTo),
    firstVisitTs(env),
  ]);
  const partial = !previousIsComplete(range, first);

  return json({
    graded: cur.pages.length,
    left: cur.left,
    partial,
    tags: Object.fromEntries(Object.keys(TAGS).map((tag) => [tag, summarizeTag(tag, cur.pages, prev.pages, partial)])),
    alignment: summarizeAlignment(cur.pages),
    checks: summarizeChecks(cur.pages),
  });
});
