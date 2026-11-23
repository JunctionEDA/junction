// crosshair.ts — KiCad's canvas cursor, drawn over the canvas at the snapped cursor position.
//
// It has a canvas of its own (#cursorCanvas, over #canvas, the same size in device pixels): a pointer move that
// only moves the cursor clears and strokes that layer, and never repaints the document.
//
// GAL::DrawCursor: the cursor sits on the grid point the tools will use (not under the mouse), in the
// colour theme's cursor colour, as one of the three View > Crosshair modes:
//  · small  — an 80 px cross ("cursorSize = 80");
//  · full   — horizontal and vertical lines across the whole canvas;
//  · 45     — the two diagonals across the whole canvas (FULLSCREEN_DIAGONAL).
// The system cursor over the canvas is the tool's KICURSOR (cursors.ts).

import { snapMm, gridSizeNow } from "./doc";
import { heldModifiers } from "./cursors";
import { cursorClickEvents, cursorStepOrigin, heldMods } from "./kicad-input";
import { interactionBusy, refreshMouse } from "./gestures";
import { E } from "./state";
import { activeModule } from "./tools";
import { applyView, canvas, flipMmX, isSch, mmH, mmW, mmX0, mmY0, stage, viewFlipped, world } from "./view";
import { IS_MAC } from "../../../shared/keys";

const SMALL = 80;   // OPENGL_GAL::blitCursor: cursorSize = 80 screen (device) pixels

/** The cursor's document position (snapped), or null while the pointer is off the canvas. */
let at: number[] | null = null;
/** Whether `at` is a position a tool forced (ForceCursorPosition) rather than the grid snap of the mouse. */
let forcedAt = false;

/**
 * Where the cursor is drawn for the mouse at `mm`: the point the active tool snapped to (VIEW_CONTROLS::
 * ForceCursorPosition from GRID_HELPER::BestSnapAnchor, the router's snap), else the grid point under the mouse.
 * SCH_TOOL_BASE::InteractiveDelete runs its picker with SetSnapping( false ), so its cursor sits on the pointer.
 */
function cursorPoint(mm: number[]): number[] {
  if (E.kdoc && E.kdoc.type === "sch" && E.tool === "delete") return mm;
  const m = activeModule() as { toolCursorPoint?: () => number[] | null } | null;
  if (m && m.toolCursorPoint) { try { const p = m.toolCursorPoint(); if (p && isFinite(p[0]) && isFinite(p[1])) return p; } catch (e) { /* fall back to the grid */ } }
  return snapMm(mm);
}

/**
 * Draw the cursor for document position `mm` (snapped here) or at the position a tool `forced`, or hide it (null:
 * the pointer left the canvas).  Returns where it is drawn (GetCursorPosition), or null.
 */
export function placeCrosshair(mm: number[] | null, forced?: number[] | null): number[] | null {
  const next = mm && E.kdoc ? (forced || cursorPoint(mm)) : null;
  forcedAt = !!(next && forced);
  if (!next && !at) return null;
  if (next && at && next[0] === at[0] && next[1] === at[1]) return next;
  at = next; requestCursor(); return next;
}

/** Redraw at the last cursor position (after a pan / zoom or a mode change), if the cursor is on the canvas. */
export function refreshCrosshair(): void { if (at && E.lastCursorMm && !forcedAt) at = cursorPoint(E.lastCursorMm); requestCursor(); }

/**
 * GAL::IsCursorEnabled: the cursor shows while a tool draws (VIEW_CONTROLS::ShowCursor) or always with Always Show
 * Crosshairs (GAL_DISPLAY_OPTIONS::m_forceDisplayCursor, Preferences > Display Options > Cursor); the selection tool
 * never turns it on.
 */
export function cursorShown(): boolean { return E.alwaysShowCursor !== false || cursorEnabled(); }
/**
 * VIEW_CONTROLS::ShowCursor( true ) (GAL::m_isCursorEnabled): every tool but the idle selection tool turns the cursor
 * on, and the selection tool does while it moves or drags something.
 */
export function cursorEnabled(): boolean { return (E.tool !== "select" && E.tool !== "selection") || interactionBusy(); }

let cursorReq = 0;
/** Redraw the cursor layer on the next frame (several moves in one frame draw once). */
function requestCursor(): void { if (!cursorReq) cursorReq = requestAnimationFrame(() => { cursorReq = 0; drawCursorLayer(); }); }

/**
 * The colour theme's cursor colour: LAYER_SCHEMATIC_CURSOR (KiCad Default #0F0F0F, Classic black) on the
 * schematic, LAYER_CURSOR of the board theme in use on the board (KiCad Default white).
 */
export function cursorColor(): string {
  if (!isSch()) { const B = KiCadCanvas as unknown as { boardColor?: (k: string) => string }; return B.boardColor ? B.boardColor("cursor") : "#FFFFFF"; }
  const K = KiCadCanvas as unknown as { schTheme?: () => string; SCH?: Record<string, string> };
  const id = K.schTheme ? K.schTheme() : "default";
  return id === "classic" ? "#000000" : id === "dark" ? "#E8E8E8" : "#0F0F0F";
}

/**
 * GAL::DrawCursor (OPENGL_GAL::blitCursor): one device pixel wide, in the cursor colour, over everything else — an
 * 80 px cross, full-window lines, or the two full-window diagonals.  The document frame (drawCanvas) calls this too,
 * so the cursor follows a pan or zoom in the same frame.
 */
export function drawCursorLayer(): void {
  const layer = document.getElementById("cursorCanvas") as HTMLCanvasElement | null; if (!layer) return;
  const ctx = layer.getContext("2d"); if (!ctx) return;
  if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height; }
  else ctx.clearRect(0, 0, layer.width, layer.height);
  layer.style.display = E.kdoc ? "block" : "none";
  if (at && E.kdoc && cursorShown()) drawCrosshair(ctx);
}

/** The cursor stroked on `ctx` (a device-pixel canvas over the stage). */
export function drawCrosshair(ctx: CanvasRenderingContext2D): void {
  if (!at || !E.kdoc) return;
  const wr = world.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  if (!(wr.width > 0) || !(wr.height > 0)) return;
  const dpr = window.devicePixelRatio || 1;
  // device pixels, on the pixel centre so a one-pixel line stays crisp
  const x = Math.round((wr.left - sr.left + ((flipMmX(at[0]) - mmX0()) / mmW()) * wr.width) * dpr) + 0.5;
  const y = Math.round((wr.top - sr.top + ((at[1] - mmY0()) / mmH()) * wr.height) * dpr) + 0.5;
  const W = ctx.canvas.width, H = ctx.canvas.height, L = W + H;
  const mode = E.crosshairMode === "full" || E.crosshairMode === "45" ? E.crosshairMode : "small";
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  // GAL::getCursorColor: the cursor is dimmed (alpha × 0.5) when it shows only because it is forced on (Always Show
  // Crosshairs) — a hint that no tool is active
  ctx.globalAlpha = cursorEnabled() ? 1 : 0.5;
  ctx.strokeStyle = cursorColor(); ctx.lineWidth = 1; ctx.setLineDash([]); ctx.beginPath();
  if (mode === "45") { ctx.moveTo(x - L, y - L); ctx.lineTo(x + L, y + L); ctx.moveTo(x - L, y + L); ctx.lineTo(x + L, y - L); }
  else if (mode === "full") { ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  else { ctx.moveTo(x - SMALL / 2, y); ctx.lineTo(x + SMALL / 2, y); ctx.moveTo(x, y - SMALL / 2); ctx.lineTo(x, y + SMALL / 2); }
  ctx.stroke(); ctx.restore();
}

/** The grid size (X, Y) the cursor keys step by: the active tool's grid override, else the grid (mm). */
function gridStep(): [number, number] { const [gx, gy] = gridSizeNow(); return [gx > 0 ? gx : 1, gy > 0 ? gy : 1]; }

/**
 * VIEW_CONTROLS m_lastKeyboardCursorPosition: where the last cursor key put the cursor, while it is valid (null
 * otherwise).  A mouse motion to anywhere else clears it (WX_VIEW_CONTROLS::onMotion, wx_view_controls.cpp:245-259).
 */
let keyboardCursor: number[] | null = null;
const toScreen = (q: number[]): number[] => { const wr = world.getBoundingClientRect(); return [wr.left + ((flipMmX(q[0]) - mmX0()) / mmW()) * wr.width, wr.top + ((q[1] - mmY0()) / mmH()) * wr.height]; };
/** A pointer move reached the canvas (index.ts): one away from the keyboard cursor's screen position clears it. */
export function noteMotion(ev: { clientX: number; clientY: number }): void {
  if (!keyboardCursor) return;
  const k = toScreen(keyboardCursor);
  if (Math.round(k[0]) !== Math.round(ev.clientX) || Math.round(k[1]) !== Math.round(ev.clientY)) keyboardCursor = null;
}
/**
 * SELECTION::GetReferencePoint while the selection has one: the moved items' reference point (EDIT_TOOL /
 * SCH_MOVE_TOOL SetReferencePoint( m_cursor )), or null.  A tool module may answer through referencePoint().
 */
function selectionReferencePoint(): number[] | null {
  const m = activeModule() as { referencePoint?: () => number[] | null; state?: unknown } | null; if (!m) return null;
  if (typeof m.referencePoint === "function") { try { return m.referencePoint(); } catch (e) { return null; } }
  const st = m.state as { move?: { start: number[]; last: number[] } | null; drag?: { anchor0?: number[]; last?: number[] } | null } | undefined;
  if (!st) return null;
  if (!isSch() && st.move && st.move.start && st.move.last) return [st.move.start[0] + st.move.last[0], st.move.start[1] + st.move.last[1]];
  if (isSch() && st.drag && st.drag.anchor0 && st.drag.last) return [st.drag.anchor0[0] + st.drag.last[0], st.drag.anchor0[1] + st.drag.last[1]];
  return null;
}

/**
 * COMMON_TOOLS::CursorControl (Up / Down / Left / Right, ×10 with Ctrl): the cursor moves by grid steps — from the
 * selection's reference point when no cursor key has moved it since the mouse did — and with a mirrored view Left /
 * Right move it the other way in the design, so it goes left / right on screen.  SetCursorPosition( cursor, true,
 * true ) -> WarpMouseCursor: a cursor that would leave the canvas centres the view on it.  The browser cannot warp
 * the mouse, so the move is handed to the canvas as a pointer move at the new position: hover, previews and drags
 * follow it as they do in KiCad.
 */
export function cursorStep(dx: number, dy: number, steps: number): void {
  if (!E.kdoc) return;
  const sr = stage.getBoundingClientRect(), gs = gridStep(), ddx = gs[0] * steps, ddy = gs[1] * steps;
  let from = E.lastCursorMm as number[] | null;
  if (!from) { const wr = world.getBoundingClientRect(); from = [flipMmX(mmX0() + ((sr.left + sr.width / 2 - wr.left) / wr.width) * mmW()), mmY0() + ((sr.top + sr.height / 2 - wr.top) / wr.height) * mmH()]; }
  // GetCursorPosition, or SELECTION::GetReferencePoint when the keyboard position is not valid (kicad-input cursorStepOrigin)
  const here = snapMm(from), rp = keyboardCursor ? null : selectionReferencePoint();
  const s = cursorStepOrigin(keyboardCursor ? here : null, rp && isFinite(rp[0]) && isFinite(rp[1]) ? rp : null, here) as number[];
  const mx = viewFlipped() ? -1 : 1, to = [s[0] + mx * dx * ddx, s[1] + dy * ddy];
  let [x, y] = toScreen(to);
  if (x < sr.left || x > sr.right || y < sr.top || y > sr.bottom) {
    // m_view->SetCenter( position ); WarpPointer( screen centre )
    E.viewTouched = true; E.panX += sr.left + sr.width / 2 - x; E.panY += sr.top + sr.height / 2 - y; applyView();
    [x, y] = toScreen(to);
  }
  keyboardCursor = to.slice();
  // which key moved the cursor, for the length of this one event: a move in progress locks to its axis (tools/axis-lock.ts)
  const g = window as unknown as { KiCadKeyboardCursor?: string | null };
  g.KiCadKeyboardCursor = dx < 0 ? "left" : dx > 0 ? "right" : dy < 0 ? "up" : "down";
  try { stage.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true })); }
  finally { g.KiCadKeyboardCursor = null; }
}

/**
 * COMMON_TOOLS::CursorControl with CURSOR_CLICK / CURSOR_DBL_CLICK (Enter / the Double-click action): a left click
 * (or a double click) of the mouse at the cursor, as if the button had been pressed where the cursor is.  Whatever
 * the active tool does with a click happens: the select tool selects, the wire tool fixes a corner, a placed item
 * drops, the router fixes the head.
 */
export function cursorClick(count: 1 | 2): void {
  if (!E.kdoc) return;
  let mm = E.lastCursorMm as number[] | null;
  const wr = world.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  if (!mm) mm = [flipMmX(mmX0() + ((sr.left + sr.width / 2 - wr.left) / wr.width) * mmW()), mmY0() + ((sr.top + sr.height / 2 - wr.top) / wr.height) * mmH()];
  const x = wr.left + ((flipMmX(mm[0]) - mmX0()) / mmW()) * wr.width, y = wr.top + ((mm[1] - mmY0()) / mmH()) * wr.height;
  // wxGetKeyState( WXK_SHIFT / WXK_CONTROL / WXK_ALT ): the click carries the modifiers held right now
  const mods = heldMods(heldModifiers(), IS_MAC);
  const at = { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true, pointerId: 1, ...mods };
  // CURSOR_DBL_CLICK is one TA_MOUSE_DBLCLICK, no click ahead of it (kicad-input.ts cursorClickEvents)
  for (const [type, detail] of cursorClickEvents(count)) {
    if (type === "pointerdown") stage.dispatchEvent(new PointerEvent(type, { ...at, button: 0, buttons: 1, detail }));
    else if (type === "pointerup") stage.dispatchEvent(new PointerEvent(type, { ...at, button: 0, buttons: 0, detail }));
    else stage.dispatchEvent(new MouseEvent(type, { ...at, button: 0, detail }));
  }
}

/** COMMON_TOOLS::PanControl (Shift + arrows): the view moves by ten steps of the displayed grid (GAL::GetGridSize, never a tool's override). */
export function panStep(dx: number, dy: number): void {
  const gx = E.gridPitch > 0 ? E.gridPitch : 1, gy = E.gridPitchY > 0 ? E.gridPitchY : gx;
  const wr = world.getBoundingClientRect(), ppx = wr.width > 0 ? wr.width / mmW() : 4;
  E.viewTouched = true; E.panX += dx * gx * 10 * ppx; E.panY += dy * gy * 10 * ppx; applyView();
  refreshCrosshair(); refreshMouse();
}
