// pcb-tools/spread.ts — Spread Tracks (ROUTER_TOOL::SpreadTracks with PNS::TRACKS_SPREADER, pns_tracks_spreader.cpp).
//
// The selected tracks are spread around a picked one: the tool starts with a selection of tracks, the first click
// picks the track to spread the others around (the root) and where on it the spreading starts; the cursor then drags
// a point along the root, and every selected line is walked around the stretch of the root from the start to that
// point (and around the lines spread before it) at the spreading distance, walked back with the normal clearance,
// and optimized inside the area that changed.  The second click commits ("Routing").  E sets the spreading distance
// (an integer in nanometres, as KiCad's dialog takes it), ] and [ step it by one grid unit.
import type { Box, DesignSettings, Obstacle, ObstacleIndex, PcbChange, PcbCtx, Pt, TrackLine } from "./types";
import { addedChange, removedChange } from "./changes";
import { openForm, settingsOf } from "./dialogs";
import { changedArea, inBox } from "./drag-optimize";
import { assembleLine, initialTrace, peq, rp, snapGrab, trackEnds } from "./dragger";
import { shapeBBox } from "./distances";
import { applySelection, selectionIds } from "./groups";
import { hitTestItem } from "./hit";
import { commonParallelProjection } from "./meander";
import { mergeFull } from "./optimize-selected";
import { setRouterSettings } from "./router-settings";
import { segIntersect, walkAroundHull } from "./shove";
import { ANG_ACUTE, ANG_HALF_FULL, ANG_RIGHT, angleType } from "./smartpads";
import { HIT_MM, K, S, bind } from "./state";
import { clone, layerOf, r6 } from "./util";
import { ROUTE_EPS, dir8, hullOf, indexObstacles, pathHits, ptsLength, routeClearance, routeObstacles, simplifyPts } from "./walkaround";
import { errorMessage } from "./via-stack";

const IU = 1e6;   // nanometres per mm: the spreading distance is held in internal units as the router settings keep it
/** commonParallelProjection's overlap above which a walked segment still lies on its original one (100 nm). */
const OVERLAP_MAX = 100 / IU;

interface SpreadLine {
  origin: TrackLine;
  /** the line split at p_start / p_end (breakAndReassemble): the part before, the spreadable part, the part after */
  pre: Pt[]; mid: Pt[]; post: Pt[];
  forward: Pt[] | null; spreadable: boolean[]; backward: Pt[] | null; optimized: Pt[] | null;
}
interface SpreadState {
  /** the selected tracks, in selection order (the spreader's aux items) */
  items: KItem[];
  picking: boolean;
  start: KItem | null; anchor: Pt | null;
  root: TrackLine | null; lines: SpreadLine[];
  /** the root split at the anchor and the cursor's nearest point: the clipped head and the rest */
  head: Pt[] | null; rootChunks: Pt[][];
  /** the start item the cursor is over while picking */
  hoverItem: KItem | null;
  done: boolean;
}
let SP: SpreadState | null = null;
export const spreading = () => SP;
const spreadDist = () => Math.max(0, Number(S.rs.spread_tracks_distance) || 0) / IU;

// ---------------------------------------------------------------- polyline helpers (SHAPE_LINE_CHAIN)
/** NearestPoint and PathLength: the point of the chain closest to p and how far along the chain it lies. */
export function nearestOnChain(pts: Pt[], p: Pt): { p: Pt; len: number } {
  let best: Pt = pts[0].slice(), bd = Infinity, bl = 0, acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy, L = Math.sqrt(l2);
    const k = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    const q: Pt = [a[0] + k * dx, a[1] + k * dy], d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < bd - 1e-12) { bd = d; best = rp(q); bl = acc + k * L; }
    acc += L;
  }
  return { p: best, len: bl };
}
/** PointAlong: the point that far along the chain. */
export function pointAlong(pts: Pt[], len: number): Pt {
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc + L >= len) { const k = L > 0 ? (len - acc) / L : 0; return rp([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]); }
    acc += L;
  }
  return pts[pts.length - 1].slice();
}
/** The chain between path lengths l0 and l1 (l0 <= l1), its ends inserted as vertices. */
export function subChain(pts: Pt[], l0: number, l1: number): Pt[] {
  const out: Pt[] = [pointAlong(pts, l0)]; let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    acc += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (acc > l0 + 1e-9 && acc < l1 - 1e-9) out.push(pts[i + 1].slice());
  }
  out.push(pointAlong(pts, l1));
  return out.filter((p, i) => i === 0 || !peq(p, out[i - 1]));
}
const segs = (pts: Pt[]) => pts.slice(0, -1).map((p, i) => [p, pts[i + 1]] as [Pt, Pt]);
/** SEG::Contains( p, threshold ) in mm. */
const segContains = (a: Pt, b: Pt, p: Pt, thr: number) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const k = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0; return Math.hypot(p[0] - a[0] - k * dx, p[1] - a[1] - k * dy) <= thr; };
/** SEG::ApproxCollinear: both ends of the shorter segment within the threshold of the longer one's line. */
function approxCollinear(s: [Pt, Pt], o: [Pt, Pt], thr: number) {
  const l2 = (x: [Pt, Pt]) => (x[1][0] - x[0][0]) ** 2 + (x[1][1] - x[0][1]) ** 2;
  const [a, b] = l2(s) < l2(o) ? [o, s] : [s, o];
  const p = a[0][1] - a[1][1], q = a[1][0] - a[0][0], L = Math.hypot(p, q); if (!L) return false;
  const d = (pt: Pt) => Math.abs(p * (pt[0] - a[0][0]) + q * (pt[1] - a[0][1])) / L;
  return d(b[0]) <= thr && d(b[1]) <= thr;
}
/** SEG::ApproxOverlaps( aSeg ) with KiCad's default 3 nm threshold. */
export function approxOverlaps(s: [Pt, Pt], o: [Pt, Pt]) {
  const thr = 3 / IU;
  if (peq(s[0], s[1])) { if (peq(o[0], s[0]) || peq(o[1], s[0])) return false; return segContains(o[0], o[1], s[0], thr); }
  if (!approxCollinear(o, s, thr)) return false;
  return segContains(o[0], o[1], s[0], thr) || segContains(o[0], o[1], s[1], thr) || segContains(s[0], s[1], o[0], thr) || segContains(s[0], s[1], o[1], thr);
}
const projection = (s: [Pt, Pt], o: [Pt, Pt]) => commonParallelProjection({ A: s[0], B: s[1] }, { A: o[0], B: o[1] });

// ---------------------------------------------------------------- the spreadable lines (prepareSpreadableLines)
/**
 * TRACKS_SPREADER::prepareSpreadableLines: the root line through the start item, then one line per selected track not
 * already part of one (nor of the root); each is cut to the stretch its selected tracks cover, grown at both ends by
 * the root's width plus every line's width, and the lines are walked in order of their distance from the anchor.
 */
function prepareLines(doc: KDoc, st: SpreadState) {
  const root = assembleLine(doc as never, st.start!)!; st.root = root; st.lines = [];
  for (const it of st.items) {
    if (it.kind !== "segment") continue;
    if (root.ids.includes(it.id) || st.lines.some((l) => l.origin.ids.includes(it.id))) continue;
    const ln = assembleLine(doc as never, it); if (!ln) continue;
    st.lines.push({ origin: ln, pre: [], mid: ln.pts.map((p) => p.slice()), post: [], forward: null, spreadable: [], backward: null, optimized: null });
  }
  let margin = root.width; for (const l of st.lines) margin += l.origin.width;
  for (const l of st.lines) {
    const shape = l.origin.pts; let near = -1, far = -1;
    for (const it of st.items) {
      if (it.kind !== "segment" || !l.origin.ids.includes(it.id)) continue;
      for (const a of trackEnds(it)) { const pl = nearestOnChain(shape, a).len; if (near < 0 || pl < near) near = pl; if (pl > far) far = pl; }
    }
    if (far < 0) continue;
    const L = ptsLength(shape), l0 = Math.max(0, near - margin), l1 = Math.min(L, far + margin);
    l.pre = l0 > 0 ? subChain(shape, 0, l0) : [];
    l.mid = subChain(shape, l0, l1);
    l.post = l1 < L ? subChain(shape, l1, L) : [];
  }
  // determineWalkOrder: nearest the anchor first
  const d2 = (l: SpreadLine) => { const q = nearestOnChain(l.origin.pts, st.anchor!).p; return (q[0] - st.anchor![0]) ** 2 + (q[1] - st.anchor![1]) ** 2; };
  st.lines.sort((a, b) => d2(a) - d2(b));
}

// ---------------------------------------------------------------- the node the spread is computed in
interface Extra { pts: Pt[]; w: number; net: string; processed: boolean; spreadable?: boolean[] }
/**
 * The obstacles a line meets in the spread node: the board's copper on its layer without the root and the spread lines
 * (they stand in their split pieces and new shapes), plus `extra` pieces.  `clr(processed, spreadable, rr)` gives each
 * one its clearance (the spreader's clearance override, NODE::GetClearance: only where the rules give one).
 */
function spreadObstacles(ctx: PcbCtx, s: DesignSettings, line: SpreadLine, skip: Set<string>, extra: Extra[], clr: ((processed: boolean, spreadable: boolean, rr: number) => number) | null): ObstacleIndex {
  const doc = ctx.doc, key = line.origin.netKey, layer = line.origin.layer;
  const base = routeObstacles(doc, s, key, layer, null, skip).list.map((ob) => Object.assign({}, ob, { clr: clr && ob.clr > 0 ? clr(false, false, ob.clr) : ob.clr, hull: undefined, hullKey: undefined }) as Obstacle);
  for (const e of extra) {
    if (key && e.net === key) continue;   // the line's own net never collides
    segs(e.pts).forEach(([a, b], i) => {
      if (peq(a, b)) return;
      const shape = { t: "seg" as const, a, b, r: e.w / 2 };
      const rr = routeClearance(s, key, { kind: "track", net: e.net }, layer, doc);
      const c = clr && rr > 0 ? clr(e.processed, !!(e.spreadable && e.spreadable[i]), rr) : rr;
      base.push({ id: null, kind: "track", net: e.net, shape, bbox: shapeBBox(shape), clr: c } as Obstacle);
    });
  }
  return indexObstacles(base);
}
/** NODE::NearestObstacle: the hit obstacle whose hull the path enters first. */
function nearestObstacle(O: ObstacleIndex, path: Pt[], r: number): Obstacle | null {
  const hits = pathHits(O, path, r); if (!hits.length) return null;
  let best: Obstacle | null = null, bl = Infinity;
  for (const ob of hits) {
    const H = hullOf(ob, r); let acc = 0, first = Infinity;
    for (let i = 0; i + 1 < path.length && first === Infinity; i++) {
      const L = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
      for (let j = 0; j < H.length; j++) { const x = segIntersect(path[i], path[i + 1], H[j], H[(j + 1) % H.length]); if (x) first = Math.min(first, acc + x.t * L); }
      acc += L;
    }
    if (first === Infinity) first = 0;
    if (first < bl) { bl = first; best = ob; }
  }
  return best;
}
type WalkStatus = "done" | "progress" | "almost" | "stuck";
/**
 * WALKAROUND::Route with the CW and CCW policies (any complete one is a success), no clustering and no length limit:
 * each step walks every policy's line round the hull of the nearest obstacle it hits, until one is clear, a walk
 * fails, or the iteration limit; a line that no longer starts where it did is stuck, one that ends elsewhere almost done.
 */
export function walkaroundRoute(O: ObstacleIndex, init: Pt[], r: number, limit: number): { status: WalkStatus[]; lines: Pt[][] } {
  const status: WalkStatus[] = ["progress", "progress"], lines = [init.map((p) => p.slice()), init.map((p) => p.slice())];
  for (let it = 0; it < limit; it++) {
    for (let pol = 0; pol < 2; pol++) {
      if (status[pol] !== "progress") continue;
      const ob = nearestObstacle(O, lines[pol], r); if (!ob) { status[pol] = "done"; continue; }
      const np = walkAroundHull(simplifyPts(lines[pol]), hullOf(ob, r), pol === 0 ? 1 : -1);
      if (!np) { status[pol] = "stuck"; continue; }
      lines[pol] = np;
    }
    if (status.includes("done") || !status.includes("progress")) break;
  }
  for (let pol = 0; pol < 2; pol++) {
    if (status[pol] === "progress") status[pol] = "almost";
    const ln = lines[pol];
    if (ln.length < 2 || !peq(ln[0], init[0])) status[pol] = "stuck";
    if (ln.length > 0 && !peq(ln[ln.length - 1], init[init.length - 1])) status[pol] = "almost";
  }
  return { status, lines };
}
/** OPTIMIZER::dragFixCorner at the line's last corner (dragFixCorners with no preserved vertex): a right or sharper corner becomes the smaller clear 45° bypass. */
function dragFixLastCorner(O: ObstacleIndex, path: Pt[], r: number, area: Box | null): Pt[] {
  const v = path.length - 2; if (v <= 0) return path;
  const s1a = path[v - 1], s2b = path[v + 1];
  const ang = angleType(dir8(s1a, path[v]), dir8(path[v], s2b));
  if (ang !== ANG_RIGHT && ang !== ANG_ACUTE && ang !== ANG_HALF_FULL) return path;
  if (area && !inBox(area, path[v])) return path;
  let best: Pt[] | null = null, bestArea = Infinity;
  for (let posture = 0; posture < 2; posture++) {
    const bypass = initialTrace(s1a, s2b, -1, posture === 1); if (bypass.length < 2) continue;
    if (pathHits(O, bypass, r).length) continue;
    const loop = [s1a, path[v], s2b, ...bypass.slice().reverse()]; let a = 0;
    for (let i = 0; i < loop.length; i++) { const p = loop[i], q = loop[(i + 1) % loop.length]; a += p[0] * q[1] - q[0] * p[1]; }
    if (Math.abs(a / 2) < bestArea) { bestArea = Math.abs(a / 2); best = bypass; }
  }
  if (!best) return path;
  return simplifyPts(path.slice(0, v - 1).concat(best, path.slice(v + 2)));
}
/**
 * OPTIMIZER::Optimize with MERGE_SEGMENTS | MERGE_COLINEAR | REQUIRE_OBTUSE_ANGLES, PRESERVE_SEGMENTS and RESTRICT_AREA
 * (strict): dragFixCorners, mergeFull under the constraints, then mergeColinear.
 */
function optimizeLine(O: ObstacleIndex, pts: Pt[], r: number, keep: [Pt, Pt][], area: Box | null): Pt[] {
  let path = dragFixLastCorner(O, pts.map((p) => p.slice()), r, area);
  const check = (cur: Pt[], v1: number, v2: number, bypass: Pt[]) => {
    for (const k of keep) for (let i = v1; i < v2; i++) if (approxOverlaps(k, [cur[i], cur[i + 1]])) return false;   // PRESERVE_SEGMENTS_CONSTRAINT
    if (!area) return true;   // AREA_CONSTRAINT
    const p1 = cur[v1], p2 = cur[v2], in1 = inBox(area, p1), in2 = inBox(area, p2);
    if (in1 && in2) return true;
    const horiz = (a0: Pt, a1: Pt, b0: Pt, b1: Pt) => { const d1 = dir8(a0, a1), d2 = dir8(b0, b1); return d1 >= 0 && d1 === d2; };
    if (v1 < cur.length - 1 && !in1 && in2 && inBox(area, cur[v1 + 1])) return horiz(bypass[0], bypass[1], cur[v1], cur[v1 + 1]);
    if (in1 && !in2 && inBox(area, cur[v2 - 1])) return horiz(bypass[bypass.length - 2], bypass[bypass.length - 1], cur[v2 - 1], cur[v2]);
    return false;
  };
  path = mergeFull(O, path, r, { obtuse: true, check });
  return simplifyPts(path);   // mergeColinear
}

/**
 * TRACKS_SPREADER::Move: the root clipped from the anchor to the point nearest the cursor; the spread lines taken out;
 * each walked (forward, in walk order) round the clipped root and the lines before it at the spreading distance —
 * everything else only at touching distance — keeping which of its new segments still lie on the original; then each
 * (backward, in reverse order) walked again with the normal clearances, and optimized (reverse order) inside the area
 * the walks changed, grown by four root widths, the segments beside the clipped root kept.
 */
export function spreadMove(ctx: PcbCtx, p: Pt) {
  const st = SP; if (!st || st.picking || !st.root) return;
  const s = settingsOf(ctx), root = st.root, rootLen = ptsLength(root.pts);
  const la = nearestOnChain(root.pts, st.anchor!).len, ln = nearestOnChain(root.pts, p).len;
  const [l0, l1] = la <= ln ? [la, ln] : [ln, la];
  st.head = Math.abs(l1 - l0) > 1e-9 ? subChain(root.pts, l0, l1) : null;
  if (st.head && la > ln) st.head.reverse();   // from the anchor towards the cursor
  st.rootChunks = [l0 > 0 ? subChain(root.pts, 0, l0) : [], st.head || [], l1 < rootLen ? subChain(root.pts, l1, rootLen) : []].filter((c) => c.length > 1);
  const skip = new Set<string>(root.ids); for (const l of st.lines) for (const id of l.origin.ids) skip.add(id);
  const rest: Extra[] = [];   // what stays in the node: the root's pieces (the head processed and spreadable) and the lines' cut-off ends
  if (l0 > 0) rest.push({ pts: subChain(root.pts, 0, l0), w: root.width, net: root.netKey, processed: false });
  if (l1 < rootLen) rest.push({ pts: subChain(root.pts, l1, rootLen), w: root.width, net: root.netKey, processed: false });
  const head: Extra[] = st.head ? [{ pts: st.head, w: root.width, net: root.netKey, processed: true, spreadable: segs(st.head).map(() => true) }] : [];
  for (const l of st.lines) { if (l.pre.length > 1) rest.push({ pts: l.pre, w: l.origin.width, net: l.origin.netKey, processed: false }); if (l.post.length > 1) rest.push({ pts: l.post, w: l.origin.width, net: l.origin.netKey, processed: false }); }
  for (const l of st.lines) { l.forward = null; l.spreadable = []; l.backward = null; l.optimized = null; }
  const limit = Number(S.rs.walkaround_iteration_limit) || 40, dist = spreadDist();
  // the clearance override: 0 unless one of the two was processed; the spreading distance against a spreadable one
  // (a zero clearance still collides with overlapping copper: obstacleHit counts a gap under clearance - ROUTE_EPS, so
  // touching distance is held as twice the router epsilon)
  const touch = (c: number) => (c > 0 ? c : 2 * ROUTE_EPS);
  const override = (processed: boolean, spreadable: boolean, rr: number) => touch(!processed ? 0 : spreadable ? dist : rr);
  const forwardExtras: Extra[] = [];
  for (const l of st.lines) {
    const O = spreadObstacles(ctx, s, l, skip, [...rest, ...head, ...forwardExtras], override);
    const ret = walkaroundRoute(O, l.mid, l.origin.width / 2, limit);
    const pol = ret.status[0] === "done" ? 0 : ret.status[1] === "done" ? 1 : -1;
    if (pol < 0) break;
    const fw = ret.lines[pol]; l.forward = fw;
    // a walked segment that still lies over one of the line's own (more than 100 nm of common projection) is not spreadable
    l.spreadable = segs(fw).map((sg) => {
      for (const o of segs(l.mid)) {
        if ((peq(sg[0], o[0]) && peq(sg[1], o[1])) || approxOverlaps(o, sg)) { const c = projection(o, sg); if (!c) continue; return !(Math.hypot(c.pClip.B[0] - c.pClip.A[0], c.pClip.B[1] - c.pClip.A[1]) > OVERLAP_MAX); }
      }
      return true;
    });
    forwardExtras.push({ pts: fw, w: l.origin.width, net: l.origin.netKey, processed: true, spreadable: l.spreadable });
  }
  for (const l of st.lines) if (l.forward) l.forward = simplifyPts(l.forward);   // Simplify2
  // backward: normal clearances, in reverse order, against the lines already walked back
  let area: Box | null = null; const backExtras: Extra[] = [];
  const rootAll: Extra[] = [...rest, ...(st.head ? [{ pts: st.head, w: root.width, net: root.netKey, processed: false }] : [])];
  for (const l of st.lines.slice().reverse()) {
    if (!l.forward) break;
    const O = spreadObstacles(ctx, s, l, skip, [...rootAll, ...backExtras], null);
    const ret = walkaroundRoute(O, l.forward, l.origin.width / 2, limit);
    const pol = ret.status[0] === "done" ? 0 : ret.status[1] === "done" ? 1 : -1;
    if (pol < 0) break;
    const bw = ret.lines[pol];
    const a = changedArea(bw, l.mid, l.origin.width);
    if (a) area = area ? [Math.min(area[0], a[0]), Math.min(area[1], a[1]), Math.max(area[2], a[2]), Math.max(area[3], a[3])] : a;
    l.backward = simplifyPts(bw); backExtras.push({ pts: l.backward, w: l.origin.width, net: l.origin.netKey, processed: false });
  }
  if (area) { const d = 4 * root.width; area = [area[0] - d, area[1] - d, area[2] + d, area[3] + d]; }
  // stage 3: optimize, reverse order, each against the node with the others as they stand
  const cur = new Map<SpreadLine, Pt[]>(); for (const l of st.lines) if (l.backward) cur.set(l, l.backward);
  for (const l of st.lines.slice().reverse()) {
    const bw = cur.get(l); if (!bw) continue;
    const others: Extra[] = []; for (const [o, pts] of cur) if (o !== l) others.push({ pts, w: o.origin.width, net: o.origin.netKey, processed: false });
    const O = spreadObstacles(ctx, s, l, skip, [...rootAll, ...others], null);
    // findNoOptSegments: the forward segments with a common parallel projection on the clipped root
    const keep: [Pt, Pt][] = [];
    if (st.head && l.forward) for (const hs of segs(st.head)) for (const fs of segs(l.forward)) if (projection(hs, fs)) keep.push(fs);
    l.optimized = optimizeLine(O, bw, l.origin.width / 2, keep, area); cur.set(l, l.optimized);
  }
  st.done = true;
}
/** What a line becomes: its cut-off ends and the optimized spread part (nothing, where the walks failed). */
const finalChunks = (l: SpreadLine) => [l.pre, l.optimized || [], l.post].filter((c) => c.length > 1);

// ---------------------------------------------------------------- the tool
/** ROUTER_TOOL::SpreadTracks: the selected tracks (segments and arcs) are taken and the selection cleared. */
export function spreadActivate(ctx: PcbCtx) {
  bind(ctx); SP = null; const doc = ctx.doc; if (!doc) return;
  const items = Array.from(selectionIds(ctx)).map((id) => doc.items.get(id)).filter((it): it is KItem => !!it && (it.kind === "segment" || it.kind === "arc"));
  if (!items.length) { ctx.toast("Please select a group of tracks you want to spread."); ctx.setTool("select"); return; }   // ShowInfoBarError
  applySelection(ctx, []);
  SP = { items, picking: true, start: null, anchor: null, root: null, lines: [], head: null, rootChunks: [], hoverItem: null, done: false };
  if (ctx.setStatus) ctx.setStatus("Pick a track you want to spread other tracks around.");
  ctx.requestRender();
}
/** The tool left: a spread not committed is dropped and the selection comes back (restoreSelection on a cancel). */
export function spreadDeactivate(ctx: PcbCtx | null) {
  const st = SP; SP = null; if (!st || !ctx) return;
  if (!st.done || st.picking) applySelection(ctx, st.items.map((it) => it.id).filter((id) => ctx.doc && ctx.doc.items.has(id)));
}
/** Escape (IsCancelInteractive): the selection is restored and the tool ends. */
export function spreadCancel(ctx: PcbCtx) { const st = SP; if (!st) return false; st.done = false; spreadDeactivate(ctx); SP = null; ctx.setTool("select"); ctx.requestRender(); return true; }
/** updateStartItem: the track under the cursor (TOOL_BASE::pickSingleItem, segments and arcs). */
function startItemAt(ctx: PcbCtx, mm: Pt): KItem | null {
  const act = hitTestItem(ctx.doc, mm[0], mm[1], HIT_MM, (c) => (c.kind === "segment" || c.kind === "arc") && layerOf(c.node) === S.layer);
  if (act && (act.kind === "segment" || act.kind === "arc")) return act;
  const any = hitTestItem(ctx.doc, mm[0], mm[1], HIT_MM, (c) => c.kind === "segment" || c.kind === "arc");
  return any && (any.kind === "segment" || any.kind === "arc") ? any : null;
}
export function spreadPointerMove(ctx: PcbCtx, mm: Pt) {
  bind(ctx); const st = SP; if (!st) return;
  if (st.picking) { st.hoverItem = startItemAt(ctx, mm); ctx.requestRender(); return; }
  spreadMove(ctx, ctx.snapOn ? ctx.snap(mm.slice()) : mm); ctx.requestRender();
}
/** A click: the first picks the start item and point (StartRouting; TRACKS_SPREADER::Start needs a segment or arc), the next commits. */
export function spreadClick(ctx: PcbCtx, mm: Pt) {
  bind(ctx); const st = SP; if (!st) return;
  if (ctx.viewOnly) { ctx.toast("View-only access"); return; }
  if (!st.picking) {   // FixRoute: the node the last motion left, committed as the tool ends
    const ch = spreadChanges(ctx); SP = null;
    if (ch.length) ctx.commit(ch, "Routing");
    ctx.setTool("select"); ctx.requestRender(); return;
  }
  const it = startItemAt(ctx, mm); if (!it) return;
  st.picking = false;
  if (ctx.setStatus) ctx.setStatus("");
  if (it.kind !== "segment") { st.done = false; spreadDeactivate(ctx); SP = null; ctx.setTool("select"); return; }   // the router's line model has no arcs here: Start fails (m_cancelled)
  st.start = it; st.anchor = snapGrab(ctx, it, mm);
  prepareLines(ctx.doc, st);
  spreadMove(ctx, st.anchor); ctx.requestRender();
}
/**
 * ROUTER::CommitRouting( node ): the root and every spread line, each replaced by its pieces in the spread node — a
 * track whose geometry is unchanged stays, every other one goes and the new pieces come in carrying its attributes.
 */
export function spreadChanges(ctx: PcbCtx): PcbChange[] {
  const st = SP; if (!st || !st.root || !st.done) return [];
  const doc = ctx.doc, out: PcbChange[] = [];
  const replace = (l: TrackLine, chunks: Pt[][]) => {
    const olds = l.ids.map((id) => doc.items.get(id)).filter(Boolean) as KItem[]; const kept = new Set<string>(); const fresh: [Pt, Pt][] = [];
    for (const c of chunks) for (const [a, b] of segs(c)) {
      if (peq(a, b)) continue;
      const same = olds.find((o) => { if (kept.has(o.id)) return false; const [p, q] = trackEnds(o); return (peq(p, a) && peq(q, b)) || (peq(p, b) && peq(q, a)); });
      if (same) kept.add(same.id); else fresh.push([a, b]);
    }
    if (!fresh.length && kept.size === olds.length) return;
    for (const o of olds) if (!kept.has(o.id)) out.push(removedChange(o));
    const tmpl = olds[0];
    for (const [a, b] of fresh) {
      const n = clone(tmpl.node) as SNode; const u = K.kid(n, "uuid"); if (u) n.splice(n.indexOf(u), 1);
      K.kid(n, "start")!.splice(1, 2, r6(a[0]), r6(a[1])); K.kid(n, "end")!.splice(1, 2, r6(b[0]), r6(b[1]));
      out.push(addedChange(doc, n, l.net));
    }
  };
  replace(st.root, st.rootChunks);
  for (const l of st.lines) replace(l.origin, finalChunks(l));
  return out;
}
/** The ids the canvas leaves out while the spread is previewed (the root and the lines, drawn as they would become). */
export function spreadHiddenIds(): Set<string> | null {
  const st = SP; if (!st || st.picking || !st.root || !st.done) return null;
  const out = new Set<string>(st.root.ids); for (const l of st.lines) for (const id of l.origin.ids) out.add(id); return out;
}
/** The preview: the root and the spread lines as the node has them (ROUTER_PREVIEW_ITEM, the layer colour at 0.8). */
export function drawSpreadPreview(c: CanvasRenderingContext2D, colorOf: (layer: string, netKey: string) => string) {
  const st = SP; if (!st) return;
  if (st.picking || !st.root || !st.done) return;
  const draw = (pts: Pt[], w: number, layer: string, key: string) => { if (pts.length < 2) return; c.globalAlpha = 0.8; c.strokeStyle = colorOf(layer, key); c.lineWidth = w; c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); c.stroke(); };
  for (const ch of st.rootChunks) draw(ch, st.root.width, st.root.layer, st.root.netKey);
  for (const l of st.lines) for (const ch of finalChunks(l)) draw(ch, l.origin.width, l.origin.layer, l.origin.netKey);
  c.globalAlpha = 1;
}

// ---------------------------------------------------------------- the spreading distance
/** ROUTER_TOOL::onSpreadTracksSetDistance: WX_TEXT_ENTRY_DIALOG "Set Spreading Distance", an integer 0 … 10000000. */
export function spreadSetDistance(ctx: PcbCtx) {
  bind(ctx);
  openForm<{ d: string }>({ title: "Set Spreading Distance", width: 320, fields: [{ k: "d", label: "Distance:", type: "text", value: String(Math.round(Number(S.rs.spread_tracks_distance) || 0)) }],
    apply(v) {
      const t = String(v.d || "").trim();
      if (!/^\d*$/.test(t)) { errorMessage(ctx, "Please enter an integer value."); return false; }   // wxIntegerValidator
      const n = t ? parseInt(t, 10) : 0;   // wxAtoi
      if (n > 10000000) { errorMessage(ctx, "Please enter a value between 0 and 10000000."); return false; }
      setRouterSettings({ spread_tracks_distance: n });
      if (SP && !SP.picking && ctx.cursor) spreadMove(ctx, ctx.cursor.slice());
      ctx.requestRender(); return true;
    } });
  return true;
}
/** onSpreadTracksIncDecDistance: up to the next grid multiple and one more grid unit, or down likewise (never below 0). */
export function spreadStepDistance(ctx: PcbCtx, inc: boolean) {
  bind(ctx); const grid = Math.round((ctx.gridPitch || 0) * IU); if (grid <= 0) return true;
  let dist = Math.round(Number(S.rs.spread_tracks_distance) || 0); const rem = dist % grid;
  if (inc) dist += (grid - rem) + grid; else dist -= rem + grid;
  if (dist < 0) dist = 0;
  setRouterSettings({ spread_tracks_distance: dist });
  if (SP && !SP.picking && ctx.cursor) spreadMove(ctx, ctx.snapOn ? ctx.snap(ctx.cursor.slice()) : ctx.cursor.slice());
  ctx.requestRender(); return true;
}
