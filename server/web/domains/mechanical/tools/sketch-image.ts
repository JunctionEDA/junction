// The Image sketch tool: a reference picture on the sketch plane.
import { defineTool } from "../core/tool";
import { runImage } from "../sketch/insert";

export default defineTool({
  id: "sketch-image", title: "Image", hint: "Choose a picture, then click two corners. It lies on the sketch plane for tracing and makes no geometry.", group: "sketch", order: 59, keep: 20,
  icon: '<rect class="f" x="3" y="5" width="18" height="14" rx="1.5"/><rect x="3" y="5" width="18" height="14" rx="1.5"/><path class="t" d="M3 17l5-5 4 4 3-3 6 6"/><circle class="s" cx="15.5" cy="9" r="1.8"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-image",
  run: (studio) => runImage(studio, "sketch-image"),
});
