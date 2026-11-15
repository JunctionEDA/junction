// dialogs/assign-footprints.ts — Tools → Assign Footprints… (KiCad's CvPcb, cvpcb/cvpcb_mainframe.cpp).
//
// The frame as CvPcb lays it out: the menu bar (cvpcb/menubar.cpp: File, Edit, Preferences), the top toolbar
// (cvpcb/toolbars_cvpcb.cpp: Save to Schematic | Manage Footprint Libraries | View Selected Footprint | previous /
// next unassigned symbol | Undo, Redo, Automatically Assign Footprints, Delete All Footprint Assignments |
// "Footprint Filters:" with the three check tools — Use symbol footprint filters, Filter by pin count, Filter by
// library — and the search text), the three lists (Footprint Libraries, Symbol : Footprint Assignments, Filtered
// Footprints), the three-field status bar (DisplayStatus) and the dialog buttons CvPcb adds under them
// (Apply, Save Schematic & Continue / Cancel / OK).
//
// Behaviour follows the tool (cvpcb/tools/cvpcb_control.cpp, cvpcb_association_tool.cpp): a double-click or Enter on a
// footprint assigns it to every selected symbol and moves to the next symbol; Delete removes the selected
// assignments; Tab / Shift+Tab move the focus between the lists; Ctrl+S saves to the schematic; assignments undo and
// redo one command at a time (m_undoList / m_redoList); Automatically Assign Footprints reads the project's
// footprint association files (*.equ) and then the single-filter rule of AutomaticFootprintMatching.  The footprint
// list is FOOTPRINT_FILTER's: the symbol's footprint filters, its pin count against the footprint's pad count, the
// selected library and the search text, each only when its tool is pressed (m_FilterFlags, 0 when first run).
import { E, appState, toast, toolCtx } from "./editor";
import { KD, confirmBox, h, popupMenu, type PopItem } from "./dom";
import { libPins, refCmp, str, symbolRows, type SymRow } from "./logic";
import { projectDocs, readDoc, submitDocOp } from "./project";
import { messageBox } from "./sch-items";
import { kicadIcon } from "../components/kicon-dom";
import { keyName } from "../keys";
import { matchesFpFilters, symbolFpFilters } from "../library/fpchoice";
import { clearPreview, renderFootprintPreview } from "../library/preview";
import { fetchItem, libraryIndex, officialLibraries, projectLibraries, type LibItem, type LibraryEntry, type SourceContext } from "../library/sources";

interface Member { docId: string; id: string }
interface Row extends SymRow { members: Member[]; fp: string; orig: string; pins: number; filters: string[] }
interface Assoc { row: Row; from: string; to: string }
type Pane = "lib" | "sym" | "fp";
interface Flags { filters: boolean; pins: boolean; lib: boolean }
const S = appState;
const ROW_H = 20;
const FLAGS_KEY = "kui.cvpcb.filter_footprint";

const CSS = `
.kd-dialog.cv-frame { width: min(1240px, 96vw); height: min(720px, 90vh); }
.kd-dialog.cv-frame .kd-body { padding: 0; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.cv-menubar { display: flex; gap: 2px; padding: 2px 6px; border-bottom: 1px solid var(--line); background: var(--panel-2); flex: none; }
.kd-dialog.cv-frame .cv-menubar button { border: 0; box-shadow: none; min-width: 0; background: transparent; color: var(--ink); font: 12px var(--font); padding: 3px 8px; border-radius: 3px; cursor: default; }
.kd-dialog.cv-frame .cv-menubar button:hover { background: color-mix(in srgb, var(--ink) 10%, transparent); }
.cv-toolbar { display: flex; align-items: center; gap: 2px; padding: 3px 6px; border-bottom: 1px solid var(--line); background: var(--panel-2); flex: none; flex-wrap: wrap; }
.cv-tool { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid transparent; border-radius: 3px; background: transparent; color: var(--ink); cursor: default; padding: 0; }
.cv-tool:hover:not(:disabled) { background: color-mix(in srgb, var(--ink) 10%, transparent); }
.cv-tool.on { background: color-mix(in srgb, var(--blue) 28%, transparent); border-color: var(--blue); }
.cv-tool:disabled { opacity: .35; }
.cv-sep { width: 1px; height: 20px; background: var(--line); margin: 0 5px; flex: none; }
.cv-toolbar b { margin: 0 6px 0 15px; font-weight: 600; white-space: nowrap; }
.kd-dialog.cv-frame .kd-body .cv-toolbar input[type=text] { min-width: 150px; width: 220px; flex: 0 0 220px; font: 12px var(--font); padding: 3px 6px; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--panel); color: var(--ink); }
.cv-panes { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(150px, 20%) minmax(300px, 1fr) minmax(220px, 35%); gap: 6px; padding: 6px; }
.cv-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.cv-pane > span { font-weight: 600; padding: 0 2px 3px; }
.cv-list { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--line); background: var(--panel); outline: 0; position: relative; font: 12px var(--mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
.cv-list:focus { border-color: var(--blue); }
.cv-rows { position: relative; }
.cv-row { position: absolute; left: 0; height: ${ROW_H}px; line-height: ${ROW_H}px; min-width: 100%; padding: 0 6px; white-space: pre; cursor: default; user-select: none; box-sizing: border-box; }
.cv-row.sel { background: color-mix(in srgb, var(--ink) 16%, transparent); }
.cv-list:focus .cv-row.sel { background: var(--accent); color: var(--on-accent); }
.cv-status { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) minmax(0, 2fr); border-top: 1px solid var(--line); background: var(--panel-2); color: var(--ink-2); flex: none; }
.cv-status span { padding: 3px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-right: 1px solid var(--line); min-height: 16px; }
.cv-status span:last-child { border-right: 0; }
.cv-view canvas { width: 100%; height: 100%; display: block; }
`;
let styled = false;
function ensureCss(): void { if (styled) return; styled = true; const st = document.createElement("style"); st.id = "cv-css"; st.textContent = CSS; document.head.appendChild(st); }

/** formatSymbolDesc: "%3d " + the reference right-aligned in 8 + " - " + the value right-aligned in 16 + " : " + fpid. */
export function formatSymbolDesc(idx: number, ref: string, value: string, fp: string): string {
  return String(idx).padStart(3) + " " + ref.padStart(8) + " - " + value.padStart(16) + " : " + fp;
}
/** One line of a footprint association file: 'value' 'footprint', after the comments (auto_associate.cpp). */
export function parseEquFile(text: string): { value: string; fp: string }[] {
  const out: { value: string; fp: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    const m = /^'([^']*)'\s+'([^']*)'/.exec(line); if (!m) continue;
    out.push({ value: m[1].trim().replace(/ /g, "_"), fp: m[2].trim() });
  }
  return out;
}
function loadFlags(): Flags {
  let n = 0; try { n = Number(localStorage.getItem(FLAGS_KEY)) || 0; } catch { n = 0; }
  return { filters: !!(n & 1), pins: !!(n & 2), lib: !!(n & 4) };   // FILTERING_BY_COMPONENT_FP_FILTERS / _PIN_COUNT / _LIBRARY
}
function saveFlags(f: Flags): void { try { localStorage.setItem(FLAGS_KEY, String((f.filters ? 1 : 0) | (f.pins ? 2 : 0) | (f.lib ? 4 : 0))); } catch { /* private mode */ } }

/** A windowed list box (wxListView in report mode with one column): fixed-height rows drawn for the visible range. */
function listBox(id: string, onPick: (i: number, ev: MouseEvent) => void, onActivate: (i: number) => void): { el: HTMLElement; set(lines: string[], selected: (i: number) => boolean): void; redraw(): void; reveal(i: number): void } {
  const rowsEl = h("div", { class: "cv-rows" }), el = h("div", { class: "cv-list", id, tabindex: "0" }, rowsEl);
  let lines: string[] = [], isSel: (i: number) => boolean = () => false, queued = false;
  const draw = (): void => {
    queued = false; rowsEl.style.height = lines.length * ROW_H + "px";
    const top = el.scrollTop, hh = el.clientHeight || 400, first = Math.max(0, Math.floor(top / ROW_H) - 8), last = Math.min(lines.length, Math.ceil((top + hh) / ROW_H) + 8);
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) { const d = h("div", { class: "cv-row" + (isSel(i) ? " sel" : ""), style: `top:${i * ROW_H}px` }, lines[i]); d.dataset.i = String(i); frag.append(d); }
    rowsEl.replaceChildren(frag);
  };
  const redraw = (): void => { if (!queued) { queued = true; requestAnimationFrame(draw); } };
  el.addEventListener("scroll", redraw);
  const at = (ev: Event): number => { const r = (ev.target as HTMLElement).closest<HTMLElement>(".cv-row"); return r ? Number(r.dataset.i) : -1; };
  el.addEventListener("mousedown", (ev) => { const i = at(ev); if (i >= 0) onPick(i, ev); });
  el.addEventListener("dblclick", (ev) => { const i = at(ev); if (i >= 0) onActivate(i); });
  return { el, set(l, s) { lines = l; isSel = s; rowsEl.style.height = lines.length * ROW_H + "px"; draw(); }, redraw,
    reveal(i) { const y = i * ROW_H, hh = el.clientHeight || 400; if (y < el.scrollTop) el.scrollTop = y; else if (y + ROW_H > el.scrollTop + hh) el.scrollTop = y + ROW_H - hh; redraw(); } };
}

export function openAssignFootprints(): void {
  if (!E.kdoc) return;
  ensureCss();
  const ro = !!E.viewOnly, here = S.docId || "", docs = new Map<string, KDoc>([[here, E.kdoc as KDoc]]);
  /** every file of the project (libraries and association files too), not only the sheets the editor joins */
  const allDocs = () => (S.project && S.project.docs) || projectDocs();
  const ctx: SourceContext = { docs: allDocs(), doc: E.kdoc as KDoc };
  const flags = loadFlags();
  let rows: Row[] = [], cur = 0, selected = new Set<number>([0]), anchor = 0;
  let libs: LibraryEntry[] = [], curLib = "", filterText = "", pendingLibs = 0, tableError = "";
  const index = new Map<string, LibItem[]>();
  let fps: LibItem[] = [], fpSel = -1, focus: Pane = "sym", clip = "", closed = false, filterTimer = 0;
  const undo: Assoc[][] = [], redo: Assoc[][] = [];
  const dirty = (): boolean => rows.some((r) => r.fp !== r.orig);

  const build = (): void => {
    const byRef = new Map<string, Row>(), old = rows; rows = [];
    for (const [docId, d] of docs) for (const r of symbolRows(d, docId, !ro)) {
      const members = r.ids.map((id) => ({ docId, id })); const prev = r.ref && !/\?$/.test(r.ref) ? byRef.get(r.ref) : undefined; if (prev) { prev.members.push(...members); continue; }
      const it = d.items.get(r.id)!; const lid = KiCadCanvas.kid(it.node, "lib_name") || KiCadCanvas.kid(it.node, "lib_id"); const lib = lid ? KiCadCanvas.resolveLib(d, str(lid[1])) : null;
      const was = old.find((x) => x.members[0].docId === docId && x.id === r.id);
      const row: Row = Object.assign(r, { members, fp: was ? was.fp : str(r.values.Footprint), orig: str(r.values.Footprint), pins: new Set(libPins(lib).map((p) => p.number)).size, filters: symbolFpFilters(lib) });
      rows.push(row); if (r.ref) byRef.set(r.ref, row);
    }
    rows.sort((a, b) => refCmp(a.ref, b.ref));
    if (cur >= rows.length) cur = Math.max(0, rows.length - 1);
    selected = new Set([...selected].filter((i) => i < rows.length)); if (!selected.size && rows.length) selected.add(cur);
  };

  // ---- the three lists
  const libList = listBox("kd-af-libs", (i) => { setFocus("lib"); pickLib(libs[i] ? libs[i].name : ""); }, () => undefined);
  const symList = listBox("kd-af-syms", (i, ev) => {
    setFocus("sym");
    if (ev.shiftKey) { selected = new Set(); for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) selected.add(k); }
    else if (ev.ctrlKey || ev.metaKey) { if (selected.has(i) && selected.size > 1) selected.delete(i); else selected.add(i); anchor = i; }
    else { selected = new Set([i]); anchor = i; }
    cur = i; symbolChanged();
  }, () => undefined);
  const fpList = listBox("kd-af-fps", (i) => { setFocus("fp"); fpSel = i; fpList.redraw(); status(); }, (i) => { fpSel = i; associate(); });
  const paneOf: Record<Pane, HTMLElement> = { lib: libList.el, sym: symList.el, fp: fpList.el };
  const setFocus = (p: Pane): void => { focus = p; if (document.activeElement !== paneOf[p]) paneOf[p].focus({ preventScroll: true }); status(); };
  for (const p of ["lib", "sym", "fp"] as Pane[]) paneOf[p].addEventListener("focus", () => { focus = p; status(); });

  const drawLibs = (): void => libList.set(libs.map((l) => l.name), (i) => !!libs[i] && libs[i].name === curLib);
  const drawSyms = (): void => symList.set(rows.map((r, i) => formatSymbolDesc(i + 1, r.ref, str(r.values.Value), r.fp)), (i) => selected.has(i));
  /** FOOTPRINT_FILTER over the loaded libraries, in library-table order. */
  const filterFps = (): void => {
    const r = rows[cur], terms = filterText.trim().toLowerCase().split(/\s+/).filter(Boolean), was = fpSel >= 0 && fps[fpSel] ? fps[fpSel].id : "";
    const out: LibItem[] = [];
    for (const l of libs) {
      if (flags.lib && curLib && l.name !== curLib) continue;
      for (const it of index.get(l.name) || []) {
        if (flags.pins && r && it.pads !== r.pins) continue;
        if (flags.filters && r && r.filters.length && !matchesFpFilters({ library: l.name, name: it.name }, r.filters)) continue;
        if (terms.length) { const hay = (l.name + ":" + it.name + " " + (it.keywords || "") + " " + (it.description || "")).toLowerCase(); if (!terms.every((t) => hay.includes(t))) continue; }
        out.push(it);
      }
    }
    fps = out; fpSel = was ? fps.findIndex((x) => x.id === was) : -1; if (fpSel < 0) fpSel = fps.length ? 0 : -1;
    fpList.set(fps.map((it, i) => String(i + 1).padStart(3) + " " + it.id), (i) => i === fpSel);
    status();
  };
  /** FOOTPRINTS_LISTBOX::SetSelectedFootprint: the symbol's own footprint is shown selected when it is in the list. */
  const selectFpOf = (r: Row | undefined): void => { if (!r || !r.fp) return; const i = fps.findIndex((x) => x.id.toLowerCase() === r.fp.toLowerCase()); if (i >= 0) { fpSel = i; fpList.reveal(i); } };
  const symbolChanged = (): void => {
    drawSyms(); symList.reveal(cur); filterFps(); selectFpOf(rows[cur]); refreshTools();
    const r = rows[cur]; if (r) { const ids = r.members.filter((m) => m.docId === here).map((m) => m.id); if (ids.length) { try { toolCtx().setSelection(ids); } catch { /* cross-probe is best effort */ } } }
  };
  const pickLib = (name: string): void => { curLib = name; drawLibs(); filterFps(); selectFpOf(rows[cur]); };

  // ---- the status bar (DisplayStatus)
  const st0 = h("span", { id: "kd-af-status" }), st1 = h("span", { id: "kd-af-status-fp" }), st2 = h("span", { id: "kd-af-status-lib" });
  const status = (): void => {
    const r = rows[cur]; const parts: string[] = [];
    if (flags.filters) parts.push("Keywords" + (r && r.filters.length ? ` (${r.filters.join(", ")})` : ""));
    if (flags.pins) parts.push("Pin Count" + (r ? ` (${r.pins})` : ""));
    if (flags.lib) parts.push("Library" + (curLib ? ` (${curLib})` : ""));
    if (filterText.trim()) parts.push(`Search Text (${filterText.trim()})`);
    st0.textContent = (parts.length ? "Filtered by " + parts.join(", ") : "No Filtering") + `: ${fps.length} matching footprints`
      + (pendingLibs > 0 ? `  (loading libraries, ${pendingLibs} to go)` : "") + (tableError ? "  " + tableError : "");
    const fp = fpSel >= 0 ? fps[fpSel] : undefined;
    st1.textContent = fp ? `Description: ${fp.description || ""};  Keywords: ${fp.keywords || ""}` : "";
    const lib = fp ? fp.library || "" : focus === "sym" ? (r && r.fp.includes(":") ? r.fp.slice(0, r.fp.indexOf(":")) : "") : focus === "lib" ? curLib : "";
    const entry = libs.find((l) => l.name === lib);
    st2.textContent = entry ? `Library location: ${entry.source === "project" ? "${KIPRJMOD}/" : "${KICAD10_FOOTPRINT_DIR}/"}${entry.name}.pretty` : "";
    st0.title = st0.textContent; st1.title = st1.textContent; st2.title = st2.textContent;
  };

  // ---- associations, with CvPcb's undo list
  const setAssoc = (list: Assoc[], record: boolean): void => {
    const real = list.filter((a) => a.from !== a.to); if (!real.length) return;
    for (const a of real) a.row.fp = a.to;
    if (record) { undo.push(real); redo.length = 0; }
    drawSyms(); refreshTools(); status();
  };
  /** CVPCB_ASSOCIATION_TOOL::Associate: the selected footprint onto every selected symbol, then the next symbol. */
  const associate = (): void => {
    if (ro) return; const fp = fpSel >= 0 ? fps[fpSel] : undefined; if (!fp) return;
    const targets = [...selected].sort((a, b) => a - b).map((i) => rows[i]).filter((r) => r && r.editable); if (!targets.length) return;
    setAssoc(targets.map((row) => ({ row, from: row.fp, to: fp.id })), true);
    const last = Math.max(...selected); if (last < rows.length - 1) { cur = last + 1; selected = new Set([cur]); anchor = cur; }
    symbolChanged();
  };
  const deleteAssoc = (): void => { if (ro) return; setAssoc([...selected].map((i) => rows[i]).filter((r) => r && r.editable).map((row) => ({ row, from: row.fp, to: "" })), true); filterFps(); };
  const deleteAll = async (): Promise<void> => {
    if (ro) return;
    if (!(await confirmBox("Confirm", "Delete all associations?", "Yes"))) return;
    setAssoc(rows.filter((r) => r.editable).map((row) => ({ row, from: row.fp, to: "" })), true);
  };
  const doUndo = (): void => { const e = undo.pop(); if (!e) return; setAssoc(e.map((a) => ({ row: a.row, from: a.to, to: a.from })), false); redo.push(e); refreshTools(); };
  const doRedo = (): void => { const e = redo.pop(); if (!e) return; setAssoc(e, false); undo.push(e); refreshTools(); };
  /** gotoNextNA / gotoPreviousNA: the next symbol without a footprint, from the current one, without wrapping. */
  const gotoNA = (dir: 1 | -1): void => {
    for (let i = cur + dir; i >= 0 && i < rows.length; i += dir) if (!rows[i].fp) { cur = i; selected = new Set([i]); anchor = i; setFocus("sym"); symbolChanged(); return; }
  };
  const known = (fpid: string): boolean => { const k = fpid.indexOf(":"); if (k < 0) return false; const lib = fpid.slice(0, k), name = fpid.slice(k + 1).toLowerCase(); return (index.get(lib) || []).some((x) => x.name.toLowerCase() === name); };
  /** AutomaticFootprintMatching: the association files first, then a single filter that names one footprint. */
  const autoAssociate = async (): Promise<void> => {
    if (ro) return;
    const equ: { value: string; fp: string }[] = [];
    for (const d of allDocs().filter((x) => /\.equ$/i.test(x.path))) {
      try { const res = await fetch(`/api/docs/${d.docId}/content?v=${Date.now()}`, { credentials: "same-origin" }); if (res.ok) equ.push(...parseEquFile(await res.text())); } catch { /* an unreadable file is left out */ }
    }
    equ.sort((a, b) => a.value.localeCompare(b.value));
    const list: Assoc[] = [], missing: string[] = [];
    for (const r of rows) {
      if (r.fp || !r.editable) continue;
      const value = str(r.values.Value).toLowerCase(); let found = "", candidate = "";
      for (let i = 0; i < equ.length && !found; i++) {
        const e = equ[i]; if (e.value.toLowerCase() !== value) continue;
        const ok = known(e.fp), unique = !(equ[i + 1] && equ[i + 1].value === e.value) && !(equ[i - 1] && equ[i - 1].value === e.value);
        if (!ok) { missing.push(`Component ${r.ref}: footprint ${e.fp} not found in any of the project footprint libraries.`); continue; }
        if (unique) { found = e.fp; break; }
        if (!candidate) candidate = e.fp;
        const name = e.fp.slice(e.fp.indexOf(":") + 1);
        if (!r.filters.length || matchesFpFilters({ name }, r.filters.filter((f) => !f.includes(":")))) found = e.fp;
      }
      if (!found) found = candidate;
      if (!found && r.filters.length === 1 && known(r.filters[0])) found = r.filters[0];
      if (found) list.push({ row: r, from: r.fp, to: found });
    }
    setAssoc(list, true); st0.textContent = `${equ.length} footprint/symbol equivalences found.`;
    if (missing.length) void messageBox(missing.join("\n\n"), "Warning");
  };
  /** CVPCB_CONTROL::ShowFootprintViewer: the selected footprint (or the selected symbol's) drawn in its own window. */
  const viewFootprint = (): void => {
    const picked = focus === "fp" || !(rows[cur] && rows[cur].fp) ? (fpSel >= 0 ? fps[fpSel] : undefined) : undefined;
    const id = picked ? picked.id : rows[cur] ? rows[cur].fp : ""; if (!id || !id.includes(":")) return;
    const lib = id.slice(0, id.indexOf(":")), name = id.slice(lib.length + 1);
    const item: LibItem = picked || { id, name, library: lib, source: projectLibraries("footprint", ctx.docs).some((l) => l.name === lib) ? "project" : "official" };
    KD().open({ title: `Footprint: ${id}`, width: 560, child: true, cls: "cv-view", buttons: [{ label: "Close", close: true, primary: true, isDefault: true }], geomKey: "cvpcb-footprint-viewer",
      cancel() { requestAnimationFrame(() => paneOf[focus].focus({ preventScroll: true })); },
      build(body) {
        const canvas = h("canvas"), msg = h("div", { class: "kd-note", style: "position:absolute;left:0;right:0;bottom:6px;text-align:center" }, "Loading…");
        body.append(h("div", { id: "kd-af-viewer", style: "position:relative;height:380px" }, canvas, msg));
        requestAnimationFrame(() => { try { clearPreview(canvas, "footprint"); } catch { /* not laid out yet */ } });
        fetchItem("footprint", item, ctx).then((got) => { if (!canvas.isConnected) return; msg.textContent = ""; try { renderFootprintPreview(canvas, got.fpid || id, got.footprint || ""); } catch (e) { msg.textContent = "Cannot draw this footprint: " + ((e as Error).message || e); } },
          (e: Error) => { msg.textContent = `Footprint '${id}' not found.` + (e && e.message ? " " + e.message : ""); });
      } });
  };
  const cut = (): void => { const r = rows[cur]; if (!r || ro) return; clip = r.fp; deleteAssoc(); };
  const copy = (): void => { const r = rows[cur]; if (r) { clip = focus === "fp" && fpSel >= 0 ? fps[fpSel].id : r.fp; try { void navigator.clipboard.writeText(clip); } catch { /* the dialog's own clipboard is enough */ } } };
  const paste = (): void => { if (ro || !clip) return; setAssoc([...selected].map((i) => rows[i]).filter((r) => r && r.editable).map((row) => ({ row, from: row.fp, to: clip })), true); };

  // ---- saving (CVPCB_MAINFRAME::SaveFootprintAssociation)
  const apply = async (): Promise<boolean> => {
    if (ro) return true;
    const sch = CollabTools.sch as SchToolModule & { fieldsTableChanges(doc: KDoc, edits: { id: string; values: Record<string, string> }[]): KChange[] };
    const byDoc = new Map<string, { id: string; values: Record<string, string> }[]>();
    for (const r of rows) if (r.fp !== r.orig) for (const m of r.members) { const l = byDoc.get(m.docId) || []; l.push({ id: m.id, values: { Footprint: r.fp } }); byDoc.set(m.docId, l); }
    let n = 0;
    try { for (const [docId, edits] of byDoc) { const d = docs.get(docId); if (!d) continue; const ch = sch.fieldsTableChanges(d, edits); if (!ch.length) continue; n += ch.length; if (docId === here) toolCtx().commit(ch, "assign footprints"); else { await submitDocOp(docId, ch); docs.set(docId, await readDoc(docId, "kicad_sch")); } } }
    catch (e) { toast("Could not assign the footprints: " + (e as Error).message, 4000); return false; }
    for (const r of rows) r.orig = r.fp;
    toast(n ? `Assigned footprints to ${n} symbol${n === 1 ? "" : "s"}` : "No footprint changes");
    refreshTools();
    return true;
  };

  // ---- the toolbar and the menu bar
  const appAction = (id: string): void => { const app = (window as unknown as { CollabApp?: { dispatch(a: { type: string; id: string }): void } }).CollabApp; if (app) app.dispatch({ type: "action", id }); };
  const tools: { el: HTMLButtonElement; enabled?: () => boolean; on?: () => boolean }[] = [];
  const tool = (id: string, icon: string, tip: string, run: () => void, opts?: { enabled?: () => boolean; on?: () => boolean; key?: string }): HTMLButtonElement => {
    const b = h("button", { class: "cv-tool", type: "button", id: "kd-af-" + id, title: tip + (opts && opts.key ? `  (${keyName(opts.key)})` : "") }, kicadIcon(icon, 22) as unknown as Node) as HTMLButtonElement;
    // a toolbar tool never takes the keyboard from the lists (wxAuiToolBar)
    b.tabIndex = -1; b.addEventListener("mousedown", (ev) => ev.preventDefault());
    b.addEventListener("click", () => { run(); refreshTools(); if (!document.activeElement || document.activeElement === document.body) paneOf[focus].focus({ preventScroll: true }); }); tools.push({ el: b, enabled: opts && opts.enabled, on: opts && opts.on }); return b;
  };
  const refreshTools = (): void => { for (const t of tools) { if (t.enabled) t.el.disabled = !t.enabled(); if (t.on) { const on = t.on(); t.el.classList.toggle("on", on); t.el.setAttribute("aria-pressed", on ? "true" : "false"); } } };
  const toggle = (k: keyof Flags): void => { flags[k] = !flags[k]; saveFlags(flags); filterFps(); selectFpOf(rows[cur]); };
  const sep = (): HTMLElement => h("i", { class: "cv-sep" });
  const filterInput = h("input", { type: "text", id: "kd-af-filter", spellcheck: "false", autocomplete: "off", "aria-label": "Footprint filter text" }) as HTMLInputElement;
  filterInput.addEventListener("input", () => { window.clearTimeout(filterTimer); filterTimer = window.setTimeout(() => { filterText = filterInput.value; filterFps(); }, 200); });
  const toolbar = h("div", { class: "cv-toolbar", role: "toolbar" },
    tool("save", "save", "Save to Schematic\nSave footprint assignments in 'footprint' fields of schematic symbols", () => { void apply(); }, { enabled: () => !ro && dirty(), key: "Ctrl+S" }), sep(),
    tool("libtable", "library_table", "Manage Footprint Libraries...\nEdit the global and project footprint library tables", () => appAction("showFootprintLibTable")), sep(),
    tool("view", "show_footprint", "View Selected Footprint", viewFootprint), sep(),
    tool("prev", "left", "Select Previous Unassigned Symbol\nSelect previous symbol with no footprint assignment", () => gotoNA(-1)),
    tool("next", "right", "Select Next Unassigned Symbol\nSelect next symbol with no footprint assignment", () => gotoNA(1)), sep(),
    tool("undo", "undo", "Undo", doUndo, { enabled: () => undo.length > 0, key: "Ctrl+Z" }),
    tool("redo", "redo", "Redo", doRedo, { enabled: () => redo.length > 0, key: "Ctrl+Y" }),
    tool("auto", "auto_associate", "Automatically Assign Footprints\nAssign footprints automatically using a footprint association file", () => { void autoAssociate(); }, { enabled: () => !ro }),
    tool("delall", "delete_association", "Delete All Footprint Assignments", () => { void deleteAll(); }, { enabled: () => !ro }), sep(),
    h("b", null, "Footprint Filters:"),
    tool("fpfilters", "module_filtered_list", "Use symbol footprint filters\nFilter footprint list by footprint filters defined in the symbol", () => toggle("filters"), { on: () => flags.filters }),
    tool("pins", "module_pin_filtered_list", "Filter by pin count\nFilter footprint list by pin count", () => toggle("pins"), { on: () => flags.pins }),
    tool("lib", "module_library_list", "Filter by library\nFilter footprint list by library", () => toggle("lib"), { on: () => flags.lib }), sep(), filterInput);
  let api: { finish(apply: boolean): void } | null = null;
  const menus: [string, () => PopItem[]][] = [
    ["File", () => [{ label: "Save to Schematic\t" + keyName("Ctrl+S"), disabled: ro || !dirty(), run: () => { void apply(); } }, { sep: true }, { label: "Close Assign Footprints", run: () => api && api.finish(false) }]],
    ["Edit", () => [{ label: "Undo\t" + keyName("Ctrl+Z"), disabled: !undo.length, run: doUndo }, { label: "Redo\t" + keyName("Ctrl+Y"), disabled: !redo.length, run: doRedo }, { sep: true },
      { label: "Cut\t" + keyName("Ctrl+X"), disabled: ro, run: cut }, { label: "Copy\t" + keyName("Ctrl+C"), run: copy }, { label: "Paste\t" + keyName("Ctrl+V"), disabled: ro || !clip, run: paste }]],
    ["Preferences", () => [{ label: "Configure Paths...", run: () => appAction("configurePaths") }, { label: "Manage Footprint Libraries...", run: () => appAction("showFootprintLibTable") },
      { label: "Manage Footprint Association Files...", run: () => { const files = allDocs().filter((x) => /\.equ$/i.test(x.path)).map((x) => "${KIPRJMOD}/" + x.path);
        void messageBox(files.length ? "Footprint association files of this project:\n\n" + files.join("\n") : "This project has no footprint association files.\n\nAdd a .equ file to the project (lines of 'value' 'Library:Footprint') and Automatically Assign Footprints reads it.", "Footprint Association Files"); } },
      { label: "Preferences...\t" + keyName("Ctrl+,"), run: () => appAction("openPreferences") }]],
  ];
  const menubar = h("div", { class: "cv-menubar", role: "menubar" }, ...menus.map(([label, items]) => {
    const b = h("button", { type: "button", role: "menuitem", "data-menu": label }, label) as HTMLButtonElement;
    b.tabIndex = -1; b.addEventListener("mousedown", (ev) => ev.preventDefault());
    b.addEventListener("click", () => { const r = b.getBoundingClientRect(); popupMenu(r.left, r.bottom, items().map((it) => (it.label ? Object.assign(it, { label: it.label.replace("\t", "      ") }) : it))); });
    return b;
  }));

  // ---- keys (CVPCB_ACTIONS' hotkeys and the list boxes' own)
  const moveIn = (delta: number): void => {
    if (focus === "sym") { if (!rows.length) return; cur = Math.max(0, Math.min(rows.length - 1, cur + delta)); selected = new Set([cur]); anchor = cur; symbolChanged(); }
    else if (focus === "fp") { if (!fps.length) return; fpSel = Math.max(0, Math.min(fps.length - 1, fpSel + delta)); fpList.reveal(fpSel); status(); }
    else { if (!libs.length) return; const i = Math.max(0, Math.min(libs.length - 1, libs.findIndex((l) => l.name === curLib) + delta)); pickLib(libs[i].name); libList.reveal(i); }
  };
  const onKey = (ev: KeyboardEvent): void => {
    const mod = ev.ctrlKey || ev.metaKey, inText = ev.target === filterInput, k = ev.key.toLowerCase();
    const page = Math.max(1, Math.floor((paneOf[focus].clientHeight || 400) / ROW_H) - 1);
    let handled = true;
    // an open menu of the menu bar takes Escape; the frame stays
    if (ev.key === "Escape") { const pops = Array.from(document.querySelectorAll(".kd-pop")); if (!pops.length) return; for (const p of pops) p.remove(); ev.preventDefault(); ev.stopPropagation(); return; }
    if (mod && k === "s") void apply();
    else if (mod && k === "z" && !ev.shiftKey) doUndo();
    else if (mod && (k === "y" || (k === "z" && ev.shiftKey))) doRedo();
    else if (inText) { if (ev.key === "Enter") { window.clearTimeout(filterTimer); filterText = filterInput.value; filterFps(); } else handled = false; }
    else if (mod && k === "x") cut(); else if (mod && k === "c") copy(); else if (mod && k === "v") paste();
    else if (ev.key === "Tab" && paneOf[focus] === ev.target) { const order: Pane[] = ["lib", "sym", "fp"]; setFocus(order[(order.indexOf(focus) + (ev.shiftKey ? 2 : 1)) % 3]); }
    else if (ev.key === "Enter" && (ev.target as HTMLElement).classList.contains("cv-list")) associate();
    else if ((ev.key === "Delete" || ev.key === "Backspace") && (ev.target as HTMLElement).classList.contains("cv-list")) deleteAssoc();
    else if (ev.key === "ArrowDown") moveIn(1); else if (ev.key === "ArrowUp") moveIn(-1);
    else if (ev.key === "PageDown") moveIn(page); else if (ev.key === "PageUp") moveIn(-page);
    else if (ev.key === "Home") moveIn(-1e9); else if (ev.key === "End") moveIn(1e9);
    else handled = false;
    if (handled) { ev.preventDefault(); ev.stopPropagation(); refreshTools(); }
  };

  build();
  api = KD().open({ title: "Assign Footprints", cls: "kd-wide cv-frame", readOnly: ro,
    extra: ro ? [] : [{ label: "Apply, Save Schematic & Continue", id: "kd-af-apply", fn: () => { void apply(); } }],
    build(body) {
      const pane = (title: string, el: HTMLElement) => h("div", { class: "cv-pane" }, h("span", null, title), el);
      body.append(menubar, toolbar, h("div", { class: "cv-panes" }, pane("Footprint Libraries", libList.el), pane("Symbol : Footprint Assignments", symList.el), pane("Filtered Footprints", fpList.el)),
        h("div", { class: "cv-status" }, st0, st1, st2));
      body.addEventListener("keydown", onKey);
      drawLibs(); drawSyms(); filterFps(); refreshTools();
      requestAnimationFrame(() => { symList.redraw(); setFocus("sym"); });
    },
    ok() { closed = true; window.clearTimeout(filterTimer); void apply(); },
    cancel() { closed = true; window.clearTimeout(filterTimer); } });

  // ---- loading: the library tables, then every library's footprint list (FOOTPRINT_LIST::ReadFootprintFiles)
  const project: LibraryEntry[] = projectLibraries("footprint", ctx.docs).map((l) => ({ name: l.name, description: "Project library", source: "project" as const }));
  const loadAll = (list: LibraryEntry[]): void => {
    const queue = list.slice(); pendingLibs += queue.length; let tick = 0;
    const later = (): void => { if (!tick) tick = window.setTimeout(() => { tick = 0; if (!closed && KD().isOpen()) { filterFps(); selectFpOf(rows[cur]); } }, 150); };
    const worker = async (): Promise<void> => { for (;;) { const l = queue.shift(); if (!l || closed) return; try { index.set(l.name, await libraryIndex("footprint", l, ctx)); } catch { index.set(l.name, []); } pendingLibs--; later(); } };
    void Promise.all([worker(), worker(), worker(), worker()]);
  };
  libs = project.slice(); drawLibs();
  officialLibraries("footprint").then((t) => { const taken = new Set(project.map((l) => l.name)); return t.libraries.filter((l) => !taken.has(l.name)); }, (e: Error) => { tableError = "KiCad libraries unavailable: " + (e.message || e); return [] as LibraryEntry[]; })
    .then((official) => {
      if (closed || !KD().isOpen()) return;
      libs = project.concat(official); drawLibs(); status();
      // CVPCB_MAINFRAME::OnSelectComponent: the library of the first symbol's footprint is the selected one
      const r = rows[cur], lib = r && r.fp.includes(":") ? r.fp.slice(0, r.fp.indexOf(":")) : "";
      if (lib && libs.some((l) => l.name === lib)) { curLib = lib; drawLibs(); libList.reveal(libs.findIndex((l) => l.name === lib)); }
      loadAll(libs);
    });
  const others = projectDocs().filter((d) => d.docType === "kicad_sch" && d.docId !== here);
  if (others.length) void Promise.all(others.map((d) => readDoc(d.docId, "kicad_sch").then((od) => { docs.set(d.docId, od); }, () => { /* left out */ }))).then(() => { if (!closed && KD().isOpen()) { build(); symbolChanged(); } });
}
