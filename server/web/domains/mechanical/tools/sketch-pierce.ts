// The Pierce sketch tool: a point where a curve of the model passes through the sketch.
import { defineTool } from "../core/tool";
import { runPierce } from "../sketch/modify";

export default defineTool({
  id: "sketch-pierce", title: "Pierce", hint: "Click a sketch point, then an edge of the model that passes through the sketch plane: the point goes where it pierces.", group: "sketch", order: 296, keep: 35,
  icon: '<path class="f" d="M2 15l6-6h14l-6 6z"/><path class="t" d="M2 15l6-6h14l-6 6z"/><path d="M8 22L16 2" stroke-width="2"/><circle class="s" cx="12" cy="12" r="2.3"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-pierce",
  run: (studio) => runPierce(studio, "sketch-pierce"),
});
