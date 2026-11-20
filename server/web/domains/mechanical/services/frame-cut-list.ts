// frame-cut-list.ts — the cut lists of the part studio as the last regeneration left them: one table per Cut
// list feature, or, with none, one of every frame part (kernel/ops/cutlist.ts).
//
//   const r = await kernel.call("frame-cut-list", { csv?: true })   → { tables: [{ name, rows, csv? }] }
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { defineService } from "../kernel/service";
import { FRAME_EXTRA, type FrameStore } from "../kernel/ops/frame";
import { cutCsv, cutRows } from "../kernel/ops/cutlist";
import { CUTLIST_EXTRA, type CutListTable } from "../features/frame-cut-list";

export default defineService({
  name: "frame-cut-list",
  run(ctx, raw) {
    const a = (raw || {}) as { csv?: boolean };
    const store = (ctx.state.extras?.[FRAME_EXTRA] || {}) as FrameStore;
    const lists = Object.values((ctx.state.extras?.[CUTLIST_EXTRA] || {}) as { [id: string]: CutListTable });
    const live = new Map(ctx.state.bodies.map((b) => [b.id, b.name]));
    const nameOf = (id: string) => live.get(id) || id;
    const tables = (lists.length ? lists : [{ feature: "", name: "All frame parts", bodies: Object.keys(store) }]).map((t) => {
      const rows = cutRows(t.bodies.filter((b) => store[b] && live.has(b)).map((b) => store[b]), nameOf);
      return { feature: t.feature, name: t.name, rows, csv: a.csv ? cutCsv(rows) : undefined };
    }).filter((t) => t.rows.length || t.feature);
    return { tables } as unknown as Json;
  },
});
