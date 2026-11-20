// sm-flat-pattern.ts — the flat pattern of every sheet metal model as the last regeneration left it: each
// connected piece laid flat (outline and holes, bend lines, forms), its bend table, and the DXF a person
// downloads (kernel/ops/sheetmetal-ops.ts `flatPattern`, `flatDxf`).
//
//   const r = await kernel.call("sm-flat-pattern", { dxf?: true, scale?: 1, insunits?: 4 })
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { defineService } from "../kernel/service";
import { EXTRA, type SMStore } from "../kernel/ops/sheetmetal";
import { flatDxf, flatPattern } from "../kernel/ops/sheetmetal-ops";

export default defineService({
  name: "sm-flat-pattern",
  run(ctx, raw) {
    const a = (raw || {}) as { dxf?: boolean; scale?: number; insunits?: number };
    const store = (ctx.state.extras?.[EXTRA] || {}) as SMStore;
    const keep = <T>(x: T): T => x;
    const models = Object.values(store).map((m) => {
      const pieces = flatPattern(ctx.k, m, keep).map((p) => ({
        ...p, name: Object.keys(m.roots).length > 1 ? `${m.name} (${p.root})` : m.name,
        dxf: a.dxf ? flatDxf(p, m.name, a.scale || 1, a.insunits || 4) : undefined,
      }));
      return { id: m.id, name: m.name, thickness: m.thickness, radius: m.radius, k: m.k, finished: m.finished, pieces };
    });
    return { models } as unknown as Json;
  },
});
