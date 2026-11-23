// script.ts — a custom feature: a feature whose `evaluate` is a script the project carries (script/).
//
// There is no "script" button: each script of the project's library is a feature type of its own on the page
// (`script:<id>.<hash>`, script/manifest.ts `definitionOf`), with the dialog its script declares.  In the worker
// every one of them is built here (kernel/regen.ts hands a `script:…` type to this definition), from the source
// the feature carries in `params.$script`, inside the sandbox (script/sandbox.ts), which it reaches through
// script/runner.ts so that the page's copy of this file does not bring the interpreter with it.
import { defineFeature } from "../core/feature";
import { scriptRunner } from "../script/runner";

export default defineFeature({
  type: "script",
  title: "Custom feature",
  toolbar: false,
  defaults: () => ({}),
  schema: [],
  evaluate(ctx, params) {
    const run = scriptRunner();
    if (!run) throw ctx.fail("Custom features cannot be built here: this build of Junction has no script interpreter.");
    return run(ctx, params);
  },
});
