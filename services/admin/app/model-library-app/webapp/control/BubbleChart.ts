import Control from "sap/ui/core/Control";
import RenderManager from "sap/ui/core/RenderManager";
import { layoutBubbles, colorForIndex } from "../model/chartLayout";
import type { ChartPoint } from "../model/benchmarks";

/** The controller pre-colours each point (colorForIndex(i), same order as /library/chart/points)
 * so the legend list and this control read the exact same colour; colorForIndex(i) here is only a
 * fallback for a caller that did not. */
type ColoredPoint = ChartPoint & { color?: string };

/**
 * A dependency-free bubble/scatter chart rendered as inline SVG: each point is a model, with a
 * native tooltip, colored per-point from chartLayout's small palette (colorForIndex) so every
 * bubble is distinguishable. The legend (C2) lives outside this control, in the view, as a plain
 * sap.m.List bound to the same points array — same order, so the same colour applies to a bubble
 * and its legend row. Replaces sap.viz so the app stays small and cannot break on a framework
 * build that omits the viz library.
 *
 * @namespace admin.modellibrary.control
 */
export default class BubbleChart extends Control {
  static readonly metadata = {
    properties: {
      points: { type: "object[]", defaultValue: [] },
      xLabel: { type: "string", defaultValue: "" },
      yLabel: { type: "string", defaultValue: "" },
      height: { type: "sap.ui.core.CSSSize", defaultValue: "480px" }
    },
    events: { press: { parameters: { point: { type: "object" } } } }
  };

  static renderer = {
    apiVersion: 2,
    render(rm: RenderManager, c: BubbleChart): void {
      const points = (c.getProperty("points") || []) as ColoredPoint[];
      const width = 900, heightPx = parseInt(String(c.getProperty("height")), 10) || 480;
      const box = { width, height: heightPx, padding: { left: 70, right: 20, top: 20, bottom: 56 } };
      const lay = layoutBubbles(points, box);
      rm.openStart("div", c).class("mlBubbleChart").style("width", "100%").openEnd();
      rm.openStart("svg").attr("viewBox", `0 0 ${width} ${heightPx}`).attr("role", "img").attr("aria-label", `${c.getProperty("xLabel")} vs ${c.getProperty("yLabel")}`).style("width", "100%").style("height", String(c.getProperty("height"))).openEnd();
      if (!points.length) {
        rm.openStart("text").attr("x", String(width / 2)).attr("y", String(heightPx / 2)).attr("text-anchor", "middle").attr("fill", "#556b82").openEnd().text("No benchmark scores for the selected models and axes").close("text");
      } else {
        // axes
        const x0 = box.padding.left, x1 = width - box.padding.right, y0 = heightPx - box.padding.bottom, y1 = box.padding.top;
        lay.yTicks.forEach(t => { const y = lay.yOf(t); rm.openStart("line").attr("x1", String(x0)).attr("x2", String(x1)).attr("y1", String(y)).attr("y2", String(y)).attr("stroke", "#d9d9d9").openEnd().close("line"); rm.openStart("text").attr("x", String(x0 - 8)).attr("y", String(y + 4)).attr("text-anchor", "end").attr("font-size", "12").attr("fill", "#556b82").openEnd().text(String(t)).close("text"); });
        lay.xTicks.forEach(t => { const x = lay.xOf(t); rm.openStart("line").attr("y1", String(y0)).attr("y2", String(y1)).attr("x1", String(x)).attr("x2", String(x)).attr("stroke", "#eeeeee").openEnd().close("line"); rm.openStart("text").attr("x", String(x)).attr("y", String(y0 + 18)).attr("text-anchor", "middle").attr("font-size", "12").attr("fill", "#556b82").openEnd().text(String(t)).close("text"); });
        rm.openStart("text").attr("x", String((x0 + x1) / 2)).attr("y", String(heightPx - 12)).attr("text-anchor", "middle").attr("font-size", "13").attr("fill", "#32363a").openEnd().text(String(c.getProperty("xLabel"))).close("text");
        rm.openStart("text").attr("transform", `translate(16 ${(y0 + y1) / 2}) rotate(-90)`).attr("text-anchor", "middle").attr("font-size", "13").attr("fill", "#32363a").openEnd().text(String(c.getProperty("yLabel"))).close("text");
        // bubbles
        lay.bubbles.forEach((b, i) => {
          rm.openStart("circle").attr("data-index", String(i)).attr("cx", String(b.cx)).attr("cy", String(b.cy)).attr("r", String(b.r)).attr("fill", b.point.color || colorForIndex(i)).attr("fill-opacity", "0.75").attr("stroke", "#ffffff").style("cursor", "pointer").openEnd();
          rm.openStart("title").openEnd().text(`${b.point.label} — ${c.getProperty("xLabel")}: ${b.point.x}, ${c.getProperty("yLabel")}: ${b.point.y}`).close("title");
          rm.close("circle");
        });
      }
      rm.close("svg");
      rm.close("div");
    }
  };

  onclick(e: MouseEvent): void {
    const el = e.target as Element;
    const idx = el?.getAttribute?.("data-index");
    if (idx !== null && idx !== undefined) {
      const points = (this.getProperty("points") || []) as ChartPoint[];
      // bubbles are rendered in points order
      if (points[Number(idx)]) this.fireEvent("press", { point: points[Number(idx)] });
    }
  }
}
