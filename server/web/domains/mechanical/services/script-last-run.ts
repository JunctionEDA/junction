// script-last-run.ts — what a custom feature's script printed and reported the last time it ran in this worker,
// and how it ended (the line of an error): the editor's console.
//
//   await kernel.call("script-last-run", { feature: "<feature id>" })   → LastRun | null   (script/run.ts)
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { defineService } from "../kernel/service";
import { lastRunOf } from "../script/run";

export default defineService({
  name: "script-last-run",
  run: (_ctx, args) => lastRunOf(String((args as { feature?: unknown }).feature ?? "")) as unknown as Json,
});
