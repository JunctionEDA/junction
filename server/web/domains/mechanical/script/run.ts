// run.ts — building a feature from its script: the worker's side of every `script:…` feature
// (features/script.ts calls `runScriptFeature`).
//
// The feature carries its script (`params.$script`: the source and the manifest worked out when it was saved).
// The manifest in the document is never trusted here: the source is read again in the sandbox, the parameter
// values are checked against what it declares, the picks are resolved to names, and `evaluate` runs with the
// host's table of operations (script/host.ts).  A script that throws, loops or misuses the API ends as a
// FeatureError with a sentence and, where there is one, the line; the engine then leaves the model as it was.
//
// What the script printed, reported and how it ended is kept here per feature for the editor and the assistant
// (services/script-last-run.ts): the last time it really ran, since a cached feature does not run again.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import { isGeomRef } from "../core/geometry";
import { profileSketch } from "../features/_profile";
import { FeatureError, type EvalContext } from "../kernel/types";
import { emptyDiagnostics, makeHost, type RunDiagnostics } from "./host";
import { SCRIPT_KEY, sourceHash, type ManifestParam, type ScriptManifest } from "./manifest";
import { ScriptError, loadSandbox, type Limits, type Sandbox, type ScriptErrorKind } from "./sandbox";

export interface LastRun extends RunDiagnostics {
  hash: string;
  ok: boolean;
  error?: { message: string; line?: number; kind: ScriptErrorKind | "params" };
  ms: number;
  /** how much of the script's allowance it used: interpreter ticks and API calls */
  ticks: number; calls: number;
}

const lastRuns = new Map<string, LastRun>();
/** What a feature's script said the last time it ran (null: it has not run in this worker). */
export function lastRunOf(featureId: string): LastRun | null { return lastRuns.get(featureId) || null; }
function remember(featureId: string, run: LastRun): void {
  lastRuns.delete(featureId);
  lastRuns.set(featureId, run);
  if (lastRuns.size > 200) lastRuns.delete(lastRuns.keys().next().value as string);
}

let sandbox: Promise<Sandbox> | null = null;
export function sandboxOnce(): Promise<Sandbox> {
  if (!sandbox) { sandbox = loadSandbox(); sandbox.catch(() => { sandbox = null; }); }
  return sandbox;
}

/** Manifests by source hash: reading a script's declaration again for every rebuild would cost a few milliseconds each. */
const described = new Map<string, ReturnType<Sandbox["describe"]>>();
export function describeCached(sb: Sandbox, source: string): ReturnType<Sandbox["describe"]> {
  const key = sourceHash(source) + ":" + source.length;
  let d = described.get(key);
  if (!d) { d = sb.describe(source); described.set(key, d); if (described.size > 100) described.delete(described.keys().next().value as string); }
  return d;
}

class ParamError extends Error {}

/** The values `evaluate` gets, as the JSON the prelude revives: numbers checked, picks resolved to names. */
export function valuesFor(ctx: EvalContext, manifest: ScriptManifest, params: JsonObject): { [key: string]: unknown } {
  const out: { [key: string]: unknown } = {};
  const one = (p: ManifestParam): unknown => {
    const v = params[p.key];
    switch (p.type) {
      case "length": case "angle": case "number": case "integer": {
        let n = typeof v === "number" && Number.isFinite(v) ? v : (p.default as number);
        if (p.type === "integer") n = Math.round(n);
        const unit = p.type === "length" ? " mm" : p.type === "angle" ? "°" : "";
        if (p.min !== undefined && n < p.min - 1e-9) throw new ParamError(`${p.label} must be at least ${p.min}${unit}.`);
        if (p.max !== undefined && n > p.max + 1e-9) throw new ParamError(`${p.label} must be at most ${p.max}${unit}.`);
        return n;
      }
      case "boolean": return typeof v === "boolean" ? v : p.default === true;
      case "text": return typeof v === "string" ? v.slice(0, 400) : String(p.default ?? "");
      case "enum": return (p.options || []).some((o) => o.value === v) ? v : p.default;
      case "face": case "edge": {
        const kind = p.type;
        const ref = Array.isArray(v) ? v[0] : v;
        if (!isGeomRef(ref) || ref.kind !== kind) return null;
        const r = ctx.resolve(ref);
        return kind === "face" ? { $f: [r.body.id, r.name] } : { $e: [r.body.id, r.name] };
      }
      case "faces": case "edges": {
        const kind = p.type === "faces" ? "face" : "edge";
        return (Array.isArray(v) ? v : v ? [v] : []).filter((x) => isGeomRef(x) && x.kind === kind).map((x) => { const r = ctx.resolve(x as never); return kind === "face" ? { $f: [r.body.id, r.name] } : { $e: [r.body.id, r.name] }; });
      }
      case "body": case "bodies": {
        const ids = (Array.isArray(v) ? v : v ? [v] : []).filter((x): x is string => typeof x === "string");
        const found = ids.map((id) => { const b = ctx.body(id); if (!b) throw new ParamError(`A part ${p.label} refers to no longer exists. Edit the feature and pick it again.`); return { $b: b.id }; });
        return p.type === "body" ? found[0] || null : found;
      }
      case "sketch": {
        const id = profileSketch(v);
        if (!id) return null;
        const sk = ctx.sketch(id);
        const chosen = v && typeof v === "object" && Array.isArray((v as { regions?: unknown }).regions) ? ((v as { regions: string[] }).regions) : null;
        const regions = sk.regions.filter((r) => !chosen || chosen.includes(r.id)).map((r) => ({ outer: r.region.outer.polygon, holes: r.region.holes.map((h) => h.polygon.slice().reverse()) }));
        return { plane: { origin: sk.frame.origin, x: sk.frame.x, y: sk.frame.y, normal: sk.frame.normal }, regions };
      }
    }
  };
  for (const p of manifest.params) out[p.key] = one(p);
  return out;
}

/** Build a `script:…` feature.  Throws a FeatureError that says what went wrong, with the script's line when it has one. */
export async function runScriptFeature(ctx: EvalContext, params: JsonObject, limits?: Limits): Promise<void> {
  const ref = params[SCRIPT_KEY] as { source?: unknown; name?: unknown } | undefined;
  const source = ref && typeof ref.source === "string" ? ref.source : null;
  if (source === null) throw new FeatureError("This custom feature has lost its script. Delete it and add it again from the project's custom features.");
  let sb: Sandbox;
  try { sb = await sandboxOnce(); } catch (e) { throw new FeatureError(`Custom features cannot run here: the script interpreter did not start (${e instanceof Error ? e.message : String(e)}).`); }
  const hash = sourceHash(source), diag = emptyDiagnostics(), t0 = Date.now();
  const fail = (message: string, kind: ScriptErrorKind | "params", line?: number): FeatureError => {
    remember(ctx.feature.id, { ...diag, hash, ok: false, error: { message, line, kind }, ms: Date.now() - t0, ticks: 0, calls: 0 });
    return new FeatureError(message);
  };
  const d = describeCached(sb, source);
  if (!d.manifest) throw fail(d.problems[0]?.message || "The script does not declare a feature.", "declare", d.problems[0]?.line);
  let values: { [key: string]: unknown };
  try { values = valuesFor(ctx, d.manifest, params); } catch (e) {
    if (e instanceof ParamError || e instanceof FeatureError) throw fail(e.message, "params");
    throw e;
  }
  const host = makeHost(ctx, values, diag);
  try {
    const used = sb.run(source, { id: ctx.feature.id, name: ctx.feature.name }, JSON.stringify(values), host.call, limits);
    host.finish();
    if (diag.reports.length) ctx.info(diag.reports.map((r) => `${r.label}: ${r.value}`).join(" · "));
    remember(ctx.feature.id, { ...diag, hash, ok: true, ms: Date.now() - t0, ticks: used.ticks, calls: used.calls });
  } catch (e) {
    if (e instanceof ScriptError) throw fail(e.message, e.kind, e.line);
    throw fail(`The script could not be run: ${e instanceof Error ? e.message : String(e)}`, "throw");
  }
}
