// mcp/script-host.ts — custom features for an outside agent: the cad_script_* tools of the MCP endpoint (the
// catalog entries are mcp/script-tools.json).  They are the editor's assistant loop with the agent in the model's
// place: read the guide and the API, read the project's library, check a script, run it on a part studio and
// get the same report (script/report.ts: errors with their line, warnings, volume before and after, whether the
// result is a sound solid, a picture), and write it to the project when it is right.
//
// Scripts run here exactly as they do in a browser's worker: in the QuickJS sandbox (script/sandbox.ts), never
// in this process's own JavaScript engine.  That matters more here than anywhere: this is the server.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { McpToolError, type McpDomainTools, type McpProject, type McpReply, type McpRequest } from "../../../platform/mcp/host";
import { SHELL_DOC_TYPE, SHELL_KIND } from "../../../platform/doctabs/elements";
import { ItemDocSession } from "../../../shared/itemdoc/sync";
import type { Item, ItemChange, JsonObject } from "../../../shared/itemdoc/itemdoc";
import { featuresOf, rollbackIndex, type FeatureItem } from "../document/format";
import * as edits from "../document/edits";
import { API_DTS, EXEMPLARS, PROMPTS } from "../generated/script-assets";
import { FEATURES, RegenEngine } from "../kernel/index";
import { freeName, saveScript, scriptsOf, type LibraryScript } from "../script/library";
import { MAX_SOURCE, SCRIPT_KEY, defaultsOf, definitionOf, sourceHash, type ScriptManifest } from "../script/manifest";
import { runReport } from "../script/report";
import { reportText } from "../script/report-text";
import { describeCached, sandboxOnce } from "../script/run";
import { kernel, studio } from "./host";

const W = globalThis as any;

// ---------------------------------------------------------------- the project's library (its own document)

class OpenLibrary {
  session: ItemDocSession | null = null;
  lastUsed = Date.now();
  private loaded: Promise<void> = Promise.resolve();
  constructor(readonly projectId: string) {}
  private open(docId: string, req: McpRequest): void {
    let ok!: () => void;
    this.loaded = new Promise<void>((r) => { ok = r; });
    this.session = new ItemDocSession({
      docId, signedIn: true, expectKind: SHELL_KIND,
      onChange: (ids) => { if (ids === null) ok(); }, onStatus: (s) => { if (s.state === "error") ok(); },
      socketUrl: req.base.replace(/^http/, "ws") + "/ws", fetchTicket: async () => req.token, WebSocketImpl: W.WebSocket,
    });
    this.session.start();
  }
  /** The library's items; with `make`, the project's document is created when the project has none yet. */
  async items(req: McpRequest, p: McpProject, make = false): Promise<Item[]> {
    this.lastUsed = Date.now();
    if (!this.session) {
      let id = p.docs.find((d) => d.docType === SHELL_DOC_TYPE)?.docId;
      if (!id && make) {
        const r = await W.fetch(`${req.base}/api/projects/${p.projectId}/shell`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${req.token}` }, body: "{}" });
        if (!r.ok) throw new McpToolError(`The project's library could not be made (${r.status}).`);
        id = (await r.json()).docId;
      }
      if (!id) return [];
      this.open(id, req);
    }
    await Promise.race([this.loaded, new Promise((r) => setTimeout(r, 20000))]);
    if (!this.session || !this.session.doc) throw new McpToolError("The project's library could not be opened in time. Try again.");
    return Array.from(this.session.doc.items.values());
  }
  async commit(changes: ItemChange[]): Promise<void> {
    const s = this.session;
    if (!s || !changes.length) return;
    if (!s.status.canEdit) throw new McpToolError("This person cannot change the project's custom features.");
    s.commit(changes, { undoable: false });
    const until = Date.now() + 15000;
    while (s.unsaved && Date.now() < until) await new Promise((r) => setTimeout(r, 15));
    if (s.unsaved) throw new McpToolError("The script was written but the server has not confirmed it yet. List the scripts again before changing more.");
  }
  close(): void { if (this.session) this.session.close(); this.session = null; }
}
const libraries = new Map<string, OpenLibrary>();
const libraryOf = (p: McpProject): OpenLibrary => { let l = libraries.get(p.projectId); if (!l) { l = new OpenLibrary(p.projectId); libraries.set(p.projectId, l); } return l; };

function needProject(req: McpRequest): McpProject { if (!req.project) throw new McpToolError("This tool needs a project."); return req.project; }
function needWrite(req: McpRequest, p: McpProject): void {
  if (!req.canWrite) throw new McpToolError("This connection was allowed to read only.");
  if (p.role !== "editor") throw new McpToolError(`This person can only view "${p.name}". To change it they need the owner to give them the editor role.`);
}
function findScript(scripts: LibraryScript[], want: unknown): LibraryScript {
  const q = typeof want === "string" ? want.trim().toLowerCase() : "";
  const hit = scripts.find((s) => s.id === want) || scripts.find((s) => s.name.toLowerCase() === q) || scripts.find((s) => s.manifest.title.toLowerCase() === q);
  if (!hit) throw new McpToolError(`There is no custom feature "${want}" in this project. They are: ${scripts.map((s) => s.name).join(", ") || "(none yet; cad_script_write adds one)"}.`);
  return hit;
}
const paramsOf = (m: ScriptManifest) => m.params.map((p) => ({ key: p.key, type: p.type, label: p.label, ...(p.default !== undefined ? { default: p.default } : {}), ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}), ...(p.options ? { options: p.options.map((o) => o.value) } : {}) }));

async function described(source: unknown): Promise<{ source: string; manifest: ScriptManifest | null; problems: { message: string; line?: number }[] }> {
  if (typeof source !== "string" || !source.trim()) throw new McpToolError("source must be the whole script, as text.");
  if (source.length > MAX_SOURCE) throw new McpToolError("The script is longer than 200 000 characters.");
  const d = describeCached(await sandboxOnce(), source);
  return { source, manifest: d.manifest, problems: d.problems };
}

// ---------------------------------------------------------------- the tools

async function guide(): Promise<McpReply> {
  return { result: { guide: PROMPTS.guide, api: { file: "feature-api.d.ts", text: API_DTS }, examples: EXEMPLARS.map((e) => ({ name: e.id, source: e.source })),
    how: "Write a script, check it with cad_script_validate, run it on a part studio with cad_script_run until the report and the picture are right (try the parameter values most likely to break it), then save it with cad_script_write. cad_script_run with add: true also puts the feature into the part studio." } };
}

async function list(req: McpRequest): Promise<McpReply> {
  const p = needProject(req);
  const scripts = scriptsOf(await libraryOf(p).items(req, p));
  return { result: { project: p.name, count: scripts.length, scripts: scripts.map((s) => ({ id: s.id, name: s.name, title: s.manifest.title, description: s.manifest.description, parameters: paramsOf(s.manifest), characters: s.source.length, version: s.hash })) } };
}

async function read(req: McpRequest): Promise<McpReply> {
  const p = needProject(req);
  const s = findScript(scriptsOf(await libraryOf(p).items(req, p)), req.args.script);
  return { result: { id: s.id, name: s.name, version: s.hash, parameters: paramsOf(s.manifest), source: s.source } };
}

async function validate(req: McpRequest): Promise<McpReply> {
  const d = await described(req.args.source);
  if (!d.manifest) return { result: { ok: false, problems: d.problems, note: "Nothing was built. Fix the declaration and validate again." } };
  return { result: { ok: true, title: d.manifest.title, description: d.manifest.description, parameters: paramsOf(d.manifest), note: "The script reads. cad_script_run builds it on a part studio." } };
}

/** Build a script as the next feature of the part studio the request names, on an engine of its own. */
async function trial(req: McpRequest, ref: { id: string; name: string; hash: string; source: string; manifest: ScriptManifest }, given: JsonObject | undefined) {
  if (given !== undefined && (!given || typeof given !== "object" || Array.isArray(given))) throw new McpToolError("params must be an object: { rib: 4, pattern: \"hex\" }.");
  const unknown = Object.keys(given || {}).filter((k) => !ref.manifest.params.some((x) => x.key === k));
  if (unknown.length) throw new McpToolError(`The script has no parameter ${unknown.map((k) => `"${k}"`).join(", ")}. Its parameters are: ${ref.manifest.params.map((x) => x.key).join(", ") || "(none)"}.`);
  const s = await studio(req), doc = await s.doc();
  const all = featuresOf(doc), at = rollbackIndex(doc, all);
  const def = definitionOf(ref, { toolbar: false });
  const candidate: FeatureItem = { id: "cf-try", type: "feature", featureType: def.type, name: ref.manifest.title, order: "", params: { ...def.defaults(), ...(given || {}) } };
  const input = await s.inputs(doc, { features: [...all.slice(0, at), candidate], rollback: at + 1 });
  const k = await kernel(), engine = new RegenEngine(k, FEATURES);
  try {
    const report = await runReport(k, engine, input.features, candidate.id, { image: req.args.picture === false ? false : { view: typeof req.args.view === "string" ? req.args.view : "iso", width: Math.max(300, Math.min(1400, Number(req.args.width_px) || 900)) }, density: typeof req.args.density === "number" ? req.args.density : undefined });
    return { s, doc, def, report };
  } finally { engine.dispose(); }
}

async function run(req: McpRequest): Promise<McpReply> {
  const p = needProject(req);
  let source = req.args.source, libScript: LibraryScript | null = null;
  if (typeof source !== "string" || !source.trim()) {
    if (req.args.script === undefined) throw new McpToolError("Give the script to run: source (the text), or script (the name of one in the project).");
    libScript = findScript(scriptsOf(await libraryOf(p).items(req, p)), req.args.script);
    source = libScript.source;
  }
  const d = await described(source);
  if (!d.manifest) return { result: { status: "error", error: { message: d.problems[0]?.message || "The script does not read.", line: d.problems[0]?.line }, problems: d.problems, note: "Nothing was built: the script's declaration does not read." } };
  const ref = { id: libScript ? libScript.id : `mcp-${sourceHash(d.source)}`, name: libScript ? libScript.name : d.manifest.title, hash: sourceHash(d.source), source: d.source, manifest: d.manifest };
  const t = await trial(req, ref, req.args.params);
  const png = t.report.png; delete t.report.png;
  return { result: { document: t.s.entry.path, script: ref.name, summary: reportText(t.report), ...t.report, note: "Nothing was changed: this was a trial. cad_script_write saves the script to the project, and with add_to puts the feature into a part studio." }, png };
}

async function write(req: McpRequest): Promise<McpReply> {
  const p = needProject(req); needWrite(req, p);
  const d = await described(req.args.source);
  if (!d.manifest) throw new McpToolError(`Nothing was written: the script does not read. ${d.problems.map((x) => x.message + (x.line ? ` (line ${x.line})` : "")).join(" ")}`);
  const lib = libraryOf(p), items = await lib.items(req, p, true), scripts = scriptsOf(items);
  const existing = req.args.script !== undefined ? findScript(scripts, req.args.script) : null;
  const name = typeof req.args.name === "string" && req.args.name.trim() ? req.args.name.trim().slice(0, 80) : existing ? existing.name : d.manifest.title;
  if (!existing && req.args.name !== undefined && scripts.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new McpToolError(`The project already has a custom feature called "${name}". Pass script: "${name}" to replace it, or another name.`);
  const r = saveScript(items, { id: existing ? existing.id : undefined, name: existing ? name : freeName(items, name), source: d.source, manifest: d.manifest });
  await lib.commit(r.changes);
  const saved = scriptsOf(await lib.items(req, p)).find((s) => s.id === r.id);
  const result: any = { written: saved ? saved.name : name, id: r.id, replaced: !!existing, parameters: paramsOf(d.manifest),
    note: existing ? "Features already made from the earlier version keep it; their rows in the feature list offer the update." : "It is in the Custom features drop-down of every part studio of the project, under This project." };
  if (req.args.add_to === undefined || !saved) return { result };
  // also a feature of a part studio: tried first, added only when it builds a sound result
  req.args.document = req.args.add_to;
  const t = await trial(req, saved, req.args.params);
  const png = t.report.png; delete t.report.png;
  result.run = { document: t.s.entry.path, summary: reportText(t.report), ...t.report };
  if (t.report.status === "error" || !t.report.sound) { result.added = false; result.note += " The feature was NOT added to the part studio: it did not build a sound result there."; return { result, png }; }
  const made = edits.addFeature(t.doc, { ...t.def, defaults: () => ({ [SCRIPT_KEY]: { id: saved.id, name: saved.name, hash: saved.hash, source: saved.source, manifest: saved.manifest as unknown as JsonObject }, ...defaultsOf(saved.manifest) }) }, (req.args.params as JsonObject) || {});
  await t.s.commit(made.changes);
  result.added = true; result.feature = { id: made.feature.id, name: made.feature.name };
  return { result, png, record: { docId: t.s.entry.docId, title: `Add ${made.feature.name}`, edits: [`added the custom feature ${made.feature.name}`], undo: { domain: "mechanical", inverse: made.changes.map((c) => ({ id: c.id, kind: "REMOVED", typeName: "feature" })) } } };
}

export const SCRIPT_TOOLS: McpDomainTools = {
  domain: "mechanical-script",
  tools: { cad_script_guide: guide, cad_script_list: list, cad_script_read: read, cad_script_validate: validate, cad_script_run: run, cad_script_write: write },
  sweep(idleMs: number): void {
    const now = Date.now();
    for (const [id, l] of libraries) if (now - l.lastUsed > idleMs) { l.close(); libraries.delete(id); }
  },
};

