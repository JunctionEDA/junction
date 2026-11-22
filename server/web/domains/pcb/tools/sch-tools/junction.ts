import type { PreviewLine, SchCtx, SchWire, UnfoldJob, Pt } from "./types";
import { symbolPins } from "./autoplace";
import { junctionAt, lineMidsAt } from "./connect";
import { connPoints, isNetLine } from "./drag";
import { junctionNode, lineNode } from "./nodes";
import { K, S, atOf, kid, kids, num, ptsOf, setAt, setPts, str } from "./state";
import { addNode, deep, modChange, r4, removeChange, replaceKid, same, segDist, segs } from "./util";
import { type Seg, mergeOverlap, segNull, simplifyWireList, twoSegments, wireNode } from "./wire";

// ---------------------------------------------------------------- JUNCTION_HELPERS::AnalyzePoint (eeschema/junction_helpers.cpp)
/** the stroke a new line gets (nodes.ts lineNode), serialized the way analyzePoint compares strokes */
const DEFAULT_STROKE = K.serialize(["stroke", ["width", 0], ["type", "default"]]);
export const angleKey = (from: Pt, to: Pt) => Math.round(Math.atan2(to[1] - from[1], to[0] - from[0]) * 1800 / Math.PI);
export const BUS_TEXT = /\[.*\.\..*\]|\{.*\}/;
/**
 * What meets at p: { isJunction, hasDot, hasBusEntry, hasBusAtPoint, allows } — three or more distinct
 * exit directions on the wire or the bus layer make a junction.  Collinear wires through the point are
 * merged first (unless a dot is there, crossings are being broken or three stubs already meet), so two
 * wires meeting end to end do not count as two exits.  `extra` adds lines that are not in the document
 * (a wire being drawn: [{ kind, a, b }]), `skip` leaves items out (ids).
 */
/**
 * The sheet's items as analyzePoint reads them, gathered once so that many points can be analysed without walking
 * every item (and every symbol's pins) again for each one: a moved 100-pin symbol asks about every pin each frame.
 */
export interface PointIndex {
  lines: { layer: string; a: Pt; b: Pt; stroke: string }[];
  dots: Pt[];
  entries: { item: KItem; c: Pt[]; m: number }[];
  /** every symbol, sheet and label, with the points where it adds an exit or a break */
  others: { item: KItem; pts: Pt[] }[];
  /** grid buckets of `others` and `dots` by rounded point (1 mm cells) */
  cells: Map<string, number[]>; dotCells: Map<string, number[]>;
  /** `lines` by 5 mm cell of their bounding box */
  lineCells: Map<string, number[]>;
}
const LINE_CELL = 5;
const cellKey = (x: number, y: number) => Math.round(x) + "," + Math.round(y);
function cellsNear(cells: Map<string, number[]>, p: Pt): number[] {
  const out: number[] = [], cx = Math.round(p[0]), cy = Math.round(p[1]);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const l = cells.get((cx + dx) + "," + (cy + dy)); if (l) for (const i of l) out.push(i); }
  return out;
}
export function pointIndex(doc: KDoc, skip?: Set<string> | null): PointIndex {
  const ix: PointIndex = { lines: [], dots: [], entries: [], others: [], cells: new Map(), dotCells: new Map(), lineCells: new Map() };
  const strokeOf = (it: KItem) => K.serialize(kid(it.node, "stroke") || []);
  const bucket = (cells: Map<string, number[]>, q: Pt, i: number) => { const k = cellKey(q[0], q[1]), l = cells.get(k); if (l) { if (l[l.length - 1] !== i) l.push(i); } else cells.set(k, [i]); };
  for (const it of doc.items.values()) {
    if (skip && skip.has(it.id)) continue;
    if (it.kind === "wire" || it.kind === "bus") {
      const st = strokeOf(it);
      for (const [a, b] of segs(it)) {
        const i = ix.lines.length; ix.lines.push({ layer: it.kind, a, b, stroke: st });
        const x0 = Math.floor((Math.min(a[0], b[0]) - 0.01) / LINE_CELL), x1 = Math.floor((Math.max(a[0], b[0]) + 0.01) / LINE_CELL);
        const y0 = Math.floor((Math.min(a[1], b[1]) - 0.01) / LINE_CELL), y1 = Math.floor((Math.max(a[1], b[1]) + 0.01) / LINE_CELL);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = x + "," + y, l = ix.lineCells.get(k); if (l) l.push(i); else ix.lineCells.set(k, [i]); }
      }
    }
    else if (it.kind === "junction") { const q = atOf(it.node) as Pt; bucket(ix.dotCells, q, ix.dots.length); ix.dots.push(q); }
    else if (it.kind === "bus_entry") {
      const c = connPoints(doc, it), st = kid(it.node, "stroke"), w = st ? num((kid(st, "width") || [])[1]) : 0;
      ix.entries.push({ item: it, c, m: (w > 0 ? w : 0.1524) / 2 + 1e-4 });
    } else if (it.kind === "symbol" || it.kind === "sheet" || it.kind === "label" || it.kind === "global_label" || it.kind === "hierarchical_label") {
      const pts: Pt[] = it.kind === "symbol" ? symbolPins(doc, it).filter((q) => q.type !== "no_connect").map((q) => [q.x, q.y] as Pt)
        : it.kind === "sheet" ? kids(it.node, "pin").map((pin) => atOf(pin) as Pt) : [atOf(it.node) as Pt];
      const i = ix.others.length; ix.others.push({ item: it, pts }); for (const q of pts) bucket(ix.cells, q, i);
    }
  }
  return ix;
}
/** The part of pointIndex that matters at p alone, gathered in one pass (no buckets beyond p's own cells). */
function pointScan(doc: KDoc, p: Pt, skip?: Set<string> | null): PointIndex {
  const ix: PointIndex = { lines: [], dots: [], entries: [], others: [], cells: new Map(), dotCells: new Map(), lineCells: new Map() };
  const lk = Math.floor(p[0] / LINE_CELL) + "," + Math.floor(p[1] / LINE_CELL), ck = cellKey(p[0], p[1]), li: number[] = [], di: number[] = [], oi: number[] = [];
  ix.lineCells.set(lk, li); ix.dotCells.set(ck, di); ix.cells.set(ck, oi);
  for (const it of doc.items.values()) {
    if (skip && skip.has(it.id)) continue;
    if (it.kind === "wire" || it.kind === "bus") {
      let st: string | null = null;
      for (const [a, b] of segs(it)) if (segDist(p, a, b) <= 1e-3) { if (st === null) st = K.serialize(kid(it.node, "stroke") || []); li.push(ix.lines.length); ix.lines.push({ layer: it.kind, a, b, stroke: st }); }
    } else if (it.kind === "junction") { const q = atOf(it.node) as Pt; if (same(q, p)) { di.push(ix.dots.length); ix.dots.push(q); } }
    else if (it.kind === "bus_entry") {
      const c = connPoints(doc, it), st = kid(it.node, "stroke"), w = st ? num((kid(st, "width") || [])[1]) : 0;
      ix.entries.push({ item: it, c, m: (w > 0 ? w : 0.1524) / 2 + 1e-4 });
    } else if (it.kind === "symbol" || it.kind === "sheet" || it.kind === "label" || it.kind === "global_label" || it.kind === "hierarchical_label") {
      const pts: Pt[] = it.kind === "symbol" ? symbolPins(doc, it).filter((q) => q.type !== "no_connect" && same([q.x, q.y], p)).map((q) => [q.x, q.y] as Pt)
        : it.kind === "sheet" ? kids(it.node, "pin").map((pin) => atOf(pin) as Pt).filter((q) => same(q, p)) : [atOf(it.node) as Pt].filter((q) => same(q, p));
      if (pts.length) { oi.push(ix.others.length); ix.others.push({ item: it, pts }); }
    }
  }
  return ix;
}
export function analyzePoint(doc: KDoc, p: Pt, breakCrossings: boolean, extra?: PreviewLine[] | null, skip?: Set<string> | null, index?: PointIndex | null) {
  const info = { isJunction: false, hasDot: false, hasBusEntry: false, hasBusAtPoint: false, multiWires: false, multiBuses: false, allows: false };
  const lines: { layer: string; a: Pt; b: Pt; stroke: string }[] = [], others: KItem[] = [];
  const onLine = (a: Pt, b: Pt) => segDist(p, a, b) <= 1e-3;
  // one point on its own (the document may be changing between calls): read the items directly; many points at
  // once (previewJunctions) pass an index built once
  const ix = index || pointScan(doc, p, skip);
  for (const i of ix.lineCells.get(Math.floor(p[0] / LINE_CELL) + "," + Math.floor(p[1] / LINE_CELL)) || []) { const l = ix.lines[i]; if (onLine(l.a, l.b)) lines.push(l); }
  for (const i of cellsNear(ix.dotCells, p)) if (same(ix.dots[i], p)) info.hasDot = true;
  for (const e of ix.entries) {
    // aItems.Overlapping( aPosition ): any entry whose bounding box (inflated by half its pen width + 1 IU) holds the
    // point sets hasBusEntry, connected or not; only one that ends here adds exits
    const c = e.c, m = e.m;
    if (p[0] >= Math.min(c[0][0], c[1][0]) - m && p[0] <= Math.max(c[0][0], c[1][0]) + m && p[1] >= Math.min(c[0][1], c[1][1]) - m && p[1] <= Math.max(c[0][1], c[1][1]) + m) info.hasBusEntry = true;
    if (c.some((q) => same(q, p))) { info.hasBusEntry = true; others.push(e.item); }
  }
  const near = new Set<number>(cellsNear(ix.cells, p));
  for (const i of Array.from(near).sort((a, b) => a - b)) { const o = ix.others[i]; if (o.pts.some((q) => same(q, p))) others.push(o.item); }
  for (const e of extra || []) if ((e.kind === "wire" || e.kind === "bus") && !same(e.a, e.b) && onLine(e.a, e.b)) lines.push({ layer: e.kind, a: e.a, b: e.b, stroke: DEFAULT_STROKE });
  const isEnd = (l: { a: Pt; b: Pt }) => same(l.a, p) || same(l.b, p);
  const pre: Record<string, Set<number>> = { wire: new Set(), bus: new Set() };
  for (const l of lines) if (!same(l.a, l.b) && isEnd(l)) pre[l.layer].add(angleKey(p, same(l.a, p) ? l.b : l.a));
  const keepStub = pre.wire.size >= 3 || pre.bus.size >= 3;
  if (!info.hasDot && !breakCrossings && !keepStub) {
    for (let merged = true; merged;) {
      merged = false;
      for (let i = 0; i < lines.length && !merged; i++) for (let j = i + 1; j < lines.length; j++) {
        if (lines[i].layer !== lines[j].layer || lines[i].stroke !== lines[j].stroke) continue;   // SCH_LINE::MergeOverlap refuses another layer or stroke
        const m = mergeOverlap([lines[i].a, lines[i].b], [lines[j].a, lines[j].b], null);
        if (m) { lines[i] = { layer: lines[i].layer, a: m[0], b: m[1], stroke: lines[i].stroke }; lines.splice(j, 1); merged = true; break; }
      }
    }
  }
  const exits: Record<string, Set<number>> = { wire: new Set(), bus: new Set() }, brk: Record<string, boolean> = { wire: false, bus: false }, mids: Record<string, { a: Pt; b: Pt }[]> = { wire: [], bus: [] };
  let unique = 100000, entryBus = 0, busEnds = 0;
  for (const l of lines) {
    if (same(l.a, l.b)) continue;
    if (isEnd(l)) { brk[l.layer] = true; exits[l.layer].add(angleKey(p, same(l.a, p) ? l.b : l.a)); if (l.layer === "bus") busEnds++; }
    else { if (breakCrossings) brk[l.layer] = true; mids[l.layer].push(l); }
    if (l.layer === "bus") info.hasBusAtPoint = true;
  }
  for (const it of others) {
    if (it.kind === "bus_entry") { brk.bus = true; exits.bus.add(unique++); entryBus++; brk.wire = true; exits.wire.add(unique++); info.hasBusEntry = true; }
    else if (it.kind === "symbol") { brk.wire = true; exits.wire.add(unique++); }             // a pin (not a no-connect pin) lands here
    else if (it.kind === "sheet") { brk.wire = true; exits.wire.add(unique++); }              // a sheet pin lands here
    else {
      if (it.kind === "label" && BUS_TEXT.test(str(it.node[1]))) brk.bus = true; else brk.wire = true;
    }
  }
  for (const layer of ["wire", "bus"]) if (brk[layer]) for (const l of mids[layer]) { exits[layer].add(angleKey(p, l.b)); exits[layer].add(angleKey(p, l.a)); }
  if (info.hasBusEntry) { info.multiWires = exits.wire.size > 2 && exits.bus.size === 1; info.multiBuses = exits.bus.size - entryBus >= 3 && busEnds >= 1; }
  info.isJunction = exits.wire.size >= 3 || exits.bus.size >= 3;
  info.allows = info.isJunction && (!info.hasBusEntry || info.multiWires || info.multiBuses);
  return info;
}
export const isJunctionPoint = (doc: KDoc, p: Pt) => analyzePoint(doc, p, false).isJunction;                                   // SCH_SCREEN::IsJunction
export const explicitJunctionNeeded = (doc: KDoc, p: Pt, extra?: PreviewLine[] | null, skip?: Set<string> | null) => { const i = analyzePoint(doc, p, false, extra, skip); return i.allows && !i.hasDot; };
export const explicitJunctionAllowed = (doc: KDoc, p: Pt) => analyzePoint(doc, p, true).allows;
// Every connection point of the items on the sheet (SCH_SCREEN::GetConnections).
export function screenConnections(doc: KDoc) {
  const out: Pt[] = [], seen = new Set<string>();
  for (const it of doc.items.values()) for (const p of connPoints(doc, it)) { const k = r4(p[0]) + "," + r4(p[1]); if (!seen.has(k)) { seen.add(k); out.push(p); } }
  return out;
}
// JUNCTION_HELPERS::PreviewJunctions: where junction dots would appear if the preview lines were committed.
// `points` are the connection points of the other preview items (the symbols, labels and sheets a move carries).
export function previewJunctions(doc: KDoc, lines: PreviewLine[], skip?: Set<string> | null, points?: Pt[] | null) {
  const extra = lines.filter((l) => !same(l.a, l.b)), pts: Pt[] = [], seen = new Set<string>();
  if (!extra.length && !(points && points.length)) return [];
  const conns = screenConnections(doc);
  const push = (p: Pt) => { const k = r4(p[0]) + "," + r4(p[1]); if (!seen.has(k)) { seen.add(k); pts.push(p); } };
  // the connection points by 5 mm cell: each preview line looks only at the cells its box covers
  const connCells = new Map<string, Pt[]>();
  if (extra.length) for (const c of conns) { const k = Math.floor(c[0] / LINE_CELL) + "," + Math.floor(c[1] / LINE_CELL), l = connCells.get(k); if (l) l.push(c); else connCells.set(k, [c]); }
  for (const l of extra) {
    push(l.a); push(l.b);
    const x0 = Math.floor((Math.min(l.a[0], l.b[0]) - 0.01) / LINE_CELL), x1 = Math.floor((Math.max(l.a[0], l.b[0]) + 0.01) / LINE_CELL);
    const y0 = Math.floor((Math.min(l.a[1], l.b[1]) - 0.01) / LINE_CELL), y1 = Math.floor((Math.max(l.a[1], l.b[1]) + 0.01) / LINE_CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (const c of connCells.get(x + "," + y) || []) if (segDist(c, l.a, l.b) <= 1e-3) push(c);
  }
  for (const p of points || []) push(p);
  const ix = pointIndex(doc, skip);
  return pts.filter((p) => analyzePoint(doc, p, false, extra, skip, ix).allows);
}

// A dry-run edit of the sheet: changes are applied to the document as they are made (so the analysis sees
// them) and restore() puts every touched item back, ready for ctx.commit to apply the change set itself.
export function editTxn(doc: KDoc, IU: number) {
  const saved = new Map<string, KItem | null>(), out = new Map<string, KChange>();
  const keep = (id: string, obj: KItem | null) => { if (!saved.has(id)) saved.set(id, obj || null); };
  return {
    add(node: SNode) { const { item, change } = addNode(doc, node); keep(item.id, null); out.set(item.id, change); return item; },
    modify(item: KItem, node: SNode) {
      keep(item.id, item);
      const prev = out.get(item.id); let c = modChange(doc, item, node);
      if (prev && prev.kind === "ADDED") c = Object.assign({}, c, { kind: "ADDED" });
      out.set(item.id, c); K.applyChange(doc, c, IU || 1e4); return doc.items.get(item.id)!;
    },
    remove(item: KItem) {
      keep(item.id, item);
      const prev = out.get(item.id);
      if (prev && prev.kind === "ADDED") out.delete(item.id); else out.set(item.id, removeChange(item));
      doc.items.delete(item.id);
    },
    restore() { for (const [id, obj] of saved) { if (obj) doc.items.set(id, obj); else doc.items.delete(id); } },
    changes() { return Array.from(out.values()); },
    has(id: string) { return out.has(id); },
    isNew(id: string) { const c = out.get(id); return !!(c && c.kind === "ADDED"); },
  };
}
/** An edit transaction (editTxn). */
export type EditTxn = ReturnType<typeof editTxn>;
export const segOf = (it: KItem): Seg | null => { const p = ptsOf(it.node); return p.length === 2 ? [p[0], p[1]] : null; };
// AddJunction: the junction plus BreakSegments at the point (every wire and bus running through it splits).
export function txnAddJunction(t: EditTxn, doc: KDoc, p: Pt) {
  for (const kd of ["wire", "bus"]) for (const it of lineMidsAt(doc, p[0], p[1], kd)) {
    const s = segOf(it); if (!s) continue;
    const a = deep(it.node); setPts(a, [s[0], [r4(p[0]), r4(p[1])]]); t.modify(it, a);
    const tail = lineNode(it.kind, p, s[1]), st = kid(it.node, "stroke"); if (st) replaceKid(tail, deep(st)); t.add(tail);
  }
  return t.add(junctionNode(p));
}
/**
 * SCHEMATIC::CleanUp, limited to the lines `seed` names and the ones they reach: identical lines go,
 * collinear overlapping or touching lines of a layer merge (not across a junction point), junctions that
 * are no longer allowed at `points` go.  The web keeps the rest of the sheet as the user left it.
 */
export function txnCleanUp(t: EditTxn, doc: KDoc, seed: Iterable<string>, points: Pt[] | null) {
  const live = new Set(seed);
  for (const p of points || []) {
    const j = junctionAt(doc, p[0], p[1]);
    if (j && !t.has(j.id) && !explicitJunctionAllowed(doc, p)) t.remove(j);
  }
  for (let changed = true, guard = 0; changed && guard < 200; guard++) {
    changed = false;
    outer: for (const id of Array.from(live)) {
      const A = doc.items.get(id); if (!A || !isNetLine(A.kind)) { live.delete(id); continue; }
      const sa = segOf(A); if (!sa) continue;
      if (same(sa[0], sa[1])) { t.remove(A); live.delete(id); changed = true; break; }
      for (const B of Array.from(doc.items.values())) {
        if (B === A || B.kind !== A.kind) continue;
        const sb = segOf(B); if (!sb) continue;
        if (Math.max(Math.min(sa[0][0], sa[1][0]), Math.min(sb[0][0], sb[1][0])) > Math.min(Math.max(sa[0][0], sa[1][0]), Math.max(sb[0][0], sb[1][0])) + 1e-6) continue;
        if (Math.max(Math.min(sa[0][1], sa[1][1]), Math.min(sb[0][1], sb[1][1])) > Math.min(Math.max(sa[0][1], sa[1][1]), Math.max(sb[0][1], sb[1][1])) + 1e-6) continue;
        const sameStroke = K.serialize(kid(A.node, "stroke") || []) === K.serialize(kid(B.node, "stroke") || []);
        if (!sameStroke) continue;
        // keep the line that was already on the sheet: the new one is the one that goes
        const [keepIt, dropIt] = t.isNew(A.id) && !t.isNew(B.id) ? [B, A] : [A, B];
        if ((same(sa[0], sb[0]) && same(sa[1], sb[1])) || (same(sa[0], sb[1]) && same(sa[1], sb[0]))) { t.remove(dropIt); live.delete(dropIt.id); live.add(keepIt.id); changed = true; break outer; }
        const m = mergeOverlap(sa, sb, (q: Pt) => isJunctionPoint(doc, q) || !!junctionAt(doc, q[0], q[1]));
        if (!m) continue;
        const n = deep(keepIt.node); setPts(n, m); t.remove(dropIt); t.modify(keepIt, n);
        live.delete(dropIt.id); live.add(keepIt.id); changed = true; break outer;
      }
    }
  }
  return live;
}
/**
 * SCHEMATIC::CleanUp over the whole sheet: every junction that is no longer allowed goes (the ones in `keep`, the
 * selection, stay), duplicate junctions and no-connects at one position go, null lines go, identical lines go and
 * every two parallel lines of a layer with the same stroke that overlap or touch (not across a junction) are merged.
 */
export function txnCleanUpAll(t: EditTxn, doc: KDoc, keep?: Set<string> | null) {
  const junctions: KItem[] = [], drop: KItem[] = [], ncs: KItem[] = [];
  for (const it of doc.items.values()) {
    if (it.kind === "junction") { if (!explicitJunctionAllowed(doc, atOf(it.node))) { if (!(keep && keep.has(it.id))) drop.push(it); } else junctions.push(it); }
    else if (it.kind === "no_connect") ncs.push(it);
  }
  for (const it of drop) t.remove(it);
  for (const list of [junctions, ncs]) {
    const at = new Set<string>();
    for (const it of list) { const a = atOf(it.node), k = r4(a[0]) + "," + r4(a[1]); if (at.has(k)) t.remove(it); else at.add(k); }
  }
  const minX = (s: Seg) => Math.min(s[0][0], s[1][0]), maxX = (s: Seg) => Math.max(s[0][0], s[1][0]), minY = (s: Seg) => Math.min(s[0][1], s[1][1]), maxY = (s: Seg) => Math.max(s[0][1], s[1][1]);
  for (let changed = true, guard = 0; changed && guard < 10000; guard++) {
    changed = false;
    const lines: { it: KItem; s: Seg; stroke: string }[] = [];
    for (const it of doc.items.values()) { if (!isNetLine(it.kind)) continue; const s = segOf(it); if (s) lines.push({ it, s, stroke: K.serialize(kid(it.node, "stroke") || []) }); }
    lines.sort((a, b) => minX(a.s) - minX(b.s));
    const gone = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const A = lines[i]; if (gone.has(A.it.id)) continue;
      if (same(A.s[0], A.s[1])) { t.remove(A.it); gone.add(A.it.id); changed = true; continue; }
      const right = maxX(A.s);
      for (let j = i + 1; j < lines.length; j++) {
        const B = lines[j];
        if (minX(B.s) > right + 1e-6) break;                                     // impossible to overlap the remaining lines
        if (Math.max(minY(A.s), minY(B.s)) > Math.min(maxY(A.s), maxY(B.s)) + 1e-6) continue;
        if (gone.has(B.it.id) || B.it.kind !== A.it.kind || B.stroke !== A.stroke) continue;
        const cross = (A.s[1][0] - A.s[0][0]) * (B.s[1][1] - B.s[0][1]) - (A.s[1][1] - A.s[0][1]) * (B.s[1][0] - B.s[0][0]);
        if (Math.abs(cross) > 1e-6 || same(B.s[0], B.s[1])) continue;            // IsParallel
        if ((same(A.s[0], B.s[0]) && same(A.s[1], B.s[1])) || (same(A.s[0], B.s[1]) && same(A.s[1], B.s[0]))) { t.remove(B.it); gone.add(B.it.id); changed = true; continue; }
        const m = mergeOverlap(B.s, A.s, (q: Pt) => isJunctionPoint(doc, q) || !!junctionAt(doc, q[0], q[1]));
        if (!m) continue;
        // KiCad replaces both by a new line; here one of them stays: a selected one, else the one already on the sheet
        const aStays = keep && keep.has(A.it.id) ? true : keep && keep.has(B.it.id) ? false : !(t.isNew(A.it.id) && !t.isNew(B.it.id));
        const [keepIt, dropIt] = aStays ? [A.it, B.it] : [B.it, A.it];
        const n = deep(keepIt.node); setPts(n, m); t.remove(dropIt); t.modify(keepIt, n);
        gone.add(A.it.id); gone.add(B.it.id); changed = true; break;
      }
    }
  }
}
// SCH_EDIT_FRAME::TrimWire: a wire drawn across both pins of a two-pin symbol loses the part between them.
export function txnTrimWire(t: EditTxn, doc: KDoc, a: Pt, b: Pt, only: Set<string> | null) {
  if (same(a, b)) return false;
  for (const it of Array.from(doc.items.values())) {
    if (it.kind !== "wire" || (only && !only.has(it.id))) continue;
    const s = segOf(it); if (!s) continue;
    if (segDist(a, s[0], s[1]) > 1e-3 || segDist(b, s[0], s[1]) > 1e-3) continue;
    if ((same(s[0], a) && same(s[1], b)) || (same(s[0], b) && same(s[1], a))) continue;   // a whole wire stays
    const da = Math.hypot(a[0] - s[0][0], a[1] - s[0][1]), db = Math.hypot(b[0] - s[0][0], b[1] - s[0][1]);
    const [near, far] = da <= db ? [a, b] : [b, a];
    const st = kid(it.node, "stroke");
    if (!same(s[0], near)) { const n = deep(it.node); setPts(n, [s[0], near]); t.modify(it, n); } else t.remove(it);
    if (!same(far, s[1])) { const tail = lineNode("wire", far, s[1]); if (st) replaceKid(tail, deep(st)); t.add(tail); }
    return true;
  }
  return false;
}
/**
 * finishSegments: backtracks merge away, the segments are added, CleanUp merges them with the lines they
 * continue, a wire across both pins of a two-pin symbol is trimmed, and every new end — plus every existing
 * connection point lying on a new segment — gets the junction IsExplicitJunctionNeeded asks for.
 */
export function finishWire(ctx: SchCtx) {
  const w = S.wire; S.wire = null; if (!w) return;
  S.wireEndedAt = Date.now();                                      // the double click that ended it opens no dialog (dom.ts)
  const list = simplifyWireList(w.segs);
  const unfold = S.unfold; S.unfold = null;
  const doc = ctx.doc, held = unfold ? dropUnfold(doc, unfold) : null;
  if (!list.length) { ctx.requestRender(); if (w.quitOnDraw) switchTool(ctx, "select"); return; }
  const t = editTxn(doc, ctx.IU), unfoldIds: string[] = [];
  if (held && unfold!.placed) for (const n of held) unfoldIds.push(t.add(n).id);   // finishSegments: entry and label join the wires' commit
  const conns = w.kind === "polyline" ? [] : screenConnections(doc), newEnds: Pt[] = [], added: string[] = [];
  for (const s of list) {
    newEnds.push(s[0], s[1]);
    for (const c of conns) if (segDist(c, s[0], s[1]) <= 1e-3) newEnds.push(c);
    added.push(t.add(wireNode(w, s[0], s[1])).id);
  }
  try {
    if (w.kind !== "polyline") {
      txnCleanUpAll(t, doc, null);                           // Schematic().CleanUp( &aCommit ): the whole screen
      for (const it of Array.from(doc.items.values())) {
        if (it.kind !== "symbol") continue;
        const pts = connPoints(doc, it); if (pts.length > 2) continue;
        for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) txnTrimWire(t, doc, pts[i], pts[j], null);
      }
      const seen = new Set<string>();
      for (const p of newEnds) {
        const k = r4(p[0]) + "," + r4(p[1]); if (seen.has(k)) continue; seen.add(k);
        if (explicitJunctionNeeded(doc, p)) txnAddJunction(t, doc, p);
      }
    }
  } finally { t.restore(); }
  const changes = t.changes();
  ctx.commit(changes, "Draw Wires");                         // doDrawSegments pushes "Draw Wires" for wires, buses and lines
  // SaveCopyForRepeatItem( m_wires[0] ) + AddCopyForRepeatItem for the rest: Insert repeats the whole wire
  S.lastPlaced = list.map((s) => ({ kind: w.kind, node: wireNode(w, s[0], s[1]) }));
  if (held && unfold!.placed) S.lastPlaced = held.map((n) => ({ kind: n[0] as string, node: deep(n) })).concat(S.lastPlaced);
  ctx.requestRender();
  if (w.quitOnDraw) switchTool(ctx, "select");
}
// Esc while drawing: the segments go; a wire started from a pin by the selection tool also ends its tool.
export function cancelWire(ctx: SchCtx) {
  const w = S.wire; S.wire = null;
  if (S.unfold) dropUnfold(ctx.doc, S.unfold); S.unfold = null;            // doDrawSegments' cleanup(): the entry and label go too
  ctx.requestRender(); if (w && w.quitOnDraw) switchTool(ctx, "select");
}
// The bus unfold's entry and label live on this client only until the wire is finished; take them out of the
// document and hand back their nodes.
export function dropUnfold(doc: KDoc, u: UnfoldJob) {
  const out: SNode[] = [];
  for (const id of [u.entryId, u.labelId]) { const it = doc.items.get(id); if (it) { out.push(deep(it.node)); doc.items.delete(id); } }
  return out;
}
// doDrawSegments' motion handling before the first click: the entry flips towards the cursor (the wire starts
// from its new end) and the label ghost sits on the cursor.
export function unfoldFollow(ctx: SchCtx, w: SchWire, p: Pt) {
  const u = S.unfold!, doc = ctx.doc, en = doc.items.get(u.entryId), lb = doc.items.get(u.labelId); if (!en || !lb) return;
  const sz = kid(en.node, "size"), sx = p[0] - u.origin[0] < 0 ? -1 : 1, sy = p[1] - u.origin[1] < 0 ? -1 : 1;
  if (sz && (Math.sign(num(sz[1])) !== sx || Math.sign(num(sz[2])) !== sy)) {
    sz[1] = r4(Math.abs(num(sz[1])) * sx); sz[2] = r4(Math.abs(num(sz[2])) * sy); K.replaceChange(doc, en);
    const end = [r4(u.origin[0] + num(sz[1])), r4(u.origin[1] + num(sz[2]))];
    w.segs[0][0] = end.slice(); if (twoSegments() && w.segs.length >= 2 && segNull(w.segs[0])) w.segs[1][0] = end.slice();
  }
  setAt(lb.node, r4(p[0]), r4(p[1])); K.replaceChange(doc, lb);
}
// Tool changes made by this module itself (a carried duplicate rides into the place tool, a wire auto-started
// from a pin goes back to select) are not the user activating another tool mid-operation.
export function switchTool(ctx: SchCtx, id: string) { S.internalSwitch = true; try { ctx.setTool(id); } finally { S.internalSwitch = false; } }
