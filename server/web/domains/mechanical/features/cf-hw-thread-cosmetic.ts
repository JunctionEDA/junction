// cf-hw-thread-cosmetic.ts — Cosmetic thread: mark a shaft or a hole as threaded without modelling the thread.
// The model stays light (no helical faces) and still says where the thread is: a reference curve that winds
// round the cylinder at the thread's pitch for its length, with a ring where it ends.  The curve can be picked
// like any reference curve (a Sweep path, a measurement).
import { defineFeature } from "../core/feature";
import { add, cross, scale, type GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { cylinderOf } from "../kernel/ops/cf-hw";
import { threadEnds } from "../kernel/ops/cf-hw-thread";
import { setCurve } from "../kernel/ops/curves";
import { chosenThread, HW_SECTION, MENU_THREADS, threadDefaults, threadFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CosmeticThreadParams { [key: string]: any; face: GeomRef | null; full: boolean; length: number; flip: boolean; left: boolean }

export default defineFeature<CosmeticThreadParams>({
  type: "cf-hw-thread-cosmetic",
  title: "Cosmetic thread",
  icon: '<path class="f" d="M8 3h8v18H8z"/><path d="M8 3h8M8 21h8M8 3v18M16 3v18"/><path class="d" d="M8 8l8-2.5M8 12l8-2.5M8 16l8-2.5"/>',
  hint: "Mark a shaft or hole as threaded with a light helix curve, without modelling the thread",
  keywords: "cosmetic thread annotation symbolic callout light tapped hole mark",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_THREADS, toolbarOrder: 13, toolbarKeep: 0,
  defaults: () => ({ face: null, ...threadDefaults(true), full: true, length: 10, flip: false, left: false }),
  schema: [
    { key: "face", label: "Cylinder or hole", kind: "refs", of: ["face"], single: true },
    ...threadFields(true),
    { key: "full", label: "Whole length", kind: "boolean" },
    { key: "length", label: "Length", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => !p.full },
    { key: "flip", label: "Start at the other end", kind: "boolean" },
    { key: "left", label: "Left-handed", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: CosmeticThreadParams) {
    const oc = ctx.oc as any, k = ctx.k;
    const cyl = cylinderOf(ctx, p.face, "the round face of a shaft, or the wall of a hole");
    const chosen = chosenThread(p, cyl.radius * 2, cyl.hole);
    if (typeof chosen === "string") throw ctx.fail(chosen);
    const span = cyl.hi - cyl.lo, length = Math.min(span, p.full ? span : Number(p.length));
    if (!(length > 0)) throw ctx.fail("The thread's length must be more than zero.");
    const ends = threadEnds(ctx, cyl, !!p.flip, length);
    const origin = add(cyl.origin, scale(cyl.dir, ends.fromHi ? cyl.hi : cyl.lo)), dir = ends.fromHi ? scale(cyl.dir, -1) : cyl.dir;
    // on the surface itself, where it is seen: a line on the cylinder's (angle, height) plane is a helix
    const ax3 = ctx.tmp(new oc.gp_Ax3(ctx.tmp(k.pnt(origin)), ctx.tmp(k.dir(dir)), ctx.tmp(k.dir(cyl.x))));
    const surface = new oc.Geom_CylindricalSurface(ax3, cyl.radius);
    const du = (p.left ? -1 : 1) * 2 * Math.PI, dv = chosen.pitch;
    const line = new oc.Geom2d_Line(ctx.tmp(new oc.gp_Pnt2d(0, 0)), ctx.tmp(new oc.gp_Dir2d(du, dv)));
    const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(line, surface, 0, (length / chosen.pitch) * Math.hypot(du, dv)));
    if (!mk.IsDone()) throw ctx.fail("The thread's curve could not be built.");
    const helix = ctx.own(mk.Edge());
    oc.BRepLib.BuildCurves3d(helix);
    const pieces = [helix];
    if (length < span - 1e-6) {
      const ax2 = ctx.tmp(new oc.gp_Ax2(ctx.tmp(k.pnt(add(origin, scale(dir, length)))), ctx.tmp(k.dir(dir)), ctx.tmp(k.dir(cross(dir, cyl.x)))));
      pieces.push(ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(new oc.gp_Circ(ax2, cyl.radius)))).Edge()));
    }
    setCurve(ctx, pieces);
  },
});
