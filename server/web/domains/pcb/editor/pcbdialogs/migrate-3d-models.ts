// pcbdialogs/migrate-3d-models — Tools > Migrate 3D Models... (GLOBAL_EDIT_TOOL::Migrate3DModels,
// DIALOG_MIGRATE_3D_MODELS): the board's VRML references that resolve to nothing on the left, the ranked STEP
// replacements of the highlighted one on the right with the footprint previewed holding the pick, the extra search
// directories below; "Replace Models" rewrites every footprint's matching references in one commit
// ("Migrate 3D Model References").  The matching is migrate-3d-models-logic.ts.
//
// The search paths here are what the server can reach: the project's files (${KIPRJMOD}) and KiCad's 3D library
// (${KICAD10_3DMODEL_DIR}, listed by /api/kicad-lib/index); an extra search directory is one of the project's folders,
// and "Add 3D Model File" picks a STEP file from KiCad's library, the project or the board's embedded files.
import { E } from "../state";
import { state } from "../appstore";
import { box, grid, h, iconButton, listDialog, messageBox, openDialog, type GridApi } from "./ui";
import { modelPreview, pick3DModel, whenGone, type PreviewApi } from "./model3d";
import { previewBoardText } from "../../library/model3d";
import { docFiles } from "../../dialogs/browse-cells";
import * as L from "./migrate-3d-models-logic";

const EXTRA_DIRS = "kicad.common.extra3DSearchDirs";   // COMMON_SETTINGS::m_Extra3DSearchDirs
const readDirs = (): string[] => { try { const v = JSON.parse(localStorage.getItem(EXTRA_DIRS) || "[]"); return Array.isArray(v) ? v.filter((d) => typeof d === "string") : []; } catch { return []; } };
const writeDirs = (d: string[]): void => { try { localStorage.setItem(EXTRA_DIRS, JSON.stringify(d)); } catch { /* the list lasts for this session */ } };

let kicadIndex: Promise<string[] | null> | null = null;
/** KiCad's 3D library's STEP models ("Library:Name"), or null when its server is out of reach. */
function kicadModels(): Promise<string[] | null> {
  if (!kicadIndex) kicadIndex = fetch("/api/kicad-lib/index?kind=model", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null)).then((j: { items?: unknown } | null) => (j && Array.isArray(j.items) ? (j.items as string[]) : null)).catch(() => null)
    .then((v) => { if (!v) kicadIndex = null; return v; });
  return kicadIndex;
}
const projectFiles = (): string[] => (state.project ? state.project.docs : []).filter((d) => d.docType === "model3d").map((d) => d.path);
const boardEmbedded = (doc: KDoc): string[] => { const ef = docFiles(doc); return ef ? KiCadCanvas.kids(ef, "file").map((f: SNode) => KiCadCanvas.str((KiCadCanvas.kid(f, "name") || [])[1])) : []; };

export async function migrate3DModels(ctx: ToolCtx): Promise<void> {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") return;
  const env: L.ResolveEnv = { projectFiles: projectFiles(), boardEmbedded: boardEmbedded(doc) };
  const byName = L.collectMissingWrlModels(doc.items.values(), env);
  const missing = [...byName.keys()], entries = [...byName.values()];
  let extraDirs = readDirs();
  let catalog: L.CatalogEntry[] = [], scanned = new Set<string>();
  let cands: L.Candidate[][] = missing.map(() => [{ absPath: "", display: L.KEEP_LABEL, score: 0 }]);
  let sel: number[] = missing.map(() => L.UNSPECIFIED);
  let models: string[] | null = null;
  let missingGrid: GridApi | null = null, candGrid: GridApi | null = null, dirGrid: GridApi | null = null, preview: PreviewApi | null = null;
  let status: HTMLElement | null = null;
  const thickness = Number((doc as { thickness?: number }).thickness) || 1.6;
  const src = (): L.CatalogSources => ({ projectFiles: env.projectFiles, kicadModels: models, extraDirs });

  // showPreview: the representative footprint, unflipped and unrotated, holding the candidate alone
  const showPreview = (i: number, abs: string): void => {
    if (!preview || i < 0 || i >= entries.length) return;
    const node = KiCadCanvas.parse(KiCadCanvas.serialize(entries[i].fp)) as SNode;
    const P = (window as unknown as { PcbTools?: { flipFootprintNode?(n: SNode): void; rotateFootprintNode?(n: SNode, d: number): void } }).PcbTools;
    const lay = KiCadCanvas.kid(node, "layer");
    if (lay && KiCadCanvas.str(lay[1]) === "B.Cu" && P && P.flipFootprintNode) P.flipFootprintNode(node);
    const rot = (KiCadCanvas.atOf(node) as [number, number, number])[2] || 0;
    if (rot && P && P.rotateFootprintNode) P.rotateFootprintNode(node, -rot);
    const at = KiCadCanvas.kid(node, "at"); if (at) at.splice(1, at.length - 1, 0, 0);
    const m = L.previewModel(abs, entries[i].xform);
    preview.update(previewBoardText(KiCadCanvas.serialize(node), m ? [m] : [], thickness));
  };
  const missingRows = (): Record<string, string>[] => missing.map((m) => ({ name: m }));
  const populateCandidates = (i: number): void => {
    if (!candGrid) return;
    if (i < 0 || i >= missing.length) { candGrid.setRows([]); return; }
    candGrid.setRows(cands[i].map((c) => ({ name: c.display })));
    const s = sel[i];
    if (s >= 0 && s < cands[i].length) { candGrid.select(s); showPreview(i, cands[i][s].absPath); }
    else if (cands[i].length) { candGrid.select(0); showPreview(i, cands[i][0].absPath); }
  };
  let populating = false;
  const refreshMissing = (): void => { if (missingGrid) missingGrid.refresh(); };
  const afterCatalogChange = (): void => {
    const r = L.rerank(missing, catalog, cands, sel); cands = r.cands; sel = r.sel;
    refreshMissing();
    populating = true; populateCandidates(missingGrid ? missingGrid.selected() : -1); populating = false;
  };
  const rebuild = (): void => { catalog = []; scanned = new Set(); for (const d of L.scanDirs(extraDirs)) L.scanDirectory(d, src(), catalog, scanned); };

  const api = openDialog({ title: "Migrate 3D Models", width: 1100, okLabel: "Replace Models", cancelLabel: "Cancel", noEnter: true,
    build(body) {
      missingGrid = grid([{ key: "name", label: "", type: "ro" }], missingRows(), { ro: true, height: "300px", key: "missingList",
        // References with no match (auto or override) are shown in bold
        rowClass: (_r, i) => (sel[i] < 0 ? "bold" : ""),
        onSelect: (i) => { populating = true; populateCandidates(i); populating = false; } });
      candGrid = grid([{ key: "name", label: "", type: "ro" }], [], { ro: true, height: "300px", key: "candidatesList",
        onSelect: (j) => {
          if (populating || !missingGrid) return;
          const i = missingGrid.selected(); if (i < 0 || i >= missing.length || j < 0 || j >= cands[i].length) return;
          const c = cands[i][j];
          sel[i] = c.absPath ? j : L.KEEP_EXISTING;
          refreshMissing(); missingGrid.select(i);
          showPreview(i, c.absPath);
        } });
      dirGrid = grid([{ key: "dir", label: "", type: "ro" }], extraDirs.map((d) => ({ dir: d })), { ro: true, height: "90px", key: "searchDirs", multi: true });
      preview = modelPreview({ key: "migratePreview", height: "300px" });
      const pv = preview; whenGone(body, () => pv.dispose());
      status = h("span", { class: "pd-note" }, "");
      const addFile = iconButton("plus", "Select a STEP model file from disk as a replacement", () => {
        const i = missingGrid ? missingGrid.selected() : -1; if (i < 0 || i >= missing.length) return;
        void pick3DModel({ projectFiles: env.projectFiles, embedded: [] }).then((p) => {
          if (!p) return;
          const abs = L.expandPath(p);
          if (!abs.startsWith("kicad-embed://") && !L.hasStepExtension(abs)) { messageBox("Select 3D Model File", `${L.fullName(abs)} is not a STEP model (${L.STEP_EXTENSIONS.map((e) => "*." + e).join(";")}).`); return; }
          const r = L.injectCandidate(cands[i], abs); cands[i] = r.cands; sel[i] = r.sel;
          refreshMissing(); populating = true; populateCandidates(i); populating = false;
        });
      });
      const addDir = iconButton("plus", "Add a directory to be included in the search for suitable 3D model replacement files", () => {
        const dirs = [...new Set(env.projectFiles.map((p) => p.split("/").slice(0, -1).join("/")))].sort();
        listDialog("Add 3D Model Search Directory", ["Directory"], dirs.map((d) => [d ? `${L.PROJECT_DIR}/${d}` : L.PROJECT_DIR]), (row) => {
          const chosen = row[0]; if (!chosen) return;
          if (dirGrid) dirGrid.setRows([...dirGrid.rows(), { dir: chosen }]);
          if (!extraDirs.includes(chosen)) { extraDirs.push(chosen); writeDirs(extraDirs); }
          L.scanDirectory(chosen, src(), catalog, scanned);
          afterCatalogChange();
        });
      });
      const delDir = iconButton("trash", "Remove the selected directory from the list.  Its contents will no longer be considered in the search for suitable replacements.", () => {
        if (!dirGrid) return;
        const rows = dirGrid.rows(), gone = new Set(dirGrid.selectedRows()); if (!gone.size) return;
        const deleted = rows.filter((_r, k) => gone.has(k)).map((r) => String(r.dir));
        dirGrid.setRows(rows.filter((_r, k) => !gone.has(k)));
        extraDirs = extraDirs.filter((d) => !deleted.includes(d)); writeDirs(extraDirs);
        rebuild(); afterCatalogChange();
      });
      body.append(
        h("div", { style: "font-weight:bold" }, "The board references VRML 3D models (*.wrl files) that are no longer present on your system."),
        h("div", { style: "font-style:italic;margin-top:4px" }, "KiCad will auto-select suitable STEP file matches from the configured 3D directories, plus any additional directories specified below.  "),
        h("div", { style: "font-style:italic" }, "Individual matches can be overridden in the Replacement list, either with another candidate from the search directories, or with a specific STEP model file."),
        h("div", { style: "display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px" },
          h("div", { style: "min-width:0" }, h("div", { class: "pd-lbl" }, "Missing 3D model references:"), missingGrid.el),
          h("div", { style: "min-width:0" }, h("div", { class: "pd-lbl" }, "Replacement:"), candGrid.el, h("div", { class: "pd-row" }, addFile)),
          h("div", { style: "min-width:0" }, h("div", { class: "pd-lbl" }, "Preview:"), h("div", { style: "height:300px;border:1px solid var(--line)" }, preview.el))),
        h("div", { style: "font-size:smaller;font-style:italic;margin-top:4px" }, "References with no match (auto or override) are shown in bold."),
        box("Extra 3D model search directories:", dirGrid.el, h("div", { class: "pd-row" }, addDir, delDir)),
        status);
      // TransferDataToWindow: the catalog, every row ranked, the top real candidate picked
      const fill = (): void => {
        rebuild();
        cands = missing.map((m) => L.rankCandidatesFor(m, catalog));
        sel = cands.map(L.autoSelect);
        refreshMissing();
        if (missing.length && missingGrid) missingGrid.select(0);
      };
      if (missing.length) {
        status.textContent = "Reading KiCad's 3D model library...";
        void kicadModels().then((m) => {
          models = m;
          if (status) status.textContent = m ? "" : "KiCad's 3D model library could not be reached: only the project's files are searched.";
          fill();
        });
      }
    },
    ok() {
      const repl = L.replacementsOf(missing, cands, sel);
      if (!repl.size) return true;   // Replace without a choice is Keep
      const { modified } = L.applyReplacements(doc.items.values(), repl, (n) => KiCadCanvas.parse(KiCadCanvas.serialize(n)) as SNode);
      const changes: KChange[] = [];
      for (const [id, node] of modified) { const it = doc.items.get(id); if (it) changes.push(KiCadCanvas.replaceChange(doc, { ...it, node })); }
      if (changes.length) ctx.commit(changes, "Migrate 3D Model References");
      return true;
    },
    cancel() { return true; } });
  if (!api) return;
}
