// Router — a minimal History API router for the dashboard SPA.
//
// Maps a pathname to a render function and paints it into a single outlet
// element. Clicks on [data-route] links are intercepted and turned into
// history.pushState navigations (no full reload); back/forward fire popstate
// and re-render. The matching nav link is flagged .active on every render.
//
// A render function receives the (already emptied) outlet, builds its DOM into
// it, and may return a teardown function that runs before the next render —
// the hook a view uses to drop subscriptions or destroy charts.
export class Router {
  constructor(outlet) {
    this.outlet = outlet;
    this.routes = new Map(); // path -> { render(outlet) => teardown?, title }
    this.fallback = null; // path used when the URL matches no route
    this._teardown = null; // cleanup returned by the current view, if any
    this.brand = document.title; // base title from <title>, e.g. "CometTrail"
    window.addEventListener("popstate", () => this._render());
  }

  // Register a route. `title` (optional) is shown in the document title /
  // browser tab when the route is active. Chainable.
  add(path, render, title) {
    this.routes.set(path, { render, title });
    return this;
  }

  // Turn every [data-route] anchor into a pushState navigation.
  bindLinks() {
    document.querySelectorAll("[data-route]").forEach((a) => {
      a.addEventListener("click", (e) => {
        // Let the browser handle anything that isn't a plain left-click: a
        // modifier or middle-click means "open in a new tab/window", which
        // calling preventDefault would silently break.
        if (e.defaultPrevented || e.button !== 0 ||
            e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        this.navigate(a.getAttribute("href"));
      });
    });
  }

  navigate(path) {
    if (path !== location.pathname) history.pushState({}, "", path);
    this._render();
  }

  // Resolve the initial URL (normalizing an unknown path — e.g. "/" — to the
  // fallback so the address bar matches the view) and paint it.
  start(fallback) {
    this.fallback = fallback;
    if (!this.routes.has(location.pathname)) {
      history.replaceState({}, "", fallback);
    }
    this._render();
  }

  _resolve() {
    return this.routes.has(location.pathname) ? location.pathname : this.fallback;
  }

  _render() {
    const path = this._resolve();
    if (this._teardown) this._teardown();
    this._setActiveNav(path);
    const { render, title } = this.routes.get(path);
    document.title = title ? `${title} · ${this.brand}` : this.brand;
    this.outlet.replaceChildren();
    this._teardown = typeof render === "function" ? render(this.outlet) : null;
  }

  _setActiveNav(path) {
    document.querySelectorAll("[data-route]").forEach((a) => {
      const active = a.getAttribute("href") === path;
      a.classList.toggle("active", active);
      if (active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
}
