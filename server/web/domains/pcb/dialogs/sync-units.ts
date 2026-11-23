// dialogs/sync-units.ts — SCH_SYMBOL::SyncOtherUnits as a commit: the edit of one unit of an annotated multi-unit
// symbol carries its Value, other fields, exclude / DNP flags, pin map override and alternate pin assignments to
// every other unit with the same reference and lib_id on every sheet of the hierarchy, in the same undo step
// (DIALOG_SYMBOL_PROPERTIES::TransferDataFromWindow, DIALOG_FIELD_PROPERTIES and the properties panel).
import { E, appState, pushUndoFor, undoStack } from "./editor";
import { messageBox } from "./sch-items";
import { projectDocs, readDoc, submitDocOp } from "./project";
import * as L from "./sch-items-logic";
import * as P from "./sym-props-logic";
import { netMap, currentInstance } from "../editor/schnets";
import { currentVariant } from "../editor/variant";
import * as VM from "../canvas/variant-model";

interface SchH { isPowerSymbol(d: KDoc, name: string): boolean }
const SH = (): SchH | null => { const m = CollabTools.sch; return m && m._ ? m._ as unknown as SchH : null; };
const libUnits = (doc: KDoc, node: SNode): number => { const H = (CollabTools as unknown as { props?: { helpers?: { libUnitCount(d: KDoc, n: SNode): number } } }).props; return H && H.helpers ? H.helpers.libUnitCount(doc, node) : 1; };
const curPath = (): string => { const s = appState.docs.find((d) => d.docId === appState.docId); return s ? s.path : ""; };

/**
 * Commit `changes` (which hold the edited symbol's new node `out`) together with the other units' updates.  `property`
 * is the single property a properties-panel edit changed (SyncOtherUnits' aProperty), null for a dialog OK.
 */
export function commitWithOtherUnits(ctx: ToolCtx & { doc: KDoc }, item: KItem, out: SNode, changes: KChange[], label: string, property: string | null = null): void {
  const doc = ctx.doc, what = P.syncFor(property);
  const units = otherUnitsOf(doc, item, out); if (!units) { ctx.commit(changes, label); return; }
  const all = changes.slice();
  // SyncOtherUnits( aSourceSheet, …, aVariantName ): each other unit is written on the sheet paths it was found on
  const variant = currentVariant(), ver = doc.version;
  // GetPinMapOverride( &aSourceSheet, aVariantName ): a source unit that delegates hands on unit 1's record
  let srcPinMap = VM.symbolPinMapOverride(out, variant, units.srcPath);
  if (srcPinMap.mode === "delegate") { const K = KiCadCanvas as unknown as { delegatedPinMapOverride?: (d: KDoc, i: KItem, v: string) => VM.PinMapOverrideState }; srcPinMap = K.delegatedPinMapOverride ? K.delegatedPinMapOverride(doc, Object.assign({}, item, { node: out }) as KItem, variant) : VM.defaultPinMapOverride(); }
  const instOf = (id: string): P.SyncInstance => ({ variant, srcPath: units.srcPath, dstPaths: units.paths.get(id) || [], ver, srcPinMap });
  for (const it of units.here) { const node = P.syncUnit(out, it.node, what, instOf(it.id)); if (node) all.push(KiCadCanvas.replaceChange(doc, Object.assign({}, it, { node, geom: [], bbox: null }) as KItem)); }
  // `if( !commit.Empty() ) commit.Push()`: a symbol being placed stages nothing of its own
  if (all.length) ctx.commit(all, label);
  commitOtherSheets(label, units.there, (n) => P.syncUnit(out, n, what, instOf(L.str((L.kid(n, "uuid") || [])[1]))), all.length > 0);
}

/**
 * CollectOtherUnits( ref, unit, libId, sheet ) over Schematic().Hierarchy() for the annotated multi-unit symbol `item`
 * (its node as `node`): the other units on the open sheet (`here`) and, per other sheet file, their ids with that
 * file's document as the net map holds it (`there`).  Null when the symbol is single-unit or not annotated.
 */
export function otherUnitsOf(doc: KDoc, item: KItem, node: SNode = item.node): { here: KItem[]; there: { file: string; doc: KDoc; ids: string[] }[]; paths: Map<string, string[]>; srcPath: string | null } | null {
  if (item.kind !== "symbol") return null;
  const c = netMap(), here = currentInstance(c);
  const pro = projectDocs().find((d) => d.docType === "kicad_pro");
  const project = pro ? (pro.path.split("/").pop() || "").replace(/\.kicad_pro$/, "") : null;
  const path = here && here.uuidPath.length ? "/" + here.uuidPath.join("/") : null;
  const e = L.instanceEntry(node, path, project);
  const refP = L.kids(node, "property").find((p) => L.fieldName(p) === "Reference");
  const ref = e && L.kid(e, "reference") ? L.str((L.kid(e, "reference") as SNode)[1]) : refP ? L.fieldValue(refP) : "";
  const unit = e && L.kid(e, "unit") ? L.num((L.kid(e, "unit") as SNode)[1], 1) : L.num((L.kid(node, "unit") || [0, 1])[1], 1);
  const libId = L.str((L.kid(node, "lib_id") || [])[1]);
  if (libUnits(doc, node) < 2 || !P.isAnnotated(ref)) return null;
  const cur = curPath();
  const sheets: { path: string; doc: KDoc; file: string }[] = [];
  if (c && c.instances.length) for (const inst of c.instances) { const d = inst.file === cur ? doc : c.docs.get(inst.file); if (d) sheets.push({ path: "/" + inst.uuidPath.join("/"), doc: d, file: inst.file }); }
  else sheets.push({ path: path || "", doc, file: cur });
  const H = SH(); const isPower = (d: KDoc, it: KItem): boolean => !!H && H.isPowerSymbol(d, L.str((L.kid(it.node, "lib_id") || [])[1]));
  const hits = P.collectOtherUnits(sheets, item, ref, unit, libId, project, isPower);
  const mine = new Map<string, KItem>(); const theirs = new Map<string, { file: string; doc: KDoc; ids: string[] }>();
  const paths = new Map<string, string[]>();
  for (const h of hits) {
    const ps = paths.get(h.item.id) || []; if (h.sheet.path && !ps.includes(h.sheet.path)) ps.push(h.sheet.path); paths.set(h.item.id, ps);
    if (h.sheet.file === cur || h.sheet.doc === doc) { const it = doc.items.get(h.item.id); if (it) mine.set(it.id, it); }
    else { const t = theirs.get(h.sheet.file) || { file: h.sheet.file, doc: h.sheet.doc, ids: [] }; if (!t.ids.includes(h.item.id)) t.ids.push(h.item.id); theirs.set(h.sheet.file, t); }
  }
  return { here: [...mine.values()], there: [...theirs.values()], paths, srcPath: path };
}

/**
 * The part of a commit that lands on other sheet files: each one's units (`there`) re-read and changed by `edit`
 * (null leaves a unit alone), submitted to that document and folded into the undo step the open sheet's commit just
 * pushed, so one Undo puts every sheet back.
 */
export function commitOtherSheets(label: string, there: { file: string; ids: string[] }[], edit: (node: SNode) => SNode | null, attach = true): void {
  if (!there.length || E.viewOnly) return;
  const entry = attach ? undoStack[undoStack.length - 1] : null;
  void (async () => {
    const done: { docId: string; file: string; changes: KChange[]; inverse: KChange[] }[] = [], failed: string[] = [];
    for (const { file, ids } of there) {
      const de = projectDocs().find((d) => d.path === file); if (!de) continue;
      try {
        const fresh = await readDoc(de.docId, "kicad_sch");
        const ch: KChange[] = [], inv: KChange[] = [];
        for (const id of ids) { const it = fresh.items.get(id); if (!it) continue; const n = edit(it.node); if (!n) continue; inv.push(KiCadCanvas.replaceChange(fresh, it)); ch.push(KiCadCanvas.replaceChange(fresh, Object.assign({}, it, { node: n, geom: [], bbox: null }) as KItem)); }
        if (!ch.length) continue;
        await submitDocOp(de.docId, ch); done.push({ docId: de.docId, file, changes: ch, inverse: inv });
      } catch (err) { failed.push(file); }
    }
    if (done.length) {
      const replay = (which: "changes" | "inverse") => () => { for (const o of done) submitDocOp(o.docId, o[which]).catch(() => { void messageBox(`Could not update '${o.file}'.`); }); };
      if (entry && undoStack.includes(entry)) Object.assign(entry, { undoOthers: replay("inverse"), redoOthers: replay("changes") });
      else pushUndoFor(String(appState.docId || ""), { label, changes: [], inverse: [], undoOthers: replay("inverse"), redoOthers: replay("changes") });
    }
    if (failed.length) void messageBox(`Could not update ${failed.map((f) => `'${f}'`).join(", ")}.`);
  })();
}

/**
 * SCH_EDIT_TOOL::SetAttribute (the Attributes menu: Exclude from Simulation / Bill of Materials / Board / Position
 * Files, Do not Populate): the flag `key` is turned on for every item when any of them (the selection plus, for an
 * annotated multi-unit symbol, its other units on every sheet) has it off, otherwise turned off for all, in one
 * "Toggle Attribute" commit.  `set` writes the state into a copy of a node.  False when there is nothing to toggle.
 */
export function toggleAttribute(ctx: ToolCtx & { doc: KDoc }, items: KItem[], isOn: (node: SNode) => boolean, set: (node: SNode, on: boolean) => SNode): boolean {
  const doc = ctx.doc; if (!items.length) return false;
  const here = new Map<string, KItem>(); const there = new Map<string, { file: string; doc: KDoc; ids: string[] }>();
  for (const it of items) {
    here.set(it.id, it);
    const u = it.kind === "symbol" ? otherUnitsOf(doc, it) : null; if (!u) continue;
    for (const o of u.here) here.set(o.id, o);
    for (const t of u.there) { const m = there.get(t.file) || { file: t.file, doc: t.doc, ids: [] }; for (const id of t.ids) if (!m.ids.includes(id)) m.ids.push(id); there.set(t.file, m); }
  }
  let on = false;
  for (const it of here.values()) if (!isOn(it.node)) { on = true; break; }
  if (!on) for (const t of there.values()) for (const id of t.ids) { const it = t.doc.items.get(id); if (it && !isOn(it.node)) { on = true; break; } }
  const changes: KChange[] = [];
  for (const it of here.values()) { const node = set(it.node, on); if (JSON.stringify(node) !== JSON.stringify(it.node)) changes.push(KiCadCanvas.replaceChange(doc, Object.assign({}, it, { node, geom: [], bbox: null }) as KItem)); }
  const label = "Toggle Attribute";
  if (changes.length) ctx.commit(changes, label);
  commitOtherSheets(label, [...there.values()], (n) => { const out = set(n, on); return JSON.stringify(out) === JSON.stringify(n) ? null : out; }, changes.length > 0);
  return true;
}

// ---------------------------------------------------------------- SCH_EDIT_FRAME::SelectUnit

/** LIB_SYMBOL::GetUnitDisplayName( unit, false ): the unit's own (unit_name …), else its letters ("A", "B", … "AA"). */
export function unitDisplayLetters(lib: SNode | null, unit: number): string {
  if (lib) for (const sub of L.kids(lib, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(L.str(sub[1])), un = L.kid(sub, "unit_name");
    if (m && +m[1] === unit && un && L.str(un[1])) return L.str(un[1]);
  }
  let n = unit, s = ""; while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}
/** SCH_SHEET_PATH::PathHumanReadable( true, true ): "/Sub" for a sub-sheet, "" for the root ("Root" in the message). */
export function sheetNameForMessage(human: string | null | undefined): string {
  const t = String(human || "").replace(/\/+$/, "");
  return t || "Root";
}
const UNIT_PLACED_KEY = "kc.dontshow.unitAlreadyPlaced";
/** KIDIALOG( msg, "Unit Already Placed", wxYES_NO | wxCANCEL | wxICON_WARNING ) with its Yes / No labels and "Do not show
 *  again": resolves "swap" (Yes), "duplicate" (No) or null (Cancel); a remembered answer is returned without asking. */
function askUnitPlaced(message: string, swapLabel: string, dupLabel: string): Promise<"swap" | "duplicate" | null> {
  let kept: string | null = null; try { kept = localStorage.getItem(UNIT_PLACED_KEY); } catch { kept = null; }
  if (kept === "swap" || kept === "duplicate") return Promise.resolve(kept);
  return new Promise((resolve) => {
    const ov = document.createElement("div"); ov.className = "kd-overlay"; ov.style.zIndex = "10050";
    const dlg = document.createElement("div"); dlg.className = "kd-dialog"; dlg.setAttribute("role", "alertdialog"); dlg.style.cssText = "width:max-content;min-width:440px;max-width:min(640px, calc(100vw - 32px))";
    const title = document.createElement("div"); title.className = "kd-title"; title.textContent = "Unit Already Placed";
    const body = document.createElement("div"); body.className = "kd-body";
    const p = document.createElement("p"); p.style.cssText = "margin:4px 0 8px;white-space:pre-wrap"; p.textContent = message;
    const lbl = document.createElement("label"); lbl.style.cssText = "display:flex;gap:6px;align-items:center";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.style.cssText = "width:auto;margin:0"; lbl.append(cb, "Do not show again");
    body.append(p, lbl);
    const foot = document.createElement("div"); foot.className = "kd-foot";
    const spacer = document.createElement("span"); spacer.className = "spacer";
    const done = (r: "swap" | "duplicate" | null): void => {
      ov.remove(); window.removeEventListener("keydown", key, true);
      if (r && cb.checked) { try { localStorage.setItem(UNIT_PLACED_KEY, r); } catch { /* no storage */ } }
      resolve(r);
    };
    const btn = (text: string, r: "swap" | "duplicate" | null, primary = false): HTMLButtonElement => { const b = document.createElement("button"); b.type = "button"; b.className = "btn" + (primary ? " primary" : ""); b.textContent = text; b.addEventListener("click", () => done(r)); return b; };
    const swap = btn(swapLabel, "swap", true);
    foot.append(spacer, swap, btn(dupLabel, "duplicate"), btn("Cancel", null));
    const key = (ev: KeyboardEvent): void => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopImmediatePropagation(); done(null); } };
    window.addEventListener("keydown", key, true);
    dlg.append(title, body, foot); ov.append(dlg); document.body.append(ov); swap.focus();
  });
}

/**
 * SCH_EDIT_FRAME::SelectUnit( symbol, unit ): when another symbol of the same reference holds the unit somewhere in the
 * hierarchy (FindSymbolByRefAndUnit), "Symbol unit '%s' is already placed (on sheet '%s')" offers to swap the two
 * units or to duplicate the unit; the symbol's fields are autoplaced again when they were; the commit is "Swap Units"
 * or "Change Unit".  True when the request was taken (the answer may still be Cancel).
 * `write`: the symbol is the one being placed (GetEditFlags() != 0): it is not staged, its new node goes to `write`,
 * and only a swapped holder is committed (its fields autoplaced again only then, as nothing was staged otherwise).
 */
/** The symbol being placed is still the one on the cursor (the question may outlive the placement). */
function carriedStill(id: string): boolean {
  const c = CollabTools.sch ? (CollabTools.sch.state as { carry?: { node: SNode } | null }).carry : null;
  return !!c && KiCadCanvas.uuidOf(c.node) === id;
}
export function selectUnit(ctx: ToolCtx & { doc: KDoc }, item: KItem, unit: number, write?: (node: SNode) => void): boolean {
  const doc = ctx.doc, node0 = item.node;
  const lib = (KiCadCanvas.resolveLib(doc, L.str((L.kid(node0, "lib_id") || [])[1])) as SNode | null) || null;
  const count = libUnits(doc, node0);
  const c = netMap(), here = currentInstance(c);
  const pro = projectDocs().find((d) => d.docType === "kicad_pro");
  const project = pro ? (pro.path.split("/").pop() || "").replace(/\.kicad_pro$/, "") : null;
  const path = here && here.uuidPath.length ? "/" + here.uuidPath.join("/") : null;
  const unitAt = (n: SNode, p: string | null): number => { const e = L.instanceEntry(n, p, project); return e && L.kid(e, "unit") ? L.num((L.kid(e, "unit") as SNode)[1], 1) : L.num((L.kid(n, "unit") || [0, 1])[1], 1); };
  const current = unitAt(node0, path);
  if (count <= 1 || current === unit) return true;
  if (unit > count) unit = count;
  // FindSymbolByRefAndUnit over the hierarchy: the first symbol of this reference holding the unit
  const units = otherUnitsOf(doc, item);
  let holder: { item: KItem; path: string; file: string | null; human: string } | null = null;
  const humanOf = (p: string | null): string => { const inst = c ? c.instances.find((i) => "/" + i.uuidPath.join("/") === p) : null; return inst ? inst.human : here ? here.human : ""; };
  if (units) {
    for (const it of units.here) for (const p of units.paths.get(it.id) || [path || ""]) if (!holder && unitAt(it.node, p) === unit) holder = { item: it, path: p, file: null, human: humanOf(p) };
    for (const t of units.there) for (const id of t.ids) {
      const it = t.doc.items.get(id); if (!it || holder) continue;
      for (const p of units.paths.get(id) || []) if (!holder && unitAt(it.node, p) === unit) holder = { item: it, path: p, file: t.file, human: humanOf(p) };
    }
  }
  const apply = (swap: boolean): void => {
    const helpers = (CollabTools as unknown as { props: { helpers: { setSymbolUnit(n: SNode, u: number): void } } }).props.helpers;
    const node = KiCadCanvas.cloneNode ? (KiCadCanvas.cloneNode as (n: SNode) => SNode)(node0) : JSON.parse(JSON.stringify(node0)) as SNode;
    helpers.setSymbolUnit(node, unit); L.setInstanceData(node, path, project, { unit });
    let out = node;
    // `if( !staged ) return;`: a carried symbol with no holder to swap changes its unit and nothing else
    const staged = !write || (swap && !!holder);
    // m_AutoplaceFields.enable: fields autoplaced (AUTO or MANUAL) are autoplaced again with their algorithm
    const sch = CollabTools.sch, ap = sch ? (sch.state as { autoplace?: { enable?: boolean } }).autoplace : null, fa = L.kid(node, "fields_autoplaced");
    if (staged && sch && (!ap || ap.enable !== false) && fa && L.str(fa[1]) !== "no") {
      try { const placed = (sch._ as unknown as { autoplaceNode(d: KDoc, it: KItem): SNode | null }).autoplaceNode(doc, Object.assign({}, item, { node }) as KItem); if (placed) out = placed; } catch { /* the fields stay where they are */ }
    }
    if (write) write(out);
    if (!staged) return;
    const changes: KChange[] = write ? [] : [KiCadCanvas.replaceChange(doc, Object.assign({}, item, { node: out, geom: [], bbox: null }) as KItem)];
    // Swap: the other symbol gets the unit this one had
    const giveOld = (n: SNode, p: string): SNode => { const m = KiCadCanvas.cloneNode ? (KiCadCanvas.cloneNode as (x: SNode) => SNode)(n) : JSON.parse(JSON.stringify(n)) as SNode; helpers.setSymbolUnit(m, current); L.setInstanceData(m, p, project, { unit: current }); return m; };
    if (swap && holder && !holder.file) changes.push(KiCadCanvas.replaceChange(doc, Object.assign({}, holder.item, { node: giveOld(holder.item.node, holder.path), geom: [], bbox: null }) as KItem));
    const label = swap ? "Swap Units" : "Change Unit";
    if (changes.length) ctx.commit(changes, label);
    if (swap && holder && holder.file) { const h = holder; commitOtherSheets(label, [{ file: h.file!, ids: [h.item.id] }], (n) => giveOld(n, h.path)); }
  };
  if (!holder) { apply(false); return true; }
  const target = unitDisplayLetters(lib, unit), currName = unitDisplayLetters(lib, current);
  void askUnitPlaced(`Symbol unit '${target}' is already placed (on sheet '${sheetNameForMessage(holder.human)}')`, `Swap '${target}' and '${currName}'`, `Duplicate '${target}'`).then((r) => {
    if (r === null || ctx.doc !== doc || (write ? !carriedStill(item.id) : !doc.items.has(item.id))) return;
    apply(r === "swap");
  });
  return true;
}
