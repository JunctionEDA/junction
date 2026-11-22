// ---------------------------------------------------------------- SCH_COLLECTOR and GuessSelectionCandidates
// SCH_SELECTION_TOOL::CollectHits gathers every item whose own HitTest( pos, threshold ) passes, with one threshold
// for all of them: max( 5 px, |grid| / 2 ).  narrowSelection then drops what is not Selectable or what the Selection
// Filter rejects, and GuessSelectionCandidates thins the rest: exact hits beat sloppy ones, an exact pin or junction
// wins outright, the closest item's half-size "tight box" drops whatever is not contained in it.  What is left is the
// click's pick when it is one item, and the Clarify Selection list when it is several.
import type { Box, SchCtx, SchGeom, Pt } from "./types";
import { root } from "../root";
import { bodyBox, symbolPins, type SymPin } from "./autoplace";
import { boxDist, geomDist, textBox } from "./hit";
import { lineEndDangling, segHitsBox, selectThreshold } from "./line-ends";
import { PIN_SYMBOL_SIZE, pinBox } from "./pins";
import { mmPerPx } from "./snap";
import { K, LINE_KINDS, SHAPE_KINDS, atOf, kid, num, ptsOf } from "./state";
import { segDist } from "./util";

/** One collected item: a document item, a symbol's pin (SCH_PIN_T) or a symbol's field (SCH_FIELD_T). */
export interface Cand { key: string; kind: "item" | "pin" | "field"; item: KItem; pin?: SymPin; field?: string; quad?: Pt[] }
/** The candidate keys the Clarify Selection list and the editor use: a pin is "id#pin:N", a field "id@field:Name". */
export const pinKey = (id: string, number: string) => id + "#pin:" + number;
export const fieldKey = (id: string, name: string) => id + "@field:" + name;

const LABELS = new Set(["label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
const BOXED = new Set(["text", "text_box", "table", "image"]);
/** SCH_JUNCTION::getEffectiveShape: its own diameter, else the schematic's junction size (36 mils). */
export function junctionRadius(it: Pick<KItem, "node">): number { const d = kid(it.node, "diameter"), v = d ? num(d[1]) : 0; return (v > 0 ? v : 0.9144) / 2; }
/** SCH_NO_CONNECT::HitTest's half side: ( pen + size ) / 2 with the 48 mil size and the default 6 mil pen. */
export const NO_CONNECT_HALF = (0.1524 + 1.2192) / 2;
const inflate = (b: Box, m: number): Box => [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
const contains = (b: Box, p: Pt) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
const boxIn = (outer: Box, b: Box) => b[0] >= outer[0] && b[2] <= outer[2] && b[1] >= outer[1] && b[3] <= outer[3];
const boxMeets = (a: Box, b: Box) => a[2] >= b[0] && a[0] <= b[2] && a[3] >= b[1] && a[1] <= b[3];
const quadBox = (q: Pt[]): Box => [Math.min(...q.map((p) => p[0])), Math.min(...q.map((p) => p[1])), Math.max(...q.map((p) => p[0])), Math.max(...q.map((p) => p[1]))];
/** GetPenWidth of a line or shape as the canvas drew it. */
function penOf(it: KItem): number { let w = 0; for (const g of (it.geom || []) as SchGeom[]) if (!g.noStroke && (g.w || 0) > w) w = g.w || 0; return w; }
/** A two-point SCH_LINE (wire, bus, graphic line); a longer polyline is a SCH_SHAPE. */
export const isSchLine = (it: KItem) => LINE_KINDS.has(it.kind) && ptsOf(it.node).length === 2;
const isShape = (it: KItem) => (LINE_KINDS.has(it.kind) && !isSchLine(it)) || SHAPE_KINDS.has(it.kind) || it.kind === "bezier" || it.kind === "rule_area";
/** EDA_SHAPE::IsFilledForHitTesting: a solid fill (the canvas draws it as a stroke-less record); never a rule area. */
export function shapeFilled(it: KItem): boolean { return it.kind !== "rule_area" && ((it.geom || []) as SchGeom[]).some((g) => g.noStroke && !!(g as { fill?: unknown }).fill); }
function pointInPts(p: Pt, poly: Pt[]) { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; } return inside; }
/** Distance from a point to a shape as EDA_SHAPE::hitTest sees it: its outline, and 0 inside a solid fill. */
export function shapeDist(it: KItem, p: Pt): number {
  let d = Infinity;
  for (const g of (it.geom || []) as SchGeom[]) {
    if (g.noStroke) {
      if (!shapeFilled(it)) continue;
      if (g.t === "poly" && g.pts.length > 2 && pointInPts(p, g.pts)) return 0;
      if (g.t === "circle" && Math.hypot(p[0] - g.x, p[1] - g.y) <= g.r) return 0;
      continue;
    }
    d = Math.min(d, geomDist(g, p[0], p[1]));
  }
  return d;
}
/** SCH_SHEET::GetBodyBoundingBox: the sheet rectangle. */
export function sheetBody(it: Pick<KItem, "node" | "bbox">): Box {
  const [x, y] = atOf(it.node), s = kid(it.node, "size"); if (!s) return it.bbox || [x, y, x, y];
  return [x, y, x + num(s[1]), y + num(s[2])];
}
/** SCH_SYMBOL::GetBodyAndPinsBoundingBox. */
export function bodyAndPinsBox(doc: KDoc, it: KItem): Box {
  let b = bodyBox(doc, it).slice() as Box;
  for (const pin of symbolPins(doc, it)) { if (pin.hidden) continue; const q = pinBox(it, pin); b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])]; }
  return b;
}
/** The candidate's GetBoundingBox(). */
export function candBox(doc: KDoc, c: Cand): Box {
  const it = c.item;
  if (c.kind === "pin") return pinBox(it, c.pin!);
  if (c.kind === "field") return quadBox(c.quad!);
  if (it.kind === "symbol") return bodyAndPinsBox(doc, it);
  if (it.kind === "sheet") return sheetBody(it);
  if (LABELS.has(it.kind) || it.kind === "text") return textBox(it);
  if (it.kind === "junction") { const [x, y] = atOf(it.node), r = junctionRadius(it); return [x - r, y - r, x + r, y + r]; }
  if (it.kind === "no_connect") { const [x, y] = atOf(it.node), r = NO_CONNECT_HALF; return [x - r, y - r, x + r, y + r]; }
  if (isSchLine(it)) { const p = ptsOf(it.node), w = penOf(it) / 2; return [Math.min(p[0][0], p[1][0]) - w, Math.min(p[0][1], p[1][1]) - w, Math.max(p[0][0], p[1][0]) + w, Math.max(p[0][1], p[1][1]) + w]; }
  if (it.bbox) return it.bbox;
  const [x, y] = atOf(it.node); return [x, y, x, y];
}
function busEntryEnds(it: KItem): [Pt, Pt] { const [ax, ay] = atOf(it.node), s = kid(it.node, "size"); return [[ax, ay], [ax + (s ? num(s[1]) : 2.54), ay + (s ? num(s[2]) : 2.54)]]; }
/** The candidate's HitTest( position, accuracy ). */
export function candHit(doc: KDoc, c: Cand, p: Pt, acc: number): boolean {
  const it = c.item;
  if (c.kind === "pin") return contains(inflate(pinBox(it, c.pin!), Math.max(acc, PIN_SYMBOL_SIZE / 4)), p);   // SCH_PIN: m_PinSymbolSize / 4 floors the accuracy
  if (c.kind === "field") return contains(inflate(quadBox(c.quad!), acc), p);
  if (it.kind === "symbol") return contains(inflate(bodyBox(doc, it), acc / 2), p);                       // SCH_SYMBOL: the body box grown by accuracy / 2
  if (it.kind === "sheet") return contains(inflate(sheetBody(it), acc), p);
  if (isSchLine(it)) { const q = ptsOf(it.node); return segDist(p, q[0], q[1]) <= acc + penOf(it) / 2; }
  if (isShape(it)) return shapeDist(it, p) <= acc + penOf(it) / 2;                                        // EDA_SHAPE: maxdist = accuracy + width / 2
  if (it.kind === "junction") { const [x, y] = atOf(it.node); return Math.hypot(x - p[0], y - p[1]) <= junctionRadius(it) + acc; }
  if (it.kind === "no_connect") { const [x, y] = atOf(it.node); return Math.abs(x - p[0]) <= NO_CONNECT_HALF + acc && Math.abs(y - p[1]) <= NO_CONNECT_HALF + acc; }
  if (it.kind === "bus_entry") { const [a, b] = busEntryEnds(it); return segDist(p, a, b) <= (acc === 0 ? penOf(it) / 2 + 0.0004 : acc); }
  if (LABELS.has(it.kind) || it.kind === "text") return contains(inflate(textBox(it), acc), p);
  if (BOXED.has(it.kind)) return !!it.bbox && contains(inflate(it.bbox, acc), p);
  return false;
}
/** The candidate's HitTest( rect, contained ): what a selection box takes, and what stays inside a tight box. */
export function candInBox(doc: KDoc, c: Cand, box: Box, contained: boolean): boolean {
  const it = c.item;
  if (c.kind === "pin" || c.kind === "field") { const b = candBox(doc, c); return contained ? boxIn(box, b) : boxMeets(box, b); }
  if (it.kind === "symbol") { const b = bodyBox(doc, it); return contained ? boxIn(box, b) : boxMeets(box, b); }
  if (it.kind === "sheet") { const b = sheetBody(it); return contained ? boxIn(box, b) : boxMeets(box, b); }
  if (isSchLine(it)) { const q = ptsOf(it.node); return contained ? contains(box, q[0]) && contains(box, q[1]) : segHitsBox(q[0], q[1], box as [number, number, number, number]); }
  if (it.kind === "junction") {
    const b = candBox(doc, c); if (contained) return boxIn(box, b);
    const [x, y] = atOf(it.node); return boxDist(box, x, y) <= junctionRadius(it);   // the circle against the rectangle
  }
  if (isShape(it)) {
    const b = it.bbox; if (!b) return false;
    if (contained) return boxIn(box, b);
    if (!boxMeets(box, b)) return false;
    if (boxIn(box, b)) return true;
    // EDA_SHAPE::hitTest( rect, false ): the outline crosses the rectangle (a box inside an unfilled shape misses it)
    for (const g of (it.geom || []) as SchGeom[]) { if (g.noStroke) continue; try { if ((K as unknown as { geomTouchesRect?: (g: unknown, x0: number, y0: number, x1: number, y1: number) => boolean }).geomTouchesRect!(g, box[0], box[1], box[2], box[3])) return true; } catch (e) { return true; } }
    return false;
  }
  if (it.kind === "bus_entry") { const [a, e] = busEntryEnds(it), b: Box = [Math.min(a[0], e[0]), Math.min(a[1], e[1]), Math.max(a[0], e[0]), Math.max(a[1], e[1])]; return contained ? boxIn(box, b) : boxMeets(box, b); }
  const b = candBox(doc, c);
  return contained ? boxIn(box, b) : boxMeets(box, b);
}

interface EditorSeam {
  /** the Selection Filter's verdict: the key of the category that rejects the candidate, "-" for one that is not shown, or null */
  schCandRejects?(kind: "item" | "pin" | "field", item: KItem): string | null;
  pickAllowed?(item: KItem): boolean;
  hiddenLayers?: Set<string> | null;
  renderOpts?: { showHiddenPins?: boolean; showDirectiveLabels?: boolean } | null;
  pinSelectsSymbol?: boolean;
}
const editor = (): EditorSeam => (root.CollabEditor || {}) as EditorSeam;
/** SCH_RULE_AREA::IsDirectiveLabelOnlyArea: it has directive labels on its outline and carries no other setting. */
function directiveOnlyArea(doc: KDoc, it: KItem): boolean {
  const n = it.node; if (kid(n, "exclude_from_sim") && String(kid(n, "exclude_from_sim")![1]) === "yes") return false;
  for (const k of ["in_bom", "on_board", "dnp"]) { const c = kid(n, k); if (c && String(c[1]) === (k === "dnp" ? "yes" : "no")) return false; }
  const poly = ((it.geom || []) as SchGeom[]).find((g) => g.t === "poly" && !g.noStroke) as (SchGeom & { pts: Pt[] }) | undefined; if (!poly) return false;
  for (const o of doc.items.values()) {
    if (o.kind !== "netclass_flag" && o.kind !== "directive_label") continue;
    const a = atOf(o.node), n2 = poly.pts.length;
    for (let i = 0; i < n2; i++) if (segDist(a, poly.pts[i], poly.pts[(i + 1) % n2]) <= 1e-3) return true;
  }
  return false;
}
/** SCH_SELECTION_TOOL::Selectable for a document item (pins and fields are checked where they are collected). */
export function selectableItem(doc: KDoc, it: KItem): boolean {
  const ro = editor().renderOpts;
  if (ro && ro.showDirectiveLabels === false) {
    if (it.kind === "netclass_flag" || it.kind === "directive_label") return false;
    if (it.kind === "rule_area" && directiveOnlyArea(doc, it)) return false;
  }
  return true;
}

/**
 * SCH_SELECTION_TOOL::CollectHits: every item, pin and field whose HitTest( pos, threshold ) passes.  With "Clicking
 * on a pin selects the symbol" on, or pins off in the Selection Filter, a hit pin brings its parent symbol.
 */
export function collectHits(ctx: SchCtx, mm: Pt, threshold?: number): Cand[] {
  const doc = ctx.doc, thr = threshold == null ? selectThreshold(ctx) : threshold, ed = editor(), out: Cand[] = [];
  const hidden = ed.hiddenLayers || null, showHidden = !!(ed.renderOpts && ed.renderOpts.showHiddenPins);
  const reach = thr + 5;
  for (const it of doc.items.values()) {
    const b = it.bbox; if (b && (mm[0] < b[0] - reach || mm[0] > b[2] + reach || mm[1] < b[1] - reach || mm[1] > b[3] + reach)) continue;
    const c: Cand = { key: it.id, kind: "item", item: it };
    if (it.kind === "symbol") {
      let pinHit = false;
      for (const pin of symbolPins(doc, it)) {
        if (pin.hidden && !showHidden) continue;
        const pc: Cand = { key: pinKey(it.id, pin.number), kind: "pin", item: it, pin };
        if (candHit(doc, pc, mm, thr)) { out.push(pc); pinHit = true; }
      }
      let boxes: { name: string; pts: Pt[] }[] = []; try { boxes = K.fieldBoxes(it, hidden) as { name: string; pts: Pt[] }[]; } catch (e) { boxes = []; }
      for (const f of boxes) { const fc: Cand = { key: fieldKey(it.id, f.name), kind: "field", item: it, field: f.name, quad: f.pts }; if (candHit(doc, fc, mm, thr)) out.push(fc); }
      const rejectsPins = !!ed.schCandRejects && ed.schCandRejects("pin", it) === "pins";
      if (candHit(doc, c, mm, thr) || (pinHit && (ed.pinSelectsSymbol || rejectsPins))) out.push(c);
      continue;
    }
    if (candHit(doc, c, mm, thr)) out.push(c);
  }
  return out;
}

export interface Narrowed { cands: Cand[]; /** the collector's size before the filter */ pre: number; /** the filter categories that rejected a hit */ rejected: string[] }
/** narrowSelection: Selectable, the Selection Filter (recording what it rejected), then the heuristics. */
export function narrowCands(ctx: SchCtx, cands: Cand[], mm: Pt, skipHeuristics?: boolean): Narrowed {
  const doc = ctx.doc, ed = editor(), rejected = new Set<string>(), kept: Cand[] = [];
  for (const c of cands) {
    if (c.kind === "item" && !selectableItem(doc, c.item)) continue;
    if (c.kind === "pin" && ed.pinSelectsSymbol) continue;   // Selectable: the pin gives way to its symbol
    const why = ed.schCandRejects ? ed.schCandRejects(c.kind, c.item) : (c.kind === "item" && ed.pickAllowed && !ed.pickAllowed(c.item) ? "-" : null);
    if (why === "-") continue;                               // not shown (the Objects pane): not selectable
    if (why) { rejected.add(why); continue; }
    kept.push(c);
  }
  const out = kept.length > 1 && !skipHeuristics ? guessCandidates(ctx, kept, mm) : kept;
  return { cands: out, pre: cands.length, rejected: kept.length ? [] : [...rejected] };
}
/** The candidates a click at mm is left with (CollectHits + narrowSelection); the first is the closest. */
export function clickCandidates(ctx: SchCtx, mm: Pt, skipHeuristics?: boolean, itemsOnly?: boolean): Narrowed {
  const all = collectHits(ctx, mm);
  // RequestSelection( MovableItems ) (a hover selection for Move, Rotate, Delete ...): its scan types hold no pins
  return narrowCands(ctx, itemsOnly ? all.filter((c) => c.kind === "item") : all, mm, skipHeuristics);
}

/** SCH_SELECTION_TOOL::GuessSelectionCandidates.  Returns the survivors, the closest one first. */
export function guessCandidates(ctx: SchCtx, input: Cand[], mm: Pt): Cand[] {
  const doc = ctx.doc, ed = editor(), thr = selectThreshold(ctx);
  let coll = input.slice();
  // Prefer exact hits to sloppy ones
  const exact = new Set<Cand>();
  for (const c of coll) {
    const it = c.item;
    if (c.kind === "item" && (isSchLine(it) || (isShape(it) && (it.kind === "polyline" || it.kind === "rule_area" || it.kind === "arc")))) {
      if (candHit(doc, c, mm, 6 * mmPerPx(ctx))) exact.add(c);        // lines are hard to hit: 6 px still counts as exact
    } else if (c.kind === "item" && it.kind === "symbol" && ed.pinSelectsSymbol) {
      if (contains(bodyAndPinsBox(doc, it), mm)) exact.add(c);
    } else if (c.kind === "item" && it.kind === "table") { /* table cells are exact, the table itself is not */ }
    else if (candHit(doc, c, mm, 0)) exact.add(c);
  }
  if (exact.size > 0 && exact.size < coll.length) coll = coll.filter((c) => exact.has(c));
  // Find the closest item (all hits are now either exact or sloppy)
  let closest: Cand | null = null, closestDist = Infinity;
  for (const c of coll) {
    const it = c.item; let dist = Infinity, dominating = false;
    if (exact.has(c)) {
      if (c.kind === "pin" || (c.kind === "item" && it.kind === "junction")) {
        // KiCad takes whichever of the two its collector lists first (R-tree order); here a junction sitting on the pin wins
        closest = coll.find((o) => exact.has(o) && o.kind === "item" && o.item.kind === "junction") || c; break;
      }
      if (c.kind === "item" && isSchLine(it)) { const q = ptsOf(it.node); dist = segDist(mm, q[0], q[1]); }
      else if (c.kind === "field") dist = boxDist(quadBox(c.quad!), mm[0], mm[1]);
      else if (c.kind === "item" && (LABELS.has(it.kind) || it.kind === "text" || it.kind === "text_box")) dist = boxDist(candBox(doc, c), mm[0], mm[1]);
      else if (c.kind === "item" && isShape(it)) { dist = shapeDist(it, mm); dominating = shapeFilled(it); }
      else if (c.kind === "item" && it.kind === "symbol") {
        const b = bodyBox(doc, it);
        dist = contains(b, mm) ? Math.hypot((b[0] + b[2]) / 2 - mm[0], (b[1] + b[3]) / 2 - mm[1]) : boxDist(b, mm[0], mm[1]);
      } else { const b = candBox(doc, c); dist = Math.hypot((b[0] + b[2]) / 2 - mm[0], (b[1] + b[3]) / 2 - mm[1]); }
    } else {
      const d = boxDist(candBox(doc, c), mm[0], mm[1]); if (d <= thr) dist = d;
    }
    // a dominating item (a filled shape wins anywhere inside it) is never the closest: it stays selectable but
    // does not boot out worthy competitors
    if (!dominating) {
      if (closest && Math.abs(dist - closestDist) <= 1e-9) { if (c.kind !== "item" && closest.kind === "item" && closest.item === c.item) closest = c; }
      else if (dist < closestDist) { closestDist = dist; closest = c; }
    }
  }
  // A tight box (half the height and width) around the centre of the closest item: whatever lies partly outside it
  // has enough other area to be selected by, and is dropped
  if (closest) {
    const b = candBox(doc, closest), dx = (b[2] - b[0]) / 4, dy = (b[3] - b[1]) / 4, tight: Box = [b[0] + dx, b[1] + dy, b[2] - dx, b[3] - dy];
    const win = closest;
    coll = coll.filter((c) => c === win || candInBox(doc, c, tight, true));
    coll = [win, ...coll.filter((c) => c !== win)];
  }
  return coll;
}
/** The candidate a key names, or null (the item, pin or field is gone). */
export function candOfKey(doc: KDoc, key: string, hidden?: Set<string> | null): Cand | null {
  const pi = key.indexOf("#pin:"), fi = key.indexOf("@field:");
  if (pi > 0) { const it = doc.items.get(key.slice(0, pi)); const pin = it ? symbolPins(doc, it).find((p) => p.number === key.slice(pi + 5)) : null; return it && pin ? { key, kind: "pin", item: it, pin } : null; }
  if (fi > 0) {
    const it = doc.items.get(key.slice(0, fi)); if (!it) return null;
    let boxes: { name: string; pts: Pt[] }[] = []; try { boxes = K.fieldBoxes(it, hidden || null) as { name: string; pts: Pt[] }[]; } catch (e) { boxes = []; }
    const f = boxes.find((q) => q.name === key.slice(fi + 7)); return f ? { key, kind: "field", item: it, field: f.name, quad: f.pts } : null;
  }
  const it = doc.items.get(key); return it ? { key, kind: "item", item: it } : null;
}

// ---------------------------------------------------------------- SelectMultiple (box and lasso)
/** SHAPE_LINE_CHAIN::Area( false ) in sheet coordinates (Y down): positive for a polygon drawn clockwise on screen. */
export function polyArea(poly: Pt[]): number {
  let a = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return -a * 0.5;
}
function segsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  const on = (p: Pt, q: Pt, r: Pt) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}
/** KIGEOM::ShapeHitTest( polygon, outline ): contained = every point inside and no edge crossed; touching = any crossing or any point inside. */
function pathInPoly(poly: Pt[], path: Pt[], closed: boolean, contained: boolean): boolean {
  let cross = false; const n = path.length, m = poly.length;
  for (let i = 0; i < (closed ? n : n - 1) && !cross; i++) for (let j = 0; j < m; j++) if (segsCross(path[i], path[(i + 1) % n], poly[j], poly[(j + 1) % m])) { cross = true; break; }
  if (contained) return !cross && path.every((p) => pointInPts(p, poly));
  return cross || path.some((p) => pointInPts(p, poly)) || (closed && n > 2 && poly.some((p) => pointInPts(p, path)));
}
const boxPath = (b: Box): Pt[] => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
/** The outline of one drawn primitive as points (a circle or arc sampled), and whether it closes. */
function geomPath(g: SchGeom): { pts: Pt[]; closed: boolean } | null {
  if (g.t === "line") return { pts: [[g.x1, g.y1], [g.x2, g.y2]], closed: false };
  if (g.t === "poly") return g.pts.length > 1 ? { pts: g.pts, closed: !!g.close } : null;
  if (g.t === "circle") { const pts: Pt[] = []; for (let i = 0; i < 48; i++) pts.push([g.x + g.r * Math.cos(i * Math.PI / 24), g.y + g.r * Math.sin(i * Math.PI / 24)]); return { pts, closed: true }; }
  if (g.t === "arc") {
    const n = (v: number) => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), sweep = g.anticlockwise ? -n(g.a0 - g.a1) : n(g.a1 - g.a0), pts: Pt[] = [];
    for (let i = 0; i <= 24; i++) { const t = g.a0 + sweep * i / 24; pts.push([g.x + g.r * Math.cos(t), g.y + g.r * Math.sin(t)]); }
    return { pts, closed: false };
  }
  if (g.t === "rect") return { pts: boxPath([g.x, g.y, g.x + g.w, g.y + g.h]), closed: true };
  return null;
}
/** The candidate's HitTest( SHAPE_LINE_CHAIN, contained ): what a lasso takes. */
export function candInPoly(doc: KDoc, c: Cand, poly: Pt[], contained: boolean): boolean {
  const it = c.item;
  if (c.kind === "item" && isSchLine(it)) return pathInPoly(poly, ptsOf(it.node), false, contained);
  if (c.kind === "item" && it.kind === "bus_entry") return pathInPoly(poly, busEntryEnds(it), false, contained);
  if (c.kind === "item" && isShape(it)) {
    // SCH_SHAPE::HitTest( poly ): any one of its effective shapes passing is a hit
    for (const g of (it.geom || []) as SchGeom[]) { if (g.noStroke) continue; const p = geomPath(g); if (p && pathInPoly(poly, p.pts, p.closed, contained)) return true; }
    return false;
  }
  if (c.kind === "item" && it.kind === "junction") { const [x, y] = atOf(it.node), r = junctionRadius(it), pts: Pt[] = []; for (let i = 0; i < 16; i++) pts.push([x + r * Math.cos(i * Math.PI / 8), y + r * Math.sin(i * Math.PI / 8)]); return pathInPoly(poly, pts, true, contained); }
  if (c.kind === "item" && it.kind === "symbol") return pathInPoly(poly, boxPath(bodyBox(doc, it)), true, contained);
  return pathInPoly(poly, boxPath(candBox(doc, c)), true, contained);   // KIGEOM::BoxHitTest
}
export interface AreaPick { /** document items, with selectMultiple's line flags: "whole", or the one dangling end inside */ items: { item: KItem; end: "whole" | 0 | 1 }[]; fields: { id: string; name: string }[]; pins: { id: string; number: string }[] }
/**
 * SCH_SELECTION_TOOL::SelectMultiple over a rectangle (`box`) or a lasso polygon (`poly`): each item by its own
 * HitTest( area, contained ) — a symbol by its body box, a shape by its outline, a label by its body — plus the pins
 * and visible fields of the symbols the area reaches.  FilterCollectorForHierarchy( multiselect ) drops a pin or
 * field whose symbol is taken too; a group's members count in contained mode only when the whole group is inside,
 * and then all of them do. 
 */
export function areaCandidates(ctx: SchCtx, area: { box?: Box; poly?: Pt[]; contained: boolean }): AreaPick {
  const doc = ctx.doc, ed = editor(), contained = area.contained, box = area.box || null, poly = area.poly || null;
  const hidden = ed.hiddenLayers || null, showHidden = !!(ed.renderOpts && ed.renderOpts.showHiddenPins);
  const hit = (c: Cand, cont: boolean) => (box ? candInBox(doc, c, box, cont) : candInPoly(doc, c, poly!, cont));
  const boxContained = (b: Box) => (box ? boxIn(box, b) : pathInPoly(poly!, boxPath(b), true, true));
  const inside = (p: Pt) => (box ? contains(box, p) : pointInPts(p, poly!));
  const allows = (kind: "item" | "pin" | "field", it: KItem) => !(ed.schCandRejects ? ed.schCandRejects(kind, it) : (kind === "item" && ed.pickAllowed && !ed.pickAllowed(it) ? "-" : null));
  // groups: members are left out in contained mode unless the whole group box is inside, which brings them all
  const groupItems = new Set<string>(), viaGroup = new Set<string>();
  for (const g of doc.items.values()) {
    if (g.kind !== "group") continue;
    const m = kid(g.node, "members"), ids = m ? m.slice(1).map(String) : [];
    let gb: Box | null = null; for (const id of ids) { const b = doc.items.get(id)?.bbox; if (b) gb = gb ? [Math.min(gb[0], b[0]), Math.min(gb[1], b[1]), Math.max(gb[2], b[2]), Math.max(gb[3], b[3])] : b.slice(); }
    if (contained && gb && ids.length && boxContained(gb)) for (const id of ids) viaGroup.add(id);
    for (const id of ids) groupItems.add(id);
  }
  const out: AreaPick = { items: [], fields: [], pins: [] }, taken = new Set<string>();
  const pinCands: Cand[] = [], fieldCands: Cand[] = [];
  for (const it of doc.items.values()) {
    if (it.kind === "group" || !selectableItem(doc, it)) continue;
    const c: Cand = { key: it.id, kind: "item", item: it };
    if (it.kind === "symbol") {
      // the view query: pins and visible fields whose box the selection reaches are candidates of their own
      for (const pin of symbolPins(doc, it)) { if (pin.hidden && !showHidden) continue; const pc: Cand = { key: pinKey(it.id, pin.number), kind: "pin", item: it, pin }; if (hit(pc, false)) pinCands.push(pc); }
      let boxes: { name: string; pts: Pt[] }[] = []; try { boxes = K.fieldBoxes(it, hidden) as { name: string; pts: Pt[] }[]; } catch (e) { boxes = []; }
      for (const f of boxes) { const fc: Cand = { key: fieldKey(it.id, f.name), kind: "field", item: it, field: f.name, quad: f.pts }; if (hit(fc, false)) fieldCands.push(fc); }
    }
    if (viaGroup.has(it.id)) { if (allows("item", it)) { out.items.push({ item: it, end: "whole" }); taken.add(it.id); } continue; }
    if (contained && groupItems.has(it.id)) continue;
    if (isSchLine(it)) {
      if (!allows("item", it)) continue;
      // a SCH_LINE: whole when the area touches it (touching mode) or holds both ends; in contained mode otherwise by
      // its dangling ends that are inside (STARTPOINT / ENDPOINT)
      const q = ptsOf(it.node), a = inside(q[0]), b = inside(q[1]); let e: "whole" | 0 | 1 | null = null;
      if ((!contained && hit(c, false)) || (a && b)) e = "whole";
      else if (contained) { const s0 = a && lineEndDangling(doc, it, 0), s1 = b && lineEndDangling(doc, it, 1); e = s0 && s1 ? "whole" : s0 ? 0 : s1 ? 1 : null; }
      if (e !== null) { out.items.push({ item: it, end: e }); taken.add(it.id); }
      continue;
    }
    if (hit(c, contained) && allows("item", it)) { out.items.push({ item: it, end: "whole" }); taken.add(it.id); }
  }
  // a field whose symbol is taken goes with it; pins are the selection only when nothing else was boxed
  for (const fc of fieldCands) if (!taken.has(fc.item.id) && hit(fc, contained) && allows("field", fc.item)) out.fields.push({ id: fc.item.id, name: fc.field! });
  if (!out.items.length && !out.fields.length) for (const pc of pinCands) if (!ed.pinSelectsSymbol && hit(pc, contained) && allows("pin", pc.item)) out.pins.push({ id: pc.item.id, number: pc.pin!.number });
  return out;
}

// ---------------------------------------------------------------- cross-probe zoom
/**
 * SCH_SELECTION_TOOL::ZoomFitCrossProbeBBox: the factor the viewport's size is multiplied by (the scale divided by)
 * for a cross-probed selection box of w x h mm shown in a viewport of vw x vh mm, or null when the view keeps its
 * zoom.  The box is grown by 20 % of its width; the ratio of its height to the default text height (50 mils) is bent
 * through a table so that a small symbol is not blown up to fill the screen; a box too wide for that falls back to
 * the plain fit; nothing changes while the resulting ratio lies within 0.5 .. 1.
 */
export function crossProbeZoomRatio(w: number, h: number, vw: number, vh: number): number | null {
  w = Math.abs(w); h = Math.abs(h); if (w === 0) return null;
  const grow = Math.round(w * 0.2 * 1e4) / 1e4, bx = w + 2 * grow, by = h + 2 * grow;
  const compRatio = by / 1.27;
  const lut: [number, number][] = [[1.25, 16], [2.5, 12], [5, 8], [6, 6], [10, 4], [20, 2], [40, 1.5], [100, 1]];
  let bent = lut[lut.length - 1][1];
  if (compRatio >= lut[0][0]) {
    for (let i = 0; i < lut.length - 1; i++) if (lut[i][0] <= compRatio && lut[i + 1][0] >= compRatio) { bent = lut[i][1] + (lut[i + 1][1] - lut[i][1]) * (compRatio - lut[i][0]) / (lut[i + 1][0] - lut[i][0]); break; }
  } else bent = lut[0][1];
  vw = Math.max(10 / 1e4, vw); vh = Math.max(10 / 1e4, vh);
  let ratio = Math.max(-1, Math.abs(by / vh));
  const kicadRatio = Math.max(Math.abs(bx / vw), Math.abs(by / vh));
  if (bx > vw * ratio * bent) { ratio = kicadRatio; bent = 1; }   // too wide for the screen: the normal fit
  ratio *= bent;
  return ratio < 0.5 || ratio > 1 ? ratio : null;
}
