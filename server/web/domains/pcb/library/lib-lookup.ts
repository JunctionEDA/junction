// library/lib-lookup.ts — what the library tables say about the items a design names, for the checks that compare a
// design with its libraries: ERC_TESTER::TestLibSymbolIssues / TestPinMap / TestFootprintLinkIssues, the DRC's
// DRC_TEST_PROVIDER_LIBRARY_PARITY and Rescue Symbols.  The configuration is the web's: the project's sym-lib-table /
// fp-lib-table rows first (LIBRARY_MANAGER::GetRow looks at the project table before the global one), then the
// project's own *.kicad_sym files and *.pretty folders the choosers read by name (library/sources.ts), then the global
// table, which is the official libraries this server provides (dialogs/lib-tables.ts "Global Libraries").  The items
// come in one request to the server's library-content endpoint (POST /api/libs/lookup) and from the project's files.
import { flattenSymbol, embedSymbol, parseLibId, symbolNodeOf } from "./core";

interface ProjectDoc { docId: string; path: string; docType?: string }

/** A library's state in the configuration:
 *  ok          — a row (or a project library) whose library can be read
 *  missing     — no row of that nickname (LIBRARY_MANAGER::GetRow found none)
 *  disabled    — a row that is not enabled
 *  not_loaded  — a row whose library cannot be read (IsLibraryLoaded false): its uri is the "not found at" path */
export type LibState = "ok" | "missing" | "disabled" | "not_loaded";
export interface SymbolLookup { state: LibState; uri: string; library: string; name: string; symbol: SNode | null;
  /** the root symbol of a derived one (LIB_SYMBOL::GetRootSymbol), as its library has it; the symbol itself when it is a root */
  root?: SNode | null }
export interface FootprintLookup { state: LibState; uri: string; library: string; name: string; footprint: SNode | null }
export interface LibraryLookup { symbols: Map<string, SymbolLookup>; footprints: Map<string, FootprintLookup> }

/** One row of a library table: nickname, uri, enabled. */
export interface TableRow { nickname: string; uri: string; enabled: boolean }
/** Where a nickname's library is: one of the project's files, an official library, or nowhere this side can read. */
export type LibSource = { state: LibState; uri: string; project?: string; official?: string };

const K = (): KiCadCanvasApi => (globalThis as unknown as { KiCadCanvas: KiCadCanvasApi }).KiCadCanvas;
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/** The rows of a sym-lib-table / fp-lib-table text (LIBRARY_TABLE parse: (lib (name)(uri)(disabled))). */
export function tableRows(text: string): TableRow[] {
  const t = text ? K().parse(text) : null; if (!t) return [];
  return K().kids(t, "lib").map((l) => ({ nickname: str((K().kid(l, "name") || [])[1]), uri: str((K().kid(l, "uri") || [])[1]), enabled: !K().kid(l, "disabled") })).filter((r) => r.nickname);
}

const PRJ = /^\$[{(]KIPRJMOD[})][\/\\]?/;
const OFFICIAL_SYM = /^\$[{(]KICAD\d*_SYMBOL_DIR[})][\/\\]([^\/\\]+?)\.kicad_sym(dir)?[\/\\]?$/;
const OFFICIAL_FP = /^\$[{(]KICAD\d*_FOOTPRINT_DIR[})][\/\\]([^\/\\]+?)\.pretty[\/\\]?$/;
const projectPath = (uri: string): string | null => (PRJ.test(uri) ? uri.replace(PRJ, "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "") : null);

/**
 * LIBRARY_MANAGER::GetRow and IsLibraryLoaded for one nickname: the project table's row first, then a project library
 * of that name, then the global table (`official`: the official library names; null when they could not be read, in
 * which case a nickname found nowhere else is taken as unknown, never as missing).
 */
export function librarySource(kind: "symbol" | "footprint", nickname: string, rows: TableRow[], docs: ProjectDoc[], official: Set<string> | null): LibSource | null {
  const row = rows.find((r) => r.nickname === nickname);
  if (row) {
    if (!row.enabled) return { state: "disabled", uri: row.uri };
    const p = projectPath(row.uri);
    if (p !== null) {
      const held = kind === "symbol" ? docs.some((d) => d.path === p) : docs.some((d) => d.path.startsWith(p + "/") && /\.kicad_mod$/i.test(d.path));
      return held ? { state: "ok", uri: row.uri, project: p } : { state: "not_loaded", uri: row.uri };
    }
    const m = (kind === "symbol" ? OFFICIAL_SYM : OFFICIAL_FP).exec(row.uri.trim());
    if (m) {
      if (!official) return null;
      return official.has(m[1]) ? { state: "ok", uri: row.uri, official: m[1] } : { state: "not_loaded", uri: row.uri };
    }
    // a path outside the project: nothing this side can read
    return { state: "not_loaded", uri: row.uri };
  }
  for (const d of docs) {
    const parts = d.path.split("/"), file = parts[parts.length - 1];
    if (kind === "symbol" && /\.kicad_sym$/i.test(file) && file.replace(/\.kicad_sym$/i, "") === nickname) return { state: "ok", uri: "${KIPRJMOD}/" + d.path, project: d.path };
    if (kind === "footprint" && /\.kicad_mod$/i.test(file) && parts[parts.length - 2] === nickname + ".pretty") { const dir = parts.slice(0, -1).join("/"); return { state: "ok", uri: "${KIPRJMOD}/" + dir, project: dir }; }
  }
  if (!official) return null;
  if (official.has(nickname)) return { state: "ok", uri: (kind === "symbol" ? "${KICAD10_SYMBOL_DIR}/" + nickname + ".kicad_symdir" : "${KICAD10_FOOTPRINT_DIR}/" + nickname + ".pretty"), official: nickname };
  return { state: "missing", uri: "" };
}

/** A symbol of a project library file: flattened (LIB_SYMBOL::Flatten) over the parents it extends. */
export function projectSymbol(text: string, name: string): SNode | null {
  const tree = K().parse(text); if (!tree) return null;
  const all = K().kids(tree, "symbol"), byName = new Map(all.map((s) => [str(s[1]), s]));
  const sym = byName.get(name); if (!sym) return null;
  const parents: SNode[] = [];
  for (let e = K().kid(sym, "extends"); e && parents.length < 16;) { const p = byName.get(str(e[1])); if (!p) break; parents.push(p); e = K().kid(p, "extends"); }
  try { return flattenSymbol(sym, parents); } catch { return null; }
}
/** The root symbol (LIB_SYMBOL::GetRootSymbol) of a project library symbol: the last one its extends chain reaches. */
export function projectRootSymbol(text: string, name: string): SNode | null {
  const tree = K().parse(text); if (!tree) return null;
  const byName = new Map(K().kids(tree, "symbol").map((s) => [str(s[1]), s]));
  let sym = byName.get(name) || null;
  for (let n = 0; sym && K().kid(sym, "extends") && n < 16; n++) sym = byName.get(str((K().kid(sym, "extends") as SNode)[1])) || null;
  return sym;
}

async function text(docId: string): Promise<string> {
  const r = await fetch(`/api/docs/${encodeURIComponent(docId)}/content`, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
async function json<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

/**
 * Every symbol (`symbols`, lib ids) and footprint (`footprints`, FPIDs) of the design as the configuration has them:
 * the library's state and, when it is readable and holds the item, the item (a symbol flattened and embedded under its
 * lib id, as the schematic caches it; a footprint as its file has it).  Rejects when the server's libraries cannot be
 * read just now (the caller then cannot tell missing libraries from unknown ones).
 */
export async function lookupLibraryItems(req: { symbols: Iterable<string>; footprints: Iterable<string> }, docs: ProjectDoc[]): Promise<LibraryLookup> {
  const tables = async (file: string): Promise<TableRow[]> => { const d = docs.find((x) => x.path === file); return d ? tableRows(await text(d.docId).catch(() => "")) : []; };
  const [symRows, fpRows, symLibs, fpLibs] = await Promise.all([tables("sym-lib-table"), tables("fp-lib-table"),
    json<{ libraries: { name: string }[] }>("/api/libs/symbols"), json<{ libraries: { name: string }[] }>("/api/libs/footprints")]);
  const offSym = new Set(symLibs.libraries.map((l) => l.name)), offFp = new Set(fpLibs.libraries.map((l) => l.name));
  const out: LibraryLookup = { symbols: new Map(), footprints: new Map() };
  const askSym: string[] = [], askFp: string[] = [];
  const wantSym = new Map<string, { id: string; src: LibSource }>(), wantFp = new Map<string, { id: string; src: LibSource }>();
  for (const id of new Set(req.symbols)) {
    const { lib, name } = parseLibId(id);
    const src = librarySource("symbol", lib, symRows, docs, offSym) || { state: "missing" as LibState, uri: "" };
    out.symbols.set(id, { state: src.state, uri: src.uri, library: lib, name, symbol: null });
    if (src.state === "ok") wantSym.set(id, { id: src.official ? src.official + ":" + name : id, src });
    if (src.state === "ok" && src.official) askSym.push(src.official + ":" + name);
  }
  for (const id of new Set(req.footprints)) {
    const { lib, name } = parseLibId(id);
    const src = librarySource("footprint", lib, fpRows, docs, offFp) || { state: "missing" as LibState, uri: "" };
    out.footprints.set(id, { state: src.state, uri: src.uri, library: lib, name, footprint: null });
    if (src.state === "ok") wantFp.set(id, { id: src.official ? src.official + ":" + name : id, src });
    if (src.state === "ok" && src.official) askFp.push(src.official + ":" + name);
  }
  type Got = { symbols: Record<string, { library: boolean; symbol?: string; parents?: string[] }>; footprints: Record<string, { library: boolean; footprint?: string }> };
  const got: Got = askSym.length || askFp.length ? await json<Got>("/api/libs/lookup", { symbols: askSym, footprints: askFp }) : { symbols: {}, footprints: {} };
  const texts = new Map<string, Promise<string>>();
  const docText = (path: string): Promise<string> => {
    let p = texts.get(path);
    if (!p) { const d = docs.find((x) => x.path === path); p = d ? text(d.docId).catch(() => "") : Promise.resolve(""); texts.set(path, p); }
    return p;
  };
  for (const [id, w] of wantSym) {
    const e = out.symbols.get(id)!;
    let flat: SNode | null = null;
    if (w.src.official) {
      const g = got.symbols[w.id];
      if (g && g.symbol) {
        try { flat = flattenSymbol(symbolNodeOf(g.symbol, e.name), (g.parents || []).map((p) => symbolNodeOf(p))); } catch { flat = null; }
        try { const ps = g.parents || []; e.root = ps.length ? symbolNodeOf(ps[ps.length - 1]) : symbolNodeOf(g.symbol, e.name); } catch { e.root = null; }
      }
    } else if (w.src.project) { const t = await docText(w.src.project); flat = projectSymbol(t, e.name); e.root = projectRootSymbol(t, e.name); }
    if (flat) { try { e.symbol = embedSymbol(id, flat); } catch { e.symbol = null; } }
  }
  for (const [id, w] of wantFp) {
    const e = out.footprints.get(id)!;
    let t = "";
    if (w.src.official) { const g = got.footprints[w.id]; t = g && g.footprint ? g.footprint : ""; }
    else if (w.src.project) t = await docText(w.src.project + "/" + e.name + ".kicad_mod");
    if (t) { const n = K().parse(t); if (n) e.footprint = n[0] === "kicad_footprint_lib" ? (K().kid(n, "footprint") as SNode | null) : n; }
  }
  return out;
}

/** The pad numbers of a library footprint (getFootprintPadNumbers: every pad with a number). */
export function footprintPadNumbers(fp: SNode | null): Set<string> {
  const out = new Set<string>(); if (!fp) return out;
  for (const p of K().kids(fp, "pad")) { const n = str(p[1]); if (n) out.add(n); }
  return out;
}
