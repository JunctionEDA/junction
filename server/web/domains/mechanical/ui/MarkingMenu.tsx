// MarkingMenu.tsx — the ring of eight tools a right click opens round the pointer (ui/marking.ts says which
// tools and where), above the ordinary menu for what is under the pointer (Overlays.tsx ContextMenu, which reads
// the same `ui.menu` and moves down to make room).  Move towards a tool and click, or click its label.  With
// "Flick gestures" on, a short quick drag with the right button runs the tool in that direction at once.
//
// Both are a person's preference (ui/prefs.ts `markingMenu`, `flick`), changed from the menu itself.
import { useEffect, useState } from "react";
import { cx } from "../../../shared/util";
import { sketchEditor } from "../sketch/editor";
import type { Pick } from "../viewport/modelview";
import { allCommands, modeOf, type Entry } from "./commands";
import { Glyph } from "./Glyph";
import { useStudio } from "./hooks";
import { ACCEPT, CANCEL, DIRECTIONS, FINISH, NEXT_FIELD, REPEAT, flickWedge, markingPlace, markingSlots, wedgeAt, wedgePlace } from "./marking";
import { getPrefs, usePref } from "./prefs";
import { featureDef, studioExtensions, type PartStudio } from "./studio";

const CHECK = '<path d="M5 12.5l4.5 4.5L19 7.5"/>', CROSS = '<path d="M6 6l12 12M18 6L6 18"/>', AGAIN = '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>', NEXT = '<path d="M5 12h13M13 6l6 6-6 6"/>';

/** what each studio started last: "again" is up */
const last = new WeakMap<PartStudio, string>();

/** The eight entries for the studio as it stands (null: an empty direction). */
export function markingEntries(studio: PartStudio, pick: Pick | null): (Entry | null)[] {
  const s = studio.getState(), mode = modeOf(studio);
  const all = allCommands(studio), byId = (id: string) => all.find((e) => e.id === id) || null;
  const own = (id: string, title: string, icon: string, run: () => void, why: string | null = null): Entry => ({ id, title, icon, why, run });
  return markingSlots(mode, { edge: !!pick && pick.kind === "edge" && s.selection.length > 1 }).map((slot) => {
    if (!slot) return null;
    if (slot === REPEAT) { const e = byId(last.get(studio) || ""); return e ? { ...e, id: REPEAT, title: `Again: ${e.title}`, icon: e.icon || AGAIN } : own(REPEAT, "Again", AGAIN, () => undefined, "Nothing to do again yet"); }
    if (slot === ACCEPT) return own(ACCEPT, "Accept", CHECK, () => studio.acceptFeature());
    if (slot === CANCEL) return own(CANCEL, "Cancel", CROSS, () => studio.cancelFeature());
    if (slot === FINISH) return own(FINISH, "Finish sketch", CHECK, () => studio.finishSketch(), s.sketch ? null : "Choose the sketch's plane first");
    if (slot === NEXT_FIELD) return own(NEXT_FIELD, "Next field", NEXT, () => studio.viewport.canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    return byId(slot);
  });
}

interface MenuAt { x: number; y: number; pick: Pick | null }

export function MarkingMenu({ studio }: { studio: PartStudio }) {
  const at = useStudio(studio, (s) => (s.ui?.menu as MenuAt | undefined) || null);
  const on = usePref("markingMenu");
  const [hot, setHot] = useState(-1);
  const shown = !!at && on;
  const place = at ? markingPlace(at.x, at.y, window.innerWidth, window.innerHeight, 0) : null;
  useEffect(() => {
    if (!shown || !place) return;
    setHot(-1);
    const move = (ev: PointerEvent) => setHot(wedgeAt(ev.clientX - place.cx, ev.clientY - place.cy));
    document.addEventListener("pointermove", move);
    return () => document.removeEventListener("pointermove", move);
  }, [shown, place?.cx, place?.cy]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!shown || !at || !place) return null;
  const entries = markingEntries(studio, at.pick);
  const run = (e: Entry | null) => { if (!e || e.why) return; studio.setUi({ menu: null }); e.run(); studio.viewport.canvas.focus(); };
  return (
    <div className="cad-marking fixed z-[56] w-0 h-0" style={{ left: place.cx, top: place.cy }} role="menu" aria-label="Marking menu" data-marking data-hot={hot >= 0 ? DIRECTIONS[hot] : undefined} onContextMenu={(ev) => ev.preventDefault()}>
      {/* the ring itself: a click in a direction is a click on that direction's tool */}
      <div className="absolute rounded-full border border-line bg-panel/60 shadow-panel" style={{ left: -34, top: -34, width: 68, height: 68 }} data-marking-ring
        onPointerDown={(ev) => { const i = wedgeAt(ev.clientX - place.cx, ev.clientY - place.cy); if (i >= 0 && entries[i] && !entries[i]!.why) { ev.stopPropagation(); run(entries[i]); } }}>
        {hot >= 0 && entries[hot] ? <span className="absolute left-1/2 top-1/2 w-0.5 h-8 -ml-px origin-top bg-[var(--mark)] rounded" style={{ transform: `rotate(${hot * 45 + 180}deg)` }} aria-hidden="true" /> : null}
        <span className="absolute left-1/2 top-1/2 w-1.5 h-1.5 -ml-[3px] -mt-[3px] rounded-full bg-ink-2" aria-hidden="true" />
      </div>
      {entries.map((e, i) => {
        if (!e) return null;
        const p = wedgePlace(i);
        // a label hangs from the side of it that faces the middle
        const anchor = p.x > 8 ? "translate(0,-50%)" : p.x < -8 ? "translate(-100%,-50%)" : "translate(-50%,-50%)";
        return (
          <button key={DIRECTIONS[i]} type="button" role="menuitem" aria-disabled={e.why ? true : undefined} title={e.why || e.hint} data-marking-item={DIRECTIONS[i]} data-marking-id={e.id} data-marking-title={e.title}
            className={cx("appearance-none m-0 [font-family:inherit] absolute flex items-center gap-1.5 h-8 px-2.5 whitespace-nowrap rounded-md border text-base text-ink shadow-panel cursor-pointer", hot === i && !e.why ? "border-[var(--mark)] bg-sel font-medium" : "border-line bg-panel hover:bg-sel-soft", e.why && "opacity-45")}
            style={{ left: p.x, top: p.y, transform: anchor }} onPointerDown={(ev) => ev.stopPropagation()} onClick={() => run(e)}>
            <Glyph svg={e.icon} size={18} /><span>{e.title}</span>{e.shortcut ? <span className="kbd ml-1">{e.shortcut}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

// What was started last, for "Again"; and the flick.
studioExtensions.push((studio) => {
  let editing = "", tool = "select";
  const unsubscribe = studio.subscribe(() => {
    const s = studio.getState();
    const e = s.editing && s.editing.isNew ? s.editing.draft.featureType : "";
    if (e && e !== editing && featureDef(e)) last.set(studio, "f:" + e);
    editing = e;
    const t = s.sketch ? s.sketch.tool : "select";
    if (t !== tool && t !== "select") last.set(studio, t);
    tool = t;
  });
  // a flick: the right button down, a short quick straight drag, up.  The view turned a little meanwhile (a
  // right drag turns it): it is put back.
  const canvas = studio.viewport.canvas;
  let from: { x: number; y: number; t: number; travelled: number; px: number; py: number; camera: ReturnType<typeof studio.viewport.cameraState> } | null = null;
  const down = (ev: PointerEvent) => { from = ev.button === 2 && getPrefs().flick && !ev.shiftKey && !ev.ctrlKey ? { x: ev.clientX, y: ev.clientY, px: ev.clientX, py: ev.clientY, t: ev.timeStamp, travelled: 0, camera: studio.viewport.cameraState() } : null; };
  const move = (ev: PointerEvent) => { if (from) { from.travelled += Math.hypot(ev.clientX - from.px, ev.clientY - from.py); from.px = ev.clientX; from.py = ev.clientY; } };
  const up = (ev: PointerEvent) => {
    const f = from; from = null;
    if (!f || ev.button !== 2) return;
    // by the events' own times, not by when the page got round to them: a page busy drawing does not turn a flick into a drag
    const i = flickWedge(ev.clientX - f.x, ev.clientY - f.y, ev.timeStamp - f.t, f.travelled || undefined);
    if (i < 0) return;
    if (studio.getState().sketch && sketchEditor(studio).getState().tool !== "select") return;   // a right click there puts the tool down
    const e = markingEntries(studio, null)[i];
    studio.viewport.setCameraState(f.camera, false);   // at once: nothing glides back from a turn nobody meant
    if (!e) return;
    if (e.why) { studio.host.toast(`${e.title}: ${e.why}`, 2000); return; }
    studio.setUi({ flicked: { id: e.id, title: e.title, direction: DIRECTIONS[i], n: ((studio.getState().ui?.flicked as { n?: number } | undefined)?.n || 0) + 1 } });
    studio.host.toast(e.title, 900);
    e.run();
  };
  canvas.addEventListener("pointerdown", down, true);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  return () => { unsubscribe(); canvas.removeEventListener("pointerdown", down, true); window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", up, true); };
});
