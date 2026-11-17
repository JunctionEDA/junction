// extrude.ts — the Extrude feature: sweep the closed regions of a sketch along the sketch's normal, as a new
// body, added to the bodies it touches, or removed from them.
//
// Also the reference for writing a feature: parameters with defaults, a schema the dialog is generated from,
// and an evaluate that reads the model through `ctx`, uses the kernel helpers that keep geometry names, and
// fails with messages a person can act on.
import { defineFeature } from "../core/feature";
import { scale } from "../core/geometry";
import type { Body, EvalContext, NamedShape, Shape } from "../kernel/types";
import type { NamedResult } from "../kernel/occ";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ExtrudeParams {
  [key: string]: any;
  /** the sketch, and which of its regions (null: all of them) */
  profile: { sketch: string; regions: string[] | null } | null;
  operation: "new" | "add" | "remove";
  /** how far the extrusion goes; "blind" is a depth, and the key leaves room for through-all, up-to-face, symmetric */
  endType: "blind";
  depth: number;
  /** extrude against the sketch normal instead of along it */
  flip: boolean;
  /** the bodies Add and Remove act on; empty means every body */
  targets: string[];
}

export default defineFeature<ExtrudeParams>({
  type: "extrude",
  title: "Extrude",
  icon: '<path d="M5 14l7 4 7-4"/><path d="M5 14V9l7-4 7 4v5"/><path d="M5 9l7 4 7-4"/><path d="M12 13v5"/>',
  toolbarOrder: 20,
  defaults: () => ({ profile: null, operation: "new", endType: "blind", depth: 10, flip: false, targets: [] }),
  schema: [
    { key: "profile", label: "Sketch to extrude", kind: "profile" },
    { key: "operation", label: "Result", kind: "enum", options: [{ value: "new", label: "New" }, { value: "add", label: "Add" }, { value: "remove", label: "Remove" }] },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0.001, step: 1 },
    { key: "flip", label: "Opposite direction", kind: "boolean" },
    { key: "targets", label: "Bodies to change", kind: "bodies", hint: "Leave empty for every body.", visible: (p) => p.operation !== "new" },
  ],

  evaluate(ctx: EvalContext, p: ExtrudeParams) {
    const k = ctx.k, id = ctx.feature.id;
    if (!p.profile || !p.profile.sketch) throw ctx.fail("Pick a sketch to extrude.");
    if (!(p.depth > 0)) throw ctx.fail("The depth must be more than zero.");
    const sketch = ctx.sketch(p.profile.sketch);
    const wanted = p.profile.regions;
    const regions = sketch.regions.filter((r) => !wanted || wanted.includes(r.id));
    if (!regions.length) throw ctx.fail(sketch.regions.length ? "The regions this feature used are gone from the sketch. Edit the feature and pick the sketch again." : "The sketch has no closed region to extrude. Close its outline first.");
    const along = scale(sketch.frame.normal, p.flip ? -p.depth : p.depth);

    const tools: NamedResult[] = regions.map((r) => k.prism(r.face, along, id, r.id, r.edges, ctx.own));
    if (p.operation === "new") {
      tools.forEach((t, i) => ctx.addBody(t.shape, t.names, { suffix: tools.length > 1 ? regions[i].id : undefined }));
      return;
    }

    const scope = (b: Body) => !p.targets || !p.targets.length || p.targets.includes(b.id);
    const faces = (t: NamedResult): NamedShape[] => k.namedFaces(t.shape, t.names, id);
    if (p.operation === "remove") {
      const targets = ctx.bodies().filter(scope);
      if (!targets.length) throw ctx.fail("There is no body to remove material from.");
      let changed = false;
      for (let body of targets) {
        for (const t of tools) {
          const r = k.boolean("cut", { shape: body.shape, faces: body.topo.faces }, { shape: t.shape, faces: faces(t) }, id, ctx.own);
          const was = k.volume(body.shape), now = k.volume(r.shape);
          if (Math.abs(was - now) <= 1e-9 * Math.max(1, was)) continue;   // this extrusion does not reach into this body
          changed = true;
          const solids = k.solids(r.shape);
          if (!solids.length) { ctx.removeBody(body); break; }
          // the cut may leave several pieces: the first stays this body, the others become bodies of their own
          const whole = body;
          body = ctx.replaceBody(body, solids[0], r.names);
          solids.slice(1).forEach((s: Shape, n: number) => ctx.addBody(s, r.names, { suffix: `${whole.id}.piece${n + 2}`, name: `${whole.name} (${n + 2})` }));
        }
      }
      if (!changed) ctx.warn("Nothing was removed: the extrusion does not reach into a body.");
      return;
    }

    // add: each extrusion joins every body it touches into one; touching none, it becomes a body of its own
    tools.forEach((t, i) => {
      let host: Body | null = null;
      for (const body of ctx.bodies().filter(scope)) {
        const r: NamedResult = host
          ? k.boolean("fuse", { shape: host.shape, faces: host.topo.faces }, { shape: body.shape, faces: body.topo.faces }, id, ctx.own)
          : k.boolean("fuse", { shape: body.shape, faces: body.topo.faces }, { shape: t.shape, faces: faces(t) }, id, ctx.own);
        const solids = k.solids(r.shape);
        if (solids.length !== 1) continue;   // they do not touch: both stay as they are
        if (host) { ctx.removeBody(body); host = ctx.replaceBody(host, solids[0], r.names); }
        else host = ctx.replaceBody(body, solids[0], r.names);
      }
      if (!host) ctx.addBody(t.shape, t.names, { suffix: tools.length > 1 ? regions[i].id : undefined });
    });
  },
});
