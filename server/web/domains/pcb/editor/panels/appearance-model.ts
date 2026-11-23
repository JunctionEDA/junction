// appearance-model.ts — the Appearance panel's rules as plain functions (no DOM, no globals), so the node tests can
// run them.  Each one is ported from pcbnew/widgets/appearance_controls.cpp:
//
//   doApplyLayerPreset         the active layer after a preset: its own, else the first of its layers (LSET::Seq) when
//                              the current one is not in the preset; only a layer the board has.
//   OnLayerContextMenu         Hide All Copper / Non Copper Layers move the active layer to the first visible layer.
//   onObjectVisibilityChanged  Footprint Text drags References and Values along; showing either turns it back on.
//   UpdateDisplayOptions /     the Ratsnest radio shows None while the global ratsnest is off, else All / Visible;
//   onRatsnestMode             picking None only turns the global ratsnest off and keeps the All / Visible mode.
//   rebuildNets                nets with a code above 0 whose name does not start "unconnected-("; net classes
//                              "Default" first, then the others sorted.
//   showNetclass               the class eye shows or hides each of its nets (the class's own eye state is only
//                              remembered, m_HiddenNetclasses); a net of a hidden class can be shown on its own.

/** PCB_LAYER_ID of a layer name (include/layer_ids.h, KiCad 9+ numbering); 1000 for a name that is not one. */
const FIXED_IDS: Record<string, number> = { "F.Cu": 0, "B.Cu": 2, "F.Mask": 1, "B.Mask": 3, "F.SilkS": 5, "B.SilkS": 7, "F.Adhes": 9, "B.Adhes": 11, "F.Paste": 13, "B.Paste": 15,
  "Dwgs.User": 17, "Cmts.User": 19, "Eco1.User": 21, "Eco2.User": 23, "Edge.Cuts": 25, "Margin": 27, "B.CrtYd": 29, "F.CrtYd": 31, "B.Fab": 33, "F.Fab": 35, "Rescue": 37 };
export function layerSeqId(name: string): number {
  if (name in FIXED_IDS) return FIXED_IDS[name];
  let m = /^In(\d+)\.Cu$/.exec(name); if (m) return 2 * Number(m[1]) + 2;
  m = /^User\.(\d+)$/.exec(name); if (m) return 39 + 2 * (Number(m[1]) - 1);
  return 1000;
}
/** *LSET::Seq().begin(): the layer with the lowest PCB_LAYER_ID, null for an empty set. */
export function firstInSeq(layers: string[]): string | null {
  let best: string | null = null;
  for (const l of layers) if (best === null || layerSeqId(l) < layerSeqId(best)) best = l;
  return best;
}

export interface PresetLayers { layers: string[]; active?: string; /** a built-in preset's first layer of its whole LSET (layers the board lacks included) */ seqFirst?: string | null }
/**
 * APPEARANCE_CONTROLS::doApplyLayerPreset: the layer to make active after the preset, null to keep the current one.
 * `boardLayers` is board->GetLayerSet().
 */
export function presetActiveLayer(p: PresetLayers, current: string, boardLayers: string[]): string | null {
  let active: string | null = null;
  if (p.active) active = p.active;
  else if (p.layers.length && !p.layers.includes(current)) active = p.seqFirst !== undefined ? p.seqFirst : firstInSeq(p.layers);
  return active && boardLayers.includes(active) ? active : null;
}

/** OnLayerContextMenu, ID_HIDE_ALL_COPPER_LAYERS / ID_HIDE_ALL_NON_COPPER: `if( !visible.test( current ) && visible.count() > 0 )`. */
export function activeAfterHide(visible: string[], current: string): string | null {
  return !visible.includes(current) && visible.length > 0 ? firstInSeq(visible) : null;
}

/** onObjectVisibilityChanged: the hidden object ids after the row `id` is shown (`on`) or hidden. */
export function objectVisibilityChange(hidden: string[], id: string, on: boolean): string[] {
  const set = new Set(hidden);
  const put = (k: string, v: boolean) => { if (v) set.delete(k); else set.add(k); };
  put(id, on);
  // LAYER_FP_TEXT is a meta-control: it drags LAYER_FP_REFERENCES and LAYER_FP_VALUES along
  if (id === "fpText") { put("references", on); put("values", on); }
  // showing References or Values while Footprint Text is off puts it back on
  else if ((id === "references" || id === "values") && on) put("fpText", true);
  return Array.from(set);
}

export type RatsnestChoice = "all" | "visible" | "none";
/** UpdateDisplayOptions: the radio from m_ShowGlobalRatsnest and m_RatsnestMode. */
export function ratsnestRadio(showGlobal: boolean, mode: RatsnestChoice): RatsnestChoice {
  return !showGlobal ? "none" : mode === "visible" ? "visible" : "all";
}
/** onRatsnestMode: the radio picked → m_ShowGlobalRatsnest and m_RatsnestMode (None keeps the mode). */
export function ratsnestFromRadio(choice: RatsnestChoice, mode: RatsnestChoice): { show: boolean; mode: "all" | "visible" } {
  if (choice === "all") return { show: true, mode: "all" };
  if (choice === "visible") return { show: true, mode: "visible" };
  return { show: false, mode: mode === "visible" ? "visible" : "all" };
}
/** PCB_CONTROL::RatsnestModeCycle: hidden → all layers → visible layers → hidden. */
export function ratsnestCycle(showGlobal: boolean, mode: RatsnestChoice): { show: boolean; mode: "all" | "visible" } {
  if (!showGlobal) return { show: true, mode: "all" };
  if (mode !== "visible") return { show: true, mode: "visible" };
  return { show: false, mode: "visible" };
}

/** NET_GRID_TABLE::Rebuild: `netCode > 0 && !name.StartsWith( "unconnected-(" )`. */
export function appearanceNets<T extends { name: string; code: number }>(list: T[]): T[] {
  return list.filter((n) => n.code > 0 && !n.name.startsWith("unconnected-("));
}
/** rebuildNets: "Default" first, then the other class names std::sort-ed (wxString ordinal order). */
export function sortNetClasses(names: string[]): string[] {
  const rest = names.filter((n) => n !== "Default").sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.includes("Default") ? ["Default", ...rest] : rest;
}
/** showNetclass: the per-net hidden set after the class eye shows or hides every net of the class. */
export function showNetclassNets(hidden: string[], classNets: string[], show: boolean): string[] {
  const set = new Set(hidden);
  for (const n of classNets) { if (show) set.delete(n); else set.add(n); }
  return Array.from(set);
}
