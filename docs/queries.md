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

## Crawl efficiency: where Googlebot's crawl went

Crawl efficiency is the share of Googlebot Search requests whose visit received
an indexable page, the Crawl Efficiency card on Log Analyzer > Overview. Each
visit gets one verdict, in the order the dashboard uses (`dashboard/lib/sql.js`):
the status code first, then a noindex, then the canonical. Every row other than
`indexable` is crawl spent where Google cannot index anything.

```sql
SELECT CASE
         WHEN status IS NULL OR status >= 500 THEN 'server_error'
         WHEN status >= 400 THEN 'client_error'
         WHEN status >= 300 THEN 'redirect'
         WHEN status <> 200 THEN 'other'
         WHEN index_status = 'blocked_by_meta' THEN 'noindex'
         WHEN index_status = 'non_canonical' THEN 'canonical'
         ELSE 'indexable'
       END AS verdict,
       COUNT(*) AS requests,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
FROM crawls
WHERE bot_name IN ('Googlebot', 'Googlebot-Smartphone')
  AND ts > (unixepoch() - 30*86400) * 1000
GROUP BY verdict
ORDER BY requests DESC;
```

## Broken URLs Googlebot saw in the last 7 days

The answers the Broken URLs table on Log Analyzer > Status Codes counts as
failing: 404 Not Found, 410 Gone, a 5xx, or no response at all (`NULL`
status). A 403 or a 429 rate limit is neither failing nor good there.

```sql
SELECT url,
       COUNT(*)                                       AS failed_hits,
       GROUP_CONCAT(DISTINCT IFNULL(status, 'none'))  AS answers,
       datetime(MAX(ts)/1000,'unixepoch')             AS last_failed
FROM crawls
WHERE bot_name IN ('Googlebot', 'Googlebot-Smartphone')
  AND (status IN (404, 410) OR status >= 500 OR status IS NULL)
  AND ts > (unixepoch() - 7*86400) * 1000
GROUP BY url
ORDER BY failed_hits DESC;
```

## URLs where the origin was unreachable (status IS NULL)

A NULL `status` means the worker couldn't reach the origin at all: timeout,
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

## Canonicals that point to a page that is not indexable

The Where canonicals lead card on Evergreen Crawl > Indexation: every page
whose newest settled visit in the last 30 days answered 200 with a canonical to
another URL, grouped by what that target got on its own newest settled visit.
A settled visit is one that got an answer other than a 429 or a 5xx, so one
failed fetch does not decide a page. The dashboard also resolves relative
canonicals; this query compares them as written.

```sql
WITH latest AS (
  SELECT url, status, index_status, canonical,
         ROW_NUMBER() OVER (PARTITION BY url ORDER BY
           CASE WHEN status IS NULL OR status = 429 OR status >= 500 THEN 1 ELSE 0 END, ts DESC) AS rn
  FROM crawls
  WHERE ts > (unixepoch() - 30*86400) * 1000
),
pointing AS (
  SELECT p.url, p.canonical AS target,
         CASE
           WHEN t.url IS NULL THEN 'not fetched'
           WHEN t.status >= 300 AND t.status < 400 THEN 'redirect'
           WHEN t.status IS NULL OR t.status <> 200 THEN 'error'
           WHEN t.index_status = 'blocked_by_meta' THEN 'noindex'
           WHEN t.index_status = 'non_canonical' THEN 'chain'
           ELSE 'indexable'
         END AS target_verdict
  FROM latest p
  LEFT JOIN latest t ON t.url = p.canonical AND t.rn = 1
  WHERE p.rn = 1 AND p.status = 200
    AND p.canonical IS NOT NULL AND p.canonical <> p.url
)
SELECT target_verdict, target, COUNT(*) AS pages
FROM pointing
WHERE target_verdict <> 'indexable'
GROUP BY target_verdict, target
ORDER BY pages DESC;
```

## Titles and descriptions longer than search results usually show

The character counts on Evergreen Crawl > Content: a title over 60 characters
or a meta description over 160 runs past what a result usually shows. They are
counted beside the verdicts, which stay word-based. Only indexable pages are
graded, each by its newest settled visit in the last 30 days.

```sql
WITH latest AS (
  SELECT url, status, index_status, trim(title) AS title, trim(meta_description) AS description,
         ROW_NUMBER() OVER (PARTITION BY url ORDER BY
           CASE WHEN status IS NULL OR status = 429 OR status >= 500 THEN 1 ELSE 0 END, ts DESC) AS rn
  FROM crawls
  WHERE ts > (unixepoch() - 30*86400) * 1000
)
SELECT url, length(title) AS title_chars, length(description) AS description_chars, title
FROM latest
WHERE rn = 1 AND status = 200 AND index_status = 'indexable'
  AND (length(title) > 60 OR length(description) > 160)
ORDER BY title_chars DESC;
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

## Hreflang coverage: expand the JSON array

```sql
SELECT c.url,
       json_extract(he.value, '$.lang') AS lang,
       json_extract(he.value, '$.href') AS href
FROM crawls c, json_each(c.hreflangs) he
WHERE c.bot_name IN ('Googlebot', 'Googlebot-Smartphone')
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

## Canonical changes per day, and what they did to indexability

How Evergreen Crawl > Changes finds a change: each 200 visit is compared with
the visit before it to the same URL. A day when many pages changed their
canonical is usually a release; the Changes page groups such days into events
and marks the biggest on the Overview, Indexation and Status Codes charts, red
when most of their changes cost pages their indexability, green when most gave
it back.
One `LAG` of a JSON array, rather than one `LAG` per column, keeps the reads
down: D1 counts a pass over the rows for every `LAG`. The 60 days give each
page of the last 30 a visit to compare with.

```sql
WITH v AS (
  SELECT url, ts, canonical, index_status,
         LAG(json_array(canonical, index_status)) OVER (PARTITION BY url ORDER BY ts) AS prev
  FROM crawls
  WHERE status = 200 AND ts > (unixepoch() - 60*86400) * 1000
)
SELECT date(ts/1000, 'unixepoch') AS day,
       COUNT(DISTINCT url) AS pages,
       COUNT(DISTINCT CASE WHEN index_status <> 'indexable'
                            AND json_extract(prev, '$[1]') = 'indexable' THEN url END) AS lost_indexability,
       COUNT(DISTINCT CASE WHEN index_status = 'indexable'
                            AND json_extract(prev, '$[1]') <> 'indexable' THEN url END) AS regained
FROM v
WHERE prev IS NOT NULL
  AND canonical IS NOT json_extract(prev, '$[0]')
  AND ts > (unixepoch() - 30*86400) * 1000
GROUP BY day
ORDER BY day;
```

## Slowest pages for Googlebot

The Slowest URLs table on Log Analyzer > Loading Time: the median and 95th
percentile response time of each URL Googlebot fetched at least five times in
the last 30 days, so a slow hit or two does not rank a page. Each percentile is
the time at rank ceil(p * n) among the URL's n visits, ordered by time.

```sql
WITH ranked AS (
  SELECT url, response_time_ms,
         ROW_NUMBER() OVER (PARTITION BY url ORDER BY response_time_ms) AS rn,
         COUNT(*)     OVER (PARTITION BY url)                           AS n
  FROM crawls
  WHERE bot_name IN ('Googlebot', 'Googlebot-Smartphone')
    AND ts > (unixepoch() - 30*86400) * 1000
)
SELECT url,
       MIN(CASE WHEN rn >= 0.5  * n THEN response_time_ms END) AS median_ms,
       MIN(CASE WHEN rn >= 0.95 * n THEN response_time_ms END) AS p95_ms,
       COUNT(*)                                                AS visits
FROM ranked
GROUP BY url
HAVING visits >= 5
ORDER BY median_ms DESC
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
