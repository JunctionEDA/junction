// cf-hw-nut-pocket.ts — Nut pocket: a place for a captive nut, at each picked point.  A pocket is a hexagonal
// (or square) recess sunk into the surface, as deep as the nut and a little more.  A trap is a slot opening to
// the side, below the surface, that the nut slides into: what a 3D-printed or laser-cut part uses to take a bolt
// from the top.  Either comes with the bolt's clearance hole.  The sizes are the nut's (ISO 4032, DIN 562) plus
// the clearance you give.
//
// Names: `<id>:<point>:pocket:flat`, `:pocket:top`, `:pocket:bottom`, and the bolt hole's `<id>:<point>:wall`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { apply, drill, extruded, ngon, poly, prefixAt, spots, type Tool, type V2 } from "../kernel/ops/cf-hw";
import { clearanceOf, cutFields, fastenerOf, FIT_OPTIONS, HW_SECTION, MENU_THREADS, sizeField, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface NutPocketParams {
  [key: string]: any;
  style: "pocket" | "trap"; nut: "hex" | "square"; size: string; clearance: number; extra: number;
  below: number; reach: number; hole: boolean; fit: "close" | "normal" | "loose"; targets: string[];
}

export default defineFeature<NutPocketParams>({
  type: "cf-hw-nut-pocket",
  title: "Nut pocket",
  icon: '<path class="f" d="M3 4h18v16H3z"/><path d="M3 4h18v16H3z"/><path d="M9.5 8h5l2.5 4-2.5 4h-5L7 12z"/><circle class="s" cx="12" cy="12" r="1.4"/>',
  hint: "Cut a pocket or a side slot that holds a nut captive, with the bolt's hole",
  keywords: "nut pocket captive nut trap slot hex recess t-slot printed insert nut catch",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_THREADS, toolbarOrder: 31, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), style: "pocket", nut: "hex", size: "M4", clearance: 0.2, extra: 0.2, below: 3, reach: 12, hole: true, fit: "normal", targets: [] }),
  schema: [
    ...whereFields({ angle: true, flip: "Opposite direction", noun: "pocket" }),
    { key: "style", label: "Style", kind: "enum", options: [{ value: "pocket", label: "Pocket" }, { value: "trap", label: "Side trap" }] },
    { key: "nut", label: "Nut", kind: "enum", options: [{ value: "hex", label: "Hex" }, { value: "square", label: "Square" }] },
    sizeField(),
    { key: "clearance", label: "Clearance", kind: "number", unit: "mm", min: 0, step: 0.05, hint: "Added across the nut's flats and to its height." },
    { key: "extra", label: "Extra depth", kind: "number", unit: "mm", min: 0, step: 0.1, hint: "How far the nut sits below the surface.", visible: (p) => p.style !== "trap" },
    { key: "below", label: "Depth below surface", kind: "number", unit: "mm", min: 0.1, step: 0.5, hint: "From the surface to the top of the nut.", visible: (p) => p.style === "trap" },
    { key: "reach", label: "Slot length", kind: "number", unit: "mm", min: 0.1, step: 1, hint: "From the bolt's axis to where the slot opens; Turn sets its direction.", visible: (p) => p.style === "trap" },
    { key: "hole", label: "Bolt hole", kind: "boolean" },
    { key: "fit", label: "Hole clearance", kind: "enum", options: FIT_OPTIONS, visible: (p) => !!p.hole },
    ...cutFields,
  ],

  evaluate(ctx: EvalContext, p: NutPocketParams) {
    const f = fastenerOf(p.size);
    if (!f) throw ctx.fail(`The size table has no ${p.size}.`);
    const c = Math.max(0, Number(p.clearance) || 0);
    const square = p.nut === "square";
    const across = f.s + c, height = (square ? f.squareM : f.nutM) + c;
    const tools: Tool[] = [];
    for (const s of spots(ctx, p)) {
      const prefix = prefixAt(ctx, s);
      const hex = ngon([0, 0], square ? 4 : 6, across, 0, "flat");
      if (p.style === "trap") {
        if (!(p.below > 0) || !(p.reach > across / 2)) throw ctx.fail("The slot must be longer than half the nut, and below the surface.");
        // the nut's outline carried sideways to the opening: its far half, then straight walls
        const a = across / 2, rc = a / Math.cos(Math.PI / 6);
        const outline: V2[] = square ? [[p.reach, -a], [-a, -a], [-a, a], [p.reach, a]] : [[p.reach, -a], [-rc / 2, -a], [-rc, 0], [-rc / 2, a], [p.reach, a]];
        tools.push({ ...extruded(ctx, s.frame, poly(outline, "flat"), [], -p.below - height, height, `${prefix}:pocket`), suffix: `${s.key}.trap` });
      } else tools.push({ ...extruded(ctx, s.frame, hex, [], -(height + Math.max(0, Number(p.extra) || 0)), height + Math.max(0, Number(p.extra) || 0), `${prefix}:pocket`), suffix: `${s.key}.pocket` });
      if (p.hole) tools.push({ ...drill(ctx, s.frame, { diameter: clearanceOf(f, p.fit) }, prefix), suffix: `${s.key}.hole` });
    }
    apply(ctx, tools, { operation: "remove", targets: p.targets });
  },
});