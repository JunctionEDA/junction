// _cf-drive-data.ts — the standard sizes the power transmission features (cf-drive-*.ts) read: parallel keys,
// retaining rings, ball bearings, roller chains, V-belt sections, timing belt teeth, straight-sided splines.
// Pure data, in millimetres; the features say which standard each table follows.

/** DIN 6885-1 parallel keys: for a shaft over `over` up to `to`, key width b and height h, depth in the shaft t1, in the hub t2. */
export const KEYS: readonly { over: number; to: number; b: number; h: number; t1: number; t2: number }[] = [
  { over: 6, to: 8, b: 2, h: 2, t1: 1.2, t2: 1.0 }, { over: 8, to: 10, b: 3, h: 3, t1: 1.8, t2: 1.4 }, { over: 10, to: 12, b: 4, h: 4, t1: 2.5, t2: 1.8 },
  { over: 12, to: 17, b: 5, h: 5, t1: 3.0, t2: 2.3 }, { over: 17, to: 22, b: 6, h: 6, t1: 3.5, t2: 2.8 }, { over: 22, to: 30, b: 8, h: 7, t1: 4.0, t2: 3.3 },
  { over: 30, to: 38, b: 10, h: 8, t1: 5.0, t2: 3.3 }, { over: 38, to: 44, b: 12, h: 8, t1: 5.0, t2: 3.3 }, { over: 44, to: 50, b: 14, h: 9, t1: 5.5, t2: 3.8 },
  { over: 50, to: 58, b: 16, h: 10, t1: 6.0, t2: 4.3 }, { over: 58, to: 65, b: 18, h: 11, t1: 7.0, t2: 4.4 }, { over: 65, to: 75, b: 20, h: 12, t1: 7.5, t2: 4.9 },
  { over: 75, to: 85, b: 22, h: 14, t1: 9.0, t2: 5.4 }, { over: 85, to: 95, b: 25, h: 14, t1: 9.0, t2: 5.4 }, { over: 95, to: 110, b: 28, h: 16, t1: 10.0, t2: 6.4 },
  { over: 110, to: 130, b: 32, h: 18, t1: 11.0, t2: 7.4 }, { over: 130, to: 150, b: 36, h: 20, t1: 12.0, t2: 8.4 },
];
/** The key for a shaft diameter (over … up to and including), or null outside 6 to 150 mm. */
export const keyFor = (d: number) => KEYS.find((k) => d > k.over + 1e-9 && d <= k.to + 1e-9) || null;

/** DIN 471 retaining rings for shafts: nominal shaft d1, groove diameter d2, groove width m. */
export const RINGS_SHAFT: readonly [number, number, number][] = [
  [3, 2.8, 0.5], [4, 3.8, 0.5], [5, 4.8, 0.7], [6, 5.7, 0.8], [7, 6.7, 0.9], [8, 7.6, 0.9], [9, 8.6, 1.1], [10, 9.6, 1.1], [11, 10.5, 1.1], [12, 11.5, 1.1],
  [13, 12.4, 1.1], [14, 13.4, 1.1], [15, 14.3, 1.1], [16, 15.2, 1.1], [17, 16.2, 1.1], [18, 17, 1.3], [19, 18, 1.3], [20, 19, 1.3], [21, 20, 1.3], [22, 21, 1.3],
  [24, 22.9, 1.3], [25, 23.9, 1.3], [26, 24.9, 1.3], [28, 26.6, 1.6], [30, 28.6, 1.6], [32, 30.3, 1.6], [34, 32.3, 1.6], [35, 33, 1.6], [36, 34, 1.85],
  [38, 36, 1.85], [40, 37.5, 1.85], [42, 39.5, 1.85], [45, 42.5, 1.85], [48, 45.5, 1.85], [50, 47, 2.15], [52, 49, 2.15], [55, 52, 2.15], [56, 53, 2.15],
  [58, 55, 2.15], [60, 57, 2.15], [62, 59, 2.15], [63, 60, 2.15], [65, 62, 2.65], [68, 65, 2.65], [70, 67, 2.65], [72, 69, 2.65], [75, 72, 2.65], [78, 75, 2.65],
  [80, 76.5, 2.65], [82, 78.5, 2.65], [85, 81.5, 3.15], [88, 84.5, 3.15], [90, 86.5, 3.15], [95, 91.5, 3.15], [100, 96.5, 3.15],
];
/** DIN 472 retaining rings for bores: nominal bore d1, groove diameter d2, groove width m. */
export const RINGS_BORE: readonly [number, number, number][] = [
  [8, 8.4, 0.9], [9, 9.4, 0.9], [10, 10.4, 1.1], [11, 11.4, 1.1], [12, 12.5, 1.1], [13, 13.6, 1.1], [14, 14.6, 1.1], [15, 15.7, 1.1], [16, 16.8, 1.1], [17, 17.8, 1.1],
  [18, 19, 1.1], [19, 20, 1.1], [20, 21, 1.1], [21, 22, 1.1], [22, 23, 1.1], [24, 25.2, 1.3], [25, 26.2, 1.3], [26, 27.2, 1.3], [28, 29.4, 1.3], [30, 31.4, 1.3],
  [32, 33.7, 1.3], [34, 35.7, 1.6], [35, 37, 1.6], [36, 38, 1.6], [37, 39, 1.6], [38, 40, 1.6], [40, 42.5, 1.85], [42, 44.5, 1.85], [45, 47.5, 1.85], [47, 49.5, 1.85],
  [48, 50.5, 1.85], [50, 53, 2.15], [52, 55, 2.15], [55, 58, 2.15], [56, 59, 2.15], [58, 61, 2.15], [60, 63, 2.15], [62, 65, 2.15], [63, 66, 2.15], [65, 68, 2.65],
  [68, 71, 2.65], [70, 73, 2.65], [72, 75, 2.65], [75, 78, 2.65], [78, 81, 2.65], [80, 83.5, 2.65], [85, 88.5, 3.15], [90, 93.5, 3.15], [95, 98.5, 3.15], [100, 103.5, 3.15],
];

/** Deep groove ball bearings (ISO 15 boundary dimensions): bore d, outside diameter D, width B. */
export const BEARINGS: { readonly [number: string]: readonly [number, number, number] } = {
  "623": [3, 10, 4], "624": [4, 13, 5], "625": [5, 16, 5], "626": [6, 19, 6], "627": [7, 22, 7], "608": [8, 22, 7], "629": [9, 26, 8],
  "604": [4, 12, 4], "605": [5, 14, 5], "606": [6, 17, 6], "607": [7, 19, 6], "609": [9, 24, 7],
  "685": [5, 11, 5], "686": [6, 13, 5], "688": [8, 16, 5], "693": [3, 8, 4], "695": [5, 13, 4], "696": [6, 15, 5], "698": [8, 19, 6],
  "MR105": [5, 10, 4], "MR115": [5, 11, 4], "MR126": [6, 12, 4], "MR128": [8, 12, 3.5],
  "6000": [10, 26, 8], "6001": [12, 28, 8], "6002": [15, 32, 9], "6003": [17, 35, 10], "6004": [20, 42, 12], "6005": [25, 47, 12], "6006": [30, 55, 13],
  "6007": [35, 62, 14], "6008": [40, 68, 15], "6009": [45, 75, 16], "6010": [50, 80, 16],
  "6200": [10, 30, 9], "6201": [12, 32, 10], "6202": [15, 35, 11], "6203": [17, 40, 12], "6204": [20, 47, 14], "6205": [25, 52, 15], "6206": [30, 62, 16],
  "6207": [35, 72, 17], "6208": [40, 80, 18], "6209": [45, 85, 19], "6210": [50, 90, 20],
  "6300": [10, 35, 11], "6301": [12, 37, 12], "6302": [15, 42, 13], "6303": [17, 47, 14], "6304": [20, 52, 15], "6305": [25, 62, 17], "6306": [30, 72, 19],
  "6307": [35, 80, 21], "6308": [40, 90, 23],
  "6800": [10, 19, 5], "6801": [12, 21, 5], "6802": [15, 24, 5], "6803": [17, 26, 5], "6804": [20, 32, 7], "6805": [25, 37, 7], "6806": [30, 42, 7],
  "6900": [10, 22, 6], "6901": [12, 24, 6], "6902": [15, 28, 7], "6903": [17, 30, 7], "6904": [20, 37, 9], "6905": [25, 42, 9], "6906": [30, 47, 9],
};

/** Roller chains (ANSI B29.1 numbers, ISO 606 B series): pitch, roller diameter d1, width between inner plates b1, plate height. */
export const CHAINS: { readonly [size: string]: { label: string; p: number; d1: number; b1: number; h: number } } = {
  "25": { label: "ANSI 25 (1/4 in)", p: 6.35, d1: 3.3, b1: 3.18, h: 6.0 },
  "35": { label: "ANSI 35 (3/8 in)", p: 9.525, d1: 5.08, b1: 4.77, h: 9.0 },
  "40": { label: "ANSI 40 (1/2 in)", p: 12.7, d1: 7.92, b1: 7.85, h: 12.0 },
  "41": { label: "ANSI 41 (1/2 in, narrow)", p: 12.7, d1: 7.77, b1: 6.25, h: 9.9 },
  "50": { label: "ANSI 50 (5/8 in)", p: 15.875, d1: 10.16, b1: 9.4, h: 15.0 },
  "60": { label: "ANSI 60 (3/4 in)", p: 19.05, d1: 11.91, b1: 12.57, h: 18.0 },
  "80": { label: "ANSI 80 (1 in)", p: 25.4, d1: 15.88, b1: 15.75, h: 24.0 },
  "100": { label: "ANSI 100 (1 1/4 in)", p: 31.75, d1: 19.05, b1: 18.9, h: 30.0 },
  "04B": { label: "ISO 04B (6 mm)", p: 6, d1: 4.0, b1: 2.8, h: 5.0 },
  "05B": { label: "ISO 05B (8 mm)", p: 8, d1: 5.0, b1: 3.0, h: 7.1 },
  "06B": { label: "ISO 06B (3/8 in)", p: 9.525, d1: 6.35, b1: 5.72, h: 8.2 },
  "08B": { label: "ISO 08B (1/2 in)", p: 12.7, d1: 8.51, b1: 7.75, h: 11.8 },
  "10B": { label: "ISO 10B (5/8 in)", p: 15.875, d1: 10.16, b1: 9.65, h: 14.7 },
  "12B": { label: "ISO 12B (3/4 in)", p: 19.05, d1: 12.07, b1: 11.68, h: 16.1 },
  "16B": { label: "ISO 16B (1 in)", p: 25.4, d1: 15.88, b1: 17.02, h: 21.0 },
  "20B": { label: "ISO 20B (1 1/4 in)", p: 31.75, d1: 19.05, b1: 19.56, h: 26.4 },
};

/**
 * V-belt pulley grooves (ISO 4183 classical and narrow sections): pitch width wd, groove above the pitch line
 * b, below it h (classical) and hn (narrow), groove spacing e, edge to first groove f, and the pitch diameter
 * up to which the groove angle is 34° (38° above).
 */
export const VBELTS: { readonly [section: string]: { label: string; wd: number; b: number; h: number; e: number; f: number; small: number } } = {
  Z: { label: "Z / 10", wd: 8.5, b: 2.0, h: 7.0, e: 12, f: 7, small: 80 },
  SPZ: { label: "SPZ", wd: 8.5, b: 2.0, h: 9.0, e: 12, f: 8, small: 80 },
  A: { label: "A / 13", wd: 11, b: 2.75, h: 8.7, e: 15, f: 9, small: 118 },
  SPA: { label: "SPA", wd: 11, b: 2.75, h: 11.0, e: 15, f: 10, small: 118 },
  B: { label: "B / 17", wd: 14, b: 3.5, h: 10.8, e: 19, f: 11.5, small: 190 },
  SPB: { label: "SPB", wd: 14, b: 3.5, h: 14.0, e: 19, f: 12.5, small: 190 },
  C: { label: "C / 22", wd: 19, b: 4.8, h: 14.3, e: 25.5, f: 16, small: 315 },
  SPC: { label: "SPC", wd: 19, b: 4.8, h: 19.0, e: 25.5, f: 17, small: 315 },
};

/**
 * Timing belt teeth.  `pld` is the pitch line differential: the pitch line lies that far outside the pulley's
 * outside diameter (pulley OD = teeth × pitch / π − 2 × pld).  The tooth is drawn across the belt: `round`
 * teeth (GT, HTD) by the radii of the profile, `trapezoid` teeth (T series, DIN 7721) by root width and angle.
 *   GT2 / GT3: the tooth bottom is an arc r3; the flanks are arcs r2 whose centres lie `b` across the centre
 *   line on the tooth's base line; r1 rounds the corner to the land.
 *   HTD: the tooth bottom is half a circle r; r1 rounds the corner to the land.
 */
export type BeltTooth =
  | { kind: "gt"; h: number; r1: number; r2: number; r3: number; b: number }
  | { kind: "htd"; h: number; r: number; r1: number }
  | { kind: "trapezoid"; h: number; root: number; angle: number; r1: number };
export const BELTS: { readonly [profile: string]: { label: string; pitch: number; pld: number; back: number; tooth: BeltTooth } } = {
  GT2: { label: "GT2 (2 mm)", pitch: 2, pld: 0.254, back: 0.63, tooth: { kind: "gt", h: 0.75, r1: 0.15, r2: 1.0, r3: 0.555, b: 0.4 } },
  GT3: { label: "GT3 (3 mm)", pitch: 3, pld: 0.381, back: 1.27, tooth: { kind: "gt", h: 1.14, r1: 0.25, r2: 1.52, r3: 0.85, b: 0.61 } },
  HTD3M: { label: "HTD 3M", pitch: 3, pld: 0.381, back: 1.19, tooth: { kind: "htd", h: 1.17, r: 0.86, r1: 0.26 } },
  HTD5M: { label: "HTD 5M", pitch: 5, pld: 0.5715, back: 1.74, tooth: { kind: "htd", h: 2.06, r: 1.49, r1: 0.43 } },
  HTD8M: { label: "HTD 8M", pitch: 8, pld: 0.6858, back: 2.64, tooth: { kind: "htd", h: 3.36, r: 2.46, r1: 0.7 } },
  "T2.5": { label: "T2.5", pitch: 2.5, pld: 0.3, back: 0.6, tooth: { kind: "trapezoid", h: 0.7, root: 1.5, angle: 40, r1: 0.2 } },
  T5: { label: "T5", pitch: 5, pld: 0.425, back: 1.0, tooth: { kind: "trapezoid", h: 1.2, root: 2.65, angle: 40, r1: 0.4 } },
  T10: { label: "T10", pitch: 10, pld: 0.925, back: 2.0, tooth: { kind: "trapezoid", h: 2.5, root: 5.3, angle: 40, r1: 0.6 } },
};

/** ISO 14 straight-sided splines: number of keys N, small diameter d, large diameter D, key width B. */
export const SPLINES: { readonly [size: string]: readonly [number, number, number, number] } = {
  "6x11x14": [6, 11, 14, 3], "6x13x16": [6, 13, 16, 3.5], "6x16x20": [6, 16, 20, 4], "6x18x22": [6, 18, 22, 5], "6x21x25": [6, 21, 25, 5],
  "6x23x26": [6, 23, 26, 6], "6x23x28": [6, 23, 28, 6], "6x26x30": [6, 26, 30, 6], "6x26x32": [6, 26, 32, 6], "6x28x32": [6, 28, 32, 7], "6x28x34": [6, 28, 34, 7],
  "8x32x36": [8, 32, 36, 6], "8x32x38": [8, 32, 38, 6], "8x36x40": [8, 36, 40, 7], "8x36x42": [8, 36, 42, 7], "8x42x46": [8, 42, 46, 8], "8x42x48": [8, 42, 48, 8],
  "8x46x50": [8, 46, 50, 9], "8x46x54": [8, 46, 54, 9], "8x52x58": [8, 52, 58, 10], "8x52x60": [8, 52, 60, 10], "8x56x62": [8, 56, 62, 10], "8x56x65": [8, 56, 65, 10],
  "8x62x68": [8, 62, 68, 12], "8x62x72": [8, 62, 72, 12], "10x72x78": [10, 72, 78, 12], "10x72x82": [10, 72, 82, 12],
};
