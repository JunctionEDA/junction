// viewprefs.ts — how one person likes the 3D viewports drawn: kept in this browser, shared by every modelling
// domain (a part studio and an assembly look the same), never in a document.
//
//   mode      how parts are drawn (the part studio's display modes)
//   ground    the soft shadow under the model
//   ao        the shading where surfaces meet, and the outline round the parts
//   inertia   the view keeps turning for a moment after an orbit is let go
export type ViewDisplayMode = "shaded-edges" | "shaded" | "hidden-line" | "wireframe" | "translucent";
export interface ViewPrefs { mode: ViewDisplayMode; ground: boolean; ao: boolean; inertia: boolean }

const DEFAULTS: ViewPrefs = { mode: "shaded-edges", ground: true, ao: true, inertia: false };
const MODES: readonly string[] = ["shaded-edges", "shaded", "hidden-line", "wireframe", "translucent"];
const KEY = "junction.cad.view";

function read(): ViewPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (!v || typeof v !== "object") return DEFAULTS;
    return { mode: MODES.includes(v.mode) ? v.mode : DEFAULTS.mode, ground: v.ground !== false, ao: v.ao !== false, inertia: v.inertia === true };
  } catch { return DEFAULTS; }
}
let prefs: ViewPrefs = read();
const listeners = new Set<() => void>();

export const getViewPrefs = (): ViewPrefs => prefs;
export function setViewPrefs(patch: Partial<ViewPrefs>): void {
  prefs = { ...prefs, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode: it lasts as long as the page */ }
  for (const fn of Array.from(listeners)) fn();
}
export const subscribeViewPrefs = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** "high" or "low" when a person (or a test) asked for one outright: `localStorage["junction.cad.quality"]`. */
export function forcedQuality(): "high" | "low" | null {
  try { const v = localStorage.getItem("junction.cad.quality"); return v === "high" || v === "low" ? v : null; } catch { return null; }
}
