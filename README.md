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
```

### Install with Claude Code (recommended)

Open this repo in [Claude Code](https://claude.com/claude-code) and run:

```
/install
```

It does the whole setup for you from **one** Cloudflare API token: creates the D1
database, fills in both `wrangler.toml` files, picks your domain and wires the
worker routes, applies the schema, deploys, and verifies that a bot crawl is
actually captured. It can optionally lock the dashboard behind Cloudflare Access
(email login) end-to-end — including the parts that normally require clicking
through the Zero Trust dashboard.

The only thing you do by hand is create the token (you can't make an API token
without one). At <https://dash.cloudflare.com/profile/api-tokens> → **Create
Token → Create Custom Token**, add these permissions:

| Permission | Scope | Needed for |
|---|---|---|
| Workers Scripts · Edit | Account | deploy the worker |
| Workers Routes · Edit | Zone | bind the worker to your domain |
| D1 · Edit | Account | create + query the database |
| Cloudflare Pages · Edit | Account | deploy the dashboard |
| Zone · Read | Zone | find your domain |
| Account Settings · Read | Account | resolve your account |
| Access: Apps and Policies · Edit | Account | *(only if locking the dashboard)* |
| Access: Organizations, IdPs, and Groups · Edit | Account | *(only if locking the dashboard)* |
| DNS · Edit | Zone | *(only if locking the dashboard)* |

Paste the token when `/install` asks. **Never commit it or paste it into a
file** — it's only held in memory during the run, and you can revoke it after.

> Not using Claude Code? The same steps run as `npm run setup -- <verb>` (see
> `scripts/ct-install.mjs` for the verb list), or follow [`docs/manual-setup.md`](docs/manual-setup.md)
> to do it entirely by hand.

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

`npm run tail` streams worker logs in real time — useful while you're getting the route wired up.

## Dashboard

`dashboard/` is a minimal Cloudflare Pages app that binds the **same** D1 database. It's built on a small **Provider/Chart** framework (`public/js/`): each visual component is fed by a dedicated data provider (a frontend object that caches its results, paired with a Pages Function endpoint). The first component is a row of summary stat cards — total requests, unique URLs, crawl efficiency, average response — served by `/api/metrics?from=&to=` and driven by a global date-range selector (7 / 30 / 90 days). It's a base to build on, not the full analytics UI.

```bash
npm run deploy:dashboard      # wrangler pages deploy
```

Local preview against your D1: `cd dashboard && npx wrangler pages dev`.

### Locking the dashboard behind Cloudflare Access

`/install` **asks** whether to lock the dashboard, and locking is the recommended path — so a dashboard set up through the installer is normally private, behind email login. Choose "lock it" and the installer does the whole Cloudflare Access setup for you (One-Time PIN provider, Access application, allow policy, custom domain, the `CF_ACCESS_*` `[vars]`, and the deploy — in the correct order, all from your API token).

Access enforcement is **opt-in at the code level**: the middleware in `dashboard/functions/_middleware.js` only enforces once the `CF_ACCESS_*` `[vars]` hold real values. Until then — if you decline the lockdown in `/install`, or run a plain `npm run deploy:dashboard` without setting those vars — it serves the page to anyone. So an unconfigured deploy is unprotected; a completed lockdown is private.

Once the vars are real, the middleware verifies the Access token on every request, which also locks the raw `*.pages.dev` URL and preview deployments — not just your custom domain. Login is enforced at the edge; who gets in is decided by the Access policy (allowed emails / domains), the single source of truth.

A **custom domain is required** either way: Cloudflare Access can only protect a hostname on a zone in your own account, so it can't sit in front of `*.pages.dev`.

Prefer to set it up by hand? The full step-by-step (custom domain, One-Time PIN, Access application, allow policy, and the `[vars]` to copy) is in [`docs/manual-setup.md`](docs/manual-setup.md#locking-the-dashboard-behind-cloudflare-access).

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
- **Full dashboard.** `dashboard/` shows only a total count so far. Charts, filters, and the per-URL time machine are a separate build on top of the `docs/queries.md` queries. (Auth is available now — see "Locking the dashboard behind Cloudflare Access".)
- **JS rendering.** The worker sees what the origin sends, not what the bot renders after running JS. For JS-heavy SPAs the captured HTML may be near-empty.
- **Retention / cleanup.** Append-only. If growth becomes a concern, add a scheduled trigger that prunes rows older than N days.
- **Non-HTML resources.** robots.txt, sitemap.xml, images, CSS, JS are not captured. Add a special-case branch if you want to track changes to robots.txt or sitemaps.

Each is a small addition — the code is intentionally short so it's easy to read and extend.

## Files

```
.
├── README.md                  you are here
├── package.json               workspaces + top-level scripts (setup, deploy:*, db:*)
├── schema.sql                 shared: crawls table + indexes
├── docs/queries.md            shared: sample SQL for SEO analysis
├── docs/manual-setup.md       hand-run setup + Access lockdown (the /install alternative)
├── scripts/ct-install.mjs     installer helper: idempotent CF API + wrangler verbs
├── .claude/commands/install.md  the /install flow that drives the helper
├── worker/                    the collector
│   ├── src/index.js           the worker (~150 lines)
│   ├── wrangler.toml.default  config template — copy to wrangler.toml
│   ├── wrangler.toml          your local config (gitignored): route, D1 binding
│   └── package.json           scripts: dev, deploy, db:init, db:recent, tail
└── dashboard/                 base Cloudflare Pages app (reads the same D1)
    ├── public/index.html      dashboard page (loads the Provider/Chart framework)
    ├── public/js/             Provider/Chart framework: core/, providers/, charts/, main.js
    ├── functions/api/metrics.js   D1 aggregate (totals, efficiency, avg) → JSON
    ├── functions/_middleware.js   optional Cloudflare Access lock (off until configured)
    ├── wrangler.toml.default  Pages config template (same database_id)
    ├── wrangler.toml          gitignored
    └── package.json           scripts: dev, deploy
```
