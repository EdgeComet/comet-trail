// Router - a minimal History API router for the dashboard SPA.
//
// Maps a pathname to a render function and paints it into a single outlet
// element. Clicks on any [data-route] link, including links a view builds
// later, are intercepted (one delegated listener) and turned into
// history.pushState navigations; back/forward fire popstate and re-render. The
// matching sidebar link is flagged .active on every render.
//
// A render function receives the (already emptied) outlet and the query
// params, builds its DOM into it, and may return a teardown function that runs
// before the next render - the hook a view uses to drop subscriptions or
// destroy charts.
export class Router {
  constructor(outlet) {
    this.outlet = outlet;
    this.routes = new Map(); // path -> { render, title, nav }
    this.fallback = null; // path used when the URL matches no route
    this._teardown = null; // cleanup returned by the current view, if any
    this.brand = document.title; // base title from <title>, e.g. "CometTrail"
    this.beforeRender = null; // optional hook run before every view paints
    window.addEventListener("popstate", () => this._render());
  }

  // Register a route. `title` shows in the browser tab; `nav` names the
  // sidebar link to highlight when it differs from the path (a detail view
  // under a list). Chainable.
  add(path, render, title, nav = path) {
    this.routes.set(path, { render, title, nav });
    return this;
  }

  // Turn every [data-route] anchor, present or future, into a pushState
  // navigation.
  bindLinks() {
    document.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-route]");
      if (!a) return;
      // Let the browser handle anything that isn't a plain left-click: a
      // modifier or middle-click means "open in a new tab/window", which
      // calling preventDefault would silently break.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      this.navigate(a.getAttribute("href"));
    });
  }

  navigate(href) {
    const target = new URL(href, location.origin);
    if (target.pathname + target.search !== location.pathname + location.search) {
      history.pushState({}, "", target.pathname + target.search);
      window.scrollTo(0, 0);
    }
    this._render();
  }

  // Resolve the initial URL (normalizing an unknown path - e.g. "/" - to the
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
    const { render, title, nav } = this.routes.get(path);
    this._setActiveNav(nav);
    document.title = title ? `${title} · ${this.brand}` : this.brand;
    if (this.beforeRender) this.beforeRender(path);
    this.outlet.replaceChildren();
    const params = new URLSearchParams(location.search);
    this._teardown = typeof render === "function" ? render(this.outlet, params) : null;
  }

  _setActiveNav(path) {
    document.querySelectorAll(".sidebar [data-route]").forEach((a) => {
      const active = a.getAttribute("href") === path;
      a.classList.toggle("active", active);
      if (active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
}
