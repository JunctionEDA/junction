// The Circular pattern sketch tool: copies of the selection round a centre.
import { defineTool } from "../core/tool";
import { runCircularPattern } from "../sketch/arrange";

export default defineTool({
  id: "sketch-circular-pattern", title: "Sketch circular pattern", hint: "Select what to pattern, take the tool, click the centre, then move round (or type 360). N sets how many.", group: "sketch", order: 161, keep: 55, menu: "Pattern",
  icon: '<circle class="d t" cx="12" cy="12" r="7.5"/><circle class="f" cx="12" cy="4.5" r="2.4"/><circle cx="12" cy="4.5" r="2.4"/><circle class="t" cx="19.5" cy="12" r="2.4"/><circle class="t" cx="12" cy="19.5" r="2.4"/><circle class="t" cx="4.5" cy="12" r="2.4"/><circle class="s" cx="12" cy="12" r="1.6"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-circular-pattern",
  run: (studio) => runCircularPattern(studio, "sketch-circular-pattern"),
});
