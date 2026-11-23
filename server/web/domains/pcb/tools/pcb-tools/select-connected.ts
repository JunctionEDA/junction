// pcb-tools/select-connected.ts — PCB_SELECTION_TOOL's connection walks (pcbnew/tools/pcb_selection_tool.cpp):
// itemPassesFilter, selectAllConnectedTracks with its stop conditions, selectAllConnectedShapes, expandConnection's
// stages, selectConnections (the copper that joins only a given set of footprints), SelectAllItemsOnNet, the
// footprints at the far end of the ratsnest (selectUnconnected / grabUnconnected) and unrouteSelected's set.
import type { BoardDoc, Netlist, Pt } from "./types";
import { padCopperLayers, viaLayers } from "./distances";
import { groupMembers, isLocked, parentOf } from "./groups";
import { netOf } from "./nets";
import { padsOf } from "./route-geom";
import { K } from "./state";
import { layerOf, pt } from "./util";

/** The Selection Filter pane's boxes (PCB_SELECTION_FILTER_OPTIONS): a category is on unless it is false. */
export type SelFilter = Record<string, boolean | undefined>;
/** A pad on its own in a selection: "footprintId#padIndex". */
export const padKey = (fpId: string, index: number) => `${fpId}#${index}`;
export const isPadKey = (id: string) => typeof id === "string" && id.indexOf("#") > 0;
const SHAPE_KINDS = new Set(["gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_curve", "gr_bbox", "gr_ellipse", "gr_ellipse_arc"]);
const TEXT_KINDS = new Set(["gr_text", "gr_text_box", "table", "property", "fp_text"]);

/** The Selection Filter category an item answers to (the switch in itemPassesFilter); a pad is "pads". */
export function filterCategory(doc: BoardDoc, it: KItem, pad?: boolean): string {
  if (pad) return "pads";
  let k = it.kind;
  if (k === "generated") {   // a generator answers as its first member does (an empty one is "other")
    const first = groupMembers(it.node).map((id) => doc.items.get(id)).find(Boolean);
    if (!first) return "other"; k = first.kind; it = first;
  }
  if (k === "footprint") return "footprints";
  if (k === "pad") return "pads";
  if (k === "segment" || k === "arc") return "tracks";
  if (k === "via") return "vias";
  if (k === "zone") return K.kid(it.node, "keepout") ? "keepouts" : "zones";
  if (SHAPE_KINDS.has(k) || k === "target" || k === "image") return "graphics";
  if (TEXT_KINDS.has(k)) return "text";
  if (k === "dimension") return "dimensions";
  if (k === "point") return "points";
  if (k === "grid_item") return "gridItems";
  return "other";
}
/**
 * PCB_SELECTION_TOOL::itemPassesFilter.  "Locked items" off rejects an item that is locked or whose parent footprint
 * is (a pad, a field), except a single pad picked by a click (aMultiSelect false); then the item's category decides.
 * `rejected` collects the categories that turned the item away (HighlightSelectionFilter flashes them).
 */
export function itemPassesFilter(doc: BoardDoc, f: SelFilter | null | undefined, it: KItem, opts?: { pad?: boolean; child?: boolean; multi?: boolean; rejected?: Set<string> } | null): boolean {
  f = f || {}; opts = opts || {};
  const child = !!opts.pad || !!opts.child;   // `it` is the parent footprint of the pad / field being asked about
  if (f.lockedItems === false && isLocked(it.node)) {
    if (opts.pad && !opts.multi) { /* allow a single pad to be selected */ }
    else { if (opts.rejected) opts.rejected.add("lockedItems"); return false; }
  }
  const cat = child && !opts.pad ? "text" : filterCategory(doc, it, opts.pad);
  if (f[cat] === false) { if (opts.rejected && cat !== "text") opts.rejected.add(cat); return false; }
  return true;
}

// ---------------------------------------------------------------- selectAllConnectedTracks
export type StopCondition = "segment" | "junction" | "pad" | "never";
const nm = (v: number) => Math.round(v * 1e6);
const pk = (p: Pt) => nm(p[0]) + "," + nm(p[1]);
interface WTrack { id: string; it: KItem; a: Pt; b: Pt; layer: string }
interface WVia { id: string; it: KItem; at: Pt; layers: Set<string>; r: number }
interface WPad { key: string; fp: KItem; at: Pt; layers: Set<string> }
interface WShape { id: string; it: KItem; pts: Pt[]; layer: string }
const isCu = (l: string) => /\.Cu$/.test(l);
const solidFill = (n: SNode) => { const f = K.kid(n, "fill"); const v = f ? K.str(f[1]) : ""; return v === "yes" || v === "solid"; };
/** PCB_SHAPE::GetConnectionPoints. */
export function shapeConnectionPoints(it: KItem): Pt[] {
  const n = it.node, k = it.kind;
  if (solidFill(n) && it.bbox && k !== "gr_line" && k !== "gr_arc" && k !== "gr_curve") return [[(it.bbox[0] + it.bbox[2]) / 2, (it.bbox[1] + it.bbox[3]) / 2]];
  const a = pt(n, "start"), b = pt(n, "end");
  if (k === "gr_circle") { const c = pt(n, "center"); if (!c || !b) return []; const r = Math.hypot(b[0] - c[0], b[1] - c[1]); return [[c[0], c[1] - r], [c[0] + r, c[1]], [c[0], c[1] + r], [c[0] - r, c[1]]]; }
  if (k === "gr_arc") return [pt(n, "mid"), a, b].filter(Boolean) as Pt[];
  if (k === "gr_line") return [a, b].filter(Boolean) as Pt[];
  if (k === "gr_curve") { const P = K.ptsOf(n) as Pt[]; return P.length ? [P[0], P[P.length - 1]] : []; }
  if (k === "gr_poly") return (K.ptsOf(n) as Pt[]).map((p) => [p[0], p[1]]);
  if (k === "gr_rect" && a && b) return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
  return [];
}
/** PCB_SHAPE's start and end as selectAllConnectedShapes searches from them (a polyline: its first and last corner). */
function shapeEnds(it: KItem): Pt[] {
  if (it.kind === "gr_poly" || it.kind === "gr_curve") { const P = K.ptsOf(it.node) as Pt[]; return P.length ? [P[0], P[P.length - 1]] : []; }
  return [pt(it.node, "start"), pt(it.node, "end")].filter(Boolean) as Pt[];
}
/** The connected items of the board as selectAllConnectedTracks maps them by position. */
function connectionMaps(doc: BoardDoc) {
  const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const trackMap = new Map<string, WTrack[]>(), viaMap = new Map<string, WVia[]>(), padMap = new Map<string, WPad>(), shapeMap = new Map<string, WShape[]>();
  const tracks = new Map<string, WTrack>(), vias = new Map<string, WVia>(), pads = new Map<string, WPad>(), shapes = new Map<string, WShape>();
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
  for (const it of doc.items.values()) {
    const n = it.node;
    if (it.kind === "segment" || it.kind === "arc") {
      const a = pt(n, "start"), b = pt(n, "end"); if (!a || !b) continue;
      const t: WTrack = { id: it.id, it, a, b, layer: layerOf(n) }; tracks.set(it.id, t); push(trackMap, pk(a), t); push(trackMap, pk(b), t);
    } else if (it.kind === "via") {
      const at = pt(n, "at"); if (!at) continue; const sz = K.kid(n, "size");
      const v: WVia = { id: it.id, it, at, layers: viaLayers(n, copper), r: (sz ? K.num(sz[1], 0.8) : 0.8) / 2 }; vias.set(it.id, v); push(viaMap, pk(at), v);
    } else if (it.kind === "footprint") {
      for (const p of padsOf(it)) {
        const layers = padCopperLayers(p, copper); if (!layers.size) continue;
        const w: WPad = { key: padKey(it.id, p.index), fp: it, at: [p.x, p.y], layers }; pads.set(w.key, w); padMap.set(pk(w.at), w);
      }
    } else if (SHAPE_KINDS.has(it.kind) && isCu(layerOf(n, ""))) {
      const s: WShape = { id: it.id, it, pts: shapeConnectionPoints(it), layer: layerOf(n) }; shapes.set(it.id, s); for (const p of s.pts) push(shapeMap, pk(p), s);
    }
  }
  return { trackMap, viaMap, padMap, shapeMap, tracks, vias, pads, shapes };
}
export interface ConnectOpts {
  /** itemPassesFilter( item, true ) for a track, via or copper shape (by its item) or a pad (by its footprint, pad true). */
  passes?: (it: KItem, pad?: boolean) => boolean;
  /** itemIsSelectableAsConnected: false keeps the walk from selecting outside an entered group. */
  inScope?: (it: KItem) => boolean;
}
/**
 * PCB_SELECTION_TOOL::selectAllConnectedTracks: from the start items (item ids, pads as "footprintId#index") push out
 * along tracks, vias and copper shapes that meet end to end, adding what is reached to `selected`.  STOP_AT_JUNCTION
 * ends a branch where more than two tracks meet, at a via or at a pad that was not a start; STOP_AT_PAD only at such a
 * pad; STOP_NEVER walks the whole connection; STOP_AT_SEGMENT takes one step.
 */
export function selectAllConnectedTracks(doc: BoardDoc, starts: string[], stop: StopCondition, selected: Set<string>, opts?: ConnectOpts | null): void {
  const passes = (opts && opts.passes) || (() => true), inScope = (opts && opts.inScope) || (() => true);
  const M = connectionMaps(doc), visited = new Set<string>(), startPads = new Set<string>();
  for (const id of starts) {
    if (M.pads.has(id)) startPads.add(id);
    const t = M.tracks.get(id) || M.vias.get(id); if (t && passes(t.it) && inScope(t.it)) selected.add(id);
  }
  type Active = { p: Pt; layers: Set<string> };
  const cuOf = (layers: Set<string>) => { const o = new Set<string>(); for (const l of layers) if (isCu(l)) o.add(l); return o; };
  const shares = (a: Set<string>, b: Set<string>) => { for (const l of a) if (b.has(l)) return true; return false; };
  for (const id of starts) {
    if (visited.has(id)) continue;
    const active: Active[] = [];
    const tr = M.tracks.get(id), vi = M.vias.get(id), pd = M.pads.get(id), sh = M.shapes.get(id);
    if (tr) { active.push({ p: tr.a, layers: new Set([tr.layer]) }, { p: tr.b, layers: new Set([tr.layer]) }); }
    else if (vi) active.push({ p: vi.at, layers: vi.layers });
    else if (pd) active.push({ p: pd.at, layers: pd.layers });
    else if (sh) for (const p of sh.pts) active.push({ p, layers: new Set([sh.layer]) });
    else continue;
    let expand = true, failSafe = 0;
    while (expand && failSafe++ < 100000) {
      expand = false;
      for (let i = active.length - 1; i >= 0; --i) {
        const p = active[i].p, cu = cuOf(active[i].layers), key = pk(p);
        let hitVia: WVia | null = null;
        const better = (c: WVia) => !hitVia || (visited.has(hitVia.id) && !visited.has(c.id));   // an unvisited via first: a stack is walked hop by hop
        const settled = () => !!hitVia && !visited.has(hitVia.id);
        for (const v of M.viaMap.get(key) || []) { if (shares(v.layers, cu) && better(v)) hitVia = v; if (settled()) break; }
        if (!hitVia) {   // an off-centre via connection
          for (const [, list] of M.viaMap) {
            for (const v of list) {
              if (!shares(v.layers, cu) || !better(v)) continue;
              if ((p[0] - v.at[0]) ** 2 + (p[1] - v.at[1]) ** 2 <= v.r * v.r) hitVia = v;
              if (settled()) break;
            }
            if (hitVia) break;
          }
        }
        const pad = M.padMap.get(key) || null;
        const gotVia = !!hitVia, gotPad = !!pad && shares(pad.layers, cu), gotNonStartPad = gotPad && !startPads.has(pad!.key);
        if (gotPad && !passes(pad!.fp, true)) { active.splice(i, 1); continue; }
        if (gotVia && !passes(hitVia!.it)) { active.splice(i, 1); continue; }
        const here = M.trackMap.get(key) || [];
        if (stop === "junction") {
          let n = 0; for (const t of here) if (pk(t.a) !== pk(t.b) && cu.has(t.layer)) n++;
          if (n > 2 || gotVia || gotNonStartPad) { active.splice(i, 1); continue; }
        } else if (stop === "pad") {
          if (gotNonStartPad) { active.splice(i, 1); continue; }
        }
        if (gotPad && !visited.has(pad!.key)) { visited.add(pad!.key); active.push({ p: pad!.at, layers: pad!.layers }); expand = true; }
        for (const t of here) {
          if (!cu.has(t.layer) || !passes(t.it)) continue;
          if (!selected.has(t.id) && inScope(t.it)) selected.add(t.id);
          if (!visited.has(t.id)) {
            visited.add(t.id);
            active.push({ p: pk(t.a) === key ? t.b : t.a, layers: new Set([t.layer]) });
            if (stop !== "segment") expand = true;
          }
        }
        for (const s of M.shapeMap.get(key) || []) {
          if (!cu.has(s.layer) || !passes(s.it)) continue;
          if (!selected.has(s.id) && inScope(s.it)) selected.add(s.id);
          if (!visited.has(s.id)) {
            visited.add(s.id);
            for (const q of s.pts) if (pk(q) !== key) active.push({ p: q, layers: new Set([s.layer]) });
            if (stop !== "segment") expand = true;
          }
        }
        if (hitVia) {
          const v: WVia = hitVia;
          if (!selected.has(v.id) && inScope(v.it)) selected.add(v.id);
          if (!visited.has(v.id)) {
            visited.add(v.id);
            // track ends that lie inside the via's pad on a layer the via spans
            for (const t of M.tracks.values()) {
              if (!v.layers.has(t.layer)) continue;
              for (const q of [t.a, t.b]) if ((q[0] - v.at[0]) ** 2 + (q[1] - v.at[1]) ** 2 <= v.r * v.r) active.push({ p: q, layers: v.layers });
            }
            active.push({ p: v.at, layers: v.layers });   // re-open this position so the next hop of a stack is found
            if (stop !== "segment") expand = true;
          }
        }
        active.splice(i, 1);
      }
    }
  }
  // generated members (a tuning pattern's meanders) are promoted to their generator
  for (const id of Array.from(selected)) {
    const par = parentOf(doc, id); if (!par || par.kind !== "generated") continue;
    selected.delete(id); selected.add(par.id); for (const m of groupMembers(par.node)) if (doc.items.has(m)) selected.add(m);
  }
}

// ---------------------------------------------------------------- selectAllConnectedShapes
/** isExpandableGraphicShape: an open graphic (segment, arc, bezier, open polygon) off the copper layers. */
export function isExpandableGraphicShape(it: KItem): boolean {
  if (isCu(layerOf(it.node, ""))) return false;
  if (it.kind === "gr_line" || it.kind === "gr_arc" || it.kind === "gr_curve") return true;
  // (a POLY counts only while it is open; a gr_poly read from a board file is a closed outline)
  return false;
}
/**
 * selectAllConnectedShapes: from the start shapes, every expandable graphic shape that the collector finds at a
 * shape's start or end (within `accuracy` mm, on the shape's own layer), and so on along the chain.
 */
export function selectAllConnectedShapes(doc: BoardDoc, starts: string[], selected: Set<string>, opts?: { passes?: (it: KItem) => boolean; accuracy?: number; hitTest?: (it: KItem, p: Pt, accuracy: number) => boolean } | null): void {
  const passes = (opts && opts.passes) || (() => true), acc = (opts && opts.accuracy) || 0;
  const hit = (opts && opts.hitTest) || ((it: KItem, p: Pt, a: number) => (it.geom || []).some((g) => { try { return K.geomHit(g, p[0], p[1], a); } catch (e) { return false; } }));
  const cand = Array.from(doc.items.values()).filter(isExpandableGraphicShape);
  const stack = starts.slice(), seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!; if (seen.has(id)) continue; seen.add(id);
    const it = doc.items.get(id); if (!it || !passes(it)) continue;
    selected.add(id);
    const layer = layerOf(it.node, "");
    for (const p of shapeEnds(it)) for (const o of cand) {
      if (seen.has(o.id) || layerOf(o.node, "") !== layer) continue;
      const b = o.bbox; if (b && (p[0] < b[0] - acc || p[0] > b[2] + acc || p[1] < b[1] - acc || p[1] > b[3] + acc)) continue;
      if (hit(o, p, acc)) stack.push(o.id);
    }
  }
}

// ---------------------------------------------------------------- expandConnection
const isConnectedKind = (it: KItem) => it.kind === "segment" || it.kind === "arc" || it.kind === "via" || it.kind === "zone" || (SHAPE_KINDS.has(it.kind) && isCu(layerOf(it.node, "")) && !!K.kid(it.node, "net"));
/** The start items of a selection for selectAllConnectedTracks: a footprint's pads, a generator's members, connected items. */
export function connectionStarts(doc: BoardDoc, ids: Iterable<string>): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (isPadKey(id)) { out.push(id); continue; }
    const it = doc.items.get(id); if (!it) continue;
    if (it.kind === "footprint") for (const p of padsOf(it)) out.push(padKey(it.id, p.index));
    else if (it.kind === "generated") { for (const m of groupMembers(it.node)) { const c = doc.items.get(m); if (c && isConnectedKind(c)) out.push(m); } }
    else if (isConnectedKind(it)) out.push(id);
  }
  return out;
}
/**
 * PCB_SELECTION_TOOL::expandConnection on a selection (item ids; pads on their own as "footprintId#index"): one stage
 * per call — to the next junction, then to the pads, then the whole connection — stopping at the first stage that
 * adds something.  A selection of nothing but open graphics off copper follows the chain of shapes first.  Returns
 * the new selection (pad keys left as they came).
 */
export function expandConnection(doc: BoardDoc, ids: Iterable<string>, opts?: (ConnectOpts & { accuracy?: number }) | null): Set<string> {
  const selected = new Set<string>(ids);
  let initial = 0;
  for (const id of selected) { const it = isPadKey(id) ? null : doc.items.get(id); if (isPadKey(id) || (it && (it.kind === "footprint" || it.kind === "generated" || isConnectedKind(it)))) initial++; }
  if (initial === 0) {
    const shapes = Array.from(selected).filter((id) => { const it = doc.items.get(id); return !!it && isExpandableGraphicShape(it); });
    if (shapes.length) selectAllConnectedShapes(doc, shapes, selected, { passes: opts && opts.passes ? (it) => opts.passes!(it) : undefined, accuracy: opts ? opts.accuracy : 0 });
  }
  for (const stop of ["junction", "pad", "never"] as StopCondition[]) {
    selectAllConnectedTracks(doc, connectionStarts(doc, Array.from(selected)), stop, selected, opts);
    if (selected.size > initial) break;
  }
  return selected;
}

// ---------------------------------------------------------------- nets
const netKeyOf = (nl: Netlist, node: SNode) => nl.table.key(netOf(node));
/** SelectAllItemsOnNet: the net's tracks, arcs, vias and copper shapes (never its zones, pads or footprints). */
export function netCopperIds(doc: BoardDoc, key: string, nl: Netlist, passes?: (it: KItem) => boolean): string[] {
  const out: string[] = []; if (!key) return out;
  for (const it of doc.items.values()) {
    const shape = SHAPE_KINDS.has(it.kind) && isCu(layerOf(it.node, "")) && !!K.kid(it.node, "net");
    if (it.kind !== "segment" && it.kind !== "arc" && it.kind !== "via" && !shape) continue;
    if (netKeyOf(nl, it.node) === key && (!passes || passes(it))) out.push(it.id);
  }
  return out;
}
/** selectNet: the nets of the selected BOARD_CONNECTED_ITEMs (tracks, vias, zones, copper shapes and pads; not footprints). */
export function connectedItemNets(doc: BoardDoc, ids: Iterable<string>, nl: Netlist): Set<string> {
  const keys = new Set<string>();
  for (const id of ids) {
    if (isPadKey(id)) { const h = id.lastIndexOf("#"), fp = doc.items.get(id.slice(0, h)), p = fp && padsOf(fp)[+id.slice(h + 1)]; const k = p && nl.table.key(p.net); if (k) keys.add(k); continue; }
    const it = doc.items.get(id); if (!it || !isConnectedKind(it)) continue;
    const k = netKeyOf(nl, it.node); if (k) keys.add(k);
  }
  return keys;
}
/**
 * selectConnections: from footprints (and pads on their own), the tracks reached from their pads up to the next pad
 * (STOP_AT_PAD) and all the copper of every net whose pads all belong to the given items.
 */
export function selectConnections(doc: BoardDoc, ids: string[], nl: Netlist, selected: Set<string>, opts?: ConnectOpts | null): void {
  const padList = new Set<string>(), nets = new Set<string>();
  const take = (fp: KItem, index: number) => { const p = padsOf(fp)[index]; const k = p && nl.table.key(p.net); if (!k) return; nets.add(k); padList.add(padKey(fp.id, index)); };
  for (const id of ids) {
    if (isPadKey(id)) { const h = id.lastIndexOf("#"), fp = doc.items.get(id.slice(0, h)); if (fp) take(fp, +id.slice(h + 1)); continue; }
    const it = doc.items.get(id); if (it && it.kind === "footprint") for (const p of padsOf(it)) take(it, p.index);
  }
  selectAllConnectedTracks(doc, Array.from(padList), "pad", selected, opts);
  for (const key of nets) {
    const net = nl.nets.get(key); if (!net) continue;
    if (net.pads.some((c) => !padList.has(padKey(c.id, (c as { index: number }).index)))) continue;   // a pad outside the list: not a local net
    for (const id of netCopperIds(doc, key, nl)) selected.add(id);
  }
}
/** FOOTPRINT::GetPath().AsString().BeforeLast( '/' ) ("/" when empty), or null for a footprint without a path. */
export function footprintSheetPath(it: KItem): string | null {
  const p = K.kid(it.node, "path"); const s = p ? K.str(p[1]) : ""; if (!s) return null;
  const i = s.lastIndexOf("/"); const sheet = i >= 0 ? s.slice(0, i) : "";
  return sheet || "/";
}
/** selectAllItemsOnSheet: the footprints on a sheet path and the connections among them. */
export function sheetItemIds(doc: BoardDoc, sheetPath: string, nl: Netlist, opts?: ConnectOpts | null): Set<string> {
  const fps: string[] = [];
  for (const it of doc.items.values()) if (it.kind === "footprint" && footprintSheetPath(it) === sheetPath) fps.push(it.id);
  const out = new Set<string>(fps); selectConnections(doc, fps, nl, out, opts); return out;
}

// ---------------------------------------------------------------- cross-probing
/** One SelectionSpec of a SyncSelection message: a footprint by reference, a pad by reference and number, or a
 *  schematic sheet by its full KIID path (root sheet first). */
export interface SyncSpec { footprint?: string; pad?: { ref: string; number: string }; sheetPath?: string[] }
/** FOOTPRINT::IsWithinSchematicSheet: the footprint's path (which omits the root sheet) starts with the sheet's. */
function withinSheet(it: KItem, sheet: string[]): boolean {
  if (!sheet.length) return false;
  const p = K.kid(it.node, "path"), path = (p ? K.str(p[1]) : "").split("/").filter(Boolean);
  if (path.length < sheet.length - 1) return false;
  for (let i = 1; i < sheet.length; i++) if (path[i - 1] !== sheet[i]) return false;
  return true;
}
/**
 * kiapi::board::FindItemsFromSyncSelection: the board items a cross-probe names, ordered by the spec that found them
 * (footprint ids, and pads as "footprintId#padIndex").
 */
export function findItemsFromSyncSelection(doc: BoardDoc, specs: SyncSpec[]): string[] {
  const pairs: [number, string][] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue;
    const ref = it.ref || "";
    specs.forEach((spec, index) => {
      if (spec.footprint !== undefined) { if (ref === spec.footprint) pairs.push([index, it.id]); }
      else if (spec.pad) { if (ref === spec.pad.ref) for (const p of padsOf(it)) if (p.number === spec.pad.number) pairs.push([index, it.id + "#" + p.index]); }
      else if (spec.sheetPath) { if (withinSheet(it, spec.sheetPath)) pairs.push([index, it.id]); }
    });
  }
  return pairs.map((x, i) => [x, i] as [[number, string], number]).sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]).map((x) => x[0][1]);
}
/**
 * PCB_SELECTION_TOOL::ZoomFitCrossProbeBBox (the scaled zoom): the factor the view's scale is divided by for a
 * cross-probed box of w x h mm in a viewport of vw x vh mm, or null when the zoom stays.  The box grows by 20 % of
 * its width (KiROUND in nm) on every side; its height over the default text height (1 mm) is bent through KiCad's
 * table; a box too wide for that uses the plain fit; nothing changes while the ratio lies within 0.5 .. 1.
 */
export function crossProbeZoomRatio(w: number, h: number, vw: number, vh: number): number | null {
  w = Math.abs(w); h = Math.abs(h); if (w === 0) return null;
  const grow = Math.round(w * 0.2 * 1e6) / 1e6, bx = w + 2 * grow, by = h + 2 * grow;
  const compRatio = by / 1;
  const lut: [number, number][] = [[1, 8], [1.5, 5], [3, 3], [4.5, 2.5], [8, 2], [12, 1.7], [16, 1.5], [24, 1.3], [32, 1]];
  let bent = lut[lut.length - 1][1];
  if (compRatio >= lut[0][0]) {
    for (let i = 0; i < lut.length - 1; i++) if (lut[i][0] <= compRatio && lut[i + 1][0] >= compRatio) { bent = lut[i][1] + (lut[i + 1][1] - lut[i][1]) * (compRatio - lut[i][0]) / (lut[i + 1][0] - lut[i][0]); break; }
  } else bent = lut[0][1];
  vw = Math.max(10 / 1e6, Math.abs(vw)); vh = Math.max(10 / 1e6, vh);
  let ratio = Math.max(-1, Math.abs(by / vh));
  const kicadRatio = Math.max(Math.abs(bx / vw), Math.abs(by / vh));
  if (bx > vw * ratio * bent) { ratio = kicadRatio; bent = 1; }
  ratio *= bent;
  return ratio < 0.5 || ratio > 1 ? ratio : null;
}

// ---------------------------------------------------------------- ratsnest neighbours
export interface RatLine { ids: string[]; a: Pt; b: Pt; length: number; net: string }
/** The pads of a selection (a footprint's, or a pad on its own) as { fp, x, y }. */
function selectionPads(doc: BoardDoc, ids: Iterable<string>) {
  const out: { fp: string; x: number; y: number; net: string }[] = [];
  for (const id of ids) {
    if (isPadKey(id)) { const h = id.lastIndexOf("#"), fp = doc.items.get(id.slice(0, h)), p = fp && padsOf(fp)[+id.slice(h + 1)]; if (fp && p) out.push({ fp: fp.id, x: p.x, y: p.y, net: p.net ? p.net.name || String(p.net.code) : "" }); continue; }
    const it = doc.items.get(id); if (it && it.kind === "footprint") for (const p of padsOf(it)) out.push({ fp: it.id, x: p.x, y: p.y, net: p.net ? p.net.name || String(p.net.code) : "" });
  }
  return out;
}
const footprintPadAt = (doc: BoardDoc, id: string, p: Pt): boolean => { const it = doc.items.get(id); return !!it && it.kind === "footprint" && padsOf(it).some((q) => pk([q.x, q.y]) === pk(p)); };
/**
 * selectUnconnected: for each pad of the selection, the footprints whose pad sits at the other end of a ratsnest
 * line that starts on that pad.
 */
export function unconnectedFootprints(doc: BoardDoc, ids: Iterable<string>, lines: RatLine[]): string[] {
  const out = new Set<string>();
  for (const pad of selectionPads(doc, ids)) {
    const k = pk([pad.x, pad.y]);
    for (const l of lines) {
      const atA = l.ids[0] === pad.fp && pk(l.a) === k, atB = l.ids[1] === pad.fp && pk(l.b) === k;
      if (atA && footprintPadAt(doc, l.ids[1], l.b)) out.add(l.ids[1]);
      else if (atB && footprintPadAt(doc, l.ids[0], l.a)) out.add(l.ids[0]);
    }
  }
  return Array.from(out);
}
/**
 * grabUnconnected: per source item (each pad of a selected footprint, each selected connected item) the footprint at
 * the far end of the shortest ratsnest line of its net that leaves the source's cluster for a pad of another
 * footprint.  One entry per source that found one, in source order (duplicates kept, as KiCad's list has them).
 */
export function nearestUnconnectedFootprints(doc: BoardDoc, ids: Iterable<string>, nl: Netlist, lines: RatLine[]): string[] {
  const out: string[] = [];
  type Src = { id: string; index?: number; net: string };
  const sources: Src[] = [];
  for (const id of ids) {
    if (isPadKey(id)) { const h = id.lastIndexOf("#"), fp = doc.items.get(id.slice(0, h)), p = fp && padsOf(fp)[+id.slice(h + 1)]; if (fp && p) sources.push({ id: fp.id, index: p.index, net: nl.table.key(p.net) }); continue; }
    const it = doc.items.get(id); if (!it) continue;
    if (it.kind === "footprint") for (const p of padsOf(it)) sources.push({ id: it.id, index: p.index, net: nl.table.key(p.net) });
    else if (isConnectedKind(it)) sources.push({ id: it.id, net: netKeyOf(nl, it.node) });
  }
  for (const s of sources) {
    if (!s.net) continue; const net = nl.nets.get(s.net); if (!net) continue;
    const mine = net.clusters.filter((cl) => cl.items.some((c) => c.id === s.id && (s.index === undefined || (c as { index?: number }).index === s.index)));
    if (!mine.length) continue;
    const inMine = (id: string, p: Pt) => mine.some((cl) => cl.anchors.some((a) => a.id === id && pk(a.p) === pk(p)));
    let best = Infinity, nearest: string | null = null;
    for (const l of lines) {
      if (l.net !== s.net) continue;
      // an edge between two anchors of one footprint is a loop; so is one between two items outside any footprint
      const fa = footprintPadAt(doc, l.ids[0], l.a) ? l.ids[0] : null, fb = footprintPadAt(doc, l.ids[1], l.b) ? l.ids[1] : null;
      if (fa === fb) continue;
      const sa = inMine(l.ids[0], l.a), sb = inMine(l.ids[1], l.b); if (sa === sb) continue;
      const otherId = sa ? l.ids[1] : l.ids[0], otherP = sa ? l.b : l.a;
      if (!footprintPadAt(doc, otherId, otherP)) continue;   // only footprints are grabbed: the line has to end on a pad
      if (l.length < best) { best = l.length; nearest = otherId; }
    }
    if (nearest) out.push(nearest);
  }
  return out;
}

// ---------------------------------------------------------------- unrouteSelected
/**
 * PCB_SELECTION_TOOL::unrouteSelected's set: from the pads of the selected footprints (and pads) and the selected
 * connected items, the tracks and vias up to the next pad (STOP_AT_PAD, with the tracks filter forced on), plus the
 * generators that own any of them with all their members.
 */
export function unrouteIds(doc: BoardDoc, ids: Iterable<string>, f?: SelFilter | null): Set<string> {
  const starts = connectionStarts(doc, ids);
  const ff: SelFilter = Object.assign({}, f || {}, { tracks: true, pads: true });
  const sel = new Set<string>();
  selectAllConnectedTracks(doc, starts, "pad", sel, { passes: (it, pad) => itemPassesFilter(doc, ff, it, { pad, multi: true }) });
  for (const it of doc.items.values()) if (it.kind === "generated") { const m = groupMembers(it.node); if (sel.has(it.id) || m.some((id) => sel.has(id))) { sel.add(it.id); for (const id of m) if (doc.items.has(id)) sel.add(id); } }
  for (const id of Array.from(sel)) { const it = doc.items.get(id); if (!it || it.kind === "footprint") sel.delete(id); }
  return sel;
}
