// cf-fab-snap-hook.ts — Snap-fit hook: a cantilever beam with a hook at its tip, standing on a face.
//
// A hook stands at every point of the sketch (loose points and circle centres), growing out of the sketch's
// plane; the hook's nose points along the sketch's x axis, turned by the angle.  The beam is a constant
// rectangle with a fillet at its root; the nose has a lead-in slope for assembly and a return face that holds
// (90° does not release; less lets the joint be pulled apart).  The strain at the root when the nose is pushed
// back by its overhang, ε = 1.5 · thickness · overhang / length², is checked against the limit given: about
// 2 % for PLA, 4–5 % for ABS and PETG, more for nylon.
// Names: `<id>:<point>:base`, `:front` (the side the nose is on), `:back`, `:catch` (the return face), `:lead`,
// `:nose`, `:top`, `:root-front`, `:root-back`, `:start`, `:end` (the two flanks).
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import type { Tool } from "../kernel/ops/combine";
import { at, frameAt, moved, positive, prism, sketchPoints, type P2, type Seg } from "../kernel/ops/cf-fab";
import { finish, PRINT, resultFields } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SnapHookParams { [key: string]: any; points: { sketch: string; regions: string[] | null } | null; length: number; thickness: number; width: number; overhang: number; lead: number; back: number; root: number; angle: number; strain: number; flip: boolean; operation: "new" | "add"; targets: string[] }

/** The strain at the root of a constant rectangular cantilever deflected by `y` at its tip. */
export const hookStrain = (thickness: number, y: number, length: number): number => (1.5 * thickness * y) / (length * length);

export default defineFeature<SnapHookParams>({
  type: "cf-fab-snap-hook",
  title: "Snap-fit hook",
  icon: '<path class="f" d="M3 20h18v-2.5H13L12 16V7.5l3-1V4l-2.5-2H9.5v14l-1 1.5H3z"/><path d="M3 20h18v-2.5H13L12 16V7.5l3-1V4l-2.5-2H9.5v14l-1 1.5H3z"/>',
  hint: "A cantilever snap hook on a face, with lead-in and return angles and a strain check",
  keywords: "snap fit cantilever hook clip latch snap-fit 3d print enclosure catch",
  ...PRINT, toolbarOrder: 10,
  defaults: () => ({ points: null, length: 15, thickness: 2, width: 6, overhang: 1, lead: 30, back: 90, root: 0.5, angle: 0, strain: 5, flip: false, operation: "add", targets: [] }),
  schema: [
    { key: "points", label: "Sketch with points", kind: "profile", hint: "A hook stands at each loose point and at the centre of each circle." },
    { key: "length", label: "Beam length", kind: "number", unit: "mm", min: 0.1, step: 1, hint: "From the face to the return face of the nose." },
    { key: "thickness", label: "Beam thickness", kind: "number", unit: "mm", min: 0.1, step: 0.2 },
    { key: "width", label: "Width", kind: "number", unit: "mm", min: 0.1, step: 0.5 },
    { key: "overhang", label: "Overhang", kind: "number", unit: "mm", min: 0.05, step: 0.1, hint: "How far the nose stands out from the beam: what it hooks behind." },
    { key: "lead", label: "Lead-in angle", kind: "number", unit: "deg", min: 5, max: 80, step: 5, hint: "The slope of the nose that pushes the beam aside on assembly, from the beam's axis." },
    { key: "back", label: "Return angle", kind: "number", unit: "deg", min: 20, max: 90, step: 5, hint: "90° holds for good; 45° lets the joint be pulled apart." },
    { key: "root", label: "Root fillet", kind: "number", unit: "mm", min: 0, step: 0.1 },
    { key: "angle", label: "Turn", kind: "number", unit: "deg", step: 15, hint: "Turns the hook about its point; at 0 the nose points along the sketch's x." },
    { key: "strain", label: "Strain limit", kind: "number", unit: "none", min: 0, step: 0.5, hint: "In per cent. A note is shown when the beam bends more than this to snap in. 0 does not check." },
    { key: "flip", label: "Opposite side", kind: "boolean", hint: "Grow from the other side of the sketch's plane." },
    ...resultFields,
  ],

  evaluate(ctx: EvalContext, p: SnapHookParams) {
    const L = positive(ctx, p.length, "beam length"), t = positive(ctx, p.thickness, "beam thickness"), b = positive(ctx, p.width, "width"), y = positive(ctx, p.overhang, "overhang");
    const lead = Number(p.lead), back = Number(p.back), r = Math.max(0, Number(p.root) || 0);
    if (!(lead >= 5 && lead <= 80)) throw ctx.fail("The lead-in angle must be between 5° and 80°.");
    if (!(back >= 20 && back <= 90)) throw ctx.fail("The return angle must be between 20° and 90°.");
    if (r >= L / 2) throw ctx.fail("The root fillet is too large for the beam.");
    const { frame, points } = sketchPoints(ctx, p.points, "hooks");
    const base = p.flip ? frameAt(frame.origin, frame.x, [-frame.normal[0], -frame.normal[1], -frame.normal[2]]) : frame;
    const id = ctx.feature.id, h = t / 2;
    // the outline, looking along the hook's width: u toward the nose, v up from the face
    const rise = back >= 90 ? 0 : y / Math.tan((back * Math.PI) / 180);   // the return face climbs toward the nose's edge
    const flat = 0.3 * t, zc = L + rise, zl = zc + flat, top = zl + (h + y) / Math.tan((lead * Math.PI) / 180);
    const k = r * (1 - Math.SQRT1_2);
    const start: P2 = [-h - r, 0];
    const segs: Seg[] = [{ to: [h + r, 0], name: "base" }];
    if (r > 0) segs.push({ to: [h, r], via: [h + k, k], name: "root-front" });
    segs.push({ to: [h, L], name: "front" }, { to: [h + y, zc], name: "catch" }, { to: [h + y, zl], name: "nose" }, { to: [0, top], name: "lead" }, { to: [-h, top], name: "top" }, { to: [-h, r], name: "back" });
    if (r > 0) segs.push({ to: [-h - r, 0], via: [-h - k, k], name: "root-back" });
    const tools: Tool[] = points.map((pt) => {
      const f = moved(base, pt.at[0], p.flip ? -pt.at[1] : pt.at[1], 0, Number(p.angle) || 0);
      // drawn in the plane of (nose direction, up) and swept across the width
      const g = frameAt(at(f, 0, b / 2, 0), f.x, [-f.y[0], -f.y[1], -f.y[2]]);
      return { ...prism(ctx, g, start, segs, 0, b, `${id}:${pt.id}`), suffix: pt.id };
    });
    finish(ctx, tools, p);
    const strain = hookStrain(t, y, L) * 100;
    if (p.strain > 0 && strain > p.strain) ctx.warn(`The beam strains ${strain.toFixed(1)} % at its root to snap in, more than the ${p.strain} % limit. Lengthen the beam, thin it or reduce the overhang.`);
  },
});
