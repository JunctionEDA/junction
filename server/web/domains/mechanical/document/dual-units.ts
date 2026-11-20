// dual-units.ts — a second unit after every length the part studio writes: "25.4 mm [1 in]".  A drawing made in
// millimetres for a shop that works in inches, or the other way round, is read without a calculator.  It is how
// one person reads the document (a preference, ui/prefs.ts `dualUnit`), not the document's units: nothing is
// stored, and what is typed still means the document's unit.  Sketch dimensions (sketch/dims.ts) and the measure
// readout (inspect/measure-format.ts) ask here.
import { LENGTH_UNITS, lengthFactor, num, type LengthUnit, type Units } from "./units";

const PREFS = "junction.cad.prefs";
let dual: LengthUnit | "" | null = null;   // null: not read yet

const isUnit = (u: unknown): u is LengthUnit => LENGTH_UNITS.some((x) => x.id === u);
/** The second unit ("" for none).  Read from the person's preferences the first time it is asked for. */
export function dualUnit(): LengthUnit | "" {
  if (dual === null) {
    dual = "";
    try { const v = JSON.parse((typeof localStorage === "undefined" ? null : localStorage.getItem(PREFS)) || "{}"); if (v && isUnit(v.dualUnit)) dual = v.dualUnit; } catch { /* no storage: none */ }
  }
  return dual as LengthUnit | "";
}
export function setDualUnit(u: string): void { dual = isUnit(u) ? u : ""; }

/** How many places a length in the second unit gets: as fine as the first unit's places are, in that unit. */
export function dualPlaces(primary: Units, second: LengthUnit): number {
  const fine = lengthFactor(primary.length) / Math.pow(10, primary.places);   // the smallest step shown, in mm
  return Math.max(0, Math.min(6, Math.ceil(-Math.log10(fine / lengthFactor(second)) - 1e-9)));
}

/** " [1 in]" for a length in millimetres, or "" when there is no second unit or it is the document's own. */
export function dualSuffix(mm: number, primary: Units, second: LengthUnit | "" = dualUnit()): string {
  if (!second || second === primary.length || !Number.isFinite(mm)) return "";
  return ` [${num(mm / lengthFactor(second), dualPlaces(primary, second))} ${second}]`;
}
