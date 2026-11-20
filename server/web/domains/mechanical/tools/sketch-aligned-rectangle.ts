// The Aligned rectangle sketch tool: rectangle on an edge at any angle: two points along one side, a third for the width.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { alignedRectangle } from "../sketch/curve-shapes";

export default defineTool({
  id: "sketch-aligned-rectangle", title: "Aligned rectangle", hint: "Click one edge's two ends, then move out for the width. Its sides stay square to each other at any angle.", group: "sketch", order: 24, keep: 99, menu: "Rectangle",
  icon: '<path class="f" d="M3.5 13.5l7-9 10 7.6-7 9z"/><path d="M3.5 13.5l7-9 10 7.6-7 9z"/><circle class="s" cx="3.5" cy="13.5" r="2.2"/><circle class="s" cx="10.5" cy="4.5" r="2.2"/><circle class="s" cx="20.5" cy="12.1" r="2.2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-aligned-rectangle",
  run: (studio) => startDrawTool(studio, alignedRectangle),
});
