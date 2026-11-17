// Put the sketch tool down: clicks select curves and points again.
import { defineTool } from "../core/tool";

export default defineTool({
  id: "sketch-select", title: "Select", hint: "Click a curve or a point; Delete removes it.", group: "sketch", order: 0,
  icon: '<path d="M6 4l11 8-5 1 3 6-2 1-3-6-4 3z"/>',
  active: (studio) => studio.getState().sketch?.tool === "select",
  run: (studio) => studio.setSketchTool("select"),
});
