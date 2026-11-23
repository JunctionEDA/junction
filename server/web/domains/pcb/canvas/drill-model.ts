// canvas/drill-model.ts — the board's drill model and the tables generated from it.
//   pcbnew/drill/drill_enumerator.cpp (EnumerateDrillSpans / EnumerateDrillOperations), drill_span.h,
//   drill/drill_symbol_profile.cpp (GroupKeyString), drill/drill_symbol_assigner.cpp (AssignDrillSymbols,
//   ResolveDrillSymbols, ResolveDrillSymbolsByItem), drill/drill_chart_model.cpp (DRILL_CHART_MODEL::Build),
//   board.cpp (DrillSymbolCache, ${DRILL_OPERATIONS} ${DRILL_SITES} ${DRILL_GROUPS}),
//   board_tables/generated_table_schema.cpp, board_tables/stackup_table_model.cpp, pcb_generated_table.cpp
//   (RebuildCells, migrateRows, setAutosizedRowHeights, IsStale, SetColumns, Flip), pcb_drill_chart.cpp,
//   pcb_stackup_table.cpp, board_tables/generated_table_refresh.cpp (RefreshGeneratedTables),
//   pcb_drill_map.cpp and pcb_painter.cpp (PCB_DRILL_MAP, the chart's symbol column).
// Lengths are mm in the nodes; the drill model works in nanometres (integers) as pcbnew does, so group keys match.
import { G, bboxAdd, buildGeom, textLines } from "./geom";
import { pcbColor, pcbZ, Z_TEXT } from "./colors";
import { arcFrom3, atOf, cloneNode, effectsOf, isList, kid, kids, num, parse, ptsOf, rotator, str, uuidOf } from "./sexpr";
import { boardFinish, boardSetupChange, drillProfile, editSetup, sectionText, viaProtection, type DrillAssignment, type DrillProfile } from "./board-setup";
import { boardLayerName } from "./pcb-textvars";
import { linebreakText, strokeLine, strokeOrigin } from "./stroke-font";
import { TEXT_INTERLINE, layoutPen, lineOffsets, textWidth, unescapeText } from "./text";
import { cellStartEnd, normalizeTable, setTablePosition, tableInfo, tablePosition } from "./table-model";
import { stackupLayerDistance } from "./geom-pcb";
import type { Doc, Item, Pt } from "./types";

/** What the drill model reads of a board (a parsed Doc, or the tools' BoardDoc). */
type Board = { items: Map<string, { id: string; kind: string; node: SNode }>; layers?: Map<string, unknown>; copper?: string[]; setupNode?: SNode | null; generalNode?: SNode | null; version?: number };
const NM = (mm: number): number => Math.round(mm * 1e6);
const MM = (nm: number): number => nm / 1e6;

// ---------------------------------------------------------------- layers (layer_ids.h)
const FIXED_IDS: Record<string, number> = {
  "F.Cu": 0, "B.Cu": 2, "F.Mask": 1, "B.Mask": 3, "F.SilkS": 5, "B.SilkS": 7, "F.Adhes": 9, "B.Adhes": 11, "F.Paste": 13, "B.Paste": 15,
  "Dwgs.User": 17, "Cmts.User": 19, "Eco1.User": 21, "Eco2.User": 23, "Edge.Cuts": 25, "Margin": 27, "B.CrtYd": 29, "F.CrtYd": 31,
  "B.Fab": 33, "F.Fab": 35, "Rescue": 37,
};
/** PCB_LAYER_ID of a canonical layer name, -1 for none. */
export function layerIdOf(name: string): number {
  if (Object.prototype.hasOwnProperty.call(FIXED_IDS, name)) return FIXED_IDS[name];
  let m = /^In(\d+)\.Cu$/.exec(name); if (m) return 2 * (+m[1] + 1);
  m = /^User\.(\d+)$/.exec(name); if (m) return 39 + 2 * (+m[1] - 1);
  return -1;
}
/** IsCopperLayerLowerThan: whether copper layer a sits below b in the stack. */
export function copperLowerThan(a: string, b: string): boolean {
  if (a === b) return false; if (a === "B.Cu") return true; if (b === "B.Cu") return false;
  return layerIdOf(a) > layerIdOf(b);
}
/** CopperLayerToOrdinal: F.Cu 0, InN.Cu N, B.Cu MAX_CU_LAYERS − 1. */
const copperOrdinal = (l: string): number => (l === "F.Cu" ? 0 : l === "B.Cu" ? 31 : (layerIdOf(l) - 2) / 2);
/** DocumentationLayers(): the non-copper, non-technical layers but the outline, margin, courtyards and Rescue. */
export function isDocumentationLayer(name: string): boolean {
  return /^(Dwgs|Cmts|Eco1|Eco2)\.User$/.test(name) || name === "F.Fab" || name === "B.Fab" || /^User\.\d+$/.test(name);
}
/** The board's enabled documentation layers, in layer-id order. */
export function documentationLayers(doc: Pick<Doc, "layers">): string[] {
  const out: string[] = []; const ls = doc.layers as Map<string, unknown> | undefined;
  if (ls) for (const name of ls.keys()) if (isDocumentationLayer(name)) out.push(name);
  return out.sort((a, b) => layerIdOf(a) - layerIdOf(b));
}
/** BOARD::GetLayerName: the layer's user name, else its canonical name. */
const layerName = (doc: Board, l: string): string => boardLayerName(doc as Doc, l);
export const userLayerName = layerName;
const isBackLayer = (l: string): boolean => /^B\./.test(l);

// ---------------------------------------------------------------- the physical stackup (BOARD_STACKUP)
export interface StackupSub { thickness: number; material: string; color: string; epsilonR: number; lossTangent: number }
export interface StackupItem { layer: string | null; kind: "copper" | "dielectric" | "soldermask" | "solderpaste" | "silkscreen"; typeName: string; dielIndex: number; subs: StackupSub[] }
const NOT_SPECIFIED = "Not specified";
const sub = (o: Partial<StackupSub>): StackupSub => ({ thickness: 0, material: "", color: "", epsilonR: 1, lossTangent: 0, ...o });
/** BOARD_STACKUP_ITEM( type ): the per-type defaults the parser then overrides. */
function stackupDefaults(kind: StackupItem["kind"]): StackupSub {
  if (kind === "copper") return sub({ thickness: 0.035 });
  if (kind === "dielectric") return sub({ color: NOT_SPECIFIED, material: "FR4", lossTangent: 0.02, epsilonR: 4.5 });
  if (kind === "soldermask") return sub({ color: NOT_SPECIFIED, material: NOT_SPECIFIED, thickness: 0.01, epsilonR: 3.3 });
  if (kind === "silkscreen") return sub({ color: NOT_SPECIFIED, material: NOT_SPECIFIED, epsilonR: 1 });
  return sub({});
}
function kindOfLayer(name: string): StackupItem["kind"] | null {
  if (/\.Cu$/.test(name)) return "copper"; if (/^dielectric \d+$/.test(name)) return "dielectric";
  if (/^[FB]\.Mask$/.test(name)) return "soldermask"; if (/^[FB]\.Paste$/.test(name)) return "solderpaste"; if (/^[FB]\.SilkS$/.test(name)) return "silkscreen";
  return null;
}
/** The (stackup …) items of the file, as PCB_IO_KICAD_SEXPR_PARSER::parseBoardStackup reads them. */
function fileStackup(doc: Board): StackupItem[] {
  const st = doc.setupNode ? kid(doc.setupNode, "stackup") : null; if (!st) return [];
  const out: StackupItem[] = [];
  for (const l of kids(st, "layer")) {
    const name = str(l[1]), kind = kindOfLayer(name); if (!kind) continue;
    const groups: SNode[] = [["layer"]];
    for (let j = 2; j < l.length; j++) { const c = l[j]; if (c === "addsublayer") groups.push(["layer"]); else if (isList(c)) groups[groups.length - 1].push(c); }
    const subs = groups.map((g, gi) => {
      const d = gi === 0 ? stackupDefaults(kind) : sub({});
      const v = (k: string) => kid(g, k);
      if (v("thickness")) d.thickness = num(v("thickness")![1], 0); if (v("material")) d.material = str(v("material")![1]);
      if (v("color")) d.color = str(v("color")![1]); if (v("epsilon_r")) d.epsilonR = num(v("epsilon_r")![1], 1); if (v("loss_tangent")) d.lossTangent = num(v("loss_tangent")![1], 0);
      return d;
    });
    const t = kid(groups[0], "type"); const dm = /^dielectric (\d+)$/.exec(name);
    out.push({ layer: kind === "dielectric" ? null : name, kind, typeName: t ? str(t[1]) : kind, dielIndex: dm ? +dm[1] : 0, subs });
  }
  return out;
}
/** BOARD::GetStackupOrDefault + BOARD_STACKUP::SynchronizeWithBoard: the default list for the enabled layers, each item taken from the file where it has one. */
export function boardStackup(doc: Board): StackupItem[] {
  const enabled = (l: string): boolean => !!(doc.layers && (doc.layers as Map<string, unknown>).has(l));
  const copper = (doc.copper || []).slice().sort((a, b) => (copperLowerThan(a, b) ? 1 : copperLowerThan(b, a) ? -1 : 0));
  const nCu = Math.max(copper.length, 2);
  const gn = doc.generalNode, thick = gn && kid(gn, "thickness") ? num(kid(gn, "thickness")![1], 1.6) : 1.6;
  const masks = (enabled("F.Mask") ? 1 : 0) + (enabled("B.Mask") ? 1 : 0);
  const diel = (thick - 0.035 * nCu - 0.01 * masks) / Math.max(1, nCu - 1);
  const list: StackupItem[] = [];
  const tech = (l: string, kind: StackupItem["kind"], typeName: string) => { if (enabled(l)) list.push({ layer: l, kind, typeName, dielIndex: 0, subs: [stackupDefaults(kind)] }); };
  tech("F.SilkS", "silkscreen", "Top Silk Screen"); tech("F.Paste", "solderpaste", "Top Solder Paste"); tech("F.Mask", "soldermask", "Top Solder Mask");
  copper.forEach((l, i) => {
    list.push({ layer: l, kind: "copper", typeName: "copper", dielIndex: 0, subs: [stackupDefaults("copper")] });
    if (i < copper.length - 1) { const s = stackupDefaults("dielectric"); s.thickness = diel; list.push({ layer: null, kind: "dielectric", typeName: (i & 1) === 0 ? "core" : "prepreg", dielIndex: i + 1, subs: [s] }); }
  });
  tech("B.Mask", "soldermask", "Bottom Solder Mask"); tech("B.Paste", "solderpaste", "Bottom Solder Paste"); tech("B.SilkS", "silkscreen", "Bottom Silk Screen");
  const file = fileStackup(doc); if (!file.length) return list;
  return list.map((it) => file.find((f) => (it.kind === "dielectric" ? f.kind === "dielectric" && f.dielIndex === it.dielIndex : f.layer === it.layer)) || it);
}
/** BOARD_STACKUP::GetDrillDepth. */
export function drillDepth(doc: Board, first: string, second: string): number {
  const list = boardStackup(doc); let total = 0, half = false;
  const items = copperLowerThan(second, first) ? list : list.slice().reverse();
  for (const it of items) {
    if (it.layer !== null && it.kind !== "copper") continue;
    if (it.subs.length) for (const s of it.subs) total += half ? NM(s.thickness) / 2 | 0 : NM(s.thickness);
    else if (it.kind === "copper") total += NM(0.035);
    if (half) return total;
    if (it.layer === second) half = true;
  }
  return total;
}

// ---------------------------------------------------------------- spans and operations (drill_span.h, drill_enumerator.cpp)
export interface DrillSpan { start: string; end: string; backdrill: boolean; npth: boolean }
export const spanTop = (s: DrillSpan): string => (copperLowerThan(s.start, s.end) ? s.end : s.start);
export const spanBottom = (s: DrillSpan): string => (copperLowerThan(s.start, s.end) ? s.start : s.end);
function spanLess(a: DrillSpan, b: DrillSpan): number {
  const at = layerIdOf(spanTop(a)), bt = layerIdOf(spanTop(b)); if (at !== bt) return at - bt;
  const ab = layerIdOf(spanBottom(a)), bb = layerIdOf(spanBottom(b)); if (ab !== bb) return ab - bb;
  if (a.backdrill !== b.backdrill) return a.backdrill ? -1 : 1;
  if (a.npth !== b.npth) return a.npth ? -1 : 1;
  if (a.start !== b.start) return layerIdOf(a.start) - layerIdOf(b.start);
  return layerIdOf(a.end) - layerIdOf(b.end);
}
const spanEq = (a: DrillSpan, b: DrillSpan): boolean => a.start === b.start && a.end === b.end && a.backdrill === b.backdrill && a.npth === b.npth;
const isFB = (s: DrillSpan): boolean => spanTop(s) === "F.Cu" && spanBottom(s) === "B.Cu";
/** PCB_VIA::LayerPair: its top and bottom copper. */
function viaPair(n: SNode): [string, string] {
  const ls = kid(n, "layers"); const a = ls ? str(ls[1]) : "F.Cu", b = ls ? str(ls[2]) : "B.Cu";
  return copperLowerThan(a, b) ? [b, a] : [a, b];
}
/** A padstack's secondary / tertiary drill: (backdrill (size s) (layers start end)). */
function extraDrill(n: SNode, key: string): { start: string; end: string; size: number } | null {
  const d = kid(n, key); if (!d) return null;
  const ls = kid(d, "layers"), s = kid(d, "size"); const size = s ? NM(num(s[1], 0)) : 0;
  const start = ls ? str(ls[1]) : "", end = ls ? str(ls[2]) : "";
  return start && end && size > 0 ? { start, end, size } : null;
}
function vias(doc: Board): SNode[] { const out: SNode[] = []; for (const it of doc.items.values()) if (it.kind === "via") out.push(it.node); return out; }
/** EnumerateDrillSpans (no pad backdrills, as every caller here asks). */
export function enumerateDrillSpans(doc: Board): DrillSpan[] {
  const uniq: DrillSpan[] = [];
  const add = (s: DrillSpan) => { if (!uniq.some((u) => spanEq(u, s))) uniq.push(s); };
  for (const v of vias(doc)) {
    const [top, bottom] = viaPair(v);
    if (!(top === "F.Cu" && bottom === "B.Cu")) add({ start: top, end: bottom, backdrill: false, npth: false });
    for (const key of ["backdrill", "tertiary_drill"]) { const d = extraDrill(v, key); if (d) add({ start: d.start, end: d.end, backdrill: true, npth: false }); }
  }
  uniq.sort(spanLess);
  return [{ start: "F.Cu", end: "B.Cu", backdrill: false, npth: false }, ...uniq.filter((s) => s.backdrill || !isFB(s))];
}
export interface PostMachining { mode: number; size: number; depth: number; angle: number }
export interface DrillOp {
  sourceId: string; kind: number; attr: number; notPlated: boolean; top: string; bottom: string;
  diameter: number; sizeXY: [number, number]; isSlot: boolean; pos: [number, number]; orient: number; stub: number | null;
  filled: boolean; capped: boolean; topCovered: boolean; bottomCovered: boolean; topPlugged: boolean; bottomPlugged: boolean; topTented: boolean; bottomTented: boolean;
  front: PostMachining; back: PostMachining;
}
const NO_PM: PostMachining = { mode: 0, size: 0, depth: 0, angle: 0 };
function postMachining(n: SNode, key: string): PostMachining {
  const pm = kid(n, key); if (!pm) return NO_PM;
  const m = str(pm[1]); const mode = m === "counterbore" ? 2 : m === "countersink" ? 3 : m === "none" || m === "" ? 0 : 1;
  const v = (k: string) => { const c = kid(pm, k); return c ? num(c[1], 0) : 0; };
  return { mode, size: NM(v("size")), depth: NM(v("depth")), angle: Math.round(v("angle") * 10) };
}
const opBase = (): Omit<DrillOp, "sourceId" | "kind" | "attr" | "notPlated" | "top" | "bottom" | "diameter" | "sizeXY" | "isSlot" | "pos" | "orient"> => ({
  stub: null, filled: false, capped: false, topCovered: false, bottomCovered: false, topPlugged: false, bottomPlugged: false, topTented: false, bottomTented: false, front: NO_PM, back: NO_PM });
/** frontBack (fab/model.ts): (tenting front back) or (tenting (front yes) (back none)); undefined where unset. */
function frontBack(n: SNode | null): [boolean | undefined, boolean | undefined] {
  if (!n) return [undefined, undefined];
  if (n.slice(1).some((x) => !isList(x))) return [n.includes("front") ? true : undefined, n.includes("back") ? true : undefined];
  const v = (k: SNode | null) => (k ? (str(k[1]) === "none" ? undefined : str(k[1]) !== "no") : undefined);
  return [v(kid(n, "front")), v(kid(n, "back"))];
}
interface DrillQuery { span: DrillSpan; nonPlatedOnly?: boolean; merge?: boolean }
/** EnumerateDrillOperations. */
export function enumerateDrillOperations(doc: Board, q: DrillQuery): DrillOp[] {
  const out: DrillOp[] = []; const span = q.span;
  const top = spanTop(span), bottom = spanBottom(span);
  if (!q.nonPlatedOnly) {
    const bd = viaProtection(doc.setupNode || null); const legacy = (doc.version || 0) > 0 && (doc.version || 0) < 20250228;
    for (const it of doc.items.values()) {
      if (it.kind !== "via") continue; const v = it.node; const [x, y] = atOf(v);
      if (span.backdrill) {
        ([["backdrill", 1], ["tertiary_drill", 2]] as [string, number][]).forEach(([key, kind]) => {
          const d = extraDrill(v, key); if (!d || d.start !== span.start || d.end !== span.end) return;
          out.push({ ...opBase(), sourceId: it.id, kind, attr: 3, notPlated: true, top, bottom, diameter: d.size, sizeXY: [d.size, d.size], isSlot: false,
            pos: [NM(x), NM(y)], orient: 0, stub: drillDepth(doc, d.start, d.end) });
        });
        continue;
      }
      const dr = kid(v, "drill"); const hole = dr ? NM(num(dr[1], 0)) : 0; if (!hole) continue;
      const [vt, vb] = viaPair(v); if (!((vt === top && vb === bottom) || (vt === bottom && vb === top))) continue;
      const own = (key: string): boolean | undefined => { const k = kid(v, key); return k && k.length > 1 && str(k[1]) !== "none" ? str(k[1]) !== "no" : undefined; };
      let [tf, tb] = frontBack(kid(v, "tenting")); let [cf, cb] = frontBack(kid(v, "covering")), [pf, pb] = frontBack(kid(v, "plugging"));
      let cap = own("capping"), fill = own("filling");
      if (legacy) { cf = cf ?? false; cb = cb ?? false; pf = pf ?? false; pb = pb ?? false; cap = cap ?? false; fill = fill ?? false; }
      tf = tf ?? bd.tentFront; tb = tb ?? bd.tentBack;
      const op: DrillOp = { ...opBase(), sourceId: it.id, kind: 0, attr: isFB(span) ? 1 : 2, notPlated: false, top: vt, bottom: vb, diameter: hole, sizeXY: [hole, hole], isSlot: false,
        pos: [NM(x), NM(y)], orient: 0, filled: fill ?? bd.fill, capped: cap ?? bd.cap, front: postMachining(v, "front_post_machining"), back: postMachining(v, "back_post_machining") };
      if (vt === "F.Cu") { op.topCovered = cf ?? bd.coverFront; op.topPlugged = pf ?? bd.plugFront; op.topTented = tf; }
      if (vb === "B.Cu") { op.bottomCovered = cb ?? bd.coverBack; op.bottomPlugged = pb ?? bd.plugBack; op.bottomTented = tb; }
      out.push(op);
    }
  }
  if (!span.backdrill && isFB(span)) {
    for (const it of doc.items.values()) {
      if (it.kind !== "footprint") continue;
      const [fx, fy, frot] = atOf(it.node); const R = rotator(frot);
      for (const pad of kids(it.node, "pad")) {
        const attr = str(pad[2]); const npth = attr === "np_thru_hole";
        if (!q.merge) { if (!q.nonPlatedOnly && npth) continue; if (q.nonPlatedOnly && !npth) continue; }
        const dr = kid(pad, "drill"); if (!dr) continue;
        const oval = dr[1] === "oval"; const nums = dr.slice(oval ? 2 : 1).filter((c) => typeof c === "number" || (typeof c === "string" && /^[-\d.]/.test(c)));
        const dx = NM(num(nums[0], 0)), dy = nums.length > 1 ? NM(num(nums[1], 0)) : dx; if (!dx) continue;
        const [lx, ly, prot] = atOf(pad); const [rx, ry] = R(lx, ly);
        const prop = kid(pad, "property"); const pp = prop ? str(prop[1]) : "";
        out.push({ ...opBase(), sourceId: it.id, kind: 0, attr: npth ? 7 : pp === "pad_prop_castellated" ? 5 : pp === "pad_prop_pressfit" ? 6 : 4, notPlated: npth,
          top: "F.Cu", bottom: "B.Cu", diameter: Math.min(dx, dy), sizeXY: [dx, dy], isSlot: oval && dx !== dy, pos: [NM(fx + rx), NM(fy + ry)], orient: prot });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- symbol profile, groups, assignments
export interface ChartFilter { plated: boolean; npth: boolean; vias: boolean; slots: boolean; backdrill: boolean; castellated: boolean }
export const FILTER_ALL: ChartFilter = { plated: true, npth: true, vias: true, slots: true, backdrill: true, castellated: true };
/** DRILL_SYMBOL_PROFILE::GroupKeyString. */
export function groupKeyString(p: DrillProfile, op: DrillOp): string {
  const by = (k: string) => p.groupBy.includes(k); let key = "v1";
  if (by("size")) key += `|d${op.diameter}`;
  if (by("slot")) key += op.isSlot ? `|s${op.sizeXY[0]}x${op.sizeXY[1]}` : "|s-";
  if (by("plating")) key += op.notPlated ? "|p0" : "|p1";
  if (by("span")) key += `|L${copperOrdinal(op.top)}-${copperOrdinal(op.bottom)}`;
  if (by("operation")) key += `|k${op.kind}`;
  if (by("hole_function")) key += `|a${op.attr}`;
  if (by("protection")) key += "|r" + [op.filled, op.capped, op.topCovered, op.bottomCovered, op.topPlugged, op.bottomPlugged, op.topTented, op.bottomTented].map((b) => (b ? 1 : 0)).join("");
  if (by("post_machining")) { const f = op.front, b = op.back; key += `|m${f.mode}:${f.size}:${f.depth}:${f.angle}/${b.mode}:${b.size}:${b.depth}:${b.angle}`; }
  return key;
}
export interface ChartGroup extends Omit<DrillOp, "sourceId" | "pos" | "orient"> { key: string; ops: number; slots: number; members: string[]; sites: [number, number][]; symbol: DrillAssignment | null }
export interface ChartTotals { operations: number; sites: number; groups: number }
function matchesFilter(op: DrillOp, f: ChartFilter): boolean {
  if (op.notPlated && !f.npth) return false; if (!op.notPlated && !f.plated) return false;
  if (op.isSlot && !f.slots) return false; if (op.kind !== 0 && !f.backdrill) return false;
  if (op.attr === 5 && !f.castellated) return false; if ((op.attr === 1 || op.attr === 2) && !f.vias) return false;
  return true;
}
/** DRILL_CHART_MODEL::Build. */
export function buildChartModel(doc: Board, p: DrillProfile, spans: DrillSpan[], filter: ChartFilter = FILTER_ALL): { groups: ChartGroup[]; totals: ChartTotals } {
  const byKey = new Map<string, ChartGroup>(), sites = new Map<string, Map<string, [number, number]>>();
  const collect = (q: DrillQuery) => {
    for (const op of enumerateDrillOperations(doc, q)) {
      if (!matchesFilter(op, filter)) continue;
      const key = groupKeyString(p, op); let g = byKey.get(key);
      if (!g) { const { sourceId: _s, pos: _p, orient: _o, ...rest } = op; g = { ...rest, key, ops: 0, slots: 0, members: [], sites: [], symbol: null }; byKey.set(key, g); sites.set(key, new Map()); }
      g.ops++; if (op.isSlot) g.slots++; g.members.push(op.sourceId);
      sites.get(key)!.set(op.pos[0] + "," + op.pos[1], op.pos);
    }
  };
  for (const span of spans) { collect({ span }); collect({ span, nonPlatedOnly: true }); }
  const all = new Set<string>(); let operations = 0; const groups: ChartGroup[] = [];
  for (const key of [...byKey.keys()].sort()) {
    const g = byKey.get(key)!; const s = [...sites.get(key)!.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    g.sites = s; for (const q of s) all.add(q[0] + "," + q[1]); operations += g.ops; groups.push(g);
  }
  groups.sort((a, b) => (a.notPlated !== b.notPlated ? (a.notPlated ? 1 : -1) : a.diameter !== b.diameter ? a.diameter - b.diameter : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { groups, totals: { operations, sites: all.size, groups: groups.length } };
}
/** DRILL_MARKERS::CuratedShapeCount / the curated marker indexes. */
export const CURATED_SHAPES = [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 16];
/** AssignDrillSymbols: frozen assignments first, then the policy's next free shape or letter; stored into the profile. */
export function assignDrillSymbols(groups: ChartGroup[], p: DrillProfile): void {
  const map = new Map<string, DrillAssignment>(); for (const a of p.assignments || []) map.set(a.key, a);
  const usedShapes = new Set<number>(), usedLetters = new Set<string>();
  if (p.freeze) for (const g of groups) { const e = map.get(g.key); if (!e) continue; g.symbol = e; if (e.mode === "shape") usedShapes.add(e.shape); else if (e.mode === "letter") usedLetters.add(e.letter); }
  const nextLetter = (): string => {
    for (let i = 0; i < 26 * 27; ++i) { const c = i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(65 + Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)); if (!usedLetters.has(c)) return c; }
    return "?";
  };
  for (const g of groups) {
    if (p.freeze && map.has(g.key)) continue;
    const a: DrillAssignment = { key: g.key, mode: "shape", shape: 0, letter: "", descr: "" };
    if (p.markPolicy === "size_text") a.mode = "size_text";
    else if (p.markPolicy === "letters") { a.mode = "letter"; a.letter = nextLetter(); usedLetters.add(a.letter); }
    else {
      let shape = -1; for (let i = 0; i < CURATED_SHAPES.length; i++) if (!usedShapes.has(i)) { shape = i; break; }
      if (shape >= 0) { a.shape = shape; usedShapes.add(shape); }
      else if (p.markPolicy === "shapes_then_letters") { a.mode = "letter"; a.letter = nextLetter(); usedLetters.add(a.letter); }
    }
    g.symbol = a; map.set(g.key, a);
  }
  p.assignments = [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
export const cloneProfile = (p: DrillProfile): DrillProfile => ({ ...p, groupBy: p.groupBy.slice(), assignments: (p.assignments || []).map((a) => ({ ...a })) });
export const boardProfile = (doc: Board): DrillProfile => drillProfile(doc.setupNode || null);
/** ResolveDrillSymbols: the assignment run on a copy of the board's profile over every group. */
export function resolveDrillSymbols(doc: Board): Map<string, DrillAssignment> {
  const p = cloneProfile(boardProfile(doc)); const { groups } = buildChartModel(doc, p, enumerateDrillSpans(doc));
  assignDrillSymbols(groups, p); const out = new Map<string, DrillAssignment>(); for (const g of groups) if (g.symbol) out.set(g.key, g.symbol);
  return out;
}
export interface SymbolEntry { symbol: DrillAssignment; span: DrillSpan; pos: [number, number]; kind: number; diameter: number; sizeXY: [number, number]; orient: number; isSlot: boolean }
export interface SymbolCache { byGroup: Map<string, DrillAssignment>; byItem: Map<string, SymbolEntry[]>; totals: ChartTotals; extent: [number, number, number, number] | null; profile: DrillProfile }

// ---------------------------------------------------------------- the drill model generation (BOARD::m_drillModelGeneration)
interface DrillState { gen: number; nodes: unknown[]; cache: SymbolCache | null; cacheKey: string; builtGen: number }
const STATE = new WeakMap<object, DrillState>();
/** The items the drill model reads (affectsDrillModel): vias, footprints, the outline, drill maps, and the setup. */
function drillInputs(doc: Board): unknown[] {
  const out: unknown[] = [doc.setupNode || null, doc.generalNode || null, doc.layers];
  for (const it of doc.items.values()) if (it.kind === "via" || it.kind === "footprint" || it.kind === "drill_map" || (it as { edge?: boolean }).edge) out.push(it.node);
  return out;
}
function drillState(doc: Board): DrillState {
  let s = STATE.get(doc); if (!s) { s = { gen: 1, nodes: drillInputs(doc), cache: null, cacheKey: "", builtGen: 0 }; STATE.set(doc, s); return s; }
  const now = drillInputs(doc);
  if (now.length !== s.nodes.length || now.some((n, i) => n !== s!.nodes[i])) { s.gen++; s.nodes = now; }
  return s;
}
/** BOARD::GetDrillModelGeneration. */
export const drillModelGeneration = (doc: Board): number => drillState(doc).gen;
/** BOARD::DrillSymbolCache. */
export function drillSymbolCache(doc: Board): SymbolCache {
  const s = drillState(doc); const profile = boardProfile(doc); const key = s.gen + "|" + JSON.stringify(profile);
  if (s.cache && s.cacheKey === key) return s.cache;
  const byGroup = resolveDrillSymbols(doc); const byItem = new Map<string, SymbolEntry[]>();
  let extent: [number, number, number, number] | null = null;
  for (const span of enumerateDrillSpans(doc)) {
    for (const op of enumerateDrillOperations(doc, { span, merge: true })) {
      const sym = byGroup.get(groupKeyString(profile, op)); if (!sym) continue;
      const e: SymbolEntry = { symbol: sym, span, pos: op.pos, kind: op.kind, diameter: op.diameter, sizeXY: op.sizeXY, orient: op.orient, isSlot: op.isSlot };
      const l = byItem.get(op.sourceId); if (l) l.push(e); else byItem.set(op.sourceId, [e]);
      extent = extent ? [Math.min(extent[0], op.pos[0]), Math.min(extent[1], op.pos[1]), Math.max(extent[2], op.pos[0]), Math.max(extent[3], op.pos[1])] : [op.pos[0], op.pos[1], op.pos[0], op.pos[1]];
    }
  }
  const totals = buildChartModel(doc, profile, enumerateDrillSpans(doc)).totals;
  s.cache = { byGroup, byItem, totals, extent, profile }; s.cacheKey = key;
  return s.cache;
}
/** BOARD::ResolveTextVar's ${DRILL_OPERATIONS} ${DRILL_SITES} ${DRILL_GROUPS}; null for any other token. */
export function drillTextVar(doc: Board, token: string): string | null {
  if (token !== "DRILL_OPERATIONS" && token !== "DRILL_SITES" && token !== "DRILL_GROUPS") return null;
  if (!doc || !doc.items) return "0";
  const t = drillSymbolCache(doc).totals;
  return String(token === "DRILL_OPERATIONS" ? t.operations : token === "DRILL_SITES" ? t.sites : t.groups);
}
const mentionsDrill = (n: unknown): boolean => (typeof n === "string" ? n.indexOf("${DRILL_") >= 0 : isList(n) ? (n as unknown[]).some(mentionsDrill) : false);
/**
 * The geometry that reads the drill model (drill maps, drill charts' symbols, text naming ${DRILL_…}): built again when
 * the model's generation moved since it was last built (BOARD::RefreshDrillSymbolLayers / the painter's cache).
 */
export function refreshDrillGeometry(doc: Doc): void {
  if (!doc || doc.type !== "pcb" || doc.fpEditor) return;
  const s = drillState(doc); if (s.builtGen === s.gen) return;
  const first = s.builtGen === 0; s.builtGen = s.gen;
  if (first) return;   // parseDoc has just built every item
  for (const it of doc.items.values()) {
    if (it.kind === "drill_map" || (it.kind === "table" && it.node[0] === "drill_chart")
      || ((it.kind === "gr_text" || it.kind === "gr_text_box" || it.kind === "table" || it.kind === "footprint" || it.kind === "dimension") && mentionsDrill(it.node))) {
      try { buildGeom(doc, it); } catch (e) { /* an item without geometry */ }
    }
  }
}

// ---------------------------------------------------------------- markers (DRILL_MARKERS::BuildMarker)
const MARKER_PATTERNS = [0o003, 0o100, 0o014, 0o040, 0o020, 0o103, 0o017, 0o043, 0o023, 0o114, 0o140, 0o120, 0o054, 0o034, 0o060,
  0o117, 0o143, 0o123, 0o057, 0o037, 0o063, 0o154, 0o134, 0o074, 0o174, 0o163, 0o157, 0o137, 0o077, 0o177,
  0o110, 0o104, 0o101, 0o050, 0o044, 0o041, 0o030, 0o024, 0o021, 0o150, 0o144, 0o141, 0o130, 0o124, 0o121, 0o070, 0o064, 0o061, 0o170, 0o164, 0o161,
  0o102, 0o042, 0o022, 0o142, 0o122, 0o062, 0o162];
/** The strokes of curated marker `shape` of radius r at (x, y): polylines and circles. */
export function markerParts(x: number, y: number, r: number, shape: number): ({ k: "line"; pts: Pt[] } | { k: "circle"; r: number })[] {
  const id = CURATED_SHAPES[shape] !== undefined ? CURATED_SHAPES[shape] : shape;
  if (id >= MARKER_PATTERNS.length) return [{ k: "circle", r }];
  const pat = MARKER_PATTERNS[id], out: ({ k: "line"; pts: Pt[] } | { k: "circle"; r: number })[] = [];
  if (pat & 0o001) out.push({ k: "line", pts: [[x - r, y - r], [x + r, y + r]] });
  if (pat & 0o002) out.push({ k: "line", pts: [[x + r, y - r], [x - r, y + r]] });
  if (pat & 0o004) out.push({ k: "line", pts: [[x, y - r], [x, y + r]] });
  if (pat & 0o010) out.push({ k: "line", pts: [[x - r, y], [x + r, y]] });
  if (pat & 0o020) out.push({ k: "line", pts: [[x, y + r], [x + r, y], [x, y - r], [x - r, y], [x, y + r]] });
  if (pat & 0o040) { const q = r / 1.4142; out.push({ k: "line", pts: [[x + q, y + q], [x + q, y - q], [x - q, y - q], [x - q, y + q], [x + q, y + q]] }); }
  if (pat & 0o100) out.push({ k: "circle", r });
  return out;
}
function drawMarker(item: Item, x: number, y: number, r: number, shape: number, w: number, layer: string): void {
  const color = pcbColor(layer), z = pcbZ(layer) + Z_TEXT;
  for (const p of markerParts(x, y, r, shape)) {
    if (p.k === "circle") G(item, { t: "circle", x, y, r: p.r, w, color, layer, z });
    else for (let i = 0; i + 1 < p.pts.length; i++) G(item, { t: "line", x1: p.pts[i][0], y1: p.pts[i][1], x2: p.pts[i + 1][0], y2: p.pts[i + 1][1], w, color, layer, z, cap: "round" });
  }
}

// ---------------------------------------------------------------- PCB_DRILL_MAP
export interface DrillMap { layer: string; offset: Pt; size: number; allSpans: boolean; span: DrillSpan; outlineSlots: boolean; guideCross: boolean; locked: boolean }
export function readDrillMap(n: SNode, doc?: Board | null): DrillMap {
  const o = kid(n, "offset"), s = kid(n, "size"), sp = kid(n, "span"), y = (k: string, d: boolean) => { const c = kid(n, k); return c ? str(c[1]) !== "no" : d; };
  const all = !sp || str(sp[1]) === "all";
  return { layer: str((kid(n, "layer") || [])[1]) || "Dwgs.User", offset: [o ? num(o[1]) : 0, o ? num(o[2]) : 0], size: s ? num(s[1]) : (doc ? boardProfile(doc).size : 1.5),
    allSpans: all, span: all ? { start: "F.Cu", end: "B.Cu", backdrill: false, npth: false } : { start: str(sp![1]), end: str(sp![2]), backdrill: sp!.includes("backdrill"), npth: sp!.includes("npth") },
    outlineSlots: y("outline_slots", true), guideCross: y("guide_cross", false), locked: y("locked", false) };
}
const q = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const f6 = (v: number): string => String(+(+v).toFixed(6));
/** PCB_IO_KICAD_SEXPR::format( PCB_DRILL_MAP ). */
export function drillMapNode(m: DrillMap, uuid: string): SNode {
  const span = m.allSpans ? "(span all)" : `(span ${q(m.span.start)} ${q(m.span.end)}${m.span.backdrill ? " backdrill" : ""}${m.span.npth ? " npth" : ""})`;
  return parse(`(drill_map (uuid ${q(uuid)})${m.locked ? "(locked yes)" : ""}(layer ${q(m.layer)})(offset ${f6(m.offset[0])} ${f6(m.offset[1])})(size ${f6(m.size)})${span}(outline_slots ${m.outlineSlots ? "yes" : "no"})(guide_cross ${m.guideCross ? "yes" : "no"}))`) as SNode;
}
/** BOARD::GetBoardPolygonOutlines' contours: the Edge.Cuts drawings chained end to end. */
export function boardOutlines(doc: Board): Pt[][] {
  const chains: Pt[][] = [];
  const take = (kind: string, g: SNode, tf: (x: number, y: number) => Pt) => {
    const P = (key: string): Pt | null => { const p = kid(g, key); return p ? tf(num(p[1]), num(p[2])) : null; };
    if (kind === "line") { const a = P("start"), b = P("end"); if (a && b) chains.push([a, b]); }
    else if (kind === "rect") { const s = kid(g, "start"), e = kid(g, "end"); if (s && e) { const x0 = num(s[1]), y0 = num(s[2]), x1 = num(e[1]), y1 = num(e[2]); const pts = [tf(x0, y0), tf(x1, y0), tf(x1, y1), tf(x0, y1)]; chains.push(pts.concat([pts[0]])); } }
    else if (kind === "circle") { const c = P("center"), e = P("end"); if (c && e) { const r = Math.hypot(e[0] - c[0], e[1] - c[1]); const pts: Pt[] = []; for (let i = 0; i <= 64; i++) pts.push([c[0] + r * Math.cos(i * Math.PI / 32), c[1] + r * Math.sin(i * Math.PI / 32)]); chains.push(pts); } }
    else if (kind === "arc") {
      const a = P("start"), m = P("mid"), b = P("end"); if (!a || !m || !b) return; const arc = arcFrom3(a, m, b); if (!arc) { chains.push([a, b]); return; }
      let a0 = arc.a0, a1 = arc.a1; if (arc.anticlockwise) { if (a1 > a0) a1 -= 2 * Math.PI; } else if (a1 < a0) a1 += 2 * Math.PI;
      const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 32))); const pts: Pt[] = [a];
      for (let i = 1; i < n; i++) { const t = a0 + (a1 - a0) * i / n; pts.push([arc.x + arc.r * Math.cos(t), arc.y + arc.r * Math.sin(t)]); }
      pts.push(b); chains.push(pts);
    } else if (kind === "poly") { const pts = ptsOf(g).map(([x, y]) => tf(x, y)); if (pts.length > 2) chains.push(pts.concat([pts[0]])); }
  };
  const id = (x: number, y: number): Pt => [x, y];
  for (const it of doc.items.values()) {
    const n = it.node;
    if (/^gr_(line|rect|circle|arc|poly)$/.test(it.kind) && str((kid(n, "layer") || [])[1]) === "Edge.Cuts") take(it.kind.slice(3), n, id);
    else if (it.kind === "footprint") {
      const [fx, fy, frot] = atOf(n); const R = rotator(frot); const tf = (x: number, y: number): Pt => { const [dx, dy] = R(x, y); return [fx + dx, fy + dy]; };
      for (const g of n) if (isList(g) && /^fp_(line|rect|circle|arc|poly)$/.test(str(g[0])) && str((kid(g, "layer") || [])[1]) === "Edge.Cuts") take(str(g[0]).slice(3), g, tf);
    }
  }
  if (!chains.length) return [];
  const tol = 0.01, same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
  const open = chains.map((c) => c.slice()), loops: Pt[][] = [];
  while (open.length) {
    let cur = open.pop()!; let grew = true;
    while (grew && !(cur.length > 2 && same(cur[0], cur[cur.length - 1]))) {
      grew = false; const tail = cur[cur.length - 1];
      for (let i = 0; i < open.length; i++) {
        const c = open[i]; if (same(c[0], tail)) { cur = cur.concat(c.slice(1)); open.splice(i, 1); grew = true; break; }
        if (same(c[c.length - 1], tail)) { cur = cur.concat(c.slice(0, -1).reverse()); open.splice(i, 1); grew = true; break; }
      }
    }
    // a chain that does not close fails the whole outline (GetBoardPolygonOutlines returns false: nothing is drawn)
    if (!(cur.length > 2 && same(cur[0], cur[cur.length - 1]))) return [];
    loops.push(cur);
  }
  return loops;
}
const spanMatches = (e: SymbolEntry, m: DrillMap): boolean => m.allSpans || spanEq(e.span, m.span);
/** PCB_PAINTER::draw( PCB_DRILL_MAP ) / the plotter: the outline moved by the offset and every hole's mark. */
export function buildDrillMapGeom(doc: Doc, item: Item, n: SNode): void {
  const m = readDrillMap(n, doc); const layer = m.layer; item.layer = layer; item.movable = true; item.x = m.offset[0]; item.y = m.offset[1]; item.rot = 0;
  const cache = drillSymbolCache(doc); const w = Math.max(cache.profile.width, 1e-6); const color = pcbColor(layer), z = pcbZ(layer) + Z_TEXT;
  const [ox, oy] = m.offset;
  for (const loop of boardOutlines(doc)) G(item, { t: "poly", pts: loop.map(([x, y]): Pt => [x + ox, y + oy]), close: true, w, color, layer, z });
  const size = m.size;
  for (const entries of cache.byItem.values()) for (const e of entries) {
    if (!spanMatches(e, m)) continue;
    const x = MM(e.pos[0]) + ox, y = MM(e.pos[1]) + oy;
    if (e.symbol.mode === "shape") drawMarker(item, x, y, size / 2, e.symbol.shape, w, layer);
    else {
      const text = e.symbol.mode === "letter" ? e.symbol.letter : MM(e.diameter).toFixed(2);
      textLines(item, x, y, text, size, color, 0, ["center", "middle"], layer, { z, w, pcb: true, sizeX: size });
    }
    if (m.guideCross) {
      G(item, { t: "line", x1: x - size, y1: y, x2: x + size, y2: y, w, color, layer, z, cap: "round" });
      G(item, { t: "line", x1: x, y1: y - size, x2: x, y2: y + size, w, color, layer, z, cap: "round" });
    }
    if (m.outlineSlots && e.isSlot) {
      let sx = MM(e.sizeXY[0]), sy = MM(e.sizeXY[1]), orient = e.orient;
      if (sx > sy) { const t = sx; sx = sy; sy = t; orient += 90; }
      const half = (sy - sx) / 2; const R = rotator(orient); const [ax, ay] = R(0, -half), [bx, by] = R(0, half);
      // a stroked segment of the slot's width, outline only: two sides and two half circles
      const r = sx / 2, ang = Math.atan2(by - ay, bx - ax), nx = -Math.sin(ang) * r, ny = Math.cos(ang) * r;
      G(item, { t: "line", x1: x + ax + nx, y1: y + ay + ny, x2: x + bx + nx, y2: y + by + ny, w, color, layer, z, cap: "round" });
      G(item, { t: "line", x1: x + ax - nx, y1: y + ay - ny, x2: x + bx - nx, y2: y + by - ny, w, color, layer, z, cap: "round" });
      G(item, { t: "arc", x: x + bx, y: y + by, r, a0: ang - Math.PI / 2, a1: ang + Math.PI / 2, anticlockwise: false, w, color, layer, z });
      G(item, { t: "arc", x: x + ax, y: y + ay, r, a0: ang + Math.PI / 2, a1: ang + 3 * Math.PI / 2, anticlockwise: false, w, color, layer, z });
    }
  }
  if (!item.bbox) bboxAdd(item, ox, oy, size);
}
/** PCB_DRILL_MAP::GetItemDescription / GetMsgPanelInfo. */
export function drillMapMsg(doc: Board, n: SNode): { description: string; rows: [string, string][] } {
  const m = readDrillMap(n, doc); const ln = layerName(doc, m.layer);
  return { description: `Drill Map on ${ln}`, rows: [["Drill Map", ""], ["Layer", ln], ["Spans", m.allSpans ? "All" : "Single"]] };
}
/** The Hole Span property's choices: All spans (−1), then one per span ("%s - %s%s"). */
export function drillMapSpanChoices(doc: Board): { label: string; span: DrillSpan | null }[] {
  return [{ label: "All spans", span: null }, ...enumerateDrillSpans(doc).map((s) => ({ label: `${layerName(doc, spanTop(s))} - ${layerName(doc, spanBottom(s))}${s.backdrill ? " (backdrill)" : ""}`, span: s }))];
}
export const sameSpan = spanEq;

// ---------------------------------------------------------------- generated tables: schemas and header
export type GenKind = "drill_chart" | "stackup_table";
export type Align = "left" | "center" | "right";
export type GenUnits = "mm" | "inch" | "mils";
export interface ColumnDef { id: string; heading: string; align: Align; shown: boolean; label: string }
export const DRILL_CHART_COLUMNS: ColumnDef[] = [
  { id: "symbol", heading: "SYM", align: "center", shown: true, label: "Symbol" },
  { id: "drill_diameter", heading: "DRILL DIA", align: "right", shown: true, label: "Drill diameter" },
  { id: "slot_size", heading: "SLOT W x L", align: "right", shown: true, label: "Slot size" },
  { id: "plating", heading: "PLATED", align: "center", shown: true, label: "Plating" },
  { id: "operation_count", heading: "OPS", align: "right", shown: true, label: "Operation count" },
  { id: "site_count", heading: "SITE COUNT", align: "right", shown: false, label: "Site count" },
  { id: "layer_span", heading: "FROM / TO", align: "center", shown: true, label: "Layer span" },
  { id: "operation", heading: "OPERATION", align: "left", shown: false, label: "Operation" },
  { id: "protection", heading: "PROTECTION", align: "left", shown: false, label: "Protection" },
  { id: "backdrill_stub", heading: "BACKDRILL STUB", align: "right", shown: false, label: "Backdrill stub" },
  { id: "aspect_ratio", heading: "ASPECT RATIO", align: "right", shown: false, label: "Aspect ratio" },
  { id: "description", heading: "DESCRIPTION", align: "left", shown: false, label: "Description" },
];
export const STACKUP_TABLE_COLUMNS: ColumnDef[] = [
  { id: "layer", heading: "Layer Name", align: "left", shown: true, label: "Layer" },
  { id: "type", heading: "Type", align: "left", shown: true, label: "Type" },
  { id: "material", heading: "Material", align: "left", shown: true, label: "Material" },
  { id: "thickness", heading: "Thickness", align: "right", shown: true, label: "Thickness" },
  { id: "color", heading: "Color", align: "left", shown: true, label: "Color" },
  { id: "epsilon_r", heading: "Epsilon R", align: "right", shown: true, label: "Epsilon R" },
  { id: "loss_tangent", heading: "Loss Tangent", align: "right", shown: true, label: "Loss Tan" },
];
export const schemaOf = (k: GenKind): ColumnDef[] => (k === "drill_chart" ? DRILL_CHART_COLUMNS : STACKUP_TABLE_COLUMNS);
export const isGeneratedKind = (k: unknown): k is GenKind => k === "drill_chart" || k === "stackup_table";
export interface GenColumn { id: string; heading: string; align: Align; width: number; visible: boolean }
export interface GenHeader { kind: GenKind; units: GenUnits; precision: number; columns: GenColumn[]; rowKeys: Map<number, string>; filter: ChartFilter; totals: boolean; rowShapes: Map<number, number>; symbolColumn: number }
export const defaultColumn = (k: GenKind, id: string): GenColumn => { const d = schemaOf(k).find((c) => c.id === id)!; return { id, heading: d.heading, align: d.align, width: 0, visible: true }; };
export const defaultColumns = (k: GenKind): GenColumn[] => schemaOf(k).filter((d) => d.shown).map((d) => defaultColumn(k, d.id));
/** GENERATED_TABLE_SCHEMA::Validate: unknown and repeated columns dropped, widths clamped; false without a column or when too wide. */
export function validateColumns(k: GenKind, cols: GenColumn[]): { columns: GenColumn[]; ok: boolean } {
  const seen = new Set<string>(), kept: GenColumn[] = []; let total = 0;
  for (const c of cols) { if (!schemaOf(k).some((d) => d.id === c.id) || seen.has(c.id)) continue; seen.add(c.id); const w = Math.min(Math.max(c.width, 0), 1000); total += w; kept.push({ ...c, width: w }); }
  return { columns: kept, ok: kept.length > 0 && total <= 10000 };
}
export function readGenerated(n: SNode): GenHeader {
  const kind: GenKind = n[0] === "stackup_table" ? "stackup_table" : "drill_chart"; const schema = schemaOf(kind);
  const u = kid(n, "units"); const units = (u && ["mm", "inch", "mils"].includes(str(u[1])) ? str(u[1]) : "mm") as GenUnits;
  const p = kid(n, "precision"); const precision = p ? Math.round(num(p[1], 3)) : 3;
  let columns: GenColumn[] = [];
  for (const c of kids(n, "column")) {
    const id = str((kid(c, "id") || [])[1]); const d = schema.find((x) => x.id === id); const nm = kid(c, "name"), j = kid(c, "justify"), w = kid(c, "width"), h = kid(c, "hide");
    const al = j ? str(j[1]) : ""; columns.push({ id, heading: nm ? str(nm[1]) : d ? d.heading : "", align: (al === "left" || al === "center" || al === "right" ? al : d ? d.align : "left") as Align,
      width: w ? num(w[1], 0) : 0, visible: !(h && str(h[1]) !== "no") });
  }
  columns = validateColumns(kind, columns).columns; if (!columns.length) columns = defaultColumns(kind);
  const rowKeys = new Map<number, string>(); const rk = kid(n, "row_keys"); if (rk) for (const k of kids(rk, "key")) rowKeys.set(Math.round(num(k[1])), str(k[2]));
  const f = kid(n, "filter"), fb = (k: string) => { const c = f ? kid(f, k) : null; return c ? str(c[1]) !== "no" : true; };
  const t = kid(n, "totals"); const rs = kid(n, "row_shapes"); const rowShapes = new Map<number, number>(); let symbolColumn = -1;
  if (rs) { const c = kid(rs, "column"); symbolColumn = c ? Math.round(num(c[1], -1)) : -1; for (const s of kids(rs, "shape")) rowShapes.set(Math.round(num(s[1])), Math.round(num(s[2]))); }
  return { kind, units, precision, columns, rowKeys, filter: { plated: fb("plated"), npth: fb("npth"), vias: fb("vias"), slots: fb("slots"), backdrill: fb("backdrill"), castellated: fb("castellated") },
    totals: t ? str(t[1]) !== "no" : true, rowShapes, symbolColumn };
}
const HEADER_KEYS = new Set(["units", "precision", "column", "row_keys", "filter", "totals", "row_shapes"]);
/** formatGeneratedTable's header (columns, row keys, the chart's extras), in place of the node's old one, after (layer). */
export function writeGenerated(n: SNode, h: GenHeader): void {
  const schema = schemaOf(h.kind); let t = "";
  if (h.units !== "mm") t += `(units ${h.units})`; if (h.precision !== 3) t += `(precision ${h.precision})`;
  for (const c of h.columns) {
    const d = schema.find((x) => x.id === c.id);
    t += `(column (id ${c.id})${!d || c.heading !== d.heading ? `(name ${q(c.heading)})` : ""}${!d || c.align !== d.align ? `(justify ${c.align})` : ""}${c.width > 0 ? `(width ${f6(c.width)})` : ""}${c.visible ? "" : "(hide yes)"})`;
  }
  if (h.rowKeys.size) t += "(row_keys" + [...h.rowKeys.entries()].sort((a, b) => a[0] - b[0]).map(([r, k]) => `(key ${r} ${q(k)})`).join("") + ")";
  if (h.kind === "drill_chart") {
    const f = h.filter; const yn = (b: boolean) => (b ? "yes" : "no");
    if (!(f.plated && f.npth && f.vias && f.slots && f.backdrill && f.castellated)) t += `(filter (plated ${yn(f.plated)})(npth ${yn(f.npth)})(vias ${yn(f.vias)})(slots ${yn(f.slots)})(backdrill ${yn(f.backdrill)})(castellated ${yn(f.castellated)}))`;
    if (!h.totals) t += "(totals no)";
    if (h.symbolColumn >= 0 && h.rowShapes.size) t += `(row_shapes (column ${h.symbolColumn})` + [...h.rowShapes.entries()].sort((a, b) => a[0] - b[0]).map(([r, s]) => `(shape ${r} ${s})`).join("") + ")";
  }
  const parts = (parse(`(x ${t})`) as SNode).slice(1) as SNode[];
  for (let j = n.length - 1; j > 0; j--) { const c = n[j]; if (isList(c) && HEADER_KEYS.has(str(c[0]))) n.splice(j, 1); }
  let at = n.findIndex((c) => isList(c) && c[0] === "layer"); if (at < 0) at = n.findIndex((c) => isList(c) && c[0] === "uuid"); at = at < 0 ? 1 : at + 1;
  n.splice(at, 0, ...parts);
}
/** FormatGeneratedTableLength. */
export function formatLength(nm: number, units: GenUnits, precision: number): string {
  const mm = nm / 1e6;
  if (units === "inch") return (mm / 25.4).toFixed(precision) + "″";
  if (units === "mils") return (mm / 25.4 * 1000).toFixed(precision) + " mil";
  return mm.toFixed(precision) + " mm";
}
/** EDA_UNIT_UTILS::UI::StringFromValue( unityScale, UNSCALED, v ): "%.10f" with the trailing zeros taken off. */
const unscaled = (v: number): string => { let t = v.toFixed(10); if (t.indexOf(".") >= 0) t = t.replace(/0+$/, "").replace(/\.$/, ""); return t === "-0" ? "0" : t; };
/** InitialCaps. */
const initialCaps = (s: string): string => s.split(" ").map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(" ");

// ---------------------------------------------------------------- content (pcb_drill_chart.cpp generate, stackup_table_model.cpp)
interface Content { rows: { key: string; cells: string[] }[]; trailer: string[][]; rowShapes: (number | null)[]; symbolColumn: number }
export interface Refresh { profile: DrillProfile }
const NO_VALUE = "—";
function chartContent(doc: Board, h: GenHeader, visible: GenColumn[], refresh: Refresh | null): Content {
  const p = refresh ? refresh.profile : boardProfile(doc);
  const { groups } = buildChartModel(doc, p, enumerateDrillSpans(doc), h.filter);
  if (refresh) assignDrillSymbols(groups, refresh.profile);
  else { const res = resolveDrillSymbols(doc); for (const g of groups) g.symbol = res.get(g.key) || null; }
  const c: Content = { rows: [], trailer: [], rowShapes: [], symbolColumn: -1 };
  visible.forEach((col, i) => { if (col.id === "symbol") c.symbolColumn = i; });
  const L = (nm: number) => formatLength(nm, h.units, h.precision);
  for (const g of groups) {
    const sym = g.symbol; c.rowShapes.push(sym && sym.mode === "shape" ? sym.shape : null);
    c.rows.push({ key: g.key, cells: visible.map((col) => {
      switch (col.id) {
      case "symbol": return !sym ? "" : sym.mode === "letter" ? sym.letter : sym.mode === "size_text" ? L(g.diameter) : "";
      case "drill_diameter": return L(g.diameter);
      case "slot_size": return g.isSlot ? `${L(g.sizeXY[0])} x ${L(g.sizeXY[1])}` : NO_VALUE;
      case "plating": return g.notPlated ? "No" : "Yes";
      case "operation_count": return String(g.ops);
      case "site_count": return String(g.sites.length);
      case "layer_span": return `${layerName(doc, g.top)} / ${layerName(doc, g.bottom)}`;
      case "operation": return g.kind !== 0 ? "Backdrill" : g.isSlot ? "Slot" : "Drill";
      case "protection": {
        const parts: string[] = []; if (g.filled) parts.push("filled"); if (g.capped) parts.push("capped"); if (g.topPlugged || g.bottomPlugged) parts.push("plugged");
        if (g.topCovered || g.bottomCovered) parts.push("covered"); if (g.topTented || g.bottomTented) parts.push("tented");
        return parts.length ? parts.join(",") : NO_VALUE;
      }
      case "backdrill_stub": return g.stub !== null ? L(g.stub) : NO_VALUE;
      case "aspect_ratio": { const depth = NM(stackupLayerDistance(doc as Doc, g.top, g.bottom)); return depth > 0 && g.diameter > 0 ? (depth / g.diameter).toFixed(1) + ":1" : NO_VALUE; }
      case "description": return sym ? sym.descr : "";
      default: return "";
      }
    }) });
  }
  if (h.totals) {
    let ops = 0; const sites = new Set<string>(); for (const g of groups) { ops += g.ops; for (const s of g.sites) sites.add(s[0] + "," + s[1]); }
    c.trailer.push([`${ops} OPS / ${sites.size} SITES`]);
  }
  return c;
}
function stackupContent(doc: Board, h: GenHeader, visible: GenColumn[]): Content {
  const c: Content = { rows: [], trailer: [], rowShapes: [], symbolColumn: -1 };
  let above = "";
  for (const it of boardStackup(doc)) {
    if (it.kind === "copper") above = it.layer!;
    it.subs.forEach((s, si) => {
      const key = it.kind === "dielectric" ? `D:${above}:${si}` : `L:${it.layer}`;
      const name = it.kind === "dielectric" ? (it.subs.length < 2 ? `Dielectric ${it.dielIndex}` : `Dielectric ${it.dielIndex} (${si + 1}/${it.subs.length})`) : layerName(doc, it.layer!);
      const editable = it.kind === "copper" || it.kind === "dielectric" || it.kind === "soldermask";
      c.rows.push({ key, cells: visible.map((col) => {
        switch (col.id) {
        case "layer": return name;
        case "type": return initialCaps(it.typeName);
        case "material": return s.material;
        case "thickness": return editable ? formatLength(NM(s.thickness), h.units, h.precision) : NOT_SPECIFIED;
        case "color": return s.color;
        case "epsilon_r": return unscaled(s.epsilonR);
        case "loss_tangent": return unscaled(s.lossTangent);
        default: return "";
        }
      }) });
      c.rowShapes.push(null);
    });
  }
  return c;
}
const contentOf = (doc: Board, h: GenHeader, refresh: Refresh | null): Content => {
  const visible = h.columns.filter((c) => c.visible);
  return h.kind === "drill_chart" ? chartContent(doc, h, visible, refresh) : stackupContent(doc, h, visible);
};

// ---------------------------------------------------------------- cells
const TEXTBOX_MARGIN = 1.0025;
const cellUuid = (c: SNode): string => uuidOf(c);
let uuidSource: () => string = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => { const r = Math.random() * 16 | 0; return (ch === "x" ? r : (r & 3) | 8).toString(16); });
/** The uuid maker new cells take (the editor's newUuid). */
export function setUuidSource(f: () => string): void { uuidSource = f; }
/** A new PCB_TABLECELL on the table's layer: KiCad's text defaults, left / centred, mirrored on a back layer. */
function newCell(layer: string): SNode {
  const just: SNode = ["justify", "left"]; if (isBackLayer(layer)) just.push("mirror");
  return ["table_cell", "", ["start", 0, 0], ["end", 0, 0], ["margins", TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN], ["span", 1, 1],
    ["layer", layer], ["uuid", uuidSource()], ["effects", ["font", ["size", 1.27, 1.27]], just], ["knockout", "no"]];
}
function replaceKid(cell: SNode, key: string, value: SNode | null, before: string[]): void {
  const i = cell.findIndex((c, j) => j > 0 && isList(c) && c[0] === key);
  if (i > 0) { if (value) cell[i] = value; else cell.splice(i, 1); return; }
  if (!value) return;
  let at = cell.length; for (const b of before) { const j = cell.findIndex((c, k) => k > 0 && isList(c) && c[0] === b); if (j > 0) { at = j; break; } }
  cell.splice(at, 0, value);
}
/** copyCellStyle: the donor's text attributes, knockout and margins. */
function copyCellStyle(cell: SNode, donor: SNode): void {
  const d = (k: string) => { const c = kid(donor, k); return c ? cloneNode(c) : null; };
  replaceKid(cell, "effects", d("effects"), ["knockout"]);
  replaceKid(cell, "angle", d("angle"), ["layer"]);
  replaceKid(cell, "margins", d("margins"), ["span", "layer"]);
  replaceKid(cell, "knockout", d("knockout") || ["knockout", "no"], []);
}
/** PCB_STACKUP_TABLE::styleNewCell: 1.5 mm text, 0.3 mm strokes in the heading and 0.2 mm below. */
function styleNewCell(kind: GenKind, cell: SNode, heading: boolean): void {
  if (kind !== "stackup_table") return;
  let e = kid(cell, "effects"); if (!e) { e = ["effects"]; replaceKid(cell, "effects", e, ["knockout"]); }
  let f = kid(e, "font"); if (!f) { f = ["font"]; e.splice(1, 0, f); }
  replaceKid(f, "size", ["size", 1.5, 1.5], []); replaceKid(f, "thickness", ["thickness", heading ? 0.3 : 0.2], ["bold", "italic"]);
}
function setHJust(cell: SNode, align: Align): void {
  let e = kid(cell, "effects"); if (!e) { e = ["effects", ["font", ["size", 1.27, 1.27]]]; replaceKid(cell, "effects", e, ["knockout"]); }
  const j = kid(e, "justify"); const rest = j ? j.slice(1).filter((t) => t !== "left" && t !== "right") : [];
  const toks = (align === "center" ? [] as string[] : [align as string]).concat(rest as string[]);
  if (j) { if (toks.length) j.splice(1, j.length - 1, ...toks); else e.splice(e.indexOf(j), 1); } else if (toks.length) e.push(["justify", ...toks]);
}
const marginsOf = (c: SNode): [number, number, number, number] => { const m = kid(c, "margins"); return m ? [num(m[1]), num(m[2]), num(m[3]), num(m[4])] : [TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN, TEXTBOX_MARGIN]; };
function justOfCell(c: SNode): { h: string; v: string } { const ef = effectsOf(c); return { h: ef.just.includes("left") ? "left" : ef.just.includes("right") ? "right" : "center", v: ef.just.includes("top") ? "top" : ef.just.includes("bottom") ? "bottom" : "center" }; }
const penOf = (c: SNode): number => { const ef = effectsOf(c); return layoutPen(ef, ef.size); };
/** The cell's shown text as GetShownText gives it: wrapped to the cell's inner width (FONT::LinebreakText). */
function shownText(c: SNode, width: number): string {
  const ef = effectsOf(c); const [ml, , mr] = marginsOf(c);
  return linebreakText(unescapeText(str(c[1])), width - ml - mr, ef.sizeX, penOf(c), ef.italic);
}
/** The glyphs' box (TransformTextToPolySet, rotated back into the text's frame) about the draw anchor; null without glyphs. */
function glyphBox(c: SNode, text: string): [number, number, number, number] | null {
  if (!text) return null;
  const ef = effectsOf(c); const sy = ef.size, sx = ef.sizeX > 0 ? ef.sizeX : sy, pen = penOf(c); const { h, v } = justOfCell(c);
  const lines = text.split("\n"); const offs = lineOffsets(lines.length, v); const pitch = sy * TEXT_INTERLINE * (ef.lineSpacing || 1);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  lines.forEach((ln, i) => {
    if (!ln) return; const L = strokeLine(ln, ef.italic); const o = strokeOrigin(L.advance, h, v, pen / sx, pen / sy); const dy = offs[i] * pitch;
    for (const st of L.strokes) for (let k = 0; k + 1 < st.length; k += 2) {
      const x = sx * (st[k] + o[0]), y = sy * (st[k + 1] + o[1]) + dy;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  });
  if (!isFinite(x0)) return null;
  return [x0 - pen / 2, y0 - pen / 2, x1 + pen / 2, y1 + pen / 2];
}

// ---------------------------------------------------------------- RebuildCells
const at0 = (a: number[], i: number): number => (i >= 0 && i < a.length && isFinite(a[i]) ? a[i] : 0);
function isDataRow(h: GenHeader, rows: number, row: number, laidOutTotals?: boolean): boolean {
  if (h.rowKeys.size) return h.rowKeys.has(row);
  const last = rows - 1 - (h.kind === "drill_chart" && (laidOutTotals ?? h.totals) ? 1 : 0);
  return row >= 1 && row <= last;
}
/** Writes widths and heights into the node and lays the cells out (PCB_TABLE::Normalize). */
function normalize(n: SNode, cols: number, rows: number, widths: number[], heights: number[]): void {
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  const cw = ["column_widths", ...Array.from({ length: cols }, (_, i) => r(at0(widths, i)))], rh = ["row_heights", ...Array.from({ length: rows }, (_, i) => r(at0(heights, i)))];
  const ci = n.findIndex((c) => isList(c) && c[0] === "column_widths"); if (ci > 0) n[ci] = cw;
  const ri = n.findIndex((c) => isList(c) && c[0] === "row_heights"); if (ri > 0) n[ri] = rh;
  normalizeTable(n, true);
}
/**
 * PCB_GENERATED_TABLE::RebuildCells on a copy of the node: the content regenerated, rows carried by key (their cells,
 * formatting and heights), new cells styled from their column, columns widened to the text, autosized, the authored
 * minimum widths applied, and the table put back where it was.  `laidOutTotals` is the chart's m_laidOutShowTotals.
 */
export function rebuildGenerated(doc: Board, node: SNode, refresh: Refresh | null, laidOutTotals?: boolean): SNode {
  const n = cloneNode(node); const h = readGenerated(n); const layer = str((kid(n, "layer") || [])[1]) || "Dwgs.User";
  const visible = h.columns.filter((c) => c.visible); const content = contentOf(doc, h, refresh);
  const cols = visible.length, dataRows = content.rows.length, rows = 1 + dataRows + content.trailer.length;
  const T = tableInfo(n); const hasData = !!kid(n, "column_count");
  const oldCols = hasData ? T.cols : 0; let cells: SNode[] = hasData ? T.cells.slice() : [];
  const anchor: Pt = cells.length ? tablePosition(n, true) : [0, 0];
  const existing = new Set(cells.map(cellUuid));
  let heights = new Map<number, number>(); T.heights.forEach((v, i) => heights.set(i, v)); if (!hasData) heights = new Map();
  const widths = hasData ? T.widths.slice(0, cols) : [];
  const newKeys: string[] = Array(rows).fill(""); for (let i = 0; i < dataRows; i++) newKeys[1 + i] = content.rows[i].key;
  // migrateRows
  if (oldCols > 0 && cols > 0 && cells.length) {
    const oldRows = Math.floor(cells.length / oldCols); const positional = h.rowKeys.size === 0;
    const byKey = new Map<string, number>(); let oldFirst = oldRows, oldLast = -1; let go = true;
    if (positional) { oldFirst = 1; oldLast = 0; for (let r = 1; r < oldRows; r++) if (isDataRow(h, oldRows, r, laidOutTotals)) oldLast = r; }
    else { for (const [r, k] of h.rowKeys) { if (r < 0 || r >= oldRows) continue; byKey.set(k, r); oldFirst = Math.min(oldFirst, r); oldLast = Math.max(oldLast, r); } if (!byKey.size) go = false; }
    if (go) {
      const newData = newKeys.filter((k) => k).length; const src: number[] = Array(rows).fill(-1);
      if (oldFirst - 1 >= 0) src[0] = oldFirst - 1;
      if (positional) { const cnt = Math.min(newData, oldLast - oldFirst + 1); for (let i = 0; i < cnt; i++) src[1 + i] = oldFirst + i; }
      else for (let i = 1; i < rows; i++) { if (!newKeys[i]) continue; const r = byKey.get(newKeys[i]); if (r !== undefined) src[i] = r; }
      const trailStart = 1 + newData; for (let i = trailStart; i < rows; i++) { const r = oldLast + 1 + (i - trailStart); if (r < oldRows) src[i] = r; }
      const next: (SNode | null)[] = Array(rows * cols).fill(null); const nh = new Map<number, number>();
      for (let i = 0; i < rows; i++) {
        if (src[i] < 0) continue;
        for (let c = 0; c < Math.min(oldCols, cols); c++) next[i * cols + c] = cells[src[i] * oldCols + c];
        if (heights.has(src[i])) nh.set(i, heights.get(src[i])!);
      }
      cells = next.map((c) => c || newCell(layer)); heights = nh;
    }
  }
  // ResizeCells
  while (cells.length > rows * cols) cells.pop();
  while (cells.length < rows * cols) cells.push(newCell(layer));
  h.rowKeys = new Map(); newKeys.forEach((k, i) => { if (k) h.rowKeys.set(i, k); });
  const cellAt = (r: number, c: number) => cells[r * cols + c];
  const setCell = (r: number, c: number, text: string) => {
    const cell = cellAt(r, c); if (!cell) return;
    if (!existing.has(cellUuid(cell))) {
      let donor: SNode | null = null;
      if (r > 0) for (let d = 1; d < rows && !donor; d++) for (const rr of [r - d, r + d]) {
        if (rr < 1 || rr >= rows || !isDataRow(h, rows, rr)) continue; const dc = cellAt(rr, c); if (dc && existing.has(cellUuid(dc))) { donor = dc; break; }
      }
      if (donor) copyCellStyle(cell, donor); else styleNewCell(h.kind, cell, r === 0);
    }
    cell[1] = text; setHJust(cell, visible[c].align);
  };
  visible.forEach((col, c) => setCell(0, c, col.heading));
  content.rows.forEach((row, i) => visible.forEach((_, c) => setCell(1 + i, c, row.cells[c] || "")));
  content.trailer.forEach((tr, i) => visible.forEach((_, c) => setCell(1 + dataRows + i, c, tr[c] || "")));
  // the table data: column count, sizes and cells
  for (let j = n.length - 1; j > 0; j--) { const c = n[j]; if (isList(c) && (c[0] === "column_count" || c[0] === "column_widths" || c[0] === "row_heights" || c[0] === "cells")) n.splice(j, 1); }
  if (!kid(n, "border")) n.push(["border", ["external", "yes"], ["header", "yes"], ["stroke", ["width", 0.1], ["type", "default"]]]);
  if (!kid(n, "separators")) n.push(["separators", ["rows", "yes"], ["cols", "yes"], ["stroke", ["width", 0.1], ["type", "default"]]]);
  const bi = n.findIndex((c) => isList(c) && c[0] === "border");
  n.splice(bi, 0, ["column_count", cols]);
  const si = n.findIndex((c) => isList(c) && c[0] === "separators");
  n.splice(si + 1, 0, ["column_widths"], ["row_heights"], ["cells", ...cells]);
  const H: number[] = Array.from({ length: rows }, (_, i) => heights.get(i) || 0);
  const W: number[] = Array.from({ length: cols }, (_, i) => at0(widths, i));
  // pre-widen to the unwrapped text
  let pre = false;
  for (let c = 0; c < cols; c++) {
    let w = 0;
    for (let r = 0; r < rows; r++) {
      const cell = cellAt(r, c); const ef = effectsOf(cell); const pen = penOf(cell); const [ml, , mr] = marginsOf(cell);
      let ext = 0; for (const ln of unescapeText(str(cell[1])).split("\n")) ext = Math.max(ext, textWidth(ln, ef.sizeX, pen));
      w = Math.max(w, ext + pen + 2 * (ml + mr));
    }
    if (w > W[c]) { W[c] = w; pre = true; }
  }
  if (pre) normalize(n, cols, rows, W, H);
  // Autosize
  normalize(n, cols, rows, W, H);
  const boxes = cells.map((cell, i) => glyphBox(cell, shownText(cell, W[i % cols])));
  for (let c = 0; c < cols; c++) { let w = 0; for (let r = 0; r < rows; r++) { const cell = cellAt(r, c), b = boxes[r * cols + c]; const [ml, , mr] = marginsOf(cell); w = Math.max(w, (b ? b[2] - b[0] : 0) + (ml + mr) * 1.5); } W[c] = w; }
  const needed = Array.from({ length: rows }, (_, r) => { let hh = 0; for (let c = 0; c < cols; c++) { const cell = cellAt(r, c), b = boxes[r * cols + c]; const m = marginsOf(cell); hh = Math.max(hh, (b ? b[3] - b[1] : 0) + m[1] + m[3]); } return hh; });
  // setAutosizedRowHeights
  normalize(n, cols, rows, W, H);
  const metric = (r: number) => { let hh = 0; for (let c = 0; c < cols; c++) { const cell = cellAt(r, c); const ef = effectsOf(cell); const m = marginsOf(cell); const lines = shownText(cell, W[c]).split("\n").length; hh = Math.max(hh, lines * ef.size * TEXT_INTERLINE * (ef.lineSpacing || 1) + penOf(cell) + m[1] + m[3]); } return hh; };
  const minRow = (r: number) => {
    let hh = 0;
    for (let c = 0; c < cols; c++) {
      const cell = cellAt(r, c); const b = glyphBox(cell, shownText(cell, W[c])); if (!b) continue; const above = -b[1], below = b[3]; const m = marginsOf(cell); const { v } = justOfCell(cell);
      hh = Math.max(hh, v === "top" ? m[1] + below : v === "bottom" ? m[3] + above : 2 * Math.max(above, below));
    }
    return hh;
  };
  const held = H.map((v) => Math.max(v, 0)); const fit = held.map((_, r) => (isDataRow(h, rows, r) ? Math.max(needed[r], metric(r)) : needed[r]));
  let maxNeed = 0; const counts = new Map<number, number>();
  for (let r = 1; r < rows; r++) { if (!isDataRow(h, rows, r)) continue; maxNeed = Math.max(maxNeed, fit[r]); if (held[r] > 0) { const k = Math.round(held[r] * 1e6); counts.set(k, (counts.get(k) || 0) + 1); } }
  let common = maxNeed, commonCount = 0; for (const [k, cnt] of [...counts.entries()].sort((a, b) => a[0] - b[0])) if (cnt >= commonCount) { common = k / 1e6; commonCount = cnt; }
  for (let r = 0; r < rows; r++) { const hh = isDataRow(h, rows, r) && held[r] === 0 ? common : held[r]; H[r] = hh > 0 && hh >= minRow(r) - 1e-9 ? hh : fit[r]; }
  normalize(n, cols, rows, W, H);
  // the authored minimum widths
  let widened = false; visible.forEach((col, c) => { if (col.width > W[c]) { W[c] = col.width; widened = true; } });
  if (widened) normalize(n, cols, rows, W, H);
  setTablePosition(n, true, anchor);
  // onRebuilt
  h.rowShapes = new Map(); content.rowShapes.forEach((s, i) => { if (s !== null) h.rowShapes.set(1 + i, s); });
  h.symbolColumn = content.symbolColumn;
  writeGenerated(n, h);
  return n;
}
/** PCB_TABLE::Autosize for an ordinary table: columns as wide as their widest text, rows as tall as theirs need. */
export function autosizeTable(n: SNode): void {
  const T = tableInfo(n); const cols = T.cols, rows = T.rows; if (!T.cells.length) return;
  const W = Array.from({ length: cols }, (_, i) => at0(T.widths, i)), H = Array.from({ length: rows }, (_, i) => at0(T.heights, i));
  if (!kid(n, "column_widths")) n.push(["column_widths"]); if (!kid(n, "row_heights")) n.push(["row_heights"]);
  const cn = n.findIndex((c) => isList(c) && c[0] === "cells"), cw = n.findIndex((c) => isList(c) && c[0] === "column_widths"), rh = n.findIndex((c) => isList(c) && c[0] === "row_heights");
  if (cn > 0 && (cw > cn || rh > cn)) { const cells = n.splice(cn, 1)[0]; n.push(cells); }
  normalize(n, cols, rows, W, H);
  const boxes = T.cells.map((cell) => { const { s, e } = cellStartEnd(cell, true); return glyphBox(cell, shownText(cell, Math.abs(e[0] - s[0]))); });
  for (let c = 0; c < cols; c++) { let w = 0; for (let r = 0; r < rows; r++) { const cell = T.cells[r * cols + c], b = boxes[r * cols + c]; if (!cell) continue; const [ml, , mr] = marginsOf(cell); w = Math.max(w, Math.trunc((b ? b[2] - b[0] : 0) * 1e6 + (ml + mr) * 1.5 * 1e6) / 1e6); } W[c] = w; }
  for (let r = 0; r < rows; r++) { let hh = 0; for (let c = 0; c < cols; c++) { const cell = T.cells[r * cols + c], b = boxes[r * cols + c]; if (!cell) continue; const m = marginsOf(cell); hh = Math.max(hh, (b ? b[3] - b[1] : 0) + m[1] + m[3]); } H[r] = hh; }
  normalize(n, cols, rows, W, H);
}
/** IsStale, by content: the column and row counts, headings, row keys, every cell's text, and the chart's shapes. */
export function generatedStale(doc: Board, node: SNode): boolean {
  const h = readGenerated(node); const visible = h.columns.filter((c) => c.visible); const content = contentOf(doc, h, null);
  if (!kid(node, "column_count")) return true;
  const T = tableInfo(node); const cols = visible.length, rows = 1 + content.rows.length + content.trailer.length;
  if (T.cols !== cols || T.rows !== rows) return true;
  const differs = (r: number, c: number, t: string) => { const cell = T.cells[r * cols + c]; return !cell || str(cell[1]) !== t; };
  for (let c = 0; c < cols; c++) if (differs(0, c, visible[c].heading)) return true;
  for (let i = 0; i < content.rows.length; i++) {
    if (h.rowKeys.get(1 + i) !== content.rows[i].key) return true;
    for (let c = 0; c < cols; c++) if (differs(1 + i, c, content.rows[i].cells[c] || "")) return true;
  }
  for (let i = 0; i < content.trailer.length; i++) for (let c = 0; c < cols; c++) if (differs(1 + content.rows.length + i, c, content.trailer[i][c] || "")) return true;
  if (h.kind === "drill_chart") {
    if (h.symbolColumn !== content.symbolColumn && content.rowShapes.some((s) => s !== null)) return true;
    const want = new Map<number, number>(); content.rowShapes.forEach((s, i) => { if (s !== null) want.set(1 + i, s); });
    if (want.size !== h.rowShapes.size || [...want].some(([r, s]) => h.rowShapes.get(r) !== s)) return true;
  }
  return false;
}
/**
 * RefreshGeneratedTables: every stale table rebuilt with one refresh, the pending drill symbol profile (the
 * assignments the rebuild handed out) returned for the board's setup when it changed.
 */
export function refreshGeneratedTables(doc: Board): { tables: { id: string; node: SNode }[]; profile: DrillProfile | null } {
  const before = boardProfile(doc); const refresh: Refresh = { profile: cloneProfile(before) }; const tables: { id: string; node: SNode }[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "table" || !isGeneratedKind(it.node[0]) || !generatedStale(doc, it.node)) continue;
    tables.push({ id: it.id, node: rebuildGenerated(doc, it.node, refresh) });
  }
  if (!tables.length) return { tables, profile: null };
  return { tables, profile: JSON.stringify(refresh.profile) !== JSON.stringify(before) ? refresh.profile : null };
}
/** A new PCB_DRILL_CHART / PCB_STACKUP_TABLE (no cells yet: RebuildCells lays it out). */
export function newGeneratedNode(kind: GenKind, layer: string, uuid: string, units: GenUnits = "mm"): SNode {
  const n: SNode = [kind, ["uuid", uuid], ["layer", layer]];
  writeGenerated(n, { kind, units: kind === "stackup_table" ? units : "mm", precision: 3, columns: defaultColumns(kind), rowKeys: new Map(), filter: { ...FILTER_ALL }, totals: true, rowShapes: new Map(), symbolColumn: -1 });
  return n;
}
/**
 * SetColumns: the shown cells follow their column by id; a column new to the table gets cells styled from the nearest
 * carried cell of the row (styleCreatedCells), else as a new cell.  The header takes the new column list.
 */
export function setGeneratedColumns(node: SNode, columns: GenColumn[]): SNode {
  const n = cloneNode(node); const h = readGenerated(n); const oldVis = h.columns.filter((c) => c.visible); const vis = columns.filter((c) => c.visible);
  const T = tableInfo(n); const layer = str((kid(n, "layer") || [])[1]) || "Dwgs.User";
  if (kid(n, "column_count") && T.cols > 0 && vis.length > 0 && T.cols === oldVis.length && T.cells.length) {
    const rows = Math.floor(T.cells.length / T.cols), nc = vis.length; const cells: (SNode | null)[] = Array(rows * nc).fill(null); const moved: boolean[] = Array(rows * nc).fill(false); const widths: number[] = Array(nc).fill(0);
    vis.forEach((col, c) => {
      const from = oldVis.findIndex((o) => o.id === col.id); if (from < 0) return;
      for (let r = 0; r < rows; r++) { cells[r * nc + c] = T.cells[r * T.cols + from]; moved[r * nc + c] = true; }
      widths[c] = at0(T.widths, from);
    });
    for (let i = 0; i < cells.length; i++) {
      if (moved[i]) continue; const r = Math.floor(i / nc), c = i % nc; const cell = newCell(layer); let donor: SNode | null = null;
      for (let d = 1; d < nc && !donor; d++) for (const p of [c - d, c + d]) if (p >= 0 && p < nc && moved[r * nc + p]) { donor = cells[r * nc + p]; break; }
      const first = T.cells[r * T.cols]; if (first) { const a = kid(first, "angle"); if (a) replaceKid(cell, "angle", cloneNode(a), ["layer"]); }
      if (donor) copyCellStyle(cell, donor); else if (h.kind === "stackup_table") styleNewCell(h.kind, cell, r === 0);
      cells[i] = cell;
    }
    const cc = kid(n, "column_count")!; cc[1] = nc;
    const ci = n.findIndex((c) => isList(c) && c[0] === "column_widths"); if (ci > 0) n[ci] = ["column_widths", ...widths];
    const cn = kid(n, "cells")!; cn.splice(1, cn.length - 1, ...(cells as SNode[]));
  }
  h.columns = columns.map((c) => ({ ...c })); writeGenerated(n, h);
  return n;
}
/**
 * PCB_GENERATED_TABLE::Flip: the cells flip with the table, the columns reverse (hidden ones keep their mirrored
 * places), trailer rows swap their texts end for end, and the chart's symbol column follows.
 */
export function flipGeneratedHeader(n: SNode): void {
  const h = readGenerated(n); h.columns.reverse();
  const vis = h.columns.filter((c) => c.visible).length;
  if (h.symbolColumn >= 0) h.symbolColumn = vis - 1 - h.symbolColumn;
  const T = tableInfo(n); const cols = T.cols;
  for (let r = 1; r < T.rows; r++) {
    if (isDataRow(h, T.rows, r)) continue;
    for (let c = 0; c < Math.floor(cols / 2); c++) { const a = T.cells[r * cols + c], b = T.cells[r * cols + cols - 1 - c]; if (!a || !b) continue; const t = a[1]; a[1] = b[1]; b[1] = t; }
  }
  writeGenerated(n, h);
}
/** PCB_PAINTER::draw( PCB_DRILL_CHART ): a shape mark in the symbol cell of each row that has one. */
export function drillChartSymbols(doc: Doc, item: Item, n: SNode): void {
  const h = readGenerated(n); if (h.symbolColumn < 0 || !h.rowShapes.size) return;
  const T = tableInfo(n); const layer = str((kid(n, "layer") || [])[1]) || "Dwgs.User"; const p = boardProfile(doc);
  for (const [row, shape] of h.rowShapes) {
    const cell = T.cells[row * T.cols + h.symbolColumn]; if (!cell) continue;
    const { s, e } = cellStartEnd(cell, true); const w = Math.abs(e[0] - s[0]), hh = Math.abs(e[1] - s[1]);
    const r = Math.min(p.size / 2, Math.min(w, hh) / 3);
    drawMarker(item, (s[0] + e[0]) / 2, (s[1] + e[1]) / 2, r, shape, p.width, layer);
  }
}
/** PCB_GENERATED_TABLE::GetMsgPanelInfo / GetItemDescription. */
export function generatedMsg(doc: Board, n: SNode): { description: string; rows: [string, string][] } {
  const T = tableInfo(n); const name = n[0] === "drill_chart" ? "Drill Chart" : "Stackup Table";
  return { description: `${name} (${T.rows} rows)`, rows: [[name, ""], ["Rows", String(T.rows)], ["Layer", layerName(doc, str((kid(n, "layer") || [])[1]))]] };
}
export const hasDrillMapOn = (doc: Board, layer: string): boolean => { for (const it of doc.items.values()) if (it.kind === "drill_map" && str((kid(it.node, "layer") || [])[1]) === layer) return true; return false; };
export const isDrillMapNode = (n: SNode): boolean => n[0] === "drill_map";
/** The BOARD_SETUP change that stores a drill symbol profile (DRILL_PROFILE_PENDING::Commit, PANEL / dialog edits). */
export function profileChange(doc: Board, p: DrillProfile): KChange {
  return boardSetupChange({ setup: sectionText(editSetup(doc.setupNode || null, { drillProfile: p })) });
}
/** BOARD_STACKUP::BuildBoardThicknessFromStackup: the copper, dielectric and solder mask thicknesses (mm). */
export function stackupBoardThickness(doc: Board): number {
  let t = 0; for (const it of boardStackup(doc)) if (it.kind === "copper" || it.kind === "dielectric" || it.kind === "soldermask") for (const s of it.subs) t += NM(s.thickness);
  return t / 1e6;
}
export { boardFinish };
