// Circular instance pattern: copies of the selected instances around an axis.  The copies follow their seeds.
import { defineAssemblyTool } from "../core/tool";
import { askPattern } from "../ui/forms";

export default defineAssemblyTool({
  id: "pattern-circular", title: "Circular pattern", hint: "Copies of the selected instances around an axis; they go where their seed goes.", section: "pattern", menu: "Pattern", order: 20, keep: 52,
  keywords: "array repeat copy polar radial ring instances",
  icon: '<circle class="d t" cx="12" cy="12.5" r="7.5"/><circle class="s" cx="12" cy="12.5" r="1.3"/><circle class="f" cx="12" cy="5" r="3"/><circle cx="12" cy="5" r="3"/><circle class="t" cx="5.5" cy="16.2" r="3" fill="var(--color-bench, #fff)"/><circle class="t" cx="18.5" cy="16.2" r="3" fill="var(--color-bench, #fff)"/>',
  disabled: (a) => (!a.getState().canEdit ? "View-only access" : a.selectedInstances().length ? null : "Select the instances to repeat first"),
  run: (a) => askPattern(a, "circular"),
});
