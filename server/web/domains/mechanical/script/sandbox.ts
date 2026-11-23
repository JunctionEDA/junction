// sandbox.ts — where a custom feature's script runs: a QuickJS interpreter compiled to WebAssembly, inside the
// modelling worker (or the assistant's node host, or a test).
//
// WHAT THE ISOLATION IS.  The script is never handed to the browser's (or node's) own JavaScript engine: it is
// text given to an interpreter that lives in a WebAssembly memory of its own.  That interpreter has the
// language (objects, arrays, Math, JSON, RegExp, Map…) and nothing else: no fetch, no XMLHttpRequest, no
// WebSocket, no importScripts, no postMessage, no indexedDB, no DOM, no `self`, no `process`, no `require`, no
// module loader, no clock.  The only door out is ONE function, `__host(op, argsJson)`, which takes two strings
// and returns a string; the host (script/host.ts) looks the op up in a fixed table.  No host object, function or
// prototype is ever reachable from inside: values cross as JSON text, and bodies, faces and edges cross as
// names.  So what a script can do is exactly what the table lets it do: read the part studio's model at this
// point of the feature list and change that working copy.  It cannot read another document, the page, cookies
// or the network, and it cannot reach the kernel's raw bindings.
//
// BOUNDS.  The interpreter's memory is capped (64 MB); its stack is capped; an interrupt handler the
// interpreter calls every few thousand operations stops it after a fixed number of calls (a deterministic
// budget: the same script stops at the same place on every machine) or when the wall clock passes the deadline;
// the host refuses further calls after the deadline and counts them.  A fresh interpreter is made for every
// evaluation and thrown away after it, so one run cannot leave anything for the next.
//
// WHAT IT DOES NOT PROTECT AGAINST.  One kernel operation (a boolean on a very heavy shape) cannot be
// interrupted part-way: the limits in host.ts (how many regions, vertices and bodies one call may bring) keep
// each one bounded, but a script can still ask for work that takes its whole time allowance on a slow machine.
// A script can make a wrong or ugly part, or one that fails: that is the feature failing, shown on its row, and
// the model stays as it was.  A bug in QuickJS or in the browser's WebAssembly engine is outside this file.
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { PRELUDE } from "../generated/script-assets";
import WASM_BASE64 from "../generated/script-wasm";
import { DESCRIBE_LIMITS, RUN_LIMITS, type Limits } from "./limits";
import { MAX_SOURCE, readManifest, type ScriptManifest } from "./manifest";

/* eslint-disable @typescript-eslint/no-explicit-any */

export { RUN_LIMITS, DESCRIBE_LIMITS, type Limits } from "./limits";

export type ScriptErrorKind = "syntax" | "fail" | "api" | "throw" | "timeout" | "memory" | "declare";
/** Why a script did not run to its end.  `line` is 1-based, in the script's own text. */
export class ScriptError extends Error {
  constructor(message: string, readonly kind: ScriptErrorKind, readonly line?: number) { super(message); this.name = "ScriptError"; }
}
/** Thrown by a host op for `ctx.fail`-like failures: the message is shown as it is, without "line n". */
export class HostFail extends Error { constructor(m: string) { super(m); this.name = "HostFail"; } }

/** One call from the script.  `mutated` tells the prelude that what it remembered about bodies is stale. */
export type HostCall = (op: string, args: any[]) => { value: unknown; mutated?: boolean };

const FILE = "feature.js";
const TOO_LONG = (ms: number) => `The script took too long and was stopped (the allowance is ${Math.round(ms / 1000)} s of work). Make the pattern coarser, or look for a loop that never ends.`;
const TOO_BIG = "The script used too much memory (more than 64 MB) and was stopped. Build fewer or simpler shapes at once.";

let loading: Promise<QuickJSWASMModule> | null = null;
function quickjs(): Promise<QuickJSWASMModule> {
  if (!loading) {
    const bytes = decode(WASM_BASE64);
    // The package's own loader is chosen by the bundler's conditions and its node build reads files; the
    // browser build is given the bytes instead and works the same in a worker and in node.
    const base: any = {
      type: "sync",
      importFFI: () => import("@jitl/quickjs-wasmfile-release-sync/ffi").then((m: any) => m.QuickJSFFI),
      // @ts-expect-error a file of the package, by path: it has no types of its own
      importModuleLoader: () => import("../../../../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.browser.mjs").then((m: any) => m.default),
    };
    loading = newQuickJSWASMModuleFromVariant(newVariant(base, { wasmLocation: "quickjs.wasm", wasmBinary: bytes.buffer as ArrayBuffer }));
    loading.catch(() => { loading = null; });
  }
  return loading;
}
function decode(b64: string): Uint8Array {
  const g = globalThis as any;
  if (typeof g.atob === "function") { const s = g.atob(b64), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
  return new Uint8Array(g.Buffer.from(b64, "base64"));
}

/**
 * Load the interpreter.  One instance serves every run; if a run ever leaves it in a state it cannot vouch for
 * (the engine under it threw: its own stack ran out, an abort), that instance is dropped and the next call
 * loads a fresh one, so a script cannot break custom features for the scripts that come after it.
 */
export async function loadSandbox(): Promise<Sandbox> {
  if (current && !current.spent) return current;
  if (current) { loading = null; current = null; }
  current = new Sandbox(await quickjs());
  return current;
}
let current: Sandbox | null = null;

interface Vm { rt: QuickJSRuntime; vm: QuickJSContext; hooks: QuickJSHandle; state: { ticks: number; calls: number; deadline: number; stopped: "" | "timeout"; limits: Limits }; dispose(): void }

export class Sandbox {
  /** this instance of the interpreter is not to be used again (loadSandbox makes another) */
  spent = false;
  constructor(private readonly q: QuickJSWASMModule) {}
  /** What to make of something other than a ScriptError coming out of the interpreter: the instance is given up. */
  private gaveWay(e: unknown): ScriptError {
    this.spent = true;
    const text = e instanceof Error ? e.message : String(e);
    if (/call stack|recursion|stack overflow/i.test(text)) return new ScriptError("The script called itself too deeply. Look for a function that calls itself without end.", "throw");
    if (/memory|out of bounds|Aborted/i.test(text)) return new ScriptError(TOO_BIG, "memory");
    return new ScriptError(`The script could not be run: ${text}`, "throw");
  }

  private open(source: string, limits: Limits, host: HostCall): Vm {
    if (typeof source !== "string") throw new ScriptError("The script is not text.", "syntax");
    if (source.length > MAX_SOURCE) throw new ScriptError("The script is longer than 200 000 characters.", "syntax");
    const rt = this.q.newRuntime();
    rt.setMemoryLimit(limits.memory);
    // well under the WebAssembly stack the interpreter itself runs on, so that a script that calls itself for ever
    // meets the interpreter's limit (an error it reports) and not the engine's (which would take the interpreter down)
    rt.setMaxStackSize(192 << 10);
    const state: Vm["state"] = { ticks: 0, calls: 0, deadline: Date.now() + limits.ms, stopped: "", limits };
    rt.setInterruptHandler(() => {
      if (state.stopped) return true;
      if (++state.ticks > limits.ticks || Date.now() > state.deadline) { state.stopped = "timeout"; return true; }
      return false;
    });
    // no Date: a feature must build the same thing every time
    const vm = rt.newContext({ intrinsics: { BaseObjects: true, Date: false, Eval: true, StringNormalize: true, RegExp: true, JSON: true, Proxy: true, MapSet: true, TypedArrays: true, Promise: true } });
    let hooks: QuickJSHandle | null = null;
    const dispose = () => {
      // an instance that gave way is left as it is: freeing a runtime with values still alive aborts the module
      if (this.spent) return;
      try { if (hooks) hooks.dispose(); } catch (e) { /* gone */ }
      try { vm.dispose(); rt.dispose(); } catch (e) { this.spent = true; }
    };
    try {
      const fn = vm.newFunction("__host", (opH, argsH) => {
        let out: string;
        try {
          if (state.stopped || Date.now() > state.deadline) { state.stopped = "timeout"; throw new HostFail(TOO_LONG(limits.ms)); }
          if (++state.calls > limits.calls) throw new HostFail(limits.calls ? `The script made more than ${limits.calls} calls into the Feature API and was stopped. Do the 2D work in fewer, larger Geo2 calls.` : "The Feature API can only be used inside evaluate(ctx, p), not while the script is being read.");
          const r = host(vm.getString(opH), JSON.parse(vm.getString(argsH)));
          out = JSON.stringify({ v: r.value === undefined ? null : r.value, m: r.mutated ? 1 : 0 });
        } catch (e) {
          out = JSON.stringify({ e: e instanceof Error ? e.message : String(e), f: e instanceof HostFail ? 1 : 0 });
        }
        return vm.newString(out);
      });
      vm.setProp(vm.global, "__host", fn);
      fn.dispose();
      this.unwrap(vm, state, vm.evalCode(PRELUDE, "prelude.js")).dispose();
      hooks = vm.getProp(vm.global, "__hooks");
      this.unwrap(vm, state, vm.evalCode("delete globalThis.__hooks", "prelude.js")).dispose();
      this.unwrap(vm, state, vm.evalCode(source, FILE)).dispose();
      return { rt, vm, hooks, state, dispose };
    } catch (e) { const out = e instanceof ScriptError ? e : this.gaveWay(e); dispose(); throw out; }
  }

  /** The value of a call into the interpreter, or the ScriptError that says why there is none. */
  private unwrap(vm: QuickJSContext, state: Vm["state"], r: { value?: QuickJSHandle; error?: QuickJSHandle }): QuickJSHandle {
    if (!r.error) return r.value!;
    let dumped: any;
    try { dumped = vm.dump(r.error); } catch (e) { dumped = { name: "Error", message: "the script failed" }; }
    r.error.dispose();
    if (state.stopped === "timeout") throw new ScriptError(TOO_LONG(state.limits.ms), "timeout");
    const name = dumped && typeof dumped === "object" ? String(dumped.name || "Error") : "Error";
    const message = dumped && typeof dumped === "object" ? String(dumped.message ?? "") : String(dumped);
    const stack = dumped && typeof dumped === "object" ? String(dumped.stack || "") : "";
    const at = /feature\.js:(\d+)/.exec(stack) || (name === "SyntaxError" ? /feature\.js:(\d+)/.exec(message) : null);
    const line = at ? Number(at[1]) : undefined;
    const where = line ? ` (line ${line})` : "";
    if (name === "InternalError" && /out of memory/.test(message)) throw new ScriptError(TOO_BIG, "memory");
    if (name === "InternalError" && /interrupted/.test(message)) throw new ScriptError(TOO_LONG(state.limits.ms), "timeout");
    if (name === "InternalError" && /stack overflow/.test(message)) throw new ScriptError(`The script called itself too deeply${where}. Look for a function that calls itself without end.`, "throw", line);
    if (name === "RangeError" && /stack/i.test(message)) throw new ScriptError(`The script called itself too deeply${where}.`, "throw", line);
    if (name === "FeatureFailure") throw new ScriptError(message || "The feature failed.", "fail", line);
    if (name === "ApiError") throw new ScriptError(`${message}${where}`, "api", line);
    if (name === "SyntaxError") throw new ScriptError(`The script cannot be read: ${message}${where}.`, "syntax", line);
    throw new ScriptError(`The script stopped with ${name}: ${message}${where}.`, "throw", line);
  }

  /** Read what a script declares, without building anything.  Never throws: a script that cannot be read is a problem. */
  describe(source: string): { manifest: ScriptManifest | null; problems: { message: string; line?: number }[] } {
    let v: Vm | null = null;
    try {
      v = this.open(source, DESCRIBE_LIMITS, () => { throw new Error("unreachable"); });
      const fn = v.vm.getProp(v.hooks, "describe");
      let text: string;
      try { const out = this.unwrap(v.vm, v.state, v.vm.callFunction(fn, v.vm.undefined)); text = v.vm.getString(out); out.dispose(); } finally { fn.dispose(); }
      const r = readManifest(JSON.parse(text));
      return { manifest: r.problems.length ? null : r.manifest, problems: r.problems.map((message) => ({ message })) };
    } catch (e) {
      if (!(e instanceof ScriptError)) e = this.gaveWay(e);
      if (e instanceof ScriptError) return { manifest: null, problems: [{ message: e.kind === "timeout" ? "The script takes too long just to be read. Do the work inside evaluate(ctx, p), not at the top of the file." : e.message, line: e.line }] };
      return { manifest: null, problems: [{ message: `The script could not be read: ${e instanceof Error ? e.message : String(e)}` }] };
    } finally { if (v) v.dispose(); }
  }

  /**
   * Run a script's `evaluate`.  `values` is the JSON of its parameter values (picks already as the tagged
   * names the prelude revives).  Throws a ScriptError when the script does not finish.
   */
  run(source: string, feature: { id: string; name: string }, valuesJson: string, host: HostCall, limits: Limits = RUN_LIMITS): { ticks: number; calls: number; ms: number } {
    const t0 = Date.now();
    const v = this.open(source, limits, host);
    try {
      const fn = v.vm.getProp(v.hooks, "run"), a = v.vm.newString(JSON.stringify(feature)), b = v.vm.newString(valuesJson);
      try { this.unwrap(v.vm, v.state, v.vm.callFunction(fn, v.vm.undefined, a, b)).dispose(); } finally { fn.dispose(); a.dispose(); b.dispose(); }
      // a script that swallowed the stop in a try/catch has still run out of time
      if (v.state.stopped === "timeout") throw new ScriptError(TOO_LONG(limits.ms), "timeout");
      return { ticks: v.state.ticks, calls: v.state.calls, ms: Date.now() - t0 };
    } catch (e) { throw e instanceof ScriptError ? e : this.gaveWay(e); }
    finally { v.dispose(); }
  }
}
