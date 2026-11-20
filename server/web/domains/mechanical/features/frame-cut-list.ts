// frame-cut-list.ts — Cut list: a table of the frames' members (and gussets and end caps) grouped by profile,
// length and end angles, with how many of each.  The table is in the Cut list panel, which exports it as CSV.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { frameStore } from "../kernel/ops/frame";
import { FRAME_SECTION } from "./_frame";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CutListParams { [key: string]: any; frames: string[] }
export interface CutListTable { feature: string; name: string; bodies: string[] }
export const CUTLIST_EXTRA = "cutlist";

export default defineFeature<CutListParams>({
  type: "frame-cut-list",
  title: "Cut list",
  icon: '<path d="M4 4h16v16H4zM4 9h16M4 14h16M10 4v16"/>',
  hint: "Make a cut list of frame members: lengths, end angles and counts",
  keywords: "cut list bom bill of materials frame members lengths csv",
  toolbarSection: FRAME_SECTION, toolbarOrder: 40, toolbarKeep: 42,
  defaults: () => ({ frames: [] }),
  schema: [{ key: "frames", label: "Frames", kind: "features", types: ["frame", "frame-gusset", "frame-end-cap"], hint: "Leave empty for every frame." }],

  evaluate(ctx: EvalContext, p: CutListParams) {
    const store = frameStore(ctx);
    const items = Object.values(store).filter((it) => ctx.body(it.body) && (!p.frames || !p.frames.length || p.frames.includes(it.feature)));
    if (!items.length) throw ctx.fail("There are no frame members to list. Make a Frame first.");
    const tables = { ...(ctx.extra<{ [id: string]: CutListTable }>(CUTLIST_EXTRA) || {}) };
    tables[ctx.feature.id] = { feature: ctx.feature.id, name: ctx.feature.name, bodies: items.map((it) => it.body) };
    ctx.setExtra(CUTLIST_EXTRA, tables);
  },
});
