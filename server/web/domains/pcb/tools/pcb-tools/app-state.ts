// pcb-tools/app-state.ts — the editor state the board tools read (defensively) and the hover / snap point of an interaction.
import type { BoardDoc, Hover, Mods, NetRef, PcbCtx, Pt, SnapHit } from "./types";
import { root } from "../root";
import { copperOf } from "./dialogs";
import { snapCursor } from "./grid-helper";
import { distSeg } from "./hit";
import { netlist } from "./netlist";
import { pickSingleItem, snapTarget, snapToItem } from "./route-geom";
import { routerSnapsTo } from "./snap-pairs";
import { RM_MARK } from "./router-settings";
import { K, S, SNAP_MM, WIDTHS, lastCtx } from "./state";
import { layerOf, pt, samePt, widthOf } from "./util";

// ---------------------------------------------------------------- app.js state (read defensively)
// app.js keeps the editor state in script-scope lets (tool, kdoc, DOC_TYPE, zoom, selected, state) that
// the module hooks don't carry live; they are read under try/catch, falling back to the last ctx seen.
export function appGlobal<T, F>(fn: () => T, fallback: F): T | F { try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; } }
/* the editor's live state is read through window.CollabEditor (see web/domains/pcb/editor/state.ts) */
export const editorState = () => root.CollabEditor || null;   // the editor bundle's state object (the former app.js script-scope lets)
export const appTool = () => appGlobal(() => editorState()!.tool, S.modTool || "select");
export const isPcbDoc = () => appGlobal(() => editorState()!.DOC_TYPE === "kicad_pcb" && !!editorState()!.kdoc && root.CollabApp!.getState().view === "editor", !!(lastCtx && !lastCtx.isSch && lastCtx.doc));
/** A board or the Footprint Editor's footprint (its children are board items): the canvas gestures of both. */
export const isBoardLikeDoc = () => appGlobal(() => (editorState()!.DOC_TYPE === "kicad_pcb" || editorState()!.DOC_TYPE === "footprint") && !!editorState()!.kdoc && root.CollabApp!.getState().view === "editor", !!(lastCtx && !lastCtx.isSch && lastCtx.doc));
export const liveDoc = () => appGlobal(() => editorState()!.kdoc, lastCtx && lastCtx.doc);
export const liveZoom = () => appGlobal(() => editorState()!.zoom, lastCtx ? lastCtx.zoom : 1);
export const liveSelected = () => appGlobal(() => editorState()!.selected, lastCtx && lastCtx.selected);
// The track / via sizes in force live in KiCadCanvas.pcbSizes.state (web/domains/pcb/canvas/pcb-sizes.ts) — BOARD_DESIGN_SETTINGS'
// pre-defined lists, the selected entries, "use netclass", the connected-width option and the routing layer pair.
// The toolbar's selectors, W / ' / \ and the router all read and step that one object.
export let seenDesign: PcbCtx["designSettings"];
/** The board's sizes; a context carrying a project file this module has not seen yet (re)loads the lists from it. */
export function sizesOf(ctx: PcbCtx) { const R = K.pcbSizes.state; if (ctx && ctx.designSettings !== seenDesign) { seenDesign = ctx.designSettings; R.load(seenDesign); } return R; }
export const widthFor = () => sizesOf(lastCtx!).currentTrackWidth();
export const netNameOf = (ctx: PcbCtx, net: NetRef | null | undefined) => (net && net.name) || (net && net.code > 0 && ctx.doc && ctx.doc.nets && ctx.doc.nets.get(net.code)) || "";
/** The width of the track a route would continue at p: the segment under it, or one ending on the pad / via there (inheritTrackWidth). */
export function connectedWidth(doc: BoardDoc, p: Pt, layer: string, towards: Pt) {
  let best: number | null = null, bd = Infinity;
  for (const it of doc.items.values()) {
    if ((it.kind !== "segment" && it.kind !== "arc") || layerOf(it.node) !== layer) continue;
    const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) continue; const w = widthOf(it.node, 0);
    const ends = samePt(a, p) ? b : samePt(b, p) ? a : null;
    if (!ends && !(it.kind === "segment" && distSeg(p[0], p[1], a[0], a[1], b[0], b[1]) <= w / 2 + 1e-6)) continue;
    const d = ends && towards ? Math.hypot(ends[0] - towards[0], ends[1] - towards[1]) : 0;   // several stubs on a pad: the one pointing at the cursor
    if (d < bd) { bd = d; best = w; }
  }
  return best;
}
export function nextWidth(w: number, dir: number) { const i = WIDTHS.findIndex((v) => Math.abs(v - w) < 1e-6); return WIDTHS[(i + (dir === -1 ? -1 : 1) + WIDTHS.length) % WIDTHS.length]; }
/** Layer names of the board.  kicad-canvas keys doc.layers by the layer *type* for (n "F.Cu" signal) entries, so fall back to what the items use. */
export function layerNames(doc: BoardDoc) {
  const names = new Set(doc ? Array.from(doc.layers.keys()).filter((l) => /\./.test(l)) : []);
  if (!names.size && doc) for (const it of doc.items.values()) for (const g of it.geom) if (g.layer && /\./.test(g.layer)) names.add(g.layer);
  return names;
}
export function gfxLayers(doc: BoardDoc) {
  const names = Array.from(layerNames(doc)).filter((l) => !/\.Cu$/.test(l));
  const out = copperOf(doc).concat(["Edge.Cuts", "F.SilkS", "B.SilkS", "Dwgs.User", "Cmts.User", "F.Fab", "B.Fab"]);   // the copper stack, then what every board has
  for (const l of names) if (!out.includes(l)) out.push(l);
  return out;
}

// ---------------------------------------------------------------- interactions
export function hoverPoint(ctx: PcbCtx, mm: Pt, magnetic: boolean, mods?: Mods | null): Hover {
  // the drawing tools resolve the cursor through the grid helper too (DRAWING_TOOL: grid.SetSnap( !Shift ), Ctrl = no grid: TOOL_EVENT::DisableGridSnapping)
  const rt0 = S.route; const routerTool = magnetic && !!ctx.doc && (!!rt0 || S.modTool === "route" || S.modTool === "routediff");
  if (routerTool) return routerHover(ctx, mm, mods || null);
  const sn = magnetic ? { p: ctx.snap(mm), anchor: null } : snapCursor(ctx, mm, null, mods);
  const g = sn.p; const out: Hover = { x: g[0], y: g[1], snap: sn.anchor ? { x: g[0], y: g[1], kind: "anchor", type: sn.anchor.t || "none", shape: !!sn.anchor.shape } : null };
  if (magnetic && ctx.doc) {
    const rt = S.route;
    // TOOL_BASE::updateEndItem: while routing only the routed net's items are end candidates (a route without a net has none)
    // (Highlight collisions connects to net-less items too, and a net-less route to anything: FixRoute adopts the net)
    const near = (a: SnapHit | null, b: SnapHit | null) => (!a ? b : !b ? a : Math.hypot(a.x - mm[0], a.y - mm[1]) <= Math.hypot(b.x - mm[0], b.y - mm[1]) ? a : b);
    const s = rt && rt.dp ? near(snapTarget(ctx.doc, mm[0], mm[1], SNAP_MM, rt.layer, rt.net, true), snapTarget(ctx.doc, mm[0], mm[1], SNAP_MM, rt.layer, rt.netN!, true)) : rt ? (S.rs.mode === RM_MARK ? snapTarget(ctx.doc, mm[0], mm[1], SNAP_MM, rt.layer, rt.netKey ? rt.net : null, false) : rt.netKey ? snapTarget(ctx.doc, mm[0], mm[1], SNAP_MM, rt.layer, rt.net, true) : null) : snapTarget(ctx.doc, mm[0], mm[1], SNAP_MM, S.layer, null);
    // before a route starts PNS picks the start item on every visible copper layer, the active one first
    // (ROUTER_TOOL::getStartLayer then routes on the item's layer)
    const s2 = s || (rt ? null : otherLayerSnap(ctx, mm, S.layer));
    if (s2) { out.x = s2.x; out.y = s2.y; out.snap = s2; }
  }
  return out;
}
/**
 * TOOL_BASE::updateStartItem / updateEndItem: the router's cursor.  Ctrl turns the grid off (DisableGridSnapping),
 * Shift object snapping (SetSnap( !MD_SHIFT )); before a route Ctrl+Shift gives no start item and the raw mouse
 * position.  The start item is picked on every shown copper layer (with the grid off only on the top one); the end
 * item only among the routed net's items on the routing layer (any layer while a via is armed), and only when the
 * magnetic pads / tracks option lets the router snap to it (checkSnap).  A route without a net has no end item
 * outside Highlight collisions.
 */
export function routerHover(ctx: PcbCtx, mm: Pt, mods: Mods | null): Hover {
  const ctrl = !!(mods && (mods.ctrlKey || mods.metaKey)), shift = !!(mods && mods.shiftKey); const rt = S.route;
  if (!rt && ctrl && shift) return { x: mm[0], y: mm[1], snap: null };
  const align = (q: Pt): Pt => (ctrl ? q : ctx.snap(q)); const g = align(mm.slice());
  const out: Hover = { x: g[0], y: g[1], snap: null };
  const hidden = appGlobal(() => editorState()!.hiddenLayers as Set<string> | null, null);
  const copper = copperOf(ctx.doc); const slop = ctx.gridPitch || 0;
  const top = (rt && rt.placingVia ? sizesOf(ctx).activeLayer : null) || S.layer;
  const o = { top, copper, shown: hidden ? (l: string) => !hidden.has(l) : null, allowNetless: S.rs.mode === RM_MARK };
  if (!rt) {
    let c = pickSingleItem(ctx.doc, mm[0], mm[1], slop, null, null, o);
    if (ctrl && c && !c.layers.includes(top)) c = null;   // !GetUseGrid(): only an item on the top layer
    if (!c) return out;
    const s = snapToItem(c, mm, top, shift ? (q: Pt) => q : align);
    // the body of a track: the start is taken on its centre line by routeClick (trackUnder), which also breaks it there
    if (s.kind === "trackMid") return out;
    out.x = s.x; out.y = s.y; out.snap = s; return out;
  }
  if (S.rs.mode !== RM_MARK && !rt.netKey) return out;
  const layer = rt.placingVia ? null : rt.layer;
  let c = pickSingleItem(ctx.doc, mm[0], mm[1], slop, layer, rt.netKey ? rt.net : null, o);
  if (!c && rt.dp && rt.netN) c = pickSingleItem(ctx.doc, mm[0], mm[1], slop, layer, rt.netN, o);
  if (!c || shift || !routerSnapsTo(c.kind)) return out;
  const s = snapToItem(c, mm, top, align);
  out.x = s.x; out.y = s.y; out.snap = s; return out;
}
/** The copper layers that are shown, the active one excluded: where a route may start off the active layer. */
export function otherCopperLayers(ctx: PcbCtx, active: string): string[] {
  const hidden = appGlobal(() => editorState()!.hiddenLayers as Set<string> | null, null);
  return copperOf(ctx.doc).filter((l) => l !== active && !(hidden && hidden.has(l)));
}
/** A magnetic target on another shown copper layer (its pad, via or track end), nearest first. */
export function otherLayerSnap(ctx: PcbCtx, mm: Pt, active: string): SnapHit | null {
  let best: SnapHit | null = null, bd = Infinity;
  for (const l of otherCopperLayers(ctx, active)) { const s = snapTarget(ctx.doc, mm[0], mm[1], SNAP_MM, l, null) as SnapHit | null; if (!s) continue; const d = Math.hypot(s.x - mm[0], s.y - mm[1]); if (d < bd) { bd = d; best = s; } }
  return best;
}
/** The board's netlist, rebuilt after a document change and kept until the next one. */
export function netlistCached(doc: BoardDoc) {
  if (doc.__bc) return doc.__bc.nl || (doc.__bc.nl = netlist(doc));   // a route's branch is never edited in place
  if (!S.nlc || S.nlc.doc !== doc || S.nlc.ver !== S.docVer) S.nlc = { doc, ver: S.docVer, nl: netlist(doc) };
  return S.nlc.nl;
}
