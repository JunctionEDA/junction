// SketchDialog.tsx — the dialog of a sketch, in the place and the frame of a feature's dialog: its name, ✓ (keep
// it) and ✗ (put it back as it was), the plane it lies on, the two things a person sets about sketching, and how
// the sketch stands.
//
// The plane field is the heart of it.  A new sketch is not put on a plane for you: started with nothing
// selected, the dialog opens with the field empty and listening ("Select a plane or planar face") and waits; a
// click on a plane, a flat face or a plane's row in the feature list fills it, and only then are there sketch
// tools.  Once filled, the field shows the plane with a × beside it: × empties the field, which then waits for
// another plane (the sketch stays where it is until one is clicked; Esc leaves it there).
import { useSyncExternalStore } from "react";
import { cx } from "../../../shared/util";
import { DEFAULT_PLANES, type PlaneRef } from "../core/geometry";
import { sketchEditor } from "../sketch/editor";
import { DialogShell } from "./DialogShell";
import { Glyph } from "./Glyph";
import { useStudio } from "./hooks";
import { setPrefs, usePref } from "./prefs";
import { TONE, standing } from "./StatusBar";
import { awaitsPlane, featureDef, type PartStudio } from "./studio";
import { tipHandlers } from "./Tip";
import { CROSS } from "./Toolbar";

const ASK = "Select a plane or planar face";

/** The field that holds the sketch's plane: empty and listening, or the plane with a × to clear it. */
function PlaneField({ name, kind, armed, onArm, onClear }: { name: string | null; kind: string; armed: boolean; onArm(): void; onClear?(): void }) {
  return (
    <div className="flex flex-col gap-1" data-field="plane">
      <span className="text-sm text-ink-2">Sketch plane</span>
      <div className={cx("flex items-center h-8 rounded-sm border bg-panel", armed ? "border-blue outline outline-1 outline-blue" : "border-line-2")} data-sketch-plane={kind} data-armed={armed || undefined} data-empty={name ? undefined : true}>
        <button type="button" className={cx("appearance-none bg-transparent border-0 m-0 [font-family:inherit] [font-size:inherit] flex-1 min-w-0 h-full pl-2.5 pr-1 text-left truncate cursor-pointer", name ? "text-ink" : "text-ink-3")} data-sketch-plane-name aria-label={name ? `Sketch plane: ${name}. Click to choose another` : ASK}
          {...tipHandlers({ title: armed ? "Listening" : "Sketch plane", hint: armed ? "Click a plane or a flat face, in the model or in the feature list." : "Click here, then a plane or a flat face, to move the sketch." })} onClick={onArm}>
          {name || ASK}
        </button>
        {name && onClear ? (
          <button type="button" className="btn sm ghost flex-none p-0 w-7 h-7 min-h-0 mr-0.5 justify-center text-ink-2" aria-label={`Clear ${name}`} data-sketch-plane-clear {...tipHandlers({ title: "Clear", hint: "Empty the field, then click another plane or flat face." })} onClick={onClear}>
            <Glyph svg={CROSS} size={14} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Options({ studio }: { studio: PartStudio }) {
  const normal = usePref("sketchNormal"), glyphs = usePref("showConstraints");
  return (
    <div className="flex flex-col gap-0.5">
      <label className="flex items-center gap-2 h-7 cursor-pointer" {...tipHandlers({ title: "Show constraints", hint: "The small marks that say what holds the sketch: horizontal, coincident, tangent… Those in conflict are always shown." })}><input type="checkbox" checked={glyphs} data-pref="showConstraints" onChange={(ev) => setPrefs({ showConstraints: ev.target.checked })} /><span>Show constraints</span></label>
      <label className="flex items-center gap-2 h-7 cursor-pointer" {...tipHandlers({ title: "Face the plane", shortcut: "N", hint: "Opening a sketch turns the view to look straight at it, and finishing turns it back. N does it at any time." })}><input type="checkbox" checked={normal} data-pref="sketchNormal" onChange={(ev) => { setPrefs({ sketchNormal: ev.target.checked }); if (ev.target.checked) studio.faceSketch(); }} /><span>Face the plane on opening</span></label>
    </div>
  );
}

export function SketchDialog({ studio }: { studio: PartStudio }) {
  const open = useStudio(studio, (s) => s.sketch);
  const feature = useStudio(studio, (s) => (s.sketch ? s.features.find((f) => f.id === s.sketch!.featureId) : undefined));
  const features = useStudio(studio, (s) => s.features);
  const picking = useStudio(studio, (s) => !!s.ui?.pickingPlane);
  const cleared = useStudio(studio, (s) => !!s.ui?.planeCleared);
  // a new sketch whose plane has not been chosen: nothing is in the document yet
  const draft = useStudio(studio, (s) => (awaitsPlane(s) ? s.editing!.draft : null));
  const listening = useStudio(studio, (s) => !!s.editing?.field);
  const ed = sketchEditor(studio);
  const st = useSyncExternalStore(ed.subscribe, ed.getState);
  const icon = featureDef("sketch")?.icon;
  if (draft) {
    return (
      <DialogShell key="new" className="cad-dialog cad-sketch-dialog" icon={icon} name={draft.name} onName={(name) => studio.setDraft({ name })} attrs={{ "data-feature": "sketch", "data-sketch-waiting": "plane" }}
        onAccept={() => studio.acceptFeature()} onCancel={() => studio.cancelFeature()} acceptAttrs={{ "data-accept": true }} cancelAttrs={{ "data-cancel": true }}
        acceptTip={{ title: "Start sketching", why: "Select a plane or a planar face first" }} cancelTip={{ title: "Cancel", shortcut: "Esc", hint: "Close and make no sketch." }}
        onKeyDown={(ev) => { if (ev.key === "Escape") { ev.stopPropagation(); studio.cancelFeature(); } }}>
        <PlaneField name={null} kind="" armed={listening} onArm={() => studio.setField("plane")} />
        <p className="m-0 text-sm text-ink-2 leading-snug" data-sketch-ask>Click a plane or a flat face in the model, or a plane in the feature list. The sketch tools come when it is chosen.</p>
        <Options studio={studio} />
      </DialogShell>
    );
  }
  if (!open || !feature) return null;
  const plane = feature.params.plane as unknown as PlaneRef | undefined;
  const where = !plane ? null : plane.kind === "plane" ? `${DEFAULT_PLANES[plane.plane]?.title || plane.plane} plane` : plane.kind === "datum" ? features.find((f) => f.id === plane.feature)?.name || "A missing plane" : "A face of the model";
  const s = standing(st);
  return (
    <DialogShell key={feature.id} className="cad-sketch-dialog" keepFold icon={icon} name={feature.name} attrs={{ "data-sketch": feature.id }}
      onAccept={() => studio.finishSketch()} onCancel={() => studio.cancelSketch()} acceptAttrs={{ "data-sketch-accept": true }} cancelAttrs={{ "data-sketch-cancel": true }}
      acceptTip={{ title: "Finish sketch", hint: "Keep the sketch and go back to the part." }} cancelTip={{ title: "Cancel sketch", hint: open.isNew ? "Leave, and take this new sketch away again." : "Leave, and put the sketch back as it was when you opened it." }}>
      <PlaneField name={picking && cleared ? null : where} kind={plane ? (plane.kind === "plane" ? plane.plane : plane.kind) : ""} armed={picking}
        onArm={() => studio.pickSketchPlane(!picking)} onClear={() => studio.pickSketchPlane(true, true)} />
      <Options studio={studio} />
      <div className="flex items-center gap-2 pt-2 border-t border-line text-sm" data-sketch-standing={s.tone} {...tipHandlers({ title: "The colours of the sketch", hint: "Teal: still free to move. Ink: settled by its dimensions and constraints. Red: constraints that cannot all hold." })}>
        <span className={cx("font-semibold whitespace-nowrap", TONE[s.tone])}>{s.text}</span>{s.detail ? <span className="text-ink-2 truncate">{s.detail}</span> : null}
        <span className="flex-1" />
        <span className="flex items-center gap-1 text-ink-3" aria-hidden="true"><span className="w-2 h-2 rounded-full bg-teal" /><span className="w-2 h-2 rounded-full bg-ink" /><span className="w-2 h-2 rounded-full bg-err" /></span>
      </div>
    </DialogShell>
  );
}
