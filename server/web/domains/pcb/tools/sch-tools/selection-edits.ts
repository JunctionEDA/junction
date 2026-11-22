import type { SchCtx, Pt } from "./types";
import { refreshCarry } from "./carry";
import { selectedItems } from "./commands";
import { junctionAt, needsJunction } from "./connect";
import { DRAG_KINDS, connPoints, junctionMerges } from "./drag";
import { pickAny } from "./hit";
import { switchTool } from "./junction";
import { anchorOf, cloneNode, mirrorNode, rotateNode, shiftNode } from "./orient";
import { LINE_KINDS, S, atOf, ptsOf, setPts } from "./state";
import { afterOrient, loneLinePivot, orientDrag, rotationCentre, transformNode, transformSelected } from "./transforms";
import { deep, ghost, modChange, r4, removeChange, same } from "./util";
import { isLockedItem, unlockedSelection } from "./lock";

// ---------------------------------------------------------------- edits on the current selection
export function selectedItem(ctx: SchCtx) { const id = ctx.selected ? ctx.selected.id : S.sel; return id ? ctx.doc.items.get(id) || null : null; }
// op: "ccw" | "cw" | "x" (KiCad's Mirror Vertically, (mirror x)) | "y" (Mirror Horizontally, (mirror y)).
// One item turns about its own anchor (or, for items without an orientation of their own, about
// its half-grid box centre); a multi-selection turns as a whole about the selection centre.
export function orientSelected(ctx: SchCtx, op: string) {
  if (S.drag) return orientDrag(ctx, op);                                        // handleMoveToolActions: the move goes on
  const c = S.carry;
  if (c) {
    const ok = op === "x" || op === "y" ? mirrorNode(c.kind, c.node, op) : rotateNode(c.kind, c.node, op === "cw"); if (ok === false) transformNode(c.kind, c.node, op, anchorOf(c.kind, c.node), true);
    // the item on the cursor is `moving` to SCH_EDIT_TOOL::Rotate / Mirror: its fields are autoplaced again or released
    const g = c.kind === "symbol" || c.kind === "sheet" ? ghost(ctx.doc, c.node) : null; if (g) afterOrient(ctx.doc, g, c.node, op, false);
    refreshCarry(ctx); return true;
  }
  const items = unlockedSelection(ctx);   // FilterSelectionForLockedItems
  if (items.length > 1) return transformSelected(ctx, op, items);
  const it = items[0]; if (!it) return false;
  if (ctx.viewOnly) return false;
  if (!DRAG_KINDS.has(it.kind)) return false;
  // SCH_EDIT_TOOL::Rotate's lone SCH_BITMAP_T case calls head->Rotate( rotPoint, clockwise ), not !clockwise as
  // every other item does: a lone reference image turns the other way
  const lop = it.kind === "image" && (op === "ccw" || op === "cw") ? (op === "ccw" ? "cw" : "ccw") : op;
  // one item goes the way a multi-selection does: the fields are autoplaced again (or released by a mirror), then
  // TrimOverLappingWires, AddJunctionsIfNeeded and SCHEMATIC::CleanUp run in the same commit
  return transformSelected(ctx, lop, [it], loneLinePivot(it, op) || rotationCentre([it], op));
}
// Removal of one item (or a list — a multi-selection) plus the junctions that only existed for them:
// a line's own points, or the connection points (pins, ends, anchors) of anything else —
// SCH_EDIT_TOOL::DoDelete's junction pass, evaluated with every listed item out of the document.
export function deleteChanges(doc: KDoc, items: KItem | KItem[]) {
  const list: KItem[] = [], ids = new Set<string>();
  for (const it of Array.isArray(items) ? items : [items]) if (it && !ids.has(it.id)) { ids.add(it.id); list.push(it); }
  const changes = list.map(removeChange), pts: { p: Pt; kind: string | null }[] = [];
  for (const it of list) { const line = LINE_KINDS.has(it.kind); for (const p of line ? ptsOf(it.node) : connPoints(doc, it)) pts.push({ p, kind: line ? it.kind : null }); }
  if (!pts.length) return changes;
  const saved = list.map((it) => [it.id, doc.items.get(it.id)] as const);
  for (const it of list) doc.items.delete(it.id);
  // SCH_EDIT_FRAME::DeleteJunction on a dry run: the junctions dropped and the lines merged are taken out of (or
  // edited in) the document while the other points are looked at, and put back at the end
  const dropped: KItem[] = [], edited = new Map<string, Pt[]>(), merged = new Map<string, KChange>(), seen = new Set<string>();
  try {
    for (const { p, kind } of pts) {
      const key = r4(p[0]) + "," + r4(p[1]);
      const j = junctionAt(doc, p[0], p[1]), own = list.some((it) => it.kind === "junction" && same(atOf(it.node), p));
      if (!j && !own) continue;
      if (j) {
        const needed = kind ? needsJunction(doc, p[0], p[1], kind) : needsJunction(doc, p[0], p[1], "wire") || needsJunction(doc, p[0], p[1], "bus");
        if (needed) continue;
        changes.push(removeChange(j)); doc.items.delete(j.id); dropped.push(j);
      }
      if (seen.has(key)) continue; seen.add(key);
      // the wires and buses that ended on the junction: identical ones go, parallel ones merge (MergeOverlap), so
      // deleting the leg of a T leaves one through-wire
      for (const m of junctionMerges(doc, p)) {
        const it = doc.items.get(m.id); if (!it) continue;
        if (!edited.has(m.id)) edited.set(m.id, ptsOf(it.node).map((q) => q.slice()));
        if (m.seg) { const n = deep(it.node); setPts(n, m.seg); merged.set(m.id, modChange(doc, it, n)); setPts(it.node, m.seg); }
        else { merged.set(m.id, removeChange(it)); doc.items.delete(m.id); dropped.push(it); }
      }
    }
  } finally {
    for (const it of dropped) doc.items.set(it.id, it);
    for (const [id, q] of edited) { const it = doc.items.get(id); if (it) setPts(it.node, q); }
    for (const [id, obj] of saved) if (obj) doc.items.set(id, obj);
  }
  return changes.concat(Array.from(merged.values()));
}
export function deleteSelected(ctx: SchCtx) {
  const it = S.sel ? ctx.doc.items.get(S.sel) : null; if (!it) return false;
  if (isLockedItem(ctx.doc, it)) return true;   // DoDelete: FilterSelectionForLockedItems
  const changes = deleteChanges(ctx.doc, it);
  S.sel = null; S.hover = null;
  ctx.commit(changes, "Delete");
  ctx.requestRender();
  return true;
}
// The delete tool's click: whatever is under the cursor goes (symbols and sheets included).
export function deleteAt(ctx: SchCtx, mm: Pt) {
  const it = pickAny(ctx, mm); if (!it || isLockedItem(ctx.doc, it)) return null;
  const changes = deleteChanges(ctx.doc, it);
  S.sel = null; S.hover = null;
  if (ctx.selected && ctx.selected.id === it.id) ctx.setSelected(null);
  ctx.commit(changes, "Delete");
  ctx.requestRender();
  return it;
}
export function duplicateSelected(ctx: SchCtx) {
  const it = selectedItem(ctx); if (!it || it.kind === "sheet") return false;
  const node = cloneNode(it); shiftNode(it.kind, node, 2.54, 2.54);
  S.carry = { kind: it.kind, node, item: ghost(ctx.doc, node), pos: anchorOf(it.kind, node) };
  S.sel = null; ctx.setSelected(null);
  switchTool(ctx, "place");                         // onActivate sees the carry and skips the picker
  ctx.requestRender();
  return true;
}
