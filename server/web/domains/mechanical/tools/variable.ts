// Variable: add a variable to the part studio (name = expression) and show it in the Variables panel, where its
// name is ready to type.  Onshape's Variable feature; here a variable is part of the studio rather than a step of
// the feature list, so it holds everywhere (document/variables.ts).  Any number field of a feature then takes an
// expression that uses it: "width / 2", or "#width / 2" as Onshape writes it.
import { defineTool } from "../core/tool";
import { addVariable, freeName } from "../document/variables";
import { showPanel } from "../ui/panels";

export default defineTool({
  id: "variable", title: "Variable", hint: "A named value (#name = expression) that any number of any feature can use.",
  icon: '<path d="M4 9h7M4 15h7M7.5 5l-1.5 14M10.5 5L9 19"/><path class="t" d="M14 9h7M14 14h7"/><path d="M17.5 7v4"/>',
  group: "feature", section: "reference", order: 90, keep: 30,
  disabled: (studio) => (studio.getState().canEdit ? null : "View-only access"),
  run(studio) {
    const doc = studio.doc;
    if (!doc) return;
    const { changes, variable } = addVariable(doc, freeName(doc), "10 mm");
    studio.commit(changes);
    showPanel("variables");
    // the new row's name, selected, to type over, once the panel has drawn it
    let tries = 0;
    const focus = () => {
      const input = document.querySelector<HTMLInputElement>(`[data-variable="${variable.name}"] input`);
      if (input) { input.focus(); input.select(); } else if (++tries < 30) requestAnimationFrame(focus);
    };
    setTimeout(focus, 0);
  },
});
