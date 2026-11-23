// render.ts — the assembly as Render mode sees it (shared/render/mode.ts): every instance that is shown, where
// it stands on screen (pulled apart, if the view is exploded), as triangles with what each part is made of.
//
// A part is rendered in the look its own part studio gives it (colour, metalness, roughness, the finish of its
// library appearance): the assembly reads that from the part studio's document, which it already keeps open.  A
// part nobody dressed is matt plastic of the colour the assembly draws it in; a board is its laminate; a part
// inside a sub-assembly is drawn in the assembly's colour for it (its part studio is not open here).
//
// The triangles are the viewport's at first; the part studios' kernels are then asked for finer ones (the
// mechanical domain's "render-mesh" service) and the picture is traced again when they arrive.  Instances of one
// part share its triangles on the way to the engine, as they do in the viewport.
//
// Two motions can be filmed besides a turntable: the parts coming apart (the exploded view's even spread), and
// one freedom of the assembly moved through its range (what the Animate panel plays).
import type { RenderMesh, RenderScene } from "../../../shared/render/api";
import { physicalSurface, type PhysicalSurface, type SurfaceLook } from "../../../shared/render/materials";
import { renderModeOf, type RenderMode, type RenderMotion, type RenderSource } from "../../../shared/render/mode";
import { appearanceOf, looksOf, surfaceLookOf, type BodyMesh } from "../../mechanical/api";
import type { Transform } from "../document/format";
import type { AssemblyEditor } from "../ui/assembly";

interface Fine { positions: Float32Array; normals: Float32Array; indices: Uint32Array; faces: { names: string[]; start: ArrayLike<number>; count: ArrayLike<number> } }

/** A row-major 3 × 4 as the 4 × 4, column-major, the engine takes. */
const matrixOf = (t: readonly number[]): number[] => [t[0], t[4], t[8], 0, t[1], t[5], t[9], 0, t[2], t[6], t[10], 0, t[3], t[7], t[11], 1];
/** a × b for row-major 3 × 4 transforms */
function multiply(a: readonly number[], b: readonly number[]): Transform {
  const out = new Array<number>(12);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
  return out as Transform;
}
const ease = (t: number): number => t * t * (3 - 2 * t);

/** The most part studios whose kernels are started only to mesh finer: beyond it the parts that are not being edited keep the viewport's triangles. */
const REFINE_STUDIOS = 12;

class AssemblySource implements RenderSource {
  private fine = new WeakMap<BodyMesh, Fine>();
  private asked = new WeakSet<BodyMesh>();
  private changed: (() => void) | null = null;

  constructor(private readonly a: AssemblyEditor) {}

  subscribe(changed: () => void): () => void {
    this.changed = changed;
    const list = this.a.scene.onChange, fn = (): void => changed();
    list.push(fn);
    return () => { this.changed = null; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  }

  scene(): RenderScene {
    const a = this.a, meshes: RenderMesh[] = [];
    const surfaces = new Map<string, PhysicalSurface>();
    const surface = (look: SurfaceLook): PhysicalSurface => { const k = JSON.stringify(look); let s = surfaces.get(k); if (!s) { s = physicalSurface(look); surfaces.set(k, s); } return s; };
    const board = appearanceOf("fr4-green");
    const want = new Map<string, { kind: string; docId: string; pieces: Map<string, BodyMesh> }>();
    for (const item of a.getState().instances) {
      if (item.suppressed || item.hidden || !item.source) continue;
      const placed = a.scene.transformOf(item.id);
      if (!placed) continue;
      const handle = a.sources.handle(item.source.kind, item.source.docId);
      const doc = item.source.kind === "part" && handle && handle.doc ? handle.doc() : null;
      const looks = doc ? looksOf(doc) : {};
      for (const piece of a.sources.piecesOf(item).pieces) {
        const coarse = piece.mesh;
        if (!coarse || !coarse.indices.length) continue;
        const fine = this.fine.get(coarse), mesh = fine || coarse;
        if (!fine && item.source.kind === "part" && !this.asked.has(coarse)) {
          const k = `${item.source.kind}|${item.source.docId}`;
          if (!want.has(k)) want.set(k, { kind: item.source.kind, docId: item.source.docId, pieces: new Map() });
          want.get(k)!.pieces.set(piece.id, coarse);
        }
        const look = looks[piece.id];
        const base: SurfaceLook = (piece.ghost || piece.reference) && !look?.color && board ? { color: board.color, metalness: board.metalness, roughness: board.roughness, finish: board.finish }
          : surfaceLookOf(look, a.scene.colorOf(coarse) || "#b9bdc2");
        const total = mesh.indices.length, groups: RenderMesh["groups"] = [];
        const colours = look?.faces;
        if (colours && Object.keys(colours).length) {
          // the faces with a colour of their own, in the order they lie in the index array; the rest is the part's surface
          const runs = mesh.faces.names.map((name, i) => ({ start: mesh.faces.start[i], count: mesh.faces.count[i], color: colours[name] })).filter((r) => r.color && r.count).sort((x, y) => x.start - y.start);
          let at = 0;
          for (const r of runs) { if (r.start < at) continue; if (r.start > at) groups.push({ start: at, count: r.start - at, surface: surface(base) }); groups.push({ start: r.start, count: r.count, surface: surface({ ...base, color: r.color! }) }); at = r.start + r.count; }
          if (at < total) groups.push({ start: at, count: total - at, surface: surface(base) });
        } else groups.push({ start: 0, count: total, surface: surface(base) });
        meshes.push({ positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, matrix: matrixOf(piece.transform ? multiply(placed, piece.transform) : placed), groups });
      }
    }
    if (want.size) void this.refine(Array.from(want.values()).slice(0, REFINE_STUDIOS));
    return { meshes };
  }

  /** Ask each part studio's kernel for finer triangles of the parts shown; the scene changes when they are here. */
  private async refine(studios: { kind: string; docId: string; pieces: Map<string, BodyMesh> }[]): Promise<void> {
    let any = false;
    for (const s of studios) {
      for (const m of s.pieces.values()) this.asked.add(m);
      try {
        const handle = this.a.sources.handle(s.kind, s.docId);
        const kernel = handle && handle.ensureKernel ? await handle.ensureKernel() : null;
        if (!kernel) continue;
        const r = (await kernel.call("render-mesh", { bodies: Array.from(s.pieces.keys()) })) as unknown as { bodies?: (Fine & { id: string })[] };
        for (const m of r.bodies || []) {
          const coarse = s.pieces.get(m.id);
          if (!coarse || !(m.positions instanceof Float32Array) || !(m.indices instanceof Uint32Array) || !m.indices.length) continue;
          this.fine.set(coarse, m); any = true;
        }
      } catch { /* the viewport's triangles stay: coarser, never wrong */ }
    }
    if (any && this.changed) this.changed();
  }

  motions(): RenderMotion[] {
    const a = this.a, s = a.getState(), out: RenderMotion[] = [];
    if (s.instances.filter((i) => !i.suppressed && !i.hidden).length > 1 && !s.mating) {
      const was = { exploding: s.exploding, explode: s.explode, view: s.explodeView };
      out.push({
        id: "explode", title: "Coming apart",
        pose: (t) => { if (!a.getState().exploding) a.setExploding(true); a.setExplode(0.9 * ease(t)); },
        restore: () => { if (was.view) a.openExplode(was.view); else { a.setExploding(was.exploding); if (was.exploding) a.setExplode(was.explode); } },
      });
    }
    if (!s.mating && !s.animating) {
      for (const d of a.drivable()) {
        // a full turn for a freedom that has no limits, its limits otherwise
        const from = d.limited || d.unit === "mm" ? d.min : d.value, to = d.limited || d.unit === "mm" ? d.max : d.value + 360, home = d.value;
        out.push({
          id: `mate-${d.mate.id}-${d.key}`, title: `${d.label} moving`,
          pose: (t) => { a.driveMate(d.mate.id, d.key, from + (to - from) * (d.limited || d.unit === "mm" ? ease(t) : t), { hold: true }); },
          restore: () => { a.driveMate(d.mate.id, d.key, home, { hold: true }); a.settle(false); },
        });
      }
    }
    return out;
  }

  toast(text: string, ms?: number): void { this.a.host.toast(text, ms); }
  name(): string { return (this.a.host.doc.path.split("/").pop() || "render").replace(/\.[^.]+$/, ""); }
}

const made = new WeakMap<AssemblyEditor, RenderMode>();
/** The assembly's Render mode. */
export function renderOf(a: AssemblyEditor): RenderMode {
  let m = made.get(a);
  if (!m) { m = renderModeOf(a.viewport, () => new AssemblySource(a)); made.set(a, m); }
  return m;
}
