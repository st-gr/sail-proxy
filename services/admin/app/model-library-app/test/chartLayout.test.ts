/** Axis ticks and bubble placement for the SVG chart; pure so the geometry is testable. */
import { niceTicks, layoutBubbles, colorForIndex, CHART_PALETTE } from '../webapp/model/chartLayout';

describe('niceTicks', () => {
  it('produces round ticks that enclose the range', () => {
    expect(niceTicks(1213, 1410, 5)).toEqual([1200, 1250, 1300, 1350, 1400, 1450]);
    expect(niceTicks(0.6, 0.74, 5)).toEqual([0.6, 0.65, 0.7, 0.75]);
  });
  it('handles a single value and a zero range', () => {
    expect(niceTicks(5, 5, 5)).toEqual([4, 5, 6]);
    expect(niceTicks(0, 0, 5)).toEqual([-1, 0, 1]);
  });
});

describe('layoutBubbles', () => {
  const box = { width: 400, height: 300, padding: { left: 60, right: 20, top: 20, bottom: 50 } };
  it('maps points into the plot area with y growing upwards', () => {
    const out = layoutBubbles([{ modelId: 'a', label: 'A', provider: 'P', x: 1200, y: 0.6, size: 1 }, { modelId: 'b', label: 'B', provider: 'P', x: 1450, y: 0.75, size: 1 }], box);
    expect(out.xTicks[0]).toBe(1200); expect(out.yTicks[0]).toBe(0.6);
    expect(out.bubbles[0].cx).toBe(60); expect(out.bubbles[0].cy).toBe(250);       // min x → left edge, min y → bottom
    expect(out.bubbles[1].cx).toBe(380); expect(out.bubbles[1].cy).toBe(20);       // max x → right edge, max y → top
    expect(out.bubbles[0].r).toBe(6);
  });
  it('returns an empty layout for no points', () => {
    expect(layoutBubbles([], box)).toEqual({ xTicks: [], yTicks: [], bubbles: [], xOf: expect.any(Function), yOf: expect.any(Function) });
  });
});

describe('colorForIndex', () => {
  it('gives the same colour for the same index every time (stable, pure)', () => {
    expect(colorForIndex(0)).toBe(CHART_PALETTE[0]);
    expect(colorForIndex(0)).toBe(colorForIndex(0));
    expect(colorForIndex(3)).toBe(CHART_PALETTE[3]);
  });
  it('cycles through the palette once there are more points than colours', () => {
    expect(colorForIndex(CHART_PALETTE.length)).toBe(CHART_PALETTE[0]);
    expect(colorForIndex(CHART_PALETTE.length + 2)).toBe(CHART_PALETTE[2]);
  });
});
