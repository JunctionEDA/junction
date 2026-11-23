// environments.ts — the lighting a rendered picture is made under: photographic studios and a sky, each computed
// here as a high dynamic range panorama.  Pure: no three.js, no DOM, no files, nothing fetched.
//
// An environment is a function from a direction to the light arriving from it (linear sRGB radiance, Y up): a
// dome that fades from its top to its horizon to its floor, with emitters on it — softboxes (rounded rectangles
// with a soft edge and a slightly hotter middle, as fabric in front of a lamp is), strips, and a disc for the sun.
// `buildEnvironment` samples that into an equirectangular image (row 0 is straight down, column 0 is −X turning
// through −Z; what three.js calls an equirectangular map with flipY off) and scales it so that a white card
// lying flat under it has the brightness the set-up asks for (`level`): every environment is exposed alike, and a
// dark one is dark because it was designed so.
//
// The renderer samples this image by importance, so a small bright softbox costs no more noise than a large
// dim one.  Radiance is kept under what a half float holds.

export type EnvironmentId = "softbox" | "overhead" | "three-point" | "white" | "dark" | "sky";

export type Rgb = [number, number, number];
type Dir = [number, number, number];

interface Emitter {
  /** where it is: degrees round from the front (positive to the camera's right when the view is the front) and up from the horizon */
  azimuth: number; elevation: number;
  /** how wide and tall it is seen from the model, degrees; a disc has `width` only */
  width: number; height?: number;
  shape?: "box" | "disc";
  /** radiance at its middle before the environment is levelled, and its tint */
  power: number; color?: Rgb;
  /** how much of its half-width the edge fades over (0 hard … 1 all of it) */
  soft?: number;
  /** turned about its own middle, degrees */
  roll?: number;
}

export interface EnvironmentSpec {
  id: EnvironmentId; title: string; hint: string;
  /** dome radiance straight up, at the horizon, and straight down */
  top: Rgb; horizon: Rgb; floor: Rgb;
  /** how sharply the horizon colour gives way to the top's (higher: a thinner band) */
  band?: number;
  emitters: Emitter[];
  /** the radiance a white card lying flat reflects once levelled (its irradiance over π) */
  level: number;
  /** the backdrop colour that suits it when the background is a plain colour, "#rrggbb" as the picture shows it */
  backdrop: string;
  /** true when the lights are few and hard enough that the picture wants the dark of a dark room behind it */
  dark?: boolean;
  /** the ground that suits it, when it is not the shadow catcher */
  ground?: "glossy" | "none";
}

// colour temperatures as tints (linear sRGB, luminance near 1)
const WARM: Rgb = [1.0, 0.93, 0.84], NEUTRAL: Rgb = [1, 1, 1], COOL: Rgb = [0.86, 0.93, 1.0], SUN: Rgb = [1.0, 0.94, 0.86];

export const ENVIRONMENTS: readonly EnvironmentSpec[] = [
  {
    id: "softbox", title: "Studio softbox", hint: "A large softbox from the upper left, a fill from the right and a rim light behind",
    top: [0.11, 0.11, 0.115], horizon: [0.2, 0.2, 0.21], floor: [0.07, 0.07, 0.07], level: 1.1, backdrop: "#e6e7e9",
    emitters: [
      { azimuth: -36, elevation: 50, width: 34, height: 28, power: 44, color: WARM, soft: 0.22, roll: 8 },
      { azimuth: 62, elevation: 18, width: 70, height: 56, power: 1.3, color: COOL, soft: 0.5 },
      { azimuth: 152, elevation: 24, width: 14, height: 46, power: 11, color: NEUTRAL, soft: 0.3 },
    ],
  },
  {
    id: "overhead", title: "Product light", hint: "One wide light overhead and white cards either side: even, with a soft shadow straight under the part",
    top: [0.22, 0.22, 0.22], horizon: [0.34, 0.34, 0.34], floor: [0.12, 0.12, 0.12], level: 1.15, backdrop: "#ececec",
    emitters: [
      { azimuth: 0, elevation: 84, width: 108, height: 78, power: 6.5, color: NEUTRAL, soft: 0.25 },
      { azimuth: -90, elevation: 12, width: 60, height: 40, power: 0.9, color: NEUTRAL, soft: 0.6 },
      { azimuth: 90, elevation: 12, width: 60, height: 40, power: 0.9, color: NEUTRAL, soft: 0.6 },
    ],
  },
  {
    id: "three-point", title: "Three-point", hint: "Key, fill and back light: the classic portrait set-up, with more contrast than the softbox",
    top: [0.05, 0.05, 0.055], horizon: [0.09, 0.09, 0.095], floor: [0.04, 0.04, 0.04], level: 0.9, backdrop: "#8f9298",
    emitters: [
      { azimuth: -46, elevation: 40, width: 34, height: 34, power: 26, color: WARM, soft: 0.25 },
      { azimuth: 48, elevation: 14, width: 44, height: 44, power: 2.6, color: COOL, soft: 0.45 },
      { azimuth: 178, elevation: 52, width: 26, height: 26, power: 22, color: NEUTRAL, soft: 0.25 },
    ],
  },
  {
    id: "white", title: "Seamless white", hint: "A bright white room: light from everywhere, hardly a shadow",
    top: [1.5, 1.5, 1.5], horizon: [1.05, 1.05, 1.05], floor: [0.8, 0.8, 0.8], band: 1.2, level: 1.35, backdrop: "#f6f6f6",
    emitters: [
      { azimuth: -30, elevation: 62, width: 90, height: 70, power: 2.4, color: NEUTRAL, soft: 0.6 },
    ],
  },
  {
    id: "dark", title: "Dark, strip lights", hint: "A dark room with tall strip lights: for polished metal and glass",
    top: [0.006, 0.006, 0.007], horizon: [0.012, 0.012, 0.014], floor: [0.005, 0.005, 0.005], level: 0.4, backdrop: "#0c0c0e", dark: true, ground: "glossy",
    emitters: [
      { azimuth: -62, elevation: 30, width: 12, height: 84, power: 30, color: COOL, soft: 0.18 },
      { azimuth: 118, elevation: 24, width: 9, height: 80, power: 26, color: WARM, soft: 0.18 },
      { azimuth: 30, elevation: 74, width: 70, height: 10, power: 9, color: NEUTRAL, soft: 0.2 },
      // a dim graded card behind the model: what its flat tops and the floor mirror, so they read as polished
      // rather than as holes
      { azimuth: 180, elevation: 30, width: 110, height: 40, power: 1.1, color: NEUTRAL, soft: 0.9 },
    ],
  },
  {
    id: "sky", title: "Outdoor sky", hint: "A clear sky with the sun to the upper left, over open ground",
    top: [0.14, 0.30, 0.72], horizon: [0.78, 0.86, 0.96], floor: [0.14, 0.13, 0.11], band: 3.2, level: 1.15, backdrop: "#b4cbea",
    emitters: [
      { azimuth: -38, elevation: 42, width: 3.2, shape: "disc", power: 1500, color: SUN, soft: 0.25 },
      // the brightening of the sky round the sun
      { azimuth: -38, elevation: 42, width: 46, shape: "disc", power: 0.5, color: SUN, soft: 1 },
    ],
  },
];
export const DEFAULT_ENVIRONMENT: EnvironmentId = "softbox";
export const environmentSpec = (id: unknown): EnvironmentSpec => ENVIRONMENTS.find((e) => e.id === id) || ENVIRONMENTS[0];

const RAD = Math.PI / 180;
const smooth = (a: number, b: number, x: number): number => { const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-9))); return t * t * (3 - 2 * t); };
const dot = (a: Dir, b: Dir): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Dir, b: Dir): Dir => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Dir): Dir => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** The direction of an azimuth and elevation in degrees: azimuth 0 is +Z (the front), positive towards +X; Y is up. */
export function directionOf(azimuth: number, elevation: number): Dir {
  const a = azimuth * RAD, e = elevation * RAD;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

interface Placed { e: Emitter; c: Dir; right: Dir; up: Dir; hw: number; hh: number; color: Rgb }
function place(e: Emitter): Placed {
  const c = directionOf(e.azimuth, e.elevation);
  // an emitter straight overhead has no "up": its long side lies across the view
  let right = Math.abs(c[1]) > 0.999 ? ([1, 0, 0] as Dir) : unit(cross([0, 1, 0], c));
  let up = cross(c, right);
  if (e.roll) { const r = e.roll * RAD, cs = Math.cos(r), sn = Math.sin(r); const r2: Dir = [right[0] * cs + up[0] * sn, right[1] * cs + up[1] * sn, right[2] * cs + up[2] * sn]; up = cross(c, r2); right = r2; }
  return { e, c, right, up, hw: Math.tan(Math.min(89, e.width / 2) * RAD), hh: Math.tan(Math.min(89, (e.height ?? e.width) / 2) * RAD), color: e.color || NEUTRAL };
}

function emitted(p: Placed, d: Dir): number {
  const along = dot(d, p.c);
  if (along <= 1e-4) return 0;
  const e = p.e, soft = Math.max(0.02, e.soft ?? 0.2);
  if (e.shape === "disc") {
    const angle = Math.acos(Math.min(1, along)) / RAD, r = e.width / 2;
    return e.power * (1 - smooth(r * (1 - soft), r, angle));
  }
  const x = Math.abs(dot(d, p.right) / along) / p.hw, y = Math.abs(dot(d, p.up) / along) / p.hh;
  if (x >= 1 || y >= 1) return 0;
  // a rounded rectangle: the corner radius is the fade's width, measured on the shorter side
  const k = Math.min(p.hw, p.hh), fx = (soft * k) / p.hw, fy = (soft * k) / p.hh;
  const qx = Math.max(0, (x - (1 - fx)) / fx), qy = Math.max(0, (y - (1 - fy)) / fy);
  const edge = 1 - smooth(0, 1, Math.hypot(qx, qy));
  // fabric in front of a lamp: a little hotter in the middle
  const hot = 1 - 0.14 * Math.min(1, x * x + y * y);
  return e.power * edge * hot;
}

/** The light an environment sends from a direction (Y up), before levelling. */
export function radiance(spec: EnvironmentSpec, placed: readonly Placed[], d: Dir, out: Rgb): Rgb {
  const band = spec.band ?? 2;
  const from = d[1] >= 0 ? spec.top : spec.floor, t = Math.pow(Math.abs(d[1]), 1 / band);
  // below the horizon the floor takes over quickly: a studio's floor is one surface
  const k = d[1] >= 0 ? t : smooth(0, 0.18, -d[1]);
  out[0] = spec.horizon[0] + (from[0] - spec.horizon[0]) * k;
  out[1] = spec.horizon[1] + (from[1] - spec.horizon[1]) * k;
  out[2] = spec.horizon[2] + (from[2] - spec.horizon[2]) * k;
  for (const p of placed) {
    const v = emitted(p, d);
    if (v > 0) { out[0] += v * p.color[0]; out[1] += v * p.color[1]; out[2] += v * p.color[2]; }
  }
  return out;
}

export interface EnvironmentImage {
  id: EnvironmentId; width: number; height: number;
  /** RGBA, linear, row 0 at the bottom (straight down) */
  data: Float32Array;
  /** the light falling on a card that lies flat and faces up (irradiance, per channel), after levelling */
  irradianceUp: Rgb;
  /**
   * What a matt ground reflects towards a viewer under these lights with nothing standing on it, per unit of its
   * colour: `flat + f × graze`, where f = (1 − cos θ)⁵ for a viewer θ off the vertical.  It is the renderer's
   * own diffuse reflection (Burley's, at roughness 1) integrated over the panorama, so a shadow catcher can
   * divide by it exactly.
   */
  ground: { flat: Rgb; graze: Rgb };
  /** what the image was multiplied by to reach the set-up's level */
  scale: number;
  /** the brightest value in it */
  peak: number;
}

/** The direction a pixel centre of the panorama looks along (the inverse of `uvOf`). */
export function directionAt(u: number, v: number): Dir {
  const phi = (u - 0.5) * 2 * Math.PI, theta = (v - 0.5) * Math.PI, c = Math.cos(theta);
  return [Math.cos(phi) * c, Math.sin(theta), Math.sin(phi) * c];
}
/** Where a direction falls in the panorama, 0…1 each way (u wraps). */
export function uvOf(d: Dir): [number, number] {
  return [Math.atan2(d[2], d[0]) / (2 * Math.PI) + 0.5, Math.asin(Math.max(-1, Math.min(1, d[1]))) / Math.PI + 0.5];
}

/** The most a pixel may hold: under a half float's largest number, with room for the renderer's intensity control. */
export const MAX_RADIANCE = 12000;

const cache = new Map<string, EnvironmentImage>();

/** An environment as a panorama `width` × `width / 2` (default 1024 × 512), levelled.  Kept: the same call returns the same image. */
export function buildEnvironment(id: EnvironmentId, width = 1024): EnvironmentImage {
  const spec = environmentSpec(id), w = Math.max(16, Math.round(width / 2) * 2), h = w / 2, key = `${spec.id}:${w}`;
  const hit = cache.get(key); if (hit) return hit;
  const placed = spec.emitters.map(place);
  const data = new Float32Array(w * h * 4), px: Rgb = [0, 0, 0];
  const up: [number, number, number] = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h, theta = (v - 0.5) * Math.PI;
    // the solid angle of a pixel of this row, and how squarely it faces a card that lies flat
    const solid = (2 * Math.PI / w) * (Math.PI / h) * Math.cos(theta), facing = Math.max(0, Math.sin(theta));
    for (let x = 0; x < w; x++) {
      radiance(spec, placed, directionAt((x + 0.5) / w, v), px);
      const at = (y * w + x) * 4;
      data[at] = px[0]; data[at + 1] = px[1]; data[at + 2] = px[2]; data[at + 3] = 1;
      up[0] += px[0] * solid * facing; up[1] += px[1] * solid * facing; up[2] += px[2] * solid * facing;
    }
  }
  const lum = 0.2126 * up[0] + 0.7152 * up[1] + 0.0722 * up[2];
  const scale = lum > 0 ? (spec.level * Math.PI) / lum : 1;
  let peak = 0;
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) { const val = Math.min(MAX_RADIANCE, data[i + c] * scale); data[i + c] = val; if (val > peak) peak = val; }
  // the ground's reflection, from the image as the renderer will read it
  const irradiance: Rgb = [0, 0, 0], flat: Rgb = [0, 0, 0], graze: Rgb = [0, 0, 0];
  for (let y = h / 2; y < h; y++) {
    const theta = ((y + 0.5) / h - 0.5) * Math.PI, cos = Math.sin(theta), solid = (2 * Math.PI / w) * (Math.PI / h) * Math.cos(theta);
    const fl = Math.pow(1 - cos, 5), rr = 0.5 + 2 * fl * fl;
    const k0 = ((1 - 0.5 * fl) + rr * fl) * cos * solid / Math.PI, k1 = (-0.5 * (1 - 0.5 * fl) + rr * (1 + fl * (rr - 1))) * cos * solid / Math.PI;
    for (let x = 0; x < w; x++) {
      const at = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) { const v = data[at + c]; irradiance[c] += v * cos * solid; flat[c] += v * k0; graze[c] += v * k1; }
    }
  }
  const img: EnvironmentImage = { id: spec.id, width: w, height: h, data, irradianceUp: irradiance, ground: { flat, graze }, scale, peak };
  cache.set(key, img);
  return img;
}
