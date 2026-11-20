// profile.ts — what a `profile` parameter is to the kernel: the closed regions a feature sweeps, from a sketch,
// from flat faces of the bodies already there, or from both (features/_profile.ts says what is stored).
//
// A face is a region like a sketch's: the kernel face itself (holes and all), its edges, and the frame of its
// plane, whose normal points out of the solid.  Where a sketch region has an id made from its curves and each
// edge has its sketch entity, a face has `faceRegionId(ref)` and each edge `faceEdgeId(<the edge's name>)`, so
// what a feature makes from a face is named the same way (`<id>:end:<region>`, `<id>:side:<entity>`) and the
// names stay what they were for as long as the face and its edges keep theirs.
import type { TopoDS_Edge, TopoDS_Face } from "replicad-opencascadejs";
import { toPlane, toWorld, type Frame, type GeomRef, type Vec3 } from "../../core/geometry";
import { faceEdgeId, faceRegionId, profileFaces, profileSketch } from "../../features/_profile";
import { ShapeIndex } from "../occ";
import type { Body, EvalContext, Shape, SketchGeometry, SketchRegion } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export interface ProfileRegion extends SketchRegion {
  /** the plane the region lies in: a sketch's frame, or a face's (normal out of the solid) */
  frame: Frame;
  /** the face of a body this region is, or null for a region of the sketch */
  from: { ref: GeomRef; body: Body } | null;
  /** points along the outer boundary, in the model: what tells which side of an axis the region lies on */
  outline: Vec3[];
}

export interface Profile {
  regions: ProfileRegion[];
  /** the sketch the profile names, when it names one */
  sketch: SketchGeometry | null;
  sketchId: string | null;
}

/** Points along an edge, ends included: the two ends of a straight edge, more of a curved one. */
function edgePoints(ctx: EvalContext, edge: Shape): Vec3[] {
  const oc = ctx.oc as Any, k = ctx.k;
  const ad = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
  try {
    const a = ad.FirstParameter(), b = ad.LastParameter();
    const n = ad.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line ? 1 : 12;
    const out: Vec3[] = [];
    for (let i = 0; i <= n; i++) { const p = ad.Value(a + ((b - a) * i) / n); out.push(k.xyz(p)); p.delete(); }
    return out;
  } finally { ad.delete(); }
}

/** A face of a body as a region, or a FeatureError that says what is wrong with it. */
export function faceRegion(ctx: EvalContext, ref: GeomRef, verb: string): ProfileRegion {
  const oc = ctx.oc as Any, k = ctx.k;
  const r = ctx.resolve(ref);
  if (r.kind !== "face") throw ctx.fail(`Pick a flat face to ${verb}.`);
  const face = r.shape as TopoDS_Face;
  const frame = k.faceFrame(face);
  if (!frame) throw ctx.fail(`A face to ${verb} must be flat. Pick a planar face, or draw a sketch.`);
  const names = new ShapeIndex<string>(k);
  for (const e of r.body.topo.edges) names.add(e.shape, e.name);
  const edges = k.sub(face, "edge").map((e, i) => ({ entity: faceEdgeId(names.get(e) ?? `${ref.name}#${i}`), edge: e as TopoDS_Edge }));
  const outer: Shape = ctx.tmp(oc.BRepTools.OuterWire(face));
  const outline = k.sub(outer, "edge").flatMap((e) => edgePoints(ctx, e));
  const id = faceRegionId(ref);
  // the outline is each edge's points, edge by edge in the kernel's order: enough to say where the region is
  const region = { id, outer: { edges: [], polygon: outline.map((p) => toPlane(frame, p)), area: 0 }, holes: [] };
  return { id, region, face, edges, frame, from: { ref, body: r.body }, outline };
}

/**
 * The regions a profile parameter names: the sketch's (all, or those listed) and then each face.  `verb` is
 * what the feature does with them ("extrude"), for the messages; `faces` says whether the feature takes faces.
 */
export function resolveProfile(ctx: EvalContext, value: unknown, verb: string, o: { faces?: boolean } = {}): Profile {
  const sketchId = profileSketch(value), faces = o.faces === false ? [] : profileFaces(value);
  if (!sketchId && !faces.length) throw ctx.fail(o.faces === false ? `Pick a sketch to ${verb}.` : `Pick a sketch or a flat face to ${verb}.`);
  const regions: ProfileRegion[] = [];
  let sketch: SketchGeometry | null = null;
  if (sketchId) {
    const s = sketch = ctx.sketch(sketchId);
    const wanted = (value as { regions?: string[] | null }).regions;
    const mine = s.regions.filter((r) => !wanted || wanted.includes(r.id));
    if (!mine.length) throw ctx.fail(s.regions.length ? "The regions this feature used are gone from the sketch. Edit the feature and pick the sketch again." : `The sketch has no closed region to ${verb}. Close its outline first.`);
    for (const r of mine) regions.push({ ...r, frame: s.frame, from: null, outline: r.region.outer.polygon.map((q) => toWorld(s.frame, q)) });
  }
  const seen = new Set<string>();
  for (const ref of faces) {
    const r = faceRegion(ctx, ref, verb);
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    regions.push(r);
  }
  return { regions, sketch, sketchId };
}

/** The edges round a face used as a profile, each with what names the surface it sweeps, and the face's frame. */
export function faceCurves(ctx: EvalContext, ref: GeomRef, verb: string): { frame: Frame; curves: { entity: string; edge: Shape }[] } {
  const r = faceRegion(ctx, ref, verb);
  return { frame: r.frame, curves: r.edges.map((e) => ({ entity: e.entity, edge: e.edge as Shape })) };
}
