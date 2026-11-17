// interference-sources.ts — where the interference check and the bill of materials get the parts of an
// assembly from: each part studio an instance names is opened (its live document, through ItemDocSession),
// rebuilt in a modelling worker of its own (one KernelClient per part studio, as CONTRACT.md "The assembly"
// says), and asked for its bodies as BRep text ("body-brep").  The first of those workers also does the checking.
//
// This is the thin page side; the logic is in interference.ts and bom.ts.  When the assembly editor draws its
// instances it will hold these same sessions and clients; this class can then take them from it.
import { ItemDocSession } from "../../../shared/itemdoc/sync";
import type { ItemDoc } from "../../../shared/itemdoc/itemdoc";
import { KernelClient, PART_STUDIO_KIND, featureInputs, featuresOf, materialOf, rollbackIndex } from "../../mechanical/api";
import { transformOf, type InstanceItem } from "../document/format";
import { textHash, type Box, type InstanceShape } from "./interference";

interface BodyInfo { id: string; name: string; brep: string; bbox: Box; key: string; material?: string }
interface Source { doc: ItemDoc; kernel: KernelClient; bodies: Map<string, BodyInfo> }

/** Open a JSON item document once and close the session: its state now, edits since the last snapshot included. */
export function readItemDoc(docId: string, signedIn: boolean, expectKind: string, ms = 30000): Promise<ItemDoc> {
  return new Promise((resolve, reject) => {
    let done = false;
    const s: ItemDocSession = new ItemDocSession({
      docId, signedIn, expectKind,
      onChange: () => { if (done || !s.doc) return; done = true; const doc = s.doc; s.close(); resolve(doc); },
      onStatus: (st) => { if (!done && st.state === "error") { done = true; s.close(); reject(new Error(st.text || "The document could not be opened.")); } },
    });
    s.start();
    setTimeout(() => { if (!done) { done = true; s.close(); reject(new Error("The document took too long to open.")); } }, ms);
  });
}

export class PartSources {
  private readonly sources = new Map<string, Source>();
  /** the worker that checks, where shapes from every part studio meet: the first part studio's own (a second
   *  kernel would cost another start of the 23 MB module), or one of its own when there is none */
  private own: KernelClient | null = null;
  private get checker(): KernelClient {
    const first = this.sources.values().next();
    if (!first.done) return first.value.kernel;
    if (!this.own) this.own = new KernelClient();
    return this.own;
  }

  constructor(private readonly signedIn: boolean) {}

  /** Open and rebuild a part studio (again, so edits made since are followed) and read its bodies. */
  async load(docId: string): Promise<Source> {
    const doc = await readItemDoc(docId, this.signedIn, PART_STUDIO_KIND);
    let src = this.sources.get(docId);
    if (!src) { src = { doc, kernel: new KernelClient(), bodies: new Map() }; this.sources.set(docId, src); }
    src.doc = doc;
    const features = featuresOf(doc);
    const result = await src.kernel.regenerate(featureInputs(features), rollbackIndex(doc, features));
    if (!result) throw new Error("The part studio was rebuilt again before it finished.");
    const failed = result.features.filter((f) => f.status === "error").length;
    if (failed && !result.bodies.length) throw new Error("The part studio's features failed to build.");
    const r = await src.kernel.call("body-brep", { bodies: null }) as unknown as { bodies: { id: string; name: string; brep: string; bbox: Box }[] };
    src.bodies = new Map(r.bodies.map((b) => [b.id, { ...b, key: `${docId}:${b.id}:${textHash(b.brep)}`, material: materialOf(doc, b.id)?.name }]));
    return src;
  }

  /** The solids of the unsuppressed part instances, placed.  Instances whose source is gone are listed apart. */
  async shapes(instances: readonly InstanceItem[]): Promise<{ shapes: InstanceShape[]; skipped: { instance: string; why: string }[] }> {
    const parts = instances.filter((i) => !i.suppressed && i.source.kind === "part");
    const docIds = Array.from(new Set(parts.map((i) => i.source.docId)));
    const loaded = new Map<string, Source | Error>();
    await Promise.all(docIds.map(async (d) => { try { loaded.set(d, await this.load(d)); } catch (e) { loaded.set(d, e instanceof Error ? e : new Error(String(e))); } }));
    const shapes: InstanceShape[] = [], skipped: { instance: string; why: string }[] = [];
    for (const i of instances) {
      if (i.suppressed) continue;
      if (i.source.kind !== "part") { skipped.push({ instance: i.id, why: i.source.kind === "board" ? "Boards are not checked yet." : "Only part studio bodies are checked." }); continue; }
      const src = loaded.get(i.source.docId);
      if (!src || src instanceof Error) { skipped.push({ instance: i.id, why: src ? src.message : "Not loaded." }); continue; }
      const b = src.bodies.get((i.source as { body: string }).body);
      if (!b) { skipped.push({ instance: i.id, why: "Its body is no longer in the part studio." }); continue; }
      shapes.push({ instance: i.id, key: b.key, brep: b.brep, bbox: b.bbox, transform: transformOf(i) });
    }
    return { shapes, skipped };
  }

  /** What each body of the part studios these instances use is called and made of (for the bill of materials). */
  async bodyNames(instances: readonly InstanceItem[]): Promise<{ [docId: string]: { [bodyId: string]: { name: string; material?: string } } }> {
    const out: { [docId: string]: { [bodyId: string]: { name: string; material?: string } } } = {};
    const docIds = Array.from(new Set(instances.filter((i) => i.source.kind === "part").map((i) => i.source.docId)));
    await Promise.all(docIds.map(async (d) => {
      try {
        const src = await this.load(d);
        out[d] = {};
        for (const b of src.bodies.values()) out[d][b.id] = { name: b.name, ...(b.material ? { material: b.material } : {}) };
      } catch (e) { /* the row falls back to the instance's name */ }
    }));
    return out;
  }

  /** The checking worker's `call`, as interference.ts takes it. */
  call = (service: string, args: unknown): Promise<unknown> => this.checker.call(service, args as never);

  dispose(): void { this.own?.dispose(); this.own = null; for (const s of this.sources.values()) s.kernel.dispose(); this.sources.clear(); }
}
