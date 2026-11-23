// pcb-tools/msgpanel.ts — the message panel (EDA_MSG_PANEL) and the routed length.
import type { BoardDoc, DesignSettings, DesignSource, NetRef, Netlist, PadInfo, Pt, Route } from "./types";
import type { RouterSettings } from "./router-settings";

/** One line of the message panel: a title over its value. */
export interface MsgItem { title: string; value: string }
/** msgPanelInfo's options: the design settings, the user's units, the route in flight and its router settings, the netlist. */
export interface MsgPanelOpts { settings?: DesignSettings; units?: string; route?: Route | null; routerSettings?: RouterSettings; nl?: Netlist; net?: string; ellipsize?: (s: string) => string; toDisplay?: (p: Pt) => Pt }
import { connectedRun } from "./connected";
import { ellipseLength } from "../../canvas/sexpr";
import { resolve } from "./drc-rules";
import type { RuleItem } from "./dru";
import { copperOf } from "./dialogs";
import { dimRead, dimUnits, dimUpdate, dimValueString, type DimModel } from "./dimensions";
import { arcLength, padCopperLayers, shapeGap, shareLayer } from "./distances";
import { designSettings, netClearance, netclassName, netclassOf } from "./drc";
import { evalRuleConstraint } from "./dru";
import { routedRuleItem } from "./rule-resolver";
import { viaNow } from "./edit-commands";
import { isLocked } from "./groups";
import { netlistCached } from "./app-state";
import { conductors, netTable, netlist, ratsnest } from "./netlist";
import { hasNet, netOf } from "./nets";
import { zoneLayers } from "./nodes";
import { padsOf } from "./route-geom";
import { MODE_NAMES, cornerStyleName } from "./router-settings";
import { K, S } from "./state";
import { layerOf, norm180, pt, r6, widthOf } from "./util";

// ---------------------------------------------------------------- message panel (EDA_MSG_PANEL)
// The strip under the canvas: GetMsgPanelInfo of the one selected item (PCB_TRACK / PCB_VIA / PAD / FOOTPRINT / ZONE /
// PCB_SHAPE), the board summary (BOARD::GetMsgPanelInfo) otherwise, the router's (ROUTER_TOOL::UpdateMessagePanel)
// while a track is being routed.  Values follow MessageTextFromValue: "%.4f mm", "%.2f mils", "%.4f in"; areas short.
export function msgValue(v: number, units: string) { const u = units || "mm"; return u === "mil" ? (v / 0.0254).toFixed(2) + " mils" : u === "in" ? (v / 25.4).toFixed(4) + " in" : v.toFixed(4) + " mm"; }
export function msgArea(a: number, units: string) { const u = units || "mm"; return u === "mil" ? (a / 0.0254 / 0.0254).toFixed(0) + " mils²" : u === "in" ? (a / 25.4 / 25.4).toFixed(3) + " in²" : a.toFixed(3) + " mm²"; }
/** UnescapeString: the {slash}-style escapes KiCad keeps in net names, shown as the characters. */
export const UNESC: Record<string, string> = { slash: "/", backslash: "\\", lt: "<", gt: ">", colon: ":", dblquote: '"', quote: "'", space: " ", tab: "\t", return: "\n", brace: "{", bar: "|" };
export const unescapeName = (t: string | null | undefined) => String(t || "").replace(/\{(slash|backslash|lt|gt|colon|dblquote|quote|space|tab|return|brace|bar)\}/g, (_, k: string) => UNESC[k]);
export const msgAngle = (v: number) => String(+(+v).toPrecision(4));
/** printf "%g": six significant digits, trailing zeroes dropped. */
export const msgG = (v: number) => String(+(+v).toPrecision(6));
/** KIUI::EllipsizeMenuText: unescaped, on one line, 34 characters and "..." past 36. */
export function ellipsizeMenuText(t: string | null | undefined) { const msg = unescapeName(t).replace(/[\n\r\t]/g, " "); return msg.length > 36 ? msg.slice(0, 34) + "..." : msg; }
/** The front of KIUI::EllipsizeStatusText: unescaped, on one line (the caller cuts it to the panel's width). */
export const statusText = (t: string | null | undefined) => unescapeName(t).replace(/[\n\r\t]/g, " ");
/** ZONE::LayerMaskDescribe's list: "A", "A and B", "A, B and C", "A, B and N more". */
export function layerListText(names: string[]) { return names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]}` : names.length > 3 ? `${names[0]}, ${names[1]} and ${names.length - 2} more` : ""; }
/** ZONE::IsTeardropArea: (attr (teardrop (type …))). */
export function isTeardropZone(n: SNode) { const a = K.kid(n, "attr"); return !!a && !!K.kid(a, "teardrop"); }
/** ZONE::GetFriendlyName. */
export function zoneFriendlyName(n: SNode) {
  if (K.kid(n, "keepout")) return "Rule Area"; if (isTeardropZone(n)) return "Teardrop Area";
  return zoneLayers(n).some((l) => /\.Cu$/.test(l)) ? "Copper Zone" : "Non-copper Zone";
}
/** STROKE_PARAMS::GetMsgPanelInfo's style name (lineTypeNames; "Default" for the default style). */
export const LINE_STYLE_NAMES: Record<string, string> = { solid: "Solid", dash: "Dashed", dot: "Dotted", dash_dot: "Dash-Dot", dash_dot_dot: "Dash-Dot-Dot" };
/** EDA_TEXT::GetEffectiveTextPenWidth of a board text's (effects (font …)), mm; 0 thickness is the automatic pen. */
export function textPenWidth(font: SNode | null) {
  const sz = font && K.kid(font, "size"), th = font && K.kid(font, "thickness"); const h = sz ? K.num(sz[1]) : 1, w = sz ? K.num(sz.length > 2 ? sz[2] : sz[1]) : 1;
  const bold = !!font && (font.includes("bold") || (!!K.kid(font, "bold") && K.str(K.kid(font, "bold")![1]) !== "no")), face = !!font && !!K.kid(font, "face");
  let pen = th ? K.num(th[1]) : 0;
  if (pen <= 1e-6) pen = bold ? Math.round(w * 1e6 / 5) / 1e6 : Math.round(w * 1e6 / 8) / 1e6; else if (bold && !face) pen = Math.round(pen * 1.6 * 1e6) / 1e6;
  return Math.min(pen, Math.round(Math.min(Math.abs(w), Math.abs(h)) * 0.25 * 1e6) / 1e6);
}
/** BOARD::GetLayerName: the user name the board gives a layer, else its canonical one. */
export function boardLayerName(doc: BoardDoc, name: string) { const l = doc && doc.layers && doc.layers.get ? doc.layers.get(name) : null; return l && l.userName ? l.userName : name; }
/** BOARD_ITEM::LayerMaskDescribe for a pad: all copper layers, else the first copper / technical / any layer, "and others". */
export function padLayerDescribe(doc: BoardDoc, p: PadInfo) {
  const copper = copperOf(doc), cu = padCopperLayers(p, copper);
  if (cu.size === copper.length) return "all copper layers";
  const tech = p.layers.filter((l) => !/\.Cu$/.test(l) && l !== "*.Cu");
  for (const set of [Array.from(cu), tech, p.layers]) if (set.length) return boardLayerName(doc, set[0].replace(/^\*\./, "F.")) + (set.length > 1 ? " and others" : "");
  return "no layers";
}
/** Clearance and its source as the DRC engine resolves it for an item on `net` (netclass rule, or the board minimum). */
export function msgClearance(s: DesignSettings, net: string) {
  const nc = netClearance(s, net), min = s.minClearance || 0;
  return nc >= min ? { v: nc, from: `netclass '${netclassName(s, net)}'` } : { v: min, from: "board setup constraints" };
}
/** BOARD::GetTrackLength: the summed length of the track run the item belongs to. */
export function routedLength(doc: BoardDoc, id: string) {
  let len = 0;
  for (const rid of connectedRun(doc, [id])) {
    const it = doc.items.get(rid); if (!it) continue;
    if (it.kind === "segment") { const a = pt(it.node, "start"), b = pt(it.node, "end"); if (a && b) len += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    else if (it.kind === "arc") { const a = pt(it.node, "start"), m = pt(it.node, "mid"), b = pt(it.node, "end"); const arc = a && m && b && K.arcFrom3(a, m, b); len += arc ? arcLength(arc) : (a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0); }
  }
  return len;
}
/** NETCLASS::GetHumanReadableName's join, used for component classes too: "A", "A and B", "A, B and C", "A, B and N more". */
export function humanList(names: string[]) {
  if (names.length <= 1) return names[0] || "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
/** GetArcToSegmentCount for a full circle, rounded up to a multiple of 8 (TransformCircleToPolygon / TransformOvalToPolygon); mm. */
export function circleSegCount(radius: number, error: number) {
  const r = Math.max(1, Math.round(radius * 1e6)), e = Math.max(1, Math.round(error * 1e6));
  const inc = Math.min(360 / 8, 180 / Math.PI * Math.acos(1 - e / r) * 2);
  const n = Math.max(Math.round(360 / inc), 2);
  return Math.floor((n + 7) / 8) * 8;
}
/** The area of TransformOvalToPolygon( …, ERROR_INSIDE ) for a segment `len` long and `w` wide: the body and two half polygons. */
export function ovalPolygonArea(len: number, w: number, error: number) {
  const r = Math.floor(Math.round(w * 1e6) / 2) / 1e6, n = circleSegCount(r, error), d = 2 * Math.PI / n;
  return len * 2 * r + r * r * (2 * Math.sin(d / 2) + (n / 2 - 1) * Math.sin(d));
}
/** The area of TransformCircleToPolygon( …, ERROR_INSIDE ): a regular polygon inscribed in the circle. */
export function circlePolygonArea(radius: number, error: number) { const n = circleSegCount(radius, error); return n * radius * radius * Math.sin(2 * Math.PI / n) / 2; }
/** PAD::GetEffectivePolygon's area for the simple shapes (ARC_HIGH_DEF, ERROR_INSIDE): circle, oval, rectangle, rounded rectangle, trapezoid. */
export function padPolygonArea(p: PadInfo) {
  const ERR = 0.005, w = p.w, h = p.h;
  if (p.shape === "circle") return circlePolygonArea(w / 2, ERR);
  if (p.shape === "oval") return ovalPolygonArea(Math.abs(w - h), Math.min(w, h), ERR);
  if (p.shape === "roundrect") {
    const rr = K.kid(p.node, "roundrect_rratio"); const r = Math.min(w, h) * (rr ? K.num(rr[1]) : 0.25);
    return w * h - 4 * r * r + circlePolygonArea(r, ERR);   // the corners together are one inscribed polygon
  }
  if (p.shape === "trapezoid") return w * h;   // the deltas shift opposite corners equally: the area is the rectangle's
  return w * h;
}
/** The pad's shape and size on each unique layer of its padstack (PADSTACK::ForEachUniqueLayer). */
export function padstackLayers(p: PadInfo): { shape: string; w: number; h: number }[] {
  const out = [{ shape: p.shape, w: p.w, h: p.h }]; const ps = K.kid(p.node, "padstack"); const mode = ps && K.kid(ps, "mode");
  if (!ps || !mode || K.str(mode[1]) === "normal") return out;
  for (const l of K.kids(ps, "layer")) { const sh = K.kid(l, "shape"), sz = K.kid(l, "size"); out.push({ shape: sh ? K.str(sh[1]) : p.shape, w: sz ? K.num(sz[1]) : p.w, h: sz ? K.num(sz.length > 2 ? sz[2] : sz[1]) : p.h }); }
  return out;
}
/**
 * BOARD::GetTrackLength: the run's summed length and the pad-to-die length of the pads its ends land on
 * (a pad counts once: GetTrackLength keeps the pads it has met).
 */
export function trackRunLength(doc: BoardDoc, id: string) {
  const len = routedLength(doc, id); let padToDie = 0; const seen = new Set<SNode>();
  const ends: { p: Pt; layer: string }[] = [];
  for (const rid of connectedRun(doc, [id])) { const it = doc.items.get(rid); if (!it || (it.kind !== "segment" && it.kind !== "arc")) continue; const a = pt(it.node, "start"), b = pt(it.node, "end"); const l = layerOf(it.node); if (a) ends.push({ p: a, layer: l }); if (b) ends.push({ p: b, layer: l }); }
  if (ends.length) {
    const copper = copperOf(doc);
    for (const fp of doc.items.values()) {
      if (fp.kind !== "footprint") continue;
      for (const p of padsOf(fp)) {
        const dl = K.kid(p.node, "die_length"); if (!dl || !K.num(dl[1]) || seen.has(p.node)) continue;
        const cu = padCopperLayers(p, copper);
        if (ends.some((e) => cu.has(e.layer) && padHit(p, e.p))) { seen.add(p.node); padToDie += K.num(dl[1]); }
      }
    }
  }
  return { len, padToDie };
}
/** PAD::HitTest for a track end: inside the pad's box turned to its angle (the anchor region the connectivity uses). */
function padHit(p: PadInfo, q: Pt) {
  const a = -(p.rot || 0) * Math.PI / 180, dx = q[0] - p.x, dy = q[1] - p.y; const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
  if (p.shape === "circle") return Math.hypot(lx, ly) <= p.w / 2 + 1e-6;
  return Math.abs(lx) <= p.w / 2 + 1e-6 && Math.abs(ly) <= p.h / 2 + 1e-6;
}
/** EDA_SHAPE::getFriendlyName */
export const SHAPE_NAMES: Record<string, string> = { line: "Segment", rect: "Rectangle", circle: "Circle", arc: "Arc", poly: "Polygon", curve: "Curve", ellipse: "Ellipse", ellipse_arc: "Elliptical Arc" };
/** BOARD_CONNECTED_ITEM::GetNetnameMsg */
export const netnameMsg = (net: NetRef) => (net && net.name ? `[${unescapeName(net.name)}]` : "[<no net>]");
/**
 * How pcbnew names an item in the Clarify Selection popup and elsewhere (GetItemDescription): "Track [VCC] on B.Cu,
 * length 0.6400 mm", "Via [GND] on F.Cu - B.Cu", "PTH pad 2 [VCC] of R10", "Footprint R10", "Zone [GND] on F.Cu, priority 0".
 * `id` may name a pad as "footprintId#padIndex".
 */
export function itemDescription(doc: BoardDoc, id: string, units: string) {
  const V = (v: number) => msgValue(v, units), L = (l: string) => boardLayerName(doc, l);
  const fi = String(id).indexOf("@field:");
  if (fi > 0) {
    // PCB_FIELD::GetItemDescription( aFull = false ): the field's text through KIUI::EllipsizeMenuText
    const fp = doc.items.get(String(id).slice(0, fi)); if (!fp) return "";
    const name = String(id).slice(fi + 7), ref = fp.ref || "";
    const prop = (fp.node as unknown[]).find((c) => Array.isArray(c) && c[0] === "property" && String(c[1]) === name) as unknown[] | undefined;
    const raw = unescapeName(prop ? String(prop[2] ?? "") : name === "Value" ? fp.value || "" : "").replace(/[\n\r\t]/g, " ");
    const content = raw.length > 36 ? raw.slice(0, 34) + "..." : raw;
    if (name === "Reference") return `Reference field of ${ref}`;
    if (name === "Value" || name === "Footprint" || name === "Datasheet") return `${name} field of ${ref} (${content})`;
    return name ? `${name} field of ${ref} (${content})` : `Field of ${ref} (${content})`;
  }
  const hash = String(id).indexOf("#"), it = doc.items.get(hash > 0 ? String(id).slice(0, hash) : id); if (!it) return "";
  const n = it.node;
  if (it.kind === "pad") {   // PAD::GetItemDescription without a parent footprint (the Footprint Editor's board is an FPHOLDER)
    const type = K.str(n[2]), num = K.str(n[1]);
    if (type === "np_thru_hole") return "NPTH pad";
    if (type === "smd" || type === "connect") {
      const ls = K.kid(n, "layers"); const pl = { layers: ls ? ls.slice(1).map(K.str) : [] } as unknown as PadInfo;
      return num ? `Pad ${num} on ${padLayerDescribe(doc, pl)}` : `Pad on ${padLayerDescribe(doc, pl)}`;
    }
    return num ? `PTH pad ${num}` : "PTH pad";
  }
  if (hash > 0 && it.kind === "footprint") {
    const p = padsOf(it)[+String(id).slice(hash + 1)]; if (!p) return "";
    const ref = it.ref || "";
    if (p.type === "np_thru_hole") return `NPTH pad of ${ref}`;
    const num = p.number ? p.number + " " : "";
    if (p.type === "smd" || p.type === "connect") return `Pad ${num}${netnameMsg(p.net)} of ${ref} on ${padLayerDescribe(doc, p)}`;
    return `PTH pad ${num}${netnameMsg(p.net)} of ${ref}`;
  }
  if (it.kind === "segment" || it.kind === "arc") {
    const a = pt(n, "start"), b = pt(n, "end"); let len = a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
    if (it.kind === "arc") { const m = pt(n, "mid"); const arc = a && m && b && K.arcFrom3(a, m, b); if (arc) len = arcLength(arc); }
    return `${it.kind === "arc" ? "Track (arc)" : "Track"} ${netnameMsg(netOf(n))} on ${L(layerOf(n))}, length ${V(len)}`;
  }
  if (it.kind === "via") {
    const ls = K.kid(n, "layers"); const pair = ls ? ls.slice(1).map(K.str) : ["F.Cu", "B.Cu"];
    const kind = n.includes("micro") ? "Micro via" : n.includes("blind") ? "Blind via" : n.includes("buried") ? "Buried via" : "Via";
    return `${kind} ${netnameMsg(netOf(n))} on ${L(pair[0] || "F.Cu")} - ${L(pair[pair.length - 1] || "B.Cu")}`;
  }
  if (it.kind === "footprint") return `Footprint ${it.ref || "<no reference designator>"}`;
  if (it.kind === "zone") {
    const names = zoneLayers(n).map(L); const keep = K.kid(n, "keepout"); const nm = K.kid(n, "name"); const zn = nm ? K.str(nm[1]) : "";
    const ld = names.length === 1 ? `on ${names[0]}` : names.length === 2 ? `on ${names[0]} and ${names[1]}` : names.length === 3 ? `on ${names[0]}, ${names[1]} and ${names[2]}` : names.length > 3 ? `on ${names[0]}, ${names[1]} and ${names.length - 2} more` : "";
    if (keep) return zn ? `Rule area '${zn}' ${ld}` : `Rule Area ${ld}`;
    if (isTeardropZone(n)) return `Teardrop ${netnameMsg(netOf(n))} ${ld}`;
    const pr = K.kid(n, "priority"); const prio = pr ? K.num(pr[1]) : 0;
    return zn ? `Zone '${zn}' ${netnameMsg(netOf(n))} ${ld}, priority ${prio}` : `Zone ${netnameMsg(netOf(n))} ${ld}, priority ${prio}`;
  }
  if (it.kind === "gr_text") return `PCB text '${ellipsizeMenuText(K.str(n[1]))}' on ${L(layerOf(n))}`;
  if (it.kind === "gr_text_box") return `PCB text box '${ellipsizeMenuText(K.str(n[1]))}' on ${L(layerOf(n))}`;
  if (it.kind === "dimension") { const gt = K.kid(n, "gr_text"); return `Dimension '${ellipsizeMenuText(gt ? K.str(gt[1]) : "")}' on ${L(layerOf(n))}`; }
  if (it.kind === "group") { const nm = typeof n[1] === "string" ? K.str(n[1]) : "", cnt = K.groupMemberIds(n).length; return nm ? `Group '${nm}', ${cnt} members` : `Unnamed Group, ${cnt} members`; }
  if (it.kind === "table") { const cc = K.kid(n, "column_count"); return `${cc ? K.num(cc[1]) : 0} column table`; }
  if (it.kind === "target") return "Target";
  if (it.kind === "barcode") { const tx = K.kid(n, "text"); return `Barcode '${tx ? K.str(tx[1]) : ""}' on ${L(layerOf(n))}`; }
  const m = /^gr_(line|rect|circle|arc|poly|curve|ellipse|ellipse_arc)$/.exec(it.kind);
  if (m) { const layer = layerOf(n); return /\.Cu$/.test(layer) ? `${SHAPE_NAMES[m[1]]} ${netnameMsg(netOf(n))} on ${L(layer)}` : `${SHAPE_NAMES[m[1]]} on ${L(layer)}`; }
  return "";
}
/**
 * SELECTION_TOOL::doSelectionMenu's getItemDescription: a footprint whose description reads like another candidate's
 * is told apart by its library id (FOOTPRINT::DisambiguateItemDescription).  `ids` are the menu's candidates.
 */
export function itemDescriptionAmong(doc: BoardDoc, id: string, ids: string[], units: string) {
  const desc = itemDescription(doc, id, units); const it = doc.items.get(String(id));
  if (!it || it.kind !== "footprint" || String(id).includes("#") || String(id).includes("@field:")) return desc;
  const limit = Math.min(100, ids.length);
  for (let i = 0; i < limit; i++) { if (ids[i] === id) continue; if (itemDescription(doc, ids[i], units) === desc) return `${desc} (${K.str(it.node[1])})`; }
  return desc;
}
/** The tuning pattern a selection is: its generator with nothing beside it but its own members. */
export function tuningPatternOfSelection(doc: BoardDoc, ids: string[]) {
  let gen: KItem | null = null;
  for (const id of ids) { const it = doc.items.get(id); if (it && it.kind === "generated" && K.str((K.kid(it.node, "type") || [])[1]) === "tuning_pattern") { if (gen) return null; gen = it; } }
  if (!gen) return null; const mem = new Set(K.groupMemberIds(gen.node));
  return ids.every((id) => id === gen!.id || mem.has(id)) ? gen : null;
}
/** PCB_TUNING_PATTERN::GetMsgPanelInfo. */
export function tuningMsgPanel(doc: BoardDoc, gen: KItem, s: DesignSettings, units: string, add: (title: string, value: unknown) => void) {
  const V = (v: number) => msgValue(v, units); const n = gen.node;
  const numOf = (k: string) => { const c = K.kid(n, k); return c ? K.num(c[1]) : null; };
  const mode = K.str((K.kid(n, "tuning_mode") || [])[1]) || "single"; const override = (() => { const c = K.kid(n, "override_custom_rules"); return !!c && K.str(c[1]) === "yes"; })();
  const timeDomain = (() => { const c = K.kid(n, "is_time_domain"); return !!c && K.str(c[1]) === "yes"; })();
  add("Type", "Tuning Pattern");
  let primary: KItem | null = null, coupled: KItem | null = null, width = 0, mixed = false;
  const NT = netTable(doc);
  for (const id of K.groupMemberIds(n)) {
    const it = doc.items.get(id); if (!it || (it.kind !== "segment" && it.kind !== "arc")) continue;
    if (!primary) primary = it; else if (!coupled && NT.key(netOf(it.node)) !== NT.key(netOf(primary.node))) coupled = it;
    const w = widthOf(it.node, 0); if (!width) width = w; else if (Math.abs(width - w) > 1e-9) mixed = true;
  }
  // the net's name from the board's table; a pattern also remembers it (last_netname)
  const nameOf = (it: KItem | null) => { if (!it) return ""; const k = NT.key(netOf(it.node)); return k && k[0] !== "#" ? k : ""; };
  const lastName = K.str((K.kid(n, "last_netname") || [])[1]) || "";
  const pName = nameOf(primary) || (primary ? lastName : ""), cName = nameOf(coupled);
  const pNet = primary ? { code: netOf(primary.node).code, name: pName } : null, cNet = coupled ? { code: netOf(coupled.node).code, name: cName } : null;
  if (cNet && pNet) add("Nets", unescapeName(pNet.name) + ", " + unescapeName(cNet.name));
  else if (pNet) add("Net", unescapeName(pNet.name));
  if (pNet) add("Resolved Netclass", unescapeName(netclassName(s, pNet.name || "")));
  add("Layer", boardLayerName(doc, K.str((K.kid(n, "layer") || [])[1]) || "F.Cu"));
  if (width && !mixed) add("Width", V(width));
  if (primary && pNet && pNet.name) {
    const len = routedLength(doc, primary.id);
    if (coupled && cNet && cNet.name) add("Routed Lengths", V(len) + ", " + V(routedLength(doc, coupled.id)));
    else add("Routed Length", V(len));
  }
  const rule = S.ruleConstraint ? S.ruleConstraint(doc, mode === "diff_pair_skew" ? "skew" : "length", primary, coupled) : null;
  if (mode === "diff_pair_skew") {
    if (!rule || override) add(`Target Skew: ${V(numOf("target_skew") || 0)}`, "(from tuning pattern properties)");
    else if (rule.text) add(`Skew Constraints: ${rule.text}`, `(from ${rule.name})`);
  } else if (!rule || override) {
    if (timeDomain) add(`Target Delay: ${(numOf("target_delay") || 0).toFixed(4)} ps`, "(from tuning pattern properties)");
    else add(`Target Length: ${V(numOf("target_length") || 0)}`, "(from tuning pattern properties)");
  } else if (rule.text) add(`${timeDomain ? "Delay" : "Length"} Constraints: ${rule.text}`, `(from ${rule.name})`);
}
export const PAD_ATTR: Record<string, string> = { thru_hole: "PTH", smd: "SMD", connect: "Conn", np_thru_hole: "NPTH" };
export const PAD_SHAPE: Record<string, string> = { circle: "Circle", oval: "Oval", rect: "Rectangle", trapezoid: "Trapezoid", roundrect: "Rounded rectangle", chamfered_rect: "Chamfered rectangle", custom: "Custom shape" };
/**
 * The message panel's columns [{ title, value }] for the selection `ids` (an id, or "footprintId#padIndex" for a pad).
 * opts: { settings, units, route, nl }.  Nothing (or several things) selected gives the board summary, as pcbnew.
 */
export function msgPanelInfo(doc: BoardDoc, ids: Iterable<string>, opts?: MsgPanelOpts) {
  opts = opts || {}; const units = opts.units || "mm", s = opts.settings || designSettings(null), out: MsgItem[] = [];
  const add = (title: string, value: unknown) => out.push({ title: String(title), value: String(value === undefined || value === null ? "" : value) });
  const V = (v: number) => msgValue(v, units), NN = (net: string) => unescapeName(netclassName(s, net));
  const fpEd = !!(doc as unknown as { fpEditor?: boolean }).fpEditor;
  const EL = (t: string | null | undefined) => { const m = statusText(t); return opts!.ellipsize ? opts!.ellipsize(m) : m; };   // KIUI::EllipsizeStatusText
  const rt = opts.route;
  if (rt) {   // ROUTER_TOOL::UpdateMessagePanel
    const net = rt.net && (rt.net.name || "");
    const rs = opts.routerSettings || S.rs;
    if (rt.dp) {   // PNS_MODE_ROUTE_DIFF_PAIR
      const netB = (rt.netN && rt.netN.name) || ""; const ncA = NN(net), ncB = NN(netB);
      add(`Routing Diff Pair: ${unescapeName(net)}, ${unescapeName(netB)}`, `Resolved Netclass: ${ncA === ncB ? ncA : ncA + ", " + ncB}`);
      add("Corner Style", cornerStyleName(rs)); add("Mode", MODE_NAMES[rs.mode]);
      const d = rt.dpSizes!; add(`Track Width: ${V(d.width)}`, `(from ${d.widthSource})`);
      if (rt.clearance != null && rt.clearanceSource) add(`Min Clearance: ${V(rt.clearance)}`, `(from ${rt.clearanceSource})`);
      else { const c = msgClearance(s, net); add(`Min Clearance: ${V(c.v)}`, `(from ${c.from === "board setup constraints" ? "board minimum clearance" : c.from})`); }
      add(`Diff Pair Gap: ${V(d.gap)}`, `(from ${d.gapSource})`);
      // CT_MAX_UNCOUPLED between the pair's two traces on the routing layer
      const rules = S.dru && S.dru.rules;
      const unc = rules && rules.length ? evalRuleConstraint(rules, "diff_pair_uncoupled", doc, s, routedRuleItem({ net, layer: rt.layer }), routedRuleItem({ net: netB, layer: rt.layer })) : null;
      if (unc && unc.max != null) add(`DP Max Uncoupled-length: ${V(unc.max)}`, `(from ${unc.name})`);
      return out;
    }
    if (net) add(`Routing Track: ${unescapeName(net)}`, `Resolved Netclass: ${NN(net)}`); else add("Routing Track", "(no net)");
    add("Corner Style", cornerStyleName(rs));
    add("Mode", MODE_NAMES[rs.mode]);
    const R = K.pcbSizes && K.pcbSizes.state;
    const widthFrom = rt.widthSource ? rt.widthSource : rt.connected && R && R.useConnectedWidth && !R.tempOverride ? "existing track" : R && !R.useNetclassTrack ? "user choice" : `netclass '${NN(net)}'`;
    add(`Track Width: ${V(rt.width)}`, `(from ${widthFrom})`);
    if (rt.clearance != null && rt.clearanceSource) add(`Min Clearance: ${V(rt.clearance)}`, `(from ${rt.clearanceSource})`);   // updateSizesAfterRouterEvent / ImportSizes
    else { const c = msgClearance(s, net); add(`Min Clearance: ${V(c.v)}`, `(from ${c.from === "board setup constraints" ? "board minimum clearance" : c.from})`); }
    return out;
  }
  /** Font / Text Thickness / the size rows shared by PCB_TEXT and PCB_TEXTBOX. */
  const textRows = (font: SNode | null, wName: string, hName: string) => {
    const face = font && K.kid(font, "face"), th = font && K.kid(font, "thickness"), sz = font && K.kid(font, "size");
    add("Font", face && K.str(face[1]) ? K.str(face[1]) : "Default");
    add("Text Thickness", th && K.num(th[1]) ? V(textPenWidth(font)) : "Auto");
    add(wName, V(sz ? K.num(sz.length > 2 ? sz[2] : sz[1]) : 1)); add(hName, V(sz ? K.num(sz[1]) : 1));
  };
  const list = Array.from(ids || []);
  const gen = tuningPatternOfSelection(doc, list);
  if (gen) { tuningMsgPanel(doc, gen, s, units, add); return out; }
  if (list.length === 1) {
    const id = String(list[0]); let hash = id.indexOf("#");
    let it = doc.items.get(hash > 0 ? id.slice(0, hash) : id);
    // the Footprint Editor: a pad is an item of the document; its footprint is the one being edited, at the origin
    if (it && it.kind === "pad" && (doc as unknown as { fpEditor?: boolean }).fpEditor) {
      const fs = (doc as unknown as { fpState?: { fp?: SNode } }).fpState; const fp = fs && fs.fp;
      const refProp = (Array.from(doc.items.values()) as KItem[]).find((x) => x.kind === "property" && K.str(x.node[1]) === "Reference");
      it = { id: it.id, kind: "footprint", ref: refProp ? K.str(refProp.node[2]) : "", node: ["footprint", fp ? fp[1] : "", ["at", 0, 0], ...(fp ? fp.filter((k) => Array.isArray(k) && k[0] === "locked") : []), it.node] } as unknown as KItem; hash = 0;
    }
    if (it && hash >= 0 && it.kind === "footprint") {   // PAD::GetMsgPanelInfo
      const p = padsOf(it)[hash > 0 ? +id.slice(hash + 1) : 0];
      if (p) {
        if (!fpEd) add("Footprint", it.ref || "");   // only in the board editor (PCB_EDIT_FRAME_NAME)
        add("Pad", p.number);
        const pf = K.kid(p.node, "pinfunction"), ptp = K.kid(p.node, "pintype");
        if (pf && K.str(pf[1])) add("Pin Name", K.str(pf[1]));
        if (ptp && K.str(ptp[1])) add("Pin Type", K.str(ptp[1]));
        if (!fpEd) {
          add("Net", unescapeName(p.net.name)); add("Resolved Netclass", NN(p.net.name));
          if (isLocked(it.node) || isLocked(p.node)) add("Status", "Locked");
        }
        if (p.type === "smd" || p.type === "connect") add("Layer", padLayerDescribe(doc, p));
        if (fpEd && p.type === "smd") add("Area", msgArea(padPolygonArea(p), units));   // the Footprint Editor: the effective polygon's area
        const prop = K.kid(p.node, "property"); const PROP: Record<string, string> = { pad_prop_bga: "BGA", pad_prop_fiducial_glob: "Fiducial global", pad_prop_fiducial_loc: "Fiducial local", pad_prop_testpoint: "Test point", pad_prop_heatsink: "Heat sink", pad_prop_castellated: "Castellated", pad_prop_mechanical: "Mechanical", pad_prop_pressfit: "Press-fit" };
        // PADSTACK::ForEachUniqueLayer: a (padstack (mode front_inner_back|custom) (layer … (shape …) (size …))) pad has a shape and size per layer
        const stack = padstackLayers(p);
        const shapes = new Set(stack.map((l) => l.shape)), widths = new Set(stack.map((l) => r6(l.w))), heights = new Set(stack.map((l) => r6(l.h)));
        const circles = new Set(stack.map((l) => l.shape === "circle" || (l.shape === "oval" && Math.abs(l.w - l.h) < 1e-9)));
        add(shapes.size === 1 ? PAD_SHAPE[stack[0].shape] || "???" : "(mixed shapes)", (PAD_ATTR[p.type] || "???") + (prop && PROP[K.str(prop[1])] ? "," + PROP[K.str(prop[1])] : ""));
        if (circles.size === 1 && circles.has(true)) add("Diameter", widths.size === 1 ? V(stack[0].w) : "(mixed)");
        else { add("Width", widths.size === 1 ? V(stack[0].w) : "(mixed)"); add("Height", heights.size === 1 ? V(stack[0].h) : "(mixed)"); }
        const frot = K.atOf(it.node)[2] || 0; const prel = norm180(p.rot - frot);
        add("Rotation", frot ? `${msgG(prel)}(+ ${msgG(frot)})` : msgG(p.rot));   // "%g(+ %g)"
        const dl = K.kid(p.node, "die_length"); if (dl && K.num(dl[1])) add("Length in Package", V(K.num(dl[1])));
        const dr = K.kid(p.node, "drill");
        if (dr) { const oval = K.str(dr[1]) === "oval"; const nums = dr.slice(oval ? 2 : 1).filter((x) => typeof x === "number"); if (nums.length && nums[0] > 0) { if (oval) add("Hole X / Y", `${V(nums[0])} / ${V(nums.length > 1 ? nums[1] : nums[0])}`); else add("Hole", V(nums[0])); } }
        const c = msgClearance(s, p.net.name); add(`Min Clearance: ${V(c.v)}`, `(from ${c.from})`);
        return out;
      }
    }
    if (it && (it.kind === "segment" || it.kind === "arc")) {   // PCB_TRACK::GetMsgPanelInfo
      const n = it.node, net = netOf(n).name || "", w = widthOf(n, 0.25), layer = layerOf(n);
      add("Type", it.kind === "arc" ? "Track (arc)" : "Track");
      add("Net", unescapeName(net)); add("Resolved Netclass", NN(net)); if (isLocked(n)) add("Status", "Locked");
      add("Layer", boardLayerName(doc, layer)); add("Width", V(w));
      const a = pt(n, "start"), b = pt(n, "end"); let len = a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
      if (it.kind === "arc") { const m = pt(n, "mid"); const arc = a && m && b && K.arcFrom3(a, m, b); if (arc) { len = arcLength(arc); add("Radius", V(arc.r)); add("Angle", (len / arc.r * 180 / Math.PI * (arc.anticlockwise ? -1 : 1)).toFixed(2) + "deg"); } }
      add("Segment Length", V(len));
      if (hasNet(netOf(n))) {   // BOARD::GetTrackLength: the run's length and the die lengths of the pads at its ends
        const run = trackRunLength(doc, it.id); add("Routed Length", V(run.len));
        if (run.padToDie) { add("Pad To Die Length", V(run.padToDie)); add("Full Length", V(run.len + run.padToDie)); }
      }
      add("Copper Area", msgArea(it.kind === "arc" ? len * w + Math.PI * w * w / 4 : ovalPolygonArea(len, w, 0.02), units));   // TransformShapeToPolySet( …, ARC_LOW_DEF, ERROR_INSIDE )
      const c = msgClearance(s, net); add(`Min Clearance: ${V(c.v)}`, `(from ${c.from})`);
      const nc = netclassOf(s, net); const mn = s.minTrackWidth || 0; const parts = []; if (mn > 0) parts.push("min " + V(mn)); if (nc && nc.track_width !== undefined) parts.push("opt " + V(nc.track_width));
      if (parts.length) add(`Width Constraints: ${parts.join("; ")}`, `(from netclass '${NN(net)}')`);
      return out;
    }
    if (it && it.kind === "via") {   // PCB_VIA::GetMsgPanelInfo
      const n = it.node, net = netOf(n).name || ""; const v = viaNow(n);
      add("Type", n.includes("micro") ? "Micro Via" : n.includes("blind") ? "Blind Via" : n.includes("buried") ? "Buried Via" : "Through Via");
      add("Net", unescapeName(net)); add("Resolved Netclass", NN(net)); if (isLocked(n)) add("Status", "Locked");
      const ls = K.kid(n, "layers"); const pair = ls ? ls.slice(1).map(K.str) : ["F.Cu", "B.Cu"];
      add("Layer", `${boardLayerName(doc, pair[0] || "F.Cu")} - ${boardLayerName(doc, pair[pair.length - 1] || "B.Cu")}`);
      // the padstack's sizes per layer: one value, else "(mixed)"
      const vw = new Set<number>(); const vps = K.kid(n, "padstack");
      if (vps) for (const l of K.kids(vps, "layer")) { const sz = K.kid(l, "size"); if (sz) vw.add(r6(K.num(sz[1]))); }
      const fsz = K.kid(n, "size"); if (fsz) vw.add(r6(K.num(fsz[1])));
      add("Diameter", vw.size > 1 ? "(mixed)" : V(v.size)); add("Hole", V(v.drill));
      const c = msgClearance(s, net); add(`Min Clearance: ${V(c.v)}`, `(from ${c.from})`);
      {   // PCB_VIA::GetMinAnnulus: EvalRules( ANNULAR_WIDTH_CONSTRAINT, this, nullptr, GetLayer() ), the custom rules before the board setup one
        const A: RuleItem = { kind: "via", node: n, item: it, layer: pair[0] || "F.Cu" };
        const ra = resolve(S.dru ? S.dru.rules : [], "annular_width", doc, s, A, null, s.minViaAnnular || 0);
        // the implicit board setup rule always has a minimum (m_ViasMinAnnularWidth, 0 included); a custom rule with
        // none gives 0 and leaves the source string as GetOwnClearance set it
        if (!ra) add(`Min Annular Width: ${V(s.minViaAnnular || 0)}`, "(from board setup constraints)");
        else add(`Min Annular Width: ${V(ra.min != null ? ra.min : 0)}`, `(from ${ra.min != null ? ra.name : c.from})`);
      }
      return out;
    }
    if (it && it.kind === "footprint") {   // FOOTPRINT::GetMsgPanelInfo (board editor)
      const n = it.node; const val = K.kids(n, "property").find((q) => K.str(q[1]) === "Value");
      add(it.ref || "", it.value !== undefined ? it.value : val ? K.str(val[2]) : "");
      add("Board Side", it.layer === "B.Cu" ? "Back (Flipped)" : "Front");
      add("Rotation", msgAngle(K.atOf(n)[2] || 0));
      const status = [], attrs = []; if (isLocked(n)) status.push("Locked"); if (n.includes("placed") || K.kid(n, "placed")) status.push("autoplaced");
      const at = K.kid(n, "attr"); const toks = at ? at.slice(1).map(K.str) : [];
      if (toks.includes("board_only")) attrs.push("not in schematic"); if (toks.includes("exclude_from_pos_files")) attrs.push("exclude from pos files"); if (toks.includes("exclude_from_bom")) attrs.push("exclude from BOM"); if (toks.includes("exclude_from_sim")) attrs.push("exclude from simulation"); if (toks.includes("dnp")) attrs.push("DNP");
      add("Status: " + status.join(", "), "Attributes: " + attrs.join(", "));
      // COMPONENT_CLASS::GetHumanReadableName of the footprint's (component_classes (class "…") …)
      const ccs = K.kid(n, "component_classes"); const ccn = ccs ? K.kids(ccs, "class").map((c) => K.str(c[1])).filter(Boolean) : [];
      if (ccn.length) add("Component Class", humanList(ccn));
      const m3 = K.kid(n, "model");
      add(`Footprint: ${K.str(n[1])}`, `3D-Shape: ${m3 ? K.str(m3[1]) : "<none>"}`);
      const descr = K.kid(n, "descr"), tags = K.kid(n, "tags");
      add(`Doc: ${descr ? K.str(descr[1]) : ""}`, `Keywords: ${tags ? K.str(tags[1]) : ""}`);
      return out;
    }
    if (it && it.kind === "zone") {   // ZONE::GetMsgPanelInfo
      const n = it.node, keep = K.kid(n, "keepout"), net = netOf(n).name || "", zl = zoneLayers(n);
      add("Type", zoneFriendlyName(n));
      if (keep) {
        const r = []; for (const [k, l] of [["vias", "No vias"], ["tracks", "No tracks"], ["pads", "No pads"], ["copperpour", "No zone fills"], ["footprints", "No footprints"]]) { const x = K.kid(keep, k); if (x && K.str(x[1]) === "not_allowed") r.push(l); } if (r.length) add("Restrictions", r.join(", "));
        const pl = K.kid(n, "placement"); const en = pl && K.kid(pl, "enabled");
        if (pl && en && K.str(en[1]) === "yes") { const src = K.kid(pl, "sheetname") || K.kid(pl, "component_class") || K.kid(pl, "group") || K.kid(pl, "design_block"); add("Placement source", unescapeName(src ? K.str(src[1]) : "")); }
        if (K.kid(n, "linked_area") || K.kid(n, "link")) add("Layout link", "Linked");
      }
      else if (zl.some((l) => /\.Cu$/.test(l) || l === "*.Cu")) { add("Net", unescapeName(net)); add("Resolved Netclass", NN(net)); const pr = K.kid(n, "priority"); add("Priority", pr ? K.num(pr[1]) : 0); }
      if (isLocked(n)) add("Status", "Locked");
      const names = zl.map((l) => boardLayerName(doc, l));
      add("Layer", names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]}` : names.length > 3 ? `${names[0]}, ${names[1]} and ${names.length - 2} more` : "");
      const nm = K.kid(n, "name"); if (nm && K.str(nm[1])) add("Name", K.str(nm[1]));
      if (!keep) {
        const fill = K.kid(n, "fill"); const fm = fill && K.kid(fill, "mode") ? K.str(K.kid(fill, "mode")![1]) : "";
        add("Fill Mode", fm === "hatch" ? "Hatched" : fm ? "Unknown" : "Solid");   // ZONE::GetMsgPanelInfo: COPPER_THIEVING falls to the default case
        let area = 0; for (const fp of K.kids(n, "filled_polygon")) { const q = K.ptsOf(fp); for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; area += a[0] * b[1] - b[0] * a[1]; } }
        add("Filled Area", msgArea(Math.abs(area) / 2, units));
        const cp = K.kid(n, "connect_pads"); const cc = cp && K.kid(cp, "clearance"); const c = msgClearance(s, net);
        const zc = cc ? K.num(cc[1]) : 0; const v = Math.max(zc, c.v); add(`Min Clearance: ${V(v)}`, `(from ${zc >= c.v && cc ? "zone" : c.from})`);
      }
      let count = 0;
      if (keep) {   // the outline's area and its points; else every vertex of the fills
        let oa = 0; for (const pg of K.kids(n, "polygon")) { const q = K.ptsOf(pg); count += q.length; let a2 = 0; for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; a2 += a[0] * b[1] - b[0] * a[1]; } oa += Math.abs(a2) / 2; }
        add("Outline Area", msgArea(oa, units));
      } else for (const fp of K.kids(n, "filled_polygon")) count += K.ptsOf(fp).length;
      add("Corner Count", count);
      return out;
    }
    if (it && /^gr_(line|rect|circle|arc|poly|curve|ellipse|ellipse_arc)$/.test(it.kind)) {   // PCB_SHAPE::GetMsgPanelInfo (EDA_SHAPE::ShapeGetMsgPanelInfo)
      const n = it.node, kind = it.kind.slice(3); const SHAPE = SHAPE_NAMES;
      add("Type", "Drawing"); if (isLocked(n)) add("Status", "Locked");
      add("Shape", SHAPE[kind]);
      const a = pt(n, "start"), b = pt(n, "end"), c = pt(n, "center");
      if (kind === "circle" && c && b) add("Radius", V(Math.hypot(b[0] - c[0], b[1] - c[1])));
      else if (kind === "arc") { const m = pt(n, "mid"); const arc = a && m && b && K.arcFrom3(a, m, b); if (arc) { const L = arcLength(arc); add("Length", V(L)); add("Angle", (L / arc.r * 180 / Math.PI).toFixed(1) + "°"); add("Radius", V(arc.r)); } }
      else if (kind === "curve") { const q = K.bezierPts(K.ptsOf(n)); let L = 0; for (let i = 1; i < q.length; i++) L += Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]); add("Length", V(L)); }
      else if (kind === "ellipse" || kind === "ellipse_arc") {
        const deg = (k: string) => `${K.num((K.kid(n, k) || [])[1] ?? 0).toFixed(1)}°`;   // MessageTextFromValue( EDA_ANGLE )
        add("Length", V(ellipseLength(n))); add("Major Radius", V(K.num((K.kid(n, "major_radius") || [])[1] ?? 0))); add("Minor Radius", V(K.num((K.kid(n, "minor_radius") || [])[1] ?? 0)));
        add("Rotation", deg("rotation_angle"));
        if (kind === "ellipse_arc") { add("Start Angle", deg("start_angle")); add("End Angle", deg("end_angle")); }
      }
      else if (kind === "poly") add("Points", K.ptsOf(n).length);
      else if (kind === "rect" && a && b) { add("Width", V(Math.abs(b[0] - a[0]))); add("Height", V(Math.abs(b[1] - a[1]))); }
      else if (kind === "line" && a && b) { add("Length", V(Math.hypot(b[0] - a[0], b[1] - a[1]))); add("Angle", (Math.atan2(a[1] - b[1], b[0] - a[0]) * 180 / Math.PI).toFixed(1) + "°"); }
      { const st = K.kid(n, "stroke"), ty = st && K.kid(st, "type"), wd = st && K.kid(st, "width"), ow = K.kid(n, "width");   // STROKE_PARAMS::GetMsgPanelInfo
        add("Line Style", (ty && LINE_STYLE_NAMES[K.str(ty[1])]) || "Default"); add("Line Width", V(wd ? K.num(wd[1]) : ow ? K.num(ow[1]) : 0)); }
      const layer = layerOf(n); add("Layer", boardLayerName(doc, layer));
      if (/\.Cu$/.test(layer) && hasNet(netOf(n))) add("Net", unescapeName(netOf(n).name));
      return out;
    }
    if (it && (it.kind === "gr_text" || it.kind === "fp_text")) {   // PCB_TEXT::GetMsgPanelInfo
      const n = it.node, fp = it.kind === "fp_text"; const ef = K.kid(n, "effects"), font = ef ? K.kid(ef, "font") : null, j = ef && K.kid(ef, "justify");
      const text = K.str(n[fp ? 2 : 1]);
      if (fp) { add("Text", EL(text)); add("Type", "Text"); } else add("PCB Text", EL(text));
      if (!fpEd && isLocked(n)) add("Status", "Locked");
      add("Layer", boardLayerName(doc, layerOf(n)));
      add("Mirror", j && j.includes("mirror") ? "Yes" : "No");
      add("Angle", msgG(K.atOf(n)[2] || 0));
      textRows(font, "Width", "Height");
      return out;
    }
    if (it && it.kind === "gr_text_box") {   // PCB_TEXTBOX::GetMsgPanelInfo
      const n = it.node; const ef = K.kid(n, "effects"), font = ef ? K.kid(ef, "font") : null, j = ef && K.kid(ef, "justify");
      add("Text Box", EL(K.str(n[1])));
      if (!fpEd && isLocked(n)) add("Status", "Locked");
      add("Layer", boardLayerName(doc, layerOf(n)));
      add("Mirror", j && j.includes("mirror") ? "Yes" : "No");
      const ang = K.kid(n, "angle"); add("Angle", msgG(ang ? K.num(ang[1]) : 0));
      textRows(font, "Text Width", "Text Height");
      const a = pt(n, "start"), b = pt(n, "end");
      let bw = 0, bh = 0;
      if (a && b) { bw = Math.abs(b[0] - a[0]); bh = Math.abs(b[1] - a[1]); }
      else { const q = K.ptsOf(n); if (q.length) { const bb = bboxOfPts(q); if (q.length === 4 && !(ang && K.num(ang[1]))) { bw = bb[2] - bb[0]; bh = bb[3] - bb[1]; } else { bw = Math.abs(q[2][0] - q[0][0]); bh = Math.abs(q[2][1] - q[0][1]); } } }   // GetEnd() - GetStart(): the stored corners
      add("Box Width", V(bw)); add("Box Height", V(bh));
      const st = K.kid(n, "stroke"), ty = st && K.kid(st, "type"), wd = st && K.kid(st, "width");
      add("Line Style", (ty && LINE_STYLE_NAMES[K.str(ty[1])]) || "Default"); add("Line Width", V(wd ? K.num(wd[1]) : 0));
      return out;
    }
    if (it && it.kind === "dimension") {   // PCB_DIMENSION_BASE / PCB_DIM_ALIGNED / PCB_DIM_LEADER::GetMsgPanelInfo
      const n = it.node, m = dimRead(n); const gt = K.kid(n, "gr_text"), ef = gt && K.kid(gt, "effects"), font = ef ? K.kid(ef, "font") : null;
      const O = (p: Pt) => { const o = opts!.toDisplay ? opts!.toDisplay([p[0] / 1e6, p[1] / 1e6]) : [p[0] / 1e6, p[1] / 1e6]; return `@(${V(o[0])}, ${V(o[1])})`; };   // ORIGIN_TRANSFORMS::ToDisplayAbs
      if (m.type === "leader") {
        add("Leader", EL(m.text)); add(O(m.start), "");
        if (!fpEd && isLocked(n)) add("Status", "Locked");   // (PCB_DIM_LEADER does not call the base)
        add("Layer", boardLayerName(doc, layerOf(n)));
        return out;
      }
      const du = dimUnits(m as DimModel), DV = (v: number) => msgValue(v, du);
      add("Dimension", EL(m.text)); add("Prefix", m.prefix);
      if (m.override !== null) add("Override Text", m.override);
      else {
        add("Value", dimValueString(m as DimModel, dimUpdate({ ...m } as DimModel).measured || 0));
        const PREC: Record<number, string> = { 6: "0.00 in / 0 mils / 0.0 mm", 7: "0.000 in / 0 mils / 0.00 mm", 8: "0.0000 in / 0.0 mils / 0.000 mm", 9: "0.00000 in / 0.00 mils / 0.0000 mm" };
        add("Precision", PREC[m.precision] || (0).toFixed(Math.max(0, m.precision)));
      }
      add("Suffix", m.suffix);
      add("Units", du === "mil" ? "mils" : du);
      const face = font && K.kid(font, "face"); add("Font", face && K.str(face[1]) ? K.str(face[1]) : "Default");
      add("Text Thickness", DV(m.textThick / 1e6)); add("Text Width", DV(m.textW / 1e6)); add("Text Height", DV(m.textH / 1e6));
      if (m.type === "center") add(O(m.start), ""); else add(O(m.start), O(m.end));
      if (!fpEd && isLocked(n)) add("Status", "Locked");
      add("Layer", boardLayerName(doc, layerOf(n)));
      if (m.type === "aligned" || m.type === "orthogonal") add("Height", DV(m.height / 1e6));
      return out;
    }
    if (it && it.kind === "group") {   // PCB_GROUP::GetMsgPanelInfo
      const n = it.node; const nm = typeof n[1] === "string" ? K.str(n[1]) : "";
      add("Group", nm || "<unnamed>"); add("Members", K.groupMemberIds(n).length);
      if (!fpEd && isLocked(n)) add("Status", "Locked");
      return out;
    }
    if (it && it.kind === "image") {   // PCB_REFERENCE_IMAGE::GetMsgPanelInfo
      const n = it.node; const g = (it.geom || []).find((x) => x.t === "image") as unknown as { w: number; h: number; pxMm: number; scale: number } | undefined;
      const sc = K.kid(n, "scale");
      add("Reference Image", ""); add("PPI", `${g && g.pxMm ? Math.round(25.4 / g.pxMm) : 300} `); add("Scale", `${(sc ? K.num(sc[1], 1) : 1).toFixed(6)} `);
      add("Width", V(g ? g.w : 0)); add("Height", V(g ? g.h : 0)); add("Layer", boardLayerName(doc, layerOf(n)));
      return out;
    }
    if (it && it.kind === "table") {   // PCB_TABLE::GetMsgPanelInfo
      const cc = K.kid(it.node, "column_count"); add("Table", `${cc ? K.num(cc[1]) : 0} Columns`);
      return out;
    }
    if (it && it.kind === "target") {   // PCB_TARGET::GetMsgPanelInfo
      const n = it.node; const sz = K.kid(n, "size");
      add("PCB Target", ""); add("Layer", boardLayerName(doc, layerOf(n))); add("Size", V(sz ? K.num(sz[1]) : 0)); add("Width", V(widthOf(n, 0))); add("Shape", n.includes("x") ? "X" : "+");
      return out;
    }
    if (it && it.kind === "barcode") {   // PCB_BARCODE::GetMsgPanelInfo
      const n = it.node; const BT: Record<string, string> = { code39: "CODE_39", code128: "CODE_128", datamatrix: "DATA_MATRIX", qr: "QR_CODE", microqr: "MICRO_QR_CODE" };
      const ty = K.kid(n, "type"), tx = K.kid(n, "text"), th = K.kid(n, "text_height");
      add("Barcode", BT[ty ? K.str(ty[1]) : ""] || (ty ? K.str(ty[1]) : ""));
      add("Text", EL(tx ? K.str(tx[1]) : ""));
      if (!fpEd && isLocked(n)) add("Status", "Locked");
      add("Layer", boardLayerName(doc, layerOf(n)));
      add("Angle", msgG(K.atOf(n)[2] || 0));
      add("Text Height", V(th ? K.num(th[1]) : 0));
      return out;
    }
  }
  if (opts.net && !list.length) {   // NETINFO_ITEM::GetMsgPanelInfo: a net highlighted with nothing selected
    const NT = netTable(doc), name = opts.net; let code = 0;
    for (const [c, nm] of NT.byCode) if (nm === name) { code = c; break; }
    if (!code) { let i = 0; for (const nm of NT.byName.keys()) { i++; if (nm === name) { code = i; break; } } }
    let padCount = 0, viaCount = 0, first = null;
    for (const it of doc.items.values()) {
      if (it.kind === "footprint") { for (const p of K.kids(it.node, "pad")) if (NT.key(netOf(p)) === name) padCount++; }
      else if ((it.kind === "via" || it.kind === "segment" || it.kind === "arc") && NT.key(netOf(it.node)) === name) { if (it.kind === "via") viaCount++; else if (!first) first = it; }
    }
    add("Net Name", unescapeName(name)); add("Net Code", code); add("Pads", padCount); add("Vias", viaCount);
    if (first) { const L = routedLength(doc, first.id); add("Net Length", V(L)); add("On Board", V(L)); add("In Package", V(0)); }
    return out;
  }
  if ((doc as unknown as { fpEditor?: boolean }).fpEditor) return out;   // the Footprint Editor shows the footprint (the editor's own panel), never board statistics
  // BOARD::GetMsgPanelInfo
  let pads = 0, vias = 0, segs = 0; const nets = new Set();
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") for (const p of K.kids(it.node, "pad")) { pads++; const nn = netOf(p); if (hasNet(nn)) nets.add(nn.name || nn.code); }
    else if (it.kind === "via" || it.kind === "segment" || it.kind === "arc") { if (it.kind === "via") vias++; else segs++; const nn = netOf(it.node); if (hasNet(nn)) nets.add(nn.name || nn.code); }
  }
  add("Pads", pads); add("Vias", vias); add("Track Segments", segs); add("Nets", nets.size);
  add("Unrouted", ratsnest(doc, opts.nl || netlistCached(doc)).length);
  return out;
}
export function bboxOfPts(pts: Pt[]) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; }
/** Ids of everything with copper or drawings on a layer (footprints by their side). */
export function idsOnLayer(doc: BoardDoc, layer: string) {
  const out = new Set<string>();
  for (const it of doc.items.values()) { if (it.kind === "group") continue; if ((it.kind === "footprint" && it.layer === layer) || it.geom.some((g) => g.layer === layer)) out.add(it.id); }
  return out;
}
export const SELECTION_TYPES: Record<string, (it: KItem) => boolean> = { footprints: (it: KItem) => it.kind === "footprint", tracks: (it: KItem) => it.kind === "segment" || it.kind === "arc", vias: (it: KItem) => it.kind === "via", zones: (it: KItem) => it.kind === "zone", graphics: (it: KItem) => /^gr_(line|rect|circle|arc|poly|curve)$/.test(it.kind) || it.kind === "image", text: (it: KItem) => it.kind === "gr_text" || it.kind === "gr_text_box" || it.kind === "table", dimensions: (it: KItem) => it.kind === "dimension", other: (it: KItem) => it.kind === "group" || it.kind === "target" || it.kind === "generated" };
export function filterIds(doc: BoardDoc, ids: Iterable<string>, keep: Record<string, boolean>) { return Array.from(ids).filter((id) => { const it = doc.items.get(id); if (!it) return false; for (const [type, test] of Object.entries(SELECTION_TYPES)) if (test(it)) return keep[type] !== false; return true; }); }
/** Clearance between two copper items, as the inspector shows it: the gap and what the rules ask for. */
export function inspectClearance(doc: BoardDoc, idA: string, idB: string, settings?: DesignSettings | DesignSource | string | null) {
  const s = settings && (settings as DesignSettings).netclasses ? settings as DesignSettings : designSettings(settings); const conds = conductors(doc).filter((c) => c.kind !== "zone");
  const A = conds.filter((c) => c.id === idA), B = conds.filter((c) => c.id === idB); if (!A.length || !B.length) return null;
  let gap = Infinity; for (const a of A) for (const b of B) if (shareLayer(a.layers, b.layers)) gap = Math.min(gap, shapeGap(a.shape, b.shape));
  const need = Math.max(netClearance(s, A[0].net), netClearance(s, B[0].net));
  return { gap: gap === Infinity ? null : r6(gap), required: need, sameNet: !!(A[0].net && A[0].net === B[0].net), nets: [A[0].net, B[0].net] };
}
