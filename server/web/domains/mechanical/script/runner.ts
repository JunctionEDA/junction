// runner.ts — how features/script.ts reaches the code that runs a script.  A feature file is bundled into the page
// too (for its id and schema), and the page must not carry the interpreter (half a megabyte of WebAssembly) it
// never uses.  So the feature asks here, and the worker's side (services/script-describe.ts, which only the
// worker, the assistant's host and the tests bundle) puts the runner in as it loads.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { EvalContext } from "../kernel/types";

export type ScriptRunner = (ctx: EvalContext, params: JsonObject) => Promise<void>;
let runner: ScriptRunner | null = null;
export function setScriptRunner(fn: ScriptRunner): void { runner = fn; }
export function scriptRunner(): ScriptRunner | null { return runner; }
