// script-part-summary.ts — the part as whoever writes a custom feature needs to know it: each body's size, its
// flat faces by direction and area, its round holes by diameter (script/report.ts partSummary).  What the
// editor's assistant is told before it writes a line.
//
//   await kernel.call("script-part-summary", { before?: "<feature id>" })   → PartSummary
//
// `before` names a feature being previewed (the editor's draft): the summary is of the model just before it.
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { defineService } from "../kernel/service";
import { partSummary } from "../script/report";

export default defineService({
  name: "script-part-summary",
  run(ctx, args) {
    const before = (args as { before?: unknown }).before;
    const state = (typeof before === "string" && ctx.before && ctx.before(before)) || ctx.state;
    return partSummary(ctx.k, state) as unknown as Json;
  },
});
