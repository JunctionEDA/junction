// The Appearance library panel: ready-made looks — metals, plastics, rubber, wood, glass — to put on a part.
// Drag a swatch onto a part in the model and the whole part takes it; hold Shift while dropping and only the
// face under the pointer does; or select parts or faces and click a swatch.  One undoable edit, seen by
// everybody.  What is stored is the colour and the renderer's two numbers (document/materials-library.ts); the
// Appearance panel beside this one still mixes a colour by hand.
import { useState } from "react";
import { definePanel } from "../core/tool";
import { cx } from "../../../shared/util";
import { APPEARANCE_GROUPS, appearanceOf, appearanceOfBody, applyAppearance, findAppearances, type Appearance, type AppearanceTarget } from "../document/materials-library";
import { useStudio } from "../ui/hooks";
import { usePanelOpen } from "../ui/panels";
import { studioExtensions, type PartStudio } from "../ui/studio";
import { tipHandlers } from "../ui/Tip";

const MIME = "application/x-junction-appearance";

/** Put an appearance on targets; says so, or why not. */
export function putAppearance(studio: PartStudio, targets: AppearanceTarget[], id: string): boolean {
  const doc = studio.doc, ap = appearanceOf(id);
  if (!doc || !ap) return false;
  if (!studio.getState().canEdit) { studio.host.toast("You can look at this part studio but not change it.", 3000); return false; }
  if (!targets.length) { studio.host.toast("Drop it on a part, or select parts or faces first.", 3000); return false; }
  const changes = applyAppearance(doc, targets, id);
  if (!changes.length) return false;
  studio.commit(changes);
  const bodies = new Set(targets.filter((t) => t.kind === "body").map((t) => t.body)).size, faces = targets.length - targets.filter((t) => t.kind === "body").length;
  studio.host.toast(`${ap.name} on ${bodies ? `${bodies} part${bodies === 1 ? "" : "s"}` : `${faces} face${faces === 1 ? "" : "s"}`}`, 1800);
  return true;
}

/** What a click on a swatch dresses: whole parts when whole parts are selected (every face of them, as the parts list selects), else the selected faces. */
export function selectedTargets(studio: PartStudio): AppearanceTarget[] {
  const s = studio.getState(), faces = s.selection.filter((p) => p.kind === "face") as { kind: "face"; body: string; name: string }[];
  const out: AppearanceTarget[] = [];
  for (const body of Array.from(new Set(faces.map((f) => f.body)))) {
    const mine = faces.filter((f) => f.body === body), all = s.bodies.find((b) => b.id === body)?.mesh?.faces.names.length || 0;
    if (all && mine.length >= all) out.push({ kind: "body", body }); else out.push(...mine.map((f) => ({ kind: "face" as const, body, name: f.name })));
  }
  return out;
}

const ball = (a: Appearance): string => {
  // a sphere lit from the top left: a metal has a tight bright highlight and a dark rim, a rough plastic a soft one
  const hi = a.metalness > 0.5 ? 0.95 - a.roughness * 0.5 : 0.75 - a.roughness * 0.45, spread = 18 + a.roughness * 40, rim = a.metalness > 0.5 ? 0.55 : 0.28;
  return `radial-gradient(circle at 32% 28%, rgba(255,255,255,${hi.toFixed(2)}) 0%, rgba(255,255,255,0) ${spread.toFixed(0)}%), radial-gradient(circle at 50% 50%, ${a.color} 55%, rgba(0,0,0,${rim}) 130%), ${a.color}`;
};

function Library({ studio }: { studio: PartStudio }) {
  const open = usePanelOpen(studio, "appearance-library");
  const canEdit = useStudio(studio, (s) => s.canEdit);
  const selection = useStudio(studio, (s) => s.selection);
  useStudio(studio, (s) => s.bodies); useStudio(studio, (s) => s.ui?.appearanceTick);
  const [q, setQ] = useState("");
  if (!open) return null;
  const found = findAppearances(q), targets = selectedTargets(studio);
  const one = targets.length === 1 && targets[0].kind === "body" ? appearanceOfBody(studio.doc, targets[0].body) : undefined;
  return (
    <div className="cad-appearance-library flex flex-col gap-1.5 p-2 text-sm" data-appearance-count={found.length}>
      <input type="text" className="input h-6 text-xs w-full" placeholder="Find an appearance…" aria-label="Find an appearance" value={q} data-appearance-search onChange={(ev) => setQ(ev.target.value)} />
      {APPEARANCE_GROUPS.map((g) => {
        const items = found.filter((x) => x.group === g);
        if (!items.length) return null;
        return (
          <section key={g} aria-label={g}>
            <h4 className="m-0 mb-1 text-2xs uppercase tracking-wide text-ink-3 mono font-normal">{g}</h4>
            <div className="grid grid-cols-6 gap-1.5">
              {items.map((x) => (
                <button key={x.id} type="button" draggable={canEdit} className={cx("appearance-none m-0 p-0 w-7 h-7 rounded-full border cursor-grab active:cursor-grabbing", one?.id === x.id ? "border-[var(--mark)] outline outline-2 outline-[var(--mark)]" : "border-line-2 hover:border-ink")} style={{ background: ball(x), opacity: x.opacity !== undefined ? 0.55 + x.opacity * 0.45 : 1 }} aria-label={x.name} aria-pressed={one?.id === x.id} data-appearance={x.id}
                  {...tipHandlers({ title: x.name, hint: `${x.metalness > 0.5 ? "Metal" : "Not a metal"}, roughness ${x.roughness}${x.opacity !== undefined ? ", see-through" : ""}. Drag it onto a part (Shift: onto one face), or click to put it on what is selected.` })}
                  onDragStart={(ev) => { ev.dataTransfer.setData(MIME, x.id); ev.dataTransfer.setData("text/plain", x.name); ev.dataTransfer.effectAllowed = "copy"; }}
                  onClick={() => { if (putAppearance(studio, targets, x.id)) studio.setUi({ appearanceTick: Date.now() }); }} />
              ))}
            </div>
          </section>
        );
      })}
      {!found.length ? <p className="note m-0">Nothing is called that.</p> : null}
      <p className="note m-0 text-xs" data-appearance-hint>{selection.length && targets.length ? `Click one to put it on ${targets.every((t) => t.kind === "body") ? (targets.length === 1 ? "the selected part" : `the ${targets.length} selected parts`) : "the selected faces"}.` : "Drag one onto a part. Hold Shift to dress one face only."}</p>
    </div>
  );
}

// the model takes a dropped swatch: the part under the pointer, or with Shift its face
studioExtensions.push((studio) => {
  const canvas = studio.viewport.canvas;
  const has = (ev: DragEvent) => !!ev.dataTransfer && Array.from(ev.dataTransfer.types).includes(MIME);
  const over = (ev: DragEvent) => {
    if (!has(ev)) return;
    ev.preventDefault(); ev.dataTransfer!.dropEffect = "copy";
    const p = studio.view.pick(ev);
    studio.view.setFeatureHover(p && "body" in p ? (ev.shiftKey && p.kind === "face" ? [p] : faceTargets(studio, p.body)) : null);
  };
  const leave = () => studio.view.setFeatureHover(null);
  const drop = (ev: DragEvent) => {
    if (!has(ev)) return;
    ev.preventDefault();
    studio.view.setFeatureHover(null);
    const id = ev.dataTransfer!.getData(MIME), p = studio.view.pick(ev);
    if (!p || !("body" in p)) { studio.host.toast("Drop it on a part.", 2500); return; }
    if (putAppearance(studio, ev.shiftKey && p.kind === "face" ? [{ kind: "face", body: p.body, name: p.name }] : [{ kind: "body", body: p.body }], id)) studio.setUi({ appearanceTick: Date.now() });
  };
  canvas.addEventListener("dragover", over); canvas.addEventListener("dragleave", leave); canvas.addEventListener("drop", drop);
  return () => { canvas.removeEventListener("dragover", over); canvas.removeEventListener("dragleave", leave); canvas.removeEventListener("drop", drop); };
});
/** every face of a part, as picks: what lights up while a swatch is held over it */
function faceTargets(studio: PartStudio, body: string) {
  const b = studio.getState().bodies.find((x) => x.id === body);
  return (b?.mesh?.faces.names || []).map((name) => ({ kind: "face" as const, body, name, point: [0, 0, 0] as [number, number, number] }));
}

export default definePanel({ id: "appearance-library", title: "Appearance library", side: "right", order: 31, open: false, render: (studio) => <Library studio={studio} /> });
