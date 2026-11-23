// components/colorswatch.ts — KiCad's COLOR_SWATCH (common/widgets/color_swatch.cpp) for the plain-DOM dialogs: a
// bordered swatch showing the colour over the checkerboard where it is translucent (COLOR_SWATCH::MakeBitmap), the
// checkerboard alone for COLOR4D::UNSPECIFIED; a click opens DIALOG_COLOR_PICKER (GetNewSwatchColor).  Never a
// browser-native colour input.
import { colorPicker, fromHex, toHex, type RGBA } from "../../domains/pcb/editor/pcbdialogs/color-picker";

export type { RGBA };
export interface SwatchOpts {
  /** DIALOG_COLOR_PICKER's opacity slider (aAllowOpacityControl) */
  opacity?: boolean;
  /** the picker's Reset to Default colour; null is UNSPECIFIED (its Clear Color) */
  def?: RGBA | null;
  /** called after the picker's OK changed the colour */
  onChange?(c: RGBA | null): void;
  id?: string; title?: string; key?: string;
  /** swatch size in pixels (KiCad's default swatch is 24 x 14 in dialogs) */
  w?: number; h?: number;
  /** a swatch that only shows its colour (COLOR_SWATCH::SetReadOnly) */
  readOnly?: boolean;
  /** the swatch background the checkerboard is derived from (COLOR_SWATCH::SetSwatchBackground) */
  background?: RGBA;
  /** open the picker on double-click / middle-click only, as the appearance panels do (SWATCH_EXPAND) */
  doubleClick?: boolean;
  /** pick the colour another way (a caller-provided picker, e.g. outside the editor bundle) */
  pick?(current: RGBA | null, allowOpacity: boolean, done: (c: RGBA) => void, def: RGBA | null): void;
}
export interface Swatch { el: HTMLSpanElement; get(): RGBA | null; set(c: RGBA | null): void; open(): void; /** wxWindow::Enable */ setDisabled(on: boolean): void }

const b255 = (x: number): number => Math.max(0, Math.min(255, Math.round(x * 255)));
const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 }, WHITE: RGBA = { r: 1, g: 1, b: 1, a: 1 };
/** COLOR4D::GetBrightness (the weighted W3C formula). */
const brightness = (c: RGBA): number => c.r * 0.299 + c.g * 0.587 + c.b * 0.117;
const css = (c: RGBA): string => `rgb(${b255(c.r)},${b255(c.g)},${b255(c.b)})`;
/**
 * COLOR_SWATCH::MakeBitmap's checkerboard: over a light background (brightness > 0.4) the background and the
 * background Darkened( 0.15 ); otherwise black and black Brightened( 0.15 ).  The base is the swatch background, or,
 * for UNSPECIFIED, WHITE / BLACK chosen by the parent window's background.
 */
export function checkerboard(base: RGBA): string {
  let white: RGBA, black: RGBA;
  if (brightness(base) > 0.4) { white = base; black = { r: white.r * 0.85, g: white.g * 0.85, b: white.b * 0.85, a: 1 }; }
  else { black = BLACK; white = { r: 0.15, g: 0.15, b: 0.15, a: 1 }; }
  return `repeating-conic-gradient(${css(black)} 0 25%, ${css(white)} 0 50%) 0 0 / 8px 8px`;
}
/**
 * The CSS background of a swatch: the colour, blended over the checkerboard when it is translucent.  `background` is
 * the swatch background (COLOR_SWATCH's aBackground, a default COLOR4D is opaque black); `parentBg` is the parent
 * window's background, used for UNSPECIFIED (m_checkerboardBg).
 */
export function swatchBackground(c: RGBA | null, background: RGBA = BLACK, parentBg: RGBA = WHITE): string {
  if (!c) return checkerboard(brightness(parentBg) > 0.4 ? WHITE : BLACK);
  const rgba = `rgba(${b255(c.r)},${b255(c.g)},${b255(c.b)},${Math.max(0, Math.min(1, c.a))})`;
  return c.a >= 1 ? rgba : `linear-gradient(${rgba},${rgba}),${checkerboard(background)}`;
}
/** The page's background colour (the parent window's background), white when it cannot be read. */
function pageBackground(el: HTMLElement): RGBA {
  try {
    for (let n: HTMLElement | null = el.parentElement || document.body; n; n = n.parentElement) {
      const c = parseColor(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) return c;
    }
  } catch { /* not in a document */ }
  return WHITE;
}
/** "#rrggbb" / "#rrggbbaa" / "rgb(a)(…)" to RGBA (null when it is none of them). */
export function parseColor(text: string | null | undefined): RGBA | null {
  if (!text) return null;
  const t = text.trim();
  if (t.startsWith("#")) return fromHex(t.length === 7 ? t + "FF" : t);
  const m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\s*\)$/i.exec(t);
  if (!m) return null;
  return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: m[4] === undefined ? 1 : +m[4] };
}
/** RGBA to "#rrggbb" (opaque) or "#rrggbbaa". */
export function colorText(c: RGBA): string { const x = toHex(c).toLowerCase(); return c.a >= 1 ? x.slice(0, 7) : x; }
/** RGBA to the CSS rgba() a canvas takes. */
export function cssColor(c: RGBA): string { return `rgba(${b255(c.r)},${b255(c.g)},${b255(c.b)},${+c.a.toFixed(3)})`; }

export function colorSwatch(init: RGBA | null, opts: SwatchOpts = {}): Swatch {
  let cur = init ? { ...init } : null;
  const w = opts.w ?? 24, hh = opts.h ?? 14;
  const el = document.createElement("span");
  el.className = "k-swatch";
  if (opts.id) el.id = opts.id;
  if (opts.key) el.dataset.k = opts.key;
  el.tabIndex = opts.readOnly ? -1 : 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", opts.title || "Color");
  el.style.cssText = `display:inline-block;flex:none;width:${w}px;height:${hh}px;border:1px solid var(--ink-3);border-radius:2px;vertical-align:middle;box-sizing:border-box;cursor:${opts.readOnly ? "default" : "pointer"}`;
  const paint = (): void => { el.style.background = swatchBackground(cur, opts.background, cur ? WHITE : pageBackground(el)); el.title = opts.title || (cur ? colorText(cur) : "Unspecified"); el.dataset.color = cur ? colorText(cur) : ""; };
  let disabled = false;
  const open = (): void => {
    if (opts.readOnly || disabled) return;
    const pick = opts.pick || colorPicker;
    pick(cur, !!opts.opacity, (c) => {
      cur = c.r === 0 && c.g === 0 && c.b === 0 && c.a === 0 && opts.def === null ? null : { ...c };
      paint(); if (opts.onChange) opts.onChange(cur);
    }, opts.def === undefined ? null : opts.def);
  };
  if (opts.doubleClick) {
    el.addEventListener("dblclick", (ev) => { ev.preventDefault(); ev.stopPropagation(); open(); });
  } else el.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); open(); });
  // wxEVT_MIDDLE_DOWN opens the picker in every mode
  el.addEventListener("mousedown", (ev) => { if (ev.button === 1) ev.preventDefault(); });
  el.addEventListener("auxclick", (ev) => { if (ev.button === 1) { ev.preventDefault(); ev.stopPropagation(); open(); } });
  el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
  paint();
  const setDisabled = (on: boolean): void => { disabled = on; el.style.opacity = on ? "0.4" : ""; el.style.cursor = on || opts.readOnly ? "default" : "pointer"; el.setAttribute("aria-disabled", on ? "true" : "false"); };
  return { el, get: () => (cur ? { ...cur } : null), set(c) { cur = c ? { ...c } : null; paint(); }, open, setDisabled };
}
