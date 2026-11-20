// cf-hw-magnet-pocket.ts — Magnet pocket: a recess that holds a disc or block magnet by a press fit, at each
// picked point.  The pocket is a little larger than the magnet all round; small ribs stand in from its wall and
// pinch the magnet, so it presses in without glue and without splitting the part: the ribs give, the wall does
// not.  A hole through the floor lets the magnet be pushed out again.
//
// Names: `<id>:<point>:wall`, `:rib` (numbered), `:floor` (the pocket's `:bottom`), and the push-out hole's `:wall`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import type { NamedResult } from "../kernel/occ";
import { apply, circle, cut, drill, extruded, prefixAt, roundRect, spots, together, type Tool, type V2 } from "../kernel/ops/cf-hw";
import { cutFields, HW_SECTION, MENU_ENCLOSURES, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MagnetPocketParams {
  [key: string]: any;
  shape: "disc" | "block"; diameter: number; length: number; width: number; thickness: number;
  clearance: number; ribs: number; pinch: number; recess: number; push: number; targets: string[];
}

export default defineFeature<MagnetPocketParams>({
  type: "cf-hw-magnet-pocket",
  title: "Magnet pocket",
  icon: '<path class="f" d="M3 4h18v16H3z"/><path d="M3 4h18v16H3z"/><circle cx="12" cy="12" r="5.5"/><path class="s" d="M12 6.5l1 1.6h-2zM17.5 12l-1.6 1v-2zM12 17.5l-1-1.6h2zM6.5 12l1.6-1v2z"/>',
  hint: "Cut a press-fit pocket with crush ribs for a disc or block magnet",
  keywords: "magnet pocket press fit crush ribs neodymium disc block recess hold snap",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_ENCLOSURES, toolbarOrder: 51, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), shape: "disc", diameter: 6, length: 10, width: 5, thickness: 3, clearance: 0.2, ribs: 3, pinch: 0.15, recess: 0.2, push: 0, targets: [] }),
  schema: [
    ...whereFields({ angle: true, flip: "Opposite direction", noun: "pocket" }),
    { key: "shape", label: "Magnet", kind: "enum", options: [{ value: "disc", label: "Disc" }, { value: "block", label: "Block" }] },
    { key: "diameter", label: "Diameter", kind: "number", unit: "mm", min: 0.5, step: 1, visible: (p) => p.shape !== "block" },
    { key: "length", label: "Length", kind: "number", unit: "mm", min: 0.5, step: 1, visible: (p) => p.shape === "block" },
    { key: "width", label: "Width", kind: "number", unit: "mm", min: 0.5, step: 1, visible: (p) => p.shape === "block" },
    { key: "thickness", label: "Thickness", kind: "number", unit: "mm", min: 0.1, step: 0.5 },
    { key: "clearance", label: "Clearance", kind: "number", unit: "mm", min: 0, step: 0.05, hint: "Added to the magnet's size: the gap between it and the pocket's wall." },
    { key: "ribs", label: "Ribs", kind: "number", unit: "none", min: 0, max: 12, step: 1, hint: "A disc: this many round the wall. A block: this many on each long side. 0 for none." },
    { key: "pinch", label: "Pinch", kind: "number", unit: "mm", min: 0, step: 0.05, hint: "How much smaller than the magnet the ribs leave the pocket." },
    { key: "recess", label: "Below the surface", kind: "number", unit: "mm", min: 0, step: 0.1 },
    { key: "push", label: "Push-out hole Ø", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "A hole through the floor; 0 for none." },
    ...cutFields,
  ],

  evaluate(ctx: EvalContext, p: MagnetPocketParams) {
    const block = p.shape === "block";
    const c = Math.max(0, Number(p.clearance) || 0), pinch = Math.max(0, Number(p.pinch) || 0);
    const ribs = Math.round(Number(p.ribs) || 0);
    if (ribs < 0 || ribs > 12) throw ctx.fail("The number of ribs must be between 0 and 12.");
    if (!(p.thickness > 0)) throw ctx.fail("The magnet's thickness must be more than zero.");
    const depth = Number(p.thickness) + Math.max(0, Number(p.recess) || 0);
    const size = block ? [Number(p.length), Number(p.width)] : [Number(p.diameter), Number(p.diameter)];
    if (!(size[0] > 0) || !(size[1] > 0)) throw ctx.fail("The magnet's size must be more than zero.");
    // a rib is a round bump: how far it stands in from the wall takes up the clearance and the pinch
    const stand = c / 2 + pinch / 2, rr = Math.max(0.5, Math.min(size[1] * 0.2, 1.5));
    const tools: Tool[] = [];
    for (const s of spots(ctx, p)) {
      const prefix = prefixAt(ctx, s);
      const outline = block ? roundRect([0, 0], size[0] + c, size[1] + c, Math.min(0.5, size[1] / 6), 0, "wall") : circle([0, 0], (size[0] + c) / 2, "wall");
      let pocket: NamedResult = extruded(ctx, s.frame, outline, [], -depth, depth, prefix);
      if (ribs > 0 && stand > 1e-6) {
        const at: V2[] = [];
        if (block) for (let i = 0; i < ribs; i++) { const x = (size[0] + c) * ((i + 0.5) / ribs - 0.5); at.push([x, (size[1] + c) / 2 + rr - stand], [x, -((size[1] + c) / 2 + rr - stand)]); }
        else for (let i = 0; i < ribs; i++) { const a = (2 * Math.PI * i) / ribs, d = (size[0] + c) / 2 + rr - stand; at.push([d * Math.cos(a), d * Math.sin(a)]); }
        // the ribs are left standing: they are taken out of what the pocket removes
        const bumps = at.map((q, i) => extruded(ctx, s.frame, circle(q, rr, "rib"), [], -depth - 0.01, depth + 0.02, `${prefix}:r${i}`));
        const ribbed = cut(ctx, pocket, together(ctx, bumps));
        pocket = { shape: ribbed.shape, names: (face, n) => { const name = ribbed.names(face, n); return name && /:r\d+:rib/.test(name) ? `${prefix}:rib` : name; } };
      }
      tools.push({ ...pocket, suffix: s.key });
      if (p.push > 0) tools.push({ ...drill(ctx, s.frame, { diameter: Number(p.push) }, `${prefix}:push`), suffix: `${s.key}.push` });
    }
    apply(ctx, tools, { operation: "remove", targets: p.targets });
  },
});
