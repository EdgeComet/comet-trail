// CometTrail: evergreen crawl worker.
//
// When a bot from shared/bots.js hits the site, capture the HTML response, extract a few
// SEO fields, and append a row to D1. The worker is a pure passthrough —
// it never modifies what the bot sees, and DB work is deferred to ctx.waitUntil
// so the bot's response is not delayed.

import { detectBot } from '../../shared/bots.js';
import { parseDirectives, computeIndexStatus } from '../../shared/seo.js';

export default {
  async fetch(request, env, ctx) {
    const ua = request.headers.get('user-agent') || '';
    const botName = detectBot(ua)?.name ?? null;

    // Not a tracked bot → straight passthrough, zero overhead. redirect: 'manual'
    // so a site redirect reaches the caller instead of being followed here.
    if (!botName) return fetch(request, { redirect: 'manual' });

    const start = Date.now();
    let response;
    try {
      // redirect: 'manual' — never follow redirects. A 3xx must be passed through
      // to the bot (so it sees the redirect), not silently resolved by the Worker.
      response = await fetch(request, { redirect: 'manual' });
    } catch (err) {
      // Origin unreachable. Record a row so the failure is visible in the
      // dataset, then propagate so Cloudflare serves its default error page.
      const responseTimeMs = Date.now() - start;
      ctx.waitUntil(
        insertRow(env, {
          url: request.url, status: null, responseTimeMs, botName,
          title: null, metaDescription: null, canonical: null,
          hreflangs: [], h1: [], h2: [],
          metaRobots: [], metaGooglebot: [], structuredDataTypes: [],
          indexStatus: 'non_200', // origin unreachable; status is null, distinguishes "no response"
        }).catch((e) => console.error('evergreen-crawl error-row insert failed:', e))
      );
      console.error('evergreen-crawl origin fetch failed:', err);
      throw err;
    }
    const responseTimeMs = Date.now() - start;

    // A 3xx carries no page to analyze. Record the hop and return the response
    // unchanged so the bot follows the site's redirect itself — the Worker must
    // not swallow it (that would break the site's redirects for crawlers).
    if (response.status >= 300 && response.status < 400) {
      ctx.waitUntil(
        insertRow(env, {
          url: request.url, status: response.status, responseTimeMs, botName,
          title: null, metaDescription: null, canonical: null,
          hreflangs: [], h1: [], h2: [],
          metaRobots: [], metaGooglebot: [], structuredDataTypes: [],
          indexStatus: 'non_200',
        }).catch((e) => console.error('evergreen-crawl redirect-row insert failed:', e))
      );
      return response;
    }

    const ct = response.headers.get('content-type') || '';
    if (!ct.toLowerCase().includes('text/html') || !response.body) {
      return response;
    }

    // Split the body: one copy streams to the bot, the other is parsed.
    // tee() reads the body, which causes Cloudflare to decompress it — so we
    // must strip Content-Encoding/Content-Length before returning, otherwise
    // the bot sees identity bytes with a gzip/br header and fails to decode.
    const [toBot, toParser] = response.body.tee();
    const botHeaders = new Headers(response.headers);
    botHeaders.delete('content-encoding');
    botHeaders.delete('content-length');

    ctx.waitUntil(
      extractAndStore({
        env,
        url: request.url,
        // URL the response came from, used for the canonical comparison. We never
        // follow redirects (redirect: 'manual'), so for any HTML page recorded
        // here it equals request.url; the fallback covers an empty response.url.
        finalUrl: response.url || request.url,
        status: response.status,
        responseTimeMs,
        botName,
        bodyStream: toParser,
      }).catch((err) => console.error('evergreen-crawl error:', err))
    );

    return new Response(toBot, {
      status: response.status,
      statusText: response.statusText,
      headers: botHeaders,
    });
  },
};

async function extractAndStore({ env, url, finalUrl, status, responseTimeMs, botName, bodyStream }) {
  const data = {
    title: null,
    metaDescription: null,
    canonical: null,
    hreflangs: [],
    h1: [],
    h2: [],
    metaRobots: [],
    metaGooglebot: [],
    structuredDataTypes: [],
  };

  const h1Coll = makeNestedCollector(data.h1);
  const h2Coll = makeNestedCollector(data.h2);

  // Raw <meta name="robots"/"googlebot"> content strings, in document order.
  // Normalized into directive arrays after the stream is drained: the engine
  // takes the first non-empty value per name (seo.go extractMetaRobots).
  const robotsRaw = [];
  const googlebotRaw = [];

  const rewriter = new HTMLRewriter()
    .on('title', createSingleTextHandler((v) => { data.title = v; }))
    .on('meta[name="description" i]', {
      element(e) {
        if (data.metaDescription === null) data.metaDescription = e.getAttribute('content');
      },
    })
    .on('meta[name="robots" i]', {
      element(e) {
        const c = e.getAttribute('content');
        if (c && c.trim()) robotsRaw.push(c);
      },
    })
    .on('meta[name="googlebot" i]', {
      element(e) {
        const c = e.getAttribute('content');
        if (c && c.trim()) googlebotRaw.push(c);
      },
    })
    .on('link[rel="canonical" i]', {
      element(e) {
        if (data.canonical === null) data.canonical = e.getAttribute('href');
      },
    })
    .on('link[rel="alternate" i][hreflang]', {
      element(e) {
        data.hreflangs.push({
          lang: e.getAttribute('hreflang'),
          href: e.getAttribute('href'),
        });
      },
    })
    .on('script[type="application/ld+json" i]', makeJsonLdCollector(data.structuredDataTypes))
    // h1 / h2 use a depth-tracked frame so text inside inline children
    // (e.g. <h1>Hello <em>world</em></h1>) is captured in one piece.
    // HTMLRewriter only fires text() for *direct* text children of the matched
    // element, so we register a second handler on `h1 *` to cover descendants.
    .on('h1',   h1Coll.parent)
    .on('h1 *', h1Coll.descendant)
    .on('h2',   h2Coll.parent)
    .on('h2 *', h2Coll.descendant);

  // Drain the stream through HTMLRewriter; the handlers above populate `data`
  // as a side effect. We don't use the returned bytes.
  await rewriter.transform(new Response(bodyStream)).arrayBuffer();

  // First non-empty content per name wins (engine parity).
  data.metaRobots = parseDirectives(robotsRaw.find(Boolean));
  data.metaGooglebot = parseDirectives(googlebotRaw.find(Boolean));

  data.indexStatus = computeIndexStatus({
    status,
    metaRobots: data.metaRobots,
    metaGooglebot: data.metaGooglebot,
    canonical: data.canonical,
    finalUrl,
  });

  await insertRow(env, { url, status, responseTimeMs, botName, ...data });
}

async function insertRow(env, row) {
  await env.DB.prepare(
    `INSERT INTO crawls
       (url, status, response_time_ms, title, meta_description,
        canonical, hreflangs, h1, h2,
        meta_robots, meta_googlebot, structured_data_types, index_status,
        bot_name, ts)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
  )
    .bind(
      row.url,
      row.status,
      row.responseTimeMs,
      row.title,
      row.metaDescription,
      row.canonical,
      JSON.stringify(row.hreflangs),
      JSON.stringify(row.h1),
      JSON.stringify(row.h2),
      JSON.stringify(row.metaRobots),
      JSON.stringify(row.metaGooglebot),
      JSON.stringify(row.structuredDataTypes),
      row.indexStatus,
      row.botName,
      Date.now()
    )
    .run();
}

// Captures the text of the FIRST non-empty matching element. Used for <title>,
// which is text-only per HTML spec. An empty <title></title> does not lock
// the slot — a later non-empty title can still claim it.
function createSingleTextHandler(setter) {
  const state = { buf: '', done: false };
  return {
    element(e) {
      if (state.done) return;
      e.onEndTag(() => {
        const value = state.buf.trim();
        state.buf = '';
        if (value) {
          setter(value);
          state.done = true;
        }
      });
    },
    text(t) {
      if (!state.done) state.buf += t.text;
    },
  };
}

// Collects the full text content of EVERY matching element into `target`,
// including text inside inline descendants. HTMLRewriter only fires text()
// for direct text children, so this returns two handlers: `parent` for the
// outer element (which manages frame entry/exit) and `descendant` for any
// element selector matching nested children (e.g. `h1 *`).
//
// Both handlers share the same depth counter and buffer, so a single
// "<h1>Hello <em>world</em></h1>" produces one entry: "Hello world".
function makeNestedCollector(target) {
  const frame = { buf: '', depth: 0 };
  const enter = (e) => {
    if (frame.depth === 0) frame.buf = '';
    frame.depth++;
    e.onEndTag(() => {
      if (--frame.depth === 0) {
        const trimmed = frame.buf.trim();
        if (trimmed) target.push(trimmed);
      }
    });
  };
  const collect = (t) => { if (frame.depth > 0) frame.buf += t.text; };
  return {
    parent: { element: enter, text: collect },
    descendant: { text: collect },
  };
}

const MAX_JSONLD_BYTES = 1024 * 1024; // engine MaxJSONLDSize: skip oversized blocks
const MAX_JSONLD_DEPTH = 10;          // engine MaxJSONLDRecursionDepth
const MAX_STRUCTURED_DATA_TYPES = 50; // bound row size

// Accumulates the text of each <script type="application/ld+json"> block (text()
// fires in chunks while streaming), parses it on the end tag, and collects every
// @type value into `out`. JSON-LD scripts don't nest, so a single shared buffer
// is safe. Malformed/oversized blocks are skipped silently so a bad block never
// rejects the ctx.waitUntil promise.
function makeJsonLdCollector(out) {
  const state = { buf: '', active: false };
  return {
    element(e) {
      state.buf = '';
      state.active = true;
      e.onEndTag(() => {
        state.active = false;
        const raw = state.buf.trim();
        state.buf = '';
        if (!raw || raw.length > MAX_JSONLD_BYTES) return;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { return; }
        collectTypes(parsed, out, 0);
      });
    },
    text(t) {
      if (state.active && state.buf.length <= MAX_JSONLD_BYTES) state.buf += t.text;
    },
  };
}

// Recursively walks parsed JSON-LD collecting @type values (string or array of
// strings) into `out`, deduped and capped. Recurses into every object value so
// nested entities and @graph arrays are covered, mirroring the engine's walk.
function collectTypes(node, out, depth) {
  if (depth > MAX_JSONLD_DEPTH || node === null || typeof node !== 'object') return;
  if (out.length >= MAX_STRUCTURED_DATA_TYPES) return;

  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, out, depth + 1);
    return;
  }

  const t = node['@type'];
  if (typeof t === 'string') {
    if (!out.includes(t) && out.length < MAX_STRUCTURED_DATA_TYPES) out.push(t);
  } else if (Array.isArray(t)) {
    for (const v of t) {
      if (typeof v === 'string' && !out.includes(v) && out.length < MAX_STRUCTURED_DATA_TYPES) {
        out.push(v);
      }
    }
  }

  for (const key in node) {
    if (key === '@type') continue;
    collectTypes(node[key], out, depth + 1);
  }
}
