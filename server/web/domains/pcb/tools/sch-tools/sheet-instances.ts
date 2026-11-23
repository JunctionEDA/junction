// sheet-instances.ts — the symbol and sheet instance data a paste or a move writes into other sheets' files.
//
// A symbol keeps one (instances (project "name" (path "/root/…" (reference …) (unit …) …))) entry per sheet path it is
// shown on (SCH_SYMBOL::m_instances, SCH_SYMBOL_INSTANCE), a sheet one (path "/parent" (page …)) per path of the sheet
// it sits on.  Those entries live in the file of the sheet the item is on, so a paste of a sheet symbol, or a move
// that drops items or sheets into a sub-sheet, has to write other files as well:
//
//  * SCH_EDITOR_CONTROL::updatePastedSheet / updatePastedSymbol: every symbol of a pasted sheet's file (and of the
//    sheets below it) gets an instance for the new sheet path, copied from its instance on the path it was copied from
//    (KIID_PATH::EndsWith the clipboard path), else from its Reference field and unit; without kept annotations it is
//    cleared (SCH_SYMBOL::ClearAnnotation( path ): "R?") and the paste's annotation numbers it.
//  * SCH_MOVE_TOOL::moveSelectionToSheet keeps each moved item's instance list as it is.  What a save and the next load
//    make of it is written here at once: instances on paths that no longer exist go (the writer's orphan pruning in
//    SCH_IO_KICAD_SEXPR::saveSymbol), and each sheet path the item is now shown on that has none gets one
//    (SCH_SHEET_PATH::CheckForMissingSymbolInstances: the project's first instance, else the first, else the
//    Reference field and unit).
//
// The other files are read as they are now (`read`); every changed item is one MODIFIED change with its inverse, and
// the caller commits them with its own changes as one atomic commit over the documents (the server's op_multi).
import { K, kid, kids, str, uuidOf } from "./state";
import { deep, typeNameFor } from "./util";
import { dirName, joinPath, normSheetFile } from "./sheets";

/** A project schematic as read now: its document id, its project path and the document. */
export interface SheetFileDoc { docId: string; path: string; doc: KDoc }
/** Reads the schematic a Sheetfile names, relative to the project path `from` (null when the project has no such file). */
export type SheetReader = (file: string, from: string) => Promise<SheetFileDoc | null>;
/** One other document's part of the commit. */
export interface OtherDoc { docId: string; path: string; changes: KChange[]; inverse: KChange[] }

const sheetFileOf = (node: SNode): string => { const p = kids(node, "property").find((q) => /^Sheet ?file$/i.test(str(q[1]))); return p ? str(p[2]) : ""; };
const fieldRef = (node: SNode): string => { const p = kids(node, "property").find((q) => str(q[1]) === "Reference"); return p ? str(p[2]) : ""; };
const unitOf = (node: SNode): number => { const u = kid(node, "unit"); return u ? +u[1] || 1 : 1; };

/** An item's instance entries: the project they are filed under and the (path …) list itself. */
export function instanceEntries(node: SNode): { project: string; pa: SNode }[] {
  const out: { project: string; pa: SNode }[] = [];
  for (const inst of kids(node, "instances")) for (const pr of kids(inst, "project")) for (const pa of kids(pr, "path")) out.push({ project: str(pr[1]), pa });
  return out;
}
/** The instance entry on `path` (SCH_SYMBOL::GetInstance), or null. */
export function instanceOn(node: SNode, path: string): SNode | null { const e = instanceEntries(node).find((x) => str(x.pa[1]) === path); return e ? e.pa : null; }
/**
 * SCH_SYMBOL::AddHierarchicalReference: the entry `pa` (its path is pa[1]) in place of the one on that path, else
 * under the project group `project` (made when the item has none), kept in path order as the writer sorts them.
 */
export function putInstance(node: SNode, project: string, pa: SNode): void {
  const path = str(pa[1]);
  for (const inst of kids(node, "instances")) for (const pr of kids(inst, "project")) {
    const j = pr.findIndex((c, k) => k > 1 && Array.isArray(c) && c[0] === "path" && str(c[1]) === path);
    if (j > 0) pr.splice(j, 1);
  }
  let insts = kid(node, "instances");
  if (!insts) { insts = ["instances"]; node.push(insts); }
  let pr = kids(insts, "project").find((p) => str(p[1]) === project) || null;
  if (!pr) { pr = ["project", project]; insts.push(pr); }
  let at = pr.length; for (let k = 2; k < pr.length; k++) { const c = pr[k]; if (Array.isArray(c) && c[0] === "path" && str(c[1]) > path) { at = k; break; } }
  pr.splice(at, 0, pa);
}
/** Drop the instance entries whose path is in `gone` (and a project group left empty); true when any went. */
export function dropInstances(node: SNode, gone: (path: string) => boolean): boolean {
  let did = false;
  for (const inst of kids(node, "instances")) {
    for (const pr of kids(inst, "project")) for (let k = pr.length - 1; k > 1; k--) { const c = pr[k]; if (Array.isArray(c) && c[0] === "path" && gone(str(c[1]))) { pr.splice(k, 1); did = true; } }
    for (let k = inst.length - 1; k > 0; k--) { const c = inst[k]; if (Array.isArray(c) && c[0] === "project" && !kids(c as SNode, "path").length) inst.splice(k, 1); }
  }
  for (let k = node.length - 1; k > 0; k--) { const c = node[k]; if (Array.isArray(c) && c[0] === "instances" && c.length === 1) node.splice(k, 1); }
  return did;
}
/**
 * SCH_SHEET_PATH::CheckForMissingSymbolInstances for one item and one path: when the item has no entry there it gets
 * a copy of the project's first entry, else of its first, else (a symbol) the Reference field and unit.  True when added.
 */
export function addMissingInstance(node: SNode, path: string, project: string, was?: SNode | null): boolean {
  if (instanceOn(node, path)) return false;
  const all = instanceEntries(node), src = all.find((e) => e.project === project) || all[0] || null;
  let pa: SNode;
  if (src) { pa = deep(src.pa); pa[1] = path; }
  else if (node[0] === "symbol") pa = ["path", path, ["reference", fieldRef(node)], ["unit", unitOf(node)]];
  else if (was) { pa = deep(was); pa[1] = path; }   // a sheet keeps the page it had on the path that went
  else return false;
  putInstance(node, project, pa);
  return true;
}

/** The documents a commit writes, each read once, with the items it changed and how they were. */
class Touched {
  docs = new Map<string, { file: SheetFileDoc; before: Map<string, string> }>();
  constructor(private read: SheetReader) {}
  async get(file: string, from: string): Promise<SheetFileDoc | null> {
    const want = joinPath(dirName(from), normSheetFile(file));
    for (const d of this.docs.values()) if (d.file.path === want) return d.file;
    const f = await this.read(file, from); if (!f) return null;
    const had = this.docs.get(f.path); if (had) return had.file;
    this.docs.set(f.path, { file: f, before: new Map() });
    return f;
  }
  /** Note an item of `f` before it is changed (its first state is the inverse). */
  touch(f: SheetFileDoc, it: KItem): void { const d = this.docs.get(f.path)!; if (!d.before.has(it.id)) d.before.set(it.id, K.serializeItem(f.doc, it)); }
  result(): OtherDoc[] {
    const out: OtherDoc[] = [];
    for (const { file, before } of this.docs.values()) {
      if (!before.size) continue;
      const changes: KChange[] = [], inverse: KChange[] = [];
      for (const [id, was] of before) {
        const it = file.doc.items.get(id); if (!it) continue;
        const now = K.serializeItem(file.doc, it); if (now === was) continue;
        changes.push({ id, kind: "MODIFIED", typeName: typeNameFor(it), sexpr: now });
        inverse.push({ id, kind: "MODIFIED", typeName: typeNameFor(it), sexpr: was });
      }
      if (changes.length) out.push({ docId: file.docId, path: file.path, changes, inverse });
    }
    return out;
  }
}

/**
 * The instance data a move into `target` (a sheet symbol on the open sheet) writes:
 *  - the moved symbols and sheets (`nodes`, the copies the sub-sheet gets) gain an entry for every path the target's
 *    file is shown on (`targetPaths`) — written into the nodes, which the caller adds to the sub-sheet;
 *  - below each moved sheet, every item of its file and of the files under it loses the entries of the paths that went
 *    with the move (old path + the sheet + …) and gains the new ones (target path + the sheet + …).
 * `herePaths` are the paths the open sheet is shown on, `hereFile` its project path.  Returns the other files' changes.
 */
export async function moveInstanceChanges(read: SheetReader, o: { hereFile: string; herePaths: string[]; targetPaths: string[]; project: string; nodes: SNode[] }): Promise<OtherDoc[]> {
  const t = new Touched(read);
  for (const n of o.nodes) if (n[0] === "symbol" || n[0] === "sheet") for (const q of o.targetPaths) addMissingInstance(n, q, o.project);
  const walk = async (file: string, from: string, olds: string[], news: string[], depth: number): Promise<void> => {
    if (depth > 64) return;
    const f = await t.get(file, from); if (!f) return;
    const gone = new Set(olds);
    for (const it of f.doc.items.values()) {
      if (it.kind !== "symbol" && it.kind !== "sheet") continue;
      const node = deep(it.node), was = instanceEntries(node).find((e) => gone.has(str(e.pa[1])));
      let did = dropInstances(node, (p) => gone.has(p));
      for (const q of news) did = addMissingInstance(node, q, o.project, was ? was.pa : null) || did;
      if (did) { t.touch(f, it); it.node.splice(0, it.node.length, ...node); }
    }
    for (const it of Array.from(f.doc.items.values())) if (it.kind === "sheet") { const sub = sheetFileOf(it.node); if (sub) await walk(sub, f.path, olds.map((p) => p + "/" + it.id), news.map((p) => p + "/" + it.id), depth + 1); }
  };
  for (const n of o.nodes) {
    if (n[0] !== "sheet") continue;
    const file = sheetFileOf(n), id = uuidOf(n) || ""; if (!file || !id) continue;
    await walk(file, o.hereFile, o.herePaths.map((p) => p + "/" + id), o.targetPaths.map((p) => p + "/" + id), 0);
  }
  return t.result();
}

/** A sheet the paste added: its new id, the id it had where it was copied, its Sheetfile. */
export interface PastedSheet { id: string; clipId: string; file: string }
/** A symbol of a pasted sheet's file on one of the new sheet paths, for the paste's annotation (its entry there is set). */
export interface PastedSubSymbol { node: SNode; path: string; doc: KDoc }
/** SCH_SYMBOL::SetRef( path ) off the sheet on screen: the entry of that path only, the Reference field stays. */
export function setInstanceReference(node: SNode, path: string, ref: string): void { const pa = instanceOn(node, path), r = pa ? kid(pa, "reference") : null; if (r) r[1] = ref; }
/**
 * SCH_EDITOR_CONTROL::updatePastedSheet over every pasted sheet and every path of the sheet pasted into
 * (`herePaths`): each symbol of the sheet's file, and of the files below it, gets the instance of the new path
 * (updatePastedSymbol: a copy of the one whose path ends with the clipboard path, else the Reference field and unit;
 * cleared to "R?" unless `keep`).  `annotate` then numbers them (the paste's annotation, path by path in the order
 * KiCad walks them), setting each symbol's new entry (setInstanceReference).
 */
export async function pastedSheetInstanceChanges(read: SheetReader, o: { hereFile: string; herePaths: string[]; project: string; sheets: PastedSheet[]; keep: boolean; annotate(list: PastedSubSymbol[], path: string): void }): Promise<OtherDoc[]> {
  const t = new Touched(read);
  const update = async (file: string, from: string, sheetPath: string, clip: string[], depth: number): Promise<void> => {
    if (depth > 64) return;
    const f = await t.get(file, from); if (!f) return;
    const clipTail = "/" + clip.join("/"), list: PastedSubSymbol[] = [];
    for (const it of f.doc.items.values()) {
      if (it.kind !== "symbol") continue;
      const node = deep(it.node);
      const hit = instanceEntries(node).find((e) => str(e.pa[1]).endsWith(clipTail));
      const pa: SNode = hit ? deep(hit.pa) : ["path", sheetPath, ["reference", fieldRef(node)], ["unit", unitOf(node)]];
      pa[1] = sheetPath;
      if (!o.keep) { const r = kid(pa, "reference"); if (r) r[1] = str(r[1]).replace(/\?$/, "").replace(/\d+$/, "") + "?"; }   // ClearAnnotation( &path ): GetRefDesUnannotated
      putInstance(node, o.project, pa);
      t.touch(f, it); it.node.splice(0, it.node.length, ...node);
      list.push({ node: it.node, path: sheetPath, doc: f.doc });
    }
    if (list.length) o.annotate(list, sheetPath);
    for (const it of Array.from(f.doc.items.values())) if (it.kind === "sheet") { const sub = sheetFileOf(it.node); if (sub) await update(sub, f.path, sheetPath + "/" + it.id, clip.concat(it.id), depth + 1); }
  };
  for (const p of o.herePaths) for (const s of o.sheets) if (s.file) await update(s.file, o.hereFile, p + "/" + s.id, [s.clipId], 0);
  return t.result();
}
