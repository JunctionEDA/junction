// cf-fab-screw-boss.ts — Screw boss: a boss for a thread-forming (self-tapping) screw in plastic.
//
// A boss stands at every point of the sketch.  Its proportions follow the usual rules for thread-forming
// screws in thermoplastics, by the screw's thread diameter d and the plastic: the pilot hole is 0.70–0.85 d,
// the boss 1.85–2.5 d across, the hole at least 2 d deep, with a relief at the mouth (d + 0.2 across, 0.3 d
// deep) that keeps the first thread from splitting the boss.  The outside can be drafted, and gussets tie the
// boss to the floor.  Diameter and hole can be given outright with Custom.
// Names: `<id>:<point>:side`, `:top`, `:relief`, `:relief-floor`, `:pilot`, `:pilot-floor`, `:base`,
// `<id>:<point>:g<n>:…` (gussets).
import { defineFeature } from "../core/feature";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import type { Tool } from "../kernel/ops/combine";
import { at, frameAt, moved, polyPrism, positive, revolve, shape, sketchPoints } from "../kernel/ops/cf-fab";
import { finish, PRINT, resultFields } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Thread-forming screw sizes: nominal thread diameter in mm. */
export const BOSS_SCREWS: { [size: string]: number } = { "2.2": 2.2, "2.5": 2.5, "2.9": 2.9, "3": 3, "3.5": 3.5, "4": 4, "4.2": 4.2, "4.8": 4.8, "5": 5, "6": 6 };
/** Plastic → [pilot hole ÷ d, boss diameter ÷ d]. */
export const BOSS_PLASTICS: { [id: string]: { label: string; hole: number; boss: number } } = {
  abs: { label: "ABS, ASA, PETG", hole: 0.8, boss: 2.0 },
  pla: { label: "PLA", hole: 0.85, boss: 2.2 },
  pc: { label: "PC", hole: 0.85, boss: 2.5 },
  pa: { label: "Nylon", hole: 0.75, boss: 1.85 },
  pp: { label: "PP, PE", hole: 0.7, boss: 2.0 },
};

export interface ScrewBossParams { [key: string]: any; points: { sketch: string; regions: string[] | null } | null; screw: string; plastic: string; bossDiameter: number; holeDiameter: number; height: number; holeDepth: number; draft: number; gussets: number; gussetThickness: number; gussetReach: number; flip: boolean; operation: "new" | "add"; targets: string[] }

const custom = (p: { [k: string]: any }) => p.screw === "custom";

export default defineFeature<ScrewBossParams>({
  type: "cf-fab-screw-boss",
  title: "Screw boss",
  icon: '<path class="f" d="M8 20V7h8v13z"/><path d="M2 20h20M8 20V7h8v13M4 20l4-6M20 20l-4-6"/><path class="s" d="M10.8 7h2.4v8h-2.4z"/><ellipse class="t" cx="12" cy="7" rx="4" ry="1.3"/>',
  hint: "A boss for a self-tapping screw in plastic, proportioned by screw size and material, with gussets",
  keywords: "screw boss self tapping thread forming boss plastic 3d print gusset pilot hole mounting post standoff",
  ...PRINT, toolbarOrder: 22,
  defaults: () => ({ points: null, screw: "3", plastic: "abs", bossDiameter: 6, holeDiameter: 2.4, height: 10, holeDepth: 0, draft: 0, gussets: 0, gussetThickness: 1.2, gussetReach: 4, flip: false, operation: "add", targets: [] }),
  schema: [
    { key: "points", label: "Sketch with points", kind: "profile", hint: "A boss stands at each loose point and at the centre of each circle." },
    { key: "screw", label: "Screw", kind: "enum", options: [{ value: "custom", label: "Custom" }, ...Object.keys(BOSS_SCREWS).map((s) => ({ value: s, label: `${s} mm` }))] },
    { key: "plastic", label: "Plastic", kind: "enum", options: Object.entries(BOSS_PLASTICS).map(([value, v]) => ({ value, label: v.label })), visible: (p) => !custom(p) },
    { key: "bossDiameter", label: "Boss diameter", kind: "number", unit: "mm", min: 0.5, step: 0.5, visible: custom },
    { key: "holeDiameter", label: "Hole diameter", kind: "number", unit: "mm", min: 0.1, step: 0.1, visible: custom },
    { key: "height", label: "Height", kind: "number", unit: "mm", min: 0.5, step: 1 },
    { key: "holeDepth", label: "Hole depth", kind: "number", unit: "mm", min: 0, step: 1, hint: "0 makes it twice the screw's diameter and a little, or as deep as the boss allows." },
    { key: "draft", label: "Draft", kind: "number", unit: "deg", min: 0, max: 10, step: 0.5, hint: "The boss is its nominal diameter at the top and wider toward the foot." },
    { key: "gussets", label: "Gussets", kind: "number", unit: "none", min: 0, max: 8, step: 1 },
    { key: "gussetThickness", label: "Gusset thickness", kind: "number", unit: "mm", min: 0.2, step: 0.2, visible: (p) => Number(p.gussets) > 0 },
    { key: "gussetReach", label: "Gusset reach", kind: "number", unit: "mm", min: 0.5, step: 0.5, hint: "How far a gusset's foot runs out from the boss.", visible: (p) => Number(p.gussets) > 0 },
    { key: "flip", label: "Opposite side", kind: "boolean" },
    ...resultFields,
  ],

  evaluate(ctx: EvalContext, p: ScrewBossParams) {
    const h = positive(ctx, p.height, "height");
    let d: number, Ro: number, rp: number;
    if (custom(p)) { Ro = positive(ctx, p.bossDiameter, "boss diameter") / 2; rp = positive(ctx, p.holeDiameter, "hole diameter") / 2; d = (rp * 2) / 0.8; }
    else {
      d = BOSS_SCREWS[p.screw];
      const pl = BOSS_PLASTICS[p.plastic] || BOSS_PLASTICS.abs;
      if (!d) throw ctx.fail(`There is no screw size ${p.screw}. Pick one of the list, or Custom.`);
      Ro = (d * pl.boss) / 2; rp = (d * pl.hole) / 2;
    }
    const rr = (d + 0.2) / 2, dr = Math.min(0.3 * d, h / 4);   // the relief at the mouth
    if (rr >= Ro - 0.3) throw ctx.fail("The hole leaves no wall on the boss. Make the boss wider or the hole smaller.");
    const draft = Math.max(0, Number(p.draft) || 0);
    if (draft > 10) throw ctx.fail("The draft must be at most 10°.");
    const Rb = Ro + h * Math.tan((draft * Math.PI) / 180);
    let hd = Number(p.holeDepth) > 0 ? Number(p.holeDepth) : Math.min(2 * d + 0.5 * d + dr, h);
    if (hd > h + 1e-9) throw ctx.fail("The hole is deeper than the boss is tall.");
    if (hd <= dr + 0.2) hd = dr + 0.2;
    const n = Math.round(Number(p.gussets) || 0);
    if (n < 0 || n > 8) throw ctx.fail("A boss takes up to 8 gussets.");
    const { frame, points } = sketchPoints(ctx, p.points, "bosses");
    const base = p.flip ? frameAt(frame.origin, frame.x, [-frame.normal[0], -frame.normal[1], -frame.normal[2]]) : frame;
    const id = ctx.feature.id;
    const tools: Tool[] = points.map((pt) => {
      const f = moved(base, pt.at[0], p.flip ? -pt.at[1] : pt.at[1]);
      const key = `${id}:${pt.id}`;
      const through = hd >= h - 1e-9;
      let made: NamedResult = through
        ? revolve(ctx, f, [[rp, 0], [Rb, 0], [Ro, h], [rr, h], [rr, h - dr], [rp, h - dr]], ["base", "side", "top", "relief", "relief-floor", "pilot"], key)
        : revolve(ctx, f, [[0, 0], [Rb, 0], [Ro, h], [rr, h], [rr, h - dr], [rp, h - dr], [rp, h - hd], [0, h - hd]], ["base", "side", "top", "relief", "relief-floor", "pilot", "pilot-floor", null], key);
      if (n > 0) {
        const gt = positive(ctx, p.gussetThickness, "gusset thickness"), reach = positive(ctx, p.gussetReach, "gusset reach");
        const ri = (rr + Ro) / 2, top = h * 0.75;   // a gusset starts inside the wall and ends below the top
        if (gt > 2 * ri) throw ctx.fail("The gussets are thicker than the boss.");
        const ribs = Array.from({ length: n }, (_, i) => {
          const g0 = moved(f, 0, 0, 0, (360 * i) / n);
          // drawn in the plane of (outward, up), swept across the gusset's thickness
          const g = frameAt(at(g0, 0, gt / 2, 0), g0.x, [-g0.y[0], -g0.y[1], -g0.y[2]]);
          return polyPrism(ctx, g, [[ri, 0], [Rb + reach, 0], [ri, top]], 0, gt, `${key}:g${i + 1}`, ["base", "slope", "inner"]);
        });
        made = shape(ctx, "fuse", made, ribs);
      }
      return { ...made, suffix: pt.id };
    });
    finish(ctx, tools, p);
  },
});
