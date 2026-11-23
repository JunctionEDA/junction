// pcb-tools/convert.ts — pads under a point, CONVERT_TOOL's conversions and small item edits, board statistics.
import { zonePriorityPlan } from "./zone-priority";
import type { BoardDoc, NetRef, PadInfo, PcbChange, Pt, SAtom } from "./types";
import { addedChange, removedChange } from "./changes";
import { arcLength, arcPoints } from "./distances";
import { RULE_AREA_LAYERS } from "./draw-modes";
import { boardOutline, chainLoops } from "./drc";
import { bboxOfPts } from "./msgpanel";
import { netNode, netOf } from "./nets";
import { lineNode, polyNode, ruleAreaNode, segmentNode, zoneNode } from "./nodes";
import { netUnder, padCovers, padOnLayer, padsOf } from "./route-geom";
import { K } from "./state";
import * as VM from "../../canvas/variant-model";
import { clone, corners, isList, layerOf, pt, r6, samePt } from "./util";
import { anchorOf, transformChanges } from "./transforms";
import { PlotLog, geomPrims } from "../../fab/plot";
import { inflate as polyInflate, primPolys, union as polyUnion } from "../../fab/poly";
import type { Prim } from "../../fab/prims";

// ---------------------------------------------------------------- pads
/** The pad under (x, y): { item, index, pad } from padsOf, the smallest pad covering the point on any copper layer. */
export function padAt(doc: BoardDoc, x: number, y: number, layer: string | null) {
  let best: { item: KItem; index: number; pad: PadInfo } | null = null;
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint" || !it.bbox || x < it.bbox[0] || x > it.bbox[2] || y < it.bbox[1] || y > it.bbox[3]) continue;
    for (const p of padsOf(it)) if ((!layer || padOnLayer(p, layer)) && padCovers(p, x, y) && (!best || p.w * p.h < best.pad.w * best.pad.h)) best = { item: it, index: p.index, pad: p };
  }
  return best;
}

// ---------------------------------------------------------------- conversions (CONVERT_TOOL) and small edits
export const closedShapeLoop = (it: KItem) => {
  const n = it.node;
  if (it.kind === "gr_rect") { const [x0, y0, x1, y1] = corners(pt(n, "start")!, pt(n, "end")!); return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
  if (it.kind === "gr_poly") return K.ptsOf(n);
  if (it.kind === "gr_circle") { const c = pt(n, "center"), e = pt(n, "end"); const r = Math.hypot(e![0] - c![0], e![1] - c![1]); const pts: Pt[] = []; for (let i = 0; i < 32; i++) pts.push([c![0] + r * Math.cos(i * Math.PI / 16), c![1] + r * Math.sin(i * Math.PI / 16)]); return pts; }
  return null;
};
/**
 * CONVERT_TOOL::SegmentToArc ("Create Arc"): the first selected item gives an arc beside it, the source stays.  A graphic
 * line becomes a graphic arc and a track segment a track arc, both through a midpoint pushed a tenth of the length along
 * the segment's normal; a graphic arc becomes a track arc and a track arc a graphic arc over the same three points.
 */
export function segmentToArcChanges(doc: BoardDoc, ids: string[]): PcbChange[] {
  const src = ids.length ? doc.items.get(ids[0]) : null; if (!src || !["gr_line", "gr_arc", "segment", "arc"].includes(src.kind)) return [];
  const n = src.node, a = pt(n, "start"), b = pt(n, "end"), l = layerOf(n); if (!a || !b) return [];
  // getStartEndPoints + ( B - A ).Perpendicular().Resize( 0.1 * length ) from the segment's centre
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const mid: Pt = len > 0 ? [(a[0] + b[0]) / 2 - (b[1] - a[1]) * 0.1, (a[1] + b[1]) / 2 + (b[0] - a[0]) * 0.1] : [a[0], a[1]];
  const xyz = (k: string, p: Pt): SAtom => [k, r6(p[0]), r6(p[1])];
  if (src.kind === "gr_line") {
    // SetCenter( CalcArcCenter( start, mid, end ) ), SetStart, SetEnd: an EDA_SHAPE arc runs from its start to its end
    // with the angle growing (CalcArcAngles), and the file's mid is the start turned by half that angle (GetArcMid)
    const c3 = K.arcFrom3(a, mid, b) as { x: number; y: number } | null; if (!c3) return [];
    const c: Pt = [c3.x, c3.y];
    const sa = Math.atan2(a[1] - c[1], a[0] - c[0]); let ea = Math.atan2(b[1] - c[1], b[0] - c[0]);
    if (ea === sa) ea = sa + 2 * Math.PI; while (ea < sa) ea += 2 * Math.PI;
    const h = (ea - sa) / 2, rx = a[0] - c[0], ry = a[1] - c[1];
    const m: Pt = [c[0] + rx * Math.cos(h) - ry * Math.sin(h), c[1] + rx * Math.sin(h) + ry * Math.cos(h)];
    const stroke = K.kid(n, "stroke");
    return [addedChange(doc, ["gr_arc", xyz("start", a), xyz("mid", m), xyz("end", b), stroke ? JSON.parse(JSON.stringify(stroke)) : ["stroke", ["width", 0], ["type", "default"]], ["layer", l]])];
  }
  if (src.kind === "gr_arc") {
    const m = pt(n, "mid"); if (!m) return [];
    const w = +((K.kid(K.kid(n, "stroke") || [], "width") || [])[1] || 0);
    return [addedChange(doc, ["arc", xyz("start", a), xyz("mid", m), xyz("end", b), ["width", r6(w)], ["layer", l], netNode(doc, null)])];
  }
  const w = +((K.kid(n, "width") || [])[1] || 0);
  if (src.kind === "segment") {
    const net = netOf(n);
    return [addedChange(doc, ["arc", xyz("start", a), xyz("mid", mid), xyz("end", b), ["width", r6(w)], ["layer", l], netNode(doc, net)], net)];
  }
  const m = pt(n, "mid"); if (!m) return [];
  return [addedChange(doc, ["gr_arc", xyz("start", a), xyz("mid", m), xyz("end", b), ["stroke", ["width", r6(w)], ["type", "solid"]], ["layer", l]])];
}
/** Lines and arcs of the selection chained into closed loops (world points), plus any closed shapes. */
export function selectionLoops(items: Iterable<KItem>) {
  const chains: Pt[][] = [], loops: Pt[][] = [];
  for (const it of items) {
    const n = it.node;
    if (it.kind === "gr_line") { const a = pt(n, "start"), b = pt(n, "end"); if (a && b) chains.push([a, b]); }
    else if (it.kind === "gr_arc") { const a = pt(n, "start"), m = pt(n, "mid"), b = pt(n, "end"); const arc = a && m && b && K.arcFrom3(a, m, b); if (arc) chains.push(arcPoints(arc, a, b)); }
    else if (it.kind === "gr_curve") { const pts = K.bezierPts(K.ptsOf(n)); if (pts.length > 1) chains.push(pts); }
    else { const l = closedShapeLoop(it); if (l) loops.push(l); }
  }
  if (chains.length) loops.push(...chainLoops(chains).loops);
  return loops.map((l) => l.map(([x, y]) => [r6(x), r6(y)]));
}
export function convertChanges(doc: BoardDoc, ids: string[], to: string, extra?: { layer?: string; net?: NetRef | null; keep?: boolean } | null) {
  const items = ids.map((id: string) => doc.items.get(id)).filter(Boolean) as KItem[]; const out: PcbChange[] = []; const layer = items.length ? layerOf(items[0].node, "F.SilkS") : "F.SilkS";
  if (to === "lines") {   // rectangles and polygons into their edges
    for (const it of items) { const loop = closedShapeLoop(it); if (!loop || it.kind === "gr_circle") continue; loop.forEach((p, i) => out.push(addedChange(doc, lineNode(p, loop[(i + 1) % loop.length], layerOf(it.node, layer))))); out.push(removedChange(it)); }
    return out;
  }
  if (to === "tracks") {   // graphic lines and arcs on copper become tracks with the line's width
    for (const it of items) {
      const n = it.node; const l = layerOf(n, layer); if (!/\.Cu$/.test(l) || (it.kind !== "gr_line" && it.kind !== "gr_arc")) continue;
      const w = K.kid(n, "stroke") ? K.num((K.kid(K.kid(n, "stroke")!, "width") || [0, 0.2])[1], 0.2) : 0.2; const a = pt(n, "start"); const net = netUnder(doc, a![0], a![1], l);
      if (it.kind === "gr_line") out.push(addedChange(doc, segmentNode(doc, a!, pt(n, "end")!, w, l, net), net));
      else out.push(addedChange(doc, ["arc", ["start", ...a!.map(r6)], ["mid", ...pt(n, "mid")!.map(r6)], ["end", ...pt(n, "end")!.map(r6)], ["width", r6(w)], ["layer", l], netNode(doc, net)], net));
      out.push(removedChange(it));
    }
    return out;
  }
  const loops = selectionLoops(items); if (!loops.length) return [];
  if (to === "poly") { for (const loop of loops) out.push(addedChange(doc, polyNode(loop, layer))); }
  else if (to === "zone") { const l = /\.Cu$/.test(layer) ? layer : (extra && extra.layer) || "F.Cu"; const net = (extra && extra.net) || { code: 0, name: "" }; for (const loop of loops) out.push(addedChange(doc, zoneNode(doc, loop, l, net), net)); }
  else if (to === "keepout") { for (const loop of loops) out.push(addedChange(doc, ruleAreaNode(loop, /\.Cu$/.test(layer) ? [layer] : RULE_AREA_LAYERS))); }
  else return [];
  if (!(extra && extra.keep)) for (const it of items) if (/^gr_(line|arc|rect|poly|circle|curve)$/.test(it.kind)) out.push(removedChange(it));
  return out;
}
// ---------------------------------------------------------------- CONVERT_TOOL::CreatePolys / CreateLines
// CONVERT_SETTINGS (convert_settings.h): the strategy, the hull's gap and line width, and whether the sources go.  The
// tool keeps one for the session (initUserSettings: centerlines, no gap, no width, delete the originals).
export type ConvertStrategy = "copy" | "centerline" | "hull";
export interface ConvertSettings { strategy: ConvertStrategy; gap: number; lineWidth: number; deleteOriginals: boolean }
export const convertSettings: ConvertSettings = { strategy: "centerline", gap: 0, lineWidth: 0, deleteOriginals: true };
/** CONVERT_SETTINGS_DIALOG ("Conversion Settings") is the editor's: the options it shows, the settings it edits in place, done(OK). */
export type ConvertSettingsDialog = (show: { copy: boolean; centerline: boolean; hull: boolean }, settings: ConvertSettings, done: (ok: boolean) => void) => void;
export const convertDialogs: { settings?: ConvertSettingsDialog } = {};
export function setConvertDialogs(d: { settings?: ConvertSettingsDialog } | null) { convertDialogs.settings = d ? d.settings : undefined; }
/** A polygon vertex, or an arc side (SHAPE_ARC in a SHAPE_LINE_CHAIN) from its start through its mid to its end. */
export type PolyElem = Pt | { arc: [Pt, Pt, Pt] };
export interface ConvOutline { outline: PolyElem[]; holes: PolyElem[][] }
const CHAIN_EPS = 1e-4;                                     // chainingEpsilon: 100 IU
const isArcElem = (e: PolyElem): e is { arc: [Pt, Pt, Pt] } => !Array.isArray(e);
const near = (a: Pt, b: Pt, d: number) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 <= d * d;
/** A (pts ...) list as SHAPE_LINE_CHAIN elements: its (xy) vertices and its (arc) sides. */
function polyElemsOf(n: SNode): PolyElem[] {
  const p = K.kid(n, "pts"); if (!p) return [];
  const out: PolyElem[] = [];
  for (const c of p.slice(1)) {
    if (!isList(c)) continue;
    if (c[0] === "xy") out.push([K.num(c[1]), K.num(c[2])]);
    else if (c[0] === "arc") { const s = pt(c as SNode, "start"), m = pt(c as SNode, "mid"), e = pt(c as SNode, "end"); if (s && m && e) out.push({ arc: [s, m, e] }); }
  }
  return out;
}
/** The chain's points, an arc side flattened (for the polygon operations of the bounding hull). */
function flatElems(els: PolyElem[]): Pt[] {
  const out: Pt[] = [];
  for (const e of els) {
    if (!isArcElem(e)) { out.push(e); continue; }
    const a = K.arcFrom3(e.arc[0], e.arc[1], e.arc[2]);
    out.push(...(a ? arcPoints(a, e.arc[0], e.arc[2]) as Pt[] : [e.arc[0], e.arc[2]]));
  }
  return out;
}
const firstPt = (e: PolyElem): Pt => (isArcElem(e) ? e.arc[0] : e), lastPt = (e: PolyElem): Pt => (isArcElem(e) ? e.arc[2] : e);
/** TransformShapeToPolygon through the plotter's primitives (the item's drawn stroke, fill and text). */
function itemPolys(it: KItem): Pt[][] {
  const prims: Prim[] = [], knock: Prim[] = [], log = new PlotLog();
  for (const g of it.geom || []) { if ((g as { hole?: boolean }).hole) continue; geomPrims(g as unknown as Parameters<typeof geomPrims>[0], prims, knock, log); }
  return prims.flatMap((p) => primPolys(p));
}
const shapeWidth = (n: SNode) => { const st = K.kid(n, "stroke"), w = st ? K.kid(st, "width") : K.kid(n, "width"); return w ? K.num(w[1], 0) : 0; };
const solidFill = (n: SNode) => { const f = K.kid(n, "fill"); const v = f ? K.str(f[1]) : ""; return v === "yes" || v === "solid"; };
/** CONVERT_TOOL::getStartEndPoints: a graphic line, arc or bezier (not with coincident ends), a track, a track arc. */
export function convStartEnd(it: KItem): [Pt, Pt] | null {
  const n = it.node;
  if (it.kind === "gr_curve") { const ps = K.ptsOf(n); if (ps.length < 4 || samePt(ps[0], ps[3])) return null; return [ps[0], ps[3]]; }
  const a = pt(n, "start"), b = pt(n, "end"); if (!a || !b) return null;
  if ((it.kind === "gr_line" || it.kind === "gr_arc") && samePt(a, b)) return null;
  return it.kind === "gr_line" || it.kind === "gr_arc" || it.kind === "segment" || it.kind === "arc" ? [a, b] : null;
}
/** A rounded rectangle's outline (ROUNDRECT::TransformToPolygon), its corners when it has no radius. */
function rectOutline(n: SNode): Pt[] {
  const [x0, y0, x1, y1] = corners(pt(n, "start")!, pt(n, "end")!); const rN = K.kid(n, "radius"); const r = Math.min(rN ? K.num(rN[1], 0) : 0, (x1 - x0) / 2, (y1 - y0) / 2);
  if (!(r > 0)) return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const out: Pt[] = [], seg = Math.max(2, Math.ceil(Math.PI / 2 / (2 * Math.acos(Math.max(-1, 1 - 0.005 / r)))));
  const corner = (cx: number, cy: number, a0: number) => { for (let i = 0; i <= seg; i++) { const a = a0 + (Math.PI / 2) * i / seg; out.push([r6(cx + r * Math.cos(a)), r6(cy + r * Math.sin(a))]); } };
  corner(x1 - r, y0 + r, -Math.PI / 2); corner(x1 - r, y1 - r, 0); corner(x0 + r, y1 - r, Math.PI / 2); corner(x0 + r, y0 + r, Math.PI);
  return out;
}
/** makePolysFromClosedGraphics: closed graphics, zones, texts and barcodes. */
function closedGraphicsPolys(items: KItem[], strategy: ConvertStrategy, used: Set<string>): ConvOutline[] {
  const out: ConvOutline[] = [], hull = strategy === "hull";
  for (const it of items) {
    if (used.has(it.id)) continue;
    const n = it.node;
    if (it.kind === "gr_rect" || it.kind === "gr_circle" || it.kind === "gr_poly") {
      if (it.kind === "gr_circle" && !hull) {   // the whole circle as arcs (SHAPE_ARC of 360 degrees from its left), here its two halves through the top and the bottom
        const c = pt(n, "center")!, e = pt(n, "end")!, R = Math.hypot(e[0] - c[0], e[1] - c[1]);
        const l: Pt = [r6(c[0] - R), c[1]], r: Pt = [r6(c[0] + R), c[1]];
        out.push({ outline: [{ arc: [l, [c[0], r6(c[1] - R)], r] }, { arc: [r, [c[0], r6(c[1] + R)], l] }], holes: [] });
      } else if (!hull) out.push({ outline: it.kind === "gr_rect" ? rectOutline(n) : polyElemsOf(n), holes: [] });   // filled, the line width ignored
      else for (const p of itemPolys(it)) out.push({ outline: p, holes: [] });
      used.add(it.id); continue;
    }
    if (it.kind === "zone") {
      const cs = K.kids(n, "polygon").map((pg) => (hull ? flatElems(polyElemsOf(pg)) : polyElemsOf(pg))).filter((p) => p.length > 2 || p.some(isArcElem));
      if (cs.length) out.push({ outline: cs[0], holes: cs.slice(1) });
      used.add(it.id); continue;
    }
    if (it.kind === "gr_text" || it.kind === "property" || it.kind === "barcode") { for (const p of itemPolys(it)) out.push({ outline: p, holes: [] }); used.add(it.id); }
  }
  return out;
}
/** makePolysFromOpenGraphics: open graphics, tracks and vias as their copper (the bounding hull). */
function openGraphicsPolys(items: KItem[], used: Set<string>): Pt[][] {
  const out: Pt[][] = [];
  for (const it of items) {
    if (used.has(it.id)) continue;
    if (/^gr_(line|arc|curve)$/.test(it.kind) || it.kind === "segment" || it.kind === "arc" || it.kind === "via") { out.push(...itemPolys(it)); used.add(it.id); }
  }
  return out;
}
/** makePolysFromChainedSegs: lines, arcs, beziers and tracks chained end to end (100 nm) into closed outlines. */
function chainedPolys(items: KItem[], used: Set<string>): ConvOutline[] {
  const keys: Pt[] = [], conns = new Map<number, [number, KItem][]>(), keyOf = new Map<string, number>();
  const find = (p: Pt) => { for (let i = 0; i < keys.length; i++) if (samePt(keys[i], p)) return i; for (let i = 0; i < keys.length; i++) if (near(p, keys[i], CHAIN_EPS)) return i; keys.push(p); return keys.length - 1; };
  const toCheck: KItem[] = [];
  for (const it of items) {
    const se = convStartEnd(it); if (!se) continue;
    toCheck.push(it);
    const ka = find(se[0]), kb = find(se[1]);
    (conns.get(ka) || conns.set(ka, []).get(ka)!).push([0, it]); (conns.get(kb) || conns.set(kb, []).get(kb)!).push([1, it]);
    keyOf.set(it.id + ":0", ka); keyOf.set(it.id + ":1", kb);
  }
  const out: ConvOutline[] = [];
  while (toCheck.length) {
    const cand = toCheck.shift()!; if (used.has(cand.id)) continue;
    const outline: PolyElem[] = [], inserted: string[] = [];
    const put = (e: PolyElem, right: boolean) => {
      if (right) { if (!isArcElem(e) && outline.length && samePt(lastPt(outline[outline.length - 1]), e)) return; outline.push(e); }   // Append drops a repeated point
      else outline.unshift(e);
    };
    const insert = (it: KItem, anchor: Pt, right: boolean) => {
      const n = it.node;
      if (it.kind === "gr_arc" || it.kind === "arc") {
        const s = pt(n, "start")!, m = pt(n, "mid")!, e = pt(n, "end")!;
        put({ arc: samePt(anchor, s) ? [s, m, e] : [e, m, s] }, right);
      } else if (it.kind === "gr_curve") {
        const ps = K.bezierPts(K.ptsOf(n)) as Pt[], seq = samePt(anchor, K.ptsOf(n)[0]) ? ps : ps.slice().reverse();
        for (const q of seq) put(q, right);   // Append each, or Insert( 0 ) each
      } else { const se = convStartEnd(it)!; put(samePt(anchor, se[0]) ? se[1] : se[0], right); }
      inserted.push(it.id);
    };
    const process = (it: KItem, anchor: number, right: boolean) => {
      if (used.has(it.id)) return;
      used.add(it.id);
      const se = convStartEnd(it)!;
      insert(it, anchor === 0 ? se[0] : se[1], right);
      const next = 1 - anchor;
      for (const [a2, other] of conns.get(keyOf.get(it.id + ":" + next)!) || []) { if (other === it) continue; process(other, a2, right); }
    };
    const se = convStartEnd(cand)!;
    if (cand.kind !== "gr_arc" && cand.kind !== "arc") insert(cand, se[0], true);
    process(cand, 1, true);
    const left = (conns.get(keyOf.get(cand.id + ":0")!) || []).find(([, o]) => o !== cand);
    if (left) process(left[1], left[0], false);
    const count = outline.reduce((c, e) => c + (isArcElem(e) ? 3 : 1), 0);
    if (count < 3 || !outline.length || !near(firstPt(outline[0]), lastPt(outline[outline.length - 1]), CHAIN_EPS)) { for (const id of inserted) used.delete(id); continue; }
    // SetClosed( true ): mergeFirstLastPointIfNeeded drops the repeated closing point (the vertex when an arc ends there)
    const f = outline[0], l = outline[outline.length - 1];
    if (outline.length > 1 && !isArcElem(l) && samePt(firstPt(f), l)) outline.pop();
    else if (outline.length > 1 && isArcElem(l) && !isArcElem(f) && samePt(f, l.arc[2])) outline.shift();
    out.push({ outline, holes: [] });
  }
  return out;
}
/** Union output (paths) as outlines with the holes that sit inside them. */
function outlinesOf(paths: Pt[][]): ConvOutline[] {
  const area = (p: Pt[]) => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]; return a / 2; };
  const total = paths.reduce((s, p) => s + area(p), 0), outer = (p: Pt[]) => Math.sign(area(p)) === Math.sign(total || 1);
  const inside = (q: Pt, p: Pt[]) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) if ((p[i][1] > q[1]) !== (p[j][1] > q[1]) && q[0] < (p[j][0] - p[i][0]) * (q[1] - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) c = !c; return c; };
  const outs: ConvOutline[] = paths.filter(outer).map((p) => ({ outline: p.map(([x, y]) => [r6(x), r6(y)] as Pt), holes: [] }));
  for (const h of paths.filter((p) => !outer(p))) { const o = outs.find((x) => inside(h[0], x.outline as Pt[])); if (o) o.holes.push(h.map(([x, y]) => [r6(x), r6(y)] as Pt)); }
  return outs;
}
/**
 * CONVERT_TOOL::CreatePolys' getPolys: the outlines a strategy makes of the items, and the items it used (SKIP_STRUCT),
 * or null when there is nothing.  The bounding hull merges everything (Simplify) and grows it by the gap, round.
 */
export function convertPolys(items: KItem[], strategy: ConvertStrategy, gap: number): { outlines: ConvOutline[]; used: Set<string> } | null {
  const used = new Set<string>();
  let outlines = closedGraphicsPolys(items, strategy, used);
  if (strategy === "hull") {
    const paths = outlines.flatMap((o) => [o.outline, ...o.holes].map(flatElems)).concat(openGraphicsPolys(items, used));
    let merged = polyUnion(paths.filter((p) => p.length > 2) as [number, number][][]);
    if (gap) merged = polyInflate(merged, gap);
    outlines = outlinesOf(merged);
  } else outlines = outlines.concat(chainedPolys(items, used));
  outlines = outlines.filter((o) => o.outline.length);
  return outlines.length ? { outlines, used } : null;
}
const ptsNode = (els: PolyElem[]): SNode => ["pts", ...els.map((e) => (isArcElem(e) ? ["arc", ["start", r6(e.arc[0][0]), r6(e.arc[0][1])], ["mid", r6(e.arc[1][0]), r6(e.arc[1][1])], ["end", r6(e.arc[2][0]), r6(e.arc[2][1])]] : ["xy", r6(e[0]), r6(e[1])]))];
/** The graphic polygon CreatePolys adds: the first outline, a solid stroke, filled for centerlines, on the active layer. */
export function convertPolyNode(o: ConvOutline, width: number, filled: boolean, layer: string): SNode {
  return ["gr_poly", ptsNode(o.outline), ["stroke", ["width", r6(width)], ["type", "solid"]], ["fill", filled ? "yes" : "no"], ["layer", layer]];
}
/** A zone or rule area from the dialog's settings (ZONE_SETTINGS::ExportSetting) on an outline and its holes. */
export function convertZoneNode(template: SNode, o: ConvOutline): SNode {
  const n = clone(template);
  let at = -1; for (let i = n.length - 1; i > 0; i--) if (isList(n[i]) && ((n[i] as SNode)[0] === "polygon" || (n[i] as SNode)[0] === "filled_polygon")) { n.splice(i, 1); at = i; }
  const polys: SNode[] = [["polygon", ptsNode(o.outline)], ...o.holes.map((h): SNode => ["polygon", ptsNode(h)])];
  if (at < 0) at = n.length; n.splice(at, 0, ...polys);
  const u = K.kid(n, "uuid"); if (u) u[1] = K.newUuid();
  return n;
}
/** COPY_LINEWIDTH: the stroke width of the top-left item with a line stroke (by BOARD_ITEM::GetPosition). */
export function topLeftStrokeWidth(items: KItem[]): number | null {
  let best: KItem | null = null, bp: Pt = [0, 0];
  for (const it of items) {
    if (!/^gr_(line|rect|circle|arc|poly|curve|text_box)$/.test(it.kind)) continue;   // HasLineStroke
    const p = anchorOf(it);
    if (!best || p[0] < bp[0] || (p[0] === bp[0] && p[1] < bp[1])) { best = it; bp = p; }
  }
  return best ? shapeWidth(best.node) : null;
}
/**
 * CONVERT_TOOL::CreateLines (Create Lines / Create Tracks): every selected rectangle (rounded), polygon or zone outline
 * (holes too) becomes lines on the target layer - tracks for Create Tracks on the board, keeping the source's net - in
 * the source's width (GetBoardItemWidth) or the new item's default; a graphic line or arc becomes a track or track arc.
 * The sides go first, then the arc sides.
 */
export function createLinesChanges(doc: BoardDoc, items: KItem[], layer: string, tracks: boolean, deleteOriginals: boolean): PcbChange[] {
  const out: PcbChange[] = [];
  const lineOf = (a: Pt, b: Pt, w: number | null, net: NetRef | null): SNode => tracks
    ? segmentNode(doc, a, b, w && w > 0 ? w : 0.2, layer, net)
    : ["gr_line", ["start", r6(a[0]), r6(a[1])], ["end", r6(b[0]), r6(b[1])], ["stroke", ["width", r6(w && w > 0 ? w : 0.1)], ["type", "default"]], ["layer", layer]];
  const arcOf = (s: Pt, m: Pt, e: Pt, w: number | null, net: NetRef | null): SNode => tracks
    ? ["arc", ["start", r6(s[0]), r6(s[1])], ["mid", r6(m[0]), r6(m[1])], ["end", r6(e[0]), r6(e[1])], ["width", r6(w && w > 0 ? w : 0.2)], ["layer", layer], netNode(doc, net)]
    : ["gr_arc", ["start", r6(s[0]), r6(s[1])], ["mid", r6(m[0]), r6(m[1])], ["end", r6(e[0]), r6(e[1])], ["stroke", ["width", r6(w && w > 0 ? w : 0.1)], ["type", "default"]], ["layer", layer]];
  const chain = (els: PolyElem[], w: number | null, net: NetRef | null) => {
    const segs: [Pt, Pt][] = [], arcs: [Pt, Pt, Pt][] = [];
    for (let i = 0; i < els.length; i++) {
      const e = els[i], nx = els[(i + 1) % els.length];
      if (isArcElem(e)) { arcs.push(e.arc); if (!samePt(e.arc[2], firstPt(nx))) segs.push([e.arc[2], firstPt(nx)]); }
      else segs.push([e, firstPt(nx)]);
    }
    for (const [a, b] of segs) if (!samePt(a, b)) out.push(addedChange(doc, lineOf(a, b, w, net), tracks ? net : undefined));
    for (const [s, m, e] of arcs) if (!samePt(s, e)) out.push(addedChange(doc, arcOf(s, m, e, w, net), tracks ? net : undefined));
  };
  for (const it of items) {
    const n = it.node, net = K.kid(n, "net") ? netOf(n) : null;
    // handleGraphicSeg: a graphic line or arc becomes a track (arc) on the target layer in its width
    if (it.kind === "gr_line" || it.kind === "gr_arc") {
      const a = pt(n, "start")!, b = pt(n, "end")!, w = shapeWidth(n);
      out.push(addedChange(doc, it.kind === "gr_line" ? segmentNode(doc, a, b, w, layer, net)
        : ["arc", ["start", r6(a[0]), r6(a[1])], ["mid", ...pt(n, "mid")!.map(r6)], ["end", r6(b[0]), r6(b[1])], ["width", r6(w)], ["layer", layer], netNode(doc, net)], net));
      continue;
    }
    // GetBoardItemWidth: a shape's width unless it is solid filled; none for a zone
    const w = /^gr_/.test(it.kind) && shapeWidth(n) && !solidFill(n) ? shapeWidth(n) : null;
    if (it.kind === "gr_rect") chain(rectOutline(n), w, net);
    else if (it.kind === "gr_poly") chain(polyElemsOf(n), w, net);
    else if (it.kind === "zone") for (const pg of K.kids(n, "polygon")) chain(polyElemsOf(pg), null, net);
  }
  if (deleteOriginals) for (const it of items) out.push(removedChange(it));
  return out;
}
export function justifyChanges(doc: BoardDoc, ids: Iterable<string>, how: string) {
  return transformChanges(doc, ids, (n, it: KItem) => {
    const t = it.kind === "dimension" ? K.kid(n, "gr_text") : (it.kind === "gr_text" || it.kind === "gr_text_box") ? n : null; if (!t) return false;
    let eff = K.kid(t, "effects"); if (!eff) { eff = ["effects"]; t.push(eff); } let j = K.kid(eff, "justify"); const rest = (j ? j.slice(1) : []).filter((x) => x !== "left" && x !== "right");
    const toks = (how === "center" ? [] as SAtom[] : [how] as SAtom[]).concat(rest);
    if (j) { if (toks.length) j.splice(1, j.length - 1, ...toks); else eff.splice(eff.indexOf(j), 1); } else if (toks.length) eff.push(["justify", ...toks]);
  });
}
/** BOARD_EDITOR_CONTROL::ZonePriority*: the one selected zone's new priority and those of the zones displaced with it (zonePriorityPlan). */
export function zonePriorityChanges(doc: BoardDoc, ids: Iterable<string>, how: string) {
  const plan = zonePriorityPlan(doc, ids, how); if (!plan) return [];
  return transformChanges(doc, plan.keys(), (n, it: KItem) => {
    const want = plan.get(it.id)!; const p = K.kid(n, "priority"); if ((p ? K.num(p[1]) : 0) === want) return false;
    if (want) { if (p) p[1] = want; else n.splice(n.indexOf((K.kid(n, "connect_pads") || K.kid(n, "min_thickness"))!), 0, ["priority", want]); } else if (p) n.splice(n.indexOf(p), 1);
  });
}
/** EDIT_TOOL::ToggleFootprintAttribute: the flag goes on for every selected footprint when any of them lacks it (as
 *  the current variant shows it), else off for all.  With a current variant (the toolbar's) the footprint's
 *  (variant …) takes the flag (created from the footprint's own flags, FOOTPRINT::AddVariant), not its (attr …). */
export function footprintAttrChanges(doc: BoardDoc, ids: Iterable<string>, flag: string, variant?: string) {
  const list = [...ids];
  const v = variant !== undefined ? variant : String(((globalThis as unknown as { CollabEditor?: { currentVariant?: string } }).CollabEditor || {}).currentVariant || "");
  const key = flag as keyof VM.FpFlags;
  let on = false;
  for (const id of list) { const it = doc.items.get(id); if (it && it.kind === "footprint" && !VM.footprintFlagsForVariant(it.node, v)[key]) { on = true; break; } }
  return transformChanges(doc, list, (n, it: KItem) => {
    if (it.kind !== "footprint") return false;
    if (v && !VM.isDefaultVariant(v)) { const out = VM.setFootprintVariant(n, v, { flags: { [key]: on } }); n.splice(0, n.length, ...out); return; }
    let a = K.kid(n, "attr"); const toks = a ? a.slice(1).map(K.str) : []; const i = toks.indexOf(flag);
    if (on === (i >= 0)) return;
    if (i >= 0) toks.splice(i, 1); else toks.push(flag);
    // the writer's token order (pcb_io_kicad_sexpr.cpp format footprint (attr …))
    const ORDER = ["smd", "through_hole", "board_only", "exclude_from_pos_files", "exclude_from_bom", "exclude_from_sim", "allow_missing_courtyard", "dnp", "allow_soldermask_bridges"];
    toks.sort((x, y) => { const a1 = ORDER.indexOf(x), b1 = ORDER.indexOf(y); return (a1 < 0 ? 99 : a1) - (b1 < 0 ? 99 : b1); });
    if (!toks.length) { n.splice(n.indexOf(a!), 1); return; } if (a) a.splice(1, a.length - 1, ...toks); else { const before = n.find((c) => isList(c) && /^(fp_|pad|model|embedded_fonts)/.test(c[0] as string)); n.splice(before ? n.indexOf(before) : n.length, 0, ["attr", ...toks]); }
  });
}
/** Board statistics (DIALOG_BOARD_STATISTICS): footprint, pad, via and track counts, board size and outline area. */
export function boardStatistics(doc: BoardDoc) {
  const st = { footprints: { total: 0, front: 0, back: 0, smd: 0, tht: 0, other: 0 }, pads: { total: 0, smd: 0, tht: 0, npth: 0, connect: 0 }, vias: { total: 0, through: 0, blind: 0, micro: 0 }, tracks: { count: 0, length: 0 }, zones: 0, drills: 0, width: 0, height: 0, area: 0 };
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") { st.footprints.total++; if (it.layer === "B.Cu") st.footprints.back++; else st.footprints.front++; const a = K.kid(it.node, "attr"); const toks = a ? a.slice(1).map(K.str) : []; if (toks.includes("smd")) st.footprints.smd++; else if (toks.includes("through_hole")) st.footprints.tht++; else st.footprints.other++;
      for (const p of K.kids(it.node, "pad")) { st.pads.total++; const t = K.str(p[2]); if (t === "smd") st.pads.smd++; else if (t === "thru_hole") { st.pads.tht++; st.drills++; } else if (t === "np_thru_hole") { st.pads.npth++; st.drills++; } else st.pads.connect++; } }
    else if (it.kind === "via") { st.vias.total++; st.drills++; if (it.node.includes("micro")) st.vias.micro++; else if (it.node.includes("blind")) st.vias.blind++; else st.vias.through++; }
    else if (it.kind === "segment") { const a = pt(it.node, "start"), b = pt(it.node, "end"); st.tracks.count++; if (a && b) st.tracks.length += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    else if (it.kind === "arc") { const a = pt(it.node, "start"), m = pt(it.node, "mid"), b = pt(it.node, "end"); const arc = a && m && b && K.arcFrom3(a, m, b); st.tracks.count++; if (arc) st.tracks.length += arcLength(arc); }
    else if (it.kind === "zone" && !K.kid(it.node, "keepout")) st.zones++;
  }
  st.tracks.length = r6(st.tracks.length);
  const ol = boardOutline(doc); const b = ol.outline ? bboxOfPts(ol.outline) : doc.bbox;
  if (b) { st.width = r6(b[2] - b[0]); st.height = r6(b[3] - b[1]); } st.area = r6(ol.outline ? ol.area : (b ? (b[2] - b[0]) * (b[3] - b[1]) : 0));
  return st;
}
