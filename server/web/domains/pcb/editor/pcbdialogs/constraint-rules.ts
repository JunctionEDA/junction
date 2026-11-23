// pcbdialogs/constraint-rules — the model behind Board Setup's Design Rules constraint family pages
// (PANEL_SETUP_CONSTRAINT_RULES::SectionsFor, RulesCanOverride, PageTitleFor, PageEditingDefault, NetclassValuesFor),
// the rule document every page edits (DRC_RULE_DOCUMENT), the panel matcher's home pages (DRC_PANEL_MATCHER::
// GetHomePanel) and the rule table's text (CONSTRAINT_RULES_LIST::ConstraintText, severityText, the override note).
// Nothing here touches the DOM: the pages are built in ./constraint-rules-page.
import { RULE_TYPES, buildCondition, constraintClauses, formatRuleName, loadRules, ruleText, rulesText, stripComments, typeById, type Rule, type RuleList } from "./drc-rule-model";

// ---------------------------------------------------------------- the sections (SectionsFor)
/** CONSTRAINT_VALUE: a distance shown in the user's units, or a plain count */
export type ConstraintValue = "length" | "count";
/** CONSTRAINT_DEFAULT_FIELD: a board default, by the name BOARD_DESIGN_SETTINGS validates it under */
export interface DefaultField { label: string; setting: string; value: ConstraintValue }
/** NETCLASS_CONSTRAINT_PART: a net class value raises the minimum, or asks for a value */
export type NetclassPart = "min" | "opt";
/** The net class value a section lists (NETCLASS::GetClearanceOpt, GetTrackWidthOpt, GetViaDiameterOpt, GetViaDrillOpt) */
export type NetclassKey = "clearance" | "track_width" | "via_diameter" | "via_drill";
/** CONSTRAINT_SECTION */
export interface Section { title: string; defaults: DefaultField[]; ruleType: string; netclass: NetclassKey | null; settingsPage: string; part: NetclassPart }
export type Family = "CLEARANCE" | "TRACKS_AND_VIAS" | "HOLES" | "SILKSCREEN" | "SOLDER_MASK" | "HIGH_SPEED" | "FOOTPRINT_RULES";
/** dialog_board_setup.cpp's ruleFamilies: the family nodes under Design Rules, in tree order */
export const FAMILIES: [Family, string][] = [["CLEARANCE", "Clearance"], ["TRACKS_AND_VIAS", "Tracks and Vias"], ["HOLES", "Holes"], ["SILKSCREEN", "Silkscreen"],
  ["SOLDER_MASK", "Mask and Paste"], ["HIGH_SPEED", "High Speed"], ["FOOTPRINT_RULES", "Footprints"]];

const D = (label: string, setting: string, value: ConstraintValue = "length"): DefaultField => ({ label, setting, value });
const S = (title: string, defaults: DefaultField[], ruleType: string, netclass: NetclassKey | null = null, settingsPage = "", part: NetclassPart = "min"): Section => ({ title, defaults, ruleType, netclass, settingsPage, part });
const BD = "Board default:", MV = "Microvia default:", SMP = "Solder Mask/Paste";

/** PANEL_SETUP_CONSTRAINT_RULES::SectionsFor */
export function sectionsFor(family: Family): Section[] {
  switch (family) {
    case "CLEARANCE": return [
      S("Minimum clearance", [D(BD, "min_clearance")], "MINIMUM_CLEARANCE", "clearance"),
      S("Copper to hole clearance", [D(BD, "min_hole_clearance")], "COPPER_TO_HOLE_CLEARANCE"),
      S("Copper to edge clearance", [D(BD, "min_copper_edge_clearance")], "COPPER_TO_EDGE_CLEARANCE"),
      S("Physical clearance", [], "PHYSICAL_CLEARANCE"),
      S("Creepage distance", [], "CREEPAGE_DISTANCE"),
      S("Minimum thermal relief spoke count", [D(BD, "min_resolved_spokes", "count")], "MINIMUM_THERMAL_RELIEF_SPOKE_COUNT")];
    case "TRACKS_AND_VIAS": return [
      S("Minimum track width", [D(BD, "min_track_width")], "ROUTING_WIDTH", "track_width", "", "opt"),
      S("Minimum connection width", [D(BD, "min_connection")], "MINIMUM_CONNECTION_WIDTH"),
      S("Minimum annular width", [D(BD, "min_via_annular_width")], "MINIMUM_ANNULAR_WIDTH"),
      S("Minimum via diameter", [D(BD, "min_via_diameter"), D(MV, "min_microvia_diameter")], "MINIMUM_VIA_DIAMETER", "via_diameter", "", "opt"),
      S("Via style", [], "VIA_STYLE"),
      S("Maximum via count", [], "MAXIMUM_VIA_COUNT")];
    case "HOLES": return [
      S("Minimum drill size", [D(BD, "min_through_hole_diameter"), D(MV, "min_microvia_drill")], "MINIMUM_DRILL_SIZE", "via_drill", "", "opt"),
      S("Hole size", [], "HOLE_SIZE"),
      S("Hole to hole clearance", [D(BD, "min_hole_to_hole")], "HOLE_TO_HOLE_DISTANCE"),
      S("Microvia stack depth", [], "MICROVIA_STACK_DEPTH"),
      S("Hole aspect ratio", [], "HOLE_ASPECT_RATIO")];
    case "SILKSCREEN": return [
      S("Silk to silk clearance", [D(BD, "min_silk_clearance")], "SILK_TO_SILK_CLEARANCE"),
      S("Minimum text height and thickness", [D("Minimum text height:", "min_text_height"), D("Minimum text thickness:", "min_text_thickness")], "MINIMUM_TEXT_HEIGHT_AND_THICKNESS"),
      S("Silk to solder mask clearance", [], "SILK_TO_SOLDERMASK_CLEARANCE")];
    case "HIGH_SPEED": return [
      S("Matched length for differential pairs", [], "MATCHED_LENGTH_DIFF_PAIR"),
      S("Absolute length", [], "ABSOLUTE_LENGTH"),
      S("Differential pair routing", [], "ROUTING_DIFF_PAIR")];
    case "SOLDER_MASK": return [
      S("Solder mask expansion", [D(BD, "solder_mask_expansion")], "SOLDERMASK_EXPANSION", null, SMP),
      S("Minimum solder mask sliver", [D(BD, "solder_mask_min_width")], "MINIMUM_SOLDERMASK_SLIVER", null, SMP),
      S("Solder paste expansion", [D(BD, "solder_paste_margin")], "SOLDERPASTE_EXPANSION", null, SMP)];
    case "FOOTPRINT_RULES": return [
      S("Permitted layers", [], "PERMITTED_LAYERS"),
      S("Allowed orientation", [], "ALLOWED_ORIENTATION"),
      S("Vias under SMD pads", [], "VIAS_UNDER_SMD"),
      S("Courtyard clearance", [], "COURTYARD_CLEARANCE")];
  }
}
export const allSections = (): Section[] => FAMILIES.flatMap(([f]) => sectionsFor(f));
/** importGroup: the Import Settings group a section's defaults travel with */
export const importGroup = (s: Section): string => s.settingsPage || "Constraints";
/** EditedDefaults: every board default a rule page edits, with its import group */
export const editedDefaults = (): [string, DefaultField][] => allSections().flatMap((s) => s.defaults.map((d): [string, DefaultField] => [importGroup(s), d]));
const sectionForSetting = (setting: string): Section | null => allSections().find((s) => s.defaults.some((d) => d.setting === setting)) || null;
/** PageEditingDefault: the title of the rule page that edits a board default, or "" */
export const pageEditingDefault = (setting: string): string => { const s = sectionForSetting(setting); return s ? s.title : ""; };
/** PageTitleFor: the title of the page that edits rules of a type, or "" */
export const pageTitleFor = (type: string): string => { const s = allSections().find((x) => x.ruleType === type); return s ? s.title : ""; };

/** RulesCanOverride: the constraint a rule sets in place of a board default, or null where rules cannot */
const OVERRIDES: Record<string, string> = {
  min_clearance: "clearance", min_hole_clearance: "hole_clearance", min_copper_edge_clearance: "edge_clearance", min_track_width: "track_width",
  min_connection: "connection_width", min_via_annular_width: "annular_width", min_via_diameter: "via_diameter", min_through_hole_diameter: "hole_size",
  min_hole_to_hole: "hole_to_hole", min_silk_clearance: "silk_clearance", min_text_height: "text_height", min_text_thickness: "text_thickness",
  solder_mask_expansion: "solder_mask_expansion", solder_mask_min_width: "solder_mask_sliver", solder_paste_margin: "solder_paste_abs_margin" };
export const rulesCanOverride = (setting: string): string | null => OVERRIDES[setting] || null;

/** A net class as the project file has it (NET_SETTINGS' classes; the Default class first). */
export interface NetclassLike { name: string; [key: string]: unknown }
/** The classes in the order DRC builds them: the default class first, then the rest by name (NET_SETTINGS::GetNetclasses). */
export function netclassOrder(classes: NetclassLike[]): NetclassLike[] {
  const def = classes.find((c) => c.name === "Default");
  const rest = classes.filter((c) => c.name !== "Default").sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return def ? [def, ...rest] : rest;
}
export const netclassValue = (c: NetclassLike, key: NetclassKey): number | null => (typeof c[key] === "number" && isFinite(c[key] as number) ? (c[key] as number) : null);
/** NetclassValuesFor: the net class values set for a board default, by value (ascending) with the classes setting each */
export function netclassValuesFor(setting: string, classes: NetclassLike[]): [number, string[]][] {
  const s = sectionForSetting(setting); if (!s || !s.netclass) return [];
  const by = new Map<number, string[]>();
  for (const c of netclassOrder(classes)) { const v = netclassValue(c, s.netclass); if (v === null) continue; const k = Math.round(v * 1e6) / 1e6; if (!by.has(k)) by.set(k, []); (by.get(k) as string[]).push(c.name); }
  return [...by.entries()].sort((a, b) => a[0] - b[0]);
}

// ---------------------------------------------------------------- the panel matcher's home pages
/** DRC_PANEL_MATCHER's claims in priority order: the panel, the constraints it requires, those it may hold */
const CLAIMS: [string, string[], string[]][] = [
  ["ROUTING_DIFF_PAIR", ["track_width", "diff_pair_gap"], ["diff_pair_uncoupled", "skew"]], ["VIA_STYLE", ["via_diameter", "hole_size"], []],
  ["MINIMUM_TEXT_HEIGHT_AND_THICKNESS", ["text_height", "text_thickness"], []], ["ROUTING_WIDTH", ["track_width"], []], ["MATCHED_LENGTH_DIFF_PAIR", ["length", "skew"], []],
  ["ABSOLUTE_LENGTH", ["length"], []], ["MATCHED_LENGTH_DIFF_PAIR", ["skew"], []], ["PERMITTED_LAYERS", ["assertion"], []], ["ALLOWED_ORIENTATION", ["assertion"], []],
  ["MINIMUM_CLEARANCE", ["clearance"], []], ["COPPER_TO_EDGE_CLEARANCE", ["edge_clearance"], []], ["COPPER_TO_HOLE_CLEARANCE", ["hole_clearance"], []],
  ["HOLE_TO_HOLE_DISTANCE", ["hole_to_hole"], []], ["COURTYARD_CLEARANCE", ["courtyard_clearance"], []], ["MINIMUM_SOLDERMASK_SLIVER", ["solder_mask_sliver"], []],
  ["PHYSICAL_CLEARANCE", ["physical_clearance"], []], ["SILK_TO_SILK_CLEARANCE", ["silk_clearance"], []], ["CREEPAGE_DISTANCE", ["creepage"], []],
  ["HOLE_SIZE", ["hole_size"], []], ["MINIMUM_VIA_DIAMETER", ["via_diameter"], []], ["MINIMUM_ANNULAR_WIDTH", ["annular_width"], []],
  ["MINIMUM_CONNECTION_WIDTH", ["connection_width"], []], ["MAXIMUM_VIA_COUNT", ["via_count"], []], ["SOLDERMASK_EXPANSION", ["solder_mask_expansion"], []],
  ["SOLDERPASTE_EXPANSION", ["solder_paste_abs_margin"], []], ["MINIMUM_THERMAL_RELIEF_SPOKE_COUNT", ["min_resolved_spokes"], []],
  ["MICROVIA_STACK_DEPTH", ["microvia_stack_depth"], []], ["HOLE_ASPECT_RATIO", ["hole_aspect_ratio"], []],
  ["ROUTING_DIFF_PAIR", ["diff_pair_gap"], ["diff_pair_uncoupled"]], ["ROUTING_DIFF_PAIR", ["diff_pair_uncoupled"], []], ["VIAS_UNDER_SMD", ["disallow"], []]];
/** GetHomePanel: the page a constraint belongs on when a rule setting it is kept as text */
export function homePanel(code: string): string {
  if (code === "hole_size") return "HOLE_SIZE";
  if (code === "silk_clearance") return "SILK_TO_SILK_CLEARANCE";
  if (code === "length") return "ABSOLUTE_LENGTH";
  const single = CLAIMS.find(([, req, opt]) => req.length === 1 && !opt.length && req[0] === code);
  if (single) return single[0];
  const any = CLAIMS.find(([, req, opt]) => req.includes(code) || opt.includes(code));
  return any ? any[0] : "CUSTOM_RULE";
}

// ---------------------------------------------------------------- a rule as the pages see it (DRC_RE_LOADED_PANEL_ENTRY)
const isCustom = (r: Rule): boolean => typeById(r.type).panel === "custom";
/** The rule's text as it would be written */
export const entryText = (r: Rule): string => (isCustom(r) ? r.text : ruleText(r));
const unq = (s: string): string => s.replace(/\\(.)/g, "$1");
/** ConstraintsOf: the constraints a rule sets, as their rule-language codes ("hole" is read as hole_size) */
export function constraintsOf(r: Rule): string[] {
  const out: string[] = [], re = /\(\s*constraint\s+([a-z_]+)/g, t = stripComments(entryText(r));
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) { const c = m[1] === "hole" ? "hole_size" : m[1]; if (!out.includes(c)) out.push(c); }
  return out;
}
/** entry.condition: the rule's condition expression */
export function entryCondition(r: Rule): string {
  if (!isCustom(r)) return buildCondition(r.conds, typeById(r.type).two);
  const m = /\(\s*condition\s+"((?:[^"\\]|\\.)*)"/.exec(stripComments(r.text)); return m ? unq(m[1]) : "";
}
/** entry.layerSource: the rule's (layer …) as written, or "" for any layer */
export function entryLayer(r: Rule): string {
  if (!isCustom(r)) return r.layer;
  const m = /\(\s*layer\s+(?:"((?:[^"\\]|\\.)*)"|([^\s()]+))/.exec(stripComments(r.text)); return m ? (m[1] !== undefined ? unq(m[1]) : m[2]) : "";
}
export function entrySeverity(r: Rule): string {
  if (!isCustom(r)) return r.severity;
  const m = /\(\s*severity\s+([a-z]+)/.exec(stripComments(r.text)); return m ? m[1] : "";
}
/** layersText */
export const layersText = (r: Rule): string => entryLayer(r) || "Any";
/** severityText */
export function severityText(r: Rule): string {
  switch (entrySeverity(r)) { case "ignore": return ", not checked"; case "warning": return ", warning only"; case "exclusion": return ", excluded"; default: return ""; }
}

/** inUserUnits: every number written with units shown the way the page shows lengths */
export function inUserUnits(clause: string, fmtU: (mm: number) => string): string {
  return clause.replace(/([0-9]+(\.[0-9]+)?)(mm|um|mil|in)\b/g, (_m, v: string, _f: string, u: string) => fmtU(+v * (u === "um" ? 0.001 : u === "mil" ? 0.0254 : u === "in" ? 25.4 : 1)));
}
/** DRC_RULE_DOCUMENT::FindConstraintClause: where the (constraint <code> …) clause starts, or -1 */
export function findConstraintClause(text: string, code: string): number {
  const kw = "(constraint", sp = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
  let pos = text.indexOf(kw);
  while (pos >= 0) {
    let c = pos + kw.length; while (c < text.length && sp(text[c])) c++;
    const end = c + code.length;
    if (c > pos + kw.length && text.startsWith(code, c) && (end >= text.length || sp(text[end]) || text[end] === ")")) return pos;
    pos = text.indexOf(kw, pos + kw.length);
  }
  return -1;
}
/** The rule-language code a constraint type edits (ConstraintToKicadDrc) */
export const constraintCode = (type: string): string => (type === "MINIMUM_TEXT_HEIGHT_AND_THICKNESS" ? "text_height" : type === "VIA_STYLE" ? "via_diameter" : typeById(type).code);
/** CONSTRAINT_RULES_LIST::ConstraintText: the constraint a rule sets, as the rule table shows it */
export function constraintText(r: Rule, type: string, fmtU: (mm: number) => string): string {
  if (isCustom(r)) {
    const text = r.text, code = constraintCode(type), start = findConstraintClause(text, code);
    if (start < 0) return "Custom rule";
    let body = start + "(constraint".length; while (body < text.length && /\s/.test(text[body])) body++;
    body += code.length;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) return inUserUnits(text.slice(body, i).replace(/[\n\t]/g, " ").trim(), fmtU) + "  (text rule)";
    }
    return "Custom rule";
  }
  const clauses = constraintClauses(r), opener = "(constraint ";
  const parts = clauses.map((c) => {
    if (!c.startsWith(opener) || !c.endsWith(")")) return c;
    const body = c.slice(opener.length, -1), sp = body.indexOf(" ");
    const code = sp < 0 ? body : body.slice(0, sp), rest = sp < 0 ? "" : body.slice(sp + 1);
    return clauses.length > 1 ? code + " " + rest : rest;
  });
  return inUserUnits(parts.join("  "), fmtU);
}
/** showOverrideNote's text: what the rule being edited displaces, or "" */
export function overrideNote(defaults: [string, string][], condition: string, layers: string): string {
  let board = "";
  for (const [name, shown] of defaults) { if (!shown) continue; const v = `${name} ${shown}`; board = board ? `${board} and ${v}` : v; }
  if (!board) return "";
  if (!condition && !layers) return `Overrides the board default, ${board}, everywhere`;
  if (!condition) return `Overrides the board default, ${board}, on ${layers}`;
  if (!layers) return `Overrides the board default, ${board}, where ${condition}`;
  return `Overrides the board default, ${board}, on ${layers} where ${condition}`;
}
/** The detail a rule gets in the Constraints page's popup ("%s, everywhere" …) */
export function ruleScopeText(value: string, condition: string, layers: string): string {
  if (!condition && !layers) return `${value}, everywhere`;
  if (!condition) return `${value}, on ${layers}`;
  if (!layers) return `${value}, where ${condition}`;
  return `${value}, on ${layers} where ${condition}`;
}

// ---------------------------------------------------------------- the rule document (DRC_RULE_DOCUMENT)
/** A deep copy of a rule, the original text it was read with kept (so an unchanged rule is written as it was read). */
export const copyRule = (r: Rule): Rule => { const c = JSON.parse(JSON.stringify(r)) as Rule; return c; };
/**
 * The custom rules of the board while Board Setup is open.  Every Design Rules page edits this one object; the rules
 * file is written once, when the dialog is accepted.  `parses` is DRC_RULES_PARSER: false for text that does not parse,
 * which is then kept verbatim and the pages may not edit the rules.
 */
export class RuleDocument {
  entries: RuleList = [];
  private raw = "";
  private textCurrent = false;
  private rawText = false;
  modified = false;
  constructor(private parses: (text: string) => boolean) {}
  /** Load: the board's own rules file (null when it has none); nothing is marked modified */
  load(text: string | null): void { this.read(text); this.modified = false; }
  /** LoadFrom: another board's rules file, as an import; a board without one changes nothing */
  loadFrom(text: string | null): void { if (text === null) return; this.read(text); this.modified = true; }
  private read(text: string | null): void {
    this.entries = []; this.raw = ""; this.rawText = false; this.textCurrent = false;
    if (text === null) return;
    this.raw = text.replace(/\r\n/g, "\n").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-");
    this.textCurrent = true; this.rawText = !this.parseInto(this.raw);
  }
  private parseInto(text: string): boolean {
    if (!this.parses(text)) return false;
    this.entries = loadRules(text); return true;
  }
  /** GetText: the text as read or typed until a page changes a rule, then the rules written out */
  getText(): string { return this.textCurrent ? this.raw : rulesText(this.entries); }
  /** SetText: the Custom Rules page's text */
  setText(text: string): void {
    if (text === this.getText()) return;
    this.raw = text; this.textCurrent = true; this.rawText = !this.parseInto(text); this.modified = true;
  }
  hasUnparsedText(): boolean { return this.rawText; }
  private touch(): void { this.modified = true; this.textCurrent = false; }
  /** IndicesFor: the rules of a type, and every text rule setting a constraint whose home page it is */
  indicesFor(type: string): number[] {
    if (this.rawText) return [];
    const out: number[] = [];
    this.entries.forEach((r, i) => {
      if (r.type === type) out.push(i);
      else if (isCustom(r) && type !== "CUSTOM_RULE" && constraintsOf(r).some((c) => homePanel(c) === type)) out.push(i);
    });
    return out;
  }
  /** IndicesSetting: every rule that sets a constraint, whichever page edits it */
  indicesSetting(code: string): number[] { if (this.rawText) return []; const out: number[] = []; this.entries.forEach((r, i) => { if (constraintsOf(r).includes(code)) out.push(i); }); return out; }
  add(r: Rule): number { if (this.rawText) return -1; this.entries.push(r); this.touch(); return this.entries.length - 1; }
  update(i: number, r: Rule): void { if (this.rawText || i < 0 || i >= this.entries.length) return; this.entries[i] = r; this.touch(); }
  remove(i: number): void { if (this.rawText || i < 0 || i >= this.entries.length) return; this.entries.splice(i, 1); this.touch(); }
  /** Duplicate: a copy named on from the original's name (a trailing number dropped), placed after it; -1 when it cannot */
  duplicate(i: number): number {
    if (this.rawText || i < 0 || i >= this.entries.length) return -1;
    const src = this.entries[i];
    let base = src.name; const sp = base.lastIndexOf(" ");
    if (sp >= 0 && /^[+-]?\d+$/.test(base.slice(sp + 1))) base = base.slice(0, sp);
    const name = this.uniqueRuleName(base), copy = copyRule(src);
    delete copy.raw; delete copy.gen; delete copy.lead;
    copy.name = name;
    if (isCustom(copy)) copy.text = copy.text.replace(/^(\s*\(rule\s+)("(?:[^"\\]|\\.)*"|[^\s()]+)/, (_m, a: string) => a + formatRuleName(name));
    this.entries.splice(i + 1, 0, copy); this.touch();
    return i + 1;
  }
  /** Move: one step among the rules listed for a type; false when already first or last */
  move(i: number, delta: number, type: string): boolean {
    if (this.rawText || !delta) return false;
    const order = this.indicesFor(type), at = order.indexOf(i); if (at < 0) return false;
    const to = at + (delta > 0 ? 1 : -1); if (to < 0 || to >= order.length) return false;
    const j = order[to];
    [this.entries[i], this.entries[j]] = [this.entries[j], this.entries[i]]; this.touch();
    return true;
  }
  /** IsRuleNameUnique: no other rule of the same type has the name */
  isRuleNameUnique(name: string, type: string, except: number): boolean {
    if (except >= 0 && except < this.entries.length) type = this.entries[except].type;
    return !this.entries.some((r, i) => i !== except && r.type === type && r.name === name);
  }
  /** UniqueRuleName: "<base> 1", "<base> 2", … the first no rule has */
  uniqueRuleName(base: string): string { let n = 1; while (this.entries.some((r) => r.name === `${base} ${n}`)) n++; return `${base} ${n}`; }
}

/** A new rule of a type as CreateConstraintData makes it: every value zero, nothing checked */
export function newRule(type: string, name: string): Rule {
  const t = typeById(type), v: Record<string, number | boolean | null> = {};
  switch (t.panel) {
    case "num": case "int": v.value = 0; break;
    case "minmax": v.min = 0; v.max = 0; break;
    case "minoptmax": case "matchlen": v.min = 0; v.opt = 0; v.max = 0; if (t.panel === "matchlen") { v.skew = 0; v.within = false; } break;
    case "viastyle": for (const k of ["dmin", "dopt", "dmax", "hmin", "hopt", "hmax"]) v[k] = 0; break;
    case "text": v.height = 0; v.thickness = 0; break;
    case "diffpair": for (const k of ["wmin", "wopt", "wmax", "gmin", "gopt", "gmax", "uncoupled"]) v[k] = 0; break;
    case "layers": v.top = false; v.bottom = false; break;
    case "orient": for (const d of [0, 90, 180, 270]) v["o" + d] = false; break;
    case "smdvias": v.through = false; v.micro = false; v.blind = false; v.buried = false; break;
  }
  return { type, name, comment: "", layer: "", severity: "", conds: [{ op: "&&", obj: "A", kind: "any", value: "" }], v, text: "" };
}

/** DRC_LAYER_CATEGORY of a constraint type (GetLayerCategoryForConstraint) */
export type LayerCategory = "copper" | "silk" | "mask" | "paste" | "topbottom" | "any" | "none";
export function layerCategory(type: string): LayerCategory {
  switch (type) {
    case "MINIMUM_CLEARANCE": case "CREEPAGE_DISTANCE": case "COPPER_TO_HOLE_CLEARANCE": case "COPPER_TO_EDGE_CLEARANCE": case "VIA_STYLE": case "MINIMUM_VIA_DIAMETER":
    case "MINIMUM_ANNULAR_WIDTH": case "MINIMUM_CONNECTION_WIDTH": case "ROUTING_WIDTH": case "ROUTING_DIFF_PAIR": case "MINIMUM_THERMAL_RELIEF_SPOKE_COUNT":
    case "MICROVIA_STACK_DEPTH": case "MATCHED_LENGTH_DIFF_PAIR": case "ABSOLUTE_LENGTH": return "copper";
    case "SILK_TO_SILK_CLEARANCE": return "silk";
    case "MINIMUM_SOLDERMASK_SLIVER": case "SOLDERMASK_EXPANSION": return "mask";
    case "SOLDERPASTE_EXPANSION": return "paste";
    case "COURTYARD_CLEARANCE": case "SILK_TO_SOLDERMASK_CLEARANCE": case "VIAS_UNDER_SMD": case "ALLOWED_ORIENTATION": return "topbottom";
    case "MAXIMUM_VIA_COUNT": case "PERMITTED_LAYERS": case "HOLE_ASPECT_RATIO": case "CUSTOM_RULE": return "none";
    default: return "any";
  }
}
/** TopBottomLayerId: the layer Top / Bottom stands for */
export const topBottomLayer = (type: string, top: boolean): string => (type === "COURTYARD_CLEARANCE" ? (top ? "F.CrtYd" : "B.CrtYd") : type === "SILK_TO_SOLDERMASK_CLEARANCE" ? (top ? "F.SilkS" : "B.SilkS") : (top ? "F.Cu" : "B.Cu"));
/** populateLayerSelector: [layer source, label] after "Any" */
export function layerChoices(type: string, enabled: string[], layerName: (l: string) => string): [string, string][] {
  const cu = enabled.filter((l) => /\.Cu$/.test(l));
  switch (layerCategory(type)) {
    case "copper": return [["outer", "outer"], ["inner", "inner"], ...cu.map((l): [string, string] => [l, layerName(l)])];
    case "silk": return [["F.SilkS", layerName("F.SilkS")], ["B.SilkS", layerName("B.SilkS")]];
    case "mask": return [["F.Mask", layerName("F.Mask")], ["B.Mask", layerName("B.Mask")]];
    case "paste": return [["F.Paste", layerName("F.Paste")], ["B.Paste", layerName("B.Paste")]];
    case "topbottom": return [[topBottomLayer(type, true), "Top"], [topBottomLayer(type, false), "Bottom"]];
    case "any": return [["outer", "outer"], ["inner", "inner"], ...enabled.map((l): [string, string] => [l, layerName(l)])];
    default: return [];
  }
}

/** PANEL_DRC_RULE_EDITOR::ValidateRule: the numbered messages ("1. …\n"), "" when the rule is valid */
export function validateRule(r: Rule, unique: boolean): string {
  const t = typeById(r.type), e: string[] = [], v = r.v;
  if (!unique) e.push("Rule name must be unique.");
  if (!r.name.trim() && t.panel !== "custom") e.push("Rule Name should not be empty.");
  const pos = (k: string, label: string): void => { if (typeof v[k] !== "number" || !isFinite(v[k] as number)) e.push(`The value of ${label} must be a valid number.`); else if ((v[k] as number) <= 0 && !/expansion|abs_margin/.test(t.code)) e.push(`The value of ${label} must be greater than 0.`); };
  const order = (a: string, b: string, la: string, lb: string): void => { if (typeof v[a] === "number" && typeof v[b] === "number" && (v[a] as number) > (v[b] as number)) e.push(`${la} value cannot be greater than ${lb} value.`); };
  const mom = (p: string, q: string): void => { order(p + "min", p + "opt", `Minimum ${q}`, `Preferred ${q}`); order(p + "opt", p + "max", `Preferred ${q}`, `Maximum ${q}`); order(p + "min", p + "max", `Minimum ${q}`, `Maximum ${q}`); };
  switch (t.panel) {
    case "num": pos("value", t.label); break;
    case "int": if (typeof v.value !== "number" || !Number.isInteger(v.value)) e.push(`The value of ${t.label} must be a valid integer.`); else if (v.value <= 0) e.push(`The value of ${t.label} must be greater than 0.`); break;
    case "minmax": order("min", "max", "Minimum Length", "Maximum Length"); break;
    case "minoptmax": mom("", "Width"); break;
    case "viastyle": mom("d", "Via Diameter"); mom("h", "Via Hole Size"); break;
    case "text": pos("height", "Minimum Text Height"); pos("thickness", "Minimum Text Thickness"); break;
    case "diffpair": mom("w", "Width"); mom("g", "Gap"); break;
    case "matchlen": mom("", "Length"); break;
    case "layers": if (!v.top && !v.bottom) e.push("Please select at least one option from Permitted Layers list."); break;
    case "orient": if (![0, 90, 180, 270].some((d) => v["o" + d])) e.push("Please select at least one option from Allowed Orientations list."); break;
    case "smdvias": if (!v.through && !v.micro && !v.blind && !v.buried) e.push("At least one via type must be selected"); break;
    case "custom": if (!/^\(rule\b/.test(r.text.trim())) e.push("Rule text should not be empty.");
  }
  return e.map((m, i) => `${i + 1}. ${m}\n`).join("");
}
export { RULE_TYPES };
