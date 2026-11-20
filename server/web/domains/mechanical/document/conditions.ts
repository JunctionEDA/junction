// conditions.ts — the yes-or-no expressions of dynamic suppression: "#depth < 12 mm", "holes == 0 || !(wall > 2)".
//
// A condition compares two expressions of document/variables.ts (numbers with units, variables, functions) with
// <  <=  >  >=  ==  != , and joins comparisons with && (and), || (or), ! (not) and brackets.  An expression on
// its own is true when it is not zero; `true` and `false` are themselves.  A bare number beside a quantity is
// in millimetres (or degrees), as everywhere in a document.
import { ExprError, evaluateDim, type Lookup } from "./variables";

/** `text` cut at every `op` that is outside brackets. */
function splitTop(text: string, op: string): string[] {
  const out: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (!depth && text.startsWith(op, i)) { out.push(text.slice(from, i)); from = i + op.length; i += op.length - 1; }
  }
  out.push(text.slice(from));
  return out;
}

const COMPARE: { [op: string]: (a: number, b: number) => boolean } = {
  "<=": (a, b) => a <= b + 1e-9, ">=": (a, b) => a >= b - 1e-9, "==": (a, b) => Math.abs(a - b) <= 1e-9, "!=": (a, b) => Math.abs(a - b) > 1e-9,
  "<": (a, b) => a < b - 1e-9, ">": (a, b) => a > b + 1e-9, "=": (a, b) => Math.abs(a - b) <= 1e-9,
};
const OPS = ["<=", ">=", "==", "!=", "<", ">", "="];

/** The first comparison outside brackets: where it is and which. */
function comparisonIn(text: string): { at: number; op: string } | null {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (!depth) for (const op of OPS) if (text.startsWith(op, i)) return { at: i, op };
  }
  return null;
}

/** Is the whole text one pair of brackets? */
function wrapped(text: string): boolean {
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) { if (text[i] === "(") depth++; else if (text[i] === ")" && --depth === 0 && i < text.length - 1) return false; }
  return depth === 0;
}

/** Is the condition true?  Throws ExprError (document/variables.ts) with a sentence when it cannot be read. */
export function evaluateCondition(text: string, lookup: Lookup = () => undefined): boolean {
  const t = String(text).trim();
  if (!t) throw new ExprError("The condition is empty.");
  const ors = splitTop(t, "||");
  if (ors.length > 1) { let any = false; for (const part of ors) if (evaluateCondition(part, lookup)) any = true; return any; }
  const ands = splitTop(t, "&&");
  if (ands.length > 1) { let all = true; for (const part of ands) if (!evaluateCondition(part, lookup)) all = false; return all; }
  if (t.startsWith("!") && !t.startsWith("!=")) return !evaluateCondition(t.slice(1), lookup);
  const cmp = comparisonIn(t);
  if (cmp) {
    const left = t.slice(0, cmp.at).trim(), right = t.slice(cmp.at + cmp.op.length).trim();
    if (!left || !right) throw new ExprError(`“${cmp.op}” needs a value on both sides.`);
    if (comparisonIn(right)) throw new ExprError("Join two comparisons with && or ||.");
    return COMPARE[cmp.op](evaluateDim(left, lookup, 1).v, evaluateDim(right, lookup, 1).v);
  }
  if (wrapped(t)) return evaluateCondition(t.slice(1, -1), lookup);
  if (t === "true") return true;
  if (t === "false") return false;
  return Math.abs(evaluateDim(t, lookup, 1).v) > 1e-12;
}

/** Why a condition cannot be read (null: it can). */
export function conditionProblem(text: string, lookup: Lookup = () => undefined): string | null {
  try { evaluateCondition(text, lookup); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
