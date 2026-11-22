import type { SchCtx, Pt } from "./types";
import { assignPastedRef, canFollow, refField, setReference, unannotated, usedReferences, annotatePastedUnique, annotationSettings, followPaste } from "./clipboard";
import { carried, cursorOf, editable, selectedItems, setSelectionIds, snapCursor } from "./commands";
import { LABEL_KINDS, beginDrag, connPoints, isNetLine } from "./drag";
import { type EditTxn, editTxn, explicitJunctionNeeded, screenConnections, segOf, txnAddJunction, txnCleanUp, txnTrimWire } from "./junction";
import { anchorOf, cloneNode, shiftNode } from "./orient";
import { LINE_KINDS, S, TEXT_KINDS, kids, str, uuidOf } from "./state";
import { autoRotateOf, setAutoRotate, supportsAutoRotate } from "./autorotate";
import { addNode, deep, modChange, r4, segDist, segs } from "./util";

// ---------------------------------------------------------------- repeat last item (Insert)
// SaveCopyForRepeatItem: what Insert repeats is a list (a whole wire, an unfold's entry, label and wire);
// junctions are never repeated.
export function rememberPlaced(kind: string, node: SNode) { if (kind === "junction") return; S.lastPlaced = [{ kind, node: deep(node) }]; }
// common/increment.cpp IncrementString: the last run of digits steps, leading zeros kept; null below zero.
export function incrementText(text: unknown, delta: number) {
  const m = str(text).match(/^([\s\S]*?)(\d+)(\D*)$/); if (!m) return str(text);
  const n = parseInt(m[2], 10) + (delta === undefined ? 1 : delta); if (n < 0) return null;
  return m[1] + String(n).padStart(m[2].length, "0") + m[3];
}
/**
 * SCH_LABEL_BASE::IncrementLabel on a label node: its text steps; SCH_DIRECTIVE_LABEL::IncrementLabel steps its
 * Netclass and Component Class fields instead.  False (and that text unchanged) when a value would go below zero.
 */
export function incrementLabelNode(kind: string, node: SNode, delta: number): boolean {
  if (kind === "netclass_flag" || kind === "directive_label") {
    let ok = true;
    for (const f of kids(node, "property")) {
      const name = str(f[1]); if (name !== "Netclass" && name !== "Component Class") continue;
      const tx = incrementText(f[2], delta); if (tx === null) ok = false; else f[2] = tx;
    }
    return ok;
  }
  const tx = incrementText(node[1], delta); if (tx === null) return false;
  node[1] = tx; return true;
}
// Junctions the new items need (SCH_SCREEN::GetNeededJunctions + AddJunction), inside a dry-run edit.
export function txnNeededJunctions(t: EditTxn, doc: KDoc, items: KItem[]) {
  const conns = screenConnections(doc), pts: Pt[] = [], seen = new Set<string>();
  const push = (p: Pt) => { const k = r4(p[0]) + "," + r4(p[1]); if (!seen.has(k)) { seen.add(k); pts.push(p); } };
  for (const it of items) {
    for (const p of connPoints(doc, it)) push(p);
    if (isNetLine(it.kind)) for (const [a, b] of segs(it)) for (const c of conns) if (segDist(c, a, b) <= 1e-3) push(c);
  }
  for (const p of pts) if (explicitJunctionNeeded(doc, p)) txnAddJunction(t, doc, p);
}
// TrimOverLappingWires: a line running through exactly two connection points of a new (non-line) item is
// cut between them (a symbol repeated onto a wire takes its place in it).
export function txnTrimOverlapping(t: EditTxn, doc: KDoc, items: KItem[]) {
  for (const it of items) {
    if (isNetLine(it.kind) || LINE_KINDS.has(it.kind)) continue;
    const pts = connPoints(doc, it); if (pts.length < 2) continue;
    for (const line of Array.from(doc.items.values())) {
      if (line.kind !== "wire") continue; const s = segOf(line); if (!s) continue;
      const on = pts.filter((p) => segDist(p, s[0], s[1]) <= 1e-3);
      if (on.length === 2) txnTrimWire(t, doc, on[0], on[1], new Set([line.id]));
    }
  }
}
/**
 * SCH_EDIT_TOOL::RepeatDrawItem (Insert): every remembered item is duplicated; a label's number steps by
 * repeat_label_increment (warning when it would go below zero), a symbol goes to the cursor, is re-annotated
 * when annotation is automatic and then follows the cursor (SCH_ACTIONS::move), anything else is offset by
 * default_repeat_offset.  Overlapped wires are trimmed, junctions added and the lines cleaned up in one
 * "Repeat Item" commit; the new items become what the next Insert repeats.
 */
export function repeatLast(ctx: SchCtx) {
  if (!editable(ctx)) return false;
  const src = S.lastPlaced; if (!src || !src.length) return false;
  const doc = ctx.doc;
  // AnnotateSymbols( ANNOTATE_SELECTION, order, algo, recursive, annotateStartNum ): the cleared copy takes the first
  // free number of the project's annotation settings
  const annotate = (node: SNode) => { if (!S.annotateAuto) return; const rf = refField(node); if (!rf) return; setReference(node, unannotated(str(rf[2]))); annotatePastedUnique(doc, [node], Object.assign(annotationSettings(ctx, doc), { reannotate: true })); };
  if (canFollow(ctx) && src.some((lp) => lp.kind === "symbol")) {
    // a symbol goes into SCH_ACTIONS::move inside the same commit: it is only on this client until the click, which
    // pushes the one "Repeat Item" step; Esc rolls it back (commit.RevertToCheckpoint) and nothing is left behind
    const ids: string[] = []; let warn = false;
    for (const lp of src) {
      const node = cloneNode({ kind: lp.kind, node: deep(lp.node) });
      if (LABEL_KINDS.has(lp.kind) && !incrementLabelNode(lp.kind, node, S.repeatIncrement)) warn = true;
      if (lp.kind === "symbol") { const p = snapCursor(ctx), a = anchorOf("symbol", node); shiftNode("symbol", node, r4(p[0] - a[0]), r4(p[1] - a[1])); annotate(node); }
      else shiftNode(lp.kind, node, S.repeatOffset[0], S.repeatOffset[1]);
      const it = addNode(doc, node).item; ids.push(it.id);
      if (supportsAutoRotate(lp.kind) && autoRotateOf(uuidOf(lp.node) || "")) setAutoRotate(it.id, true);
    }
    if (warn) ctx.toast("Label value cannot go below zero", 4000);
    if (followPaste(ctx, ids, [], cursorOf(ctx), "Repeat Item")) return true;
    for (const id of ids) doc.items.delete(id);
  }
  const t = editTxn(doc, ctx.IU), added: string[] = [];
  let warned = false;
  try {
    for (const lp of src) {
      const node = cloneNode({ kind: lp.kind, node: deep(lp.node) });
      if (LABEL_KINDS.has(lp.kind) && !incrementLabelNode(lp.kind, node, S.repeatIncrement)) { if (!warned) ctx.toast("Label value cannot go below zero", 4000); warned = true; }
      if (lp.kind === "symbol") {
        const p = snapCursor(ctx), a = anchorOf("symbol", node); shiftNode("symbol", node, r4(p[0] - a[0]), r4(p[1] - a[1]));
        annotate(node);
      } else shiftNode(lp.kind, node, S.repeatOffset[0], S.repeatOffset[1]);
      const it = t.add(node); added.push(it.id);
      // SCH_ITEM::Duplicate copies SCH_LABEL_BASE::m_autoRotateOnPlacement: the repeated label keeps its Auto flag
      if (supportsAutoRotate(lp.kind) && autoRotateOf(uuidOf(lp.node) || "")) setAutoRotate(it.id, true);
    }
    const items = added.map((id) => doc.items.get(id)).filter(Boolean) as KItem[];
    txnTrimOverlapping(t, doc, items);
    txnNeededJunctions(t, doc, items);
    txnCleanUp(t, doc, added.filter((id) => { const it = doc.items.get(id); return it && isNetLine(it.kind); }), []);
  } finally { t.restore(); }
  const changes = t.changes(); if (!changes.length) return false;
  ctx.commit(changes, "Repeat Item");
  const now = added.map((id) => doc.items.get(id)).filter(Boolean) as KItem[];
  S.lastPlaced = now.map((it) => ({ kind: it.kind, node: deep(it.node) }));
  setSelectionIds(ctx, now.map((it) => it.id));
  return true;
}
/**
 * STRING_INCREMENTER::Increment (common/increment.cpp) as the schematic uses it (no IOSQXZ skipping): the string is
 * cut from the right into integer runs, same-case letter runs and skipped separators; the part `rightIndex` counts
 * (0 the rightmost, 1 the one before it) steps by delta.  An integer keeps its zero padding and does not go below
 * zero; a letter run steps as a spreadsheet column (Z -> AA) while its index is at most 50.  null when there is no
 * such part or it cannot step.
 */
export function incrementStringPart(text: string, delta: number, rightIndex: number): string | null {
  if (!text) return null;
  let rest = text; const parts: { s: string; t: "int" | "alpha" | "skip" }[] = []; let good = 0;
  while (good <= rightIndex && rest.length) {
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/\d+$/))) { parts.push({ s: m[0], t: "int" }); good++; }
    else if ((m = rest.match(/([a-z]+|[A-Z]+)$/))) { parts.push({ s: m[0], t: "alpha" }); good++; }
    else if ((m = rest.match(/[^a-zA-Z0-9]+$/))) parts.push({ s: m[0], t: "skip" });
    else break;
    rest = rest.slice(0, rest.length - m[0].length);
  }
  if (good <= rightIndex) return null;
  const part = parts[parts.length - 1];
  if (part.t === "int") {
    const n = parseInt(part.s, 10) + delta; if (!isFinite(n) || n < 0) return null;
    let out = String(n); if (part.s.startsWith("0") && out.length < part.s.length) out = "0".repeat(part.s.length - out.length) + out;
    part.s = out;
  } else if (part.t === "alpha") {
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", up = part.s.toUpperCase(), wasUpper = part.s === up;
    let index = 0; for (let i = 0; i < up.length; i++) { let ai = A.indexOf(up[i]); if (ai < 0) return null; if (i !== up.length - 1) ai++; index += ai * Math.pow(26, up.length - 1 - i); }
    if (index > 50) return null;                       // m_AlphabeticMaxIndex
    let next = index + delta; if (next < 0) return null;
    let out = "", first = true; do { let mod = next % 26; if (!first) mod--; out = A[mod] + out; next = Math.floor(next / 26); first = false; } while (next);
    part.s = wasUpper ? out : out.toLowerCase();
  } else return null;
  return rest + parts.slice().reverse().map((q) => q.s).join("");
}
/**
 * ACTIONS::increment (SCH_TOOL_BASE::Increment).  With `field` given (the selection tool's Shift+Alt+wheel: 0, the
 * primary part; Ctrl+Alt+wheel: 1, the secondary) the selected labels and texts, which must all be of one type, step
 * that part of their text; without it the last number steps (Repeat's increment).
 */
export function incrementSelection(ctx: SchCtx, delta: number, field?: number) {
  if (!editable(ctx)) return false;
  // TwoClickPlace: ACTIONS::increment acts on the label or text on the cursor
  const cr = carried(ctx);
  if (cr) {
    if (!TEXT_KINDS.has(cr.item.kind) && cr.item.kind !== "text_box") return false;
    const t = incrementText(cr.item.node[1], delta); if (t === null || t === str(cr.item.node[1])) return false;
    const n = deep(cr.item.node); n[1] = t; cr.write(n); return true;
  }
  const changes: KChange[] = [];
  if (field !== undefined) {
    const INC = new Set(["label", "global_label", "hierarchical_label", "text"]);
    const items = selectedItems(ctx).filter((it) => INC.has(it.kind)); if (!items.length) return false;
    if (items.some((it) => it.kind !== items[0].kind)) return false;   // "Incrementing multiple types at once seems confusing"
    for (const it of items) {
      const t = incrementStringPart(str(it.node[1]), delta, field); if (t === null || t === str(it.node[1])) continue;
      const n = deep(it.node); n[1] = t; changes.push(modChange(ctx.doc, it, n));
    }
    if (!changes.length) return false;
    ctx.commit(changes, "Increment"); return true;
  }
  for (const it of selectedItems(ctx)) {
    if (!TEXT_KINDS.has(it.kind) && it.kind !== "text_box") continue;
    const t = incrementText(it.node[1], delta); if (t === null || t === str(it.node[1])) continue;
    const n = deep(it.node); n[1] = t; changes.push(modChange(ctx.doc, it, n));
  }
  if (!changes.length) return false;
  ctx.commit(changes, delta < 0 ? "decrement" : "increment"); return true;
}
