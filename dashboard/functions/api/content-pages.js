// GET /api/content-pages?from=&to=&tag=title|description|h1&filter=&offset=&limit=
// The pages behind one figure of the Content report, the pages bots fetch most
// first. `filter` names the figure:
//   verdict:<verdict>   a verdict of the tag (missing, duplicated, ...)
//   cluster:<id>        one duplicate group of the tag
//   align:<bucket>      a title vs H1 bucket
//   check:<check>       placeholder or soft_404
// The same lib/content.js rules decide membership as decided the figure.
// Each row carries the page's three tags, the word count of the selected tag
// and, for the placeholder check, the tag that holds the placeholder.
import { handle, json, parseRange, intParam, enumParam } from "../../lib/api.js";
import { TAGS, loadPages, listPages, wordCount, placeholderIn } from "../../lib/content.js";

export const onRequestGet = handle(async ({ env, request }) => {
  const range = parseRange(request);
  const tag = enumParam(request, "tag", Object.keys(TAGS), "title");
  const filter = new URL(request.url).searchParams.get("filter") ?? "";
  const limit = intParam(request, "limit", 20, { min: 1, max: 200 });
  const requested = intParam(request, "offset", 0, { min: 0, max: 1000000 });

  const { pages } = await loadPages(env, range.from, range.to);
  const list = listPages(pages, tag, filter);
  const total = list.length;
  // An offset past the end (the period changed under it) lands on the last page.
  const offset = requested >= total ? Math.max(0, Math.floor((total - 1) / limit) * limit) : requested;

  return json({
    total,
    offset,
    rows: list.slice(offset, offset + limit).map((p) => ({
      url: p.url,
      title: p.title,
      description: p.description,
      h1s: p.h1s,
      words: wordCount(TAGS[tag].read(p)),
      googlebot: p.googlebot,
      ai_user: p.ai_user,
      placeholder: placeholderIn(p),
    })),
  });
});
