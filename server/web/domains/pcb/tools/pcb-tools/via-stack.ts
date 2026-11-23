// pcb-tools/via-stack.ts — microvia stacks (pcbnew/generators/pcb_via_stack.cpp PCB_VIA_STACK): a generator that
// holds one single-hop microvia per adjacent copper pair of its span (and, for a staggered stack, the short traces
// joining the hops on each landing layer).  The model (BuildMembers, Regenerate, CreateFromItems,
// ExpandMultiHopMicrovias, FindNetAtPosition), the Place Microvia Stack tool (DRAWING_TOOL::PlaceMicroviaStack),
// Create Stack from Selection (GENERATOR_TOOL::MakeViaStackFromSelection), the stack's properties
// (PCB_VIA_STACK::ShowPropertiesDialog with DIALOG_MICROVIA_STACK) and the router's Place Microvia Stack at Track End
// (ROUTER_TOOL::onViaStackCommand, commitPendingViaStack and the expansion in finishInteractive).
import type { BoardDoc, NetRef, PcbChange, PcbCtx, Pt, Route } from "./types";
import { hoverPoint, sizesOf } from "./app-state";
import { addedChange, removedChange, replacedChange, upsertChange } from "./changes";
import { copperOf, KD, openForm, settingsOf } from "./dialogs";
import { netclassOf } from "./drc";
import { evalRuleConstraint } from "./dru";
import { angleSnapMode } from "./draw-modes";
import { applySelection, groupMembers, parentOf, selectionIds } from "./groups";
import { pointInPoly } from "./hit";
import { netOf } from "./nets";
import { segmentNode, viaNode } from "./nodes";
import { padsOf } from "./route-geom";
import { alignToSegment, routeClick, trackRule, viaPlaceHits, viaSnapPad, viaSnapTrack } from "./route-tool";
import { updateHead } from "./branch";
import { refreshChip } from "./dom";
import { MAGNETIC_NEVER, magneticOption } from "./snap-pairs";
import { viaTypeOf } from "./dru-eval";
import { K, S, bind, lastCtx } from "./state";
import { fmtG, sexprQ } from "./tuning-tool";
import { color, layerOf, pt, r6 } from "./util";
import { pathHits, routeObstacles } from "./walkaround";
import { netTable } from "./netlist";

/** MAX_MICROVIA_STACK_PITCH_MM (board_design_settings_defaults.h). */
export const MAX_MICROVIA_STACK_PITCH_MM = 25;
export const VIA_STACK_TYPE = "via_stack";
/** PCB_VIA_STACK::DISPLAY_NAME / GetCommitMessage. */
export const VIA_STACK_NAME = "Microvia Stack", VIA_STACK_EDIT = "Edit Microvia Stack";

/** VIA_STACK_PRESET, in mm, as board.design_settings.via_stack_presets stores it. */
export interface ViaStackPreset { name: string; start_layer: string; end_layer: string; staggered: boolean; via_size: number; via_drill: number; use_netclass: boolean; filled: boolean; capped: boolean; pitch: number }
/** PCB_VIA_STACK's settings (mm): span, style, sizes, the net, its position and, staggered, the hop centres. */
export interface ViaStackSettings {
  start: string; end: string; staggered: boolean; pitch: number; filled: boolean; capped: boolean;
  viaSize: number; viaDrill: number; useNetclass: boolean; presetName: string; origin: Pt; hops: Pt[] | null; net: NetRef;
}

const isCopperName = (l: unknown) => typeof l === "string" && /^(F\.Cu|B\.Cu|In\d+\.Cu)$/.test(l);
const json = (src: unknown): Record<string, unknown> | null => {
  let v = src; if (typeof src === "string") { try { v = src.trim() ? JSON.parse(src) : null; } catch (e) { v = null; } }
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
};
/**
 * BOARD_DESIGN_SETTINGS' via_stack_presets reader: entries without a string name are skipped, an odd or non-copper layer
 * falls back (F.Cu / In1.Cu), sizes below zero read as 0, the pitch is clamped to 0 … 25 mm, and a name already taken
 * (case-insensitively) is dropped.
 */
export function viaStackPresets(src: unknown): ViaStackPreset[] {
  const pro = json(src); const board = pro && json(pro.board); const ds = board && json(board.design_settings);
  const list = ds && Array.isArray(ds.via_stack_presets) ? ds.via_stack_presets as unknown[] : [];
  const out: ViaStackPreset[] = [];
  const bool = (o: Record<string, unknown>, k: string, d: boolean) => (typeof o[k] === "boolean" ? o[k] as boolean : d);
  const mmOr = (o: Record<string, unknown>, k: string) => (typeof o[k] === "number" && (o[k] as number) >= 0 && isFinite(o[k] as number) ? o[k] as number : 0);
  for (const e of list) {
    const o = json(e); if (!o || typeof o.name !== "string") continue;
    const p: ViaStackPreset = { name: o.name, start_layer: isCopperName(o.start_layer) ? o.start_layer as string : "F.Cu", end_layer: isCopperName(o.end_layer) ? o.end_layer as string : "In1.Cu",
      staggered: bool(o, "staggered", false), via_size: mmOr(o, "via_size"), via_drill: mmOr(o, "via_drill"), use_netclass: bool(o, "use_netclass", false),
      filled: bool(o, "filled", true), capped: bool(o, "capped", false), pitch: typeof o.pitch === "number" && isFinite(o.pitch) ? Math.min(Math.max(o.pitch, 0), MAX_MICROVIA_STACK_PITCH_MM) : 0 };
    if (!out.some((q) => q.name.toLowerCase() === p.name.toLowerCase())) out.push(p);
  }
  return out;
}
/** BOARD_DESIGN_SETTINGS::GetViaStackIndex: the preset the toolbar's microvia stack selector has chosen. */
export function viaStackIndex(): number { const st = K.pcbSizes && K.pcbSizes.state; return st && typeof st.viaStackIndex === "number" ? st.viaStackIndex : 0; }
/** The preset the stack tools place: the selected one, clamped into the list; null with none defined. */
export function currentPreset(ctx: PcbCtx): ViaStackPreset | null { const ps = viaStackPresets(ctx.designSettings); return ps.length ? ps[Math.max(0, Math.min(viaStackIndex(), ps.length - 1))] : null; }

/** PCB_VIA_STACK( aParent, F_Cu ): stacked F.Cu to In1.Cu, filled, sizes from the board. */
export function defaultSettings(): ViaStackSettings {
  return { start: "F.Cu", end: "In1.Cu", staggered: false, pitch: 0, filled: true, capped: false, viaSize: 0, viaDrill: 0, useNetclass: false, presetName: "", origin: [0, 0], hops: null, net: { code: 0, name: "" } };
}
/** PCB_VIA_STACK::ApplyPreset. */
export function applyPreset(st: ViaStackSettings, p: ViaStackPreset): ViaStackSettings {
  return Object.assign(st, { start: p.start_layer, end: p.end_layer, staggered: p.staggered, viaSize: p.via_size, viaDrill: p.via_drill, useNetclass: p.use_netclass, filled: p.filled, capped: p.capped, pitch: p.pitch, presetName: p.name });
}
/** PCB_VIA_STACK::ToPreset. */
export function toPreset(st: ViaStackSettings): ViaStackPreset {
  return { name: st.presetName, start_layer: st.start, end_layer: st.end, staggered: st.staggered, via_size: st.viaSize, via_drill: st.viaDrill, use_netclass: st.useNetclass, filled: st.filled, capped: st.capped, pitch: st.pitch };
}

// ---------------------------------------------------------------- layers
/** The board's copper layers in physical order (LAYER_RANGE( F_Cu, B_Cu, copper count )). */
export function copperOrder(doc: BoardDoc): string[] { return K.pcbSizes.copperStack(copperOf(doc)); }
/** LAYER_RANGE( a, b ): the copper layers from a to b inclusive, walked in that direction. */
export function layerRange(doc: BoardDoc, a: string, b: string): string[] {
  const cu = copperOrder(doc), i = cu.indexOf(a), j = cu.indexOf(b); if (i < 0 || j < 0) return [];
  return i <= j ? cu.slice(i, j + 1) : cu.slice(j, i + 1).reverse();
}
/** PCB_VIA_STACK::IsSpanValid: both ends copper layers present on the board, and different. */
export function isSpanValid(doc: BoardDoc, a: string, b: string): boolean { const cu = copperOrder(doc); return cu.includes(a) && cu.includes(b) && a !== b; }
const isOuter = (l: string) => l === "F.Cu" || l === "B.Cu";

// ---------------------------------------------------------------- sizes
const netName = (ctx: PcbCtx, net: NetRef | null | undefined) => (net && net.name) || (net && net.code > 0 && ctx.doc.nets && ctx.doc.nets.get(net.code)) || "";
/** PCB_VIA_STACK::GetNetclassViaSize: the net class's microvia diameter and drill, the current via size where unset. */
export function netclassViaSize(ctx: PcbCtx, net: NetRef | null): { diameter: number; drill: number } {
  const nc = netclassOf(settingsOf(ctx), netName(ctx, net)) as { microvia_diameter?: number; microvia_drill?: number }; const cur = sizesOf(ctx).currentVia();
  return { diameter: typeof nc.microvia_diameter === "number" && nc.microvia_diameter > 0 ? nc.microvia_diameter : cur.diameter, drill: typeof nc.microvia_drill === "number" && nc.microvia_drill > 0 ? nc.microvia_drill : cur.drill };
}
/** MINOPTMAX::PinnedOpt( aDefault ): the opt (else the default) held inside min / max. */
const pinned = (h: { min: number | null; opt: number | null; max: number | null } | null, d: number) => { if (!h) return d; let v = h.opt != null ? h.opt : d; if (h.max != null) v = Math.min(v, h.max); if (h.min != null) v = Math.max(v, h.min); return v; };
/** PCB_VIA::SetSizeFromRules: the via_diameter and hole_size rules that match the via, pinned around the given size. */
export function sizeFromRules(ctx: PcbCtx, node: SNode, diameter: number, drill: number): { diameter: number; drill: number } {
  const d = S.dru; if (!d || !d.rules.length) return { diameter, drill };
  const s = settingsOf(ctx), A = { kind: "via", node, layer: null };
  return { diameter: pinned(evalRuleConstraint(d.rules, "via_diameter", ctx.doc, s, A, null), diameter), drill: pinned(evalRuleConstraint(d.rules, "hole_size", ctx.doc, s, A, null), drill) };
}
const microNode = (doc: BoardDoc, at: Pt, size: number, drill: number, net: NetRef, a: string, b: string) => { const n = viaNode(doc, at[0], at[1], size, drill, net, [a, b]); n.splice(1, 0, "micro"); return n; };
/** The via's (capping) / (filling), before its net as PCB_IO_KICAD_SEXPR writes them. */
function setProtection(n: SNode, capped: boolean, filled: boolean) {
  for (const k of ["capping", "filling"]) { const c = K.kid(n, k); if (c) n.splice(n.indexOf(c), 1); }
  const at = n.findIndex((c, i) => i > 0 && Array.isArray(c) && (c[0] === "padstack" || c[0] === "teardrops" || c[0] === "net" || c[0] === "uuid"));
  n.splice(at < 0 ? n.length : at, 0, ["capping", capped ? "yes" : "no"]);
  const at2 = n.findIndex((c, i) => i > 0 && Array.isArray(c) && (c[0] === "padstack" || c[0] === "teardrops" || c[0] === "net" || c[0] === "uuid"));
  n.splice(at2 < 0 ? n.length : at2, 0, ["filling", filled ? "yes" : "no"]);
}

// ---------------------------------------------------------------- members
/** The hop positions BuildMembers places (hopPos): staggered hops from the stored chain, extrapolated past its end. */
export function hopPos(st: ViaStackSettings, i: number): Pt {
  if (!st.staggered) return st.origin.slice();   // stacked hops are coaxial
  const h = st.hops;
  if (h && i < h.length) return h[i].slice();
  if (h && h.length > 1) {
    const last = h.length - 1, dx = h[last][0] - h[last - 1][0], dy = h[last][1] - h[last - 1][1], L = Math.hypot(dx, dy);
    if (L > 0) { const sx = dx / L * st.pitch, sy = dy / L * st.pitch; if (Math.hypot(sx, sy) > 0) return [r6(h[last][0] + sx * (i - last)), r6(h[last][1] + sy * (i - last))]; }
  }
  return [r6(st.origin[0] + st.pitch * i), st.origin[1]];
}
/**
 * PCB_VIA_STACK::BuildMembers: one microvia per adjacent copper pair (the stack's size, or the net class's microvia size
 * through the via rules with "use netclass values"; a hop is capped only when the stack is and it reaches an outer layer,
 * filled when stacked, filled or capped), then for a staggered stack a trace on each shared landing layer between
 * consecutive hops, as wide as the track width rules make the net's width there (never under the board minimum).
 */
export function buildMembers(ctx: PcbCtx, st: ViaStackSettings, net: NetRef): SNode[] {
  const doc = ctx.doc, out: SNode[] = [];
  if (!isSpanValid(doc, st.start, st.end)) return out;
  const layers = layerRange(doc, st.start, st.end); if (layers.length < 2) return out;
  const nHops = layers.length - 1, cur = sizesOf(ctx).currentVia();
  let size: number, drill: number;
  if (st.useNetclass) { const v = netclassViaSize(ctx, net); size = v.diameter; drill = v.drill; }
  else { size = st.viaSize > 0 ? st.viaSize : cur.diameter; drill = st.viaDrill > 0 ? st.viaDrill : cur.drill; }
  for (let i = 0; i < nHops; i++) {
    let n = microNode(doc, hopPos(st, i), size, drill, net, layers[i], layers[i + 1]);
    if (st.useNetclass) { const r = sizeFromRules(ctx, n, size, drill); n = microNode(doc, hopPos(st, i), r.diameter, r.drill, net, layers[i], layers[i + 1]); }
    const capped = st.capped && (isOuter(layers[i]) || isOuter(layers[i + 1]));
    setProtection(n, capped, !st.staggered || st.filled || capped);
    out.push(n);
  }
  if (st.staggered) {
    const s = settingsOf(ctx), name = netName(ctx, net); const nc = netclassOf(s, name) as { track_width?: number };
    const trackWidth = typeof nc.track_width === "number" ? nc.track_width : sizesOf(ctx).currentTrackWidth();
    for (let i = 0; i < nHops - 1; i++) {
      const a = hopPos(st, i), b = hopPos(st, i + 1); if (a[0] === b[0] && a[1] === b[1]) continue;
      const r = trackRule(ctx, "track_width", name, layers[i + 1]);
      const w = r ? pinned({ min: r.min, opt: r.opt, max: r.max }, trackWidth) : trackWidth;
      out.push(segmentNode(doc, a, b, Math.max(s.minTrackWidth || 0, w), layers[i + 1], net));
    }
  }
  return out;
}

// ---------------------------------------------------------------- the generator node
/**
 * PCB_IO_KICAD_SEXPR::format( PCB_GENERATOR ) for a stack: type, name, layer (the start layer), then GetProperties in
 * STRING_ANY_MAP (alphabetical) order — lengths as mm, booleans yes / no, strings quoted, the hops as a point list —
 * and the members' uuids.
 */
export function viaStackNode(st: ViaStackSettings, members: string[], uuid?: string | null, locked?: boolean): SNode {
  const yn = (b: boolean) => (b ? "yes" : "no"), xy = (p: Pt) => `(xy ${fmtG(p[0])} ${fmtG(p[1])})`;
  const props = [`(capped ${yn(st.capped)})`, `(end_layer ${sexprQ(st.end)})`, `(filled ${yn(st.filled)})`, ...(st.hops ? [`(hops (pts ${st.hops.map(xy).join(" ")}))`] : []),
    `(origin ${xy(st.origin)})`, `(pitch ${fmtG(st.pitch)})`, `(preset ${sexprQ(st.presetName)})`, `(start_layer ${sexprQ(st.start)})`, `(style ${sexprQ(st.staggered ? "staggered" : "stacked")})`,
    `(use_netclass ${yn(st.useNetclass)})`, `(via_drill ${fmtG(st.viaDrill)})`, `(via_size ${fmtG(st.viaSize)})`];
  return K.parse(`(generated (uuid ${sexprQ(uuid || K.newUuid())}) (type ${VIA_STACK_TYPE}) (name ${sexprQ(VIA_STACK_NAME)}) (layer ${sexprQ(st.start)})${locked ? " (locked yes)" : ""} ${props.join(" ")} (members ${members.slice().sort().map(sexprQ).join(" ")}))`) as SNode;
}
export const isViaStack = (it: KItem | null | undefined): it is KItem => !!it && it.kind === "generated" && K.str((K.kid(it.node, "type") || [])[1]) === VIA_STACK_TYPE;
/** PCB_VIA_STACK::SetProperties (and GetNetCode: the first member's net, else none). */
export function viaStackInfo(doc: BoardDoc, node: SNode): ViaStackSettings {
  const st = defaultSettings();
  const str = (k: string) => { const c = K.kid(node, k); return c ? K.str(c[1]) : null; };
  const num = (k: string) => { const c = K.kid(node, k); return c ? K.num(c[1], 0) : null; };
  const bool = (k: string) => { const c = K.kid(node, k); return c ? K.str(c[1]) === "yes" : null; };
  const sl = str("start_layer"), el = str("end_layer"), style = str("style");
  if (sl !== null && isCopperName(sl)) st.start = sl; if (el !== null && isCopperName(el)) st.end = el;
  if (style !== null) st.staggered = style === "staggered";
  for (const [k, f] of [["filled", "filled"], ["capped", "capped"], ["use_netclass", "useNetclass"]] as const) { const v = bool(k); if (v !== null) (st as unknown as Record<string, boolean>)[f] = v; }
  const pr = str("preset"); if (pr !== null) st.presetName = pr;
  for (const [k, f] of [["pitch", "pitch"], ["via_size", "viaSize"], ["via_drill", "viaDrill"]] as const) { const v = num(k); if (v !== null) (st as unknown as Record<string, number>)[f] = v; }
  const o = K.kid(node, "origin"), oxy = o && K.kid(o, "xy"); if (oxy) st.origin = [K.num(oxy[1]), K.num(oxy[2])];
  const h = K.kid(node, "hops"); if (h) st.hops = K.ptsOf(h).map((p: number[]) => [p[0], p[1]]);
  for (const id of groupMembers(node)) { const m = doc.items.get(id); if (m && (m.kind === "via" || m.kind === "segment" || m.kind === "arc")) { st.net = netOf(m.node); break; } }
  return st;
}

// ---------------------------------------------------------------- regeneration
const memberKey = (n: SNode) => (n[0] === "via" ? `via|${viaPair(n).join("|")}` : n[0] === "segment" ? `segment|${layerOf(n)}` : null);
/** PCB_VIA::TopLayer / BottomLayer in board order. */
function viaPair(n: SNode): string[] { const ls = (K.kid(n, "layers") || []).slice(1).map((x) => K.str(x)); return ls; }
/**
 * PCB_VIA_STACK::Regenerate as board changes: the rebuilt members reuse the live ones when they implement the same hops
 * (reuseMembers: one live member per key, keyed by type and layers — they are reshaped in place); otherwise every
 * member goes and the rebuilt ones come in.  `node` is the generator as it should end (its settings), written with
 * the member list that results.  Nothing changes when the span no longer builds but members exist.
 */
export function regenerateChanges(ctx: PcbCtx, gen: KItem, st: ViaStackSettings, node: SNode): PcbChange[] {
  const doc = ctx.doc, net = st.net; const rebuilt = buildMembers(ctx, st, net);
  const live = groupMembers(gen.node).map((id) => doc.items.get(id)).filter(Boolean) as KItem[];
  const out: PcbChange[] = [];
  const finish = (ids: string[]) => { const m = K.kid(node, "members"); if (m) m.splice(1, m.length - 1, ...ids.slice().sort()); else node.push(["members", ...ids.slice().sort()]); out.push(upsertChange({ id: gen.id, kind: "generated", node }, "MODIFIED")); return out; };
  if (!rebuilt.length && live.length) return finish(live.map((it) => it.id));
  const byKey = new Map<string, KItem>(); let reuse = rebuilt.length > 0 && rebuilt.length === live.length;
  for (const it of live) { const k = memberKey(it.node); if (!k || byKey.has(k)) { reuse = false; break; } byKey.set(k, it); }
  if (reuse) for (const n of rebuilt) { const k = memberKey(n); if (!k || !byKey.has(k)) { reuse = false; break; } }
  if (reuse) {
    const ids: string[] = [];
    for (const n of rebuilt) {
      const it = byKey.get(memberKey(n)!)!; byKey.delete(memberKey(n)!); ids.push(it.id);
      const fresh = K.cloneNode(it.node) as SNode;
      if (n[0] === "via") {
        for (const k of ["at", "size", "drill"]) { const src = K.kid(n, k)!, dst = K.kid(fresh, k); if (dst) dst.splice(1, dst.length - 1, ...src.slice(1)); }
        setProtection(fresh, K.str((K.kid(n, "capping") || [])[1]) === "yes", K.str((K.kid(n, "filling") || [])[1]) === "yes");
      } else for (const k of ["start", "end", "width"]) { const src = K.kid(n, k)!, dst = K.kid(fresh, k); if (dst) dst.splice(1, dst.length - 1, ...src.slice(1)); }
      const nn = K.kid(fresh, "net"), sn = K.kid(n, "net"); if (nn && sn) nn.splice(1, nn.length - 1, ...sn.slice(1));
      if (K.serialize(fresh) !== K.serialize(it.node)) out.push(replacedChange(it, fresh));
    }
    return finish(ids);
  }
  for (const it of live) out.push(removedChange(it));
  const scratch = Object.assign({}, doc, { items: new Map(doc.items) }) as BoardDoc; const ids: string[] = [];
  for (const n of rebuilt) { n.push(["uuid", K.newUuid()]); const it = K.createItem(scratch, n)!; ids.push(it.id); out.push(upsertChange(it, "ADDED", netOf(n))); }
  return finish(ids);
}
/** The changes that add a new stack (EditStart on an IS_NEW stack, Update, EditFinish): its members, then the generator. */
export function newStackChanges(ctx: PcbCtx, st: ViaStackSettings): { changes: PcbChange[]; members: SNode[]; gen: SNode } {
  const doc = ctx.doc, scratch = Object.assign({}, doc, { items: new Map(doc.items) }) as BoardDoc;
  const members = buildMembers(ctx, st, st.net), changes: PcbChange[] = [], ids: string[] = [];
  for (const n of members) { n.push(["uuid", K.newUuid()]); const it = K.createItem(scratch, n)!; ids.push(it.id); changes.push(upsertChange(it, "ADDED", netOf(n))); }
  const gen = viaStackNode(st, ids); changes.push(addedChange(scratch, gen));
  return { changes, members, gen };
}

// ---------------------------------------------------------------- FindNetAtPosition
const padNpth = (p: { node: SNode }) => K.str(p.node[2] as string) === "np_thru_hole";
const padOn = (ls: string[], layer: string) => ls.some((l) => l === layer || l === "*.Cu" || l === "F&B.Cu" || (l === "In*.Cu" && /^In\d+\.Cu$/.test(layer)));
function padHit(p: { x: number; y: number; rot: number; w: number; h: number }, q: Pt) {
  const a = -p.rot * Math.PI / 180, dx = q[0] - p.x, dy = q[1] - p.y; const lx = dx * Math.cos(a) + dy * Math.sin(a), ly = -dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= p.w / 2 + 1e-9 && Math.abs(ly) <= p.h / 2 + 1e-9;
}
const distSeg = (p: Pt, a: Pt, b: Pt) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const k = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0; return Math.hypot(p[0] - (a[0] + k * dx), p[1] - (a[1] + k * dy)); };
/** PCB_VIA_STACK::FindNetAtPosition on one layer: a pad (not a mechanical hole) first, then a track, then a filled zone. */
export function netAtLayer(doc: BoardDoc, p: Pt, layer: string): NetRef | null {
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue;
    for (const pad of padsOf(it)) if (!padNpth(pad) && padOn(pad.layers, layer) && padHit(pad, p)) return pad.net;
  }
  for (const it of doc.items.values()) {
    if (it.kind === "segment" || it.kind === "arc") {
      if (layerOf(it.node) !== layer) continue; const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) continue;
      const w = K.num((K.kid(it.node, "width") || [0, 0.25])[1], 0.25);
      if (it.kind === "segment" ? distSeg(p, a, b) <= w / 2 + 1e-9 : it.geom.some((g) => K.geomHit(g, p[0], p[1], 0))) return netOf(it.node);
    } else if (it.kind === "via") {
      const at = pt(it.node, "at"), ls = viaPair(it.node), cu = copperOrder(doc); const i = cu.indexOf(ls[0]), j = cu.indexOf(ls[ls.length - 1]), k = cu.indexOf(layer);
      const r = K.num((K.kid(it.node, "size") || [0, 0])[1]) / 2;
      if (at && k >= Math.min(i, j) && k <= Math.max(i, j) && Math.hypot(p[0] - at[0], p[1] - at[1]) <= r + 1e-9) return netOf(it.node);
    }
  }
  for (const it of doc.items.values()) {
    if (it.kind !== "zone" || K.kid(it.node, "keepout")) continue;
    for (const fp of K.kids(it.node, "filled_polygon")) { const l = K.kid(fp, "layer"); if (!l || K.str(l[1]) !== layer) continue; const pts = K.ptsOf(fp); if (pts.length >= 3 && pointInPoly(pts, p[0], p[1])) return netOf(it.node); }
  }
  return null;
}
/** FindNetAtPosition( LSET ): the first layer of the span, top down (CuStack), with copper of a net under the point. */
export function findNetAtPosition(doc: BoardDoc, p: Pt, layers: string[]): NetRef {
  const set = new Set(layers);
  for (const l of copperOrder(doc)) { if (!set.has(l)) continue; const n = netAtLayer(doc, p, l); if (n && (n.code > 0 || n.name)) return n; }
  return { code: 0, name: "" };
}

// ---------------------------------------------------------------- CreateFromItems / ExpandMultiHopMicrovias
const fillOf = (n: SNode): boolean | null => { const c = K.kid(n, "filling"); return c ? K.str(c[1]) === "yes" : null; };
const capOf = (n: SNode): boolean | null => { const c = K.kid(n, "capping"); return c ? K.str(c[1]) === "yes" : null; };
/** BOARD_DESIGN_SETTINGS::m_FillVias: the board setup's (filling …). */
export function boardFillsVias(doc: BoardDoc): boolean { const st = (doc as unknown as { setupNode?: SNode | null }).setupNode; const f = st ? K.kid(st, "filling") : null; return !!f && K.str(f[1]) === "yes"; }
const ordinalsOf = (doc: BoardDoc) => { const m = new Map<string, number>(); copperOrder(doc).forEach((l, i) => m.set(l, i)); return m; };
const viaSize = (n: SNode) => K.num((K.kid(n, "size") || [0, 0])[1]), viaDrill = (n: SNode) => K.num((K.kid(n, "drill") || [0, 0])[1]);
const netKey = (doc: BoardDoc, n: SNode) => netTable(doc).key(netOf(n));
export const STACK_NEEDS = "A microvia stack needs two or more microvias on the same net, each spanning one layer step, with no gap between them.";
export const STACK_MIXED_SIZES = "The selected microvias have different diameters or hole sizes. A microvia stack uses one size for every hop.";
/**
 * PCB_VIA_STACK::CreateFromItems: microvias (not already in a generator, one net, one size) and traces only; each via
 * one layer step, together tiling a contiguous span.  Coaxial vias make a stacked (filled) stack, anything else a
 * staggered one with the hops in layer order and the first step as the pitch.  The members are the vias plus the
 * traces that join hop positions on a landing layer of the stack's net.  null (and maybe a message) when refused.
 */
export function createFromItems(doc: BoardDoc, items: KItem[]): { st: ViaStackSettings; members: string[] } | { error: string | null } {
  const vias: KItem[] = [], traces: KItem[] = [];
  for (const it of items) {
    if (it.kind === "via") {
      if (viaTypeOf(it.node) !== "micro") return { error: null };
      const par = parentOf(doc, it.id); if (par && par.kind === "generated") return { error: null };
      if (vias.length && netKey(doc, it.node) !== netKey(doc, vias[0].node)) return { error: null };
      if (vias.length && (Math.abs(viaSize(it.node) - viaSize(vias[0].node)) > 1e-9 || Math.abs(viaDrill(it.node) - viaDrill(vias[0].node)) > 1e-9)) return { error: STACK_MIXED_SIZES };
      vias.push(it);
    } else if (it.kind === "segment") traces.push(it);
    else return { error: null };
  }
  if (vias.length < 2) return { error: null };
  const order = copperOrder(doc), ord = ordinalsOf(doc); const byUpper = new Map<number, KItem>();
  for (const v of vias) {
    const ls = viaPair(v.node); const t = ord.get(ls[0]), b = ord.get(ls[ls.length - 1]);
    if (t === undefined || b === undefined || Math.abs(t - b) !== 1) return { error: null };
    const up = Math.min(t, b); if (byUpper.has(up)) return { error: null }; byUpper.set(up, v);
  }
  const uppers = [...byUpper.keys()].sort((a, b) => a - b), first = uppers[0], last = uppers[uppers.length - 1];
  if (uppers.length !== last - first + 1) return { error: null };
  const top = byUpper.get(first)!, tp = pt(top.node, "at")!;
  const coaxial = vias.every((v) => { const p = pt(v.node, "at")!; return p[0] === tp[0] && p[1] === tp[1]; });
  const st = defaultSettings();
  st.start = order[first]; st.end = order[last + 1]; st.viaSize = viaSize(top.node); st.viaDrill = viaDrill(top.node); st.net = netOf(top.node);
  const f = fillOf(top.node); st.filled = f !== null ? f : boardFillsVias(doc);
  st.capped = vias.some((v) => { const ls = viaPair(v.node); return (ls.some(isOuter)) && capOf(v.node) === true; });
  st.origin = tp.slice();
  if (coaxial) { st.staggered = false; st.filled = true; }
  else { st.staggered = true; st.hops = uppers.map((u) => pt(byUpper.get(u)!.node, "at")!); st.pitch = r6(Math.hypot(st.hops[1][0] - st.hops[0][0], st.hops[1][1] - st.hops[0][1])); }
  const landing = new Set(order.slice(first + 1, last + 1)); const pos = new Set(vias.map((v) => { const p = pt(v.node, "at")!; return p[0] + "," + p[1]; }));
  const members = vias.map((v) => v.id);
  for (const t of traces) {
    const a = pt(t.node, "start")!, b = pt(t.node, "end")!;
    if (landing.has(layerOf(t.node)) && !(a[0] === b[0] && a[1] === b[1]) && netKey(doc, t.node) === netKey(doc, top.node) && pos.has(a[0] + "," + a[1]) && pos.has(b[0] + "," + b[1])) members.push(t.id);
  }
  return { st, members };
}
/** isExpandableMicrovia: a loose microvia (in no group) crossing more than one layer step. */
function isExpandable(doc: BoardDoc, ord: Map<string, number>, it: KItem) {
  if (it.kind !== "via" || viaTypeOf(it.node) !== "micro" || parentOf(doc, it.id)) return false;
  const ls = viaPair(it.node); const t = ord.get(ls[0]), b = ord.get(ls[ls.length - 1]);
  return t !== undefined && b !== undefined && Math.abs(t - b) > 1;
}
/** PCB_VIA_STACK::CollectExpandableMicrovias: the ids an expansion would consider now. */
export function collectExpandableMicrovias(doc: BoardDoc): Set<string> { const ord = ordinalsOf(doc); const out = new Set<string>(); for (const it of doc.items.values()) if (isExpandable(doc, ord, it)) out.add(it.id); return out; }
/**
 * PCB_VIA_STACK::ExpandMultiHopMicrovias: every loose multi-hop microvia (those the matcher returns a preset for, when
 * there is one) becomes a stacked, filled stack of single-hop microvias of its size and net at its position, taking
 * the preset's other attributes.
 */
export function expandMultiHopMicrovias(ctx: PcbCtx, matcher?: ((via: KItem) => ViaStackPreset | null) | null): PcbChange[] {
  const doc = ctx.doc, ord = ordinalsOf(doc); const out: PcbChange[] = [];
  const cands: { via: KItem; preset: ViaStackPreset | null }[] = [];
  for (const it of doc.items.values()) {
    if (!isExpandable(doc, ord, it)) continue;
    let preset: ViaStackPreset | null = null;
    if (matcher) { preset = matcher(it); if (!preset) continue; }
    cands.push({ via: it, preset });
  }
  for (const { via, preset } of cands) {
    const ls = viaPair(via.node), cu = copperOrder(doc); const [top, bottom] = cu.indexOf(ls[0]) <= cu.indexOf(ls[ls.length - 1]) ? [ls[0], ls[ls.length - 1]] : [ls[ls.length - 1], ls[0]];
    const st = defaultSettings(); if (preset) applyPreset(st, preset);
    Object.assign(st, { start: top, end: bottom, staggered: false, viaSize: viaSize(via.node), viaDrill: viaDrill(via.node), net: netOf(via.node), filled: true, origin: pt(via.node, "at")!, hops: null });
    out.push(removedChange(via));
    out.push(...newStackChanges(ctx, st).changes);
  }
  return out;
}

// ---------------------------------------------------------------- Create Stack from Selection
/** GENERATOR_TOOL::MakeViaStackFromSelection ("Create Stack from Selection", commit "Create Microvia Stack"). */
export function makeViaStack(ctx: PcbCtx): boolean {
  bind(ctx); const doc = ctx.doc; if (!doc) return false;
  const ids = Array.from(selectionIds(ctx)).filter((id) => { const it = doc.items.get(id); return !!it && (it.kind === "via" || it.kind === "segment"); });
  const items = ids.map((id) => doc.items.get(id)!) as KItem[];
  const res = createFromItems(doc, items);
  if ("error" in res) { ctx.toast(res.error || STACK_NEEDS); return true; }
  if (ctx.viewOnly) { ctx.toast("View-only access"); return true; }
  applySelection(ctx, []);
  const changes: PcbChange[] = [];
  // a member leaves the group it was in (the old group is modified, then the member joins the stack)
  for (const id of res.members) {
    const par = parentOf(doc, id); if (!par || par.kind !== "group") continue;
    const n = K.cloneNode(par.node) as SNode; const m = K.kid(n, "members")!; m.splice(1, m.length - 1, ...m.slice(1).filter((x) => K.str(x) !== id));
    changes.push(replacedChange(par, n)); par.node = n;
  }
  const gen = viaStackNode(res.st, res.members);
  const scratch = Object.assign({}, doc, { items: new Map(doc.items) }) as BoardDoc; const it = K.createItem(scratch, gen)!;
  changes.push(upsertChange(it, "ADDED"));
  ctx.commit(changes, "Create Microvia Stack");
  applySelection(ctx, [it.id, ...res.members]); ctx.requestRender();
  return true;
}

// ---------------------------------------------------------------- properties (DIALOG_MICROVIA_STACK)
/** The one microvia stack the selection is (the generator and its own members), or null. */
export function selectedViaStack(ctx: PcbCtx): KItem | null {
  const doc = ctx.doc; if (!doc) return null; const sel = Array.from(selectionIds(ctx)); let gen: KItem | null = null;
  for (const id of sel) { const it = doc.items.get(id); if (isViaStack(it)) { if (gen) return null; gen = it; } }
  if (!gen) { if (sel.length !== 1) return null; const par = parentOf(doc, sel[0]); return isViaStack(par) ? par : null; }
  const mem = new Set(groupMembers(gen.node)); for (const id of sel) if (id !== gen.id && !mem.has(id)) return null;
  return gen;
}
/** DisplayErrorMessage over the dialog that is open (a child window with one OK). */
export function errorMessage(ctx: PcbCtx, msg: string) {
  const kd = KD(); if (!kd || typeof document === "undefined") { ctx.toast(msg); return; }
  kd.open({ title: "Error", width: 380, child: true, buttons: [{ label: "OK", primary: true, isDefault: true, close: true }],
    build(body: HTMLElement) { const p = document.createElement("p"); p.style.margin = "4px 0"; p.textContent = msg; body.appendChild(p); } });
}
/** PCB_VIA::ValidateViaParameters for a microvia stack's size (the checks the dialog makes before it accepts). */
export function validateViaParameters(diameter: number, drill: number): string | null {
  if (!(diameter > 0)) return "Via diameter is too small.";
  if (!(drill > 0)) return "Via drill is too small.";
  if (drill >= diameter) return "Via hole size must be smaller than via diameter";
  return null;
}
/**
 * DIALOG_MICROVIA_STACK over a scratch copy of the settings: Start layer / End layer (copper only), Type (Stacked /
 * Staggered), Via diameter / Via hole, Use netclass values, Copper-filled, Capped, Pitch.  Pitch is enabled only for a
 * staggered stack, the sizes only without the net class (showing the net class size while it is on), Copper-filled
 * only for a staggered stack (a stacked one is always filled).  done(settings) on OK.
 */
export function microviaStackDialog(ctx: PcbCtx, st0: ViaStackSettings, done: (st: ViaStackSettings) => void) {
  const doc = ctx.doc, cu = copperOrder(doc); let explicitSize = st0.viaSize, explicitDrill = st0.viaDrill;
  const nc = netclassViaSize(ctx, st0.net); const unit = "mm";
  const fields = [
    { k: "start", label: "Start layer:", type: "select", value: st0.start, options: cu.map((l) => [l, l]) },
    { k: "end", label: "End layer:", type: "select", value: st0.end, options: cu.map((l) => [l, l]) },
    { k: "type", label: "Type:", type: "select", value: st0.staggered ? "1" : "0", options: [["0", "Stacked"], ["1", "Staggered"]] },
    { k: "viaSize", label: "Via diameter:", type: "num", unit, value: st0.useNetclass ? nc.diameter : explicitSize },
    { k: "viaDrill", label: "Via hole:", type: "num", unit, value: st0.useNetclass ? nc.drill : explicitDrill },
    { k: "useNetclass", label: "Use netclass values", type: "check", value: st0.useNetclass },
    { k: "filled", label: "Copper-filled", type: "check", value: st0.staggered ? st0.filled : true },
    { k: "capped", label: "Capped", type: "check", value: st0.capped },
    { k: "pitch", label: "Pitch:", type: "num", unit, value: st0.pitch },
  ];
  const enable = (staggered: boolean, useNc: boolean) => {   // updateEnableState
    if (typeof document === "undefined") return;
    const el = (k: string) => document.querySelector(`.kd-dialog [data-k="${k}"]`) as HTMLInputElement | null;
    const p = el("pitch"), d = el("viaSize"), h = el("viaDrill"), f = el("filled");
    if (p) p.disabled = !staggered; if (d) d.disabled = useNc; if (h) h.disabled = useNc;
    if (f) { f.disabled = !staggered; if (!staggered) f.checked = true; }
  };
  let staggered = st0.staggered, useNc = st0.useNetclass;
  openForm<{ start: string; end: string; type: string; viaSize: number; viaDrill: number; useNetclass: boolean; filled: boolean; capped: boolean; pitch: number }>({ title: "Microvia Stack", width: 420, fields,
    change(k, v, set) {
      if (k === "type") { staggered = v === "1"; if (!staggered) set("filled", true); }
      if (k === "useNetclass") {   // onUseNetclass
        useNc = !!v;
        const cur = (key: string) => { const e = typeof document !== "undefined" ? document.querySelector(`.kd-dialog [data-k="${key}"]`) as HTMLInputElement | null : null; return e ? parseFloat(e.value) : NaN; };
        if (useNc) { explicitSize = cur("viaSize"); explicitDrill = cur("viaDrill"); set("viaSize", nc.diameter); set("viaDrill", nc.drill); }
        else { if (explicitSize > 0) set("viaSize", explicitSize); if (explicitDrill > 0) set("viaDrill", explicitDrill); }
      }
      enable(staggered, useNc);
    },
    apply(v) {
      const stag = v.type === "1";
      if (v.start === v.end) { errorMessage(ctx, "The start and end layers must be different."); return false; }
      if (!isSpanValid(doc, v.start, v.end)) { errorMessage(ctx, "Select a start and an end layer present on this board."); return false; }
      const pitch = isFinite(v.pitch) ? v.pitch : 0;
      if (stag && !(pitch > 0)) { errorMessage(ctx, "Staggered stacks need a pitch greater than zero."); return false; }
      if (pitch > MAX_MICROVIA_STACK_PITCH_MM) { errorMessage(ctx, `The pitch must be ${MAX_MICROVIA_STACK_PITCH_MM.toFixed(4)} mm or less.`); return false; }
      const st = Object.assign({}, st0, { start: v.start, end: v.end, staggered: stag, useNetclass: !!v.useNetclass, filled: stag ? !!v.filled : true, capped: !!v.capped, pitch: r6(pitch) });
      if (v.useNetclass) { st.viaSize = 0; st.viaDrill = 0; }
      else { const err = validateViaParameters(v.viaSize, v.viaDrill); if (err) { errorMessage(ctx, err); return false; } st.viaSize = r6(v.viaSize); st.viaDrill = r6(v.viaDrill); }
      done(st); return true;
    } });
  if (typeof setTimeout !== "undefined") setTimeout(() => enable(staggered, useNc), 0);
}
/**
 * PCB_VIA_STACK::ShowPropertiesDialog: the dialog edits a copy; on OK the stack takes the new settings, a staggered
 * stack's hops are re-spaced to the pitch keeping each step's direction, a stack without a net takes the net of the
 * copper under it across its span, and the members are rebuilt ("Edit Microvia Stack").
 */
export function viaStackProperties(ctx: PcbCtx, gen: KItem): boolean {
  bind(ctx); const st0 = viaStackInfo(ctx.doc, gen.node);
  microviaStackDialog(ctx, st0, (edited) => {
    const c = lastCtx || ctx; if (c.viewOnly) { c.toast("View-only access"); return; }
    const cur = c.doc.items.get(gen.id); if (!cur) return;
    const st = Object.assign({}, edited);
    if (st.staggered && st.hops && st.hops.length >= 2) {
      const h: Pt[] = [st.hops[0].slice()];
      for (let i = 1; i < st.hops.length; i++) { let dx = st.hops[i][0] - st.hops[i - 1][0], dy = st.hops[i][1] - st.hops[i - 1][1]; const L = Math.hypot(dx, dy); if (L > 0) { dx = dx / L * st.pitch; dy = dy / L * st.pitch; } h.push([r6(h[i - 1][0] + dx), r6(h[i - 1][1] + dy)]); }
      st.hops = h;
    }
    if (!(st.net.code > 0 || st.net.name) && isSpanValid(c.doc, st.start, st.end)) st.net = findNetAtPosition(c.doc, st.origin, layerRange(c.doc, st.start, st.end));
    const locked = !!K.kid(cur.node, "locked") && K.str(K.kid(cur.node, "locked")![1]) !== "no";
    const node = viaStackNode(st, groupMembers(cur.node), K.str((K.kid(cur.node, "uuid") || [])[1]) || cur.id, locked);
    c.commit(regenerateChanges(c, cur, st, node), VIA_STACK_EDIT); c.requestRender();
  });
  return true;
}

// ---------------------------------------------------------------- Place Microvia Stack (DRAWING_TOOL::PlaceMicroviaStack)
export interface StackPlacing { st: ViaStackSettings; staggered: boolean; span: string[]; nHops: number; hops: Pt[]; lastDir: Pt; seeded: boolean; cursor: Pt; preview: SNode[]; lastViaPos: Pt | null }
let placing: StackPlacing | null = null;
/** The router's handoff (DRAWING_TOOL::SeedViaStackStart): the staggered stack starts at the routed head. */
let seed: { at: Pt; start: string; end: string } | null = null;
export function seedViaStackStart(at: Pt, start: string, end: string) { seed = { at: at.slice(), start, end }; }
export const stackPlacing = () => placing;
/** The tool started (PCB_ACTIONS::placeViaStack): the selected preset, or the dialog when none is defined yet. */
export function viaStackActivate(ctx: PcbCtx) {
  bind(ctx); placing = null; const sd = seed; seed = null;
  if (ctx.fpEditor) { ctx.setTool("select"); return; }
  const preset = currentPreset(ctx), st = defaultSettings();
  const start = (s: ViaStackSettings) => beginPlacing(ctx, s, sd);
  if (preset) { applyPreset(st, preset); start(st); return; }
  if (sd) { start(st); return; }
  microviaStackDialog(ctx, st, (edited) => { if ((lastCtx || ctx).doc && S.modTool === "viastack") start(edited); });
}
function beginPlacing(ctx: PcbCtx, st: ViaStackSettings, sd: { at: Pt; start: string; end: string } | null) {
  if (sd) { st.start = sd.start; st.end = sd.end; st.staggered = true; }
  if (!isSpanValid(ctx.doc, st.start, st.end)) { ctx.toast("The microvia stack layers are not present on this board."); ctx.setTool("select"); return; }
  const span = layerRange(ctx.doc, st.start, st.end);
  if (st.staggered && !(st.pitch > 0)) { const dia = st.viaSize > 0 ? st.viaSize : sizesOf(ctx).currentVia().diameter; st.pitch = r6(dia * 2); }   // a zero pitch would pin the steering circle onto a point
  const nHops = span.length - 1; if (nHops < 1) { ctx.setTool("select"); return; }
  placing = { st, staggered: st.staggered, span, nHops, hops: sd ? [sd.at.slice()] : [], lastDir: [1, 0], seeded: !!sd, cursor: sd ? sd.at.slice() : (ctx.cursor ? ctx.cursor.slice() : [0, 0]), preview: [], lastViaPos: null };
  ctx.requestRender();
}
/** Leaving the tool: the preview goes. */
export function viaStackDeactivate() { placing = null; }
/** snapToCopper: with item snapping (not Shift) a track of the span under the cursor (AlignToSegment), else a pad's centre; else the grid. */
function snapToCopper(ctx: PcbCtx, raw: Pt, itemSnap: boolean): Pt {
  const P = placing!, dia = P.st.viaSize > 0 ? P.st.viaSize : sizesOf(ctx).currentVia().diameter, pair = [P.st.start, P.st.end];
  if (itemSnap) {
    if (magneticOption("tracks") !== MAGNETIC_NEVER) { const t = viaSnapTrack(ctx.doc, raw, dia, pair); if (t && t.kind === "segment") return alignToSegment(ctx, raw, pt(t.node, "start")!, pt(t.node, "end")!); }
    if (magneticOption("pads") !== MAGNETIC_NEVER) { const p = viaSnapPad(ctx.doc, raw, pair); if (p) return [p.x, p.y]; }
  }
  return ctx.snapOn && ctx.snap ? ctx.snap(raw.slice()) : raw.slice();
}
/** The cursor of the loop: a staggered hop steers on a circle of pitch radius round the previous one, in the angle snap mode (Ctrl: free). */
function stackCursor(ctx: PcbCtx, raw: Pt, ev: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } | null): Pt {
  const P = placing!;
  if (P.staggered && P.hops.length) {
    const o = P.hops[P.hops.length - 1]; let dx = raw[0] - o[0], dy = raw[1] - o[1]; if (Math.hypot(dx, dy) < 1e-6) { dx = 1; dy = 0; }
    let mode = angleSnapMode(); if (ev && (ev.ctrlKey || ev.metaKey)) mode = "free";
    let c: Pt;
    if (mode !== "free") { const step = mode === "90" ? Math.PI / 2 : Math.PI / 4; const a = Math.round(Math.atan2(dy, dx) / step) * step; c = [r6(o[0] + Math.cos(a) * P.st.pitch), r6(o[1] + Math.sin(a) * P.st.pitch)]; }
    else { const L = Math.hypot(dx, dy); c = [r6(o[0] + dx / L * P.st.pitch), r6(o[1] + dy / L * P.st.pitch)]; }
    P.lastDir = [c[0] - o[0], c[1] - o[1]]; return c;
  }
  return snapToCopper(ctx, raw, !(ev && ev.shiftKey));
}
/** updatePreview: the placed hops plus the one being steered (staggered), or the whole stack at the cursor. */
function updatePreview(ctx: PcbCtx) {
  const P = placing!; const st = Object.assign({}, P.st);
  if (P.staggered) { st.hops = P.hops.concat([P.cursor]); st.origin = P.hops.length ? P.hops[0] : P.cursor; st.end = P.span[Math.min(P.hops.length + 1, P.nHops)]; }
  else st.origin = P.cursor.slice();
  P.preview = buildMembers(ctx, st, { code: 0, name: "" });
}
export function viaStackMove(ctx: PcbCtx, raw: Pt, ev: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } | null) {
  bind(ctx); if (!placing) return; placing.cursor = stackCursor(ctx, raw, ev); updatePreview(ctx); S.hover = { x: placing.cursor[0], y: placing.cursor[1], snap: null } as never;
}
/** CheckItemDRCViolation for a would-be member: what copper, hole, keep-out or edge it violates on its layers. */
function memberViolates(ctx: PcbCtx, n: SNode, net: NetRef): boolean {
  if (n[0] === "via") return viaPlaceHits(ctx, pt(n, "at")!, viaSize(n), viaPair(n), net).length > 0;
  const s = settingsOf(ctx), key = netTable(ctx.doc).key(net), w = K.num((K.kid(n, "width") || [0, 0])[1]);
  return pathHits(routeObstacles(ctx.doc, s, key, layerOf(n), null), [pt(n, "start")!, pt(n, "end")!], w / 2).length > 0;
}
/** placeStack: the full span at the hops / cursor with the net of what it lands on, refused over foreign copper unless violations are allowed. */
function placeStack(ctx: PcbCtx, cursor: Pt): boolean {
  const P = placing!; const st = Object.assign({}, P.st); st.end = P.span[P.span.length - 1];
  if (P.staggered) { st.hops = P.hops.map((p) => p.slice()); st.origin = P.hops[0].slice(); } else { st.hops = null; st.origin = cursor.slice(); }
  st.net = findNetAtPosition(ctx.doc, st.origin, P.span);
  const violates = buildMembers(ctx, st, st.net).some((n) => memberViolates(ctx, n, st.net));
  if (violates && !S.rs.can_violate_drc) { ctx.toast("Microvia stack location violates DRC."); return false; }
  const { changes, members } = newStackChanges(ctx, st);
  const last = members.find((n) => n[0] === "via" && viaPair(n).includes(st.end)); P.lastViaPos = last ? pt(last, "at") : null;
  ctx.commit(changes, "Place Microvia Stack"); return true;
}
/** A click (or a double click) in the tool. */
export function viaStackClick(ctx: PcbCtx, raw: Pt, ev: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } | null) {
  bind(ctx); const P = placing; if (!P) return;
  if (ctx.viewOnly) { ctx.toast("View-only access"); return; }
  P.cursor = stackCursor(ctx, raw, ev);
  if (P.staggered) {
    P.hops.push(P.cursor.slice());
    if (P.hops.length >= P.nHops) {
      if (!placeStack(ctx, P.cursor)) P.hops.pop();   // blocked by DRC: the last hop can be moved and tried again
      else { P.hops = []; P.preview = []; if (P.seeded) return resumeRouting(ctx); }
    } else { const L = Math.hypot(P.lastDir[0], P.lastDir[1]) || 1; P.cursor = [r6(P.hops[P.hops.length - 1][0] + P.lastDir[0] / L * P.st.pitch), r6(P.hops[P.hops.length - 1][1] + P.lastDir[1] / L * P.st.pitch)]; updatePreview(ctx); }
  } else if (placeStack(ctx, P.cursor)) { P.preview = []; if (P.seeded) return resumeRouting(ctx); }
  ctx.requestRender();
}
/** ACTIONS::undo / doDelete in the loop: a staggered stack's last hop comes back (never the seeded one); always swallowed. */
export function viaStackUndo(ctx: PcbCtx): boolean {
  const P = placing; if (!P) return false;
  if (P.staggered && P.hops.length > (P.seeded ? 1 : 0)) { P.hops.pop(); P.lastDir = [1, 0]; updatePreview(ctx); ctx.requestRender(); }
  return true;
}
/** Back to routing from the last placed via (the router's handoff): the end layer is active and the route starts there. */
function resumeRouting(ctx: PcbCtx) {
  const P = placing!; const at = P.lastViaPos, end = P.st.end; placing = null;
  S.layer = end; sizesOf(ctx).setActiveLayer(end);
  ctx.setTool("route");
  if (at && S.modTool === "route") { S.layer = end; const hv = hoverPoint(ctx, at, true); S.hover = hv; routeClick(ctx, hv, at); }
  ctx.requestRender();
}
/** The preview (the members at the cursor) for the overlay. */
export function drawViaStackPreview(c: CanvasRenderingContext2D, px: number) {
  const P = placing; if (!P || !P.preview.length) return;
  c.save(); c.globalAlpha = 0.6; c.lineCap = "round";
  for (const n of P.preview) {
    if (n[0] === "segment") { const a = pt(n, "start")!, b = pt(n, "end")!; c.strokeStyle = color(layerOf(n)); c.lineWidth = K.num((K.kid(n, "width") || [0, 0.2])[1]); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
  }
  for (const n of P.preview) {
    if (n[0] !== "via") continue; const at = pt(n, "at")!, d = viaSize(n), h = viaDrill(n); c.strokeStyle = "rgb(179, 179, 179)";
    c.lineWidth = Math.max((d - h) / 2, px); c.beginPath(); c.arc(at[0], at[1], (d + h) / 4, 0, Math.PI * 2); c.stroke();
  }
  c.restore();
}

// ---------------------------------------------------------------- the router: Place Microvia Stack at Track End
interface PendingExpansion { start: string; end: string; net: NetRef; preset: ViaStackPreset; pos: Pt | null }
interface RouteStackState { pending: PendingExpansion[]; preRoute: Set<string>; awaiting: boolean; stagger: { head: Pt; start: string; end: string } | null }
const routeStacks = new WeakMap<Route, RouteStackState>();
const routeState = (rt: Route) => { let r = routeStacks.get(rt); if (!r) { r = { pending: [], preRoute: new Set(), awaiting: false, stagger: null }; routeStacks.set(rt, r); } return r; };
/** ViaStackTargetLayer: from the start layer the end, from the end layer back to the start, else none. */
export function viaStackTargetLayer(start: string, end: string, current: string): string | null {
  if (start === end) return null; if (current === start) return end; if (current === end) return start; return null;
}
/** MatchPendingStackExpansion: a via the route left (not there before) at a drop's position, of its net and span. */
export function matchPendingStackExpansion(doc: BoardDoc, via: KItem, preRoute: Set<string>, pending: PendingExpansion[]): ViaStackPreset | null {
  if (preRoute.has(via.id)) return null;
  const at = pt(via.node, "at")!, ls = viaPair(via.node), cu = copperOrder(doc); const [top, bot] = cu.indexOf(ls[0]) <= cu.indexOf(ls[ls.length - 1]) ? [ls[0], ls[ls.length - 1]] : [ls[ls.length - 1], ls[0]];
  const key = netTable(doc).key(netOf(via.node));
  for (const e of pending) {
    if (!e.pos || Math.abs(e.pos[0] - at[0]) > 1e-6 || Math.abs(e.pos[1] - at[1]) > 1e-6) continue;
    if (netTable(doc).key(e.net) !== key) continue;
    if ((top === e.start && bot === e.end) || (top === e.end && bot === e.start)) return e.preset;
  }
  return null;
}
/**
 * ROUTER_TOOL::onViaStackCommand (Ctrl+Shift+V while routing): the selected preset's stack at the track end.  The
 * route must be on one of the preset's two layers.  A staggered preset fixes the track here and hands over to the
 * Place Microvia Stack tool once the route has ended; a stacked one arms a microvia from the current layer to the
 * other end of the span (the preset's size, or the net class's microvia size through the via rules), which the end
 * of the route expands into a stack.
 */
export function onViaStackCommand(ctx: PcbCtx, toggleOff: () => void, fixForStack: () => boolean, endRouteFn: () => void): boolean {
  const rt = S.route; if (!rt || rt.dp) return false;
  const presets = viaStackPresets(ctx.designSettings);
  if (!presets.length) { ctx.toast("No microvia stack presets defined. Add one in Board Setup, Microvia Stacks."); return true; }
  const preset = presets[Math.max(0, Math.min(viaStackIndex(), presets.length - 1))];
  const cur = rt.layer, cu = copperOrder(ctx.doc);
  if (!cu.includes(preset.start_layer) || !cu.includes(preset.end_layer)) { ctx.toast("The microvia stack preset layers are not present on this board."); return true; }
  const target = viaStackTargetLayer(preset.start_layer, preset.end_layer, cur);
  if (!target) { ctx.toast(`The microvia stack runs between ${preset.start_layer} and ${preset.end_layer}. Route on one of those layers to place it.`); return true; }
  const rs = routeState(rt);
  if (preset.staggered) {
    if (rt.placingVia) toggleOff();
    if (!fixForStack()) { ctx.toast("Could not end the track here for a microvia stack."); refreshChip(ctx); return true; }
    rs.stagger = { head: rt.last.slice(), start: cur, end: target };   // the head is where the fixed track ends
    endRouteFn();   // the route ends; the stack is placed once it has (commitPendingViaStack)
    return true;
  }
  const net = rt.net && (rt.net.code > 0 || rt.net.name) ? rt.net : { code: 0, name: "" };
  let size: number, drill: number;
  if (preset.use_netclass) {
    const v = netclassViaSize(ctx, net); const r = sizeFromRules(ctx, microNode(ctx.doc, rt.last, v.diameter, v.drill, net, cur, target), v.diameter, v.drill); size = r.diameter; drill = r.drill;
  } else { const v = sizesOf(ctx).currentVia(); size = preset.via_size > 0 ? preset.via_size : v.diameter; drill = preset.via_drill > 0 ? preset.via_drill : v.drill; }
  if (!rs.pending.length) rs.preRoute = collectExpandableMicrovias(ctx.doc);
  rs.pending.push({ start: cur, end: target, net, preset, pos: null }); rs.awaiting = true;
  const span = [cur, target].sort((a, b) => cu.indexOf(a) - cu.indexOf(b));
  rt.placingVia = { type: "micro", toLayer: target, span, diameter: size, drill };
  sizesOf(ctx).setActiveLayer(target); S.layer = rt.layer;
  if (rt.cursor) updateHead(ctx);
  refreshChip(ctx); ctx.requestRender(); return true;
}
/** recordPendingStackViaPos, after a fix: the via of the drop lands where the trace ended (the route's new start). */
export function noteStackViaFixed(rt: Route, placedVia: boolean) {
  const rs = routeStacks.get(rt); if (!rs || !rs.awaiting) return;
  if (placedVia && rs.pending.length) rs.pending[rs.pending.length - 1].pos = rt.last.slice();
  if (!rt.placingVia) rs.awaiting = false;
}
/**
 * finishInteractive, after the route is on the board: the multi-hop microvias the stack drops left become stacks
 * ("Expand Microvia Stacks", joined to the route's undo step); then a queued staggered stack hands over to the stack
 * tool, anchored at the routed head (commitPendingViaStack).
 */
export function finishRouteStacks(ctx: PcbCtx, rt: Route, committed: boolean) {
  const rs = routeStacks.get(rt); if (!rs) return; routeStacks.delete(rt);
  if (rs.pending.length && committed) {
    const ch = expandMultiHopMicrovias(ctx, (v) => matchPendingStackExpansion(ctx.doc, v, rs.preRoute, rs.pending));
    if (ch.length) ctx.commit(ch, "Expand Microvia Stacks", { amend: true });
  }
  if (rs.stagger) { seedViaStackStart(rs.stagger.head, rs.stagger.start, rs.stagger.end); ctx.setTool("viastack"); }
}
