// script.ts — a custom feature: a feature whose `evaluate` is a script the project carries (script/).
//
// There is no "script" button: each script of the project's library is a feature type of its own on the page
// (`script:<id>.<hash>`, script/manifest.ts `definitionOf`), with the dialog its script declares.  In the worker
// every one of them is built here (kernel/regen.ts hands a `script:…` type to this definition), from the source
// the feature carries in `params.$script`, inside the sandbox (script/sandbox.ts).
import { defineFeature } from "../core/feature";
import { runScriptFeature } from "../script/run";

export default defineFeature({
  type: "script",
  title: "Custom feature",
  toolbar: false,
  defaults: () => ({}),
  schema: [],
  evaluate: (ctx, params) => runScriptFeature(ctx, params),
});
