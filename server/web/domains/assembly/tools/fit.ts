// Zoom to fit the whole assembly.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "fit", title: "Zoom to fit", hint: "The whole assembly in view. Also a double click beside it.", section: "more", order: 10, key: "z",
  keywords: "fit all view zoom extents home",
  icon: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect class="f" x="8.5" y="8.5" width="7" height="7"/><rect x="8.5" y="8.5" width="7" height="7"/>',
  run: (a) => a.fit(),
});
