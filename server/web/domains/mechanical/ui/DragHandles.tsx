// DragHandles.tsx — the numbers of the feature being edited that can be dragged in the model: an arrow where an
// extrusion ends, pulled along its direction (the feature says where: kernel/protocol.ts DragHandle).
//
// The arrow is drawn over the canvas and follows the view.  While it is dragged the number goes by steps a person
// would type (1, 2 or 5 of a round size, finer the closer the view is zoomed in: ui/drag-snap.ts); Alt lets it
// go freely.  Pulled back through where it starts, a depth turns the feature's direction over.
import * as THREE from "three";
import { useEffect, useRef } from "react";
import type { DragHandle } from "../kernel/protocol";
import { formatLength, lengthFactor } from "../document/units";
import { useStudio } from "./hooks";
import { snapLength } from "./drag-snap";
import type { PartStudio } from "./studio";

/** how far from where the number ends the arrow starts, how long it is, and its head (CSS px) */
const GAP = 6, LENGTH = 44, HEAD = 13;

interface Drag { h: DragHandle; pointer: number; offset: number; value: number; flipped: boolean; flip0: boolean }

export function DragHandles({ studio }: { studio: PartStudio }) {
  const editing = useStudio(studio, (s) => s.editing);
  const reports = useStudio(studio, (s) => s.reports);
  const inSketch = useStudio(studio, (s) => !!s.sketch);
  const units = useStudio(studio, (s) => s.units);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const handles = editing && !inSketch ? reports[editing.draft.id]?.handles || [] : [];
  const live = useRef(handles);
  live.current = handles;

  // ---- where each arrow is on the screen: again on every frame the view draws
  const paint = useRef<() => void>(() => undefined);
  paint.current = () => {
    const el = svg.current; if (!el) return;
    const vp = studio.viewport, c = vp.canvas.getBoundingClientRect(), r = el.getBoundingClientRect();
    const ox = c.left - r.left, oy = c.top - r.top, px = vp.pixelSize();
    for (const g of Array.from(el.querySelectorAll<SVGGElement>("[data-handle]"))) {
      const d = drag.current && drag.current.h.key === g.dataset.handle ? drag.current : null;
      const h = d ? d.h : live.current.find((x) => x.key === g.dataset.handle);
      if (!h) { g.style.display = "none"; continue; }
      const sign = d && d.flipped ? -1 : 1, value = d ? d.value : h.value;
      const dir = new THREE.Vector3(...h.dir).multiplyScalar(sign);
      const tip = new THREE.Vector3(...h.origin).addScaledVector(dir, value / h.scale);
      const a = vp.project(tip), b = vp.project(tip.clone().addScaledVector(dir, px * 100));
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      // seen end on there is no direction on the screen to pull along
      const flat = len < 12;
      g.style.display = "";
      g.dataset.endOn = flat ? "1" : "";
      g.setAttribute("transform", `translate(${a.x + ox} ${a.y + oy}) rotate(${flat ? -90 : (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI})`);
      const label = el.querySelector<SVGGElement>(`[data-handle-label="${h.key}"]`);
      if (label) {
        label.style.display = d ? "" : "none";
        label.setAttribute("transform", `translate(${a.x + ox + 16} ${a.y + oy - 16})`);
        const text = label.querySelector("text"), box = label.querySelector("rect");
        if (text && d) { text.textContent = formatLength(value, units); if (box) box.setAttribute("width", String(text.textContent.length * 7.2 + 14)); }
      }
    }
  };
  useEffect(() => {
    const f = () => paint.current();
    studio.viewport.onFrame.push(f);
    return () => { const i = studio.viewport.onFrame.indexOf(f); if (i >= 0) studio.viewport.onFrame.splice(i, 1); };
  }, [studio]);
  useEffect(() => { paint.current(); });

  // ---- the drag: the point of the arrow's own line nearest the pointer's line of sight
  const along = (h: DragHandle, ev: { clientX: number; clientY: number }): number | null => {
    const ray = studio.viewport.ray(ev);
    const p = new THREE.Vector3(...h.origin), d = new THREE.Vector3(...h.dir).normalize(), w = p.clone().sub(ray.origin);
    const b = d.dot(ray.direction), den = 1 - b * b;
    if (den < 1e-6) return null;
    return (b * w.dot(ray.direction) - w.dot(d)) / den;
  };
  const down = (h: DragHandle) => (ev: React.PointerEvent<SVGGElement>) => {
    if (ev.button !== 0 || ev.currentTarget.dataset.endOn) return;
    const s = along(h, ev); if (s === null) return;
    ev.preventDefault(); ev.stopPropagation();
    ev.currentTarget.setPointerCapture(ev.pointerId);
    const flip0 = h.flip ? !!studio.getState().editing?.draft.params[h.flip] : false;
    drag.current = { h, pointer: ev.pointerId, offset: h.value / h.scale - s, value: h.value, flipped: false, flip0 };
    ev.currentTarget.dataset.dragging = "1";
    paint.current();
  };
  const move = (ev: React.PointerEvent<SVGGElement>) => {
    const d = drag.current; if (!d || ev.pointerId !== d.pointer) return;
    const s = along(d.h, ev); if (s === null) return;
    let v = (s + d.offset) * d.h.scale;
    const flipped = !!d.h.flip && v < 0;
    v = Math.abs(v);
    const f = lengthFactor(units.length);
    v = snapLength(v / f, (studio.viewport.pixelSize() * d.h.scale) / f, { free: ev.altKey, places: units.places }) * f;
    if (!(v > 0) || (v === d.value && flipped === d.flipped)) return;
    d.value = v; d.flipped = flipped;
    studio.setDraft({ params: { [d.h.key]: v, ...(d.h.flip ? { [d.h.flip]: d.flip0 !== flipped } : {}) } });
    paint.current();
  };
  const up = (ev: React.PointerEvent<SVGGElement>) => {
    const d = drag.current; if (!d || ev.pointerId !== d.pointer) return;
    drag.current = null;
    delete ev.currentTarget.dataset.dragging;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch (x) { /* already let go */ }
    studio.viewport.canvas.focus();
    paint.current();
  };

  if (!handles.length) return null;
  return (
    <svg ref={svg} className="cad-drag-handles absolute inset-0 w-full h-full pointer-events-none overflow-visible" aria-hidden="true">
      {handles.map((h) => (
        <g key={h.key} data-handle={h.key} className="cad-drag-handle pointer-events-auto cursor-grab" style={{ display: "none" }}
          onPointerDown={down(h)} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <title>Drag to change the depth. Hold Alt to drag without steps.</title>
          {/* room to catch it by */}
          <rect x={0} y={-12} width={GAP + LENGTH + 4} height={24} fill="transparent" />
          <g className="cad-drag-arrow">
            <path d={`M${GAP} 0H${GAP + LENGTH - HEAD + 1}`} fill="none" strokeLinecap="round" stroke="var(--paper)" strokeWidth={6} />
            <path d={`M${GAP + LENGTH} 0l${-HEAD} ${-HEAD * 0.48}v${HEAD * 0.96}z`} stroke="var(--paper)" strokeWidth={3} strokeLinejoin="round" fill="var(--paper)" />
            <path d={`M${GAP} 0H${GAP + LENGTH - HEAD + 1}`} fill="none" strokeLinecap="round" stroke="var(--blue)" strokeWidth={3} />
            <path d={`M${GAP + LENGTH} 0l${-HEAD} ${-HEAD * 0.48}v${HEAD * 0.96}z`} fill="var(--blue)" />
          </g>
        </g>
      ))}
      {handles.map((h) => (
        <g key={h.key} data-handle-label={h.key} style={{ display: "none" }}>
          <rect x={0} y={-11} height={22} rx={4} fill="var(--ink)" />
          <text x={7} y={4} fontSize={12} fill="var(--paper)" className="mono" />
        </g>
      ))}
    </svg>
  );
}
