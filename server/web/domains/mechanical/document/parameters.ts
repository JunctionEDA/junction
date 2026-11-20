// parameters.ts — every number that drives the part studio as one table: the variables, each feature's number
// fields and each sketch's driving dimensions, with the expression each was typed as, its value, a comment and a
// star.  Onshape has a variable table; the dimensions of features and sketches are found one dialog at a time.
// Here they are rows of one list that can be read, searched and changed in place (ui/ParametersTable.tsx).
//
// Nothing new is stored about the numbers themselves: a row is read from, and written to, where the number
// lives (a variable item, a feature's params with `$expr` / `$unit`, a sketch constraint).  What people say
// about a number is one item:
//
//   { id: "parameter-notes", type: "parameter-notes", comments: { "<row key>": "…" }, favourites: { "<row key>": true } }
//
// keyed by row, so two people annotating different numbers both win.  A row's key is `v:<variable id>`,
// `f:<feature id>:<param key>` or `d:<feature id>:<constraint id>`.  Pure.
import type { Item, ItemChange, ItemDoc, JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { ParamField } from "../core/feature";
import type { SketchData } from "../sketch/format";
import { setParams } from "./edits";
import { featuresOf, type FeatureItem } from "./format";
import { DEFAULT_UNITS, fieldText, fieldUnit, parseField, quantityOf, type Quantity, type Units } from "./units";
import { EXPR_KEY, UNIT_KEY, exprUnitsOf, exprsOf, isVariable, lookupOf, nameProblem, setVariable, variableValues, variablesOf } from "./variables";

export const NOTES_ID = "parameter-notes";
export interface NotesItem extends Item { type: "parameter-notes"; comments?: { [key: string]: string }; favourites?: { [key: string]: boolean } }

export interface ParamRow {
  key: string;
  kind: "variable" | "feature" | "dimension";
  /** what it belongs to: "Variables", or the feature's name */
  owner: string; ownerId: string;
  /** the variable's name, the field's label, or what a dimension measures ("distance d1") */
  label: string;
  /** what is typed: the expression when there is one, else the number in the document's unit */
  text: string;
  /** in millimetres or degrees (a plain number as it is); null when it has no value */
  value: number | null;
  quantity: Quantity;
  /** the unit shown after the value ("mm", "°", "") */
  unit: string;
  expression: boolean;
  comment: string; favourite: boolean;
  /** why it has no value (a variable that cannot be worked out) */
  error?: string;
  /** not built: the feature is suppressed (the row can still be changed) */
  suppressed?: boolean;
}

export type SchemaOf = (featureType: string) => readonly ParamField[] | undefined;
const DIMENSIONS = new Set(["distance", "radius", "diameter", "angle"]);
const sketchOf = (f: FeatureItem): SketchData | null => { const s = f.params.sketch as unknown as SketchData | undefined; return f.featureType === "sketch" && s && typeof s === "object" && s.constraints ? s : null; };
const notesOf = (doc: ItemDoc): NotesItem | null => { const n = doc.items.get(NOTES_ID); return n && n.type === NOTES_ID ? (n as NotesItem) : null; };

/** Every row, in the order a person meets them: the variables, then the features in build order. */
export function parameterRows(doc: ItemDoc | null, schemaOf: SchemaOf, u: Units = DEFAULT_UNITS): ParamRow[] {
  if (!doc) return [];
  const notes = notesOf(doc), comments = notes?.comments || {}, favourites = notes?.favourites || {};
  const note = (key: string) => ({ comment: typeof comments[key] === "string" ? comments[key] : "", favourite: favourites[key] === true });
  const rows: ParamRow[] = [];
  const vars = variablesOf(doc), vv = variableValues(vars);
  for (const v of vars) {
    const key = `v:${v.id}`, value = vv.values.get(v.name), dim = vv.dims.get(v.name) === 1;
    rows.push({ key, kind: "variable", owner: "Variables", ownerId: "", label: v.name, text: v.expr, value: value === undefined ? null : value, quantity: dim ? "length" : "none", unit: dim ? u.length : "", expression: true, error: vv.errors.get(v.id), ...note(key) });
  }
  for (const f of featuresOf(doc)) {
    const exprs = exprsOf(f.params);
    for (const field of schemaOf(f.featureType) || []) {
      if (field.kind !== "number" || (field.visible && !field.visible(f.params as never))) continue;
      const v = f.params[field.key]; if (typeof v !== "number") continue;
      const key = `f:${f.id}:${field.key}`, q = quantityOf(field.unit), expr = exprs[field.key];
      rows.push({ key, kind: "feature", owner: f.name, ownerId: f.id, label: field.label, text: expr ?? fieldText(v, q, u), value: v, quantity: q, unit: fieldUnit(q, u), expression: expr !== undefined, suppressed: !!f.suppressed || undefined, ...note(key) });
    }
    const sk = sketchOf(f);
    if (sk) for (const id of Object.keys(sk.constraints).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      const c = sk.constraints[id];
      if (!c || !DIMENSIONS.has(c.type) || typeof c.value !== "number" || c.driving === false) continue;
      const key = `d:${f.id}:${id}`, q: Quantity = c.type === "angle" ? "angle" : "length";
      rows.push({ key, kind: "dimension", owner: f.name, ownerId: f.id, label: `${c.type} ${id}`, text: typeof c.expr === "string" && c.expr ? c.expr : fieldText(c.value, q, u), value: c.value, quantity: q, unit: fieldUnit(q, u), expression: typeof c.expr === "string" && !!c.expr, suppressed: !!f.suppressed || undefined, ...note(key) });
    }
  }
  return rows;
}

/** The rows a search leaves: every word in the owner, the label, the expression or the comment. */
export function filterRows(rows: readonly ParamRow[], query: string, favouritesOnly = false): ParamRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => (!favouritesOnly || r.favourite) && words.every((w) => `${r.owner} ${r.label} ${r.text} ${r.comment}`.toLowerCase().includes(w)));
}

export type ParamEdit =
  | { ok: true; changes: ItemChange[] }
  /** a sketch dimension: the sketch must be solved with the new value before it is stored (the document keeps solved coordinates) */
  | { ok: true; solve: { featureId: string; constraint: string; data: SketchData } }
  | { ok: false; error: string };

/** What typing `text` into a row's expression does. */
export function editParameter(doc: ItemDoc, key: string, text: string, schemaOf: SchemaOf, u: Units = DEFAULT_UNITS): ParamEdit {
  const [kind, a, ...rest] = key.split(":"), b = rest.join(":");
  const t = text.trim();
  if (!t) return { ok: false, error: "Type a number or an expression." };
  const vars = variablesOf(doc);
  if (kind === "v") {
    const v = doc.items.get(a);
    if (!isVariable(v)) return { ok: false, error: "That variable no longer exists." };
    // the variable as it would be: it must come to a number, and may not end up needing itself
    const after = variableValues(vars.map((x) => (x.id === a ? { ...x, expr: t } : x)));
    if (after.errors.has(a)) return { ok: false, error: after.errors.get(a)! };
    return { ok: true, changes: setVariable(doc, a, { expr: t }) };
  }
  const f = doc.items.get(a) as FeatureItem | undefined;
  if (!f || f.type !== "feature") return { ok: false, error: "That feature no longer exists." };
  const lookup = lookupOf(variableValues(vars));
  if (kind === "f") {
    const field = (schemaOf(f.featureType) || []).find((x) => x.key === b);
    if (!field || field.kind !== "number") return { ok: false, error: "That parameter no longer exists." };
    const q = quantityOf(field.unit), r = parseField(t, q, u, lookup);
    if (!r || !Number.isFinite(r.value)) return { ok: false, error: "That does not come to a number." };
    if (field.min !== undefined && r.value < field.min - 1e-9) return { ok: false, error: `${field.label} must be at least ${fieldText(field.min, q, u)}.` };
    if (field.max !== undefined && r.value > field.max + 1e-9) return { ok: false, error: `${field.label} must be at most ${fieldText(field.max, q, u)}.` };
    // as the feature's own dialog stores it: the number, the text when it is more than a number, and the unit its bare numbers were typed in
    const exprs = { ...exprsOf(f.params) }, units = { ...exprUnitsOf(f.params) };
    delete exprs[b]; delete units[b];
    if (r.isExpression) { exprs[b] = t; const unit = q === "length" ? u.length : q === "angle" ? u.angle : ""; if (unit && unit !== "mm" && unit !== "deg") units[b] = unit; }
    const params: JsonObject = { ...f.params, [b]: r.value };
    if (Object.keys(exprs).length) params[EXPR_KEY] = exprs; else delete params[EXPR_KEY];
    if (Object.keys(units).length) params[UNIT_KEY] = units; else delete params[UNIT_KEY];
    return { ok: true, changes: setParams(doc, a, params) };
  }
  if (kind === "d") {
    const sk = sketchOf(f), c = sk?.constraints[b];
    if (!sk || !c || typeof c.value !== "number") return { ok: false, error: "That dimension no longer exists." };
    const q: Quantity = c.type === "angle" ? "angle" : "length", r = parseField(t, q, u, lookup);
    if (!r || !Number.isFinite(r.value)) return { ok: false, error: "That does not come to a number." };
    if (c.type !== "angle" && !(r.value > 0)) return { ok: false, error: "A dimension must be more than zero." };
    const next = { ...c, value: r.value } as typeof c;
    if (r.isExpression) next.expr = t; else delete next.expr;
    return { ok: true, solve: { featureId: a, constraint: b, data: { ...sk, constraints: { ...sk.constraints, [b]: next } } } };
  }
  return { ok: false, error: "That row cannot be changed." };
}

/** Store a sketch as the solver left it (after `editParameter` asked for a solve). */
export function storeSolvedSketch(doc: ItemDoc, featureId: string, data: SketchData): ItemChange[] {
  const f = doc.items.get(featureId) as FeatureItem | undefined;
  return f && f.type === "feature" ? setParams(doc, featureId, { ...f.params, sketch: data as unknown as JsonObject }) : [];
}

/** A comment on a row ("" removes it), or its star. */
export function setParamNote(doc: ItemDoc, key: string, patch: { comment?: string; favourite?: boolean }): ItemChange[] {
  const notes = notesOf(doc);
  const comment = patch.comment === undefined ? undefined : patch.comment.trim().slice(0, 500);
  if (!notes) {
    const item: NotesItem = { id: NOTES_ID, type: NOTES_ID, comments: comment ? { [key]: comment } : {}, favourites: patch.favourite ? { [key]: true } : {} };
    return comment || patch.favourite ? [{ id: NOTES_ID, kind: "ADDED", typeName: NOTES_ID, item }] : [];
  }
  const props: { path: string[]; value?: string | boolean; del?: boolean }[] = [];
  if (comment !== undefined && comment !== ((notes.comments || {})[key] || "")) props.push(comment ? { path: ["comments", key], value: comment } : { path: ["comments", key], del: true });
  if (patch.favourite !== undefined && patch.favourite !== ((notes.favourites || {})[key] === true)) props.push(patch.favourite ? { path: ["favourites", key], value: true } : { path: ["favourites", key], del: true });
  return props.length ? [{ id: NOTES_ID, kind: "MODIFIED", typeName: NOTES_ID, props }] : [];
}

/** Why a new variable cannot have this name, or null. */
export const variableNameProblem = (doc: ItemDoc, name: string, but?: string): string | null => nameProblem(name, variablesOf(doc).filter((v) => v.id !== but).map((v) => v.name));
