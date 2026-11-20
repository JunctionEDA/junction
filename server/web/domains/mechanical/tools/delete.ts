// Delete: what is selected in the open sketch (curves, points, constraints, dimensions), or else the feature
// selected in the list (a selected folder goes with what is in it).
import { defineTool } from "../core/tool";
import { deleteItems } from "../document/folders";
import { sketchEditor } from "../sketch/editor";

export default defineTool({
  id: "delete", title: "Delete", group: "edit", order: 30, keep: 0, key: "Delete",
  icon: '<path class="f" d="M6 7.5h12l-1 12.5H7z"/><path d="M4 7.5h16M9.5 4h5M6 7.5L7 20h10l1-12.5M10 11.5v5M14 11.5v5"/>',
  disabled: (studio) => {
    const s = studio.getState();
    if (!s.canEdit) return "View-only access";
    if (s.sketch) return null;   // the sketch editor keeps its own selection; an empty one is answered when pressed
    return s.selectedFeature && !s.editing ? null : "Nothing selected";
  },
  run: (studio) => {
    const s = studio.getState();
    if (s.sketch) { if (!sketchEditor(studio).deleteSelection()) studio.host.toast("Select something in the sketch to delete.", 2500); return; }
    // every row selected in the feature list goes, as one step
    const ids = s.selectedFeatures.length ? s.selectedFeatures : s.selectedFeature ? [s.selectedFeature] : [];
    if (ids.length && !s.editing && studio.doc) { const changes = deleteItems(studio.doc, ids); if (changes.length) studio.commit(changes); }
  },
});
