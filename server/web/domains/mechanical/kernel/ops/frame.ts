// frame.ts — frames: standard profiles (tubes, angles, channels, beams, T-slot extrusions) swept along path
// segments, one part per segment, their ends mitred or butted where segments meet; and what Trim, Gusset, End
// cap and Cut list need to know about the parts made that way (ModelState.extras["frame"]).
//
// A profile is drawn in its own plane, centred on its box, x across and y up.  A member's frame puts the
// profile square to the path at the segment's start: z along the path, y the "up" of the path (the sketch's
// normal, or world Z for edges), x = y × z.
import type { Vec2, Vec3 } from "../../core/geometry";
import type { Kernel, Keep } from "../occ";
import { FeatureError, type EvalContext, type Shape } from "../types";
import { bool, circleFace, mframe, minv, mpt, poly2, xform, type Mat } from "./sheetmetal";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ------------------------------------------------------------------ the profile library
export interface ProfileDef {
  /** stored in documents: `<family>:<size>` */
  id: string; family: string; size: string;
  /** what the cut list calls it */
  label: string;
}
type Ring = { poly: Vec2[] } | { circle: number };
interface Outline { outer: Ring; holes: Ring[]; cuts?: Vec2[][] }

export const FAMILIES: { id: string; label: string }[] = [
  { id: "square-tube", label: "Square tube" }, { id: "rect-tube", label: "Rectangular tube" }, { id: "round-tube", label: "Round tube" },
  { id: "angle", label: "Angle" }, { id: "channel", label: "Channel" }, { id: "i-beam", label: "I-beam" }, { id: "t-slot", label: "T-slot" },
];
/** Sizes of each family, as text: what a person picks and what the cut list prints. */
export const SIZES: { [family: string]: string[] } = {
  "square-tube": ["20x20x2", "25x25x2", "30x30x3", "40x40x3", "50x50x4"],
  "rect-tube": ["40x20x2", "50x30x3", "60x40x3", "80x40x4"],
  "round-tube": ["21.3x2.3", "26.9x2.6", "33.7x3.2", "42.4x3.2", "48.3x3.6", "60.3x4"],
  angle: ["20x20x3", "30x30x3", "40x40x4", "50x50x5"],
  channel: ["UPN50", "UPN80", "UPN100"],
  "i-beam": ["IPE80", "IPE100", "IPE120", "IPE160"],
  "t-slot": ["20", "30", "40"],
};
const CHANNEL: { [s: string]: number[] } = { UPN50: [50, 38, 5, 7], UPN80: [80, 45, 6, 8], UPN100: [100, 50, 6, 8.5] };
const IPE: { [s: string]: number[] } = { IPE80: [80, 46, 3.8, 5.2], IPE100: [100, 55, 4.1, 5.7], IPE120: [120, 64, 4.4, 6.3], IPE160: [160, 82, 5, 7.4] };
/** T-slot series: side, slot opening, lip, cavity width, cavity depth, centre bore */
const TSLOT: { [s: string]: number[] } = { "20": [20, 6.2, 1.8, 11, 4.3, 4.2], "30": [30, 8.2, 2.2, 16.5, 6.5, 6.8], "40": [40, 8.2, 4.3, 20, 8, 10] };

export function profileDef(family: string, size: string): ProfileDef {
  const f = FAMILIES.find((x) => x.id === family);
  if (!f || !(SIZES[family] || []).includes(size)) throw new FeatureError("Pick a profile and a size from the library.");
  const label = family === "t-slot" ? `T-slot ${size} series` : `${f.label} ${size.replace(/x/g, "×")}`;
  return { id: `${family}:${size}`, family, size, label };
}

const box = (w: number, h: number, x = 0, y = 0): Vec2[] => [[x - w / 2, y - h / 2], [x + w / 2, y - h / 2], [x + w / 2, y + h / 2], [x - w / 2, y + h / 2]];
const shiftAll = (pts: Vec2[], dx: number, dy: number): Vec2[] => pts.map((p) => [p[0] + dx, p[1] + dy]);

function outlineOf(p: ProfileDef): Outline {
  const n = p.size.split("x").map(Number);
  switch (p.family) {
    case "square-tube": return { outer: { poly: box(n[0], n[1]) }, holes: [{ poly: box(n[0] - 2 * n[2], n[1] - 2 * n[2]) }] };
    case "rect-tube": return { outer: { poly: box(n[0], n[1]) }, holes: [{ poly: box(n[0] - 2 * n[2], n[1] - 2 * n[2]) }] };
    case "round-tube": return { outer: { circle: n[0] / 2 }, holes: [{ circle: n[0] / 2 - n[1] }] };
    case "angle": { const [a, b, t] = n; return { outer: { poly: shiftAll([[0, 0], [a, 0], [a, t], [t, t], [t, b], [0, b]], -a / 2, -b / 2) }, holes: [] }; }
    case "channel": {
      const [h, b, tw, tf] = CHANNEL[p.size];
      return { outer: { poly: shiftAll([[0, 0], [b, 0], [b, tf], [tw, tf], [tw, h - tf], [b, h - tf], [b, h], [0, h]], -b / 2, -h / 2) }, holes: [] };
    }
    case "i-beam": {
      const [h, b, tw, tf] = IPE[p.size], x = b / 2, w = tw / 2, y = h / 2;
      return { outer: { poly: [[-x, -y], [x, -y], [x, -y + tf], [w, -y + tf], [w, y - tf], [x, y - tf], [x, y], [-x, y], [-x, y - tf], [-w, y - tf], [-w, -y + tf], [-x, -y + tf]] }, holes: [] };
    }
    case "t-slot": {
      const [s, open, lip, cw, cd, bore] = TSLOT[p.size];
      const cuts: Vec2[][] = [];
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2, c = Math.cos(a), sn = Math.sin(a);
        const rot = (pts: Vec2[]): Vec2[] => pts.map((q) => [q[0] * c - q[1] * sn, q[0] * sn + q[1] * c]);
        cuts.push(rot(box(open, lip + 1, 0, s / 2 - lip / 2 + 0.5)));
        // the cavity behind the lip narrows towards the core, leaving the webs to the corners
        const y1 = s / 2 - lip + 1e-3, y0 = s / 2 - lip - cd;
        cuts.push(rot([[-open / 2, y0], [open / 2, y0], [cw / 2, y1], [-cw / 2, y1]]));
      }
      return { outer: { poly: box(s, s) }, holes: [{ circle: bore / 2 }], cuts };
    }
  }
  throw new FeatureError("That profile is not in the library.");
}

/** The profile as a planar face in XY, centred on its box. */
export function profileFace(k: Kernel, p: ProfileDef, keep: Keep): Shape {
  const o = outlineOf(p);
  const ring = (r: Ring): Shape => ("circle" in r ? circleFace(k, [0, 0, 0], [0, 0, 1], r.circle, keep) : poly2(k, r.poly, keep));
  let f = ring(o.outer);
  for (const h of o.holes) f = bool(k, "cut", f, ring(h), keep);
  for (const c of o.cuts || []) f = bool(k, "cut", f, poly2(k, c, keep), keep);
  const faces = k.sub(f, "face");
  if (faces.length !== 1) throw new FeatureError("The profile could not be drawn.");
  return keep((k.oc as any).TopoDS.Face(faces[0]));
}
/** The profile's box: half its width and half its height. */
export function profileHalf(p: ProfileDef): [number, number] {
  const o = outlineOf(p);
  if ("circle" in o.outer) return [o.outer.circle, o.outer.circle];
  let x = 0, y = 0;
  for (const q of o.outer.poly) { x = Math.max(x, Math.abs(q[0])); y = Math.max(y, Math.abs(q[1])); }
  return [x, y];
}

// ------------------------------------------------------------------ what the frame features keep
export interface FrameItem {
  body: string; feature: string;
  kind: "member" | "gusset" | "end cap";
  /** the profile's label, or the plate's description */
  label: string;
  /** the member's length (longest point to longest point along its axis), or the plate's largest size */
  length: number;
  /** each end's cut, in degrees from square */
  angles: [number, number];
  /** a straight member's axis, start to end */
  axis?: [Vec3, Vec3];
  half?: [number, number];
}
export type FrameStore = { [body: string]: FrameItem };
export const FRAME_EXTRA = "frame";
export const frameStore = (ctx: EvalContext): FrameStore => ctx.extra<FrameStore>(FRAME_EXTRA) || {};
export function setItems(ctx: EvalContext, items: FrameItem[]): void {
  const s = { ...frameStore(ctx) };
  for (const it of items) s[it.body] = it;
  ctx.setExtra(FRAME_EXTRA, s);
}

// ------------------------------------------------------------------ vectors and cutting
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Remove what lies on the +normal side of a plane through `origin`. */
export function cutBeyond(k: Kernel, solid: Shape, origin: Vec3, normal: Vec3, keep: Keep): Shape {
  const n = unit3(normal), size = 1e4;
  const u = unit3(Math.abs(n[2]) < 0.9 ? cross3(n, [0, 0, 1]) : cross3(n, [1, 0, 0])), v = cross3(n, u);
  const P = (a: number, b: number): Vec3 => add3(add3(origin, u, a), v, b);
  const oc = k.oc as any;
  const face = poly2Face(k, [P(-size, -size), P(size, -size), P(size, size), P(-size, size)], keep);
  const vec = k.vec([n[0] * size, n[1] * size, n[2] * size]);
  const pr = new oc.BRepPrimAPI_MakePrism(face, vec, false, true);
  const tool = keep(pr.Shape());
  pr.delete(); vec.delete();
  const out = bool(k, "cut", solid, tool, keep);
  const solids = k.solids(out);
  if (!solids.length) throw new FeatureError("A cut would leave nothing of a member.");
  return solids.length === 1 ? solids[0] : out;
}
function poly2Face(k: Kernel, pts: Vec3[], keep: Keep): Shape {
  // a planar face through 3D points (sheetmetal.ts polyFace, without its import cycle)
  const oc = k.oc as any, mw = new oc.BRepBuilderAPI_MakeWire();
  const P = pts.map((p) => k.pnt(p));
  for (let i = 0; i < P.length; i++) { const me = new oc.BRepBuilderAPI_MakeEdge(P[i], P[(i + 1) % P.length]); mw.Add(me.Edge()); me.delete(); }
  const mf = new oc.BRepBuilderAPI_MakeFace(mw.Wire(), true), f = keep(mf.Face());
  mf.delete(); mw.delete(); P.forEach((p) => p.delete());
  return f;
}

/** The extent of a solid along a direction: [min, max] of its vertices' projections from `origin`. */
export function extentAlong(k: Kernel, shape: Shape, origin: Vec3, dir: Vec3): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const v of k.sub(shape, "vertex")) { const t = dot3(sub3(k.vertexPoint(v), origin), dir); lo = Math.min(lo, t); hi = Math.max(hi, t); }
  return [lo, hi];
}

// ------------------------------------------------------------------ members
export interface Segment {
  /** the curve itself (a line or an arc edge) */
  edge: Shape;
  a: Vec3; b: Vec3;
  /** tangents at the start and the end, in the direction of travel */
  ta: Vec3; tb: Vec3;
  straight: boolean;
  /** the profile's "up" at the start */
  up: Vec3;
}
export interface MemberOptions { profile: ProfileDef; angle: number; mirror: boolean; align: string; corner: "miter" | "butt" | "none" }

/** A curve edge as a segment (its ends and tangents). */
export function segmentOf(k: Kernel, edge: Shape, up: Vec3 | null): Segment {
  const oc = k.oc as any;
  const ad = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
  try {
    const f = ad.FirstParameter(), l = ad.LastParameter(), straight = ad.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line;
    const at = (u: number): [Vec3, Vec3] => {
      const p = new oc.gp_Pnt(), v = new oc.gp_Vec();
      ad.D1(u, p, v);
      const out: [Vec3, Vec3] = [k.xyz(p), unit3([v.X(), v.Y(), v.Z()])];
      p.delete(); v.delete();
      return out;
    };
    let [a, ta] = at(f), [b, tb] = at(l);
    if (edge.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) { [a, b] = [b, a]; [ta, tb] = [[-tb[0], -tb[1], -tb[2]], [-ta[0], -ta[1], -ta[2]]]; }
    let u: Vec3 = up || [0, 0, 1];
    if (Math.abs(dot3(u, ta)) > 0.99) u = Math.abs(ta[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return { edge, a, b, ta, tb, straight, up: u };
  } finally { ad.delete(); }
}
/** The same segment run the other way. */
export const reversed = (s: Segment, k: Kernel): Segment => ({ ...s, edge: s.edge.Reversed(), a: s.b, b: s.a, ta: [-s.tb[0], -s.tb[1], -s.tb[2]], tb: [-s.ta[0], -s.ta[1], -s.ta[2]] });

/** The frame a profile is placed by at a segment's start, with the member's rotation, mirror and alignment. */
export function profileFrame(s: Segment, o: MemberOptions): Mat {
  const z = s.ta, y0 = unit3(sub3(s.up, [z[0] * dot3(s.up, z), z[1] * dot3(s.up, z), z[2] * dot3(s.up, z)])), x0 = cross3(y0, z);
  const c = Math.cos((o.angle * Math.PI) / 180), sn = Math.sin((o.angle * Math.PI) / 180);
  const x = add3([x0[0] * c, x0[1] * c, x0[2] * c], y0, sn), y = add3([y0[0] * c, y0[1] * c, y0[2] * c], x0, -sn);
  const [hx, hy] = profileHalf(o.profile);
  const dx = o.align.includes("left") ? hx : o.align.includes("right") ? -hx : 0, dy = o.align.includes("bottom") ? hy : o.align.includes("top") ? -hy : 0;
  const origin = add3(add3(s.a, x, dx), y, dy);
  return o.mirror ? mframe(origin, [-x[0], -x[1], -x[2]], y, [-z[0], -z[1], -z[2]]) : mframe(origin, x, y, z);
}

/** The bare member along a segment, extended by `ext0` before its start and `ext1` past its end (straight segments only). */
export function memberSolid(k: Kernel, s: Segment, o: MemberOptions, ext0: number, ext1: number, keep: Keep): Shape {
  const oc = k.oc as any;
  const F = profileFrame(s, o);
  if (s.straight) {
    const L = Math.hypot(...sub3(s.b, s.a)) + ext0 + ext1;
    const start = mframe(add3([F[3], F[7], F[11]], s.ta, -ext0), [F[0], F[4], F[8]], [F[1], F[5], F[9]], [F[2], F[6], F[10]]);
    const face = xform(k, profileFace(k, o.profile, keep), start, keep);
    const v = k.vec([s.ta[0] * L, s.ta[1] * L, s.ta[2] * L]);
    const pr = new oc.BRepPrimAPI_MakePrism(face, v, false, true);
    const out = keep(pr.Shape());
    pr.delete(); v.delete();
    return out;
  }
  const face = xform(k, profileFace(k, o.profile, keep), F, keep);
  const mw = new oc.BRepBuilderAPI_MakeWire(oc.TopoDS.Edge(s.edge));
  const pipe = new oc.BRepOffsetAPI_MakePipe(mw.Wire(), face);
  try {
    pipe.Build(new oc.Message_ProgressRange());
    if (!pipe.IsDone()) throw new FeatureError("The profile could not be swept along a curved segment. Try a smaller profile or a larger radius.");
    return keep(pipe.Shape());
  } finally { pipe.delete(); mw.delete(); }
}

/** The half-size of a member's profile seen from a direction square to its axis at one end. */
export function reachToward(s: Segment, o: MemberOptions, atEnd: boolean, dir: Vec3): number {
  const F = profileFrame(s, o), [hx, hy] = profileHalf(o.profile);
  const x: Vec3 = [F[0], F[4], F[8]], y: Vec3 = [F[1], F[5], F[9]];
  const c = atEnd ? s.b : s.a, centre: Vec3 = [F[3] + (c[0] - s.a[0]), F[7] + (c[1] - s.a[1]), F[11] + (c[2] - s.a[2])];
  let best = 0;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) best = Math.max(best, dot3(sub3(add3(add3(centre, x, sx * hx), y, sy * hy), c), dir));
  return best;
}

/** The degrees between a cut's normal and the member's axis: 0 for a square cut. */
export const cutAngle = (axis: Vec3, normal: Vec3): number => (Math.acos(Math.min(1, Math.abs(dot3(unit3(axis), unit3(normal))))) * 180) / Math.PI;

/** A frame's members: each segment swept, the ends trimmed where segments meet. */
export function buildMembers(k: Kernel, segs: Segment[], o: MemberOptions, keep: Keep): { shape: Shape; seg: Segment; length: number; angles: [number, number] }[] {
  const near = (p: Vec3, q: Vec3) => Math.hypot(...sub3(p, q)) < 1e-4;
  const [hx, hy] = profileHalf(o.profile), big = 2 * Math.hypot(hx, hy) + 1;
  const out: { shape: Shape; seg: Segment; length: number; angles: [number, number] }[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    // the segment joined at each end, and the cut there
    const joins: ({ normal: Vec3; at: Vec3; ext: number } | null)[] = [null, null];
    for (const end of [0, 1] as const) {
      const P = end ? s.b : s.a, t = end ? s.tb : s.ta;   // t: travel direction at that end
      for (let j = 0; j < segs.length; j++) {
        if (j === i) continue;
        const q = segs[j];
        // the other segment's direction leaving P
        const away: Vec3 | null = near(q.a, P) ? q.ta : near(q.b, P) ? [-q.tb[0], -q.tb[1], -q.tb[2]] : null;
        if (!away) continue;
        const into: Vec3 = end ? t : [-t[0], -t[1], -t[2]];   // this member's direction arriving at P
        if (dot3(into, away) > 0.9999) { joins[end] = null; break; }   // straight on: no cut
        if (dot3(into, away) < -0.9999 || o.corner === "none") break;
        if (o.corner === "miter") {
          const n = unit3(add3(into, away));
          joins[end] = { normal: n, at: P, ext: s.straight ? big : 0 };
        } else {
          // butt: the earlier segment of the path runs through, the later one stops at its side
          const qOpts = o, firstHere = i < j;
          const qSeg: Segment = near(q.a, P) ? q : reversed(q, k);
          if (firstHere) joins[end] = { normal: into, at: add3(P, into, reachToward(qSeg, qOpts, false, into)), ext: s.straight ? big : 0 };
          else joins[end] = { normal: into, at: add3(P, into, -reachToward(qSeg, qOpts, false, [-into[0], -into[1], -into[2]])), ext: s.straight ? big : 0 };
        }
        break;
      }
    }
    let shape = memberSolid(k, s, o, joins[0]?.ext || 0, joins[1]?.ext || 0, keep);
    const angles: [number, number] = [0, 0];
    joins.forEach((j, end) => {
      if (!j) return;
      // remove what lies past the cut, seen from this member
      const outward: Vec3 = end ? j.normal : [-j.normal[0], -j.normal[1], -j.normal[2]];
      const dirOut: Vec3 = end ? s.tb : [-s.ta[0], -s.ta[1], -s.ta[2]];
      shape = cutBeyond(k, shape, j.at, dot3(outward, dirOut) >= 0 ? outward : [-outward[0], -outward[1], -outward[2]], keep);
      angles[end] = cutAngle(end ? s.tb : s.ta, j.normal);
    });
    out.push({ shape, seg: s, length: s.straight ? (() => { const [lo, hi] = extentAlong(k, shape, s.a, s.ta); return hi - lo; })() : edgeLength(k, s.edge), angles });
  }
  return out;
}
export function edgeLength(k: Kernel, e: Shape): number {
  const oc = k.oc as any, g = new oc.GProp_GProps();
  oc.BRepGProp.LinearProperties(e, g, false, false);
  const v = g.Mass(); g.delete();
  return v;
}
/** A point's coordinates in a frame (for names that do not depend on where the member is). */
export const localOf = (F: Mat, p: Vec3): Vec3 => mpt(minv(F), p);
