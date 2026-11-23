// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/domains/pcb/canvas/index.ts — edit these modules, not the bundle).
import { SCH, SCH_Z, dimColor, parseColor } from "./colors";
import { stackedItems, unescapePin } from "./stacked-pins";
import { G, bboxAdd, boxUnion, textGeom, textLines, transformedText } from "./geom";
import { arcFrom3, atOf, bezierPts, colorOf as itemColorOf, dashOf, effectsOf as itemEffectsOf, faceOf, ellipsePts, fillOf, has, isList, justOf, kid, kids, num, ptsOf, rotPt, str, strokeColorOf as itemStrokeColorOf, widthOf, yesNo } from "./sexpr";
import { buildImageGeom, buildTableGeom } from "./tables-images";
import { hatchLines } from "./geom-pcb";
import { arcEnds, arcTangents, bezierEndings, emitEnding, hasEndings, polyTangents, readEndings, shortenArc, shortenPoly, shortenSegment } from "./line-ending";
import { MIL, SCH_PEN, layoutPen, parseMarkup, setSchTextVersion, textPen, textWidth, unescapeText } from "./text";
import { linebreakText } from "./stroke-font";
import { expandTextVars, hasTextVars, sheetTextVars, varResolver } from "./sheet";
import type { Box, Doc, Geom, GeomSink, Item, Pt, SheetContext, TextEffects, Tf } from "./types";
/** SCH_SYMBOL::ResolveTextVar: the Sim.* fields a symbol may lack, which resolve to "" rather than staying ${…}. */
const SIM_VARS = new Set(["SIM.DEVICE", "SIM.TYPE", "SIM.PINS", "SIM.PARAMS", "SIM.LIBRARY", "SIM.NAME"]);
/** The host's operating-point variables (SCH_SYMBOL / SCH_LABEL_BASE::ResolveTextVar's ${OP…} from
 *  SCHEMATIC::GetOperatingPoint): the shown text of a token, or null when it is not one. */
export type OpTextVar = (kind: "symbol" | "label", item: Item, token: string) => string | null;
export const opVars: { resolve: OpTextVar | null } = { resolve: null };
/**
 * The host's connectivity for SCH_SYMBOL::ResolveTextVar's pin functions: `net` gives ${NET_NAME(pin)},
 * ${SHORT_NET_NAME(pin)} and ${NET_CLASS(pin)} of a pin of the symbol (`unit` names another unit of the same
 * reference, null the symbol's own), null when the pin has no connection; `unitPlaced` says whether that other unit is
 * placed anywhere in the hierarchy (false: "<Unit X not placed>") and gives its pin's alternate.
 */
export const symVars: {
  net: ((item: Item, pin: string, kind: "NET_NAME" | "SHORT_NET_NAME" | "NET_CLASS", unit: number | null) => string | null) | null;
  unitPlaced: ((item: Item, ref: string, unit: number) => { alt?: string } | false | null) | null;
} = { net: null, unitPlaced: null };
/**
 * The host's part of SCH_LABEL_BASE::ResolveTextVar: ${NET_NAME}, ${SHORT_NET_NAME} and ${NET_CLASS} of a label come
 * from the connection graph, which the editor keeps (editor/schnets.ts); null leaves the token as written.
 */
export type LabelTextVar = (item: Item, token: string) => string | null;
export const labelVars: { resolve: LabelTextVar | null } = { resolve: null };
/** getElectricalTypeLabel: ${CONNECTION_TYPE} of a global or hierarchical label. */
const CONNECTION_TYPE: Record<string, string> = { input: "Input", output: "Output", bidirectional: "Bidirectional", tri_state: "Tri-State", passive: "Passive" };
const onSegment = (p: number[], a: number[], b: number[]): boolean => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)) <= 1e-4;
};
/** A directive label's ${EXCLUDE_FROM_BOM} / ${EXCLUDE_FROM_BOARD} / ${EXCLUDE_FROM_SIM} / ${DNP}: the wording when a
 *  rule area the label sits on (SCH_DIRECTIVE_LABEL::GetConnectedRuleAreas) carries the flag, else "". */
const DIRECTIVE_FLAGS: Record<string, { key: string; on: string; text: string }> = {
  EXCLUDE_FROM_BOM: { key: "in_bom", on: "no", text: "Excluded from BOM" }, EXCLUDE_FROM_BOARD: { key: "on_board", on: "no", text: "Excluded from board" },
  EXCLUDE_FROM_SIM: { key: "exclude_from_sim", on: "yes", text: "Excluded from simulation" }, DNP: { key: "dnp", on: "yes", text: "DNP" } };
function directiveFlagText(item: Item, doc: Doc | null | undefined, token: string): string {
  const f = DIRECTIVE_FLAGS[token], at = atOf(item.node); let out = "";
  if (doc) for (const ra of doc.items.values()) {
    if (ra.kind !== "rule_area") continue;
    const k = kid(ra.node, f.key); if (!k || str(k[1]) !== f.on) continue;
    const pl = kid(ra.node, "polyline"), poly = pl ? ptsOf(pl) : [];
    if (poly.some((v, i) => onSegment(at, v, poly[(i + 1) % poly.length]))) out = f.text;
  }
  return out;
}
/**
 * SCH_LABEL_BASE::GetShownText: every ${…} of a label's text or of one of its fields through ResolveTextVar — the
 * operating point, CONNECTION_TYPE, the net's name and class (the host), a directive label's rule-area flags, the
 * label's own fields, then the sheet's and the project's variables.  A token nothing resolves stays as written.
 */
function labelShownText(item: Item, text: string, doc?: Doc | null, depth = 0): string {
  if (!text || !hasTextVars(text) || depth > 10) return text;
  const k = item.kind, n = item.node, directive = k === "directive_label" || k === "netclass_flag";
  let docVar: ((t: string) => unknown) | null = null;
  try {
    return expandTextVars(text, (token: string) => {
      if (token.startsWith("OP") && opVars.resolve) { const r = opVars.resolve("label", item, token); if (r !== null) return r; }
      if (token === "CONNECTION_TYPE" && (k === "global_label" || k === "hierarchical_label")) return CONNECTION_TYPE[str((kid(n, "shape") || [])[1])] || "???";
      if (token === "NET_NAME" || token === "SHORT_NET_NAME" || token === "NET_CLASS") { const r = labelVars.resolve ? labelVars.resolve(item, token) : null; if (r !== null) return r; return null; }
      if (directive && DIRECTIVE_FLAGS[token]) return directiveFlagText(item, doc, token);
      for (const p of kids(n, "property")) if (str(p[1]) === token && !INTERSHEET_FIELD.test(token)) return labelShownText(item, str(p[2]), doc, depth + 1);
      if (!docVar) docVar = varResolver(sheetTextVars(doc), { project: (doc && doc.projectVars) || null }) as (t: string) => unknown;
      return docVar(token) as string | null;
    });
  } catch (e) { return text; }
}
/** An item whose text or fields hold a text variable the connection graph answers (${NET_NAME}, ${SHORT_NET_NAME}, ${NET_CLASS}). */
export function hasNetTextVar(item: Item): boolean {
  const n = item.node; if (!n || !(item.kind === "label" || item.kind === "global_label" || item.kind === "hierarchical_label" || item.kind === "directive_label" || item.kind === "netclass_flag")) return false;
  const re = /\$\{(NET_NAME|SHORT_NET_NAME|NET_CLASS)\}/;
  return re.test(str(n[1])) || kids(n, "property").some((p) => re.test(str(p[2])));
}
/** The text of an item that holds an ${OP…} token (a symbol's fields, a label and its fields). */
export function hasOpTextVar(item: Item): boolean {
  const n = item.node; if (!n) return false;
  if ((item.kind === "label" || item.kind === "global_label" || item.kind === "hierarchical_label" || item.kind === "directive_label" || item.kind === "netclass_flag") && str(n[1]).indexOf("${OP") >= 0) return true;
  return kids(n, "property").some((p) => str(p[2]).indexOf("${OP") >= 0);
}

// SCH_RENDER_SETTINGS::m_OverrideItemColors (the theme's "Override individual item colors"): SCH_PAINTER::getRenderColor
// then skips every item's own stroke / text / junction colour and takes the layer's; FILLED_WITH_COLOR shape fills and
// sheet backgrounds (read through fillOf) keep theirs.
const colorOf = (node: SNode): string | null => (schFormat.overrideItemColors ? null : itemColorOf(node));
const strokeColorOf = (node: SNode): string | null => (schFormat.overrideItemColors ? null : itemStrokeColorOf(node));
const effectsOf = (node: SNode): TextEffects => { const ef = itemEffectsOf(node); if (schFormat.overrideItemColors && ef.color) ef.color = undefined; return ef; };
/** SCH_FIELD::IsNameShown: (show_name yes), or the bare token of older files. */
const nameShown = (p: SNode): boolean => yesNo(p, "show_name");
/** What buildPinGeom needs of the symbol around a pin. */
/** `literalTilde`: the file is at version 20250318 or later, where a pin named "~" is literally "~" (older files meant no name). */
export interface PinSym { literalTilde?: boolean; nameOff: number; hideNames: boolean; hideNums: boolean; maxNameHalf: number; col: (c: string) => string; alpha?: number; showHidden?: boolean; altIcons?: boolean }
/** ${VAR} in free text: the title-block / sheet / project variables GetShownText resolves; unknown ones stay as written. */
export function expandDocVars(doc: SheetContext | null | undefined, text: string): string {
  if (!text || !hasTextVars(text)) return text;
  try { return expandTextVars(text, varResolver(sheetTextVars(doc), { project: (doc && doc.projectVars) || null })); } catch (e) { return text; }
}
/** The file version from which a pin name "~" is no longer read as an empty name. */
export const TILDE_LITERAL_VERSION = 20250318;
// ---- schematic ----
// KiCad TRANSFORM matrices on library (Y up) coordinates: screen = T·lib + origin (x' = T0·x + T1·y, y' = T2·x + T3·y)
export const ORIENT: Record<number, number[]> = { 0: [1, 0, 0, -1], 90: [0, -1, -1, 0], 180: [-1, 0, 0, 1], 270: [0, 1, 1, 0] };

export function symbolTransform(rot: number, mirror: string): number[] {
  let T = ORIENT[((Math.round(rot) % 360) + 360) % 360] || ORIENT[0];
  if (mirror === "y") T = [-T[0], -T[1], T[2], T[3]];   // mirror y negates the X row
  if (mirror === "x") T = [T[0], T[1], -T[2], -T[3]];   // mirror x negates the Y row
  return T.map((v) => v + 0);   // no -0 entries
}

// KiCad's own (internal, Y-down lib coordinates) matrix, used for field/text justification: T·diag(1,-1)
export const internalT = (T: readonly number[]): number[] => [T[0], -T[1], T[2], -T[3]];

export function resolveLib(doc: Pick<KDoc, "lib">, name: string, depth?: number): SNode | null {
  const s = doc.lib.get(name); if (!s) return null;
  const ext = kid(s, "extends");
  if (ext && (depth || 0) < 4) {
    const parent = resolveLib(doc, name.split(":")[0] + ":" + str(ext[1]), (depth || 0) + 1) || resolveLib(doc, str(ext[1]), (depth || 0) + 1);
    if (parent) {
      // a derived symbol inherits the parent's drawing, pin settings and power flag
      const merged = s.slice();
      for (const c of parent.slice(1)) if (isList(c) && (c[0] === "symbol" || (c[0] === "pin_names" && !kid(s, "pin_names")) || (c[0] === "pin_numbers" && !kid(s, "pin_numbers")) || (c[0] === "power" && !kid(s, "power")))) merged.push(c);
      return merged;
    }
  }
  return s;
}


// label flag shapes (eeschema/sch_label.cpp)
export const SPIN: Record<number, string> = { 0: "R", 90: "U", 180: "L", 270: "B" };
   // file angle → spin style
export const SPIN_ROT: Record<string, number> = { L: 0, U: -90, R: 180, B: 90 };
        // template rotation per spin (RotatePoint sign)
export const SPIN_IDX: Record<string, number> = { L: 0, U: 1, R: 2, B: 3 };

export const HIER_TPL: Record<string, number[][]> = {
  input: [[0, 0, -1, -1, -2, -1, -2, 1, -1, 1, 0, 0], [0, 0, 1, -1, 1, -2, -1, -2, -1, -1, 0, 0], [0, 0, 1, 1, 2, 1, 2, -1, 1, -1, 0, 0], [0, 0, 1, 1, 1, 2, -1, 2, -1, 1, 0, 0]],
  output: [[-2, 0, -1, 1, 0, 1, 0, -1, -1, -1, -2, 0], [0, -2, 1, -1, 1, 0, -1, 0, -1, -1, 0, -2], [2, 0, 1, -1, 0, -1, 0, 1, 1, 1, 2, 0], [0, 2, 1, 1, 1, 0, -1, 0, -1, 1, 0, 2]],
  bidirectional: [[0, 0, -1, -1, -2, 0, -1, 1, 0, 0], [0, 0, -1, -1, 0, -2, 1, -1, 0, 0], [0, 0, 1, -1, 2, 0, 1, 1, 0, 0], [0, 0, -1, 1, 0, 2, 1, 1, 0, 0]],
  tri_state: [[0, 0, -1, -1, -2, 0, -1, 1, 0, 0], [0, 0, -1, -1, 0, -2, 1, -1, 0, 0], [0, 0, 1, -1, 2, 0, 1, 1, 0, 0], [0, 0, -1, 1, 0, 2, 1, 1, 0, 0]],
  passive: [[0, -1, -2, -1, -2, 1, 0, 1, 0, -1], [1, 0, 1, -2, -1, -2, -1, 0, 1, 0], [0, -1, 2, -1, 2, 1, 0, 1, 0, -1], [1, 0, 1, 2, -1, 2, -1, 0, 1, 0]],
};

export function hierShape(x: number, y: number, size: number, shape: string, spin: string): Pt[] {
  const t = (HIER_TPL[shape] || HIER_TPL.input)[SPIN_IDX[spin]]; const hs = size / 2; const pts: Pt[] = [];
  for (let i = 0; i < t.length; i += 2) pts.push([x + hs * t[i], y + hs * t[i + 1]]);
  return pts;
}

export function spinText(spin: string): { rot: number; h: string } { return { rot: spin === "U" || spin === "B" ? 90 : 0, h: spin === "R" || spin === "U" ? "left" : "right" }; }

/**
 * SCH_GLOBALLABEL::ResolveTextVar( INTERSHEET_REFS ): the pages the label's text is on (sorted, without this one unless
 * "own page" is on), "first..last" in the short form with more than two, else comma-separated, between the prefix and
 * suffix; "?" when the text is on no page.
 */
export function intersheetRefsText(refs: NonNullable<Doc["intersheetRefs"]>, label: string): string {
  const list = refs.pages[label]; let ref = "";
  if (!list) ref = "?";
  else {
    let pages = Array.from(new Set(list)).sort((a, b) => a - b);
    if (!refs.ownPage) pages = pages.filter((p) => p !== refs.current);
    const name = (p: number): string => (refs.names[p] !== undefined ? refs.names[p] : "");
    ref = refs.short && pages.length > 2 ? `${name(pages[0])}..${name(pages[pages.length - 1])}` : pages.map(name).join(",");
  }
  return refs.prefix + ref + refs.suffix;
}
const INTERSHEET_FIELD = /^intersheet ?refs$/i;
/**
 * SCH_PAINTER::getRenderColor for a field (SCH_FIELD::GetFieldColor): its own (font (color …)) when set, else the
 * layer's colour (LAYER_HIDDEN for a hidden one shown by show_hidden_fields, which still takes the field's own colour).
 * A label's field would fall back to the label's netclass colour first; netclass colours are not resolved here.
 */
export function fieldColor(ef: Pick<TextEffects, "color">, layerColor: string): string { return ef.color || layerColor; }
export function labelFields(item: Item, n: SNode, color: string, layer: string, z: number, doc?: Doc | null, labelLen = 0, textOffset: readonly number[] = [0, 0]): void {
  // SCH_PAINTER::draw( SCH_FIELD ): the field of a global label is drawn moved by the label's GetSchematicTextOffset
  const [ox, oy] = textOffset;
  for (const p of kids(n, "property")) {
    const ef = effectsOf(p); let val = str(p[2]);
    const fname = str(p[1]);
    // SCH_FIELD::GetDefaultLayer: a local label's Netclass / Component Class field is on LAYER_NETCLASS_REFS
    const nc = item.kind === "label" && (fname === "Netclass" || fname === "Component Class");
    const fColor = nc ? SCH.netclass : color, fz = nc ? SCH_Z.netclass : z;
    // the global label's Intersheetrefs field: shown (whatever its own flag) when Formatting > Show inter-sheet
    // references is on (SCHEMATIC::RecomputeIntersheetRefs sets it visible), its ${INTERSHEET_REFS} resolved
    if (item.kind === "global_label" && INTERSHEET_FIELD.test(str(p[1])) && /\$\{INTERSHEET_REFS\}/.test(val)) {
      const refs = doc && doc.intersheetRefs; if (!refs || !refs.show) continue;
      val = val.replace(/\$\{INTERSHEET_REFS\}/g, intersheetRefsText(refs, str(n[1])));
      let [px, py, pr] = atOf(p), just = ef.just;
      // RecomputeIntersheetRefs: a lone field still on the label's own position is autoplaced first
      // (SCH_LABEL_BASE::AutoplaceFields: beside the body, labelLen + 2 × text offset out along the spin)
      const [lx, ly, lr] = atOf(n);
      if (kids(n, "property").length === 1 && Math.abs(px - lx) < 1e-6 && Math.abs(py - ly) < 1e-6) {
        const lef = effectsOf(n), margin = 2 * schFormat.textOffsetRatio * lef.size, d = labelLen + margin;
        const spin = SPIN[((Math.round(lr) % 360) + 360) % 360] || "R";
        if (spin === "L") { px = lx - d; pr = 0; just = ["right"]; } else if (spin === "R") { px = lx + d; pr = 0; just = ["left"]; }
        else if (spin === "U") { py = ly - d; pr = 90; just = ["left"]; } else { py = ly + d; pr = 90; just = ["right"]; }
      }
      // LAYER_INTERSHEET_REFS draws in LAYER_GLOBLABEL's colour (RENDER_SETTINGS::GetLayerColor)
      // GetShownText: the variables resolved, then "Name: " ahead of the text when the name is shown
      val = labelShownText(item, val, doc);
      if (nameShown(p)) val = fname + ": " + val;
      textLines(item, px + ox, py + oy, val, ef.size, ef.color || SCH.glabel, pr, just, layer, { z: SCH_Z.intersheet, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX, lineSpacing: ef.lineSpacing, field: str(p[1]), olKind: "field" });
      continue;
    }
    // SCH_FIELD::GetShownText: the variables resolved (SCH_LABEL_BASE::ResolveTextVar; one nothing resolves is shown as
    // written, as KiCad does), then "Name: " ahead of the text when the name is shown; an empty shown text is not drawn
    val = labelShownText(item, val, doc);
    if (nameShown(p)) val = fname + ": " + val;
    if (!val) continue;
    const [px0, py0, pr] = atOf(p), px = px0 + ox, py = py0 + oy;
    // a hidden field: kept aside in LAYER_HIDDEN for show_hidden_fields, outside the hit boxes
    const sink: GeomSink = ef.hide ? { geom: [], bbox: null } : item;
    textLines(sink, px, py, val, ef.size, fieldColor(ef, ef.hide ? SCH.hidden : fColor), pr, ef.just, layer, { z: fz, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX, lineSpacing: ef.lineSpacing, field: str(p[1]), olKind: "field" });
    if (ef.hide && sink.geom.length) { const sc = fieldColor(ef, fColor); for (const g of sink.geom) { g.hiddenText = true; g.noBox = true; if (g.color) g.shownColor = sc; } (item.hiddenGeom = item.hiddenGeom || []).push(...sink.geom); }
  }
}


export function buildSchGeom(doc: Doc, item: Item): void {
  setSchTextVersion(doc && doc.version);
  const n = item.node, k = item.kind;
  if (k === "wire" || k === "bus" || k === "polyline") {
    const p = ptsOf(n); const isBus = k === "bus";
    // SCH_LINE::GetPenWidth: a width of 0 (or less) is the default: the wire / bus width, the schematic's default line width for a graphic line
    const w0 = widthOf(n, 0); const w = w0 > 0 ? w0 : isBus ? 0.3048 : k === "polyline" ? SCH_PEN : 0.1524;
    const color = strokeColorOf(n) || (isBus ? SCH.bus : k === "polyline" ? SCH.notes : SCH.wire);
    if (k === "polyline" && p.length > 2) {
      // a closed polyline with a fill (drawPolygon writes one): SCH_SHAPE fill rules, as for library bodies
      const f = fillOf(n);
      const fill = f.type === "background" ? SCH.body : f.type === "outline" || f.type === "solid" ? color : f.type === "color" ? f.color : null;
      if (fill) G(item, { t: "poly", pts: p, close: true, w: 0, color: fill, fill, layer: "Notes", z: f.type === "outline" || f.type === "solid" ? SCH_Z.notes : SCH_Z.shapesBg, noStroke: true });
    }
    if (k === "polyline" && hasEndings(n)) {
      // KiCad 10 line endings: the body is shortened (ShortenSegmentForEndings / ShortenPolyForEndings), the
      // endings drawn along the outward tangent at each end
      const e = readEndings(n), tan = polyTangents(p);
      const seg = p.length === 2 ? shortenSegment(p[0], p[1], e.start, e.end, w) : null;
      const body = p.length === 2 ? (seg ? [seg[0], seg[1]] : null) : shortenPoly(p, e.start, e.end, w);
      if (body) G(item, Object.assign({ t: "poly" as const, pts: body, close: false, w, color, layer: "Notes", z: SCH_Z.notes, cap: "round" }, dashOf(n)));
      emitEnding(item, e.start, p[0], tan[0], w, color, "Notes", SCH_Z.notes); emitEnding(item, e.end, p[p.length - 1], tan[1], w, color, "Notes", SCH_Z.notes);
    } else
    G(item, Object.assign({ t: "poly" as const, pts: p, close: false, w, color, layer: isBus ? "Buses" : k === "polyline" ? "Notes" : "Wires", z: isBus ? SCH_Z.bus : k === "polyline" ? SCH_Z.notes : SCH_Z.wire, cap: "round" }, dashOf(n)));
  } else if (k === "bus_entry") {
    // wire-to-bus entries take the wire colour and width
    const [x, y] = atOf(n); const s = kid(n, "size"); const dx = s ? num(s[1]) : 2.54, dy = s ? num(s[2]) : 2.54;
    G(item, Object.assign({ t: "line" as const, x1: x, y1: y, x2: x + dx, y2: y + dy, w: widthOf(n, 0) || 0.1524, color: strokeColorOf(n) || SCH.busEntry, layer: "Wires", z: SCH_Z.wire, cap: "round" }, dashOf(n)));
  } else if (k === "junction") {
    const [x, y] = atOf(n); const d = kid(n, "diameter"); const dflt = doc && doc.schSettings && typeof doc.schSettings.junctionDiameter === "number" ? doc.schSettings.junctionDiameter : 0.9144;   // Schematic Setup > Formatting > Junction dot size
    const r = (d && num(d[1]) > 0 ? num(d[1]) : dflt) / 2;
    G(item, { t: "circle", x, y, r, w: 0, color: colorOf(n) || SCH.junction, fill: colorOf(n) || SCH.junction, layer: "Junctions", z: SCH_Z.junction });
  } else if (k === "no_connect") {
    const [x, y] = atOf(n); const s = Math.max(1.2192, SCH_PEN * 3) / 2;   // DEFAULT_NOCONNECT_SIZE 48 mil
    G(item, { t: "line", x1: x - s, y1: y - s, x2: x + s, y2: y + s, w: SCH_PEN, color: SCH.noconnect, layer: "No-connects", z: SCH_Z.noconnect });
    G(item, { t: "line", x1: x - s, y1: y + s, x2: x + s, y2: y - s, w: SCH_PEN, color: SCH.noconnect, layer: "No-connects", z: SCH_Z.noconnect });
  } else if (k === "label" || k === "global_label" || k === "hierarchical_label" || k === "netclass_flag" || k === "directive_label") {
    buildLabelGeom(item, n, k, doc);
  } else if (k === "text") {
    const [x, y, rot] = atOf(n); const ef = effectsOf(n);
    // SCH_TEXT::GetSchematicTextOffset: a fixed 0.25 mm lift; angles are kept upright (KeepUpright)
    textLines(item, x, y - 0.25, expandDocVars(doc, str(n[1])), ef.size, ef.color || SCH.notes, rot, ef.just, "Notes", { z: SCH_Z.notes, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX, lineSpacing: ef.lineSpacing, olKind: "text", olLift: 0.25 });
  } else if (k === "text_box") {
    const [x, y, rot] = atOf(n); const s = kid(n, "size"); const w = s ? num(s[1]) : 10, h = s ? num(s[2]) : 5; const ef = effectsOf(n);
    const x0 = Math.min(x, x + w), y0 = Math.min(y, y + h), x1 = Math.max(x, x + w), y1 = Math.max(y, y + h);
    const bw = widthOf(n, 0); const border = bw < 0 ? 0 : (bw || SCH_PEN); const f = fillOf(n);
    const fill = f.type === "color" ? f.color : f.type === "background" ? SCH.body : f.type === "solid" ? SCH.notes : null;
    if (fill) G(item, { t: "rect", x: x0, y: y0, w: x1 - x0, h: y1 - y0, wd: 0, color: fill, fill, layer: "Notes", z: SCH_Z.shapesBg, noStroke: true });
    if (border > 0) G(item, Object.assign({ t: "rect" as const, x: x0, y: y0, w: x1 - x0, h: y1 - y0, wd: border, color: strokeColorOf(n) || SCH.notes, fill: null, layer: "Notes", z: SCH_Z.notes }, dashOf(n)));
    const mg = kid(n, "margins"); const lm = mg ? num(mg[1]) : border / 2 + ef.size * 0.75, tm = mg ? num(mg[2]) : lm, rm = mg ? num(mg[3]) : lm, bm = mg ? num(mg[4]) : lm;
    const j = justOf(ef.just);   // the file default is centre / centre (parseEDA_TEXT)
    const vert = ((rot % 180) + 180) % 180 === 90;
    // SCH_TEXTBOX::GetDrawPos: anchor on the box edge matching the justification
    let tx: number, ty: number;
    if (vert) { ty = j.h === "left" ? y1 - bm : j.h === "right" ? y0 + tm : (y0 + y1) / 2; tx = j.v === "top" ? x0 + lm : j.v === "bottom" ? x1 - rm : (x0 + x1) / 2; }
    else { tx = j.h === "left" ? x0 + lm : j.h === "right" ? x1 - rm : (x0 + x1) / 2; ty = j.v === "top" ? y0 + tm : j.v === "bottom" ? y1 - bm : (y0 + y1) / 2; }
    // SCH_TEXTBOX::GetShownText: wrapped to the box's inner width (its height when the text runs vertically)
    const col = vert ? (y1 - y0) - tm - bm : (x1 - x0) - lm - rm;
    textLines(item, tx, ty, linebreakText(unescapeText(expandDocVars(doc, str(n[1]))), col, ef.sizeX, ef.thick, ef.italic), ef.size, ef.color || SCH.notes, rot, [j.h, j.v], "Notes", { z: SCH_Z.notes, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX, lineSpacing: ef.lineSpacing });
  } else if (k === "rectangle" || k === "circle" || k === "arc" || k === "bezier" || k === "ellipse" || k === "ellipse_arc") {
    shapeGeom(item, n, k, (x: number, y: number) => [x, y], SCH.notes, "Notes", SCH_Z.notes, SCH_Z.shapesBg, widthOf(n, 0) || SCH_PEN);
  } else if (k === "rule_area") {
    for (const pl of kids(n, "polyline")) {
      const p = ptsOf(pl); if (p.length < 2) continue;
      // SCH_PAINTER::draw( SCH_SHAPE ) for a SCH_RULE_AREA: the fill on LAYER_NOTES_BACKGROUND (a FILLED_SHAPE one on
      // LAYER_RULE_AREAS, in the border colour), a colour left unspecified falling back to LAYER_RULE_AREAS
      const w0 = widthOf(pl, 0), w = w0 || SCH_PEN, sc = strokeColorOf(pl) || SCH.ruleArea, f = fillOf(pl);
      const solid = f.type === "outline" || f.type === "solid";
      const fill = f.type === "background" ? SCH.body : f.type === "color" ? f.color || SCH.ruleArea : solid ? sc : null;
      if (fill && p.length > 2) G(item, { t: "poly", pts: p, close: true, w: 0, color: fill, fill, layer: "Rule areas", z: solid ? SCH_Z.ruleArea : SCH_Z.notesBg, noStroke: true });
      hatchGeom(item, p, f.type, w > 0 ? w : SCH_PEN, f.color || SCH.ruleArea, "Rule areas", SCH_Z.notesBg);
      if (w0 >= 0) G(item, Object.assign({ t: "poly" as const, pts: p, close: true, w, color: sc, layer: "Rule areas", z: SCH_Z.ruleArea }, dashOf(pl)));
      else if (!item.bbox || !item.geom.length) for (const q of p) bboxAdd(item, q[0], q[1]);
    }
  } else if (k === "table") {
    buildTableGeom(doc, item, n);
  } else if (k === "image") {
    buildImageGeom(doc, item, n);
  } else if (k === "sheet") {
    buildSheetGeom(item, n, doc);
  } else if (k === "symbol") {
    buildSymbolGeom(doc, item);
  }
}

/**
 * ROUNDRECT::TransformToPolygon: the rectangle x0,y0 – x1,y1 with each corner a quarter circle of radius r (at most
 * half the shorter side).  With `maxError` (mm) each corner has as many segments as that error allows (a board's
 * ARC_HIGH_DEF); without it, eight.
 */
export function roundRectPts(x0: number, y0: number, x1: number, y1: number, r: number, maxError?: number): Pt[] {
  const l = Math.min(x0, x1), t = Math.min(y0, y1), rr = Math.max(x0, x1), b = Math.max(y0, y1);
  r = Math.min(r, (rr - l) / 2, (b - t) / 2); if (!(r > 0)) return [[l, t], [rr, t], [rr, b], [l, b]];
  const step = maxError && r > maxError ? 2 * Math.acos(1 - maxError / r) : Math.PI / 2;
  const out: Pt[] = [], n = maxError ? Math.max(1, Math.ceil((Math.PI / 2) / step)) : 8;
  const corner = (cx: number, cy: number, a0: number) => { for (let i = 0; i <= n; i++) { const a = a0 + (Math.PI / 2) * i / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
  corner(rr - r, t + r, -Math.PI / 2); corner(rr - r, b - r, 0); corner(l + r, b - r, Math.PI / 2); corner(l + r, t + r, Math.PI);
  return out;
}
/**
 * EDA_SHAPE::UpdateHatching for an SCH_SHAPE filled hatch / reverse_hatch / cross_hatch: lines of slope -1, +1 or
 * both, GetHatchLineWidth() = effective width / 2 wide, 40 of those apart (at most 100 lines across the major
 * axis), clipped to the outline; drawn on the background layer in the fill colour (the stroke colour when none).
 */
export function hatchGeom(item: GeomSink, outline: Pt[], type: string, w: number, color: string, layer: string, z: number, pcb = false): void {
  const slopes = type === "cross_hatch" ? [1, -1] : type === "hatch" ? [-1] : type === "reverse_hatch" ? [1] : null;
  if (!slopes || outline.length < 3) return;
  // pcb: EDA_SHAPE's own GetHatchLineWidth() = the effective width, GetHatchLineSpacing() = 10 of those (eda_shape.h:168-169)
  const lw = pcb ? w : w / 2; let spacing = lw * (pcb ? 10 : 40); if (!(spacing > 0)) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of outline) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const major = Math.max(x1 - x0, y1 - y0); if (major / spacing > 100) spacing = major / 100;
  for (const sl of slopes) for (const [ax, ay, bx, by] of hatchLines(outline, sl, spacing, -1))
    G(item, { t: "line", x1: ax, y1: ay, x2: bx, y2: by, w: lw, color, layer, z, cap: "round", noShadow: true, ...(pcb ? { hatchLine: true } : {}) });
}

/** Graphic shape shared by sheet-level notes and library bodies (tf maps node coords to screen). */
export function shapeGeom(item: GeomSink, g: SNode, gk: string, tf: Tf, color: string, layer: string, z: number, zBg: number, w: number, bodyFill?: unknown, invertY?: boolean): void {
  const f = fillOf(g); const sc = strokeColorOf(g) || color;
  const fill = f.type === "background" ? SCH.body : f.type === "outline" ? sc : f.type === "color" ? f.color : f.type === "solid" ? sc : null;
  const fz = f.type === "outline" || f.type === "solid" ? z : zBg;   // KiCad fills device-coloured shapes in the foreground
  const closed = f.type !== "none"; const ds = dashOf(g);
  // SCH_ITEM::GetEffectivePenWidth: a negative pen width is "no border" (SCH_PAINTER strokes only when lineWidth > 0):
  // the fill and hatch stay, the outline and its line endings are not drawn (the shape keeps its hit box)
  const border = w >= 0; if (!border) w = SCH_PEN;
  const O = <T extends Geom>(g: T): void => {
    if (border) { G(item, g); return; }
    if ((g as { fill?: string | null }).fill) { G(item, Object.assign(g, { w: 0, noStroke: true })); return; }
    const ghost: GeomSink = { geom: [], bbox: null }; G(ghost, g); const bb = ghost.bbox as Box | null;
    if (bb) { bboxAdd(item, bb[0], bb[1]); bboxAdd(item, bb[2], bb[3]); }
  };
  const hatch = (outline: Pt[]) => hatchGeom(item, outline, f.type, w, f.color || sc, layer, zBg);
  if (gk === "rectangle") {
    const s0 = kid(g, "start"), e0 = kid(g, "end"); if (!s0 || !e0) return;
    const x0 = num(s0[1]), y0 = num(s0[2]), x1 = num(e0[1]), y1 = num(e0[2]);
    // (radius r): SCH_PAINTER draws a ROUNDRECT, its fill and shadow following the same outline
    const rN = kid(g, "radius"), rad = rN ? num(rN[1]) : 0;
    const pts = rad > 0 ? roundRectPts(x0, y0, x1, y1, rad).map(([x, y]) => tf(x, y)) : [tf(x0, y0), tf(x1, y0), tf(x1, y1), tf(x0, y1)];
    if (fill) G(item, { t: "poly", pts, close: true, w: 0, color: fill, fill, layer, z: fz, noStroke: true });
    hatch(pts);
    O(Object.assign({ t: "poly" as const, pts, close: true, w, color: sc, layer, z }, ds));
  } else if (gk === "polyline" || gk === "bezier") {
    const ctrl = ptsOf(g).map(([x, y]) => tf(x, y)); let p = ctrl; if (p.length < 2) return;
    if (gk === "bezier") p = bezierPts(p);
    if (fill && p.length > 2) G(item, { t: "poly", pts: p, close: true, w: 0, color: fill, fill, layer, z: fz, noStroke: true });
    if (gk === "polyline" && p.length > 2) hatch(p);
    if (hasEndings(g)) {
      const e = readEndings(g);
      let body: Pt[] | null, tan: [Pt | null, Pt | null];
      if (gk === "bezier") { const r = bezierEndings(p, ctrl, e.start, e.end, w); body = r.body; tan = r.tan; }
      else { body = shortenPoly(p, e.start, e.end, w); tan = polyTangents(p); }
      if (body) O(Object.assign({ t: "poly" as const, pts: body, close: false, w, color: sc, layer, z }, ds));
      if (border) emitEnding(item, e.start, p[0], tan[0], w, sc, layer, z); if (border) emitEnding(item, e.end, p[p.length - 1], tan[1], w, sc, layer, z);
      return;
    }
    O(Object.assign({ t: "poly" as const, pts: p, close: false, w, color: sc, layer, z }, ds));
  } else if (gk === "circle") {
    const c = kid(g, "center"), r = kid(g, "radius"); if (!c) return; const [cx, cy] = tf(num(c[1]), num(c[2]));
    const rad = r ? num(r[1]) : 1;
    if (fill) G(item, { t: "circle", x: cx, y: cy, r: rad, w: 0, color: fill, fill, layer, z: fz, noStroke: true });
    if (f.type.endsWith("hatch")) { const ring: Pt[] = []; for (let i = 0; i < 64; i++) ring.push([cx + rad * Math.cos(i * Math.PI / 32), cy + rad * Math.sin(i * Math.PI / 32)]); hatch(ring); }
    O(Object.assign({ t: "circle" as const, x: cx, y: cy, r: rad, w, color: sc, layer, z }, ds));
  } else if (gk === "ellipse" || gk === "ellipse_arc") {
    const e = ellipsePts(g, invertY); if (!e) return; const p = e.pts.map(([x, y]) => tf(x, y));
    if (fill && p.length > 2) G(item, { t: "poly", pts: p, close: true, w: 0, color: fill, fill, layer, z: fz, noStroke: true });
    if (gk === "ellipse") hatch(p);
    O(Object.assign({ t: "poly" as const, pts: p, close: e.closed, w, color: sc, layer, z }, ds));
  } else if (gk === "arc") {
    const s0 = kid(g, "start"), m0 = kid(g, "mid"), e0 = kid(g, "end"); if (!s0 || !m0 || !e0) return;
    const a = arcFrom3(tf(num(s0[1]), num(s0[2])), tf(num(m0[1]), num(m0[2])), tf(num(e0[1]), num(e0[2])));
    if (a && hasEndings(g)) {
      const e = readEndings(g), body = shortenArc(a, e.start, e.end, w), tan = arcTangents(a), [ps, pe] = arcEnds(a);
      if (body) O(Object.assign({ t: "arc" as const, w, color: sc, layer, z, fill: closed ? fill : null }, body, ds));
      if (border) emitEnding(item, e.start, ps, tan[0], w, sc, layer, z); if (border) emitEnding(item, e.end, pe, tan[1], w, sc, layer, z);
    } else if (a) O(Object.assign({ t: "arc" as const, w, color: sc, layer, z, fill: closed ? fill : null }, a, ds));
    else { const p0 = tf(num(s0[1]), num(s0[2])), p1 = tf(num(e0[1]), num(e0[2])); O(Object.assign({ t: "line" as const, x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], w, color: sc, layer, z }, ds)); }
  }
}

export function buildLabelGeom(item: Item, n: SNode, k: string, doc?: Doc | null): void {
  const [x, y, rot] = atOf(n); const ef = effectsOf(n); const text = labelShownText(item, str(n[1]), doc); const size = ef.size;
  const spin = SPIN[((Math.round(rot) % 360) + 360) % 360] || "R"; const st = spinText(spin);
  const pen = textPen(ef, size), lpen = layoutPen(ef, size); const off = schFormat.textOffsetRatio * size;   // SCHEMATIC_SETTINGS::m_TextOffsetRatio
  const shapeN = kid(n, "shape"); const shape = shapeN ? str(shapeN[1]) : "";
  if (k === "label") {
    const d = off + lpen; const tx = st.rot ? x - d : x, ty = st.rot ? y : y - d;
    textGeom(item, tx, ty, text, size, ef.color || SCH.label, st.rot, [st.h, "bottom"], "Labels", { z: SCH_Z.loclabel, w: pen, italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX });
    labelFields(item, n, SCH.field, "Fields", SCH_Z.fields, doc);
  } else if (k === "global_label") {
    const color = ef.color || SCH.glabel; const margin = schFormat.labelSizeRatio * size;   // SCHEMATIC_SETTINGS::m_LabelSizeRatio
    let horiz = margin; if (shape === "input" || shape === "bidirectional" || shape === "tri_state") horiz += size * 0.75;
    const vert = size * 0.0715;
    const to = spin === "L" ? [-horiz, vert] : spin === "U" ? [vert, -horiz] : spin === "R" ? [horiz, vert] : [vert, horiz];
    textGeom(item, x + to[0], y + to[1], text, size, color, st.rot, [st.h, "middle"], "Labels", { z: SCH_Z.globlabel, w: pen, italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX });
    // outline: SCH_GLOBALLABEL::CreateGraphicShape
    const halfSize = size / 2 + margin; const symbLen = textWidth(parseMarkup(text).text, size, lpen) + 2 * margin;
    const bx = symbLen + lpen, by = halfSize + lpen;
    let pts: Pt[] = [[0, 0], [0, -by], [-bx, -by], [-bx, 0], [-bx, by], [0, by]]; let xo = 0;
    if (shape === "input") { xo = -halfSize; pts[0][0] += halfSize; }
    else if (shape === "output") pts[3][0] -= halfSize;
    else if (shape === "bidirectional" || shape === "tri_state") { xo = -halfSize; pts[0][0] += halfSize; pts[3][0] -= halfSize; }
    pts = pts.map(([px, py]) => { const [rx, ry] = rotPt(px + xo, py, SPIN_ROT[spin]); return [x + rx, y + ry]; });
    G(item, { t: "poly", pts, close: true, w: lpen, color, layer: "Labels", z: SCH_Z.globlabel });   // getLineWidth( aLabel ): GetPenWidth, the label's own text pen
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);   // GetBodyBoundingBox().GetSizeMax()
    labelFields(item, n, SCH.field, "Fields", SCH_Z.fields, doc, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)), to);
  } else if (k === "hierarchical_label") {
    const color = ef.color || SCH.hlabel; const d = off + ef.sizeX;
    const to = spin === "L" ? [-d, 0] : spin === "U" ? [0, -d] : spin === "R" ? [d, 0] : [0, d];
    textGeom(item, x + to[0], y + to[1], text, size, color, st.rot, [st.h, "middle"], "Labels", { z: SCH_Z.hierlabel, w: pen, italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX });
    G(item, { t: "poly", pts: hierShape(x, y, size, shape || "input", spin), close: false, w: lpen, color, layer: "Labels", z: SCH_Z.hierlabel });
    labelFields(item, n, SCH.field, "Fields", SCH_Z.fields, doc);
  } else {
    // directive label / netclass flag: SCH_DIRECTIVE_LABEL::CreateGraphicShape
    const color = ef.color || SCH.netclass; const lenN = kid(n, "length"); const pinLen = lenN ? num(lenN[1]) : 2.54;
    const symSize = 0.508; let s = symSize; let pts: Pt[], kind = shape || "round";
    if (kind === "dot") { s = symSize * 0.7; pts = [[0, 0], [0, pinLen - s], [0, pinLen]]; }
    else if (kind === "round") pts = [[0, 0], [0, pinLen - s], [0, pinLen]];
    else if (kind === "diamond") pts = [[0, 0], [0, pinLen - s], [-2 * symSize, pinLen], [0, pinLen + s], [2 * symSize, pinLen], [0, pinLen - s]];
    else { s = symSize * 0.8; pts = [[0, 0], [0, pinLen - s], [-2 * s, pinLen - s], [-2 * s, pinLen + s], [2 * s, pinLen + s], [2 * s, pinLen - s], [0, pinLen - s]]; }
    pts = pts.map(([px, py]) => { const [rx, ry] = rotPt(px, py, SPIN_ROT[spin]); return [x + rx, y + ry]; });
    const w = Math.max(pen, SCH_PEN);
    if (kind === "dot" || kind === "round") {
      G(item, { t: "line", x1: pts[0][0], y1: pts[0][1], x2: pts[1][0], y2: pts[1][1], w, color, layer: "Labels", z: SCH_Z.loclabel });
      G(item, { t: "circle", x: pts[2][0], y: pts[2][1], r: Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]), w, color, fill: kind === "dot" ? color : null, layer: "Labels", z: SCH_Z.loclabel });
    } else G(item, { t: "poly", pts, close: false, w, color, layer: "Labels", z: SCH_Z.loclabel });
    // SCH_PAINTER::draw( SCH_DIRECTIVE_LABEL ) draws the shape and the fields, never the label's own text; the fields
    // are on LAYER_FIELDS (SCH_FIELD::GetDefaultLayer: only a local label's Netclass field is on LAYER_NETCLASS_REFS)
    labelFields(item, n, SCH.field, "Fields", SCH_Z.fields, doc);
  }
}

export function buildSheetGeom(item: Item, n: SNode, doc?: Doc | null): void {
  const [x, y] = atOf(n); const s = kid(n, "size"); const w = s ? num(s[1]) : 20, h = s ? num(s[2]) : 20;
  const f = fillOf(n); const bw = widthOf(n, 0) || SCH_PEN;
  // (dnp yes): the sheet, its fields and pins dimmed (draw( …, DNP )) under the red cross; (exclude_from_sim yes): the marker
  const dnp = yesNo(n, "dnp"), noSim = yesNo(n, "exclude_from_sim");
  const col = dnp ? (c: string) => dimColor(c, SCH.bg) : (c: string) => c;
  // the sheet's own background, else the theme's LAYER_SHEET_BACKGROUND; drawn when its alpha is above 0
  const bgc = f.color || (parseColor(SCH.sheetBg)[3] > 0 ? SCH.sheetBg : null);
  if (bgc) G(item, { t: "rect", x, y, w, h, wd: 0, color: col(bgc), fill: col(bgc), layer: "Sheets", z: SCH_Z.sheetBg, noStroke: true });
  G(item, Object.assign({ t: "rect" as const, x, y, w, h, wd: bw, color: col(strokeColorOf(n) || SCH.sheet), fill: null, layer: "Sheets", z: SCH_Z.sheet }, dashOf(n)));
  item.movable = true; item.x = x; item.y = y; item.w = w; item.h = h; item.rot = 0;
  // A subsheet's page number lives HERE, in the parent's instance data — the child's own file has no
  // (sheet_instances …) at all.  SCH_SCREEN::GetPageNumber() is what feeds the child's ${#}
  // (eeschema/sch_view.cpp:134), so the child cannot answer it from its own text.
  const inst = kid(n, "instances");
  if (inst) for (const proj of kids(inst, "project")) for (const path of kids(proj, "path")) { const pg = kid(path, "page"); if (pg) { item.page = str(pg[1]); break; } }
  for (const p of kids(n, "property")) {
    const name = str(p[1]), val = str(p[2]); const ef = effectsOf(p);
    if (name === "Sheetname") item.name = val; if (name === "Sheetfile") item.file = val;
    if (!val) continue;
    const [px, py, pr] = atOf(p);
    // a hidden field: kept aside in LAYER_HIDDEN for show_hidden_fields, outside the hit boxes
    const sink: GeomSink = ef.hide ? { geom: [], bbox: null } : item;
    const color = col(fieldColor(ef, ef.hide ? SCH.hidden : name === "Sheetname" ? SCH.sheetName : name === "Sheetfile" ? SCH.sheetFile : SCH.sheetFields));
    // SCH_FIELD::GetShownText: the value as written ("Name: " ahead of it when the name is shown), its variables
    // resolved against the sheet's own fields (SCH_SHEET::ResolveTextVar) and the document's
    let shown = (nameShown(p) ? name + ": " : "") + val;
    if (hasTextVars(shown)) {
      shown = expandTextVars(shown, (tok) => { const up = tok.toUpperCase(); for (const q of kids(n, "property")) if (q !== p && str(q[1]).toUpperCase() === up) return str(q[2]); return null; }, 0, { finalize: false });
      shown = expandDocVars(doc, shown);
    }
    textLines(sink, px, py, shown, ef.size, color, pr, ef.just, "Sheets", { z: name === "Sheetname" ? SCH_Z.sheetName : name === "Sheetfile" ? SCH_Z.sheetFile : SCH_Z.sheetFields, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX, lineSpacing: ef.lineSpacing, field: name, olKind: "field" });
    if (ef.hide && sink.geom.length) { const sc = col(fieldColor(ef, name === "Sheetname" ? SCH.sheetName : name === "Sheetfile" ? SCH.sheetFile : SCH.sheetFields)); for (const g of sink.geom) { g.hiddenText = true; g.noBox = true; if (g.color) g.shownColor = sc; } (item.hiddenGeom = item.hiddenGeom || []).push(...sink.geom); }
  }
  for (const pin of kids(n, "pin")) {
    const [px, py, pr] = atOf(pin); const ef = effectsOf(pin); const size = ef.size; const pen = textPen(ef, size);
    // side → spin: right edge reads leftwards into the sheet, etc. (SCH_SHEET_PIN::SetSide)
    const side = ((Math.round(pr) % 360) + 360) % 360; const spin = side === 0 ? "L" : side === 90 ? "B" : side === 180 ? "R" : "U";
    let shape = str(pin[2]) || "input"; if (shape === "input") shape = "output"; else if (shape === "output") shape = "input";
    const g0 = item.geom.length;
    // SCH_PAINTER draws a SCH_SHEET_PIN through draw( SCH_HIERLABEL ): the shape in LAYER_HIERLABEL, only the text in
    // LAYER_SHEETLABEL (the pin's own text colour wins for both)
    const pinColor = col(ef.color || SCH.sheetLabel), shapeColor = col(ef.color || SCH.hlabel);
    G(item, { t: "poly", pts: hierShape(px, py, size, shape, spin), close: false, w: SCH_PEN, color: shapeColor, layer: "Sheets", z: SCH_Z.sheetPin });
    const d = schFormat.textOffsetRatio * size + ef.sizeX; const st = spinText(spin);   // GetTextOffset() + GetTextWidth()
    const to = spin === "L" ? [-d, 0] : spin === "U" ? [0, -d] : spin === "R" ? [d, 0] : [0, d];
    textGeom(item, px + to[0], py + to[1], str(pin[1]), size, pinColor, st.rot, [st.h, "middle"], "Sheets", { z: SCH_Z.sheetPin, w: pen, italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX });
    for (let i = g0; i < item.geom.length; i++) item.geom[i].pinNo = str(pin[1]);   // "sheetId#pin:<name>" in a net highlight
  }
  if (dnp && schFormat.showDnpMarkers) {   // m_ShowDNPMarkers
    // the symbol's DNP cross: the body box grown toward the pins (GetBoundingBox), 3 x the default line width
    const all = item.bbox || [x, y, x + w, y + h];
    const mx0 = Math.max(x - all[0], all[2] - (x + w)), my0 = Math.max(y - all[1], all[3] - (y + h));
    const mx = Math.max(mx0 * 0.6, my0 * 0.3), my = Math.max(my0 * 0.6, mx0 * 0.3);
    const b = [x - mx, y - my, x + w + mx, y + h + my];
    G(item, { t: "line", x1: b[0], y1: b[1], x2: b[2], y2: b[3], w: 3 * 6 * MIL, color: SCH.dnp, layer: "Sheets", z: SCH_Z.marker, cap: "round" });
    G(item, { t: "line", x1: b[2], y1: b[1], x2: b[0], y2: b[3], w: 3 * 6 * MIL, color: SCH.dnp, layer: "Sheets", z: SCH_Z.marker, cap: "round" });
  }
  if (noSim) { const sw = 25 * MIL; simMarker(item, [x - sw / 2, y - sw / 2, x + w + sw / 2, y + h + sw / 2], sw, 0.5); }
}

/**
 * SCH_PAINTER::draw( SCH_TEXTBOX ) for a text box of a placed symbol.  OrientAndMirrorSymbolItems turns the library
 * item with the symbol: each quarter turn rotates the rectangle and swaps the text between horizontal and vertical
 * (SCH_TEXTBOX::Rotate), a mirror flips the rectangle and the horizontal justification of text running across the
 * mirror axis (MirrorHorizontally / MirrorVertically).  Then the fill on its background layer, the wrapped text at
 * GetDrawPos and the border (default pen when 0, none when negative; the stroke colour or LAYER_DEVICE).
 */
function symbolTextBox(item: GeomSink, g: SNode, tf: Tf, rot: number, mirror: string, text: string, ef: TextEffects, col: (c: string) => string, layer: string): void {
  const [tx, ty, tr] = atOf(g); const sN = kid(g, "size"); const sw = sN ? num(sN[1]) : 5, sh = sN ? num(sN[2]) : -2.5;   // saveTextBox writes -height (library Y up)
  const a = tf(tx, ty), b = tf(tx + sw, ty + sh);
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]), x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const turns = ((Math.round(rot / 90) % 4) + 4) % 4;
  const vert = (((Math.round(tr) % 180) + 180) % 180 === 90) !== (turns % 2 === 1);
  const j = justOf(ef.just);
  if ((mirror === "y" && !vert) || (mirror === "x" && vert)) j.h = j.h === "left" ? "right" : j.h === "right" ? "left" : j.h;
  const bw = widthOf(g, 0); const border = bw < 0 ? 0 : (bw || SCH_PEN); const f = fillOf(g);
  const fill = f.type === "color" ? f.color : f.type === "background" ? SCH.body : f.type === "solid" || f.type === "outline" ? strokeColorOf(g) || SCH.outline : null;
  if (fill) G(item, { t: "rect", x: x0, y: y0, w: x1 - x0, h: y1 - y0, wd: 0, color: col(fill), fill: col(fill), layer, z: f.type === "background" ? SCH_Z.deviceBg : SCH_Z.shapesBg, noStroke: true });
  const mg = kid(g, "margins"); const lm = mg ? num(mg[1]) : border / 2 + ef.size * 0.75, tm = mg ? num(mg[2]) : lm, rm = mg ? num(mg[3]) : lm, bm = mg ? num(mg[4]) : lm;
  // SCH_TEXTBOX::GetDrawPos: anchor on the box edge matching the justification
  let px: number, py: number;
  if (vert) { py = j.h === "left" ? y1 - bm : j.h === "right" ? y0 + tm : (y0 + y1) / 2; px = j.v === "top" ? x0 + lm : j.v === "bottom" ? x1 - rm : (x0 + x1) / 2; }
  else { px = j.h === "left" ? x0 + lm : j.h === "right" ? x1 - rm : (x0 + x1) / 2; py = j.v === "top" ? y0 + tm : j.v === "bottom" ? y1 - bm : (y0 + y1) / 2; }
  // SCH_TEXTBOX::GetShownText: wrapped to the box's inner width (its height when the text runs vertically)
  const colW = vert ? (y1 - y0) - tm - bm : (x1 - x0) - lm - rm;
  textLines(item, px, py, linebreakText(unescapeText(text), colW, ef.sizeX, ef.thick, ef.italic), ef.size, col(ef.color || SCH.outline), vert ? 90 : 0, [j.h, j.v], layer, { z: SCH_Z.device, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX, lineSpacing: ef.lineSpacing });
  if (border > 0) G(item, Object.assign({ t: "rect" as const, x: x0, y: y0, w: x1 - x0, h: y1 - y0, wd: border, color: col(strokeColorOf(g) || SCH.outline), fill: null, layer, z: SCH_Z.device }, dashOf(g)));
}

/** LIB_SYMBOL::LetterSubReference( aUnit, aInitialLetter ): A..Z, then AA.. (from 'a' with the lower-case notation) */
export function letterSubReference(unit: number, initial: number): string {
  let u: number, suffix = "";
  do { u = (unit - 1) % 26; suffix = String.fromCharCode(initial + u) + suffix; unit = (unit - u) / 26 | 0; } while (unit > 0);
  return suffix;
}
/** LIB_SYMBOL::LetterSubReference( unit, 'A' ): A..Z, then AA.. */
export function unitLetter(unit: number): string { return letterSubReference(unit, 65); }
/** LIB_SYMBOL::GetUnitDisplayNames: the (unit_name …) of each "Name_U_S" sub-symbol. */
export function unitDisplayNames(lib: SNode | null | undefined): Map<number, string> {
  const names = new Map<number, string>(); if (!lib) return names;
  for (const sub of kids(lib, "symbol")) { const m = str(sub[1]).match(/_(\d+)_(\d+)$/), un = kid(sub, "unit_name"); if (m && un && +m[1] > 0) names.set(+m[1], str(un[1])); }
  return names;
}
/**
 * SCH_SYMBOL::SubReference( aUnit, aAddSeparator ): the library's unit display name when it has one, else
 * SCHEMATIC_SETTINGS::SubReference — the project's separator (subpart_id_separator) and first id (subpart_first_id:
 * 'A', 'a' or '1'), kept in schFormat.
 */
export function subReference(lib: SNode | null | undefined, unit: number, addSeparator = true): string {
  const sep = schFormat.subpartIdSeparator, first = schFormat.subpartFirstId;
  const name = unitDisplayNames(lib).get(unit);
  if (name !== undefined) return (sep !== 0 && addSeparator ? String.fromCharCode(sep) : "") + name;
  if (unit < 1) return "";
  let out = sep !== 0 && addSeparator ? String.fromCharCode(sep) : "";
  if (first >= 48 && first <= 57) out += String(unit); else out += letterSubReference(unit, first);
  return out;
}
/**
 * The symbol's instance on a sheet path (SCH_SYMBOL::refFor / GetUnitSelection): the (instances … (path "…")) entry
 * whose path is exactly `path`.  null when the path is not known or the symbol has no entry for it — the Reference
 * field and the symbol's own (unit) then stand, as in KiCad.
 */
export function symbolInstance(n: SNode, path: string | null | undefined): { ref: string; unit: number | null } | null {
  if (!path) return null;
  const inst = kid(n, "instances"); if (!inst) return null;
  for (const pr of kids(inst, "project")) for (const e of kids(pr, "path")) {
    if (str(e[1]) !== path) continue;
    const r = kid(e, "reference"), u = kid(e, "unit");
    return { ref: r ? str(r[1]) : "", unit: u ? num(u[1], 1) : null };
  }
  return null;
}

export const PIN_TEXT_OFFSET = Math.round(24 * 0.15) * MIL, PIN_TEXT_MARGIN = 4 * MIL, TARGET_PIN_RADIUS = 15 * MIL;

export const pinHidden = (g: SNode): boolean => has(g, "hide") || !!(kid(g, "hide") && str(kid(g, "hide")![1]) === "yes");

export function buildSymbolGeom(doc: Doc, item: Item): void {
  const n = item.node;
  const libId = str((kid(n, "lib_name") || kid(n, "lib_id") || [])[1]);
  const [ax, ay, rot] = atOf(n);
  const mirrorN = kid(n, "mirror"); const mirror = mirrorN ? str(mirrorN[1]) : "";
  // SCH_SHEET_PATH::UpdateAllScreenReferences: the reference and the unit shown are the displayed sheet path's instance
  const inst = symbolInstance(n, doc.instancePath);
  const unit = inst && inst.unit !== null ? inst.unit : kid(n, "unit") ? num(kid(n, "unit")![1], 1) : 1;
  const styleN = kid(n, "body_style") || kid(n, "convert"); const style = styleN ? num(styleN[1], 1) : 1;
  const dnp = yesNo(n, "dnp"); const noSim = yesNo(n, "exclude_from_sim");
  const T = symbolTransform(rot, mirror); const Ti = internalT(T);
  const tf = (lx: number, ly: number): Pt => [ax + T[0] * lx + T[1] * ly, ay + T[2] * lx + T[3] * ly];
  item.movable = true; item.x = ax; item.y = ay; item.rot = rot; item.lib = str((kid(n, "lib_id") || [])[1]) || libId; item.unit = unit;
  const lib = resolveLib(doc, libId) || (libId !== str((kid(n, "lib_id") || [])[1]) ? resolveLib(doc, str((kid(n, "lib_id") || [])[1])) : null);
  const col = dnp ? (c: string) => dimColor(c, SCH.bg) : (c: string) => c;
  // excluded from simulation: only the marker below (SCH_PAINTER keeps the symbol's own colours)
  const alpha: number | undefined = undefined;
  const bodyLayer = "Symbols";
  let bodyBox: Box | null = null, pinBox: Box | null = null, unitCount = 1;
  if (lib) for (const sub of kids(lib, "symbol")) { const m = str(sub[1]).match(/_(\d+)_(\d+)$/); if (m && +m[1] > unitCount) unitCount = +m[1]; }
  const fieldsOf = kids(n, "property");
  // GetRef( path ): the instance's reference, else the Reference field
  const refProp = fieldsOf.find((q) => str(q[1]) === "Reference"), baseRef = inst && inst.ref ? inst.ref : refProp ? str(refProp[2]) : "";
  // GetRef( path, true ): a multi-unit symbol's reference carries its unit (U2 → U2A)
  const fullRef = unitCount > 1 ? baseRef + subReference(lib, unit) : baseRef;
  /** SCH_SYMBOL::ResolveTextVar. */
  const resolveTok = (tok: string, depth: number): string | { ref: string } | null => {
    if (opVars.resolve && tok.startsWith("OP")) { const r = opVars.resolve("symbol", item, tok); if (r !== null) return r; }
    const low = tok.toLowerCase();
    for (const q of fieldsOf) {
      const qn = str(q[1]);
      // "If the field data is just a reference to the field, don't resolve": the token is left as its own name
      if (str(q[2]).replace(/ /g, "").toLowerCase() === "${" + qn.toLowerCase() + "}") return tok;
      if (qn.toLowerCase() !== low) continue;
      if (qn === "Reference") return fullRef;
      const t = str(q[2]);
      return hasTextVars(t) && depth < 10 ? expandTextVars(t, (k) => resolveTok(k, depth + 1)) : t;
    }
    // missing simulation fields read as empty, not unresolved (exact, upper-case token names)
    if (SIM_VARS.has(tok)) return "";
    // a project field name template the symbol does not carry is empty too
    for (const tn of doc.templateFieldNames || []) if (tok === tn || tok === tn.toUpperCase()) return "";
    const fpText = (): string => { const f = fieldsOf.find((q) => str(q[1]) === "Footprint"); return f ? str(f[2]) : ""; };
    const libIdFull = str((kid(n, "lib_id") || [])[1]), colon = libIdFull.indexOf(":");
    const flagOn = (key: string, on: string): boolean => { const k = kid(n, key); return !!k && str(k[1]) === on; };
    switch (tok) {
      case "FOOTPRINT_LIBRARY": { const parts = fpText().split(":"); return fpText() ? parts[0] : ""; }
      case "FOOTPRINT_NAME": { const parts = fpText().split(":"); return parts.length > 1 ? parts[1] : ""; }
      case "UNIT": return subReference(lib, unit);
      case "SHORT_REFERENCE": return baseRef;
      case "SYMBOL_LIBRARY": return colon >= 0 ? libIdFull.slice(0, colon) : "";
      case "SYMBOL_NAME": return colon >= 0 ? libIdFull.slice(colon + 1) : libIdFull;
      case "SYMBOL_DESCRIPTION": { const d = fieldsOf.find((q) => str(q[1]) === "Description") || (lib ? kids(lib, "property").find((q) => str(q[1]) === "Description" || str(q[1]) === "ki_description") : null); return d ? str(d[2]) : ""; }
      case "SYMBOL_KEYWORDS": { const k = lib ? kids(lib, "property").find((q) => str(q[1]) === "ki_keywords") : null; return k ? str(k[2]) : ""; }
      case "SYMBOL_IS_POWER": return lib && kid(lib, "power") ? "Power Symbol" : "";
      case "SYMBOL_IS_LOCAL_POWER": { const pw = lib ? kid(lib, "power") : null; return pw && str(pw[1]) === "local" ? "Local Power Symbol" : ""; }
      case "EXCLUDE_FROM_BOM": return flagOn("in_bom", "no") ? "Excluded from BOM" : "";
      case "EXCLUDE_FROM_BOARD": return flagOn("on_board", "no") ? "Excluded from board" : "";
      case "EXCLUDE_FROM_SIM": return noSim ? "Excluded from simulation" : "";
      case "DNP": return dnp ? "DNP" : "";
      default: break;
    }
    const fn = /^(SHORT_NET_NAME|NET_NAME|NET_CLASS|PIN_NAME|PIN_BASE_NAME|PIN_ALT_LIST|REFERENCE|SHORT_REFERENCE|UNIT)\(/.exec(tok);
    if (fn) {
      const pinNumber = tok.slice(tok.indexOf("(") + 1, Math.max(tok.indexOf("(") + 1, tok.lastIndexOf(")")));
      // the library pins by number: [the pin, its unit (0: common to all units)], the shown unit and body style first
      const all: { g: SNode; u: number; here: boolean }[] = [];
      if (lib) for (const sub of kids(lib, "symbol")) {
        const m = str(sub[1]).match(/_(\d+)_(\d+)$/); const u = m ? +m[1] : 0, st = m ? +m[2] : 1;
        for (const g of kids(sub, "pin")) all.push({ g, u, here: (u === 0 || u === unit) && (st === 0 || st === style) });
      }
      const numOf = (g: SNode): string => { const nn = kid(g, "number"); return nn ? str(nn[1]) : ""; };
      const nameOf = (g: SNode): string => { const nm = kid(g, "name"); return nm ? str(nm[1]) : ""; };
      const altOf = (): string => { for (const ip of kids(n, "pin")) if (str(ip[1]) === pinNumber) { const a = kid(ip, "alternate"); return a ? str(a[1]) : ""; } return ""; };
      const altList = (g: SNode): string => kids(g, "alternate").map((a) => str(a[1])).sort().join(", ");
      const kind = fn[1];
      if (kind === "REFERENCE" || kind === "SHORT_REFERENCE" || kind === "UNIT") {
        const hit = all.find((x) => numOf(x.g) === pinNumber);
        if (hit) {
          if (kind === "REFERENCE") return hit.u !== 0 ? baseRef + subReference(lib, hit.u, false) : baseRef;
          if (kind === "SHORT_REFERENCE") return baseRef;
          return hit.u !== 0 ? subReference(lib, hit.u, false) : "";
        }
        return `<Unresolved: pin ${pinNumber}>`;
      }
      const net = (u: number | null): string => { const r = symVars.net ? symVars.net(item, pinNumber, kind as "NET_NAME" | "SHORT_NET_NAME" | "NET_CLASS", u) : null; return r === null ? "" : r; };
      const here = all.find((x) => x.here && numOf(x.g) === pinNumber);
      if (here) {
        if (kind === "PIN_NAME") return altOf() || nameOf(here.g);
        if (kind === "PIN_BASE_NAME") return nameOf(here.g);
        if (kind === "PIN_ALT_LIST") return altList(here.g);
        return net(null);
      }
      const other = all.find((x) => numOf(x.g) === pinNumber);
      if (other) {
        if (kind === "PIN_BASE_NAME") return nameOf(other.g);
        if (kind === "PIN_ALT_LIST") return altList(other.g);
        // the unit holding the pin, wherever it is placed: the host knows the hierarchy
        const placed = symVars.unitPlaced ? symVars.unitPlaced(item, baseRef, other.u) : null;
        if (placed === false) return `<Unit ${subReference(lib, other.u, false)} not placed>`;
        if (kind === "PIN_NAME") return (placed && placed.alt) || nameOf(other.g);
        return net(other.u);
      }
      return `<Unresolved: pin ${pinNumber}>`;
    }
    // the sheet's own variables, the title block and the project (SCH_SHEET::ResolveTextVar and its parents)
    try { const v = varResolver(sheetTextVars(doc), { project: (doc && doc.projectVars) || null })(tok); return v === undefined ? null : v; } catch (e) { return null; }
  };
  /** expandLibItemTextVars: a body text, text box or pin name of the library symbol, resolved against this symbol. */
  const symText = (t: string): string => (hasTextVars(t) ? expandTextVars(t, (tok) => resolveTok(tok, 0)) : t);
  const take = (g0: string) => { const b = item.bbox; if (!b) return; if (g0 === "pin") pinBox = boxUnion(pinBox, b[0], b[1], b[2], b[3]); else bodyBox = boxUnion(bodyBox, b[0], b[1], b[2], b[3]); };
  if (lib) {
    const pn = kid(lib, "pin_names"); const nameOff = pn && kid(pn, "offset") ? num(kid(pn, "offset")![1]) : 0.508;
    const hideNames = !!(pn && (has(pn, "hide") || (kid(pn, "hide") && str(kid(pn, "hide")![1]) === "yes")));
    const pnu = kid(lib, "pin_numbers"); const hideNums = !!(pnu && (has(pnu, "hide") || (kid(pnu, "hide") && str(kid(pnu, "hide")![1]) === "yes")));
    const subs = kids(lib, "symbol");
    // SCH_PAINTER::draw( SCH_SYMBOL ): the drawn pin takes the schematic pin's shown name, type and shape, which are the
    // chosen alternate's (SCH_PIN::GetShownName / GetType / GetShape), and its name's variables are expanded
    const altOf = new Map<string, string>();
    for (const ip of kids(n, "pin")) { const a = kid(ip, "alternate"); if (a && str(a[1])) altOf.set(str(ip[1]), str(a[1])); }
    const shownPin = (g: SNode): SNode => {
      let out = g; const numN = kid(g, "number"), alt = numN ? altOf.get(str(numN[1])) : undefined;
      const an = alt ? kids(g, "alternate").find((a) => str(a[1]) === alt) : undefined;
      if (an) {
        out = g.slice() as SNode; out[1] = an[2]; out[2] = an[3];
        const nm = kid(g, "name"); if (nm) out[out.indexOf(nm)] = [nm[0], str(an[1]), ...nm.slice(2)] as SNode; else out.push(["name", str(an[1])] as SNode);
      }
      const nn = kid(out, "name");
      if (nn && hasTextVars(str(nn[1]))) { if (out === g) out = g.slice() as SNode; out[out.indexOf(nn)] = [nn[0], symText(str(nn[1])), ...nn.slice(2)] as SNode; }
      return out;
    };
    // SCH_PIN::GetEffectivePadNumber (no footprint pads on the canvas): the pad a pin-to-pad map sends the pin to: the
    // instance's named map, else the map of the associated footprint that is the symbol's Footprint field, patched by
    // the instance's own edits unless the override forces the identity
    let padOf: ((pin: string) => string) | null = null;
    const ovr = kid(n, "pin_map_override"), pmaps = kid(lib, "pin_maps");
    if (ovr || pmaps) {
      const modeN = ovr && kid(ovr, "mode"), mode = modeN ? str(modeN[1]) : "library_default", mapN = ovr && kid(ovr, "map");
      const edits = new Map<string, string>(); if (ovr) for (const e of kids(ovr, "edit")) edits.set(str(e[1]), str(e[2]));
      const maps = pmaps ? kids(pmaps, "pin_map") : [];
      let map: SNode | undefined = mode === "named_map" && mapN ? maps.find((m) => str(m[1]) === str(mapN[1])) : undefined;
      if (!map && mode !== "identity") {
        const fpN = kids(n, "property").find((q) => str(q[1]) === "Footprint"), fp = fpN ? str(fpN[2]) : "", af = kid(lib, "associated_footprints");
        const a = af ? kids(af, "footprint").find((f) => str(f[1]) === fp) : undefined, am = a && kid(a, "map");
        if (am) map = maps.find((m) => str(m[1]) === str(am[1]));
      }
      const entries = new Map<string, string>(); if (map) for (const en of kids(map, "entry")) entries.set(str(en[1]), str(en[2]));
      if (entries.size || (mode !== "identity" && edits.size)) padOf = (pin) => (mode !== "identity" && edits.has(pin) ? edits.get(pin)! : entries.has(pin) ? entries.get(pin)! : pin);
    }
    /** The number a pin shows: its effective pad, and the original number kept beside it under show_remapped_pin_numbers. */
    const shownNumber = (g: SNode): PinShown | undefined => {
      const numN = kid(g, "number"), orig = numN ? str(numN[1]) : ""; if (!padOf || !orig) return undefined;
      const eff = padOf(orig); return eff === orig ? undefined : { number: eff, remappedFrom: schDisplay.remappedPinNumbers ? orig : undefined };
    };
    // tallest visible pin name of the whole symbol positions names above horizontal pins
    let maxNameHalf = 0;
    for (const sub of subs) for (const p0 of kids(sub, "pin")) { const p = shownPin(p0), nm = kid(p, "name"); if (nm && str(nm[1]) && (str(nm[1]) !== "~" || (doc.version || 0) >= TILDE_LITERAL_VERSION)) maxNameHalf = Math.max(maxNameHalf, effectsOf(nm).size / 2); }
    // show_pin_alt_icons (EESCHEMA_SETTINGS, on by default): pins with alternates draw drawAltPinModesIcon
    const sym: PinSym = { nameOff, hideNames, hideNums, maxNameHalf, col, alpha, literalTilde: (doc.version || 0) >= TILDE_LITERAL_VERSION, altIcons: schDisplay.pinAltIcons };
    const geomStart = item.geom.length;
    for (const sub of subs) {
      const m = str(sub[1]).match(/_(\d+)_(\d+)$/); const u = m ? +m[1] : 0, s = m ? +m[2] : 1;
      if ((u !== 0 && u !== unit) || (s !== 0 && s !== style)) continue;   // unit 0 / body style 0 = common to all (LIB_SYMBOL)
      for (let j = 2; j < sub.length; j++) {
        const g = sub[j]; if (!isList(g)) continue;
        const gk = g[0];
        if (yesNo(g, "private")) continue;
        const before = item.bbox ? item.bbox.slice() : null; item.bbox = null;
        if (gk === "rectangle" || gk === "polyline" || gk === "bezier" || gk === "circle" || gk === "arc" || gk === "ellipse" || gk === "ellipse_arc") {
          // a DNP symbol's shapes dimmed whole (getRenderColor aDimmed): their own stroke colours and the body fill too
          const g0 = item.geom.length;
          // SCH_SHAPE::ViewGetLayers: a body-colour fill is on LAYER_DEVICE_BACKGROUND, any other on LAYER_SHAPES_BACKGROUND
          shapeGeom(item, g, gk, tf, SCH.outline, bodyLayer, SCH_Z.device, fillOf(g).type === "background" ? SCH_Z.deviceBg : SCH_Z.shapesBg, widthOf(g, 0) || SCH_PEN, undefined, true);
          if (dnp) for (let i = g0; i < item.geom.length; i++) { const x = item.geom[i] as { color?: string | null; fill?: string | null }; if (x.color) x.color = col(x.color); if (x.fill) x.fill = col(x.fill); }
          take("body");
        } else if (gk === "text") {
          const [tx, ty, tr] = atOf(g); const ef = effectsOf(g);
          // SCH_PAINTER::draw( SCH_TEXT ) on LAYER_DEVICE: placed on its box like a field, each line keeping its H justification;
          // a hidden one is drawn in LAYER_HIDDEN under show_hidden_fields
          const sink: GeomSink = ef.hide ? { geom: [], bbox: null } : item;
          const [px, py] = tf(tx, ty); transformedText(sink, Ti, px, py, symText(str(g[1])), ef.size, ef.hide ? ef.color || SCH.hidden : col(ef.color || SCH.outline), tr / 10, ef.just, bodyLayer, { z: SCH_Z.device, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX, lineSpacing: ef.lineSpacing, alpha, olKind: "field", olKeepH: true });
          if (ef.hide) { for (const hg of sink.geom) { hg.hiddenText = true; hg.noBox = true; } if (sink.geom.length) (item.hiddenGeom = item.hiddenGeom || []).push(...sink.geom); }
          else take("body");
        } else if (gk === "text_box") {
          const ef = effectsOf(g); const sink: GeomSink = ef.hide ? { geom: [], bbox: null } : item;
          symbolTextBox(sink, g, tf, rot, mirror, symText(str(g[1])), ef, ef.hide ? () => SCH.hidden : col, bodyLayer);
          if (ef.hide) { for (const hg of sink.geom) { hg.hiddenText = true; hg.noBox = true; } if (sink.geom.length) (item.hiddenGeom = item.hiddenGeom || []).push(...sink.geom); }
          else take("body");
        } else if (gk === "pin") {
          if (pinHidden(g)) {
            // kept aside, untouched bbox: drawn only under the showHiddenPins render option, in KiCad's hidden-item colour
            const shadow: GeomSink = { geom: [], bbox: null };
            buildPinGeom(shadow, shownPin(g), tf, Object.assign({}, sym, { col: () => SCH.hidden, showHidden: true }), shownNumber(g));
            if (shadow.geom.length) (item.hiddenGeom = item.hiddenGeom || []).push(...shadow.geom);
          } else { buildPinGeom(item, shownPin(g), tf, sym, shownNumber(g)); take("pin"); }
        }
        if (before) item.bbox = item.bbox ? boxUnion(item.bbox, before[0], before[1], before[2], before[3]) : before;
      }
    }
    if (alpha !== undefined) for (let i = geomStart; i < item.geom.length; i++) if (item.geom[i].alpha === undefined) item.geom[i].alpha = alpha;
    if (alpha !== undefined && item.hiddenGeom) for (const hg of item.hiddenGeom) if (hg.alpha === undefined) hg.alpha = alpha;
  } else {
    // LIB_SYMBOL::GetDummy: a rectangle from (-200, 200) to (200, -200) mils and the text "??" at the origin, 150 mils high
    G(item, { t: "rect", x: ax - 5.08, y: ay - 5.08, w: 10.16, h: 10.16, wd: SCH_PEN, color: col(SCH.outline), fill: null, layer: bodyLayer, z: SCH_Z.device });
    transformedText(item, Ti, ax, ay, "??", 3.81, col(SCH.outline), 0, [], bodyLayer, { z: SCH_Z.device, w: SCH_PEN, sizeX: 3.81, olKind: "field", olKeepH: true });
    bodyBox = item.bbox!.slice();   // G just grew it
  }
  if (!bodyBox) bodyBox = [ax, ay, ax, ay]; if (!pinBox) pinBox = bodyBox.slice();
  let localPower = false;
  if (lib) { const pw = kid(lib, "power"); if (pw && str(pw[1]) === "local") { const pins: SNode[] = []; for (const sub of kids(lib, "symbol")) pins.push(...kids(sub, "pin")); localPower = pins.length === 1 && str(pins[0][1]) === "power_in"; } }
  const union = boxUnion(bodyBox, pinBox[0], pinBox[1], pinBox[2], pinBox[3]);
  for (const p of fieldsOf) {
    const name = str(p[1]); const ef = effectsOf(p);
    // SCH_FIELD::getUnescapedText: the Reference field is the instance's reference on the displayed sheet path
    const val = name === "Reference" ? baseRef : str(p[2]);
    if (name === "Reference") item.ref = val; if (name === "Value") item.value = val;
    if (!val || name.startsWith("ki_")) continue;
    const [px, py, pr] = atOf(p);
    const isRef = name === "Reference", isVal = name === "Value";
    // a hidden field is kept aside in LAYER_HIDDEN, drawn under show_hidden_fields (outside the hit boxes)
    const sink: GeomSink = ef.hide ? { geom: [], bbox: null } : item;
    const color = col(fieldColor(ef, ef.hide ? SCH.hidden : isRef ? SCH.ref : isVal ? SCH.value : SCH.field));   // LAYER_REFERENCEPART / LAYER_VALUEPART / LAYER_FIELDS
    // SCH_FIELD::GetShownText: the reference of a multi-unit symbol carries its unit (U2 → U2A)
    let shown = isRef ? fullRef : val;
    // IsNameShown(): "Name: text" on the canvas
    if (nameShown(p)) shown = name + ": " + shown;
    // SCH_SYMBOL::ResolveTextVar: the symbol's fields by name, its own variables, then the sheet's
    if (hasTextVars(shown)) shown = expandTextVars(shown, (tok) => resolveTok(tok, 0));
    const tg = transformedText(sink, Ti, px, py, shown, ef.size, color, pr, ef.just, isRef || isVal ? "Reference & value" : "Fields", { z: isRef ? SCH_Z.ref : isVal ? SCH_Z.value : SCH_Z.fields, w: textPen(ef, ef.size), italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX, lineSpacing: ef.lineSpacing, alpha, field: name, olKind: "field" });
    // a local power symbol (IsSymbolLikePowerLocalLabel) marks its Value with drawLocalPowerIcon
    if (isVal && localPower) localPowerIcon(sink, tg, shown, textPen(ef, ef.size), color, name);
    if (ef.hide) { const sc = col(fieldColor(ef, isRef ? SCH.ref : isVal ? SCH.value : SCH.field)); for (const hg of sink.geom) { hg.hiddenText = true; hg.noBox = true; if (hg.color) hg.shownColor = sc; } if (sink.geom.length) (item.hiddenGeom = item.hiddenGeom || []).push(...sink.geom); }
  }
  if (dnp && schFormat.showDnpMarkers) {   // m_ShowDNPMarkers
    // SCH_PAINTER: body box grown toward the pins, crossed at 3× the default line width
    const mx0 = Math.max(bodyBox[0] - union[0], union[2] - bodyBox[2]), my0 = Math.max(bodyBox[1] - union[1], union[3] - bodyBox[3]);
    const mx = Math.max(mx0 * 0.6, my0 * 0.3), my = Math.max(my0 * 0.6, mx0 * 0.3);
    const b = [bodyBox[0] - mx, bodyBox[1] - my, bodyBox[2] + mx, bodyBox[3] + my];
    G(item, { t: "line", x1: b[0], y1: b[1], x2: b[2], y2: b[3], w: 3 * 6 * MIL, color: SCH.dnp, layer: "Symbols", z: SCH_Z.marker, cap: "round" });
    G(item, { t: "line", x1: b[0], y1: b[3], x2: b[2], y2: b[1], w: 3 * 6 * MIL, color: SCH.dnp, layer: "Symbols", z: SCH_Z.marker, cap: "round" });
  }
  if (noSim) {
    // exclude-from-simulation marker: grey frame plus the wave badge at the bottom-right corner
    const sw = 25 * MIL; const b = [bodyBox[0] - sw / 2, bodyBox[1] - sw / 2, bodyBox[2] + sw / 2, bodyBox[3] + sw / 2];
    simMarker(item, b, sw, 1);
  }
  if (!item.bbox) bboxAdd(item, ax, ay, 2.54);
}

/**
 * The schematic View-menu options that change geometry (EESCHEMA_SETTINGS appearance): the pin alternate icons.  The
 * host sets them and rebuilds the sheet's symbols (KiCadCanvas.setSchDisplay).
 */
/**
 * Schematic Setup > Formatting values the painter reads (SCHEMATIC_SETTINGS, the project's schematic.drawing):
 * text_offset_ratio (0.15), label_size_ratio (0.375), pin_symbol_size (25 mil; 0 = from the pin's text sizes),
 * show_dnp_markers.  default_line_thickness is text.ts's SCH_PEN.  setSchFormatting (index.ts) rebuilds the sheet.
 */
export const schFormat = { textOffsetRatio: 0.15, labelSizeRatio: 0.375, pinSymbolSize: 25 * MIL, showDnpMarkers: true, overbarHeight: 1.23, hopOverChoice: 0, overrideItemColors: false,
  /** SCHEMATIC_SETTINGS::m_SubpartIdSeparator (0: none) and m_SubpartFirstId ('A') — the unit notation of SubReference */
  subpartIdSeparator: 0, subpartFirstId: 65 };
export const schDisplay = { pinAltIcons: true, /** appearance.show_remapped_pin_numbers (on by default) */ remappedPinNumbers: true };
/**
 * SCH_PAINTER's excluded-from-simulation marker (mark_sim_exclusions): the body box framed at
 * m_ExcludeFromSimulationLineWidth (25 mils) and the wave badge at its bottom-right corner, in
 * LAYER_EXCLUDED_FROM_SIM (a sheet's at alpha 0.5).  Tagged simMarker: render() leaves it out when the option is off.
 */
export function simMarker(item: GeomSink, b: number[], sw: number, alpha: number): void {
  const [r, g, bl] = parseColor(SCH.excluded); const col = (a: number) => `rgba(${r},${g},${bl},${a})`;
  const c = alpha < 1 ? col(alpha) : SCH.excluded, layer = "Symbols", z = SCH_Z.marker;
  G(item, { t: "poly", pts: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], close: true, w: sw, color: c, layer, z, simMarker: true });
  const off = 2 * sw; const cx = b[2] + off + sw, cy = b[3] - off;
  G(item, { t: "circle", x: cx, y: cy, r: off, w: sw, color: c, fill: col(0.1), layer, z, simMarker: true });
  G(item, { t: "poly", pts: bezierPts([[cx - off, cy], [cx, cy + off], [cx, cy - off], [cx + off, cy]], 12), close: false, w: sw, color: c, layer, z, simMarker: true });
}
/**
 * SCH_PAINTER::drawLocalPowerIcon beside a local power symbol's Value: SCH_SYMBOL::BuildLocalPowerIconShape (three
 * beziers and a filled dot, line width size / 10) at bbox.left - h/2, bottom - h/6, size h / 1.5 (the vertical text's
 * variant rotated 90 degrees), in the field colour.  `tg` is the field's text record.
 */
export function localPowerIcon(item: GeomSink, tg: { x: number; y: number; rot: number; h: string; v: string; size: number; sizeX?: number }, text: string, pen: number, color: string, field: string): void {
  const w = textWidth(parseMarkup(text).text, tg.sizeX || tg.size, pen), hgt = tg.size + pen, rotated = ((Math.round(tg.rot) % 180) + 180) % 180 === 90;
  // the field's box in sheet coordinates
  const along0 = tg.h === "left" ? 0 : tg.h === "right" ? -w : -w / 2, across0 = tg.v === "top" ? 0 : tg.v === "bottom" ? -hgt : -hgt / 2;
  let bx0: number, by0: number, bw: number, bh: number;
  if (!rotated) { bx0 = tg.x + along0; by0 = tg.y + across0; bw = w; bh = hgt; }
  else { bx0 = tg.x + across0; by0 = tg.y - along0 - w; bw = hgt; bh = w; }
  const size = rotated ? bw / 1.5 : bh / 1.5;
  const pos: Pt = rotated ? [bx0 + bw - bw / 6, by0 + bh + bw / 2] : [bx0 - bh / 2, by0 + bh - bh / 6];
  const xr = size / 1.6180339887, xm = xr / 2;
  const P = (x: number, y: number): Pt => rotated ? [pos[0] + y, pos[1] - x] : [pos[0] + x, pos[1] + y];   // RotatePoint 90 CCW, then Move
  const bottom: Pt = [xm, 0], left: Pt = [0, -2 * size / 3], right: Pt = [xr, -2 * size / 3];
  const bA: Pt = [xm, -size / 4], l1: Pt = [0, -size / 2.5], l2: Pt = [0, -size * 1.15], r1: Pt = [xr, -size / 2.5], r2: Pt = [xr, -size * 1.15];
  const lw = size / 10, layer = "Reference & value", z = SCH_Z.value;
  for (const c of [[bottom, bA, l1, left], [left, l2, r2, right], [right, r1, bA, bottom]])
    G(item, { t: "poly", pts: bezierPts(c.map((p) => P(p[0], p[1])), 12), close: false, w: lw, color, layer, z, field, cap: "round" });
  const cc = P((left[0] + right[0]) / 2, (left[1] + right[1]) / 2);
  G(item, { t: "circle", x: cc[0], y: cc[1], r: size / 15, w: lw, color, fill: color, layer, z, field });
}

/** One library pin mapped to the sheet: line, shape decoration, name and number (PIN_LAYOUT_CACHE rules). */
/** drawAltPinModesIcon (sch_painter.cpp), base function selected: two arrows, the lower one leaving an S-bend. */
function altPinModesIcon(item: GeomSink, x: number, y: number, size: number, rotate: boolean, color: string): void {
  const w = size / 10, lyo = size / 4, ah = size / 8, layer = "Pin names", z = SCH_Z.pinName;
  const P = (px: number, py: number): Pt => (rotate ? [x + py, y - px] : [x + px, y + py]);   // GAL Rotate( 270 deg )
  const seg = (a: Pt, b: Pt) => G(item, { t: "line", x1: a[0], y1: a[1], x2: b[0], y2: b[1], w, color, layer, z, cap: "round" });
  const tr: Pt = [size / 2, -lyo], br: Pt = [size / 2, lyo];
  seg(P(tr[0], tr[1]), P(tr[0] - size, tr[1]));
  seg(P(tr[0], tr[1]), P(tr[0] - ah * 1.2, tr[1] - ah)); seg(P(tr[0], tr[1]), P(tr[0] - ah * 1.2, tr[1] + ah));
  seg(P(br[0], br[1]), P(br[0] - size / 2, br[1]));
  seg(P(br[0], br[1]), P(br[0] - ah * 1.2, br[1] - ah)); seg(P(br[0], br[1]), P(br[0] - ah * 1.2, br[1] + ah));
  const arc: Pt[] = []; for (let i = 0; i <= 8; i++) { const t = Math.PI - (Math.PI / 2) * i / 8; arc.push(P(lyo * Math.cos(t), lyo * Math.sin(t))); }   // centre (0, 0), 180 -> 90 deg
  G(item, { t: "poly", pts: arc, close: false, w, color, layer, z });
}
/** A pin's shown number when a pin-to-pad map changes it: the effective pad, and the original number to draw after it. */
export interface PinShown { number: string; remappedFrom?: string }
export function buildPinGeom(item: GeomSink, g: SNode, tf: Tf, sym: PinSym, shown?: PinShown): void {
  const type = str(g[1]), shape = str(g[2]);
  const [px, py, pr] = atOf(g); const lenN = kid(g, "length"); const len = lenN ? num(lenN[1]) : 2.54;
  if (pinHidden(g) && !sym.showHidden) return;   // hidden (e.g. power) pins draw nothing unless asked for
  // every geometry of the pin carries its number: a net highlight brightens single pins ("symbolId#pin:<number>")
  const g0 = item.geom.length, numTag = kid(g, "number"); const tag = numTag ? str(numTag[1]) : "";
  try { buildPinGeomInner(item, g, tf, sym, type, shape, px, py, pr, len, shown); } finally { for (let i = g0; i < item.geom.length; i++) item.geom[i].pinNo = tag; }
}
/** FormatStackedPinForDisplay keeps the author's order and range notation. Only the display is split. */
function pinNumberLines(number: string, length: number, size: number): string[] {
  const items = stackedItems(number);
  if (!items) return [number];
  const parts = items.map(unescapePin);
  const inline = "[" + parts.join(",") + "]";
  return parts.length > 1 && textWidth(inline, size, size / 8) > Math.max(length, 50 * MIL) ? parts : [inline];
}

function buildPinGeomInner(item: GeomSink, g: SNode, tf: Tf, sym: PinSym, type: string, shape: string, px: number, py: number, pr: number, len: number, shown?: PinShown): void {
  const dir = ((Math.round(pr) % 360) + 360) % 360;
  const d = dir === 0 ? [1, 0] : dir === 90 ? [0, 1] : dir === 180 ? [-1, 0] : [0, -1];   // file angle points into the body
  const pos = tf(px, py), rootPt = tf(px + d[0] * len, py + d[1] * len);
  const tip = tf(px + d[0], py + d[1]); let ox = pos[0] - tip[0], oy = pos[1] - tip[1];   // outward: body → connection point
  const ol = Math.hypot(ox, oy) || 1; ox = Math.round(ox / ol); oy = Math.round(oy / ol);
  // KiCad's PIN_RIGHT/LEFT/UP/DOWN name the direction from the connection point into the body
  const orient = ox < 0 ? "R" : ox > 0 ? "L" : oy > 0 ? "U" : "D"; const vertical = orient === "U" || orient === "D";
  const color = sym.col(SCH.pin); const w = SCH_PEN; const z = SCH_Z.pin, layer = "Pins";
  const nameN = kid(g, "name"), numN = kid(g, "number");
  const nameEf: Pick<TextEffects, "size" | "hide"> = nameN ? effectsOf(nameN) : { size: 1.27, hide: false }, numEf: Pick<TextEffects, "size" | "hide"> = numN ? effectsOf(numN) : { size: 1.27, hide: false };
  const ps = schFormat.pinSymbolSize;   // SCH_PAINTER::externalPinDecoSize / internalPinDecoSize: m_PinSymbolSize when set
  const radius = ps > 0 ? ps : numEf.size / 2, diam = radius * 2, clock = ps > 0 ? ps : (nameEf.size || numEf.size) / 2;
  const p0 = rootPt; const line = (a: Pt, b: Pt) => G(item, { t: "line", x1: a[0], y1: a[1], x2: b[0], y2: b[1], w, color, layer, z, cap: "round" });
  const tri = (a: Pt, b: Pt, c: Pt) => G(item, { t: "poly", pts: [a, b, c], close: false, w, color, layer, z });
  const P = (dx: number, dy: number): Pt => [p0[0] + dx, p0[1] + dy];
  if (len > 0 || shape !== "line" || type === "no_connect") {   // a PT_NC pin always draws its line and X
    if (type === "no_connect") {
      line(p0, pos); const r = TARGET_PIN_RADIUS;
      line([pos[0] - r, pos[1] - r], [pos[0] + r, pos[1] + r]); line([pos[0] + r, pos[1] - r], [pos[0] - r, pos[1] + r]);
    } else if (shape === "inverted") {
      G(item, { t: "circle", x: p0[0] + ox * radius, y: p0[1] + oy * radius, r: radius, w, color, layer, z });
      line(P(ox * diam, oy * diam), pos);
    } else if (shape === "inverted_clock") {
      tri(P(oy * clock, -ox * clock), P(-ox * clock, -oy * clock), P(-oy * clock, ox * clock));
      G(item, { t: "circle", x: p0[0] + ox * radius, y: p0[1] + oy * radius, r: radius, w, color, layer, z });
      line(P(ox * diam, oy * diam), pos);
    } else if (shape === "clock_low" || shape === "edge_clock_high") {
      tri(P(oy * clock, -ox * clock), P(-ox * clock, -oy * clock), P(-oy * clock, ox * clock));
      if (!oy) tri(P(ox * diam, 0), P(ox * diam, -diam), p0); else tri(P(0, oy * diam), P(-diam, oy * diam), p0);
      if (len > 0) line(p0, pos);
    } else if (shape === "clock") {
      if (len > 0) line(p0, pos);
      if (!oy) tri(P(0, clock), P(-ox * clock, 0), P(0, -clock)); else tri(P(clock, 0), P(0, -oy * clock), P(-clock, 0));
    } else if (shape === "input_low") {
      if (len > 0) line(p0, pos);
      if (!oy) tri(P(ox * diam, 0), P(ox * diam, -diam), p0); else tri(P(0, oy * diam), P(-diam, oy * diam), p0);
    } else if (shape === "output_low") {
      if (len > 0) line(p0, pos);
      if (!oy) line(P(0, -diam), P(ox * diam, 0)); else line(P(-diam, 0), P(0, oy * diam));
    } else if (shape === "non_logic") {
      if (len > 0) line(p0, pos);
      line(P(-(ox + oy) * radius, -(oy - ox) * radius), P((ox + oy) * radius, (oy - ox) * radius));
      line(P(-(ox - oy) * radius, -(ox + oy) * radius), P((ox - oy) * radius, (ox + oy) * radius));
    } else if (len > 0) line(p0, pos);
  }
  bboxAdd(item, pos[0], pos[1]); bboxAdd(item, p0[0], p0[1]);
  // --- text ---
  const pinName = nameN ? str(nameN[1]) : "", pinNum = shown ? shown.number : numN ? str(numN[1]) : "";
  const named = !!pinName && (pinName !== "~" || !!sym.literalTilde);   // SCH_IO_KICAD_SEXPR_PARSER: "~" is empty only before 20250318
  const showName = named && !sym.hideNames && !nameEf.hide;
  const showNum = !!pinNum && !sym.hideNums && !numEf.hide;
  const nameThick = Math.min(SCH_PEN, 0.18 * nameEf.size), numThick = Math.min(SCH_PEN, 0.18 * numEf.size);
  const clearance = PIN_TEXT_OFFSET + PIN_TEXT_MARGIN; const halfLen = len / 2;
  const inside = sym.nameOff > 0;
  const both = named && !sym.hideNames && !inside;   // name drawn outside → number moves to the other side
  const alongX = orient === "L" ? pos[0] - halfLen : pos[0] + halfLen, alongY = orient === "D" ? pos[1] + halfLen : pos[1] - halfLen;
  const nameColor = sym.col(SCH.pinName), numColor = sym.col(SCH.pinNum);
  if (showNum) {
    const size = numEf.size, lines = pinNumberLines(pinNum, len, size), stacked = lines.length > 1;
    const pitch = 1.3 * size, height = stacked ? lines.length * pitch : size;
    // Long number blocks follow the symbol transform so a flip keeps them in the space the author reserved.
    const side = d[0] ? tf(px, py + 1) : tf(px - 1, py);
    const positive = both || (stacked && (vertical ? side[0] > pos[0] : side[1] > pos[1]));
    const perp = (positive ? 1 : -1) * (clearance + height / 2 + numThick);
    const center = (vertical ? pos[0] : pos[1]) + perp;
    const halfSpan = (lines.length - 1) * pitch / 2;
    const point = (across: number, row: number): Pt => vertical ? [center + row, alongY + across] : [alongX + across, center + row];
    // SCH_PAINTER::draw( SCH_PIN ): a remapped pin shows "/" + its original number after the pad, 4/5 of the number's
    // size and half its alpha, left aligned at the number box's right edge (its top for a vertical number, which
    // reads bottom to top); the pair is shifted back by the label's length when it would run into the symbol body;
    // a stacked block's box is the whole block (PIN_LAYOUT_CACHE::GetPinNumberBBox), its
    // braces drawn about the shifted text like the lines themselves
    const from = shown && shown.remappedFrom ? "/" + shown.remappedFrom : "";
    const fromSize = Math.max(1e-4, size * 4 / 5), fromLen = from ? textWidth(from, fromSize, numThick) : 0;
    const shift = from && (vertical ? oy > 0 : ox < 0) ? fromLen : 0;
    for (const [i, label] of lines.entries()) {
      const [x, y] = point(vertical ? shift : -shift, i * pitch - halfSpan);
      textGeom(item, x, y, label, size, numColor, vertical ? 90 : 0, ["center", "middle"], "Pin numbers", { z: SCH_Z.pinNum, w: numThick });
    }
    if (from) {
      const half = lines.reduce((max, l) => Math.max(max, textWidth(l, size, numThick)), 0) / 2, [x0, y0] = point(0, 0);
      const tg = vertical ? textGeom(item, x0, y0 - half + shift, from, fromSize, numColor, 90, ["left", "middle"], "Pin numbers", { z: SCH_Z.pinNum, w: numThick })
        : textGeom(item, x0 + half - shift, y0, from, fromSize, numColor, 0, ["left", "middle"], "Pin numbers", { z: SCH_Z.pinNum, w: numThick });
      tg.alpha = (tg.alpha === undefined ? 1 : tg.alpha) * 0.5;
    }
    if (stacked) {
      const brace = size / 3, top = -halfSpan - 2 * brace, bottom = halfSpan;
      const gap = lines.reduce((max, s) => Math.max(max, textWidth(s, size, numThick)), 0) / 2 + brace;
      const sh = vertical ? shift : -shift;
      for (const sign of [-1, 1]) {
        const edge = sign * gap + sh, tip = sign * brace;
        const pts = [point(edge, top), point(edge + tip / 2, top), point(edge + tip, (top + bottom) / 2),
          point(edge + tip / 2, bottom), point(edge, bottom)];
        G(item, { t: "poly", pts, close: false, w: numThick, color: numColor, layer: "Pin numbers", z: SCH_Z.pinNum });
      }
    }
  }
  if (showName && sym.altIcons && kids(g, "alternate").length) {
    // PIN_LAYOUT_CACHE::getUntransformedAltIconBox + drawAltPinModesIcon: beyond an inside name, before an outside one
    const icon = Math.min(nameEf.size, 1.5), nw = textWidth(pinName, nameEf.size, nameThick);
    const ux = -ox, uy = -oy;   // connection point → body
    const along = inside ? len + sym.nameOff + nw + icon * 0.75 : halfLen - nw / 2 - icon * 0.75;
    const perp = inside ? 0 : vertical ? clearance + nameEf.size / 2 + nameThick : sym.maxNameHalf + clearance + nameThick;
    const cx = pos[0] + ux * along - (vertical ? perp : 0), cy = pos[1] + uy * along - (vertical ? 0 : perp);
    altPinModesIcon(item, cx, cy, icon, vertical, nameColor);
  }
  if (showName) {
    if (inside) {
      const dd = len + sym.nameOff;
      const at = orient === "R" ? [pos[0] + dd, pos[1]] : orient === "L" ? [pos[0] - dd, pos[1]] : orient === "U" ? [pos[0], pos[1] - dd] : [pos[0], pos[1] + dd];
      textGeom(item, at[0], at[1], pinName, nameEf.size, nameColor, vertical ? 90 : 0, [orient === "R" || orient === "U" ? "left" : "right", "middle"], "Pin names", { z: SCH_Z.pinName, w: nameThick });
    } else if (vertical) {
      textGeom(item, pos[0] - (clearance + nameEf.size / 2 + nameThick), alongY, pinName, nameEf.size, nameColor, 90, ["center", "middle"], "Pin names", { z: SCH_Z.pinName, w: nameThick });
    } else {
      textGeom(item, alongX, pos[1] - (sym.maxNameHalf + clearance + nameThick), pinName, nameEf.size, nameColor, 0, ["center", "middle"], "Pin names", { z: SCH_Z.pinName, w: nameThick });
    }
  }
}
