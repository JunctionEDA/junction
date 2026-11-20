// delete-body.ts — the Delete body feature: take bodies out of the part studio from this point in the history
// on.  Earlier features still see them (a body used as a tool and then deleted).
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DeleteBodyParams { [key: string]: any; bodies: string[] }

export default defineFeature<DeleteBodyParams>({
  type: "delete-body",
  title: "Delete body",
  icon: '<path class="f" d="M10 2.5l6.5 3.7v7.4L10 17.3l-6.5-3.7V6.2z"/><path d="M10 2.5l6.5 3.7v7.4L10 17.3l-6.5-3.7V6.2zM3.5 6.2L10 10l6.5-3.8M10 10v7.3"/><path d="M15.5 16l6 6M21.5 16l-6 6" stroke-width="1.75"/>',
  toolbarOrder: 45, toolbarSection: "combine", toolbarMenu: "Transform", toolbarKeep: 40,
  defaults: () => ({ bodies: [] }),
  schema: [{ key: "bodies", label: "Bodies", kind: "bodies", hint: "Click the bodies to delete." }],

  evaluate(ctx: EvalContext, p: DeleteBodyParams) {
    if (!p.bodies || !p.bodies.length) throw ctx.fail("Pick the bodies to delete.");
    let gone = 0;
    for (const id of p.bodies) { const b = ctx.body(id); if (b) ctx.removeBody(b); else gone++; }
    if (gone === p.bodies.length) throw ctx.fail("The bodies to delete are already gone.");
    if (gone) ctx.warn(`${gone} of the bodies to delete ${gone === 1 ? "is" : "are"} already gone.`);
  },
});
