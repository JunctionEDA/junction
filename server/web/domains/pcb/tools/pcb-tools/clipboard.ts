// pcb-tools/clipboard.ts — the clipboard in KiCad's own format (a kicad_pcb document), paste and duplicate.
import { canHaveNumber, nextPadNumber, padMemory } from "./pad-tool";
import { GENERATOR_VERSION } from "../../canvas/format-version";
import type { BoardDoc, NetRef, PcbChange, PcbCtx, Pt, SAtom } from "./types";

/** A paste-special / duplicate option bag. */
export interface PasteOpts { annotations?: string; clearNets?: boolean; xform?: (n: SNode, it: KItem, src?: KItem) => void; increment?: boolean }
import { addedChange } from "./changes";
import { conductorEnds } from "./connected";
import { copperOf } from "./dialogs";
import { expandGroups, groupMembers, groupMembersChanges, groupOf, parentOf, setLocked } from "./groups";
import { netTable } from "./netlist";
import { netNode, netOf, netStyle } from "./nets";
import { padsOf } from "./route-geom";
import { BOARD_VERSION, K, S } from "./state";
import { PCB_KINDS, anchorOf, isFootprintNode, mapNodePoints, selectionCenter, translateNode } from "./transforms";
import { clone, isList, norm360, r6, rotator } from "./util";
import { uniqueZoneName } from "./zone-modes";

// ---------------------------------------------------------------- clipboard (KiCad's own format: a kicad_pcb document)
// formatBoardLayers: the copper layers first, in stack order (the parser counts them there), then the rest by id.
export function layersBlock(doc: BoardDoc) {
  const rows: (string | number)[][] = []; for (const [name, l] of doc.layers) if (/\./.test(name) || name === "Margin") rows.push([l.id, name, l.type || "user"].concat(l.userName ? [l.userName] : []));
  if (!rows.length) rows.push([0, "F.Cu", "signal"], [2, "B.Cu", "signal"]);
  const copper = copperOf(doc); const rank = (r: (string | number)[]) => { const i = copper.indexOf(r[1] as string); return i >= 0 ? i : (/\.Cu$/.test(r[1] as string) ? 500 + (r[0] as number) : 1000 + (r[0] as number)); };
  rows.sort((a, b) => rank(a) - rank(b)); return ["layers", ...rows];
}
/** The (layers …) block as text: KiCad's parser wants the layer names and user names quoted, which the serializer would leave bare. */
export const quote = (s: unknown) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
export function layersText(doc: BoardDoc) { return "(layers " + layersBlock(doc).slice(1).map((r) => `(${r[0]} ${quote(r[1])} ${r[2]}${r[3] !== undefined ? " " + quote(r[3]) : ""})`).join(" ") + ")"; }
/** BestDragOrigin: the item anchor nearest the cursor, else the cursor, else the selection's centre. */
export function referencePoint(doc: BoardDoc, ids: string[], cursor: Pt | null | undefined) {
  const items = ids.map((id: string) => doc.items.get(id)).filter(Boolean) as KItem[]; let best: Pt | null = null, bd = Infinity;
  if (cursor) for (const it of items) { const pts = it.kind === "footprint" ? [anchorOf(it)].concat(padsOf(it).map((p) => [p.x, p.y])) : [anchorOf(it)].concat(conductorEnds(it)); for (const p of pts) { const d = Math.hypot(p[0] - cursor![0], p[1] - cursor![1]); if (d < bd) { bd = d; best = p; } } }
  return best || cursor || selectionCenter(items);
}
/** PCB_FIELD::IsMandatory: the footprint fields every footprint has (a copy never carries them into another footprint). */
const MANDATORY_FIELDS = new Set(["Reference", "Value", "Datasheet", "Description"]);
const isMandatoryFieldNode = (n: SNode) => (n[0] === "property" && MANDATORY_FIELDS.has(K.str(n[1]))) || (n[0] === "fp_text" && (n[1] === "reference" || n[1] === "value"));
const stripPadNet = (pad: SNode) => { for (let i = pad.length - 1; i > 0; i--) { const c = pad[i]; if (isList(c) && c[0] === "net") pad.splice(i, 1); } };
/**
 * CLIPBOARD_IO::SaveSelection.  Board editor: a kicad_pcb with the board's layers and the items moved so ref sits at
 * (0, 0); locks dropped; a lone footprint is copied without its pad nets.  KiCad writes no net declarations (items
 * carry their net names); a board in the older numbered-net style gets the table its (net N) items need.
 * Footprint editor: one (footprint "clipboard:<uuid>" …) holding the selected children — mandatory fields skipped,
 * pad nets cleared.  `extra` are nodes the caller built itself (a field copied as text, a pad in its own footprint),
 * already in board coordinates.
 */
export function clipboardText(doc: BoardDoc, ids: Iterable<string>, ref?: Pt | null, extra?: SNode[] | null) {
  ref = ref || [0, 0]; const NT = netTable(doc); const top = Array.from(ids); const items = Array.from(expandGroups(doc, top)).map((id) => doc.items.get(id)).filter(Boolean);
  if (doc.fpEditor) {
    const FD = K.footprintDoc; const parts = [`(footprint ${quote("clipboard:" + K.newUuid())} (layer "F.Cu") (at 0 0)`];
    for (const it of items) {
      if (it!.kind === "property" && isMandatoryFieldNode(it!.node)) continue;
      const node = clone(it!.node); if (node[0] === "pad") stripPadNet(node);
      translateNode(node, -ref![0], -ref![1]);
      setLocked(node, false); parts.push(K.serialize(FD && FD.toFileNode ? FD.toFileNode(node) : node));
    }
    for (const n of fullySelectedConstraints(doc, items as KItem[])) parts.push(K.serialize(n));
    return parts.join("\n") + "\n)";
  }
  const lone = top.length === 1 && !(extra && extra.length) && !!doc.items.get(top[0]) && doc.items.get(top[0])!.kind === "footprint";
  const refd = new Map<string, number>(); const take = (n: NetRef) => { const key = NT.key(n); if (key && !refd.has(key)) refd.set(key, n.code > 0 ? n.code : 0); };
  if (!lone) for (const it of items) { if (it!.kind === "footprint") for (const p of K.kids(it!.node, "pad")) take(netOf(p)); else if (K.kid(it!.node, "net")) take(netOf(it!.node)); }
  let next = 1; const used = new Set(refd.values()); for (const [k, v] of refd) if (!v) { while (used.has(next)) next++; refd.set(k, next); used.add(next); }
  const parts = [`(kicad_pcb (version ${BOARD_VERSION}) (generator "pcbnew") (generator_version "${GENERATOR_VERSION}")`, layersText(doc)];
  if (netStyle(doc) === "code" && refd.size) { parts.push('(net 0 "")'); for (const [name, code] of Array.from(refd).sort((a, b) => a[1] - b[1])) parts.push(`(net ${code} ${quote(name)})`); }
  for (const it of items) {
    const node = clone(it!.node); translateNode(node, -ref![0], -ref![1]); setLocked(node, false);
    if (lone) for (const p of K.kids(node, "pad")) stripPadNet(p);   // "Copy without nets"
    parts.push(K.serialize(node));
  }
  for (const n of extra || []) { const node = clone(n); translateNode(node, -ref![0], -ref![1]); setLocked(node, false); parts.push(K.serialize(node)); }
  for (const n of fullySelectedConstraints(doc, items as KItem[])) parts.push(K.serialize(n));
  return parts.join("\n") + "\n)";
}
/** CollectConstraintScopeIds: the items and everything inside them (a footprint's pads and drawings). */
function constraintScopeIds(items: KItem[]): Set<string> {
  const ids = new Set<string>();
  const walk = (n: SNode) => { const u = K.uuidOf(n); if (u) ids.add(u); for (const c of n) if (isList(c) && c[0] !== "uuid") walk(c); };
  for (const it of items) { ids.add(it.id); walk(it.node); }
  return ids;
}
/** ConstraintFullySelected over the document's constraints: the ones whose every member is in the copied items. */
function fullySelectedConstraints(doc: BoardDoc, items: KItem[]): SNode[] {
  const scope = constraintScopeIds(items); const out: SNode[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "constraint") continue;
    const ms = K.kids(K.kid(it.node, "members") || [], "member");
    if (ms.length && ms.every((m) => scope.has(K.str(m[1])))) out.push(clone(it.node));
  }
  return out;
}
export function parseClipboard(text: string) {
  let trees: SAtom[] | null | undefined; try { trees = K.parseAll(text); } catch (e) { return null; }
  const nodes: SNode[] = [], codeToName = new Map<number, string>();
  for (const t of trees || []) {
    if (!isList(t)) continue;
    if (t[0] === "kicad_pcb") { for (const c of t.slice(1)) { if (!isList(c)) continue; if (c[0] === "net" && typeof c[1] === "number") codeToName.set(c[1], K.str(c[2])); else if (PCB_KINDS.has(c[0] as string)) nodes.push(c); } }
    else if (PCB_KINDS.has(t[0] as string)) nodes.push(t);
  }
  return nodes.length ? { nodes, codeToName } : null;
}
/** Every (uuid) / (tstamp) at any depth gets a new id; group members follow the map (members left behind are dropped). */
export function freshUuids(nodes: SNode[]) {
  const map = new Map<string, string>();
  const walk = (n: SNode) => { for (let i = 1; i < n.length; i++) { const c = n[i]; if (!isList(c)) continue; if ((c[0] === "uuid" || c[0] === "tstamp") && c.length > 1) { const old = K.str(c[1]); if (!map.has(old)) map.set(old, K.newUuid()); c[1] = map.get(old)!; } else walk(c); } };
  for (const n of nodes) walk(n);
  // PCB_CONSTRAINT::RemapKIIDs: a pasted / duplicated constraint points at the copies of its members
  for (const n of nodes) if (n[0] === "constraint") for (const m of K.kids(K.kid(n, "members") || [], "member")) { const id = K.str(m[1]); if (map.has(id)) m[1] = map.get(id)!; }
  for (const n of nodes) if (n[0] === "group" || n[0] === "generated") { const m = K.kid(n, "members"); if (m) { const ids = m.slice(1).map(K.str).filter((id) => map.has(id)).map((id) => map.get(id)!); m.splice(1, m.length - 1, ...ids); } }
  return map;
}
/** Nets are kept by name and rewritten in the target document's style; names the board lacks become unconnected in a code-style board. */
export function rewriteNets(nodes: SNode[], codeToName: Map<number, string>, doc: BoardDoc) {
  const NT = netTable(doc); const style = netStyle(doc);
  const walk = (n: SNode) => {
    for (let i = 1; i < n.length; i++) {
      const c = n[i]; if (!isList(c)) continue;
      if (c[0] === "net" && c.length > 1 && n[0] !== "kicad_pcb") {
        const name = typeof c[1] === "number" ? (c.length > 2 ? K.str(c[2]) : (codeToName.get(c[1]) || "")) : K.str(c[1]);
        if (style === "name") n[i] = ["net", name];
        else { const t = name ? NT.byName.get(name) : null; const code = t && t.code > 0 ? t.code : 0; n[i] = c.length > 2 || n[0] === "pad" ? ["net", code, code ? name : ""] : ["net", code]; }
      } else walk(c);
    }
  };
  for (const n of nodes) walk(n);
}
export const refProp = (node: SNode) => K.kids(node, "property").find((p) => K.str(p[1]) === "Reference");
/** StrNumCmp( a, b, CMP_T::IGNORE_CASE ): digit runs compare by value, the rest letter by letter without case. */
function strNumCmpNoCase(a: string, b: string) {
  const ra = a.match(/\d+|\D/g) || [], rb = b.match(/\d+|\D/g) || [];
  for (let i = 0; i < ra.length && i < rb.length; i++) {
    const x = ra[i], y = rb[i]; const nx = /^\d/.test(x), ny = /^\d/.test(y);
    if (nx && ny) { const d = parseInt(x, 10) - parseInt(y, 10); if (d) return d; }
    else { const c = x.toUpperCase() < y.toUpperCase() ? -1 : x.toUpperCase() > y.toUpperCase() ? 1 : 0; if (c) return c; }
  }
  return ra.length - rb.length;
}
/**
 * Paste-special annotation modes (PASTE_MODE): keep (the default), unique, clear (REF**).
 * unique is BOARD_REANNOTATE_TOOL::ReannotateDuplicates: the pasted footprints sorted by reference (StrNumCmp without
 * case), then Y descending, X ascending; each one whose reference the board already has counts up from its own
 * number until free (no number: from 1), and only a renumbered reference is recorded as used.
 */
export function annotate(nodes: SNode[], doc: BoardDoc, mode: string) {
  if (mode === "keep") return;
  const fps = nodes.filter((n) => isFootprintNode(n) && refProp(n));
  if (mode === "clear") { for (const n of fps) refProp(n)![2] = "REF**"; return; }
  const used = new Set<string>(); for (const it of doc.items.values()) if (it.kind === "footprint") used.add(it.ref || "");
  const order = fps.map((n, i) => ({ n, i })).sort((a, b) => {
    const c = strNumCmpNoCase(K.str(refProp(a.n)![2]), K.str(refProp(b.n)![2])); if (c) return c;
    const pa = K.atOf(a.n), pb = K.atOf(b.n); if (pa[1] !== pb[1]) return pb[1] - pa[1]; if (pa[0] !== pb[0]) return pa[0] - pb[0]; return a.i - b.i;
  });
  for (const { n } of order) {
    const p = refProp(n)!; let ref = K.str(p[2]);
    const stem = ref.replace(/[\d?]+$/, "");                      // UTIL::GetRefDesPrefix
    const d = ref.search(/\d/); let value = d < 0 || !/^\d+$/.test(ref.slice(d)) ? -1 : parseInt(ref.slice(d), 10);   // UTIL::GetRefDesNumber
    let duplicate = false;
    while (used.has(ref)) { duplicate = true; value = value < 0 ? 1 : value + 1; ref = stem + value; }
    if (duplicate) { p[2] = ref; used.add(ref); }
  }
}
/** The layer names a (layers …) list stands for on a board with this copper stack. */
const expandLayers = (names: string[], copper: string[]) => names.flatMap((n) => (n === "*.Cu" ? copper : n === "F&B.Cu" ? ["F.Cu", "B.Cu"] : n.startsWith("*.") ? ["F" + n.slice(1), "B" + n.slice(1)] : [n]));
/** PCB_LAYER_ID of a copper layer name: F.Cu 0, B.Cu 2, InN.Cu 2N + 2. */
const copperId = (name: string) => name === "F.Cu" ? 0 : name === "B.Cu" ? 2 : /^In(\d+)\.Cu$/.test(name) ? 2 * parseInt(name.slice(2), 10) + 2 : -1;
export const PASTE_LAYERS_MSG = "Warning: some pasted items were on layers which are not present in the current board.\nThese items could not be pasted.\n";
/**
 * PCB_CONTROL::pruneItemLayers: an item that does not fit the board's enabled layers is not pasted (and leaves its
 * group); a kept one is confined to the layers the board has.  A footprint is judged by its side only and a group is
 * layer-agnostic; a via needs a valid layer pair as well (PCB_VIA::HasValidLayerPair).  Returns the kept nodes.
 */
export function pruneItemLayers(nodes: SNode[], doc: BoardDoc): SNode[] {
  const enabled = new Set<string>(doc.layers.keys()); const copper = copperOf(doc); if (!enabled.size) return nodes;
  const out: SNode[] = [], gone = new Set<string>();
  for (const n of nodes) {
    const k = n[0] as string; let fits = true;
    if (k === "group" || k === "generated") fits = true;
    else if (k === "footprint") { const l = K.kid(n, "layer"); const side = l ? K.str(l[1]) : ""; fits = side === "F.Cu" || side === "B.Cu"; }
    else if (k === "via") {
      const ls = K.kid(n, "layers"); const pair = ls ? ls.slice(1).map(K.str) : ["F.Cu", "B.Cu"]; const a = copperId(pair[0]), b = copperId(pair[pair.length - 1]);
      const lim = copper.length * 2; const span = copper.filter((c) => { const id = copperId(c), lo = a === 2 ? Infinity : a, hi = b === 2 ? Infinity : b; const v = id === 2 ? Infinity : id; return v >= Math.min(lo, hi) && v <= Math.max(lo, hi); });
      fits = span.length > 0 && !(a > 2 && a > lim) && !(b > 2 && b > lim);
    } else {
      const l = K.kid(n, "layer"), ls = K.kid(n, "layers");
      if (ls) {
        const keep = expandLayers(ls.slice(1).map(K.str), copper).filter((x) => enabled.has(x)); fits = keep.length > 0;
        if (fits && keep.length !== expandLayers(ls.slice(1).map(K.str), copper).length) {   // SetLayerSet( GetLayerSet() & enabledLayers )
          ls.splice(1, ls.length - 1, ...keep);
          if (k === "zone") for (const fp of K.kids(n, "filled_polygon")) { const fl = K.kid(fp, "layer"); if (fl && !enabled.has(K.str(fl[1]))) n.splice(n.indexOf(fp), 1); }
        }
      } else if (l) fits = enabled.has(K.str(l[1]));
    }
    if (fits) out.push(n); else { const u = K.kid(n, "uuid") || K.kid(n, "tstamp"); if (u) gone.add(K.str(u[1])); }
  }
  if (gone.size) for (const n of out) if (n[0] === "group" || n[0] === "generated") { const m = K.kid(n, "members"); if (m) m.splice(1, m.length - 1, ...m.slice(1).filter((id) => !gone.has(K.str(id)))); }
  // a constraint goes with any member that could not be pasted (it would only resolve to an error)
  if (gone.size) return out.filter((n) => n[0] !== "constraint" || !K.kids(K.kid(n, "members") || [], "member").some((m) => gone.has(K.str(m[1]))));
  return out;
}
/** The footprint editor keeps these loose board items of a pasted board (PCB_CONTROL::Paste); tracks, vias, zones, images go. */
const FP_PASTE_DRAWINGS = new Set(["gr_text", "gr_text_box", "table", "gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_curve", "gr_ellipse", "gr_ellipse_arc", "barcode", "dimension", "point"]);
/**
 * pasteFootprintItemsToFootprintEditor: a pasted footprint is taken apart.  Its pads and zones keep where they are on
 * the clipboard (the footprint's place and turn applied); its graphics and non-mandatory fields keep their position
 * relative to the footprint, texts turned back by its orientation; mandatory fields are dropped.  Groups travel as
 * they are.
 */
function footprintToEditorItems(fp: SNode): SNode[] {
  const FD = K.footprintDoc; const at = K.atOf(fp); const px = at[0] || 0, py = at[1] || 0, rot = at[2] || 0; const R = rotator(rot);
  const abs = (x: number, y: number) => { const [dx, dy] = R(x, y); return [px + dx, py + dy]; };
  const out: SNode[] = [];
  for (const c of fp.slice(1)) {
    if (!isList(c) || !FD || !FD.isOwnedFileNode(c)) continue;
    if (isMandatoryFieldNode(c)) continue;
    const k = c[0] as string; let n = clone(c);
    if (k === "pad" || k === "zone") mapNodePoints(n, abs);
    else if ((k === "fp_text" || k === "property") && rot) { const a = K.kid(n, "at"); if (a) { const ang = r6(norm360((a.length > 3 ? K.num(a[3]) : 0) - rot)); a.length = 3; if (ang) a.push(ang); } }
    n = FD.toBoardNode(n); out.push(n);
  }
  return out;
}
/** PCB_CONTROL::Paste in the footprint editor: footprints taken apart, of the loose board items only drawings kept. */
function footprintEditorNodes(nodes: SNode[]): SNode[] {
  const out: SNode[] = [];
  for (const n of nodes) {
    if (n[0] === "footprint") out.push(...footprintToEditorItems(n));
    else if (n[0] === "group" || FP_PASTE_DRAWINGS.has(n[0] as string)) out.push(n);
  }
  const kept = new Set<string>(); for (const n of out) { const u = K.kid(n, "uuid") || K.kid(n, "tstamp"); if (u) kept.add(K.str(u[1])); }
  for (const n of out) if (n[0] === "group") { const m = K.kid(n, "members"); if (m) m.splice(1, m.length - 1, ...m.slice(1).filter((id) => kept.has(K.str(id)))); }
  return out;
}
/**
 * ADDED changes for clipboard text placed with its reference point at `at`; returns { changes, ids, select, pruned }.
 * `select` are the ids PCB_CONTROL::placeBoardItems selects (items whose parent group is not pasted with them);
 * `pruned` says pruneItemLayers left something out (PASTE_LAYERS_MSG).
 */
export function pasteChanges(doc: BoardDoc, text: string, at: Pt | null | undefined, opts?: PasteOpts | null) {
  opts = opts || {}; const parsed = parseClipboard(text); if (!parsed) return { changes: [], ids: [] };
  let nodes = parsed.nodes.map(clone); let pruned = false;
  if (doc.fpEditor) nodes = footprintEditorNodes(nodes);
  else { const kept = pruneItemLayers(nodes, doc); pruned = kept.length < nodes.length; nodes = kept; }
  freshUuids(nodes); rewriteNets(nodes, parsed.codeToName, doc);
  if (!doc.fpEditor) annotate(nodes, doc, opts.annotations || "keep");
  if (opts.clearNets || doc.fpEditor) clearNets(nodes, doc);
  for (const n of nodes) {
    // a pasted footprint is new: no schematic symbol behind it (footprint->SetPath( KIID_PATH() ))
    if (n[0] === "footprint") { const p = K.kid(n, "path"); if (p) n.splice(n.indexOf(p), 1); }
    // a pasted zone must not reuse a name the board has (BOARD::GetUniqueZoneName)
    if (n[0] === "zone" && !doc.fpEditor) { const nm = K.kid(n, "name"); if (nm && K.str(nm[1])) nm[1] = uniqueZoneName(doc, K.str(nm[1])); }
  }
  const changes: PcbChange[] = [], ids: string[] = []; const inGroup = new Set<string>();
  for (const n of nodes) if (n[0] === "group" || n[0] === "generated") for (const id of groupMembers(n)) inGroup.add(id);
  for (const n of nodes) {
    if (at && (at[0] || at[1])) translateNode(n, at[0], at[1]);
    const c = addedChange(doc, n); changes.push(c); if (n[0] !== "constraint") ids.push(c.id);   // constraints are not selectable
  }
  const res: { changes: PcbChange[]; ids: string[]; select?: string[]; pruned?: boolean } = { changes, ids };
  if (ids.some((id) => inGroup.has(id))) res.select = ids.filter((id) => !inGroup.has(id));
  if (pruned) res.pruned = true;
  return res;
}
/**
 * DIALOG_PASTE_SPECIAL's "Clear net assignments": every pasted connected item goes onto the orphaned net
 * (SetNet( NETINFO_LIST::OrphanedItem() )) — pads lose their (net …), tracks, vias and zones take net 0 / "".
 */
export function clearNets(nodes: SNode[], doc: BoardDoc) {
  const walk = (n: SNode) => {
    for (let i = n.length - 1; i > 0; i--) {
      const c = n[i]; if (!isList(c)) continue;
      if (c[0] === "net" && n[0] !== "kicad_pcb") { if (n[0] === "pad") n.splice(i, 1); else n[i] = netNode(doc, null); }
      else if (c[0] === "net_name") c[1] = "";
      else walk(c);
    }
  };
  for (const n of nodes) walk(n);
}
/**
 * EDIT_TOOL::Duplicate: BOARD_ITEM::Duplicate clones each item with a new uuid and nothing else changed — the same
 * reference, lock state, nets and place — and a copy whose original sits in a group that is not itself being
 * duplicated joins that group (the group is MODIFIED in the same commit).  A selected group is copied whole
 * (PCB_GROUP::DeepDuplicate): a new group holding copies of its members.  Returns { changes, ids, restore } where
 * restore holds the groups' nodes before the copies joined them (a cancelled placement puts them back).
 */
export function duplicateChanges(doc: BoardDoc, ids: Iterable<string>, offset?: Pt | null, opts?: PasteOpts | null) {
  const sel = new Set(ids); const out: { changes: PcbChange[]; ids: string[]; restore: { id: string; node: SNode }[] } = { changes: [], ids: [], restore: [] }; const joins = new Map<string, string[]>();
  const coveredByGroup = (id: string) => { for (let g = parentOf(doc, id); g; g = parentOf(doc, g.id)) if (sel.has(g.id)) return true; return false; };
  const isParent = (n: SNode) => n[0] === "group" || n[0] === "generated";
  const subtree = (it: KItem, acc: KItem[]): KItem[] => { acc.push(it); if (it.kind === "group" || it.kind === "generated") for (const m of groupMembers(it.node)) { const c = doc.items.get(m); if (c) subtree(c, acc); } return acc; };
  const incUsed = new Set<string>();   // numbers taken by copies made earlier in this pass
  const idMap = new Map<string, string>();   // original uuid -> its copy's, for the constraints carried along
  for (const id of ids) {
    // a generator (a tuning pattern) is copied as PCB_GENERATOR::DeepDuplicate does: a new generator holding copies of its members
    const it = doc.items.get(id); if (!it || coveredByGroup(id)) continue;
    if (doc.fpEditor && it.kind === "property") continue;   // EDIT_TOOL::Duplicate: a footprint's fields are not duplicated
    const src = subtree(it, []);
    const nodes = src.map((x) => clone(x.node)); for (const [a, b] of freshUuids(nodes)) idMap.set(a, b);
    // Duplicate and Increment (footprint editor): the copy takes FOOTPRINT::GetNextPadNumber of PAD_TOOL's last number
    if (doc.fpEditor && opts && opts.increment) for (const n of nodes) if (n[0] === "pad" && canHaveNumber(n)) {
      n[1] = padMemory.lastNumber = nextPadNumber(doc, padMemory.lastNumber, incUsed); incUsed.add(String(n[1]));
    }
    if (opts && opts.annotations) annotate(nodes, doc, opts.annotations);
    if (opts && opts.xform) nodes.forEach((n, i) => opts.xform!(n, it, src[i]));   // the array tool's per-copy transform (about the top item)
    // members first, so a group's ADDED change finds them
    const order = nodes.map((n, i: number) => i).sort((a, b) => (isParent(nodes[a]) as unknown as number) - (isParent(nodes[b]) as unknown as number) || b - a);   // booleans subtract as 0/1
    let topId: string | null = null;
    for (const i of order) {
      const n = nodes[i]; if (offset && (offset[0] || offset[1])) translateNode(n, offset[0], offset[1]);
      const c = addedChange(doc, n); out.changes.push(c); out.ids.push(c.id); if (i === 0) topId = c.id;
    }
    const g = groupOf(doc, id);
    if (g && topId) { if (!joins.has(g.id)) joins.set(g.id, []); joins.get(g.id)!.push(topId); }
  }
  for (const [gid, add] of joins) { const g = doc.items.get(gid); out.restore.push({ id: gid, node: clone(g!.node) }); out.changes.push(...groupMembersChanges(doc, g!, add, [])); }
  // CloneFullySelectedConstraints: the constraints whose members were all duplicated, repointed at the copies (kept out of the selection)
  for (const it of Array.from(doc.items.values())) {
    if (it.kind !== "constraint") continue;
    const ms = K.kids(K.kid(it.node, "members") || [], "member");
    if (!ms.length || !ms.every((m) => idMap.has(K.str(m[1])))) continue;
    const n = clone(it.node); freshUuids([n]);
    for (const m of K.kids(K.kid(n, "members") || [], "member")) m[1] = idMap.get(K.str(m[1]))!;
    out.changes.push(addedChange(doc, n));
  }
  return out;
}
/**
 * EDIT_TOOL::copyToClipboardAsText's getItemText: a text, a field (footprint editor), a dimension or a text box gives
 * its shown text (GetShownText( FOR_CANVAS ): its variables resolved, pcb-textvars.ts); a table its cells' shown texts,
 * tab-joined along a row and newline-joined down the rows; anything else (a footprint included) has no string
 * representation.  Without `doc` the texts are taken as written.
 */
export function textOfItem(it: KItem, doc?: KDoc | null): string {
  const shown = (t: string, layerNode: SNode): string => (doc ? K.pcbTextShown(doc, t, K.str((K.kid(layerNode, "layer") || [])[1]) || "Dwgs.User") : t);
  const unesc = K.unescapeText as (s: string) => string;
  if (it.kind === "gr_text" || it.kind === "fp_text") return shown(K.str(it.node[1]), it.node);
  if (it.kind === "gr_text_box" || it.kind === "fp_text_box") return shown(doc ? unesc(K.str(it.node[1])) : K.str(it.node[1]), it.node);
  if (it.kind === "property") return shown(K.str(it.node[2]), it.node);
  if (it.kind === "dimension") return shown(K.str((K.kid(it.node, "gr_text") || [])[1]), it.node);
  if (it.kind === "table") {
    const cols = Math.max(1, K.num((K.kid(it.node, "column_count") || [])[1]) || 1), cells = K.kid(it.node, "cells"); if (!cells) return "";
    const texts = K.kids(cells, "table_cell").map((c, i) => (doc ? K.tableCellShownText(doc, it.node, i, true) : K.str(c[1]))); const rows: string[] = [];
    for (let i = 0; i < texts.length; i += cols) rows.push(texts.slice(i, i + cols).join("\t"));
    return rows.join("\n");
  }
  return "";
}
// The clipboard: the browser's when it can be reached, an app-supplied one, else a buffer of our own.
export let clipBuffer = "";
export function clipSet(ctx: PcbCtx, text: string) {
  clipBuffer = text; if (ctx.clipboard && ctx.clipboard.set) ctx.clipboard.set(text);
  if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
}
/**
 * What Ctrl+V pastes: the system clipboard as it is (KiCad items, any other text, or "" when it holds no text — an
 * image, perhaps); the editor's own buffer only when the clipboard cannot be read or is empty.
 */
export function clipGet(ctx: PcbCtx, done: (text: string) => void) {
  const cb = ctx.clipboard;
  if (cb && typeof cb.read === "function") { try { const v = cb.read(); if (v && typeof v.then === "function") { v.then((t) => done(t === "" ? "" : t || clipBuffer), () => done(clipBuffer)); return; } } catch (e) { /* fall through */ } }
  if (cb && cb.get) { const v = cb.get(); if (v && typeof (v as Promise<string | null | undefined>).then === "function") { (v as Promise<string | null | undefined>).then((t) => done(t || clipBuffer), () => done(clipBuffer)); return; } done((v as string | null | undefined) || clipBuffer); return; }
  if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.readText) { navigator.clipboard.readText().then((t) => done(t || clipBuffer), () => done(clipBuffer)); return; }
  done(clipBuffer);
}
export function cursorPoint(ctx: PcbCtx) {
  let p: Pt | null = ctx.cursor || (S.hover ? [S.hover.x, S.hover.y] : null);
  if (!p && ctx.doc && ctx.doc.bbox) p = [(ctx.doc.bbox[0] + ctx.doc.bbox[2]) / 2, (ctx.doc.bbox[1] + ctx.doc.bbox[3]) / 2];
  if (!p) return [0, 0]; return ctx.snapOn && ctx.snap ? ctx.snap(p) : p;
}
