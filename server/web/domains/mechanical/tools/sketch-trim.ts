// The Trim tool: cut a curve back to where other curves cross it.
import { defineTool } from "../core/tool";
import { runTrim } from "../sketch/modify";

export default defineTool({
  id: "sketch-trim", title: "Trim", hint: "Click the part of a curve to cut away.", group: "sketch", order: 140, keep: 89, key: "t",
  icon: '<circle cx="6" cy="6.5" r="3"/><circle cx="6" cy="17.5" r="3"/><path d="M8.5 8.3L21 18M8.5 15.7L21 6"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-trim",
  run: (studio) => runTrim(studio, "sketch-trim"),
});
