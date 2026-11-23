// export-symbols.ts — File > Export > Symbols... (SCH_EDITOR_CONTROL::ExportSymbolsToLibrary): SelectLibrary's
// "Export Symbols" list with its two checkboxes and New Library..., then every library symbol the schematic uses
// saved into the chosen library, and with "Update schematic symbols" the symbols relinked to it in one commit per
// sheet ("Update Library Identifiers").  The library is a project .kicad_sym document (symedit/libdoc.ts): the symbols
// go in as one op and the library is saved (SCH_IO_KICAD_SEXPR::SaveSymbol writes the file).
import { E } from "./state";
import { isSch, requestRender } from "./view";
import { listDialog, messageBox } from "./pcbdialogs/ui";
import { toast } from "./util";
import { loadSheets, sheetDoc, sheetInstances } from "./panels/hierarchy";
import { submitDocOp } from "../dialogs/project";
import { appState, pushUndoFor } from "../dialogs/editor";
import { promptText } from "../dialogs/dom";
import { toolCtx } from "./tools";
import { officialLibraries, projectLibraries } from "../library/sources";
import { loadPinnedLibs } from "../library/pinned";
import { strNumCmpNoCase } from "../library/core";
import { libDocFor } from "../symedit/libdoc";
import { NEW_LIBRARY_TEXT } from "../symedit/model";
import { importSymbolLibraries } from "../symedit/dialogs";
import { collectExportSymbols, exportedSymbolText, libraryRows, relinkChange, selectedLibrary, type ExportSheet } from "./export-symbols-logic";

const TITLE = "Export Symbols";
/** PROJECT::SCH_LIB_SELECT: the library last chosen in SelectLibrary, preselected next time. */
let lastLib = "";
const docs = () => appState.docs || [];

/** SCH_BASE_FRAME::SelectLibrary: resolves with the chosen library (empty on Cancel); the checkboxes take the user's choice on OK. */
function selectLibrary(title: string, listLabel: string, checks: { label: string; value: boolean }[]): Promise<string> {
  return new Promise((resolve) => {
    void (async () => {
      let official: { name: string; description: string }[] = [];
      try { official = (await officialLibraries("symbol")).libraries; } catch { /* the project's libraries only */ }
      const project = projectLibraries("symbol", docs()).map((l) => ({ name: l.name, description: "" }));
      const names = new Set(project.map((l) => l.name));
      const libs = [...project, ...official.filter((l) => !names.has(l.name))];
      const rows = libraryRows(libs, loadPinnedLibs("symbol"), strNumCmpNoCase);
      let done = false;
      const finish = (v: string): void => { if (!done) { done = true; resolve(v); } };
      const api = listDialog(title, ["Library", "Description"], rows, () => { /* onOk below */ }, {
        select: (rows.find((r) => selectedLibrary(r) === lastLib) || [""])[0], width: 520, listLabel, checks,
        extra: [{ label: "New Library...", fn: () => { done = true; if (api) api.close(); done = false; void newLibrary().then(() => selectLibrary(title, listLabel, checks).then(finish)); } }],
        onOk: (row) => { const lib = selectedLibrary(row); lastLib = lib; finish(lib); },
        onCancel: () => finish(""),
      });
      if (!api) finish("");
    })();
  });
}

/** ID_MAKE_NEW_LIBRARY: a new project .kicad_sym (Create New Library) with its sym-lib-table row; SelectLibrary shows again after. */
async function newLibrary(): Promise<void> {
  if (E.viewOnly || !appState.project) { toast("You can view this project but not change it"); return; }
  const nm = await promptText("Create New Library", "File name:", ""); if (nm === null) return;
  const nick = nm.trim().replace(/\.kicad_sym$/i, "");
  if (!nick || /[\\/:]/.test(nick)) { messageBox(TITLE, "Illegal character found in library name."); return; }
  if (projectLibraries("symbol", docs()).some((l) => l.name === nick)) { messageBox(TITLE, `Library '${nick}' already exists.`); return; }
  const res = await importSymbolLibraries([{ path: nick + ".kicad_sym", text: NEW_LIBRARY_TEXT }]);
  if (!res.added.length) messageBox(TITLE, `Could not add library '${nick}'.`);
}

/** SCH_EDITOR_CONTROL::ExportSymbolsToLibrary */
export async function exportSymbolsToLibrary(): Promise<void> {
  if (!isSch() || !E.kdoc) return;
  const savePower = { label: "Include power symbols in export", value: false };
  const map = { label: "Update schematic symbols to link to exported symbols", value: false };
  const targetLib = await selectLibrary(TITLE, "Export symbols to library:", [savePower, map]);
  if (!targetLib) return;

  // BuildSheetListSortedByPageNumbers + GetSymbols
  try { await loadSheets(); } catch { /* the sheets as last read */ }
  const sheets: ExportSheet[] = [];
  for (const inst of sheetInstances()) {
    const docId = inst.node.docId; if (!docId) continue;
    const doc = sheetDoc(docId); if (doc) sheets.push({ docId, doc, instPath: inst.instPath });
  }
  const list = collectExportSymbols(sheets, savePower.value);

  // adapter->GetRow( targetLib ) and the plugin's SaveSymbol
  const lib = projectLibraries("symbol", docs()).find((l) => l.name === targetLib);
  const file = lib && lib.docs[0];
  const fail = (name: string, why: string): void => { messageBox(TITLE, `Error saving symbol ${name} to library '${targetLib}'.\n\n${why}`); };
  if (!list.length) return;
  if (!file) { fail(list[0].name, `Library '${targetLib}' is read only.`); return; }
  const ld = libDocFor(file.docId, file.path, targetLib);
  try { await ld.whenLoaded(); } catch { /* reported below */ }
  if (ld.error || !ld.canEdit) { fail(list[0].name, ld.error || `Library '${targetLib}' is read only.`); return; }
  try {
    await ld.commit(list.map((e): [string, string] => [e.name, exportedSymbolText(e)]));
    if (!(await ld.save())) throw new Error(`Could not save library '${targetLib}'.`);
  } catch (e) { fail(list[list.length - 1].name, String((e as Error).message || e)); return; }

  if (!map.value) return;
  if (E.viewOnly) { toast("View-only access"); return; }
  // commit.Modify + SetLibId for every symbol of each exported id, one commit ("Update Library Identifiers")
  const perDoc = new Map<string, { changes: KChange[]; inverse: KChange[] }>();
  for (const e of list) {
    for (const u of e.uses) {
      const doc = sheetDoc(u.docId), it = doc ? doc.items.get(u.id) : null; if (!doc || !it) continue;
      const acc = perDoc.get(u.docId) || { changes: [], inverse: [] }; perDoc.set(u.docId, acc);
      acc.inverse.push(KiCadCanvas.replaceChange(doc, it));
      acc.changes.push(relinkChange(it, e, targetLib));
    }
  }
  const label = "Update Library Identifiers";
  for (const [docId, acc] of perDoc) {
    if (docId === appState.docId) { (toolCtx() as unknown as { commit(c: KChange[], label: string): void }).commit(acc.changes, label); continue; }
    try { await submitDocOp(docId, acc.changes); pushUndoFor(docId, { label, changes: acc.changes, inverse: acc.inverse }); }
    catch (e) { toast(`Could not update a sheet: ${(e as Error).message}`, 4000); }
  }
  requestRender();
}
