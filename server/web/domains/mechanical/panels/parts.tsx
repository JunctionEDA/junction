// The Parts panel: the parts list (ui/PartsList.tsx) under the feature list.  What the features up to the
// rollback bar make, in sections: Parts, Surfaces, Curves, Composite parts.  A panel is one file here; see
// core/tool.ts.
//
// It also marks, in the feature list, the rows of the features that made or changed what is selected in the
// model (a part chosen here, a face clicked in the viewport): ui/part-actions.ts crossFeatures.
import { definePanel } from "../core/tool";
import { Glyph } from "../ui/Glyph";
import { useStudio } from "../ui/hooks";
import { crossFeatures } from "../ui/part-actions";
import { PART_ICONS, PartsList } from "../ui/PartsList";
import { addFeatureRowSlot } from "../ui/slots";
import type { PartStudio } from "../ui/studio";
import { tipHandlers } from "../ui/Tip";

/** At the end of a feature's row: this feature made or changed what is selected. */
function MadeSelection({ studio, featureId }: { studio: PartStudio; featureId: string }) {
  const on = useStudio(studio, () => crossFeatures(studio).has(featureId));
  if (!on) return null;
  return <span className="flex-none text-accent" data-part-cross {...tipHandlers({ title: "Shaped the selection", hint: "This feature made or changed what is selected in the model." })}><Glyph svg={PART_ICONS.part} size={14} /></span>;
}
addFeatureRowSlot(MadeSelection);

export default definePanel({
  id: "parts", title: "Parts", side: "left", order: 20,
  count: (studio) => studio.getState().bodies.filter((b) => !b.reference && !b.sheet).length || null,
  render: (studio) => <PartsList studio={studio} />,
});
