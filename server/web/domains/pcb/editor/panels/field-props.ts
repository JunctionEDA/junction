// panels/field-props.ts — the Properties panel of a schematic field selected on its own (SCH_FIELD_T in the
// selection): SCH_FIELD_DESC's properties over the field's (property …) node (eeschema/sch_field.cpp, with
// EDA_TEXT_DESC's of common/eda_text.cpp it keeps: Position, Orientation, Hyperlink, Thickness, Mirrored, Width,
// Height, Locked, Unit and Body Style are masked).  Pure: each property reads the node and returns an edited copy
// of it, through the same row model the Field Properties dialog writes.
import * as L from "../../dialogs/sch-items-logic";

export type FieldRaw = string | number | boolean | null;
export type FieldPropType = "text" | "bool" | "enum" | "length" | "color";
export interface FieldProp {
  group: string; name: string; type: FieldPropType; choices?: [string, string][];
  get(p: SNode): FieldRaw;
  /** the edited copy of the field's node; null = the value is refused */
  set(p: SNode, v: FieldRaw): SNode | null;
}
export const FIELD_TEXT_GROUP = "Text Properties";
export const FIELD_BASIC_GROUP = "Basic Properties";
const H_JUST: [string, string][] = [["left", "Left"], ["center", "Center"], ["right", "Right"]];
const V_JUST: [string, string][] = [["top", "Top"], ["center", "Center"], ["bottom", "Bottom"]];

/** GetPenSizeForNormal / GetPenSizeForBold (gr_text.cpp): the pen an automatic thickness draws with. */
export function effectivePenWidth(size: number, bold: boolean): number { return +(bold ? size / 5 : size / 8).toFixed(4); }

function viaRow(p: SNode, edit: (r: L.FieldRow) => void): SNode { const r = L.rowFromField(p, [0, 0], false); edit(r); return L.fieldFromRow(r, [0, 0]); }
function colorRaw(c: L.Color): string { if (!c) return ""; const [r, g, b, a] = c; return a >= 1 ? "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") : `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(3)})`; }

/**
 * The properties of a field, in the order the panel lists them.  `fonts` are the faces the Font row offers besides
 * the stroke font; `rgba` parses the colour row's text ("" is COLOR4D::UNSPECIFIED).
 */
export function fieldProps(fonts: string[], rgba: (text: string) => number[] | null): FieldProp[] {
  const T = FIELD_TEXT_GROUP, B = FIELD_BASIC_GROUP;
  const faces: [string, string][] = [L.KICAD_FONT, ...fonts.filter((f) => f && f !== L.KICAD_FONT)].map((f): [string, string] => [f, f]);
  return [
    { group: T, name: "Text", type: "text", get: (p) => L.fieldValue(p), set: (p, v) => viaRow(p, (r) => { r.value = String(v === null ? "" : v); }) },
    { group: T, name: "Font", type: "enum", choices: faces, get: (p) => L.readFx(p).font, set: (p, v) => viaRow(p, (r) => { r.font = String(v); }) },
    // EDA_TEXT::SetAutoThickness: off keeps the pen the text draws with now, on drops the stored thickness
    { group: T, name: "Auto Thickness", type: "bool", get: (p) => !L.readFx(p).thickness,
      set: (p, v) => { const fx = L.readFx(p); if (!fx.thickness === !!v) return null; const n = L.clone(p); L.writeFx(n, { thickness: v ? 0 : effectivePenWidth(fx.size, fx.bold) }); return n; } },
    { group: T, name: "Italic", type: "bool", get: (p) => L.readFx(p).italic, set: (p, v) => viaRow(p, (r) => { r.italic = !!v; }) },
    { group: T, name: "Bold", type: "bool", get: (p) => L.readFx(p).bold, set: (p, v) => viaRow(p, (r) => { r.bold = !!v; }) },
    { group: T, name: "Visible", type: "bool", get: (p) => !L.isHidden(p), set: (p, v) => viaRow(p, (r) => { r.show = !!v; }) },
    { group: T, name: "Horizontal Justification", type: "enum", choices: H_JUST, get: (p) => L.readFx(p).h, set: (p, v) => viaRow(p, (r) => { r.h = String(v) as L.FieldRow["h"]; }) },
    { group: T, name: "Vertical Justification", type: "enum", choices: V_JUST, get: (p) => L.readFx(p).v, set: (p, v) => viaRow(p, (r) => { r.v = String(v) as L.FieldRow["v"]; }) },
    { group: T, name: "Color", type: "color", get: (p) => colorRaw(L.readFx(p).color),
      set: (p, v) => { const c = v ? rgba(String(v)) : null; if (v && !c) return null; return viaRow(p, (r) => { r.color = c ? [c[0], c[1], c[2], c.length > 3 ? c[3] : 1] : null; }); } },
    { group: T, name: "Text Size", type: "length", get: (p) => L.readFx(p).size, set: (p, v) => ((v as number) > 0 ? viaRow(p, (r) => { r.size = v as number; }) : null) },
    { group: B, name: "Show Field Name", type: "bool", get: (p) => L.yes(p, "show_name"), set: (p, v) => viaRow(p, (r) => { r.showName = !!v; }) },
    { group: B, name: "Allow Autoplacement", type: "bool", get: (p) => !L.yes(p, "do_not_autoplace"), set: (p, v) => viaRow(p, (r) => { r.autoplace = !!v; }) },
  ];
}
/** The field's node inside its parent's. */
export function fieldNodeOf(parent: SNode, name: string): SNode | null { return L.kids(parent, "property").find((q) => L.fieldName(q) === name) || null; }
/** `parent` with the field's node replaced (in place). */
export function replaceField(parent: SNode, name: string, next: SNode): boolean {
  for (let j = 1; j < parent.length; j++) { const c = parent[j]; if (Array.isArray(c) && c[0] === "property" && L.fieldName(c as SNode) === name) { parent[j] = next; return true; } }
  return false;
}
/** The row of the parent's own grid that edits this field's text (SCH_SYMBOL's / SCH_SHEET's field properties). */
export function parentFieldRow(kind: string, name: string): string { return kind === "sheet" ? (name === "Sheetname" || name === "Sheet name" ? "Sheet Name" : name === "Sheetfile" || name === "Sheet file" ? "Sheet File" : name) : name; }
