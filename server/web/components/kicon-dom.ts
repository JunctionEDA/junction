// components/kicon-dom.ts — KiCad's icon pack in the parts of the editor built without React: the icon itself (the web
// icon pack derived from resources/bitmaps_png, published by ui.js as window.KiCadIconFor; light and dark variants
// follow the theme, and an icon asked for before the pack is in fills in when it arrives), wxWidgets' BITMAP_BUTTON /
// STD_BITMAP_BUTTON (small_plus, small_up, small_down, small_trash, small_edit, small_refresh, small_folder,
// small_library, config…), the toggle kind the text formatting bars use (text_bold, text_italic, text_align_*…) and
// their separators.  Every plain-DOM dialog draws its bitmaps through here, never from text glyphs.
import type { IconSpec } from "../spec";

interface IconGlobals { KiCadIconFor?: (name: string) => IconSpec | undefined; KiCadIconsReady?: Promise<void> }
const G = (): IconGlobals => (typeof window === "undefined" ? {} : window as unknown as IconGlobals);
const NS = "http://www.w3.org/2000/svg";
const CSS = `
.kic{flex:none;vertical-align:middle}
.kic .dk{display:none}
:root[data-theme="dark"] .kic .lt{display:none} :root[data-theme="dark"] .kic .dk{display:inline}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .kic .lt{display:none} :root:not([data-theme="light"]) .kic .dk{display:inline}}
:root[data-theme="dark"]{--kic-lt:none;--kic-dk:inline}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--kic-lt:none;--kic-dk:inline}}
.kbmp{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:24px;padding:0;border:1px solid var(--line);border-radius:var(--r-2,3px);background:var(--panel);color:var(--ink);cursor:pointer}
.kbmp>.kic{display:block}
.kbmp:hover:not(:disabled){border-color:var(--line-2);background:var(--paper)}
.kbmp:disabled{opacity:.4;cursor:default}
.kbmp.flat{border-color:transparent;background:transparent}
.kbmp.flat:hover:not(:disabled){border-color:var(--line)}
.kbmp.on,.kbmp[aria-pressed="true"]{background:var(--on,var(--sel-soft));border-color:var(--on-line,var(--sel))}
.kbmp-sep{flex:none;width:1px;height:18px;margin:0 4px;background:var(--line);align-self:center}
.kbmp-bar{display:flex;align-items:center;gap:2px;flex-wrap:wrap}
`;
let styled = false;
export function ensureIconCss(): void {
  if (styled || typeof document === "undefined") return; styled = true;
  const st = document.createElement("style"); st.id = "kicon-css"; st.textContent = CSS; document.head.appendChild(st);
}
function fill(el: SVGSVGElement, ic: IconSpec): void {
  el.setAttribute("viewBox", ic.vb || "0 0 24 24");
  el.innerHTML = `<g class="lt">${ic.light || ic.dark || ""}</g><g class="dk">${ic.dark || ic.light || ""}</g>`;
  el.dataset.icon = el.dataset.want || "";
}

/** KiCad's icon `name` as an inline SVG, `size` px square (16 for the dialog bitmap buttons, as KiCad's small_* are). */
export function kicadIcon(name: string, size = 16): SVGSVGElement {
  ensureIconCss();
  const el = document.createElementNS(NS, "svg") as SVGSVGElement;
  el.setAttribute("class", "kic kicon-dom"); el.setAttribute("aria-hidden", "true"); el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size)); el.setAttribute("height", String(size));
  setKicadIcon(el, name);
  return el;
}

/** Point an icon made by kicadIcon at another of KiCad's icons (TEXT_BUTTON_URL::UpdateButtonBitmaps). */
export function setKicadIcon(el: SVGSVGElement, name: string): void {
  if (el.dataset.want === name && el.dataset.icon === name) return;
  el.dataset.want = name; el.dataset.icon = name;
  const g = G(), ic = g.KiCadIconFor ? g.KiCadIconFor(name) : undefined;
  if (ic) { fill(el, ic); return; }
  if (g.KiCadIconsReady) void g.KiCadIconsReady.then(() => { if (el.dataset.want !== name) return; const i = G().KiCadIconFor?.(name); if (i) fill(el, i); }).catch(() => undefined);
}

export interface BmpOpts { id?: string; key?: string; flat?: boolean; disabled?: boolean; size?: number; cls?: string }
/** STD_BITMAP_BUTTON / BITMAP_BUTTON: a small themed button (.kbmp) showing one of KiCad's bitmaps; `title` is its tooltip (and accessible name). */
export function bitmapButton(icon: string, title: string, onClick: ((ev: MouseEvent) => void) | null, opts?: BmpOpts): HTMLButtonElement {
  ensureIconCss();
  const b = document.createElement("button");
  b.type = "button"; b.className = "kbmp" + (opts?.flat ? " flat" : "") + (opts?.cls ? " " + opts.cls : "");
  b.title = title; b.setAttribute("aria-label", title.split("\n")[0]); b.dataset.icon = icon;
  if (opts?.id) b.id = opts.id; if (opts?.key) b.dataset.k = opts.key; if (opts?.disabled) b.disabled = true;
  b.appendChild(kicadIcon(icon, opts?.size || 16));
  if (onClick) b.addEventListener("click", (ev) => onClick(ev));
  return b;
}

/** BITMAP_BUTTON with IsToggle / SetIsCheckButton: pressed state in aria-pressed; `onToggle` gets the new state. */
export function bitmapToggle(icon: string, title: string, on: boolean, onToggle?: (on: boolean) => void, opts?: BmpOpts): HTMLButtonElement & { setOn(v: boolean): void; isOn(): boolean } {
  const b = bitmapButton(icon, title, null, Object.assign({ flat: true }, opts)) as HTMLButtonElement & { setOn(v: boolean): void; isOn(): boolean };
  b.setOn = (v: boolean) => { b.setAttribute("aria-pressed", String(!!v)); b.classList.toggle("on", !!v); };
  b.isOn = () => b.getAttribute("aria-pressed") === "true";
  b.setOn(on);
  b.addEventListener("click", () => { if (b.disabled) return; b.setOn(!b.isOn()); if (onToggle) onToggle(b.isOn()); });
  return b;
}

/**
 * A group of BITMAP_BUTTONs that act as radio items (text alignment, label orientation): one is pressed.
 * `items` = [value, icon, tooltip]; returns the buttons in a bar with value() / set(v).
 */
export function bitmapRadio(items: [string, string, string][], value: string, onChange?: (v: string) => void, opts?: { key?: string }): { el: HTMLElement; buttons: HTMLButtonElement[]; value(): string; set(v: string): void } {
  ensureIconCss();
  let cur = value;
  const bar = document.createElement("span"); bar.className = "kbmp-bar"; if (opts?.key) bar.dataset.k = opts.key;
  const buttons = items.map(([v, icon, tip]) => {
    const b = bitmapButton(icon, tip, () => { set(v); if (onChange) onChange(v); }, { flat: true }); b.dataset.v = v; bar.appendChild(b); return b;
  });
  function set(v: string): void { cur = v; for (const b of buttons) { const on = b.dataset.v === v; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); } }
  set(cur);
  return { el: bar, buttons, value: () => cur, set };
}

/** The separator BITMAP_BUTTON KiCad puts between groups of a formatting bar (SetIsSeparator). */
export function bitmapSeparator(): HTMLSpanElement { ensureIconCss(); const s = document.createElement("span"); s.className = "kbmp-sep"; s.setAttribute("aria-hidden", "true"); return s; }
