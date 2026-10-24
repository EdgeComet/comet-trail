// Bot catalog, shared by the collector (worker/src/index.js), the dashboard API
// (dashboard/functions/) and the demo seed (scripts/seed-demo.mjs).
//
// Each bot has:
//   name     - the value stored in crawls.bot_name. Renaming one orphans its old
//              rows from their family, so add new names rather than rename.
//   pattern  - user-agent match. Order matters: the first match wins, so more
//              specific tokens (Googlebot-Image) come before generic ones (Googlebot).
//   family   - which line it joins on the Bot Activity chart (FAMILIES below).
//   purpose  - AI bots only: why the bot came (PURPOSES below). Families and
//              purposes follow EdgeComet's product taxonomy.
//   engine   - search engine crawlers only: whose crawler it is, 'google' or
//              'bing'. The Googlebot and Bingbot reports count their Search
//              family; their Bot Variants table lists every crawler of the engine.
//
// Matching is by user agent only: a scraper that claims to be Googlebot is stored
// as Googlebot. See "What's deliberately left out" in README.md.

export const FAMILIES = [
  { key: 'googlebot', label: 'Googlebot Search' },
  { key: 'bingbot', label: 'Bingbot Search' },
  { key: 'chatgpt', label: 'ChatGPT' },
  { key: 'claude', label: 'Claude' },
  { key: 'perplexity', label: 'Perplexity' },
  { key: 'meta', label: 'Meta AI' },
  { key: 'other', label: 'Other' },
];

export const PURPOSES = [
  { key: 'user', label: 'User fetches', description: 'fetched live while a person asked an AI assistant' },
  { key: 'search', label: 'AI search', description: 'crawled to build an AI search index' },
  { key: 'training', label: 'Training', description: 'crawled to collect model training data' },
];

export const BOTS = [
  // Google. Only desktop and smartphone Googlebot form the "Googlebot Search"
  // family; the image, news, ads and GoogleOther fetchers count as Other.
  { name: 'Googlebot-Image', pattern: /Googlebot-Image/i, family: 'other', engine: 'google' },
  { name: 'Googlebot-Video', pattern: /Googlebot-Video/i, family: 'other', engine: 'google' },
  { name: 'Googlebot-News', pattern: /Googlebot-News/i, family: 'other', engine: 'google' },
  { name: 'AdsBot-Google-Mobile', pattern: /AdsBot-Google-Mobile/i, family: 'other', engine: 'google' },
  { name: 'AdsBot-Google', pattern: /AdsBot-Google/i, family: 'other', engine: 'google' },
  { name: 'GoogleOther', pattern: /GoogleOther/i, family: 'other', engine: 'google' },
  { name: 'Googlebot-Smartphone', pattern: /Mobile[^)]*Googlebot|Googlebot[^)]*Mobile/i, family: 'googlebot', engine: 'google' },
  { name: 'Googlebot', pattern: /Googlebot/i, family: 'googlebot', engine: 'google' },

  // Bing. Its smartphone crawler says "Mobile" before "bingbot"; rows recorded
  // before it had a name of its own are stored as Bingbot.
  { name: 'Bingbot-Smartphone', pattern: /Mobile[^)]*bingbot|bingbot[^)]*Mobile/i, family: 'bingbot', engine: 'bing' },
  { name: 'Bingbot', pattern: /bingbot/i, family: 'bingbot', engine: 'bing' },

  // Other search engines
  { name: 'YandexBot', pattern: /YandexBot/i, family: 'other' },
  { name: 'DuckDuckBot', pattern: /DuckDuckBot/i, family: 'other' },
  { name: 'Applebot', pattern: /Applebot\//i, family: 'other' },

  // OpenAI
  { name: 'GPTBot', pattern: /GPTBot/i, family: 'chatgpt', purpose: 'training' },
  { name: 'OAI-SearchBot', pattern: /OAI-SearchBot/i, family: 'chatgpt', purpose: 'search' },
  { name: 'ChatGPT-User', pattern: /ChatGPT-User/i, family: 'chatgpt', purpose: 'user' },

  // Anthropic. Claude-Web is a retired user agent, kept so old rows still land
  // in the Claude family; its purpose was never documented, so it has none.
  { name: 'ClaudeBot', pattern: /ClaudeBot/i, family: 'claude', purpose: 'training' },
  { name: 'Claude-SearchBot', pattern: /Claude-SearchBot/i, family: 'claude', purpose: 'search' },
  { name: 'Claude-User', pattern: /Claude-User/i, family: 'claude', purpose: 'user' },
  { name: 'Claude-Web', pattern: /Claude-Web/i, family: 'claude' },

  // Perplexity (no training crawler)
  { name: 'PerplexityBot', pattern: /PerplexityBot/i, family: 'perplexity', purpose: 'search' },
  { name: 'Perplexity-User', pattern: /Perplexity-User/i, family: 'perplexity', purpose: 'user' },

  // Meta: externalagent trains models, webindexer feeds Meta AI search,
  // externalfetcher serves user-requested fetches.
  { name: 'Meta-ExternalAgent', pattern: /meta-externalagent/i, family: 'meta', purpose: 'training' },
  { name: 'Meta-WebIndexer', pattern: /meta-webindexer/i, family: 'meta', purpose: 'search' },
  { name: 'Meta-ExternalFetcher', pattern: /meta-externalfetcher/i, family: 'meta', purpose: 'user' },

  // Other AI crawlers
  { name: 'CCBot', pattern: /CCBot/i, family: 'other', purpose: 'training' },
  { name: 'Bytespider', pattern: /Bytespider/i, family: 'other', purpose: 'training' },
  { name: 'MistralAI-User', pattern: /MistralAI-User/i, family: 'other', purpose: 'user' },
  { name: 'MistralAI-Index', pattern: /MistralAI-Index/i, family: 'other', purpose: 'search' },
  { name: 'MistralAI-Training', pattern: /MistralAI-Training/i, family: 'other', purpose: 'training' },
  // edit this list to add or remove bots
];

const BY_NAME = new Map(BOTS.map((b) => [b.name, b]));

// The catalog entry whose pattern matches this user agent, or null for anything
// that is not a tracked bot (human visitors included).
export function detectBot(ua) {
  for (const b of BOTS) if (b.pattern.test(ua)) return b;
  return null;
}

export function botInfo(name) {
  return BY_NAME.get(name) ?? null;
}

// --- SQL helpers ----------------------------------------------------------
// Families and purposes are derived from bot_name at query time rather than
// stored, so rows written before a bot was (re)classified still group correctly.
// Every interpolated value is a constant from this file, never request input.

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// `IN (...)` list of bot names that satisfy `predicate`, for WHERE clauses.
export function botNamesSql(predicate) {
  const names = BOTS.filter(predicate).map((b) => quote(b.name));
  return names.length ? `(${names.join(', ')})` : '(NULL)';
}

function caseSql(col, keyOf, fallbackSql) {
  const groups = new Map();
  for (const b of BOTS) {
    const key = keyOf(b);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(quote(b.name));
  }
  const whens = [...groups].map(([key, names]) => `WHEN ${col} IN (${names.join(', ')}) THEN ${quote(key)}`);
  return `CASE ${whens.join(' ')} ELSE ${fallbackSql} END`;
}

// SQL expression mapping a bot_name column to its family key ('other' for
// anything unlisted).
export function familySql(col = 'bot_name') {
  return caseSql(col, (b) => (b.family === 'other' ? null : b.family), quote('other'));
}

// SQL expression mapping a bot_name column to its AI purpose key, NULL for
// search engines and other non-AI bots.
export function purposeSql(col = 'bot_name') {
  return caseSql(col, (b) => b.purpose ?? null, 'NULL');
}

// AI bots are the ones with a known purpose, so every AI total splits cleanly
// into user fetches, AI search and training (Claude-Web, retired, has none).
export const isAiBot = (b) => Boolean(b.purpose);
export const isGooglebot = (b) => b.family === 'googlebot';
export const isBingbot = (b) => b.family === 'bingbot';
