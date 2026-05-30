// Content page — placeholder.
//
// Routing scaffold only: the view renders its header and a checklist of the
// widgets it will hold. The data already exists in the crawls table (title,
// h1, h2, hreflangs, structured_data_types); see the "Content" queries in
// docs/queries.md for the backing SQL.
import { pageHeader, emptyState } from "../core/ui.js";

export function renderContent(outlet) {
  outlet.append(
    pageHeader("Content", "The SEO fields bots saw on each page.")
  );
  outlet.append(
    emptyState("Nothing here yet. This page will show:", [
      "Title and H1 changes for a URL over time",
      "Hreflang coverage across the site",
      "Structured-data types seen, by page count",
      "Heading depth (H2 count) per page",
    ])
  );
}
