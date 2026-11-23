import type { Mods, SchCtx, Pt } from "./types";
import { pinsAt } from "./connect";
import { K, S, atOf, kid, kids, num, ptsOf } from "./state";
import { r4 } from "./util";
import { cancelConstructionProposal, clearConstruction, constructionBatches, proposeConstructionItems, setConstructionChangeCallback, onArcSweep, type CBatch, type CDrawable } from "../pcb-tools/construction";

// ---------------------------------------------------------------- cursor snapping
export function mmPerPx(ctx: SchCtx) {
  if (ctx.worldMm && ctx.stage) { try { const a = ctx.worldMm({ clientX: 0, clientY: 0 }), b = ctx.worldMm({ clientX: 100, clientY: 0 }); const v = (b[0] - a[0]) / 100; if (v > 0 && isFinite(v)) return v; } catch (e) { /* no layout yet */ } }
  return ctx.pxPerMm ? 1 / ctx.pxPerMm : 0.25;
}
// Grid snap, but a pin or line end within reach wins (KiCad's connection snapping).  As in every SCH tool loop,
// Shift turns the magnetic snap to anchors off (grid.SetSnap( !MD_SHIFT )) and Ctrl the grid (DisableGridSnapping).
/** The modifier keys of the event behind a click or a move. */
export function snapConn(ctx: SchCtx, mm: Pt, kind: string, ev?: Mods | null): Pt {
  return resolveSnap(ctx, mm, kind, ev || null).p;
}
const SNAP_CONNECTABLE = new Set(["junction", "no_connect", "wire", "bus", "bus_entry", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
/**
 * GRID_HELPER::computeSnapRanges( true ): the snap range is 25 px clamped to the visible grid; an anchor is snapped
 * to within range - 5 px (m_SnapHysteresis) and held until range + 5 px.
 */
export function snapRanges(ctx: SchCtx): { range: number; in: number; out: number } {
  const px = mmPerPx(ctx), range = Math.min(25 * px, ctx.gridPitch || 1.27), h = 5 * px;
  return { range, in: Math.max(0, range - h), out: range + h };
}
/**
 * EE_GRID_HELPER::computeAnchors within reach of the cursor: every connection point of junctions, no-connects,
 * labels, bus entries, sheet pins and wire / bus ends, the pin positions, and for a horizontal or vertical line the
 * grid-aligned point on it.  The graphic-line tool (GRID_GRAPHICS) takes the non-connectable items instead: graphic
 * line ends (and their on-line point) and text box / table corners.
 */
export function snapAnchors(ctx: SchCtx, mm: Pt, kind: string, reach: number, skip?: Set<string> | null, ids?: (string | null)[]): Pt[] {
  const doc = ctx.doc, out: Pt[] = [], graphics = kind === "polyline";
  const near = (p: Pt) => Math.abs(p[0] - mm[0]) <= reach && Math.abs(p[1] - mm[1]) <= reach;
  let owner: string | null = null;   // the item each anchor belongs to (ANCHOR::items), for its construction geometry
  const add = (p: Pt) => { if (near(p)) { out.push([p[0], p[1]]); if (ids) ids.push(owner); } };
  const al = ctx.snap([mm[0], mm[1]]);
  const onLine = (a: Pt, b: Pt) => {   // the aligned point on a vertical / horizontal SCH_LINE
    if (Math.abs(a[0] - b[0]) <= 1e-6) { const y = al[1]; if (y >= Math.min(a[1], b[1]) - 1e-6 && y <= Math.max(a[1], b[1]) + 1e-6) add([a[0], y]); }
    else if (Math.abs(a[1] - b[1]) <= 1e-6) { const x = al[0]; if (x >= Math.min(a[0], b[0]) - 1e-6 && x <= Math.max(a[0], b[0]) + 1e-6) add([x, a[1]]); }
  };
  if (!graphics) for (const p of pinsAt(doc, mm[0], mm[1], reach)) { if (skip && skip.has(p.item.id)) continue; out.push([p.x, p.y]); if (ids) ids.push(p.item.id); }
  for (const it of doc.items.values()) {
    if (skip && skip.has(it.id)) continue; owner = it.id;
    const b = it.bbox; if (b && (mm[0] < b[0] - reach || mm[0] > b[2] + reach || mm[1] < b[1] - reach || mm[1] > b[3] + reach)) continue;
    if (graphics) {
      if (it.kind === "polyline") { const p = ptsOf(it.node); if (p.length === 2) { add(p[0]); add(p[1]); onLine(p[0], p[1]); } }
      else if ((it.kind === "text_box" || it.kind === "table") && b) { add([b[0], b[1]]); add([b[2], b[3]]); }
      continue;
    }
    if (it.kind === "sheet") { for (const pin of kids(it.node, "pin")) add(atOf(pin)); continue; }
    if (!SNAP_CONNECTABLE.has(it.kind)) continue;
    if (it.kind === "wire" || it.kind === "bus") { const p = ptsOf(it.node); if (p.length < 2) continue; add(p[0]); add(p[p.length - 1]); if (p.length === 2) onLine(p[0], p[1]); }
    else if (it.kind === "bus_entry") { const [x, y] = atOf(it.node), sz = kid(it.node, "size"); add([x, y]); add([x + (sz ? num(sz[1]) : 2.54), y + (sz ? num(sz[2]) : 2.54)]); }
    else add(atOf(it.node));
  }
  return out;
}
/**
 * The object anchor snapConn lands on for this cursor, or null when it does not land on one (EE_GRID_HELPER::
 * ResolveSnap's anchor presentation: m_snapItem and the snap indicator).
 */
export function snapAnchor(ctx: SchCtx, mm: Pt, kind: string): Pt | null {
  if (lastSnap && lastSnap.kind === kind && lastSnap.mm[0] === mm[0] && lastSnap.mm[1] === mm[1]) return lastSnap.anchor;   // drawn from the resolve the move made
  return resolveSnap(ctx, mm, kind, S.mods || null).anchor;
}
/** The anchor the last ResolveSnap presented (the snap indicator of a move, which resolves the grab point, not the cursor). */
export function lastSnapAnchor(): Pt | null { return lastSnap ? lastSnap.anchor : null; }
let lastSnap: { mm: Pt; kind: string; anchor: Pt | null } | null = null;

// ---------------------------------------------------------------- EE_GRID_HELPER::ResolveSnap (libs/snap)

/** SNAP_INFERENCE_SETTINGS of the schematic editor (Preferences > Schematic Editor > Snapping). */
export function schSnapInference(): { objectGeometry: boolean; constructionExtensions: boolean } {
  const v = (S as { snapInference?: { objectGeometry?: boolean; constructionExtensions?: boolean } }).snapInference || {};
  return { objectGeometry: v.objectGeometry !== false, constructionExtensions: v.constructionExtensions !== false };
}
/** A 2-point graphic line or a wire / bus: an SCH_LINE (a longer polyline is an SCH_SHAPE POLY). */
function lineSeg(it: KItem): [Pt, Pt] | null {
  if (it.kind !== "wire" && it.kind !== "bus" && it.kind !== "polyline") return null;
  const p = ptsOf(it.node); return p.length === 2 ? [p[0], p[1]] : null;
}
type SchGeom = { t: "seg"; a: Pt; b: Pt } | { t: "circle"; c: Pt; r: number } | { t: "arc"; c: Pt; r: number; a0: number; a1: number; anticlockwise: boolean } | { t: "box"; x0: number; y0: number; x1: number; y1: number } | { t: "line"; a: Pt; b: Pt } | { t: "half"; a: Pt; b: Pt };
function shapeGeom(it: KItem): SchGeom | null {
  const P = (k: string): Pt | null => { const n = kid(it.node, k); return n ? [num(n[1]), num(n[2])] : null; };
  if (it.kind === "circle") { const c = P("center"), e = P("end"); if (c && e) return { t: "circle", c, r: Math.hypot(e[0] - c[0], e[1] - c[1]) }; if (c) { const rr = kid(it.node, "radius"); if (rr) return { t: "circle", c, r: num(rr[1]) }; } return null; }
  if (it.kind === "arc") { const a = P("start"), m = P("mid"), e = P("end"); const g = a && m && e ? K.arcFrom3(a, m, e) as { x: number; y: number; r: number; a0: number; a1: number; anticlockwise: boolean } | null : null; return g ? { t: "arc", c: [g.x, g.y], r: g.r, a0: g.a0, a1: g.a1, anticlockwise: g.anticlockwise } : null; }
  if (it.kind === "rectangle") { const a = P("start"), e = P("end"); return a && e ? { t: "box", x0: Math.min(a[0], e[0]), y0: Math.min(a[1], e[1]), x1: Math.max(a[0], e[0]), y1: Math.max(a[1], e[1]) } : null; }
  return null;
}
/** getSchematicIntersectable: an SCH_LINE's segment, or an SCH_SHAPE's circle, arc or rectangle. */
export function schIntersectable(it: KItem): SchGeom | null { const sg = lineSeg(it); return sg ? { t: "seg", a: sg[0], b: sg[1] } : shapeGeom(it); }
/**
 * EE_GRID_HELPER::AddConstructionItems for one item: a line's two rays out from its ends (or with aExtensionOnly off,
 * the whole line), its ends as points when persistent; an arc's circle and centre; a circle's centre.
 */
export function schConstruction(it: KItem, extensionOnly: boolean, persistent: boolean): CDrawable[] {
  const out: CDrawable[] = [], sg = lineSeg(it), g = sg ? null : shapeGeom(it);
  if (sg) {
    const [a, b] = sg, v: Pt = [b[0] - a[0], b[1] - a[1]];
    if (extensionOnly) out.push({ t: "half", a, b: [a[0] - v[0], a[1] - v[1]] }, { t: "half", a: b, b: [b[0] + v[0], b[1] + v[1]] });
    else out.push({ t: "line", a, b });
    if (persistent) out.push({ t: "pt", p: a }, { t: "pt", p: b });
  } else if (g && g.t === "arc") out.push({ t: "circle", c: g.c, r: g.r }, { t: "pt", p: g.c });
  else if (g && g.t === "circle") out.push({ t: "pt", p: g.c });
  return out;
}
function proposeSch(items: KItem[], persistent: boolean) {
  const batch: CBatch = items.map((it) => ({ source: "items" as const, item: it.id, drawables: schConstruction(it, true, persistent).map((d) => ({ d, w: 1 })) }));
  proposeConstructionItems(batch, persistent);
}
const nearestOnSeg = (p: Pt, a: Pt, b: Pt, clamp: "seg" | "half" | "line"): Pt => {
  const d = [b[0] - a[0], b[1] - a[1]], L = d[0] * d[0] + d[1] * d[1]; if (!L) return [a[0], a[1]];
  let t = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / L;
  if (clamp === "seg") t = Math.max(0, Math.min(1, t)); else if (clamp === "half") t = Math.max(0, t);
  return [a[0] + t * d[0], a[1] + t * d[1]];
};
/** The nearest point of a geometry (NearestPoint / GetNearestPoint). */
function nearestOn(g: SchGeom, p: Pt): Pt {
  if (g.t === "seg" || g.t === "line" || g.t === "half") return nearestOnSeg(p, g.a, g.b, g.t);
  if (g.t === "circle" || g.t === "arc") {
    const d = Math.hypot(p[0] - g.c[0], p[1] - g.c[1]), q: Pt = d ? [g.c[0] + (p[0] - g.c[0]) * g.r / d, g.c[1] + (p[1] - g.c[1]) * g.r / d] : [g.c[0] + g.r, g.c[1]];
    if (g.t === "circle" || onArcSweep(g, Math.atan2(q[1] - g.c[1], q[0] - g.c[0]))) return q;
    const e0: Pt = [g.c[0] + g.r * Math.cos(g.a0), g.c[1] + g.r * Math.sin(g.a0)], e1: Pt = [g.c[0] + g.r * Math.cos(g.a1), g.c[1] + g.r * Math.sin(g.a1)];
    return Math.hypot(p[0] - e0[0], p[1] - e0[1]) <= Math.hypot(p[0] - e1[0], p[1] - e1[1]) ? e0 : e1;
  }
  const C: Pt[] = [[g.x0, g.y0], [g.x1, g.y0], [g.x1, g.y1], [g.x0, g.y1]]; let best: Pt = C[0], bd = Infinity;
  for (let i = 0; i < 4; i++) { const q = nearestOnSeg(p, C[i], C[(i + 1) % 4], "seg"), d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = q; } }
  return best;
}
const gdist = (g: SchGeom, p: Pt) => { const q = nearestOn(g, p); return Math.hypot(q[0] - p[0], q[1] - p[1]); };
const linear = (g: SchGeom) => g.t === "seg" || g.t === "line" || g.t === "half";
/** INTERSECTION_VISITOR for the shapes the schematic offers (a box is its four sides). */
function intersections(a: SchGeom, b: SchGeom): Pt[] {
  const out: Pt[] = [];
  const sides = (g: SchGeom): SchGeom[] => g.t === "box" ? [[g.x0, g.y0, g.x1, g.y0], [g.x1, g.y0, g.x1, g.y1], [g.x1, g.y1, g.x0, g.y1], [g.x0, g.y1, g.x0, g.y0]].map((v) => ({ t: "seg", a: [v[0], v[1]], b: [v[2], v[3]] }) as SchGeom) : [g];
  if (a.t === "box" || b.t === "box") { for (const x of sides(a)) for (const y of sides(b)) out.push(...intersections(x, y)); return out; }
  const tOk = (g: SchGeom, t: number) => g.t === "line" || (t >= -1e-9 && (g.t === "half" || t <= 1 + 1e-9));
  const onCurve = (g: SchGeom, q: Pt) => g.t !== "arc" || onArcSweep(g, Math.atan2(q[1] - g.c[1], q[0] - g.c[0]));
  if (linear(a) && linear(b)) {
    const A = a as { a: Pt; b: Pt }, B = b as { a: Pt; b: Pt };
    const r = [A.b[0] - A.a[0], A.b[1] - A.a[1]], q = [B.b[0] - B.a[0], B.b[1] - B.a[1]], den = r[0] * q[1] - r[1] * q[0];
    if (Math.abs(den) < 1e-15) return out;
    const t = ((B.a[0] - A.a[0]) * q[1] - (B.a[1] - A.a[1]) * q[0]) / den, u = ((B.a[0] - A.a[0]) * r[1] - (B.a[1] - A.a[1]) * r[0]) / den;
    if (tOk(a, t) && tOk(b, u)) out.push([A.a[0] + t * r[0], A.a[1] + t * r[1]]);
    return out;
  }
  if (linear(a) && !linear(b)) {
    const A = a as { a: Pt; b: Pt }, C = b as { c: Pt; r: number }, d = [A.b[0] - A.a[0], A.b[1] - A.a[1]], fx = A.a[0] - C.c[0], fy = A.a[1] - C.c[1];
    const qa = d[0] * d[0] + d[1] * d[1], qb = 2 * (fx * d[0] + fy * d[1]), qc = fx * fx + fy * fy - C.r * C.r, disc = qb * qb - 4 * qa * qc;
    if (qa < 1e-18 || disc < 0) return out;
    for (const sg of [-1, 1]) { const t = (-qb + sg * Math.sqrt(disc)) / (2 * qa); if (!tOk(a, t)) continue; const q: Pt = [A.a[0] + t * d[0], A.a[1] + t * d[1]]; if (onCurve(b, q)) out.push(q); }
    return out;
  }
  if (!linear(a) && linear(b)) return intersections(b, a);
  const P = a as { c: Pt; r: number }, Q = b as { c: Pt; r: number };
  const dx = Q.c[0] - P.c[0], dy = Q.c[1] - P.c[1], d = Math.hypot(dx, dy);
  if (d < 1e-12 || d > P.r + Q.r || d < Math.abs(P.r - Q.r)) return out;
  const k = (P.r * P.r - Q.r * Q.r + d * d) / (2 * d), h = Math.sqrt(Math.max(0, P.r * P.r - k * k)), mx = P.c[0] + k * dx / d, my = P.c[1] + k * dy / d;
  for (const sg of [-1, 1]) { const q: Pt = [mx + sg * h * dy / d, my - sg * h * dx / d]; if (onCurve(a, q) && onCurve(b, q)) out.push(q); }
  return out;
}
/** SNAP_PRIORITY_TIER and SNAP_CANDIDATE_SUBTYPE's subtypeRank. */
const TIER_OBJECT = 2, TIER_GRID = 3;
const RANK: Record<string, number> = { intrinsic: 0, constructed: 1, intersection: 1, finite: 4, extension: 5, grid: 0 };
/** SNAP_CANDIDATE: a point (COINCIDENCE, 2 DOF), a point on a curve (1 DOF, nonlinear), a line (POINT_ON_LINE, 1 DOF) or a grid axis. */
interface Cand { id: string; tier: number; sub: string; rel: "pt" | "line" | "gx" | "gy" | "curve"; o: Pt; dir?: Pt; finite?: boolean; manifold?: SchGeom; dof: number; res: number; anchor?: { p: Pt; id: string | null; constructed: boolean; propose: boolean } }
/** The solve() of snap_resolver.cpp: the position the accepted candidates fix, or null when they cannot all hold. */
function solve(src: Pt, cs: Cand[]): { p: Pt; dof: number } | null {
  type Eq = { a: number; b: number; c: number; exact: boolean };
  const eqs: Eq[] = [], nonlinear: SchGeom[] = [];
  for (const c of cs) {
    if (c.rel === "pt") eqs.push({ a: 1, b: 0, c: c.o[0], exact: true }, { a: 0, b: 1, c: c.o[1], exact: true });
    else if (c.rel === "gx") eqs.push({ a: 1, b: 0, c: c.o[0], exact: true });
    else if (c.rel === "gy") eqs.push({ a: 0, b: 1, c: c.o[1], exact: true });
    else if (c.rel === "line") { const a = -c.dir![1], b = c.dir![0]; eqs.push({ a, b, c: a * c.o[0] + b * c.o[1], exact: false }); }
    if (c.manifold && (c.manifold.t === "circle" || c.manifold.t === "arc")) nonlinear.push(c.manifold);
  }
  let first: Eq | null = null, second: Eq | null = null;
  for (const e of eqs) {
    if (Math.hypot(e.a, e.b) <= 1e-12) return null;
    if (!first) { first = e; continue; }
    if (Math.abs(first.a * e.b - e.a * first.b) > 1e-12) { second = e; break; }
  }
  let x = src[0], y = src[1], dof = 2;
  if (first && second) { const det = first.a * second.b - second.a * first.b; x = (first.c * second.b - second.c * first.b) / det; y = (first.a * second.c - second.a * first.c) / det; dof = 0; }
  else if (first) { const dv = first.a * first.a + first.b * first.b, dl = (first.c - first.a * x - first.b * y) / dv; x += dl * first.a; y += dl * first.b; dof = 1; }
  if (!second && nonlinear.length) {
    let pts: Pt[] = [];
    if (first) { const o: Pt = Math.abs(first.a) > Math.abs(first.b) ? [first.c / first.a, 0] : [0, first.c / first.b]; pts = intersections({ t: "line", a: o, b: [o[0] + first.b, o[1] - first.a] }, nonlinear[0]); }
    else if (nonlinear.length >= 2) pts = intersections(nonlinear[0], nonlinear[1]);
    else pts = [nearestOn(nonlinear[0], src)];
    if (!pts.length) return null;
    pts.sort((p, q) => Math.hypot(p[0] - src[0], p[1] - src[1]) - Math.hypot(q[0] - src[0], q[1] - src[1]));
    x = pts[0][0]; y = pts[0][1]; dof = first || nonlinear.length >= 2 ? 0 : 1;
  }
  if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 2e6 || Math.abs(y) > 2e6) return null;
  const p: Pt = [r4(x), r4(y)];   // KiROUND to the schematic's 100 nm units
  for (const e of eqs) {
    const res = Math.abs(e.a * p[0] + e.b * p[1] - e.c) / Math.hypot(e.a, e.b);
    if (e.exact ? res > 1e-7 : res > 2e-4) return null;   // LINE_TOLERANCE_IU: 2 IU
  }
  for (const c of cs) {
    if (c.manifold && gdist(c.manifold, p) > 2e-4) return null;
    if (!c.finite || !c.dir) continue;
    const L = c.dir[0] * c.dir[0] + c.dir[1] * c.dir[1]; if (L <= 1e-24) return null;
    const t = ((p[0] - c.o[0]) * c.dir[0] + (p[1] - c.o[1]) * c.dir[1]) / L; if (t < 0 || t > 1) return null;
  }
  return { p, dof };
}
/** SNAP_RESOLVER::Resolve: the candidates ranked, the nearest intrinsic anchor first, then the retained one, then the rest in rank order. */
function resolveCandidates(src: Pt, cands: Cand[], sticky: Set<string>, retainedId: string | null, hysteresis: number): { p: Pt; accepted: Cand[] } {
  const ranked = cands.map((c) => ({ c, rank: RANK[c.sub] ?? 0, hys: sticky.has(c.id), eff: Math.max(0, c.res - (sticky.has(c.id) ? hysteresis : 0)) }));
  ranked.sort((A, B) => (A.c.tier - B.c.tier) || (A.rank - B.rank) || (B.c.dof - A.c.dof) || (A.eff - B.eff) || (Number(!A.hys) - Number(!B.hys)) || (A.c.id < B.c.id ? -1 : A.c.id > B.c.id ? 1 : 0));
  const accepted: Cand[] = [], done = ranked.map(() => false); let pos: Pt = [src[0], src[1]], dof = 2;
  const accept = (i: number) => { const r = solve(src, accepted.concat([ranked[i].c])); if (r) { accepted.push(ranked[i].c); pos = r.p; dof = r.dof; } done[i] = true; };
  for (let i = 0; i < ranked.length && dof > 0; i++) if (!done[i] && ranked[i].c.sub === "intrinsic") { accept(i); break; }
  if (retainedId) for (let i = 0; i < ranked.length && dof > 0; i++) if (!done[i] && ranked[i].c.id === retainedId) { accept(i); break; }
  for (let i = 0; i < ranked.length && dof > 0; i++) if (!done[i]) accept(i);
  return { p: pos, accepted };
}
/** The items near the cursor (queryVisible over the snap range box), less the ones moving. */
function queryVisible(ctx: SchCtx, mm: Pt, range: number, skip: Set<string> | null): KItem[] {
  const out: KItem[] = [], h = range / 2;
  for (const it of ctx.doc.items.values()) {
    if (skip && skip.has(it.id)) continue; const b = it.bbox;
    if (b && (mm[0] + h < b[0] || mm[0] - h > b[2] || mm[1] + h < b[1] || mm[1] - h > b[3])) continue;
    out.push(it);
  }
  return out;
}
let schSticky = new Set<string>();
/**
 * EE_GRID_HELPER::ResolveSnap: the cursor resolved against the anchors near it (the one held, m_snapItem, while
 * within the snap-out range; a new one within the snap-in range), the object geometry of the items near it (points on
 * lines and shapes, where two of them cross), the construction geometry (rays out from a hovered or snapped line,
 * an arc's circle and centre, accepted after 500 ms) and the grid, through SNAP_RESOLVER's ranking: an intrinsic
 * anchor, then constructed points and intersections, then points on objects (one grid axis then fixing the rest),
 * then the grid.  Shift turns the object snapping off, Ctrl the grid.  `kind` picks the grid class (a graphic
 * line's GRID_GRAPHICS takes non-connectable anchors only); `skip` holds the items that move.
 */
export function resolveSnap(ctx: SchCtx, mm: Pt, kind: string, ev: Mods | null, skip?: Set<string> | null): { p: Pt; anchor: Pt | null } {
  const useGrid = !(ev && (ev.ctrlKey || ev.metaKey)) && ctx.snapOn !== false, enableSnap = !(ev && ev.shiftKey);
  const px = mmPerPx(ctx), r = snapRanges(ctx), scale = 25 * px, range = useGrid ? r.range : scale;
  const snapIn = Math.max(0, range - 5 * px), snapOut = range + 5 * px;
  const inf = schSnapInference(), consOn = enableSnap && inf.constructionExtensions;
  if (!consOn) clearConstruction();
  setConstructionChangeCallback(() => { if (ctx.requestRender) ctx.requestRender(); });
  const grid = useGrid ? ctx.snap([mm[0], mm[1]]).map(r4) as Pt : [mm[0], mm[1]] as Pt;
  const retained = S.snapItem as (Pt & { owner?: string | null; constructed?: boolean }) | null | undefined;
  const visible = queryVisible(ctx, mm, range, skip || null);
  const cands: Cand[] = [];
  const aid = (p: Pt) => "anchor:" + r4(p[0]) + "," + r4(p[1]);
  // computeAnchors over the visible items, and (computeAnchors over GetConstructionItems) the construction points
  const ids: (string | null)[] = [];
  const anchors = enableSnap ? snapAnchors(ctx, mm, kind, Math.max(snapOut, range), skip, ids) : [];
  const all = anchors.map((p, i) => ({ p, id: ids[i] ?? null, constructed: false }));
  if (consOn) for (const bt of constructionBatches()) for (const ci of bt) for (const e of ci.drawables) if (e.d.t === "pt") all.push({ p: [e.d.p[0], e.d.p[1]], id: ci.item, constructed: true });
  let nearest: { p: Pt; id: string | null; constructed: boolean } | null = null, nd = Infinity;
  for (const a of all) { const d = Math.hypot(a.p[0] - mm[0], a.p[1] - mm[1]); if (d < nd) { nd = d; nearest = a; } }
  // object geometry: SNAP_INFERENCE_PROVIDER::CollectObjectGeometry over the items' paths and the construction paths
  if (enableSnap && (inf.objectGeometry || consOn)) {
    const paths: { id: string; g: SchGeom; ext: boolean; d: number }[] = [];
    if (inf.objectGeometry) for (const it of visible) { const g = schIntersectable(it); if (g) paths.push({ id: "path:" + it.id, g, ext: false, d: gdist(g, mm) }); }
    let ci = 0;
    if (consOn) for (const bt of constructionBatches()) for (const c of bt) for (const e of c.drawables) {
      const d = e.d, id = "cons:" + (c.item || "") + ":" + ci++;
      const g: SchGeom | null = d.t === "line" || d.t === "half" || d.t === "seg" ? { t: d.t, a: d.a, b: d.b } : d.t === "circle" ? { t: "circle", c: d.c, r: d.r } : d.t === "arc" ? { t: "arc", c: d.c, r: d.r, a0: d.a0, a1: d.a1, anticlockwise: d.anticlockwise } : null;
      if (g) paths.push({ id, g, ext: true, d: gdist(g, mm) });
    }
    const eligible = paths.filter((q) => q.d <= range).sort((a, b) => (a.d - b.d) || (a.id < b.id ? -1 : 1)).slice(0, 64);
    for (const q of eligible) {
      const g = q.g, sub = q.ext ? "extension" : "finite", res = q.d / Math.max(1e-9, range);
      if (g.t === "seg" || g.t === "line" || g.t === "half") cands.push({ id: q.id, tier: TIER_OBJECT, sub: g.t === "seg" && !q.ext ? "finite" : "extension", rel: "line", o: g.a, dir: [g.b[0] - g.a[0], g.b[1] - g.a[1]], finite: g.t === "seg" && !q.ext, manifold: g.t === "half" ? g : undefined, dof: 1, res });
      else if (g.t === "circle" || g.t === "arc") cands.push({ id: q.id, tier: TIER_OBJECT, sub, rel: "curve", o: nearestOn(g, mm), manifold: g, dof: 1, res });
      else cands.push({ id: q.id, tier: TIER_OBJECT, sub, rel: "pt", o: nearestOn(g, mm).map(r4) as Pt, manifold: g, dof: 2, res });
    }
    const X = eligible.slice(0, 12);
    for (let i = 0; i < X.length; i++) for (let j = i + 1; j < X.length; j++) {
      const a = X[i].g, b = X[j].g;
      if (linear(a) && linear(b)) { const A = a as { a: Pt; b: Pt }, B = b as { a: Pt; b: Pt }; if (Math.abs((A.b[0] - A.a[0]) * (B.b[1] - B.a[1]) - (A.b[1] - A.a[1]) * (B.b[0] - B.a[0])) < 1e-15) continue; }
      const pts = intersections(a, b).map((q) => [r4(q[0]), r4(q[1])] as Pt).filter((q, k, arr) => arr.findIndex((w) => w[0] === q[0] && w[1] === q[1]) === k);
      pts.forEach((q, k) => { const d = Math.hypot(q[0] - mm[0], q[1] - mm[1]); if (d <= range) cands.push({ id: "x:" + X[i].id + "|" + X[j].id + "|" + k, tier: TIER_OBJECT, sub: "intersection", rel: "pt", o: q, dof: 2, res: d / Math.max(1e-9, range) }); });
    }
  }
  // the anchor held from the last call, and the nearest new one within the snap-in range
  let retainedId: string | null = null;
  if (enableSnap && retained && Math.hypot(retained[0] - mm[0], retained[1] - mm[1]) <= snapOut && !(retained.owner && skip && skip.has(retained.owner))) {
    retainedId = aid(retained);
    cands.push({ id: retainedId, tier: TIER_OBJECT, sub: retained.constructed ? "constructed" : "intrinsic", rel: "pt", o: [retained[0], retained[1]], dof: 2, res: Math.hypot(retained[0] - mm[0], retained[1] - mm[1]) / scale, anchor: { p: [retained[0], retained[1]], id: retained.owner ?? null, constructed: !!retained.constructed, propose: false } });
  }
  if (enableSnap && nearest && nd <= snapIn) {
    const id = aid(nearest.p), c: Cand = { id, tier: TIER_OBJECT, sub: nearest.constructed ? "constructed" : "intrinsic", rel: "pt", o: [nearest.p[0], nearest.p[1]], dof: 2, res: nd / scale, anchor: { p: nearest.p, id: nearest.id, constructed: nearest.constructed, propose: true } };
    const at = cands.findIndex((x) => x.id === id); if (at >= 0) cands[at] = c; else cands.push(c);
  }
  if (useGrid) cands.push({ id: "grid:x", tier: TIER_GRID, sub: "grid", rel: "gx", o: grid, dof: 1, res: Math.abs(grid[0] - mm[0]) / scale }, { id: "grid:y", tier: TIER_GRID, sub: "grid", rel: "gy", o: grid, dof: 1, res: Math.abs(grid[1] - mm[1]) / scale });
  const out = resolveCandidates(mm, cands, schSticky, retainedId, 5 / 25);
  schSticky = new Set(out.accepted.map((c) => c.id));
  // the presentation: the first accepted candidate that is an anchor shows the snap indicator and is held
  const shown = out.accepted.find((c) => c.anchor);
  let keep = false, anchor: Pt | null = null;
  if (shown && shown.anchor) {
    const a = shown.anchor, held = [r4(a.p[0]), r4(a.p[1])] as Pt & { owner?: string | null; constructed?: boolean };
    held.owner = a.id; held.constructed = a.constructed; S.snapItem = held; anchor = [held[0], held[1]];
    if (a.propose && consOn && a.id && !a.constructed) { const it = ctx.doc.items.get(a.id); if (it) { proposeSch([it], false); keep = true; } }
  } else S.snapItem = null;
  // ExtensionSnapActivateOnHover: the first item under the cursor proposes its construction geometry
  if (consOn && !keep) for (const it of visible) { const g = schIntersectable(it); if (g && gdist(g, mm) <= Math.max(1e-9, itemHalfWidth(it))) { proposeSch([it], false); keep = true; break; } }
  if (!keep) cancelConstructionProposal();
  const p: Pt = [r4(out.p[0]), r4(out.p[1])];
  lastSnap = { mm: [mm[0], mm[1]], kind, anchor };
  return { p, anchor };
}
/** SCH_ITEM::HitTest( aPosition, 0 ): within half the line's width (the default 6 mil when it has none). */
function itemHalfWidth(it: KItem): number {
  const st = kid(it.node, "stroke"), w = st ? kid(st, "width") : null, v = w ? num(w[1]) : 0;
  return (v > 0 ? v : it.kind === "bus" ? 0.3048 : 0.1524) / 2;
}
/** SCH_ITEM::IsConnectable: the kinds that take part in the connectivity. */
const CONNECTABLE = new Set(["symbol", "sheet", "no_connect", "label", "global_label", "hierarchical_label", "directive_label", "netclass_flag", "junction", "wire", "bus", "bus_entry"]);
/** EE_GRID_HELPER's grid class of a selection: connectable when any moved item is, else graphics (the anchors it may take). */
export function selectionSnapKind(items: KItem[]): string {
  return items.some((it) => CONNECTABLE.has(it.kind)) ? "wire" : "polyline";
}
/**
 * EE_GRID_HELPER::BestDragOrigin: the grab point of a move is the moved items' anchor nearest the mouse - an origin
 * (a symbol's or sheet's position, a pin; a text's when nothing connectable moves) or a corner (a connection point;
 * a text box or table corner when nothing connectable moves) - filtered by the selection's grid class; the mouse
 * itself when the items have none.
 */
export function bestDragOrigin(ctx: SchCtx, items: KItem[], mouse: Pt): Pt {
  const doc = ctx.doc, conn = selectionSnapKind(items) === "wire";
  const pts: { p: Pt; connectable: boolean }[] = [];
  const add = (p: Pt, it: KItem) => pts.push({ p: [p[0], p[1]], connectable: CONNECTABLE.has(it.kind) });
  for (const it of items) {
    const k = it.kind;
    if (k === "text" || k === "field") { if (!conn) add(atOf(it.node), it); continue; }
    if (k === "table" || k === "text_box") { if (!conn && it.bbox) { add([it.bbox[0], it.bbox[1]], it); add([it.bbox[2], it.bbox[3]], it); } continue; }
    if (k === "symbol" || k === "sheet") add(atOf(it.node), it);
    if (k === "polyline" && !conn) { const p = ptsOf(it.node); if (p.length === 2) { add(p[0], it); add(p[1], it); } continue; }
    if (k === "symbol") { for (const q of K.pinPoints(doc, it)) add([q.x, q.y], it); continue; }
    if (k === "sheet") { for (const pin of kids(it.node, "pin")) add(atOf(pin), it); continue; }
    if (k === "wire" || k === "bus") { const p = ptsOf(it.node); if (p.length) { add(p[0], it); add(p[p.length - 1], it); } continue; }
    if (k === "bus_entry") { const [x, y] = atOf(it.node), sz = kid(it.node, "size"); add([x, y], it); add([x + (sz ? num(sz[1]) : 2.54), y + (sz ? num(sz[2]) : 2.54)], it); continue; }
    if (CONNECTABLE.has(k)) add(atOf(it.node), it);
  }
  // nearestAnchor( aMousePos, flags, aGrid ): GRID_CONNECTABLE takes connectable items only, GRID_GRAPHICS the others
  const usable = pts.filter((q) => (conn ? q.connectable : !q.connectable));
  let best: Pt | null = null, bd = Infinity;
  for (const q of usable) { const d = Math.hypot(q.p[0] - mouse[0], q.p[1] - mouse[1]); if (d < bd) { bd = d; best = q.p; } }
  return best ? [r4(best[0]), r4(best[1])] : [mouse[0], mouse[1]];
}
