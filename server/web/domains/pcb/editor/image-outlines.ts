// editor/image-outlines.ts — Convert to Outlines on a reference image, in both editors:
//   DRAWING_TOOL::ConvertImageToOutlines (pcbnew/tools/drawing_tool.cpp) and SCH_EDIT_TOOL::ConvertImageToOutlines
//   (eeschema/tools/sch_edit_tool.cpp), with DIALOG_CONVERT_IMAGE_TO_OUTLINES (common/dialogs): the image shown black
//   and white at the threshold while the dialog is open (BITMAP_BASE::BeginPreviewImage), then traced
//   (common/bitmap_tracing.cpp, tools/bitmap-tracing.ts) into filled polygons — PCB_SHAPEs on the chosen layer, or
//   filled SCH_SHAPEs — grouped, with the image removed, as one "Convert Image to Outlines" commit.
import { E } from "./state";
import { selectedIds } from "./menu-actions";
import { commitChanges } from "./tools";
import { toast } from "./util";
import { isSch, requestRender } from "./view";
import { checkField, form, h, openDialog, selectField } from "./pcbdialogs/ui";
import { bilevelRgba, convertImageToBilevel, imageToOutlines, type RgbaImage, type TracedImagePlace } from "../tools/bitmap-tracing";
import type { Pt } from "../fab/prims";
import type { ActionHandler } from "./types";

interface ImageEntry { img?: CanvasImageSource | null; loaded?: boolean; failed?: boolean; w?: number; h?: number; ppi?: number }
interface ImageGeom { t: string; entry?: ImageEntry; scale?: number; rot?: number }

/** DIALOG_SHIM keeps the slider and the check box for the session; the layer opts out (OptOut( m_layer )). */
const remembered = { threshold: 50, invert: false };

/** IU per millimetre and per inch (pcbIUScale / schIUScale). */
const iuPerMm = (sch: boolean): number => (sch ? 1e4 : 1e6);
const kiRound = (v: number): number => (v < 0 ? -Math.round(-v) : Math.round(v));
/** FormatInternalUnits: IU back to mm, as many decimals as the editor writes. */
const toMm = (v: number, sch: boolean): number => { const r = +(v / iuPerMm(sch)).toFixed(sch ? 4 : 6); return r === 0 ? 0 : r; };

/**
 * The image as the tracer sees it: REFERENCE_IMAGE::GetPosition, GetSize (BITMAP_BASE::GetSize, KiROUND( pixels *
 * 1000 mils / ppi * scale )) and GetOrientation, in internal units.
 */
export function imagePlace(item: { x?: number; y?: number }, g: { scale?: number; rot?: number }, px: { w: number; h: number; ppi?: number }, sch: boolean): TracedImagePlace {
  const perPx = iuPerMm(sch) * 25.4 / (px.ppi || 300) * (g.scale || 1);
  return { posX: kiRound((item.x || 0) * iuPerMm(sch)), posY: kiRound((item.y || 0) * iuPerMm(sch)), sizeX: kiRound(px.w * perPx), sizeY: kiRound(px.h * perPx), rotation: g.rot || 0 };
}

/** PCB_SHAPE POLY, filled, stroke 0, as PCB_IO_KICAD_SEXPR writes it. */
export function boardPolyNode(pts: Pt[], layer: string, uuid: string): SNode {
  return ["gr_poly", ["pts", ...pts.map((p) => ["xy", toMm(p[0], false), toMm(p[1], false)] as SNode)], ["stroke", ["width", 0], ["type", "default"]], ["fill", "yes"], ["layer", layer], ["uuid", uuid]];
}
/** SCH_SHAPE POLY, FILLED_SHAPE, STROKE_PARAMS( -1 ): the outline's points and its first point again. */
export function schPolyNode(pts: Pt[], uuid: string): SNode {
  const xy = (p: Pt): SNode => ["xy", toMm(p[0], true), toMm(p[1], true)];
  return ["polyline", ["pts", ...pts.map(xy), xy(pts[0])], ["stroke", ["width", toMm(-1, true)], ["type", "default"]], ["fill", ["type", "outline"]], ["uuid", uuid]];
}

/** The layers the board offers (GetEnabledLayers().UIOrder()) and the one the image is on. */
function boardLayers(doc: KDoc, imageLayer: string): { names: [string, string][]; selected: string } {
  const sizes = (KiCadCanvas as unknown as { pcbSizes?: { enabledLayers(d: KDoc, c: (l: string) => string): { name: string; label: string }[] } }).pcbSizes;
  const list = sizes ? sizes.enabledLayers(doc, () => "") : Array.from(doc.layers ? doc.layers.keys() : []).map((name) => ({ name, label: name }));
  const names = list.map((l): [string, string] => [l.name, l.label]);
  return { names, selected: names.some((n) => n[0] === imageLayer) ? imageLayer : (names[0] ? names[0][0] : imageLayer) };
}

/** The decoded bitmap's pixels (BITMAP_BASE::GetImageData), or null while it has not loaded. */
function pixelsOf(e: ImageEntry): RgbaImage | null {
  const img = e.img as HTMLImageElement | null | undefined;
  if (!img || !e.loaded || e.failed || typeof document === "undefined") return null;
  const w = img.naturalWidth || e.w || 0, hgt = img.naturalHeight || e.h || 0;
  if (!(w > 0 && hgt > 0)) return null;
  const c = document.createElement("canvas"); c.width = w; c.height = hgt;
  const g = c.getContext("2d"); if (!g) return null;
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, w, hgt).data;
  return { w, h: hgt, data };
}

/** A canvas showing the bilevel image, drawn in the image's place while the dialog is open. */
function previewCanvas(px: RgbaImage, threshold: number, invert: boolean): HTMLCanvasElement | null {
  const c = document.createElement("canvas"); c.width = px.w; c.height = px.h;
  const g = c.getContext("2d"); if (!g) return null;
  const im = g.createImageData(px.w, px.h);
  im.data.set(bilevelRgba(convertImageToBilevel(px, threshold, invert), px.data));
  g.putImageData(im, 0, 0);
  return c;
}

interface PcbToolsView { addedChange(doc: KDoc, node: SNode): KChange; removedChange(item: KItem): KChange; groupNode(name: string, ids: Iterable<string>): SNode }
interface SchToolsView { _?: { addNode(doc: KDoc, node: SNode): { item: KItem; change: KChange } } }

/** The commit: the shapes, the image removed, the group of the shapes (named ""). */
export function outlineChanges(doc: KDoc, image: KItem, outlines: Pt[][], sch: boolean, layer: string): KChange[] | null {
  const changes: KChange[] = [], ids: string[] = [];
  if (sch) {
    const m = (window as unknown as { CollabTools?: { sch?: SchToolsView } }).CollabTools; const add = m && m.sch && m.sch._ && m.sch._.addNode;
    if (!add) return null;
    for (const o of outlines) { const r = add(doc, schPolyNode(o, KiCadCanvas.newUuid())); ids.push(r.item.id); changes.push(r.change); }
    changes.push({ id: image.id, kind: "REMOVED", typeName: "SCH_BITMAP", properties: [] });
    const g = add(doc, ["group", "", ["uuid", KiCadCanvas.newUuid()], ["members", ...ids]]);
    changes.push(g.change);
    return changes;
  }
  const P = (window as unknown as { PcbTools?: PcbToolsView }).PcbTools;
  if (!P) return null;
  for (const o of outlines) { const c = P.addedChange(doc, boardPolyNode(o, layer, KiCadCanvas.newUuid())); ids.push(c.id); changes.push(c); }
  changes.push(P.removedChange(image));
  changes.push(P.addedChange(doc, P.groupNode("", ids)));
  return changes;
}

/** The info bar's message after a conversion (wxPLURAL "Added %d shape." plus the tracer's warnings). */
export function outlinesMessage(count: number, warnings: string[]): string {
  const w = warnings.join("\n").trim();
  if (!count) return w || "No shapes to trace at this threshold.";
  const m = count === 1 ? `Added ${count} shape.` : `Added ${count} shapes.`;
  return w ? m + " " + w : m;
}

/** SCH_EDIT_TOOL / DRAWING_TOOL::ConvertImageToOutlines. */
export function convertImageToOutlines(): boolean {
  const doc = E.kdoc as KDoc | null; if (!doc || E.viewOnly) return false;
  const sel = selectedIds().filter((id) => doc.items.has(id));
  if (sel.length !== 1) return false;
  const image = doc.items.get(sel[0])!;
  if (image.kind !== "image") return false;
  const g = (image.geom || []).find((x) => (x as { t?: string }).t === "image") as ImageGeom | undefined;
  const entry = g && g.entry; if (!entry) return false;
  const px = pixelsOf(entry); if (!px) return false;   // !bitmap.GetImageData()
  const sch = isSch();
  const layers = sch ? null : boardLayers(doc, String((image as { layer?: string }).layer || ""));
  // showPreview: BeginPreviewImage swaps the drawn bitmap, EndPreviewImage puts the source back
  const source = entry.img;
  let previewing = false;
  const showPreview = (threshold: number, invert: boolean): void => {
    const c = previewCanvas(px, threshold, invert); if (!c) return;
    entry.img = c; previewing = true; requestRender();
  };
  const endPreview = (): void => { if (previewing) { entry.img = source; previewing = false; requestRender(); } };
  let threshold = remembered.threshold, invert = remembered.invert, layer = layers ? layers.selected : "";
  const api = openDialog({ title: "Convert to Outlines", width: 400,
    build(body) {
      // "Black / white threshold:" over a 0 .. 100 slider with its labels (wxSL_LABELS), "Invert Colors", then
      // "Layer:" when the editor has layers
      const value = h("span", { "data-k": "threshold-value", style: "display:block;text-align:center;font-variant-numeric:tabular-nums" }, String(threshold));
      const slider = h("input", { type: "range", min: "0", max: "100", step: "1", value: String(threshold), "data-k": "threshold", style: "flex:1;min-width:0" }) as HTMLInputElement;
      const changed = (): void => { remembered.threshold = threshold; remembered.invert = invert; showPreview(threshold / 100, invert); };
      slider.addEventListener("input", () => { threshold = Number(slider.value) || 0; value.textContent = String(threshold); changed(); });   // wxEVT_SCROLL_THUMBTRACK / CHANGED
      const inv = checkField(invert, "Invert Colors", { key: "invert", onChange: (v) => { invert = v; changed(); } });
      body.append(h("div", null, "Black / white threshold:"),
        h("div", { style: "min-width:360px" }, value, h("div", { style: "display:flex;align-items:center;gap:6px" }, h("span", null, "0"), slider, h("span", null, "100"))),
        h("div", { style: "margin-top:6px" }, inv.el));
      if (layers && layers.names.length) {
        const sel = selectField<string>(layer, layers.names, { key: "layer", onChange: (v) => { layer = v; } });
        body.append(form([["Layer:", sel.el]], true));
      }
    },
    ok() { endPreview(); finish(); return true; },
    cancel() { endPreview(); return true; } });
  if (!api) { endPreview(); return false; }
  showPreview(threshold / 100, invert);
  function finish(): void {
    const place = imagePlace(image, g!, { w: px!.w, h: px!.h, ppi: entry!.ppi }, sch);
    const res = imageToOutlines(px!, threshold / 100, invert, place);
    const icon = res.warnings.length ? "warning" : "info";
    if (!res.outlines.length) { requestRender(); toast(outlinesMessage(0, res.warnings), 4000, undefined, icon); return; }
    const changes = outlineChanges(doc!, image, res.outlines, sch, layer);
    if (!changes) return;
    commitChanges(changes, "Convert Image to Outlines");
    toast(outlinesMessage(res.outlines.length, res.warnings), 4000, undefined, icon);
  }
  return true;
}

export function installImageOutlines(table: Record<string, ActionHandler>): void {
  Object.assign(table, { convertImageToOutlines: () => { convertImageToOutlines(); } });
}
