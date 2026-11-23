// mcp/host.ts — the assembly domain's tools for an AI assistant (the assembly cad_ tools of the MCP endpoint), as
// the table the headless tool host takes (web/platform/mcp/host.ts).  The catalog entries are mcp/tools.json.
//
// An assembly is opened as its editor opens it (an ItemDocSession, acting as the person), and the part studios
// its instances come from are built by the mechanical domain's headless studio (mechanical/mcp/api.ts), in the
// same process and kernel.  Edits are planned and solved by mcp/model.ts with the editor's own solver and
// committed through the session, so everyone in the assembly sees the parts move.  Looking, measuring, checking
// and exporting are the mechanical tools': this file gives them the assembly as a scene (its instances where
// the mates put them), so cad_render_view, cad_describe, cad_check, cad_measure, cad_find_geometry and
// cad_export work on a .jasm as they do on a .jpart.
//
// What this host does not build: board instances and model-file instances (they need the electronics reader and
// a file source of their own).  They are kept, listed, and left out of pictures and checks with a note.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { McpToolError, type McpDocEntry, type McpDomainTools, type McpProject, type McpReply, type McpRequest } from "../../../platform/mcp/host";
import { newId, newItemDoc, serializeItemDoc, type Item, type ItemDoc } from "../../../shared/itemdoc/itemdoc";
import { densities, featuresOf, materialOf, namedBodies, partNamesOf, type BodyMesh } from "../../mechanical/api";
import {
  OpenDoc, addReference, addSceneKind, api, createDocument, fieldDoc, findDocument, freePath, kernel, looksOf, needProject, needWrite, pickFields, placedBox, standingMesh, studioOf, undoRecorded,
  type Scene, type ScenePart,
} from "../../mechanical/mcp/api";
import { multiply } from "../core/transform";
import { ASSEMBLY_KIND, instancesOf, matesOf, newAssemblyText, transformOf as storedTransform, type InstanceItem, type InstanceSource, type Transform } from "../document/format";
import { MATES } from "../generated/mates";
import { bomCsv, combinedBom } from "../services/bom";
import { existingStudio, fileStem, supplierOf, type ModelHit, type ModelSearch } from "../suppliers/model";
import { assemblyJson, mateTypesText, planAssemblyEdits, solveAssembly, type AssemblyGeometry, type Piece, type ResolvedInsert, type SourcePieces } from "./model";

const W = globalThis as any;
const DOC_TYPE = "assembly";
const NO_ASSEMBLY = "(none; cad_create_assembly makes one)";
const baseName = (p: string) => p.split("/").pop() || p;
const stemOf = (p: string) => baseName(p).replace(/\.[^.]+$/, "");

class OpenAssembly extends OpenDoc {
  constructor(entry: McpDocEntry, req: McpRequest) { super(entry, req, ASSEMBLY_KIND); }
}
const open = new Map<string, OpenAssembly>();

function assemblyOf(req: McpRequest, entry: McpDocEntry): OpenAssembly {
  let a = open.get(entry.docId);
  if (!a) { a = new OpenAssembly(entry, req); open.set(entry.docId, a); }
  a.conn = { base: req.base, token: req.token, agent: req.agent }; a.lastUsed = Date.now();
  return a;
}
function findAssembly(p: McpProject, name: unknown): McpDocEntry { return findDocument(p, name, [DOC_TYPE], "assembly", NO_ASSEMBLY); }

// ---------------------------------------------------------------- the geometry of the instances

/** What a piece is beyond its mesh: the kernel's shape and what it is made of. */
interface PieceExtra { shape: any; color?: number; density: number | null; material?: string }
interface Gathered {
  geo: AssemblyGeometry;
  extras: Map<string, PieceExtra>;   // by `${kind}:${docId}:${piece id}`
  problems: string[];
  /** what a part studio's bodies are called and made of, for the bill of materials */
  parts: { [docId: string]: { [bodyId: string]: { name: string; material?: string } } };
}
const hex = (c: unknown): number | undefined => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? parseInt(c.slice(1), 16) : undefined);

/** Build every source the instances (and the sources about to be inserted) name. */
async function gather(req: McpRequest, p: McpProject, doc: ItemDoc, more: readonly InstanceSource[] = [], ancestry: readonly string[] = []): Promise<Gathered> {
  const all = new Map<string, { status: "ready" | "error"; message?: string; pieces: Piece[] }>();
  const extras = new Map<string, PieceExtra>(), problems: string[] = [], parts: Gathered["parts"] = {};
  const sources = [...instancesOf(doc).filter((i) => !i.suppressed).map((i) => i.source as InstanceSource), ...more];
  for (const s of sources) {
    const key = `${s.kind}:${s.docId}`;
    if (all.has(key)) continue;
    const entry = p.docs.find((d) => d.docId === s.docId);
    const fail = (message: string) => { all.set(key, { status: "error", message, pieces: [] }); problems.push(message); };
    if (!entry) { fail(`A document an instance comes from is no longer in the project (${s.docId}).`); continue; }
    if (s.kind === "part") {
      try {
        const studio = studioOf(req, entry), sdoc = await studio.doc(), built = await studio.regen(sdoc);
        const dens = densities(sdoc), names = partNamesOf(sdoc), looks = looksOf(sdoc), pieces: Piece[] = [];
        parts[s.docId] = {};
        for (const b of namedBodies(sdoc, built.result.bodies)) {
          if (!b.mesh) continue;
          const body = built.engine.state.bodies.find((x) => x.id === b.id);
          const mat = materialOf(sdoc, b.id);
          pieces.push({ id: b.id, name: names[b.id] || b.name, mesh: b.mesh, local: null });
          extras.set(`${key}:${b.id}`, { shape: body ? body.shape : null, color: hex(looks[b.id]?.color), density: dens[b.id] ?? null, material: mat?.name });
          parts[s.docId][b.id] = { name: names[b.id] || b.name, ...(mat ? { material: mat.name } : {}) };
        }
        const failed = built.result.features.filter((f) => f.status === "error").length;
        if (failed) problems.push(`${entry.path}: ${failed} feature${failed === 1 ? "" : "s"} failed to build (cad_get_features says which).`);
        all.set(key, { status: "ready", pieces });
      } catch (e) { fail(`${entry.path} could not be built: ${e instanceof Error ? e.message : String(e)}`); }
    } else if (s.kind === "assembly") {
      if (ancestry.includes(s.docId)) { fail(`${entry.path} contains itself.`); continue; }
      try {
        const sub = assemblyOf(req, entry), subDoc = await sub.doc();
        const inner = await gather(req, p, subDoc, [], [...ancestry, s.docId]);
        const pieces: Piece[] = [];
        for (const i of instancesOf(subDoc)) {
          if (i.suppressed || i.hidden) continue;
          const place = storedTransform(i), src = inner.geo.pieces(i.source);
          for (const piece of src.pieces) {
            const id = `${i.id}/${piece.id}`;
            pieces.push({ id, name: i.name, mesh: piece.mesh, local: piece.local ? multiply(place, piece.local) : place });
            const x = inner.extras.get(`${i.source.kind}:${i.source.docId}:${piece.id}`);
            if (x) extras.set(`${key}:${id}`, x);
          }
        }
        problems.push(...inner.problems);
        all.set(key, { status: "ready", pieces });
      } catch (e) { fail(`${entry.path} could not be opened: ${e instanceof Error ? e.message : String(e)}`); }
    } else fail(`${entry.path} is a ${s.kind === "board" ? "circuit board" : "model file"}: the tool host does not build those, so it is left out of pictures, checks and exports here (it is still in the assembly).`);
  }
  const geo: AssemblyGeometry = {
    pieces(source): SourcePieces {
      const got = all.get(`${source.kind}:${source.docId}`);
      if (!got) return { status: "error", message: "Its source was not built.", pieces: [] };
      if (got.status !== "ready" || source.kind !== "part") return got;
      const mine = got.pieces.filter((x) => x.id === source.body);
      return mine.length ? { status: "ready", pieces: mine } : { status: "error", message: "The body it showed no longer exists in its part studio.", pieces: [] };
    },
  };
  return { geo, extras, problems: Array.from(new Set(problems)), parts };
}

const standingOf = (mesh: BodyMesh, t: Transform): BodyMesh => standingMesh({ mesh, transform: t });

// ---------------------------------------------------------------- the assembly as a scene

function partsOf(doc: ItemDoc, g: Gathered, transforms: ReadonlyMap<string, Transform>, skipHidden: boolean): { parts: ScenePart[]; owners: InstanceItem[] } {
  const parts: ScenePart[] = [], owners: InstanceItem[] = [];
  for (const i of instancesOf(doc)) {
    if (i.suppressed || (skipHidden && i.hidden)) continue;
    const src = g.geo.pieces(i.source), place = transforms.get(i.id) || storedTransform(i);
    for (const piece of src.pieces) {
      const x = g.extras.get(`${i.source.kind}:${i.source.docId}:${piece.id}`);
      parts.push({
        id: i.id, name: src.pieces.length > 1 ? `${i.name} / ${piece.name}` : i.name, body: piece.id, mesh: piece.mesh, shape: x ? x.shape : null,
        transform: piece.local ? multiply(place, piece.local) : place, owner: i.id, color: x?.color, density: x ? x.density : null, material: x?.material, createdBy: i.name,
      });
      owners.push(i);
    }
  }
  return { parts, owners };
}

addSceneKind({
  docType: DOC_TYPE, what: "assembly",
  async scene(req, entry, { args }) {
    const p = needProject(req), a = assemblyOf(req, entry), doc = await a.doc();
    const g = await gather(req, p, doc);
    const solved = solveAssembly(doc, MATES, g.geo);
    const { parts, owners } = partsOf(doc, g, solved.transforms, req.tool === "cad_render_view");
    const json = assemblyJson(doc, MATES, g.geo, { compact: true });
    const problems = [...g.problems];
    for (const m of json.mates as any[]) if (m.state !== "ok" && m.state !== "suppressed") problems.push(`${m.name}: failed: mate is ${m.state}${m.message ? ": " + m.message : ""}`);
    const mates = (json.mates as any[]).map((m) => `${m.name} (${m.type}: ${m.a.instance} to ${m.b.instance}${m.values ? ", " + Object.entries(m.values).map(([k, v]) => `${k} ${v}`).join(", ") : ""}${m.state !== "ok" ? ` [${m.state}]` : ""})`);
    const solve = json.solve as any;
    const scene: Scene & { frames?: { transforms: (number[] | null)[]; label: string }[] } = {
      document: entry.path, kind: "assembly", k: parts.some((x) => x.shape) ? await kernel() : null, parts, problems, partWord: "instance",
      notes: [`Mates (${mates.length}): ${mates.join("; ") || "none yet"}`, `Freedoms left: ${solve.freedoms === null ? "not counted" : solve.freedoms}.` + (solve.hints ? " " + solve.hints.join(" ") : "")],
      refOf: (part, kind, name) => ({ instance: owners[parts.indexOf(part)]?.name || part.name, [kind]: name }),
    };
    if (req.tool === "cad_render_view") {
      // an exploded view: every instance moved away from the middle of the assembly, as the editor's Explode does
      const k = typeof args.explode === "number" && Number.isFinite(args.explode) ? Math.max(0, Math.min(3, args.explode)) : 0;
      if (k > 0 && parts.length > 1) {
        const mids = parts.map((x) => { const b = placedBox(x.mesh, x.transform); return [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2]; });
        const byOwner = new Map<string, number[]>();
        parts.forEach((x, i) => { const c = byOwner.get(x.owner) || [0, 0, 0, 0]; c[0] += mids[i][0]; c[1] += mids[i][1]; c[2] += mids[i][2]; c[3]++; byOwner.set(x.owner, c); });
        const centre = [0, 0, 0]; for (const c of byOwner.values()) for (let j = 0; j < 3; j++) centre[j] += c[j] / c[3] / byOwner.size;
        for (const x of parts) { const c = byOwner.get(x.owner)!, t = (x.transform as number[]).slice(); t[3] += (c[0] / c[3] - centre[0]) * k; t[7] += (c[1] / c[3] - centre[1]) * k; t[11] += (c[2] / c[3] - centre[2]) * k; x.transform = t; }
      }
      if (args.drive !== undefined && args.drive !== null) {
        const d = args.drive, mates2 = matesOf(doc), low = String(d.mate || "").toLowerCase();
        const m = mates2.find((x) => x.id === d.mate) || mates2.find((x) => x.name.toLowerCase() === low);
        if (!m) throw new McpToolError(`drive.mate: there is no mate "${d.mate}". The mates are: ${mates2.map((x) => x.name).join(", ") || "(none)"}.`);
        const values = MATES.find((x) => x.type === m.mateType)?.solve?.values || [];
        const v = typeof d.key === "string" ? values.find((x) => x.key === d.key) : values[0];
        if (!v) throw new McpToolError(`A ${m.mateType} mate has no ${typeof d.key === "string" ? `value "${d.key}"` : "value to drive"}.`);
        if (!Array.isArray(d.values) || !d.values.length || d.values.length > 6 || !d.values.every((x: any) => typeof x === "number" && Number.isFinite(x))) throw new McpToolError("drive.values is a list of 1 to 6 numbers (degrees for an angle, millimetres for a distance).");
        scene.frames = d.values.map((value: number) => {
          const s = solveAssembly(doc, MATES, g.geo, { drives: [{ mate: m.id, key: v.key, value }], analyze: false });
          const state = s.mates.get(m.id);
          return { label: `${m.name} ${v.key} ${value}${v.unit === "deg" ? "°" : " mm"}${state && state.state !== "ok" ? " (not reached: " + state.state + ")" : ""}`, transforms: partsOf(doc, g, s.transforms, true).parts.map((x) => x.transform) };
        });
      }
    }
    return scene;
  },
});

// ---------------------------------------------------------------- reading

async function getAssembly(req: McpRequest): Promise<McpReply> {
  const p = needProject(req), a = assemblyOf(req, findAssembly(p, req.args.document)), doc = await a.doc();
  const g = await gather(req, p, doc);
  const out = assemblyJson(doc, MATES, g.geo, { compact: req.args.compact === true, docName: (id) => p.docs.find((d) => d.docId === id)?.path || id });
  if (req.args.fields !== undefined) {
    // the keys of an instance and of a mate differ: a key is kept where it exists, and must exist in one of the two
    const rows = [...(out.instances as any[]), ...(out.mates as any[])];
    pickFields(rows, req.args.fields, "instance or mate");
    const keep = (list: any[]) => list.map((r) => { const o: any = { name: r.name }; for (const k of req.args.fields as string[]) if (k in r) o[k] = r[k]; return o; });
    out.instances = keep(out.instances as any[]); out.mates = keep(out.mates as any[]);
  }
  return { result: { document: a.entry.path, ...out, problems: g.problems.length ? g.problems : undefined } };
}

async function getBom(req: McpRequest): Promise<McpReply> {
  const p = needProject(req), a = assemblyOf(req, findAssembly(p, req.args.document)), doc = await a.doc();
  const g = await gather(req, p, doc);
  const boards: { [docId: string]: { error: string } } = {};
  for (const i of instancesOf(doc)) if (i.source.kind === "board") boards[i.source.docId] = { error: "The board's own parts are listed by get_bom (the electronics tool) on the board." };
  const rows = combinedBom({ instances: instancesOf(doc), docs: p.docs, parts: g.parts, boards });
  if (req.args.format === "csv") return { result: bomCsv(rows) };
  return {
    result: { document: a.entry.path, lines: rows.length, parts: rows.reduce((n, r) => n + (r.kind === "component" ? 0 : r.quantity), 0),
      rows: rows.map((r) => ({ item: r.item, name: r.name, quantity: r.quantity, kind: r.kind, ...(r.description ? { from: r.description } : {}), ...(r.material ? { material: r.material } : {}), ...(r.link ? { link: r.link } : {}), ...(r.note ? { note: r.note } : {}) })) },
  };
}

// ---------------------------------------------------------------- suppliers' models and standard parts

async function searchModels(req: McpRequest, query: string): Promise<ModelSearch> {
  return (await api(req, `/api/models3d/search?q=${encodeURIComponent(query)}`)) as ModelSearch;
}

async function searchTool(req: McpRequest): Promise<McpReply> {
  const q = typeof req.args.query === "string" ? req.args.query.trim() : "";
  if (!q) throw new McpToolError("query is what to look for: a standard size (\"M5x20 socket head\", \"M4 nut\", \"608 bearing\") or a supplier's part number.");
  const r = await searchModels(req, q);
  const limit = Math.max(1, Math.min(30, Math.round(Number(req.args.limit) || 10)));
  const rows = r.results.slice(0, limit).map((h) => ({
    title: h.title, model: { provider: h.provider, id: h.id, title: h.title }, supplier: h.supplier, part_number: h.part_number || undefined, description: h.description || undefined,
    ...(h.size ? { size_mm: h.size } : {}), ...(h.generated ? { drawn_from_standard: true } : {}),
    placeable: !!h.format && !h.upload, ...(h.note ? { note: h.note } : {}), ...(h.url ? { url: h.url } : {}),
  }));
  return {
    result: { query: q, count: r.results.length, results: rows, ...(r.errors && r.errors.length ? { errors: r.errors.map((e) => `${e.name}: ${e.message}`) } : {}),
      note: rows.some((x) => x.placeable) ? "Place one with cad_edit_assembly { op: \"insert\", model: <a result's model> }, or { op: \"insert\", standard: \"<the same words>\" } for the first drawn standard part. size_mm is the part's box." : "Nothing here can be placed. Try a standard size (\"M5x20 socket head\", \"M4 hex nut\", \"M4 washer\", \"608 bearing\")." },
  };
}

/** The part studio of a supplier's model in the project, made now when the project does not have it yet. */
async function modelStudio(req: McpRequest, p: McpProject, hit: ModelHit): Promise<McpDocEntry> {
  const have = existingStudio(p.docs, hit);
  if (have) return have;
  needWrite(req, p);
  let r: any;
  try { r = await W.fetch(`${req.base}/api/models3d/model?provider=${encodeURIComponent(hit.provider)}&id=${encodeURIComponent(hit.id)}`, { headers: { authorization: `Bearer ${req.token}` } }); }
  catch (e) { throw new McpToolError("The supplier's model could not be fetched. Try again."); }
  if (!r.ok) { let m = ""; try { const b = await r.json(); m = b.message || b.error || ""; } catch { /* no body */ } throw new McpToolError(`${hit.title} could not be fetched${m ? ": " + m : ` (${r.status})`}.`); }
  const stem = fileStem(hit);
  if (r.headers.get("x-model-format") === "jpart") return createDocument(req, p, `${stem}.jpart`, await r.text(), "part_studio");
  const bytes = new Uint8Array(await r.arrayBuffer());
  const taken = new Set(p.docs.map((d) => d.path.toLowerCase()));
  let path = `models/${stem}.step`; for (let n = 2; taken.has(path.toLowerCase()); n++) path = `models/${stem} ${n}.step`;
  const stored = await createDocument(req, p, path, bytes, "model3d");
  const items: Item[] = [
    { id: "studio", type: "studio", units: "mm", rollback: null },
    { id: newId(), type: "feature", featureType: "import", name: stem, order: "V", params: { file: { docId: stored.docId, path: stored.path, name: baseName(stored.path), bytes: bytes.length, format: "step" }, split: "one" } } as Item,
    { ...supplierOf(hit), modelId: hit.id, id: "supplier-part", type: "supplier-part" } as Item,
  ];
  return createDocument(req, p, `${stem}.jpart`, serializeItemDoc(newItemDoc("part-studio", items)), "part_studio");
}

/** What an insert edit places: the documents are found (a supplier's model is brought into the project) and built. */
async function resolveInsert(req: McpRequest, p: McpProject, self: McpDocEntry, e: any): Promise<ResolvedInsert> {
  try {
    let entry: McpDocEntry, supplier: any, title = "";
    if (e.assembly !== undefined) {
      entry = findDocument(p, e.assembly, [DOC_TYPE], "assembly", NO_ASSEMBLY);
      if (entry.docId === self.docId) return { offers: [], problem: "an assembly cannot be placed in itself" };
      return { offers: [{ source: { kind: "assembly", docId: entry.docId }, name: stemOf(entry.path) }] };
    }
    if (e.standard !== undefined || e.model !== undefined) {
      let hit: ModelHit | undefined;
      if (typeof e.standard === "string" && e.standard.trim()) {
        const r = await searchModels(req, e.standard.trim());
        // the words asked for must be the part's: a search that finds something else ("flange" answered with a nut) is not it
        const asked = e.standard.toLowerCase().split(/[^a-z]+/).filter((w: string) => w.length >= 3 && !/^m\d/.test(w) && !["and", "the", "with", "for", "mm"].includes(w));
        const fits = (h: ModelHit): boolean => { const text = `${h.title} ${h.description} ${h.part_number}`.toLowerCase(); return asked.every((w: string) => text.includes(w) || text.includes(w.replace(/s$/, ""))); };
        hit = r.results.find((h) => h.generated && h.format && !h.upload && fits(h)) || r.results.find((h) => h.format && !h.upload && fits(h));
        if (!hit) return { offers: [], problem: `nothing that can be placed matches "${e.standard}"${r.results.length ? ` (found: ${r.results.slice(0, 4).map((h) => h.title).join(", ")})` : ""}. Try a standard size such as "M5x20 socket head", "M4 hex nut", "M4 washer", "608 bearing", or look with cad_search_models` };
      } else if (e.model && typeof e.model === "object" && typeof e.model.provider === "string" && typeof e.model.id === "string") {
        const r = await searchModels(req, String(e.model.title || e.model.id.split("|").pop() || e.model.id)).catch(() => null);
        hit = (r && r.results.find((h) => h.provider === e.model.provider && h.id === e.model.id)) || ({ provider: e.model.provider, id: e.model.id, supplier: e.model.provider, part_number: "", title: String(e.model.title || e.model.id), description: "", format: "step", url: "", generated: false } as ModelHit);
        if (hit.upload || !hit.format) return { offers: [], problem: hit.note || `${hit.title} has no model the server can fetch; the person can download the supplier's STEP file and add it to the project, then insert it as a part` };
      } else return { offers: [], problem: "standard is a size in words (\"M5x20 socket head\"); model is { provider, id, title } from cad_search_models" };
      entry = await modelStudio(req, p, hit); supplier = supplierOf(hit); title = hit.title;
    } else if (e.part !== undefined) entry = findDocument(p, e.part, ["part_studio"], "part studio", "(none; cad_create_part_studio makes one)");
    else return { offers: [] };
    const studio = studioOf(req, entry), sdoc = await studio.doc(), built = await studio.regen(sdoc);
    const names = partNamesOf(sdoc);
    const bodies = built.engine.state.bodies.filter((b) => !b.reference && !b.sheet).map((b) => ({ id: b.id, name: names[b.id] || b.name, createdBy: b.createdBy }));
    if (!bodies.length) {
      const failed = built.result.features.filter((f) => f.status === "error");
      return { offers: [], problem: `${entry.path} has no solid body to place${failed.length ? ` (${failed.length} of its features failed: ${failed[0].message || ""})` : " yet"}` };
    }
    let chosen = bodies;
    if (typeof e.body === "string" && e.body) {
      const low = e.body.toLowerCase(), features = featuresOf(sdoc);
      const f = features.find((x) => x.id === e.body) || features.find((x) => x.name.toLowerCase() === low);
      chosen = bodies.filter((b) => b.id === e.body || b.name.toLowerCase() === low || (f && b.createdBy === f.id));
      if (!chosen.length) return { offers: [], problem: `${entry.path} has no body "${e.body}". Its bodies are: ${bodies.map((b) => b.name).join(", ")}` };
    }
    const stem = title || stemOf(entry.path);
    return { offers: chosen.map((b) => ({ source: { kind: "part", docId: entry.docId, body: b.id }, name: bodies.length === 1 ? stem : supplier ? `${stem} ${b.name}` : b.name })), supplier };
  } catch (err) {
    if (err instanceof McpToolError) return { offers: [], problem: err.message.replace(/\.$/, "") };
    throw err;
  }
}

// ---------------------------------------------------------------- editing

async function editAssembly(req: McpRequest): Promise<McpReply> {
  const p = needProject(req), a = assemblyOf(req, findAssembly(p, req.args.document)), doc = await a.doc();
  const dry = req.args.dry_run === true, list = req.args.edits;
  if (!dry) needWrite(req, p);
  if (!Array.isArray(list) || !list.length) throw new McpToolError("Nothing was changed. edits must be a list with at least one edit.");
  const inserts = new Map<number, ResolvedInsert>();
  for (let n = 0; n < list.length; n++) if (list[n] && list[n].op === "insert") inserts.set(n, await resolveInsert(req, p, a.entry, list[n]));
  const more = Array.from(inserts.values()).flatMap((r) => r.offers.map((o) => o.source));
  const g = await gather(req, p, doc, more);
  const plan = planAssemblyEdits(doc, list, { defs: MATES, geo: g.geo, inserts, standing: standingOf });
  if (plan.problems.length) throw new McpToolError(`Nothing was changed. ${plan.problems.join("; ")}.`);
  const say = (d: ItemDoc) => assemblyJson(d, MATES, g.geo, { compact: true, docName: (id) => p.docs.find((x) => x.docId === id)?.path || id });
  if (dry) return { result: { document: a.entry.path, dry_run: true, would: plan.done, ...say(plan.after), notes: plan.notes.length ? plan.notes : undefined, note: "Nothing was changed in the assembly. This is how it would stand." } };
  await a.commit(plan.changes);
  const title = plan.done.length === 1 ? plan.done[0] : `${plan.done.length} edits to ${baseName(a.entry.path)}`;
  const reply: McpReply = { result: { document: a.entry.path, applied: plan.done, ...say(await a.doc()), notes: plan.notes.length ? plan.notes : undefined, problems: g.problems.length ? g.problems : undefined } };
  if (plan.changes.length) reply.record = { docId: a.entry.docId, title: title.slice(0, 200), edits: plan.done, undo: { domain: "assembly", inverse: plan.inverse } };
  return reply;
}

async function undo(req: McpRequest): Promise<McpReply> {
  const p = needProject(req); needWrite(req, p);
  const rec = req.args.__record as { docId: string };
  const entry = p.docs.find((d) => d.docId === rec.docId);
  if (!entry) throw new McpToolError("The document of that change is no longer in the project.");
  const a = assemblyOf(req, entry);
  return undoRecorded(req, a, async () => { const doc = await a.doc(); const g = await gather(req, p, doc); return assemblyJson(doc, MATES, g.geo, { compact: true }); }, "assembly");
}

async function createAssembly(req: McpRequest): Promise<McpReply> {
  const p = needProject(req); needWrite(req, p);
  const path = freePath(p, req.args.name, ".jasm", "Assembly");
  await createDocument(req, p, path, newAssemblyText(), DOC_TYPE);
  return { result: { created: path, document: path, note: "An empty assembly. Insert parts with cad_edit_assembly (fix the first one), then add mates; cad_reference topic \"mates\" says how." } };
}

// ---------------------------------------------------------------- the page on mates

addReference("mates", "Assemblies: instances, mates and connectors", () => `# Assemblies

An assembly (.jasm) places bodies of part studios (and other assemblies) as instances and ties them with mates.
It copies no geometry: when a part studio changes, the assembly follows. cad_create_assembly makes one;
cad_get_assembly reads it; cad_edit_assembly changes it; cad_describe, cad_render_view (also explode and drive),
cad_measure, cad_check (interference), cad_find_geometry and cad_export work on it as on a part studio, in assembly
space. cad_get_bom is its bill of materials; cad_search_models finds standard hardware and suppliers' parts.

## Edits (cad_edit_assembly), applied in order as one change, the mates solved after each
- { op: "insert", part: "Box.jpart", body?, name?, at?: [x, y, z], rotate?: { axis, angle }, fixed?, ref? }
  A part keeps the place its part studio gave it unless at says otherwise, so parts designed in position assemble in
  position; a second instance of the same body is set beside the first. Without body every solid of the studio is
  inserted. Also assembly: "Sub.jasm" (a rigid sub-assembly), standard: "M5x20 socket head" (a standard part the
  server draws: socket head, button head and countersunk screws, hex nuts, washers, bearings, …), or
  model: { provider, id, title } from cad_search_models. The model is added to the project as a part studio.
- { op: "fix", instance, fixed? }: pin an instance. Fix the base part first, or everything floats.
- { op: "move", instance, to?: [x, y, z], by?: [dx, dy, dz], rotate?: { axis, angle, about? } }: mates still hold.
- { op: "mate", type, a, b, name?, params?, ref? }: b is moved to a. { op: "set_mate", mate, a?, b?, params?, type?, name? }.
- { op: "drive", mate, value, key? }: set a mate's angle (degrees) or distance (mm), the other mates holding; stored.
- { op: "copy", instance, count?, step: [dx, dy, dz] }, { op: "rename", instance | mate, name },
  { op: "suppress", instance | mate, suppressed? }, { op: "hide", instance, hidden? }, { op: "delete", instance | mate }.
An instance or mate is named by its name, its id, or "$ref" of an earlier edit in the same call.

## Connectors
A mate joins a connector on instance a to one on instance b. A connector is geometry of the part:
{ instance, face: <name or pick> }, { instance, edge: … } or { instance, vertex: … }, with flip: true to turn its axis
round. Picks are as everywhere (cad_reference topic "references"), on the instance where it stands in the assembly:
{ instance: "Lid", face: "bottom" }, { instance: "Pin", face: { type: "cylinder" } },
{ instance: "Box", face: { hole: true, diameter: 4, nearest: [10, 5, 20] } }.
What each gives: a flat face, its centre with the axis along its outward normal; a cylinder (a hole or a shaft), the
middle of its axis; a circular edge, its centre with the axis through it (the rim of a hole: the usual seat of a
screw head); a straight edge, its midpoint; a vertex, the point.
The mate brings b's connector onto a's: same origin, axes along each other. When both are flat faces b is flipped so
the faces MEET, unless you give flip yourself. params.offset (mm) moves b along the axis, params.rotation (degrees)
turns it about the axis, params.reorient (0 to 3) gives it quarter turns. If a part lands the wrong way round, set
flip on one end or a rotation; look with cad_render_view.

## Mate types
${mateTypesText(MATES, fieldDoc)}
limits: true with <value>Min and <value>Max (for example angleMin: 0, angleMax: 110) stops a motion at both ends.

## What the result says
solve.freedoms is the number of freedoms the whole assembly is left (0: nothing can move; a hinged lid leaves 1).
Each instance says its own; each mate its state (ok, conflict, error) and its values. A conflict means the mates
ask for the impossible: remove or change the last one. cad_render_view { drive: { mate, values: [0, 45, 90] } }
shows a motion; cad_check finds parts that overlap.

## A hinge in one call
{ "edits": [
  { "op": "insert", "part": "Box.jpart", "ref": "box", "fixed": true },
  { "op": "insert", "part": "Lid.jpart", "ref": "lid" },
  { "op": "mate", "type": "revolute", "name": "Hinge", "a": { "instance": "$box", "face": { "hole": true, "diameter": 3 } }, "b": { "instance": "$lid", "face": { "hole": true, "diameter": 3 } }, "params": { "limits": true, "angleMin": 0, "angleMax": 110 } },
  { "op": "insert", "standard": "M3x10 socket head", "ref": "screw" },
  { "op": "mate", "type": "fastened", "a": { "instance": "$box", "edge": { "type": "circle", "diameter": 3.4, "nearest": [5, 5, 20] } }, "b": { "instance": "$screw", "edge": { "type": "circle", "nearest": [0, 0, 0] } } }
] }
`);

export const ASSEMBLY_TOOLS: McpDomainTools = {
  domain: "assembly",
  tools: {
    cad_create_assembly: createAssembly,
    cad_get_assembly: getAssembly,
    cad_edit_assembly: editAssembly,
    cad_search_models: searchTool,
    cad_get_bom: getBom,
  },
  undo,
  sweep(idleMs: number): void {
    const now = Date.now();
    for (const [id, a] of open) if (now - a.lastUsed > idleMs) { a.close(); open.delete(id); }
  },
};
