// tools/axis-lock.ts — the arrow keys' axis lock of a move in progress (SCH_MOVE_TOOL::Main, sch_move_tool.cpp
// 872-927, and EDIT_TOOL::doMoveSelection, edit_tool_move_fct.cpp 1330-1384).
//
// While items are moving, an arrow key (ACTIONS::cursorLeft / Right / Up / Down and their fast forms) steps the
// cursor by the grid and locks the move to that key's axis: Left or Right locks it horizontal, Up or Down vertical.
// The lock holds for the mouse as well (the cursor keeps the locked coordinate of the previous position) until the
// opposite key of the same axis is pressed; a key of the other axis moves the lock there.
//
// The editor's cursor keys (editor/crosshair.ts cursorStep) post a pointer move at the new cursor position and say
// which key made it through `window.KiCadKeyboardCursor` for the length of that one event.

export type ArrowKey = "left" | "right" | "up" | "down";
export type AxisLock = "" | "h" | "v";
export interface AxisLockState { lock: AxisLock; lastKey: ArrowKey | null }

export const newAxisLock = (): AxisLockState => ({ lock: "", lastKey: null });

const OPPOSITE: Record<ArrowKey, ArrowKey> = { left: "right", right: "left", up: "down", down: "up" };

/** The lock after one arrow key (the C++'s if / else ladder). */
export function axisLockKey(s: AxisLockState, key: ArrowKey): AxisLockState {
  const axis: AxisLock = key === "left" || key === "right" ? "h" : "v";
  let lock = s.lock;
  if (lock === axis) { if (s.lastKey === OPPOSITE[key]) lock = ""; }   // the opposite key of the locked axis unlocks; the same direction keeps it
  else lock = axis;
  return { lock, lastKey: key };
}

/** The cursor with the locked coordinate held at the previous position. */
export function applyAxisLock(lock: AxisLock, p: number[], prev: number[]): number[] {
  if (lock === "h") return [p[0], prev[1]];
  if (lock === "v") return [prev[0], p[1]];
  return p;
}

/** The arrow key behind the pointer event being handled, if the editor's cursor keys posted it. */
export function keyboardCursorKey(): ArrowKey | null {
  const g = (typeof window !== "undefined" ? window : globalThis) as unknown as { KiCadKeyboardCursor?: ArrowKey | null };
  return g.KiCadKeyboardCursor || null;
}
