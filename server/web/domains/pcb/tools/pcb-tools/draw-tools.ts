// pcb-tools/draw-tools.ts — the drawing tools' clicks: shapes, zones and rule areas, text boxes, tables, dimensions and images.
import type { DrawState, Hover, PcbCtx, Pt, PtrEvent } from "./types";
import type { PickedImage } from "./dom";
import { root } from "../root";
import { sizesOf } from "./app-state";
import { NM, arcClick, arcMove, toNm } from "./arcs";
import { newItemDialogs } from "./assistants";
import { addedChange, boardNets } from "./changes";
import { openForm } from "./dialogs";
import { DIM_TYPE, dimensionNode, snap45 } from "./dimensions";
import type { DimSpec } from "./dimensions";
import { pickerImpl, promptImpl } from "./dom";
import { POLY_TOOLS, RULE_AREA_LAYERS, constrainDraw, curveGeom, drawTrack, drawWidth, pushPt, simplifyOutline, withStroke } from "./draw-modes";
import { applySelection, selectionIds } from "./groups";
import { base64Bytes, imageInfo, imageMm } from "./images";
import { netTable } from "./netlist";
import { netOf } from "./nets";
import { circleNode, curveNode, imageNode, lineNode, polyFilledOn, polyNode, rectNode, ruleAreaNode, tableNode, textBoxNode, thievingAllowed, thievingZoneNode, THIEVING_NEEDS_VERSION_MSG, zoneLayers, zoneNode } from "./nodes";
import { netUnder } from "./route-geom";
import { K, S, lastCtx } from "./state";
import { samePt, vadd, vsub, xy } from "./util";
import { similarZoneNode, zoneCutoutChanges, zoneLayerList } from "./zone-modes";

/** The shapes DRAWING_TOOL::drawShape draws: while one is in progress the screen's local origin is its first point. */
const ORIGIN_SHAPES = new Set(["gline", "grect", "gcircle", "gtextbox"]);
/**
 * drawShape: `if( !isLocalOriginSet ) m_LocalOrigin = cursorPos` at the first click and back to (0, 0) when the shape
 * ends, unless the user had (or has since) set a local origin (resetLocalCoords).
 */
export function drawOriginBegin(ctx: PcbCtx, p: Pt) {
  if (!ctx.localOrigin || !ctx.setLocalOrigin) return;
  const o = ctx.localOrigin();
  if (S.drawOrigin) { if (o && samePt(o, S.drawOrigin)) { S.drawOrigin = p.slice(); ctx.setLocalOrigin(p.slice()); } else S.drawOrigin = null; return; }   // the next segment of a chain
  if (o && (o[0] || o[1])) return;   // isLocalOriginSet
  S.drawOrigin = p.slice(); ctx.setLocalOrigin(p.slice());
}
/** The shape ended (committed, cancelled, the tool left): the origin this tool set goes back to (0, 0). */
export function drawOriginSync(ctx: PcbCtx | null | undefined) {
  if (!S.drawOrigin || (S.draw && ORIGIN_SHAPES.has(S.draw.shape))) return;
  const mine = S.drawOrigin; S.drawOrigin = null;
  if (!ctx || !ctx.localOrigin || !ctx.setLocalOrigin) return;
  const o = ctx.localOrigin(); if (o && samePt(o, mine)) ctx.setLocalOrigin([0, 0]);
}
/**
 * The first click of a shape, zone or dimension: ACTIONS::selectionClear, and the layer it is drawn on is made visible
 * (GetAppearancePanel()->SetLayerVisible( m_layer, true )).
 */
export function drawBegin(ctx: PcbCtx, layer: string | null | undefined) {
  applySelection(ctx, []);
  if (layer && ctx.showLayer) ctx.showLayer(layer);
}
/** DRAWING_TOOL::DrawBezier's commit: "Draw Bezier", the curve selected. */
function commitCurve(ctx: PcbCtx, g: Pt[]) {
  // curveGeom gives start, control 1, end, control 2; the file's order is start, control 1, control 2, end
  const c = addedChange(ctx.doc, withStroke(curveNode([g[0], g[1], g[3], g[2]], S.gfxLayer)));
  ctx.commit([c], "Draw Bezier"); applySelection(ctx, [c.id]);
}
/**
 * ACTIONS::finishInteractive or a double-click while a bezier is drawn (drawManagedShape): what there is so far is
 * kept and committed, and no further curve is chained.
 */
export function finishCurve(ctx: PcbCtx) {
  const d = S.draw; if (!d || d.shape !== "gcurve") return false;
  S.draw = null; commitCurve(ctx, curveGeom(d.pts, d.cur)); ctx.requestRender(); return true;
}
export function drawClick(ctx: PcbCtx, hv: Hover, t: string, ev: PtrEvent) {
  if (S.draw && S.draw.shape !== "garc") { const c = constrainDraw(S.draw, [hv.x, hv.y], !!(ev && (ev.ctrlKey || ev.metaKey))); hv = Object.assign({}, hv, { x: c[0], y: c[1] }); }
  if (t === "garc" && S.draw && S.draw.shape === "garc") arcMove(S.draw, [hv.x, hv.y], !!(ev && (ev.ctrlKey || ev.metaKey)));
  const p = [hv.x, hv.y], layer = S.gfxLayer;
  if (!S.draw && t === "thievingzone" && !thievingAllowed(ctx.doc)) { ctx.toast(THIEVING_NEEDS_VERSION_MSG); return; }
  if (!S.draw && t === "thievingzone") {
    // ZONE_CREATE_HELPER::createNewZone with m_thieving: no pre-draw dialog, COPPER_THIEVING on the active layer, net 0
    const tpl = zoneTemplate(ctx, false, true);
    S.draw = { shape: t, start: p, cur: p.slice(), pts: [p], template: tpl, layer: zoneLayers(tpl)[0] }; drawBegin(ctx, S.draw.layer); ctx.requestRender();
    return;
  }
  if (!S.draw && t === "zone" && S.zoneMode) {
    // ZONE_MODE::CUTOUT / SIMILAR: no dialog, the source zone's settings (createZoneFromExisting); a similar zone goes on
    // the active layer when the source is on it, else on the source's first layer
    const src = ctx.doc.items.get(S.zoneMode.src);
    if (!src) { S.zoneMode = null; ctx.setTool("select"); return; }
    const layers = zoneLayerList(src.node), active = sizesOf(ctx).activeLayer || S.layer;
    S.draw = { shape: t, start: p, cur: p.slice(), pts: [p], template: src.node, layer: S.zoneMode.mode === "similar" && !layers.includes(active) ? layers[0] : active, zoneMode: S.zoneMode.mode };
    drawBegin(ctx, S.draw.layer); ctx.requestRender(); return;
  }
  if (!S.draw && (t === "zone" || t === "rulearea") && newItemDialogs.zone) {
    // ZONE_CREATE_HELPER::OnFirstPoint → createNewZone: the properties dialog on a template first; Cancel ends it
    const tpl = zoneTemplate(ctx, t === "rulearea"), d: DrawState = { shape: t, start: p, cur: p.slice(), pts: [p], pending: true, template: null, layer: zoneLayers(tpl)[0] };
    S.draw = d; ctx.requestRender();
    newItemDialogs.zone(ctx, tpl, (node: SNode | null) => {
      if (S.draw !== d) return;
      if (!node) { S.draw = null; ctx.requestRender(); return; }
      d.template = node; d.pending = false; d.layer = zoneLayers(node)[0] || d.layer; drawBegin(ctx, d.layer); ctx.requestRender();
    });
    return;
  }
  if (t === "garc") { arcClick(ctx, p); return; }
  if (!S.draw) {
    S.draw = { shape: t, start: p, cur: p.slice(), pts: [p] }; if (t === "dimortho") S.draw.orientation = "h";
    drawBegin(ctx, t === "zone" || t === "thievingzone" ? S.layer : t === "rulearea" ? null : layer);
    if (ORIGIN_SHAPES.has(t)) drawOriginBegin(ctx, p);
    ctx.requestRender(); return;
  }
  const d = S.draw;
  if (POLY_TOOLS.has(t)) {
    if (d.pending) return;   // the properties dialog is still open
    drawTrack(d, p, !!(ev && (ev.ctrlKey || ev.metaKey)));
    // NewPointClosesOutline: only the first corner closes the outline; the last corner clicked again adds nothing
    // (POLYGON_GEOM_MANAGER::AddPoint), a double-click or Finish ends it
    if (samePt(p, d.pts[0])) finishPoly(ctx);
    else if (samePt(p, d.pts[d.pts.length - 1])) return;
    else {   // AddPoint: the leader's bend and its end are locked in
      const L = d.leader || [d.pts[d.pts.length - 1], p];
      if (L.length > 1) { pushPt(d.pts, L[L.length - 2]); pushPt(d.pts, L[L.length - 1]); } else pushPt(d.pts, p);
      drawTrack(d, d.cur, !!(ev && (ev.ctrlKey || ev.metaKey)));
      ctx.requestRender();
    }
    return;
  }
  if (t === "gcurve") {
    // BEZIER_GEOM_MANAGER::acceptPoint: SET_START, SET_CONTROL1, SET_END (refused while it equals the start),
    // SET_CONTROL2 (the cursor mirrored through the end)
    if (d.pts.length === 2 && samePt(p, d.pts[0])) return;
    d.pts.push(p);
    if (d.pts.length === 4) {
      const g = curveGeom(d.pts, p), end = g[2], c2 = g[3];
      commitCurve(ctx, g);
      // DrawBezier chains: the next curve starts at this one's end, its control 1 the last arm mirrored (when there is one)
      S.draw = { shape: t, start: end, cur: p.slice(), pts: samePt(end, c2) ? [end] : [end, [2 * end[0] - c2[0], 2 * end[1] - c2[1]]] };
    }
    ctx.requestRender(); return;
  }
  if (t === "gtextbox" || t === "table") {
    S.draw = null; ctx.requestRender();
    if (t === "gtextbox" && samePt(p, d.start)) return;   // clicking the corner again drops the box
    if (t === "gtextbox") {
      // DRAWING_TOOL::DrawRectangle for a PCB_TEXTBOX: Text Box Properties on the drawn box; OK adds it ("Draw Text Box", selected), Cancel drops it
      const node = withStroke(textBoxNode("", d.start, p, layer));
      const dlg = newItemDialogs.gr_text_box;
      if (!dlg) { askText(ctx, "Text box", "", (text: string | null) => { if (text) { node[1] = text; const c = addedChange(ctx.doc, node); ctx.commit([c], "Draw Text Box"); applySelection(ctx, [c.id]); } }); return; }
      dlg(ctx, node, (n) => { if (!n) return; const c = addedChange(ctx.doc, n); ctx.commit([c], "Draw Text Box"); applySelection(ctx, [c.id]); ctx.requestRender(); });
      return;
    }
    // the second click: Table Properties on the new table; OK adds it ("Draw Table", selected), Cancel drops it
    const node = tableNode(d.start, p, layer, ctx.gridPitch || 0);
    const dlg = newItemDialogs.table;
    const add = (n: SNode) => { const c = addedChange(ctx.doc, n); ctx.commit([c], "Draw Table"); applySelection(ctx, [c.id]); ctx.requestRender(); };
    if (!dlg) { add(node); return; }
    dlg(ctx, node, (n) => { if (n) add(n); });
    return;
  }
  if (DIM_TYPE[t]) { dimClick(ctx, p, t); return; }
  if (samePt(p, d.start)) { S.draw = null; ctx.requestRender(); return; }   // clicking the start again ends the chain
  const node = withStroke(t === "gline" ? lineNode(d.start, p, layer) : t === "grect" ? rectNode(d.start, p, layer) : circleNode(d.start, p, layer));
  const add = addedChange(ctx.doc, node);
  ctx.commit([add], t === "gline" ? "Draw Line" : t === "grect" ? "Draw Rectangle" : "Draw Circle");
  // drawShape: a line whose end snapped onto an existing graphic closes a path: it is selected and the chain ends
  const closes = t === "gline" && !!(hv.snap && hv.snap.shape);
  if (t !== "gline" || closes) applySelection(ctx, [add.id]);   // DrawRectangle / DrawCircle: ACTIONS::selectItem
  // lines chain like KiCad's polyline drawing; the committed segments stack up for deleteLastPoint (aCommittedGraphics)
  S.draw = t === "gline" && !closes ? { shape: t, start: p, cur: p.slice(), pts: [p], chain: (d.chain || []).concat([{ id: add.id, start: d.start, end: p }]) } : null;
  if (S.draw) drawOriginBegin(ctx, p);
  ctx.requestRender();
}
/**
 * ZONE_CREATE_HELPER::createNewZone: the board's default zone settings on the active layer, no name, the highlighted
 * net (else the first selected connected item's), a unique priority on copper; a rule area keeps out tracks, vias and pads.
 */
export function zoneTemplate(ctx: PcbCtx, keepout: boolean, thieving = false) {
  const doc = ctx.doc, layer = sizesOf(ctx).activeLayer || S.layer;
  if (keepout) return ruleAreaNode([], [layer]);
  if (thieving) return thievingZoneNode(doc, [], layer);
  let net = { code: 0, name: "" };
  if (S.highlightNet) { const t = netTable(doc); const n = boardNets(doc).find((x) => t.key(x) === S.highlightNet); if (n) net = n; }
  if (!net.name) {
    const first = Array.from(selectionIds(ctx))[0], it = first && doc.items.get(first);
    if (it && it.kind !== "footprint" && K.kid(it.node, "net")) net = netOf(it.node);
  }
  const node = zoneNode(doc, [], layer, net);
  if (!/\.Cu$/.test(layer)) { const pr = K.kid(node, "priority"); if (pr) node.splice(node.indexOf(pr), 1); }
  return node;
}
/** POLYGON_GEOM_MANAGER's locked points, then (45 / 90 modes) the leader's and the loop's bends: ZONE_CREATE_HELPER::OnComplete. */
export function polyOutline(d: DrawState) {
  const out: Pt[] = []; for (const p of d.pts) pushPt(out, p);
  if (d.mode === "45" || d.mode === "90") {
    for (const p of (d.leader || []).slice(1)) pushPt(out, p);
    for (const p of (d.loop || []).slice(1, -1)) pushPt(out, p);
  }
  while (out.length > 1 && samePt(out[out.length - 1], out[0])) out.pop();
  return simplifyOutline(out);   // chain.Simplify( true ), then the start point when it is collinear with its neighbours
}
export function finishPoly(ctx: PcbCtx) {
  const d = S.draw; if (!d || !POLY_TOOLS.has(d.shape) || d.pending) return;
  S.draw = null; ctx.requestRender();
  const locked: Pt[] = []; for (const p of d.pts) pushPt(locked, p);
  if (locked.length < 3) return;   // OnComplete: fewer than three locked corners scrap the zone or polygon, silently
  d.pts = polyOutline(d);
  if (d.template && d.zoneMode) {
    if (d.pts.length < 3) return;
    const src = S.zoneMode && ctx.doc.items.get(S.zoneMode.src);
    if (!src) return;
    if (d.zoneMode === "similar") {
      const c = addedChange(ctx.doc, similarZoneNode(ctx.doc, src.node, d.pts), netOf(src.node));
      ctx.commit([c], "Draw Zone"); applySelection(ctx, [c.id]); return;
    }
    // performZoneCutout: the selection is cleared, the source replaced by its remains; the first is the next cutout's source
    applySelection(ctx, []);
    const { changes, first } = zoneCutoutChanges(ctx.doc, src, d.pts);
    ctx.commit(changes, "Add Zone Cutout");
    if (first) { S.zoneMode = { mode: "cutout", src: first }; applySelection(ctx, [first]); } else { S.zoneMode = null; ctx.setTool("select"); }
    return;
  }
  if (d.template) {   // the zone the dialog set up, with the outline drawn
    if (d.pts.length < 3) return;   // OnComplete: fewer than three corners scrap the zone
    const node = JSON.parse(JSON.stringify(d.template)), poly = K.kid(node, "polygon");
    const pts = ["pts", ...d.pts.map(xy)];
    if (poly) poly.splice(1, poly.length - 1, pts); else node.push(["polygon", pts]);
    const c = addedChange(ctx.doc, node, netOf(node));
    ctx.commit([c], "Draw Zone"); applySelection(ctx, [c.id]); return;   // commitZone: "Draw Zone", ACTIONS::selectItem
  }
  if (d.pts.length < 3) return;
  if (d.shape === "gpoly") {
    // ZONE_MODE::GRAPHIC_POLYGON: filled off Edge.Cuts and the courtyards, the layer's default line thickness, solid
    // (the width hotkeys do not reach it), "Draw Polygon", selected
    const c = addedChange(ctx.doc, polyNode(d.pts, S.gfxLayer, polyFilledOn(S.gfxLayer), true));
    ctx.commit([c], "Draw Polygon"); applySelection(ctx, [c.id]); return;
  }
  if (d.shape === "rulearea") { const c = addedChange(ctx.doc, ruleAreaNode(d.pts, RULE_AREA_LAYERS)); ctx.commit([c], "Draw Zone"); applySelection(ctx, [c.id]); return; }
  // a copper zone on the active layer: the net comes from the prompt, which offers the board's nets and
  // starts on whatever copper the first corner sits on (KiCad takes the highlighted or selected net)
  const layer = S.layer, nets = boardNets(ctx.doc), under = netUnder(ctx.doc, d.pts[0][0], d.pts[0][1], layer);
  askText(ctx, "Zone net", under.name, (name: string | null) => {
    if (name === null) return;
    const net = name ? (nets.find((n) => n.name === name) || { code: -1, name }) : { code: 0, name: "" };
    const c = addedChange(ctx.doc, zoneNode(ctx.doc, d.pts, layer, net), net);
    ctx.commit([c], "Draw Zone"); applySelection(ctx, [c.id]);
  }, nets.map((n) => n.name));
}
// DRAWING_TOOL::DrawDimension: SET_ORIGIN, SET_END (centre, radial and leader are done there), then SET_HEIGHT where
// the cursor sets the aligned offset or the orthogonal axis and offset.  A second click on the first point is ignored
// (a dimension needs two); the new dimension is selected, and a leader opens Dimension Properties for its text.
export function dimClick(ctx: PcbCtx, p: Pt, t: string) {
  const d = S.draw, type = DIM_TYPE[t];
  if (d!.pts.length === 1) {
    if (samePt(p, d!.start)) return;
    d!.end = type === "center" ? vadd(d!.start, snap45(vsub(p, d!.start))) : p;   // the centre cross always sits on 45°
    d!.pts.push(d!.end);
    if (type === "orthogonal") d!.orientation = Math.abs(d!.end[0] - d!.start[0]) < Math.abs(d!.end[1] - d!.start[1]) ? "v" : "h";
    if (type === "center" || type === "radial" || type === "leader") { commitDim(ctx, type, d!); return; }
    ctx.requestRender(); return;
  }
  dimTrack(d!, p);
  commitDim(ctx, type, d!);
}
export function commitDim(ctx: PcbCtx, type: string, d: DrawState) {
  S.draw = null;
  const add = addedChange(ctx.doc, dimensionNode(type, Object.assign({}, d, { textPos: type === "radial" || type === "leader" ? null : d.textPos, thickness: drawWidth(S.gfxLayer) }) as DimSpec, S.gfxLayer));   // the end is set by now
  ctx.commit([add], "Draw Dimension"); ctx.requestRender();
  if (add.id) applySelection(ctx, [add.id]);   // ACTIONS::selectItem
  // PCB_DIM_LEADER: "Run the edit immediately to set the leader text"
  const it = type === "leader" && add.id && ctx.doc.items.get(add.id);
  if (it && root.KDialogs && root.KDialogs.openItem) root.KDialogs.openItem(ctx as unknown as Parameters<typeof root.KDialogs.openItem>[0], it);   // the board ctx is the dialog's ctx (app.js hands the same object)
}
/** The cursor after the second click (the tool's SET_HEIGHT motion). */
export function dimTrack(d: DrawState, p: Pt) {
  const type = DIM_TYPE[d.shape], s = d.start, e = d.end; if (!e) return;
  if (type === "aligned") {   // in nm, the height truncated as SetHeight( int ) takes it
    const S0 = toNm(s), E0 = toNm(e), P0 = toNm(p), a = Math.atan2(E0[1] - S0[1], E0[0] - S0[0]) + Math.PI / 2;
    d.height = Math.trunc((P0[0] - E0[0]) * Math.cos(a) + (P0[1] - E0[1]) * Math.sin(a)) / NM;
  }
  else if (type === "orthogonal") {
    const x0 = Math.min(s[0], e[0]), x1 = Math.max(s[0], e[0]), y0 = Math.min(s[1], e[1]), y1 = Math.max(s[1], e[1]);
    if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) {   // the axis only changes outside the points' box
      let vert;
      if (x1 === x0) vert = true; else if (y1 === y0) vert = false;
      else if (p[0] > x0 && p[0] < x1) vert = false;            // above or below: measure X
      else if (p[1] > y0 && p[1] < y1) vert = true;             // beside: measure Y
      else vert = Math.abs(p[1] - (y0 + y1) / 2) < Math.abs(p[0] - (x0 + x1) / 2);
      d.orientation = vert ? "v" : "h";
    }
    d.height = d.orientation === "v" ? p[0] - s[0] : p[1] - s[1];
  }
}
// Reference images (DRAWING_TOOL::PlaceReferenceImage): the picker (a file dialog; tests swap it) hands back
// { base64, name }; the image then rides the cursor and a click places its centre ("Place Image", selected).  A file
// that is not an image: KiCad's "Could not load image from '…'." and the tool waits for the next click.
export function loadImage(ctx: PcbCtx, res: PickedImage | null) {
  if (!res || !res.base64) return;                                   // the file dialog was cancelled
  const info = imageInfo(base64Bytes(res.base64));
  if (!info) { openForm({ title: "Message", width: 420, fields: [{ type: "note", value: `Could not load image from '${res.name || ""}'.` }] }); return; }
  const [w, h] = imageMm(info); S.image = { base64: res.base64, info, w, h, name: res.name || "", el: null };
  if (typeof Image !== "undefined") { const el = new Image(); el.onload = () => { if (lastCtx) lastCtx.requestRender(); }; el.src = `data:image/${info.type === "jpeg" ? "jpeg" : "png"};base64,${res.base64}`; S.image.el = el; }
  ctx.requestRender();
}
export function openImagePicker() { pickerImpl((res: PickedImage | null) => { if (lastCtx && S.modTool === "image") loadImage(lastCtx, res); }); }
export function placeImage(ctx: PcbCtx, hv: Pick<Hover, "x" | "y">) {
  const img = S.image; S.image = null;
  const c = addedChange(ctx.doc, imageNode(hv.x, hv.y, img!.base64, S.gfxLayer));
  ctx.commit([c], "Place Image"); applySelection(ctx, [c.id]); ctx.requestRender();
}
/** The inline prompt: done(text) on Enter ("" allowed), done(null) on Escape or blur. */
export function askText(ctx: PcbCtx, title: string, initial: string | null | undefined, done: (v: string | null) => void, options?: string[] | null) { promptImpl(title, initial || "", S.client!, (v: string | null) => { S.text = null; done(v); }, options || null); }
