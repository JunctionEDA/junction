// sm-tab.ts — Tab: add the regions of a sketch drawn on a sheet metal wall's face to that wall (in its plane).
// The regions must touch the wall; whatever hangs from the wall's bends is not changed.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { commit, mframe, minv, mmul, mtrans, placements, xform, type SMModel } from "../kernel/ops/sheetmetal";
import { growWall } from "../kernel/ops/sheetmetal-ops";
import { openModels, SM_SECTION } from "./_sm";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TabParams { [key: string]: any; profile: { sketch: string; regions: string[] | null } | null }

export default defineFeature<TabParams>({
  type: "sm-tab",
  title: "Tab",
  icon: '<path class="f" d="M9 9h6v5H9z"/><path d="M3 14h18v5H3zM9 14V9h6v5"/>',
  hint: "Add sketch regions drawn on a sheet metal wall to the wall",
  keywords: "tab add material sheet metal wall region",
  toolbarSection: SM_SECTION, toolbarOrder: 22, toolbarKeep: 50,
  defaults: () => ({ profile: null }),
  schema: [{ key: "profile", label: "Tab regions", kind: "profile", hint: "Regions of a sketch on a face of a wall." }],

  evaluate(ctx: EvalContext, p: TabParams) {
    if (!p.profile || !p.profile.sketch) throw ctx.fail("Pick the sketch regions to add.");
    const s = ctx.sketch(p.profile.sketch), f = s.frame;
    const regions = s.regions.filter((r) => !p.profile!.regions || p.profile!.regions.includes(r.id));
    if (!regions.length) throw ctx.fail("The sketch has no closed region.");
    const S = mframe(f.origin, f.x, f.y, f.normal);
    const changed = new Map<string, SMModel>();
    for (const r of regions) {
      let placed = false;
      for (const m0 of openModels(ctx)) {
        const m = changed.get(m0.id) || m0, { mat } = placements(m);
        for (const w of m.walls) {
          const L = mmul(minv(mat.get(w.id)!), S);   // the sketch in the wall's coordinates
          const parallel = Math.abs(Math.abs(L[10]) - 1) < 1e-6, z = L[11];
          if (!parallel || !(Math.abs(z) < 1e-4 || Math.abs(z - m.thickness) < 1e-4)) continue;
          const face = xform(ctx.k, r.face, mmul(mtrans(0, 0, -z), minv(mat.get(w.id)!)), ctx.own);
          try { changed.set(m.id, growWall(ctx.k, m, w.id, face, ctx.own, "")); placed = true; break; } catch { /* not this wall */ }
        }
        if (placed) break;
      }
      if (!placed) throw ctx.fail("A tab region does not lie on and touch a wall of a sheet metal part. Sketch it on a wall's face, against the wall.");
    }
    for (const m of changed.values()) commit(ctx, m);
  },
});
