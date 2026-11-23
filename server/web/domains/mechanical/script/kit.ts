// kit.ts — everything of custom features that runs beside a kernel, in one module: what the assistant's host and
// the node tests bundle (the worker gets the same pieces through features/script.ts and services/script-*.ts).
export * from "../kernel/index";
export * as Geo2 from "./geom2d";
export * from "./manifest";
export { ScriptError, RUN_LIMITS, DESCRIBE_LIMITS, loadSandbox, type Limits, type Sandbox } from "./sandbox";
export { describeCached, lastRunOf, runScriptFeature, sandboxOnce, type LastRun } from "./run";
export { partSummary, reportText, runReport, type PartSummary, type RunReport } from "./report";
export { API_DTS, EXEMPLARS, PROMPTS } from "../generated/script-assets";
