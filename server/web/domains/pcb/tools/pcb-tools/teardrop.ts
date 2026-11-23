// pcb-tools/teardrop.ts — TEARDROP_MANAGER (pcbnew/teardrop/teardrop.cpp, teardrop_utils.cpp) in internal units (nm):
// the teardrop zones of the pads, vias and track ends, rebuilt the way BOARD_COMMIT::Push does it after every edit that
// touches copper (RemoveTeardrops for the teardrops whose anchors changed, UpdateTeardrops for the dirty pads, vias and
// tracks), by ZONE_FILLER_TOOL::FillAllZones (a full update) and by the Edit Teardrops dialog.
//   computeAnchorPoints / findAnchorPointsOnTrack / computeTeardropPolygon / computeCurvedFor{Round,Rect}Shape,
//   computeFittedTeardropPolygon (narrowed until it clears other nets: collidesWithOtherNets), areItemsInSameZone,
//   computeChordThroughShape, setTeardropPriorities (30000 up, per layer, the biggest first), AddTeardropsOnTracks,
//   DeleteTrackToTrackTeardrops, createTeardrop / createTeardropMask (uuid = track xor anchor, +2 per crossing slot;
//   the mask zone's uuid the copper one's + 1), BEZIER_POLY::GetPoly, BuildConvexHull, SHAPE_ARC::ConvertToPolyline.
import type { BoardDoc, DesignSettings, PcbChange } from "./types";
import { removedChange, upsertChange } from "./changes";
import { designSettings } from "./drc";
import { polyPolyDist, polySegDist, viaLayers } from "./distances";
import { netOf, netStyle } from "./nets";
import { arcToSegmentCount, circleToPolygon, padShapePolygon, MAX_ERROR_IU } from "./pad-outline";
import { padsOf } from "./route-geom";
import { rulePairClearance } from "./rule-resolver";
import { K } from "./state";
import { rotator } from "./util";
import { copperCtx, type CopperCtx } from "./drc-sliver";
import { padPrims } from "../../fab/plot";
import { primPolys, union as polyUnion } from "../../fab/poly";
import type { Prim } from "../../fab/prims";
import { intersect as clipIntersect, inflate as clipInflate } from "../../fab/zonefill";

type V = [number, number];
const IU = 1e6;
const MAGIC_TEARDROP_ZONE_ID = 30000;
const DRC_EPSILON = 500;   // DEFAULT_DRC_EPSILON 0.0005 mm
const iu = (mm: number): number => Math.round(mm * IU);
const mm = (v: number): number => { const x = +(v / IU).toFixed(6); return x === 0 ? 0 : x; };
/** KiROUND: half away from zero. */
const KR = (v: number): number => (v < 0 ? -Math.round(-v) : Math.round(v));
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1]];
const half = (a: V): V => [Math.trunc(a[0] / 2), Math.trunc(a[1] / 2)];   // VECTOR2I / 2
const eq = (a: V, b: V): boolean => a[0] === b[0] && a[1] === b[1];
const normD = (v: V): number => Math.hypot(v[0], v[1]);
const normI = (v: V): number => KR(Math.hypot(v[0], v[1]));   // VECTOR2I::EuclideanNorm, SEG::Length
const unit = (v: V): V => { const n = normD(v); return [v[0] / n, v[1] / n]; };   // NormalizeVector
const resize = (v: V, len: number): V => { if (!v[0] && !v[1]) return [0, 0]; const n = normD(v); return [KR(v[0] * len / n), KR(v[1] * len / n)]; };
const vi = (x: number, y: number): V => [Math.trunc(x), Math.trunc(y)];   // VECTOR2I( double, double )
const INT_MAX = 2147483647;

// ---------------------------------------------------------------- parameters
/** TEARDROP_PARAMETERS in internal units. */
export interface TdPrm { enabled: boolean; maxLen: number; maxWidth: number; lenRatio: number; widthRatio: number; filterRatio: number; curved: boolean; twoSegments: boolean; onPadsInZones: boolean }
interface PadTd { enabled: boolean; twoSegments: boolean; preferZone: boolean; maxLen: number; maxWidth: number; lenRatio: number; widthRatio: number; filterRatio: number; curved: boolean }
const PM = (): { readTeardrops(n: SNode): PadTd } => (K as unknown as { padModel: { readTeardrops(n: SNode): PadTd } }).padModel;
const fromPad = (t: PadTd): TdPrm => ({ enabled: t.enabled, maxLen: iu(t.maxLen), maxWidth: iu(t.maxWidth), lenRatio: t.lenRatio, widthRatio: t.widthRatio, filterRatio: t.filterRatio, curved: t.curved, twoSegments: t.twoSegments, onPadsInZones: !t.preferZone });
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {});
const numOr = (v: unknown, d: number): number => (typeof v === "number" && isFinite(v) ? v : d);
/** The project's TARGET_TRACK entry (board.design_settings.teardrop_parameters, td_track_end). */
export function trackTargetParams(project: unknown): TdPrm {
  const ds = obj(obj(obj(project).board).design_settings);
  const p = (Array.isArray(ds.teardrop_parameters) ? ds.teardrop_parameters as unknown[] : []).map(obj).find((x) => x.td_target_name === "td_track_end") || {};
  return { enabled: p.td_enabled === true, maxLen: iu(numOr(p.td_maxlen, 1)), maxWidth: iu(numOr(p.td_maxheight, 2)), lenRatio: numOr(p.td_length_ratio, 0.5), widthRatio: numOr(p.td_height_ratio, 1),
    filterRatio: numOr(p.td_width_to_size_filter_ratio, 0.9), curved: p.td_curve_segcount === true || numOr(p.td_curve_segcount, 0) > 0,
    twoSegments: p.td_allow_use_two_tracks === undefined ? true : !!p.td_allow_use_two_tracks, onPadsInZones: p.td_on_pad_in_zone === true };
}

// ---------------------------------------------------------------- KIID
function uuidBytes(s: string): number[] {
  const h = s.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(h)) { const b: number[] = []; for (let i = 0; i < 32; i += 2) b.push(parseInt(h.slice(i, i + 2), 16)); return b; }
  // not a UUID (a hand-written id): a deterministic stand-in
  const b: number[] = []; let x = 2166136261;
  for (let i = 0; i < 16; i++) { for (let j = 0; j < s.length; j++) { x ^= s.charCodeAt(j) + i; x = Math.imul(x, 16777619) >>> 0; } b.push(x & 255); }
  return b;
}
const bytesUuid = (b: number[]): string => { const h = b.map((x) => x.toString(16).padStart(2, "0")).join(""); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
/** KIID::Increment: the bytes from the last, with carry. */
function increment(b: number[]): void { for (let i = 15; i >= 0; i--) { b[i] = (b[i] + 1) & 255; if (b[i] !== 0) break; } }
/** TEARDROP_MANAGER::teardropUuid: KIID::Combine( track, candidate ) then Increment 2 x slot times. */
export function teardropUuid(track: string, cand: string, slot: number): string {
  const a = uuidBytes(track), c = uuidBytes(cand); const b = a.map((x, i) => x ^ c[i]);
  for (let i = 0; i < 2 * slot; i++) increment(b);
  return bytesUuid(b);
}
export function maskUuidFor(u: string): string { const b = uuidBytes(u); increment(b); return bytesUuid(b); }

// ---------------------------------------------------------------- geometry ports
/** BuildConvexHull (convex_hull.cpp): Andrew's monotone chain. */
export function convexHull(pts: V[]): V[] {
  const p = pts.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const n = p.length; if (n < 3) return p;
  const cross = (o: V, a: V, b: V): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const H: V[] = []; let k = 0;
  for (let i = 0; i < n; i++) { while (k >= 2 && cross(H[k - 2], H[k - 1], p[i]) <= 0) k--; H[k++] = p[i]; }
  for (let i = n - 2, t = k + 1; i >= 0; i--) { while (k >= t && cross(H[k - 2], H[k - 1], p[i]) <= 0) k--; H[k++] = p[i]; }
  H.length = k - 1; return H;
}
/** SEG::Intersect( aSeg ) of segment a (this) with b, end points included. */
function segIntersect(a0: V, a1: V, b0: V, b1: V): V | null {
  const e = sub(a1, a0), f = sub(b1, b0), ac = sub(b0, a0);
  const d = f[0] * e[1] - f[1] * e[0], p = f[0] * ac[1] - f[1] * ac[0], q = e[0] * ac[1] - e[1] * ac[0];
  if (d === 0) return null;
  if (d > 0 && (q < 0 || q > d || p < 0 || p > d)) return null;
  if (d < 0 && (q < d || p < d || p > 0 || q > 0)) return null;
  return [b0[0] + KR(q * f[0] / d), b0[1] + KR(q * f[1] / d)];
}
/** SHAPE_LINE_CHAIN::Intersect( SEG ) of a closed outline: one hit per outline segment, in segment order. */
function chainSegHits(out: V[], s0: V, s1: V, hits: V[]): void {
  for (let i = 0; i < out.length; i++) { const p = segIntersect(out[i], out[(i + 1) % out.length], s0, s1); if (p) hits.push(p); }
}
function collinear(a0: V, a1: V, b0: V, b1: V): boolean {
  const c = (o: V, a: V, b: V): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  return c(a0, a1, b0) === 0 && c(a0, a1, b1) === 0;
}
function segContains(a0: V, a1: V, p: V): boolean { return distPS(p, a0, a1) <= 1; }
/** SHAPE_LINE_CHAIN::Intersect( SHAPE_LINE_CHAIN ) of a closed outline with an open polyline (addIntersection drops repeats). */
function chainChainHits(out: V[], line: V[], hits: V[]): void {
  const push = (p: V): void => { if (!hits.length || !eq(hits[hits.length - 1], p)) hits.push(p); };
  for (let i = 0; i < out.length; i++) {
    const a0 = out[i], a1 = out[(i + 1) % out.length];
    for (let j = 0; j + 1 < line.length; j++) {
      const b0 = line[j], b1 = line[j + 1];
      if (collinear(a0, a1, b0, b1)) {
        if (segContains(a0, a1, b0)) push(b0); if (segContains(a0, a1, b1)) push(b1);
        if (segContains(b0, b1, a0)) push(a0); if (segContains(b0, b1, a1)) push(a1);
      } else { const p = segIntersect(a0, a1, b0, b1); if (p) push(p); }
    }
  }
}
function distPS(p: V, a: V, b: V): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function nearestOnSeg(p: V, a: V, b: V): V {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; if (!l2) return a;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return [a[0] + KR(t * dx), a[1] + KR(t * dy)];
}
function pip(poly: V[], p: V): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
const containsAny = (polys: V[][], p: V): boolean => { let n = 0; for (const q of polys) if (pip(q, p)) n++; return n % 2 === 1; };
const areaAbs = (pts: V[]): number => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]; return Math.abs(a / 2); };
type Bx = [number, number, number, number];
const bboxOf = (pts: V[]): Bx => { const b: Bx = [Infinity, Infinity, -Infinity, -Infinity]; for (const p of pts) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); } return b; };
const boxHit = (a: Bx, b: Bx): boolean => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const grow = (b: Bx, d: number): Bx => [b[0] - d, b[1] - d, b[2] + d, b[3] + d];

/** BEZIER_POLY::GetPoly (Hain et al.'s parabolic approximation), cubic, rounded to internal units. */
export function bezierPoly(s: V, c1: V, c2: V, e: V, maxError: number): V[] {
  type P = [number, number]; type B = P[];
  const lerp = (a: P, b: P, t: number): P => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  const cr = (a: P, b: P): number => a[0] * b[1] - a[1] * b[0];
  const dot = (a: P, b: P): number => a[0] * b[0] + a[1] * b[1];
  const dif = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
  const isFlat = (c: B, err: number): boolean => {
    const delta = dif(c[3], c[0]), d21 = dif(c[1], c[0]), d31 = dif(c[2], c[0]);
    const c1x = cr(delta, d21), c2x = cr(delta, d31), inv = 1 / dot(delta, delta);
    const d1 = c1x * c1x * inv, d2 = c2x * c2x * inv, f = c1x * c2x > 0 ? 3 / 4 : 4 / 9, f2 = f * f, tol = err * err;
    return d1 * f2 <= tol && d2 * f2 <= tol;
  };
  const evalAt = (c: B, t: number): P => { const o = 1 - t; const a = o * o * o, b = 3 * t * o * o, d = 3 * t * t * o, g = t * t * t; return [a * c[0][0] + b * c[1][0] + d * c[2][0] + g * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + g * c[3][1]]; };
  const subdivide = (c: B, t: number): [B, B] => {
    const l1 = lerp(c[0], c[1], t), tmp = lerp(c[1], c[2], t), l2 = lerp(l1, tmp, t), r2 = lerp(c[2], c[3], t), r1 = lerp(tmp, r2, t), sh = lerp(l2, r1, t);
    return [[c[0], l1, l2, sh], [sh, r1, r2, c[3]]];
  };
  const thirdDev = (c: B): number => {
    const d = dif(c[1], c[0]); const l2 = dot(d, d); if (l2 < 1e-6) return 0; const l = Math.sqrt(l2);
    const r = (c[1][1] - c[0][1]) / l, ss = (c[0][0] - c[1][0]) / l, u = (c[1][0] * c[0][1] - c[0][0] * c[1][1]) / l;
    return Math.abs(r * c[2][0] + ss * c[2][1] + u);
  };
  const recursive = (c0: B, out: P[], thr: number): void => {
    const stack: B[] = [c0];
    while (stack.length) {
      const b = stack[stack.length - 1];
      if (b[3][0] === b[0][0] && b[3][1] === b[0][1]) stack.pop();
      else if (isFlat(b, thr)) { out.push(b[3]); stack.pop(); }
      else { const [l, r] = subdivide(b, 0.5); stack[stack.length - 1] = r; stack.push(l); }
    }
  };
  const isNaNB = (c: B): boolean => c.some((p) => isNaN(p[0]) || isNaN(p[1]));
  const parabolic = (c0: B, out: P[], err: number): void => {
    let c = c0;
    for (;;) {
      if (isNaNB(c)) break;
      if (isFlat(c, err)) { out.push(c[3]); break; }
      const d = thirdDev(c); if (d === 0) { recursive(c, out, err); break; }
      const t = 2 * Math.sqrt(err / (3 * d)); if (t > 1) { recursive(c, out, err); break; }
      const [b1, b2] = subdivide(c, t);
      if (isFlat(b1, err)) out.push(b1[3]); else recursive(b1, out, err);
      c = b2;
    }
  };
  const inflections = (c: B): { n: number; t1: number; t2: number } => {
    const A: P = [-c[0][0] + 3 * c[1][0] - 3 * c[2][0] + c[3][0], -c[0][1] + 3 * c[1][1] - 3 * c[2][1] + c[3][1]];
    const Bv: P = [3 * c[0][0] - 6 * c[1][0] + 3 * c[2][0], 3 * c[0][1] - 6 * c[1][1] + 3 * c[2][1]];
    const C: P = [-3 * c[0][0] + 3 * c[1][0], -3 * c[0][1] + 3 * c[1][1]];
    const a = 3 * cr(A, Bv), b = 3 * cr(A, C), cc = cr(Bv, C), r2 = b * b - 4 * a * cc;
    if (r2 >= 0 && a !== 0) {
      const r = Math.sqrt(r2); let t1 = (-b + r) / (2 * a), t2 = (-b - r) / (2 * a);
      const in1 = t1 > 0 && t1 < 1, in2 = t2 > 0 && t2 < 1;
      if (in1 && in2) { if (t1 > t2) [t1, t2] = [t2, t1]; return t2 - t1 > 0.00001 ? { n: 2, t1, t2 } : { n: 1, t1, t2 }; }
      if (in1) return { n: 1, t1, t2: 0 }; if (in2) return { n: 1, t1: t2, t2: 0 };
    }
    return { n: 0, t1: 0, t2: 0 };
  };
  const numInflections = (c: B): number => {
    const d21 = dif(c[1], c[0]), d32 = dif(c[2], c[1]), d43 = dif(c[3], c[2]);
    if (cr(d21, d32) * cr(d32, d43) < 0) return 1; if (cr(d21, d32) * cr(d21, d43) > 0) return 0;
    if ((dot(d21, d32) > 0) !== (dot(d32, d43) > 0)) return 0; return -1;
  };
  if (maxError <= 0) maxError = 10;
  const ctrl: B = [[s[0], s[1]], [c1[0], c1[1]], [c2[0], c2[1]], [e[0], e[1]]];
  const out: P[] = [ctrl[0]];
  if (numInflections(ctrl) === 0) parabolic(ctrl, out, maxError);
  else {
    const f = inflections(ctrl);
    if (f.n === 2) {
      const [sub1, tmp1] = subdivide(ctrl, f.t1); parabolic(sub1, out, maxError);
      const g = inflections(tmp1);
      if (g.n === 0) out.push(tmp1[3]);
      else { const [sub2, sub3] = subdivide(tmp1, g.t1); recursive(sub2, out, maxError); parabolic(sub3, out, maxError); }
    } else if (f.n === 1) { const [sub1, sub2] = subdivide(ctrl, f.t1); parabolic(sub1, out, maxError); parabolic(sub2, out, maxError); }
    else parabolic(ctrl, out, maxError);
  }
  return out.map((p) => [KR(p[0]), KR(p[1])] as V);
}

// ---------------------------------------------------------------- the board, as the teardrop manager sees it
interface Trk { k: "track"; id: string; uuid: string; arc: boolean; start: V; end: V; mid: V | null; width: number; layer: string; net: string; mask: boolean; maskMargin: number | null; box: Bx }
interface Via { k: "via"; id: string; uuid: string; pos: V; width: number; layers: Set<string>; net: string; td: TdPrm; box: Bx }
interface PadShape { shape: string; size: V; rr: number; polys: V[][]; boundR: number }
interface Pad { k: "pad"; id: string; uuid: string; pos: V; shapePos: V; orient: number; layers: Set<string>; net: string; td: TdPrm; node: SNode; fp: KItem; cache: Map<string, PadShape>; box: Bx }
interface Gfx { k: "gfx"; id: string; net: string; layer: string; segs: [V, V][]; hw: number; polys: V[][]; box: Bx }
interface Zn { k: "zone"; id: string; uuid: string; layer: string; net: string; type: string; outline: V[]; fill: V[][]; priority: number; item: KItem | null; box: Bx; created?: boolean; node?: SNode }
type Anchor = Trk | Via | Pad;
type Copper = Trk | Via | Pad | Gfx | Zn;

export interface TeardropOpts { project?: unknown; settings?: DesignSettings | null; maxError?: number; /** TARGET_TRACK's m_Enabled as just set (Edit Teardrops) */ trackEnabled?: boolean }
const trackPrmOf = (o: TeardropOpts): TdPrm => ({ ...trackTargetParams(o.project), ...(o.trackEnabled !== undefined ? { enabled: o.trackEnabled } : {}) });
interface World {
  doc: BoardDoc; copper: string[]; tracks: Trk[]; vias: Via[]; pads: Pad[]; gfx: Gfx[]; tdZones: Zn[]; zones: KItem[];
  netNames: Map<string, string>; maxErr: number; maxClear: number; s: DesignSettings; cc: CopperCtx | null; legacy: boolean;
  padVia: { query(b: Bx, slop: number): (Via | Pad)[] }; byId: Map<string, Anchor>;
  pairCache: Map<string, number>; zoneIslands: Map<string, V[][][]>;
}
const ptOf = (n: SNode | null): V => (n ? [iu(K.num(n[1])), iu(K.num(n[2]))] : [0, 0]);
/** The key two items share when they are on one net (code first: a board kept with net numbers). */
function netKey(node: SNode): string { const n = netOf(node); return n.code > 0 ? "#" + n.code : n.name; }
const cuLayers = (names: string[], copper: string[]): Set<string> => {
  const out = new Set<string>();
  for (const l of names) { if (l === "*.Cu") copper.forEach((c) => out.add(c)); else if (l === "F&B.Cu") { out.add("F.Cu"); out.add("B.Cu"); } else if (/\.Cu$/.test(l)) out.add(l); }
  return out;
};
function trackOf(it: KItem): Trk {
  const n = it.node, arc = it.kind === "arc"; const w = K.kid(n, "width"); const width = w ? iu(K.num(w[1])) : 0;
  const ls = K.kid(n, "layers"); const lnames = ls ? ls.slice(1).map((x) => K.str(x)) : [K.str((K.kid(n, "layer") || [])[1]) || "F.Cu"];
  const layer = lnames.find((l) => /\.Cu$/.test(l)) || "F.Cu";
  const mk = K.kid(n, "solder_mask_margin");
  const start = ptOf(K.kid(n, "start")), end = ptOf(K.kid(n, "end")), mid = arc ? ptOf(K.kid(n, "mid")) : null;
  const pts = mid ? [start, end, mid] : [start, end]; const u = K.kid(n, "uuid");
  return { k: "track", id: it.id, uuid: u ? K.str(u[1]) : it.id, arc, start, end, mid, width, layer, net: netKey(n), mask: lnames.some((l) => /\.Mask$/.test(l)), maskMargin: mk ? iu(K.num(mk[1])) : null,
    box: grow(bboxOf(pts), Math.ceil(width / 2) + (mid ? normI(sub(start, end)) : 0)) };
}
function buildWorld(doc: BoardDoc, o: TeardropOpts, exclude?: Set<string>): World {
  const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const s = o.settings || designSettings((o.project || null) as Parameters<typeof designSettings>[0]);
  const tracks: Trk[] = [], vias: Via[] = [], pads: Pad[] = [], gfx: Gfx[] = [], tdZones: Zn[] = [], zones: KItem[] = []; const netNames = new Map<string, string>();
  const name = (node: SNode, nm?: string): void => { const n = netOf(node); if (n.code > 0 && (nm || n.name) && !netNames.has("#" + n.code)) netNames.set("#" + n.code, nm || n.name); if (n.code < 0 && n.name) netNames.set(n.name, n.name); };
  let maxClear = Math.max(s.clearance || 0, s.minClearance || 0);
  for (const nc of Object.values(s.netclasses || {})) maxClear = Math.max(maxClear, nc && typeof nc.clearance === "number" ? nc.clearance : 0);
  for (const it of doc.items.values()) {
    if (exclude && exclude.has(it.id)) continue;
    const n = it.node;
    if (it.kind === "segment" || it.kind === "arc") { tracks.push(trackOf(it)); name(n); }
    else if (it.kind === "via") {
      const sz = K.kid(n, "size"), u = K.kid(n, "uuid"); const pos = ptOf(K.kid(n, "at")), width = sz ? iu(K.num(sz[1])) : iu(0.6);
      vias.push({ k: "via", id: it.id, uuid: u ? K.str(u[1]) : it.id, pos, width, layers: viaLayers(n, copper), net: netKey(n), td: fromPad(PM().readTeardrops(n)), box: grow([pos[0], pos[1], pos[0], pos[1]], Math.ceil(width / 2)) });
      name(n);
    } else if (it.kind === "footprint") {
      for (const p of padsOf(it)) {
        if (p.type === "np_thru_hole") continue;
        const ls = cuLayers(p.layers, copper); if (!ls.size) continue;
        const pos: V = [iu(p.x), iu(p.y)]; const [ox, oy] = rotator(p.rot)(p.off[0], p.off[1]);
        const u = K.kid(p.node, "uuid"); const r = iu(Math.hypot(p.w, p.h) / 2 + Math.hypot(p.off[0], p.off[1]));
        pads.push({ k: "pad", id: it.id + "#" + (u ? K.str(u[1]) : p.index), uuid: u ? K.str(u[1]) : it.id + "#" + p.index, pos, shapePos: [iu(p.x + ox), iu(p.y + oy)], orient: p.rot, layers: ls, net: netKey(p.node),
          td: fromPad(PM().readTeardrops(p.node)), node: p.node, fp: it, cache: new Map(), box: grow([pos[0], pos[1], pos[0], pos[1]], r) });
        name(p.node);
      }
    } else if (it.kind === "zone") {
      const nn = K.kid(n, "net_name"); name(n, nn ? K.str(nn[1]) : undefined);
      const lc = K.kid(K.kid(n, "connect_pads") || ["x"], "clearance"); if (lc) maxClear = Math.max(maxClear, K.num(lc[1]));
      const z = zoneOf(it); if (z) tdZones.push(z); else if (!K.kid(n, "keepout")) zones.push(it);
    } else if (/^gr_(line|arc|rect|circle|poly)$/.test(it.kind)) { const g = gfxOf(it); if (g) gfx.push(g); }
  }
  const pv: (Via | Pad)[] = [...vias, ...pads];
  const byId = new Map<string, Anchor>(); for (const a of [...tracks, ...vias, ...pads]) byId.set(a.id, a);
  const legacy = !!(doc as unknown as { generalNode?: SNode | null }).generalNode && (() => { const l = K.kid((doc as unknown as { generalNode: SNode }).generalNode, "legacy_teardrops"); return !!l && K.str(l[1]) === "yes"; })();
  return { doc, copper, tracks, vias, pads, gfx, tdZones, zones, netNames, maxErr: o.maxError || MAX_ERROR_IU, maxClear: iu(maxClear), s, cc: null, legacy,
    padVia: boxGridIU(pv, (x) => x.box), byId, pairCache: new Map(), zoneIslands: new Map() };
}
function boxGridIU<T>(items: T[], boxOf: (t: T) => Bx): { query(b: Bx, slop: number): T[] } {
  const cell = 2 * IU, cells = new Map<string, number[]>(), big: number[] = []; const boxes = items.map(boxOf);
  boxes.forEach((b, i) => {
    const x0 = Math.floor(b[0] / cell), x1 = Math.floor(b[2] / cell), y0 = Math.floor(b[1] / cell), y1 = Math.floor(b[3] / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) { big.push(i); return; }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = x + "," + y; const l = cells.get(k); if (l) l.push(i); else cells.set(k, [i]); }
  });
  return { query(b: Bx, slop: number): T[] {
    const q = grow(b, slop); const hit = new Set<number>(big);
    const x0 = Math.floor(q[0] / cell), x1 = Math.floor(q[2] / cell), y0 = Math.floor(q[1] / cell), y1 = Math.floor(q[3] / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) return items.filter((_t, i) => boxHit(boxes[i], q));
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const l = cells.get(x + "," + y); if (l) for (const i of l) hit.add(i); }
    return [...hit].sort((a, c) => a - c).filter((i) => boxHit(boxes[i], q)).map((i) => items[i]);
  } };
}
function polyOfPts(node: SNode | null): V[] { return node ? (K.ptsOf(node) as [number, number][]).map((p) => [iu(p[0]), iu(p[1])] as V) : []; }
function zoneOf(it: KItem): Zn | null {
  const n = it.node; const attr = K.kid(n, "attr"), td = attr && K.kid(attr, "teardrop"); if (!td) return null;
  const tt = K.kid(td, "type"); const layer = K.str((K.kid(n, "layer") || (K.kid(n, "layers") || []))[1]) || "F.Cu";
  const outline = polyOfPts(K.kid(n, "polygon")); const fill: V[][] = [];
  for (const f of K.kids(n, "filled_polygon")) { const l = K.kid(f, "layer"); if (!l || K.str(l[1]) === layer) fill.push(polyOfPts(f)); }
  const pr = K.kid(n, "priority"), u = K.kid(n, "uuid");
  return { k: "zone", id: it.id, uuid: u ? K.str(u[1]) : it.id, layer, net: netKey(n), type: tt ? K.str(tt[1]) : "padvia", outline, fill: fill.length ? fill : [outline], priority: pr ? K.num(pr[1]) : 0, item: it, box: bboxOf(outline) };
}
function gfxOf(it: KItem): Gfx | null {
  const n = it.node; const layer = K.str((K.kid(n, "layer") || [])[1]); if (!/\.Cu$/.test(layer)) return null;
  const st = K.kid(n, "stroke"), wn = (st && K.kid(st, "width")) || K.kid(n, "width"); const w = wn ? iu(K.num(wn[1])) : 0;
  const f = K.kid(n, "fill"); const filled = !!f && /^(yes|solid)$/.test(K.str(f[1]));
  const segs: [V, V][] = []; const polys: V[][] = [];
  const s = ptOf(K.kid(n, "start")), e = ptOf(K.kid(n, "end"));
  if (it.kind === "gr_line") segs.push([s, e]);
  else if (it.kind === "gr_rect") { const c: V[] = [s, [e[0], s[1]], e, [s[0], e[1]]]; for (let i = 0; i < 4; i++) segs.push([c[i], c[(i + 1) % 4]]); if (filled) polys.push(c); }
  else if (it.kind === "gr_poly") { const c = polyOfPts(K.kid(n, "pts") ? n : null); for (let i = 0; i < c.length; i++) segs.push([c[i], c[(i + 1) % c.length]]); if (filled) polys.push(c); }
  else if (it.kind === "gr_circle") { const r = normI(sub(e, s)); const c = circleToPolygon(s, r, MAX_ERROR_IU, 16); for (let i = 0; i < c.length; i++) segs.push([c[i], c[(i + 1) % c.length]]); if (filled) polys.push(c); }
  else if (it.kind === "gr_arc") { const m = ptOf(K.kid(n, "mid")); const pl = arcPolyline(s, m, e, 0, MAX_ERROR_IU); for (let i = 0; i + 1 < pl.length; i++) segs.push([pl[i], pl[i + 1]]); }
  const all = segs.flatMap((x) => x); if (!all.length) return null;
  return { k: "gfx", id: it.id, net: netKey(n), layer, segs, hw: w / 2, polys, box: grow(bboxOf(all), Math.ceil(w / 2)) };
}

// ---------------------------------------------------------------- arcs (SHAPE_ARC)
interface ArcG { c: [number, number]; r: number; sa: number; ca: number }
function arcGeom(s: V, m: V, e: V): ArcG {
  const ax = s[0], ay = s[1], bx = m[0], by = m[1], cx = e[0], cy = e[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (!d) return { c: [(ax + cx) / 2, (ay + cy) / 2], r: Math.hypot(cx - ax, cy - ay) / 2, sa: 0, ca: 0 };
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const c: [number, number] = [KR(ux), KR(uy)];
  const ang = (p: V): number => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const n180 = (a: number): number => { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; };
  return { c, r: Math.hypot(s[0] - c[0], s[1] - c[1]), sa: ang(s), ca: n180(ang(m) - ang(s)) + n180(ang(e) - ang(m)) };
}
/** CircleToEndSegmentDeltaRadius. */
function endSegDelta(radius: number, segs: number): number { if (segs <= 2) segs = 3; return Math.trunc(Math.trunc(radius) * (1 - Math.cos(Math.PI / segs))); }
/** SHAPE_ARC::ConvertToPolyline. */
export function arcPolyline(s: V, m: V, e: V, width: number, maxError: number): V[] {
  const g = arcGeom(s, m, e); let r = g.r; const caDeg = g.ca * 180 / Math.PI;
  const halfErr = Math.max(1, maxError / 2), ext = r + width / 2; let n: number, eff: number;
  if (ext < halfErr || g.ca === 0 || distPS(arcMid(g), s, e) < halfErr) { n = 0; eff = ext; }
  else { n = arcToSegmentCount(ext, maxError, caDeg); const seg360 = Math.trunc(n * 360 / Math.abs(caDeg)); eff = endSegDelta(ext, seg360); }
  r += eff / 2; n *= 2;
  const out: V[] = [s];
  for (let i = 1; i < n; i += 2) { const a = g.sa + g.ca * i / n; out.push([KR(g.c[0] + r * Math.cos(a)), KR(g.c[1] + r * Math.sin(a))]); }
  out.push(e); return out;
}
const arcMid = (g: ArcG): V => [KR(g.c[0] + g.r * Math.cos(g.sa + g.ca / 2)), KR(g.c[1] + g.r * Math.sin(g.sa + g.ca / 2))];
function inSweep(g: ArcG, a: number): boolean { let d = (a - g.sa) * Math.sign(g.ca || 1); while (d < 0) d += 2 * Math.PI; while (d >= 2 * Math.PI) d -= 2 * Math.PI; return d <= Math.abs(g.ca); }
/** SHAPE_ARC::NearestPoint. */
function arcNearest(s: V, m: V, e: V, p: V): V {
  const g = arcGeom(s, m, e); const v: V = [p[0] - g.c[0], p[1] - g.c[1]];
  if ((v[0] || v[1]) && inSweep(g, Math.atan2(v[1], v[0]))) { const q = resize(v, KR(g.r)); return [g.c[0] + q[0], g.c[1] + q[1]]; }
  return normD(sub(p, s)) <= normD(sub(p, e)) ? s : e;
}
const trackLength = (t: Trk): number => { if (!t.arc || !t.mid) return normD(sub(t.end, t.start)); const g = arcGeom(t.start, t.mid, t.end); return g.r * Math.abs(g.ca); };
function trackSegs(t: Trk, maxErr: number): [V, V][] {
  if (!t.arc || !t.mid) return [[t.start, t.end]];
  const pl = arcPolyline(t.start, t.mid, t.end, 0, maxErr); const out: [V, V][] = []; for (let i = 0; i + 1 < pl.length; i++) out.push([pl[i], pl[i + 1]]); return out;
}
/** PCB_TRACK::HitTest( pos, accuracy ). */
function trackHit(t: Trk, p: V, acc = 0): boolean {
  const hw = t.width / 2 + acc;
  if (!t.arc || !t.mid) return distPS(p, t.start, t.end) <= hw;
  const g = arcGeom(t.start, t.mid, t.end); const d = Math.hypot(p[0] - g.c[0], p[1] - g.c[1]);
  if (Math.abs(d - g.r) > hw) return normD(sub(p, t.start)) <= hw || normD(sub(p, t.end)) <= hw;
  return inSweep(g, Math.atan2(p[1] - g.c[1], p[0] - g.c[0])) || normD(sub(p, t.start)) <= hw || normD(sub(p, t.end)) <= hw;
}
/** PCB_TRACK::IsPointOnEnds: 1 STARTPOINT, 2 ENDPOINT. */
function pointOnEnds(t: Trk, p: V, minDist: number): number {
  let r = 0; if (eq(t.start, p)) r |= 1; if (eq(t.end, p)) r |= 2;
  if (minDist === 0 || r) return r;
  if (minDist >= KR(normD(sub(t.start, p)))) r |= 1; if (minDist >= KR(normD(sub(t.end, p)))) r |= 2;
  return r;
}

// ---------------------------------------------------------------- pads
const PADSTACK_KEYS = ["shape", "size", "roundrect_rratio", "chamfer_ratio", "chamfer", "rect_delta", "offset"];
/** The pad as it is on a layer (a padstack's own shape there). */
function padLayerNode(pad: SNode, layer: string): SNode {
  const ps = K.kid(pad, "padstack"); if (!ps) return pad;
  const mode = K.str((K.kid(ps, "mode") || [])[1]);
  const want = mode === "custom" ? layer : layer === "F.Cu" ? "" : layer === "B.Cu" ? "B.Cu" : "Inner";
  const l = want ? K.kids(ps, "layer").find((x) => K.str(x[1]) === want) : null; if (!l) return pad;
  const n = K.cloneNode(pad);
  for (const key of PADSTACK_KEYS) {
    const v = K.kid(l, key); if (!v) continue;
    if (key === "shape") { n[3] = v[1]; continue; }
    const i = n.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === key); if (i > 0) n[i] = v; else n.push(v);
  }
  return n;
}
function padShape(w: World, pad: Pad, layer: string): PadShape {
  let got = pad.cache.get(layer); if (got) return got;
  const n = padLayerNode(pad.node, layer); const shape = K.str(n[3]); const sz = K.kid(n, "size");
  const size: V = [iu(K.num(sz && sz[1])), iu(K.num(sz && (sz.length > 2 ? sz[2] : sz[1])))];
  const rr = K.kid(n, "roundrect_rratio"); const radius = shape === "roundrect" && rr ? KR(Math.min(size[0], size[1]) * K.num(rr[1])) : 0;
  let polys: V[][];
  if (shape === "custom") {
    if (!w.cc) w.cc = copperCtx(w.doc);
    const fp = w.cc.pads.get(pad.node); const out: Prim[] = [];
    if (fp) padPrims(fp, layer, w.cc.m, out);
    polys = polyUnion(out.flatMap((p) => primPolys(p))).map((q) => q.map((p) => [iu(p[0]), iu(p[1])] as V));
  } else polys = [padShapePolygon(n, [mm(pad.shapePos[0]), mm(pad.shapePos[1])], w.maxErr).map((p) => [iu(p[0]), iu(p[1])] as V)];
  let boundR = 0; for (const q of polys) for (const p of q) boundR = Math.max(boundR, normD(sub(p, pad.pos)));
  got = { shape, size, rr: radius, polys, boundR }; pad.cache.set(layer, got); return got;
}
const onLayer = (a: Copper, layer: string): boolean => a.k === "track" || a.k === "gfx" || a.k === "zone" ? a.layer === layer : a.layers.has(layer);
const posOf = (a: Anchor): V => (a.k === "track" ? a.start : a.pos);
/** TEARDROP_MANAGER::GetWidth. */
function getWidth(w: World, a: Anchor, layer: string): number { if (a.k === "via") return a.width; if (a.k === "pad") { const s = padShape(w, a, layer); return Math.min(s.size[0], s.size[1]); } return a.width; }
/** TEARDROP_MANAGER::IsRound. */
function isRound(w: World, a: Anchor, layer: string): boolean { if (a.k !== "pad") return true; const s = padShape(w, a, layer); return s.shape === "circle" || (s.shape === "oval" && s.size[0] === s.size[1]); }
/** BOARD_ITEM::HitTest( pos, 0[, layer] ). */
function hitTest(w: World, a: Anchor, p: V, layer: string): boolean {
  if (a.k === "via") { const r = a.width / 2; return (p[0] - a.pos[0]) ** 2 + (p[1] - a.pos[1]) ** 2 <= r * r; }
  if (a.k === "track") return trackHit(a, p);
  const s = padShape(w, a, layer); if (normD(sub(p, a.pos)) > s.boundR) return false; return containsAny(s.polys, p);
}
/** The anchor's outline: a circle of GetWidth/2 (16 segments at least, ERROR_INSIDE) when round, else the pad's polygon. */
function shapeBuffer(w: World, a: Anchor, layer: string, at: V): V[][] {
  if (isRound(w, a, layer)) return [circleToPolygon(at, Math.trunc(getWidth(w, a, layer) / 2), w.maxErr, 16)];
  return padShape(w, a as Pad, layer).polys;
}

// ---------------------------------------------------------------- connectivity (CN_CONNECTIVITY_ALGO, as far as teardrops ask)
/** CONNECTIVITY_DATA::GetConnectedPadsAndVias( track ): same net, a common layer, a track end inside the pad / via or its centre on the track. */
function connectedPadsAndVias(w: World, t: Trk): { pads: Pad[]; vias: Via[] } {
  const pads: Pad[] = [], vias: Via[] = [];
  for (const a of w.padVia.query(t.box, 0)) {
    if (a.net !== t.net || !a.layers.has(t.layer)) continue;
    const hit = hitTest(w, a, t.start, t.layer) || hitTest(w, a, t.end, t.layer) || trackHit(t, a.k === "pad" ? a.shapePos : a.pos);
    if (hit) (a.k === "pad" ? pads : vias).push(a as never);
  }
  return { pads, vias };
}
/** The pads, vias and tracks a teardrop zone touches (GetConnectedPadsAndVias / GetConnectedTracks of a zone). */
function zoneAnchors(w: World, z: Zn): Set<string> {
  const out = new Set<string>(); const fill = z.fill;
  for (const a of w.padVia.query(z.box, 0)) {
    if (a.net !== z.net || !a.layers.has(z.layer)) continue;
    const touch = a.k === "via" ? fill.some((f) => distPolyPoint(f, a.pos) <= a.width / 2) : padShape(w, a, z.layer).polys.some((pp) => fill.some((f) => polyPolyDist(pp, f) === 0));
    if (touch) out.add(a.id);
  }
  for (const t of w.tracks) {
    if (t.net !== z.net || t.layer !== z.layer || !boxHit(t.box, z.box)) continue;
    if (trackSegs(t, w.maxErr).some(([a, b]) => fill.some((f) => polySegDist(f, a, b) <= t.width / 2))) out.add(t.id);
  }
  return out;
}
const distPolyPoint = (f: V[], p: V): number => (pip(f, p) ? 0 : f.reduce((d, q, i) => Math.min(d, distPS(p, q, f[(i + 1) % f.length])), Infinity));
/** CONNECTIVITY_DATA::GetZoneIslandConnections: per filled island of a zone on a layer. */
function islandsOf(w: World, z: KItem, layer: string): V[][][] {
  const key = z.id + "|" + layer; let got = w.zoneIslands.get(key); if (got) return got;
  got = []; for (const f of K.kids(z.node, "filled_polygon")) { const l = K.kid(f, "layer"); if (l && K.str(l[1]) === layer) got.push([polyOfPts(f)]); }
  w.zoneIslands.set(key, got); return got;
}
/** TEARDROP_MANAGER::areItemsInSameZone. */
function areItemsInSameZone(w: World, a: Pad | Via, t: Trk): boolean {
  const layer = t.layer;
  for (const z of w.zones) {
    const zl = K.kid(z.node, "layers"), l1 = K.kid(z.node, "layer"); const ls = zl ? zl.slice(1).map((x) => K.str(x)) : l1 ? [K.str(l1[1])] : [];
    if (!ls.includes(layer) && !(ls.includes("*.Cu") || ls.includes("F&B.Cu"))) continue;
    if (netKey(z.node) !== t.net) continue;
    const islands = islandsOf(w, z, layer); if (!islands.length) continue;
    for (const isl of islands) {
      const f = isl[0];
      const hasA = a.k === "via" ? distPolyPoint(f, a.pos) <= a.width / 2 : padShape(w, a, layer).polys.some((pp) => polyPolyDist(pp, f) === 0);
      const hasT = pip(f, t.start) || pip(f, t.end) || trackSegs(t, w.maxErr).some(([p, q]) => polySegDist(f, p, q) <= t.width / 2);
      if (hasA && hasT) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- collisions with other nets
interface ItemShape { segs?: [V, V][]; hw?: number; circle?: { c: V; r: number }; polys?: V[][] }
function shapeOn(w: World, c: Copper, layer: string): ItemShape {
  if (c.k === "track") return { segs: trackSegs(c, w.maxErr), hw: c.width / 2 };
  if (c.k === "via") return { circle: { c: c.pos, r: c.width / 2 } };
  if (c.k === "pad") return { polys: padShape(w, c, layer).polys };
  if (c.k === "gfx") return { segs: c.segs, hw: c.hw, polys: c.polys };
  return { polys: c.fill };
}
function polyShapeDist(P: V[], s: ItemShape): number {
  let d = Infinity;
  if (s.segs) for (const [a, b] of s.segs) { d = Math.min(d, Math.max(0, polySegDist(P, a, b) - (s.hw || 0))); if (d === 0) return 0; }
  if (s.circle) d = Math.min(d, Math.max(0, distPolyPoint(P, s.circle.c) - s.circle.r));
  if (s.polys) for (const q of s.polys) if (q.length >= 3) { d = Math.min(d, polyPolyDist(P, q)); if (d === 0) return 0; }
  return d;
}
function shapeAsPolys(s: ItemShape, maxErr: number): V[][] {
  const out: V[][] = [];
  if (s.polys) out.push(...s.polys);
  if (s.circle) out.push(circleToPolygon(s.circle.c, Math.trunc(s.circle.r), maxErr, 16));
  if (s.segs) for (const [a, b] of s.segs) out.push(capsule(a, b, s.hw || 0));
  return out;
}
function capsule(a: V, b: V, hw: number): V[] {
  const n = 8, ang = Math.atan2(b[1] - a[1], b[0] - a[0]); const out: V[] = [];
  for (let i = 0; i <= n; i++) { const t = ang + Math.PI / 2 + Math.PI * i / n; out.push([KR(b[0] + hw * Math.cos(t - Math.PI)), KR(b[1] + hw * Math.sin(t - Math.PI))]); }
  for (let i = 0; i <= n; i++) { const t = ang - Math.PI / 2 + Math.PI * i / n; out.push([KR(a[0] + hw * Math.cos(t + Math.PI)), KR(a[1] + hw * Math.sin(t + Math.PI))]); }
  return out;
}
/** TEARDROP_MANAGER::pairClearance: the clearance rule between the track and the item, less the DRC epsilon. */
function pairClearance(w: World, src: Trk, c: Copper, layer: string): number {
  const key = src.id + "|" + c.id + "|" + layer; const got = w.pairCache.get(key); if (got !== undefined) return got;
  const nm = (k: string): string => w.netNames.get(k) || (k.startsWith("#") ? (w.doc.nets ? String(w.doc.nets.get(+k.slice(1)) || "") : "") : k);
  const v = Math.max(0, iu(rulePairClearance(w.doc, w.s, nm(src.net), nm(c.net), layer, c.k === "via" ? "via" : undefined)) - DRC_EPSILON);
  w.pairCache.set(key, v); return v;
}
interface Mgr { w: World; created: Zn[]; changes: PcbChange[]; removed: Set<string>; tolerance: number }
/** TEARDROP_MANAGER::collidesWithOtherNets. */
function collidesWithOtherNets(m: Mgr, pts: V[], src: Trk, exempt: Copper[]): boolean {
  if (pts.length < 3) return false;
  const w = m.w, layer = src.layer, net = src.net;
  const anchorPolys: V[][] = net === "" ? exempt.flatMap((e) => shapeAsPolys(shapeOn(w, e, layer), w.maxErr)) : [];
  const touches = (c: Copper): boolean => { const ps = shapeAsPolys(shapeOn(w, c, layer), w.maxErr); return ps.some((p) => anchorPolys.some((a) => polyPolyDist(p, a) === 0)); };
  const same = (c: Copper): boolean => (net !== "" ? c.net === net : c.net === "" && touches(c));
  const collides = (c: Copper): boolean => {
    if (exempt.includes(c) || same(c)) return false;
    const d = polyShapeDist(pts, shapeOn(w, c, layer)); const cl = pairClearance(w, src, c, layer);
    return d === 0 || d < cl;
  };
  const box = grow(bboxOf(pts), w.maxClear);
  const cands: Copper[] = [];
  for (const t of w.tracks) if (t.layer === layer && boxHit(t.box, box)) cands.push(t);
  for (const z of w.tdZones) if (z.layer === layer && !m.removed.has(z.id) && boxHit(z.box, box)) cands.push(z);
  for (const g of w.gfx) if (g.layer === layer && boxHit(g.box, box)) cands.push(g);
  for (const a of w.padVia.query(box, 0)) if (a.layers.has(layer)) cands.push(a);
  for (const c of cands) if (collides(c)) return true;
  for (const z of m.created) if (z.layer === layer && boxHit(z.box, box) && collides(z)) return true;
  return false;
}

// ---------------------------------------------------------------- the teardrop shape
type Pts5 = V[];
/** TEARDROP_MANAGER::computeAnchorPoints: C and E, where the hull of A, B and the (clipped) anchor outline leaves A and B. */
function computeAnchorPoints(w: World, prm: TdPrm, layer: string, a: Anchor, pos: V, pts: Pts5): boolean {
  let buf: V[][]; let preferred = KR(getWidth(w, a, layer) * prm.widthRatio); let forceClip = prm.widthRatio < 1;
  if (isRound(w, a, layer)) buf = [circleToPolygon(pos, Math.trunc(getWidth(w, a, layer) / 2), w.maxErr, 16)];
  else { forceClip = true; preferred = KR(getWidth(w, a, layer) * prm.widthRatio); buf = padShape(w, a as Pad, layer).polys; }
  if (forceClip || (prm.maxWidth > 0 && prm.maxWidth < preferred)) {
    const hs = Math.trunc((prm.maxWidth > 0 ? Math.min(prm.maxWidth, preferred) : preferred) / 2);
    const ref = half(add(pts[0], pts[1])); const axis = sub(pts[3], ref); const orient = Math.atan2(axis[1], axis[0]); const len = normI(axis);
    const c = Math.cos(orient), s = Math.sin(orient);
    const rect: V[] = ([[0, -hs], [0, hs], [len, hs], [len, -hs]] as V[]).map((p) => [KR(p[0] * c - p[1] * s) + ref[0], KR(p[0] * s + p[1] * c) + ref[1]] as V);
    const res = clipIntersect(buf.map((q) => q.map((p) => ({ x: mm(p[0]), y: mm(p[1]) }))), [rect.map((p) => ({ x: mm(p[0]), y: mm(p[1]) }))]);
    buf = res.map((path) => path.map((p) => [iu(p.x), iu(p.y)] as V));
  }
  if (!buf.length) return false;
  const hull = convexHull([pts[0], pts[1], ...buf[0]]);
  let C: V = [0, 0], E: V = [0, 0], foundStart = -1, foundEnd = -1; const start = pts[0], pend = pts[1];
  for (let ii = 0; ii < hull.length; ii++) {
    const next = ii + 1 >= hull.length ? 0 : ii + 1, prev = ii - 1 < 0 ? hull.length - 1 : ii - 1;
    if (eq(hull[ii], start)) { E = !eq(hull[next], pend) ? hull[next] : hull[prev]; foundStart = ii; }
    if (eq(hull[ii], pend)) { C = !eq(hull[next], start) ? hull[next] : hull[prev]; foundEnd = ii; }
  }
  if (foundStart < 0) { let ii = foundEnd - 1; if (ii < 0) ii = hull.length - 1; E = hull[ii]; }
  if (foundEnd < 0) { let ii = foundStart - 1; if (ii < 0) ii = hull.length - 1; C = hull[ii]; }
  pts[2] = C; pts[4] = E;
  const a1 = areaAbs(pts); [pts[2], pts[4]] = [pts[4], pts[2]]; const a2 = areaAbs(pts);
  if (a1 > a2) [pts[2], pts[4]] = [pts[4], pts[2]];
  return true;
}
/** TEARDROP_MANAGER::findTouchingTrack: the one track (the longest at a Y) with an end at the point. */
function findTouchingTrack(m: Mgr, ref: Trk, source: Trk, endPt: V): { t: Trk; match: number } | null {
  let matches = 0, cand: Trk | null = null, match = 0;
  for (const t of m.w.tracks) {
    if (t === ref || t === source || t.layer !== ref.layer || !boxHit(t.box, ref.box)) continue;
    if (!tracksCollide(m.w, t, ref)) continue;
    const mt = pointOnEnds(t, endPt, m.tolerance);
    if (mt) { matches++; if (matches > 1 && cand && trackLength(cand) >= trackLength(t)) continue; match = mt; cand = t; }
  }
  return cand ? { t: cand, match } : null;
}
function tracksCollide(w: World, a: Trk, b: Trk): boolean {
  const lim = (a.width + b.width) / 2;
  for (const [p, q] of trackSegs(a, w.maxErr)) for (const [r, s] of trackSegs(b, w.maxErr)) {
    if (segIntersect(p, q, r, s)) return true;
    if (Math.min(distPS(p, r, s), distPS(q, r, s), distPS(r, p, q), distPS(s, p, q)) <= lim) return true;
  }
  return false;
}
interface Found { start: V; end: V; inter: V; track: Trk; len: number }
/** TEARDROP_MANAGER::findAnchorPointsOnTrack. */
function findAnchorPointsOnTrack(m: Mgr, prm: TdPrm, track0: Trk, source: Trk, other: Anchor, otherPos: V): Found | null {
  const w = m.w; let track = track0; let start = track.start, end = track.end; const layer = track.layer;
  let target = KR(getWidth(w, other, layer) * prm.lenRatio); if (prm.maxLen > 0) target = Math.min(prm.maxLen, target);
  let needSwap = false;
  if (!hitTest(w, other, start, layer)) { [start, end] = [end, start]; needSwap = true; }
  const outline = shapeBuffer(w, other, layer, otherPos)[0]; if (!outline) return null;
  const hits: V[] = [];
  if (track.arc && track.mid) chainChainHits(outline, arcPolyline(track.start, track.mid, track.end, track.width, w.maxErr), hits);
  else chainSegHits(outline, start, end, hits);
  if (hits.length < 1) return null;
  const inter = hits[0]; start = inter;
  let len = Math.min(target, normI(sub(end, start))); const ref = start;
  if (len < target && prm.twoSegments) {
    let consumed = 0;
    while (len + consumed < target) {
      const f = findTouchingTrack(m, track, source, end); if (!f) break;
      const firstDir = unit(sub(end, ref)); const secondDir = f.match === 1 ? unit(sub(f.t.end, f.t.start)) : unit(sub(f.t.start, f.t.end));
      if (firstDir[0] * secondDir[0] + firstDir[1] * secondDir[1] < 0.5) break;
      consumed += len; len = Math.min(target - consumed, Math.trunc(trackLength(f.t)));
      track = f.t; end = f.t.end; start = f.t.start; needSwap = false;
      if (f.match !== 1) { [start, end] = [end, start]; needSwap = true; }
      break;
    }
  }
  if (track.arc && track.mid) {
    const as = needSwap ? track.end : track.start, ae = needSwap ? track.start : track.end;
    const poly = arcPolyline(as, track.mid, ae, track.width, w.maxErr).map((p) => arcNearest(as, track.mid!, ae, p));
    if (poly.length > 2) {
      for (let ii = poly.length - 1; ii >= 0; ii--) {
        const d = normI(sub(poly[ii], start));
        if (d < len || ii === 0) {
          start = poly[ii]; if (ii < poly.length - 1) end = poly[ii + 1];
          len -= normI(sub(start, ref)); if (len < 0) len = 0; len = Math.min(len, normI(sub(end, start)));
          break;
        }
      }
    }
  }
  return { start, end, inter, track, len };
}
/** computeCornerTangentControlPoint. */
function cornerTangent(anchor: V, center: V, bias: number, desired: V): V {
  const radial = sub(anchor, center); if (!radial[0] && !radial[1]) return anchor;
  const t1: V = [radial[1], -radial[0]], t2: V = [-radial[1], radial[0]];
  const d1 = t1[0] * desired[0] + t1[1] * desired[1], d2 = t2[0] * desired[0] + t2[1] * desired[1];
  return add(anchor, resize(d1 > d2 ? t1 : t2, KR(bias)));
}
const rotPt = (p: V, deg: number): V => { const [x, y] = rotator(deg)(p[0], p[1]); return [KR(x), KR(y)]; };
/** isPointOnOvalEnd. */
function onOvalEnd(p: V, pos: V, size: V, deg: number): V | null {
  const l = rotPt(sub(p, pos), deg); const hw = Math.trunc(size[0] / 2), hh = Math.trunc(size[1] / 2), r = Math.min(hw, hh); let c: V;
  if (hw > hh) { const off = hw - r; if (Math.abs(l[0]) <= off) return null; c = [l[0] > 0 ? off : -off, 0]; }
  else { const off = hh - r; if (Math.abs(l[1]) <= off) return null; c = [0, l[1] > 0 ? off : -off]; }
  return add(rotPt(c, -deg), pos);
}
/** isPointOnRoundedCorner. */
function onRoundedCorner(p: V, pos: V, size: V, radius: number, deg: number): V | null {
  const l = rotPt(sub(p, pos), deg); const ihw = Math.trunc(size[0] / 2) - radius, ihh = Math.trunc(size[1] / 2) - radius;
  if (!(Math.abs(l[0]) > ihw) || !(Math.abs(l[1]) > ihh)) return null;
  return add(rotPt([l[0] > 0 ? ihw : -ihw, l[1] > 0 ? ihh : -ihh], -deg), pos);
}
/** TEARDROP_MANAGER::computeCurvedForRoundShape. */
function curvedRound(w: World, prm: TdPrm, out: V[], layer: string, trackHW: number, dir: [number, number], other: Anchor, otherPos: V, pts: Pts5): void {
  const maxErr = w.maxErr; let vp = prm.widthRatio; const tdH = KR(getWidth(w, other, layer) * vp);
  if (prm.maxWidth > 0 && prm.maxWidth < tdH) vp *= prm.maxWidth / tdH;
  let radius = Math.trunc(getWidth(w, other, layer) / 2); if (radius === 0) radius = 1;
  const minVp = trackHW / radius; const weaken = (vp - minVp) / (1 - minVp) / radius;
  let vecC = sub(pts[2], otherPos); const distC = normI(vecC);
  if (distC > 0 && Math.abs(distC - radius) > maxErr) { pts[2] = add(otherPos, resize(vecC, radius)); vecC = sub(pts[2], otherPos); }
  let vecE = sub(pts[4], otherPos); const distE = normI(vecE);
  if (distE > 0 && Math.abs(distE - radius) > maxErr) { pts[4] = add(otherPos, resize(vecE, radius)); vecE = sub(pts[4], otherPos); }
  const biasBC = 0.5 * normI(sub(pts[2], pts[1])), biasAE = 0.5 * normI(sub(pts[0], pts[4]));
  const tC = vi(pts[2][0] - vecC[1] * biasBC * weaken, pts[2][1] + vecC[0] * biasBC * weaken);
  const tE = vi(pts[4][0] + vecE[1] * biasAE * weaken, pts[4][1] - vecE[0] * biasAE * weaken);
  const tB = vi(pts[1][0] - dir[0] * biasBC, pts[1][1] - dir[1] * biasBC);
  const tA = vi(pts[0][0] - dir[0] * biasAE, pts[0][1] - dir[1] * biasAE);
  out.push(...bezierPoly(pts[1], tB, tC, pts[2], maxErr)); out.push(pts[3]); out.push(...bezierPoly(pts[4], tE, tA, pts[0], maxErr));
}
/** TEARDROP_MANAGER::computeCurvedForRectShape. */
function curvedRect(w: World, out: V[], pts: Pts5, inter: V, other: Anchor, otherPos: V, layer: string): void {
  const maxErr = w.maxErr; const side1 = sub(pts[2], pts[1]), side2 = sub(pts[4], pts[0]); const trackDir = sub(inter, half(add(pts[0], pts[1])));
  let rrect = false, oval = false, cr = 0, size: V = [0, 0], deg = 0;
  if (other.k === "pad") { const s = padShape(w, other, layer); if (s.shape === "roundrect") { rrect = true; cr = s.rr; size = s.size; deg = other.orient; } else if (s.shape === "oval") { oval = true; size = s.size; deg = other.orient; } }
  const toward: V = [-trackDir[0], -trackDir[1]];
  let ctrl1 = add(pts[1], resize(trackDir, Math.trunc(normI(side1) / 4))); let ctrl2 = half(add(pts[2], inter));
  const tangentAt = (p: V, side: V): V | null => {
    const c = rrect && cr > 0 ? onRoundedCorner(p, otherPos, size, cr, deg) : oval ? onOvalEnd(p, otherPos, size, deg) : null;
    return c ? cornerTangent(p, c, 0.5 * normI(side), toward) : null;
  };
  ctrl2 = tangentAt(pts[2], side1) || ctrl2;
  out.push(...bezierPoly(pts[1], ctrl1, ctrl2, pts[2], maxErr)); out.push(pts[3]);
  ctrl1 = tangentAt(pts[4], side2) || half(add(pts[4], inter));
  ctrl2 = add(pts[0], resize(trackDir, Math.trunc(normI(side2) / 4)));
  out.push(...bezierPoly(pts[4], ctrl1, ctrl2, pts[0], maxErr));
}
/** TEARDROP_MANAGER::computeTeardropPolygon. */
function computeTeardropPolygon(m: Mgr, prm: TdPrm, track0: Trk, source: Trk, other: Anchor, otherPos: V): V[] | null {
  const w = m.w; const f = findAnchorPointsOnTrack(m, prm, track0, source, other, otherPos); if (!f) return null;
  const { start, end, inter } = f; const track = f.track; const stub = f.len;
  if (eq(start, end)) return null;
  const vecT = unit(sub(end, start)); const two = track !== track0;
  let vecVia = vecT; if (two && !eq(start, inter)) vecVia = unit(sub(start, inter));
  let hw = Math.trunc(track.width / 2); if (track.arc) hw = Math.max(Math.trunc(track.width / 4), Math.trunc(track.width / 2) - w.maxErr);
  const pointB = add(start, vi(vecT[0] * stub + vecT[1] * hw, vecT[1] * stub - vecT[0] * hw));
  const pointA = add(start, vi(vecT[0] * stub - vecT[1] * hw, vecT[1] * stub + vecT[0] * hw));
  const layer = track.layer;
  if (!isRound(w, other, layer) && (hitTest(w, other, pointA, layer) || hitTest(w, other, pointB, layer))) return null;
  const padRadius = Math.trunc(getWidth(w, other, layer) / 2);
  const intToPad: [number, number] = [otherPos[0] - inter[0], otherPos[1] - inter[1]];
  const proj = -(intToPad[0] * vecVia[0] + intToPad[1] * vecVia[1]);
  const offset = 1000;   // 0.001 mm
  const custom = other.k === "pad" && padShape(w, other, layer).shape === "custom";
  let eff = custom ? padRadius : Math.max(proj, padRadius);
  if (!isRound(w, other, layer) && other.k === "pad") {
    const ps = padShape(w, other, layer); const reach = eff + 2 * ps.boundR + offset;
    const rayEnd = add(inter, [KR(-vecVia[0] * reach), KR(-vecVia[1] * reach)]); const hits: V[] = [];
    for (const o of ps.polys) chainSegHits(o, inter, rayEnd, hits);
    const crossings = hits.map((h) => normD(sub(h, inter))).filter((d) => d > offset).sort((a, b) => a - b);
    let exit = 0;
    for (const d of crossings) { const probe = add(inter, [KR(-vecVia[0] * (d + offset)), KR(-vecVia[1] * (d + offset))]); if (!containsAny(ps.polys, probe)) { exit = d; break; } }
    eff = Math.min(eff, Math.max(0, exit - 2 * offset));
  } else {
    const R = padRadius, dsq = intToPad[0] ** 2 + intToPad[1] ** 2, disc = proj * proj - (dsq - R * R);
    if (disc >= 0) { const far = proj + Math.sqrt(disc); const maxA = Math.max(0, far - 2 * offset); if (eff > maxA) eff = maxA; }
  }
  const pointD = add(inter, [KR(-vecVia[0] * (eff + offset)), KR(-vecVia[1] * (eff + offset))]);
  let jB2: V = [0, 0], jB1: V = [0, 0], jA2: V = [0, 0], jA1: V = [0, 0];
  if (two) {
    jB2 = add(start, [KR(vecT[1] * hw), KR(-vecT[0] * hw)]); jA2 = add(start, [KR(-vecT[1] * hw), KR(vecT[0] * hw)]);
    jB1 = add(start, [KR(vecVia[1] * hw), KR(-vecVia[0] * hw)]); jA1 = add(start, [KR(-vecVia[1] * hw), KR(vecVia[0] * hw)]);
  }
  let skipA = false, skipB = false;
  if (two) {
    const tA = sub(jA2, jA1), dA = sub(pointA, jA1); skipA = tA[0] * dA[0] + tA[1] * dA[1] < 0;
    const tB = sub(jB2, jB1), dB = sub(pointB, jB1); skipB = tB[0] * dB[0] + tB[1] * dB[1] < 0;
  }
  const pts: Pts5 = [two ? jA1 : pointA, two ? jB1 : pointB, [0, 0], pointD, [0, 0]];
  if (!computeAnchorPoints(w, prm, layer, other, otherPos, pts)) return null;
  if (isRound(w, other, layer)) {
    const perp: [number, number] = [-vecVia[1], vecVia[0]]; const perpDist = intToPad[0] * perp[0] + intToPad[1] * perp[1];
    if (Math.abs(perpDist) > padRadius * 0.1) {
      const d = Math.abs(perpDist);
      if (d < padRadius) {
        const maxSym = padRadius - d; const preferred = KR(getWidth(w, other, layer) * prm.widthRatio); let maxHalf = Math.trunc(preferred / 2);
        if (prm.maxWidth > 0) maxHalf = Math.min(maxHalf, Math.trunc(prm.maxWidth / 2));
        const sym = Math.min(maxSym, maxHalf);
        if (sym > hw) {
          const R = padRadius;
          const at = (pd: number): V => {
            const along = intToPad[0] * vecVia[0] + intToPad[1] * vecVia[1];
            const o: [number, number] = [inter[0] + vecVia[0] * along + perp[0] * pd, inter[1] + vecVia[1] * along + perp[1] * pd];
            const oc = [o[0] - otherPos[0], o[1] - otherPos[1]]; const b = oc[0] * vecVia[0] + oc[1] * vecVia[1], c = oc[0] * oc[0] + oc[1] * oc[1] - R * R, disc = b * b - c;
            if (disc < 0) return [KR(o[0]), KR(o[1])];
            const sq = Math.sqrt(disc), t1 = -b - sq, t2 = -b + sq;
            const p1 = [o[0] + vecVia[0] * t1, o[1] + vecVia[1] * t1], p2 = [o[0] + vecVia[0] * t2, o[1] + vecVia[1] * t2];
            return Math.hypot(p1[0] - inter[0], p1[1] - inter[1]) < Math.hypot(p2[0] - inter[0], p2[1] - inter[1]) ? [KR(p1[0]), KR(p1[1])] : [KR(p2[0]), KR(p2[1])];
          };
          pts[2] = at(-sym); pts[4] = at(sym);
        }
      }
    }
  }
  const out: V[] = [];
  if (!prm.curved) {
    if (two) { out.push(pointA, pointB); if (!skipB) out.push(jB2); out.push(pts[1], pts[2], pts[3], pts[4], pts[0]); if (!skipA) out.push(jA2); return out; }
    return pts;
  }
  const wrap = (curve: V[]): void => { out.push(pointB); if (!skipB) out.push(jB2); out.push(...curve); if (!skipA) out.push(jA2); out.push(pointA); };
  if (isRound(w, other, layer)) {
    if (two) { const c: V[] = []; curvedRound(w, prm, c, layer, hw, vecVia, other, otherPos, pts); wrap(c); }
    else curvedRound(w, prm, out, layer, hw, vecT, other, otherPos, pts);
  } else {
    if (two) { const c: V[] = []; curvedRect(w, c, pts, inter, other, otherPos, layer); wrap(c); }
    else curvedRect(w, out, pts, inter, other, otherPos, layer);
  }
  return out;
}
/** TEARDROP_MANAGER::computeFittedTeardropPolygon: the shape asked for, else the widest that clears other nets. */
function computeFitted(m: Mgr, prm: TdPrm, track: Trk, source: Trk, other: Anchor, otherPos: V): V[] | null {
  const exempt: Copper[] = [other, source, track];
  const pts = computeTeardropPolygon(m, prm, track, source, other, otherPos); if (!pts) return null;
  if (!collidesWithOtherNets(m, pts, source, exempt)) return pts;
  const preferred = KR(getWidth(m.w, other, track.layer) * prm.widthRatio);
  let hi = prm.maxWidth > 0 ? Math.min(prm.maxWidth, preferred) : preferred, lo = track.width;
  if (lo >= hi) return null;
  let fitted: V[] | null = null;
  const tryWidth = (wd: number): boolean => { const c = computeTeardropPolygon(m, { ...prm, maxWidth: wd }, track, source, other, otherPos); if (!c || collidesWithOtherNets(m, c, source, exempt)) return false; fitted = c; return true; };
  if (!tryWidth(lo)) return null;
  for (let ii = 0; ii < 4 && hi - lo > 1; ii++) { const mid = lo + Math.trunc((hi - lo) / 2); if (tryWidth(mid)) lo = mid; else hi = mid; }
  return fitted && (fitted as V[]).length ? fitted : null;
}
/** TEARDROP_MANAGER::computeChordThroughShape. */
function chordThroughShape(w: World, t: Trk, other: Anchor, layer: string, inside: V): number {
  if (t.arc) return INT_MAX;
  const delta = sub(t.end, t.start); const len = normD(delta); if (len === 0) return INT_MAX;
  const buf = shapeBuffer(w, other, layer, posOf(other));
  const dir: [number, number] = [delta[0] / len, delta[1] / len]; const mid = half(add(t.start, t.end));
  const bb = bboxOf(buf.flat()); const reach = KR(Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) + len);
  const s0 = sub(mid, [KR(dir[0] * reach), KR(dir[1] * reach)]), s1 = add(mid, [KR(dir[0] * reach), KR(dir[1] * reach)]);
  const hits: V[] = []; for (const o of buf) chainSegHits(o, s0, s1, hits);
  if (hits.length < 2) return INT_MAX;
  const proj = hits.map((h) => (h[0] - s0[0]) * dir[0] + (h[1] - s0[1]) * dir[1]).sort((a, b) => a - b);
  const ip = (inside[0] - s0[0]) * dir[0] + (inside[1] - s0[1]) * dir[1];
  for (let i = 0; i + 1 < proj.length; i++) {
    const sm: V = add(s0, [KR(dir[0] * (proj[i] + proj[i + 1]) / 2), KR(dir[1] * (proj[i] + proj[i + 1]) / 2)]);
    if (!containsAny(buf, sm)) continue;
    if (ip >= proj[i] && ip <= proj[i + 1]) return KR(proj[i + 1] - proj[i]);
  }
  return INT_MAX;
}

// ---------------------------------------------------------------- zones
const ptsText = (pts: V[]): string => pts.map((p) => `(xy ${mm(p[0])} ${mm(p[1])})`).join(" ");
function netText(w: World, net: string): string {
  if (!net) return "";
  const code = net.startsWith("#") ? +net.slice(1) : 0, name = w.netNames.get(net) || (code ? (w.doc.nets ? String(w.doc.nets.get(code) || "") : "") : net);
  if (netStyle(w.doc) === "name") return `(net ${JSON.stringify(name)})`;
  return `(net ${code}) (net_name ${JSON.stringify(name)})`;
}
/** TEARDROP_MANAGER::createTeardrop / createTeardropMask: the zone node. */
function teardropNode(w: World, type: string, pts: V[], src: Trk, uuid: string, priority: number, mask: boolean): SNode {
  let outline = pts; let minThick = 25400; let layer = src.layer;
  if (mask) {
    layer = src.layer === "F.Cu" ? "F.Mask" : "B.Mask";
    const exp = solderMaskExpansion(w, src);
    if (exp) {
      minThick = Math.max(minThick, exp);
      const r = clipInflate([pts.map((p) => ({ x: mm(p[0]), y: mm(p[1]) }))], mm(exp), false, mm(w.maxErr));
      if (r.length) outline = r[0].map((p) => [iu(p.x), iu(p.y)] as V);
    }
  }
  const head = mask ? "" : netText(w, src.net);
  const conn = mask ? "(connect_pads (clearance 0.5))" : "(connect_pads yes (clearance 0))";
  const text = `(zone ${head} (layer ${JSON.stringify(layer)}) (uuid ${JSON.stringify(uuid)}) (hatch none 0.1)${priority > 0 ? ` (priority ${priority})` : ""} (attr (teardrop (type ${type}))) ${conn} (min_thickness ${mm(minThick)}) (fill yes (island_removal_mode 1)) (polygon (pts ${ptsText(outline)})) (filled_polygon (layer ${JSON.stringify(layer)}) (pts ${ptsText(outline)})))`;
  return K.parse(text) as SNode;
}
/** PCB_TRACK::GetSolderMaskExpansion: the track's own margin, else the board's (pad_to_mask_clearance), at least -width/2. */
function solderMaskExpansion(w: World, t: Trk): number {
  let m = t.maskMargin;
  if (m === null) { const setup = (w.doc as unknown as { setupNode?: SNode | null }).setupNode; const p = setup && K.kid(setup, "pad_to_mask_clearance"); m = p ? iu(K.num(p[1])) : 0; }
  return Math.max(m, -Math.trunc(t.width / 2));
}
const isExternal = (l: string): boolean => l === "F.Cu" || l === "B.Cu";
/** createAndAddTeardropWithMask. */
function addTeardrop(m: Mgr, type: "padvia" | "track_end", pts: V[], src: Trk, uuid: string): void {
  const node = teardropNode(m.w, type, pts, src, uuid, 0, false);
  m.created.push({ k: "zone", id: uuid, uuid, layer: src.layer, net: src.net, type, outline: pts, fill: [pts], priority: 0, item: null, box: bboxOf(pts), created: true, node });
  if (src.mask && isExternal(src.layer)) {
    const mu = maskUuidFor(uuid); const mn = teardropNode(m.w, type, pts, src, mu, 0, true);
    m.created.push({ k: "zone", id: mu, uuid: mu, layer: src.layer === "F.Cu" ? "F.Mask" : "B.Mask", net: "", type, outline: pts, fill: [pts], priority: 0, item: null, box: bboxOf(pts), created: true, node: mn });
  }
}
function tryTrackTeardrop(m: Mgr, prm: TdPrm, type: "padvia" | "track_end", track: Trk, source: Trk, cand: Anchor, pos: V, uuid: string): boolean {
  const pts = computeFitted(m, prm, track, source, cand, pos); if (!pts) return false;
  addTeardrop(m, type, pts, source, uuid); return true;
}
/** buildCrossingStub: a track from one end of the crossing track to the point nearest the anchor. */
function crossingStub(t: Trk, crossed: V, from: V): Trk {
  const end = t.arc && t.mid ? arcNearest(t.start, t.mid, t.end, crossed) : nearestOnSeg(crossed, t.start, t.end);
  return { ...t, arc: false, mid: null, start: from, end, box: grow(bboxOf([from, end]), Math.ceil(t.width / 2)) };
}

// ---------------------------------------------------------------- TEARDROP_MANAGER
/** TEARDROP_MANAGER::UpdateTeardrops (without the full-update removal, done by the caller). */
function updateTeardrops(m: Mgr, dirtyPV: Set<string> | null, dirtyTracks: Set<string> | null, force: boolean, trackPrm: TdPrm): void {
  const w = m.w; m.tolerance = 10000;
  for (const track of w.tracks) {
    const { pads, vias } = connectedPadsAndVias(w, track);
    const forceUpdate = force || (!!dirtyTracks && dirtyTracks.has(track.id));
    for (const a of [...pads, ...vias] as (Pad | Via)[]) {
      if (!forceUpdate && !(dirtyPV && dirtyPV.has(a.id))) continue;
      const prm = a.td; const annular = getWidth(w, a, track.layer);
      if (!prm.enabled) continue;
      if ((prm.maxWidth > 0 && track.width >= prm.maxWidth) || track.width >= annular * prm.widthRatio || track.width >= annular * prm.filterRatio) continue;
      const sh = hitTest(w, a, track.start, track.layer), eh = hitTest(w, a, track.end, track.layer);
      if (sh && eh) continue;
      if (sh !== eh && chordThroughShape(w, track, a, track.layer, sh ? track.start : track.end) < track.width) continue;
      if (a.k === "pad" && !prm.onPadsInZones && areItemsInSameZone(w, a, track)) continue;
      if (!sh && !eh && trackHit(track, a.pos)) {
        tryTrackTeardrop(m, prm, "padvia", crossingStub(track, a.pos, track.end), track, a, a.pos, teardropUuid(track.uuid, a.uuid, 0));
        tryTrackTeardrop(m, prm, "padvia", crossingStub(track, a.pos, track.start), track, a, a.pos, teardropUuid(track.uuid, a.uuid, 1));
      } else tryTrackTeardrop(m, prm, "padvia", track, track, a, a.pos, teardropUuid(track.uuid, a.uuid, 0));
    }
  }
  if ((force || (!!dirtyTracks && dirtyTracks.size > 0)) && trackPrm.enabled) addTeardropsOnTracks(m, dirtyTracks, force, trackPrm);
}
/** TEARDROP_MANAGER::AddTeardropsOnTracks. */
function addTeardropsOnTracks(m: Mgr, tracks: Set<string> | null, force: boolean, prm0: TdPrm): void {
  const w = m.w; const prm = { ...prm0 }; const groups = new Map<string, Trk[]>();
  for (const t of w.tracks) { const k = t.layer + "|" + t.net; const l = groups.get(k); if (l) l.push(t); else groups.set(k, [t]); }
  for (const list0 of groups.values()) {
    if (list0.length <= 1) continue;
    const list = list0.map((t, i) => ({ t, i })).sort((a, b) => (a.t.width - b.t.width) || (a.i - b.i)).map((x) => x.t);
    if (list[0].width === list[list.length - 1].width) continue;
    for (let ii = 0; ii < list.length - 1; ii++) {
      const track = list[ii]; const tlen = Math.trunc(trackLength(track)); const needs = force || (!!tracks && tracks.has(track.id));
      prm.filterRatio = Math.max(prm.filterRatio, 0.1); const minW = KR(track.width * (1 / prm.filterRatio));
      for (let jj = ii + 1; jj < list.length; jj++) {
        const cand = list[jj];
        if (minW >= cand.width) continue;
        if (tlen <= Math.trunc(cand.width / 2)) continue;
        let pos = cand.start; let mt = pointOnEnds(track, pos, m.tolerance);
        if (!mt) { pos = cand.end; mt = pointOnEnds(track, pos, m.tolerance); }
        if (!mt) continue;
        if (!needs && !(tracks && tracks.has(cand.id))) continue;
        const { pads, vias } = connectedPadsAndVias(w, track);
        if (pads.some((p) => hitTest(w, p, pos, track.layer)) || vias.some((v) => hitTest(w, v, pos, track.layer))) continue;
        tryTrackTeardrop(m, prm, "track_end", track, track, cand, pos, teardropUuid(track.uuid, cand.uuid, 0));
      }
    }
  }
}
/** TEARDROP_MANAGER::setTeardropPriorities. */
function setTeardropPriorities(m: Mgr): void {
  const copper = m.w.copper; const li = (l: string): number => { const i = copper.indexOf(l); return i < 0 ? 1000 + (l === "F.Mask" ? 0 : 1) : i; };
  const area = new Map<Zn, number>(); for (const z of m.created) area.set(z, areaAbs(z.outline));
  const list = m.created.slice().sort((a, b) => li(a.layer) !== li(b.layer) ? li(a.layer) - li(b.layer) : area.get(a) !== area.get(b) ? area.get(b)! - area.get(a)! : a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0);
  const taken = new Map<string, Set<number>>();
  for (const z of m.w.tdZones) if (!m.removed.has(z.id)) { let s = taken.get(z.layer); if (!s) taken.set(z.layer, s = new Set()); s.add(z.priority); }
  let cur: string | null = null, base = MAGIC_TEARDROP_ZONE_ID;
  for (const z of list) {
    if (z.layer !== cur) { cur = z.layer; base = MAGIC_TEARDROP_ZONE_ID; }
    const t = taken.get(cur) || new Set<number>(); while (t.has(base) && base < 4294967295) base++;
    z.priority = base; if (base < 4294967295) base++;
    setPriority(z.node!, z.priority);
  }
  m.created = list;
}
function setPriority(node: SNode, p: number): void {
  const i = node.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "priority");
  if (p <= 0) { if (i > 0) node.splice(i, 1); return; }
  if (i > 0) { node[i] = ["priority", p]; return; }
  const h = node.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "hatch"); node.splice(h > 0 ? h + 1 : node.length, 0, ["priority", p]);
}
/** The REMOVED / ADDED (or MODIFIED, for a teardrop rebuilt with the same uuid) changes for a run. */
function emit(m: Mgr, already: Set<string>): PcbChange[] {
  const out: PcbChange[] = []; const createdById = new Map(m.created.map((z) => [z.id, z]));
  for (const id of m.removed) {
    if (already.has(id)) continue;
    const it = m.w.doc.items.get(id); if (!it) continue;
    const c = createdById.get(id);
    if (c) { createdById.delete(id); if (K.serialize(c.node!) !== K.serialize(it.node)) out.push(upsertChange({ id, kind: "zone", node: c.node! }, "MODIFIED")); continue; }
    out.push(removedChange(it));
  }
  for (const z of m.created) {
    if (!createdById.has(z.id) || already.has(z.id)) continue;
    const it = m.w.doc.items.get(z.id);
    out.push(upsertChange({ id: z.id, kind: "zone", node: z.node! }, it ? "MODIFIED" : "ADDED"));
  }
  return out;
}
const newMgr = (w: World): Mgr => ({ w, created: [], changes: [], removed: new Set(), tolerance: 0 });

/** A board with the changes applied, for looking at (the items are shared until a change replaces them). */
function appliedDoc(doc: BoardDoc, changes: PcbChange[]): BoardDoc {
  const b = Object.assign({}, doc, { items: new Map(doc.items), dupItems: [] }) as BoardDoc;
  for (const c of changes) { try { K.applyChange(b, c as never, 1e6); } catch (e) { /* a change the board cannot take: left out */ } }
  return b;
}
const isTeardropZone = (it: KItem | undefined): boolean => !!it && it.kind === "zone" && !!K.kid(K.kid(it.node, "attr") || ["x"], "teardrop");
const CU_KINDS = new Set(["segment", "arc", "via"]);
const isCopperDrawing = (it: KItem): boolean => /^gr_/.test(it.kind) && /\.Cu$/.test(K.str((K.kid(it.node, "layer") || [])[1]));

/**
 * Nothing for RemoveTeardrops / UpdateTeardrops to do: no teardrop zone on the board or in the edit, TARGET_TRACK
 * off, and no pad or via with its teardrops enabled (UpdateTeardrops skips a pad or via whose m_Enabled is false).
 * A plain scan of the nodes, so an ordinary edit on a board without teardrops builds no teardrop world.
 */
function teardropsIdle(doc: BoardDoc, post: BoardDoc, changes: PcbChange[], o: TeardropOpts): boolean {
  if (trackPrmOf(o).enabled) return false;
  const tdOn = (n: SNode): boolean => !!K.kid(n, "teardrops") && PM().readTeardrops(n).enabled;
  const busy = (it: KItem | undefined): boolean => !!it && (isTeardropZone(it) || (it.kind === "via" && tdOn(it.node)) || (it.kind === "footprint" && K.kids(it.node, "pad").some(tdOn)));
  for (const it of doc.items.values()) if (busy(it)) return false;
  for (const c of changes) if (busy(post.items.get(c.id))) return false;
  return true;
}
/**
 * BOARD_COMMIT::Push's teardrop pass for a set of board changes: the teardrops whose pads, vias or tracks the edit
 * touched (or whose neighbours of another net moved) go (RemoveTeardrops), and the dirty pads, vias and tracks get
 * theirs again (UpdateTeardrops).  Returns the changes to commit with the edit.
 */
export function teardropCommitChanges(doc: BoardDoc, changes: PcbChange[], o: TeardropOpts = {}): PcbChange[] {
  if (!changes.length || doc.fpEditor) return [];
  const post = appliedDoc(doc, changes);
  if (teardropsIdle(doc, post, changes, o)) return [];
  const pre = buildWorld(doc, o);
  const dirtyPV = new Set<string>(), dirtyTracks = new Set<string>(); const dirtyCopper: { box: Bx; net: string; layers: string[] }[] = [];
  const collect = (it: KItem | undefined): void => {
    if (!it) return;
    if (CU_KINDS.has(it.kind)) {
      const t = it.kind === "via" ? null : trackOf(it);
      if (t) dirtyCopper.push({ box: t.box, net: t.net, layers: [t.layer] });
      else { const v = pre.byId.get(it.id) as Via | undefined; const sz = K.kid(it.node, "size"), at = ptOf(K.kid(it.node, "at")), r = Math.ceil((sz ? iu(K.num(sz[1])) : 0) / 2); dirtyCopper.push({ box: grow([at[0], at[1], at[0], at[1]], r), net: netKey(it.node), layers: v ? [...v.layers] : [...viaLayers(it.node, pre.copper)] }); }
    } else if (it.kind === "footprint") {
      for (const p of padsOf(it)) { const r = iu(Math.hypot(p.w, p.h) / 2 + Math.hypot(p.off[0], p.off[1])); const at: V = [iu(p.x), iu(p.y)]; dirtyCopper.push({ box: grow([at[0], at[1], at[0], at[1]], r), net: netKey(p.node), layers: [...cuLayers(p.layers, pre.copper)] }); }
    } else if (isCopperDrawing(it)) { const g = gfxOf(it); if (g) dirtyCopper.push({ box: g.box, net: g.net, layers: [g.layer] }); }
  };
  const already = new Set<string>();
  for (const c of changes) {
    already.add(c.id);
    const before = doc.items.get(c.id), after = post.items.get(c.id);
    const item = after || before; if (!item) continue;
    if (item.kind === "zone" || item.kind === "group" || item.kind === "generated") continue;
    collect(after); collect(before);
    if (item.kind === "footprint") { for (const it of [after, before]) if (it) for (const p of padsOf(it)) { const u = K.kid(p.node, "uuid"); dirtyPV.add(it.id + "#" + (u ? K.str(u[1]) : p.index)); } }
    else if (item.kind === "via") dirtyPV.add(item.id);
    else if (item.kind === "segment" || item.kind === "arc") {
      dirtyTracks.add(item.id);
      const t = pre.byId.get(item.id) as Trk | undefined;
      if (t) { const { pads, vias } = connectedPadsAndVias(pre, t); for (const a of [...pads, ...vias]) dirtyPV.add(a.id); }
    }
  }
  if (!dirtyPV.size && !dirtyTracks.size && !dirtyCopper.length) return [];
  // RemoveTeardrops, on the board as it was (its connectivity is the one before the edit)
  const w = buildWorld(post, o);
  const m = newMgr(w);
  const byLayer = new Map<string, typeof dirtyCopper>();
  for (const d of dirtyCopper) for (const l of d.layers) { let a = byLayer.get(l); if (!a) byLayer.set(l, a = []); a.push(d); }
  const zonesNow = w.tdZones; const anchors = new Map<string, Set<string>>();
  for (const z of zonesNow) {
    if (!pre.copper.includes(z.layer)) continue;
    const old = pre.tdZones.find((x) => x.id === z.id);
    anchors.set(z.id, old ? zoneAnchors(pre, old) : new Set());
  }
  for (const z of zonesNow) {
    const a = anchors.get(z.id); if (!a) continue;
    const list = byLayer.get(z.layer); if (!list) continue;
    const reach = grow(z.box, w.maxClear);
    if (!list.some((d) => !(z.net !== "" && d.net === z.net) && boxHit(reach, d.box))) continue;
    for (const id of a) { const x = pre.byId.get(id); if (x && x.k === "track") dirtyTracks.add(id); else dirtyPV.add(id); }
  }
  const survives = new Map<string, boolean>(); const surviving = new Map<string, Zn[]>();
  for (const z of zonesNow) {
    const a = anchors.get(z.id); if (!a) continue;
    const stale = [...a].some((id) => dirtyPV.has(id) || dirtyTracks.has(id));
    survives.set(maskUuidFor(z.uuid), !stale);
    if (stale) m.removed.add(z.id); else { let l = surviving.get(z.layer); if (!l) surviving.set(z.layer, l = []); l.push(z); }
  }
  for (const z of zonesNow) {
    if (anchors.has(z.id)) continue;
    let covers: boolean; const s = survives.get(z.uuid);
    if (s !== undefined) covers = s;
    else {
      const cu = z.layer === "F.Mask" ? "F.Cu" : "B.Cu"; covers = false;
      const c1: V = [(z.box[0] + z.box[2]) / 2, (z.box[1] + z.box[3]) / 2];
      for (const c of surviving.get(cu) || []) {
        const c2: V = [(c.box[0] + c.box[2]) / 2, (c.box[1] + c.box[3]) / 2];
        const inB = (b: Bx, p: V): boolean => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
        if (inB(z.box, c2) && inB(c.box, c1)) { covers = true; break; }
      }
    }
    if (!covers) m.removed.add(z.id);
  }
  // already removed or replaced by the edit itself: nothing to do for them
  for (const id of [...m.removed]) if (already.has(id)) m.removed.delete(id);
  if (!w.legacy && (dirtyPV.size || dirtyTracks.size)) {
    const w2 = buildWorld(post, o, m.removed); const m2: Mgr = { w: w2, created: [], changes: [], removed: m.removed, tolerance: 0 };
    w2.tdZones = w2.tdZones.filter((z) => !m.removed.has(z.id));
    updateTeardrops(m2, dirtyPV, dirtyTracks, false, trackPrmOf(o));
    setTeardropPriorities(m2);
    m.created = m2.created;
  }
  m.w = w;
  return emit(m, already);
}

/** TEARDROP_MANAGER::UpdateTeardrops( commit, nullptr, nullptr, true ): every teardrop rebuilt (Fill All, Edit Teardrops). */
export function teardropFullUpdate(doc: BoardDoc, o: TeardropOpts = {}): PcbChange[] {
  if (doc.fpEditor) return [];
  const w = buildWorld(doc, o); if (w.legacy) return [];
  const m = newMgr(w);
  for (const z of w.tdZones) m.removed.add(z.id);
  const w2 = buildWorld(doc, o, m.removed); w2.tdZones = [];
  const m2: Mgr = { w: w2, created: [], changes: [], removed: m.removed, tolerance: 0 };
  updateTeardrops(m2, null, null, true, trackPrmOf(o));
  setTeardropPriorities(m2);
  m.created = m2.created;
  return emit(m, new Set());
}
/** TEARDROP_MANAGER::DeleteTrackToTrackTeardrops. */
export function deleteTrackToTrackTeardrops(doc: BoardDoc): PcbChange[] {
  const out: PcbChange[] = [];
  for (const it of doc.items.values()) if (isTeardropZone(it)) { const z = zoneOf(it); if (z && z.type === "track_end") out.push(removedChange(it)); }
  return out;
}
/** TEARDROP_MANAGER::AddTeardropsOnTracks( commit, nullptr, true ) with the track caches built (Edit Teardrops, Track to track). */
export function addTrackToTrackTeardrops(doc: BoardDoc, o: TeardropOpts = {}, exclude?: Set<string>): PcbChange[] {
  const w = buildWorld(doc, o, exclude); if (exclude) w.tdZones = w.tdZones.filter((z) => !exclude.has(z.id));
  const m = newMgr(w); m.tolerance = 0;
  addTeardropsOnTracks(m, null, true, { ...trackTargetParams(o.project), enabled: true });
  setTeardropPriorities(m);
  return emit(m, new Set());
}
export { appliedDoc as teardropAppliedDoc };
/**
 * The changes of b made after those of a, as one commit: one change per item (an undo step applies its inverse in
 * order, so an item must not appear twice).  ADDED then MODIFIED is ADDED, ADDED then REMOVED is nothing, REMOVED then
 * ADDED is MODIFIED, MODIFIED then REMOVED is REMOVED.
 */
export function foldChanges(a: PcbChange[], b: PcbChange[]): PcbChange[] {
  const out = a.slice(); const at = new Map<string, number>(); out.forEach((c, i) => at.set(c.id, i));
  const drop = new Set<number>();
  for (const c of b) {
    const i = at.get(c.id);
    if (i === undefined || drop.has(i)) { at.set(c.id, out.length); out.push(c); continue; }
    const p = out[i];
    if (p.kind === "ADDED") { if (c.kind === "REMOVED") drop.add(i); else out[i] = { ...c, kind: "ADDED" }; }
    else if (p.kind === "REMOVED") out[i] = c.kind === "REMOVED" ? p : { ...c, kind: "MODIFIED" };
    else out[i] = c.kind === "ADDED" ? { ...c, kind: "MODIFIED" } : c;
  }
  return out.filter((_c, i) => !drop.has(i));
}
