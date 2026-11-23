// construction.ts — KiCad's construction geometry for the board's snapping (common/tool/construction_manager.cpp
// CONSTRUCTION_MANAGER and SNAP_LINE_MANAGER, pcbnew/tools/pcb_grid_helper.cpp AddConstructionItems).
//
// Hovering a graphic (or snapping to one of its anchors) proposes its construction items: a line's two rays out from
// its ends, the rest of an arc's circle and its centre, a circle's or rectangle's centre, a reference image's position
// and frame.  A proposal is accepted after m_ExtensionSnapTimeoutMs (500 ms) unless another one replaces it or it is
// cancelled; one persistent batch and up to two temporary batches are kept.  The accepted lines take part in the
// snapping (their intersections with each other and with the items near the cursor are anchors, their free points
// are anchors) and are drawn in LAYER_ANCHOR.
//
// The snap line manager keeps the move's angle-snap lines: their origin (moved onto each anchor the cursor snaps to
// that is not on one of the lines), the snapped end and so the active direction.

import type { Pt } from "./types";
import { K } from "./state";
import { isList, rotator } from "./util";

/** KIGFX::CONSTRUCTION_GEOM::DRAWABLE: LINE (infinite), HALF_LINE (a ray from a through b), SEG, CIRCLE, SHAPE_ARC or a point. */
export type CDrawable =
  | { t: "line"; a: Pt; b: Pt }
  | { t: "half"; a: Pt; b: Pt }
  | { t: "seg"; a: Pt; b: Pt }
  | { t: "circle"; c: Pt; r: number }
  | { t: "arc"; c: Pt; r: number; a0: number; a1: number; anticlockwise: boolean }
  | { t: "pt"; p: Pt };
/** CONSTRUCTION_ITEM: where it came from, the item (a key: an item id, "#n" for a footprint's nth graphic) and its drawables with their line widths. */
export interface CItem { source: "items" | "snapLine"; item: string | null; drawables: { d: CDrawable; w: number }[] }
export type CBatch = CItem[];

/** ADVANCED_CFG m_ExtensionSnapTimeoutMs. */
export const EXTENSION_SNAP_TIMEOUT_MS = 500;
/** CONSTRUCTION_MANAGER::getMaxTemporaryBatches. */
const MAX_TEMPORARY_BATCHES = 2;

interface Pending { batch: CBatch; persistent: boolean }
const CM = {
  persistent: null as CBatch | null,
  temporary: [] as CBatch[],
  involved: new Set<string | null>(),
  pending: null as Pending | null,
  pendingTag: null as string | null,
  lastAcceptedTag: null as string | null,
  timer: null as ReturnType<typeof setTimeout> | null,
  onChange: null as (() => void) | null,
};

/** HashConstructionBatchSources: the persistence and each item's source and item. */
const batchTag = (b: CBatch, persistent: boolean) => JSON.stringify([persistent, b.map((i) => [i.source, i.item])]);

/** The callback run when an accepted batch changes what is drawn (a re-render). */
export function setConstructionChangeCallback(f: (() => void) | null) { CM.onChange = f; }

/**
 * CONSTRUCTION_MANAGER::ProposeConstructionItems through ACTIVATION_HELPER::ProposeActivation: an empty batch is
 * ignored; the batch accepted last time and the one already pending are not proposed again; a persistent batch is
 * accepted at once, a temporary one when the timeout passes.
 */
export function proposeConstructionItems(batch: CBatch, persistent: boolean, timeoutMs = EXTENSION_SNAP_TIMEOUT_MS) {
  if (!batch.length) return;
  const tag = batchTag(batch, persistent);
  if (CM.lastAcceptedTag === tag || CM.pendingTag === tag) return;
  CM.pendingTag = tag; CM.pending = { batch, persistent };
  if (CM.timer) { clearTimeout(CM.timer); CM.timer = null; }
  if (persistent) acceptPending();
  else {
    CM.timer = setTimeout(() => { CM.timer = null; acceptPending(); }, timeoutMs);
    const t = CM.timer as unknown as { unref?: () => void }; if (t && typeof t.unref === "function") t.unref();   // (node: a test never waits on it)
  }
}
/** ACTIVATION_HELPER::CancelProposal. */
export function cancelConstructionProposal() {
  CM.pendingTag = null; CM.pending = null;
  if (CM.timer) { clearTimeout(CM.timer); CM.timer = null; }
}
function acceptPending() {
  if (!CM.pendingTag || !CM.pending) return;
  CM.lastAcceptedTag = CM.pendingTag; CM.pendingTag = null;
  const p = CM.pending; CM.pending = null;
  acceptConstructionItems(p.batch, p.persistent);
}
/**
 * CONSTRUCTION_MANAGER::acceptConstructionItems: a persistent batch replaces the persistent one; a temporary batch
 * is added (dropping the oldest past two) only when it involves an item not already involved.
 */
function acceptConstructionItems(batch: CBatch, persistent: boolean) {
  if (persistent) CM.persistent = batch;
  else {
    if (!batch.some((i) => !CM.involved.has(i.item))) return;
    while (CM.temporary.length >= MAX_TEMPORARY_BATCHES) CM.temporary.shift();
    CM.temporary.push(batch);
  }
  CM.involved.clear();
  for (const b of constructionBatches()) for (const i of b) CM.involved.add(i.item);
  if (CM.onChange) CM.onChange();
}
/** CONSTRUCTION_MANAGER::GetConstructionItems: the persistent batch, then the temporary ones. */
export function constructionBatches(): CBatch[] { return (CM.persistent ? [CM.persistent] : []).concat(CM.temporary); }
/** CONSTRUCTION_MANAGER::HasActiveConstruction. */
export const hasActiveConstruction = () => !!CM.persistent || CM.temporary.length > 0;
/** CONSTRUCTION_MANAGER::Clear. */
export function clearConstruction() {
  CM.persistent = null; CM.temporary = []; CM.involved.clear(); cancelConstructionProposal();
  CM.lastAcceptedTag = null;
}

// ---------------------------------------------------------------- what an item offers (PCB_GRID_HELPER::AddConstructionItems)

const FP_SHAPES: Record<string, string> = { fp_line: "gr_line", fp_rect: "gr_rect", fp_circle: "gr_circle", fp_arc: "gr_arc" };
/** A graphic in board coordinates: its shape, points, stroke width and fill. */
export interface CShape { kind: "line" | "arc" | "circle" | "rect"; start: Pt; end: Pt; mid?: Pt; center?: Pt; r?: number; w: number; filled: boolean; arc?: { c: Pt; r: number; a0: number; a1: number; anticlockwise: boolean } }
function shapeOf(kind: string, n: SNode, tf: (p: Pt) => Pt): CShape | null {
  const p = (key: string): Pt | null => { const k = K.kid(n, key); return k ? tf([K.num(k[1]), K.num(k[2])]) : null; };
  const st = K.kid(n, "stroke"), sw = st && K.kid(st as SNode, "width"), wn = K.kid(n, "width");
  const w = sw ? K.num(sw[1]) : wn ? K.num(wn[1]) : 0;
  const f = K.kid(n, "fill"), filled = !!f && /^(yes|solid)$/.test(String(K.str(f[1])));
  if (kind === "gr_line") { const s = p("start"), e = p("end"); return s && e ? { kind: "line", start: s, end: e, w, filled: false } : null; }
  if (kind === "gr_rect") { const s = p("start"), e = p("end"); return s && e ? { kind: "rect", start: s, end: e, center: [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2], w, filled } : null; }
  if (kind === "gr_circle") { const c = p("center"), e = p("end"); return c && e ? { kind: "circle", start: e, end: e, center: c, r: Math.hypot(e[0] - c[0], e[1] - c[1]), w, filled } : null; }
  if (kind === "gr_arc") {
    const s = p("start"), m = p("mid"), e = p("end"); if (!s || !m || !e) return null;
    const a = K.arcFrom3(s, m, e) as { x: number; y: number; r: number; a0: number; a1: number; anticlockwise: boolean } | null; if (!a) return null;
    return { kind: "arc", start: s, mid: m, end: e, center: [a.x, a.y], r: a.r, w, filled: false, arc: { c: [a.x, a.y], r: a.r, a0: a.a0, a1: a.a1, anticlockwise: a.anticlockwise } };
  }
  return null;
}
/** The graphics an item is made of, keyed as construction items: a board graphic itself, a footprint's graphics one by one. */
export function itemShapes(it: KItem): { key: string; shape: CShape; layer: string }[] {
  if (/^gr_(line|rect|circle|arc)$/.test(it.kind)) { const s = shapeOf(it.kind, it.node, (q) => q); return s ? [{ key: it.id, shape: s, layer: it.layer || "" }] : []; }
  if (it.kind !== "footprint") return [];
  const [fx, fy, fa] = K.atOf(it.node); const R = rotator(fa); const tf = (q: Pt): Pt => { const [x, y] = R(q[0], q[1]); return [fx + x, fy + y]; };
  const out: { key: string; shape: CShape; layer: string }[] = [];
  it.node.forEach((c: unknown, i: number) => {
    if (!isList(c)) return; const kind = FP_SHAPES[String(c[0])]; if (!kind) return;
    const s = shapeOf(kind, c as SNode, tf); const l = K.kid(c as SNode, "layer");
    if (s) out.push({ key: it.id + "#" + i, shape: s, layer: l ? String(K.str(l[1])) : "" });
  });
  return out;
}
/**
 * AddConstructionItems for one graphic: a segment gives its whole line, or with aExtensionOnly the two rays out from
 * its ends; an arc its circle, or the rest of it (the arc through the point opposite its middle), and its centre; a
 * circle and a rectangle their centre.  A persistent segment or arc also gives its ends as (reference-only) points.
 */
export function shapeConstruction(s: CShape, extensionOnly: boolean, persistent: boolean): CDrawable[] {
  const out: CDrawable[] = [];
  if (s.kind === "line") {
    if (!extensionOnly) out.push({ t: "line", a: s.start, b: s.end });
    else {
      const v: Pt = [s.end[0] - s.start[0], s.end[1] - s.start[1]];
      out.push({ t: "half", a: s.start, b: [s.start[0] - v[0], s.start[1] - v[1]] }, { t: "half", a: s.end, b: [s.end[0] + v[0], s.end[1] + v[1]] });
    }
    if (persistent) out.push({ t: "pt", p: s.start }, { t: "pt", p: s.end });
  } else if (s.kind === "arc" && s.arc) {
    const a = s.arc;
    if (!extensionOnly) out.push({ t: "circle", c: a.c, r: a.r });
    else out.push({ t: "arc", c: a.c, r: a.r, a0: a.a1, a1: a.a0, anticlockwise: a.anticlockwise });   // start -> opposite mid -> end
    out.push({ t: "pt", p: a.c });
    if (persistent) out.push({ t: "pt", p: s.start }, { t: "pt", p: s.end });
  } else if ((s.kind === "circle" || s.kind === "rect") && s.center) out.push({ t: "pt", p: s.center });
  return out;
}
/** A reference image (PCB_REFERENCE_IMAGE_T): its position and the four sides of its box. */
export function imageConstruction(it: KItem): CDrawable[] {
  const b = it.bbox; if (!b) return [];
  const [x, y] = K.atOf(it.node);
  const P: Pt[] = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
  return [{ t: "pt", p: [x, y] } as CDrawable].concat(P.map((p, i) => ({ t: "seg", a: p, b: P[(i + 1) % 4] }) as CDrawable));
}
/** The construction items for graphics given by key (AddConstructionItems( aItems, aExtensionOnly = true, false )). */
export function constructionBatchFor(entries: { key: string; drawables: CDrawable[] }[]): CBatch {
  return entries.map((e) => ({ source: "items", item: e.key, drawables: e.drawables.map((d) => ({ d, w: 1 })) }));
}

// ---------------------------------------------------------------- hit testing (BOARD_ITEM::HitTest( aPosition, 0 ))

const segDist = (p: Pt, a: Pt, b: Pt) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
const TWO_PI = Math.PI * 2, nrm = (v: number) => ((v % TWO_PI) + TWO_PI) % TWO_PI;
/** Whether angle `t` lies on the arc's sweep. */
export function onArcSweep(a: { a0: number; a1: number; anticlockwise: boolean }, t: number) {
  const from = a.anticlockwise ? a.a1 : a.a0, sweep = nrm((a.anticlockwise ? a.a0 : a.a1) - from) || TWO_PI;
  return nrm(t - from) <= sweep + 1e-9;
}
/** PCB_SHAPE::HitTest with no extra accuracy: within half the stroke of the outline, or inside a filled shape. */
export function shapeHit(s: CShape, p: Pt): boolean {
  const tol = s.w / 2;
  if (s.kind === "line") return segDist(p, s.start, s.end) <= tol;
  if (s.kind === "circle" && s.center && s.r !== undefined) { const d = Math.hypot(p[0] - s.center[0], p[1] - s.center[1]); return s.filled ? d <= s.r + tol : Math.abs(d - s.r) <= tol; }
  if (s.kind === "arc" && s.arc) { const d = Math.hypot(p[0] - s.arc.c[0], p[1] - s.arc.c[1]); return Math.abs(d - s.arc.r) <= tol && onArcSweep(s.arc, Math.atan2(p[1] - s.arc.c[1], p[0] - s.arc.c[0])); }
  if (s.kind === "rect") {
    const x0 = Math.min(s.start[0], s.end[0]), x1 = Math.max(s.start[0], s.end[0]), y0 = Math.min(s.start[1], s.end[1]), y1 = Math.max(s.start[1], s.end[1]);
    if (s.filled && p[0] >= x0 - tol && p[0] <= x1 + tol && p[1] >= y0 - tol && p[1] <= y1 + tol) return true;
    const P: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    return P.some((q, i) => segDist(p, q, P[(i + 1) % 4]) <= tol);
  }
  return false;
}

// ---------------------------------------------------------------- SNAP_LINE_MANAGER

const SL = {
  origin: null as Pt | null,
  end: null as Pt | null,
  dirs: [] as Pt[],
  active: null as number | null,
  seed: null as Pt | null,
};
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
/** normalizeDirection: reduced by the gcd, pointing right (or down). */
export function normalizeDirection(d: Pt): Pt {
  let dx = Math.round(d[0]), dy = Math.round(d[1]); if (!dx && !dy) return [0, 0];
  const g = gcd(Math.abs(dx), Math.abs(dy)); if (g > 0) { dx /= g; dy /= g; }
  if (dx < 0 || (dx === 0 && dy < 0)) { dx = -dx; dy = -dy; }
  return [dx + 0, dy + 0];
}
const near0 = (v: number) => Math.abs(v) < 1e-6;
/** findDirectionIndex: the direction a delta runs along exactly, or null (in mm, so a delta along a direction to 1e-6). */
export function findDirectionIndex(dirs: Pt[], delta: Pt): number | null {
  if (near0(delta[0]) && near0(delta[1])) return null;
  for (let i = 0; i < dirs.length; i++) { const d = dirs[i]; if (near0(delta[0] * d[1] - delta[1] * d[0])) return i; }
  return null;
}
/** SNAP_LINE_MANAGER::SetDirections: unique normalised directions; a change drops the active direction (and an end no longer on one). */
export function snapLineSetDirections(dirs: Pt[]) {
  const u: Pt[] = [];
  for (const d of dirs) { const n = normalizeDirection(d); if (!n[0] && !n[1]) continue; if (!u.some((q) => q[0] === n[0] && q[1] === n[1])) u.push(n); }
  if (u.length === SL.dirs.length && u.every((q, i) => q[0] === SL.dirs[i][0] && q[1] === SL.dirs[i][1])) return;
  SL.dirs = u; SL.active = null;
  if (SL.origin && SL.end && findDirectionIndex(SL.dirs, [SL.end[0] - SL.origin[0], SL.end[1] - SL.origin[1]]) === null) SL.end = null;
  if (!SL.dirs.length) snapLineClear();
}
/** SNAP_LINE_MANAGER::SetSnapLineOrigin: a new origin drops the end and the active direction. */
export function snapLineSetOrigin(o: Pt) {
  if (SL.origin && SL.origin[0] === o[0] && SL.origin[1] === o[1] && !SL.end) return;
  SL.origin = [o[0], o[1]]; SL.end = null; SL.active = null;
}
/** SNAP_LINE_MANAGER::SetSnapLineEnd: the end, and the direction it lies along as the active one. */
export function snapLineSetEnd(e: Pt | null) {
  if (!SL.origin) return;
  if ((e === null && SL.end === null) || (e && SL.end && e[0] === SL.end[0] && e[1] === SL.end[1])) return;
  SL.end = e ? [e[0], e[1]] : null;
  SL.active = SL.end ? findDirectionIndex(SL.dirs, [SL.end[0] - SL.origin[0], SL.end[1] - SL.origin[1]]) : null;
}
/** SNAP_LINE_MANAGER::ClearSnapLine. */
export function snapLineClear() { SL.origin = null; SL.end = null; SL.active = null; SL.seed = null; }
/**
 * SNAP_LINE_MANAGER::SetSnappedAnchor: an anchor on one of the lines through the origin becomes the line's end;
 * any other anchor becomes the new origin.
 */
export function snapLineSetSnappedAnchor(p: Pt) {
  if (SL.origin && findDirectionIndex(SL.dirs, [p[0] - SL.origin[0], p[1] - SL.origin[1]]) !== null) snapLineSetEnd(p);
  else snapLineSetOrigin(p);
}
/**
 * The caller's snap lines (EDIT_TOOL::doMoveSelection's configureAngleSnap: SetSnapLineDirections, then
 * SetSnapLineOrigin( the move's origin ) on a new move or a mode change).  Later anchors move the origin.
 */
export function snapLineConfigure(origin: Pt, dirs: Pt[]) {
  const before = SL.dirs;
  snapLineSetDirections(dirs);
  if (!SL.dirs.length) return;
  if (!SL.seed || SL.seed[0] !== origin[0] || SL.seed[1] !== origin[1] || before !== SL.dirs) { SL.seed = [origin[0], origin[1]]; snapLineSetOrigin(origin); }
}
/** The snap line state: origin, end, directions and the active direction's index. */
export function snapLineState() { return { origin: SL.origin, end: SL.end, dirs: SL.dirs, active: SL.active }; }
/**
 * SNAP_MANAGER::GetConstructionItems' snap line batch: a line through the origin along each direction (FROM_SNAP_LINE,
 * no item), the active one twice as wide.
 */
export function snapLineConstruction(): CBatch {
  if (!SL.origin || !SL.dirs.length) return [];
  const o = SL.origin;
  return [{ source: "snapLine", item: null, drawables: SL.dirs.map((d, i) => ({ d: { t: "line", a: o, b: [o[0] + d[0], o[1] + d[1]] } as CDrawable, w: SL.active === i ? 2 : 1 })) }];
}
