// pcbdialogs/generated-tables — the board's generated tables and drill symbols:
//  - DIALOG_GENERATED_TABLE_PROPERTIES (+ PANEL_DRILL_CHART_OPTIONS and DRILL_CHART_TEMPLATE's JSON) for a drill chart
//    or a stackup table: General (Layer, Units, Decimal places, Locked), Columns (the column grid, Move Up / Move Down /
//    Reset to Default and, on a chart, the filter, totals and grouping options with the template import / export) and
//    Appearance (the border and separator strokes); OK rebuilds the table with one refresh and commits "Edit %s".
//  - DIALOG_DRILL_GROUPS (PCB_ACTIONS::showDrillGroups): the board's drill groups with their symbols, modeless.
//  - PCB_EDIT_FRAME::OnModify's RefreshGeneratedTables: after an edit of the board, every stale generated table is
//    rebuilt and the assignments it handed out stored, folded into that edit's undo step.
import { box, checkField, commitPendingEdit, download, errorMessage, form, grid, h, lenField, notebook, openDialog, selectField, spinField, textField, unitLabel, type CellValue, type DialogApi, type Field, type GridApi } from "./ui";
import { commitChanges, commitObservers, toolCtx } from "../tools";
import { focusOnLocation } from "../view";
import { store } from "../appstore";
import { E } from "../state";
import { ALIGN_CHOICES, DM, GROUP_KEY_ROWS, K, MARK_MODES, PT, UNIT_CHOICES, applyGenerated, assignmentEdit, columnRows, drillGroups, friendlyName, generatedError, generatedRefreshChanges, generatedValues, groupRow, layerLabel, parseTemplate, shownColumns, templateJson,
  type ChartGroup, type ColumnRow, type GenColumn, type GenKind, type GenUnits, type GeneratedValues } from "./generated-tables-model";

/** PCB_EDIT_FRAME::OnEditItemRequest for a PCB_DRILL_CHART / PCB_STACKUP_TABLE. */
export function generatedTableDialog(ctx: ToolCtx, item: KItem): boolean {
  const doc = ctx.doc as KDoc; if (!doc) return false;
  const node0 = item.node, kind = node0[0] as GenKind, ro = !!ctx.viewOnly, name = friendlyName(kind);
  const v0 = generatedValues(doc, node0);
  let rows: ColumnRow[] = v0.rows.map((r) => ({ ...r, col: { ...r.col } }));
  let g: GridApi | null = null;
  let units: Field<GenUnits>, precision: Field<number> & { enable(on: boolean): void }, totals: Field<boolean> | null = null;
  const schema = DM().schemaOf(kind);
  const label = (id: string): string => { const d = schema.find((x) => x.id === id); return d ? d.label || d.heading : ""; };
  const gridRows = (): Record<string, CellValue>[] => rows.map((r) => ({ show: r.shown, name: label(r.col.id), heading: r.col.heading, align: r.col.align, width: r.col.width > 0 ? r.col.width : NaN }));
  // harvestColumnGrid
  const harvest = (): void => {
    if (!g) return; commitPendingEdit(g);
    g.rows().forEach((row, i) => {
      const r = rows[i]; if (!r) return;
      r.shown = !!row.show; r.col.heading = String(row.heading); const a = String(row.align);
      if (a === "left" || a === "center" || a === "right") r.col.align = a;
      const w = Number(row.width); r.col.width = Math.min(1000, Math.max(0, isFinite(w) ? w : 0));
    });
  };
  const fill = (sel = -1): void => { if (!g) return; g.setRows(gridRows()); if (sel >= 0) g.select(sel); };
  const setColumns = (cols: GenColumn[]): void => { rows = columnRows(kind, cols); fill(); };
  const move = (delta: number): void => {
    if (!g) return; harvest(); const row = g.selected(), target = row + delta;
    if (row < 0 || target < 0 || target >= rows.length) return;
    const t = rows[row]; rows[row] = rows[target]; rows[target] = t; fill(target);
  };
  const f: Record<string, Field<string | number | boolean>> = {};
  const current = (): GeneratedValues => {
    harvest();
    const v: GeneratedValues = { layer: String(f.layer.get()), locked: !!f.locked.get(), units: units.get(), precision: Number(precision.get()), rows,
      external: !!f.external.get(), header: !!f.header.get(), borderWidth: Number(f.borderWidth.get()), rowLines: !!f.rows.get(), colLines: !!f.cols.get(), sepWidth: Number(f.sepWidth.get()) };
    if (kind === "drill_chart") {
      v.filter = { plated: !!f.plated.get(), npth: !!f.npth.get(), vias: !!f.vias.get(), slots: !!f.slots.get(), backdrill: !!f.backdrill.get(), castellated: !!f.castellated.get() };
      v.totals = !!(totals && totals.get()); v.groupBy = GROUP_KEY_ROWS.map((r) => r[0]).filter((k) => !!f["group_" + k].get());
    }
    return v;
  };
  return !!openDialog({ title: `${name} Properties`, width: 620, readOnly: ro, noEnter: true,
    build(body) {
      // Not merely "not copper": only the documentation layers
      const layers = DM().documentationLayers(doc as never); if (v0.layer && !layers.includes(v0.layer)) layers.unshift(v0.layer);
      f.layer = selectField<string>(v0.layer, layers.map((l): [string, string] => [l, layerLabel(doc, l)]), { ro, key: "layer" }) as Field<string | number | boolean>;
      units = selectField<GenUnits>(v0.units, UNIT_CHOICES, { ro, key: "units" });
      precision = spinField(v0.precision, { min: 0, max: 6, ro, key: "precision" });
      f.locked = checkField(v0.locked, "Locked", { ro, key: "locked" }) as Field<string | number | boolean>;
      // the column grid
      g = grid([{ label: "Show", key: "show", type: "check" }, { label: "Column", key: "name", type: "ro" }, { label: "Heading", key: "heading" },
        { label: "Align", key: "align", type: "select", options: ALIGN_CHOICES }, { label: "Min Width", key: "width", type: "len", blank: "" }], gridRows(), { ro, height: "220px", key: "columns" });
      const btn = (text: string, k: string, fn: () => void): HTMLButtonElement => { const b = h("button", { type: "button", "data-k": k, disabled: ro }, text) as HTMLButtonElement; b.addEventListener("click", fn); return b; };
      const colButtons = h("div", { class: "pd-row", style: "gap:6px;margin-top:6px" }, btn("Move Up", "moveUp", () => move(-1)), btn("Move Down", "moveDown", () => move(1)),
        btn("Reset to Default", "resetColumns", () => setColumns(DM().defaultColumns(kind))));
      const columnsPage: HTMLElement[] = [g.el, colButtons];
      if (kind === "drill_chart") {
        const fl = v0.filter!; const opt = (k: string, text: string, on: boolean): HTMLElement => { f[k] = checkField(on, text, { ro, key: k }) as Field<string | number | boolean>; return f[k].el; };
        totals = checkField(!!v0.totals, "Show totals row", { ro, key: "showTotals" });
        const groups = GROUP_KEY_ROWS.map(([k, text]) => opt("group_" + k, text, (v0.groupBy || []).includes(k)));
        // onImportTemplate / onExportTemplate
        const picker = h("input", { type: "file", accept: ".json", style: "display:none", "data-k": "templatePicker" }) as HTMLInputElement;
        picker.addEventListener("change", () => {
          const file = picker.files && picker.files[0]; picker.value = ""; if (!file) return;
          void file.text().then((text) => {
            const t = parseTemplate(text);
            if ("error" in t) { errorMessage(t.error); return; }
            setColumns(t.columns); units.set(t.units); precision.set(t.precision); if (totals) totals.set(t.showTotals);
          });
        });
        const exportTemplate = (): void => {
          const v = current();
          const fileName = textField("drill_chart", { key: "templateName" });
          openDialog({ title: "Export Drill Chart Template", width: 360, child: true,
            build(b) { b.append(form([["File name:", fileName.el, unitLabel(".json")]], true)); },
            ok() {
              const base = fileName.get().trim().replace(/\.json$/i, ""); if (!base) return false;
              download(base + ".json", templateJson({ name: base, version: 1, units: v.units, precision: v.precision, showTotals: !!v.totals, columns: shownColumns(v.rows) }), "application/json");
              return true;
            } });
        };
        columnsPage.push(h("div", { class: "pd-cols2", style: "margin-top:8px", "data-k": "chartOptions" },
          h("div", null, box("Include", opt("plated", "Plated holes", fl.plated), opt("npth", "Non-plated holes", fl.npth), opt("vias", "Vias", fl.vias), opt("slots", "Slots", fl.slots),
            opt("backdrill", "Backdrills", fl.backdrill), opt("castellated", "Castellated", fl.castellated)), h("div", { class: "pd-row" }, totals.el)),
          box("Group holes by", ...groups, h("p", { class: "pd-note" }, "Grouping is shared by every drill chart and drill map on the board"))),
          h("div", { class: "pd-row", style: "gap:6px;margin-top:6px" }, btn("Import Template...", "importTemplate", () => picker.click()), btn("Export Template...", "exportTemplate", exportTemplate)), picker);
      }
      // the strokes (onBorderChecked)
      const bw = lenField(v0.borderWidth >= 0 ? v0.borderWidth : NaN, { ro: ro || !(v0.external || v0.header), key: "borderWidth", allowEmpty: true });
      const sw = lenField(v0.sepWidth >= 0 ? v0.sepWidth : NaN, { ro: ro || !(v0.rowLines || v0.colLines), key: "sepWidth", allowEmpty: true });
      const sync = (): void => {
        const lw = PT().gfxWidth ? (PT().gfxWidth as (l: string) => number)(String(f.layer.get())) : 0.1;
        const b = !!f.external.get() || !!f.header.get(), s = !!f.rows.get() || !!f.cols.get();
        if (b && !(bw.get() >= 0)) bw.set(lw);
        if (s && !(sw.get() >= 0)) sw.set(lw);
        bw.input.disabled = ro || !b; sw.input.disabled = ro || !s;
      };
      f.external = checkField(v0.external, "External border", { ro, key: "external", onChange: sync }) as Field<string | number | boolean>;
      f.header = checkField(v0.header, "Header separator", { ro, key: "header", onChange: sync }) as Field<string | number | boolean>;
      f.rows = checkField(v0.rowLines, "Row separators", { ro, key: "rows", onChange: sync }) as Field<string | number | boolean>;
      f.cols = checkField(v0.colLines, "Column separators", { ro, key: "cols", onChange: sync }) as Field<string | number | boolean>;
      f.borderWidth = bw as Field<string | number | boolean>; f.sepWidth = sw as Field<string | number | boolean>;
      const book = notebook([
        { label: "General", build: (el) => { el.append(form([["Layer:", f.layer.el], ["Units:", units.el], ["Decimal places:", precision.el]], true), h("div", { class: "pd-row" }, f.locked.el)); } },
        { label: "Columns", build: (el) => { el.append(...columnsPage); } },
        { label: "Appearance", build: (el) => { el.append(f.external.el, f.header.el, f.rows.el, f.cols.el, form([["Border width:", bw.el, unitLabel()], ["Separator width:", sw.el, unitLabel()]], true)); } },
      ], { start: 0 });
      body.append(h("div", { "data-k": "generatedTable" }), book.el);
    },
    ok() {
      if (ro) return true;
      const v = current(); const err = generatedError(kind, v);
      if (err) { errorMessage(err); return false; }
      const cur = doc.items.get(item.id);
      if (!cur || cur.kind !== "table") return true;
      const r = applyGenerated(doc, cur.node, v);
      const changes: KChange[] = [K().replaceChange(doc, { ...cur, node: r.node, geom: [], bbox: null })];
      if (r.profile) changes.push(DM().profileChange(doc as never, r.profile));
      ctx.commit(changes, `Edit ${name}`);
      return true;
    } });
}

let groupsOpen: DialogApi | null = null;
/** PCB_CONTROL::ShowDrillGroups: the dialog, raised when it is already open. */
export function showDrillGroups(ctx: ToolCtx): void {
  const doc0 = ctx.doc as KDoc | null; if (!doc0 || (doc0 as { type?: string }).type !== "pcb") return;
  if (groupsOpen && document.body.contains(groupsOpen.dialog)) { groupsOpen.dialog.focus(); return; }
  const ro = !!ctx.viewOnly;
  let groups: ChartGroup[] = [], detailRow = -1, loading = false, lastVersion = -1, reloadPending = false;
  const profileName = h("span", { "data-k": "profileName" }, "-");
  const freeze = checkField(true, "Freeze assignments", { ro, key: "freeze", onChange: (on) => {
    const doc = E.kdoc as KDoc | null; if (!doc) return;
    const p = DM().cloneProfile(DM().boardProfile(doc as never)); if (p.freeze === on) return; p.freeze = on;
    commitChanges([DM().profileChange(doc as never, p)], "Drill Groups");
  } });
  const mark = selectField<number>(0, [[0, "Shape"], [1, "Letter"], [2, "Hole size text"]], { ro, key: "mark" });
  const shape = spinField(0, { min: 0, max: 63, ro, key: "shape" });
  const letter = textField("", { ro, key: "letter" }), descr = textField("", { ro, key: "description" });
  const flash = h("button", { type: "button", "data-k": "flash" }, "Flash on Canvas") as HTMLButtonElement;
  const g = grid([{ label: "Symbol", key: "symbol", type: "ro" }, { label: "Size", key: "size", type: "ro" }, { label: "Plated", key: "plated", type: "ro" },
    { label: "From / To", key: "span", type: "ro" }, { label: "Ops", key: "ops", type: "ro" }, { label: "Sites", key: "sites", type: "ro" }], [],
  { ro: true, height: "260px", key: "groups", onSelect: (i) => { if (loading) return; commitDetail(detailRow); showDetail(i); } });
  const enableDetail = (on: boolean): void => { for (const c of [mark.input, shape.input, letter.input, descr.input]) c.disabled = ro || !on; shape.enable(!ro && on); flash.disabled = !on; };
  function showDetail(row: number): void {
    loading = true;
    const valid = row >= 0 && row < groups.length; enableDetail(valid);
    if (valid) {
      const s = groups[row].symbol; mark.set(Math.max(0, MARK_MODES.indexOf(s ? s.mode : "shape"))); shape.set(s ? s.shape : 0); letter.set(s ? s.letter : ""); descr.set(s ? s.descr : "");
      if (g.selected() !== row) g.select(row);
    }
    detailRow = valid ? row : -1;
    loading = false;
  }
  function commitDetail(row: number): void {
    const doc = E.kdoc as KDoc | null;
    if (ro || loading || !doc || row < 0 || row >= groups.length) return;
    const p = assignmentEdit(doc, groups[row].key, { mode: MARK_MODES[Number(mark.get())] || "shape", shape: Math.round(Number(shape.get())), letter: letter.get(), descr: descr.get() });
    if (!p) return;
    commitChanges([DM().profileChange(doc as never, p)], "Drill Groups");
  }
  function reload(): void {
    commitDetail(detailRow);
    const doc = E.kdoc as KDoc | null; if (!doc || (doc as { type?: string }).type !== "pcb") return;
    const p = DM().boardProfile(doc as never);
    profileName.textContent = p.name ? p.name : "Default"; freeze.set(p.freeze);
    groups = drillGroups(doc);
    loading = true; g.setRows(groups.map((x) => groupRow(x) as unknown as Record<string, CellValue>)); loading = false;
    showDetail(groups.length ? 0 : -1);
    lastVersion = store.get().document.version;
  }
  const scheduleReload = (): void => { if (reloadPending) return; reloadPending = true; setTimeout(() => { reloadPending = false; if (groupsOpen) reload(); }, 0); };
  flash.addEventListener("click", () => {
    const row = g.selected(); if (row < 0 || row >= groups.length) return;
    commitDetail(detailRow);
    const doc = E.kdoc as KDoc | null; if (!doc) return;
    const ids = groups[row].members.filter((id) => doc.items.has(id)); if (!ids.length) return;
    // FocusOnItems: brightened, and the view pans to them when they are out of sight
    const c = toolCtx() as ToolCtx & { setHighlight?(s: Set<string> | null): void }; if (c.setHighlight) c.setHighlight(new Set(ids));
    let bb: number[] | null = null;
    for (const id of ids) { const b = doc.items.get(id)!.bbox; if (b) bb = bb ? [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])] : b.slice(); }
    if (bb) focusOnLocation((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2);
  });
  // BOARD_LISTENER: any change of the board reloads (once per burst)
  const unsubscribe = store.subscribe(() => { const s = store.get(); if (groupsOpen && s.document.version !== lastVersion) scheduleReload(); });
  groupsOpen = openDialog({ title: "Drill Groups", width: 640, modeless: true, noOk: true, cancelLabel: "Close",
    build(body) {
      body.append(h("div", { "data-k": "drillGroups" }), h("div", { class: "pd-row", style: "gap:6px" }, h("span", null, "Profile:"), profileName), h("div", { class: "pd-row" }, freeze.el), g.el,
        box("Selected group", form([["Mark:", mark.el], ["Shape:", shape.el], ["Letter:", letter.el], ["Description:", descr.el]], true), h("div", { class: "pd-row" }, flash)));
    },
    cancel() { commitDetail(detailRow); unsubscribe(); groupsOpen = null; } });
  if (!groupsOpen) { unsubscribe(); return; }
  reload();
}

let refreshing = false;
/** PCB_EDIT_FRAME::OnModify → RefreshGeneratedTables: folded into the edit that made them stale. */
export function generatedTablesObserver(phase: "before" | "after", _changes: unknown[], label: string | undefined, opts: unknown): void {
  if (phase !== "after" || refreshing) return;
  const o = (opts || {}) as { tentative?: boolean; discard?: boolean };
  if (o.tentative || o.discard) return;
  const doc = E.kdoc as (KDoc & { fpEditor?: unknown; type?: string }) | null;
  if (!doc || doc.type !== "pcb" || doc.fpEditor || E.viewOnly) return;
  let any = false; for (const it of doc.items.values()) if (it.kind === "table" && DM().isGeneratedKind(it.node[0])) { any = true; break; }
  if (!any) return;
  refreshing = true;
  try { const changes = generatedRefreshChanges(doc); if (changes.length) commitChanges(changes, label, { amend: true }); } finally { refreshing = false; }
}
commitObservers.push(generatedTablesObserver);
