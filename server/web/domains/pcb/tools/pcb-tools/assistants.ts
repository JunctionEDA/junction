// pcb-tools/assistants.ts — the drawing assistants (dimension labels, status popups), text placement and cancelling what is in flight.
import type { DrawState, PcbCtx, Pt } from "./types";

/** An editor dialog for a new item: it edits the node and hands it back, or null on Cancel. */
export type NewItemDialog = (ctx: PcbCtx, node: SNode, done: (node: SNode | null) => void) => void;
import { addedChange } from "./changes";
import { closeTextPrompt } from "./dom";
import { askText, drawOriginSync } from "./draw-tools";
import { sizeUnits } from "./edit-commands";
import { applySelection } from "./groups";
import { barcodeAllowed, barcodeNode, BARCODE_NEEDS_VERSION_MSG, textNode } from "./nodes";
import { line } from "./overlay";
import { editHandleUp } from "./point-editor";
import { routeUnhighlight } from "./route-fix";
import { restoreActiveLayer } from "./route-tool";
import { beginCarryMove, finishSelectMove } from "./select-move";
import { K, S, lastCtx } from "./state";
import { vsub } from "./util";

/** STATUS_TEXT_POPUP::PopupFor: a one-line note 20 px right of and below the cursor that goes away by itself. */
export function statusPopup(ctx: PcbCtx, text: string, at: Pt, ms: number) {
  S.popup = { text, at: at.slice(), until: Date.now() + ms }; ctx.requestRender();
  if (typeof setTimeout === "function") setTimeout(() => { if (S.popup && Date.now() >= S.popup.until - 5) { S.popup = null; if (lastCtx) lastCtx.requestRender(); } }, ms);
}
/** KIGFX::PREVIEW::DimensionLabel: "l: 12.345 mm", at the preview precision of the user's units. */
export function dimensionLabel(prefix: string, mm: number, deg?: boolean) {
  if (deg) return `${prefix}: ${mm.toFixed(1)}°`;
  const u = sizeUnits();
  return `${prefix}: ${u === "mil" ? (mm / 0.0254).toFixed(1) + " mils" : u === "in" ? (mm / 25.4).toFixed(4) + " in" : mm.toFixed(3) + " mm"}`;
}
/**
 * TWO_POINT_ASSISTANT::ViewDraw: next to the cursor, on the side away from the origin, a line shows its length and
 * angle (+90° up), a rectangle its width and height, a circle its radius (with the radius line drawn).
 */
export function drawTwoPointAssistant(c: CanvasRenderingContext2D, d: DrawState, px: number, colour: string) {
  const t = d.shape; if ((t !== "gline" && t !== "grect" && t !== "gcircle") || !d.cur) return;
  const o = d.start, e = d.cur, v = vsub(e, o); if (!v[0] && !v[1]) return;
  const strs = t === "gline" ? [dimensionLabel("l", Math.hypot(v[0], v[1])), dimensionLabel("θ", Math.atan2(-v[1], v[0]) * 180 / Math.PI, true)]
    : t === "grect" ? [dimensionLabel("x", Math.abs(v[0])), dimensionLabel("y", Math.abs(v[1]))] : [dimensionLabel("r", Math.hypot(v[0], v[1]))];
  if (t === "gcircle") { c.save(); c.globalAlpha = 1; c.lineWidth = px; c.strokeStyle = AUX_ITEMS_COLOR; line(c, o, e); c.restore(); }   // DRAW_CONTEXT::DrawLine in LAYER_AUX_ITEMS
  textNextToCursor(c, e, vsub(o, e), strs, px, colour);   // DrawTextNextToCursor( end, origin - end )
}
/** LAYER_AUX_ITEMS of the board editor's theme: what the drawing assistants write and rule in. */
export const AUX_ITEMS_COLOR = "#FFFFFF";
/** KIGFX::PREVIEW::GetConstantGlyphHeight( gal, 0 ): the glyph height in pixels, and the stroke, shadow and line pitch factors (HiDPI canvases use the smaller set). */
export function previewTextDims() {
  const hidpi = typeof devicePixelRatio === "number" && devicePixelRatio > 1;
  return hidpi ? { height: 11, stroke: 0.15, shadow: 0.10, pitch: 1.7 } : { height: 14, stroke: 0.2, shadow: 0.15, pitch: 1.9 };
}
/**
 * KIGFX::PREVIEW::DrawTextNextToCursor: the lines beside the cursor, on the side away from aTextQuadrant, a constant
 * size on screen, in KiCad's stroke font and LAYER_AUX_ITEMS, drawn twice as the GAL draws the two overlay layers: the
 * drop shadow (GetShadowColor, the stroke widened by 2 x the shadow width, shifted by 1.2 x the shadow width), then the
 * text; 15 px off the cursor, one line pitch per string, top to bottom; left / right swapped and the text kept readable
 * in a flipped view (gal->IsFlippedX()).
 */
export function textNextToCursor(c: CanvasRenderingContext2D, e: Pt, q: Pt, strs: string[], px: number, colour?: string) {
  void colour;   // the layer colour the callers have: the assistant's text is always LAYER_AUX_ITEMS
  const stroke = K.drawStrokeText as (ctx: CanvasRenderingContext2D, base: number[], t: Record<string, unknown>, color: string, minPen: number) => void;
  const m = c.getTransform(), base = [m.a, m.b, m.c, m.d, m.e, m.f], flipped = m.a < 0;
  const dims = previewTextDims(), size = dims.height * px, pen = size * dims.stroke, pitch = size * dims.pitch, shadowW = size * dims.shadow;
  c.save(); c.globalAlpha = 1; c.setLineDash([]);
  for (const shadow of [true, false]) {
    let x = e[0], y = e[1];
    if (q[1] > 0) y -= pitch * (strs.length + 1);
    let h: "left" | "right";
    if (q[0] < 0) { h = flipped ? "right" : "left"; x += 15 * px; } else { h = flipped ? "left" : "right"; x -= 15 * px; }
    // an int in IU (nm), scaled by 1.2 and truncated again
    const sx = shadow ? Math.trunc(Math.trunc(shadowW * 1e6) * 1.2) / 1e6 : 0;
    x += (h === "left") !== flipped ? -sx : sx;
    const color = shadow ? "#000000" : AUX_ITEMS_COLOR;   // GetShadowColor( white ): black
    for (const str of strs) {
      y += pitch;
      stroke(c, base, { x, y, text: str, size, rot: 0, mirror: flipped, h, v: "center", pen: shadow ? pen + 2 * shadowW : pen, italic: false, dy: 0 }, color, px);
    }
  }
  c.restore();
}
export function drawStatusPopup(c: CanvasRenderingContext2D, px: number) {
  const p = S.popup; if (!p) return;
  if (Date.now() > p.until) { S.popup = null; return; }
  const css = (name: string, dflt: string) => { try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || dflt; } catch (e) { return dflt; } };
  const fs = 12 * px, m = 5 * px; c.save(); c.globalAlpha = 1; c.font = `${fs}px sans-serif`;
  const lines = p.text.split("\n"), lh = fs * 1.3;   // STATUS_TEXT_POPUP takes several lines ("Click on pad 1\nPress <esc> …")
  const w = Math.max(...lines.map((l) => c.measureText(l).width)) + 2 * m, h = fs + (lines.length - 1) * lh + 2 * m, x = p.at[0] + 20 * px, y = p.at[1] + 20 * px;
  c.fillStyle = css("--panel", "#2b2b2b"); c.strokeStyle = css("--line", "#555"); c.lineWidth = px; c.fillRect(x, y, w, h); c.strokeRect(x, y, w, h);
  c.fillStyle = css("--ink", "#e0e0e0"); c.textBaseline = "top"; lines.forEach((l, i) => c.fillText(l, x + m, y + m + i * lh)); c.restore();
}
/**
 * PCB_PICKER_TOOL's STATUS_TEXT_POPUP: the picker's prompt in a small box that follows the mouse, 20 px right of it
 * and 50 px above (statusPopup.Move( mouse + wxPoint( 20, -50 ) )).
 */
export function drawPickerPrompt(c: CanvasRenderingContext2D, px: number) {
  // a two-point pick (pickTwoPoints) shows its prompt in its own status popup (S.popup), not a second time here
  const pk = S.pick, at = S.hover; if (!pk || !pk.prompt || pk.two || !at || (S.modTool !== "pickpoint" && S.modTool !== "pickitem")) return;
  const css = (name: string, dflt: string) => { try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || dflt; } catch (e) { return dflt; } };
  const fs = 12 * px, m = 5 * px; c.save(); c.globalAlpha = 1; c.setLineDash([]); c.font = `${fs}px sans-serif`;
  const w = c.measureText(pk.prompt).width + 2 * m, h = fs + 2 * m, x = at.x + 20 * px, y = at.y - 50 * px;
  c.fillStyle = css("--panel", "#2b2b2b"); c.strokeStyle = css("--line", "#555"); c.lineWidth = px; c.fillRect(x, y, w, h); c.strokeRect(x, y, w, h);
  c.fillStyle = css("--ink", "#e0e0e0"); c.textBaseline = "top"; c.textAlign = "left"; c.fillText(pk.prompt, x + m, y + m); c.restore();
}
export function placeText(ctx: PcbCtx, mm: Pt, text: string) { ctx.commit([addedChange(ctx.doc, textNode(text, mm[0], mm[1], S.gfxLayer))], "text"); }
// the editor's dialogs for a new item (pcbdialogs/item-props.ts): kind -> (ctx, node, done(node | null))
export let newItemDialogs: Record<string, NewItemDialog | undefined> = {};
/**
 * DRAWING_TOOL::PlaceText: the click makes a PCB_TEXT on the active layer with the layer class's size and thickness
 * (Board Setup's text defaults), left / bottom justified and mirrored on a back layer, and opens Text Properties on
 * it.  OK with printable text: the text hangs on the cursor until the next click places it ("Draw Text", selected);
 * placed at once when the dialog changed its position.  Cancel or blank text: nothing.
 */
export function placeTextAt(ctx: PcbCtx, at: Pt) {
  if (ctx.viewOnly || S.move) return;
  const dlg = newItemDialogs.gr_text;
  if (!dlg) { askText(ctx, "Text", "", (v: string | null) => { if (v) placeText(ctx, at, v); }); return; }
  applySelection(ctx, []);
  dlg(ctx, textNode("", at[0], at[1], S.gfxLayer), (n: SNode | null) => {
    if (!n || !/[^\s]/.test(K.str(n[1]).replace(/\\n/g, ""))) return;   // NoPrintableChars
    const p = K.atOf(n); const moved = Math.abs(p[0] - at[0]) > 1e-9 || Math.abs(p[1] - at[1]) > 1e-9;
    // DRAWING_TOOL::PlaceText: a text left where it was clicked hangs on the cursor and is committed ("Draw Text") by
    // the click that places it; Escape deletes it with nothing to undo (the paste's tentative commit)
    const c = addedChange(ctx.doc, n); ctx.commit([c], "Draw Text", moved ? undefined : { tentative: true }); applySelection(ctx, [c.id]);
    if (!moved) beginCarryMove(ctx, { placing: [c.id], origin: at });
    ctx.requestRender();
  });
}
/**
 * DRAWING_TOOL::DrawBarcode: the click makes a PCB_BARCODE on the active layer at the cursor and opens Barcode
 * Properties on it; OK adds it ("Draw Barcode") and selects it, Cancel drops it.  The tool stays armed.
 */
export function placeBarcodeAt(ctx: PcbCtx, at: Pt) {
  if (ctx.viewOnly || S.move || !ctx.doc) return;
  if (!barcodeAllowed(ctx.doc)) { ctx.toast(BARCODE_NEEDS_VERSION_MSG); return; }
  const dlg = newItemDialogs.barcode; if (!dlg) { ctx.toast("Barcode Properties: dialogs are unavailable here"); return; }
  applySelection(ctx, []);
  dlg(ctx, barcodeNode(at[0], at[1], S.gfxLayer), (n: SNode | null) => {
    if (!n) return;
    const c = addedChange(ctx.doc, n); ctx.commit([c], "Draw Barcode"); applySelection(ctx, [c.id]); ctx.requestRender();
  });
}
export function cancelOps() { if (S.drag && lastCtx && lastCtx.doc) { const D = S.drag; S.drag = null; routeUnhighlight(lastCtx, D.subs[0]); } if (S.route) { K.pcbSizes.state.endRoute(); const rt = S.route; S.route = null; restoreActiveLayer(lastCtx && lastCtx.doc ? lastCtx : null, rt); if (lastCtx && lastCtx.doc) routeUnhighlight(lastCtx, rt); } S.violations = null; S.routeQueue = null; S.draw = null; drawOriginSync(lastCtx); S.drag = null; S.image = null; S.pending = null; if (S.move && lastCtx) finishSelectMove(lastCtx, false); S.move = null; if (S.pedit && lastCtx) editHandleUp(lastCtx, false); closeTextPrompt(); if (S.tune) S.tune.pattern = null; }
/** pcb.setNewItemDialogs: the editor's dialogs for a new item. */
export function setNewItemDialogsImpl(d: Record<string, NewItemDialog | undefined>) { newItemDialogs = d; }
