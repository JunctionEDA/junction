// insert.ts — putting things into a sketch that are not drawn stroke by stroke: text (outlines in a font, whose
// closed letters are regions an extrude can use) and a reference image (a picture on the sketch plane to trace
// over; it makes no geometry).
//
// Text: click where its baseline starts, then how tall its capitals are; a small editor opens at the text for
// what it says and its style (font, bold, italic).  A double click on a text opens the editor again.
// Image: choose a picture file, then click two corners; it keeps its proportions.  It is stored in the sketch,
// scaled down to at most 1024 pixels a side.
import type { Vec2 } from "../core/geometry";
import type { PartStudio } from "../ui/studio";
import { textWidth } from "./curves";
import { startDrawTool, type ShapeSpec } from "./draw";
import { ENTITY_EDITORS, sketchEditor, type SketchEditor } from "./editor";
import type { SketchData, SketchEntity, SketchText } from "./format";
import { pointFor } from "./infer";
import { pointAt } from "./refs";

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];

/** The fonts sketch text can be set in (the outline fonts generated into the bundle). */
export const TEXT_FONTS = ["Source Sans"];

// ---------------------------------------------------------------- text
let lastStyle: { font: string; bold: boolean; italic: boolean } = { font: TEXT_FONTS[0], bold: false, italic: false };

/** The outline of a text box as it would be drawn: baseline at a, capitals h tall, `chars` wide. */
function textBox(a: Vec2, h: number, data: SketchData, text: string): Vec2[] {
  const probe: SketchData = { ...data, entities: { ...data.entities, $a: { type: "point", x: a[0], y: a[1] }, $b: { type: "point", x: a[0], y: a[1] + h }, $t: { type: "text", a: "$a", b: "$b", text, ...lastStyle } } };
  const w = textWidth(probe, probe.entities.$t) || h * text.length * 0.5;
  return [a, [a[0] + w, a[1]], [a[0] + w, a[1] + h], [a[0], a[1] + h], a];
}

export function textTool(studio: PartStudio, toolId: string): ShapeSpec {
  return {
    id: toolId, clicks: 2,
    hint: (n) => (n ? "Move up to set the height of the capitals and click, or type it." : "Click where the text's baseline starts. A double click on a text edits it."),
    context: (pts) => (pts.length ? { relations: false } : {}),
    fields: (pts, c) => [{ key: "height", label: "H", unit: "mm", value: Math.abs(c[1] - pts[0].p[1]) }],
    constrain: (pts, c, typed) => (typed.height !== undefined ? [c[0], pts[0].p[1] + typed.height] : c),
    preview: (pts, c, data) => [textBox(pts[0].p, Math.max(1e-3, Math.abs(c.p[1] - pts[0].p[1])), data, "Text")],
    build(d, pts, typed) {
      const h = typed.height ?? Math.abs(pts[1].p[1] - pts[0].p[1]);
      if (!(h > 1e-6)) return false;
      const a = pointFor(d, pts[0]), b = d.point([pts[0].p[0], pts[0].p[1] + h]);
      d.constrain("vertical", [a, b]);   // upright; the distance from a to b is the height of the capitals
      if (typed.height !== undefined) d.constrain("distance", [a, b], { value: typed.height });
      const id = d.id("t");
      d.set(id, { type: "text", a, b, text: "Text", ...lastStyle, ...(d.construction ? { construction: true } : {}) } as SketchEntity);
      made = id;
      return {};
    },
  };
}
let made: string | null = null;

export function runText(studio: PartStudio, toolId: string): void {
  const ed = sketchEditor(studio);
  if (!ed.getState().open) return;
  made = null;
  const spec = textTool(studio, toolId), build = spec.build;
  spec.build = (d, pts, typed, chain) => {
    const r = build(d, pts, typed, chain);
    // the text is in the sketch: say what it says once this edit is committed
    if (r) window.setTimeout(() => { if (made && ed.getState().data.entities[made]) editText(ed, made); }, 0);
    return r;
  };
  startDrawTool(studio, spec);
}

let panel: HTMLElement | null = null;
/** Open the small editor for a text: what it says, its font, bold and italic.  Enter or ✓ keeps it. */
export function editText(ed: SketchEditor, id: string): void {
  panel?.remove(); panel = null;
  const e0 = ed.getState().data.entities[id] as SketchText | undefined;
  if (!e0 || e0.type !== "text") return;
  const studio = ed.studio, host = studio.viewport.host;
  let style = { font: String(e0.font || TEXT_FONTS[0]), bold: !!e0.bold, italic: !!e0.italic };
  const el = document.createElement("div");
  el.className = "cad-text-editor";
  el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Sketch text");
  el.style.cssText = "position:absolute;z-index:5;display:flex;gap:4px;align-items:center;padding:4px;border:1px solid var(--line);border-radius:var(--r-2);background:var(--panel);box-shadow:var(--shadow);font:var(--fs-sm) var(--sans)";
  const input = document.createElement("input");
  input.className = "input"; input.type = "text"; input.value = String(e0.text || ""); input.spellcheck = false;
  input.setAttribute("aria-label", "Text"); input.style.cssText = "width:180px;height:24px;padding:0 6px";
  const button = (label: string, title: string, on: () => boolean, toggle: () => void) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn sm"; b.textContent = label; b.title = title; b.setAttribute("aria-label", title);
    const show = () => { b.setAttribute("aria-pressed", String(on())); b.style.background = on() ? "var(--mark)" : ""; b.style.color = on() ? "var(--paper)" : ""; };
    b.addEventListener("click", () => { toggle(); show(); preview(); input.focus(); });
    show();
    return b;
  };
  // one font family is built in; it is named, and the faces are the toggles beside it
  const font = document.createElement("span");
  font.textContent = style.font; font.title = "Font"; font.style.cssText = "padding:0 4px;color:var(--ink-2);white-space:nowrap";
  const bold = button("B", "Bold", () => style.bold, () => { style = { ...style, bold: !style.bold }; });
  bold.style.fontWeight = "700";
  const italic = button("I", "Italic", () => style.italic, () => { style = { ...style, italic: !style.italic }; });
  italic.style.fontStyle = "italic";
  const ok = document.createElement("button");
  ok.type = "button"; ok.className = "btn sm primary"; ok.textContent = "✓"; ok.title = "Keep the text (Enter)"; ok.setAttribute("aria-label", "Keep the text");
  el.append(input, font, bold, italic, ok);

  const next = (): SketchText => ({ ...(ed.getState().data.entities[id] as SketchText), text: input.value || " ", ...style });
  const preview = () => { const data = ed.getState().data; if (data.entities[id]) ed.showDraft({ ...data, entities: { ...data.entities, [id]: next() } }); };
  let closed = false;
  const close = (keep: boolean) => {
    if (closed) return;
    closed = true;
    el.remove(); if (panel === el) panel = null;
    ed.showDraft(null);
    if (keep && input.value.trim() && ed.getState().data.entities[id]) {
      lastStyle = { ...style };
      const value = next();
      ed.edit((d) => { d.set(id, value); });
    }
    studio.viewport.canvas.focus();
  };
  input.addEventListener("input", preview);
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") { ev.preventDefault(); close(true); }
    else if (ev.key === "Escape") { ev.preventDefault(); close(false); }
  });
  ok.addEventListener("click", () => close(true));
  for (const t of ["pointerdown", "pointerup", "dblclick", "wheel", "keydown"]) el.addEventListener(t, (ev) => ev.stopPropagation());
  // under the text's baseline
  const a = pointAt(ed.getState().data, e0.a);
  const at = a ? ed.screenOf(a) : { x: 40, y: 40 };
  el.style.left = Math.max(4, Math.round(at.x)) + "px"; el.style.top = Math.round(at.y + 10) + "px";
  host.appendChild(el);
  panel = el;
  window.setTimeout(() => { input.focus(); input.select(); }, 0);
}
ENTITY_EDITORS.text = editText;

// ---------------------------------------------------------------- image
const MAX_SIDE = 1024;

/** A picture file as a data URL, scaled down to at most MAX_SIDE pixels a side, and its proportions. */
async function readPicture(file: File): Promise<{ src: string; aspect: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error("That file is not a picture this browser can read.")); i.src = url; });
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error("That picture is empty.");
    const s = Math.min(1, MAX_SIDE / Math.max(w, h)), cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
    const canvas = document.createElement("canvas"); canvas.width = cw; canvas.height = ch;
    const g = canvas.getContext("2d")!; g.drawImage(img, 0, 0, cw, ch);
    const png = canvas.toDataURL("image/png"), jpeg = canvas.toDataURL("image/jpeg", 0.85);
    return { src: png.length <= jpeg.length * 1.5 ? png : jpeg, aspect: h / w };
  } finally { URL.revokeObjectURL(url); }
}

export function imageTool(toolId: string, src: string, aspect: number): ShapeSpec {
  const corner = (a: Vec2, c: Vec2): Vec2 => { const v = sub(c, a), w = Math.abs(v[0]) || 1e-6; return [a[0] + Math.sign(v[0] || 1) * w, a[1] + Math.sign(v[1] || 1) * w * aspect]; };
  return {
    id: toolId, clicks: 2,
    hint: (n) => (n ? "Click the opposite corner (the picture keeps its proportions), or type its width." : "Click a corner of the picture."),
    context: (pts) => (pts.length ? { relations: false } : {}),
    fields: (pts, c) => [{ key: "width", label: "W", unit: "mm", value: Math.abs(c[0] - pts[0].p[0]) }],
    constrain: (pts, c, typed) => (typed.width !== undefined ? [pts[0].p[0] + Math.sign(c[0] - pts[0].p[0] || 1) * typed.width, c[1]] : c),
    preview: (pts, c) => { const a = pts[0].p, b = corner(a, c.p); return [[a, [b[0], a[1]], b, [a[0], b[1]], a]]; },
    build(d, pts) {
      const a0 = pts[0].p, b0 = corner(a0, pts[1].p);
      if (Math.abs(b0[0] - a0[0]) < 1e-6) return false;
      const a = pointFor(d, pts[0]), b = d.point(b0);
      d.set(d.id("i"), { type: "image", a, b, src, construction: true } as SketchEntity);
      return {};
    },
  };
}

export function runImage(studio: PartStudio, toolId: string): void {
  const ed = sketchEditor(studio);
  if (!ed.getState().open) return;
  const input = document.createElement("input");
  input.type = "file"; input.accept = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/bmp";
  input.style.display = "none";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    readPicture(file).then(({ src, aspect }) => { if (ed.getState().open) startDrawTool(studio, imageTool(toolId, src, aspect)); }, (err) => studio.host.toast(String((err as Error).message || err), 4000));
  });
  document.body.appendChild(input);
  input.click();
}
