// load.ts — fetching and starting OpenCascade.  Kept apart from occ.ts so that code which is handed a kernel
// (the regeneration engine, features, tests) does not pull the loader into its bundle.
import { Kernel } from "./occ";

/** Load the kernel.  `source` is the .wasm bytes (node, tests) or its URL (the worker). */
export async function loadKernel(source: { wasmBinary: ArrayBuffer | Uint8Array } | { wasmUrl: string }): Promise<Kernel> {
  const init = (await import("replicad-opencascadejs")).default;
  const oc = await init("wasmUrl" in source ? { locateFile: () => source.wasmUrl } : { wasmBinary: source.wasmBinary });
  return new Kernel(oc);
}

