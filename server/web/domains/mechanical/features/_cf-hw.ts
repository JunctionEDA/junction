// _cf-hw.ts — the tables and dialog fields the hardware custom features (cf-hw-*.ts) share: thread sizes and
// forms, fastener, nut and washer dimensions, O-rings, bearings, motor and display mounts.  Pure data and pure
// functions: this file is bundled into the page (for the dialogs) and into the worker.
//
// Sources, so a number can be checked: ISO 261/262 (metric pitches), ISO 68-1 (the 60° basic profile, also the
// unified one of ASME B1.1), ASME B1.20.1 (NPT), ISO 7-1 (BSPT, 55°), ISO 4014/4017/4032/4762/7380/10642 and
// DIN 7991/985/562/127 (heads, nuts, washers: nominal sizes), ISO 273 (clearance holes), ISO 7089/7093
// (washers), SAE AS568 = ISO 3601-1 class A (O-rings), ISO 15 (bearing boundary dimensions), NEMA ICS 16
// (motor faces), VESA FDMI (display mounts).
import type { ParamField } from "../core/feature";
import { METRIC } from "../kernel/ops/holes";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const HW_SECTION = "library" as const;
export const MENU_THREADS = "Threads & fasteners";
export const MENU_ENCLOSURES = "Enclosures & hardware";
const IN = 25.4;

type Option = { value: string; label: string };
const options = (ids: readonly string[], first: Option[] = []): Option[] => [...first, ...ids.map((v) => ({ value: v, label: v }))];

// ------------------------------------------------------------------ where a feature goes

/** The fields that place a feature: picked points, and the plane they lie in. */
export function whereFields(o: { angle?: boolean; flip?: string | false; noun?: string } = {}): ParamField[] {
  const out: ParamField[] = [
    { key: "at", label: "Locations", kind: "refs", of: ["vertex", "edge"], sketch: true, datums: ["point"], hint: `Sketch points, vertices or round edges (their centres): one ${o.noun || "copy"} at each. Leave empty for the middle of the face, or the plane's origin.` },
    { key: "plane", label: "Plane or face", kind: "plane", hint: "The flat face or plane it stands on. Sketch points bring their sketch's plane." },
  ];
  if (o.angle) out.push({ key: "angle", label: "Turn", kind: "number", unit: "deg", step: 15 });
  if (o.flip !== false) out.push({ key: "flip", label: o.flip || "Opposite side", kind: "boolean" });
  return out;
}
export const whereDefaults = () => ({ at: [], plane: { kind: "plane", plane: "top" }, angle: 0, flip: false });

// ------------------------------------------------------------------ threads

export interface ThreadSize { id: string; d: number; pitch: number }
export interface ThreadForm { depth: number; majorFlat: number; minorFlat: number }

const metric = (rows: [number, number][]): ThreadSize[] => rows.map(([d, p]) => ({ id: `M${d}×${p}`, d, pitch: p }));
const unified = (rows: [string, number, number][], suffix: string): ThreadSize[] => rows.map(([name, d, tpi]) => ({ id: `${name}-${tpi} ${suffix}`, d: d * IN, pitch: IN / tpi }));

export const THREADS: { [standard: string]: { label: string; sizes: ThreadSize[] } } = {
  iso: { label: "ISO metric coarse", sizes: metric([[1.6, 0.35], [2, 0.4], [2.5, 0.45], [3, 0.5], [4, 0.7], [5, 0.8], [6, 1], [8, 1.25], [10, 1.5], [12, 1.75], [14, 2], [16, 2], [18, 2.5], [20, 2.5], [22, 2.5], [24, 3], [27, 3], [30, 3.5], [36, 4], [42, 4.5], [48, 5]]) },
  isoFine: { label: "ISO metric fine", sizes: metric([[3, 0.35], [4, 0.5], [5, 0.5], [6, 0.75], [8, 1], [8, 0.75], [10, 1.25], [10, 1], [12, 1.5], [12, 1.25], [14, 1.5], [16, 1.5], [18, 1.5], [20, 2], [20, 1.5], [22, 1.5], [24, 2], [27, 2], [30, 2], [36, 3], [42, 3], [48, 3]]) },
  unc: { label: "Unified coarse (UNC)", sizes: unified([["#2", 0.086, 56], ["#4", 0.112, 40], ["#6", 0.138, 32], ["#8", 0.164, 32], ["#10", 0.19, 24], ["1/4", 0.25, 20], ["5/16", 0.3125, 18], ["3/8", 0.375, 16], ["7/16", 0.4375, 14], ["1/2", 0.5, 13], ["9/16", 0.5625, 12], ["5/8", 0.625, 11], ["3/4", 0.75, 10], ["7/8", 0.875, 9], ["1", 1, 8]], "UNC") },
  unf: { label: "Unified fine (UNF)", sizes: unified([["#2", 0.086, 64], ["#4", 0.112, 48], ["#6", 0.138, 40], ["#8", 0.164, 36], ["#10", 0.19, 32], ["1/4", 0.25, 28], ["5/16", 0.3125, 24], ["3/8", 0.375, 24], ["7/16", 0.4375, 20], ["1/2", 0.5, 20], ["9/16", 0.5625, 18], ["5/8", 0.625, 18], ["3/4", 0.75, 16], ["7/8", 0.875, 14], ["1", 1, 12]], "UNF") },
};
export const THREAD_STANDARDS = Object.keys(THREADS);

/** The 60° basic profile of ISO 68-1 and ASME B1.1: 5/8 of the sharp V deep, flats of P/8 (major) and P/4 (minor). */
export const form60 = (pitch: number): ThreadForm => ({ depth: (5 / 8) * (Math.sqrt(3) / 2) * pitch, majorFlat: pitch / 8, minorFlat: pitch / 4 });

/** The dialog's fields for a thread standard and size; `auto` adds "fit the cylinder" as the first size. */
export function threadFields(auto: boolean): ParamField[] {
  const first: Option[] = auto ? [{ value: "auto", label: "Fit the diameter" }] : [];
  return [
    { key: "standard", label: "Standard", kind: "enum", options: [...THREAD_STANDARDS.map((s) => ({ value: s, label: THREADS[s].label })), { value: "custom", label: "Custom" }] },
    ...THREAD_STANDARDS.map((s): ParamField => ({ key: `size_${s}`, label: "Size", kind: "enum", options: options(THREADS[s].sizes.map((t) => t.id), first), visible: (p) => p.standard === s })),
    { key: "pitch", label: "Pitch", kind: "number", unit: "mm", min: 0.05, step: 0.25, visible: (p) => p.standard === "custom" },
    ...(auto ? [] : [{ key: "diameter", label: "Major diameter", kind: "number", unit: "mm", min: 0.5, step: 1, visible: (p: any) => p.standard === "custom" } as ParamField]),
  ];
}
export const threadDefaults = (auto: boolean, size = "M8×1.25") => ({ standard: "iso", size_iso: auto ? "auto" : size, size_isoFine: auto ? "auto" : "M8×1", size_unc: auto ? "auto" : "1/4-20 UNC", size_unf: auto ? "auto" : "1/4-28 UNF", pitch: 1.5, diameter: 10 });

/**
 * The thread a dialog asks for.  `near` is the diameter it should fit when the size is "auto" (the major diameter
 * for a thread on a shaft, the tap drill for one in a hole); the answer says what was chosen.
 */
export function chosenThread(p: { [k: string]: any }, near: number | null, inHole = false): { size: ThreadSize | null; d: number; pitch: number; label: string } | string {
  if (p.standard === "custom") {
    const d = near ?? Number(p.diameter), pitch = Number(p.pitch);
    if (!(pitch > 0)) return "The pitch must be more than zero.";
    return { size: null, d: inHole && near !== null ? near + 2 * form60(pitch).depth : d, pitch, label: `Ø${round(d)}×${round(pitch)}` };
  }
  const std = THREADS[p.standard];
  if (!std) return "Pick a thread standard.";
  const want = p[`size_${p.standard}`];
  if (want && want !== "auto") {
    const s = std.sizes.find((t) => t.id === want);
    return s ? { size: s, d: s.d, pitch: s.pitch, label: s.id } : `The ${std.label} table has no ${want}.`;
  }
  if (near === null) return "Pick a thread size.";
  const fit = (t: ThreadSize) => Math.abs((inHole ? t.d - 2 * form60(t.pitch).depth : t.d) - near);
  const best = std.sizes.reduce((a, b) => (fit(b) < fit(a) ? b : a));
  if (fit(best) > Math.max(0.12, 0.04 * near)) return `No ${std.label} size ${inHole ? "is tapped in a hole of" : "has a diameter near"} ${round(near)} mm. Pick a size, or Custom.`;
  return { size: best, d: best.d, pitch: best.pitch, label: best.id };
}
const round = (v: number) => Math.round(v * 1000) / 1000;

/** Tapered pipe threads: NPT (ASME B1.20.1, 60°, flats 0.038 P) and BSPT (ISO 7-1, 55°, modelled with flats of P/6). */
export interface PipeSize {
  id: string; pitch: number;
  /** the pipe's outside diameter */
  od: number;
  /** major diameter at the small end of the external thread, and at the mouth of the internal one */
  majorTip: number; majorMouth: number;
  /** the length of effective thread */
  length: number;
}
const NPT_H = 0.8, BSP_H = 0.640327;
const npt = (id: string, tpi: number, od: number, e0: number, l1: number, l2: number): PipeSize => {
  const p = IN / tpi;
  return { id: `${id} NPT`, pitch: p, od: od * IN, majorTip: e0 * IN + NPT_H * p, majorMouth: (e0 + l1 / 16) * IN + NPT_H * p, length: l2 * IN };
};
const bspt = (id: string, tpi: number, gauge: number, gaugeLength: number, useful: number): PipeSize => ({ id: `R ${id} (BSPT)`, pitch: IN / tpi, od: gauge, majorTip: gauge - gaugeLength / 16, majorMouth: gauge, length: useful });
export const PIPE_THREADS: { [standard: string]: { label: string; form(pitch: number): ThreadForm; sizes: PipeSize[] } } = {
  npt: {
    label: "NPT", form: (p) => ({ depth: NPT_H * p, majorFlat: 0.038 * p, minorFlat: 0.038 * p }),
    sizes: [npt("1/16", 27, 0.3125, 0.27118, 0.16, 0.2611), npt("1/8", 27, 0.405, 0.36351, 0.1615, 0.2639), npt("1/4", 18, 0.54, 0.47739, 0.2278, 0.4018), npt("3/8", 18, 0.675, 0.61201, 0.24, 0.4078),
      npt("1/2", 14, 0.84, 0.75843, 0.32, 0.5337), npt("3/4", 14, 1.05, 0.96768, 0.339, 0.5457), npt("1", 11.5, 1.315, 1.21363, 0.4, 0.6828), npt("1-1/4", 11.5, 1.66, 1.55713, 0.42, 0.7068),
      npt("1-1/2", 11.5, 1.9, 1.79609, 0.42, 0.7235), npt("2", 11.5, 2.375, 2.26902, 0.436, 0.7565)],
  },
  bspt: {
    label: "BSPT (R / Rc)", form: (p) => ({ depth: BSP_H * p, majorFlat: p / 6, minorFlat: p / 6 }),
    sizes: [bspt("1/16", 28, 7.723, 4, 6.5), bspt("1/8", 28, 9.728, 4, 6.5), bspt("1/4", 19, 13.157, 6, 9.7), bspt("3/8", 19, 16.662, 6.4, 10.1), bspt("1/2", 14, 20.955, 8.2, 13.2),
      bspt("3/4", 14, 26.441, 9.5, 14.5), bspt("1", 11, 33.249, 10.4, 16.8), bspt("1-1/4", 11, 41.91, 12.7, 19.1), bspt("1-1/2", 11, 47.803, 12.7, 19.1), bspt("2", 11, 59.614, 15.9, 23.4)],
  },
};
/** Diameter grows by 1 in 16 along a pipe thread: the radius by this much per unit of length. */
export const PIPE_TAPER = 1 / 32;

// ------------------------------------------------------------------ fasteners

export interface Fastener {
  d: number; pitch: number;
  /** hexagon head and nut: across flats; head height; nut height; self-locking nut height; thin square nut height */
  s: number; hexK: number; nutM: number; nylocM: number; squareM: number;
  /** socket head cap screw: head diameter (its height is d), key size, key depth */
  capD: number; key: number; keyT: number;
  /** button head: diameter, height, key size, key depth */
  buttonD: number; buttonK: number; buttonKey: number; buttonT: number;
  /** countersunk head (90°): diameter, height, key size, key depth */
  flatD: number; flatK: number; flatKey: number; flatT: number;
  /** holes: tap drill, clearance (close, normal, loose), counterbore diameter and depth, countersink diameter */
  tap: number; clearance: [number, number, number]; cbore: [number, number]; csink: number;
  /** plain washer (ISO 7089), large washer (ISO 7093), spring washer (DIN 127): inside, outside, thickness */
  washer: [number, number, number]; washerLarge: [number, number, number]; washerSpring: [number, number, number];
  /** heat-set insert for plastics: hole diameter and depth (typical brass inserts; check the maker's sheet) */
  insert: [number, number];
}
//        d  pitch  s   hexK nutM nylocM sqM | capD key keyT | btnD btnK key t | flatD flatK key t | washer…
const F = (d: number, pitch: number, s: number, hexK: number, nutM: number, nylocM: number, squareM: number, cap: [number, number, number], button: [number, number, number, number], flat: [number, number, number, number],
  holes: { tap: number; clearance: [number, number, number]; cbore: [number, number]; csink: number } | null, washer: [number, number, number], washerLarge: [number, number, number], washerSpring: [number, number, number], insert: [number, number]): Fastener => {
  const m = METRIC[`M${d}`];
  const h = holes || { tap: m.tap, clearance: m.clearance, cbore: m.cbore, csink: m.csink };
  return { d, pitch, s, hexK, nutM, nylocM, squareM, capD: cap[0], key: cap[1], keyT: cap[2], buttonD: button[0], buttonK: button[1], buttonKey: button[2], buttonT: button[3], flatD: flat[0], flatK: flat[1], flatKey: flat[2], flatT: flat[3], ...h, washer, washerLarge, washerSpring, insert };
};
export const FASTENERS: { [size: string]: Fastener } = {
  M2: F(2, 0.4, 4, 1.4, 1.6, 2.8, 1.2, [3.8, 1.5, 1], [3.5, 1.3, 1.3, 0.7], [4, 1.2, 1.3, 0.7], null, [2.2, 5, 0.3], [2.2, 6, 0.5], [2.1, 4.4, 0.5], [3.2, 3.5]),
  "M2.5": F(2.5, 0.45, 5, 1.7, 2, 3.5, 1.6, [4.5, 2, 1.1], [4.7, 1.5, 1.5, 0.9], [5, 1.5, 1.5, 0.9], null, [2.7, 6, 0.5], [2.7, 8, 0.5], [2.6, 5.1, 0.6], [4, 4.5]),
  M3: F(3, 0.5, 5.5, 2, 2.4, 4, 1.8, [5.5, 2.5, 1.3], [5.7, 1.65, 2, 1.04], [6, 1.7, 2, 1.1], null, [3.2, 7, 0.5], [3.2, 9, 0.8], [3.1, 6.2, 0.8], [4, 5.5]),
  M4: F(4, 0.7, 7, 2.8, 3.2, 5, 2.2, [7, 3, 2], [7.6, 2.2, 2.5, 1.3], [8, 2.3, 2.5, 1.5], null, [4.3, 9, 0.8], [4.3, 12, 1], [4.1, 7.6, 0.9], [5.6, 7.5]),
  M5: F(5, 0.8, 8, 3.5, 4.7, 5, 2.7, [8.5, 4, 2.5], [9.5, 2.75, 3, 1.56], [10, 2.8, 3, 1.9], null, [5.3, 10, 1], [5.3, 15, 1.2], [5.1, 9.2, 1.2], [6.4, 9]),
  M6: F(6, 1, 10, 4, 5.2, 6, 3.2, [10, 5, 3], [10.5, 3.3, 4, 2.08], [12, 3.3, 4, 2.2], null, [6.4, 12, 1.6], [6.4, 18, 1.6], [6.1, 11.8, 1.6], [8, 11.5]),
  M8: F(8, 1.25, 13, 5.3, 6.8, 8, 4, [13, 6, 4], [14, 4.4, 5, 2.6], [16, 4.4, 5, 3], null, [8.4, 16, 1.6], [8.4, 24, 2], [8.1, 14.8, 2], [9.7, 13.5]),
  M10: F(10, 1.5, 16, 6.4, 8.4, 10, 5, [16, 8, 5], [17.5, 5.5, 6, 3.12], [20, 5.5, 6, 3.6], null, [10.5, 20, 2], [10.5, 30, 2.5], [10.2, 18.1, 2.2], [12.6, 16]),
  M12: F(12, 1.75, 18, 7.5, 10.8, 12, 10, [18, 10, 6], [21, 6.6, 8, 4.16], [24, 6.5, 8, 4.3], null, [13, 24, 2.5], [13, 37, 3], [12.2, 21.1, 2.5], [15, 18]),
  M16: F(16, 2, 24, 10, 14.8, 16, 13, [24, 14, 8], [28, 8.8, 10, 5.2], [30, 7.5, 10, 4.8], { tap: 14, clearance: [17, 17.5, 18.5], cbore: [26, 17.5], csink: 33 }, [17, 30, 3], [17, 50, 3], [16.2, 27.4, 3.5], [19.5, 22]),
  M20: F(20, 2.5, 30, 12.5, 18, 20, 16, [30, 17, 10], [35, 11, 12, 6.5], [36, 8.5, 12, 5.6], { tap: 17.5, clearance: [21, 22, 24], cbore: [33, 21.5], csink: 40 }, [21, 37, 3], [21, 60, 4], [20.2, 33.6, 4], [24, 26]),
  M24: F(24, 3, 36, 15, 21.5, 24, 19, [36, 19, 12], [42, 13.2, 14, 7.8], [39, 14, 14, 10], { tap: 21, clearance: [25, 26, 28], cbore: [40, 25.5], csink: 44 }, [25, 44, 4], [25, 72, 5], [24.5, 40, 5], [29, 30]),
};
export const FASTENER_SIZES = Object.keys(FASTENERS);
export const fastenerOptions = (): Option[] => options(FASTENER_SIZES);
export const sizeField = (label = "Size"): ParamField => ({ key: "size", label, kind: "enum", options: fastenerOptions() });
export const fastenerOf = (size: unknown): Fastener | null => FASTENERS[String(size)] || null;

// ------------------------------------------------------------------ O-rings

export interface ORing { dash: string; cs: number; id: number }
// The AS568 table is regular: a size's inside diameter is a nominal fraction of an inch less a fixed amount for its
// series, written to a thousandth (a half rounds down).  Each run: first and last dash number, the first
// nominal diameter and the step between sizes (inches).
const SERIES: { cs: number; less(dash: number): number; runs: [number, number, number, number][] }[] = [
  { cs: 0.07, less: () => 0.011, runs: [[6, 10, 1 / 8, 1 / 32], [11, 28, 5 / 16, 1 / 16], [29, 41, 1.5, 1 / 8], [42, 50, 3.25, 1 / 4]] },
  { cs: 0.103, less: (d) => (d < 135 ? 0.013 : 0.0125), runs: [[102, 108, 1 / 16, 1 / 32], [109, 150, 5 / 16, 1 / 16], [151, 151, 3, 1], [152, 178, 3.25, 1 / 4]] },
  { cs: 0.139, less: () => 0.016, runs: [[201, 222, 3 / 16, 1 / 16], [223, 258, 1.625, 1 / 8], [259, 274, 6.25, 1 / 4], [275, 278, 10.5, 1 / 2]] },
  { cs: 0.21, less: () => 0.025, runs: [[309, 324, 7 / 16, 1 / 16], [325, 361, 1.5, 1 / 8], [362, 377, 6.25, 1 / 4], [378, 381, 10.5, 1 / 2]] },
  { cs: 0.275, less: () => 0.025, runs: [[425, 437, 4.5, 1 / 8], [438, 445, 6.25, 1 / 4], [446, 460, 8.5, 1 / 2]] },
];
/** AS568 (ISO 3601-1 class A) O-rings by dash number, in millimetres: -001 to -050, -102 to -178, -201 to -278, -309 to -381, -425 to -460. */
export const ORINGS: ORing[] = (() => {
  const inch = (dash: number, cs: number, id: number): ORing => ({ dash: String(dash).padStart(3, "0"), cs: cs * IN, id: id * IN });
  const out: ORing[] = [inch(1, 0.04, 0.029), inch(2, 0.05, 0.042), inch(3, 0.06, 0.056), inch(4, 0.07, 0.07), inch(5, 0.07, 0.101)];
  for (const s of SERIES) for (const [first, last, nominal, step] of s.runs) for (let dash = first; dash <= last; dash++) {
    out.push(inch(dash, s.cs, Math.round((nominal + (dash - first) * step - s.less(dash)) * 1000 - 1e-6) / 1000));
  }
  return out;
})();
export const oringOf = (dash: unknown): ORing | null => {
  const want = String(dash ?? "").replace(/[^0-9]/g, "").padStart(3, "0");
  return ORINGS.find((o) => o.dash === want) || null;
};

/** Gland dimensions by cross-section (Parker O-Ring Handbook, industrial glands, mid-tolerance), in millimetres. */
const GLANDS: { cs: number; staticDepth: number; dynamicDepth: number; radialWidth: number; faceDepth: number; faceWidth: number; radius: number }[] = [
  { cs: 1.78, staticDepth: 1.3, dynamicDepth: 1.42, radialWidth: 2.4, faceDepth: 1.32, faceWidth: 2.65, radius: 0.25 },
  { cs: 2.62, staticDepth: 2.08, dynamicDepth: 2.26, radialWidth: 3.6, faceDepth: 1.96, faceWidth: 3.55, radius: 0.25 },
  { cs: 3.53, staticDepth: 2.84, dynamicDepth: 3.1, radialWidth: 4.8, faceDepth: 2.64, faceWidth: 4.6, radius: 0.45 },
  { cs: 5.33, staticDepth: 4.36, dynamicDepth: 4.74, radialWidth: 7.2, faceDepth: 3.99, faceWidth: 7.1, radius: 0.7 },
  { cs: 6.99, staticDepth: 5.78, dynamicDepth: 6.06, radialWidth: 9.6, faceDepth: 5.23, faceWidth: 8.95, radius: 0.7 },
];
/** The gland for a cross-section: the table's row, or the rows either side of it in proportion. */
export function glandFor(cs: number): { staticDepth: number; dynamicDepth: number; radialWidth: number; faceDepth: number; faceWidth: number; radius: number } {
  const g = GLANDS;
  const keys = ["staticDepth", "dynamicDepth", "radialWidth", "faceDepth", "faceWidth", "radius"] as const;
  let i = g.findIndex((r) => r.cs >= cs);
  if (i < 0) i = g.length - 1;
  const a = g[Math.max(0, i - 1)], b = g[i];
  const t = a === b || cs <= a.cs ? 0 : Math.min(1, (cs - a.cs) / (b.cs - a.cs));
  const out: any = {};
  // outside the table the ratios of the nearest row hold; inside it the ratio is carried from row to row
  for (const key of keys) out[key] = cs * ((a[key] / a.cs) * (1 - t) + (b[key] / b.cs) * t);
  return out;
}

// ------------------------------------------------------------------ bearings

/** Deep-groove ball bearings by designation: bore, outside diameter, width (ISO 15). */
export const BEARINGS: { [id: string]: [number, number, number] } = {
  MR63: [3, 6, 2.5], MR74: [4, 7, 2.5], MR84: [4, 8, 3], MR85: [5, 8, 2.5], MR105: [5, 10, 4], MR115: [5, 11, 4], MR128: [8, 12, 3.5],
  683: [3, 7, 3], 693: [3, 8, 4], 623: [3, 10, 4], 684: [4, 9, 4], 694: [4, 11, 4], 604: [4, 12, 4], 624: [4, 13, 5], 685: [5, 11, 5], 695: [5, 13, 4], 605: [5, 14, 5], 625: [5, 16, 5],
  686: [6, 13, 5], 696: [6, 15, 5], 606: [6, 17, 6], 626: [6, 19, 6], 687: [7, 14, 5], 607: [7, 19, 6], 627: [7, 22, 7], 688: [8, 16, 5], 698: [8, 19, 6], 608: [8, 22, 7], 628: [8, 24, 8], 629: [9, 26, 8],
  6800: [10, 19, 5], 6900: [10, 22, 6], 6000: [10, 26, 8], 6200: [10, 30, 9], 6300: [10, 35, 11], 6801: [12, 21, 5], 6901: [12, 24, 6], 6001: [12, 28, 8], 6201: [12, 32, 10], 6301: [12, 37, 12],
  6802: [15, 24, 5], 6902: [15, 28, 7], 6002: [15, 32, 9], 6202: [15, 35, 11], 6302: [15, 42, 13], 6803: [17, 26, 5], 6903: [17, 30, 7], 6003: [17, 35, 10], 6203: [17, 40, 12], 6303: [17, 47, 14],
  6804: [20, 32, 7], 6904: [20, 37, 9], 6004: [20, 42, 12], 6204: [20, 47, 14], 6304: [20, 52, 15], 6805: [25, 37, 7], 6905: [25, 42, 9], 6005: [25, 47, 12], 6205: [25, 52, 15], 6305: [25, 62, 17],
  6806: [30, 42, 7], 6906: [30, 47, 9], 6006: [30, 55, 13], 6206: [30, 62, 16], 6306: [30, 72, 19], 6007: [35, 62, 14], 6207: [35, 72, 17], 6008: [40, 68, 15], 6208: [40, 80, 18],
};
export const bearingOptions = (): Option[] => options(Object.keys(BEARINGS), [{ value: "custom", label: "Custom" }]);

// ------------------------------------------------------------------ mounts

/** Stepper motor faces: bolt square, pilot (boss) diameter, screw. */
export const NEMA: { [id: string]: { square: number; pilot: number; screw: string; body: number } } = {
  "NEMA 8": { square: 16, pilot: 15, screw: "M2", body: 20.3 }, "NEMA 11": { square: 23, pilot: 22, screw: "M2.5", body: 28.2 }, "NEMA 14": { square: 26, pilot: 22, screw: "M3", body: 35.2 },
  "NEMA 17": { square: 31, pilot: 22, screw: "M3", body: 42.3 }, "NEMA 23": { square: 47.14, pilot: 38.1, screw: "M5", body: 56.4 }, "NEMA 24": { square: 47.14, pilot: 38.1, screw: "M5", body: 60 },
  "NEMA 34": { square: 69.6, pilot: 73.02, screw: "M6", body: 86 },
};
/** Display mounts (VESA FDMI): hole spacing across and up, screw. */
export const VESA: { [id: string]: { x: number; y: number; screw: string } } = {
  "VESA 75": { x: 75, y: 75, screw: "M4" }, "VESA 100": { x: 100, y: 100, screw: "M4" }, "VESA 200×100": { x: 200, y: 100, screw: "M4" }, "VESA 200": { x: 200, y: 200, screw: "M6" },
  "VESA 300": { x: 300, y: 300, screw: "M6" }, "VESA 400": { x: 400, y: 400, screw: "M6" },
};

/** Circuit boards people mount: hole positions about the pattern's middle, and the screw. */
export const BOARD_PATTERNS: { [id: string]: { label: string; screw: string; holes: [number, number][] } } = (() => {
  const rect = (x: number, y: number): [number, number][] => [[-x / 2, -y / 2], [x / 2, -y / 2], [x / 2, y / 2], [-x / 2, y / 2]];
  return {
    pi: { label: "Raspberry Pi 2/3/4/5 (58×49)", screw: "M2.5", holes: rect(58, 49) },
    pizero: { label: "Raspberry Pi Zero (58×23)", screw: "M2.5", holes: rect(58, 23) },
    pico: { label: "Raspberry Pi Pico (11.4×47)", screw: "M2", holes: rect(11.4, 47) },
    uno: { label: "Arduino Uno", screw: "M3", holes: [[-26.67, -24.13], [-25.4, 24.13], [25.4, -8.89], [25.4, 19.05]] },
    nano: { label: "Arduino Nano (15.24×40.64)", screw: "M2", holes: rect(15.24, 40.64) },
    custom: { label: "Custom rectangle", screw: "M3", holes: [] },
  };
})();

/** Cable glands: the thread's major diameter and pitch. */
export const GLANDS_CABLE: { [id: string]: { d: number; pitch: number; af: number } } = {
  PG7: { d: 12.5, pitch: 1.27, af: 15 }, PG9: { d: 15.2, pitch: 1.41, af: 19 }, PG11: { d: 18.6, pitch: 1.41, af: 22 }, "PG13.5": { d: 20.4, pitch: 1.41, af: 24 }, PG16: { d: 22.5, pitch: 1.41, af: 27 }, PG21: { d: 28.3, pitch: 1.588, af: 33 },
  "M12×1.5": { d: 12, pitch: 1.5, af: 15 }, "M16×1.5": { d: 16, pitch: 1.5, af: 19 }, "M20×1.5": { d: 20, pitch: 1.5, af: 24 }, "M25×1.5": { d: 25, pitch: 1.5, af: 30 }, "M32×1.5": { d: 32, pitch: 1.5, af: 36 }, "M40×1.5": { d: 40, pitch: 1.5, af: 46 },
};

export { options };

// ------------------------------------------------------------------ what a feature does with what it builds

/** Result: a new body, or joined to the bodies it touches. */
export const resultFields: ParamField[] = [
  { key: "operation", label: "Result", kind: "enum", options: [{ value: "new", label: "New" }, { value: "add", label: "Add" }] },
  { key: "targets", label: "Bodies to join", kind: "bodies", hint: "Leave empty for every body it touches.", visible: (p) => p.operation === "add" },
];
/** Which bodies a feature that removes material cuts. */
export const cutFields: ParamField[] = [{ key: "targets", label: "Bodies to cut", kind: "bodies", hint: "Leave empty for every body." }];
export const FIT_OPTIONS: Option[] = [{ value: "close", label: "Close" }, { value: "normal", label: "Normal" }, { value: "loose", label: "Loose" }];
export const clearanceOf = (f: Fastener, fit: unknown): number => f.clearance[fit === "close" ? 0 : fit === "loose" ? 2 : 1];
