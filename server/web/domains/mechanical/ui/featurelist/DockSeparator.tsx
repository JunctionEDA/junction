// DockSeparator.tsx — the bar between the feature list and the panel under it (the parts list): drag it to give
// one more room and the other less.  Each of the two scrolls by itself.  The height a person chose is kept in
// this browser; a double click gives the choice back (the lower panel is then as tall as what it holds).
import { useSyncExternalStore } from "react";
import { tipHandlers } from "../Tip";

const KEY = "junction.cad.dockSplit";
const MIN = 64;

function read(): number | null {
  try { const v = Number(localStorage.getItem(KEY)); return Number.isFinite(v) && v >= MIN ? v : null; } catch (e) { return null; }
}
let height: number | null = read();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** Set the height of the panel under the bar in pixels (null: as tall as what it holds). */
export function setDockSplit(h: number | null): void {
  const next = h === null ? null : Math.round(Math.max(MIN, h));
  if (next === height) return;
  height = next;
  try { if (next === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(next)); } catch (e) { /* private mode: it lasts as long as the page */ }
  for (const fn of Array.from(listeners)) fn();
}
/** React: the chosen height of the panel under the bar, or null. */
export function useDockSplit(): number | null { return useSyncExternalStore(subscribe, () => height); }

export function DockSeparator() {
  const chosen = useDockSplit();
  /** the most the lower panel may take: the dock less room for a few rows of the feature list */
  const most = (bar: HTMLElement): number => Math.max(MIN, (bar.parentElement?.clientHeight || 600) - 150);
  const lower = (bar: HTMLElement): number => (bar.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().height || MIN;
  const drag = (ev: React.PointerEvent) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const bar = ev.currentTarget as HTMLElement, y0 = ev.clientY, h0 = lower(bar), max = most(bar);
    bar.focus();
    document.body.style.cursor = "row-resize";
    const move = (e: PointerEvent) => setDockSplit(Math.min(max, h0 - (e.clientY - y0)));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.style.cursor = ""; };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  return (
    <div className="cad-dock-separator group/sep flex-none flex items-center justify-center h-1.5 cursor-row-resize bg-bench border-b border-line outline-none hover:bg-sel-soft focus-visible:bg-sel-soft" role="separator" aria-orientation="horizontal" aria-label="Share the room between the features and the parts" tabIndex={0} data-dock-separator data-split={chosen ?? undefined}
      {...tipHandlers({ title: "Drag to resize", hint: "More of the feature list, or more of the parts. Double-click: as tall as the parts need." })}
      onPointerDown={drag} onDoubleClick={() => setDockSplit(null)}
      onKeyDown={(ev) => {
        if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
        const bar = ev.currentTarget as HTMLElement;
        setDockSplit(Math.min(most(bar), lower(bar) + (ev.key === "ArrowUp" ? 16 : -16)));
        ev.preventDefault(); ev.stopPropagation();
      }}>
      <span className="w-8 h-0.5 rounded-full bg-line-2 group-hover/sep:bg-accent" aria-hidden="true" />
    </div>
  );
}
