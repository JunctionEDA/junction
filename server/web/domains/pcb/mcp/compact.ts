// compact.ts — fold a document's journalled edits into a new whole file, without a desktop editor.
//
// The server keeps a document as a snapshot (a whole KiCad file) with the ops made since laid over it,
// and only the desktop editors write snapshots.  A project edited only in the browser or through the
// tools therefore carries its whole history as ops, which every open and every join pays for, and the
// server's own readers of "the file" (downloads, GitHub sync) see the last snapshot, not the design.
//
// This writes the file those ops describe.  It is a splice, not a save: the stored file is cut into its
// top-level elements and every one of them that no edit touched goes into the result as the same bytes,
// in the same place — the format version, the generator, the sections this reader does not model
// (embedded files and fonts, sheet and symbol instances, net declarations, anything newer than us) and
// every item nobody changed.  Only the items the ops added, changed or removed, the library symbols those
// brought or left unused, and the header sections an edit replaced (page, title block, board setup) are
// written, and those from the edit's own text wherever it carried one.
//
// What the ops mean is not decided here: they are applied with the editor's own applyChange, so the
// result is the document every open browser already shows.  The result is then read back and compared
// with that document, item by item, and anything short of identical is refused — a document that cannot
// be folded stays as it was (snapshot + ops), which is correct, only slower.
import { schCompare, schRank, pcbBlock, pcbCompare, placeFresh, canonicalLayerId, type BoardOrderCtx } from "./item-order";
import { prettify, type PrettifyMode } from "../canvas/prettify";
import { readQuoted } from "../canvas/sexpr";
import { CURRENT_VERSION, GENERATOR, GENERATOR_VERSION, minimumFileFormatVersion, usesEscapedStackedPinNotation, versionRaisedMessage, type FormatRequirement } from "../canvas/format-version";

/** The canvas functions used (window.KiCadCanvas in the host, the modules themselves in a test). */
export interface CanvasApi {
  parse(text: string): any;
  parseAll(text: string): any[];
  serialize(node: any): string;
  parseDoc(text: string, type: string): any;
  applyChange(doc: any, change: any, IU: number): boolean;
  /** canvas/legacy.ts downgradeSchNode: a symbol as KiCad writes it into a schematic kept at an older version. */
  downgradeSchNode?(node: any, version: number): any;
  /** canvas/legacy.ts migrateLegacyTree: what the parsers change while reading a file of an older version, in place. */
  migrateLegacyTree?(tree: any, pcb: boolean, version: number): void;
  /** canvas/legacy.ts upgradeLegacyNode: a stored item read at `from` in the form a file of version `to` stores it. */
  upgradeLegacyNode?(node: any, pcb: boolean, from: number, to: number): any;
}
export interface FoldOp { seq?: number; changes?: any[] }
/** `version`: the (version …) the result is stamped with; `notice`: KiCad's message when the edits made it raise the stamp. */
export type FoldResult = { ok: true; text: string; changed: number; version?: number; notice?: string } | { ok: false; reason: string };

const SCH_KINDS = new Set(["symbol", "wire", "bus", "junction", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label", "no_connect", "sheet", "text", "text_box", "polyline", "rectangle", "circle", "arc", "bezier", "bus_entry", "image",
  "table", "rule_area", "ellipse", "ellipse_arc", "net_chain", "group"]);
const PCB_KINDS = new Set(["footprint", "segment", "arc", "via", "zone", "gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_text", "gr_text_box", "gr_curve", "gr_bbox", "dimension", "target", "image", "group", "table", "generated",
  "gr_ellipse", "gr_ellipse_arc", "barcode", "point", "grid_item", "constraint"]);
/** Sections that close a file: new items go in before them. */
const TRAILERS = new Set(["sheet_instances", "symbol_instances", "embedded_fonts", "embedded_files"]);
const BOARD_SECTIONS = ["general", "layers", "setup"] as const;
/** The header every writer puts first, written afresh by every save (KiCad 5 boards say (host pcbnew …) instead). */
const HEADER = new Set(["version", "generator", "generator_version", "host"]);
/** A BOARD_SETUP property carrying one (file …) for the board's own (embedded_files …) (canvas/board-setup.ts). */
const EMBEDDED_FILE_PROP = "embedded_file";
/** BOARD_SETUP properties of Board Setup > Embedded Files: a file the board no longer keeps (its name), and Embed fonts ("yes" / "no"). */
const EMBEDDED_FILE_REMOVE_PROP = "embedded_file_remove", EMBEDDED_FONTS_PROP = "embedded_fonts";
/** A BOARD_SETUP property carrying the board's whole (net_chains …) section, "" to drop it (canvas/board-setup.ts). */
const NET_CHAINS_PROP = "net_chains";
/** A BOARD_SETUP property carrying the board's whole (variants …) registry, "" to drop it (canvas/board-setup.ts). */
const VARIANTS_PROP = "variants";

class Refuse extends Error {}
/** A board read item by item turned out to need a version raise past a reading boundary: read it whole and fold again. */
class Restart extends Error {}
const refuse = (why: string): never => { throw new Refuse(why); };

// ---------------------------------------------------------------- the file as spans

const isWs = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;
/** DSNLEXER: a line whose first non-blank character is '#' is a comment.  End of that line when s[i] starts one, else -1. */
function commentEnd(s: string, i: number): number {
  if (s.charCodeAt(i) !== 35) return -1;
  for (let k = i - 1; k >= 0; k--) { const c = s.charCodeAt(k); if (c === 10 || c === 13) break; if (c !== 32 && c !== 9) return -1; }
  let j = i; while (j < s.length && s.charCodeAt(j) !== 10 && s.charCodeAt(j) !== 13) j++;
  return j;
}
/** Past the blanks and comment lines from i. */
function skipBlank(s: string, i: number): number {
  const n = s.length;
  for (;;) { while (i < n && isWs(s.charCodeAt(i))) i++; const e = commentEnd(s, i); if (e < 0) return i; i = e; }
}
/** End (exclusive) of the element starting at i: a quoted string, a bare atom or a balanced list.  -1 when the text ends first. */
function elementEnd(s: string, i: number): number {
  const n = s.length, c = s.charCodeAt(i);
  if (c === 34) { let j = i + 1; while (j < n) { const d = s.charCodeAt(j); if (d === 92) j += 2; else if (d === 34) return j + 1; else j++; } return -1; }
  if (c === 40) {
    let depth = 0, j = i;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 34) { j = elementEnd(s, j); if (j < 0) return -1; continue; }
      if (d === 35) { const e = commentEnd(s, j); if (e >= 0) { j = e; continue; } }
      if (d === 40) depth++;
      else if (d === 41 && --depth === 0) return j + 1;
      j++;
    }
    return -1;
  }
  if (c === 41 || i >= n) return -1;
  let j = i; while (j < n) { const d = s.charCodeAt(j); if (isWs(d) || d === 40 || d === 41) break; j++; }
  return j;
}
interface Span { lead: string; text: string; head: string }
interface ListSpans { open: string; children: Span[]; tail: string }
/** A list cut into "(head", its elements (each with the whitespace before it) and what follows the last one. */
function cut(text: string): ListSpans | null {
  const n = text.length; const i = skipBlank(text, 0);
  if (text.charCodeAt(i) !== 40) return null;
  const headEnd = elementEnd(text, i + 1); if (headEnd < 0) return null;
  const children: Span[] = []; let prev = headEnd;
  for (;;) {
    const j = skipBlank(text, prev);
    if (j >= n) return null;
    if (text.charCodeAt(j) === 41) return { open: text.slice(0, headEnd), children, tail: text.slice(prev) };
    const e = elementEnd(text, j); if (e < 0) return null;
    const t = text.slice(j, e);
    children.push({ lead: text.slice(prev, j), text: t, head: headOf(t) });
    prev = e;
  }
}
function headOf(t: string): string { if (t.charCodeAt(0) !== 40) return ""; const e = elementEnd(t, 1); return e < 0 ? "" : t.slice(1, e); }
/** A quoted string's text, decoded as DSNLEXER decodes it (canvas/sexpr.ts readQuoted). */
const unquote = (t: string): string => (t.charCodeAt(0) !== 34 ? t : readQuoted(t, 1).s);
/** The first argument of a list when it is an atom or a string. */
function firstArg(t: string): string | null { const l = cut(t); if (!l || !l.children.length || l.children[0].head) return null; return unquote(l.children[0].text); }
function directValue(l: ListSpans, name: string): string | null { for (const c of l.children) if (c.head === name) return firstArg(c.text); return null; }
/** canvas/sexpr.ts uuidOf, on text. */
function uuidOfText(t: string): string {
  const l = cut(t); if (!l) return "";
  const u = directValue(l, "uuid") ?? directValue(l, "tstamp"); if (u) return u;
  if (headOf(t) === "net_chain") { const n = firstArg(t); return n === null ? "" : "net_chain:" + n; }
  if (headOf(t) === "rule_area") for (const c of l.children) if (c.head) { const inner = cut(c.text); const v = inner && directValue(inner, "uuid"); if (v) return v; }
  return "";
}

/** The items (by id) and library symbols (by name) a change's fragment carries, as text — canvas/ops.ts fragmentItems. */
function fragmentParts(frag: string, kinds: Set<string>, onItem: (id: string, text: string) => void, onLib: (name: string, text: string) => void): void {
  const walk = (t: string): void => {
    const h = headOf(t);
    if (h === "kicad_sch" || h === "kicad_pcb") { const l = cut(t); if (l) for (const c of l.children) if (c.head === "lib_symbols" || kinds.has(c.head)) walk(c.text); return; }
    if (h === "lib_symbols") { const l = cut(t); if (l) for (const c of l.children) if (c.head === "symbol") { const name = firstArg(c.text); if (name !== null) onLib(name, c.text); } return; }
    const id = uuidOfText(t); if (id) onItem(id, t);
  };
  let i = 0; const n = frag.length;
  for (;;) { while (i < n && isWs(frag.charCodeAt(i))) i++; if (i >= n) break; const e = elementEnd(frag, i); if (e < 0) break; walk(frag.slice(i, e)); i = e; }
}

/** The net names a board's items name with (net "name"), in file order (outside quoted strings and comment lines). */
function netNamesInOrder(file: string): string[] {
  const out: string[] = []; const n = file.length;
  for (let i = 0; i < n; i++) {
    const c = file.charCodeAt(i);
    if (c === 34) { const e = elementEnd(file, i); if (e < 0) break; i = e - 1; continue; }
    if (c === 35) { const e = commentEnd(file, i); if (e >= 0) { i = e - 1; continue; } }
    if (c !== 40 || file.slice(i + 1, i + 4) !== "net" || !isWs(file.charCodeAt(i + 4))) continue;
    const j = skipBlank(file, i + 4); if (file.charCodeAt(j) !== 34) continue;   // (net N …): a code, not a name
    const e = elementEnd(file, j); if (e < 0) break;
    out.push(unquote(file.slice(j, e))); i = e - 1;
  }
  return out;
}

// ---------------------------------------------------------------- writing

/** A node's text laid out as KiCad lays a file out, to sit at `depth` tabs. */
function laidOut(text: string, depth: number, mode: PrettifyMode): string {
  const p = prettify(text.trim(), mode).replace(/\s+$/, "");
  if (!depth) return p;
  // indent the lines, but not a line break inside a quoted string: that one is content
  const tabs = "\t".repeat(depth); let out = "", from = 0, quoted = false;
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (quoted) { if (c === 92) i++; else if (c === 34) quoted = false; }
    else if (c === 34) quoted = true;
    else if (c === 10) { out += p.slice(from, i + 1) + tabs; from = i + 1; }
  }
  return out + p.slice(from);
}

/**
 * The file `ops` make of `file`.  `ops` are the journal after the snapshot, in order.
 */
export function foldOps(k: CanvasApi, docType: string, file: string, ops: FoldOp[]): FoldResult {
  try {
    try { return fold(k, docType, file, ops, false); }
    catch (e) { if (e instanceof Restart) return fold(k, docType, file, ops, true); throw e; }
  } catch (e) { if (e instanceof Refuse) return { ok: false, reason: e.message }; return { ok: false, reason: "failed: " + (e instanceof Error ? e.message : String(e)) }; }
}

function fold(k: CanvasApi, docType: string, file: string, ops: FoldOp[], whole: boolean): FoldResult {
  const sch = docType === "kicad_sch"; if (!sch && docType !== "kicad_pcb") refuse("not a schematic or a board");
  const kinds = sch ? SCH_KINDS : PCB_KINDS, IU = sch ? 1e4 : 1e6;
  const top = cut(file) || refuse("the stored file is not one list");
  // KiCad 5 files name the paper (page A3): the parsers read it as (paper …) up to 20200119 (board) / 20200506 (schematic)
  const fileVersion = Number(directValue(top!, "version")) || 0;
  const pageIsPaper = fileVersion > 0 && fileVersion <= (sch ? 20200506 : 20200119) && !top!.children.some((c) => c.head === "paper");
  const isPaper = (head: string): boolean => head === "paper" || (pageIsPaper && head === "page");
  if (headOf(file.slice(skipBlank(file, 0))) !== docType) refuse("the stored file is not a " + docType);
  // KiCad 9 and later keep (font …), (stroke …) and (fill …) on one line; write new text the way the file is written
  const mode: PrettifyMode = /\(font \(/.test(file) ? "compactText" : "normal";
  const ser = (n: any): string => k.serialize(n);
  const canon = (t: string): string => { const n = k.parse(t); if (!n) refuse("unreadable text"); return ser(n); };

  // ---- the items of the stored file, and which of them the edits name
  const ids: string[] = top!.children.map((c) => (kinds.has(c.head) ? uuidOfText(c.text) : ""));
  const where = new Map<string, number>();   // item id -> index in top.children
  ids.forEach((id, i) => { if (!id) return; if (where.has(id)) refuse("two items share the id " + id); where.set(id, i); });   // (no id: no op can name it, it stays as it is)
  const touched = new Set<string>();
  for (const op of ops) for (const c of op.changes || []) {
    if (!c || typeof c !== "object") continue;
    if (c.id !== undefined) touched.add(String(c.id));
    const frag = c.sexpr || c.itemSexpr; if (typeof frag === "string") fragmentParts(frag, kinds, (id) => touched.add(id), () => undefined);
  }
  // A schematic is read whole (a removed symbol can take its library copy with it, which depends on every other
  // symbol).  On a board an edit concerns only the item it names, so only those are read: the rest of a large
  // board is never parsed, it is copied.
  // (A raised version that changes how stored items read makes every item a candidate for rewriting: then the whole
  // board is read.)
  const inDoc = (i: number): boolean => sch || whole || (ids[i] !== "" && touched.has(ids[i]));
  const subset = (l: ListSpans, take: (c: Span, i: number) => boolean): string => l.open + l.children.filter((c, i) => !kinds.has(c.head) || take(c, i)).map((c) => c.lead + c.text).join("") + l.tail;

  // ---- the document as every browser has it
  let doc = k.parseDoc(sch ? file : subset(top!, (_c, i) => inDoc(i)), docType) || refuse("the stored file could not be read");
  const before = new Map<string, string>(); for (const [id, it] of doc.items) before.set(id, ser(it.node));
  const libBefore = new Map<string, string>(); if (sch) for (const [name, n] of doc.lib) libBefore.set(name, ser(n));
  ids.forEach((id, i) => { if (id && inDoc(i) && !before.has(id)) refuse("item " + id + " is in the file but not in the document"); });
  for (const id of before.keys()) if (!where.has(id) && !id.startsWith("anon-")) refuse("item " + id + " is in the document but not in the file");

  // ---- the edits
  let paper: string | null = null, title: string | null = null; const sections: Record<string, string> = {};
  const embeds = new Map<string, string>();   // the board's (the root schematic's) embedded files an edit replaced or added, by name
  const embedsGone = new Set<string>();       // … and the ones an edit removed
  let fontsSet: boolean | null = null;        // (embedded_fonts …) as an edit set it; null: as stored
  const putEmbed = (text: string): void => {
    const l = cut(text); const name = l && headOf(text.trim()) === "file" ? directValue(l, "name") : null;
    if (name === null) refuse("an embedded file edit without a (file (name …) …)");
    embeds.set(name!, text.trim()); embedsGone.delete(name!);
  };
  const dropEmbed = (name: string): void => { embeds.delete(name); embedsGone.add(name); };
  let chainsText: string | null = null;   // the board's (net_chains …) as an edit set it ("" removes it); null: as stored
  let variantsText: string | null = null;   // the board's (variants …) as an edit set it ("" removes it); null: as stored
  const fragText = new Map<string, string>();   // the text an edit carried for an item or a library symbol
  const replacedBy = new Map<string, string>();   // an item given a new id (an ADDED with replaces): it takes the old one's place
  const noteFragment = (frag: string): void => fragmentParts(frag, kinds, (id, t) => fragText.set(id, t), (name, t) => fragText.set("lib:" + name, t));
  for (const op of ops) for (const c of op.changes || []) {
    if (!c || typeof c !== "object") continue;
    if (c.docProps) {
      const p = c.docProps;
      if (typeof p.paper === "string" && p.paper) { const n = k.parse(p.paper); if (n && n[0] === "paper") paper = p.paper.trim(); }
      if (typeof p.titleBlock === "string") { const n = p.titleBlock ? k.parse(p.titleBlock) : null; title = n && n[0] === "title_block" ? p.titleBlock.trim() : ""; }
      // the root schematic's embedded files (Schematic Setup > Embedded Files): files put, files removed, Embed fonts
      const ef = sch && p.embeddedFiles && typeof p.embeddedFiles === "object" ? p.embeddedFiles : null;
      if (ef) {
        for (const name of Array.isArray(ef.remove) ? ef.remove : []) if (typeof name === "string") dropEmbed(name);
        for (const t of Array.isArray(ef.put) ? ef.put : []) if (typeof t === "string") putEmbed(t);
        if (typeof ef.fonts === "boolean") fontsSet = ef.fonts;
      }
      continue;
    }
    if (c.typeName === "BOARD_SETUP") {
      if (sch) continue;
      for (const p of c.properties || []) {
        if (p && p.name === EMBEDDED_FILE_PROP && p.after && typeof p.after.v === "string") { putEmbed(p.after.v); continue; }
        if (p && p.name === EMBEDDED_FILE_REMOVE_PROP && p.after && typeof p.after.v === "string") { dropEmbed(p.after.v); continue; }
        if (p && p.name === EMBEDDED_FONTS_PROP && p.after && typeof p.after.v === "string") { fontsSet = p.after.v === "yes"; continue; }
        if (p && p.name === NET_CHAINS_PROP && p.after && typeof p.after.v === "string") {
          const v = p.after.v.trim();
          if (v && headOf(v) !== "net_chains") refuse("a net chains edit that is not a (net_chains …)");
          chainsText = v; continue;
        }
        if (p && p.name === VARIANTS_PROP && p.after && typeof p.after.v === "string") {
          const v = p.after.v.trim();
          if (v && headOf(v) !== "variants") refuse("a design variants edit that is not a (variants …)");
          variantsText = v; continue;
        }
        if (!p || !(BOARD_SECTIONS as readonly string[]).includes(p.name) || !p.after || typeof p.after.v !== "string") continue;
        const n = k.parse(p.after.v); if (!n) continue;
        if (n[0] !== p.name) refuse("a board setup edit names " + p.name + " but carries " + String(n[0]));
        sections[p.name] = p.after.v.trim();
      }
      continue;
    }
    const frag = c.sexpr || c.itemSexpr, kind = String(c.kind || "").toUpperCase();
    if (kind === "ADDED" && typeof c.replaces === "string" && c.id !== undefined) replacedBy.set(c.replaces, String(c.id));
    let ok = false;
    try { ok = k.applyChange(doc, c, IU); } catch (e) { refuse("an edit could not be applied: " + (e instanceof Error ? e.message : String(e))); }
    // the editors' own rule (editor/doc.ts mutateDoc): a removal or a value edit of an item that is not there is
    // nothing; a fragment that could not be taken means the copies differ, and then this one must not be written
    if (!ok && (frag || kind === "ADDED")) refuse("an edit to " + String(c.id) + " could not be applied");
    if (ok && typeof frag === "string") noteFragment(frag);
  }

  // ---- the file version: the stored one, raised only when what the edits wrote needs it (SCH_IO_KICAD_SEXPR /
  // PCB_IO_KICAD_SEXPR chooseFileFormatVersion over the body formatted at the loaded version); the items no edit
  // touched are the stored bytes, already readable at the stored version, so only the written ones are measured
  let writeAt = fileVersion, notice: string | undefined;
  const down = (node: any): any => (sch && writeAt > 0 && k.downgradeSchNode ? k.downgradeSchNode(node, writeAt) : node);
  let upgrading = false;   // the raise crosses a version below which stored items read differently
  const up = (node: any): any => (upgrading ? k.upgradeLegacyNode!(node, !sch, fileVersion, writeAt) : node);
  /** An item or library symbol in the form the new file writes it: read at the stored version, written at writeAt. */
  const form = (node: any): any => down(up(node));
  const written: any[] = [];   // the items and library symbols the new file writes rather than copies
  for (const [id, it] of doc.items) if (before.get(id) !== ser(it.node)) written.push(it.node);
  if (sch) for (const [name, n] of doc.lib) if (libBefore.get(name) !== ser(n)) written.push(n);
  const walk = (n: any, fn: (x: any) => void): void => { if (!Array.isArray(n)) return; fn(n); for (let j = 1; j < n.length; j++) walk(n[j], fn); };
  const child = (n: any, key: string): any => n.find((c: any, j: number) => j > 0 && Array.isArray(c) && c[0] === key) || null;
  if (fileVersion > 0) {
    const domain = sch ? "sch" : "pcb";
    const req: FormatRequirement = { version: 0, feature: null };
    const need = (r: FormatRequirement): void => { if (r.version > req.version) { req.version = r.version; req.feature = r.feature; } };
    const texts: string[] = written.map((n) => ser(down(n)));
    for (const t of [paper, title, ...Object.values(sections), ...embeds.values(), fontsSet !== null ? `(embedded_fonts ${fontsSet ? "yes" : "no"})` : null]) if (t) texts.push(t);
    for (const t of texts) need(minimumFileFormatVersion(t, domain));
    // the model checks the scan cannot make: escaped stacked pin numbers live inside quoted text; a footprint's
    // (height …) and an image's (rotate …) / (opacity …) are tokens older formats already use elsewhere
    for (const n of written) {
      if (sch && req.version < 20260622) walk(n, (x) => { if (x[0] !== "pin") return; const num = child(x, "number"); if (num && typeof num[1] === "string" && usesEscapedStackedPinNotation(num[1])) need({ version: 20260622, feature: "escaped special characters in stacked pin notation" }); });
      if (!sch && n[0] === "footprint" && req.version < 20261017) { const h = child(n, "height"); if (h && Number(h[1])) need({ version: 20261017, feature: "a footprint with an overall height" }); }
      if (!sch && n[0] === "image" && req.version < 20261025) { const r = child(n, "rotate"), o = child(n, "opacity"); if ((r && Number(r[1])) || (o && Number(o[1]) < 1)) need({ version: 20261025, feature: "a rotated or translucent reference image" }); }
    }
    if (req.version > fileVersion) {
      const chosen = Math.min(req.version, CURRENT_VERSION[domain]);
      // A raised stamp changes how this reader (and KiCad's) reads what is stored below it.  KiCad re-saves every item
      // from what it read, so each stored item that would read differently at the new version is written in its new
      // form (below); the rest keep their bytes, which mean the same at both versions.
      const all = file + "\n" + texts.join("\n");
      const crossing = (sch ? SCH_LEGACY_READINGS : PCB_LEGACY_READINGS).some(([upTo, inclusive, test]) => (inclusive ? fileVersion <= upTo && chosen > upTo : fileVersion < upTo && chosen >= upTo) && test(all, top!));
      if (crossing) {
        if (!sch && !whole) throw new Restart();
        if (!k.upgradeLegacyNode || !k.migrateLegacyTree) refuse("the edits need file format version " + chosen + ", where the stored items read differently, and this reader cannot rewrite them");
        upgrading = true;
      }
      writeAt = chosen;
      notice = versionRaisedMessage(sch ? "schematic" : "board", req.feature, fileVersion, chosen);
    }
  }

  // ---- the stored items, library symbols and sections that read differently at the raised version: written anew
  const rewrite = new Set<string>(), libRewrite = new Set<string>(), rewriteTop = new Map<number, string>();
  if (upgrading) {
    const restamped = top.open + top.children.map((c) => c.lead + (c.head === "version" ? `(version ${writeAt})` : c.text)).join("") + top.tail;
    const atNew = k.parseDoc(restamped, docType) || refuse("the stored file could not be read at version " + writeAt);
    for (const [id, it] of doc.items) {
      if (!where.has(id) || ser(it.node) !== before.get(id)) continue;   // a new or edited item is written anyway
      const now = atNew.items.get(id);
      if (!now || ser(form(it.node)) !== ser(down(now.node))) rewrite.add(id);
    }
    if (sch) for (const [name, n] of doc.lib) { if (libBefore.get(name) !== ser(n)) continue; const now = atNew.lib.get(name); if (!now || ser(form(n)) !== ser(down(now))) libRewrite.add(name); }
    // the sections no reader models (bus aliases, symbol instances, the board's net list and net classes): what the
    // parsers make of each at the stored version, where that is not what they make of it at the new one
    const OWN = new Set(["lib_symbols", "title_block", "net_chains", "embedded_files", "embedded_fonts", ...BOARD_SECTIONS]);
    top.children.forEach((c, i) => {
      if (!c.head || kinds.has(c.head) || HEADER.has(c.head) || isPaper(c.head) || OWN.has(c.head)) return;
      const was = [docType, k.parse(c.text)], is = [docType, k.parse(c.text)]; if (!was[1] || !is[1]) return;
      k.migrateLegacyTree!(was, !sch, fileVersion); k.migrateLegacyTree!(is, !sch, writeAt);
      if (ser(was[1]) !== ser(is[1])) rewriteTop.set(i, laidOut(ser(was[1]), 1, mode));
    });
    // a KiCad 5 (page …) is the paper only up to its version; a newer file names it (paper …)
    const pageAt = pageIsPaper && writeAt > (sch ? 20200506 : 20200119) ? top.children.findIndex((c) => c.head === "page") : -1;
    if (pageAt >= 0 && paper === null) {
      const l = cut(top.children[pageAt].text)!;
      paper = "(paper " + l.children.map((c, j) => (j === 0 ? '"' + unquote(c.text).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"' : c.text)).join(" ") + ")";
    }
  }

  // ---- a board kept before 20251028 names nets by number, and the parser resolves a number only through the board's
  // (net N "name") list (formatHeader writes one per net): a number the written items use that the stored list lacks
  // is declared, after the stored list (else after the setup), in code order
  const netAdds: string[] = [];
  if (!sch && writeAt > 0 && writeAt < 20251028) {
    const declared = new Set<number>();
    for (const c of top.children) if (c.head === "net") { const l = cut(c.text); const a = l && l.children[0]; if (a && !a.head) declared.add(Number(a.text)); }
    const missing = new Map<number, string>();
    for (const n of written) walk(n, (x) => {
      const net = child(x, "net"); if (!net || typeof net[1] !== "number" || net[1] <= 0 || declared.has(net[1])) return;
      const nn = child(x, "net_name"), name = typeof net[2] === "string" ? net[2] : nn && typeof nn[1] === "string" ? nn[1] : doc.nets && doc.nets.get(net[1]);
      if (typeof name === "string" && !missing.has(net[1])) missing.set(net[1], name);
    });
    const q = (t: string): string => '"' + t.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"';
    for (const code of Array.from(missing.keys()).sort((a, b) => a - b)) netAdds.push(`(net ${code} ${q(missing.get(code)!)})`);
  }
  let netAt = -1, setupAt = -1; top.children.forEach((c, i) => { if (c.head === "net") netAt = i; else if (c.head === "setup" && setupAt < 0) setupAt = i; });
  if (netAt < 0) netAt = setupAt; if (!netAdds.length) netAt = -1;
  if (netAdds.length && netAt < 0) refuse("the stored board has no (setup …) to declare new nets after");

  // ---- the new file
  /** The text for an item or library symbol as it now stands: the edit's own text when that is what it still is. */
  const textOf = (key: string, node: any, depth: number): string => {
    const dn = form(node); if (dn !== node) return laidOut(ser(dn), depth, mode);   // the older (or the raised) file's own form
    const now = ser(node), sent = fragText.get(key);
    let own = false; if (sent !== undefined) { try { own = canon(sent) === now; } catch { own = false; } }
    return laidOut(own ? sent! : now, depth, mode);
  };
  let changed = 0;
  const out: string[] = [top.open];
  const live = new Set<string>(); for (const id of doc.items.keys()) live.add(id);
  const freshById = new Map<string, string>(); for (const [id, it] of doc.items) if (!where.has(id) && !before.has(id)) freshById.set(id, textOf(id, it.node, 1));
  changed += freshById.size;
  // an item that only changed its id (Repair Board) is written where the old one was, not with the additions
  const inPlace = new Map<string, string>();
  for (const [old, now] of replacedBy) if (where.has(old) && !live.has(old) && freshById.has(now)) { inPlace.set(old, freshById.get(now)!); freshById.delete(now); }
  // where KiCad's next save puts each new item (mcp/item-order.ts): before a stored item, or after the last one (-1)
  const freshAt = new Map<number, string[]>(), fresh: string[] = [];
  if (freshById.size) {
    const nodeAt = (i: number): any => { const id = ids[i], it = id && doc.items.get(id); if (it) return it.node; try { return k.parse(top!.children[i].text); } catch { return null; } };
    const stored: { at: number; node: () => any }[] = []; top.children.forEach((c, i) => { if (kinds.has(c.head)) { let n: any; stored.push({ at: i, node: () => (n === undefined ? (n = nodeAt(i)) : n) }); } });
    const freshNodes = Array.from(freshById.keys()).map((id) => doc.items.get(id).node);
    const textOfNode = new Map<any, string>(); for (const id of freshById.keys()) textOfNode.set(doc.items.get(id).node, freshById.get(id)!);
    let block: (n: any) => number | null, cmp: (a: any, b: any) => number;
    if (sch) { block = (n) => (schRank(n) === null ? null : 0); cmp = (a, b) => schCompare(a, b) ?? 0; }
    else {
      // PCB_LAYER_ID by name: the canonical names have one id in every version (an older file's table numbers them
      // its own way, which the parser maps); a name the board's table alone knows takes the table's id
      const layer = new Map<string, number>(); for (const [name, l] of doc.layers || []) layer.set(name, canonicalLayerId(name) ?? Number(l.id));
      const copper = Array.from(layer).filter(([n]) => /\.Cu$/.test(n)).map(([, id]) => id);
      // the copper stack, top down: F.Cu, In1.Cu … B.Cu
      const copperStack = copper.slice().sort((x, y) => (x === 2 ? 1 : y === 2 ? -1 : x - y));
      // the net codes: a board with a (net N "name") table keeps those codes; one without (20251028 and later) gets
      // them as the parser meets each new name (parseNet: NETINFO_LIST::AppendNet, getFreeNetCode), in file order
      const nets = new Map<string, number>(); for (const [code, name] of doc.nets || []) if (!nets.has(name)) nets.set(name, Number(code));
      const table = top.children.some((c) => c.head === "net"); let next = 1;
      if (!table) { nets.clear(); nets.set("", 0); for (const name of netNamesInOrder(file)) if (!nets.has(name)) nets.set(name, next++); }
      else for (const v of nets.values()) next = Math.max(next, v + 1);
      // BOARD_DESIGN_SETTINGS m_TentViasFront / Back: the setup's (tenting …) (true when it has none), or the legacy
      // plot parameter (viasonmask …)
      const tentVias: [boolean, boolean] = [true, true];
      { const st = top.children.find((c) => c.head === "setup"); const sn = st ? k.parse(st.text) : null;
        const t = sn ? sn.find((c: any, j: number) => j > 0 && Array.isArray(c) && c[0] === "tenting") : null;
        if (t) {
          const legacy = t.slice(1).every((c: any) => !Array.isArray(c)); let f: boolean | null = null, b: boolean | null = null;
          if (legacy) { for (const c of t.slice(1)) { if (c === "front") f = true; else if (c === "back") b = true; else if (c === "none") { f = null; b = null; } } }
          else for (const key of ["front", "back"]) { const v = t.find((c: any, j: number) => j > 0 && Array.isArray(c) && c[0] === key); const x = v ? String(v[1]) : "none"; const r = x === "yes" ? true : x === "no" ? false : null; if (key === "front") f = r; else b = r; }
          tentVias[0] = f ?? false; tentVias[1] = b ?? false;
        }
        const pp = sn ? sn.find((c: any, j: number) => j > 0 && Array.isArray(c) && c[0] === "pcbplotparams") : null;
        const vm = pp ? pp.find((c: any, j: number) => j > 0 && Array.isArray(c) && c[0] === "viasonmask") : null;
        if (vm) { const tent = !(String(vm[1]) === "true" || String(vm[1]) === "yes"); tentVias[0] = tent; tentVias[1] = tent; } }
      const byId = new Map<string, number>(); ids.forEach((id, i) => { if (id) byId.set(id.toLowerCase(), i); });
      const ctx: BoardOrderCtx = {
        version: fileVersion, copperStack, tentVias,
        nodeById: (id) => { const live = doc.items.get(id); if (live) return live.node; const i = byId.get(id.toLowerCase()); return i === undefined ? null : nodeAt(i); },
        layerId: (name) => layer.get(name) ?? canonicalLayerId(name) ?? -1,
        layerIds: (name) => (name === "*.Cu" ? copper : name === "F&B.Cu" ? [layer.get("F.Cu") ?? -1, layer.get("B.Cu") ?? -1] : /^\*\./.test(name) ? [layer.get("F" + name.slice(1)) ?? -1, layer.get("B" + name.slice(1)) ?? -1] : [layer.get(name) ?? -1]),
        netCode: (n) => { const c = (n as any[]).find((x: any, j: number) => j > 0 && Array.isArray(x) && x[0] === "net"); if (!c) return 0; if (typeof c[1] === "number") return c[1]; const name = String(c[1]); if (!nets.has(name)) nets.set(name, next++); return nets.get(name)!; },
      };
      block = (n) => pcbBlock(n); cmp = (a, b) => pcbCompare(a, b, ctx);
    }
    const placed = placeFresh(stored, freshNodes, block, cmp);
    const groups = new Map<number, any[]>(); for (const p of placed) { const g = groups.get(p.before) || []; g.push(p.node); groups.set(p.before, g); }
    for (const [at, nodes] of groups) {
      const key = (n: any): number => block(n) ?? Infinity;
      const texts = nodes.slice().sort((x, y) => (key(x) !== key(y) ? (key(x) < key(y) ? -1 : 1) : key(x) === Infinity ? 0 : cmp(x, y))).map((n) => textOfNode.get(n)!);
      if (at >= 0) freshAt.set(at, texts); else fresh.push(...texts);
    }
  }

  // where additions go: after the last item of the stored file, else before the sections that close it, else at the end
  let lastItem = -1, firstTrailer = -1, paperAt = -1, titleAt = -1, libAt = -1, filesAt = -1, fontsAt = -1, chainsAt = -1, variantsAt = -1; const sectionAt: Record<string, number> = {};
  top.children.forEach((c, i) => {
    if (kinds.has(c.head)) lastItem = i;
    else if (TRAILERS.has(c.head)) { if (firstTrailer < 0) firstTrailer = i; if (c.head === "embedded_files" && filesAt < 0) filesAt = i; if (c.head === "embedded_fonts" && fontsAt < 0) fontsAt = i; }
    else if (isPaper(c.head)) { if (paperAt < 0) paperAt = i; }
    else if (c.head === "title_block") { if (titleAt < 0) titleAt = i; }
    else if (c.head === "lib_symbols") { if (libAt < 0) libAt = i; }
    else if (c.head === "net_chains" && !sch) { if (chainsAt < 0) chainsAt = i; }
    else if (c.head === "variants" && !sch) { if (variantsAt < 0) variantsAt = i; }
    else if ((BOARD_SECTIONS as readonly string[]).includes(c.head)) { if (!(c.head in sectionAt)) sectionAt[c.head] = i; }
  });
  if ((paper !== null || title) && paperAt < 0) refuse("the stored file has no (paper …) section");
  for (const name of Object.keys(sections)) if (!(name in sectionAt)) refuse("the stored board has no (" + name + " …) section to replace");

  // library symbols (schematic): the stored ones in place, the ones an edit brought after them
  let libText: string | null = null;   // null: as stored
  if (sch) {
    const lib = libAt >= 0 ? cut(top.children[libAt].text) : null;
    if (libAt >= 0 && !lib) refuse("unreadable (lib_symbols …)");
    const stored = new Set<string>(); let touched = false; const parts: string[] = [];
    if (lib) for (const c of lib.children) {
      if (c.head !== "symbol") { parts.push(c.lead + c.text); continue; }
      const name = firstArg(c.text); if (name === null) refuse("a library symbol without a name");
      if (stored.has(name!)) refuse("two library symbols are named " + name);
      if (!libBefore.has(name!)) refuse("library symbol " + name + " is in the file but not in the document");
      stored.add(name!);
      const node = doc.lib.get(name!);
      if (!node) { touched = true; continue; }                                   // no symbol uses it any more
      if (ser(node) === libBefore.get(name!) && !libRewrite.has(name!)) parts.push(c.lead + c.text);
      else { touched = true; parts.push(c.lead + textOf("lib:" + name, node, 2)); }
    }
    for (const name of libBefore.keys()) if (!stored.has(name)) refuse("library symbol " + name + " is in the document but not in the file");
    for (const [name, node] of doc.lib) if (!stored.has(name)) { touched = true; parts.push("\n\t\t" + textOf("lib:" + name, node, 2)); }
    if (touched) { changed++; libText = (lib ? lib.open : "(lib_symbols") + parts.join("") + (lib ? lib.tail : "\n\t)"); }
  }

  const add = (texts: string[]): void => { for (const t of texts) out.push("\n\t" + t); };
  const same = (a: string, b: string): boolean => { try { return canon(a) === canon(b); } catch { return false; } };
  // the board's (root schematic's) own embedded files: the stored section with the files an edit carried in place of
  // theirs, new ones last, removed ones gone; "" when none is left (WriteEmbeddedFiles is not called for an empty set)
  let filesText: string | null = null;   // null: as stored
  if (embeds.size || embedsGone.size) {
    const l = filesAt >= 0 ? cut(top.children[filesAt].text) : null;
    if (filesAt >= 0 && !l) refuse("unreadable (embedded_files …)");
    const parts: string[] = [], done = new Set<string>(); let touched = false;
    if (l) for (const c of l.children) {
      const inner = c.head === "file" ? cut(c.text) : null, name = inner ? directValue(inner, "name") : null;
      if (name !== null && embedsGone.has(name)) { touched = true; continue; }
      const put = name !== null ? embeds.get(name) : undefined;
      if (put === undefined) { parts.push(c.lead + c.text); continue; }
      done.add(name!);
      if (same(put, c.text)) parts.push(c.lead + c.text); else { touched = true; parts.push(c.lead + laidOut(put, 2, mode)); }
    }
    for (const [name, t] of embeds) if (!done.has(name)) { touched = true; parts.push("\n\t\t" + laidOut(t, 2, mode)); }
    if (touched) { changed++; filesText = parts.some((t) => /^\s*\(file[\s)]/.test(t)) ? (l ? l.open : "(embedded_files") + parts.join("") + (l ? l.tail : "\n\t)") : ""; }
  }
  // (embedded_fonts yes|no): in place, else just before the files (KiCad writes it last but for them)
  let fontsText: string | null = null;
  if (fontsSet !== null) {
    fontsText = `(embedded_fonts ${fontsSet ? "yes" : "no"})`;
    if (fontsAt >= 0 ? !same(fontsText, top.children[fontsAt].text) : true) changed++;
  }
  // the net chains: in place of the stored section, else after the items (before the sections that close the board)
  let chainsDone = chainsText === null || (chainsAt < 0 && !chainsText);
  if (!sch && chainsText !== null && (chainsAt >= 0 ? !same(chainsText, top.children[chainsAt].text) || !chainsText : !!chainsText)) changed++;
  // the design variants (formatVariants): in place of the stored section, else after the setup, properties and nets
  let variantsAnchor = -1; top.children.forEach((c, i) => { if (c.head === "setup" || c.head === "property" || c.head === "net") variantsAnchor = i; });
  let variantsDone = variantsText === null || (variantsAt < 0 && !variantsText);
  if (!sch && variantsText !== null && (variantsAt >= 0 ? !same(variantsText, top.children[variantsAt].text) || !variantsText : !!variantsText)) changed++;
  if (!variantsDone && variantsAt < 0 && variantsAnchor < 0) refuse("the stored board has no (setup …) to put the design variants after");
  let freshDone = false;
  const hdr: Record<string, [number, string]> = {};   // header child -> its place in out, its lead
  top.children.forEach((c, i) => {
    if (i === firstTrailer && lastItem < 0 && !freshDone) { if (libText !== null && libAt < 0) out.push("\n\t" + libText); add(fresh); freshDone = true; }
    if (i === firstTrailer && !chainsDone && chainsAt < 0 && freshDone) { out.push("\n\t" + laidOut(chainsText!, 1, mode)); chainsDone = true; }
    if (freshAt.has(i)) add(freshAt.get(i)!);
    if (HEADER.has(c.head) && !(c.head in hdr)) { hdr[c.head] = [out.length, c.lead]; out.push(c.lead + c.text); }
    else if (i === paperAt) {
      if (paper !== null && !same(paper, c.text)) { out.push(c.lead + laidOut(paper, 1, mode)); changed++; } else out.push(c.lead + c.text);
      if (title && titleAt < 0) { out.push("\n\t" + laidOut(title, 1, mode)); changed++; }
    } else if (i === titleAt) {
      if (title === null || (title && same(title, c.text))) out.push(c.lead + c.text);
      else { changed++; if (title) out.push(c.lead + laidOut(title, 1, mode)); }
    } else if (i === libAt && sch) out.push(c.lead + (libText !== null ? libText : c.text));
    else if (!sch && sectionAt[c.head] === i && sections[c.head] !== undefined && !same(sections[c.head], c.text)) { out.push(c.lead + laidOut(sections[c.head], 1, mode)); changed++; }
    else if (i === fontsAt && fontsText !== null) out.push(c.lead + (same(fontsText, c.text) ? c.text : fontsText));
    else if (i === filesAt && (filesText !== null || (fontsText !== null && fontsAt < 0))) { if (fontsText !== null && fontsAt < 0) out.push(c.lead + fontsText); if (filesText !== "") out.push((fontsText !== null && fontsAt < 0 ? "\n\t" : c.lead) + (filesText !== null ? filesText : c.text)); }
    else if (i === chainsAt && chainsText !== null) { if (chainsText) out.push(c.lead + (same(chainsText, c.text) ? c.text : laidOut(chainsText, 1, mode))); chainsDone = true; }
    else if (i === variantsAt && variantsText !== null) { if (variantsText) out.push(c.lead + (same(variantsText, c.text) ? c.text : laidOut(variantsText, 1, mode))); variantsDone = true; }
    else if (kinds.has(c.head)) {
      const id = ids[i];
      if (!id || !inDoc(i)) out.push(c.lead + c.text);                          // not named by any edit: as stored
      else if (!live.has(id)) { changed++; const t = inPlace.get(id); if (t !== undefined) out.push(c.lead + t); }   // removed (or re-id'd in place)
      else {
        const node = doc.items.get(id).node;
        if (ser(node) === before.get(id) && !rewrite.has(id)) out.push(c.lead + c.text);
        else { out.push(c.lead + textOf(id, node, 1)); changed++; }
      }
    } else if (rewriteTop.has(i)) { out.push(c.lead + rewriteTop.get(i)!); changed++; }
    else out.push(c.lead + c.text);
    if (i === netAt) add(netAdds);
    if (i === variantsAnchor && !variantsDone && variantsAt < 0) { out.push("\n\t" + laidOut(variantsText!, 1, mode)); variantsDone = true; }
    if (i === lastItem && !freshDone) { if (libText !== null && libAt < 0) out.push("\n\t" + libText); add(fresh); freshDone = true; }
  });
  if (!freshDone) { if (libText !== null && libAt < 0) out.push("\n\t" + libText); add(fresh); }
  if (!chainsDone) out.push("\n\t" + laidOut(chainsText!, 1, mode));
  if (fontsText !== null && fontsAt < 0 && filesAt < 0) out.push("\n\t" + fontsText);
  if (filesText && filesAt < 0) out.push("\n\t" + filesText);   // a file with no embedded files: the section closes it
  out.push(top.tail);
  if (!changed) return { ok: true, text: file, changed: 0 };
  // every save writes the header afresh: (version N) (generator "eeschema"|"pcbnew") (generator_version "<major.minor>")
  const gen = `(generator "${GENERATOR[sch ? "sch" : "pcb"]}")`, genVer = `(generator_version "${GENERATOR_VERSION}")`;
  const setHdr = (key: string, t: string): void => { const [at, lead] = hdr[key]; out[at] = lead + t; };
  if (hdr.version && writeAt !== fileVersion) setHdr("version", `(version ${writeAt})`);
  if (hdr.host) { setHdr("host", gen + " " + genVer); if (hdr.generator) setHdr("generator", ""); if (hdr.generator_version) setHdr("generator_version", ""); }
  else if (hdr.generator) { setHdr("generator", gen); if (hdr.generator_version) setHdr("generator_version", genVer); else out[hdr.generator[0]] += " " + genVer; }
  else if (hdr.version) out[hdr.version[0]] += " " + gen + " " + genVer;
  const text = out.join("");

  // ---- read it back: it must be the document, and everything else must be the stored bytes
  const topBack = cut(text) || refuse("the new file is not one list");
  const want = new Map<string, string>(), wantLib = new Map<string, string>(); let anonA = 0, anonB = 0;
  // (compared as written: a symbol in an older schematic is written in that version's form)
  for (const [id, it] of doc.items) { if (id.startsWith("anon-")) anonA++; else want.set(id, ser(form(it.node))); }
  if (sch) for (const [name, n] of doc.lib) wantLib.set(name, ser(form(n)));
  doc = null; before.clear(); libBefore.clear(); fragText.clear();   // (a large document is not held twice)
  // items no edit named: each still there, once, as the stored text
  const seen = new Set<string>(); let unnamedWas = 0, unnamedIs = 0;
  ids.forEach((id, i) => { if (kinds.has(top!.children[i].head) && !id) unnamedWas++; });
  const read = (c: Span): boolean => {   // whether this element of the new file goes through the reader
    if (sch) return true;
    const id = uuidOfText(c.text); if (!id) { unnamedIs++; return false; }
    if (seen.has(id)) refuse("the new file has two items with the id " + id); seen.add(id);
    if (want.has(id)) return true;
    const at = where.get(id); if (at === undefined || inDoc(at) || top!.children[at].text !== c.text) refuse("item " + id + " came out differently");
    return false;
  };
  const backText = sch ? text : subset(topBack!, (c) => read(c));
  if (!sch) {
    if (unnamedWas !== unnamedIs) refuse("the new file has a different number of unnamed items");
    ids.forEach((id, i) => { if (id && !inDoc(i) && !seen.has(id)) refuse("item " + id + " is missing from the new file"); });
  }
  const back = k.parseDoc(backText, docType) || refuse("the new file could not be read back");
  for (const [id, it] of back.items) { if (id.startsWith("anon-")) { anonB++; continue; } const w = want.get(id); if (w === undefined) refuse("item " + id + " is in the new file but not in the document"); if (ser(down(it.node)) !== w) refuse("item " + id + " reads back differently"); }
  for (const id of want.keys()) if (!back.items.has(id)) refuse("item " + id + " is missing from the new file");
  if (anonA !== anonB) refuse("the new file has a different number of unnamed items");
  if (sch) {
    if (back.lib.size !== wantLib.size) refuse("the new file has a different set of library symbols");
    for (const [name, w] of wantLib) { const b = back.lib.get(name); if (!b || ser(down(b)) !== w) refuse("library symbol " + name + " reads back differently"); }
  }
  const kept = (l: ListSpans, now?: Map<number, string>): string[] => l.children.map((c, i) => (now && now.has(i) ? { ...c, text: now.get(i)! } : c)).filter((c) => !kinds.has(c.head) && !HEADER.has(c.head) && !isPaper(c.head) && c.head !== "title_block" && c.head !== "lib_symbols" && !(!sch && (BOARD_SECTIONS as readonly string[]).includes(c.head)) && !(filesText !== null && c.head === "embedded_files") && !(fontsText !== null && c.head === "embedded_fonts") && !(chainsText !== null && c.head === "net_chains") && !(variantsText !== null && c.head === "variants")).map((c) => c.text);
  const added = new Set(netAdds), a = kept(top, rewriteTop), b = kept(topBack!).filter((t) => !added.has(t));
  if (a.length !== b.length || a.some((t, i) => t !== b[i]) || top.open !== topBack!.open) refuse("a section no edit touched came out differently");
  const section = (l: ListSpans, name: string): string | null => { const c = l.children.find((x) => (name === "paper" ? isPaper(x.head) : x.head === name)); return c ? c.text : null; };
  const expect = (name: string, set: string | null | undefined): void => {
    const was = section(top!, name), is = section(topBack!, name);
    const want = set === undefined || set === null ? was : set === "" ? null : set;
    if ((want === null) !== (is === null) || (want !== null && !same(want, is!))) refuse("the (" + name + " …) section reads back differently");
  };
  if (fileVersion > 0 && Number(directValue(topBack!, "version")) !== writeAt) refuse("the new file has the wrong (version …)");
  const genBack = topBack!.children.filter((c) => c.head === "generator" || c.head === "generator_version").map((c) => c.text).join(" ");
  if (topBack!.children.some((c) => c.head === "host") || (top.children.some((c) => HEADER.has(c.head) && c.head !== "version") && genBack !== gen + " " + genVer)) refuse("the new file has the wrong (generator …)");
  expect("paper", paper); expect("title_block", title);
  if (!sch) for (const name of BOARD_SECTIONS) expect(name, sections[name]);
  if (!sch) expect("net_chains", chainsText);
  if (!sch) expect("variants", variantsText);
  if (fontsText !== null) expect("embedded_fonts", fontsText);
  if (filesText === "" && topBack!.children.some((c) => c.head === "embedded_files")) refuse("the (embedded_files …) section reads back differently");
  if (filesText) {
    // the files no edit carried as stored, the ones an edit carried as it carried them, the removed ones gone
    const was = filesAt >= 0 ? cut(top.children[filesAt].text) : null, is = topBack!.children.filter((c) => c.head === "embedded_files");
    const back = is.length === 1 ? cut(is[0].text) : null; if (!back) refuse("the (embedded_files …) section reads back differently");
    const files = (x: ListSpans | null): Map<string, string> => { const m = new Map<string, string>(); if (x) for (const c of x.children) { const inner = c.head === "file" ? cut(c.text) : null; const n = inner ? directValue(inner, "name") : null; m.set(n ?? "#" + m.size, c.text); } return m; };
    const a0 = files(was), b0 = files(back);
    for (const [name, t] of embeds) a0.set(name, t);
    for (const name of embedsGone) a0.delete(name);
    if (a0.size !== b0.size) refuse("the (embedded_files …) section reads back differently");
    for (const [name, t] of a0) { const b1 = b0.get(name); if (b1 === undefined || (embeds.has(name) ? !same(t, b1) : t !== b1)) refuse("embedded file " + name + " reads back differently"); }
  }
  return writeAt !== fileVersion ? { ok: true, text, changed, version: writeAt, notice } : { ok: true, text, changed };
}

/**
 * What the parsers read differently below a version (canvas/legacy.ts, and the readers that go by the version: the
 * legacy bold pen, the image PPI scale, footprint zones and points in board frame, via protection off): [version,
 * whether the legacy reading includes that version itself, whether the file may have something read that way, what].
 * A raise across one of these compares every stored item at both versions and rewrites the ones that differ.
 */
type LegacyReading = [number, boolean, (file: string, top: ListSpans) => boolean, string];
const BOLD_PEN = /\(thickness [^()]*\)\s*(?:\(bold(?:\s+yes)?\)|bold\b)/;
const SCH_LEGACY_READINGS: LegacyReading[] = [
  [20200506, true, (_f, top) => top.children.some((c) => c.head === "page") && !top.children.some((c) => c.head === "paper"), "a KiCad 5 page size"],
  [20210606, false, (f) => f.indexOf("~") >= 0, "the old overbar notation"],
  [20210621, false, (f) => /\(bus_alias/.test(f), "bus aliases in the old overbar notation"],
  [20211123, true, (f) => /\(polyline/.test(f), "KiCad 6 polylines"],
  [20230121, true, (f) => /\(arc/.test(f), "pre-7.0 symbol arcs"],
  [20230121, true, (f) => /\(image/.test(f), "reference images at 300 PPI"],
  [20250318, false, (f) => /"~"|[\s(]~[\s)]/.test(f), "\"~\" as an empty value"],
  [20260623, false, (f) => /\(image/.test(f), "reference image scale"],
  [20260826, false, (f) => BOLD_PEN.test(f), "bold text width"],
];
const PCB_LEGACY_READINGS: LegacyReading[] = [
  [20200119, true, (_f, top) => top.children.some((c) => c.head === "page") && !top.children.some((c) => c.head === "paper"), "a KiCad 5 page size"],
  [20210606, false, (f) => f.indexOf("~") >= 0, "the old overbar notation"],
  [20211014, true, (f) => /\bcustom\b/.test(f), "custom pad spoke angle"],
  [20240201, true, (f) => /\((?:solder_mask_margin|solder_paste_margin|solder_paste_margin_ratio|solder_paste_ratio|clearance) [-+]?0*\.?0*\)/.test(f), "a local override of 0"],
  [20250228, false, (f) => /\(via[\s)]/.test(f), "via protection"],
  [20260616, false, (_f, top) => top.children.some((c) => c.head === "footprint" && /\((?:zone|point)[\s)]/.test(c.text)), "footprint zones and points in board coordinates"],
  [20260623, false, (f) => /\(image/.test(f), "reference image scale"],
  [20260826, false, (f) => BOLD_PEN.test(f), "bold text width"],
];
