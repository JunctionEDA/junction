// dialogs/fields-table.ts — Tools → Symbol Fields Table (Bulk Edit Symbol Fields…) and Generate Bill of Materials…:
// eeschema/dialogs/dialog_symbol_fields_table.cpp over common/dialogs/dialog_fields_table_base.  One dialog, two tabs:
// "Edit" (the grouped, filterable grid; a cell edit applies to every symbol of its row) and "Export" (the BOM:
// delimiters, format presets, preview, Export downloads the file).  The field list on the left sets each column's
// BOM name, whether it is included and whether rows group by it; view presets are KiCad's built-ins plus the project's.
import { bitmapButton } from "../../../shared/components/kicon-dom";
import { E, appState, toast, toolCtx, cloneNode } from "./editor";
import { KD, checkbox, download, h, popupMenu, promptFields, promptText, select, textInput, unsavedChangesBox, type GridApi, type GridColumn } from "./dom";
import { messageBox } from "./sch-items";
import { clearVariantSymbol, setVariantSymbol } from "./change-symbols";
import { datasheetButton, docFiles, footprintButton } from "./browse-cells";
import { commonChooserFilters, type FpChooserFilters } from "../library/fpchoice";
import { fieldNamesAreDuplicates } from "./sch-items-logic";
import { resolvedFieldTemplates } from "./field-templates";
import { ATTR_FIELDS, BOM_FMT_PRESETS, BOM_PRESETS, ITEM_NO, QTY, bomExport, bomRows, canSortBy, cursorColumn, moveColumn, fieldDisplayName, fieldNames, groupByError, removeFieldError, renameFieldCheck, renameFieldError, renameRowField, str, symbolRows, withAllFields, type BomField, type BomFilterScope, type BomFmt, type BomPreset, type BomRow, type SymRow } from "./logic";
import { loadProject, obj, projectDocs, projectName, readDoc, saveProject, sub, submitDocOp, type Json, type JsonObj } from "./project";
import { listDialog, messageBox as buttonBox } from "../editor/pcbdialogs/ui";
import { openDocId, pushUndoFor, store } from "./editor";
import { variantDocView, variantEditNode } from "./variant-edits";
import * as VM from "../canvas/variant-model";
import { currentSheetPath, setCurrentVariant, variantNamesForUI } from "../editor/variant";
import { suffixRefEditing } from "../editor/schnets";
import { addVariant, type VariantPrompts, fieldsTableCopyVariant, fieldsTableDeleteVariant, fieldsTableEditVariantDescription, fieldsTableRenameVariant } from "../editor/variant-ops";
/** DIALOG_SYMBOL_FIELDS_TABLE::SetupColumnProperties: the symbols' fields, then "any templateFieldNames which aren't
 *  already present" (hidden, not grouped: withAllFields adds new names that way). */
function tableFieldNames(rows: SymRow[]): string[] {
  const names = fieldNames(rows);
  for (const t of resolvedFieldTemplates()) if (!names.includes(t.name)) names.push(t.name);
  return names;
}

/** The variant dialogs stacked over the table (KiCad opens them as children of the table). */
const stackedPrompts: VariantPrompts = {
  text: (title, message, value) => promptText(title, message, value),
  nameDesc: async (title, withName, desc0) => {
    const r = await promptFields(title, [...(withName ? [{ key: "variant-name", label: "Variant name:" }] : []), { key: "variant-desc", label: withName ? "Description (optional):" : "Description:", initial: desc0, multiline: true }]);
    return r ? { name: r["variant-name"] || "", desc: r["variant-desc"] || "" } : null;
  },
};
// DIALOG_FIELDS_TABLE's variant buttons: KiCad's small_plus / small_edit / copy / text / small_trash bitmaps
const V_ICONS: Record<string, string> = { plus: "small_plus", edit: "small_edit", copy: "copy", text: "text", trash: "small_trash" };

interface Member { docId: string; id: string }
interface Row extends SymRow { members: Member[] }
type GRow = Record<string, string | boolean | BomRow> & { _g: BomRow };
const S = appState;
const UNSAVED = "(unsaved)", SAVE = "Save preset...", DELETE = "Delete preset...";
type Scope = "Entire Project" | "Current Sheet Only" | "Current Sheet and Down" | "Selection";
const SCOPES: Scope[] = ["Entire Project", "Current Sheet Only", "Current Sheet and Down", "Selection"];
const FLAG_NODE: Record<string, [string, boolean]> = { dnp: ["dnp", true], excludeBom: ["in_bom", false], excludeBoard: ["on_board", false], excludeSim: ["exclude_from_sim", true], excludePos: ["in_pos_files", false] };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function presetFromJson(j: Json | undefined): BomPreset | null {
  const o = obj(j); if (!Array.isArray(o.fields_ordered) || !o.fields_ordered.length) return null;
  return { name: str(o.name), fields_ordered: (o.fields_ordered as JsonObj[]).map((f) => ({ name: str(f.name), label: str(f.label), show: !!f.show, group_by: !!f.group_by })), sort_field: str(o.sort_field), sort_asc: o.sort_asc !== false,
    filter_string: str(o.filter_string), filter_scope: o.filter_scope === "visible" || o.filter_scope === "all" ? o.filter_scope : "reference", group_symbols: o.group_symbols !== false, exclude_dnp: !!o.exclude_dnp, include_excluded_from_bom: !!o.include_excluded_from_bom };
}
function fmtFromJson(j: Json | undefined): BomFmt | null {
  const o = obj(j); if (typeof o.field_delimiter !== "string") return null;
  return { name: str(o.name), field_delimiter: str(o.field_delimiter), string_delimiter: str(o.string_delimiter), ref_delimiter: str(o.ref_delimiter), ref_range_delimiter: str(o.ref_range_delimiter), keep_tabs: !!o.keep_tabs, keep_line_breaks: !!o.keep_line_breaks, include_bom: !!o.include_bom };
}
const presetJson = (p: BomPreset): JsonObj => ({ exclude_dnp: p.exclude_dnp, fields_ordered: p.fields_ordered.map((f) => ({ group_by: f.group_by, label: f.label, name: f.name, show: f.show })), filter_string: p.filter_string, filter_scope: p.filter_scope || "reference", group_symbols: p.group_symbols, include_excluded_from_bom: p.include_excluded_from_bom, name: p.name, sort_asc: p.sort_asc, sort_field: p.sort_field });
const fmtJson = (f: BomFmt): JsonObj => ({ field_delimiter: f.field_delimiter, keep_line_breaks: f.keep_line_breaks, keep_tabs: f.keep_tabs, name: f.name, ref_delimiter: f.ref_delimiter, ref_range_delimiter: f.ref_range_delimiter, string_delimiter: f.string_delimiter });
/** The sheets a sheet file reaches through its (sheet …) items, itself included. */
function sheetAndDown(docs: Map<string, KDoc>, docId: string): Set<string> {
  const all = projectDocs().filter((d) => d.docType === "kicad_sch"), out = new Set<string>([docId]), queue = [docId];
  while (queue.length) {
    const id = queue.pop()!, d = docs.get(id), entry = all.find((x) => x.docId === id); if (!d || !entry) continue;
    const dir = entry.path.split("/").slice(0, -1).join("/");
    for (const it of d.items.values()) { if (it.kind !== "sheet" || !it.file) continue; const path = dir ? `${dir}/${it.file}` : it.file;
      const sub = all.find((x) => x.path === path) || all.find((x) => x.path.split("/").pop() === it.file!.split("/").pop()); if (sub && !out.has(sub.docId)) { out.add(sub.docId); queue.push(sub.docId); } }
  }
  return out;
}

// m_filterScope's choices, in BOM_FILTER_SCOPE order
const FILTER_SCOPES: [BomFilterScope, string][] = [["reference", "References"], ["visible", "Visible"], ["all", "All"]];
/** EESCHEMA_SETTINGS field_editor.selection_mode: 0 highlight, 1 select, 2 neither on cross-probe. */
function crossProbeMode(): number { try { const v = Number(localStorage.getItem("kui.fieldsTable.selectionMode")); return v === 1 || v === 2 ? v : 0; } catch { return 0; } }
function setCrossProbeMode(v: number): void { try { localStorage.setItem("kui.fieldsTable.selectionMode", String(v)); } catch { /* private window */ } }

/** IsOK( this, message ): "Confirmation" with Yes / No; No and Escape are false. */
const isOK = (message: string): Promise<boolean> => new Promise((resolve) => { buttonBox("Confirmation", message, [{ label: "No", fn: () => resolve(false) }, { label: "Yes", fn: () => resolve(true) }], 0); });
/** OKOrCancelDialog( nullptr, warning, message, "", "OK", "Cancel" ). */
const okOrCancel = (warning: string, message: string): Promise<boolean> => new Promise((resolve) => { buttonBox(warning, message, [{ label: "Cancel", fn: () => resolve(false) }, { label: "OK", fn: () => resolve(true) }], 0); });
/** EESCHEMA_SETTINGS m_FieldEditorPanel.sidebar_collapsed, kept per browser. */
function sidebarCollapsed(): boolean { try { return localStorage.getItem("kui.fieldsTable.sidebarCollapsed") === "1"; } catch { return false; } }
function setSidebarCollapsed(on: boolean): void { try { localStorage.setItem("kui.fieldsTable.sidebarCollapsed", on ? "1" : "0"); } catch { /* private window */ } }

/** wxGrid::GoToCell( row, col ): the cursor on that cell (its editor focused) and the cell scrolled into view. */
function goToCell(g: GridApi<GRow>, row: number): void {
  const key = cursorColumn(g.columns.map((c) => c.key)); if (!key) return;
  const col = g.columns.findIndex((c) => c.key === key);
  const td = g.el.querySelectorAll("tbody tr")[row]?.querySelectorAll("td")[col] as HTMLElement | undefined; if (!td) return;
  td.scrollIntoView({ block: "nearest", inline: "nearest" });
  const ed = td.querySelector<HTMLElement>("input, k-select"); if (ed) setTimeout(() => ed.focus(), 0);
}
export function openFieldsTable(exportTab = false): void {
  if (!E.kdoc) return;
  const ro = !!E.viewOnly, here = S.docId || "", docs = new Map<string, KDoc>([[here, E.kdoc as KDoc]]);
  // the Selection scope follows the schematic's selection while the dialog is open (OnSchSelectionChanged)
  const selectionNow = (): Set<string> => { const s = new Set<string>(E.selection as Set<string>); if (E.selected) s.add(E.selected.id); return s; };
  let selection = selectionNow();
  let onExportTab = exportTab;
  let rows: Row[] = [], scope: Scope = "Entire Project", loading = false;
  let preset: BomPreset = clone(BOM_PRESETS[0]), presetName = BOM_PRESETS[0].name, userPresets: BomPreset[] = [];
  let fmt: BomFmt = clone(BOM_FMT_PRESETS[0]), fmtName = BOM_FMT_PRESETS[0].name, userFmts: BomFmt[] = [], outFile = "${PROJECTNAME}.csv";
  let dirtySettings = false;
  // the table's variant follows the schematic's current one; edits are staged per variant and Apply writes them all
  let variant = String((E as { currentVariant?: string }).currentVariant || "");
  const edits = new Map<string, { m: Member; variant: string; values: Record<string, string>; flags: Record<string, boolean>; remove?: Set<string>; present?: Set<string> }>();
  const editKey = (m: Member, v = variant): string => v + "\u0001" + m.docId + "\u0000" + m.id;
  const editOf = (m: Member) => { const k = editKey(m); let e = edits.get(k); if (!e) { e = { m, variant, values: {}, flags: {} }; edits.set(k, e); } return e; };
  let fieldGrid: GridApi<BomField> | null = null, grid: GridApi<GRow> | null = null, gridHost: HTMLElement | null = null, previewEl: HTMLTextAreaElement | null = null, presetSel: HTMLSelectElement | null = null, fmtSel: HTMLSelectElement | null = null, countEl: HTMLElement | null = null;
  const fmtInputs: Record<string, HTMLInputElement> = {}; let syncBar: () => void = () => {};

  // the open sheet's symbols read and write the instance on screen (GetCurrentSheet()); another sheet's, its first
  const herePath = currentSheetPath();
  const pathOf = (docId: string): string | null => (docId === here ? herePath : null);
  const buildRows = () => {
    // Selection: the selected symbols, and every symbol of the sheets a selected sheet reaches (getSheetSymbolReferences)
    const selSheets = new Set<string>();
    if (scope === "Selection") {
      const hd = docs.get(here), all = projectDocs().filter((x) => x.docType === "kicad_sch"), entry = all.find((x) => x.docId === here), dir = entry ? entry.path.split("/").slice(0, -1).join("/") : "";
      if (hd) for (const it of hd.items.values()) {
        if (it.kind !== "sheet" || !it.file || !selection.has(it.id)) continue;
        const path = dir ? `${dir}/${it.file}` : it.file, subDoc = all.find((x) => x.path === path) || all.find((x) => x.path.split("/").pop() === it.file!.split("/").pop());
        if (subDoc) for (const id of sheetAndDown(docs, subDoc.docId)) selSheets.add(id);
      }
    }
    const use = scope === "Current Sheet Only" ? new Set([here]) : scope === "Selection" ? new Set([here, ...selSheets]) : scope === "Current Sheet and Down" ? sheetAndDown(docs, here) : new Set(docs.keys());
    const byRef = new Map<string, Row>(), out: Row[] = [];
    // "Don't add power symbols": !IsMissingLibSymbol() && IsPower()
    const powerIn = (d: KDoc) => (it: KItem): boolean => {
      const hp = (CollabTools.sch as unknown as { _?: { isPowerSymbol?(doc: KDoc, libId: string): boolean } } | undefined)?._;
      const ln = KiCadCanvas.kid(it.node, "lib_name") || KiCadCanvas.kid(it.node, "lib_id"), name = ln ? KiCadCanvas.str(ln[1]) : "";
      if (!hp || !hp.isPowerSymbol || !name || !KiCadCanvas.resolveLib(d, name)) return false;
      return hp.isPowerSymbol(d, name);
    };
    for (const [docId, d] of docs) {
      if (!use.has(docId)) continue;
      // SCH_REFERENCE::GetRefSuffix with reused-sheet suffixes: each row's base and its package's suffix, so units of one
      // channel group together and ranges keep to one channel (FormatRefDesRanges)
      const entry = projectDocs().find((x) => x.docId === docId), se = suffixRefEditing(docId === here && E.kdoc ? E.kdoc as KDoc : d, entry ? entry.path : undefined);
      for (const r of symbolRows(variantDocView(d, variant, pathOf(docId)), docId, !ro, powerIn(d))) {
        const it = d.items.get(r.id), path = se ? se.sheet.path || "" : "";
        if (se && it && se.sc.rs.has) { const b = se.S.baseRefOn(se.sc, se.sheet, it.node), sfx = b.endsWith("?") ? "" : se.sc.rs.packageSuffix(r.id, path); if (r.ref === b + sfx || r.ref === b + se.sc.rs.suffix(path)) { r.refBase = b; r.refSuffix = sfx; } }
        if (scope === "Selection" && !selSheets.has(docId) && !r.ids.some((id) => selection.has(id))) continue;
        const prev = r.ref && !/\?$/.test(r.ref) ? byRef.get(r.ref) : undefined; const members = r.ids.map((id) => ({ docId, id }));
        if (prev) { prev.members.push(...members); continue; }
        const row: Row = Object.assign(r, { members }); out.push(row); if (r.ref) byRef.set(r.ref, row);
      }
    }
    // edits made before a rescope / reload stay on screen
    for (const r of out) for (const m of r.members) { const e = edits.get(editKey(m)); if (!e) continue; Object.assign(r.values, e.values); for (const gone of e.remove || []) delete r.values[gone]; for (const [f, v] of Object.entries(e.flags)) (r as unknown as Record<string, boolean>)[f] = v; if (e.values.Reference !== undefined) { r.ref = e.values.Reference; delete r.refBase; delete r.refSuffix; } }
    rows = out; preset = withAllFields(preset, tableFieldNames(rows));
  };
  const markUnsaved = () => { dirtySettings = true; if (presetName !== UNSAVED) { presetName = UNSAVED; fillPresetSel(); } };
  const fillPresetSel = () => { if (!presetSel) return; const names = [...BOM_PRESETS.map((p) => p.name), ...userPresets.map((p) => p.name)]; presetSel.replaceChildren(...[...names, ...(presetName === UNSAVED ? [UNSAVED] : []), "---", SAVE, DELETE].map((n) => h("option", { value: n, disabled: n === "---" }, n === BOM_PRESETS[0].name ? "Default Editing" : n))); presetSel.value = presetName; };
  const fillFmtSel = () => { if (!fmtSel) return; const names = [...BOM_FMT_PRESETS.map((p) => p.name), ...userFmts.map((p) => p.name)]; fmtSel.replaceChildren(...[...names, ...(fmtName === UNSAVED ? [UNSAVED] : []), "---", SAVE, DELETE].map((n) => h("option", { value: n, disabled: n === "---" }, n))); fmtSel.value = fmtName; };
  const syncFmtInputs = () => { for (const [k, inp] of Object.entries(fmtInputs)) { const v = (fmt as unknown as Record<string, string | boolean>)[k]; if (inp.type === "checkbox") inp.checked = !!v; else inp.value = str(v).replace(/\t/g, "\\t"); } };
  const refreshPreview = () => { if (previewEl) previewEl.value = bomExport(rows, preset, fmt); };
  const refreshFields = () => { if (fieldGrid) { fieldGrid.rows.splice(0, fieldGrid.rows.length, ...preset.fields_ordered); fieldGrid.refresh(); } };
  /** getFootprintChooserSymbolNetlist: the library symbol of each of a row's symbols (the current variant's alternate
   *  symbol, SCH_SYMBOL::GetVariantLibSymbol, when the variant overrides it with one the schematic holds), one set of
   *  filters when their netlists agree. */
  const memberLib = (m: Member): SNode | null => {
    const d = docs.get(m.docId), it = d && d.items.get(m.id); if (!d || !it) return null;
    const ln = KiCadCanvas.kid(it.node, "lib_name") || KiCadCanvas.kid(it.node, "lib_id"), own = ln ? KiCadCanvas.str(ln[1]) : "";
    const libId = KiCadCanvas.kid(it.node, "lib_id"), alt = VM.symbolVariantOverride(it.node, variant, pathOf(m.docId));
    if (alt && alt !== (libId ? KiCadCanvas.str(libId[1]) : "")) { const a = KiCadCanvas.resolveLib(d, alt); if (a) return a; }
    return own ? KiCadCanvas.resolveLib(d, own) : null;
  };
  const rowFilters = (r: GRow): FpChooserFilters | null => commonChooserFilters((r._g.rows as Row[]).flatMap((x) => x.members).map(memberLib));
  /** GRID_CELL_URL_EDITOR's files stack: the schematic's embedded files ({ &m_parent->Schematic() }). */
  const dsButton = datasheetButton(() => ({ files: [docFiles(E.kdoc as KDoc)] }));
  const refreshGrid = () => {
    if (!gridHost) return;
    const cols: GridColumn<GRow>[] = preset.fields_ordered.filter((f) => f.show).map((f) => {
      const sort: "asc" | "desc" | undefined = (preset.sort_field || "Reference") === f.name ? (preset.sort_asc === false ? "desc" : "asc") : undefined;
      const base = { key: f.name, label: f.label, sort };
      if (ATTR_FIELDS[f.name]) return Object.assign(base, { type: "bool" as const, width: 90, ro: (r: GRow) => !r._g.rows.every((x) => x.editable) });
      if (f.name === QTY || f.name === ITEM_NO) return Object.assign(base, { type: "ro" as const, width: 46 });
      // DIALOG_SYMBOL_FIELDS_TABLE: the Footprint column's GRID_CELL_FPID_EDITOR (filters only when every symbol of the
      // row has the same ones), the Datasheet column's GRID_CELL_URL_EDITOR
      const button = f.name === "Footprint" ? (r: GRow) => footprintButton(() => rowFilters(r)) : f.name === "Datasheet" ? () => dsButton : undefined;
      return Object.assign(base, { type: "text" as const, ro: (r: GRow) => (f.name === "Reference" && r._g.rows.length > 1) || !r._g.rows.every((x) => x.editable), button });
    });
    const groups = bomRows(rows, preset);
    const data: GRow[] = groups.map((g) => { const r: GRow = { _g: g }; for (const f of preset.fields_ordered) { const a = ATTR_FIELDS[f.name]; r[f.name] = a ? g.rows.every((x) => x[a.flag]) : g.cells[f.name]; } return r; });
    gridHost.replaceChildren();
    grid = KD().grid<GRow>(gridHost, cols, data, { readOnly: ro, height: "46vh",
      onHeader(c) { if (!canSortBy(c.key)) return;   // OnColSort: the Item Number column is generated by the sort
        if (preset.sort_field === c.key || (!preset.sort_field && c.key === "Reference")) preset.sort_asc = preset.sort_asc === false; else { preset.sort_field = c.key; preset.sort_asc = true; } markUnsaved(); refreshGrid(); },
      // OnColMove: MoveColumn in the data model, then the columns laid out again and the preset selection synced
      onColMove(from, to) { if (!moveColumn(preset.fields_ordered, cols[from].key, cols[to].key)) return; markUnsaved(); refreshFields(); refreshGrid(); refreshPreview(); },
      // DIALOG_SYMBOL_FIELDS_TABLE::OnTableSelectionChanged: highlight (FindSymbolAndItem HIGHLIGHT_SYMBOL) or select
      onSelect(r) {
        // no cross-probing in the Selection scope (it would change what the table shows) or on the Export tab
        const mode = crossProbeMode(); if (mode === 2 || scope === "Selection" || onExportTab) return;
        const members = r ? r._g.rows.flatMap((x) => (x as Row).members) : [];
        // FindSymbolAndItem: a symbol of another sheet brings that sheet up
        if (members.length && !members.some((m) => m.docId === S.docId)) { try { openDocId(members[0].docId); } catch { /* the sheet stays */ } return; }
        const ids = members.filter((m) => m.docId === S.docId).map((m) => m.id);
        try { if (mode === 0) toolCtx().setHighlight(ids.length ? new Set(ids.slice(0, 1)) : null); else if (ids.length) toolCtx().setSelection(ids); else toolCtx().setSelection([]); } catch (e) { /* cross-probe is best effort */ }
      },
      // FIELDS_EDITOR_GRID_TRICKS::showFieldsTablePopupMenu: Show Datasheet on the Datasheet column
      // FIELDS_TABLE_GRID_TRICKS::showPopupMenu: Revert Row, Clear Cell, then the column's own entry
      // (showFieldsTablePopupMenu: Select Footprint... / Show Datasheet) and Copy from Variant
      cellMenu(r, c) {
        const rowsOf = r._g.rows as Row[], members = rowsOf.flatMap((x) => x.members), editable = !ro && rowsOf.every((x) => x.editable);
        const edited = members.some((m) => edits.has(editKey(m)));
        const canClear = !ATTR_FIELDS[c.key] && c.key !== QTY && c.key !== ITEM_NO && !removeFieldError(c.key) && rowsOf.some((x) => x.values[c.key] !== undefined);
        const items: import("./dom").PopItem[] = [
          { label: "Revert Row", title: "Revert the fields in this row", disabled: !editable || !edited, run: () => { for (const m of members) edits.delete(editKey(m)); refreshAll(); } },
          { label: "Clear Cell", title: "Clear the cell value", disabled: !editable || !canClear, run: () => { for (const x of rowsOf) { delete x.values[c.key]; for (const m of x.members) { const e = editOf(m); delete e.values[c.key]; (e.remove || (e.remove = new Set())).add(c.key); } } refreshGrid(); refreshPreview(); } },
          { sep: true }];
        const setCell = (v: string): void => { for (const x of rowsOf) { x.values[c.key] = v; for (const m of x.members) { const e = editOf(m); e.values[c.key] = v; if (e.remove) e.remove.delete(c.key); } } refreshGrid(); refreshPreview(); };
        if (c.key === "Footprint") items.push({ label: "Select Footprint...", title: "Browse for footprint", disabled: !editable, run: () => footprintButton(() => rowFilters(r)).run(str(r[c.key]), setCell) }, { sep: true });
        else if (c.key === "Datasheet") {
          const url = str(r[c.key]).trim();
          items.push({ label: "Show Datasheet", title: "Show datasheet in browser", disabled: !url || url === "~", run: () => { if (/^https?:/i.test(url)) window.open(url, "_blank", "noopener"); else toast("Datasheet: " + url); } }, { sep: true });
        }
        // showFieldsTablePopupMenu under a design variant: a row of one symbol offers Set Variant Symbol... and, when
        // its variant record holds a symbol override, Clear Variant Symbol (SyncSelection, then the actions)
        const curVariant = String((E as { currentVariant?: string }).currentVariant || "");
        if (curVariant && members.length === 1) {
          const m = members[0], d = docs.get(m.docId), it = d && d.items.get(m.id);
          if (d && it && it.kind === "symbol") {
            const sheet = { docId: m.docId, doc: d, path: pathOf(m.docId) };
            const sync = (): void => { if (m.docId === S.docId) { try { toolCtx().setSelection([m.id]); } catch (e) { /* the selection is best effort */ } } };
            items.push({ sep: true }, { label: "Set Variant Symbol...", run: () => { sync(); void setVariantSymbol(m.id, sheet); } });
            if (VM.symbolVariantOverride(it.node, curVariant, sheet.path)) items.push({ label: "Clear Variant Symbol", run: () => { sync(); void clearVariantSymbol(m.id, sheet); } });
          }
        }
        // appendPopupMenuItems: with a variant besides the default, the cell's value in another variant
        const names = variantNamesForUI();
        if (names.length >= 2) {
          const canCopy = editable && !ATTR_FIELDS[c.key] && c.key !== QTY && c.key !== ITEM_NO && c.key !== "Reference";
          items.push({ label: "Copy from Variant", disabled: !canCopy, sub: names.map((n, i) => { const v = i === 0 ? "" : n; return { label: n, disabled: !canCopy || v === variant, run: () => {
            for (const x of rowsOf) for (const m of x.members) {
              const d = docs.get(m.docId); if (!d) continue;
              const src = symbolRows(variantDocView(d, v, pathOf(m.docId)), m.docId, false, () => false).find((y) => y.ids.includes(m.id)); if (!src) continue;
              const val = str(src.values[c.key]); x.values[c.key] = val; const e = editOf(m); e.values[c.key] = val;
            }
            refreshGrid(); refreshPreview(); } }; }) }, { sep: true });
        }
        return items;
      },
      onChange(r, key, value) {
        if (!key) return; const a = ATTR_FIELDS[key];
        for (const x of r._g.rows as Row[]) {
          if (a) (x as unknown as Record<string, boolean>)[a.flag] = !!value; else { x.values[key] = str(value); if (key === "Reference") { x.ref = str(value); delete x.refBase; delete x.refSuffix; } }
          for (const m of x.members) { const e = editOf(m); if (a) e.flags[a.flag] = !!value; else { e.values[key] = str(value); if (e.remove) e.remove.delete(key); } }
        }
        refreshGrid();
      } });
    if (countEl) countEl.textContent = loading ? "Loading the other sheets…" : "";
  };
  const refreshAll = () => { buildRows(); refreshFields(); refreshGrid(); refreshPreview(); };

  /** The edits as changes per document; flags ride on the same change as the field texts. */
  const changesByDoc = (): Map<string, KChange[]> => {
    const sch = CollabTools.sch as SchToolModule & { fieldsTableChanges(doc: KDoc, edits: { id: string; values: Record<string, string>; remove?: string[]; present?: string[] }[]): KChange[] };
    const out = new Map<string, KChange[]>(), byDoc = new Map<string, { id: string; values: Record<string, string>; flags: Record<string, boolean>; remove?: string[]; present?: string[] }[]>();
    const variantEdits = new Map<string, { id: string; variant: string; values: Record<string, string>; flags: Record<string, boolean> }[]>();
    for (const e of edits.values()) {
      // with a variant, the Reference is still the symbol's own; the rest goes to the variant below
      // field presence is the symbol's own, whatever the variant shown (removed fields go, renamed ones are created)
      const remove = e.remove && e.remove.size ? [...e.remove] : undefined, present = e.present && e.present.size ? [...e.present] : undefined;
      const base = e.variant ? { id: e.m.id, values: Object.assign({}, e.values.Reference !== undefined ? { Reference: e.values.Reference } : {}, ...(present || []).filter((k) => e.values[k] !== undefined).map((k) => ({ [k]: e.values[k] }))), flags: {}, remove, present } : { id: e.m.id, values: e.values, flags: e.flags, remove, present };
      const l = byDoc.get(e.m.docId) || []; l.push(base); byDoc.set(e.m.docId, l);
      if (e.variant) { const v = variantEdits.get(e.m.docId) || []; v.push({ id: e.m.id, variant: e.variant, values: e.values, flags: e.flags }); variantEdits.set(e.m.docId, v); }
    }
    for (const [docId, list] of byDoc) {
      const d = docs.get(docId); if (!d) continue;
      const ch = new Map<string, KChange>(); for (const c of sch.fieldsTableChanges(d, list.filter((x) => Object.keys(x.values).length || x.remove).map((x) => ({ id: x.id, values: x.values, remove: x.remove, present: x.present })))) ch.set(c.id, c);
      for (const x of variantEdits.get(docId) || []) {
        const it = d.items.get(x.id); if (!it) continue;
        const prior = ch.get(x.id); const node = (prior && prior.sexpr ? KiCadCanvas.parse(prior.sexpr) : cloneNode(it.node)) as SNode;
        const nn = variantEditNode(node, x.variant, x.values, x.flags, pathOf(docId), d.version);
        if (nn) ch.set(x.id, KiCadCanvas.replaceChange(d, Object.assign({}, it, { node: nn, geom: [], bbox: null })));
      }
      for (const x of list) {
        if (!Object.keys(x.flags).length) continue; const it = d.items.get(x.id); if (!it) continue;
        const prior = ch.get(x.id); const node = (prior && prior.sexpr ? KiCadCanvas.parse(prior.sexpr) : cloneNode(it.node)) as SNode; let any = false;
        for (const [flag, on] of Object.entries(x.flags)) { const [key, direct] = FLAG_NODE[flag] || []; const k = key ? KiCadCanvas.kid(node, key) : null; if (!k) continue; const want = (direct ? on : !on) ? "yes" : "no"; if (str(k[1]) !== want) { k[1] = want; any = true; } }
        if (any) ch.set(x.id, KiCadCanvas.replaceChange(d, Object.assign({}, it, { node, geom: [], bbox: null })));
      }
      if (ch.size) out.set(docId, [...ch.values()]);
    }
    return out;
  };
  const apply = async (): Promise<boolean> => {
    if (ro) return true;
    const byDoc = changesByDoc();
    try {
      // commit.Push( "Symbol Fields Table Edit" ); another sheet's part of it is undoable on that sheet
      for (const [docId, ch] of byDoc) {
        if (docId === S.docId) toolCtx().commit(ch, "Symbol Fields Table Edit");
        else {
          const od = docs.get(docId), inverse = od ? ch.map((c) => { const it = od.items.get(c.id as string); return it ? KiCadCanvas.replaceChange(od, it) : null; }).filter(Boolean) as KChange[] : [];
          await submitDocOp(docId, ch); if (inverse.length) pushUndoFor(docId, { label: "Symbol Fields Table Edit", changes: ch, inverse });
          const fresh = await readDoc(docId, "kicad_sch"); docs.set(docId, fresh);
        }
      }
    } catch (e) { toast("Could not apply the changes: " + (e as Error).message, 4000); return false; }
    edits.clear(); if (S.docId && docs.has(S.docId)) docs.set(S.docId, E.kdoc as KDoc);
    if (dirtySettings) {
      dirtySettings = false;
      saveProject((pro) => { const s = sub(pro, "schematic"); s.bom_settings = presetJson(Object.assign({}, preset, { name: presetName === UNSAVED ? "" : presetName })); s.bom_presets = userPresets.map(presetJson);
        s.bom_fmt_settings = fmtJson(Object.assign({}, fmt, { name: fmtName === UNSAVED ? "" : fmtName })); s.bom_fmt_presets = userFmts.map(fmtJson); s.bom_export_filename = outFile; }, "BOM settings").catch(() => { /* the table still applied */ });
    }
    return true;
  };
  // DIALOG_FIELDS_TABLE::OnExport
  const doExport = async (): Promise<void> => {
    if (edits.size && !(await okOrCancel("Unsaved data", "Changes have not yet been saved. Export unsaved data?"))) return;
    const path = outFile.replace(/\$\{PROJECTNAME\}/g, projectName() || "project");
    if (!path.trim()) { void messageBox("No output file specified in Export tab."); return; }
    const name = path.split(/[\\/]/).pop() || path;
    try { download(name, bomExport(rows, preset, fmt)); } catch { void messageBox(`Could not write BOM output '${name}'.`); return; }
    void messageBox(`Wrote BOM output to '${name}'`, "Information");
  };

  buildRows();
  const api = KD().open({ title: "Symbol Fields Table", width: 1120, cls: "kd-wide", readOnly: ro,
    extra: [{ label: "Export", fn: () => { void doExport(); } }, ...(ro ? [] : [{ label: "Apply, Save Schematic & Continue", fn: () => { void apply().then(() => refreshAll()); } }])],
    build(body) {
      // ---- left: the field list and the view presets
      const left = h("div", { style: "width:330px;flex:none;display:flex;flex-direction:column" });
      fieldGrid = KD().grid<BomField>(left, [{ key: "name", label: "Field", type: "ro", format: (v) => fieldDisplayName(str(v)) }, { key: "label", label: "BOM Name", type: "text" }, { key: "show", label: "Include", type: "bool", width: 52 }, { key: "group_by", label: "Group By", type: "bool", width: 62 }],
        preset.fields_ordered, { height: "40vh", onChange(row, key) {
          // OnViewControlsCellChanged( GROUP_BY_COLUMN ): the Quantity and Item Number columns cannot be grouped by
          const ge = row && key === "group_by" && row.group_by ? groupByError(row.name) : null;
          if (ge) { row.group_by = false; fieldGrid!.refresh(); void messageBox(ge); return; }
          markUnsaved(); preset.fields_ordered = fieldGrid!.rows; refreshGrid(); refreshPreview(); }, buttons: { move: true } });
      const bar = fieldGrid.bar || h("div", { class: "kd-grid-btns" }); if (!fieldGrid.bar) left.append(bar);
      const fbtn = (icon: string, title: string, id: string, fn: () => void) => { const b = bitmapButton(icon, title, fn, { id, disabled: ro }); bar.prepend(b); return b; };
      // DIALOG_FIELDS_TABLE::OnRemoveField: the refusals as error boxes, else IsOK, then the field leaves every symbol
      // and every preset
      fbtn("small_trash", "Remove selected field", "kd-sft-removefield", () => { const at = fieldGrid!.selected(), f = preset.fields_ordered[at]; if (!f) return;
        const err = removeFieldError(f.name); if (err) { void messageBox(err); return; }
        void isOK(`Are you sure you want to remove the field '${fieldDisplayName(f.name)}'?`).then((yes) => {
          if (!yes) return;
          preset.fields_ordered.splice(preset.fields_ordered.indexOf(f), 1);
          for (const r of rows) { const had = r.values[f.name] !== undefined; delete r.values[f.name]; if (had) for (const m of r.members) { const e = editOf(m); delete e.values[f.name]; (e.remove || (e.remove = new Set())).add(f.name); } }
          for (const p of userPresets) p.fields_ordered = p.fields_ordered.filter((x) => x.name !== f.name);
          markUnsaved(); refreshFields(); refreshGrid(); refreshPreview(); }); });
      // DIALOG_FIELDS_TABLE::OnRenameField: the field itself is renamed on every symbol (the prompt holds its name);
      // a label that was the generated one follows
      fbtn("small_edit", "Rename selected field", "kd-sft-renamefield", () => { const f = preset.fields_ordered[fieldGrid!.selected()]; if (!f) return;
        const err = renameFieldError(f.name); if (err) { void messageBox(err); return; }
        void promptText("Rename Field", "New field name:", f.name).then((n) => {
          if (n === null) return;
          const bad = renameFieldCheck(preset.fields_ordered.map((x) => x.name), f.name, n); if (bad === "") return; if (bad) { void messageBox(bad); return; }
          const old = f.name, auto = f.label === old;
          for (const r of rows) { if (!renameRowField(r.values, old, n)) continue; for (const m of r.members) { const e = editOf(m); e.values[n] = r.values[n]; delete e.values[old]; (e.remove || (e.remove = new Set())).add(old); e.remove.delete(n); (e.present || (e.present = new Set())).add(n); } }
          f.name = n; if (auto) f.label = n;
          if (preset.sort_field === old) preset.sort_field = n;
          markUnsaved(); refreshFields(); refreshGrid(); refreshPreview(); }); });
      fbtn("small_plus", "Add a new field", "kd-sft-addfield", () => { void promptText("Add Field", "New field name:").then((n) => {
        // DIALOG_FIELDS_TABLE::OnAddField: Cancel does nothing; an empty or taken name is a DisplayError box
        if (n === null) return;
        if (!n) { void messageBox("Field must have a name."); return; }
        if (preset.fields_ordered.some((f) => fieldNamesAreDuplicates(n, f.name))) { void messageBox(`Field name '${n}' already in use.`); return; } preset.fields_ordered.push({ name: n, label: n, show: true, group_by: false }); markUnsaved(); refreshFields(); refreshGrid(); }); });
      presetSel = select([], "", (v) => {
        if (v === SAVE) { fillPresetSel(); void promptText("Save BOM Preset", "BOM preset name:", presetName === UNSAVED ? "" : presetName).then((n) => { n = (n || "").trim(); if (!n) return; if (BOM_PRESETS.some((p) => p.name === n)) { void messageBox("Default presets cannot be modified.\nPlease use a different name."); return; }
          const store = (): void => { userPresets = userPresets.filter((p) => p.name !== n); userPresets.push(Object.assign(clone(preset), { name: n })); presetName = n; dirtySettings = true; fillPresetSel(); };
          // an existing user preset is overwritten only after IsOK( "Overwrite existing preset?" )
          if (userPresets.some((p) => p.name === n)) void isOK("Overwrite existing preset?").then((yes) => { if (yes) store(); }); else store(); }); return; }
        // EDA_LIST_DIALOG( this, "Delete Preset", { "Presets" }, the user presets ), list label "Select preset:"
        if (v === DELETE) { fillPresetSel(); listDialog("Delete Preset", ["Presets"], userPresets.map((p) => [p.name]), (row) => { const n = row[0]; userPresets = userPresets.filter((p) => p.name !== n); if (presetName === n) presetName = UNSAVED; dirtySettings = true; fillPresetSel(); }, { listLabel: "Select preset:", child: true }); return; }
        const p = BOM_PRESETS.find((x) => x.name === v) || userPresets.find((x) => x.name === v); if (!p) return;
        preset = withAllFields(clone(p), tableFieldNames(rows)); presetName = v; dirtySettings = true; fillPresetSel(); refreshFields(); syncEditBar(); refreshGrid(); refreshPreview(); }, { id: "kd-sft-preset" });
      left.append(h("div", { class: "kd-row", style: "margin-top:10px" }, h("label", { style: "white-space:nowrap;color:var(--ink-2)" }, "View presets:"), presetSel)); fillPresetSel();
      // Schematic variants: the list (GetVariantNamesForUI), choosing one shows (and stages edits for) its values
      // and makes it the schematic's current variant (onVariantSelectionChange); add / rename / copy / describe / delete
      const vlist = h("k-select", { id: "kd-sft-variants", size: 5, style: "width:100%;margin-top:3px" }) as HTMLSelectElement;   // a themed list box (components/kselect.ts)
      const fillVariants = () => { const names = variantNamesForUI(); vlist.replaceChildren(...names.map((n, i) => h("option", { value: i === 0 ? "" : n }, n))); vlist.value = variant; if (vlist.selectedIndex < 0) vlist.selectedIndex = 0; };
      vlist.addEventListener("change", () => { variant = vlist.value; setCurrentVariant(variant); refreshAll(); });
      // the buttons act on the list's selection (DIALOG_SYMBOL_FIELDS_TABLE::onRenameVariant …); copy, rename,
      // describe and delete are disabled on the default (updateVariantButtonStates)
      const btns: HTMLButtonElement[] = [];
      const afterCmd = (sel: string | null) => setTimeout(() => {
        variant = String((E as { currentVariant?: string }).currentVariant || ""); fillVariants();
        if (sel !== null) { const i = variantNamesForUI().indexOf(sel); if (i >= 0) vlist.selectedIndex = i; }
        updateBtns(); refreshAll(); }, 300);
      const vbtn = (icon: string, title: string, id: string, fn: (names: string[], index: number, prompts: VariantPrompts) => Promise<string | null> | void, needsVariant: boolean) => {
        const b = bitmapButton(V_ICONS[icon], title, () => { const names = variantNamesForUI(); const r = fn(names, vlist.selectedIndex, stackedPrompts); if (r) void r.then((sel) => afterCmd(sel)); }, { id, disabled: ro });
        if (needsVariant) b.dataset.needsVariant = "1";
        btns.push(b); return b;
      };
      const updateBtns = () => { for (const b of btns) if (b.dataset.needsVariant) b.disabled = ro || vlist.selectedIndex <= 0; };
      vlist.addEventListener("change", updateBtns);
      left.append(h("div", { style: "margin-top:10px" }, h("label", { style: "color:var(--ink-2)" }, "Schematic variants:"), vlist,
        h("div", { class: "kd-row", style: "gap:4px;margin-top:3px" },
          vbtn("plus", "Add a new variant", "kd-sft-addvariant", () => { addVariant((name) => afterCmd(name), stackedPrompts); }, false),
          vbtn("edit", "Rename the selected variant", "kd-sft-renamevariant", fieldsTableRenameVariant, true),
          vbtn("copy", "Copy the selected variant", "kd-sft-copyvariant", fieldsTableCopyVariant, true),
          vbtn("text", "Edit the selected variant's description", "kd-sft-descvariant", fieldsTableEditVariantDescription, true),
          h("span", { style: "flex:1" }),
          vbtn("trash", "Delete the selected variant", "kd-sft-deletevariant", fieldsTableDeleteVariant, true))));
      fillVariants(); updateBtns();

      // ---- right: Edit / Export
      const right = h("div", { style: "flex:1;min-width:0" });
      const filter = textInput(preset.filter_string, (v) => { preset.filter_string = v; refreshGrid(); }, { id: "kd-sft-filter", placeholder: "Filter", style: "width:170px" });
      const groupCb = checkbox("Group symbols", preset.group_symbols, (on) => { preset.group_symbols = on; markUnsaved(); refreshGrid(); refreshPreview(); }, { id: "kd-sft-group", title: "Group symbols together based on common properties" });
      const filterScope = select(FILTER_SCOPES, preset.filter_scope || "reference", (v) => { preset.filter_scope = v as BomFilterScope; markUnsaved(); refreshGrid(); refreshPreview(); }, { id: "kd-sft-filterscope", style: "width:110px" });
      // m_bMenu (BITMAPS::config): DIALOG_SYMBOL_FIELDS_TABLE::OnMenu
      const menuBtn = bitmapButton("config", "", () => {
        const r = menuBtn.getBoundingClientRect(), mode = crossProbeMode();
        popupMenu(r.left, r.bottom, [
          { label: "Include 'DNP' Symbols", check: true, checked: !preset.exclude_dnp, run: () => { preset.exclude_dnp = !preset.exclude_dnp; markUnsaved(); refreshGrid(); refreshPreview(); } },
          { label: "Include 'Exclude from BOM' Symbols", check: true, checked: preset.include_excluded_from_bom, run: () => { preset.include_excluded_from_bom = !preset.include_excluded_from_bom; markUnsaved(); refreshGrid(); refreshPreview(); } },
          { sep: true },
          { label: "Highlight on Cross-probe", check: true, checked: mode === 0, run: () => setCrossProbeMode(mode !== 0 ? 0 : 2) },
          { label: "Select on Cross-probe", check: true, checked: mode === 1, run: () => setCrossProbeMode(mode !== 1 ? 1 : 2) },
        ]);
      }, { id: "kd-sft-menu" });
      menuBtn.removeAttribute("title");
      const syncEditBar = () => { filter.value = preset.filter_string; filterScope.value = preset.filter_scope || "reference"; (groupCb.firstChild as HTMLInputElement).checked = preset.group_symbols; };
      syncBar = syncEditBar;
      KD().notebook(right, [
        { label: "Edit", build(page) {
          const scopeSel = select(SCOPES, scope, (v) => { scope = v as Scope; refreshAll(); }, { id: "kd-sft-scope", style: "width:190px" });
          const vsep = () => h("span", { class: "kbmp-sep", style: "height:22px" });
          page.append(h("div", { class: "kd-row", style: "margin-bottom:6px;flex-wrap:wrap;align-items:center" }, filter, filterScope, vsep(), scopeSel, vsep(), groupCb, vsep(), bitmapButton("small_refresh", "Refresh Grouping", () => refreshAll(), { id: "kd-sft-refresh" }), menuBtn),
            h("div", { class: "kd-row", style: "margin-bottom:6px;gap:18px" }, (countEl = h("span", { style: "margin-left:auto;color:var(--ink-2)", id: "kd-sft-count" }))));
          gridHost = h("div", { id: "kd-sft-grid" }); page.append(gridHost); refreshGrid();
        } },
        { label: "Export", build(page) {
          const fi = (key: keyof BomFmt, id: string, width = 70) => { const i = textInput("", (v) => { (fmt as unknown as Record<string, string>)[key] = v.replace(/\\t/g, "\t"); fmtName = UNSAVED; dirtySettings = true; fillFmtSel(); refreshPreview(); }, { id, style: `width:${width}px` }); fmtInputs[key] = i; return i; };
          const fc = (key: keyof BomFmt, label: string, id: string, title?: string) => { const c = checkbox(label, false, (on) => { (fmt as unknown as Record<string, boolean>)[key] = on; fmtName = UNSAVED; dirtySettings = true; fillFmtSel(); refreshPreview(); }, { id, title }); fmtInputs[key] = c.firstChild as HTMLInputElement; return c; };
          fmtSel = select([], "", (v) => {
            if (v === SAVE) { fillFmtSel(); void promptText("Save BOM Format Preset", "BOM preset name:", fmtName === UNSAVED ? "" : fmtName).then((n) => { n = (n || "").trim(); if (!n) return; if (BOM_FMT_PRESETS.some((p) => p.name === n)) { void messageBox("Default presets cannot be modified.\nPlease use a different name."); return; }
              const store = (): void => { userFmts = userFmts.filter((p) => p.name !== n); userFmts.push(Object.assign(clone(fmt), { name: n })); fmtName = n; dirtySettings = true; fillFmtSel(); };
              if (userFmts.some((p) => p.name === n)) void isOK("Overwrite existing preset?").then((yes) => { if (yes) store(); }); else store(); }); return; }
            if (v === DELETE) { fillFmtSel(); listDialog("Delete Preset", ["Presets"], userFmts.map((p) => [p.name]), (row) => { const n = row[0]; userFmts = userFmts.filter((p) => p.name !== n); if (fmtName === n) fmtName = UNSAVED; dirtySettings = true; fillFmtSel(); }, { listLabel: "Select preset:", child: true }); return; }
            const p = BOM_FMT_PRESETS.find((x) => x.name === v) || userFmts.find((x) => x.name === v); if (!p) return; fmt = clone(p); fmtName = v; dirtySettings = true; fillFmtSel(); syncFmtInputs(); refreshPreview(); }, { id: "kd-sft-fmt", style: "width:220px" });
          page.append(h("div", { style: "display:grid;grid-template-columns:max-content max-content max-content max-content 1fr;gap:6px 12px;align-items:center" },
            h("label", null, "Field delimiter:"), fi("field_delimiter", "kd-sft-fd"), h("label", null, "String delimiter:"), fi("string_delimiter", "kd-sft-sd"), h("span"),
            h("label", null, "Reference delimiter:"), fi("ref_delimiter", "kd-sft-rd"), h("label", null, "Range delimiter:"), fi("ref_range_delimiter", "kd-sft-rr"), h("span", { class: "kd-note", style: "margin:0" }, "Leave blank to disable ranges.")),
            h("div", { class: "kd-row", style: "gap:18px;margin:8px 0" }, fc("keep_tabs", "Keep tabs", "kd-sft-tabs"), fc("keep_line_breaks", "Keep line breaks", "kd-sft-lb"), fc("include_bom", "Include byte order mark", "kd-sft-bom", "Can increase compatibility with older software that does not import UTF-8 correctly, such as Excel. Can worsen compatibility in some cases.")),
            h("div", { class: "kd-row", style: "margin:8px 0;border-top:1px solid var(--line);padding-top:8px" }, h("label", { style: "color:var(--ink-2)" }, "Format presets:"), fmtSel),
            h("div", { class: "kd-row", style: "margin:8px 0" }, h("label", { style: "white-space:nowrap;color:var(--ink-2)" }, "Output file:"), textInput(outFile, (v) => { outFile = v; dirtySettings = true; }, { id: "kd-sft-out" })),
            h("div", { class: "kd-row", style: "justify-content:space-between" }, h("label", { style: "color:var(--ink-2)" }, "Preview:"), bitmapButton("small_refresh", "Refresh preview", () => refreshPreview(), { key: "refresh-preview" })),
            (previewEl = h("textarea", { id: "kd-sft-preview", readonly: true, wrap: "off", style: "height:34vh;margin-top:4px;white-space:pre;font-size:12px" })));
          fillFmtSel(); syncFmtInputs(); refreshPreview();
        } },
      ], { selected: exportTab ? 1 : 0, onSelect(i) { onExportTab = i === 1; if (i === 1) refreshPreview(); } });
      // m_sidebarButton: collapses the left panel (BITMAPS::left) or brings it back (BITMAPS::right)
      const side = bitmapButton(sidebarCollapsed() ? "right" : "left", sidebarCollapsed() ? "Expand left panel" : "Collapse left panel", () => {
        const on = !sidebarCollapsed(); setSidebarCollapsed(on); left.style.display = on ? "none" : "flex";
        const next = bitmapButton(on ? "right" : "left", "", null); side.innerHTML = next.innerHTML; side.title = on ? "Expand left panel" : "Collapse left panel";
      }, { id: "kd-sft-sidebar" });
      if (sidebarCollapsed()) left.style.display = "none";
      right.prepend(h("div", { style: "float:left;margin-right:6px" }, side));
      body.append(h("div", { style: "display:flex;gap:14px" }, left, right));
      if (exportTab) refreshPreview();
    },
    ok() { unsubscribe(); void apply(); },
    // DIALOG_SYMBOL_FIELDS_TABLE::OnClose: HandleUnsavedChanges( "Save changes?" ) over edits not applied yet
    cancel() {
      if (ro || !edits.size) { unsubscribe(); return true; }
      void unsavedChangesBox("Save changes?").then((r) => { if (r === "cancel") return; if (r === "save") void apply().then((ok) => { if (ok) { unsubscribe(); api.close(); } }); else { edits.clear(); unsubscribe(); api.close(); } });
      return false;
    } });

  // OnSchSelectionChanged / OnSchItemsChanged: while the dialog is open the Selection scope follows the selection and
  // the rows follow the open sheet's document
  let lastDoc: KDoc | null = E.kdoc as KDoc, lastSel = [...selection].sort().join(",");
  const unsubscribe: () => void = store && store.subscribe ? store.subscribe(() => {
    if (!api.body.isConnected) { unsubscribe(); return; }
    const d = E.kdoc as KDoc | null, sel = selectionNow(), key = [...sel].sort().join(",");
    let changed = false;
    if (d && d !== lastDoc && S.docId) { lastDoc = d; docs.set(S.docId, d); changed = true; }
    if (key !== lastSel) { lastSel = key; selection = sel; if (scope === "Selection") changed = true; }
    if (changed) refreshAll();
  }) : () => {};
  // on open the cursor goes to the row of the single selected symbol
  { const g0 = grid as GridApi<GRow> | null; if (selection.size === 1 && g0) { const id = [...selection][0], i = g0.rows.findIndex((r) => (r._g.rows as Row[]).some((x) => x.ids.includes(id))); if (i >= 0) { g0.select(i); goToCell(g0, i); } } }
  // the project's stored BOM settings and presets, then the other sheets
  void loadProject().then((pro) => {
    const s = obj(pro.schematic); if (!KD().isOpen()) return;
    userPresets = (Array.isArray(s.bom_presets) ? s.bom_presets : []).map(presetFromJson).filter((p): p is BomPreset => !!p && !!p.name);
    userFmts = (Array.isArray(s.bom_fmt_presets) ? s.bom_fmt_presets : []).map(fmtFromJson).filter((p): p is BomFmt => !!p && !!p.name);
    const cur = presetFromJson(s.bom_settings);
    if (cur && cur.name && (BOM_PRESETS.some((p) => p.name === cur.name) || userPresets.some((p) => p.name === cur.name))) { const p = BOM_PRESETS.find((x) => x.name === cur.name) || userPresets.find((x) => x.name === cur.name)!; preset = withAllFields(clone(p), tableFieldNames(rows)); presetName = cur.name; }
    else if (cur && !cur.name) { preset = withAllFields(cur, tableFieldNames(rows)); presetName = UNSAVED; }
    const cf = fmtFromJson(s.bom_fmt_settings); if (cf) { fmt = cf; fmtName = BOM_FMT_PRESETS.some((p) => p.name === cf.name && JSON.stringify(fmtJson(p)) === JSON.stringify(fmtJson(cf))) || userFmts.some((p) => p.name === cf.name) ? cf.name : UNSAVED; }
    if (typeof s.bom_export_filename === "string" && s.bom_export_filename) outFile = s.bom_export_filename;
    const out = document.querySelector<HTMLInputElement>("#kd-sft-out"); if (out) out.value = outFile;
    fillPresetSel(); fillFmtSel(); syncFmtInputs(); syncBar(); refreshFields(); refreshGrid(); refreshPreview();
  });
  const others = projectDocs().filter((d) => d.docType === "kicad_sch" && d.docId !== here);
  if (others.length) {
    loading = true; refreshGrid();
    void Promise.all(others.map((d) => readDoc(d.docId, "kicad_sch").then((od) => { docs.set(d.docId, od); }, () => { /* an unreadable sheet is left out */ }))).then(() => { loading = false; if (KD().isOpen()) refreshAll(); });
  }
}
