// Report header shared by every page view: title and subtitle on the left, the
// period selector on the right, as in the EdgeComet dashboard. The selector
// drives the one global range (core/dateRange.js), so a period chosen on one
// page carries over to the next.
//
// The selector is the quick 7D / 30D / 90D buttons plus the date range itself,
// which opens a popover with every preset and a custom From / To range.
import { globalRange, PRESETS, MAX_DAYS, dayOf } from "./dateRange.js";
import { h, icon } from "./ui.js";

const QUICK = [7, 30, 90];

// Period labels use UTC days, the days the charts are bucketed by.
const DAY_UTC = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const DATE_UTC = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function rangeLabel({ from, to }) {
  return `${DAY_UTC.format(new Date(from))} - ${DATE_UTC.format(new Date(to))}`;
}

export function periodSelector(range = globalRange) {
  const quick = QUICK.map((days) =>
    h("button", { type: "button", className: "period-btn", title: `Last ${days} days`, text: `${days}D` })
  );
  const nameEl = h("strong", { className: "period-name" });
  const datesEl = h("span");
  const trigger = h(
    "button",
    { type: "button", className: "period-dates", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Choose the period" },
    icon("calendar"),
    nameEl,
    datesEl,
    icon("chevronDown")
  );
  const box = h("div", { className: "period", role: "group", "aria-label": "Period" }, ...quick, trigger);
  const wrap = h("div", { className: "period-wrap" }, box);

  // Reflect the store in the buttons and the label.
  const sync = () => {
    quick.forEach((btn, i) => {
      const on = !range.custom && range.days === QUICK[i];
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    });
    nameEl.textContent = range.name();
    datesEl.textContent = rangeLabel(range.get());
  };

  quick.forEach((btn, i) =>
    btn.addEventListener("click", () => {
      close();
      range.setDays(QUICK[i]);
      sync();
    })
  );

  // --- Popover ---------------------------------------------------------------
  let pop = null;

  const onOutside = (e) => {
    if (!wrap.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      close();
      trigger.focus();
    }
  };

  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onOutside);
    document.removeEventListener("keydown", onKey);
  }

  function open() {
    pop = buildPopover(range, {
      onPreset: (days) => {
        close();
        range.setDays(days);
        sync();
        trigger.focus();
      },
      onCustom: (fromDay, toDay) => {
        const error = range.setCustom(fromDay, toDay);
        if (error) return error;
        close();
        sync();
        trigger.focus();
        return null;
      },
      onCancel: () => {
        close();
        trigger.focus();
      },
    });
    wrap.append(pop);
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onKey);
    pop.querySelector(".period-preset.active, .period-preset")?.focus();
  }

  trigger.addEventListener("click", () => (pop ? close() : open()));

  sync();
  return wrap;
}

function buildPopover(range, { onPreset, onCustom, onCancel }) {
  const presets = h(
    "div",
    { className: "period-presets", role: "group", "aria-label": "Presets" },
    PRESETS.map((p) => {
      const on = !range.custom && range.days === p.days;
      return h(
        "button",
        {
          type: "button",
          className: on ? "period-preset active" : "period-preset",
          "aria-pressed": String(on),
          on: { click: () => onPreset(p.days) },
        },
        h("span", { text: p.label }),
        on ? icon("check") : null
      );
    })
  );

  // The custom fields open on the current period, limited to recorded data.
  const { from, to } = range.get();
  const today = dayOf(Date.now());
  const first = range.minTs !== null ? dayOf(range.minTs) : null;
  const dateInput = (label, value) =>
    h("input", { className: "input", type: "date", value, min: first, max: today, "aria-label": label, required: true });
  const fromInput = dateInput("Start date", range.custom?.fromDay ?? dayOf(from));
  const toInput = dateInput("End date", range.custom?.toDay ?? dayOf(to));
  const error = h("p", { className: "period-error", role: "alert" });

  const apply = (e) => {
    e.preventDefault();
    const message = onCustom(fromInput.value, toInput.value);
    error.textContent = message ?? "";
  };

  const custom = h(
    "form",
    { className: "period-custom", on: { submit: apply } },
    h("div", { className: "period-custom-title", text: "Custom range" }),
    h(
      "div",
      { className: "period-fields" },
      h("label", { className: "period-field" }, h("span", { text: "From" }), fromInput),
      h("label", { className: "period-field" }, h("span", { text: "To" }), toInput)
    ),
    error,
    h(
      "div",
      { className: "period-actions" },
      h("button", { type: "button", className: "btn btn-ghost btn-sm", on: { click: onCancel } }, "Cancel"),
      h("button", { type: "submit", className: "btn btn-primary btn-sm" }, "Apply")
    )
  );

  const note = first
    ? `Data from ${DATE_UTC.format(new Date(range.minTs))}. Up to ${MAX_DAYS} days, in UTC like the charts.`
    : `Up to ${MAX_DAYS} days, in UTC like the charts.`;

  return h(
    "div",
    { className: "period-pop", role: "dialog", "aria-label": "Choose the period" },
    h("div", { className: "period-pop-body" }, presets, custom),
    h("p", { className: "period-note", text: note })
  );
}

export function reportHeader({ title, subtitle = "", period = true, actions = null, back = null }) {
  return h(
    "header",
    { className: "report-header" },
    h(
      "div",
      { className: "report-heading" },
      back ? h("a", { className: "back-link", href: back.href, "data-route": "" }, icon("arrowLeft"), back.label) : null,
      h("h1", { className: "report-title", text: title }),
      subtitle ? h("p", { className: "report-subtitle", text: subtitle }) : null
    ),
    h("div", { className: "report-actions" }, actions, period ? periodSelector() : null)
  );
}
