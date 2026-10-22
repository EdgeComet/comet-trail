// Shown on every route while the database holds no visit yet (a fresh install):
// what CometTrail is waiting for, and how to make the first row appear now
// instead of waiting for a real bot.
import { reportHeader } from "../core/report.js";
import { h, card } from "../core/ui.js";

const code = (text) => h("pre", { className: "code" }, h("code", { text }));

// `site` is the /api/site response; schema === false means the crawls table
// does not exist yet.
export function renderWaiting(outlet, _params, site = null) {
  outlet.append(
    reportHeader({
      title: "Waiting for the first bot visit",
      subtitle: "CometTrail records each page a search or AI bot fetches from your site. No bot visit has been recorded yet.",
      period: false,
    }),
    card(
      { title: "Get the first visit recorded" },
      h(
        "ol",
        { className: "steps" },
        site?.schema === false
          ? h(
              "li",
              {},
              h("strong", { text: "Create the table. " }),
              "The database has no crawls table yet. Apply the schema once (",
              h("span", { className: "mono", text: "npm run db:init" }),
              ")."
            )
          : null,
        h(
          "li",
          {},
          h("strong", { text: "Check that the collector is live. " }),
          "The worker must be deployed and routed on the domain you track (",
          h("span", { className: "mono", text: "npm run deploy:worker" }),
          ")."
        ),
        h(
          "li",
          {},
          h("strong", { text: "Visit your site as Googlebot. " }),
          "Only bot user agents are recorded, so a normal browser visit adds nothing:",
          code('curl -A "Googlebot/2.1" https://your-domain.com/')
        ),
        h(
          "li",
          {},
          h("strong", { text: "Reload this page. " }),
          "The visit appears within seconds. From then on, every report fills in as real bots crawl: there is no crawl to schedule."
        )
      ),
      h(
        "p",
        { className: "steps-note" },
        "Want to look around first? Run ",
        h("span", { className: "mono", text: "make dev" }),
        " in the repository for a local copy with a demo store's data."
      )
    )
  );
  return null;
}
