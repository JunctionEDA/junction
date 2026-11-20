// cf-hw-thread-internal.ts — Internal thread: a modelled helical thread in a round hole.  Pick the hole's wall;
// the size is the standard one tapped in a hole of that diameter (its tap drill), or the one you choose, in which
// case the hole is opened up to the thread's minor diameter.  Countersunk at the mouth, and faded out at the
// bottom of a blind hole as a tap leaves it.
//
// Names: `<id>:crest` (at the major diameter), `<id>:root` (at the minor), `<id>:flank`, `<id>:flank-back`,
// `<id>:start`, `<id>:end`.
import { defineFeature } from "../core/feature";
import { HW_SECTION, MENU_THREADS } from "./_cf-hw";
import { evaluateThread, threadParamDefaults, threadSchema, type ThreadParams } from "./_cf-hw-thread";

export default defineFeature<ThreadParams>({
  type: "cf-hw-thread-internal",
  title: "Internal thread",
  icon: '<path class="f" d="M3 4h18v16H3z"/><path d="M3 4h18v16H3z"/><path d="M8.5 4v16M15.5 4v16" class="t"/><path d="M8.5 8.5l7-2M8.5 12.5l7-2M8.5 16.5l7-2"/>',
  hint: "Model a real helical thread in a hole: ISO metric, unified (UNC/UNF) or any pitch",
  keywords: "thread internal tapped hole female nut helical metric iso unc unf tap modelled 3d print",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_THREADS, toolbarOrder: 11, toolbarKeep: 0,
  defaults: threadParamDefaults,
  schema: threadSchema(true),
  evaluate(ctx, p) { evaluateThread(ctx, p, true); },
});
