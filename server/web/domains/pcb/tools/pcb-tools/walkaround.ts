// pcb-tools/walkaround.ts — the interactive router's Walk around mode and its obstacles.
import type { Box, BoardDoc, Conductor, CopperShape, DesignSettings, LegFn, Obstacle, ObstacleIndex, PadInfo, PolyShape, Pt, RouterWorld, WorldItem } from "./types";
import { copperOf } from "./dialogs";
import { boxesTouch, padShape, polySegDist, rectCore, shapeBBox, shapeGap, shapeOffset } from "./distances";
import { edgeShapes, netClearance } from "./drc";
import { pointInPoly } from "./hit";
import { conductors } from "./netlist";
import { zoneLayers } from "./nodes";
import { padsOf, routeLeg } from "./route-geom";
import { K, S } from "./state";
import { r6, samePt } from "./util";
import type { RuleItem } from "./dru";
import { customRouteClearance } from "./rule-resolver";
import { mergeFull } from "./optimize-selected";
import type { RoutedItem } from "./rule-resolver";

// ---------------------------------------------------------------- interactive router: KiCad's default Walk around mode
// ROUTING_SETTINGS' defaults (pns_routing_settings.cpp): mode RM_Walkaround, start_diagonal false, auto_posture true,
// no DRC violations allowed.  Every pointer move walks the head line from the last fixed point to the cursor around
// other nets' copper (pads, tracks, arcs, vias), NPTH holes, Edge.Cuts and rule areas that keep tracks out, each
// inflated by the clearance the design rules give the pair plus half the track width.  Zone fills are not obstacles
// (PNS does not model them).  When the cursor cannot be reached the head stops at the reachable point closest to it.
export const ROUTE_EPS = 1e-4;      // a gap this much short of the rule still passes (the router's clearance epsilon)
export const HULL_EPS = 2e-3;       // hull corners sit this far outside the clearance boundary
export const DIRS8 = [[1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2], [-1, 0], [-Math.SQRT1_2, -Math.SQRT1_2], [0, -1], [Math.SQRT1_2, -Math.SQRT1_2]];
export const octile = (a: Pt, b: Pt) => { const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]); return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy); };
export function shapeCorePts(s: CopperShape): Pt[] { return s.t === "circle" ? [[s.x, s.y]] : s.t === "seg" ? [s.a, s.b] : s.t === "rect" ? rectCore(s) : s.pts; }

/** The board's copper and other routing obstacles, rebuilt when the document changes. */
export function routerWorld(doc: BoardDoc): RouterWorld {
  if (doc.__bc && doc.__bc.rworld) return doc.__bc.rworld;
  if (!doc.__bc && S.rworld && S.rworld.doc === doc && S.rworld.ver === S.docVer) return S.rworld;
  const copper = copperOf(doc); const conds = conductors(doc).filter((c) => c.kind !== "zone");
  const holes: WorldItem[] = [], keepouts: WorldItem[] = [];
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") {
      for (const p of padsOf(it)) {
        if (p.type !== "np_thru_hole") continue;
        const d = K.kid(p.node, "drill"); let w = p.w, h = p.h;
        if (d) { if (K.str(d[1]) === "oval") { w = K.num(d[2], w); h = K.num(d[3], w); } else { w = h = K.num(d[1], w); } }
        const shape = padShape(Object.assign({}, p, { w, h, shape: Math.abs(w - h) < 1e-9 ? "circle" : "oval" }));
        holes.push({ id: it.id, kind: "hole", pad: p, layers: new Set(copper), shape, bbox: shapeBBox(shape) });
      }
    } else if (it.kind === "zone" && K.kid(it.node, "keepout")) {
      const ko = K.kid(it.node, "keepout")!; const tr = K.kid(ko, "tracks"); if (!tr || K.str(tr[1]) !== "not_allowed") continue;
      const layers = new Set<string>(); for (const l of zoneLayers(it.node)) { if (l === "*.Cu" || l === "F&B.Cu") copper.forEach((c) => layers.add(c)); else layers.add(l); }
      const poly = K.kid(it.node, "polygon"); const pts = poly ? K.ptsOf(poly) : []; if (pts.length < 3) continue;
      const shape: CopperShape = { t: "poly", pts }; keepouts.push({ id: it.id, kind: "keepout", layers, shape, bbox: shapeBBox(shape) });
    }
  }
  const edges = edgeShapes(doc).shapes.map((shape): WorldItem => ({ id: null, kind: "edge", shape, bbox: shapeBBox(shape) }));
  const W = { doc, ver: S.docVer, conds, holes, keepouts, edges, copper };
  if (doc.__bc) doc.__bc.rworld = W; else { S.rworld = W; S.sworld = null; }
  return W;
}
/**
 * PNS_PCBNEW_RULE_RESOLVER::Clearance for the routed net against an obstacle: a custom rule (.kicad_dru) that
 * matches the pair decides (customRouteClearance); otherwise the larger netclass clearance, floored at the board
 * minimum, the board hole clearance for a hole and the edge clearance for the board edge.
 */
export function routeClearance(s: DesignSettings, netKey: string, ob: Pick<Obstacle, "kind" | "net"> & { id?: string | null; src?: Conductor | WorldItem }, layer?: string | null, doc?: BoardDoc | null, A?: Partial<RoutedItem>) {
  const custom = doc ? customRouteClearance(doc, s, Object.assign({ net: netKey, layer: layer || null }, A || {}), { kind: ob.kind, net: ob.net, id: ob.id, rule: ob.src ? srcRuleItem(ob.src) : null }, layer || null) : null;
  if (custom != null) return custom;
  const minC = s.minClearance || 0; const mine = Math.max(netClearance(s, netKey), minC);
  if (ob.kind === "edge") return s.edgeClearance || 0;
  if (ob.kind === "hole") return Math.max(s.holeClearance !== undefined ? s.holeClearance : 0.25, mine);
  if (ob.kind === "keepout") return 0;
  return Math.max(mine, netClearance(s, ob.net), minC);
}
/** The board item an obstacle stands for, as the rules read it (a pad with its footprint, a track, via or zone). */
export function srcRuleItem(src: Conductor | WorldItem): RuleItem | null {
  const c = src as Conductor & WorldItem;
  if (c.pad) return { kind: "pad", node: c.pad.node, parent: (c as Conductor).item || null, shape: c.shape };
  if ((c as Conductor).item) return { kind: c.kind, node: (c as Conductor).item.node, item: (c as Conductor).item, shape: c.shape };
  return null;
}
/**
 * The obstacles a route on `layer` meets: everything on the layer that is not the routed net's copper.  Pads without a
 * net block every route with a net, free pads block nothing; other net-less copper collides with every route but the
 * route's own items (`own`: the start item and the fixed segments of a route that has no net).
 */
/** PAD::IsFreePad: a pin of type free whose net is still its own "unconnected-(…)" net. */
export function isFreePad(p: PadInfo | null | undefined) {
  const t = p && p.node && K.kid(p.node, "pintype"); const n = p && p.net;
  return !!t && K.str(t[1]) === "free" && !!n && /^(.*\/)?unconnected-\(/.test(n.name || "");
}
export function routeObstacles(doc: BoardDoc, s: DesignSettings, netKey: string, layer: string, own?: Set<string> | null, skip?: Set<string> | null) {
  const W = routerWorld(doc); const out: Obstacle[] = [];
  const take = (o: Conductor | WorldItem, net: string) => { const ob = { id: o.id, kind: o.kind, net: net || "", shape: o.shape, bbox: o.bbox, src: o } as Obstacle; ob.clr = routeClearance(s, netKey, ob, layer, doc); out.push(ob); };
  for (const c of W.conds) {
    if (!c.layers.has(layer) || (skip && skip.has(c.id) && c.kind !== "pad")) continue;
    if (netKey && c.net === netKey) continue;
    // PNS ITEM::collideSimple: a net-less pad is the orphaned net's copper, an obstacle to every routed net (only a
    // net-less route shares its net); a free pad (PAD::IsFreePad) collides with nothing
    if (c.kind === "pad" && (!c.net ? !netKey : isFreePad(c.pad))) continue;
    if (own && own.has(c.id) && c.kind !== "pad") continue;
    take(c, c.net);
  }
  for (const h of W.holes) take(h, "");
  for (const k of W.keepouts) if (k.layers!.has(layer)) take(k, "");
  for (const e of W.edges) take(e, "");
  return indexObstacles(out);
}
/** The obstacle list with a coarse grid so a leg only meets the obstacles near it. */
export function indexObstacles(out: Obstacle[]): ObstacleIndex {
  const CELL = 2.5, grid = new Map<string, number[]>(); let maxClr = 0;
  out.forEach((ob, i: number) => {
    maxClr = Math.max(maxClr, ob.clr); const b = ob.bbox;
    for (let gx = Math.floor((b[0] - ob.clr) / CELL); gx <= Math.floor((b[2] + ob.clr) / CELL); gx++) for (let gy = Math.floor((b[1] - ob.clr) / CELL); gy <= Math.floor((b[3] + ob.clr) / CELL); gy++) {
      const key = gx + "," + gy; let l = grid.get(key); if (!l) grid.set(key, l = []); l.push(i);
    }
  });
  return { list: out, grid, CELL, maxClr, stamp: new Uint32Array(out.length), tick: 0 };
}
/** Obstacles whose clearance zone may reach the box [x0, y0, x1, y1] grown by r. */
export function obstaclesNear(O: ObstacleIndex, box: Box, r: number, fn: (ob: Obstacle) => boolean) {
  const C = O.CELL; O.tick++; if (O.tick > 4e9) { O.stamp.fill(0); O.tick = 1; }
  for (let gx = Math.floor((box[0] - r) / C); gx <= Math.floor((box[2] + r) / C); gx++) for (let gy = Math.floor((box[1] - r) / C); gy <= Math.floor((box[3] + r) / C); gy++) {
    const l = O.grid.get(gx + "," + gy); if (!l) continue;
    for (const i of l) { if (O.stamp[i] === O.tick) continue; O.stamp[i] = O.tick; const ob = O.list[i]; if (!boxesTouch(box, ob.bbox, r + ob.clr)) continue; if (fn(ob)) return ob; }
  }
  return null;
}
/** Does a track of half width r along a..b (a point when a === b) violate an obstacle's clearance? */
export function obstacleHit(ob: Obstacle, a: Pt, b: Pt, r: number) {
  const sh: CopperShape = samePt(a, b) ? { t: "circle", x: a[0], y: a[1], r } : { t: "seg", a, b, r };
  if (ob.kind === "keepout") return pointInPoly((ob.shape as PolyShape).pts, a[0], a[1]) || pointInPoly((ob.shape as PolyShape).pts, b[0], b[1]) || polySegDist((ob.shape as PolyShape).pts, a, b) < r - ROUTE_EPS;
  return shapeGap(sh, ob.shape) < ob.clr - ROUTE_EPS;
}
/** The first obstacle a segment hits (null when clear). */
export function segHit(O: ObstacleIndex, a: Pt, b: Pt, r: number) {
  const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  return obstaclesNear(O, box, r, (ob) => obstacleHit(ob, a, b, r));
}
/** Every obstacle a polyline (or one point) at half width r violates. */
export function pathHits(O: ObstacleIndex, pts: Pt[], r: number) {
  const out = new Set<Obstacle>();
  const segs = pts.length === 1 ? [[pts[0], pts[0]]] : pts.slice(0, -1).map((p: Pt, i: number) => [p, pts[i + 1]]);
  for (const [a, b] of segs) { const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]; obstaclesNear(O, box, r, (ob) => { if (!out.has(ob) && obstacleHit(ob, a, b, r)) out.add(ob); return false; }); }
  return Array.from(out);
}
export const pathClear = (O: ObstacleIndex, pts: Pt[], r: number) => { if (pts.length === 1) return !segHit(O, pts[0], pts[0], r); for (let i = 0; i + 1 < pts.length; i++) if (segHit(O, pts[i], pts[i + 1], r)) return false; return true; };
/** The 45° octagon around an obstacle's clearance zone for a track of half width r: where the walk turns. */
export function hullOf(ob: Obstacle, r: number): Pt[] {
  const key = r.toFixed(6); if (ob.hullKey === key) return ob.hull!;
  const core = shapeCorePts(ob.shape), off = (ob.kind === "keepout" ? 0 : shapeOffset(ob.shape) + ob.clr) + r + HULL_EPS;
  const h = DIRS8.map((u) => { let m = -Infinity; for (const p of core) m = Math.max(m, p[0] * u[0] + p[1] * u[1]); return m + off; });
  const out: Pt[] = [];
  for (let k = 0; k < 8; k++) {
    const u0 = DIRS8[k], u1 = DIRS8[(k + 1) % 8], h0 = h[k], h1 = h[(k + 1) % 8]; const det = u0[0] * u1[1] - u0[1] * u1[0];
    out.push([(h0 * u1[1] - h1 * u0[1]) / det, (u0[0] * h1 - u1[0] * h0) / det]);
  }
  ob.hullKey = key; ob.hull = out; return out;
}
/** DIRECTION_45 of a vector: 0 = E, 1 = SE (y down), … 7 = NE; -1 for a null vector. */
export function dir8(a: Pt, b: Pt) { const dx = b[0] - a[0], dy = b[1] - a[1]; if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return -1; return (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8; }
/** DIRECTION_45::Angle: 0 straight, 1 obtuse, 2 right, 3 acute, 4 half full (a U-turn). */
export const dirAngle = (d1: number, d2: number) => { const d = Math.abs(d1 - d2) % 8; return d > 4 ? 8 - d : d; };
export const isDiagDir = (d: number) => d >= 0 && d % 2 === 1;
/** A leg as a point list (routeLeg's segments joined). */
export const legPts45 = (a: Pt, b: Pt, diagFirst: boolean) => legPts(a, b, diagFirst);
export function legPts(a: Pt, b: Pt, diagFirst: boolean): Pt[] { const segs = routeLeg(a, b, diagFirst); return segs.length ? [segs[0][0]].concat(segs.map((s) => s[1])) : [a.slice()]; }
/** SHAPE_LINE_CHAIN::Simplify: drop repeated points and merge colinear segments. */
export function simplifyPts(pts: Pt[]) {
  const out: Pt[] = [];
  for (const p of pts) {
    if (out.length && samePt(out[out.length - 1], p)) continue;
    if (out.length >= 2) { const a = out[out.length - 2], b = out[out.length - 1]; if (dir8(a, b) === dir8(b, p) && Math.abs((b[0] - a[0]) * (p[1] - b[1]) - (b[1] - a[1]) * (p[0] - b[0])) < 1e-9) { out[out.length - 1] = p.slice(); continue; } }
    out.push(p.slice());
  }
  return out;
}
/** The point of a polyline at arc length t. */
export function alongPts(pts: Pt[], t: number) {
  for (let i = 0; i + 1 < pts.length; i++) { const a = pts[i], b = pts[i + 1]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (t <= L || i + 2 === pts.length) { const k = L > 0 ? Math.min(1, t / L) : 0; return { i, p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k] }; } t -= L; }
  return { i: 0, p: pts[0].slice() };
}
export const ptsLength = (pts: Pt[]) => { let L = 0; for (let i = 0; i + 1 < pts.length; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); return L; };
/** A clear polyline cut where it first violates clearance (cursorDistMinimum's fallback: the head just stops short). */
export function clipPts(O: ObstacleIndex, pts: Pt[], r: number) {
  if (segHit(O, pts[0], pts[0], r)) return [pts[0].slice()];
  let lo = 0, hi = ptsLength(pts);
  const clearTo = (t: number) => { const { i, p } = alongPts(pts, t); return pathClear(O, pts.slice(0, i + 1).concat([p]), r); };
  if (clearTo(hi)) return pts.map((p: Pt) => p.slice());
  for (let n = 0; n < 24; n++) { const m = (lo + hi) / 2; if (clearTo(m)) lo = m; else hi = m; }
  const { i, p } = alongPts(pts, lo); return simplifyPts(pts.slice(0, i + 1).concat([[r6(p[0]), r6(p[1])]]));
}
// ================================================================ SHAPE_LINE_CHAIN in whole nanometres
// The walkaround works on KiCad's integer coordinates: points are rounded to the nanometre (mm × 1e6) going in and
// come back as mm, so the exact point comparisons, Split / Find / PointOnEdge thresholds and the hull graph behave as
// in pns_line.cpp.  A closed chain (a hull) has a closing segment from its last point back to the first.
export type NmPt = number[];
export const toNm = (p: Pt): NmPt => [Math.round(p[0] * 1e6), Math.round(p[1] * 1e6)];
export const fromNm = (p: NmPt): Pt => [r6(p[0] / 1e6) + 0, r6(p[1] / 1e6) + 0];
const ieq = (a: NmPt, b: NmPt) => a[0] === b[0] && a[1] === b[1];
const peqPt = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 5e-7 && Math.abs(a[1] - b[1]) < 5e-7;
const segCount = (c: NmPt[], closed: boolean) => (c.length < 2 ? 0 : closed ? c.length : c.length - 1);
/** CSegment( i ) of a chain; a negative index counts from the end. */
const cseg = (c: NmPt[], closed: boolean, i: number): [NmPt, NmPt] => { const n = segCount(c, closed); if (i < 0) i += n; return [c[i], c[(i + 1) % c.length]]; };
/** SEG::SquaredDistance. */
export function segSqDist(a: NmPt, b: NmPt, p: NmPt) {
  const abx = b[0] - a[0], aby = b[1] - a[1], apx = p[0] - a[0], apy = p[1] - a[1]; const e = apx * abx + apy * aby;
  if (e <= 0) return apx * apx + apy * apy;
  const f = abx * abx + aby * aby;
  if (e >= f) { const bx = p[0] - b[0], by = p[1] - b[1]; return bx * bx + by * by; }
  const cr = abx * apy - aby * apx; return Math.round(cr * cr / f);
}
const segContains = (a: NmPt, b: NmPt, p: NmPt) => segSqDist(a, b, p) <= 3;
/** SEG::Side: the sign of ( B - A ) × ( p - A ). */
export const segSide = (a: NmPt, b: NmPt, p: NmPt) => { const d = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); return d < 0 ? -1 : d > 0 ? 1 : 0; };
/** SEG::Collinear: both ends of c..d within 1 of the line a..b in its canonical coefficients. */
function segCollinear(a: NmPt, b: NmPt, c: NmPt, d: NmPt) {
  const qa = a[1] - b[1], qb = b[0] - a[0];
  return Math.abs(qa * (c[0] - a[0]) + qb * (c[1] - a[1])) <= 1 && Math.abs(qa * (d[0] - a[0]) + qb * (d[1] - a[1])) <= 1;
}
/** SEG::Intersect( aSeg ) of two non-parallel segments, ends included (parallel ones never cross here). */
function segCross(a1: NmPt, b1: NmPt, a2: NmPt, b2: NmPt): NmPt | null {
  if (Math.max(a1[0], b1[0]) < Math.min(a2[0], b2[0]) || Math.max(a2[0], b2[0]) < Math.min(a1[0], b1[0]) || Math.max(a1[1], b1[1]) < Math.min(a2[1], b2[1]) || Math.max(a2[1], b2[1]) < Math.min(a1[1], b1[1])) return null;
  const d1x = b1[0] - a1[0], d1y = b1[1] - a1[1], d2x = b2[0] - a2[0], d2y = b2[1] - a2[1], ox = a2[0] - a1[0], oy = a2[1] - a1[1];
  const det = d2x * d1y - d2y * d1x; if (det === 0) return null;
  const p2 = d2x * oy - d2y * ox, p1 = d1x * oy - d1y * ox;
  if (det > 0 ? (p1 < 0 || p1 > det || p2 < 0 || p2 > det) : (p1 > 0 || p1 < det || p2 > 0 || p2 < det)) return null;
  return [a2[0] + Math.round(p1 * d2x / det), a2[1] + Math.round(p1 * d2y / det)];
}
/** SEG::NearestPoint. */
export function segNearestNm(a: NmPt, b: NmPt, p: NmPt): NmPt {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; if (!l2) return a.slice();
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2; if (t <= 0) return a.slice(); if (t >= 1) return b.slice();
  return [a[0] + Math.round(t * dx), a[1] + Math.round(t * dy)];
}
const nmLen = (a: NmPt, b: NmPt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
/** SHAPE_LINE_CHAIN::Length (of an open chain). */
export const chainLength = (c: NmPt[]) => { let L = 0; for (let i = 0; i + 1 < c.length; i++) L += nmLen(c[i], c[i + 1]); return L; };
/** SHAPE_LINE_CHAIN_BASE::PointOnEdge( p, accuracy 0 ): within one nanometre of an edge. */
export function chainOnEdge(c: NmPt[], closed: boolean, p: NmPt) {
  if (!c.length) return false; if (c.length === 1) { const dx = c[0][0] - p[0], dy = c[0][1] - p[1]; return dx * dx + dy * dy <= 1; }
  for (let i = 0; i < segCount(c, closed); i++) { const [a, b] = cseg(c, closed, i); if (ieq(a, p) || ieq(b, p) || segSqDist(a, b, p) <= 1) return true; }
  return false;
}
/** SHAPE_LINE_CHAIN::PointInside of a closed chain (the ray test; a point on the outline may go either way). */
export function chainInside(c: NmPt[], p: NmPt) {
  if (c.length < 3) return false; let inside = false;
  for (let i = 0; i < c.length; i++) {
    const p1 = c[i], p2 = c[(i + 1) % c.length]; const dx = p2[0] - p1[0], dy = p2[1] - p1[1]; if (dy === 0) continue;
    const d = Math.round(dx * (p[1] - p1[1]) / dy);
    if ((p1[1] >= p[1]) !== (p2[1] >= p[1]) && p[0] - p1[0] < d) inside = !inside;
  }
  return inside;
}
/** SHAPE_LINE_CHAIN::Find: the index of the point (within aThreshold nm), or -1. */
export function chainFind(c: NmPt[], p: NmPt, thr = 0) { for (let i = 0; i < c.length; i++) if (thr === 0 ? ieq(c[i], p) : nmLen(c[i], p) <= thr) return i; return -1; }
/** SHAPE_LINE_CHAIN::Split( p ): a vertex at p on the segment it lies on (within 2 nm); its index, or -1. */
export function chainSplit(c: NmPt[], closed: boolean, p: NmPt) {
  const found = chainFind(c, p); let ii = -1, minD = 2;
  for (let s = 0; s < segCount(c, closed); s++) {
    const [a, b] = cseg(c, closed, s); const d = Math.round(Math.sqrt(segSqDist(a, b, p)));
    if (d < minD && !ieq(a, p) && !ieq(b, p)) { minD = d; if (found < 0 || s < found) ii = s; }
  }
  if (ii < 0) ii = found; if (ii < 0) return -1;
  if (ieq(c[ii], p)) return ii;
  c.splice(ii + 1, 0, p.slice()); return ii + 1;
}
/** SHAPE_LINE_CHAIN::PathLength( p, index ): the length along the chain up to p on segment `index`. */
function chainPathLength(c: NmPt[], p: NmPt, index: number) {
  let sum = 0; const n = segCount(c, false);
  for (let i = 0; i < n; i++) { const match = index === n ? i === n - 1 : i === index; if (match) return sum + Math.round(nmLen(c[i], p)); sum += Math.round(nmLen(c[i], c[i + 1])); }
  return -1;
}
/** SHAPE_LINE_CHAIN::Simplify2( aRemoveColinear ): duplicate points out, then (optionally) the colinear ones. */
export function chainSimplify2(c: NmPt[], removeColinear = true): NmPt[] {
  if (c.length < 3) return c.map((p) => p.slice());
  if (c.length === 3) { const out = c.map((p) => p.slice()); if (ieq(out[0], out[1]) || ieq(out[1], out[2])) out.splice(1, 1); return out; }
  const u: NmPt[] = []; for (const p of c) if (!u.length || !ieq(u[u.length - 1], p)) u.push(p.slice());
  const np = u.length, out: NmPt[] = []; let i = 0;
  const lineDist = (a: NmPt, b: NmPt, p: NmPt) => { const L = nmLen(a, b); return L ? Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / L : nmLen(a, p); };
  while (i < np - 2) {
    const p0 = u[i]; let n = i;
    if (removeColinear) while (n < np - 2 && (lineDist(p0, u[n + 2], u[n + 1]) <= 1 || segCollinear(p0, u[n + 2], p0, u[n + 1]))) n++;
    out.push(p0); if (n > i) i = n;
    if (n === np - 2) { out.push(u[np - 1]); return out; }
    i++;
  }
  if (np > 1) out.push(u[np - 2]); out.push(u[np - 1]);
  return out;
}
/** SHAPE_LINE_CHAIN::SelfIntersecting of an open chain: the first place two of its segments meet, or null. */
function chainSelfIntersecting(c: NmPt[]): NmPt | null {
  const n = segCount(c, false); if (n < 2) return null;
  for (let s1 = 0; s1 < n; s1++) for (let s2 = s1 + 1; s2 < n; s2++) {
    const a1 = c[s1], b1 = c[s1 + 1], a2 = c[s2], b2 = c[s2 + 1];
    if (s1 + 1 !== s2 && segContains(a1, b1, a2)) return a2.slice();
    if (segContains(a1, b1, b2)) return b2.slice();
    const p = segCross(a1, b1, a2, b2);
    if (p) { const ends = (ieq(p, a1) || ieq(p, b1)) && (ieq(p, a2) || ieq(p, b2)); if (!ends) return p; }   // Intersect( seg, aIgnoreEndpoints = true )
  }
  return null;
}
/** One crossing of a hull (ours, closed) and a line (theirs): SHAPE_LINE_CHAIN::INTERSECTION. */
interface ChainIP { p: NmPt; our: number; their: number; cOur: boolean; cTheir: boolean }
/** SHAPE_LINE_CHAIN::Intersect( chain ) for a closed hull against an open line, colinear overlaps as corner points. */
function chainIntersect(hull: NmPt[], line: NmPt[]): ChainIP[] {
  const out: ChainIP[] = []; const nh = segCount(hull, true), nl = segCount(line, false);
  for (let s1 = 0; s1 < nh; s1++) {
    const [a, b] = cseg(hull, true, s1);
    for (let s2 = 0; s2 < nl; s2++) {
      const c = line[s2], d = line[s2 + 1];
      if (segCollinear(a, b, c, d)) {
        if (segContains(a, b, c)) out.push({ p: c.slice(), our: s1, their: s2, cOur: false, cTheir: true });
        if (segContains(a, b, d)) out.push({ p: d.slice(), our: s1, their: s2 + 1, cOur: false, cTheir: true });
        if (segContains(c, d, a)) out.push({ p: a.slice(), our: s1, their: s2, cOur: true, cTheir: false });
        if (segContains(c, d, b)) out.push({ p: b.slice(), our: s1 + 1, their: s2, cOur: true, cTheir: false });
        continue;
      }
      const p = segCross(a, b, c, d); if (!p) continue;
      const ip: ChainIP = { p, our: s1, their: s2, cOur: false, cTheir: false };
      if (ieq(p, a)) ip.cOur = true;
      if (ieq(p, b)) { ip.cOur = true; ip.our++; }
      if (ieq(p, c)) ip.cTheir = true;
      if (ieq(p, d)) { ip.cTheir = true; ip.their++; }
      out.push(ip);
    }
  }
  return out;
}
/** HullIntersection (pns_utils.cpp): the line's crossings of the hull, a touch at a corner only when the line goes inside. */
export function hullIntersection(hull: NmPt[], line: NmPt[]): ChainIP[] {
  const ips: ChainIP[] = []; if (line.length < 2) return ips; const nh = segCount(hull, true);
  for (const p0 of chainIntersect(hull, line)) {
    if (!p0.cOur && !p0.cTheir) { ips.push(p0); continue; }
    const p = Object.assign({}, p0); if (p.our >= nh) p.our -= nh;
    const d1: [NmPt, NmPt][] = p.cOur ? [cseg(hull, true, p.our), cseg(hull, true, p.our - 1)] : [cseg(hull, true, p.our)];
    const d2: NmPt[] = [];
    if (p.cTheir) { if (p.their > 0) d2.push(line[p.their - 1]); if (p.their < line.length - 1) d2.push(line[p.their + 1]); }
    else { d2.push(line[p.their], line[p.their + 1]); }
    let valid = false; for (const [a, b] of d1) for (const q of d2) if (segSide(a, b, q) > 0) valid = true;
    if (valid) ips.push(p0);
  }
  return ips;
}

// ================================================================ LINE::Walkaround (pns_line.cpp)
/**
 * The line `path` (nm) walked round the convex hull `hull` (clockwise in y-down screen coordinates, as KiCad's hulls
 * are): the line's and the hull's vertices with every crossing split into both make a graph that is walked from the
 * line's first point, along the line while outside the hull and along the hull (in its order for cw, against it
 * otherwise) while the line is inside.  When the line ends inside the hull the walk stops at the hull point nearest the
 * end.  null when it cannot be walked (the line starts inside the hull, or the graph leads nowhere).
 */
export function lineWalkaround(path: NmPt[], hull: NmPt[], cw: boolean): NmPt[] | null {
  if (path.length < 2) return null;
  const pFirst = path[0], last = path[path.length - 1];
  if (chainInside(hull, pFirst) && !chainOnEdge(hull, true, pFirst)) return null;
  const ips = hullIntersection(hull, path);
  const pnew = path.map((p) => p.slice()); let hnew = hull.map((p) => p.slice());
  const si = chainSelfIntersecting(pnew); if (si && !ieq(si, pnew[pnew.length - 1])) chainSplit(pnew, false, si);
  for (const ip of ips) { if (chainFind(pnew, ip.p, 1) < 0) chainSplit(pnew, false, ip.p); if (chainFind(hnew, ip.p, 1) < 0) chainSplit(hnew, true, ip.p); }
  for (let i = 0; i < pnew.length; i++) { const p = pnew[i]; if (!chainOnEdge(hnew, true, p)) continue; if (chainFind(hnew, p) < 0) chainSplit(hnew, true, p); }
  if (!cw) hnew = hnew.slice().reverse();
  const INSIDE = 0, OUTSIDE = 1, ON_EDGE = 2;
  interface V { type: number; isHull: boolean; pos: NmPt; nb: V[]; ip: number; ih: number; visited: boolean }
  const vts: V[] = [];
  const findV = (p: NmPt) => { for (const v of vts) if (ieq(v.pos, p)) return v; return null; };
  for (let i = 0; i < pnew.length; i++) {
    const p = pnew[i]; const onEdge = chainOnEdge(hnew, true, p), inside = chainInside(hnew, p);
    vts.push({ type: inside && !onEdge ? INSIDE : onEdge ? ON_EDGE : OUTSIDE, isHull: false, pos: p, nb: [], ip: i, ih: -1, visited: false });
  }
  for (let i = 0; i < pnew.length - 1; i++) vts[i].nb.push(vts[i + 1]);
  for (let i = 1; i < pnew.length; i++) vts[i].nb.push(vts[i - 1]);
  for (let i = 0; i < hnew.length; i++) { const vn = findV(hnew[i]); if (vn) { vn.isHull = true; vn.ih = i; } else vts.push({ type: ON_EDGE, isHull: true, pos: hnew[i], nb: [], ip: -1, ih: i, visited: false }); }
  for (let i = 0; i < hnew.length; i++) { const vc = findV(hnew[i]), vnext = findV(hnew[(i + 1) % hnew.length]); if (vc && vnext) vc.nb.push(vnext); }
  const neighbours = (x: number, y: number, max: number) => (x > 0 && x - 1 === y) || (x < max - 1 && x + 1 === y);
  const inLast = chainInside(hull, last) && !chainOnEdge(hull, true, last); let appendV = true, lastDst = Infinity;
  let v: V | null = vts[0], vPrev: V | null = null; const out: NmPt[] = []; let iterLimit = 1000;
  while (v!.ip !== pnew.length - 1) {
    if (--iterLimit === 0) return null;
    if (v!.visited) break;
    out.push(v!.pos.slice());
    let vNext: V | null = null;
    if (v!.type === OUTSIDE) {
      out.push(v!.pos.slice()); let fallback: V | null = null;
      for (const vn of v!.nb) if (neighbours(vn.ip, v!.ip, pnew.length) && vn.type !== INSIDE) { if (!vn.visited) { vNext = vn; break; } else if (vn !== vPrev) fallback = vn; }
      if (!vNext) vNext = fallback;
      if (!vNext) return null;
    } else if (v!.type === ON_EDGE) {
      for (const vn of v!.nb) if (vn.type === OUTSIDE && !vn.visited) { vNext = vn; break; }
      if (!vNext) for (const vn of v!.nb) if (vn.type === ON_EDGE && !vn.isHull && neighbours(vn.ip, v!.ip, pnew.length) && vn.ih === (v!.ih + 1) % hnew.length) { vNext = vn; break; }
      if (!vNext) {
        for (const vn of v!.nb) if (vn.type === ON_EDGE && vn.ih === (v!.ih + 1) % hnew.length) { vNext = vn; break; }
        if (vNext) for (const vt of vts) if (vt.isHull) vt.visited = false;
        if (inLast && vNext) {
          const dx = vNext.pos[0] - last[0], dy = vNext.pos[1] - last[1], d = dx * dx + dy * dy;
          if (d < lastDst) lastDst = d;
          else { out.push(segNearestNm(v!.pos, vNext.pos, last)); appendV = false; break; }
        }
      }
    }
    v!.visited = true; vPrev = v; v = vNext;
    if (!v) return null;
  }
  if (appendV) out.push(v!.pos.slice());
  return chainSimplify2(out, false);
}

// ================================================================ WALKAROUND (pns_walkaround.cpp)
export const WP_CW = 0, WP_CCW = 1, WP_SHORTEST = 2;
export const ST_IN_PROGRESS = 0, ST_ALMOST_DONE = 1, ST_DONE = 2, ST_STUCK = 3, ST_NONE = 4;
/** ADVANCED_CFG::m_PNSProcessClusterTimeout: a cluster that is not walked round within this many ms gives up. */
export const PNS_PROCESS_CLUSTER_TIMEOUT = 100;
/** WALKAROUND's options: the policies, iteration limit (WalkaroundIterationLimit), length limit and corner mode. */
export interface WalkOpts { policies: number[]; iterLimit?: number; lengthLimit?: boolean; lengthFactor?: number; anyComplete?: boolean; cornerMode?: number; filter?: ((ob: Obstacle) => boolean) | null }
export interface WalkResult { status: number[]; lines: NmPt[][] }
/** HullCache( item, clearance, width ) as the walk uses it, in nm; the 90° corner modes walk round its bounding box. */
export function walkHull(ob: Obstacle, r: number, cm?: number): NmPt[] {
  const key = r.toFixed(6) + "|" + (cm === 2 || cm === 3 ? 1 : 0);
  if (ob.whKey === key) return ob.wh as NmPt[];
  // the octagon of hullOf at exactly the clearance (SegmentHull / OctagonalHull put their edges at clearance + half
  // width; a line on an edge keeps the clearance, the collision test's epsilon absorbs the nanometre rounding)
  const core = shapeCorePts(ob.shape), off = (ob.kind === "keepout" ? 0 : shapeOffset(ob.shape) + ob.clr) + r;
  const hd = DIRS8.map((u) => { let m = -Infinity; for (const p of core) m = Math.max(m, p[0] * u[0] + p[1] * u[1]); return m + off; });
  let h: NmPt[] = [];
  for (let k = 0; k < 8; k++) { const u0 = DIRS8[k], u1 = DIRS8[(k + 1) % 8], h0 = hd[k], h1 = hd[(k + 1) % 8]; const det = u0[0] * u1[1] - u0[1] * u1[0]; h.push(toNm([(h0 * u1[1] - h1 * u0[1]) / det, (u0[0] * h1 - u1[0] * h0) / det])); }
  if (cm === 2 || cm === 3) {   // MITERED_90 / ROUNDED_90: BBox() of the hull, clockwise from the top left
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of h) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    h = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }
  ob.whKey = key; ob.wh = h; return h;
}
const nmPathHits = (O: ObstacleIndex, line: NmPt[], r: number, filter?: ((ob: Obstacle) => boolean) | null) => { const hs = pathHits(O, line.map(fromNm), r); return filter ? hs.filter(filter) : hs; };
/**
 * NODE::NearestObstacle( line ): of the obstacles the line collides with, the one whose hull it crosses first along
 * its length (the first colliding one when no crossing is found).
 */
export function walkNearestObstacle(O: ObstacleIndex, line: NmPt[], r: number, cm?: number, filter?: ((ob: Obstacle) => boolean) | null): Obstacle | null {
  const obs = nmPathHits(O, line, r, filter); if (!obs.length) return null;
  let best: Obstacle | null = null, bd = Infinity;
  for (const ob of obs) {
    let d = Infinity;
    for (const ip of hullIntersection(walkHull(ob, r, cm), line)) { const L = chainPathLength(line, ip.p, ip.their); if (L >= 0 && L < d) d = L; }
    if (d < bd) { bd = d; best = ob; if (d === 0) break; }
  }
  return best || obs[0];
}
/**
 * TOPOLOGY::AssembleCluster: the obstacle and everything that touches it within `margin` (2 × its clearance + the line
 * width), transitively, on the layer — two tracks of different nets never join a cluster through each other.
 */
export function walkCluster(O: ObstacleIndex, seed: Obstacle, margin: number): Obstacle[] {
  const out: Obstacle[] = [seed], seen = new Set<Obstacle>([seed]), pending: Obstacle[] = [seed];
  while (pending.length) {
    const top = pending.shift()!;
    obstaclesNear(O, top.bbox, margin, (ob) => {
      if (seen.has(ob)) return false;
      if (ob.net !== top.net && ob.kind === "segment" && top.kind === "segment") return false;   // trackOnTrack
      let g: number; try { g = shapeGap(top.shape, ob.shape); } catch { g = Infinity; }
      if (!(g < margin)) return false;
      seen.add(ob); out.push(ob); pending.push(ob); return false;
    });
  }
  return out;
}
/**
 * WALKAROUND::Route( initialPath ): each enabled policy (clockwise, counter-clockwise, shortest) walks its own copy of
 * the line: the nearest obstacle's cluster is walked round item by item (LINE::Walkaround on each hull), until nothing
 * collides (ST_DONE), a walk fails (ST_STUCK), the iteration limit runs out or the line grows past lengthFactor times
 * its first length (ST_ALMOST_DONE).  A line that no longer starts at the start is stuck; one that no longer ends at the
 * end is almost done.
 */
export function walkaroundRoute(O: ObstacleIndex, init: NmPt[], r: number, wo: WalkOpts): WalkResult {
  const iterLimit = wo.iterLimit || 40, lengthLimit = wo.lengthLimit !== false, factor = wo.lengthFactor || 10, cm = wo.cornerMode, filter = wo.filter || null;
  const en = [false, false, false]; for (const p of wo.policies) en[p] = true;
  const res: WalkResult = { status: [ST_NONE, ST_NONE, ST_NONE], lines: [[], [], []] };
  for (let p = 0; p < 3; p++) { res.status[p] = ST_IN_PROGRESS; res.lines[p] = init.map((q) => q.slice()); }
  const initLen = chainLength(init); const processed = new Set<Obstacle>();
  const processCluster = (cluster: Obstacle[], line: NmPt[], cw: boolean): NmPt[] | null => {
    const t0 = now(); let cur = line;
    for (const ob of cluster) {
      if (now() - t0 > PNS_PROCESS_CLUSTER_TIMEOUT) return null;
      const hull = walkHull(ob, r, cm); cur = chainSimplify2(cur);
      const w = lineWalkaround(cur, hull, cw); if (!w) return null; cur = w;
    }
    return cur;
  };
  for (let iter = 0; iter < iterLimit; iter++) {
    const pending: (Obstacle[] | null)[] = [null, null, null];
    for (let i = 0; i < 3; i++) {
      if (!en[i] || res.status[i] !== ST_IN_PROGRESS) continue;
      const ob = walkNearestObstacle(O, res.lines[i], r, cm, filter);
      if (!ob) { res.status[i] = ST_DONE; continue; }
      pending[i] = walkCluster(O, ob, 2 * ob.clr + 2 * r);
    }
    for (const pol of [WP_CW, WP_CCW]) {
      if (!en[pol] || !pending[pol]) continue;
      const w = processCluster(pending[pol]!, res.lines[pol], pol === WP_CW); if (!w) res.status[pol] = ST_STUCK; else res.lines[pol] = w;
    }
    if (en[WP_SHORTEST] && pending[WP_SHORTEST]) {
      const line = res.lines[WP_SHORTEST]; const cwP = processCluster(pending[WP_SHORTEST]!, line, true), ccwP = processCluster(pending[WP_SHORTEST]!, line, false);
      const coll = (l: NmPt[]) => nmPathHits(O, l, r, filter).length > 0;
      const cwC = cwP ? coll(cwP) : false, ccwC = ccwP ? coll(ccwP) : false;
      let shortest: NmPt[] | null = null, alt: NmPt[] | null = null;
      if (cwP && ccwP) {
        if ((!cwC && !ccwC) || (cwC && ccwC)) { if (chainLength(cwP) > chainLength(ccwP)) { shortest = ccwP; alt = cwP; } else { shortest = cwP; alt = ccwP; } }
        else if (!cwC) shortest = cwP; else if (!ccwC) shortest = ccwP;
      } else if (ccwP) shortest = ccwP; else if (cwP) shortest = cwP;
      if (shortest && processed.size && nmPathHits(O, shortest, r, filter).some((ob) => processed.has(ob))) shortest = alt;
      if (!shortest) res.status[WP_SHORTEST] = ST_STUCK; else res.lines[WP_SHORTEST] = shortest;
      for (const ob of pending[WP_SHORTEST]!) processed.add(ob);
    }
    let still = false, finished = false;
    for (let p = 0; p < 3; p++) {
      if (!en[p]) continue;
      if (res.status[p] === ST_DONE && wo.anyComplete) { finished = true; break; }
      const lf = initLen ? chainLength(res.lines[p]) / initLen : Infinity;
      if (lengthLimit && res.status[p] !== ST_DONE && lf > factor) res.status[p] = ST_ALMOST_DONE;
      if (res.status[p] === ST_IN_PROGRESS) still = true;
    }
    if (!still || finished) break;
  }
  for (let p = 0; p < 3; p++) {
    const ln = res.lines[p];
    if (res.status[p] === ST_IN_PROGRESS) res.status[p] = ST_ALMOST_DONE;
    if (ln.length < 2 || !ieq(ln[0], init[0])) res.status[p] = ST_STUCK;
    if (ln.length > 0 && !ieq(ln[ln.length - 1], init[init.length - 1])) res.status[p] = ST_ALMOST_DONE;
  }
  return res;
}

// ================================================================ LINE_PLACER's walk (pns_line_placer.cpp)
/** LINE_PLACER::splitHeadTail: a walked line (tail + head) cut back into the part that keeps the old tail and the new head. */
export function splitHeadTail(line: Pt[], oldTail: Pt[]): { head: Pt[]; tail: Pt[] } {
  const l2 = line.map(toNm); const n = l2.length;
  if (n > 1 && oldTail.length > 1) {
    const ot = oldTail.map(toNm); const tl = ot[ot.length - 1];
    if (chainOnEdge(l2, false, tl)) chainSplit(l2, false, tl);
    let i: number, found = false;
    for (i = 0; i < ot.length; i++) if (chainFind(l2, ot[i]) < 0) { found = true; break; }
    if (!found) i--;
    if (i >= l2.length) i = l2.length - 1;
    return { tail: i === 0 ? [] : l2.slice(0, i + 1).map(fromNm), head: l2.slice(i).map(fromNm) };
  }
  return { tail: [], head: line.map((p) => p.slice()) };
}
/** clipAndCheckCollisions: the line up to aP when it is longer than the best so far and clear; { out, dist } or null. */
function clipAndCheck(O: ObstacleIndex, r: number, aP: NmPt, L: NmPt[], threshold: number): { out: NmPt[]; dist: number } | null {
  const l = L.map((p) => p.slice()); const idx = chainSplit(l, false, aP); if (idx < 0) return null;
  const l2 = l.slice(0, idx + 1); const dist = Math.round(chainLength(l2));
  if (dist < threshold) return null;
  if (nmPathHits(O, l2, r).length) return null;
  return { out: l2, dist };
}
/**
 * LINE_PLACER::cursorDistMinimum: of the walked line's vertices (and the points nearest the cursor on its segments)
 * within lengthThreshold of its start, the one nearest the cursor — the line clipped there when that is clear, else the
 * longest clear clip at any of them.  null when none is clear.
 */
export function cursorDistMinimum(O: ObstacleIndex, r: number, L: NmPt[], cursor: NmPt, lengthThreshold: number): NmPt[] | null {
  if (!L.length) return null;
  const dists: number[] = [], pts: NmPt[] = []; let lastP = L[L.length - 1], acc = 0;
  for (let i = 0; i + 1 < L.length; i++) {
    const a = L[i], b = L[i + 1];
    dists.push(Math.round(nmLen(cursor, a))); pts.push(a);
    const pn = segNearestNm(a, b, cursor); if (!ieq(pn, a) && !ieq(pn, b)) { dists.push(Math.round(nmLen(pn, cursor))); pts.push(pn); }
    acc += Math.round(nmLen(a, b));
    if (acc > lengthThreshold) { lastP = b; break; }
  }
  dists.push(Math.round(nmLen(cursor, lastP))); pts.push(lastP);
  let minG = Infinity, pG = -1; for (let i = 0; i < dists.length; i++) if (dists[i] < minG) { minG = dists[i]; pG = i; }
  const pref = clipAndCheck(O, r, pts[pG], L, 0); if (pref) return pref.out;
  let thr = 0, out: NmPt[] | null = null;
  for (const p of pts) { const c = clipAndCheck(O, r, p, L, thr); if (c) { out = c.out; thr = c.dist; } }
  return out;
}
/** What rhWalkBase needs from the placer: the tail, where the head starts, its initial line and the optimizer. */
export interface WalkBaseOpts {
  /** the tail as it is when the initial line has been built (buildInitialLine may drop it) */
  tail(): Pt[]; cursor: Pt; r: number; cornerMode?: number; iterLimit?: number; hugThreshold?: number; placingVia?: boolean;
  /** what a clipped walk is checked against (m_currentNode->CheckColliding: every item, also when the walk is for the solids only) */
  checkO?: ObstacleIndex;
  /** buildInitialLine( p ): the head's initial line towards p (with the carried via pushed out of what it meets) */
  initial(p: Pt, round: number): Pt[];
  /** OPTIMIZER::Optimize( line, MERGE_SEGMENTS ) against the walk's obstacles */
  optimize(pts: Pt[]): Pt[];
}
/**
 * LINE_PLACER::rhWalkBase: the tail and the initial head walked round everything in O both ways (WP_CCW, WP_CW).  A
 * walk that completes is optimized (MERGE_SEGMENTS on the whole line, then on its head); the shorter one is taken when
 * it is under 2 × hug threshold × the initial length.  Otherwise each walk is clipped where it comes closest to the
 * cursor within hug threshold × the initial length (cursorDistMinimum) and the nearer clip wins.  With a via in hand
 * the walk is done twice, the second time towards where the first one ended.  The walked line (tail + head), or null.
 */
export function rhWalkBase(O: ObstacleIndex, wb: WalkBaseOpts): Pt[] | null {
  let walkFull: Pt[] | null = null; let walkP = wb.cursor.slice(); let round = 0; const aP = toNm(wb.cursor);
  do {
    round++;
    const l1 = wb.initial(walkP, round); const tail = wb.tail();
    const initTrack = simplifyPts(tail.length && l1.length && peqPt(tail[tail.length - 1], l1[0]) ? tail.concat(l1.slice(1)) : tail.concat(l1)).map(toNm);
    const initialLength = chainLength(initTrack), thr = wb.hugThreshold || 1.5;
    const hugLen = initialLength * thr, hugLenComplete = 2 * initialLength * thr;
    if (initTrack.length < 2) { walkFull = initTrack.map(fromNm); walkP = walkFull[walkFull.length - 1]; continue; }
    const wr = walkaroundRoute(O, initTrack, wb.r, { policies: [WP_CCW, WP_CW], iterLimit: wb.iterLimit, cornerMode: wb.cornerMode });
    let best: NmPt[] | null = null;
    let lenCw = wr.status[WP_CW] !== ST_STUCK ? Math.round(chainLength(wr.lines[WP_CW])) : Infinity, lenCcw = wr.status[WP_CCW] !== ST_STUCK ? Math.round(chainLength(wr.lines[WP_CCW])) : Infinity;
    const finish = (pol: number) => {
      let full = wb.optimize(wr.lines[pol].map(fromNm));
      const sp = splitHeadTail(full, tail); full = simplifyPts(sp.tail.concat(wb.optimize(sp.head)));
      wr.lines[pol] = full.map(toNm); return Math.round(chainLength(wr.lines[pol]));
    };
    if (wr.status[WP_CW] === ST_DONE) { lenCw = finish(WP_CW); best = wr.lines[WP_CW]; }
    if (wr.status[WP_CCW] === ST_DONE) { lenCcw = finish(WP_CCW); if (lenCcw < lenCw) best = wr.lines[WP_CCW]; }
    const bestLength = Math.min(lenCw, lenCcw);
    if (bestLength < hugLenComplete && best) { walkFull = best.map(fromNm); walkP = walkFull[walkFull.length - 1]; continue; }
    let lCw: NmPt[] | null = null, lCcw: NmPt[] | null = null, dCw = Infinity, dCcw = Infinity;
    if (wr.status[WP_CW] !== ST_STUCK) { lCw = cursorDistMinimum(wb.checkO || O, wb.r, wr.lines[WP_CW], aP, hugLen); if (lCw) dCw = Math.round(nmLen(aP, lCw[lCw.length - 1])); }
    if (wr.status[WP_CCW] !== ST_STUCK) { lCcw = cursorDistMinimum(wb.checkO || O, wb.r, wr.lines[WP_CCW], aP, hugLen); if (lCcw) dCcw = Math.round(nmLen(aP, lCcw[lCcw.length - 1])); }
    if (dCw < dCcw && lCw) walkFull = lCw.map(fromNm);
    else if (lCcw) walkFull = lCcw.map(fromNm);
    else return null;
    walkP = walkFull[walkFull.length - 1];
  } while (round < 2 && wb.placingVia);
  return walkFull;
}
export const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
/** The router settings the walk reads: corner mode, WalkaroundIterationLimit, WalkaroundHugLengthThreshold. */
const walkSettings = () => ({ cornerMode: S.rs.corner_mode, iterLimit: S.rs.walkaround_iteration_limit || 40, hugThreshold: S.rs.walkaround_hug_length_threshold || 1.5 });
/**
 * WALKAROUND of the initial leg start → goal (both ways round, WP_CW and WP_CCW): the shorter walk that reaches the goal
 * clear of everything in O, or null.
 */
export function walkTo(O: ObstacleIndex, start: Pt, goal: Pt, r: number, diagFirst: boolean, _lastDir?: number, _deadline?: number, legFn?: LegFn | null): Pt[] | null {
  const legPts = legFn || legPts45; const first = legPts(start, goal, diagFirst); if (pathClear(O, first, r)) return first;
  const ws = walkSettings(); const wr = walkaroundRoute(O, first.map(toNm), r, { policies: [WP_CW, WP_CCW], iterLimit: ws.iterLimit, cornerMode: ws.cornerMode });
  let best: NmPt[] | null = null;
  for (const pol of [WP_CW, WP_CCW]) if (wr.status[pol] === ST_DONE && (!best || chainLength(wr.lines[pol]) < chainLength(best))) best = wr.lines[pol];
  return best ? simplifyPts(best.map(fromNm)) : null;
}
/**
 * LINE_PLACER::rhWalkOnly for a head without a tail: rhWalkBase from `start` towards the cursor, refused when the
 * result collides; the head optimized per the Optimizer effort (OE_LOW: not at all, else MERGE_SEGMENTS).  A head that
 * cannot be walked stays at its start.  { pts, reached }.
 */
export function walkHead(O: ObstacleIndex, start: Pt, goal: Pt, r: number, diagFirst: boolean, _lastDir?: number, legFn?: LegFn | null) {
  const legPts = legFn || legPts45;
  if (samePt(start, goal)) return { pts: [start.slice()], reached: true };
  const ws = walkSettings(); const merge = (pts: Pt[]) => mergeFull(O, pts, r, { obtuse: false });
  const w = rhWalkBase(O, { tail: () => [], cursor: goal, r, cornerMode: ws.cornerMode, iterLimit: ws.iterLimit, hugThreshold: ws.hugThreshold, initial: (p) => legPts(start, p, diagFirst), optimize: merge });
  if (!w || w.length < 1 || !pathClear(O, w, r)) return { pts: [start.slice()], reached: false };
  const pts = simplifyPts((S.rs.effort as number) === 0 ? w : merge(w));
  return { pts, reached: samePt(pts[pts.length - 1], goal) };
}
