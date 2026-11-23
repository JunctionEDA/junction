// script-run.ts — try a custom feature's script on the part studio without touching what the page shows: the
// feature list it is given (the studio's, with the candidate laid in) is built by an engine of this service's
// own, and the answer is the report of script/report.ts: errors with their line, warnings, the console, volume
// before and after, whether the result is a sound solid, and a picture.
//
//   await kernel.call("script-run", { features, feature: "<id of the script feature in that list>",
//                                     image?: { view?, width? } | false, density? })   → RunReport
//   await kernel.call("script-run", { dispose: true })     let go of the engine's cache (the editor closed)
//
// The engine is kept between calls, so trying again after an edit re-runs only the script.
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { RegenEngine } from "../kernel/regen";
import { defineService } from "../kernel/service";
import type { FeatureInput } from "../kernel/protocol";
import { FEATURES } from "../generated/worker";
import { runReport, type RunOptions } from "../script/report";

let scratch: RegenEngine | null = null;

export default defineService({
  name: "script-run",
  async run(ctx, args) {
    const a = args as unknown as { features?: FeatureInput[]; feature?: string; dispose?: boolean } & RunOptions;
    if (a.dispose) { if (scratch) scratch.dispose(); scratch = null; return { disposed: true }; }
    if (!Array.isArray(a.features) || typeof a.feature !== "string") throw ctx.fail("script-run needs the feature list and the feature to run.");
    if (!scratch || scratch.k !== ctx.k) scratch = new RegenEngine(ctx.k, FEATURES);
    // the engine sets the kernel's scope per feature; the worker's own scope for this call is put back after
    const outer = ctx.k.scope;
    try { return (await runReport(ctx.k, scratch, a.features, a.feature, { image: a.image, density: a.density })) as unknown as Json; }
    finally { ctx.k.scope = outer; }
  },
});
