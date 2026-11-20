// solve.ts — the sketch constraint solver: the sketch format (sketch/format.ts) in, solved coordinates out.
//
// The solving itself is FreeCAD's PlaneGCS (npm @salusoft89/planegcs, LGPL-2.1-or-later, a WebAssembly build):
// this file only translates.  Entities become solver points, lines, circles and arcs; each constraint of the
// sketch becomes one or more solver constraints tagged with the sketch constraint's id, so that what the solver
// reports as conflicting or redundant can be shown on the constraint a person made.
//
// It runs in the page (a solve of an ordinary sketch takes well under a millisecond, see the sketch-solver
// test), before an edit is committed.  The kernel never solves: the document stores what comes out of here.
//
//   const solver = await loadSolver();              // solver/load.ts
//   const r = solver.solve(data);                   // r.data has the solved coordinates when r.ok
//   solver.solve(data, { drag: [{ point, to }] })   // pull points towards the pointer, constraints permitting
import type { Vec2 } from "../../core/geometry";
import type { SketchConstraint, SketchData, SketchEntity } from "../format";
import { curvaturePoint, directionPoint, eccentric, endsOf, nearestOnPiece, pieceAt, pieceTangent } from "../curves";
import { ORIGIN, angleFrame, arcSweep, dist, pointAt, pointsOf, resolve, type Resolved } from "../refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Something being dragged: a point towards a position, or a circle or arc towards a radius. */
export type DragTarget = { point: string; to: Vec2 } | { curve: string; radius: number };

export interface SolveOptions {
  drag?: DragTarget[];
  /** extra constraints for this solve only (the definedness probe uses it) */
  extra?: { [id: string]: SketchConstraint };
  /**
   * false: skip the second pass.  The solver counts freedoms and finds redundant constraints where the sketch
   * *starts*, so after a solve that moved things the count is taken again at the solution (a horizontal line is
   * only seen to be parallel to another horizontal line once both are horizontal).  A drag does not need it.
   */
  diagnose?: boolean;
}

export interface SolveResult {
  /** the solver converged and no constraint conflicts with another */
  ok: boolean;
  /** the sketch with solved coordinates when `ok`; the input otherwise */
  data: SketchData;
  /** degrees of freedom left; 0 is fully constrained */
  dof: number;
  /** ids of the sketch constraints that cannot all hold */
  conflicting: string[];
  /** ids of constraints that say what others already say */
  redundant: string[];
  /** ids of constraints that were left out: unknown type, or references that no longer exist */
  skipped: string[];
  ms: number;
}

/** The solver's own module and wrapper, as solver/load.ts hands them over. */
export interface GcsHandle { wrapper: any; Algorithm: { DogLeg: number; LevenbergMarquardt: number; BFGS: number } }

const DEG = Math.PI / 180;
const round = (v: number): number => { const r = Math.round(v * 1e9) / 1e9; return Object.is(r, -0) ? 0 : r; };
/** The sketch constraint a solver primitive id belongs to ("k3#2" → "k3"). */
const owner = (id: string): string => { const i = id.indexOf("#"); return i < 0 ? id : id.slice(0, i); };

export class SketchSolver {
  constructor(private readonly gcs: GcsHandle) {}

  solve(data: SketchData, opts: SolveOptions = {}): SolveResult {
    const first = this.pass(data, opts);
    if (!first.ok || opts.diagnose === false || first.data === data || (opts.drag && opts.drag.length)) return first;
    const second = this.pass(first.data, opts);
    if (!second.ok) return { ...first, ms: first.ms + second.ms };
    return { ...second, redundant: unique([...first.redundant, ...second.redundant]), skipped: first.skipped, ms: first.ms + second.ms };
  }

  private pass(data: SketchData, opts: SolveOptions): SolveResult {
    const t0 = now();
    const g = this.gcs.wrapper;
    const skipped: string[] = [];
    const prims = primitives(data, opts, skipped);
    let status = 2, dof = 0, conflicting: string[] = [], redundant: string[] = [];
    try {
      g.clear_data();
      g.push_primitives_and_params(prims);
      // FreeCAD's own order of attack: DogLeg, then Levenberg-Marquardt, then BFGS
      for (const algo of [this.gcs.Algorithm.DogLeg, this.gcs.Algorithm.LevenbergMarquardt, this.gcs.Algorithm.BFGS]) {
        status = g.solve(algo);
        if (status === 0 || status === 1) break;
      }
      dof = g.gcs.dof();
      conflicting = unique((g.get_gcs_conflicting_constraints() as string[]).filter(Boolean).map(owner));
      redundant = unique((g.get_gcs_redundant_constraints() as string[]).filter(Boolean).map(owner)).filter((id) => !conflicting.includes(id));
    } catch (err) {
      g.clear_data();
      return { ok: false, data, dof: 0, conflicting: [], redundant: [], skipped, ms: now() - t0 };
    }
    const ok = (status === 0 || status === 1) && !conflicting.length;
    let out = data;
    if (ok) {
      g.apply_solution();
      const entities: { [id: string]: SketchEntity } = { ...data.entities };
      let finite = true;
      for (const p of g.sketch_index.get_primitives() as any[]) {
        const e = entities[p.id]; if (!e) continue;
        if (p.type === "point" && e.type === "point") {
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { finite = false; break; }
          const x = round(p.x), y = round(p.y);
          if (x !== e.x || y !== e.y) entities[p.id] = { ...e, x, y };
        } else if ((p.type === "ellipse" || p.type === "arc_of_ellipse") && (e.type === "ellipse" || e.type === "ellipticalArc")) {
          if (!Number.isFinite(p.radmin) || !(p.radmin > 0)) { finite = false; break; }
          const r = round(p.radmin);
          if (r !== e.minor) entities[p.id] = { ...e, minor: r };
        } else if (p.type === "circle" && e.type === "circle") {
          if (!Number.isFinite(p.radius) || !(p.radius > 0)) { finite = false; break; }
          const r = round(p.radius);
          if (r !== e.r) entities[p.id] = { ...e, r };
        }
      }
      if (finite) { if (Object.keys(entities).some((id) => entities[id] !== data.entities[id])) out = { ...data, entities }; }
      else { g.clear_data(); return { ok: false, data, dof, conflicting, redundant, skipped, ms: now() - t0 }; }
    }
    g.clear_data();
    return { ok, data: out, dof: Math.max(0, dof), conflicting, redundant, skipped, ms: now() - t0 };
  }

  /**
   * The entities whose place the constraints settle completely.  One solve per point and per circle: each is
   * pinned where it is, and if that takes away no freedom it had none.  Call it when the pointer is at rest,
   * not while dragging.
   */
  defined(data: SketchData, dof: number): Set<string> {
    const steps = this.definedSteps(data, dof);
    for (;;) { const s = steps.next(); if (s.done) return s.value; }
  }

  /** `defined` a solve at a time, so a caller can spread a large sketch over several frames. */
  *definedSteps(data: SketchData, dof: number): Generator<void, Set<string>, void> {
    const out = new Set<string>();
    const ids = Object.keys(data.entities);
    if (dof <= 0) { for (const id of ids) out.add(id); return out; }
    const probe = (c: SketchConstraint): boolean => { const r = this.pass(data, { extra: { "$probe": c } }); return r.ok ? r.dof === dof : true; };
    const pinned = new Set<string>();
    for (const id of ids) {
      if (data.entities[id].type !== "point") continue;
      if (probe({ type: "fix", refs: [{ entity: id }] })) pinned.add(id);
      yield;
    }
    for (const id of ids) {
      const e = data.entities[id];
      if (e.type === "point") { if (pinned.has(id)) out.add(id); }
      else if (e.type === "line") { if (pinned.has(e.a) && pinned.has(e.b)) out.add(id); }
      else if (e.type === "arc") { if (pinned.has(e.center) && pinned.has(e.start) && pinned.has(e.end)) out.add(id); }
      else if (e.type === "circle") {
        if (!pinned.has(e.center)) continue;
        if (probe({ type: "radius", refs: [{ entity: id }], value: e.r })) out.add(id);
        yield;
      }
      else if (pointsOf(e).length && pointsOf(e).every((p) => pinned.has(p))) {
        // an ellipse also needs its minor radius held: pin it and see whether that takes a freedom away
        if (e.type === "ellipse" || e.type === "ellipticalArc") { if (probe({ type: "fix", refs: [{ entity: id }] })) out.add(id); yield; }
        else out.add(id);
      }
    }
    return out;
  }
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
const unique = (a: string[]): string[] => Array.from(new Set(a));

// ---------------------------------------------------------------- the translation

/** The solver's input for a sketch: points first, then curves, then constraints. */
function primitives(data: SketchData, opts: SolveOptions, skipped: string[]): any[] {
  const out: any[] = [{ id: ORIGIN, type: "point", x: 0, y: 0, fixed: true }];
  const ids = Object.keys(data.entities).sort();
  const have = new Set<string>([ORIGIN]);
  for (const id of ids) {
    const e = data.entities[id];
    if (e.type === "point" && Number.isFinite(e.x) && Number.isFinite(e.y)) { out.push({ id, type: "point", x: e.x, y: e.y, fixed: false }); have.add(id); }
  }
  const rules: any[] = [];
  for (const id of ids) {
    const e = data.entities[id];
    if (e.type === "line" && have.has(e.a) && have.has(e.b) && e.a !== e.b) { out.push({ id, type: "line", p1_id: e.a, p2_id: e.b }); have.add(id); }
    else if (e.type === "circle" && have.has(e.center) && e.r > 0) { out.push({ id, type: "circle", c_id: e.center, radius: e.r }); have.add(id); }
    else if (e.type === "arc" && have.has(e.center) && have.has(e.start) && have.has(e.end)) {
      const r = resolve(data, { entity: id }) as Extract<Resolved, { kind: "arc" }> | null;
      if (!r || !(r.r > 0)) continue;
      const { a0, a1 } = arcSweep(r.c, r.s, r.en);
      out.push({ id, type: "arc", c_id: e.center, start_id: e.start, end_id: e.end, start_angle: a0, end_angle: a1, radius: r.r });
      rules.push({ id: id + "#rules", type: "arc_rules", a_id: id });
      have.add(id);
    } else if ((e.type === "ellipse" || e.type === "ellipticalArc") && have.has(e.center) && have.has(e.major) && Number(e.minor) > 0 && (e.type === "ellipse" || (have.has(e.start) && have.has(e.end)))) {
      // PlaneGCS holds an ellipse by its centre, a focus and the minor radius; the focus is the solver's own point,
      // and the stored major-axis point is tied to the end of the major axis
      const c = pointAt(data, e.center)!, m = pointAt(data, e.major)!, b = Number(e.minor), a = dist(c, m);
      if (!(a > 0)) continue;
      const u: [number, number] = [(m[0] - c[0]) / a, (m[1] - c[1]) / a], f = Math.sqrt(Math.max(0, a * a - b * b));
      out.push({ id: id + "$f", type: "point", x: c[0] + u[0] * f, y: c[1] + u[1] * f, fixed: false });
      if (e.type === "ellipse") out.push({ id, type: "ellipse", c_id: e.center, focus1_id: id + "$f", radmin: b });
      else {
        const s = pointAt(data, e.start)!, en = pointAt(data, e.end)!, bb = Math.min(b, a);
        const e0 = eccentric(c, u, a, bb, s); let e1 = eccentric(c, u, a, bb, en); if (e1 <= e0) e1 += Math.PI * 2;
        out.push({ id, type: "arc_of_ellipse", c_id: e.center, focus1_id: id + "$f", start_id: e.start, end_id: e.end, start_angle: e0, end_angle: e1, radmin: b });
        rules.push({ id: id + "#rules", type: "arc_of_ellipse_rules", a_id: id });
      }
      // the major-axis point is the positive end of the major diameter; the negative end is the solver's own.
      // (A lone point-to-ellipse alignment is no use here: this build of the glue drops its alignment type.)
      out.push({ id: id + "$n", type: "point", x: 2 * c[0] - m[0], y: 2 * c[1] - m[1], fixed: false });
      rules.push({ id: id + "#major", type: "internal_alignment_ellipse_major_diameter", e_id: id, p1_id: e.major, p2_id: id + "$n" });
      have.add(id);
    } else if (e.type !== "point" && e.type !== "line" && e.type !== "circle" && e.type !== "arc" && pointsOf(e).every((p) => have.has(p))) {
      // splines, conics, text, images: their points are the solver's unknowns; the curve itself is not a primitive
      have.add(id);
    }
  }
  out.push(...rules);
  const all: [string, SketchConstraint][] = Object.keys(data.constraints || {}).sort().map((id) => [id, data.constraints[id]]);
  for (const [id, c] of Object.entries(opts.extra || {})) all.push([id, c]);
  for (const [id, c] of all) {
    if (!c || c.driving === false) continue;
    const made = translate(data, id, c, have);
    if (!made) { skipped.push(id); continue; }
    let i = 0;
    for (const m of made) {
      if (m.type === "$point") out.push({ id: m.pid, type: "point", x: m.x, y: m.y, fixed: false });   // a point of the solver's own
      else { out.push({ ...m, id: i ? `${id}#${i + 1}` : id }); i++; }
    }
  }
  let n = 0;
  for (const d of opts.drag || []) {
    if ("point" in d) {
      if (!have.has(d.point) || d.point === ORIGIN) continue;
      out.push({ id: `$drag#${n++}`, type: "coordinate_x", p_id: d.point, x: d.to[0], temporary: true });
      out.push({ id: `$drag#${n++}`, type: "coordinate_y", p_id: d.point, y: d.to[1], temporary: true });
    } else if (have.has(d.curve) && d.radius > 0) {
      const e = data.entities[d.curve];
      if (e.type === "circle") out.push({ id: `$drag#${n++}`, type: "circle_radius", c_id: d.curve, radius: d.radius, temporary: true });
      if (e.type === "arc") out.push({ id: `$drag#${n++}`, type: "arc_radius", a_id: d.curve, radius: d.radius, temporary: true });
    }
  }
  return out;
}

type Line = Extract<Resolved, { kind: "line" }>;
type Circ = Extract<Resolved, { kind: "circle" | "arc" }>;
const isCirc = (r: Resolved): r is Circ => r.kind === "circle" || r.kind === "arc";

/** The solver constraints for one sketch constraint, or null when it cannot be expressed. */
function translate(data: SketchData, id: string, c: SketchConstraint, have: Set<string>): any[] | null {
  const refs = (c.refs || []).map((ref) => resolve(data, ref));
  if (!refs.length || refs.some((r) => !r || !have.has(r.id))) return null;
  const r = refs as Resolved[];
  const [a, b, d] = r;
  const points = r.filter((x) => x.kind === "point") as Extract<Resolved, { kind: "point" }>[];
  const lines = r.filter((x) => x.kind === "line") as Line[];
  const circs = r.filter(isCirc);
  const value = typeof c.value === "number" && Number.isFinite(c.value) ? c.value : null;

  switch (c.type) {
    case "coincident": {
      if (r.length !== 2) return null;
      if (points.length === 2) return points[0].id === points[1].id ? [] : [{ type: "p2p_coincident", p1_id: points[0].id, p2_id: points[1].id }];
      if (points.length !== 1) return null;
      const p = points[0], on = a === p ? b : a;
      if (curveUses(on, p.id)) return [];
      if (on.kind === "line") return [{ type: "point_on_line_pl", p_id: p.id, l_id: on.id }];
      if (on.kind === "circle") return [{ type: "point_on_circle", p_id: p.id, c_id: on.id }];
      if (on.kind === "arc") return [{ type: "point_on_arc", p_id: p.id, a_id: on.id }];
      if (on.kind === "curve" && isEllipse(on)) return [{ type: "point_on_ellipse", p_id: p.id, e_id: on.id }];
      return null;
    }
    case "normal": return r.length === 2 ? normal(a, b) : null;
    case "curvature": return r.length === 2 ? curvature(data, id, a, b) : null;
    case "horizontal": case "vertical": {
      const t = c.type;
      if (r.length === 1 && a.kind === "line") return [{ type: `${t}_l`, l_id: a.id }];
      if (r.length === 2 && points.length === 2 && points[0].id !== points[1].id) return [{ type: `${t}_pp`, p1_id: points[0].id, p2_id: points[1].id }];
      return null;
    }
    case "parallel": return lines.length === 2 && r.length === 2 ? [{ type: "parallel", l1_id: a.id, l2_id: b.id }] : null;
    case "perpendicular": return lines.length === 2 && r.length === 2 ? [{ type: "perpendicular_ll", l1_id: a.id, l2_id: b.id }] : null;
    case "collinear":
      if (lines.length !== 2 || r.length !== 2) return null;
      return [{ type: "point_on_line_pl", p_id: lines[1].e.a, l_id: lines[0].id }, { type: "point_on_line_pl", p_id: lines[1].e.b, l_id: lines[0].id }];
    case "equal": {
      if (r.length !== 2) return null;
      if (lines.length === 2) return [{ type: "equal_length", l1_id: a.id, l2_id: b.id }];
      if (circs.length !== 2) return null;
      if (a.kind === "circle" && b.kind === "circle") return [{ type: "equal_radius_cc", c1_id: a.id, c2_id: b.id }];
      if (a.kind === "arc" && b.kind === "arc") return [{ type: "equal_radius_aa", a1_id: a.id, a2_id: b.id }];
      const circle = a.kind === "circle" ? a : b, arc = a.kind === "arc" ? a : b;
      return [{ type: "equal_radius_ca", c1_id: circle.id, a2_id: arc.id }];
    }
    case "midpoint": {
      if (r.length !== 2 || points.length !== 1 || lines.length !== 1) return null;
      return [{ type: "point_on_line_pl", p_id: points[0].id, l_id: lines[0].id }, { type: "point_on_perp_bisector_pl", p_id: points[0].id, l_id: lines[0].id }];
    }
    case "concentric": {
      if (r.length !== 2 || circs.length !== 2) return null;
      const c1 = circs[0].e.center, c2 = circs[1].e.center;
      return c1 === c2 ? [] : [{ type: "p2p_coincident", p1_id: c1, p2_id: c2 }];
    }
    case "symmetric": {
      if (r.length !== 3 || !d) return null;
      if (points.length === 2 && lines.length === 1) return [{ type: "p2p_symmetric_ppl", p1_id: points[0].id, p2_id: points[1].id, l_id: lines[0].id }];
      if (points.length === 3) return [{ type: "p2p_symmetric_ppp", p1_id: a.id, p2_id: b.id, p_id: d.id }];
      return null;
    }
    case "tangent": return r.length === 2 ? tangent(a, b) : null;
    case "fix": {
      const out: any[] = [];
      for (const x of r) {
        const pts = x.kind === "point" ? [x.id] : x.kind === "line" ? [x.e.a, x.e.b] : x.kind === "circle" ? [x.e.center] : x.kind === "curve" ? pointsOf(x.e) : [x.e.center, x.e.start, x.e.end];
        for (const pid of pts) {
          if (pid === ORIGIN) continue;
          const p = (data.entities[pid] as { x: number; y: number });
          out.push({ type: "coordinate_x", p_id: pid, x: p.x }, { type: "coordinate_y", p_id: pid, y: p.y });
        }
        if (x.kind === "circle") out.push({ type: "circle_radius", c_id: x.id, radius: x.r });
        if (x.kind === "curve" && (x.e.type === "ellipse" || x.e.type === "ellipticalArc") && have.has(x.id)) out.push({ type: "equal", param1: { o_id: x.id, prop: "radmin" }, param2: Number(x.e.minor) });
      }
      return out;
    }
    case "distance": {
      if (value === null || value < 0) return null;
      const axis = c.axis === "x" || c.axis === "y" ? c.axis : null;
      let p1: { id: string; p: Vec2 } | null = null, p2: { id: string; p: Vec2 } | null = null;
      if (r.length === 1 && a.kind === "line") { p1 = { id: a.e.a, p: a.a }; p2 = { id: a.e.b, p: a.b }; }
      else if (r.length === 2 && points.length === 2) { p1 = points[0]; p2 = points[1]; }
      if (p1 && p2) {
        if (p1.id === p2.id) return null;
        if (!axis) return [{ type: "p2p_distance", p1_id: p1.id, p2_id: p2.id, distance: value }];
        // a horizontal or vertical distance keeps the side the second point is on now
        const i = axis === "x" ? 0 : 1, sign = p2.p[i] - p1.p[i] < 0 ? -1 : 1;
        return [{ type: "difference", param1: { o_id: p1.id, prop: axis }, param2: { o_id: p2.id, prop: axis }, difference: sign * value }];
      }
      if (r.length === 2 && points.length === 1 && lines.length === 1) return curveUses(lines[0], points[0].id) ? null : [{ type: "p2l_distance", p_id: points[0].id, l_id: lines[0].id, distance: value }];
      if (r.length === 2 && lines.length === 2) return [{ type: "p2l_distance", p_id: lines[1].e.a, l_id: lines[0].id, distance: value }];
      return null;
    }
    case "radius": case "diameter": {
      if (value === null || !(value > 0) || r.length !== 1 || !isCirc(a)) return null;
      if (a.kind === "circle") return [c.type === "radius" ? { type: "circle_radius", c_id: a.id, radius: value } : { type: "circle_diameter", c_id: a.id, diameter: value }];
      return [c.type === "radius" ? { type: "arc_radius", a_id: a.id, radius: value } : { type: "arc_diameter", a_id: a.id, diameter: value }];
    }
    case "angle": {
      if (value === null || r.length !== 2 || lines.length !== 2) return null;
      const f = angleFrame(lines[0], lines[1]);
      return [{ type: "l2l_angle_pppp", l1p1_id: f.p[0], l1p2_id: f.p[1], l2p1_id: f.p[2], l2p2_id: f.p[3], angle: (f.angle < 0 ? -1 : 1) * value * DEG }];
    }
  }
  return null;
}

function curveUses(curve: Resolved, pointId: string): boolean {
  if (curve.kind === "line") return curve.e.a === pointId || curve.e.b === pointId;
  if (curve.kind === "arc") return curve.e.start === pointId || curve.e.end === pointId;
  if (curve.kind === "curve") { const en = endsOf(curve.e); return !!en && en.includes(pointId); }
  return false;
}

type Free = Extract<Resolved, { kind: "curve" }>;
/** An ellipse or a partial ellipse: a curve the solver holds as a primitive. */
const isEllipse = (x: Resolved): x is Free => x.kind === "curve" && (x.e.type === "ellipse" || x.e.type === "ellipticalArc");

/** The end points of an open curve (a line, an arc, an open free-form curve). */
function ends(x: Resolved): { id: string; p: Vec2 }[] {
  if (x.kind === "line") return [{ id: x.e.a, p: x.a }, { id: x.e.b, p: x.b }];
  if (x.kind === "arc") return [{ id: x.e.start, p: x.s }, { id: x.e.end, p: x.en }];
  if (x.kind === "curve") {
    const en = endsOf(x.e), pc = x.pieces[0];
    if (!en || x.pieces.length !== 1) return [];
    return [{ id: en[0], p: pieceAt(pc, pc.t0) }, { id: en[1], p: pieceAt(pc, pc.t1) }];
  }
  return [];
}
/** The direction a curve runs at a point of it: a line from a to b, a circle or arc counter-clockwise. */
function tangentAt(x: Resolved, p: Vec2): Vec2 {
  if (x.kind === "line") return [x.b[0] - x.a[0], x.b[1] - x.a[1]];
  if (isCirc(x)) return [-(p[1] - x.c[1]), p[0] - x.c[0]];
  if (x.kind === "curve") { const pc = x.pieces[0], n = nearestOnPiece(pc, p); return pieceTangent(pc, n.t); }
  return [1, 0];
}

/** Two curves' shared end: the point where one ends on the other. */
function sharedEnd(a: Resolved, b: Resolved): { id: string; p: Vec2 } | null {
  for (const ea of ends(a)) for (const eb of ends(b)) if (ea.id === eb.id || dist(ea.p, eb.p) <= 1e-7) return ea;
  return null;
}

/**
 * Tangency where a spline, Bézier curve or conic ends: the curve's second control point (or its handle) lies
 * on the line, square to the radius of the arc, or in line with the other curve's.
 */
function freeTangent(f: Free, other: Resolved): any[] | null {
  const at = sharedEnd(f, other); if (!at) return null;
  const h = directionPoint(f.e, at.id); if (!h) return null;
  if (other.kind === "line") return [{ type: "point_on_line_pl", p_id: h, l_id: other.id }];
  if (isCirc(other)) return [{ type: "perpendicular_pppp", l1p1_id: other.e.center, l1p2_id: at.id, l2p1_id: at.id, l2p2_id: h }];
  if (other.kind === "curve" && !isEllipse(other)) { const h2 = directionPoint((other as Free).e, at.id); return h2 ? [{ type: "point_on_line_ppp", p_id: h2, lp1_id: at.id, lp2_id: h }] : null; }
  return null;
}

/** A line square to a curve: through a circle's centre, or square to the curve where it ends on it. */
function normal(a: Resolved, b: Resolved): any[] | null {
  const line = a.kind === "line" ? a : b.kind === "line" ? b : null;
  const other = line === a ? b : a;
  if (!line || other.kind === "point") return null;
  if (other.kind === "line") return [{ type: "perpendicular_ll", l1_id: line.id, l2_id: other.id }];
  if (isCirc(other)) return [{ type: "point_on_line_pl", p_id: other.e.center, l_id: line.id }];
  if (isEllipse(other)) {
    const pc = other.pieces[0], ea = nearestOnPiece(pc, line.a).d, eb = nearestOnPiece(pc, line.b).d;
    const pid = ea <= eb ? line.e.a : line.e.b;
    const out: any[] = [{ type: "angle_via_point", crv1_id: line.id, crv2_id: other.id, p_id: pid, angle: Math.PI / 2 }];
    if (!curveUses(other, pid)) out.unshift({ type: "point_on_ellipse", p_id: pid, e_id: other.id });
    return out;
  }
  const f = other as Free, at = sharedEnd(line, f), h = at && directionPoint(f.e, at.id);
  return at && h ? [{ type: "perpendicular_pppp", l1p1_id: line.e.a, l1p2_id: line.e.b, l2p1_id: at.id, l2p2_id: h }] : null;
}

/**
 * Curvature continuity (G2) where a control-point spline, Bézier curve or conic ends on a line (its second and
 * third control points lie on the line), or where two Bézier curves of one degree meet (C2: the ends' first
 * and second derivatives agree, held through two points of the solver's own).
 */
function curvature(data: SketchData, cid: string, a: Resolved, b: Resolved): any[] | null {
  const free = a.kind === "curve" ? a : b.kind === "curve" ? b : null;
  if (!free) return null;
  const other = free === a ? b : a;
  const at = sharedEnd(free, other); if (!at) return null;
  const h1 = directionPoint(free.e, at.id), h2 = curvaturePoint(free.e, at.id);
  if (other.kind === "line") {
    if (!h1) return null;
    const out: any[] = [{ type: "point_on_line_pl", p_id: h1, l_id: other.id }];
    if (h2) out.push({ type: "point_on_line_pl", p_id: h2, l_id: other.id });
    else if (free.e.type !== "conic") return null;
    return out;
  }
  if (other.kind === "curve" && other.e.type === "bspline" && free.e.type === "bspline") {
    const k1 = directionPoint(other.e, at.id), k2 = curvaturePoint(other.e, at.id);
    const n1 = ((free.e.poles || []) as string[]).length, n2 = ((other.e.poles || []) as string[]).length;
    if (!h1 || !h2 || !k1 || !k2 || n1 !== n2 || free.e.degree !== other.e.degree || free.e.degree !== n1 - 1) return null;
    const P = pointAt(data, at.id)!, A1 = pointAt(data, h1)!, B2 = pointAt(data, k2)!;
    return [
      { type: "$point", pid: cid + "$x", x: 2 * A1[0] - P[0], y: 2 * A1[1] - P[1] },
      { type: "$point", pid: cid + "$v", x: 2 * P[0] - B2[0], y: 2 * P[1] - B2[1] },
      { type: "p2p_symmetric_ppp", p1_id: h1, p2_id: k1, p_id: at.id },
      { type: "p2p_symmetric_ppp", p1_id: at.id, p2_id: cid + "$x", p_id: h1 },
      { type: "p2p_symmetric_ppp", p1_id: k2, p2_id: cid + "$v", p_id: at.id },
      { type: "p2p_symmetric_ppp", p1_id: h2, p2_id: cid + "$v", p_id: cid + "$x" },
    ];
  }
  return null;
}

function tangent(a: Resolved, b: Resolved): any[] | null {
  if (a.kind === "point" || b.kind === "point") return null;
  if (a.kind === "curve" && !isEllipse(a)) return freeTangent(a, b);
  if (b.kind === "curve" && !isEllipse(b)) return freeTangent(b, a);
  if (isEllipse(a) || isEllipse(b)) {
    const at = sharedEnd(a, b);
    if (at) {
      const ta = tangentAt(a, at.p), tb = tangentAt(b, at.p);
      return [{ type: "angle_via_point", crv1_id: a.id, crv2_id: b.id, p_id: at.id, angle: ta[0] * tb[0] + ta[1] * tb[1] >= 0 ? 0 : Math.PI }];
    }
    const e = isEllipse(a) ? a : b, o = e === a ? b : a;
    if (o.kind === "line") return [{ type: "tangent_le", l_id: o.id, e_id: e.id }];
    return null;
  }
  if (a.kind === "line" && b.kind === "line") return null;
  // Two curves that end on the same point are tangent *there*: the angle between them at that point is 0 or π,
  // whichever they are nearer now.  (Tangency of the whole curves has a second answer on the far side of the
  // circle, and the solver would be free to jump to it.)
  for (const ea of ends(a)) for (const eb of ends(b)) {
    if (ea.id !== eb.id && dist(ea.p, eb.p) > 1e-7) continue;
    const ta = tangentAt(a, ea.p), tb = tangentAt(b, ea.p);
    const along = ta[0] * tb[0] + ta[1] * tb[1] >= 0;
    return [{ type: "angle_via_point", crv1_id: a.id, crv2_id: b.id, p_id: ea.id, angle: along ? 0 : Math.PI }];
  }
  const line = a.kind === "line" ? a : b.kind === "line" ? b : null;
  if (line) {
    const other = line === a ? b : a;
    return [other.kind === "circle" ? { type: "tangent_lc", l_id: line.id, c_id: other.id } : { type: "tangent_la", l_id: line.id, a_id: other.id }];
  }
  if (a.kind === "circle" && b.kind === "circle") return [{ type: "tangent_cc", c1_id: a.id, c2_id: b.id }];
  if (a.kind === "arc" && b.kind === "arc") return [{ type: "tangent_aa", a1_id: a.id, a2_id: b.id }];
  const circle = a.kind === "circle" ? a : b, arc = a.kind === "arc" ? a : b;
  return [{ type: "tangent_ca", c_id: circle.id, a_id: arc.id }];
}
