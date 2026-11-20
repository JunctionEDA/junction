// cells.ts — direct editing without a defeaturing kernel: space is cut into cells by a body's faces and by
// surfaces carried past their trimmed edges, and the cells say what a face edit adds and removes.
//
// The kernel build has no defeaturing and no per-face offset.  What it has is a general splitter.  Take a box
// round the body and split it by the body, by the faces next to the ones being edited made as large as their
// surface allows (a plane everywhere, a cylinder all round and along), and by any new surface.  Every cell of
// the result is wholly inside or wholly outside the body, and is bounded by pieces of known faces.  Then:
//
//   delete faces (heal)   a cell bounded only by the deleted faces and the neighbours' extensions is the gap the
//                         neighbours close: outside the body it is filled (a hole, a round on an outer edge),
//                         inside it is removed (a boss, a round in an inner corner).
//   move a face           the same, with the face's new surface as one more wall: the cells between the face
//                         and its new place are added on the material side and removed on the other.
//
// Names (CONTRACT.md "Geometry names"): the body's faces keep theirs; a neighbour that grew keeps its name (the
// new piece merges into it); the moved face keeps its name on its new surface.
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "../../core/geometry";
import { ShapeIndex, type NamedResult } from "../occ";
import type { EvalContext, NamedShape, Shape } from "../types";
import { bbox, planeFace, solidCentre } from "./shapes";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** A surface with a material side: what a moved or replaced face lies on afterwards. */
/** `signed` is below zero on the material side of the surface, zero on it. */
export interface Wall { face: Shape; signed(p: Vec3): number }

export interface Cell { shape: Shape; tags: Set<string>[]; faces: Shape[] }

/** The faces of `faces` that share an edge with one of `picked` and are not picked themselves. */
export function neighbours(ctx: EvalContext, faces: readonly NamedShape[], picked: readonly Shape[]): NamedShape[] {
  const k = ctx.k;
  const edges = new ShapeIndex<true>(k);
  for (const f of picked) for (const e of k.sub(f, "edge")) edges.add(e, true);
  return faces.filter((f) => !picked.some((p) => p.IsSame(f.shape)) && k.sub(f.shape, "edge").some((e) => edges.has(e)));
}

/** What a face lies on, for the kinds that can be carried past its edges exactly. */
export function surfaceOf(ctx: EvalContext, face: Shape): { kind: "plane"; origin: Vec3; normal: Vec3 } | { kind: "cylinder"; origin: Vec3; dir: Vec3; radius: number; outward: boolean } | { kind: "other" } {
  const oc = ctx.oc as Any, k = ctx.k;
  const frame = k.faceFrame(oc.TopoDS.Face(face));
  if (frame) return { kind: "plane", origin: k.centre(face, "face"), normal: frame.normal };
  const ad = ctx.tmp(new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true));
  if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) return { kind: "other" };
  const cyl = ad.Cylinder(), ax = cyl.Axis(), loc = ax.Location(), d = ax.Direction();
  const origin = k.xyz(loc), dir = k.xyz(d), radius = cyl.Radius();
  d.delete(); loc.delete(); ax.delete(); cyl.delete();
  // which way the solid's own normal points at the middle of the face: away from the axis (a boss) or to it (a hole)
  const n = normalAt(ctx, face), c = pointOn(ctx, face);
  const radial = sub(sub(c, origin), scale(dir, dot(sub(c, origin), dir)));
  return { kind: "cylinder", origin, dir, radius, outward: dot(n, radial) > 0 };
}

const mid = (ctx: EvalContext, face: Shape): [number, number] => {
  const b = (ctx.oc as Any).BRepTools.UVBounds(ctx.oc.TopoDS.Face(face), 0, 0, 0, 0);
  return [(b.UMin + b.UMax) / 2, (b.VMin + b.VMax) / 2];
};

/** A point of a face (the middle of its parameter range). */
export function pointOn(ctx: EvalContext, face: Shape): Vec3 {
  const oc = ctx.oc as Any;
  const ad = ctx.tmp(new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true));
  const [u, v] = mid(ctx, face);
  const p = ad.Value(u, v); const out = ctx.k.xyz(p); p.delete();
  return out;
}

/** The normal of a face at the middle of its parameter range, pointing out of the solid it belongs to. */
export function normalAt(ctx: EvalContext, face: Shape, uv?: [number, number]): Vec3 {
  const oc = ctx.oc as Any, k = ctx.k;
  const ad = ctx.tmp(new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true));
  const [u, v] = uv || mid(ctx, face);
  const p = ctx.tmp(new oc.gp_Pnt(0, 0, 0)), du = ctx.tmp(new oc.gp_Vec(0, 0, 0)), dv = ctx.tmp(new oc.gp_Vec(0, 0, 0));
  ad.D1(u, v, p, du, dv);
  let n = cross(k.xyz(du), k.xyz(dv));
  if (length(n) < 1e-12) return [0, 0, 1];
  n = normalize(n);
  return face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED ? scale(n, -1) : n;
}

/** A face on the same surface as `face`, carried as far past its edges as the surface goes (at least `reach`). */
export function extended(ctx: EvalContext, face: Shape, centre: Vec3, reach: number): Shape {
  const oc = ctx.oc as Any, k = ctx.k;
  const s = surfaceOf(ctx, face);
  if (s.kind === "plane") {
    const o = sub(centre, scale(s.normal, dot(sub(centre, s.origin), s.normal)));
    return planeFace(k, o, s.normal, reach, ctx.own);
  }
  if (s.kind === "cylinder") return cylinderFace(ctx, s.origin, s.dir, s.radius, centre, reach);
  // any other surface: as far as the kernel can stretch it, or as it is
  try {
    const out = ctx.own(new oc.TopoDS_Face());
    oc.BRepLib.ExtendFace(oc.TopoDS.Face(face), reach, true, true, true, true, out);
    if (!out.IsNull()) return out;
  } catch (e) { /* the face as it is */ }
  return face;
}

/** A whole cylinder as a face, long enough to pass `reach` either side of `centre`. */
export function cylinderFace(ctx: EvalContext, origin: Vec3, dir: Vec3, radius: number, centre: Vec3, reach: number): Shape {
  const oc = ctx.oc as Any, k = ctx.k;
  const d = normalize(dir), at = add(origin, scale(d, dot(sub(centre, origin), d)));
  const ax3 = ctx.tmp(new oc.gp_Ax3(ctx.tmp(k.pnt(at)), ctx.tmp(k.dir(d))));
  const cyl = ctx.tmp(new oc.gp_Cylinder(ax3, radius));
  const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(cyl, 0, 2 * Math.PI, -reach, reach));
  if (!mk.IsDone()) throw ctx.fail("A cylinder could not be extended.");
  return ctx.own(mk.Face());
}

/** Something that cuts the box into cells: its faces, and what to call each of them. */
export interface Source { shape: Shape; tag: (face: Shape) => string }

/** Split a box by the sources; every cell with what each of its faces came from ("box": the box itself). */
export function splitBox(ctx: EvalContext, box: Shape, sources: readonly Source[]): Cell[] {
  const oc = ctx.oc as Any, k = ctx.k;
  const mk = ctx.own(new oc.BRepAlgoAPI_Splitter());
  const args = ctx.tmp(new oc.NCollection_List_TopoDS_Shape()); args.Append(box);
  const tools = ctx.tmp(new oc.NCollection_List_TopoDS_Shape());
  for (const s of sources) tools.Append(s.shape);
  mk.SetArguments(args); mk.SetTools(tools);
  try { mk.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (e) { throw ctx.fail(`The faces could not be worked out (${k.describe(e)}).`); }
  if (!mk.IsDone() || mk.HasErrors()) throw ctx.fail("The faces could not be extended to meet.");
  const result: Shape = ctx.own(mk.Shape());
  const from = new ShapeIndex<Set<string>>(k);
  const mark = (src: Shape, tag: string) => {
    const images = k.list(mk.Modified(src));
    for (const im of images.length ? images : mk.IsDeleted(src) ? [] : [src]) { const have = from.get(im); if (have) have.add(tag); else from.add(im, new Set([tag])); }
  };
  for (const s of sources) for (const f of k.sub(s.shape, "face")) mark(f, s.tag(f));
  for (const f of k.sub(box, "face")) mark(f, "box");
  return k.sub(result, "solid").map((shape) => { const faces = k.sub(shape, "face"); return { shape, faces, tags: faces.map((f) => from.get(f) || new Set<string>(["?"])) }; });
}

function split(ctx: EvalContext, body: Shape, bodyTag: (face: Shape) => string, walls: readonly { tag: string; face: Shape }[], box: Shape): Cell[] {
  return splitBox(ctx, box, [{ shape: body, tag: bodyTag }, ...walls.map((w) => ({ shape: w.face, tag: () => w.tag }))]);
}

export function boxAround(ctx: EvalContext, shapes: readonly Shape[]): { box: Shape; centre: Vec3; reach: number } {
  const oc = ctx.oc as Any, k = ctx.k;
  const b = bbox(k, shapes);
  if (!b) throw ctx.fail("There is nothing to edit.");
  const diag = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]), m = diag * 0.5 + 5;
  const mk = ctx.tmp(new oc.BRepPrimAPI_MakeBox(ctx.tmp(new oc.gp_Pnt(b[0] - m, b[1] - m, b[2] - m)), ctx.tmp(new oc.gp_Pnt(b[3] + m, b[4] + m, b[5] + m))));
  return { box: ctx.own(mk.Shape()), centre: [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2], reach: diag * 3 + 50 };
}

/** Whether a cell is inside the body (every cell is wholly in or wholly out). */
function inside(ctx: EvalContext, cell: Shape, body: Shape): boolean {
  const oc = ctx.oc as Any, k = ctx.k;
  const range = ctx.tmp(new oc.Message_ProgressRange());
  const algo = ctx.tmp(new oc.BRepAlgoAPI_Common(cell, body, range));
  algo.Build(range);
  if (!algo.IsDone()) return false;
  const s = ctx.tmp(algo.Shape());
  return k.solids(s).length > 0 && k.volume(s) > 0.5 * k.volume(cell);
}

const only = (c: Cell, ok: (t: string) => boolean) => c.tags.every((ts) => !ts.has("box") && Array.from(ts).some(ok));
const has = (c: Cell, tag: string) => c.tags.some((ts) => ts.has(tag));

/**
 * Which side of a wall a cell is on: the wall's signed distance at the point of the cell farthest from it (a
 * cell's centre of mass will not do: a ring's is in its hole).
 */
function probe(ctx: EvalContext, c: Cell, wall: Wall): number {
  const oc = ctx.oc as Any, k = ctx.k;
  let best = 0;
  for (const e of k.sub(c.shape, "edge")) {
    const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e)));
    const p = ad.Value((ad.FirstParameter() + ad.LastParameter()) / 2); const s = wall.signed(k.xyz(p)); p.delete();
    if (Math.abs(s) > Math.abs(best)) best = s;
  }
  return Math.abs(best) > 1e-9 ? best : wall.signed(solidCentre(k, c.shape));
}

/** Apply cells to a body: `fill` are joined to it, `remove` cut from it; each cell face is named by `nameOf`. */
function apply(ctx: EvalContext, body: { shape: Shape; faces: readonly NamedShape[] }, fill: readonly Cell[], remove: readonly Cell[], nameOf: (tags: Set<string>) => string | null): NamedResult {
  const k = ctx.k, id = ctx.feature.id;
  let acc: { shape: Shape; faces: readonly NamedShape[] } = body;
  let names: NamedResult["names"] = (f) => body.faces.find((x) => x.shape.IsSame(f))?.name ?? null;
  const facesOf = (c: Cell): NamedShape[] => {
    const index = new ShapeIndex<string | null>(k);
    c.faces.forEach((f, i) => index.add(f, nameOf(c.tags[i])));
    return k.namedFaces(c.shape, (f) => index.get(f) ?? null, id);
  };
  for (const [op, cells] of [["fuse", fill], ["cut", remove]] as const) for (const c of cells) {
    const r = k.boolean(op, acc, { shape: c.shape, faces: facesOf(c) }, id, ctx.own);
    const solids = k.solids(r.shape);
    if (solids.length !== 1) throw ctx.fail("The edit would leave the part in pieces or empty.");
    acc = { shape: solids[0], faces: k.namedFaces(solids[0], r.names, id) };
    names = r.names;
  }
  return { shape: acc.shape, names };
}

/**
 * Delete faces of a body and close the gap by carrying the faces around them on until they meet.  Fails with
 * a sentence when they do not close.
 */
export function healFaces(ctx: EvalContext, body: { shape: Shape; faces: readonly NamedShape[] }, picked: readonly Shape[]): NamedResult {
  const k = ctx.k;
  if (!picked.length) throw ctx.fail("Pick the faces to delete.");
  const next = neighbours(ctx, body.faces, picked);
  if (!next.length) throw ctx.fail("Those faces are the whole part: nothing would be left to close the gap.");
  const { box, centre, reach } = boxAround(ctx, [body.shape]);
  const walls = next.map((n) => ({ tag: `N:${n.name}`, face: extended(ctx, n.shape, centre, reach) }));
  const gone = new ShapeIndex<true>(k);
  for (const f of picked) gone.add(f, true);
  const cells = split(ctx, body.shape, (f) => (gone.has(f) ? "F" : "B"), walls, box);
  const gap = cells.filter((c) => has(c, "F") && only(c, (t) => t === "F" || t.startsWith("N:")));
  if (!gap.length) throw ctx.fail("The faces around the deleted ones do not meet when extended, so the gap cannot be closed.");
  const fill: Cell[] = [], remove: Cell[] = [];
  for (const c of gap) (inside(ctx, c.shape, body.shape) ? remove : fill).push(c);
  if (remove.length && remove.reduce((s, c) => s + k.volume(c.shape), 0) >= k.volume(body.shape) * (1 - 1e-9)) throw ctx.fail("Deleting those faces would remove the whole part.");
  return apply(ctx, body, fill, remove, (tags) => { for (const t of tags) if (t.startsWith("N:")) return t.slice(2); return null; });
}

/**
 * Put one face of a body on a new surface: the faces around it are carried on (or cut back) to meet the wall.
 * `name` is the face's name, which the new face keeps.  Returns null when nothing changes.
 */
export function moveToWall(ctx: EvalContext, body: { shape: Shape; faces: readonly NamedShape[] }, face: NamedShape, wall: Wall): NamedResult | null {
  const k = ctx.k;
  const next = neighbours(ctx, body.faces, [face.shape]);
  const { box, centre, reach } = boxAround(ctx, [body.shape, wall.face]);
  const walls = [{ tag: "S", face: wall.face }, ...next.map((n) => ({ tag: `N:${n.name}`, face: extended(ctx, n.shape, centre, reach) }))];
  const cells = split(ctx, body.shape, (f) => (f.IsSame(face.shape) ? "F" : "B"), walls, box);
  const bounded = cells.filter((c) => only(c, (t) => t === "F" || t === "S" || t.startsWith("N:")));
  const fill: Cell[] = [], remove: Cell[] = [];
  for (const c of bounded) {
    const material = probe(ctx, c, wall) < 0, isIn = inside(ctx, c.shape, body.shape);
    if (!isIn && material && has(c, "F")) fill.push(c);
    else if (isIn && !material && (has(c, "F") || has(c, "S"))) remove.push(c);
  }
  if (!fill.length && !remove.length) return null;
  if (remove.length && remove.reduce((s, c) => s + k.volume(c.shape), 0) >= k.volume(body.shape) * (1 - 1e-9)) throw ctx.fail("Moving the face that far would remove the whole part.");
  return apply(ctx, body, fill, remove, (tags) => { if (tags.has("S")) return face.name; for (const t of tags) if (t.startsWith("N:")) return t.slice(2); return null; });
}

/** A plane as a wall: material is behind it (against its normal). */
export function planeWall(ctx: EvalContext, origin: Vec3, normal: Vec3, around: readonly Shape[]): Wall {
  const b = bbox(ctx.k, around);
  const c: Vec3 = b ? [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2] : origin;
  const reach = (b ? Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) : 100) * 4 + 100 + length(sub(origin, c)) * 4;
  const n = normalize(normal), o = sub(c, scale(n, dot(sub(c, origin), n)));
  return { face: planeFace(ctx.k, o, n, reach, ctx.own), signed: (p) => dot(sub(p, origin), n) };
}

/** A cylinder as a wall: material inside it (`outward`, a boss) or outside it (a hole). */
export function cylinderWall(ctx: EvalContext, origin: Vec3, dir: Vec3, radius: number, outward: boolean, around: readonly Shape[]): Wall {
  const b = bbox(ctx.k, around);
  const c: Vec3 = b ? [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2] : origin;
  const reach = (b ? Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) : 100) * 4 + 100 + length(sub(origin, c)) * 4;
  const d = normalize(dir);
  return {
    face: cylinderFace(ctx, origin, d, radius, c, reach),
    signed: (p) => { const r = sub(p, origin); return (length(sub(r, scale(d, dot(r, d)))) - radius) * (outward ? 1 : -1); },
  };
}
