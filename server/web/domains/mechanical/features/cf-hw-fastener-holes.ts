// cf-hw-fastener-holes.ts — Fastener holes: the holes one screw needs through a stack of parts, in one feature.
// At each picked point the screw's axis is followed into the model.  The first part it enters gets the head's
// seat (a counterbore for a socket head, a countersink for a flat head, a plain clearance hole for a hexagon or
// button head); every part in between gets a clearance hole; the last part gets a clearance hole (for a nut), a
// tap drill hole, or the hole of a heat-set insert.  The Hole feature drills one size into everything; this one
// sizes each part's hole by its place in the stack.
//
// Names: as Hole, with the part in them: `<id>:<point>:<body id>:wall`, `:cbore`, `:cbore-floor`, `:csink`, `:floor`.
import { defineFeature } from "../core/feature";
import { dot, scale, sub } from "../core/geometry";
import type { Body, EvalContext } from "../kernel/types";
import { combine, scoped } from "../kernel/ops/combine";
import { drill, frameAt, spots, tube } from "../kernel/ops/cf-hw";
import { clearanceOf, cutFields, fastenerOf, FIT_OPTIONS, HW_SECTION, MENU_THREADS, sizeField, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FastenerHolesParams {
  [key: string]: any;
  head: "socket" | "flat" | "hex"; size: string; fit: "close" | "normal" | "loose";
  last: "clearance" | "tapped" | "insert"; engagement: number; headroom: number; targets: string[];
}

export default defineFeature<FastenerHolesParams>({
  type: "cf-hw-fastener-holes",
  title: "Fastener holes",
  icon: '<path class="f" d="M3 5h18v6H3zM3 13h18v6H3z"/><path d="M3 5h18v6H3zM3 13h18v6H3z"/><path d="M8 5v3h2.5v11M16 5v3h-2.5v11"/>',
  hint: "Drill a screw's holes through a stack of parts: counterbore or countersink, clearance, and a tapped or insert hole in the last",
  keywords: "counterbore countersink clearance hole set fastener stack bolt through parts tapped heat set insert screw hole",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_THREADS, toolbarOrder: 30, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), head: "socket", size: "M4", fit: "normal", last: "tapped", engagement: 0, headroom: 0, targets: [] }),
  schema: [
    ...whereFields({ flip: "Opposite direction", noun: "screw" }),
    { key: "head", label: "Screw head", kind: "enum", options: [{ value: "socket", label: "Socket (counterbore)" }, { value: "flat", label: "Flat (countersink)" }, { value: "hex", label: "Hex / button (none)" }] },
    sizeField(),
    { key: "fit", label: "Clearance", kind: "enum", options: FIT_OPTIONS },
    { key: "last", label: "Last part", kind: "enum", options: [{ value: "clearance", label: "Clearance" }, { value: "tapped", label: "Tapped" }, { value: "insert", label: "Insert" }], hint: "Clearance for a nut behind it, a tap drill hole, or the hole of a heat-set insert." },
    { key: "engagement", label: "Thread depth", kind: "number", unit: "mm", min: 0, step: 1, hint: "How deep the last part is drilled; 0 for twice the screw's diameter.", visible: (p) => p.last === "tapped" },
    { key: "headroom", label: "Extra counterbore depth", kind: "number", unit: "mm", min: 0, step: 0.5, visible: (p) => p.head === "socket" },
    ...cutFields,
  ],

  evaluate(ctx: EvalContext, p: FastenerHolesParams) {
    const k = ctx.k, id = ctx.feature.id;
    const f = fastenerOf(p.size);
    if (!f) throw ctx.fail(`The size table has no ${p.size}.`);
    const clear = clearanceOf(f, p.fit);
    const bodies = scoped(ctx, p.targets);
    if (!bodies.length) throw ctx.fail("There is no body to drill.");
    let drilled = 0;
    for (const s of spots(ctx, p)) {
      const dir = scale(s.frame.normal, -1);
      // where the axis passes through each body: a thin probe along it, cut down to what lies inside the body
      const stack: { body: Body; enter: number; leave: number }[] = [];
      const reach = bodies.reduce((m, b) => Math.max(m, ...k.sub(b.shape, "vertex").map((v) => Math.abs(dot(sub(k.vertexPoint(v), s.frame.origin), dir)))), 1) + 1;
      for (const body of bodies) {
        const probe = tube(ctx, s.frame.origin, dir, s.frame.x, 0, Math.min(0.05, clear / 8), -1e-3, reach, `${id}:probe`);
        const hit = k.boolean("common", { shape: body.shape, faces: body.topo.faces }, { shape: probe.shape, faces: [] }, id, ctx.own);
        let enter = Infinity, leave = -Infinity;
        for (const v of k.sub(hit.shape, "vertex")) { const t = dot(sub(k.vertexPoint(v), s.frame.origin), dir); enter = Math.min(enter, t); leave = Math.max(leave, t); }
        if (leave - enter > 1e-4) stack.push({ body, enter: Math.max(0, enter), leave });
      }
      stack.sort((a, b) => a.enter - b.enter);
      stack.forEach((part, n) => {
        const first = n === 0, last = n === stack.length - 1 && stack.length > 1;
        const prefix = `${id}:${s.key}:${part.body.id}`;
        const from = frameAt(s.frame, [0, 0], -part.enter);
        const length = part.leave - part.enter + 0.5;
        let tool;
        if (last && p.last !== "clearance") {
          const [diameter, depth] = p.last === "insert" ? f.insert : [f.tap, p.engagement > 0 ? Number(p.engagement) : 2 * f.d];
          // through the part when it is thinner than the hole is deep
          tool = depth >= part.leave - part.enter - 1e-6 ? drill(ctx, from, { diameter, depth: length }, prefix) : drill(ctx, from, { diameter, depth, flat: p.last === "insert" }, prefix);
        } else if (first && p.head === "socket") {
          const cboreDepth = f.cbore[1] + Math.max(0, Number(p.headroom) || 0);
          if (cboreDepth >= part.leave - part.enter) throw ctx.fail(`The first part is ${Math.round((part.leave - part.enter) * 100) / 100} mm thick: too thin for the head's counterbore (${cboreDepth} mm).`);
          tool = drill(ctx, from, { kind: "cbore", diameter: clear, cboreDiameter: f.cbore[0], cboreDepth, depth: length }, prefix);
        } else if (first && p.head === "flat") {
          tool = drill(ctx, from, { kind: "csink", diameter: clear, csinkDiameter: Math.max(f.csink, f.flatD + 0.4), csinkAngle: 90, depth: length }, prefix);
        } else tool = drill(ctx, from, { diameter: clear, depth: length }, prefix);
        combine(ctx, [tool], "remove", [part.body.id]);
        drilled++;
      });
    }
    if (!drilled) ctx.warn("No hole was drilled: the points' axes do not pass through a body.");
  },
});
