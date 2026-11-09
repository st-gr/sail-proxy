import type { ChartPoint } from './benchmarks';

/**
 * C2: a small, repeating palette for chart bubbles and their legend rows. Colour is assigned
 * purely by a point's position in the points array, so the bubble and its legend row (same
 * index) always match, and re-rendering the same points array always yields the same colours.
 */
export const CHART_PALETTE = ["#0070f2", "#d27700", "#36a41d", "#e76500", "#8b47d7", "#c35500", "#049f9a", "#a93e00", "#256f3a", "#1b4fa0"];
export function colorForIndex(i: number): string { return CHART_PALETTE[i % CHART_PALETTE.length]; }

/** "Nice" tick values (1, 2, 5 × 10^n steps) enclosing [min, max]; a degenerate range is widened by one step around it. */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) { const step = min === 0 ? 1 : Math.pow(10, Math.floor(Math.log10(Math.abs(min)))) / (Math.abs(min) >= 10 ? 1 : 1); const s = min === 0 ? 1 : Math.max(step, 1); return [min - s, min, min + s]; }
  const raw = (max - min) / Math.max(1, count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  // Floating-point division (e.g. 0.6 / 0.05 === 11.999999999999998) can push a boundary that
  // should land exactly on a step below it; nudge by an epsilon before flooring/ceiling.
  const EPS = 1e-9;
  const start = Math.floor(min / step + EPS) * step;
  const end = Math.ceil(max / step - EPS) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

export interface Box { width: number; height: number; padding: { left: number; right: number; top: number; bottom: number }; }
// Generic over the point type (default ChartPoint) so a caller that hands in points already
// carrying extra fields — e.g. BubbleChart's ColoredPoint (adds "color") — gets that field back
// on Bubble.point typed, instead of narrowed to plain ChartPoint.
export interface Bubble<P extends ChartPoint = ChartPoint> { cx: number; cy: number; r: number; point: P; }
export interface Layout<P extends ChartPoint = ChartPoint> { xTicks: number[]; yTicks: number[]; bubbles: Bubble<P>[]; xOf: (v: number) => number; yOf: (v: number) => number; }

export function layoutBubbles<P extends ChartPoint>(points: P[], box: Box): Layout<P> {
  const noop = () => 0;
  if (!points.length) return { xTicks: [], yTicks: [], bubbles: [], xOf: noop, yOf: noop };
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const xTicks = niceTicks(Math.min(...xs), Math.max(...xs), 6);
  const yTicks = niceTicks(Math.min(...ys), Math.max(...ys), 6);
  const x0 = xTicks[0], x1 = xTicks[xTicks.length - 1], y0 = yTicks[0], y1 = yTicks[yTicks.length - 1];
  const plotW = box.width - box.padding.left - box.padding.right;
  const plotH = box.height - box.padding.top - box.padding.bottom;
  const xOf = (v: number) => box.padding.left + (x1 === x0 ? plotW / 2 : (v - x0) / (x1 - x0) * plotW);
  const yOf = (v: number) => box.padding.top + plotH - (y1 === y0 ? plotH / 2 : (v - y0) / (y1 - y0) * plotH);
  const maxSize = Math.max(...points.map(p => p.size || 1));
  const bubbles = points.map(p => ({ cx: round(xOf(p.x)), cy: round(yOf(p.y)), r: 6 + 8 * ((p.size || 1) / maxSize) - 8 + 0, point: p }));
  return { xTicks, yTicks, bubbles: bubbles.map(b => ({ ...b, r: round(Math.max(6, b.r)) })), xOf, yOf };
}
const round = (n: number) => Math.round(n * 100) / 100;
