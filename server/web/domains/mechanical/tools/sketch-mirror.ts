// The Mirror tool: copies across a line that stay its mirror image.
import { defineTool } from "../core/tool";
import { runMirror } from "../sketch/modify";

export default defineTool({
  id: "sketch-mirror", title: "Mirror", hint: "Select what to mirror, then click the line to mirror about.", group: "sketch", order: 130, keep: 82, key: "m",
  icon: '<path d="M9.5 4.5v15h-7z"/><path class="d t" d="M14.5 4.5v15h7z"/><path class="d" d="M12 2v20"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-mirror",
  run: (studio) => runMirror(studio, "sketch-mirror"),
});
