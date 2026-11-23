// pcb-tools/teardrop-edit.ts — Edit > Edit Teardrops... (DIALOG_GLOBAL_EDIT_TEARDROPS::TransferDataFromWindow):
// the pads and vias in scope get their TEARDROP_PARAMETERS removed (disabled), set to the board's defaults for
// their shape, or given the values the dialog specifies; then the teardrops are rebuilt (TEARDROP_MANAGER).
import type { BoardDoc, PcbChange } from "./types";
import { replacedChange } from "./changes";
import { addTrackToTrackTeardrops, deleteTrackToTrackTeardrops, foldChanges, teardropAppliedDoc, teardropFullUpdate, type TeardropOpts } from "./teardrop";
import { netOf } from "./nets";
import { K } from "./state";
import { clone } from "./util";

/** pad-model's Teardrops (TEARDROP_PARAMETERS). */
export interface TeardropParams { enabled: boolean; twoSegments: boolean; preferZone: boolean; maxLen: number; maxWidth: number; lenRatio: number; widthRatio: number; filterRatio: number; curved: boolean }
export interface TeardropEditOpts {
  vias: boolean; pthPads: boolean; smdPads: boolean; trackToTrack: boolean;
  action: "remove" | "removeAll" | "default" | "specified";
  /** TARGET_ROUND / TARGET_RECT from the board setup */
  defaults: { round: TeardropParams; rect: TeardropParams };
  /** the specified values; a missing one is the dialog's indeterminate state and leaves the item's value */
  specified?: Partial<Omit<TeardropParams, "enabled">>;
  roundOnly?: boolean; existingOnly?: boolean;
  /** Selected items only: ids of selected vias, pads (by uuid) and footprints */
  selected?: Set<string> | null;
  /** net / net class / layer filters: true leaves the item alone */
  skip?(info: { net: string; layer: string }): boolean;
  /** a net, net class, layer, round-pad, existing-teardrop or selection filter is on */
  filtered?: boolean;
  /** the project's teardrop targets and rules (the teardrop manager's) */
  teardrop?: TeardropOpts;
}
interface PadModelApi { readTeardrops(n: SNode): TeardropParams; formatTeardrops(t: TeardropParams): string; setPadChild(pad: SNode, key: string, text: string | null): void; TD_DEFAULTS: TeardropParams }
const PM = (): PadModelApi => (K as unknown as { padModel: PadModelApi }).padModel;
const VIA_ORDER = ["at", "size", "drill", "backdrill", "tertiary_drill", "front_post_machining", "back_post_machining", "layers", "remove_unused_layers", "keep_end_layers", "start_end_only",
  "locked", "free", "zone_layer_connections", "tenting", "capping", "covering", "plugging", "filling", "padstack", "teardrops", "net", "uuid", "tstamp"];
const same = (a: TeardropParams, b: TeardropParams): boolean => (Object.keys(b) as (keyof TeardropParams)[]).every((k) => (typeof a[k] === "number" ? Math.abs((a[k] as number) - (b[k] as number)) < 1e-9 : a[k] === b[k]));
function writeTd(n: SNode, td: TeardropParams, via: boolean): void {
  // isDefaultTeardropParameters: a node at the defaults is left out
  const text = same(td, PM().TD_DEFAULTS) ? null : PM().formatTeardrops(td);
  if (!via) { PM().setPadChild(n, "teardrops", text); return; }
  const at = n.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "teardrops");
  if (text === null) { if (at > 0) n.splice(at, 1); return; }
  const node = K.parse(text) as SNode;
  if (at > 0) { n[at] = node; return; }
  const rank = VIA_ORDER.indexOf("teardrops"); let ins = n.length;
  for (let j = 1; j < n.length; j++) { const c = n[j]; if (Array.isArray(c) && VIA_ORDER.indexOf(String(c[0])) > rank) { ins = j; break; } }
  n.splice(ins, 0, node);
}
/** TEARDROP_MANAGER::IsUniformlyRound: a via, or a pad that is a circle (or a square oval) on every layer. */
function isRound(n: SNode, via: boolean): boolean {
  if (via) return true;
  const shape = K.str(n[3]), size = K.kid(n, "size"), ps = K.kid(n, "padstack");
  if (ps && K.kids(ps, "layer").some((l) => { const s = K.kid(l, "shape"), z = K.kid(l, "size"); const sh = s ? K.str(s[1]) : shape; return !(sh === "circle" || (sh === "oval" && z && K.num(z[1]) === K.num(z[2]))); })) return false;
  return shape === "circle" || (shape === "oval" && !!size && K.num(size[1]) === K.num(size[2]));
}
/** BOARD_ITEM::GetLayer for a via (its start layer) or a pad (its first copper layer). */
function firstCopper(n: SNode): string {
  const ls = K.kid(n, "layers"); const names = ls ? ls.slice(1).map((x) => K.str(x)) : [];
  for (const l of names) { if (l === "*.Cu" || l === "F&B.Cu") return "F.Cu"; if (/\.Cu$/.test(l)) return l; }
  return "F.Cu";
}

export function teardropEditChanges(doc: BoardDoc, o: TeardropEditOpts): PcbChange[] {
  const removeAll = o.action === "removeAll";
  // processItem
  const process = (n: SNode, via: boolean): boolean => {
    const before = PM().readTeardrops(n); let td: TeardropParams;
    if (o.action === "remove" || removeAll) td = { ...before, enabled: false };
    else if (o.action === "default") td = { ...(isRound(n, via) ? o.defaults.round : o.defaults.rect), enabled: true };
    else {
      td = { ...before, ...(o.specified || {}) } as TeardropParams;
      for (const k of Object.keys(td) as (keyof TeardropParams)[]) if (td[k] === undefined) (td as unknown as Record<string, unknown>)[k] = before[k];
      if (!o.existingOnly) td.enabled = true;
    }
    if (same(td, before)) return false;
    writeTd(n, td, via); return true;
  };
  // visitItem
  const visit = (n: SNode, via: boolean, picked: boolean, always: boolean): boolean => {
    if (o.selected && !picked) return false;
    if (always) return process(n, via);
    if (o.skip && o.skip({ net: netOf(n).name, layer: firstCopper(n) })) return false;
    if (o.roundOnly && !isRound(n, via)) return false;
    if (o.existingOnly && !PM().readTeardrops(n).enabled) return false;
    return process(n, via);
  };
  const out: PcbChange[] = [], edited = new Map<string, SNode>();
  for (const it of doc.items.values()) {
    if (it.kind === "via" && (o.vias || removeAll)) {
      const n = clone(it.node); if (visit(n, true, !!o.selected && o.selected.has(it.id), removeAll)) { out.push(replacedChange(it, n)); edited.set(it.id, n); }
    } else if (it.kind === "footprint") {
      const n = clone(it.node); let changed = false;
      for (const p of K.kids(n, "pad")) {
        const u = K.kid(p, "uuid"), picked = !!o.selected && (o.selected.has(it.id) || (!!u && o.selected.has(K.str(u[1]))));
        const type = K.str(p[2]);
        if (removeAll) { if (visit(p, false, picked, true)) changed = true; continue; }
        if (o.pthPads && type === "thru_hole") { if (visit(p, false, picked, false)) changed = true; }
        else if (o.smdPads && (type === "smd" || type === "connect" || type === "non_component")) { if (visit(p, false, picked, false)) changed = true; }
      }
      if (changed) { out.push(replacedChange(it, n)); edited.set(it.id, n); }
    }
  }
  // TEARDROP_MANAGER: Track to track (or Remove all) deletes the track-end teardrops, and "default values" adds them
  // again with TARGET_TRACK enabled (BuildTrackCaches, AddTeardropsOnTracks)
  const td: TeardropOpts = { ...(o.teardrop || {}) };
  let res = out;
  if (o.trackToTrack || removeAll) {
    const gone = deleteTrackToTrackTeardrops(doc); res = foldChanges(res, gone);
    if (o.action === "remove" || removeAll) td.trackEnabled = false;
    else if (o.action === "default") {
      td.trackEnabled = true;
      res = foldChanges(res, addTrackToTrackTeardrops(teardropAppliedDoc(doc, res), td));
    }
  }
  // no filter: the edit is pushed with SKIP_TEARDROPS and every teardrop rebuilt in the same undo step
  // (UpdateTeardrops( forceFullUpdate )); with one, the commit's own teardrop pass does it
  if (!o.filtered) {
    res = foldChanges(res, teardropFullUpdate(teardropAppliedDoc(doc, res), td));
    return Object.assign(res, { skipTeardrops: true });
  }
  return res;
}
