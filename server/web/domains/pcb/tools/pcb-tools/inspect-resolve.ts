// pcb-tools/inspect-resolve.ts — DRC_ENGINE::EvalRules with a reporter (pcbnew/drc/drc_engine.cpp), as the inspection
// reports (BOARD_INSPECTION_TOOL::InspectConstraints / reportClearance) print it: the implicit rules loadImplicitRules
// makes (board setup constraints, the micro-via and barcode defaults, the net class rules, the keepout areas), then
// the custom rules in file order, each line the way reportConstraintHeader / processConstraint write it, and around
// them the local overrides, the parent footprint's inheritance and the board defaults.
import type { BoardDoc, DesignSettings } from "./types";
import { K } from "./state";
import { netclassName, netclassOf } from "./drc";
import { netName, viaTypeOf, type RuleItem } from "./dru-eval";
import { layerOk, parseCondition, ruleMatches, setRuleConstraint, type DruConstraint, type DruRule } from "./dru";
import { padsOf } from "./route-geom";
import { itemDescription } from "./msgpanel";
import { zoneLayers } from "./nodes";

export interface MOM { min: number | null; opt: number | null; max: number | null }
export interface Resolved extends MOM { name: string; /** a rule (implicit or not) set it: DRC_CONSTRAINT::IsNull is false */ ruled: boolean; implicit: boolean; disallow: number; /** the user rule's (severity …), DRC_CONSTRAINT::GetSeverity */ severity?: string | null }
type Fmt = (mm: number) => string;
export interface ResolveCtx { doc: BoardDoc; s: DesignSettings; rules: DruRule[]; fmt: Fmt; units?: string }

export const UNDEF = "<i>undefined</i>";
const esc = (t: string): string => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** reportMin / reportOpt / reportMax */
export const repV = (c: { min?: number | null; opt?: number | null; max?: number | null }, k: "min" | "opt" | "max", fmt: Fmt): string => (c[k] != null ? fmt(c[k] as number) : UNDEF);

// DRC_DISALLOW_* (drc_rule.h)
export const DISALLOW = { THROUGH_VIAS: 1, MICRO_VIAS: 2, BLIND_VIAS: 4, BURIED_VIAS: 8, TRACKS: 16, PADS: 32, ZONES: 64, TEXTS: 128, GRAPHICS: 256, HOLES: 512, FOOTPRINTS: 1024 };
const DISALLOW_WORDS: Record<string, number> = { track: 16, via: 15, through_via: 1, micro_via: 2, blind_via: 4, buried_via: 8, pad: 32, zone: 64, text: 128, graphic: 256, hole: 512, footprint: 1024 };

// ---------------------------------------------------------------- the items
const kidNum = (n: SNode, k: string): number | null => { const c = K.kid(n, k); return c && c[1] !== undefined ? K.num(c[1]) : null; };
/** The rule item of a candidate id: a pad as "fpId#index", a footprint field as "fpId@field:Name". */
export function resolveItem(doc: BoardDoc, id: string): RuleItem | null {
  const fi = id.indexOf("@field:");
  if (fi > 0) {
    const fp = doc.items.get(id.slice(0, fi)); if (!fp) return null; const name = id.slice(fi + 7);
    const prop = fp.node.find((c) => Array.isArray(c) && c[0] === "property" && K.str(c[1]) === name) as SNode | undefined;
    const node = prop || (["property", name, ""] as unknown as SNode);
    const l = K.kid(node, "layer");
    return { kind: "property", node, parent: fp, layer: l ? K.str(l[1]) : null, id };
  }
  const h = id.indexOf("#");
  if (h > 0) {
    const fp = doc.items.get(id.slice(0, h)); if (!fp) return null; const p = padsOf(fp)[+id.slice(h + 1)]; if (!p) return null;
    return { kind: "pad", node: p.node, parent: fp, layer: p.layers.find((l) => /\.Cu$/.test(l) && !l.startsWith("*")) || (p.layers.some((l) => l.startsWith("*.Cu") || l === "F&B.Cu") ? "F.Cu" : p.layers[0] || null), id };
  }
  const it = doc.items.get(id); if (!it) return null;
  const l = K.kid(it.node, "layer"); const ls = K.kid(it.node, "layers");
  return { kind: it.kind, node: it.node, item: it, layer: l ? K.str(l[1]) : ls ? K.str(ls[1]) : null, id };
}
/** The copper layers of a "*.Cu" / "F&B.Cu" wildcard on this board. */
const copperOf = (doc: BoardDoc): string[] => (doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]);
/** BOARD_ITEM::GetLayerSet */
export function itemLayerSet(doc: BoardDoc, it: RuleItem): Set<string> {
  const out = new Set<string>(); const cu = copperOf(doc);
  const add = (l: string): void => {
    if (l === "*.Cu" || l === "F&B.Cu") { if (l === "*.Cu") cu.forEach((c) => out.add(c)); else { out.add("F.Cu"); out.add("B.Cu"); } return; }
    if (l.startsWith("*.")) { out.add("F." + l.slice(2)); out.add("B." + l.slice(2)); return; }
    out.add(l);
  };
  const n = it.node;
  if (it.kind === "via") {
    const ls = K.kid(n, "layers"); const a = ls ? K.str(ls[1]) : "F.Cu", b = ls ? K.str(ls[2] ?? ls[1]) : "B.Cu";
    const i0 = cu.indexOf(a), i1 = cu.indexOf(b); if (i0 >= 0 && i1 >= 0) for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) out.add(cu[i]); else { out.add(a); out.add(b); }
    return out;
  }
  if (it.kind === "zone") { zoneLayers(n).forEach(add); return out; }
  if (it.kind === "footprint") { for (const c of n) if (Array.isArray(c) && (c[0] === "pad" || /^fp_/.test(String(c[0])) || c[0] === "property")) { const l = K.kid(c as SNode, "layer"); const ls = K.kid(c as SNode, "layers"); if (l) add(K.str(l[1])); if (ls) ls.slice(1).forEach((x) => add(K.str(x))); } const l = K.kid(n, "layer"); if (l) add(K.str(l[1])); return out; }
  const ls = K.kid(n, "layers"); if (ls) ls.slice(1).forEach((x) => add(K.str(x)));
  const l = K.kid(n, "layer"); if (l) add(K.str(l[1]));
  return out;
}
const isConnected = (it: RuleItem): boolean => it.kind === "pad" || it.kind === "segment" || it.kind === "arc" || it.kind === "via" || (it.kind === "zone" && !K.kid(it.node, "keepout"));
const isNpth = (it: RuleItem): boolean => it.kind === "pad" && K.str(it.node[2]) === "np_thru_hole";
/** BOARD_ITEM::HasHole */
export function hasHole(it: RuleItem): boolean { if (it.kind === "via") return true; if (it.kind !== "pad") return false; const d = K.kid(it.node, "drill"); return !!d && d.slice(1).some((v) => typeof v === "number" && v > 0); }
const onCopper = (doc: BoardDoc, it: RuleItem): boolean => [...itemLayerSet(doc, it)].some((l) => /\.Cu$/.test(l));
const isKeepout = (it: RuleItem): boolean => it.kind === "zone" && !!K.kid(it.node, "keepout");
/** The net class name of a connected item (GetEffectiveNetClass), or null. */
const ncOf = (ctx: ResolveCtx, it: RuleItem | null): string | null => (it && isConnected(it) ? netclassName(ctx.s, netName(ctx.doc, it.node)) : null);
/** GetItemDescription( frame, true ) as the inspection reports quote it. */
export function describe(ctx: ResolveCtx, it: RuleItem): string { return itemDescription(ctx.doc, it.id || (it.item ? it.item.id : ""), ctx.units || "mm"); }
/** BOARD_INSPECTION_TOOL::getItemDescription: the description and, for a connected item that is not an NPTH pad, its net class. */
export function inspectionDescription(ctx: ResolveCtx, it: RuleItem): string {
  const d = describe(ctx, it);
  return isConnected(it) && !isNpth(it) ? `${d} [netclass ${netclassName(ctx.s, netName(ctx.doc, it.node))}]` : d;
}

// ---------------------------------------------------------------- the constraints walked (m_constraintMap)
interface Src {
  name: string; type: string; v: Partial<MOM>;
  /** null: a rule the user wrote; else the implicit rule's source */
  implicit: "board" | "netclass" | "keepout" | "barcode" | null;
  cond?: string; netclass?: string; layers?: string[] | null; rule?: DruRule; c?: DruConstraint; disallow?: number; keepoutOf?: KItem | null;
}
const SILK = ["F.SilkS", "B.SilkS"];
function implicitSources(ctx: ResolveCtx, type: string): Src[] {
  const s = ctx.s, out: Src[] = [];
  const B = (name: string, v: Partial<MOM>, extra?: Partial<Src>): void => { out.push({ name, type, v, implicit: "board", ...extra }); };
  switch (type) {
    case "track_width": B("board setup constraints", { min: s.minTrackWidth || 0 }); break;
    case "connection_width": B("board setup constraints", { min: s.minConn || 0 }); break;
    case "hole_size": B("board setup constraints", { min: s.minThroughDrill || 0 }); break;
    case "annular_width": B("board setup constraints", { min: s.minViaAnnular || 0 }); break;
    case "via_diameter": B("board setup constraints", { min: s.minViaDiameter || 0 }); break;
    case "hole_to_hole": B("board setup constraints", { min: s.minHoleToHole || 0 }); break;
    case "min_resolved_spokes": B("board setup constraints zone fill strategy", { min: Number(s.minResolvedSpokes ?? 2) }); break;
    case "silk_clearance": B("board setup constraints silk", { min: Number(s.minSilkClearance || 0) }, { layers: SILK }); break;
    case "text_height": B("board setup constraints silk text height", { min: s.minTextHeight || 0 }, { layers: SILK }); break;
    case "line_width": B("board setup constraints silk line width", { min: s.minSilkLineWidth || 0 }, { layers: SILK }); break;
    case "hole_clearance": B("board setup constraints hole", { min: s.holeClearance || 0 }); break;
    case "edge_clearance": B("board setup constraints edge", { min: s.edgeClearance || 0 }); break;
    case "courtyard_clearance": B("board setup constraints courtyard", {}); break;
  }
  if (type === "hole_size") B("board setup constraints micro-via", { min: s.minMicroViaDrill || 0 }, { cond: "A.Via_Type == 'Micro'" });
  if (type === "via_diameter") B("board setup constraints micro-via", { min: s.minMicroViaDiameter || 0 }, { cond: "A.Via_Type == 'Micro'" });
  if (type === "physical_clearance") out.push({ name: "barcode visual separation default", type, v: { min: 1 }, implicit: "barcode", cond: "A.Type == 'Barcode'" });
  // 3) the net classes: Default first, then the others; the clearance rules sorted by their min
  const names = ["Default", ...Object.keys(s.netclasses).filter((n) => n !== "Default")].filter((n) => !n.endsWith("\\"));   // EscapeStringLiteral: no rule for an unquotable class
  const raw = (n: string): Record<string, number | undefined> => (s.netclasses[n] || {}) as unknown as Record<string, number | undefined>;
  const has = (v: number | undefined): v is number => typeof v === "number" && v > 0;
  const NC = (n: string, v: Partial<MOM>, cond: string, suffix = ""): Src => ({ name: `netclass '${n}'${suffix}`, type, v, implicit: "netclass", cond, netclass: n });
  if (type === "clearance") {
    const cl = names.filter((n) => has(raw(n).clearance)).map((n) => NC(n, { min: raw(n).clearance as number }, `A.hasExactNetclass('${n}')`));
    cl.sort((a, b) => (a.v.min as number) - (b.v.min as number)); out.push(...cl);
  }
  for (const n of names) {
    const r = raw(n);
    if (type === "track_width" && has(r.track_width)) out.push(NC(n, { min: s.minTrackWidth || 0, opt: r.track_width }, `A.hasExactNetclass('${n}')`));
    if (type === "track_width" && has(r.diff_pair_width)) out.push(NC(n, { min: s.minTrackWidth || 0, opt: r.diff_pair_width }, `A.hasExactNetclass('${n}') && A.inDiffPair('*')`, " diff pair"));
    if (type === "diff_pair_gap" && has(r.diff_pair_gap)) out.push(NC(n, { min: s.minClearance || 0, opt: r.diff_pair_gap }, `A.hasExactNetclass('${n}')`));
    if (type === "via_diameter" && has(r.via_diameter)) out.push(NC(n, { min: s.minViaDiameter || 0, opt: r.via_diameter }, `A.hasExactNetclass('${n}') && A.Via_Type != 'Micro'`));
    if (type === "hole_size" && has(r.via_drill)) out.push(NC(n, { min: s.minThroughDrill || 0, opt: r.via_drill }, `A.hasExactNetclass('${n}') && A.Via_Type != 'Micro'`));
    if (type === "via_diameter" && has(r.microvia_diameter)) out.push(NC(n, { min: s.minMicroViaDiameter || 0, opt: r.microvia_diameter }, `A.hasExactNetclass('${n}') && A.Via_Type == 'Micro'`, " uvia"));
    if (type === "hole_size" && has(r.microvia_drill)) out.push(NC(n, { min: s.minMicroViaDrill || 0, opt: r.microvia_drill }, `A.hasExactNetclass('${n}') && A.Via_Type == 'Micro'`, " uvia"));
  }
  // 5) the keepout areas (rule areas with something kept out), board level then footprint level
  if (type === "disallow") {
    const add = (z: SNode, fp: KItem | null, id: string): void => {
      const ko = K.kid(z, "keepout"); if (!ko) return;
      const not = (k: string): boolean => { const c = K.kid(ko, k); return !!c && K.str(c[1]) === "not_allowed"; };
      let f = 0; if (not("tracks")) f |= DISALLOW.TRACKS; if (not("vias")) f |= 15; if (not("pads")) f |= DISALLOW.PADS; if (not("copperpour")) f |= DISALLOW.ZONES; if (not("footprints")) f |= DISALLOW.FOOTPRINTS;
      if (!f) return;   // isKeepoutZone( zone, true ): a rule area that keeps something out
      const nm = K.kid(z, "name"), zn = nm ? K.str(nm[1]) : "", ref = fp ? fp.ref || "" : "";
      const name = zn ? (fp ? `keepout area '${zn}' of ${ref}` : `keepout area '${zn}'`) : fp ? `keepout area of ${ref}` : "keepout area";
      out.push({ name, type, v: {}, implicit: "keepout", cond: `A.intersectsKeepout('${id}')`, layers: zoneLayers(z), disallow: f, keepoutOf: fp });
    };
    for (const it of ctx.doc.items.values()) if (it.kind === "zone") add(it.node, null, K.uuidOf(it.node) || it.id);
    for (const it of ctx.doc.items.values()) if (it.kind === "footprint") for (const z of K.kids(it.node, "zone")) add(z, it, K.uuidOf(z) || "");
  }
  return out;
}
const userSources = (ctx: ResolveCtx, type: string): Src[] => {
  const out: Src[] = [];
  for (const r of ctx.rules) for (const c of r.constraints) if (c.type === type) {
    let dis = 0; if (type === "disallow") for (const w of c.options || []) dis |= DISALLOW_WORDS[w] || 0;
    out.push({ name: `rule '${r.name}'`, type, v: { min: c.min, opt: c.opt, max: c.max }, implicit: null, rule: r, c, layers: null, disallow: dis });
  }
  return out;
};
/** DRC_ENGINE::HasRulesForConstraintType */
export const hasRulesFor = (ctx: ResolveCtx, type: string): boolean => implicitSources(ctx, type).length > 0 || userSources(ctx, type).length > 0;

const CLEARANCE_TYPES = new Set(["clearance", "courtyard_clearance", "silk_clearance", "hole_clearance", "edge_clearance", "physical_clearance", "physical_hole_clearance"]);
const MOM_TYPES = new Set(["track_width", "annular_width", "via_diameter", "hole_size", "text_height", "diff_pair_gap", "length", "line_width", "connection_width", "hole_to_hole"]);
/** reportConstraintHeader */
function header(src: Src, fmt: Fmt): string {
  const n = esc(src.name), v = src.v;
  if (CLEARANCE_TYPES.has(src.type)) return `Checking ${n} clearance: ${fmt(v.min ?? 0)}.`;
  switch (src.type) {
    case "creepage": return `Checking ${n} creepage: ${fmt(v.min ?? 0)}.`;
    case "diff_pair_uncoupled": return `Checking ${n} max uncoupled length: ${fmt(v.max ?? 0)}.`;
    case "skew": return `Checking ${n} max skew: ${fmt(v.max ?? 0)}.`;
    case "thermal_relief_gap": return `Checking ${n} gap: ${fmt(v.min ?? 0)}.`;
    case "thermal_spoke_width": return `Checking ${n} thermal spoke width: ${fmt(v.opt ?? 0)}.`;
    case "solder_mask_expansion": return `Checking ${n} solder mask expansion: ${fmt(v.opt ?? 0)}.`;
    case "solder_paste_abs_margin": return `Checking ${n} solder paste absolute clearance: ${fmt(v.opt ?? 0)}.`;
    case "solder_paste_rel_margin": return `Checking ${n} solder paste relative clearance: ${fmt(v.opt ?? 0)}.`;
    case "min_resolved_spokes": return `Checking ${n} min spoke count: ${v.min ?? 0}.`;
    case "microvia_stack_depth": return `Checking ${n} max microvia stack depth: ${v.max ?? 0}.`;
    case "hole_aspect_ratio": return `Checking ${n} max hole aspect ratio: ${((v.max ?? 0) / 1000).toFixed(3)}.`;
  }
  if (MOM_TYPES.has(src.type)) {
    if (src.implicit) {
      const om = (label: string): string => (v.opt != null ? `Checking ${n} ${label}: opt ${fmt(v.opt)}.` : `Checking ${n} ${label}: min ${fmt(v.min ?? 0)}.`);
      switch (src.type) {
        case "track_width": return om("track width");
        case "annular_width": return `Checking ${n} annular width: min ${fmt(v.opt ?? 0)}.`;
        case "via_diameter": return om("via diameter");
        case "hole_size": return om("hole size");
        case "text_height": case "line_width": case "connection_width": return `Checking ${n}: min ${fmt(v.min ?? 0)}.`;
        case "diff_pair_gap": return v.opt != null ? `Checking ${n} diff pair gap: opt ${fmt(v.opt)}.` : `Checking ${n} clearance: min ${fmt(v.min ?? 0)}.`;
        case "hole_to_hole": return `Checking ${n} hole to hole: min ${fmt(v.min ?? 0)}.`;
        default: return `Checking ${n}.`;
      }
    }
    return `Checking ${n}: min ${repV(v, "min", fmt)}; opt ${repV(v, "opt", fmt)}; max ${repV(v, "max", fmt)}.`;
  }
  return `Checking ${n}.`;
}

/** The DRC_DISALLOW_* bit an item is tested under. */
function disallowMask(ctx: ResolveCtx, a: RuleItem): number {
  switch (a.kind) {
    case "via": { const t = viaTypeOf(a.node); return t === "micro" ? DISALLOW.MICRO_VIAS : t === "blind" ? DISALLOW.BLIND_VIAS : t === "buried" ? DISALLOW.BURIED_VIAS : DISALLOW.THROUGH_VIAS; }
    case "segment": case "arc": return DISALLOW.TRACKS;
    case "pad": return DISALLOW.PADS;
    case "footprint": return DISALLOW.FOOTPRINTS;
    case "zone": return K.kid(a.node, "attr") && K.kid(K.kid(a.node, "attr") as SNode, "teardrop") ? DISALLOW.TRACKS : DISALLOW.ZONES;
    case "property": case "gr_text": case "gr_text_box": case "fp_text": case "table": return DISALLOW.TEXTS;
    case "barcode": return DISALLOW.GRAPHICS;
    default: return /^gr_|^fp_/.test(a.kind) ? DISALLOW.GRAPHICS : 0;
  }
}

/**
 * DRC_ENGINE::EvalRules( type, a, b, layer, reporter ): the lines it reports go to `out`, the resolved constraint comes
 * back.  `layer` null is UNDEFINED_LAYER.
 */
export function evalRules(ctx: ResolveCtx, type: string, a: RuleItem, b: RuleItem | null, layer: string | null, out: string[] | null): Resolved {
  const R = (t: string): void => { if (out) out.push(t); };
  const fmt = ctx.fmt, doc = ctx.doc, s = ctx.s;
  const res: Resolved = { min: null, opt: null, max: null, name: "", ruled: false, implicit: false, disallow: 0 };
  const aNonCu = !onCopper(doc, a) || isKeepout(a), bNonCu = !!b && (!onCopper(doc, b) || isKeepout(b));
  const ac = isConnected(a) ? a : null, bc = b && isConnected(b) ? b : null;
  const pad = a.kind === "pad" ? a : b && b.kind === "pad" ? b : null;
  const parentFp = pad && pad.parent ? pad.parent : null;
  const PADISH = new Set(["zone_connection", "thermal_relief_gap", "thermal_spoke_width", "solder_mask_expansion", "solder_paste_abs_margin", "solder_paste_rel_margin"]);
  const apply = (src: Src): void => {
    if (src.v.min != null) { res.min = CLEARANCE_TYPES.has(type) ? Math.min(src.v.min, 1000) : src.v.min; }
    if (src.v.opt != null) res.opt = src.v.opt;
    if (src.v.max != null) res.max = src.v.max;
    res.disallow = src.disallow || 0; res.name = src.name; res.ruled = true; res.implicit = !!src.implicit; res.severity = src.rule ? src.rule.severity : null;
  };
  // local overrides (clearance and hole clearance: the larger item override, raised to the board minimum)
  if (type === "clearance" || type === "hole_clearance") {
    const ov = (it: RuleItem | null): number | null => {
      if (!it) return null;
      if (it.kind === "pad") { const v = kidNum(it.node, "clearance"); if (v !== null) return v; return it.parent ? kidNum(it.parent.node, "clearance") : null; }
      return null;
    };
    const oa = ac && !bNonCu ? ov(ac) : null, ob = bc && !aNonCu ? ov(bc) : null;
    if (oa !== null || ob !== null) {
      let val = 0, msg = "";
      const nameOf = (it: RuleItem): string => (kidNum(it.node, "clearance") !== null ? "pad" : `footprint ${it.parent ? it.parent.ref || "" : ""}`);
      if (oa !== null) { R(""); R(`Local override on ${esc(describe(ctx, a))}; clearance: ${fmt(oa)}.`); val = oa; msg = nameOf(a); }
      if (ob !== null) { R(""); R(`Local override on ${esc(describe(ctx, b!))}; clearance: ${fmt(ob)}.`); if (ob > val) { val = ob; msg = nameOf(b!); } }
      if (val) {
        if (type === "clearance" && val < (s.minClearance || 0)) { val = s.minClearance || 0; msg = "board minimum"; R(""); R(`Board minimum clearance: ${fmt(val)}.`); }
        if (type === "hole_clearance" && val < (s.holeClearance || 0)) { val = s.holeClearance || 0; msg = "board minimum hole"; R(""); R(`Board minimum hole clearance: ${fmt(val)}.`); }
        return { ...res, min: val, name: msg, ruled: true };
      }
    }
  }
  const maskOverride = (it: RuleItem, key: string): number | null => kidNum(it.node, key);
  if (type === "solder_mask_expansion") {
    let v: number | null = null, who: RuleItem = a;
    if (a.kind === "pad" || /^gr_|^fp_/.test(a.kind) || a.kind === "segment" || a.kind === "arc" || a.kind === "via") v = maskOverride(a, "solder_mask_margin");
    if (v === null && a.kind === "pad" && a.parent) { v = kidNum(a.parent.node, "solder_mask_margin"); who = { kind: "footprint", node: a.parent.node, item: a.parent, id: a.parent.id }; }
    if (v !== null) { R(""); R(`Local override on ${esc(describe(ctx, who))}; solder mask expansion: ${fmt(v)}.`); return { ...res, opt: v }; }
  } else if (type === "solder_paste_abs_margin" || type === "solder_paste_rel_margin") {
    const rel = type === "solder_paste_rel_margin"; let v: number | null = null, who: RuleItem = a;
    if (a.kind === "pad") v = kidNum(a.node, rel ? "solder_paste_margin_ratio" : "solder_paste_margin");
    if (v === null && a.kind === "pad" && a.parent) { v = kidNum(a.parent.node, rel ? "solder_paste_ratio" : "solder_paste_margin"); who = { kind: "footprint", node: a.parent.node, item: a.parent, id: a.parent.id }; }
    if (v !== null) {
      R(""); R(rel ? `Local override on ${esc(describe(ctx, who))}; solder paste relative clearance: ${(v * 100).toFixed(4)}.` : `Local override on ${esc(describe(ctx, who))}; solder paste absolute clearance: ${fmt(v)}.`);
      return { ...res, opt: rel ? Math.round(v * 1000) : v };
    }
  }

  const srcs = [...implicitSources(ctx, type), ...userSources(ctx, type)];
  const acNc = ncOf(ctx, ac), bcNc = ncOf(ctx, bc);
  const condOf = (src: Src, A: RuleItem, B: RuleItem | null): boolean => {
    const was = setRuleConstraint(type);
    try {
      const rule: DruRule = src.rule ? { ...src.rule, layer: null } : { name: src.name, condition: src.cond || "", layer: null, severity: null, constraints: [], expr: src.cond ? parseCondition(src.cond) : null, error: null };
      if (!rule.expr) return true;
      // DRC_RULE_CONDITION::EvaluateFor: conditions are commutative
      return ruleMatches(rule, doc, s, A, B) || (!!B && ruleMatches(rule, doc, s, B, A));
    } catch (e) { return false; } finally { setRuleConstraint(was); }
  };
  const process = (src: Src, A: RuleItem, B: RuleItem | null): void => {
    const implicit = !!src.implicit;
    if (src.implicit === "netclass") {
      if (type === "clearance" && (aNonCu || bNonCu)) { R(""); R(header(src, fmt)); R("Netclass clearances apply only between copper items."); return; }
      if (src.netclass && acNc !== src.netclass && bcNc !== src.netclass) return;
      if (!condOf(src, A, B)) return;
    }
    R(""); R(header(src, fmt));
    if (type === "clearance") {
      if (aNonCu) { R(`${esc(describe(ctx, A))} contains no copper.  Constraint ignored.`); return; }
      if (bNonCu && B) { R(`${esc(describe(ctx, B))} contains no copper.  Constraint ignored.`); return; }
    } else if (type === "disallow") {
      if (src.keepoutOf && A.kind === "footprint" && A.item === src.keepoutOf) { R("Keepout belongs to the footprint under test; constraint ignored."); return; }
      const mask = hasHole(A) && A.kind === "hole" ? DISALLOW.HOLES : disallowMask(ctx, A);
      if (((src.disallow || 0) & mask) === 0) { R(implicit ? "Keepout constraint not met." : "Disallow constraint not met."); return; }
      if (src.layers) {
        const il = itemLayerSet(doc, A);
        if (A.kind === "footprint") { const cy = (side: string): boolean => A.node.some((c) => Array.isArray(c) && /^fp_/.test(String(c[0])) && (() => { const l = K.kid(c as SNode, "layer"); return !!l && K.str(l[1]) === side; })()); if (cy("F.CrtYd")) ["F.Cu", "F.SilkS", "F.Mask", "F.Paste", "F.Adhes", "F.Fab", "F.CrtYd"].forEach((l) => il.add(l)); if (cy("B.CrtYd")) ["B.Cu", "B.SilkS", "B.Mask", "B.Paste", "B.Adhes", "B.Fab", "B.CrtYd"].forEach((l) => il.add(l)); }
        if (!src.layers.some((l) => il.has(l) || (l === "*.Cu" && [...il].some((x) => /\.Cu$/.test(x))))) { R(implicit ? "Keepout layer(s) not matched." : `Rule layer '${esc(src.rule && src.rule.layerSource ? src.rule.layerSource : src.rule ? src.rule.layer || "" : "")}' not matched; rule ignored.`); return; }
      }
    }
    const layerBad = (): boolean => {
      if (src.rule) return !!layer && !!src.rule.layer && !layerOk(src.rule, layer);
      if (src.layers && src.type !== "disallow") return !!layer && !src.layers.includes(layer);
      return false;
    };
    if (layerBad()) { R(implicit ? "Constraint layer not matched." : `Rule layer '${esc(src.rule ? src.rule.layerSource || src.rule.layer || "" : "")}' not matched; rule ignored.`); return; }
    if (type === "hole_to_hole" && B && (!hasHole(A) || !hasHole(B))) { R(`${esc(describe(ctx, hasHole(A) ? B : A))} does not have a hole; rule ignored.`); return; }
    const condText = src.rule ? src.rule.condition : src.cond || "";
    if (!condText.trim()) {
      if (implicit) R("Unconditional constraint applied.");
      else if (type === "assertion") R("Unconditional rule applied.");
      else R("Unconditional rule applied; overrides previous constraints.");
      apply(src); return;
    }
    if (!implicit) R(`Checking rule condition '${esc(condText)}'.`);
    if (src.rule && src.rule.error) { R("Condition not satisfied; rule ignored."); return; }
    const ok = src.implicit === "netclass" ? true : condOf(src, A, B);
    if (ok) { R(implicit ? "Constraint applied." : type === "assertion" ? "Rule applied." : "Rule applied; overrides previous constraints."); apply(src); }
    else R(implicit ? "Membership not satisfied; constraint ignored." : "Condition not satisfied; rule ignored.");
  };
  for (const src of srcs) process(src, a, b);
  if (res.ruled && !res.implicit) return res;
  // properties a pad inherits from its footprint: the rules targeting the footprint, then the board defaults
  if (pad && parentFp && PADISH.has(type)) {
    R(""); R(`Inheriting from parent: ${esc(describe(ctx, { kind: "footprint", node: parentFp.node, item: parentFp, id: parentFp.id }))}.`);
    const F: RuleItem = { kind: "footprint", node: parentFp.node, item: parentFp, id: parentFp.id, layer: a.layer };
    for (const src of srcs) process(src, a === pad ? F : a, a === pad ? b : F);
    if (res.ruled && !res.implicit) return res;
    const setup = (doc as BoardDoc & { setupNode?: SNode | null }).setupNode || null;
    const sv = (k: string): number => (setup ? kidNum(setup, k) || 0 : 0);
    if (type === "solder_mask_expansion") return { ...res, ruled: false, name: "board setup", opt: sv("pad_to_mask_clearance") };
    if (type === "solder_paste_abs_margin") return { ...res, ruled: false, name: "board setup", opt: sv("pad_to_paste_clearance") };
    if (type === "solder_paste_rel_margin") return { ...res, ruled: false, name: "board setup", opt: Math.round(sv("pad_to_paste_clearance_ratio") * 1000) };
  }
  if (type === "clearance") {
    let clearance = res.min ?? 0, blank = true;
    const local = (it: RuleItem | null): number | null => { if (!it) return null; if (it.kind === "zone") { const cp = K.kid(it.node, "connect_pads"); const c = cp ? K.kid(cp, "clearance") : null; return c ? K.num(c[1]) : null; } if (it.kind === "pad") { const v = kidNum(it.node, "clearance"); return v !== null ? v : it.parent ? kidNum(it.parent.node, "clearance") : null; } return null; };
    for (const [it, who] of [[ac, a], [bc, b]] as [RuleItem | null, RuleItem | null][]) {
      const l = local(it); if (l === null || !who) continue;
      if (blank) { R(""); blank = false; }
      R(`Local clearance on ${esc(describe(ctx, who))}: ${fmt(l)}.`);
      if (l > clearance) { clearance = l; res.min = l; res.name = it!.kind === "zone" ? "zone" : "pad"; res.ruled = false; }
    }
    if (!aNonCu && !bNonCu) {
      if (blank) { R(""); blank = false; }
      R(`Board minimum clearance: ${fmt(s.minClearance || 0)}.`);
      if (clearance < (s.minClearance || 0)) { res.min = s.minClearance || 0; res.name = "board minimum"; }
    }
    return res;
  }
  if (!res.ruled) res.disallow = 0;
  return res;
}

/** DRC_ENGINE::ProcessAssertions with a reporter: every assertion rule that applies to the item, tested. */
export function processAssertions(ctx: ResolveCtx, a: RuleItem, out: string[]): void {
  const R = (t: string): void => { out.push(t); };
  for (const src of userSources(ctx, "assertion")) {
    const r = src.rule!, c = src.c!;
    R(""); R(`Checking ${esc(src.name)}.`);
    if (r.layer && a.layer && !layerOk(r, a.layer)) { R(`Rule layer '${esc(r.layerSource || r.layer)}' not matched; rule ignored.`); continue; }
    const was = setRuleConstraint("assertion");
    try {
      let applies = true;
      if (r.condition.trim()) { R(`Checking rule condition '${esc(r.condition)}'.`); applies = ruleMatches({ ...r, layer: null }, ctx.doc, ctx.s, a, null); }
      if (!applies) { R("Condition not satisfied; rule ignored."); continue; }
      R(r.condition.trim() ? "Rule applied." : "Unconditional rule applied.");
      const expr = String((c.options && c.options[0]) || "");
      R(`Checking assertion '${esc(expr)}'.`);
      let pass = false; try { pass = ruleMatches({ name: r.name, condition: expr, layer: null, severity: null, constraints: [], expr: parseCondition(expr), error: null }, ctx.doc, ctx.s, a, null); } catch (e) { pass = false; }
      R(pass ? "Assertion passed." : "--&gt; Assertion failed. &lt;--");
    } finally { setRuleConstraint(was); }
  }
}

// ---------------------------------------------------------------- the reports
export interface ReportPage { title: string; lines: string[]; /** a page per layer behind a "Layer:" chooser (the Clearance page) */ layers?: { name: string; lines: string[] }[] }
/** reportHeader: the title and the items (with the layer when one is given). */
function reportHeader(ctx: ResolveCtx, title: string, items: RuleItem[], layer: string | null, out: string[]): void {
  out.push(`<h7>${esc(title)}</h7>`);
  const li = items.map((it) => `<li>${esc(inspectionDescription(ctx, it))}</li>`);
  if (layer) li.unshift(`<li>${esc("Layer " + layerName(ctx, layer))}</li>`);
  out.push(`<ul>${li.join("")}</ul>`);
}
const layerName = (ctx: ResolveCtx, l: string): string => { const names = (ctx.doc as BoardDoc & { layerNames?: Map<string, string> }).layerNames; return (names && names.get(l)) || l; };
const COMPILE_ERROR = "Report incomplete: could not compile custom design rules.&nbsp;&nbsp;<a href='$CUSTOM_RULES'>Show design rules.</a>";

/** BOARD_INSPECTION_TOOL::InspectConstraints' pages for one item. */
export function constraintsReport(ctx: ResolveCtx, id: string, compileError = false): ReportPage[] | null {
  const a = resolveItem(ctx.doc, id); if (!a) return null;
  const fmt = ctx.fmt, pages: ReportPage[] = [];
  const page = (title: string): string[] => { const p: ReportPage = { title, lines: [] }; pages.push(p); return p.lines; };
  const ce = (r: string[]): void => { if (compileError) { r.push(""); r.push(COMPILE_ERROR); } };
  const mom = (c: MOM): string => `min ${repV(c, "min", fmt)}; opt ${repV(c, "opt", fmt)}; max ${repV(c, "max", fmt)}`;
  if (a.kind === "segment") {
    const r = page("Track Width"); reportHeader(ctx, "Track width resolution for:", [a], null, r);
    const c = evalRules(ctx, "track_width", a, null, a.layer || null, r); ce(r); r.push(""); r.push(`Resolved width constraints: ${mom(c)}.`);
  }
  if (a.kind === "via") {
    let r = page("Via Diameter"); reportHeader(ctx, "Via diameter resolution for:", [a], null, r);
    let c = evalRules(ctx, "via_diameter", a, null, null, r); ce(r); r.push(""); r.push(`Resolved diameter constraints: ${mom(c)}.`);
    r = page("Via Annular Width"); reportHeader(ctx, "Via annular width resolution for:", [a], null, r);
    c = evalRules(ctx, "annular_width", a, null, null, r); ce(r); r.push(""); r.push(`Resolved annular width constraints: ${mom(c)}.`);
  }
  if ((a.kind === "pad" && hasHole(a)) || a.kind === "via") {
    const r = page("Hole Size"); reportHeader(ctx, "Hole size resolution for:", [a], null, r);
    const c = evalRules(ctx, "hole_size", a, null, null, r); ce(r); r.push(""); r.push(`Resolved hole size constraints: ${mom(c)}.`);
  }
  if (a.kind === "pad" || /^gr_(line|rect|circle|arc|poly|curve|ellipse)/.test(a.kind) || a.kind === "segment" || a.kind === "arc" || a.kind === "via") {
    const r = page("Solder Mask"); reportHeader(ctx, "Solder mask expansion resolution for:", [a], null, r);
    const c = evalRules(ctx, "solder_mask_expansion", a, null, null, r); ce(r); r.push(""); r.push(`Resolved solder mask expansion: ${repV(c, "opt", fmt)}.`);
  }
  if (a.kind === "pad") {
    const r = page("Solder Paste"); reportHeader(ctx, "Solder paste absolute clearance resolution for:", [a], null, r);
    let c = evalRules(ctx, "solder_paste_abs_margin", a, null, null, r); ce(r); r.push(""); r.push(`Resolved solder paste absolute clearance: ${repV(c, "opt", fmt)}.`);
    reportHeader(ctx, "Solder paste relative clearance resolution for:", [a], null, r);
    c = evalRules(ctx, "solder_paste_rel_margin", a, null, null, r); ce(r); r.push(""); r.push(""); r.push("");
    r.push(`Resolved solder paste relative clearance: ${repV(c, "opt", fmt)}.`);
  }
  if (a.kind === "property" || a.kind === "gr_text" || a.kind === "gr_text_box") {
    const r = page("Text Size"); reportHeader(ctx, "Text height resolution for:", [a], null, r);
    let c = evalRules(ctx, "text_height", a, null, null, r); ce(r); r.push(""); r.push(`Resolved height constraints: ${mom(c)}.`);
    r.push(""); r.push(""); r.push(""); reportHeader(ctx, "Text thickness resolution for:", [a], null, r);
    c = evalRules(ctx, "line_width", a, null, null, r); ce(r); r.push(""); r.push(`Resolved thickness constraints: ${mom(c)}.`);
  }
  {
    const r = page("Keepouts"); reportHeader(ctx, "Keepout resolution for:", [a], null, r);
    const c = evalRules(ctx, "disallow", a, null, a.layer || null, r); ce(r); r.push("");
    r.push(c.disallow ? "Item <b>disallowed</b> at current location." : "Item allowed at current location.");
  }
  {
    const r = page("Assertions"); reportHeader(ctx, "Assertions for:", [a], null, r); ce(r);
    processAssertions(ctx, a, r);
  }
  return pages;
}

/** BOARD_INSPECTION_TOOL::reportClearance's checkFootprint: a footprint whose pads are all one logical pad stands for that pad. */
function footprintOrPad(doc: BoardDoc, id: string): string {
  const it = doc.items.get(id); if (!it || it.kind !== "footprint") return id;
  const pads = padsOf(it); if (!pads.length) return id;
  const n0 = pads[0].number; return pads.every((p) => p.number === n0 && !!n0) ? `${id}#${pads[0].index}` : id;
}
/**
 * BOARD_INSPECTION_TOOL::reportClearance: the Clearance Report's pages for two items (a group stands for its first
 * member, a footprint of one logical pad for that pad).  null with the infobar error when a group is empty.
 */
export function clearanceReport(ctx: ResolveCtx, idA: string, idB: string, active: string, compileError = false): { pages: ReportPage[] } | { error: string } | null {
  const doc = ctx.doc;
  const first = (id: string): string | null => { const it = doc.items.get(id); if (it && it.kind === "group") { const m = K.groupMemberIds(it.node); return m.length ? m[0] : null; } return id; };
  let ia = first(idA), ib = first(idB);
  if (ia === null || ib === null) return { error: "Cannot generate clearance report on empty group." };
  ia = footprintOrPad(doc, ia); ib = footprintOrPad(doc, ib);
  let a = resolveItem(doc, ia), b = resolveItem(doc, ib); if (!a || !b) return null;
  if (a.kind !== "zone" && b.kind === "zone") [a, b] = [b, a];
  else if (!isConnected(a) && isConnected(b)) [a, b] = [b, a];
  const fmt = ctx.fmt, pages: ReportPage[] = [];
  const la = itemLayerSet(doc, a), lb = itemLayerSet(doc, b);
  const inter = [...la].filter((l) => lb.has(l)), cuInter = copperOf(doc).filter((l) => inter.includes(l));
  const ce = (r: string[]): void => { if (compileError) { r.push(""); r.push(COMPILE_ERROR); } };
  const page = (title: string): string[] => { const p: ReportPage = { title, lines: [] }; pages.push(p); return p.lines; };
  const aFP = a.kind === "footprint", bFP = b.kind === "footprint";
  const resolvedMin = (c: Resolved): string => `Resolved min clearance: ${fmt(c.min ?? 0)}.`;
  const net = (it: RuleItem): string => netName(doc, it.node);
  const zone = a.kind === "zone" ? a : null, pad = b.kind === "pad" ? b : null;
  if (cuInter.length && zone && pad && net(zone) === net(pad)) {
    const zl = zoneLayers(zone.node); const layer = zl.includes(active) ? active : zl[0] || null;
    const r = page("Zone"); reportHeader(ctx, "Zone connection resolution for:", [a, b], layer, r);
    // DRC_ENGINE::EvalZoneConnection: the pad's own, the footprint's, the rules, the zone's
    const zcText = (v: string): string => ({ none: "none", thru_hole_only: "thermal reliefs for PTH", solid: "solid", thermal: "thermal reliefs" } as Record<string, string>)[v] || "thermal reliefs";
    const zcNode = (n: SNode): string | null => { const c = K.kid(n, "zone_connect"); return c ? ["none", "thermal", "solid", "thru_hole_only"][K.num(c[1])] || null : null; };
    let zc: string | null = zcNode(pad.node), from = "";
    if (zc) { r.push(""); r.push(`Local override on ${esc(describe(ctx, pad))}; zone connection: ${zcText(zc)}.`); }
    else if (pad.parent && (zc = zcNode(pad.parent.node))) { from = "footprint"; r.push(""); r.push(`${esc(describe(ctx, { kind: "footprint", node: pad.parent.node, item: pad.parent, id: pad.parent.id }))} zone connection: ${zcText(zc)}.`); }
    if (!zc) {
      const c = evalRules(ctx, "zone_connection", pad, zone, layer, r);
      if (c.ruled && !c.implicit) { const rs = ctx.rules.find((x) => `rule '${x.name}'` === c.name); const k = rs && rs.constraints.find((y) => y.type === "zone_connection"); zc = k && k.options ? k.options[0] : null; }
      if (!zc) { const cp = K.kid(zone.node, "connect_pads"); const v = cp && typeof cp[1] === "string" ? (cp[1] === "yes" ? "solid" : cp[1] === "no" ? "none" : cp[1] === "thru_hole_only" ? "thru_hole_only" : "thermal") : "thermal"; zc = v; r.push(""); r.push(`${esc(describe(ctx, zone))} pad connection: ${zcText(zc)}.`); }
    }
    void from;
    if (zc === "thermal") {
      r.push(""); r.push(""); reportHeader(ctx, "Thermal-relief gap resolution for:", [a, b], layer, r);
      const zoneGap = (): number => { const cp = K.kid(zone.node, "connect_pads"); const tg = K.kid(zone.node, "thermal_gap") || (cp ? K.kid(cp, "thermal_gap") : null); return tg ? K.num(tg[1]) : 0.5; };
      let g = evalRules(ctx, "thermal_relief_gap", pad, zone, layer, r); let gap = g.min;
      if (!(g.ruled && !g.implicit)) { gap = kidNum(pad.node, "thermal_gap") ?? zoneGap(); if (kidNum(pad.node, "thermal_gap") === null) { r.push(""); r.push(`${esc(describe(ctx, zone))} thermal relief gap: ${fmt(gap)}.`); } }
      ce(r); r.push(""); r.push(`Resolved thermal relief gap: ${fmt(gap ?? 0)}.`);
      r.push(""); r.push(""); reportHeader(ctx, "Thermal-relief spoke width resolution for:", [a, b], layer, r);
      g = evalRules(ctx, "thermal_spoke_width", pad, zone, layer, r); let w = g.opt;
      if (!(g.ruled && !g.implicit)) { const tb = K.kid(zone.node, "thermal_bridge_width"); w = kidNum(pad.node, "thermal_bridge_width") ?? (tb ? K.num(tb[1]) : 0.5); r.push(""); r.push(`${esc(describe(ctx, zone))} thermal spoke width: ${fmt(w)}.`); }
      ce(r); r.push(""); r.push(`Resolved spoke width: ${fmt(w ?? 0)}.`);
      r.push(""); r.push(""); reportHeader(ctx, "Thermal-relief min spoke count resolution for:", [a, b], layer, r);
      g = evalRules(ctx, "min_resolved_spokes", pad, zone, layer, r); ce(r); r.push(""); r.push(`Resolved min spoke count: ${g.min ?? 0}.`);
    } else if (zc === "none") {
      r.push(""); r.push(""); reportHeader(ctx, "Zone clearance resolution for:", [a, b], layer, r);
      const cp = K.kid(zone.node, "connect_pads"), cl = cp ? K.kid(cp, "clearance") : null; let clearance = cl ? K.num(cl[1]) : 0;
      r.push(""); r.push(`Zone clearance: ${fmt(clearance)}.`);
      let c = evalRules(ctx, "physical_clearance", pad, zone, layer, r);
      if ((c.min ?? 0) > clearance) { clearance = c.min!; r.push(""); r.push(`Overridden by larger physical clearance from ${esc(c.name)};clearance: ${fmt(clearance)}.`); }
      const flashes = !!layer && [...itemLayerSet(doc, pad)].includes(layer);
      if (!flashes) { c = evalRules(ctx, "physical_hole_clearance", pad, zone, layer, r); if ((c.min ?? 0) > clearance) { clearance = c.min!; r.push(""); r.push(`Overridden by larger physical hole clearance from ${esc(c.name)}; clearance: ${fmt(clearance)}.`); } }
      ce(r); r.push(""); r.push(`Resolved min clearance: ${fmt(clearance)}.`);
    } else {
      r.push(""); r.push(""); reportHeader(ctx, "Zone clearance resolution for:", [a, b], layer, r); ce(r); r.push(""); r.push(`Resolved min clearance: ${fmt(0)}.`);
    }
  } else if (cuInter.length && !aFP && !bFP) {
    const sameNet = isConnected(a) && isConnected(b) && !!net(a) && net(a) === net(b);
    const layers = cuInter.includes(active) ? [active, ...cuInter.filter((l) => l !== active)] : cuInter;
    const fill = (layer: string): string[] => {
      const r: string[] = []; reportHeader(ctx, "Clearance resolution for:", [a!, b!], layer, r);
      if (sameNet) { r.push("Items belong to the same net. Min clearance is 0."); return r; }
      const c = evalRules(ctx, "clearance", a!, b!, layer, r); ce(r); r.push("");
      if (!c.ruled && c.min === null) r.push("Min clearance is 0.");
      else if ((c.min ?? 0) < 0) r.push(`Resolved clearance: ${fmt(c.min!)}; clearance will not be tested.`);
      else r.push(resolvedMin(c));
      return r;
    };
    if (layers.length === 1) pages.push({ title: layerName(ctx, layers[0]), lines: fill(layers[0]) });
    else pages.push({ title: "Clearance", lines: [], layers: layers.map((l) => ({ name: layerName(ctx, l), lines: fill(l) })) });
  }
  // a differential pair: the gap and the max uncoupled length
  if (isConnected(a) && isConnected(b)) {
    const m = /^(.*?)(\+|P|-|N)$/.exec(net(a));
    const partner = m ? m[1] + ({ "+": "-", P: "N", "-": "+", N: "P" } as Record<string, string>)[m[2]] : null;
    if (partner && net(b) === partner) {
      const dpInter = copperOf(doc).filter((l) => la.has(l) && lb.has(l)); const dpLayer = dpInter.includes(active) || !dpInter.length ? active : dpInter[0];
      const r = page("Diff Pair"); reportHeader(ctx, "Diff-pair gap resolution for:", [a, b], dpLayer, r);
      let c = evalRules(ctx, "diff_pair_gap", a, b, dpLayer, r);
      const cl = evalRules(ctx, "clearance", a, b, dpLayer, null);
      r.push(""); r.push(`Resolved minimum clearance: ${fmt(cl.min ?? 0)}.`);
      if ((c.min ?? 0) < (cl.min ?? 0)) c = { ...c, min: cl.min };
      r.push(""); r.push(`Resolved gap constraints: min ${repV(c, "min", fmt)}; opt ${repV(c, "opt", fmt)}; max ${repV(c, "max", fmt)}.`);
      r.push(""); r.push(""); r.push(""); reportHeader(ctx, "Diff-pair max uncoupled length resolution for:", [a, b], dpLayer, r);
      if (!hasRulesFor(ctx, "diff_pair_uncoupled")) { r.push(""); r.push("No 'diff_pair_uncoupled' constraints defined."); }
      else { c = evalRules(ctx, "diff_pair_uncoupled", a, b, dpLayer, r); r.push(""); r.push(`Resolved max uncoupled length: ${repV(c, "max", fmt)}.`); }
    }
  }
  // silkscreen and courtyard clearances
  for (const layer of ["F.SilkS", "B.SilkS"]) {
    const front = layer.startsWith("F."), mask = front ? "F.Mask" : "B.Mask";
    const onCorr = (o: Set<string>): boolean => o.has(layer) || o.has(mask);
    if ((la.has(layer) && onCorr(lb)) || (lb.has(layer) && onCorr(la))) {
      const r = page(layerName(ctx, layer)); reportHeader(ctx, "Silkscreen clearance resolution for:", [a, b], layer, r);
      const c = evalRules(ctx, "silk_clearance", a, b, layer, r); ce(r); r.push(""); r.push(resolvedMin(c));
    }
  }
  const courtyard = (it: RuleItem, l: string): boolean => it.kind === "footprint" && it.node.some((c) => Array.isArray(c) && /^fp_/.test(String(c[0])) && (() => { const x = K.kid(c as SNode, "layer"); return !!x && K.str(x[1]) === l; })());
  for (const layer of ["F.CrtYd", "B.CrtYd"]) {
    if (courtyard(a, layer) && courtyard(b, layer)) {
      const r = page(layerName(ctx, layer)); reportHeader(ctx, "Courtyard clearance resolution for:", [a, b], layer, r);
      const c = evalRules(ctx, "courtyard_clearance", a, b, layer, r); ce(r); r.push(""); r.push(resolvedMin(c));
    }
  }
  // holes
  const isCu = (l: string | null | undefined): l is string => !!l && /\.Cu$/.test(l);
  if (hasHole(a) || hasHole(b)) {
    let layer: string | null = null; let r: string[] | null = null;
    if (hasHole(a) && lb.has(active) && isCu(active)) layer = active;
    else if (hasHole(b) && la.has(active) && isCu(active)) layer = active;
    else if (hasHole(a) && onCopper(doc, b)) layer = b.layer || null;
    else if (hasHole(b) && onCopper(doc, a)) layer = a.layer || null;
    if (layer) {
      r = page("Hole"); reportHeader(ctx, "Hole clearance resolution for:", [a, b], layer, r);
      const c = evalRules(ctx, "hole_clearance", a, b, layer, r); ce(r); r.push(""); r.push(resolvedMin(c));
    }
    if (hasHole(a) || hasHole(b)) {
      if (!r) r = page("Hole"); else { r.push(""); r.push(""); r.push(""); }
      reportHeader(ctx, "Hole-to-hole clearance resolution for:", [a, b], null, r);
      const c = evalRules(ctx, "hole_to_hole", a, b, null, r); ce(r); r.push(""); r.push(resolvedMin(c));
    }
  }
  // the board edge and the margin
  for (const edge of ["Edge.Cuts", "Margin"]) {
    let layer: string | null = null;
    if (la.has(edge) && !bFP) layer = lb.has(active) && isCu(active) ? active : isCu(b.layer) ? b.layer! : null;
    else if (lb.has(edge) && !aFP) layer = la.has(active) && isCu(active) ? active : isCu(a.layer) ? a.layer! : null;
    if (layer) {
      const r = page(`${layerName(ctx, edge)} Clearance`); reportHeader(ctx, "Edge clearance resolution for:", [a, b], layer, r);
      const c = evalRules(ctx, "edge_clearance", a, b, layer, r); ce(r); r.push(""); r.push(resolvedMin(c));
    }
  }
  // the physical clearances
  {
    const r = page("Physical Clearances");
    if (compileError) ce(r);
    else if (!hasRulesFor(ctx, "physical_clearance")) { r.push(""); r.push("No 'physical_clearance' constraints defined."); }
    else {
      const rep = new Set(inter);
      const PHYS = (o: Set<string>): string[] => [...o].filter((l) => !/^(Margin|User\.|Rescue)/.test(l));
      if (la.has("Edge.Cuts")) (bFP ? ["F.CrtYd", "B.CrtYd"] : PHYS(lb)).forEach((l) => rep.add(l));
      if (lb.has("Edge.Cuts")) (aFP ? ["F.CrtYd", "B.CrtYd"] : PHYS(la)).forEach((l) => rep.add(l));
      const order = (l: string): number => { const i = copperOf(doc).indexOf(l); return i >= 0 ? i : 100 + l.charCodeAt(0); };
      let reported = false;
      for (const layer of [...rep].sort((x, y) => order(x) - order(y))) {
        reported = true; reportHeader(ctx, "Physical clearance resolution for:", [a, b], layer, r);
        const c = evalRules(ctx, "physical_clearance", a, b, layer, r);
        r.push(""); r.push(!c.ruled ? `No 'physical_clearance' constraints in effect on ${esc(layerName(ctx, layer))}.` : resolvedMin(c));
        r.push(""); r.push(""); r.push("");
      }
      if (!reported) { reportHeader(ctx, "Physical clearance resolution for:", [a, b], null, r); r.push(""); r.push("Items share no relevant layers.  No 'physical_clearance' constraints will be applied."); }
    }
    if (hasHole(a) || hasHole(b)) {
      const layer = hasHole(a) && lb.has(active) ? active : hasHole(b) && la.has(active) ? active : hasHole(a) ? b.layer || null : a.layer || null;
      reportHeader(ctx, "Physical hole clearance resolution for:", [a, b], layer, r);
      const c = evalRules(ctx, "physical_hole_clearance", a, b, layer, r);
      if (compileError) ce(r);
      else if (!hasRulesFor(ctx, "physical_hole_clearance")) { r.push(""); r.push("No 'physical_hole_clearance' constraints defined."); }
      else { r.push(""); r.push(resolvedMin(c)); }
    }
  }
  return { pages };
}
