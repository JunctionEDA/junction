// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/domains/pcb/canvas/index.ts — edit these modules, not the bundle).
//
// ---------------------------------------------------------------- the drawing sheet
//
// KiCad's page is not a rectangle: it is the (kicad_wks …) drawing sheet, drawn by
// common/drawing_sheet/.  This module transcribes KiCad's built-in sheet verbatim
// (common/drawing_sheet/drawing_sheet_default_description.cpp `defaultDrawingSheet`)
// and interprets it the way DS_DATA_ITEM / DS_DRAW_ITEM_LIST do, so the repeats,
// the tick labels and the title-block text all fall out of the same description
// instead of being hand-unrolled here.
//
// Coordinates.  Every point in a wks description is measured from a page CORNER of
// the *framed* area — the paper inset by the (setup …) margins — and grows towards
// the opposite corner (DS_DATA_ITEM::GetStartPos, ds_data_item.cpp:263-291):
//     LT = (leftMargin, topMargin)                              (ds_data_model.cpp:88-105)
//     RB = (pageWidth - rightMargin, pageHeight - bottomMargin)
//     rbcorner (the default): RB - p      rtcorner: (RB.x - p.x, LT.y + p.y)
//     lbcorner: (LT.x + p.x, RB.y - p.y)  ltcorner: LT + p
// (repeat N) (incrx dx) (incry dy) emit N copies at p + (dx, dy)·j — the increment is
// applied to start and end alike, which is how one (rect … (repeat 2) (incrx 2) (incry 2))
// draws both frame rectangles.  A copy is dropped when it walks off the framed area
// (DS_DATA_ITEM::IsInsidePage, :338-358); copy 0 is always kept.  Repeated text steps its
// label from the base text by an absolute delta each time (DS_DATA_ITEM_TEXT::IncrementLabel,
// :621-633, via STRING_INCREMENTER, common/increment.cpp:83-243) — "1" 2 3 …, "A" B C … Z AA AB.
//
// Text.  Sizes and pen widths follow DS_DATA_ITEM_TEXT::SyncDrawItems (:521-606) and
// EDA_TEXT::GetEffectiveTextPenWidth: 1.5 mm / 0.15 mm by default, and bold text feeds
// pen 0 so the auto-bold width (size/5) applies — 0.30 mm for the bold 1.5 mm fields,
// 0.40 mm for the 2 mm bold-italic title.  Justification defaults to left / vertically
// centred, and `(justify center)` sets BOTH axes (drawing_sheet_parser.cpp:820-845), which
// is why only the A/B/C row labels are centred and the 1/2/3 column labels are not.
//
// Nothing here touches a canvas: buildDrawingSheet() returns plain records so render()
// (canvas) and renderSvg() (export) can paint the same geometry.
import { kids, num, parse, pointInPoly, str } from "./sexpr";
import { INTERLINE, convertToNewOverbarNotation, parseMarkup, textWidth } from "./text";
import { base64Bytes, imageInfo } from "./tables-images";
import { evaluateText } from "./text-eval";
import type { Pt, SheetContext } from "./types";

/** A point of a wks item: an offset from one corner of the framed area (lt / lb / rt / rb). */
export interface WksCoord { x: number; y: number; anchor: string }
/** One (rect …) / (line …) / (tbtext …) of a drawing-sheet description. */
export interface WksItem {
  kind: string; repeat: number; incr: [number, number]; incrLabel: number; lineWidth: number; option: string; rot: number;
  bold: boolean; italic: boolean; sizeX: number; sizeY: number; color: string | null; hjust: string; vjust: string;
  maxlen: number; maxheight: number; text: string; start?: WksCoord; end?: WksCoord;
  /** a (polygon …): its (pts …) outlines, each closed, in the item's own frame (turned by `rot` about the origin) */
  contours?: Pt[][];
  /** a (bitmap …): the image as base64, its (scale …) and the header's pixel size and PPI */
  bitmap?: { b64: string; scale: number; mime: string; w: number; h: number; ppi: number };
}
/** A parsed (kicad_wks …): the page setup and the items. */
export interface DrawingSheet { setup: typeof WKS_DEFAULTS; items: WksItem[] }
/** One draw record of the sheet for a page (buildDrawingSheet). */
export type SheetDraw =
  | { t: "line"; x1: number; y1: number; x2: number; y2: number; w: number }
  | { t: "rect"; x: number; y: number; w: number; h: number; lw: number }
  | { t: "text"; x: number; y: number; text: string; size: number; sizeX: number; w: number; bold: boolean; italic: boolean; h: string; v: string; rot: number; color: string | null; multiline: boolean }
  /** DS_DRAW_ITEM_POLYPOLYGONS: each outline filled in the sheet colour, no stroke */
  | { t: "poly"; polys: Pt[][] }
  /** DS_DRAW_ITEM_BITMAP: the image centred on its position, `x, y` its top-left corner */
  | { t: "image"; x: number; y: number; w: number; h: number; b64: string; url: string };
/** The text-variable map the title block resolves (sheetTextVars). */
export type SheetVars = Record<string, string>;
/** What a resolver answers: the value, null for an untouched miss, or { ref } for a token it rewrote and then refused. */
export type VarValue = string | null | undefined | { ref: string };
export type VarResolver = (token: string) => VarValue;

/** common/drawing_sheet/drawing_sheet_default_description.cpp:117-151, verbatim. */
export const DEFAULT_DRAWING_SHEET = `(kicad_wks (version 20210606) (generator pl_editor)
(setup (textsize 1.5 1.5)(linewidth 0.15)(textlinewidth 0.15)
(left_margin 10)(right_margin 10)(top_margin 10)(bottom_margin 10))
(rect (name "") (start 110 34) (end 2 2) (comment "rect around the title block"))
(rect (name "") (start 0 0 ltcorner) (end 0 0) (repeat 2) (incrx 2) (incry 2))
(line (name "") (start 50 2 ltcorner) (end 50 0 ltcorner) (repeat 30) (incrx 50))
(tbtext "1" (name "") (pos 25 1 ltcorner) (font (size 1.3 1.3)) (repeat 100) (incrx 50))
(line (name "") (start 50 2 lbcorner) (end 50 0 lbcorner) (repeat 30) (incrx 50))
(tbtext "1" (name "") (pos 25 1 lbcorner) (font (size 1.3 1.3)) (repeat 100) (incrx 50))
(line (name "") (start 0 50 ltcorner) (end 2 50 ltcorner) (repeat 30) (incry 50))
(tbtext "A" (name "") (pos 1 25 ltcorner) (font (size 1.3 1.3)) (justify center) (repeat 100) (incry 50))
(line (name "") (start 0 50 rtcorner) (end 2 50 rtcorner) (repeat 30) (incry 50))
(tbtext "A" (name "") (pos 1 25 rtcorner) (font (size 1.3 1.3)) (justify center) (repeat 100) (incry 50))
(tbtext "Date: \${ISSUE_DATE}" (name "") (pos 87 6.9))
(line (name "") (start 110 5.5) (end 2 5.5))
(tbtext "\${KICAD_VERSION}" (name "") (pos 109 4.1) (comment "Kicad version"))
(line (name "") (start 110 8.5) (end 2 8.5))
(tbtext "Rev: \${REVISION}" (name "") (pos 24 6.9) (font bold))
(tbtext "Size: \${PAPER}" (name "") (pos 109 6.9) (comment "Paper format name"))
(tbtext "Id: \${#}/\${##}" (name "") (pos 24 4.1) (comment "Sheet id"))
(line (name "") (start 110 12.5) (end 2 12.5))
(tbtext "Title: \${TITLE}" (name "") (pos 109 10.7) (font (size 2 2) bold italic))
(tbtext "File: \${FILENAME}" (name "") (pos 109 14.3))
(line (name "") (start 110 18.5) (end 2 18.5))
(tbtext "Sheet: \${SHEETPATH}" (name "") (pos 109 17))
(tbtext "\${COMPANY}" (name "") (pos 109 20) (font bold) (comment "Company name"))
(tbtext "\${COMMENT1}" (name "") (pos 109 23) (comment "Comment 0"))
(tbtext "\${COMMENT2}" (name "") (pos 109 26) (comment "Comment 1"))
(tbtext "\${COMMENT3}" (name "") (pos 109 29) (comment "Comment 2"))
(tbtext "\${COMMENT4}" (name "") (pos 109 32) (comment "Comment 3"))
(line (name "") (start 90 8.5) (end 90 5.5))
(line (name "") (start 26 8.5) (end 26 2))
)`;

// TB_DEFAULT_TEXTSIZE / the DS_DATA_MODEL constructor's defaults (include/drawing_sheet/ds_data_item.h:31,
// common/drawing_sheet/ds_data_model.cpp:44-69).
export const WKS_DEFAULTS = { textSizeX: 1.5, textSizeY: 1.5, lineWidth: 0.15, textLineWidth: 0.15, left: 10, right: 10, top: 10, bottom: 10 };

/** DS_MAX_REPEAT_COUNT (include/drawing_sheet/ds_data_item.h:63). */
export const DS_MAX_REPEAT_COUNT = 100;

const CORNERS: Record<string, string> = { ltcorner: "lt", lbcorner: "lb", rbcorner: "rb", rtcorner: "rt" };

function coordOf(node: SNode, from: number): WksCoord {
  // (start x y [corner]) / (end …) / (pos …); the anchor defaults to rbcorner (drawing_sheet_parser.cpp:866-882)
  const c = { x: num(node[from], 0), y: num(node[from + 1], 0), anchor: "rb" };
  for (let j = from + 2; j < node.length; j++) { const a = CORNERS[str(node[j])]; if (a) c.anchor = a; }
  return c;
}

/**
 * convertLegacyVariableRefs (drawing_sheet_parser.cpp:124-190): the old % codes of a tbtext as text variables
 * (%% → %, %D → ${ISSUE_DATE}, %C0 … %C8 → ${COMMENT1} … ${COMMENT9}, …); any other %x is dropped.
 */
export function convertLegacyVariableRefs(text: string): string {
  const CODES: Record<string, string> = { "%": "%", D: "${ISSUE_DATE}", R: "${REVISION}", K: "${KICAD_VERSION}", Z: "${PAPER}", S: "${#}", N: "${##}",
    F: "${FILENAME}", L: "${LAYER}", P: "${SHEETPATH}", Y: "${COMPANY}", T: "${TITLE}" };
  let msg = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "%") { msg += text[i]; continue; }
    if (++i >= text.length) break;
    const f = text[i];
    if (f === "C") { const d = text[++i]; if (d !== undefined && d >= "0" && d <= "8") msg += "${COMMENT" + (Number(d) + 1) + "}"; }
    else if (Object.prototype.hasOwnProperty.call(CODES, f)) msg += CODES[f];
  }
  return msg;
}
/** ConvertToNewOverbarNotation (common/string_utils.cpp:87-157): one port, in text.ts, shared with the item readers (legacy.ts). */
export { convertToNewOverbarNotation };
/** BITMAP_BASE::LoadLegacyData: the hex bytes of a (pngdata (data "…") …) as base64. */
function hexToBase64(lines: string[]): string {
  const bytes: number[] = [];
  for (const l of lines) for (const h of l.trim().split(/\s+/)) { if (/^[0-9A-Fa-f]{1,2}$/.test(h)) bytes.push(parseInt(h, 16)); }
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  if (typeof btoa === "function") return btoa(bin);
  const B = (globalThis as unknown as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } }).Buffer;
  return B ? B.from(bin, "binary").toString("base64") : "";
}

/**
 * A (kicad_wks …) description → { setup, items }: rect / line / tbtext with repeat, incrx/incry, incrlabel,
 * linewidth, font, justify, rotate, maxlen, maxheight, option; polygons (filled outlines) and bitmaps.  The header is
 * DRAWING_SHEET_PARSER::parseHeader's: kicad_wks / drawing_sheet carry a (version …); any other root (the legacy
 * page_layout) is version 0.  Every tbtext goes through convertLegacyVariableRefs, and through
 * ConvertToNewOverbarNotation when the version is before 20210606.
 */
export function parseDrawingSheet(text: string | SNode | null): DrawingSheet {
  const tree = typeof text === "string" ? parse(text) : text;
  const setup = Object.assign({}, WKS_DEFAULTS);
  const items: WksItem[] = [];
  if (!tree || !Array.isArray(tree)) return { setup, items };
  let version = 0;
  if (tree[0] === "kicad_wks" || tree[0] === "drawing_sheet") {
    const v = tree.find((c) => Array.isArray(c) && c[0] === "version") as SNode | undefined;
    if (!v) return { setup, items };   // Expecting( T_version ): the file does not load
    version = Math.round(num(v[1], 0));
  }
  for (let j = 1; j < tree.length; j++) {
    const node = tree[j]; if (!Array.isArray(node)) continue;
    if (node[0] === "setup") {
      for (const s of node.slice(1)) {
        if (!Array.isArray(s)) continue;
        if (s[0] === "textsize") { setup.textSizeX = num(s[1], setup.textSizeX); setup.textSizeY = num(s[2], setup.textSizeY); }
        else if (s[0] === "linewidth") setup.lineWidth = num(s[1], setup.lineWidth);
        else if (s[0] === "textlinewidth") setup.textLineWidth = num(s[1], setup.textLineWidth);
        else if (s[0] === "left_margin") setup.left = num(s[1], setup.left);
        else if (s[0] === "right_margin") setup.right = num(s[1], setup.right);
        else if (s[0] === "top_margin") setup.top = num(s[1], setup.top);
        else if (s[0] === "bottom_margin") setup.bottom = num(s[1], setup.bottom);
      }
      continue;
    }
    const kind = node[0];
    if (kind !== "rect" && kind !== "line" && kind !== "tbtext" && kind !== "polygon" && kind !== "bitmap") continue;
    let tb = kind === "tbtext" ? convertLegacyVariableRefs(str(node[1])) : "";
    if (kind === "tbtext" && version < 20210606) tb = convertToNewOverbarNotation(tb);
    const it: WksItem = { kind, repeat: 1, incr: [0, 0], incrLabel: 1, lineWidth: 0, option: "", rot: 0,
      bold: false, italic: false, sizeX: 0, sizeY: 0, color: null, hjust: "left", vjust: "middle",
      maxlen: 0, maxheight: 0, text: tb };
    let b64 = "", scale = 1;
    for (const c of node.slice(1)) {
      if (!Array.isArray(c)) continue;
      switch (c[0]) {
        case "start": it.start = coordOf(c, 1); break;
        case "end": it.end = coordOf(c, 1); break;
        case "pos": it.start = coordOf(c, 1); break;
        case "repeat": it.repeat = Math.min(Math.max(Math.round(num(c[1], 1)), 1), DS_MAX_REPEAT_COUNT); break;
        case "incrx": it.incr[0] = num(c[1], 0); break;
        case "incry": it.incr[1] = num(c[1], 0); break;
        case "incrlabel": it.incrLabel = Math.round(num(c[1], 1)); break;
        case "linewidth": it.lineWidth = num(c[1], 0); break;
        case "maxlen": it.maxlen = num(c[1], 0); break;
        case "maxheight": it.maxheight = num(c[1], 0); break;
        case "rotate": it.rot = num(c[1], 0); break;
        case "option": it.option = str(c[1]); break;
        case "pts": if (kind === "polygon") (it.contours = it.contours || []).push(kids(c, "xy").map((q) => [num(q[1]), num(q[2])] as Pt)); break;
        case "scale": scale = num(c[1], 1); break;
        case "data": b64 = c.slice(1).map(str).join(""); break;
        case "pngdata": b64 = hexToBase64(kids(c, "data").map((d) => str(d[1]))); break;
        case "justify":
          for (const t of c.slice(1)) {
            const v = str(t);
            if (v === "center") { it.hjust = "center"; it.vjust = "middle"; }   // sets BOTH axes
            else if (v === "left") it.hjust = "left";
            else if (v === "right") it.hjust = "right";
            else if (v === "top") it.vjust = "top";
            else if (v === "bottom") it.vjust = "bottom";
          }
          break;
        case "font":
          for (const f of c.slice(1)) {
            if (f === "bold") it.bold = true;
            else if (f === "italic") it.italic = true;
            else if (Array.isArray(f)) {
              if (f[0] === "size") { it.sizeX = num(f[1], 0); it.sizeY = num(f[2], 0); }
              else if (f[0] === "linewidth") it.lineWidth = num(f[1], 0);
              else if (f[0] === "color") { const a = num(f[4], 1); if (a > 0) it.color = `rgba(${num(f[1])},${num(f[2])},${num(f[3])},${+a.toFixed(3)})`; }
            }
          }
          break;
      }
    }
    if (!it.start) it.start = { x: 0, y: 0, anchor: "rb" };
    if (!it.end) it.end = { x: it.start.x, y: it.start.y, anchor: it.start.anchor };
    if (kind === "bitmap") {
      // "Drop invalid bitmaps": an image whose data does not read is not kept
      const info = imageInfo(base64Bytes(b64, 1 << 17)); if (!b64 || !(info.w > 0 && info.h > 0)) continue;
      it.bitmap = { b64, scale: scale > 0 && isFinite(scale) ? scale : 1, mime: info.mime, w: info.w, h: info.h, ppi: info.ppi || 300 };
    }
    items.push(it);
  }
  return { setup, items };
}

/** The built-in sheet, parsed once. */
let DEFAULT_SHEET: DrawingSheet | null = null;
export function defaultDrawingSheet(): DrawingSheet { if (!DEFAULT_SHEET) DEFAULT_SHEET = parseDrawingSheet(DEFAULT_DRAWING_SHEET); return DEFAULT_SHEET; }

// ---------------------------------------------------------------- label increment
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** IndexFromAlphabetic (common/increment.cpp:249-268): A→0 … Z→25, AA→26, BA→52. */
export function indexFromAlphabetic(s: string, alphabet?: string): number {
  const alpha = alphabet || ALPHABET, radix = alpha.length; let index = 0;
  for (let i = 0; i < s.length; i++) {
    let k = alpha.indexOf(s[i]); if (k < 0) return -1;
    if (i !== s.length - 1) k++;
    index += k * Math.pow(radix, s.length - 1 - i);
  }
  return index;
}

/** AlphabeticFromIndex(n, alpha, zeroBasedNonUnitCols = true) (common/increment.cpp:270-291). */
export function alphabeticFromIndex(n: number, alphabet?: string): string {
  const alpha = alphabet || ALPHABET, radix = alpha.length;
  let out = "", first = true;
  do {
    let mod = n % radix;
    if (!first) mod--;
    out = alpha[mod] + out;
    n = Math.floor(n / radix);
    first = false;
  } while (n);
  return out;
}

/**
 * STRING_INCREMENTER::Increment( str, delta, rightIndex ) (common/increment.cpp:83-243).  Walks in from the right,
 * chunking \d+$ (integer), ([a-z]+|[A-Z]+)$ (single-case run) and [^a-zA-Z0-9]+$ (skipped), and steps the incrementable
 * chunk `rightIndex` counts (0 the rightmost, 1 the one before it).  An integer keeps its zero padding and does not go
 * below zero; a letter run steps through A..Z, AA.. in the alphabet without I O S Q X Z when `skipIOSQXZ` is set and the
 * run holds none of them, and is refused above `alphabeticMaxIndex` (< 0: no bound).  null when there is no such part
 * or it cannot step.  The defaults are DS_DATA_ITEM_TEXT::IncrementLabel's settings.
 */
export function incrementString(s: string, delta: number, rightIndex = 0, skipIOSQXZ = false, alphabeticMaxIndex = -1): string | null {
  if (!s) return null;
  let remaining = s; const parts: { s: string; type: string }[] = []; let good = 0;
  while (good <= rightIndex && remaining) {
    let m = /\d+$/.exec(remaining);
    if (m) { parts.push({ s: m[0], type: "int" }); good++; }
    else if ((m = /([a-z]+|[A-Z]+)$/.exec(remaining))) { parts.push({ s: m[0], type: "alpha" }); good++; }
    else if ((m = /[^a-zA-Z0-9]+$/.exec(remaining))) parts.push({ s: m[0], type: "skip" });
    else break;
    remaining = remaining.slice(0, remaining.length - m[0].length);
  }
  if (good <= rightIndex) return null;
  const last = parts[parts.length - 1];
  let stepped: string;
  if (last.type === "int") {
    const oldLen = last.s.length, padded = last.s[0] === "0";
    const n = parseInt(last.s, 10) + delta;
    if (!isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) return null;
    stepped = String(n);
    if (padded && stepped.length < oldLen) stepped = "0".repeat(oldLen - stepped.length) + stepped;
  } else {
    const upper = last.s.toUpperCase(), wasUpper = last.s === upper;
    const alpha = skipIOSQXZ && !/[IOSQXZ]/.test(last.s) ? "ABCDEFGHJKLMNPRTUVWY" : ALPHABET;
    const index = indexFromAlphabetic(upper, alpha);
    if (index < 0) return null;
    if (index > alphabeticMaxIndex && alphabeticMaxIndex >= 0) return null;
    const next = index + delta;
    if (next < 0 || next > 2147483647) return null;
    stepped = alphabeticFromIndex(next, alpha);
    if (!wasUpper) stepped = stepped.toLowerCase();
  }
  last.s = stepped;
  let out = remaining;
  for (let i = parts.length - 1; i >= 0; i--) out += parts[i].s;
  return out;
}

/** DS_DATA_ITEM_TEXT::IncrementLabel: always steps the BASE text by an absolute delta. */
export function incrementLabel(base: string, delta: number): string { const s = incrementString(base, delta); return s === null ? base : s; }

// ---------------------------------------------------------------- text variables
/** The markers ExpandTextVars puts in place of an escaped \${…} / \@{…} so no later pass expands it (common.cpp:168-196). */
const ESC_DOLLAR = "<<<ESC_DOLLAR:", ESC_AT = "<<<ESC_AT:";
/** ADVANCED_CFG::m_ResolveTextRecursionDepth: how deep nested references are expanded. */
export const RESOLVE_TEXT_RECURSION_DEPTH = 6;
/** Options of expandTextVars: `erc` is the FOR_ERC_DRC context (user ${ERC_WARNING …} etc. are kept); `finalize: false` leaves the escape markers in for a further pass. */
export interface ExpandOpts { erc?: boolean; finalize?: boolean }
/** From `i` (just past a marker or an escaped "{"), the index past the brace that closes it, brace depth counted. */
function skipBraced(src: string, i: number): number {
  let depth = 1;
  for (; i < src.length && depth > 0; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; }
  return i;
}
/** EDA_TEXT::HasTextVars: the text holds a ${…} or @{…} (or an escape marker a further pass must finalise). */
export function hasTextVars(text: string): boolean { return text.indexOf("${") >= 0 || text.indexOf("@{") >= 0 || text.indexOf("<<<ESC_") >= 0; }
/** The body of ExpandTextVars( aSource, aResolver, aContext, aDepth ) (common/common.cpp:107-330); markers are left in. */
function expandRaw(src: string, resolve: VarResolver, depth: number, erc: boolean): string {
  let out = "";
  const n = src.length;
  for (let i = 0; i < n; ++i) {
    // an existing escape marker is copied through with its contents, never expanded
    if (src.startsWith(ESC_DOLLAR, i) || src.startsWith(ESC_AT, i)) {
      const m = src.startsWith(ESC_DOLLAR, i) ? ESC_DOLLAR : ESC_AT, e = skipBraced(src, i + m.length);
      out += src.slice(i, e); i = e - 1; continue;
    }
    // \${…} / \@{…}: an escaped reference becomes a marker up to its matching brace
    if (src[i] === "\\" && i + 1 < n && (src[i + 1] === "$" || src[i + 1] === "@") && i + 2 < n && src[i + 2] === "{") {
      const e = skipBraced(src, i + 3);
      out += (src[i + 1] === "$" ? ESC_DOLLAR : ESC_AT) + src.slice(i + 3, e); i = e - 1; continue;
    }
    if ((src[i] === "$" || src[i] === "@") && i + 1 < n && src[i + 1] === "{") {
      const isMath = src[i] === "@";
      let token = "", braceDepth = 1;
      for (i = i + 2; i < n; ++i) {
        if (src.startsWith(ESC_DOLLAR, i) || src.startsWith(ESC_AT, i)) {
          const m = src.startsWith(ESC_DOLLAR, i) ? ESC_DOLLAR : ESC_AT, e = skipBraced(src, i + m.length);
          token += src.slice(i, e); i = e - 1; continue;
        }
        if (src[i] === "{") { braceDepth++; token += "{"; }
        else if (src[i] === "}") { if (--braceDepth === 0) break; token += "}"; }
        else token += src[i];
      }
      // an empty token draws nothing; an unterminated one takes the rest of the text
      if (!token) continue;
      const nested = (token.indexOf("${") >= 0 || token.indexOf("@{") >= 0) && depth < RESOLVE_TEXT_RECURSION_DEPTH;
      if (isMath) {
        // @{…}: the nested references are expanded, the expression is left for EvaluateText
        if (nested) token = expandRaw(token, resolve, depth + 1, erc);
        out += "@{" + token + "}";
        continue;
      }
      if (nested) {
        token = expandRaw(token, resolve, depth + 1, erc);
        if (token.indexOf("@{") >= 0) token = evaluateText(token);
      }
      // only ERC / DRC show the user-defined warnings and errors
      if (!erc && /^(ERC_WARNING|ERC_ERROR|DRC_WARNING|DRC_ERROR)/.test(token)) continue;
      const v = resolve(token);
      // KiCad's resolver takes the token by reference and may rewrite it even when it goes on to
      // report failure, and `newbuf.append( "${" + token + "}" )` then wraps whatever is left in it
      // (common/common.cpp:311-315).  `{ ref }` is that case; null is an untouched miss.
      if (v === null || v === undefined) out += "${" + token + "}";
      else if (typeof v === "object" && typeof v.ref === "string") out += "${" + v.ref + "}";
      else out += v;
    } else out += src[i];
  }
  return out;
}
/**
 * FinalizeTextVarExpansion (common.cpp:88-104): the escape markers become the literal reference again: "${X}" for the
 * canvas and the GUI (the backslash is dropped), "\${X}" for ERC / DRC and internal use.
 */
export function finalizeTextVars(text: string, internal = false): string {
  if (text.indexOf("<<<ESC_") < 0) return text;
  return text.split(ESC_DOLLAR).join(internal ? "\\${" : "${").split(ESC_AT).join(internal ? "\\@{" : "@{");
}
/**
 * ExpandTextVars (common/common.cpp:107-330): ${TOKEN} through the resolver, innermost first; an unresolved reference is
 * left in the text verbatim (an unterminated one gets its closing brace), an empty ${} draws nothing, \${…} / \@{…}
 * are shown literally, @{expr} keeps its expression with the nested references expanded, and outside ERC / DRC
 * ${ERC_WARNING …} / ${ERC_ERROR …} / ${DRC_WARNING …} / ${DRC_ERROR …} draw nothing.  The outermost call then
 * evaluates the @{…} expressions (EXPRESSION_EVALUATOR::Evaluate, as ResolveTextVars and BuildFullText do) and
 * finalises the escapes (FinalizeTextVarExpansion), unless `opts.finalize` is false (a further pass follows).  A
 * caller passing `depth` gets the raw expansion, markers and expressions left in.
 */
export function expandTextVars(text: unknown, resolve: VarResolver, depth?: number, opts?: ExpandOpts): string {
  const src = str(text);
  if (!hasTextVars(src)) return src;
  const erc = !!(opts && opts.erc);
  if (depth) return expandRaw(src, resolve, depth, erc);
  let out = expandRaw(src, resolve, 0, erc);
  if (out.indexOf("@{") >= 0) out = evaluateText(out);
  return opts && opts.finalize === false ? out : finalizeTextVars(out, erc);
}

const TWO = (n: number) => (n < 10 ? "0" : "") + n;
const joinPath = (dir: string, name: string) => (dir ? dir.replace(/\/+$/, "") + "/" + name.replace(/^\/+/, "") : name);

/** ds_painter.cpp:40 — `static const wxString productName = wxT( "KiCad E.D.A." )`. */
export const PRODUCT_NAME = "KiCad E.D.A.";

/**
 * The tokens DS_DRAW_ITEM_LIST::BuildFullText's own lambda answers, before it ever looks at the
 * title block (ds_painter.cpp:112-172).
 */
export const WS_TOKENS = new Set(["KICAD_VERSION", "#", "##", "SHEETNAME", "SHEETPATH", "FILENAME", "FILEPATH",
  "PAPER", "LAYER", "VARIANT", "VARIANT_DESC"]);

/** The tokens PROJECT::TextVarResolver answers ahead of the project's own variables (common/project.cpp:178-211). */
export const PROJECT_TOKENS = new Set(["PROJECTNAME", "CURRENT_DATE", "CURRENT_TIME_HH_MM_SS", "CURRENT_TIME_LOCALE", "VCSHASH", "VCSSHORTHASH"]);

/** The tokens TITLE_BLOCK::TextVarResolver answers (title_block.cpp:122-190). */
export const TB_TOKENS = new Set(["ISSUE_DATE", "CURRENT_DATE", "CURRENT_TIME_HH_MM_SS", "CURRENT_TIME_LOCALE",
  "REVISION", "TITLE", "COMPANY", "COMMENT1", "COMMENT2", "COMMENT3", "COMMENT4", "COMMENT5", "COMMENT6",
  "COMMENT7", "COMMENT8", "COMMENT9"]);

/**
 * The document's text-variable values, in DS_DRAW_ITEM_LIST::BuildFullText's order
 * (ds_painter.cpp:112-226) followed by TITLE_BLOCK::TextVarResolver (title_block.cpp:122-190).
 * A field the document does not carry resolves to the empty string, exactly as KiCad's
 * resolver does — "Rev: ${REVISION}" on a schematic with no revision reads "Rev: ".
 *
 * ${KICAD_VERSION} is `productName + " " + GetBaseVersion()` (ds_painter.cpp:40,119-121); the base
 * version is the KiCad this tree builds, baked in by scripts/gen-version.js (canvas/version.ts) and
 * carried on doc.kicadVersion, so the web's title block reads the same string the desktop's does.
 */
export function sheetTextVars(doc: Partial<SheetContext> | null | undefined): SheetVars {
  const tb: Record<string, string> = (doc && doc.titleBlock) || {};
  const now = new Date();
  const vars: SheetVars = {
    KICAD_VERSION: PRODUCT_NAME + " " + str(doc && doc.kicadVersion),
    "#": str(doc && doc.pageNumber) || "1",
    "##": String((doc && doc.sheetCount) || 1),
    SHEETNAME: str(doc && doc.sheetName),
    SHEETPATH: str(doc && doc.sheetPath),
    FILENAME: str(doc && doc.fileName),
    // wxFileName( m_fileName ).GetFullPath() (ds_painter.cpp:149-153): the directory and the name.
    // KiCad's m_fileName is the absolute path the program opened; the browser has only the document's
    // path inside the shared project — every peer's local copy sits somewhere different, so there is
    // no one filesystem path to quote.  doc.fileRoot is the hook for a host that does know one.
    FILEPATH: joinPath(str(doc && doc.fileRoot), str(doc && doc.filePath) || str(doc && doc.fileName)),
    PROJECTNAME: str(doc && doc.projectName),
    // KIGIT::PROJECT_GIT_UTILS::GetCurrentHash( long / short ): empty when the host knows no commit
    VCSHASH: str(doc && doc.vcsHash), VCSSHORTHASH: str(doc && doc.vcsShortHash),
    PAPER: str(doc && doc.paper) || "A4",
    LAYER: str(doc && doc.sheetLayer),
    // the drawing sheet's ${VARIANT} / ${VARIANT_DESC}: the current variant (PCB_EDIT_FRAME / SCH_EDIT_FRAME
    // SetCurrentVariant hand them to the drawing sheet; empty for the default)
    VARIANT: str(doc && doc.variantName), VARIANT_DESC: str(doc && doc.variantDesc),
    ISSUE_DATE: str(tb.date),
    CURRENT_DATE: `${now.getFullYear()}-${TWO(now.getMonth() + 1)}-${TWO(now.getDate())}`,
    // TITLE_BLOCK::GetCurrentTimeHHMMSS: "%Hh%Mm%Ss" (letters, so the value is safe in a file name)
    CURRENT_TIME_HH_MM_SS: `${TWO(now.getHours())}h${TWO(now.getMinutes())}m${TWO(now.getSeconds())}s`,
    CURRENT_TIME_LOCALE: now.toLocaleTimeString(),
    REVISION: str(tb.rev),
    TITLE: str(tb.title),
    COMPANY: str(tb.company),
  };
  for (let i = 1; i <= 9; i++) vars["COMMENT" + i] = str(tb["comment" + i]);
  if (doc && doc.sheetVars) Object.assign(vars, doc.sheetVars);
  return vars;
}

/**
 * BuildFullText's `wsResolver` over a plain {token: value} map (ds_painter.cpp:112-226).  Its three
 * layers are not interchangeable, and KiCad's differences between them are visible in a title block:
 *
 *  - A worksheet token (WS_TOKENS) resolves to its value, expanded against the PROJECT's text
 *    variables only — never against the title block.  ${FILEPATH} returns straight out and skips
 *    even that (`return true` at ds_painter.cpp:149-153).
 *  - A title-block token resolves through TITLE_BLOCK::TextVarResolver, and BuildFullText then
 *    re-runs *this* resolver over the value with `m_titleBlock = nullptr` (ds_painter.cpp:174-186),
 *    so a title-block token nested inside a title-block field is deliberately left unresolved:
 *    (company "A ${TITLE} B") draws "A ${TITLE} B", not the title.
 *  - A field holding exactly its own reference — (rev "${REVISION}") — trips TITLE_BLOCK's "this is
 *    the default fallback, so don't claim we resolved it" test (title_block.cpp:186-188) *after* it
 *    has already rewritten the token to "${REVISION}", and ExpandTextVars wraps what it finds in the
 *    token: KiCad draws "Rev: ${${REVISION}}".  `{ ref }` reproduces that.
 *  - Anything none of them claims falls through to the project's text variables (:222-223).
 *
 * opts: { titleBlock: false } is the inner pass with the title block switched off; { project } is
 * the .kicad_pro's text_variables map.
 */
export function varResolver(vars: SheetVars, opts?: { titleBlock?: boolean; project?: Record<string, unknown> | null }): VarResolver {
  const o = opts || {};
  const withTb = o.titleBlock !== false;
  const project = o.project || null;
  // PROJECT::TextVarResolver (common/project.cpp:178-217): PROJECTNAME, the current date and times and the VCS hashes,
  // then the project's text variables
  const fromProject = (token: string): string | null => {
    if (PROJECT_TOKENS.has(token)) return str(vars[token]);
    const v = project ? project[token] : undefined; return v === undefined || v === null ? null : String(v);
  };
  const expandProject = (text: string): string => (project ? expandTextVars(text, fromProject) : text);
  return (token: string): VarValue => {
    if (WS_TOKENS.has(token)) {
      const v = vars[token];
      if (v === undefined || v === null) return null;
      return token === "FILEPATH" ? String(v) : expandProject(String(v));
    }
    if (withTb && TB_TOKENS.has(token)) {
      const raw = vars[token];
      if (raw !== undefined && raw !== null) {
        const value = token === "CURRENT_DATE" ? String(raw) : expandProject(String(raw));
        if (value === "${" + token + "}") { const p = fromProject(value); return p === null ? { ref: value } : p; }
        return expandTextVars(value, varResolver(vars, { titleBlock: false, project }));
      }
    }
    return fromProject(token);
  };
}

/** DS_DATA_ITEM_TEXT::ReplaceAntiSlashSequence (ds_data_item.cpp:639-671): \\ → \, \n → newline. */
export function replaceAntiSlash(s: string): { text: string; multiline: boolean } {
  let out = "", multiline = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "\\") { out += "\\"; i++; continue; }
    if (s[i] === "\\" && s[i + 1] === "n") { out += "\n"; multiline = true; i++; continue; }
    out += s[i];
  }
  return { text: out, multiline };
}

// ---------------------------------------------------------------- geometry
/**
 * EDA_TEXT::GetEffectiveTextPenWidth with DS_DATA_ITEM_TEXT's bold rule (ds_data_item.cpp:546-551,
 * common/gr_text.cpp:33-74): bold text is fed pen 0 so it picks up the auto-bold width size/5;
 * everything is clamped to a quarter of the glyph size.
 */
export function sheetTextPen(pen: number, size: number, bold: boolean, sizeX = size): number {
  let t = bold ? 0 : pen;
  if (t <= 0) t = bold ? sizeX / 5 : sizeX / 8;   // GetPenSizeForBold / ForNormal( GetTextWidth() )
  return Math.min(t, Math.min(Math.abs(sizeX), Math.abs(size)) * 0.25);
}
/**
 * DS_DATA_ITEM_TEXT::SetConstrainedTextSize (ds_data_item.cpp:674-714): the full text's box (EDA_TEXT::GetTextBox of a
 * multi-line text with the automatic pen, in whole millimetres as KiCad rounds it) and each size scaled down on its
 * own: the X size when the box is wider than maxlen, the Y size when it is taller than maxheight.
 */
export function constrainedTextSize(text: string, sizeX: number, sizeY: number, bold: boolean, maxlen: number, maxheight: number): [number, number] {
  if (!(maxlen > 0) && !(maxheight > 0)) return [sizeX, sizeY];
  const pen = sheetTextPen(0, sizeY, bold, sizeX);
  const lines = text.split("\n");
  let w = 0; for (const l of lines) w = Math.max(w, textWidth(parseMarkup(l).text, sizeX, pen));
  const ext = sizeY + 3 * pen;
  let h = ext + ext * 0.17 + (lines.length - 1) * sizeY * INTERLINE;
  if (/~\{/.test(lines[0])) h += ext / 6;
  const kround = (v: number): number => Math.sign(v) * Math.round(Math.abs(v));   // KiRound( (int) width / FSCALE )
  const bw = kround(w), bh = kround(h);
  if (maxlen > 0 && bw > maxlen) sizeX *= maxlen / bw;
  if (maxheight > 0 && bh > maxheight) sizeY *= maxheight / bh;
  return [sizeX, sizeY];
}

/**
 * The drawing sheet for one page as flat draw records, in KiCad's own item order:
 *   { t: "line", x1, y1, x2, y2, w }
 *   { t: "rect", x, y, w, h, lw }
 *   { t: "text", x, y, text, size, w, bold, italic, h, v, rot, color }
 * `page` is [width, height] in mm; `vars` is the resolver map (sheetTextVars); `wks` is a parsed
 * description (the built-in sheet by default); `firstPage` filters (option page1only|notonpage1);
 * `project` is the project's text_variables map (the .kicad_pro's), KiCad's last resolver.
 */
export function buildDrawingSheet(page: readonly number[], vars: SheetVars | null | undefined, wks: DrawingSheet | null | undefined, firstPage?: boolean, project?: Record<string, unknown> | null): SheetDraw[] {
  const sheet = wks || defaultDrawingSheet();
  const setup = sheet.setup;
  const LT = [setup.left, setup.top];
  const RB = [page[0] - setup.right, page[1] - setup.bottom];
  const resolve = varResolver(vars || {}, { project: project || null });
  const isFirst = firstPage !== false;
  const at = (c: WksCoord, i: number, incr: readonly number[]): Pt => {
    const px = c.x + incr[0] * i, py = c.y + incr[1] * i;
    if (c.anchor === "lt") return [LT[0] + px, LT[1] + py];
    if (c.anchor === "lb") return [LT[0] + px, RB[1] - py];
    if (c.anchor === "rt") return [RB[0] - px, LT[1] + py];
    return [RB[0] - px, RB[1] - py];                            // rbcorner, the default
  };
  const out: SheetDraw[] = [];
  for (const it of sheet.items) {
    if (it.option === "page1only" && !isFirst) continue;
    if (it.option === "notonpage1" && isFirst) continue;
    const isText = it.kind === "tbtext";
    // DS_DATA_ITEM::IsInsidePage: the framed area, grown to take in the run's own seed positions
    const s0 = at(it.start!, 0, it.incr), e0 = at(it.end!, 0, it.incr);   // parseDrawingSheet fills both
    let bx0 = Math.min(LT[0], s0[0]), by0 = Math.min(LT[1], s0[1]);
    let bx1 = Math.max(RB[0], s0[0]), by1 = Math.max(RB[1], s0[1]);
    if (!isText) { bx0 = Math.min(bx0, e0[0]); by0 = Math.min(by0, e0[1]); bx1 = Math.max(bx1, e0[0]); by1 = Math.max(by1, e0[1]); }
    const inside = (p: Pt) => p[0] >= bx0 - 1e-9 && p[0] <= bx1 + 1e-9 && p[1] >= by0 - 1e-9 && p[1] <= by1 + 1e-9;

    let full: string | null = null, multiline = false, escaped = false, size = 0, sizeX = 0, pen = 0;
    if (isText) {
      const expanded = expandTextVars(it.text, resolve);
      const r = replaceAntiSlash(expanded);
      full = r.text;
      escaped = r.multiline;                        // ReplaceAntiSlashSequence's own answer: it guards IncrementLabel
      // …but the layout keys on the newline itself.  DSNLEXER already turns a `\n` written in the
      // file into a real newline (common/dsnlexer.cpp:667), so a title-block field can arrive with
      // one without ReplaceAntiSlashSequence ever firing — and FONT::Draw splits on '\n' either way
      // (common/font/font.cpp:175-180), which is what actually puts the lines on the page.
      multiline = full.indexOf("\n") >= 0;
      // SetConstrainedTextSize: shrink, never grow, to fit maxlen / maxheight; the pen follows the sizes drawn
      [sizeX, size] = constrainedTextSize(full, it.sizeX || setup.textSizeX, it.sizeY || setup.textSizeY, it.bold, it.maxlen, it.maxheight);
      pen = sheetTextPen(it.lineWidth || setup.textLineWidth, size, it.bold, sizeX);
    }
    if (it.kind === "polygon" || it.kind === "bitmap") {
      // DS_DATA_ITEM_POLYGONS: the corners turned by (rotate) about the item origin, then put at the start position; a
      // repeat is kept while its turned extent stays on the page (IsInsidePage over m_minCoord / m_maxCoord)
      const a = it.rot * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
      const turn = (p: Pt): Pt => [p[0] * c + p[1] * sn, p[1] * c - p[0] * sn];   // RotatePoint
      const contours = (it.contours || []).map((ct) => ct.map(turn));
      const all = contours.flat();
      const mn: Pt = all.length ? [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))] : [0, 0];
      const mx: Pt = all.length ? [Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))] : [0, 0];
      const p0 = at(it.start!, 0, it.incr);
      const px0 = Math.min(LT[0], it.kind === "polygon" ? p0[0] + mn[0] : p0[0]), py0 = Math.min(LT[1], it.kind === "polygon" ? p0[1] + mn[1] : p0[1]);
      const px1 = Math.max(RB[0], it.kind === "polygon" ? p0[0] + mx[0] : p0[0]), py1 = Math.max(RB[1], it.kind === "polygon" ? p0[1] + mx[1] : p0[1]);
      const onPage = (p: Pt) => p[0] >= px0 - 1e-9 && p[0] <= px1 + 1e-9 && p[1] >= py0 - 1e-9 && p[1] <= py1 + 1e-9;
      for (let j = 0; j < it.repeat; j++) {
        const sp = at(it.start!, j, it.incr);
        if (it.kind === "polygon") {
          if (j > 0 && !(onPage([sp[0] + mn[0], sp[1] + mn[1]]) && onPage([sp[0] + mx[0], sp[1] + mx[1]]))) continue;
          out.push({ t: "poly", polys: contours.map((ct) => ct.map((p) => [p[0] + sp[0], p[1] + sp[1]] as Pt)) });
        } else {
          if (j > 0 && !onPage(sp)) continue;
          // DS_DATA_ITEM_BITMAP: a pixel is 1 / PPI inch, the (scale) a zoom about the position the image is centred on
          const bm = it.bitmap!, pxMm = 25.4 / bm.ppi, w = bm.w * pxMm * bm.scale, h = bm.h * pxMm * bm.scale;
          out.push({ t: "image", x: sp[0] - w / 2, y: sp[1] - h / 2, w, h, b64: bm.b64, url: "data:" + bm.mime + ";base64," + bm.b64 });
        }
      }
      continue;
    }
    const lw = it.lineWidth || setup.lineWidth;
    let label = full;
    for (let j = 0; j < it.repeat; j++) {
      if (j > 0) {
        const sp = at(it.start!, j, it.incr);
        if (!isText && !inside(at(it.end!, j, it.incr))) continue;
        if (!inside(sp)) continue;
      }
      const [sx, sy] = at(it.start!, j, it.incr);
      if (isText) {
        if (label) out.push({ t: "text", x: sx, y: sy, text: label, size, sizeX, w: pen, bold: it.bold, italic: it.italic,
          h: it.hjust, v: it.vjust, rot: it.rot, color: it.color, multiline });
        if (it.repeat > 1 && !escaped) label = incrementLabel(it.text, (j + 1) * it.incrLabel);
      } else {
        const [ex, ey] = at(it.end!, j, it.incr);
        if (it.kind === "line") out.push({ t: "line", x1: sx, y1: sy, x2: ex, y2: ey, w: lw });
        else out.push({ t: "rect", x: Math.min(sx, ex), y: Math.min(sy, ey), w: Math.abs(ex - sx), h: Math.abs(ey - sy), lw });
      }
    }
  }
  return out;
}

/**
 * The sheet for a parsed document — page size and text variables come off the doc.  render() calls
 * this every frame, so the result is cached per document and rebuilt only when something it depends
 * on changes (the page, the title block, the sheet identity or the description itself).
 */
const SHEET_CACHE = new WeakMap<object, { key: string; wks: DrawingSheet | null; items: SheetDraw[] }>();
export function documentDrawingSheet(doc: SheetContext): SheetDraw[] {
  const wks = doc.drawingSheet || null;
  // Keyed on the document's own inputs rather than on the resolved variables, so the wall clock
  // (${CURRENT_TIME_*}, which the built-in sheet never shows) does not invalidate it every frame.
  const key = [doc.page[0], doc.page[1], doc.isFirstPage, doc.paper, doc.pageNumber, doc.sheetCount,
    doc.fileName, doc.filePath, doc.fileRoot, doc.sheetName, doc.sheetPath, doc.projectName, doc.kicadVersion, doc.vcsHash, doc.vcsShortHash].join("\u0000")
    + "\u0000" + JSON.stringify(doc.titleBlock || null) + "\u0000" + JSON.stringify(doc.sheetVars || null)
    + "\u0000" + JSON.stringify(doc.projectVars || null);
  const hit = SHEET_CACHE.get(doc);
  if (hit && hit.key === key && hit.wks === wks) return hit.items;
  const items = buildDrawingSheet(doc.page, sheetTextVars(doc), wks, doc.isFirstPage !== false, doc.projectVars || null);
  SHEET_CACHE.set(doc, { key, wks, items });
  return items;
}

/**
 * DS_PROXY_VIEW_ITEM::HitTestDrawingSheetItems: whether a point is within `tol` of a drawing-sheet item: a line
 * (TestSegmentHit with half its width), a rectangle's edges (DS_DRAW_ITEM_RECT::HitTest), or a text's box
 * (EDA_TEXT::TextHitTest inflated by tol).
 */
export function hitTestDrawingSheet(doc: SheetContext, x: number, y: number, tol: number): boolean {
  const seg = (ax: number, ay: number, bx: number, by: number, d: number) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= d;
  };
  for (const it of documentDrawingSheet(doc)) {
    if (it.t === "line") { if (seg(it.x1, it.y1, it.x2, it.y2, tol + it.w / 2)) return true; }
    else if (it.t === "rect") {
      const d = tol + it.lw / 2, x1 = it.x + it.w, y1 = it.y + it.h;
      if (seg(it.x, it.y, x1, it.y, d) || seg(x1, it.y, x1, y1, d) || seg(x1, y1, it.x, y1, d) || seg(it.x, y1, it.x, it.y, d)) return true;
    } else if (it.t === "poly") {
      // DS_DRAW_ITEM_POLYPOLYGONS::HitTest: SHAPE_POLY_SET::Collide, inside an outline or within tol of its edge
      for (const pl of it.polys) { if (pointInPoly(pl, x, y)) return true; for (let i = 0; i < pl.length; i++) { const a = pl[i], b = pl[(i + 1) % pl.length]; if (seg(a[0], a[1], b[0], b[1], tol)) return true; } }
    } else if (it.t === "image") {
      // DS_DRAW_ITEM_BITMAP::HitTest: the image's box inflated by tol
      if (x >= it.x - tol && x <= it.x + it.w + tol && y >= it.y - tol && y <= it.y + it.h + tol) return true;
    } else {
      const lines = it.text.split("\n"), w = Math.max(...lines.map((l) => textWidth(l, it.sizeX || it.size, it.w))), h = it.size * (1 + (lines.length - 1) * 1.62);
      let bw = w, bh = h; if (Math.abs(it.rot % 180) === 90) { bw = h; bh = w; }
      const x0 = it.h === "center" ? it.x - bw / 2 : it.h === "right" ? it.x - bw : it.x, y0 = it.v === "middle" || it.v === "center" ? it.y - bh / 2 : it.v === "bottom" ? it.y - bh : it.y;
      if (x >= x0 - tol && x <= x0 + bw + tol && y >= y0 - tol && y <= y0 + bh + tol) return true;
    }
  }
  return false;
}
