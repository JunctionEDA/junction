// The Partial ellipse sketch tool: part of an ellipse.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { partialEllipse } from "../sketch/curve-shapes";

export default defineTool({
  id: "sketch-partial-ellipse", title: "Partial ellipse", hint: "Click the centre, the end of the major axis, the minor radius, then where the curve starts and ends.", group: "sketch", order: 49, keep: 68, menu: "Ellipse",
  icon: '<ellipse class="d t" cx="12" cy="13" rx="9.5" ry="6"/><path d="M2.5 13a9.5 6 0 0 1 16.2-4.25"/><circle class="s" cx="2.5" cy="13" r="2"/><circle class="s" cx="18.7" cy="8.75" r="2"/><circle class="s" cx="12" cy="13" r="1.8"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-partial-ellipse",
  run: (studio) => startDrawTool(studio, partialEllipse()),
});
