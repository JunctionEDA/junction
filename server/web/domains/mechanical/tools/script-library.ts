// Custom feature library: the project's own features in one list (script/ui/LibraryDialog.tsx): use, edit,
// rename, duplicate, export, import, delete, and the examples that ship.
import { defineTool } from "../core/tool";
import { LIBRARY_UI } from "../script/ui/LibraryDialog";

export default defineTool({
  id: "script-library", title: "Custom feature library…",
  hint: "The custom features of this project: use one, edit its script, rename, duplicate, export or import, and add the examples that ship.",
  icon: '<rect x="4" y="4" width="16" height="16" rx="1.500"/><path d="M4 9.500h16M4 14.500h16"/><path class="t" d="M7.500 7h3M7.500 12h5M7.500 17h4"/>',
  group: "feature", section: "library", menu: "This project", order: 99992, keep: 0,
  run: (studio) => studio.setUi({ [LIBRARY_UI]: true }),
});
