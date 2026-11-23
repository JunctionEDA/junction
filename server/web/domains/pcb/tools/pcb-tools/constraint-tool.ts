// pcb-tools/constraint-tool.ts — CONSTRAINT_EDIT_TOOL (pcbnew/tools/constraint_edit_tool.cpp): adding geometric
// constraints from the selection or by clicking the items (the picker paths), the constraint value dialog
// (DIALOG_CONSTRAINT_VALUE), the constraint list (DIALOG_CONSTRAINT_LIST), removing constraints, the automatic
// constraints the drawing tools stage (SelectShapeAutoConstraints, bindDimensionEndpoints), the driving dimension
// value mode (SetDimensionValueMode) and the re-solves after moves and edits (SolveAfterMove / SolveAfterEdit).
import type { BoardDoc, PcbCtx, Pt } from "./types";
import { addedChange, removedChange, replacedChange } from "./changes";
import { openForm } from "./dialogs";
import { dimRead, dimUnits, dimUpdate, dimWrite } from "./dimensions";
import { pickInteractively } from "./dom";
import { sizeUnits } from "./edit-commands";
import { applySelection, expandGroups } from "./groups";
import { appGlobal, editorState } from "./app-state";
import { itemDescription, msgValue } from "./msgpanel";
import { lsGet, lsSet } from "./router-settings";
import { K } from "./state";
import {
  CBoard, CONSTRAINT_LABELS, IU_PER_MM, anchorLabel, buildConstraintFromItems, constrainableItems, constraintIsDuplicateOnBoard, constraintItemIsLocked,
  constraintNode, constraintSelectionHint, constraintValueIsLength, constraintsAreDuplicate, dimensionCanDrive, dimensionHasValueMode, dimensionValueMode,
  findDimensionLengthConstraint, itemAnchors, member, nearestConstraintAnchor, nearestOutlineShape, newConstraint, remapPolygonVertexMembers, segDistance, selectEndpointBindings,
  selectRadialDimensionTarget,
} from "./pcb-constraint";
import type { CItem, CMember, ConstraintAnchor, ConstraintType, DimValueMode, PcbConstraint } from "./pcb-constraint";
import {
  BoardConstraintBlockSession, BoardConstraintDragSession, BoardConstraintMoveSession, applyConstraintImmediately, constraintReferenceShapes, diagnoseBoardConstraints, reSolveAfterShapeResize, reSolveShapeClusters, reSolveShapeClustersHoldingEdited, solveCluster,
} from "./constraint-adapter";
import type { BoardConstraintDiagnostics } from "./constraint-adapter";

const iuOf = (p: Pt): Pt => [Math.round(p[0] * IU_PER_MM), Math.round(p[1] * IU_PER_MM)];
const hyp = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** The board as the constraint code sees it (the footprint in the Footprint Editor). */
export const boardOf = (ctx: PcbCtx): CBoard => new CBoard(ctx.doc, !!ctx.fpEditor);
/** BoardHasConstraints. */
export const boardHasConstraints = (ctx: PcbCtx): boolean => { for (const it of ctx.doc.items.values()) if (it.kind === "constraint") return true; return false; };

/** BOARD_COMMIT::Push of what a CBoard staged (Modify / Add / Remove); the number of changes. */
export function commitBoard(ctx: PcbCtx, board: CBoard, label: string, amend = false): number {
  const changes: KChange[] = [];
  for (const [id, n] of board.edits) { if (board.removed.has(id)) continue; const it = ctx.doc.items.get(id); if (it && K.serialize(n) !== K.serialize(it.node)) changes.push(replacedChange(it, n)); }
  for (const id of board.removed) { const it = ctx.doc.items.get(id); if (it) changes.push(removedChange(it)); }
  for (const n of board.added) changes.push(addedChange(ctx.doc, n));
  if (changes.length) ctx.commit(changes, label, amend ? { amend: true } : undefined);
  return changes.length;
}
/** RemapPolygonVertexMembers as changes for an edit of a polygon's corners: each [changedIndex, delta] in order. */
export function constraintRemapChanges(doc: BoardDoc, poly: string, steps: [number, number][]): KChange[] {
  let has = false; for (const it of doc.items.values()) if (it.kind === "constraint") { has = true; break; }
  if (!has) return [];
  const board = new CBoard(doc); for (const [i, d] of steps) remapPolygonVertexMembers(board, poly, i, d);
  const out: KChange[] = [];
  for (const [id, n] of board.edits) { if (board.removed.has(id)) continue; const it = doc.items.get(id); if (it && K.serialize(n) !== K.serialize(it.node)) out.push(replacedChange(it, n)); }
  for (const id of board.removed) { const it = doc.items.get(id); if (it) out.push(removedChange(it)); }
  return out;
}
/** A new constraint's node with its uuid in the writer's place (K.createItem would append one). */
export function stageConstraint(c: PcbConstraint) { if (!c.id) c.id = K.newUuid(); return constraintNode(c); }

// ---------------------------------------------------------------- settings
/** PCBNEW_SETTINGS / FOOTPRINT_EDITOR_SETTINGS m_AutoConstraints ("editing.auto_constraints", default on). */
const autoKey = (ctx: PcbCtx | null) => (ctx && (ctx.fpEditor || (ctx.doc && ctx.doc.fpEditor)) ? "fpedit" : "pcbnew") + ".editing.auto_constraints";
const autoSetting: Record<string, boolean> = {};   // the session's value (storage may be unavailable)
export const getAutoConstraints = (ctx: PcbCtx | null): boolean => { const k = autoKey(ctx); return k in autoSetting ? autoSetting[k] : lsGet(k) !== "0"; };
/** CONSTRAINT_EDIT_TOOL::ToggleAutoConstraints. */
export function toggleAutoConstraints(ctx: PcbCtx) { const k = autoKey(ctx), on = !getAutoConstraints(ctx); autoSetting[k] = on; lsSet(k, on ? "1" : "0"); return true; }

// ---------------------------------------------------------------- the tool's session state
const lastValue = new Map<ConstraintType, number>(), lastDriving = new Map<ConstraintType, boolean>();
/** The infobar warning (ShowInfoBarWarning). */
const warn = (ctx: PcbCtx, msg: string) => ctx.toast(msg, 5000);

/** allMembersLocked. */
function allMembersLocked(board: CBoard, c: PcbConstraint) {
  return c.members.length > 0 && c.members.every((m) => { const it = board.resolve(m.item); return !!it && constraintItemIsLocked(it); });
}
/** solveAddedConstraint: snap the cluster to the new constraint, folded into the add's undo step. */
function solveAddedConstraint(ctx: PcbCtx, id: string) {
  const board = boardOf(ctx); const c = board.constraints().find((x) => x.id === id);
  if (!c || c.type === "fixed_position") return;
  applyConstraintImmediately(board, c, constraintReferenceShapes(board, c));
  commitBoard(ctx, board, "Apply Geometric Constraint", true);
}
/** finishConstraintCommit: push the add, solve it, and say when it cannot do anything or cannot be met. */
function finishConstraintCommit(ctx: PcbCtx, added: PcbConstraint[]) {
  if (!added.length) return;
  ctx.commit(added.map((c) => addedChange(ctx.doc, stageConstraint(c))), "Add Geometric Constraint");
  solveAddedConstraint(ctx, added[0].id);
  const board = boardOf(ctx);
  if (added[0].type !== "fixed_position" && allMembersLocked(board, added[0])) { warn(ctx, "All items referenced by this constraint are locked, so the constraint cannot move any geometry."); return; }
  const diag = diagnoseBoardConstraints(board);
  for (const c of added) {
    if (diag.conflicting.includes(c.id)) { warn(ctx, "The new geometric constraint conflicts with existing constraints and could not be satisfied."); return; }
    if (diag.errored.includes(c.id)) { warn(ctx, "The new geometric constraint could not be applied to the referenced items."); return; }
  }
}

/** UNIT_BINDER for a length: the user's units, the value in IU. */
const unitFactor = (u: string) => (u === "mil" ? 25400 : u === "in" ? 25.4e6 : 1e6);
const unitName = (u: string) => (u === "mil" ? "mils" : u === "in" ? "in" : "mm");
/** EDA_UNIT_UTILS::UI::DoubleValueFromString: a number with an optional unit suffix, in IU (NaN when no number). */
export function valueFromString(text: string, units: string): number {
  const t = String(text).trim().replace(",", "."); const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(mm|in|"|mils?|thou|th|um|µm|cm)?/i.exec(t);
  if (!m) return NaN;
  const v = parseFloat(m[1]); const u = (m[2] || "").toLowerCase();
  const f = u === "mm" ? 1e6 : u === "in" || u === '"' ? 25.4e6 : u === "mil" || u === "mils" || u === "thou" || u === "th" ? 25400 : u === "um" || u === "µm" ? 1e3 : u === "cm" ? 1e7 : unitFactor(units);
  return v * f;
}
/** EDA_UNIT_UTILS::UI::StringFromValue (no unit label). */
export const stringFromValue = (iu: number, units: string): string => String(+(iu / unitFactor(units)).toFixed(units === "mm" ? 6 : units === "in" ? 8 : 4));

/** DIALOG_CONSTRAINT_VALUE: the value (IU for lengths, degrees for angles) and the driving flag; done() on OK only. */
export function constraintValueDialog(ctx: PcbCtx, type: ConstraintType, value: number, driving: boolean, done: (value: number, driving: boolean) => void): boolean {
  const isAngle = !constraintValueIsLength(type); const units = sizeUnits();
  const shown = isAngle ? String(+value.toFixed(6)) : stringFromValue(value, units);
  return openForm<{ value: string; driving: boolean }>({
    title: "Constraint Value", width: 340,
    fields: [
      { k: "value", label: isAngle ? "Angle:" : "Value:", type: "text", value: shown, unit: isAngle ? "°" : unitName(units) },
      { k: "driving", label: "Driving (locks the geometry)", type: "check", value: driving },
    ],
    apply(v) {
      const drv = !!v.driving;
      // a reference value reports the measured geometry: its field is disabled and keeps what it showed
      const text = drv ? String(v.value) : shown;
      const num = isAngle ? parseFloat(text.replace(",", ".")) : valueFromString(text, units);
      if (isAngle && drv) {
        if (type === "arc_angle") { if (!(num > 0 && num < 360)) { warn(ctx, "Enter an arc angle between 0 and 360 degrees."); return false; } }
        else if (!(num >= 0)) { warn(ctx, "Value must be greater than or equal to 0 °."); return false; }
        else if (num > 180) { warn(ctx, "Value must be less than or equal to 180 °."); return false; }
      }
      if (!isAngle && drv && !(Math.round(num) > 0)) { warn(ctx, "Enter a value greater than zero."); return false; }
      done(isAngle ? num : Math.round(Number.isFinite(num) ? num : value), drv);
      return true;
    },
  });
}

/** commitConstraint: refuse a duplicate, ask a valued constraint's value, then add it. */
export function commitConstraint(ctx: PcbCtx, c: PcbConstraint | null): boolean {
  if (!c) return false;
  const board = boardOf(ctx);
  if (constraintIsDuplicateOnBoard(board, c)) { warn(ctx, "An identical geometric constraint already exists."); return false; }
  if (c.value !== null) {
    const type = c.type; const initial = lastValue.has(type) ? lastValue.get(type)! : c.value;   // InitialConstraintValue
    const driving = lastDriving.has(type) ? lastDriving.get(type)! : c.driving;
    return constraintValueDialog(ctx, type, initial, driving, (value, drv) => {
      c.value = value; c.driving = drv; lastValue.set(type, value); lastDriving.set(type, drv);
      finishConstraintCommit(ctx, [c]);
    });
  }
  finishConstraintCommit(ctx, [c]);
  return true;
}

// ---------------------------------------------------------------- AddConstraint and the pickers
const SNAP_TOL = 1.0 * IU_PER_MM;   // snapTol: 1 mm
/** The picker: one click at a time, staying active until Escape (PCB_PICKER_TOOL's click handler returning true). */
function pickLoop(ctx: PcbCtx, prompt: () => string, click: (pos: Pt) => boolean) {
  const step = () => pickInteractively(ctx, "point", prompt(), (res) => {
    if (!res || !Array.isArray(res)) return;   // Escape ends the picker (the finalize handler)
    if (click(iuOf(res as Pt))) step();
  });
  step();
}
/** pickShapeConstraint: click whole shapes until the type has its count, then build; stays for the next one. */
function pickShapeConstraint(ctx: PcbCtx, type: ConstraintType) {
  const count = type === "horizontal" || type === "vertical" || type === "fixed_length" || type === "fixed_radius" || type === "arc_angle" ? 1 : 2;
  const allowCircle = type === "fixed_radius" || type === "arc_angle" || type === "tangent" || type === "concentric" || type === "equal_radius";
  let picked: string[] = [];
  pickLoop(ctx, () => constraintSelectionHint(type) || CONSTRAINT_LABELS[type], (pos) => {
    const board = boardOf(ctx); const target = nearestOutlineShape(board, pos, SNAP_TOL, allowCircle);
    if (!target || picked.includes(target)) return true;   // nothing new snapped, keep picking
    picked.push(target); if (picked.length < count) return true;
    const items = picked.map((id) => board.resolve(id)).filter((x): x is CItem => !!x); picked = [];
    const c = buildConstraintFromItems(type, items);
    if (!c) warn(ctx, `Cannot form a ${CONSTRAINT_LABELS[type]} constraint from those items.`);
    commitConstraint(ctx, c);
    return true;   // stay active so more can be placed, like the draw tools
  });
}
/** pickLinearConstraint: horizontal / vertical over two point anchors, or over a whole segment. */
function pickLinearConstraint(ctx: PcbCtx, type: ConstraintType) {
  let members: CMember[] = [];
  pickLoop(ctx, () => constraintSelectionHint(type), (pos) => {
    const board = boardOf(ctx);
    // a point under the cursor wins over its segment, so clicking a corner starts the two point path
    const anchor = nearestConstraintAnchor(board, pos, SNAP_TOL, members);
    if (anchor) {
      members.push(anchor); if (members.length < 2) return true;
      const c = newConstraint(type, members.slice()); members = []; commitConstraint(ctx, c); return true;
    }
    // no anchor before the first point: a whole segment authors immediately
    if (!members.length) { const target = nearestOutlineShape(board, pos, SNAP_TOL, false); if (target) commitConstraint(ctx, newConstraint(type, [member(target, "whole")])); }
    return true;
  });
}
/** CONSTRAINT_EDIT_TOOL::AddConstraint: from the selection when it fits, else the click picker. */
export function addConstraint(ctx: PcbCtx, type: ConstraintType) {
  if (ctx.viewOnly) { ctx.toast("View-only access"); return true; }
  const board = boardOf(ctx); const ids = Array.from(ctx.selection || []);
  const items = ids.map((id) => board.resolve(id)).filter((x): x is CItem => !!x);
  const c = ids.length && items.length === ids.length ? buildConstraintFromItems(type, items) : null;
  if (!c) {
    if (ids.length) { const hint = constraintSelectionHint(type); if (hint) warn(ctx, hint); }
    applySelection(ctx, []);
    if (type === "horizontal" || type === "vertical") pickLinearConstraint(ctx, type); else pickShapeConstraint(ctx, type);
    return true;
  }
  commitConstraint(ctx, c);
  return true;
}
/** CONSTRAINT_EDIT_TOOL::AddPointConstraint: the pick plan (true a point anchor, false a whole segment), done after one. */
export function addPointConstraint(ctx: PcbCtx, type: ConstraintType) {
  if (ctx.viewOnly) { ctx.toast("View-only access"); return true; }
  const plan = type === "fixed_position" ? [true] : type === "coincident" ? [true, true] : type === "point_on_line" || type === "midpoint" ? [true, false] : type === "symmetric" ? [true, true, false] : null;
  if (!plan) return false;
  const members: CMember[] = [];
  // the actions' tooltips say what to click (pcb_actions.cpp)
  const PROMPTS: Partial<Record<ConstraintType, string>> = { fixed_position: "Click a point to pin it where it is, grounding the shapes constrained to it",
    coincident: "Click two shape endpoints to make them coincide", point_on_line: "Click an endpoint, then a segment or circle, to put the point on it",
    midpoint: "Click an endpoint, then a segment, to put the point at its midpoint", symmetric: "Click two endpoints, then a segment axis, to mirror them across it" };
  applySelection(ctx, []);
  pickLoop(ctx, () => PROMPTS[type]!, (pos) => {
    const board = boardOf(ctx);
    if (plan[members.length]) { const a = nearestConstraintAnchor(board, pos, SNAP_TOL, members); if (!a) return true; members.push(a); }
    else { const t = nearestOutlineShape(board, pos, SNAP_TOL, type === "point_on_line"); if (!t) return true; members.push(member(t, "whole")); }
    if (members.length < plan.length) return true;
    const c = newConstraint(type, members.slice());
    if (constraintIsDuplicateOnBoard(board, c)) { warn(ctx, "An identical geometric constraint already exists."); return false; }
    finishConstraintCommit(ctx, [c]);
    return false;   // done
  });
  return true;
}

// ---------------------------------------------------------------- removing, editing, the list
/** SolveAfterMove: settle the clusters of the moved shapes (folded into the last undo step), then the diagnosis. */
export function solveAfterMove(ctx: PcbCtx, ids: string[]) {
  if (!ids.length || !boardHasConstraints(ctx)) return;
  const board = boardOf(ctx); reSolveShapeClusters(board, ids.filter((id) => !!board.resolve(id)));
  commitBoard(ctx, board, "Apply Geometric Constraint", true);
  diagnoseAfterMove(ctx, ids);
}
/** EDIT_TOOL::collectConstraintShapes: the shapes of the items, recursing into groups and footprints. */
export function constraintShapeIds(ctx: PcbCtx, ids: Iterable<string>): string[] {
  const tops = new Set(expandGroups(ctx.doc, ids)); const out: string[] = [];
  for (const it of boardOf(ctx).items().values()) if (it.cls === "shape" && (tops.has(it.id) || tops.has(it.top))) out.push(it.id);
  return out;
}
/** EDIT_TOOL::reSolveConstraintsAfterEdit (Rotate, Mirror, Flip, Move Exactly) and the end of a move: SolveAfterMove over the shapes. */
export function solveAfterTransform(ctx: PcbCtx, ids: Iterable<string>) { if (boardHasConstraints(ctx)) solveAfterMove(ctx, constraintShapeIds(ctx, ids)); }
/** EDIT_TOOL::Properties after a dialog's commit and the Properties panel: SolveAfterEdit over the shapes. */
export function solveAfterDialogEdit(ctx: PcbCtx, ids: Iterable<string>) { if (boardHasConstraints(ctx)) solveAfterEdit(ctx, constraintShapeIds(ctx, ids)); }
/** SolveAfterEdit: the edited shapes hold, their neighbours follow. */
export function solveAfterEdit(ctx: PcbCtx, ids: string[]) {
  if (!ids.length || !boardHasConstraints(ctx)) return;
  const board = boardOf(ctx); reSolveShapeClustersHoldingEdited(board, ids.filter((id) => !!board.resolve(id)));
  commitBoard(ctx, board, "Apply Geometric Constraint", true);
  diagnoseAfterMove(ctx, ids);
}
/** DiagnoseAfterMove: say so when an edit left a moved shape's cluster over-constrained. */
export function diagnoseAfterMove(ctx: PcbCtx, ids: string[]): BoardConstraintDiagnostics | null {
  if (!ids.length || !boardHasConstraints(ctx)) return null;
  const diag = diagnoseBoardConstraints(boardOf(ctx));
  if (ids.some((id) => diag.shapeStates.get(id) === "over")) warn(ctx, "A geometric constraint could not be satisfied by this edit.");
  return diag;
}
// ---------------------------------------------------------------- live solving while a gesture runs
/**
 * The canvas side of a gesture's constraint solves (BOARD_COMMIT::Modify of the neighbours in the gesture's commit):
 * what a session's Apply staged on `board` is put on the canvas each frame, the nodes as they were before the gesture
 * are kept, and the gesture's end either commits the neighbours with its own step or puts them back.
 */
export class LiveConstraintEdit {
  ctx: PcbCtx; board: CBoard; origs = new Map<string, SNode>(); touched = new Set<string>();
  drag: BoardConstraintDragSession | null = null; move: BoardConstraintMoveSession | null = null; block: BoardConstraintBlockSession | null = null;
  constructor(ctx: PcbCtx) { this.ctx = ctx; this.board = boardOf(ctx); }
  /** Before a frame's solve: the board reads the canvas afresh, and nothing is staged yet. */
  begin(): CBoard { this.board.edits.clear(); this.board.invalidate(); return this.board; }
  /** The nodes the gesture writes itself, as they were before it began (so takeBack restores them too). */
  own(id: string, node: SNode) { if (!this.origs.has(id)) this.origs.set(id, K.cloneNode(node)); }
  /** Put the staged nodes on the canvas (all but `skip`, the items the gesture places itself); the ids written. */
  flush(skip?: Set<string>): string[] {
    const doc = this.ctx.doc, out: string[] = [];
    for (const [id, n] of this.board.edits) {
      if (skip && skip.has(id)) continue;
      const it = doc.items.get(id); if (!it) continue;
      if (!this.origs.has(id)) this.origs.set(id, K.cloneNode(it.node));
      it.node.length = 0; it.node.push(...K.cloneNode(n)); K.replaceChange(doc, it); this.touched.add(id); out.push(id);
    }
    this.board.edits.clear(); this.board.invalidate();
    return out;
  }
  /** The gesture ends: every node it changed back as it was; the nodes it had reached, by id. */
  takeBack(): Map<string, SNode> {
    const doc = this.ctx.doc, out = new Map<string, SNode>();
    for (const [id, n] of this.origs) {
      const it = doc.items.get(id); if (!it) continue;
      out.set(id, K.cloneNode(it.node)); it.node.length = 0; it.node.push(...K.cloneNode(n)); K.replaceChange(doc, it);
    }
    this.origs.clear(); this.touched.clear(); this.board.invalidate();
    return out;
  }
  /** The changes of a takeBack against the restored nodes (BOARD_COMMIT::Push of the gesture's Modify list). */
  changes(nodes: Map<string, SNode>, except?: Set<string>): KChange[] {
    const out: KChange[] = [];
    for (const [id, n] of nodes) { if (except && except.has(id)) continue; const it = this.ctx.doc.items.get(id); if (it && K.serialize(n) !== K.serialize(it.node)) out.push(replacedChange(it, n)); }
    return out;
  }
}
const IU_EQ = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1;
/**
 * constraintMemberForEditPoint / PCB_POINT_EDITOR::updateItem's match of the edited point to a constraint anchor:
 * a segment, arc or Bezier end (or an arc centre) by position, a circle's centre, a rectangle corner or side by its
 * ordinal (corners in min / max order), a modelable polygon's corner or edge by its ordinal (an edge brings its second
 * vertex as the co-dragged pin).  `pos` is the edited point (IU); null when the handle is no constraint anchor.
 */
export function memberForEditPoint(it: CItem, key: string, pos: Pt): { member: CMember; cursor: Pt; co: [CMember, Pt] | null } | null {
  if (it.cls !== "shape") return null;
  const one = (m: CMember, at: Pt) => ({ member: m, cursor: at, co: null });
  if (it.shape === "segment" || it.shape === "arc" || it.shape === "bezier") {
    if (IU_EQ(pos, it.start)) return one(member(it.id, "start"), pos);
    if (IU_EQ(pos, it.end)) return one(member(it.id, "end"), pos);
    if (it.shape === "arc" && IU_EQ(pos, it.center)) return one(member(it.id, "center"), pos);
    return null;
  }
  if (it.shape === "circle") return IU_EQ(pos, it.center) ? one(member(it.id, "center"), pos) : null;
  const anchors = itemAnchors(it);
  if (it.shape === "rect") {
    const m = /^[re]([0-3])$/.exec(key); if (!m) return null;
    const a = anchors[+m[1]]; return a ? one(member(it.id, "vertex", a.index), a.pos) : null;
  }
  if (it.shape === "poly" && anchors.length) {
    const c = /^c(\d+)$/.exec(key); if (c) { const a = anchors[+c[1]]; return a ? one(member(it.id, "vertex", a.index), a.pos) : null; }
    const e = /^m(\d+)$/.exec(key);
    if (e) { const i = +e[1], a = anchors[i], b = anchors[(i + 1) % anchors.length]; return a && b ? { member: member(it.id, "vertex", a.index), cursor: a.pos, co: [member(it.id, "vertex", b.index), b.pos] } : null; }
  }
  return null;
}
/** The drag starts (PCB_POINT_EDITOR's first IsDrag): the edited anchor's BOARD_CONSTRAINT_DRAG_SESSION, built on the item as it stands. */
export function beginPointEditConstraints(ctx: PcbCtx, id: string, key: string, posMm: Pt, orig: SNode): LiveConstraintEdit | null {
  if (!boardHasConstraints(ctx)) return null;
  const live = new LiveConstraintEdit(ctx); live.own(id, orig);
  const it = live.board.resolve(id); const m = it ? memberForEditPoint(it, key, iuOf(posMm)) : null;
  if (m) { const s = new BoardConstraintDragSession(); if (s.build(live.board, m.member)) live.drag = s; }
  return live;
}
/**
 * PCB_POINT_EDITOR::updateItem's re-solve, every frame of a handle drag (the item already shows the handle at the
 * cursor): a dragged constraint anchor pins there through the drag session (SolveCluster without one); a curve's
 * radius or axis handle keeps the new size (ReSolveAfterShapeResize); any other rectangle or modelable polygon handle
 * wins and its neighbours follow (ReSolveShapeClustersHoldingEdited).  `posMm` is the edited point.
 */
export function pointEditSolveFrame(live: LiveConstraintEdit, id: string, key: string, posMm: Pt) {
  const board = live.begin(); const it = board.resolve(id); if (!it || it.cls !== "shape") return;
  const m = memberForEditPoint(it, key, iuOf(posMm));
  const isCurve = it.shape === "circle" || it.shape === "arc" || it.shape === "ellipse" || it.shape === "ellipse_arc";
  if (m) {
    if (!live.drag || !live.drag.matches(m.member)) { const s = new BoardConstraintDragSession(); live.drag = s.build(board, m.member) ? s : null; }
    if (live.drag) live.drag.solve(m.cursor, false, new Set(), m.co);
    else solveCluster(board, m.member, m.cursor, false, new Set(), new Set(), false, m.co);
  } else if (isCurve) reSolveAfterShapeResize(board, id);
  else if (it.shape === "rect" || it.shape === "poly") reSolveShapeClustersHoldingEdited(board, [id]);
  live.flush();
}
/** SHAPE_GROUP_POINT_EDIT_BEHAVIOR's frame: the group writes its own shapes, their neighbours re-solve holding them. */
export function groupEditSolveFrame(live: LiveConstraintEdit, shapeIds: string[]) {
  const board = live.begin(); reSolveShapeClustersHoldingEdited(board, constraintShapeIds(live.ctx, shapeIds)); live.flush(new Set(shapeIds));
}
/** EDIT_TOOL::doMoveSelection's constraint session: the moved shapes' clusters (Move Individually re-solves each frame instead). */
export function beginMoveConstraints(ctx: PcbCtx, ids: string[], individually: boolean): { live: LiveConstraintEdit; shapes: string[] } | null {
  if (!boardHasConstraints(ctx)) return null;
  const shapes = constraintShapeIds(ctx, ids); if (!shapes.length) return null;
  const live = new LiveConstraintEdit(ctx);
  if (!individually) { const s = new BoardConstraintMoveSession(); if (s.build(live.board, shapes, [0, 0])) live.move = s; }
  return { live, shapes };
}
/** One frame of the move: the cluster follows the offset (mm); false when it cannot (the frame is then refused). */
export function moveSolveFrame(live: LiveConstraintEdit, shapes: string[], moved: Set<string>, offset: Pt): boolean {
  const board = live.begin();
  const ok = live.move ? live.move.solve(iuOf(offset)).ok : reSolveShapeClustersHoldingEdited(board, shapes);
  if (ok) live.flush(moved); else { board.edits.clear(); board.invalidate(); }
  return ok;
}

/** removeConstraint: "Remove Geometric Constraint", then the members' clusters re-settle. */
export function removeConstraint(ctx: PcbCtx, id: string) {
  const it = ctx.doc.items.get(id); if (!it) return;
  const board = boardOf(ctx); const c = board.constraints().find((x) => x.id === id);
  const members = c ? c.members.map((m) => m.item).filter((m) => { const r = board.resolve(m); return !!r && r.cls === "shape"; }) : [];
  ctx.commit([removedChange(it)], "Remove Geometric Constraint");
  solveAfterMove(ctx, members);
}
/** CONSTRAINT_EDIT_TOOL::RemoveConstraints: every constraint that references a selected item. */
export function removeConstraints(ctx: PcbCtx) {
  const sel = new Set(ctx.selection || []); if (!sel.size) return true;
  const gone = boardOf(ctx).constraints().filter((c) => c.members.some((m) => sel.has(m.item)));
  if (gone.length) ctx.commit(gone.map((c) => removedChange(ctx.doc.items.get(c.id)!)), "Remove Geometric Constraints");
  return true;
}
/** Does any constraint reference the selection (the context menu's removeConstraints condition)? */
export function selectionIsConstrained(ctx: PcbCtx): boolean {
  const sel = new Set(ctx.selection || []); if (!sel.size) return false;
  return boardOf(ctx).constraints().some((c) => c.members.some((m) => sel.has(m.item)));
}
/** EditConstraintValue: the value dialog over an existing constraint, then the snap, as "Edit Geometric Constraint". */
export function editConstraintValue(ctx: PcbCtx, id: string): boolean {
  const board0 = boardOf(ctx); const c0 = board0.constraints().find((x) => x.id === id); if (!c0 || c0.value === null) return false;
  return constraintValueDialog(ctx, c0.type, c0.value, c0.driving, (value, driving) => {
    const board = boardOf(ctx); const c = board.constraints().find((x) => x.id === id)!; c.value = value; c.driving = driving; board.writeConstraint(c);
    applyConstraintImmediately(board, board.constraints().find((x) => x.id === id)!);
    commitBoard(ctx, board, "Edit Geometric Constraint");
    lastValue.set(c.type, value); lastDriving.set(c.type, driving);
  });
}

/** ConstraintMemberLabel: the item's description and the anchor ("(missing)" for an item that is gone). */
function memberLabel(ctx: PcbCtx, board: CBoard, m: CMember, units: string): string {
  const it = board.resolve(m.item); if (!it) return "(missing)";
  let text = it.top === it.id ? String(itemDescription(ctx.doc, it.id, units) || "") : "";
  if (!text) {
    const ref = (() => { const fp = ctx.doc.items.get(it.top); const p = fp && K.kids(fp.node, "property").find((x) => K.str(x[1]) === "Reference"); return p ? K.str(p[2]) : ""; })();
    if (it.cls === "pad") text = `Pad ${K.str(it.node[1])} of ${ref}`;
    else text = `${({ segment: "Segment", rect: "Rectangle", poly: "Polygon", bezier: "Curve", circle: "Circle", arc: "Arc", ellipse: "Ellipse", ellipse_arc: "Elliptical Arc", other: "Graphic" } as Record<string, string>)[it.shape]} of ${ref}`;
  }
  const anchor = m.anchor === "vertex" && m.index >= 0 ? `${it.shape === "rect" ? "corner" : "vertex"} ${m.index + 1}` : anchorLabel(m.anchor as ConstraintAnchor);
  return anchor ? `${text} (${anchor})` : text;
}
/** ConstraintDisplayLabel: the type, and the value (a reference one parenthesised). */
export function constraintDisplayLabel(c: PcbConstraint, units: string): string {
  const label = CONSTRAINT_LABELS[c.type]; if (c.value === null) return label;
  const text = constraintValueIsLength(c.type) ? msgValue(c.value / IU_PER_MM, units) : `${(+c.value).toFixed(1)}°`;
  return c.driving ? `${label}: ${text}` : `${label}: (${text})`;
}
/** PopulateConstraintList's rows: the two item cells, the constraint and its state. */
export function constraintListRows(ctx: PcbCtx): { id: string; cells: string[] }[] {
  const board = boardOf(ctx); const diag = diagnoseBoardConstraints(board); const units = sizeUnits();
  return board.constraints().map((c) => {
    const item1 = c.members.length ? memberLabel(ctx, board, c.members[0], units) : "";
    let item2 = c.members.length > 1 ? memberLabel(ctx, board, c.members[1], units) : "";
    if (c.members.length > 2) item2 += ` (+${c.members.length - 2})`;
    const state = diag.errored.includes(c.id) ? "Error (missing item)" : diag.conflicting.includes(c.id) ? "Over-constrained" : diag.redundant.includes(c.id) ? "Redundant" : "OK";
    return { id: c.id, cells: [item1, item2, constraintDisplayLabel(c, units), state] };
  });
}
/** HighlightConstraintMembers: select the members (all of them, or the one of a member cell). */
export function highlightConstraintMembers(ctx: PcbCtx, id: string, index = -1) {
  const c = boardOf(ctx).constraints().find((x) => x.id === id); if (!c) return;
  const ms = index >= 0 && index < c.members.length ? [c.members[index]] : c.members;
  const board = boardOf(ctx); const ids = new Set<string>();
  for (const m of ms) { const it = board.resolve(m.item); if (it) ids.add(it.top === it.id || !ctx.doc.items.has(it.id) ? it.top : it.id); }
  // selecting the members is a board selection: the badge selection goes (Delete then targets the members)
  setSelectedConstraint(ctx, null);
  applySelection(ctx, [...ids]); overlayState.selSig = selSigOf(ids);
  if (ids.size) appGlobal(() => editorState()!.hotkeys!.runKicadAction!("zoomFitSelection"), false);   // ACTIONS::zoomFitSelection
  overlayState.isolated = id; overlayState.version++;   // after selecting, which clears the isolation
  ctx.requestRender();
}
/** CONSTRAINT_EDIT_TOOL::ManageConstraints: DIALOG_CONSTRAINT_LIST (activating a row selects its members and closes; Delete removes it). */
export function manageConstraints(ctx: PcbCtx): boolean {
  // the board editor docks PANEL_CONSTRAINTS (PCB_EDIT_FRAME::ToggleConstraintsPanel); the footprint editor has the dialog
  const showPane = appGlobal(() => editorState()!.DOC_TYPE === "kicad_pcb" ? editorState()!.hooks!.showPane || null : null, null);
  if (showPane) { showPane("constraints"); return true; }
  let chosen = -1;
  const rows = constraintListRows(ctx);
  return openForm<Record<string, unknown>>({
    title: "Geometric Constraints", width: 640,
    fields: [
      { k: "list", type: "table", columns: [{ label: "Item 1", width: "1.4fr" }, { label: "Item 2", width: "1.4fr" }, { label: "Constraint", width: "1.2fr" }, { label: "State", width: "1fr" }],
        rows: rows.map((r) => r.cells), empty: "No geometric constraints.",
        onRow(i, row) {
          if (chosen === i) { highlightConstraintMembers(ctx, rows[i].id); const dlg = row.closest(".kd-dialog, dialog, [role=dialog]") as HTMLElement | null; const close = dlg && dlg.querySelector("[data-act=cancel], .kd-close, button.cancel") as HTMLElement | null; if (close) close.click(); return; }
          chosen = i; const box = row.parentElement; if (box) for (const r of Array.from(box.children) as HTMLElement[]) r.style.background = r === row ? "var(--sel, rgba(80,140,255,.25))" : "";
        } },
      { k: "delete", label: "Delete", type: "button" },
    ],
    change(k) {
      if (k !== "delete" || chosen < 0 || !rows[chosen]) return;
      removeConstraint(ctx, rows[chosen].id);
      manageConstraints(ctx);   // Populate(): the constraint set changed
    },
    apply() { return true; },
  });
}

// ---------------------------------------------------------------- automatic constraints (drawing tools)
const AUTO_BIND_TOL = 0.01 * IU_PER_MM, AUTO_CORRIDOR = 0.25 * IU_PER_MM, AUTO_TANGENT_TOL = 10 * Math.PI / 180;
export interface AutoConstraint { constraint: PcbConstraint; needsSolve: boolean }
function tangentDirAt(it: CItem, pos: Pt): number | null {
  if (it.shape === "segment") { const dx = it.end[0] - it.start[0], dy = it.end[1] - it.start[1]; return dx || dy ? Math.atan2(dy, dx) : null; }
  if (it.shape === "arc" || it.shape === "circle") { const dx = pos[0] - it.center[0], dy = pos[1] - it.center[1]; return dx || dy ? Math.atan2(dy, dx) + Math.PI / 2 : null; }
  return null;
}
function makeTangent(shape: CItem, target: CItem, pos: Pt): PcbConstraint | null {
  if (!(shape.shape === "arc" || target.shape === "arc" || target.shape === "circle")) return null;
  const a = tangentDirAt(shape, pos), b = tangentDirAt(target, pos); if (a === null || b === null) return null;
  let diff = Math.abs((a - b) % Math.PI); diff = Math.min(diff, Math.PI - diff);
  return diff > AUTO_TANGENT_TOL ? null : newConstraint("tangent", [member(target.id, "whole"), member(shape.id, "whole")]);
}
function addUnlessDuplicate(board: CBoard, out: AutoConstraint[], c: PcbConstraint, needsSolve: boolean) {
  if (constraintIsDuplicateOnBoard(board, c) || out.some((e) => constraintsAreDuplicate(e.constraint, c))) return;
  out.push({ constraint: c, needsSolve });
}
/** SelectShapeAutoConstraints: the bindings a freshly drawn shape gets (its endpoints, centre, a corridor, tangency, its axis). */
export function selectShapeAutoConstraints(board: CBoard, id: string, axisConstraint: boolean): AutoConstraint[] {
  const sh = board.resolve(id); if (!sh || sh.cls !== "shape") return [];
  // the drawn shape is only staged on the commit, not on the board the candidates are collected from
  board.removed.add(id); board.invalidate();
  try { return shapeAutoConstraints(board, sh, axisConstraint); } finally { board.removed.delete(id); board.invalidate(); }
}
function shapeAutoConstraints(board: CBoard, sh: CItem, axisConstraint: boolean): AutoConstraint[] {
  const out: AutoConstraint[] = []; const id = sh.id;
  if (sh.shape === "circle" || sh.shape === "ellipse") {   // selectCenterBindings
    const target = nearestConstraintAnchor(board, sh.center, AUTO_BIND_TOL, [member(id, "center")], sh.layer);
    if (target) {
      const c = target.anchor === "center" ? newConstraint("concentric", [member(target.item, "whole"), member(id, "whole")])
        : newConstraint("coincident", [member(id, "center"), target]);
      addUnlessDuplicate(board, out, c, false);
    } else {
      const outline = nearestOutlineShape(board, sh.center, AUTO_BIND_TOL, true, sh.layer);
      if (outline && outline !== id) addUnlessDuplicate(board, out, newConstraint("point_on_line", [member(id, "center"), member(outline, "whole")]), false);
    }
    return out;
  }
  const bound = new Set<string>(); const touches: [Pt, string][] = [];
  // selectEndpointCoincidents
  for (const b of selectEndpointBindings(board, id, sh.start, sh.end, AUTO_BIND_TOL, sh.layer)) {
    bound.add(b.sourceAnchor); touches.push([b.sourceAnchor === "start" ? sh.start : sh.end, b.target.item]);
    addUnlessDuplicate(board, out, newConstraint("coincident", [member(id, b.sourceAnchor), b.target]), false);
  }
  // selectOutlineFallbacks
  for (const anchor of ["start", "end"] as const) {
    if (bound.has(anchor)) continue;
    const pos = anchor === "start" ? sh.start : sh.end; const target = nearestOutlineShape(board, pos, AUTO_BIND_TOL, true, sh.layer);
    if (!target || target === id) continue;
    let type: ConstraintType = "point_on_line"; const ts = board.resolve(target);
    if (ts && ts.shape === "segment") { const mid: Pt = [ts.start[0] + Math.trunc((ts.end[0] - ts.start[0]) / 2), ts.start[1] + Math.trunc((ts.end[1] - ts.start[1]) / 2)]; if (hyp(pos, mid) <= AUTO_BIND_TOL) type = "midpoint"; }
    touches.push([pos, target]);
    addUnlessDuplicate(board, out, newConstraint(type, [member(id, anchor), member(target, "whole")]), false);
  }
  // selectCorridorPins
  if (sh.shape === "segment" && !(sh.start[0] === sh.end[0] && sh.start[1] === sh.end[1])) {
    const boundPos: Pt[] = [];
    for (const it of constrainableItems(board, sh.layer)) {
      if (it.id === id || it.cls !== "shape") continue;
      for (const a of itemAnchors(it)) {
        if (segDistance(sh.start, sh.end, a.pos) > AUTO_CORRIDOR) continue;
        if (hyp(a.pos, sh.start) <= AUTO_CORRIDOR || hyp(a.pos, sh.end) <= AUTO_CORRIDOR) continue;
        if (boundPos.some((p) => hyp(a.pos, p) <= AUTO_BIND_TOL)) continue;
        boundPos.push(a.pos);
        addUnlessDuplicate(board, out, newConstraint("point_on_line", [member(it.id, a.anchor, a.index), member(id, "whole")]), true);
      }
    }
  }
  // selectTangents
  for (const [pos, tid] of touches) { const t = board.resolve(tid); if (t && t.id !== id && t.cls === "shape") { const c = makeTangent(sh, t, pos); if (c) addUnlessDuplicate(board, out, c, true); } }
  // selectAxisConstraint
  if (axisConstraint && sh.shape === "segment" && !(sh.start[0] === sh.end[0] && sh.start[1] === sh.end[1])) {
    const horizontal = sh.start[1] === sh.end[1], vertical = sh.start[0] === sh.end[0];
    if (horizontal || vertical) addUnlessDuplicate(board, out, newConstraint(horizontal ? "horizontal" : "vertical", [member(id, "whole")]), false);
  }
  return out;
}
/** bindDimensionEndpoints (drawing_tool.cpp): a new dimension's feature points bound to the geometry they measure. */
export function dimensionBindings(board: CBoard, dimId: string): PcbConstraint[] {
  const dim = board.resolve(dimId); if (!dim || dim.cls !== "dim") return [];
  board.removed.add(dimId); board.invalidate();   // staged on the commit, not yet on the board
  try { return bindDimension(board, dim); } finally { board.removed.delete(dimId); board.invalidate(); }
}
function bindDimension(board: CBoard, dim: CItem): PcbConstraint[] {
  const dimId = dim.id;
  const tol = 0.01 * IU_PER_MM; const out: PcbConstraint[] = [];
  const add = (c: PcbConstraint) => { if (!constraintIsDuplicateOnBoard(board, c)) out.push(c); };
  if (dim.dimType === "radial") {
    const arc = selectRadialDimensionTarget(board, dimId, dim.start, dim.end, tol); if (!arc) return out;
    add(newConstraint("coincident", [member(dimId, "start"), member(arc, "center")]));
    add(newConstraint("point_on_line", [member(dimId, "end"), member(arc, "whole")]));
    return out;
  }
  const end = dim.dimType === "aligned" || dim.dimType === "orthogonal" ? dim.end : null;
  for (const b of selectEndpointBindings(board, dimId, dim.start, end, tol)) add(newConstraint("coincident", [member(dimId, b.sourceAnchor), b.target]));
  return out;
}
/**
 * The drawing tools' commit with the automatic constraints (stageAutoConstraints / bindDimensionEndpoints on the same
 * commit, then snapAutoConstraints folded into it).  `add` is the drawn item's ADDED change.
 */
export function commitDrawn(ctx: PcbCtx, add: KChange, label: string, kind: "shape" | "dim" | null, axisConstraint = false) {
  const changes: KChange[] = [add]; const snaps: string[] = [];
  if (kind && add.id && getAutoConstraints(ctx)) {
    const board = boardOf(ctx);
    const staged: AutoConstraint[] = kind === "dim" ? dimensionBindings(board, add.id).map((c) => ({ constraint: c, needsSolve: false })) : selectShapeAutoConstraints(board, add.id, axisConstraint);
    for (const e of staged) { changes.push(addedChange(ctx.doc, stageConstraint(e.constraint))); if (e.needsSolve) snaps.push(e.constraint.id); }
  }
  ctx.commit(changes, label);
  if (snaps.length) {   // snapAutoConstraints
    const board = boardOf(ctx);
    for (const id of snaps) { const c = board.constraints().find((x) => x.id === id); if (c) applyConstraintImmediately(board, c); }
    commitBoard(ctx, board, "Apply Geometric Constraint", true);
  }
}

// ---------------------------------------------------------------- driving dimensions
/** The dimension's own units (PCB_DIMENSION_BASE::GetUnits). */
export function dimensionUnits(ctx: PcbCtx, dimId: string): string { const it = ctx.doc.items.get(dimId); return it ? dimUnits(dimRead(it.node) as never) : sizeUnits(); }
/** GetValueFieldText in Driving mode: the length constraint's value in the dimension's units. */
export function drivingValueText(ctx: PcbCtx, dimId: string): string | null {
  const c = findDimensionLengthConstraint(boardOf(ctx), dimId); return c && c.value !== null ? stringFromValue(c.value, dimensionUnits(ctx, dimId)) : null;
}
function setOverride(node: SNode, text: string | null) {
  const fmt = K.kid(node, "format"); if (!fmt) return;
  const i = fmt.findIndex((x) => Array.isArray(x) && x[0] === "override_value");
  if (text === null) { if (i >= 0) fmt.splice(i, 1); return; }
  if (i >= 0) (fmt[i] as SNode)[1] = text;
  else { const j = fmt.findIndex((x) => Array.isArray(x) && x[0] === "suppress_zeroes"); const n: SNode = ["override_value", text]; if (j >= 0) fmt.splice(j, 0, n); else fmt.push(n); }
}
/**
 * SetDimensionValueMode over a staged board: Driving clears the override and holds (or adds) the FIXED_LENGTH over the
 * dimension's ends; Driven / Arbitrary set the override state and drop the length.  The driving constraint, or null.
 */
export function setDimensionValueMode(board: CBoard, dimId: string, mode: DimValueMode, drivingLengthIU: number | null, overrideText: string | null): PcbConstraint | null {
  if (!dimensionHasValueMode(board.resolve(dimId))) return null;
  const existing = findDimensionLengthConstraint(board, dimId);
  const update = (override: string | null | undefined) => {
    const n = board.modify(dimId); if (override !== undefined) setOverride(n, override);
    const m = dimRead(n); dimUpdate(m); const fresh = dimWrite(n, m); n.length = 0; n.push(...fresh); board.invalidate();
  };
  if (mode === "driving") {
    if (!drivingLengthIU || drivingLengthIU <= 0 || !dimensionCanDrive(board, dimId)) return null;
    update(null);
    if (existing) { existing.value = drivingLengthIU; existing.driving = true; board.writeConstraint(existing); return existing; }
    const c = newConstraint("fixed_length", [member(dimId, "start"), member(dimId, "end")], drivingLengthIU, true);
    board.added.push(stageConstraint(c)); return c;
  }
  const cur = K.kid(K.kid(board.nodeOf(dimId)!, "format") || [], "override_value");
  update(mode === "arbitrary" ? (overrideText !== null ? overrideText : cur ? K.str(cur[1]) : "") : null);
  if (existing) { const i = board.added.findIndex((n) => K.uuidOf(n) === existing.id); if (i >= 0) board.added.splice(i, 1); else board.removed.add(existing.id); }
  return null;
}
/** resolveDrivingConstraint: the driving length moves the far end and what is bound to it, folded into the edit. */
function resolveDriving(ctx: PcbCtx, id: string, label: string) {
  const board = boardOf(ctx); const c = board.constraints().find((x) => x.id === id); if (!c) return;
  applyConstraintImmediately(board, c); commitBoard(ctx, board, label, true);
}
/**
 * DIALOG_DIMENSION_PROPERTIES::TransferDataFromWindow for a value dimension: the edited node and the value mode in one
 * "Edit Dimension Properties", then "Apply Dimension Length".  False when Driving has no positive length.
 */
export function commitDimensionEdit(ctx: PcbCtx, dimId: string, node: SNode, mode: DimValueMode, drivingText: string | null): boolean {
  let length: number | null = null;
  if (mode === "driving") { const iu = valueFromString(drivingText || "", dimensionUnits(ctx, dimId)); if (!(iu > 0)) return false; length = Math.round(iu); }
  const board = boardOf(ctx); const n = board.modify(dimId); n.length = 0; n.push(...K.cloneNode(node)); board.invalidate();
  const driving = setDimensionValueMode(board, dimId, mode, length, null);
  commitBoard(ctx, board, "Edit Dimension Properties");
  if (driving) resolveDriving(ctx, driving.id, "Apply Dimension Length");
  return true;
}
/** The Properties panel's Value Mode row (pcb_properties_panel.cpp): seeded from the length shown, so a switch alone does not move geometry. */
export function propSetValueMode(ctx: PcbCtx, dimIds: string[], mode: DimValueMode) {
  const board = boardOf(ctx); const drivers: string[] = [];
  for (const id of dimIds) {
    let length: number | null = null;
    if (mode === "driving") { const ex = findDimensionLengthConstraint(board, id); const it = ctx.doc.items.get(id); length = ex && ex.value !== null ? Math.round(ex.value) : it ? (dimUpdate(dimRead(it.node)).measured as number) || 0 : 0; }
    let override: string | null = null;
    if (mode === "arbitrary") { const n = board.nodeOf(id)!; if (!K.kid(K.kid(n, "format") || [], "override_value")) { const gt = K.kid(n, "gr_text"); const m = dimRead(n); override = gt ? String(m.text).slice(m.prefix.length, String(m.text).length - m.suffix.length || undefined) : ""; } }
    const d = setDimensionValueMode(board, id, mode, length, override); if (d) drivers.push(d.id);
  }
  commitBoard(ctx, board, "Edit Properties");
  for (const id of drivers) resolveDriving(ctx, id, "Apply Dimension Length");
}
/** The Properties panel's Value row in Driving mode: the length constraint's new value. */
export function propSetDrivingValue(ctx: PcbCtx, dimIds: string[], text: string) {
  const board = boardOf(ctx); const drivers: string[] = [];
  for (const id of dimIds) {
    if (dimensionValueMode(board, id) !== "driving") continue;
    const iu = valueFromString(text, dimensionUnits(ctx, id)); if (!(iu > 0)) continue;
    const c = findDimensionLengthConstraint(board, id); if (!c) continue;
    c.value = Math.round(iu); board.writeConstraint(c); drivers.push(c.id);
  }
  commitBoard(ctx, board, "Edit Properties");
  for (const id of drivers) resolveDriving(ctx, id, "Apply Dimension Length");
}
/** The dimension's value mode and whether Driving is offered (DimensionValueMode / DimensionCanDrive). */
export function dimensionModeInfo(ctx: PcbCtx, dimId: string): { mode: DimValueMode; canDrive: boolean; hasValueMode: boolean } {
  const board = boardOf(ctx);
  return { mode: dimensionValueMode(board, dimId), canDrive: dimensionCanDrive(board, dimId), hasValueMode: dimensionHasValueMode(board.resolve(dimId)) };
}

// ---------------------------------------------------------------- the context menu's view of the selection
/** CONSTRAINT_EDIT_TOOL::Init's conditions over the selection. */
export function constraintMenuState(ctx: PcbCtx) {
  const board = boardOf(ctx); const items = Array.from(ctx.selection || []).map((id) => board.resolve(id));
  const all = items.length > 0 && items.every((x) => !!x); const its = items as CItem[];
  const seg = (it: CItem) => it.cls === "shape" && it.shape === "segment";
  const radial = (it: CItem) => it.cls === "shape" && (it.shape === "circle" || it.shape === "arc");
  const centred = (it: CItem) => radial(it) || (it.cls === "shape" && (it.shape === "ellipse" || it.shape === "ellipse_arc"));
  const n = its.length;
  return {
    twoSegments: all && n === 2 && its.every(seg), oneSegment: all && n === 1 && seg(its[0]),
    tangentPair: all && n === 2 && ((seg(its[0]) && centred(its[1])) || (seg(its[1]) && centred(its[0])) || its.every(radial)),
    twoCentered: all && n === 2 && its.every(centred), twoRadial: all && n === 2 && its.every(radial), oneRadial: all && n === 1 && radial(its[0]),
    oneArc: all && n === 1 && its[0].cls === "shape" && its[0].shape === "arc", constrained: selectionIsConstrained(ctx),
  };
}

// ---------------------------------------------------------------- CONSTRAINT_OVERLAY (the badges)
/** PCBNEW_SETTINGS m_Display.m_ShowConstraints: true is OVERLAY_MODE::ALWAYS, false HOVER (the default). */
const SHOW_KEY = "pcbnew.display.show_constraints"; let showAlways: boolean | null = null;
export const constraintsAlwaysShown = (): boolean => (showAlways !== null ? showAlways : lsGet(SHOW_KEY) === "1");
/** CONSTRAINT_EDIT_TOOL::ShowConstraints: the action, not a toggle, picks the mode. */
export function showConstraints(ctx: PcbCtx, always: boolean) { showAlways = always; lsSet(SHOW_KEY, always ? "1" : "0"); ctx.requestRender(); return true; }
// the state tints (LAYER_CONSTRAINT_UNDER / WELL / OVER defaults)
const UNDER = "rgba(204, 107, 5, 0.9)", WELL = "rgba(46, 184, 77, 0.9)", OVER = "rgba(235, 46, 46, 0.9)";
const GLYPH: Record<string, string> = { coincident: "●", horizontal: "H", vertical: "V", parallel: "∥", perpendicular: "⊥", collinear: "⋯", symmetric: "⌯", equal_length: "=",
  equal_radius: "=", concentric: "◎", tangent: "⌒", midpoint: "M", point_on_line: "∘", fixed_length: "↔", fixed_radius: "R", angular_dimension: "∠", arc_angle: "∡", fixed_position: "⚓", undefined: "?" };
let diagCache: { sig: string; diag: BoardConstraintDiagnostics } | null = null;
/** The diagnosis behind the badges, kept while the constraints and their members are unchanged (m_cachedDiag). */
function overlayDiagnosis(ctx: PcbCtx, board: CBoard, cs: PcbConstraint[]): BoardConstraintDiagnostics {
  const tops = new Set<string>(); for (const c of cs) { tops.add(c.id); for (const m of c.members) { const it = board.resolve(m.item); if (it) tops.add(it.top); } }
  const sig = [...tops].map((t) => { const n = board.nodeOf(t); return n ? K.serialize(n) : t; }).join("\n");
  if (!diagCache || diagCache.sig !== sig) diagCache = { sig, diag: diagnoseBoardConstraints(board) };
  return diagCache.diag;
}
/** CONSTRAINT_OVERLAY::LayoutBadges: each badge at the preferred offset, else the first direction and distance clear of the shapes and the other badges. */
export function layoutBadges(badges: { pos: Pt; avoid: [Pt, Pt][] }[], wpp: number): Pt[] {
  const discPx = 11, marginPx = 3, pref: Pt = [16, -16], baseMag = Math.hypot(pref[0], pref[1]), baseAngle = Math.atan2(pref[1], pref[0]);
  const shapeClear = (discPx + marginPx) * wpp, badgeClear = (2 * discPx + marginPx) * wpp; const out: Pt[] = [];
  for (const b of badges) {
    const clearance = (p: Pt) => { let d = Number.MAX_VALUE; for (const [s, e] of b.avoid) d = Math.min(d, segDistance(s, e, p) - shapeClear); for (const q of out) d = Math.min(d, hyp(q, p) - badgeClear); return d; };
    let best: Pt = [b.pos[0] + pref[0] * wpp, b.pos[1] + pref[1] * wpp], bestScore = -Number.MAX_VALUE, placed = false;
    for (const mag of [1.0, 1.6, 2.3]) {
      for (const spread of [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
        const a = baseAngle + spread * Math.PI / 180; const cand: Pt = [b.pos[0] + Math.cos(a) * baseMag * mag * wpp, b.pos[1] + Math.sin(a) * baseMag * mag * wpp];
        const score = clearance(cand); if (score >= 0) { best = cand; placed = true; break; }
        if (score > bestScore) { bestScore = score; best = cand; }
      }
      if (placed) break;
    }
    out.push(best);
  }
  return out;
}
function shapeSegs(it: CItem, out: [Pt, Pt][]) {
  if (it.shape === "segment") out.push([it.start, it.end]);
  else if (it.shape === "circle" || it.shape === "arc") {
    const c = it.center, r = it.radius; let start = 0, sweep = 2 * Math.PI;
    if (it.shape === "arc") { start = Math.atan2(it.start[1] - c[1], it.start[0] - c[0]); const e = Math.atan2(it.end[1] - c[1], it.end[0] - c[0]), m = Math.atan2(it.mid[1] - c[1], it.mid[0] - c[0]);
      const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); sweep = norm(e - start); if (norm(m - start) > sweep) sweep -= 2 * Math.PI; }
    const steps = Math.max(2, Math.round(Math.abs(sweep * 180 / Math.PI) / 30)); let prev: Pt | null = null;
    for (let i = 0; i <= steps; i++) { const a = start + sweep * i / steps; const p: Pt = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]; if (prev) out.push([prev, p]); prev = p; }
  } else if (it.shape === "bezier") { const pts = [it.start, it.c1, it.c2, it.end]; for (let i = 1; i < pts.length; i++) out.push([pts[i - 1], pts[i]]); }
}
/** The constrained shape under the cursor (onHoverMotion / NearestConstrainedShape), or null. */
function hoverShape(board: CBoard, cs: PcbConstraint[], at: Pt, tol: number): string | null {
  const ids = new Set<string>(); for (const c of cs) for (const m of c.members) ids.add(m.item);
  let best = tol, out: string | null = null;
  for (const id of ids) { const it = board.resolve(id); if (!it || it.cls !== "shape") continue; const segs: [Pt, Pt][] = []; shapeSegs(it, segs); for (const [s, e] of segs) { const d = segDistance(s, e, at); if (d <= best) { best = d; out = id; } } }
  return out;
}
// ---------------------------------------------------------------- badges: render, hit-test, selection, isolation
/** CONSTRAINT_OVERLAY m_selected (the badge clicked), m_isolated (a panel row's constraint shown alone) and m_hoverShape. */
const overlayState = { selected: null as string | null, isolated: null as string | null, hover: null as string | null, version: 0, selSig: "" };
const selSigOf = (ids: Iterable<string>) => [...ids].map(String).sort().join(",");
/** EVENTS::SelectedEvent / UnselectedEvent / ClearedEvent reach onSelectionChanged: noticed as the board selection's signature changes. */
function watchSelection(ctx: PcbCtx) {
  const sig = selSigOf(ctx.selection || []); if (sig === overlayState.selSig) return;
  overlayState.selSig = sig; constraintSelectionChanged(ctx, !sig);
}
/** The badge selection and isolation as the panes read them (a version that moves whenever either changes). */
export const constraintSelection = () => ({ selected: overlayState.selected, isolated: overlayState.isolated, version: overlayState.version });
const BADGE_HIT_PX = 14;   // CONSTRAINT_OVERLAY::BadgeHitRadius
/** CONSTRAINT_OVERLAY::BadgeWorldPerPixel (IU per screen pixel, capped so a zoomed-out glyph shrinks). */
const badgeWpp = (iuPx: number) => Math.min(iuPx, 3 * IU_PER_MM / 16);
interface Badge { id: string; pos: Pt; avoid: [Pt, Pt][]; color: string; type: string }
/** The badges of the constraints `shown` admits (CONSTRAINT_OVERLAY::Update's walkConstraints). */
function overlayBadges(ctx: PcbCtx, board: CBoard, cs: PcbConstraint[], shown: (c: PcbConstraint) => boolean): Badge[] {
  const diag = overlayDiagnosis(ctx, board, cs); const out: Badge[] = [];
  for (const k of cs) {
    if (!k.members.length || !shown(k)) continue;
    const first = k.members[0]; const fit = board.resolve(first.item); if (!fit) continue;
    let pos = first.anchor === "whole" ? null : (itemAnchors(fit).find((a) => a.anchor === first.anchor && (a.anchor !== "vertex" || a.index === first.index)) || { pos: null }).pos;
    if (!pos) { const segs: [Pt, Pt][] = []; shapeSegs(fit, segs); const xs = segs.flat(), all = xs.length ? xs : [fit.start, fit.end]; const x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0])), y0 = Math.min(...all.map((p) => p[1])), y1 = Math.max(...all.map((p) => p[1])); pos = [(x0 + x1) / 2, (y0 + y1) / 2]; }
    const st = diag.shapeStates.get(first.item);
    const color = diag.errored.includes(k.id) || diag.conflicting.includes(k.id) ? OVER : st === "well" ? WELL : st === "over" ? OVER : UNDER;
    const avoid: [Pt, Pt][] = []; for (const m of k.members) { const it = board.resolve(m.item); if (it && it.cls === "shape") shapeSegs(it, avoid); }
    out.push({ id: k.id, pos, avoid, color, type: k.type });
  }
  return out;
}
/**
 * The badges on screen and where they sit, for the draw and the hit-test alike (so a click and a glyph cannot drift
 * apart): a panel row's isolation shows that constraint alone, else Always shows them all and Show on Hover Only the
 * constraints of the constrained shape under the cursor (kept while the cursor is on that shape or one of its badges).
 * `px` is mm per screen pixel, `cursor` in mm.
 */
export function constraintBadges(ctx: PcbCtx, px: number, cursor: Pt | null): { badges: Badge[]; at: Pt[]; wpp: number } {
  const none = { badges: [], at: [], wpp: 1 };
  if (!ctx.doc || !boardHasConstraints(ctx)) return none;
  const board = boardOf(ctx); const cs = board.constraints(); if (!cs.length) return none;
  watchSelection(ctx);
  const wpp = badgeWpp(px * IU_PER_MM);
  if (overlayState.isolated && !cs.some((c) => c.id === overlayState.isolated)) overlayState.isolated = null;   // the isolated constraint is gone
  let shown: (c: PcbConstraint) => boolean;
  if (overlayState.isolated) { const iso = overlayState.isolated; shown = (c) => c.id === iso; }
  else if (constraintsAlwaysShown()) shown = () => true;
  else {
    const cur = cursor ? iuOf(cursor) : null; const tol = BADGE_HIT_PX * px * IU_PER_MM;
    const refs = (id: string) => (c: PcbConstraint) => c.members.some((m) => m.item === id);
    let focus: string | null = null;
    if (overlayState.hover && cur && board.resolve(overlayState.hover)) {   // sticky while over the shape or one of its badges
      const hb = overlayBadges(ctx, board, cs, refs(overlayState.hover)); const lay = layoutBadges(hb, wpp);
      const segs: [Pt, Pt][] = []; shapeSegs(board.resolve(overlayState.hover)!, segs);
      if (lay.some((q) => hyp(q, cur) <= BADGE_HIT_PX * wpp) || segs.some(([a, b]) => segDistance(a, b, cur) <= tol)) focus = overlayState.hover;
    }
    if (!focus && cur) focus = hoverShape(board, cs, cur, tol);
    overlayState.hover = focus;
    if (!focus) return none;
    shown = refs(focus);
  }
  const badges = overlayBadges(ctx, board, cs, shown);
  // drop a selection whose constraint no longer has a badge (deleted, or its members vanished)
  if (overlayState.selected && !badges.some((b) => b.id === overlayState.selected) && !cs.some((c) => c.id === overlayState.selected)) setSelectedConstraint(ctx, null);
  return { badges, at: layoutBadges(badges, wpp), wpp };
}
/** CONSTRAINT_EDIT_TOOL::hitTestBadge: the constraint of the nearest badge within the hit radius of `mm`, or null. */
export function hitTestBadge(ctx: PcbCtx, mm: Pt, px: number): string | null {
  const { badges, at, wpp } = constraintBadges(ctx, px, mm); const p = iuOf(mm); let best = BADGE_HIT_PX * wpp, out: string | null = null;
  badges.forEach((b, i) => { const d = hyp(at[i], p); if (d <= best) { best = d; out = b.id; } });
  return out;
}
/** setSelectedConstraint: the badge drawn enlarged and ringed, its members' shadow brighter, its panel row selected and its message-panel rows shown. */
export function setSelectedConstraint(ctx: PcbCtx, id: string | null) {
  if (overlayState.selected === id) return;
  overlayState.selected = id; overlayState.version++;
  publishShadow(ctx); ctx.requestRender();
}
/** CONSTRAINT_EDIT_TOOL::SelectConstraintAt: a click on a badge selects that constraint, not a board item (the board selection is cleared). */
export function selectConstraintAt(ctx: PcbCtx, mm: Pt, px: number): boolean {
  const id = hitTestBadge(ctx, mm, px); if (!id) return false;
  applySelection(ctx, []); overlayState.selSig = ""; setSelectedConstraint(ctx, id); return true;
}
/** EditConstraintAt: a double click on a badge selects it and edits its value. */
export function editConstraintAt(ctx: PcbCtx, mm: Pt, px: number): boolean {
  const id = hitTestBadge(ctx, mm, px); if (!id) return false;
  setSelectedConstraint(ctx, id); editConstraintById(ctx, id); return true;
}
/** ClearConstraintSelection: true when a badge was selected. */
export function clearConstraintSelection(ctx: PcbCtx): boolean { const was = !!overlayState.selected; setSelectedConstraint(ctx, null); return was; }
/** onSelectionChanged: a board selection supersedes the badge selection, and a canvas selection shows every constraint again. */
export function constraintSelectionChanged(ctx: PcbCtx, selectionEmpty: boolean) {
  if (!selectionEmpty) setSelectedConstraint(ctx, null);
  if (overlayState.isolated) { overlayState.isolated = null; overlayState.version++; ctx.requestRender(); }
}
/** TryDeleteSelectedConstraint: Delete on a badge-selected constraint removes it (a vanished one still consumes the key). */
export function tryDeleteSelectedConstraint(ctx: PcbCtx): boolean {
  if (!overlayState.selected) return false;
  const id = overlayState.selected; setSelectedConstraint(ctx, null);
  if (boardOf(ctx).constraints().some((c) => c.id === id)) removeConstraint(ctx, id);
  return true;
}
/** TryEditSelectedConstraint: E (Properties) on a badge-selected constraint edits its value (a vanished one falls through). */
export function tryEditSelectedConstraint(ctx: PcbCtx): boolean {
  if (!overlayState.selected) return false;
  const id = overlayState.selected;
  if (!boardOf(ctx).constraints().some((c) => c.id === id)) { setSelectedConstraint(ctx, null); return false; }
  editConstraint(ctx, id); return true;
}
/** editConstraint: a valued constraint's value dialog (its value and driving flag become the next one's defaults); others just consume the gesture. */
function editConstraint(ctx: PcbCtx, id: string) {
  const c = boardOf(ctx).constraints().find((x) => x.id === id); if (!c || c.value === null) return;
  editConstraintValue(ctx, id);
}
/** EditConstraintById (a panel row's activation): a valueless relation locates its members instead. */
export function editConstraintById(ctx: PcbCtx, id: string) {
  const c = boardOf(ctx).constraints().find((x) => x.id === id); if (!c) return;
  if (c.value === null) { highlightConstraintMembers(ctx, id, -1); return; }
  editConstraint(ctx, id);
}
/** RemoveConstraintById. */
export function removeConstraintById(ctx: PcbCtx, id: string) { if (boardOf(ctx).constraints().some((c) => c.id === id)) removeConstraint(ctx, id); }
/** updateConstraintMsgPanel: Constraint, Items and State of the badge-selected constraint, or null (the board's own readout). */
export function constraintMsgPanel(ctx: PcbCtx, units: string): { title: string; value: string }[] | null {
  const id = overlayState.selected; if (!id || !ctx.doc) return null;
  const board = boardOf(ctx); const c = board.constraints().find((x) => x.id === id); if (!c) return null;
  const items = c.members.map((m) => memberLabel(ctx, board, m, units)).join(", ");
  const diag = overlayDiagnosis(ctx, board, board.constraints());
  const state = diag.errored.includes(c.id) ? "Error (missing item)" : diag.conflicting.includes(c.id) ? "Over-constrained" : diag.redundant.includes(c.id) ? "Redundant" : "OK";
  return [{ title: "Constraint", value: constraintDisplayLabel(c, units) }, { title: "Items", value: items }, { title: "State", value: state }];
}
// ---------------------------------------------------------------- LAYER_CONSTRAINT_SHADOW
/** updateConstrainedItems / updateHighlightedConstraintMembers: the items the shadow marks (every diagnosed one) and the selected constraint's members, drawn brighter. */
export function constraintShadowIds(ctx: PcbCtx): { constrained: Set<string>; highlighted: Set<string> } {
  const out = { constrained: new Set<string>(), highlighted: new Set<string>() };
  if (!ctx.doc || !boardHasConstraints(ctx)) return out;
  const board = boardOf(ctx); const cs = board.constraints(); if (!cs.length) return out;
  for (const id of overlayDiagnosis(ctx, board, cs).shapeStates.keys()) out.constrained.add(id);
  const sel = overlayState.selected ? cs.find((c) => c.id === overlayState.selected) : null;
  if (sel) for (const m of sel.members) out.highlighted.add(m.item);
  return out;
}
/** Hand the shadow sets to the renderer (PCB_RENDER_SETTINGS::SetConstrainedItems / SetHighlightedConstraintMembers). */
function publishShadow(ctx: PcbCtx) {
  const ro = appGlobal(() => editorState()!.renderOpts || null, null); if (!ro) return;
  const sh = constraintShadowIds(ctx); ro.constraintHighlightIds = sh.highlighted;
}
/** CONSTRAINT_OVERLAY::render + CONSTRAINT_BADGE_ITEM::ViewDraw: a state-tinted disc with the type's glyph per shown constraint, the selected one enlarged and ringed. `px` is mm per device pixel. */
export function drawConstraintOverlay(c: CanvasRenderingContext2D, ctx: PcbCtx, px: number, hover: Pt | null) {
  const { badges, at, wpp } = constraintBadges(ctx, px, hover); if (!badges.length) return;
  const s = wpp / IU_PER_MM, linePx = 1.5;
  c.save(); c.globalAlpha = 1;
  badges.forEach((b, i) => {
    const x = at[i][0] / IU_PER_MM, y = at[i][1] / IU_PER_MM, selected = b.id === overlayState.selected;
    const iconPx = selected ? 26 : 18, chipR = 0.62 * iconPx * s;   // iconPx / bigIconPx, chipR = 0.62 * iconSize
    c.beginPath(); c.arc(x, y, chipR, 0, Math.PI * 2); c.fillStyle = b.color; c.fill(); c.lineWidth = linePx * s; c.strokeStyle = "rgba(255, 255, 255, 0.9)"; c.stroke();
    if (selected) { c.beginPath(); c.arc(x, y, chipR + 2 * linePx * s, 0, Math.PI * 2); c.lineWidth = linePx * s; c.strokeStyle = "rgba(255, 255, 255, 0.9)"; c.stroke(); }
    c.fillStyle = "#fff"; c.font = `${13 * iconPx / 18 * s}px sans-serif`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(GLYPH[b.type] || "?", x, y + 0.5 * s);
  });
  c.restore();
}
