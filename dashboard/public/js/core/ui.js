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
