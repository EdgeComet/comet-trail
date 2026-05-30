// Chart — any provider-fed visual component (not only a billboard.js graph).
//
// A chart owns one DOM element and is fed by one Provider. It does NOT listen
// for date-range changes itself; the Dashboard registry calls load(from, to)
// on every chart, keeping charts dumb and the wiring in one place.
import { spinnerEl, errorEl } from "./ui.js";

export class Chart {
  constructor(el, provider) {
    this.el = el; // container this chart fully controls
    this.provider = provider; // Provider instance feeding this chart
    this._seq = 0; // monotonic token guarding against out-of-order loads
  }

  // Orchestration: spinner -> provider.get -> render | error.
  // Rapid range switches race, so a load only commits if it is still the
  // newest one when its response arrives (the seq guard).
  async load(from, to) {
    const seq = ++this._seq;
    this.showLoading();
    try {
      const data = await this.provider.get(from, to);
      if (seq !== this._seq) return; // a newer load superseded this one
      this.render(data);
    } catch (err) {
      if (seq !== this._seq) return;
      this.showError(err.message);
    }
  }

  showLoading() {
    this.el.replaceChildren(spinnerEl());
  }

  showError(message) {
    this.el.replaceChildren(errorEl(message));
  }

  // Subclasses MUST implement: paint `data` into this.el.
  render(_data) {
    throw new Error("Chart.render() not implemented");
  }
}
