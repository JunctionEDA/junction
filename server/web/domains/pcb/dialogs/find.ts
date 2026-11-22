// dialogs/find.ts — Edit → Find (Ctrl+F) and Find and Replace (Ctrl+Alt+F): eeschema/dialogs/dialog_sch_find.cpp.
// A modeless dialog: Find walks the hits (left to right, top to bottom, then on to the project's other sheets unless
// "Search the current sheet only" is ticked), selecting and centring each; Replace / Replace All edit references
// (when allowed), values, fields, labels and text as ordinary collab changes.
import { E, appState, applyView, centerOn, openDocId, pushUndoFor, toolCtx, cloneNode } from "./editor";
import { KD, checkbox, h, textInput, type DlgApi } from "./dom";
import { findHits, findHighlightIds, findOptionChanged, hitOrder, replaceInNode, str, pushFindHistory, type FindHit, type FindOpts } from "./logic";
import { sheetList } from "./sch-hierarchy";
import { comboBox } from "../../../shared/components/kcombo";
import { projectDocs, readDoc, submitDocOp } from "./project";
import { keyName } from "../../../shared/keys";

interface FindState extends FindOpts { replacement: string; backward: boolean; currentSheetOnly: boolean }
const F: FindState = { query: "", replacement: "", backward: false, matchCase: false, wholeWord: false, regex: false, pins: false, hiddenFields: false, currentSheetOnly: false, selectionOnly: false, replaceRefs: false, netNames: false };
/** FindNext's searchAllSheets: !searchCurrentSheetOnly (Find Next Marker shares the dialog's search data). */
export const findSearchesAllSheets = (): boolean => !F.currentSheetOnly && !F.selectionOnly;
interface Last { docId: string | null; key: string; x: number; y: number; id: string }
let last: Last | null = null;   // the hit the cursor sits on (m_afterItem)
let api: DlgApi | null = null, statusEl: HTMLElement | null = null;
const otherDocs = new Map<string, KDoc>();
// The Search for / Replace with history (EDA_DRAW_FRAME::m_findStringHistoryList / m_replaceStringHistoryList), kept per
// viewer as KiCad keeps it in the app settings.
const HIST_KEY = "kc-find-history";
const hist: { find: string[]; replace: string[] } = (() => {
  try { const v = JSON.parse(localStorage.getItem(HIST_KEY) || "null"); if (v && Array.isArray(v.find) && Array.isArray(v.replace)) return { find: v.find.filter((x: unknown) => typeof x === "string"), replace: v.replace.filter((x: unknown) => typeof x === "string") }; } catch { /* no storage */ }
  return { find: [], replace: [] };
})();
function remember(): void {
  hist.find = pushFindHistory(hist.find, F.query);
  hist.replace = pushFindHistory(hist.replace, F.replacement);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(hist)); } catch { /* no storage */ }
}
const resolveLib = (d: Pick<KDoc, "items" | "lib">, name: string) => KiCadCanvas.resolveLib(d as KDoc, name);
const keyOf = (hit: FindHit) => `${hit.id}\u0000${hit.what}\u0000${hit.field || ""}\u0000${hit.sub === undefined ? "" : hit.sub}`;
const S = appState;
let statusTimer: ReturnType<typeof setTimeout> | null = null;
/** ShowFindReplaceStatus( msg, ms ): the dialog's status line; with a time it clears itself. */
function setStatus(text: string, bad = false, ms = 0): void {
  if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
  if (statusEl) { statusEl.textContent = text; statusEl.style.color = bad ? "var(--err)" : "var(--ink-2)"; }
  if (ms && text) statusTimer = setTimeout(() => { statusTimer = null; if (statusEl) statusEl.textContent = ""; }, ms);
}
/** What the open dialog refreshes after a find, a replace or a change of the search (wxUpdateUIEvent / ACTIONS::updateFind). */
let syncUi: () => void = () => {};
/** SCH_FIND_REPLACE_TOOL::HasMatch: the current match still matches the search. */
export function findHasMatch(): boolean { return !!F.query && !!last && last.docId === S.docId && hitsHere().some((x) => keyOf(x) === last!.key); }
/**
 * SCH_FIND_REPLACE_TOOL::UpdateFind: while the dialog is open every item of the sheet shown that matches the search
 * (within the selection for a selection-only search) is brightened; with nothing to look for, or the dialog closed,
 * the brightening goes.
 */
let foundItemHighlighted = false;
export function updateFind(): void {
  const ids = findIsOpen() && F.query ? findHighlightIds(hitsHere()) : [];
  if (!ids.length && !foundItemHighlighted) return;
  foundItemHighlighted = ids.length > 0;
  try { toolCtx().setHighlight(ids.length ? new Set(ids) : null); } catch { /* no canvas */ }
}
function hitsHere(): FindHit[] { return E.kdoc ? findHits(E.kdoc, F, F.selectionOnly ? new Set<string>(E.selection) : null, resolveLib) : []; }

/**
 * SCH_FIND_REPLACE_TOOL::FindNext's tail: the matching item itself is selected (a field of a symbol or sheet, else
 * the item; a selection-only search leaves the selection alone) and the view centred on it, the zoom unchanged.
 */
function focusHit(hit: FindHit): void {
  if (!F.selectionOnly) {
    const ctx = toolCtx() as ReturnType<typeof toolCtx> & { selectField?: (id: string, name: string) => void };
    if (hit.field && (hit.kind === "symbol" || hit.kind === "sheet") && ctx.selectField) ctx.selectField(hit.id, hit.field); else ctx.setSelection([hit.id]);
  }
  centerOn(hit.x, hit.y);
}
/** The project's sheets in page order (SCH_SHEET_LIST::SortByPageNumbers), each file once. */
async function sheetOrder(): Promise<string[]> {
  let ids: string[] = [];
  try { for (const s of await sheetList()) if (!ids.includes(s.docId)) ids.push(s.docId); } catch { ids = []; }
  for (const d of projectDocs()) if (d.docType === "kicad_sch" && !ids.includes(d.docId)) ids.push(d.docId);
  return ids;
}
async function hitsOn(docId: string): Promise<FindHit[]> {
  if (docId === S.docId) return hitsHere();
  let od = otherDocs.get(docId); if (!od) { try { od = await readDoc(docId, "kicad_sch"); otherDocs.set(docId, od); } catch (e) { return []; } }
  return findHits(od, F, null, resolveLib);
}
function whenDocOpen(docId: string): Promise<boolean> {
  return new Promise((resolve) => { const t0 = Date.now(); const tick = () => { if (S.docId === docId && E.kdoc && E.kdoc.items.size) resolve(true); else if (Date.now() - t0 > 8000) resolve(false); else setTimeout(tick, 100); }; tick(); });
}
/** nextMatch( screen, sheet, aAfter ): the first hit past `after` in the search order (before it when reversed). */
function nextHit(hits: FindHit[], after: Last | null, rev: boolean): FindHit | null {
  if (!after) return hits[rev ? hits.length - 1 : 0] || null;
  const i = hits.findIndex((x) => keyOf(x) === after.key);
  if (i >= 0) return hits[i + (rev ? -1 : 1)] || null;
  // the item no longer matches (it was replaced): the search goes on from where it sits
  const past = hits.filter((x) => (rev ? hitOrder(x, after) < 0 : hitOrder(x, after) > 0));
  return past[rev ? past.length - 1 : 0] || null;
}
export async function findNext(reverse = false): Promise<FindHit | null> {
  // SCH_FIND_REPLACE_TOOL::FindNext with nothing to look for: FindAndReplace( ACTIONS::find )
  if (!F.query) { setStatus(""); if (!findIsOpen()) openFind(false); return null; }
  const rev = F.backward !== reverse, searchAll = findSearchesAllSheets();
  if (last && last.docId !== S.docId) last = null;   // m_afterItemScreen is not the screen shown
  let hit: FindHit | null = null, wrapped = false, onDoc: string | null = null;
  for (let attempt = 0; attempt < 2 && !hit; attempt++) {
    if (attempt === 1) { if (!last) break; last = null; wrapped = true; }   // nothing past the last match: once more from the start
    const fresh = !last;
    if (attempt === 0 || !searchAll) { hit = nextHit(hitsHere(), last, rev); if (hit) onDoc = S.docId; }
    if (!hit && searchAll) {
      const order = await sheetOrder(); if (rev) order.reverse();
      let skipping = attempt === 0 && (rev || !fresh);   // only the sheets past the one shown
      for (const id of order) {
        if (skipping) { if (id === S.docId) skipping = false; continue; }
        const hs = await hitsOn(id); if (hs.length) { hit = hs[rev ? hs.length - 1 : 0]; onDoc = id; break; }
      }
    }
  }
  if (hit && onDoc && onDoc !== S.docId) {
    openDocId(onDoc);
    hit = (await whenDocOpen(onDoc)) ? nextHit(hitsHere(), null, rev) : null;
  }
  if (!hit) { last = null; setStatus("No matches found.", false, 2000); updateFind(); syncUi(); return null; }
  last = { docId: S.docId, key: keyOf(hit), x: hit.x, y: hit.y, id: hit.id }; focusHit(hit); updateFind(); syncUi();
  if (wrapped) setStatus(searchAll ? "Reached end of schematic." : "Reached end of sheet.", false, 2000); else setStatus("");
  return hit;
}
/** MODIFIED changes replacing every replaceable hit of `hits` on `doc`. */
function replaceChanges(doc: KDoc, hits: FindHit[]): KChange[] {
  const byItem = new Map<string, FindHit[]>(); for (const x of hits) if (x.replaceable) { const l = byItem.get(x.id); if (l) l.push(x); else byItem.set(x.id, [x]); }
  const out: KChange[] = []; const setRef = CollabTools.sch && (CollabTools.sch._.setReference as ((n: SNode, r: string) => void) | undefined);
  for (const [id, list] of byItem) {
    const it = doc.items.get(id); if (!it) continue; const node = cloneNode(it.node) as SNode; let any = false;
    for (const x of list) if (replaceInNode(node, x, F, F.replacement)) { any = true; if (x.field === "Reference" && it.kind === "symbol" && setRef) { const p = KiCadCanvas.kids(node, "property").find((q) => str(q[1]) === "Reference"); if (p) setRef(node, str(p[2])); } }
    if (any) out.push(KiCadCanvas.replaceChange(doc, Object.assign({}, it, { node, geom: [], bbox: null })));
  }
  return out;
}
export async function replaceOne(): Promise<void> {
  if (E.viewOnly) { setStatus("View-only access", true); return; }
  // ReplaceAndFindNext: nothing to look for opens Find; only a current match ( HasMatch ) is replaced, then the next is found
  if (!F.query) { if (!findIsOpen()) openFind(false); return; }
  const hits = hitsHere(), cur = last && last.docId === S.docId ? hits.find((x) => keyOf(x) === last!.key) : undefined;
  if (!cur) return;
  const ch = E.kdoc ? replaceChanges(E.kdoc, [cur]) : []; if (ch.length) toolCtx().commit(ch, "Find and Replace");
  await findNext();
}
export async function replaceAll(): Promise<void> {
  if (E.viewOnly) { setStatus("View-only access", true); return; }
  if (!F.query) { if (!findIsOpen()) openFind(false); return; }
  const here = E.kdoc ? replaceChanges(E.kdoc, hitsHere()) : []; if (here.length) toolCtx().commit(here, "Find and Replace All");
    if (!F.currentSheetOnly && !F.selectionOnly) {
    for (const d of projectDocs().filter((x) => x.docType === "kicad_sch" && x.docId !== S.docId)) {
      try { const od = await readDoc(d.docId, "kicad_sch"); otherDocs.delete(d.docId); const ch = replaceChanges(od, findHits(od, F, null, resolveLib)); if (ch.length) {
          // the step is undoable on that sheet: its Ctrl+Z puts the texts back (KiCad undoes all sheets at once; here each sheet has its own list)
          const inverse = ch.map((c) => { const it = od.items.get(c.id); return it ? KiCadCanvas.replaceChange(od, it) : null; }).filter(Boolean) as KChange[];
          await submitDocOp(d.docId, ch); pushUndoFor(d.docId, { label: "Find and Replace All", changes: ch, inverse });
        } }
      catch (e) { setStatus(`Could not replace in ${d.path}: ${(e as Error).message}`, true); return; }
    }
  }
  last = null; setStatus("");   // ReplaceAll shows no status
  updateFind(); syncUi();
}

export function openFind(replace: boolean): void {
  otherDocs.clear(); F.searchAndReplace = replace; last = null;
  const ro = !!E.viewOnly;
  api = KD().open({ title: replace ? "Find and Replace" : "Find", width: 560, modeless: true, cls: "kd-find", buttons: [],
    build(body, a) {
      a.foot.style.display = "none";
      const q = textInput(F.query, (v) => { F.query = v; last = null; changed(); }, { id: "kd-find-q" });
      q.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !qc.isOpen()) { ev.preventDefault(); run(() => findNext(ev.shiftKey)); } });
      const rw = textInput(F.replacement, (v) => { F.replacement = v; }, { id: "kd-find-r", disabled: ro });
      // m_comboFind / m_comboReplace are wxComboBox with the search history; picking an entry sets the text
      const qc = comboBox(q, () => hist.find), rc = comboBox(rw, () => hist.replace);
      q.addEventListener("input", () => { F.query = q.value; last = null; changed(); });
      // DIALOG_SCH_FIND::OnReplaceWithEnter: Enter in "Replace with" finds
      rw.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !rc.isOpen()) { ev.preventDefault(); run(() => findNext(ev.shiftKey)); } });
      rw.addEventListener("input", () => { F.replacement = rw.value; });
      q.addEventListener("change", () => { F.query = q.value; last = null; changed(); });
      rw.addEventListener("change", () => { F.replacement = rw.value; });
      const run = (fn: () => Promise<unknown>): void => { F.query = q.value; if (replace) F.replacement = rw.value; remember(); qc.setOptions(hist.find); rc.setOptions(hist.replace); void fn(); };
      // DIALOG_SCH_FIND::OnOptions / updateFlags: Regular Expression clears Match case and Whole words only (and either
      // of those clears it); a selection-only search greys "Search the current sheet only", whose own value is kept
      const boxes: Record<string, HTMLInputElement> = {};
      const opt = (label: string, key: keyof FindState, id: string) => {
        const c = checkbox(label, !!F[key], (on) => {
          Object.assign(F, findOptionChanged(F, key as keyof FindOpts | "currentSheetOnly", on)); last = null;
          for (const k of ["matchCase", "wholeWord", "regex"]) if (boxes[k]) boxes[k].checked = !!(F as unknown as Record<string, boolean>)[k];
          changed();
        }, { id });
        boxes[key] = c.querySelector("input") as HTMLInputElement; return c;
      };
      // OnUpdateReplaceUI / OnUpdateReplaceAllUI, and ACTIONS::updateFind after any change of the search
      const changed = (): void => { updateFind(); syncUi(); };
      syncUi = (): void => {
        const rb = document.getElementById("kd-find-replace") as HTMLButtonElement | null, ra = document.getElementById("kd-find-replaceall") as HTMLButtonElement | null;
        if (rb) rb.disabled = ro || !q.value || !findHasMatch();
        if (ra) ra.disabled = ro || !q.value;
        if (boxes.currentSheetOnly) { boxes.currentSheetOnly.disabled = !!F.selectionOnly; const l = boxes.currentSheetOnly.closest("label") as HTMLElement | null; if (l) l.style.opacity = F.selectionOnly ? ".5" : ""; }
      };
      const fields = h("div", { class: "kv", style: "margin-bottom:10px" }, h("label", null, "Search for:"), q);
      if (replace) fields.append(h("label", null, "Replace with:"), rw);
      const left = h("div", { style: "flex:1;min-width:0" }, fields,
        // DIALOG_SCH_FIND hides m_staticDirection and the Forward / Backward radios (F3 / Shift+F3 pick the way)
        h("div", null,
          h("div", null, opt("Match case", "matchCase", "kd-find-case"), opt("Whole words only", "wholeWord", "kd-find-word"), opt("Regular Expression", "regex", "kd-find-regex"),
            opt("Search pin names and numbers", "pins", "kd-find-pins"), opt("Include hidden fields", "hiddenFields", "kd-find-hidden"), opt("Search the current sheet only", "currentSheetOnly", "kd-find-sheet"),
            opt("Search the current selection only", "selectionOnly", "kd-find-sel"), replace ? opt("Replace matches in reference designators", "replaceRefs", "kd-find-refs") : null, opt("Search net names", "netNames", "kd-find-nets"))));
      const btn = (label: string, id: string, fn: () => void, primary = false, disabled = false) => h("button", { class: "btn" + (primary ? " primary" : ""), type: "button", id, disabled, style: "width:104px", onclick: fn }, label);
      const right = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:none" }, btn("Find", "kd-find-next", () => run(() => findNext()), true),
        replace ? btn("Replace", "kd-find-replace", () => run(replaceOne), false, ro) : null,
        replace ? btn("Replace All", "kd-find-replaceall", () => run(replaceAll), false, ro) : null,
        btn("Close", "kd-find-close", () => a.finish(false)));
      statusEl = h("div", { id: "kd-find-status", style: "margin-top:8px;min-height:16px;color:var(--ink-2)" });
      // m_searchPanelLink: "Show search panel (Ctrl+G)" under a rule, at the right (ACTIONS::showSearch's hotkey)
      const link = h("a", { href: "#", id: "kd-find-panel", style: "color:var(--accent);white-space:nowrap" }, "Show search panel (" + keyName("Ctrl+G") + ")");
      link.addEventListener("click", (ev) => { ev.preventDefault(); const sp = (E as unknown as { hooks: { showPane?: (n: string, s?: boolean) => void } }).hooks.showPane; if (sp) sp("search", true); a.close(); setTimeout(() => { const b = document.getElementById("searchBox") as HTMLInputElement | null; if (b) b.focus(); }, 50); });
      body.append(h("div", { style: "display:flex;gap:16px" }, left, right), statusEl,
        h("div", { style: "border-top:1px solid var(--line);margin-top:8px;padding-top:6px;text-align:right" }, link));
      // the dialog is up: ACTIONS::find / findAndReplace run UpdateFind on what is already typed
      setTimeout(() => { if (findIsOpen()) { updateFind(); syncUi(); } }, 0);
    },
    cancel() { api = null; statusEl = null; syncUi = () => {}; updateFind(); } });
}
export function findIsOpen(): boolean { return !!api && KD().isOpen(); }
