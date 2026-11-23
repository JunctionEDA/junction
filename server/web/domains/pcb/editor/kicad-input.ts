// kicad-input.ts — the pure rules of KiCad's common tool framework (common/tool/*.cpp) the editor shell follows, kept
// free of the DOM so the tests can run them: the keyboard click's events, the zoom tool's box, the right click's
// selection, the Clarify Selection menu's keys and where the keyboard cursor starts.

export interface SyntheticMods { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }

/**
 * COMMON_TOOLS::CursorControl (common_tools.cpp 156-169): CURSOR_CLICK posts one TA_MOUSE_CLICK, CURSOR_DBL_CLICK one
 * TA_MOUSE_DBLCLICK, both with BUT_LEFT and the modifiers held right now (wxGetKeyState( WXK_SHIFT / CONTROL / ALT )).
 * In the browser's event model a click is pointerdown, pointerup, click; KiCad's IsDblClick is what the tools see as
 * the second press of a double click (a pointerdown whose detail is 2) and the dblclick that follows it, with no click
 * ahead of it.  The events to dispatch, in order, as [type, detail].
 */
export function cursorClickEvents(count: 1 | 2): [string, number][] {
  if (count === 2) return [["pointerdown", 2], ["pointerup", 2], ["dblclick", 2]];
  return [["pointerdown", 1], ["pointerup", 1], ["click", 1]];
}

/** The modifiers a keyboard click carries: the held keys, MD_CTRL being Cmd on macOS. */
export function heldMods(held: { shift: boolean; ctrl: boolean; alt: boolean }, mac: boolean): SyntheticMods {
  return { shiftKey: !!held.shift, ctrlKey: !mac && !!held.ctrl, metaKey: mac && !!held.ctrl, altKey: !!held.alt };
}

/**
 * ZOOM_TOOL::selectRegion (zoom_tool.cpp 84-152), on the release of the box: a click or a box without width or height
 * does nothing; a left drag zooms in so the box fills the view exactly (scale / ratio), a right drag zooms out by the
 * same ratio (scale * ratio), centred on the box either way.  `box` and `view` are the box and the visible area in the
 * same units; null when nothing happens, else the new scale factor relative to now and the centre.
 */
export function zoomRegion(box: { x: number; y: number; w: number; h: number }, view: { w: number; h: number }, zoomOut: boolean): { factor: number; center: [number, number] } | null {
  const w = Math.abs(box.w), h = Math.abs(box.h);
  if (w === 0 || h === 0 || !(view.w > 0) || !(view.h > 0)) return null;
  const ratio = Math.max(w / view.w, h / view.h);
  if (!(ratio > 0) || !isFinite(ratio)) return null;
  const x0 = Math.min(box.x, box.x + box.w), y0 = Math.min(box.y, box.y + box.h);
  return { factor: zoomOut ? ratio : 1 / ratio, center: [x0 + w / 2, y0 + h / 2] };
}

/**
 * The selection a right click works on.  PCB_SELECTION_TOOL (pcb_selection_tool.cpp 514-518) selects under the cursor
 * only when nothing is selected; SCH_SELECTION_TOOL (sch_selection_tool.cpp 996-1024) also when the click is outside
 * the selection's bounding box inflated by one grid step.  True: keep the selection as it is.
 */
export function rightClickKeepsSelection(sch: boolean, selCount: number, bbox: number[] | null, at: number[], grid: number): boolean {
  if (selCount === 0) return false;
  if (!sch) return true;
  if (!bbox) return false;
  return at[0] >= bbox[0] - grid && at[0] <= bbox[2] + grid && at[1] >= bbox[1] - grid && at[1] <= bbox[3] + grid;
}

/**
 * SELECTION_TOOL::selectionMenu's entries carry a hotkey (selection_tool.cpp 337, 352, 355: "&%d  %s\t%d", "Select
 * &All\tA", "Show &More Choices...\tM"): a printable key picks the entry whose key it is, case aside.  The index of
 * the entry, or -1.
 */
export function menuKeyIndex(items: ({ key?: string | null; disabled?: boolean; separator?: boolean } | null | undefined)[], key: string): number {
  if (!key || key.length !== 1) return -1;
  const k = key.toUpperCase();
  return items.findIndex((it) => !!it && !it.separator && !it.disabled && !!it.key && String(it.key).toUpperCase() === k);
}

/**
 * COMMON_TOOLS::CursorControl (common_tools.cpp 118-123): the keys move the keyboard cursor from where it is; when it
 * has no valid position (the mouse moved it last) and the selection has a reference point, from that point.
 */
export function cursorStepOrigin(keyboardAt: number[] | null, selectionRef: number[] | null, mouseAt: number[] | null): number[] | null {
  if (keyboardAt) return keyboardAt;
  if (selectionRef) return selectionRef;
  return mouseAt;
}

/**
 * ACTIONS::redo's hotkey (actions.cpp 294-301): Cmd+Shift+Z on macOS, Ctrl+Y on Windows and Linux; nothing else.
 * `ctrl` is MD_CTRL (Cmd on a Mac).
 */
export function redoCombo(mac: boolean, k: { ctrl: boolean; shift: boolean; alt: boolean; key: string }): boolean {
  if (!k.ctrl || k.alt) return false;
  const key = k.key.toLowerCase();
  return mac ? k.shift && key === "z" : !k.shift && key === "y";
}
