// editor/netchains — the schematic editor's net chains (SCH_EDITOR_CONTROL's net chain actions, the selection tool's
// "Net Chain..." submenu, DIALOG_CREATE_NET_CHAIN, the highlighted chain's status text and painter state).
//
// The chains themselves are canvas/net-chains.ts's model, built from the hierarchy's net map (editor/schnets.ts) and
// the first top-level sheet's (net_chain …) entries.  A change to a chain is a change to that sheet's entries: an
// entry added, replaced or removed there, the open sheet's undo list taking it when it is the one on screen.
import type { netChains as NetChainsApi, ChainModel, ChainPin, NetChain } from "../canvas/net-chains";
import { state, setStatusBar } from "./appstore";
import { rootSchematic, topLevelSchematics } from "./doc";
import { HL, applyHighlight, chainHooks, currentInstance, loadSheets, nameOfPick, netMap, previewNets, goTo } from "./schnets";
import { projectDocs } from "./projectfile";
import { E } from "./state";
import { toolCtx } from "./tools";
import { requestRender, fitBox, pxPerMm, stage, zoomBy } from "./view";
import { selectionItems, selectionChanged } from "./gestures";
import { errorMessage, h, messageBox, openDialog, textEntryBox, type DialogApi } from "./pcbdialogs/ui";
import { submitDocOp, saveProject, type JsonObj } from "../dialogs/project";
import { setPassthrough } from "../dialogs/sym-props-logic";
import { sendOp } from "./net";
import { applyChanges } from "./doc";

const NC = (): typeof NetChainsApi => (KiCadCanvas as unknown as { netChains: typeof NetChainsApi }).netChains;
interface SchHelpers { symbolPins(doc: KDoc, item: KItem): { x: number; y: number; number: string; name: string; type: string; hidden: boolean }[]; pickNet?(ctx: unknown, mm: number[]): { item: KItem; at?: [number, number]; pin?: string } | null; crossProbeZoomRatio?(w: number, h: number, vw: number, vh: number): number | null }
const helpers = (): SchHelpers | null => { const m = CollabTools.sch; return m && m._ ? m._ as unknown as SchHelpers : null; };
interface PinRef { id: string; number: string }
type Ctx = ToolCtx;
const ctx = (): Ctx => (toolCtx as unknown as () => Ctx)();

// ---------------------------------------------------------------- the model
interface DocLike { docId: string; path: string }
/** SCHEMATIC::GetTopLevelSheet( 0 ): the sheet whose file holds the net chains. */
export function chainSheet(): DocLike | null {
  const tops = topLevelSchematics(); if (tops.length) return tops[0].doc as unknown as DocLike;
  try { return (rootSchematic() as unknown as DocLike) || null; } catch (e) { return null; }
}
let cache: { key: string; m: ChainModel } | null = null;
/** The schematic's chains as they stand (NETCHAIN_MANAGER after a rebuild); null outside a schematic. */
export function chainModel(): ChainModel | null {
  const c = netMap(), h0 = helpers(); if (!c || !h0) return null;
  const root = chainSheet(), rootDoc = root ? c.docs.get(root.path) || null : null;
  const saved = NC().savedChains(rootDoc);
  const key = c.key + "|" + JSON.stringify(saved);
  if (cache && cache.key === key) return cache.m;
  const pro = projectDocs().find((d) => d.docType === "kicad_pro");
  const project = pro ? pro.path.split("/").pop()!.replace(/\.kicad_pro$/, "") : (c.rootName || undefined);
  let m: ChainModel;
  try { m = NC().buildChains({ map: c.map, instances: c.instances, docs: c.docs, symbolPins: h0.symbolPins, project, saved }); } catch (e) { console.warn(e); return null; }
  cache = { key, m };
  return m;
}
const proJson = (): JsonObj => { try { return E.proSettings ? JSON.parse(E.proSettings as string) as JsonObj : {}; } catch (e) { return {}; } };
/** NET_SETTINGS::GetNetChainClass. */
export function chainClassOf(name: string): string {
  const ns = proJson().net_settings as JsonObj | undefined, m = ns && ns.net_chain_classes as Record<string, unknown> | undefined;
  return m && typeof m[name] === "string" ? String(m[name]) : "";
}
/** GetNetChainForNet( net ): the chain's name, "" when the net is on none (SCH_LINE's "Net Chain" message panel row). */
export function chainNameForNet(net: string): string { const m = chainModel(); const c = m ? NC().chainForNet(m, net) : null; return c ? c.name : ""; }

// ---------------------------------------------------------------- writing the chains
const typeName = "SCH_NETCHAIN";
/** Commit entry changes to the sheet holding the chains: through the open sheet's undo list, or as an op on it. */
async function commitChains(changes: KChange[], label: string): Promise<boolean> {
  if (!changes.length) return true;
  const root = chainSheet(); if (!root) return false;
  if (E.viewOnly) return false;
  if ((state.docId as string | null) === root.docId) { ctx().commit(changes, label); cache = null; return true; }
  try { await submitDocOp(root.docId, changes); } catch (e) { errorMessage(String((e as Error).message || e)); return false; }
  cache = null; await loadSheets(true); return true;
}
const added = (text: string, name: string): KChange => ({ id: "net_chain:" + name, kind: "ADDED", typeName, sexpr: text });
const removed = (name: string): KChange => ({ id: "net_chain:" + name, kind: "REMOVED", typeName, properties: [] });
const modified = (text: string, name: string): KChange => ({ id: "net_chain:" + name, kind: "MODIFIED", typeName, sexpr: text });
/** The entry written for a chain: in place of the one of its name, else a new one. */
function putEntry(m: ChainModel, name: string, text: string): KChange { return m.saved.some((s) => s.name === name) ? modified(text, name) : added(text, name); }
/** NET_SETTINGS::SetNetChainClass( old, "" ) / ( new, class ) as RenameCommittedNetChain / DeleteCommittedNetChain do. */
async function moveChainClass(oldName: string, newName: string | null): Promise<void> {
  const cls = chainClassOf(oldName); if (!cls) return;
  try {
    await saveProject((pro) => {
      const ns = (pro.net_settings || (pro.net_settings = {})) as JsonObj;
      const m = (ns.net_chain_classes && typeof ns.net_chain_classes === "object" ? ns.net_chain_classes : (ns.net_chain_classes = {})) as JsonObj;
      delete m[oldName]; if (newName) m[newName] = cls;
    }, "net chain class");
  } catch (e) { console.warn(e); }
}

// ---------------------------------------------------------------- the highlight
/** SetHighlightedNetChain + UpdateNetHighlighting + UpdateNetHighlightStatus. */
export function highlightChain(name: string | null, connection: string | null = null): void {
  HL.chain = name || null; HL.name = connection || null; HL.busMembers = false; if (!connection) HL.nav = null;
  applyHighlight();
}
/** UpdateNetHighlightStatus: "Net chain members: …" for a highlighted chain, else the net's line. */
function chainStatus(name: string): string | null {
  const m = chainModel(), c = m ? NC().chainByName(m, name) : null;
  return c ? "Net chain members: " + c.nets.join(", ") : null;
}
/** The painter's view of the highlighted chain on the sheet on screen (SCH_PAINTER's wire tint and terminal circles). */
export function schNetChainPaint(): { wires: Map<string, string>; terminals: { key: string; x: number; y: number; color: string | null }[] } | null {
  if (!HL.chain) return null;
  const m = chainModel(), c = m ? NC().chainByName(m, HL.chain) : null; if (!m || !c) return null;
  const nm = netMap(), inst = currentInstance(nm), doc = E.kdoc as KDoc | null; if (!nm || !inst || !doc) return null;
  const wires = new Map<string, string>();
  const color = NC().colorCss(c.color);
  if (color) for (const it of doc.items.values()) {
    if (it.kind !== "wire") continue;
    const net = nm.index.get(inst.index + "|" + it.id); if (!net) continue;
    const owner = NC().chainForNet(m, net);
    if (owner && owner.name === c.name) wires.set(it.id, color);
  }
  const terminals: { key: string; x: number; y: number; color: string | null }[] = [];
  for (const t of [c.termA, c.termB]) if (t && t.inst === inst.index && doc.items.has(t.id)) terminals.push({ key: t.id + "#pin:" + t.pin, x: t.x, y: t.y, color });
  return { wires, terminals };
}

// ---------------------------------------------------------------- the selection
/** The current sheet instance's pin as a chain pin. */
function pinOf(m: ChainModel, p: PinRef): ChainPin | null { const inst = currentInstance(); return inst ? NC().chainPinOf(m, inst.index, p.id, p.number) : null; }
const selPins = (): PinRef[] => ((E.selPins || []) as PinRef[]).slice();
/** GetConnectionName( currentSheet ) of a selected pin. */
function pinNet(m: ChainModel, p: PinRef): string { const inst = currentInstance(); return inst ? NC().pinNetOf(m, inst.index, p.id, p.number) : ""; }
/** The net of a selected item: a pin's, a wire's or a label's; a symbol has none. */
function itemNet(it: KItem | null, pin?: string): string {
  if (!it) return "";
  if (it.kind === "symbol" && pin === undefined) return "";
  const r = nameOfPick({ item: it, pin }); return r && r.name ? r.name : "";
}

// ---------------------------------------------------------------- the actions
/** SCH_EDITOR_CONTROL::HighlightNetChain: the item under the cursor; its chain, else its net as a connection. */
export function highlightNetChainAt(mm: number[] | null): void {
  const h0 = helpers(), m = chainModel(); if (!h0 || !m || !E.kdoc) return;
  const pick = mm && h0.pickNet ? h0.pickNet(ctx(), mm) : null;
  const r = pick ? nameOfPick(pick) : null, name = r && r.name ? r.name : "";
  let chain: string | null = null, conn: string | null = null;
  if (name) { const c = NC().chainForNet(m, name); if (c) chain = c.name; else conn = name; }
  highlightChain(chain, conn);
}
/** SCH_EDITOR_CONTROL::RemoveFromNetChain: every bridge joining the net to the rest of its chain gets passthrough "block". */
export async function removeFromNetChain(): Promise<void> {
  const m = chainModel(), nm = netMap(), h0 = helpers(); if (!m || !nm || !E.kdoc) return;
  let net = "";
  const items = selectionItems(), pins = selPins();
  if (items.length + pins.length === 1) net = pins.length ? pinNet(m, pins[0]) : itemNet(items[0]);
  else {
    const mm = E.lastCursorMm as number[] | null, pick = mm && h0 && h0.pickNet ? h0.pickNet(ctx(), mm) : null;
    if (!pick) return;
    net = (nameOfPick(pick) || { name: "" }).name || "";
  }
  const chain = net ? NC().chainForNet(m, net) : null; if (!chain || E.viewOnly) return;
  const bridges = NC().bridgeSymbols(m, chain, net);
  const cur = state.docId as string | null, curPath = (state as { doc?: { path?: string } }).doc?.path || "";
  const byFile = new Map<string, KChange[]>();
  for (const b of bridges) {
    const doc = b.file === curPath ? E.kdoc as KDoc : nm.docs.get(b.file); const it = doc && doc.items.get(b.id); if (!doc || !it) continue;
    const node = KiCadCanvas.cloneNode(it.node) as SNode; setPassthrough(node, "block");
    const l = byFile.get(b.file) || []; l.push(KiCadCanvas.replaceChange(doc, { ...it, node })); byFile.set(b.file, l);
  }
  let others = false;
  for (const [file, ch] of byFile) {
    if (file === curPath) { ctx().commit(ch, "Remove from Net Chain"); continue; }
    const d = projectDocs().find((x) => x.path === file && x.docType === "kicad_sch"); if (!d || d.docId === cur) continue;
    try { await submitDocOp(d.docId, ch); others = true; } catch (e) { errorMessage(String((e as Error).message || e)); }
  }
  cache = null; if (others) await loadSheets(true);
  requestRender();
}
/** SCH_EDITOR_CONTROL::ReplaceTerminalPin: the selected pin becomes terminal `endpoint` (0 A, 1 B) of its chain. */
export async function replaceTerminalPin(endpoint: number): Promise<void> {
  const m = chainModel(), pins = selPins(); if (!m || !pins.length) return;
  const pin = pinOf(m, pins[0]), chain = NC().chainForNet(m, pinNet(m, pins[0]));
  const refs = chain && pin ? NC().replaceTerminal(m, chain, endpoint, pin) : null;
  const text = chain && refs ? NC().committedNodeText(chain, { termA: refs[0], termB: refs[1] }) : null;
  if (!chain || !text) { errorMessage("Unable to replace the net chain terminal pin."); return; }
  await commitChains([putEntry(m, chain.name, text)], "Replace Terminal Pin");
  applyHighlight(); requestRender();
}
/** SCH_EDITOR_CONTROL::NameNetChain: rename the selected pin's chain. */
export function nameNetChain(): void {
  const m = chainModel(), pins = selPins(); if (!m || !pins.length) return;
  const net = pinNet(m, pins[0]); if (!net) return;
  const chain = NC().chainForNet(m, net); if (!chain) return;
  const oldName = chain.name;
  textEntryBox("Name Net Chain", "Net chain name:", oldName, false, (newName) => { void (async () => {
    if (!newName || newName === oldName) return;
    if (!NC().isValidName(newName)) { errorMessage("Chain name cannot contain spaces, quotes, or parentheses."); return; }
    const text = NC().committedNodeText(chain, { name: newName });
    if (NC().chainByName(m, newName) || !text || E.viewOnly) { errorMessage(`Unable to rename net chain '${oldName}' to '${newName}'.`); return; }
    const ch: KChange[] = [];
    if (m.saved.some((s) => s.name === oldName)) ch.push(removed(oldName));
    ch.push(putEntry({ ...m, saved: m.saved.filter((s) => s.name !== oldName) }, newName, text));
    if (!(await commitChains(ch, "Name Net Chain"))) return;
    await moveChainClass(oldName, newName);
    highlightChain(newName);
  })(); });
}
/** The box around the pins (SCH_PIN::GetBoundingBox), mm. */
function pinBox(items: { id: string; pin: string }[]): number[] | null {
  const doc = E.kdoc as KDoc | null; if (!doc) return null;
  let b: number[] | null = null;
  const gb = KiCadCanvas.geomBox as unknown as (g: unknown) => number[] | null;
  for (const p of items) {
    const it = doc.items.get(p.id); if (!it) continue;
    for (const g of it.geom as unknown as { pinNo?: string }[]) {
      if (g.pinNo !== p.pin) continue;
      const q = gb(g); if (q) b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : q.slice();
    }
  }
  return b;
}
/** SCH_EDITOR_CONTROL::CreateNetChainBetweenPins: commit the potential chain the two selected pins share. */
export function createNetChainBetweenPins(): void {
  const m = chainModel(), pins = selPins(); if (!m || pins.length !== 2) return;
  const pa = pinOf(m, pins[0]), pb = pinOf(m, pins[1]); if (!pa || !pb) return;
  const potential = NC().potentialBetween(m, pinNet(m, pins[0]), pinNet(m, pins[1]));
  if (!potential) { errorMessage("No potential net chain connects the selected pins."); return; }
  for (const net of potential.nets) { const owner = NC().chainForNet(m, net); if (owner) { errorMessage(`The selected pins are already in net chain '${owner.name}'.`); return; } }
  const suggestion = `${pa.ref}_${pb.ref}`;
  const msg = `Create Net Chain between ${pa.ref}:${pa.pin} and ${pb.ref}:${pb.pin}`;
  // the temporary highlight: the potential's name (GetNetChainByName finds no committed chain by it)
  const prevChain = HL.chain, prevConn = HL.name;
  highlightChain(potential.name, null);
  // zoom to the two pins' box, grown by a quarter of its size (at least 100 IU) for context
  const b = pinBox([{ id: pins[0].id, pin: pins[0].number }, { id: pins[1].id, pin: pins[1].number }]);
  if (b) {
    const dx = Math.max((b[2] - b[0]) / 4, 0.01), dy = Math.max((b[3] - b[1]) / 4, 0.01);
    fitBox([b[0] - dx, b[1] - dy, b[2] - b[0] + 2 * dx, b[3] - b[1] + 2 * dy]);
  }
  const restore = (): void => { highlightChain(prevChain, prevConn); };
  let answered = false;
  const ov = textEntryBox("Create Net Chain", msg, suggestion, false, (name) => { answered = true; void (async () => {
    if (!name) { restore(); return; }
    if (!NC().isValidName(name)) { restore(); errorMessage("Chain name cannot contain spaces, quotes, or parentheses."); return; }
    if (NC().chainByName(m, name)) { restore(); errorMessage(`A net chain named '${name}' already exists.`); return; }
    const text = NC().potentialNodeText(potential, name);
    if (!text || E.viewOnly || !(await commitChains([putEntry(m, name, text)], "Create Net Chain"))) { restore(); errorMessage(`Unable to create net chain '${name}'.`); return; }
    highlightChain(name);
  })(); });
  // wxGetTextFromUser returns "" on Cancel: the highlight goes back
  if (ov) new MutationObserver((_r, obs) => { if (!ov.isConnected) { obs.disconnect(); if (!answered) restore(); } }).observe(document.body, { childList: true });
}

// ---------------------------------------------------------------- the context submenu (NET_CHAIN_MENU::update)
export interface ChainRow { label: string; act?: string; run?: () => void; disabled?: boolean; sub?: ChainRow[] }
/** The rows of the selection tool's "Net Chain..." submenu for the selection. */
export function netChainMenuRows(): ChainRow[] {
  const m = chainModel(); if (!m) return [{ label: "(No net chain actions)", disabled: true }];
  const items = selectionItems(), pins = selPins();
  const out: ChainRow[] = [];
  if (!pins.length && items.length && items.every((it) => it.kind === "symbol")) return [{ label: "", act: "SCH_ACTIONS::createNetChain" }];
  const size = items.length + pins.length;
  const singlePin = size === 1 && pins.length === 1 && !!pinNet(m, pins[0]);
  let inSignal = false, canName = false, canRemove = false;
  for (const p of pins) {
    const net = pinNet(m, p); if (!net) continue;
    if (NC().chainForNet(m, net)) { inSignal = true; canRemove = true; if (size === 1) canName = true; }
  }
  if (inSignal) out.push({ label: "", act: "SCH_ACTIONS::highlightNetChain" });
  if (canRemove) out.push({ label: "", act: "SCH_ACTIONS::removeFromNetChain" });
  if (singlePin && inSignal) {
    // REPLACE_TERMINAL_PIN_MENU: Terminal A / B, both greyed when the pin already is a terminal of the chain
    const chain = NC().chainForNet(m, pinNet(m, pins[0]))!, pin = pinOf(m, pins[0]);
    const isEnd = NC().terminalIndex(chain, pin) >= 0;
    out.push({ label: "Replace terminal pin", sub: [
      { label: "Terminal A", disabled: isEnd || !!E.viewOnly, run: () => { void replaceTerminalPin(0); } },
      { label: "Terminal B", disabled: isEnd || !!E.viewOnly, run: () => { void replaceTerminalPin(1); } }] });
  }
  if (canName) out.push({ label: "", act: "SCH_ACTIONS::nameNetChain" });
  if (size === 2 && pins.length === 2) {
    const pa = pinOf(m, pins[0]), pb = pinOf(m, pins[1]);
    if (pa && pb && NC().potentialBetween(m, pinNet(m, pins[0]), pinNet(m, pins[1]))) out.push({ label: `Create Net Chain between ${pa.ref}:${pa.pin} and ${pb.ref}:${pb.pin}`, act: "SCH_ACTIONS::createNetChainBetweenPins" });
  }
  if (size === 1) {
    const connectedPin = pins.length === 1 && !!pinNet(m, pins[0]);
    const it = items[0], connectedLine = !!it && (it.kind === "wire" || it.kind === "bus") && !!itemNet(it);
    if (connectedPin || connectedLine) out.push({ label: "", act: "SCH_ACTIONS::createNetChain" });
  }
  if (!out.length) out.push({ label: "(No net chain actions)", disabled: true });
  return out;
}

// ---------------------------------------------------------------- DIALOG_CREATE_NET_CHAIN
interface PotentialRow {
  live: NetChain | null; memberNets: string[]; suggestedName: string; terminals: string;
  force?: { fromSym: { file: string; id: string }; toSym: { file: string; id: string }; fromRef: string; toRef: string; fromPin: string; toPin: string };
}
const ARROW = " → ";
/** The hierarchy's symbols with their composed references (SCH_REFERENCE_LIST, SYMBOL_FILTER_ALL). */
function composedRefs(m: ChainModel): { composed: string; inst: number; file: string; item: KItem; ref: string; pins: { number: string }[] }[] {
  const out: { composed: string; inst: number; file: string; item: KItem; ref: string; pins: { number: string }[] }[] = [];
  const NL = KiCadCanvas.pcbNetlist as unknown as { unitCount?(doc: KDoc, node: SNode): number };
  for (const sh of m.sheets) for (const s of sh.symbols) {
    const un = KiCadCanvas.kid(s.item.node, "unit"), unit = un ? Number(un[1]) || 1 : 1;
    const multi = NL.unitCount ? NL.unitCount(sh.doc, s.item.node) > 1 : false;
    out.push({ composed: s.ref + (multi ? (KiCadCanvas.unitLetter as unknown as (u: number) => string)(unit) : ""), inst: sh.inst.index, file: sh.inst.file, item: s.item, ref: s.ref, pins: s.pins });
  }
  return out;
}
/** Tools > Create Net Chain... (SCH_EDITOR_CONTROL::ShowCreateNetChain): the focus hint from the selection. */
export function showCreateNetChain(): void {
  const m = chainModel(); if (!m) return;
  const items = selectionItems(), pins = selPins();
  const hint = { fromRef: "", toRef: "", netName: "" };
  const inst = currentInstance();
  const symbols = items.filter((it) => it.kind === "symbol");
  const refOf = (it: KItem): string => { const sh = m.sheets.find((s) => inst && s.inst.index === inst.index); const s = sh && sh.symbols.find((x) => x.item.id === it.id); return s ? s.ref : ""; };
  if (symbols.length >= 1) hint.fromRef = refOf(symbols[0]);
  if (symbols.length >= 2) hint.toRef = refOf(symbols[1]);
  if (!symbols.length && items.length + pins.length === 1) {
    if (pins.length) hint.netName = pinNet(m, pins[0]);
    else if (items[0].kind === "wire" || items[0].kind === "bus") hint.netName = itemNet(items[0]);
  }
  openCreateNetChain(hint);
}
export function openCreateNetChain(hint: { fromRef: string; toRef: string; netName: string }): DialogApi | null {
  let m = chainModel(); if (!m) return null;
  let rows: PotentialRow[] = [], filtered: number[] = [], created = 0, sel = -1, lastSheet: number | null = null;
  const header = h("div", { style: "margin:2px 0 8px", "data-k": "header" }, " Select a detected net chain path and assign a name to create a net chain.");
  const filter = h("input", { type: "text", placeholder: "Filter chains by name or net...", style: "width:100%;margin-bottom:5px", "data-k": "filter" }) as HTMLInputElement;
  const table = h("table", { class: "pd-table" }), gridWrap = h("div", { class: "pd-grid", style: "height:220px;overflow:auto", "data-k": "chains" }, table);
  const membersLabel = h("div", { style: "margin:5px 0 0 5px", "data-k": "members-label" }, "Member Nets");
  // m_memberList: a read-only wxListBox of the chain's nets
  const members = h("div", { class: "pd-grid", role: "listbox", style: "width:100%;height:120px;overflow:auto", "data-k": "members" });
  const refs = (): string[] => Array.from(new Set(composedRefs(m!).map((r) => r.composed))).sort();
  const listId = "kd-nc-refs-" + Math.random().toString(36).slice(2, 8);
  const datalist = h("datalist", { id: listId });
  const fillRefs = (): void => { datalist.replaceChildren(...refs().map((r) => h("option", { value: r }))); };
  const from = h("input", { type: "text", list: listId, style: "flex:1", "data-k": "from" }) as HTMLInputElement;
  const to = h("input", { type: "text", list: listId, style: "flex:1", "data-k": "to" }) as HTMLInputElement;
  const findBtn = h("button", { class: "btn", type: "button", title: "Find net chain path between the two components", "data-k": "find-path" }, "Find Path");
  const nameInput = h("input", { type: "text", style: "flex:1", "data-k": "name" }) as HTMLInputElement;
  const refreshBtn = h("button", { class: "btn", type: "button", title: "Re-detect potential net chains from the schematic", "data-k": "refresh" }, "Refresh");
  const box = (msg: string, title = "Create Net Chain"): void => { messageBox(title, msg); };

  const committedNames = (): Set<string> => new Set(m!.committed.map((c) => c.name));
  const loadPotentials = (): void => {
    rows = [];
    const names = committedNames();
    for (const p of m!.potentials) {
      if (p.nets.some((n) => { const ex = NC().chainForNet(m!, n); return !!ex && names.has(ex.name); })) continue;
      let suggested = ""; for (const n of p.nets) if (n.length > suggested.length) suggested = n;
      let a = p.termA ? p.termA.ref : "", b = p.termB ? p.termB.ref : "";
      if (p.termA && p.termA.pin) a += ":" + p.termA.pin;
      if (p.termB && p.termB.pin) b += ":" + p.termB.pin;
      rows.push({ live: p, memberNets: p.nets.slice(), suggestedName: suggested, terminals: a || b ? a + ARROW + b : "" });
    }
  };
  const syncEdits = (): void => {
    filtered.forEach((di, gi) => { const inp = table.querySelector<HTMLInputElement>(`tbody tr:nth-child(${gi + 1}) input`); if (inp && inp.value && rows[di]) rows[di].suggestedName = inp.value; });
  };
  const rebuildGrid = (): void => {
    syncEdits();
    filtered = [];
    const f = filter.value.toLowerCase().trim();
    rows.forEach((r, i) => {
      if (!f || r.suggestedName.toLowerCase().includes(f) || (r.terminals && r.terminals.toLowerCase().includes(f)) || r.memberNets.some((n) => n.toLowerCase().includes(f))) filtered.push(i);
    });
    const body = h("tbody");
    filtered.forEach((di, gi) => {
      const r = rows[di];
      let preview = r.terminals ? "[" + r.terminals + "] " : "";
      for (const n of r.memberNets) { if (preview && !preview.endsWith(" ")) preview += ", "; preview += n; }
      const name = h("input", { type: "text", value: r.suggestedName, style: "width:100%;border:0;background:transparent;color:inherit" }) as HTMLInputElement;
      name.addEventListener("change", () => { if (gi === sel) nameInput.value = name.value; });
      const tr = h("tr", null, h("td", null, name), h("td", null, String(r.memberNets.length)), h("td", null, preview));
      tr.addEventListener("click", () => selectRow(gi));
      body.append(tr);
    });
    table.replaceChildren(h("thead", null, h("tr", null, h("th", { style: "width:30%" }, "Suggested Name"), h("th", { style: "width:10%" }, "Nets"), h("th", null, "Preview"))), body);
    sel = -1;
    members.replaceChildren(); membersLabel.textContent = "Member Nets";
  };
  const updateMemberDetail = (di: number): void => {
    members.replaceChildren();
    const r = rows[di]; if (!r) { membersLabel.textContent = "Member Nets"; return; }
    membersLabel.textContent = r.terminals ? `Member Nets — ${r.suggestedName} (${r.memberNets.length}) [${r.terminals}]` : `Member Nets — ${r.suggestedName} (${r.memberNets.length})`;
    for (const n of r.memberNets.slice().sort()) members.append(h("div", { role: "option", style: "padding:1px 4px" }, n));
  };
  /** findSheetForRow: the sheet of the chain's first terminal reference, else the first sheet with a member net. */
  const sheetForRow = (r: PotentialRow): number | null => {
    const target = r.live ? (r.live.termA && r.live.termA.ref) || (r.live.termB && r.live.termB.ref) || "" : r.force ? r.force.fromRef || r.force.toRef : "";
    if (target) { let hit: number | null = null; for (const s of composedRefs(m!)) if (s.composed === target) { hit = s.inst; break; } if (hit !== null) return hit; }
    const nm = netMap(); if (!nm) return null;
    for (const inst of nm.instances) for (const n of r.memberNets) { const e = nm.map.get(n); if (e && e.members.some((x) => x.inst === inst.index)) return inst.index; }
    return null;
  };
  /** navigateAndHighlightChain: show the row's sheet with its nets brightened, the view zoomed to them. */
  const navigate = async (r: PotentialRow): Promise<void> => {
    const target = sheetForRow(r), cur = currentInstance();
    if (target !== null && (!cur || cur.index !== target)) await goTo(target, null);
    previewNets(r.memberNets);
    const nm = netMap(), inst = currentInstance(nm), doc = E.kdoc as KDoc | null;
    if (nm && inst && doc) {
      let b: number[] | null = null;
      const keys = new Set<string>(); for (const n of r.memberNets) for (const k of (KiCadCanvas.schNets as unknown as { collectKeys(map: unknown, n: string, i: number, bus: boolean): Set<string> }).collectKeys(nm.map, n, inst.index, false)) keys.add(k);
      for (const k of keys) { const id = k.split("#")[0]; const it = doc.items.get(id); const q = it && it.bbox; if (q) b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : [q[0], q[1], q[2], q[3]]; }
      const h0 = helpers();
      if (b && (b[2] > b[0] || b[3] > b[1]) && h0 && h0.crossProbeZoomRatio) {
        const ppm = pxPerMm(), ratio = h0.crossProbeZoomRatio(b[2] - b[0], b[3] - b[1], stage.clientWidth / ppm, stage.clientHeight / ppm);
        if (ratio) zoomBy(1 / ratio);
      }
    }
    lastSheet = currentInstance() ? currentInstance()!.index : null;
    requestRender();
  };
  const selectRow = (gi: number): void => {
    sel = gi;
    Array.from(table.querySelectorAll("tbody tr")).forEach((tr, k) => tr.classList.toggle("sel", k === gi));
    const di = gi >= 0 && gi < filtered.length ? filtered[gi] : -1;
    updateMemberDetail(di);
    if (di >= 0) {
      const inp = table.querySelector<HTMLInputElement>(`tbody tr:nth-child(${gi + 1}) input`);
      if (inp && inp.value) rows[di].suggestedName = inp.value;
      nameInput.value = rows[di].suggestedName;
      void navigate(rows[di]);
    } else previewNets([]);
  };
  const autoSelectFirstRow = (): void => { if (filtered.length) selectRow(0); };
  const findPath = (): void => {
    const fromRef = from.value.trim(), toRef = to.value.trim();
    if (!fromRef || !toRef) { box("Please select both a From and To component.", "Find Path"); return; }
    if (fromRef === toRef) { box("From and To must be different components.", "Find Path"); return; }
    let fs: ReturnType<typeof composedRefs>[number] | null = null, ts: ReturnType<typeof composedRefs>[number] | null = null;
    for (const r of composedRefs(m!)) { if (r.composed === fromRef) fs = r; if (r.composed === toRef) ts = r; }
    if (!fs || !ts) { box(`Could not find component '${fromRef}' or '${toRef}'.`, "Find Path"); return; }
    const found: { chain: NetChain; fromPin: string; toPin: string; nets: string[] }[] = [];
    for (const pa of fs.pins) for (const pb of ts.pins) {
      const c = NC().potentialBetween(m!, NC().pinNetOf(m!, fs.inst, fs.item.id, pa.number), NC().pinNetOf(m!, ts.inst, ts.item.id, pb.number));
      if (c && !found.some((f) => f.chain === c)) found.push({ chain: c, fromPin: fromRef + ":" + pa.number, toPin: toRef + ":" + pb.number, nets: c.nets.slice() });
    }
    if (!found.length) {
      messageBox("Find Path", `No net chain path found between ${fromRef} and ${toRef} through passthrough components.\n\nWould you like to force-create a manual chain link between these components?`, [{ label: "No" }, { label: "Yes", fn: () => {
        const fromNets = new Set<string>(), toNets = new Set<string>(); let fp: string | null = null, tp: string | null = null;
        for (const p of fs!.pins) { const n = NC().pinNetOf(m!, fs!.inst, fs!.item.id, p.number); if (n) { fromNets.add(n); if (fp === null) fp = p.number; } }
        for (const p of ts!.pins) { const n = NC().pinNetOf(m!, ts!.inst, ts!.item.id, p.number); if (n) { toNets.add(n); if (tp === null) tp = p.number; } }
        if (fp === null || tp === null) { box("Selected components have no connected pins to anchor a manual chain.", "Find Path"); return; }
        filtered = []; rows = [{ live: null, memberNets: Array.from(new Set([...fromNets, ...toNets])).sort(), suggestedName: fromRef + "_" + toRef, terminals: fromRef + ARROW + toRef,
          force: { fromSym: { file: fs!.file, id: fs!.item.id }, toSym: { file: ts!.file, id: ts!.item.id }, fromRef, toRef, fromPin: fp, toPin: tp } }];
        rebuildGrid(); autoSelectFirstRow();
        header.textContent = `Showing manual chain between ${fromRef} and ${toRef}. Use Refresh to restore all.`;
      } }], 0);
      return;
    }
    const names = committedNames();
    const uncommitted = found.filter((f) => !f.nets.some((n) => { const ex = NC().chainForNet(m!, n); return !!ex && names.has(ex.name); }));
    if (!uncommitted.length) { box(`All ${found.length} net chain paths between ${fromRef} and ${toRef} are already committed as net chains.`, "Find Path"); return; }
    filtered = []; rows = uncommitted.map((f) => ({ live: f.chain, memberNets: f.nets, terminals: f.fromPin + ARROW + f.toPin,
      suggestedName: fromRef + "_" + toRef + (uncommitted.length > 1 ? "_" + f.fromPin.slice(f.fromPin.lastIndexOf(":") + 1) : "") }));
    rebuildGrid(); autoSelectFirstRow();
    header.textContent = `Showing ${uncommitted.length} path(s) between ${fromRef} and ${toRef}. Use Refresh to restore all.`;
  };
  const reload = (): void => { m = chainModel() || m; filtered = []; loadPotentials(); rebuildGrid(); };
  /** validateAndCreate */
  const create = async (): Promise<boolean> => {
    if (sel < 0 || sel >= filtered.length) { box("Please select a chain from the list."); return false; }
    const di = filtered[sel];
    const inp = table.querySelector<HTMLInputElement>(`tbody tr:nth-child(${sel + 1}) input`);
    if (inp && inp.value) rows[di].suggestedName = inp.value;
    let name = nameInput.value.trim(); if (!name) name = rows[di].suggestedName;
    if (!name) { box("Please enter a name for the net chain."); return false; }
    if (!NC().isValidName(name)) { box("Chain name cannot contain spaces, quotes, or parentheses."); return false; }
    if (NC().chainByName(m!, name)) { box(`A net chain named '${name}' already exists.`); return false; }
    const r = rows[di];
    if (r.live) {
      const text = NC().potentialNodeText(r.live, name);
      if (!text || E.viewOnly || !(await commitChains([putEntry(m!, name, text)], "Create Net Chain"))) { box("Failed to create the net chain."); return false; }
    } else if (r.force) {
      // CreateManualNetChain: a valid, unused name, no member net owned by another chain, both terminals one pin each
      const f = r.force;
      const ok = NC().isValidName(name) && !NC().chainByName(m!, name) && !r.memberNets.some((n) => !!n && !!NC().chainForNet(m!, n));
      const unique = (ref: string, pin: string): boolean => { let n = 0; for (const sh of m!.sheets) for (const s of sh.symbols) if (s.ref === ref) for (const p of s.pins) if (p.number === pin) n++; return n === 1; };
      const text = NC().chainNodeText({ name, from: { ref: f.fromRef, pin: f.fromPin }, to: { ref: f.toRef, pin: f.toPin }, nets: r.memberNets });
      if (!ok || !unique(f.fromRef, f.fromPin) || !unique(f.toRef, f.toPin) || E.viewOnly || !(await commitChains([putEntry(m!, name, text)], "Create Net Chain"))) { box("Failed to create the manual net chain."); return false; }
    }
    created++;
    return true;
  };
  const dlg = openDialog({ title: "Create Net Chain", width: 760, okLabel: "Create", cancelLabel: "Close", noEnter: true, readOnly: !!E.viewOnly,
    build(body) {
      fillRefs();
      body.append(header, filter, gridWrap, membersLabel, members,
        h("hr", { style: "margin:10px 0 0" }),
        h("div", { style: "margin-top:10px;font-weight:bold" }, "Manual endpoint selection"),
        h("div", { style: "display:flex;gap:5px;align-items:center;margin-top:5px" }, h("label", null, "From:"), from, h("label", null, "To:"), to, findBtn), datalist,
        h("div", { style: "display:flex;gap:5px;align-items:center;margin-top:10px" }, h("label", null, "Chain Name:"), nameInput),
        h("div", { style: "margin-top:10px" }, refreshBtn));
      filter.addEventListener("input", () => { rebuildGrid(); });
      findBtn.addEventListener("click", findPath);
      refreshBtn.addEventListener("click", () => { filter.value = ""; fillRefs(); void loadSheets(true).then(() => { reload(); }); });
      if (hint.fromRef) from.value = hint.fromRef;
      if (hint.toRef) to.value = hint.toRef;
      loadPotentials(); rebuildGrid();
      // applyFocusHint
      if (hint.fromRef && hint.toRef) { findPath(); return; }
      let value = "", label = "";
      if (hint.netName) { value = hint.netName; label = `net '${hint.netName}'`; }
      else if (hint.fromRef) { value = hint.fromRef; label = `component ${hint.fromRef}`; }
      else if (hint.toRef) { value = hint.toRef; label = `component ${hint.toRef}`; }
      else return;
      filter.value = value; rebuildGrid();
      if (filtered.length === 1) autoSelectFirstRow();
      else if (!filtered.length) header.textContent = `No uncommitted chains match the selected ${label}. Use Refresh to restore the full list.`;
    },
    ok() {
      void create().then((done) => {
        if (!done) return;
        filtered = []; rows = []; nameInput.value = "";
        m = chainModel() || m; loadPotentials(); rebuildGrid();
        header.textContent = `Chain created (${created} total). Select another or close.`;
      });
      return false;   // the dialog stays open for the next chain
    },
    cancel() { void lastSheet; previewNets([]); applyHighlight(); } });
  return dlg;
}

// ---------------------------------------------------------------- Schematic Setup > Net Chains
/** PANEL_SETUP_NET_CHAINS::loadFromModel: a row per committed chain; null outside a schematic. */
export function setupChainRows(classes: Record<string, unknown>): ChainRow0[] | null {
  const m = chainModel(); if (!m) return null;
  return m.committed.map((c) => ({ name: c.name, origName: c.name, nets: c.nets.slice(), chainClass: typeof classes[c.name] === "string" ? String(classes[c.name]) : "",
    netClass: c.netClass, color: c.color ? `rgba(${c.color[0]}, ${c.color[1]}, ${c.color[2]}, ${+c.color[3].toFixed(3)})` : "",
    from: c.termA ? `${c.termA.ref}-${c.termA.pin}` : "", to: c.termB ? `${c.termB.ref}-${c.termB.pin}` : "" }));
}
type ChainRow0 = { name: string; origName?: string; nets: string[]; chainClass: string; netClass: string; color: string; from: string; to: string };
/** ApplyEdits' renames, colour / net class edits and deletions, written to the sheet that holds the chains. */
export async function applySetupEdits(edits: { orig: string; name: string | null; netClass: string; color: [number, number, number, number] | null }[]): Promise<boolean> {
  const m = chainModel(); if (!m) return false;
  const gone: KChange[] = [], put: KChange[] = [];
  const same = (a: [number, number, number, number] | null, b: [number, number, number, number] | null): boolean => JSON.stringify(a) === JSON.stringify(b);
  for (const e of edits) {
    const c = NC().chainByName(m, e.orig); if (!c) continue;
    const hasEntry = m.saved.some((s) => s.name === e.orig);
    if (e.name === null) { if (hasEntry) gone.push(removed(e.orig)); continue; }
    if (e.name === e.orig && e.netClass === c.netClass && same(e.color, c.color)) continue;
    const text = NC().committedNodeText(c, { name: e.name, netClass: e.netClass, color: e.color }); if (!text) continue;
    if (e.name !== e.orig) { if (hasEntry) gone.push(removed(e.orig)); put.push(added(text, e.name)); }
    else put.push(hasEntry ? modified(text, e.name) : added(text, e.name));
  }
  return commitChains([...gone, ...put], "Net Chains");
}

// ---------------------------------------------------------------- the netlist (NETLIST_EXPORTER_XML's (net_chains …))
/**
 * The committed chains of a hierarchy read for Update PCB (the netlist, its sheets by path, the first top-level
 * sheet's path that holds the chains, the project file) as the netlist carries them to the board.
 */
export function netlistChainsOf(netlist: { netMap?: Map<string, unknown>; instances?: unknown[] }, files: Map<string, { doc: KDoc }>, chainPath: string, pro: Record<string, unknown> | null):
  { name: string; netClass: string; chainClass: string; color: string; members: string[]; terminals: { ref: string; pin: string }[] }[] {
  const h0 = helpers(); if (!h0 || !netlist.netMap || !netlist.instances) return [];
  const docs = new Map<string, KDoc>(); for (const [p, f] of files) docs.set(p, f.doc);
  const holder = files.get(chainPath);
  const saved = NC().savedChains(holder ? holder.doc : null);
  const proName = projectDocs().find((d) => d.docType === "kicad_pro");
  const project = proName ? proName.path.split("/").pop()!.replace(/\.kicad_pro$/, "") : undefined;
  let m: ChainModel;
  try { m = NC().buildChains({ map: netlist.netMap as never, instances: netlist.instances as never, docs, symbolPins: h0.symbolPins, project, saved }); } catch (e) { console.warn(e); return []; }
  const ns = pro && pro.net_settings && typeof pro.net_settings === "object" ? pro.net_settings as Record<string, unknown> : {};
  const cc = ns.net_chain_classes && typeof ns.net_chain_classes === "object" ? ns.net_chain_classes as Record<string, unknown> : {};
  return NC().netlistChains(m, (n) => (typeof cc[n] === "string" ? String(cc[n]) : ""));
}
/**
 * After Update PCB: the board's chain assignments and terminal pads (BOARD_NETLIST_UPDATER), and ApplyChainNetclasses'
 * net_chain_classes / net_chain_netclasses in the project.  The warnings for the report.
 */
export async function applyNetlistChains(chains: ReturnType<typeof netlistChainsOf>): Promise<string[]> {
  const P = CollabTools.pcb as unknown as { netlistChainUpdate?(c: unknown, ch: typeof chains): { text: string | null; warnings: string[] } } | undefined;
  if (!P || !P.netlistChainUpdate || E.viewOnly) return [];
  const r = P.netlistChainUpdate(ctx(), chains);
  if (r.text !== null) {
    const BS = (KiCadCanvas as unknown as { boardSetup: { netChainsChange(t: string): KChange } }).boardSetup;
    const change = BS.netChainsChange(r.text); sendOp([change], false); applyChanges([change]);
  }
  const classes: JsonObj = {}, netclasses: JsonObj = {};
  for (const c of chains) { if (c.chainClass) classes[c.name] = c.chainClass; if (c.netClass) netclasses[c.name] = c.netClass; }
  const ns0 = (proJson().net_settings || {}) as JsonObj;
  const same = (a: unknown, b: JsonObj): boolean => JSON.stringify(a && typeof a === "object" ? a : {}) === JSON.stringify(b);
  if (!same(ns0.net_chain_classes, classes) || !same(ns0.net_chain_netclasses, netclasses)) {
    try { await saveProject((pro) => { const ns = (pro.net_settings || (pro.net_settings = {})) as JsonObj; ns.net_chain_classes = classes; ns.net_chain_netclasses = netclasses; }, "update netlist"); } catch (e) { console.warn(e); }
  }
  return r.warnings;
}

// ---------------------------------------------------------------- the board (REPLACE_TERMINAL_PAD_MENU, ReplaceTerminalPad)
interface PcbChainTools { terminalPadState?(ctx: unknown): { pad: string; old: [string, string] } | null; replaceTerminalPad?(ctx: unknown, prev: string, next: string): string | null }
const pcbChains = (): PcbChainTools | null => (CollabTools.pcb as unknown as PcbChainTools | undefined) || null;
export function boardTerminalPadState(): { pad: string; old: [string, string] } | null {
  const P = pcbChains(); if (!P || !P.terminalPadState || !E.kdoc) return null;
  try { return P.terminalPadState(ctx()); } catch (e) { return null; }
}
/** PCB_ACTIONS::setTerminalPad: the highlighted chain's terminal pad `prev` becomes `next`; the board's (net_chains …) is rewritten. */
export function setTerminalPad(prev: string, next: string): void {
  const P = pcbChains(); if (!P || !P.replaceTerminalPad || E.viewOnly) return;
  const text = P.replaceTerminalPad(ctx(), prev, next); if (text === null) return;
  const BS = (KiCadCanvas as unknown as { boardSetup: { netChainsChange(t: string): KChange } }).boardSetup;
  const change = BS.netChainsChange(text);
  sendOp([change], false); applyChanges([change]); requestRender();
}

// ---------------------------------------------------------------- hooks
export function installNetChains(handlers: Record<string, (a?: unknown) => void>): void {
  // SCH_EDITOR_CONTROL's net chain actions (the board's highlightNetChain / selectNetChain are pcb-tools actions)
  Object.assign(handlers, {
    highlightNetChain: () => {
      if (E.kdoc && (E.kdoc as KDoc).type === "sch") { highlightNetChainAt((E.lastCursorMm as number[] | null) || null); return; }
      const P = CollabTools.pcb as unknown as { highlightNetChainAt?(c: unknown): boolean } | undefined; if (P && P.highlightNetChainAt) { P.highlightNetChainAt(ctx()); requestRender(); }
    },
    removeFromNetChain: () => { void removeFromNetChain(); },
    nameNetChain: () => { nameNetChain(); },
    createNetChainBetweenPins: () => { createNetChainBetweenPins(); },
    createNetChain: () => { showCreateNetChain(); },
  });
  chainHooks.byName = (name: string) => { const m = chainModel(); const c = m ? NC().chainByName(m, name) : null; return c ? { name: c.name, nets: c.nets } : null; };
  chainHooks.forNet = (net: string) => { const m = chainModel(); const c = m ? NC().chainForNet(m, net) : null; return c ? { name: c.name, nets: c.nets } : null; };
  chainHooks.status = chainStatus;
  void setStatusBar; void selectionChanged;
}
