// cf-fab-mortise-tenon.ts — Mortise and tenon: a tenon on the end of one board and the mortise for it in the
// board the end stands against.
//
// Pick the end face of the rail (the board that gets the tenon).  The tenon is centred on it, a third of the
// board's thickness unless a thickness is given, with a shoulder at each end of its width; the mortise is cut
// in every other body in scope, a clearance larger all round and a glue gap deeper.  Round ends are what a
// router leaves in the mortise: the tenon is rounded to match.
// Names: `<id>:tenon:…` on the rail (`:end` is the tenon's tip), `<id>:mortise:…` in the other board.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { change, edgeFace, fresh, positive, prism, slotOutline } from "../kernel/ops/cf-fab";
import { LASER, others, pickedFace } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MortiseTenonParams { [key: string]: any; face: GeomRef | null; length: number; thickness: number; shoulder: number; round: boolean; clearance: number; glueGap: number; targets: string[] }

export default defineFeature<MortiseTenonParams>({
  type: "cf-fab-mortise-tenon",
  title: "Mortise and tenon",
  icon: '<path class="f" d="M2 8h9v2.5h4v3h-4V16H2z"/><path d="M2 8h9v2.5h4v3h-4V16H2z"/><path class="f" d="M15 3h6v18h-6z"/><path d="M15 3h6v18h-6z"/><path class="d t" d="M15 10.5h3.5v3H15"/>',
  hint: "A tenon on a board's end and the mortise for it in the board it meets",
  keywords: "mortise tenon joint woodworking rail stile frame furniture joinery loose tenon",
  ...LASER, toolbarOrder: 40,
  defaults: () => ({ face: null, length: 20, thickness: 0, shoulder: 5, round: false, clearance: 0.1, glueGap: 1, targets: [] }),
  schema: [
    { key: "face", label: "End face", kind: "refs", of: ["face"], single: true, hint: "The end of the board that gets the tenon, where it stands against the other board." },
    { key: "length", label: "Tenon length", kind: "number", unit: "mm", min: 0.1, step: 1 },
    { key: "thickness", label: "Tenon thickness", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "0 makes it a third of the board's thickness." },
    { key: "shoulder", label: "Shoulder", kind: "number", unit: "mm", min: 0, step: 1, hint: "How far the tenon stops short of each edge of the board's width." },
    { key: "round", label: "Round ends", kind: "boolean", hint: "As a router cuts the mortise." },
    { key: "clearance", label: "Clearance", kind: "number", unit: "mm", min: 0, step: 0.05, hint: "Room round the tenon in the mortise." },
    { key: "glueGap", label: "Glue gap", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "How much deeper the mortise is than the tenon is long." },
    { key: "targets", label: "Boards to mortise", kind: "bodies", hint: "Leave empty for every other body the tenon reaches." },
  ],

  evaluate(ctx: EvalContext, p: MortiseTenonParams) {
    const f = pickedFace(ctx, p.face, "the end face of the board that gets the tenon");
    const len = positive(ctx, p.length, "tenon length");
    const ef = edgeFace(ctx, f.shape);
    const thick = p.thickness > 0 ? p.thickness : ef.short / 3;
    const shoulder = Math.max(0, Number(p.shoulder) || 0), c = Math.max(0, Number(p.clearance) || 0), gap = Math.max(0, Number(p.glueGap) || 0);
    const width = ef.long - 2 * shoulder;
    if (thick > ef.short + 1e-9) throw ctx.fail("The tenon is thicker than the board.");
    if (width < thick) throw ctx.fail("The shoulders leave too little of the board for a tenon. Make them smaller.");
    const id = ctx.feature.id;
    const m = slotOutline(0, 0, width + 2 * c, thick + 2 * c, !!p.round);
    const mortise = prism(ctx, ef.frame, m.start, m.segs, 0, len + gap, `${id}:mortise`);
    let cut = 0;
    for (const body of others(ctx, f.body, p.targets)) if (change(ctx, body, "cut", mortise) !== body) cut++;
    const t = slotOutline(0, 0, width, thick, !!p.round);
    change(ctx, fresh(ctx, f.body), "fuse", prism(ctx, ef.frame, t.start, t.segs, 0, len, `${id}:tenon`));
    if (!cut && others(ctx, f.body, p.targets).length) ctx.warn("The tenon reaches no other board: no mortise was cut.");
  },
});
