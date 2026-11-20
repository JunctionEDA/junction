// cf-hw-mount-pattern.ts — Mount pattern: the holes of a standard mount in one feature.  Stepper motor faces
// (NEMA 8 to 34: four screws on a square and the pilot hole for the motor's boss) and display mounts (VESA 75,
// 100, 200×100, 200 …: four screws on a rectangle).  The screw holes are clearance holes for the standard's
// screw, or slots so the motor can be slid to tension a belt.
//
// Names: `<id>:<place>:h1…h4:wall` (or `:side` for slots), `<id>:<place>:pilot:wall`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { reachPast } from "../kernel/ops/shapes";
import { apply, cornerPoints, extruded, prefixAt, scoped, slot, spots, together, type Tool } from "../kernel/ops/cf-hw";
import { clearanceOf, cutFields, fastenerOf, FIT_OPTIONS, HW_SECTION, MENU_ENCLOSURES, NEMA, options, VESA, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MountPatternParams { [key: string]: any; standard: string; fit: "close" | "normal" | "loose"; pilot: boolean; pilotClearance: number; slots: number; depth: number; targets: string[] }

const isNema = (p: any) => String(p.standard).startsWith("NEMA");

export default defineFeature<MountPatternParams>({
  type: "cf-hw-mount-pattern",
  title: "Mount pattern",
  icon: '<path class="f" d="M3 3h18v18H3z"/><path d="M3 3h18v18H3z"/><circle cx="12" cy="12" r="4.5"/><circle class="s" cx="6.5" cy="6.5" r="1.3"/><circle class="s" cx="17.5" cy="6.5" r="1.3"/><circle class="s" cx="6.5" cy="17.5" r="1.3"/><circle class="s" cx="17.5" cy="17.5" r="1.3"/>',
  hint: "Cut a standard hole pattern: NEMA stepper motor faces (8 to 34) or VESA display mounts (75, 100, 200)",
  keywords: "nema motor mount stepper nema17 nema23 vesa 75 100 200 mis-d monitor bracket hole pattern bolt circle",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_ENCLOSURES, toolbarOrder: 52, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), standard: "NEMA 17", fit: "normal", pilot: true, pilotClearance: 0.5, slots: 0, depth: 0, targets: [] }),
  schema: [
    ...whereFields({ angle: true, flip: "Opposite direction", noun: "pattern" }),
    { key: "standard", label: "Standard", kind: "enum", options: options([...Object.keys(NEMA), ...Object.keys(VESA)]) },
    { key: "fit", label: "Screw clearance", kind: "enum", options: FIT_OPTIONS },
    { key: "pilot", label: "Pilot hole", kind: "boolean", hint: "The hole for the motor's round boss and shaft.", visible: isNema },
    { key: "pilotClearance", label: "Pilot clearance", kind: "number", unit: "mm", min: 0, step: 0.1, hint: "Added to the boss's diameter.", visible: (p) => isNema(p) && !!p.pilot },
    { key: "slots", label: "Slot length", kind: "number", unit: "mm", min: 0, step: 1, hint: "Make the holes slots this long, to slide the motor and tension a belt; 0 for round holes.", visible: isNema },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0, step: 1, hint: "0 cuts through everything." },
    ...cutFields,
  ],

  evaluate(ctx: EvalContext, p: MountPatternParams) {
    const nema = NEMA[p.standard], vesa = VESA[p.standard];
    if (!nema && !vesa) throw ctx.fail("Pick a NEMA or VESA size.");
    const screw = fastenerOf((nema || vesa).screw)!;
    const d = clearanceOf(screw, p.fit), slide = nema ? Math.max(0, Number(p.slots) || 0) : 0;
    const bodies = scoped(ctx, p.targets);
    const tools: Tool[] = [];
    for (const s of spots(ctx, p)) {
      const prefix = prefixAt(ctx, s);
      const depth = p.depth > 0 ? Number(p.depth) : reachPast(ctx.k, bodies.map((b) => b.shape), s.frame.origin);
      const holes = cornerPoints(nema ? nema.square : vesa.x, nema ? nema.square : vesa.y).map((q, i) => extruded(ctx, s.frame, slot(q, slide, d, 0, "wall"), [], -depth, depth, `${prefix}:h${i + 1}`));
      if (nema && p.pilot) holes.push(extruded(ctx, s.frame, slot([0, 0], slide, nema.pilot + Math.max(0, Number(p.pilotClearance) || 0), 0, "wall"), [], -depth, depth, `${prefix}:pilot`));
      tools.push({ ...together(ctx, holes), suffix: s.key });
    }
    apply(ctx, tools, { operation: "remove", targets: p.targets });
  },
});
