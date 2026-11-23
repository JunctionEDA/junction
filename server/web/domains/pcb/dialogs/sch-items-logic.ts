// dialogs/sch-items-logic.ts — the document half of eeschema's item property dialogs: DIALOG_LABEL_PROPERTIES,
// DIALOG_TEXT_PROPERTIES, DIALOG_FIELD_PROPERTIES, DIALOG_LINE_PROPERTIES, DIALOG_WIRE_BUS_PROPERTIES,
// DIALOG_JUNCTION_PROPS, DIALOG_SHAPE_PROPERTIES and the FIELDS_GRID_TABLE rows the label, symbol and sheet
// dialogs share.  Pure functions over s-expression nodes (the node tests load this file directly); the dialogs
// themselves are in sch-items.ts.  Every writer edits only the children it owns and keeps the others, and their
// order, as they were.

import { isBusGroup, isBusVector } from "../canvas/busname";
import { SimSession, type FieldLike } from "./sim-model-logic";
import { refPrefix, simPinsOfLib } from "./sim-files";

const K = (): KiCadCanvasApi => (globalThis as unknown as { KiCadCanvas: KiCadCanvasApi }).KiCadCanvas;
const isList = Array.isArray;
export const clone = (n: SNode): SNode => (K().cloneNode as (x: SNode) => SNode)(n);
export const kid = (n: SNode, k: string): SNode | null => { for (let j = 1; j < n.length; j++) { const c = n[j]; if (isList(c) && c[0] === k) return c as SNode; } return null; };
export const kids = (n: SNode, k: string): SNode[] => { const o: SNode[] = []; for (let j = 1; j < n.length; j++) { const c = n[j]; if (isList(c) && c[0] === k) o.push(c as SNode); } return o; };
export const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
export const num = (v: unknown, d = 0): number => { const x = Number(isList(v) ? NaN : v); return v === "" || v === undefined || v === null || !Number.isFinite(x) ? d : x; };
/** (k "v") with v written as a quoted string, as the file format wants it. */
export const qnode = (k: string, v: string): SNode => K().parse("(" + k + " " + JSON.stringify(v) + ")") as SNode;
export const r4 = (v: number): number => Math.round(v * 10000) / 10000;

/** A COLOR4D as the file writes it: r, g, b 0..255 and alpha 0..1.  null is COLOR4D::UNSPECIFIED. */
export type Color = [number, number, number, number] | null;
export type HAlign = "left" | "center" | "right";
export type VAlign = "top" | "center" | "bottom";
export const KICAD_FONT = "KiCad Font";
export const LINE_STYLES: [string, string][] = [["default", "Default"], ["solid", "Solid"], ["dash", "Dashed"], ["dot", "Dotted"], ["dash_dot", "Dash-Dot"], ["dash_dot_dot", "Dash-Dot-Dot"]];
/** lineTypeNames' bitmaps (common/stroke_params.cpp): the Default entry has none. */
export const LINE_STYLE_ICONS: Record<string, string> = { solid: "stroke_solid", dash: "stroke_dash", dot: "stroke_dot", dash_dot: "stroke_dashdot", dash_dot_dot: "stroke_dashdotdot" };

// ---------------------------------------------------------------- generic child edits
const idx = (n: SNode, k: string): number => { for (let j = 1; j < n.length; j++) { const c = n[j]; if (isList(c) && c[0] === k) return j; } return -1; };
export const drop = (n: SNode, k: string): void => { let i; while ((i = idx(n, k)) > 0) n.splice(i, 1); };
const dropTok = (n: SNode, t: string): void => { for (let j = n.length - 1; j > 0; j--) if (n[j] === t) n.splice(j, 1); };
/** (k …values): replaced where it is, or inserted before the first of `before` that exists (else at the end). */
export function put(n: SNode, k: string, values: unknown[], before: string[] = []): SNode {
  const i = idx(n, k), c = [k, ...values] as unknown as SNode;
  if (i > 0) { n[i] = c; return c; }
  let at = n.length; for (const b of before) { const j = idx(n, b); if (j > 0) { at = j; break; } }
  n.splice(at, 0, c); return c;
}
export const yes = (n: SNode, k: string): boolean => { if ((n as unknown[]).includes(k)) return true; const c = kid(n, k); return !!c && str(c[1]) !== "no"; };
export function setYes(n: SNode, k: string, on: boolean, before: string[] = [], writeNo = false): void {
  dropTok(n, k);
  if (on) put(n, k, ["yes"], before); else if (writeNo && kid(n, k)) put(n, k, ["no"], before); else drop(n, k);
}
export const colorVals = (c: [number, number, number, number]): number[] => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), r4(c[3])];
/** (color r g b a): all zero is COLOR4D::UNSPECIFIED. */
export function colorOf(c: SNode | null): Color {
  if (!c) return null; const v = [num(c[1]), num(c[2]), num(c[3]), num(c[4], 1)] as [number, number, number, number];
  return v[0] === 0 && v[1] === 0 && v[2] === 0 && v[3] === 0 ? null : v;
}
export function hexToColor(hex: string, alpha = 1): Color {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim()); if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), alpha];
}
export function colorToHex(c: Color): string { return c ? "#" + c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v as number))).toString(16).padStart(2, "0")).join("") : "#000000"; }
export const sameColor = (a: Color, b: Color): boolean => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- EDA_TEXT (effects)
export interface TextFx { font: string; size: number; thickness: number; bold: boolean; italic: boolean; color: Color; h: HAlign; v: VAlign; mirror: boolean; hidden: boolean; href: string }
export function readFx(n: SNode): TextFx {
  const e = kid(n, "effects"), f = e && kid(e, "font"), sz = f && kid(f, "size"), th = f && kid(f, "thickness"), j = e && kid(e, "justify"), face = f && kid(f, "face"), href = e && kid(e, "href");
  const ju = (j || []) as unknown[];
  return {
    font: face ? str(face[1]) : KICAD_FONT, size: sz ? num(sz[2], num(sz[1], 1.27)) : 1.27, thickness: th ? num(th[1]) : 0,
    bold: !!f && yes(f, "bold"), italic: !!f && yes(f, "italic"), color: f ? colorOf(kid(f, "color")) : null,
    h: ju.includes("left") ? "left" : ju.includes("right") ? "right" : "center", v: ju.includes("top") ? "top" : ju.includes("bottom") ? "bottom" : "center",
    mirror: ju.includes("mirror"), hidden: isHidden(n), href: href ? str(href[1]) : "",
  };
}
/** Write the parts of `fx` given; KiCad 9's order inside (font …): face, size, thickness, bold, italic, line_spacing, color. */
export function writeFx(n: SNode, fx: Partial<TextFx>): void {
  let e = kid(n, "effects"); if (!e) e = put(n, "effects", [["font", ["size", 1.27, 1.27]]], ["uuid", "property"]);
  let f = kid(e, "font"); if (!f) { f = ["font", ["size", 1.27, 1.27]] as unknown as SNode; e.splice(1, 0, f); }
  if (fx.font !== undefined) { drop(f, "face"); if (fx.font && fx.font !== KICAD_FONT) f.splice(1, 0, ["face", fx.font] as unknown as SNode); }
  if (fx.size !== undefined) put(f, "size", [r4(fx.size), r4(fx.size)], ["thickness", "bold", "italic", "line_spacing", "color"]);
  if (fx.thickness !== undefined) { if (fx.thickness > 0) put(f, "thickness", [r4(fx.thickness)], ["bold", "italic", "line_spacing", "color"]); else drop(f, "thickness"); }
  if (fx.bold !== undefined) setYes(f, "bold", fx.bold, ["italic", "line_spacing", "color"]);
  if (fx.italic !== undefined) setYes(f, "italic", fx.italic, ["line_spacing", "color"]);
  if (fx.color !== undefined) { drop(f, "color"); if (fx.color) put(f, "color", colorVals(fx.color)); }
  if (fx.h !== undefined || fx.v !== undefined || fx.mirror !== undefined) {
    const cur = readFx(n), h = fx.h ?? cur.h, v = fx.v ?? cur.v, m = fx.mirror ?? cur.mirror;
    const jv: string[] = []; if (h !== "center") jv.push(h); if (v !== "center") jv.push(v); if (m) jv.push("mirror");
    if (jv.length) put(e, "justify", jv, ["hide", "href"]); else drop(e, "justify");
  }
  if (fx.href !== undefined) { drop(e, "href"); if (fx.href) put(e, "href", [fx.href]); }
  if (fx.hidden !== undefined) setHidden(n, fx.hidden);
}
/** SCH_FIELD visibility: (hide yes) on the property (KiCad 9), or the older (effects … hide). */
export function isHidden(n: SNode): boolean {
  const hd = kid(n, "hide"); if (hd) return str(hd[1]) !== "no";
  const e = kid(n, "effects"); return !!e && ((e as unknown[]).includes("hide") || (!!kid(e, "hide") && str((kid(e, "hide") as SNode)[1]) !== "no"));
}
export function setHidden(n: SNode, hidden: boolean): void {
  const e = kid(n, "effects"); if (e) { dropTok(e, "hide"); drop(e, "hide"); }
  drop(n, "hide"); if (hidden) put(n, "hide", ["yes"], ["show_name", "do_not_autoplace", "effects"]);
}
export function atOf(n: SNode): [number, number, number] { const a = kid(n, "at"); return a ? [num(a[1]), num(a[2]), num(a[3])] : [0, 0, 0]; }
export function setAt(n: SNode, x: number, y: number, rot?: number): void {
  const a = kid(n, "at"); const r = rot === undefined ? (a ? num(a[3]) : 0) : rot;
  if (a) { a[1] = r4(x) as unknown as SNode; a[2] = r4(y) as unknown as SNode; if (a.length >= 4 || r) a[3] = r4(r) as unknown as SNode; }
  else put(n, "at", [r4(x), r4(y), r4(r)], ["effects", "uuid"]);
}

// ---------------------------------------------------------------- FIELDS_GRID_TABLE
/** One row of the fields grid; x / y are relative to the parent (the dialogs show offsets). */
export interface FieldRow {
  name: string; value: string; show: boolean; showName: boolean; h: HAlign; v: VAlign; italic: boolean; bold: boolean;
  size: number; orient: 0 | 90; x: number; y: number; font: string; color: Color; autoplace: boolean; mandatory: boolean;
  /** The node the row came from (null for a new row). */
  src: SNode | null;
  /** a field name template's row the symbol does not have yet (DIALOG_*_PROPERTIES "Add in any template fieldnames") */
  template?: boolean;
  /** The placed symbol the field belongs to: h / v are then the justification as displayed (GetEffective*Justify). */
  parent?: SNode | null;
}
/**
 * SCH_FIELD::IsHorizJustifyFlipped / IsVertJustifyFlipped: does the parent symbol's transform draw a field's stored
 * justification on the other side?  KiCad compares the rendered bounding box centre with the field position; the box
 * of a left-justified text lies towards +x of its anchor (a top-justified one towards +y), is turned by the text angle
 * (RotatePoint) and then by the symbol's TRANSFORM, and the side is read along the draw rotation's axis
 * (GetDrawRotation: the text angle, swapped when the transform has a y1 term).  Only a placed symbol has a transform.
 */
export function justifyFlips(parent: SNode | null | undefined, vertical: boolean): { h: boolean; v: boolean } {
  if (!parent || parent[0] !== "symbol" || !kid(parent, "lib_id")) return { h: false, v: false };
  const m = kid(parent, "mirror"), T = (K().symbolTransform as (r: number, m: string) => number[])(atOf(parent)[2], m ? str(m[1]) : "");
  const x1 = T[0], y1 = -T[1], x2 = T[2], y2 = -T[3];             // KiCad's own (Y-down) matrix
  const tr = (dx: number, dy: number): [number, number] => { const [rx, ry] = vertical ? [dy, -dx] : [dx, dy]; return [x1 * rx + y1 * ry, x2 * rx + y2 * ry]; };
  const drawVertical = vertical !== (y1 !== 0);
  const ch = tr(1, 0), cv = tr(0, 1);                              // box centre of a LEFT / of a TOP justified text, from its anchor
  return { h: drawVertical ? ch[1] > 0 : ch[0] < 0, v: drawVertical ? cv[0] < 0 : cv[1] < 0 };
}
const flipH = (h: HAlign): HAlign => (h === "left" ? "right" : h === "right" ? "left" : h);
const flipV = (v: VAlign): VAlign => (v === "top" ? "bottom" : v === "bottom" ? "top" : v);
/**
 * The field name templates the symbol does not define yet, as new rows shown per the template's visibility.  `rows`
 * gains them in place; `withoutUnusedTemplates` leaves out the ones still empty when the dialog closes, so a dialog
 * opened and closed adds nothing to the design (m_addedTemplateFields of the library dialog).
 */
export function addTemplateRows(rows: FieldRow[], templates: { name: string; visible: boolean }[], origin: [number, number]): FieldRow[] {
  const defined = new Set(rows.map((r) => r.name));
  for (const t of templates) if (!defined.has(t.name)) { const r = newRow(t.name, origin); r.show = t.visible; r.template = true; rows.push(r); defined.add(t.name); }
  return rows;
}
export function withoutUnusedTemplates(rows: FieldRow[]): FieldRow[] { return rows.filter((r) => !(r.template && !r.src && !r.value)); }
export const META_FIELD = /^ki_/;
export function fieldName(p: SNode): string { return str(p[1]) === "private" && p.length > 3 && !isList(p[2]) ? str(p[2]) : str(p[1]); }
export function fieldValue(p: SNode): string { return str(p[1]) === "private" && p.length > 3 && !isList(p[2]) ? str(p[3]) : str(p[2]); }
function setFieldValue(p: SNode, v: string): void { if (str(p[1]) === "private" && p.length > 3 && !isList(p[2])) p[3] = v as unknown as SNode; else p[2] = v as unknown as SNode; }
export function rowFromField(p: SNode, origin: [number, number], mandatory: boolean, parent?: SNode | null): FieldRow {
  const fx = readFx(p), [x, y, rot] = atOf(p), r = ((Math.round(rot) % 360) + 360) % 360, vertical = r === 90 || r === 270;
  const fl = justifyFlips(parent, vertical);      // GetEffectiveHorizJustify / GetEffectiveVertJustify
  const row: FieldRow = { name: fieldName(p), value: fieldValue(p), show: !fx.hidden, showName: yes(p, "show_name"), h: fl.h ? flipH(fx.h) : fx.h, v: fl.v ? flipV(fx.v) : fx.v, italic: fx.italic, bold: fx.bold,
    size: fx.size, orient: vertical ? 90 : 0, x: r4(x - origin[0]), y: r4(y - origin[1]), font: fx.font, color: fx.color,
    autoplace: !yes(p, "do_not_autoplace"), mandatory, src: p };
  if (parent) row.parent = parent;
  return row;
}
export function fieldRows(node: SNode, origin: [number, number], mandatory: string[] = []): FieldRow[] {
  return kids(node, "property").filter((p) => !META_FIELD.test(fieldName(p))).map((p) => rowFromField(p, origin, mandatory.includes(fieldName(p)), node));
}
export function newRow(name: string, origin: [number, number], size = 1.27): FieldRow {
  return { name, value: "", show: true, showName: false, h: "left", v: "center", italic: false, bold: false, size, orient: 0, x: 0, y: 0, font: KICAD_FONT, color: null, autoplace: true, mandatory: false, src: null };
}
/** The text of a row written into its (property) node (new or the one it came from, cloned). */
export function fieldFromRow(r: FieldRow, origin: [number, number], parent: SNode | null | undefined = r.parent): SNode {
  const p = r.src ? clone(r.src) : (["property", r.name, r.value, ["at", 0, 0, 0], ["effects", ["font", ["size", 1.27, 1.27]]]] as unknown as SNode);
  if (fieldName(p) !== r.name) { if (str(p[1]) === "private" && p.length > 3 && !isList(p[2])) p[2] = r.name as unknown as SNode; else p[1] = r.name as unknown as SNode; }
  setFieldValue(p, r.value);
  setAt(p, origin[0] + r.x, origin[1] + r.y, r.orient);
  setHidden(p, !r.show);
  drop(p, "show_name"); if (r.showName) put(p, "show_name", ["yes"], ["do_not_autoplace", "effects"]);
  else if (r.src && kid(r.src, "show_name")) put(p, "show_name", ["no"], ["do_not_autoplace", "effects"]);
  drop(p, "do_not_autoplace"); if (!r.autoplace) put(p, "do_not_autoplace", ["yes"], ["effects"]);
  else if (r.src && kid(r.src, "do_not_autoplace")) put(p, "do_not_autoplace", ["no"], ["effects"]);
  // SetHorizJustify / SetVertJustify, then the opposite when the parent draws it flipped (IsHorizJustifyFlipped)
  const fl = justifyFlips(parent, r.orient === 90);
  writeFx(p, { font: r.font, size: r.size, bold: r.bold, italic: r.italic, color: r.color, h: fl.h ? flipH(r.h) : r.h, v: fl.v ? flipV(r.v) : r.v });
  return p;
}
/** Did a row move (positioningChanged: position, justification or angle)? */
export function rowMoved(r: FieldRow, origin: [number, number]): boolean {
  if (!r.src) return false; const o = rowFromField(r.src, origin, r.mandatory, r.parent);
  return o.x !== r.x || o.y !== r.y || o.h !== r.h || o.v !== r.v || o.orient !== r.orient;
}
/**
 * DIALOG_LABEL_PROPERTIES::TransferDataFromWindow's tidy-up of the rows: empty unnamed rows go, an empty Netclass
 * row goes when another Netclass row is there, an unnamed row with text is called "untitled".
 */
export function tidyRows(rows: FieldRow[]): FieldRow[] {
  const out = rows.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const r = out[i];
    if (!r.name && !r.value) out.splice(i, 1);
    else if (r.name === "Netclass" && !r.value && out.filter((x) => x.name === "Netclass").length > 1) out.splice(i, 1);
    else if (!r.name) r.name = "untitled";
  }
  return out;
}
/** FIELDS_GRID_TABLE's name check: "Field name '%s' already in use." for the first clash. */
/** What deleting a mandatory row says (DIALOG_LABEL_PROPERTIES::OnDeleteField, DIALOG_SHEET_PROPERTIES::OnDeleteField). */
export function mandatoryFieldsMessage(n: number): string { return n <= 1 ? "The first field is mandatory." : `The first ${n} fields are mandatory.`; }
export function duplicateFieldName(rows: FieldRow[], mandatory: string[] = []): string | null {
  const seen: string[] = [];
  for (const r of rows) { if (!r.name) continue; if (seen.some((s) => fieldNamesAreDuplicates(r.name, s, mandatory))) return `Field name '${r.name}' already in use.`; seen.push(r.name); }
  return null;
}
/** The untranslated mandatory field names per parent (MANDATORY_FIELDS, SHEET_MANDATORY_FIELDS, GLOBALLABEL_MANDATORY_FIELDS). */
export function mandatoryNamesOf(parentKind: string): string[] {
  return parentKind === "symbol" || parentKind === "lib_symbol" ? ["Reference", "Value", "Footprint", "Datasheet", "Description"]
    : parentKind === "sheet" ? ["Sheetname", "Sheetfile"] : parentKind === "global_label" ? ["Intersheetrefs"] : [];
}
/** OnGridCellChanging on a Name cell: the message when `name` clashes with another row's name, else null. */
export function fieldNameClash(rows: { name: string }[], index: number, name: string, mandatory: string[]): string | null {
  for (let i = 0; i < rows.length; i++) if (i !== index && fieldNamesAreDuplicates(name, rows[i].name, mandatory)) return `Field name '${name}' already in use.`;
  return null;
}

// ---------------------------------------------------------------- OnAddField
/** GetUserFieldName( m_fields->size() ): "Field" and the number of rows there are. */
export const userFieldName = (count: number): string => "Field" + count;
/**
 * DIALOG_SYMBOL_PROPERTIES::OnAddField / DIALOG_SHEET_PROPERTIES::OnAddField: "Field<row count>", hidden, with the text
 * angle of the Reference (a symbol) or Sheetname (a sheet) row.
 */
export function newParentFieldRow(rows: FieldRow[], angleOf: string[]): FieldRow {
  const r = newRow(userFieldName(rows.length), [0, 0]), a = rows.find((x) => angleOf.includes(x.name));
  r.show = false; if (a) r.orient = a.orient;
  return r;
}
/** SCH_LABEL_BASE::GetDefaultFieldName: what a label's field is called on screen (the stored name stays). */
export function labelFieldDisplayName(name: string): string { return name === "Intersheetrefs" ? "Sheet References" : name === "Netclass" ? "Net Class" : name; }
/** The stored name of what was typed in a label's Name cell (SCH_FIELD::GetUntranslatedName recovers "Net Class"). */
export function labelFieldStoredName(shown: string): string { return shown === "Net Class" ? "Netclass" : shown === "Sheet References" ? "Intersheetrefs" : shown; }
/**
 * DIALOG_LABEL_PROPERTIES::OnAddField: "Netclass" (shown as "Net Class") while every row is the intersheet references
 * field or a Netclass field, else "Field"; the attributes and visibility of the last row (SetAttributes: angle, size,
 * italic, bold, justification, font, colour), or visible and italic when it is the first.
 */
export function newLabelFieldRow(rows: FieldRow[]): FieldRow {
  const plain = rows.some((x) => !(x.mandatory && x.name === "Intersheetrefs") && x.name !== "Netclass");
  const r = newRow(plain ? "Field" : "Netclass", [0, 0]), last = rows[rows.length - 1];
  if (last) { r.show = last.show; r.h = last.h; r.v = last.v; r.italic = last.italic; r.bold = last.bold; r.size = last.size; r.orient = last.orient; r.font = last.font; r.color = last.color ? (last.color.slice() as Color) : null; }
  else { r.show = true; r.italic = true; }
  return r;
}
/** SCH_FIELD::IsEmpty rows are not saved (DIALOG_SHEET_PROPERTIES::TransferDataFromWindow: name and text both blank). */
export function withoutBlankRows(rows: FieldRow[]): FieldRow[] { return rows.filter((r) => r.mandatory || !!r.name.trim() || !!r.value.trim()); }
/** ::IsGeneratedField: a field whose name is a ${...} expression (its text is the name and cannot be edited). */
export function isGeneratedField(name: string): boolean { return /^(\$\{[\w.]*\}|@\{.*\})$/.test(name); }

// ---------------------------------------------------------------- UNIT_BINDER::Validate
/**
 * "%s must be at least %s." / "%s must be less than %s." with the control's label (without its colon) and the bound in
 * the user's units; null when `v` lies within [min, max].  `fmt` writes a length with its unit.
 */
export function rangeError(label: string, v: number | undefined, min: number, max: number, fmt: (mm: number) => string): string | null {
  const name = label.replace(/:\s*$/, "");
  if (v === undefined || v < min) return `${name} must be at least ${fmt(min)}.`;
  if (v > max) return `${name} must be less than ${fmt(max)}.`;
  return null;
}

// ---------------------------------------------------------------- SCH_NETNAME_VALIDATOR (eeschema/sch_validators.cpp)
/**
 * NETNAME_VALIDATOR::IsValid then SCH_NETNAME_VALIDATOR::IsValid: "" for a usable signal name, else KiCad's message.
 * A '{' that does not follow $ _ ^ ~ (m_busGroupRegex) with a '}' somewhere must parse as a bus group; otherwise any
 * '[' or ']' must parse as a bus vector.  A single character is never checked further.
 */
export function netNameError(text: string, allowSpaces = true): string {
  if (/[\r\n]/.test(text)) return "Signal names cannot contain CR or LF characters";
  if (!allowSpaces && /[ \t]/.test(text)) return "Signal names cannot contain spaces";
  if (text.length === 1) return "";
  if (/(^|[^$_^~])\{/.test(text) && text.includes("}")) {
    if (!isBusGroup(text)) return "Signal name contains '{' and '}' but is not a valid bus name";
  } else if (text.includes("[") || text.includes("]")) {
    if (!isBusVector(text)) return "Signal name contains '[' or ']' but is not a valid bus name.";
  }
  return "";
}
/** Replace the node's (property) children by the rows: the property block keeps its place among the other children. */
export function writeFields(node: SNode, rows: FieldRow[], origin: [number, number]): void {
  const meta = kids(node, "property").filter((p) => META_FIELD.test(fieldName(p)));
  let first = -1;
  for (let j = node.length - 1; j > 0; j--) { const c = node[j]; if (isList(c) && c[0] === "property") { node.splice(j, 1); first = j; } }
  const block = [...rows.map((r) => fieldFromRow(r, origin, node)), ...meta];
  if (first < 0) { const before = ["pin", "instances"].map((k) => idx(node, k)).filter((j) => j > 0); first = before.length ? Math.min(...before) : node.length; }
  node.splice(first, 0, ...block);
}

// ---------------------------------------------------------------- labels
export const LABEL_KINDS = new Set(["label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
export const isDirective = (kind: string): boolean => kind === "netclass_flag" || kind === "directive_label";
export function labelTitle(kind: string): string {
  return kind === "global_label" ? "Global Label Properties" : kind === "hierarchical_label" ? "Hierarchical Label Properties" : isDirective(kind) ? "Directive Label Properties" : kind === "sheet_pin" ? "Hierarchical Sheet Pin Properties" : "Label Properties";
}
/** The shape radios of a label type: [file token, label] (LABEL_FLAG_SHAPE). */
export function labelShapes(kind: string): [string, string][] {
  if (isDirective(kind)) return [["dot", "Dot"], ["round", "Circle"], ["diamond", "Diamond"], ["rectangle", "Rectangle"]];
  if (kind === "global_label" || kind === "hierarchical_label" || kind === "sheet_pin") return [["input", "Input"], ["output", "Output"], ["bidirectional", "Bidirectional"], ["tri_state", "Tri-state"], ["passive", "Passive"]];
  return [];
}
// ---------------------------------------------------------------- sheet pins (DIALOG_SHEET_PIN_PROPERTIES)
/** A sheet pin's dialog state: (pin "name" <shape> (at x y a) (effects (font …)) (uuid …)) inside the sheet. */
export interface SheetPinState { text: string; shape: string; font: string; size: number; bold: boolean; italic: boolean; color: Color }
export const SHEET_PIN_SHAPES = new Set(["input", "output", "bidirectional", "tri_state", "passive"]);
export function readSheetPin(pin: SNode): SheetPinState {
  const fx = readFx(pin), e = kid(pin, "effects"), f = e && kid(e, "font"), sz = f && kid(f, "size");
  const shape = str(pin[2]);
  // eeschema uses only the text width as the text size (TransferDataToWindow: GetTextWidth)
  return { text: str(pin[1]), shape: SHEET_PIN_SHAPES.has(shape) ? shape : "input", font: fx.font, size: sz ? num(sz[1], 1.27) : 1.27, bold: fx.bold, italic: fx.italic, color: fx.color };
}
/** TransferDataFromWindow: name (EscapeString CTX_NETNAME), font, size (w = h), bold, italic, colour, shape. */
export function writeSheetPin(pin: SNode, s: SheetPinState): void {
  pin[1] = escapeNetName(s.text) as unknown as SNode;
  pin[2] = (SHEET_PIN_SHAPES.has(s.shape) ? s.shape : "input") as unknown as SNode;
  const cur = readSheetPin(pin);
  writeFx(pin, { font: s.font, size: Math.abs(cur.size - s.size) > 1e-9 ? s.size : undefined, bold: s.bold, italic: s.italic, color: s.color });
}
/** "Sheet pin name can not be empty." when the trimmed name is empty, else null. */
export function sheetPinNameError(text: string): string | null { return text.trim() ? null : "Sheet pin name can not be empty."; }
/**
 * SCH_SHEET_PIN::HitTest: the pin under `p` (index among the sheet's (pin …) children), or -1.  The pin's box runs
 * from its anchor on the sheet edge inwards over its flag and name (SCH_HIERLABEL's body: the flag is one text height,
 * the name about 0.7 of it per character), one text height across.
 */
export function sheetPinAt(sheet: SNode, p: [number, number], tol = 0): number {
  const pins = kids(sheet, "pin");
  for (let i = 0; i < pins.length; i++) {
    const pin = pins[i], [x, y, a] = atOf(pin), st = readSheetPin(pin), sz = st.size;
    const len = sz * 1.2 + sz * 0.72 * Math.max(1, unescapeString(st.text).length);
    const ang = ((Math.round(a) % 360) + 360) % 360;
    // a pin on the right edge (0) reads leftwards into the sheet, on the left edge (180) rightwards; top (90) down, bottom (270) up
    const dx = ang === 0 ? -1 : ang === 180 ? 1 : 0, dy = ang === 90 ? 1 : ang === 270 ? -1 : 0;
    const x0 = Math.min(x, x + dx * len), x1 = Math.max(x, x + dx * len), y0 = Math.min(y, y + dy * len), y1 = Math.max(y, y + dy * len);
    const half = sz * 0.6;
    const bx0 = dx ? x0 : x - half, bx1 = dx ? x1 : x + half, by0 = dy ? y0 : y - half, by1 = dy ? y1 : y + half;
    if (p[0] >= bx0 - tol && p[0] <= bx1 + tol && p[1] >= by0 - tol && p[1] <= by1 + tol) return i;
  }
  return -1;
}

/** SPIN_STYLE from the label's angle: 0 RIGHT, 1 UP, 2 LEFT, 3 BOTTOM (the file angle / 90). */
export function spinOf(n: SNode): 0 | 1 | 2 | 3 { const r = ((Math.round(atOf(n)[2]) % 360) + 360) % 360; return (Math.round(r / 90) % 4) as 0 | 1 | 2 | 3; }
/** SCH_LABEL_BASE::SetSpinStyle: the angle, and the justification it implies (a local label also sits on its baseline). */
export function setSpin(kind: string, n: SNode, spin: 0 | 1 | 2 | 3): void {
  const [x, y] = atOf(n), rot = spin * 90; setAt(n, x, y, rot);
  const right = spin === 2 || spin === 3;
  if (isDirective(kind)) return;
  const e = kid(n, "effects"); if (!e) return;
  const jv = kind === "label" || kind === "text" ? [right ? "right" : "left", "bottom"] : [right ? "right" : "left"];
  const old = kid(e, "justify"); if (old && (old as unknown[]).includes("mirror")) jv.push("mirror");
  put(e, "justify", jv, ["hide", "href"]);
}
export interface LabelState {
  text: string; shape: string; font: string; size: number; bold: boolean; italic: boolean; color: Color; spin: 0 | 1 | 2 | 3; autoRotate: boolean;
}
export function readLabel(kind: string, n: SNode): LabelState {
  const fx = readFx(n), sh = kid(n, "shape"), len = kid(n, "length");
  return { text: str(n[1]), shape: sh ? str(sh[1]) : (isDirective(kind) ? "round" : "input"), font: fx.font, size: isDirective(kind) ? (len ? num(len[1], 2.54) : 2.54) : fx.size,
    bold: fx.bold, italic: fx.italic, color: fx.color, spin: spinOf(n), autoRotate: false };   // m_autoRotateOnPlacement is not in the file: the caller fills it in
}
/** Write the dialog's label state into the node (the fields are written by writeFields). */
export function writeLabel(kind: string, n: SNode, s: LabelState): void {
  if (!isDirective(kind)) n[1] = s.text as unknown as SNode;
  if (labelShapes(kind).length) { const sh = kid(n, "shape"); if (sh) sh[1] = s.shape as unknown as SNode; else n.splice(2, 0, ["shape", s.shape] as unknown as SNode); }
  if (isDirective(kind)) {
    const len = kid(n, "length"); if (len) len[1] = r4(s.size) as unknown as SNode; else n.splice(2, 0, ["length", r4(s.size)] as unknown as SNode);
    writeFx(n, { color: s.color });
  } else {
    const cur = readFx(n);
    writeFx(n, { font: s.font, size: Math.abs(cur.size - s.size) > 1e-9 ? s.size : undefined, bold: s.bold, italic: s.italic, color: s.color });
  }
  if (spinOf(n) !== s.spin) setSpin(kind, n, s.spin);
}
/** EscapeString( aSource, CTX_NETNAME ): '/' becomes {slash}, carriage returns and line feeds are dropped. */
export function escapeNetName(text: string): string { return text.replace(/\//g, "{slash}").replace(/[\r\n]/g, ""); }
const UNESCAPE: Record<string, string> = { dblquote: "\"", quote: "'", lt: "<", gt: ">", backslash: "\\", slash: "/", bar: "|", comma: ",", colon: ":", space: " ", dollar: "$", tab: "\t", return: "\n", brace: "{" };
/** UnescapeString (common/string_utils.cpp): {slash} -> '/' and the other tokens; ${…}, ~{…}, ^{…}, _{…} stay. */
export function unescapeString(src: string): string {
  if (src.length <= 2) return src;
  let out = "", prev = "", ch = "";
  for (let i = 0; i < src.length; ++i) {
    prev = ch; ch = src[i];
    if (ch === "{") {
      let token = "", depth = 1, terminated = false;
      for (i = i + 1; i < src.length; ++i) {
        ch = src[i];
        if (ch === "{") depth++; else if (ch === "}") depth--;
        if (depth <= 0) { terminated = true; break; }
        token += ch;
      }
      if (!terminated) out += "{" + unescapeString(token);
      else if (prev === "$" || prev === "~" || prev === "^" || prev === "_") out += "{" + unescapeString(token) + "}";
      else if (Object.prototype.hasOwnProperty.call(UNESCAPE, token)) out += UNESCAPE[token];
      else out += "{" + unescapeString(token) + "}";
    } else out += ch;
  }
  return out;
}
/**
 * The label texts DIALOG_LABEL_PROPERTIES::TransferDataFromWindow writes.  An edited label keeps the text as typed,
 * escaped (EscapeString( text, CTX_NETNAME )); a new label's text goes through m_labelList, one label per line,
 * each line escaped and trimmed, empty lines skipped.
 */
export function labelLines(text: string, multi: boolean, isNew = true): string[] {
  const t = text.replace(/\r/g, "\n");
  if (!isNew) return [escapeNetName(t)];
  const lines = multi ? t.split("\n") : [t];
  return lines.map((l) => escapeNetName(l).trim()).filter((l) => !!l);
}

// ---------------------------------------------------------------- strokes, fills, junctions
export interface StrokeState { width: number; style: string; color: Color }
export function readStroke(n: SNode): StrokeState {
  const s = kid(n, "stroke"), w = s && kid(s, "width"), t = s && kid(s, "type");
  return { width: w ? num(w[1]) : 0, style: t ? str(t[1]) : "default", color: s ? colorOf(kid(s, "color")) : null };
}
export function writeStroke(n: SNode, s: Partial<StrokeState>): void {
  let st = kid(n, "stroke"); if (!st) st = put(n, "stroke", [["width", 0], ["type", "default"]], ["fill", "uuid"]);
  if (s.width !== undefined) put(st, "width", [r4(Math.max(0, s.width))], ["type", "color"]);
  if (s.style !== undefined) put(st, "type", [s.style], ["color"]);
  if (s.color !== undefined) { drop(st, "color"); if (s.color) put(st, "color", colorVals(s.color)); }
}
/** UI_FILL_MODE of a sheet-level shape: none, solid (FILLED_WITH_COLOR), hatch, reverse_hatch, cross_hatch. */
export const FILL_MODES: [string, string][] = [["none", "None"], ["solid", "Solid"], ["hatch", "Hatch"], ["reverse_hatch", "Reverse Hatch"], ["cross_hatch", "Cross-hatch"]];
export function readFill(n: SNode): { mode: string; color: Color } {
  const f = kid(n, "fill"), t = f && kid(f, "type"), ty = t ? str(t[1]) : "none";
  const mode = ty === "none" ? "none" : ty === "hatch" || ty === "reverse_hatch" || ty === "cross_hatch" ? ty : "solid";
  return { mode, color: f ? colorOf(kid(f, "color")) : null };
}
export function writeFill(n: SNode, mode: string, color: Color): void {
  const ty = mode === "solid" ? "color" : mode;
  const vals: unknown[] = [["type", ty]]; if (ty !== "none") vals.push(["color", ...colorVals(color || [0, 0, 0, 0])]);
  put(n, "fill", vals, ["effects", "uuid"]);
}
export function readJunction(n: SNode): { diameter: number; color: Color } { const d = kid(n, "diameter"); return { diameter: d ? num(d[1]) : 0, color: colorOf(kid(n, "color")) }; }
export function writeJunction(n: SNode, s: { diameter?: number; color?: Color }): void {
  if (s.diameter !== undefined) put(n, "diameter", [r4(Math.max(0, s.diameter))], ["color", "uuid"]);
  if (s.color !== undefined) put(n, "color", colorVals(s.color || [0, 0, 0, 0]), ["uuid"]);
}
/** The common value of a property over several items, or undefined when they differ (an INDETERMINATE control). */
export function common<T>(values: T[]): T | undefined {
  if (!values.length) return undefined; const a = JSON.stringify(values[0]);
  return values.every((v) => JSON.stringify(v) === a) ? values[0] : undefined;
}

// ---------------------------------------------------------------- SCH_EDIT_TOOL::Properties
export type PropsTarget =
  | { dialog: "none" } | { dialog: "lines"; ids: string[] } | { dialog: "junctions"; ids: string[] } | { dialog: "wires"; ids: string[] }
  | { dialog: "mixed" } | { dialog: "item"; id: string } | { dialog: "promote"; id: string };
const WIRE_KINDS = new Set(["wire", "bus", "bus_entry", "bus_wire_entry", "junction"]);
/**
 * A schematic (polyline) with two points is a SCH_LINE graphic line; with more it is a SCH_SHAPE polygon
 * (SCH_IO_KICAD_SEXPR_PARSER: "keep SCH_SHAPE for a polygon and convert to SCH_LINE when the item has only 2 corners").
 */
export function isGraphicLine(kind: string, node?: SNode | null): boolean {
  if (kind !== "polyline") return false;
  if (!node) return true;
  const pts = kid(node, "pts"); return !pts || kids(pts, "xy").length <= 2;
}
/**
 * Which dialog E opens for a selection (SCH_EDIT_TOOL::Properties): only graphic lines -> the line dialog, only
 * junctions -> the junction dialog, wires / buses / entries / junctions -> the wire & bus dialog, any other mix ->
 * the infobar; one item -> its own dialog, but nothing for a no-connect and a pin promoted to its symbol.
 */
export function propertiesTarget(items: { id: string; kind: string; node?: SNode }[]): PropsTarget {
  if (!items.length) return { dialog: "none" };
  if (items.every((i) => isGraphicLine(i.kind, i.node))) return { dialog: "lines", ids: items.map((i) => i.id) };
  if (items.every((i) => i.kind === "junction")) return { dialog: "junctions", ids: items.map((i) => i.id) };
  if (items.every((i) => WIRE_KINDS.has(i.kind))) return { dialog: "wires", ids: items.map((i) => i.id) };
  if (items.length > 1) return { dialog: "mixed" };
  const it = items[0];
  if (it.kind === "no_connect") return { dialog: "none" };
  if (it.kind === "pin") return { dialog: "promote", id: it.id };
  return { dialog: "item", id: it.id };
}

// ---------------------------------------------------------------- DIALOG_FIELD_PROPERTIES
const TITLE_CAPS: Record<string, string> = { Reference: "Reference Designator", Value: "Value", Footprint: "Footprint", Datasheet: "Datasheet", Description: "Description", Sheetname: "Sheet Name", Sheetfile: "Sheet File", Intersheetrefs: "Intersheet References" };
/** "Edit %s Field" with TitleCaps for a mandatory field, "Edit '%s' Field" for a user field. */
export function fieldDialogTitle(name: string, parentKind: string): string {
  const mandatory = parentKind === "symbol" || parentKind === "lib_symbol" ? ["Reference", "Value", "Footprint", "Datasheet", "Description"] : parentKind === "sheet" ? ["Sheetname", "Sheetfile"] : parentKind === "global_label" ? ["Intersheetrefs"] : [];
  return mandatory.includes(name) ? `Edit ${TITLE_CAPS[name] || name} Field` : `Edit '${name}' Field`;
}

/** EDA_TEXT::ValidateHyperlink: empty, "#<page>", or a URI with a scheme. */
export function validHyperlink(url: string): boolean {
  if (!url || url.startsWith("#")) return true;
  return /^[a-z][a-z0-9+.-]*:\S*$/i.test(url);
}
export const BAD_LINK = "Invalid hyperlink destination. Please enter either a valid URL (e.g. file:// or http(s)://) or \"#<page number>\" to create a hyperlink to a page in this schematic.";

/** SCH_SYMBOL::SetShowPinNames / SetShowPinNumbers act on the symbol's library copy: (pin_names (hide yes)). */
export function setPinVisibility(lib: SNode, key: "pin_numbers" | "pin_names", show: boolean): void {
  let c = kid(lib, key);
  if (!c) { if (show) return; c = put(lib, key, [], ["exclude_from_sim", "in_bom", "on_board", "property", "symbol"]); }
  const t = (c as unknown[]).indexOf("hide"); if (t > 0) c.splice(t, 1);
  drop(c, "hide"); if (!show) put(c, "hide", ["yes"]);
  if (c.length === 1) drop(lib, key);
}
/** The (pin "n" …) instance node's alternate: set, or cleared for the base function. */
export function setPinAlternate(node: SNode, number: string, alt: string): void {
  let p = kids(node, "pin").find((x) => str(x[1]) === number);
  if (!p) { if (!alt) return; p = ["pin", number, ["uuid", (K().newUuid as () => string)()]] as unknown as SNode; const at = node.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "instances"); if (at > 0) node.splice(at, 0, p); else node.push(p); }
  drop(p, "alternate"); if (alt) p.push(qnode("alternate", alt));
}



// ---------------------------------------------------------------- FIELD_VALIDATOR (common/validators.cpp)
export type FieldId = "REFERENCE" | "VALUE" | "FOOTPRINT" | "DATASHEET" | "SHEET_NAME" | "SHEET_FILENAME" | "SHEET_REF_SUFFIX" | "USER";
/** UTIL::GetRefDesPrefix: the reference up to its trailing digits and question marks. */
export function refDesPrefix(ref: string): string { let i = ref.length; while (i > 0 && (ref[i - 1] === "?" || /[0-9]/.test(ref[i - 1]))) i--; return ref.slice(0, i); }
/** GetFieldValidationErrorMessage: "" when the text is acceptable for that field. */
export function fieldValidationError(id: FieldId, value: string): string {
  let excludes = "\r\n\t";
  // SHEET_REF_SUFFIX: '?' marks unannotated references and ',' is reserved for stacked sheet series
  if (id === "REFERENCE") excludes += " "; else if (id === "SHEET_NAME") excludes += "/"; else if (id === "SHEET_REF_SUFFIX") excludes += " ?,";
  // a suffix is unescaped until it no longer changes, so {brace}comma} cannot hide a comma
  if (id === "SHEET_REF_SUFFIX") for (let next = unescapeString(value); next !== value; next = unescapeString(value)) value = next;
  const empty = id === "REFERENCE" || id === "SHEET_NAME" || id === "SHEET_FILENAME";
  if (empty && !value) return id === "SHEET_NAME" ? "A sheet must have a name." : id === "SHEET_FILENAME" ? "A sheet must have a file specified." : "The value of the field cannot be empty.";
  const found: string[] = [];
  for (const c of excludes) if (value.includes(c)) found.push(c === "\r" ? "carriage return" : c === "\n" ? "line feed" : c === "\t" ? "tab" : c === " " ? "space" : `'${c}'`);
  if (found.length) {
    let bad = "";
    found.forEach((f, i) => { if (bad) bad += found.length === 2 ? " or " : i < found.length - 2 ? ", or " : ", "; bad += f; });
    const what: Record<FieldId, string> = { REFERENCE: "The reference designator", VALUE: "The value field", FOOTPRINT: "The footprint field", DATASHEET: "The datasheet field", SHEET_NAME: "The sheet name", SHEET_FILENAME: "The sheet filename", SHEET_REF_SUFFIX: "The reference suffix", USER: "The field" };
    return `${what[id]} cannot contain ${bad} character(s).`;
  }
  if (id === "REFERENCE" && value.includes("${")) return "The reference designator cannot contain text variable references";
  if (id === "REFERENCE" && !refDesPrefix(value)) return "References must start with a letter.";
  return "";
}
/** Which FIELD_VALIDATOR a fields-grid row's value gets (FIELDS_GRID_TABLE::GetAttr; a symbol's Value cell is a styled-text editor without one). */
export function fieldIdOf(parentKind: string, name: string): FieldId | null {
  if (parentKind === "symbol") return name === "Reference" ? "REFERENCE" : name === "Value" ? null : "USER";
  if (parentKind === "sheet") return /^Sheet ?name$/i.test(name) ? "SHEET_NAME" : /^Sheet ?file$/i.test(name) ? "SHEET_FILENAME" : "USER";
  return "USER";
}
/**
 * The fields grid's checks at OK, in KiCad's order: each cell's FIELD_VALIDATOR (a wx grid vetoes the edit with
 * "Field Validation Error"), then "Fields must have a name." for a user field without one (a sheet only minds a
 * nameless field that has text).
 */
export function validateFieldRows(parentKind: string, rows: FieldRow[]): { title: string; message: string } | null {
  for (const r of rows) {
    const nameErr = r.mandatory ? "" : fieldValidationError("USER", r.name);
    if (nameErr) return { title: "Field Validation Error", message: nameErr };
    const id = fieldIdOf(parentKind, r.name), err = id ? fieldValidationError(id, r.value) : "";
    if (err) return { title: "Field Validation Error", message: err };
  }
  for (const r of rows) {
    if (r.mandatory || r.name) continue;
    if (parentKind === "sheet" && !r.value) continue;
    return { title: "Error", message: "Fields must have a name." };
  }
  return null;
}

// ---------------------------------------------------------------- symbol instance data (SCH_SYMBOL::SetRef / SetUnitSelection)
/**
 * The (instances (project …) (path "…")) entry of one sheet path: the exact path (the named project first), or —
 * when the hierarchy is not known — the only entry there is.  null when the symbol has no entry for the path.
 */
export function instanceEntry(node: SNode, path: string | null, project: string | null): SNode | null {
  const inst = kid(node, "instances"); if (!inst) return null;
  const prs = kids(inst, "project").slice().sort((a, b) => Number(str(b[1]) === project) - Number(str(a[1]) === project));
  const all: SNode[] = []; for (const pr of prs) all.push(...kids(pr, "path"));
  if (path) { const hit = all.find((p) => str(p[1]) === path); if (hit) return hit; }
  return all.length === 1 ? all[0] : null;
}
/** SetRef / SetUnitSelection on the current sheet path only: the other projects' and sheet instances' data stay. */
export function setInstanceData(node: SNode, path: string | null, project: string | null, data: { reference?: string; unit?: number }): boolean {
  const e = instanceEntry(node, path, project); if (!e) return false;
  if (data.reference !== undefined) { const r = kid(e, "reference"); if (r) r[1] = data.reference as unknown as SNode; else put(e, "reference", [data.reference], ["unit"]); }
  if (data.unit !== undefined) { const u = kid(e, "unit"); if (u) u[1] = data.unit as unknown as SNode; else put(e, "unit", [data.unit]); }
  return true;
}

// ---------------------------------------------------------------- a sheet file linked anew (ChangeSheetFile)
/**
 * SCH_SHEET_LIST::AddNewSymbolInstances / AddNewSheetInstances then SCH_SCREENS::ClearAnnotationOfNewSheetPaths on
 * one sheet file reached by the new sheet path `path`: every symbol gets an instance entry for the path (added when it
 * has none) with its reference reset to the prefix and '?', its unit kept; every sub-sheet gets a page entry for the
 * path (the next virtual page number) and is returned with its own new path, to be walked in turn.
 */
export function newSheetPathNodes(doc: KDoc, path: string, project: string, nextPage: () => number): { nodes: Map<string, SNode>; subs: { file: string; path: string }[] } {
  const P = K() as unknown as { parse(s: string): SNode; cloneNode(n: SNode): SNode };
  const q = JSON.stringify, nodes = new Map<string, SNode>(), subs: { file: string; path: string }[] = [];
  const projectOf = (n: SNode): SNode => {
    let inst = kid(n, "instances");
    if (!inst) { inst = ["instances"] as unknown as SNode; n.push(inst); }                 // written last, after the pins
    let pr = kids(inst, "project").find((x) => str(x[1]) === project);
    if (!pr) { pr = P.parse(`(project ${q(project)})`); inst.push(pr); }
    return pr;
  };
  for (const it of doc.items.values()) {
    if (it.kind === "symbol") {
      const n = P.cloneNode(it.node);
      const all = instanceEntriesOf(n), refP = kids(n, "property").find((p) => fieldName(p) === "Reference");
      const curRef = all.length && kid(all[0], "reference") ? str((kid(all[0], "reference") as SNode)[1]) : refP ? fieldValue(refP) : "";
      const unit = all.length && kid(all[0], "unit") ? num((kid(all[0], "unit") as SNode)[1], 1) : num((kid(n, "unit") || [0, 1])[1], 1);
      const ref = refDesPrefix(curRef) + "?";
      const pr = projectOf(n); let e = kids(pr, "path").find((x) => str(x[1]) === path);
      if (!e) { e = P.parse(`(path ${q(path)} (reference ${q(ref)}) (unit ${unit}))`); pr.push(e); }
      else { const r = kid(e, "reference"); if (r) r[1] = ref as unknown as SNode; else e.splice(2, 0, P.parse(`(reference ${q(ref)})`)); }
      nodes.set(it.id, n);
    } else if (it.kind === "sheet") {
      const n = P.cloneNode(it.node), uuid = str((kid(n, "uuid") || [])[1]);
      const pr = projectOf(n);
      if (!kids(pr, "path").some((x) => str(x[1]) === path)) pr.push(P.parse(`(path ${q(path)} (page ${q(String(nextPage()))}))`));
      nodes.set(it.id, n);
      const f = kids(n, "property").find((p) => /^Sheet ?file$/i.test(fieldName(p)));
      if (f && uuid) subs.push({ file: fieldValue(f), path: `${path}/${uuid}` });
    }
  }
  return { nodes, subs };
}
function instanceEntriesOf(n: SNode): SNode[] { const inst = kid(n, "instances"); const out: SNode[] = []; if (inst) for (const pr of kids(inst, "project")) out.push(...kids(pr, "path")); return out; }

// ---------------------------------------------------------------- SCH_SHEET_LIST::TestForRecursion
/**
 * Would linking `srcFiles` (the new sheet file and every file under it) into `dest` (the file of the sheet being
 * edited's parent) make a loop?  `paths` are the hierarchy's sheet paths as file names from the root down.
 */
export function sheetRecursion(paths: string[][], srcFiles: string[], dest: string): boolean {
  for (const src of srcFiles) {
    if (src === dest) return true;                       // the source and destination file names cannot be the same
    for (const p of paths) {
      let i = p.indexOf(dest); if (i <= 0) continue;     // not in this path, or the root: no recursion possible
      while (i > 0) { i--; if (p[i] === src) return true; }
    }
  }
  return false;
}
export const RECURSION_MSG = (dest: string): string => `The sheet changes cannot be made because the destination sheet already has the sheet '${dest}' or one of its subsheets as a parent somewhere in the schematic hierarchy.`;

// ---------------------------------------------------------------- SCH_SCREEN::Append's library symbol variants
/**
 * getLibSymbolNameMatches + the comparison in SCH_SCREEN::Append: the name of an existing library copy (the
 * lib_id itself or "<item name>_<n>") that equals `copy` apart from its name, else a new "<item name>_<n>".
 */
export function libVariantName(lib: Map<string, SNode>, libId: string, copy: SNode): { name: string; reused: boolean } {
  const item = libId.split(":").pop() || libId;
  const matches: string[] = []; if (lib.has(libId)) matches.push(libId);
  for (const n of lib.keys()) if (n.startsWith(item + "_") && /^\d+$/.test(n.slice(item.length + 1))) matches.push(n);
  const body = (n: SNode): string => JSON.stringify((n as unknown[]).slice(2));
  const want = body(copy);
  for (const n of matches) { const l = lib.get(n); if (l && body(l) === want) return { name: n, reused: true }; }
  let k = 1; while (lib.has(`${item}_${k}`)) k++;
  return { name: `${item}_${k}`, reused: false };
}

// ---------------------------------------------------------------- KiCad 10 line endings (DIALOG_LINE_PROPERTIES / DIALOG_SHAPE_PROPERTIES)
export type EndingStyle = "none" | "arrow" | "arrow_open" | "circle" | "square";
/** LINE_ENDING::s_defaultChoiceOrder with the dialogs' names. */
export const ENDING_CHOICES: [EndingStyle, string][] = [["none", "None"], ["arrow", "Arrow"], ["arrow_open", "Open Arrow"], ["circle", "Circle"], ["square", "Square"]];
export const ENDINGS_HELP = "Set line ending sizes to 0 for automatic (5× line width).";
/** The schematic file version that introduced line endings: older sheets keep the controls off (no format bump). */
export const LINE_ENDING_VERSION = 20260818;
export interface EndingState { style: EndingStyle; length: number; width: number; thickness: number; strokeType: string }
export function readEndingState(n: SNode, key: "start_shape" | "end_shape"): EndingState {
  const e = kid(n, key); const st: EndingState = { style: "none", length: 0, width: 0, thickness: 0, strokeType: "default" }; if (!e) return st;
  const s = str(e[1]); st.style = (ENDING_CHOICES.some(([v]) => v === s) ? s : "none") as EndingStyle;
  const l = kid(e, "length"), w = kid(e, "width"), sk = kid(e, "stroke"); if (l) st.length = num(l[1]); if (w) st.width = num(w[1]);
  if (sk) { const sw = kid(sk, "width"), ty = kid(sk, "type"); if (sw) st.thickness = num(sw[1]); if (ty) st.strokeType = str(ty[1]); }
  return st;
}
/** LINE_ENDING::Format: nothing for None; (length)/(width)/(stroke) only when > 0; placed after (stroke), start before end. */
export function writeEndingState(n: SNode, key: "start_shape" | "end_shape", st: EndingState): void {
  drop(n, key);
  if (st.style === "none") return;
  const f = (v: number): string => String(r4(v));
  let s = "(" + key + " " + st.style;
  if (st.length > 0) s += " (length " + f(st.length) + ")";
  if (st.width > 0) s += " (width " + f(st.width) + ")";
  if (st.thickness > 0) s += " (stroke (width " + f(st.thickness) + ") (type " + (st.strokeType || "default") + "))";
  const node = K().parse(s + ")") as SNode;
  let at = idx(n, key === "start_shape" ? "end_shape" : "");
  if (at < 0) { const sk = idx(n, "stroke"); at = sk > 0 ? sk + 1 : -1; if (key === "end_shape") { const ss = idx(n, "start_shape"); if (ss > 0) at = ss + 1; } }
  if (at < 0) { for (const b of ["fill", "uuid", "locked"]) { const j = idx(n, b); if (j > 0) { at = j; break; } } }
  if (at < 0) at = n.length;
  n.splice(at, 0, node);
}
/** Do the line ending controls apply?  Graphic lines and open shapes (DIALOG_SHAPE_PROPERTIES hides them on closed ones). */
export function supportsEndings(kind: string, n: SNode): boolean {
  if (kind === "arc" || kind === "bezier") return true;
  if (kind !== "polyline") return false;
  const p = kid(n, "pts"); const pts = p ? kids(p, "xy") : [];
  if (pts.length < 2) return false;
  const a = pts[0], b = pts[pts.length - 1]; const f = kid(n, "fill"); const filled = !!f && !!kid(f, "type") && str((kid(f, "type") as SNode)[1]) !== "none";
  return pts.length === 2 || (!filled && !(num(a[1]) === num(b[1]) && num(a[2]) === num(b[2])));
}

/** FieldNamesAreDuplicates (template_fieldnames.cpp): the same name, or a case variant of a mandatory field's name
 *  (the parser folds those). */
export function fieldNamesAreDuplicates(a: string, b: string, mandatory: string[] = ["Reference", "Value", "Footprint", "Datasheet", "Description"]): boolean {
  if (a === b) return true;
  if (a.toLowerCase() !== b.toLowerCase()) return false;
  return mandatory.some((m) => m.toLowerCase() === a.toLowerCase());
}

/** DIALOG_TEXT_PROPERTIES' hyperlink combo (dialog_text_properties.cpp): one "Page <n> (<sheet>)" entry per sheet page,
 *  a "---" separator, then the file://, http:// and https:// stems. */
export function hyperlinkChoices(pages: [string, string][]): string[] {
  return [...pages.map(([p, n]) => `Page ${p} (${n})`), "---", "file://...", "http://...", "https://..."];
}
/** onHyperlinkCombo: an entry's client data — "#<page>" for a page, the scheme for "file://..." and the like; the
 *  separator restores the previous text; anything else stays. */
export function hyperlinkPick(choice: string, pages: [string, string][], prev: string): string {
  const i = pages.findIndex(([p, n]) => choice === `Page ${p} (${n})`);
  if (i >= 0) return "#" + pages[i][0];
  if (choice === "file://..." || choice === "http://..." || choice === "https://...") return choice.slice(0, -3);
  return choice === "---" ? prev : choice;
}

// ---------------------------------------------------------------- KIUI::SelectReferenceNumber
/**
 * The part of a reference designator a first focus selects: the run of '?' (or of '*'), else the number left once
 * non-digits are trimmed from both ends ("R12" -> the "12").  null: select everything (no number).
 */
export function referenceNumberRange(ref: string): [number, number] | null {
  for (const ch of ["?", "*"]) if (ref.includes(ch)) return [ref.indexOf(ch), ref.lastIndexOf(ch) + 1];
  const digit = (c: string): boolean => c >= "0" && c <= "9";
  let num = ref;
  while (num && (!digit(num[num.length - 1]) || !digit(num[0]))) {
    if (!digit(num[num.length - 1])) num = num.slice(0, -1);
    if (num && !digit(num[0])) num = num.slice(1);
  }
  if (!num) return null;
  const at = ref.indexOf(num); return [at, at + num.length];
}
/** LIB_SYMBOL::GetUnitDisplayName( unit, false ): the library's (unit_name …) when set, else the unit's letter. */
export function unitDisplayName(lib: SNode | null, unit: number, letter: (u: number) => string): string {
  if (lib) for (const s of kids(lib, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(str(s[1])); if (!m || Number(m[1]) !== unit) continue;
    const un = kid(s, "unit_name"); if (un && str(un[1])) return str(un[1]);
  }
  return letter(unit);
}

// ---------------------------------------------------------------- SCHEMATIC::ConvertRefsToKIIDs / ConvertKIIDsToRefs
/** One symbol instance: its KIID path ("/<sheet uuids…>/<symbol uuid>"), uuid and reference on that sheet path. */
export interface XrefSymbol { path: string; uuid: string; ref: string; power?: boolean }
/** An escaped expression (\${…} or \@{…}) starting at i: copied verbatim; the index of its last character, else -1. */
function copyEscaped(src: string, i: number, out: string[]): number {
  const n = src.length;
  if (!(src[i] === "\\" && i + 2 < n && src[i + 2] === "{" && (src[i + 1] === "$" || src[i + 1] === "@"))) return -1;
  out.push(src[i], src[i + 1], src[i + 2]); i += 2;
  let depth = 1;
  for (i = i + 1; i < n && depth > 0; ++i) { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; out.push(src[i]); }
  return i - 1;
}
/** ${R1:Value} -> ${<sheet path>/<symbol uuid>:Value} for the first non-power symbol instance with that reference. */
export function schRefsToKiids(src: string, symbols: XrefSymbol[]): string {
  const out: string[] = [], n = src.length;
  for (let i = 0; i < n; ++i) {
    const e = copyEscaped(src, i, out); if (e >= 0) { i = e; continue; }
    if (src[i] === "$" && i + 1 < n && src[i + 1] === "{") {
      let token = "", cross = false, nesting = 0;
      for (i = i + 2; i < n; ++i) {
        if (src[i] === "{" && (src[i - 1] === "_" || src[i - 1] === "^" || src[i - 1] === "~")) nesting++;
        if (src[i] === "}") { nesting--; if (nesting < 0) break; }
        if (src[i] === ":") cross = true;
        token += src[i];
      }
      if (cross) {
        const k = token.indexOf(":"), ref = token.slice(0, k), rest = token.slice(k + 1);
        const hit = symbols.find((s) => !s.power && s.ref === ref);
        if (hit) token = hit.path + ":" + rest;
      }
      out.push("${" + token + "}");
    } else out.push(src[i]);
  }
  return out.join("");
}
/** ${<path or uuid>:Value} -> ${R1:Value} when the last id of the path is a symbol (its reference on that sheet path). */
export function schKiidsToRefs(src: string, symbols: XrefSymbol[]): string {
  const out: string[] = [], n = src.length;
  for (let i = 0; i < n; ++i) {
    const e = copyEscaped(src, i, out); if (e >= 0) { i = e; continue; }
    if (src[i] === "$" && i + 1 < n && src[i + 1] === "{") {
      let token = "", cross = false;
      for (i = i + 2; i < n; ++i) { if (src[i] === "}") break; if (src[i] === ":") cross = true; token += src[i]; }
      if (cross) {
        const k = token.indexOf(":"), ref = token.slice(0, k), rest = token.slice(k + 1);
        const ids = ref.split("/").filter(Boolean), uuid = ids[ids.length - 1] || "";
        // ResolveItem( uuid ), on the sheet path the reference names when it has one
        const hit = (ids.length > 1 && symbols.find((s) => s.path === "/" + ids.join("/"))) || symbols.find((s) => s.uuid === uuid);
        if (uuid && hit) token = hit.ref + ":" + rest;
      }
      out.push("${" + token + "}");
    } else out.push(src[i]);
  }
  return out.join("");
}

// ---------------------------------------------------------------- DIALOG_TEXT_PROPERTIES: a text box that fits its text
/**
 * After the properties are applied: where the box is smaller than SCH_TEXTBOX::GetMinSize the end corner is pushed out
 * (end = end >= start ? start + min : start - min, per axis).  True when the (size …) changed.
 */
export function growTextBox(n: SNode, min: [number, number]): boolean {
  const sz = kid(n, "size"); if (!sz) return false;
  let grown = false;
  for (const ax of [0, 1]) {
    const cur = num(sz[1 + ax]), m = min[ax];
    if (m > 0 && Math.abs(cur) < m) { sz[1 + ax] = r4(cur >= 0 ? m : -m) as unknown as SNode; grown = true; }
  }
  return grown;
}

// ---------------------------------------------------------------- DIALOG_SHEET_PROPERTIES
/** The (path …) entry of the sheet instance on `path` (this sheet under the sheet path now open); without a known path,
 *  the only entry there is. */
function sheetInstanceEntry(node: SNode, path: string | null, project: string | null): SNode | null {
  const inst = kid(node, "instances"); if (!inst) return null;
  const prs = kids(inst, "project").slice().sort((a, b) => Number(str(b[1]) === project) - Number(str(a[1]) === project));
  const all: SNode[] = []; for (const pr of prs) all.push(...kids(pr, "path"));
  if (path) return all.find((p) => str(p[1]) === path) || null;
  return all.length === 1 ? all[0] : null;
}
/** instance.GetPageNumber(): the page of this sheet on the current sheet path ("" when it has none). */
export function sheetPageNumber(node: SNode, path: string | null, project: string | null): string {
  const e = sheetInstanceEntry(node, path, project), pg = e && kid(e, "page"); return pg ? str(pg[1]) : "";
}
/** instance.SetPageNumber( text ): written as typed (an empty text too); the instance entry is made when missing. */
export function setSheetPageNumber(node: SNode, path: string | null, project: string | null, page: string): boolean {
  let e = sheetInstanceEntry(node, path, project);
  if (!e) {
    if (!path || !project) return false;
    let inst = kid(node, "instances"); if (!inst) { inst = ["instances"] as unknown as SNode; node.push(inst); }
    let pr = kids(inst, "project").find((x) => str(x[1]) === project); if (!pr) { pr = qnode("project", project); inst.push(pr); }
    e = qnode("path", path); pr.push(e);
  }
  const pg = kid(e, "page"); if (pg) pg[1] = String(page) as unknown as SNode; else e.splice(2, 0, qnode("page", String(page)));
  return true;
}
/**
 * GetSheetFieldsForEditing (eeschema/fields_grid_table.cpp): a hidden Reference Suffix row (the Sheetname's size and
 * angle) when the sheet has none; the mandatory rows first, the suffix row right after them, the rest in their order.
 */
export function sheetFieldsForEditing(rows: FieldRow[], suffixName: string): FieldRow[] {
  const out = rows.slice();
  if (!out.some((r) => r.name === suffixName)) {
    const name = out.find((r) => /^Sheet ?name$/i.test(r.name)), r = newRow(suffixName, [0, 0], name ? name.size : 1.27);
    r.show = false; if (name) r.orient = name.orient;
    out.push(r);
  }
  const rank = (r: FieldRow): number => (r.mandatory ? 0 : r.name === suffixName ? 1 : 2);
  return out.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}
/**
 * NET_SETTINGS::RenameNetPathPrefix on the .kicad_pro: the netclass patterns and the net colour keys that start with
 * the old path prefix take the new one.  True when something changed.
 */
export function renameNetPathPrefix(pro: Record<string, unknown>, oldPrefix: string, newPrefix: string): boolean {
  if (!oldPrefix || oldPrefix === newPrefix) return false;
  const ns = pro.net_settings as Record<string, unknown> | undefined; if (!ns || typeof ns !== "object") return false;
  let changed = false;
  if (Array.isArray(ns.netclass_patterns)) for (const p of ns.netclass_patterns as { pattern?: unknown }[]) {
    if (p && typeof p.pattern === "string" && p.pattern.startsWith(oldPrefix)) { p.pattern = newPrefix + p.pattern.slice(oldPrefix.length); changed = true; }
  }
  const colors = ns.net_colors as Record<string, unknown> | null | undefined;
  if (colors && typeof colors === "object" && !Array.isArray(colors)) {
    const next: Record<string, unknown> = {}; let any = false;
    for (const [k, v] of Object.entries(colors)) { if (k.startsWith(oldPrefix)) { next[newPrefix + k.slice(oldPrefix.length)] = v; any = true; } else next[k] = v; }
    if (any) { ns.net_colors = next; changed = true; }
  }
  return changed;
}

// ---------------------------------------------------------------- SCINTILLA_TRICKS::DoTextVarAutocomplete
/** The simulation model's session over a placed symbol's fields (SIM_LIB_MGR::CreateModel), before its library is read. */
function simSessionOf(node: SNode, lib: SNode | null): { ses: SimSession<FieldLike>; libraryPath: string } {
  const rows: FieldLike[] = kids(node, "property").map((p) => ({ name: fieldName(p), value: fieldValue(p) }));
  const ref = rows.find((r) => r.name === "Reference");
  let units = 1; if (lib) for (const sub of kids(lib, "symbol")) { const m = /_(\d+)_\d+$/.exec(str(sub[1])); if (m) units = Math.max(units, Number(m[1])); }
  const ses = new SimSession<FieldLike>(rows, { prefix: refPrefix(ref ? ref.value : ""), pins: simPinsOfLib(lib), unitCount: units }, (name, value, show) => ({ name, value, show }), (r) => ({ ...r }));
  return { ses, libraryPath: ses.begin().libraryPath };
}
/** The Sim.Library a symbol's model is read from ("" for a built-in or inferred model). */
export function simLibraryPath(node: SNode, lib: SNode | null): string { return simSessionOf(node, lib).libraryPath; }
/**
 * SCH_FIELD::OnScintillaCharAdded after "${OP:": the pins of the symbol's simulation model (SIM_LIB_MGR::CreateModel,
 * then SIM_MODEL::GetPinNames; an optional pin without its angle brackets), then the synthetic "power" port.
 * `libText` gives the text of the model's Sim.Library (null when it has not been or cannot be read).
 */
export function simModelPorts(node: SNode, lib: SNode | null, libText: (path: string) => string | null): string[] {
  const { ses, libraryPath } = simSessionOf(node, lib);
  ses.finishBegin(libraryPath ? libText(libraryPath) : null);
  const out = ses.curModel().pinNames().map((n) => (n.startsWith("<") && n.endsWith(">") ? n.slice(1, -1) : n));
  out.push("power");
  return out;
}
/** Scintilla's WordStartPosition( pos, onlyWordCharacters = true ): back over letters, digits, '_' and non-ASCII. */
export function wordStart(text: string, pos: number): number {
  let i = Math.max(0, Math.min(pos, text.length));
  while (i > 0 && (/[A-Za-z0-9_]/.test(text[i - 1]) || text.charCodeAt(i - 1) >= 0x80)) i--;
  return i;
}
/**
 * What the caret is completing: after "${" the variable name typed so far (`xref` ""), after "${REF:" the name typed
 * so far with the cross-referenced symbol's reference in `xref`.  null when the caret is in neither.
 */
export function textVarContext(text: string, pos: number): { partial: string; xref: string; start: number } | null {
  const start = wordStart(text, pos), isRef = (p: number): boolean => p >= 2 && text[p - 2] === "$" && text[p - 1] === "{";
  if (start > 1 && text[start - 1] === ":") {
    const refStart = wordStart(text, start - 1);
    return isRef(refStart) ? { partial: text.slice(start, pos), xref: text.slice(refStart, start - 1), start } : null;
  }
  return isRef(start) ? { partial: text.slice(start, pos), xref: "", start } : null;
}
/** DoAutocomplete: the tokens that contain the partial text (without case), in case-insensitive order. */
export function autocompleteMatches(partial: string, tokens: string[]): string[] {
  const f = partial.toLowerCase();
  const cmp = (a: string, b: string): number => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; };
  return tokens.filter((t) => t.toLowerCase().includes(f)).sort(cmp);
}
/** The field names a parent offers as variables: a mandatory field by its untranslated name in capitals, the others as named. */
function fieldVarNames(node: SNode, mandatory: string[], skipPrivate: boolean): string[] {
  const out: string[] = [];
  for (const p of kids(node, "property")) {
    const name = fieldName(p); if (META_FIELD.test(name)) continue;
    if (skipPrivate && str(p[1]) === "private" && p.length > 3 && !isList(p[2])) continue;
    out.push(mandatory.some((m) => m.toLowerCase() === name.replace(/ /g, "").toLowerCase()) ? name.replace(/ /g, "").toUpperCase() : name);
  }
  return out;
}
/** SCH_SYMBOL::GetContextualTextVars. */
export function symbolTextVars(node: SNode): string[] {
  return [...fieldVarNames(node, mandatoryNamesOf("symbol"), true), "OP", "FOOTPRINT_LIBRARY", "FOOTPRINT_NAME", "UNIT", "SHORT_REFERENCE", "SYMBOL_LIBRARY", "SYMBOL_NAME", "SYMBOL_DESCRIPTION",
    "SYMBOL_KEYWORDS", "SYMBOL_IS_POWER", "SYMBOL_IS_LOCAL_POWER", "EXCLUDE_FROM_BOM", "EXCLUDE_FROM_BOARD", "EXCLUDE_FROM_SIM", "DNP", "SHORT_NET_NAME(<pin_number>)", "NET_NAME(<pin_number>)",
    "NET_CLASS(<pin_number>)", "PIN_NAME(<pin_number>)", "REFERENCE(<pin_number>)", "SHORT_REFERENCE(<pin_number>)", "UNIT(<pin_number>)"];
}
/** SCH_LABEL_BASE::GetContextualTextVars. */
export function labelTextVars(kind: string, node: SNode): string[] {
  return [...fieldVarNames(node, mandatoryNamesOf(kind), false), "OP", "CONNECTION_TYPE", "SHORT_NET_NAME", "NET_NAME", "NET_CLASS"];
}
const TITLE_BLOCK_VARS = ["ISSUE_DATE", "CURRENT_DATE", "CURRENT_TIME_LOCALE", "CURRENT_TIME_HH_MM_SS", "REVISION", "TITLE", "COMPANY", "COMMENT1", "COMMENT2", "COMMENT3", "COMMENT4", "COMMENT5", "COMMENT6", "COMMENT7", "COMMENT8", "COMMENT9"];
/**
 * SCH_SHEET::GetContextualTextVars of the sheet at the end of `chain` (the sheet symbols from the top sheet down to it;
 * empty for the root sheet): each sheet's fields, innermost first, then SCHEMATIC::GetContextualTextVars (with the
 * project's text variables) and the sheet's own tokens, each name once.
 */
export function sheetTextVars(chain: SNode[], projectVars: string[]): string[] {
  const out: string[] = [], add = (v: string): void => { if (!out.includes(v)) out.push(v); };
  for (let i = chain.length - 1; i >= 0; i--) for (const v of fieldVarNames(chain[i], mandatoryNamesOf("sheet"), false)) add(v);
  for (const v of ["SHEETNAME", "SHEETFILE"]) add(v);                    // the root sheet's own mandatory fields
  for (const v of ["#", "##", "SHEETPATH", "SHEETNAME", "FILENAME", "FILEPATH", "PROJECTNAME", "VARIANT", "VARIANT_DESC", ...TITLE_BLOCK_VARS, ...projectVars]) add(v);
  for (const v of ["EXCLUDE_FROM_BOM", "EXCLUDE_FROM_BOARD", "EXCLUDE_FROM_SIM", "DNP", "ERC_ERROR <message_text>", "ERC_WARNING <message_text>"]) add(v);
  return out;
}
