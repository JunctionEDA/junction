// pcbdialogs/embed-models — Tools > Collect And Embed 3D Models (PCB_CONTROL::CollectAndEmbed3DModels): every footprint
// model that is not embedded yet and whose file the resolver finds is added to the board's own embedded files, and the
// model then names the file's kicad-embed:// link; the footprints change as one "Embed 3D Models" step and the info
// bar says how many were embedded.  KiCad adds the files to the board outside the commit (an undo puts the model paths
// back and leaves the files), and so does this: the board's files travel as a BOARD_SETUP "embedded_file" change.
//
// FILENAME_RESOLVER::ResolvePath here: a project path (${KIPRJMOD}/…, or an absolute path the project keeps) is the
// project's own model document of that name, KiCad's library (${KICAD*_3DMODEL_DIR}/<Lib>.3dshapes/<Name>.ext) is the
// server's copy of that library file, a vendor part's model (${KICAD_COLLAB_3DMODELS}/…) the server's vendor STEP file
// (the only file that folder holds).  A .wrl / .wrz model is embedded itself, and the first of its STEP siblings that
// exists (stp, step, STP, STEP, Stp, Step, stpz, stpZ, STPZ) beside it, for the STEP exporter.
import { embeddedFileNode, embeddedFileSexpr } from "../../library/embedded-file";

type Node = unknown[];
const isList = Array.isArray;
/** KiCadCanvas.cloneNode (the quoting marks go with the copy), else a plain deep copy */
const cloneNode = (n: Node): Node => { const K = (globalThis as { KiCadCanvas?: { cloneNode?(x: Node): Node } }).KiCadCanvas; return K && K.cloneNode ? K.cloneNode(n) : (JSON.parse(JSON.stringify(n)) as Node); };
const fieldOf = (n: Node, name: string): string => { for (const c of n) if (isList(c) && c[0] === "property" && String(c[1]).toLowerCase() === name.toLowerCase()) return String(c[2] ?? "").trim(); return ""; };
const VENDOR_FIELDS: [string, string][] = [["LCSC", "lcsc"], ["Mouser", "mouser"], ["DigiKey", "digikey"]];
/** FILEEXT::KiCadUriPrefix */
export const KICAD_URI_PREFIX = "kicad-embed://";

/** Where a model's file is read from, and the name it is embedded under (wxFileName::GetFullName of the resolved file). */
export interface ResolvedModel { url: string; name: string }
/** The model files the server can hold (STEP, compressed STEP, VRML, compressed VRML). */
const MODEL_EXT = /^(step|stp|stpz|wrl|wrz)$/i;
/** PCB_CONTROL::CollectAndEmbed3DModels: the STEP files looked for beside an embedded VRML model, in its order. */
export const STEP_ALTERNATIVES = ["stp", "step", "STP", "STEP", "Stp", "Step", "stpz", "stpZ", "STPZ"];
/**
 * FILENAME_RESOLVER::ResolvePath for a footprint's (model "path"), or for that path with its extension replaced by
 * `ext` (the wxFileName of a sibling): the file the server has for it, or null when there is none (KiCad's
 * wxFileName::Exists() is false, and the model is left as it is).  `projectModel` is the page's KiCadProjectModel
 * (project path without its extension, and the extension -> where that document is read).
 */
export function resolveModel(path: string, fp: Node, projectModel?: ((stem: string, ext?: string) => string | null) | null, ext?: string): ResolvedModel | null {
  const dot = /^(.*)\.([^.\/\\]+)$/.exec(path); if (!dot) return null;
  const e = ext === undefined ? dot[2] : ext; if (!MODEL_EXT.test(e)) return null;
  const full = dot[1] + "." + e, name = full.replace(/^.*[\/\\]/, "");
  const own = (stem: string): string | null => { try { return projectModel ? projectModel(stem, e) || null : null; } catch { return null; } };
  const stemOf = (p: string): string => p.slice(0, p.length - e.length - 1);
  if (/^(?:[A-Za-z]:)?[\/\\]/.test(full)) { const url = own(stemOf(full).replace(/\\/g, "/")); return url ? { url, name } : null; }
  const v = /^\$[{(]([A-Za-z0-9_]+)[})][\/\\](.+)$/.exec(full);
  if (v && /^KIPRJMOD$/.test(v[1])) {
    const stem = stemOf(v[2]).replace(/\\/g, "/").replace(/^\.\//, "");
    if (stem.replace(/^(?:\.\.\/)+/, "").split("/").includes("..")) return null;
    const url = own(stem); return url ? { url, name } : null;
  }
  const lib = /([^\/\\${}]+)\.3dshapes[\/\\]([^\/\\]+)$/.exec(full);
  if (v && /^KICAD_COLLAB_3DMODELS$/.test(v[1])) {
    if (e !== "step") return null;   // the vendor folder holds <name>.step only
    const hit = VENDOR_FIELDS.map(([f, k]) => [k, fieldOf(fp, f)]).find(([, id]) => id); if (!hit) return null;
    return { url: `/api/parts/model.step?vendor=${hit[0]}&id=${encodeURIComponent(hit[1])}&fit=5`, name };
  }
  if (lib && (!v || /^(KICAD\d*_3DMODEL_DIR|KISYS3DMOD)$/.test(v[1]))) {
    const item = lib[2].slice(0, lib[2].length - e.length - 1);
    return { url: `/api/kicad-lib/model?lib=${encodeURIComponent(lib[1])}&name=${encodeURIComponent(item)}` + (e === "step" ? "" : `&ext=${encodeURIComponent(e)}`), name };
  }
  if (v) {   // another path variable: the project's copy of that file, when it keeps one
    const stem = stemOf(v[2]).replace(/\\/g, "/").replace(/^\.\//, "");
    if (stem.split("/").includes("..")) return null;
    const url = own(stem) || (stem.includes("/") ? own("/" + stem) : null); return url ? { url, name } : null;
  }
  return null;
}

/** What CollectAndEmbed3DModels does to a board: the footprints it changed (their new nodes), the board files it added, the count. */
export interface EmbedResult { footprints: { id: string; node: Node }[]; files: string[]; count: number }
/**
 * PCB_CONTROL::CollectAndEmbed3DModels over `items` (the board's items in board order; footprints are those of kind
 * "footprint") and `boardFiles` (the board's (embedded_files …)).  `fetchBytes` reads a resolved file (null: it does not
 * exist).  EMBEDDED_FILES::AddFile( aName, false ): a file the board already has under that name is taken as it is.
 */
export async function collectAndEmbed3DModels(items: Iterable<{ id: string; kind: string; node: Node }>, boardFiles: Node | null | undefined, fetchBytes: (url: string) => Promise<Uint8Array | null>, projectModel?: ((stem: string, ext?: string) => string | null) | null): Promise<EmbedResult> {
  const out: EmbedResult = { footprints: [], files: [], count: 0 };
  const added = new Set<string>(), cache = new Map<string, Promise<Uint8Array | null>>();
  const read = (url: string): Promise<Uint8Array | null> => { let p = cache.get(url); if (!p) { p = fetchBytes(url).catch(() => null); cache.set(url, p); } return p; };
  for (const it of items) {
    if (it.kind !== "footprint") continue;
    let node: Node | null = null;
    for (let j = 0; j < it.node.length; j++) {
      const c = it.node[j]; if (!isList(c) || c[0] !== "model") continue;
      const path = String(c[1] ?? ""); if (path.startsWith(KICAD_URI_PREFIX)) continue;
      const res = resolveModel(path, it.node, projectModel); if (!res) continue;
      const bytes = await read(res.url); if (!bytes || !bytes.length) continue;   // fname.Exists()
      const addFile = (name: string, data: Uint8Array): void => { if (!embeddedFileNode(boardFiles, name) && !added.has(name)) { added.add(name); out.files.push(embeddedFileSexpr(name, data)); } };
      addFile(res.name, bytes);
      if (!node) node = cloneNode(it.node);
      (node[j] as Node)[1] = KICAD_URI_PREFIX + res.name;   // model.m_Filename = file->GetLink()
      out.count++;
      // "Store STEP along with WRL for the OCCT(STEP) exporter": the first alternative that exists
      if (/^(?:wrl|wrz)$/i.test(res.name.replace(/^.*\./, ""))) {
        for (const alt of STEP_ALTERNATIVES) {
          const a = resolveModel(path, it.node, projectModel, alt); if (!a) continue;
          const altBytes = await read(a.url); if (!altBytes || !altBytes.length) continue;
          addFile(a.name, altBytes); break;
        }
      }
    }
    if (node) out.footprints.push({ id: it.id, node });
  }
  return out;
}
/** The info bar's message after an embed. */
export const embeddedCountMessage = (n: number): string => `${n} 3D model(s) successfully embedded.`;
