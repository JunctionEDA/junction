// New custom feature: open the editor on a new script (script/ui/editor-state.ts).  It sits at the end of the
// Custom features drop-down, after the project's own features.
import { defineTool } from "../core/tool";
import { editorOf } from "../script/ui/editor-state";

export default defineTool({
  id: "script-new", title: "New custom feature…",
  hint: "Write a feature of your own as a short script, or describe it and have the assistant write it. It is saved to this project and works like any other feature.",
  icon: '<path d="M8.500 7 4 12l4.500 5M15.500 7 20 12l-4.500 5"/><path class="t" d="M13 5.500 11 18.500"/>',
  group: "feature", section: "library", menu: "This project", order: 99991, keep: 0,
  disabled: (studio) => (studio.getState().canEdit ? null : "View-only access"),
  active: (studio) => editorOf(studio).getState().open,
  run: (studio) => { const e = editorOf(studio); if (!e.getState().open) e.openNew(); },
});
