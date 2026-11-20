// cf-drive-keyway.ts — Keyway: the seat of a parallel key, cut in a shaft or in a bore, sized by DIN 6885-1 from
// the diameter of the cylindrical face picked.  On a shaft it is a keyseat as deep as the standard's t1, with
// round ends (as an end mill leaves, for a form A key) or square ones, at a distance from the shaft's end; in a
// bore it is the hub's keyway, t2 deep, through the whole bore or over a length.
//
// Names: `<id>:floor`, `<id>:a`, `<id>:b` (the sides), `<id>:end1`, `<id>:end2`.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { Pen, polyLoop, prismOf, Space, type Loop } from "../kernel/ops/cf-drive";
import { cutFrom, DRIVES, num, positive, roundField, roundOf, SECTION } from "./_cf-drive";
import { keyFor } from "./_cf-drive-data";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface KeywayParams { [key: string]: any; face: GeomRef | null; size: "din" | "custom"; width: number; depth: number; length: number; offset: number; ends: "round" | "square"; flip: boolean; angle: number }

export default defineFeature<KeywayParams>({
  type: "cf-keyway",
  title: "Keyway",
  icon: '<circle class="f" cx="12" cy="13" r="8.5"/><path d="M9.5 4.9a8.5 8.5 0 1 0 5 0V8.5h-5z"/><path class="s" d="M10.3 3h3.4v4.7h-3.4z"/>',
  hint: "A key seat in a shaft or a keyway in a bore, sized by DIN 6885 from the diameter",
  keywords: "keyway keyseat key slot parallel key feather key DIN 6885 shaft key hub",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 40, toolbarKeep: 0,
  defaults: () => ({ face: null, size: "din", width: 6, depth: 3.5, length: 20, offset: 5, ends: "round", flip: false, angle: 0 }),
  schema: [
    roundField,
    { key: "size", label: "Size", kind: "enum", options: [{ value: "din", label: "DIN 6885" }, { value: "custom", label: "Custom" }] },
    { key: "width", label: "Width", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => p.size === "custom" },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0.1, step: 0.5, hint: "Below the shaft's surface, or beyond the bore's wall.", visible: (p) => p.size === "custom" },
    { key: "length", label: "Length", kind: "number", unit: "mm", min: 0, step: 1, hint: "0 runs it the whole length of the face." },
    { key: "offset", label: "From the end", kind: "number", unit: "mm", min: 0, step: 1, visible: (p) => Number(p.length) > 0 },
    { key: "ends", label: "Ends", kind: "enum", options: [{ value: "round", label: "Round" }, { value: "square", label: "Square" }], visible: (p) => Number(p.length) > 0 },
    { key: "flip", label: "From the other end", kind: "boolean", visible: (p) => Number(p.length) > 0 },
    { key: "angle", label: "Turned", kind: "number", unit: "deg", step: 15, hint: "Where round the axis the keyway is." },
  ],
  evaluate(ctx: EvalContext, p: KeywayParams) {
    const id = ctx.feature.id;
    const on = roundOf(ctx, p.face, p.flip, p.angle), d = 2 * on.radius;
    let b: number, t: number;
    if (p.size === "custom") { b = positive(ctx, p.width, "The width"); t = positive(ctx, p.depth, "The depth"); }
    else {
      const key = keyFor(Math.round(d * 1000) / 1000);
      if (!key) throw ctx.fail(`DIN 6885 has keys for diameters over 6 mm up to 150 mm; this face is ${d.toFixed(2)} mm. Use Custom.`);
      b = key.b; t = on.bore ? key.t2 : key.t1;
    }
    if (!(b < d * 0.9)) throw ctx.fail("The key is as wide as the face. Use a narrower one.");
    if (!on.bore && !(t < on.radius)) throw ctx.fail("The keyseat is deeper than the shaft's radius.");
    const whole = !(num(p.length) > 0), length = whole ? on.length + 2 : num(p.length), z0 = whole ? -1 : Math.max(0, num(p.offset));
    if (!whole && z0 + length > on.length + 1e-6) ctx.warn(`The keyway runs ${(z0 + length - on.length).toFixed(2)} mm past the end of the face.`);
    // drawn looking down on the keyway from outside the shaft: u across it, v along the axis; then pushed into the material
    const s = on.space;
    const from = on.bore ? Math.sqrt(on.radius * on.radius - (b * b) / 4) - 0.02 * b : on.radius - t;
    const depth = on.bore ? on.radius + t - from : t + on.radius * 0.1 + 1;
    const look = new Space(s.p([from, 0, 0]), s.y, s.z, s.x);
    let outline: Loop;
    if (!whole && p.ends !== "square" && length > b + 1e-6) {
      const pen = new Pen([-b / 2, z0 + b / 2]);
      pen.arc([0, z0], [b / 2, z0 + b / 2], "end1").line([b / 2, z0 + length - b / 2], "b").arc([0, z0 + length], [-b / 2, z0 + length - b / 2], "end2");
      outline = pen.close("a");
    } else outline = polyLoop([[-b / 2, z0], [b / 2, z0], [b / 2, z0 + length], [-b / 2, z0 + length]], (i) => ["end1", "b", "end2", "a"][i]);
    const tool = prismOf(ctx, look, outline, [], 0, depth, id);
    const names = tool.names;
    // the face at the bottom of a keyseat, or at the back of a hub's keyway, is its floor
    tool.names = (f, i) => { const n = names(f, i); return n === `${id}:${on.bore ? "top" : "bottom"}` ? `${id}:floor` : n; };
    cutFrom(ctx, on.body, tool);
  },
});
