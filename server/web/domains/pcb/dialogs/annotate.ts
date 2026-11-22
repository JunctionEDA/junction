// dialogs/annotate.ts — Tools → Annotate Schematic…: eeschema/dialogs/dialog_annotate.cpp (DIALOG_ANNOTATE).
// Scope (Entire schematic / Current sheet only / Selection), Order (by X / by Y), Numbering (first free after N,
// sheet number × 100, × 1000) and Options (keep / reset existing annotations); "Annotate" numbers the symbols in
// scope against every reference the project's sheets already use (SCH_REFERENCE_LIST over the whole hierarchy),
// "Clear Annotation" resets them to "R?".  Recurse into subsheets takes in the sheets below the current one, Regroup
// symbol units (with Reset) drops the locked unit sets, and the message panel lists AnnotateSymbols' report lines.  Other sheets are edited through their own documents, each step on
// that sheet's undo list, as Find and Replace's Replace All does.
import { E, appState, pushUndoFor, toast, toolCtx } from "./editor";
import { KD, checkbox, h, textInput, type DlgApi } from "./dom";
import { obj, projectDocs, projectJson, readDoc, saveProject, sub, submitDocOp } from "./project";
import { effectiveTheme } from "../../../shared/theme";
import { subsheetFiles, annotateSettingsFromProject, annotateProjectChanges } from "./annotate-logic";
import { currentInstance, instancePage, loadSheets, netMap } from "../editor/schnets";
import { messageBox, reportPanel, type ReportLine, infoBar } from "../editor/pcbdialogs/ui";
export { subsheetFiles };

/** BITMAPS::annotate_down_right / annotate_right_down (24 px, light and dark), beside the two sort orders. */
const ORDER_BMP: Record<string, [string, string]> = {
  x: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAQAAABKfvVzAAABcUlEQVR4AZyTA2xeURTHZ9u2/c7/vjcjmO0tmL1gtm3bCId4aJwiqm27sb6gbh+u6ser3/FpVt7Iu+kA4qcNaxxQMHVggwE6SufgM24ZF2YPkLend6FNGKID91BefQc2ay5uWj0Rz74jWzTWltMXBVWAsUWWT79wu/J7Dq9FwNNBQbJ8cz5SF7Sr3BuFDBmwdZRhuywffmy3M8ozB+tR8qGXZP8YFI5qa4/Zb9qsA4WGFCF2Bc+8vfs4rQOZ5ggRQIIx0xsfwxMdiALx4wZDKg8B24KfGkB/aSUH6BHdEMxbgAANwHu23x3PbI8ia4wAWAjjAHfymjfeTX+ljExDtA5sZb+dpRaIYst4ebBVdBi5bJW1XALQH0W2m9iIEO7wxDZIcirtq9JASDYnVn47IBmLpABfqD5eQnNV4DaeNmuOz/RNKZFeVIhy9ldr0cndEYVY+osOatPgCcqN9Qpgu8uLTK4r5nVKA1u/YuZaZJcaANc6D+SZmvZDAAAAAElFTkSuQmCC", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAQAAABKfvVzAAABc0lEQVR4AZ2UA6ybURTHZ9u2bSuY7S2YvWC2bdsIh3iKM0Tzs76e/6nbWA0e6vbq+ePV797jKsEK3pUHkEldKgZ4He3LDdBO+yEE+ByO2Nup07mNeJnVyQBwCcHo/T1YVZ50NkcmXsNBXTTA1xreCEAr1P3xjs+Hv4f4vgyIM36o+9NkWFQnWMXRAzAAX2su4tXq/vwF62MtuPM6mlYKuFvIy61e8OXWjrXxnpabgE+1EJ3AreTcZd5vAszdZABZGJts76IbBkApGCaW20fAEiagFXhrnvCR5woA13BG9GgKvpnAY9qcaDvqwm/1EoBtFP4YAJ3AqSS8Hh8VAwxBqgmsxPt4uxqlYFZiPLO5fR62s8s+z5qtAGgLf0xNXopfQuH0WpQTizR6qSUQcrl/sIq7HnJt0xQDH4kCBbaJGsDn6WawKj/HKzVEsluQD8GEVjLQlFKQjo/uenrS0A0EsVgDYuqKINPiKpkp5Ux97lfpqhECB494COOT5+8AAAAASUVORK5CYII="],
  y: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAQAAABKfvVzAAABU0lEQVR4AaWUM5zcURSF/zOxbdu6332xmthOyti2bdvugi5GFds2l+1utztsxvyd9nzvXVuOOJU4wFzZTKV4gGU4yNQdploMAG/IIBuHR7lkkcE33nCZY7pKR7WqHAS0qtGqhq732J/JtCalTTVTG5F+TGK1XiSdz2xsViowpOU80zGWLUQQNtOE3byy7H5Auyp+5iCId6ZazGWlMCflSox9sOw6lC9yhsIxAO0K6Rhe6xO6x9DpVio7SNer2tubWwSgdX1ZySe+y7rW9aPOkunCNdJkr2nvfTci0LqMXOA74+oWiGmW2hTnAxu7Fox5+GSEng1laF6+ZsGQANX5I0ukbiCgQ/jBmjYVQuTQsiYH+UWKXGCbznZNaWdBYDoOHGSY/do0ZFlNNR3JQnZznrs85TWpOLyS+6ZJtNHwhuQgh9sthnsLHRVgoJzVDskfgdjlBJq3EE2kTXGiAAAAAElFTkSuQmCC", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAQAAABKfvVzAAABVklEQVR4AZySM5xcYRTFY9u2kyZo4iq2kzK2bdu2u6Bbo1rb3v3uue+NZ9rdbndsvtnfae//6pw25ijVegCn6SGGRgNcgRkmPFOPVACgDEY0wWwTt1AjjGhAGWLxhW7QDmlYACBGi9G4awcKxBG5X/1IHodZvIYO0E38h4Fq+T739V/pKgqwy9w2yBpteTq9RIm5nQ8gD/cv9oVQUT9S8Vs13fg74pT60I43ow6/NN0UAHJX7KJS5ImlCpyW5uAZDIjHSp/bggENk/g6aiBwp2FSxCzRYk6AHq8xz6dvcEDVH/8gsKeus6Is1fVCFd+nLorDR9vwO1hB/SDfJp5TR0HGJXmCP4BNIOmWfnCQG2gMvwdDi394Qidph1jEs606ag+lEW+lGUHfWj+StvN5eom/SEc+lUIHs0OUWTc9CBBkJTOakSq22h8dGaD1+M2WWSP4tC81AA41eI6chFwMAAAAAElFTkSuQmCC"],
};

type Scope = "all" | "sheet" | "selection";
interface AnnotateOpts { order: "x" | "y"; keep: boolean; start: number; sheetInterval: number; sheetNumber?: number; only?: Set<string>; reserved?: string[]; regroup?: boolean; tracker?: { reuse: boolean; used: Set<string> } | null }
/** A sheet instance as the annotation takes it (sch-tools AnnSheet). */
interface AnnSheet { doc: KDoc; path: string | null; page: number; shown?: boolean; project?: string | null; file?: string; human?: string }
interface HSheet extends AnnSheet { docId: string; uuidPath: string[] }
interface AnnScope { all: boolean; sheets: { sheet: AnnSheet; only?: Set<string> | null }[] }
interface SchAnnotate {
  annotateChanges(doc: KDoc, opts: AnnotateOpts): KChange[];
  annotateMessages(doc: KDoc, changes: KChange[], clear?: boolean): string[];
  clearAnnotationChanges(doc: KDoc, only?: Set<string> | null): KChange[];
  incrementAnnotationChanges?(doc: KDoc, start: string, by: number): KChange[];
  annotateHierarchy(sheets: AnnSheet[], scope: AnnScope, opts: AnnotateOpts): { changes: Map<KDoc, KChange[]>; messages: string[]; errors: string[] };
  clearAnnotationHierarchy(scope: AnnScope["sheets"]): { changes: Map<KDoc, KChange[]>; messages: string[] };
  replaceDuplicateIds(docs: KDoc[]): { changes: Map<KDoc, KChange[]>; count: number };
  inferredSelection(doc: KDoc, ids: Iterable<string>): { symbols: Set<string>; sheets: Set<string> };
  serializeTracker(used: Iterable<string>): string;
  deserializeTracker(data: string): Set<string>;
  state: { refTracker?: { reuse: boolean; used: Set<string> } | null };
}
const sch = (): SchAnnotate | null => ((window as unknown as { CollabTools?: { sch?: SchAnnotate } }).CollabTools || {}).sch || null;

/**
 * What the dialog shows.  Scope, Recurse, Keep / Reset and Regroup are the app's (EESCHEMA_SETTINGS::m_AnnotatePanel,
 * kept per browser); the order, the numbering method and the start number are the project's (SCHEMATIC_SETTINGS
 * m_AnnotateSortOrder / m_AnnotateMethod / m_AnnotateStartNum), read when the dialog opens and written when it closes.
 */
const A = { scope: "all" as Scope, order: "x" as "x" | "y", numbering: "first" as "first" | "100" | "1000", start: 0, keep: true, recursive: true, regroup: false };
const PANEL_KEY = "kui.annotate.panel";
(() => {
  try {
    const v = JSON.parse(localStorage.getItem(PANEL_KEY) || "null") as { scope?: unknown; recursive?: unknown; options?: unknown; regroup_units?: unknown } | null; if (!v || typeof v !== "object") return;
    if (v.scope === "all" || v.scope === "sheet" || v.scope === "selection") A.scope = v.scope;
    if (typeof v.recursive === "boolean") A.recursive = v.recursive;
    if (typeof v.options === "number") A.keep = v.options < 1;
    if (typeof v.regroup_units === "boolean") A.regroup = v.regroup_units;
  } catch { /* no storage */ }
})();
/** ~DIALOG_ANNOTATE: the panel settings into the app's; scope and recurse only when the scope could be chosen. */
function savePanel(scopeEditable: boolean): void {
  try {
    const prev = JSON.parse(localStorage.getItem(PANEL_KEY) || "{}") as Record<string, unknown>;
    const next: Record<string, unknown> = Object.assign({}, prev, { options: A.keep ? 0 : 1, regroup_units: A.regroup });
    if (scopeEditable) { next.scope = A.scope; next.recursive = A.recursive; }
    localStorage.setItem(PANEL_KEY, JSON.stringify(next));
  } catch { /* no storage */ }
}
/** ~DIALOG_ANNOTATE: the sort order, method and start number go to the project when they differ from what it holds. */
async function storeProjectSettings(): Promise<void> {
  const cur = { sortY: A.order === "y", method: (A.numbering === "100" ? 1 : A.numbering === "1000" ? 2 : 0) as 0 | 1 | 2, startNum: A.start };
  const ch = annotateProjectChanges(obj(projectJson().schematic) as never, cur);
  if (!ch || E.viewOnly) return;
  try { await saveProject((pro) => { const s = sub(pro, "schematic"); if (ch.sort_order !== undefined) sub(pro, "schematic", "annotation").sort_order = ch.sort_order; if (ch.method !== undefined) sub(pro, "schematic", "annotation").method = ch.method; if (ch.annotate_start_num !== undefined) s.annotate_start_num = ch.annotate_start_num; }, "annotation options"); } catch { /* the project keeps its settings */ }
}

/** The annotated references of a sheet ("R1", "#PWR03"; "R?" is not one) — what the other sheets must not reuse. */
export function usedRefs(doc: KDoc): string[] {
  const out: string[] = [];
  for (const it of doc.items.values()) if (it.kind === "symbol" && it.ref && !/\?$/.test(it.ref)) out.push(it.ref);
  return out;
}
const inverseOf = (doc: KDoc, ch: KChange[]): KChange[] => ch.map((c) => { const it = doc.items.get(c.id as string); return it ? KiCadCanvas.replaceChange(doc, it) : null; }).filter(Boolean) as KChange[];

/**
 * The references the project's other sheets use, kept on the schematic module (state.otherRefs) so that placing,
 * pasting or repeating a symbol never takes a number another sheet already has.  Refreshed when a sheet opens and
 * after an annotation; a sheet edited elsewhere since then is caught by the next refresh (and by ERC).
 */
let refreshing = 0;
export async function refreshOtherRefs(): Promise<void> {
  type Unit = { ref: string; lib: string; value: string; unit: number };
  const S = (window as unknown as { CollabTools?: { sch?: { state: { otherRefs?: Set<string>; otherUnits?: Unit[] } } } }).CollabTools?.sch; if (!S || !E.kdoc || E.kdoc.type !== "sch") return;
  const mine = ++refreshing, set = new Set<string>(), units: Unit[] = [];
  for (const d of projectDocs().filter((x) => x.docType === "kicad_sch" && x.docId !== appState.docId)) {
    try {
      const doc = await readDoc(d.docId, "kicad_sch");
      for (const r of usedRefs(doc)) set.add(r);
      // which unit of which symbol holds each reference: a unit pasted or placed here may join that package
      for (const it of doc.items.values()) {
        if (it.kind !== "symbol" || !it.ref || /\?$/.test(it.ref)) continue;
        const n = it.node as SNode[], kidOf = (k: string) => n.find((c) => Array.isArray(c) && c[0] === k) as SNode[] | undefined;
        const v = n.find((c) => Array.isArray(c) && c[0] === "property" && c[1] === "Value") as SNode[] | undefined, u = kidOf("unit");
        units.push({ ref: it.ref, lib: String((kidOf("lib_id") || [])[1] || ""), value: v ? String(v[2]) : "", unit: u ? Number(u[1]) || 1 : 1 });
      }
    } catch (e) { /* unreadable sheet: its references stay unknown */ }
    if (mine !== refreshing) return;   // a newer refresh (another sheet opened) supersedes this one
  }
  S.state.otherRefs = set; S.state.otherUnits = units;
}

let api: DlgApi | null = null;   // the dialog this module opened last (KDialogs keeps one dialog at a time)
/** m_MessageWindow (WX_HTML_REPORT_PANEL): the lines AnnotateSymbols reports, actions unless they are errors. */
let report: { el: HTMLElement; set(lines: ReportLine[]): void } | null = null;
let reportLines: ReportLine[] = [];
const say = (text: string, bad = false) => {
  if (!report) return; reportLines.push({ severity: bad ? "error" : "action", text }); report.set(reportLines);
  const list = report.el.firstElementChild as HTMLElement | null; if (list) list.scrollTop = list.scrollHeight;
};
const clearReport = (): void => { reportLines = []; if (report) report.set(reportLines); };

async function otherSheets(): Promise<{ docId: string; path: string; doc: KDoc }[]> {
  const out: { docId: string; path: string; doc: KDoc }[] = [];
  for (const d of projectDocs().filter((x) => x.docType === "kicad_sch" && x.docId !== appState.docId)) {
    try { out.push({ docId: d.docId, path: d.path, doc: await readDoc(d.docId, "kicad_sch") }); } catch (e) { say(`Could not read ${d.path}: ${(e as Error).message}`, true); }
  }
  return out;
}

/**
 * The schematic's sheet instances (SCHEMATIC::Hierarchy(), sorted by page): each with its file's document, the
 * instance path its symbols record ("/<root uuid>/<sheet uuid>…") and its page number as an integer
 * (SCH_SHEET_PATH::GetPageNumberAsInt: the page when it is a number, else the virtual page), and the one on screen.
 * Without a readable hierarchy the open sheet stands alone.
 */
async function hierarchy(): Promise<{ sheets: HSheet[]; here: HSheet | null }> {
  const doc = E.kdoc as KDoc; const pro = projectDocs().find((d) => d.docType === "kicad_pro");
  const project = pro ? (pro.path.split("/").pop() || "").replace(/\.kicad_pro$/, "") : null;
  const alone = (): { sheets: HSheet[]; here: HSheet | null } => {
    const pg = parseInt(String((doc as KDoc & { pageNumber?: string }).pageNumber || ""), 10);
    const h: HSheet = { doc, path: doc.instancePath || null, page: pg > 0 ? pg : 1, shown: true, project, docId: appState.docId as string, uuidPath: [] };
    return { sheets: [h], here: h };
  };
  try { await loadSheets(); } catch (e) { /* the sheets that could be read */ }
  const c = netMap(), cur = currentInstance(c);
  if (!c || !cur || !c.instances.length) return alone();
  const idOf = new Map(projectDocs().filter((d) => d.docType === "kicad_sch").map((d) => [d.path, d.docId]));
  const rows = c.instances.filter((i) => c.docs.has(i.file) && idOf.has(i.file)).map((i, n) => ({ i, n, text: instancePage(c, i) }));
  // SCH_SHEET_LIST::SortByPageNumbers: by page number (natural order), ties in hierarchy order; the position is the virtual page
  rows.sort((a, b) => a.text.localeCompare(b.text, undefined, { numeric: true }) || a.n - b.n);
  const firstOfFile = new Set<string>(), sheets: HSheet[] = []; let here: HSheet | null = null;
  rows.forEach((r, n) => {
    const isHere = r.i === cur, d = isHere ? doc : c.docs.get(r.i.file) as KDoc;
    const h: HSheet = { doc: d, path: "/" + r.i.uuidPath.join("/"), page: /^\s*[+-]?\d+\s*$/.test(r.text) ? parseInt(r.text, 10) : n + 1, project, file: r.i.file, human: r.i.human, docId: idOf.get(r.i.file) as string, uuidPath: r.i.uuidPath };
    if (isHere) here = h;
    sheets.push(h);
  });
  // the Reference field of a file follows the instance on screen, else the file's first instance
  for (const h of sheets) { if (h.doc === doc) h.shown = h === here; else if (!firstOfFile.has(h.docId)) { firstOfFile.add(h.docId); h.shown = true; } }
  if (!here) return alone();
  return { sheets, here };
}
/** The sheet instances strictly below a path (SCH_SHEET_LIST::GetSheetsWithinPath of its sub-sheets). */
const below = (sheets: HSheet[], top: string[]): HSheet[] => sheets.filter((h) => h.uuidPath.length > top.length && top.every((u, i) => h.uuidPath[i] === u));
/**
 * ANNOTATE_SCOPE_T over the hierarchy: the entire schematic; the current sheet (with Recurse, the sheets below it);
 * or the selection — getInferredSymbols (symbols, the symbols in selected groups) on this sheet and, with Recurse, the
 * sheets below the selected sheets.
 */
function scopeOf(S: SchAnnotate, sheets: HSheet[], here: HSheet): AnnScope {
  if (A.scope === "all") return { all: true, sheets: sheets.map((sheet) => ({ sheet })) };
  if (A.scope === "sheet") return { all: false, sheets: [{ sheet: here }, ...(A.recursive ? below(sheets, here.uuidPath).map((sheet) => ({ sheet })) : [])] };
  const ids = new Set<string>(E.selection); if (E.selected) ids.add(E.selected.id);
  const sel = S.inferredSelection(E.kdoc as KDoc, ids), out: AnnScope["sheets"] = [{ sheet: here, only: sel.symbols }];
  if (A.recursive) { const seen = new Set<HSheet>(); for (const id of sel.sheets) for (const h of [...sheets.filter((x) => x.uuidPath.length === here.uuidPath.length + 1 && x.uuidPath[here.uuidPath.length] === id && here.uuidPath.every((u, i) => x.uuidPath[i] === u)), ...below(sheets, [...here.uuidPath, id])]) if (!seen.has(h)) { seen.add(h); out.push({ sheet: h }); } }
  return { all: false, sheets: out };
}
/** One step on each document: the open sheet through its tool context, the others through their own operation logs. */
async function applyChanges(sheets: HSheet[], changes: Map<KDoc, KChange[]>, label: string, failed: string): Promise<void> {
  for (const [doc, ch] of changes) {
    if (!ch.length) continue;
    if (doc === E.kdoc) { toolCtx().commit(ch, label); continue; }
    const h = sheets.find((x) => x.doc === doc); if (!h) continue;
    const inverse = inverseOf(doc, ch);
    try { await submitDocOp(h.docId, ch); } catch (e) { say(`${failed} ${h.file || ""}: ${(e as Error).message}`, true); continue; }
    pushUndoFor(h.docId, { label, changes: ch, inverse });
    for (const c of ch) KiCadCanvas.applyChange(doc, c, 1e4);
  }
}
/** The project's REFDES_TRACKER (reuse_designators, used_designators) with every designator in use (CacheExistingAnnotation). */
function projectTracker(S: SchAnnotate, sheets: HSheet[]): { reuse: boolean; used: Set<string> } {
  const sc = obj(obj(projectJson()).schematic);
  const used = S.deserializeTracker(typeof sc.used_designators === "string" ? sc.used_designators : "");
  const live = S.state.refTracker; if (live) for (const r of live.used) used.add(r);
  for (const h of sheets) for (const it of h.doc.items.values()) if (it.kind === "symbol" && it.ref && !/\?$/.test(it.ref) && it.ref[0] !== "#") used.add(it.ref);
  return { reuse: sc.reuse_designators !== false, used };
}

async function runAnnotate(): Promise<void> {
  const S = sch(); if (!S || !E.kdoc) return;
  clearReport();
  if (E.viewOnly) { say("View-only access", true); return; }
  const interval = A.numbering === "100" ? 100 : A.numbering === "1000" ? 1000 : 0;
  await storeReusedSheetMode();   // OnAnnotateClick: annotation reads the mode from the project, not from its arguments
  const { sheets, here } = await hierarchy(); if (!here) return;
  const tracker = projectTracker(S, sheets), tracked0 = S.serializeTracker(tracker.used);
  // ReplaceDuplicateTimeStamps (aRepairTimestamps): duplicate uuids across the screens get fresh ones first
  const files: KDoc[] = []; for (const h of sheets) if (!files.includes(h.doc)) files.push(h.doc);
  const rep = S.replaceDuplicateIds(files);
  if (rep.count) { await applyChanges(sheets, rep.changes, "Annotate", "Could not annotate"); say(`${rep.count} duplicate time stamps were found and replaced.`); }
  // OnAnnotateClick: regroupUnits = resetAnnotation && m_checkRegroupUnits
  const opts: AnnotateOpts = { order: A.order, keep: A.keep, start: A.numbering === "first" ? A.start : 0, sheetInterval: interval, regroup: !A.keep && A.regroup, tracker };
  const r = S.annotateHierarchy(sheets, scopeOf(S, sheets, here), opts);
  await applyChanges(sheets, r.changes, "Annotate", "Could not annotate");
  for (const l of r.messages) say(l);
  // CheckAnnotate: its errors, and "Annotation complete." only when there are none
  for (const l of r.errors) say(l.replace(/\n$/, ""), true);
  if (!r.errors.length) say("Annotation complete.");
  const tracked = S.serializeTracker(tracker.used); if (tracked !== tracked0) await storeUsedDesignators(tracked);
  if (S.state.refTracker) for (const d of tracker.used) S.state.refTracker.used.add(d);
  void refreshOtherRefs();
}

async function runClear(): Promise<void> {
  const S = sch(); if (!S || !E.kdoc) return;
  clearReport();
  if (E.viewOnly) { say("View-only access", true); return; }
  const { sheets, here } = await hierarchy(); if (!here) return;
  const r = S.clearAnnotationHierarchy(scopeOf(S, sheets, here).sheets);
  await applyChanges(sheets, r.changes, "Delete Annotation", "Could not clear");
  for (const l of r.messages) say(l);
  void refreshOtherRefs();
}

let reuseSuffix = false, initialReuse = false;
/** storeReusedSheetMode: the Reused Sheets choice written to the project when it changed. */
async function storeReusedSheetMode(): Promise<void> {
  if (reuseSuffix === initialReuse || E.viewOnly) return;
  initialReuse = reuseSuffix; const on = reuseSuffix;
  await saveProject((pro) => { sub(pro, "schematic", "annotation").reused_sheet_suffixes = on; }, "annotation options");
}
/** The project's REFDES_TRACKER after an annotation handed out designators (used_designators). */
async function storeUsedDesignators(used: string): Promise<void> {
  await saveProject((pro) => { sub(pro, "schematic").used_designators = used; }, "annotation options");
}
/**
 * DIALOG_ANNOTATE( parent, message ).  With a message (SCH_EDIT_FRAME::ModalAnnotate, from ReadyToNetlist) the dialog
 * is modal over whatever asked, its infobar shows the message, "Entire schematic" is ticked and that radio disabled.
 * The promise resolves when the dialog closes.
 */
export function openAnnotate(o?: { message?: string }): Promise<void> {
  const message = o && typeof o.message === "string" ? o.message : "";
  const scope0 = A.scope, recursive0 = A.recursive;
  if (message) A.scope = "all";
  const ps = annotateSettingsFromProject(obj(projectJson().schematic) as never);
  A.order = ps.sortY ? "y" : "x"; A.numbering = ps.method === 1 ? "100" : ps.method === 2 ? "1000" : "first"; A.start = ps.startNum;
  let closed: () => void = () => {}, gone = false;
  const done = new Promise<void>((resolve) => { closed = resolve; });
  const destroyed = (): void => {
    if (gone) return; gone = true;
    savePanel(!message);
    if (message) { A.scope = scope0; A.recursive = recursive0; }
    void Promise.all([storeProjectSettings(), storeReusedSheetMode()]).then(closed, closed);
  };
  const radio = (name: string, value: string, label: string, on: boolean, set: () => void, disabled = false) => {
    const r = h("input", { type: "radio", name, value, checked: on, disabled, id: `kd-ann-${name}-${value}` }); r.addEventListener("change", () => { if (r.checked) set(); });
    return h("label", { class: "kd-chk", style: "display:flex;gap:6px;align-items:center" }, r, label);
  };
  const box = (title: string, ...rows: HTMLElement[]) => { const b = h("div", { style: "flex:1;min-width:0" }); KD().staticBox(b, title).append(...rows); return b; };
  api = KD().open({
    title: "Annotate Schematic", width: 600, child: !!message,
    build(body) {
      if (message) { const bar = infoBar(); body.append(bar.el); bar.show(message); (bar.el.querySelector("button.x") as HTMLElement | null)?.remove(); }
      // m_MessageWindow: WX_HTML_REPORT_PANEL labelled "Annotation Messages:", saved as report.txt (SetFileName)
      reportLines = []; report = reportPanel("160px", { fileName: "report.txt", empty: "" });
      (report.el.firstElementChild as HTMLElement).setAttribute("data-ann-msgs", "1");
      report.set(reportLines);
      const messages = h("div", { style: "margin-top:10px" }); KD().staticBox(messages, "Annotation Messages:").append(report.el);
      const start = textInput(String(A.start), (v) => { A.start = Math.max(0, parseInt(v, 10) || 0); }, { id: "kd-ann-start", style: "width:70px", type: "number", min: "0" });
      const dark = effectiveTheme() === "dark";
      // bSizerXpos / bSizerYpos: the radio button, then annotate_down_right / annotate_right_down beside it
      const withBmp = (row: HTMLElement, o: string) => h("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:12px" }, row, h("img", { src: ORDER_BMP[o][dark ? 1 : 0], width: "24", height: "24", alt: "", "data-bitmap": o === "x" ? "annotate_down_right" : "annotate_right_down" }));
      const withTip = (row: HTMLElement, tip: string) => { row.title = tip; return row; };
      reuseSuffix = obj(obj(obj(projectJson()).schematic).annotation).reused_sheet_suffixes === true;
      initialReuse = reuseSuffix;
      const regroup = checkbox("Regroup symbol units", A.regroup, (on) => { A.regroup = on; }, { id: "kd-ann-regroup", disabled: A.keep });
      const regroupBox = regroup.querySelector("input") as HTMLInputElement;
      const keepChanged = (keep: boolean): void => { A.keep = keep; regroupBox.disabled = keep; regroup.style.opacity = keep ? ".5" : ""; };
      if (A.keep) regroup.style.opacity = ".5";
      // fgSizer1 (2 × 2): Scope | Order, Options | Numbering; the Reused Sheets box; then the message panel
      body.append(
        h("div", { style: "display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px 12px" },
          box("Scope", radio("scope", "all", "Entire schematic", A.scope === "all", () => { A.scope = "all"; }, !!message), radio("scope", "sheet", "Current sheet only", A.scope === "sheet", () => { A.scope = "sheet"; }),
            radio("scope", "selection", "Selection", A.scope === "selection", () => { A.scope = "selection"; }),
            checkbox("Recurse into subsheets", A.recursive, (on) => { A.recursive = on; }, { id: "kd-ann-recursive" })),
          box("Order", withBmp(radio("order", "x", "Sort symbols by X position", A.order === "x", () => { A.order = "x"; }), "x"), withBmp(radio("order", "y", "Sort symbols by Y position", A.order === "y", () => { A.order = "y"; }), "y")),
          box("Options", radio("keep", "keep", "Keep existing annotations", A.keep, () => keepChanged(true)), radio("keep", "reset", "Reset existing annotations", !A.keep, () => keepChanged(false)), regroup),
          box("Numbering", h("div", { style: "display:flex;gap:6px;align-items:center" }, radio("num", "first", "Use first free number after:", A.numbering === "first", () => { A.numbering = "first"; }), start),
            radio("num", "100", "First free after sheet number X 100", A.numbering === "100", () => { A.numbering = "100"; }),
            radio("num", "1000", "First free after sheet number X 1000", A.numbering === "1000", () => { A.numbering = "1000"; }))),
        // sbSizerReusedSheets: SCHEMATIC_SETTINGS::m_AnnotateReusedSheetSuffixes (annotation.reused_sheet_suffixes)
        h("div", { style: "margin-top:8px" }, box("Reused Sheets",
          radio("reuse", "separate", "Number each sheet instance separately (R1, R2 ...)", !reuseSuffix, () => { reuseSuffix = false; }),
          withTip(radio("reuse", "suffix", "Number each file once and add the sheet's reference suffix (R1_M1, R1_M2 ...)", reuseSuffix, () => { reuseSuffix = true; }),
            "Repeated instances of one sheet file need distinct full reference suffixes. Set Reference Suffix in Sheet Properties."))),
        messages);
    },
    buttons: [
      { label: "Clear Annotation", fn: () => { void runClear(); }, id: "kd-ann-clear" },
      { label: "Close", close: true },
      { label: "Annotate", primary: true, isDefault: true, fn: () => { void runAnnotate(); }, id: "kd-ann-run" },
    ],
    // ~DIALOG_ANNOTATE: the settings are stored whichever way the dialog closes
    cancel() {
      const st = document.getElementById("kd-ann-start") as HTMLInputElement | null; if (st) A.start = Math.max(0, parseInt(st.value, 10) || 0);
      destroyed();
    },
  });
  // the dialog can also go without its Close (another dialog replacing it): the destructor runs all the same
  const ov = api.body.closest(".kd-overlay");
  if (ov) { const mo = new MutationObserver(() => { if (!ov.isConnected) { mo.disconnect(); destroyed(); } }); mo.observe(document.body, { childList: true }); }
  return done;
}

/**
 * Tools > Increment Annotations From... (SCH_EDITOR_CONTROL::IncrementAnnotations, DIALOG_INCREMENT_ANNOTATIONS_BASE):
 * a start reference, an increment (1 to 64) and Current sheet only / All sheets; OK moves every reference of that prefix
 * numbered at least the start's up by the increment, as one "Increment Annotations" change per sheet.
 */
export function openIncrementAnnotations(): void {
  let ref: HTMLInputElement | null = null, by: HTMLInputElement | null = null, all: HTMLInputElement | null = null;
  KD().open({ title: "Increment Annotations From", width: 360,
    build(body) {
      ref = h("input", { type: "text", id: "kd-inc-ref", style: "width:100%" }) as HTMLInputElement;
      by = h("input", { type: "number", id: "kd-inc-by", min: "1", max: "64", step: "1", value: "1", style: "width:80px" }) as HTMLInputElement;
      by.addEventListener("change", () => { const v = Math.round(+by!.value); by!.value = String(Math.max(1, Math.min(64, isFinite(v) ? v : 1))); });
      const radio = (value: string, label: string, on: boolean): [HTMLInputElement, HTMLElement] => { const r = h("input", { type: "radio", name: "kd-inc-scope", value, checked: on, id: "kd-inc-" + value }) as HTMLInputElement; return [r, h("label", { class: "kd-chk", style: "display:flex;gap:6px;align-items:center;margin-top:6px" }, r, label)]; };
      const [, cur] = radio("sheet", "Current sheet only", true), [a, allRow] = radio("all", "All sheets", false); all = a;
      body.append(h("div", { style: "display:grid;grid-template-columns:max-content 1fr;gap:6px 10px;align-items:center" },
        h("label", { for: "kd-inc-ref", title: "The symbol name in library and also the default\nsymbol value when loaded in the schematic." }, "Start reference designator:"), ref, h("label", { for: "kd-inc-by" }, "Increment by:"), by), cur, allRow);
      setTimeout(() => ref && ref.focus(), 0);
    },
    ok() {
      const start = ref ? ref.value : "", step = by ? Math.max(1, Math.min(64, Math.round(+by.value) || 1)) : 1;
      // m_FirstRefDes's wxTextValidator( wxFILTER_EMPTY ): wxWidgets' own box, and the dialog stays
      if (!start) { messageBox("Validation conflict", "Required information entry is empty."); if (ref) ref.focus(); return false; }
      void runIncrement(start, step, !!(all && all.checked));
    } });
}
async function runIncrement(start: string, by: number, allSheets: boolean): Promise<void> {
  const S = sch(); if (!S || !S.incrementAnnotationChanges || !E.kdoc || E.viewOnly) return;
  const here = S.incrementAnnotationChanges(E.kdoc, start, by);
  if (here.length) toolCtx().commit(here, "Increment Annotations");
  if (allSheets) {
    for (const o of await otherSheets()) {
      const ch = S.incrementAnnotationChanges(o.doc, start, by); if (!ch.length) continue;
      const inverse = inverseOf(o.doc, ch);
      try { await submitDocOp(o.docId, ch); } catch (e) { toast(`Could not update ${o.path}: ${(e as Error).message}`); continue; }
      pushUndoFor(o.docId, { label: "Increment Annotations", changes: ch, inverse });
      for (const c of ch) KiCadCanvas.applyChange(o.doc, c, 1e4);
    }
  }
  void refreshOtherRefs();
}
