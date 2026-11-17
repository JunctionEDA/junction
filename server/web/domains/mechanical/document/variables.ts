// variables.ts — variables of a part studio, and the expressions that use them.
//
// A variable is an item of the `.jpart` (CONTRACT.md "Unknown items": an older reader keeps it):
//
//   { id, type: "variable", name: "width", expr: "40 mm + 2 * wall", order }
//
// Any number field of a feature can hold an expression instead of a number.  The feature's params keep the
// number (so every reader, and the kernel, sees a plain value) and the text it came from, under the reserved
// key `$expr`:
//
//   params: { depth: 12.5, $expr: { depth: "width / 4 + 2.5" } }
//
// Before the features go to the worker, the page evaluates every `$expr` again with the current variables
// (`resolveInputs`), so a model always follows its variables, even when a stored number is stale.  Editing a
// variable also rewrites the stored numbers that depend on it, in the same change, so the file stays true.
//
// Expressions: numbers with optional units (mm, cm, m, in, ft for lengths, all turned into millimetres; deg and
// rad for angles, turned into degrees), + − × ÷ ^ and brackets, variables by name, the constant pi, and
// sin cos tan (of degrees), asin acos atan atan2 (in degrees), sqrt abs min max floor ceil round.
import { addedChange, byOrder, newId, orderBetween, removedChange, type Item, type ItemChange, type ItemDoc, type JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { FeatureInput } from "../kernel/protocol";
import { isFeature } from "./format";

export const VARIABLE_TYPE = "variable";
/** The params key that holds the expressions a feature's numbers were typed as. */
export const EXPR_KEY = "$expr";

export interface VariableItem extends Item { type: "variable"; name: string; expr: string; order: string }

export const isVariable = (i: Item | undefined): i is VariableItem => !!i && i.type === VARIABLE_TYPE && typeof i.name === "string";

export function variablesOf(doc: ItemDoc): VariableItem[] {
  const out: VariableItem[] = [];
  for (const i of doc.items.values()) if (isVariable(i)) out.push(i);
  return byOrder(out);
}

// ---------------------------------------------------------------- expressions

export class ExprError extends Error {}

const UNITS: { [u: string]: number } = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, deg: 1, rad: 180 / Math.PI };
const D2R = Math.PI / 180;
const FUNCS: { [f: string]: (...a: number[]) => number } = {
  sin: (x) => Math.sin(x * D2R), cos: (x) => Math.cos(x * D2R), tan: (x) => Math.tan(x * D2R),
  asin: (x) => Math.asin(x) / D2R, acos: (x) => Math.acos(x) / D2R, atan: (x) => Math.atan(x) / D2R, atan2: (y, x) => Math.atan2(y, x) / D2R,
  sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round,
};
const CONSTS: { [c: string]: number } = { pi: Math.PI };

type Token = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokens(text: string): Token[] {
  const out: Token[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[-+*/^(),×÷]))/y;
  let i = 0;
  while (i < text.length) {
    if (/^\s*$/.test(text.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) throw new ExprError(`I do not understand “${text.slice(i).trim().slice(0, 12)}”.`);
    i = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: "id", v: m[2] });
    else out.push({ t: "op", v: m[3] === "**" ? "^" : m[3] === "×" ? "*" : m[3] === "÷" ? "/" : m[3] });
  }
  return out;
}

/** The variable names an expression mentions (for dependencies and renames). */
export function namesIn(text: string): string[] {
  try { return Array.from(new Set(tokens(text).filter((t) => t.t === "id" && !FUNCS[t.v] && !CONSTS[t.v] && !(t.v in UNITS)).map((t) => t.v as string))); } catch (e) { return []; }
}

/** Evaluate an expression.  `lookup` gives a variable's value, or undefined when there is none by that name. */
export function evaluate(text: string, lookup: (name: string) => number | undefined = () => undefined): number {
  const ts = tokens(String(text));
  if (!ts.length) throw new ExprError("The expression is empty.");
  let i = 0;
  const peek = () => ts[i];
  const isOp = (v: string) => { const t = ts[i]; return !!t && t.t === "op" && t.v === v; };
  const expect = (v: string) => { if (!isOp(v)) throw new ExprError(`Expected “${v}”.`); i++; };
  const expr = (): number => {
    let v = term();
    while (isOp("+") || isOp("-")) { const op = (ts[i++] as { v: string }).v; const r = term(); v = op === "+" ? v + r : v - r; }
    return v;
  };
  const term = (): number => {
    let v = unary();
    while (isOp("*") || isOp("/")) {
      const op = (ts[i++] as { v: string }).v; const r = unary();
      if (op === "/" && r === 0) throw new ExprError("The expression divides by zero.");
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const unary = (): number => {
    if (isOp("-")) { i++; return -unary(); }
    if (isOp("+")) { i++; return unary(); }
    return power();
  };
  const power = (): number => {
    const b = postfix();
    if (isOp("^")) { i++; return Math.pow(b, unary()); }
    return b;
  };
  const postfix = (): number => {
    const t = peek();
    if (!t) throw new ExprError("The expression ends too soon.");
    let v: number;
    if (t.t === "num") {
      i++; v = t.v;
      const u = peek();
      if (u && u.t === "id" && u.v in UNITS) { i++; v *= UNITS[u.v]; }
      return v;
    }
    if (t.t === "id") {
      i++;
      if (isOp("(")) {
        const f = FUNCS[t.v];
        if (!f) throw new ExprError(`There is no function called “${t.v}”.`);
        i++;
        const args: number[] = [];
        if (!isOp(")")) { args.push(expr()); while (isOp(",")) { i++; args.push(expr()); } }
        expect(")");
        return f(...args);
      }
      const known = lookup(t.v);
      if (known !== undefined) return known;
      if (t.v in CONSTS) return CONSTS[t.v];
      throw new ExprError(`There is no variable called “${t.v}”.`);
    }
    if (t.v === "(") { i++; v = expr(); expect(")"); return v; }
    throw new ExprError(`Unexpected “${t.v}”.`);
  };
  const v = expr();
  if (i < ts.length) throw new ExprError(`Unexpected “${(ts[i] as { v: unknown }).v}”.`);
  if (!Number.isFinite(v)) throw new ExprError("The expression has no finite value.");
  return v;
}

/** A plain number typed as text, as opposed to an expression. */
export const isPlainNumber = (text: string): boolean => /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(text);

/** A name a variable may have: a letter or _, then letters, digits and _; not a function, unit or constant. */
export function nameProblem(name: string, taken: readonly string[] = []): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return "A name starts with a letter and has only letters, digits and _.";
  if (FUNCS[name] || CONSTS[name] || name in UNITS) return `“${name}” is a function, unit or constant.`;
  if (taken.includes(name)) return `There is already a variable called “${name}”.`;
  return null;
}

export interface VariableValues {
  values: Map<string, number>;
  /** variable id → why it has no value */
  errors: Map<string, string>;
}

/** Every variable's value.  A variable may use any other; a cycle is an error on each variable in it. */
export function variableValues(vars: readonly VariableItem[]): VariableValues {
  const byName = new Map<string, VariableItem>();
  const errors = new Map<string, string>();
  for (const v of vars) { if (byName.has(v.name)) errors.set(v.id, `There is already a variable called “${v.name}”.`); else byName.set(v.name, v); }
  const values = new Map<string, number>();
  const visiting = new Set<string>();
  const value = (name: string): number | undefined => {
    if (values.has(name)) return values.get(name);
    const v = byName.get(name);
    if (!v) return undefined;
    if (errors.has(v.id)) throw new ExprError(`“${name}” has no value.`);
    if (visiting.has(name)) throw new ExprError(`“${name}” is defined in terms of itself.`);
    visiting.add(name);
    try { const x = evaluate(v.expr, value); values.set(name, x); return x; }
    catch (e) { errors.set(v.id, e instanceof Error ? e.message : String(e)); throw new ExprError(`“${name}” has no value.`); }
    finally { visiting.delete(name); }
  };
  for (const v of byName.values()) { try { value(v.name); } catch (e) { /* recorded */ } }
  return { values, errors };
}

/** The expressions stored with a feature's params (key → text). */
export function exprsOf(params: JsonObject | undefined): { [key: string]: string } {
  const e = params && params[EXPR_KEY];
  return e && typeof e === "object" && !Array.isArray(e) ? (e as { [key: string]: string }) : {};
}

/** The features with every expression evaluated again; a feature whose expression fails keeps its stored number. */
export function resolveInputs(inputs: FeatureInput[], values: ReadonlyMap<string, number>): FeatureInput[] {
  const lookup = (n: string) => values.get(n);
  return inputs.map((f) => {
    const ex = exprsOf(f.params);
    const keys = Object.keys(ex);
    if (!keys.length) return f;
    const params: JsonObject = { ...f.params };
    for (const key of keys) { try { params[key] = evaluate(ex[key], lookup); } catch (e) { /* keep the stored number */ } }
    return { ...f, params };
  });
}

// ---------------------------------------------------------------- edits (changes only; commit them with studio.commit)

/** Changes that add a variable at the end of the list. */
export function addVariable(doc: ItemDoc, name: string, expr: string): { changes: ItemChange[]; variable: VariableItem } {
  const vars = variablesOf(doc);
  const variable: VariableItem = { id: newId(), type: "variable", name, expr, order: orderBetween(vars.length ? vars[vars.length - 1].order : null, null) };
  return { changes: [addedChange(variable)], variable };
}

/** A name not taken yet: "v1", "v2", … */
export function freeName(doc: ItemDoc, stem = "v"): string {
  const taken = new Set(variablesOf(doc).map((v) => v.name));
  for (let n = 1; ; n++) if (!taken.has(`${stem}${n}`)) return `${stem}${n}`;
}

const renameIn = (text: string, from: string, to: string) => text.replace(new RegExp(`(^|[^A-Za-z0-9_])${from}(?![A-Za-z0-9_])`, "g"), (_m, pre) => `${pre}${to}`);

/**
 * Change a variable's name and/or expression.  A rename is carried into every expression that used the old name;
 * either way, the stored numbers of features that depend on the variable are brought up to date.
 */
export function setVariable(doc: ItemDoc, id: string, patch: { name?: string; expr?: string }): ItemChange[] {
  const v = doc.items.get(id);
  if (!isVariable(v)) return [];
  const out: ItemChange[] = [];
  const props: { path: string[]; value: string }[] = [];
  const name = patch.name !== undefined ? patch.name.trim() : v.name;
  const expr = patch.expr !== undefined ? patch.expr : v.expr;
  if (name !== v.name) props.push({ path: ["name"], value: name });
  if (expr !== v.expr) props.push({ path: ["expr"], value: expr });
  if (!props.length) return [];
  out.push({ id, kind: "MODIFIED", typeName: VARIABLE_TYPE, props });
  const renamed = name !== v.name;
  // the variables as they will be, with the rename carried into the others' expressions
  const vars = variablesOf(doc).map((x) => {
    if (x.id === id) return { ...x, name, expr };
    if (renamed && namesIn(x.expr).includes(v.name)) {
      const next = renameIn(x.expr, v.name, name);
      out.push({ id: x.id, kind: "MODIFIED", typeName: VARIABLE_TYPE, props: [{ path: ["expr"], value: next }] });
      return { ...x, expr: next };
    }
    return x;
  });
  const { values } = variableValues(vars);
  for (const item of doc.items.values()) {
    if (!isFeature(item)) continue;
    const ex = exprsOf(item.params);
    const fprops: { path: string[]; value: JsonObject[string] }[] = [];
    for (const key of Object.keys(ex)) {
      let text = ex[key];
      if (renamed && namesIn(text).includes(v.name)) { text = renameIn(text, v.name, name); fprops.push({ path: ["params", EXPR_KEY, key], value: text }); }
      try { const n = evaluate(text, (x) => values.get(x)); if (n !== item.params[key]) fprops.push({ path: ["params", key], value: n }); } catch (e) { /* leave the stored number */ }
    }
    if (fprops.length) out.push({ id: item.id, kind: "MODIFIED", typeName: "feature", props: fprops });
  }
  return out;
}

export function deleteVariable(doc: ItemDoc, id: string): ItemChange[] {
  const v = doc.items.get(id);
  return isVariable(v) ? [removedChange(v)] : [];
}

/** Which features use a variable (by name), for the panel. */
export function usersOf(doc: ItemDoc, name: string): string[] {
  const out: string[] = [];
  for (const item of doc.items.values()) {
    if (isFeature(item) && Object.values(exprsOf(item.params)).some((t) => namesIn(t).includes(name))) out.push(item.id);
  }
  return out;
}
