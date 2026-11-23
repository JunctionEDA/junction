// mcp/host.ts — the mechanical domain's tools for an AI assistant (the cad_ tools of the MCP endpoint), as the
// table the headless tool host takes (web/platform/mcp/host.ts).  The catalog entries are mcp/tools.json.
//
// A part studio is opened here exactly as a browser tab opens it: an ItemDocSession on the collaboration socket,
// acting as the person.  An edit is planned from the feature registry (mcp/model.ts), committed through the
// session (so everyone in the document sees it, and it lands in the journal like anyone's edit), and then the
// model is rebuilt by the same regeneration engine the browser's worker runs, on the same OpenCascade build, so
// the assistant is told what the people in the document see: which features failed and why, the bodies, their
// volume.  One kernel serves every document this process has open; each document keeps its own engine (its
// cache of what every feature built).
//
// The tools that look at, check and export "what is there" (cad_render_view, cad_describe, cad_check,
// cad_measure, cad_find_geometry, cad_export) work on a SCENE: named parts with a tessellation, the kernel's
// shape and a placement.  A part studio's scene is its bodies; another kind of document brings its own with
// `addSceneKind` (an assembly's is its instances as placed, assembly/mcp/host.ts), and those tools then work on
// it unchanged.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { McpToolError, type McpDocEntry, type McpDomainTools, type McpProject, type McpReply, type McpRequest } from "../../../platform/mcp/host";
import { newId, newItemDoc, serializeItemDoc, type Item, type ItemChange, type ItemDoc } from "../../../shared/itemdoc/itemdoc";
import { ItemDocSession } from "../../../shared/itemdoc/sync";
import { BoardFeed } from "../board/feed";
import { looksOf } from "../document/appearance-items";
import { PART_STUDIO_KIND, featuresOf, newPartStudioText } from "../document/format";
import { studioInputs } from "../document/inputs";
import { densities, materialOf } from "../document/mass-materials";
import { partNamesOf } from "../document/part-items";
import { FEATURES, SERVICES, RegenEngine, resolveRef, type Kernel, type RegenResult } from "../kernel/index";
import { loadKernel } from "../kernel/load";
import { faceOutline, sketchDrawing, writeDxf, writeSvg } from "../kernel/ops/exchange-2d";
import { RESOLUTIONS, meshOf, triangleCount, write3mf, writeGlb, writeObj, writeStlBinary, type MeshPart } from "../kernel/ops/exchange-mesh";
import { writeBrep, writeStep, type ExportPart } from "../kernel/ops/exchange-step";
import type { BodyMesh } from "../kernel/protocol";
import type { Shape } from "../kernel/types";
import { brepOf, placed } from "../services/_measure-kernel";
import type { SketchData } from "../sketch/format";
import { loadSolver } from "../sketch/solver/load";
import type { SketchSolver } from "../sketch/solver/solve";
import { catalogText, featureCatalog } from "./catalog";
import { describeFeature, describePart, minThickness, placedBox } from "./describe";
import { applyRecorded, featureTypes, findBody, planStaged, treeOf, variablesJson, type KnownBody } from "./model";
import { addReference, reference, referenceTopics } from "./reference";
import { VIEWS, encodePng, renderMeshes, renderSheet, type RenderOptions, type ViewName } from "./render";
import { PickError, SIDES, infoJson, pickGeometry, summarise, type GeoKind } from "./select";
import { sketchReport } from "./sketch";

declare const process: any;
declare function require(name: string): any;
const W = globalThis as any;

const DOC_TYPE = "part_studio";

// ---------------------------------------------------------------- the kernel

let kernelLoading: Promise<Kernel> | null = null;
export function kernel(): Promise<Kernel> {
  if (!kernelLoading) {
    kernelLoading = (async () => {
      const fs = require("node:fs"), path = require("node:path");
      // beside the Python runtime the server serves (scripts/build-python.mjs puts it there), or where KC_OCC_WASM says
      const dirs = [process.env.KC_OCC_WASM, process.env.KC_PYODIDE_DIR && path.join(process.env.KC_PYODIDE_DIR, "occ-kernel.wasm"), path.join(process.cwd(), "static", "dist", "pyodide", "occ-kernel.wasm")].filter(Boolean) as string[];
      const file = dirs.find((f) => fs.existsSync(f));
      if (!file) throw new McpToolError("The modelling kernel is not installed on this server (occ-kernel.wasm is missing from its runtime folder), so part studios cannot be rebuilt here. The feature list can still be read with cad_get_features.");
      // in Node the kernel's loader reads the file itself, from the path it is told
      return loadKernel({ wasmUrl: path.resolve(file) });
    })();
    kernelLoading.catch(() => { kernelLoading = null; });
  }
  return kernelLoading;
}

let solverLoading: Promise<SketchSolver | null> | null = null;
/** The sketch constraint solver, or null where it cannot start: sketches are then written without a freedom count. */
function solver(): Promise<SketchSolver | null> {
  if (!solverLoading) solverLoading = loadSolver().catch(() => null);
  return solverLoading;
}

// ---------------------------------------------------------------- the server, as the person

/** Who the process is acting for just now: an Import feature reads its file with it (kernel/ops/exchange-files.ts). */
let acting: { base: string; token: string } = { base: "", token: "" };
W.__junctionProjectFile = async (file: { docId: string }): Promise<Uint8Array | null> => {
  if (!acting.base) return null;
  const r = await W.fetch(`${acting.base}/api/docs/${encodeURIComponent(file.docId)}/content`, { headers: { authorization: `Bearer ${acting.token}` } });
  return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
};

/** One request to the server's own API with the person's token; the parsed JSON, or the text. */
export async function api(req: McpRequest, url: string, init: any = {}): Promise<any> {
  let r: any;
  try { r = await W.fetch(req.base + url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${req.token}` } }); }
  catch (e) { throw new McpToolError("The server could not be reached from the tool host. Try again."); }
  const text = await r.text(); let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw new McpToolError((body && (body.message || body.error)) || `The server refused (${r.status}).`);
  return body;
}

/** Add a document to the project with its first content; returns its entry (also added to the request's project). */
export async function createDocument(req: McpRequest, p: McpProject, path: string, content: string | Uint8Array, docType: string): Promise<McpDocEntry> {
  const made = await api(req, `/api/projects/${p.projectId}/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
  await api(req, `/api/docs/${made.docId}/snapshots?seq=0`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: content });
  const entry = { docId: made.docId, path: made.path || path, docType: made.docType || docType };
  if (!p.docs.some((d) => d.docId === entry.docId)) p.docs.push(entry);
  return entry;
}

/** A name a document can have, and the path that is free for it. */
export function freePath(p: McpProject, name: unknown, ext: string, fallback: string): string {
  let stem = typeof name === "string" ? name.trim().replace(new RegExp(`\\${ext}$`, "i"), "") : "";
  if (/[\\/:*?"<>|]/.test(stem)) throw new McpToolError("The name cannot contain / \\ : * ? \" < > |.");
  const taken = new Set(p.docs.map((d) => d.path.toLowerCase()));
  if (!stem) { for (let n = 1; ; n++) if (!taken.has(`${fallback} ${n}${ext}`.toLowerCase())) { stem = `${fallback} ${n}`; break; } }
  const path = `${stem}${ext}`;
  if (taken.has(path.toLowerCase())) throw new McpToolError(`${p.name} already has a document called ${path}. Use it, or choose another name.`);
  return path;
}

// ---------------------------------------------------------------- documents

/** The collaboration socket, saying it is an assistant: the people in the document see who is editing. */
function agentSocket(agent: () => string): typeof WebSocket {
  return class {
    private ws: any;
    onopen: any = null; onclose: any = null; onmessage: any = null; onerror: any = null;
    constructor(url: string) {
      this.ws = new W.WebSocket(url);
      this.ws.onopen = (e: any) => this.onopen && this.onopen(e);
      this.ws.onclose = (e: any) => this.onclose && this.onclose(e);
      this.ws.onmessage = (e: any) => this.onmessage && this.onmessage(e);
      this.ws.onerror = (e: any) => this.onerror && this.onerror(e);
    }
    get readyState(): number { return this.ws.readyState; }
    send(data: string): void {
      if (typeof data === "string" && data.startsWith("{\"type\":\"hello\"")) { const m = JSON.parse(data); m.client = "mcp"; m.agent = agent(); data = JSON.stringify(m); }
      this.ws.send(data);
    }
    close(): void { this.ws.close(); }
  } as unknown as typeof WebSocket;
}

/** An item document (a part studio, an assembly) joined over the collaboration socket, as the person. */
export class OpenDoc {
  readonly session: ItemDocSession;
  lastUsed = Date.now();
  conn: { base: string; token: string; agent: string };
  private loaded: Promise<void>;
  private failed = "";

  constructor(readonly entry: McpDocEntry, req: McpRequest, kind: string) {
    this.conn = { base: req.base, token: req.token, agent: req.agent };
    let ok!: () => void;
    this.loaded = new Promise<void>((resolve) => { ok = resolve; });
    this.session = new ItemDocSession({
      docId: entry.docId, signedIn: true, expectKind: kind,
      onChange: (ids) => { if (ids === null) ok(); },
      onStatus: (s) => { if (s.state === "error") { this.failed = s.text; ok(); } },
      socketUrl: req.base.replace(/^http/, "ws") + "/ws",
      fetchTicket: async () => this.conn.token,
      WebSocketImpl: this.socket(),
    });
    this.session.start();
  }
  protected socket(): typeof WebSocket { return agentSocket(() => this.conn.agent || "AI assistant"); }

  async doc(): Promise<ItemDoc> {
    await Promise.race([this.loaded, new Promise((r) => setTimeout(r, 20000))]);
    if (this.failed) throw new McpToolError(`${this.entry.path} could not be opened: ${this.failed}.`);
    if (!this.session.doc) throw new McpToolError(`${this.entry.path} could not be opened in time. Try again.`);
    return this.session.doc;
  }

  /** Commit and wait until the server has taken it. */
  async commit(changes: ItemChange[]): Promise<void> {
    if (!this.session.status.canEdit) throw new McpToolError(`This person cannot edit ${this.entry.path}.`);
    if (!this.session.commit(changes, { undoable: false })) return;
    const until = Date.now() + 15000;
    while (this.session.unsaved && Date.now() < until) await new Promise((r) => setTimeout(r, 15));
    if (this.session.unsaved) throw new McpToolError("The edit was made but the server has not confirmed it yet. Read the document again before changing more.");
  }

  close(): void { this.session.close(); }
}

export interface Built { k: Kernel; engine: RegenEngine; result: RegenResult }

export class OpenStudio extends OpenDoc {
  engine: RegenEngine | null = null;
  /** the boards of the studio's Board features, read over the same socket route (board/feed.ts) */
  private readonly boards: BoardFeed;

  constructor(entry: McpDocEntry, req: McpRequest) {
    super(entry, req, PART_STUDIO_KIND);
    this.boards = new BoardFeed({ signedIn: true, changed: () => {}, socket: { socketUrl: req.base.replace(/^http/, "ws") + "/ws", fetchTicket: async () => this.conn.token, WebSocketImpl: this.socket() } });
  }

  /** Rebuild a document (the live one, or a planned one for a dry run) and say what came of it. */
  async regen(doc: ItemDoc): Promise<Built> {
    const k = await kernel();
    if (!this.engine) this.engine = new RegenEngine(k, FEATURES);
    acting = { base: this.conn.base, token: this.conn.token };
    // as the studio's own page builds it (document/inputs.ts): variables applied, the Board features' boards supplied
    studioInputs(doc, { filters: [this.boards.filter] });   // opens the boards it names
    await this.boards.settled(15000);
    const input = studioInputs(doc, { filters: [this.boards.filter] });
    const result = await this.engine.regenerate(input.features, input.rollback);
    return { k, engine: this.engine, result };
  }

  override close(): void { super.close(); this.boards.close(); if (this.engine) this.engine.dispose(); this.engine = null; }
}

const open = new Map<string, OpenStudio>();

export function needProject(req: McpRequest): McpProject { if (!req.project) throw new McpToolError("This tool needs a project."); return req.project; }
export function needWrite(req: McpRequest, p: McpProject): void {
  if (!req.canWrite) throw new McpToolError("This connection was allowed to read only.");
  if (p.role !== "editor") throw new McpToolError(`This person can only view "${p.name}". To change it they need the owner to give them the editor role.`);
}
const baseName = (p: string) => p.split("/").pop() || p;

/** A document of the project by what an assistant calls it: its path, its id, its file name, or the name without the extension. */
export function findDocument(p: McpProject, name: unknown, types: readonly string[], what: string, none: string): McpDocEntry {
  const docs = p.docs.filter((d) => types.includes(d.docType));
  const listed = () => docs.map((d) => d.path).join(", ") || none;
  if (typeof name !== "string" || !name.trim()) {
    if (docs.length === 1) return docs[0];
    throw new McpToolError(`Say which ${what} (document): ${listed()}.`);
  }
  const q = name.trim().toLowerCase(), stem = (s: string) => s.replace(/\.(jpart|jasm)$/, "");
  const exact = docs.find((d) => d.path.toLowerCase() === q) || docs.find((d) => d.docId === q) || docs.find((d) => baseName(d.path).toLowerCase() === q);
  if (exact) return exact;
  const loose = docs.filter((d) => stem(baseName(d.path).toLowerCase()) === stem(q));
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) throw new McpToolError(`"${name}" could be ${loose.map((d) => d.path).join(" or ")}. Give the path with its extension.`);
  throw new McpToolError(`There is no ${what} "${name}" in ${p.name}. There ${docs.length === 1 ? "is" : "are"}: ${listed()}.`);
}

const NO_STUDIO = "(none; cad_create_part_studio makes one)";
function findStudio(p: McpProject, name: unknown): McpDocEntry { return findDocument(p, name, [DOC_TYPE], "part studio", NO_STUDIO); }

/** The open part studio of a document entry (opened on first use, kept while it is used). */
export function studioOf(req: McpRequest, entry: McpDocEntry): OpenStudio {
  let s = open.get(entry.docId);
  if (!s) { s = new OpenStudio(entry, req); open.set(entry.docId, s); }
  s.conn = { base: req.base, token: req.token, agent: req.agent }; s.lastUsed = Date.now();
  return s;
}
async function studio(req: McpRequest): Promise<OpenStudio> { return studioOf(req, findStudio(needProject(req), req.args && req.args.document)); }

// ---------------------------------------------------------------- what the kernel says

const round = (v: number, digits = 4): number => { const m = Math.pow(10, digits); return Math.round(v * m) / m; };

/** Run one of the kernel's services (kernel/service.ts) on a studio's model as last built. */
export async function service(b: Built, name: string, args: any): Promise<any> {
  const svc = SERVICES.find((s) => s.name === name);
  if (!svc) throw new McpToolError(`This server's kernel has no "${name}" service.`);
  const k = b.k, mine: { delete(): void }[] = []; k.scope = mine;
  try { return await svc.run({ oc: k.oc, k, state: b.engine.state, fail: (t) => new McpToolError(t), before: (id) => b.engine.before(id) }, args); }
  catch (e) { if (e instanceof McpToolError) throw e; throw new McpToolError(e instanceof Error && e.message ? e.message : k.describe(e)); }
  finally { k.scope = null; for (const o of mine.reverse()) { try { o.delete(); } catch (x) { /* gone */ } } }
}

/** The bodies as an edit may name them, with the meshes picks are resolved on. */
function knownBodies(doc: ItemDoc, b: Built): KnownBody[] {
  const names = partNamesOf(doc);
  return b.engine.state.bodies.map((x) => ({ id: x.id, name: names[x.id] || x.name, createdBy: x.createdBy, mesh: b.result.bodies.find((r) => r.id === x.id)?.mesh }));
}

function bodiesOf(doc: ItemDoc, b: Built, o: { names?: boolean; brief?: boolean } = {}, mass?: any): any[] {
  const names = partNamesOf(doc);
  const parts: any[] = (mass && mass.parts) || [];
  return b.engine.state.bodies.map((body) => {
    const out: any = { id: body.id, name: names[body.id] || body.name, created_by: body.createdBy, ...(body.sheet ? { surface: true } : {}), ...(body.reference ? { reference: true } : {}) };
    const mesh = b.result.bodies.find((x) => x.id === body.id)?.mesh;
    if (mesh) out.bbox_mm = { min: [0, 1, 2].map((i) => round(mesh.bbox[i])), max: [3, 4, 5].map((i) => round(mesh.bbox[i])) };
    const m = parts.find((x) => x.id === body.id);
    if (m) {
      out.volume_mm3 = round(m.volume, 3);
      if (!o.brief) { out.area_mm2 = round(m.area, 3); out.centre_of_mass = (m.centre as number[]).map((v) => round(v)); }
      const mat = materialOf(doc, body.id);
      if (mat) { out.material = mat.name; if (typeof m.mass === "number") out.mass_g = round(m.mass * 1000, 3); }
    } else if (!mass) out.mass_properties = "not available";
    if (o.brief) return out;
    out.faces = body.topo.faces.length; out.edges = body.topo.edges.length;
    if (o.names) { out.face_names = body.topo.faces.map((f) => f.name); out.edge_names = body.topo.edges.map((f) => f.name); }
    return out;
  });
}

async function massOf(doc: ItemDoc, b: Built): Promise<any> {
  try { return await service(b, "mass-properties", { bodies: null, density: densities(doc) }); } catch (e) { return null; }
}

/**
 * Keep only the asked keys of each row of a list (`fields`), so a big read costs what is needed of it.  The row's
 * name always stays.  A key no row has is refused with the keys there are.
 */
export function pickFields(rows: any[], fields: unknown, what: string): any[] {
  if (fields === undefined || fields === null) return rows;
  if (!Array.isArray(fields) || !fields.length || !fields.every((f) => typeof f === "string")) throw new McpToolError(`fields is a list of the keys to keep of each ${what}, for example ["name", "status"].`);
  const known = new Set<string>(); for (const r of rows) for (const k of Object.keys(r)) known.add(k);
  const odd = (fields as string[]).filter((f) => rows.length && !known.has(f));
  if (odd.length) throw new McpToolError(`A ${what} has no ${odd.map((f) => `"${f}"`).join(", ")}. Its keys are: ${Array.from(known).join(", ")}.`);
  const keep = new Set<string>(["name", ...(fields as string[])]);
  return rows.map((r) => { const o: any = {}; for (const k of Object.keys(r)) if (keep.has(k)) o[k] = r[k]; return o; });
}

/** What to try when a feature fails with this message. */
export function hintFor(message: string, type: string): string {
  const m = message.toLowerCase();
  if (/no longer exists|was lost|is gone|not found|cannot be found/.test(m)) return "What it referred to is gone (a face removed upstream, or a sketch redrawn). Find the new face or edge with cad_find_geometry and set the reference again; a pick ({ kind, body, pick }) does it in one edit.";
  if (/closed region|closed loop|no region|open/.test(m)) return "The sketch must enclose a region. cad_get_features { feature: <the sketch> } says how many regions it has; close the outline or use rectangle, circle or polygon.";
  if (/must be flat|not flat|planar/.test(m)) return "It needs a flat face: cad_find_geometry { kind: \"face\", pick: { type: \"plane\" } } lists them.";
  if (/suppressed|rolled|not built|comes after|above it/.test(m)) return "It uses a feature that is not built before it: unsuppress that feature, or move this one below it (op \"move\").";
  if (/nothing to (cut|remove)|does not (touch|meet|intersect)|no material|misses|outside/.test(m)) return "The tool does not meet the part. Try flip: true, check the depth, and look where the sketch is with cad_render_view.";
  if (/radius|too large|too big|too small|thickness/.test(m)) return "The size does not fit the geometry: try a smaller value (a fillet radius must be below the neighbouring face widths, a shell thickness below half the thinnest wall).";
  if (/broken|not sound|invalid|self-intersect/.test(m)) return "The result would not be a sound solid. Change the size, or build the shape another way (for instance two simpler features).";
  return `Read it with cad_get_features { feature } and compare with cad_feature_types { type: "${type}" }.`;
}

function problemsOf(doc: ItemDoc, result: RegenResult): string[] {
  const features = featuresOf(doc);
  return result.features.filter((r) => r.status === "error" || r.status === "warning").map((r) => {
    const f = features.find((x) => x.id === r.id);
    return `${f?.name || r.id}: ${r.status === "error" ? "failed" : "note"}: ${r.message || ""}` + (r.status === "error" ? ` Hint: ${hintFor(r.message || "", f?.featureType || "")}` : "");
  });
}

interface ReportOptions { entities?: boolean; names?: boolean; compact?: boolean; only?: string; offset?: number; limit?: number; bodies?: boolean; brief?: boolean }

async function report(s: OpenStudio, doc: ItemDoc, o: ReportOptions = {}): Promise<any> {
  let built: Built;
  try { built = await s.regen(doc); }
  catch (e) { if (!(e instanceof McpToolError)) throw e; return { ...treeOf(doc, null, o), kernel: e.message }; }
  const errors = problemsOf(doc, built.result);
  const out: any = { ...treeOf(doc, built.result.features, o) };
  if (o.bodies !== false) out.bodies = bodiesOf(doc, built, { names: !!o.names, brief: !!o.brief }, await massOf(doc, built));
  out.problems = errors.length ? errors : undefined;
  out.rebuild_ms = built.result.ms;
  return out;
}

// ---------------------------------------------------------------- scenes: what the looking and checking tools work on

export interface ScenePart {
  /** what a `part` argument names it by: a body's id, an instance's id */
  id: string;
  name: string;
  /** the body's id in its own part studio (what a reference's `body` is) */
  body: string;
  mesh: BodyMesh;
  /** the kernel's shape, in its own space; null when this host cannot build it */
  shape: Shape | null;
  /** where it stands: the rows of a 3 x 4 matrix, or null for "as it is" */
  transform: number[] | null;
  /** parts that move as one (the pieces of one instance) share an owner: they are not checked against each other */
  owner: string;
  /** the colour a person gave the part (0xRRGGBB); without one the picture takes the next of its palette, so neighbours can be told apart */
  color?: number;
  /** g/cm3, when it has a material */
  density?: number | null;
  material?: string;
  /** the feature that made it, in a part studio */
  createdBy?: string;
}
export interface Scene {
  document: string;
  kind: string;
  k: Kernel | null;
  parts: ScenePart[];
  problems: string[];
  /** lines for cad_describe after the parts (a part studio's features, an assembly's mates) */
  notes: string[];
  /** how a part is named in an argument: "body" in a part studio, "instance" in an assembly */
  partWord: string;
  /** a face, edge or vertex of a part as this kind of document refers to it */
  refOf(part: ScenePart, kind: GeoKind, name: string): any;
  /** exact quantities of named geometry from the kernel (the "measure" service), where the document has one model */
  exact?(refs: { kind: GeoKind; body: string; name: string }[]): Promise<any>;
}
export interface SceneKind {
  docType: string;
  what: string;
  scene(req: McpRequest, entry: McpDocEntry, o: { args: any }): Promise<Scene>;
}

const SCENE_KINDS: SceneKind[] = [];
export function addSceneKind(k: SceneKind): void { if (!SCENE_KINDS.some((x) => x.docType === k.docType)) SCENE_KINDS.push(k); }

const hex = (c: unknown): number | undefined => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? parseInt(c.slice(1), 16) : undefined);

/** A part studio's scene from a build of it: its bodies where they are. */
export function studioParts(doc: ItemDoc, b: Built): ScenePart[] {
  const names = partNamesOf(doc), looks = looksOf(doc), dens = densities(doc);
  const out: ScenePart[] = [];
  for (const body of b.engine.state.bodies) {
    const mesh = b.result.bodies.find((x) => x.id === body.id)?.mesh;
    if (!mesh) continue;
    const mat = materialOf(doc, body.id);
    out.push({ id: body.id, name: names[body.id] || body.name, body: body.id, mesh, shape: body.shape, transform: null, owner: body.id, color: hex(looks[body.id]?.color), density: dens[body.id] ?? null, material: mat?.name, createdBy: body.createdBy });
  }
  return out;
}

addSceneKind({
  docType: DOC_TYPE, what: "part studio",
  async scene(req, entry) {
    const s = studioOf(req, entry), doc = await s.doc(), built = await s.regen(doc);
    const features = featuresOf(doc), by = new Map(built.result.features.map((r) => [r.id, r]));
    return {
      document: entry.path, kind: "part studio", k: built.k, parts: studioParts(doc, built), problems: problemsOf(doc, built.result), partWord: "body",
      notes: [`Features (${features.length}), in build order: ` + (features.map((f) => describeFeature(FEATURES.find((d) => d.type === f.featureType), f, by.get(f.id)?.status, by.get(f.id)?.message)).join("; ") || "none yet"),
        ...(variablesJson(doc).length ? ["Variables: " + variablesJson(doc).map((v) => `${v.name} = ${v.expr}${v.value !== undefined && String(v.value) !== v.expr ? ` (${v.value})` : ""}`).join(", ")] : [])],
      refOf: (part, kind, name) => ({ kind, body: part.body, name }),
      exact: (refs) => service(built, "measure", { items: refs }),
    };
  },
});

async function sceneOf(req: McpRequest): Promise<Scene> {
  const p = needProject(req);
  const entry = findDocument(p, req.args && req.args.document, SCENE_KINDS.map((k) => k.docType), "part studio or assembly", "(none; cad_create_part_studio or cad_create_assembly makes one)");
  const kind = SCENE_KINDS.find((k) => k.docType === entry.docType)!;
  return kind.scene(req, entry, { args: req.args || {} });
}

/** The parts an argument names (ids or names; a part studio's body also by the feature that made it). */
function partsNamed(scene: Scene, key: unknown, what = scene.partWord): ScenePart[] {
  const list = Array.isArray(key) ? key : [key];
  const out: ScenePart[] = [];
  for (const k of list) {
    if (typeof k !== "string" || !k) throw new McpToolError(`${what} is a ${scene.partWord}'s id or name. There ${scene.parts.length === 1 ? "is" : "are"}: ${scene.parts.map((x) => x.name).join(", ") || "(none)"}.`);
    const low = k.toLowerCase();
    const hit = scene.parts.filter((x) => x.id === k || x.owner === k || x.name.toLowerCase() === low || x.createdBy === k);
    if (!hit.length) throw new McpToolError(`There is no ${scene.partWord} "${k}" in ${scene.document}. There ${scene.parts.length === 1 ? "is" : "are"}: ${Array.from(new Set(scene.parts.map((x) => x.name))).join(", ") || "(none)"}.`);
    out.push(...hit);
  }
  return Array.from(new Set(out));
}

/** A part's mesh where it stands (an instance's in assembly space): what picks and measurements read. */
const meshCache = new WeakMap<BodyMesh, Map<string, BodyMesh>>();
export function standingMesh(part: Pick<ScenePart, "mesh" | "transform">): BodyMesh {
  const t = part.transform;
  if (!t) return part.mesh;
  const key = t.map((v) => Math.round(v * 1e6)).join(",");
  let by = meshCache.get(part.mesh);
  if (!by) { by = new Map(); meshCache.set(part.mesh, by); }
  let m = by.get(key);
  if (!m) {
    const move = (src: Float32Array, w: number): Float32Array => {
      const out = new Float32Array(src.length);
      for (let i = 0; i + 2 < src.length; i += 3) { const x = src[i], y = src[i + 1], z = src[i + 2]; out[i] = t[0] * x + t[1] * y + t[2] * z + w * t[3]; out[i + 1] = t[4] * x + t[5] * y + t[6] * z + w * t[7]; out[i + 2] = t[8] * x + t[9] * y + t[10] * z + w * t[11]; }
      return out;
    };
    m = { ...part.mesh, positions: move(part.mesh.positions, 1), normals: move(part.mesh.normals, 0), edges: { ...part.mesh.edges, positions: move(part.mesh.edges.positions, 1) }, vertices: { ...part.mesh.vertices, positions: move(part.mesh.vertices.positions, 1) }, bbox: placedBox(part.mesh, t) as BodyMesh["bbox"] };
    if (by.size > 8) by.clear();
    by.set(key, m);
  }
  return m;
}

/** A reference or a pick in an argument, found on the scene: { kind, body | instance | part, name | pick }. */
function geometryNamed(scene: Scene, v: any, what: string): { part: ScenePart; kind: GeoKind; name: string }[] {
  if (!v || typeof v !== "object" || !["face", "edge", "vertex"].includes(v.kind)) throw new McpToolError(`${what} is { kind: "face" | "edge" | "vertex", ${scene.partWord}, name } or { kind, ${scene.partWord}, pick } (cad_find_geometry gives them).`);
  const key = v[scene.partWord] ?? v.part ?? v.body ?? v.instance;
  const parts = key === undefined || key === null || key === "" ? (scene.parts.length === 1 ? scene.parts : null) : partsNamed(scene, key);
  if (!parts) throw new McpToolError(`${what}: say which ${scene.partWord}: ${scene.parts.map((x) => x.name).join(", ")}.`);
  const out: { part: ScenePart; kind: GeoKind; name: string }[] = [];
  let last: PickError | null = null;
  for (const part of parts) {
    try { for (const g of pickGeometry(standingMesh(part), v.kind, v.pick !== undefined ? v.pick : v.name)) out.push({ part, kind: v.kind, name: g.name }); }
    catch (e) { if (!(e instanceof PickError)) throw e; last = e; }
  }
  if (!out.length) throw new McpToolError(`${what}: ${last ? last.message : "nothing matches."}`);
  return out;
}

// ---------------------------------------------------------------- exact answers about placed parts

const brepText = new WeakMap<object, { key: string; brep: string; bbox: number[] }>();
let brepSeq = 0;
/** A part as the kernel's interference and clearance services take it: BRep text under a key that names the shape. */
function placedShape(k: Kernel, part: ScenePart): { key: string; brep: string; transform: number[] | null } {
  let t = brepText.get(part.shape as object);
  if (!t) { t = { key: `mcp:${++brepSeq}:${part.body}`, brep: brepOf(k, part.shape as Shape), bbox: [] }; brepText.set(part.shape as object, t); }
  return { key: t.key, brep: t.brep, transform: part.transform };
}

/** An engine-less kernel call: the services that take their shapes as arguments (interference, clearance). */
async function kernelCall(k: Kernel, name: string, args: any): Promise<any> {
  const svc = SERVICES.find((s) => s.name === name);
  if (!svc) throw new McpToolError(`This server's kernel has no "${name}" service.`);
  const mine: { delete(): void }[] = []; k.scope = mine;
  try { return await svc.run({ oc: k.oc, k, state: { bodies: [], sketches: {} }, fail: (t) => new McpToolError(t) }, args); }
  catch (e) { if (e instanceof McpToolError) throw e; throw new McpToolError(e instanceof Error && e.message ? e.message : k.describe(e)); }
  finally { k.scope = null; for (const o of mine.reverse()) { try { o.delete(); } catch (x) { /* gone */ } } }
}

const boxesMeet = (a: number[], b: number[], gap = 0): boolean => a[0] <= b[3] + gap && b[0] <= a[3] + gap && a[1] <= b[4] + gap && b[1] <= a[4] + gap && a[2] <= b[5] + gap && b[2] <= a[5] + gap;

/** Which parts of a scene overlap, and by how much (mm3), exact. */
export async function interferenceOf(scene: Scene, only?: ScenePart[]): Promise<{ clashes: any[]; checked: number; skipped: string[] }> {
  const parts = (only || scene.parts).filter((p) => p.shape), k = scene.k;
  const skipped = (only || scene.parts).filter((p) => !p.shape).map((p) => p.name);
  if (!k || parts.length < 2) return { clashes: [], checked: 0, skipped };
  const boxes = parts.map((p) => placedBox(p.mesh, p.transform));
  const pairs: [number, number][] = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (parts[i].owner !== parts[j].owner && boxesMeet(boxes[i], boxes[j])) pairs.push([i, j]);
  if (!pairs.length) return { clashes: [], checked: 0, skipped };
  const r = await kernelCall(k, "interference", { shapes: parts.map((p) => placedShape(k, p)), pairs });
  const clashes = (r.clashes || []).map((c: any) => ({ a: parts[c.a].name, b: parts[c.b].name, volume_mm3: c.volume === null ? null : round(c.volume, 4), ...(c.centre ? { at: c.centre.map((v: number) => round(v, 3)) } : {}), ...(c.error ? { error: c.error } : {}) }));
  return { clashes, checked: r.checked || pairs.length, skipped };
}

/** The smallest gap between two parts (0: they touch or overlap), and where it is. */
export async function clearanceOf(scene: Scene, a: ScenePart, b: ScenePart): Promise<{ distance_mm: number | null; from?: number[]; to?: number[] }> {
  if (!scene.k || !a.shape || !b.shape) return { distance_mm: null };
  const r = await kernelCall(scene.k, "clearance", { shapes: [placedShape(scene.k, a), placedShape(scene.k, b)], pairs: [[0, 1]] });
  const x = r.results && r.results[0];
  if (!x || x.distance === null || x.distance === undefined) return { distance_mm: null };
  return { distance_mm: round(x.distance, 4), from: (x.pa || []).map((v: number) => round(v, 3)), to: (x.pb || []).map((v: number) => round(v, 3)) };
}

/** Volume, mass and centre of a scene's parts where they stand (exact; mass where there is a material). */
function massOfScene(scene: Scene): { parts: any[]; total: any } {
  const k = scene.k, out: any[] = [];
  let volume = 0, mass = 0, known = true; const c = [0, 0, 0]; let weight = 0;
  for (const p of scene.parts) {
    const row: any = { name: p.name };
    if (k && p.shape) {
      const oc = k.oc as any, g = new oc.GProp_GProps();
      try {
        oc.BRepGProp.VolumeProperties(p.shape, g, true, false, false);
        const v = g.Mass(), cm = g.CentreOfMass(), local = [cm.X(), cm.Y(), cm.Z()]; cm.delete();
        const t = p.transform, at = t ? [0, 1, 2].map((r) => t[r * 4] * local[0] + t[r * 4 + 1] * local[1] + t[r * 4 + 2] * local[2] + t[r * 4 + 3]) : local;
        row.volume_mm3 = round(v, 3); row.centre_of_mass = at.map((x) => round(x, 3));
        volume += v;
        const m = typeof p.density === "number" ? (v * p.density) / 1000 : null;   // g/cm3 × mm3 / 1000 = g
        if (m !== null) { row.mass_g = round(m, 3); row.material = p.material; mass += m; } else known = false;
        const w = m !== null ? m : v; weight += w; for (let i = 0; i < 3; i++) c[i] += at[i] * w;
      } finally { g.delete(); }
    } else known = false;
    out.push(row);
  }
  const total: any = { parts: scene.parts.length, volume_mm3: round(volume, 3) };
  if (known && scene.parts.length) total.mass_g = round(mass, 3); else if (scene.parts.length) total.mass_note = `Not every ${scene.partWord} has a material, so there is no total mass. Give each part one in its part studio: cad_edit_features { op: "set_part", body, material }.`;
  if (weight > 0) total.centre_of_mass = c.map((x) => round(x / weight, 3));
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of scene.parts) { const b = placedBox(p.mesh, p.transform); for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], b[i]); hi[i] = Math.max(hi[i], b[i + 3]); } }
  if (scene.parts.length) total.bbox_mm = { min: lo.map((v) => round(v, 3)), max: hi.map((v) => round(v, 3)), size: [0, 1, 2].map((i) => round(hi[i] - lo[i], 3)) };
  return { parts: out, total };
}

// ---------------------------------------------------------------- the tools: reading

async function featureTypesTool(req: McpRequest): Promise<McpReply> {
  const a = req.args || {};
  if (a.detail === "full" && !a.query && !a.family && !a.type) return { result: featureTypes(FEATURES) };
  const r = featureCatalog(FEATURES, a);
  if (r.error) throw new McpToolError(r.error);
  return { result: r.result };
}

async function referenceTool(req: McpRequest): Promise<McpReply> {
  const topic = typeof req.args.topic === "string" ? req.args.topic : "";
  if (topic === "features") return { result: catalogText(FEATURES) };
  const text = topic ? reference(topic) : null;
  if (!text) throw new McpToolError(`topic is one of ${referenceTopics().map((t) => `"${t.topic}" (${t.title})`).join(", ")}, or "features" (every feature type, one line each).`);
  return { result: text };
}

async function getFeatures(req: McpRequest): Promise<McpReply> {
  const s = await studio(req), doc = await s.doc(), a = req.args || {};
  if (typeof a.feature === "string" && a.feature) {
    const features = featuresOf(doc), low = a.feature.toLowerCase();
    const f = features.find((x) => x.id === a.feature) || features.find((x) => x.name.toLowerCase() === low);
    if (!f) throw new McpToolError(`There is no feature "${a.feature}" in ${s.entry.path}. The features are: ${features.map((x) => x.name).join(", ") || "(none)"}.`);
    const r = await report(s, doc, { only: f.id, bodies: false });
    const row = r.features[0];
    if (f.featureType === "sketch" && f.params.sketch) row.sketch = sketchReport(f.params.sketch as SketchData, await solver()).report;
    if (row && row.status === "error") row.hint = hintFor(row.message || "", f.featureType);
    const users = features.filter((x) => x.id !== f.id && JSON.stringify(x.params).includes(f.id)).map((x) => x.name);
    return { result: { document: s.entry.path, feature: row, ...(users.length ? { used_by: users } : {}), units: r.units } };
  }
  const many = featuresOf(doc).length > 40;
  const compact = a.compact === true || (a.compact === undefined && many && !a.limit);
  const r = await report(s, doc, { entities: a.entities === true, compact, offset: Number(a.offset) || 0, limit: Number(a.limit) || 0, bodies: a.bodies !== false, brief: compact });
  if (compact && a.compact === undefined) r.note = "The tree is long, so parameters are left out. Ask for one feature with feature, or a page with offset and limit.";
  r.features = pickFields(r.features, a.fields, "feature");
  return { result: { document: s.entry.path, ...r } };
}

async function getBodies(req: McpRequest): Promise<McpReply> {
  const s = await studio(req), doc = await s.doc();
  const built = await s.regen(doc);
  let bodies = bodiesOf(doc, built, { names: req.args.names === true }, await massOf(doc, built));
  if (typeof req.args.body === "string" && req.args.body) {
    let hit: KnownBody;
    try { hit = findBody(knownBodies(doc, built), req.args.body, featuresOf(doc), new Map(), partNamesOf(doc)); } catch (e) { throw new McpToolError(e instanceof Error ? e.message : String(e)); }
    bodies = bodies.filter((b) => b.id === hit.id);
  }
  const total = bodies.reduce((n, b) => n + (b.volume_mm3 || 0), 0);
  const out: any = { document: s.entry.path, units: "mm", count: bodies.length, total_volume_mm3: round(total, 3), bodies, problems: problemsOf(doc, built.result) };
  if (bodies.length && bodies.every((b) => typeof b.mass_g === "number")) out.total_mass_g = round(bodies.reduce((n, b) => n + b.mass_g, 0), 3);
  if (req.args.names === true) out.note = "Names are opaque. cad_find_geometry says what each face and edge is and finds them by description.";
  return { result: out };
}

async function findGeometry(req: McpRequest): Promise<McpReply> {
  const scene = await sceneOf(req), a = req.args || {};
  const kind: GeoKind = ["face", "edge", "vertex"].includes(a.kind) ? a.kind : "face";
  const key = a[scene.partWord] ?? a.part ?? a.body ?? a.instance;
  const parts = key === undefined || key === null || key === "" ? scene.parts : partsNamed(scene, key);
  if (!parts.length) return { result: { document: scene.document, count: 0, matches: [], note: `There is no ${scene.partWord} yet.`, problems: scene.problems.length ? scene.problems : undefined } };
  const matches: any[] = [];
  let last = "";
  for (const part of parts) {
    const mesh = standingMesh(part);
    try {
      // every match is listed here, best first (a pick written in a reference takes the first unless it says all)
      const every = typeof a.pick === "string" && a.pick.trim().toLowerCase() in SIDES ? { side: a.pick.trim().toLowerCase(), all: true } : a.pick && typeof a.pick === "object" && !Array.isArray(a.pick) ? { ...a.pick, all: true } : a.pick;
      const found = a.pick === undefined || a.pick === null ? summarise(mesh, kind).slice().sort((x, y) => (y.area || y.length || 0) - (x.area || x.length || 0)) : pickGeometry(mesh, kind, every);
      for (const g of found) matches.push({ ref: scene.refOf(part, kind, g.name), ...infoJson(g), name: undefined, ...(parts.length > 1 ? { [scene.partWord]: part.name } : {}) });
    } catch (e) { if (!(e instanceof PickError)) throw e; last = e.message; }
  }
  if (!matches.length && last) throw new McpToolError(last);
  const offset = Math.max(0, Math.round(Number(a.offset) || 0)), limit = Math.max(1, Math.min(200, Math.round(Number(a.limit) || 40)));
  const page = matches.slice(offset, offset + limit);
  const out: any = { document: scene.document, kind, count: matches.length, matches: page, units: "mm" + (scene.kind === "assembly" ? ", in assembly space as placed" : "") };
  if (offset + page.length < matches.length) { out.next_offset = offset + page.length; out.note = "More match than are listed: narrow the pick (type, side, nearest, of_face), or page with offset."; }
  if (scene.problems.length) out.problems = scene.problems;
  return { result: out };
}

// ---------------------------------------------------------------- the tools: editing

async function editFeatures(req: McpRequest): Promise<McpReply> {
  const p = needProject(req), s = await studio(req), doc = await s.doc(), a = req.args || {};
  const dry = a.dry_run === true;
  if (!dry) needWrite(req, p);
  const live = await s.regen(doc).catch((e) => { if (e instanceof McpToolError) return null; throw e; });
  const failedBefore = new Set(live ? live.result.features.filter((r) => r.status === "error").map((r) => r.id) : []);
  const plan = await planStaged(doc, FEATURES, a.edits, { solver: await solver(), bodies: live ? knownBodies(doc, live) : [] }, async (d) => {
    const built = await s.regen(d), features = featuresOf(d);
    return { bodies: knownBodies(d, built), failed: built.result.features.filter((r) => r.status === "error").map((r) => ({ name: features.find((f) => f.id === r.id)?.name || r.id, message: r.message || "" })) };
  });
  if (plan.problems.length) throw new McpToolError(`Nothing was changed. ${plan.problems.join("; ")}.`);
  const shape = (r: any): any => {
    // a long tree: only what was touched and what is not well, the rest counted
    if (a.report !== "full" && Array.isArray(r.features) && r.features.length > 40) {
      const all = r.features.length;
      r.features = r.features.filter((f: any) => plan.touched.includes(f.id) || (f.status !== "ok" && f.status !== "suppressed"));
      r.feature_count = all; r.note_features = "Only the features this call touched and those that are not ok are listed (report: \"full\" lists all).";
    }
    if (Object.keys(plan.sketches).length) r.sketches = plan.sketches;
    return r;
  };
  const sayNew = (r: any): string[] => (r.features || []).filter((f: any) => f.status === "error" && !failedBefore.has(f.id)).map((f: any) => `${f.name}: ${f.message || "failed"} Hint: ${hintFor(f.message || "", f.type)}`);
  if (dry || a.atomic === true) {
    const after = await report(s, plan.after, { compact: true, brief: true });
    const newly = sayNew(after);
    if (a.atomic === true && newly.length) throw new McpToolError(`Nothing was changed (atomic): the edits are valid but ${newly.length === 1 ? "a feature" : `${newly.length} features`} would fail to build. ${newly.join("; ")}`);
    if (dry) return { result: { document: s.entry.path, dry_run: true, would: plan.done, ...shape(after), would_fail: newly.length ? newly : undefined, note: "Nothing was changed. This is the part studio as it would be." } };
  }
  await s.commit(plan.changes);
  const after = await report(s, await s.doc(), { compact: true, brief: true });
  const title = plan.done.length === 1 ? plan.done[0] : `${plan.done.length} edits to ${baseName(s.entry.path)}`;
  const reply: McpReply = { result: { document: s.entry.path, applied: plan.done, ...shape(after) } };
  if (plan.changes.length) reply.record = { docId: s.entry.docId, title: title.slice(0, 200), edits: plan.done, undo: { domain: "mechanical", inverse: plan.inverse } };
  return reply;
}

/** Take back or put back a recorded change of any item document: what `undo` of a domain's table does. */
export async function undoRecorded(req: McpRequest, od: OpenDoc, after: () => Promise<any>, domain: string): Promise<McpReply> {
  const rec = req.args.__record as { docId: string; title: string; undo: { inverse: ItemChange[] } };
  const doc = await od.doc();
  const redo = req.tool === "redo_changes", word = redo ? "redone" : "undone";
  const { applied, inverse } = applyRecorded(doc, rec.undo.inverse || []);
  await od.commit(applied);
  return { result: { [word]: rec.title, document: od.entry.path, changes: applied.length, ...(await after()), note: redo ? "undo_changes takes it back again." : "redo_changes puts it back." }, swap: { domain, inverse } };
}

async function undo(req: McpRequest): Promise<McpReply> {
  const p = needProject(req); needWrite(req, p);
  const rec = req.args.__record as { docId: string };
  const entry = p.docs.find((d) => d.docId === rec.docId);
  if (!entry) throw new McpToolError("The document of that change is no longer in the project.");
  const s = studioOf(req, entry);
  return undoRecorded(req, s, async () => report(s, await s.doc(), { compact: true, brief: true }), "mechanical");
}

async function createStudio(req: McpRequest): Promise<McpReply> {
  const p = needProject(req); needWrite(req, p);
  const path = freePath(p, req.args.name, ".jpart", "Part Studio");
  await createDocument(req, p, path, newPartStudioText(), DOC_TYPE);
  return { result: { created: path, document: path, note: "An empty part studio. Add a sketch and an extrude with cad_edit_features (cad_reference topic \"guide\" has a part in one call)." } };
}

// ---------------------------------------------------------------- the tools: measuring and checking

async function measure(req: McpRequest): Promise<McpReply> {
  const scene = await sceneOf(req), a = req.args || {};
  const out: any = { document: scene.document, units: "mm, degrees" + (scene.kind === "assembly" ? "; positions in assembly space" : "") };
  if (Array.isArray(a.items) && a.items.length) {
    if (a.items.length > 12) throw new McpToolError("Measure at most 12 things in one call.");
    const found = a.items.flatMap((v: any, i: number) => geometryNamed(scene, v, `items[${i}]`));
    const infos = found.map((f: { part: ScenePart; kind: GeoKind; name: string }) => ({ f, g: summarise(standingMesh(f.part), f.kind).find((x) => x.name === f.name)! }));
    out.items = infos.map(({ f, g }: any) => ({ ref: scene.refOf(f.part, f.kind, f.name), ...infoJson(g), name: undefined }));
    if (infos.length === 2) {
      const [x, y] = infos.map((i: any) => i.g);
      const pair: any = {};
      const dir = (g: any): number[] | null => g.normal || g.axis || null;
      const dx = dir(x), dy = dir(y);
      const sub3 = (p: number[], q: number[]) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]], dot3 = (p: number[], q: number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2], len3 = (p: number[]) => Math.hypot(p[0], p[1], p[2]);
      pair.centre_distance = round(len3(sub3(x.at, y.at)));
      pair.offset = sub3(y.at, x.at).map((v) => round(v));
      if (dx && dy) {
        const c = Math.max(-1, Math.min(1, dot3(dx, dy)));
        const lineLike = !(x.normal && y.normal);
        pair.angle = round((Math.acos(lineLike ? Math.abs(c) : c) * 180) / Math.PI, 3);
        const parallel = Math.abs(Math.abs(c) - 1) < 1e-6;
        if (parallel && x.normal && y.normal) pair.plane_distance = round(Math.abs(dot3(sub3(y.at, x.at), x.normal)));
        else if (parallel && !x.normal && !y.normal) { const d = sub3(y.at, x.at), along = dot3(d, dx); pair.axis_distance = round(len3([d[0] - dx[0] * along, d[1] - dx[1] * along, d[2] - dx[2] * along])); }
        else if (parallel || Math.abs(c) < 1e-6) { const pl = x.normal ? x : y.normal ? y : null, o = pl === x ? y : x; if (pl && Math.abs(c) < 1e-6) pair.distance_to_plane = round(Math.abs(dot3(sub3(o.at, pl.at), pl.normal))); }
      } else if ((x.normal || y.normal)) { const pl = x.normal ? x : y, o = pl === x ? y : x; pair.distance_to_plane = round(Math.abs(dot3(sub3(o.at, pl.at), pl.normal))); }
      out.between = pair;
    }
    // the kernel's exact numbers where it can give them (one model: a part studio)
    if (scene.exact) {
      try {
        const ex = await scene.exact(found.map((f: { part: ScenePart; kind: GeoKind; name: string }) => ({ kind: f.kind, body: f.part.body, name: f.name })));
        (ex.items || []).forEach((e: any, i: number) => {
          const row = out.items[i]; if (!row) return;
          if (typeof e.area === "number") row.area = round(e.area); if (typeof e.length === "number") row.length = round(e.length);
          if (typeof e.radius === "number") row.radius = round(e.radius); if (typeof e.perimeter === "number") row.perimeter = round(e.perimeter);
        });
        if (ex.pair && out.between) {
          if (ex.pair.min) { out.between.min_distance = round(ex.pair.min.distance); out.between.nearest_points = [ex.pair.min.a.map((v: number) => round(v, 3)), ex.pair.min.b.map((v: number) => round(v, 3))]; }
          // two flat faces keep the angle between their normals (180: they face each other); a line has no sense, so 0 to 90
          if (typeof ex.pair.angle === "number" && !(infos[0].g.normal && infos[1].g.normal)) out.between.angle = round(ex.pair.angle, 3);
          if (typeof ex.pair.normalDistance === "number") out.between.parallel_distance = round(ex.pair.normalDistance);
        }
      } catch (e) { /* the estimates from the tessellation stand */ }
    }
    const area = infos.reduce((n: number, i: any) => n + (i.g.area || 0), 0), length = infos.reduce((n: number, i: any) => n + (i.g.kind === "edge" ? i.g.length || 0 : 0), 0);
    if (infos.length > 1 && area) out.total_area_mm2 = round(area);
    if (infos.length > 1 && length) out.total_length_mm = round(length);
  }
  if (Array.isArray(a.between) && a.between.length === 2) {
    const [pa, pb] = a.between.map((k: any) => partsNamed(scene, k, "between")[0]);
    if (pa === pb) throw new McpToolError(`between needs two different ${scene.partWord}s.`);
    out.clearance = { a: pa.name, b: pb.name, ...(await clearanceOf(scene, pa, pb)) };
    if (out.clearance.distance_mm === 0) out.clearance.note = "They touch or overlap: cad_check says by how much.";
  } else if (a.between !== undefined) throw new McpToolError(`between is two ${scene.partWord}s: [a, b] by name or id.`);
  if (!out.items && !out.clearance) {
    const m = massOfScene(scene);
    out[scene.partWord === "body" ? "bodies" : "instances"] = m.parts; out.total = m.total;
  }
  if (scene.problems.length) out.problems = scene.problems;
  return { result: out };
}

async function check(req: McpRequest): Promise<McpReply> {
  const scene = await sceneOf(req), a = req.args || {};
  const all = ["validity", "interference", "clearance", "thickness"];
  const want: string[] = Array.isArray(a.checks) && a.checks.length ? a.checks.map((c: any) => String(c).toLowerCase()) : ["validity", "interference"];
  const odd = want.filter((c) => !all.includes(c));
  if (odd.length) throw new McpToolError(`checks are any of ${all.join(", ")} (validity and interference when left out).`);
  const out: any = { document: scene.document, units: "mm" };
  const findings: string[] = [];
  if (want.includes("validity")) {
    out.validity = { ok: !scene.problems.some((p) => /: failed: /.test(p)), problems: scene.problems, [scene.partWord === "body" ? "bodies" : "instances"]: scene.parts.length };
    if (!scene.parts.length) findings.push("There is nothing built yet.");
    for (const p of scene.problems) if (/: failed: /.test(p)) findings.push(p);
  }
  if (want.includes("interference")) {
    const r = await interferenceOf(scene);
    out.interference = { clashes: r.clashes, pairs_checked: r.checked, ...(r.skipped.length ? { not_checked: r.skipped } : {}) };
    for (const c of r.clashes) findings.push(`${c.a} and ${c.b} overlap by ${c.volume_mm3 === null ? "an amount the kernel could not find" : c.volume_mm3 + " mm3"}.`);
  }
  if (want.includes("clearance")) {
    const limit = typeof a.min_clearance === "number" && a.min_clearance > 0 ? a.min_clearance : null;
    const parts = scene.parts.filter((p) => p.shape), pairs: any[] = [];
    const boxes = parts.map((p) => placedBox(p.mesh, p.transform));
    let n = 0;
    for (let i = 0; i < parts.length && n < 40; i++) for (let j = i + 1; j < parts.length && n < 40; j++) {
      if (parts[i].owner === parts[j].owner || !boxesMeet(boxes[i], boxes[j], limit ?? 5)) continue;
      n++;
      const c = await clearanceOf(scene, parts[i], parts[j]);
      if (c.distance_mm !== null) pairs.push({ a: parts[i].name, b: parts[j].name, ...c });
    }
    pairs.sort((x, y) => x.distance_mm - y.distance_mm);
    out.clearance = { pairs: pairs.slice(0, 20), note: `Pairs whose boxes come within ${limit ?? 5} mm of each other, nearest first; 0 means touching or overlapping.` };
    if (limit !== null) for (const c of pairs) if (c.distance_mm > 0 && c.distance_mm < limit) findings.push(`${c.a} and ${c.b} are ${c.distance_mm} mm apart, under the ${limit} mm asked for.`);
  }
  if (want.includes("thickness")) {
    const limit = typeof a.min_wall === "number" && a.min_wall > 0 ? a.min_wall : null;
    out.thickness = scene.parts.slice(0, 12).map((p) => {
      const t = minThickness(p.mesh);
      if (t && limit !== null && t.min < limit) findings.push(`${p.name} is ${t.min} mm thin near [${t.at.join(", ")}], under the ${limit} mm asked for.`);
      return t ? { [scene.partWord]: p.name, min_wall_mm: t.min, near: t.at, samples: t.samples } : { [scene.partWord]: p.name, min_wall_mm: null };
    });
    out.thickness_note = "An estimate by sampling straight through the material from points of the surface (in the part's own space); it finds thin walls, not every sliver.";
  }
  out.ok = findings.length === 0;
  out.findings = findings;
  return { result: out };
}

// ---------------------------------------------------------------- the tools: looking

const PALETTE = [0x9db4cf, 0xd3b58f, 0xa7c9a1, 0xcfa3b8, 0xb0a8d6, 0xc9c48f];
const SECTION_PLANES: { [k: string]: [number, number, number] } = { top: [0, 0, 1], front: [0, -1, 0], right: [1, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** The picture of a scene as cad_render_view asks for it.  `frames` gives each cell of a sheet its own placements. */
export function renderScene(scene: Scene, a: any, frames?: { transforms: (number[] | null)[]; label: string }[]): { png: string; info: any } {
  const viewNames = Object.keys(VIEWS);
  const viewOf = (v: any): ViewName | [number, number, number] => {
    if (Array.isArray(v) && v.length === 3 && v.every((x: any) => typeof x === "number" && Number.isFinite(x)) && Math.hypot(v[0], v[1], v[2]) > 1e-9) return v as [number, number, number];
    const name = String(v || "iso").toLowerCase();
    if (!(name in VIEWS)) throw new McpToolError(`view is one of ${viewNames.join(", ")}, or a direction to look along as [x, y, z].`);
    return name as ViewName;
  };
  let parts = scene.parts;
  const only = a[scene.partWord === "body" ? "bodies" : "instances"] ?? a.only;
  if (only !== undefined && only !== null && !(Array.isArray(only) && !only.length)) parts = partsNamed(scene, only, "only");
  const index = new Map(parts.map((p, i) => [p, i]));
  const o: RenderOptions = { edges: a.edges !== false, colors: parts.map((p, i) => p.color ?? PALETTE[i % PALETTE.length]), transforms: parts.map((p) => p.transform) };
  const info: any = {};
  if (a.zoom_to !== undefined && a.zoom_to !== null) {
    const targets = partsNamed(scene, a.zoom_to, "zoom_to");
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of targets) { const b = placedBox(p.mesh, p.transform); for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], b[i]); hi[i] = Math.max(hi[i], b[i + 3]); } }
    const pad = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 0.15;
    o.frame = [lo[0] - pad, lo[1] - pad, lo[2] - pad, hi[0] + pad, hi[1] + pad, hi[2] + pad];
    info.zoomed_to = targets.map((p) => p.name);
  }
  if (Array.isArray(a.highlight) && a.highlight.length) {
    const lit: NonNullable<RenderOptions["highlight"]> = [];
    a.highlight.slice(0, 40).forEach((h: any, i: number) => { for (const g of geometryNamed(scene, h, `highlight[${i}]`)) { const at = index.get(g.part); if (at !== undefined && g.kind !== "vertex") lit.push({ mesh: at, kind: g.kind, name: g.name }); } });
    o.highlight = lit; info.highlighted = lit.length;
  }
  if (a.section !== undefined && a.section !== null) {
    const sct = typeof a.section === "string" ? { plane: a.section } : a.section;
    const n = typeof sct.plane === "string" ? SECTION_PLANES[sct.plane.toLowerCase()] : Array.isArray(sct.normal) && sct.normal.length === 3 ? sct.normal : null;
    if (!n || !n.every((v: any) => typeof v === "number" && Number.isFinite(v)) || Math.hypot(n[0], n[1], n[2]) < 1e-9) throw new McpToolError("section is { plane: \"top\" | \"front\" | \"right\" (or \"x\", \"y\", \"z\"), offset?: mm, flip?: true }, or { normal: [x, y, z], point: [x, y, z] }: what lies on the side the normal points to is cut away.");
    const len = Math.hypot(n[0], n[1], n[2]), unit: [number, number, number] = [n[0] / len, n[1] / len, n[2] / len];
    let point: [number, number, number];
    if (Array.isArray(sct.point) && sct.point.length === 3) point = sct.point;
    else {
      // through the middle of what is drawn, moved along the normal by `offset`
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const p of parts) { const b = placedBox(p.mesh, p.transform); for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], b[i]); hi[i] = Math.max(hi[i], b[i + 3]); } }
      const mid = parts.length ? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] : [0, 0, 0], off = typeof sct.offset === "number" ? sct.offset : 0;
      point = [mid[0] + unit[0] * off, mid[1] + unit[1] * off, mid[2] + unit[2] * off];
    }
    const normal: [number, number, number] = sct.flip ? [-unit[0], -unit[1], -unit[2]] : unit;
    o.section = { point, normal };
    info.section = { point: point.map((v) => round(v, 3)), cut_away_side: normal };
  }
  const meshes = parts.map((p) => p.mesh);
  // a section with no view asked for is looked at from the side that was cut away, a little from above: the cut faces the camera
  let sectionView: [number, number, number] | null = null;
  if (o.section && a.view === undefined && !(Array.isArray(a.views) && a.views.length)) {
    const n = o.section.normal, iso = [-1, 1, -1], along = iso[0] * n[0] + iso[1] * n[1] + iso[2] * n[2];
    sectionView = [0, 1, 2].map((i) => -n[i] + 0.45 * (iso[i] - along * n[i])) as [number, number, number];
  }
  const many = Array.isArray(a.views) && a.views.length ? a.views.slice(0, 6).map(viewOf) : null;
  const cells = frames && frames.length ? frames.length : many ? many.length : 1;
  const width = Math.max(300, Math.min(cells > 1 ? 2000 : 1600, Math.round(Number(a.width_px) || (cells > 1 ? 1200 : 900))));
  let pic;
  if (frames && frames.length) {
    const v = viewOf(a.view);
    // every step of the motion framed alike: on all the steps together
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const f of frames) parts.forEach((p, i) => { const b = placedBox(p.mesh, f.transforms[i]); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b[k]); hi[k] = Math.max(hi[k], b[k + 3]); } });
    pic = renderSheet(meshes, frames.map(() => v), { ...o, width, frame: o.frame || (Number.isFinite(lo[0]) ? [...lo, ...hi] : undefined) }, (i) => ({ transforms: frames[i].transforms }));
    info.view = v; info.cells = frames.map((f) => f.label);
  } else if (many && many.length > 1) { pic = renderSheet(meshes, many, { ...o, width }); info.views = many; info.cells = "left to right, top to bottom: " + many.map((v: any) => (typeof v === "string" ? v : `[${v.join(", ")}]`)).join(", "); }
  else {
    const v = many ? many[0] : sectionView || viewOf(a.view);
    pic = renderMeshes(meshes, { ...o, width, height: Math.round(width * 0.75), ...(typeof v === "string" ? { view: v as ViewName } : { direction: v }) });
    info.view = v;
  }
  const png = encodePng(pic);
  info.image_px = [pic.width, pic.height];
  return { png: typeof W.Buffer !== "undefined" ? W.Buffer.from(png).toString("base64") : "", info };
}

async function renderView(req: McpRequest): Promise<McpReply> {
  const scene = await sceneOf(req), a = req.args || {};
  const frames = (scene as any).frames as { transforms: (number[] | null)[]; label: string }[] | undefined;
  const { png, info } = renderScene(scene, a, frames);
  const word = scene.partWord === "body" ? "bodies" : "instances";
  return {
    result: { document: scene.document, ...info, [word]: Array.from(new Set(scene.parts.map((b) => b.name))), problems: scene.problems,
      note: scene.parts.length ? "Orthographic, framed on what is drawn. The triad in the corner is X red, Y green, Z blue (Z up)." : `There is nothing to draw yet.` },
    png,
  };
}

async function describe(req: McpRequest): Promise<McpReply> {
  const scene = await sceneOf(req);
  const m = massOfScene(scene);
  const lines: string[] = [];
  const word = scene.partWord === "body" ? "bodies" : "instances";
  const count = new Set(scene.parts.map((p) => p.owner)).size;
  lines.push(`${scene.document} (${scene.kind}): ${count} ${count === 1 ? scene.partWord : word}${count !== scene.parts.length ? ` (${scene.parts.length} parts)` : ""}` + (m.total.bbox_mm ? `, ${m.total.bbox_mm.size.join(" × ")} mm overall` : "") + (m.total.mass_g !== undefined ? `, ${m.total.mass_g} g` : "") + ".");
  scene.parts.slice(0, 40).forEach((p, i) => lines.push("- " + describePart(p.name, p.mesh, { transform: p.transform, volume: m.parts[i].volume_mm3, mass_g: m.parts[i].mass_g, material: p.material })));
  if (scene.parts.length > 40) lines.push(`- … and ${scene.parts.length - 40} more.`);
  lines.push(...scene.notes);
  if (scene.problems.length) lines.push("Problems: " + scene.problems.join(" | "));
  return { result: lines.join("\n") };
}

// ---------------------------------------------------------------- the tools: files out and in

const MIME: { [ext: string]: string } = { step: "model/step", stl: "model/stl", "3mf": "model/3mf", obj: "model/obj", glb: "model/gltf-binary", brep: "application/octet-stream", dxf: "image/vnd.dxf", svg: "image/svg+xml" };

async function exportTool(req: McpRequest): Promise<McpReply> {
  const p = needProject(req), a = req.args || {};
  const format = String(a.format || "step").toLowerCase().replace(/^\./, "").replace("stp", "step");
  if (!(format in MIME)) throw new McpToolError(`format is one of ${Object.keys(MIME).join(", ")} (dxf and svg are the outline of a flat face or a sketch).`);
  let data: Uint8Array, stem: string, extra: any = {};
  if (format === "dxf" || format === "svg") {
    const s = await studio(req), doc = await s.doc(), built = await s.regen(doc);
    let drawing;
    if (typeof a.sketch === "string" && a.sketch) {
      const features = featuresOf(doc), low = a.sketch.toLowerCase();
      const f = features.find((x) => x.id === a.sketch) || features.find((x) => x.name.toLowerCase() === low);
      if (!f || f.featureType !== "sketch") throw new McpToolError(`There is no sketch "${a.sketch}". The sketches are: ${features.filter((x) => x.featureType === "sketch").map((x) => x.name).join(", ") || "(none)"}.`);
      drawing = sketchDrawing(f.params.sketch as SketchData, f.name); stem = f.name;
    } else if (a.face) {
      const scene: Scene = { document: s.entry.path, kind: "part studio", k: built.k, parts: studioParts(doc, built), problems: [], notes: [], partWord: "body", refOf: (part, kind, name) => ({ kind, body: part.body, name }) };
      const found = geometryNamed(scene, { kind: "face", ...(typeof a.face === "object" ? a.face : { pick: a.face }) }, "face");
      const ref = { kind: "face" as const, body: found[0].part.body, name: found[0].name };
      const k = built.k, mine: { delete(): void }[] = []; k.scope = mine;
      try {
        const r = resolveRef(built.engine.state, ref), frame = k.faceFrame(r.shape as never);
        if (!frame) throw new McpToolError("That face is not flat. Pick a flat face (cad_find_geometry { pick: { type: \"plane\" } }), or export a sketch.");
        drawing = faceOutline(k, r.shape, frame);
      } finally { k.scope = null; for (const o of mine.reverse()) { try { o.delete(); } catch (x) { /* gone */ } } }
      stem = `${baseName(s.entry.path).replace(/\.jpart$/, "")} face`;
    } else throw new McpToolError(`A ${format} is the outline of one flat face or of a sketch: give face ({ kind: "face", body, name } or a pick such as "top") or sketch (a sketch's name).`);
    const unit = ["mm", "cm", "m", "in"].includes(a.unit) ? a.unit : "mm";
    const text = format === "dxf" ? writeDxf(drawing, unit) : writeSvg(drawing, unit);
    data = new W.TextEncoder().encode(text);
    extra = { curves: drawing.curves.length };
    if (text.length <= 12000 && a.inline !== false) extra.content = text;
  } else {
    const scene = await sceneOf(req);
    const key = a[scene.partWord === "body" ? "bodies" : "instances"] ?? a.only;
    const parts = (key === undefined || key === null || (Array.isArray(key) && !key.length) ? scene.parts : partsNamed(scene, key)).filter((x) => x.shape);
    const k = scene.k;
    if (!k || !parts.length) throw new McpToolError(scene.parts.length ? "None of those parts has a solid this host can write." : `There is nothing to export yet in ${scene.document}.`);
    stem = baseName(scene.document).replace(/\.(jpart|jasm)$/, "");
    const mine: { delete(): void }[] = []; k.scope = mine;
    const made: Shape[] = [];
    try {
      const names = new Map<string, number>();
      const list: ExportPart[] = parts.map((x) => {
        const n = (names.get(x.name) || 0) + 1; names.set(x.name, n);
        const shape = x.transform ? placed(k, x.shape as Shape, x.transform) : (x.shape as Shape);
        if (x.transform) made.push(shape);
        const c = x.color;
        return { id: x.id + ":" + n, name: n > 1 ? `${x.name} ${n}` : x.name, shape, color: c !== undefined ? [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255] : null };
      });
      const unit = ["mm", "cm", "m", "in"].includes(a.unit) ? a.unit : "mm";
      if (format === "step") data = writeStep(k, list, { schema: a.schema === "AP242" ? "AP242" : "AP214", unit });
      else if (format === "brep") data = writeBrep(k, list);
      else {
        const res = RESOLUTIONS[(["coarse", "medium", "fine"].includes(a.resolution) ? a.resolution : "medium") as keyof typeof RESOLUTIONS];
        const meshes: MeshPart[] = list.map((x) => meshOf(k, x.shape, res, x.name, x.color));
        extra.triangles = triangleCount(meshes);
        data = format === "stl" ? writeStlBinary(meshes) : format === "3mf" ? await write3mf(meshes, unit) : format === "obj" ? writeObj(meshes) : writeGlb(meshes);
      }
      extra.parts = list.map((x) => x.name);
    } catch (e) { if (e instanceof McpToolError) throw e; throw new McpToolError(`The ${format.toUpperCase()} file could not be written: ${e instanceof Error && e.message ? e.message : k.describe(e)}`); }
    finally { k.scope = null; for (const o of mine.reverse()) { try { o.delete(); } catch (x) { /* gone */ } } for (const s of made) { try { s.delete(); } catch (x) { /* gone */ } } }
    if (scene.problems.length) extra.problems = scene.problems;
  }
  const name = `${(typeof a.name === "string" && a.name.trim() ? a.name.trim() : stem).replace(/[\\/:*?"<>|]/g, "-").replace(/\.[a-z0-9]+$/i, "")}.${format}`;
  let stored: any;
  try { stored = await api(req, `/api/projects/${p.projectId}/exports?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: data }); }
  catch (e) { throw new McpToolError(`The file was written (${data.length} bytes) but could not be stored on the server: ${e instanceof Error ? e.message : String(e)}`); }
  const link = `${a.__site || req.base}${stored.path}`;
  return {
    result: { file: stored.name, format, size_kb: Math.round(stored.bytes / 102.4) / 10, download: link, resource: `junction://exports/${stored.id}`, kept_days: stored.keptDays, ...extra,
      note: "The download link opens for members of the project signed in to the site; an MCP client can read the same file as the resource (resources/read). Lengths are millimetres unless unit says otherwise." },
    links: [{ uri: `junction://exports/${stored.id}`, name: stored.name, mimeType: MIME[format] }],
  } as McpReply;
}

async function importTool(req: McpRequest): Promise<McpReply> {
  const p = needProject(req), a = req.args || {}; needWrite(req, p);
  let file: McpDocEntry | undefined, bytes = 0;
  if (typeof a.file === "string" && a.file.trim()) {
    const q = a.file.trim().toLowerCase();
    const models = p.docs.filter((d) => /\.(step|stp)$/i.test(d.path));
    file = models.find((d) => d.path.toLowerCase() === q) || models.find((d) => d.docId === q) || models.find((d) => baseName(d.path).toLowerCase() === q);
    if (!file) throw new McpToolError(`There is no STEP file "${a.file}" in ${p.name}. The STEP files are: ${models.map((d) => d.path).join(", ") || "(none; pass the file's text as content, or the person can drop a file on the project's Home tab)"}.`);
  } else if (typeof a.content === "string" && a.content.trim()) {
    const text = a.content;
    if (!/^\s*ISO-10303-21/.test(text)) throw new McpToolError("content must be the text of a STEP file: it starts with ISO-10303-21;");
    if (text.length > 8 * 1024 * 1024) throw new McpToolError("That STEP file is over 8 MB. The person can add it to the project themselves (drop it on the Home tab); then pass its path as file.");
    const stem = (typeof a.name === "string" && a.name.trim() ? a.name.trim() : "import").replace(/[\\/:*?"<>|]/g, "-").replace(/\.(step|stp)$/i, "");
    const taken = new Set(p.docs.map((d) => d.path.toLowerCase()));
    let path = `models/${stem}.step`; for (let n = 2; taken.has(path.toLowerCase()); n++) path = `models/${stem} ${n}.step`;
    file = await createDocument(req, p, path, text, "model3d"); bytes = text.length;
  } else throw new McpToolError("Give file (the path of a STEP file already in the project, as get_project lists it) or content (the text of a STEP file).");
  const stem = baseName(file.path).replace(/\.(step|stp)$/i, "");
  const path = freePath(p, typeof a.name === "string" && a.name.trim() ? a.name : uniqueStem(p, stem, ".jpart"), ".jpart", "Part Studio");
  const items: Item[] = [
    { id: "studio", type: "studio", units: "mm", rollback: null },
    { id: newId(), type: "feature", featureType: "import", name: stem, order: "V", params: { file: { docId: file.docId, path: file.path, name: baseName(file.path), ...(bytes ? { bytes } : {}), format: "step" }, split: a.split === "one" ? "one" : "solids" } } as Item,
  ];
  const entry = await createDocument(req, p, path, serializeItemDoc(newItemDoc(PART_STUDIO_KIND, items)), DOC_TYPE);
  const s = studioOf(req, entry);
  const after = await report(s, await s.doc(), { compact: true });
  return { result: { created: path, document: path, from: file.path, ...after, note: "The file's solids are bodies of this part studio: features can cut, fillet and sketch on them, and an assembly can place them (cad_edit_assembly op \"insert\")." } };
}

function uniqueStem(p: McpProject, stem: string, ext: string): string {
  const taken = new Set(p.docs.map((d) => d.path.toLowerCase()));
  if (!taken.has((stem + ext).toLowerCase())) return stem;
  for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}${ext}`.toLowerCase())) return `${stem} ${n}`;
}

export { addReference };

export const MECHANICAL_TOOLS: McpDomainTools = {
  domain: "mechanical",
  tools: {
    cad_feature_types: featureTypesTool,
    cad_reference: referenceTool,
    cad_get_features: getFeatures,
    cad_get_bodies: getBodies,
    cad_find_geometry: findGeometry,
    cad_edit_features: editFeatures,
    cad_measure: measure,
    cad_check: check,
    cad_render_view: renderView,
    cad_describe: describe,
    cad_export: exportTool,
    cad_import: importTool,
    cad_create_part_studio: createStudio,
  },
  undo,
  sweep(idleMs: number): void {
    const now = Date.now();
    for (const [id, s] of open) if (now - s.lastUsed > idleMs) { s.close(); open.delete(id); }
  },
};
