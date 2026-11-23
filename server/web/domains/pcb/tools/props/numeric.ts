// props/numeric.ts — numeric input (libs/kimath NUMERIC_EVALUATOR)
// What KiCad's unit-aware text fields accept: + - * / and parentheses over numbers that may carry a unit
// (mm, cm, um / µm, in / ", mil / mils / thou; ° / deg for angles).  A number without a unit is in
// `defUnit` ("mm" | "in" | "mil"; "" for plain numbers, where a unit is an error).  Returns millimetres
// (or the plain number), NaN when the text does not parse.
import { r6, str } from "./sexpr";
import { stringFromValue, type IuScale } from "../../../../shared/units";

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, um: 0.001, "µm": 0.001, "in": 25.4, '"': 25.4, inch: 25.4, mil: 0.0254, mils: 0.0254, thou: 0.0254 };
/**
 * Evaluate the text.  NUMERIC_EVALUATOR's grammar (common/libeval/grammar.lemon) also has variables and statements:
 * `x = 2; x * 3` assigns x (an assignment has no value of its own) and the result is the last statement's; a
 * statement ended by ';' gives no result, an unknown variable is an error.  The variables live in `vars`, kept by
 * the caller for one field the way each UNIT_BINDER keeps its own evaluator (a fresh map when none is given).
 */
export function evalExpr(text: unknown, defUnit?: string, vars: Map<string, number> = new Map()): number {
  const src = str(text).trim().replace(/,/g, "."); if (!src) return NaN;
  const scale = defUnit ? (UNIT_MM[defUnit] || 1) : 1;
  let i = 0, bad = false;
  // the grammar's `valid` flag: a value, a variable, a unary or binary operator takes its (right) operand's; an
  // assignment is not valid.  The operand evaluated last decides, so one flag follows the recursion.
  let valid = true;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const ident = (): string | null => { const m = /^[A-Za-z][A-Za-z0-9]*/.exec(src.slice(i)); return m ? m[0] : null; };
  const UNIT_RE = /^(mm|cm|um|µm|inch|in|"|mils|mil|thou|°|deg)(?![A-Za-z0-9])/i;
  function primary(): number {
    ws();
    if (src[i] === "(") { i++; const v = expr(); ws(); if (src[i] !== ")") return NaN; i++; return v; }
    if (src[i] === "-") { i++; return -primary(); }
    if (src[i] === "+") { i++; return primary(); }
    const id = UNIT_RE.test(src.slice(i)) ? null : ident();
    if (id) {
      // VAR (GetVar: an unknown name is a parse error); a unit after it converts like after a number
      i += id.length; valid = true;
      const has = vars.has(id); if (!has) bad = true;
      let v = has ? vars.get(id)! : 0;
      ws(); const u = UNIT_RE.exec(src.slice(i));
      if (u) { i += u[0].length; const key = u[0].toLowerCase(); if (key === "°" || key === "deg") return defUnit ? NaN : v; if (!defUnit) return NaN; v = (v / scale) * UNIT_MM[key]; }
      return v;
    }
    const m = /^(\d+\.?\d*(?:e[-+]?\d+)?|\.\d+(?:e[-+]?\d+)?)/i.exec(src.slice(i)); if (!m) return NaN;
    i += m[0].length; let v = parseFloat(m[0]); valid = true;
    ws();
    const u = /^(mm|cm|um|µm|inch|in|"|mils|mil|thou|°|deg)/i.exec(src.slice(i));
    if (u) {
      i += u[0].length; const key = u[0].toLowerCase();
      if (key === "°" || key === "deg") return defUnit ? NaN : v;
      if (!defUnit) return NaN;
      return v * UNIT_MM[key];
    }
    return v * scale;
  }
  // a product of two lengths would be an area: only the first unit-carrying factor is scaled, later bare
  // factors are plain multipliers ("2 * 1.5" in mm is 3 mm, as NUMERIC_EVALUATOR treats it)
  function product(): number {
    let v = primary();
    for (;;) {
      ws(); const op = src[i]; if (op !== "*" && op !== "/") return v;
      i++; const r = primary() / scale;
      v = op === "*" ? v * r : v / r;
    }
  }
  function sum(): number {
    let v = product();
    for (;;) { ws(); const op = src[i]; if (op !== "+" && op !== "-") return v; i++; const r = product(); v = op === "+" ? v + r : v - r; }
  }
  // expr ::= VAR ASSIGN expr (the lowest precedence, not associative)
  function expr(): number {
    ws(); const id = UNIT_RE.test(src.slice(i)) ? null : ident();
    if (id) {
      const save = i; i += id.length; ws();
      if (src[i] === "=") { i++; const v = sum(); vars.set(id, v); valid = false; return v; }
      i = save;
    }
    return sum();
  }
  // in ::= stmt | in stmt;  stmt ::= ENDS | expr ENDS | expr SEMCOL
  let out = NaN;
  for (;;) {
    const v = expr(); ws();
    if (bad || !isFinite(v)) return NaN;
    if (src[i] === ";") { i++; out = NaN; ws(); if (i >= src.length) return NaN; continue; }
    if (i < src.length) return NaN;
    out = valid ? v : NaN;
    break;
  }
  return isFinite(out) ? r6(out) : NaN;
}
/**
 * A millimetre length as KiCad's property grid shows it in the given units: "1.27 mm", "50 mils", "0.05 in"
 * (EDA_UNIT_UTILS::UI::StringFromValue in the editor's internal-unit scale).
 */
export function formatLength(v: number, unit?: string, scale: IuScale = "pcb"): string {
  return stringFromValue(v, unit === "in" || unit === "mil" ? unit : "mm", scale, true);
}
