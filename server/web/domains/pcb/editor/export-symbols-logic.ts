// export-symbols-logic.ts — File > Export > Symbols... (SCH_EDITOR_CONTROL::ExportSymbolsToLibrary,
// eeschema/tools/sch_editor_control.cpp) as plain functions over the parsed sheets (no DOM), so the node tests can run
// them; editor/export-symbols.ts is the dialog and the writes.
//
//   SCH_SHEET_LIST::GetSymbols( SYMBOL_FILTER_ALL or SYMBOL_FILTER_NON_POWER ) on every sheet instance: a symbol with
//   a library symbol (GetLibSymbolRef), power and '#' symbols left out unless "Include power symbols" is checked;
//   libSymbols[ LIB_ID ] keeps the first library symbol of each id (std::map: in LIB_ID order), symbolMap[ LIB_ID ]
//   every symbol using it.  Each one is saved flattened under its name (LIB_SYMBOL::GetName, the id's item name); with
//   "Update schematic symbols" each of those symbols takes the id with the target library's nickname.
import { libIsPower, symbolInstanceRef } from "./panels/search-model";

type N = SNode;
const K = (): KiCadCanvasApi => window.KiCadCanvas;
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/** One sheet instance: its document and its instance path (SCH_SHEET_PATH). */
export interface ExportSheet { docId: string; doc: KDoc; instPath: string }
/** One library symbol to export: its LIB_ID, the schematic's copy and the symbols that use it. */
export interface ExportSymbol { libId: string; name: string; def: N; uses: { docId: string; id: string }[] }

/** LIB_ID::Parse: the nickname before the first ':' and the item name after it (no ':' is an item name alone). */
export function splitLibId(id: string): { nick: string; item: string } {
  const at = id.indexOf(":");
  return at < 0 ? { nick: "", item: id } : { nick: id.slice(0, at), item: id.slice(at + 1) };
}
/** LIB_ID::compare: the nickname, then the item name (wxString::Cmp, case-sensitive). */
export function compareLibIds(a: string, b: string): number {
  const x = splitLibId(a), y = splitLibId(b);
  const c = x.nick < y.nick ? -1 : x.nick > y.nick ? 1 : 0;
  return c || (x.item < y.item ? -1 : x.item > y.item ? 1 : 0);
}
/** SCH_SYMBOL::GetLibSymbolRef: the schematic's library symbol of a placed symbol (lib_name first, as the cache keys it). */
export function libSymbolOf(doc: KDoc, sym: N): N | null {
  const libId = str((K().kid(sym, "lib_id") || [])[1]), libName = str((K().kid(sym, "lib_name") || [])[1]);
  return (K().resolveLib(doc, libName || libId) || (libName ? K().resolveLib(doc, libId) : null)) as N | null;
}
/** matchesSymbolFilter( SYMBOL_FILTER_NON_POWER ): a power symbol, or a reference starting with '#', is a pseudo-symbol. */
export function isPseudoSymbol(def: N, sym: N, instPath: string): boolean {
  const ref = symbolInstanceRef(sym, instPath).ref;
  return libIsPower(def) || (ref !== "" && ref[0] === "#");
}

/** The library symbols to export, in LIB_ID order, each with every symbol (once per document item) that uses it. */
export function collectExportSymbols(sheets: ExportSheet[], savePowerSymbols: boolean): ExportSymbol[] {
  const byId = new Map<string, ExportSymbol>();
  for (const s of sheets) {
    for (const it of s.doc.items.values()) {
      if (it.kind !== "symbol") continue;
      const def = libSymbolOf(s.doc, it.node); if (!def) continue;           // orphans are not in the list
      if (!savePowerSymbols && isPseudoSymbol(def, it.node, s.instPath)) continue;
      // the cached LIB_SYMBOL's LIB_ID is its name in lib_symbols (SCH_IO_KICAD_SEXPR_PARSER::parseLibSymbol)
      const libId = str(def[1]);
      let e = byId.get(libId);
      if (!e) { e = { libId, name: splitLibId(libId).item, def, uses: [] }; byId.set(libId, e); }
      if (!e.uses.some((u) => u.docId === s.docId && u.id === it.id)) e.uses.push({ docId: s.docId, id: it.id });
    }
  }
  return Array.from(byId.values()).sort((a, b) => compareLibIds(a.libId, b.libId));
}

/** LIB_SYMBOL::Flatten of the schematic's copy (already flat: the cache holds root symbols) under its own name. */
export function exportedSymbolText(e: ExportSymbol): string {
  const n = K().cloneNode(e.def) as N;
  n[1] = e.name;
  return K().serialize(n);
}

/**
 * The "Update schematic symbols to link to exported symbols" edit of one symbol: SetLibId( id with the target's
 * nickname ).  Without a lib_name the schematic's library symbol is keyed by that id (GetSchSymbolLibraryName), so it
 * goes into lib_symbols under the new id with the change; with one it stays under the lib_name.
 */
export function relinkChange(item: KItem, e: ExportSymbol, targetLib: string): KChange {
  const node = K().cloneNode(item.node) as N;
  const newId = `${targetLib}:${e.name}`;
  const lid = K().kid(node, "lib_id") as N | null;
  if (lid) lid[1] = newId; else node.splice(1, 0, ["lib_id", newId]);
  const libName = str((K().kid(node, "lib_name") || [])[1]);
  if (libName) return { id: item.id, kind: "MODIFIED", typeName: "SCH_SYMBOL", sexpr: K().serialize(node) } as unknown as KChange;
  const lib = K().cloneNode(e.def) as N; lib[1] = newId;
  return { id: item.id, kind: "MODIFIED", typeName: "SCH_SYMBOL", sexpr: "(lib_symbols " + K().serialize(lib) + ") " + K().serialize(node) } as unknown as KChange;
}

/** SCH_BASE_FRAME::GetLibraryItemsForListDialog: Library / Description rows, the pinned ones first (with the pin mark), each group in StrNumCmp order. */
export const PIN_MARK = "☆ ";
export function libraryRows(libs: { name: string; description: string }[], pinned: Set<string>, cmp: (a: string, b: string) => number): string[][] {
  const on = libs.filter((l) => pinned.has(l.name)).sort((a, b) => cmp(a.name, b.name)).map((l) => [PIN_MARK + l.name, l.description]);
  const off = libs.filter((l) => !pinned.has(l.name)).sort((a, b) => cmp(a.name, b.name)).map((l) => [l.name, l.description]);
  return [...on, ...off];
}
/** EDA_LIST_DIALOG::GetTextSelection: the first column without the pin mark. */
export function selectedLibrary(row: string[] | null): string {
  const t = row ? str(row[0]) : "";
  return t.startsWith(PIN_MARK) ? t.slice(PIN_MARK.length) : t;
}
