// viewkeys.ts — Onshape's keys for turning the view without a mouse, for any Viewport3D (the part studio and the
// assembly both take them, studio.ts onKey and assembly.ts onKey):
//
//   ← → ↑ ↓              turn the view 15° about the screen's vertical (← →) or horizontal (↑ ↓) axis
//   Shift + ← → ↑ ↓      the same, 90°
//   Ctrl/Cmd + ← →       roll the view 15° about the line of sight (←: counter-clockwise)
//   Ctrl/Cmd+Shift + ← → roll it 90° (as the view cube's curved arrows do)
//   Shift + 1 … 7        Front, Back, Left, Right, Top, Bottom, Isometric
//
// Every turn is animated as the view cube's are (Viewport3D.rotateBy, setView).  F (zoom to fit) and N (normal
// to) are the editors' own, because what they fit or face is theirs.  `VIEW_KEYS` is the same list for the sheet
// of keys and the view cube's tooltips.
import type { StandardView, Viewport3D } from "../../../shared/viewport3d/viewport3d";

/** The standard views in the order Shift + 1 … 7 reach them. */
export const NUMBERED_VIEWS: readonly StandardView[] = ["front", "back", "left", "right", "top", "bottom", "iso"];
/** The key that turns to a standard view: "Shift+1" for the front. */
export const viewShortcut = (view: StandardView): string => `Shift+${NUMBERED_VIEWS.indexOf(view) + 1}`;

/** A small turn and a big one, in degrees. */
export const STEP = 15, BIG_STEP = 90;
/** What the platform calls the modifier that rolls: "Cmd" on a Mac, "Ctrl" elsewhere. */
export const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "Cmd" : "Ctrl";

/** The keys and what they do, for the sheet of keys. */
export const VIEW_KEYS: readonly [string, string][] = [
  ["← → ↑ ↓", `Turn the view ${STEP}°`],
  ["Shift+← → ↑ ↓", `Turn the view ${BIG_STEP}°`],
  [`${MOD}+← →`, `Roll the view ${STEP}°`],
  [`${MOD}+Shift+← →`, `Roll the view ${BIG_STEP}°`],
  ["Shift+1 … 6", "Front, back, left, right, top, bottom"],
  ["Shift+7", "Isometric"],
];

/** True when this key event is one of the view keys; it has then turned the view (and is not marked as used: the caller does that). */
export function viewKey(viewport: Viewport3D, ev: KeyboardEvent): boolean {
  if (ev.altKey) return false;
  const mod = ev.ctrlKey || ev.metaKey;
  // Shift + a digit: by the key's place, so that it is the same on every keyboard layout
  if (ev.shiftKey && !mod && /^Digit[1-7]$/.test(ev.code)) { viewport.setView(NUMBERED_VIEWS[Number(ev.code.slice(5)) - 1]); return true; }
  if (!ev.key.startsWith("Arrow")) return false;
  const step = ((ev.shiftKey ? BIG_STEP : STEP) * Math.PI) / 180;
  if (mod) {
    // the line of sight: Ctrl+← rolls the picture counter-clockwise, as the cube's left curved arrow does
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return false;
    viewport.rotateBy(0, 0, true, ev.key === "ArrowLeft" ? step : -step);
    return true;
  }
  viewport.rotateBy(ev.key === "ArrowLeft" ? -step : ev.key === "ArrowRight" ? step : 0, ev.key === "ArrowUp" ? -step : ev.key === "ArrowDown" ? step : 0);
  return true;
}
