// pcbdialogs/cleanup-graphics — Tools > Cleanup Graphics... (DIALOG_CLEANUP_GRAPHICS, dialog_cleanup_graphics_base.fbp):
// Merge lines into rectangles, Delete redundant graphics, Fix discontinuities in board outlines with its Tolerance.
// Every checkbox reruns the dry run into "Changes to be applied:"; OK ("Update PCB") applies them as one
// "Cleanup Graphics" commit.  Selecting a change highlights its items on the board.  In the footprint editor the
// outline fix is not offered and "Merge overlapping graphics into pads" is (GRAPHICS_CLEANER::mergePads: PAD::Recombine
// on every pad outside a net-tie pad group); OK is "Update Footprint" there.
import { E } from "../state";
import { setActiveLayer } from "../doc";
import { visibleRectNm } from "../view";
import { focusOnLocation } from "./find";
import { checkField, form, h, lenField, openDialog, unitLabel } from "./ui";

/** The layers a board item is on (its (layer …), else its (layers …)), in the order the file lists them. */
function itemLayers(it: KItem): string[] {
  if (it.layer) return [it.layer];
  const l = KiCadCanvas.kid(it.node, "layer") as SNode | null; if (l) return [String(l[1])];
  const ls = KiCadCanvas.kid(it.node, "layers") as SNode | null; return ls ? ls.slice(1).map(String) : [];
}
/**
 * PCB_BASE_FRAME::FocusOnItem( item ): a pad, a via or a marker by its position; any other item by the centre of
 * the part of its outline that lies in the viewport; then EDA_DRAW_FRAME::FocusOnLocation (the view moves only when
 * the point is near the edge of the canvas, off it, or under a dialog).
 */
export function focusOnBoardItem(id: string): void {
  const doc = E.kdoc as KDoc | null; const it = doc && doc.items.get(id); if (!it) return;
  if (it.kind === "via" || it.kind === "pad" || !it.bbox) { const at = KiCadCanvas.atOf(it.node) as number[]; focusOnLocation(at[0], at[1]); return; }
  let [x0, y0, x1, y1] = it.bbox;
  const v = visibleRectNm();
  if (v) {
    const vx0 = v[0] / E.IU, vy0 = v[1] / E.IU, vx1 = vx0 + v[2] / E.IU, vy1 = vy0 + v[3] / E.IU;
    const cx0 = Math.max(x0, vx0), cy0 = Math.max(y0, vy0), cx1 = Math.min(x1, vx1), cy1 = Math.min(y1, vy1);
    if (cx0 <= cx1 && cy0 <= cy1) { x0 = cx0; y0 = cy0; x1 = cx1; y1 = cy1; }   // the clipped outline, when any of it shows
  }
  focusOnLocation((x0 + x1) / 2, (y0 + y1) / 2);
}
/** DIALOG_CLEANUP_GRAPHICS::OnSelectItem: the item's first layer becomes active unless the active one is among its layers, then FocusOnItem. */
export function selectCleanupItem(id: string, switchLayer: boolean): void {
  const doc = E.kdoc as KDoc | null; const it = doc && doc.items.get(id); if (!it) return;
  if (switchLayer) { const ls = itemLayers(it); if (ls.length && !ls.includes(E.activeLayer)) setActiveLayer(ls[0]); }
  focusOnBoardItem(id);
}

interface Opts { mergeRects: boolean; deleteRedundant: boolean; fixBoardOutlines: boolean; tolerance: number }
interface Plan { items: { text: string; ids: string[] }[]; changes: KChange[] }
interface PcbToolsApi { graphicsCleanup(doc: KDoc, o: Opts, dryRun: boolean): Plan; applySelection?(ctx: ToolCtx, ids: string[]): void; fpPads: { recombinePadChanges(doc: KDoc, padId: string, dryRun?: boolean): { changes: KChange[]; merged: string[] } } }
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;

/** s_defaultTolerance: 2 mm, then whatever the last OK used, for the session. */
let lastTolerance = 2;

export function openCleanupGraphics(ctx: ToolCtx): void {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") { ctx.toast("Cleanup Graphics needs a board"); return; }
  if (E.viewOnly) { ctx.toast("This board is read-only"); return; }
  const setHl = (ids: string[] | null): void => { const c = ctx as ToolCtx & { setHighlight?(s: Set<string> | null): void }; if (c.setHighlight) c.setHighlight(ids && ids.length ? new Set(ids) : null); ctx.requestRender(); };
  const rects = checkField(false, "Merge lines into rectangles", { key: "createRectangles" });
  const redundant = checkField(false, "Delete redundant graphics", { key: "deleteRedundant" });
  const outlines = checkField(false, "Fix discontinuities in board outlines", { key: "fixBoardOutlines" });
  const fpEd = !!doc.fpEditor;
  const mergePads = checkField(false, "Merge overlapping graphics into pads", { key: "mergePads" });
  /** FOOTPRINT::MapPadNumbersToNetTieGroups: the pad numbers that sit in a net-tie group */
  const netTiePads = (): Set<string> => {
    const hdr = (doc as KDoc & { fp?: SNode }).fp; const g = hdr ? (hdr.find((c) => Array.isArray(c) && c[0] === "net_tie_pad_groups") as SNode | undefined) : undefined;
    return new Set(g ? g.slice(1).flatMap((x) => String(x).split(/[,\s]+/).filter(Boolean)) : []);
  };
  /** mergePads over the pads: each pad with the shapes PAD::Recombine would take in */
  const padMerges = (dry: boolean): { ids: string[]; changes: KChange[] }[] => {
    if (!fpEd || !mergePads.get()) return [];
    const tie = netTiePads(), out: { ids: string[]; changes: KChange[] }[] = [];
    for (const it of doc.items.values()) {
      if (it.kind !== "pad" || tie.has(String(it.node[1]))) continue;
      const r = PT().fpPads.recombinePadChanges(doc, it.id, dry);
      if (r.merged.length) out.push({ ids: [...r.merged, it.id], changes: r.changes });
    }
    return out;
  };
  const tol = lenField(lastTolerance, { key: "tolerance", min: 0 });
  tol.input.setAttribute("data-nopersist", "");   // TransferDataToWindow sets it from s_defaultTolerance
  const list = h("div", { class: "pd-report", style: "height:250px;min-height:0", "data-k": "changes" });
  const opts = (): Opts => ({ mergeRects: rects.get(), deleteRedundant: redundant.get(), fixBoardOutlines: !fpEd && outlines.get(), tolerance: tol.get() });
  const dryRun = (): void => {
    setHl(null);
    const items = PT().graphicsCleanup(doc, opts(), true).items.concat(padMerges(true).map((m) => ({ text: "Merge overlapping shapes into pad", ids: m.ids })));
    list.replaceChildren(...items.map((it) => {
      const row = h("div", { class: "ln action", tabindex: "0" }, it.text);
      row.addEventListener("click", () => { for (const r of Array.from(list.children)) r.classList.toggle("sel", r === row); setHl(it.ids); if (it.ids[0]) selectCleanupItem(it.ids[0], true); });
      return row;
    }));
  };
  openDialog({ title: "Cleanup Graphics", width: 680, okLabel: fpEd ? "Update Footprint" : "Update PCB", persist: true,
    build(body) {
      body.append(fpEd
        ? h("div", { style: "display:flex;flex-direction:column;gap:2px" }, rects.el, redundant.el, mergePads.el,
          h("div", { class: "pd-lbl", style: "margin-left:22px;font-style:italic;font-size:11px" }, "(Pads which appear in a Net Tie pad group will not be considered for merging.)"))
        : h("div", { style: "display:flex;flex-direction:column;gap:2px" }, rects.el, redundant.el, outlines.el,
          h("div", { style: "margin-left:22px" }, form([["Tolerance:", tol.el, unitLabel()]]))),
        h("div", { class: "pd-lbl", style: "margin:10px 0 4px" }, "Changes to be applied:"), list);
      // OnCheckBox: only the check boxes rerun the dry run (the tolerance is read when they do)
      body.addEventListener("change", (ev) => { const t = ev.target as HTMLInputElement; if (!list.contains(t) && t.type === "checkbox") dryRun(); });
      dryRun();
    },
    restored() { dryRun(); },
    cancel() { setHl(null); return true; },
    ok() {
      lastTolerance = tol.get();
      setHl(null);
      const sel = PT().applySelection; if (sel) sel(ctx, []);   // ACTIONS::selectionClear
      const plan = PT().graphicsCleanup(doc, opts(), false);
      // the pad merges after the shape cleanup, leaving out a pad whose shapes the cleanup already changes
      const touched = new Set(plan.changes.map((c) => (c as { id?: string }).id));
      const merges = padMerges(false).filter((m) => !m.ids.some((id) => touched.has(id)));
      const changes = plan.changes.concat(...merges.map((m) => m.changes));
      if (changes.length) ctx.commit(changes, "Cleanup Graphics");
      ctx.requestRender();
      return true;
    } });
}
