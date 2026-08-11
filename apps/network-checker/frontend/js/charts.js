// Hand-rolled SVG line charts. A charting library would be a second
// dependency to draw a handful of polylines, and it could not be loaded
// offline anyway — this is the whole engine, generic over any series set.

export function buildChart(rows, seriesKeys, { width = 900, height = 150, floor = 10, pad = 4 } = {}) {
  const out = { width, height, rows, series: {}, xAt: null, yAt: null, max: floor };
  if (rows.length < 2) return out;

  const all = rows.flatMap((r) => seriesKeys.map((k) => r[k])).filter((v) => v != null);
  const max = Math.max(floor, ...all);
  const xAt = (i) => (i / (rows.length - 1)) * width;
  const yAt = (v) => height - (v / max) * (height - pad * 2) - pad;

  for (const key of seriesKeys) {
    out.series[key] = rows.map((r, i) => (r[key] == null ? null : { x: xAt(i), y: yAt(r[key]), v: r[key], i }));
  }
  return { ...out, xAt, yAt, max };
}

export function polyline(points) {
  return points.filter(Boolean).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

/** One path of rectangle subpaths (not one <rect> per band): keeps the
 * failure-band overlay to a single SVG element regardless of row count. */
export function bandsPath(chart, predicate, bandWidth = 4) {
  if (!chart.xAt) return "";
  return chart.rows
    .map((r, i) => (predicate(r) ? `M${(chart.xAt(i) - bandWidth / 2).toFixed(1)},0h${bandWidth}v${chart.height}h-${bandWidth}Z` : null))
    .filter(Boolean)
    .join(" ");
}

/** Nearest row to a pointer x-position in SVG user units — the basis for the
 * hover tooltip on every chart. */
export function nearestIndex(chart, x) {
  if (!chart.rows.length) return -1;
  const step = chart.width / Math.max(1, chart.rows.length - 1);
  return Math.min(chart.rows.length - 1, Math.max(0, Math.round(x / step)));
}
