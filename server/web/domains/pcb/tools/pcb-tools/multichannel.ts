// pcb-tools/multichannel.ts — MULTICHANNEL_TOOL (pcbnew/tools/multichannel_tool.cpp) without its dialogs: placement
// rule areas (Generate Placement Rule Areas), the Repeat Layout session from a rule area or from plain selected parts
// (discovery of the channels that repeat them, loose matching, the anchor, linking), Update Linked Layouts, Unlink
// Layout, Expand Selection by One Step / to Largest Matching Topology, and PCB_CONTROL::ApplyDesignBlockLayout's
// repeat of a design block's board onto its linked groups.  The footprints of two channels are paired by TMATCH
// (topo-match.ts).  Every edit is staged on a Stage (BOARD_COMMIT) that never touches the document: its changes()
// are committed by the caller as one undo step, or dropped (the preview's Revert).  Nets are keyed by name.
import type { BoardDoc, PcbChange, Pt } from "./types";
import { K } from "./state";
import { clone, isList, r6, rotator } from "./util";
import { upsertChange, typeNameOf } from "./changes";
import { rotateNode, translateNode, flipNode } from "./transforms";
import { rotateFootprintNode } from "./footprint";
import { netName as netNameOf, itemShape, shapeInsidePoly } from "./dru-eval";
import { netNode } from "./nets";
import { zoneLayers } from "./nodes";
import { convexHull } from "./teardrop";
import { ratsnest as ratsnestOf } from "./netlist";
import { strNumCmp } from "../../sim/netlist-kicad";
import { ConnectionGraph, commonPathTailLength, type ComponentMatches, type MismatchReason, type TmFootprint } from "./topo-match";

export type SourceType = "sheetname" | "component_class" | "group" | "design_block";
/** REPEAT_LAYOUT_OPTIONS (zone_settings.h); anchor is a footprint uuid, "" for the area centre. */
export interface RepeatOptions { copyRouting: boolean; connectedRoutingOnly: boolean; copyPlacement: boolean; copyOtherItems: boolean; groupItems: boolean; includeLockedItems: boolean; anchor: string }
export const DEFAULT_REPEAT_OPTIONS: RepeatOptions = { copyRouting: true, connectedRoutingOnly: false, copyPlacement: true, copyOtherItems: true, groupItems: false, includeLockedItems: true, anchor: "" };

/** One side of a repeat: the board, or a design block's board parsed on its own (Apply Design Block Layout). */
interface Side { doc: BoardDoc; key(name: string): string }
/** RULE_AREA */
export interface RuleArea {
  sourceType: SourceType; fromSelection: boolean;
  /** the area's zone node: the board's own, or a scratch one not on the board */
  zone: SNode | null; zoneId: string | null;
  components: KItem[]; designBlockItems: KItem[];
  /** the group of a group-placement area or of a discovered channel (on the board, or a scratch node) */
  group: SNode | null; groupId: string | null;
  generateEnabled: boolean; sheetPath: string; sheetName: string; ruleName: string; componentClass: string; groupName: string; center: Pt;
  side: Side;
}
/** RULE_AREA_COMPAT_DATA */
export interface CompatData {
  isOk: boolean; doCopy: boolean; errorMsg: string; matching: Map<KItem, KItem>; mismatchReasons: string[];
  affected: Set<string>; groupable: Set<string>; discovered: Map<KItem, KItem>; unmatched: KItem[]; searchLimit: boolean;
}
const newCompat = (): CompatData => ({ isOk: false, doCopy: false, errorMsg: "", matching: new Map(), mismatchReasons: [], affected: new Set(), groupable: new Set(), discovered: new Map(), unmatched: [], searchLimit: false });

// ---------------------------------------------------------------- node helpers
const kidStr = (n: SNode, k: string): string => { const c = K.kid(n, k); return c && c.length > 1 ? K.str(c[1]) : ""; };
const prop = (n: SNode, name: string): string => { const p = K.kids(n, "property").find((c) => K.str(c[1]) === name); return p ? K.str(p[2]) : ""; };
const fpRef = (n: SNode): string => prop(n, "Reference") || (K.kids(n, "fp_text").find((t) => K.str(t[1]) === "reference") ? K.str(K.kids(n, "fp_text").find((t) => K.str(t[1]) === "reference")![2]) : "");
const fpValue = (n: SNode): string => prop(n, "Value");
const fpid = (n: SNode): string => K.str(n[1]);
const fpPath = (n: SNode): string[] => kidStr(n, "path").split("/").filter(Boolean);
const fpSheetname = (n: SNode): string => kidStr(n, "sheetname") || prop(n, "Sheetname");
const fpSheetfile = (n: SNode): string => kidStr(n, "sheetfile") || prop(n, "Sheetfile");
const fpClasses = (n: SNode): string[] => { const cc = K.kid(n, "component_classes"); return cc ? K.kids(cc, "class").map((c) => K.str(c[1])) : []; };
const uuidOf = (n: SNode): string => kidStr(n, "uuid") || kidStr(n, "tstamp") || kidStr(n, "id");
const isLockedNode = (n: SNode): boolean => { const l = K.kid(n, "locked"); return l ? K.str(l[1]) !== "no" : n.includes("locked"); };
const membersOf = (n: SNode): string[] => { const m = K.kid(n, "members"); return m ? m.slice(1).map(K.str) : []; };
const isGroupish = (k: string): boolean => k === "group" || k === "generated";
const footprints = (doc: BoardDoc): KItem[] => [...doc.items.values()].filter((it) => it.kind === "footprint");
const groups = (doc: BoardDoc): KItem[] => [...doc.items.values()].filter((it) => it.kind === "group");
const TRACKS = new Set(["segment", "arc", "via"]);
const DRAWING = (k: string): boolean => !TRACKS.has(k) && k !== "footprint" && k !== "zone" && k !== "group" && k !== "generated";
const isCopper = (l: string): boolean => /\.Cu$/.test(l);
/** BOARD_ITEM::GetLayer: a via's first layer, a footprint's side, an item's (layer). */
function itemLayer(n: SNode): string { const l = K.kid(n, "layer"); if (l) return K.str(l[1]); const ls = K.kid(n, "layers"); return ls && ls.length > 1 ? K.str(ls[1]) : ""; }
function itemLayers(doc: BoardDoc, n: SNode): string[] { if (n[0] === "zone") return expandLayers(doc, zoneLayers(n)); if (n[0] === "via") return copperOf(doc); const l = itemLayer(n); return l ? expandLayers(doc, [l]) : []; }
const copperOf = (doc: BoardDoc): string[] => (doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]);
function expandLayers(doc: BoardDoc, ls: string[]): string[] {
  const out: string[] = [];
  for (const l of ls) { if (l === "*.Cu") out.push(...copperOf(doc)); else if (l === "F&B.Cu") out.push("F.Cu", "B.Cu"); else if (l.startsWith("*.")) out.push("F" + l.slice(1), "B" + l.slice(1)); else out.push(l); }
  return out;
}
/** BOARD_ITEM::IsConnected: tracks, vias, zones and shapes on copper are BOARD_CONNECTED_ITEMs on a copper layer. */
const isConnected = (doc: BoardDoc, n: SNode): boolean => TRACKS.has(String(n[0])) || n[0] === "zone" ? !(n[0] === "zone" && K.kid(n, "keepout")) : /^gr_/.test(String(n[0])) && n[0] !== "gr_text" && n[0] !== "gr_text_box" && isCopper(itemLayer(n));
/** The first outline of a zone. */
const outline0 = (z: SNode): Pt[] => { const p = K.kid(z, "polygon"); return p ? K.ptsOf(p) as Pt[] : []; };
const bboxOfPts = (pts: Pt[]): number[] => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; };
/** SHAPE::Centre: the bounding box's centre. */
const centreOf = (pts: Pt[]): Pt => { const b = bboxOfPts(pts); return [r6((b[0] + b[2]) / 2), r6((b[1] + b[3]) / 2)]; };
const boxContains = (a: number[], b: number[]): boolean => b[0] >= a[0] && b[1] >= a[1] && b[2] <= a[2] && b[3] <= a[3];
const boxIntersects = (a: number[], b: number[]): boolean => !(b[0] > a[2] || b[2] < a[0] || b[1] > a[3] || b[3] < a[1]);

/** An item of a node not on the board, with its geometry (bbox) built. */
function scratchItem(doc: BoardDoc, node: SNode): KItem | null { return K.addItem({ ...doc, items: new Map() } as KDoc, node); }
/** FOOTPRINT::GetBoundingBox( false ): the footprint without its texts. */
export function footprintBox(it: KItem): number[] | null {
  let b: number[] | null = null;
  for (const g of it.geom || []) {
    const gg = g as KGeom & { t?: string; text?: string }; if (gg.t === "text" || gg.text) continue;
    const gb = (K as unknown as { geomBox(g: KGeom): number[] | null }).geomBox(g); if (!gb) continue;
    b = b ? [Math.min(b[0], gb[0]), Math.min(b[1], gb[1]), Math.max(b[2], gb[2]), Math.max(b[3], gb[3])] : gb.slice();
  }
  return b || (it.bbox ? it.bbox.slice() : null);
}
const itemBox = (it: KItem): number[] | null => (it.kind === "footprint" ? footprintBox(it) : it.bbox ? it.bbox.slice() : null);

// ---------------------------------------------------------------- geometry ports
const NM = 1e6;
/** KIGEOM::RectifyPolygon on BuildConvexHull's open chain: PointInside of an open chain is false, so every edge A→B
 *  turns at (A.x, B.y); then SHAPE_LINE_CHAIN::Simplify( 0 ) of the closed result. */
export function rectifyHull(hull: number[][]): number[][] {
  const out: number[][] = [];
  const seg = (a: number[], b: number[]): void => { out.push(a); out.push([a[0], b[1]]); };
  for (let i = 0; i + 1 < hull.length; i++) seg(hull[i], hull[i + 1]);
  if (hull.length >= 2) seg(hull[hull.length - 1], hull[0]);
  return simplifyClosed(out);
}
/** TestSegmentHit( p, a, b, 0 ): p on the segment a-b (integer nanometres). */
const onSeg = (p: number[], a: number[], b: number[]): boolean => {
  const cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); if (cr !== 0) return false;
  return p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
};
/** SHAPE_LINE_CHAIN::Simplify( 0 ) of a closed chain. */
export function simplifyClosed(pts: number[][]): number[][] {
  const n = pts.length; if (n < 3) return pts.slice();
  const res: number[][] = [];
  for (let s = 0; s < n;) {
    res.push(pts[s]);
    let e = (s + 2) % n, can = true;
    while (can && e !== s) {
      for (let t = (s + 1) % n; t !== e; t = (t + 1) % n) if (!onSeg(pts[t], pts[s], pts[e])) { can = false; break; }
      if (can) e = (e + 1) % n;
    }
    if (e === (s + 2) % n) s++;
    else { const ns = (e + n - 1) % n; if (ns <= s) break; s = ns; }
  }
  if (res.length === 1) res.push(pts[n - 1]);
  return res;
}
/** buildRAOutline: the convex hull of the boxes grown by aMargin, made of 90 degree segments. */
export function buildRAOutline(boxes: number[][], marginMm: number): Pt[] {
  const corners: number[][] = [];
  for (const b of boxes) {
    const x0 = Math.round((b[0] - marginMm) * NM), y0 = Math.round((b[1] - marginMm) * NM), x1 = Math.round((b[2] + marginMm) * NM), y1 = Math.round((b[3] + marginMm) * NM);
    corners.push([x0, y0], [x1, y0], [x1, y1], [x0, y1]);
  }
  if (corners.length < 2) return [];
  return rectifyHull(convexHull(corners as [number, number][])).map(([x, y]) => [r6(x / NM), r6(y / NM)]);
}
/** outlinesOverlap: the two outlines share area; touching edges do not count. */
export function outlinesOverlap(a: Pt[], b: Pt[]): boolean {
  if (a.length < 3 || b.length < 3 || !boxIntersects(bboxOfPts(a), bboxOfPts(b))) return false;
  const inside = (P: Pt[], x: number, y: number): boolean => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  const onEdge = (P: Pt[], p: Pt): boolean => P.some((q, i) => onSeg(p.map((v) => Math.round(v * NM)), q.map((v) => Math.round(v * NM)), P[(i + 1) % P.length].map((v) => Math.round(v * NM))));
  const cross = (o: Pt, p: Pt, q: Pt): number => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const a0 = a[i], a1 = a[(i + 1) % a.length], b0 = b[j], b1 = b[(j + 1) % b.length];
    const d1 = cross(b0, b1, a0), d2 = cross(b0, b1, a1), d3 = cross(a0, a1, b0), d4 = cross(a0, a1, b1);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;   // a proper crossing
  }
  // no proper crossing: one holds the other, or they only touch; a sample point strictly inside decides
  const probe = (P: Pt[], Q: Pt[]): boolean => {
    for (let i = 0; i < P.length; i++) {
      const m: Pt = [(P[i][0] + P[(i + 1) % P.length][0]) / 2, (P[i][1] + P[(i + 1) % P.length][1]) / 2];
      for (const p of [P[i], m]) if (!onEdge(Q, p) && inside(Q, p[0], p[1])) return true;
    }
    const c = centreOf(P); return inside(P, c[0], c[1]) && !onEdge(Q, c) && inside(Q, c[0], c[1]);
  };
  return probe(a, b) || probe(b, a);
}

// ---------------------------------------------------------------- zones: placement source and the layout link
export interface ZonePlacement { enabled: boolean; type: SourceType; source: string }
/** The zone's (placement …): enabled, source type and source. */
export function placementOf(z: SNode): ZonePlacement {
  const p = K.kid(z, "placement");
  if (!p) return { enabled: false, type: "sheetname", source: "" };
  const t: SourceType = K.kid(p, "component_class") ? "component_class" : K.kid(p, "group") ? "group" : "sheetname";
  return { enabled: kidStr(p, "enabled") === "yes", type: t, source: kidStr(p, t) };
}
/** GetIsRuleArea */
export const isRuleArea = (z: SNode): boolean => z[0] === "zone" && !!K.kid(z, "keepout");
const isPlacementArea = (z: SNode): boolean => isRuleArea(z) && placementOf(z).enabled;
/** ZONE::GetLinkSet / GetRepeatOptions: (placement … (link "set" (placement yes) … (anchor "uuid"))). */
export function linkOf(z: SNode): { set: string; opts: RepeatOptions } {
  const p = K.kid(z, "placement"), l = p && K.kid(p, "link");
  if (!l) return { set: "", opts: { ...DEFAULT_REPEAT_OPTIONS } };
  const b = (k: string, d: boolean): boolean => { const c = K.kid(l, k); return c ? K.str(c[1]) === "yes" : d; };
  return { set: K.str(l[1]), opts: { copyPlacement: b("placement", true), copyRouting: b("routing", true), connectedRoutingOnly: b("connected_routing", false), copyOtherItems: b("other_items", true),
    groupItems: b("group_items", false), includeLockedItems: b("locked_items", true), anchor: kidStr(l, "anchor") } };
}
/** SetLinkSet / SetRepeatOptions, written as PCB_IO_KICAD_SEXPR formats them (only while the zone is linked). */
export function setLink(z: SNode, set: string, opts: RepeatOptions): void {
  let p = K.kid(z, "placement");
  if (!p) { if (!set) return; p = ["placement", ["enabled", "no"], ["sheetname", ""]]; const f = z.findIndex((c, i) => i > 0 && isList(c) && (c[0] === "fill" || c[0] === "polygon")); z.splice(f > 0 ? f : z.length, 0, p); }
  const i = p.findIndex((c, k) => k > 0 && isList(c) && c[0] === "link"); if (i > 0) p.splice(i, 1);
  if (!set) return;
  const yn = (v: boolean): string => (v ? "yes" : "no");
  const l: SNode = ["link", set, ["placement", yn(opts.copyPlacement)], ["routing", yn(opts.copyRouting)], ["connected_routing", yn(opts.connectedRoutingOnly)], ["other_items", yn(opts.copyOtherItems)], ["group_items", yn(opts.groupItems)], ["locked_items", yn(opts.includeLockedItems)]];
  if (opts.anchor) l.push(["anchor", opts.anchor]);
  p.push(l);
}
function setPlacement(z: SNode, type: SourceType, source: string): void {
  const link = K.kid(z, "placement") && K.kid(K.kid(z, "placement")!, "link");
  const i = z.findIndex((c, k) => k > 0 && isList(c) && c[0] === "placement");
  const p: SNode = ["placement", ["enabled", "yes"]]; if (type !== "design_block") p.push([type, source]); if (link) p.push(link);
  if (i > 0) z[i] = p; else { const f = z.findIndex((c, k) => k > 0 && isList(c) && (c[0] === "fill" || c[0] === "polygon")); z.splice(f > 0 ? f : z.length, 0, p); }
}
const setZoneName = (z: SNode, name: string): void => { const n = K.kid(z, "name"); if (n) n[1] = name; else { const u = z.findIndex((c, k) => k > 0 && isList(c) && c[0] === "uuid"); z.splice(u > 0 ? u + 1 : 1, 0, ["name", name]); } };
const setOutline = (z: SNode, pts: Pt[]): void => { const i = z.findIndex((c, k) => k > 0 && isList(c) && c[0] === "polygon"); const poly: SNode = ["polygon", ["pts", ...pts.map((p) => ["xy", r6(p[0]), r6(p[1])])]]; for (let k = z.length - 1; k > 0; k--) if (isList(z[k]) && ((z[k] as SNode)[0] === "polygon" || (z[k] as SNode)[0] === "filled_polygon")) z.splice(k, 1); z.splice(i > 0 ? i : z.length, 0, poly); };
/** makePlacementArea: a copper rule area with nothing disallowed, placement on, no hatch. */
export function placementAreaNode(outline: Pt[]): SNode {
  return ["zone", ["layers", "*.Cu"], ["uuid", K.newUuid()], ["hatch", "none", 0.5], ["connect_pads", ["clearance", 0]], ["min_thickness", 0.25], ["filled_areas_thickness", "no"],
    ["keepout", ["tracks", "allowed"], ["vias", "allowed"], ["pads", "allowed"], ["copperpour", "allowed"], ["footprints", "allowed"]],
    ["placement", ["enabled", "yes"], ["sheetname", ""]], ["fill", ["thermal_gap", 0.5], ["thermal_bridge_width", 0.5]], ["polygon", ["pts", ...outline.map((p) => ["xy", r6(p[0]), r6(p[1])])]]];
}
/** BOARD::MakeUniqueZoneName */
export function makeUniqueZoneName(base: string, inUse: (s: string) => boolean): string {
  if (!base || !inUse(base)) return base;
  let root = base; const us = base.lastIndexOf("_"); if (us >= 0 && /^\d+$/.test(base.slice(us + 1))) root = base.slice(0, us);
  for (let i = 1; ; i++) { const c = `${root}_${i}`; if (!inUse(c)) return c; }
}

// ---------------------------------------------------------------- BOARD_COMMIT
/** The edits of one command, staged without touching the document. */
export class Stage {
  mods = new Map<string, SNode>(); adds = new Map<string, SNode>(); dels = new Set<string>();
  constructor(public doc: BoardDoc) {}
  node(id: string): SNode | null { return this.adds.get(id) || this.mods.get(id) || (this.dels.has(id) ? null : this.doc.items.get(id)?.node || null); }
  /** GetStatus( item ) != 0 */
  status(id: string): boolean { return this.adds.has(id) || this.mods.has(id) || this.dels.has(id); }
  modify(id: string): SNode | null {
    const a = this.adds.get(id); if (a) return a;
    if (this.dels.has(id)) return null;
    let m = this.mods.get(id); if (!m) { const it = this.doc.items.get(id); if (!it) return null; m = clone(it.node); this.mods.set(id, m); }
    return m;
  }
  add(node: SNode): string { let id = uuidOf(node); if (!id) { id = K.newUuid(); node.push(["uuid", id]); } this.adds.set(id, node); return id; }
  remove(id: string): void {
    const g = this.parentOf(id); if (g) { const gn = this.modify(g)!; const m = K.kid(gn, "members"); if (m) { const i = m.findIndex((x, k) => k > 0 && K.str(x) === id); if (i > 0) m.splice(i, 1); } }
    if (this.adds.delete(id)) return;
    this.mods.delete(id); if (this.doc.items.has(id)) this.dels.add(id);
  }
  groupIds(): string[] { const out: string[] = []; for (const it of this.doc.items.values()) if (isGroupish(it.kind) && !this.dels.has(it.id)) out.push(it.id); for (const [id, n] of this.adds) if (isGroupish(String(n[0]))) out.push(id); return out; }
  /** GetParentGroup in the staged state */
  parentOf(id: string): string | null { for (const g of this.groupIds()) if (membersOf(this.node(g)!).includes(id)) return g; return null; }
  kindOf(id: string): string { const n = this.node(id); return n ? String(n[0]) : ""; }
  addMember(groupId: string, id: string): void { const gn = this.modify(groupId)!; let m = K.kid(gn, "members"); if (!m) { m = ["members"]; gn.push(m); } if (!m.slice(1).map(K.str).includes(id)) m.push(id); }
  removeMember(groupId: string, id: string): void { const gn = this.modify(groupId)!; const m = K.kid(gn, "members"); if (!m) return; const i = m.findIndex((x, k) => k > 0 && K.str(x) === id); if (i > 0) m.splice(i, 1); }
  changes(): PcbChange[] {
    const out: PcbChange[] = [];
    for (const id of this.dels) { const it = this.doc.items.get(id); if (it) { const c = K.removeChange(it) as PcbChange; c.typeName = typeNameOf(it); out.push(c); } }
    const added = [...this.adds].sort((a, b) => Number(isGroupish(String(a[1][0]))) - Number(isGroupish(String(b[1][0]))));
    for (const [id, n] of added) out.push(upsertChange({ id, kind: String(n[0]), node: n }, "ADDED"));
    for (const [id, n] of this.mods) { const it = this.doc.items.get(id)!; if (K.serialize(it.node) !== K.serialize(n)) out.push(upsertChange({ id, kind: it.kind, node: n }, "MODIFIED")); }
    return out;
  }
  get empty(): boolean { return !this.adds.size && !this.dels.size && ![...this.mods].some(([id, n]) => K.serialize(this.doc.items.get(id)!.node) !== K.serialize(n)); }
}
/** stageAddToGroup: aItem moves into aGroup; the group it leaves is staged too.  A generator keeps its members. */
function stageAddToGroup(st: Stage, groupId: string, id: string): void {
  const old = st.parentOf(id);
  if (old) { if (old === groupId || st.kindOf(old) === "generated") return; st.removeMember(old, id); }
  st.addMember(groupId, id);
}

// ---------------------------------------------------------------- the topology of a footprint set
const AUTO_NET = (n: string): boolean => n.startsWith("Net-(") || n.startsWith("unconnected-");
const boardSide = (doc: BoardDoc): Side => ({ doc, key: (n) => n });
/** A design block's board: its auto-named nets get a private namespace (IsolateDesignBlockAutoNets, issue 24767). */
const blockSide = (doc: BoardDoc): Side => ({ doc, key: (n) => (AUTO_NET(n) ? "__dbapply_" + n : n) });
const padNetKey = (side: Side, pad: SNode): string => { const n = netNameOf(side.doc, pad); return n ? side.key(n) : ""; };
const tmCache = new WeakMap<SNode, TmFootprint & { item: KItem }>();
function tmOf(side: Side, it: KItem): TmFootprint & { item: KItem } {
  let t = tmCache.get(it.node);
  if (t && t.item === it) return t;
  const shown = new Map<string, string>();
  const pads = K.kids(it.node, "pad").map((p) => { const net = padNetKey(side, p); shown.set(net, netNameOf(side.doc, p)); return { number: K.str(p[1]), net }; });
  t = { key: it.id, ref: fpRef(it.node), fpid: fpid(it.node), value: fpValue(it.node), path: fpPath(it.node), pads, netName: (n) => shown.get(n) || "", item: it };
  tmCache.set(it.node, t); return t;
}
const sortRefs = (fps: KItem[]): string[] => fps.map((f) => fpRef(f.node)).sort((a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
/** FormatComponentList: the references, ten to a line. */
export function formatComponentList(fps: KItem[]): string {
  const refs = sortRefs(fps); if (!refs.length) return "(none)";
  const lines: string[] = []; for (let i = 0; i < refs.length; i += 10) lines.push(refs.slice(i, i + 10).join(", "));
  return lines.join("\n");
}
/** MULTICHANNEL_TOOL::JoinReferences */
export const joinReferences = (fps: Iterable<KItem>): string => [...fps].map((f) => fpRef(f.node)).sort().join(",");

/** matchBySymbolInstancePath: the unique closest instance path, when it gives a pad compatible bijection. */
function matchBySymbolInstancePath(ref: KItem[], target: KItem[]): Map<KItem, KItem> | null {
  if (!ref.length || ref.length !== target.length) return null;
  const res = new Map<KItem, KItem>(), used = new Set<KItem>();
  for (const r of ref) {
    let t: KItem | null = null, best = 0, tied = false;
    for (const c of target) { const len = commonPathTailLength(fpPath(r.node), fpPath(c.node)); if (len > best) { t = c; best = len; tied = false; } else if (len === best && len > 0) tied = true; }
    if (!t || tied) return null;
    if (fpid(r.node) !== fpid(t.node) || K.kids(r.node, "pad").length !== K.kids(t.node, "pad").length) return null;
    if (used.has(t)) return null; used.add(t); res.set(r, t);
  }
  return res;
}

// ---------------------------------------------------------------- the tool
export interface RulesProgress { (title: string, done: number, total: number, matched: number, of: number): boolean | void }

/** RULE_AREAS_DATA and the MULTICHANNEL_TOOL methods that work on it. */
export class Multichannel {
  areas: RuleArea[] = [];
  compat = new Map<RuleArea, CompatData>();
  refRA: RuleArea | null = null;
  options: RepeatOptions = { ...DEFAULT_REPEAT_OPTIONS };
  replaceExisting = false; linkAreas = false;
  selectedItems: KItem[] = []; selectedFootprints: KItem[] = [];
  /** areas and groups not yet on the board: their nodes by id */
  scratch = new Map<string, SNode>();
  side: Side;
  /** the user cancelled the progress of resolveTopologies (checked between jobs and during a job) */
  cancelled: () => boolean = () => false;
  constructor(public doc: BoardDoc) { this.side = boardSide(doc); }
  get fromSelection(): boolean { return this.selectedItems.length > 0; }
  reset(): void { this.areas = []; this.compat = new Map(); this.refRA = null; this.options = { ...DEFAULT_REPEAT_OPTIONS }; this.replaceExisting = false; this.linkAreas = false; this.selectedItems = []; this.selectedFootprints = []; this.scratch = new Map(); }
  private area(p: Partial<RuleArea>): RuleArea {
    return { sourceType: "sheetname", fromSelection: false, zone: null, zoneId: null, components: [], designBlockItems: [], group: null, groupId: null, generateEnabled: false, sheetPath: "", sheetName: "", ruleName: "", componentClass: "", groupName: "", center: [0, 0], side: this.side, ...p };
  }
  private zoneOnBoard(a: RuleArea): boolean { return !!a.zoneId && this.doc.items.has(a.zoneId) && this.doc.items.get(a.zoneId)!.node === a.zone; }

  // ---------------------------------------------------------------- queries
  /** queryComponentsInSheet: the sheet and its children */
  queryComponentsInSheet(sheet: string): KItem[] {
    if (sheet.endsWith("/")) sheet = sheet.slice(0, -1);
    const child = sheet + "/";
    return footprints(this.doc).filter((fp) => { let sn = fpSheetname(fp.node); if (sn.endsWith("/")) sn = sn.slice(0, -1); return sn === sheet || sn.startsWith(child); });
  }
  queryComponentsInComponentClass(cls: string): KItem[] { return footprints(this.doc).filter((fp) => fpClasses(fp.node).includes(cls)); }
  private wxMatches(pat: string, s: string): boolean { return new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$").test(s); }
  private collectGroupFootprints(g: SNode, out: KItem[]): void {
    for (const id of membersOf(g)) { const it = this.doc.items.get(id); if (!it) continue; if (it.kind === "footprint") { if (!out.includes(it)) out.push(it); } else if (it.kind === "group") this.collectGroupFootprints(it.node, out); }
  }
  /** collectGroupBoardItems: nested groups recurse, a generator stands for its children */
  collectGroupBoardItems(g: SNode, out: KItem[], st?: Stage): void {
    for (const id of membersOf(g)) { const n = st ? st.node(id) : this.doc.items.get(id)?.node; const it = this.doc.items.get(id); if (!n || !it) continue; if (n[0] === "group") this.collectGroupBoardItems(n, out, st); else if (!out.includes(it)) out.push(it); }
  }
  queryComponentsInGroup(name: string): KItem[] { const out: KItem[] = []; for (const g of groups(this.doc)) if (this.wxMatches(name, K.str(g.node[1]))) this.collectGroupFootprints(g.node, out); return out; }
  findPlacementGroup(name: string): KItem | null { let f: KItem | null = null; for (const g of groups(this.doc)) { if (!this.wxMatches(name, K.str(g.node[1]))) continue; if (f) return null; f = g; } return f; }
  queryBoardItemsInGroup(name: string): KItem[] { const out: KItem[] = []; for (const g of groups(this.doc)) { if (!this.wxMatches(name, K.str(g.node[1]))) continue; for (const id of membersOf(g.node)) { const it = this.doc.items.get(id); if (it && !out.includes(it)) out.push(it); } } return out; }
  parentGroupOf(id: string): KItem | null { for (const it of this.doc.items.values()) if (isGroupish(it.kind) && membersOf(it.node).includes(id)) return it; return null; }

  /** findComponentsInRuleArea: the area's source (memberOfSheetOrChildren, hasComponentClass, memberOfGroup) */
  findComponentsInRuleArea(a: RuleArea): KItem[] {
    if (!a.zone) return [];
    if (a.sourceType === "design_block") return a.designBlockItems.filter((it) => it.kind === "footprint");
    const pl = placementOf(a.zone), src = pl.source;
    return footprints(this.doc).filter((fp) => {
      if (pl.type === "component_class") return fpClasses(fp.node).some((c) => this.wxMatches(src, c));
      if (pl.type === "group") { let g = this.parentGroupOf(fp.id), guard = 0; while (g && guard++ < 64) { if (this.wxMatches(src, K.str(g.node[1]))) return true; g = this.parentGroupOf(g.id); } return false; }
      let sheet = fpSheetname(fp.node), ref = src; if (sheet.endsWith("/")) sheet = sheet.slice(0, -1); if (ref.endsWith("/")) ref = ref.slice(0, -1);
      if ((this.wxMatches("/", ref) || !ref) && !sheet) return true;
      const sp = sheet.split("/"), rp = ref.split("/"); if (rp.length > sp.length) return false;
      return rp.every((r, i) => this.wxMatches(r, sp[i]));
    });
  }
  /** enclosedByArea( zone uuid ) */
  private enclosed(zone: SNode, it: KItem): boolean {
    const sh = itemShape({ kind: it.kind, node: it.node, item: it }); if (!sh) return false;
    const zl = itemLayers(this.doc, zone), il = it.kind === "via" || it.kind === "footprint" ? [] : itemLayers(this.doc, it.node);
    if (il.length && it.kind !== "zone" && !il.some((l) => zl.includes(l))) return false;
    for (const poly of K.kids(zone, "polygon")) { const P = K.ptsOf(poly) as Pt[]; if (P.length > 2 && shapeInsidePoly(sh, P)) return true; }
    return false;
  }
  /** linkedChannelGroup: a linked channel made with its items grouped is exactly its group */
  linkedChannelGroup(a: RuleArea): KItem | null {
    if (!a.zone || a.sourceType === "design_block" || !this.zoneOnBoard(a)) return null;
    const l = linkOf(a.zone); if (!l.set || !l.opts.groupItems) return null;
    const g = this.parentGroupOf(a.zoneId!); return g && g.kind === "group" ? g : null;
  }
  private layersIntersect(zone: SNode, n: SNode): boolean { const zl = itemLayers(this.doc, zone); return itemLayers(this.doc, n).some((l) => zl.includes(l)) || n[0] === "via" && zl.some(isCopper); }
  /** findOtherItemsInRuleArea */
  findOtherItemsInRuleArea(a: RuleArea): KItem[] {
    const out: KItem[] = []; if (!a.zone) return out;
    const add = (it: KItem): void => { if (!out.includes(it)) out.push(it); };
    if (a.sourceType === "design_block") {
      for (const it of a.designBlockItems) {
        if (it.kind === "footprint" || it.kind === "group" || it.kind === "generated") continue;
        if (!isConnected(a.side.doc, it.node) || it.kind === "zone") add(it);
      }
      if (a.fromSelection) {
        const box = bboxOfPts(outline0(a.zone));
        const inside = (it: KItem): boolean => this.layersIntersect(a.zone!, it.node) && !!it.bbox && boxContains(box, it.bbox);
        for (const it of this.doc.items.values()) {
          if (it.kind === "zone" && !isRuleArea(it.node) && inside(it)) add(it);
          else if (DRAWING(it.kind) && !isConnected(this.doc, it.node) && !this.parentGroupOf(it.id) && inside(it)) add(it);
        }
      }
      return out;
    }
    const lg = this.linkedChannelGroup(a);
    if (lg) {
      const members: KItem[] = []; this.collectGroupBoardItems(lg.node, members);
      for (const it of members) { if (it.id === a.zoneId || it.kind === "footprint" || it.kind === "generated") continue; if (!isConnected(this.doc, it.node) || it.kind === "zone") add(it); }
      return out;
    }
    if (a.sourceType === "group" && (a.components.length || a.group) && !this.zoneOnBoard(a)) {
      const g = a.group || (a.components.length ? this.parentGroupOf(a.components[0].id)?.node || null : null);
      if (g) { const members: KItem[] = []; this.collectGroupBoardItems(g, members); for (const it of members) { if (it.kind === "footprint" || it.kind === "generated") continue; if (!isConnected(this.doc, it.node) || it.kind === "zone") add(it); } }
      return out;
    }
    for (const it of this.doc.items.values()) {
      if (it.kind === "zone") { if (it.node !== a.zone && this.enclosed(a.zone, it)) add(it); }
      else if (DRAWING(it.kind) && !isConnected(this.doc, it.node) && this.enclosed(a.zone, it)) add(it);
    }
    return out;
  }
  /** findRoutingInRuleArea */
  findRoutingInRuleArea(a: RuleArea, out: KItem[]): void {
    if (!a.zone) return;
    const inGenerator = (id: string, doc: BoardDoc): boolean => { for (const g of doc.items.values()) if (g.kind === "generated" && membersOf(g.node).includes(id)) return true; return false; };
    const add = (it: KItem): void => { if (!out.includes(it)) out.push(it); };
    if (a.sourceType === "design_block") {
      for (const it of a.designBlockItems) { if (it.kind === "zone" || !isConnected(a.side.doc, it.node) || inGenerator(it.id, a.side.doc)) continue; add(it); }
      if (!a.fromSelection) return;
    }
    const lg = this.linkedChannelGroup(a);
    if (lg) {
      const members: KItem[] = []; this.collectGroupBoardItems(lg.node, members);
      for (const it of members) if (it.kind !== "zone" && isConnected(this.doc, it.node) && !inGenerator(it.id, this.doc)) add(it);
      return;
    }
    const candidates = [...this.doc.items.values()].filter((it) => TRACKS.has(it.kind) || (DRAWING(it.kind) && isConnected(this.doc, it.node)));
    const zbox = bboxOfPts(outline0(a.zone));
    const scratchZone = (a.sourceType === "group" || a.fromSelection) && !this.zoneOnBoard(a);
    for (const it of candidates) {
      if (out.includes(it) || inGenerator(it.id, this.doc)) continue;
      if (!this.layersIntersect(a.zone, it.node) || !it.bbox) continue;
      if (scratchZone ? !boxContains(zbox, it.bbox) : !boxIntersects(zbox, it.bbox)) continue;
      if (this.enclosed(a.zone, it)) add(it);
    }
  }

  // ---------------------------------------------------------------- Generate Placement Rule Areas
  /** GeneratePotentialRuleAreas: every sheet (and parent sheet), component class and named group */
  generatePotentialRuleAreas(): void {
    const sheets = new Map<string, string>(), classes = new Set<string>(), grps = new Set<string>();
    this.areas = [];
    for (const fp of footprints(this.doc)) {
      const sn = fpSheetname(fp.node); sheets.set(sn, fpSheetfile(fp.node));
      for (const parent of parentSheetPaths(sn)) if (!sheets.has(parent)) sheets.set(parent, "");
      for (const c of fpClasses(fp.node)) classes.add(c);
      for (let g = this.parentGroupOf(fp.id), guard = 0; g && guard++ < 64; g = this.parentGroupOf(g.id)) { const nm = g.kind === "group" ? K.str(g.node[1]) : ""; if (nm) grps.add(nm); }
    }
    const sorted = (it: Iterable<string>): string[] => [...it].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const path of sorted(sheets.keys())) this.areas.push(this.area({ sourceType: "sheetname", sheetPath: path, sheetName: sheets.get(path)!, components: this.queryComponentsInSheet(path) }));
    for (const c of sorted(classes)) this.areas.push(this.area({ sourceType: "component_class", componentClass: c, components: this.queryComponentsInComponentClass(c) }));
    for (const g of sorted(grps)) this.areas.push(this.area({ sourceType: "group", groupName: g, components: this.queryComponentsInGroup(g) }));
  }
  /** FindExistingRuleAreas: the board's placement rule areas with their footprints */
  findExistingRuleAreas(): void {
    this.areas = [];
    for (const it of this.doc.items.values()) {
      if (it.kind !== "zone" || !isPlacementArea(it.node)) continue;
      const pl = placementOf(it.node);
      const a = this.area({ zone: it.node, zoneId: it.id, sourceType: pl.type, ruleName: kidStr(it.node, "name"), center: centreOf(outline0(it.node)) });
      if (pl.type === "sheetname") a.sheetPath = pl.source;
      else if (pl.type === "component_class") a.componentClass = pl.source;
      else if (pl.type === "group") { a.groupName = pl.source; const g = this.findPlacementGroup(a.groupName); a.group = g ? g.node : null; a.groupId = g ? g.id : null; }
      a.components = this.findComponentsInRuleArea(a);
      this.areas.push(a);
    }
  }
  /** AutogenerateRuleAreas after the dialog: the commit of "Auto-generate Placement Rule Areas" */
  autogenerateRuleAreas(): PcbChange[] {
    const st = new Stage(this.doc);
    const made = new Map<RuleArea, string>();
    for (const ra of this.areas) {
      if (!ra.generateEnabled || !ra.components.length) continue;
      const source = ra.sourceType === "sheetname" ? ra.sheetPath : ra.sourceType === "component_class" ? ra.componentClass : ra.groupName;
      const old = [...this.doc.items.values()].filter((z) => z.kind === "zone" && isPlacementArea(z.node) && placementOf(z.node).type === ra.sourceType && placementOf(z.node).source === source);
      if (old.length && !this.replaceExisting) continue;
      let outline: Pt[];
      if (ra.sourceType === "group") {
        const gi = this.queryBoardItemsInGroup(ra.groupName); if (!gi.length) continue;
        outline = buildRAOutline(gi.map(itemBox).filter(Boolean) as number[][], 0.1);
      } else {
        const items: KItem[] = [], grs: KItem[] = [], nets = new Set<string>();
        for (const fp of ra.components) {
          items.push(fp); for (const p of K.kids(fp.node, "pad")) nets.add(netNameOf(this.doc, p));
          for (let g = this.parentGroupOf(fp.id), guard = 0; g && guard++ < 64; g = this.parentGroupOf(g.id)) if (!grs.includes(g)) grs.push(g);
        }
        for (const g of grs) this.collectGroupBoardItems(g.node, items);
        const foreign = new Set<string>(); for (const fp of footprints(this.doc)) if (!ra.components.includes(fp)) for (const p of K.kids(fp.node, "pad")) foreign.add(netNameOf(this.doc, p));
        for (const t of this.doc.items.values()) { if (t.kind !== "segment" && t.kind !== "arc" && t.kind !== "via") continue; const n = netNameOf(this.doc, t.node); if (n && nets.has(n) && !foreign.has(n) && !items.includes(t)) items.push(t); }
        outline = buildRAOutline(items.map(itemBox).filter(Boolean) as number[][], 0.1);
      }
      if (outline.length < 3) continue;
      const z = placementAreaNode(outline); setZoneName(z, `auto-placement-area-${source}`); setPlacement(z, ra.sourceType, source);
      for (const o of old) st.remove(o.id);
      made.set(ra, st.add(z));
    }
    if (this.options.groupItems) {
      for (const [ra, zid] of made) {
        pruneExistingGroups(this, st, new Set(ra.components.map((c) => c.id)));
        const g: SNode = ["group", "", ["uuid", K.newUuid()], ["members"]]; const gid = st.add(g);
        st.addMember(gid, zid); for (const fp of ra.components) { const old = st.parentOf(fp.id); if (old && old !== gid) st.removeMember(old, fp.id); st.addMember(gid, fp.id); }
      }
    }
    return st.changes();
  }

  // ---------------------------------------------------------------- topology
  /** resolveConnectionTopology */
  resolveConnectionTopology(ref: RuleArea, target: RuleArea, m: CompatData, extraGlobal: Set<string> = new Set()): boolean {
    if (ref.sourceType === "design_block" && !ref.components.length && !target.components.length) { m.matching = new Map(); m.isOk = true; m.errorMsg = "OK"; m.mismatchReasons = []; return true; }
    if (ref.components.length) {
      const shared = ref.components.filter((c) => target.components.includes(c));
      if (shared.length) {
        m.matching = new Map(); m.isOk = false; m.errorMsg = "Target Rule Area shares components with the reference area";
        m.mismatchReasons = ["This target Rule Area selects the same components as the reference area. Repeat layout cannot copy a Rule Area onto itself. Give each placement Rule Area a distinct sheet, component class or group.", `Shared components:\n${formatComponentList(shared)}`];
        return false;
      }
    }
    // a rail connects 2+ pads in two component-disjoint areas
    const internal = new Map<string, RuleArea[]>();
    for (const a of this.areas) {
      const counts = new Map<string, number>();
      for (const fp of a.components) for (const p of K.kids(fp.node, "pad")) { const k = padNetKey(a.side, p); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
      for (const [k, n] of counts) if (n >= 2) internal.set(k, (internal.get(k) || []).concat(a));
    }
    const disjoint = (x: RuleArea, y: RuleArea): boolean => !x.components.some((c) => y.components.includes(c));
    const globalNets = new Set(extraGlobal);
    for (const [k, as] of internal) for (let i = 0; i < as.length && !globalNets.has(k); i++) for (let j = i + 1; j < as.length; j++) if (disjoint(as[i], as[j])) { globalNets.add(k); break; }
    const tr = ref.components.map((c) => tmOf(ref.side, c)), tt = target.components.map((c) => tmOf(target.side, c));
    const cgRef = ConnectionGraph.fromFootprints(tr, tt, globalNets), cgTarget = ConnectionGraph.fromFootprints(tt, tr, globalNets);
    const result: ComponentMatches = new Map(), reasons: MismatchReason[] = [];
    let ok = cgRef.findIsomorphism(cgTarget, result, reasons, { cancelled: this.cancelled });
    m.matching = new Map(); for (const [a, b] of result) m.matching.set((a as TmFootprint & { item: KItem }).item, (b as TmFootprint & { item: KItem }).item);
    if (!ok && !this.cancelled()) { const byPath = matchBySymbolInstancePath(ref.components, target.components); if (byPath) { m.matching = byPath; ok = true; } }
    m.isOk = ok;
    if (ok) { m.errorMsg = "OK"; m.mismatchReasons = []; return true; }
    m.mismatchReasons = [];
    for (const r of reasons) { if (!r.reason) continue; if (r.reference && r.candidate) m.mismatchReasons.push(r.reason); else if (r.reference) m.mismatchReasons.push(`${r.reference}: ${r.reason}`); else m.mismatchReasons.push(r.reason); }
    if (!m.mismatchReasons.length) m.mismatchReasons.push("The components in the two areas could not be paired up.");
    if (ref.components.length !== target.components.length && ref.components.length && target.components.length) {
      m.mismatchReasons.push(`Reference area components:\n${formatComponentList(ref.components)}`, `Target area components:\n${formatComponentList(target.components)}`);
    }
    m.errorMsg = m.mismatchReasons[0];
    return false;
  }
  /** resolveTopologies: the jobs in turn; false when cancelled, the unfinished jobs then "Cancelled" */
  async resolveTopologies(title: string, jobs: { ref: RuleArea; target: RuleArea; compat: CompatData }[], progress?: RulesProgress): Promise<boolean> {
    let done = 0;
    for (const j of jobs) {
      if (this.cancelled()) break;
      if (progress && progress(title, done, jobs.length, 0, j.ref.components.length) === false) break;
      // the progress dialog paints and its Cancel is heard between jobs
      await new Promise((r) => setTimeout(r, 0));
      this.resolveConnectionTopology(j.ref, j.target, j.compat);
      if (this.cancelled()) break;
      done++;
    }
    if (done === jobs.length) return true;
    for (let i = done; i < jobs.length; i++) { jobs[i].compat.isOk = false; jobs[i].compat.errorMsg = "Cancelled"; jobs[i].compat.mismatchReasons = []; }
    return false;
  }
  /** CheckRACompatibility: -1 when the zone is no area here or the check was cancelled */
  async checkRACompatibility(refZoneId: string, progress?: RulesProgress): Promise<number> {
    this.refRA = this.areas.find((a) => a.zoneId === refZoneId) || null;
    if (!this.refRA) return -1;
    this.compat = new Map();
    const jobs = this.areas.filter((a) => a !== this.refRA).map((a) => { const c = newCompat(); this.compat.set(a, c); return { ref: this.refRA!, target: a, compat: c }; });
    if (!(await this.resolveTopologies("Checking Rule Area compatibility...", jobs, progress))) { this.compat = new Map(); return -1; }
    return 0;
  }
  /** Begin Repeat Layout from a rule area (MULTICHANNEL_TOOL::repeatLayout): the existing areas, checked against it. */
  async startFromRuleArea(refZoneId: string, progress?: RulesProgress): Promise<"ok" | "cancelled" | "none"> {
    this.reset(); this.findExistingRuleAreas();
    if ((await this.checkRACompatibility(refZoneId, progress)) < 0) return "cancelled";
    if (this.areas.length <= 1) return "none";
    const ref = this.refRA!.zone!, l = linkOf(ref);
    this.options = { ...l.opts }; this.linkAreas = !!l.set;
    for (const [a, c] of this.compat) c.doCopy = c.isOk && (!l.set || linkOf(a.zone!).set === l.set);
    return "ok";
  }

  // ---------------------------------------------------------------- discovery from plain selected parts
  private buildNetOwners(): Map<string, KItem[]> {
    const owners = new Map<string, KItem[]>();
    for (const fp of footprints(this.doc)) for (const p of K.kids(fp.node, "pad")) { const n = netNameOf(this.doc, p); if (!n) continue; const l = owners.get(n) || []; if (l[l.length - 1] !== fp) l.push(fp); owners.set(n, l); }
    return owners;
  }
  /** findMatches: the channels elsewhere on the board that repeat the topology of the selected parts */
  findMatches(selected: KItem[], loose: boolean): CompatData[] {
    const netOwners = this.buildNetOwners();
    const isChannelNet = (owners: KItem[], ch: Set<KItem>): boolean => owners.filter((f) => !ch.has(f)).length <= 1;
    const selSet = new Set(selected);
    const internal = new Set<string>(); for (const [n, ow] of netOwners) if (ow.length > 1 && isChannelNet(ow, selSet) && ow.some((f) => selSet.has(f))) internal.add(n);
    const padNets = (fp: KItem): string[] => { const s: string[] = []; for (const p of K.kids(fp.node, "pad")) { const n = netNameOf(this.doc, p); if (internal.has(n) && !s.includes(n)) s.push(n); } return s.sort(); };
    const leaves = new Set(selected.filter((fp) => padNets(fp).length <= 1));
    const found: CompatData[] = [];
    const classify = (c: CompatData): boolean => {
      for (const fp of selected) if (!c.discovered.has(fp)) c.unmatched.push(fp);
      c.doCopy = true;
      return !c.unmatched.length || (loose && c.unmatched.every((f) => leaves.has(f)));
    };
    for (const m of matchSheetInstances(this.doc, selected)) { const c = newCompat(); c.discovered = m; if (classify(c)) found.push(c); }
    if (found.length) return found;
    const fpidCount = new Map<string, number>(); for (const fp of footprints(this.doc)) fpidCount.set(fpid(fp.node), (fpidCount.get(fpid(fp.node)) || 0) + 1);
    const seed = selected.slice().sort((a, b) => (Number(leaves.has(a)) - Number(leaves.has(b))) || ((fpidCount.get(fpid(a.node)) || 0) - (fpidCount.get(fpid(b.node)) || 0)))[0];
    const order: KItem[] = [seed];
    for (let i = 0; i < order.length; i++) for (const n of padNets(order[i])) for (const fp of netOwners.get(n) || []) if (selSet.has(fp) && !order.includes(fp)) order.push(fp);
    const claimed = new Set(selected);
    for (const twin of footprints(this.doc)) {
      if (claimed.has(twin) || fpid(twin.node) !== fpid(seed.node)) continue;
      const fm = new FlatMatcher(this.doc, netOwners, internal, leaves, claimed, order, loose);
      const ok = fm.pair(0, twin);
      const c = newCompat();
      if (fm.budget < 0) { c.discovered = new Map([[seed, twin]]); c.searchLimit = true; found.push(c); continue; }
      c.discovered = fm.map;
      if (!ok || !classify(c)) continue;
      const refArea = this.area({}), tgtArea = this.area({}); const both = new Set<KItem>(); const rails = new Set<string>();
      for (const [r, t] of c.discovered) { refArea.components.push(r); tgtArea.components.push(t); both.add(r); both.add(t); }
      for (const fp of both) for (const p of K.kids(fp.node, "pad")) { const n = netNameOf(this.doc, p); if (n && !isChannelNet(netOwners.get(n) || [], both)) rails.add(n); }
      const saved = this.areas; this.areas = [];
      const okTopo = this.resolveConnectionTopology(refArea, tgtArea, newCompat(), rails);
      this.areas = saved;
      if (!okTopo) continue;
      for (const t of tgtArea.components) claimed.add(t);
      found.push(c);
    }
    return found;
  }
  /** StartRepeatFromSelection */
  async startRepeatFromSelection(ids: string[], progress?: RulesProgress): Promise<boolean> {
    this.reset();
    this.options.groupItems = true;
    for (const id of ids) {
      const it = this.doc.items.get(id); if (!it) continue;
      if (it.kind === "group") this.collectGroupBoardItems(it.node, this.selectedItems);
      else if (!this.selectedItems.includes(it)) this.selectedItems.push(it);
    }
    this.selectedFootprints = this.selectedItems.filter((it) => it.kind === "footprint");
    await this.discoverRepeatCandidates(false, progress);
    if (!this.refRA) { this.reset(); return false; }
    return true;
  }
  /** DiscoverRepeatCandidates */
  async discoverRepeatCandidates(loose: boolean, progress?: RulesProgress): Promise<void> {
    const selected = this.selectedFootprints;
    this.refRA = null; this.compat = new Map(); this.areas = []; this.scratch = new Map();
    if (!selected.length) return;
    const found = this.findMatches(selected, loose);
    const addArea = (outline: Pt[], fps: KItem[], type: SourceType): RuleArea => {
      const z = placementAreaNode(outline), g: SNode = ["group", "", ["uuid", K.newUuid()], ["members"]];
      this.scratch.set(uuidOf(z), z); this.scratch.set(uuidOf(g), g);
      const a = this.area({ zone: z, zoneId: uuidOf(z), group: g, groupId: uuidOf(g), components: fps.slice(), center: centreOf(outline), sourceType: type });
      this.areas.push(a); return a;
    };
    addArea(buildRAOutline(this.selectedItems.map(itemBox).filter(Boolean) as number[][], 0.1), selected, "design_block").fromSelection = true;
    for (const c of found) { const t = [...c.discovered.values()]; addArea(buildRAOutline(t.map(itemBox).filter(Boolean) as number[][], 0.1), t, "group"); }
    this.refRA = this.areas[0];
    found.forEach((c, i) => this.compat.set(this.areas[i + 1], c));
    const resolved = await this.updateSelectionCore(progress);
    let unticked = false;
    for (const c of this.compat.values()) { unticked = unticked || (c.doCopy && !c.isOk); c.doCopy = c.doCopy && c.isOk; }
    if (unticked && resolved) await this.updateSelectionCore(progress);
  }
  /** updateSelectionCore: every channel keeps the parts all ticked channels share; false when the check was cancelled */
  async updateSelectionCore(progress?: RulesProgress): Promise<boolean> {
    const ref = this.refRA; if (!ref) return true;
    const pruned = new Set<KItem>(); for (const c of this.compat.values()) if (c.doCopy) for (const u of c.unmatched) pruned.add(u);
    ref.components = []; ref.designBlockItems = [];
    for (const it of this.selectedItems) { if (it.kind === "footprint" && pruned.has(it)) continue; ref.designBlockItems.push(it); if (it.kind === "footprint") ref.components.push(it); }
    if (!ref.components.length) { for (const c of this.compat.values()) { c.isOk = false; c.errorMsg = "The ticked channels share no selected part"; } return true; }
    if (!ref.components.some((fp) => fp.id === this.options.anchor)) {
      this.options.anchor = ""; let biggest = -1;
      for (const fp of ref.components) { const b = footprintBox(fp); const area = b ? Math.round((b[2] - b[0]) * NM) * Math.round((b[3] - b[1]) * NM) : 0; if (area > biggest) { biggest = area; this.options.anchor = fp.id; } }
    }
    const jobs: { ref: RuleArea; target: RuleArea; compat: CompatData }[] = [];
    for (const [a, c] of this.compat) {
      a.components = []; for (const fp of ref.components) { const t = c.discovered.get(fp); if (t) a.components.push(t); }
      if (c.searchLimit) { c.isOk = false; c.errorMsg = "Search limit reached"; continue; }
      jobs.push({ ref, target: a, compat: c });
    }
    const resolved = await this.resolveTopologies("Matching channels...", jobs, progress);
    for (const j of jobs) {
      const c = j.compat; if (!c.isOk) continue;
      if (c.unmatched.length) c.errorMsg = `Loose: prunes ${joinReferences(c.unmatched)}`;
      const r = repeatedOutline(ref, j.target, this.options.anchor, c.matching);
      setOutline(j.target.zone!, r.outline);
    }
    return resolved;
  }
  /** RefreshRepeat (the preview follows separately) */
  async refreshRepeat(progress?: RulesProgress): Promise<void> { if (this.fromSelection) await this.updateSelectionCore(progress); }

  /** ExpandToMatchingTopology: one layer of neighbours, or (largest) until nothing more fits, after the sheet instance */
  expandToMatchingTopology(seed: KItem[], largest: boolean): KItem[] {
    let budget = 400;
    const hasTwin = (set: KItem[]): boolean => { budget--; return this.findMatches(set, false).some((m) => !m.searchLimit); };
    let result = seed.slice();
    if (!result.length || !hasTwin(result)) return result;
    const path = fpPath(seed[0].node);
    if (largest && path.length >= 2) {
      const sheet = footprints(this.doc).filter((fp) => { const o = fpPath(fp.node); return o.length === path.length && path.slice(0, -1).every((p, i) => p === o[i]); });
      if (sheet.length > result.length && seed.every((f) => sheet.includes(f)) && hasTwin(sheet)) return sheet;
    }
    const owners = this.buildNetOwners(); const maxOwners = 12;
    const rejected = new Set<KItem>(); let grew = true;
    const netKeys = [...owners.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    while (grew && budget > 0) {
      grew = false; const frontier = new Set(result);
      for (const n of netKeys) {
        const ow = owners.get(n)!; if (ow.length > maxOwners || !ow.some((f) => frontier.has(f))) continue;
        for (const fp of ow) {
          if (budget <= 0) break;
          if (result.includes(fp) || rejected.has(fp)) continue;
          const trial = result.concat(fp);
          if (hasTwin(trial)) { result = trial; grew = true; } else rejected.add(fp);
        }
      }
      if (grew) rejected.clear();
      if (!largest) break;
    }
    return result;
  }

  // ---------------------------------------------------------------- copying
  /** findRepeatRouting: the area's routing on the given nets, continued to the first segment outside unless restricted */
  findRepeatRouting(a: RuleArea, nets: Set<string>, opts: RepeatOptions): KItem[] {
    const scanned: KItem[] = []; this.findRoutingInRuleArea(a, scanned);
    const routing = scanned.filter((it) => nets.has(netNameOf(a.side.doc, it.node)));
    if (opts.connectedRoutingOnly || this.linkedChannelGroup(a)) return routing;
    const inside = routing.slice();
    const inGen = (id: string): boolean => { for (const g of this.doc.items.values()) if (g.kind === "generated" && membersOf(g.node).includes(id)) return true; return false; };
    const ends = (it: KItem): Pt[] => { const n = it.node; if (it.kind === "via") { const at = K.kid(n, "at"); return at ? [[K.num(at[1]), K.num(at[2])]] : []; } const s = K.kid(n, "start"), e = K.kid(n, "end"); return s && e ? [[K.num(s[1]), K.num(s[2])], [K.num(e[1]), K.num(e[2])]] : []; };
    const shareLayer = (x: KItem, y: KItem): boolean => { const lx = itemLayers(this.doc, x.node), ly = itemLayers(this.doc, y.node); return lx.some((l) => ly.includes(l)); };
    const touch = (x: KItem, y: KItem): boolean => { const ex = ends(x), ey = ends(y); return shareLayer(x, y) && ex.some((p) => ey.some((q) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6)); };
    for (const it of inside) {
      const net = netNameOf(this.doc, it.node);
      for (const nx of this.doc.items.values()) {
        if (!TRACKS.has(nx.kind) || routing.includes(nx) || inGen(nx.id)) continue;
        if (netNameOf(this.doc, nx.node) !== net || !nets.has(net)) continue;
        if (touch(it, nx)) routing.push(nx);
      }
    }
    return routing;
  }
  /** fixupNet: the copy takes the target net of the reference net, no net without matched parts */
  private fixupNet(refSide: Side, refNode: SNode, target: SNode, hasMatches: boolean, netMap: Map<string, string>): void {
    if (!hasMatches) { setNodeNet(this.doc, target, ""); return; }
    const k = padNetKey(refSide, refNode); if (netMap.has(k)) setNodeNet(this.doc, target, netMap.get(k)!);
    else if (refSide.doc !== this.doc) setNodeNet(this.doc, target, netNameOf(refSide.doc, refNode));
  }
  private layerSetContains(zone: SNode, layer: string): boolean { return itemLayers(this.doc, zone).includes(layer); }
  /** copyRuleAreaContents */
  copyRuleAreaContents(ref: RuleArea, target: RuleArea, st: Stage, opts: RepeatOptions, cd: CompatData): void {
    const { outline: newOutline, disp, rot } = repeatedOutline(ref, target, opts.anchor, cd.matching);
    const xf = (n: SNode): void => { if (rot) rotateNode(n, 0, 0, rot); translateNode(n, disp[0], disp[1]); };
    const hasMatches = cd.matching.size > 0;
    const netMap = new Map<string, string>();
    for (const [rf, tf] of cd.matching) for (const rp of K.kids(rf.node, "pad")) { const k = padNetKey(ref.side, rp); if (!k) continue; const tp = K.kids(tf.node, "pad").find((p) => K.str(p[1]) === K.str(rp[1])); if (tp && !netMap.has(k)) netMap.set(k, netNameOf(this.doc, tp)); }
    const refPoly = outline0(ref.zone!);
    const preserveGroups = target.sourceType !== "group" && !opts.groupItems;
    const fixups: [KItem, string][] = [], reproduced = new Set<string>();
    const refGroupOf = (it: KItem): KItem | null => { for (const g of ref.side.doc.items.values()) if (isGroupish(g.kind) && membersOf(g.node).includes(it.id)) return g; return null; };
    const fixupParentGroup = (src: KItem, destId: string): void => { if (!preserveGroups) return; if (refGroupOf(src)) fixups.push([src, destId]); reproduced.add(src.id); };
    const targetOnBoard = this.zoneOnBoard(target);
    if (targetOnBoard) {
      st.modify(target.zoneId!); cd.affected.add(target.zoneId!); cd.groupable.add(target.zoneId!);
      if (preserveGroups) { const rz = ref.zoneId ? ref.side.doc.items.get(ref.zoneId) : null; if (rz && refGroupOf(rz)) fixups.push([rz, target.zoneId!]); if (rz) reproduced.add(rz.id); }
    }
    const locked = (it: KItem): boolean => isLockedNode(it.node) || !!(this.parentGroupOf(it.id) && isLockedNode(this.parentGroupOf(it.id)!.node));
    if (opts.copyRouting) {
      const refc = new Set<string>(), targc = new Set<string>();
      for (const [rf, tf] of cd.matching) { for (const p of K.kids(rf.node, "pad")) refc.add(netNameOf(ref.side.doc, p)); for (const p of K.kids(tf.node, "pad")) targc.add(netNameOf(this.doc, p)); }
      let refRouting: KItem[] = [], targetRouting: KItem[] = [];
      const scans = ref.sourceType !== "design_block" || ref.fromSelection;
      if (scans) { targetRouting = this.findRepeatRouting(target, targc, opts); refRouting = this.findRepeatRouting(ref, refc, opts); }
      else { this.findRoutingInRuleArea(target, targetRouting); this.findRoutingInRuleArea(ref, refRouting); }
      const targetGroupNets = new Set<string>();
      for (const fp of target.components) for (const p of K.kids(fp.node, "pad")) targetGroupNets.add(netNameOf(this.doc, p));
      if (target.group) { const mem: KItem[] = []; this.collectGroupBoardItems(target.group, mem); for (const m of mem) if (m.kind === "footprint") { for (const p of K.kids(m.node, "pad")) targetGroupNets.add(netNameOf(this.doc, p)); } else if (isConnected(this.doc, m.node)) targetGroupNets.add(netNameOf(this.doc, m.node)); }
      const channelScope = ref.fromSelection || !!this.linkedChannelGroup(target);
      const targetChannelNets = new Set<string>();
      const owners = channelScope ? this.buildNetOwners() : null;
      for (const n of targetGroupNets) {
        if (!channelScope) { targetChannelNets.add(n); continue; }
        const ow = owners!.get(n) || []; if (ow.filter((f) => !target.components.includes(f)).length <= 1) targetChannelNets.add(n);
      }
      const tGroupMembers = new Set<string>(); if (target.group) { const mem: KItem[] = []; this.collectGroupBoardItems(target.group, mem); for (const m of mem) tGroupMembers.add(m.id); }
      for (const it of targetRouting) {
        if (ref.designBlockItems.includes(it)) continue;
        const net = netNameOf(this.doc, it.node);
        if (target.group && !tGroupMembers.has(it.id)) {
          if (this.parentGroupOf(it.id) || locked(it) || !net || !targetChannelNets.has(net)) continue;
        }
        if (locked(it) && !opts.includeLockedItems) continue;
        if ((opts.connectedRoutingOnly || scans) && !targc.has(net)) continue;
        if (st.status(it.id)) continue;
        if (!this.layerSetContains(target.zone!, itemLayer(it.node))) continue;
        cd.affected.add(it.id); st.remove(it.id);
      }
      for (const it of refRouting) {
        if (isLockedNode(it.node) && !opts.includeLockedItems) continue;
        if ((opts.connectedRoutingOnly || scans) && !refc.has(netNameOf(ref.side.doc, it.node))) continue;
        const l = itemLayer(it.node);
        if (!this.layerSetContains(ref.zone!, l) || !this.layerSetContains(target.zone!, l)) continue;
        const copy = clone(it.node); freshUuid(copy);
        this.fixupNet(ref.side, it.node, copy, hasMatches, netMap);
        xf(copy); const id = st.add(copy); fixupParentGroup(it, id); cd.groupable.add(id);
      }
      // generators (meanders) are copied whole
      const refGens: KItem[] = [], tgtGens: KItem[] = [];
      const gensOf = (g: SNode, out: KItem[], doc: BoardDoc): void => { const mem: KItem[] = []; const coll = (gg: SNode): void => { for (const id of membersOf(gg)) { const m = doc.items.get(id); if (!m) continue; if (m.kind === "group") coll(m.node); else mem.push(m); } }; coll(g); for (const m of mem) if (m.kind === "generated" && !out.includes(m)) out.push(m); };
      if (ref.sourceType === "design_block") {
        for (const it of ref.designBlockItems) if (it.kind === "generated") refGens.push(it);
        const tg = target.group || (target.components.length ? this.parentGroupOf(target.components[0].id)?.node || null : null);
        if (tg) gensOf(tg, tgtGens, this.doc);
      } else {
        const rg = this.linkedChannelGroup(ref), tg = this.linkedChannelGroup(target);
        if (rg) gensOf(rg.node, refGens, this.doc); if (tg) gensOf(tg.node, tgtGens, this.doc);
        if (!rg || !tg) {
          const ro = outline0(ref.zone!), to = outline0(target.zone!);
          for (const g of this.doc.items.values()) {
            if (g.kind !== "generated" || kidStr(g.node, "type") !== "tuning_pattern") continue;
            const hits = (P: Pt[]): boolean => !!g.bbox && P.length > 2 && [[g.bbox[0], g.bbox[1]], [g.bbox[2], g.bbox[3]]].every((p) => pointInPoly(P, p as Pt));
            if (!rg && hits(ro)) refGens.push(g);
            else if (!tg && !(rg && hits(ro)) && hits(to)) tgtGens.push(g);
          }
        }
      }
      for (const g of tgtGens) {
        if (isLockedNode(g.node) && !opts.includeLockedItems) continue;
        for (const id of membersOf(g.node)) st.remove(id);
        st.remove(g.id); cd.affected.add(g.id);
      }
      for (const g of refGens) {
        if (isLockedNode(g.node) && !opts.includeLockedItems) continue;
        const gc = clone(g.node); freshUuid(gc); xf(gc);
        const ids: string[] = [];
        for (const id of membersOf(g.node)) {
          const m = ref.side.doc.items.get(id); if (!m) continue;
          const mc = clone(m.node); freshUuid(mc); this.fixupNet(ref.side, m.node, mc, hasMatches, netMap); xf(mc); ids.push(st.add(mc));
        }
        const mm = K.kid(gc, "members"); if (mm) mm.splice(1, mm.length - 1, ...ids);
        const gid = st.add(gc); cd.groupable.add(gid);
      }
    }
    if (opts.copyOtherItems) {
      const src = this.findOtherItemsInRuleArea(ref), tgt = this.findOtherItemsInRuleArea(target);
      const skipLayer = ref.sourceType === "design_block" && target.sourceType === "group";
      for (const it of tgt) {
        if (ref.designBlockItems.includes(it)) continue;
        if (locked(it) && !opts.includeLockedItems) continue;
        if (st.status(it.id)) continue;
        if (it.kind === "zone") { if (skipLayer || itemLayers(this.doc, it.node).every((l) => this.layerSetContains(target.zone!, l))) { cd.affected.add(it.id); st.remove(it.id); } }
        else if (skipLayer || this.layerSetContains(target.zone!, itemLayer(it.node))) { cd.affected.add(it.id); st.remove(it.id); }
      }
      for (const it of src) {
        if (isLockedNode(it.node) && !opts.includeLockedItems) continue;
        const copy = clone(it.node);
        if (it.kind === "zone") {
          if (!skipLayer) { const allowed = itemLayers(this.doc, ref.zone!).filter((l) => this.layerSetContains(target.zone!, l)); if (!itemLayers(ref.side.doc, it.node).every((l) => allowed.includes(l))) continue; }
          freshUuid(copy); this.fixupNet(ref.side, it.node, copy, hasMatches, netMap);
        } else {
          if (!skipLayer) { const l = itemLayer(it.node); if (!this.layerSetContains(ref.zone!, l) || !this.layerSetContains(target.zone!, l)) continue; }
          freshUuid(copy);
        }
        xf(copy); const id = st.add(copy); fixupParentGroup(it, id); cd.groupable.add(id);
      }
    }
    if (opts.copyPlacement) {
      for (const [rf, tf] of cd.matching) {
        const rl = itemLayer(rf.node);
        if (!this.layerSetContains(ref.zone!, rl) || !this.layerSetContains(target.zone!, rl)) continue;
        if (ref.sourceType !== "design_block" && !this.linkedChannelGroup(ref) && !footprintCollides(rf, refPoly)) continue;
        if (locked(tf) && !opts.includeLockedItems) continue;
        const n = st.modify(tf.id)!;
        placeLike(this.doc, n, rf.node, rot, disp);
        cd.affected.add(tf.id); cd.groupable.add(tf.id);
        if (preserveGroups && refGroupOf(rf)) fixups.push([rf, tf.id]);
        if (preserveGroups) reproduced.add(rf.id);
      }
    }
    if (preserveGroups && fixups.length) {
      const map = new Map<string, string>(), full = new Map<string, boolean>();
      const fully = (g: KItem): boolean => { if (full.has(g.id)) return full.get(g.id)!; const ok = membersOf(g.node).every((m) => { const it = ref.side.doc.items.get(m); return !!it && !isGroupish(it.kind) && reproduced.has(m); }); full.set(g.id, ok); return ok; };
      for (const [src, dest] of fixups) {
        const pg = refGroupOf(src); if (!pg || !fully(pg)) continue;
        if (!map.has(pg.id)) { const ng = clone(pg.node); freshUuid(ng); const mm = K.kid(ng, "members"); if (mm) mm.splice(1); else ng.push(["members"]); if (pg.kind === "generated") xf(ng); map.set(pg.id, st.add(ng)); }
        const gid = map.get(pg.id)!; const old = st.parentOf(dest); if (old && old !== gid) st.removeMember(old, dest);
        st.addMember(gid, dest);
      }
    }
    if (target.zone) { const z = targetOnBoard ? st.modify(target.zoneId!)! : target.zone; setOutline(z, newOutline); if (!targetOnBoard) target.zone = z; }
  }
  /** applyRepeat: copy onto every ticked, matching target, then group the copies when asked */
  applyRepeat(st: Stage): number {
    let copied = 0;
    for (const [t, c] of this.compat) { if (!c.doCopy || !c.isOk) continue; this.copyRuleAreaContents(this.refRA!, t, st, this.options, c); copied++; }
    if (this.options.groupItems) {
      for (const [t, c] of this.compat) {
        if (c.groupable.size < 2) continue;
        let gid = t.sourceType === "group" && t.groupId ? t.groupId : null;
        if (gid && st.node(gid)) st.modify(gid);
        else if (gid && this.scratch.has(gid)) { /* a channel not yet on the board: applySelectionRepeat adds it */ }
        else { pruneExistingGroups(this, st, c.affected); gid = st.add(["group", "", ["uuid", K.newUuid()], ["members"]]); }
        for (const id of c.groupable) stageAddToGroup(st, gid, id);
      }
    }
    return copied;
  }
  /** detachArea */
  private detach(st: Stage, zoneId: string, scratch?: SNode): void { const z = scratch || st.modify(zoneId); if (z) setLink(z, "", DEFAULT_REPEAT_OPTIONS); }
  /** linkAreas: the reference and the targets in one new set, each with its own anchor */
  linkAreasTo(st: Stage, refZoneId: string, targets: RuleArea[]): void {
    const set = K.newUuid(), oldSets = new Set<string>();
    const zoneNode = (a: { zoneId: string | null }): SNode | null => (a.zoneId && this.doc.items.has(a.zoneId) ? st.modify(a.zoneId) : a.zoneId ? st.node(a.zoneId) || this.scratch.get(a.zoneId) || null : null);
    const join = (z: SNode | null, anchor: string): void => { if (!z) return; const l = linkOf(z); if (l.set) oldSets.add(l.set); setLink(z, set, { ...this.options, anchor }); };
    join(zoneNode({ zoneId: refZoneId }), this.options.anchor);
    for (const t of targets) {
      const m = this.compat.get(t)!.matching; let anchor = "";
      if (this.options.anchor && m.size) anchor = anchorPair(m, this.options.anchor)[1].id;
      join(zoneNode(t), anchor);
    }
    this.dropLoneLinks(st, oldSets);
  }
  /** dropLoneLinks: a set left with one area is no set */
  dropLoneLinks(st: Stage, sets: Set<string>): void {
    const members = new Map<string, string[]>();
    for (const it of this.doc.items.values()) { if (it.kind !== "zone") continue; const n = st.node(it.id); if (!n) continue; const s = linkOf(n).set; if (sets.has(s)) members.set(s, (members.get(s) || []).concat(it.id)); }
    for (const [, zs] of members) if (zs.length < 2) this.detach(st, zs[0]);
  }
  /** RepeatLayout( event, zone ): the Repeat dialog's apply for rule areas */
  repeatToRuleAreas(): { changes: PcbChange[]; copied: number } {
    const st = new Stage(this.doc); const copied = this.applyRepeat(st);
    if (this.linkAreas) this.linkAreasTo(st, this.refRA!.zoneId!, [...this.compat].filter(([, c]) => c.doCopy && c.isOk).map(([a]) => a));
    return { changes: st.changes(), copied };
  }
  /** applySelectionRepeat: the channels become groups with their areas, named after the anchor's counterpart */
  applySelectionRepeat(): { changes: PcbChange[]; created: number; refGroup: string } | null {
    const ref = this.refRA!; const channels: RuleArea[] = [ref];
    for (const [a, c] of this.compat) if (c.doCopy && c.isOk) channels.push(a);
    if (channels.length < 2) return null;
    const st = new Stage(this.doc);
    const names = new Set<string>(groups(this.doc).map((g) => K.str(g.node[1])));
    for (const a of channels) {
      const matched = a === ref ? channels[1] : a;
      const [ra, ta] = anchorPair(this.compat.get(matched)!.matching, this.options.anchor);
      const anchor = a === ref ? ra : ta;
      const name = makeUniqueZoneName(`${fpRef(anchor.node)} channel`, (s) => names.has(s)); names.add(name);
      a.group![1] = name; setZoneName(a.zone!, name);
      const sheet = fpSheetname(anchor.node), inSheet = this.queryComponentsInSheet(sheet);
      const whole = inSheet.length === a.components.length && inSheet.every((f) => a.components.includes(f));
      setPlacement(a.zone!, whole ? "sheetname" : "group", whole ? sheet : name);
      st.add(a.zone!); st.add(a.group!);
      stageAddToGroup(st, a.groupId!, a.zoneId!);
      for (const fp of a.components) stageAddToGroup(st, a.groupId!, fp.id);
    }
    for (const it of ref.designBlockItems) if (it.kind !== "footprint") stageAddToGroup(st, ref.groupId!, it.id);
    const found: KItem[] = [];
    if (this.options.copyRouting) { const nets = new Set<string>(); for (const fp of ref.components) for (const p of K.kids(fp.node, "pad")) nets.add(netNameOf(this.doc, p)); found.push(...this.findRepeatRouting(ref, nets, this.options)); }
    if (this.options.copyOtherItems) for (const it of this.findOtherItemsInRuleArea(ref)) if (!found.includes(it)) found.push(it);
    for (const it of found) if (!st.parentOf(it.id) && !ref.designBlockItems.includes(it)) stageAddToGroup(st, ref.groupId!, it.id);
    if (this.linkAreas) this.linkAreasTo(st, ref.zoneId!, channels.filter((a) => a !== ref));
    this.applyRepeat(st);
    return { changes: st.changes(), created: channels.length, refGroup: ref.groupId! };
  }
  /**
   * UpdateRepeatPreview: the copy staged and dropped.  What the copy replaces is hidden; what it makes (and the moved
   * parts) is shown, as items of a scratch document (`nodes`, the brightened ones in `bright`); the moved parts'
   * boxes and their ratsnest at the new spots are what HighlightRepeatAreas draws.
   */
  previewRepeat(): { hidden: Set<string>; nodes: SNode[]; bright: Set<string>; boxes: Map<string, number[]>; ratsnest: [Pt, Pt][] } {
    const saved = new Map([...this.compat].map(([a, c]) => [a, { ...c, affected: new Set(c.affected), groupable: new Set(c.groupable) }]));
    const savedOpts = this.options, savedZones = new Map(this.areas.map((a) => [a, a.zone]));
    this.options = { ...this.options, groupItems: false };
    for (const c of this.compat.values()) { c.affected = new Set(); c.groupable = new Set(); }
    const st = new Stage(this.doc);
    try { this.applyRepeat(st); } finally { this.options = savedOpts; }
    const hidden = new Set<string>(), nodes: SNode[] = [], bright = new Set<string>(), boxes = new Map<string, number[]>(), seen = new Set<string>();
    const show = (id: string, top: boolean): void => {
      const n = st.node(id); if (!n || seen.has(id)) return; seen.add(id);
      if (isGroupish(String(n[0]))) { for (const m of membersOf(n)) show(m, false); return; }
      nodes.push(n); if (top) bright.add(id);
    };
    for (const c of this.compat.values()) { for (const id of c.affected) hidden.add(id); for (const id of c.groupable) show(id, true); }
    // the board as the copy leaves it, for the moved parts' boxes and ratsnest
    const after: BoardDoc = { ...this.doc, items: new Map(this.doc.items) } as BoardDoc;
    const moved: string[] = [];
    for (const c of this.compat.values()) for (const id of c.affected) {
      const it = this.doc.items.get(id); if (!it || it.kind !== "footprint" || moved.includes(id)) continue;
      const n = st.node(id); if (!n) continue;
      const ni = scratchItem(this.doc, n); if (!ni) continue;
      after.items.set(id, ni); moved.push(id); const b = footprintBox(ni); if (b) boxes.set(id, b);
    }
    const ratsnest: [Pt, Pt][] = [];
    if (moved.length) for (const l of ratsnestOf(after)) if (l.ids.some((i) => moved.includes(i))) ratsnest.push([l.a, l.b]);
    this.compat = saved; for (const [a, z] of savedZones) a.zone = z;
    return { hidden, nodes, bright, boxes, ratsnest };
  }

  // ---------------------------------------------------------------- linked layouts
  /** linkedAreasIn: the linked areas a selection stands for (the area, a group holding one, a part of its channel) */
  linkedAreasIn(ids: Iterable<string>): string[] {
    const zones: string[] = [];
    const asLinked = (it: KItem | undefined): boolean => !!it && it.kind === "zone" && isRuleArea(it.node) && !!linkOf(it.node).set;
    const addFrom = (g: KItem): boolean => { let f = false; for (const m of membersOf(g.node)) { const it = this.doc.items.get(m); if (asLinked(it)) { if (!zones.includes(m)) zones.push(m); f = true; } } return f; };
    for (const id of ids) {
      const it = this.doc.items.get(id); if (!it) continue;
      if (asLinked(it)) { if (!zones.includes(id)) zones.push(id); continue; }
      let g: KItem | null = it.kind === "group" ? it : this.parentGroupOf(id);
      while (g && !addFrom(g)) g = this.parentGroupOf(g.id);
    }
    return zones;
  }
  /** ChannelZone: the placement area that makes a group a repeated channel */
  channelZone(g: KItem): string | null { for (const m of membersOf(g.node)) { const it = this.doc.items.get(m); if (it && it.kind === "zone" && isPlacementArea(it.node)) return m; } return null; }
  /** UnlinkAreas */
  unlinkAreas(zoneIds: string[]): PcbChange[] {
    const st = new Stage(this.doc), old = new Set<string>();
    for (const id of zoneIds) { const n = st.node(id); if (n && linkOf(n).set) old.add(linkOf(n).set); this.detach(st, id); }
    this.dropLoneLinks(st, old);
    return st.changes();
  }
  /** UpdateLinkedLayouts: the source copied onto the other areas of its link set */
  async updateLinkedLayouts(sourceId: string, progress?: RulesProgress): Promise<{ changes: PcbChange[]; warning: string | null; copied: number }> {
    this.reset(); this.findExistingRuleAreas();
    let ref: RuleArea | null = null; const linked: RuleArea[] = []; const use = new Map<KItem, number>();
    for (const a of this.areas) { if (!linkOf(a.zone!).set) continue; linked.push(a); if (a.zoneId === sourceId) ref = a; for (const fp of a.components) use.set(fp, (use.get(fp) || 0) + 1); }
    if (!ref) return { changes: [], warning: null, copied: 0 };
    const sharesParts = (a: RuleArea): boolean => a.components.some((f) => (use.get(f) || 0) > 1);
    const overlapsOther = (a: RuleArea, o: Pt[]): boolean => linked.some((b) => b !== a && outlinesOverlap(o, outline0(b.zone!)));
    const refGrouped = !!this.linkedChannelGroup(ref);
    if (sharesParts(ref) || (!refGrouped && overlapsOther(ref, outline0(ref.zone!)))) return { changes: [], warning: `'${ref.ruleName}' overlaps another linked Rule Area.`, copied: 0 };
    const problems: string[] = [], accepted: Pt[][] = [];
    this.refRA = ref; this.options = { ...linkOf(ref.zone!).opts }; this.compat = new Map();
    const set = linkOf(ref.zone!).set;
    const targets = linked.filter((t) => t !== ref && linkOf(t.zone!).set === set);
    const jobs = targets.map((t) => { const c = newCompat(); this.compat.set(t, c); return { ref: ref!, target: t, compat: c }; });
    if (!(await this.resolveTopologies("Updating linked layouts...", jobs, progress))) { this.compat = new Map(); return { changes: [], warning: null, copied: 0 }; }
    for (const t of targets) {
      const c = this.compat.get(t)!;
      if (!c.isOk) { problems.push(`'${t.ruleName}': ${c.errorMsg}`); continue; }
      const rep = repeatedOutline(ref, t, this.options.anchor, c.matching).outline;
      const overAccepted = accepted.some((o) => outlinesOverlap(rep, o));
      const scoped = refGrouped && !!this.linkedChannelGroup(t);
      if (sharesParts(t) || (!scoped && (overAccepted || overlapsOther(t, outline0(t.zone!)) || overlapsOther(t, rep)))) { problems.push(`'${t.ruleName}' overlaps another linked Rule Area.`); continue; }
      c.doCopy = true; accepted.push(rep);
    }
    const st = new Stage(this.doc); const copied = this.applyRepeat(st);
    return { changes: copied ? st.changes() : [], warning: problems.length ? `Some linked Rule Areas were not updated. ${problems.join("\n")}` : null, copied };
  }

  // ---------------------------------------------------------------- Apply Design Block Layout
  /** applyOneGroup of PCB_CONTROL::ApplyDesignBlockLayout: the block's board repeated onto the group, into st */
  applyDesignBlockToGroup(st: Stage, group: KItem, blockText: string): { ok: boolean; error?: string; netless?: boolean } {
    let bdoc: BoardDoc;
    try { bdoc = K.parseDoc(blockText, "kicad_pcb") as BoardDoc; } catch { return { ok: false, error: "the design block's board file could not be read" }; }
    if (!bdoc || !bdoc.items) return { ok: false, error: "the design block's board file could not be read" };
    const side = blockSide(bdoc);
    const items = [...bdoc.items.values()];
    if (!items.length) return { ok: false, error: "the design block's board layout is empty" };
    const comps = items.filter((it) => it.kind === "footprint");
    const netless = !comps.length && items.some((it) => isConnected(bdoc, it.node));
    const box = (its: KItem[]): Pt[] => buildRAOutlineLoose(its.map((it) => it.bbox).filter(Boolean) as number[][]);
    const dz = placementAreaNode(box(items)); setZoneName(dz, kidStr(group.node, "lib_id"));
    const dbRA = this.area({ sourceType: "design_block", generateEnabled: true, designBlockItems: items, components: comps, zone: dz, center: centreOf(outline0(dz)), side });
    const members = membersOf(group.node).map((id) => this.doc.items.get(id)).filter(Boolean) as KItem[];
    if (!members.length) return { ok: false, error: "the group has no items" };
    const tz = placementAreaNode(box(members)); setZoneName(tz, K.str(group.node[1]) || "(unnamed group)");
    const destRA = this.area({ sourceType: "group", components: members.filter((m) => m.kind === "footprint"), group: group.node, groupId: group.id, zone: tz, center: centreOf(outline0(tz)) });
    const opts: RepeatOptions = { ...DEFAULT_REPEAT_OPTIONS };
    const saved = this.areas; this.areas = [];
    try {
      const compat = newCompat();
      if (!this.resolveConnectionTopology(dbRA, destRA, compat)) return { ok: false, error: compat.mismatchReasons.length ? compat.mismatchReasons.join("\n") : compat.errorMsg };
      if (!opts.anchor && compat.matching.size) opts.anchor = firstPair(compat.matching)[0].id;
      this.copyRuleAreaContents(dbRA, destRA, st, opts, compat);
      st.modify(group.id);
      // EDA_GROUP::AddItem: an item already in the group stays; another leaves the group it was in
      for (const id of compat.groupable) { if (membersOf(st.node(group.id)!).includes(id)) continue; const old = st.parentOf(id); if (old) st.removeMember(old, id); st.addMember(group.id, id); }
    } finally { this.areas = saved; }
    return { ok: true, netless };
  }
}

/** pruneExistingGroups: the items leave the board's groups; a group left with fewer than two goes */
function pruneExistingGroups(mc: Multichannel, st: Stage, ids: Set<string>): void {
  for (const g of groups(mc.doc)) {
    const n = st.node(g.id); if (!n) continue;
    const prune = membersOf(n).filter((m) => ids.has(m)); if (!prune.length) continue;
    for (const m of prune) st.removeMember(g.id, m);
    if (membersOf(st.node(g.id)!).length < 2) st.remove(g.id);
  }
}
/** The generateBoundingBox of ApplyDesignBlockLayout: every item's GetBoundingBox grown by 0.1 mm, hull, rectified. */
function buildRAOutlineLoose(boxes: number[][]): Pt[] { return buildRAOutline(boxes, 0.1); }
function freshUuid(n: SNode): void { const u = K.kid(n, "uuid") || K.kid(n, "tstamp"); if (u) u[1] = K.newUuid(); else n.push(["uuid", K.newUuid()]); }
function setNodeNet(doc: BoardDoc, n: SNode, name: string): void {
  let code = 0; if (name && doc.nets) for (const [c, nm] of doc.nets) if (String(nm) === name) { code = c; break; }
  const nn = netNode(doc, { code: name ? (code || -1) : 0, name });
  const i = n.findIndex((c, k) => k > 0 && isList(c) && c[0] === "net");
  if (i > 0) n[i] = nn; else if (name) { const l = n.findIndex((c, k) => k > 0 && isList(c) && (c[0] === "uuid" || c[0] === "layer" || c[0] === "layers")); n.splice(l > 0 ? l : n.length, 0, nn); }
  const nm = K.kid(n, "net_name"); if (nm) nm[1] = name;
}
const pointInPoly = (P: Pt[], p: Pt): boolean => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) c = !c; } return c; };
/** refFP->GetEffectiveShape( layer )->Collide( refPoly ): the footprint's box touches the reference outline */
function footprintCollides(fp: KItem, poly: Pt[]): boolean {
  const b = footprintBox(fp); if (!b || poly.length < 3) return false;
  const rect: Pt[] = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
  return rect.some((p) => pointInPoly(poly, p)) || poly.some((p) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]) || outlinesOverlap(rect, poly);
}
/** getParentSheetPaths: "/A/B/C/" gives "/A/" and "/A/B/" */
export function parentSheetPaths(sheet: string): string[] {
  const segs = sheet.split("/").filter(Boolean); const out: string[] = []; let prefix = "/";
  for (let i = 0; i + 1 < segs.length; i++) { prefix += segs[i] + "/"; out.push(prefix); }
  return out;
}
/** firstPair: the matched pair whose reference part sorts first (StrNumCmp, then position, then uuid) */
export function firstPair(m: Map<KItem, KItem>): [KItem, KItem] {
  let best: [KItem, KItem] | null = null;
  for (const p of m) {
    if (!best) { best = p; continue; }
    const a = p[0], b = best[0]; const c = strNumCmp(fpRef(a.node), fpRef(b.node));
    if (c) { if (c < 0) best = p; continue; }
    const [ax, ay] = K.atOf(a.node), [bx, by] = K.atOf(b.node);
    if (ax < bx || (ax === bx && (ay < by || (ay === by && a.id < b.id)))) best = p;
  }
  return best!;
}
/** anchorPair: the pair holding the anchor, else the first pair */
export function anchorPair(m: Map<KItem, KItem>, anchor: string): [KItem, KItem] { for (const p of m) if (p[0].id === anchor) return p; return firstPair(m); }
/** repeatedOutline: the outline the target takes on, and the transform (rotation about the origin, then displacement) */
export function repeatedOutline(ref: RuleArea, target: RuleArea, anchor: string, m: Map<KItem, KItem>): { outline: Pt[]; disp: Pt; rot: number } {
  let disp: Pt = [target.center[0] - ref.center[0], target.center[1] - ref.center[1]], rot = 0;
  if (anchor && m.size) {
    const [ra, ta] = anchorPair(m, anchor); const [rx, ry, rr] = K.atOf(ra.node), [tx, ty, tr] = K.atOf(ta.node);
    rot = tr - rr; const [ox, oy] = rotator(rot)(rx, ry); disp = [tx - ox, ty - oy];
  }
  const R = rotator(rot);
  const outline = outline0(ref.zone!).map(([x, y]) => { const [a, b] = R(x, y); return [r6(a + disp[0]), r6(b + disp[1])] as Pt; });
  return { outline, disp: [r6(disp[0]), r6(disp[1])], rot };
}
/** matchSheetInstances: repeated sheets give every instance the same symbol uuids under its own instance path */
function matchSheetInstances(doc: BoardDoc, ref: KItem[]): Map<KItem, KItem>[] {
  let prefix: string[] | null = null;
  for (const fp of ref) {
    const p = fpPath(fp.node); if (p.length < 2) return [];
    if (!prefix) prefix = p.slice(0, -1);
    const depth = Math.min(prefix.length, p.length - 1); let i = 0; while (i < depth && prefix[i] === p[i]) i++;
    prefix.length = i;
  }
  if (!prefix || !prefix.length) return [];
  const depth = prefix.length; const rest = (p: string[]): string => p.slice(depth).join("/");
  const byRest = new Map<string, KItem>(); for (const fp of ref) byRest.set(rest(fpPath(fp.node)), fp);
  const inst = new Map<string, Map<KItem, KItem>>();
  for (const fp of footprints(doc)) {
    const p = fpPath(fp.node); if (ref.includes(fp) || p.length <= depth) continue;
    const pre = p.slice(0, depth); if (pre.every((x, i) => x === prefix![i])) continue;
    const r = byRest.get(rest(p)); if (r && fpid(r.node) === fpid(fp.node)) { const k = pre.join("/"); if (!inst.has(k)) inst.set(k, new Map()); inst.get(k)!.set(r, fp); }
  }
  return [...inst.keys()].sort().map((k) => inst.get(k)!);
}
/** FLAT_MATCHER: the reference parts, in growth order from the seed, paired with parts on the same mirrored nets */
class FlatMatcher {
  map = new Map<KItem, KItem>(); used = new Set<KItem>(); netMap = new Map<string, string>(); taken = new Set<string>(); budget = 10000;
  constructor(private doc: BoardDoc, private owners: Map<string, KItem[]>, private internal: Set<string>, private leaves: Set<KItem>, private claimed: Set<KItem>, private order: KItem[], private loose: boolean) {}
  bind(ref: KItem, tgt: KItem, added: string[]): boolean {
    for (const pad of K.kids(ref.node, "pad")) {
      const net = netNameOf(this.doc, pad); if (!this.internal.has(net)) continue;
      const peer = K.kids(tgt.node, "pad").find((p) => K.str(p[1]) === K.str(pad[1])); if (!peer) return false;
      const pn = netNameOf(this.doc, peer);
      if (this.netMap.has(net)) { if (this.netMap.get(net) !== pn) return false; }
      else { if (!pn || this.taken.has(pn)) return false; this.netMap.set(net, pn); this.taken.add(pn); added.push(net); }
    }
    return true;
  }
  pair(i: number, choice: KItem): boolean {
    const ref = this.order[i]; const added: string[] = [];
    if (this.bind(ref, choice, added)) {
      this.map.set(ref, choice); this.used.add(choice);
      if (this.extend(i + 1)) return true;
      this.map.delete(ref); this.used.delete(choice);
    }
    for (const n of added) { this.taken.delete(this.netMap.get(n)!); this.netMap.delete(n); }
    return false;
  }
  extend(i: number): boolean {
    if (i === this.order.length) return true;
    if (--this.budget < 0) return false;
    const ref = this.order[i];
    const mapped = K.kids(ref.node, "pad").find((p) => this.netMap.has(netNameOf(this.doc, p)));
    if (mapped) {
      for (const fp of this.owners.get(this.netMap.get(netNameOf(this.doc, mapped))!) || []) {
        if (!this.claimed.has(fp) && !this.used.has(fp) && fpid(fp.node) === fpid(ref.node) && this.pair(i, fp)) return true;
        if (this.budget < 0) return false;
      }
    }
    return this.loose && this.leaves.has(ref) && this.extend(i + 1);
  }
}

/**
 * The placement of a matched footprint (copyRuleAreaContents, m_copyPlacement): the target takes the reference's side,
 * orientation and position through the transform; its fields and texts take the reference's layout, its 3D models
 * the reference's, and each pad the reference pad's settings (PAD::ImportSettingsFrom), keeping its own number, net
 * and position.
 */
export function placeLike(doc: BoardDoc, target: SNode, ref: SNode, rot: number, disp: Pt): void {
  const side = (n: SNode): string => itemLayer(n) || "F.Cu";
  if (side(target) !== side(ref)) { const [x, y] = K.atOf(target); flipNode(target, x, doc, y, "lr"); }
  const [, , ta] = K.atOf(target), [rx, ry, ra] = K.atOf(ref);
  if (ta !== ra) rotateFootprintNode(target, ra - ta);
  const [tx, ty] = K.atOf(target); translateNode(target, rx - tx, ry - ty);
  if (rot) rotateNode(target, 0, 0, rot);
  translateNode(target, disp[0], disp[1]);
  const fa = K.atOf(target)[2];
  // a child's (at) is local with an absolute angle: the reference's local spot, its angle turned by rot
  const layout = (dst: SNode, src: SNode): void => {
    const sAt = K.kid(src, "at"), dAt = K.kid(dst, "at");
    if (sAt && dAt) { dAt.splice(1, dAt.length - 1, ...sAt.slice(1)); if (rot) { const a = r6(((K.num(sAt[3]) + rot) % 360 + 360) % 360); if (dAt.length >= 4) dAt[3] = a; else if (a) dAt.push(a); } }
    for (const k of ["layer", "hide", "effects", "unlocked"]) {
      const s = K.kid(src, k), i = dst.findIndex((c, j) => j > 0 && isList(c) && c[0] === k);
      if (s) { if (i > 0) dst[i] = clone(s); else dst.push(clone(s)); } else if (i > 0) dst.splice(i, 1);
    }
  };
  for (const rp of K.kids(ref, "property")) { const tp = K.kids(target, "property").find((p) => K.str(p[1]) === K.str(rp[1])); if (tp) layout(tp, rp); }
  const used = new Set<SNode>();
  for (const rt of K.kids(ref, "fp_text").filter((t) => K.str(t[1]) === "user")) {
    let pick: SNode | null = null;
    for (const c of K.kids(target, "fp_text")) { if (K.str(c[1]) !== "user" || used.has(c) || K.str(c[2]) !== K.str(rt[2])) continue; pick = c; if (itemLayer(c) === itemLayer(rt)) break; }
    if (!pick) continue; used.add(pick); layout(pick, rt);
  }
  for (let i = target.length - 1; i > 0; i--) if (isList(target[i]) && (target[i] as SNode)[0] === "model") target.splice(i, 1);
  for (const m of K.kids(ref, "model")) target.push(clone(m));
  const consumed = new Set<SNode>();
  for (const rp of K.kids(ref, "pad")) {
    const ti = target.findIndex((c, j) => j > 0 && isList(c) && c[0] === "pad" && !consumed.has(c as SNode) && K.str((c as SNode)[1]) === K.str(rp[1])); if (ti < 0) continue;
    const tp = target[ti] as SNode; const np = clone(rp); consumed.add(np);
    np[1] = tp[1];
    const keep = (k: string): void => { const i = np.findIndex((c, j) => j > 0 && isList(c) && c[0] === k); const t = K.kid(tp, k); if (t) { if (i > 0) np[i] = clone(t); else np.push(clone(t)); } else if (i > 0) np.splice(i, 1); };
    for (const k of ["net", "pinfunction", "pintype", "uuid", "die_length", "die_delay"]) keep(k);
    const tAt = K.kid(tp, "at"), nAt = K.kid(np, "at");
    if (tAt && nAt) { const rel = K.num(rp.length && K.kid(rp, "at") ? K.kid(rp, "at")![3] : 0) - ra; const a = r6(((rel + fa) % 360 + 360) % 360); nAt.splice(1, nAt.length - 1, tAt[1], tAt[2]); if (a) nAt.push(a > 180 ? r6(a - 360) : a); }
    target[ti] = np;
  }
}
