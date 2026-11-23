// scrollbars.ts — the canvas scrollbars of "Show scrollbars in editors" (COMMON_SETTINGS appearance.show_scrollbars,
// Preferences > Common, off by default).  EDA_DRAW_PANEL_GAL shows them (wxSHOW_SB_ALWAYS) when the setting is on as
// the canvas is created, so a change takes effect when the editor is opened again (here: the page reloaded).
//
// WX_VIEW_CONTROLS::UpdateScrollbars (wx_view_controls.cpp:1278-1310): one scroll unit per pixel, the thumb a page
// (the canvas size in pixels) long, the scale 2000 units over the viewport, the range the view's boundary at that
// scale plus the thumb, the position the viewport centre's distance from the boundary's left / top edge (from its
// right edge in a mirrored view).  onScroll (838-913): dragging the thumb sets the view centre from the position; a
// line step pans 5 % of the view, a page step 50 %.
//
// The bars float over the stage's right and bottom edges, outside the stage element, so no canvas handler sees them.
import { E } from "./state";
import { applyView, flipMmX, mmH, mmW, mmX0, mmY0, stage, viewFlipped, world } from "./view";

/** VIEW's default boundary (view.cpp:317-325): the whole int range in internal units, the schematic's included. */
export function viewBoundaryMm(iuPerMm: number): { left: number; top: number; width: number; height: number } {
  const pos = -2147483648 / 2, size = 2147483647;
  return { left: pos / iuPerMm, top: pos / iuPerMm, width: size / iuPerMm, height: size / iuPerMm };
}

/** One axis of UpdateScrollbars: the thumb's position, the range (both in scroll units) and the page (thumb) size. */
export function scrollAxis(centre: number, viewSize: number, bLeft: number, bSize: number, pagePx: number, mirrored = false): { pos: number; range: number; page: number; scale: number } {
  const scale = 2e3 / viewSize;
  const pos = Math.trunc((mirrored ? bLeft + bSize - centre : centre - bLeft) * scale);
  return { pos, range: Math.trunc(scale * bSize + pagePx), page: pagePx, scale };
}
/** onScroll's wxEVT_SCROLLWIN_THUMBTRACK: the view centre for a thumb position. */
export function centreForThumb(pos: number, scale: number, bLeft: number, bSize: number, mirrored = false): number {
  return mirrored ? bLeft + bSize - pos / scale : bLeft + pos / scale;
}
/** onScroll's line / page steps: how far (in design units) the centre moves; `up` is LINEUP / PAGEUP (toward the start). */
export function scrollStep(viewSize: number, page: boolean, up: boolean): number { return -(up ? 1 : -1) * (page ? 0.5 : 0.05) * viewSize; }

const SIZE = 12;   // px, the bar's thickness
let bars: { h: HTMLElement; v: HTMLElement; ht: HTMLElement; vt: HTMLElement } | null = null;
let latched: boolean | null = null;

/** The visible design rectangle (mm, x as drawn: flipMmX gives the design x in a flipped view) and the stage's pixel size. */
function viewport(): { x: number; y: number; w: number; h: number; pw: number; ph: number } | null {
  const wr = world.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  if (!(wr.width > 0) || !(sr.width > 0)) return null;
  const x = mmX0() + ((sr.left - wr.left) / wr.width) * mmW(), y = mmY0() + ((sr.top - wr.top) / wr.height) * mmH();
  return { x, y, w: (sr.width / wr.width) * mmW(), h: (sr.height / wr.height) * mmH(), pw: sr.width, ph: sr.height };
}
/** SetCenter( centre ): the design point (design x, as KiCad's view centre) to the middle of the stage. */
function setCentre(cx: number, cy: number): void {
  const w = world.clientWidth, h = (w * mmH()) / mmW();
  E.viewTouched = true;
  E.panX = stage.clientWidth / 2 - ((flipMmX(cx) - mmX0()) / mmW()) * w * E.zoom;
  E.panY = stage.clientHeight / 2 - ((cy - mmY0()) / mmH()) * h * E.zoom;
  applyView();
}

/** Lay the bars out over the stage and move the thumbs to the view (called after every view change). */
export function updateScrollbars(): void {
  if (!bars) return;
  const sr = stage.getBoundingClientRect(), vp = E.kdoc ? viewport() : null;
  const show = !!vp && sr.width > SIZE * 2 && sr.height > SIZE * 2;
  bars.h.style.display = bars.v.style.display = show ? "block" : "none";
  if (!show || !vp) return;
  Object.assign(bars.h.style, { left: sr.left + "px", top: sr.bottom - SIZE + "px", width: sr.width - SIZE + "px", height: SIZE + "px" });
  Object.assign(bars.v.style, { left: sr.right - SIZE + "px", top: sr.top + "px", width: SIZE + "px", height: sr.height - SIZE + "px" });
  const b = viewBoundaryMm(E.IU || 1e6), mir = viewFlipped();
  const ax = scrollAxis(flipMmX(vp.x + vp.w / 2), vp.w, b.left, b.width, vp.pw, mir), ay = scrollAxis(vp.y + vp.h / 2, vp.h, b.top, b.height, vp.ph);
  const place = (thumb: HTMLElement, a: { pos: number; range: number; page: number }, len: number, horiz: boolean): void => {
    const t = Math.max(16, Math.min(len, (len * a.page) / a.range)), span = Math.max(1, a.range - a.page);
    const at = Math.max(0, Math.min(len - t, (a.pos / span) * (len - t)));
    if (horiz) Object.assign(thumb.style, { left: at + "px", width: t + "px", top: "2px", height: SIZE - 4 + "px" });
    else Object.assign(thumb.style, { top: at + "px", height: t + "px", left: "2px", width: SIZE - 4 + "px" });
  };
  place(bars.ht, ax, sr.width - SIZE, true); place(bars.vt, ay, sr.height - SIZE, false);
}

/** A press on a bar: on the thumb it drags (THUMBTRACK), elsewhere a page step toward the press (PAGEUP / PAGEDOWN). */
function onBarDown(ev: PointerEvent, horiz: boolean): void {
  if (ev.button !== 0 || !bars) return;
  ev.preventDefault(); ev.stopPropagation();
  const vp = viewport(); if (!vp) return;
  const bar = horiz ? bars.h : bars.v, thumb = horiz ? bars.ht : bars.vt, tr = thumb.getBoundingClientRect(), br = bar.getBoundingClientRect();
  const b = viewBoundaryMm(E.IU || 1e6), mir = horiz && viewFlipped();
  const cx = flipMmX(vp.x + vp.w / 2), cy = vp.y + vp.h / 2;
  if (ev.target !== thumb) {
    // a page step moves the view centre in design coordinates, mirrored view or not (onScroll does not flip it)
    const up = horiz ? ev.clientX < tr.left : ev.clientY < tr.top;
    const d = scrollStep(horiz ? vp.w : vp.h, true, up);
    if (horiz) setCentre(cx + d, cy); else setCentre(cx, cy + d);
    return;
  }
  const a = horiz ? scrollAxis(cx, vp.w, b.left, b.width, vp.pw, mir) : scrollAxis(cy, vp.h, b.top, b.height, vp.ph);
  const len = (horiz ? br.width : br.height), t = horiz ? tr.width : tr.height, span = Math.max(1, a.range - a.page);
  const start = horiz ? ev.clientX : ev.clientY, pos0 = a.pos;
  try { thumb.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
  const move = (e: PointerEvent): void => {
    const px = (horiz ? e.clientX : e.clientY) - start;
    const pos = Math.max(0, Math.min(span, pos0 + (px / Math.max(1, len - t)) * span));
    const c = centreForThumb(pos, a.scale, horiz ? b.left : b.top, horiz ? b.width : b.height, mir);
    if (horiz) setCentre(c, cy); else setCentre(cx, c);
  };
  const up = (): void => { thumb.removeEventListener("pointermove", move); thumb.removeEventListener("pointerup", up); thumb.removeEventListener("pointercancel", up); };
  thumb.addEventListener("pointermove", move); thumb.addEventListener("pointerup", up); thumb.addEventListener("pointercancel", up);
}

/**
 * EDA_DRAW_PANEL_GAL's constructor: the scrollbars show when the setting is on as the canvas is made.  The first call
 * decides; later calls (the preference changed) wait for the next opening, as KiCad's tooltip says.
 */
export function initScrollbars(show: boolean): void {
  if (latched !== null || typeof document === "undefined") return;
  latched = show; if (!show) return;
  const mk = (horiz: boolean): [HTMLElement, HTMLElement] => {
    const bar = document.createElement("div"), thumb = document.createElement("div");
    bar.className = "kc-scrollbar"; bar.setAttribute("aria-hidden", "true");
    Object.assign(bar.style, { position: "fixed", zIndex: "5", display: "none", background: "var(--bg-2, rgba(128,128,128,.12))", borderTop: horiz ? "1px solid var(--line, rgba(128,128,128,.3))" : "", borderLeft: horiz ? "" : "1px solid var(--line, rgba(128,128,128,.3))", boxSizing: "border-box" });
    Object.assign(thumb.style, { position: "absolute", borderRadius: "4px", background: "var(--ink-3, rgba(128,128,128,.6))" });
    bar.append(thumb); document.body.append(bar);
    bar.addEventListener("pointerdown", (ev) => onBarDown(ev, horiz));
    // the wheel over a bar: a line step per event (LINEUP / LINEDOWN, 5 % of the view)
    bar.addEventListener("wheel", (ev) => {
      ev.preventDefault(); const vp = viewport(); const dl = horiz ? ev.deltaX || ev.deltaY : ev.deltaY; if (!vp || !dl) return;
      const cx = flipMmX(vp.x + vp.w / 2), cy = vp.y + vp.h / 2, d = scrollStep(horiz ? vp.w : vp.h, false, dl < 0);
      if (horiz) setCentre(cx + d, cy); else setCentre(cx, cy + d);
    }, { passive: false });
    return [bar, thumb];
  };
  const [h, ht] = mk(true), [v, vt] = mk(false);
  bars = { h, v, ht, vt };
  try { new ResizeObserver(() => updateScrollbars()).observe(stage); } catch { /* no observer: the next view change lays them out */ }
  window.addEventListener("resize", () => updateScrollbars());
  updateScrollbars();
}