// editor/schnets — the schematic net highlight across the whole hierarchy (SCH_EDITOR_CONTROL::HighlightNet /
// UpdateNetHighlighting) and the model behind the Net Navigator.
//
// eeschema keeps the highlighted connection as a net NAME, not as a set of items: on every sheet change and every
// edit the items of that net are collected again on the sheet on screen (NAVIGATION_QUERY::CollectNetItems), so the
// highlight follows the net into sub-sheets and back up through sheet pins, hierarchical labels, global labels and
// power nets.  The browser has one sheet open, so the project's other sheets are read (live: snapshot + ops) and
// kept; the net map is rebuilt from them and the sheet on screen (canvas/pcb-netlist.ts buildNetlist, the
// CONNECTION_GRAPH naming rules) whenever someone needs it.
//
// sch-tools.js hands its picks here through CollabTools.sch.setNetHighlighter (see highlightClick there).
import type { NetEntry, SheetFile, SheetInstance } from "../canvas/pcb-netlist";
import type { schNets } from "../canvas/sch-nets";
import { setStatusBar, state } from "./appstore";
import { focusOnLocation } from "./pcbdialogs/find";
import { findSheetDoc, openDoc, readSavedSchematic, rootSchematic, topLevelSchematics } from "./doc";
import { NL } from "./pcbdialogs/canvas";
import { liveDocument, projectDocs, type ProjectDocInfo } from "./projectfile";
import { E } from "./state";
import { toolCtx } from "./tools";

const SN = (): typeof schNets => (KiCadCanvas as unknown as { schNets: typeof schNets }).schNets;
const SCH_IU = 10000;

interface SchHelpers {
  symbolPins(doc: KDoc, item: KItem): { x: number; y: number; number: string; name: string; type: string; hidden: boolean }[];
  isPowerSymbol(doc: KDoc, libId: string): boolean;
  setHighlight(ctx: ToolCtx, ids: Set<string> | null): void;
}
const schMod = (): (SchToolModule & { setNetHighlighter?(h: unknown): void }) | undefined => CollabTools.sch as (SchToolModule & { setNetHighlighter?(h: unknown): void }) | undefined;
const helpers = (): SchHelpers | null => { const m = schMod(); return m && m._ ? m._ as unknown as SchHelpers : null; };
interface Pick { item: KItem; at?: [number, number]; pin?: string }

/** The highlight: the net's name, the bus-members toggle and the item the navigator should show selected. */
export const HL = { name: null as string | null, busMembers: false, nav: null as { inst: number; id: string; pin?: string } | null, chain: null as string | null };
/** editor/netchains.ts's view of the net chains (NETCHAIN_MANAGER::GetNetChainByName / GetNetChainForNet) and the status line. */
export const chainHooks = {
  byName: null as ((name: string) => { name: string; nets: string[] } | null) | null,
  forNet: null as ((net: string) => { name: string; nets: string[] } | null) | null,
  status: null as ((name: string) => string | null) | null,
};
/** The sheet instance to show a file as when it is opened from the navigator (a file used twice has two). */
let preferHuman: string | null = null;

// ---------------------------------------------------------------- the project's sheets
interface Cached { file: SheetFile; at: number }
const sheets = new Map<string, Cached>();   // docId -> the sheet as last read (the open one is always taken live)
let sheetsProject = "", loading: Promise<void> | null = null, loadedVer = 0, lastLive: { docId: string; doc: KDoc } | null = null;
const STALE_MS = 30000;
const projectKey = (): string => { const p = state.project as { projectId?: string } | null; return (p && p.projectId) || ""; };
const schDocs = (): ProjectDocInfo[] => projectDocs().filter((d) => d.docType === "kicad_sch");
const curEntry = (): ProjectDocInfo | null => ((state as { doc?: ProjectDocInfo | null }).doc) || null;

async function readSheet(d: ProjectDocInfo): Promise<SheetFile | null> {
  let text: string | null = null, ops: { changes?: KChange[] }[] = [];
  if ((state as { me?: unknown }).me) { try { const live = await liveDocument(d.docId); text = live.file; ops = live.ops; } catch (e) { text = null; } }
  const doc = text === null ? await readSavedSchematic(d.docId) : KiCadCanvas.parseDoc(text, "kicad_sch");
  if (!doc) return null;
  for (const op of ops) for (const c of op.changes || []) { try { KiCadCanvas.applyChange(doc, c, SCH_IU); } catch (e) { /* an op this reader cannot take */ } }
  return { doc, uuid: String((doc as KDoc & { uuid?: string }).uuid || ""), file: d.path };
}
/** Read the sheets that are not on screen (again when older than STALE_MS); resolves when they are in. */
export function loadSheets(force = false): Promise<void> {
  if (sheetsProject !== projectKey()) { sheets.clear(); sheetsProject = projectKey(); }
  const now = Date.now(), cur = state.docId as string | null;
  const want = schDocs().filter((d) => d.docId !== cur && (force || !sheets.has(d.docId) || now - (sheets.get(d.docId) as Cached).at > STALE_MS));
  if (!want.length) return Promise.resolve();
  if (loading) return force ? loading.then(() => loadSheets(true)) : loading;
  const pid = projectKey();
  loading = Promise.all(want.map(async (d) => { const f = await readSheet(d); if (f && pid === projectKey()) sheets.set(d.docId, { file: f, at: Date.now() }); }))
    .then(() => { loading = null; loadedVer++; computed = null; syncInstancePath(); refreshNetTexts(); changed(); }, () => { loading = null; });
  return loading;
}

// ---------------------------------------------------------------- the net map
interface Computed { map: Map<string, NetEntry>; instances: SheetInstance[]; index: Map<string, string>; rootName: string; docs: Map<string, KDoc>; key: string;
  /** the netclass label assignments the hierarchy gives (directive labels, Netclass fields, rule areas) */
  netclassLabels?: Map<string, Set<string>> }
let computed: Computed | null = null, docGen = 0, proSeen: unknown = null, proGen = 0;
function compute(): Computed | null {
  const h = helpers(); const cur = curEntry(), doc = E.kdoc as KDoc | null;
  if (!h || !cur || !doc || doc.type !== "sch") return null;
  const topKey = topLevelSchematics().map((t) => t.doc.docId + ":" + t.name).join(",");
  if (E.proSettings !== proSeen) { proSeen = E.proSettings; proGen++; }   // the project's bus aliases and text variables name nets too
  const key = `${projectKey()}|${cur.docId}|${docGen}|${loadedVer}|${topKey}|${proGen}`;
  if (computed && computed.key === key) return computed;
  const files = new Map<string, SheetFile>(), docs = new Map<string, KDoc>();
  for (const d of schDocs()) {
    if (d.docId === cur.docId) { const c = sheets.get(d.docId); files.set(d.path, { doc, uuid: String((doc as KDoc & { uuid?: string }).uuid || (c ? c.file.uuid : "")), file: d.path }); }
    else { const c = sheets.get(d.docId); if (c) files.set(d.path, c.file); }
  }
  if (!files.has(cur.path)) files.set(cur.path, { doc, uuid: String((doc as KDoc & { uuid?: string }).uuid || ""), file: cur.path });
  for (const [p, f] of files) docs.set(p, f.doc);
  const root = (state.project ? rootSchematic() : null) as ProjectDocInfo | null;
  const rootFile = (root && files.get(root.path)) || files.get(cur.path) as SheetFile;
  const resolve = (file: string, parent: SheetFile): SheetFile | null => {
    const entry = findSheetDoc(file, parent.file);
    return entry ? files.get(entry.path) || null : null;
  };
  const stem = rootFile.file.split("/").pop()!.replace(/\.kicad_sch$/, "");
  const pro = projectDocs().find((d) => d.docType === "kicad_pro");
  const project = pro ? pro.path.split("/").pop()!.replace(/\.kicad_pro$/, "") : stem;
  // the top-level sheets read so far (all of them once loadSheets is done; the root alone before the project file is in)
  const tops = topLevelSchematics().map((t) => ({ sheet: files.get(t.doc.path) as SheetFile, name: t.name, uuid: t.uuid })).filter((t) => !!t.sheet);
  const nl = NL().buildNetlist(tops.length > 1 ? tops : rootFile, resolve, { symbolPins: h.symbolPins, isPower: (d, it) => h.isPowerSymbol(d, String(((KiCadCanvas.kid(it.node, "lib_id") as SNode | null) || [])[1])) }, project, NL().netlistOptions(E.proSettings || null));
  const map = nl.netMap || new Map<string, NetEntry>(), instances = nl.instances || [];
  computed = { map, instances, index: SN().nameIndex(map), rootName: stem, docs, key, netclassLabels: nl.netclassLabels };
  return computed;
}
/** The net map of the whole hierarchy as it stands (null outside a schematic). */
export function netMap(): Computed | null { try { return compute(); } catch (e) { console.warn(e); return null; } }
/** The sheet instance on screen. */
export function currentInstance(c: Computed | null = netMap()): SheetInstance | null {
  const cur = curEntry(); if (!c || !cur) return null;
  // the instance asked for (the navigator, the hierarchy pane) when it is one of this file's, else the sheet's own path
  const asked = preferHuman && c.instances.some((i) => i.file === cur.path && i.human === preferHuman) ? preferHuman : null;
  return SN().instanceFor(c.instances, cur.path, asked || (E.kdoc as KDoc & { sheetPath?: string } | null)?.sheetPath || null);
}
export function docOfInstance(c: Computed, inst: SheetInstance): KDoc | null { return c.docs.get(inst.file) || null; }

// ---------------------------------------------------------------- the highlight
const listeners = new Set<() => void>();
/** Called when the highlight or the net map changes (the Net Navigator rebuilds). */
export function onNetsChanged(fn: () => void): void { listeners.add(fn); }
function changed(): void { for (const fn of listeners) { try { fn(); } catch (e) { console.warn(e); } } }

/** UpdateNetHighlighting: brighten the items of the highlighted net on this sheet; the status bar names the net. */
export function applyHighlight(ctx: ToolCtx = (toolCtx as unknown as () => ToolCtx)()): void {
  const h = helpers(); if (!h) return;
  const chain = HL.chain && chainHooks.byName ? chainHooks.byName(HL.chain) : null;
  if (!HL.name && !chain) { h.setHighlight(ctx, null); setStatusBar({ message: "" }); changed(); return; }
  const c = netMap(), inst = currentInstance(c);
  const keys = c && inst && HL.name ? SN().collectKeys(c.map, HL.name, inst.index, HL.busMembers) : new Set<string>();
  // the highlighted chain's nets are collected too (UpdateNetHighlighting)
  if (c && inst && chain) for (const n of chain.nets) for (const k of SN().collectKeys(c.map, n, inst.index, false)) keys.add(k);
  h.setHighlight(ctx, keys.size ? keys : null);
  // UpdateNetHighlightStatus: "Net chain members: …" for a highlighted chain, else the net
  const chainLine = chain && chainHooks.status ? chainHooks.status(chain.name) : null;
  setStatusBar({ message: chainLine !== null ? chainLine : HL.name ? SN().highlightStatus(HL.name) : "" });
  changed();
}
/** SetHighlightedConnection( name ): highlight a net by name (the Search pane, a cross-probe, a test). */
export function highlightName(name: string | null, ctx?: ToolCtx): void { HL.name = name || null; HL.busMembers = false; HL.nav = null; applyHighlight(ctx); }
export function clearHighlight(ctx?: ToolCtx): void { HL.name = null; HL.busMembers = false; HL.nav = null; HL.chain = null; applyHighlight(ctx); }
/** SCH_EDIT_FRAME::HandleRemoteNetHighlight: the net, and its chain when it is on one. */
export function highlightRemote(name: string | null, ctx?: ToolCtx): void {
  const chain = name && chainHooks.forNet ? chainHooks.forNet(name) : null;
  HL.chain = chain ? chain.name : null;
  highlightName(name, ctx);
}

/** GetConnectionName of the picked item on this sheet: a pin by its number, a sheet pin by its name. */
export function nameOfPick(pick: Pick | null): { name: string | null; inst: number; id: string; pin?: string } | null {
  if (!pick || !pick.item) return null;
  const c = netMap(), inst = currentInstance(c); if (!c || !inst) return null;
  const it = pick.item, K = KiCadCanvas; let pin: string | undefined;
  if (it.kind === "symbol") {
    pin = pick.pin;
    if (!pin) { const h = helpers(); const pins = h ? h.symbolPins(E.kdoc as KDoc, it) : []; let bd = Infinity; const at = pick.at || [0, 0]; for (const p of pins) { const d = Math.hypot(p.x - at[0], p.y - at[1]); if (d < bd) { bd = d; pin = p.number; } } }
  } else if (it.kind === "sheet" && pick.pin !== undefined) {
    pin = pick.pin;
  } else if (it.kind === "sheet") {
    const at = pick.at || [0, 0]; let bd = Infinity;
    for (const p of K.kids(it.node, "pin") as SNode[]) { const a = K.atOf(p) as number[]; const d = Math.hypot(a[0] - at[0], a[1] - at[1]); if (d < bd) { bd = d; pin = K.str(p[1]); } }
  }
  const key = inst.index + "|" + it.id + (pin !== undefined ? "#pin:" + pin : "");
  return { name: c.index.get(key) || null, inst: inst.index, id: it.id, pin };
}

/**
 * highlightNet(): a new net replaces the highlight (and the bus-members toggle is reset); the same net again
 * toggles SetHighlightBusMembers and selects the item in the Net Navigator; nothing named there clears it.
 */
export function highlightPick(ctx: ToolCtx, pick: Pick | null): void {
  const r = nameOfPick(pick);
  if (!r || !r.name) { clearHighlight(ctx); return; }
  // a new net drops the chain highlight; the same net again highlights its chain when it is on one, else toggles
  // the bus members
  if (r.name !== HL.name) { HL.busMembers = false; HL.chain = null; HL.name = r.name; HL.nav = { inst: r.inst, id: r.id, pin: r.pin }; }
  else {
    const chain = chainHooks.forNet ? chainHooks.forNet(r.name) : null;
    if (chain) { HL.name = null; HL.chain = chain.name; HL.busMembers = false; }
    else { HL.busMembers = !HL.busMembers; HL.nav = { inst: r.inst, id: r.id, pin: r.pin }; }
  }
  applyHighlight(ctx);
}

/** The sheet on screen changed (an edit: the same sheet; a switch: another one). */
function docChanged(ctx: ToolCtx, sameDoc: boolean): void {
  docGen++;
  const cur = state.docId as string | null;
  if (!sameDoc) {
    // the sheet just left: what was on screen is newer than the server's copy for a moment
    const left = lastLive && lastLive.docId !== cur ? schDocs().find((d) => d.docId === lastLive!.docId) : null;
    if (left && lastLive) sheets.set(left.docId, { file: { doc: lastLive.doc, uuid: String((lastLive.doc as KDoc & { uuid?: string }).uuid || ""), file: left.path }, at: Date.now() });
    void loadSheets().then(() => { syncInstancePath(); if (HL.name || HL.chain) applyHighlight(); else changed(); });
  }
  if (cur && E.kdoc) lastLive = { docId: cur, doc: E.kdoc as KDoc };
  refreshNetTexts(ctx);
  if (HL.name || HL.chain) applyHighlight(ctx); else changed();
}

/**
 * SCH_SHEET_PATH::UpdateAllScreenReferences: the symbols of the sheet on screen show the reference and the unit of
 * its sheet instance (a file used twice has two sets).  Until the hierarchy is read the Reference fields stand.
 */
export function syncInstancePath(): void {
  const doc = E.kdoc as KDoc | null; if (!doc || doc.type !== "sch") return;
  let path: string | null = null;
  try { const inst = currentInstance(); path = inst && inst.uuidPath.length ? "/" + inst.uuidPath.join("/") : null; } catch (e) { path = null; }
  if (path === null) return;
  if (KiCadCanvas.setInstancePath(doc, path)) { try { (toolCtx as unknown as () => ToolCtx)().requestRender(); } catch (e) { /* no canvas yet */ } }
}
// ---------------------------------------------------------------- ${NET_NAME} / ${SHORT_NET_NAME} / ${NET_CLASS} in labels
let sizesSrc: unknown = undefined, sizes: unknown = null;
/** GetEffectiveNetClass( path )->GetName() of a net. */
export function netclassOfNet(name: string): string {
  const PS = (KiCadCanvas as unknown as { pcbSizes?: { boardSizes(src: unknown): unknown; effectiveNetclass(s: unknown, net: string): { name?: string } } }).pcbSizes;
  if (!PS) return "Default";
  try { if (sizesSrc !== E.proSettings) { sizesSrc = E.proSettings; sizes = PS.boardSizes(E.proSettings || null); } return PS.effectiveNetclass(sizes, name).name || "Default"; } catch (e) { return "Default"; }
}
/**
 * SCH_LABEL_BASE::ResolveTextVar's connection tokens for a label of the sheet on screen: NET_NAME is
 * GetConnectionName( path ), SHORT_NET_NAME the name without its sheet path, NET_CLASS the effective netclass (empty
 * when the label is on no net).  null (the token stays as written) for an item of another document.
 */
function labelTextVar(item: KItem, token: string): string | null {
  const doc = E.kdoc as KDoc | null; if (!doc || doc.items.get(item.id) !== item) return null;
  const c = netMap(), inst = currentInstance(c); if (!c || !inst) return null;
  const name = c.index.get(inst.index + "|" + item.id) || "";
  if (token === "NET_NAME") return NL().unescapeNetName(name);
  if (token === "SHORT_NET_NAME") return NL().unescapeNetName(name.slice(name.lastIndexOf("/") + 1));
  if (token === "NET_CLASS") return name ? netclassOfNet(name) : "";
  return null;
}
interface LabelVarCanvas { setLabelTextVar?(fn: ((item: KItem, token: string) => string | null) | null): void; refreshLabelTextVars?(doc: KDoc): boolean }
interface SymVarCanvas {
  symVars?: { net: unknown; unitPlaced: unknown; crossRef: unknown; refSuffix?: unknown };
  symbolInstance?(n: SNode, path: string | null): { ref: string; unit: number | null } | null;
  resolveCrossReference?(sheets: { doc: KDoc; path: string | null }[], token: string, depth: number): string;
}
/** A symbol's reference and unit on a sheet instance (SCH_SYMBOL::GetRef( path, false ) / GetUnitSelection( path )). */
function refAndUnit(node: SNode, path: string): { ref: string; unit: number } {
  const K = KiCadCanvas as unknown as SymVarCanvas & { kid(n: SNode, k: string): SNode | null; kids(n: SNode, k: string): SNode[]; str(v: unknown): string };
  const inst = K.symbolInstance ? K.symbolInstance(node, path) : null, rp = K.kids(node, "property").find((p) => K.str(p[1]) === "Reference"), u = K.kid(node, "unit");
  return { ref: inst && inst.ref ? inst.ref : rp ? K.str(rp[2]) : "", unit: inst && inst.unit !== null ? inst.unit : u ? Number(u[1]) || 1 : 1 };
}
/** The placed symbol (and its sheet instance) with a reference and unit, anywhere in the hierarchy. */
function findUnit(c: Computed, ref: string, unit: number): { inst: SheetInstance; it: KItem } | null {
  for (const inst of c.instances) {
    const d = c.docs.get(inst.file), path = "/" + inst.uuidPath.join("/"); if (!d) continue;
    for (const it of d.items.values()) { if (it.kind !== "symbol") continue; const ru = refAndUnit(it.node, path); if (ru.ref === ref && ru.unit === unit) return { inst, it }; }
  }
  return null;
}
/**
 * SCH_SYMBOL::ResolveTextVar's NET_NAME( pin ), SHORT_NET_NAME( pin ) and NET_CLASS( pin ) from the connection graph:
 * SCH_PIN::GetConnectionName( path, local ) ("NC" for an unconnected pin's short name) and GetEffectiveNetClass.  A
 * pin of another unit (`unit`) is the one on the sheet where that unit is placed.  null when the pin has no connection.
 */
function symbolNetVar(item: KItem, pin: string, kind: "NET_NAME" | "SHORT_NET_NAME" | "NET_CLASS", unit: number | null): string | null {
  const doc = E.kdoc as KDoc | null; if (!doc || !doc.items.has(item.id)) return null;
  const c = netMap(), here = currentInstance(c); if (!c || !here) return null;
  let at: SheetInstance = here, id = item.id;
  if (unit !== null) { const f = findUnit(c, refAndUnit(item.node, "/" + here.uuidPath.join("/")).ref, unit); if (!f) return null; at = f.inst; id = f.it.id; }
  const name = c.index.get(at.index + "|" + id + "#pin:" + pin); if (name === undefined) return null;
  if (kind === "NET_CLASS") return name ? netclassOfNet(name) : "";
  if (kind === "SHORT_NET_NAME") { const local = NL().unescapeNetName(name.slice(name.lastIndexOf("/") + 1)); return local.toLowerCase().startsWith("unconnected") ? "NC" : local; }
  return NL().unescapeNetName(name);
}
/** Whether a unit of `ref` is placed anywhere (false: "<Unit X not placed>"), with that unit's pin's alternate. */
function symbolUnitPlaced(item: KItem, ref: string, unit: number, pin?: string): { alt?: string } | false | null {
  const c = netMap(); if (!c || !c.instances.length) return null;
  const f = findUnit(c, ref, unit); if (!f) return false;
  const K = KiCadCanvas as unknown as { kid(n: SNode, k: string): SNode | null; kids(n: SNode, k: string): SNode[]; str(v: unknown): string };
  const ip = pin !== undefined ? K.kids(f.it.node, "pin").find((p) => K.str(p[1]) === pin) : undefined, a = ip ? K.kid(ip, "alternate") : null;
  return a && K.str(a[1]) ? { alt: K.str(a[1]) } : {};
}
/** SCHEMATIC::ResolveCrossReference over every sheet instance of the hierarchy (the open sheet as it is now). */
function symbolCrossRef(token: string, depth: number): string | null {
  const KC = KiCadCanvas as unknown as SymVarCanvas, c = netMap(), cur = curEntry(); if (!c || !c.instances.length || !KC.resolveCrossReference) return null;
  const sheets: { doc: KDoc; path: string | null }[] = [];
  for (const inst of c.instances) { const d = cur && inst.file === cur.path && E.kdoc ? E.kdoc as KDoc : c.docs.get(inst.file); if (d) sheets.push({ doc: d, path: "/" + inst.uuidPath.join("/") }); }
  return KC.resolveCrossReference(sheets, token, depth);
}
/** SCHEMATIC::GetRefSuffix of a sheet instance path, from the hierarchy the net map walked (the project's suffix mode). */
const suffixCache = new WeakMap<Computed, { mode: boolean; get(path: string): string }>();
function symbolRefSuffix(path: string): string {
  const c = netMap(); if (!c || !c.instances.length) return "";
  let mode = false;
  try { const pro = JSON.parse((E.proSettings as string | null) || "{}") as { schematic?: { annotation?: { reused_sheet_suffixes?: boolean } } }; mode = !!(pro.schematic && pro.schematic.annotation && pro.schematic.annotation.reused_sheet_suffixes); } catch (e) { mode = false; }
  if (!mode) return "";
  let hit = suffixCache.get(c);
  if (!hit || hit.mode !== mode) {
    const RS = KiCadCanvas.refSuffix, out = new Map<string, string>();
    for (const inst of c.instances) {
      const chain: (SNode | null)[] = [];
      for (let k = 1; k < inst.uuidPath.length; k++) {
        const parent = c.instances.find((x) => x.uuidPath.length === k && x.uuidPath.every((u, j) => inst.uuidPath[j] === u));
        const pd = parent ? c.docs.get(parent.file) : undefined, it = pd ? pd.items.get(inst.uuidPath[k]) : undefined;
        chain.push(it ? it.node as SNode : null);
      }
      out.set("/" + inst.uuidPath.join("/"), RS.composeRefSuffix(chain));
    }
    hit = { mode, get: (p: string) => out.get(p) || "" }; suffixCache.set(c, hit);
  }
  return hit.get(path);
}
/** One sheet instance as the suffix tools take it (sch-tools AnnSheet, with PathHumanReadable( false ) as `readable`). */
export interface SuffixSheet { doc: KDoc; path: string; page: number; shown: boolean; project: string; file: string; human: string; readable: string; sheets: (SNode | null)[] }
/**
 * The hierarchy as the reused-sheet suffix tools read it (ctx.suffixSheets): every sheet instance with its file's
 * document (the one on screen for its own file), its sheet symbols from the top down, and the project's
 * annotation.reused_sheet_suffixes and annotation.increment_pasted_suffix.  null until the hierarchy is read.
 */
export function suffixSheets(): { sheets: SuffixSheet[]; mode: boolean; increment: boolean } | null {
  const c = netMap(), cur = curEntry(); if (!c || !c.instances.length || !cur) return null;
  let a: { reused_sheet_suffixes?: boolean; increment_pasted_suffix?: boolean } = {};
  try { const pro = JSON.parse((E.proSettings as string | null) || "{}") as { schematic?: { annotation?: typeof a } }; a = (pro.schematic && pro.schematic.annotation) || {}; } catch (e) { a = {}; }
  const pro = projectDocs().find((d) => d.docType === "kicad_pro"), project = pro ? pro.path.split("/").pop()!.replace(/\.kicad_pro$/, "") : c.rootName;
  const here = currentInstance(c), out: SuffixSheet[] = [];
  for (const inst of c.instances) {
    const doc = inst.file === cur.path && E.kdoc ? E.kdoc as KDoc : c.docs.get(inst.file); if (!doc) return null;
    const chain: (SNode | null)[] = [];
    for (let k = 1; k < inst.uuidPath.length; k++) {
      const parent = c.instances.find((x) => x.uuidPath.length === k && x.uuidPath.every((u, j) => inst.uuidPath[j] === u));
      const pd = parent ? (parent.file === cur.path && E.kdoc ? E.kdoc as KDoc : c.docs.get(parent.file)) : undefined, it = pd ? pd.items.get(inst.uuidPath[k]) : undefined;
      chain.push(it && it.kind === "sheet" ? it.node as SNode : null);
    }
    const pg = parseInt(instancePage(c, inst), 10);
    out.push({ doc, path: "/" + inst.uuidPath.join("/"), page: pg > 0 ? pg : out.length + 1, shown: inst === here, project, file: inst.file, human: inst.human, readable: SN().sheetNodeText(inst, c.rootName, c.instances) + "/", sheets: chain });
  }
  return { sheets: out, mode: a.reused_sheet_suffixes === true, increment: a.increment_pasted_suffix !== false };
}
(E as unknown as { hooks: Record<string, unknown> }).hooks.suffixSheets = suffixSheets;
/** The suffix tools of sch-tools (tools/sch-tools/annotate.ts) the Reference editors use. */
export interface SuffixRefTools {
  suffixCtx(raw: unknown): { mode: boolean; rs: { has: boolean; suffix(path: string): string; packageSuffix(uuid: string, path: string): string } } | null;
  suffixSheetOf(sc: unknown, doc: KDoc): { path: string | null } | null;
  baseRefOn(sc: unknown, sheet: unknown, node: SNode): string;
  baseRefFromUser(sc: unknown, sheet: unknown, node: SNode, text: string): { base: string; error: string };
  setUserRef(sc: unknown, sheet: unknown, node: SNode, base: string): void;
  composedRefLabel(sc: unknown, sheet: unknown, node: SNode, text: string): string | null;
}
/**
 * The Reference editors' view of the suffixes (SCH_SYMBOL::GetBaseRef / BaseRefFromUser / SetUserRef on the current
 * sheet): null while the hierarchy is not read, or when the sheet on screen is not in it.
 */
export function suffixRefEditing(doc: KDoc | null = E.kdoc as KDoc | null, file?: string): { S: SuffixRefTools; sc: { mode: boolean; rs: { has: boolean; suffix(path: string): string; packageSuffix(uuid: string, path: string): string } }; sheet: { path: string | null } } | null {
  const S = (window as unknown as { CollabTools?: { sch?: unknown } }).CollabTools?.sch as SuffixRefTools | undefined;
  if (!doc || !S || !S.suffixCtx) return null;
  const raw = suffixSheets(), sc = S.suffixCtx(raw); if (!sc || !raw) return null;
  // a sheet read on its own (Replace All on the other sheets): its file's first instance
  const sheet = S.suffixSheetOf(sc, doc) || (file ? (raw.sheets.find((x) => x.file === file) || null) : null);
  return sheet ? { S, sc, sheet } : null;
}
/** The labels that show a net's name or class are drawn again when the nets may have changed. */
function refreshNetTexts(ctx?: ToolCtx): void {
  const KC = KiCadCanvas as unknown as LabelVarCanvas, doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "sch" || !KC.refreshLabelTextVars) return;
  try { if (KC.refreshLabelTextVars(doc)) (ctx || (toolCtx as unknown as () => ToolCtx)()).requestRender(); } catch (e) { console.warn(e); }
}

/** Open the sheet instance `inst` (a file shown under that hierarchy path) and centre on `at` once it is up. */
export async function goTo(instIndex: number, at: [number, number] | null): Promise<void> {
  const c = netMap(); if (!c) return;
  const inst = c.instances[instIndex]; if (!inst) return;
  const cur = currentInstance(c);
  if (!cur || cur.index !== inst.index) {
    const entry = schDocs().find((d) => d.path === inst.file);
    if (!entry) return;
    preferHuman = inst.human;
    if (!curEntry() || curEntry()!.docId !== entry.docId) { await openDoc(entry); await new Promise((r) => setTimeout(r, 40)); }   // after the opening fit
    else { docGen++; syncInstancePath(); applyHighlight(); }
  }
  // EDA_DRAW_FRAME::FocusOnLocation: the view moves only when the point is off screen or within 10 % of its edge
  if (at) focusOnLocation(at[0], at[1]);
}
export function preferInstance(human: string | null): void { preferHuman = human; }

/**
 * SCH_NAVIGATE_TOOL::LeaveSheet (Navigate > Leave Sheet, Backspace): the parent of the sheet instance on screen.  A
 * top-level sheet has none (with several top-level sheets, each is one); "the root sheet" names it in the message.
 */
export function leaveSheet(): void {
  const cur = curEntry();
  const c = netMap(), inst = currentInstance(c);
  if (c && inst) {
    if (inst.uuidPath.length <= 1) return;   // CanGoUp false: KiCad only rings the bell
    const up = inst.uuidPath.slice(0, -1).join("/");
    const parent = c.instances.find((i) => i.uuidPath.join("/") === up);
    const d = parent ? schDocs().find((x) => x.path === parent.file) : null;
    if (parent && d) { preferInstance(parent.human); if (!cur || d.docId !== cur.docId) void openDoc(d as never); else applyHighlight(); return; }
  }
  // the hierarchy is not read yet: the root sheet, unless this is a top-level sheet already
  const tops = topLevelSchematics();
  if (cur && tops.some((t) => t.doc.docId === cur.docId)) return;
  const r = rootSchematic(); if (r) void openDoc(r);
}

/**
 * SCH_DRAWING_TOOLS::findWireLabelDriverName: the name of the wire's net when its driver on this sheet is a local or
 * global label (CONNECTION_SUBGRAPH priority: global label, then power pin, then local label), else "".
 */
export function wireDriverName(wireId: string): string {
  const c = netMap(), inst = currentInstance(c); if (!c || !inst) return "";
  const name = c.index.get(inst.index + "|" + wireId); const e = name ? c.map.get(name) : null; if (!e || e.bus) return "";
  const here = e.members.filter((m) => m.inst === inst.index);
  const g = here.find((m) => m.kind === "global_label"); if (g) return g.text || "";
  if (here.some((m) => m.kind === "pin" && m.power)) return "";
  const l = here.find((m) => m.kind === "label"); return l ? l.text || "" : "";
}
/** The schematic's default text size (Schematic Setup > Formatting, mils) and the intersheet-refs visibility. */
export function labelDefaults(): { textSize: number; intersheetRefsShow: boolean } {
  let d: Record<string, unknown> = {};
  try { const j = E.proSettings ? JSON.parse(E.proSettings as string) : null; d = (j && j.schematic && j.schematic.drawing) || {}; } catch (e) { d = {}; }
  const mils = Number(d.default_text_size);
  return { textSize: Number.isFinite(mils) && mils > 0 ? Math.round(mils * 0.0254 * 10000) / 10000 : 1.27, intersheetRefsShow: !!d.intersheets_ref_show };
}

/** SCHEMATIC::GetAllBusAliases: the project's bus aliases (Schematic Setup > Bus Alias Definitions), name -> members. */
export function busAliases(): Record<string, string[]> | null {
  try { const j = E.proSettings ? JSON.parse(E.proSettings as string) as { schematic?: { bus_aliases?: Record<string, string[]> } } : null; const ba = j && j.schematic && j.schematic.bus_aliases; return ba && typeof ba === "object" ? ba : null; } catch (e) { return null; }
}
/** The Net Navigator's stepper (panels/netnav.ts registers it; the navigator imports this module, not the reverse). */
let navStepper: ((dir: number) => Promise<string | null>) | null = null;
export function setNavStepper(fn: (dir: number) => Promise<string | null>): void { navStepper = fn; }
/**
 * SCH_SELECTION_TOOL::SelectNext / SelectPrevious: the next / previous item of the Net Navigator's tree becomes the
 * selection.  (The caller has checked that the first selected item is net-highlighted.)
 */
function stepNetItem(ctx: ToolCtx, dir: number): boolean {
  if (!navStepper || !HL.name) return false;
  void navStepper(dir).then((id) => { if (id) (toolCtx as unknown as () => { setSelection(ids: string[]): void })().setSelection([id]); });
  void ctx;
  return true;
}
// ---------------------------------------------------------------- net classes on the canvas
/** NETCLASS's schematic values: GetSchematicColor (null when unspecified), GetWireWidth / GetBusWidth (mm), GetLineStyle. */
interface SchClass { name: string; color: string | null; wireWidth: number; busWidth: number; dashType: string | null }
const LINE_STYLES: (string | null)[] = [null, "dash", "dot", "dash_dot", "dash_dot_dot"];   // LINE_STYLE: SOLID, DASH, DOT, DASHDOT, DASHDOTDOT
interface SizesLike { classes: { name: string; priority: number }[]; assignments: Record<string, string[]>; patterns: { pattern: string; netclass: string }[] }
let classCache: { src: unknown; sizes: SizesLike | null; raw: Map<string, Record<string, unknown>>; byNet: Map<string, SchClass>; styled: boolean; labels?: Map<string, Set<string>> | null } | null = null;
/**
 * NET_SETTINGS::GetEffectiveNetClass for the schematic's values: the classes assigned to the net and those whose
 * pattern matches it, by priority, each value taken from the highest-priority class that sets it, Default's otherwise.
 */
export function schClassOf(net: string): SchClass {
  if (!classCache || classCache.src !== E.proSettings) {
    const PS = (KiCadCanvas as unknown as { pcbSizes?: { boardSizes(src: unknown): SizesLike } }).pcbSizes;
    const raw = new Map<string, Record<string, unknown>>(); let sizes: SizesLike | null = null;
    try {
      const j = E.proSettings ? JSON.parse(E.proSettings as string) : null, cl = j && j.net_settings && j.net_settings.classes;
      if (Array.isArray(cl)) for (const c of cl) if (c && typeof c.name === "string") raw.set(c.name, c);
      sizes = PS ? PS.boardSizes(E.proSettings || null) : null;
    } catch (e) { sizes = null; }
    // does any class draw differently from the defaults (a colour, a wire / bus width, a line style)?  Without one the canvas needs no net map
    let styled = false;
    for (const c of raw.values()) if ((typeof c.schematic_color === "string" && !/,\s*0(\.0*)?\s*\)$/.test(c.schematic_color)) || (typeof c.wire_width === "number" && c.wire_width !== 6) || (typeof c.bus_width === "number" && c.bus_width !== 12) || (typeof c.line_style === "number" && c.line_style > 0)) styled = true;
    classCache = { src: E.proSettings, sizes, raw, byNet: new Map(), styled };
  }
  // CONNECTION_GRAPH rebuilds the label assignments from the schematic (unconditionally on a full recalculation), so
  // the net map's take the place of the project file's netclass_assignments once the hierarchy is read
  const nm = netMap(), labels = nm && nm.netclassLabels ? nm.netclassLabels : null;
  if (classCache.labels !== labels) { classCache.labels = labels; classCache.byNet = new Map(); }
  const cc = classCache, hit = cc.byNet.get(net); if (hit) return hit;
  const out: SchClass = { name: "Default", color: null, wireWidth: 6 * 0.0254, busWidth: 12 * 0.0254, dashType: null };
  const take = (c: Record<string, unknown> | undefined): void => {
    if (!c) return;
    if (typeof c.schematic_color === "string") { const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(c.schematic_color); if (m && (m[4] === undefined || +m[4] > 0)) out.color = m[4] === undefined || +m[4] >= 1 ? `rgb(${+m[1]},${+m[2]},${+m[3]})` : `rgba(${+m[1]},${+m[2]},${+m[3]},${+m[4]})`; }
    if (typeof c.wire_width === "number" && c.wire_width > 0) out.wireWidth = c.wire_width * 0.0254;
    if (typeof c.bus_width === "number" && c.bus_width > 0) out.busWidth = c.bus_width * 0.0254;
    if (typeof c.line_style === "number" && c.line_style >= 0) out.dashType = LINE_STYLES[c.line_style] || null;
  };
  take(cc.raw.get("Default"));
  if (net && cc.sizes) {
    const PS = (KiCadCanvas as unknown as { pcbSizes: { netclassPatternMatches(p: string, n: string): boolean } }).pcbSizes;
    const names = new Set<string>(cc.labels ? cc.labels.get(net) || [] : cc.sizes.assignments[net] || []);
    for (const p of cc.sizes.patterns) if (PS.netclassPatternMatches(p.pattern, net)) names.add(p.netclass);
    const res = Array.from(names, (n) => cc.sizes!.classes.find((c) => c.name === n)).filter((c): c is { name: string; priority: number } => !!c);
    res.sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (let i = res.length - 1; i >= 0; i--) take(cc.raw.get(res[i].name));
    if (res.length) out.name = res[0].name;
  }
  cc.byNet.set(net, out);
  return out;
}
const NET_STYLED = new Set(["wire", "bus", "bus_entry", "junction", "label", "global_label", "hierarchical_label", "directive_label", "netclass_flag"]);
let styleCache: { c: Computed; src: unknown; doc: KDoc; inst: number; map: Map<string, { color?: string | null; wireWidth?: number; busWidth?: number; dashType?: string | null }> | null } | null = null;
/**
 * The render option schNetStyle: for every connected wire, bus, bus entry, junction and label of the sheet on screen
 * whose effective net class draws differently from the defaults, that class's colour, widths and line style.
 */
export function schNetStyles(): Map<string, { color?: string | null; wireWidth?: number; busWidth?: number; dashType?: string | null }> | null {
  const doc = E.kdoc as KDoc | null; if (!doc || doc.type !== "sch") return null;
  schClassOf(""); if (!classCache || !classCache.styled) return null;
  const c = netMap(), inst = currentInstance(c); if (!c || !inst) return null;
  if (styleCache && styleCache.c === c && styleCache.src === E.proSettings && styleCache.doc === doc && styleCache.inst === inst.index) return styleCache.map;
  const map = new Map<string, { color?: string | null; wireWidth?: number; busWidth?: number; dashType?: string | null }>();
  for (const it of doc.items.values()) {
    if (!NET_STYLED.has(it.kind)) continue;
    const name = c.index.get(inst.index + "|" + it.id); if (!name) continue;
    const k = schClassOf(name);
    if (k.color || k.dashType || Math.abs(k.wireWidth - 0.1524) > 1e-9 || Math.abs(k.busWidth - 0.3048) > 1e-9) map.set(it.id, { color: k.color, wireWidth: k.wireWidth, busWidth: k.busWidth, dashType: k.dashType });
  }
  styleCache = { c, src: E.proSettings, doc, inst: inst.index, map: map.size ? map : null };
  return styleCache.map;
}
/** Hook the module into the schematic tools (called once from editor/index.ts). */
/**
 * SCH_SHEET_PATH::GetPageNumber of a sheet instance: the page its sheet symbol records for the parent's path (the
 * root's is its file's own page).  "" when it cannot be told.
 */
export function instancePage(c: Computed, inst: SheetInstance): string {
  const K = KiCadCanvas, d = c.docs.get(inst.file);
  if (inst.uuidPath.length <= 1) return String((d as KDoc & { pageNumber?: string } | undefined)?.pageNumber || "");
  const parentPath = "/" + inst.uuidPath.slice(0, -1).join("/"), parent = c.instances.find((i) => "/" + i.uuidPath.join("/") === parentPath);
  const pd = parent ? c.docs.get(parent.file) : null, sheet = pd ? pd.items.get(inst.uuidPath[inst.uuidPath.length - 1]) : null;
  if (!sheet) return "";
  for (const ins of K.kids(sheet.node, "instances")) for (const pr of K.kids(ins, "project")) for (const pa of K.kids(pr, "path")) {
    if (K.str(pa[1]) === parentPath) { const pg = K.kid(pa, "page"); return pg ? K.str(pg[1]) : ""; }
  }
  return "";
}
/** The page numbers of every sheet instance of the hierarchy (SCH_SHEET_LIST::GetNextPageNumber reads them); null when it is not known. */
function hierarchyPages(): string[] | null {
  const c = netMap(); if (!c || !c.instances.length) return null;
  return c.instances.map((i) => instancePage(c, i));
}
export function installSchNets(): void {
  const KC = KiCadCanvas as unknown as LabelVarCanvas; if (KC.setLabelTextVar) KC.setLabelTextVar(labelTextVar);
  const SV = (KiCadCanvas as unknown as SymVarCanvas).symVars; if (SV) { SV.net = symbolNetVar; SV.unitPlaced = symbolUnitPlaced; SV.crossRef = symbolCrossRef; SV.refSuffix = symbolRefSuffix; }
  const PH = (KiCadCanvas as unknown as { pinMapHooks?: { unit1: ((ref: string) => { node: SNode; path: string | null } | null) | null } }).pinMapHooks; if (PH) PH.unit1 = unit1Symbol;
  const m = schMod(); if (!m || !m.setNetHighlighter) return;
  (m.state as { hierarchyPages?: (() => string[] | null) | null }).hierarchyPages = hierarchyPages;
  m.setNetHighlighter({ highlightPick: userHighlightPick, clear: (ctx: ToolCtx) => { clearHighlight(ctx); netProbe.send?.([]); }, active: () => !!HL.name || !!HL.chain, docChanged, wireDriverName, labelDefaults, busAliases, stepNetItem });
}
/** SCH_SYMBOL::resolveDelegatedPinMapOverride's walk over Schematic()->Hierarchy(): the first unit-1 symbol whose
 *  reference on its sheet instance is `ref` (lower case), with that instance's path. */
function unit1Symbol(ref: string): { node: SNode; path: string | null } | null {
  const c = netMap(); if (!c) return null;
  for (const inst of c.instances) {
    const doc = c.docs.get(inst.file); if (!doc) continue;
    const path = "/" + inst.uuidPath.join("/");
    for (const it of doc.items.values()) {
      if (it.kind !== "symbol") continue;
      const at = KiCadCanvas.symbolInstance(it.node, path) as { ref: string; unit: number | null } | null;
      const unitK = KiCadCanvas.kid(it.node, "unit") as SNode | null;
      const unit = at && at.unit !== null ? at.unit : unitK ? Number(unitK[1]) || 1 : 1;
      const r = at ? at.ref : String(it.ref || "");
      if (unit === 1 && r.toLowerCase() === ref) return { node: it.node, path };
    }
  }
  return null;
}
/** editor/crossprobe.ts: where the user's net highlight goes (SendCrossProbeNetName / SetCrossProbeConnection). */
export const netProbe = { send: null as ((names: string[]) => void) | null };
/**
 * highlightNet() as the user runs it: a new net is cross-probed with SignalNames (the net, or a bus's net members,
 * sorted); nothing under the cursor sends a clear; the same net again (the bus-members toggle) sends nothing.
 */
function userHighlightPick(ctx: ToolCtx, pick: Pick | null): void {
  const before = HL.name;
  highlightPick(ctx, pick);
  if (!HL.name && HL.chain) return;   // the same net again, escalated to its chain: no cross-probe
  if (!HL.name) { netProbe.send?.([]); return; }
  if (HL.name === before) return;
  const c = netMap(), e = c ? c.map.get(HL.name) : undefined; if (!e) { netProbe.send?.([]); return; }
  const names = new Set<string>(); if (!e.bus) names.add(HL.name); else for (const m of e.busMembers) names.add(m);
  netProbe.send?.([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** DIALOG_ASSIGN_NETCLASS's previewer: the items of these nets on the sheet on screen brightened (the highlight stays its own). */
export function previewNets(names: string[], ctx: ToolCtx = (toolCtx as unknown as () => ToolCtx)()): void {
  const h = helpers(); if (!h) return;
  const c = netMap(), inst = currentInstance(c), keys = new Set<string>();
  if (c && inst) for (const n of names) for (const k of SN().collectKeys(c.map, n, inst.index, false)) keys.add(k);
  h.setHighlight(ctx, keys.size ? keys : null);
}
/** The net entries of items on the sheet on screen, by id (SCH_CONNECTION of each), in the order given. */
export function netsOfItems(ids: string[]): (NetEntry | null)[] {
  const c = netMap(), inst = currentInstance(c); if (!c || !inst) return ids.map(() => null);
  return ids.map((id) => { const n = c.index.get(inst.index + "|" + id); return n ? c.map.get(n) || null : null; });
}
/**
 * SCH_ITEM::Connection( sheet )->Name() for Find's "Search net names": the net of an item on the sheet on screen (a
 * symbol pin by its number, a sheet pin by its name); a bus answers its own name and its members' nets.
 */
export function netNamesOf(id: string, pin?: string): string[] {
  const c = netMap(), inst = currentInstance(c); if (!c || !inst) return [];
  const n = c.index.get(inst.index + "|" + id + (pin !== undefined ? "#pin:" + pin : "")); if (!n) return [];
  const e = c.map.get(n);
  return e && e.bus ? [n].concat(e.busMembers || []) : [n];
}
/** Every net name of the schematic (GetNetClassAssignmentCandidates). */
export function allNetNames(): string[] { const c = netMap(); return c ? SN().netNames(c.map, false) : []; }
/**
 * The hierarchy for the tools (ctx.sheetHierarchy): every sheet path as the files from the root down, and the
 * sheets read so far by file (SCH_SHEET_LIST for the paste's recursion test and its page numbers).
 */
export function sheetHierarchy(): { paths: string[][]; docs: Map<string, KDoc>; instances: { file: string; path: string }[] } | null {
  const c = netMap(); if (!c) return null;
  const byPath = new Map<string, string>(); for (const i of c.instances) byPath.set(i.uuidPath.join("/"), i.file);
  const paths = c.instances.map((i) => i.uuidPath.map((_u, n) => byPath.get(i.uuidPath.slice(0, n + 1).join("/")) || "").filter(Boolean));
  // every sheet path as its KIID path (SCH_SHEET_PATH::Path) and the file shown there: a symbol's instances are keyed by it
  return { paths, docs: c.docs, instances: c.instances.map((i) => ({ file: i.file, path: "/" + i.uuidPath.join("/") })) };
}
(E as unknown as { hooks: Record<string, unknown> }).hooks.sheetHierarchy = sheetHierarchy;
