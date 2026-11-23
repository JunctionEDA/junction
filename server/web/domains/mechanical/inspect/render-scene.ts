// render-scene.ts — the part studio as Render mode sees it (shared/render/mode.ts): the parts that are shown, as
// triangles with what each is made of.
//
// A part is rendered in the look the document gives it (document/appearance-items.ts): its colour, metalness and
// roughness, and the finish of its library appearance (document/materials-library.ts `finishOf`); a face with a
// colour of its own keeps it.  A part nobody dressed is the matt plastic of the colour the viewport draws it in.
// Hidden parts are left out; the ways of looking that are not the model (a section cut, "make transparent",
// wireframe) do not apply to a photograph.
//
// The triangles are the viewport's at first, so the picture starts at once, and the kernel is asked for finer ones
// (services/render-mesh.ts), which replace them when they arrive: round things are then round in outline too.
import type { RenderMesh, RenderScene } from "../../../shared/render/api";
import { physicalSurface, type PhysicalSurface, type SurfaceLook } from "../../../shared/render/materials";
import { renderModeOf, type RenderMode, type RenderSource } from "../../../shared/render/mode";
import { toolsChanged } from "../core/tool";
import { appearanceOf, surfaceLookOf } from "../document/materials-library";
import type { PartStudio } from "../ui/studio";
import { displayOf } from "./appearance-display";

interface Triangles { positions: Float32Array; normals: Float32Array; indices: Uint32Array; faces: { names: string[]; start: ArrayLike<number>; count: ArrayLike<number> } }
interface Fine extends Triangles { rev: number }

/** The runs of a mesh's index array and what each is made of: the part's surface, but for faces with a colour of their own. */
export function surfaceGroups(mesh: Triangles, base: SurfaceLook, faceColors: { [faceName: string]: string } | undefined): RenderMesh["groups"] {
  const whole = physicalSurface(base), total = mesh.indices.length;
  if (!faceColors || !Object.keys(faceColors).length) return [{ start: 0, count: total, surface: whole }];
  const made = new Map<string, PhysicalSurface>();
  const runs: { start: number; count: number; surface: PhysicalSurface }[] = [];
  mesh.faces.names.forEach((name, i) => {
    const c = faceColors[name];
    if (!c || !mesh.faces.count[i]) return;
    if (!made.has(c)) made.set(c, physicalSurface({ ...base, color: c }));
    runs.push({ start: mesh.faces.start[i], count: mesh.faces.count[i], surface: made.get(c)! });
  });
  runs.sort((a, b) => a.start - b.start);
  // everything between the coloured faces is the part's own surface; neighbours of one surface are one run
  const out: RenderMesh["groups"] = [];
  const put = (start: number, count: number, surface: PhysicalSurface): void => {
    if (count <= 0) return;
    const last = out[out.length - 1];
    if (last && last.surface === surface && last.start + last.count === start) last.count += count; else out.push({ start, count, surface });
  };
  let at = 0;
  for (const r of runs) { if (r.start < at) continue; put(at, r.start - at, whole); put(r.start, r.count, r.surface); at = r.start + r.count; }
  put(at, total - at, whole);
  return out;
}

class StudioSource implements RenderSource {
  private fine = new Map<string, Fine>();
  private asked = new Map<string, number>();
  private changed: (() => void) | null = null;

  constructor(private readonly studio: PartStudio) {}

  subscribe(changed: () => void): () => void {
    this.changed = changed;
    const display = displayOf(this.studio), bodies = this.studio.view.onBodies;
    // the display dresses the bodies again after every regeneration, a change of look, of what is hidden, of theme
    const fn = (): void => changed();
    display.onApplied.push(fn); bodies.push(fn);
    return () => {
      this.changed = null;
      for (const list of [display.onApplied, bodies]) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
    };
  }

  scene(): RenderScene {
    const studio = this.studio, display = displayOf(studio), meshes: RenderMesh[] = [], missing: string[] = [];
    for (const b of studio.getState().bodies) {
      if (!display.isVisible(b.id)) continue;
      const o = studio.view.bodyObjects(b.id);
      const coarse = b.mesh || o?.result.mesh;
      if (!coarse || !coarse.indices.length) continue;
      const fine = this.fine.get(b.id);
      const mesh: Triangles = fine && fine.rev === b.rev ? fine : coarse;
      if (mesh === coarse && this.asked.get(b.id) !== b.rev) missing.push(b.id);
      const look = display.lookOf(b.id);
      // a board is drawn by its own picture in the viewport; a photograph shows it as the laminate it is
      const board = b.reference && !look.color ? appearanceOf("fr4-green") : undefined;
      const base: SurfaceLook = board ? { color: board.color, metalness: board.metalness, roughness: board.roughness, finish: board.finish } : surfaceLookOf(look, display.hexOf(b.id));
      meshes.push({ positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, groups: surfaceGroups(mesh, base, look.faces) });
    }
    for (const id of Array.from(this.fine.keys())) if (!studio.getState().bodies.some((b) => b.id === id)) { this.fine.delete(id); this.asked.delete(id); }
    if (missing.length) this.refine(missing);
    return { meshes };
  }

  /** Ask the kernel for finer triangles of these bodies; the scene changes when they are here. */
  private refine(ids: string[]): void {
    const studio = this.studio;
    if (studio.getState().kernel.state !== "ready" && studio.getState().kernel.state !== "working") return;
    const revs = new Map(studio.getState().bodies.map((b) => [b.id, b.rev]));
    for (const id of ids) this.asked.set(id, revs.get(id) ?? -1);
    void studio.kernel.call("render-mesh", { bodies: ids }).then((r) => {
      const got = (r as unknown as { bodies?: (Fine & { id: string })[] }).bodies || [];
      let any = false;
      for (const m of got) {
        if (!(m.positions instanceof Float32Array) || !(m.indices instanceof Uint32Array) || !m.indices.length) continue;
        this.fine.set(m.id, m); any = true;
      }
      if (any && this.changed) this.changed();
    }).catch(() => { /* the viewport's triangles stay: coarser, never wrong */ });
  }

  toast(text: string, ms?: number): void { this.studio.host.toast(text, ms); }
  name(): string { return (this.studio.host.doc.path.split("/").pop() || "render").replace(/\.[^.]+$/, ""); }
  projectionChanged(): void { displayOf(this.studio).syncProjection(); }
}

const made = new WeakMap<PartStudio, RenderMode>();
/** The part studio's Render mode. */
export function renderOf(studio: PartStudio): RenderMode {
  let m = made.get(studio);
  if (!m) {
    const mode = (m = renderModeOf(studio.viewport, () => new StudioSource(studio)));
    made.set(studio, mode);
    // the toolbar's button is pressed while it is on
    let on = false;
    mode.subscribe(() => { if (mode.getState().on !== on) { on = mode.getState().on; toolsChanged(); } });
  }
  return m;
}
