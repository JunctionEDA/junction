// composite-part.ts — the Composite part feature: several bodies held as one part, without joining them (a
// bearing, a cable with its plugs, a weldment bought as one item).  "Closed" takes the bodies into the composite:
// they are no longer parts of their own, and the composite is one row in the parts list and one item in an
// assembly.  Open, the bodies stay and the composite is kept beside them as reference geometry.
//
// Names: a face of the composite is `<id>:<the body's id>:<the face's name>`, since names are only unique within
// a body.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { ShapeIndex } from "../kernel/occ";
import { compound } from "../kernel/ops/shapes";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CompositePartParams { [key: string]: any; bodies: string[]; closed: boolean }

export default defineFeature<CompositePartParams>({
  type: "composite-part",
  title: "Composite part",
  hint: "Hold several parts as one, without joining them.",
  keywords: "group parts together one item closed open multi body",
  icon: '<rect class="f" x="3.5" y="9.5" width="8" height="8" rx="1"/><rect x="3.5" y="9.5" width="8" height="8" rx="1"/><circle class="f" cx="15.5" cy="9" r="4"/><circle cx="15.5" cy="9" r="4"/><rect class="d t" x="1.5" y="3" width="21" height="17.5" rx="2.5"/>',
  toolbarOrder: 47, toolbarSection: "combine", toolbarKeep: 30,
  defaults: () => ({ bodies: [], closed: true }),
  schema: [
    { key: "bodies", label: "Parts", kind: "bodies", hint: "The bodies that make up the composite: two or more." },
    { key: "closed", label: "Closed", kind: "boolean", hint: "The parts are taken into the composite and are no longer parts of their own." },
  ],

  evaluate(ctx: EvalContext, p: CompositePartParams) {
    const k = ctx.k, id = ctx.feature.id;
    const ids = Array.isArray(p.bodies) ? p.bodies : [];
    if (ids.length < 2) throw ctx.fail("Pick two or more parts for the composite.");
    const bodies = ids.map((b) => { const body = ctx.body(b); if (!body) throw ctx.fail("A part of the composite is gone. Edit the feature and pick it again."); return body; });
    if (new Set(bodies.map((b) => b.id)).size !== bodies.length) throw ctx.fail("A part is in the composite twice.");
    const shape = compound(k, bodies.map((b) => b.shape), ctx.own);
    const index = new ShapeIndex<string>(k);
    for (const b of bodies) for (const f of b.topo.faces) index.add(f.shape, `${id}:${b.id}:${f.name}`);
    if (p.closed !== false) for (const b of bodies) ctx.removeBody(b);
    ctx.addBody(shape, (f) => index.get(f) ?? null, { name: ctx.feature.name, reference: p.closed === false });
  },
});
