// pcbdialogs/generated-tables-model — the logic halves of the generated table and drill group dialogs
// (DIALOG_GENERATED_TABLE_PROPERTIES, PANEL_DRILL_CHART_OPTIONS, DRILL_CHART_TEMPLATE, DIALOG_DRILL_GROUPS) and
// RefreshGeneratedTables' changes: no DOM, so the node tests run them.
export type DMApi = KiCadCanvasApi["drillModel"];
export type GenColumn = import("../../canvas/drill-model").GenColumn;
export type GenKind = import("../../canvas/drill-model").GenKind;
export type GenUnits = import("../../canvas/drill-model").GenUnits;
export type ChartGroup = import("../../canvas/drill-model").ChartGroup;
export type Profile = import("../../canvas/board-setup").DrillProfile;
export type Assignment = import("../../canvas/board-setup").DrillAssignment;

const isList = Array.isArray;
export const K = (): KiCadCanvasApi => KiCadCanvas;
export const DM = (): DMApi => KiCadCanvas.drillModel;
const kid = (n: SNode | null, key: string): SNode | null => (n ? (K().kid(n, key) as SNode | null) : null);
const sval = (n: SNode | null, i = 1): string => (n && n[i] !== undefined ? String(n[i]) : "");
const nval = (n: SNode | null, i = 1, d = 0): number => (n && typeof n[i] === "number" ? (n[i] as number) : d);
const yes = (n: SNode | null): boolean => !!n && (n.length < 2 || String(n[1]) !== "no");
const f6 = (v: number): string => String(+(+v).toFixed(6));
const quote = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
interface LockApi { isLocked(n: SNode): boolean; setLocked(n: SNode, on: boolean): SNode; gfxWidth?(layer: string): number }
export const PT = (): LockApi => (globalThis as unknown as { PcbTools: LockApi }).PcbTools;
export const friendlyName = (kind: GenKind): string => (kind === "drill_chart" ? "Drill Chart" : "Stackup Table");
export const layerLabel = (doc: KDoc, name: string): string => { const l = doc.layers.get(name); return l && l.userName ? l.userName : name; };

/** g_groupKeyRows: the "Group holes by" rows, as DRILL_GROUP_KEY tokens. */
export const GROUP_KEY_ROWS: [string, string][] = [["size", "Hole size"], ["slot", "Slot shape"], ["plating", "Plating"], ["span", "Layer span"], ["operation", "Drill operation"],
  ["hole_function", "Hole function"], ["protection", "IPC-4761 protection"], ["post_machining", "Post-machining"]];
export const UNIT_CHOICES: [GenUnits, string][] = [["mm", "mm"], ["inch", "inch"], ["mils", "mils"]];
export const ALIGN_CHOICES: [string, string][] = [["left", "Left"], ["center", "Center"], ["right", "Right"]];

// ---------------------------------------------------------------- DRILL_CHART_TEMPLATE
export interface ChartTemplate { name: string; version: number; units: GenUnits; precision: number; showTotals: boolean; columns: GenColumn[] }
/** DRILL_CHART_TEMPLATE::SaveToFile's JSON (nlohmann dump( 2 ) and a newline); widths in nm. */
export function templateJson(t: ChartTemplate): string {
  const js = { name: t.name, version: t.version, units: t.units, precision: t.precision, show_totals: t.showTotals,
    columns: t.columns.map((c) => ({ id: c.id, heading: c.heading, align: c.align, width: Math.round(c.width * 1e6) })) };
  return JSON.stringify(js, null, 2) + "\n";
}
/** DRILL_CHART_TEMPLATE::LoadFromFile: the template, or the error it reports. */
export function parseTemplate(text: string): ChartTemplate | { error: string } {
  let js: unknown;
  try { js = JSON.parse(text); } catch (e) { return { error: (e as Error).message }; }
  if (!js || typeof js !== "object" || isList(js)) return { error: "Template is not a JSON object." };
  const o = js as Record<string, unknown>; const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
  const t: ChartTemplate = { name: "", version: 1, units: "mm", precision: 3, showTotals: true, columns: [] };
  if (typeof o.name === "string") t.name = o.name;
  if (isInt(o.version)) t.version = o.version;
  if (typeof o.units === "string" && (o.units === "mm" || o.units === "inch" || o.units === "mils")) t.units = o.units;
  if (isInt(o.precision)) t.precision = Math.min(6, Math.max(0, o.precision));
  if (typeof o.show_totals === "boolean") t.showTotals = o.show_totals;
  if (isList(o.columns)) {
    for (const e of o.columns as unknown[]) {
      if (!e || typeof e !== "object" || isList(e) || typeof (e as Record<string, unknown>).id !== "string") continue;
      const c = e as Record<string, unknown>;
      if (!DM().DRILL_CHART_COLUMNS.some((d) => d.id === c.id)) continue;
      const col: GenColumn = { id: c.id as string, heading: "", align: "left", width: 0, visible: true };
      if (typeof c.heading === "string") col.heading = c.heading;
      if (c.align === "left" || c.align === "center" || c.align === "right") col.align = c.align;
      if (isInt(c.width)) col.width = c.width / 1e6;
      t.columns.push(col);
    }
  }
  const v = DM().validateColumns("drill_chart", t.columns);
  if (!v.ok) return { error: "Template has no usable columns." };
  t.columns = v.columns;
  return t;
}

// ---------------------------------------------------------------- DIALOG_GENERATED_TABLE_PROPERTIES
export interface ColumnRow { col: GenColumn; shown: boolean; placed: boolean }
/** setColumns: the table's columns in order, then every column of the schema it does not have, unticked. */
export function columnRows(kind: GenKind, columns: GenColumn[]): ColumnRow[] {
  const rows: ColumnRow[] = columns.map((c) => ({ col: { ...c }, shown: c.visible, placed: true }));
  for (const d of DM().schemaOf(kind)) if (!columns.some((c) => c.id === d.id)) rows.push({ col: DM().defaultColumn(kind, d.id), shown: false, placed: false });
  return rows;
}
/** placedColumns: a column the table never had and nobody ticked stays out. */
export const placedColumns = (rows: ColumnRow[]): GenColumn[] => rows.filter((r) => r.shown || r.placed).map((r) => ({ ...r.col, visible: r.shown }));
export const shownColumns = (rows: ColumnRow[]): GenColumn[] => placedColumns(rows).filter((c) => c.visible);

export interface GeneratedValues {
  layer: string; locked: boolean; units: GenUnits; precision: number; rows: ColumnRow[];
  external: boolean; header: boolean; borderWidth: number; rowLines: boolean; colLines: boolean; sepWidth: number;
  /** the chart's options (PANEL_DRILL_CHART_OPTIONS) */
  filter?: { plated: boolean; npth: boolean; vias: boolean; slots: boolean; backdrill: boolean; castellated: boolean }; totals?: boolean; groupBy?: string[];
}
const strokeWidthOf = (n: SNode | null): number => { const st = kid(n, "stroke"), w = kid(st, "width"); return st && w ? nval(w) : -1; };

/** TransferDataToWindow. */
export function generatedValues(doc: KDoc, node: SNode): GeneratedValues {
  const g = DM().readGenerated(node), kind = g.kind; const border = kid(node, "border"), seps = kid(node, "separators");
  const v: GeneratedValues = { layer: sval(kid(node, "layer")), locked: PT().isLocked(node), units: g.units, precision: g.precision, rows: columnRows(kind, g.columns),
    external: yes(kid(border, "external")), header: yes(kid(border, "header")), borderWidth: strokeWidthOf(border),
    rowLines: yes(kid(seps, "rows")), colLines: yes(kid(seps, "cols")), sepWidth: strokeWidthOf(seps) };
  if (kind === "drill_chart") { v.filter = { ...g.filter }; v.totals = g.totals; v.groupBy = DM().boardProfile(doc as never).groupBy.slice(); }
  return v;
}
/** Validate's two refusals, or null. */
export function generatedError(kind: GenKind, v: GeneratedValues): string | null {
  const cols = shownColumns(v.rows);
  if (!cols.length) return "A table needs at least one column.";
  if (!DM().validateColumns(kind, cols).ok) return "The columns are too wide in total.";
  return null;
}
function setStroke(n: SNode, key: string, a: [string, boolean], b: [string, boolean], width: number): void {
  let i = n.findIndex((c) => isList(c) && c[0] === key);
  if (i < 0) { n.push([key]); i = n.length - 1; }
  const old = n[i] as SNode; const st = kid(old, "stroke"); const type = sval(kid(st, "type")) || "default";
  const on = a[1] || b[1];
  // strokeWidth: a stroke with neither of its lines on is written without width (-1)
  const text = `(${key} (${a[0]} ${a[1] ? "yes" : "no"}) (${b[0]} ${b[1] ? "yes" : "no"})${on ? ` (stroke (width ${f6(Math.max(0, isFinite(width) ? width : 0))}) (type ${type}))` : ""})`;
  n[i] = K().parse(text) as SNode;
}
/**
 * TransferDataFromWindow: the options into the table and the pending profile, then layer, lock, units, precision,
 * SetColumns( placedColumns ), the strokes and RebuildCells( refresh ).  The table node and the profile to store
 * (null when the grouping is as it was).
 */
export function applyGenerated(doc: KDoc, base: SNode, v: GeneratedValues): { node: SNode; profile: Profile | null } {
  const D = DM(); const laidOutTotals = D.readGenerated(base).totals;
  const before = D.boardProfile(doc as never); const refresh = { profile: D.cloneProfile(before) };
  let n = D.setGeneratedColumns(base, placedColumns(v.rows));
  const g = D.readGenerated(n);
  if (g.kind === "drill_chart" && v.filter) {
    g.filter = { ...v.filter }; g.totals = !!v.totals;
    const groupBy = GROUP_KEY_ROWS.map((r) => r[0]).filter((k) => (v.groupBy || []).includes(k));
    // the keys the rows do not show keep their state
    for (const k of before.groupBy) if (!GROUP_KEY_ROWS.some((r) => r[0] === k) && !groupBy.includes(k)) groupBy.push(k);
    refresh.profile.groupBy = groupBy;
  }
  g.units = v.units; g.precision = Math.min(6, Math.max(0, Math.round(v.precision)));
  D.writeGenerated(n, g);
  // PCB_TABLE::SetLayer: the cells follow
  const li = n.findIndex((c) => isList(c) && c[0] === "layer"); const lt = K().parse(`(layer ${quote(v.layer)})`) as SNode;
  if (li > 0) n[li] = lt; else n.splice(1, 0, lt);
  const cells = kid(n, "cells");
  if (cells) for (const cell of cells.slice(1) as SNode[]) { if (!isList(cell)) continue; const j = cell.findIndex((c) => isList(c) && c[0] === "layer"); if (j > 0) cell[j] = K().parse(`(layer ${quote(v.layer)})`) as SNode; }
  n = PT().setLocked(n, v.locked);
  setStroke(n, "border", ["external", v.external], ["header", v.header], v.borderWidth);
  setStroke(n, "separators", ["rows", v.rowLines], ["cols", v.colLines], v.sepWidth);
  n = D.rebuildGenerated(doc as never, n, refresh, laidOutTotals);
  const changed = JSON.stringify(refresh.profile) !== JSON.stringify(before);
  return { node: n, profile: changed ? refresh.profile : null };
}

// ---------------------------------------------------------------- DIALOG_DRILL_GROUPS
export const MARK_MODES: Assignment["mode"][] = ["shape", "letter", "size_text"];
/** markText. */
export function markText(a: Assignment | null, diameterNm: number): string {
  if (a && a.mode === "letter") return a.letter;
  if (a && a.mode === "size_text") return (diameterNm / 1e6).toFixed(2);
  return `Shape ${(a ? a.shape : 0) + 1}`;
}
export interface GroupRow { symbol: string; size: string; plated: string; span: string; ops: string; sites: string }
/** Reload: the board's groups (DRILL_CHART_MODEL over every span) with the symbols the cache resolved. */
export function drillGroups(doc: KDoc): ChartGroup[] {
  const D = DM(); const p = D.boardProfile(doc as never); const groups = D.buildChartModel(doc as never, p, D.enumerateDrillSpans(doc as never)).groups;
  const cache = D.drillSymbolCache(doc as never);
  for (const g of groups) { const s = cache.byGroup.get(g.key); if (s) g.symbol = s; }
  return groups;
}
export function groupRow(g: ChartGroup): GroupRow {
  return { symbol: markText(g.symbol, g.diameter), size: g.isSlot ? `${(g.sizeXY[0] / 1e6).toFixed(3)} x ${(g.sizeXY[1] / 1e6).toFixed(3)}` : (g.diameter / 1e6).toFixed(3),
    plated: g.notPlated ? "No" : "Yes", span: `${g.top} / ${g.bottom}`, ops: String(g.ops), sites: String(g.sites.length) };
}
/** commitDetail: the profile with the group's assignment set, or null when it is as stored. */
export function assignmentEdit(doc: KDoc, key: string, a: Omit<Assignment, "key">): Profile | null {
  const p = DM().cloneProfile(DM().boardProfile(doc as never)); const list = p.assignments || [];
  const existing = list.find((x) => x.key === key);
  if (existing && existing.mode === a.mode && existing.shape === a.shape && existing.letter === a.letter && existing.descr === a.descr) return null;
  const next: Assignment = { key, ...a };
  p.assignments = list.filter((x) => x.key !== key).concat([next]).sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return p;
}
// ---------------------------------------------------------------- RefreshGeneratedTables after an edit
/** The changes that bring every stale generated table up to date (and store the profile it handed out). */
export function generatedRefreshChanges(doc: KDoc): KChange[] {
  const r = DM().refreshGeneratedTables(doc as never); const out: KChange[] = [];
  for (const t of r.tables) { const it = doc.items.get(t.id); if (it) out.push(K().replaceChange(doc, { ...it, node: t.node, geom: [], bbox: null })); }
  if (r.profile) out.push(DM().profileChange(doc as never, r.profile));
  return out;
}
