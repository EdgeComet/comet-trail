-- Evergreen crawl: one row per bot HTML hit.
-- Append-only — every visit creates a new row, giving you a time machine of the site.

CREATE TABLE IF NOT EXISTS crawls (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  url              TEXT    NOT NULL,
  status           INTEGER,         -- NULL means origin fetch failed (timeout, DNS, TLS, ...)
  response_time_ms INTEGER NOT NULL,
  title            TEXT,
  meta_description TEXT,
  canonical        TEXT,
  hreflangs        TEXT,            -- JSON array, e.g. '[{"lang":"en","href":"..."}]'
  h1               TEXT,            -- JSON array of strings
  h2               TEXT,            -- JSON array of strings
  bot_name         TEXT    NOT NULL,
  ts               INTEGER NOT NULL -- unix milliseconds
);

CREATE INDEX IF NOT EXISTS idx_crawls_url_ts  ON crawls(url, ts DESC);
CREATE INDEX IF NOT EXISTS idx_crawls_bot_ts  ON crawls(bot_name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_crawls_ts      ON crawls(ts DESC);
CREATE INDEX IF NOT EXISTS idx_crawls_status  ON crawls(status);
