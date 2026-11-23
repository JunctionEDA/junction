// dialogs/erc.ts — Inspect → Electrical Rules Checker: eeschema/dialogs/dialog_erc.cpp (DIALOG_ERC).  A modeless
// dialog with the "Violations (n)" and "Ignored Tests (n)" pages: each violation is a tree node ("Error: " /
// "Warning: " / "Excluded …: " and its message) with its items and its exclusion comment as rows under it
// (RC_TREE_MODEL); with "Cross-probe Selected Items" a click brightens the row's marker or item on the sheet and
// scrolls to it when it is out of sight (OnERCItemSelected), a double click hides the dialog; a right-click offers
// DIALOG_ERC::OnERCItemRClick's menu (exclude, exclude with comment, remove the exclusion, change the rule's severity,
// ignore it, edit the severities or the pin conflict map); "Show: All / Errors / Warnings / Exclusions" filter the
// list with their counts, "Save..." writes ERC_REPORT's text or JSON report, the options button holds the three
// cross-probe options, "Delete Marker" / "Delete All Markers" clear them and "Run ERC" runs the checks with the
// project's rule severities behind the "Tests Running..." page.
//
// Exclusions are kept in the project's erc_exclusions (ERC_SETTINGS::m_ErcExclusions) in the form its erc schema
// already uses, so a re-run excludes the same violations again (SCHEMATIC::ResolveERCExclusions).
import { bitmapButton } from "../../../shared/components/kicon-dom";
import { E, appState, focusOnLocation, openDocId, requestRender, store, toast, toolCtx } from "./editor";
import { preferInstance } from "../editor/schnets";
import { setStatusBar } from "../editor/appstore";
import { syntaxHelp } from "../editor/syntax-help";
import { KD, checkbox, download, h, popupMenu, type DlgApi, type PopItem } from "./dom";
import { badgeText, defaultSeverity, ercRuleTitle, ignoredRules, markerPrefix, sortBySeverity, stepMarker } from "./erc-rules";
import { dropRule, markExcluded, readExclusions, sameViolation, setExcluded } from "./erc-exclusions";
import { obj, projectJson, saveProject, sub } from "./project";
import { openSchematicSetup } from "./schematic-setup";
import { messageBox, textEntryBox } from "../editor/pcbdialogs/ui";
import type { Units } from "../../../shared/store";
import { ercJsonReport, ercPhaseMessages, ercTextReport, sevOf, shownBy } from "./erc-report";
import { messageText } from "../../../shared/units";
import { KICAD_BASE_VERSION } from "../canvas/version";
import { sheetList, type SheetInstance } from "./sch-hierarchy";
import { lastFallback } from "../editor/kicad-check";
import { allMarkers, distribute, ercProjectOpts, ercSource, forgetHierErc, onOpenSheet, onSheetOpened, runHierErc, runSheetList, type HierMarker } from "./erc-hier";
import { findSearchesAllSheets } from "./find";
export { ercTextReport, sevOf, shownBy };

/** An item of a violation: its place and description, the item that holds it on the sheet (`id`), a symbol pin's
 *  number or a sheet pin's name, and its own uuid. */
export interface ErcViolationItem { x: number; y: number; desc: string; len?: number; id?: string; pin?: string; sheetPin?: string; uuid?: string; /** the sheet instance of an item that is not on its marker's sheet (ERC_ITEM::GetAuxItemSheetPath) */ docId?: string; sheetPath?: string; sheetKey?: string }
export interface ErcViolation { code: string; severity: string; x: number; y: number; text: string; ids: string[]; base?: string; comment?: string; selected?: boolean; brightened?: boolean; items?: ErcViolationItem[] }

/** The rule title KiCad shows for a violation (ERC_ITEM::GetErrorText), falling back to the marker's own text. */
export function ruleTitle(v: Pick<ErcViolation, "code" | "text">): string { return ercRuleTitle(v.code) || unescape(v.text); }
/** RC_ITEM::GetErrorMessage: the violation's own message, the rule's title when it has none. */
export function errorMessage(v: Pick<ErcViolation, "code" | "text">): string { return v.text ? unescape(v.text) : ruleTitle(v); }
/** ERC_TREE_MODEL::GetValue of a marker row: "Error: " / "Warning: " / "Excluded …: " and the message on one line. */
export function markerRowText(m: ErcViolation): string { return (markerPrefix(m) + errorMessage(m)).replace(/\n/g, " "); }
const fmt = (v: number): string => (Math.round(v * 10000) / 10000).toFixed(4).replace(/\.?0+$/, "");
/** The item line under a violation: "@(76.2 mm, 41.9 mm): Symbol R1 is not annotated" (millimetres as the status bar). */
export function itemLine(v: Pick<ErcViolation, "x" | "y" | "text">): string { return `@(${fmt(v.x)} mm, ${fmt(v.y)} mm): ${unescape(v.text)}`; }
/** UnescapeString: net and label names are shown as typed ({slash} → /), as KiCad's GetShownText. */
const unescape = (s: string): string => { const K = (window as unknown as { KiCadCanvas?: { unescapeText?(s: string): string } }).KiCadCanvas; return K && K.unescapeText ? K.unescapeText(s) : s; };
/** The rules the project sets to "ignore" (the report's ignored checks), in dialog order. */
export function ignoredTests(severities: Record<string, unknown>): string[] { return ignoredRules(severities).map(([title]) => title); }
const severities = (): Record<string, unknown> => obj(obj(projectJson().erc).rule_severities) as Record<string, unknown>;
/** ERC_SETTINGS::GetSeverity of a rule. */
export function severityOf(code: string, sev: Record<string, unknown> = severities()): string { return typeof sev[code] === "string" ? String(sev[code]) : defaultSeverity(code); }

// ---------------------------------------------------------------- exclusions (SCH_MARKER::SetExcluded)
/** An excluded marker shows as an exclusion, its rule's severity kept as base. */
export const isExcluded = (m: Pick<ErcViolation, "severity">): boolean => m.severity === "exclusion";
/** Apply the project's exclusions to the marker list (SCHEMATIC::ResolveERCExclusions). */
export function withExclusions<T extends ErcViolation>(list: T[]): T[] { return markExcluded(list, readExclusions(obj(projectJson().erc))) as T[]; }
/** The same violation in another copy of the marker list (the rule, the position and the items). */
const sameMarker = (a: ErcViolation, b: ErcViolation): boolean => sameViolation(a, { ...b, comment: "" }) && a.ids.join(",") === b.ids.join(",");
/** SCH_MARKER::SetExcluded + RecordERCExclusions: add, re-comment or drop the violation's entry in the .kicad_pro, then re-resolve. */
function storeExclusion(m: ErcViolation, on: boolean, comment = ""): Promise<void> {
  if (E.viewOnly) { toast("View-only access"); return Promise.resolve(); }
  return saveProject((pro) => { setExcluded(sub(pro, "erc") as never, { ...m, severity: sevOf(m) }, on, comment); }, on ? "ERC exclusion" : "remove ERC exclusion")
    .then(() => { publishMarkers(withExclusions(markers())); })
    .catch((e: Error) => toast(`Could not change the exclusion: ${e.message}`, 5000));
}

interface SchModule { actions?: Record<string, { run(ctx: unknown, opts?: unknown): unknown }>; state: { markers?: ErcViolation[] }; itemDescription?(d: KDoc, id: string, u: string): string }
const sch = (): SchModule | null => ((window as unknown as { CollabTools?: { sch?: SchModule } }).CollabTools || {}).sch || null;
/** The open sheet's markers (on the canvas). */
const liveMarkers = (): ErcViolation[] => ((E as unknown as { markers?: ErcViolation[] }).markers || []).filter((m) => m && typeof m.code === "string");
/** Every marker of the hierarchy the last Run ERC found (the open sheet's are the canvas list itself), as
 *  SHEETLIST_ERC_ITEMS_PROVIDER lists them: errors, then warnings, then exclusions, each in sheet order. */
export const markers = (): ErcViolation[] => sortBySeverity(allMarkers(liveMarkers() as unknown as HierMarker[]) as unknown as ErcViolation[]);
const hereDoc = (): string | null => (appState as unknown as { docId: string | null }).docId;
/** Hand a changed marker list (or the same list, changed) to the canvas and the module: each sheet keeps its own. */
function publishMarkers(all: ErcViolation[]): void {
  const l = distribute(all as unknown as HierMarker[]) as unknown as ErcViolation[];
  const s = sch(); if (s) s.state.markers = l;
  const EE = E as unknown as { markers: unknown[]; renderOpts: Record<string, unknown> };
  EE.markers = l; EE.renderOpts.markers = l.length ? l : undefined; store.slice("viewport", { renderOpts: Object.assign({}, EE.renderOpts) }); requestRender();
}

// ---------------------------------------------------------------- the canvas side: the marker selected on the sheet
/** The marker selected on the canvas (SCH_SELECTION_TOOL with a SCH_MARKER_T), or null. */
export function selectedMarker(): ErcViolation | null { return markers().find((m) => m.selected) || null; }
export function selectMarker(m: ErcViolation | null): void { for (const x of markers()) if (x.selected && x !== m) delete x.selected; if (m) m.selected = true; requestRender(); }
/** The marker of the current list that is `m` (exclusions re-resolve the list into fresh copies). */
const resolveMarker = (m: ErcViolation | null): ErcViolation | null => (m ? markers().find((x) => x === m) || markers().find((x) => sameMarker(x, m)) || null : null);

// ---------------------------------------------------------------- DIALOG_ERC::OnERCItemRClick's Inspect / Fix entries
type Handlers = Record<string, ((a?: unknown) => void) | undefined>;
const handlers = (): Handlers => ((E as unknown as { api?: { HANDLERS?: Handlers } }).api?.HANDLERS) || {};
/** The violation's main item, selected on the sheet (ResolveItem( GetMainItemID() )), or null. */
function mainItem(m: ErcViolation): KItem | null {
  const d = E.kdoc as KDoc | null, id = m.ids.find((x) => d && d.items.has(x)); if (!d || !id) return null;
  return d.items.get(id) || null;
}
function runOn(m: ErcViolation, act: string): void {
  const it = mainItem(m), h = handlers()[act]; if (!it || !h) return;
  toolCtx().setSelection([it.id]); h();
}
/**
 * SCH_INSPECTION_TOOL::InspectERCErrorMenuText / InspectERCError, then SCH_EDIT_TOOL::FixERCErrorMenuText / FixERCError
 * (a command the web editor does not have is listed disabled).
 */
export function fixEntries(m: ErcViolation): PopItem[] {
  const out: PopItem[] = [], hs = handlers();
  const run = (label: string, act: string, fn: () => void): void => { out.push(hs[act] ? { label, run: fn } : { label, disabled: true }); };
  if (m.code === "bus_to_net_conflict") out.push({ label: "Run: Inspect > Show Bus Syntax Help", run: () => syntaxHelp(false) });
  else if (m.code === "lib_symbol_mismatch") run("Run: Inspect > Compare Symbol with Library", "diffSymbol", () => runOn(m, "diffSymbol"));
  switch (m.code) {
    case "simulation_model_issue": case "footprint_filter": case "footprint_link_issues":
      run("Edit Symbol Properties...", "properties", () => runOn(m, "properties")); break;
    case "lib_symbol_issues": run("Run: Preferences > Manage Symbol Libraries...", "showSymbolLibTable", () => hs.showSymbolLibTable?.()); break;
    case "lib_symbol_mismatch": run("Run: Update Symbol...", "updateSymbol", () => runOn(m, "updateSymbol")); break;
    case "unannotated": case "duplicate_reference": run("Run: Tools > Annotate Schematic...", "annotate", () => hs.annotate?.()); break;
    case "undefined_netclass": out.push({ label: "Edit Netclasses...", run: () => openSchematicSetup("Net Classes") }); break;
    case "empty_label_name": out.push({ label: "Remove Empty Label", run: () => {
      const it = mainItem(m), s = sch() as (SchModule & { _?: { deleteChanges?(d: KDoc, it: KItem): KChange[] } }) | null, ctx = toolCtx();
      if (!it || !/label$/.test(it.kind) || !s || !s._ || !s._.deleteChanges) return;
      ctx.setSelection([]); ctx.commit(s._.deleteChanges(ctx.doc as KDoc, it), "Remove Empty Label");
    } }); break;
  }
  return out;
}

let api: DlgApi | null = null;   // the dialog this module opened last (KDialogs keeps one dialog at a time)
/** The open dialog's handles (SCH_INSPECTION_TOOL::PrevMarker / NextMarker / ExcludeMarker / CrossProbe reach DIALOG_ERC only while it exists). */
let live: { step(dir: 1 | -1): void; show(m: ErcViolation): void; exclude(m: ErcViolation | null): void; refresh(): void; hidden(): boolean; unhide(): void } | null = null;
const isLive = (): boolean => { if (live && api && api.body.isConnected) return true; if (live) { live = null; ercClearFocus(); } return false; };
export function ercPrevMarker(): void { if (isLive()) live!.step(-1); else { openErc(); if (isLive()) live!.step(-1); } }
export function ercNextMarker(): void { if (isLive()) live!.step(1); else { openErc(); if (isLive()) live!.step(1); } }
/** SCH_INSPECTION_TOOL::ExcludeMarker: the marker selected on the canvas, else the dialog's current row. */
export function ercExcludeMarker(): void {
  const m = selectedMarker();
  if (isLive()) { live!.exclude(m); return; }
  if (m && !isExcluded(m)) void storeExclusion(m, true);
}
/** SCH_INSPECTION_TOOL::CrossProbe( marker ): the dialog comes up (or forward) with the marker's row picked. */
export function ercCrossProbe(m: ErcViolation, open: boolean): void {
  if (!isLive()) { if (!open) return; openErc(); }
  if (isLive()) live!.show(m);
}
/** nextMatch's order over a screen's markers (top to bottom, then left to right); excluded ones are skipped. */
const screenOrder = (l: ErcViolation[]): ErcViolation[] => l.filter((m) => !isExcluded(m)).sort((a, b) => (a.y - b.y) || (a.x - b.x));
/** The found marker: selected alone and centred (FindNext's ClearSelection / AddItemToSel / FocusOnLocation). */
function focusMarker(m: ErcViolation): void {
  const ctx = toolCtx(); ctx.setSelection([]); selectMarker(m);
  focusOnLocation(m.x, m.y, true, dialogRects());   // FocusOnLocation: only when out of sight, the zoom kept
  if (isLive()) live!.show(m);
  const hooks = (E as unknown as { hooks?: { markerSelectionChanged?: () => void } }).hooks; if (hooks && hooks.markerSelectionChanged) hooks.markerSelectionChanged();
}
/** SCH_ACTIONS::changeSheet to a run's sheet instance, then `then` once it is on screen. */
function changeSheet(sh: { docId: string; sheetPath: string }, then: () => void): void {
  preferInstance(sh.sheetPath);
  if (sh.docId === hereDoc()) { onSheetOpened(); then(); return; }
  const before = E.kdoc; openDocId(sh.docId);
  let tries = 0; const wait = (): void => { if (E.kdoc && E.kdoc !== before && hereDoc() === sh.docId) { onSheetOpened(); then(); return; } if (++tries < 100) setTimeout(wait, 100); };
  setTimeout(wait, 100);
}
/**
 * Find Next Marker (Ctrl+Shift+F3, SCH_FIND_REPLACE_TOOL::FindNext with data.markersOnly): nextMatch walks the current
 * screen's markers after the found one; past the last, unless the Find dialog searches the current sheet only, the
 * sheets that follow in page order (SCH_ACTIONS::changeSheet to the first with a marker); then it wraps around
 * ("Reached end of schematic.").  Another sheet's markers are never selected without opening that sheet.
 */
export function findNextMarker(): boolean {
  const here = screenOrder(liveMarkers()), cur = here.find((m) => m.selected) || null;
  const i = cur ? here.indexOf(cur) : -1;
  if (i + 1 < here.length) { focusMarker(here[i + 1]); return true; }
  const { sheets, open } = runSheetList();
  const firstOn = (k: number): ErcViolation | null => { const l = screenOrder((sheets[k].markers as unknown as ErcViolation[])); return l[0] || null; };
  const goTo = (k: number, wrapped: boolean): boolean => {
    if (k === open) { const m = here[0]; if (!m) return false; focusMarker(m); }
    else changeSheet(sheets[k], () => { const m = screenOrder(liveMarkers())[0]; if (m) focusMarker(m); });
    if (wrapped) setStatusBar({ message: "Reached end of schematic." });
    return true;
  };
  if (findSearchesAllSheets() && sheets.length && open >= 0) {
    // a fresh session (nothing found yet) starts at the first sheet; else at the one after the current sheet
    for (let k = cur ? open + 1 : 0; k < sheets.length; k++) if (k !== open && firstOn(k)) return goTo(k, false);
    if (!cur) { setStatusBar({ message: "No matches found." }); return false; }
    for (let k = 0; k < sheets.length; k++) if (k === open ? here.length : firstOn(k)) return goTo(k, true);
    return false;
  }
  if (!here.length) { setStatusBar({ message: "No matches found." }); return false; }
  focusMarker(here[0]);
  if (cur) setStatusBar({ message: findSearchesAllSheets() ? "Reached end of schematic." : "Reached end of sheet." });
  return true;
}

// ---------------------------------------------------------------- the dialog's persisted options (DIALOG_ERC m_crossprobe …)
const OPTS_KEY = "kui.erc.options";
/** The three options of the menu button, and the "Show:" boxes (DIALOG_SHIM keeps a dialog's control state across sessions). */
const opts = ((): { crossprobe: boolean; scrollOnCrossprobe: boolean; showAllErrors: boolean; show: { errors: boolean; warnings: boolean; exclusions: boolean } } => {
  const d = { crossprobe: true, scrollOnCrossprobe: true, showAllErrors: false, show: { errors: true, warnings: true, exclusions: false } };
  try {
    const s = JSON.parse(localStorage.getItem(OPTS_KEY) || "null");
    if (s && typeof s === "object") { const sh = s.show; Object.assign(d, s, { show: d.show }); if (sh && typeof sh === "object") for (const k of ["errors", "warnings", "exclusions"] as const) if (typeof sh[k] === "boolean") d.show[k] = sh[k]; }
  } catch { /* storage blocked */ }
  return d;
})();
const saveOpts = (): void => { try { localStorage.setItem(OPTS_KEY, JSON.stringify(opts)); } catch { /* storage blocked */ } };
export function ercShowAllErrors(): boolean { return opts.showAllErrors; }
const show = opts.show;

/** g_lastERCRun / g_lastERCIgnored: whether the ERC has run on a project's schematic, and the ignored tests listed at that run. */
const runStates = new Map<string, { run: boolean; ignored: [string, string][] }>();
function runState(): { run: boolean; ignored: [string, string][] } {
  const p = (appState as unknown as { project: { projectId: string } | null }).project, k = p ? p.projectId : "";
  let st = runStates.get(k); if (!st) runStates.set(k, st = { run: false, ignored: [] });
  return st;
}

/** wxDateTime::Now().FormatISOCombined('T'): local time, no zone. */
const isoNow = (): string => { const d = new Date(), p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

// ---------------------------------------------------------------- SCH_EDIT_FRAME::FocusOnItem
/** The dialog's rectangle on screen while it is shown (EDA_DRAW_FRAME::findDialogs). */
function dialogRects(): { left: number; top: number; width: number; height: number }[] {
  if (!api || !api.dlg.isConnected) return [];
  const r = api.dlg.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? [r] : [];
}
let brightMarker: ErcViolation | null = null;
/** The one brightened item (lastBrightenedItemID): a marker, or an item named as the canvas names it ("id", "id#pin:3"). */
function setBrightened(marker: ErcViolation | null, key: string | null): void {
  for (const x of markers()) if (x.brightened && x !== marker) delete x.brightened;
  if (brightMarker && brightMarker !== marker) delete brightMarker.brightened;
  brightMarker = marker; if (marker) marker.brightened = true;
  const EE = E as unknown as { renderOpts: Record<string, unknown> };
  if (key) EE.renderOpts.schBrightened = new Set([key]); else delete EE.renderOpts.schBrightened;
  store.slice("viewport", { renderOpts: Object.assign({}, EE.renderOpts) }); requestRender();
}
/** SCH_EDIT_FRAME::ClearFocus. */
export function ercClearFocus(): void { setBrightened(null, null); }
/** The item of a violation on the open sheet as the canvas names it: a symbol pin and a sheet pin are sub-items of their owner. */
function itemKey(it: ErcViolationItem): string | null {
  const d = E.kdoc as KDoc | null; if (!d || !it.id) return null;
  const owner = d.items.get(it.id); if (!owner) return null;
  if (it.pin !== undefined) return `${it.id}#pin:${it.pin}`;
  if (it.sheetPin !== undefined) return `${it.id}#pin:${it.sheetPin}`;
  if (it.uuid && it.uuid !== it.id) {
    // KiCad's report names a pin by its own uuid: the owner's (pin "3" (uuid …)) or a sheet's (pin "NAME" … (uuid …))
    for (const p of KiCadCanvas.kids(owner.node, "pin")) { const u = KiCadCanvas.kid(p as SNode, "uuid"); if (u && String(u[1]) === it.uuid) return `${it.id}#pin:${KiCadCanvas.str(p[1] as SNode)}`; }
  }
  return it.id;
}

/** The row of the violation tree that is picked: the marker itself (-1), one of its items, or its comment. */
type RowPart = number | "comment";

export function openErc(): void {
  // a dialog hidden by a double click comes back as it was (Show( true )), its list cursor kept
  if (isLive() && api && live && live.hidden()) { live.unhide(); return; }
  let list: HTMLElement, vioTab: HTMLElement | null = null, ignTab: HTMLElement | null = null, ignHost: HTMLElement | null = null, current: ErcViolation | null = null, part: RowPart = -1;
  let nb: { select(i: number): void; index(): number } | null = null;
  let infoBar: HTMLElement | null = null, resultsEl: HTMLElement | null = null, runningEl: HTMLElement | null = null, messages: HTMLElement | null = null;
  let running = false, cancelled = false, closeIsDefault = false, notAnnotated = 0;
  let abort: AbortController | null = null;
  const st = runState();
  const shown = (m: ErcViolation): boolean => shownBy(m, show);
  const footBtn = (id: string): HTMLButtonElement | null => (api ? api.dlg.querySelector<HTMLButtonElement>(`#${id}, [data-btn="${id}"]`) : null);
  const closeBtn = (): HTMLButtonElement | null => (api ? Array.from(api.foot.querySelectorAll<HTMLButtonElement>("button")).find((b) => !b.id && !b.dataset.btn) || null : null);
  // m_ignoredList: the tests ignored at the last Run ERC, plus the ones ignored from the list since
  const fillIgnored = () => {
    if (ignTab) ignTab.textContent = st.run ? `Ignored Tests (${st.ignored.length})` : "Ignored Tests";
    if (!ignHost) return;
    ignHost.replaceChildren(...st.ignored.map(([title, code], i) => {
      const row = h("div", { "data-erc-ignored-row": code, style: "cursor:default" }, " • " + title);
      // OnIgnoredItemRClick: Error / Warning / Ignore as radio items; another severity takes the test off the list
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault(); const cur = severityOf(code);
        const choose = (sev: string): void => { if (sev === cur) return; setRuleSeverity(code, sev, () => { st.ignored.splice(i, 1); refresh(); }); };
        popupMenu((ev as MouseEvent).clientX, (ev as MouseEvent).clientY, [
          { label: "Error", check: true, checked: cur === "error", run: () => choose("error") },
          { label: "Warning", check: true, checked: cur === "warning", run: () => choose("warning") },
          { label: "Ignore", check: true, checked: cur === "ignore", run: () => choose("ignore") }]);
      });
      return row;
    }));
  };
  // updateDisplayedCounts: no counts on the tabs and blank error / warning badges until the ERC has run
  const refresh = () => {
    const all = markers(), errors = all.filter((m) => m.severity === "error").length, excl = all.filter(isExcluded).length, warnings = all.length - errors - excl;
    const rows = all.filter(shown);
    if (vioTab) vioTab.textContent = st.run ? `Violations (${rows.length})` : "Violations";
    const cnt = api && api.body.querySelectorAll<HTMLElement>("[data-erc-count]"); if (cnt) cnt.forEach((e) => {
      e.textContent = e.dataset.ercCount === "errors" ? badgeText(errors, st.run) : e.dataset.ercCount === "warnings" ? badgeText(warnings, st.run) : badgeText(excl, true);
    });
    list.innerHTML = "";
    current = resolveMarker(current);
    for (const m of rows) {
      const i = all.indexOf(m), ex = isExcluded(m);
      // RC_TREE_MODEL::GetAttr: the marker row bold, every row of an excluded marker dimmed and italic
      const style = (p: RowPart, indent: boolean): string => `padding:2px 6px${indent ? " 2px 22px" : ""};cursor:default;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${ex ? "font-style:italic;" : ""}${m === current && part === p ? "background:var(--blue);color:var(--panel)" : ex ? "color:var(--ink-3)" : ""}`;
      const row = (p: RowPart, text: string, attrs: Record<string, string | undefined>): HTMLElement => {
        const el = h("div", { ...attrs, style: style(p, p !== -1) + (p === -1 ? ";font-weight:bold" : ""), title: text }, text);
        el.addEventListener("click", () => pick(m, false, false, p));
        el.addEventListener("dblclick", () => hide());
        el.addEventListener("contextmenu", (ev) => { const me = ev as MouseEvent; me.preventDefault(); pick(m, false, false, p); rowMenu(m, me.clientX, me.clientY); });
        return el;
      };
      const node = h("div", { "data-erc-node": String(i), "data-excluded": ex ? "1" : undefined },
        row(-1, markerRowText(m), { "data-erc-row": String(i) }),
        // MAIN_ITEM, AUX_ITEM, AUX_ITEM2, AUX_ITEM3: the item's description alone; then the exclusion's comment
        ...(m.items || []).slice(0, 4).map((it, k) => row(k, unescape(itemText(it)).replace(/\n/g, " "), { "data-erc-item": String(k) })),
        ex && m.comment ? row("comment", m.comment.replace(/\n/g, " "), { "data-erc-comment": "1" }) : null);
      list.append(node);
    }
    fillIgnored();
  };
  const itemText = (it: ErcViolationItem): string => (it.len !== undefined ? it.desc.replace("%L", messageText(it.len, (E.units === "in" || E.units === "mil" ? E.units : "mm") as Units, "sch")) : it.desc);
  const scrollToRow = (): void => {
    const node = current ? list.querySelector<HTMLElement>(`[data-erc-node="${markers().indexOf(current)}"]`) : null;
    const row = node ? (part === -1 ? node.firstElementChild : part === "comment" ? node.querySelector("[data-erc-comment]") : node.querySelector(`[data-erc-item="${part}"]`)) as HTMLElement | null : null;
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  };
  // DIALOG_ERC::OnERCItemSelected: nothing without cross-probing; else the row's marker or item is brightened on its
  // sheet (SCH_EDIT_FRAME::FocusOnItem: the selection is left alone) and scrolled to when it is out of sight
  const pick = (m: ErcViolation, fromCanvas = false, opened = false, p: RowPart = -1): void => {
    current = m; part = p;
    if (fromCanvas || !opts.crossprobe) { refresh(); scrollToRow(); return; }
    const it = typeof p === "number" && p >= 0 && m.items ? m.items[p] : null;
    // an item the sheet no longer has ("(Deleted Item)"): nothing to show
    if (typeof p === "number" && p >= 0 && (!it || !it.id)) { refresh(); scrollToRow(); return; }
    // a marker on another sheet: that sheet opens (SCH_ACTIONS::changeSheet), then it is focused there; an item row goes
    // to the item's own sheet (MainItemHasSheetPath / AuxItemHasSheetPath), which can be another than its marker's
    const where = (it && it.docId ? it : m) as { docId?: string; sheetPath?: string; sheetKey?: string };
    if (!opened && !onOpenSheet(where)) {
      const own = where, target = own.docId!, before = E.kdoc;
      // the instance of a sheet used more than once (SCH_SHEET_PATH): the hierarchy shows that one
      preferInstance(own.sheetPath || null);
      if (target === hereDoc()) { onSheetOpened(); pick(m, false, true, p); return; }
      openDocId(target);
      let tries = 0; const wait = (): void => { if (E.kdoc && E.kdoc !== before && hereDoc() === target) { onSheetOpened(); pick(resolveMarker(m) || m, false, true, p); return; } if (++tries < 100) setTimeout(wait, 100); };
      setTimeout(wait, 100); refresh(); return;
    }
    if (it) { const key = itemKey(it); if (key) { setBrightened(null, key); focusOnLocation(it.x, it.y, opts.scrollOnCrossprobe, dialogRects()); } }
    else { setBrightened(m, null); focusOnLocation(m.x, m.y, opts.scrollOnCrossprobe, dialogRects()); }
    refresh(); scrollToRow();
  };
  const shownRows = () => markers().map((m, i) => [m, i] as const).filter(([m]) => shown(m)).map(([, i]) => i);
  const exclude = (m: ErcViolation, on: boolean, comment = "") => { void storeExclusion(m, on, comment).then(refresh); };
  // WX_TEXT_ENTRY_DIALOG( …, _( "Exclusion Comment" ), …, true ): a multi-line entry
  const askComment = (initial: string, then: (text: string) => void): void => { textEntryBox("Exclusion Comment", "", initial, true, then); };
  // ERC_SETTINGS::SetSeverity into the .kicad_pro
  const setRuleSeverity = (code: string, sev: string, then: () => void): void => {
    if (E.viewOnly) { toast("View-only access"); return; }
    void saveProject((pro) => { const e = sub(pro, "erc"); sub(e, "rule_severities")[code] = sev; if (sev === "ignore") dropRule(e as never, code); }, "ERC severity").then(then)
      .catch((e: Error) => toast(`Could not change the severity: ${e.message}`, 5000));
  };
  // OnERCItemRClick's severity entries: Ignore lists the test under Ignored Tests, drops the rule's exclusions and deletes
  // the markers of the clicked code (ScreenList.DeleteMarkers: a pin conflict's errors and warnings are two codes, and
  // only an error takes the warnings' severity with it); the others take the new level (an exclusion keeps it as its base)
  const setSeverity = (m: ErcViolation, sev: string) => {
    const code = m.code, own = sevOf(m);
    setRuleSeverity(code, sev, () => {
      let all = markers();
      if (sev === "ignore") {
        st.ignored.push([ruleTitle(m), code]);
        toolCtx().setSelection([]); selectMarker(null);
        const gone = (x: ErcViolation): boolean => x.code === code && (code !== "pin_to_pin" || sevOf(x) === own);
        all = all.filter((x) => !gone(x)); if (current && gone(current)) { current = null; ercClearFocus(); }
      } else for (const x of all) if (x.code === code) { if (isExcluded(x)) x.base = sev; else x.severity = sev; }
      publishMarkers(all); refresh();
    });
  };
  const rowMenu = (m: ErcViolation, x: number, y: number) => {
    const sev = severityOf(m.code), et = ruleTitle(m);
    // the menu entries' help strings: listName follows the rule's severity (settings.GetSeverity)
    const listName = sev === "error" ? "errors" : sev === "warning" ? "warnings" : "appropriate", SETUP = "Open the Schematic Setup dialog", ALSO = "Violation severities can also be edited in Schematic Setup";
    const items: PopItem[] = isExcluded(m)
      ? [{ label: "Remove exclusion for this violation", title: `It will be placed back in the ${listName} list`, run: () => exclude(m, false) },
         { label: "Edit exclusion comment...", run: () => askComment(m.comment || "", (t) => exclude(m, true, t)) }]
      : [{ label: "Exclude this violation", title: `It will be excluded from the ${listName} list`, run: () => exclude(m, true) },
         { label: "Exclude with comment...", title: `It will be excluded from the ${listName} list`, run: () => askComment("", (t) => exclude(m, true, t)) }];
    items.push({ sep: true });
    // SCH_INSPECTION_TOOL::InspectERCErrorMenuText then SCH_EDIT_TOOL::FixERCErrorMenuText, a separator after them
    const fixes = fixEntries(m); if (fixes.length) items.push(...fixes, { sep: true });
    if (m.code !== "pin_to_pin") {
      if (sev === "warning") items.push({ label: `Change severity to Error for all '${et}' violations`, title: ALSO, run: () => setSeverity(m, "error") });
      else items.push({ label: `Change severity to Warning for all '${et}' violations`, title: ALSO, run: () => setSeverity(m, "warning") });
    }
    items.push({ label: `Ignore all '${et}' violations`, title: "Violations will not be checked or reported", run: () => setSeverity(m, "ignore") }, { sep: true });
    if (m.code === "pin_to_pin") items.push({ label: "Edit pin-to-pin conflict map...", title: SETUP, run: () => openSchematicSetup("Pin Conflicts Map") });
    else items.push({ label: "Edit violation severities...", title: SETUP, run: () => openSchematicSetup("Violation Severity") });
    if (m.code === "endpoint_off_grid") items.push({ label: "Edit connection grid spacing...", title: SETUP, run: () => openSchematicSetup("Formatting") });
    popupMenu(x, y, items);
  };
  // OnERCItemDClick: Show( false ) on the modeless dialog, nothing destroyed
  const overlay = (): HTMLElement | null => (api ? api.dlg.parentElement : null);
  const hide = (): void => { const ov = overlay(); if (ov) ov.style.display = "none"; };
  live = {
    // DIALOG_ERC::PrevMarker / NextMarker: the Violations page first, then the marker row before / after
    step(dir) {
      this.unhide(); if (nb && nb.index() !== 0) nb.select(0);
      const all = markers(), cur = resolveMarker(current), i = stepMarker(shownRows(), cur ? all.indexOf(cur) : -1, dir); const m = i === null ? null : all[i]; if (!m) return;
      pick(m);
    },
    show(m) { this.unhide(); if (nb) nb.select(0); pick(m, true); },
    exclude(m) { const t = resolveMarker(m || current); if (t && !isExcluded(t)) exclude(t, true); },
    refresh() { refresh(); },
    hidden() { const ov = overlay(); return !!ov && ov.style.display === "none"; },
    unhide() { const ov = overlay(); if (ov && ov.style.display === "none") ov.style.display = ""; },
  };
  const hierDocs = async (): Promise<KDoc[]> => {
    let l: SheetInstance[] = []; try { l = await sheetList(); } catch { l = []; }
    const here = hereDoc(), cur = E.kdoc as KDoc | null;
    if (!l.length || !l.some((x) => x.docId === here)) return cur ? [cur] : [];
    return l.map((x) => (x.docId === here && cur ? cur : x.doc));
  };
  // UpdateAnnotationWarning: SCH_EDIT_FRAME::CheckAnnotate over the whole schematic; the bar shows while it finds anything
  const updateAnnotationWarning = async (): Promise<number> => {
    const s = sch() as (SchModule & { checkAnnotate?(docs: KDoc[]): number }) | null; let n = 0;
    try { n = s && s.checkAnnotate ? s.checkAnnotate(await hierDocs()) : 0; } catch { n = 0; }
    if (infoBar) infoBar.style.display = n ? "flex" : "none";
    return n;
  };
  const report = (text: string, head = false): void => { if (!messages) return; const line = h("div", { style: "margin-bottom:8px" }, text); if (head) messages.prepend(line); else messages.append(line); messages.scrollTop = messages.scrollHeight; };
  const showRunning = (on: boolean): void => { if (resultsEl) resultsEl.style.display = on ? "none" : ""; if (runningEl) runningEl.style.display = on ? "" : "none"; };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  // DIALOG_ERC::OnRunERCClick: ERC_TESTER::RunTests over the whole hierarchy; a sheet outside it (or no hierarchy known) is checked alone
  const run = async (): Promise<void> => {
    const s = sch(); const a = s && s.actions && s.actions.runERC; if (!a || running) return;
    notAnnotated = await updateAnnotationWarning();
    // ClearErcMarkers, then the ignored tests as the severities stand now
    current = null; ercClearFocus(); forgetHierErc(); publishMarkers([]);
    st.ignored = ignoredRules(severities());
    cancelled = false; showRunning(true); if (messages) messages.replaceChildren();
    running = true;
    const close = closeBtn(), busy = ["kd-erc-run", "kd-erc-del", "kd-erc-delall", "kd-erc-save"].map(footBtn);
    if (close) close.textContent = "Cancel";
    for (const b of busy) if (b) b.disabled = true;
    // ERC_TESTER::RunTests' AdvancePhase lines: kicad-cli's own as it reaches each phase; when the browser's engine
    // checks instead, the ones the severities leave enabled
    const sv = severities();
    let phases = 0;
    abort = typeof AbortController !== "undefined" ? new AbortController() : null;
    try {
      const mine = await runHierErc({ showAllErrors: opts.showAllErrors, onPhase: (msg) => { if (!cancelled) { phases++; report(msg); } }, signal: abort ? abort.signal : undefined },
        (l) => withExclusions(l as unknown as ErcViolation[]) as unknown as HierMarker[]);
      if (!cancelled && !phases && (ercSource !== "kicad" || !mine)) for (const line of ercPhaseMessages((code) => severityOf(code, sv) !== "ignore")) report(line);
      if (cancelled) { forgetHierErc(); publishMarkers([]); }
      else if (!mine) { forgetHierErc(); a.run(toolCtx(), Object.assign(ercProjectOpts(), { showAllErrors: opts.showAllErrors, silent: true })); }
      else onSheetOpened();   // the canvas: this sheet's own markers (the others stay with their sheets)
      // the checks KiCad itself did not make: the browser's own engine ran, which lacks some of ERC_TESTER's tests
      if (!cancelled && (ercSource !== "kicad" || !mine)) report(`Checked in the browser (${lastFallback || "KiCad unavailable"}): ${BROWSER_UNCHECKED}`);
    } catch (e) { report(`ERC failed: ${(e as Error).message || e}`); }
    abort = null;
    if (notAnnotated) report(`${notAnnotated} symbol(s) require annotation.`, true);
    report(cancelled ? "-------- ERC cancelled by user." : "Done.");
    running = false;
    if (close) close.textContent = "Close";
    for (const b of busy) if (b) b.disabled = false;
    if (!cancelled) {
      // Close becomes the default button; the messages stay up for half a second before the results come back
      closeIsDefault = true;
      const rb = footBtn("kd-erc-run"); if (rb) rb.classList.remove("primary"); if (close) close.classList.add("primary");
      await sleep(500);
      showRunning(false);
    }
    st.run = true;
    refresh();
  };
  // DIALOG_ERC::OnDeleteOneClick: on the Violations page only; the selection is cleared (it may hold the marker), the
  // current row's marker goes and the row after it (the one before, at the end) is picked as a click would
  const delOne = () => {
    if (running) return;
    if (nb && nb.index() !== 0) { refresh(); return; }
    toolCtx().setSelection([]); selectMarker(null);
    const c = resolveMarker(current); if (!c) { refresh(); return; }
    const rows = markers().filter(shown), at = rows.indexOf(c);
    current = null; ercClearFocus();
    publishMarkers(markers().filter((m) => m !== c));
    const left = markers().filter(shown), next = at >= 0 ? left[Math.min(at, left.length - 1)] : undefined;
    if (next) pick(next); else refresh();
  };
  // OnDeleteAllClick: with exclusions about, ask whether they go too (ClearUnresolvedERCExclusions + DeleteAllMarkers);
  // the ERC then counts as not run
  const delAll = () => {
    if (running) return;
    const all = markers(), stored = readExclusions(obj(projectJson().erc));
    const unresolved = stored.filter((ex) => !all.some((m) => isExcluded(m) && sameViolation({ ...m, severity: sevOf(m) }, ex))).length;
    const wipe = (withExcl: boolean): void => {
      if (withExcl && stored.length && !E.viewOnly) void saveProject((pro) => { sub(pro, "erc").erc_exclusions = []; }, "clear ERC exclusions").catch((e: Error) => toast(`Could not clear the exclusions: ${e.message}`, 5000));
      current = null; ercClearFocus(); publishMarkers(withExcl ? [] : all.filter(isExcluded)); st.run = false; refresh();
    };
    if (unresolved + all.filter(isExcluded).length <= 0) { wipe(false); return; }
    messageBox("Delete All Markers", "Delete exclusions too?", [{ label: "Cancel" }, { label: "Errors, Warnings and Exclusions", fn: () => wipe(true) }, { label: "Errors and Warnings Only", fn: () => wipe(false) }], 0);
  };
  // OnSaveReport: ERC.rpt or ERC.json (the file dialog's two wildcards) with the shown severities; the browser saves it
  const save = async (json: boolean): Promise<void> => {
    const u = (E.units === "in" || E.units === "mil" ? E.units : "mm") as Units;
    // BuildSheetListSortedByPageNumbers: a "***** Sheet" block per sheet; a marker goes under its main item's sheet
    let list: SheetInstance[] = []; try { list = await sheetList(); } catch { list = []; }
    const here = list.find((x) => x.docId === appState.docId);
    const sheetOf = (m: ErcViolation): string | null => {
      const ms = (m as { mainSheet?: unknown }).mainSheet, own = (m as { sheetPath?: string; docId?: string });
      if (own.sheetPath && own.docId !== hereDoc()) return own.sheetPath;
      if (typeof ms === "string" && here) { const child = list.find((x) => x.parentDocId === here.docId && x.sheetItemId === ms && x.uuidPath.slice(0, -1).join("/") === here.uuidPath.join("/")); if (child) return child.sheetPath; }
      return own.sheetPath || (here ? here.sheetPath : null);
    };
    const sheets = list.length ? list.map((x) => x.sheetPath) : undefined;
    const name = json ? "ERC.json" : "ERC.rpt";
    try {
    if (json) {
      // the KIID path of each sheet instance: the top-level sheet's uuid, then the sheet symbols down to it
      const top = (x: SheetInstance): SheetInstance => { let t = x; for (let k = 0; k < 64 && t.sheetItemId && t.parentDocId; k++) { const p = list.find((q) => q.docId === t.parentDocId && q.uuidPath.join("/") === t.uuidPath.slice(0, -1).join("/")); if (!p) break; t = p; } return t; };
      const uuidPath = (x: SheetInstance): string => "/" + [String((top(x).doc as KDoc & { uuid?: string }).uuid || ""), ...x.uuidPath].join("/");
      const rootDoc = list[0] ? appState.docs.find((d) => d.docId === list[0].docId) : appState.docs.find((d) => d.docId === hereDoc());
      const source = rootDoc ? String((rootDoc as unknown as { path?: string }).path || "").split("/").pop() || "" : "";
      const idx = (m: ErcViolation): number => { const p = sheetOf(m); return Math.max(0, list.findIndex((x) => x.sheetPath === p)); };
      download(name, ercJsonReport(markers(), { ...show, units: u, date: isoNow(), source, kicadVersion: KICAD_BASE_VERSION, ignored: ignoredRules(severities()),
        sheets: list.map((x) => ({ path: x.sheetPath, uuidPath: uuidPath(x) })), sheetOf: idx, title: errorMessage, text: unescape }), "application/json;charset=utf-8");
    } else download(name, ercTextReport(markers(), { ...show, units: u, date: isoNow(), ignored: ignoredTests(severities()), sheets, sheetOf, title: errorMessage, text: unescape }), "text/plain;charset=utf-8");
    } catch { messageBox("Error", `Failed to create file '${name}'.`); return; }   // DisplayErrorMessage
    report(`Report file '${name}' created.`);
  };
  api = KD().open({
    title: "Electrical Rules Checker", width: 640, modeless: true,
    build(body) {
      // m_infoBar: the annotation warning with its link (UpdateAnnotationWarning)
      const link = h("a", { href: "#", id: "kd-erc-annotate", style: "color:var(--blue);white-space:nowrap" }, "Show Annotation dialog");
      link.addEventListener("click", (ev) => { ev.preventDefault(); handlers().annotate?.(); });
      infoBar = h("div", { "data-erc-infobar": "1", role: "status", style: "display:none;gap:12px;align-items:center;justify-content:space-between;padding:5px 8px;margin-bottom:6px;border:1px solid var(--line);border-radius:4px;background:color-mix(in srgb, var(--warn) 18%, var(--panel))" },
        h("span", null, "Schematic is not fully annotated. ERC results will be incomplete."), link);
      body.append(infoBar);
      // m_bMenu: the options button at the top right (DIALOG_ERC::OnMenu)
      const gear = bitmapButton("config", "Options", null, { id: "kd-erc-options", flat: true });
      gear.addEventListener("click", () => { const r = gear.getBoundingClientRect(); popupMenu(r.left, r.bottom, [
        { label: "Cross-probe Selected Items", title: "Highlight corresponding items on canvas when selected in the ERC list", check: true, checked: opts.crossprobe, run: () => { opts.crossprobe = !opts.crossprobe; saveOpts(); } },
        { label: "Center on Cross-probe", title: "When cross-probing, scroll the canvas so that the item is visible", check: true, checked: opts.scrollOnCrossprobe, run: () => { opts.scrollOnCrossprobe = !opts.scrollOnCrossprobe; saveOpts(); } },
        { label: "Show all errors", title: "Show duplicate ERC markers on all applicable pins", check: true, checked: opts.showAllErrors, run: () => { opts.showAllErrors = !opts.showAllErrors; saveOpts(); } }]); });
      body.append(h("div", { style: "display:flex;justify-content:flex-end;margin-bottom:4px" }, gear));
      // m_runningResultsBook: the "Tests Running..." page with the messages and the gauge, or the results
      resultsEl = h("div", { "data-erc-results": "1" });
      messages = h("div", { "data-erc-messages": "1", style: "height:270px;overflow:auto;border:1px solid var(--line);background:var(--panel);padding:6px 8px" });
      runningEl = h("div", { "data-erc-running": "1", style: "display:none" });
      KD().notebook(runningEl, [{ label: "Tests Running...", build(page) { page.append(messages!, h("progress", { style: "display:block;width:100%;margin-top:6px;height:10px", "aria-label": "ERC progress" })); } }]);
      body.append(runningEl, resultsEl);
      const book = KD().notebook(resultsEl, [
        { label: "Violations", build(page) {
          list = h("div", { "data-erc-list": "1", style: "height:300px;overflow:auto;border:1px solid var(--line);background:var(--panel)" });
          page.append(list);
        } },
        { label: "Ignored Tests", build(page) {
          ignHost = h("div", { "data-erc-ignored": "1", style: "height:276px;overflow:auto;border:1px solid var(--line);background:var(--panel);padding:4px 6px" });
          const link = h("a", { href: "#", id: "kd-erc-edit-ignored", "data-k": "edit-ignored", style: "display:inline-block;margin-top:6px;color:var(--blue)" }, "Edit ignored tests");
          link.addEventListener("click", (ev) => { ev.preventDefault(); openSchematicSetup("Violation Severity"); });
          page.append(ignHost, link);
          fillIgnored();
        } },
      ]);
      nb = book;
      // OnSeverity: "All" ticks Errors and sets Warnings and Exclusions to itself; only the list changes
      const changed = (): void => { saveOpts(); syncBoxes(); refresh(); };
      const saveBtn = h("button", { class: "btn sm", type: "button", id: "kd-erc-save" }, "Save...");
      saveBtn.addEventListener("click", () => { const r = saveBtn.getBoundingClientRect(); popupMenu(r.left, r.bottom, [
        { label: "Report files (*.rpt)", run: () => { void save(false); } }, { label: "Json files (*.json)", run: () => { void save(true); } }]); });
      const filt = h("div", { style: "display:flex;gap:14px;align-items:center;margin:8px 0 0" }, h("span", null, "Show:"),
        checkbox("All", show.errors && show.warnings && show.exclusions, (on) => { show.errors = true; show.warnings = show.exclusions = on; changed(); }, { id: "kd-erc-all" }),
        checkbox("Errors", show.errors, (on) => { show.errors = on; changed(); }, { id: "kd-erc-errors" }), h("span", { "data-erc-count": "errors", class: "kd-badge" }),
        checkbox("Warnings", show.warnings, (on) => { show.warnings = on; changed(); }, { id: "kd-erc-warnings" }), h("span", { "data-erc-count": "warnings", class: "kd-badge" }),
        checkbox("Exclusions", show.exclusions, (on) => { show.exclusions = on; changed(); }, { id: "kd-erc-excl" }), h("span", { "data-erc-count": "exclusions", class: "kd-badge" }),
        h("span", { style: "flex:1" }), saveBtn);
      body.append(filt);
      const tabs = book.el.querySelectorAll<HTMLElement>(".kd-nb-tab"); vioTab = tabs[0] || null; ignTab = tabs[1] || null;
    },
    // m_buttonsSizer: Delete Marker / Delete All Markers on the left, then Run ERC / Close
    extra: [{ label: "Delete Marker", fn: delOne, id: "kd-erc-del" }, { label: "Delete All Markers", fn: delAll, id: "kd-erc-delall" }],
    buttons: [{ label: "Run ERC", primary: true, isDefault: true, fn: () => { void run(); }, id: "kd-erc-run" }, { label: "Close", close: true }],
    // OnCancelClick: while the tests run the button is "Cancel" and only cancels them; else the focus is cleared and the dialog goes
    cancel() { if (running) { cancelled = true; if (abort) abort.abort(); return false; } live = null; ercClearFocus(); return undefined; },
  });
  // once a run has ended Close is the default button (m_sdbSizer1Cancel->SetDefault())
  api.dlg.addEventListener("keydown", (ev) => {
    const t = ev.target as HTMLElement | null;
    if (ev.key !== "Enter" || !closeIsDefault || running || (t && (t.tagName === "BUTTON" || t.tagName === "TEXTAREA"))) return;
    ev.preventDefault(); ev.stopPropagation(); api!.finish(false);
  });
  function syncBoxes(): void {
    const set = (id: string, on: boolean) => { const e = api && api.body.querySelector<HTMLInputElement>("#" + id); if (e) e.checked = on; };
    set("kd-erc-all", show.errors && show.warnings && show.exclusions); set("kd-erc-errors", show.errors); set("kd-erc-warnings", show.warnings); set("kd-erc-excl", show.exclusions);
  }
  const sel = selectedMarker(); if (sel) current = sel;
  void updateAnnotationWarning();
  refresh();
}
/** ERC_TESTER's tests the browser's own engine does not make (they need KiCad's libraries, simulator or bus parser). */
const BROWSER_UNCHECKED = "bus conflicts, reused-sheet reference suffixes, the pin map, wired hidden power pins, text variables, simulation models, library symbol and footprint links and design variants were not checked.";
