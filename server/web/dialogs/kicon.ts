// dialogs/kicon.ts — KiCad's icon pack in plain-DOM dialogs: the icon itself (light and dark variants, filled in
// when the pack arrives), wxWidgets' BITMAP_BUTTON / STD_BITMAP_BUTTON (small_plus, small_up, small_down,
// small_trash, small_edit, small_refresh, small_folder, small_library, config…), the toggle kind the text
// formatting bars use (text_bold, text_italic, text_align_*…) and their separators.  The icons come from
// window.KiCadIconFor (ui.js publishes SPEC.icons + the fetched kicad-icons.json), never from text glyphs.
interface IconSpec { vb?: string; light?: string; dark?: string }
interface IconGlobals { KiCadIconFor?: (name: string) => IconSpec | undefined; KiCadIconsReady?: Promise<void> }
const G = (): IconGlobals => (typeof window === "undefined" ? {} : (window as unknown as IconGlobals));

const NS = "http://www.w3.org/2000/svg";
const CSS = `
.kic{display:block;flex:none}
.kic .dk{display:none}
:root[data-theme="dark"] .kic .lt{display:none} :root[data-theme="dark"] .kic .dk{display:inline}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .kic .lt{display:none} :root:not([data-theme="light"]) .kic .dk{display:inline}}
:root[data-theme="dark"]{--kic-lt:none;--kic-dk:inline}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--kic-lt:none;--kic-dk:inline}}
.kbmp{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:24px;padding:0;border:1px solid var(--line);border-radius:var(--r-2,3px);background:var(--panel);color:var(--ink);cursor:pointer}
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

const waiting = new Set<{ el: SVGSVGElement; name: string }>();
let hooked = false;
function fill(el: SVGSVGElement, ic: IconSpec): void {
  el.setAttribute("viewBox", ic.vb || "0 0 24 24");
  el.innerHTML = `<g class="lt">${ic.light || ic.dark || ""}</g><g class="dk">${ic.dark || ic.light || ""}</g>`;
}

/** KiCad's icon `name` as an inline SVG of `size` px (16 for the dialog bitmap buttons, as KiCad's small_* are). */
export function kicon(name: string, size = 16): SVGSVGElement {
  ensureIconCss();
  const el = document.createElementNS(NS, "svg") as SVGSVGElement;
  el.setAttribute("class", "kic"); el.setAttribute("aria-hidden", "true"); el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size)); el.setAttribute("height", String(size)); el.dataset.icon = name;
  const g = G(), ic = g.KiCadIconFor ? g.KiCadIconFor(name) : undefined;
  if (ic) fill(el, ic);
  else {
    waiting.add({ el, name });
    if (!hooked && g.KiCadIconsReady) {
      hooked = true;
      g.KiCadIconsReady.then(() => { for (const w of waiting) { const i = G().KiCadIconFor?.(w.name); if (i) fill(w.el, i); } waiting.clear(); hooked = false; }).catch(() => undefined);
    }
  }
  return el;
}

export interface BmpOpts { id?: string; key?: string; flat?: boolean; disabled?: boolean; size?: number; cls?: string }
/** STD_BITMAP_BUTTON: a small button showing one icon; `title` is its tooltip (and accessible name). */
export function bitmapButton(icon: string, title: string, onClick: ((ev: MouseEvent) => void) | null, opts?: BmpOpts): HTMLButtonElement {
  ensureIconCss();
  const b = document.createElement("button");
  b.type = "button"; b.className = "kbmp" + (opts?.flat ? " flat" : "") + (opts?.cls ? " " + opts.cls : "");
  b.title = title; b.setAttribute("aria-label", title.split("\n")[0]);
  if (opts?.id) b.id = opts.id; if (opts?.key) b.dataset.k = opts.key; if (opts?.disabled) b.disabled = true;
  b.appendChild(kicon(icon, opts?.size || 16));
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
