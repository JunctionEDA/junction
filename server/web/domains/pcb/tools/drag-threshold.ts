// tools/drag-threshold.ts — TOOL_DISPATCHER's one click-versus-drag test (common/tool/tool_dispatcher.cpp 134-138,
// 215-218, 304-313), shared by the editor shell and the tool modules.
//
// A press becomes a drag once the mouse has moved past the system drag distance on either axis, in screen pixels:
//   m_sysDragMinX = wxSystemSettings::GetMetric( wxSYS_DRAG_X ), DragDistanceThreshold (8) when wx has none;
//   IsPastDragThreshold: abs( offset.x ) > m_sysDragMinX || abs( offset.y ) > m_sysDragMinY.
// wxSYS_DRAG_X is SM_CXDRAG (4) on Windows, gtk-dnd-drag-threshold (8) on GTK and -1 on macOS (so 8).  On macOS
// (__WXMAC__) a press held longer than DragTimeThreshold (300 ms) is a drag on the next motion as well.
// The same test serves every button and every tool.

function detect(re: RegExp): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.platform || (nav.userAgentData && nav.userAgentData.platform) || nav.userAgent || "";
  return re.test(p);
}
const ON_WINDOWS = detect(/Win/i), ON_MAC = detect(/Mac|iPhone|iPad|iPod/i);

/** DragDistanceThreshold (tool_dispatcher.h), the fallback when the system has no drag metric. */
export const DRAG_DISTANCE_THRESHOLD = 8;
/** DragTimeThreshold (tool_dispatcher.h), macOS only. */
export const DRAG_TIME_THRESHOLD_MS = 300;

/** The system drag distance in screen pixels for a platform (wxSYS_DRAG_X / Y). */
export function dragMinPx(platform: "win" | "mac" | "linux" = ON_WINDOWS ? "win" : ON_MAC ? "mac" : "linux"): number {
  return platform === "win" ? 4 : DRAG_DISTANCE_THRESHOLD;
}

/**
 * TOOL_DISPATCHER::IsPastDragThreshold for a screen offset (CSS px) from the press, plus macOS's held-time rule:
 * `heldMs` (time since the press, when the caller knows it) past DragTimeThreshold is a drag there too.
 */
export function isPastDragThreshold(dxPx: number, dyPx: number, heldMs?: number, platform?: "win" | "mac" | "linux"): boolean {
  const plat = platform || (ON_WINDOWS ? "win" : ON_MAC ? "mac" : "linux");
  const t = dragMinPx(plat);
  if (Math.abs(dxPx) > t || Math.abs(dyPx) > t) return true;
  return plat === "mac" && heldMs !== undefined && heldMs > DRAG_TIME_THRESHOLD_MS;
}
