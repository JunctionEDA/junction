// library/design-blocks.ts — KiCad's design block libraries over the project's files (DESIGN_BLOCK_IO,
// DESIGN_BLOCK_LIBRARY_ADAPTER, DESIGN_BLOCK_IO_MGR), without any DOM.
//
//   table      the project's design-block-lib-table (LIBRARY_TABLE with "(design_block_lib_table"); this server provides
//              no global design block libraries, so the global table is empty and every library is a project library
//   library    a "<nick>.kicad_blocks" folder; each design block is a "<name>.kicad_block" folder in it holding
//              "<name>.kicad_sch", "<name>.kicad_pcb" and the "<name>.json" metadata (description, keywords, fields)
//   enumerate  DesignBlockEnumerate: the "*.kicad_block" folders of the library (a block exists while one of its files
//              does: the project stores files, not folders)
//   save       DesignBlockSave: the schematic / board copied in under the block's name, then the metadata written as
//              nlohmann's dump( 0 ) prints it
//   delete     DesignBlockDelete: every file of the block's folder; DeleteLibrary: every block of the library
// Reading and writing the files is the caller's (DbStore): the editor binds it to the project's documents.

/** LIB_ID of a design block: "<nickname>:<name>" (LIB_ID::Format / GetUniStringLibId). */
export interface DbLibId { lib: string; name: string }
export const formatDbLibId = (id: DbLibId): string => (id.lib ? id.lib + ":" + id.name : id.name);
/** LIB_ID::Parse: the nickname is everything before the first ':'. */
export function parseDbLibId(s: string): DbLibId { const i = s.indexOf(":"); return i < 0 ? { lib: "", name: s } : { lib: s.slice(0, i), name: s.slice(i + 1) }; }

/** One DESIGN_BLOCK as the library reads it. */
export interface DesignBlock {
  id: DbLibId;
  description: string;
  keywords: string;
  /** m_fields: an ordered map, name -> value */
  fields: [string, string][];
  /** the schematic / board / metadata documents of the block, when it has them */
  schDoc: string | null;
  pcbDoc: string | null;
  jsonDoc: string | null;
}

/** One row of the design block library table as the pane shows it. */
export interface DbLibrary { nick: string; descr: string; uri: string; enabled: boolean; visible: boolean; type: string; options: string;
  /** the project folder of the library ("lib/x.kicad_blocks"), null for a path outside the project */
  path: string | null }

/** What a library is read from and written to: the project's documents. */
export interface DbDoc { docId: string; path: string; docType?: string }
export interface DbStore {
  docs(): DbDoc[];
  read(docId: string): Promise<string>;
  /** a new project file with this content: its document id, null when it could not be made */
  create(path: string, text: string): Promise<string | null>;
  write(docId: string, text: string): Promise<boolean>;
  remove(docId: string): Promise<boolean>;
  /** the project cannot be changed (a view-only visitor) */
  readOnly(): boolean;
}

export const DB_TABLE_FILE = "design-block-lib-table";
export const DB_LIB_EXT = "kicad_blocks";
export const DB_EXT = "kicad_block";

// ---------------------------------------------------------------- the table
interface TableRow { nickname: string; uri: string; type: string; options: string; descr: string; enabled: boolean; visible: boolean }
/** The project-relative folder of a ${KIPRJMOD} uri, null for one outside the project. */
export function projectFolder(uri: string): string | null {
  const m = /^\$\{KIPRJMOD\}\/?(.*)$/.exec(uri.trim().replace(/\\/g, "/")); if (!m) return null;
  return m[1].replace(/^\.\//, "").replace(/\/+$/, "");
}
/** LIBRARY_MANAGER::Rows( DESIGN_BLOCK ): the table's rows as libraries (disabled ones included; the caller filters). */
export function librariesOf(rows: TableRow[]): DbLibrary[] {
  return rows.map((r) => ({ nick: r.nickname, descr: r.descr, uri: r.uri, enabled: r.enabled, visible: r.visible, type: r.type, options: r.options, path: projectFolder(r.uri) }));
}

// ---------------------------------------------------------------- the folders
/** A file of a design block: its library folder, block name and kind. */
export function blockFileOf(path: string): { lib: string; name: string; kind: "sch" | "pcb" | "json" | null } | null {
  const m = /^(.*)\/([^/]+)\.kicad_block\/([^/]+)$/.exec(path); if (!m) return null;
  const file = m[3], kind = /\.kicad_sch$/i.test(file) ? "sch" : /\.kicad_pcb$/i.test(file) ? "pcb" : /\.json$/i.test(file) ? "json" : null;
  return { lib: m[1], name: m[2], kind };
}
/** DESIGN_BLOCK_IO::DesignBlockEnumerate: the block folders of a library folder, by name, with their files. */
export function enumerateBlocks(docs: DbDoc[], libPath: string): Map<string, { sch: DbDoc | null; pcb: DbDoc | null; json: DbDoc | null; files: DbDoc[] }> {
  const out = new Map<string, { sch: DbDoc | null; pcb: DbDoc | null; json: DbDoc | null; files: DbDoc[] }>();
  for (const d of docs) {
    const f = blockFileOf(d.path); if (!f || f.lib !== libPath) continue;
    let e = out.get(f.name); if (!e) { e = { sch: null, pcb: null, json: null, files: [] }; out.set(f.name, e); }
    e.files.push(d);
    // DesignBlockLoad reads "<name>.kicad_sch" / ".kicad_pcb" / ".json" by the block's own name
    const base = d.path.slice(d.path.lastIndexOf("/") + 1);
    if (f.kind && base === f.name + "." + (f.kind === "sch" ? "kicad_sch" : f.kind === "pcb" ? "kicad_pcb" : "json")) e[f.kind] = d;
  }
  return out;
}
/** The folder of a block: "<lib>/<name>.kicad_block". */
export const blockFolder = (libPath: string, name: string): string => (libPath ? libPath + "/" : "") + name + "." + DB_EXT;
export const blockFile = (libPath: string, name: string, ext: "kicad_sch" | "kicad_pcb" | "json"): string => blockFolder(libPath, name) + "/" + name + "." + ext;

// ---------------------------------------------------------------- the metadata
/** nlohmann::ordered_json::dump( 0 ): a newline after every '{' and ',', none of indentation; {} for an empty object. */
export function metadataText(description: string, keywords: string, fields: [string, string][]): string {
  const obj = (entries: [string, string][]): string => (entries.length ? "{\n" + entries.map(([k, v]) => JSON.stringify(k) + ": " + v).join(",\n") + "\n}" : "{}");
  const flds = obj(fields.map(([k, v]) => [k, JSON.stringify(v)] as [string, string]));
  return obj([["description", JSON.stringify(description)], ["keywords", JSON.stringify(keywords)], ["fields", flds]]);
}
/** DesignBlockLoad's JSON reading: description, keywords and the "fields" object, in their order. */
export function parseMetadata(text: string): { description: string; keywords: string; fields: [string, string][] } {
  const j = JSON.parse(text) as { description?: unknown; keywords?: unknown; fields?: Record<string, unknown> };
  const asStr = (v: unknown): string => { if (typeof v !== "string") throw new Error("not a string"); return v; };
  return {
    description: j.description !== undefined ? asStr(j.description) : "",
    keywords: j.keywords !== undefined ? asStr(j.keywords) : "",
    fields: j.fields && typeof j.fields === "object" ? Object.entries(j.fields).map(([k, v]) => [k, asStr(v)] as [string, string]) : [],
  };
}

// ---------------------------------------------------------------- the adapter
export class DbError extends Error {}

/** DESIGN_BLOCK_LIBRARY_ADAPTER over a DbStore and the project's table rows. */
export class DesignBlockLibs {
  constructor(public store: DbStore, public libs: () => DbLibrary[]) {}
  library(nick: string): DbLibrary | null { return this.libs().find((l) => l.nick === nick) || null; }
  /** DESIGN_BLOCK_IO::IsLibraryWritable: a project library, and the project may be changed. */
  isWritable(nick: string): boolean { const l = this.library(nick); return !!l && l.path !== null && !this.store.readOnly(); }
  private libPath(nick: string): string {
    const l = this.library(nick); if (!l) throw new DbError(`Library '${nick}' not found.`);
    if (l.path === null) throw new DbError(`Design block library folder '${l.uri}' could not be opened.`);
    return l.path;
  }
  /** DesignBlockEnumerate: the names, in the library's own order (the tree sorts them). */
  names(nick: string): string[] { const l = this.library(nick); return l && l.path !== null ? [...enumerateBlocks(this.store.docs(), l.path).keys()] : []; }
  exists(nick: string, name: string): boolean { const l = this.library(nick); return !!l && l.path !== null && enumerateBlocks(this.store.docs(), l.path).has(name); }
  /** DESIGN_BLOCK_IO::DesignBlockLoad: "Design block '%s' does not exist in library '%s'." when the folder is not there. */
  async load(id: DbLibId): Promise<DesignBlock> {
    const path = this.libPath(id.lib);
    const e = enumerateBlocks(this.store.docs(), path).get(id.name);
    if (!e) throw new DbError(`Design block '${id.name}' does not exist in library '${path}'.`);
    const out: DesignBlock = { id: { lib: id.lib, name: id.name }, description: "", keywords: "", fields: [], schDoc: e.sch ? e.sch.docId : null, pcbDoc: e.pcb ? e.pcb.docId : null, jsonDoc: e.json ? e.json.docId : null };
    if (e.json) {
      try { const m = parseMetadata(await this.store.read(e.json.docId)); out.description = m.description; out.keywords = m.keywords; out.fields = m.fields; }
      catch (err) { throw new DbError(`Design block metadata file '${e.json.path}' could not be read.`); }
    }
    return out;
  }
  /** All the blocks of a library with their metadata (GetDesignBlocks), unreadable ones left out. */
  async blocks(nick: string): Promise<DesignBlock[]> {
    const out: DesignBlock[] = [];
    for (const n of this.names(nick)) { try { out.push(await this.load({ lib: nick, name: n })); } catch (e) { /* GetDesignBlocks skips what it cannot load */ } }
    return out;
  }
  /** The text of a block's schematic or board. */
  async text(docId: string): Promise<string> { return this.store.read(docId); }
  /**
   * DESIGN_BLOCK_IO::DesignBlockSave: the block needs a valid LIB_ID and a schematic or a board; the files take the
   * block's name, a file given as null is kept as it is, and the metadata is always written.
   */
  async save(block: { id: DbLibId; description: string; keywords: string; fields: [string, string][] }, files: { sch?: string | null; pcb?: string | null }): Promise<void> {
    if (!block.id.name || /[\\:/]/.test(block.id.name)) throw new DbError("Design block does not have a valid library ID.");
    const path = this.libPath(block.id.lib);
    const have = enumerateBlocks(this.store.docs(), path).get(block.id.name);
    if (files.sch == null && files.pcb == null && !(have && (have.sch || have.pcb))) throw new DbError("Design block does not have a schematic or board file.");
    const put = async (ext: "kicad_sch" | "kicad_pcb" | "json", text: string, doc: DbDoc | null | undefined, what: string): Promise<void> => {
      const target = blockFile(path, block.id.name, ext);
      if (doc) { if (!(await this.store.write(doc.docId, text))) throw new DbError(what.replace("%s", target)); return; }
      if (!(await this.store.create(target, text))) throw new DbError(what.replace("%s", target));
    };
    if (files.sch != null) await put("kicad_sch", files.sch, have && have.sch, "Schematic file could not be saved as design block at '%s'.");
    if (files.pcb != null) await put("kicad_pcb", files.pcb, have && have.pcb, "Board file could not be saved as design block at '%s'.");
    await put("json", metadataText(block.description, block.keywords, block.fields), have && have.json, "Design block metadata file '%s' could not be saved.");
  }
  /** DESIGN_BLOCK_IO::DesignBlockDelete: the whole folder. */
  async remove(id: DbLibId): Promise<void> {
    const path = this.libPath(id.lib);
    const e = enumerateBlocks(this.store.docs(), path).get(id.name);
    if (!e) throw new DbError(`Design block '${id.name}.${DB_EXT}' does not exist.`);
    for (const f of e.files) if (!(await this.store.remove(f.docId))) throw new DbError(`Design block folder '${blockFolder(path, id.name)}' could not be deleted.`);
  }
  /** DESIGN_BLOCK_IO::DeleteLibrary: every block folder of the library, then the library itself. */
  async removeLibrary(nick: string): Promise<boolean> {
    const l = this.library(nick); if (!l || l.path === null) return false;
    const files = this.store.docs().filter((d) => d.path.startsWith(l.path + "/"));
    // "Design block folders should only contain sub-folders for each design block"
    const stray = files.find((d) => !blockFileOf(d.path) || blockFileOf(d.path)!.lib !== l.path);
    if (stray) throw new DbError(stray.path.slice(l.path.length + 1).includes("/") ? `Unexpected folder '${stray.path.slice(0, stray.path.lastIndexOf("/"))}' found in library path '${l.path}'.` : `Library folder '${l.path}' has unexpected files.`);
    for (const f of files) if (!(await this.store.remove(f.docId))) throw new DbError(`Design block library '${l.path}' cannot be deleted.`);
    return true;
  }
}

// ---------------------------------------------------------------- the tree's info and search
const escHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** DESIGN_BLOCK_TREE_MODEL_ADAPTER::GenerateInfo: the name, description, keywords and the field table, as HTML. */
export function blockInfoHtml(b: DesignBlock): string {
  let desc = escHtml(b.description).replace(/\n/g, "<br>");
  desc = desc.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');   // LinkifyHTML
  return "<b>" + escHtml(b.id.name) + "</b>" + (desc ? "<br>" + desc : "") + (b.keywords ? "<br>Keywords: " + escHtml(b.keywords) : "")
    + "<hr><table border=0>" + b.fields.map(([k, v]) => "<tr>   <td><b>" + escHtml(k) + "</b></td>   <td>" + escHtml(v) + "</td></tr>").join("") + "</table>";
}

/**
 * DIALOG_DESIGN_BLOCK_PROPERTIES::TransferDataFromWindow / TransferDataFromGrid: an illegal name character (LIB_ID's
 * and '/'), then the field names (stripped, newlines dropped, double spaces made single) must be unique.
 */
export function validateProperties(name: string, fields: [string, string][]): { error?: string; fields: [string, string][] } {
  const bad = [...name].find((c) => c < " " || c === "\\" || c === ":" || c === "/");
  if (bad !== undefined) return { error: `Illegal character '${bad}' in name '${name}'.`, fields };
  const out: [string, string][] = [];
  for (const [k, v] of fields) {
    let n = k.trim().replace(/\n/g, "");
    while (n.includes("  ")) n = n.replace(/ {2}/g, " ");
    if (out.some(([o]) => o === n)) return { error: "Duplicate fields are not allowed.", fields };
    out.push([n, v]);
  }
  return { fields: out };
}

// ---------------------------------------------------------------- the pane's context menu
/** What the pane's context menu conditions read (DESIGN_BLOCK_CONTROL::getCurrentTreeNode and the frame's selection). */
export interface DbTreeCtx {
  /** the current tree node is a library (TYPE::LIBRARY) */
  isLibrary: boolean;
  /** the current tree node is a design block (TYPE::ITEM) */
  isDesignBlock: boolean;
  /** the current library node is pinned */
  pinned: boolean;
  /** !GetCurrentSelection().Empty() on the canvas */
  hasSelection: boolean;
}
/**
 * The Design Blocks pane's CONDITIONAL_MENU: DESIGN_BLOCK_CONTROL::AddContextMenuItems (pin / unpin at 1, New
 * Library, the separators at 2 and 400, Hide Library Tree) with SCH_DESIGN_BLOCK_CONTROL::Init's or
 * PCB_DESIGN_BLOCK_CONTROL::Init's rows at 50 and 100.  Rows whose condition is false are left out, separators
 * collapse.  The entries are the action ids of the editor (sheet / board).
 */
export function designBlockTreeMenu(editor: "sch" | "pcb", c: DbTreeCtx): string[] {
  const inLib = c.isLibrary || c.isDesignBlock, isDb = c.isDesignBlock;
  const rows: [number, string, boolean][] = [];
  const add = (order: number, id: string, cond = true): void => { rows.push([order, id, cond]); };
  add(1, "pinLibrary", c.isLibrary && !c.pinned); add(1, "unpinLibrary", c.isLibrary && c.pinned); add(1, "newLibrary");
  add(2, "-"); add(400, "-"); add(400, "hideLibraryTree");
  add(50, "placeDesignBlock", isDb); add(50, "-");
  add(100, "editDesignBlockProperties", isDb);
  add(100, editor === "sch" ? "saveSheetAsDesignBlock" : "saveBoardAsDesignBlock", inLib);
  add(100, "saveSelectionAsDesignBlock", inLib && c.hasSelection);
  add(100, editor === "sch" ? "updateDesignBlockFromSheet" : "updateDesignBlockFromBoard", isDb);
  add(100, "updateDesignBlockFromSelection", isDb && c.hasSelection);
  add(100, "deleteDesignBlock", isDb);
  add(100, "-");
  const sorted = rows.map((r, i) => [r, i] as const).sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]).filter(([r]) => r[2]).map(([r]) => r[1]);
  const out: string[] = [];
  for (const r of sorted) { if (r === "-" && (!out.length || out[out.length - 1] === "-")) continue; out.push(r); }
  while (out.length && out[out.length - 1] === "-") out.pop();
  return out;
}

/** PANEL_DESIGN_BLOCK_CHOOSER::addDesignBlockToHistory: the id goes first, duplicates go, and the list keeps under 8. */
export function addToHistory(list: string[], id: string): string[] {
  const out = [id, ...list.filter((x) => x !== id)];
  while (out.length >= 8) out.pop();
  return out;
}

/** The checkboxes of the pane (APP_SETTINGS_BASE::m_DesignBlockChooserPanel), with KiCad's defaults. */
export interface DbPlaceOpts { repeated: boolean; group: boolean; sheet: boolean; keep: boolean }
export const DB_PLACE_DEFAULTS: DbPlaceOpts = { repeated: false, group: true, sheet: false, keep: false };

/** The group linked to a design block: its LIB_ID ((lib_id "...") of a group node), null when it has none. */
export function groupDesignBlockId(node: SNode): string | null {
  for (let i = 2; i < node.length; i++) { const c = node[i]; if (Array.isArray(c) && c[0] === "lib_id") { const v = String(c[1] ?? ""); return v || null; } }
  return null;
}
