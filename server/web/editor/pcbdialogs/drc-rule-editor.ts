// pcbdialogs/drc-rule-editor — Tools > DRC Rule Editor (DIALOG_DRC_RULE_EDITOR over RULE_EDITOR_DIALOG_BASE,
// pcbnew/drc/rule_editor).  Left: the filter box and the rule tree (Design Rules > Electrical / Manufacturability /
// Highspeed design / Footprints / Custom, their constraint types and the project's rules under each) with the
// small_plus / copy / small_up / small_down / small_trash buttons and the same right-click menu.  Right: a category
// shows its group grid (Rule Type / Rule Name / Comment); a rule shows PANEL_DRC_RULE_EDITOR: Name and Comment, the
// "Constraint" overlay panel of its type, "Conditions" ("Where conditions match:" with Object A / B rows for a
// two-object constraint, "Where object matches:" otherwise; Any / Net / Netclass / Within Area / Custom Query; the
// AND / OR / AND NOT / OR NOT operators; "Add another condition"), Syntax help, the Check rule syntax button, Show
// Matches, and the Layer choice.  Save writes the project's .kicad_dru (DRC_RULE_SAVER::GenerateRulesText); Close
// with unsaved rules asks "Save Changes?".
import { E } from "../state";
import { state } from "../appstore";
import { popupMenu } from "../../dialogs/dom";
import { canWriteProject, liveDocument, projectDoc, saveTextDocument } from "../projectfile";
import { markdownToHtml } from "../markdown";
import { RULES_HELP_MD } from "../../generated/rules-help";
import { keysInText } from "../../keys";
import { bitmapButton, checkField, ensureCss, fmtLen, h, messageBox, parseLen, selectField, textField, unitName, type Field } from "./ui";

// ---------------------------------------------------------------- the constraint types (buildRuleTreeNodes)
type Panel = "num" | "int" | "minmax" | "minoptmax" | "viastyle" | "text" | "diffpair" | "matchlen" | "layers" | "orient" | "smdvias" | "custom";
export interface RuleType { id: string; label: string; code: string; panel: Panel; two: boolean; cat: string[]; unitless?: boolean; field?: string }
export const RULE_TYPES: RuleType[] = [
  { id: "MINIMUM_CLEARANCE", label: "Minimum clearance", code: "clearance", panel: "num", two: true, cat: ["Electrical", "Clearance"] },
  { id: "COPPER_TO_EDGE_CLEARANCE", label: "Copper to edge clearance", code: "edge_clearance", panel: "num", two: false, cat: ["Electrical", "Clearance"] },
  { id: "COURTYARD_CLEARANCE", label: "Courtyard clearance", code: "courtyard_clearance", panel: "num", two: true, cat: ["Electrical", "Clearance"] },
  { id: "PHYSICAL_CLEARANCE", label: "Physical clearance", code: "physical_clearance", panel: "num", two: true, cat: ["Electrical", "Clearance"] },
  { id: "CREEPAGE_DISTANCE", label: "Creepage distance", code: "creepage", panel: "num", two: true, cat: ["Electrical", "Clearance"] },
  { id: "MINIMUM_CONNECTION_WIDTH", label: "Minimum connection width", code: "connection_width", panel: "num", two: false, cat: ["Electrical"] },
  { id: "COPPER_TO_HOLE_CLEARANCE", label: "Copper to hole clearance", code: "hole_clearance", panel: "num", two: true, cat: ["Electrical"] },
  { id: "MINIMUM_THERMAL_RELIEF_SPOKE_COUNT", label: "Minimum thermal relief spoke count", code: "min_resolved_spokes", panel: "int", two: false, cat: ["Electrical"], unitless: true },
  { id: "MINIMUM_ANNULAR_WIDTH", label: "Minimum annular width", code: "annular_width", panel: "num", two: false, cat: ["Manufacturability"] },
  { id: "MINIMUM_DRILL_SIZE", label: "Minimum drill size", code: "hole_size", panel: "num", two: false, cat: ["Manufacturability", "Hole"] },
  { id: "HOLE_TO_HOLE_DISTANCE", label: "Hole to hole distance", code: "hole_to_hole", panel: "num", two: true, cat: ["Manufacturability", "Hole"] },
  { id: "VIA_STYLE", label: "Via style", code: "via_style", panel: "viastyle", two: false, cat: ["Manufacturability", "Hole"] },
  { id: "HOLE_ASPECT_RATIO", label: "Maximum aspect ratio", code: "hole_aspect_ratio", panel: "int", two: false, cat: ["Manufacturability", "Hole"], unitless: true },
  { id: "MICROVIA_STACK_DEPTH", label: "Maximum stack depth", code: "microvia_stack_depth", panel: "int", two: false, cat: ["Manufacturability", "Microvia"], unitless: true },
  { id: "MINIMUM_TEXT_HEIGHT_AND_THICKNESS", label: "Minimum text height and thickness", code: "text_height", panel: "text", two: false, cat: ["Manufacturability"] },
  { id: "SILK_TO_SILK_CLEARANCE", label: "Silk to silk clearance", code: "silk_clearance", panel: "num", two: true, cat: ["Manufacturability"] },
  { id: "SILK_TO_SOLDERMASK_CLEARANCE", label: "Silk to soldermask clearance", code: "silk_clearance", panel: "num", two: true, cat: ["Manufacturability"] },
  { id: "MINIMUM_SOLDERMASK_SLIVER", label: "Minimum soldermask sliver", code: "solder_mask_sliver", panel: "num", two: false, cat: ["Manufacturability"] },
  { id: "SOLDERMASK_EXPANSION", label: "Soldermask expansion", code: "solder_mask_expansion", panel: "num", two: false, cat: ["Manufacturability"] },
  { id: "SOLDERPASTE_EXPANSION", label: "Solderpaste expansion", code: "solder_paste_abs_margin", panel: "num", two: false, cat: ["Manufacturability"] },
  { id: "ROUTING_WIDTH", label: "Routing width", code: "track_width", panel: "minoptmax", two: false, cat: ["Highspeed design"] },
  { id: "MAXIMUM_VIA_COUNT", label: "Maximum via count", code: "via_count", panel: "int", two: false, cat: ["Highspeed design"], unitless: true },
  { id: "ROUTING_DIFF_PAIR", label: "Routing diff pair", code: "diff_pair_gap", panel: "diffpair", two: false, cat: ["Highspeed design"] },
  { id: "MATCHED_LENGTH_DIFF_PAIR", label: "Matched length diff pair", code: "length", panel: "matchlen", two: false, cat: ["Highspeed design"] },
  { id: "ABSOLUTE_LENGTH", label: "Absolute length", code: "length", panel: "minmax", two: false, cat: ["Highspeed design"] },
  { id: "PERMITTED_LAYERS", label: "Permitted layers", code: "permitted_layers", panel: "layers", two: false, cat: ["Footprints"] },
  { id: "ALLOWED_ORIENTATION", label: "Allowed orientation", code: "allowed_orientation", panel: "orient", two: false, cat: ["Footprints"] },
  { id: "VIAS_UNDER_SMD", label: "Vias under SMD", code: "disallow_via", panel: "smdvias", two: false, cat: ["Footprints"] },
  { id: "CUSTOM_RULE", label: "Custom rule", code: "", panel: "custom", two: false, cat: ["Custom"] },
];
const typeById = (id: string): RuleType => RULE_TYPES.find((t) => t.id === id) || RULE_TYPES[RULE_TYPES.length - 1];

// ---------------------------------------------------------------- the rule model
export type CondKind = "any" | "net" | "netclass" | "area" | "custom";
export interface Cond { op: "&&" | "||" | "&& !" | "|| !"; obj: "A" | "B"; kind: CondKind; value: string }
export interface Rule { type: string; name: string; comment: string; layer: string; severity: string; conds: Cond[]; v: Record<string, number | boolean | null>; text: string }

/** formatRuleName: quoted when it is a number or has characters other than letters, digits, _ - . */
export function formatRuleName(n: string): string {
  if (!n) return '""';
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(n) || !/^[\w.-]+$/.test(n)) return `"${n.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return n;
}
const num = (v: number): string => { let s = (Math.round(v * 1e6) / 1e6).toFixed(6); if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, ""); return s; };
const mm = (v: number | boolean | null | undefined): string => num(Number(v) || 0) + "mm";
/** DRC_RE_CONDITION_GROUP_PANEL::BuildCondition */
export function buildCondition(conds: Cond[], two: boolean): string {
  let out = "";
  for (const c of conds) {
    const p = two ? c.obj : "A";
    const e = c.kind === "net" ? (c.value ? `${p}.NetName == '${c.value}'` : "") : c.kind === "netclass" ? (c.value ? `${p}.hasNetclass('${c.value}')` : "") : c.kind === "area" ? (c.value ? `${p}.intersectsArea('${c.value}')` : "") : c.kind === "custom" ? c.value : "";
    if (!e) continue;
    if (out) out += c.op === "&&" ? " && " : c.op === "||" ? " || " : c.op === "&& !" ? " && !" : " || !";
    out += e;
  }
  return out;
}
/** ParseCondition / ParseExpression: top-level && / || parts become rows, anything else one Custom Query row */
export function parseCondition(expr: string): Cond[] {
  const s = expr.trim(); if (!s) return [{ op: "&&", obj: "A", kind: "any", value: "" }];
  const parts: { op: Cond["op"]; e: string }[] = []; let depth = 0, q = "", start = 0, op: Cond["op"] = "&&";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ""; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === "(") depth++; else if (c === ")") depth--;
    else if (depth === 0 && (s.startsWith("&&", i) || s.startsWith("||", i))) {
      parts.push({ op, e: s.slice(start, i).trim() });
      op = s[i] === "&" ? "&&" : "||"; i += 2; while (s[i] === " ") i++;
      if (s[i] === "!") { op = op === "&&" ? "&& !" : "|| !"; i++; }
      start = i; i--;
    }
  }
  parts.push({ op, e: s.slice(start).trim() });
  const rows: Cond[] = [];
  for (const p of parts) {
    let m: RegExpExecArray | null;
    if ((m = /^([AB])\.NetName\s*==\s*'([^']*)'$/.exec(p.e))) rows.push({ op: p.op, obj: m[1] as "A" | "B", kind: "net", value: m[2] });
    else if ((m = /^([AB])\.hasNetclass\('([^']*)'\)$/.exec(p.e))) rows.push({ op: p.op, obj: m[1] as "A" | "B", kind: "netclass", value: m[2] });
    else if ((m = /^([AB])\.intersectsArea\('([^']*)'\)$/.exec(p.e))) rows.push({ op: p.op, obj: m[1] as "A" | "B", kind: "area", value: m[2] });
    else rows.push({ op: p.op, obj: "A", kind: "custom", value: p.e });   // ParseExpression: no match -> CUSTOM
  }
  return rows;
}
/** The constraint clauses of a rule (GetConstraintClauses of each *_CONSTRAINT_DATA) */
export function constraintClauses(r: Rule): string[] {
  const t = typeById(r.type), v = r.v;
  const mmm = (code: string, a: string, b: string, c: string): string => `(constraint ${code} (min ${mm(v[a])}) (opt ${mm(v[b])}) (max ${mm(v[c])}))`;
  switch (t.panel) {
    case "num": return [`(constraint ${t.code} (min ${mm(v.value)}))`];
    case "int": return t.code === "min_resolved_spokes" ? [`(constraint ${t.code} ${num(Number(v.value) || 0)})`] : [`(constraint ${t.code} (max ${num(Number(v.value) || 0)}))`];
    case "minmax": return [`(constraint ${t.code} (min ${mm(v.min)}) (max ${mm(v.max)}))`];
    case "minoptmax": return [mmm(t.code, "min", "opt", "max")];
    case "viastyle": return [mmm("via_diameter", "dmin", "dopt", "dmax"), mmm("hole_size", "hmin", "hopt", "hmax")];
    case "text": return [`(constraint text_height (min ${mm(v.height)}))`, `(constraint text_thickness (min ${mm(v.thickness)}))`];
    case "diffpair": return [mmm("track_width", "wmin", "wopt", "wmax"), mmm("diff_pair_gap", "gmin", "gopt", "gmax"), `(constraint diff_pair_uncoupled (max ${mm(v.uncoupled)}))`];
    case "matchlen": return [mmm("length", "min", "opt", "max"), `(constraint skew (max ${mm(v.skew)})${v.within ? " (within_diff_pairs)" : ""})`];
    case "layers": { const a = [v.top ? "A.Layer == 'F.Cu'" : "", v.bottom ? "A.Layer == 'B.Cu'" : ""].filter(Boolean); return a.length ? [`(constraint assertion "${a.join(" || ")}")`] : []; }
    case "orient": { const a = [0, 90, 180, 270].filter((d) => v["o" + d]).map((d) => `A.Orientation == ${d} deg`); return a.length ? [`(constraint assertion "${a.join(" || ")}")`] : []; }
    case "smdvias": {
      const ks = [["through", "through_via"], ["micro", "micro_via"], ["blind", "blind_via"], ["buried", "buried_via"]].filter(([k]) => v[k]);
      return !ks.length ? [] : ks.length === 4 ? ["(constraint disallow via)"] : [`(constraint disallow ${ks.map(([, c]) => c).join(" ")})`];
    }
    default: return [];
  }
}
/** buildRule: (rule name, the comment lines as # comments, the layer, the clauses, the condition) */
export function ruleText(r: Rule): string {
  const t = typeById(r.type);
  if (t.panel === "custom") return r.text.trim();
  let s = `(rule ${formatRuleName(r.name)}\n`;
  for (const line of r.comment.split("\n")) if (line) s += `\t# ${line}\n`;
  if (r.layer) s += `\t(layer ${/^(outer|inner)$/.test(r.layer) ? r.layer : `"${r.layer}"`})\n`;
  for (const c of constraintClauses(r)) s += `\t${c}\n`;
  if (r.severity) s += `\t(severity ${r.severity})\n`;
  const cond = buildCondition(r.conds, t.two);
  if (cond) s += `\t(condition "${cond.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")\n`;
  return s + ")";
}
export const rulesText = (rules: Rule[]): string => "(version 1)\n\n" + rules.map(ruleText).filter(Boolean).join("\n\n") + "\n";

/** DRC_RULE_LOADER + DRC_RE_PANEL_MATCHER: a .kicad_dru's rules as editor entries (an unmatched rule is a Custom rule) */
export function loadRules(text: string): Rule[] {
  const out: Rule[] = [];
  let root: SNode;
  try { root = KiCadCanvas.parse("(dru " + text + "\n)") as SNode; } catch (e) { return out; }
  // the raw text of each top-level (rule …) for Custom rules
  const raws: string[] = []; { let depth = 0, q = false, st = -1; for (let i = 0; i < text.length; i++) { const c = text[i]; if (q) { if (c === "\\") i++; else if (c === '"') q = false; continue; } if (c === '"') q = true; else if (c === "#" && depth === 0) { const j = text.indexOf("\n", i); i = j < 0 ? text.length : j; } else if (c === "(") { if (depth === 0) st = i; depth++; } else if (c === ")") { depth--; if (depth === 0 && st >= 0) { raws.push(text.slice(st, i + 1)); st = -1; } } } }
  const tops = raws.filter((r) => /^\(\s*rule\b/.test(r));
  let ri = 0;
  for (const r of root.slice(1)) {
    if (!Array.isArray(r) || r[0] !== "rule") continue;
    const raw = tops[ri++] || "";
    const S = (x: unknown): string => String(x ?? "");
    const rule: Rule = { type: "CUSTOM_RULE", name: S(r[1]), comment: "", layer: "", severity: "", conds: [], v: {}, text: raw };
    const comments = /\(rule[^\n]*\n((?:\s*#[^\n]*\n)*)/.exec(raw); if (comments) rule.comment = comments[1].split("\n").map((l) => l.replace(/^\s*#\s?/, "")).filter(Boolean).join("\n");
    const cons: SNode[] = []; let cond = "";
    for (const c of r.slice(2)) { if (!Array.isArray(c)) continue; if (c[0] === "constraint") cons.push(c as SNode); else if (c[0] === "condition") cond = S(c[1]); else if (c[0] === "layer") rule.layer = S(c[1]); else if (c[0] === "severity") rule.severity = S(c[1]); }
    const bound = (c: SNode | undefined, k: string): number | null => { if (!c) return null; const b = c.find((x) => Array.isArray(x) && x[0] === k) as SNode | undefined; if (!b) return null; const m = /^(-?[\d.]+)\s*(mm|mil|mils|in|um)?$/.exec(S(b[1])); if (!m) return null; const f = m[2] === "mil" || m[2] === "mils" ? 0.0254 : m[2] === "in" ? 25.4 : m[2] === "um" ? 0.001 : 1; return +m[1] * f; };
    const by = (code: string): SNode | undefined => cons.find((c) => c[1] === code);
    const codes = cons.map((c) => S(c[1])).sort().join(",");
    const set = (type: string, v: Record<string, number | boolean | null>): void => { rule.type = type; rule.v = v; };
    if (codes === "hole_size,via_diameter") { const d = by("via_diameter"), hh = by("hole_size"); set("VIA_STYLE", { dmin: bound(d, "min"), dopt: bound(d, "opt"), dmax: bound(d, "max"), hmin: bound(hh, "min"), hopt: bound(hh, "opt"), hmax: bound(hh, "max") }); }
    else if (codes === "text_height,text_thickness") set("MINIMUM_TEXT_HEIGHT_AND_THICKNESS", { height: bound(by("text_height"), "min"), thickness: bound(by("text_thickness"), "min") });
    else if (codes === "diff_pair_gap,diff_pair_uncoupled,track_width") { const w = by("track_width"), g = by("diff_pair_gap"); set("ROUTING_DIFF_PAIR", { wmin: bound(w, "min"), wopt: bound(w, "opt"), wmax: bound(w, "max"), gmin: bound(g, "min"), gopt: bound(g, "opt"), gmax: bound(g, "max"), uncoupled: bound(by("diff_pair_uncoupled"), "max") }); }
    else if (codes === "length,skew") { const l = by("length"), sk = by("skew"); set("MATCHED_LENGTH_DIFF_PAIR", { min: bound(l, "min"), opt: bound(l, "opt"), max: bound(l, "max"), skew: bound(sk, "max"), within: !!sk && sk.some((x) => Array.isArray(x) && x[0] === "within_diff_pairs") }); }
    else if (cons.length === 1) {
      const c = cons[0], code = S(c[1]);
      if (code === "assertion" && /A\.Layer == /.test(S(c[2]))) set("PERMITTED_LAYERS", { top: /'F\.Cu'/.test(S(c[2])), bottom: /'B\.Cu'/.test(S(c[2])) });
      else if (code === "assertion" && /A\.Orientation == /.test(S(c[2]))) { const v: Record<string, boolean> = {}; for (const d of [0, 90, 180, 270]) v["o" + d] = new RegExp(`== ${d} deg`).test(S(c[2])); set("ALLOWED_ORIENTATION", v); }
      else if (code === "disallow") { const items = c.slice(2).map(S); const all = items.includes("via"); set("VIAS_UNDER_SMD", { through: all || items.includes("through_via"), micro: all || items.includes("micro_via"), blind: all || items.includes("blind_via"), buried: all || items.includes("buried_via") }); }
      else if (code === "track_width") set("ROUTING_WIDTH", { min: bound(c, "min"), opt: bound(c, "opt"), max: bound(c, "max") });
      else if (code === "length") set("ABSOLUTE_LENGTH", { min: bound(c, "min"), max: bound(c, "max") });
      else if (code === "min_resolved_spokes") set("MINIMUM_THERMAL_RELIEF_SPOKE_COUNT", { value: +S(c[2]) || 0 });
      else if (code === "via_count" || code === "microvia_stack_depth" || code === "hole_aspect_ratio") set(RULE_TYPES.find((t) => t.code === code)!.id, { value: bound(c, "max") });
      else { const t = RULE_TYPES.find((x) => x.panel === "num" && x.code === code); if (t && bound(c, "min") !== null && c.length === 3) set(t.id, { value: bound(c, "min") }); }
    }
    if (rule.type !== "CUSTOM_RULE") rule.conds = parseCondition(cond); else rule.conds = [];
    out.push(rule);
  }
  return out;
}

// ---------------------------------------------------------------- the dialog
const CSS = `
.dre { display: flex; gap: 8px; height: 640px; }
.dre-left { width: 290px; flex: 0 0 auto; display: flex; flex-direction: column; gap: 6px; }
.dre-tree { flex: 1; overflow: auto; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--panel); padding: 2px 0; }
.dre-tree .n { padding: 2px 6px; cursor: default; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 4px; }
.dre-tree .n.sel { background: var(--accent); color: var(--on-accent); }
.dre-tree .n.rule { font-style: normal; } .dre-tree .n.dirty::after { content: " *"; }
.dre-tree .n .tw { width: 12px; text-align: center; color: var(--ink-2); flex: 0 0 auto; }
.dre-right { flex: 1; min-width: 0; overflow: auto; padding: 0 4px; }
.dre-hd { font-weight: 600; margin: 14px 0 2px; display: flex; align-items: center; gap: 8px; } .dre-hd:first-child { margin-top: 0; }
.dre-hd + hr { margin: 2px 0 8px; border: 0; border-top: 1px solid var(--line); }
.dre-grid { display: grid; grid-template-columns: max-content 140px max-content; gap: 6px 8px; align-items: center; }
.dre-cond { display: flex; gap: 6px; align-items: center; margin: 4px 0; } .dre-cond > .grow { flex: 1 1 auto; min-width: 120px; } .dre-cond > :not(.grow):not(button) { flex: 0 0 130px; width: 130px; min-width: 0; } .dre-cond > button { flex: 0 0 auto; }
.dre-cond .grow > * { width: 100%; }
.dre-cond input[type=text] { width: 100%; }
.dre-msg { color: var(--ink-2); white-space: pre-wrap; font-size: 12px; margin-top: 4px; } .dre-msg.err { color: var(--danger, #c33); }
.dre-custom { width: 100%; height: 220px; font-family: var(--mono, monospace); font-size: 12px; }
.dre-group { width: 100%; border-collapse: collapse; } .dre-group th, .dre-group td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; }
`;

export async function openDrcRuleEditor(ctx: ToolCtx): Promise<void> {
  if (!E.kdoc || E.kdoc.type !== "pcb") { ctx.toast("The Design Rule Editor needs a board"); return; }
  ensureCss();
  const dru = projectDoc("design_rules");
  let druText = "";
  if (dru) { try { druText = (await liveDocument(dru.docId)).file; } catch (e) { druText = ""; } }
  const ro = !canWriteProject() || !!E.viewOnly;
  let rules = loadRules(druText);
  let saved = rules.map(ruleText);
  const dirty = (r: Rule, i: number): boolean => ruleText(r) !== saved[i];
  const netNames = (): string[] => { const d = E.kdoc as (KDoc & { nets?: Map<number, string> }) | null; const s = new Set<string>(); if (d && d.nets) for (const v of d.nets.values()) if (v) s.add(String(v)); return [...s].sort(); };
  const netclasses = (): string[] => { const p = (E.proSettings || {}) as { net_settings?: { classes?: { name: string }[] } }; const c = (p.net_settings && p.net_settings.classes) || []; return ["Default", ...c.map((x) => x.name).filter((n) => n !== "Default")]; };
  const areas = (): string[] => { const out: string[] = []; for (const it of (E.kdoc as KDoc).items.values()) if (it.kind === "zone") { const n = (it.node as SNode).find((x) => Array.isArray(x) && x[0] === "name") as SNode | undefined; if (n && n[1]) out.push(String(n[1])); } return [...new Set(out)].sort(); };
  const copperLayers = (): string[] => Array.from(((E.kdoc as KDoc & { layers?: Map<string, unknown> }).layers || new Map()).keys()).filter((l) => /\.Cu$/.test(l));

  const tree = h("div", { class: "dre-tree", "data-k": "ruleTree", tabIndex: 0 });
  const right = h("div", { class: "dre-right", "data-k": "rulePanel" });
  const filter = h("input", { type: "search", placeholder: "Type filter text", "data-k": "treeFilter" }) as HTMLInputElement;
  /** the selection: a category path ("Electrical/Clearance"), a type id, or a rule index */
  let sel: { kind: "cat"; path: string } | { kind: "type"; id: string } | { kind: "rule"; i: number } = { kind: "cat", path: "" };
  const collapsed = new Set<string>();

  const buildTree = (): void => {
    const q = filter.value.trim().toLowerCase();
    const nodes: HTMLElement[] = [];
    const node = (label: string, depth: number, cls: string, isSel: boolean, onClick: () => void, key?: string, kids?: boolean): void => {
      const tw = h("span", { class: "tw" }, kids ? (key && collapsed.has(key) ? "\u25B8" : "\u25BE") : "");
      if (kids && key) tw.addEventListener("click", (ev) => { ev.stopPropagation(); if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); buildTree(); });
      const n = h("div", { class: `n ${cls}${isSel ? " sel" : ""}`, style: `padding-left:${6 + depth * 14}px`, "data-label": label }, tw, label);
      n.addEventListener("click", onClick);
      n.addEventListener("contextmenu", (ev) => { ev.preventDefault(); onClick(); treeMenu(ev.clientX, ev.clientY); });
      nodes.push(n);
    };
    const visible = (t: RuleType): boolean => !q || t.label.toLowerCase().includes(q) || rules.some((r) => r.type === t.id && r.name.toLowerCase().includes(q));
    node("Design Rules", 0, "root", sel.kind === "cat" && sel.path === "", () => { sel = { kind: "cat", path: "" }; refresh(); }, "", true);
    const cats: string[] = []; for (const t of RULE_TYPES) { for (let i = 1; i <= t.cat.length; i++) { const p = t.cat.slice(0, i).join("/"); if (!cats.includes(p)) cats.push(p); } }
    const emitCat = (path: string, depth: number): void => {
      if (![...RULE_TYPES].some((t) => t.cat.join("/").startsWith(path) && visible(t))) return;
      node(path.split("/").pop()!, depth, "cat", sel.kind === "cat" && sel.path === path, () => { sel = { kind: "cat", path }; refresh(); }, path, true);
      if (collapsed.has(path)) return;
      for (const sub of cats.filter((c) => c.startsWith(path + "/") && c.split("/").length === path.split("/").length + 1)) emitCat(sub, depth + 1);
      for (const t of RULE_TYPES.filter((x) => x.cat.join("/") === path && visible(x))) {
        const mine = rules.map((r, i) => ({ r, i })).filter(({ r }) => r.type === t.id && (!q || t.label.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)));
        node(t.label, depth + 1, "type", sel.kind === "type" && sel.id === t.id, () => { sel = { kind: "type", id: t.id }; refresh(); }, "t:" + t.id, mine.length > 0);
        if (collapsed.has("t:" + t.id)) continue;
        for (const { r, i } of mine) node(r.name || "(unnamed)", depth + 2, "rule" + (dirty(r, i) ? " dirty" : ""), sel.kind === "rule" && sel.i === i, () => { sel = { kind: "rule", i }; refresh(); });
      }
    };
    if (!collapsed.has("")) for (const c of cats.filter((x) => !x.includes("/"))) emitCat(c, 1);
    tree.replaceChildren(...nodes);
  };
  filter.addEventListener("input", buildTree);

  // ---- tree actions (RULE_EDITOR_DIALOG_BASE: new, copy, move up / down, delete)
  const selType = (): RuleType | null => (sel.kind === "type" ? typeById(sel.id) : sel.kind === "rule" ? typeById(rules[sel.i].type) : null);
  const uniqueName = (base: string): string => { let n = base, k = 1; while (rules.some((r) => r.name === n)) n = `${base}_${k++}`; return n; };
  const defaults = (t: RuleType): Record<string, number | boolean | null> => {
    switch (t.panel) {
      case "num": return { value: 0.2 }; case "int": return { value: t.code === "min_resolved_spokes" ? 2 : t.code === "hole_aspect_ratio" ? 10 : 1 };
      case "minmax": return { min: 0, max: 100 }; case "minoptmax": return { min: 0.2, opt: 0.25, max: 1 };
      case "viastyle": return { dmin: 0.5, dopt: 0.6, dmax: 1, hmin: 0.2, hopt: 0.3, hmax: 0.6 };
      case "text": return { height: 0.8, thickness: 0.12 };
      case "diffpair": return { wmin: 0.15, wopt: 0.2, wmax: 0.25, gmin: 0.15, gopt: 0.2, gmax: 0.25, uncoupled: 5 };
      case "matchlen": return { min: 0, opt: 50, max: 100, skew: 0.5, within: true };
      case "layers": return { top: true, bottom: false }; case "orient": return { o0: true, o90: true, o180: true, o270: true };
      case "smdvias": return { through: true, micro: true, blind: true, buried: true };
      default: return {};
    }
  };
  const addRule = (): void => {
    const t = selType(); if (!t || ro) return;
    const name = uniqueName(t.label.replace(/\s+/g, "_").toLowerCase());
    rules.push({ type: t.id, name, comment: "", layer: "", severity: "", conds: [{ op: "&&", obj: "A", kind: "any", value: "" }], v: defaults(t), text: t.panel === "custom" ? `(rule ${name}\n\t(constraint clearance (min 0.2mm))\n\t(condition "A.Type == 'Track'"))` : "" });
    saved.push(""); sel = { kind: "rule", i: rules.length - 1 }; collapsed.delete("t:" + t.id); refresh();
  };
  const copyRule = (): void => {
    if (sel.kind !== "rule" || ro) return;
    const src = rules[sel.i], copy: Rule = JSON.parse(JSON.stringify(src)); copy.name = uniqueName(src.name + "_copy");
    if (typeById(copy.type).panel === "custom") copy.text = copy.text.replace(/^\(rule\s+("[^"]*"|\S+)/, `(rule ${formatRuleName(copy.name)}`);
    rules.splice(sel.i + 1, 0, copy); saved.splice(sel.i + 1, 0, ""); sel = { kind: "rule", i: sel.i + 1 }; refresh();
  };
  const move = (d: number): void => {
    if (sel.kind !== "rule" || ro) return;
    const i = sel.i, t = rules[i].type; let j = i + d; while (j >= 0 && j < rules.length && rules[j].type !== t) j += d;
    if (j < 0 || j >= rules.length) return;
    [rules[i], rules[j]] = [rules[j], rules[i]]; [saved[i], saved[j]] = [saved[j], saved[i]]; sel = { kind: "rule", i: j }; refresh();
  };
  const del = (): void => {
    if (sel.kind !== "rule" || ro) return;
    const i = sel.i;
    messageBox("Confirmation", "Are you sure you want to delete?", [{ label: "Cancel" }, { label: "Delete", fn: () => { const t = rules[i].type; rules.splice(i, 1); saved.splice(i, 1); sel = { kind: "type", id: t }; deletedAny = true; refresh(); } }]);
  };
  let deletedAny = false;
  function treeMenu(x: number, y: number): void {
    const t = selType();
    popupMenu(x, y, [
      { label: "New Rule", disabled: !t || ro, run: addRule },
      { label: "Copy Rule", disabled: sel.kind !== "rule" || ro, run: copyRule },
      { label: "Delete Rule", disabled: sel.kind !== "rule" || ro, run: del },
      { label: "Move Up", disabled: sel.kind !== "rule" || ro, run: () => move(-1) },
      { label: "Move Down", disabled: sel.kind !== "rule" || ro, run: () => move(1) },
    ]);
  }
  const bAdd = bitmapButton("small_plus", "New Rule", addRule, { key: "addRule" }), bCopy = bitmapButton("copy", "Copy Rule", copyRule, { key: "copyRule" });
  const bUp = bitmapButton("small_up", "Move Up", () => move(-1), { key: "moveUp" }), bDown = bitmapButton("small_down", "Move Down", () => move(1), { key: "moveDown" });
  const bDel = bitmapButton("small_trash", "Delete Rule", del, { key: "deleteRule" });
  let closeBtn: HTMLButtonElement | null = null;
  const syncButtons = (): void => {
    const t = selType(); bAdd.disabled = !t || ro; for (const b of [bCopy, bUp, bDown, bDel]) b.disabled = sel.kind !== "rule" || ro;
    // RULE_EDITOR_DIALOG_BASE: Close, or Discard while a rule has unsaved changes
    if (closeBtn) closeBtn.textContent = anyDirty() ? "Discard" : "Close";
  };
  const anyDirty = (): boolean => deletedAny || rules.length !== saved.length || rules.some((r, i) => dirty(r, i));

  // ---- the right panel
  const lenIn = (r: Rule, k: string, key: string, onChange: () => void): HTMLElement => {
    const inp = h("input", { type: "text", "data-k": key, value: r.v[k] === null || r.v[k] === undefined ? "" : fmtLen(Number(r.v[k])) }) as HTMLInputElement; inp.disabled = ro;
    inp.addEventListener("change", () => { const v = parseLen(inp.value); r.v[k] = isNaN(v) ? null : v; if (!isNaN(v)) inp.value = fmtLen(v); onChange(); });
    return inp;
  };
  const numIn = (r: Rule, k: string, key: string, onChange: () => void): HTMLElement => {
    const inp = h("input", { type: "text", "data-k": key, value: r.v[k] === null || r.v[k] === undefined ? "" : String(r.v[k]) }) as HTMLInputElement; inp.disabled = ro;
    inp.addEventListener("change", () => { const v = parseFloat(inp.value); r.v[k] = isNaN(v) ? null : v; onChange(); });
    return inp;
  };
  const chk = (r: Rule, k: string, label: string, onChange: () => void): HTMLElement => checkField(!!r.v[k], label, { ro, key: k, onChange: (v) => { r.v[k] = v; onChange(); } }).el;
  const msg = h("div", { class: "dre-msg", "data-k": "validation" });
  /** Validate(): the messages of drc_rule_editor_utils (empty, not a number, not > 0, min > opt > max) */
  const validate = (r: Rule): string[] => {
    const t = typeById(r.type), e: string[] = [], v = r.v;
    if (!r.name.trim()) e.push("Rule name should not be empty.");
    else if (rules.some((x) => x !== r && x.name === r.name)) e.push(`Rule name '${r.name}' is already used.`);
    const pos = (k: string, label: string): void => { if (v[k] === null || v[k] === undefined || typeof v[k] !== "number") e.push(`The value of ${label} must be a valid number.`); else if ((v[k] as number) <= 0 && !/expansion/.test(t.code)) e.push(`The value of ${label} must be greater than 0.`); };
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
    return e;
  };
  const changed = (r: Rule): void => { const errs = validate(r); msg.textContent = errs.join("\n"); msg.classList.toggle("err", errs.length > 0); buildTree(); syncButtons(); };

  const constraintPanel = (r: Rule): HTMLElement => {
    const t = typeById(r.type), u = (): HTMLElement => h("span", { class: "unit" }, unitName()), on = (): void => changed(r);
    const row = (label: string, ctl: HTMLElement, unit?: HTMLElement | null): HTMLElement[] => [h("label", null, label), ctl, unit || h("span")];
    const grid3 = (...rows: HTMLElement[][]): HTMLElement => h("div", { class: "dre-grid" }, ...rows.flat());
    const mom = (p: string, q: string): HTMLElement => grid3(row(`Minimum ${q}:`, lenIn(r, p + "min", p + "min", on), u()), row(`Preferred ${q}:`, lenIn(r, p + "opt", p + "opt", on), u()), row(`Maximum ${q}:`, lenIn(r, p + "max", p + "max", on), u()));
    switch (t.panel) {
      case "num": return grid3(row(`${t.label}:`, lenIn(r, "value", "value", on), u()));
      case "int": return grid3(row(`${t.label}:`, numIn(r, "value", "value", on), null));
      case "minmax": return grid3(row("Minimum length:", lenIn(r, "min", "min", on), u()), row("Maximum length:", lenIn(r, "max", "max", on), u()));
      case "minoptmax": return mom("", "width");
      case "viastyle": return h("div", { style: "display:flex;gap:24px" }, mom("d", "via diameter"), mom("h", "hole size"));
      case "text": return grid3(row("Minimum text height:", lenIn(r, "height", "height", on), u()), row("Minimum text thickness:", lenIn(r, "thickness", "thickness", on), u()));
      case "diffpair": return h("div", null, h("div", { style: "display:flex;gap:24px" }, mom("w", "width"), mom("g", "gap")), h("div", { style: "margin-top:6px" }, grid3(row("Maximum uncoupled length:", lenIn(r, "uncoupled", "uncoupled", on), u()))));
      case "matchlen": return h("div", null, mom("", "length"), h("div", { style: "margin-top:6px" }, grid3(row("Maximum skew:", lenIn(r, "skew", "skew", on), u()))), h("div", { style: "margin-top:6px" }, chk(r, "within", "Within diff pairs", on)));
      case "layers": return h("div", null, chk(r, "top", "Top layer", on), chk(r, "bottom", "Bottom layer", on));
      case "orient": return h("div", { style: "display:flex;gap:16px" }, ...[0, 90, 180, 270].map((d) => chk(r, "o" + d, `${d}\u00B0`, on)));
      case "smdvias": return h("div", null, chk(r, "through", "Through vias", on), chk(r, "micro", "Micro vias", on), chk(r, "blind", "Blind vias", on), chk(r, "buried", "Buried vias", on));
      default: {
        const ta = h("textarea", { class: "dre-custom", "data-k": "customRule", spellcheck: false }) as HTMLTextAreaElement; ta.value = r.text; ta.disabled = ro;
        ta.addEventListener("input", () => { r.text = ta.value; const m = /^\(rule\s+("([^"]*)"|[^\s()]+)/.exec(ta.value.trim()); if (m) r.name = m[2] !== undefined ? m[2] : m[1]; on(); });
        return ta;
      }
    }
  };
  const conditionsPanel = (r: Rule): HTMLElement => {
    const t = typeById(r.type), host = h("div", { "data-k": "conditions" });
    const draw = (): void => {
      if (!r.conds.length) r.conds.push({ op: "&&", obj: "A", kind: "any", value: "" });
      const rowsEl = r.conds.map((c, i) => {
        const parts: HTMLElement[] = [];
        if (i > 0) parts.push(selectField<string>(c.op, [["&&", "AND"], ["||", "OR"], ["&& !", "AND NOT"], ["|| !", "OR NOT"]], { ro, key: "op" + i, onChange: (v) => { c.op = v as Cond["op"]; changed(r); } }).el);
        if (t.two) { const o = selectField<string>(c.obj, [["A", "Object A"], ["B", "Object B"]], { ro, key: "obj" + i, onChange: (v) => { c.obj = v as "A" | "B"; changed(r); } }); o.input.title = "Which of the two compared objects this condition applies to"; parts.push(o.el); }
        const k = selectField<string>(c.kind, [["any", "Any"], ["net", "Net"], ["netclass", "Netclass"], ["area", "Within Area"], ["custom", "Custom Query"]], { ro, key: "cond" + i, onChange: (v) => { c.kind = v as CondKind; c.value = ""; draw(); changed(r); } });
        k.input.title = "How items are matched by this condition"; parts.push(k.el);
        let val: Field<string> | null = null;
        if (c.kind === "net") { const n = netNames(); val = selectField<string>(c.value, [["", ""], ...n.map((x): [string, string] => [x, x])], { ro, key: "net" + i }); val.input.title = "Net an item must belong to"; }
        else if (c.kind === "netclass") { const n = netclasses(); val = selectField<string>(c.value, [["", ""], ...n.map((x): [string, string] => [x, x])], { ro, key: "netclass" + i }); val.input.title = "Net class an item must belong to"; }
        else if (c.kind === "area") { const n = areas(); val = selectField<string>(c.value, [["", ""], ...n.map((x): [string, string] => [x, x])], { ro, key: "area" + i }); val.input.title = "Rule area an item must be inside"; }
        else if (c.kind === "custom") { val = textField(c.value, { ro, key: "query" + i, placeholder: "A.Type == 'Via'" }); val.input.title = "Custom match expression in the DRC rule language"; }
        if (val) { const f = val; f.input.addEventListener("change", () => { c.value = f.get(); changed(r); }); f.input.addEventListener("input", () => { c.value = f.get(); changed(r); }); parts.push(h("div", { class: "grow" }, f.el)); }
        else parts.push(h("div", { class: "grow" }));
        const rm = bitmapButton("small_trash", "Remove this condition", () => { r.conds.splice(i, 1); draw(); changed(r); }, { key: "removeCond" + i, disabled: ro || r.conds.length < 2 });
        parts.push(rm);
        return h("div", { class: "dre-cond" }, ...parts);
      });
      const add = bitmapButton("small_plus", "Add another condition", () => { r.conds.push({ op: "&&", obj: "A", kind: "any", value: "" }); draw(); changed(r); }, { key: "addCond", disabled: ro });
      host.replaceChildren(h("div", { class: "pd-lbl" }, t.two ? "Where conditions match:" : "Where object matches:"), ...rowsEl, add);
    };
    draw(); return host;
  };
  const syntaxHelp = (): void => {
    const md = keysInText(RULES_HELP_MD);
    if (typeof KDialogs !== "undefined" && KDialogs) KDialogs.open({ title: "Syntax Help", width: 760, modeless: true, child: true, buttons: [], build(body: HTMLElement) { const d = h("div", { class: "kd-help", "data-k": "rules-help", style: "max-height:70vh;overflow:auto;font-size:12px;line-height:1.35" }); d.innerHTML = markdownToHtml(md); body.append(d); } } as never);
  };
  type Tools = { parseDru?: (t: string) => { errors: string[] }; ruleMatchingItems?: (d: KDoc, s: unknown, t: string, n: string) => string[] | null; designSettings?: (p: unknown) => unknown };
  const tools = (): Tools => ((globalThis as { PcbTools?: Tools }).PcbTools || {});
  const checkSyntax = (r: Rule): string[] => { const text = "(version 1)\n" + ruleText(r); const t = tools(); if (!t.parseDru) return []; const res = t.parseDru(text); return res.errors; };

  function rulePanel(r: Rule): HTMLElement {
    const t = typeById(r.type);
    const name = textField(r.name, { ro: ro || t.panel === "custom", key: "ruleName" }), comment = textField(r.comment, { ro, key: "ruleComment" });
    name.input.addEventListener("input", () => { r.name = name.get(); changed(r); });
    comment.input.addEventListener("input", () => { r.comment = comment.get(); changed(r); });
    const showBtn = h("button", { type: "button", class: "btn", "data-k": "showMatches" }, "Show Matches") as HTMLButtonElement;
    showBtn.addEventListener("click", () => {
      const tl = tools(); const errs = checkSyntax(r);
      if (errs.length || !tl.ruleMatchingItems) { showBtn.textContent = "Show Matches (error)"; return; }
      const ids = tl.ruleMatchingItems(E.kdoc as KDoc, tl.designSettings ? tl.designSettings(E.proSettings || null) : {}, "(version 1)\n" + ruleText(r), r.name);
      if (!ids) { showBtn.textContent = "Show Matches (error)"; return; }
      showBtn.textContent = `Show Matches (${ids.length})`;
      ctx.setHighlight(new Set(ids)); ctx.requestRender();
    });
    const report = h("div", { class: "dre-msg", "data-k": "syntaxReport" });
    const checkB = bitmapButton("drc", "Check rule syntax", () => { const e = checkSyntax(r).concat(validate(r)); report.textContent = e.length ? e.join("\n") : "No errors found."; report.classList.toggle("err", e.length > 0); }, { key: "checkSyntax" });
    const help = h("a", { href: "#", "data-k": "syntaxHelp", style: "margin-left:auto;font-weight:400" }, "Syntax help"); help.addEventListener("click", (ev) => { ev.preventDefault(); syntaxHelp(); });
    const layerOpts: [string, string][] = [["", "Any"], ["outer", "Outer layers"], ["inner", "Inner layers"], ...copperLayers().map((l): [string, string] => [l, l])];
    if (r.layer && !layerOpts.some(([k]) => k === r.layer)) layerOpts.push([r.layer, r.layer]);
    const layer = selectField<string>(r.layer, layerOpts, { ro, key: "ruleLayer", onChange: (v) => { r.layer = v; changed(r); } });
    const hd = (label: string, ...extra: HTMLElement[]): HTMLElement[] => [h("div", { class: "dre-hd" }, label, ...extra), h("hr")];
    const out = h("div", null,
      h("div", { style: "display:grid;grid-template-columns:max-content 1fr max-content 1fr;gap:5px 8px;align-items:center" }, h("label", null, "Name:"), name.el, h("label", null, "Comment:"), comment.el),
      ...hd("Constraint"), constraintPanel(r));
    if (t.panel !== "custom") out.append(...hd("Conditions", help), conditionsPanel(r), ...hd("Layer"), layer.el);
    else out.querySelector(".dre-hd")!.append(help);
    out.append(h("div", { style: "display:flex;gap:6px;align-items:flex-start;margin-top:12px" }, checkB, h("div", { style: "flex:1" }, report), showBtn), msg);
    changed(r);
    return out;
  }
  function groupPanel(): HTMLElement {
    // PANEL_DRC_GROUP_HEADER: Rule Type / Rule Name / Comment of the rules under the selected node
    const inType = (r: Rule): boolean => sel.kind === "type" ? r.type === sel.id : sel.kind === "cat" ? typeById(r.type).cat.join("/").startsWith(sel.path) : false;
    const rows = rules.filter(inType);
    const title = sel.kind === "type" ? typeById(sel.id).label : sel.kind === "cat" ? (sel.path.split("/").pop() || "Design Rules") : "";
    const tb = h("table", { class: "dre-group", "data-k": "groupGrid" }, h("thead", null, h("tr", null, h("th", null, "Rule Type"), h("th", null, "Rule Name"), h("th", null, "Comment"))),
      h("tbody", null, ...rows.map((r) => { const tr = h("tr", null, h("td", null, typeById(r.type).label), h("td", null, r.name), h("td", null, r.comment)); tr.addEventListener("dblclick", () => { sel = { kind: "rule", i: rules.indexOf(r) }; refresh(); }); return tr; })));
    return h("div", null, h("div", { class: "dre-hd" }, title), h("hr"), tb, sel.kind === "type" && !ro ? h("p", { class: "dre-msg" }, "Use the + button to add a rule of this type.") : "");
  }
  function refresh(): void {
    buildTree(); syncButtons();
    right.replaceChildren(sel.kind === "rule" && rules[sel.i] ? rulePanel(rules[sel.i]) : groupPanel());
  }

  const save = async (): Promise<boolean> => {
    if (ro) return false;
    for (const r of rules) { const e = validate(r); if (e.length) { messageBox("Error", `Cannot save due to validation errors in rule '${r.name}':\n\n${e.join("\n")}`); return false; } }
    const text = rulesText(rules);
    let ok = false;
    if (dru) ok = await saveTextDocument(dru.docId, text, { id: "rules", kind: "MODIFIED", typeName: "DESIGN_RULES_FILE", properties: [{ name: "text", after: { type: "string", v: text } }] });
    else {
      const board = state.project ? (state.project as { docs: { docId: string; path: string }[] }).docs.find((d) => d.docId === state.docId) : null;
      const path = board ? board.path.replace(/\.kicad_pcb$/i, "") + ".kicad_dru" : "rules.kicad_dru";
      ok = E.api && E.api.saveCustomRules ? await E.api.saveCustomRules(path, text) : false;
    }
    if (!ok) { ctx.toast("Could not save the custom rules"); return false; }
    E.druText = text; saved = rules.map(ruleText); deletedAny = false; refresh(); ctx.toast("Custom rules saved");
    return true;
  };

  const dlgApi = KDialogs ? KDialogs.open({ title: "Design Rule Editor", width: 980,
    buttons: [{ label: "Close", id: "close", fn: () => tryClose() }, ...(ro ? [] : [{ label: "Save", primary: true, id: "save", fn: () => { void save(); } }])],
    cancel: () => { if (anyDirty()) { tryClose(); return false; } ctx.setHighlight(null); return true; },
    build(body: HTMLElement) {
      body.append(h("style", null, CSS));
      const left = h("div", { class: "dre-left" }, filter, tree, h("div", { style: "display:flex;gap:4px" }, bAdd, bCopy, bUp, bDown, h("span", { style: "flex:1" }), bDel));
      body.append(h("div", { class: "dre" }, left, right));
      const dlg = body.parentElement as HTMLElement; dlg.style.maxWidth = "96vw";
      closeBtn = dlg.querySelector<HTMLButtonElement>('.kd-foot [data-btn="close"]');
      if (ro) body.prepend(h("div", { class: "pd-note", "data-k": "readOnly" }, "Project is missing or read-only. Settings will not be editable."));
      refresh();
    } } as never) as { close(): void } | null : null;
  /** the unsaved-changes prompt of DIALOG_DRC_RULE_EDITOR::OnClose */
  function tryClose(): void {
    if (!anyDirty()) { ctx.setHighlight(null); if (KDialogs) KDialogs.close(); return; }
    const names = rules.filter((r, i) => dirty(r, i)).map((r) => `  \u2022 ${r.name}`).join("\n");
    messageBox("Save Changes?", `The following rules have unsaved changes:\n\n${names || "  \u2022 (deleted rules)"}\n\nDo you want to save your changes?`, [
      { label: "Cancel" },
      { label: "Discard", fn: () => { ctx.setHighlight(null); if (KDialogs) KDialogs.close(); } },
      { label: "Save", fn: () => { void save().then((ok) => { if (ok && KDialogs) { ctx.setHighlight(null); KDialogs.close(); } }); } },
    ], 0);
  }
  void dlgApi;
}
