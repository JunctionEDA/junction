// Section view: cut the view open with a plane across the assembly to look inside.  A way of looking: nothing is stored.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "section", title: "Section view", hint: "Cut the view open across X, Y or Z to look inside; slide the cut along.", section: "inspect", order: 30, keep: 50,
  keywords: "cross-section cut view slice clip inside",
  icon: '<path class="f" d="M12 3.5a8.5 8.5 0 0 0 0 17z"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17"/><path class="d t" d="M12 3.5a8.5 8.5 0 0 1 0 17"/><path d="M12 1.5v21"/>',
  disabled: (a) => (a.getState().instances.length ? null : "Place an instance first"),
  active: (a) => !!a.getState().section,
  run: (a) => { if (a.getState().section) a.setSection(null); else { const [lo, hi] = a.extent("x"); a.setSection({ axis: "x", offset: (lo + hi) / 2, flip: false }); } },
});
