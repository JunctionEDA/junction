// canvas/pcb-textvars.ts — the board's text variables: BOARD::ResolveTextVar (pcbnew/board.cpp), FOOTPRINT::ResolveTextVar
// (pcbnew/footprint.cpp), PCB_TEXT / PCB_TEXTBOX / PCB_FIELD::GetShownText (pcbnew/pcb_text.cpp, pcb_textbox.cpp,
// pcb_field.cpp).  A text resolves ${LAYER} to its own layer, then through its footprint (fields, flags, pad nets,
// ${PROPERTY.*}), then through the board (cross-references ${REF:FIELD}, the file and variant, the title block, the
// project's variables and the board's own properties).  The net class of a pad's net comes from the host (pcbVars).
import { expandTextVars, hasTextVars, sheetTextVars, varResolver, WS_TOKENS, type ExpandOpts, type VarValue } from "./sheet";
import { atOf, has, isList, kid, kids, num, str, yesNo } from "./sexpr";
import { unescapeText } from "./text";
import { footprintFlagsForVariant, footprintVariant, isDefaultVariant } from "./variant-model";
import { stringFromValue } from "../../../shared/units";
import type { Doc } from "./types";
import { drillTextVar } from "./drill-model";

/** The host's answers the board file cannot give: a net's effective net class (the project's net settings). */
export const pcbVars: { netClass: ((net: string) => string | null) | null } = { netClass: null };

const DEPTH = 10;
type Board = Doc;

/** BOARD::GetLayerName: the board's own (user) name for a layer, else its standard name. */
export function boardLayerName(doc: Board | null | undefined, layer: string): string {
  const ll = doc ? (doc as { layers?: { get?: (k: string) => { userName?: string } | undefined } }).layers : null;
  const lu = ll && typeof ll.get === "function" ? ll.get(layer) : null;
  return lu && lu.userName ? lu.userName : layer;
}
const fpRef = (fp: SNode): string => {
  const p = kids(fp, "property").find((q) => str(q[1]) === "Reference"); if (p) return str(p[2]);
  const t = kids(fp, "fp_text").find((q) => str(q[1]) === "reference"); return t ? str(t[2]) : "";
};
const uuidOf = (n: SNode): string => str((kid(n, "uuid") || kid(n, "tstamp") || [])[1]);
/** The footprint's fields as (name, node): (property …), or the fp_text reference / value of older files. */
function fpFields(fp: SNode): [string, SNode, string][] {
  const out: [string, SNode, string][] = [];
  for (const c of fp) {
    if (!isList(c)) continue;
    if (c[0] === "property") out.push([str(c[1]), c, str(c[2])]);
    else if (c[0] === "fp_text" && (str(c[1]) === "reference" || str(c[1]) === "value")) out.push([str(c[1]) === "reference" ? "Reference" : "Value", c, str(c[2])]);
  }
  return out;
}
/** The board's (property "k" "v") entries (BOARD::m_properties). */
function boardProperties(doc: Board): Record<string, string> {
  const own = (doc as { boardProperties?: Record<string, string> }).boardProperties;
  const out: Record<string, string> = Object.assign({}, own || {});
  for (const it of doc.items.values()) if (it.kind === "property" && it.node && it.node[0] === "property" && !(doc as { fpEditor?: boolean }).fpEditor) out[str(it.node[1])] = str(it.node[2]);
  return out;
}
const currentVariant = (doc: Board): string => str((doc as { variantName?: string }).variantName);

/** BOARD::ResolveTextVar( token, variant, depth ). */
export function boardResolve(doc: Board, token: string, depth: number, variant?: string): VarValue {
  const vname = variant === undefined ? currentVariant(doc) : variant;
  if (token.indexOf(":") >= 0) {
    const ref = token.slice(0, token.indexOf(":")), rest = token.slice(token.indexOf(":") + 1);
    // ResolveItem( KIID( ref ), true ): a footprint, or one of a footprint's children
    let refItem: SNode | null = null, isFp = false;
    const direct = doc.items.get(ref);
    if (direct) { refItem = direct.node; isFp = direct.kind === "footprint"; }
    else for (const it of doc.items.values()) if (it.kind === "footprint") { for (const c of it.node) if (isList(c) && uuidOf(c) === ref) { refItem = c; break; } if (refItem) break; }
    if (refItem && isFp) {
      const r = footprintResolve(doc, refItem, rest, depth + 1, vname);
      return r !== null && r !== undefined ? r : `<Unresolved: ${fpRef(refItem)}:${rest}>`;
    }
    // a reference designator, matched without case (${U1:VALUE} typed before a save converts it)
    if (!refItem) {
      for (const it of doc.items.values()) {
        if (it.kind !== "footprint" || fpRef(it.node).toLowerCase() !== ref.toLowerCase()) continue;
        const r = footprintResolve(doc, it.node, rest, depth + 1, vname);
        return r !== null && r !== undefined ? r : `<Unresolved: ${ref}:${rest}>`;
      }
      return `<Unresolved: ${ref}:${rest}>`;
    }
  }
  const vars = sheetTextVars(doc);
  if (token === "FILENAME") return str(vars.FILENAME).split("/").pop() || "";
  if (token === "FILEPATH") return str(vars.FILEPATH);
  if (token === "VARIANT") return vname;
  if (token === "VARIANT_DESC") return vname === currentVariant(doc) ? str((doc as { variantDesc?: string }).variantDesc) : "";
  if (token === "PROJECTNAME" && (doc as { projectName?: string }).projectName !== undefined) return str((doc as { projectName?: string }).projectName);
  { const d = drillTextVar(doc as Doc, token); if (d !== null) return d; }   // ${DRILL_OPERATIONS} ${DRILL_SITES} ${DRILL_GROUPS}
  // TITLE_BLOCK::TextVarResolver, then PROJECT::TextVarResolver (the drawing sheet's own tokens are not the board's)
  const project = (doc && (doc as { projectVars?: Record<string, unknown> | null }).projectVars) || null;
  if (WS_TOKENS.has(token)) { const v = project ? project[token] : undefined; if (v !== undefined && v !== null) return String(v); }
  else { const v = varResolver(vars, { project })(token); if (v !== null && v !== undefined) return v; }
  // the board's cached properties
  const props = boardProperties(doc);
  if (Object.prototype.hasOwnProperty.call(props, token)) return props[token];
  return null;
}

/** PCB_FIELD::GetShownText( variant, INTERNAL ): a variant's value is taken as it is, the field's own text is resolved. */
function fieldShown(doc: Board, fp: SNode, name: string, node: SNode, text: string, depth: number, variant: string): string {
  if (!isDefaultVariant(variant)) {
    const st = footprintVariant(fp, variant);
    if (st && st.fields.has(name)) return unescapeText(st.fields.get(name) as string);
  }
  const t = unescapeText(text);
  if (!hasTextVars(t) || depth > DEPTH) return t;
  const layer = boardLayerName(doc, str((kid(node, "layer") || [])[1]) || "F.SilkS");
  return expandTextVars(t, (tok) => {
    if (tok === "LAYER") return layer;
    const r = footprintResolve(doc, fp, tok, depth + 1, variant); if (r !== null && r !== undefined) return r;
    return boardResolve(doc, tok, depth + 1, variant);
  }, undefined, { erc: true });
}

/** FOOTPRINT's ${PROPERTY.Name} (FOOTPRINT_DESC and BOARD_ITEM_DESC, shown as DIFF_VALUE::ToDisplayString in mm). */
function footprintProperty(doc: Board, fp: SNode, name: string, variant: string): string | null {
  const attr = kid(fp, "attr"), toks = attr ? attr.slice(1).map(str) : [];
  const flags = footprintFlagsForVariant(fp, variant), b = (v: boolean): string => (v ? "true" : "false");
  const [x, y, rot] = atOf(fp);
  const mm = (v: number): string => stringFromValue(v, "mm", "pcb", true);
  const descr = (k: string): string => str((kid(fp, k) || [])[1]);
  const opt = (k: string): SNode | null => kid(fp, k);
  switch (name) {
    case "Position X": return mm(x);
    case "Position Y": return mm(y);
    case "Locked": return b(has(fp, "locked") || yesNo(fp, "locked"));
    case "Layer": return str((kid(fp, "layer") || [])[1]) || "F.Cu";
    // MessageTextFromValue( EDA_ANGLE ): "%.1f°"
    case "Orientation": return (rot || 0).toFixed(1) + "°";
    case "Scale X": case "Scale Y": {
      const tr = kid(fp, "transform"), sc = tr ? kid(tr, "scale") : null; const v = sc ? num(sc[name === "Scale X" ? 1 : 2], 1) : 1; return String(Number(v.toPrecision(6)));
    }
    case "Reference": return fpRef(fp);
    case "Library Link": return str(fp[1]);
    case "Library Description": return descr("descr");
    case "Keywords": return descr("tags");
    case "Height": return mm(opt("height") ? num(opt("height")![1], 0) : 0);
    case "Component Class": {
      const cc = kid(fp, "component_classes"); const names = cc ? kids(cc, "class").map((c) => str(c[1])).filter((s) => s) : [];
      return Array.from(new Set(names)).sort().join(",");
    }
    case "Footprint Type": return toks.includes("through_hole") ? "Through hole" : toks.includes("smd") ? "SMD" : "Unspecified";
    case "Not in Schematic": return b(toks.includes("board_only"));
    case "Exclude From Position Files": return b(flags.exclude_from_pos_files);
    case "Exclude From Bill of Materials": return b(flags.exclude_from_bom);
    case "Exclude From Simulation": return b(flags.exclude_from_sim);
    case "Do not Populate": return b(flags.dnp);
    case "Exempt From Courtyard Requirement": return b(toks.includes("allow_missing_courtyard"));
    // std::optional values: unset is no value at all (the token stays unresolved)
    case "Clearance Override": return opt("clearance") ? mm(num(opt("clearance")![1], 0)) : null;
    case "Solderpaste Margin Override": return opt("solder_paste_margin") ? mm(num(opt("solder_paste_margin")![1], 0)) : null;
    case "Solderpaste Margin Ratio Override": return opt("solder_paste_margin_ratio") ? String(Number(num(opt("solder_paste_margin_ratio")![1], 0).toPrecision(6))) : null;
    case "Zone Connection Style": {
      const zc = opt("zone_connect"); const v = zc ? num(zc[1], -1) : -1;
      return v === 0 ? "None" : v === 1 ? "Thermal reliefs" : v === 2 ? "Solid" : v === 3 ? "Thermal reliefs for PTH" : "Inherited";
    }
    default: return null;
  }
}

/** FOOTPRINT::ResolveTextVar( token, variant, depth ): null when neither it nor the board answers. */
export function footprintResolve(doc: Board, fp: SNode, token: string, depth: number, variant?: string): VarValue {
  // a footprint in the Footprint Editor resolves nothing of its own
  if ((doc as { fpEditor?: boolean }).fpEditor) return null;
  const vname = variant === undefined ? currentVariant(doc) : variant;
  const fields = fpFields(fp), field = (nm: string) => fields.find((f) => f[0] === nm);
  if (token === "REFERENCE" || token === "VALUE") {
    const f = field(token === "REFERENCE" ? "Reference" : "Value");
    return f ? fieldShown(doc, fp, f[0], f[1], f[2], depth + 1, vname) : "";
  }
  if (token === "LAYER") return boardLayerName(doc, str((kid(fp, "layer") || [])[1]) || "F.Cu");
  if (token === "FOOTPRINT_LIBRARY" || token === "FOOTPRINT_NAME") {
    const id = str(fp[1]), i = id.indexOf(":");
    return token === "FOOTPRINT_LIBRARY" ? (i >= 0 ? id.slice(0, i) : "") : (i >= 0 ? id.slice(i + 1) : id);
  }
  if (/^(SHORT_NET_NAME|NET_NAME|NET_CLASS|PIN_NAME)\(/.test(token)) {
    const arg = token.slice(token.indexOf("(") + 1), close = arg.lastIndexOf(")"), padNumber = close >= 0 ? arg.slice(0, close) : arg;
    for (const pad of kids(fp, "pad")) {
      if (str(pad[1]) !== padNumber) continue;
      const netN = kid(pad, "net"), net = netN ? str(netN[netN.length - 1]) : "";
      const hasNet = !!netN && !(netN.length === 3 && num(netN[1], 0) === 0);
      if (token.startsWith("SHORT_NET_NAME")) return hasNet ? net.slice(net.lastIndexOf("/") + 1) : "";
      if (token.startsWith("NET_NAME")) return hasNet ? net : "";
      if (token.startsWith("NET_CLASS")) { const c = hasNet && pcbVars.netClass ? pcbVars.netClass(net) : null; return c || "Default"; }
      return str((kid(pad, "pinfunction") || [])[1]);
    }
  } else if (token === "EXCLUDE_FROM_BOM") return footprintFlagsForVariant(fp, vname).exclude_from_bom ? "Excluded from BOM" : "";
  else if (token === "EXCLUDE_FROM_POS_FILES") return footprintFlagsForVariant(fp, vname).exclude_from_pos_files ? "Excluded from position files" : "";
  else if (token === "EXCLUDE_FROM_BOARD") return "";
  else if (token === "EXCLUDE_FROM_SIM") return footprintFlagsForVariant(fp, vname).exclude_from_sim ? "Excluded from simulation" : "";
  else if (token === "DNP") return footprintFlagsForVariant(fp, vname).dnp ? "DNP" : "";
  else if (field(token)) { const f = field(token)!; return fieldShown(doc, fp, f[0], f[1], f[2], depth + 1, vname); }
  else if (token.startsWith("PROPERTY.")) return footprintProperty(doc, fp, token.slice(token.indexOf(".") + 1).replace(/_/g, " "), vname);
  return boardResolve(doc, token, depth + 1, vname);
}

/**
 * PCB_TEXT / PCB_TEXTBOX::GetShownText: ${LAYER} is the text's own layer, then its footprint's variables, then the
 * board's.  A footprint's field takes the variant's value as it is (PCB_FIELD::GetShownText) when `field` names it.
 * `opts.erc` keeps the form ERC / DRC read (FOR_ERC_DRC: an escaped \${…} keeps its backslash).
 */
export function pcbTextShown(doc: Board | null | undefined, text: string, layer: string, fp?: SNode | null, field?: string | null, opts?: ExpandOpts): string {
  if (!doc) return text;
  if (fp && field) {
    const vname = currentVariant(doc);
    if (!isDefaultVariant(vname)) { const st = footprintVariant(fp, vname); if (st && st.fields.has(field)) return st.fields.get(field) as string; }
  }
  if (!hasTextVars(text)) return text;
  const lname = boardLayerName(doc, layer);
  try {
    return expandTextVars(text, (tok) => {
      if (tok === "LAYER") return lname;
      if (fp) { const r = footprintResolve(doc, fp, tok, 1); if (r !== null && r !== undefined) return r; }
      return boardResolve(doc, tok, 1);
    }, undefined, opts);
  } catch (e) { return text; }
}
