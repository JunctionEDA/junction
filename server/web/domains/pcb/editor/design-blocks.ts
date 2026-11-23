// editor/design-blocks.ts — the Design Blocks pane's model and the design block actions of both editors:
//   DESIGN_BLOCK_PANE / PANEL_DESIGN_BLOCK_CHOOSER (common/widgets): the libraries of the design block library table,
//     a "-- Recently Used --" list (addDesignBlockToHistory), the selected node, the placement checkboxes
//     (APP_SETTINGS_BASE::m_DesignBlockChooserPanel) and the library commands (new library, pin / unpin, delete
//     block, properties, hide);
//   SCH_DESIGN_BLOCK_CONTROL / PCB_DESIGN_BLOCK_CONTROL and sch_design_block_utils.cpp / pcb_design_block_utils.cpp:
//     Save Current Sheet / Board as Design Block, Save Selection as Design Block, Update Design Block from Sheet /
//     Board / Selection;
//   SCH_DRAWING_TOOLS::ImportSheet (placeDesignBlock) and DrawSheet (drawSheetFromDesignBlock), PCB_CONTROL::
//     AppendDesignBlock, PlaceLinkedDesignBlock and SaveToLinkedDesignBlock;
//   DIALOG_DESIGN_BLOCK_PROPERTIES.
// The libraries are project folders ("<nick>.kicad_blocks", library/design-blocks.ts); the chrome's pane
// (shared/components/panes/DesignBlocks.tsx) reads this model through window.KcDesignBlocks.
import { state, store, setStatusBar } from "./appstore";
import { E } from "./state";
import { toast } from "./util";
import { setTool, toolCtx } from "./tools";
import { isSch } from "./view";
import { showPane } from "./panes";
import { KD, h } from "../dialogs/dom";
import {
  DesignBlockLibs, DB_PLACE_DEFAULTS, DB_TABLE_FILE, DbError, addToHistory, blockInfoHtml, formatDbLibId, groupDesignBlockId, librariesOf, parseDbLibId, validateProperties,
  type DbDoc, type DbLibId, type DbLibrary, type DbPlaceOpts, type DbStore, type DesignBlock,
} from "../library/design-blocks";
import { loadPinnedLibs, setLibPinned } from "../library/pinned";
import type { ActionHandler } from "./types";

type Ed = "sch" | "pcb";
const editor = (): Ed => (isSch() ? "sch" : "pcb");

// ---------------------------------------------------------------- the project's documents as a DbStore
interface ProjectView { projectId: string; docs: { docId: string; path: string; docType: string }[] }
const project = (): ProjectView | null => (state.project as unknown as ProjectView | null) || null;
async function readText(docId: string): Promise<string> {
  const r = await fetch(`/api/docs/${docId}/content?v=${Date.now()}`, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
const libTables = () => import("../dialogs/lib-tables");
export const projectStore: DbStore = {
  docs: (): DbDoc[] => (project() ? project()!.docs : []),
  read: readText,
  async create(path, text) { const m = await libTables(); return m.writeProjectText(path, text); },
  async write(docId, text) { const p = project(); const d = p && p.docs.find((x) => x.docId === docId); if (!d) return false; const m = await libTables(); return !!(await m.writeProjectText(d.path, text)); },
  async remove(docId) {
    const p = project(); if (!p) return false;
    const r = await fetch(`/api/docs/${docId}`, { method: "DELETE", credentials: "same-origin" });
    if (!r.ok) return false;
    p.docs = p.docs.filter((x) => x.docId !== docId); store.set({ project: Object.assign({}, state.project) });
    return true;
  },
  readOnly: () => !!E.viewOnly || !state.me,
};

// ---------------------------------------------------------------- the pane's model
export interface DbPaneBlock { name: string; desc: string; keywords: string }
export interface DbPaneLib { nick: string; descr: string; pinned: boolean; writable: boolean; blocks: DbPaneBlock[] }
export interface DbPaneState {
  editor: Ed;
  libs: DbPaneLib[];
  /** the "-- Recently Used --" entries, as "lib:name" */
  history: string[];
  /** the current tree node: "lib:name" for a block, "lib:" for a library, null for none */
  current: string | null;
  opts: DbPlaceOpts;
  loading: boolean;
  /** GenerateInfo of the current block */
  info: string;
  version: number;
}
const OPTS_KEY = (ed: Ed): string => "kui.designBlocks." + ed;
function loadOpts(ed: Ed): DbPlaceOpts {
  try { const v = JSON.parse(localStorage.getItem(OPTS_KEY(ed)) || "{}") as Partial<DbPlaceOpts>; return { ...DB_PLACE_DEFAULTS, ...v }; } catch { return { ...DB_PLACE_DEFAULTS }; }
}
const histories: Record<Ed, string[]> = { sch: [], pcb: [] };
let model: DbPaneState = { editor: "sch", libs: [], history: [], current: null, opts: loadOpts("sch"), loading: false, info: "", version: 0 };
const listeners = new Set<() => void>();
function publish(patch: Partial<DbPaneState>): void { model = { ...model, ...patch, version: model.version + 1 }; for (const l of listeners) l(); }

let tableRows: DbLibrary[] = [];
export const libs = new DesignBlockLibs(projectStore, () => tableRows);
const blockCache = new Map<string, DesignBlock>();

/** LIBRARY_MANAGER's design block table rows: the project's design-block-lib-table (the global table is empty). */
async function readTable(): Promise<DbLibrary[]> {
  const p = project(); const d = p && p.docs.find((x) => x.path === DB_TABLE_FILE); if (!d) return [];
  const { parseLibTable } = await import("../symedit/model");
  try { return librariesOf(parseLibTable(await readText(d.docId))); } catch { return []; }
}
let loadSeq = 0;
/** DESIGN_BLOCK_PANE::RefreshLibs: the enabled, visible libraries with their blocks' metadata. */
export async function refreshLibs(): Promise<void> {
  const seq = ++loadSeq, ed = editor();
  if (model.editor !== ed) publish({ editor: ed, opts: loadOpts(ed), history: histories[ed].slice(), current: null, info: "" });
  publish({ loading: true });
  tableRows = await readTable();
  const pinned = loadPinnedLibs("designBlock");
  const out: DbPaneLib[] = [];
  blockCache.clear();
  for (const l of tableRows) {
    if (!l.enabled || !l.visible) continue;
    const blocks = await libs.blocks(l.nick);
    for (const b of blocks) blockCache.set(formatDbLibId(b.id), b);
    out.push({ nick: l.nick, descr: l.descr, pinned: pinned.has(l.nick), writable: libs.isWritable(l.nick), blocks: blocks.map((b) => ({ name: b.id.name, desc: b.description, keywords: b.keywords })) });
  }
  if (seq !== loadSeq) return;
  // a history entry whose block went is dropped from the list shown
  const hist = histories[ed].filter((id) => blockCache.has(id));
  publish({ libs: out, loading: false, history: hist, info: model.current && blockCache.get(model.current) ? blockInfoHtml(blockCache.get(model.current)!) : "" });
}
/** DESIGN_BLOCK_PANE::SelectLibId / the tree's selection. */
export function selectNode(id: string | null): void {
  const b = id ? blockCache.get(id) : null;
  publish({ current: id, info: b ? blockInfoHtml(b) : "" });
}
/** GetSelectedLibId: the current block's LIB_ID, null when a library or nothing is current. */
export function selectedLibId(): DbLibId | null {
  const c = model.current; if (!c) return null; const id = parseDbLibId(c); return id.name ? id : null;
}
const currentLibrary = (): string => (model.current ? parseDbLibId(model.current).lib : "");
function setOpt(k: keyof DbPlaceOpts, on: boolean): void {
  const opts = { ...model.opts, [k]: on };
  try { localStorage.setItem(OPTS_KEY(model.editor), JSON.stringify(opts)); } catch { /* private window */ }
  publish({ opts });
}
function remember(id: DbLibId): void { const key = formatDbLibId(id); histories[model.editor] = addToHistory(histories[model.editor], key); publish({ history: histories[model.editor].slice() }); }

// ---------------------------------------------------------------- small dialogs
const infoBarError = (msg: string): void => toast(msg, 6000, undefined, "error");
async function errorBox(msg: string): Promise<void> { const m = await libTables(); await m.choiceBox("Error", msg, ["OK"]); }
/** OKOrCancelDialog( "Confirmation", msg, detail, "Overwrite" ). */
async function okOrCancel(msg: string, detail: string, ok: string): Promise<boolean> { const m = await libTables(); return (await m.choiceBox("Confirmation", msg, ["Cancel", ok], { detail })).index === 1; }
/** IsOK: Yes / No. */
async function isOK(msg: string): Promise<boolean> { const m = await libTables(); return (await m.choiceBox("Confirmation", msg, ["No", "Yes"])).index === 1; }
const checkOverwrite = (lib: string, name: string): Promise<boolean> => okOrCancel(`Design block '${name}' already exists in library '${lib}'.`, "Overwrite existing design block?", "Overwrite");

/**
 * DIALOG_DESIGN_BLOCK_PROPERTIES: Name, Keywords, Description and the Default Fields grid (add, delete, move up /
 * down; a new row is "Untitled Field").  OK checks the name for an illegal character and the field names for
 * duplicates; resolves the edited block, or null on Cancel.
 */
export function designBlockProperties(block: DesignBlock, readOnly = false): Promise<DesignBlock | null> {
  return new Promise((resolve) => {
    let name: HTMLInputElement, keywords: HTMLInputElement, descr: HTMLTextAreaElement;
    const rows = block.fields.map(([k, v]) => ({ name: k, value: v }));
    let settled = false; const done = (v: DesignBlock | null): void => { if (!settled) { settled = true; resolve(v); } };
    KD().open({
      title: "Design Block Properties", width: 480, readOnly,
      build(body) {
        name = h("input", { type: "text", "data-k": "db-name", value: block.id.name, style: "width:100%" }) as HTMLInputElement;
        keywords = h("input", { type: "text", "data-k": "db-keywords", value: block.keywords, style: "width:100%" }) as HTMLInputElement;
        descr = h("textarea", { "data-k": "db-description", style: "width:100%;min-height:60px;box-sizing:border-box" }) as HTMLTextAreaElement; descr.value = block.description;
        body.append(h("div", { class: "kv" }, h("label", null, "Name:"), name, h("label", null, "Keywords:"), keywords, h("label", null, "Description:"), descr));
        const box = KD().staticBox(body, "Default Fields");
        KD().grid(box, [{ key: "name", label: "Name" }, { key: "value", label: "Value" }], rows, { readOnly, height: 160,
          buttons: { add: () => ({ name: "Untitled Field", value: "" }), remove: true, move: true } });
      },
      ok() {
        const fields = rows.map((r) => [String(r.name ?? ""), String(r.value ?? "")] as [string, string]);
        const v = validateProperties(name.value, fields);
        if (v.error) { void errorBox(v.error); return false; }
        done({ ...block, id: { lib: block.id.lib, name: name.value }, keywords: keywords.value, description: descr.value, fields: v.fields });
      },
      cancel() { done(null); },
    });
  });
}

// ---------------------------------------------------------------- library commands
/** DESIGN_BLOCK_PANE::CreateNewDesignBlockLibrary + AddDesignBlockLibrary: a new project library and its table row. */
export async function newLibrary(title = "New Design Block Library"): Promise<string | null> {
  if (projectStore.readOnly()) { toast("View-only access"); return null; }
  const { promptText } = await import("../dialogs/dom");
  let path = await promptText(title, "File name:", "untitled.kicad_blocks"); if (!path) return null;
  path = path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""); if (!path) return null;
  if (!/\.kicad_blocks$/i.test(path)) path += ".kicad_blocks";
  const existing = projectStore.docs().filter((d) => d.path.startsWith(path + "/"));
  if (existing.length) {
    if (!(await okOrCancel(`Library ${path} already exists.`, "", "Overwrite"))) return null;
    for (const d of existing) if (!(await projectStore.remove(d.docId))) { await errorBox(`Design block library '${path}' cannot be deleted.`); return null; }
  }
  const fileName = path.slice(path.lastIndexOf("/") + 1), nick = fileName.replace(/\.kicad_blocks$/i, "");
  if (!nick) return null;
  const description = await promptText(title, "Enter a description for the library:", "");
  const p = project(); if (!p) return null;
  const { parseLibTable, formatLibTable } = await import("../symedit/model");
  const d = p.docs.find((x) => x.path === DB_TABLE_FILE);
  let rows = d ? parseLibTable(await readText(d.docId)) : [];
  rows = rows.concat([{ nickname: nick, uri: "${KIPRJMOD}/" + path, type: "KiCad", options: "", descr: description || "", enabled: true, visible: true }]);
  const m = await libTables();
  if (!(await m.writeProjectText(DB_TABLE_FILE, formatLibTable(rows, "design_block_lib_table")))) { await errorBox("Error saving library table:\n\n" + DB_TABLE_FILE); return null; }
  window.dispatchEvent(new CustomEvent("kc-libtable-changed", { detail: { kind: "designBlock" } }));
  await refreshLibs(); selectNode(nick + ":");
  return path;
}
/** DESIGN_BLOCK_PANE::DeleteDesignBlockFromLibrary (with the confirmation). */
export async function deleteDesignBlock(id: DbLibId | null = selectedLibId()): Promise<boolean> {
  if (!id) return false;
  if (!libs.isWritable(id.lib)) { infoBarError(`Library '${id.lib}' is read only.`); return false; }
  if (!(await isOK(`Delete design block '${id.name}' in library '${id.lib}' from disk?`))) return false;
  try { await libs.remove(id); } catch (e) { await errorBox((e as Error).message); return false; }
  setStatusBar({ message: `Design block '${id.name}' deleted from library '${id.lib}'` });
  histories[model.editor] = histories[model.editor].filter((x) => x !== formatDbLibId(id));
  await refreshLibs(); selectNode(id.lib + ":");
  return true;
}
/** DESIGN_BLOCK_PANE::EditDesignBlockProperties: a renamed block is saved under its new name, then the old one goes. */
export async function editDesignBlockProperties(id: DbLibId | null = selectedLibId()): Promise<boolean> {
  if (!id) return false;
  if (!libs.isWritable(id.lib)) { infoBarError(`Library '${id.lib}' is read only.`); return false; }
  let blk: DesignBlock;
  try { blk = await libs.load(id); } catch (e) { await errorBox((e as Error).message); return false; }
  const edited = await designBlockProperties(blk); if (!edited) return false;
  try {
    if (edited.id.name !== id.name) {
      if (libs.exists(id.lib, edited.id.name) && !(await checkOverwrite(id.lib, edited.id.name))) return false;
      const sch = blk.schDoc ? await libs.text(blk.schDoc) : null, pcb = blk.pcbDoc ? await libs.text(blk.pcbDoc) : null;
      await libs.save(edited, { sch, pcb });
      await libs.remove(id);
    } else await libs.save(edited, {});
  } catch (e) { await errorBox((e as Error).message); return false; }
  await refreshLibs(); selectNode(formatDbLibId(edited.id));
  return true;
}
export function pinLibrary(nick: string, on: boolean): void { setLibPinned("designBlock", nick, on); void refreshLibs(); }

// ---------------------------------------------------------------- the editors' selection
interface SchModule { clipboardText(doc: KDoc, items: KItem[], opts?: { wrap?: boolean }): string; state: Record<string, unknown>;
  _: { pasteText(ctx: unknown, text: string, opts?: Record<string, unknown>): boolean; addNode(doc: KDoc, node: SNode): { item: KItem; change: KChange }; modChange(doc: KDoc, item: KItem, node: SNode): KChange; setSelectionIds(ctx: unknown, ids: string[]): void } }
interface PcbModuleView { clipboardText(doc: KDoc, ids: Iterable<string>, ref?: number[] | null): string; applySelection(ctx: unknown, ids: string[]): void;
  groupMembersChanges(doc: KDoc, g: KItem, add: string[] | null, remove: string[] | null): KChange[]; addedChange?: unknown }
interface PcbToolsView { placeBoardText(ctx: unknown, text: string, opts: { label: string; group?: { name: string; libId: string } | null; after?: (placed: boolean) => void }): boolean; addedChange(doc: KDoc, node: SNode): KChange; replacedChange(item: KItem, node: SNode): KChange }
const schMod = (): SchModule | null => ((window as unknown as { CollabTools?: { sch?: SchModule } }).CollabTools?.sch) || null;
const pcbMod = (): PcbModuleView | null => ((window as unknown as { CollabTools?: { pcb?: PcbModuleView } }).CollabTools?.pcb) || null;
const pcbTools = (): PcbToolsView | null => ((window as unknown as { PcbTools?: PcbToolsView }).PcbTools) || null;
const selectedItems = (): KItem[] => (E.kdoc ? [...((E.selection as Set<string> | undefined) || [])].map((id) => E.kdoc!.items.get(id)).filter(Boolean) as KItem[] : []);
const groupItems = (): KItem[] => (E.kdoc ? [...E.kdoc.items.values()].filter((it) => it.kind === "group") : []);
const membersOf = (g: KItem): string[] => { for (const c of g.node) if (Array.isArray(c) && c[0] === "members") return c.slice(1).map((x) => String(x)); return []; };
const parentGroup = (id: string): KItem | null => groupItems().find((g) => membersOf(g).includes(id)) || null;
/** groupWithDesignBlockLink: exactly one item selected, a group that has a design block link. */
export function selectedLinkedGroup(): KItem | null {
  const sel = selectedItems(); if (sel.length !== 1 || sel[0].kind !== "group") return null;
  return groupDesignBlockId(sel[0].node) ? sel[0] : null;
}
/** Every member below a group (RECURSE). */
function flatten(items: KItem[]): KItem[] {
  const out: KItem[] = [], seen = new Set<string>();
  const take = (it: KItem): void => { if (seen.has(it.id)) return; seen.add(it.id); out.push(it); if (it.kind === "group") for (const id of membersOf(it)) { const m = E.kdoc!.items.get(id); if (m) take(m); } };
  for (const it of items) take(it); return out;
}
const fileStem = (): string => { const p = project(); const d = p && p.docs.find((x) => x.docId === state.docId); const base = d ? d.path.slice(d.path.lastIndexOf("/") + 1) : ""; return base.replace(/\.[^.]*$/, ""); };
const groupName = (g: KItem): string => String(g.node[1] ?? "");

/** A selected sheet's own schematic (SaveSheetAsDesignBlock on GetCurrentSheet() + the sheet): its name, its fields
 *  other than the name and file, and its file's document; nested sheets in it are refused. */
async function subsheet(it: KItem): Promise<{ name: string; fields: [string, string][]; text: string } | null> {
  const props = it.node.filter((c) => Array.isArray(c) && c[0] === "property") as SNode[];
  const prop = (re: RegExp): string => { const f = props.find((c) => re.test(String(c[1]))); return f ? String(f[2]) : ""; };
  const file = prop(/^Sheet ?file$/i), name = prop(/^Sheet ?name$/i);
  const p = project(), cur = p && p.docs.find((x) => x.docId === state.docId), dir = cur && cur.path.includes("/") ? cur.path.slice(0, cur.path.lastIndexOf("/") + 1) : "";
  const norm = (s: string): string => { const out: string[] = []; for (const seg of s.split("/")) { if (seg === "..") out.pop(); else if (seg && seg !== ".") out.push(seg); } return out.join("/"); };
  const d = p && p.docs.find((x) => x.path === norm(dir + file.replace(/\\/g, "/")));
  if (!d) { await errorBox("Error saving temporary schematic file to create design block."); return null; }
  const text = await readText(d.docId);
  if (/\(\s*sheet\s*\(\s*at\b/.test(text)) { await errorBox("Design blocks with nested sheets are not supported."); return null; }
  // wxFileNameFromPath( sheet->GetName() ).GetName(): the sheet's name without a path or an extension
  return { name: name.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, ""), fields: props.filter((c) => !/^Sheet ?(file|name)$/i.test(String(c[1]))).map((c) => [String(c[1]), String(c[2])] as [string, string]), text };
}
/** The schematic of a selection as a sheet of its own (the temporary SCH_SCREEN the save writes). */
function selectionSchematic(items: KItem[]): string { const m = schMod()!; return m.clipboardText(E.kdoc!, items, { wrap: true }); }
/** The layout of a selection as a board of its own (saveSelectionToDesignBlock's temporary BOARD). */
function selectionBoard(items: KItem[]): string { return pcbMod()!.clipboardText(E.kdoc!, items.map((it) => it.id), [0, 0]); }

/** "Group Items" after a save: the selection's groupable top-level items go into a new group linked to the block. */
function groupSelection(items: KItem[], id: DbLibId): void {
  const doc = E.kdoc!, ctx = toolCtx(), changes: KChange[] = [];
  const members = items.filter((it) => it.kind !== "pin" && it.kind !== "field" && it.kind !== "pad" && it.kind !== "property").map((it) => it.id);
  if (!members.length) return;
  // an item leaves the group it was in (EDA_GROUP::AddItem)
  const touched = new Map<string, string[]>();
  for (const m of members) { const g = parentGroup(m); if (g) touched.set(g.id, (touched.get(g.id) || []).concat(m)); }
  const node: SNode = ["group", id.name, ["uuid", KiCadCanvas.newUuid()], ["lib_id", formatDbLibId(id)], ["members", ...members]];
  let newId = "";
  if (isSch()) {
    const m = schMod()!;
    for (const [gid, gone] of touched) { const g = doc.items.get(gid)!; const n = g.node.map((c: unknown) => (Array.isArray(c) && c[0] === "members" ? ["members", ...membersOf(g).filter((x) => !gone.includes(x))] : c)) as SNode; changes.push(m._.modChange(doc, g, n)); }
    const r = m._.addNode(doc, node); changes.push(r.change); newId = r.item.id;
    (ctx as { commit(c: KChange[], l: string): void }).commit(changes, "Group Items"); m._.setSelectionIds(ctx, [newId]);
  } else {
    const P = pcbMod()!, T = pcbTools()!;
    for (const [gid, gone] of touched) changes.push(...P.groupMembersChanges(doc, doc.items.get(gid)!, null, gone));
    const c = T.addedChange(doc, node); changes.push(c); newId = c.id;
    (ctx as { commit(c: KChange[], l: string): void }).commit(changes, "Group Items"); P.applySelection(ctx, [newId]);
  }
}
/** The group node with (lib_id …) set, kept in the order the file writes it (before the members). */
function withLink(node: SNode, libId: string): SNode {
  const out = node.filter((c) => !(Array.isArray(c) && c[0] === "lib_id")) as SNode;
  const at = out.findIndex((c, i) => i > 0 && Array.isArray(c) && c[0] === "members");
  out.splice(at > 0 ? at : out.length, 0, ["lib_id", libId]); return out;
}
function modifyGroup(g: KItem, node: SNode, label: string): void {
  const ctx = toolCtx() as { commit(c: KChange[], l: string): void };
  ctx.commit([isSch() ? schMod()!._.modChange(E.kdoc!, g, node) : pcbTools()!.replacedChange(g, node)], label);
}

// ---------------------------------------------------------------- save / update
const needLibrary = async (): Promise<string | null> => {
  const lib = currentLibrary();
  if (!lib) { await errorBox("Please select a library to save the design block to."); return null; }
  return lib;
};
/** SaveSheetAsDesignBlock / SaveBoardAsDesignBlock. */
export async function saveDocumentAsDesignBlock(): Promise<boolean> {
  if (!E.kdoc) return false;
  const lib = await needLibrary(); if (!lib) return false;
  const sch = isSch();
  if (sch && [...E.kdoc.items.values()].some((it) => it.kind === "sheet")) { await errorBox("Design blocks with nested sheets are not supported."); return false; }
  const blk: DesignBlock = { id: { lib, name: fileStem() }, description: "", keywords: "", fields: [], schDoc: null, pcbDoc: null, jsonDoc: null };
  const edited = await designBlockProperties(blk); if (!edited) return false;
  if (libs.exists(edited.id.lib, edited.id.name) && !(await checkOverwrite(edited.id.lib, edited.id.name))) return false;
  let text: string;
  try { text = await readText(state.docId as string); }
  catch { await errorBox(sch ? "Error saving temporary schematic file to create design block." : "Error saving temporary board file to create design block."); return false; }
  return finishSave(edited, sch ? { sch: text } : { pcb: text });
}
async function finishSave(blk: DesignBlock, files: { sch?: string; pcb?: string }): Promise<boolean> {
  let ok = false;
  try { await libs.save(blk, files); ok = true; } catch (e) { await errorBox((e as Error).message); }
  await refreshLibs(); selectNode(formatDbLibId(blk.id));
  return ok;
}
/** SaveSelectionAsDesignBlock (both editors). */
export async function saveSelectionAsDesignBlock(): Promise<boolean> {
  if (!E.kdoc) return false;
  const sch = isSch();
  let sel = selectedItems();
  if (sch && !sel.length) { await errorBox("Please select some items to save as a design block."); return false; }
  const lib = await needLibrary(); if (!lib) return false;
  if (!sch && !sel.length) { await errorBox("Please select some items to save as a design block."); return false; }
  if (sch && sel.some((it) => it.kind === "sheet")) {
    if (sel.length !== 1) { await errorBox("Design blocks with nested sheets are not supported."); return false; }
    // a lone sheet is saved as its own schematic (SaveSheetAsDesignBlock on the sheet's path)
    const sub = await subsheet(sel[0]); if (!sub) return false;
    const edited = await designBlockProperties({ id: { lib, name: sub.name }, description: "", keywords: "", fields: sub.fields, schDoc: null, pcbDoc: null, jsonDoc: null }); if (!edited) return false;
    if (libs.exists(edited.id.lib, edited.id.name) && !(await checkOverwrite(edited.id.lib, edited.id.name))) return false;
    return finishSave(edited, { sch: sub.text });
  }
  const group = sel.length === 1 && sel[0].kind === "group" ? sel[0] : null;
  const blk: DesignBlock = { id: { lib, name: group && groupName(group) ? groupName(group) : fileStem() }, description: "", keywords: "", fields: [], schDoc: null, pcbDoc: null, jsonDoc: null };
  const edited = await designBlockProperties(blk); if (!edited) return false;
  if (libs.exists(edited.id.lib, edited.id.name) && !(await checkOverwrite(edited.id.lib, edited.id.name))) return false;
  // a single group is saved as its children (not recursing: inner groups stay groups)
  if (group) sel = membersOf(group).map((id) => E.kdoc!.items.get(id)).filter(Boolean) as KItem[];
  const text = sch ? selectionSchematic(sel) : selectionBoard(sel);
  const ok = await finishSave(edited, sch ? { sch: text } : { pcb: text });
  if (ok && !group) groupSelection(sel, edited.id);
  else if (ok && group && !groupDesignBlockId(group.node)) modifyGroup(group, withLink(group.node, formatDbLibId(edited.id)), "Set Group Design Block Link");
  return ok;
}
const checkOverwriteContent = (id: DbLibId, sch: boolean): Promise<boolean> =>
  okOrCancel(`Design block '${id.name}' already has a ${sch ? "schematic" : "layout"}.`, `Overwrite existing ${sch ? "schematic" : "layout"}?`, "Overwrite");
/** UpdateDesignBlockFromSheet / UpdateDesignBlockFromBoard. */
export async function updateDesignBlockFromDocument(id: DbLibId | null = selectedLibId()): Promise<boolean> {
  if (!E.kdoc) return false;
  const sch = isSch();
  if (sch) { if (!id || !libs.exists(id.lib, id.name)) { await errorBox("Please select a design block to save the schematic to."); return false; } }
  else if (!currentLibrary() || !id) { await errorBox("Please select a library to save the design block to."); return false; }
  if (sch && [...E.kdoc.items.values()].some((it) => it.kind === "sheet")) { await errorBox("Design blocks with nested sheets are not supported."); return false; }
  let blk: DesignBlock;
  try { blk = await libs.load(id); } catch (e) { await errorBox((e as Error).message); return false; }
  if ((sch ? blk.schDoc : blk.pcbDoc) && !(await checkOverwriteContent(id, sch))) return false;
  if (sch) { const edited = await designBlockProperties(blk); if (!edited) return false; blk = { ...edited, id: blk.id }; }
  let text: string;
  try { text = await readText(state.docId as string); }
  catch { await errorBox(sch ? "Error saving temporary schematic file to create design block." : "Error saving temporary board file to create design block."); return false; }
  return finishSave(blk, sch ? { sch: text } : { pcb: text });
}
/** UpdateDesignBlockFromSelection (both editors). */
export async function updateDesignBlockFromSelection(id: DbLibId | null = selectedLibId()): Promise<boolean> {
  if (!E.kdoc) return false;
  const sch = isSch();
  let sel = selectedItems();
  if (sch) {
    if (!sel.length) { await errorBox("Please select some items to save as a design block."); return false; }
    if (!id || !libs.exists(id.lib, id.name)) { await errorBox("Please select a design block to save the schematic to."); return false; }
    if (sel.some((it) => it.kind === "sheet")) {
      if (sel.length !== 1) { await errorBox("Design blocks with nested sheets are not supported."); return false; }
      // UpdateDesignBlockFromSheet on the sheet's path: its fields overwrite the block's, the others stay
      const sub = await subsheet(sel[0]); if (!sub) return false;
      let blk: DesignBlock;
      try { blk = await libs.load(id); } catch (e) { await errorBox((e as Error).message); return false; }
      if (blk.schDoc && !(await checkOverwriteContent(id, true))) return false;
      const fields = blk.fields.slice(); for (const [k, v] of sub.fields) { const i = fields.findIndex(([n]) => n === k); if (i >= 0) fields[i] = [k, v]; else fields.push([k, v]); }
      const edited = await designBlockProperties({ ...blk, fields }); if (!edited) return false;
      return finishSave({ ...edited, id: blk.id }, { sch: sub.text });
    }
  } else {
    if (!currentLibrary() || !id) { await errorBox("Please select a library to save the design block to."); return false; }
    if (!sel.length) { await errorBox("Please select some items to save as a design block."); return false; }
  }
  // a lone group, or the one group of the selection linked to this block, is saved as its children with the rest
  const key = formatDbLibId(id);
  let group: KItem | null = null; const extra: KItem[] = [];
  if (sel.length === 1) { if (sel[0].kind === "group") group = sel[0]; }
  else for (const it of sel) {
    if (it.kind !== "group" || groupDesignBlockId(it.node) !== key) continue;
    if (group) { await errorBox("The selection contains more than one group linked to this design block."); return false; }
    group = it;
  }
  if (group) { for (const it of sel) if (it !== group) extra.push(it); sel = sel.filter((it) => it !== group).concat(membersOf(group).map((m) => E.kdoc!.items.get(m)).filter(Boolean) as KItem[]); }
  let blk: DesignBlock;
  try { blk = await libs.load(id); } catch (e) { await errorBox((e as Error).message); return false; }
  if ((sch ? blk.schDoc : blk.pcbDoc) && !(await checkOverwriteContent(id, sch))) return false;
  const text = sch ? selectionSchematic(sel) : selectionBoard(sel);
  const ok = await finishSave(blk, sch ? { sch: text } : { pcb: text });
  if (ok && group) {
    // the extra items join the group, and a group without a link gets this one ("Update Design Block Group")
    const have = new Set(membersOf(group)), add = extra.filter((it) => it.kind !== "pin" && it.kind !== "field" && it.kind !== "pad" && !have.has(it.id)).map((it) => it.id);
    let node = group.node;
    if (add.length) node = node.map((c: unknown) => (Array.isArray(c) && c[0] === "members" ? ["members", ...membersOf(group!), ...add] : c)) as SNode;
    if (!groupDesignBlockId(node)) node = withLink(node, key);
    if (node !== group.node) {
      const doc = E.kdoc!, ctx = toolCtx() as { commit(c: KChange[], l: string): void }, changes: KChange[] = [];
      for (const a of add) { const g = parentGroup(a); if (g && g.id !== group.id) changes.push(isSch() ? schMod()!._.modChange(doc, g, g.node.map((c: unknown) => (Array.isArray(c) && c[0] === "members" ? ["members", ...membersOf(g).filter((x) => x !== a)] : c)) as SNode) : pcbMod()!.groupMembersChanges(doc, g, null, [a])[0]); }
      changes.push(isSch() ? schMod()!._.modChange(doc, group, node) : pcbTools()!.replacedChange(group, node));
      ctx.commit(changes.filter(Boolean), "Update Design Block Group");
    }
  } else if (ok) groupSelection(sel, id);
  return ok;
}

// ---------------------------------------------------------------- placing
/** GetDesignBlock( libId, true, true ): the block, or the error shown and null. */
async function loadBlock(id: DbLibId): Promise<DesignBlock | null> {
  try { return await libs.load(id); } catch (e) { infoBarError((e as Error).message); return null; }
}
/** SCH_DRAWING_TOOLS::ImportSheet( placeDesignBlock ) and PCB_CONTROL::AppendDesignBlock. */
export async function placeDesignBlock(id: DbLibId | null = selectedLibId(), linkedGroup?: KItem | null): Promise<boolean> {
  if (!E.kdoc || !id) return false;
  if (E.viewOnly) { toast("View-only access"); return false; }
  const blk = await loadBlock(id); if (!blk) return false;
  const sch = isSch(), opts = model.editor === editor() ? model.opts : loadOpts(editor());
  if (sch && !blk.schDoc) { if (linkedGroup) toast(`Design block ${formatDbLibId(id)} does not have a schematic file.`, 5000, undefined, "warning"); else infoBarError("Design block has no schematic to place."); return false; }
  if (!sch && !blk.pcbDoc) { if (linkedGroup) toast(`Design block ${formatDbLibId(id)} does not have a board file.`, 5000, undefined, "warning"); else infoBarError("Design block has no layout to place."); return false; }
  const text = await libs.text((sch ? blk.schDoc : blk.pcbDoc)!);
  remember(id);
  if (sch) return placeSchematic(blk, text, opts, !!linkedGroup);
  return placeBoard(blk, text, opts, !!linkedGroup);
}
function placeSchematic(blk: DesignBlock, text: string, opts: DbPlaceOpts, linked: boolean): boolean {
  const m = schMod(); if (!m) return false;
  if (opts.sheet && !linked) {
    // drawSheetFromDesignBlock: the sheet tool, its next sheet named after the block and filled with its schematic
    const arm = (): void => {
      const names = new Set<string>(); for (const it of E.kdoc!.items.values()) if (it.kind === "sheet") for (const c of it.node) if (Array.isArray(c) && c[0] === "property" && /^Sheet ?name$/i.test(String(c[1]))) names.add(String(c[2]));
      let sn = blk.id.name; if (names.has(sn)) { let n = 1; while (names.has(sn + n)) n++; sn = sn + n; }   // UniqueSheetName
      m.state.sheetPreset = { name: sn, file: blk.id.name + ".kicad_sch", armed: true, seed: text, fields: blk.fields, label: "Draw Sheet",
        group: opts.group ? { name: blk.id.name, libId: formatDbLibId(blk.id) } : null,
        after: (placed: boolean) => { if (placed && opts.repeated) { arm(); setTool("sheet"); } else if (placed) setTool("select"); } };
      setTool("sheet");
    };
    arm(); return true;
  }
  const place = (): boolean => {
    if (E.tool !== "select") setTool("select");
    return m._.pasteText(toolCtx(), text, { label: "Add Design Block", pasteMode: opts.keep ? "keep" : "reset", anchor: "designBlock",
      ...(opts.group ? { group: blk.id.name, groupLibId: formatDbLibId(blk.id) } : {}),
      after: (placed: boolean) => { if (placed && opts.repeated && !linked) place(); } });
  };
  return place();
}
function placeBoard(blk: DesignBlock, text: string, opts: DbPlaceOpts, linked: boolean): boolean {
  const T = pcbTools(); if (!T) return false;
  const place = (): boolean => {
    if (E.tool !== "select") setTool("select");
    const ok = T.placeBoardText(toolCtx(), text, { label: "Place Design Block", group: opts.group ? { name: blk.id.name, libId: formatDbLibId(blk.id) } : null,
      after: (placed: boolean) => { if (placed && opts.repeated && !linked) place(); } });
    return ok;
  };
  return place();
}
/** DESIGN_BLOCK_PANE::GetDesignBlock( libId, true, false, &err ) and the text of its board file, for
 *  PCB_CONTROL::ApplyDesignBlockLayout (pcbdialogs/multichannel.ts); the reason in its words when there is none. */
export async function designBlockBoard(libId: string): Promise<{ text: string } | { error: string }> {
  let blk: DesignBlock;
  if (!tableRows.length) tableRows = await readTable();   // the pane's libraries, though it was never opened
  try { blk = await libs.load(parseDbLibId(libId)); } catch (e) { return { error: (e as Error).message }; }
  if (!blk.pcbDoc) return { error: "the design block has no saved board layout" };
  try { return { text: await libs.text(blk.pcbDoc) }; } catch { return { error: "the design block's board file could not be read" }; }
}
/** SCH_EDITOR_CONTROL / PCB_CONTROL::PlaceLinkedDesignBlock: the block linked to the one selected group. */
export async function placeLinkedDesignBlock(): Promise<boolean> {
  const g = selectedLinkedGroup(); if (!g) return false;
  return placeDesignBlock(parseDbLibId(groupDesignBlockId(g.node)!), g);
}
/** SaveToLinkedDesignBlock: the pane selects the linked block, then Update Design Block from Selection runs. */
export async function saveToLinkedDesignBlock(): Promise<boolean> {
  const g = selectedLinkedGroup(); if (!g) return false;
  const id = parseDbLibId(groupDesignBlockId(g.node)!);
  const blk = await loadBlock(id); if (!blk) return false;
  if (!blockCache.size) await refreshLibs();
  selectNode(formatDbLibId(id));
  return updateDesignBlockFromSelection(id);
}

// ---------------------------------------------------------------- the pane's API and the handlers
export interface DesignBlocksApi {
  subscribe(fn: () => void): () => void;
  get(): DbPaneState;
  select(id: string | null): void;
  setOpt(k: keyof DbPlaceOpts, on: boolean): void;
  /** a block was chosen (double-click / Enter): placeDesignBlock */
  choose(id: string): void;
  /** a context menu row of the pane */
  run(action: string): void;
  /** the schematic or board text of a block, for the preview */
  text(id: string): Promise<{ kind: "sch" | "pcb"; text: string } | null>;
  refresh(): void;
}
const api: DesignBlocksApi = {
  subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  get: () => model,
  select: (id) => selectNode(id),
  setOpt,
  choose(id) { selectNode(id); void placeDesignBlock(parseDbLibId(id)); },
  run(action) {
    const cur = model.current ? parseDbLibId(model.current) : null;
    switch (action) {
      case "pinLibrary": if (cur) pinLibrary(cur.lib, true); break;
      case "unpinLibrary": if (cur) pinLibrary(cur.lib, false); break;
      case "newLibrary": void newLibrary(); break;
      case "hideLibraryTree": showPane("designblocks", false); break;
      default: { const h = handlers[action]; if (h) h(null); }
    }
  },
  async text(id) {
    const b = blockCache.get(id); if (!b) return null;
    const ed = editor(), doc = ed === "sch" ? b.schDoc : b.pcbDoc; if (!doc) return null;
    try { return { kind: ed, text: await libs.text(doc) }; } catch { return null; }
  },
  refresh: () => { void refreshLibs(); },
};

const handlers: Record<string, ActionHandler> = {
  showDesignBlockPanel: () => { showPane("designblocks"); void refreshLibs(); },
  // Preferences > Manage Design Block Libraries... (DIALOG_EDIT_LIBRARY_TABLES with PANEL_DESIGN_BLOCK_LIB_TABLE)
  showDesignBlockLibTable: () => { void libTables().then((m) => m.manageLibraries("designBlock", { readOnly: !!E.viewOnly, onSaved: () => { void refreshLibs(); } })); },
  placeDesignBlock: () => { void placeDesignBlock(); },
  placeLinkedDesignBlock: () => { void placeLinkedDesignBlock(); },
  saveToLinkedDesignBlock: () => { void saveToLinkedDesignBlock(); },
  saveSheetAsDesignBlock: () => { if (isSch()) void saveDocumentAsDesignBlock(); },
  saveBoardAsDesignBlock: () => { if (!isSch()) void saveDocumentAsDesignBlock(); },
  saveSelectionAsDesignBlock: () => { void saveSelectionAsDesignBlock(); },
  updateDesignBlockFromSheet: () => { if (isSch()) void updateDesignBlockFromDocument(); },
  updateDesignBlockFromBoard: () => { if (!isSch()) void updateDesignBlockFromDocument(); },
  updateDesignBlockFromSelection: () => { void updateDesignBlockFromSelection(); },
  deleteDesignBlock: () => { void deleteDesignBlock(); },
  editDesignBlockProperties: () => { void editDesignBlockProperties(); },
};

/** The design block actions into the editor's handler table, and window.KcDesignBlocks for the pane. */
export function installDesignBlocks(table: Record<string, ActionHandler>): void {
  Object.assign(table, handlers);
  (window as unknown as { KcDesignBlocks?: DesignBlocksApi }).KcDesignBlocks = api;
  window.dispatchEvent(new CustomEvent("kc-designblocks-ready"));
  window.addEventListener("kc-libtable-changed", (ev) => { const k = (ev as CustomEvent<{ kind?: string }>).detail; if (k && k.kind === "designBlock") void refreshLibs(); });
}
export { DbError };
