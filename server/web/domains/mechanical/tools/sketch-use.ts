// The Use tool: draw an edge or a corner of the model in the sketch, projected onto the sketch plane.
import { defineTool } from "../core/tool";
import { runUse } from "../sketch/modify";

export default defineTool({
  id: "sketch-use", title: "Use edge", hint: "Click an edge or a corner of the model to draw it in the sketch.", group: "sketch", order: 120, keep: 83, key: "u", menu: "Use",
  icon: '<path class="f" d="M5 2.5h14v8H5z"/><path class="t" d="M5 10.5v-8h14v8"/><path d="M12 12.5v5M9.5 15L12 17.5l2.5-2.5"/><path d="M4 20.5h16" stroke-width="2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-use",
  run: (studio) => runUse(studio, "sketch-use"),
});
