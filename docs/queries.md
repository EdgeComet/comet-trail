# Sample queries

Run any of these with:

```bash
npx wrangler d1 execute comet-trail --remote --command "..."
```

Add `--json` to get machine-readable output (handy for piping into Claude or a notebook).

## Recent activity

```sql
SELECT url, status, response_time_ms, title, bot_name,
       datetime(ts/1000,'unixepoch') AS seen
FROM crawls
ORDER BY ts DESC
LIMIT 50;
```

## Which bots are hitting the site

```sql
SELECT bot_name,
       COUNT(*)                                    AS hits,
       COUNT(DISTINCT url)                         AS unique_urls,
       datetime(MAX(ts)/1000,'unixepoch')          AS last_seen
FROM crawls
GROUP BY bot_name
ORDER BY hits DESC;
```

## Broken URLs Googlebot saw in the last 7 days

```sql
SELECT url, status,
       datetime(ts/1000,'unixepoch') AS seen
FROM crawls
WHERE bot_name = 'Googlebot'
  AND status >= 400
  AND ts > (unixepoch() - 7*86400) * 1000
ORDER BY ts DESC;
```

## URLs where the origin was unreachable (status IS NULL)

A NULL `status` means the worker couldn't reach the origin at all — timeout,
DNS error, TLS failure, etc. These rows are usually the most actionable.

```sql
SELECT url, bot_name, response_time_ms,
       datetime(ts/1000,'unixepoch') AS seen
FROM crawls
WHERE status IS NULL
  AND ts > (unixepoch() - 7*86400) * 1000
ORDER BY ts DESC;
```

## Title changes over time for one URL

```sql
SELECT datetime(ts/1000,'unixepoch') AS seen,
       title,
       bot_name
FROM crawls
WHERE url = 'https://example.com/some-page'
ORDER BY ts ASC;
```

## Pages missing a canonical

```sql
SELECT DISTINCT url
FROM crawls
WHERE canonical IS NULL
  AND status = 200
ORDER BY url;
```

## Latest snapshot per URL (collapse the time machine)

```sql
SELECT c.url, c.status, c.title, c.canonical, c.bot_name,
       datetime(c.ts/1000,'unixepoch') AS seen
FROM crawls c
JOIN (
  SELECT url, MAX(ts) AS max_ts FROM crawls GROUP BY url
) latest ON c.url = latest.url AND c.ts = latest.max_ts
ORDER BY c.url;
```

## Hreflang coverage — expand the JSON array

```sql
SELECT c.url,
       json_extract(he.value, '$.lang') AS lang,
       json_extract(he.value, '$.href') AS href
FROM crawls c, json_each(c.hreflangs) he
WHERE c.bot_name = 'Googlebot'
ORDER BY c.ts DESC, c.url, lang;
```

## URLs where the H1 changed across two visits

```sql
WITH ranked AS (
  SELECT url, h1, ts,
         ROW_NUMBER() OVER (PARTITION BY url ORDER BY ts DESC) AS rn
  FROM crawls
  WHERE status = 200 AND h1 IS NOT NULL
)
SELECT a.url,
       datetime(b.ts/1000,'unixepoch') AS earlier_seen, b.h1 AS earlier_h1,
       datetime(a.ts/1000,'unixepoch') AS later_seen,   a.h1 AS later_h1
FROM ranked a
JOIN ranked b ON a.url = b.url AND a.rn = 1 AND b.rn = 2
WHERE a.h1 != b.h1;
```

## Slowest pages for Googlebot

```sql
SELECT url,
       MAX(response_time_ms) AS slowest_ms,
       AVG(response_time_ms) AS avg_ms,
       COUNT(*)              AS hits
FROM crawls
WHERE bot_name = 'Googlebot' AND status = 200
GROUP BY url
ORDER BY slowest_ms DESC
LIMIT 20;
```

## How many H2s per page (median-ish)

```sql
SELECT url,
       json_array_length(h2) AS h2_count,
       title
FROM crawls
WHERE status = 200 AND h2 IS NOT NULL
GROUP BY url
ORDER BY h2_count DESC
LIMIT 50;
```

## Pages bots have never seen a 200 on

```sql
SELECT DISTINCT url
FROM crawls
WHERE url NOT IN (SELECT url FROM crawls WHERE status BETWEEN 200 AND 299);
```

## Indexation status breakdown (latest snapshot per URL)

`index_status` is `indexable`, `non_200`, `blocked_by_meta`, or `non_canonical`.
This collapses the time machine to each URL's most recent visit, then counts.

```sql
WITH latest AS (
  SELECT c.url, c.index_status,
         ROW_NUMBER() OVER (PARTITION BY c.url ORDER BY c.ts DESC) AS rn
  FROM crawls c
)
SELECT index_status, COUNT(*) AS urls
FROM latest
WHERE rn = 1
GROUP BY index_status
ORDER BY urls DESC;
```

## URLs blocked from indexing, with the offending directives

```sql
SELECT url, index_status, meta_robots, meta_googlebot,
       datetime(ts/1000,'unixepoch') AS seen
FROM crawls
WHERE index_status IN ('blocked_by_meta', 'non_canonical')
ORDER BY ts DESC;
```

## URLs whose indexation status flipped across two visits

```sql
WITH ranked AS (
  SELECT url, index_status, ts,
         ROW_NUMBER() OVER (PARTITION BY url ORDER BY ts DESC) AS rn
  FROM crawls
  WHERE index_status IS NOT NULL
)
SELECT a.url,
       datetime(b.ts/1000,'unixepoch') AS earlier_seen, b.index_status AS earlier_status,
       datetime(a.ts/1000,'unixepoch') AS later_seen,   a.index_status AS later_status
FROM ranked a
JOIN ranked b ON a.url = b.url AND a.rn = 1 AND b.rn = 2
WHERE a.index_status != b.index_status;
```

## Structured-data types seen across the site

```sql
SELECT json_each.value AS type, COUNT(DISTINCT c.url) AS urls
FROM crawls c, json_each(c.structured_data_types)
WHERE c.status = 200
GROUP BY type
ORDER BY urls DESC;
```
