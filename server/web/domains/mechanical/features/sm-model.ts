// sm-model.ts — Sheet metal model: start a sheet metal part, and say its thickness, bend radius, K-factor,
// minimal gap and the reliefs its bends and corners get when nothing else is said.
//
// Three ways in, as Onshape has them:
//   • Thicken: the regions of a sketch become flat walls.
//   • Extrude: sketch lines become walls `depth` high, joined by bends where the lines meet.
//   • Convert: the flat faces of a part become walls (the material inside them), joined by bends along the
//     part's edges, except the edges named to rip (and edges that would close a loop of bends, which rip too).
// The part is a definition (kernel/ops/sheetmetal.ts), from which the body and the flat pattern both come.
import { defineFeature } from "../core/feature";
import { cross, normalize, sub, toWorld, type GeomRef, type Vec2, type Vec3 } from "../core/geometry";
import type { EvalContext, Shape } from "../kernel/types";
import { commit, mframe, minv, mpt, placements, poly2, sideAt, storeOf, wallOf, xform, type Mat, type SMModel } from "../kernel/ops/sheetmetal";
import { addWall, joinBend, newModel, ripTrim, touching } from "../kernel/ops/sheetmetal-ops";
import { chainOf } from "../kernel/ops/sweep-path";
import { pointOf } from "../sketch/format";
import type { RefTarget } from "./_refs";
import { SM_SECTION } from "./_sm";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SMModelParams {
  [key: string]: any;
  method: "thicken" | "extrude" | "convert";
  profile: { sketch: string; regions: string[] | null } | null;
  lines: RefTarget[];
  depth: number; symmetric: boolean;
  parts: string[]; exclude: GeomRef[]; rips: GeomRef[];
  thickness: number; flip: boolean;
  radius: number; kFactor: number; gap: number;
  reliefType: "rectangle" | "obround" | "tear"; reliefWidth: number; reliefDepth: number;
  cornerType: "rectangle" | "round" | "closed"; cornerScale: number;
}

export const SM_ICON = '<path class="f" d="M3 17.5l6-3.5 12 0-6 3.5z"/><path d="M3 17.5l6-3.5h12l-6 3.5zM3 17.5V8.5M15 17.5V8.5M3 8.5h12"/><path class="t" d="M9 14V5h12v9"/>';

/** Rigid frame of a wall standing on a sketch line, `x` along it and `y` up the sketch normal. */
const wallFrame = (o: Vec3, x: Vec3, y: Vec3): Mat => mframe(o, x, y, cross(x, y));
const shift = (m: Mat, v: Vec3, by: number): Mat => { const o = m.slice(); o[3] += v[0] * by; o[7] += v[1] * by; o[11] += v[2] * by; return o; };
const zOf = (m: Mat): Vec3 => [m[2], m[6], m[10]];

/** Join two walls along a common edge with a bend, or trim them back to a rip when a bend cannot be made there. */
function joinOrRip(ctx: EvalContext, m: SMModel, wa: string, pa: [Vec3, Vec3], wb: string, pb: [Vec3, Vec3], rip: boolean): SMModel {
  const { mat } = placements(m);
  const local = (w: string, p: Vec3): Vec2 => { const q = mpt(minv(mat.get(w)!), p); return [q[0], q[1]]; };
  const side = (w: string, p: [Vec3, Vec3]) => {
    const a = local(w, p[0]), b = local(w, p[1]), L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return sideAt(ctx.k, wallOf(m, w), [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], [(b[0] - a[0]) / L, (b[1] - a[1]) / L]);
  };
  const sa = side(wa, pa), sb = side(wb, pb);
  if (!sa || !sb || !touching(ctx.k, m, sa, sb)) return m;
  if (!rip && placements(m).root.get(wa) !== placements(m).root.get(wb)) {
    try { return joinBend(ctx.k, m, sa, sb, m.radius, m.k, ctx.feature.id, ctx.own); } catch (e) { if (!(e instanceof Error) || e.name !== "FeatureError") throw e; }
  }
  return ripTrim(ctx.k, m, sa, sb, m.gap, ctx.own);
}

export default defineFeature<SMModelParams>({
  type: "sm-model",
  title: "Sheet metal model",
  icon: SM_ICON,
  hint: "Start a sheet metal part from a sketch or a part, with its thickness, bend radius and K-factor",
  keywords: "sheet metal model thickness k factor bend radius convert thicken extrude",
  toolbarSection: SM_SECTION, toolbarOrder: 10, toolbarKeep: 70,
  defaults: () => ({
    method: "thicken", profile: null, lines: [], depth: 25, symmetric: false, parts: [], exclude: [], rips: [],
    thickness: 1, flip: false, radius: 1, kFactor: 0.45, gap: 0.2,
    reliefType: "rectangle", reliefWidth: 1, reliefDepth: 1.5, cornerType: "rectangle", cornerScale: 1.5,
  }),
  schema: [
    { key: "method", label: "Method", kind: "enum", options: [{ value: "thicken", label: "Thicken" }, { value: "extrude", label: "Extrude" }, { value: "convert", label: "Convert" }] },
    { key: "profile", label: "Regions to thicken", kind: "profile", visible: (p) => p.method === "thicken" || !p.method },
    { key: "lines", label: "Sketch lines", kind: "refs", of: ["edge"], sketch: true, hint: "Picking one line takes the lines joined to it.", visible: (p) => p.method === "extrude" },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0.01, step: 1, visible: (p) => p.method === "extrude" },
    { key: "symmetric", label: "Symmetric", kind: "boolean", visible: (p) => p.method === "extrude" },
    { key: "parts", label: "Part to convert", kind: "bodies", visible: (p) => p.method === "convert" },
    { key: "exclude", label: "Faces to exclude", kind: "refs", of: ["face"], hint: "Left open in the sheet metal part.", visible: (p) => p.method === "convert" },
    { key: "rips", label: "Edges to rip", kind: "refs", of: ["edge"], hint: "Kept apart by the minimal gap instead of bent.", visible: (p) => p.method === "convert" },
    { key: "thickness", label: "Thickness", kind: "number", unit: "mm", min: 0.01, step: 0.1 },
    { key: "flip", label: "Opposite direction", kind: "boolean", hint: "Put the material on the other side.", visible: (p) => p.method !== "convert" },
    { key: "radius", label: "Bend radius", kind: "number", unit: "mm", min: 0.01, step: 0.5 },
    { key: "kFactor", label: "K-factor", kind: "number", unit: "none", min: 0, max: 1, step: 0.01, hint: "Where the neutral axis lies, as a fraction of the thickness from the inside." },
    { key: "gap", label: "Minimal gap", kind: "number", unit: "mm", min: 0, step: 0.1, hint: "Left between walls that meet at a rip or a closed corner." },
    { key: "reliefType", label: "Bend relief", kind: "enum", options: [{ value: "rectangle", label: "Rectangle" }, { value: "obround", label: "Obround" }, { value: "tear", label: "Tear" }] },
    { key: "reliefWidth", label: "Relief width scale", kind: "number", unit: "none", min: 0, step: 0.1, hint: "× the thickness.", visible: (p) => p.reliefType !== "tear" },
    { key: "reliefDepth", label: "Relief depth scale", kind: "number", unit: "none", min: 0, step: 0.1, hint: "× the thickness, past the bend.", visible: (p) => p.reliefType !== "tear" },
    { key: "cornerType", label: "Corner relief", kind: "enum", options: [{ value: "rectangle", label: "Rectangle" }, { value: "round", label: "Round" }, { value: "closed", label: "Closed" }] },
    { key: "cornerScale", label: "Corner relief scale", kind: "number", unit: "none", min: 0.1, step: 0.1, hint: "× (bend radius + thickness).", visible: (p) => p.cornerType !== "closed" },
  ],

  evaluate(ctx: EvalContext, p: SMModelParams) {
    const k = ctx.k, id = ctx.feature.id, t = p.thickness;
    if (!(t > 0)) throw ctx.fail("The thickness must be more than zero.");
    if (!(p.radius > 0)) throw ctx.fail("The bend radius must be more than zero.");
    const kf = Math.max(0, Math.min(1, Number.isFinite(p.kFactor) ? p.kFactor : 0.45));
    let m = newModel(id, ctx.feature.name, {
      thickness: t, radius: p.radius, k: kf, gap: Math.max(0, p.gap || 0),
      relief: { type: p.reliefType || "rectangle", width: (p.reliefWidth ?? 1) * t, depth: (p.reliefDepth ?? 1.5) * t },
      corner: { type: p.cornerType || "rectangle", size: (p.cornerScale ?? 1.5) * (p.radius + t) },
    });
    const method = p.method || "thicken";
    if (method === "thicken") {
      if (!p.profile || !p.profile.sketch) throw ctx.fail("Pick the sketch regions to make into sheet metal.");
      const s = ctx.sketch(p.profile.sketch), f = s.frame;
      const regions = s.regions.filter((r) => !p.profile!.regions || p.profile!.regions.includes(r.id));
      if (!regions.length) throw ctx.fail("The sketch has no closed region.");
      let place: Mat = mframe(f.origin, f.x, f.y, f.normal);
      if (p.flip) place = shift(place, f.normal, -t);
      for (const r of regions) m = addWall(k, m, xform(k, r.face, minv(place), ctx.own), id, place, ctx.own).model;
    } else if (method === "extrude") {
      const picks = (p.lines || []).filter((x) => x.kind === "sketch") as { feature: string; entity: string }[];
      if (!picks.length) throw ctx.fail("Pick sketch lines to extrude into walls.");
      if (!(p.depth > 0)) throw ctx.fail("The depth must be more than zero.");
      const sk = ctx.sketch(picks[0].feature), f = sk.frame, data = sk.data;
      const ids = chainOf(data, picks.filter((x) => x.feature === picks[0].feature).map((x) => x.entity));
      const segs: { a: Vec2; b: Vec2 }[] = [];
      for (const e of ids) {
        const ent = data.entities[e] as any;
        if (ent.type !== "line") throw ctx.fail("Extrude takes straight sketch lines only (draw arcs as bends with Flange or Bend).");
        const a = pointOf(data, ent.a), b = pointOf(data, ent.b);
        if (a && b) segs.push({ a, b });
      }
      // in path order, so each wall is joined to the one before it
      const ordered: { a: Vec2; b: Vec2 }[] = [];
      const same = (u: Vec2, v: Vec2) => Math.hypot(u[0] - v[0], u[1] - v[1]) < 1e-6;
      const rest = segs.slice();
      let start = rest.findIndex((s) => !rest.some((o) => o !== s && (same(o.a, s.a) || same(o.b, s.a))));
      if (start < 0) start = 0;
      ordered.push(rest.splice(start, 1)[0]);
      while (rest.length) {
        const tip = ordered[ordered.length - 1].b;
        const i = rest.findIndex((s) => same(s.a, tip) || same(s.b, tip));
        if (i < 0) break;
        const s = rest.splice(i, 1)[0];
        ordered.push(same(s.a, tip) ? s : { a: s.b, b: s.a });
      }
      const up = f.normal, base = p.symmetric ? -p.depth / 2 : 0;
      const walls: { id: string; A: Vec3; B: Vec3 }[] = [];
      for (const s of ordered) {
        const A = toWorld(f, s.a), B = toWorld(f, s.b), L = Math.hypot(...sub(B, A));
        let W = wallFrame(A, normalize(sub(B, A)), up);
        W = shift(W, up, base);
        if (p.flip) W = shift(W, zOf(W), -t);
        const made = addWall(k, m, poly2(k, [[0, 0], [L, 0], [L, p.depth], [0, p.depth]], ctx.own), id, W, ctx.own);
        m = made.model;
        walls.push({ id: made.wall.id, A, B });
      }
      for (let i = 1; i < walls.length; i++) {
        const P = walls[i].A, Q: Vec3 = [P[0] + up[0], P[1] + up[1], P[2] + up[2]];
        m = joinOrRip(ctx, m, walls[i - 1].id, [P, Q], walls[i].id, [P, Q], false);
      }
      // a closed loop of lines: the last wall meets the first at a rip
      if (walls.length > 2 && Math.hypot(...sub(walls[0].A, walls[walls.length - 1].B)) < 1e-6) {
        const P = walls[0].A, Q: Vec3 = [P[0] + up[0], P[1] + up[1], P[2] + up[2]];
        m = joinOrRip(ctx, m, walls[walls.length - 1].id, [P, Q], walls[0].id, [P, Q], true);
      }
    } else {
      const parts = p.parts || [];
      if (!parts.length) throw ctx.fail("Pick the part to convert to sheet metal.");
      const body = ctx.body(parts[0]);
      if (!body) throw ctx.fail("The part to convert is gone. Pick it again.");
      if (Object.values(storeOf(ctx)).some((x) => Object.values(x.bodies).includes(body.id))) throw ctx.fail("That part is sheet metal already.");
      const skip = new Set<string>();
      for (const r of p.exclude || []) skip.add(ctx.resolve(r).name);
      const ripEdges: Shape[] = (p.rips || []).map((r) => ctx.resolve(r).shape);
      const wallOfFace = new Map<string, string>();
      for (const nf of body.topo.faces) {
        if (skip.has(nf.name)) continue;
        const fr = k.faceFrame(nf.shape as any);
        if (!fr) throw ctx.fail("Only parts with flat faces can be converted. Exclude the curved faces.");
        // the wall's material lies inside the face: its +z points into the part
        const n: Vec3 = [-fr.normal[0], -fr.normal[1], -fr.normal[2]], y: Vec3 = [-fr.y[0], -fr.y[1], -fr.y[2]];
        const W = mframe(fr.origin, fr.x, y, n);
        const made = addWall(k, m, xform(k, nf.shape, minv(W), ctx.own), id, W, ctx.own);
        m = made.model;
        wallOfFace.set(nf.name, made.wall.id);
      }
      if (!wallOfFace.size) throw ctx.fail("Every face is excluded: nothing is left to convert.");
      // the part's edges between two walls, longest first, so the bends go where they matter most
      const joints: { a: string; b: string; p: [Vec3, Vec3]; rip: boolean; len: number }[] = [];
      for (const e of body.topo.edges) {
        const faces = body.topo.faces.filter((f) => k.sub(f.shape, "edge").some((x) => x.IsSame(e.shape)));
        if (faces.length !== 2) continue;
        const a = wallOfFace.get(faces[0].name), b = wallOfFace.get(faces[1].name);
        if (!a || !b) continue;
        const vs = k.sub(e.shape, "vertex");
        if (vs.length !== 2) continue;
        const P = vs.map((v) => k.vertexPoint(v)) as [Vec3, Vec3];
        joints.push({ a, b, p: P, rip: ripEdges.some((x) => x.IsSame(e.shape)), len: Math.hypot(...sub(P[1], P[0])) });
      }
      joints.sort((x, y) => Number(x.rip) - Number(y.rip) || y.len - x.len);
      for (const j of joints) m = joinOrRip(ctx, m, j.a, j.p, j.b, j.p, j.rip);
      ctx.removeBody(body);
    }
    commit(ctx, m);
  },
});
