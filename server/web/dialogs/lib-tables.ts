// dialogs/lib-tables.ts — Preferences → Manage Symbol Libraries… / Manage Footprint Libraries… (PANEL_SYM_LIB_TABLE,
// PANEL_FP_LIB_TABLE in DIALOG_EDIT_LIBRARY_TABLES) and Preferences → Configure Paths… (DIALOG_CONFIGURE_PATHS) for
// the schematic and board editors and Assign Footprints.
//
// The two tables of the web editor: the global one is the set of KiCad libraries the server provides (read-only,
// like a global table the user cannot write), the project one is the project's sym-lib-table / fp-lib-table file,
// edited in a grid (Active, Visible, Nickname, Library Path, Library Format, Options, Description) with KiCad's add,
// remove and move buttons and its nickname checks.  The paths the tables are written against are the server's:
// Configure Paths lists them as KiCad lists variables set outside the program, which it shows but does not edit.
import { E, api, appState } from "./editor";
import { KD, h, type GridApi, type GridColumn, type NotebookApi } from "./dom";
import { messageBox } from "./sch-items";
import { saveTextDocument } from "../editor/projectfile";
import { officialLibraries } from "../library/sources";
import { formatLibTable, parseLibTable, verifyLibTable, type LibTableRow } from "../symedit/model";

type Kind = "symbol" | "footprint";
const META: Record<Kind, { title: string; file: string; root: string; dir: string; ext: string }> = {
  symbol: { title: "Symbol Libraries", file: "sym-lib-table", root: "sym_lib_table", dir: "KICAD10_SYMBOL_DIR", ext: ".kicad_sym" },
  footprint: { title: "Footprint Libraries", file: "fp-lib-table", root: "fp_lib_table", dir: "KICAD10_FOOTPRINT_DIR", ext: ".pretty" },
};
/** The path variables the server resolves, as Configure Paths and the tables' "Available path substitutions" show them. */
export const PATH_VARS: { name: string; value: string }[] = [
  { name: "KICAD10_3DMODEL_DIR", value: "(the KiCad 3D models this server provides)" },
  { name: "KICAD10_FOOTPRINT_DIR", value: "(the KiCad footprint libraries this server provides)" },
  { name: "KICAD10_SYMBOL_DIR", value: "(the KiCad symbol libraries this server provides)" },
  { name: "KICAD_COLLAB_3DMODELS", value: "(3D models of vendor parts, fetched on use)" },
  { name: "KIPRJMOD", value: "(the project folder)" },
];

async function firstSnapshot(docId: string, text: string): Promise<boolean> {
  try { const r = await fetch(`/api/docs/${docId}/snapshots?seq=0`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: text }); if (r.ok) return true; } catch { /* fall through */ }
  return saveTextDocument(docId, text, { id: "table", kind: "MODIFIED", typeName: "LIB_TABLE", properties: [] } as unknown as KChange);
}

/** ACTIONS::showSymbolLibTable / showFootprintLibTable. */
export async function openLibTable(kind: Kind): Promise<void> {
  const m = META[kind], proj = appState.project, ro = !!E.viewOnly || !proj;
  const table = proj ? proj.docs.find((d) => d.path === m.file) : undefined;
  let oldText = "";
  if (table) { try { const r = await fetch(`/api/docs/${table.docId}/content?v=${Date.now()}`, { credentials: "same-origin" }); if (r.ok) oldText = await r.text(); } catch { /* an empty table */ } }
  const projRows: LibTableRow[] = oldText ? parseLibTable(oldText) : [];
  let globalRows: LibTableRow[] = [];
  try { globalRows = (await officialLibraries(kind)).libraries.map((l) => ({ enabled: true, visible: true, nickname: l.name, uri: "${" + m.dir + "}/" + l.name + m.ext, type: "KiCad", options: "", descr: l.description || "" })); } catch { globalRows = []; }
  const cols = (readOnly: boolean): GridColumn<LibTableRow>[] => ([
    { key: "enabled", label: "Active", type: "bool", width: 50 }, { key: "visible", label: "Visible", type: "bool", width: 50 },
    { key: "nickname", label: "Nickname", width: 170 }, { key: "uri", label: "Library Path", width: 320 },
    { key: "type", label: "Library Format", type: "choice", options: (r: LibTableRow) => { const o = kind === "symbol" ? ["KiCad", "Legacy", "Database", "Table"] : ["KiCad", "Eagle", "Legacy", "GEDA/PCB", "Table"]; return o.includes(r.type) ? o : [...o, r.type]; }, width: 110 },
    { key: "options", label: "Options", width: 70 }, { key: "descr", label: "Description", width: 220 },
  ] as GridColumn<LibTableRow>[]).map((c) => (readOnly ? { ...c, ro: () => true } : c));
  let nb: NotebookApi | null = null, projGrid: GridApi<LibTableRow> | null = null;
  KD().open({
    title: m.title, width: 1000, cls: "kd-wide", readOnly: ro, geomKey: "lib-table-" + kind,
    build(body) {
      nb = KD().notebook(body, [
        { label: "Global Libraries", build(pg) { KD().grid(pg, cols(true), globalRows, { readOnly: true, height: 320 }); } },
        { label: "Project Specific Libraries", build(pg) {
          projGrid = KD().grid(pg, cols(ro), projRows, { readOnly: ro, height: 320, buttons: ro ? undefined : { add: () => ({ enabled: true, visible: true, nickname: "", uri: "", type: "KiCad", options: "", descr: "" }), addTitle: "Add empty row to table", remove: true, removeTitle: "Remove library from table", move: true } });
          if (!proj) pg.append(h("div", { class: "kd-note", style: "margin-top:6px" }, "Open a project to edit its library table."));
        } },
      ], { selected: proj ? 1 : 0 });
      const subs = KD().staticBox(body, "Available path substitutions:");
      KD().grid(subs, [{ key: "name", label: "Name", type: "ro", width: 220 }, { key: "value", label: "Value", type: "ro", width: 560 }],
        PATH_VARS.filter((v) => v.name === m.dir || v.name === "KIPRJMOD"), { readOnly: true, height: 70 });
    },
    ok() {
      if (ro || !proj) return true;
      const v = verifyLibTable(projRows);
      if (v.error) { if (nb) nb.select(1); if (projGrid && v.row !== undefined) projGrid.select(v.row); void messageBox(v.error, "Library Nickname Error"); return false; }
      projRows.splice(0, projRows.length, ...v.rows); if (projGrid) projGrid.refresh();
      if (JSON.stringify(oldText ? parseLibTable(oldText) : []) === JSON.stringify(v.rows)) return true;
      const text = formatLibTable(v.rows, m.root);
      void (async () => {
        try {
          if (table) { if (!(await saveTextDocument(table.docId, text, { id: "table", kind: "MODIFIED", typeName: "LIB_TABLE", properties: [] } as unknown as KChange))) throw new Error("not saved"); }
          else {
            const d = await api(`/api/projects/${proj.projectId}/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: m.file }) }) as { docId: string; path: string; docType: string };
            if (!(await firstSnapshot(d.docId, text))) throw new Error("not saved");
            proj.docs.push({ docId: d.docId, path: d.path, docType: d.docType || "lib_table" });
          }
          window.dispatchEvent(new CustomEvent("kc-lib-table", { detail: { kind } }));
        } catch (e) { await messageBox("Error saving project library table:\n\n" + (e as Error).message, "File Save Error"); }
      })();
      return true;
    },
  });
}

/** ACTIONS::configurePaths: the Environment Variables grid.  Every path here is set by the server, which KiCad shows
 *  as a variable "defined externally to the running process": listed, not editable. */
export function openConfigurePaths(): void {
  KD().open({
    title: "Configure Paths", width: 760, geomKey: "configure-paths", buttons: [{ label: "Close", close: true, primary: true, isDefault: true }],
    build(body) {
      const box = KD().staticBox(body, "Environment Variables");
      KD().grid(box, [{ key: "name", label: "Name", type: "ro", width: 230 }, { key: "value", label: "Path", type: "ro", width: 470 }], PATH_VARS.slice(), { readOnly: true, height: 190 });
      body.append(h("p", { class: "kd-note", id: "kd-paths-note", style: "margin:8px 2px 0" },
        "These paths are defined by the Junction server, outside the editor, and cannot be changed here. Library tables and 3D model references written with them resolve the same way in the desktop app, where the variables point at the local KiCad install."));
    },
  });
}
