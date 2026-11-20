// cf-fab-pocket-hole.ts — Pocket hole: the angled, stepped hole of a pocket-hole jig, for screwing the end of a
// board to another.
//
// Pick the end face of the board.  Each hole runs at the jig's angle (15° to the board's face) and comes out in
// the middle of the end's thickness: a pilot bore for the screw's shank next to the end, then the wide pocket
// the screw's head sits in, which breaks out through the board's face.  "Other face" puts the pockets on the
// opposite side of the board.
// Names: `<id>:h<n>:pilot`, `:seat` (the step the head bears on), `:pocket`.
import { defineFeature } from "../core/feature";
import { add, scale, type GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { at, changeAll, edgeFace, frameAt, positive, revolve, whole } from "../kernel/ops/cf-fab";
import { LASER, pickedFace } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PocketHoleParams { [key: string]: any; face: GeomRef | null; count: number; angle: number; pocket: number; pilot: number; pilotLength: number; flip: boolean }

export default defineFeature<PocketHoleParams>({
  type: "cf-fab-pocket-hole",
  title: "Pocket hole",
  icon: '<path class="f" d="M2 9h20v8H2z"/><path d="M2 9h20v8H2z"/><path d="M9 9l8 3.5M12.5 9l6 2.6M17 12.5l1.5-.9M18 12l4 1.5"/><path class="d t" d="M5 5.5l5 2.2"/>',
  hint: "The angled, stepped hole of a pocket-hole jig, at the end of a board",
  keywords: "pocket hole kreg jig angled screw hole woodworking face frame joint",
  ...LASER, toolbarOrder: 46,
  defaults: () => ({ face: null, count: 2, angle: 15, pocket: 9.5, pilot: 4, pilotLength: 12, flip: false }),
  schema: [
    { key: "face", label: "End face", kind: "refs", of: ["face"], single: true, hint: "The end of the board the screws come out of." },
    { key: "count", label: "Count", kind: "number", unit: "none", min: 1, step: 1 },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", min: 5, max: 45, step: 1, hint: "Between the hole and the board's face: 15° for the common jigs." },
    { key: "pocket", label: "Pocket diameter", kind: "number", unit: "mm", min: 0.1, step: 0.5, hint: "9.5 mm (3/8 in) for the common step drill." },
    { key: "pilot", label: "Pilot diameter", kind: "number", unit: "mm", min: 0.1, step: 0.5 },
    { key: "pilotLength", label: "Pilot length", kind: "number", unit: "mm", min: 0.1, step: 1, hint: "From the end of the board to the step the screw's head bears on, along the hole." },
    { key: "flip", label: "Other face", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: PocketHoleParams) {
    const f = pickedFace(ctx, p.face, "the end face of the board");
    const count = whole(ctx, p.count, "count", 1, 100);
    const pocket = positive(ctx, p.pocket, "pocket diameter"), pilot = positive(ctx, p.pilot, "pilot diameter"), pl = positive(ctx, p.pilotLength, "pilot length");
    const angle = Number(p.angle);
    if (!(angle >= 5 && angle <= 45)) throw ctx.fail("The angle must be between 5° and 45°.");
    if (pilot >= pocket) throw ctx.fail("The pilot must be narrower than the pocket.");
    const ef = edgeFace(ctx, f.shape);
    if (pocket >= ef.short) throw ctx.fail(`The board is too thin (${Math.round(ef.short * 10) / 10} mm) for a ${pocket} mm pocket.`);
    const pitch = ef.long / count;
    if (pocket + 2 > pitch) throw ctx.fail("The pockets do not fit across the board. Use fewer.");
    const a = (angle * Math.PI) / 180, side = p.flip ? -1 : 1;
    // into the board and up toward the face the pocket breaks out of
    const dir = add(scale(ef.frame.normal, -Math.cos(a)), scale(ef.frame.y, side * Math.sin(a)));
    // the step must still be inside the board, and the pocket long enough to break out
    if (pl * Math.sin(a) + (pocket / 2) * Math.cos(a) >= ef.short / 2) throw ctx.fail("The pilot is so long that the pocket starts outside the board. Shorten it.");
    const far = ef.short / 2 / Math.sin(a) + pocket / Math.tan(a) + 5;
    const id = ctx.feature.id;
    const tools = Array.from({ length: count }, (_, i) => {
      const x = -ef.long / 2 + pitch * (i + 0.5);
      const g = frameAt(at(ef.frame, x, 0, 0), ef.frame.x, dir);
      return revolve(ctx, g, [[0, -2], [pilot / 2, -2], [pilot / 2, pl], [pocket / 2, pl], [pocket / 2, far], [0, far]], [null, "pilot", "seat", "pocket", null, null], `${id}:h${i + 1}`);
    });
    changeAll(ctx, f.body, "cut", tools);
  },
});
