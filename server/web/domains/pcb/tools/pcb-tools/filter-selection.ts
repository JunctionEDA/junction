// pcb-tools/filter-selection.ts — PCB_SELECTION_TOOL::filterSelection's itemIsIncludedByFilter
// (pcbnew/tools/pcb_selection_tool.cpp) with DIALOG_FILTER_SELECTION::OPTIONS: which of the selected items Edit >
// Select > Filter Selected Items... keeps.  The dialog is inclusive: a kind it has no option for is dropped.
import type { BoardDoc } from "./types";
import { K } from "./state";
import { groupMembers, isLocked } from "./groups";

export interface FilterSelectionOptions {
  includeFootprints: boolean; includeLockedFootprints: boolean; includeTracks: boolean; includeVias: boolean; includeZones: boolean;
  includeItemsOnTechLayers: boolean; includeBoardOutlineLayer: boolean; includePcbTexts: boolean;
}
/** DIALOG_FILTER_SELECTION::OPTIONS' defaults: everything. */
export const FILTER_SELECTION_DEFAULTS: FilterSelectionOptions = { includeFootprints: true, includeLockedFootprints: true, includeTracks: true, includeVias: true,
  includeZones: true, includeItemsOnTechLayers: true, includeBoardOutlineLayer: true, includePcbTexts: true };
const SHAPES = new Set(["gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_curve", "gr_bbox", "gr_ellipse", "gr_ellipse_arc", "target", "dimension"]);
const TEXTS = new Set(["gr_text", "gr_text_box", "table", "property", "drill_map"]);

export function itemIsIncludedByFilter(it: KItem, o: FilterSelectionOptions): boolean {
  const k = it.kind;
  if (k === "footprint") return o.includeFootprints && (o.includeLockedFootprints || !isLocked(it.node));
  if (k === "segment" || k === "arc") return o.includeTracks;
  if (k === "via") return o.includeVias;
  if (k === "zone") return o.includeZones;
  if (SHAPES.has(k)) { const l = K.kid(it.node, "layer"); return l && K.str(l[1]) === "Edge.Cuts" ? o.includeBoardOutlineLayer : o.includeItemsOnTechLayers; }
  if (k === "grid_item") return o.includeItemsOnTechLayers;
  if (TEXTS.has(k)) return o.includePcbTexts;
  return false;
}
/**
 * The ids of the selection the options keep, in selection order.  A selected group (or generator) is one item of
 * KiCad's selection, a kind the dialog has no option for: it goes as a whole, its members with it (this selection
 * model holds a selected group as its id plus every member).
 */
export function filterSelectionIds(doc: BoardDoc, ids: Iterable<string>, o: FilterSelectionOptions): string[] {
  const all = Array.from(ids), gone = new Set<string>();
  const drop = (id: string, depth: number) => { const it = doc.items.get(id); if (!it || gone.has(id) || depth > 32) return; gone.add(id); if (it.kind === "group" || it.kind === "generated") for (const m of groupMembers(it.node)) drop(m, depth + 1); };
  for (const id of all) { const it = doc.items.get(id); if (it && (it.kind === "group" || it.kind === "generated")) drop(id, 0); }
  const out: string[] = [];
  for (const id of all) { if (gone.has(id)) continue; const it = doc.items.get(id); if (it && itemIsIncludedByFilter(it, o)) out.push(id); }
  return out;
}
