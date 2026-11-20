// cf-hw-thread.ts — Thread: a modelled helical thread on a shaft.  Pick the round face; the size is the standard
// one of that diameter (ISO metric coarse or fine, unified coarse or fine) or any pitch you type.  The flanks are
// true helicoids with the standard's 60° profile (kernel/ops/cf-hw-thread.ts), the start is chamfered and the
// far end fades out against a shoulder.
//
// Names: `<id>:crest`, `<id>:root`, `<id>:flank`, `<id>:flank-back` (numbered along the thread), `<id>:start`,
// `<id>:end`.  The rest of the body keeps its names.
import { defineFeature } from "../core/feature";
import { HW_SECTION, MENU_THREADS } from "./_cf-hw";
import { evaluateThread, threadParamDefaults, threadSchema, type ThreadParams } from "./_cf-hw-thread";

export default defineFeature<ThreadParams>({
  type: "cf-hw-thread",
  title: "Thread",
  icon: '<path class="f" d="M8 3h8v18H8z"/><path d="M8 3h8M8 21h8M8 3v18M16 3v18"/><path d="M8 8l8-2.5M8 12l8-2.5M8 16l8-2.5M8 20l8-2.5"/>',
  hint: "Model a real helical thread on a shaft: ISO metric, unified (UNC/UNF) or any pitch",
  keywords: "thread creator external screw helical metric iso unc unf bolt male threaded rod modelled 3d print",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_THREADS, toolbarOrder: 10, toolbarKeep: 0,
  defaults: threadParamDefaults,
  schema: threadSchema(false),
  evaluate(ctx, p) { evaluateThread(ctx, p, false); },
});
