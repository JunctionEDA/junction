// The Intersection sketch tool: curves where the sketch plane cuts the model.
import { defineTool } from "../core/tool";
import { runIntersection } from "../sketch/modify";

export default defineTool({
  id: "sketch-intersection", title: "Intersection", hint: "Click a face (Shift: a whole part) to draw the curves where the sketch plane cuts it, pinned.", group: "sketch", order: 121, keep: 50, menu: "Use",
  icon: '<path class="f" d="M4 9l8-5 8 5v8l-8 5-8-5z"/><path class="t" d="M4 9l8-5 8 5v8l-8 5-8-5z"/><path d="M2 13.5h20" stroke-width="2.2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-intersection",
  run: (studio) => runIntersection(studio, "sketch-intersection"),
});
