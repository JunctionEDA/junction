// cf-fab-tslot.ts — T-slot joint: the captive nut and bolt joint of laser-cut boxes.
//
// Pick the edge face of the plate that holds the nuts.  At each position a slot for the bolt runs in from the
// edge with a cross slot for a square or hex nut (a T, cut through the plate), and the plates against the edge
// get a clearance hole for the bolt.  Sizes are ISO: the nut's width across flats and thickness per ISO 4032
// (hex) — a square nut of DIN 562 has the same width and is thinner, so it fits the same T.
// Names: `<id>:t<n>:…` (the T), `<id>:hole<n>:wall`.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { at, changeAll, cylinder, edgeFace, frameAt, polyPrism, positive, whole, type P2 } from "../kernel/ops/cf-fab";
import { allowance, fitFields, LASER, others, pickedFace } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Bolt size → [thread diameter, nut width across flats, nut thickness] (ISO 4032). */
export const TSLOT_SIZES: { [size: string]: [number, number, number] } = {
  M2: [2, 4, 1.6], "M2.5": [2.5, 5, 2], M3: [3, 5.5, 2.4], M4: [4, 7, 3.2], M5: [5, 8, 4.7], M6: [6, 10, 5.2], M8: [8, 13, 6.8],
};

export interface TSlotParams { [key: string]: any; face: GeomRef | null; size: string; boltLength: number; mate: number; nutDistance: number; count: number; clearance: number; kerf: number; targets: string[] }

export default defineFeature<TSlotParams>({
  type: "cf-fab-tslot",
  title: "T-slot joint",
  icon: '<path class="f" d="M3 3h18v5H3zM4 10h16v11H4z"/><path d="M3 3h18v5H3zM4 10h7v4H8.5v3h7v-3H13v-4h7v11H4z"/><path class="s" d="M11.3 2h1.4v6h-1.4z"/>',
  hint: "A captive nut and bolt joint: a T-shaped slot in one plate, a bolt hole in the other",
  keywords: "t-slot t slot captive nut bolt joint laser cut box nut trap screw tee",
  ...LASER, toolbarOrder: 16,
  defaults: () => ({ face: null, size: "M3", boltLength: 12, mate: 3, nutDistance: 0, count: 1, clearance: 0.2, kerf: 0, targets: [] }),
  schema: [
    { key: "face", label: "Edge face", kind: "refs", of: ["face"], single: true, hint: "The narrow face of the plate that holds the nuts, where the other plate lies against it." },
    { key: "size", label: "Bolt", kind: "enum", options: Object.keys(TSLOT_SIZES).map((s) => ({ value: s, label: s })) },
    { key: "boltLength", label: "Bolt length", kind: "number", unit: "mm", min: 1, step: 1, hint: "Under the head." },
    { key: "mate", label: "Plate under the head", kind: "number", unit: "mm", min: 0.1, step: 0.5, hint: "The thickness of the plate the bolt goes through before the edge." },
    { key: "nutDistance", label: "Nut from the edge", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "0 puts the nut two threads short of the bolt's end." },
    { key: "count", label: "Count", kind: "number", unit: "none", min: 1, step: 1 },
    ...fitFields("Extra room around the bolt and the nut."),
    { key: "targets", label: "Plates to drill", kind: "bodies", hint: "Leave empty for every other body the bolt reaches." },
  ],

  evaluate(ctx: EvalContext, p: TSlotParams) {
    const f = pickedFace(ctx, p.face, "the edge face of the plate that holds the nuts");
    const size = TSLOT_SIZES[p.size];
    if (!size) throw ctx.fail(`There is no bolt size ${p.size}. Pick one of the list.`);
    const [d, af, nutT] = size;
    const count = whole(ctx, p.count, "count", 1, 100), bolt = positive(ctx, p.boltLength, "bolt length"), mate = positive(ctx, p.mate, "thickness of the plate under the head");
    const allow = allowance(ctx, p);
    const reach = bolt - mate;   // the bolt in the plate
    const nutW = nutT + allow, hb = (d + allow) / 2, hn = (af + allow) / 2;
    if (reach < nutT + 1) throw ctx.fail(`A ${bolt} mm bolt through a ${mate} mm plate leaves too little thread for the nut. Use a longer bolt.`);
    if (!(hb > 0 && nutW > 0)) throw ctx.fail("The kerf is larger than the slot.");
    const pitchOfThread = d * 0.2;
    const nd = p.nutDistance > 0 ? p.nutDistance : Math.max(1, reach - nutW - 2 * pitchOfThread - 0.5);
    const depth = reach + 1;   // the slot runs a little past the bolt's end
    if (nd + nutW > depth + 1e-9) throw ctx.fail("The nut is farther from the edge than the bolt reaches. Move it nearer or use a longer bolt.");
    const ef = edgeFace(ctx, f.shape);
    const pitch = ef.long / count;
    if (af + allow + 2 >= pitch) throw ctx.fail("The edge is too short for that many nuts.");
    const id = ctx.feature.id;
    // the T is drawn looking through the plate: u along the edge, v into the plate
    const g = frameAt(at(ef.frame, 0, -ef.short / 2 - 1, 0), ef.frame.x, ef.frame.y);
    const ts = [], holes = [];
    for (let i = 0; i < count; i++) {
      const x = -ef.long / 2 + pitch * (i + 0.5);
      const pts: P2[] = [[x - hb, -1], [x + hb, -1], [x + hb, nd], [x + hn, nd], [x + hn, nd + nutW], [x + hb, nd + nutW], [x + hb, depth], [x - hb, depth], [x - hb, nd + nutW], [x - hn, nd + nutW], [x - hn, nd], [x - hb, nd]];
      ts.push(polyPrism(ctx, g, pts, 0, ef.short + 2, `${id}:t${i + 1}`, ["mouth", "bolt-r", "nut-front-r", "nut-r", "nut-back-r", "bolt-r2", "end", "bolt-l2", "nut-back-l", "nut-l", "nut-front-l", "bolt-l"]));
      holes.push(cylinder(ctx, ef.frame, [x, 0], hb, 0, mate + 1, `${id}:hole${i + 1}`));
    }
    for (const body of others(ctx, f.body, p.targets)) changeAll(ctx, body, "cut", holes);
    changeAll(ctx, ctx.body(f.body.id)!, "cut", ts);
  },
});
