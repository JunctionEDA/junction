// api.ts — adding, renaming and deleting the documents of an open project, over the endpoints every client uses
// (server/src/http.rs: POST /api/projects/{id}/docs, POST /api/docs/{id}/snapshots, PATCH and DELETE /api/docs/{id}).
// Pure helpers are separate from the network calls so they can be tested.
import type { DocEntry } from "../../shared/store";
import { DOCUMENT_KINDS, documentKind, type DocumentKind } from "../../domains/registry";

const base = (path: string): string => path.split("/").pop() || path;
/** A document's name as its tab shows it: the file name without its folder and extension. */
export const stemOf = (path: string): string => base(path).replace(/\.[^.]+$/, "");

export interface Tab { doc: DocEntry; kind: DocumentKind; label: string }

/** The documents that get a tab, in tab order: by kind as the registry lists them, then by name. */
export function tabsOf(docs: readonly DocEntry[], rootDocId: string | null): Tab[] {
  const out: Tab[] = [];
  const boards = docs.filter((d) => d.docType === "kicad_pcb").length;
  for (const doc of docs) {
    const kind = documentKind(doc.docType); if (!kind) continue;
    // a schematic's sheets are reached from the schematic itself: only the root sheet has a tab
    if (doc.docType === "kicad_sch" && rootDocId && doc.docId !== rootDocId) continue;
    const own = !!kind.newName;   // a document the tabs made carries the name its maker gave it
    out.push({ doc, kind, label: own || (doc.docType === "kicad_pcb" && boards > 1) ? stemOf(doc.path) : kind.title });
  }
  const rank = (t: Tab) => DOCUMENT_KINDS.indexOf(t.kind);
  return out.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, undefined, { numeric: true }));
}

/** "Part Studio 2.jpart": the first name of that kind no document of the project has (whatever the letter case). */
export function freeName(kind: DocumentKind, docs: readonly { path: string }[]): string {
  const taken = new Set(docs.map((d) => base(d.path).toLowerCase()));
  for (let n = 1; ; n++) { const name = `${kind.newName || kind.title} ${n}${kind.ext}`; if (!taken.has(name.toLowerCase())) return name; }
}

/** The path a document gets when its tab is renamed to `name`, or why that name will not do. */
export function renamedPath(doc: { path: string }, name: string, docs: readonly { docId?: string; path: string }[]): { path: string } | { error: string } {
  const stem = name.trim().replace(/\s+/g, " ");
  if (!stem) return { error: "A document needs a name." };
  if (/[\\/:*?"<>|]/.test(stem) || stem.startsWith(".")) return { error: 'A name cannot contain \\ / : * ? " < > | or start with a dot.' };
  const ext = (/\.[^.\/]+$/.exec(doc.path) || [""])[0];
  const dir = doc.path.includes("/") ? doc.path.slice(0, doc.path.lastIndexOf("/") + 1) : "";
  const path = dir + stem + ext;
  if (path === doc.path) return { path };
  if (docs.some((d) => d.path !== doc.path && d.path.toLowerCase() === path.toLowerCase())) return { error: `This project already has “${stem}${ext}”.` };
  return { path };
}

async function call(path: string, init: RequestInit): Promise<unknown> {
  const r = await fetch(path, init);
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(t || `${r.status} ${r.statusText}`); }
  return (r.headers.get("content-type") || "").includes("json") ? r.json() : r.text();
}
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The project's documents as the server has them now. */
export async function fetchDocs(projectId: string): Promise<DocEntry[]> {
  const info = (await call(`/api/projects/${projectId}/info`, { headers: { "content-type": "application/json" } })) as { docs: DocEntry[] };
  return info.docs || [];
}

/** Make a new, empty document of a kind; returns its id.  The document's first snapshot is the kind's empty file. */
export async function createDocument(projectId: string, kind: DocumentKind, docs: readonly DocEntry[]): Promise<string> {
  if (kind.newText === undefined) throw new Error(`A ${kind.title} cannot be created here.`);
  const made = (await call(`/api/projects/${projectId}/docs`, json({ path: freeName(kind, docs) }))) as { docId: string };
  await call(`/api/docs/${made.docId}/snapshots?seq=0`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: kind.newText });
  return made.docId;
}

/** "models/bracket.step", or "models/bracket 2.step" when the project has that (whatever the letter case). */
export function freeFilePath(folder: string, name: string, docs: readonly { path: string }[]): string {
  const clean = (base(name).replace(/[\\/:*?"<>|]+/g, "_").trim() || "file").replace(/^\.+/, "_");
  const dir = folder ? folder.replace(/\/+$/, "") + "/" : "";
  const dot = clean.lastIndexOf("."), stem = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : "";
  const taken = new Set(docs.map((d) => d.path.toLowerCase()));
  for (let n = 1; ; n++) { const p = `${dir}${n === 1 ? stem : `${stem} ${n}`}${ext}`; if (!taken.has(p.toLowerCase())) return p; }
}

/**
 * Store a file in the project as it is (its bytes become the document's first snapshot): a STEP model, say.
 * `onProgress` hears the upload's progress, 0 to 1.  Returns the new document.
 */
export async function uploadFile(projectId: string, folder: string, name: string, data: Blob, onProgress?: (done: number) => void): Promise<DocEntry> {
  let docs = await fetchDocs(projectId);
  let made: { docId: string; path: string; docType: string; existing?: boolean } | null = null;
  for (let tries = 0; tries < 3 && !made; tries++) {
    const r = (await call(`/api/projects/${projectId}/docs`, json({ path: freeFilePath(folder, name, docs) }))) as { docId: string; path: string; docType: string; existing?: boolean };
    if (!r.existing) made = r; else docs = await fetchDocs(projectId);   // somebody took the name meanwhile
  }
  if (!made) throw new Error(`“${name}” could not be added to the project.`);
  await new Promise<void>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", `/api/docs/${made!.docId}/snapshots?seq=0`);
    x.setRequestHeader("content-type", "application/octet-stream");
    x.upload.onprogress = (ev) => { if (ev.lengthComputable && onProgress) onProgress(ev.loaded / ev.total); };
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(x.responseText || `${x.status} ${x.statusText}`)));
    x.onerror = () => reject(new Error(`“${name}” could not be uploaded.`));
    x.send(data);
  });
  return { docId: made.docId, path: made.path, docType: made.docType };
}

/** Make a document of `kind` from a file (kind.fromFile): store the file, then the document that uses it.  Returns the new document's id. */
export async function documentFromFile(projectId: string, kind: DocumentKind, file: File, onProgress?: (done: number) => void): Promise<string> {
  const from = kind.fromFile;
  if (!from) throw new Error(`A ${kind.title} cannot be made from a file.`);
  if (!from.accept.some((ext) => file.name.toLowerCase().endsWith(ext))) throw new Error(`“${file.name}” is not a ${from.title} (${from.accept.join(", ")}).`);
  const stored = await uploadFile(projectId, from.folder, file.name, file, onProgress);
  const docs = await fetchDocs(projectId);
  const stem = stemOf(stored.path);
  const path = freeFilePath("", stem + kind.ext, docs);
  const made = (await call(`/api/projects/${projectId}/docs`, json({ path }))) as { docId: string };
  const text = from.text({ docId: stored.docId, path: stored.path, name: base(stored.path), bytes: file.size });
  await call(`/api/docs/${made.docId}/snapshots?seq=0`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: text });
  return made.docId;
}

/** The kind a dropped or chosen file makes, by its extension. */
export function kindForFile(name: string): DocumentKind | undefined {
  const lower = name.toLowerCase();
  return DOCUMENT_KINDS.find((k) => k.fromFile && k.fromFile.accept.some((ext) => lower.endsWith(ext)));
}

export async function renameDocument(doc: DocEntry, path: string): Promise<void> {
  await call(`/api/docs/${doc.docId}`, { ...json({ path }), method: "PATCH" });
}

export async function deleteDocument(doc: DocEntry): Promise<void> {
  await call(`/api/docs/${doc.docId}`, { method: "DELETE", headers: { "content-type": "application/json" } });
}
