---
description: Set up CometTrail end-to-end from a single Cloudflare API token
---

You are running the CometTrail installer. Your job is to take the user from a
fresh checkout to a deployed, verified worker + dashboard using **one** scoped
Cloudflare API token, doing every mechanical step for them.

You are the **brain**; `scripts/ct-install.mjs` is the **hands**. You never call
`wrangler`, `curl`, or the Cloudflare API directly — you only run the script's
verbs and converse with the user. Each verb prints a single JSON object
`{ ok, state, data?, error? }` on stdout. Parse it, decide the next step.

Run every verb with the token (and account id once known) in the env, e.g.:

```
CLOUDFLARE_API_TOKEN=<token> [CLOUDFLARE_ACCOUNT_ID=<id>] node scripts/ct-install.mjs <verb> [--json '<args>'] [--flags]
```

## Golden rules

- **Never print or echo the token** back to the user or into any file. Pass it
  inline on the command only. Tell the user they can revoke it after install.
- **One verb at a time.** Read its JSON result before the next step. On
  `ok:false`, stop and handle the error (see Error handling) — do not barrel on.
- **Don't improvise Cloudflare calls.** If a step isn't covered by a verb, say so
  rather than hand-rolling `curl`.
- Keep the user informed in plain language between steps; don't dump raw JSON.

## Step 0 — Token handoff (the one manual step)

Tell the user to create **one custom Cloudflare API token** at
<https://dash.cloudflare.com/profile/api-tokens> → **Create Token → Create
Custom Token**, with these permission groups:

**Core (always):**
- Account · Workers Scripts · Edit
- Zone · Workers Routes · Edit
- Account · D1 · Edit
- Account · Cloudflare Pages · Edit
- Zone · Zone · Read
- Account · Account Settings · Read

**Add these only if they want to lock the dashboard behind Cloudflare Access
(you'll ask in Step 7 — it's fine to include them now to avoid a second token):**
- Account · Access: Apps and Policies · Edit
- Account · Access: Organizations, Identity Providers, and Groups · Edit
- Zone · DNS · Edit

Set **Account Resources** to their account and **Zone Resources** to the zone
they'll track (or All zones). Recommend a short TTL. There is no reliable
pre-filled link — they must add these by hand.

Ask them to paste the token. Then run `preflight`. On success you have the
`accountId` — reuse it on every later call. If it reports multiple accounts, ask
which one and pass `CLOUDFLARE_ACCOUNT_ID`.

## Core install (always)

1. **`list-zones`** → if one active zone, propose it; if several, ask which
   domain to track. Derive `rootDomain` (the hostname) and `zoneName` (the zone).
   Default the dashboard host to `dashboard.<rootDomain>` but let them change it.
   If the domain they want isn't listed, stop: it must be on Cloudflare first.
2. **`d1-ensure`** → capture `data.uuid`.
3. **`toml-write`** `--json '{"rootDomain":"…","zoneName":"…","databaseId":"<uuid>"}'`
   → writes both `wrangler.toml` files with the same id.
4. **`schema-apply`**.
5. **`worker-deploy`**.
6. **`verify-worker`** `--json '{"rootDomain":"…"}'` → confirms a Googlebot UA is
   captured and a browser UA is not. If it fails with "no row", the route may
   still be propagating — offer to wait and re-run, or check `npm run tail`.
7. **`pages-ensure`** → creates the Pages project shell.

Now **ask**: "Lock the dashboard behind Cloudflare Access (email login), or
leave it unprotected?" Recommend locking — that's the usual reason to run this.

### If unprotected (declined)

- **`pages-deploy`** (no `--access-enforced`). The vars stay as `REPLACE_ME`, so
  the middleware does not enforce and the dashboard is reachable by anyone.
- Confirm `https://<dashboard host or *.pages.dev>/api/site` returns JSON with
  `host` and `last_ts` (both `null` until the first bot visit is recorded). Done.
- Remind the user it is unprotected, and that re-running `/install` can lock it later.

### If locked (opted in) — order matters (the middleware fails closed)

8. **`pages-domain-ensure`** `--json '{"host":"<dashboard host>"}'` → attaches the
   custom domain and polls until `active`. If it returns `pending`, the cert is
   still issuing — offer to re-run to keep polling; later steps can proceed but
   `verify-access` on the custom domain will fail until it's active.
9. **`access-otp-ensure`** → capture the OTP IdP `data.id`.
10. **`access-app-ensure`** `--json '{"host":"<dashboard host>","idpId":"<id>","email":"you@example.com"}'`
    (use `"emailDomain":"example.com"` instead of `email` to allow a whole
    domain). Ask the user who should be allowed in. Capture `data.aud`.
    **Never recreate an existing app** — the verb reuses it; the AUD must not
    change.
11. **`org-team-domain`** → capture `data.teamDomain` (already `https://…`). If it
    reports no `auth_domain`, the user must open Zero Trust once to pick a team
    name, then you re-run this verb.
12. **`dash-vars-write`** `--json '{"teamDomain":"<teamDomain>","aud":"<aud>"}'`
    → writes the dashboard `[vars]`. **Only after steps 10–11 succeed.**
13. **`pages-deploy --access-enforced`** → the guard refuses if the vars are still
    `REPLACE_ME`, so this confirms the ordering held.
14. **`verify-access`** `--json '{"host":"<dashboard host>"}'` → expects both the
    raw `*.pages.dev` URL and the custom domain to serve no content: a redirect
    to the `*.cloudflareaccess.com` login (what the Access plugin sends) or a 403. Tell the user to finish the email-PIN login in a browser to confirm
    end-to-end (the PIN step can't be scripted).

## Error handling

- `cfErrors` containing code `9109`/`10000` (or httpStatus 403) → the token is
  missing a permission. Name the specific scope for the step that failed and ask
  the user to recreate the token with it added, then resume from that step.
- `preflight` reports multiple accounts → ask which; pass `CLOUDFLARE_ACCOUNT_ID`.
- `org-team-domain` has no `auth_domain` → one-time Zero Trust team-name pick.
- `pages-domain-ensure` returns `pending`/`error` → surface the `validation`/
  `verification` detail; for `pending`, offer to re-run.
- Any verb is **idempotent** — re-running after a fix is safe (it reuses existing
  D1 / Pages project / Access app / OTP IdP rather than duplicating).

## Notes

- Everything is re-runnable: if the user comes back later, you can re-run from any
  step; the `ensure` verbs reconcile to the current Cloudflare state.
- This flow is also documented for manual use in `README.md` (the appendix). The
  non-Claude entry point is `npm run setup -- <verb>`.
