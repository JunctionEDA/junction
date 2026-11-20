// The Dimension tool: click what to measure, click where the text goes, type the value (sketch/dimension.ts).
import { defineTool } from "../core/tool";
import { runDimensionTool } from "../sketch/dimension";

export default defineTool({
  id: "sketch-dimension", title: "Dimension", hint: "Click a line, a circle, or two things; click where the text goes; type the value.", group: "sketch", order: 300, keep: 96, key: "d",
  icon: '<path d="M3.5 4v16M20.5 4v16"/><path d="M6.5 12h11M9.5 9l-3 3 3 3M14.5 9l3 3-3 3"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-dimension",
  run: (studio) => runDimensionTool(studio, "sketch-dimension"),
});
