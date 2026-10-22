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
  meta_robots      TEXT,            -- JSON array of directives, e.g. '["noindex","nofollow"]'
  meta_googlebot   TEXT,            -- JSON array of googlebot-specific directives
  structured_data_types TEXT,       -- JSON array of JSON-LD @type values
  index_status     TEXT,            -- 'indexable' | 'non_200' | 'blocked_by_meta' | 'non_canonical'
  bot_name         TEXT    NOT NULL,
  ts               INTEGER NOT NULL -- unix milliseconds
);

-- Two indexes only. D1 bills every index entry as an extra row written, so each
-- bot visit costs 1 + (number of indexes) writes against the daily quota.
--   idx_crawls_ts     - every dashboard report filters on a date range
--   idx_crawls_url_ts - the per-page history (time machine) reads one URL's rows
CREATE INDEX IF NOT EXISTS idx_crawls_ts     ON crawls(ts DESC);
CREATE INDEX IF NOT EXISTS idx_crawls_url_ts ON crawls(url, ts DESC);

-- Indexes from earlier versions that no query uses. Re-running this file
-- (npm run db:init) removes them from an existing database.
DROP INDEX IF EXISTS idx_crawls_bot_ts;
DROP INDEX IF EXISTS idx_crawls_status;
DROP INDEX IF EXISTS idx_crawls_index_status;
