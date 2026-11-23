// pcb-tools/global-delete.ts — DIALOG_GLOBAL_DELETION::DoGlobalDeletions (dialog_global_deletion.cpp): which board
// items Edit > Global Deletions... removes for the dialog's check boxes, filters and layer choice.  Plain item
// selection (no DOM), so the node tests drive it; the dialog lives in pcb-tools/dialogs.ts.
import { removedChange, replacedChange } from "./changes";
import { copperOf } from "./dialogs";
import { isLocked } from "./groups";
import { itemDescription } from "./msgpanel";
import { itemOnLayer } from "./snap-pairs";
import { K } from "./state";
import type { BoardDoc, PcbChange } from "./types";

export interface GlobalDeletionOptions {
  zones?: boolean; texts?: boolean; boardOutlines?: boolean; graphics?: boolean; footprints?: boolean; tracks?: boolean; teardrops?: boolean; markers?: boolean; all?: boolean;
  lockedGraphics?: boolean; unlockedGraphics?: boolean; lockedFootprints?: boolean; unlockedFootprints?: boolean;
  lockedTracks?: boolean; unlockedTracks?: boolean; lockedVias?: boolean; unlockedVias?: boolean;
  /** m_rbLayersOption: false = All layers, true = Current layer only */
  currentLayerOnly?: boolean;
}
/** The dialog's initial state: nothing to delete, the "unlocked" filters on, all layers (it never saves its state). */
export const GLOBAL_DELETION_DEFAULTS: GlobalDeletionOptions = { unlockedGraphics: true, unlockedFootprints: true, unlockedTracks: true, unlockedVias: true };

const SHAPE = new Set(["gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_curve", "gr_bbox", "gr_ellipse", "gr_ellipse_arc"]);
const DRAWING = new Set([...SHAPE, "gr_text", "gr_text_box", "dimension", "target", "image", "table", "barcode"]);
const isTeardrop = (n: SNode) => { const a = K.kid(n, "attr"); return !!(a && K.kid(a, "teardrop")); };
/** LSET::AllNonCuMask(): every layer that is not copper. */
const nonCopper = (l: string) => !/\.Cu$/.test(l) && l !== "*.Cu";

/** The ids DoGlobalDeletions removes (zones, drawings, footprints, tracks and vias, empty tuning patterns), in board order. */
export function globalDeletionIds(doc: KDoc, o: GlobalDeletionOptions, currentLayer: string): string[] {
  const all = !!o.all;
  const onFilter = (it: KItem) => !o.currentLayerOnly || itemOnLayer(it, currentLayer);
  const out: string[] = [];
  const items = Array.from(doc.items.values());
  // zones
  for (const it of items) {
    if (it.kind !== "zone") continue;
    if (all) out.push(it.id);
    else if (isTeardrop(it.node)) { if (o.teardrops && onFilter(it)) out.push(it.id); }
    else if (o.zones && onFilter(it)) out.push(it.id);
  }
  // drawings: shapes by the graphics / board outline layers and the lock filters; texts only when no shapes are deleted
  const shapes = !!(o.graphics || o.boardOutlines), texts = !!o.texts;
  if (all || shapes || texts) {
    const drawingLayer = (l: string) => (o.graphics && nonCopper(l) && l !== "Edge.Cuts") || (o.boardOutlines && l === "Edge.Cuts");
    const drawingOk = (it: KItem) => {
      const layers = it.layer ? [it.layer] : Array.from(new Set(it.geom.map((g) => g.layer).filter(Boolean) as string[]));
      return layers.some((l) => drawingLayer(l) && (!o.currentLayerOnly || l === currentLayer));
    };
    for (const it of items) {
      if (!DRAWING.has(it.kind)) continue;
      if (all) out.push(it.id);
      else if (shapes) {
        if (!SHAPE.has(it.kind)) continue;
        if (isLocked(it.node) ? o.lockedGraphics : o.unlockedGraphics) { if (drawingOk(it)) out.push(it.id); }
      } else if (texts) { if ((it.kind === "gr_text" || it.kind === "gr_text_box") && onFilter(it)) out.push(it.id); }
    }
  }
  // footprints
  if (all || o.footprints) for (const it of items) {
    if (it.kind !== "footprint") continue;
    if (all) out.push(it.id);
    else if (isLocked(it.node) ? o.lockedFootprints : o.unlockedFootprints) { if (onFilter(it)) out.push(it.id); }
  }
  // tracks and vias, then the tuning patterns left with no items
  if (all || o.tracks) {
    for (const it of items) {
      if (it.kind !== "segment" && it.kind !== "arc" && it.kind !== "via") continue;
      if (all) out.push(it.id);
      else if (it.kind === "via") { if (isLocked(it.node) ? o.lockedVias : o.unlockedVias) { if (onFilter(it)) out.push(it.id); } }
      else if (isLocked(it.node) ? o.lockedTracks : o.unlockedTracks) { if (onFilter(it)) out.push(it.id); }
    }
    for (const it of items) {
      if (it.kind !== "generated") continue;
      const m = K.kid(it.node, "members");
      if (!m || m.length <= 1) out.push(it.id);
    }
  }
  return out;
}

const isThroughVia = (n: SNode) => !K.kid(n, "blind") && !K.kid(n, "micro") && !K.kid(n, "buried") && !(n[1] === "blind" || n[1] === "micro" || n[1] === "buried");
const expandLayers = (names: string[], copper: string[]) => names.flatMap((n) => (n === "*.Cu" ? copper : n === "F&B.Cu" ? ["F.Cu", "B.Cu"] : n.startsWith("*.") ? ["F" + n.slice(1), "B" + n.slice(1)] : [n]));
/** PAD::HasExplicitDefinitionForLayer: a custom padstack names the layer. */
const padDefinesLayer = (pad: SNode, layer: string) => { const ps = K.kid(pad, "padstack"); return !!ps && K.kids(ps, "layer").some((l) => K.str(l[1]) === layer); };

/**
 * PANEL_SETUP_LAYERS::TransferDataFromWindow's warning list: per removed layer the board-level items on it (not
 * footprints, PCB_LAYER_COLLECTOR over BoardLevelItems) with their descriptions, then "Pad %s of %s on %s" for each
 * pad whose padstack defines the layer.  Empty when nothing would go.
 */
export function removedLayerItems(doc: BoardDoc, layers: string[], units: string, layerName: (l: string) => string = (l) => l): { id: string; desc: string }[] {
  const out: { id: string; desc: string }[] = [];
  for (const layer of layers) {
    for (const it of doc.items.values()) {
      if (it.kind === "footprint" || !itemOnLayer(it, layer)) continue;
      out.push({ id: it.id, desc: String(itemDescription(doc, it.id, units) || it.kind) });
    }
    for (const fp of doc.items.values()) {
      if (fp.kind !== "footprint") continue;
      const refNode = K.kids(fp.node, "property").find((x) => x[1] === "Reference") || K.kids(fp.node, "fp_text").find((x) => x[1] === "reference");
      for (const pad of K.kids(fp.node, "pad")) if (padDefinesLayer(pad, layer)) out.push({ id: fp.id, desc: `Pad ${K.str(pad[1])} of ${refNode ? K.str(refNode[2]) : ""} on ${layerName(layer)}` });
    }
  }
  return out;
}

/**
 * BOARD::RemoveAllItemsOnLayer for each removed layer: a footprint (and what it owns) stays; a through via stays; a
 * blind / buried via whose top or bottom is the layer goes; any other item on the layer loses the layer from its
 * layer set, and goes when none is left.
 */
export function removeItemsOnLayers(doc: BoardDoc, layers: string[]): PcbChange[] {
  const copper = copperOf(doc), out: PcbChange[] = [];
  for (const it of doc.items.values()) {
    if (it.kind === "footprint" || !layers.some((l) => itemOnLayer(it, l))) continue;
    if (it.kind === "via") {
      if (isThroughVia(it.node)) continue;
      const ls = K.kid(it.node, "layers"); const pair = ls ? ls.slice(1).map(K.str) : [];
      if (layers.some((l) => pair[0] === l || pair[pair.length - 1] === l)) out.push(removedChange(it));
      continue;
    }
    const ls = K.kid(it.node, "layers");
    const names = ls ? expandLayers(ls.slice(1).map(K.str), copper) : [];
    const keep = names.filter((l) => !layers.includes(l));
    if (ls && keep.length) {
      const n = K.cloneNode(it.node); const nl = K.kid(n, "layers")!;
      nl.splice(1, nl.length - 1, ...keep);
      if (it.kind === "zone") for (const fp of K.kids(n, "filled_polygon")) { const fl = K.kid(fp, "layer"); if (fl && layers.includes(K.str(fl[1]))) n.splice(n.indexOf(fp), 1); }
      out.push(replacedChange(it, n));
    } else out.push(removedChange(it));
  }
  return out;
}

export const globalDeletionApi = { globalDeletionIds, GLOBAL_DELETION_DEFAULTS, removedLayerItems, removeItemsOnLayers };
