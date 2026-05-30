// Dashboard — owns the list of charts and fans out a re-render to all of them
// whenever the global date range changes. This is the only place that bridges
// the DateRangeStore to the charts, so charts stay unaware of the range source.
export class Dashboard {
  constructor(dateRange) {
    this.dateRange = dateRange;
    this.charts = [];
    dateRange.subscribe(({ from, to }) => this._renderAll(from, to));
  }

  add(chart) {
    this.charts.push(chart);
    return chart;
  }

  _renderAll(from, to) {
    for (const chart of this.charts) chart.load(from, to);
  }

  // Initial paint with the current range (cache empty -> one AJAX per chart).
  start() {
    const { from, to } = this.dateRange.get();
    this._renderAll(from, to);
  }
}
