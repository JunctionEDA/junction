// panels/constraints.ts — the board's Geometric Constraints pane (pcbnew/widgets/panel_constraints.cpp) and the
// constraint badges' editor hooks (CONSTRAINT_EDIT_TOOL as PCB_SELECTION_TOOL, EDIT_TOOL and the message panel call it).
// The constraint model lives in the board tools (PcbTools.constraints); this file only reaches it.
import type { ConstraintsCmd, ConstraintsModel } from "../../panels-api";
import { addMsgHook } from "../msgpanel";
import { showPane } from "../panes";
import { E } from "../state";
import { isSch } from "../view";
import { panelStore, tctx } from "./core";

type Ctx = ReturnType<typeof tctx>;
type Pt = [number, number];
/** The constraint editing calls the editor makes (pcb-tools/constraint-tool.ts). */
export interface ConstraintTools {
  constraintListRows(ctx: Ctx): { id: string; cells: string[] }[];
  constraintSelection(): { selected: string | null; isolated: string | null; version: number };
  selectConstraintAt(ctx: Ctx, mm: Pt, px: number): boolean;
  editConstraintAt(ctx: Ctx, mm: Pt, px: number): boolean;
  clearConstraintSelection(ctx: Ctx): boolean;
  tryDeleteSelectedConstraint(ctx: Ctx): boolean;
  tryEditSelectedConstraint(ctx: Ctx): boolean;
  setSelectedConstraint(ctx: Ctx, id: string | null): void;
  highlightConstraintMembers(ctx: Ctx, id: string, index?: number): void;
  editConstraintById(ctx: Ctx, id: string): void;
  removeConstraintById(ctx: Ctx, id: string): void;
  constraintMsgPanel(ctx: Ctx, units: string): { title: string; value: string }[] | null;
  constraintShadowIds(ctx: Ctx): { constrained: Set<string>; highlighted: Set<string> };
}
/** PcbTools.constraints on a board (null on a schematic or before the board tools load). */
export const constraintTools = (): ConstraintTools | null => {
  if (isSch()) return null;
  const P = (window as unknown as { PcbTools?: { constraints?: ConstraintTools } }).PcbTools;
  return (P && P.constraints) || null;
};

const EMPTY: ConstraintsModel = { rows: [], selected: null };
/** PANEL_CONSTRAINTS::Populate: one row per constraint (Item 1, Item 2, Constraint, State); the badge selection marks its row. */
export function constraintsModel(): ConstraintsModel {
  const C = constraintTools(); if (!C || !E.kdoc) return EMPTY;
  try { return { rows: C.constraintListRows(tctx()), selected: C.constraintSelection().selected }; } catch (e) { console.warn(e); return EMPTY; }
}
/**
 * PANEL_CONSTRAINTS::OnSelectionChanged: a row selects (and zooms to) the constraint's members, one member alone when
 * the click was on its item cell; OnItemActivated: EditConstraintById; OnDelete: RemoveConstraintById.
 */
export function constraintsCmd(c: ConstraintsCmd): void {
  const C = constraintTools(); if (!C || !E.kdoc) return;
  const ctx = tctx();
  try {
    if (c.t === "select") C.highlightConstraintMembers(ctx, c.id, c.col === 0 || c.col === 1 ? c.col : -1);
    else if (c.t === "activate") C.editConstraintById(ctx, c.id);
    else if (c.t === "delete" && !E.viewOnly) C.removeConstraintById(ctx, c.id);
  } catch (e) { console.warn(e); }
  bumpConstraints();
}
let conSig = "";
/** The badge selection or isolation moved: the pane re-reads (PANEL_CONSTRAINTS::SelectConstraint). */
export function bumpConstraints(): void { panelStore.set({ conVersion: (panelStore.get().conVersion || 0) + 1 }); }
/** Polled with the selection: a change of the badge selection reaches the pane. */
export function watchConstraints(): void {
  const C = constraintTools(); const s = C ? C.constraintSelection() : null;
  const sig = s ? `${s.selected || ""}:${s.isolated || ""}:${s.version}` : "";
  if (sig !== conSig) { conSig = sig; bumpConstraints(); }
}

// updateConstraintMsgPanel: a badge-selected constraint's rows replace the board's own readout
addMsgHook((units: string) => { const C = constraintTools(); return C && E.kdoc ? C.constraintMsgPanel(tctx(), units) : null; });
// CONSTRAINT_EDIT_TOOL::ManageConstraints reaches the docked pane through the editor
(E.hooks as { showPane?: (name: string, show?: boolean) => void }).showPane = (name: string, show?: boolean) => showPane(name, show);
