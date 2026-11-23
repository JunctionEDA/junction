// Group: hold the selected instances together as they stand, so they move as one (two parts that never move
// against each other need no mate between them).  A folder of the list is something else: it holds nothing.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "group", title: "Group", hint: "Hold the selected instances together as they stand: they move as one.", section: "connect", order: 20, keep: 58, key: "g",
  keywords: "rigid lock together weld bond fasten keep relative",
  icon: '<rect class="d t" x="2.5" y="2.5" width="19" height="19" rx="1.5"/><rect class="f" x="5.5" y="6" width="6.5" height="6.5"/><rect x="5.5" y="6" width="6.5" height="6.5"/><rect x="12" y="11.5" width="6.5" height="6.5"/>',
  disabled: (a) => (!a.getState().canEdit ? "View-only access" : a.selectedInstances().length >= 2 ? null : "Select two or more instances first"),
  run: (a) => a.groupRigid(a.selectedInstances().map((i) => i.id)),
});
