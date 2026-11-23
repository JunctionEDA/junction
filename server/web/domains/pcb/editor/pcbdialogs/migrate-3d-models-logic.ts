// pcbdialogs/migrate-3d-models-logic — Tools > Migrate 3D Models... without the DOM (DIALOG_MIGRATE_3D_MODELS,
// pcbnew/dialogs/dialog_migrate_3d_models.cpp, and MODEL_SUBSTITUTION's helpers, 3d-viewer/3d_cache/
// model_substitution_helpers.cpp): the board's .wrl / .wrz model references that resolve to no file, the catalog of
// STEP-family files in the 3D search paths, the candidates ranked for each reference (same stem in the same folder,
// same stem, or a close stem by edit distance), FILENAME_RESOLVER::ShortenPath for the stored name, and the
// footprints rewritten with the chosen replacements.
//
// The search paths are the resolver's: ${KIPRJMOD} (the project's files) and ${KICAD10_3DMODEL_DIR} (KiCad's 3D
// library, whose STEP models the server lists), then the project's 3dshapes folder and the extra directories.  Each
// is given an absolute path here the way the resolver expands it, so the candidates show and store as in KiCad.

import { EMBED_PREFIX, MODEL_DIR_VAR, modelTarget } from "../../library/model3d";

type N = SNode;
/** ${KIPRJMOD} expanded: the folder the project's files are in */
export const PROJECT_DIR = "/home/kicad/project";
/** ${KICAD10_3DMODEL_DIR} expanded: KiCad's 3D library where a Linux install puts it */
export const MODEL_DIR = "/usr/share/kicad/3dmodels";
export const UNSPECIFIED = -2, KEEP_EXISTING = -1;

/** stepExtensions(): the "current" (STEP-era) replacement extensions, by preference */
export const STEP_EXTENSIONS = ["step", "stp", "stpz", "step.gz", "stp.gz", "iges", "igs"];
const STRIP = [".step.gz", ".stp.gz", ".wrl", ".wrz", ".step", ".stp", ".stpz", ".iges", ".igs"];

/** normalizeStem: the name less one known 3D extension, lowercased, '-' and ' ' as '_' */
export function normalizeStem(name: string): string {
  let stem = name;
  for (const ext of STRIP) if (stem.length > ext.length && stem.slice(-ext.length).toLowerCase() === ext) { stem = stem.slice(0, stem.length - ext.length); break; }
  return stem.toLowerCase().split("-").join("_").split(" ").join("_");
}
/** levenshtein: the classic iterative edit distance */
export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_v, j) => j), curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) { const cost = a[i - 1] === b[j - 1] ? 0 : 1; curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost); }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
/** wxFileName( path ).GetFullName() */
export const fullName = (p: string): string => { const s = p.replace(/\\/g, "/"); return s.slice(s.lastIndexOf("/") + 1); };
/** parentDirName: the last folder of the path ("Resistor_SMD.3dshapes" of ".../Resistor_SMD.3dshapes/R_0603.wrl") */
export function parentDirName(p: string): string {
  const s = p.replace(/\\/g, "/"), dirs = s.slice(0, Math.max(0, s.lastIndexOf("/"))).split("/").filter((d) => d && d !== "." );
  return dirs.length ? dirs[dirs.length - 1] : "";
}
/** MODEL_SUBSTITUTION::IsWrlExtension */
export const isWrlExtension = (fn: string): boolean => { const e = fn.slice(fn.lastIndexOf(".") + 1).toLowerCase(); return e === "wrl" || e === "wrz"; };
/** hasStepExtension (scanDirectory's test) */
export const hasStepExtension = (p: string): boolean => { const l = p.toLowerCase(); return STEP_EXTENSIONS.some((e) => l.length > e.length + 1 && l.endsWith("." + e)); };

/** FILENAME_RESOLVER::ShortenPath: a file under a search path is stored as ${ALIAS}/rest. */
export function shortenPath(abs: string): string {
  for (const [dir, alias] of [[PROJECT_DIR, "${KIPRJMOD}"], [MODEL_DIR, "${" + MODEL_DIR_VAR + "}"]]) if (abs.startsWith(dir + "/")) return `${alias}/${abs.slice(dir.length + 1)}`;
  return abs;
}
/** The absolute path a stored name stands for (FILENAME_RESOLVER's expansion of the two aliases). */
export function expandPath(stored: string): string {
  const t = modelTarget(stored);
  if (t.kind === "kicad") return `${MODEL_DIR}/${t.lib}.3dshapes/${t.name}.${t.ext}`;
  if (t.kind === "project") return `${PROJECT_DIR}/${t.path}`;
  return stored;
}

/** What resolves here: the project's files, the footprint's and the board's embedded files (EMBEDDED_FILES stack). */
export interface ResolveEnv { projectFiles: string[]; boardEmbedded: string[] }
const isFileModel = (c: unknown): c is N => Array.isArray(c) && c[0] === "model" && typeof c[1] === "string";
const kid = (n: N, k: string): N | null => (n.find((c) => Array.isArray(c) && c[0] === k) as N | undefined) || null;
const fpEmbedded = (fp: N): string[] => { const ef = kid(fp, "embedded_files"); return ef ? ef.filter((c) => Array.isArray(c) && c[0] === "file").map((f) => String((kid(f as N, "name") || [])[1] ?? "")) : []; };
/**
 * FILENAME_RESOLVER::ResolvePath for a model reference: an embedded file of the footprint or the board, a file of the
 * project (relative or under ${KIPRJMOD}), a vendor model the server serves; KiCad's 3D library holds STEP models only,
 * so a .wrl there, like an absolute path to this server's disk, is not found.
 */
export function resolves(fn: string, fp: N, env: ResolveEnv): boolean {
  const t = modelTarget(fn);
  switch (t.kind) {
    case "embedded": return fpEmbedded(fp).includes(t.name) || env.boardEmbedded.includes(t.name);
    case "vendor": return true;
    case "project": return env.projectFiles.includes(t.path);
    case "kicad": return !isWrlExtension(fn);
    default: return false;
  }
}

/** ENTRY: the first footprint holding the reference and that model's transform */
export interface MissingEntry { fpId: string; fp: N; xform: { scale: number[]; rotation: number[]; offset: number[]; opacity: number } }
const xyz = (m: N, k: string, d: number): number[] => { const a = kid(m, k), v = a && kid(a, "xyz"); return v ? [1, 2, 3].map((i) => (typeof v[i] === "number" ? (v[i] as number) : d)) : [d, d, d]; };
/** DIALOG_MIGRATE_3D_MODELS::collectMissingWrlModels: by file name, in std::map order */
export function collectMissingWrlModels(items: Iterable<KItem>, env: ResolveEnv): Map<string, MissingEntry> {
  const byName = new Map<string, MissingEntry>();
  for (const it of items) {
    if (it.kind !== "footprint") continue;
    for (const m of it.node) {
      if (!isFileModel(m)) continue;
      const fn = String(m[1]);
      if (!fn || !isWrlExtension(fn) || byName.has(fn)) continue;
      if (resolves(fn, it.node, env)) continue;
      const op = kid(m, "opacity");
      byName.set(fn, { fpId: it.id, fp: it.node, xform: { scale: xyz(m, "scale", 1), rotation: xyz(m, "rotate", 0), offset: xyz(m, "offset", 0), opacity: op && typeof op[1] === "number" ? op[1] : 1 } });
    }
  }
  return new Map([...byName.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/** CATALOG_ENTRY */
export interface CatalogEntry { absPath: string; stem: string; parent: string }
/** Where the search paths' files come from: the project's (relative paths) and KiCad's STEP models ("Library:Name"). */
export interface CatalogSources { projectFiles: string[]; kicadModels: string[] | null; extraDirs: string[] }
/** The search paths' files, absolute: what CollectFilesLoopSafe finds under each. */
export function filesUnder(dir: string, src: CatalogSources): string[] {
  const all = [...src.projectFiles.map((p) => `${PROJECT_DIR}/${p}`), ...(src.kicadModels || []).map((id) => { const c = id.indexOf(":"); return `${MODEL_DIR}/${id.slice(0, c)}.3dshapes/${id.slice(c + 1)}.step`; })];
  const d = dir.replace(/\/+$/, "");
  return all.filter((f) => f.startsWith(d + "/"));
}
/** The directories buildCatalog scans, in order: the resolver's search paths, the project's 3dshapes, the extra ones. */
export const scanDirs = (extra: string[]): string[] => [PROJECT_DIR, MODEL_DIR, `${PROJECT_DIR}/3dshapes`, ...extra];
/** DIALOG_MIGRATE_3D_MODELS::scanDirectory, onto `catalog` (`scanned`: the directories already walked). */
export function scanDirectory(dir: string, src: CatalogSources, catalog: CatalogEntry[], scanned: Set<string>): void {
  if (!dir) return;
  const norm = dir.replace(/\/+$/, "") || "/";
  if (scanned.has(norm.toLowerCase())) return;
  scanned.add(norm.toLowerCase());
  const existing = new Set(catalog.map((e) => e.absPath.toLowerCase()));
  for (const f of filesUnder(norm, src)) {
    const lower = f.toLowerCase();
    if (!hasStepExtension(f) || existing.has(lower)) continue;
    existing.add(lower);
    catalog.push({ absPath: f, stem: normalizeStem(fullName(f)), parent: parentDirName(f) });
  }
}
/** DIALOG_MIGRATE_3D_MODELS::buildCatalog */
export function buildCatalog(src: CatalogSources): CatalogEntry[] {
  const catalog: CatalogEntry[] = [], scanned = new Set<string>();
  for (const d of scanDirs(src.extraDirs)) scanDirectory(d, src, catalog, scanned);
  return catalog;
}

/** MATCH_CANDIDATE */
export interface Candidate { absPath: string; display: string; score: number }
export const KEEP_LABEL = "(keep existing reference)";
const cmpNoCase = (a: string, b: string): number => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; };
/** DIALOG_MIGRATE_3D_MODELS::rankCandidatesFor: the best 15, then "keep existing" */
export function rankCandidatesFor(wrl: string, catalog: CatalogEntry[]): Candidate[] {
  const wrlStem = normalizeStem(fullName(wrl)), wrlParent = parentDirName(wrl);
  const ranked: Candidate[] = [];
  for (const e of catalog) {
    let score = 0;
    if (e.stem === wrlStem) score = wrlParent && cmpNoCase(e.parent, wrlParent) === 0 ? 1000 : 800;
    else {
      const dist = levenshtein(e.stem, wrlStem), maxDist = Math.max(2, Math.floor(wrlStem.length / 4));
      if (dist <= maxDist) score = 500 - dist * 10;
    }
    if (score > 0) ranked.push({ absPath: e.absPath, display: `${fullName(e.absPath)}   —   ${e.parent}`, score });
  }
  ranked.sort((a, b) => (a.score !== b.score ? b.score - a.score : cmpNoCase(a.display, b.display)));
  ranked.length = Math.min(ranked.length, 15);
  ranked.push({ absPath: "", display: KEEP_LABEL, score: 0 });
  return ranked;
}
/** The initial choice of each row (TransferDataToWindow): the top real candidate, else none. */
export const autoSelect = (cands: Candidate[]): number => (cands.length && cands[0].absPath ? 0 : UNSPECIFIED);
/** OnOpenExternalFileClick: the chosen file as a top candidate ("user-selected", score 2000), or the row already there. */
export function injectCandidate(cands: Candidate[], abs: string): { cands: Candidate[]; sel: number } {
  const at = cands.findIndex((c) => c.absPath === abs);
  if (at >= 0) return { cands, sel: at };
  return { cands: [{ absPath: abs, display: `${fullName(abs)}   —   user-selected`, score: 2000 }, ...cands], sel: 0 };
}
/** updateAfterCatalogChange: re-rank every row, keeping a prior pick by file and "keep existing" rows as they were. */
export function rerank(missing: string[], catalog: CatalogEntry[], prior: Candidate[][], sel: number[]): { cands: Candidate[][]; sel: number[] } {
  const priorPaths = missing.map((_m, i) => (sel[i] >= 0 && sel[i] < prior[i].length ? prior[i][sel[i]].absPath : ""));
  const cands = missing.map((m) => rankCandidatesFor(m, catalog));
  const out = sel.slice();
  for (let i = 0; i < missing.length; i++) {
    if (out[i] === KEEP_EXISTING) continue;
    out[i] = UNSPECIFIED;
    if (priorPaths[i]) { const j = cands[i].findIndex((c) => c.absPath === priorPaths[i]); if (j >= 0) out[i] = j; }
    if (out[i] === UNSPECIFIED && cands[i].length && cands[i][0].absPath) out[i] = 0;
  }
  return { cands, sel: out };
}

/** MODEL_SUBSTITUTION::STEP_CATALOG::FindMatchFor: the same stem, preferring the same parent folder. */
export function findMatchFor(wrl: string, catalog: CatalogEntry[]): string {
  if (!isWrlExtension(wrl)) return "";
  const stem = normalizeStem(fullName(wrl));
  if (!stem) return "";
  const hits = catalog.filter((e) => e.stem === stem);
  if (!hits.length) return "";
  const parent = parentDirName(wrl);
  if (parent) { const same = hits.find((e) => cmpNoCase(e.parent, parent) === 0); if (same) return same.absPath; }
  return hits[0].absPath;
}

/** OnReplaceClick's map: old file name → the stored (shortened) replacement, for rows with a real pick. */
export function replacementsOf(missing: string[], cands: Candidate[][], sel: number[]): Map<string, string> {
  const out = new Map<string, string>();
  missing.forEach((m, i) => { const s = sel[i]; if (s < 0 || s >= cands[i].length) return; const c = cands[i][s]; if (!c.absPath) return; out.set(m, c.absPath.startsWith(EMBED_PREFIX) ? c.absPath : shortenPath(c.absPath)); });
  return out;
}
/** Every footprint's (model …) whose file is replaced, rewritten on a copy (commit.Modify per footprint). */
export function applyReplacements(items: Iterable<KItem>, repl: Map<string, string>, copy: (n: N) => N): { modified: Map<string, N>; rewritten: number } {
  const modified = new Map<string, N>(); let rewritten = 0;
  for (const it of items) {
    if (it.kind !== "footprint" || !it.node.some((m) => isFileModel(m) && repl.has(String(m[1])))) continue;
    const node = copy(it.node);
    for (const m of node) if (isFileModel(m) && repl.has(String(m[1]))) { m[1] = repl.get(String(m[1]))!; rewritten++; }
    modified.set(it.id, node);
  }
  return { modified, rewritten };
}
/** showPreview's footprint: a copy with the candidate as its only model, carrying the reference's transform. */
export function previewModel(abs: string, x: MissingEntry["xform"]): { file: string; show: boolean; opacity: number; offset: number[]; scale: number[]; rotate: number[] } | null {
  return abs ? { file: abs.startsWith(EMBED_PREFIX) ? abs : shortenPath(abs), show: true, opacity: x.opacity, offset: x.offset, scale: x.scale, rotate: x.rotation } : null;
}
