// CometTrail: evergreen crawl worker.
//
// When a bot in BOTS hits the site, capture the HTML response, extract a few
// SEO fields, and append a row to D1. The worker is a pure passthrough —
// it never modifies what the bot sees, and DB work is deferred to ctx.waitUntil
// so the bot's response is not delayed.

// Order matters: more-specific patterns first, so e.g. Googlebot-Image is
// matched before the catch-all /Googlebot/.
const BOTS = [
  // Google variants
  { name: 'Googlebot-Image',       pattern: /Googlebot-Image/i },
  { name: 'Googlebot-Video',       pattern: /Googlebot-Video/i },
  { name: 'Googlebot-News',        pattern: /Googlebot-News/i },
  { name: 'AdsBot-Google-Mobile',  pattern: /AdsBot-Google-Mobile/i },
  { name: 'AdsBot-Google',         pattern: /AdsBot-Google/i },
  { name: 'GoogleOther',           pattern: /GoogleOther/i },
  { name: 'Google-Extended',       pattern: /Google-Extended/i },
  { name: 'Googlebot-Smartphone',  pattern: /Mobile[^)]*Googlebot|Googlebot[^)]*Mobile/i },
  { name: 'Googlebot',             pattern: /Googlebot/i },

  // Search engines
  { name: 'Bingbot',               pattern: /Bingbot/i },
  { name: 'YandexBot',             pattern: /YandexBot/i },
  { name: 'DuckDuckBot',           pattern: /DuckDuckBot/i },
  { name: 'Applebot',              pattern: /Applebot/i },

  // AI / answer engines
  { name: 'GPTBot',                pattern: /GPTBot/i },
  { name: 'OAI-SearchBot',         pattern: /OAI-SearchBot/i },
  { name: 'ChatGPT-User',          pattern: /ChatGPT-User/i },
  { name: 'ClaudeBot',             pattern: /ClaudeBot/i },
  { name: 'Claude-Web',            pattern: /Claude-Web/i },
  { name: 'Claude-User',           pattern: /Claude-User/i },
  { name: 'PerplexityBot',         pattern: /PerplexityBot/i },
  // edit this list to add or remove bots
];

function detectBot(ua) {
  for (const b of BOTS) if (b.pattern.test(ua)) return b.name;
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const ua = request.headers.get('user-agent') || '';
    const botName = detectBot(ua);

    // Not a tracked bot → straight passthrough, zero overhead.
    if (!botName) return fetch(request);

    const start = Date.now();
    let response;
    try {
      response = await fetch(request);
    } catch (err) {
      // Origin unreachable. Record a row so the failure is visible in the
      // dataset, then propagate so Cloudflare serves its default error page.
      const responseTimeMs = Date.now() - start;
      ctx.waitUntil(
        insertRow(env, {
          url: request.url, status: null, responseTimeMs, botName,
          title: null, metaDescription: null, canonical: null,
          hreflangs: [], h1: [], h2: [],
        }).catch((e) => console.error('evergreen-crawl error-row insert failed:', e))
      );
      console.error('evergreen-crawl origin fetch failed:', err);
      throw err;
    }
    const responseTimeMs = Date.now() - start;

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

async function extractAndStore({ env, url, status, responseTimeMs, botName, bodyStream }) {
  const data = {
    title: null,
    metaDescription: null,
    canonical: null,
    hreflangs: [],
    h1: [],
    h2: [],
  };

  const h1Coll = makeNestedCollector(data.h1);
  const h2Coll = makeNestedCollector(data.h2);

  const rewriter = new HTMLRewriter()
    .on('title', createSingleTextHandler((v) => { data.title = v; }))
    .on('meta[name="description" i]', {
      element(e) {
        if (data.metaDescription === null) data.metaDescription = e.getAttribute('content');
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

  await insertRow(env, { url, status, responseTimeMs, botName, ...data });
}

async function insertRow(env, row) {
  await env.DB.prepare(
    `INSERT INTO crawls
       (url, status, response_time_ms, title, meta_description,
        canonical, hreflangs, h1, h2, bot_name, ts)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
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
