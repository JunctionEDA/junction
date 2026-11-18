// The Extend tool: lengthen the end of a line or an arc to the next curve it would meet.
import { defineTool } from "../core/tool";
import { runExtend } from "../sketch/modify";

export default defineTool({
  id: "sketch-extend", title: "Extend", hint: "Click near the end of a line or an arc to lengthen it to the next curve.", group: "sketch", order: 150, keep: 66, key: "x",
  icon: '<path d="M20.5 3v18"/><path d="M3 12h6"/><path class="d" d="M9.5 12h8"/><path d="M14.5 8.5L18 12l-3.5 3.5"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-extend",
  run: (studio) => runExtend(studio, "sketch-extend"),
});
