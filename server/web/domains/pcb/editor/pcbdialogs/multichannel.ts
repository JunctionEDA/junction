// pcbdialogs/multichannel — the board editor's side of MULTICHANNEL_TOOL (pcbnew/tools/multichannel_tool.cpp) and of
// PCB_CONTROL::ApplyDesignBlockLayout: Tools > Multi-Channel > Generate Placement Rule Areas... (DIALOG_MULTICHANNEL_
// GENERATE_RULE_AREAS), Repeat Layout... (the modeless DIALOG_MULTICHANNEL_REPEAT_LAYOUT with its preview on the
// board), Update Linked Layouts, Unlink Layout, Expand Selection by One Step / to Largest Matching Topology, the
// selection menu's Multi-Channel sub-menu conditions, Properties on a repeated channel's group, and Apply Design
// Block Layout (also run by Update PCB from Schematic's "Apply design block layouts to new groups").  The logic is
// pcb-tools/multichannel.ts; this file asks, shows and commits.
import type * as McApi from "../../tools/pcb-tools/multichannel";
import { E } from "../state";
import { toast } from "../util";
import { toolCtx } from "../tools";
import { pcbState } from "../gestures";
import { overlayHooks } from "../overlays";
import { propertiesHooks } from "../pointer";
import { designBlockBoard } from "../design-blocks";
import { checkField, grid, h, notebook, openDialog, selectField, type DialogApi, type GridApi } from "./ui";
import { progressDialog, type Reporter } from "./zonefill";

type Mc = typeof McApi;
type Multichannel = McApi.Multichannel;
type RuleArea = McApi.RuleArea;
interface PcbToolsApi {
  multichannel: Mc;
  selectionIds(ctx: ToolCtx): Set<string>;
  applySelection(ctx: ToolCtx, ids: Iterable<string>): void;
  pickInteractively(ctx: ToolCtx, mode: "item", prompt: string, done: (r: KItem | null) => void, filter?: (it: KItem) => boolean): void;
  overrideLocks?(): boolean;
}
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;
const MC = (): Mc => PT().multichannel;
const board = (ctx: ToolCtx): KDoc | null => (ctx.doc && ctx.doc.type === "pcb" ? ctx.doc : null);
const infoMsg = (msg: string): void => toast(msg, 6000, undefined, "info");
const infoError = (msg: string): void => toast(msg, 6000, undefined, "error");
const infoWarning = (msg: string): void => toast(msg, 6000, undefined, "warning");
const selected = (ctx: ToolCtx): KItem[] => { const d = board(ctx); return d ? [...PT().selectionIds(ctx)].map((id) => d.items.get(id)).filter(Boolean) as KItem[] : []; };
function select(ctx: ToolCtx, ids: string[]): void {
  (ctx as unknown as { setSelection?(ids: string[]): void }).setSelection?.(ids);
  PT().applySelection(ctx, ids);
  ctx.requestRender();
}
const kidStr = (n: SNode, k: string): string => { const c = KiCadCanvas.kid(n, k) as SNode | null; return c && c.length > 1 ? KiCadCanvas.str(c[1]) : ""; };
const zoneName = (n: SNode): string => kidStr(n, "name");
const refOf = (fp: KItem): string => { for (const c of fp.node) if (Array.isArray(c) && c[0] === "property" && KiCadCanvas.str(c[1]) === "Reference") return KiCadCanvas.str(c[2]); return ""; };

// ---------------------------------------------------------------- progress (resolveTopologies' reporter)
/** WX_PROGRESS_REPORTER shown once the work takes longer than 250 ms, with Cancel. */
function topologyProgress(mc: Multichannel): { report: McApi.RulesProgress; close(): void } {
  const t0 = Date.now(); let rep: Reporter | null = null; let high = 0;
  mc.cancelled = () => !!rep && rep.cancelled();
  return {
    report(title, done, total, matched, of) {
      if (!rep && Date.now() - t0 > 250) rep = progressDialog(title, 1);
      if (rep) {
        const p = (done + (of > 0 ? matched / of : 0)) / Math.max(1, total); if (p > high) high = p;
        rep.phase(1, `Resolving topology ${Math.min(done + 1, total)} of ${total} (${matched}/${of} components)`); rep.advance(high, 1);
        if (rep.cancelled()) return false;
      }
      return true;
    },
    close() { if (rep) rep.close(); rep = null; mc.cancelled = () => false; },
  };
}

// ---------------------------------------------------------------- ShowTopologyMismatchReasons
/** wxRichMessageDialog( summary, "Topology mismatch", wxICON_ERROR ) with the reasons as its detailed text. */
function showMismatchDetails(summary: string, reasons: string[], child: boolean): void {
  if (!reasons.length) return;
  const details = h("pre", { style: "display:none;margin:6px 0 0;max-height:260px;overflow:auto;white-space:pre-wrap;font:inherit" }, reasons.join("\n"));
  const toggle = h("button", { type: "button", class: "btn", style: "margin-top:8px" }, "See details");
  toggle.addEventListener("click", () => { const on = details.style.display === "none"; details.style.display = on ? "block" : "none"; toggle.textContent = on ? "Hide details" : "See details"; });
  openDialog({ title: "Topology mismatch", width: 480, noOk: true, cancelLabel: "OK", child,
    build(body) { body.append(h("p", { style: "margin:4px 0;white-space:pre-wrap" }, summary), toggle, details); } });
}

// ---------------------------------------------------------------- Generate Placement Rule Areas
/** MULTICHANNEL_TOOL::AutogenerateRuleAreas */
export function generatePlacementRuleAreas(ctx: ToolCtx): void {
  const doc = board(ctx); if (!doc) return;
  if (E.viewOnly) { ctx.toast("This board is read-only"); return; }
  closeRepeatDialog();
  const mc = new (MC().Multichannel)(doc);
  mc.generatePotentialRuleAreas();
  if (mc.areas.length <= 1) {
    infoError("Cannot auto-generate any placement areas because the schematic has only one or no hierarchical sheets, groups, or component classes.");
    return;
  }
  type Row = Record<string, string | boolean | number>;
  const rowsOf = (t: McApi.SourceType): { row: Row; ra: RuleArea }[] => mc.areas.filter((a) => a.sourceType === t).map((ra) => { const row: Row = t === "sheetname" ? { gen: ra.generateEnabled, a: ra.sheetPath, b: ra.sheetName } : { gen: ra.generateEnabled, a: t === "component_class" ? ra.componentClass : ra.groupName }; return { ra, row }; });
  const sheets = rowsOf("sheetname"), classes = rowsOf("component_class"), grps = rowsOf("group");
  const replace = checkField(mc.replaceExisting, "Replace existing placement rule areas");
  const groupItems = checkField(mc.options.groupItems, "Group footprints with their placement rule areas");
  const page = (rows: { row: Row }[], cols: { key: string; label: string }[]) => (el: HTMLElement): void => {
    const g = grid([{ key: "gen", label: "Generate", type: "check", width: "80px" }, ...cols.map((c) => ({ ...c, type: "ro" as const }))], rows.map((r) => r.row), { height: "360px" });
    el.append(g.el);
  };
  // the Sheets page is skipped for the next one when it holds only the root sheet
  const start = sheets.length === 1 ? (classes.length ? 1 : grps.length ? 2 : 0) : 0;
  const book = notebook([
    { label: "Sheets", build: page(sheets, [{ key: "a", label: "Sheet Path" }, { key: "b", label: "Sheet Name" }]) },
    { label: "Component Classes", build: page(classes, [{ key: "a", label: "Component Class" }]) },
    { label: "Groups", build: page(grps, [{ key: "a", label: "Name" }]) },
  ], { start, onShow: (i) => { groupItems.input.disabled = i === 2; groupItems.el.classList.toggle("disabled", i === 2); } });
  openDialog({ title: "Generate Multichannel Rule Areas", width: 640,
    build(body) {
      body.append(h("div", { style: "min-height:400px;display:flex;flex-direction:column" }, book.el), h("div", { style: "display:flex;flex-direction:column;gap:2px;margin-top:8px" }, replace.el, groupItems.el));
      if (book.current() === 2) { groupItems.input.disabled = true; groupItems.el.classList.add("disabled"); }
    },
    ok() {
      for (const r of [...sheets, ...classes, ...grps]) r.ra.generateEnabled = !!r.row.gen;
      mc.replaceExisting = replace.get();
      // grouping is not offered for group sources
      mc.options.groupItems = book.current() === 2 ? false : groupItems.get();
      const changes = mc.autogenerateRuleAreas();
      if (changes.length) ctx.commit(changes as KChange[], "Auto-generate Placement Rule Areas");
      ctx.requestRender();
      return true;
    } });
}

// ---------------------------------------------------------------- the Repeat Layout preview
interface Preview { hidden: Set<string>; doc: KDoc; ids: Set<string>; bright: Set<string>; boxes: Map<string, number[]>; ratsnest: [number[], number[]][] }
let session: { mc: Multichannel; dlg: DialogApi | null; focus: RuleArea | null; preview: Preview | null; ctx: ToolCtx } | null = null;
const ES = E as { dialogGhosts?: { ids: Set<string>; dx: number; dy: number; bright?: boolean | Set<string>; doc?: KDoc }[] | null; dialogHidden?: Set<string> | null };
/** clearRepeatPreview */
function clearPreview(): void {
  if (session) session.preview = null;
  ES.dialogGhosts = null; ES.dialogHidden = null;
  toolCtx().requestRender();
}
/** UpdateRepeatPreview: the staged copy drawn over the board, what it replaces hidden. */
function updatePreview(): void {
  if (!session || !session.mc.refRA) { clearPreview(); return; }
  const mc = session.mc, p = mc.previewRepeat();
  const doc = { ...(mc.doc as KDoc), items: new Map() } as KDoc;
  for (const n of p.nodes) KiCadCanvas.addItem(doc, n);
  const ids = new Set(doc.items.keys());
  session.preview = { hidden: p.hidden, doc, ids, bright: p.bright, boxes: p.boxes, ratsnest: p.ratsnest };
  ES.dialogGhosts = ids.size ? [{ ids, dx: 0, dy: 0, bright: p.bright, doc }] : null;
  ES.dialogHidden = p.hidden.size ? new Set(p.hidden) : null;
  toolCtx().requestRender();
}
/** HighlightRepeatAreas: the reference parts green, the focused row's orange, and the moved parts' ratsnest. */
function drawHighlight(g: CanvasRenderingContext2D): void {
  const s = session; if (!s || !s.mc.refRA || !E.kdoc) return;
  const mark = (a: RuleArea, rgb: [number, number, number]): void => {
    const c = rgb.map((v) => Math.round(v * 255)).join(",");
    g.strokeStyle = `rgba(${c},0.9)`; g.fillStyle = `rgba(${c},0.08)`; g.lineWidth = 0.2;
    for (const fp of a.components) {
      const b = (s.preview && s.preview.boxes.get(fp.id)) || MC().footprintBox(fp); if (!b) continue;
      g.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]); g.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
    }
  };
  g.save(); g.setLineDash([]);
  mark(s.mc.refRA, [0.1, 0.8, 0.3]);
  if (s.focus) mark(s.focus, [1.0, 0.6, 0.1]);
  if (s.preview && s.preview.ratsnest.length) {
    g.strokeStyle = "rgba(153,204,255,0.8)"; g.lineWidth = 0.05; g.beginPath();
    for (const [a, b] of s.preview.ratsnest) { g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
    g.stroke();
  }
  g.restore();
}

// ---------------------------------------------------------------- DIALOG_MULTICHANNEL_REPEAT_LAYOUT
function closeRepeatDialog(): void { if (session && session.dlg) { const d = session.dlg; session.dlg = null; d.close(); } endSession(); }
/** onRepeatDialogClosed */
function endSession(): void { clearPreview(); session = null; }

function openRepeatDialog(ctx: ToolCtx, mc: Multichannel): void {
  session = { mc, dlg: null, focus: null, preview: null, ctx };
  interface Entry { ra: RuleArea; name: string; err: string; ok: boolean; reasons: string[]; row: Record<string, string | boolean | number> }
  let entries: Entry[] = [];
  let busy = false, pending = false;
  const refName = h("span", { "data-k": "refRAName" });
  let anchor = selectField<string>("", [["", ""]], { onChange: () => { void onOptionChanged(); } });
  anchor.el.title = "Optional, use for precise and/or rotated placement.\nSelect reference rule area footprint, place corresponding\ntarget rule area footprint(s).";
  const anchorHost = h("span", null, anchor.el);
  const onCheck = (): void => { readWindow(); updatePreview(); };
  const cbPlacement = checkField(true, "Copy footprint placement", { onChange: onCheck });
  const cbRouting = checkField(true, "Copy routing", { onChange: onCheck });
  const cbConnected = checkField(false, "Restrict to routing connected within the area", { tip: "Can be useful if unrelated tracks pass through the area", onChange: onCheck });
  const cbOther = checkField(true, "Copy other items", { tip: "Copy text, shapes, zones, and other items inside the source rule area", onChange: onCheck });
  const cbGroup = checkField(false, "Group items with their target rule areas", { onChange: onCheck });
  const cbLocked = checkField(true, "Include locked items", { tip: "Copy from reference area + delete / update in target area if included", onChange: onCheck });
  const cbLink = checkField(false, "Link these areas", { tip: "Update Linked Layouts copies a selected area to the others. Unlink Layout detaches it", onChange: onCheck });
  const cbLoose = checkField(false, "Allow loose matching", { tip: "Also offer channels that lack some of the selected parts on the edge of the circuit; those parts are left out of every channel",
    onChange: (on) => { void (async () => { const pr = topologyProgress(mc); try { await mc.discoverRepeatCandidates(on, pr.report); } finally { pr.close(); } updatePreview(); transferToWindow(); })(); } });
  const g: GridApi = grid([
    { key: "copy", label: "Copy", type: "check", width: "50px" },
    { key: "name", label: "Target Rule Area", type: "ro" },
    { key: "status", label: "Status", type: "ro" },
    { key: "details", label: "Details", type: "icon", width: "56px", icon: (row) => (row.details ? { icon: "help", title: "Show the reasons" } : null) },
  ], [], { height: "240px",
    onSelect: (i) => { if (session && entries[i]) { session.focus = entries[i].ra; toolCtx().requestRender(); } },
    onChange: () => { void onOptionChanged(); } });
  // OnGridCellLeftClick: the Details cell of a mismatched row shows the reasons
  g.el.addEventListener("click", (ev) => {
    const td = (ev.target as Element).closest("td.ico"); if (!td) return;
    const tr = td.parentElement as HTMLTableRowElement, i = Array.from(tr.parentElement!.children).indexOf(tr);
    const e = entries[i]; if (!e || e.ok || !e.reasons.length) return;
    showMismatchDetails(`Rule area topologies do not match: ${e.err}`, e.reasons, true);
  });

  /** readWindow */
  const readWindow = (): void => {
    entries.forEach((e) => { const c = mc.compat.get(e.ra); if (c) c.doCopy = !!e.row.copy; });
    mc.options.copyPlacement = cbPlacement.get(); mc.options.copyRouting = cbRouting.get(); mc.options.connectedRoutingOnly = cbConnected.get();
    mc.options.copyOtherItems = cbOther.get(); mc.options.groupItems = cbGroup.get(); mc.options.includeLockedItems = cbLocked.get();
    mc.linkAreas = cbLink.get();
    mc.options.anchor = "";
    // a duplicate reference designator outside the area must not become the anchor
    for (const fp of mc.refRA ? mc.refRA.components : []) if (refOf(fp) === anchor.get()) mc.options.anchor = fp.id;
  };
  /** TransferDataToWindow */
  const transferToWindow = (): void => {
    const ref = mc.refRA; if (!ref) return;
    const linkSet = ref.zone ? MC().linkOf(ref.zone).set : "";
    entries = [...mc.compat].map(([ra, c]) => {
      const linked = !!linkSet && !!ra.zone && MC().linkOf(ra.zone).set === linkSet;
      const name = ra.ruleName || MC().joinReferences(ra.components);   // a discovered channel is named after its parts until it is created
      return { ra, name, err: linked && c.isOk ? "OK (linked)" : c.errorMsg, ok: c.isOk, reasons: c.mismatchReasons, row: {} };
    });
    entries.sort((a, b) => (a.ok !== b.ok ? (a.ok ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) e.row = { copy: !!mc.compat.get(e.ra)!.doCopy, name: e.name, status: e.err, details: !e.ok && e.reasons.length ? 1 : 0 };
    g.setRows(entries.map((e) => e.row));
    refName.textContent = mc.fromSelection ? `${mc.selectedFootprints.length} selected footprints` : (ref.zone ? zoneName(ref.zone) : "");
    const refs = ["", ...ref.components.map(refOf)].sort();
    let pick = ""; for (const fp of ref.components) if (fp.id === mc.options.anchor) pick = refOf(fp);
    const next = selectField<string>(pick, refs.map((r) => [r, r] as [string, string]), { onChange: () => { void onOptionChanged(); } });
    next.el.title = anchor.el.title; anchorHost.replaceChildren(next.el); anchor = next;
    cbPlacement.set(mc.options.copyPlacement); cbRouting.set(mc.options.copyRouting); cbConnected.set(mc.options.connectedRoutingOnly);
    cbGroup.set(mc.options.groupItems); cbOther.set(mc.options.copyOtherItems); cbLocked.set(mc.options.includeLockedItems); cbLink.set(mc.linkAreas);
    // channels made from a selection are always groups; loose matching only applies to discovery
    cbGroup.input.disabled = mc.fromSelection; cbGroup.el.classList.toggle("disabled", mc.fromSelection);
    cbLoose.input.disabled = !mc.fromSelection; cbLoose.el.classList.toggle("disabled", !mc.fromSelection);
  };
  /** onOptionChanged: ticks and the anchor reshape the channels; a second refresh waits for the first */
  const onOptionChanged = async (): Promise<void> => {
    readWindow();
    if (busy) { pending = true; return; }
    busy = true;
    try {
      do {
        pending = false; readWindow();
        const pr = topologyProgress(mc);
        try { await mc.refreshRepeat(pr.report); } finally { pr.close(); }
        updatePreview(); transferToWindow();
      } while (pending);
    } finally { busy = false; }
  };

  const dlg = openDialog({ title: "Repeat Multichannel Layout", width: 560, modeless: true,
    build(body) {
      body.append(
        h("div", { style: "display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;margin-bottom:8px" },
          h("span", null, "Reference rule area:"), refName, h("span", null, "Anchor footprint:"), anchorHost),
        h("div", { style: "margin:4px 0" }, "Target areas:"), g.el,
        h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:2px 16px;margin-top:8px" },
          h("div", { style: "display:flex;flex-direction:column;gap:2px" }, cbPlacement.el, cbRouting.el, h("div", { style: "padding-left:20px" }, cbConnected.el), cbOther.el),
          h("div", { style: "display:flex;flex-direction:column;gap:2px" }, cbGroup.el, cbLocked.el, cbLink.el, cbLoose.el)));
      transferToWindow();
    },
    ok() {
      readWindow();
      applyRepeat(ctx, mc);
      return true;
    },
    cancel() { if (session && session.mc === mc) { session.dlg = null; endSession(); } } });
  if (!dlg) { endSession(); return; }
  session.dlg = dlg;
  // the dialog closes itself after OK; the session (and the preview) goes with it
  const gone = new MutationObserver(() => { if (!dlg.dialog.isConnected) { gone.disconnect(); if (session && session.mc === mc) { session.dlg = null; endSession(); } } });
  gone.observe(document.body, { childList: true, subtree: true });
  updatePreview();
}

/** ApplyRepeat: a selection's channels are made, or the copy goes onto the ticked rule areas. */
function applyRepeat(ctx: ToolCtx, mc: Multichannel): void {
  clearPreview();
  if (mc.fromSelection) {
    const res = mc.applySelectionRepeat(); if (!res) return;
    ctx.commit(res.changes as KChange[], "Repeat Layout");
    // editing the old loose selection would leave the reference area behind
    select(ctx, [res.refGroup]);
    infoMsg((mc.linkAreas ? "Created %d linked channels." : "Created %d channels.").replace("%d", String(res.created)));
    return;
  }
  const { changes, copied } = mc.repeatToRuleAreas();
  if (changes.length) ctx.commit(changes as KChange[], "Repeat Layout");
  infoMsg(`Copied to ${copied} Rule Areas.`);
}

/** MULTICHANNEL_TOOL::repeatLayout */
export async function repeatLayout(ctx: ToolCtx): Promise<void> {
  const doc = board(ctx); if (!doc) return;
  if (E.viewOnly) { ctx.toast("This board is read-only"); return; }
  const M = MC();
  const asRA = (it: KItem | undefined): boolean => !!it && it.kind === "zone" && M.isRuleArea(it.node) && M.placementOf(it.node).enabled;
  const sel = selected(ctx), refRAs: string[] = [];
  for (const it of sel) {
    if (asRA(it)) refRAs.push(it.id);
    else if (it.kind === "group") for (const c of it.node) if (Array.isArray(c) && c[0] === "members") for (const m of c.slice(1)) { const z = doc.items.get(KiCadCanvas.str(m)); if (z && asRA(z)) refRAs.push(z.id); }
  }
  closeRepeatDialog();
  const mc = new M.Multichannel(doc);
  const pr = topologyProgress(mc);
  try {
    // plain parts with no rule area are the reference, and the channels repeating them are discovered
    if (!refRAs.length && sel.some((it) => it.kind === "footprint" || it.kind === "group")) {
      if (!(await mc.startRepeatFromSelection(sel.map((it) => it.id), pr.report))) { pr.close(); infoMsg("Select the footprints of the circuit to repeat."); return; }
    } else if (refRAs.length !== 1) {
      pr.close();
      PT().pickInteractively(ctx, "item", "Select a reference Rule Area to copy from...", (it) => {
        if (!it) return;
        // UpdatePickedItem: the picked area is the selection the action runs on again
        select(ctx, [it.id]); void repeatLayout(toolCtx());
      }, (it) => asRA(it));
      return;
    } else {
      const r = await mc.startFromRuleArea(refRAs[0], pr.report);
      if (r === "cancelled") return;
      if (r === "none") { infoError("No Rule Areas to repeat layout to have been found."); return; }
    }
  } finally { pr.close(); }
  openRepeatDialog(ctx, mc);
}

// ---------------------------------------------------------------- linked layouts
/** MULTICHANNEL_TOOL::updateLinkedLayouts */
export async function updateLinkedLayouts(ctx: ToolCtx): Promise<void> {
  const doc = board(ctx); if (!doc) return;
  if (E.viewOnly) { ctx.toast("This board is read-only"); return; }
  const mc = new (MC().Multichannel)(doc);
  const sources = mc.linkedAreasIn(selected(ctx).map((it) => it.id));
  if (sources.length !== 1) { infoMsg(sources.length ? "Select items from a single linked channel." : "Select a linked Rule Area, or a part of one, to update the others from."); return; }
  // routerBusy: an interactive route in progress
  const p = pcbState();
  if (p && (p as { route?: unknown }).route) { infoWarning("Finish routing before updating linked layouts."); return; }
  // the dialog's session lives in the same data this rebuilds
  closeRepeatDialog();
  const pr = topologyProgress(mc);
  let res: Awaited<ReturnType<Multichannel["updateLinkedLayouts"]>>;
  try { res = await mc.updateLinkedLayouts(sources[0], pr.report); } finally { pr.close(); }
  if (res.warning) infoWarning(res.warning);
  if (res.copied && res.changes.length) ctx.commit(res.changes as KChange[], "Update Linked Layouts");
  ctx.requestRender();
}
/** MULTICHANNEL_TOOL::unlinkLayout */
export function unlinkLayout(ctx: ToolCtx): void {
  const doc = board(ctx); if (!doc) return;
  if (E.viewOnly) { ctx.toast("This board is read-only"); return; }
  const mc = new (MC().Multichannel)(doc);
  const members = mc.linkedAreasIn(selected(ctx).map((it) => it.id));
  if (!members.length) { infoMsg("Select a linked Rule Area, or a part of one, to unlink."); return; }
  const changes = mc.unlinkAreas(members);
  ctx.commit(changes as KChange[], "Unlink Layout");
  ctx.requestRender();
}

// ---------------------------------------------------------------- Expand Selection
/** MULTICHANNEL_TOOL::expandSelection */
export function expandSelection(ctx: ToolCtx, largest: boolean): void {
  const doc = board(ctx); if (!doc) return;
  const mc = new (MC().Multichannel)(doc);
  const seed: KItem[] = [];
  const collect = (g: KItem): void => { for (const c of g.node) if (Array.isArray(c) && c[0] === "members") for (const m of c.slice(1)) { const it = doc.items.get(KiCadCanvas.str(m)); if (!it) continue; if (it.kind === "footprint") { if (!seed.includes(it)) seed.push(it); } else if (it.kind === "group") collect(it); } };
  for (const it of selected(ctx)) { if (it.kind === "footprint") { if (!seed.includes(it)) seed.push(it); } else if (it.kind === "group") collect(it); }
  if (!seed.length) { infoMsg("Select a footprint to expand from."); return; }
  const expanded = mc.expandToMatchingTopology(seed, largest);
  if (expanded.length === seed.length) { infoMsg("No larger topology repeats elsewhere on the board."); return; }
  select(ctx, expanded.map((f) => f.id));
  infoMsg(`Selected ${expanded.length} parts that repeat elsewhere.`);
}

// ---------------------------------------------------------------- Apply Design Block Layout
/** PCB_CONTROL::ApplyDesignBlockLayout on the selected groups linked to a design block. */
export async function applyDesignBlockLayout(ctx: ToolCtx): Promise<boolean> {
  const doc = board(ctx); if (!doc) return false;
  if (E.viewOnly) { ctx.toast("This board is read-only"); return false; }
  const linked: KItem[] = []; let skippedNoLink = 0;
  for (const it of selected(ctx)) { if (it.kind !== "group") continue; if (kidStr(it.node, "lib_id")) linked.push(it); else skippedNoLink++; }
  if (!linked.length) { infoError("No groups with a linked design block are selected."); return false; }
  const M = MC();
  if (!E.overrideLocks) {
    const lockedNode = (n: SNode): boolean => { const l = KiCadCanvas.kid(n, "locked") as SNode | null; return l ? KiCadCanvas.str(l[1]) !== "no" : n.includes("locked"); };
    const anyLocked = (g: KItem): boolean => {
      if (lockedNode(g.node)) return true;
      for (const c of g.node) if (Array.isArray(c) && c[0] === "members") for (const m of c.slice(1)) { const it = doc.items.get(KiCadCanvas.str(m)); if (!it) continue; if (lockedNode(it.node) || (it.kind === "group" && anyLocked(it))) return true; }
      return false;
    };
    if (linked.some(anyLocked)) { infoWarning("Selection contains locked items. Enable 'Override locks' to operate on them."); return false; }
  }
  const st = new M.Stage(doc), mc = new M.Multichannel(doc);
  const failures: { group: KItem; reason: string }[] = [];
  let applied = 0, cancelled = false, netless = false;
  const progress = linked.length > 1 ? progressDialog("Applying Design Block Layouts", 1) : null;
  for (let i = 0; i < linked.length; i++) {
    const grp = linked[i];
    if (progress) {
      progress.phase(1, `Applying layout to group ${i + 1} of ${linked.length}...`); progress.advance(i, linked.length);
      await new Promise((r) => setTimeout(r, 0));
      if (progress.cancelled()) { cancelled = true; break; }
    }
    const blk = await designBlockBoard(kidStr(grp.node, "lib_id"));
    if ("error" in blk) { failures.push({ group: grp, reason: blk.error }); continue; }
    const r = mc.applyDesignBlockToGroup(st, grp, blk.text);
    if (r.ok) { applied++; if (r.netless) netless = true; } else failures.push({ group: grp, reason: r.error || "the layout could not be copied onto the group" });
  }
  if (progress) { progress.advance(1, 1); progress.close(); }
  if (cancelled) { infoMsg("Apply design block layout cancelled."); return false; }
  if (applied > 0) {
    ctx.commit(st.changes() as KChange[], "Apply Design Block Layout");
    if (netless) infoMsg("Copied copper has no net assigned. Assign nets to connect it.");
  }
  if (skippedNoLink > 0 || failures.length || linked.length > 1) {
    // HTML_MESSAGE_BOX "Apply Design Block Layout"
    openDialog({ title: "Apply Design Block Layout", width: 540, noOk: true, cancelLabel: "OK",
      build(body) {
        body.append(h("p", null, `Applied design block layout to ${applied} of ${linked.length} group(s).`));
        if (skippedNoLink > 0) body.append(h("p", null, `Skipped ${skippedNoLink} selected item(s) that are not groups linked to a design block.`));
        if (failures.length) {
          const ul = h("ul");
          for (const f of failures) {
            const name = typeof f.group.node[1] === "string" && KiCadCanvas.str(f.group.node[1]) ? KiCadCanvas.str(f.group.node[1]) : "(unnamed group)";
            const li = h("li", null, h("b", null, name), ": ");
            f.reason.split("\n").forEach((line, k) => { if (k) li.append(h("br")); li.append(line); });
            ul.append(li);
          }
          body.append(h("p", null, "The following groups could not be processed:"), ul);
        }
      } });
  }
  ctx.requestRender();
  return applied > 0;
}

/** DIALOG_UPDATE_PCB::PerformUpdate with "Apply design block layouts to new groups": each added linked group in turn. */
export async function applyDesignBlockLayoutsToGroups(ctx: ToolCtx, groupIds: string[]): Promise<void> {
  for (const id of groupIds) {
    const c = toolCtx(); const doc = board(c); const g = doc && doc.items.get(id);
    if (!g || g.kind !== "group" || !kidStr(g.node, "lib_id")) continue;
    select(c, []); select(c, [id]);
    await applyDesignBlockLayout(c);
  }
  select(ctx, []);
}

// ---------------------------------------------------------------- installation
/** EDIT_TOOL::Properties: a repeated channel's group is edited through the Repeat Layout dialog. */
function channelProperties(): boolean {
  const ctx = toolCtx(); const doc = board(ctx); if (!doc) return false;
  const sel = selected(ctx); if (sel.length !== 1 || sel[0].kind !== "group") return false;
  if (!new (MC().Multichannel)(doc).channelZone(sel[0])) return false;
  void repeatLayout(ctx); return true;
}
/** The preview's overlay and the Properties hook (run once the board tools are loaded, from installPcbDialogs). */
export function installMultichannel(): void {
  overlayHooks.push(drawHighlight);
  propertiesHooks.push(channelProperties);
}
