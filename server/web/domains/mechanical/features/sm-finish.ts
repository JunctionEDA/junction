// sm-finish.ts — Finish sheet metal model: the parts of a sheet metal model become ordinary parts.  Sheet metal
// features after it no longer change them; the flat pattern stays as it was at the finish.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { EXTRA, storeOf } from "../kernel/ops/sheetmetal";
import { openModels, SM_SECTION } from "./_sm";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FinishParams { [key: string]: any; models: string[] }

export default defineFeature<FinishParams>({
  type: "sm-finish",
  title: "Finish sheet metal",
  icon: '<path d="M3 17l6-3h12l-6 3zM3 17V9h12v8"/><path class="t" d="M14 6l2.5 2.5L21 4"/>',
  hint: "Finish a sheet metal model: its parts become ordinary parts",
  keywords: "finish sheet metal model done close",
  toolbarSection: SM_SECTION, toolbarOrder: 90, toolbarKeep: 38,
  defaults: () => ({ models: [] }),
  schema: [{ key: "models", label: "Sheet metal models", kind: "features", types: ["sm-model"], hint: "Leave empty for every open model." }],

  evaluate(ctx: EvalContext, p: FinishParams) {
    const open = openModels(ctx).filter((m) => !p.models || !p.models.length || p.models.includes(m.id));
    if (!open.length) throw ctx.fail("There is no open sheet metal model to finish.");
    const store = { ...storeOf(ctx) };
    for (const m of open) store[m.id] = { ...m, finished: true };
    ctx.setExtra(EXTRA, store);
  },
});
