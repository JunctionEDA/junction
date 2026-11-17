// part.ts — the "part" source: a body of a part studio (`{ kind: "part", docId, body }`).
//
// The handle joins the part studio's document like an editor would (ItemDocSession), so it sees every edit as
// it is made, and turns the document into meshes without the person ever opening that tab: from the cache when
// this content was built before (cache.ts), else in a modelling worker (kernels.ts).  A regeneration is keyed
// by the document's content, so a rename or a reconnect costs nothing.
import { stableJson } from "../../../shared/itemdoc/itemdoc";
import { ItemDocSession } from "../../../shared/itemdoc/sync";
import { PART_STUDIO_KIND, featureInputs, featuresOf, rollbackIndex, type FeatureInput } from "../../mechanical/api";
import { fingerprint, readCached, writeCached } from "./cache";
import type { KernelPool } from "./kernels";
import type { SourceEnv, SourceHandle, SourcePiece, SourceProvider, SourceSnapshot } from "./types";

const assetV = (): string => String((globalThis as { __kcAssetV?: string }).__kcAssetV || "");

class PartHandle implements SourceHandle {
  private snap: SourceSnapshot = { status: "loading", message: "Opening the part studio…", pieces: [], version: 0 };
  private readonly session: ItemDocSession;
  private builtHash = "";
  private wantHash = "";
  private input: { features: FeatureInput[]; rollback: number } | null = null;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly docId: string, private readonly env: SourceEnv, private readonly pool: KernelPool) {
    this.session = new ItemDocSession({
      docId, signedIn: env.signedIn, expectKind: PART_STUDIO_KIND,
      onChange: () => this.schedule(),
      onStatus: (s) => { if (s.state === "error" && this.snap.status === "loading") this.set({ status: "error", message: s.text || "The part studio could not be opened." }); },
    });
    this.session.start();
  }

  snapshot(): SourceSnapshot { return this.snap; }
  kernel() { return this.pool.clientFor(this.docId); }
  features() { return this.input; }
  close(): void { this.closed = true; clearTimeout(this.timer); this.session.close(); this.pool.forget(this.docId); }

  private set(patch: Partial<SourceSnapshot>): void {
    if (this.closed) return;
    this.snap = { ...this.snap, ...patch, version: this.snap.version + 1 };
    this.env.changed();
  }

  /** Edits arrive in bursts (a drag in a sketch): build once they pause for a moment. */
  private schedule(): void { clearTimeout(this.timer); this.timer = setTimeout(() => void this.build(), this.builtHash ? 80 : 0); }

  private async build(): Promise<void> {
    const doc = this.session.doc;
    if (!doc || this.closed) return;
    const items = featuresOf(doc), rollback = rollbackIndex(doc, items), features = featureInputs(items);
    this.input = { features, rollback };
    // what the kernel would see: names are left out, so renaming a feature rebuilds nothing
    const hash = fingerprint(assetV() + "|" + rollback + "|" + stableJson(features.map((f) => ({ id: f.id, type: f.type, suppressed: f.suppressed, params: f.suppressed ? null : f.params })) as never));
    if (hash === this.builtHash) { this.wantHash = hash; return; }   // back to what is shown: drop whatever is on its way
    if (hash === this.wantHash) return;
    this.wantHash = hash;
    const first = !this.builtHash;
    if (first) {
      const cached = await readCached(this.docId, hash);
      if (this.closed || this.wantHash !== hash) return;
      if (cached) { this.builtHash = hash; this.set({ status: "ready", message: undefined, pieces: cached.map((b) => ({ id: b.id, name: b.name, mesh: b.mesh, transform: null })) }); return; }
    }
    if (first) this.set({ status: "loading", message: "Building the part…" });
    const result = await this.pool.regenerate(this.docId, features, rollback);
    if (this.closed) return;
    if (!result) {
      if (this.wantHash === hash) { this.wantHash = ""; const why = this.pool.failure; if (why) this.set({ status: "error", message: why }); }
      return;
    }
    if (this.wantHash !== hash) return;   // a newer edit is already being built
    this.builtHash = hash;
    const old = new Map(this.snap.pieces.map((p) => [p.id, p]));
    const pieces: SourcePiece[] = [];
    for (const b of result.bodies) {
      if (!b.mesh) continue;
      const was = old.get(b.id);
      // an unchanged body keeps its piece object: nothing downstream rebuilds
      pieces.push(was && was.mesh === b.mesh && was.name === b.name ? was : { id: b.id, name: b.name, mesh: b.mesh, transform: null });
    }
    const failed = result.features.filter((f) => f.status === "error").length;
    this.set({ status: "ready", message: failed ? `${failed} feature${failed === 1 ? "" : "s"} of the part studio failed to build.` : undefined, pieces });
    void writeCached(this.docId, hash, pieces.map((p) => ({ id: p.id, name: p.name, mesh: p.mesh })));
  }
}

export function partSource(pool: KernelPool): SourceProvider {
  return {
    kind: "part",
    docTypes: ["part_studio"],
    title: "Part studio",
    unavailable: () => null,
    open: (docId, env) => new PartHandle(docId, env, pool),
    select: (source, snapshot) => (source.kind === "part" ? snapshot.pieces.filter((p) => p.id === source.body) : []),
    offers: (docId, _docName, snapshot) => snapshot.pieces.map((p) => ({ source: { kind: "part", docId, body: p.id }, name: p.name })),
    offersAll: true,
  };
}
