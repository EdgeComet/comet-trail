// Indexation page — placeholder.
//
// Routing scaffold only: the view renders its header and a checklist of the
// widgets it will hold. The data already exists in the crawls table
// (index_status, meta_robots, meta_googlebot, canonical); see the "Indexation"
// queries in docs/queries.md for the backing SQL.
import { pageHeader, emptyState } from "../core/ui.js";

export function renderIndexation(outlet) {
  outlet.append(
    pageHeader("Indexation", "Whether bots can index what they crawled.")
  );
  outlet.append(
    emptyState("Nothing here yet. This page will show:", [
      "Indexation status breakdown (indexable / non-200 / blocked / non-canonical)",
      "URLs blocked from indexing, with the offending robots directives",
      "Pages missing a canonical link",
      "URLs whose indexation status flipped between visits",
    ])
  );
}
