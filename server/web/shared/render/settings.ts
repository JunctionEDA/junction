// settings.ts — what a person chooses about a rendered picture (the lights, the ground, the backdrop, exposure,
// focus, how long to spend on it) and about a turntable film.  Pure; kept in this browser like the other view
// preferences (shared/viewport3d/viewprefs.ts), never in a document.
import { DEFAULT_ENVIRONMENT, ENVIRONMENTS, type EnvironmentId } from "./environments";
import type { ToneMap } from "./tonemap";
import type { TurntablePath, Vec3 } from "./turntable";

/** What the model stands on: a floor that only shows the shadow it catches, a glossy floor that also mirrors it, or nothing. */
export type GroundMode = "shadow" | "glossy" | "none";
export const GROUNDS: readonly { id: GroundMode; title: string; hint: string }[] = [
  { id: "shadow", title: "Shadow", hint: "The backdrop carries on under the model and shows its shadow" },
  { id: "glossy", title: "Floor", hint: "A glossy floor that mirrors the model" },
  { id: "none", title: "None", hint: "Nothing under the model" },
];
/** What is behind the model: a plain colour, the lighting environment itself, or nothing (a PNG with transparency). */
export type BackgroundMode = "color" | "environment" | "transparent";
export const BACKGROUNDS: readonly { id: BackgroundMode; title: string }[] = [{ id: "color", title: "Colour" }, { id: "environment", title: "Environment" }, { id: "transparent", title: "Transparent" }];

export type QualityId = "draft" | "standard" | "high";
export interface QualityPreset {
  id: QualityId; title: string; hint: string;
  /** samples per pixel the picture is refined to */
  samples: number;
  /** how many times light may bounce, and how many more surfaces of a clear solid it may pass */
  bounces: number; transmissiveBounces: number;
  /** the share of the viewport's pixels (each way) the live picture is traced at */
  scale: number;
  /** the most a single sample may add to a pixel, in units of a white card's brightness (what keeps fireflies out) */
  clamp: number;
}
export const QUALITIES: readonly QualityPreset[] = [
  { id: "draft", title: "Draft", hint: "Quick: half resolution, 64 samples", samples: 64, bounces: 4, transmissiveBounces: 6, scale: 0.5, clamp: 24 },
  { id: "standard", title: "Standard", hint: "256 samples at full resolution", samples: 256, bounces: 7, transmissiveBounces: 10, scale: 1, clamp: 48 },
  { id: "high", title: "High", hint: "1500 samples: for glass, and for the picture you keep", samples: 1500, bounces: 12, transmissiveBounces: 16, scale: 1, clamp: 96 },
];
export const qualityOf = (id: unknown): QualityPreset => QUALITIES.find((q) => q.id === id) || QUALITIES[1];

export interface RenderSettings {
  environment: EnvironmentId;
  /** the lights turned about the vertical, degrees */
  rotation: number;
  /** the lights' brightness, 1 as designed */
  intensity: number;
  /** the lights stay where they are in the picture as the view turns (a photographer's lights: the model turns under them) */
  follow: boolean;
  ground: GroundMode;
  background: BackgroundMode;
  /** "#rrggbb", or null for the colour that suits the environment */
  backgroundColor: string | null;
  /** stops */
  exposure: number;
  tone: ToneMap;
  /** depth of field: on, the lens's f-number, and the point in focus (null: the point the view turns about) */
  dof: boolean; fstop: number; focus: Vec3 | null;
  quality: QualityId;
  denoise: boolean;
}

export const DEFAULT_SETTINGS: RenderSettings = {
  environment: DEFAULT_ENVIRONMENT, rotation: 0, intensity: 1, follow: true,
  ground: "shadow", background: "color", backgroundColor: null,
  exposure: 0, tone: "agx", dof: false, fstop: 4, focus: null, quality: "standard", denoise: true,
};

const num = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const one = <T extends string>(v: unknown, of: readonly T[], d: T): T => (of.includes(v as T) ? (v as T) : d);
const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

/** Settings from anything (what was stored, what a test passed): every field checked, the rest defaulted. */
export function cleanSettings(raw: unknown): RenderSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>, d = DEFAULT_SETTINGS;
  const focus = Array.isArray(r.focus) && r.focus.length === 3 && r.focus.every((v) => typeof v === "number" && Number.isFinite(v)) ? (r.focus as Vec3) : null;
  return {
    environment: one(r.environment, ENVIRONMENTS.map((e) => e.id), d.environment),
    rotation: ((num(r.rotation, -3600, 3600, 0) % 360) + 360) % 360, intensity: num(r.intensity, 0.05, 8, 1), follow: r.follow !== false,
    ground: one(r.ground, GROUNDS.map((g) => g.id), d.ground), background: one(r.background, BACKGROUNDS.map((b) => b.id), d.background),
    backgroundColor: isHex(r.backgroundColor) ? r.backgroundColor.toLowerCase() : null,
    exposure: num(r.exposure, -6, 6, 0), tone: one(r.tone, ["agx", "aces"] as const, d.tone),
    dof: r.dof === true, fstop: num(r.fstop, 0.7, 64, d.fstop), focus,
    quality: one(r.quality, QUALITIES.map((q) => q.id), d.quality), denoise: r.denoise !== false,
  };
}

const KEY = "junction.cad.render";
export function loadSettings(): RenderSettings {
  // where the focus is belongs to one model, one view: it is not kept
  try { return { ...cleanSettings(JSON.parse(localStorage.getItem(KEY) || "{}")), focus: null }; } catch { return { ...DEFAULT_SETTINGS }; }
}
export function storeSettings(s: RenderSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify({ ...s, focus: null })); } catch { /* private mode: it lasts as long as the page */ }
}

/** Sizes a still is saved at.  "view" is the viewport as it is on screen. */
export const IMAGE_SIZES: readonly { id: string; title: string; width: number; height: number }[] = [
  { id: "view", title: "As on screen", width: 0, height: 0 },
  { id: "hd", title: "1280 × 720", width: 1280, height: 720 },
  { id: "fhd", title: "1920 × 1080", width: 1920, height: 1080 },
  { id: "qhd", title: "2560 × 1440", width: 2560, height: 1440 },
  { id: "uhd", title: "3840 × 2160 (4K)", width: 3840, height: 2160 },
  { id: "square", title: "2048 × 2048", width: 2048, height: 2048 },
  { id: "poster", title: "5120 × 2880 (5K)", width: 5120, height: 2880 },
];
/** The largest side a still may have: tiles keep the graphics memory bounded, the finished picture itself is held in ordinary memory (4 bytes a pixel). */
export const MAX_IMAGE_SIDE = 8192;

export interface TurntableSettings {
  /** seconds */
  duration: number; fps: number;
  width: number; height: number;
  /** samples per pixel in each frame */
  samples: number;
  /** degrees above the table's plane; null keeps the view's own */
  elevation: number | null;
  path: TurntablePath;
  /** degrees climbed, for "rise" */
  rise: number;
  /** which way the table turns about: the model's vertical, or one of the others */
  axis: "z" | "x" | "y";
  /** times round */
  turns: number;
}
export const DEFAULT_TURNTABLE: TurntableSettings = { duration: 6, fps: 30, width: 1280, height: 720, samples: 48, elevation: null, path: "orbit", rise: 25, axis: "z", turns: 1 };
export const TURNTABLE_SIZES: readonly { title: string; width: number; height: number }[] = [
  { title: "640 × 360", width: 640, height: 360 }, { title: "1280 × 720", width: 1280, height: 720 }, { title: "1920 × 1080", width: 1920, height: 1080 },
  { title: "1080 × 1080", width: 1080, height: 1080 }, { title: "3840 × 2160 (4K)", width: 3840, height: 2160 },
];
export function cleanTurntable(raw: unknown): TurntableSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>, d = DEFAULT_TURNTABLE;
  return {
    duration: num(r.duration, 0.1, 120, d.duration), fps: Math.round(num(r.fps, 1, 60, d.fps)),
    width: Math.round(num(r.width, 16, MAX_IMAGE_SIDE, d.width)), height: Math.round(num(r.height, 16, MAX_IMAGE_SIDE, d.height)),
    samples: Math.round(num(r.samples, 1, 4096, d.samples)),
    elevation: typeof r.elevation === "number" && Number.isFinite(r.elevation) ? Math.max(-89, Math.min(89, r.elevation)) : null,
    path: one(r.path, ["orbit", "rise"] as const, d.path), rise: num(r.rise, -89, 89, d.rise),
    axis: one(r.axis, ["z", "x", "y"] as const, d.axis), turns: num(r.turns, -8, 8, d.turns) || 1,
  };
}
