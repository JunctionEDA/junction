// rescue-symbols.ts — Tools > Rescue Symbols... (SCH_EDITOR_CONTROL::RescueSymbols, RESCUER::RescueProject and
// DIALOG_RESCUE_EACH, eeschema/project_rescue.cpp and eeschema/dialogs/dialog_rescue_each.cpp): the candidates
// editor/rescue-symbols-logic.ts finds, the "Project Rescue Helper" dialog with its Accept / Symbol Name / Action Taken
// list, the instances of the selected symbol and the cached and library symbols side by side; then the rescue library
// "<schematic>-rescue.kicad_sym" written with the chosen symbols, its project library table row, and every symbol of a
// rescued id relinked to it.
import { E } from "./state";
import { isSch, requestRender } from "./view";
import { grid, h, messageBox, openDialog, type GridApi } from "./pcbdialogs/ui";
import { toast } from "./util";
import { loadSheets, sheetDoc, sheetInstances } from "./panels/hierarchy";
import { submitDocOp } from "../dialogs/project";
import { appState } from "../dialogs/editor";
import { toolCtx } from "./tools";
import { rootSchematic } from "./doc";
import { saveTextDocument } from "./projectfile";
import { lookupLibraryItems } from "../library/lib-lookup";
import { renderSymbolPreview, clearPreview } from "../library/preview";
import { importSymbolLibraries } from "../symedit/dialogs";
import { parseLibTable, formatLibTable } from "../symedit/model";
import { relinkChange } from "./export-symbols-logic";
import { actionDescription, findRescues, instanceRows, legacySymbolNode, parseLegacyLibrary, removeDuplicates, rescueLibraryText, rescueSymbols, rescuedSymbol, type LSymbol, type RescueCandidate } from "./rescue-symbols-logic";

const TITLE = "Project Rescue Helper";
const K = (): KiCadCanvasApi => window.KiCadCanvas;
const docs = (): { docId: string; path: string; docType?: string }[] => (appState.docs || []) as { docId: string; path: string; docType?: string }[];
async function docText(path: string): Promise<string | null> {
  const d = docs().find((x) => x.path === path); if (!d) return null;
  const r = await fetch(`/api/docs/${encodeURIComponent(d.docId)}/content?v=${Date.now()}`, { credentials: "same-origin" });
  return r.ok ? r.text() : null;
}
const say = (msg: string, title = TITLE): Promise<void> => new Promise((resolve) => { if (!messageBox(title, msg, [{ label: "OK", fn: () => resolve() }])) resolve(); });

/** The project table's row of a nickname, with its type (LIBRARY_MANAGER::GetRow over the project table). */
async function tableRow(nick: string): Promise<{ uri: string; type: string } | null> {
  const t = await docText("sym-lib-table").catch(() => null); if (!t) return null;
  try { const row = parseLibTable(t).find((r) => r.nickname === nick); return row ? { uri: row.uri, type: row.type } : null; } catch { return null; }
}
const projectPathOf = (uri: string): string | null => (/^\$[{(]KIPRJMOD[})][\/\\]?/.test(uri) ? uri.replace(/^\$[{(]KIPRJMOD[})][\/\\]?/, "").replace(/\\/g, "/") : null);

/** SCH_EDITOR_CONTROL::RescueSymbols */
export async function rescueSymbolsTool(): Promise<void> {
  if (!isSch() || !E.kdoc) return;
  try { await loadSheets(); } catch { /* the sheets as last read */ }
  const rows = sheetInstances();
  const screens: { docId: string; doc: KDoc }[] = [];
  for (const r of rows) { const id = r.node.docId; if (!id || screens.some((s) => s.docId === id)) continue; const doc = sheetDoc(id); if (doc) screens.push({ docId: id, doc }); }
  const symbols = rescueSymbols(screens);

  // SCH_SCREENS::HasNoFullyDefinedLibIds: a schematic whose symbols name no library is rescued by LEGACY_RESCUER,
  // which needs the legacy project's .lib list and writes a legacy .lib; a .kicad_sch schematic here is remapped first
  if (symbols.length && symbols.every((s) => s.libId.indexOf(":") < 0)) {
    await say("This schematic's symbols name no library.  Run Remap Legacy Library Symbols first, then rescue its symbols.");
    return;
  }

  // GetRescueLibraryFileName: the root schematic's name with "-rescue"
  const root = rootSchematic();
  const rootPath = root ? root.path : (appState.project ? appState.project.name + ".kicad_sch" : "schematic.kicad_sch");
  const dir = rootPath.split("/").slice(0, -1);
  const stem = (rootPath.split("/").pop() || "").replace(/\.kicad_sch$/i, "");
  const rescueNick = stem + "-rescue";
  const rescuePath = dir.concat(rescueNick + ".kicad_sym").join("/");

  // LEGACY_SYMBOL_LIBS::LoadAllLibraries: the project's cache library ("<project>-cache.lib" and its .dcm)
  const proj = (docs().find((d) => /\.kicad_pro$/i.test(d.path)) || null);
  const projStem = proj ? proj.path.replace(/\.kicad_pro$/i, "") : dir.concat(stem).join("/");
  let cache: Map<string, LSymbol> | null = null;
  try {
    const lib = await docText(projStem + "-cache.lib");
    if (lib !== null) cache = parseLegacyLibrary(lib, await docText(projStem + "-cache.dcm"));
  } catch (e) { toast(`Symbol library '${projStem}-cache.lib' failed to load.`, 4000); cache = null; }
  const cacheNodes = new Map<string, SNode>();
  const cacheFind = (name: string): SNode | null => {
    if (!cache) return null;
    const s = cache.get(name); if (!s) return null;
    let n = cacheNodes.get(name); if (!n) { n = legacySymbolNode(s); cacheNodes.set(name, n); }
    return n;
  };

  let lookup;
  try { lookup = await lookupLibraryItems({ symbols: new Set(symbols.map((s) => s.libId)), footprints: [] }, docs()); }
  catch (e) { await say(`The symbol libraries could not be read: ${String((e as Error).message || e)}`); return; }
  const libFind = (id: string): { symbol: SNode | null; root: SNode | null } | null => { const l = lookup.symbols.get(id); return l ? { symbol: l.symbol, root: l.root || null } : null; };

  const all = findRescues(symbols, cacheFind, libFind, rescueNick);
  if (!all.length) { await say("This project has nothing to rescue."); return; }
  const cands = removeDuplicates(all);

  const instPath = (rows.find((r) => r.node.docId === appState.docId) || rows[0] || { instPath: "" }).instPath;
  const chosen = await rescueDialog(cands, symbols, instPath);
  if (!chosen.length) { await say("No symbols were rescued."); return; }
  if (E.viewOnly) { toast("View-only access"); return; }

  // RESCUER::DoRescues: PerformAction fails on a candidate found nowhere, and nothing is changed
  const added: SNode[] = [];
  for (const c of chosen) { const n = rescuedSymbol(c); if (!n) return; added.push(n); }

  // OpenRescueLibrary + WriteRescueLibrary: the library's earlier symbols kept, the new ones saved over them
  const row = await tableRow(rescueNick);
  let base = await docText(rescuePath).catch(() => null);
  if (row) {
    const p = projectPathOf(row.uri);
    if (p && p !== rescuePath) {
      const t = await docText(p).catch(() => null);
      if (t !== null) {
        try {
          if (/^legacy$/i.test(row.type)) { const l = parseLegacyLibrary(t, await docText(p.replace(/\.lib$/i, ".dcm"))); added.unshift(...Array.from(l.values()).map((s) => legacySymbolNode(s))); }
          else base = rescueLibraryText(base, Array.from(K().kids(K().parse(t) || [], "symbol")) as SNode[]);
        } catch { /* an unreadable library adds nothing */ }
      }
    }
  }
  const text = rescueLibraryText(base, added);
  const res = await importSymbolLibraries([{ path: rescuePath, text }]);
  if (res.failed.length) { await say(`Failed to save rescue library ${rescuePath}.`, "Error"); return; }
  // a legacy row of that name is pointed at the new library (uri ${KIPRJMOD}/<file>, type KiCad)
  if (row && /^legacy$/i.test(row.type)) {
    const t = docs().find((d) => d.path === "sym-lib-table");
    try {
      const old = t ? await docText("sym-lib-table") : null;
      if (t && old !== null) {
        const rs = parseLibTable(old);
        for (const r of rs) if (r.nickname === rescueNick) { r.uri = "${KIPRJMOD}/" + rescuePath; r.type = "KiCad"; }
        await saveTextDocument(t.docId, formatLibTable(rs, "sym_lib_table"), { id: "table", kind: "MODIFIED", typeName: "LIB_TABLE", properties: [] } as unknown as KChange);
      }
    } catch { await say("Error saving library table.", "File Save Error"); return; }
  }

  // PerformAction's SetLibId on every symbol of a rescued id, then UpdateSymbolLinks: the schematic's copy is the
  // rescued symbol under the new id.  KiCad clears the undo list after a rescue.
  const perDoc = new Map<string, KChange[]>();
  chosen.forEach((c, k) => {
    const name = c.newId.slice(c.newId.indexOf(":") + 1);
    for (const s of symbols) {
      if (s.libId !== c.requestedId) continue;
      const doc = sheetDoc(s.docId), it = doc ? doc.items.get(s.id) : null; if (!it) continue;
      const list = perDoc.get(s.docId) || []; perDoc.set(s.docId, list);
      list.push(relinkChange(it, { libId: c.newId, name, def: added[added.length - chosen.length + k], uses: [] }, rescueNick));
    }
  });
  for (const [docId, changes] of perDoc) {
    if (docId === appState.docId) { (toolCtx() as unknown as { commit(c: KChange[], label: string): void }).commit(changes, "Rescue Symbols"); continue; }
    try { await submitDocOp(docId, changes); } catch (e) { toast(`Could not update a sheet: ${(e as Error).message}`, 4000); }
  }
  requestRender();
}

/** DIALOG_RESCUE_EACH (from the menu: no "Never Show Again"): resolves with the accepted candidates, none on Skip Symbol Rescue. */
function rescueDialog(cands: RescueCandidate[], symbols: ReturnType<typeof rescueSymbols>, instPath: string): Promise<RescueCandidate[]> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: RescueCandidate[]): void => { if (!done) { done = true; resolve(v); } };
    let list: GridApi | null = null, inst: GridApi | null = null;
    const instTitle = h("div", { class: "pd-lbl", "data-k": "instances-title" }, "Instances of this symbol:");
    const oldCv = h("canvas", { width: 260, height: 200, "data-k": "preview-old", style: "width:100%;height:200px" }) as HTMLCanvasElement;
    const newCv = h("canvas", { width: 260, height: 200, "data-k": "preview-new", style: "width:100%;height:200px" }) as HTMLCanvasElement;
    const show = (row: number): void => {
      const c = cands[row < 0 ? 0 : row];
      // PopulateInstanceList
      const rows = instanceRows(symbols, c.requestedId, instPath);
      if (inst) inst.setRows(rows.map((r) => ({ c0: r[0], c1: r[1] })));
      instTitle.textContent = `Instances of this symbol (${rows.length} items):`;
      // displayItemsInConflict: the cached symbol and the library symbol in the candidate's unit and body style
      const draw = (cv: HTMLCanvasElement, n: SNode | null): void => {
        try { if (n) renderSymbolPreview(cv, c.requestedId, K().serialize(n), c.unit, c.bodyStyle); else clearPreview(cv, "symbol"); } catch { clearPreview(cv, "symbol"); }
      };
      draw(oldCv, c.cache); draw(newCv, c.lib);
    };
    const api = openDialog({ title: TITLE, width: 860, okLabel: "Rescue Symbols", cancelLabel: "Skip Symbol Rescue",
      build(body) {
        body.append(h("p", { style: "margin:0 0 8px;white-space:pre-wrap", "data-k": "prompt" },
          "This schematic was made using older symbol libraries which may break the schematic.  Some symbols may need to be linked to a different symbol name.  Some symbols may need to be \"rescued\" (copied and renamed) into a new library.\n\nThe following changes are recommended to update the project."));
        list = grid([{ key: "accept", label: "Accept", type: "check", width: "70px" }, { key: "name", label: "Symbol Name", type: "ro" }, { key: "action", label: "Action Taken", type: "ro" }],
          cands.map((c) => ({ accept: true, name: c.requestedId, action: actionDescription(c) })), { height: "180px", key: "conflicts", onSelect: (i) => show(i) });
        inst = grid([{ key: "c0", label: "Reference", type: "ro" }, { key: "c1", label: "Value", type: "ro" }], [], { ro: true, height: "120px", key: "instances" });
        body.append(h("div", { class: "pd-lbl" }, "Symbols to update:"), list.el, instTitle, inst.el,
          h("div", { style: "display:flex;gap:10px;margin-top:8px" },
            h("div", { style: "flex:1" }, h("div", { class: "pd-lbl" }, "Cached Symbol:"), oldCv),
            h("div", { style: "flex:1" }, h("div", { class: "pd-lbl" }, "Library Symbol:"), newCv)));
        list.select(0); show(0);
      },
      ok() { const rows = list ? list.rows() : []; finish(cands.filter((_c, i) => rows[i] && rows[i].accept === true)); },
      cancel() { finish([]); },
    });
    if (!api) finish([]);
  });
}
