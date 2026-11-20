// Parameters: every variable, feature value and sketch dimension of the part studio in one table that can be
// searched and changed in place (ui/ParametersTable.tsx).
import { defineTool } from "../core/tool";

export default defineTool({
  id: "parameters", title: "Parameters", hint: "Every variable, feature value and sketch dimension in one table: change them in place, with expressions, comments and stars.",
  icon: '<rect x="3" y="4.5" width="18" height="15" rx="1.5"/><path d="M3 9.5h18M3 14.5h18M9 4.5v15"/><path class="s" d="M5.2 6.2l.6 1.2 1.3.2-1 .9.3 1.3-1.2-.7"/>',
  group: "feature", section: "reference", order: 91, keep: 30,
  run: (studio) => studio.setUi({ parameters: true }),
});
