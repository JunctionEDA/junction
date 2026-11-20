// cf-hw-wires.ts — a flat outline moved in or out (the gasket's edge, a lip along a rim).  Worker side.
import type { Vec3 } from "../../core/geometry";
import type { EvalContext, Shape } from "../types";
import { flatFace } from "./cf-hw-thread";
import { edgeInfo } from "./ref-geom";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A closed planar wire moved out (positive) or in by `d`, as wires: none when it shrinks to nothing. */
export function offsetWire(ctx: EvalContext, origin: Vec3, normal: Vec3, x: Vec3, wire: Shape, d: number): Shape[] {
  const oc = ctx.oc as any, k = ctx.k;
  if (Math.abs(d) < 1e-9) return [wire];
  const edges = k.sub(wire, "edge");
  if (edges.length === 1) {
    // a lone circle is done by hand: the kernel's offset puts it at the wrong height when its plane is not through the origin
    const c = edgeInfo(ctx, edges[0]);
    if (c.kind === "circle" && c.centre && c.radius) {
      if (!(c.radius + d > 1e-6)) return [];
      const ax = ctx.tmp(new oc.gp_Ax2(ctx.tmp(k.pnt(c.centre)), ctx.tmp(k.dir(normal)), ctx.tmp(k.dir(x))));
      const e = ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(new oc.gp_Circ(ax, c.radius + d)))).Edge());
      return [ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeWire(e)).Wire())];
    }
  }
  const solo = flatFace(ctx, origin, normal, x, 0, wire, []);
  const mk = ctx.tmp(new oc.BRepOffsetAPI_MakeOffset(oc.TopoDS.Face(solo), oc.GeomAbs_JoinType.GeomAbs_Arc, false));
  try { mk.Perform(d, 0); } catch (e) { return []; }
  if (!mk.IsDone()) return [];
  const out = ctx.own(mk.Shape());
  return out.IsNull() ? [] : k.sub(out, "wire");
}
