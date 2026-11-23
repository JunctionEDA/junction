// pcb-tools/constraint-adapter.ts — BOARD_CONSTRAINT_ADAPTER (pcbnew/constraints/board_constraint_adapter.cpp): a
// cluster of shapes, dimensions and pads and the constraints between them translated into a planegcs system in a
// millimetre frame centred on the first item, solved (stabilised, dragged, after a resize), written back (shapes, a
// dimension's feature points, a rigid footprint moved whole), the reference values re-measured, and diagnosed (free
// degrees of freedom, conflicting / redundant constraints).  Below it the cluster functions the tools call:
// SolveCluster, ApplyConstraintImmediately, ReSolveShapeClusters, ReSolveShapeClustersHoldingEdited,
// ReSolveAfterShapeResize and DiagnoseBoardConstraints.
import type { Pt } from "./types";
import { Arc, ArcOfEllipse, Circle, DefaultTemporaryConstraint, Ellipse, Line, Param, Point, SolveStatus, System } from "./planegcs";
import { CBoard, type CItem, type CMember, type PcbConstraint, anchorPosition, arcAngleDeg, constraintItemIsLocked, isConstrainable, itemAnchors, measureCornerAngle, member, sameMember } from "./pcb-constraint";
import { dimKnee, dimRead, dimUpdate, dimWrite } from "./dimensions";
import { translateNode } from "./transforms";
import { K } from "./state";

const IU_PER_NORM_UNIT = 1e6;
/** Bound the solver so an interactive solve can never stall the page. */
const MAX_SOLVE_ITERATIONS = 100;
/** The stay-put pins are kept far weaker than a real drive or the cursor so they only fill the null space. */
const STAY_PUT_WEIGHT = 1e-4;

/** CONSTRAINT_DIAGNOSIS. */
export interface ConstraintDiagnosis { solved: boolean; freeDof: number; conflicting: string[]; redundant: string[] }
export type ConstraintState = "unconstrained" | "under" | "well" | "over";
/** BOARD_CONSTRAINT_DIAGNOSTICS. */
export interface BoardConstraintDiagnostics { totalFreeDof: number; shapeStates: Map<string, ConstraintState>; conflicting: string[]; redundant: string[]; errored: string[] }
const emptyDiagnosis = (): ConstraintDiagnosis => ({ solved: false, freeDof: -1, conflicting: [], redundant: [] });
export const isOverConstrained = (d: ConstraintDiagnosis): boolean => d.conflicting.length > 0;
/** CONSTRAINT_BLOCK_RESULT. */
export type BlockSolveResult = "solved" | "refused" | "not_modeled";

type Kind = "SEGMENT" | "BEZIER" | "CIRCLE" | "ARC" | "ELLIPSE" | "ELLIPSE_ARC" | "POINT_PAIR" | "RECTANGLE" | "POLYGON" | "PAD_CENTER";
interface ShapeVars {
  item: CItem; kind: Kind; startX: number; endX: number; radius: number; focusX: number; arcStartX: number; arcEndX: number; startAngle: number; endAngle: number;
  fixedLengthParam: number; vertexCount: number; startIsLeft: boolean; startIsTop: boolean;
}
interface AnchorParams { x: number; y: number }
const valid = (a: AnchorParams): boolean => a.x >= 0 && a.y >= 0;
const NONE: AnchorParams = { x: -1, y: -1 };
interface RigidFootprint { fp: string; buildPosition: Pt; translationX: number }

const isDegenerateLine = (l: Line): boolean => Math.hypot(l.p2.x.v - l.p1.x.v, l.p2.y.v - l.p1.y.v) < 1e-9;
/** std::remainder. */
function remainder(x: number, y: number): number {
  const q = x / y; const n = Math.abs(q - Math.trunc(q)) === 0.5 ? 2 * Math.round(q / 2) : Math.round(q);   // the quotient rounded half to even
  return x - n * y;
}
/** The directed l1 -> l2 angle that realises the stored corner angle nearest the present geometry (directedAngleForCorner). */
function directedAngleForCorner(l1: Line, l2: Line, cornerDeg: number): number {
  const ax = [l1.p1.x.v, l1.p2.x.v], ay = [l1.p1.y.v, l1.p2.y.v], bx = [l2.p1.x.v, l2.p2.x.v], by = [l2.p1.y.v, l2.p2.y.v];
  let vA = 0, vB = 0, best = Number.MAX_VALUE;
  for (let i = 0; i < 2; ++i) for (let j = 0; j < 2; ++j) { const d = Math.hypot(ax[i] - bx[j], ay[i] - by[j]); if (d < best) { best = d; vA = i; vB = j; } }
  const d1x = ax[1] - ax[0], d1y = ay[1] - ay[0], d2x = bx[1] - bx[0], d2y = by[1] - by[0];
  const theta = Math.atan2(d1x * d2y - d1y * d2x, d1x * d2x + d1y * d2y);
  const alpha = Math.abs(remainder(cornerDeg * Math.PI / 180, 2 * Math.PI)), shift = (vB - vA) * Math.PI;
  const c1 = alpha - shift, c2 = -alpha - shift;
  return Math.abs(remainder(theta - c1, 2 * Math.PI)) <= Math.abs(remainder(theta - c2, 2 * Math.PI)) ? c1 : c2;
}
/** The arc's swept-angle target nearest the current endpoint separation (arcSweepTarget). */
function arcSweepTarget(startAngle: number, endAngle: number, sweepDeg: number): number {
  const current = endAngle - startAngle, alpha = Math.abs(sweepDeg) * Math.PI / 180;
  return current - remainder(current - alpha, 2 * Math.PI);
}
const ptEq = (a: Pt, b: Pt): boolean => a[0] === b[0] && a[1] === b[1];
const mm = (v: number): number => { const x = +(v / IU_PER_NORM_UNIT).toFixed(6); return x === 0 ? 0 : x; };

/** BOARD_CONSTRAINT_ADAPTER. */
export class ConstraintAdapter {
  private board: CBoard; private gcs = new System(); private P: Param[] = [];
  private vars = new Map<string, ShapeVars>(); private fixed = new Set<number>(); private grounded = new Set<number>();
  private tagToConstraint = new Map<number, string>(); private droppedTags = new Set<number>(); private nonDrivingTags = new Set<number>(); private tagMembers = new Map<number, string[]>();
  private referenceConstraints: PcbConstraint[] = []; unmapped: string[] = []; private rigid: RigidFootprint[] = []; private rigidMembers = new Set<string>();
  private angleConstrained = new Set<string>(); private ox = 0; private oy = 0; private scale = IU_PER_NORM_UNIT; private inv = 1 / IU_PER_NORM_UNIT;
  private dragX = -1; private dragY = -1; private coDragX = -1; private coDragY = -1; private temps: number[] = []; private nextTemp = 0;
  private lengthHoldTag = -1; private resizeRadiusTag = -1; private built = false;
  constructor(board: CBoard) { this.board = board; }

  private push(v: number): number { this.P.push(new Param(v)); return this.P.length - 1; }
  private temporaryParam(v: number): number { if (this.nextTemp === this.temps.length) this.temps.push(this.push(v)); const i = this.temps[this.nextTemp++]; this.P[i].v = v; return i; }
  private nx(v: number): number { return (v - this.ox) * this.inv; }
  private ny(v: number): number { return (v - this.oy) * this.inv; }
  private dx(v: number): number { return v * this.scale + this.ox; }
  private dy(v: number): number { return v * this.scale + this.oy; }
  private pt(x: number): Point { return new Point(this.P[x], this.P[x + 1]); }
  private ptFor(a: AnchorParams): Point { return new Point(this.P[a.x], this.P[a.y]); }
  /** The vars in KIID order (std::map<KIID, SHAPE_VARS>). */
  private sorted(): [string, ShapeVars][] { return [...this.vars.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); }

  /** Build: the cluster's items and constraints as a planegcs system; fixedShapes are frozen whole. */
  build(items: CItem[], constraints: PcbConstraint[], fixedShapes: Set<string> | null = null): boolean {
    this.built = false;
    const shapes = items.filter((it) => it.cls === "shape"), dims = items.filter((it) => it.cls === "dim"), pads = items.filter((it) => it.cls === "pad");
    if (!shapes.length && !dims.length && !pads.length) return false;
    const origin = shapes.length ? shapes[0].start : dims.length ? dims[0].start : pads[0].center;
    this.ox = origin[0]; this.oy = origin[1];
    const lockedRanges: [number, number][] = [], ellipseOffsets: number[] = [];
    const blankVars = (item: CItem, kind: Kind): ShapeVars => ({ item, kind, startX: -1, endX: -1, radius: -1, focusX: -1, arcStartX: -1, arcEndX: -1, startAngle: -1, endAngle: -1, fixedLengthParam: -1, vertexCount: 0, startIsLeft: true, startIsTop: true });
    for (const s of shapes) {
      const first = this.P.length; let v: ShapeVars;
      if (s.shape === "segment" || s.shape === "bezier") {
        v = blankVars(s, s.shape === "segment" ? "SEGMENT" : "BEZIER");
        v.startX = this.push(this.nx(s.start[0])); this.push(this.ny(s.start[1])); v.endX = this.push(this.nx(s.end[0])); this.push(this.ny(s.end[1]));
      } else if (s.shape === "rect") {
        v = blankVars(s, "RECTANGLE"); v.startIsLeft = s.start[0] <= s.end[0]; v.startIsTop = s.start[1] <= s.end[1];
        v.startX = this.push(this.nx(s.start[0])); this.push(this.ny(s.start[1])); v.endX = this.push(this.nx(s.end[0])); this.push(this.ny(s.end[1]));
      } else if (s.shape === "poly") {
        if (!s.pts.length) continue;
        v = blankVars(s, "POLYGON"); v.vertexCount = s.pts.length;
        v.startX = this.push(this.nx(s.pts[0][0])); this.push(this.ny(s.pts[0][1]));
        for (let i = 1; i < s.pts.length; ++i) { this.push(this.nx(s.pts[i][0])); this.push(this.ny(s.pts[i][1])); }
      } else if (s.shape === "circle") {
        v = blankVars(s, "CIRCLE"); v.startX = this.push(this.nx(s.center[0])); this.push(this.ny(s.center[1])); v.radius = this.push(s.radius * this.inv);
      } else if (s.shape === "arc") {
        v = blankVars(s, "ARC");
        const cx = this.nx(s.center[0]), cy = this.ny(s.center[1]), sx = this.nx(s.start[0]), sy = this.ny(s.start[1]), ex = this.nx(s.end[0]), ey = this.ny(s.end[1]);
        v.startX = this.push(cx); this.push(cy); v.radius = this.push(s.radius * this.inv);
        v.arcStartX = this.push(sx); this.push(sy); v.arcEndX = this.push(ex); this.push(ey);
        v.startAngle = this.push(Math.atan2(sy - cy, sx - cx)); v.endAngle = this.push(Math.atan2(ey - cy, ex - cx));
        this.gcs.addConstraintArcRules(new Arc(this.pt(v.startX), this.P[v.radius], this.pt(v.arcStartX), this.pt(v.arcEndX), this.P[v.startAngle], this.P[v.endAngle]));
      } else if ((s.shape === "ellipse" || s.shape === "ellipse_arc") && s.ell) {
        v = blankVars(s, s.shape === "ellipse" ? "ELLIPSE" : "ELLIPSE_ARC");
        let major = s.ell.major, minor = s.ell.minor, phi = s.ell.rotation * Math.PI / 180, sa = s.ell.start, ea = s.ell.end;
        if (minor > major) { [major, minor] = [minor, major]; phi += Math.PI / 2; sa -= 90; ea -= 90; }
        const focal = Math.sqrt(major * major - minor * minor), cx = this.nx(s.ell.cx), cy = this.ny(s.ell.cy);
        v.startX = this.push(cx); this.push(cy);
        v.focusX = this.push(cx + focal * this.inv * Math.cos(phi)); this.push(cy + focal * this.inv * Math.sin(phi));
        v.radius = this.push(minor * this.inv);
        const offX = this.push(focal * this.inv * Math.cos(phi)), offY = this.push(focal * this.inv * Math.sin(phi)); ellipseOffsets.push(offX, offY);
        this.gcs.addConstraintDifference(this.P[v.startX], this.P[v.focusX], this.P[offX]);
        this.gcs.addConstraintDifference(this.P[v.startX + 1], this.P[v.focusX + 1], this.P[offY]);
        if (v.kind === "ELLIPSE_ARC") {
          v.arcStartX = this.push(this.nx(s.start[0])); this.push(this.ny(s.start[1])); v.arcEndX = this.push(this.nx(s.end[0])); this.push(this.ny(s.end[1]));
          v.startAngle = this.push(sa * Math.PI / 180); v.endAngle = this.push(ea * Math.PI / 180);
          this.gcs.addConstraintArcOfEllipseRules(new ArcOfEllipse(this.pt(v.startX), this.pt(v.focusX), this.P[v.radius], this.pt(v.arcStartX), this.pt(v.arcEndX), this.P[v.startAngle], this.P[v.endAngle]));
        }
      } else continue;   // other shapes are not mapped
      if (constraintItemIsLocked(s) || (fixedShapes && fixedShapes.has(s.id))) lockedRanges.push([first, this.P.length]);
      this.vars.set(s.id, v);
    }
    for (const d of dims) {
      const v = blankVars(d, "POINT_PAIR"); v.startX = this.push(this.nx(d.start[0])); this.push(this.ny(d.start[1]));
      if (d.dimType === "aligned" || d.dimType === "orthogonal" || d.dimType === "radial") { v.endX = this.push(this.nx(d.end[0])); this.push(this.ny(d.end[1])); }
      this.vars.set(d.id, v);
    }
    for (const p of pads) { const v = blankVars(p, "PAD_CENTER"); v.startX = this.push(this.nx(p.center[0])); this.push(this.ny(p.center[1])); this.vars.set(p.id, v); }
    const fixed = new Set<number>(), grounded = new Set<number>();
    for (const [a, b] of lockedRanges) for (let i = a; i < b; ++i) fixed.add(i);
    for (const i of ellipseOffsets) fixed.add(i);
    const footprints = new Set<string>(); for (const [, v] of this.sorted()) if (v.item.fp) footprints.add(v.item.fp);
    this.coupleRigidFootprints([...footprints].sort(), fixedShapes, fixed);
    const lineFor = (m: CMember): Line | null => { const v = this.vars.get(m.item); return v && v.kind === "SEGMENT" && m.anchor === "whole" ? new Line(this.pt(v.startX), this.pt(v.endX)) : null; };
    const circleFor = (m: CMember): Circle | null => { const v = this.vars.get(m.item); return v && (v.kind === "CIRCLE" || v.kind === "ARC") ? new Circle(this.pt(v.startX), this.P[v.radius]) : null; };
    const ellipseFor = (m: CMember): Ellipse | null => { const v = this.vars.get(m.item); return v && (v.kind === "ELLIPSE" || v.kind === "ELLIPSE_ARC") ? new Ellipse(this.pt(v.startX), this.pt(v.focusX), this.P[v.radius]) : null; };
    const pushConstant = (iuValue: number): number => { const i = this.push(iuValue * this.inv); fixed.add(i); return i; };
    let tag = 1;
    for (const c of constraints) {
      const ms = c.members; let mapped = false; const g = this.gcs;
      switch (c.type) {
        case "parallel": { const l1 = ms.length === 2 ? lineFor(ms[0]) : null, l2 = ms.length === 2 ? lineFor(ms[1]) : null; if (l1 && l2) { g.addConstraintParallel(l1, l2, tag); mapped = true; } break; }
        case "horizontal": case "vertical": {
          if (ms.length === 1) { const l = lineFor(ms[0]); if (l) { if (c.type === "horizontal") g.addConstraintHorizontal(l, tag); else g.addConstraintVertical(l, tag); mapped = true; } }
          else if (ms.length === 2) { const a = this.anchorParams(ms[0]), b = this.anchorParams(ms[1]); if (valid(a) && valid(b)) { if (c.type === "horizontal") g.addConstraintHorizontalPts(this.ptFor(a), this.ptFor(b), tag); else g.addConstraintVerticalPts(this.ptFor(a), this.ptFor(b), tag); mapped = true; } }
          break;
        }
        case "coincident": { const a = ms.length === 2 ? this.anchorParams(ms[0]) : NONE, b = ms.length === 2 ? this.anchorParams(ms[1]) : NONE; if (valid(a) && valid(b)) { g.addConstraintP2PCoincident(this.ptFor(a), this.ptFor(b), tag); mapped = true; } break; }
        case "fixed_position": { const a = ms.length === 1 ? this.anchorParams(ms[0]) : NONE; if (valid(a)) { fixed.add(a.x); fixed.add(a.y); grounded.add(a.x); grounded.add(a.y); mapped = true; } break; }
        case "perpendicular": { const l1 = ms.length === 2 ? lineFor(ms[0]) : null, l2 = ms.length === 2 ? lineFor(ms[1]) : null; if (l1 && l2) { g.addConstraintPerpendicular(l1, l2, tag); mapped = true; } break; }
        case "equal_length": { const l1 = ms.length === 2 ? lineFor(ms[0]) : null, l2 = ms.length === 2 ? lineFor(ms[1]) : null; if (l1 && l2) { g.addConstraintEqualLength(l1, l2, tag); mapped = true; } break; }
        case "point_on_line": {
          const p = ms.length === 2 ? this.anchorParams(ms[0]) : NONE; if (!valid(p)) break;
          const l = lineFor(ms[1]); if (l) { g.addConstraintPointOnLine(this.ptFor(p), l, tag); mapped = true; break; }
          const ci = circleFor(ms[1]); if (ci) { g.addConstraintPointOnCircle(this.ptFor(p), ci, tag); mapped = true; break; }
          const e = ellipseFor(ms[1]); if (e) { g.addConstraintPointOnEllipse(this.ptFor(p), e, tag); mapped = true; }
          break;
        }
        case "midpoint": { const p = ms.length === 2 ? this.anchorParams(ms[0]) : NONE; const seg = valid(p) ? lineFor(ms[1]) : null; if (seg) { g.addConstraintP2PSymmetricPoint(seg.p1, seg.p2, this.ptFor(p), tag); mapped = true; } break; }
        case "collinear": { const l1 = ms.length === 2 ? lineFor(ms[0]) : null, l2 = ms.length === 2 ? lineFor(ms[1]) : null; if (l1 && l2) { g.addConstraintPointOnLine(l2.p1, l1, tag); g.addConstraintPointOnLine(l2.p2, l1, tag); mapped = true; } break; }
        case "symmetric": {
          const a = ms.length === 3 ? this.anchorParams(ms[0]) : NONE, b = ms.length === 3 ? this.anchorParams(ms[1]) : NONE; const axis = valid(a) && valid(b) ? lineFor(ms[2]) : null;
          if (axis) { g.addConstraintP2PSymmetricLine(this.ptFor(a), this.ptFor(b), axis, tag); mapped = true; } break;
        }
        case "fixed_length": {
          if (c.value === null) break;
          const l = ms.length === 1 ? lineFor(ms[0]) : null;
          if (l) {
            const len = pushConstant(c.value); g.addConstraintP2PDistance(l.p1, l.p2, this.P[len], tag, c.driving); this.recordReferenceValue(c);
            if (c.driving) { const v = this.vars.get(ms[0].item); if (v) v.fixedLengthParam = len; }
            mapped = true;
          } else if (ms.length === 2) {
            const a = this.anchorParams(ms[0]), b = this.anchorParams(ms[1]);
            if (valid(a) && valid(b)) {
              const ortho = this.orthogonalDimensionForMembers(ms);
              if (ortho) {
                const aAxis = ortho.horizontal ? a.x : a.y, bAxis = ortho.horizontal ? b.x : b.y, gap = this.P[bAxis].v - this.P[aAxis].v;
                const len = pushConstant((gap >= 0 ? 1 : -1) * c.value); g.addConstraintDifference(this.P[aAxis], this.P[bAxis], this.P[len], tag, c.driving);
              } else { const len = pushConstant(c.value); g.addConstraintP2PDistance(this.ptFor(a), this.ptFor(b), this.P[len], tag, c.driving); }
              this.recordReferenceValue(c); mapped = true;
            }
          }
          break;
        }
        case "fixed_radius": { const ci = ms.length === 1 && c.value !== null ? circleFor(ms[0]) : null; if (ci) { const rad = pushConstant(c.value!); g.addConstraintCircleRadius(ci, this.P[rad], tag, c.driving); this.recordReferenceValue(c); mapped = true; } break; }
        case "equal_radius": { const c1 = ms.length === 2 ? circleFor(ms[0]) : null, c2 = ms.length === 2 ? circleFor(ms[1]) : null; if (c1 && c2) { g.addConstraintEqualRadius(c1, c2, tag); mapped = true; } break; }
        case "concentric": {
          const centerOf = (m: CMember): Point | null => { const ci = circleFor(m); if (ci) return ci.center; const e = ellipseFor(m); return e ? e.center : null; };
          const p1 = ms.length === 2 ? centerOf(ms[0]) : null, p2 = ms.length === 2 ? centerOf(ms[1]) : null;
          if (p1 && p2) { g.addConstraintP2PCoincident(p1, p2, tag); mapped = true; } break;
        }
        case "angular_dimension": {
          const l1 = ms.length === 2 && c.value !== null ? lineFor(ms[0]) : null, l2 = l1 ? lineFor(ms[1]) : null;
          if (l1 && l2 && !isDegenerateLine(l1) && !isDegenerateLine(l2)) {
            const angle = this.push(directedAngleForCorner(l1, l2, c.value!)); fixed.add(angle);
            g.addConstraintL2LAngle(l1, l2, this.P[angle], tag, c.driving); this.recordReferenceValue(c); mapped = true;
          }
          break;
        }
        case "arc_angle": {
          const v = ms.length === 1 ? this.vars.get(ms[0].item) : undefined; const validSweep = c.value !== null && c.value > 0 && c.value < 360;
          if (v && v.kind === "ARC" && validSweep) {
            const tgt = this.push(arcSweepTarget(this.P[v.startAngle].v, this.P[v.endAngle].v, c.value!)); fixed.add(tgt);
            g.addConstraintDifference(this.P[v.startAngle], this.P[v.endAngle], this.P[tgt], tag, c.driving); this.recordReferenceValue(c); mapped = true;
          }
          break;
        }
        case "tangent": {
          if (ms.length !== 2) break;
          const la = lineFor(ms[0]), lb = la ? null : lineFor(ms[1]); const l = la || lb;
          if (l) {
            const other = ms[la ? 1 : 0]; const c1 = circleFor(other);
            if (c1) { const ddx = l.p2.x.v - l.p1.x.v, ddy = l.p2.y.v - l.p1.y.v, cross = ddx * (c1.center.y.v - l.p1.y.v) - ddy * (c1.center.x.v - l.p1.x.v); g.addConstraintTangentLineCircle(l, c1, cross > 0, tag); mapped = true; }
            else { const e = ellipseFor(other); if (e) { g.addConstraintTangentLineEllipse(l, e, tag); mapped = true; } }
          } else { const c1 = circleFor(ms[0]), c2 = circleFor(ms[1]); if (c1 && c2) { g.addConstraintTangentCircles(c1, c2, tag); mapped = true; } }
          break;
        }
        default: break;
      }
      if (!mapped) { this.unmapped.push(c.id); continue; }
      if (c.type !== "fixed_position") this.tagToConstraint.set(tag, c.id);
      if (!c.driving) this.nonDrivingTags.add(tag);
      this.tagMembers.set(tag, c.members.map((m) => m.item));
      const angular = ((c.type === "horizontal" || c.type === "vertical") && c.members.length === 1) || c.type === "parallel" || c.type === "perpendicular" || c.type === "collinear" || c.type === "angular_dimension" || c.type === "arc_angle";
      if (angular) for (const m of c.members) this.angleConstrained.add(m.item);
      tag++;
    }
    this.lengthHoldTag = tag; this.resizeRadiusTag = tag + 1;
    const unmapped = new Set(this.unmapped), referencedDim = new Set<number>();
    for (const c of constraints) { if (unmapped.has(c.id)) continue; for (const m of c.members) { const v = this.vars.get(m.item); if (v && v.kind === "POINT_PAIR") { const a = this.anchorParams(m); if (valid(a)) referencedDim.add(a.x); } } }
    for (const [id, v] of this.sorted()) {
      if (v.kind === "PAD_CENTER" && !this.rigidMembers.has(id)) { fixed.add(v.startX); fixed.add(v.startX + 1); continue; }
      if (v.kind !== "POINT_PAIR" || this.rigidMembers.has(id)) continue;
      const locked = constraintItemIsLocked(v.item);
      for (const px of [v.startX, v.endX]) if (px >= 0 && (locked || !referencedDim.has(px))) { fixed.add(px); fixed.add(px + 1); }
    }
    const unknowns: Param[] = []; for (let i = 0; i < this.P.length; ++i) if (!fixed.has(i)) unknowns.push(this.P[i]);
    this.fixed = fixed; this.grounded = grounded;
    this.gcs.declareUnknowns(unknowns); this.gcs.initSolution(); this.gcs.maxIter = MAX_SOLVE_ITERATIONS;
    this.dragX = this.push(0); this.dragY = this.push(0); this.coDragX = this.push(0); this.coDragY = this.push(0);
    this.built = true;
    return true;
  }

  private recordReferenceValue(c: PcbConstraint): void { if (!c.driving) this.referenceConstraints.push(c); }
  /** coupleRigidFootprints: a footprint's children share one free translation, or are frozen when any is locked or fixed. */
  private coupleRigidFootprints(fps: string[], fixedShapes: Set<string> | null, fixed: Set<number>): void {
    for (const fp of fps) {
      const children = new Set<string>(); let frozen = false;
      for (const [id, v] of this.sorted()) { if (v.item.fp !== fp) continue; children.add(id); frozen = frozen || constraintItemIsLocked(v.item) || !!(fixedShapes && fixedShapes.has(id)); }
      for (const id of children) this.rigidMembers.add(id);
      const state = this.collectRigidState(children);
      for (const h of state.radii) fixed.add(h.radius);
      if (frozen) { for (const px of state.points) { fixed.add(px); fixed.add(px + 1); } continue; }
      const node = this.board.nodeOf(fp)!; const at = K.atOf(node);
      const body: RigidFootprint = { fp, buildPosition: [Math.round(at[0] * IU_PER_NORM_UNIT), Math.round(at[1] * IU_PER_NORM_UNIT)], translationX: this.push(0) }; this.push(0);
      for (const px of state.points) for (const axis of [0, 1]) {
        const origin = this.push(this.P[px + axis].v); fixed.add(origin);
        this.gcs.addConstraintDifference(this.P[origin], this.P[px + axis], this.P[body.translationX + axis]);
      }
      this.rigid.push(body);
    }
  }
  private collectRigidState(ids: Set<string>): { points: number[]; radii: { centerX: number; radius: number }[] } {
    const points = new Set<number>(), radii: { centerX: number; radius: number }[] = []; const add = (x: number) => { if (x >= 0) points.add(x); };
    for (const id of ids) {
      const v = this.vars.get(id); if (!v) continue;
      switch (v.kind) {
        case "SEGMENT": case "RECTANGLE": case "BEZIER": case "POINT_PAIR": add(v.startX); add(v.endX); break;
        case "CIRCLE": add(v.startX); radii.push({ centerX: v.startX, radius: v.radius }); break;
        case "ELLIPSE": add(v.startX); add(v.focusX); radii.push({ centerX: v.startX, radius: v.radius }); break;
        case "ARC": add(v.startX); add(v.arcStartX); add(v.arcEndX); radii.push({ centerX: v.startX, radius: v.radius }); break;
        case "ELLIPSE_ARC": add(v.startX); add(v.focusX); add(v.arcStartX); add(v.arcEndX); radii.push({ centerX: v.startX, radius: v.radius }); break;
        case "POLYGON": for (let i = 0; i < v.vertexCount; ++i) add(v.startX + 2 * i); break;
        case "PAD_CENTER": add(v.startX); break;
      }
    }
    return { points: [...points].sort((a, b) => a - b), radii };
  }
  private holdRigidRadii(radii: { centerX: number; radius: number }[], tag: number): void {
    for (const h of radii) { const t = this.temporaryParam(this.P[h.radius].v); this.gcs.addConstraintCircleRadius(new Circle(this.pt(h.centerX), this.P[h.radius]), this.P[t], tag); }
  }
  /** anchorParams: the params of a member's anchor (a rectangle corner aliases start / end coordinates). */
  anchorParams(m: CMember): AnchorParams {
    const v = this.vars.get(m.item); if (!v) return NONE;
    const hasEndpoints = v.kind === "SEGMENT" || v.kind === "BEZIER" || v.kind === "POINT_PAIR";
    const pairAt = (x: number): AnchorParams => (x >= 0 ? { x, y: x + 1 } : NONE);
    if (v.kind === "RECTANGLE") {
      if (m.anchor !== "vertex" || m.index < 0 || m.index > 3) return NONE;
      const leftX = v.startIsLeft ? v.startX : v.endX, rightX = v.startIsLeft ? v.endX : v.startX;
      const topY = (v.startIsTop ? v.startX : v.endX) + 1, botY = (v.startIsTop ? v.endX : v.startX) + 1;
      return m.index === 0 ? { x: leftX, y: topY } : m.index === 1 ? { x: rightX, y: topY } : m.index === 2 ? { x: rightX, y: botY } : { x: leftX, y: botY };
    }
    if (v.kind === "POLYGON") return m.anchor !== "vertex" || m.index < 0 || m.index >= v.vertexCount ? NONE : pairAt(v.startX + 2 * m.index);
    switch (m.anchor) {
      case "start": if (v.kind === "ARC" || v.kind === "ELLIPSE_ARC") return pairAt(v.arcStartX); return hasEndpoints ? pairAt(v.startX) : NONE;
      case "end": if (v.kind === "ARC" || v.kind === "ELLIPSE_ARC") return pairAt(v.arcEndX); return hasEndpoints ? pairAt(v.endX) : NONE;
      case "center": return hasEndpoints ? NONE : pairAt(v.startX);
      default: return NONE;
    }
  }
  private orthogonalDimensionForMembers(ms: CMember[]): CItem | null {
    if (ms.length !== 2 || ms[0].item !== ms[1].item) return null;
    const a0 = ms[0].anchor, a1 = ms[1].anchor; if (!((a0 === "start" && a1 === "end") || (a0 === "end" && a1 === "start"))) return null;
    const v = this.vars.get(ms[0].item); return v && v.kind === "POINT_PAIR" && v.item.dimType === "orthogonal" ? v.item : null;
  }

  /** Solve with no drag pin (stabilize holds the free segment lengths and arc radii of angle-constrained shapes). */
  solve(stabilize = false): boolean {
    if (!this.built) return false;
    this.nextTemp = 0;
    if (stabilize) { this.holdFreeSegmentLengths(this.lengthHoldTag, this.angleConstrained); this.holdFreeArcRadii(this.lengthHoldTag, this.angleConstrained); }
    this.pinUneditedShapes(new Set(), DefaultTemporaryConstraint);
    this.gcs.initSolution(); const ret = this.gcs.solve(); this.gcs.applySolution();
    const solved = this.solveSucceeded(ret);
    this.gcs.clearByTag(DefaultTemporaryConstraint); if (stabilize) this.gcs.clearByTag(this.lengthHoldTag);
    return solved;
  }
  /** SolveAfterResize: hold the resized radius and pin its centre, neighbours translate. */
  solveAfterResize(resized: string): boolean {
    if (!this.built) return false;
    this.nextTemp = 0;
    for (const [id, v] of this.sorted()) {
      if (v.radius < 0) continue;
      const target = this.temporaryParam(this.P[v.radius].v); const c = new Circle(this.pt(v.startX), this.P[v.radius]);
      if (id === resized) {
        this.gcs.addConstraintCircleRadius(c, this.P[target], this.resizeRadiusTag, true);
        const cx = this.temporaryParam(this.P[v.startX].v), cy = this.temporaryParam(this.P[v.startX + 1].v);
        this.gcs.addConstraintCoordinateX(c.center, this.P[cx], DefaultTemporaryConstraint); this.gcs.addConstraintCoordinateY(c.center, this.P[cy], DefaultTemporaryConstraint);
      } else this.gcs.addConstraintCircleRadius(c, this.P[target], DefaultTemporaryConstraint);
    }
    this.pinUneditedShapes(new Set([resized]), DefaultTemporaryConstraint); this.holdPolygonVertices(new Set([resized]), DefaultTemporaryConstraint);
    this.gcs.initSolution(); const ret = this.gcs.solve(); this.gcs.applySolution();
    const solved = this.solveSucceeded(ret);
    this.gcs.clearByTag(DefaultTemporaryConstraint); this.gcs.clearByTag(this.resizeRadiusTag);
    return solved;
  }
  /** Solve with an anchor pinned to the cursor (IU); see BOARD_CONSTRAINT_ADAPTER::Solve( aDragged, … ). */
  solveDragged(dragged: CMember, cursor: Pt, stabilize = false, edited: Set<string> = new Set(), coDragged: [CMember, Pt] | null = null, holdDraggedRigid = false): boolean {
    if (!this.built) return false;
    this.nextTemp = 0;
    const params = this.anchorParams(dragged); if (!valid(params)) return false;
    let tx = this.nx(cursor[0]), ty = this.ny(cursor[1]);
    const dv = this.vars.get(dragged.item);
    if (!stabilize && dv && dv.kind === "ARC" && (dragged.anchor === "start" || dragged.anchor === "end")) {
      const ddx = tx - this.P[dv.startX].v, ddy = ty - this.P[dv.startX + 1].v, len = Math.hypot(ddx, ddy);
      if (len > 1e-9) { const r = this.P[dv.radius].v; tx = this.P[dv.startX].v + ddx * r / len; ty = this.P[dv.startX + 1].v + ddy * r / len; }
    }
    if (!stabilize && dv && dv.kind === "SEGMENT" && dv.fixedLengthParam >= 0 && (dragged.anchor === "start" || dragged.anchor === "end")) {
      const farX = dragged.anchor === "start" ? dv.endX : dv.startX, segLen = this.P[dv.fixedLengthParam].v;
      const ddx = tx - this.P[farX].v, ddy = ty - this.P[farX + 1].v, len = Math.hypot(ddx, ddy);
      if (len > 1e-9 && segLen > 1e-9) { tx = this.P[farX].v + ddx * segLen / len; ty = this.P[farX + 1].v + ddy * segLen / len; }
    }
    this.P[this.dragX].v = tx; this.P[this.dragY].v = ty;
    const anchor = this.ptFor(params);
    this.gcs.addConstraintCoordinateX(anchor, this.P[this.dragX], DefaultTemporaryConstraint); this.gcs.addConstraintCoordinateY(anchor, this.P[this.dragY], DefaultTemporaryConstraint);
    let co: CMember | null = null;
    if (coDragged) {
      const cp = this.anchorParams(coDragged[0]);
      if (valid(cp)) {
        co = coDragged[0]; this.P[this.coDragX].v = this.nx(coDragged[1][0]); this.P[this.coDragY].v = this.ny(coDragged[1][1]);
        const ca = this.ptFor(cp); this.gcs.addConstraintCoordinateX(ca, this.P[this.coDragX], DefaultTemporaryConstraint); this.gcs.addConstraintCoordinateY(ca, this.P[this.coDragY], DefaultTemporaryConstraint);
      }
    }
    if (!stabilize) this.pinDraggedShapeRest(dragged, DefaultTemporaryConstraint, co);
    if (stabilize) {
      this.holdFreeSegmentLengths(DefaultTemporaryConstraint, this.angleConstrained); this.holdFreeArcRadii(DefaultTemporaryConstraint, this.angleConstrained);
      if (holdDraggedRigid) this.holdShapesRigid(DefaultTemporaryConstraint, new Set([dragged.item]));
    }
    const editedShapes = new Set(edited); editedShapes.add(dragged.item); if (co) editedShapes.add(co.item);
    this.pinUneditedShapes(editedShapes, DefaultTemporaryConstraint);
    const held = new Set(editedShapes); if (!stabilize) held.delete(dragged.item);
    this.holdPolygonVertices(held, DefaultTemporaryConstraint);
    this.gcs.initSolution(); const ret = this.gcs.solve(); this.gcs.applySolution();
    const solved = this.solveSucceeded(ret);
    this.gcs.clearByTag(DefaultTemporaryConstraint);
    return solved;
  }
  /** Snapshot / Restore (CONSTRAINT_SYSTEM_2D::Snapshot, RestorePrefix): the parameter values, the temporary ones after them left as they are. */
  snapshot(): number[] { return this.P.map((p) => p.v); }
  restore(s: number[]): boolean { if (s.length > this.P.length) return false; for (let i = 0; i < s.length; ++i) this.P[i].v = s[i]; return true; }
  /** TravelsWhole: every shape of the cluster is edited and none is locked, so a translation changes nothing a constraint measures. */
  travelsWhole(edited: Set<string>): boolean { return [...this.vars].every(([id, v]) => edited.has(id) && (v.item.cls === "pad" || !constraintItemIsLocked(v.item))); }
  /** SolveRigidTranslation: the edited shapes travel by `translation` (IU) exactly, the rest of the cluster follows as little as the relations allow. */
  solveRigidTranslation(edited: Set<string>, translation: Pt): boolean {
    if (!this.built || !edited.size) return false;
    const state = this.collectRigidState(edited); if (!state.points.length) return false;
    const movesGrounded = state.points.some((px) => this.fixed.has(px) || this.fixed.has(px + 1));
    if (movesGrounded && (translation[0] || translation[1])) return false;   // a pinned or locked coordinate cannot travel
    const ddx = translation[0] * this.inv, ddy = translation[1] * this.inv; const exact = new Map<number, Pt>();
    for (const px of state.points) { this.P[px].v += ddx; this.P[px + 1].v += ddy; exact.set(px, [Math.round(this.dx(this.P[px].v)), Math.round(this.dy(this.P[px + 1].v))]); }
    if (this.travelsWhole(edited)) return true;   // moving every shape a constraint touches cannot change what it measures
    this.nextTemp = 0;
    for (const px of state.points) this.softPinPoint(px, DefaultTemporaryConstraint);
    this.holdRigidRadii(state.radii, DefaultTemporaryConstraint);
    this.pinUneditedShapes(edited, DefaultTemporaryConstraint);
    this.gcs.initSolution(); const ret = this.gcs.solve(); this.gcs.applySolution();
    let solved = this.solveSucceeded(ret);
    for (const [px, target] of exact) solved = solved && Math.round(this.dx(this.P[px].v)) === target[0] && Math.round(this.dy(this.P[px + 1].v)) === target[1];
    this.gcs.clearByTag(DefaultTemporaryConstraint);
    return solved && this.quantizedRelationsSatisfied();
  }
  /** SolveBlockEdit: the picked anchors held at their targets and the carried shapes at their offset, everything else as still as the relations allow. */
  solveBlockEdit(pinned: [CMember, Pt][], translated: Set<string>, translation: Pt): BlockSolveResult {
    if (!this.built) return "not_modeled";
    const targetsX = new Map<number, number>(), targetsY = new Map<number, number>();
    const carried = this.collectRigidState(translated);
    // a shape travelling whole cannot carry a point the user pinned (a locked one stays placeable: the caller already put it where the user asked)
    if (carried.points.some((px) => this.grounded.has(px) || this.grounded.has(px + 1)) && (translation[0] || translation[1])) return "refused";
    for (const px of carried.points) { targetsX.set(px, Math.round(this.dx(this.P[px].v)) + translation[0]); targetsY.set(px + 1, Math.round(this.dy(this.P[px + 1].v)) + translation[1]); }
    let groundedAnchorPicked = false;
    for (const [m, target] of pinned) {
      const a = this.anchorParams(m); if (!valid(a)) continue;   // an anchor the cluster does not model is skipped
      if (this.grounded.has(a.x)) groundedAnchorPicked = true; else targetsX.set(a.x, target[0]);
      if (this.grounded.has(a.y)) groundedAnchorPicked = true; else targetsY.set(a.y, target[1]);
    }
    if (!targetsX.size && !targetsY.size && !groundedAnchorPicked) return "not_modeled";
    this.nextTemp = 0;
    const commanded = new Set<number>();
    for (const [i, t] of [...targetsX].sort((a, b) => a[0] - b[0])) { this.P[i].v = this.nx(t); commanded.add(i); }
    for (const [i, t] of [...targetsY].sort((a, b) => a[0] - b[0])) { this.P[i].v = this.ny(t); commanded.add(i); }
    for (const i of [...commanded].sort((a, b) => a - b)) this.softPinCoordinate(i, DefaultTemporaryConstraint);
    this.pinUncommandedCoordinates(commanded, DefaultTemporaryConstraint);
    this.gcs.initSolution(); const ret = this.gcs.solve(); this.gcs.applySolution();
    let solved = this.solveSucceeded(ret);
    for (const [i, t] of targetsX) solved = solved && Math.round(this.dx(this.P[i].v)) === t;
    for (const [i, t] of targetsY) solved = solved && Math.round(this.dy(this.P[i].v)) === t;
    this.gcs.clearByTag(DefaultTemporaryConstraint);
    return solved ? "solved" : "refused";
  }
  /** QuantizedRelationsSatisfied: the relations still hold once every coordinate and radius is rounded to whole IU, as the board will store them. */
  quantizedRelationsSatisfied(): boolean {
    const snap = this.snapshot(); const xs = new Set<number>(), ys = new Set<number>(), radii = new Set<number>();
    const addPoint = (x: number) => { if (x >= 0) { xs.add(x); ys.add(x + 1); } };
    for (const [, v] of this.sorted()) {
      addPoint(v.startX); addPoint(v.endX); addPoint(v.arcStartX); addPoint(v.arcEndX); addPoint(v.focusX);
      if (v.kind === "POLYGON") for (let i = 0; i < v.vertexCount; ++i) addPoint(v.startX + 2 * i);
      if (v.radius >= 0) radii.add(v.radius);
    }
    for (const i of xs) this.P[i].v = this.nx(Math.round(this.dx(this.P[i].v)));
    for (const i of ys) this.P[i].v = this.ny(Math.round(this.dy(this.P[i].v)));
    for (const i of radii) this.P[i].v = Math.round(this.P[i].v * this.scale) * this.inv;
    const ok = this.hardRelationsSatisfied(); this.restore(snap); return ok;
  }
  /** DropStaleRelations: the relations the geometry already fails taken out (their mapping kept for Diagnose); the number dropped. */
  dropStaleRelations(): number {
    const stale = this.staleRelationTags();
    for (const tag of stale) { this.gcs.clearByTag(tag); this.droppedTags.add(tag); }
    if (stale.length) this.gcs.initSolution();
    return stale.length;
  }
  private softPinCoordinate(i: number, tag: number, weight?: number): void {
    if (i < 0) return;
    const pin = this.temporaryParam(this.P[i].v); const id = this.gcs.addConstraintEqual(this.P[i], this.P[pin], tag);
    if (weight !== undefined) this.gcs.rescaleConstraint(id, weight);
  }
  /** pinUncommandedCoordinates: every free coordinate the edit did not command stays put at the stay-put weight; a commanded shape keeps its radius exactly. */
  private pinUncommandedCoordinates(commanded: Set<number>, tag: number): void {
    for (const [id, v] of this.sorted()) {
      if (v.item.cls !== "pad" && constraintItemIsLocked(v.item)) continue;
      const st = this.collectRigidState(new Set([id]));
      const commandedShape = st.points.some((px) => commanded.has(px) || commanded.has(px + 1));
      for (const px of st.points) { if (!commanded.has(px)) this.softPinCoordinate(px, tag, STAY_PUT_WEIGHT); if (!commanded.has(px + 1)) this.softPinCoordinate(px + 1, tag, STAY_PUT_WEIGHT); }
      for (const h of st.radii) {
        const target = this.temporaryParam(this.P[h.radius].v);
        const cid = this.gcs.addConstraintCircleRadius(new Circle(this.pt(h.centerX), this.P[h.radius]), this.P[target], tag);
        if (!commandedShape) this.gcs.rescaleConstraint(cid, STAY_PUT_WEIGHT);
      }
    }
  }
  /** AnchorPosition (IU) of a member in the current parameters. */
  anchorPosition(m: CMember): Pt | null { const a = this.anchorParams(m); return valid(a) ? [Math.round(this.dx(this.P[a.x].v)), Math.round(this.dy(this.P[a.y].v))] : null; }
  private solveSucceeded(ret: number): boolean { if ((ret === SolveStatus.Success || ret === SolveStatus.Converged) && this.parametersFinite()) return true; return this.hardRelationsSatisfied(); }
  private parametersFinite(): boolean { return this.P.every((p) => Number.isFinite(p.v)); }
  /** CurrentRelationsSatisfied. */
  hardRelationsSatisfied(): boolean {
    if (!this.parametersFinite()) return false;
    const structural = this.gcs.calculateConstraintErrorByTag(0);
    if (Number.isFinite(structural) && Math.abs(structural) > 1e-3) return false;
    return this.staleRelationTags().length === 0;
  }
  private staleRelationTags(): number[] {
    const out: number[] = [];
    for (const [tag] of [...this.tagToConstraint.entries()].sort((a, b) => a[0] - b[0])) {
      if (this.nonDrivingTags.has(tag) || this.droppedTags.has(tag)) continue;
      const err = this.gcs.calculateConstraintErrorByTag(tag); if (!Number.isFinite(err) || Math.abs(err) > 1e-3) out.push(tag);
    }
    return out;
  }
  private softPinPoint(x: number, tag: number, weight?: number): void { if (x >= 0) this.softPin({ x, y: x + 1 }, tag, weight); }
  private softPin(a: AnchorParams, tag: number, weight?: number): void {
    if (!valid(a)) return;
    const px = this.temporaryParam(this.P[a.x].v), py = this.temporaryParam(this.P[a.y].v), p = this.ptFor(a);
    const cx = this.gcs.addConstraintCoordinateX(p, this.P[px], tag), cy = this.gcs.addConstraintCoordinateY(p, this.P[py], tag);
    if (weight !== undefined) { this.gcs.rescaleConstraint(cx, weight); this.gcs.rescaleConstraint(cy, weight); }
  }
  private pinDraggedShapeRest(dragged: CMember, tag: number, co: CMember | null): void {
    const v = this.vars.get(dragged.item); if (!v) return;
    if (v.kind === "SEGMENT" || v.kind === "BEZIER") { if (dragged.anchor === "start") this.softPinPoint(v.endX, tag); else if (dragged.anchor === "end") this.softPinPoint(v.startX, tag); }
    else if (v.kind === "ARC") {
      if (dragged.anchor === "start" || dragged.anchor === "end") { this.softPinPoint(v.startX, tag); this.holdArcRadius(v, tag); this.softPinPoint(dragged.anchor === "start" ? v.arcEndX : v.arcStartX, tag); }
      else if (dragged.anchor === "center") { this.softPinPoint(v.arcStartX, tag); this.softPinPoint(v.arcEndX, tag); }
    } else if (v.kind === "RECTANGLE" && dragged.anchor === "vertex") this.softPin(this.anchorParams(member(dragged.item, "vertex", (dragged.index + 2) % 4)), tag);
    else if (v.kind === "POLYGON" && dragged.anchor === "vertex") {
      for (let i = 0; i < v.vertexCount; ++i) { if (i === dragged.index || (co && co.item === dragged.item && i === co.index)) continue; this.softPinPoint(v.startX + 2 * i, tag); }
    }
  }
  private pinUneditedShapes(edited: Set<string>, tag: number): void {
    const holdRadius = (v: ShapeVars) => { const rad = this.temporaryParam(this.P[v.radius].v); this.gcs.rescaleConstraint(this.gcs.addConstraintCircleRadius(new Circle(this.pt(v.startX), this.P[v.radius]), this.P[rad], tag), STAY_PUT_WEIGHT); };
    for (const [id, v] of this.sorted()) {
      if (edited.has(id)) continue;
      if (v.item.cls !== "pad" && constraintItemIsLocked(v.item)) continue;
      switch (v.kind) {
        case "SEGMENT": case "BEZIER": case "POINT_PAIR": case "RECTANGLE": this.softPinPoint(v.startX, tag, STAY_PUT_WEIGHT); this.softPinPoint(v.endX, tag, STAY_PUT_WEIGHT); break;
        case "CIRCLE": case "ELLIPSE": this.softPinPoint(v.startX, tag, STAY_PUT_WEIGHT); holdRadius(v); break;
        case "ARC": case "ELLIPSE_ARC": this.softPinPoint(v.startX, tag, STAY_PUT_WEIGHT); this.softPinPoint(v.arcStartX, tag, STAY_PUT_WEIGHT); this.softPinPoint(v.arcEndX, tag, STAY_PUT_WEIGHT); holdRadius(v); break;
        case "POLYGON": for (let i = 0; i < v.vertexCount; ++i) this.softPinPoint(v.startX + 2 * i, tag, STAY_PUT_WEIGHT); break;
        case "PAD_CENTER": this.softPinPoint(v.startX, tag, STAY_PUT_WEIGHT); break;
      }
    }
  }
  private holdPolygonVertices(shapes: Set<string>, tag: number): void {
    for (const [id, v] of this.sorted()) { if (v.kind !== "POLYGON" || constraintItemIsLocked(v.item) || !shapes.has(id)) continue; for (let i = 0; i < v.vertexCount; ++i) this.softPinPoint(v.startX + 2 * i, tag, STAY_PUT_WEIGHT); }
  }
  private holdFreeSegmentLengths(tag: number, shapes: Set<string>): void {
    for (const [id, v] of this.sorted()) {
      if (v.kind !== "SEGMENT" || constraintItemIsLocked(v.item) || !shapes.has(id)) continue;
      const len = this.temporaryParam(Math.hypot(this.P[v.endX].v - this.P[v.startX].v, this.P[v.endX + 1].v - this.P[v.startX + 1].v));
      this.gcs.addConstraintP2PDistance(this.pt(v.startX), this.pt(v.endX), this.P[len], tag);
    }
  }
  private holdArcRadius(v: ShapeVars, tag: number): void { const rad = this.temporaryParam(this.P[v.radius].v); this.gcs.addConstraintCircleRadius(new Circle(this.pt(v.startX), this.P[v.radius]), this.P[rad], tag); }
  private holdFreeArcRadii(tag: number, shapes: Set<string>): void { for (const [id, v] of this.sorted()) if (v.kind === "ARC" && !constraintItemIsLocked(v.item) && shapes.has(id)) this.holdArcRadius(v, tag); }
  private holdShapesRigid(tag: number, shapes: Set<string>): void {
    for (const [id, v] of this.sorted()) {
      if (v.item.cls !== "shape" || constraintItemIsLocked(v.item) || !shapes.has(id)) continue;
      const st = this.collectRigidState(new Set([id])); if (!st.points.length) continue;
      const ax = st.points[0];
      for (const px of st.points) {
        if (px === ax) continue;
        const ox = this.temporaryParam(this.P[px].v - this.P[ax].v), oy = this.temporaryParam(this.P[px + 1].v - this.P[ax + 1].v);
        this.gcs.addConstraintDifference(this.P[ax], this.P[px], this.P[ox], tag); this.gcs.addConstraintDifference(this.P[ax + 1], this.P[px + 1], this.P[oy], tag);
      }
      this.holdRigidRadii(st.radii, tag);
    }
  }

  /** Apply: write the solved geometry back into the board's working nodes; returns the ids of the changed shapes. */
  apply(): string[] {
    const changed: string[] = []; if (!this.built) return changed;
    const pointAt = (x: number): Pt => [Math.round(this.dx(this.P[x].v)), Math.round(this.dy(this.P[x + 1].v))];
    const B = this.board;
    const current = B.items();   // Apply compares with each item as it stands now (a session writes frame after frame)
    for (const body of this.rigid) {
      const t: Pt = [Math.round(this.P[body.translationX].v * this.scale), Math.round(this.P[body.translationX + 1].v * this.scale)];
      const at = K.atOf(B.nodeOf(body.fp)!), cur: Pt = [Math.round(at[0] * IU_PER_NORM_UNIT), Math.round(at[1] * IU_PER_NORM_UNIT)];
      const delta: Pt = [body.buildPosition[0] + t[0] - cur[0], body.buildPosition[1] + t[1] - cur[1]];
      if (!delta[0] && !delta[1]) continue;
      translateNode(B.modify(body.fp), delta[0] / IU_PER_NORM_UNIT, delta[1] / IU_PER_NORM_UNIT);
    }
    const setXY = (n: SNode, k: string, p: Pt) => { const c = K.kid(n, k); if (c) { c[1] = mm(p[0]); c[2] = mm(p[1]); } };
    for (const [id, v] of this.sorted()) {
      if (this.rigidMembers.has(id) || v.kind === "PAD_CENTER") continue;
      const s = current.get(id) || v.item;
      if (v.kind === "POINT_PAIR") {
        const start = pointAt(v.startX), end = v.endX >= 0 ? pointAt(v.endX) : s.end;
        if (ptEq(start, s.start) && ptEq(end, s.end)) continue;
        const n = B.modify(s.top); const m = dimRead(n); const oldKnee = m.type === "radial" ? dimKnee(m) : null;
        m.start = start; m.end = end;
        if (oldKnee) { const k = dimKnee(m); m.textPos = [m.textPos[0] + k[0] - oldKnee[0], m.textPos[1] + k[1] - oldKnee[1]]; }
        dimUpdate(m); const fresh = dimWrite(n, m); n.length = 0; n.push(...fresh);
        continue;
      }
      if (v.kind === "CIRCLE") {
        const center = pointAt(v.startX), radius = Math.round(this.P[v.radius].v * this.scale);
        if (ptEq(center, s.center) && radius === s.radius) continue;
        const n = B.modify(s.top); setXY(n, "center", center); setXY(n, "end", [center[0] + radius, center[1]]); changed.push(id); continue;
      }
      if (v.kind === "ARC") {
        if (this.P[v.radius].v * this.scale < 1000 && s.radius >= 1000) continue;
        const center = pointAt(v.startX), start = pointAt(v.arcStartX), end = pointAt(v.arcEndX);
        if (ptEq(start, s.start) && ptEq(end, s.end) && ptEq(center, s.center)) continue;
        const rad = this.P[v.radius].v * this.scale; const sa = Math.atan2(start[1] - center[1], start[0] - center[0]); let ea = Math.atan2(end[1] - center[1], end[0] - center[0]);
        const cw = (s.mid[0] - s.start[0]) * (s.end[1] - s.start[1]) - (s.mid[1] - s.start[1]) * (s.end[0] - s.start[0]) < 0;
        if (cw) { if (ea > sa) ea -= 2 * Math.PI; } else if (ea < sa) ea += 2 * Math.PI;
        const midA = 0.5 * (sa + ea), mid: Pt = [Math.round(center[0] + rad * Math.cos(midA)), Math.round(center[1] + rad * Math.sin(midA))];
        const n = B.modify(s.top); setXY(n, "start", start); setXY(n, "mid", mid); setXY(n, "end", end); changed.push(id); continue;
      }
      if ((v.kind === "ELLIPSE" || v.kind === "ELLIPSE_ARC") && s.ell) {
        const center = pointAt(v.startX), fx = (this.P[v.focusX].v - this.P[v.startX].v) * this.scale, fy = (this.P[v.focusX + 1].v - this.P[v.startX + 1].v) * this.scale;
        const focal = Math.hypot(fx, fy), minor = this.P[v.radius].v * this.scale, major = Math.sqrt(focal * focal + minor * minor);
        const rotation = focal > 1 ? Math.atan2(fy, fx) * 180 / Math.PI : s.ell.rotation;
        let sa = s.ell.start, ea = s.ell.end;
        if (v.kind === "ELLIPSE_ARC") { sa = this.P[v.startAngle].v * 180 / Math.PI; ea = this.P[v.endAngle].v * 180 / Math.PI; }
        const same = (a: number, b: number) => { let d = (a - b) % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return Math.abs(d) < 1e-6; };
        if (ptEq(center, [s.ell.cx, s.ell.cy]) && Math.round(major) === s.ell.major && Math.round(minor) === s.ell.minor && same(rotation, s.ell.rotation) && same(sa, s.ell.start) && same(ea, s.ell.end)) continue;
        const n = B.modify(s.top); const ang = (x: number) => { const r = Number((+x).toPrecision(10)); return r === 0 ? 0 : r; }; const put = (k: string, x: number) => { const c = K.kid(n, k); if (c) c[1] = x; };
        setXY(n, "center", center); put("rotation_angle", ang(rotation)); put("major_radius", mm(Math.round(major))); put("minor_radius", mm(Math.round(minor)));
        if (v.kind === "ELLIPSE_ARC") { put("start_angle", ang(sa)); put("end_angle", ang(ea)); }
        changed.push(id); continue;
      }
      if (v.kind === "BEZIER") {
        const start = pointAt(v.startX), end = pointAt(v.endX); if (ptEq(start, s.start) && ptEq(end, s.end)) continue;
        const pts: Pt[] = [start, [s.c1[0] + start[0] - s.start[0], s.c1[1] + start[1] - s.start[1]], [s.c2[0] + end[0] - s.end[0], s.c2[1] + end[1] - s.end[1]], end];
        const n = B.modify(s.top); const pl = K.kid(n, "pts"); const xy = pl ? pl.filter((c) => Array.isArray(c) && c[0] === "xy") as SNode[] : [];
        pts.forEach((p, i) => { if (xy[i]) { xy[i][1] = mm(p[0]); xy[i][2] = mm(p[1]); } }); changed.push(id); continue;
      }
      if (v.kind === "POLYGON") {
        if (s.pts.length !== v.vertexCount) continue;
        const pts: Pt[] = []; for (let i = 0; i < v.vertexCount; ++i) pts.push(pointAt(v.startX + 2 * i));
        if (pts.every((p, i) => ptEq(p, s.pts[i]))) continue;
        const n = B.modify(s.top); const pl = K.kid(n, "pts"); if (pl) pl.splice(1, pl.length - 1, ...pts.map((p) => ["xy", mm(p[0]), mm(p[1])] as SNode));
        changed.push(id); continue;
      }
      const start = pointAt(v.startX), end = pointAt(v.endX); if (ptEq(start, s.start) && ptEq(end, s.end)) continue;
      if (v.kind === "RECTANGLE") {
        const nw = Math.abs(end[0] - start[0]), nh = Math.abs(end[1] - start[1]), cw = Math.abs(s.end[0] - s.start[0]), ch = Math.abs(s.end[1] - s.start[1]);
        if ((nw < 1000 && cw >= 1000) || (nh < 1000 && ch >= 1000)) continue;
      } else if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 1000 && Math.hypot(s.end[0] - s.start[0], s.end[1] - s.start[1]) >= 1000) continue;
      const n = B.modify(s.top); setXY(n, "start", start); setXY(n, "end", end); changed.push(id);
    }
    B.invalidate();
    return changed;
  }
  /** ApplyReferenceValues: a reference (non-driving) constraint's value re-measured from the written geometry. */
  applyReferenceValues(): void {
    if (!this.built) return;
    for (const c of this.referenceConstraints) {
      if (!c.members.length) continue;
      const v = this.vars.get(c.members[0].item); if (!v) continue;
      const shape = this.board.resolve(c.members[0].item); let value: number | null = null, tol = 1;
      switch (c.type) {
        case "fixed_length":
          if (c.members.length === 2) {
            const pa = this.anchorPosition(c.members[0]), pb = this.anchorPosition(c.members[1]);
            if (pa && pb) { const ortho = this.orthogonalDimensionForMembers(c.members); value = ortho ? (ortho.horizontal ? Math.abs(pb[0] - pa[0]) : Math.abs(pb[1] - pa[1])) : Math.hypot(pb[0] - pa[0], pb[1] - pa[1]); }
          } else if (shape) value = Math.hypot(shape.end[0] - shape.start[0], shape.end[1] - shape.start[1]);
          break;
        case "fixed_radius": if (shape) value = shape.radius; break;
        case "angular_dimension": { if (c.members.length !== 2 || !shape) break; const b = this.vars.has(c.members[1].item) ? this.board.resolve(c.members[1].item) : null; if (!b) break; value = measureCornerAngle([shape.start, shape.end], [b.start, b.end]); tol = 1e-3; break; }
        case "arc_angle": if (shape) { value = arcAngleDeg(shape); tol = 1e-3; } break;
        default: break;
      }
      if (value === null) continue;
      if (c.value !== null && Math.abs(value - c.value) <= tol) continue;
      c.value = value; this.board.writeConstraint(c);
    }
  }
  /** Diagnose: free degrees of freedom, conflicting and redundant constraints (QR plus the residual and collapse checks). */
  diagnose(): ConstraintDiagnosis {
    const diag = emptyDiagnosis(); if (!this.built) return diag;
    this.gcs.diagnose(); diag.freeDof = this.gcs.dofsNumber();
    const toIds = (tags: number[], out: string[]) => { for (const t of tags) { const id = this.tagToConstraint.get(t); if (id) out.push(id); } };
    toIds(this.gcs.getConflicting(), diag.conflicting); toIds(this.gcs.getRedundant(), diag.redundant);
    const flag = (id: string) => { if (!diag.conflicting.includes(id)) diag.conflicting.push(id); };
    const tags = [...this.tagToConstraint.entries()].sort((a, b) => a[0] - b[0]);
    for (const [tag, id] of tags) { if (this.nonDrivingTags.has(tag)) continue; const err = this.gcs.calculateConstraintErrorByTag(tag); if (!Number.isFinite(err) || Math.abs(err) <= 1e-3) continue; flag(id); }
    const collapsed = new Set<string>();
    for (const [k, v] of this.sorted()) {
      if (v.kind !== "SEGMENT") continue;
      const solved = Math.hypot(this.P[v.endX].v - this.P[v.startX].v, this.P[v.endX + 1].v - this.P[v.startX + 1].v);
      const orig = Math.hypot(v.item.end[0] - v.item.start[0], v.item.end[1] - v.item.start[1]) * this.inv;
      if (orig > 1e-3 && solved < 1e-3) collapsed.add(k);
    }
    if (collapsed.size) {
      let attributed = false;
      for (const [tag, id] of tags) { if (this.nonDrivingTags.has(tag)) continue; const ms = this.tagMembers.get(tag); if (!ms) continue; if (ms.some((m) => collapsed.has(m))) { flag(id); attributed = true; } }
      if (!attributed) for (const [tag, id] of tags) if (!this.nonDrivingTags.has(tag)) flag(id);
    }
    return diag;
  }
}

// ---------------------------------------------------------------- the cluster functions
/** CONSTRAINT_GRAPH: constraints by member id, and each board footprint's constrained children linked in a star. */
interface ConstraintGraph { byMember: Map<string, PcbConstraint[]>; rigidSiblings: Map<string, string[]> }
function buildShapeConstraintMap(board: CBoard, constraints: PcbConstraint[], errored?: string[]): ConstraintGraph {
  const g: ConstraintGraph = { byMember: new Map(), rigidSiblings: new Map() };
  for (const c of constraints) {
    let bad = !c.members.length;
    for (const m of c.members) { let l = g.byMember.get(m.item); if (!l) g.byMember.set(m.item, l = []); l.push(c); if (errored && !isConstrainable(board.resolve(m.item))) bad = true; }
    if (bad && errored) errored.push(c.id);
  }
  if (board.fpEditor) return g;
  const byFp = new Map<string, string[]>();
  for (const it of board.items().values()) if (it.fp && g.byMember.has(it.id)) { let l = byFp.get(it.fp); if (!l) byFp.set(it.fp, l = []); l.push(it.id); }
  for (const ids of byFp.values()) {
    if (ids.length < 2) continue;
    for (let i = 1; i < ids.length; ++i) {
      const a = g.rigidSiblings.get(ids[0]) || []; a.push(ids[i]); g.rigidSiblings.set(ids[0], a);
      const b = g.rigidSiblings.get(ids[i]) || []; b.push(ids[0]); g.rigidSiblings.set(ids[i], b);
    }
  }
  return g;
}
/** collectConstraintCluster: the connected component of shapes and constraints containing seed. */
function collectCluster(g: ConstraintGraph, seed: string, visited?: Set<string>): { shapes: Set<string>; constraints: PcbConstraint[] } {
  const shapes = new Set<string>([seed]), constraints: PcbConstraint[] = [], used = new Set<string>(), frontier = [seed];
  while (frontier.length) {
    const id = frontier.pop()!; if (visited) visited.add(id);
    for (const s of g.rigidSiblings.get(id) || []) if (!shapes.has(s)) { shapes.add(s); frontier.push(s); }
    for (const c of g.byMember.get(id) || []) {
      if (!used.has(c.id)) { used.add(c.id); constraints.push(c); }
      for (const m of c.members) if (!shapes.has(m.item)) { shapes.add(m.item); frontier.push(m.item); }
    }
  }
  return { shapes, constraints };
}
const resolveCluster = (board: CBoard, ids: Set<string>): CItem[] => [...ids].map((id) => board.resolve(id)).filter((x): x is CItem => !!x);

/** SolveCluster: build the dragged anchor's cluster, solve with the anchor at the cursor, and write it back. */
export function solveCluster(board: CBoard, dragged: CMember, cursor: Pt, stabilize: boolean, edited: Set<string> = new Set(), fixedShapes: Set<string> = new Set(), holdDraggedRigid = false, coDragged: [CMember, Pt] | null = null): ConstraintDiagnosis {
  const g = buildShapeConstraintMap(board, board.constraints());
  const { shapes, constraints } = collectCluster(g, dragged.item);
  const items = resolveCluster(board, shapes);
  if (!items.length || !constraints.length) return emptyDiagnosis();
  const a = new ConstraintAdapter(board);
  if (!a.build(items, constraints, fixedShapes)) return emptyDiagnosis();
  if (!a.solveDragged(dragged, cursor, stabilize, edited, coDragged, holdDraggedRigid)) return emptyDiagnosis();
  a.apply(); a.applyReferenceValues();
  const diag = a.diagnose(); diag.solved = true; return diag;
}
/** ConstraintReferenceShapes: the curve a point-on-line / midpoint snaps onto stays put (the point moves to it). */
export function constraintReferenceShapes(board: CBoard, c: PcbConstraint): Set<string> {
  if (c.type !== "point_on_line" && c.type !== "midpoint") return new Set();
  const ms = c.members; if (ms.length !== 2 || ms[0].item === ms[1].item) return new Set();
  const last = board.resolve(ms[1].item); if (ms[1].anchor !== "whole" || !last || last.cls !== "shape") return new Set();
  if (constraintItemIsLocked(board.resolve(ms[0].item))) return new Set();
  if (board.constraints().some((o) => o.type === "fixed_position" && o.members.length && sameMember(o.members[0], ms[0]))) return new Set();
  return new Set([ms[1].item]);
}
/** ApplyConstraintImmediately: pin the first member where it is and settle its cluster (stabilised). */
export function applyConstraintImmediately(board: CBoard, c: PcbConstraint, fixedShapes: Set<string> = new Set()): ConstraintDiagnosis {
  if (!c.members.length) return emptyDiagnosis();
  let pin = c.members[0];
  if (pin.anchor === "whole") {
    const it = board.resolve(pin.item); if (!it || it.cls !== "shape") return emptyDiagnosis();
    const anchors = itemAnchors(it); if (!anchors.length) return emptyDiagnosis();
    pin = member(pin.item, anchors[0].anchor, anchors[0].index);
  }
  const pos = anchorPosition(board, pin); if (!pos) return emptyDiagnosis();
  return solveCluster(board, pin, pos, true, new Set(), fixedShapes, fixedShapes.size > 0);
}
/** ReSolveShapeClusters: settle the cluster of each moved shape, the moved ones as edited. */
export function reSolveShapeClusters(board: CBoard, shapeIds: string[]): void {
  const g = buildShapeConstraintMap(board, board.constraints()); const visited = new Set<string>();
  for (const id of shapeIds) {
    if (visited.has(id) || !g.byMember.has(id)) continue;
    const { shapes } = collectCluster(g, id, visited);
    const it = board.resolve(id); const anchors = itemAnchors(it); if (!anchors.length) continue;
    const edited = new Set(shapeIds.filter((o) => shapes.has(o)));
    solveCluster(board, member(id, anchors[0].anchor, anchors[0].index), anchors[0].pos, false, edited);
  }
}
/** ReSolveShapeClustersHoldingEdited: each edited shape frozen, its neighbours follow; false (nothing written) when a cluster cannot hold. */
export function reSolveShapeClustersHoldingEdited(board: CBoard, edited: string[]): boolean {
  const g = buildShapeConstraintMap(board, board.constraints()); const visited = new Set<string>(); const solved: ConstraintAdapter[] = [];
  for (const seed of edited) {
    if (visited.has(seed) || !g.byMember.has(seed)) continue;
    const { shapes, constraints } = collectCluster(g, seed, visited);
    const items = resolveCluster(board, shapes);
    if (!items.some((it) => it.cls === "shape") || !constraints.length) continue;
    const fixed = new Set(edited.filter((e) => shapes.has(e)));
    const a = new ConstraintAdapter(board);
    if (!a.build(items, constraints, fixed) || !a.solve(true) || !a.hardRelationsSatisfied()) return false;
    solved.push(a);
  }
  for (const a of solved) { a.apply(); a.applyReferenceValues(); }
  return true;
}
/** ReSolveAfterShapeResize. */
export function reSolveAfterShapeResize(board: CBoard, shapeId: string): void {
  const g = buildShapeConstraintMap(board, board.constraints()); if (!g.byMember.has(shapeId)) return;
  const { shapes, constraints } = collectCluster(g, shapeId); const items = resolveCluster(board, shapes);
  if (!items.some((it) => it.cls === "shape") || !constraints.length) return;
  const a = new ConstraintAdapter(board);
  if (!a.build(items, constraints, null) || !a.solveAfterResize(shapeId)) return;
  a.apply(); a.applyReferenceValues();
}
/** DiagnoseBoardConstraints: every cluster's state, the free degrees of freedom and the conflicting / redundant / errored constraints. */
export function diagnoseBoardConstraints(board: CBoard): BoardConstraintDiagnostics {
  const out: BoardConstraintDiagnostics = { totalFreeDof: 0, shapeStates: new Map(), conflicting: [], redundant: [], errored: [] };
  const all = board.constraints(); if (!all.length) return out;
  const g = buildShapeConstraintMap(board, all, out.errored); const visited = new Set<string>();
  for (const seed of g.byMember.keys()) {
    if (visited.has(seed)) continue;
    const { shapes, constraints } = collectCluster(g, seed, visited);
    const items = resolveCluster(board, shapes); const a = new ConstraintAdapter(board);
    if (!items.length || !constraints.length || !a.build(items, constraints, null)) continue;
    out.errored.push(...a.unmapped);
    // the diagnosis must not write: solve a scratch board
    a.solve(true); const d = a.diagnose();
    const state: ConstraintState = isOverConstrained(d) ? "over" : d.freeDof > 0 ? "under" : "well";
    for (const it of items) out.shapeStates.set(it.id, state);
    if (d.freeDof > 0) out.totalFreeDof += d.freeDof;
    out.conflicting.push(...d.conflicting); out.redundant.push(...d.redundant);
  }
  out.errored = [...new Set(out.errored)].sort();
  return out;
}

// ---------------------------------------------------------------- the editing sessions
/**
 * BOARD_CONSTRAINT_SESSION: one editing session over a constraint cluster, its adapter and the baseline every
 * speculative solve starts from.  The board is the live one: a session's Apply writes into `board`'s working nodes,
 * which the caller puts on the canvas frame by frame (and takes back, or commits, when the gesture ends).
 */
export class BoardConstraintSession {
  board: CBoard | null = null; adapter: ConstraintAdapter | null = null; protected baseline: number[] = []; baseConflict = false;
  protected reset(): void { this.adapter = null; this.baseline = []; this.baseConflict = false; }
  protected buildCluster(board: CBoard, shapes: Set<string>, constraints: PcbConstraint[]): boolean {
    this.board = board; this.reset();
    const items = resolveCluster(board, shapes);
    if (!items.length || !constraints.length) return false;
    const a = new ConstraintAdapter(board);
    if (!a.build(items, constraints, null)) return false;
    this.adapter = a; this.baseline = a.snapshot(); this.baseConflict = !a.hardRelationsSatisfied();
    return true;
  }
  protected usable(): boolean { return !!this.adapter && !this.baseConflict; }
  protected rewind(): boolean { return !!this.adapter && this.adapter.restore(this.baseline); }
}
/** BOARD_CONSTRAINT_DRAG_SESSION: a handle drag of one anchor, solved every frame from the last accepted state. */
export class BoardConstraintDragSession extends BoardConstraintSession {
  dragged: CMember | null = null;
  build(board: CBoard, dragged: CMember): boolean {
    this.board = board; this.dragged = dragged; this.reset();
    const { shapes, constraints } = collectCluster(buildShapeConstraintMap(board, board.constraints()), dragged.item);
    return this.buildCluster(board, shapes, constraints);
  }
  matches(m: CMember): boolean { return !!this.adapter && !!this.dragged && sameMember(this.dragged, m) && this.dragged.index === m.index; }
  /** IsExactFeasible: the anchor can sit exactly at the target with every relation still holding in whole IU. */
  isExactFeasible(target: Pt): boolean {
    if (!this.usable() || !this.rewind() || !this.dragged) return false;
    const solved = this.adapter!.solveDragged(this.dragged, target, false); const at = solved ? this.adapter!.anchorPosition(this.dragged) : null;
    const ok = !!at && at[0] === target[0] && at[1] === target[1] && this.adapter!.quantizedRelationsSatisfied();
    this.rewind(); return ok;
  }
  /** Solve: the anchor at the cursor (IU) and the cluster written to the board; the ids of the shapes it changed. */
  solve(cursor: Pt, stabilize = false, edited: Set<string> = new Set(), coDragged: [CMember, Pt] | null = null): { diag: ConstraintDiagnosis; changed: string[] } {
    const a = this.adapter; if (!a || !this.rewind() || !this.dragged) return { diag: emptyDiagnosis(), changed: [] };
    if (this.baseConflict) { const changed = a.apply(); return { diag: a.diagnose(), changed }; }
    if (!a.solveDragged(this.dragged, cursor, stabilize, edited, coDragged)) { this.rewind(); return { diag: emptyDiagnosis(), changed: a.apply() }; }
    const changed = a.apply(); a.applyReferenceValues();
    this.baseline = a.snapshot();
    const diag = a.diagnose(); diag.solved = true;
    return { diag, changed };
  }
}
/** BOARD_CONSTRAINT_MOVE_SESSION: a rigid move of the edited shapes, every frame from the cluster as it was built. */
export class BoardConstraintMoveSession extends BoardConstraintSession {
  edited = new Set<string>(); reference: Pt = [0, 0];
  build(board: CBoard, editedShapes: string[], reference: Pt): boolean {
    this.reference = reference; this.edited = new Set(); this.reset();
    if (!editedShapes.length) return false;
    const g = buildShapeConstraintMap(board, board.constraints()); const visited = new Set<string>();
    const shapes = new Set<string>(); const constraints: PcbConstraint[] = [];
    // every seed's cluster joins one adapter: a move is rigid, so shapes that constrain each other solve together
    for (const seed of editedShapes) {
      if (visited.has(seed) || !g.byMember.has(seed)) continue;
      const cl = collectCluster(g, seed, visited);
      for (const e of editedShapes) if (cl.shapes.has(e)) this.edited.add(e);
      for (const sh of cl.shapes) shapes.add(sh); constraints.push(...cl.constraints);
    }
    if (!this.edited.size) return false;
    return this.buildCluster(board, shapes, constraints);
  }
  /** feasibleAt: the edited shapes can land with the reference at the target (IU). */
  feasibleAt(target: Pt): boolean {
    if (!this.usable()) return false;
    const ok = this.rewind() && this.adapter!.solveRigidTranslation(this.edited, [target[0] - this.reference[0], target[1] - this.reference[1]]);
    this.rewind(); return ok;
  }
  /** Solve: the move to the target (IU) written to the board; false (nothing written) when the cluster cannot follow. */
  solve(target: Pt): { ok: boolean; changed: string[] } {
    const a = this.adapter;
    // a cluster that travels whole carries any base conflict along unchanged
    if (!a || (this.baseConflict && !a.travelsWhole(this.edited))) return { ok: false, changed: [] };
    if (!this.rewind() || !a.solveRigidTranslation(this.edited, [target[0] - this.reference[0], target[1] - this.reference[1]])) { this.rewind(); return { ok: false, changed: [] }; }
    const changed = a.apply(); a.applyReferenceValues();
    return { ok: true, changed };
  }
}
/** BOARD_CONSTRAINT_BLOCK_SESSION: a block edit (several picked anchors and one carried offset), every frame from the starting geometry. */
export class BoardConstraintBlockSession extends BoardConstraintSession {
  build(board: CBoard, blockItems: string[]): boolean {
    this.reset(); if (!blockItems.length) return false;
    const g = buildShapeConstraintMap(board, board.constraints()); const visited = new Set<string>();
    const shapes = new Set<string>(); const constraints: PcbConstraint[] = [];
    for (const seed of blockItems) {
      if (visited.has(seed) || !g.byMember.has(seed)) continue;
      const cl = collectCluster(g, seed, visited);
      for (const sh of cl.shapes) shapes.add(sh); constraints.push(...cl.constraints);
    }
    if (!shapes.size || !this.buildCluster(board, shapes, constraints)) return false;
    // one constraint the geometry already fails would leave the whole cluster unsolved: take the stale ones out instead
    if (this.baseConflict && this.adapter!.dropStaleRelations() > 0) this.baseConflict = !this.adapter!.hardRelationsSatisfied();
    return true;
  }
  solve(pinned: [CMember, Pt][], translated: Set<string>, translation: Pt): { result: BlockSolveResult; changed: string[] } {
    if (!this.usable() || !this.rewind()) return { result: "not_modeled", changed: [] };
    const result = this.adapter!.solveBlockEdit(pinned, translated, translation);
    if (result !== "solved") { this.rewind(); return { result, changed: [] }; }
    const changed = this.adapter!.apply(); this.adapter!.applyReferenceValues();
    return { result, changed };
  }
}
/**
 * blockDragAppendConstraintCoMembers: the top-level items that share a constraint (transitively) with `ids` but are not
 * among them — the solver can move them, so a block drag's outline validation watches them too.  A constrained child
 * of a board footprint brings its whole footprint.
 */
export function constraintCoMembers(board: CBoard, ids: Iterable<string>): string[] {
  const known = new Set(ids); for (const it of board.items().values()) if (known.has(it.top)) known.add(it.id);
  const out: string[] = []; const cs = board.constraints(); let grew = true;
  while (grew) {
    grew = false;
    for (const c of cs) {
      if (!c.members.some((m) => known.has(m.item))) continue;
      for (const m of c.members) {
        if (known.has(m.item)) continue; const it = board.resolve(m.item); if (!it) continue;
        known.add(m.item); grew = true;
        if (!known.has(it.top) || it.top === it.id) { known.add(it.top); if (!out.includes(it.top)) out.push(it.top); }
        if (it.fp) for (const ch of board.items().values()) if (ch.top === it.top) known.add(ch.id);
      }
    }
  }
  return out;
}
