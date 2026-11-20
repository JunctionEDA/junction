// ViewCube.tsx — the part studio's view cube (ViewCubeControl.tsx: the cube, the triad, the arrows and the view
// menu, as Onshape's), whose menu adds zoom to selection, normal to, the display modes, the planes, the section
// view and the named views.
import { namedViews } from "../document/appearance-items";
import { VIEW_MODES, displayOf } from "../inspect/appearance-display";
import { toggleSection } from "../inspect/section-pick";
import { sectionOf } from "../inspect/section-view";
import { useStore } from "../inspect/store";
import type { CameraState } from "../../../shared/viewport3d/viewport3d";
import { useStudio } from "./hooks";
import type { PartStudio } from "./studio";
import { ViewCubeControl } from "./ViewCubeControl";

/** The part studio's view cube: its menu also has zoom to selection, normal to, display modes, planes, section view and named views. */
export function ViewCube({ studio }: { studio: PartStudio }) {
  const display = displayOf(studio), section = sectionOf(studio);
  const mode = useStore(display, (s) => s.mode);
  const perspective = useStore(display, (s) => s.perspective);
  const sectionOn = useStore(section, (s) => s.on);
  const planes = useStudio(studio, (s) => s.planesVisible);
  const sketch = useStudio(studio, (s) => !!s.sketch);
  const hasBodies = useStudio(studio, (s) => s.bodies.length > 0);
  useStudio(studio, (s) => s.features);
  const views = namedViews(studio.doc);
  return (
    <ViewCubeControl viewport={studio.viewport} fit={() => studio.fit()} perspective={perspective} setPerspective={(on) => display.setPerspective(on)}
      hint="Standard views, zoom, projection, display mode, section view, planes, named views."
      zoom={({ row }) => <>
        {row("Zoom to selection", null, () => studio.zoomToSelection(), { key: "Z" })}
        {row("View normal to", null, () => studio.normalTo(), { key: "N" })}
      </>}
      more={({ row, head }) => <>
        {head("Display")}
        {VIEW_MODES.map((m, i) => row(m.title, mode === m.id, () => display.setMode(m.id), { key: i === 0 ? "W cycles" : undefined, why: sketch ? "Finish the sketch first" : null }))}
        {head("Show")}
        {row("Planes", planes, () => studio.setPlanesVisible(!planes), { key: "P" })}
        {row("Section view", sectionOn, () => { void toggleSection(studio); }, { key: "X", why: sketch ? "Finish the sketch first" : hasBodies ? null : "Nothing to cut" })}
        {views.length ? head("Named views") : null}
        {views.map((v) => row(v.name, null, () => studio.viewport.setCameraState(v.camera as unknown as CameraState), { attr: "named-" + v.name }))}
      </>} />
  );
}
