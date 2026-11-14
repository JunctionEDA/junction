// pcbdialogs/shape-modify — the Shape Modification sub-menu's actions (EDIT_TOOL::ModifyLines, SimplifyPolygons,
// BooleanPolygons): WX_UNIT_ENTRY_DIALOG for the fillet radius ("Fillet Lines", Radius:), the chamfer setback
// ("Chamfer Lines", Chamfer setback:) and the tolerance ("Simplify Shapes", Tolerance value:), each value remembered
// for the session as KiCad's statics are; the geometry is pcb-tools' (shape-modify.ts).
import { selectionIds } from "../gestures";
import { form, lenField, openDialog, unitLabel } from "./ui";

interface Result { changes: KChange[]; label: string; message: string | null; select: string[] }
interface ShapeApi {
  modifyLines(doc: KDoc, ids: string[], op: string, value: number): Result | { error: string };
  simplifyPolygons(doc: KDoc, ids: string[], tol: number): Result;
  booleanPolygons(doc: KDoc, ids: string[], op: string): Result;
}
const PT = (): { shapeModify: ShapeApi; applySelection?(ctx: ToolCtx, ids: string[]): void } => (window as unknown as { PcbTools: { shapeModify: ShapeApi } }).PcbTools;
// s_filletRadius (1 mm), the chamfer setback (1 mm) and s_toleranceValue (3 mm)
const remembered: Record<string, number> = { filletLines: 1, chamferLines: 1, simplifyPolygons: 3 };

/** WX_UNIT_ENTRY_DIALOG: one length; a value of zero or less does nothing. */
function unitEntry(title: string, caption: string, key: string, done: (v: number) => void): void {
  const f = lenField(remembered[key], { key: "unitEntry" });
  openDialog({ title, width: 360,
    build(body) { body.append(form([[caption, f.el, unitLabel()]])); setTimeout(() => { (f.input as HTMLInputElement).focus(); (f.input as HTMLInputElement).select(); }, 0); },
    ok() { const v = f.get(); if (!isFinite(v)) return false; remembered[key] = v; if (v > 0) done(v); return true; } });
}
function apply(ctx: ToolCtx, r: Result | { error: string }): void {
  if ("error" in r) { ctx.toast(r.error); return; }
  if (r.changes.length) ctx.commit(r.changes, r.label);
  const P = PT(); if (r.select.length && P.applySelection) P.applySelection(ctx, r.select);
  if (r.message) ctx.toast(r.message);
  ctx.requestRender();
}
const board = (ctx: ToolCtx): KDoc | null => (ctx.doc && ctx.doc.type === "pcb" && !ctx.viewOnly ? ctx.doc : null);

export function filletLines(ctx: ToolCtx): void {
  const doc = board(ctx); if (!doc) return; const ids = selectionIds();
  unitEntry("Fillet Lines", "Radius:", "filletLines", (v) => apply(ctx, PT().shapeModify.modifyLines(doc, ids, "filletLines", v)));
}
export function chamferLines(ctx: ToolCtx): void {
  const doc = board(ctx); if (!doc) return; const ids = selectionIds();
  unitEntry("Chamfer Lines", "Chamfer setback:", "chamferLines", (v) => apply(ctx, PT().shapeModify.modifyLines(doc, ids, "chamferLines", v)));
}
export function extendLines(ctx: ToolCtx): void {
  const doc = board(ctx); if (!doc) return;
  apply(ctx, PT().shapeModify.modifyLines(doc, selectionIds(), "extendLines", 0));
}
export function simplifyPolygons(ctx: ToolCtx): void {
  const doc = board(ctx); if (!doc) return; const ids = selectionIds();
  unitEntry("Simplify Shapes", "Tolerance value:", "simplifyPolygons", (v) => apply(ctx, PT().shapeModify.simplifyPolygons(doc, ids, v)));
}
export function booleanPolygons(op: "mergePolygons" | "subtractPolygons" | "intersectPolygons"): (ctx: ToolCtx) => void {
  return (ctx) => { const doc = board(ctx); if (!doc) return; apply(ctx, PT().shapeModify.booleanPolygons(doc, selectionIds(), op)); };
}
