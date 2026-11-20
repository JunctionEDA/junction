// cf-fab-living-hinge.ts — Living hinge: rows of staggered slits through a plate, so a stiff sheet (plywood,
// MDF, acrylic) bends along a band.
//
// Pick the flat side of the plate.  The band lies across the plate at an offset from its middle; the slits run
// along the bend axis, in rows a pitch apart, each row shifted half a period against the last so the material
// left between them is a chain of thin torsion bars.  Even rows have a bridge at the plate's
// middle and stop a bridge short of its edges; odd rows run out through the edges.
// Names: `<id>:r<row>.<n>:…`.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import { box, change, frameAt, plateOf, positive, together } from "../kernel/ops/cf-fab";
import { LASER, pickedFace } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface LivingHingeParams { [key: string]: any; face: GeomRef | null; axis: "short" | "long"; offset: number; band: number; slit: number; bridge: number; pitch: number; width: number }

export default defineFeature<LivingHingeParams>({
  type: "cf-fab-living-hinge",
  title: "Living hinge",
  icon: '<path class="f" d="M2 5h20v14H2z"/><path d="M2 5h20v14H2z"/><path d="M8 5v4M8 11v6M10.7 7v6M10.7 15v4M13.3 5v4M13.3 11v6M16 7v6M16 15v4"/>',
  hint: "Staggered slits through a plate so it bends: a lattice hinge for laser-cut sheet",
  keywords: "living hinge lattice hinge kerf bending flex slits laser plywood bend pattern",
  ...LASER, toolbarOrder: 24,
  defaults: () => ({ face: null, axis: "short", offset: 0, band: 30, slit: 20, bridge: 3, pitch: 2, width: 0.3 }),
  schema: [
    { key: "face", label: "Plate face", kind: "refs", of: ["face"], single: true, hint: "The flat side of the plate." },
    { key: "axis", label: "Bend along", kind: "enum", options: [{ value: "short", label: "Short side" }, { value: "long", label: "Long side" }], hint: "The direction the slits run in: the axis the plate bends about." },
    { key: "offset", label: "From the middle", kind: "number", unit: "mm", step: 1, hint: "Where the band is, measured from the middle of the plate." },
    { key: "band", label: "Band width", kind: "number", unit: "mm", min: 0.1, step: 1 },
    { key: "slit", label: "Slit length", kind: "number", unit: "mm", min: 0.1, step: 1 },
    { key: "bridge", label: "Bridge", kind: "number", unit: "mm", min: 0.1, step: 0.5, hint: "The material left between two slits of a row." },
    { key: "pitch", label: "Row spacing", kind: "number", unit: "mm", min: 0.1, step: 0.5 },
    { key: "width", label: "Slit width", kind: "number", unit: "mm", min: 0.01, step: 0.05, hint: "The width of the cut: the laser's kerf, or the cutter's diameter." },
  ],

  evaluate(ctx: EvalContext, p: LivingHingeParams) {
    const f = pickedFace(ctx, p.face, "the flat side of the plate");
    const band = positive(ctx, p.band, "band width"), slit = positive(ctx, p.slit, "slit length"), bridge = positive(ctx, p.bridge, "bridge"), pitch = positive(ctx, p.pitch, "row spacing"), width = positive(ctx, p.width, "slit width");
    if (width >= pitch) throw ctx.fail("The rows are closer together than a slit is wide. Increase the row spacing.");
    const pl = plateOf(ctx, f.body, f.shape);
    // u across the band (the rows are a pitch apart along it), v along the slits
    const alongLong = p.axis === "long";
    const g = alongLong ? frameAt(pl.frame.origin, pl.frame.y, pl.frame.normal) : pl.frame;
    const across = alongLong ? pl.size[1] : pl.size[0], run = alongLong ? pl.size[0] : pl.size[1];
    const offset = Number(p.offset) || 0;
    if (Math.abs(offset) + band / 2 > across / 2 + 1e-6) throw ctx.fail("The band does not fit on the plate there. Move it or make it narrower.");
    const period = slit + bridge;
    if (run < period) throw ctx.fail("The plate is narrower than one slit and one bridge. Shorten the slits.");
    const rows = Math.floor((band - width) / pitch + 1e-9) + 1;
    const perRow = Math.ceil(run / period) + 1;
    if (rows * perRow > 900) throw ctx.fail("That is too many slits (more than 900). Use a narrower band, longer slits or wider row spacing.");
    const id = ctx.feature.id, half = run / 2;
    const tools: NamedResult[] = [];
    for (let r = 0; r < rows; r++) {
      const u = offset - ((rows - 1) * pitch) / 2 + r * pitch;
      // even rows: bridges at 0, ±period, …; odd rows: slits centred there
      const shift = r % 2 === 0 ? period / 2 : 0;
      const first = Math.ceil((-half - slit / 2 - shift) / period), last = Math.floor((half + slit / 2 - shift) / period);
      for (let j = first; j <= last; j++) {
        const c = shift + j * period;
        // odd rows run out through the edges; even rows stop a bridge short of them, and a stub is left out
        let v0 = c - slit / 2, v1 = c + slit / 2;
        if (r % 2) { if (v0 < -half + bridge) v0 = -half - 1; if (v1 > half - bridge) v1 = half + 1; }
        else { v0 = Math.max(v0, -half + bridge); v1 = Math.min(v1, half - bridge); }
        if (Math.min(v1, half) - Math.max(v0, -half) < Math.max(bridge, 2 * width)) continue;
        tools.push(box(ctx, g, [u - width / 2, v0, -pl.thickness - 1], [u + width / 2, v1, 1], `${id}:r${r + 1}.${j - first + 1}`));
      }
    }
    if (!tools.length) throw ctx.fail("The band is too narrow for a row of slits.");
    const before = ctx.bodies().length;
    change(ctx, f.body, "cut", together(ctx, tools));
    if (ctx.bodies().length !== before) throw ctx.fail("The slits cut the plate in two. Shorten them or widen the bridges.");
  },
});
