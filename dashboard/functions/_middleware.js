// Runs in front of every route (the static page and /api/*).
//
// Access enforcement is opt-in at the code level (the `/install` flow asks, and
// locking is the recommended choice — so an installed dashboard is normally
// private). This middleware only enforces once the vars are configured:
//   - If CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD are unset or still hold the
//     `REPLACE_ME…` template placeholders, this middleware does nothing and the
//     page is served to anyone (an unconfigured deploy is unprotected).
//   - Once both vars hold real values (see README "Locking the dashboard behind
//     Cloudflare Access", or run `/install` in Claude Code), it verifies the
//     Cloudflare Access JWT (Cf-Access-Jwt-Assertion) on every request:
//     signature against the team JWKS, plus `aud` and issuer. A request
//     without a valid token gets no content: the plugin redirects it (302) to
//     the team's Access login.
//
// Enforcing is what locks the *.pages.dev URL and every per-deploy preview
// alias — those hostnames are not fronted by the Access app, so they carry no
// token. Real access flows through the custom domain, where Access injects the
// token after login. Who is allowed in is decided by the Access policy (allowed
// emails / domains), not here — the policy is the single source of truth.
//
// Config comes from wrangler [vars]:
//   CF_ACCESS_TEAM_DOMAIN = "https://<team>.cloudflareaccess.com"  (full URL)
//   CF_ACCESS_AUD         = "<application audience tag>"
import cloudflareAccessPlugin from "@cloudflare/pages-plugin-cloudflare-access";

// A var counts as "configured" only when it holds a real value — not empty and
// not the `REPLACE_ME…` placeholder shipped in wrangler.toml.default. This keeps
// the dashboard from failing closed (403 for everyone, including you) before the
// Access app and its vars actually exist.
// `.includes` (not `.startsWith`): the team-domain placeholder is
// "https://REPLACE_ME.cloudflareaccess.com", so REPLACE_ME is in the middle.
const isConfigured = (v) =>
  typeof v === "string" && v.length > 0 && !v.includes("REPLACE_ME");

export const onRequest = (context) => {
  const { CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD } = context.env;

  if (!isConfigured(CF_ACCESS_TEAM_DOMAIN) || !isConfigured(CF_ACCESS_AUD)) {
    // Access not set up → public dashboard.
    return context.next();
  }

  return cloudflareAccessPlugin({
    domain: CF_ACCESS_TEAM_DOMAIN,
    aud: CF_ACCESS_AUD,
  })(context);
};
