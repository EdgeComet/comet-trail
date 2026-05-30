# Manual setup (without Claude Code)

This is the hand-run alternative to `/install` (see the [README](../README.md#setup)). Use it if you're not using Claude Code, or you want to see exactly what each step does. It assumes you've already run `npm install` at the repo root.

## Deploy the collector

```bash
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

Then verify capture and deploy the dashboard as described in the README's [Verify it works](../README.md#verify-it-works) and [Dashboard](../README.md#dashboard) sections.

## Locking the dashboard behind Cloudflare Access

The steps below are all done in the Cloudflare dashboard ([dash.cloudflare.com](https://dash.cloudflare.com)) and only need to be done once. Replace `dashboard.example.com` with your hostname.

**1. Attach a custom domain to the Pages project.**
Go to **Workers & Pages → `comet-trail-dashboard` → Custom domains → Set up a custom domain**, enter `dashboard.example.com`, and confirm. Since the domain is already on your account, Cloudflare creates the DNS record and certificate automatically — wait until it shows **Active**.
(Wrangler has no command for this. If you prefer the API: `POST /accounts/{account_id}/pages/projects/comet-trail-dashboard/domains` with body `{"name":"dashboard.example.com"}`.)

**2. Enable One-Time PIN login.**
This is the login method that needs no external identity provider (Access emails the user a code). It is **off by default**. Open **Zero Trust**, then **Integrations → Identity providers → Add new → One-time PIN → Save**. (In some accounts this lives under **Settings → Authentication → Login methods**.)

**3. Create the Access application.**
**Zero Trust → Access controls → Applications → Create new application → Self-hosted and private**. Then:
- **Application name:** `CometTrail Dashboard`.
- **Add public hostname:** pick your domain from the dropdown and enter the subdomain so it resolves to `dashboard.example.com`.
- **Session Duration:** e.g. `24 hours`.
- **Identity providers:** make sure **One-time PIN** is selected.
- Continue to the policy step.

**4. Add an Allow policy (your allow-list).**
In the application's **Policies** step → **Create new policy** (or **Add a policy**):
- **Policy name:** `CometTrail allow`.
- **Action:** **Allow**.
- **Add include rules** (any one match lets a user in):
  - Selector **Emails** → a specific address, e.g. `you@example.com`; and/or
  - Selector **Emails ending in** → a whole domain, e.g. `@example.com`.
- Save the policy and finish creating the application.

**This policy is the only place that decides who gets in** — the middleware does not keep its own list. To add a teammate later, edit this policy; no redeploy needed.

**5. Copy two values into the dashboard config.**
- **Application Audience (AUD) tag:** **Zero Trust → Access controls → Applications → Configure** (your app) **→ Additional settings → Application Audience (AUD) Tag** → copy.
- **Team domain:** under **Zero Trust → Settings** (also the `<your-team>.cloudflareaccess.com` shown in your Access login page URL).

Put both into `dashboard/wrangler.toml` under `[vars]`:
```toml
[vars]
CF_ACCESS_TEAM_DOMAIN = "https://your-team.cloudflareaccess.com"  # note the https:// prefix
CF_ACCESS_AUD = "<the AUD tag you copied>"
```

**6. Deploy.**
```bash
npm run deploy:dashboard
```

> Deploy **after** completing steps 1–5. The middleware fails closed: deploying it before the Access app exists and the `[vars]` are filled will return 403 to everyone, including you.

**Verify:** `curl -i https://comet-trail-dashboard.pages.dev/api/metrics` should return **403** (raw Pages URL has no token), while opening `https://dashboard.example.com/` redirects you to the Access login and, after entering the emailed code, loads the page.
