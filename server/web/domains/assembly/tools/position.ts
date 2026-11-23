// Save where the instances are now as a named position, to come back to (open, closed, folded).
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "position", title: "Named position", hint: "Keep where the moving parts are now under a name, to come back to: open, closed, folded.", section: "view", order: 20, keep: 54,
  keywords: "pose configuration state save position open closed",
  icon: '<path class="f" d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/><path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/>',
  disabled: (a) => (!a.getState().canEdit ? "View-only access" : a.getState().mating ? "Finish the mate first" : a.getState().instances.length ? null : "Place an instance first"),
  run: (a) => a.ask({ title: "Save position", acceptLabel: "Save", fields: [{ key: "name", label: "Name", kind: "text", value: `Position ${a.getState().positions.length + 1}` }], accept: (v) => a.saveCurrentPosition(String(v.name).trim() || undefined) }),
});
