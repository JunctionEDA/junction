// fieldops.ts — what Delete does to a schematic field selected on its own (E.selField): SCH_EDIT_TOOL::DoDelete on a
// SCH_FIELD hides it (SetVisible( false )), one "Delete" step.  A board footprint field's Delete is the board module's
// (EDIT_TOOL::DeleteItems, pcb-tools/field-edit.ts); Move / Drag of a field is gestures.ts startFieldMove.
import { E } from "./state";
import { fieldOf, drawSelection, renderProps, selectedFields } from "./selection";
import { commitChanges } from "./tools";
import { isSch, requestRender } from "./view";
import { toast } from "./util";

type FieldKit = { fieldHidden(p: SNode): boolean; setFieldHidden(node: SNode, p: SNode, hidden: boolean): void };
const kit = (): FieldKit | null => { const K = window.KDialogs as unknown as { _?: Partial<FieldKit> } | undefined; return K && K._ && K._.fieldHidden && K._.setFieldHidden ? K._ as FieldKit : null; };

/** The node a field hide leaves (null: nothing to change) and whether the field was visible. */
export function hiddenFieldNode(node: SNode, name: string, k: FieldKit, find: (node: SNode, name: string) => SNode | null): SNode | null {
  const copy = JSON.parse(JSON.stringify(node)) as SNode; const p = find(copy, name); if (!p) return null;
  if (k.fieldHidden(p)) return null;
  k.setFieldHidden(copy, p, true); return copy;
}

/** Delete with a field selected: hide it.  True when the key was ours. */
export function deleteSelectedField(): boolean {
  const all = selectedFields(); if (!all.length || !E.kdoc || !isSch()) return false;
  if (E.viewOnly) { toast("View-only access"); return true; }
  const k = kit(); if (!k) return true;
  // one change per symbol, every selected field of it hidden
  const nodes = new Map<string, SNode>();
  for (const f of all) {
    const it = E.kdoc.items.get(f.id); if (!it) continue;
    const node = hiddenFieldNode(nodes.get(f.id) || it.node, f.name, k, (n, nm) => fieldOf({ node: n }, nm));
    if (node) nodes.set(f.id, node);
  }
  const changes = [];
  for (const [id, node] of nodes) { const it = E.kdoc.items.get(id); if (it) changes.push(KiCadCanvas.replaceChange(E.kdoc, Object.assign({}, it, { node, geom: [], bbox: null }))); }
  if (changes.length) commitChanges(changes, "Delete");
  E.selField = null; E.selFields = []; drawSelection(); renderProps(); requestRender();
  return true;
}
