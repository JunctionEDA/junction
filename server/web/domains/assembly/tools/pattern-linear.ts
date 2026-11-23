// Linear instance pattern: copies of the selected instances in a row.  The copies follow their seeds.
import { defineAssemblyTool } from "../core/tool";
import { askPattern } from "../ui/forms";

export default defineAssemblyTool({
  id: "pattern-linear", title: "Linear pattern", hint: "Copies of the selected instances in a row; they go where their seed goes.", section: "pattern", menu: "Pattern", order: 10, keep: 52,
  keywords: "array repeat copy row grid instances",
  icon: '<rect class="f" x="3" y="3" width="7.5" height="7.5" rx="1"/><rect x="3" y="3" width="7.5" height="7.5" rx="1"/><rect class="t" x="13.5" y="3" width="7.5" height="7.5" rx="1"/><rect class="t" x="3" y="13.5" width="7.5" height="7.5" rx="1"/><rect class="t" x="13.5" y="13.5" width="7.5" height="7.5" rx="1"/>',
  disabled: (a) => (!a.getState().canEdit ? "View-only access" : a.selectedInstances().length ? null : "Select the instances to repeat first"),
  run: (a) => askPattern(a, "linear"),
});
