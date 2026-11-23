// Fix or unfix the selected instances: a fixed instance stays where it is, and the mates move the others to it.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "fix", title: "Fix", hint: "Hold the selected instances where they are; again to let them go.", section: "connect", order: 30, keep: 70, key: "f",
  keywords: "ground anchor lock pin hold fixed unfix constrain",
  icon: '<path class="f" d="M8 3.5h8l-1.5 6 3.5 3.5H6l3.5-3.5z"/><path d="M8 3.5h8l-1.5 6 3.5 3.5H6l3.5-3.5z"/><path d="M12 13v8"/>',
  disabled: (a) => (!a.getState().canEdit ? "View-only access" : a.selectedInstances().length ? null : "Select an instance first"),
  active: (a) => { const s = a.selectedInstances(); return s.length > 0 && s.every((i) => !!i.fixed); },
  run: (a) => { const s = a.selectedInstances(); a.setFixed(s.map((i) => i.id), !s.every((i) => !!i.fixed)); },
});
