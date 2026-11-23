// library/preview.ts — the chooser's preview panes: one library symbol unit or one footprint
// drawn with the document renderer (KiCadCanvas.render) on its own canvas, fitted to the pane.
import { embedSymbol, footprintInstance, symbolInfo, symbolInstance } from "./core";

const K = (): KiCadCanvasApi => window.KiCadCanvas;
type Render = (doc: KDoc, ctx: CanvasRenderingContext2D, view: KView, opts: Record<string, unknown>) => void;

/** Board layers a lone footprint is drawn against (the stack KiCad's footprint preview uses). */
const PREVIEW_LAYERS = `(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (9 "F.Adhes" user) (11 "B.Adhes" user) (13 "F.Paste" user) (15 "B.Paste" user) (5 "F.SilkS" user) (7 "B.SilkS" user)
  (1 "F.Mask" user) (3 "B.Mask" user) (17 "Dwgs.User" user) (19 "Cmts.User" user) (25 "Edge.Cuts" user) (27 "Margin" user) (31 "F.CrtYd" user) (29 "B.CrtYd" user) (35 "F.Fab" user) (33 "B.Fab" user))`;

function sizeToBox(canvas: HTMLCanvasElement): { w: number; h: number; dpr: number } {
  const dpr = window.devicePixelRatio || 1, w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  return { w, h, dpr };
}

function boundsOf(doc: KDoc): [number, number, number, number] | null {
  let b: [number, number, number, number] | null = null;
  for (const it of doc.items.values()) {
    const ib = it.bbox; if (!ib) continue;
    b = b ? [Math.min(b[0], ib[0]), Math.min(b[1], ib[1]), Math.max(b[2], ib[2]), Math.max(b[3], ib[3])] : [ib[0], ib[1], ib[2], ib[3]];
  }
  return b;
}

function draw(canvas: HTMLCanvasElement, doc: KDoc, opts: Record<string, unknown>, maxPpm: number, zoom = 1): void {
  const g = canvas.getContext("2d"); if (!g) return;
  const { w, h, dpr } = sizeToBox(canvas);
  const b = boundsOf(doc) || [-5, -5, 5, 5];
  const bw = Math.max(0.5, b[2] - b[0]), bh = Math.max(0.5, b[3] - b[1]);
  const ppm = Math.min(maxPpm, (w * 0.84) / bw, (h * 0.84) / bh) * zoom;
  const view: KView = { ppm, zoom: 1, panX: 0, panY: 0, x0: (b[0] + b[2]) / 2 - w / 2 / ppm, y0: (b[1] + b[3]) / 2 - h / 2 / ppm, dpr };
  (K().render as unknown as Render)(doc, g, view, Object.assign({ frame: false, grid: 0 }, opts));
}

/** Blank the pane (the editor's own background). */
export function clearPreview(canvas: HTMLCanvasElement, kind: "symbol" | "footprint"): void {
  const doc = K().parseDoc(kind === "symbol" ? '(kicad_sch (version 20260101) (generator "eeschema") (paper "A4"))' : `(kicad_pcb (version 20260206) (generator "pcbnew") ${PREVIEW_LAYERS})`);
  draw(canvas, doc, { hidden: new Set<string>() }, 20);
}

/** One unit of a library symbol (flattened text), with its visible fields as a new instance would show them. */
export function renderSymbolPreview(canvas: HTMLCanvasElement, libId: string, symbol: string, unit: number, bodyStyle = 1): void {
  const lib = embedSymbol(libId, symbol);
  const inst = symbolInstance({ libId, symbol: lib, at: [0, 0], unit, bodyStyle, reference: symbolInfo(lib).reference || "U", uuid: "00000000-0000-4000-8000-000000000001" });
  const doc = K().parseDoc(`(kicad_sch (version 20260101) (generator "eeschema") (paper "A4") (lib_symbols ${K().serialize(lib)}) ${K().serialize(inst)})`);
  draw(canvas, doc, {}, 24);
}

/** A library footprint (.kicad_mod text) placed at the origin of an otherwise empty board (the footprint viewers' model). */
export function footprintPreviewDoc(fpid: string, footprint: string): KDoc {
  const node = footprintInstance({ fpid, footprint, at: [0, 0], uuid: "00000000-0000-4000-8000-000000000002" });
  return K().parseDoc(`(kicad_pcb (version 20260206) (generator "pcbnew") ${PREVIEW_LAYERS} ${K().serialize(node)})`);
}
/** An empty board with the preview layer stack. */
export function emptyPreviewDoc(): KDoc { return K().parseDoc(`(kicad_pcb (version 20260206) (generator "pcbnew") ${PREVIEW_LAYERS})`); }

/** A library footprint (.kicad_mod text), every layer shown. */
export function renderFootprintPreview(canvas: HTMLCanvasElement, fpid: string, footprint: string, zoom = 1): void {
  const node = footprintInstance({ fpid, footprint, at: [0, 0], uuid: "00000000-0000-4000-8000-000000000002" });
  const doc = K().parseDoc(`(kicad_pcb (version 20260206) (generator "pcbnew") ${PREVIEW_LAYERS} ${K().serialize(node)})`);
  draw(canvas, doc, { hidden: new Set<string>() }, 60, zoom);
}

/** DESIGN_BLOCK_PREVIEW_WIDGET::DisplayDesignBlock: a design block's schematic or layout (a whole .kicad_sch /
 *  .kicad_pcb), fitted to the pane; an unreadable file leaves the pane blank. */
export function renderDesignBlockPreview(canvas: HTMLCanvasElement, kind: "sch" | "pcb", text: string): void {
  let doc: KDoc;
  try { doc = K().parseDoc(text); } catch { clearPreview(canvas, kind === "sch" ? "symbol" : "footprint"); return; }
  draw(canvas, doc, kind === "pcb" ? { hidden: new Set<string>() } : {}, kind === "pcb" ? 60 : 24);
}

// ---------------------------------------------------------------- the choosers' live previews

/** A chooser pane's own view over the fitted one: the wheel zoom about a point and the drag pan (reset on a new item). */
export interface PaneView { zoom: number; panX: number; panY: number }
export const freshView = (): PaneView => ({ zoom: 1, panX: 0, panY: 0 });
/** What a chooser pane last drew: its scale and world origin, for the pointer (zoom about the cursor, the ruler). */
export interface PaneFrame { ppm: number; x0: number; y0: number }

/** The fitted view of a box, then the pane's zoom and pan; the frame it used. */
function drawFitted(canvas: HTMLCanvasElement, doc: KDoc, opts: Record<string, unknown>, box: [number, number, number, number], fit: (w: number, h: number, bw: number, bh: number) => number, pv: PaneView): PaneFrame | null {
  const g = canvas.getContext("2d"); if (!g) return null;
  const { w, h, dpr } = sizeToBox(canvas);
  const bw = Math.max(0.05, box[2] - box[0]), bh = Math.max(0.05, box[3] - box[1]);
  const ppm = fit(w, h, bw, bh) * pv.zoom;
  const x0 = (box[0] + box[2]) / 2 - (w / 2 + pv.panX) / ppm, y0 = (box[1] + box[3]) / 2 - (h / 2 + pv.panY) / ppm;
  const view: KView = { ppm, zoom: 1, panX: 0, panY: 0, x0, y0, dpr };
  (K().render as unknown as Render)(doc, g, view, Object.assign({ frame: false, grid: 0 }, opts));
  return { ppm, x0, y0 };
}

/**
 * SYMBOL_PREVIEW_WIDGET::DisplaySymbol: one unit and body style of a library symbol, its fields autoplaced when the
 * preference says so (`autoplace`, the schematic module's AutoplaceFields), fitted by fitOnDrawArea (the unit's box,
 * an exact fit divided by 1.2).
 */
export function renderChooserSymbol(canvas: HTMLCanvasElement, libId: string, symbol: string, unit: number, bodyStyle: number,
  o: { view?: PaneView; autoplace?: ((doc: KDoc, item: KItem) => SNode | null) | null } = {}): PaneFrame | null {
  const lib = embedSymbol(libId, symbol);
  let inst = symbolInstance({ libId, symbol: lib, at: [0, 0], unit, bodyStyle, reference: symbolInfo(lib).reference || "U", uuid: "00000000-0000-4000-8000-000000000001" });
  const head = `(kicad_sch (version 20260101) (generator "eeschema") (paper "A4") (lib_symbols ${K().serialize(lib)})`;
  let doc = K().parseDoc(`${head} ${K().serialize(inst)})`);
  if (o.autoplace) {
    try { const it = doc.items.get("00000000-0000-4000-8000-000000000001"); const placed = it ? o.autoplace(doc, it) : null; if (placed) { inst = placed; doc = K().parseDoc(`${head} ${K().serialize(inst)})`); } }
    catch { /* drawn with the library's field positions */ }
  }
  const box = boundsOf(doc) || [-5, -5, 5, 5];
  return drawFitted(canvas, doc, {}, box, (w, h, bw, bh) => Math.min(w / bw, h / bh) / 1.2, o.view || freshView());
}

/** FOOTPRINT_PREVIEW_PANEL::SetPinFunctions: every pad's pin function is the symbol's pin name of its number ("" without one). */
export function withPinFunctions(fp: SNode, pinNames: Record<string, string>): SNode {
  for (const pad of K().kids(fp, "pad")) {
    const num = String(pad[1] ?? ""), name = Object.prototype.hasOwnProperty.call(pinNames, num) ? pinNames[num] : "";
    for (let i = pad.length - 1; i >= 1; i--) { const c = pad[i]; if (Array.isArray(c) && (c[0] === "pinfunction" || c[0] === "net")) pad.splice(i, 1); }
    if (name) {
      (pad as SNode[]).push(K().parse(`(pinfunction ${JSON.stringify(name)})`) as SNode);
      // PCB_PAINTER draws the pin function where a board pad shows its net name (the CvPcb viewers' netname): the
      // preview hands it to the pad label as the pad's net ("/" escaped, as the label shows the text after a slash)
      (pad as SNode[]).push(K().parse(`(net ${JSON.stringify(name.replace(/\//g, "{slash}"))})`) as SNode);
    }
  }
  return fp;
}

/**
 * FOOTPRINT_PREVIEW_PANEL::DisplayFootprint + fitToCurrentFootprint: the footprint (pads named after the symbol's pins
 * when `pinNames` is given) fitted on its box without texts (unless it is texts only), inflated by 100 DRC epsilons,
 * at 70 %; the board editor's grid behind it when `grid` (mm) is set.
 */
export function renderChooserFootprint(canvas: HTMLCanvasElement, fpid: string, footprint: string,
  o: { view?: PaneView; pinNames?: Record<string, string> | null; grid?: number } = {}): PaneFrame | null {
  const node = footprintInstance({ fpid, footprint, at: [0, 0], uuid: "00000000-0000-4000-8000-000000000002" });
  if (o.pinNames) withPinFunctions(node, o.pinNames);
  const doc = K().parseDoc(`(kicad_pcb (version 20260206) (generator "pcbnew") ${PREVIEW_LAYERS} ${K().serialize(node)})`);
  // GetBoundingBox( includeText = TextOnly() )
  const bare = (K().cloneNode as (n: SNode) => SNode)(node);
  for (let i = bare.length - 1; i >= 1; i--) { const c = bare[i]; if (Array.isArray(c) && (c[0] === "property" || c[0] === "fp_text")) bare.splice(i, 1); }
  const textOnly = !bare.slice(2).some((c) => Array.isArray(c) && !["layer", "uuid", "at", "descr", "tags", "attr", "model", "embedded_fonts", "embedded_files", "sheetname", "sheetfile", "path"].includes(String(c[0])));
  const boxDoc = textOnly ? doc : K().parseDoc(`(kicad_pcb (version 20260206) (generator "pcbnew") ${PREVIEW_LAYERS} ${K().serialize(bare)})`);
  const b = boundsOf(boxDoc) || boundsOf(doc) || [-5, -5, 5, 5];
  const eps = 0.0005 * 100;   // ADVANCED_CFG m_DRCEpsilon (mm) * 100
  const box: [number, number, number, number] = [b[0] - eps, b[1] - eps, b[2] + eps, b[3] + eps];
  return drawFitted(canvas, doc, { hidden: new Set<string>(), grid: o.grid && o.grid > 0 ? o.grid : 0 }, box, (w, h, bw, bh) => Math.min(w / bw, h / bh) * 0.7, o.view || freshView());
}

/**
 * SYMBOL_DIFF_WIDGET: the schematic copy and the library symbol drawn over each other at one scale.  `pct` is the
 * slider (0 schematic only … 0.5 both … 1 library only): below the middle the library fades out, above it the
 * schematic does (onSlider's forced transparencies).
 */
export function renderSymbolDiff(canvas: HTMLCanvasElement, sch: KDoc, lib: KDoc, pct: number): void {
  const g = canvas.getContext("2d"); if (!g) return;
  const { w, h, dpr } = sizeToBox(canvas);
  const a = boundsOf(sch), c = boundsOf(lib);
  const b = a && c ? [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[2]), Math.max(a[3], c[3])] : a || c || [-5, -5, 5, 5];
  const bw = Math.max(0.5, b[2] - b[0]), bh = Math.max(0.5, b[3] - b[1]);
  const ppm = Math.min(24, (w * 0.84) / bw, (h * 0.84) / bh);
  const view: KView = { ppm, zoom: 1, panX: 0, panY: 0, x0: (b[0] + b[2]) / 2 - w / 2 / ppm, y0: (b[1] + b[3]) / 2 - h / 2 / ppm, dpr };
  const render = K().render as unknown as Render;
  render(K().parseDoc('(kicad_sch (version 20260101) (generator "eeschema") (paper "A4"))'), g, view, { frame: false, grid: 0, hidden: new Set<string>() });
  const layer = (doc: KDoc, alpha: number): void => {
    if (alpha <= 0) return;
    const off = document.createElement("canvas"); off.width = canvas.width; off.height = canvas.height;
    const o = off.getContext("2d"); if (!o) return;
    render(doc, o, view, { frame: false, grid: 0, background: null });
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = alpha; g.drawImage(off, 0, 0); g.restore();
  };
  layer(sch, 1 - (pct < 0.5 ? 0 : (pct - 0.5) * 2));
  layer(lib, 1 - (pct > 0.5 ? 0 : 1 - pct * 2));
}
