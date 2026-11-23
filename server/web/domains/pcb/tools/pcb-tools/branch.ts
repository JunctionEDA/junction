// pcb-tools/branch.ts — the route's branch: the router's NODE until CommitRouting, and the head it carries.
import type { BoardDoc, BranchCache, BranchOp, Obstacle, ObstacleIndex, PcbChange, PcbCtx, Pt, Route, ShoveResult, TrackLine } from "./types";
import { shapeOffset } from "./distances";
import { pointInPoly } from "./hit";
import { closestOnSeg } from "./point-editor";
import { removedChange, replacedChange, upsertChange } from "./changes";
import { copperOf, settingsOf } from "./dialogs";
import { dpUpdateHead } from "./diffpair";
import { peq, rp, segX } from "./dragger";
import { netClearance } from "./drc";
import { netOf } from "./nets";
import { cornerLeg, headElems } from "./posture";
import { jointAt, loopRemovals } from "./redundant";
import { boxNearest, firstHit, leadingRatline, polyNearest, trackOps } from "./route-fix";
import { CM_M45, CM_R45, RM_MARK, RM_SHOVE, RM_WALK, is90 } from "./router-settings";
import { shoveHead, solidObs } from "./shove";
import { fanoutCleanup, mergeFull } from "./optimize-selected";
import { ANG_ACUTE, ANG_HALF_FULL, ANG_RIGHT, ANG_UNDEFINED, angleType, runSmartPads } from "./smartpads";
import { K, S } from "./state";
import { initialDir, tracerPosture, trailAdd } from "./tracer";
import { dir8, hullOf, isDiagDir, pathClear, pathHits, rhWalkBase, routeObstacles, shapeCorePts, simplifyPts, splitHeadTail } from "./walkaround";
import { samePt } from "./util";

// ---------------------------------------------------------------- the route's branch: ROUTER's NODE until CommitRouting
// Everything fixed while one track is routed (its segments, vias, broken tracks and what Shove pushed aside) lives on a
// branch of the board — a document with its own item map — and goes to the board as ONE commit when the route ends.
// Escape drops the branch (LINE_PLACER::AbortPlacement), Backspace pops the last fixed stage (UnfixRoute).
export function branchDoc(doc: BoardDoc, ops?: BranchOp[] | null) {
  const b = Object.assign({}, doc, { items: new Map(doc.items), __bc: {} as BranchCache, __base: doc, __stale: 0 });
  ops = ops || [];
  // The branch is rebuilt on the live board, which collaborators edit while the route is open.  A { set } / { del }
  // carries the text of the item it was computed from (op.base); when that item is gone or has changed since, the edit
  // is stale and is left out — with the rest of its group (one shoved line, one split track) — so committing the route
  // never brings back an item someone deleted or overwrites their change with the copy the router saw
  // (CommitRouting writes the router's diff onto the live items; it never resurrects them).
  for (let i = 0; i < ops.length;) {
    let j = i + 1; const g = ops[i].grp; if (g) while (j < ops.length && ops[j].grp === g) j++;
    const chunk = ops.slice(i, j); i = j;
    if (chunk.every((op) => branchOpFresh(b, op))) for (const op of chunk) applyBranchOp(b, op); else b.__stale += chunk.length;
  }
  return b;
}
/** Whether a branch edit still applies: its target item is there and unchanged since the edit was computed. */
export function branchOpFresh(b: BoardDoc, op: BranchOp) {
  const id = op.set || op.del; if (!id || op.base == null) return true;
  const cur = b.items.get(id); return !!cur && K.serialize(cur.node) === op.base;
}
/** Stamp a { set } / { del } with the item it was computed from (see branchDoc). */
export function opOn(it: KItem, op: BranchOp, grp?: object) { op.base = K.serialize(it.node); if (grp) op.grp = grp; return op; }
/** One branch edit: { add: node } | { del: id } | { set: id, node } (the node keeps the item's uuid). */
export function applyBranchOp(b: BoardDoc, op: BranchOp) {
  if (op.del) { b.items.delete(op.del); return; }
  if (op.set) { b.items.delete(op.set); K.createItem(b, op.node!); return; }
  if (op.add) K.createItem(b, op.add);
}
/** The board changes that turn `doc` into the branch: added, modified and removed items. */
export function branchChanges(doc: BoardDoc, b: BoardDoc) {
  const out: PcbChange[] = [];
  for (const [id, it] of b.items) { const o = doc.items.get(id); if (!o) out.push(upsertChange(it, "ADDED", netOf(it.node))); else if (o.node !== it.node) out.push(replacedChange(o, it.node)); }
  for (const [id, o] of doc.items) if (!b.items.has(id)) out.push(removedChange(o));
  return out;
}
/** The route's working document: the board plus its fixed stages. */
export function routeDoc(ctx: PcbCtx, rt: Route): BoardDoc {
  if (!rt.stages.length) return ctx.doc;
  if (!rt.bdoc || rt.bdoc.__base !== ctx.doc || rt.bdocVer !== S.docVer) { rt.bdoc = branchDoc(ctx.doc, rt.stages.flatMap((s) => s.ops)); rt.bdocVer = S.docVer; }
  return rt.bdoc;
}
/** The tool context with the route's document in place of the board's (what the router's queries see). */
export function routeCtx(ctx: PcbCtx, rt: Route): PcbCtx { const d = routeDoc(ctx, rt); if (d === ctx.doc) return ctx; const rc = Object.create(ctx); rc.doc = d; return rc; }
/** A route without a net does not collide with itself: its start item. */
export function routeOwn(rt: Route) {
  const s = new Set<string>(rt.startIds || []); for (const st of rt.stages) { for (const id of st.startIds || []) s.add(id); for (const op of st.ops) if (op.add && op.add[0] !== "footprint") { const u = K.kid(op.add, "uuid"); if (u) s.add(K.str(u[1])); } }
  return s;
}
export function routeObs(ctx: PcbCtx, rt: Route, layer?: string) {
  layer = layer || rt.layer; const doc = routeDoc(ctx, rt); const key = S.docVer + "|" + layer + "|" + rt.width + "|" + rt.stages.length + "|" + rt.netKey;
  if (!rt.obs || rt.obs.key !== key || rt.obs.doc !== doc) { rt.obs = routeObstacles(doc, settingsOf(ctx), rt.netKey, layer, rt.netKey ? null : routeOwn(rt)); rt.obs.key = key; rt.obs.doc = doc; }
  return rt.obs;
}
/** ROUTING_SETTINGS' displayed clearance (ImportSizes): the routed net's class clearance, never below the board minimum. */
export function routeHaloClearance(ctx: PcbCtx, rt: Route) { const s = settingsOf(ctx); return Math.max(netClearance(s, rt.netKey), s.minClearance || 0); }
/** The via being carried at the head's end (ToggleViaPlacement): its sizes and the copper it spans. */
export function headVia(ctx: PcbCtx, rt: Route) {
  const pv = rt.placingVia; if (!pv) return null;
  const end = rt.head && rt.head.length ? rt.head[rt.head.length - 1] : rt.last;
  return { at: end.slice(), diameter: pv.diameter, drill: pv.drill, layers: pv.span, type: pv.type };
}
/** Every obstacle the carried via violates, on each copper layer it spans. */
export function viaHits(ctx: PcbCtx, rt: Route, via: { at: Pt; diameter: number; layers: string[] }) {
  const doc = routeDoc(ctx, rt), s = settingsOf(ctx), own = rt.netKey ? null : routeOwn(rt); const out: Obstacle[] = [];
  for (const L of viaSpanLayers(doc, via.layers)) for (const ob of pathHits(routeObstacles(doc, s, rt.netKey, L, own), [via.at], via.diameter / 2)) if (!out.includes(ob)) out.push(ob);
  return out;
}
/** SHAPE::Collide's minimum translation vector for a disc of radius R at c against `sh` (its core and rounding): null when apart. */
export function discMtv(sh: Obstacle["shape"], c: Pt, R: number): Pt | null {
  const off = shapeOffset(sh); const core = shapeCorePts(sh); const need = R + off;
  let q: Pt = core[0], bd = Infinity;
  const segs: Pt[][] = core.length === 1 ? [[core[0], core[0]]] : (sh.t === "seg" || sh.t === "path") ? core.slice(0, -1).map((p, i) => [p, core[i + 1]]) : core.map((p, i) => [p, core[(i + 1) % core.length]]);
  for (const [a, b] of segs) { const z = closestOnSeg(c, a, b); const d = Math.hypot(z[0] - c[0], z[1] - c[1]); if (d < bd) { bd = d; q = z; } }
  const inside = (sh.t === "rect" || sh.t === "poly") && core.length >= 3 && pointInPoly(core, c[0], c[1]);
  if (inside) { const d = bd; const n = d > 1e-12 ? [(q[0] - c[0]) / d, (q[1] - c[1]) / d] : [1, 0]; return [n[0] * (d + need), n[1] * (d + need)]; }
  if (bd >= need) return null;
  const n = bd > 1e-12 ? [(c[0] - q[0]) / bd, (c[1] - q[1]) / bd] : [1, 0];
  return [n[0] * (need - bd), n[1] * (need - bd)];
}
/**
 * VIA::PushoutForce( node, lead, force, collisionMask, iterLimit ): the via carried by the head is pushed out of the
 * first obstacle it collides with by the minimum translation (its copper at the obstacle's clearance, its hole at the
 * hole clearance, whichever is larger), each step at most a quarter of the diameter; after half the iterations a
 * step that is still too big goes along `lead` instead.  The total force, or null when it does not come free within
 * via_force_prop_iteration_limit iterations.  solidsOnly: Shove's mask (ITEM::SOLID_T), else everything (Walk around).
 */
export function viaPushout(ctx: PcbCtx, rt: Route, via: { at: Pt; diameter: number; drill?: number; layers: string[] }, lead: Pt, solidsOnly: boolean): Pt | null {
  const doc = routeDoc(ctx, rt), s = settingsOf(ctx), own = rt.netKey ? null : routeOwn(rt);
  const lists = viaSpanLayers(doc, via.layers).map((L) => routeObstacles(doc, s, rt.netKey, L, own));
  const movable = (ob: Obstacle) => ob.kind === "segment" || ob.kind === "arc" || ob.kind === "via" || ob.kind === "track";
  const rv = via.diameter / 2, rh = (via.drill || 0) / 2, limit = S.rs.via_force_prop_iteration_limit || 40, threshold = via.diameter / 4;
  const pos = via.at.slice(), total: Pt = [0, 0]; let iter = 0;
  for (; iter < limit; iter++) {
    let obs: Obstacle | null = null;
    for (const O of lists) { const h = pathHits(O, [pos], rv).find((ob) => !solidsOnly || !movable(ob)); if (h) { obs = h; break; } }
    if (!obs) break;
    let f = discMtv(obs.shape, pos, rv + obs.clr);
    if (rh > 0) { const hc = obs.kind === "hole" ? (s.minHoleToHole || 0) : (s.holeClearance || 0); const fh = discMtv(obs.shape, pos, rh + hc); if (fh && (!f || Math.hypot(fh[0], fh[1]) > Math.hypot(f[0], f[1]))) f = fh; }
    if (!f) return null;   // a collision but no translation: force propagation has failed
    const mag = Math.hypot(f[0], f[1]);
    if (iter > limit / 2 && mag > threshold) { const ll = Math.hypot(lead[0], lead[1]) || 1; f = [lead[0] / ll * threshold, lead[1] / ll * threshold]; }
    else if (mag > threshold) f = [f[0] / mag * threshold, f[1] / mag * threshold];
    total[0] += f[0]; total[1] += f[1]; pos[0] += f[0]; pos[1] += f[1];
  }
  if (iter === limit) return null;
  return total;
}
/** The copper layers between two layers of a via, inclusive, in stack order. */
export function viaSpanLayers(doc: BoardDoc, pair: string[]) {
  const cu = K.pcbSizes.copperStack(copperOf(doc)); const i = cu.indexOf(pair[0]), j = cu.indexOf(pair[pair.length - 1]);
  if (i < 0 || j < 0) return pair.slice(); return cu.slice(Math.min(i, j), Math.max(i, j) + 1);
}
/** LINE_PLACER's head and tail between pointer moves (m_head, m_tail, m_direction, m_p_start, m_last_p_end). */
export interface WalkPlacer { key: string; tail: Pt[]; head: Pt[]; dir: number; initDir: number; pStart: Pt; lastPEnd: Pt | null; /** m_currentStart */ start: Pt }
/** The placer of the route's current leg: a fix, an unfix or a layer change starts a new one (initPlacement). */
export function walkPlacer(rt: Route): WalkPlacer {
  const key = rt.last[0] + "," + rt.last[1] + "|" + rt.layer + "|" + rt.stages.length;
  if (!rt.walk || rt.walk.key !== key) {
    // m_initial_direction: InitialDirection() on Start, the last fixed segment's direction after a fix
    const initDir = rt.tracer && rt.tracer.lastSegDir >= 0 ? rt.tracer.lastSegDir : initialDir();
    rt.walk = { key, tail: [], head: [], dir: initDir, initDir, pStart: rt.last.slice(), lastPEnd: null, start: rt.last.slice() };
  }
  return rt.walk;
}
const segDir = (pts: Pt[], i: number) => dir8(pts[i], pts[i + 1]);
const lastDir = (pts: Pt[]) => dir8(pts[pts.length - 2], pts[pts.length - 1]);
/** LINE::CountCorners( ForbiddenAngles ) of mergeHead: acute, half-full and undefined corners. */
function forbiddenCorners(pts: Pt[]) { let n = 0; for (let i = 0; i + 2 < pts.length; i++) if (angleType(segDir(pts, i), segDir(pts, i + 1)) & (ANG_ACUTE | ANG_HALF_FULL | ANG_UNDEFINED)) n++; return n; }
/** SHAPE_LINE_CHAIN::Intersect of the tail with the head: { n: the tail segment of the crossing nearest the tail's start, p }. */
function tailHeadCrossing(tail: Pt[], head: Pt[]) {
  let n = Infinity, ip: Pt | null = null;
  for (let i = 0; i + 1 < tail.length; i++) for (let j = 0; j + 1 < head.length; j++) {
    const x = segX(tail[i], tail[i + 1], head[j], head[j + 1]); if (x && i < n) { n = i; ip = x; }
  }
  return ip ? { n, p: ip } : null;
}
/** LINE_PLACER::handleSelfIntersections: a head that crosses the tail cuts the tail back to before the crossing. */
function handleSelfIntersections(W: WalkPlacer) {
  const head = W.head, tail = W.tail;
  if (tail.length < 2 || head.length < 2) return false;
  if (peq(tail[0], head[0])) { W.dir = W.initDir; W.tail = []; return true; }
  const x = tailHeadCrossing(tail, head); if (!x) return false;
  if (peq(x.p, head[0]) || peq(x.p, tail[tail.length - 1])) return false;
  if (x.n < 2) { W.dir = W.initDir; W.tail = []; W.head = []; return true; }
  W.dir = segDir(tail, x.n - 1); W.tail = tail.slice(0, x.n + 1); return true;
}
/** LINE_PLACER::handlePullback: a head that leaves the tail at a right or acute angle takes the tail's last segment back. */
function handlePullback(W: WalkPlacer) {
  const head = W.head, tail = W.tail; if (head.length < 2) return false;
  const n = tail.length; if (n === 0) return false; if (n === 1) { W.tail = []; return true; }
  const angle = angleType(segDir(head, 0), lastDir(tail));
  if (angle === ANG_RIGHT || angle === ANG_ACUTE) {
    W.dir = lastDir(tail);
    W.tail = n < 2 ? [] : tail.slice(0, -1);
    if (W.tail.length < 2) W.dir = W.initDir;
    return true;
  }
  return false;
}
/** LINE_PLACER::reduceTail: the farthest-back tail segment from which a clear trace in its own direction reaches the cursor replaces the rest. */
function reduceTail(W: WalkPlacer, aEnd: Pt, clear: (pts: Pt[]) => boolean, legDir: (a: Pt, b: Pt, d: number) => Pt[]) {
  const head = W.head, tail = W.tail; const n = tail.length - 1;
  if (head.length < 2 || n < 2) return false;
  let reduceIndex = -1, newDir = -1;
  for (let i = n - 1; i >= 0; i--) {
    const d = segDir(tail, i); const rep = legDir(tail[i], aEnd, d); if (rep.length < 2) continue;
    if (!clear(tail.concat(rep.slice(1)))) break;
    if (dir8(rep[0], rep[1]) === d) { newDir = d; reduceIndex = i; }
  }
  if (reduceIndex >= 0) { W.dir = newDir; W.tail = tail.slice(0, reduceIndex + 2); W.head = []; return true; }
  if (W.tail.length < 2) W.dir = W.initDir;
  return false;
}
/** LINE_PLACER::mergeHead: a head of three or more segments without sharp corners joins the tail. */
function mergeHead(W: WalkPlacer) {
  const head = simplifyPts(W.head), tail = simplifyPts(W.tail); W.head = head; W.tail = tail;
  if (head.length - 1 < 3) return false;
  if (tail.length && !peq(head[0], tail[tail.length - 1])) return false;
  if (forbiddenCorners(head) !== 0) return false;
  if (tail.length >= 2 && (angleType(segDir(head, 0), lastDir(tail)) & (ANG_ACUTE | ANG_HALF_FULL | ANG_UNDEFINED))) return false;
  W.tail = simplifyPts(tail.concat(tail.length ? head.slice(1) : head)); W.dir = lastDir(W.tail); W.head = [];
  return true;
}
/** LINE_PLACER::Trace: the tail and the head as one line. */
export function placerTrace(W: WalkPlacer) { const l = W.tail.concat(W.tail.length && W.head.length && peq(W.tail[W.tail.length - 1], W.head[0]) ? W.head.slice(1) : W.head); return l.length > 2 ? simplifyPts(l) : l; }
/**
 * LINE_PLACER::optimizeTailHeadTransition: the whole trace tidied by FANOUT_CLEANUP (unless the posture was forced),
 * else the last three tail segments and the head's first two merged by MERGE_SEGMENTS.
 */
function optimizeTailHeadTransition(W: WalkPlacer, rc: PcbCtx, rt: Route, O: ObstacleIndex, forced: boolean) {
  const r = rt.width / 2;
  if (!forced) {
    const tr = placerTrace(W);
    const fo = tr.length >= 2 ? fanoutCleanup(rc.doc, O, { layer: rt.layer, netKey: rt.netKey, width: rt.width } as TrackLine, tr) : null;
    if (fo) { if (fo.length < 2) return false; W.head = fo; W.dir = segDir(fo, 0); W.tail = []; return true; }
  }
  const tail = W.tail, head = W.head;
  if (tail.length - 1 < 3) return false;
  const threshold = Math.min(tail.length, 3 + 1);
  const opt = simplifyPts(tail.slice(-threshold).concat(head.slice(1, Math.min(2, head.length - 1) + 1)));
  const merged = mergeFull(O, opt, r, { obtuse: false });
  if (merged.length !== opt.length || merged.some((p, i) => !peq(p, opt[i]))) {
    W.head = []; W.tail = simplifyPts(tail.slice(0, tail.length - threshold).concat(merged)); W.dir = lastDir(merged);
    return true;
  }
  return false;
}
/**
 * LINE_PLACER::routeStep: the tail reduced towards the cursor (follow mouse), the head routed from the tail's end
 * (routeHead), a head that crosses the tail or turns sharply back on it trimming the tail and routing again, and with
 * "follow mouse" the tail / head transition optimized or the head merged into the tail.
 */
function routeStep(W: WalkPlacer, aP: Pt, routeHead: (W: WalkPlacer) => { head: Pt[]; tail: Pt[] } | null, follow: boolean, reduce: (W: WalkPlacer) => void, transition: (W: WalkPlacer) => boolean) {
  let fail = false, goBack = false;
  for (let i = 0, nIter = 1; i < nIter && i < 64; i++) {
    const prevTail = W.tail.map((p) => p.slice()), prevHead = W.head.map((p) => p.slice());
    if (!goBack && follow) reduce(W);
    goBack = false;
    W.pStart = W.tail.length ? W.tail[W.tail.length - 1].slice() : W.start.slice();   // updatePStart
    const res = routeHead(W);
    if (!res) { W.tail = prevTail; W.head = prevHead; if (!W.tail.length) W.tail = [W.pStart.slice(), W.pStart.slice()]; fail = true; }
    W.pStart = W.tail.length ? W.tail[W.tail.length - 1].slice() : W.start.slice();
    if (fail) break;
    W.head = res!.head; W.tail = res!.tail;
    if (handleSelfIntersections(W)) { nIter++; goBack = true; }
    if (!goBack && handlePullback(W)) { nIter++; W.head = []; goBack = true; }
  }
  if (!fail && follow && !transition(W)) mergeHead(W);
  W.lastPEnd = aP.slice();
  return !fail;
}
/**
 * LINE_PLACER::Move → routeStep → routeHead: the posture from the mouse trail, then the head built for the router mode
 * from where the tail ends — Highlight collisions: straight to the cursor (snapped onto the first obstacle's hull when
 * the cursor is within half a track width of it), collisions marked; Shove: walked around the solids (rhWalkBase with
 * the tail), the tracks and vias in the way pushed aside (Walk around when the shove cannot be done); Walk around:
 * walked around every obstacle (rhWalkOnly).  The walked line is split back into tail and head (splitHeadTail) and
 * the tail is kept between moves.
 */
export function updateHead(ctx: PcbCtx) {
  const rt = S.route; if (!rt || !ctx.doc) return;
  if (rt.dp) { dpUpdateHead(ctx, S.hover); return; }
  const rs = S.rs, rc = routeCtx(ctx, rt), O = routeObs(ctx, rt); const r = rt.width / 2;
  trailAdd(rt.tracer, rt.cursor);
  // MOUSE_TRAIL_TRACER: the posture follows the mouse unless "Use mouse path to set track posture" is off (then the
  // posture switches every segment: m_lastSegDirection.Right(), or the initial direction on the first leg)
  if (rs.auto_posture || rt.tracer.manuallyForced) rt.diagFirst = isDiagDir(tracerPosture(rt.tracer, rt.cursor));
  else rt.diagFirst = rt.tracer.lastSegDir >= 0 ? !isDiagDir(rt.tracer.lastSegDir) : !!rs.start_diagonal;
  const cm = rs.corner_mode, free = rs.mode === RM_MARK && rs.free_angle_mode;
  rt.collisions = null; rt.shove = null; rt.viaBad = null;
  const via = headVia(ctx, rt);
  const W = walkPlacer(rt);
  const manuallyForced = !!rt.tracer.manuallyForced;
  // buildInitialLine: from where the tail ends, in the tail's direction (the mouse posture without a tail); with the
  // posture forced, a one-segment tail that the head carries straight on is dropped first.  In Walk around and Shove
  // the carried via is pushed out of what it collides with (all items / solids) and the head aims at p + force; the
  // second attempt leads from where the previous move ended.
  const cursor0 = rt.cursor.slice(); let pushed = false, aim = rt.cursor.slice();
  const viaAim = (p: Pt) => {
    if (!via || rs.mode === RM_MARK) return p;
    for (let attempt = 0; attempt < 2; attempt++) {
      const from = attempt === 1 && W.lastPEnd ? W.lastPEnd : W.pStart; if (attempt === 1 && !W.lastPEnd) break;
      const f = viaPushout(ctx, rt, Object.assign({}, via, { at: p }), [p[0] - from[0], p[1] - from[1]], rs.mode === RM_SHOVE);
      if (f) { pushed = true; return (aim = rp([p[0] + f[0], p[1] + f[1]])); }
    }
    return (aim = p);
  };
  const buildInitial = (p: Pt) => {
    if (manuallyForced && W.tail.length === 2 && W.head.length >= 2 && (segDir(W.tail, 0) === segDir(W.head, 0) || W.head.length === 2)) { W.pStart = W.tail[0].slice(); W.tail = []; }
    if (samePt(W.pStart, p)) return [W.pStart.slice()];
    return cornerLeg(W.pStart, p, W.tail.length ? isDiagDir(W.dir) : rt.diagFirst, cm, false);
  };
  const clearAll = (pts: Pt[]) => pathClear(O, pts, r);
  const smart = rs.smart_pads && (cm === CM_M45 || cm === CM_R45) && !manuallyForced;
  // OPTIMIZER::Optimize( head, effort ): MERGE_SEGMENTS unless the effort is low, SMART_PADS in the 45° modes
  const optimizeHead = (pts: Pt[], OB: ObstacleIndex) => {
    let out = (rs.effort as number) === 0 ? pts : mergeFull(OB, pts, r, { obtuse: false });
    if (smart && out.length >= 3) { const sp = runSmartPads(rc.doc, out, rt.width, rt.layer, rt.netKey, (q: Pt[]) => pathClear(OB, q, r)); if (sp) out = sp; }
    return out;
  };
  const walkBase = (OB: ObstacleIndex) => rhWalkBase(OB, { tail: () => W.tail, cursor: rt.cursor, r, cornerMode: cm, iterLimit: rs.walkaround_iteration_limit, hugThreshold: rs.walkaround_hug_length_threshold, placingVia: !!via,
    checkO: O, initial: (p) => buildInitial(viaAim(p)), optimize: (pts) => mergeFull(OB, pts, r, { obtuse: false }) });
  // rhWalkOnly: the walk of tail + head round everything, refused when it collides; split, the head optimized
  const rhWalkOnly = (): { head: Pt[]; tail: Pt[] } | null => {
    const full = walkBase(O); if (!full || !full.length || !clearAll(full)) return null;
    const sp = splitHeadTail(full, W.tail); return { head: optimizeHead(sp.head, O), tail: sp.tail };
  };
  let shoveRes: ShoveResult | null = null;
  const routeHead = (): { head: Pt[]; tail: Pt[] } | null => {
    if (rs.mode === RM_WALK) return rhWalkOnly();
    // rhShoveOnly: walked round the solids only, then shoved into the rest; Walk around when the shove fails
    shoveRes = null;
    const SOL = solidObs(rc, rt); const full = walkBase(SOL);
    if (!full || !full.length) return null;
    const sh = shoveHead(rc, rt, full);
    if (!sh) return rhWalkOnly();
    shoveRes = sh.shove; const sp = splitHeadTail(full, W.tail);
    return { head: optimizeHead(sp.head, sh.optO || SOL), tail: sp.tail };
  };
  if (rs.mode === RM_MARK) {
    const leg = (a: Pt, b: Pt) => cornerLeg(a, b, rt.diagFirst, cm, free);
    let pts = leg(rt.last, rt.cursor); let hits = pathHits(O, pts, r);
    if (hits.length) {   // snap to the hull of the first obstacle (rhMarkObstacles)
      const ob = firstHit(O, pts, r) || hits[0]; const H = hullOf(ob, r);
      const near = is90(cm) ? boxNearest(H, rt.cursor) : polyNearest(H, rt.cursor);
      if (Math.hypot(near[0] - rt.cursor[0], near[1] - rt.cursor[1]) < r) { pts = leg(rt.last, rp(near)); hits = pathHits(O, pts, r); }
    }
    rt.head = pts; rt.reached = true;
    if (via) { rt.head.length && (via.at = rt.head[rt.head.length - 1].slice()); for (const ob of viaHits(ctx, rt, via)) if (!hits.includes(ob)) hits.push(ob); }
    rt.collisions = hits.length ? hits : null;
  } else {
    const legDir = (a: Pt, b: Pt, d: number) => cornerLeg(a, b, isDiagDir(d), cm, false);
    routeStep(W, rt.cursor, () => routeHead(), !!rs.follow_mouse, (w) => { reduceTail(w, rt.cursor, clearAll, legDir); }, (w) => optimizeTailHeadTransition(w, rc, rt, O, manuallyForced));
    rt.head = placerTrace(W); if (!rt.head.length) rt.head = [rt.last.slice()];
    // LINE_PLACER::route: the cursor is reached when the line ends on it
    rt.reached = samePt(rt.head[rt.head.length - 1], aim);
    if (shoveRes) rt.shove = shoveRes;
  }
  rt.target = rt.head[rt.head.length - 1].slice();
  if (pushed) rt.cursor = cursor0;   // the mouse stays where it is; only the head and its via moved
  if (via && rs.mode === RM_WALK) { const vh = viaHits(ctx, rt, Object.assign({}, via, { at: rt.target })); rt.viaBad = vh.length ? vh : null; }
  rt.els = headElems(rt.head, cm, rs.mode === RM_MARK ? null : (p: Pt[]) => pathClear(O, p, r));
  rt.ratline = leadingRatline(rc, rt);
  rt.loopHidden = previewLoops(ctx, rt, rc);
}
/**
 * LINE_PLACER::Move: when the head reaches an item of its net, removeLoops runs on the head's node, so the tracks it
 * would erase vanish from the preview.  The ids the board render leaves out, or null.
 */
export function previewLoops(ctx: PcbCtx, rt: Route, rc: PcbCtx) {
  if (!S.rs.remove_loops || !rt.reached || !rt.netKey || !rt.els || !rt.els.length) return null;
  const doc = rc.doc; if (!jointAt(doc, rt.layer, rt.target, rt.netKey).count) return null;
  const b = branchDoc(doc, trackOps(doc, rt.els, rt.width, rt.layer, rt.net));
  const ids = loopRemovals(ctx.doc, b); return ids.size ? ids : null;
}
