// Small DOM helpers shared by every Chart's loading/error states.

// A spinning indicator. Consumes the @keyframes spin already in styles.css.
export function spinnerEl() {
  const el = document.createElement("div");
  el.className = "spinner";
  el.setAttribute("role", "status");
  el.setAttribute("aria-label", "Loading");
  return el;
}

// An inline error message. Uses textContent (never innerHTML) so an error
// string can't inject markup into the page.
export function errorEl(message) {
  const el = document.createElement("div");
  el.className = "chart-error";
  el.setAttribute("role", "alert");
  el.textContent = `Failed to load: ${message}`;
  return el;
}

// A page heading (title + optional subtitle) shared by every routed view, so
// the three pages get a consistent header beneath the app chrome.
export function pageHeader(title, subtitle) {
  const header = document.createElement("div");
  header.className = "page-header";

  const h1 = document.createElement("h1");
  h1.className = "page-title";
  h1.textContent = title;
  header.appendChild(h1);

  if (subtitle) {
    const p = document.createElement("p");
    p.className = "page-subtitle";
    p.textContent = subtitle;
    header.appendChild(p);
  }
  return header;
}

// A "nothing here yet" card for pages whose widgets are not built. `items` is
// an optional list of the planned contents, rendered as a checklist so the
// placeholder doubles as a spec for what the page will hold.
export function emptyState(lead, items = []) {
  const card = document.createElement("div");
  card.className = "card empty-state";

  const body = document.createElement("div");
  body.className = "card-body card-body-lg";

  const p = document.createElement("p");
  p.className = "empty-state-lead";
  p.textContent = lead;
  body.appendChild(p);

  if (items.length) {
    const ul = document.createElement("ul");
    ul.className = "empty-state-list";
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = item;
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }

  card.appendChild(body);
  return card;
}
