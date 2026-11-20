// _cf-geo-measured.ts — writing what Measure to variable features measured into the document's variables
// (features/cf-geo-measure.ts measures; tools/cf-geo-measure-sync.ts calls this after each regeneration).  Pure:
// it reads the document and returns the changes to commit.
import { addedChange, orderBetween, type ItemChange, type ItemDoc } from "../../../shared/itemdoc/itemdoc";
import { addVariable, setVariable, variableValues, variablesOf } from "../document/variables";

export interface MeasuredValue { name: string; value: number; unit: string }

/** The text a measured value is stored as: a length and an angle with their unit, an area or volume as a number. */
export function measuredText(m: MeasuredValue): string {
  const v = Number(m.value.toFixed(6));
  return m.unit === "mm" ? `${v} mm` : m.unit === "deg" ? `${v} deg` : String(v);
}

/**
 * The changes that bring the variables up to date with the measurements: a variable that is missing is added,
 * one whose value differs is rewritten, and one that already has the value is left alone (so a regeneration
 * that measures the same thing changes nothing, and the page settles).
 */
export function measuredChanges(doc: ItemDoc, measured: readonly MeasuredValue[]): ItemChange[] {
  const out: ItemChange[] = [];
  const vars = variablesOf(doc), values = variableValues(vars).values, seen = new Set<string>();
  let last: string | null = vars.length ? vars[vars.length - 1].order : null;   // new variables go after the last, one after another
  for (const m of measured) {
    if (!m || typeof m.name !== "string" || !Number.isFinite(m.value) || seen.has(m.name)) continue;
    seen.add(m.name);
    const have = vars.find((v) => v.name === m.name), text = measuredText(m);
    if (!have) {
      const made = addVariable(doc, m.name, text).variable;
      last = made.order = orderBetween(last, null);
      out.push(addedChange(made));
      continue;
    }
    const now = values.get(m.name);
    if (have.expr === text || (now !== undefined && Math.abs(now - m.value) <= 5e-7 * Math.max(1, Math.abs(m.value)))) continue;
    out.push(...setVariable(doc, have.id, { expr: text }));
  }
  return out;
}
