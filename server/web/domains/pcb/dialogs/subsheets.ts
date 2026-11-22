// dialogs/subsheets.ts — the sub-sheet documents the open schematic's sheet symbols name, for the schematic tools that
// look into them (Place Sheet Pins' importHierLabel, the ERC's sheet pin / hierarchical label checks).  A sheet's file
// is found beside the open page (else by file name among the project's schematics), read with readDoc and cached by
// the sheet's Sheetfile; every read refreshes the cache entry, so a later use sees the sub-sheet as it is now.
// The editor's toolCtx reaches it through E.hooks.loadSheetDoc (the editor modules do not import the dialogs).
import { readDoc, submitDocOp } from "./project";
import { E, appState, pushUndoFor, undoStack } from "./editor";
import { messageBox } from "./sch-items";
import type { DocEntry } from "../../../shared/store";
import { subSheetDocs } from "../editor/subsheets";

/** The project document a sheet symbol on the open page names, or null. */
export function sheetDocEntry(sheet: KItem): DocEntry | null {
  const st = appState as unknown as { docs: DocEntry[] | null; docId: string | null };
  const docs = (st.docs || []) as DocEntry[], here = docs.find((d) => d.docId === st.docId);
  const dir = here ? here.path.split("/").slice(0, -1).join("/") : "", f = sheet.file || "";
  if (!f) return null;
  const path = dir ? `${dir}/${f}` : f, all = docs.filter((d) => d.docType === "kicad_sch");
  return all.find((d) => d.path === path) || all.find((d) => d.path.split("/").pop() === f.split("/").pop()) || null;
}

/** Read the sub-sheet a sheet symbol names (null when the project has no such file or it cannot be read). */
export async function loadSheetDoc(sheet: KItem): Promise<KDoc | null> {
  const entry = sheetDocEntry(sheet); if (!entry) return null;
  try { const d = await readDoc(entry.docId, "kicad_sch"); if (sheet.file) subSheetDocs.set(sheet.file, d); return d; } catch (e) { return null; }
}

/**
 * SCH_MOVE_TOOL::moveSelectionToSheet, the destination side: the sub-sheet is read as it is now, `build` makes the
 * changes that add the dropped items to it (it sees the sub-sheet's items for the overlap stepping), they are
 * submitted to that document and folded into the undo step the open sheet's commit just pushed, so one Undo takes the
 * items out of the sub-sheet and puts them back on this one.
 */
export function dropIntoSheet(sheet: KItem, label: string, build: (sub: KDoc) => KChange[]): void {
  const entry = sheetDocEntry(sheet); if (!entry || E.viewOnly) return;
  const step = undoStack[undoStack.length - 1] || null;
  void (async () => {
    try {
      const sub = await readDoc(entry.docId, "kicad_sch"), changes = build(sub); if (!changes.length) return;
      const inverse: KChange[] = changes.map((c) => ({ id: c.id, kind: "REMOVED", typeName: c.typeName, properties: [] }));
      await submitDocOp(entry.docId, changes);
      if (sheet.file) subSheetDocs.delete(sheet.file);                 // the cached copy is stale now
      const replay = (which: KChange[]) => () => { submitDocOp(entry.docId, which).catch(() => { void messageBox(`Could not update '${entry.path}'.`); }); };
      if (step && undoStack.includes(step)) Object.assign(step, { undoOthers: replay(inverse), redoOthers: replay(changes) });
      else pushUndoFor(String(appState.docId || ""), { label, changes: [], inverse: [], undoOthers: replay(inverse), redoOthers: replay(changes) });
    } catch (err) { void messageBox(`Could not move the items into '${entry.path}'.`); }
  })();
}

/** Called once by installDialogs: the tool context's loadSheetDoc and dropIntoSheet go through these hooks. */
export function installSubSheets(): void { const h = (E as unknown as { hooks: Record<string, unknown> }).hooks; h.loadSheetDoc = loadSheetDoc; h.dropIntoSheet = dropIntoSheet; }
