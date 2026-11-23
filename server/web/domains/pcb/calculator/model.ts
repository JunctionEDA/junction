// calculator/model.ts — the formulas and tables of KiCad's Calculator Tools (pcb_calculator/calculator_panels), in SI
// units (metres, amperes, ohms, seconds) as the panels normalise them with UNIT_SELECTOR::GetUnitScale.  No DOM.

/** units_scales.h: a unit to metres (or hertz) */
export const UNIT = { m: 1, cm: 1e-2, mm: 1e-3, um: 1e-6, inch: 2.54e-2, mil: 2.54e-5, ozsqft: 34.40e-6, GHz: 1e9, MHz: 1e6, kHz: 1e3, Hz: 1 } as const;
/** UNIT_SELECTOR_LEN and UNIT_SELECTOR_THICKNESS choices: [label, scale] */
export const LEN_UNITS: [string, number][] = [["mm", UNIT.mm], ["um", UNIT.um], ["cm", UNIT.cm], ["mil", UNIT.mil], ["inch", UNIT.inch]];
export const THICKNESS_UNITS: [string, number][] = [["mm", UNIT.mm], ["µm", UNIT.um], ["cm", UNIT.cm], ["mil", UNIT.mil], ["inch", UNIT.inch], ["oz/ft²", UNIT.ozsqft]];
export const FREQ_UNITS: [string, number][] = [["GHz", UNIT.GHz], ["MHz", UNIT.MHz], ["kHz", UNIT.kHz], ["Hz", UNIT.Hz]];
/** UNIT_SELECTOR_LEN_CABLE: cm, m, km, inch, feet (UNIT_FEET 0.3048) */
export const LEN_CABLE_UNITS: [string, number][] = [["cm", UNIT.cm], ["m", UNIT.m], ["km", 1e3], ["inch", UNIT.inch], ["feet", 0.3048]];
/** UNIT_SELECTOR_TIME: ns, ps */
export const TIME_UNITS: [string, number][] = [["ns", 1e-9], ["ps", 1e-12]];
/** UNIT_SELECTOR_SPEED: m/s, ft/s, km/h, mi/h, scaled by units_scales.h as KiCad does (UNIT_MILES_PER_HOUR is 1609.34) */
export const SPEED_UNITS: [string, number][] = [["m/s", 1], ["ft/s", 0.3048], ["km/h", 1 / 3.6], ["mi/h", 1609.34]];
/** UNIT_SELECTOR_RESISTOR: Ω, kΩ */
export const RESISTOR_UNITS: [string, number][] = [["Ω", 1], ["kΩ", 1e3]];
/** common_data.cpp StandardRelativeDielectricConstantList: "value \tmaterial" */
export const DIELECTRIC_CONSTANTS: [string, string][] = [["4.5", "FR4"], ["3.67", "Isola FR408"], ["4.04", "Isola 370HR"], ["3.55", "Rogers RO4003C"], ["3.66", "Rogers R4350B"],
  ["9.8", "alumina (Al2O3)"], ["3.78", "fused quartz"], ["3.38", "RO4003"], ["2.2", "RT/duroid 5880"], ["10.2", "RT/duroid 6010LM"], ["2.1", "teflon (PTFE)"], ["4.0", "PVC"],
  ["2.3", "PE"], ["6.6", "beryllia (BeO)"], ["8.7", "aluminum nitride"], ["11.9", "silicon"], ["12.9", "GaAs"]];
/** common_data.cpp StandardResistivityList */
export const RESISTIVITIES: [string, string][] = [["2.4e-8", "gold"], ["1.72e-8", "copper"], ["1.62e-8", "silver"], ["12.4e-8", "tin"], ["10.5e-8", "platinum"], ["2.62e-8", "aluminum"],
  ["6.9e-8", "nickel"], ["3.9e-8", "brass (66Cu 34Zn)"], ["9.71e-8", "iron"], ["6.0e-8", "zinc"]];

/** panel_track_width.cpp copper_resistivity */
export const COPPER_RESISTIVITY = 1.72e-8;

// ---- Track Width: common/track_width_calculations.cpp, the IPC-2152 based Brooks & Adam fit (mils, amperes)
interface BA { K: number; a: number; b: number; c: number }
const EXTERNAL: BA = { K: 215.3, a: 2.0, b: -1.15, c: -1.0 };
const INTERNAL: BA[] = [{ K: 120.0, a: 2.0, b: -1.10, c: -1.52 }, { K: 200.0, a: 1.9, b: -1.10, c: -1.52 }, { K: 300.0, a: 2.0, b: -1.15, c: -1.52 }, { K: 262.5, a: 1.9, b: -1.15, c: -1.52 }];
const OZ_MILS = [0.689, 1.378, 2.756, 4.134];
function coefficients(internal: boolean, thMils: number): BA {
  if (!internal) return EXTERNAL;
  if (thMils < (OZ_MILS[0] + OZ_MILS[1]) / 2) return INTERNAL[0];
  if (thMils < (OZ_MILS[1] + OZ_MILS[2]) / 2) return INTERNAL[1];
  if (thMils < (OZ_MILS[2] + OZ_MILS[3]) / 2) return INTERNAL[2];
  return INTERNAL[3];
}
/** TRACK_WIDTH_CALCULATIONS::WidthFromCurrent, in metres from amperes and a thickness in metres. */
export function trackWidthFromCurrent(current: number, thickness: number, deltaT: number, internal: boolean): number {
  const th = thickness / UNIT.mil, k = coefficients(internal, th);
  return Math.pow(deltaT / (k.K * Math.pow(current, k.a) * Math.pow(th, k.c)), 1 / k.b) * UNIT.mil;
}
/** TRACK_WIDTH_CALCULATIONS::CurrentFromWidth: amperes from a width and thickness in metres. */
export function trackCurrentFromWidth(width: number, thickness: number, deltaT: number, internal: boolean): number {
  const th = thickness / UNIT.mil, k = coefficients(internal, th);
  return Math.pow(deltaT / (k.K * Math.pow(width / UNIT.mil, k.b) * Math.pow(th, k.c)), 1 / k.a);
}
/** PANEL_TRACK_WIDTH::TWDisplayValues: area (m²), resistance, voltage drop and power loss of a track. */
export function trackElectrical(current: number, width: number, thickness: number, length: number, rho = COPPER_RESISTIVITY): { area: number; resistance: number; vdrop: number; loss: number } {
  const resistance = (rho * length) / (width * thickness), vdrop = resistance * current;
  return { area: width * thickness, resistance, vdrop, loss: vdrop * current };
}

// ---- Via Size: panel_via_size.cpp OnViaCalculate
export interface ViaInput { hole: number; plating: number; length: number; pad: number; clearance: number; z0: number; current: number; rho: number; er: number; deltaT: number; riseTime: number }
export interface ViaResult { resistance: number; vdrop: number; loss: number; ampacity: number; thermalResistance: number; capacitance: number; riseTimeDegradation: number; inductance: number; reactance: number; padTooBig: boolean }
/** Lengths in metres, rise time in nanoseconds: capacitance in pF, rise time degradation in ps, inductance in nH. */
export function viaSize(v: ViaInput): ViaResult {
  let area = Math.PI * (v.hole + v.plating) * v.plating;
  const resistance = v.rho * v.length / area;
  const thermalResistance = 2.49e-3 * v.length / area;
  const vdrop = v.current * resistance, loss = v.current * vdrop;
  area /= UNIT.mil * UNIT.mil;
  const ampacity = 0.048 * Math.pow(v.deltaT, 0.44) * Math.pow(area, 0.725);
  const capacitance = 55.51 * v.er * v.length * v.pad / (v.clearance - v.pad);
  const riseTimeDegradation = 2.2 * capacitance * v.z0 / 2;
  const inductance = 200 * v.length * (Math.log(4 * v.length / v.hole) + 1);
  const reactance = Math.PI * inductance / v.riseTime;
  return { resistance, vdrop, loss, ampacity, thermalResistance, capacitance, riseTimeDegradation, inductance, reactance, padTooBig: v.pad >= v.clearance };
}

// ---- Fusing Current: panel_fusing_current.cpp m_onCalculateClick (the adiabatic Onderdonk-style balance)
const ABS_ZERO = -273.15;
export type FuseSolve = "width" | "thickness" | "current" | "time";
export interface FuseInput { ambient: number; melting: number; width: number; thickness: number; current: number; time: number }
/** The solved field's value (NaN when the inputs are not valid: KiCad's "Error"), and whether the long-time note shows. */
export function fusingCurrent(i: FuseInput, solve: FuseSolve): { value: number; longTime: boolean } {
  const { ambient: Ta, melting: Tm } = i;
  let { width: W, thickness: T, current: I, time } = i;
  const ok = [Tm, Ta].every(isFinite) && Tm > Ta && Ta > ABS_ZERO && (solve === "current" || I > 0) && (solve === "width" || W > 0) && (solve === "thickness" || T > 0) && (solve === "time" || time > 0);
  const cp = 385, density = 8940, latentHeat = 205350.0;
  const volumicEnergy = density * ((Tm - Ta) * cp + latentHeat);
  const R = (((Ta - ABS_ZERO - 293) * 0.00393 + 1) * 1.72e-8 + ((Tm - ABS_ZERO - 293) * 0.00393 + 1) * 1.72e-8) / 2;
  const coeff = volumicEnergy / R;
  let A = W * T, value = NaN;
  if (ok) {
    if (solve === "width") { A = I / Math.sqrt(coeff / time); W = A / T; value = W; }
    else if (solve === "thickness") { A = I / Math.sqrt(coeff / time); T = A / W; value = T; }
    else if (solve === "current") { I = A * Math.sqrt(coeff / time); value = I; }
    else { time = coeff * A * A / I / I; value = time; }
  }
  const r = Math.sqrt(A / Math.PI), tmK = Tm - ABS_ZERO, frad = 0.5 * Math.pow(tmK + 293, 3);
  const tau = cp * density * r / (5.67e-8 * 0.5 * frad * 2);
  return { value, longTime: ok && !(2 * time < tau) };
}

// ---- Wavelength: panel_wavelength.cpp
export const SPEED_LIGHT = 299792458;
export function wavelength(freq: number, er: number, mur: number): { period: number; vacuum: number; medium: number; speed: number } {
  const n = Math.sqrt(er * mur);
  return { period: 1 / freq, vacuum: SPEED_LIGHT / freq, medium: SPEED_LIGHT / freq / n, speed: SPEED_LIGHT / n };
}

// ---- Board Classes: panel_board_class.cpp clist (metres; null is "--")
export const BOARD_CLASS_ROWS = ["Lines width", "Minimum clearance", "Via: (diameter - drill)", "Plated Pad: (diameter - drill)", "NP Pad: (diameter - drill)"];
export const BOARD_CLASSES: (number | null)[][] = [
  [0.80, 0.68, null, 1.19, 1.57], [0.50, 0.50, null, 0.78, 1.13], [0.31, 0.31, 0.45, 0.6, 0.90],
  [0.21, 0.21, 0.34, 0.49, null], [0.15, 0.15, 0.24, 0.39, null], [0.12, 0.12, 0.20, 0.35, null],
].map((c) => c.map((v) => (v === null ? null : v * UNIT.mm)));

// ---- E-Series: pcb_calculator/eseries.cpp
const E24 = [100, 110, 120, 130, 150, 160, 180, 200, 220, 240, 270, 300, 330, 360, 390, 430, 470, 510, 560, 620, 680, 750, 820, 910];
const E192 = [100, 101, 102, 104, 105, 106, 107, 109, 110, 111, 113, 114, 115, 117, 118, 120, 121, 123, 124, 126, 127, 129, 130, 132, 133, 135, 137, 138, 140, 142, 143, 145, 147, 149, 150, 152,
  154, 156, 158, 160, 162, 164, 165, 167, 169, 172, 174, 176, 178, 180, 182, 184, 187, 189, 191, 193, 196, 198, 200, 203, 205, 208, 210, 213, 215, 218, 221, 223, 226, 229, 232, 234,
  237, 240, 243, 246, 249, 252, 255, 258, 261, 264, 267, 271, 274, 277, 280, 284, 287, 291, 294, 298, 301, 305, 309, 312, 316, 320, 324, 328, 332, 336, 340, 344, 348, 352, 357, 361,
  365, 370, 374, 379, 383, 388, 392, 397, 402, 407, 412, 417, 422, 427, 432, 437, 442, 448, 453, 459, 464, 470, 475, 481, 487, 493, 499, 505, 511, 517, 523, 530, 536, 542, 549, 556,
  562, 569, 576, 583, 590, 597, 604, 612, 619, 626, 634, 642, 649, 657, 665, 673, 681, 690, 698, 706, 715, 723, 732, 741, 750, 759, 768, 777, 787, 796, 806, 816, 825, 835, 845, 856,
  866, 876, 887, 898, 909, 920, 931, 942, 953, 965, 976, 988];
export type ESeries = 1 | 3 | 6 | 12 | 24 | 48 | 96 | 192;
/** ESERIES_VALUES: one decade of a series as KiCad stores it (100 .. 988). */
export function eSeries(n: ESeries): number[] {
  const base = n <= 24 ? E24 : E192, step = base.length / n;
  return base.filter((_, i) => i % step === 0);
}

// ---- Color Code: PANEL_COLOR_CODE shows KiCad's color_code_* bitmaps (the chart is the picture), nothing computed.
/** PANEL_COLOR_CODE::ToleranceSelection: the band columns shown, the 4th band only for "<= 2%" (selection 1). */
export function colorCodeColumns(tolerance: 0 | 1): { label: string; bitmap: string }[] {
  return [{ label: "1st Band", bitmap: "color_code_value_and_name" }, { label: "2nd Band", bitmap: "color_code_value" }, { label: "3rd Band", bitmap: "color_code_value" },
    ...(tolerance ? [{ label: "4th Band", bitmap: "color_code_value" }] : []), { label: "Multiplier", bitmap: "color_code_multiplier" }, { label: "Tolerance", bitmap: "color_code_tolerance" }];
}

/** wxString::Format("%g"): six significant digits, trailing zeros dropped. */
export function fmtG(v: number): string {
  if (!isFinite(v)) return "";
  if (v === 0) return "0";
  const e = Math.floor(Math.log10(Math.abs(v)));
  if (e < -5 || e >= 6) { const s = v.toExponential(5).replace(/\.?0+e/, "e"); return s.replace(/e([+-])(\d)$/, "e$10$2"); }
  return String(+v.toPrecision(6));
}

// ---------------------------------------------------------------- the through-hole size (common/pth_hole_size.cpp)
// Sizes are in nanometres (KiCad's PCB internal units), as there.
export type PthLeadShape = "round" | "square" | "rect";
export interface PthLead { shape: PthLeadShape; minX: number; maxX: number; minY: number; maxY: number }
export interface PthRange { leadMin: number; leadMax: number; holeMin: number; holeMax: number }
/** KiROUND for the sizes here. */
const kiRound = (v: number): number => (v < 0 ? -Math.round(-v) : Math.round(v));
export const mmToIU = (mm: number): number => kiRound(mm * 1e6);
/** effectiveLeadSize: a square or rectangular lead's diagonal. */
export function pthEffectiveLeadSize(l: PthLead): [number, number] {
  if (l.shape === "square") return [kiRound(Math.hypot(l.minX, l.minX)), kiRound(Math.hypot(l.maxX, l.maxX))];
  if (l.shape === "rect") return [kiRound(Math.hypot(l.minX, l.minY)), kiRound(Math.hypot(l.maxX, l.maxY))];
  return [l.minX, l.maxX];
}
/** IPC2222_HOLE_SIZE_STANDARD, the one standard GetPthHoleSizeStandards lists. */
export const IPC2222B = {
  id: "IPC-2222B", levels: ["A (General)", "B (Moderate)", "C (High density)"],
  minAdd: [mmToIU(0.25), mmToIU(0.20), mmToIU(0.15)], maxAdd: [mmToIU(0.70), mmToIU(0.70), mmToIU(0.60)],
};
export const PTH_STANDARDS = [IPC2222B];
/** ComputeHoleSize: the smallest hole the largest lead fits, the largest the smallest lead still needs. */
export function pthHoleRange(level: number, l: PthLead, std = IPC2222B): PthRange {
  const lv = Math.max(0, Math.min(std.levels.length - 1, level));
  const [leadMin, leadMax] = pthEffectiveLeadSize(l);
  return { leadMin, leadMax, holeMin: leadMax + std.minAdd[lv], holeMax: leadMin + std.maxAdd[lv] };
}
/** ComputeRecommendedPthHoleSize: the middle of the range rounded (up or to the nearest) to the step, never under the minimum. */
export function pthRecommendedHole(r: PthRange, step: number, up: boolean): number {
  const mid = Math.trunc((r.holeMin + r.holeMax) / 2);
  if (step <= 0) return mid;
  let hole = up ? Math.trunc((mid + step - 1) / step) * step : Math.trunc((mid + Math.trunc(step / 2)) / step) * step;
  if (hole < r.holeMin) hole = Math.trunc((r.holeMin + step - 1) / step) * step;
  return hole;
}
/** wxString::Format( "%.3g", mm ) of a size in nm (formatMm). */
export function fmtMm3(iu: number): string {
  const v = iu / 1e6;
  if (!isFinite(v)) return "";
  if (v === 0) return "0";
  const e = Math.floor(Math.log10(Math.abs(+v.toPrecision(3))));
  if (e < -4 || e >= 3) { const s = v.toExponential(2).replace(/\.?0+e/, "e"); return s.replace(/e([+-])(\d)$/, "e$10$2"); }
  return String(+v.toPrecision(3));
}
/** pthResultReportText: the labelled lines, the labels padded to one width. */
export function pthReportText(level: number, l: PthLead, annular: number, r: PthRange, hole: number, pad: number, std = IPC2222B): string {
  const rng = (a: number, b: number): string => `${fmtMm3(a)} – ${fmtMm3(b)} mm`;
  const shape = l.shape === "round" ? "Round" : l.shape === "square" ? "Square" : "Rectangular";
  const size = l.shape === "rect" ? `${fmtMm3(l.minX)} – ${fmtMm3(l.maxX)} mm x ${fmtMm3(l.minY)} – ${fmtMm3(l.maxY)} mm` : rng(l.minX, l.maxX);
  const rows: string[][] = [["Standard:", std.id], ["Production level:", std.levels[Math.max(0, Math.min(std.levels.length - 1, level))]], ["Lead shape:", shape], ["Lead size:", size],
    ["Effective lead size:", rng(r.leadMin, r.leadMax)], [""], ["Minimum hole size:", `${fmtMm3(r.holeMin)} mm`], ["Maximum hole size:", `${fmtMm3(r.holeMax)} mm`],
    ["Recommended hole size:", `${fmtMm3(hole)} mm`], ["Hole clearance over max. lead:", `${fmtMm3(hole - r.leadMax)} mm`], ["Annular ring:", `${fmtMm3(annular)} mm`], ["Pad diameter:", `${fmtMm3(pad)} mm`]];
  const w = Math.max(...rows.filter((x) => x.length > 1).map((x) => x[0].length));
  return rows.map((x) => (x.length > 1 ? x[0].padEnd(w) + " " + x[1] : x[0]) + "\n").join("");
}
