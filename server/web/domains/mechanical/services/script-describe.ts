// script-describe.ts — read what a custom feature's script declares (its title, icon and parameters) without
// building anything: what the editor asks on every pause in typing, and what Save stores beside the source.
//
//   await kernel.call("script-describe", { source })
//   → { manifest | null, problems: [{ message, line? }], hash }
import type { Json } from "../../../shared/itemdoc/itemdoc";
import { defineService } from "../kernel/service";
import { sourceHash } from "../script/manifest";
import { describeCached, sandboxOnce } from "../script/run";

export default defineService({
  name: "script-describe",
  async run(_ctx, args) {
    const source = String((args as { source?: unknown }).source ?? "");
    const d = describeCached(await sandboxOnce(), source);
    return { manifest: d.manifest, problems: d.problems, hash: sourceHash(source) } as unknown as Json;
  },
});
