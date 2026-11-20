// cf-fab-split-pins.ts — Split with alignment pins: cut a part in two with a plane, for printing in pieces, and
// give the cut faces pins and sockets (or holes for loose pins) so the halves register when glued.
//
// The pins go at the points of a sketch drawn on the split plane, or, with no sketch, are spread along the
// longer side of the cut where there is room for them.  Integral pins grow from the piece behind the plane
// (in front with "Pins on the other piece") and have a chamfered tip; the sockets are a clearance wider and
// deeper.  Loose pins leave the same hole in both pieces: 1.75 mm filament or a steel dowel does the rest.
// The piece behind the plane keeps the body; the other is `<id>:<body>.front`.
// Names: `<id>:cut` on both pieces, `<id>:pin<n>:side`, `:tip`, `:chamfer`, `<id>:socket<n>:wall`, `:end`.
import { defineFeature } from "../core/feature";
import { add, dot, scale, sub, type Frame, type PlaneRef, type Vec3 } from "../core/geometry";
import type { NamedResult } from "../kernel/occ";
import type { Body, EvalContext, Shape } from "../kernel/types";
import { onPlane } from "../kernel/ops/ref-geom";
import { planeFace, reachPast, solidCentre } from "../kernel/ops/shapes";
import { at, changeAll, cylinder, distanceTo, extentIn, frameAt, positive, revolve, sketchPoints, whole } from "../kernel/ops/cf-fab";
import { PRINT } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SplitPinsParams { [key: string]: any; bodies: string[]; plane: PlaneRef; points: { sketch: string; regions: string[] | null } | null; kind: "pin" | "loose"; count: number; diameter: number; length: number; clearance: number; wall: number; flip: boolean }

export default defineFeature<SplitPinsParams>({
  type: "cf-fab-split-pins",
  title: "Split with pins",
  icon: '<path class="f" d="M3 4h18v6.5H3zM3 13.5h18V20H3z"/><path d="M3 4h18v6.5H3zM3 13.5h18V20H3z"/><path class="s" d="M6.5 10.5h3V13h-3zM14.5 10.5h3V13h-3z"/><path class="d t" d="M1 12h22"/>',
  hint: "Split a part with a plane and add alignment pins and sockets to the cut faces",
  keywords: "split part alignment pins keys dowel registration print in pieces cut glue halves socket",
  ...PRINT, toolbarOrder: 32,
  defaults: () => ({ bodies: [], plane: { kind: "plane", plane: "top" }, points: null, kind: "pin", count: 2, diameter: 4, length: 4, clearance: 0.15, wall: 1.2, flip: false }),
  schema: [
    { key: "bodies", label: "Part", kind: "bodies", hint: "The part to split. Leave empty when there is only one." },
    { key: "plane", label: "Split with", kind: "plane" },
    { key: "points", label: "Pin positions", kind: "profile", hint: "A sketch on the split plane: a pin at each loose point and circle centre. Leave empty to place them automatically." },
    { key: "kind", label: "Pins", kind: "enum", options: [{ value: "pin", label: "Integral" }, { value: "loose", label: "Loose (holes)" }] },
    { key: "count", label: "Count", kind: "number", unit: "none", min: 1, max: 12, step: 1, visible: (p) => !p.points || !(p.points as any).sketch },
    { key: "diameter", label: "Pin diameter", kind: "number", unit: "mm", min: 0.2, step: 0.5 },
    { key: "length", label: "Pin length", kind: "number", unit: "mm", min: 0.2, step: 0.5, hint: "How far a pin reaches into each piece." },
    { key: "clearance", label: "Clearance", kind: "number", unit: "mm", min: 0, step: 0.05, hint: "Between pin and socket, on the radius." },
    { key: "wall", label: "Least wall", kind: "number", unit: "mm", min: 0, step: 0.2, hint: "The material that must stay round a pin placed automatically.", visible: (p) => !p.points || !(p.points as any).sketch },
    { key: "flip", label: "Pins on the other piece", kind: "boolean", visible: (p) => p.kind !== "loose" },
  ],

  evaluate(ctx: EvalContext, p: SplitPinsParams) {
    const k = ctx.k, oc = ctx.oc as any, id = ctx.feature.id;
    const r = positive(ctx, p.diameter, "pin diameter") / 2, len = positive(ctx, p.length, "pin length"), c = Math.max(0, Number(p.clearance) || 0);
    const list = Array.isArray(p.bodies) ? p.bodies : [];
    const parts = list.length ? ctx.bodies().filter((b) => list.includes(b.id)) : ctx.bodies().slice();
    if (parts.length !== 1) throw ctx.fail(list.length ? "Pick one part to split." : "Pick the part to split.");
    const body: Body = parts[0];
    const frame: Frame = ctx.frameOf(p.plane);
    // split, as the Split feature does
    const tool = planeFace(k, frame.origin, frame.normal, reachPast(k, [body.shape], frame.origin), ctx.own);
    const mk = ctx.own(new oc.BRepAlgoAPI_Splitter());
    const args = ctx.tmp(new oc.NCollection_List_TopoDS_Shape()); args.Append(body.shape);
    const tools = ctx.tmp(new oc.NCollection_List_TopoDS_Shape()); tools.Append(tool);
    mk.SetArguments(args); mk.SetTools(tools);
    mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
    if (!mk.IsDone() || mk.HasErrors()) throw ctx.fail(`${body.name} could not be split.`);
    const whole_: Shape = ctx.own(mk.Shape());
    const pieces = k.solids(whole_);
    if (pieces.length < 2) throw ctx.fail("The plane does not cross the part.");
    if (pieces.length > 2) throw ctx.fail("The plane cuts the part into more than two pieces. Split it where the cut is one face, or use Split and place the pins by hand.");
    const cut = `${id}:cut`;
    const carried = k.carryNames(whole_, mk, [...body.topo.faces, { name: cut, shape: tool }], id);
    const names = (f: any, i: number) => { const n = carried(f, i); return n && n.startsWith(cut) ? cut : n; };
    const side = (s: Shape) => dot(sub(solidCentre(k, s), frame.origin), frame.normal);
    const frontShape = side(pieces[0]) > 0 ? pieces[0] : pieces[1], backShape = frontShape === pieces[0] ? pieces[1] : pieces[0];
    const back = ctx.replaceBody(body, backShape, names);
    const front = ctx.addBody(frontShape, names, { suffix: `${body.id}.front`, name: `${body.name} (2)` });

    // where the pins go
    let spots: Vec3[];
    if (p.points && p.points.sketch) {
      const sp = sketchPoints(ctx, p.points, "pins");
      spots = sp.points.map((q) => at(sp.frame, q.at[0], q.at[1], 0));
      if (spots.some((q) => Math.abs(dot(sub(q, frame.origin), frame.normal)) > 1e-6)) throw ctx.fail("The sketch with the pin positions is not on the split plane.");
    } else {
      const count = whole(ctx, p.count, "count", 1, 12), wall = Math.max(0, Number(p.wall) || 0);
      const faces = back.topo.faces.filter((f) => f.name === cut || f.name.startsWith(`${cut}~`)).map((f) => f.shape);
      if (!faces.length) throw ctx.fail("The cut face was lost. Place the pins with a sketch.");
      // the cut's extent in the plane; pins are spread along its longer side
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const f of faces) { const e = extentIn(ctx, f, frame); u0 = Math.min(u0, e[0][0]); u1 = Math.max(u1, e[0][1]); v0 = Math.min(v0, e[1][0]); v1 = Math.max(v1, e[1][1]); }
      const alongU = u1 - u0 >= v1 - v0;
      const need = r + c + wall;
      const room = (q: Vec3) => faces.some((f) => distanceTo(ctx, f, q) < 1e-6 && k.sub(f, "edge").every((e) => distanceTo(ctx, e, q) >= need - 1e-9));
      spots = [];
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count;
        // on the middle line, or failing that a quarter to either side of it
        const found = [0.5, 0.25, 0.75].map((s) => (alongU ? at(frame, u0 + (u1 - u0) * t, v0 + (v1 - v0) * s, 0) : at(frame, u0 + (u1 - u0) * s, v0 + (v1 - v0) * t, 0))).map((q) => onPlane(frame, q)).find(room);
        if (found) spots.push(found);
      }
      if (!spots.length) throw ctx.fail("There is no room on the cut for a pin of that size. Make the pins thinner, or draw a sketch on the split plane with a point where each pin goes.");
      if (spots.length < count) ctx.warn(`Only ${spots.length} of ${count} pins fit on the cut.`);
    }

    // pins point into the piece that gets the sockets
    const pinsOnFront = p.kind !== "loose" && !!p.flip;
    const into: Vec3 = pinsOnFront ? scale(frame.normal, -1) : frame.normal;
    const holder = pinsOnFront ? front : back, other = pinsOnFront ? back : front;
    if (p.kind === "loose") {
      const holes = spots.map((q, i) => cylinder(ctx, frameAt(add(q, scale(frame.normal, -len - c)), frame.x, frame.normal), [0, 0], r + c, 0, 2 * (len + c), `${id}:socket${i + 1}`));
      changeAll(ctx, back, "cut", holes);
      changeAll(ctx, front, "cut", holes);
      return;
    }
    const ch = Math.min(r * 0.4, len * 0.3);
    const pins: NamedResult[] = spots.map((q, i) => revolve(ctx, frameAt(q, frame.x, into), [[0, 0], [r, 0], [r, len - ch], [r - ch, len], [0, len]], ["base", "side", "chamfer", "tip", null], `${id}:pin${i + 1}`));
    const sockets: NamedResult[] = spots.map((q, i) => cylinder(ctx, frameAt(q, frame.x, into), [0, 0], r + c, 0, len + c, `${id}:socket${i + 1}`));
    changeAll(ctx, other, "cut", sockets);
    changeAll(ctx, holder, "fuse", pins);
  },
});
