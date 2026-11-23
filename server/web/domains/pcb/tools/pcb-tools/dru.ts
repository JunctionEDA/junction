// pcb-tools/dru.ts — custom design rules (.kicad_dru): DRC_RULES_PARSER, the PCBEXPR condition language and
// DRC_ENGINE::EvalRules for the constraints the web editor uses (length, skew, diff_pair_gap,
// diff_pair_uncoupled, clearance, track_width).  Lengths are in mm.
import type { BoardDoc, DesignSettings, DrcMarker, SAtom } from "./types";
import { arcLength } from "./distances";
import { matchDpSuffix } from "./diffpair";
import { marker, mm4, mmPair, ruled } from "./drc";
import { approxParallelT, commonParallelProjection } from "./meander";
import { netOf } from "./nets";
import { K, S } from "./state";
import { FUNCS, FUNC_BY_LOWER, MISSING_ARG, callFunc, isKnownProp, netName, parentRuleItem, propOf } from "./dru-eval";
import type { RuleItem, Val } from "./dru-eval";
import { layerOf } from "./util";

/** A rule's (constraint …): its type and min / opt / max in mm (null when not given). */
export interface DruConstraint { type: string; min: number | null; opt: number | null; max: number | null; options?: string[]; timeDomain?: boolean; refLayer?: string; refNet?: string }
/** A parsed (rule …). */
export interface DruRule { name: string; condition: string; layer: string | null; severity: string | null; constraints: DruConstraint[]; expr: Expr | null; error: string | null; /** DRC_RULE::m_LayerSource: 'outer' / 'inner' (GetTokenString), the layer pattern that matched, else "" */ layerSource?: string }
/** What a resolved constraint reports: the text as MessageTextFromMinOptMax writes it and the rule's name. */
export interface RuleHit { text: string; name: string; min: number | null; opt: number | null; max: number | null; severity?: string | null }

type Expr = { k: "lit"; v: Val } | { k: "prop"; who: "A" | "B" | "L"; nav: number; name: string } | { k: "call"; who: "A" | "B" | null; nav: number; fn: string; args: Expr[] }
  | { k: "not"; e: Expr } | { k: "bin"; op: string; a: Expr; b: Expr };

const UNIT: Record<string, number> = { deg: 1, mm: 1, mil: 0.0254, mils: 0.0254, th: 0.0254, in: 25.4, um: 0.001, nm: 1e-6, cm: 10, m: 1000 };
/** A rule value: a number with an optional length unit (mm when there is none, as DRC_RULES_PARSER::parseValue). */
export function druValue(s: unknown): number | null {
  const m = /^\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*([a-z]*)\s*$/i.exec(String(s)); if (!m) return null;
  const u = m[2].toLowerCase(); if (u && !(u in UNIT)) return null;
  return +m[1] * (u ? UNIT[u] : 1);
}

// ---- the condition language (LIBEVAL): || && == != < > <= >= ! ( ), 'strings', numbers with units, A.Prop, A.fn('x')
function tokenize(src: string) {
  const out: string[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') { let j = i + 1, s = ""; while (j < src.length && src[j] !== c) { if (src[j] === "\\" && j + 1 < src.length) j++; s += src[j++]; } if (j >= src.length) throw new Error("Missing closing quote"); out.push("'" + s); i = j + 1; continue; }
    const two = src.slice(i, i + 2); if (["||", "&&", "==", "!=", "<=", ">="].includes(two)) { out.push(two); i += 2; continue; }
    if ("()<>!,".includes(c)) { out.push(c); i++; continue; }
    const m = /^[A-Za-z_0-9.]+/.exec(src.slice(i)); if (!m) throw new Error(`Unexpected '${c}'`);
    out.push(m[0]); i += m[0].length;
  }
  return out;
}
/** PCBEXPR_COMPILER: the condition as an expression tree (throws with KiCad-like messages on a syntax error). */
export function parseCondition(src: string): Expr {
  const t = tokenize(src); let p = 0;
  const peek = () => t[p], eat = (x?: string) => { const v = t[p++]; if (x && v !== x) throw new Error(`Expected '${x}'`); return v; };
  const bin = (next: () => Expr, ops: string[]) => () => { let a = next(); while (ops.includes(peek())) { const op = eat(); a = { k: "bin", op, a, b: next() }; } return a; };
  const primary = (): Expr => {
    const tok = eat(); if (tok === undefined) throw new Error("Unexpected end of expression");
    if (tok === "(") { const e = or(); eat(")"); return e; }
    if (tok === "!") return { k: "not", e: primary() };
    if (tok[0] === "'") { const s = tok.slice(1); return { k: "lit", v: { t: "s", v: s, wild: /[*?]/.test(s) } }; }
    const n = druValue(tok); if (n !== null) return { k: "lit", v: { t: "n", v: n } };
    // PCBEXPR_UCODE::CreateVarRef: `null`, a receiver A / B / AB / L with an optional navigation chain (A.Parent.…,
    // only Parent, only from A or B) and a field; L has only Layer, AB only functions
    if (tok.toLowerCase() === "null" && peek() !== "(") return { k: "lit", v: { t: "null" } };
    const parts = tok.split("."), field = parts[parts.length - 1], base = parts.length > 1 ? parts[0] : "";
    const bad = () => new Error(`Unrecognized item '${tok}'`);
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(field) || (parts.length > 1 && !["A", "B", "AB", "L"].includes(base))) throw bad();
    const navs = parts.slice(1, -1); if (navs.some((x) => x.toLowerCase() !== "parent") || (navs.length && base !== "A" && base !== "B")) throw bad();
    const nav = navs.length;
    const m = [tok, base, field];
    const who = (base === "AB" ? "A" : base === "L" ? null : base || null) as "A" | "B" | null;
    if (peek() === "(") {
      if (base === "L") throw bad();
      eat("("); const args: Expr[] = []; if (peek() !== ")") { args.push(or()); while (peek() === ",") { eat(","); args.push(or()); } } eat(")");
      const fn = FUNC_BY_LOWER.get(m[2].toLowerCase()); if (!fn) throw new Error(`Unrecognized function '${m[2]}'`);   // LIBEVAL looks functions up without case
      const empty = (x: Expr | undefined) => !x || (x.k === "lit" && x.v.t === "s" && x.v.v === "");
      if (MISSING_ARG[fn] && empty(args[0])) throw new Error(MISSING_ARG[fn]);
      if (fn === "fromTo") { if (empty(args[0])) throw new Error("Missing 'from' pad argument (footprint reference designator followed by hyphen and pad number) to fromTo()."); if (empty(args[1])) throw new Error("Missing 'to' pad argument (footprint reference designator followed by hyphen and pad number) to fromTo()."); }
      void FUNCS; return { k: "call", who, nav, fn, args };
    }
    if (base === "L") { if (field.toLowerCase() !== "layer") throw bad(); return { k: "prop", who: "L", nav: 0, name: "Layer" }; }
    if (!who || base === "AB") throw bad();
    if (!isKnownProp(m[2])) throw new Error(`Unrecognized property '${m[2]}'`);
    return { k: "prop", who, nav, name: m[2] };
  };
  const cmp = bin(primary, ["==", "!=", "<", ">", "<=", ">="]);
  const and = bin(cmp, ["&&"]); const or: () => Expr = bin(and, ["||"]);
  const e = or(); if (p < t.length) throw new Error(`Unexpected '${t[p]}'`);
  return e;
}

export type { RuleItem } from "./dru-eval";
/** WildCompareString( pattern, string, false ): * and ? wildcards, case-insensitive. */
export function wildMatch(pat: string, s: string) { const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i"); return re.test(s); }
/** wxString::Matches: * and ? wildcards, case-sensitive. */
export function wxMatches(pat: string, s: string) { const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"); return re.test(s); }
/**
 * A.Type: PCBEXPR_TYPE_REF::GetValue returns ENUM_MAP<KICAD_T>'s name of the item's type (EDA_ITEM_DESC,
 * common/eda_item.cpp) — an arc track is a "Track" like a straight one, every dimension but the leader a "Dimension".
 */
export const TYPE_NAME: Record<string, string> = { segment: "Track", arc: "Track", via: "Via", pad: "Pad", zone: "Zone", footprint: "Footprint",
  gr_line: "Graphic", gr_rect: "Graphic", gr_circle: "Graphic", gr_arc: "Graphic", gr_poly: "Graphic", gr_curve: "Graphic", gr_bbox: "Graphic",
  gr_text: "Text", fp_text: "Text", property: "Text", gr_text_box: "Text Box", fp_text_box: "Text Box", table: "Table", table_cell: "Table Cell",
  image: "Reference Image", generated: "Generator", group: "Group", target: "Target", point: "Point", barcode: "Barcode",
  fp_line: "Graphic", fp_rect: "Graphic", fp_circle: "Graphic", fp_arc: "Graphic", fp_poly: "Graphic", fp_curve: "Graphic" };
/** A dimension's type name: PCB_DIM_LEADER_T is "Leader", the aligned, orthogonal, centre and radial ones "Dimension". */
export function typeName(it: RuleItem) {
  if (it.kind === "dimension") { const t = K.kid(it.node, "type"); return t && K.str(t[1]) === "leader" ? "Leader" : "Dimension"; }
  return TYPE_NAME[it.kind] || it.kind;
}
const truth = (v: Val) => v.t === "n" ? v.v !== 0 : v.t === "s" ? v.v !== "" : false;
const num = (b: boolean): Val => ({ t: "n", v: b ? 1 : 0 });
function evalExpr(e: Expr, doc: BoardDoc, s: DesignSettings, A: RuleItem | null, B: RuleItem | null): Val {
  switch (e.k) {
  case "lit": return e.v;
  case "prop": {
    if (e.who === "L") { const L = curLayer || (A ? A.layer || layerOf(A.node) : null); return L ? { t: "s", v: L, wild: false } : { t: "u" }; }   // PCBEXPR_LAYER_VALUE( context->GetLayer() )
    return propOf(doc, s, navigate(e.who === "A" ? A : B, e.nav), e.name, typeName);
  }
  case "not": return num(!truth(evalExpr(e.e, doc, s, A, B)));
  case "bin": {
    if (e.op === "&&") return num(truth(evalExpr(e.a, doc, s, A, B)) && truth(evalExpr(e.b, doc, s, A, B)));
    if (e.op === "||") return num(truth(evalExpr(e.a, doc, s, A, B)) || truth(evalExpr(e.b, doc, s, A, B)));
    const a = evalExpr(e.a, doc, s, A, B), b = evalExpr(e.b, doc, s, A, B);
    if (e.op === "==" || e.op === "!=") {   // VALUE::EqualTo: the right side's wildcards match the left
      let eq = false;
      if (a.t === "u" || b.t === "u") return num(false);   // VALUE::EqualTo / NotEqualTo: undefined is never equal nor unequal
      if (a.t === "null" && b.t === "null") eq = true;
      else if (a.t === "n" && b.t === "n") eq = a.v === b.v;
      else if (a.t === "s" && b.t === "s") eq = b.wild ? wildMatch(b.v, a.v) : a.v.toLowerCase() === b.v.toLowerCase();
      return num(e.op === "==" ? eq : !eq);
    }
    if (a.t !== "n" || b.t !== "n") return num(false);
    return num(e.op === "<" ? a.v < b.v : e.op === ">" ? a.v > b.v : e.op === "<=" ? a.v <= b.v : a.v >= b.v);
  }
  case "call": {
    const it = navigate(e.who === "B" ? B : A, e.nav);
    const args = e.args.map((x) => { const v = evalExpr(x, doc, s, A, B); return v.t === "s" ? v.v : v.t === "n" ? String(v.v) : ""; });
    return callFunc(e.fn, it, args, { doc, s, A, B, constraint: curConstraint, ver: S.docVer }, wildMatch, wxMatches);
  }
  }
}
/** PCBEXPR_VAR_REF::GetObject: the receiver after its navigation steps (each Parent goes up one level). */
function navigate(it: RuleItem | null, nav: number) { for (let i = 0; i < nav && it; i++) it = parentRuleItem(it); return it; }
/** The layer EvalRules is resolving on, when the caller gives one (L.Layer); else the item's own. */
let curLayer: string | null = null;
export function setRuleLayer(l: string | null) { const was = curLayer; curLayer = l; return was; }
/** The constraint EvalRules is resolving (isCoupledDiffPair answers differently for the pair constraints). */
let curConstraint: string | null = null;

/** ProcessAssertions: does the item satisfy the assertion constraint's expression (null when it does not compile)? */
const ASSERT_CACHE = new WeakMap<DruConstraint, Expr | null>();
export function evalAssertion(rule: DruRule, c: DruConstraint, doc: BoardDoc, s: DesignSettings, A: RuleItem): boolean | null {
  let e = ASSERT_CACHE.get(c);
  if (e === undefined) { try { e = parseCondition((c.options || [])[0] || ""); } catch { e = null; } ASSERT_CACHE.set(c, e); }
  if (!e) return null; curConstraint = "assertion"; void rule;
  return truth(evalExpr(e, doc, s, A, null));
}
/** ENUM_MAP<PCB_LAYER_ID>'s names (LSET::Name over LSET::AllLayersMask), in layer id order. */
const ALL_LAYER_NAMES: string[] = (() => {
  const byId: [number, string][] = [[0, "F.Cu"], [1, "F.Mask"], [2, "B.Cu"], [3, "B.Mask"], [5, "F.SilkS"], [7, "B.SilkS"], [9, "F.Adhes"], [11, "B.Adhes"], [13, "F.Paste"], [15, "B.Paste"],
    [17, "Dwgs.User"], [19, "Cmts.User"], [21, "Eco1.User"], [23, "Eco2.User"], [25, "Edge.Cuts"], [27, "Margin"], [29, "B.CrtYd"], [31, "F.CrtYd"], [33, "B.Fab"], [35, "F.Fab"], [37, "Rescue"]];
  for (let n = 1; n <= 30; n++) byId.push([2 + 2 * n, `In${n}.Cu`]);
  for (let n = 1; n <= 45; n++) byId.push([37 + 2 * n, `User.${n}`]);
  return byId.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
})();
/**
 * PANEL_SETUP_RULES::checkPlausibility: rules sharing a condition (and layer source), a NetClass compared with a
 * class the board does not have, and a (layer …) whose matching layers (DRC_RULES_PARSER::parseLayer: every layer
 * name the pattern Matches) are not all enabled.  The warnings in the report's order.
 */
export function rulesPlausibility(rules: DruRule[], enabled: Set<string>, netclasses: Set<string>, layerName: (l: string) => string = (l) => l): string[] {
  const out: string[] = [], seen = new Map<string, string>();
  for (const rule of rules) {
    const condition = (rule.condition || "").trim();
    // m_LayerSource: 'outer' / 'inner' (GetTokenString), the pattern when some layer name Matches it, else nothing (Rescue)
    const src = rule.layerSource !== undefined ? rule.layerSource : rule.layer === "outer" || rule.layer === "inner" ? `'${rule.layer}'` : rule.layer && ALL_LAYER_NAMES.some((l) => wxMatches(rule.layer as string, l)) ? rule.layer : "";
    const cond = src && src !== "'outer'" && src !== "'inner'" ? ALL_LAYER_NAMES.filter((l) => wxMatches(src, l)) : [];
    const key = condition + "\u0000" + src;
    if (seen.has(key)) out.push(`Rules '${rule.name}' and '${seen.get(key)}' share the same condition.`);
    else seen.set(key, rule.name);
    const re = /NetClass\s*[!=]=\s*'"?([^"\s]+)'"?/g;
    for (let m = re.exec(condition); m; m = re.exec(condition)) {
      // NET_SETTINGS::HasNetclass looks in m_netClasses, which does not hold the Default class
      if (!netclasses.has(m[1])) out.push(`Rule '${rule.name}' references undefined netclass '${m[1]}'.`);
    }
    if (src && src !== "'inner'" && src !== "'outer'") {
      const invalid = cond.filter((l) => !enabled.has(l));
      if (invalid.length) out.push(`Rule '${rule.name}' references undefined layer(s): ${invalid.map(layerName).join(", ")}.`);
    }
  }
  return out;
}
// ---------------------------------------------------------------- DRC_RULES_PARSER (drc_rule_parser.cpp) over a DSNLEXER
/** One message of the parser's reporter: ERROR: <a href='line:offset'>first</a>rest, a deprecation warning, or the info line. */
export interface DruMessage { severity: "error" | "warning" | "info"; text: string; rest?: string; line?: number; col?: number; /** a PARSE_ERROR thrown out of DRC_RULES_PARSER::Parse (InitEngine fails) */ fatal?: boolean }
/** drc_rules.keywords: the symbols the lexer returns as keywords (an unquoted symbol only). */
const DRU_KEYWORDS = new Set("annular_width assertion assign_component_class board_edge bridged_mask blind_via buried_via clearance condition connection_width constraint courtyard_clearance creepage diff_pair_gap diff_pair_uncoupled disallow edge_clearance error exclusion footprint graphic hole hole_aspect_ratio hole_clearance hole_size hole_to_hole ignore inner layer length line_width net_chain_length return_path stub_length max mechanical_clearance mechanical_hole_clearance micro_via microvia_stack_depth min min_resolved_spokes net none npth opt outer pad pth physical_clearance physical_hole_clearance rule severity silk_clearance skew solder_mask_expansion solder_paste_abs_margin solder_paste_rel_margin solder_mask_sliver solid text text_height text_thickness thermal_reliefs thermal_relief_gap thermal_spoke_width through_via track track_angle track_width track_segment_length version via via_count via_dangling via_diameter warning within_diff_pairs zone zone_connection".split(" "));
interface DsnTok { kind: "(" | ")" | "string" | "number" | "symbol" | "eof"; text: string; line: number; col: number; sep: string; src: string }
/** DSNLEXER in KiCad mode: ( ) tokens, "quoted" strings with C escapes, numbers, symbols; a line whose first non-blank is # is a comment. */
class DsnLexer {
  private lines: string[]; private ln = 0; private pos = 0; private started = false;
  cur: DsnTok;
  constructor(text: string) { this.lines = text.split("\n").map((l, i, a) => (i < a.length - 1 ? l + "\n" : l)); if (this.lines.length && this.lines[this.lines.length - 1] === "") this.lines.pop(); this.cur = { kind: "eof", text: "", line: 0, col: 1, sep: "", src: "" }; }
  next(): DsnTok {
    if (this.started && this.cur.kind === "eof") return this.cur;
    let sep = "";
    for (;;) {
      if (!this.started || this.pos >= (this.lines[this.ln] || "").length) {
        if (this.started) { this.ln++; this.pos = 0; }
        this.started = true;
        if (this.ln >= this.lines.length) { this.cur = { kind: "eof", text: "", line: Math.max(1, this.lines.length), col: 1, sep, src: "" }; return this.cur; }
        const L = this.lines[this.ln]; let i = 0; while (i < L.length && /[ \t\r\n\f\v]/.test(L[i])) { sep += L[i]; i++; }
        if (L[i] === "#") { this.pos = L.length; continue; }   // a comment line
        this.pos = i; if (i >= L.length) continue;
      }
      const L = this.lines[this.ln];
      while (this.pos < L.length && /[ \t\r\n\f\v]/.test(L[this.pos])) { sep += L[this.pos]; this.pos++; }
      if (this.pos >= L.length) continue;
      const at = this.pos, c = L[at], tok = (kind: DsnTok["kind"], text: string, end: number): DsnTok => { this.pos = end; return (this.cur = { kind, text, line: this.ln + 1, col: at + 1, sep, src: L }); };
      if (c === "(") return tok("(", "(", at + 1);
      if (c === ")") return tok(")", ")", at + 1);
      if (c === '"') {
        let h = at + 1, t = "";
        while (h < L.length) {
          const d = L[h];
          if (d === "\\") {
            if (++h >= L.length) break; const e = L[h++];
            const simple: Record<string, string> = { '"': '"', "\\": "\\", a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
            if (e in simple) t += simple[e];
            else if (e === "x") { const m = /^[0-9a-fA-F]{1,2}/.exec(L.slice(h)); if (m) { t += String.fromCharCode(parseInt(m[0], 16)); h += m[0].length; } else t += "x"; }
            else { h--; const m = /^[0-7]{1,3}/.exec(L.slice(h)); if (m) { t += String.fromCharCode(parseInt(m[0], 8)); h += m[0].length; } else t += "\\"; }
          } else if (d === '"') return tok("string", t, h + 1);
          else { t += d; h++; }
        }
        // THROW_PARSE_ERROR( "Unterminated delimited string", …, cur - start + curText.length() )
        throw Object.assign(new Error("Unterminated delimited string"), { dsnLine: this.ln + 1, dsnCol: at + 1 + t.length });
      }
      let h = at; while (h < L.length && !/[ \t\r\n\f\v()]/.test(L[h])) h++;
      const text = L.slice(at, h);
      return tok(/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text) ? "number" : "symbol", text, h);
    }
  }
}
const isKw = (t: DsnTok, kw: string): boolean => t.kind === "symbol" && t.text === kw;
const isSymbolTok = (t: DsnTok): boolean => t.kind === "symbol" || t.kind === "string";
/** The constraint keywords (parseConstraint's switch) and the type each gives. */
const CONSTRAINT_TYPES: Record<string, string> = { assertion: "assertion", clearance: "clearance", creepage: "creepage", hole_clearance: "hole_clearance", edge_clearance: "edge_clearance", hole_size: "hole_size",
  hole_to_hole: "hole_to_hole", courtyard_clearance: "courtyard_clearance", silk_clearance: "silk_clearance", line_width: "line_width", text_height: "text_height", text_thickness: "line_width", track_width: "track_width",
  track_angle: "track_angle", track_segment_length: "track_segment_length", connection_width: "connection_width", annular_width: "annular_width", via_diameter: "via_diameter", via_dangling: "via_dangling",
  zone_connection: "zone_connection", thermal_relief_gap: "thermal_relief_gap", thermal_spoke_width: "thermal_spoke_width", microvia_stack_depth: "microvia_stack_depth", hole_aspect_ratio: "hole_aspect_ratio",
  min_resolved_spokes: "min_resolved_spokes", solder_mask_expansion: "solder_mask_expansion", solder_mask_sliver: "solder_mask_sliver", solder_paste_abs_margin: "solder_paste_abs_margin", solder_paste_rel_margin: "solder_paste_rel_margin",
  disallow: "disallow", length: "length", net_chain_length: "net_chain_length", stub_length: "stub_length", return_path: "return_path", skew: "skew", via_count: "via_count", diff_pair_gap: "diff_pair_gap",
  diff_pair_uncoupled: "diff_pair_uncoupled", physical_clearance: "physical_clearance", physical_hole_clearance: "physical_hole_clearance", bridged_mask: "bridged_mask" };
/** DRC_CONSTRAINT::IsUnary: the constraints resolved for one item. */
const UNARY = new Set(["hole_size", "text_height", "line_width", "track_segment_length", "annular_width", "solder_mask_expansion", "solder_paste_abs_margin", "solder_paste_rel_margin", "disallow", "via_diameter", "length", "net_chain_length", "stub_length", "return_path", "skew", "via_count", "assertion", "via_dangling", "bridged_mask", "microvia_stack_depth", "hole_aspect_ratio"]);
const MISSING_TYPE = "assertion, clearance, hole_clearance, edge_clearance, physical_clearance, physical_hole_clearance, courtyard_clearance, silk_clearance, hole_size, hole_to_hole, track_width, track_angle, track_segment_length, annular_width, disallow, zone_connection, thermal_relief_gap, thermal_spoke_width, min_resolved_spokes, microvia_stack_depth, hole_aspect_ratio, solder_mask_expansion, solder_paste_abs_margin, solder_paste_rel_margin, length, net_chain_length, skew, via_count, via_dangling, via_diameter, diff_pair_gap or diff_pair_uncoupled";
const UNKNOWN_TYPE = "assertion, clearance, hole_clearance, edge_clearance, physical_clearance, physical_hole_clearance, courtyard_clearance, silk_clearance, hole_size, hole_to_hole, track_width, track_angle, track_segment_length, annular_width, disallow, zone_connection, thermal_relief_gap, thermal_spoke_width, min_resolved_spokes, microvia_stack_depth, hole_aspect_ratio, solder_mask_expansion, solder_mask_sliver, solder_paste_abs_margin, solder_paste_rel_margin, length, line_width, net_chain_length, skew, via_count, via_dangling, via_diameter, diff_pair_gap, diff_pair_uncoupled or bridged_mask";
/** ENUM_MAP<PCB_LAYER_ID>'s names (LSET::Name of every layer), which a (layer "…") pattern is matched against. */
const LAYER_NAMES: string[] = ["F.Cu", ...Array.from({ length: 30 }, (_, i) => `In${i + 1}.Cu`), "B.Cu", "B.Adhes", "F.Adhes", "B.Paste", "F.Paste", "B.SilkS", "F.SilkS", "B.Mask", "F.Mask",
  "Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User", "Edge.Cuts", "Margin", "F.CrtYd", "B.CrtYd", "F.Fab", "B.Fab", "Rescue", ...Array.from({ length: 45 }, (_, i) => `User.${i + 1}`)];

/**
 * PCBEXPR_EVALUATOR over a constraint value: + - * / ( ) and unary signs over numbers with the units
 * PCBEXPR_UNIT_RESOLVER knows (mil, mm, in, deg, fs, ps; none for the unitless types).  Lengths come back in mm,
 * angles in degrees, times in ps.  The errors are LIBEVAL's, with their offset into the expression.
 */
export function evalDruValue(expr: string, o: { unitless: boolean; impliedDegrees: boolean }): { value: number; units: "" | "mm" | "deg" | "ps"; errors: { text: string; rest?: string; offset: number }[] } {
  const UNITS: [string, number, "mm" | "deg" | "ps"][] = o.unitless ? [] : [["mil", 0.0254, "mm"], ["mm", 1, "mm"], ["in", 25.4, "mm"], ["deg", 1, "deg"], ["fs", 0.001, "ps"], ["ps", 1, "ps"]];
  type T = { k: "num" | "op" | "id" | "end"; v: string; at: number; unit?: [string, number, "mm" | "deg" | "ps"] };
  const errors: { text: string; rest?: string; offset: number }[] = []; const toks: T[] = []; let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === " ") { i++; continue; }
    if (/\d/.test(c)) {
      const at = i; let sepSeen = false; while (i < expr.length && (/\d/.test(expr[i]) || ((expr[i] === "." || expr[i] === ",") && !sepSeen))) { if (expr[i] === "." || expr[i] === ",") sepSeen = true; i++; }
      const t: T = { k: "num", v: expr.slice(at, i).replace(",", "."), at };
      let j = i; while (expr[j] === " ") j++;
      const u = UNITS.find(([n]) => expr.startsWith(n, j) && !/[A-Za-z0-9]/.test(expr[j + n.length] || ""));
      if (u) { t.unit = u; i = j + u[0].length; }
      toks.push(t); continue;
    }
    if (/[A-Za-z_]/.test(c)) { const m = /^[A-Za-z0-9_]+/.exec(expr.slice(i))!; toks.push({ k: "id", v: m[0], at: i }); i += m[0].length; continue; }
    if ("+-*/()".includes(c)) { toks.push({ k: "op", v: c, at: i }); i++; continue; }
    if (expr.startsWith("${", i)) errors.push({ text: "Unresolved text variable reference", offset: i + 2 });
    else errors.push({ text: `Unrecognized character '${c}'`, offset: i });
    i++;
  }
  toks.push({ k: "end", v: "", at: expr.length });
  let p = 0, numbers = 0, missing: { text: string; rest: string; offset: number } | null = null, syntax = false;
  type V = { v: number; u: "" | "mm" | "deg" | "ps" };
  const opUnits = (a: V, b: V): V["u"] => (!a.u && b.u ? b.u : a.u && !b.u ? a.u : b.u);
  const fail = (): V => { if (!syntax) { syntax = true; errors.push({ text: "Syntax error", offset: toks[p] ? toks[p].at : expr.length }); } return { v: 0, u: "" }; };
  const primary = (): V => {
    const t = toks[p];
    if (t.k === "num") {
      p++; numbers++;
      if (t.unit) return { v: +t.v * t.unit[1], u: t.unit[2] };
      if (!o.unitless && !o.impliedDegrees) missing = { text: `Missing units for '${t.v}'`, rest: " (must be mm, in, mil, deg, fs, or ps)", offset: t.at };
      return { v: o.impliedDegrees || o.unitless ? +t.v : +t.v / 1e6, u: o.impliedDegrees ? "deg" : "" };   // DoubleValueFromString: internal units (nm), degrees for an angle; a count or ratio as written
    }
    if (t.k === "op" && (t.v === "-" || t.v === "+")) { p++; const x = primary(); return { v: t.v === "-" ? -x.v : x.v, u: x.u }; }
    if (t.k === "op" && t.v === "(") { p++; const x = sum(); if (toks[p].v !== ")" || toks[p].k !== "op") return fail(); p++; return x; }
    if (t.k === "id") { p++; errors.push({ text: `Unrecognized item '${t.v}'`, offset: t.at }); return { v: 0, u: "" }; }
    return fail();
  };
  const prod = (): V => { let a = primary(); while (toks[p].k === "op" && (toks[p].v === "*" || toks[p].v === "/")) { const op = toks[p++].v, b = primary(); a = { v: op === "*" ? a.v * b.v : b.v ? a.v / b.v : 0, u: opUnits(a, b) }; } return a; };
  const sum = (): V => { let a = prod(); while (toks[p].k === "op" && (toks[p].v === "+" || toks[p].v === "-")) { const op = toks[p++].v, b = prod(); a = { v: op === "+" ? a.v + b.v : a.v - b.v, u: opUnits(a, b) }; } return a; };
  const r = sum(); if (toks[p].k !== "end") fail();
  if (missing && numbers === 1) errors.push(missing);
  return errors.length ? { value: 0, units: "", errors } : { value: r.v, units: r.u, errors };
}

/**
 * DRC_RULES_PARSER::Parse with a reporter (PANEL_SETUP_RULES::OnCompile): the rules, every message in KiCad's words
 * with its line and byte offset (parsing goes on after an error), the deprecation warnings and "No errors found.".
 * `errors` keeps the condition compile errors as "rule '<name>': <message>" (the condition editors' form).
 */
export function parseDru(text: string): { rules: DruRule[]; errors: string[]; messages: DruMessage[] } {
  const rules: DruRule[] = [], errors: string[] = [], messages: DruMessage[] = [];
  const lx = new DsnLexer(text || "");
  const at = (t: DsnTok, off = 0) => ({ line: t.line, col: t.col + off });
  const report = (msg: string, off = 0): void => { const bar = msg.indexOf("|"); messages.push({ severity: "error", text: bar >= 0 ? msg.slice(0, bar) : msg, ...(bar >= 0 ? { rest: msg.slice(bar + 1) } : {}), ...at(lx.cur, off) }); };
  const next = (): DsnTok => lx.next();
  // checkUnresolvedTextVariable: a ${…} in the current token that is not a ${Class:…} selector
  const unresolved = (): boolean => {
    const t = lx.cur.text; for (let p = t.indexOf("${"); p >= 0; p = t.indexOf("${", p + 2)) {
      const e = t.indexOf("}", p + 2); if (e >= 0 && t.slice(p + 2, e).toUpperCase().startsWith("CLASS:")) continue;
      report("Unresolved text variable", p); return true;
    }
    return false;
  };
  const parseUnknown = (): void => { let depth = 1; for (let t = next(); t.kind !== "eof"; t = next()) { if (t.kind === "(") depth++; if (t.kind === ")" && --depth === 0) break; } };
  const expected = (what: string): void => { report(lx.cur.text.startsWith("${") ? "Unresolved text variable." : `Unrecognized item '${lx.cur.text}'.| Expected ${what}.`); parseUnknown(); };
  // parseExpression: the tokens up to the matching ')' joined by their separators
  const parseExpression = (): string => { let e = "", depth = 1; for (let t = next(); t.kind !== "eof"; t = next()) { if (t.kind === "(") depth++; if (t.kind === ")" && --depth === 0) break; if (e) e += t.sep; unresolved(); e += t.text; } return e; };
  const compileCondition = (src: string, t: DsnTok): { expr: Expr | null; error: string | null; pair: boolean; refB: boolean } => {
    try {
      const expr = parseCondition(src);
      // PCBEXPR_UCODE::CreateVarRef: B or AB makes the condition need the pair; B alone references item B
      const walk = (e: Expr, f: { pair: boolean; refB: boolean }): void => {
        if (e.k === "prop") { if (e.who === "B") { f.pair = true; f.refB = true; } }
        else if (e.k === "call") { if (e.who === "B") { f.pair = true; f.refB = true; } else if (e.who === "A" && /(^|[^A-Za-z_])AB\./.test(src)) f.pair = true; e.args.forEach((x) => walk(x, f)); }
        else if (e.k === "not") walk(e.e, f); else if (e.k === "bin") { walk(e.a, f); walk(e.b, f); }
      };
      const f = { pair: /(^|[^A-Za-z_.])AB\./.test(src), refB: false }; walk(expr, f);
      return { expr, error: null, ...f };
    } catch (e) {
      const m = (e as Error).message; messages.push({ severity: "error", text: m, line: t.line, col: t.col });
      return { expr: null, error: m, pair: false, refB: false };
    }
  };
  const parseConstraint = (rule: DruRule): void => {
    let t = next();
    if (unresolved()) return;
    let kw = t.kind === "symbol" ? t.text : "";
    if (kw === "mechanical_clearance") { messages.push({ severity: "warning", text: "The 'mechanical_clearance' keyword has been deprecated.  Please use 'physical_clearance' instead." }); kw = "physical_clearance"; }
    else if (kw === "mechanical_hole_clearance") { messages.push({ severity: "warning", text: "The 'mechanical_hole_clearance' keyword has been deprecated.  Please use 'physical_hole_clearance' instead." }); kw = "physical_hole_clearance"; }
    else if (kw === "hole") { messages.push({ severity: "warning", text: "The 'hole' keyword has been deprecated.  Please use 'hole_size' instead." }); kw = "hole_size"; }
    else if (t.kind === ")" || t.kind === "eof") { report(`Missing constraint type.|  Expected ${MISSING_TYPE}.`); return; }
    const type = CONSTRAINT_TYPES[kw];
    if (!type) { expected(UNKNOWN_TYPE); return; }
    const c: DruConstraint = { type, min: null, opt: null, max: null };
    if (rule.constraints.some((k) => k.type === type)) report(`Rule already has a '${t.text}' constraint.`);
    const ratio = type === "hole_aspect_ratio";
    const unitless = ratio || ["via_count", "min_resolved_spokes", "microvia_stack_depth", "via_dangling", "bridged_mask"].includes(type);
    const impliedDegrees = type === "track_angle";
    const allowsTime = ["length", "net_chain_length", "stub_length", "skew"].includes(type);
    if (type === "disallow") {
      for (t = next(); t.kind !== ")"; t = next()) {
        const word = t.kind === "symbol" || t.kind === "string" ? t.text : "";
        if (["track", "via", "through_via", "blind_via", "buried_via", "micro_via", "pad", "zone", "text", "graphic", "hole", "footprint"].includes(word)) { (c.options = c.options || []).push(word); continue; }
        if (t.kind === "eof") { report("Missing ')'."); return; }
        expected("track, via, through_via, blind_via, micro_via, buried_via, pad, zone, text, graphic, hole, or footprint."); return;
      }
      rule.constraints.push(c); return;
    }
    if (type === "return_path") {
      for (t = next(); t.kind !== ")"; t = next()) {
        if (t.kind === "(") t = next();
        if (isKw(t, "layer") || isKw(t, "net")) { const k = t.text; const v = next(); if (k === "layer") c.refLayer = v.text; else c.refNet = v.text; next(); continue; }
        if (t.kind === "eof") { report("Missing ')'."); return; }
        while (next().kind !== ")" && lx.cur.kind !== "eof") { /* an unknown sub-option's subtree */ }
      }
      rule.constraints.push(c); return;
    }
    if (type === "zone_connection") {
      t = next(); const word = t.kind === "symbol" || t.kind === "string" ? t.text : "";
      if (["solid", "thermal_reliefs", "none"].includes(word)) c.options = [word];
      else if (t.kind === "eof") { report("Missing ')'."); return; }
      else { expected("solid, thermal_reliefs or none."); return; }
      if (next().kind !== ")") report("Missing ')'.");
      rule.constraints.push(c); return;
    }
    if (type === "min_resolved_spokes") {
      // a bare count, not (min …): KiCad wants no implied optimum spoke count
      t = next();
      if (t.kind === "number") { c.min = parseInt(t.text, 10) || 0; if (next().kind !== ")") report("Missing ')'."); }
      else expected("number");
      rule.constraints.push(c); return;
    }
    if (type === "assertion") {
      t = next();
      if (t.kind === ")") report("Missing assertion expression.");
      if (isSymbolTok(t) || DRU_KEYWORDS.has(t.text) && t.kind === "symbol") {
        c.options = [t.text];
        const cc = compileCondition(t.text, t);
        if (cc.pair) report("Item 'B' is not available in assertion expressions.");
        if (next().kind !== ")") report("Missing ')'.");
      } else expected("quoted expression");
      rule.constraints.push(c); return;
    }
    let unitsType: string | null = null;
    for (t = next(); t.kind !== ")" && t.kind !== "eof"; t = next()) {
      if (t.kind !== "(") report("Missing '('.");
      t = next();
      if (isKw(t, "within_diff_pairs")) {
        if (type === "skew") (c.options = c.options || []).push("within_diff_pairs"); else report("within_diff_pairs option invalid for constraint type.");
        if (next().kind !== ")") report("Missing ')'.");
        continue;
      }
      if (isKw(t, "min") || isKw(t, "max") || isKw(t, "opt")) {
        const which = t.text as "min" | "max" | "opt", vt = t, offset = t.col + which.length;
        const expr = parseExpression();
        if (!expr) { report(`Missing ${which} value.`); continue; }
        const r = evalDruValue(expr, { unitless, impliedDegrees });
        for (const e of r.errors) messages.push({ severity: "error", text: e.text, ...(e.rest ? { rest: e.rest } : {}), line: vt.line, col: offset + e.offset });
        // validateAndSetValueWithUnits
        const ut = r.units === "ps" ? "time" : r.units === "mm" ? "length" : r.units === "deg" ? "angle" : "unitless";
        if (!allowsTime && ut === "time") report("Time based units not allowed for constraint type.");
        if ((c.min != null || c.max != null || c.opt != null) && unitsType !== ut) report("Mixed units for constraint values.");
        unitsType = ut;
        c[which] = ratio ? Math.round(r.value * 1000) / 1000 : r.value;
        if (allowsTime) { if (ut === "time") c.timeDomain = true; else delete c.timeDomain; }
        continue;
      }
      if (t.kind === "eof") { report("Incomplete statement."); return; }
      expected("min, max, opt, or within_diff_pairs");
    }
    rule.constraints.push(c);
  };
  const parseRule = (): DruRule => {
    const rule: DruRule = { name: "", condition: "", layer: null, severity: null, constraints: [], expr: null, error: null, layerSource: "" };
    let cond: { pair: boolean; refB: boolean } | null = null, condTok: DsnTok | null = null, layerSeen = false;
    let t = next();
    if (!isSymbolTok(t)) report("Missing rule name.");
    unresolved(); rule.name = t.text;
    for (t = next(); t.kind !== ")" && t.kind !== "eof"; t = next()) {
      if (unresolved()) continue;
      if (t.kind !== "(") report("Missing '('.");
      t = next();
      if (isKw(t, "constraint")) parseConstraint(rule);
      else if (isKw(t, "condition")) {
        t = next();
        if (t.kind === ")") report("Missing condition expression.");
        else if (isSymbolTok(t)) {
          unresolved(); rule.condition = t.text; condTok = t;
          const cc = compileCondition(t.text, t); rule.expr = cc.expr; cond = cc;
          if (cc.error) { rule.error = cc.error; errors.push(`rule '${rule.name}': ${cc.error}`); report(`Could not parse expression '${t.text}'.`); }
          if (next().kind !== ")") report("Missing ')'.");
        } else expected("quoted expression");
      }
      else if (isKw(t, "layer")) {
        if (layerSeen) report("'layer' keyword already present.");
        layerSeen = true;
        t = next();
        if (t.kind === ")") { report("Missing layer name or type."); rule.layer = "*.Cu"; continue; }
        if (isKw(t, "outer") || isKw(t, "inner")) { rule.layer = t.text; rule.layerSource = `'${t.text}'`; }
        else {
          const name = t.text; const re = new RegExp("^" + name.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
          if (LAYER_NAMES.some((l) => re.test(l))) { rule.layer = name; rule.layerSource = name; }
          else { if (!unresolved()) report(`Unrecognized layer '${name}'.`); rule.layer = "Rescue"; }
        }
        if (next().kind !== ")") report("Missing ')'.");
      }
      else if (isKw(t, "severity")) {
        t = next();
        if (t.kind === ")" || t.kind === "eof") report("Missing severity name.");
        else {
          if (["ignore", "warning", "error", "exclusion"].includes(t.kind === "symbol" ? t.text : "")) rule.severity = t.text;
          else expected("ignore, warning, error, or exclusion");
          if (next().kind !== ")") report("Missing ')'.");
        }
      }
      else if (t.kind === "eof") { report("Incomplete statement."); return rule; }
      else expected("constraint, condition, or disallow");
    }
    if (lx.cur.kind !== ")") report("Missing ')'.");
    if (cond && cond.pair && condTok) {
      for (const k of rule.constraints) {
        if (!cond.refB && (k.type === "length" || k.type === "net_chain_length" || k.type === "skew")) continue;
        if (UNARY.has(k.type)) { messages.push({ severity: "error", text: `Item 'B' is not available for a single-item constraint in rule '${rule.name}'.`, line: condTok.line, col: condTok.col }); break; }
      }
    }
    return rule;
  };
  try {
    let haveVersion = false;
    for (let t = next(); t.kind !== "eof"; t = next()) {
      if (unresolved()) continue;
      if (t.kind !== "(") report("Missing '('.");
      t = next();
      if (!haveVersion && !isKw(t, "version")) { report("Missing version statement."); haveVersion = true; }
      if (isKw(t, "version")) {
        haveVersion = true; t = next();
        if (t.kind === ")") report("Missing version number.");
        else if (t.kind === "number") { if (next().kind !== ")") report("Missing ')'."); }
        else expected("version number");
      }
      else if (isKw(t, "rule")) rules.push(parseRule());
      else if (t.kind === "eof") report("Incomplete statement.");
      else expected("rule or version");
    }
    if (!messages.length) messages.push({ severity: "info", text: "No errors found." });
  } catch (e) {
    const x = e as Error & { dsnLine?: number; dsnCol?: number };
    messages.push({ severity: "error", text: x.message, line: x.dsnLine || lx.cur.line, col: x.dsnCol || lx.cur.col, fatal: true });
  }
  return { rules, errors, messages };
}
const layerOk = (rule: DruRule, layer: string | null | undefined) => {
  if (!rule.layer || !layer) return true;
  if (rule.layer === "outer") return /^(F|B)\.Cu$/.test(layer);
  if (rule.layer === "inner") return /^In\d+\.Cu$/.test(layer);
  return wildMatch(rule.layer, layer);
};
/** Does a rule apply to A (and B)? */
export function ruleMatches(rule: DruRule, doc: BoardDoc, s: DesignSettings, A: RuleItem | null, B: RuleItem | null) {
  if (rule.error) return false;
  if (!layerOk(rule, A ? A.layer || layerOf(A.node) : null)) return false;
  return !rule.expr || truth(evalExpr(rule.expr, doc, s, A, B));
}
/**
 * DRC_ENGINE::EvalRules for one constraint type: the rules are walked last to first and the first that matches and
 * carries the constraint wins (later rules take precedence).  null when no rule gives it.
 */
export function evalRuleConstraint(rules: DruRule[], type: string, doc: BoardDoc, s: DesignSettings, A: RuleItem | null, B: RuleItem | null, fmt?: (mm: number) => string): RuleHit | null {
  curConstraint = type;
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i]; const c = r.constraints.find((k) => k.type === type); if (!c) continue;
    if (!ruleMatches(r, doc, s, A, B)) continue;
    const f = fmt || ((v: number) => v.toFixed(4) + " mm"); const parts: string[] = [];
    if (c.min != null && c.min > 0) parts.push("min " + f(c.min));   // MessageTextFromMinOptMax
    if (c.opt != null) parts.push("opt " + f(c.opt));
    if (c.max != null) parts.push("max " + f(c.max));
    return { text: parts.join("; "), name: `rule '${r.name}'`, min: c.min, opt: c.opt, max: c.max, severity: r.severity };
  }
  return null;
}

/**
 * DRC_ENGINE::EvalRules( CLEARANCE_CONSTRAINT, a, b, layer ) over the custom rules: the last rule with a clearance
 * constraint whose condition holds for (A, B) or (B, A) gives the clearance (its min); null when none does, and the
 * netclass clearance applies.  A rule with severity ignore gives 0.
 */
export function ruleClearance(rules: DruRule[], doc: BoardDoc, s: DesignSettings, A: RuleItem, B: RuleItem): { min: number; name: string } | null {
  curConstraint = "clearance";
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i], c = r.constraints.find((k) => k.type === "clearance"); if (!c || c.min == null) continue;
    if (!ruleMatches(r, doc, s, A, B) && !ruleMatches(r, doc, s, B, A)) continue;
    return { min: r.severity === "ignore" ? 0 : c.min, name: `rule '${r.name}'` };
  }
  return null;
}
/**
 * DRC_TEST_PROVIDER_MATCHED_LENGTH for the custom rules: every net whose tracks a rule gives a length constraint is
 * checked as one connection (its routed track length; via heights and pad-to-die lengths are not counted), and the
 * nets one skew rule covers are compared with the longest of them (within_diff_pairs: each pair on its own).
 */
export function matchedLengthMarkers(doc: BoardDoc, s: DesignSettings, rules: DruRule[]): DrcMarker[] {
  const out: DrcMarker[] = []; if (!rules.some((r) => r.constraints.some((c) => c.type === "length" || c.type === "skew" || c.type === "via_count"))) return out;
  const vias = new Map<string, string[]>();   // CONNECTION::viaCount: the vias of the net
  for (const it of doc.items.values()) { if (it.kind !== "via") continue; const name = netName(doc, it.node); if (!name) continue; const l = vias.get(name); if (l) l.push(it.id); else vias.set(name, [it.id]); }
  const nets = new Map<string, { name: string; ids: string[]; total: number; first: KItem }>();
  for (const it of doc.items.values()) {
    if (it.kind !== "segment" && it.kind !== "arc") continue;
    const name = netName(doc, it.node); if (!name) continue;
    const a = K.kid(it.node, "start"), b = K.kid(it.node, "end"); if (!a || !b) continue;
    const A: [number, number] = [K.num(a[1]), K.num(a[2])], B: [number, number] = [K.num(b[1]), K.num(b[2])];
    let L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (it.kind === "arc") { const m = K.kid(it.node, "mid"); const c = m && K.arcFrom3(A, [K.num(m[1]), K.num(m[2])], B); if (c) L = arcLength(c); }
    let n = nets.get(name); if (!n) nets.set(name, n = { name, ids: [], total: 0, first: it });
    n.ids.push(it.id); n.total += L;
  }
  const at = (it: KItem) => { const a = K.kid(it.node, "start")!; return [K.num(a[1]), K.num(a[2])]; };
  const groups = new Map<string, { c: DruConstraint; rule: DruRule; nets: typeof nets extends Map<string, infer V> ? V[] : never }>();
  for (const n of nets.values()) {
    for (let i = rules.length - 1; i >= 0; i--) {   // the rule that gives this net its length constraint
      const r = rules[i], c = r.constraints.find((k) => k.type === "length"); if (!c || !ruleMatches(r, doc, s, n.first, null)) continue;
      // a time-domain bound (ps / fs) is compared against propagation delays from the tuning profiles, which this checker lacks
      if (r.severity === "ignore" || c.timeDomain) break;
      const name = `rule '${r.name}'`, [x, y] = at(n.first);
      if (c.min != null && n.total < c.min - 1e-6) out.push(ruled(Object.assign(marker("length_out_of_range", "error", x, y, `Track length out of range (${name} min length ${mmPair(c.min, n.total)[0]}; actual ${mmPair(c.min, n.total)[1]})`, n.ids.slice())), r.severity));
      else if (c.max != null && n.total > c.max + 1e-6) out.push(ruled(marker("length_out_of_range", "error", x, y, `Track length out of range (${name} max length ${mmPair(c.max, n.total)[0]}; actual ${mmPair(c.max, n.total)[1]})`, n.ids.slice()), r.severity));
      break;
    }
    // DRC_TEST_PROVIDER_MATCHED_LENGTH::checkViaCounts: "Too many vias on a connection (rule 'x' max count N; actual M)"
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i], c = r.constraints.find((k) => k.type === "via_count"); if (!c || !ruleMatches(r, doc, s, n.first, null)) continue;
      if (r.severity === "ignore") break;
      const count = (vias.get(n.name) || []).length, name = `rule '${r.name}'`, [x, y] = at(n.first);
      let text = "";
      if (c.max != null && count > c.max) text = `Too many vias on a connection (${name} max count ${Math.trunc(c.max)}; actual ${count})`;
      else if (c.min != null && count < c.min) text = `Too few vias on a connection (${name} min count ${Math.trunc(c.min)}; actual ${count})`;
      if (text) { const m = marker("too_many_vias", "error", x, y, text, n.ids.concat(vias.get(n.name) || [])); m.layer = layerOf(n.first.node); out.push(ruled(m, r.severity)); }
      break;
    }
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i], c = r.constraints.find((k) => k.type === "skew"); if (!c || !ruleMatches(r, doc, s, n.first, null)) continue;
      if (r.severity === "ignore" || c.timeDomain) break;
      let g = groups.get(r.name + "\u0000" + i); if (!g) groups.set(r.name + "\u0000" + i, g = { c, rule: r, nets: [] }); g.nets.push(n); break;
    }
  }
  for (const g of groups.values()) {
    let sets: (typeof g.nets)[] = [g.nets];
    if (g.c.options && g.c.options.includes("within_diff_pairs")) {
      sets = []; const left = new Map(g.nets.map((n) => [n.name, n]));
      for (const n of g.nets) { if (!left.has(n.name)) continue; const m = matchDpSuffix(n.name); const o = m.rv ? left.get(m.complement) : null; if (o) { sets.push([n, o]); left.delete(n.name); left.delete(o.name); } }
    }
    for (const set of sets) {
      let ref = set[0]; for (const n of set) if (n.total > ref.total) ref = n;
      for (const n of set) {
        const skew = Math.abs(n.total - ref.total), name = `rule '${g.rule.name}'`; let kind = "";
        if (g.c.max != null && skew > g.c.max + 1e-6) kind = "max"; else if (g.c.min != null && n !== ref && skew < g.c.min - 1e-6) kind = "min";
        if (!kind) continue;
        const [x, y] = at(n.first);
        out.push(ruled(marker("skew_out_of_range", "error", x, y, `Skew between tracks out of range (${name} ${kind} skew ${mmPair(kind === "max" ? g.c.max! : g.c.min!, n.total - ref.total)[0]}; actual ${mmPair(kind === "max" ? g.c.max! : g.c.min!, n.total - ref.total)[1]}; target net length ${mm4(ref.total)} (from ${ref.name}); actual ${mm4(n.total)})`, n.ids.slice()), g.rule.severity));
      }
    }
  }
  return out.filter((m) => s.severities[m.code] !== "ignore");
}
/**
 * DRC_TEST_PROVIDER_DIFF_PAIR_COUPLING for the custom rules: each differential pair a diff_pair_gap or
 * diff_pair_uncoupled rule covers has its P / N track segments (outside tuning patterns) paired where they run
 * side by side over a common stretch (commonParallelProjection, the gap measured between them less the half widths).
 * The web pairs each P segment with its nearest parallel N segment where KiCad discards pairs another item sits
 * between.  "Differential uncoupled length too long" when the stretch not coupled within the gap exceeds the rule's
 * max; "Differential pair gap out of range" for each pair outside the gap (only when the uncoupled length fails too,
 * or no uncoupled rule applies).
 */
export function diffPairMarkers(doc: BoardDoc, s: DesignSettings, rules: DruRule[]): DrcMarker[] {
  const out: DrcMarker[] = []; if (!rules.some((r) => r.constraints.some((c) => c.type === "diff_pair_gap" || c.type === "diff_pair_uncoupled"))) return out;
  const inPattern = new Set<string>(); for (const it of doc.items.values()) if (it.kind === "generated") for (const id of K.groupMemberIds(it.node)) inPattern.add(id);
  const byNet = new Map<string, KItem[]>();
  for (const it of doc.items.values()) if (it.kind === "segment" || it.kind === "arc") { const n = netName(doc, it.node); if (n) { let l = byNet.get(n); if (!l) byNet.set(n, l = []); l.push(it); } }
  const xy = (it: KItem, k: string): [number, number] => { const v = K.kid(it.node, k)!; return [K.num(v[1]), K.num(v[2])]; };
  const len = (it: KItem) => { const a = xy(it, "start"), b = xy(it, "end"); if (it.kind === "arc") { const m = xy(it, "mid"); const c = K.arcFrom3(a, m, b); if (c) return arcLength(c); } return Math.hypot(b[0] - a[0], b[1] - a[1]); };
  const width = (it: KItem) => { const w = K.kid(it.node, "width"); return w ? K.num(w[1]) : 0; };
  const find = (type: string, A: KItem, B: KItem) => { for (let i = rules.length - 1; i >= 0; i--) { const r = rules[i], c = r.constraints.find((k) => k.type === type); if (c && ruleMatches(r, doc, s, A, B)) return r.severity === "ignore" ? null : { c, r }; } return null; };
  const at = (it: KItem) => xy(it, "start");
  for (const [name, P] of byNet) {
    const m = matchDpSuffix(name); if (m.rv <= 0) continue; const N = byNet.get(m.complement); if (!N) continue;
    const gapR = find("diff_pair_gap", P[0], N[0]), uncR = find("diff_pair_uncoupled", P[0], N[0]); if (!gapR && !uncR) continue;
    const I = (p: [number, number]) => [p[0] * 1e6, p[1] * 1e6];
    const coupled: { p: KItem; n: KItem; gap: number; len: number; failMin: boolean; failMax: boolean }[] = [];
    for (const sp of P) {
      if (sp.kind !== "segment" || inPattern.has(sp.id)) continue; let best: (typeof coupled)[number] | null = null;
      for (const sn of N) {
        if (sn.kind !== "segment" || inPattern.has(sn.id) || layerOf(sn.node) !== layerOf(sp.node)) continue;
        const a = { A: I(xy(sp, "start")), B: I(xy(sp, "end")) }, b = { A: I(xy(sn, "start")), B: I(xy(sn, "end")) };
        if (!approxParallelT(a, b, 10)) continue;
        const cp = commonParallelProjection(a, b); if (!cp) continue;
        const gap = (Math.hypot(cp.pClip.A[0] - cp.nClip.A[0], cp.pClip.A[1] - cp.nClip.A[1]) - (width(sp) + width(sn)) / 2 * 1e6) / 1e6;
        const L = Math.hypot(cp.nClip.B[0] - cp.nClip.A[0], cp.nClip.B[1] - cp.nClip.A[1]) / 1e6;
        if (!best || gap < best.gap) best = { p: sp, n: sn, gap, len: L, failMin: false, failMax: false };
      }
      if (best) coupled.push(best);
    }
    let totalCoupled = 0;
    for (const d of coupled) {
      const g = gapR && gapR.c; if (g) { d.failMin = g.min != null && g.min >= 0 && d.gap < g.min - 0.0005; d.failMax = g.max != null && g.max >= 0 && d.gap > g.max + 0.0005; }
      if (!d.failMin && !d.failMax) totalCoupled += d.len;
    }
    const sum = (l: KItem[]) => l.filter((it) => !inPattern.has(it.id)).reduce((t, it) => t + len(it), 0);
    const total = Math.max(sum(P), sum(N)), uncoupled = total - totalCoupled; let uncFail = false;
    if (uncR && uncR.c.max != null && uncR.c.max >= 0 && uncoupled > uncR.c.max + 1e-6) {
      uncFail = true; const [x, y] = at(N[0]);
      out.push(ruled(marker("diff_pair_uncoupled_length_too_long", "error", x, y, `Differential uncoupled length too long (rule '${uncR.r.name}' maximum uncoupled length ${mmPair(uncR.c.max, uncoupled)[0]}; actual ${mmPair(uncR.c.max, uncoupled)[1]})`, P.concat(N).map((it) => it.id)), uncR.r.severity));
    }
    if (gapR && (uncFail || !uncR)) for (const d of coupled) {
      if (!d.failMin && !d.failMax) continue; const [x, y] = at(d.n);
      out.push(ruled(marker("diff_pair_gap_out_of_range", "error", x, y, `Differential pair gap out of range (rule '${gapR.r.name}' ${d.failMin ? "minimum" : "maximum"} gap ${mmPair(d.failMin ? gapR.c.min! : gapR.c.max!, d.gap)[0]}; actual ${mmPair(d.failMin ? gapR.c.min! : gapR.c.max!, d.gap)[1]})`, [d.p.id, d.n.id]), gapR.r.severity));
    }
  }
  return out.filter((mk) => s.severities[mk.code] !== "ignore");
}
