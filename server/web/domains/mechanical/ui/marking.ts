// marking.ts — the marking menu: a right click puts the eight tools most wanted where the pointer is, one in each
// direction, so a tool is a direction of the hand and not a place on the bar; the ordinary menu for what is under
// the pointer hangs below it.  A flick (a short, quick drag with the right button) runs the tool in that
// direction without the menu ever being drawn.  Pure: which tools, which direction, what counts as a flick.

/** The directions in the order the wedges are kept: N first, then clockwise. */
export const DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type Direction = (typeof DIRECTIONS)[number];
/** the distance of a wedge's label from the middle, and the middle's own radius, where nothing is chosen */
export const RADIUS = 96, DEAD = 22;

/** The wedge a point lies in, seen from the middle (screen pixels, y down); -1 inside the dead zone. */
export function wedgeAt(dx: number, dy: number, dead = DEAD): number {
  if (Math.hypot(dx, dy) < dead) return -1;
  const turn = Math.atan2(dx, -dy) / (Math.PI / 4);   // 0 at N, clockwise, in eighths of a turn
  return ((Math.round(turn) % 8) + 8) % 8;
}
/** Where a wedge's label sits, from the middle. */
export function wedgePlace(i: number, r = RADIUS): { x: number; y: number } {
  const a = (i * Math.PI) / 4;
  // the labels left and right are wide: the ring is a little wider than it is tall
  return { x: Math.round(Math.sin(a) * r * 1.18), y: Math.round(-Math.cos(a) * r) };
}

/** A drag with the right button is a flick when it is short in time, long enough to have a direction, and straight. */
export const FLICK = { ms: 260, min: 44, max: 420 };
export function flickWedge(dx: number, dy: number, ms: number, travelled = Math.hypot(dx, dy)): number {
  const d = Math.hypot(dx, dy);
  if (ms > FLICK.ms || d < FLICK.min || d > FLICK.max) return -1;
  if (travelled > d * 1.35) return -1;   // a wiggle is not a direction
  return wedgeAt(dx, dy, 0);
}

export type MarkingMode = "model" | "sketch" | "dialog" | "view";
/** A wedge: a command by its id (ui/commands.ts), or one of the few things that are not commands. */
export type MarkingSlot = string | null;
export const REPEAT = "@repeat", ACCEPT = "@accept", CANCEL = "@cancel", FINISH = "@finish", NEXT_FIELD = "@next-field", FIT = "view:fit", NORMAL = "view:normal";

/**
 * The eight tools for where the part studio is, N first and clockwise.  Up is "again"; undo is always to the
 * left; what ends the mode (finish the sketch, cancel the dialog) is always down.
 */
export function markingSlots(mode: MarkingMode, o: { edge?: boolean } = {}): MarkingSlot[] {
  if (mode === "sketch") return [REPEAT, "sketch-line", "sketch-rectangle", "sketch-circle", FINISH, "sketch-dimension", "undo", "sketch-trim"];
  if (mode === "dialog") return [ACCEPT, null, NEXT_FIELD, null, CANCEL, null, null, null];
  if (mode === "view") return [null, FIT, "measure", null, "section-view", null, null, NORMAL];
  return [REPEAT, "f:sketch", "press-pull", "f:extrude", "measure", o.edge ? "f:chamfer" : "f:fillet", "undo", "redo"];
}

/** Where the ring and the list under it go for a click at (x, y) in a window: both wholly on screen. */
export function markingPlace(x: number, y: number, w: number, h: number, listHeight: number, listWidth = 220): { cx: number; cy: number; listLeft: number; listTop: number } {
  const padX = Math.round(RADIUS * 1.18) + 70, padY = RADIUS + 22;
  const cx = Math.max(padX, Math.min(x, w - padX)), cy = Math.max(padY, Math.min(y, h - padY));
  const below = cy + padY + 6, above = cy - padY - 6 - listHeight;
  const listTop = below + listHeight <= h - 6 ? below : above >= 6 ? above : Math.max(6, h - listHeight - 6);
  // when the list fits neither below nor above the ring it stands beside it
  const beside = below + listHeight > h - 6 && above < 6;
  const reach = padX + 150;   // the labels left and right of the ring are long
  const listLeft = beside ? (cx + reach + listWidth + 6 <= w ? cx + reach : Math.max(6, cx - reach - listWidth)) : Math.max(6, Math.min(cx - listWidth / 2, w - listWidth - 6));
  return { cx, cy, listLeft: Math.round(listLeft), listTop: Math.round(listTop) };
}
