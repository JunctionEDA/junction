// panels/propgrid.ts — KiCad's Properties panel (PROPERTIES_PANEL over PROPERTY_MANAGER): the property grid of
// the selection, with the category and property names the C++ registers (eeschema/sch_symbol.cpp, sch_line.cpp,
// sch_label.cpp, …; pcbnew/footprint.cpp, pcb_track.cpp, pad.cpp, zone.cpp, pcb_shape.cpp, pcb_text.cpp,
// pcb_dimension.cpp; common/eda_shape.cpp, eda_text.cpp).  A property is a getter over an item's s-expression
// node and a setter that edits a clone of it; committing a value replaces every selected item that has the
// property in ONE op (the same whole-item replace change props.js commits), so it syncs and undoes as a unit.
// Multi-selection shows the properties the items share; values that differ show as mixed.
import type { PropGrid, PropGroup, PropRow, PropType } from "../../panels-api";
import { E } from "../state";
import { fromDisplayAbsAxis, toDisplayAbsAxis } from "../userorigin";
import { setNet } from "../pcbdialogs/item-props";
import * as TV from "../pcbdialogs/track-via-model";
import { applyDimDialog, dimDialogValues, type DimDialogValues } from "../pcbdialogs/dimension";
import { KICAD_FONT, faceOfFont, facesUsed, setFaceOfFont } from "../../dialogs/font-picker";
import { layerDisplayName, netClassOf } from "./appearance";
import { KC, isSchDoc, kdoc, panelStore, pcbTools, tctx } from "./core";
import { commitWithOtherUnits } from "../../dialogs/sync-units";
import * as VM from "../../canvas/variant-model";
import { currentInstance, netMap } from "../schnets";
import { fieldValidationError, unescapeString, readEndingState, writeEndingState } from "../../dialogs/sch-items-logic";
import { chooseFootprint, noFileBrowsing, openDatasheet } from "../../dialogs/browse-cells";
import { chooserFilters, datasheetLink, type FpChooserFilters } from "../../library/fpchoice";
import { toast } from "../util";
import { colorText, parseColorText } from "../../../../shared/components/panes/prop-text";
import { composeRefSuffix, REF_SUFFIX_FIELD, PIN_MAP_VERSION, activeAssociatedFootprint, associatedFootprints, defaultOverride, effectivePadNumber, readOverride, readPinMaps, writeOverride, type PinMapMode, type PinMapOverride } from "../../dialogs/sym-props-logic";
import { expandStacked } from "../../symedit/model";
import { selectedFields } from "../selection";
import { fieldNodeOf, fieldProps as schFieldProps, parentFieldRow, replaceField, type FieldProp } from "./field-props";
import { changeSheetFileProp } from "../../dialogs/sch-symbol-sheet";

type Raw = string | number | boolean | null;
interface PropDef {
  group: string; name: string; type: PropType;
  get(it: KItem): Raw;
  /** edit a CLONE of the item's node; false = nothing to change */
  set?(node: SNode, v: Raw, it: KItem): boolean | void;
  /** a view-only control (the pad picker): runs instead of a commit */
  local?(v: Raw, it: KItem): void;
  choices?: [string, string][];
  /** PROPERTY_BASE::Available: the row is shown only when every selected item has it */
  avail?(it: KItem): boolean;
  /** PROPERTY_BASE::Writeable: the row is greyed out when one selected item cannot take it */
  canWrite?(it: KItem): boolean;
  /** a tuning pattern's property that lives on its member tracks: edit each member's (cloned) node */
  member?(node: SNode, v: Raw): boolean | void;
  /** a name the user may rename in the grid's label column (PCB_PROPERTIES_PANEL::isKeyEditable) */
  key?: "field" | "custom";
  /** PROPERTY<…, std::optional<T>>: an empty cell is "no value" (the setter gets null), and 0 is a value */
  optional?: boolean;
  /** an editable combo's predefined values in mm (a track's Width: BOARD_DESIGN_SETTINGS::m_TrackWidthList) */
  suggest?(): number[];
  /** PROPERTY_BASE::SetValidator: the error for a value this item cannot take (shown, nothing committed); null or ""
   *  when it may be set */
  validate?(v: Raw, it: KItem): string | null;
  /** DUMMY_PROPERTY: stands in on an item that has no such property, so the items beside it that do keep theirs
   *  common (SCH_PROPERTIES_PANEL::rebuildProperties: a junction among wires, a wire among junctions) */
  dummy?: boolean;
}

/** props.js's node editors (static/props.js `helpers`). */
interface Helpers {
  evalExpr(text: string, unit: string): number; formatLength(mm: number, unit: string): string;
  kid(n: SNode, k: string): SNode | null; kids(n: SNode, k: string): SNode[]; num(v: unknown, d?: number): number; str(v: unknown): string;
  setKid(n: SNode, k: string, values: (string | number | SNode)[], before?: string[]): SNode; delKid(n: SNode, k: string): void;
  yes(n: SNode, k: string, def: boolean): boolean; setYesNo(n: SNode, k: string, on: boolean): void;
  fieldList(n: SNode): SNode[]; setField(n: SNode, name: string, v: string): SNode;
  mirrorOf(n: SNode): string; setSymbolTransform(n: SNode, rot: number, mirror: string): void; setSymbolPosition(n: SNode, x: number, y: number): void;
  setSymbolUnit(n: SNode, u: number): void; setSymbolFlag(n: SNode, key: string, on: boolean): void; libUnitCount(doc: KDoc, n: SNode): number;
  setFootprintPosition(n: SNode, x: number, y: number): void; setFootprintRotation(n: SNode, deg: number): boolean; setFootprintSide(n: SNode, side: string, leftRight?: boolean): boolean;
  footprintAttrs(n: SNode): Record<string, unknown>; setFootprintAttrs(n: SNode, patch: Record<string, unknown>): void;
  netNameOf(doc: KDoc, n: SNode): string; boardNetNames(doc: KDoc): string[]; boardLayers(doc: KDoc, copperOnly: boolean): string[];
  padNode(n: SNode, i: number): SNode | null; padInfo(doc: KDoc, pad: SNode): { number: string; type: string; shape: string; w: number; h: number; rot: number; drill: string; net: string; maskMargin: number | null; pasteMargin: number | null; rratio: number | null };
  setPad(n: SNode, i: number, patch: Record<string, unknown>, doc: KDoc): boolean;
  strokeWidth(n: SNode): number; setStrokeWidth(n: SNode, w: number): void; setWidth(n: SNode, w: number): void; setLayer(n: SNode, l: string): void;
  setText(n: SNode, t: string): void; textSize(n: SNode): number; setTextSize(n: SNode, s: number): void; setShape(n: SNode, s: string): void; setDiameter(n: SNode, d: number): void;
  setViaSize(n: SNode, s: number): void; setViaDrill(n: SNode, d: number): void; setViaLayers(n: SNode, a: string, b: string): void;
  setZoneName(n: SNode, name: string): void; setZonePriority(n: SNode, p: number): void; normDeg(a: number): number; deg360(a: number): number;
}
const H = (): Helpers => (window.CollabTools.props as unknown as { helpers: Helpers }).helpers;
const K = KC;
const r6 = (v: number) => +(+v).toFixed(6);

// ---------------------------------------------------------------- selection
/** Every selected item: the app's selection, the tool module's own picks, else (on a board) the item of a selected
 *  field.  A schematic field selected on its own is the SCH_FIELD itself (fieldGrid), not its symbol or sheet. */
export function selectedItems(): KItem[] {
  const doc = kdoc(); if (!doc) return [];
  const ids = new Set<string>(E.selection as Set<string>);
  if (E.selected && E.selected.id) ids.add(E.selected.id as string);
  if (isSchDoc()) { const s = window.CollabTools.sch ? window.CollabTools.sch.state.sel : null; if (typeof s === "string" && s) ids.add(s); }
  else { const P = pcbTools(); if (P) for (const id of P.state.sel) ids.add(id); }
  if (!ids.size && E.selField && E.selField.id && !isSchDoc()) ids.add(E.selField.id as string);
  const out: KItem[] = [];
  for (const id of ids) { const it = doc.items.get(id); if (it) out.push(it); }
  return out;
}
export function selectionSignature(): string { return selectedItems().map((it) => it.id).sort().join(",") + selectedPads().map((p) => "|pad:" + p.key).join("") + (isSchDoc() ? selectedFields().map((f) => "|field:" + f.id + ":" + f.name).join("") : "") + E.selPins.map((p: { id: string; number: string }) => "|pin:" + p.id + ":" + p.number).join("") + "|" + String(E.units) + "|" + (E.viewOnly ? 1 : 0); }

// ---------------------------------------------------------------- shared property builders
const BASIC = "Basic Properties";
const ORIENT4: [string, string][] = [["0", "0°"], ["90", "90°"], ["180", "180°"], ["270", "270°"]];
const LINE_STYLES: [string, string][] = [["default", "Default"], ["solid", "Solid"], ["dash", "Dashed"], ["dot", "Dotted"], ["dash_dot", "Dash-Dot"], ["dash_dot_dot", "Dash-Dot-Dot"]];
const H_JUST: [string, string][] = [["left", "Left"], ["center", "Center"], ["right", "Right"]];
const V_JUST: [string, string][] = [["top", "Top"], ["center", "Center"], ["bottom", "Bottom"]];

function xyProp(group: string, name: string, key: string, index: 1 | 2, type: PropType = "coord"): PropDef {
  return { group, name, type, get: (it) => { const k = H().kid(it.node, key); return k ? H().num(k[index]) : null; },
    set: (n, v) => { const k = H().kid(n, key); if (!k) return false; k[index] = r6(v as number); } };
}
/** A footprint's FOOTPRINT::GetScaleX / GetScaleY: (transform … (scale x y)), 1 without one. */
function fpScale(n: SNode): [number, number] { const h = H(); const t = h.kid(n, "transform"), s = t && h.kid(t, "scale"); return s ? [h.num(s[1], 1) || 1, h.num(s[2], 1) || 1] : [1, 1]; }
function scaleProp(name: string, index: 1 | 2): PropDef {
  return { group: BASIC, name, type: "number", get: (x) => fpScale(x.node)[index - 1],
    set: (n, v) => {
      const h = H(), val = v as number; if (!Number.isFinite(val) || val <= 0) return false;
      const cur = fpScale(n); const sc: [number, number] = index === 1 ? [val, cur[1]] : [cur[0], val]; if (sc[0] === cur[0] && sc[1] === cur[1]) return false;
      let t = h.kid(n, "transform");
      if (!t) { const [x, y, a] = K().atOf(n); const at = h.kid(n, "at"); const i = at ? n.indexOf(at) : 3; if (at) n.splice(i, 1); t = ["transform", ["translate", x, y], ["rotate", a]] as unknown as SNode; n.splice(i, 0, t); }
      const s = h.kid(t, "scale"); if (s) { s[1] = r6(sc[0]); s[2] = r6(sc[1]); } else t.push(["scale", r6(sc[0]), r6(sc[1])]);
    } };
}
function atProp(name: string, index: 1 | 2): PropDef {
  return { group: BASIC, name, type: "coord", get: (it) => K().atOf(it.node)[index - 1],
    set: (n, v) => { const [x, y] = K().atOf(n); K().setAt(n, index === 1 ? r6(v as number) : x, index === 2 ? r6(v as number) : y); } };
}
function strokeOf(n: SNode): SNode | null { return H().kid(n, "stroke"); }
function strokeProps(group: string, styleName: string, withColor: boolean): PropDef[] {
  const out: PropDef[] = [
    { group, name: styleName, type: "enum", choices: LINE_STYLES, get: (it) => { const s = strokeOf(it.node), t = s && H().kid(s, "type"); return t ? H().str(t[1]) : "default"; },
      set: (n, v) => { let s = strokeOf(n); if (!s) s = H().setKid(n, "stroke", [["width", 0]], ["fill", "uuid", "tstamp"]); H().setKid(s, "type", [String(v)], ["color"]); } },
    { group, name: "Line Width", type: "length", get: (it) => H().strokeWidth(it.node), set: (n, v) => { H().setStrokeWidth(n, Math.max(0, v as number)); } },
  ];
  // PGPROPERTY_COLOR4D: the colour with its alpha ("#rrggbb" when opaque, else "rgba(r,g,b,a)"); "" is UNSPECIFIED
  if (withColor) out.push(colorProp(group, "Color", (n) => { const s = strokeOf(n); return s ? H().kid(s, "color") : null; },
    (n, c) => { let s = strokeOf(n); if (!s) s = H().setKid(n, "stroke", [["width", 0], ["type", "default"]], ["fill", "uuid", "tstamp"]); H().setKid(s, "color", c); }));
  return out;
}
function fontOf(n: SNode, create: boolean): SNode | null {
  let e = H().kid(n, "effects"); if (!e) { if (!create) return null; e = H().setKid(n, "effects", [], ["uuid", "tstamp"]); }
  let f = H().kid(e, "font"); if (!f) { if (!create) return null; f = H().setKid(e, "font", [["size", 1.27, 1.27]], ["justify", "hide", "href"]); }
  return f;
}
function fontFlag(group: string, name: string, key: string): PropDef {
  return { group, name, type: "bool", get: (it) => { const f = fontOf(it.node, false); return !!f && (H().yes(f, key, false)); },
    set: (n, v) => { const f = fontOf(n, true)!; const i = f.indexOf(key); if (i > 0) f.splice(i, 1); H().delKid(f, key); if (v) H().setKid(f, key, ["yes"], key === "bold" ? ["italic", "color", "line_spacing"] : ["color", "line_spacing"]); } };
}
function justifyOf(n: SNode): { h: string; v: string; mirror: boolean } {
  const e = H().kid(n, "effects"), j = e && H().kid(e, "justify"); const toks = j ? j.slice(1).map((x) => H().str(x)) : [];
  return { h: toks.includes("left") ? "left" : toks.includes("right") ? "right" : "center", v: toks.includes("top") ? "top" : toks.includes("bottom") ? "bottom" : "center", mirror: toks.includes("mirror") };
}
function setJustify(n: SNode, patch: Partial<{ h: string; v: string; mirror: boolean }>): void {
  const cur = Object.assign(justifyOf(n), patch);
  let e = H().kid(n, "effects"); if (!e) e = H().setKid(n, "effects", [["font", ["size", 1.27, 1.27]]], ["uuid", "tstamp"]);
  const toks: string[] = []; if (cur.h !== "center") toks.push(cur.h); if (cur.v !== "center") toks.push(cur.v); if (cur.mirror) toks.push("mirror");
  if (toks.length) H().setKid(e, "justify", toks, ["hide", "href"]); else H().delKid(e, "justify");
}
function justifyProps(group: string): PropDef[] {
  return [
    { group, name: "Horizontal Justification", type: "enum", choices: H_JUST, get: (it) => justifyOf(it.node).h, set: (n, v) => setJustify(n, { h: String(v) }) },
    { group, name: "Vertical Justification", type: "enum", choices: V_JUST, get: (it) => justifyOf(it.node).v, set: (n, v) => setJustify(n, { v: String(v) }) },
  ];
}
function fieldProps(it: KItem): PropDef[] {
  return H().fieldList(it.node).map((p): PropDef => {
    const name = H().str(p[1]);
    return { group: "Fields", name, type: "text", get: (x) => { const f = H().fieldList(x.node).find((q) => H().str(q[1]) === name); return f ? H().str(f[2]) : null; }, set: (n, v) => { H().setField(n, name, String(v)); } };
  });
}
const flag = (group: string, name: string, key: string, def: boolean, invert: boolean): PropDef => ({ group, name, type: "bool",
  get: (it) => { const on = H().yes(it.node, key, def); return invert ? !on : on; }, set: (n, v) => { H().setSymbolFlag(n, key, invert ? !v : !!v); } });

// ---------------------------------------------------------------- schematic items
function symbolProps(it: KItem, doc: KDoc): PropDef[] {
  const h = H();
  const mirrorSet = (axis: "x" | "y") => (n: SNode, v: Raw) => {
    const rot = K().atOf(n)[2], m = h.mirrorOf(n), on = !!v, has = m === axis;
    if (on === has) return false;
    if (!on) h.setSymbolTransform(n, rot, "");
    else if (!m) h.setSymbolTransform(n, rot, axis);
    else h.setSymbolTransform(n, (rot + 180) % 360, "");     // mirrored about both axes is a half turn
  };
  const out: PropDef[] = [
    { group: BASIC, name: "Position X", type: "coord", get: (x) => K().atOf(x.node)[0], set: (n, v) => { h.setSymbolPosition(n, v as number, K().atOf(n)[1]); } },
    { group: BASIC, name: "Position Y", type: "coord", get: (x) => K().atOf(x.node)[1], set: (n, v) => { h.setSymbolPosition(n, K().atOf(n)[0], v as number); } },
    { group: BASIC, name: "Orientation", type: "enum", choices: ORIENT4, get: (x) => String(h.deg360(K().atOf(x.node)[2])), set: (n, v) => { h.setSymbolTransform(n, +(v as string), h.mirrorOf(n)); } },
    { group: BASIC, name: "Mirror X", type: "bool", get: (x) => h.mirrorOf(x.node) === "x", set: mirrorSet("x") },
    { group: BASIC, name: "Mirror Y", type: "bool", get: (x) => h.mirrorOf(x.node) === "y", set: mirrorSet("y") },
  ];
  const units = h.libUnitCount(doc, it.node);
  const unitChoices: [string, string][] = []; for (let u = 1; u <= Math.max(1, units); u++) unitChoices.push([String(u), u <= 26 ? String.fromCharCode(64 + u) : String(u)]);
  out.push({ group: BASIC, name: "Unit", type: "enum", choices: unitChoices, get: (x) => { const k = h.kid(x.node, "unit"); return String(k ? h.num(k[1], 1) : 1); }, set: (n, v) => { h.setSymbolUnit(n, +(v as string)); } });
  const fieldDefs = fieldProps(it).map((d) => (SYM_MANDATORY.includes(d.name) ? d : Object.assign(d, { key: "field" as const })));
  // with a current variant the fields (but the Reference) and the attributes read and write the symbol instance's
  // variant (SCH_SYMBOL's property getters / setters take Schematic().GetCurrentVariant())
  const variant = String(E.currentVariant || "");
  if (variant) {
    const inst = currentInstance(), path = inst && inst.uuidPath.length ? "/" + inst.uuidPath.join("/") : null;
    const ver = (doc as KDoc).version;
    const view = (x: KItem): SNode => VM.symbolViewForVariant(x.node, variant, path, ver);
    const put = (n: SNode, patch: VM.SymVariantPatch): void => { const c = VM.setSymbolVariant(n, variant, patch, path, ver); n.length = 0; n.push(...c); };
    for (const d of fieldDefs) {
      const name = d.name;
      out.push(name === "Reference" ? d : { ...d, get: (x) => { const f = H().fieldList(view(x)).find((q) => H().str(q[1]) === name); return f ? H().str(f[2]) : null; }, set: (n, v) => { put(n, { fields: { [name]: String(v) } }); } });
    }
    out.push({ group: "Fields", name: "Library Link", type: "text", get: (x) => h.str((h.kid(x.node, "lib_id") || [])[1]) });
    const vflag = (name: string, f: keyof VM.SymFlags): PropDef => ({ group: "Attributes", name, type: "bool", get: (x) => VM.symbolFlagsForVariant(x.node, variant, path, ver)[f], set: (n, v) => { put(n, { flags: { [f]: !!v } }); } });
    out.push(vflag("Exclude From Simulation", "excludedFromSim"), vflag("Exclude From Bill of Materials", "excludedFromBOM"), vflag("Exclude From Board", "excludedFromBoard"),
      vflag("Exclude From Position Files", "excludedFromPosFiles"), vflag("Do not Populate", "dnp"));
    return out;
  }
  out.push(...fieldDefs);
  out.push({ group: "Fields", name: "Library Link", type: "text", get: (x) => h.str((h.kid(x.node, "lib_id") || [])[1]) });
  out.push(...pinMapProps(it, doc));
  out.push(flag("Attributes", "Exclude From Simulation", "exclude_from_sim", false, false), flag("Attributes", "Exclude From Bill of Materials", "in_bom", true, true),
    flag("Attributes", "Exclude From Board", "on_board", true, true), flag("Attributes", "Exclude From Position Files", "in_pos_files", true, true), flag("Attributes", "Do not Populate", "dnp", false, false));
  return out;
}
/**
 * SCH_SYMBOL::GetDynamicProperties' "Pin Map" category (Pin Map Footprint, Pin Map Mode, Pin Map Name) and its
 * "Effective Pin Map" rows (one read-only "Pin <n>" per pin of the instance's unit), shown for a symbol whose library
 * symbol has an associated footprint (HasEffectiveAssociatedFootprint) in a file new enough to hold pin maps.  The
 * category's "Edit Pin Map..." button opens the Symbol Properties dialog's Pin Map page.
 */
/** SCH_SYMBOL_PIN_MAP_MODE_PROPERTY::BuildChoices: DELEGATE_TO_UNIT_1 is internal and never offered. */
const PIN_MAP_MODES: [string, string][] = [["library_default", "Library default"], ["named_map", "Named map"], ["identity", "Identity"]];
function ownLibOf(doc: KDoc, n: SNode): SNode | null {
  const h = H(), name = h.str((h.kid(n, "lib_name") || [])[1]) || h.str((h.kid(n, "lib_id") || [])[1]);
  const lib = (doc as KDoc & { lib?: Map<string, SNode> }).lib;
  return lib ? lib.get(name) || lib.get(h.str((h.kid(n, "lib_id") || [])[1])) || null : null;
}
export function hasPinMaps(doc: KDoc, it: KItem): boolean {
  if (it.kind !== "symbol" || (Number((doc as KDoc & { version?: number }).version) || 0) < PIN_MAP_VERSION) return false;
  return associatedFootprints(ownLibOf(doc, it.node)).length > 0;
}
const symUnit = (n: SNode): number => { const k = H().kid(n, "unit"); return k ? H().num(k[1], 1) : 1; };
const footprintFieldOf = (n: SNode): string => { const f = H().fieldList(n).find((q) => H().str(q[1]) === "Footprint"); return f ? H().str(f[2]) : ""; };
/** SCH_SYMBOL::GetPinMapOverride: units 2..N that delegate follow unit 1's record (resolveDelegatedPinMapOverride). */
function pinMapOverride(doc: KDoc, it: KItem): PinMapOverride {
  const o = readOverride(it.node) || defaultOverride(); if (o.mode !== "delegate") return o;
  const ref = String(it.ref || "").toLowerCase();
  for (const sib of doc.items.values()) {
    if (sib === it || sib.kind !== "symbol" || symUnit(sib.node) !== 1 || String(sib.ref || "").toLowerCase() !== ref) continue;
    const u1 = readOverride(sib.node) || defaultOverride(); return u1.mode === "delegate" ? defaultOverride() : u1;
  }
  return defaultOverride();
}
/** SCH_SYMBOL::GetPins: the library pins of the instance's unit and body style (plus the common ones). */
function instancePinNumbers(lib: SNode, n: SNode): string[] {
  const h = H(), unit = symUnit(n), bk = h.kid(n, "body_style") || h.kid(n, "convert"), body = bk ? h.num(bk[1], 1) : 1, out: string[] = [];
  for (const u of h.kids(lib, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(h.str(u[1])); if (!m) continue;
    if ((+m[1] !== 0 && +m[1] !== unit) || (+m[2] !== 0 && +m[2] !== body)) continue;
    for (const p of h.kids(u, "pin")) { const k = h.kid(p, "number"); out.push(k ? h.str(k[1]) : ""); }
  }
  return out;
}
function pinMapProps(it: KItem, doc: KDoc): PropDef[] {
  if (!hasPinMaps(doc, it)) return [];
  const G = "Pin Map", lib = ownLibOf(doc, it.node) as SNode;
  const names = readPinMaps(lib).maps.map((m) => m.name);
  const out: PropDef[] = [
    { group: G, name: "Pin Map Footprint", type: "text", get: (x) => { const a = activeAssociatedFootprint(lib, footprintFieldOf(x.node)); return a ? a.footprint : ""; } },
    { group: G, name: "Pin Map Mode", type: "enum", choices: PIN_MAP_MODES, get: (x) => { const m = pinMapOverride(doc, x).mode; return m === "delegate" ? "library_default" : m; },
      set: (n, v, x) => {
        const o = pinMapOverride(doc, x); o.mode = String(v) as PinMapMode;
        // the active map name is seeded from the active associated footprint when switching to a named map
        if (o.mode === "named_map" && !o.map) { const a = activeAssociatedFootprint(lib, footprintFieldOf(n)); if (a) o.map = a.map; }
        writeOverride(n, o);
      } },
  ];
  if (names.length > 1) out.push({ group: G, name: "Pin Map Name", type: "enum", choices: names.map((m) => [m, m] as [string, string]),
    get: (x) => {
      const o = pinMapOverride(doc, x); let active = o.mode === "named_map" ? o.map : "";
      if (!names.includes(active)) { const a = activeAssociatedFootprint(lib, footprintFieldOf(x.node)); if (a) active = a.map; }
      return names.includes(active) ? active : names[0];
    },
    set: (n, v, x) => { if (!names.includes(String(v))) return false; const o = pinMapOverride(doc, x); o.mode = "named_map"; o.map = String(v); writeOverride(n, o); } });
  // one read-only row per (stacked) pin number: the pad its pin resolves to
  const seen = new Set<string>();
  for (const pin of instancePinNumbers(lib, it.node)) {
    for (const number of expandStacked(pin).pins) {
      if (!number || seen.has(number)) continue; seen.add(number);
      out.push({ group: "Effective Pin Map", name: "Pin " + number, type: "text", get: (x) => {
        const pad = effectivePadNumber(lib, pinMapOverride(doc, x), footprintFieldOf(x.node), pin);
        return pad === number ? `${pad} (identity)` : pad;
      } });
    }
  }
  return out;
}
function schLineProps(it: KItem): PropDef[] {
  const pt = (name: string, end: boolean, i: 0 | 1): PropDef => ({ group: BASIC, name, type: "coord",
    get: (x) => { const p = K().ptsOf(x.node); const q = end ? p[p.length - 1] : p[0]; return q ? q[i] : null; },
    set: (n, v) => { const p = K().ptsOf(n).map((q) => q.slice() as [number, number]); const q = end ? p[p.length - 1] : p[0]; if (!q) return false; q[i] = r6(v as number); K().setPts(n, p); } });
  return [pt("Start X", false, 0), pt("Start Y", false, 1), pt("End X", true, 0), pt("End Y", true, 1),
    { group: BASIC, name: "Length", type: "length", get: (x) => { const p = K().ptsOf(x.node); let l = 0; for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return l; } },
    ...strokeProps(BASIC, it.kind === "polyline" ? "Line Style" : "Wire Style", true)];
}
/** FLAG_SHAPE: a directive label's flag (the file's (shape dot | round | diamond | rectangle)). */
const FLAG_SHAPES: [string, string][] = [["dot", "Dot"], ["round", "Circle"], ["diamond", "Diamond"], ["rectangle", "Rectangle"]];
const LABEL_SHAPES: [string, string][] = [["input", "Input"], ["output", "Output"], ["bidirectional", "Bidirectional"], ["tri_state", "Tri-state"], ["passive", "Passive"]];
function schTextProps(it: KItem): PropDef[] {
  const h = H(), k = it.kind, T = "Text Properties";
  const out: PropDef[] = [atProp("Position X", 1), atProp("Position Y", 2)];
  if (k === "global_label" || k === "hierarchical_label") out.push({ group: BASIC, name: "Shape", type: "enum", choices: LABEL_SHAPES, get: (x) => h.str((h.kid(x.node, "shape") || [])[1] || "input"), set: (n, v) => { h.setShape(n, String(v)); } });
  // SCH_DIRECTIVE_LABEL_DESC: "Shape" (the flag's) and "Pin length"; "Text", "Thickness", "Italic", "Bold" and the
  // justifications are masked (a directive label shows no text of its own)
  const directive = k === "netclass_flag" || k === "directive_label";
  if (directive) out.push({ group: BASIC, name: "Shape", type: "enum", choices: FLAG_SHAPES, get: (x) => h.str((h.kid(x.node, "shape") || [])[1] || "round"), set: (n, v) => { h.setKid(n, "shape", [String(v)], ["at", "fields_autoplaced", "effects", "uuid"]); } },
    { group: BASIC, name: "Pin length", type: "length", get: (x) => h.num((h.kid(x.node, "length") || [])[1], 2.54), set: (n, v) => { if (!((v as number) >= 0)) return false; h.setKid(n, "length", [r6(v as number)], ["shape", "at", "fields_autoplaced", "effects", "uuid"]); } });
  else out.push({ group: BASIC, name: "Text", type: k === "text" || k === "text_box" ? "longtext" : "text", get: (x) => h.str(x.node[1]), set: (n, v) => { h.setText(n, String(v)); } });
  out.push({ group: BASIC, name: "Orientation", type: "enum", choices: ORIENT4, get: (x) => String(h.deg360(K().atOf(x.node)[2])), set: (n, v) => { const [x, y] = K().atOf(n); K().setAt(n, x, y, +(v as string)); } });
  out.push({ group: T, name: "Text Size", type: "length", get: (x) => h.textSize(x.node), set: (n, v) => { if (!((v as number) > 0)) return false; h.setTextSize(n, v as number); } });
  if (!directive) out.push(fontFlag(T, "Bold", "bold"), fontFlag(T, "Italic", "italic"));
  if (k === "text") out.push(...justifyProps(T));
  return out;
}
function schShapeProps(it: KItem): PropDef[] {
  const S = "Shape Properties", out: PropDef[] = [];
  if (it.kind === "rectangle") out.push(xyProp(S, "Start X", "start", 1), xyProp(S, "Start Y", "start", 2), xyProp(S, "End X", "end", 1), xyProp(S, "End Y", "end", 2));
  if (it.kind === "circle") out.push(xyProp(S, "Center X", "center", 1), xyProp(S, "Center Y", "center", 2), xyProp(S, "Radius", "radius", 1, "length"));
  out.push(...strokeProps(S, "Line Style", true));
  return out;
}
function schProps(it: KItem, doc: KDoc): PropDef[] {
  const h = H();
  switch (it.kind) {
    case "symbol": return symbolProps(it, doc);
    case "wire": case "bus": case "polyline": return schLineProps(it);
    case "label": case "global_label": case "hierarchical_label": case "netclass_flag": case "directive_label": case "text": case "text_box": return schTextProps(it);
    case "junction": return [atProp("Position X", 1), atProp("Position Y", 2),
      { group: BASIC, name: "Diameter", type: "length", get: (x) => h.num((h.kid(x.node, "diameter") || [])[1], 0), set: (n, v) => { h.setDiameter(n, Math.max(0, v as number)); } },
      // SCH_JUNCTION_DESC: Diameter, Color (the junction's own (color r g b a); "" is UNSPECIFIED: the netclass or layer colour)
      colorProp(BASIC, "Color", (n) => h.kid(n, "color"), (n, c) => { h.setKid(n, "color", c, ["uuid", "tstamp"]); })];
    case "no_connect": return [atProp("Position X", 1), atProp("Position Y", 2)];
    case "bus_entry": return [atProp("Position X", 1), atProp("Position Y", 2), ...strokeProps(BASIC, "Wire Style", true)];
    case "sheet": {
      const fld = (name: string, label: string, ro: boolean): PropDef => ({ group: "Fields", name: label, type: "text", get: (x) => { const p = h.kids(x.node, "property").find((q) => h.str(q[1]) === name); return p ? h.str(p[2]) : null; }, set: ro ? undefined : (n, v) => { h.setField(n, name, String(v)); } });
      const user = h.kids(it.node, "property").map((p) => h.str(p[1])).filter((nm) => !SHEET_MANDATORY.includes(nm))
        .map((nm): PropDef => Object.assign(fld(nm, nm, false), { key: "field" as const },
          // SCH_SHEET_FIELD_PROPERTY: the Reference Suffix field's validator (GetFieldValidationErrorMessage( SHEET_REF_SUFFIX ))
          nm === REF_SUFFIX_FIELD ? { validate: (v: Raw) => fieldValidationError("SHEET_REF_SUFFIX", String(v === null ? "" : v)) } : {}));
      // SCH_SHEET_DESC: Sheet Name (validated: GetFieldValidationErrorMessage( FIELD_T::SHEET_NAME )), Full Suffix (read
      // only, shown when the sheet has one), Border Width, Border Color, Background Color
      const name: PropDef = Object.assign(fld("Sheetname", "Sheet Name", false), { validate: (v: Raw) => fieldValidationError("SHEET_NAME", String(v === null ? "" : v)) });
      return [atProp("Position X", 1), atProp("Position Y", 2), name, fld("Sheetfile", "Sheet File", true), ...user,
        ...(sheetFullSuffix(it.node) ? [{ group: BASIC, name: "Full Suffix", type: "text", get: (x: KItem) => sheetFullSuffix(x.node) } satisfies PropDef] : []),
        { group: BASIC, name: "Border Width", type: "length", get: (x) => h.strokeWidth(x.node), set: (n, v) => { h.setStrokeWidth(n, Math.max(0, v as number)); } },
        colorProp(BASIC, "Border Color", (n) => { const s = strokeOf(n); return s ? h.kid(s, "color") : null; },
          (n, c) => { let s = strokeOf(n); if (!s) s = h.setKid(n, "stroke", [["width", 0], ["type", "solid"]], ["fill", "uuid", "tstamp"]); h.setKid(s, "color", c); }),
        colorProp(BASIC, "Background Color", (n) => { const f = h.kid(n, "fill"); return f ? h.kid(f, "color") : null; },
          (n, c) => { let f = h.kid(n, "fill"); if (!f) f = h.setKid(n, "fill", [], ["uuid", "tstamp", "property"]); h.setKid(f, "color", c); }),
        flag("Attributes", "Exclude From Simulation", "exclude_from_sim", false, false), flag("Attributes", "Exclude From Bill of Materials", "in_bom", true, true),
        flag("Attributes", "Exclude From Board", "on_board", true, true), flag("Attributes", "Do not Populate", "dnp", false, false)];
    }
    case "rectangle": case "circle": case "arc": case "bezier": case "rule_area": return schShapeProps(it);
    default: {
      const out: PropDef[] = [];
      if (h.kid(it.node, "at")) out.push(atProp("Position X", 1), atProp("Position Y", 2));
      if (h.kid(it.node, "stroke")) out.push(...strokeProps(BASIC, "Line Style", false));
      return out;
    }
  }
}

// ---------------------------------------------------------------- board items
function layerChoices(doc: KDoc, copperOnly: boolean): [string, string][] { return H().boardLayers(doc, copperOnly).map((l) => [l, layerDisplayName(doc, l)]); }
function lockedProp(): PropDef {
  return { group: BASIC, name: "Locked", type: "bool", get: (it) => { const P = pcbTools(); return P ? P.isLocked(it.node) : false; },
    set: (n, v) => { const P = pcbTools(); if (!P || P.isLocked(n) === !!v) return false; P.setLocked(n, !!v); } };
}
function layerProp(doc: KDoc, copperOnly: boolean, def: string): PropDef {
  return { group: BASIC, name: "Layer", type: "enum", choices: layerChoices(doc, copperOnly), get: (it) => H().str((H().kid(it.node, "layer") || [])[1] || def), set: (n, v) => { H().setLayer(n, String(v)); } };
}
/** BOARD_DESIGN_SETTINGS::m_TrackWidthList past its netclass entry: Board Setup's predefined track widths (mm). */
function trackWidthList(): number[] {
  const K = (window as unknown as { KiCadCanvas?: { pcbSizes?: { state?: { sizes?: { trackWidths?: number[] } } } } }).KiCadCanvas;
  const tw = K && K.pcbSizes && K.pcbSizes.state && K.pcbSizes.state.sizes ? K.pcbSizes.state.sizes.trackWidths || [] : [];
  return tw.slice(1).filter((w) => w > 0);
}
function netProps(doc: KDoc): PropDef[] {
  // BOARD_CONNECTED_ITEM's "Net" is a net selector: the board's nets, <no net> first
  const nets: [string, string][] = [["", "<no net>"], ...H().boardNetNames(doc).filter(Boolean).map((n): [string, string] => [n, unescapeString(n)])];   // pcb_track.cpp: UnescapeString( GetNetname() )
  // registered with no group (Basic Properties); "Net Class" is hidden from the properties manager
  return [{ group: BASIC, name: "Net", type: "enum", choices: nets, get: (it) => H().netNameOf(doc, it.node) || "",
    set: (n, v) => { if (H().netNameOf(doc, n) === String(v || "")) return false; setNet(doc, n, String(v || "")); } }];
}
// ---------------------------------------------------------------- validators (include/properties/property_validators.h)
const lenText = (mm: number): string => H().formatLength(mm, String(E.units || "mm"));
/** VALIDATION_ERROR_TOO_SMALL / TOO_LARGE::Format */
const tooSmall = (min: number, unitless?: boolean): string => `Value must be greater than or equal to ${unitless ? trimNum(min, 6) : lenText(min)}`;
const tooLarge = (max: number, unitless?: boolean): string => `Value must be less than or equal to ${unitless ? trimNum(max, 6) : lenText(max)}`;
/** PROPERTY_VALIDATORS::PositiveIntValidator: no value (std::optional) is always valid */
const positiveInt = (v: Raw): string | null => (v === null || v === undefined ? null : (v as number) < 0 ? tooSmall(0) : null);
/** PROPERTY_VALIDATORS::RangeIntValidator<Min, Max> (mm; max Infinity for INT_MAX) */
const rangeInt = (min: number, max: number) => (v: Raw): string | null => (v === null || v === undefined ? null : (v as number) > max ? tooLarge(max) : (v as number) < min ? tooSmall(min) : null);
/** PROPERTY_VALIDATORS::PositiveRatioValidator */
const positiveRatio = (v: Raw): string | null => ((v as number) > 1 ? tooLarge(1, true) : (v as number) < 0 ? tooSmall(0, true) : null);
const ZONE_CONNECTION: [string, string][] = [["", "Inherited"], ["0", "None"], ["1", "Thermal reliefs"], ["2", "Solid"], ["3", "Thermal reliefs for PTH"]];
/** A copper layer on the outside of the board (IsExternalCopperLayer). */
const isExternalCu = (l: string): boolean => l === "F.Cu" || l === "B.Cu";
/** The layers of a track / copper shape: (layers "F.Cu" "F.Mask") with a solder mask opening, else (layer "F.Cu"). */
function itemLayers(n: SNode): string[] { const h = H(); const l = h.kid(n, "layers"); if (l) return l.slice(1).map((x) => h.str(x)); const s = h.kid(n, "layer"); return s ? [h.str(s[1])] : []; }
const itemCopper = (n: SNode): string => { const ls = itemLayers(n); return ls.find((l) => /\.Cu$/.test(l)) || ls[0] || ""; };
/** "Technical Layers" of a track or a copper graphic on an outer layer (pcb_track.cpp, pcb_shape.cpp): Soldermask, Soldermask Margin Override. */
function techLayerProps(): PropDef[] {
  const h = H(), TL = "Technical Layers"; const ext = (x: KItem) => isExternalCu(itemCopper(x.node));
  return [
    { group: TL, name: "Soldermask", type: "bool", avail: ext, get: (x) => itemLayers(x.node).some((l) => /\.Mask$/.test(l)),
      set: (n, v) => { const cu = itemCopper(n); if (!isExternalCu(cu)) return false; const keep = h.kid(n, "layer") || h.kid(n, "layers"); const extra = keep ? keep.slice(1).filter((t) => typeof t === "string" && !/\.(Cu|Mask)$/.test(t) && t !== cu) : [];
        h.delKid(n, "layer"); h.delKid(n, "layers"); h.setKid(n, v ? "layers" : "layer", v ? [cu, cu === "F.Cu" ? "F.Mask" : "B.Mask"] : [cu, ...extra], ["solder_mask_margin", "net", "uuid", "tstamp"]); } },
    { group: TL, name: "Soldermask Margin Override", type: "length", optional: true, avail: ext, get: (x) => { const c = h.kid(x.node, "solder_mask_margin"); return c ? h.num(c[1]) : null; },
      set: (n, v) => { if (v === null || v === undefined) h.delKid(n, "solder_mask_margin"); else h.setKid(n, "solder_mask_margin", [r6(v as number)], ["net", "uuid", "tstamp"]); } },
  ];
}
/** A track's Layer (BOARD_CONNECTED_ITEM's, copper only): the copper layer of (layer …) or (layers copper mask). */
function trackLayerProp(doc: KDoc): PropDef {
  const h = H();
  return { group: BASIC, name: "Layer", type: "enum", choices: layerChoices(doc, true), get: (it) => itemCopper(it.node) || "F.Cu",
    set: (n, v) => { const mask = itemLayers(n).some((l) => /\.Mask$/.test(l)), L = String(v);
      if (!h.kid(n, "layers")) { h.setLayer(n, L); return; }
      h.delKid(n, "layers");   // the mask opening follows an outer layer; an inner layer has none
      if (mask && isExternalCu(L)) h.setKid(n, "layers", [L, L === "F.Cu" ? "F.Mask" : "B.Mask"], ["solder_mask_margin", "net", "uuid", "tstamp"]);
      else { h.setKid(n, "layer", [L], ["solder_mask_margin", "net", "uuid", "tstamp"]); h.delKid(n, "solder_mask_margin"); } } };
}
/** BOARD_CONNECTED_ITEM's "Teardrops" group (a pad or a via of a board without legacy teardrops); `at` finds the pad / via in a cloned node. */
function teardropDefs(doc: KDoc, at: (n: SNode) => SNode | null, via: boolean): PropDef[] {
  if ((doc as unknown as { legacyTeardrops?: boolean }).legacyTeardrops) return [];
  const G = "Teardrops";
  type Td = { enabled: boolean; twoSegments: boolean; preferZone: boolean; maxLen: number; maxWidth: number; lenRatio: number; widthRatio: number; filterRatio: number; curved: boolean };
  type PMApi = { readTeardrops(n: SNode): Td; formatTeardrops(t: Td): string; setPadChild(pad: SNode, key: string, text: string | null): void; TD_DEFAULTS: Td };
  const PMo = (): PMApi => (K() as unknown as { padModel: PMApi }).padModel;
  const read = (x: KItem): Td | null => { const n = at(x.node); return n ? PMo().readTeardrops(n) : null; };
  const same = (a: Td, b: Td) => (Object.keys(b) as (keyof Td)[]).every((k) => (typeof a[k] === "number" ? Math.abs((a[k] as number) - (b[k] as number)) < 1e-9 : a[k] === b[k]));
  const write = (root: SNode, patch: Partial<Td>): boolean => {
    const n = at(root); if (!n) return false; const td = Object.assign(PMo().readTeardrops(n), patch);
    const text = same(td, PMo().TD_DEFAULTS) ? null : PMo().formatTeardrops(td);   // the writer leaves default parameters out
    if (via) TV.setChild(n, "teardrops", text, TV.VIA_ORDER, (t: string) => K().parse(t) as SNode); else PMo().setPadChild(n, "teardrops", text);
    return true;
  };
  const row = (name: string, key: keyof Td, type: PropType, validate?: (v: Raw) => string | null): PropDef => ({ group: G, name, type, validate,
    get: (x) => { const t = read(x); return t ? (t[key] as Raw) : null; }, set: (n, v) => write(n, { [key]: type === "bool" ? !!v : (v as number) } as Partial<Td>) });
  const out = [row("Enable Teardrops", "enabled", "bool"), row("Best Length Ratio", "lenRatio", "number", positiveRatio), row("Max Length", "maxLen", "length"),
    row("Best Width Ratio", "widthRatio", "number", positiveRatio), row("Max Width", "maxWidth", "length"), row("Curved Teardrops", "curved", "bool")];
  if (!via) out.push(row("Prefer Zone Connections", "preferZone", "bool"));
  out.push(row("Allow Teardrops To Span Two Tracks", "twoSegments", "bool"), row("Max Width Ratio", "filterRatio", "number"));
  return out;
}
const FP_TYPES: [string, string][] = [["through_hole", "Through hole"], ["smd", "SMD"], ["", "Unspecified"]];
const PAD_TYPES: [string, string][] = [["thru_hole", "Through-hole"], ["smd", "SMD"], ["connect", "Edge connector"], ["np_thru_hole", "NPTH, mechanical"], ["non_component", "Non-component"]];
const PAD_DRILL_SHAPES: [string, string][] = [["circle", "Round"], ["oval", "Oblong"]];
const PAD_SIM_TYPES: [string, string][] = [["", "None"], ["source", "Source"], ["sink", "Sink"]];
const PAD_FAB_PROPS: [string, string][] = [["", "None"], ["pad_prop_bga", "BGA pad"], ["pad_prop_fiducial_glob", "Fiducial, global to board"], ["pad_prop_fiducial_loc", "Fiducial, local to footprint"], ["pad_prop_testpoint", "Test point pad"], ["pad_prop_heatsink", "Heatsink pad"], ["pad_prop_castellated", "Castellated pad"], ["pad_prop_mechanical", "Mechanical pad"], ["pad_prop_pressfit", "Press-fit pad"]];
const PAD_ZONE_CONNECT: [string, string][] = [["", "Inherited"], ["0", "None"], ["1", "Thermal reliefs"], ["2", "Solid"], ["3", "Thermal reliefs for PTH"]];
const PAD_SHAPES: [string, string][] = [["circle", "Circle"], ["rect", "Rectangle"], ["oval", "Oval"], ["trapezoid", "Trapezoid"], ["roundrect", "Rounded rectangle"], ["chamfered_rect", "Chamfered rectangle"], ["custom", "Custom"]];
const PIN_TYPES: [string, string][] = ["input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect"].map((t): [string, string] => [t, t]);   // GetCanonicalElectricalTypeName
const PAD_UNCONNECTED: [string, string][] = [["keep_all", "All copper layers"], ["remove_all", "Connected layers only"], ["remove_except_start_end", "Front, back and connected layers"], ["start_end_only", "Start and end layers only"]];
const PAD_POST_MACHINING: [string, string][] = [["none", "Not post-machined"], ["counterbore", "Counterbore"], ["countersink", "Countersink"]];
const PAD_BACKDRILL: [string, string][] = [["none", "No backdrill"], ["bottom", "Backdrill bottom"], ["top", "Backdrill top"], ["both", "Backdrill both"]];
const PM = "Post-machining Properties", BD = "Backdrill Properties";
const padIndexOf = new Map<string, number>();   // footprint id -> the pad the Pad Properties rows show

/** FIELD_T's mandatory footprint fields (PCB_FIELD::IsMandatory): never renamed or removed from the panel. */
const FP_MANDATORY = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
/** SCH_FIELD::IsMandatory of a symbol (the same five FIELD_Ts) and of a sheet (SHEET_NAME, SHEET_FILENAME). */
const SYM_MANDATORY = FP_MANDATORY, SHEET_MANDATORY = ["Sheetname", "Sheetfile"];
/** The fields of a footprint / symbol / sheet node the panel may rename or remove (isKeyEditable), or null for an item without them. */
function mandatoryOf(n: SNode): string[] | null { return n[0] === "footprint" ? FP_MANDATORY : n[0] === "symbol" ? SYM_MANDATORY : n[0] === "sheet" ? SHEET_MANDATORY : null; }
/** A field written (property private "Name" …) (PCB_FIELD::IsPrivate). */
function privateField(n: SNode, name: string): boolean { const h = H(); return h.kids(n, "property").some((p) => p[1] === "private" && h.str(p[2]) === name); }

// ---------------------------------------------------------------- custom properties (EDA_ITEM::m_customProperties)
// (custom_property "key" "value") children, last in the item (KICAD_FORMAT::FormatCustomProperties), in key order
// (std::map); EDA_CUSTOM_PROPERTY puts each in the "Custom Properties" group.
export const CUSTOM_GROUP = "Custom Properties";
export function customProps(n: SNode): [string, string][] { const h = H(); return h.kids(n, "custom_property").map((p): [string, string] => [h.str(p[1]), h.str(p[2])]); }
/** EDA_ITEM::SetCustomProperty: replace the value of `key`, or insert it in key order after the item's other children. */
export function setCustomProp(n: SNode, key: string, value: string): void {
  const h = H(); const all = h.kids(n, "custom_property");
  const at = all.find((p) => h.str(p[1]) === key); if (at) { at[2] = value; return; }
  const next = all.find((p) => h.str(p[1]) > key);
  const node: SNode = ["custom_property", key, value];
  if (next) n.splice(n.indexOf(next), 0, node);
  else if (all.length) n.splice(n.indexOf(all[all.length - 1]!) + 1, 0, node);
  else n.push(node);
}
/** EDA_ITEM::RemoveCustomProperty. */
export function removeCustomProp(n: SNode, key: string): boolean {
  const h = H(); const i = n.findIndex((c) => Array.isArray(c) && c[0] === "custom_property" && h.str(c[1]) === key);
  if (i < 0) return false; n.splice(i, 1); return true;
}
function customPropDefs(it: KItem): PropDef[] {
  return customProps(it.node).map(([key]): PropDef => ({ group: CUSTOM_GROUP, name: key, type: "text", key: "custom",
    get: (x) => { const kv = customProps(x.node).find((q) => q[0] === key); return kv ? kv[1] : null; },
    set: (n, v) => { setCustomProp(n, key, String(v)); } }));
}

function footprintProps(it: KItem, doc: KDoc, single: boolean): PropDef[] {
  const h = H();
  const attr = (name: string, key: string): PropDef => ({ group: "Attributes", name, type: "bool", get: (x) => !!h.footprintAttrs(x.node)[key], set: (n, v) => { h.setFootprintAttrs(n, { [key]: !!v }); } });
  // PROPERTY<FOOTPRINT, std::optional<int>>: empty is no override, 0 an override of 0 (the writer prints it)
  const over = (name: string, key: string, before: string[]): PropDef => ({ group: "Overrides", name, type: "length", optional: true, get: (x) => { const k = h.kid(x.node, key); return k ? h.num(k[1]) : null; },
    set: (n, v) => { if (v !== null && v !== undefined) h.setKid(n, key, [r6(v as number)], before); else h.delKid(n, key); } });
  const out: PropDef[] = [
    { group: BASIC, name: "Position X", type: "coord", get: (x) => K().atOf(x.node)[0], set: (n, v) => { h.setFootprintPosition(n, v as number, K().atOf(n)[1]); } },
    { group: BASIC, name: "Position Y", type: "coord", get: (x) => K().atOf(x.node)[1], set: (n, v) => { h.setFootprintPosition(n, K().atOf(n)[0], v as number); } },
    lockedProp(),
    // FOOTPRINT::SetLayerAndFlip: Flip( GetPosition(), FLIP_DIRECTION::LEFT_RIGHT ), the orientation becomes 180 − θ
    { group: BASIC, name: "Layer", type: "enum", choices: [["F.Cu", layerDisplayName(doc, "F.Cu")], ["B.Cu", layerDisplayName(doc, "B.Cu")]], get: (x) => h.str((h.kid(x.node, "layer") || [])[1] || "F.Cu"), set: (n, v) => h.setFootprintSide(n, String(v), true) },
    { group: BASIC, name: "Orientation", type: "angle", get: (x) => K().atOf(x.node)[2], set: (n, v) => h.setFootprintRotation(n, v as number) },
    // FOOTPRINT::SetScaleX / SetScaleY (SetTransformScale): the (transform … (scale x y)); a zero, negative or
    // non-finite scale is refused.  The file keeps the children unscaled (the writer unbakes them), so only the
    // transform changes; a footprint still placed by (at …) is written with a (transform …) once it is scaled.
    scaleProp("Scale X", 1), scaleProp("Scale Y", 2),
    ...fieldProps(it).map((d) => (FP_MANDATORY.includes(d.name) || privateField(it.node, d.name) ? d : Object.assign(d, { key: "field" as const }))),
    { group: "Footprint Properties", name: "Library Link", type: "text", get: (x) => h.str(x.node[1]) },
    { group: "Footprint Properties", name: "Library Description", type: "text", get: (x) => h.str((h.kid(x.node, "descr") || [])[1]) },
    { group: "Footprint Properties", name: "Keywords", type: "text", get: (x) => h.str((h.kid(x.node, "tags") || [])[1]) },
    // FOOTPRINT::m_height: (height h) after the keywords, left out at 0; boards before 20261017 cannot store it
    { group: "Footprint Properties", name: "Height", type: "length", avail: (x) => !!h.kid(x.node, "height") || !(Number((doc as unknown as { version?: unknown }).version) > 0) || Number((doc as unknown as { version?: unknown }).version) >= 20261017,
      get: (x) => h.num((h.kid(x.node, "height") || [])[1], 0),
      set: (n, v) => { if (v) h.setKid(n, "height", [r6(v as number)], ["property", "component_classes", "path", "sheetname", "sheetfile", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance", "zone_connect", "attr", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "pad", "embedded_fonts", "model"]); else h.delKid(n, "height"); } },
    // COMPONENT_CLASS::GetName of the static class: its constituents' names joined by commas
    { group: "Footprint Properties", name: "Component Class", type: "text", get: (x) => { const c = h.kid(x.node, "component_classes"); return c ? h.kids(c, "class").map((k) => h.str(k[1])).join(",") : ""; } },
    { group: "Attributes", name: "Footprint Type", type: "enum", choices: FP_TYPES, get: (x) => String(h.footprintAttrs(x.node).type || ""), set: (n, v) => { h.setFootprintAttrs(n, { type: String(v) }); } },
    attr("Not in Schematic", "board_only"), attr("Exclude From Position Files", "exclude_from_pos_files"), attr("Exclude From Bill of Materials", "exclude_from_bom"), attr("Exclude From Simulation", "exclude_from_sim"), attr("Do not Populate", "dnp"),
    attr("Exempt From Courtyard Requirement", "allow_missing_courtyard"),
    over("Clearance Override", "clearance", ["zone_connect", "thermal_width", "thermal_gap", "attr", "net_tie_pad_groups", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "pad", "embedded_fonts", "model"]),
    over("Solderpaste Margin Override", "solder_paste_margin", ["solder_paste_margin_ratio", "solder_paste_ratio", "clearance", "zone_connect", "thermal_width", "thermal_gap", "attr", "net_tie_pad_groups", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "pad", "embedded_fonts", "model"]),
    Object.assign(over("Solderpaste Margin Ratio Override", "solder_paste_margin_ratio", ["clearance", "zone_connect", "thermal_width", "thermal_gap", "attr", "net_tie_pad_groups", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "pad", "embedded_fonts", "model"]), { type: "number" as PropType }),
    // ZONE_CONNECTION: INHERITED is no (zone_connect), the others its number
    { group: "Overrides", name: "Zone Connection Style", type: "enum", choices: ZONE_CONNECTION, get: (x) => { const k = h.kid(x.node, "zone_connect"); return k ? String(h.num(k[1])) : ""; },
      set: (n, v) => { if (v === "" || v === null) h.delKid(n, "zone_connect"); else h.setKid(n, "zone_connect", [+(v as string)], ["thermal_width", "thermal_gap", "attr", "net_tie_pad_groups", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "pad", "embedded_fonts", "model"]); } },
  ];
  // the Overrides entries registered with the Attributes group stay where KiCad lists them
  for (const d of out) if (d.name === "Exempt From Courtyard Requirement") d.group = "Overrides";
  if (single) out.push(...padProps(it, doc));
  return out;
}
/** One pad of a single selected footprint (PAD's properties); the "Pad" row picks which. */
function padProps(fp: KItem, doc: KDoc): PropDef[] {
  const h = H(), G = "Pad Properties"; const pads = h.kids(fp.node, "pad"); if (!pads.length) return [];
  let idx = padIndexOf.get(fp.id) || 0; if (idx >= pads.length) idx = 0;
  const picker: PropDef = { group: G, name: "Pad", type: "enum", choices: pads.map((p, i): [string, string] => { const net = h.netNameOf(doc, p); return [String(i), h.str(p[1]) + (net ? " · " + unescapeString(net) : "")]; }), get: () => String(idx), local: (v, x) => { padIndexOf.set(x.id, +(v as string) || 0); } };
  const own = padDefs(doc, idx).filter((d) => (d.group === G || d.group === "Overrides" || d.group === PM || d.group === BD || d.group === "Teardrops") && (!d.avail || d.avail(fp))).map((d) => d.group === "Overrides" ? Object.assign(d, { group: "Pad Overrides" }) : d);
  return [picker, ...own];
}
/** PAD's registered properties (pad.cpp PAD_DESC) for pad `idx` of a footprint item: Basic (position, orientation),
 *  Net, Pad Properties and the clearance / mask / paste Overrides; every setter edits the footprint's (cloned) node. */
function padDefs(doc: KDoc, idx: number): PropDef[] {
  const h = H(), G = "Pad Properties";
  const info = (x: KItem) => { const p = h.padNode(x.node, idx); return p ? h.padInfo(doc, p) : null; };
  const edit = (patch: (v: Raw, n: SNode) => Record<string, unknown>) => (n: SNode, v: Raw) => h.setPad(n, idx, patch(v, n), doc);
  const drillOf = (x: KItem): [number, number] => { const i = info(x); if (!i || !i.drill) return [0, 0]; const p = i.drill.split(/x/i).map(Number); return [p[0] || 0, p.length > 1 ? p[1] || 0 : p[0] || 0]; };
  const nets: [string, string][] = [["", "<no net>"], ...h.boardNetNames(doc).map((n): [string, string] => [n, unescapeString(n)])];
  const tail = ["zone_connect", "thermal_bridge_width", "thermal_bridge_angle", "thermal_gap", "options", "primitives", "teardrops", "tenting", "uuid", "tstamp", "padstack"];
  // the writer's order of a pad's children after (layers …) (PCB_IO_KICAD_SEXPR::format( PAD ))
  const ORDER = ["property", "sim_electrical_type", "layers", "remove_unused_layers", "keep_end_layers", "zone_layer_connections", "roundrect_rratio", "chamfer_ratio", "chamfer", "net", "pinfunction", "pintype", "die_length", "die_delay", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance", ...tail];
  const after = (key: string) => ORDER.slice(ORDER.indexOf(key) + 1);
  const pad = (x: KItem) => h.padNode(x.node, idx);
  const padType = (x: KItem) => { const p = pad(x); return p ? h.str(p[2]) : ""; };
  const isCopper = (x: KItem) => padType(x) !== "np_thru_hole";                           // isCopperPad: not NPTH
  const canHole = (x: KItem) => padType(x) === "thru_hole" || padType(x) === "np_thru_hole";   // padCanHaveHole
  // PAD::SetSizeXProp / SetSizeYProp: not 0 or less; a circle pad takes the value on both axes
  const sizeProp = (n: SNode, v: Raw, axis: "w" | "h") => { if (!((v as number) > 0)) return false; const p = h.padNode(n, idx); if (!p) return false; return h.setPad(n, idx, h.str(p[3]) === "circle" ? { w: v, h: v } : { [axis]: v }, doc); };
  // hasNormalPadstack: no (padstack (mode front_inner_back|custom) …)
  const normalStack = (x: KItem) => { const p = pad(x), ps = p && h.kid(p, "padstack"), m = ps && h.kid(ps, "mode"); return !m || h.str(m[1]) === "normal"; };
  const drillKid = (x: KItem) => { const p = pad(x); return p ? h.kid(p, "drill") : null; };
  const oblong = (x: KItem) => { const d = drillKid(x); return !!d && d.includes("oval"); };
  // PAD_UTILS::PadHasMeaningfulRoundingRadius on the front layer: a rounded (or chamfered) rectangle
  const rounded = (x: KItem) => { const p = pad(x); return !!p && normalStack(x) && (h.str(p[3]) === "roundrect" || h.str(p[3]) === "chamfered_rect"); };
  const rratio = (x: KItem) => { const p = pad(x), k = p && h.kid(p, "roundrect_rratio"); return k ? h.num(k[1]) : 0; };
  const minSide = (x: KItem) => { const i = info(x); return i ? Math.min(i.w, i.h) : 0; };
  const setRatio = (n: SNode, v: number) => { const p = h.padNode(n, idx); if (!p) return false; h.setKid(p, "roundrect_rratio", [r6(Math.max(0, Math.min(0.5, v)))], after("roundrect_rratio")); return true; };
  /** A plain int the writer prints only when it is not 0 (die_length, die_delay): 0 drops (key value). */
  const intKid = (group: string, name: string, key: string, type: PropType, extra?: Partial<PropDef>): PropDef => Object.assign({ group, name, type,
    get: (x: KItem) => { const p = pad(x), k = p && h.kid(p, key); return k ? h.num(k[1]) : 0; },
    set: (n: SNode, v: Raw) => { const p = h.padNode(n, idx); if (!p) return false; if (v) h.setKid(p, key, [r6(v as number)], after(key)); else h.delKid(p, key); } }, extra || {});
  /** PROPERTY<PAD, std::optional<…>>: an empty cell is no override (no (key …)); 0 is an override of 0, written. */
  const optKid = (group: string, name: string, key: string, type: PropType, extra?: Partial<PropDef>): PropDef => Object.assign({ group, name, type, optional: true,
    get: (x: KItem) => { const p = pad(x), k = p && h.kid(p, key); return k ? h.num(k[1]) : null; },
    set: (n: SNode, v: Raw) => { const p = h.padNode(n, idx); if (!p) return false; if (v !== null && v !== undefined) h.setKid(p, key, [r6(v as number)], after(key)); else h.delKid(p, key); } }, extra || {});
  // PAD::GetPosition is the board position: the footprint's position plus the pad's local offset rotated by the footprint
  const padPos = (n: SNode): [number, number] | null => { const p = h.padNode(n, idx); if (!p) return null; const [fx, fy, fr] = K().atOf(n), [lx, ly] = K().atOf(p); const [rx, ry] = padRot(lx, ly, fr); return [fx + rx, fy + ry]; };
  const setPos = (n: SNode, x: number, y: number): boolean => { const p = h.padNode(n, idx), at = p && h.kid(p, "at"); if (!at) return false; const [fx, fy, fr] = K().atOf(n); const [lx, ly] = padRot(x - fx, y - fy, -fr); at[1] = r6(lx); at[2] = r6(ly); return true; };
  return [
    { group: BASIC, name: "Position X", type: "coord", get: (x) => padPos(x.node)?.[0] ?? null, set: (n, v) => { const c = padPos(n); return !!c && setPos(n, v as number, c[1]); } },
    { group: BASIC, name: "Position Y", type: "coord", get: (x) => padPos(x.node)?.[1] ?? null, set: (n, v) => { const c = padPos(n); return !!c && setPos(n, c[0], v as number); } },
    // PAD::GetOrientationDegrees: the board (absolute) angle, the one the pad's (at x y angle) stores
    { group: BASIC, name: "Orientation", type: "angle", get: (x) => { const i = info(x); return i ? h.normDeg(i.rot) : null; }, set: edit((v) => ({ rot: v as number })) },
    { group: BASIC, name: "Net", type: "enum", choices: nets, avail: isCopper, get: (x) => info(x)?.net ?? null, set: edit((v) => ({ net: String(v) })) },
    { group: G, name: "Pad Type", type: "enum", choices: PAD_TYPES, get: (x) => info(x)?.type ?? null, set: edit((v) => ({ type: String(v) })) },
    { group: G, name: "Pad Shape", type: "enum", choices: PAD_SHAPES, avail: normalStack, get: (x) => info(x)?.shape ?? null, set: edit((v) => ({ shape: String(v) })) },
    { group: G, name: "Pad Number", type: "text", avail: isCopper, get: (x) => info(x)?.number ?? null, set: edit((v) => ({ number: String(v) })) },
    { group: G, name: "Pin Name", type: "text", get: (x) => { const p = h.padNode(x.node, idx), k = p && h.kid(p, "pinfunction"); return k ? h.str(k[1]) : ""; },
      set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; if (v) h.setKid(p, "pinfunction", [String(v)], after("pinfunction")); else h.delKid(p, "pinfunction"); } },
    { group: G, name: "Pin Type", type: "enum", choices: PIN_TYPES, get: (x) => { const p = h.padNode(x.node, idx), k = p && h.kid(p, "pintype"); return k ? h.str(k[1]) : ""; },
      set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; if (v) h.setKid(p, "pintype", [String(v)], after("pintype")); else h.delKid(p, "pintype"); } },
    { group: G, name: "Simulation Electrical Type", type: "enum", choices: PAD_SIM_TYPES, get: (x) => { const p = pad(x), k = p && h.kid(p, "sim_electrical_type"); return k ? h.str(k[1]) : ""; },
      set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; if (v) h.setKid(p, "sim_electrical_type", [String(v)], after("sim_electrical_type")); else h.delKid(p, "sim_electrical_type"); } },
    { group: G, name: "Size X", type: "length", avail: normalStack, get: (x) => info(x)?.w ?? null, set: (n, v) => sizeProp(n, v, "w") },
    // circle pads have no usable Y size
    { group: G, name: "Size Y", type: "length", avail: (x) => normalStack(x) && h.str(pad(x)?.[3]) !== "circle", get: (x) => info(x)?.h ?? null, set: (n, v) => sizeProp(n, v, "h") },
    { group: G, name: "Corner Radius Ratio", type: "number", avail: rounded, get: (x) => rratio(x), set: (n, v) => setRatio(n, v as number) },
    { group: G, name: "Corner Radius Size", type: "length", avail: rounded, get: (x) => r6(rratio(x) * minSide(x)),
      set: (n, v, it) => { const m = minSide(Object.assign({}, it, { node: n })); return m > 0 && setRatio(n, (v as number) / m); } },
    // PAD::SetDrillShape: (drill oval x y) for an oblong hole, (drill d) for a round one
    { group: G, name: "Hole Shape", type: "enum", choices: PAD_DRILL_SHAPES, canWrite: canHole, get: (x) => (oblong(x) ? "oval" : "circle"),
      set: (n, v) => { const p = h.padNode(n, idx), d = p && h.kid(p, "drill"); if (!d) return false; const i = d.indexOf("oval"); if (v === "oval") { if (i < 0) d.splice(1, 0, "oval"); } else if (i > 0) { d.splice(i, 1); const sz = d.slice(1).filter((t) => typeof t === "number"); if (sz.length > 1) d.splice(d.indexOf(sz[1]), 1); } } },
    // PAD::SetDrillSizeXProp / SetDrillSizeYProp: only the size changes; an oblong hole stays oblong when X equals Y
    { group: G, name: "Hole Size X", type: "length", canWrite: canHole, validate: positiveInt, get: (x) => drillOf(x)[0], set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; const dk = h.kid(p, "drill"), ob = !!dk && dk.includes("oval"); const d = h.padInfo(doc, p).drill.split(/x/i).map(Number); return h.setPad(n, idx, ob ? { drill: [v as number, d.length > 1 ? d[1] : (v as number)], drillShape: "oval" } : { drill: [v as number, v as number] }, doc); } },
    { group: G, name: "Hole Size Y", type: "length", canWrite: canHole, avail: oblong, validate: positiveInt, get: (x) => drillOf(x)[1], set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; const d = h.padInfo(doc, p).drill.split(/x/i).map(Number); return h.setPad(n, idx, { drill: [d[0] || 0, v as number], drillShape: "oval" }, doc); } },
    { group: G, name: "Fabrication Property", type: "enum", choices: PAD_FAB_PROPS, get: (x) => { const p = pad(x), k = p && h.kid(p, "property"); return k ? h.str(k[1]) : ""; },
      set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; if (v) h.setKid(p, "property", [String(v)], after("property")); else h.delKid(p, "property"); } },
    // UNCONNECTED_LAYER_MODE: the writer keeps (remove_unused_layers) / (keep_end_layers) for a PTH pad only
    { group: G, name: "Copper Layers", type: "enum", choices: PAD_UNCONNECTED, get: (x) => { const p = pad(x); return p ? unconnectedMode(p) : null; },
      set: (n, v) => { const p = h.padNode(n, idx); if (!p || h.str(p[2]) !== "thru_hole") return false; setUnconnectedMode(p, String(v)); } },
    intKid(G, "Pad To Die Length", "die_length", "length", { avail: isCopper }),
    intKid(G, "Pad To Die Delay", "die_delay", "time", { avail: isCopper }),
    ...postMachiningDefs(doc, idx, "Top", "front_post_machining"),
    ...postMachiningDefs(doc, idx, "Bottom", "back_post_machining"),
    ...backdrillDefs(doc, idx),
    optKid("Overrides", "Clearance Override", "clearance", "length"),
    { group: "Overrides", name: "Soldermask Margin Override", type: "length", optional: true, get: (x) => info(x)?.maskMargin ?? null, set: edit((v) => ({ maskMargin: v === undefined ? null : v })) },
    { group: "Overrides", name: "Solderpaste Margin Override", type: "length", optional: true, get: (x) => info(x)?.pasteMargin ?? null, set: edit((v) => ({ pasteMargin: v === undefined ? null : v })) },
    optKid("Overrides", "Solderpaste Margin Ratio Override", "solder_paste_margin_ratio", "number"),
    // ZONE_CONNECTION: INHERITED is no (zone_connect), the others its number
    { group: "Overrides", name: "Zone Connection Style", type: "enum", choices: PAD_ZONE_CONNECT, get: (x) => { const p = pad(x), k = p && h.kid(p, "zone_connect"); return k ? String(h.num(k[1])) : ""; },
      set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; if (v === "" || v === null) h.delKid(p, "zone_connect"); else h.setKid(p, "zone_connect", [+(v as string)], after("zone_connect")); } },
    optKid("Overrides", "Thermal Relief Spoke Width", "thermal_bridge_width", "length", { validate: rangeInt(0.025, Infinity) }),   // RangeIntValidator<minZoneWidth, INT_MAX>
    // PADSTACK::ThermalSpokeAngle: the stored angle, else DefaultThermalSpokeAngleForShape (45° for a circle, else 90°);
    // the writer leaves the default out
    { group: "Overrides", name: "Thermal Relief Spoke Angle", type: "angle", get: (x) => { const p = pad(x), k = p && h.kid(p, "thermal_bridge_angle"); return k ? h.num(k[1]) : (p && h.str(p[3]) === "circle" ? 45 : 90); },
      set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; const def = h.str(p[3]) === "circle" ? 45 : 90; const a = h.deg360(v as number); if (a === def) h.delKid(p, "thermal_bridge_angle"); else h.setKid(p, "thermal_bridge_angle", [r6(a)], after("thermal_bridge_angle")); } },
    optKid("Overrides", "Thermal Relief Gap", "thermal_gap", "length", { validate: positiveInt }),
    ...teardropDefs(doc, (n) => h.padNode(n, idx), false),
  ];
}
// the children of (pad …) in the writer's order (PCB_IO_KICAD_SEXPR::format( PAD )), so a new one lands in its place
const PAD_CHILD_ORDER = ["at", "size", "rect_delta", "drill", "backdrill", "tertiary_drill", "front_post_machining", "back_post_machining", "property", "sim_electrical_type",
  "layers", "remove_unused_layers", "keep_end_layers", "zone_layer_connections", "roundrect_rratio", "chamfer_ratio", "chamfer", "net", "pinfunction", "pintype", "die_length",
  "die_delay", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance", "zone_connect", "thermal_bridge_width", "thermal_bridge_angle", "thermal_gap",
  "options", "primitives", "teardrops", "tenting", "uuid", "tstamp", "padstack"];
const padAfter = (key: string) => PAD_CHILD_ORDER.slice(PAD_CHILD_ORDER.indexOf(key) + 1);
/** PAD::GetUnconnectedLayerMode from (remove_unused_layers) and (keep_end_layers). */
function unconnectedMode(p: SNode): string {
  const h = H(); const flag = (key: string) => { const k = h.kid(p, key); return k ? h.str(k[1]) !== "no" : p.includes(key); };
  if (!flag("remove_unused_layers")) return "keep_all";
  return flag("keep_end_layers") ? "remove_except_start_end" : "remove_all";
}
/** PAD::SetUnconnectedLayerMode as the writer saves it: START_END_ONLY has no token of its own for a pad and is
 *  written like REMOVE_ALL (GetRemoveUnconnected true, GetKeepTopBottom false). */
function setUnconnectedMode(p: SNode, mode: string): void {
  const h = H(); const remove = mode !== "keep_all";
  h.setKid(p, "remove_unused_layers", [remove ? "yes" : "no"], padAfter("remove_unused_layers"));
  if (!remove) { h.delKid(p, "keep_end_layers"); h.delKid(p, "zone_layer_connections"); return; }
  h.setKid(p, "keep_end_layers", [mode === "remove_except_start_end" ? "yes" : "no"], padAfter("keep_end_layers"));
  if (!h.kid(p, "zone_layer_connections")) h.setKid(p, "zone_layer_connections", [], padAfter("zone_layer_connections"));
}
const isRoundDrill = (p: SNode | null) => { const d = p && H().kid(p, "drill"); return !d || !d.includes("oval"); };   // GetDrillShape() == CIRCLE
/** The "Post-machining Properties" rows of one side (PADSTACK::FrontPostMachining / BackPostMachining):
 *  (front_post_machining counterbore|countersink (size s) (depth d) (angle a)), left out when not post-machined. */
function postMachiningDefs(doc: KDoc, idx: number, side: "Top" | "Bottom", key: string): PropDef[] {
  const h = H(); void doc;
  const pad = (x: KItem) => h.padNode(x.node, idx);
  const canHole = (x: KItem) => { const p = pad(x), t = p ? h.str(p[2]) : ""; return t === "thru_hole" || t === "np_thru_hole"; };
  const node = (p: SNode | null) => (p ? h.kid(p, key) : null);
  const mode = (x: KItem) => { const k = node(pad(x)); return k ? h.str(k[1]) : "none"; };
  const round = (x: KItem) => isRoundDrill(pad(x));
  const sub = (name: string, sk: string, type: PropType, show: (m: string) => boolean, before: string[]): PropDef => ({ group: PM, name, type, canWrite: canHole,
    avail: (x) => round(x) && show(mode(x)),
    get: (x) => { const k = node(pad(x)), v = k && h.kid(k, sk); return v ? h.num(v[1]) : 0; },
    // the writer prints each only when it is above 0
    set: (n, v) => { const k = node(h.padNode(n, idx)); if (!k) return false; if ((v as number) > 0) h.setKid(k, sk, [r6(v as number)], before); else h.delKid(k, sk); } });
  return [
    { group: PM, name: `${side} Post-machining`, type: "enum", choices: PAD_POST_MACHINING, canWrite: canHole, avail: round, get: mode,
      set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; const k = node(p);
        if (v === "none") { if (!k) return false; h.delKid(p, key); return; }
        if (k) k[1] = String(v); else h.setKid(p, key, [String(v)], padAfter(key)); } },
    sub(`${side} Post-machining Size`, "size", "length", (m) => m === "counterbore" || m === "countersink", ["depth", "angle"]),
    sub(`${side} Counterbore Depth`, "depth", "length", (m) => m === "counterbore", ["angle"]),
    sub(`${side} Countersink Angle`, "angle", "angle", (m) => m === "countersink", []),
  ];
}
/** The "Backdrill Properties" rows (PADSTACK::GetBackdrillMode & co.): a backdrill is a (backdrill …) or
 *  (tertiary_drill …) child, (size s) (layers start must-cut), whose start layer is its side (F.Cu top, B.Cu bottom). */
function backdrillDefs(doc: KDoc, idx: number): PropDef[] {
  const h = H(); const cu = layerChoices(doc, true);
  const pad = (x: KItem) => h.padNode(x.node, idx);
  const SLOTS = ["backdrill", "tertiary_drill"];
  const sizeOf = (k: SNode) => { const z = h.kid(k, "size"); return z ? h.num(z[1]) : 0; };
  const startOf = (k: SNode) => { const l = h.kid(k, "layers"); return l ? h.str(l[1]) : ""; };
  const endOf = (k: SNode) => { const l = h.kid(k, "layers"); return l && l.length > 2 ? h.str(l[2]) : ""; };
  const sideLayer = (top: boolean) => (top ? "F.Cu" : "B.Cu");
  /** findBackdrillDrill */
  const find = (p: SNode | null, top: boolean): SNode | null => { if (!p) return null; for (const key of SLOTS) { const k = h.kid(p, key); if (k && sizeOf(k) > 0 && startOf(k) === sideLayer(top)) return k; } return null; };
  /** backdrillWriteSlot: the side's drill, else its home slot (backdrill for the top, tertiary_drill for the bottom)
   *  unless the other side holds it */
  const slotKey = (p: SNode, top: boolean): string => {
    const home = top ? "backdrill" : "tertiary_drill", other = top ? "tertiary_drill" : "backdrill", k = h.kid(p, home);
    return k && sizeOf(k) > 0 && startOf(k) === sideLayer(!top) ? other : home;
  };
  const write = (p: SNode, top: boolean, size: number, end: string) => {
    const k = find(p, top), key = k ? (k[0] as string) : slotKey(p, top);
    h.setKid(p, key, [["size", r6(size)], ["layers", sideLayer(top), end || sideLayer(top)]], padAfter(key));
  };
  /** clearBackdrillSide: the writer leaves out a drill of size 0 */
  const clear = (p: SNode, top: boolean) => { for (const key of SLOTS) { const k = h.kid(p, key); if (k && startOf(k) === sideLayer(top)) h.delKid(p, key); } };
  const drill = (p: SNode) => { const d = h.kid(p, "drill"); if (!d) return 0; const v = d.slice(1).find((t) => typeof t === "number"); return typeof v === "number" ? v : 0; };
  const mode = (x: KItem) => { const p = pad(x), t = !!find(p, true), b = !!find(p, false); return t && b ? "both" : t ? "top" : b ? "bottom" : "none"; };
  const has = (top: boolean) => (x: KItem) => { if (!isRoundDrill(pad(x))) return false; const m = mode(x); return m === "both" || m === (top ? "top" : "bottom"); };
  const sizeRow = (top: boolean): PropDef => ({ group: BD, name: `${top ? "Top" : "Bottom"} Backdrill Size`, type: "length", optional: true, avail: has(top),
    get: (x) => { const k = find(pad(x), top); return k ? sizeOf(k) : null; },
    set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; if (v === null || v === undefined || !((v as number) > 0)) { clear(p, top); return; } const k = find(p, top); write(p, top, v as number, k ? endOf(k) : ""); } });
  const cutRow = (top: boolean): PropDef => ({ group: BD, name: `${top ? "Top" : "Bottom"} Backdrill Must-Cut`, type: "enum", choices: cu, avail: has(top),
    get: (x) => { const k = find(pad(x), top); return k ? endOf(k) : null; },
    set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false; const k = find(p, top); if (!k) return false; write(p, top, sizeOf(k), String(v)); } });
  return [
    { group: BD, name: "Backdrill Mode", type: "enum", choices: PAD_BACKDRILL, get: mode,
      // PADSTACK::SetBackdrillMode: a new side starts on its own copper layer, 1.1 × the hole
      set: (n, v) => { const p = h.padNode(n, idx); if (!p) return false;
        for (const top of [true, false]) {
          const want = v === "both" || v === (top ? "top" : "bottom"), k = find(p, top);
          if (!want) { clear(p, top); continue; }
          if (k) continue;
          const size = r6(drill(p) * 1.1); if (size > 0) write(p, top, size, "");
        } } },
    sizeRow(false), cutRow(false), sizeRow(true), cutRow(true),
  ];
}
/** RotatePoint (trigo.cpp) with KiCad's Y-down board axes. */
function padRot(x: number, y: number, deg: number): [number, number] { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [x * c + y * s, -x * s + y * c]; }

// ---------------------------------------------------------------- selected pads (PCB_PAD_T in the selection)
interface PadPick { key: string; fp: KItem; idx: number }
/** The pads picked on their own (CollabTools.pcb.selectedPadKeys(): "footprintId#padIndex"), when no item is selected. */
export function selectedPads(): PadPick[] {
  const doc = kdoc(); if (!doc || isSchDoc()) return [];
  const P = window.CollabTools && window.CollabTools.pcb; const keys: string[] = P && P.selectedPadKeys ? P.selectedPadKeys() : [];
  const out: PadPick[] = [];
  for (const key of keys) { const i = key.lastIndexOf("#"); const fp = doc.items.get(key.slice(0, i)); const idx = +key.slice(i + 1); if (fp && H().padNode(fp.node, idx)) out.push({ key, fp, idx }); }
  return out;
}
function padGrid(doc: KDoc, pads: PadPick[], ro: boolean): PropGrid {
  const defs = pads.map((p) => new Map(padDefs(doc, p.idx).map((d): [string, PropDef] => [defId(d), d])));
  const groups: PropGroup[] = [];
  for (const d of defs[0].values()) {
    const id = defId(d); let value = "", mixed = false, writable = true;
    if (pads.some((p, i) => { const own = defs[i].get(id)!; try { return !!own.avail && !own.avail(p.fp); } catch (e) { return true; } })) continue;   // PROPERTIES_PANEL: only what every item has
    pads.forEach((p, i) => { const own = defs[i].get(id)!; if (!own.set || (own.canWrite && !own.canWrite(p.fp))) writable = false; let raw: Raw = null; try { raw = own.get(p.fp); } catch (e) { raw = null; } const text = show(own, raw); if (i === 0) value = text; else if (text !== value) mixed = true; });
    const row: PropRow = { id, name: d.name, type: d.type, value: mixed ? "" : value, mixed, readOnly: ro || !writable, choices: d.choices };
    let g = groups.find((x) => x.name === d.group); if (!g) { g = { name: d.group, rows: [] }; groups.push(g); }
    g.rows.push(row);
  }
  return { title: pads.length === 1 ? "Pad" : `${pads.length} objects selected`, count: pads.length, groups, readOnly: ro };
}
/** Commit one property to every selected pad: one whole-footprint replace per footprint, all in one undo step. */
function setPadProp(doc: KDoc, pads: PadPick[], id: string, text: string): string | null {
  const head = padDefs(doc, pads[0].idx).find((d) => defId(d) === id); if (!head || !head.set) return "No such property";
  const parsed = parse(head, text); if (typeof parsed === "string") return parsed;
  for (const p of pads) { const d = padDefs(doc, p.idx).find((x) => defId(x) === id); const err = d && d.validate ? d.validate(parsed.v, p.fp) : null; if (err) return err; }
  const byFp = new Map<string, PadPick[]>(); for (const p of pads) { const l = byFp.get(p.fp.id) || []; l.push(p); byFp.set(p.fp.id, l); }
  const changes: KChange[] = [];
  for (const list of byFp.values()) {
    const fp = list[0].fp; const node = K().cloneNode(fp.node); let touched = false;
    for (const p of list) {
      const d = padDefs(doc, p.idx).find((x) => defId(x) === id); if (!d || !d.set || (d.canWrite && !d.canWrite(fp))) continue;
      let cur: Raw = null; try { cur = d.get(Object.assign({}, fp, { node })); } catch (e) { cur = null; }
      if (show(d, cur) === show(d, parsed.v)) continue;
      try { if (d.set(node, parsed.v, fp) !== false) touched = true; } catch (e) { console.warn(e); }
    }
    if (touched) changes.push(K().replaceChange(doc, Object.assign({}, fp, { node, geom: [], bbox: null })));
  }
  if (!changes.length) return null;
  tctx().commit(changes, head.name.toLowerCase());
  panelStore.set({ selVersion: panelStore.get().selVersion + 1 });
  return null;
}
const VIA_TYPES: [string, string][] = [["through", "Through"], ["blind", "Blind"], ["buried", "Buried"], ["micro", "Micro"]];
const VIA_SIDE = (yes: string, no: string): [string, string][] => [["", "From board stackup"], ["yes", yes], ["no", no]];
function viaProps(doc: KDoc): PropDef[] {
  const h = H(), V = "Via Properties", VB = "Backdrill", VP = "Post-machining"; const cu = layerChoices(doc, true);
  const sx = (t: string) => K().parse(t) as SNode;
  const typeOf = (n: SNode) => VIA_TYPES.map((t) => t[0]).find((t) => t !== "through" && n.indexOf(t) > 0) || "through";
  const pair = (n: SNode): [string, string] => { const l = h.kid(n, "layers"); return [l ? h.str(l[1]) : "F.Cu", l ? h.str(l[2]) : "B.Cu"]; };
  /** PCB_VIA::SanitizeLayers: a through via spans the board, any other via runs from its upper to its lower layer */
  const sanitize = (n: SNode) => {
    let [a, b] = pair(n);
    if (typeOf(n) === "through") { a = "F.Cu"; b = "B.Cu"; }
    else { const stack = h.boardLayers(doc, true); if (stack.indexOf(a) > stack.indexOf(b) && stack.indexOf(b) >= 0) [a, b] = [b, a]; }
    h.setViaLayers(n, a, b);
  };
  const layer = (name: string, i: 1 | 2): PropDef => ({ group: V, name, type: "enum", choices: cu, get: (x) => pair(x.node)[i - 1],
    // PCB_VIA::ValidateViaParameters
    validate: (v, x) => (!/\.Cu$/.test(String(v)) ? "Via layer must be a copper layer." : !h.boardLayers(doc, true).includes(String(v)) ? "Via layer is outside the board stack."
      : String(v) === pair(x.node)[2 - i] ? "Via start layer and end layer cannot be the same" : null),
    set: (n, v) => { const [a, b] = pair(n); const before = JSON.stringify(pair(n)); h.setViaLayers(n, i === 1 ? String(v) : a, i === 2 ? String(v) : b); sanitize(n); if (JSON.stringify(pair(n)) === before) return false; } });
  const dia = (n: SNode) => h.num((h.kid(n, "size") || [])[1], 0.8), hole = (n: SNode) => h.num((h.kid(n, "drill") || [])[1], 0.4);
  /** (tenting (front yes) (back no)), the legacy (tenting front back); a side that is not named follows the board stackup */
  const sides = (n: SNode, key: string): [string, string] => {
    const k = h.kid(n, key); let f = "", b = ""; if (!k) return [f, b];
    for (let j = 1; j < k.length; j++) { const c = k[j];
      if (Array.isArray(c)) { const s = h.str(c[1]), o = s === "yes" || s === "no" ? s : ""; if (c[0] === "front") f = o; else if (c[0] === "back") b = o; }
      else if (c === "front") f = "yes"; else if (c === "back") b = "yes"; }
    return [f, b];
  };
  const side = (name: string, key: string, i: 0 | 1, yes: string, no: string): PropDef => ({ group: V, name, type: "enum", choices: VIA_SIDE(yes, no), get: (x) => sides(x.node, key)[i],
    set: (n, v) => { const s = sides(n, key); s[i] = String(v || ""); TV.setChild(n, key, !s[0] && !s[1] ? null : `(${key} (front ${s[0] || "none"}) (back ${s[1] || "none"}))`, TV.VIA_ORDER, sx); } });
  const drillOpt = (name: string, key: string, yes: string, no: string): PropDef => ({ group: V, name, type: "enum", choices: VIA_SIDE(yes, no),
    get: (x) => { const k = h.kid(x.node, key), s = k ? h.str(k[1]) : ""; return s === "yes" || s === "no" ? s : ""; },
    set: (n, v) => { TV.setChild(n, key, v ? `(${key} ${String(v)})` : null, TV.VIA_ORDER, sx); } });
  // backdrills (PCB_VIA::GetBackdrillMode & co.): the drill from F.Cu is the top one, from B.Cu the bottom one
  const bdMode = (n: SNode) => ["none", "bottom", "top", "both"][TV.backdrillMode(n)];
  const bdHas = (top: boolean) => (x: KItem) => { const m = bdMode(x.node); return m === "both" || m === (top ? "top" : "bottom"); };
  const bdGet = (n: SNode, top: boolean) => { const b = TV.backdrills(n); return top ? b.front : b.back; };
  const bdSet = (n: SNode, top: boolean, d: TV.Backdrill | null) => { const b = TV.backdrills(n); TV.setBackdrills(n, top ? d : b.front, top ? b.back : d, sx); };
  const bdSize = (top: boolean): PropDef => ({ group: VB, name: `${top ? "Top" : "Bottom"} Backdrill Size`, type: "length", optional: true, avail: bdHas(top),
    validate: (v) => (v !== null && v !== undefined && (v as number) < 0.001 ? "Backdrill diameter is too small." : null),
    get: (x) => { const d = bdGet(x.node, top); return d ? d.size : null; },
    set: (n, v) => { const d = bdGet(n, top); if (v === null || v === undefined) { bdSet(n, top, null); return; } bdSet(n, top, { size: v as number, end: d ? d.end : top ? "F.Cu" : "B.Cu" }); } });
  const bdCut = (top: boolean): PropDef => ({ group: VB, name: `${top ? "Top" : "Bottom"} Backdrill Must-Cut`, type: "enum", choices: cu, avail: bdHas(top),
    get: (x) => { const d = bdGet(x.node, top); return d ? d.end : null; }, set: (n, v) => { const d = bdGet(n, top); if (!d) return false; bdSet(n, top, { size: d.size, end: String(v) }); } });
  const pmRow = (front: boolean, name: string, key: "size" | "depth" | "angle", type: PropType): PropDef => ({ group: VP, name: `${front ? "Front" : "Back"} ${name}`, type,
    avail: (x) => TV.postMachining(x.node, front).mode !== "none", get: (x) => TV.postMachining(x.node, front)[key],
    set: (n, v) => { const pm = TV.postMachining(n, front); TV.setPostMachining(n, front, Object.assign(pm, { [key]: Math.max(0, v as number) }), sx); } });
  const pmDefs = (front: boolean): PropDef[] => [
    { group: VP, name: `${front ? "Front" : "Back"} Post-machining`, type: "enum", choices: PAD_POST_MACHINING, get: (x) => TV.postMachining(x.node, front).mode,
      set: (n, v) => { const pm = TV.postMachining(n, front); TV.setPostMachining(n, front, Object.assign(pm, { mode: String(v) as TV.PostMachining["mode"] }), sx); } },
    pmRow(front, "Post-machining Size", "size", "length"), pmRow(front, "Post-machining Depth", "depth", "length"), pmRow(front, "Post-machining Angle", "angle", "angle")];
  return [atProp("Position X", 1), atProp("Position Y", 2), lockedProp(), ...netProps(doc),
    // PCB_VIA::GetIsFree: a free via keeps its net; otherwise it takes the net of the copper it lands on
    { group: BASIC, name: "Automatically Update Net", type: "bool", get: (x) => !h.yes(x.node, "free", false),
      set: (n, v) => { TV.setChild(n, "free", v ? null : "(free yes)", TV.VIA_ORDER, sx); } },
    { group: V, name: "Diameter", type: "length", get: (x) => dia(x.node),
      validate: (v, x) => ((v as number) < 0.001 ? "Via diameter is too small." : hole(x.node) >= (v as number) ? "Via hole size must be smaller than via diameter" : null),
      set: (n, v) => { h.setViaSize(n, v as number); } },
    { group: V, name: "Hole", type: "length", get: (x) => hole(x.node),
      validate: (v, x) => ((v as number) < 0.001 ? "Via drill is too small." : (v as number) >= dia(x.node) ? "Via hole size must be smaller than via diameter" : null),
      set: (n, v) => { h.setViaDrill(n, v as number); } },
    layer("Layer Top", 1), layer("Layer Bottom", 2),
    { group: V, name: "Via Type", type: "enum", choices: VIA_TYPES, get: (x) => typeOf(x.node), set: (n, v) => { for (const t of ["blind", "buried", "micro"]) { const i = n.indexOf(t); if (i > 0) n.splice(i, 1); } if (v !== "through") n.splice(1, 0, String(v)); sanitize(n); } },
    side("Front Tenting", "tenting", 0, "Tented", "Not tented"), side("Back Tenting", "tenting", 1, "Tented", "Not tented"),
    side("Front Covering", "covering", 0, "Covered", "Not covered"), side("Back Covering", "covering", 1, "Covered", "Not covered"),
    side("Front Plugging", "plugging", 0, "Plugged", "Not plugged"), side("Back Plugging", "plugging", 1, "Plugged", "Not plugged"),
    drillOpt("Capping", "capping", "Capped", "Not capped"), drillOpt("Filling", "filling", "Filled", "Not filled"),
    { group: VB, name: "Backdrill Mode", type: "enum", choices: PAD_BACKDRILL, avail: (x) => typeOf(x.node) === "through" || bdMode(x.node) !== "none", get: (x) => bdMode(x.node),
      // PADSTACK::SetBackdrillMode: a new side starts on its own copper layer, 1.1 × the hole
      set: (n, v) => { const b = TV.backdrills(n), mk = (top: boolean, cur: TV.Backdrill | null): TV.Backdrill | null => (v === "both" || v === (top ? "top" : "bottom") ? cur || { size: r6(hole(n) * 1.1), end: top ? "F.Cu" : "B.Cu" } : null);
        TV.setBackdrills(n, mk(true, b.front), mk(false, b.back), sx); } },
    bdSize(false), bdCut(false), bdSize(true), bdCut(true),
    ...pmDefs(true), ...pmDefs(false),
    ...teardropDefs(doc, (n) => n, true)];
}
const ZONE_CONNECT: [string, string][] = [["", "Thermal reliefs"], ["no", "None"], ["yes", "Solid"], ["thru_hole_only", "Thermal reliefs for PTH"]];
const FILL_MODES: [string, string][] = [["solid", "Solid fill"], ["hatch", "Hatch pattern"], ["thieving", "Copper thieving"]];
const THIEVING_PATTERNS: [string, string][] = [["dots", "Dots"], ["squares", "Squares"], ["hatch", "Hatch"]];
function zoneProps(it: KItem, doc: KDoc): PropDef[] {
  const h = H(), El = "Electrical";
  const cp = (n: SNode) => h.kid(n, "connect_pads");
  const fillKid = (name: string, key: string): PropDef => ({ group: El, name, type: "length", get: (x) => { const f = h.kid(x.node, "fill"), k = f && h.kid(f, key); return k ? h.num(k[1]) : 0.5; },
    set: (n, v) => { let f = h.kid(n, "fill"); if (!f) f = h.setKid(n, "fill", [], ["polygon", "filled_polygon"]); h.setKid(f, key, [r6(Math.max(0, v as number))], key === "thermal_gap" ? ["thermal_bridge_width", "smoothing", "radius", "island_removal_mode"] : ["smoothing", "radius", "island_removal_mode"]); } });
  const zoneCopper = (n: SNode) => { const s = h.kid(n, "layer"), m = h.kid(n, "layers"); const l = s ? h.str(s[1]) : m ? h.str(m[1]) : ""; return /\.Cu$/.test(l) || /^\*\.Cu$|^F&B\.Cu$/.test(l); };
  const isKeepout = !!h.kid(it.node, "keepout");
  const nameRow: PropDef = { group: BASIC, name: "Name", type: "text", get: (x) => h.str((h.kid(x.node, "name") || [])[1]), set: (n, v) => { h.setZoneName(n, String(v)); } };
  // ZONE_DESC: BOARD_ITEM's Locked, the Net (copper zones), Priority (copper zones that are not rule areas), Name; a
  // zone's layer set is not a property (the single "Layer" is hidden)
  const out: PropDef[] = [lockedProp()];
  if (!isKeepout && zoneCopper(it.node)) out.push({ group: BASIC, name: "Priority", type: "int", get: (x) => h.num((h.kid(x.node, "priority") || [])[1], 0), set: (n, v) => { h.setZonePriority(n, v as number); } });
  out.push(nameRow);
  if (isKeepout) {
    // "Keepout" (rule areas): (keepout (tracks allowed|not_allowed) (vias …) (pads …) (copperpour …) (footprints …))
    const ko = (name: string, key: string): PropDef => ({ group: "Keepout", name, type: "bool", get: (x) => { const k = h.kid(x.node, "keepout"), c = k && h.kid(k, key); return !!c && h.str(c[1]) === "not_allowed"; },
      set: (n, v) => { const k = h.kid(n, "keepout"); if (!k) return false; const order = ["tracks", "vias", "pads", "copperpour", "footprints"]; h.setKid(k, key, [v ? "not_allowed" : "allowed"], order.slice(order.indexOf(key) + 1)); } });
    out.push(ko("Keep Out Tracks", "tracks"), ko("Keep Out Vias", "vias"), ko("Keep Out Pads", "pads"), ko("Keep Out Zone Fills", "copperpour"), ko("Keep Out Footprints", "footprints"));
    // "Placement": (placement (enabled yes) (sheetname|component_class|group "…")); the source rows need it enabled
    const SRC: [string, string][] = [["sheetname", "Sheet Name"], ["component_class", "Component Class"], ["group", "Group"]];
    const pl = (n: SNode) => h.kid(n, "placement");
    const plOn = (n: SNode) => { const p = pl(n); return !!p && h.yes(p, "enabled", false); };
    const plSrc = (n: SNode): [string, string] => { const p = pl(n); if (p) for (const [k] of SRC) { const c = h.kid(p, k); if (c) return [k, h.str(c[1])]; } return ["sheetname", ""]; };
    const plWrite = (n: SNode, on: boolean, type: string, name: string) => { h.delKid(n, "placement"); h.setKid(n, "placement", [["enabled", on ? "yes" : "no"], [type, name]], ["fill", "polygon", "filled_polygon"]); };
    out.push({ group: "Placement", name: "Enable", type: "bool", get: (x) => plOn(x.node), set: (n, v) => { const [t, s] = plSrc(n); plWrite(n, !!v, t, s); } },
      { group: "Placement", name: "Source Type", type: "enum", choices: SRC, avail: (x) => plOn(x.node), get: (x) => plSrc(x.node)[0], set: (n, v) => { plWrite(n, plOn(n), String(v), plSrc(n)[1]); } },
      { group: "Placement", name: "Source Name", type: "text", avail: (x) => plOn(x.node), get: (x) => plSrc(x.node)[1], set: (n, v) => { plWrite(n, plOn(n), plSrc(n)[0], String(v)); } });
    return out;
  }
  // ZONE_DESC: Fill Mode on copper zones; a copper-thieving zone hides its net, pad connections and thermal rows
  // and shows its THIEVING_SETTINGS (Element Size writable for dots and squares, Line Width for hatch)
  type ZT = { zoneFillMode(n: SNode): string; setZoneFillMode(n: SNode, m: string): SNode; thievingOf(n: SNode): Record<string, number | string | boolean>; setThieving(n: SNode, p: Record<string, unknown>): SNode; thievingAllowed?(d: KDoc): boolean };
  const Z = pcbTools() as unknown as ZT | null;
  if (!Z || !zoneCopper(it.node)) return out;
  const minW = (n: SNode) => h.num((h.kid(n, "min_thickness") || [])[1], 0.25);
  const notBelowMin = (v: Raw, x: KItem): string | null => ((v as number) < minW(x.node) ? "Cannot be less than zone minimum width" : null);
  const FILL_ORDER = ["mode", "thermal_gap", "thermal_bridge_width", "smoothing", "radius", "island_removal_mode", "island_area_min", "hatch_thickness", "hatch_gap", "hatch_orientation", "hatch_smoothing_level", "hatch_smoothing_value", "hatch_border_algorithm", "hatch_min_hole_area", "thieving"];
  const fillNum = (name: string, key: string, type: PropType, def: number, extra?: Partial<PropDef>): PropDef => Object.assign({ group: "Fill Style", name, type,
    get: (x: KItem) => { const f = h.kid(x.node, "fill"), k = f && h.kid(f, key); return k ? h.num(k[1]) : def; },
    set: (n: SNode, v: Raw) => { let f = h.kid(n, "fill"); if (!f) f = h.setKid(n, "fill", [], ["polygon", "filled_polygon"]); h.setKid(f, key, [type === "int" ? Math.round(v as number) : r6(v as number)], FILL_ORDER.slice(FILL_ORDER.indexOf(key) + 1)); } }, extra || {});
  const FS = "Fill Style";
  const thieving = Z.zoneFillMode(it.node) === "thieving";
  if (thieving) out.splice(1, 0, layerProp(doc, true, "F.Cu")); else out.splice(1, 0, ...netProps(doc));
  const tv = (key: string, type: PropType, writable?: (x: KItem) => boolean): PropDef => ({ group: FS, name: "", type, get: (x) => Z.thievingOf(x.node)[key] as Raw, validate: type === "length" ? positiveInt : undefined,
    set: (n, v, x) => { if (writable && !writable(x)) return false; if ((type === "length") && !((v as number) > 0)) return false; Z.setThieving(n, { [key]: type === "bool" ? !!v : type === "enum" ? String(v) : +(v as number) }); } });
  const named = (d: PropDef, name: string): PropDef => Object.assign(d, { name });
  const isHatch = (x: KItem) => Z.thievingOf(x.node).type === "hatch";
  // copper thieving needs the KiCad 11 board format (20260513): a board in an older format is not offered it, so its
  // file format version is never raised by a fill mode edit
  const canThieve = thieving || !Z.thievingAllowed || Z.thievingAllowed(doc);
  const modes = canThieve ? FILL_MODES : FILL_MODES.filter((m) => m[0] !== "thieving");
  out.push({ group: FS, name: "Fill Mode", type: "enum", choices: modes, get: (x) => Z.zoneFillMode(x.node), set: (n, v) => { if (Z.zoneFillMode(n) === String(v)) return false; if (String(v) === "thieving" && !canThieve) return false; Z.setZoneFillMode(n, String(v)); } });
  if (thieving) {
    out.push(named(Object.assign(tv("type", "enum"), { choices: THIEVING_PATTERNS }), "Thieving Pattern"),
      named(tv("size", "length", (x) => !isHatch(x)), "Thieving Element Size"), named(tv("gap", "length"), "Thieving Gap"),
      named(tv("width", "length", isHatch), "Thieving Line Width"), named(tv("stagger", "bool"), "Thieving Stagger"), named(tv("orientation", "angle"), "Thieving Orientation"),
      { group: El, name: "Clearance", type: "length", validate: rangeInt(0, 100), get: (x) => { const c = cp(x.node), k = c && h.kid(c, "clearance"); return k ? h.num(k[1]) : 0; }, set: (n, v) => { let c = cp(n); if (!c) c = h.setKid(n, "connect_pads", [], ["min_thickness", "filled_areas_thickness", "keepout", "fill"]); h.setKid(c, "clearance", [r6(Math.max(0, v as number))]); } },
      { group: El, name: "Minimum Width", type: "length", validate: rangeInt(0.025, Infinity), get: (x) => h.num((h.kid(x.node, "min_thickness") || [])[1], 0.25), set: (n, v) => { if (!((v as number) > 0)) return false; h.setKid(n, "min_thickness", [r6(v as number)], ["filled_areas_thickness", "keepout", "fill"]); } });
    return out;
  }
  // the hatch rows are writable only in hatch mode; Minimum Island Area only when islands below a limit are removed
  const hatched = (x: KItem) => Z.zoneFillMode(x.node) === "hatch";
  const islandMode = (n: SNode) => { const f = h.kid(n, "fill"), k = f && h.kid(f, "island_removal_mode"); return k ? String(h.num(k[1])) : "0"; };
  out.push(
    fillNum("Hatch Orientation", "hatch_orientation", "angle", 0, { canWrite: hatched }),
    fillNum("Hatch Width", "hatch_thickness", "length", 1, { canWrite: hatched, validate: notBelowMin }),
    fillNum("Hatch Gap", "hatch_gap", "length", 1.5, { canWrite: hatched, validate: notBelowMin }),
    fillNum("Hatch Minimum Hole Ratio", "hatch_min_hole_area", "number", 0.3, { canWrite: hatched, validate: positiveRatio }),
    fillNum("Smoothing Effort", "hatch_smoothing_level", "int", 0, { canWrite: hatched }),
    fillNum("Smoothing Amount", "hatch_smoothing_value", "number", 0.1, { canWrite: hatched }),
    { group: FS, name: "Remove Islands", type: "enum", choices: [["0", "Always"], ["1", "Never"], ["2", "Below area limit"]], get: (x) => islandMode(x.node),
      set: (n, v) => { let f = h.kid(n, "fill"); if (!f) f = h.setKid(n, "fill", [], ["polygon", "filled_polygon"]); h.setKid(f, "island_removal_mode", [+(v as string)], FILL_ORDER.slice(FILL_ORDER.indexOf("island_removal_mode") + 1)); if (v !== "2") h.delKid(f, "island_area_min"); else if (!h.kid(f, "island_area_min")) h.setKid(f, "island_area_min", [10], FILL_ORDER.slice(FILL_ORDER.indexOf("island_area_min") + 1)); } },
    fillNum("Minimum Island Area", "island_area_min", "number", 0, { canWrite: (x: KItem) => islandMode(x.node) === "2" }),
    { group: El, name: "Clearance", type: "length", validate: rangeInt(0, 100), get: (x) => { const c = cp(x.node), k = c && h.kid(c, "clearance"); return k ? h.num(k[1]) : 0; }, set: (n, v) => { let c = cp(n); if (!c) c = h.setKid(n, "connect_pads", [], ["min_thickness", "filled_areas_thickness", "keepout", "fill"]); h.setKid(c, "clearance", [r6(Math.max(0, v as number))]); } },
    { group: El, name: "Minimum Width", type: "length", validate: rangeInt(0.025, Infinity), get: (x) => h.num((h.kid(x.node, "min_thickness") || [])[1], 0.25), set: (n, v) => { if (!((v as number) > 0)) return false; h.setKid(n, "min_thickness", [r6(v as number)], ["filled_areas_thickness", "keepout", "fill"]); } },
    { group: El, name: "Pad Connections", type: "enum", choices: ZONE_CONNECT, get: (x) => { const c = cp(x.node); return c && typeof c[1] === "string" ? c[1] : ""; },
      set: (n, v) => { let c = cp(n); if (!c) c = h.setKid(n, "connect_pads", [["clearance", 0.5]], ["min_thickness", "filled_areas_thickness", "keepout", "fill"]); if (typeof c[1] === "string") c.splice(1, 1); if (v) c.splice(1, 0, String(v)); } },
    Object.assign(fillKid("Thermal Relief Gap", "thermal_gap"), { validate: positiveInt }), Object.assign(fillKid("Thermal Relief Spoke Width", "thermal_bridge_width"), { validate: notBelowMin }));
  return out;
}
function fillOfShape(n: SNode): boolean { const f = H().kid(n, "fill"); if (!f) return false; const v = H().str(f[1]); return v === "yes" || v === "solid"; }
const SHAPE_NAMES: Record<string, string> = { gr_line: "Segment", gr_rect: "Rectangle", gr_arc: "Arc", gr_circle: "Circle", gr_poly: "Polygon", gr_curve: "Bezier" };
/** LINE_ENDING_STYLE's ENUM_MAP (common/eda_shape.cpp): its tokens and names, in the registered order. */
const LINE_ENDINGS: [string, string][] = [["none", "None"], ["arrow", "Arrow"], ["circle", "Circle"], ["square", "Square"], ["arrow_open", "Open Arrow"]];
const SHAPE_FILLS: [string, string][] = [["no", "None"], ["yes", "Solid"], ["hatch", "Hatch"], ["reverse_hatch", "Reverse Hatch"], ["cross_hatch", "Cross-hatch"]];
/** An arc as EDA_SHAPE holds it: the centre and the two ends in its winding (the stored start and end swap when the
 *  file's start → mid → end runs the other way), with GetArcAngle. */
function arcInternal(n: SNode): { c: [number, number]; s: [number, number]; e: [number, number]; angle: number; swapped: boolean } | null {
  const h = H(), P = (k: string): [number, number] | null => { const c = h.kid(n, k); return c ? [h.num(c[1]), h.num(c[2])] : null; };
  const S = P("start"), M = P("mid"), En = P("end"); if (!S || !M || !En) return null;
  const g = (K() as unknown as { arcFrom3(a: number[], b: number[], c: number[]): { x: number; y: number } | null }).arcFrom3(S, M, En); if (!g) return null;
  const c: [number, number] = [g.x, g.y], phi = (p: [number, number]) => Math.atan2(p[1] - c[1], p[0] - c[0]) * 180 / Math.PI, n360 = (a: number) => ((a % 360) + 360) % 360;
  const dM = n360(phi(M) - phi(S)), dE = n360(phi(En) - phi(S));
  return dM < dE ? { c, s: S, e: En, angle: dE, swapped: false } : { c, s: En, e: S, angle: 360 - dE, swapped: true };
}
/** EDA_SHAPE::SetArcAngleAndEnd( aAngle, true ): the end is the start turned about the centre; a negative angle swaps the ends. */
function setArcAngle(n: SNode, deg: number): boolean {
  const h = H(), a = arcInternal(n); if (!a || !deg) return false;
  const turn = (d: number): [number, number] => { const [x, y] = padRot(a.s[0] - a.c[0], a.s[1] - a.c[1], -d); return [r6(a.c[0] + x), r6(a.c[1] + y)]; };
  let s: [number, number] = a.s, e = turn(deg); const mid = turn(deg / 2);
  if (deg < 0) [s, e] = [e, s];
  if (a.swapped) [s, e] = [e, s];
  const put = (k: string, p: [number, number]) => { const c = h.kid(n, k); if (c) { c[1] = r6(p[0]); c[2] = r6(p[1]); } };
  put("start", s); put("mid", mid); put("end", e); return true;
}
function boardShapeProps(it: KItem, doc: KDoc): PropDef[] {
  const h = H(), S = "Shape Properties", k = it.kind;
  const onCopper = (x: KItem) => /\.Cu$/.test(itemCopper(x.node));
  // PCB_SHAPE_DESC: Locked, the Net of a shape on copper, Layer; then EDA_SHAPE's rows
  const out: PropDef[] = [lockedProp(), ...netProps(doc).map((d): PropDef => Object.assign(d, { avail: onCopper })), Object.assign(trackLayerProp(doc), { choices: layerChoices(doc, false) })];
  // BOARD_ITEM's Position X / Y, available on a polygon only (EDA_SHAPE::getPosition: its first vertex; setPosition moves every vertex)
  if (k === "gr_poly") {
    const polyPos = (name: string, i: 1 | 2): PropDef => ({ group: BASIC, name, type: "coord", get: (x) => { const p = h.kid(x.node, "pts"), q = p ? h.kids(p, "xy")[0] : null; return q ? h.num(q[i]) : null; },
      set: (n, v) => { const p = h.kid(n, "pts"), xy = p ? h.kids(p, "xy") : []; if (!xy.length) return false; const d = (v as number) - h.num(xy[0][i]); if (!d) return false;
        for (let j = 1; j < p!.length; j++) { const c = p![j] as SNode; if (!Array.isArray(c)) continue; if (c[0] === "xy") c[i] = r6(h.num(c[i]) + d); else if (c[0] === "arc") for (const key of ["start", "mid", "end"]) { const q = h.kid(c, key); if (q) q[i] = r6(h.num(q[i]) + d); } } } });
    out.unshift(polyPos("Position X", 1), polyPos("Position Y", 2));
  }
  out.push({ group: S, name: "Shape", type: "text", get: () => SHAPE_NAMES[k] || k });   // read-only: a shape does not change its kind
  const bez = (name: string, vi: number, i: 1 | 2): PropDef => ({ group: S, name, type: "coord", get: (x) => { const p = h.kid(x.node, "pts"), q = p ? h.kids(p, "xy")[vi] : null; return q ? h.num(q[i]) : null; },
    set: (n, v) => { const p = h.kid(n, "pts"), q = p ? h.kids(p, "xy")[vi] : null; if (!q) return false; q[i] = r6(v as number); } });
  if (k === "gr_line" || k === "gr_rect" || k === "gr_arc") out.push(xyProp(S, "Start X", "start", 1), xyProp(S, "Start Y", "start", 2), xyProp(S, "End X", "end", 1), xyProp(S, "End Y", "end", 2));
  if (k === "gr_curve") out.push(bez("Start X", 0, 1), bez("Start Y", 0, 2), bez("End X", 3, 1), bez("End Y", 3, 2));
  if (k === "gr_rect") {
    // EDA_SHAPE::SetRectangleWidth / Height move the end corner; Corner Radius is (radius r), left out at 0
    const dim = (name: string, i: 1 | 2): PropDef => ({ group: S, name, type: "length", get: (x) => { const s = h.kid(x.node, "start"), e = h.kid(x.node, "end"); return s && e ? Math.abs(h.num(e[i]) - h.num(s[i])) : null; },
      set: (n, v) => { const s = h.kid(n, "start"), e = h.kid(n, "end"); if (!s || !e) return false; e[i] = r6(h.num(s[i]) + (v as number)); } });
    const half = (n: SNode) => { const s = h.kid(n, "start"), e = h.kid(n, "end"); return s && e ? Math.min(Math.abs(h.num(e[1]) - h.num(s[1])), Math.abs(h.num(e[2]) - h.num(s[2]))) / 2 : 0; };
    out.push(dim("Width", 1), dim("Height", 2), { group: S, name: "Corner Radius", type: "length", get: (x) => h.num((h.kid(x.node, "radius") || [])[1], 0),
      validate: (v, x) => ((v as number) > half(x.node) ? tooLarge(half(x.node)) : (v as number) < 0 ? tooSmall(0) : null),
      set: (n, v) => { if ((v as number) > 0) h.setKid(n, "radius", [r6(v as number)], ["stroke", "fill", "layer", "layers", "solder_mask_margin", "net", "uuid", "tstamp"]); else h.delKid(n, "radius"); } });
  }
  if (k === "gr_circle") {
    const centre = (name: string, i: 1 | 2): PropDef => ({ group: S, name, type: "coord", get: (x) => { const c = h.kid(x.node, "center"); return c ? h.num(c[i]) : null; },
      set: (n, v) => { const c = h.kid(n, "center"), e = h.kid(n, "end"); if (!c || !e) return false; const d = (v as number) - h.num(c[i]); c[i] = r6(v as number); e[i] = r6(h.num(e[i]) + d); } });
    out.push(centre("Center X", 1), centre("Center Y", 2), { group: S, name: "Radius", type: "length",
      get: (x) => { const c = h.kid(x.node, "center"), e = h.kid(x.node, "end"); return c && e ? Math.hypot(h.num(e[1]) - h.num(c[1]), h.num(e[2]) - h.num(c[2])) : null; },
      set: (n, v) => { const c = h.kid(n, "center"), e = h.kid(n, "end"); if (!c || !e || !((v as number) > 0)) return false; e[1] = r6(h.num(c[1]) + (v as number)); e[2] = r6(h.num(c[2])); } });
  }
  out.push({ group: S, name: "Line Width", type: "length", get: (x) => h.strokeWidth(x.node) || h.num((h.kid(x.node, "width") || [])[1], 0), set: (n, v) => { if (h.kid(n, "stroke") || !h.kid(n, "width")) h.setStrokeWidth(n, Math.max(0, v as number)); else h.setWidth(n, Math.max(0, v as number)); } });
  // Line Style is always there: a shape with a legacy (width w) gets a (stroke …) when its style is set
  out.push({ group: S, name: "Line Style", type: "enum", choices: LINE_STYLES.slice(1), get: (x) => { const st = h.kid(x.node, "stroke"), t = st && h.kid(st, "type"); const s = t ? h.str(t[1]) : "solid"; return s === "default" ? "solid" : s; },
    set: (n, v) => { let st = h.kid(n, "stroke"); if (!st) { const w = h.num((h.kid(n, "width") || [])[1], 0); h.delKid(n, "width"); st = h.setKid(n, "stroke", [["width", w]], ["fill", "layer", "layers", "solder_mask_margin", "net", "uuid", "tstamp"]); } h.setKid(st, "type", [String(v)], ["color"]); } });
  if (k === "gr_arc") out.push({ group: S, name: "Angle", type: "angle", get: (x) => { const a = arcInternal(x.node); return a ? r6(a.angle) : null; },
    validate: (v) => ((v as number) === 0 ? "Arc angle must not be zero." : null), set: (n, v) => setArcAngle(n, v as number) });
  // UI_FILL_MODE: (fill no|yes|hatch|reverse_hatch|cross_hatch); files before 20241228 say none / solid
  if (k === "gr_rect" || k === "gr_circle" || k === "gr_poly" || k === "gr_curve") out.push({ group: S, name: "Fill", type: "enum", choices: SHAPE_FILLS,
    get: (x) => { const f = h.kid(x.node, "fill"), s = f ? h.str(f[1]) : "no"; return s === "solid" ? "yes" : s === "none" ? "no" : SHAPE_FILLS.some((c) => c[0] === s) ? s : "no"; },
    set: (n, v) => { const f = h.kid(n, "fill"); const old = f ? h.str(f[1]) : ""; const legacy = old === "solid" || old === "none"; const t = String(v);
      h.setKid(n, "fill", [legacy && t === "yes" ? "solid" : legacy && t === "no" ? "none" : t], ["layer", "layers", "solder_mask_margin", "net", "uuid", "tstamp"]); } });
  // EDA_SHAPE's line endings on an open shape (a segment, an arc, a curve whose ends differ): LINE_ENDING::Format's
  // (start_shape …) / (end_shape …) after the stroke, nothing for None
  const isOpen = (x: KItem): boolean => { if (k === "gr_line" || k === "gr_arc") return true; if (k !== "gr_curve") return false; const p = h.kid(x.node, "pts"), q = p ? h.kids(p, "xy") : []; return q.length < 3 || h.num(q[0][1]) !== h.num(q[q.length - 1][1]) || h.num(q[0][2]) !== h.num(q[q.length - 1][2]); };
  if (k === "gr_line" || k === "gr_arc" || k === "gr_curve") {
    const ending = (side: "Start" | "End", name: string, field: "style" | "length" | "width" | "thickness"): PropDef => {
      const key = side === "Start" ? "start_shape" : "end_shape";
      return { group: S, name: `${side} ${name}`, type: field === "style" ? "enum" : "length", choices: field === "style" ? LINE_ENDINGS : undefined, avail: isOpen,
        get: (x) => readEndingState(x.node, key)[field] as Raw,
        set: (n, v) => { const st = readEndingState(n, key); if (field === "style") st.style = String(v) as typeof st.style; else st[field] = Math.max(0, v as number); writeEndingState(n, key, st); } };
    };
    for (const side of ["Start", "End"] as const) out.push(ending(side, "Shape", "style"), ending(side, "Length", "length"), ending(side, "Width", "width"), ending(side, "Stroke Width", "thickness"));
  }
  out.push(...techLayerProps());
  return out;
}
/** PCB_TEXTBOX::SetTextAngle through the board module: the box slides about its start, the angle is the text's. */
function slideTextBox(n: SNode, deg: number) {
  const P = pcbTools() as unknown as { setTextBoxAngleSliding?(n: SNode, d: number): SNode } | null;
  if (P && P.setTextBoxAngleSliding) P.setTextBoxAngleSliding(n, deg);
}
function boardTextBoxProps(doc: KDoc): PropDef[] {
  const h = H(), T = "Text Properties";
  const base = boardTextProps(doc).filter((d) => d.name !== "Position X" && d.name !== "Position Y" && d.name !== "Orientation" && d.name !== "Knockout");
  // PCB_SHAPE::GetPosition is the box's start; SetPosition moves the whole box
  const pos = (name: string, i: 1 | 2): PropDef => ({ group: BASIC, name, type: "coord", get: (x) => h.num((h.kid(x.node, "start") || [])[i], 0),
    set: (n, v) => { const s = h.kid(n, "start"), e = h.kid(n, "end"); if (!s) return false; const d = (v as number) - h.num(s[i]); s[i] = r6(h.num(s[i]) + d); if (e) e[i] = r6(h.num(e[i]) + d); } });
  const margin = (name: string, i: number): PropDef => ({ group: "Margins", name, type: "length", get: (x) => { const m = h.kid(x.node, "margins"); return m ? h.num(m[i], 0) : 0; },
    set: (n, v) => { const m = h.kid(n, "margins"); if (!m || !((v as number) >= 0)) return false; m[i] = r6(v as number); } });
  const orient: PropDef = { group: T, name: "Orientation", type: "angle", get: (x) => { const a = h.kid(x.node, "angle"); return h.normDeg(a ? h.num(a[1]) : 0); }, set: (n, v) => { slideTextBox(n, v as number); } };
  const out = [pos("Position X", 1), pos("Position Y", 2), ...base];
  out.splice(out.findIndex((d) => d.name === "Text") + 1, 0, orient);
  out.push(
    { group: T, name: "Knockout", type: "bool", get: (x) => { const l = h.kid(x.node, "layer"); return !!l && l.indexOf("knockout") > 0; }, set: (n, v) => { const l = h.kid(n, "layer"); if (!l) return false; const i = l.indexOf("knockout"); if (i > 0) l.splice(i, 1); if (v) l.push("knockout"); } },
    { group: "Border Properties", name: "Border", type: "bool", get: (x) => h.yes(x.node, "border", false), set: (n, v) => { h.setKid(n, "border", [v ? "yes" : "no"], ["stroke", "knockout", "uuid"]); } },
    { group: "Border Properties", name: "Border Style", type: "enum", choices: LINE_STYLES.slice(1), get: (x) => { const st = h.kid(x.node, "stroke"), t = st && h.kid(st, "type"); return t ? h.str(t[1]) : "solid"; },
      set: (n, v) => { const st = h.kid(n, "stroke") || h.setKid(n, "stroke", [["width", 0.1]], ["knockout", "uuid"]); h.setKid(st, "type", [String(v)]); } },
    { group: "Border Properties", name: "Border Width", type: "length", get: (x) => h.strokeWidth(x.node), set: (n, v) => { h.setStrokeWidth(n, Math.max(0, v as number)); } },
    margin("Margin Left", 1), margin("Margin Top", 2), margin("Margin Right", 3), margin("Margin Bottom", 4));
  return out;
}
function boardTextProps(doc: KDoc): PropDef[] {
  const h = H(), T = "Text Properties";
  const size = (name: string, i: 1 | 2): PropDef => ({ group: T, name, type: "length", get: (x) => { const f = fontOf(x.node, false), s = f && h.kid(f, "size"); return s ? h.num(s[i], 1) : 1; },
    set: (n, v) => { if (!((v as number) > 0)) return false; const f = fontOf(n, true)!; const s = h.kid(f, "size") || h.setKid(f, "size", [1, 1], ["thickness", "bold", "italic"]); s[i] = r6(v as number); } });
  const thick = (n: SNode): number => { const f = fontOf(n, false), t = f && h.kid(f, "thickness"); return t ? h.num(t[1]) : 0; };
  /** EDA_TEXT::GetEffectiveTextPenWidth of an auto-thickness text: GetPenSizeForNormal / Bold of the smaller size */
  const autoPen = (n: SNode): number => { const f = fontOf(n, false), s = f && h.kid(f, "size"); const m = s ? Math.min(h.num(s[1], 1), h.num(s[2], 1)) : 1; const bold = !!f && (f.includes("bold") || h.yes(f, "bold", false)); return r6(Math.round(m * 1e6 / (bold ? 5 : 8)) / 1e6); };
  const faces: [string, string][] = [["", KICAD_FONT], ...facesUsed(doc as unknown as Parameters<typeof facesUsed>[0]).map((f): [string, string] => [f, f])];
  // PCB_TEXT_DESC: Position, Layer, Locked, Orientation (BOARD_ITEM's and the masked-in EDA_TEXT angle), then EDA_TEXT's rows
  return [atProp("Position X", 1), atProp("Position Y", 2), layerProp(doc, false, "F.SilkS"), lockedProp(),
    { group: BASIC, name: "Orientation", type: "angle", get: (x) => K().atOf(x.node)[2], set: (n, v) => { const [x, y] = K().atOf(n); K().setAt(n, x, y, r6(h.normDeg(v as number))); } },
    { group: T, name: "Text", type: "longtext", get: (x) => h.str(x.node[1]), set: (n, v) => { h.setText(n, String(v)); } },
    { group: T, name: "Font", type: "enum", choices: faces, get: (x) => { const f = faceOfFont(fontOf(x.node, false)); return faces.some((c) => c[0] === f) ? f : ""; }, set: (n, v) => { setFaceOfFont(fontOf(n, true)!, String(v || "")); } },
    // Auto Thickness: no (thickness …); Thickness then shows the pen the size gives and is read-only
    { group: T, name: "Auto Thickness", type: "bool", get: (x) => !(thick(x.node) > 0), set: (n, v) => { const f = fontOf(n, true)!; if (v) h.delKid(f, "thickness"); else h.setKid(f, "thickness", [autoPen(n)], ["bold", "italic", "color"]); } },
    { group: T, name: "Thickness", type: "length", canWrite: (x) => thick(x.node) > 0, get: (x) => thick(x.node) || autoPen(x.node), set: (n, v) => { const f = fontOf(n, true)!; if ((v as number) > 0) h.setKid(f, "thickness", [r6(v as number)], ["bold", "italic", "color"]); else h.delKid(f, "thickness"); } },
    fontFlag(T, "Italic", "italic"), fontFlag(T, "Bold", "bold"),
    { group: T, name: "Mirrored", type: "bool", get: (x) => justifyOf(x.node).mirror, set: (n, v) => setJustify(n, { mirror: !!v }) },
    size("Width", 2), size("Height", 1),
    ...justifyProps(T),
    { group: T, name: "Knockout", type: "bool", get: (x) => { const l = h.kid(x.node, "layer"); return !!l && l.indexOf("knockout") > 0; }, set: (n, v) => { const l = h.kid(n, "layer"); if (!l) return false; const i = l.indexOf("knockout"); if (i > 0) l.splice(i, 1); if (v) l.push("knockout"); } },
  ];
}
// PCB_TUNING_PATTERN_DESC (pcbnew/generators/pcb_tuning_pattern.cpp): BOARD_ITEM's rows with its own Layer, Width and
// Net, the Technical Layers group, and "Pattern Properties"; the target rows follow the tuning mode
const TUNING_MODES: [string, string][] = [["single", "Single track"], ["diff_pair", "Differential pair"], ["diff_pair_skew", "Diff pair skew"]];
const MEANDER_SIDES: [string, string][] = [["left", "Left"], ["right", "Right"], ["default", "Default"]];
function tuningPatternProps(it: KItem, doc: KDoc): PropDef[] {
  const h = H(), PT = "Pattern Properties", TL = "Technical Layers";
  const members = (x: KItem) => ((window.KiCadCanvas as unknown as { groupMemberIds(n: SNode): string[] }).groupMemberIds(x.node)).map((id) => doc.items.get(id)).filter((m): m is KItem => !!m && (m.kind === "segment" || m.kind === "arc"));
  const firstTrack = (x: KItem) => members(x)[0] || null;
  const numKid = (n: SNode, k: string, d: number | null = null) => { const c = h.kid(n, k); return c ? h.num(c[1]) : d; };
  const setNum = (n: SNode, k: string, v: number) => { const c = h.kid(n, k); if (c) c.splice(1, c.length - 1, r6(v)); else h.setKid(n, k, [r6(v)], ["members"]); };
  const strKid = (n: SNode, k: string) => h.str((h.kid(n, k) || [])[1] || "");
  const yn = (n: SNode, k: string, d: boolean) => { const c = h.kid(n, k); return c ? h.str(c[1]) === "yes" : d; };
  const setYn = (n: SNode, k: string, v: boolean) => { const c = h.kid(n, k); if (c) c.splice(1, c.length - 1, v ? "yes" : "no"); else h.setKid(n, k, [v ? "yes" : "no"], ["members"]); };
  const xyOf = (n: SNode, k: string): [number, number] | null => { const c = h.kid(n, k), q = c && h.kid(c, "xy"); return q ? [h.num(q[1]), h.num(q[2])] : null; };
  const setXy = (n: SNode, k: string, i: 1 | 2, v: number) => { const c = h.kid(n, k), q = c && h.kid(c, "xy"); if (!q) return false; q[i] = r6(v); };
  const mode = (x: KItem) => strKid(x.node, "tuning_mode") || "single";
  const timeDomain = (x: KItem) => yn(x.node, "is_time_domain", false);
  const nets: [string, string][] = [["", "<no net>"], ...h.boardNetNames(doc).filter(Boolean).map((n): [string, string] => [n, unescapeString(n)])];
  const pos = (name: string, i: 1 | 2): PropDef => ({ group: BASIC, name, type: "coord", get: (x) => (xyOf(x.node, "origin") || [0, 0])[i - 1],
    // PCB_GENERATOR::SetPosition moves the pattern: its origin and end shift, Update re-tunes it on the track there
    set: (n, v) => { const o = xyOf(n, "origin"); if (!o) return false; const d = (v as number) - o[i - 1]; setXy(n, "origin", i, o[i - 1] + d); const e = xyOf(n, "end"); if (e) setXy(n, "end", i, e[i - 1] + d); } });
  const layers = (n: SNode): string[] => { const l = h.kid(n, "layers"); if (l) return l.slice(1).map((x) => h.str(x)); const s = h.kid(n, "layer"); return s ? [h.str(s[1])] : []; };
  const defs: PropDef[] = [
    pos("Position X", 1), pos("Position Y", 2),
    { group: BASIC, name: "Layer", type: "enum", choices: layerChoices(doc, true), get: (x) => strKid(x.node, "layer") || "F.Cu", set: (n, v) => { h.setLayer(n, String(v)); },
      member: (n, v) => { const l = h.kid(n, "layers"); if (l) { const rest = l.slice(2); l.splice(1, l.length - 1, String(v), ...rest); return; } h.setLayer(n, String(v)); } },
    lockedProp(),
    { group: BASIC, name: "Width", type: "length", get: (x) => { const t = firstTrack(x); return t ? h.num((h.kid(t.node, "width") || [])[1], 0.25) : numKid(x.node, "last_track_width", 0.25); },
      set: (n, v) => { if (!((v as number) > 0)) return false; setNum(n, "last_track_width", v as number); }, member: (n, v) => { if (!((v as number) > 0)) return false; h.setWidth(n, v as number); } },
    { group: BASIC, name: "Net", type: "enum", choices: nets, get: (x) => { const t = firstTrack(x); return t ? h.netNameOf(doc, t.node) || "" : ""; },
      set: (n, v) => { const c = h.kid(n, "last_netname"); if (c) c.splice(1, c.length - 1, String(v || "")); }, member: (n, v) => { if (h.netNameOf(doc, n) === String(v || "")) return false; setNet(doc, n, String(v || "")); } },
    { group: TL, name: "Soldermask", type: "bool", get: (x) => { const t = firstTrack(x); return t ? layers(t.node).some((l) => /\.Mask$/.test(l)) : true; }, set: () => true,
      member: (n, v) => { const ls = layers(n); const cu = ls.find((l) => /\.Cu$/.test(l)) || ls[0]; if (!cu) return false; const mask = cu === "F.Cu" ? "F.Mask" : cu === "B.Cu" ? "B.Mask" : ""; if (!mask) return false;
        h.delKid(n, "layer"); h.delKid(n, "layers"); h.setKid(n, v ? "layers" : "layer", v ? [cu, mask] : [cu], ["solder_mask_margin", "net", "uuid", "tstamp"]); } },
    { group: TL, name: "Soldermask Margin Override", type: "length", get: (x) => { const t = firstTrack(x), c = t && h.kid(t.node, "solder_mask_margin"); return c ? h.num(c[1]) : null; }, set: () => true,
      member: (n, v) => { if (v === null || v === "" || Number.isNaN(v as number)) h.delKid(n, "solder_mask_margin"); else h.setKid(n, "solder_mask_margin", [r6(v as number)], ["net", "uuid", "tstamp"]); } },
    { group: PT, name: "End X", type: "coord", get: (x) => (xyOf(x.node, "end") || [0, 0])[0], set: (n, v) => setXy(n, "end", 1, v as number) },
    { group: PT, name: "End Y", type: "coord", get: (x) => (xyOf(x.node, "end") || [0, 0])[1], set: (n, v) => setXy(n, "end", 2, v as number) },
    { group: PT, name: "Tuning Mode", type: "enum", choices: TUNING_MODES, get: (x) => mode(x) },   // NO_SETTER
    { group: PT, name: "Min Amplitude", type: "length", get: (x) => numKid(x.node, "min_amplitude", 0.2), set: (n, v) => setNum(n, "min_amplitude", v as number) },
    { group: PT, name: "Max Amplitude", type: "length", get: (x) => numKid(x.node, "max_amplitude", 1), set: (n, v) => setNum(n, "max_amplitude", v as number) },
    { group: PT, name: "Initial Side", type: "enum", choices: MEANDER_SIDES, get: (x) => strKid(x.node, "initial_side") || "default", set: (n, v) => { const c = h.kid(n, "initial_side"); if (c) c.splice(1, c.length - 1, String(v)); else h.setKid(n, "initial_side", [String(v)], ["members"]); } },
    { group: PT, name: "Min Spacing", type: "length", get: (x) => numKid(x.node, "min_spacing", 0.6), set: (n, v) => setNum(n, "min_spacing", v as number) },
    { group: PT, name: "Corner Radius %", type: "int", get: (x) => numKid(x.node, "corner_radius_percent", 80), set: (n, v) => setNum(n, "corner_radius_percent", Math.round(v as number)) },
  ];
  // SetAvailableFunc: Target Length (length, space domain), Target Delay (time domain), Target Skew / Target Skew Delay (skew)
  const skew = mode(it) === "diff_pair_skew", td = timeDomain(it);
  const target = (name: string, key: string, type: PropType): PropDef => ({ group: PT, name, type, get: (x) => numKid(x.node, key, null),
    set: (n, v) => { const o = v as number; setNum(n, key, o); setNum(n, key + "_min", o - 0.1); setNum(n, key + "_max", o + 0.1); } });   // DEFAULT_LENGTH_TOLERANCE
  if (!skew && !td) defs.push(target("Target Length", "target_length", "length"));
  if (!skew && td) defs.push(target("Target Delay", "target_delay", "number"));
  if (skew && !td) defs.push(target("Target Skew", "target_skew", "coord"));
  if (skew && td) defs.push(target("Target Skew Delay", "target_skew_delay", "number"));
  defs.push(
    { group: PT, name: "Override Custom Rules", type: "bool", get: (x) => yn(x.node, "override_custom_rules", false), set: (n, v) => setYn(n, "override_custom_rules", !!v) },
    { group: PT, name: "Single-sided", type: "bool", get: (x) => yn(x.node, "single_sided", false), set: (n, v) => setYn(n, "single_sided", !!v) },
    { group: PT, name: "Rounded", type: "bool", get: (x) => yn(x.node, "rounded", true), set: (n, v) => setYn(n, "rounded", !!v) });
  return defs;
}
// DIMENSION_DESC / ALIGNED_DIMENSION_DESC (pcbnew/pcb_dimension.cpp): the rows read and write what the Dimension
// Properties dialog does (dimDialogValues / applyDimDialog), so the geometry and the text are rebuilt the same way
const DIM_PRECISIONS: [string, string][] = ["0", "0.0", "0.00", "0.000", "0.0000", "0.00000", "0.00 in / 0 mils / 0.0 mm", "0.000 / 0 / 0.00", "0.0000 / 0.0 / 0.000", "0.00000 / 0.00 / 0.0000"].map((l, i): [string, string] => [String(i), l]);
function dimensionProps(it: KItem, doc: KDoc): PropDef[] {
  const h = H(), D = "Dimension Properties", T = "Text Properties";
  const type = (n: SNode) => h.str((h.kid(n, "type") || [])[1]) || "aligned";
  const leader = type(it.node) === "leader", center = type(it.node) === "center", aligned = type(it.node) === "aligned" || type(it.node) === "orthogonal";
  const valueMode = type(it.node) === "aligned" || type(it.node) === "orthogonal" || type(it.node) === "radial";   // DimensionHasValueMode
  const apply = (n: SNode, patch: Partial<DimDialogValues>) => { const out = applyDimDialog(n, Object.assign(dimDialogValues(n), patch)); n.splice(0, n.length, ...out); };
  const row = <Kk extends keyof DimDialogValues>(group: string, name: string, key: Kk, ptype: PropType, extra?: Partial<PropDef>): PropDef => Object.assign({ group, name, type: ptype,
    get: (x: KItem) => { const v = dimDialogValues(x.node)[key]; return ptype === "enum" ? String(v) : (v as Raw); },
    set: (n: SNode, v: Raw) => { const cur = dimDialogValues(n)[key]; apply(n, { [key]: typeof cur === "number" ? +(v as number) : typeof cur === "boolean" ? !!v : String(v) } as Partial<DimDialogValues>); } }, extra || {});
  const out: PropDef[] = [
    { group: BASIC, name: "Layer", type: "enum", choices: layerChoices(doc, false), get: (x) => dimDialogValues(x.node).layer, set: (n, v) => apply(n, { layer: String(v) }) },
    lockedProp()];
  if (!leader) out.push(row(D, "Prefix", "prefix", "text"), row(D, "Suffix", "suffix", "text"));
  if (center) out.push({ group: D, name: "Override Text", type: "text", get: (x) => { const f = h.kid(x.node, "format"), o = f && h.kid(f, "override_value"); return o ? h.str(o[1]) : ""; },
    set: (n, v) => { const f = h.kid(n, "format"); if (!f) return false; if (String(v)) h.setKid(f, "override_value", [String(v)], ["suppress_zeroes"]); else h.delKid(f, "override_value"); } });
  if (valueMode) out.push(
    { group: D, name: "Value Mode", type: "enum", choices: [["0", "Driven"], ["1", "Driving"], ["2", "Arbitrary"]], get: (x) => (dimDialogValues(x.node).arbitrary ? "2" : "0"),
      // DimensionCanDrive: both ends bound to objects by constraints, which a board here does not hold
      validate: (v) => (v === "1" ? "Driving requires both dimension endpoints bound to objects" : null), set: (n, v) => apply(n, { arbitrary: v === "2" }) },
    // Driven mirrors the measured geometry, so the row is greyed out
    { group: D, name: "Value", type: "text", canWrite: (x) => dimDialogValues(x.node).arbitrary, get: (x) => dimDialogValues(x.node).value, set: (n, v) => apply(n, { arbitrary: true, value: String(v) }) });
  if (leader) out.push(row(D, "Text", "value", "text"));
  if (!leader) out.push(
    row(D, "Units", "unitsMode", "enum", { choices: [["0", "Inches"], ["1", "Mils"], ["2", "Millimeters"], ["3", "Automatic"]] }),
    row(D, "Units Format", "unitsFormat", "enum", { choices: [["0", "1234.0"], ["1", "1234.0 mm"], ["2", "1234.0 (mm)"]] }),
    row(D, "Precision", "precision", "enum", { choices: DIM_PRECISIONS }),
    row(D, "Suppress Trailing Zeroes", "suppressZeroes", "bool"));
  if (aligned) out.push({ group: D, name: "Arrow Direction", type: "enum", choices: [["inward", "Inward"], ["outward", "Outward"]], get: (x) => (dimDialogValues(x.node).arrowInward ? "inward" : "outward"), set: (n, v) => apply(n, { arrowInward: v === "inward" }) });
  out.push(row(D, "Line Thickness", "lineThickness", "length"));
  if (!center) out.push(row(D, "Arrow Length", "arrowLength", "length"), row(D, "Extension Line Offset", "extOffset", "length"));
  if (aligned) {
    type DT = { dimRead(n: SNode): { height: number }; dimUpdate(m: unknown): unknown; dimWrite(n: SNode, m: unknown): SNode };
    const P = pcbTools() as unknown as DT | null;
    if (P && P.dimRead) out.push({ group: D, name: "Crossbar Height", type: "coord", get: (x) => P.dimRead(x.node).height / 1e6,
      set: (n, v) => { const m = P.dimRead(n); m.height = Math.round((v as number) * 1e6); P.dimUpdate(m); const o = P.dimWrite(n, m); n.splice(0, n.length, ...o); } });
    out.push(row(D, "Extension Line Overshoot", "extHeight", "length"));
  }
  if (!center) {
    if (!leader) out.push(row(T, "Text Position", "posMode", "enum", { choices: [["0", "Outside"], ["1", "Inline"], ["2", "Manual"]] }));
    out.push(row(T, "Keep Aligned with Dimension", "keepAligned", "bool"),
      row(T, "Orientation", "angle", "angle", { canWrite: (x: KItem) => !dimDialogValues(x.node).keepAligned }),
      row(T, "Auto Thickness", "autoThickness", "bool"), row(T, "Thickness", "textThick", "length", { canWrite: (x: KItem) => !dimDialogValues(x.node).autoThickness }),
      row(T, "Italic", "italic", "bool"), row(T, "Bold", "bold", "bool"), row(T, "Mirrored", "mirrored", "bool"),
      row(T, "Width", "textW", "length"), row(T, "Height", "textH", "length"),
      row(T, "Horizontal Justification", "hJustify", "enum", { choices: [["left", "Left"], ["center", "Center"], ["right", "Right"]] }));
  }
  return out;
}
function pcbProps(it: KItem, doc: KDoc, single: boolean): PropDef[] {
  const h = H();
  if (it.kind === "generated" && h.str((h.kid(it.node, "type") || [])[1]) === "tuning_pattern") return tuningPatternProps(it, doc);
  switch (it.kind) {
    case "footprint": return footprintProps(it, doc, single);
    // PCB_TRACK_DESC: BOARD_ITEM's Locked, the copper Layer and the Net, then the track's own rows and Technical Layers
    case "segment": case "arc": return [lockedProp(), trackLayerProp(doc), ...netProps(doc),
      { group: BASIC, name: "Width", type: "length", get: (x) => h.num((h.kid(x.node, "width") || [])[1], 0.25), set: (n, v) => { if (!((v as number) > 0)) return false; h.setWidth(n, v as number); }, suggest: trackWidthList },
      xyProp(BASIC, "Start X", "start", 1), xyProp(BASIC, "Start Y", "start", 2), xyProp(BASIC, "End X", "end", 1), xyProp(BASIC, "End Y", "end", 2),
      ...techLayerProps()];
    case "via": return viaProps(doc);
    case "pad": if ((doc as unknown as { fpEditor?: boolean }).fpEditor) return fpEditorPadProps(doc, it); break;
    case "zone": return zoneProps(it, doc);
    case "gr_line": case "gr_rect": case "gr_circle": case "gr_arc": case "gr_poly": case "gr_curve": return boardShapeProps(it, doc);
    case "gr_text": return boardTextProps(doc);
    case "gr_text_box": return h.kid(it.node, "start") ? boardTextBoxProps(doc) : boardTextProps(doc).filter((d) => !/^Position|^Orientation/.test(d.name));
    case "dimension": return dimensionProps(it, doc);
    // PCB_GROUP_DESC: BOARD_ITEM's Locked (a group has no position or layer rows) and "Group Properties" / Name
    case "group": return [lockedProp(), { group: "Group Properties", name: "Name", type: "text", get: (x) => (typeof x.node[1] === "string" ? h.str(x.node[1]) : ""),
      set: (n, v) => { if (typeof n[1] === "string") n[1] = String(v); else n.splice(1, 0, String(v)); } }];
    default: break;
  }
  const out: PropDef[] = [];
  if (h.kid(it.node, "at")) out.push(atProp("Position X", 1), atProp("Position Y", 2));
  if (h.kid(it.node, "layer")) out.push(layerProp(doc, false, "Dwgs.User"));
  out.push(lockedProp());
  return out;
}
/**
 * A pad of the footprint open in the Footprint Editor is its own item (its node is the (pad …)): PAD_DESC's rows as the
 * board shows them for a footprint's pad, run over the pad wrapped in a footprint at the origin (the editor's footprint
 * sits at 0,0 unrotated, so its local position and angle are the absolute ones).  A library footprint has no nets, so
 * the Net rows are left out.
 */
function fpEditorPadProps(doc: KDoc, it: KItem): PropDef[] {
  const wrapNode = (n: SNode): SNode => ["footprint", "", ["at", 0, 0], n] as unknown as SNode;
  const wrap = (x: KItem): KItem => Object.assign({}, x, { node: wrapNode(x.node) });
  return padDefs(doc, 0).filter((d) => d.name !== "Net" && d.name !== "Pin Name" && d.name !== "Pin Type" && (!d.avail || d.avail(wrap(it)))).map((d): PropDef => Object.assign({}, d, {
    get: (x: KItem) => d.get(wrap(x)),
    avail: d.avail ? (x: KItem) => d.avail!(wrap(x)) : undefined,
    canWrite: d.canWrite ? (x: KItem) => d.canWrite!(wrap(x)) : undefined,
    set: d.set ? (n: SNode, v: Raw, it: KItem) => d.set!(wrapNode(n), v, wrap(it)) : undefined,
  }));
}

// ---------------------------------------------------------------- the grid
const FRIENDLY: Record<string, string> = { symbol: "Symbol", footprint: "Footprint", wire: "Wire", bus: "Bus", polyline: "Graphic Line", segment: "Track", arc: "Arc", via: "Via", label: "Label", global_label: "Global Label",
  hierarchical_label: "Hierarchical Label", netclass_flag: "Directive Label", directive_label: "Directive Label", text: "Text", gr_text: "Text", text_box: "Text Box", gr_text_box: "Text Box", junction: "Junction", zone: "Zone",
  no_connect: "No-Connect", bus_entry: "Bus Entry", pad: "Pad", sheet: "Sheet", gr_line: "Segment", gr_rect: "Rectangle", gr_circle: "Circle", gr_arc: "Arc", gr_poly: "Polygon", gr_curve: "Curve", rectangle: "Rectangle", circle: "Circle",
  bezier: "Bezier", rule_area: "Rule Area", dimension: "Dimension", group: "Group", image: "Image", table: "Table" };
/** GetFriendlyName (the panel's caption for one item): PCB_ARC "Track (arc)", ZONE by what it is, PCB_SHAPE by its shape, … */
function friendly(it: KItem): string {
  if (it.docType === "pcb") {
    const h = H();
    if (it.kind === "arc") return "Track (arc)";
    if (it.kind === "zone") { const a = h.kid(it.node, "attr"); if (h.kid(it.node, "keepout")) return "Rule Area"; if (a && h.kid(a, "teardrop")) return "Teardrop Area";
      const s = h.kid(it.node, "layer"), m = h.kid(it.node, "layers"), l = s ? h.str(s[1]) : m ? h.str(m[1]) : ""; return /\.Cu$/.test(l) ? "Copper Zone" : "Non-copper Zone"; }
    if (it.kind === "image") return "Reference Image";
    if (it.kind === "dimension" && h.str((h.kid(it.node, "type") || [])[1]) === "leader") return "Leader";
  }
  return it.kind === "generated" ? "Tuning Pattern" : FRIENDLY[it.kind] || it.kind;
}

function trimNum(v: number, digits: number): string { let t = v.toFixed(digits); if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, ""); return t === "-0" ? "0" : t; }
/** A coordinate row's axis (PROPERTY::SetCoordType ABS_X_COORD / ABS_Y_COORD): "Position X", "Start Y", "End X" … */
function coordAxis(def: PropDef): "x" | "y" | null { return def.type !== "coord" ? null : / X$/.test(def.name) ? "x" : / Y$/.test(def.name) ? "y" : null; }
function show(def: PropDef, raw: Raw): string {
  if (raw === null || raw === undefined) return "";
  const ax = coordAxis(def);   // PGPropertyFactory: board coordinates through the frame's ORIGIN_TRANSFORMS
  if (ax) return H().formatLength(toDisplayAbsAxis(raw as number, ax), String(E.units || "mm"));
  switch (def.type) {
    case "length": case "coord": return H().formatLength(raw as number, String(E.units || "mm"));
    case "angle": return trimNum(raw as number, 4) + "°";
    case "time": return trimNum(raw as number, 4) + " ps";   // PGPROPERTY_TIME in the frame's time unit
    case "number": return trimNum(raw as number, 6);
    case "int": return String(Math.round(raw as number));
    case "bool": return raw ? "1" : "0";
    default: return String(raw);
  }
}
function defsOf(it: KItem, doc: KDoc, single: boolean): PropDef[] { try { return isSchDoc() ? schProps(it, doc).concat(customPropDefs(it)) : pcbProps(it, doc, single).concat(it.kind === "generated" ? [] : customPropDefs(it)); } catch (e) { console.warn(e); return []; } }
const defId = (d: PropDef) => d.group + "/" + d.name;

/**
 * MATCH_PROPERTIES_CATALOG::Copy over this grid's properties: each [source name, target name, optional] pair read off
 * the source and staged on a clone of the target (a property the source cannot write, or the target does not have or
 * cannot take, is skipped; across kinds an optional one that will not go is dropped, otherwise it is an error).  The
 * change replaces the target with the clone; changed counts the values that differed.
 */
export function copyItemProps(source: KItem, target: KItem, pairs: [string, string, boolean][]): { changed: number; error?: string; change?: KChange } {
  const doc = kdoc(); if (!doc) return { changed: 0 };
  const byName = (it: KItem) => { const m = new Map<string, PropDef>(); for (const d of defsOf(it, doc, true)) if (!m.has(d.name)) m.set(d.name, d); return m; };
  const sd = byName(source), td = byName(target);
  const node = K().cloneNode(target.node), staged = Object.assign({}, target, { node }) as KItem;
  let changed = 0;
  for (const [sn, tn, optional] of pairs) {
    const s = sd.get(sn), t = td.get(tn); if (!s || !t || !s.set || !t.set || s.local || t.local) continue;
    if ((s.avail && !s.avail(source)) || (s.canWrite && !s.canWrite(source))) continue;
    if ((t.avail && !t.avail(staged)) || (t.canWrite && !t.canWrite(staged))) continue;
    if (s.type !== t.type) { if (optional) continue; return { changed: 0, error: `Could not apply property '${tn}' to the target item.` }; }
    let v: Raw; try { v = s.get(source); } catch (e) { continue; }
    if (v === null && !s.optional) continue;   // IsIndeterminate: nothing single to copy
    let cur: Raw = null; try { cur = t.get(staged); } catch (e) { cur = null; }
    if (t.type === "bool" ? !!cur === !!v : show(t, cur) === show(t, v)) continue;
    let res: boolean | void = false; try { res = t.set(node, v, staged); } catch (e) { res = false; }
    if (res === false) { if (optional) continue; return { changed: 0, error: `Could not apply property '${tn}' to the target item.` }; }
    changed++;
  }
  if (!changed) return { changed: 0 };
  return { changed, change: K().replaceChange(doc, Object.assign({}, target, { node, geom: [], bbox: null })) };
}
/** The names of the properties this grid shows for an item. */
export function itemPropNames(it: KItem): Set<string> { const doc = kdoc(); return new Set(doc ? defsOf(it, doc, true).filter((d) => d.set && !d.local).map((d) => d.name) : []); }

/** A COLOR4D property over a (color r g b a) node: "" is COLOR4D::UNSPECIFIED (all zero, or no node). */
function colorProp(group: string, name: string, find: (n: SNode) => SNode | null, put: (n: SNode, rgba: number[]) => void): PropDef {
  return { group, name, type: "color",
    get: (it) => { const c = find(it.node); if (!c || (!H().num(c[4]) && !H().num(c[1]) && !H().num(c[2]) && !H().num(c[3]))) return ""; return colorText([1, 2, 3].map((i) => H().num(c[i])), c.length > 4 ? H().num(c[4]) : 1); },
    set: (n, v) => { put(n, parseColorText(String(v || "")) || [0, 0, 0, 0]); } };
}
/** SCH_SHEET::GetFullRefSuffixProp: the reference suffix of the sheet's instance under the sheet on screen (the path's
 *  "Reference Suffix" fields, root first, then the sheet's own). */
function sheetFullSuffix(node: SNode): string {
  let up = "";
  try {
    const c = netMap(), here = currentInstance(c);
    if (c && here) {
      const nodes: (SNode | null)[] = [];
      for (const id of here.uuidPath.slice(1)) { let hit: SNode | null = null; for (const d of c.docs.values()) { const it = d.items.get(id); if (it && it.kind === "sheet") { hit = it.node; break; } } nodes.push(hit); }
      up = composeRefSuffix(nodes);
    }
  } catch (e) { up = ""; }
  return up + composeRefSuffix([node]);
}

interface Resolved { items: KItem[]; defs: Map<string, PropDef>[]; shared: PropDef[] }
/** A selected tuning pattern is its generator with its members: KiCad's selection holds the one PCB_GENERATOR. */
function patternSelection(items: KItem[]): KItem | null {
  const P = pcbTools(); if (isSchDoc() || !P || !P.selectedTuningPattern || items.length < 1) return null;
  try { return P.selectedTuningPattern(tctx(), items.map((it) => it.id)); } catch (e) { return null; }
}
function resolve(): Resolved {
  const doc = kdoc(); let items = selectedItems(); if (!doc || !items.length) return { items: [], defs: [], shared: [] };
  const gen = patternSelection(items); if (gen) items = [gen];
  const defs = items.map((it) => new Map(defsOf(it, doc, items.length === 1).map((d): [string, PropDef] => [defId(d), d])));
  // SCH_PROPERTIES_PANEL::rebuildProperties: with junctions and wires / buses selected together, dummy "Wire Style" and
  // "Line Width" on the junctions and a dummy "Diameter" on the lines keep those three common; a change reaches the
  // items that really have the property
  if (isSchDoc() && items.some((it) => it.kind === "junction") && items.some((it) => it.kind === "wire" || it.kind === "bus")) {
    const stand = (name: string, type: PropType, choices?: [string, string][]): PropDef => ({ group: BASIC, name, type, choices, dummy: true, get: () => null });
    items.forEach((it, i) => {
      const add = (d: PropDef): void => { if (!defs[i].has(defId(d))) defs[i].set(defId(d), d); };
      if (it.kind === "junction") { add(stand("Wire Style", "enum", LINE_STYLES)); add(stand("Line Width", "length")); }
      else if (it.kind === "wire" || it.kind === "bus") add(stand("Diameter", "length"));
    });
  }
  const shared: PropDef[] = [];
  // the row is described by an item that has the property (the first item's may be the stand-in)
  const real = (id: string): PropDef | undefined => { for (const m of defs) { const o = m.get(id); if (o && !o.dummy) return o; } return undefined; };
  for (const d0 of defs[0].values()) { const d = d0.dummy ? real(defId(d0)) : d0; if (!d) continue;     if (defs.every((m) => { const o = m.get(defId(d)); return !!o && o.type === d.type; })) shared.push(d); }
  return { items, defs, shared };
}

/**
 * DIALOG_FIND_BY_PROPERTIES::itemMatchesPropertyCriteria's value of one property of any item, as the grid shows it;
 * undefined when the item has no such property (PROPERTY_MANAGER::GetProperty / IsAvailableFor).
 */
export function itemPropText(it: KItem, id: string): string | undefined {
  const doc = kdoc(); if (!doc) return undefined;
  const d = defsOf(it, doc, false).find((x) => defId(x) === id); if (!d || (d.avail && !d.avail(it))) return undefined;
  let raw: Raw = null; try { raw = d.get(it); } catch (e) { raw = null; }
  return show(d, raw);
}

export function propGrid(): PropGrid {
  const doc = kdoc();
  if (!doc) return { title: "No objects selected", count: 0, groups: [], readOnly: true };
  const { items, defs, shared } = resolve(); const ro = !!E.viewOnly;
  if (!items.length && E.selPins.length && isSchDoc()) { const g = pinGrid(doc); if (g) return g; }
  if (!items.length && isSchDoc()) { const picks = fieldPicks(doc); if (picks.length) return fieldGrid(doc, picks, ro); }
  if (!items.length) { const pads = selectedPads(); if (pads.length) return padGrid(doc, pads, ro); }
  if (!items.length) return { title: "No objects selected", count: 0, groups: [], readOnly: ro };
  const groups: PropGroup[] = [];
  for (const d of shared) {
    const id = defId(d); let value = "", mixed = false, first = true, writable = true;
    items.forEach((it, i) => {
      const own = defs[i].get(id)!; if (own.dummy) return;   // a stand-in has no value: the row shows the others'
      if ((!own.set && !own.local) || (own.canWrite && !own.canWrite(it))) writable = false;
      let raw: Raw = null; try { raw = own.get(it); } catch (e) { raw = null; }
      const text = show(own, raw);
      if (first) { value = text; first = false; } else if (text !== value) mixed = true;
    });
    const row: PropRow = { id, name: d.name, type: d.type, value: mixed ? "" : value, mixed, readOnly: ro || !writable, choices: d.choices };
    if (d.key && !ro && items.length === 1) row.keyEditable = true;   // isKeyEditable looks at the front item
    if (d.type === "enum" && d.group === BASIC && d.name === "Net" && !isSchDoc()) row.netSelector = true;   // PG_NET_SELECTOR_EDITOR
    if (d.suggest) { const u = String(E.units || "mm"); row.suggest = d.suggest().map((mm) => H().formatLength(mm, u)); }
    // SCH_PROPERTIES_PANEL / PCB_PROPERTIES_PANEL::createPGProperty: the Footprint and Datasheet properties get
    // PG_FPID_EDITOR and PG_URL_EDITOR (an editor only an editable row opens)
    if (d.group === "Fields" && d.type === "text" && !row.readOnly) { if (d.name === "Footprint") row.browse = "footprint"; else if (d.name === "Datasheet") row.browse = "url"; }
    let g = groups.find((x) => x.name === d.group); if (!g) { g = { name: d.group, rows: [] }; groups.push(g); }
    g.rows.push(row);
  }
  // PROPERTIES_PANEL::rebuildProperties: the Custom Properties group always shows (its "+" button is the way to add
  // one); the category buttons are PCB_PROPERTIES_PANEL's / SCH_PROPERTIES_PANEL's "Add Custom Property" and "Add
  // Field" (a field goes on the selected footprints, or the selected symbols and sheets)
  if (!(items.length === 1 && items[0]!.kind === "generated")) {
    if (!groups.some((g) => g.name === CUSTOM_GROUP)) groups.push({ name: CUSTOM_GROUP, rows: [] });
    const fieldKinds = isSchDoc() ? ["symbol", "sheet"] : ["footprint"];
    for (const g of groups) {
      if (ro) break;
      if (g.name === CUSTOM_GROUP) g.add = "Add Custom Property";
      else if (g.name === "Fields" && items.some((it) => fieldKinds.includes(it.kind))) g.add = "Add Field";
      // SCH_PROPERTIES_PANEL: the Pin Map category's "Edit Pin Map..." button, for one pin-mapped symbol
      else if (g.name === "Pin Map" && items.length === 1) g.add = "Edit Pin Map...";
    }
  }
  const kinds = new Set(items.map(friendly));
  const title = items.length === 1 ? friendly(items[0]) : `${items.length} objects selected`;
  return { title, count: items.length, groups, readOnly: ro, note: items.length > 1 && kinds.size > 1 ? Array.from(kinds).join(", ") : undefined };
}

/** Selected bare pins (SCH_PIN_T): SCH_PIN's rows, all read-only in the schematic editor; a row whose value differs
 *  between the pins shows blank (mixed), as PROPERTIES_PANEL does for a multiple selection. */
function pinGrid(doc: KDoc): PropGrid | null {
  const T = window.CollabTools.sch && window.CollabTools.sch._ as unknown as { pinProperties?(d: KDoc, r: unknown): { name: string; type: PropType; value: string | number; choices?: [string, string][] }[] | null };
  if (!T || !T.pinProperties) return null;
  const all = (E.selPins as unknown[]).map((p) => T.pinProperties!(doc, p)).filter((r): r is NonNullable<typeof r> => !!r); if (!all.length) return null;
  const text = (r: { type: PropType; value: string | number }) => (r.type === "length" ? H().formatLength(r.value as number, String(E.units || "mm")) : String(r.value));
  const out: PropRow[] = all[0].filter((r) => all.every((rows) => rows.some((q) => q.name === r.name))).map((r) => {
    const vals = all.map((rows) => text(rows.find((q) => q.name === r.name)!)); const mixed = vals.some((v) => v !== vals[0]);
    return { id: BASIC + "/" + r.name, name: r.name, type: r.type, mixed, readOnly: true, choices: r.choices, value: mixed ? "" : vals[0] };
  });
  return { title: all.length === 1 ? "Pin" : `${all.length} objects selected`, count: all.length, groups: [{ name: BASIC, rows: out }], readOnly: true };
}

/** Parse the text of a row into the raw value its setter takes; a string return is the error to show. */
function parse(def: PropDef, text: string): { v: Raw } | string {
  const t = String(text);
  if (def.optional && !t.trim()) return { v: null };   // std::optional: an empty cell clears the value
  switch (def.type) {
    case "length": case "coord": { const v = H().evalExpr(t, String(E.units || "mm")); if (Number.isNaN(v)) return "Not a valid length"; const ax = coordAxis(def); return { v: ax ? r6(fromDisplayAbsAxis(v, ax)) : v }; }
    case "angle": { const v = H().evalExpr(t.replace(/°|deg/gi, ""), ""); if (Number.isNaN(v)) return "Not a valid angle"; return { v }; }
    case "number": { const v = H().evalExpr(t, ""); if (Number.isNaN(v)) return "Not a valid number"; return { v }; }
    case "time": { const m = /^\s*(.*?)\s*(fs|ps|ns)?\s*$/i.exec(t)!; const v = H().evalExpr(m[1], ""); if (Number.isNaN(v)) return "Not a valid time"; const u = (m[2] || "ps").toLowerCase(); return { v: u === "fs" ? v / 1000 : u === "ns" ? v * 1000 : v }; }
    case "int": { const v = H().evalExpr(t, ""); if (Number.isNaN(v)) return "Not a valid number"; return { v: Math.round(v) }; }
    case "bool": return { v: t === "1" || t === "true" };
    case "enum": if (def.choices && !def.choices.some((c) => c[0] === t)) return "Not one of the choices"; return { v: t };
    case "color": if (t && !parseColorText(t)) return "Not a colour"; return { v: t };
    default: return { v: t };
  }
}

// ---------------------------------------------------------------- a schematic field selected on its own
/** SCH_FIELD items in the selection (a field picked by itself, not through its symbol or sheet). */
interface FieldPick { it: KItem; name: string }
function fieldPicks(doc: KDoc): FieldPick[] {
  const out: FieldPick[] = [];
  for (const f of selectedFields()) { const it = doc.items.get(f.id); if (it && fieldNodeOf(it.node, f.name)) out.push({ it, name: f.name }); }
  return out;
}
/** The parent's own row for the field's text: the symbol's field property (the reference through its instance data,
 *  a variant's override when one is current) or the sheet's (the name validated, the file name read-only). */
function parentTextDef(doc: KDoc, p: FieldPick): PropDef | null {
  if (p.it.kind !== "symbol" && p.it.kind !== "sheet") return null;
  const row = parentFieldRow(p.it.kind, p.name);
  return defsOf(p.it, doc, false).find((d) => d.group === "Fields" && d.name === row) || null;
}
/** IsGeneratedField (common/common.cpp): a field whose name is a text variable or an expression. */
const isGeneratedField = (name: string): boolean => /^(\$\{[\w.]*\}|@\{.*\})$/.test(name);
function fieldDefs(doc: KDoc): FieldProp[] { return schFieldProps(facesUsed(doc), (t) => parseColorText(t)); }
const asDef = (d: FieldProp): PropDef => ({ group: d.group, name: d.name, type: d.type, choices: d.choices, get: () => null });
function fieldGrid(doc: KDoc, picks: FieldPick[], ro: boolean): PropGrid {
  const groups: PropGroup[] = [];
  for (const d of fieldDefs(doc)) {
    const def = asDef(d); let value = "", mixed = false, writable = true;
    picks.forEach((p, i) => {
      let raw: Raw = null;
      const own = d.name === "Text" ? parentTextDef(doc, p) : null;
      if (own) { if (!own.set && !(p.it.kind === "sheet" && /^Sheet ?file$/i.test(p.name))) writable = false; try { raw = own.get(p.it); } catch (e) { raw = null; } }
      else { const n = fieldNodeOf(p.it.node, p.name); try { raw = n ? d.get(n) : null; } catch (e) { raw = null; } }
      // OverrideWriteability( "Text" ): a generated field ("${…}" / "@{…}" as its name) is read only
      if (d.name === "Text" && isGeneratedField(p.name)) writable = false;
      const text = show(def, raw); if (i === 0) value = text; else if (text !== value) mixed = true;
    });
    const row: PropRow = { id: defId(def), name: d.name, type: d.type, value: mixed ? "" : value, mixed, readOnly: ro || !writable, choices: d.choices };
    let g = groups.find((x) => x.name === d.group); if (!g) { g = { name: d.group, rows: [] }; groups.push(g); }
    g.rows.push(row);
  }
  return { title: picks.length === 1 ? "Field" : `${picks.length} objects selected`, count: picks.length, groups, readOnly: ro };
}
/** SCH_PROPERTIES_PANEL::valueChanged for selected fields: one replace of each parent, all in one "Edit Properties"
 *  commit.  The text of a symbol's or sheet's field goes through the parent (SetRefProp, the current variant's
 *  override, the sheet name's and reference suffix's validators); a sheet's file name through
 *  handleSheetFilenameChange (changeSheetFileProp), which links or creates the file. */
function setFieldProp(doc: KDoc, picks: FieldPick[], id: string, text: string): string | null {
  const d = fieldDefs(doc).find((x) => defId(asDef(x)) === id); if (!d) return "No such property";
  const parsed = parse(asDef(d), text); if (typeof parsed === "string") return parsed;
  const isText = d.name === "Text";
  // a sheet's file-name field: handleSheetFilenameChange (the extension, the file linked or created)
  const isFile = (p: FieldPick): boolean => isText && p.it.kind === "sheet" && /^Sheet ?file$/i.test(p.name);
  if (isText) for (const p of picks) {   // valueChanging: the value must be valid for every selected field
    if (isGeneratedField(p.name)) return "Text: read only";
    if (isFile(p)) continue;
    const own = parentTextDef(doc, p); if (!own) continue;
    const bad = own.validate ? own.validate(parsed.v, p.it) : p.it.kind === "symbol" && p.name === "Reference" ? fieldValidationError("REFERENCE", String(parsed.v)) : "";
    if (bad) return bad;
  }
  const staged = new Map<string, { it: KItem; node: SNode; touched: boolean }>();
  const files: FieldPick[] = [];
  for (const p of picks) {
    if (isFile(p)) { files.push(p); continue; }
    let s = staged.get(p.it.id); if (!s) { s = { it: p.it, node: K().cloneNode(p.it.node), touched: false }; staged.set(p.it.id, s); }
    const own = isText ? parentTextDef(doc, p) : null;
    try {
      if (own && own.set) {
        if (show(own, own.get(Object.assign({}, p.it, { node: s.node }))) === show(own, parsed.v)) continue;
        if (own.set(s.node, parsed.v, p.it) !== false) s.touched = true;
      } else {
        const n = fieldNodeOf(s.node, p.name); if (!n) continue;
        if (show(asDef(d), d.get(n)) === show(asDef(d), parsed.v)) continue;
        const next = d.set(n, parsed.v); if (next && replaceField(s.node, p.name, next)) s.touched = true;
      }
    } catch (e) { console.warn(e); }
  }
  if (files.length) {
    const ctx = Object.assign(tctx() as unknown as ToolCtx, { doc });
    void (async () => { for (const p of files) { const it = doc.items.get(p.it.id); if (it && await changeSheetFileProp(ctx, it, String(parsed.v))) panelStore.set({ selVersion: panelStore.get().selVersion + 1 }); } })();
  }
  const done = Array.from(staged.values()).filter((s) => s.touched); if (!done.length) return null;
  const changes: KChange[] = done.map((s) => K().replaceChange(doc, Object.assign({}, s.it, { node: s.node, geom: [], bbox: null })));
  // SyncOtherUnits: the value, footprint and datasheet of one symbol follow to its other units
  if (isText && done.length === 1 && done[0].it.kind === "symbol" && picks.length === 1 && SYNCED_FIELDS.has(picks[0].name)) {
    const ctx = tctx() as unknown as ToolCtx & { doc: KDoc };
    commitWithOtherUnits(Object.assign(ctx, { doc }), done[0].it, done[0].node, changes, "Edit Properties", "field:" + picks[0].name);
  } else tctx().commit(changes, "Edit Properties");
  panelStore.set({ selVersion: panelStore.get().selVersion + 1 });
  return null;
}
const SYNCED_FIELDS = new Set(["Value", "Footprint", "Datasheet"]);

const SYNCED = new Set(["Value", "Exclude From Board", "Exclude From Bill of Materials", "Exclude From Position Files", "Do not Populate", "Pin Map Mode", "Pin Map Name"]);
export function setProp(id: string, text: string): string | null {
  const doc = kdoc(); if (!doc) return "No document";
  if (E.viewOnly) return "View-only access";
  const { items, defs } = resolve();
  if (!items.length && isSchDoc()) { const picks = fieldPicks(doc); if (picks.length) return setFieldProp(doc, picks, id, text); }
  if (!items.length) { const pads = selectedPads(); if (pads.length) return setPadProp(doc, pads, id, text); }
  if (!items.length) return "Nothing selected";
  let head = defs[0].get(id); if (!head) return "No such property";
  if (head.dummy) head = defs.map((m) => m.get(id)).find((d) => !!d && !d.dummy) || head;
  const parsed = parse(head, text); if (typeof parsed === "string") return parsed;
  // PROPERTY_BASE::Validate (a sheet's name, a via's sizes …): one item that cannot take the value refuses the whole edit
  for (let i = 0; i < items.length; i++) { const d = defs[i].get(id); const err = d && d.validate ? d.validate(parsed.v, items[i]) : null; if (err) return err; }
  if (head.local) { items.forEach((it, i) => { const d = defs[i].get(id); if (d && d.local) d.local(parsed.v, it); }); panelStore.set({ selVersion: panelStore.get().selVersion + 1 }); return null; }
  const gen = items.length === 1 && items[0].kind === "generated" ? items[0] : null; const P = pcbTools();
  if (gen && P && P.editTuningPattern) {   // PCB_TUNING_PATTERN: the property, then EditStart / Update / EditFinish in one commit
    const d = defs[0].get(id); if (!d || !d.set) return null;
    let cur: Raw = null; try { cur = d.get(gen); } catch (e) { cur = null; }
    if (show(d, cur) === show(d, parsed.v) && d.type !== "bool") return null;
    const node = K().cloneNode(gen.node); if (d.set(node, parsed.v, gen) === false) return null;
    P.editTuningPattern(tctx(), gen, node, d.member ? (n: SNode) => d.member!(n, parsed.v) : null);
    panelStore.set({ selVersion: panelStore.get().selVersion + 1 });
    return null;
  }
  const changes: KChange[] = [], nodes: SNode[] = [];
  items.forEach((it, i) => {
    const d = defs[i].get(id); if (!d || !d.set) return;
    let cur: Raw = null; try { cur = d.get(it); } catch (e) { cur = null; }
    if (show(d, cur) === show(d, parsed.v) && d.type !== "bool") return;                 // unchanged: no op for this item
    if (d.type === "bool" && !!cur === !!parsed.v) return;
    const node = K().cloneNode(it.node);
    let res: boolean | void;
    try { res = d.set(node, parsed.v, it); } catch (e) { console.warn(e); return; }
    if (res === false) return;
    changes.push(K().replaceChange(doc, Object.assign({}, it, { node, geom: [], bbox: null }))); nodes.push(node);
  });
  if (!changes.length) return null;
  // SCH_SYMBOL::SyncOtherUnits( …, aProperty ): these properties follow to the other units of a multi-unit part
  if (items.length === 1 && items[0].kind === "symbol" && SYNCED.has(head.name)) {
    const node = nodes[0], ctx = tctx() as unknown as ToolCtx & { doc: KDoc };
    if (node) { commitWithOtherUnits(Object.assign(ctx, { doc }), items[0], node, changes, head.name.toLowerCase(), head.name); panelStore.set({ selVersion: panelStore.get().selVersion + 1 }); return null; }
  }
  tctx().commit(changes, head.name.toLowerCase());
  panelStore.set({ selVersion: panelStore.get().selVersion + 1 });
  return null;
}


/** SCH_PROPERTIES_PANEL's netlistCallback: the selected symbols' library symbol when they share one (else nothing),
 *  its pins sent with their numbers as they are (a stacked "[1-4]" is one pin there, unlike the fields grids'
 *  BuildFootprintChooserSymbolNetlist); the board's panel sends an empty netlist. */
function selectionFilters(doc: KDoc, items: KItem[]): FpChooserFilters | null {
  if (!isSchDoc()) return null;
  const syms = items.filter((it) => it.kind === "symbol"); if (!syms.length) return null;
  const libName = (n: SNode): string => { const k = H().kid(n, "lib_name") || H().kid(n, "lib_id"); return k ? H().str(k[1]) : ""; };
  const first = libName(syms[0].node); if (syms.some((it) => libName(it.node) !== first)) return null;
  return chooserFilters(K().resolveLib(doc, first), false);
}
/** PG_FPID_EDITOR / PG_URL_EDITOR::OnEvent( wxEVT_BUTTON ). */
/** "Edit Pin Map...": SCH_EDIT_FRAME's Symbol Properties dialog for the one selected symbol, at its Pin Map page. */
export function editPinMap(): void {
  const doc = kdoc(), items = selectedItems(); if (!doc || items.length !== 1 || !hasPinMaps(doc, items[0])) return;
  const KD = (window as unknown as { KDialogs?: { schItemDialog?(c: unknown, it: KItem, o: { pinMapPage: boolean }): boolean } }).KDialogs;
  if (KD && KD.schItemDialog) KD.schItemDialog(tctx(), items[0], { pinMapPage: true });
}
export function browseProp(id: string): void {
  const doc = kdoc(); if (!doc || E.viewOnly) return;
  const { items, defs } = resolve(); if (!items.length) return;
  const d = defs[0].get(id); if (!d) return;
  let raw: Raw = null; try { raw = d.get(items[0]); } catch (e) { raw = null; }
  const value = raw === null ? "" : String(raw), mixed = items.some((it, i) => { const o = defs[i].get(id); let v: Raw = null; try { v = o ? o.get(it) : null; } catch (e) { v = null; } return String(v ?? "") !== value; });
  if (d.name === "Datasheet") {
    // a mixed value has no one datasheet to show: the editor starts as for an empty one
    if (mixed || datasheetLink(value).kind === "none") void noFileBrowsing("property");
    // PG_URL_EDITOR::OnEvent calls GetAssociatedDocument with no embedded-files stack: a kicad-embed:// link stays unopened
    else openDatasheet(value, { files: [] });
    return;
  }
  if (d.name !== "Footprint") return;
  void chooseFootprint(mixed ? "" : value, selectionFilters(doc, items)).then((fp) => {
    if (!fp) return;
    const err = setProp(id, fp); if (err) toast(err);   // aGrid->ChangePropertyValue: one commit, one undo step
  });
}

// ---------------------------------------------------------------- the label column (PCB_PROPERTIES_PANEL key editing)
/** isKeyNameInUse: the front item already has a property of that name (a built-in one, a field or a custom one). */
function keyNameInUse(name: string): boolean {
  const doc = kdoc(); const { items } = resolve(); if (!doc || !items.length) return false;
  return defsOf(items[0]!, doc, items.length === 1).some((d) => d.name === name);
}
/** The commit of an edit that applies `fn` to a clone of every selected item it changes. */
function commitEach(label: string, fn: (node: SNode, it: KItem) => boolean): boolean {
  const doc = kdoc(); if (!doc || E.viewOnly) return false;
  const { items } = resolve(); const changes: KChange[] = [];
  for (const it of items) { const node = K().cloneNode(it.node); if (!fn(node, it)) continue; changes.push(K().replaceChange(doc, Object.assign({}, it, { node, geom: [], bbox: null }))); }
  if (!changes.length) return false;
  tctx().commit(changes, label);
  panelStore.set({ selVersion: panelStore.get().selVersion + 1 });
  return true;
}
/**
 * onLabelEditEnding / onKeyRenamed: rename a footprint field or a custom property on every selected item ("Rename
 * Property").  An empty name, or one the item already uses, is refused (the label goes back); a property that was
 * just added and is left so is removed again (onNewItemLeftBlank).  Returns whether the rename happened.
 */
export function renamePropKey(id: string, newName: string, pending: boolean): boolean {
  const slash = id.indexOf("/"); const group = id.slice(0, slash), oldName = id.slice(slash + 1);
  const name = newName.trim() === "" ? "" : newName;
  if (name === oldName && !pending) return false;
  if (!name || (name !== oldName && keyNameInUse(name))) { if (pending) removePropKey(id); return false; }
  if (name === oldName) return false;
  const h = H();
  return commitEach("Rename Property", (n) => {
    if (group === "Fields") {
      const mand = mandatoryOf(n); if (!mand || mand.includes(oldName)) return false;
      const f = h.kids(n, "property").find((p) => h.str(p[1]) === oldName); if (!f) return false; f[1] = name; return true;
    }
    const kv = customProps(n).find((q) => q[0] === oldName); if (!kv) return false;
    removeCustomProp(n, oldName); setCustomProp(n, name, kv[1]); return true;
  });
}
/** removeField / removeCustomProperty ("Remove Field" deletes the field outright, not just hides it). */
export function removePropKey(id: string): boolean {
  const slash = id.indexOf("/"); const group = id.slice(0, slash), name = id.slice(slash + 1); const h = H();
  if (group === "Fields") return commitEach("Remove Field", (n) => {
    const mand = mandatoryOf(n); if (!mand || mand.includes(name)) return false;
    const i = n.findIndex((c) => Array.isArray(c) && c[0] === "property" && h.str(c[1]) === name); if (i < 0) return false; n.splice(i, 1); return true;
  });
  return commitEach("Remove Custom Property", (n) => removeCustomProp(n, name));
}
/** A new field goes after the item's last field (m_fields.push_back), else ahead of its pins, instances and custom properties. */
function insertSchField(n: SNode, f: SNode): void {
  const props = H().kids(n, "property"); const last = props[props.length - 1];
  if (last) { n.splice(n.indexOf(last) + 1, 0, f); return; }
  const at = n.findIndex((c, i) => i > 0 && Array.isArray(c) && (c[0] === "pin" || c[0] === "instances" || c[0] === "custom_property"));
  if (at > 0) n.splice(at, 0, f); else n.push(f);
}
/** The first free placeholder: GetUserFieldName( n ) = "Field<n>" for a field, "Property<n>" for a custom property. */
export function freeKeyName(taken: (name: string) => boolean, kind: "field" | "custom"): string {
  for (let n = 0; ; n++) { const name = (kind === "field" ? "Field" : "Property") + n; if (!taken(name)) return name; }
}
/**
 * addBlankField / addBlankCustomProperty: a hidden empty field on every selected footprint (PCB_FIELD( footprint,
 * USER, name ): on the silkscreen of the footprint's side at its anchor), or an empty custom property on every
 * selected item; returns the new row's id, whose label the panel then edits from blank.
 */
export function addPropKey(kind: "field" | "custom"): string | null {
  const { items } = resolve(); if (!items.length || E.viewOnly) return null; const h = H();
  if (kind === "field") {
    const sch = isSchDoc(), kinds = sch ? ["symbol", "sheet"] : ["footprint"];
    const fps = items.filter((it) => kinds.includes(it.kind)); if (!fps.length) return null;
    const name = freeKeyName((nm) => fps.some((it) => h.kids(it.node, "property").some((p) => h.str(p[1]) === nm)), "field");
    const ok = commitEach("Add Field", (n) => {
      if (sch) {   // SCH_FIELD( parent, USER / SHEET_USER, name ) with SetVisible( false ): at the origin, the default text size
        if (n[0] !== "symbol" && n[0] !== "sheet") return false;
        insertSchField(n, ["property", name, "", ["at", 0, 0, 0], ["hide", "yes"], ["effects", ["font", ["size", 1.27, 1.27]]]]);
        return true;
      }
      if (n[0] !== "footprint") return false;
      const back = h.str((h.kid(n, "layer") || [])[1]) === "B.Cu";
      const font: SNode = ["font", ["size", 1.27, 1.27]];
      const eff: SNode = back ? ["effects", font, ["justify", "mirror"]] : ["effects", font];
      const f: SNode = ["property", name, "", ["at", 0, 0, 0], ["layer", back ? "B.SilkS" : "F.SilkS"], ["hide", "yes"], ["uuid", K().newUuid()], eff];
      const last = h.kids(n, "property").pop(); n.splice(last ? n.indexOf(last) + 1 : n.length, 0, f); return true;
    });
    return ok ? "Fields/" + name : null;
  }
  const name = freeKeyName((nm) => items.some((it) => customProps(it.node).some((q) => q[0] === nm)), "custom");
  const ok = commitEach("Add Custom Property", (n) => { setCustomProp(n, name, ""); return true; });
  return ok ? CUSTOM_GROUP + "/" + name : null;
}
