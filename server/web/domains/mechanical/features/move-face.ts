// move-face.ts — the Move face feature: translate, rotate or offset faces of a part, whatever made it.
//
//   • a flat face is put on its moved plane, and the faces around it are carried on (or cut back) to meet it:
//     the top of a block moved up makes the block taller, the floor of a pocket moved down makes it deeper;
//   • a round face offset changes its radius (a hole grows or shrinks), a flat face offset moves along its
//     normal;
//   • faces that are not all flat (a hole, a boss, a whole pocket with its rounded corners) are moved as one
//     rigid shape: the part is healed where they were and the shape they made is put back in its new place.
//
// Names: every face keeps its name.
import { defineFeature } from "../core/feature";
import { add, cross, dot, length, normalize, scale, sub, type GeomRef, type Vec3 } from "../core/geometry";
import type { NamedResult } from "../kernel/occ";
import type { Body, EvalContext, NamedShape, Shape } from "../kernel/types";
import { cylinderWall, healFaces, moveToWall, planeWall, surfaceOf } from "../kernel/ops/cells";
import { axisOf } from "../kernel/ops/ref-geom";
import { rotateAbout } from "../kernel/ops/ref-datum";
import { facesByBody } from "./delete-face";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MoveFaceParams {
  [key: string]: any;
  faces: GeomRef[]; type: "translate" | "rotate" | "offset";
  direction: RefTarget | null; distance: number; flip: boolean;
  axis: RefTarget | null; angle: number;
}

const DIRECTION = { kind: "refs" as const, of: ["edge" as const, "face" as const], single: true, planes: true, datums: ["axis" as const, "plane" as const], sketch: true };

/** Put a named face of a body on a wall, keeping the body as it is when the wall is where the face is already. */
function onWall(ctx: EvalContext, body: Body, name: string, wall: (face: NamedShape) => ReturnType<typeof planeWall>): Body {
  const face = body.topo.faces.find((f) => f.name === name);
  if (!face) throw ctx.fail("A face to move was used up by moving the ones before it. Move them in separate features.");
  const r = moveToWall(ctx, { shape: body.shape, faces: body.topo.faces }, face, wall(face));
  return r ? ctx.replaceBody(body, r.shape, r.names) : body;
}

export default defineFeature<MoveFaceParams>({
  type: "move-face",
  title: "Move face",
  hint: "Translate, rotate or offset faces of a part; the faces around follow.",
  keywords: "push pull offset translate rotate face direct edit resize",
  icon: '<path class="d t" d="M3.5 9.5l6-3.5h8l-6 3.5z"/><path class="f" d="M3.5 13.5l6-3.5h8v7l-6 3.5h-8z"/><path d="M3.5 13.5l6-3.5h8v7l-6 3.5h-8zM3.5 13.5h8v7M11.5 13.5l6-3.5"/><path d="M20.5 9v-6M18.5 5l2-2 2 2"/>',
  toolbarOrder: 52, toolbarSection: "direct", toolbarKeep: 32,
  defaults: () => ({ faces: [], type: "translate", direction: null, distance: 5, flip: false, axis: null, angle: 10 }),
  schema: [
    { key: "faces", label: "Faces to move", kind: "refs", of: ["face"] },
    { key: "type", label: "Move", kind: "enum", options: [{ value: "translate", label: "Translate" }, { value: "rotate", label: "Rotate" }, { value: "offset", label: "Offset" }] },
    { key: "direction", label: "Direction", ...DIRECTION, hint: "A straight edge, a flat face or plane (its normal), or an axis. Empty: the first face's own normal.", visible: (p) => p.type === "translate" },
    { key: "distance", label: "Distance", kind: "number", unit: "mm", step: 1, visible: (p) => p.type !== "rotate" },
    { key: "axis", label: "Axis", ...DIRECTION, hint: "A straight edge, an axis, or a round face's own axis.", visible: (p) => p.type === "rotate" },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", step: 5, visible: (p) => p.type === "rotate" },
    { key: "flip", label: "Opposite direction", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: MoveFaceParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    const sign = p.flip ? -1 : 1;
    for (const [start, faces] of facesByBody(ctx, p.faces, "to move")) {
      let body = start;
      const kinds = faces.map((f) => surfaceOf(ctx, f.shape));
      if (p.type === "offset") {
        const d = sign * (Number(p.distance) || 0);
        if (!d) throw ctx.fail("The offset must not be zero.");
        if (kinds.some((s) => s.kind === "other")) throw ctx.fail("Offset moves flat and cylindrical faces. For other faces use Translate.");
        faces.forEach((f, i) => {
          const s = kinds[i];
          body = onWall(ctx, body, f.name, () => {
            if (s.kind === "plane") return planeWall(ctx, add(s.origin, scale(s.normal, d)), s.normal, [body.shape]);
            if (s.kind !== "cylinder") throw ctx.fail("Offset moves flat and cylindrical faces.");
            const r = s.radius + (s.outward ? d : -d);
            if (!(r > 1e-6)) throw ctx.fail("That offset would shrink a round face to nothing.");
            return cylinderWall(ctx, s.origin, s.dir, r, s.outward, [body.shape]);
          });
        });
        continue;
      }
      // a rigid motion: of points (`at`) and of directions (`turn`)
      let at: (q: Vec3) => Vec3, turn: (v: Vec3) => Vec3, trsf: any;
      if (p.type === "rotate") {
        const axis = axisOf(ctx, p.axis, "axis");
        const a = (sign * (Number(p.angle) || 0) * Math.PI) / 180;
        if (!a) throw ctx.fail("The angle must not be zero.");
        turn = (v) => rotateAbout(v, axis.dir, a);
        at = (q) => add(axis.origin, rotateAbout(sub(q, axis.origin), axis.dir, a));
        trsf = ctx.tmp(new oc.gp_Trsf());
        trsf.SetRotation(ctx.tmp(new oc.gp_Ax1(ctx.tmp(k.pnt(axis.origin)), ctx.tmp(k.dir(axis.dir)))), a);
      } else {
        const d = sign * (Number(p.distance) || 0);
        if (!d) throw ctx.fail("The distance must not be zero.");
        const first = kinds[0];
        const dir = p.direction ? axisOf(ctx, p.direction, "direction").dir : first.kind === "plane" ? first.normal : null;
        if (!dir) throw ctx.fail("Pick the direction to move in.");
        const v = scale(normalize(dir), d);
        turn = (x) => x; at = (q) => add(q, v);
        trsf = ctx.tmp(new oc.gp_Trsf());
        trsf.SetTranslation(ctx.tmp(k.vec(v)));
      }
      if (kinds.every((s) => s.kind === "plane")) {
        faces.forEach((f, i) => {
          const s = kinds[i] as { kind: "plane"; origin: Vec3; normal: Vec3 };
          const n = turn(s.normal), o = at(s.origin);
          // a flat face slid in its own plane is where it was
          if (length(cross(n, s.normal)) < 1e-9 && Math.abs(dot(sub(o, s.origin), n)) < 1e-9) return;
          body = onWall(ctx, body, f.name, () => planeWall(ctx, o, n, [body.shape]));
        });
        continue;
      }
      // what the faces made: the part healed without them, less the part (what they cut away) and the part less
      // the healed one (what they added); both are put back moved
      const was = { shape: body.shape, faces: body.topo.faces };
      const healed = healFaces(ctx, was, faces.map((f) => f.shape));
      const base = { shape: healed.shape, faces: k.namedFaces(healed.shape, healed.names, id) };
      const moved = (r: NamedResult): { shape: Shape; faces: NamedShape[] } | null => {
        const solids = k.solids(r.shape);
        if (!solids.length || !(k.volume(r.shape) > 1e-9)) return null;
        const src = k.namedFaces(r.shape, r.names, id);
        const mk = ctx.own(new oc.BRepBuilderAPI_Transform(r.shape, trsf, true, false));
        const shape: Shape = ctx.own(mk.Shape());
        return { shape, faces: src.map((f) => ({ name: f.name, shape: ctx.own(mk.ModifiedShape(f.shape)) })) };
      };
      const removed = moved(k.boolean("cut", base, was, id, ctx.own)), added = moved(k.boolean("cut", was, base, id, ctx.own));
      let acc: NamedResult = { shape: base.shape, names: healed.names };
      const accFaces = () => k.namedFaces(acc.shape, acc.names, id);
      if (removed) acc = k.boolean("cut", { shape: acc.shape, faces: accFaces() }, removed, id, ctx.own);
      if (added) acc = k.boolean("fuse", { shape: acc.shape, faces: accFaces() }, added, id, ctx.own);
      const solids = k.solids(acc.shape);
      if (solids.length !== 1) throw ctx.fail("Moved there, the faces would leave the part in pieces.");
      ctx.replaceBody(body, solids[0], acc.names);
    }
  },
});
