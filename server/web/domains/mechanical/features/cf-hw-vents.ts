// cf-hw-vents.ts — Vents: a field of openings cut in a wall, about a picked point: rows of slots, a grid of round
// holes, or a honeycomb of hexagons.  Slots can be cut on a slant (louvres), so that air passes and a straight
// finger or a line of sight does not.  All of it is one cut.
//
// Names: `<id>:<place>:v<row>.<column>:side` (and `:wall` for round holes, `:flat` for hexagons).
import { defineFeature } from "../core/feature";
import { add, scale } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { reachPast } from "../kernel/ops/shapes";
import { apply, circle, extruded, ngon, prefixAt, scoped, slot, spots, together, type Loop, type Tool, type V2 } from "../kernel/ops/cf-hw";
import { cutFields, HW_SECTION, MENU_ENCLOSURES, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface VentsParams {
  [key: string]: any;
  style: "slots" | "holes" | "hex"; columns: number; rows: number; length: number; width: number; pitch: number; rowPitch: number;
  tilt: number; depth: number; targets: string[];
}

export default defineFeature<VentsParams>({
  type: "cf-hw-vents",
  title: "Vents",
  icon: '<path class="f" d="M3 4h18v16H3z"/><path d="M3 4h18v16H3z"/><rect class="s" x="6.5" y="7" width="11" height="2" rx="1"/><rect class="s" x="6.5" y="11" width="11" height="2" rx="1"/><rect class="s" x="6.5" y="15" width="11" height="2" rx="1"/>',
  hint: "Cut a field of vent slots, louvres, round holes or a hexagon honeycomb in a wall",
  keywords: "vent slots louver louvre grille ventilation holes honeycomb hex perforated cooling air speaker",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_ENCLOSURES, toolbarOrder: 60, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), style: "slots", columns: 1, rows: 6, length: 30, width: 2, pitch: 5, rowPitch: 5, tilt: 0, depth: 0, targets: [] }),
  schema: [
    ...whereFields({ angle: true, flip: "Opposite direction", noun: "field" }),
    { key: "style", label: "Openings", kind: "enum", options: [{ value: "slots", label: "Slots" }, { value: "holes", label: "Holes" }, { value: "hex", label: "Honeycomb" }] },
    { key: "columns", label: "Across", kind: "number", unit: "none", min: 1, max: 60, step: 1 },
    { key: "rows", label: "Rows", kind: "number", unit: "none", min: 1, max: 60, step: 1 },
    { key: "length", label: "Slot length", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => p.style === "slots" },
    { key: "width", label: "Width / Ø", kind: "number", unit: "mm", min: 0.1, step: 0.5, hint: "A slot's width, a hole's diameter, a hexagon across its flats." },
    { key: "pitch", label: "Spacing across", kind: "number", unit: "mm", min: 0.1, step: 1, hint: "Centre to centre. For slots: between the ends of one and the start of the next, plus a slot's length." },
    { key: "rowPitch", label: "Spacing of rows", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => p.style !== "hex" },
    { key: "tilt", label: "Louvre angle", kind: "number", unit: "deg", min: -60, max: 60, step: 5, hint: "Cut the slots on a slant.", visible: (p) => p.style === "slots" },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0, step: 1, hint: "0 cuts through everything behind the face: give the wall's thickness to cut one wall of a box." },
    ...cutFields,
  ],

  evaluate(ctx: EvalContext, p: VentsParams) {
    const nx = Math.round(Number(p.columns) || 1), ny = Math.round(Number(p.rows) || 1);
    if (nx < 1 || ny < 1 || nx * ny > 600) throw ctx.fail("Give at least one opening, and at most 600.");
    const w = Number(p.width), pitch = Number(p.pitch);
    if (!(w > 0) || !(pitch > 0)) throw ctx.fail("The openings' width and spacing must be more than zero.");
    const hex = p.style === "hex", slots = p.style === "slots";
    const len = slots ? Number(p.length) : 0;
    if (slots && !(len >= w)) throw ctx.fail("A slot must be at least as long as it is wide.");
    const dx = slots ? Math.max(pitch, len + 0.2) : pitch;
    const dy = hex ? (pitch * Math.sqrt(3)) / 2 : Number(p.rowPitch);
    if (!(dy > 0)) throw ctx.fail("The spacing of the rows must be more than zero.");
    if (!slots && pitch <= w + 1e-6) throw ctx.fail("The openings overlap: space them further apart than they are wide.");
    if (!hex && dy <= w + 1e-6) throw ctx.fail("The rows overlap: space them further apart than the openings are wide.");
    const tilt = slots ? ((Number(p.tilt) || 0) * Math.PI) / 180 : 0;
    const bodies = scoped(ctx, p.targets);
    const tools: Tool[] = [];
    for (const s of spots(ctx, p)) {
      const f = s.frame, prefix = prefixAt(ctx, s);
      const depth = p.depth > 0 ? Number(p.depth) : reachPast(ctx.k, bodies.map((b) => b.shape), f.origin);
      // straight down, or leaning across the slots
      const along = add(scale(f.normal, -depth - 0.01), scale(f.y, -(depth + 0.01) * Math.tan(tilt)));
      const cuts = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const at: V2 = [(i - (nx - 1) / 2) * dx + (hex && j % 2 ? dx / 2 : 0), (j - (ny - 1) / 2) * dy];
        const outline: Loop = slots ? slot(at, len - w, w, 0, "side") : hex ? ngon(at, 6, w, 0, "flat") : circle(at, w / 2, "wall");
        cuts.push(extruded(ctx, f, outline, [], 0.01, -1, `${prefix}:v${j + 1}.${i + 1}`, along));
      }
      tools.push({ ...together(ctx, cuts), suffix: s.key });
    }
    apply(ctx, tools, { operation: "remove", targets: p.targets });
  },
});
