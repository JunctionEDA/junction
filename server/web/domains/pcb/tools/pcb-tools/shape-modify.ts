// pcb-tools/shape-modify.ts — EDIT_TOOL's Shape Modification sub-menu on board graphics (pcbnew/tools/edit_tool.cpp,
// item_modification_routine.cpp):
//   ModifyLines        Fillet Lines, Chamfer Lines and Extend Lines to Meet: rectangles and polygons are taken apart
//                      into their edges first, then every pair of lines is handed to the routine (LINE_FILLET_ROUTINE
//                      adds a tangent arc at a shared corner, LINE_CHAMFER_ROUTINE a setback segment,
//                      LINE_EXTENSION_ROUTINE runs two lines to where they meet); lines that shrink to nothing go
//   SimplifyPolygons   SHAPE_POLY_SET::SimplifyOutlines( tolerance ) on graphic polygons and zones
//   BooleanPolygons    Merge / Subtract / Intersect Polygons (POLYGON_*_ROUTINE): the last added shape is the basis
//                      and the property donor, the others are combined into it, every source goes and each outline
//                      of the result becomes a new polygon; a subtract that leaves nothing is run again largest first
// Plain node editing; the changes come back with the routine's commit label and status message.
import { FillRule, differenceD, intersectD, unionD, type PathsD } from "clipper2-ts";
import type { BoardDoc, PcbChange, Pt } from "./types";
import { addedChange, removedChange, replacedChange } from "./changes";
import { closedShapeLoop } from "./convert";
import { fracture } from "../../fab/poly";
import { K } from "./state";
import { clone, isList, layerOf, pt, r6 } from "./util";

export interface ShapeModifyResult { changes: PcbChange[]; label: string; message: string | null; select: string[] }
const EPS = 1e-6;
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const len = (v: Pt) => Math.hypot(v[0], v[1]);
const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
const strokeOf = (n: SNode): SNode => clone(K.kid(n, "stroke") || ["stroke", ["width", 0.1], ["type", "default"]]);
const lineOf = (a: Pt, b: Pt, like: SNode): SNode => ["gr_line", ["start", r6(a[0]), r6(a[1])], ["end", r6(b[0]), r6(b[1])], strokeOf(like), ["layer", layerOf(like)], ["uuid", K.newUuid()]];

interface Line { id: string | null; a: Pt; b: Pt; like: SNode; deleted: boolean; changed: boolean; item: KItem | null; fresh: SNode | null }

/** GetSharedEndpoints: which ends of the two lines meet (0 start, 1 end), or null. */
function shared(A: Line, B: Line): [0 | 1, 0 | 1] | null {
  if (same(A.a, B.a)) return [0, 0]; if (same(A.a, B.b)) return [0, 1]; if (same(A.b, B.a)) return [1, 0]; if (same(A.b, B.b)) return [1, 1];
  return null;
}
const endOf = (L: Line, e: 0 | 1): Pt => (e ? L.b : L.a);
const setEnd = (L: Line, e: 0 | 1, p: Pt): void => { if (e) L.b = p; else L.a = p; L.changed = true; if (len(sub(L.b, L.a)) < EPS) L.deleted = true; };

/** LINE_FILLET_ROUTINE::ProcessLinePair: the arc of radius r tangent to both lines at their shared corner. */
function filletPair(A: Line, B: Line, r: number, out: SNode[]): boolean | null {
  const s = shared(A, B); if (!s) return null;
  const P = endOf(A, s[0]), fa = endOf(A, (1 - s[0]) as 0 | 1), fb = endOf(B, (1 - s[1]) as 0 | 1);
  const ua = sub(fa, P), ub = sub(fb, P), la = len(ua), lb = len(ub);
  if (la < EPS || lb < EPS) return null;
  const u: Pt = [ua[0] / la, ua[1] / la], v: Pt = [ub[0] / lb, ub[1] / lb];
  const theta = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
  if (theta < 1e-9 || Math.abs(theta - Math.PI) < 1e-9) return null;   // parallel: seg_a.Angle( seg_b ).IsHorizontal()
  const t = r / Math.tan(theta / 2);
  if (t > la + EPS || t > lb + EPS) return false;   // the arc's ends must lie on the lines
  const T1: Pt = [P[0] + u[0] * t, P[1] + u[1] * t], T2: Pt = [P[0] + v[0] * t, P[1] + v[1] * t];
  const bis: Pt = [u[0] + v[0], u[1] + v[1]], lbis = len(bis), d = r / Math.sin(theta / 2) - r;
  const M: Pt = [P[0] + bis[0] / lbis * d, P[1] + bis[1] / lbis * d];
  out.push(["gr_arc", ["start", r6(T1[0]), r6(T1[1])], ["mid", r6(M[0]), r6(M[1])], ["end", r6(T2[0]), r6(T2[1])], strokeOf(A.like), ["layer", layerOf(A.like)], ["uuid", K.newUuid()]]);
  setEnd(A, s[0], T1); setEnd(B, s[1], T2);
  return true;
}
/** LINE_CHAMFER_ROUTINE::ProcessLinePair with a symmetric setback (ComputeChamferPoints). */
function chamferPair(A: Line, B: Line, setback: number, out: SNode[]): boolean | null {
  const s = shared(A, B); if (!s) return null;
  const P = endOf(A, s[0]), fa = endOf(A, (1 - s[0]) as 0 | 1), fb = endOf(B, (1 - s[1]) as 0 | 1);
  const ua = sub(fa, P), ub = sub(fb, P), la = len(ua), lb = len(ub);
  if (la < EPS || lb < EPS || setback > la + EPS || setback > lb + EPS) return false;
  const T1: Pt = [P[0] + ua[0] / la * setback, P[1] + ua[1] / la * setback], T2: Pt = [P[0] + ub[0] / lb * setback, P[1] + ub[1] / lb * setback];
  out.push(lineOf(T1, T2, A.like));
  setEnd(A, s[0], T1); setEnd(B, s[1], T2);
  return true;
}
/** LINE_EXTENSION_ROUTINE::ProcessLinePair: both lines run to where their lines cross, from their far ends. */
function extendPair(A: Line, B: Line): boolean | null {
  const r = sub(A.b, A.a), q = sub(B.b, B.a), den = r[0] * q[1] - r[1] * q[0];
  if (Math.abs(den) < 1e-12) return null;   // parallel
  const w = sub(B.a, A.a), t = (w[0] * q[1] - w[1] * q[0]) / den, u = (w[0] * r[1] - w[1] * r[0]) / den;
  if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS) return null;   // already intersecting
  const X: Pt = [A.a[0] + r[0] * t, A.a[1] + r[1] * t];
  const extend = (L: Line, k: number): void => {
    if (k >= -EPS && k <= 1 + EPS) return;   // already on the line
    const far = len(sub(X, L.a)) < len(sub(X, L.b)) ? L.b : L.a;
    L.a = far; L.b = X; L.changed = true;
  };
  extend(A, t); extend(B, u);
  return true;
}

/** The lines the routines work on: the selected lines, and rectangles and polygons broken into theirs. */
function linesOf(doc: BoardDoc, ids: string[], changes: PcbChange[]): Line[] {
  const lines: Line[] = [];
  for (const id of ids) {
    const it = doc.items.get(id); if (!it) continue;
    if (it.kind === "gr_line") { const a = pt(it.node, "start"), b = pt(it.node, "end"); if (a && b) lines.push({ id, a, b, like: it.node, deleted: false, changed: false, item: it, fresh: null }); continue; }
    if (it.kind !== "gr_rect" && it.kind !== "gr_poly") continue;
    const loop = closedShapeLoop(it) as Pt[] | null; if (!loop || loop.length < 2) continue;
    changes.push(removedChange(it));
    loop.forEach((p, i) => lines.push({ id: null, a: p, b: loop[(i + 1) % loop.length], like: it.node, deleted: false, changed: true, item: null, fresh: null }));
  }
  return lines;
}

const LINE_MSG: Record<string, [string, string, string]> = {
  filletLines: ["Fillet Lines", "Unable to fillet the selected lines.", "Some of the lines could not be filleted."],
  chamferLines: ["Chamfer Lines", "Unable to chamfer the selected lines.", "Some of the lines could not be chamfered."],
  extendLines: ["Extend Lines to Meet", "Unable to extend the selected lines to meet.", "Some of the lines could not be extended to meet."],
};
/**
 * EDIT_TOOL::ModifyLines for filletLines (value: radius), chamferLines (value: setback) and extendLines.  null with
 * `error` when the selection does not qualify (the info-bar message KiCad shows).
 */
export function modifyLines(doc: BoardDoc, ids: string[], op: "filletLines" | "chamferLines" | "extendLines", value: number): ShapeModifyResult | { error: string } {
  const changes: PcbChange[] = [];
  const lines = linesOf(doc, ids, changes);
  if (op === "extendLines" && lines.length !== 2) return { error: "Exactly two lines must be selected to extend them." };
  if (lines.length < 2) return { error: "A shape with at least two lines must be selected." };
  const added: SNode[] = [];
  let ok = 0, fail = 0;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const A = lines[i], B = lines[j]; if (A.deleted || B.deleted) continue;
    const r = op === "filletLines" ? filletPair(A, B, value, added) : op === "chamferLines" ? chamferPair(A, B, value, added) : extendPair(A, B);
    if (r === true) ok++; else if (r === false) fail++;
  }
  const select: string[] = [];
  for (const L of lines) {
    if (L.item) {
      if (L.deleted) changes.push(removedChange(L.item));
      else if (L.changed) { const n = clone(L.item.node); const s = K.kid(n, "start"), e = K.kid(n, "end"); s!.splice(1, 2, r6(L.a[0]), r6(L.a[1])); e!.splice(1, 2, r6(L.b[0]), r6(L.b[1])); changes.push(replacedChange(L.item, n)); select.push(L.item.id); }
      else select.push(L.item.id);   // an untouched line stays in the selection
    } else if (!L.deleted) { const c = addedChange(doc, lineOf(L.a, L.b, L.like)); changes.push(c); select.push(c.id); }
  }
  for (const n of added) { const c = addedChange(doc, n); changes.push(c); select.push(c.id); }
  const [label, none, some] = LINE_MSG[op];
  const message = ok === 0 ? none : fail > 0 || ok < lines.length - 1 ? some : null;
  // the commit is pushed whatever the routine did: rectangles and polygons stay taken apart into their lines (and
  // those lines selected) even when no pair could be handled
  return { changes, label, message, select: changes.length ? select : [] };
}
/**
 * ModifyLines' check before any dialog opens: the selection's segments plus the edges of its rectangles and polygons
 * ("Exactly two lines must be selected to extend them." / "A shape with at least two lines must be selected.").
 */
export function lineCheck(doc: BoardDoc, ids: string[], op: string): string | null {
  const n = linesOf(doc, ids, []).length;
  if (op === "extendLines" && n !== 2) return "Exactly two lines must be selected to extend them.";
  return n < 2 ? "A shape with at least two lines must be selected." : null;
}

const IU = (v: number) => Math.round(v * 1e6);
/** TestSegmentHit( ref, start, end, dist ) (trigo.cpp), in nanometres. */
function testSegmentHit(p: Pt, a: Pt, b: Pt, dist: number): boolean {
  const xmin = Math.min(a[0], b[0]), xmax = Math.max(a[0], b[0]), ymin = Math.min(a[1], b[1]), ymax = Math.max(a[1], b[1]);
  if (ymin - p[1] > dist || p[1] - ymax > dist) return false;
  if (xmin - p[0] > dist || p[0] - xmax > dist) return false;
  if (a[0] === b[0] && p[1] > ymin && p[1] < ymax) return Math.abs(a[0] - p[0]) <= dist;
  if (a[1] === b[1] && p[0] > xmin && p[0] < xmax) return Math.abs(a[1] - p[1]) <= dist;
  // SEG::SquaredDistance: to SEG::NearestPoint, whose foot on the segment is rounded to the grid (rescale)
  const dx = BigInt(b[0] - a[0]), dy = BigInt(b[1] - a[1]), l2 = dx * dx + dy * dy;
  let nx = a[0], ny = a[1];
  if (l2 !== 0n) {
    const t = dx * BigInt(p[0] - a[0]) + dy * BigInt(p[1] - a[1]);
    if (t > l2) { nx = b[0]; ny = b[1]; }
    else if (t >= 0n) {
      const rescale = (num: bigint): number => { const neg = num < 0n, q = ((neg ? -num : num) * 2n + l2) / (2n * l2); return Number(neg ? -q : q); };
      nx = a[0] + rescale(t * dx); ny = a[1] + rescale(t * dy);
    }
  }
  const ex = nx - p[0], ey = ny - p[1];
  return ex * ex + ey * ey < (dist + 1) * (dist + 1);
}
/**
 * SHAPE_LINE_CHAIN::Simplify( tolerance ) on a closed outline: a greedy forward scan - from each kept point the
 * span is stretched while every point inside it lies within the tolerance of the segment across it
 * (TestSegmentHit), then the scan jumps to the span's last point.  `fixed[i]` marks an arc's point, which is never
 * dropped from inside a span (it may end one).  Returns the indices kept.
 */
export function simplifyIndices(pts: Pt[], tol: number, fixed?: boolean[]): number[] {
  const n = pts.length, keep: number[] = [];
  if (n < 3) return pts.map((_, i) => i);
  const P = pts.map((p) => [IU(p[0]), IU(p[1])] as Pt), T = IU(tol);
  for (let start = 0; start < n;) {
    keep.push(start);
    let end = (start + 2) % n, can = true;
    while (can && end !== start) {   // ( end_idx > start_idx || m_closed ): the outline is closed
      for (let t = (start + 1) % n; t !== end; t = (t + 1) % n) {
        if ((fixed && fixed[t]) || !testSegmentHit(P[t], P[start], P[end], T)) { can = false; break; }
      }
      if (can) end = (end + 1) % n;
    }
    if (end === (start + 2) % n) start++;
    else { const next = (end + n - 1) % n; if (next <= start) break; start = next; }   // looped all the way round: done
  }
  if (keep.length === 1) keep.push(n - 1);
  return keep;
}
/** The simplified outline's points (SHAPE_LINE_CHAIN::Simplify on a closed chain of plain points). */
export function simplifyLoop(pts: Pt[], tol: number): Pt[] { return simplifyIndices(pts, tol).map((i) => pts[i]); }
/** EDIT_TOOL::SimplifyPolygons on gr_poly and zone outlines (teardrop areas sit out). */
export function simplifyPolygons(doc: BoardDoc, ids: string[], tol: number): ShapeModifyResult {
  const changes: PcbChange[] = [];
  for (const id of ids) {
    const it = doc.items.get(id); if (!it) continue;
    const n = clone(it.node); let did = false;
    const fix = (ptsNode: SNode | null): void => {
      if (!ptsNode) return;
      // the chain's points: an (xy) is one, an (arc) its start, mid and end (SHAPE_IS_PT only for the plain ones);
      // an arc starting on the point before it shares that point, as SHAPE_LINE_CHAIN::Append( arc ) does
      const pts: Pt[] = [], fixed: boolean[] = [], owner: SNode[][] = [];
      for (const c of ptsNode.slice(1)) {
        if (!isList(c)) continue;
        if (c[0] === "xy") { pts.push([K.num(c[1]), K.num(c[2])]); fixed.push(false); owner.push([c as SNode]); }
        else if (c[0] === "arc") {
          const q = ["start", "mid", "end"].map((k) => pt(c as SNode, k)); if (q.some((v) => !v)) return;
          const last = pts.length ? pts[pts.length - 1] : null;
          if (last && same(last, q[0]!)) { fixed[pts.length - 1] = true; owner[pts.length - 1].push(c as SNode); }
          else { pts.push(q[0]!); fixed.push(true); owner.push([c as SNode]); }
          pts.push(q[1]!); fixed.push(true); owner.push([]); pts.push(q[2]!); fixed.push(true); owner.push([]);
        }
      }
      if (pts.length < 3) return;
      const keep = simplifyIndices(pts, tol, fixed); if (keep.length === pts.length) return;
      const out: SNode[] = []; for (const i of keep) for (const o of owner[i]) out.push(o);
      ptsNode.splice(1, ptsNode.length - 1, ...out); did = true;
    };
    if (it.kind === "gr_poly") fix(K.kid(n, "pts"));
    else if (it.kind === "zone" && !K.kid(n, "attr")) for (const p of K.kids(n, "polygon")) fix(K.kid(p, "pts"));
    if (did) changes.push(replacedChange(it, n));
  }
  return { changes, label: "Simplify Polygons", message: null, select: [] };
}

const BOOL: Record<string, [string, string, string]> = {
  mergePolygons: ["Merge Polygons", "Unable to merge the selected polygons.", "Some of the polygons could not be merged."],
  subtractPolygons: ["Subtract Polygons", "Unable to subtract the selected polygons.", "Some of the polygons could not be subtracted."],
  intersectPolygons: ["Intersect Polygons", "Unable to intersect the selected polygons.", "Some of the polygons could not be intersected."],
};
/**
 * EDIT_TOOL::BooleanPolygons; `ids` in selection order.  The last added shape swaps places with the first: it is
 * the working polygon and the donor of width, layer and fill.  POLYGON_BOOLEAN_ROUTINE::ProcessShape then takes each
 * other shape in turn: merged or subtracted it always counts and its source goes; an intersection that would leave
 * nothing is skipped - the source stays and a failure is counted ("Some of the polygons could not be intersected.").
 * Finalize makes one polygon per outline of what is left, its holes cut into the outline (EDA_SHAPE::SetPolyShape
 * fractures).  A subtraction that leaves nothing is run again largest bounding box first.
 */
export function booleanPolygons(doc: BoardDoc, ids: string[], op: "mergePolygons" | "subtractPolygons" | "intersectPolygons"): ShapeModifyResult {
  const items = ids.map((id) => doc.items.get(id)).filter((it): it is KItem => !!it && (it.kind === "gr_poly" || it.kind === "gr_rect" || it.kind === "gr_circle"));
  const [label, none, some] = BOOL[op];
  if (items.length < 2) return { changes: [], label, message: none, select: [] };
  // items_to_process: each pushed in turn, the last added one swapped with the front as it arrives
  const order: KItem[] = [], last = items[items.length - 1];
  for (const it of items) { order.push(it); if (it === last) { const t = order[0]; order[0] = order[order.length - 1]; order[order.length - 1] = t; } }
  const paths = (it: KItem): PathsD => { const l = closedShapeLoop(it) as Pt[] | null; return l && l.length > 2 ? [l.map(([x, y]) => ({ x, y }))] : []; };
  const run = (list: KItem[]) => {
    let work: PathsD | null = null, donor: SNode | null = null, ok = 0, fail = 0; const gone: KItem[] = [];
    for (const it of list) {
      const p = paths(it); if (!p.length) continue;
      if (!work) { work = p; donor = it.node; gone.push(it); continue; }
      if (op === "mergePolygons") work = unionD(work, p, FillRule.NonZero, 6);
      else if (op === "subtractPolygons") work = differenceD(work, p, FillRule.NonZero, 6);
      else {
        const x = intersectD(work, p, FillRule.NonZero, 6);
        if (!x.length) { fail++; continue; }   // no intersection: skipped rather than emptying the working polygon
        work = x;
      }
      gone.push(it); ok++;
    }
    return { work: work || [], donor, ok, fail, gone };
  };
  let r = run(order);
  if (op === "subtractPolygons" && !r.work.length) {
    // not commutative: revert and try again with the largest shape first
    const area = (it: KItem) => { const b = it.bbox; return b ? (b[2] - b[0]) * (b[3] - b[1]) : 0; };
    r = run(order.slice().sort((a, b) => area(b) - area(a)));
  }
  const changes: PcbChange[] = r.gone.map((it) => removedChange(it)), select: string[] = [];
  if (r.donor) for (const p of fracture(r.work.map((c) => c.map((q): [number, number] => [q.x, q.y])))) {
    if (p.length < 3) continue;
    const n: SNode = ["gr_poly", ["pts", ...p.map((q) => ["xy", r6(q[0]), r6(q[1])])], strokeOf(r.donor), clone(K.kid(r.donor, "fill") || ["fill", "no"]), ["layer", layerOf(r.donor)], ["uuid", K.newUuid()]];
    const c = addedChange(doc, n); changes.push(c); select.push(c.id);
  }
  return { changes, label, message: r.ok === 0 ? none : r.fail > 0 ? some : null, select };
}
export const shapeModifyApi = { modifyLines, lineCheck, simplifyPolygons, booleanPolygons, simplifyLoop, simplifyIndices };
