#!/usr/bin/env node
// CometTrail installer helper — the deterministic "hands" of the hybrid setup.
//
// Each verb does ONE step, is idempotent (GET-before-write), and prints exactly
// ONE JSON object to stdout: { ok, state, data?, error? }. The /install command
// (the "brain") calls these verbs and decides what to do next; this file never
// makes decisions or talks to the user.
//
// Usage:
//   node scripts/ct-install.mjs <verb> [--json '<args-object>'] [--flag]
//
// Auth comes from the environment, never disk:
//   CLOUDFLARE_API_TOKEN   (required for every verb except `help`)
//   CLOUDFLARE_ACCOUNT_ID  (optional; resolved from the token if omitted)
//
// Verbs: preflight, list-zones, d1-ensure, toml-write, schema-apply,
//        worker-deploy, verify-worker, pages-ensure, pages-deploy,
//        pages-domain-ensure, access-otp-ensure, access-app-ensure,
//        org-team-domain, dash-vars-write, verify-access

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WORKER_DIR = path.join(ROOT, "worker");
const DASHBOARD_DIR = path.join(ROOT, "dashboard");
const SCHEMA = path.join(ROOT, "schema.sql");

const D1_NAME = "comet-trail";
const PAGES_PROJECT = "comet-trail-dashboard";
const API = "https://api.cloudflare.com/client/v4";

// ---------------------------------------------------------------------------
// Output: one JSON object, then exit. ok=false sets a non-zero exit code.
// ---------------------------------------------------------------------------
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(obj.ok ? 0 : 1);
}
const ok = (state, data = {}) => emit({ ok: true, state, data });
const fail = (step, message, extra = {}) =>
  emit({ ok: false, error: { step, message, ...extra } });

// ---------------------------------------------------------------------------
// Cloudflare API v4. Throws CfError on { success: false } so callers can read
// the CF error codes (e.g. 9109/10000 = auth/permission) and react.
// ---------------------------------------------------------------------------
class CfError extends Error {
  constructor(message, { status, cfErrors } = {}) {
    super(message);
    this.status = status;
    this.cfErrors = cfErrors || [];
  }
}

function token() {
  const t = process.env.CLOUDFLARE_API_TOKEN;
  if (!t) throw new CfError("CLOUDFLARE_API_TOKEN is not set in the environment");
  return t;
}

async function cf(method, pathname, body) {
  const res = await fetch(API + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new CfError(`Non-JSON response from ${method} ${pathname}`, {
      status: res.status,
    });
  }
  if (!json.success) {
    const errs = json.errors || [];
    const msg = errs.map((e) => `${e.code}: ${e.message}`).join("; ") ||
      `HTTP ${res.status}`;
    throw new CfError(msg, { status: res.status, cfErrors: errs });
  }
  return json.result;
}

// ---------------------------------------------------------------------------
// Account id: explicit env var wins; otherwise resolve from the token. If the
// token can see exactly one account we use it; more than one is ambiguous and
// the caller must pick (we return the list).
// ---------------------------------------------------------------------------
async function accountId() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const accounts = await cf("GET", "/accounts");
  if (!accounts.length) throw new CfError("Token can see no accounts");
  if (accounts.length > 1) {
    const e = new CfError("Multiple accounts visible; set CLOUDFLARE_ACCOUNT_ID");
    e.accounts = accounts.map((a) => ({ id: a.id, name: a.name }));
    throw e;
  }
  return accounts[0].id;
}

// ---------------------------------------------------------------------------
// wrangler shell-out. Inherits the env (incl. the CF token + account id) so it
// runs non-interactively. stdout/stderr are captured, never mixed into ours.
// ---------------------------------------------------------------------------
function wrangler(args, cwd) {
  const env = { ...process.env };
  if (process.env.CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
  // `npx.cmd` on Windows. Don't use shell:true — args here (e.g. the SQL passed
  // to d1 execute) contain spaces/quotes that a shell would re-split.
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const r = spawnSync(npx, ["wrangler", ...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`wrangler spawn failed: ${r.error.message}`);
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || "").trim().split("\n").slice(-12).join("\n");
    throw new Error(`wrangler ${args.join(" ")} exited ${r.status}:\n${tail}`);
  }
  return r.stdout || "";
}

// Pull the first JSON value out of mixed wrangler stdout.
function extractJson(str) {
  const start = str.search(/[[{]/);
  if (start === -1) throw new Error("no JSON in wrangler output");
  return JSON.parse(str.slice(start));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

// preflight: validate the token, then resolve the account id.
async function preflight() {
  const v = await cf("GET", "/user/tokens/verify");
  if (v.status !== "active") {
    return fail("preflight", `Token status is "${v.status}", expected "active"`);
  }
  let acct;
  try {
    acct = await accountId();
  } catch (e) {
    if (e.accounts) return fail("preflight", e.message, { accounts: e.accounts });
    throw e;
  }
  return ok("verified", { accountId: acct, tokenId: v.id });
}

// list-zones: active zones the token can read, for the domain pick.
async function listZones() {
  const zones = await cf("GET", "/zones?per_page=50");
  return ok("listed", {
    zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status })),
  });
}

// d1-ensure: reuse the comet-trail DB by name, or create it. Never a second one.
async function d1Ensure() {
  const acct = await accountId();
  const list = await cf("GET", `/accounts/${acct}/d1/database?name=${D1_NAME}`);
  const existing = list.find((d) => d.name === D1_NAME);
  if (existing) return ok("reused", { uuid: existing.uuid, name: D1_NAME });
  const created = await cf("POST", `/accounts/${acct}/d1/database`, { name: D1_NAME });
  return ok("created", { uuid: created.uuid, name: D1_NAME });
}

// toml-write: regenerate BOTH wrangler.toml files from their templates so the
// result is deterministic regardless of prior edits. Same database_id to both.
// Dashboard [vars] are left as REPLACE_ME placeholders (dash-vars-write fills
// them after the Access app exists).
function tomlWrite(args) {
  const { rootDomain, zoneName, databaseId } = args;
  if (!rootDomain || !zoneName || !databaseId) {
    return fail("toml-write", "need rootDomain, zoneName, databaseId");
  }

  // worker
  const workerTpl = readFileSync(path.join(WORKER_DIR, "wrangler.toml.default"), "utf8");
  const routes =
    `routes = [\n` +
    `  { pattern = "${rootDomain}/*",     zone_name = "${zoneName}" },\n` +
    `  { pattern = "www.${rootDomain}/*", zone_name = "${zoneName}" },\n` +
    `]`;
  let worker = workerTpl.replace(/routes\s*=\s*\[[\s\S]*?\]/, routes);
  worker = worker.replace(
    /database_id\s*=\s*"[^"]*"/,
    `database_id = "${databaseId}"`
  );
  writeFileSync(path.join(WORKER_DIR, "wrangler.toml"), worker);

  // dashboard (database_id only; vars stay as placeholders)
  const dashTpl = readFileSync(path.join(DASHBOARD_DIR, "wrangler.toml.default"), "utf8");
  const dash = dashTpl.replace(
    /database_id\s*=\s*"[^"]*"/,
    `database_id = "${databaseId}"`
  );
  writeFileSync(path.join(DASHBOARD_DIR, "wrangler.toml"), dash);

  return ok("written", {
    worker: "worker/wrangler.toml",
    dashboard: "dashboard/wrangler.toml",
    rootDomain,
    zoneName,
  });
}

// schema-apply: idempotent (schema.sql is all IF NOT EXISTS).
function schemaApply() {
  const stdout = wrangler(
    ["d1", "execute", D1_NAME, "--remote", `--file=${SCHEMA}`, "--yes"],
    WORKER_DIR
  );
  return ok("applied", { tail: stdout.trim().split("\n").slice(-3).join("\n") });
}

function workerDeploy() {
  const stdout = wrangler(["deploy"], WORKER_DIR);
  const m = stdout.match(/https?:\/\/\S+workers\.dev\S*/);
  return ok("deployed", { url: m ? m[0] : null });
}

// verify-worker: a Googlebot UA produces a row; a browser UA does not.
async function verifyWorker(args) {
  const { rootDomain } = args;
  if (!rootDomain) return fail("verify-worker", "need rootDomain");
  // Tag each request with a unique marker and match the stored row by that
  // marker, not the full URL — the origin may redirect (apex→www, http→https)
  // or normalize the host, so the captured request.url won't be byte-identical
  // to what we sent. The markers are distinct substrings (neither contains the
  // other) and are URL/SQL-safe (alphanumeric + hyphen).
  const stamp = Date.now();
  const posTag = `ctv-${stamp}-pos`;
  const negTag = `ctv-${stamp}-neg`;

  await fetch(`https://${rootDomain}/?_ct=${posTag}`, { headers: { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" } }).catch(() => {});
  await fetch(`https://${rootDomain}/?_ct=${negTag}`, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" } }).catch(() => {});

  // Inserts run in waitUntil + route propagation can lag; poll briefly.
  const queryRow = (tag) => {
    const out = wrangler(
      ["d1", "execute", D1_NAME, "--remote", "--json", "--yes", "--command",
        `SELECT bot_name, ts FROM crawls WHERE url LIKE '%${tag}%' ORDER BY ts DESC LIMIT 1`],
      WORKER_DIR
    );
    const parsed = extractJson(out);
    const results = Array.isArray(parsed) ? (parsed[0]?.results || []) : (parsed.results || []);
    return results[0] || null;
  };

  let posRow = null;
  for (let i = 0; i < 6 && !posRow; i++) {
    await sleep(2500);
    posRow = queryRow(posTag);
  }
  const negRow = queryRow(negTag);

  if (!posRow) {
    return fail("verify-worker",
      "No row captured for the Googlebot request. Route may not be active yet — check `npm run tail` and the worker/wrangler.toml routes.",
      { positiveCaptured: false });
  }
  if (negRow) {
    return fail("verify-worker",
      "A browser-UA request was captured but should not have been.",
      { positiveCaptured: true, negativeLeaked: true });
  }
  return ok("verified", { botName: posRow.bot_name, positiveCaptured: true, negativeLeaked: false });
}

// pages-ensure: create the project shell so a custom domain can attach before
// the first (correct) deploy. Reuse if it already exists.
async function pagesEnsure() {
  const acct = await accountId();
  try {
    const existing = await cf("GET", `/accounts/${acct}/pages/projects/${PAGES_PROJECT}`);
    return ok("reused", { name: existing.name });
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const created = await cf("POST", `/accounts/${acct}/pages/projects`, {
    name: PAGES_PROJECT,
    production_branch: "main",
  });
  return ok("created", { name: created.name });
}

// pages-deploy. When the caller passes --access-enforced (user opted into the
// lockdown), refuse to deploy until the dashboard [vars] are real — this is the
// fail-closed guard ensuring the Access app + AUD exist first.
function pagesDeploy(_args, flags) {
  const tomlPath = path.join(DASHBOARD_DIR, "wrangler.toml");
  const toml = readFileSync(tomlPath, "utf8");
  if (flags.has("access-enforced") && /REPLACE_ME/.test(toml)) {
    return fail("pages-deploy",
      "Access enforcement requested but dashboard/wrangler.toml still has REPLACE_ME [vars]. Run access-app-ensure + org-team-domain + dash-vars-write first.");
  }
  // Pass project + branch explicitly: spawnSync has no TTY, so an inferred
  // prompt (pick/create project, choose branch) would fail rather than wait.
  // The directory is inferred from pages_build_output_dir in wrangler.toml.
  const stdout = wrangler(
    ["pages", "deploy", "--project-name", PAGES_PROJECT, "--branch", "main", "--commit-dirty=true"],
    DASHBOARD_DIR
  );
  const m = stdout.match(/https?:\/\/\S+pages\.dev\S*/);
  return ok("deployed", { url: m ? m[0] : null, enforced: flags.has("access-enforced") });
}

// pages-domain-ensure: attach the custom domain, create the proxied CNAME that
// points it at the Pages project, then poll until active.
//
// The DNS step is essential: a Pages custom domain added via the API stays
// "pending" forever unless a DNS record points the host at <project>.pages.dev.
// The dashboard UI creates that record for you; the API does not. The record
// must be added AFTER the domain is associated above, or it serves a 522.
async function pagesDomainEnsure(args) {
  const { host } = args;
  if (!host) return fail("pages-domain-ensure", "need host");
  const acct = await accountId();
  const base = `/accounts/${acct}/pages/projects/${PAGES_PROJECT}/domains`;

  // 1. Associate the custom domain with the Pages project (idempotent).
  const list = await cf("GET", base);
  if (!list.find((d) => d.name === host)) {
    await cf("POST", base, { name: host });
  }

  // 2. Ensure the proxied CNAME exists. Auto-detect the zone: the host's zone is
  //    the longest account zone that `host` ends with (so this needs no extra
  //    argument and a stuck run can just re-invoke the same command).
  const zones = await cf("GET", "/zones?per_page=50");
  const zone = zones
    .filter((z) => host === z.name || host.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone) {
    return fail("pages-domain-ensure",
      `No zone in this account matches "${host}". Is its domain on Cloudflare, and does the token have Zone:Read?`);
  }
  const recs = await cf("GET", `/zones/${zone.id}/dns_records?name=${host}`);
  let dns;
  if (recs.find((r) => r.name === host)) {
    dns = "exists";
  } else {
    await cf("POST", `/zones/${zone.id}/dns_records`, {
      type: "CNAME",
      name: host,
      content: `${PAGES_PROJECT}.pages.dev`,
      proxied: true,
    });
    dns = "created";
  }

  // 3. Poll until active (cert issuance is async).
  let status = "pending";
  for (let i = 0; i < 24; i++) {
    const d = await cf("GET", `${base}/${host}`);
    status = d.status;
    if (status === "active") return ok("active", { host, status, dns });
    if (status === "error" || status === "blocked") {
      return fail("pages-domain-ensure", `Domain status is "${status}"`, {
        host, status, dns, validation: d.validation_data, verification: d.verification_data,
      });
    }
    await sleep(5000);
  }
  return ok("pending", { host, status, dns, note: "DNS record is in place; the certificate may still be issuing. Re-run to keep polling." });
}

// access-otp-ensure: find or create the One-Time PIN identity provider.
async function accessOtpEnsure() {
  const acct = await accountId();
  const idps = await cf("GET", `/accounts/${acct}/access/identity_providers`);
  const otp = idps.find((p) => p.type === "onetimepin");
  if (otp) return ok("reused", { id: otp.id });
  const created = await cf("POST", `/accounts/${acct}/access/identity_providers`, {
    name: "One-time PIN",
    type: "onetimepin",
    config: {},
  });
  return ok("created", { id: created.id });
}

// access-app-ensure: find a self-hosted app by hostname, or create it WITH an
// inline allow policy. The app's `aud` is captured (and reused on re-run — never
// recreate, or the AUD changes and breaks the deployed dashboard).
async function accessAppEnsure(args) {
  const { host, idpId, email, emailDomain } = args;
  if (!host) return fail("access-app-ensure", "need host");
  const acct = await accountId();

  const apps = await cf("GET", `/accounts/${acct}/access/apps`);
  const existing = apps.find((a) => a.domain === host);
  if (existing) return ok("reused", { appId: existing.id, aud: existing.aud });

  const include = email
    ? [{ email: { email } }]
    : emailDomain
      ? [{ email_domain: { domain: emailDomain } }]
      : null;
  if (!include) return fail("access-app-ensure", "need email or emailDomain for the allow policy");

  const body = {
    name: "CometTrail Dashboard",
    domain: host,
    type: "self_hosted",
    session_duration: "24h",
    auto_redirect_to_identity: true,
    policies: [{ name: "CometTrail allow", decision: "allow", include }],
  };
  if (idpId) body.allowed_idps = [idpId];

  const created = await cf("POST", `/accounts/${acct}/access/apps`, body);
  // The AUD is load-bearing (the dashboard middleware checks it). If the create
  // response didn't include it, read it back rather than write undefined.
  let aud = created.aud;
  if (!aud) {
    const fetched = await cf("GET", `/accounts/${acct}/access/apps/${created.id}`);
    aud = fetched.aud;
  }
  return ok("created", { appId: created.id, aud });
}

// org-team-domain: the <team>.cloudflareaccess.com value (returned without a
// scheme; CF_ACCESS_TEAM_DOMAIN needs the https:// prefix).
async function orgTeamDomain() {
  const acct = await accountId();
  const org = await cf("GET", `/accounts/${acct}/access/organizations`);
  if (!org || !org.auth_domain) {
    return fail("org-team-domain",
      "No Zero Trust auth_domain on this account. Open Zero Trust once to choose a team name, then re-run.");
  }
  return ok("found", {
    authDomain: org.auth_domain,
    teamDomain: `https://${org.auth_domain}`,
  });
}

// dash-vars-write: set the two Access [vars] in dashboard/wrangler.toml.
function dashVarsWrite(args) {
  const { aud } = args;
  if (!args.teamDomain || !aud) return fail("dash-vars-write", "need teamDomain and aud");
  // The plugin needs the full URL; normalize in case the bare auth_domain was passed.
  const teamDomain = /^https?:\/\//.test(args.teamDomain) ? args.teamDomain : `https://${args.teamDomain}`;
  const tomlPath = path.join(DASHBOARD_DIR, "wrangler.toml");
  let toml = readFileSync(tomlPath, "utf8");
  toml = toml.replace(/CF_ACCESS_TEAM_DOMAIN\s*=\s*"[^"]*"/, `CF_ACCESS_TEAM_DOMAIN = "${teamDomain}"`);
  toml = toml.replace(/CF_ACCESS_AUD\s*=\s*"[^"]*"/, `CF_ACCESS_AUD = "${aud}"`);
  // A missing [vars] block would make the replaces silent no-ops, leaving the
  // dashboard public despite the user opting into Access. Confirm both landed.
  if (!toml.includes(`CF_ACCESS_TEAM_DOMAIN = "${teamDomain}"`) ||
      !toml.includes(`CF_ACCESS_AUD = "${aud}"`)) {
    return fail("dash-vars-write",
      "Could not set the [vars] in dashboard/wrangler.toml (block missing?). Run toml-write first.");
  }
  writeFileSync(tomlPath, toml);
  return ok("written", { file: "dashboard/wrangler.toml" });
}

// verify-access: the raw *.pages.dev URL must 403; the custom domain must
// redirect to the Access login.
async function verifyAccess(args) {
  const { host } = args;
  if (!host) return fail("verify-access", "need host");

  const pagesRes = await fetch(`https://${PAGES_PROJECT}.pages.dev/api/summary`, { redirect: "manual" }).catch((e) => ({ error: e }));
  const pagesStatus = pagesRes && !pagesRes.error ? pagesRes.status : null;

  const hostRes = await fetch(`https://${host}/`, { redirect: "manual" }).catch((e) => ({ error: e }));
  const hostStatus = hostRes && !hostRes.error ? hostRes.status : null;
  const location = hostRes && hostRes.headers ? hostRes.headers.get("location") : null;

  const pagesLocked = pagesStatus === 403;
  const redirected = hostStatus >= 300 && hostStatus < 400 &&
    !!location && /cloudflareaccess\.com/.test(location);

  if (pagesLocked && redirected) {
    return ok("enforced", { pagesStatus, hostStatus, location });
  }
  return fail("verify-access",
    `Expected 403 on *.pages.dev (got ${pagesStatus}) and a redirect to *.cloudflareaccess.com (got ${hostStatus} -> ${location || "none"}). The custom domain may still be issuing its certificate.`,
    { pagesStatus, hostStatus, location, pagesLocked, redirected });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgv(argv) {
  const verb = argv[0];
  let args = {};
  const flags = new Set();
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      args = JSON.parse(argv[++i] || "{}");
    } else if (a.startsWith("--")) {
      flags.add(a.slice(2));
    }
  }
  return { verb, args, flags };
}

const VERBS = {
  preflight,
  "list-zones": listZones,
  "d1-ensure": d1Ensure,
  "toml-write": tomlWrite,
  "schema-apply": schemaApply,
  "worker-deploy": workerDeploy,
  "verify-worker": verifyWorker,
  "pages-ensure": pagesEnsure,
  "pages-deploy": pagesDeploy,
  "pages-domain-ensure": pagesDomainEnsure,
  "access-otp-ensure": accessOtpEnsure,
  "access-app-ensure": accessAppEnsure,
  "org-team-domain": orgTeamDomain,
  "dash-vars-write": dashVarsWrite,
  "verify-access": verifyAccess,
};

async function main() {
  const { verb, args, flags } = parseArgv(process.argv.slice(2));
  if (!verb || verb === "help" || !VERBS[verb]) {
    return emit({
      ok: !!verb && verb === "help",
      ...(verb && verb !== "help" ? { error: { step: "cli", message: `Unknown verb "${verb}"` } } : {}),
      data: { verbs: Object.keys(VERBS) },
    });
  }
  try {
    await VERBS[verb](args, flags);
  } catch (e) {
    const extra = {};
    if (e instanceof CfError) {
      extra.cfErrors = e.cfErrors;
      extra.httpStatus = e.status;
    }
    if (e.accounts) extra.accounts = e.accounts;
    fail(verb, e.message, extra);
  }
}

main();
