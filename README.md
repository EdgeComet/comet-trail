# CometTrail — Evergreen Crawl PoC

A tiny Cloudflare Worker that watches Googlebot, Bingbot, GPTBot, ClaudeBot and friends crawl your site, extracts the SEO fields they saw, and appends a row to a Cloudflare D1 database. Append-only — every visit is preserved, so you can scroll back in time and see what each bot saw on any URL on any day.

This is a proof of concept for the **evergreen crawl** idea: instead of running a traditional SEO crawler against your site, observe the bots that are already crawling it and store what they fetched. No simulated traffic, no two-month crawl windows, no stale snapshots.

## What it does

```
Bot request → Cloudflare edge → [Worker] → Origin
                                   │ ▲
                                   │ │ response
                                   ▼ │
                            tee response body
                                   │
                       ┌───────────┴───────────┐
                       ▼                       ▼
                  back to the bot      HTMLRewriter parses,
                  (no added latency)   D1 INSERT via ctx.waitUntil
```

Per captured request the worker stores:

| Field | Source |
|---|---|
| `url` | request URL |
| `status` | HTTP status from origin |
| `response_time_ms` | time spent waiting on origin |
| `title` | `<title>` |
| `meta_description` | `<meta name="description">` |
| `canonical` | `<link rel="canonical">` |
| `hreflangs` | JSON array of `<link rel="alternate" hreflang=…>` |
| `h1`, `h2` | JSON arrays of heading text |
| `bot_name` | which bot from `BOTS` matched |
| `ts` | unix ms when the worker captured it |

Pure passthrough: the worker never modifies the response the bot receives, and never adds latency to it (the D1 insert runs in `ctx.waitUntil` after the response is on its way).

## Prereqs

- Cloudflare account (free tier is fine — D1's free limits cover any normal site)
- The domain you want to track is already on Cloudflare (nameservers pointed at CF)
- Node.js ≥ 18 locally

## Layout

This is a small monorepo (npm workspaces):

- **`worker/`** — the collector: the Cloudflare Worker that captures bot crawls into D1.
- **`dashboard/`** — a base Cloudflare Pages app that reads the same D1 (currently shows one number: total requests captured).
- **`schema.sql`**, **`docs/`** — shared between both.

## Setup

```bash
git clone <this repo>
cd comet-trail
npm install          # installs both workspaces
npx wrangler login
```

`wrangler.toml` is gitignored in each subproject (it holds your `database_id` and live domain). Create each from its committed `wrangler.toml.default` template:

```bash
cp worker/wrangler.toml.default       worker/wrangler.toml
cp dashboard/wrangler.toml.default     dashboard/wrangler.toml
```

Create the D1 database and copy the printed `database_id` into **both** `wrangler.toml` files (the worker writes it, the dashboard reads it):

```bash
npx wrangler d1 create comet-trail
```

Apply the schema, then point the worker at your domain — edit `worker/wrangler.toml` and replace both `example.com` lines in the `routes` block. Optionally edit `worker/src/index.js` to tweak the `BOTS` list:

```bash
npm run db:init
```

Deploy the worker:

```bash
npm run deploy:worker
```

## Verify it works

After deploy, hit your live site with a bot user-agent:

```bash
curl -A "Googlebot/2.1" https://your-domain.com/
```

Then look at what landed:

```bash
npm run db:recent
```

You should see one row per `curl`. Loading the same page from a normal browser should produce **no** row (only bot UAs are captured).

`npx wrangler tail` streams worker logs in real time — useful while you're getting the route wired up.

## Dashboard

`dashboard/` is a minimal Cloudflare Pages app that binds the **same** D1 database and serves a single live number — total requests captured — via a Pages Function at `/api/summary`. It's a base to build on, not the full analytics UI.

```bash
npm run deploy:dashboard      # wrangler pages deploy
```

Local preview against your D1: `cd dashboard && npx wrangler pages dev`. Charts, filters, and auth are intentionally out of scope here.

## Querying the data

`docs/queries.md` has ready-made SQL for common SEO questions: broken URLs Googlebot saw last week, title changes over time, hreflang coverage, bot mix on your site, pages missing a canonical, etc.

Run any of them with:

```bash
npx wrangler d1 execute comet-trail --remote --command "SELECT …"
```

Dump the table for offline analysis (e.g., pipe into Claude):

```bash
npx wrangler d1 execute comet-trail --remote --json \
  --command "SELECT * FROM crawls ORDER BY ts DESC LIMIT 1000" > crawls.json
```

## What's deliberately left out

- **Bot verification.** UA match only — spoofed Googlebot UAs will be stored as if real. To filter, check `request.cf.verifiedBotCategory` in `index.js` before the BOTS lookup, or do a reverse-DNS verification.
- **Full dashboard.** `dashboard/` shows only a total count so far. Charts, filters, the per-URL time machine, and auth are a separate build on top of the `docs/queries.md` queries.
- **JS rendering.** The worker sees what the origin sends, not what the bot renders after running JS. For JS-heavy SPAs the captured HTML may be near-empty.
- **Retention / cleanup.** Append-only. If growth becomes a concern, add a scheduled trigger that prunes rows older than N days.
- **Non-HTML resources.** robots.txt, sitemap.xml, images, CSS, JS are not captured. Add a special-case branch if you want to track changes to robots.txt or sitemaps.

Each is a small addition — the code is intentionally short so it's easy to read and extend.

## Files

```
.
├── README.md                  you are here
├── package.json               workspaces + top-level scripts (deploy:worker, deploy:dashboard, db:*)
├── schema.sql                 shared: crawls table + indexes
├── docs/queries.md            shared: sample SQL for SEO analysis
├── worker/                    the collector
│   ├── src/index.js           the worker (~150 lines)
│   ├── wrangler.toml.default  config template — copy to wrangler.toml
│   ├── wrangler.toml          your local config (gitignored): route, D1 binding
│   └── package.json           scripts: dev, deploy, db:init, db:recent, tail
└── dashboard/                 base Cloudflare Pages app (reads the same D1)
    ├── public/index.html      single page: shows total requests
    ├── functions/api/summary.js   D1 COUNT(*) → JSON
    ├── wrangler.toml.default  Pages config template (same database_id)
    ├── wrangler.toml          gitignored
    └── package.json           scripts: dev, deploy
```
