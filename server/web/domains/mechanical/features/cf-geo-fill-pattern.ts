// cf-geo-fill-pattern.ts — the Fill pattern: copies of features or bodies at every place of a lattice (grid,
// hex or staggered) that lies on a flat face and at least a margin from its edges and holes.  The original is
// one place of the lattice; the lattice can be turned.  Copies are placed by kernel/ops/pattern-core.ts and
// named by their place in the lattice: `<id>:g<i>.<j>:<seed face name>`.
import { defineFeature } from "../core/feature";
import { toPlane, toWorld, type GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { flatFace, placement, seedCentre } from "../kernel/ops/cf-geo";
import type { Instance } from "../kernel/ops/pattern-core";
import { copyDefaults, copyFields, copyInstances, type CopyParams } from "./_pattern";
import { LAYOUT_OPTIONS, inRegion, lattice, type Layout } from "./_cf-geo";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FillPatternParams extends CopyParams { [key: string]: any; face: GeomRef | null; layout: Layout; spacing: number; spacing2: number; angle: number; margin: number }

export default defineFeature<FillPatternParams>({
  type: "cf-geo-fill-pattern",
  title: "Fill pattern",
  hint: "Fill a flat face with copies on a grid, hex or staggered lattice, keeping a margin from its edges.",
  keywords: "fill pattern area region grid hex hexagonal staggered perforated vent holes speaker grille margin boundary",
  icon: '<path class="f" d="M3 6.5l9-3.5 9 3.5v11l-9 3.5-9-3.5z"/><path d="M3 6.5l9-3.5 9 3.5v11l-9 3.5-9-3.5z"/><circle class="s" cx="8" cy="9" r="1.1"/><circle class="s" cx="12" cy="9" r="1.1"/><circle class="s" cx="16" cy="9" r="1.1"/><circle class="s" cx="10" cy="12.3" r="1.1"/><circle class="s" cx="14" cy="12.3" r="1.1"/><circle class="s" cx="8" cy="15.6" r="1.1"/><circle class="s" cx="12" cy="15.6" r="1.1"/><circle class="s" cx="16" cy="15.6" r="1.1"/>',
  toolbarOrder: 302, toolbarSection: "library", toolbarMenu: "Patterns & texture", toolbarKeep: 0,
  defaults: () => ({ ...copyDefaults(), face: null, layout: "hex", spacing: 8, spacing2: 8, angle: 0, margin: 4 }),
  schema: [
    ...copyFields("Copy"),
    { key: "face", label: "Face to fill", kind: "refs", of: ["face"], single: true, hint: "A flat face. Copies go wherever the lattice lies on it." },
    { key: "layout", label: "Layout", kind: "enum", options: LAYOUT_OPTIONS },
    { key: "spacing", label: "Spacing", kind: "number", unit: "mm", min: 0.01, step: 1, hint: "Centre to centre." },
    { key: "spacing2", label: "Row spacing", kind: "number", unit: "mm", min: 0.01, step: 1, visible: (p) => p.layout !== "hex" },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", step: 15, hint: "Turns the lattice about the original." },
    { key: "margin", label: "Margin", kind: "number", unit: "mm", min: 0, step: 1, hint: "The least distance from a copy's centre to the face's edges and holes." },
  ],

  evaluate(ctx: EvalContext, p: FillPatternParams) {
    if (!(p.spacing > 0) || (p.layout !== "hex" && !(p.spacing2 > 0))) throw ctx.fail("The spacing must be more than zero.");
    if (!(p.margin >= 0)) throw ctx.fail("The margin cannot be less than zero.");
    const f = flatFace(ctx, p.face, "face to fill");
    const centre = seedCentre(ctx, p), anchor = toPlane(f.frame, centre);
    const sites = lattice(p.layout, p.spacing, p.spacing2, ((Number(p.angle) || 0) * Math.PI) / 180, anchor, f.box, 40000);
    if (sites.some((s) => s.key === "too-many")) throw ctx.fail("The spacing is too small for this face: that is too many copies.");
    const inside = sites.filter((s) => !(s.i === 0 && s.j === 0) && inRegion(f.region, s.at, p.margin));
    if (inside.length > 2500) throw ctx.fail(`That is too many copies (${inside.length}; at most 2500). Use a larger spacing.`);
    if (!inside.length) ctx.warn("No copy fits: the face is smaller than the spacing and margin leave room for.");
    // each copy moves in the face's plane, from where the original is
    const instances: Instance[] = inside.map((s) => ({ key: s.key, trsf: placement(ctx, toWorld(f.frame, anchor), toWorld(f.frame, s.at), f.frame.normal) }));
    copyInstances(ctx, p, instances, "pattern");
  },
});
