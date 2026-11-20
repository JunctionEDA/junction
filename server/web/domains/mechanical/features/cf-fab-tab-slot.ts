// cf-fab-tab-slot.ts — Tab and slot: tabs grown from the edge face of one plate and the slots for them cut in
// the plates the edge stands against.
//
// Pick the narrow edge face of the plate that gets the tabs.  The tabs are as thick as the plate, spaced evenly
// along the edge, and as long as asked (the thickness of the plate they go through).  Every other body in scope
// that a tab reaches gets a slot: the tab's section, opened by the clearance and closed by the kerf.
// Names: `<id>:tab<n>:…` on the tabbed plate, `<id>:slot<n>:…` in the slotted ones.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { box, changeAll, edgeFace, fresh, positive, whole } from "../kernel/ops/cf-fab";
import { allowance, fitFields, LASER, others, pickedFace } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TabSlotParams { [key: string]: any; face: GeomRef | null; count: number; width: number; length: number; clearance: number; kerf: number; targets: string[] }

export default defineFeature<TabSlotParams>({
  type: "cf-fab-tab-slot",
  title: "Tab and slot",
  icon: '<path class="f" d="M3 13h18v7H3z"/><path d="M3 13h18v7H3z"/><path class="f" d="M5 4h14v6h-3v3h-3v-3h-2v3H8v-3H5z"/><path d="M5 4h14v6h-3v3h-3v-3h-2v3H8v-3H5z"/>',
  hint: "Tabs on a plate's edge and matching slots in the plate it meets",
  keywords: "tab slot tabs slots mortise laser cnc plate edge interlock kerf",
  ...LASER, toolbarOrder: 14,
  defaults: () => ({ face: null, count: 2, width: 10, length: 3, clearance: 0, kerf: 0, targets: [] }),
  schema: [
    { key: "face", label: "Edge face", kind: "refs", of: ["face"], single: true, hint: "The narrow face of the plate that gets the tabs, where it meets the other plate." },
    { key: "count", label: "Tabs", kind: "number", unit: "none", min: 1, step: 1 },
    { key: "width", label: "Tab width", kind: "number", unit: "mm", min: 0.1, step: 1 },
    { key: "length", label: "Tab length", kind: "number", unit: "mm", min: 0.1, step: 0.5, hint: "How far a tab stands out: the thickness of the plate it goes through." },
    ...fitFields("Extra room around each tab in its slot."),
    { key: "targets", label: "Plates to slot", kind: "bodies", hint: "Leave empty for every other body a tab reaches." },
  ],

  evaluate(ctx: EvalContext, p: TabSlotParams) {
    const f = pickedFace(ctx, p.face, "the edge face of the plate that gets the tabs");
    const count = whole(ctx, p.count, "number of tabs", 1, 200), width = positive(ctx, p.width, "tab width"), len = positive(ctx, p.length, "tab length");
    const allow = allowance(ctx, p);
    const ef = edgeFace(ctx, f.shape);
    const pitch = ef.long / count;
    if (width + Math.max(0, allow) >= pitch - 1e-6) throw ctx.fail(`${count} tabs of ${width} mm do not fit on an edge ${Math.round(ef.long * 100) / 100} mm long. Use fewer or narrower tabs.`);
    if (ef.short + allow <= 0 || width + allow <= 0) throw ctx.fail("The kerf is larger than the tab.");
    const id = ctx.feature.id;
    const xs = Array.from({ length: count }, (_, i) => -ef.long / 2 + pitch * (i + 0.5));
    const slots = xs.map((x, i) => box(ctx, ef.frame, [x - width / 2 - allow / 2, -ef.short / 2 - allow / 2, 0], [x + width / 2 + allow / 2, ef.short / 2 + allow / 2, len + Math.max(0, allow)], `${id}:slot${i + 1}`));
    for (const body of others(ctx, f.body, p.targets)) changeAll(ctx, body, "cut", slots);
    const tabs = xs.map((x, i) => box(ctx, ef.frame, [x - width / 2, -ef.short / 2, 0], [x + width / 2, ef.short / 2, len], `${id}:tab${i + 1}`));
    changeAll(ctx, fresh(ctx, f.body), "fuse", tabs);
  },
});
