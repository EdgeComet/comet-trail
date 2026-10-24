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
    this.params = {}; // extra query params a page sets (a URL, a filter)
    this.actions = null; // a control a page puts in the card header (core/botGroup.js)
    this.range = null; // the period of the newest load
  }

  // Orchestration: spinner -> provider.get -> render | error.
  // Rapid range switches race, so a load only commits if it is still the
  // newest one when its response arrives (the seq guard).
  load(from, to) {
    this.range = { from, to };
    const seq = ++this._seq;
    this.showLoading();
    return this._paint(seq, from, to);
  }

  // Load the same period again after `params` changed (a switch in the card
  // header), without the spinner: the card keeps showing the old figures until
  // the new ones paint, so it does not blink.
  reload() {
    if (!this.range) return undefined;
    return this._paint(++this._seq, this.range.from, this.range.to);
  }

  async _paint(seq, from, to) {
    try {
      const data = await this.provider.get(from, to, this.params);
      if (seq !== this._seq) return; // a newer load superseded this one
      // A control the card keeps across renders (a header switch) is put back
      // into the new card; give it back the focus it had.
      const focused = this.el.contains(document.activeElement) ? document.activeElement : null;
      this.render(data);
      if (focused?.isConnected && document.activeElement !== focused) focused.focus();
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

  // Optional teardown when the view unmounts (Dashboard.destroy calls it).
  // Bumping _seq invalidates any load still in flight, so its awaited render()
  // is skipped instead of painting into the now-detached DOM after teardown.
  // Subclasses that own a chart-library instance (e.g. billboard) override to
  // also release it — and must call super.destroy() to keep the seq guard.
  destroy() {
    this._seq++;
  }
}
