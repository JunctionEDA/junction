// Delete: the selected curves and points of the open sketch, or else the feature selected in the list.
import { defineTool } from "../core/tool";
import { deleteFeature } from "../document/edits";
import { openSketch, sketchEntitiesChange } from "../sketch/drawing";
import { withOrphanPoints } from "../sketch/format";
import type { PartStudio } from "../ui/studio";

function target(studio: PartStudio): { entities: string[] } | { feature: string } | null {
  const s = studio.getState();
  if (s.sketch) {
    const ids = s.selection.filter((p) => p.kind === "sketch" && p.featureId === s.sketch!.featureId && p.entity).map((p) => (p as { entity: string }).entity);
    return ids.length ? { entities: ids } : null;
  }
  return s.selectedFeature && !s.editing ? { feature: s.selectedFeature } : null;
}

export default defineTool({
  id: "delete", title: "Delete", group: "edit", order: 30, key: "Delete",
  icon: '<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 12h8l1-12"/>',
  disabled: (studio) => (!studio.getState().canEdit ? "View-only access" : target(studio) ? null : "Nothing selected"),
  run: (studio) => {
    const t = target(studio); if (!t || !studio.doc) return;
    if ("feature" in t) { studio.commit(deleteFeature(studio.doc, t.feature)); return; }
    const sk = openSketch(studio); if (!sk) return;
    const gone: { [id: string]: null } = {};
    for (const id of withOrphanPoints(sk.data, t.entities)) gone[id] = null;
    studio.select([]);
    studio.commit([sketchEntitiesChange(sk.featureId, gone)]);
  },
});
