// Add an explicit mate connector: a connector that stays on a part where it was put (with an offset, a turn or
// a flip of its own), for a mate to use later.  Implicit connectors need none of this: a mate tool finds them
// under the pointer.  An explicit one is for a place that has no geometry of its own, or that several mates share.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "connector", title: "Mate connector", hint: "Click a face, an edge or a point to keep a connector there, for mates to use.", section: "connect", order: 10, keep: 60,
  keywords: "connector coordinate system frame point axis csys",
  icon: '<circle class="f" cx="9" cy="15" r="3.5"/><circle cx="9" cy="15" r="3.5"/><path d="M9 15V3.5M7 5.5l2-2 2 2M9 15h11.5M18.5 13l2 2-2 2"/><path class="t" d="M9 15l-5.5 5"/>',
  disabled: (a) => (!a.getState().canEdit ? "View-only access" : a.getState().instances.length ? null : "Place an instance first"),
  active: (a) => a.getState().connecting,
  run: (a) => a.setConnecting(!a.getState().connecting),
});
