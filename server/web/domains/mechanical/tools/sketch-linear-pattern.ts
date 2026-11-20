// The Linear pattern sketch tool: copies of the selection in a row.
import { defineTool } from "../core/tool";
import { runLinearPattern } from "../sketch/arrange";

export default defineTool({
  id: "sketch-linear-pattern", title: "Linear pattern", hint: "Select what to pattern, take the tool, click a point, then where its first copy goes. N sets how many.", group: "sketch", order: 160, keep: 55, menu: "Pattern",
  icon: '<rect class="f" x="2.5" y="8" width="5" height="8"/><rect x="2.5" y="8" width="5" height="8"/><rect class="t" x="9.5" y="8" width="5" height="8"/><rect class="t" x="16.5" y="8" width="5" height="8"/><path class="d" d="M2 20h20"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-linear-pattern",
  run: (studio) => runLinearPattern(studio, "sketch-linear-pattern"),
});
