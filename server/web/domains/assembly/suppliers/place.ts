// place.ts — put a supplier's model in the assembly: fetch it, keep it in the project, and add an instance.
//
// The model becomes a part studio of the project, by the paths every other part takes:
//   a STEP file   is stored in models/ (platform/doctabs/api.ts uploadFile) and imported by a new part studio
//                 (the mechanical domain's Import feature), as a dropped STEP file is, but as ONE body: a
//                 supplier's file of one part often holds several solids (a resistor's body and its two caps),
//                 and what is placed is the part;
//   a part studio the server drew (a standard part: sketches, a revolve, an extrude) is stored as it is.
// The instance is then an ordinary one of that studio's body, so it mates, fixes, hides and counts in the bill
// of materials like any part, and it carries `supplier` (model.ts) so its name and link survive.  A model the
// project already has (placed before, by anybody) is not fetched again: another instance of it is added.
import { fetchDocs, freeFilePath, uploadFile } from "../../../platform/doctabs/api";
import { rawFetch } from "../../../platform/documents/rawfetch";
import { modifiedChange, newId, newItemDoc, serializeItemDoc, type Item, type ItemChange } from "../../../shared/itemdoc/itemdoc";
import { isInstance, type Transform } from "../document/format";
import type { SourceOffer } from "../sources/types";
import type { AssemblyEditor } from "../ui/assembly";
import { fetchModel } from "./api";
import { existingStudio, fileStem, supplierOf, type ModelHit } from "./model";

const HOLDER = "supplier";
/** The standard part a generated model is ("shcs:M5:20"), out of the row's id. */
const specOf = (hit: ModelHit): string => (hit.generated ? hit.id.split("|").pop() || "" : "");

async function post(path: string, init: RequestInit): Promise<unknown> {
  const r = await rawFetch()(path, { credentials: "same-origin", ...init });
  if (!r.ok) { const t = await r.text().catch(() => ""); let m = t; try { m = (JSON.parse(t) as { message?: string }).message || t; } catch (e) { /* plain text */ } throw new Error(m || `${r.status} ${r.statusText}`); }
  return (r.headers.get("content-type") || "").includes("json") ? r.json() : r.text();
}

/** Keep the model in the project; returns the part studio that shows it. */
async function store(assembly: AssemblyEditor, hit: ModelHit, say: (text: string) => void): Promise<string> {
  const projectId = assembly.host.project.projectId;
  say(hit.format === "jpart" ? `Drawing ${hit.title}…` : `Fetching ${hit.title} from ${hit.supplier}…`);
  const got = await fetchModel(hit);
  const stem = fileStem(hit);
  const newDoc = async (text: string): Promise<string> => {
    const docs = await fetchDocs(projectId);
    const made = (await post(`/api/projects/${projectId}/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: freeFilePath("", stem + ".jpart", docs) }) })) as { docId: string };
    await post(`/api/docs/${made.docId}/snapshots?seq=0`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: text });
    return made.docId;
  };
  let docId: string;
  if (got.format === "jpart") docId = await newDoc(await got.data.text());
  else {
    say(`Adding ${hit.title} to the project…`);
    const stored = await uploadFile(projectId, "models", stem + ".step", new Blob([got.data], { type: "model/step" }));
    const items: Item[] = [
      { id: "studio", type: "studio", units: "mm", rollback: null },
      { id: newId(), type: "feature", featureType: "import", name: stem, order: "V", params: { file: { docId: stored.docId, path: stored.path, name: stored.path.split("/").pop() || stem + ".step", bytes: got.data.size, format: "step" }, split: "one" } },
      // where the file came from, for whoever opens the part studio (an item a reader that does not know it keeps)
      { ...supplierOf(hit), modelId: hit.id, id: "supplier-part", type: "supplier-part" },
    ];
    docId = await newDoc(serializeItemDoc(newItemDoc("part-studio", items)));
  }
  // the editor was handed the project's documents when it opened: tell it of the new ones
  const known = new Set(assembly.host.docs.map((d) => d.docId));
  for (const d of await fetchDocs(projectId).catch(() => [])) if (!known.has(d.docId)) assembly.host.docs.push({ docId: d.docId, path: d.path, docType: d.docType });
  if (!assembly.host.docs.some((d) => d.docId === docId)) assembly.host.docs.push({ docId, path: stem + ".jpart", docType: "part_studio" });
  return docId;
}

/** The studio's parts once it is built, or the reason it could not be. */
function built(assembly: AssemblyEditor, docId: string, ms: number): Promise<SourceOffer[]> {
  const provider = assembly.sources.provider("part");
  return new Promise((resolve, reject) => {
    let done = false;
    const stop = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); off(); fn(); };
    const look = () => {
      const snap = assembly.sources.snapshot("part", docId);
      if (!snap || !provider || snap.status === "loading") return;
      if (snap.status === "error") { stop(() => reject(new Error(snap.message || "The model could not be built."))); return; }
      const offers = provider.offers(docId, "", snap).filter((o) => !snap.pieces.find((p) => o.source.kind === "part" && p.id === o.source.body)?.reference);
      if (!offers.length) { stop(() => reject(new Error(snap.message || "The model has no solid in it."))); return; }
      stop(() => resolve(offers));
    };
    const off = assembly.subscribe(look);
    const timer = setTimeout(() => stop(() => reject(new Error("The model is taking too long to build. It is in the project: insert it from the list when it is ready."))), ms);
    look();
  });
}

/** Where a new model goes: along X, clear of everything placed; null when the assembly is empty. */
function beside(assembly: AssemblyEditor, docId: string): Transform | undefined {
  let right = -Infinity;
  for (const p of assembly.placed()) for (const piece of p.pieces) {
    const b = piece.mesh.bbox, t = piece.transform;
    for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) right = Math.max(right, t[0] * x + t[1] * y + t[2] * z + t[3]);
  }
  if (!Number.isFinite(right)) return undefined;
  let left = Infinity;
  for (const piece of assembly.sources.snapshot("part", docId)?.pieces || []) left = Math.min(left, piece.mesh.bbox[0]);
  if (!Number.isFinite(left)) left = 0;
  return [1, 0, 0, Math.round((right - left + 5) * 100) / 100, 0, 1, 0, 0, 0, 0, 1, 0];
}

/**
 * Fetch `hit`, keep it in the project and add an instance of it.  `say` hears what is going on.  Resolves with the
 * new instances' ids; rejects with what to tell the person.
 */
export async function placeModel(assembly: AssemblyEditor, hit: ModelHit, say: (text: string) => void = () => {}): Promise<string[]> {
  if (!assembly.getState().canEdit) throw new Error("You have view-only access to this assembly.");
  if (!hit.format) throw new Error(hit.note || "There is no model of this part to place.");
  let docId = existingStudio(assembly.host.docs, hit)?.docId || "";
  let held = "";
  try {
    for (let attempt = 0; ; attempt++) {
      if (!docId) docId = await store(assembly, hit, say);
      assembly.sources.hold("part", docId, HOLDER); held = docId;
      say(`Building ${hit.title}…`);
      const offers = await built(assembly, docId, 180000);
      // a drawn part of the same name and another size (the size of a supplier's number was typed again): not this one
      const said = assembly.sources.handle("part", docId)?.doc?.()?.items.get("standard-part") as { spec?: string } | undefined;
      if (attempt === 0 && specOf(hit) && said && typeof said.spec === "string" && said.spec !== specOf(hit)) { assembly.sources.release("part", docId, HOLDER); held = ""; docId = ""; continue; }
      // a model new to the assembly is set down beside what is there, not on top of it (one placed before goes beside its like: insert())
      const first = !assembly.getState().instances.some((i) => i.source.docId === docId);
      const at = first ? beside(assembly, docId) : undefined;
      const named = offers.map((o) => ({ ...o, name: offers.length === 1 ? hit.title : `${hit.title} ${o.name}`, ...(at ? { transform: at } : {}) }));
      const before = new Set(assembly.getState().instances.map((i) => i.id));
      assembly.insert(named);
      const doc = assembly.doc;
      const made = assembly.getState().instances.filter((i) => !before.has(i.id));
      if (!doc || !made.length) throw new Error("The model is in the project, but it could not be placed. Insert it from the list.");
      // where it came from, on each instance: not a step of its own in the undo history
      const supplier = supplierOf(hit);
      const changes: ItemChange[] = [];
      for (const i of made) { const item = doc.items.get(i.id); if (isInstance(item)) { const c = modifiedChange(item, { ...item, supplier }); if (c) changes.push(c); } }
      if (changes.length) assembly.commit(changes, { undoable: false });
      return made.map((i) => i.id);
    }
  } finally {
    // the instances hold the source from here on ("instances"); a failed attempt lets it go
    if (held) assembly.sources.release("part", held, HOLDER);
  }
}
