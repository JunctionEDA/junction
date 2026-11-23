// pcb-tools/route-tool.ts — the route tool: start, click, end and abort, vias and the layer picker.
import type { BoardDoc, Hover, NetRef, Obstacle, PcbCtx, Pt, Route, RouteSplit, SnapHit, ViaPlan } from "./types";

/** What the layer picker is opened with: the copper layers, the current one, those it greys out, and where. */
export interface LayerPickerOpts { layers: string[]; current: string; disallow: Set<string>; at: Pt; client: unknown }
/** The layer picker: done(layer) with the picked layer, or done(null) on Cancel. */
export type LayerPicker = (opts: LayerPickerOpts, done: (layer: string | null) => void) => void;
import { runAction } from "./actions";
import { connectedWidth, hoverPoint, netNameOf, otherCopperLayers, sizesOf } from "./app-state";
import { branchChanges, routeCtx, routeDoc, updateHead } from "./branch";
import { addedChange, replacedChange } from "./changes";
import { padAt } from "./convert";
import { copperOf, openForm, settingsOf } from "./dialogs";
import { dpClick, dpFix, dpSetLayer, dpToggleVia, dpUndoLeg } from "./diffpair";
import { padCopperLayers, viaLayers } from "./distances";
import { refreshChip } from "./dom";
import { hitTestItem, pointInPoly } from "./hit";
import { netTable } from "./netlist";
import { hasNet, netOf, sameNet } from "./nets";
import { viaNode } from "./nodes";
import { removeRedundant } from "./redundant";
import { fixHead, leadingRatline, routeHighlight, routeUnhighlight } from "./route-fix";
import { netUnder, padsOf } from "./route-geom";
import { RM_MARK } from "./router-settings";
import { DBL_MS, HIT_MM, K, S, lastCtx } from "./state";
import { initialDir, newTracer, trailAdd } from "./tracer";
import { clone, layerOf, pt, r6, samePt } from "./util";
import { pathHits, routeObstacles, routerWorld } from "./walkaround";
import { evalRuleConstraint } from "./dru";
import { netClearance, netclassName, netclassOf } from "./drc";
import { pinnedOpt, routedRuleItem } from "./rule-resolver";

/** ROUTER::CommitRouting: the route's branch onto the board as one undo step ("Routing", PNS_KICAD_IFACE::Commit). */
export function commitRoute(ctx: PcbCtx, rt: Route) {
  let b = routeDoc(ctx, rt); if (b === ctx.doc) return false;
  b = removeRedundant(ctx.doc, b, rt);   // DIFF_PAIR_PLACER::FixRoute runs removeLoops on both lines too
  const changes = branchChanges(ctx.doc, b); if (!changes.length) return false;
  ctx.commit(changes, "Routing", rt.amend ? { amend: true } : undefined); return true;   // amend: SetCommitFlags( APPEND_UNDO ) after Continue From End
}
/** ROUTER_TOOL::finishInteractive: frame()->SetActiveLayer( m_originalActiveLayer ), after every route, finished or aborted. */
export function restoreActiveLayer(ctx: PcbCtx | null, rt: Route) {
  const l = rt.originalLayer; if (!l) return;
  S.layer = l; if (ctx) sizesOf(ctx).setActiveLayer(l); else if (K.pcbSizes) K.pcbSizes.state.setActiveLayer(l);
}
/** A MINOPTMAX constraint and the name of the rule that gave it (DRC_CONSTRAINT::GetName). */
export interface SizeRule { min: number | null; opt: number | null; max: number | null; name: string }
/**
 * DRC_ENGINE::EvalRules( TRACK_WIDTH / CLEARANCE / DIFF_PAIR_GAP ) for a dummy track of `net` on `layer` (B: the
 * coupled net's track for a pair): the last custom rule that matches, else the netclass's implicit rule: clearance
 * min, track width min = board minimum and opt = the class width ("netclass '%s' diff pair" for a pair's width),
 * diff pair gap min = board minimum clearance and opt = the class gap.
 */
export function trackRule(ctx: PcbCtx, type: "clearance" | "track_width" | "diff_pair_gap", net: string, layer: string, coupled?: string | null): SizeRule {
  const s = settingsOf(ctx); const d = S.dru;
  if (d && d.rules.length && ctx.doc) {
    const h = evalRuleConstraint(d.rules, type, ctx.doc, s, routedRuleItem({ net, layer }), coupled != null ? routedRuleItem({ net: coupled, layer }) : null);
    if (h) return { min: h.min, opt: h.opt, max: h.max, name: h.name };
  }
  const nc = netclassOf(s, net) as Record<string, number | undefined>, name = netclassName(s, net);
  if (type === "clearance") return { min: netClearance(s, net), opt: null, max: null, name: `netclass '${name}'` };
  if (type === "diff_pair_gap") return { min: s.minClearance || 0, opt: nc.diff_pair_gap != null ? nc.diff_pair_gap : null, max: null, name: `netclass '${name}'` };
  if (coupled != null) return { min: s.minTrackWidth || 0, opt: nc.diff_pair_width != null ? nc.diff_pair_width : null, max: null, name: `netclass '${name}' diff pair` };
  return { min: s.minTrackWidth || 0, opt: nc.track_width != null ? nc.track_width : s.trackWidth, max: null, name: `netclass '${name}'` };
}
/** The routing clearance the message panel shows: the rule's min when it reaches the board minimum, else the minimum. */
export function sizeClearance(ctx: PcbCtx, rt: Route, layer: string) {
  const min = settingsOf(ctx).minClearance || 0; const c = trackRule(ctx, "clearance", (rt.net && rt.net.name) || "", layer);
  if (c.min != null && c.min >= min) { rt.clearance = c.min; rt.clearanceSource = c.name; } else { rt.clearance = min; rt.clearanceSource = "board minimum clearance"; }
}
/** PNS_KICAD_IFACE_BASE::ImportSizes' sources for a new route: the start's clearance rule and where the width came from. */
export function importSizeSources(ctx: PcbCtx, rt: Route, usedConnected: boolean) {
  sizeClearance(ctx, rt, rt.layer);
  const R = sizesOf(ctx); const minW = settingsOf(ctx).minTrackWidth || 0;
  if (usedConnected) { rt.widthSource = "existing track"; return; }
  if (R.useNetclassTrack) {
    const w = trackRule(ctx, "track_width", (rt.net && rt.net.name) || "", rt.layer);
    rt.widthSource = w.opt != null && Math.abs(rt.width - w.opt) < 1e-9 ? w.name : "board minimum track width";
  } else rt.widthSource = Math.abs(rt.width - R.currentTrackWidth()) < 1e-9 || Math.abs(rt.width - minW) >= 1e-9 ? "user choice" : "board minimum track width";
}
/**
 * ROUTER_TOOL::updateSizesAfterRouterEvent, after a click, a via's layer switch or a layer command: CLEARANCE and
 * TRACK_WIDTH (and for a pair its width and gap) evaluated for a dummy track on the target layer.  The width changes
 * when the toolbar follows the netclass or the current width is out of the new range; LINE_PLACER::UpdateSizes
 * then puts it on the head only when the width is explicit or nothing is placed yet from a start that is no track.
 */
export function resizeAfterEvent(ctx: PcbCtx, rt: Route, layer: string) {
  const s = settingsOf(ctx); const R = sizesOf(ctx); const net = (rt.net && rt.net.name) || "";
  const minW = s.minTrackWidth || 0, minC = s.minClearance || 0;
  const explicit = !R.useConnectedWidth || !!R.tempOverride;   // SetTrackWidthIsExplicit( !m_UseConnectedTrackWidth || m_TempOverrideTrackWidth )
  const out = (v: number, c: SizeRule, floor: number) => v < floor || (c.min != null && v < c.min) || (c.max != null && v > c.max);
  sizeClearance(ctx, rt, layer);
  if (rt.dp && rt.dpSizes && rt.netN) {
    if (!(R.useNetclassDiffPair || !explicit)) return;
    const d = rt.dpSizes, netN = rt.netN.name || ""; let changed = false;
    const w = trackRule(ctx, "track_width", net, layer, netN), wp = pinnedOpt(w);
    if (w.min != null || w.opt != null || w.max != null) {
      // DIFF_PAIR_PLACER::UpdateSizes: an inherited width is kept once something is fixed unless the width is explicit
      if ((R.useNetclassDiffPair || out(d.width, w, minW)) && (explicit || !rt.dpFixed)) { const v = Math.max(minW, wp ?? 0); if (v !== d.width) { d.width = v; changed = true; } }
      d.widthSource = wp != null && Math.abs(d.width - wp) < 1e-9 ? w.name : "board minimum track width";
    }
    const g = trackRule(ctx, "diff_pair_gap", net, layer, netN), gp = pinnedOpt(g);
    if (g.min != null || g.opt != null || g.max != null) {
      if (R.useNetclassDiffPair || out(d.gap, g, minC)) { const v = Math.max(minC, gp ?? 0); if (v !== d.gap) { d.gap = v; changed = true; } }
      d.gapSource = gp != null && Math.abs(d.gap - gp) < 1e-9 ? g.name : "board minimum clearance";
    }
    if (changed) { d.h = (d.gap + d.width) / 2; rt.width = d.width; rt.dpObs = null; rt.obs = null; }
    return;
  }
  if (!(R.useNetclassTrack || !explicit)) return;
  const w = trackRule(ctx, "track_width", net, layer), wp = pinnedOpt(w);
  let width = rt.width;
  if (R.useNetclassTrack || out(width, w, minW)) width = Math.max(minW, wp ?? 0);
  if ((explicit || (!rt.stages.length && rt.startKind !== "track")) && width !== rt.width) { rt.width = width; rt.obs = null; rt.bdoc = null; }
  rt.widthSource = wp != null && Math.abs(width - wp) < 1e-9 ? w.name : Math.abs(width - minW) < 1e-9 ? "board minimum track width" : "existing track";
}
/** End the route: fix the head when asked (End / double click: FixRoute( forceFinish )), then commit everything fixed. */
export function endRoute(ctx: PcbCtx, fixCurrent: boolean): boolean {
  const rt = S.route; if (!rt) return false;
  if (rt.dp) { if (fixCurrent && rt.dpLines) dpFix(ctx, { finish: true }); }
  else if (fixCurrent && ((rt.els && rt.els.length) || rt.placingVia)) fixHead(ctx, { finish: true });
  S.route = null; const committed = commitRoute(ctx, rt); restoreActiveLayer(ctx, rt); routeUnhighlight(ctx, rt); sizesOf(ctx).endRoute(); refreshChip(ctx); ctx.requestRender();
  if (S.routeQueue && routeQueueNext) { const next = routeQueueNext; Promise.resolve().then(() => next(ctx)); }   // RouteSelected: the next one
  return committed;
}
/** route-selected.ts's routeNext, handed over at load (the modules import each other). */
let routeQueueNext: ((ctx: PcbCtx) => unknown) | null = null;
export function setRouteQueueNext(fn: (ctx: PcbCtx) => unknown) { routeQueueNext = fn; }
/** Escape / another tool (ROUTER::AbortPlacement): the route and everything fixed in it are dropped. */
export function abortRoute(ctx: PcbCtx) {
  const rt = S.route; if (!rt) return; S.route = null; S.violations = null; S.routeQueue = null;   // RouteSelected stops (m_cancelled)
  restoreActiveLayer(ctx, rt);
  if (ctx) { routeUnhighlight(ctx, rt); sizesOf(ctx).endRoute(); refreshChip(ctx); ctx.requestRender(); } else if (K.pcbSizes) K.pcbSizes.state.endRoute();
}
/**
 * Backspace / Delete / Ctrl+Z while routing (ROUTER::UndoLastSegment → LINE_PLACER::UnfixRoute): the last fixed stage
 * comes off the branch and routing carries on from where it began.  Silent when nothing is fixed.
 */
export function undoRouteLeg(ctx: PcbCtx) {
  if (S.route && S.route.dp) return dpUndoLeg(ctx);
  const rt = S.route; const st = rt && rt.stages.pop(); if (!st) return false;
  rt.bdoc = null; rt.obs = null;
  rt.last = st.from.slice(); rt.net = st.net; rt.netKey = st.netKey; rt.startIds = st.startIds || []; rt.split = st.split || null; rt.placingVia = null;
  if (st.layer !== rt.layer) { rt.layer = st.layer; S.layer = st.layer; sizesOf(ctx).setActiveLayer(st.layer); }
  rt.tracer = newTracer(rt.width, rt.stages.length ? st.dir : -1, initialDir()); trailAdd(rt.tracer, rt.last); rt.head = [rt.last.slice()]; rt.els = []; rt.target = rt.last.slice();
  rt.chained = rt.stages.length > 0 && !rt.stages[rt.stages.length - 1].placingVia;
  if (rt.cursor) updateHead(ctx);
  routeHighlight(ctx, rt); refreshChip(ctx); ctx.requestRender(); return true;
}
/** The segment on `layer` under (x, y) with the point projected onto its centre line: where a route started on a track begins. */
export function trackUnder(doc: BoardDoc, x: number, y: number, layer: string) {
  const it = hitTestItem(doc, x, y, HIT_MM, (c) => c.kind === "segment" && layerOf(c.node) === layer); if (!it || it.kind !== "segment" || layerOf(it.node) !== layer) return null;
  const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) return null;
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const k = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
  return { item: it, point: [r6(a[0] + k * dx), r6(a[1] + k * dy)] };
}
/**
 * ROUTER_TOOL::getStartLayer: the layer a route starting at the hover begins on.  The active layer when the start item is
 * on it (or there is none); else the item's own layer: a track end / body on another shown copper layer, or a pad or
 * via that does not reach the active layer.
 */
export function startLayerOf(ctx: PcbCtx, hv: Hover, mm: Pt | null): string | null {
  const snap = hv.snap as SnapHit | null;
  if (snap && snap.kind !== "anchor") {
    if (snap.kind === "pad" || snap.kind === "via") {
      if (snap.onLayer) return snap.onLayer;
      return null;
    }
    return snap.onLayer || null;
  }
  const q = mm || [hv.x, hv.y];
  if (trackUnder(ctx.doc, q[0], q[1], S.layer)) return S.layer;
  for (const l of otherCopperLayers(ctx, S.layer)) if (trackUnder(ctx.doc, q[0], q[1], l)) return l;
  return null;
}
/** The obstacles in violation, shown as KiCad's router does (pure green over a clearance halo) until the cursor moves on. */
export function showViolations(obs: Obstacle[], at: Pt) { S.violations = obs.length ? { obs, at: at.slice() } : null; }
/** QueryHoverItems' non-routable hits at the point: the refusal of ROUTER::isStartingPointRoutable for the item kinds it names. */
export function startItemRefusal(doc: BoardDoc, p: Pt, q: Pt, layer: string): string | null {
  // a routable item (a pad, via or track with copper on the layer) under the cursor: failureReason = wxEmptyString; break
  const pad = padAt(doc, q[0], q[1], layer);
  if (pad && pad.pad.type !== "np_thru_hole") return null;
  const cu = copperOf(doc);
  if (hitTestItem(doc, q[0], q[1], HIT_MM, (c) => ((c.kind === "segment" || c.kind === "arc") && layerOf(c.node) === layer) || (c.kind === "via" && viaLayers(c.node, cu).has(layer)))) return null;
  let reason: string | null = null;
  const hole = pad || padAt(doc, q[0], q[1], null);
  if (hole && hole.pad.type === "np_thru_hole") reason = "Cannot start routing from a non-plated hole.";
  for (const k of routerWorld(doc).keepouts) {
    if (!k.layers!.has(layer) || !pointInPoly((k.shape as { pts: Pt[] }).pts, p[0], p[1])) continue;
    const z = k.id ? doc.items.get(k.id) : null; const nm = z ? K.kid(z.node, "name") : null; const name = nm ? K.str(nm[1]) : "";
    reason = name ? `Rule area '${name}' disallows tracks.` : "Rule area disallows tracks.";
  }
  // PCB_FIELD_T / PCB_TEXT_T / PCB_TEXTBOX_T on the routing layer
  const t = hitTestItem(doc, q[0], q[1], HIT_MM, (c) => (c.kind === "gr_text" || c.kind === "gr_text_box") && layerOf(c.node) === layer);
  if (t) reason = "Cannot start routing from a text item.";
  else for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue; const b = it.bbox; if (b && (q[0] < b[0] - 5 || q[0] > b[2] + 5 || q[1] < b[1] - 5 || q[1] > b[3] + 5)) continue;
    if ((K.fieldBoxes(it) as unknown as { pts: Pt[]; geom: { layer?: string } }[]).some((f) => f.geom.layer === layer && pointInPoly(f.pts, q[0], q[1]))) { reason = "Cannot start routing from a text item."; break; }
  }
  return reason;
}
/**
 * ROUTER::isStartingPointRoutable and ROUTER_TOOL's start checks: no route from a non-plated hole, inside a rule area
 * that keeps tracks out, from copper text, or where a zero-length track (at the route width, then the board minimum)
 * already violates clearance.  A routable item under the cursor on the layer clears the first three; "Allow DRC
 * violations" in Highlight collisions (AllowDRCViolations) clears them all.  Returns the refusal message or null.
 */
export function startRefusal(ctx: PcbCtx, p: Pt, mm: Pt, net: NetRef, width: number, layer: string, own: Set<string>, snapped: boolean) {
  const doc = ctx.doc; const q = mm || p;
  if (!/\.Cu$/.test(layer)) return "Tracks on Copper layers only.";   // ROUTER_TOOL::prepareInteractive, before StartRouting
  if (S.rs.mode === RM_MARK && S.rs.can_violate_drc) return null;   // Settings().AllowDRCViolations()
  const item = startItemRefusal(doc, p, q, layer); if (item) return item;
  const s = settingsOf(ctx); const key = netTable(doc).key(net);
  const O = routeObstacles(doc, s, key, layer, key ? null : own);
  let hits = pathHits(O, [p], width / 2);
  if (hits.length && s.minTrackWidth > 0) hits = pathHits(O, [p], s.minTrackWidth / 2);
  if (hits.length) { showViolations(hits, p); return "The routing start point violates DRC."; }
  return null;
}
export function routeClick(ctx: PcbCtx, hv: Hover, mm: Pt, opts?: { enter?: boolean } | null) {
  if ((S.route && S.route.dp) || (!S.route && S.modTool === "routediff")) { dpClick(ctx, hv, mm, opts as { enter?: boolean } | undefined); return; }
  opts = opts || {}; const now = Date.now(); let p = [hv.x, hv.y];
  S.violations = null;
  if (!S.route) {
    let net = (hv.snap ? hv.snap.net : netUnder(ctx.doc, hv.x, hv.y, S.layer)) as NetRef;   // a grid snap carries none: undefined, as before
    let split: RouteSplit | null = null, startIds: string[] = [], startKind = hv.snap ? hv.snap.kind : null;
    // ROUTER_TOOL::getStartLayer: a start item that is not on the active layer moves the route (and the active layer) to its layer
    const startOn = startLayerOf(ctx, hv, mm); const originalLayer = S.layer;   // m_originalActiveLayer
    if (startOn && startOn !== S.layer) setLayer(ctx, startOn);
    if (!hv.snap) { const on = trackUnder(ctx.doc, mm ? mm[0] : hv.x, mm ? mm[1] : hv.y, S.layer); if (on) { p = on.point; net = netOf(on.item.node); split = { id: on.item.id, point: p.slice(), node: clone(on.item.node) }; startIds.push(on.item.id); startKind = "track"; } }   // started on a track: its centre line and its net
    else if (hv.snap.kind !== "pad") { const it = hitTestItem(ctx.doc, hv.x, hv.y, HIT_MM); if (it) startIds.push(it.id); }
    const R = sizesOf(ctx); const connected = connectedWidth(ctx.doc, p, S.layer, mm || p);
    const width = R.routeWidth(netNameOf(ctx, net), connected);   // ImportSizes: the connected track, the net's class, or the selected width
    const refusal = startRefusal(ctx, p, mm, net, width, S.layer, new Set(startIds), !!hv.snap);
    if (refusal) { ctx.toast(refusal); ctx.requestRender(); return; }
    const netKey = netTable(ctx.doc).key(net);
    S.route = { start: p.slice(), startLayer: S.layer, startKind, startSpan: hv.snap && (hv.snap.kind === "pad" || hv.snap.kind === "via") ? ((hv.snap as SnapHit).layers || null) : null,
      last: p, target: p.slice(), cursor: p.slice(), head: [p.slice()], els: [], reached: true, net, netKey, layer: S.layer, width, connected, diagFirst: !!S.rs.start_diagonal, clickT: now, clickAt: p.slice(),
      stages: [], split, startIds, ratline: null, placingVia: null, chained: false, collisions: null, shove: null,
      tracer: newTracer(width, -1, initialDir()), keepHighlight: !!netKey && S.highlightNet === netKey, originalLayer };
    trailAdd(S.route!.tracer, p);
    importSizeSources(ctx, S.route!, !!(R.useConnectedWidth && !R.tempOverride && connected && connected > 0));
    if (R.activeLayer !== S.layer) R.setActiveLayer(S.layer);
    routeHighlight(ctx, S.route); S.route!.ratline = leadingRatline(ctx, S.route!);
    refreshChip(ctx); ctx.requestRender(); return;
  }
  const rt = S.route;
  const dbl = !opts.enter && now - rt.clickT < DBL_MS && Math.hypot(p[0] - rt.clickAt[0], p[1] - rt.clickAt[1]) < 0.3;
  rt.clickT = now; rt.clickAt = p.slice();
  if (dbl) { endRoute(ctx, true); return; }
  if (!samePt(p, rt.cursor || rt.last)) { rt.cursor = p.slice(); updateHead(ctx); }
  const rc = routeCtx(ctx, rt);
  // landing on the routed net (a pad, via or track end) ends the trace once the head reaches it, as in KiCad
  const onNet = hv.snap && rt.netKey && sameNet(hv.snap.net, rt.net);
  const lands = onNet && rt.reached && samePt(rt.target, [hv.x, hv.y]);
  let endSplit: RouteSplit | null = null;
  if (lands && hv.snap!.kind === "trackMid" && !(rt.split && rt.split.id === (hv.snap as SnapHit).id)) { const it = rc.doc.items.get((hv.snap as SnapHit).id!); if (it) endSplit = { id: it.id, point: [hv.x, hv.y], node: clone(it.node) }; }
  const markEnd = S.rs.mode === RM_MARK && hv.snap && samePt(rt.target, [hv.x, hv.y]) ? hv.snap as SnapHit : null;
  const placingVia = !!rt.placingVia;
  // LINE_PLACER::FixRoute: an end item of the routed net is the real end, every segment is fixed
  const realEnd = !!(lands || (markEnd && hasNet(markEnd.net) && rt.netKey && sameNet(markEnd.net, rt.net)));
  if (!fixHead(ctx, { endSplit, snap: markEnd, finish: realEnd })) { ctx.requestRender(); return; }
  if (realEnd && !placingVia) { endRoute(ctx, false); return; }
  resizeAfterEvent(ctx, rt, rt.layer);   // switchLayerOnViaPlacement / updateSizesAfterRouterEvent( current layer )
  if (rt.cursor) updateHead(ctx);
  routeHighlight(ctx, rt); refreshChip(ctx); ctx.requestRender();
}
/** The through via's layer span: the outer copper layers of the board. */
export function viaSpan(doc: BoardDoc) { const cu = K.pcbSizes.copperStack(copperOf(doc)); return [cu[0], cu[cu.length - 1]]; }
/** The microvia's sizes: the net's class microvia, else KiCad's netclass defaults (0.3 / 0.1 mm). */
export function microViaSize(ctx: PcbCtx, net: NetRef) {
  // the microvia fields ride on the class when the project has them (they are not in NetClassValues)
  const R = sizesOf(ctx); const nc = (R.netclassOf ? R.netclassOf(netNameOf(ctx, net)) : null) as { uvia_diameter?: number; uvia_drill?: number } | null;
  return { diameter: nc && nc.uvia_diameter! > 0 ? nc.uvia_diameter! : 0.3, drill: nc && nc.uvia_drill! > 0 ? nc.uvia_drill! : 0.1 };
}
/**
 * ROUTER_TOOL::handleLayerSwitch for a via command: the via's type, sizes and the layer it leads to.  A through via
 * goes to the layer of the nearest ratsnest anchor (the layer pair when that anchor is through-hole or on the current
 * layer, or when there is none); blind/buried and micro vias go across the layer pair.  `target` is a picked layer
 * (the Select Layer variants).  Returns the via or a refusal message.
 */
export function viaPlan(ctx: PcbCtx, rt: Route, type: string, target?: string | null): ViaPlan | string {
  const R = sizesOf(ctx); const cur = rt.layer; const [pTop, pBot] = R.layerPair || ["F.Cu", "B.Cu"];
  const doc = routeDoc(ctx, rt); const stack = K.pcbSizes.copperStack(copperOf(doc)); const F = stack[0], B = stack[stack.length - 1];
  if (type !== "through" && target && ((target === B && cur === F) || (target === F && cur === B))) type = "through";   // a blind via across the whole board is a through via
  const paired = (x: string, p0: string, p1: string) => (x === p0 ? p1 : x === p1 ? p0 : p0);   // SIZES_SETTINGS::PairedLayer, else GetLayerTop()
  let a = cur, b = target || null, next: string;
  if (b) next = b;
  else if (type === "through") {
    const rl = rt.ratAnchor;
    if (!rl || !rl.layers.length) { a = pTop; b = pBot; next = paired(cur, pTop, pBot); }
    else if (rl.through) { b = cur === pBot ? pTop : cur === pTop ? pBot : pTop; next = b; }
    else { const other = K.pcbSizes.copperStack(rl.layers)[0]; b = other === cur ? paired(cur, pTop, pBot) : other; next = b; }
  } else {
    if (cur === pTop || cur === pBot) { a = pTop; b = pBot; } else b = pTop;
    if (a === b) return "Via needs 2 different layers.";
    next = paired(cur, a, b);
  }
  if (next === cur) { if (type !== "through") return "Via needs 2 different layers."; next = cur === F ? B : F; }
  const size = type === "micro" ? microViaSize(ctx, rt.net) : R.routeVia(netNameOf(ctx, rt.net));
  const span = type === "through" ? [F, B] : [a, b].sort((x, y) => stack.indexOf(x) - stack.indexOf(y));
  return { type, toLayer: next, span, diameter: size.diameter, drill: size.drill };
}
/**
 * ROUTER_TOOL::onViaCommand: the first via command attaches a via to the head's end (it follows the cursor and is
 * checked with it, ToggleViaPlacement); the same command again takes it off.  The next click fixes trace and via
 * and routing goes on on the via's other layer.  With no route yet (the Route tool idle) only the active layer toggles.
 */
export function toggleViaPlacement(ctx: PcbCtx, type?: string, target?: string | null) {
  const rt = S.route;
  if (rt && rt.dp) return dpToggleVia(ctx, type, target!);
  if (!rt) { if (S.modTool === "routediff") return true; startWithVia(ctx); return true; }
  if (rt.placingVia && !target) { rt.placingVia = null; S.layer = rt.layer; sizesOf(ctx).setActiveLayer(rt.layer); if (rt.cursor) updateHead(ctx); refreshChip(ctx); ctx.requestRender(); return true; }
  const plan = viaPlan(ctx, rt, type!, target);
  if (typeof plan === "string") { ctx.toast(plan); return true; }
  rt.placingVia = plan; sizesOf(ctx).setActiveLayer(plan.toLayer); S.layer = rt.layer;
  if (rt.cursor) updateHead(ctx);
  refreshChip(ctx); ctx.requestRender(); return true;
}
/** ACT_PlaceThroughVia with the Route tool idle (ROUTER_TOOL::MainLoop): PCB_ACTIONS::layerToggle, nothing else. */
export function startWithVia(ctx: PcbCtx) { runAction("layerToggle", ctx); }
/** The Select Layer and Place … Via commands: KiCad's layer picker at the track end, then the via to that layer. */
export function selectLayerAndPlaceVia(ctx: PcbCtx, type: string) {
  const rt = S.route; if (!rt) return false;
  if (rt.placingVia) return toggleViaPlacement(ctx);   // onViaCommand: any via action with a via armed takes it off
  const doc = routeDoc(ctx, rt); const cu = K.pcbSizes.copperStack(copperOf(doc));
  const disallow = new Set(type === "through" ? [] : [rt.layer]);
  const at = rt.target || rt.last;
  layerPickerImpl({ layers: cu, current: rt.layer, disallow, at, client: S.client }, (layer: string | null) => {
    if (!layer || !S.route || S.route !== rt) return;
    if (type !== "through" && layer === rt.layer) return;
    if (rt.placingVia) rt.placingVia = null;
    toggleViaPlacement(lastCtx || ctx, type, layer);
  });
  return true;
}
// ---------------------------------------------------------------- DRAWING_TOOL::DrawVia (VIA_PLACER)
/** The via the Place Via tool would put down (VIA_PLACER::CreateItem): the current via size, through the board. */
export function placedVia(ctx: PcbCtx, net?: NetRef | null) { const v = sizesOf(ctx).routeVia(netNameOf(ctx, net || null)); return { diameter: v.diameter, drill: v.drill, layers: viaSpan(ctx.doc) }; }
/** FindSnapTrack: the track on the via's layers within ( track width + via width ) / 2 of the point, the nearest by its segment. */
export function viaSnapTrack(doc: BoardDoc, p: Pt, diameter: number, layers: string[]) {
  const span = new Set(viaSpanLayersOf(doc, layers)); let best: KItem | null = null, bd = Infinity;
  for (const it of doc.items.values()) {
    if ((it.kind !== "segment" && it.kind !== "arc") || !span.has(layerOf(it.node))) continue;
    const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) continue;
    const w = K.num((K.kid(it.node, "width") || [0, 0.25])[1], 0.25);
    if (it.kind === "segment") { if (distToSeg(p, a, b) > (w + diameter) / 2) continue; }
    else if (!it.geom.some((g) => K.geomHit(g, p[0], p[1], diameter / 2))) continue;
    const d = distToSeg(p, a, b); if (d < bd) { bd = d; best = it; }
  }
  return best;
}
const distToSeg = (p: Pt, a: Pt, b: Pt) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const k = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0; return Math.hypot(p[0] - (a[0] + k * dx), p[1] - (a[1] + k * dy)); };
/** The copper layers a via spans, outer pair inclusive. */
function viaSpanLayersOf(doc: BoardDoc, pair: string[]) { const cu = K.pcbSizes.copperStack(copperOf(doc)); const i = cu.indexOf(pair[0]), j = cu.indexOf(pair[pair.length - 1]); return i < 0 || j < 0 ? pair : cu.slice(Math.min(i, j), Math.max(i, j) + 1); }
/** FindSnapPad: a pad on the via's layers that the point is inside. */
export function viaSnapPad(doc: BoardDoc, p: Pt, layers: string[]) {
  const span = viaSpanLayersOf(doc, layers);
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint" || !it.bbox || p[0] < it.bbox[0] || p[0] > it.bbox[2] || p[1] < it.bbox[1] || p[1] > it.bbox[3]) continue;
    for (const pad of padsOf(it)) if (span.some((l) => padOnCopper(pad.layers, l)) && padHit(pad, p)) return pad;
  }
  return null;
}
const padOnCopper = (ls: string[], layer: string) => ls.some((l) => l === layer || l === "*.Cu" || l === "F&B.Cu");
const padHit = (pad: { x: number; y: number; rot: number; w: number; h: number }, p: Pt) => { const a = -pad.rot * Math.PI / 180, dx = p[0] - pad.x, dy = p[1] - pad.y; const lx = dx * Math.cos(a) + dy * Math.sin(a), ly = -dx * Math.sin(a) + dy * Math.cos(a); return Math.abs(lx) <= pad.w / 2 && Math.abs(ly) <= pad.h / 2; };
/** PCB_SHAPE::GetPosition as FindSnapGraphic ranks by it: an arc's or circle's centre, a polygon's first corner, else the start. */
function shapePosition(it: KItem): Pt | null {
  const n = it.node;
  if (it.kind === "gr_circle") return pt(n, "center");
  if (it.kind === "gr_arc") { const s = pt(n, "start"), m = pt(n, "mid"), e = pt(n, "end"), a = s && m && e ? K.arcFrom3(s, m, e) : null; return a ? [a.x, a.y] : s; }
  if (it.kind === "gr_poly" || it.kind === "gr_curve") return K.ptsOf(n)[0] || null;
  return pt(n, "start");
}
/** FindSnapGraphic: a graphic on one of the via's copper layers within half the via's width of the point, the nearest by position. */
export function viaSnapGraphic(doc: BoardDoc, p: Pt, diameter: number, layers: string[]) {
  const span = new Set(viaSpanLayersOf(doc, layers)); let best: KItem | null = null, bd = Infinity;
  for (const it of doc.items.values()) {
    if (!/^gr_(line|rect|circle|arc|poly|curve)$/.test(it.kind) || !span.has(layerOf(it.node))) continue;
    if (!it.geom.some((g) => K.geomHit(g, p[0], p[1], diameter / 2))) continue;
    const q = shapePosition(it), d = q ? Math.hypot(q[0] - p[0], q[1] - p[1]) : Infinity; if (d < bd || !best) { bd = d; best = it; }
  }
  return best;
}
/**
 * PCB_GRID_HELPER::AlignToSegment: the grid point nearest the cursor, pulled onto the segment where a grid line or a
 * grid diagonal through it crosses the segment, or onto the nearer end of the segment when that is closer to the pointer.
 */
export function alignToSegment(ctx: PcbCtx, p: Pt, a: Pt, b: Pt): Pt {
  const g = ctx.snapOn && ctx.snap ? ctx.snap(p.slice()) : p.slice();
  const d: Pt = [b[0] - a[0], b[1] - a[1]]; const cand: Pt[] = [];
  for (const dir of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    const den = d[0] * dir[1] - d[1] * dir[0]; if (Math.abs(den) < 1e-12) continue;
    const t = ((g[0] - a[0]) * dir[1] - (g[1] - a[1]) * dir[0]) / den; const q: Pt = [a[0] + d[0] * t, a[1] + d[1] * t];
    if (distToSeg(q, a, b) <= 2e-6) cand.push(q);   // on the segment itself (c_gridSnapEpsilon_sq, 2 nm)
  }
  let nearest = g, best = Infinity;
  for (const q of [a, b]) { const dd = Math.hypot(q[0] - p[0], q[1] - p[1]); if (dd < best) { best = dd; nearest = q.slice(); } }
  for (const q of cand) { const dd = Math.hypot(q[0] - g[0], q[1] - g[1]); if (dd < best) { best = dd; nearest = q; } }
  return [r6(nearest[0]), r6(nearest[1])];
}
const polyArea = (pts: Pt[]) => { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };
/**
 * VIA_PLACER::SnapItem: from the mouse (not the grid point), the via goes onto the track under it (AlignToSegment), else
 * the centre of the pad under it, else the graphic under it (a filled shape no more than four vias large is replaced at
 * its position, a line by AlignToSegment, an arc at its nearer end, a polygon on its nearest side); Shift turns it off.
 */
export function viaSnapPoint(ctx: PcbCtx, mm: Pt, shift: boolean): Pt {
  const grid: Pt = ctx.snapOn && ctx.snap ? ctx.snap(mm.slice()) : mm.slice();
  if (shift || !ctx.doc) return grid;
  const v = placedVia(ctx), doc = ctx.doc;
  const track = viaSnapTrack(doc, mm, v.diameter, v.layers);
  if (track) return alignToSegment(ctx, mm, pt(track.node, "start")!, pt(track.node, "end")!);
  const pad = viaSnapPad(doc, mm, v.layers); if (pad) return [pad.x, pad.y];
  const sh = viaSnapGraphic(doc, mm, v.diameter, v.layers);
  if (sh) {
    const n = sh.node, fill = K.kid(n, "fill"), filled = !!fill && fill[1] !== "no" && fill[1] !== "none", pos = shapePosition(sh);
    if (filled) {
      const outline = sh.kind === "gr_circle" ? null : sh.kind === "gr_rect" ? (() => { const a = pt(n, "start")!, b = pt(n, "end")!; return [a, [b[0], a[1]], b, [a[0], b[1]]] as Pt[]; })() : K.ptsOf(n);
      const c = pt(n, "center"), e = pt(n, "end");
      const area = sh.kind === "gr_circle" && c && e ? Math.PI * ((e[0] - c[0]) ** 2 + (e[1] - c[1]) ** 2) : outline ? polyArea(outline) : 0;
      return Math.PI * (v.diameter / 2) ** 2 * 4 > area && pos ? [r6(pos[0]), r6(pos[1])] : grid;
    }
    if (sh.kind === "gr_line") return alignToSegment(ctx, mm, pt(n, "start")!, pt(n, "end")!);
    if (sh.kind === "gr_arc") { const s = pt(n, "start")!, e = pt(n, "end")!; return Math.hypot(e[0] - mm[0], e[1] - mm[1]) < Math.hypot(s[0] - mm[0], s[1] - mm[1]) ? e : s; }
    if (sh.kind === "gr_poly") {
      const ps = K.ptsOf(n); let bs: [Pt, Pt] | null = null, bd = Infinity;
      for (let i = 0; i < ps.length; i++) { const a = ps[i], b = ps[(i + 1) % ps.length], d = distToSeg(mm, a, b); if (d < bd) { bd = d; bs = [a, b]; } }
      return bs ? alignToSegment(ctx, mm, bs[0], bs[1]) : pos || grid;
    }
    return pos ? [r6(pos[0]), r6(pos[1])] : grid;
  }
  return grid;
}
/** VIA_PLACER::findStitchedZoneNet: the nets of the filled zones (rule areas apart) under the via on its visible layers. */
export function viaZoneNets(ctx: PcbCtx, p: Pt, layers: string[]): NetRef[] {
  const doc = ctx.doc, visible = new Set(otherCopperLayers(ctx, ""));   // GetVisibleLayers() & the via's layer set
  const span = viaSpanLayersOf(doc, layers).filter((l) => visible.has(l)); const NT = netTable(doc); const out = new Map<string, NetRef>();
  for (const it of doc.items.values()) {
    if (it.kind !== "zone" || K.kid(it.node, "keepout")) continue;
    for (const fp of K.kids(it.node, "filled_polygon")) {
      const l = K.kid(fp, "layer"); if (!l || !span.includes(K.str(l[1]))) continue;
      const pts = K.ptsOf(fp); if (pts.length >= 3 && pointInPoly(pts, p[0], p[1])) { const n = netOf(it.node); out.set(NT.key(n), n); }
    }
  }
  return [...out.values()];
}
/** CheckItemDRCViolation for the via: whatever copper, hole, keepout or edge it would violate on the layers it spans. */
export function viaPlaceHits(ctx: PcbCtx, at: Pt, diameter: number, layers: string[], net: NetRef | null) {
  const doc = ctx.doc, s = settingsOf(ctx), key = netTable(doc).key(net); const out: Obstacle[] = [];
  for (const L of viaSpanLayersOf(doc, layers)) for (const ob of pathHits(routeObstacles(doc, s, key, L, null), [at], diameter / 2)) if (!out.includes(ob)) out.push(ob);
  return out;
}
/** The net chooser of selectPossibleNetsByPopupMenu ("Select Net:"); tests swap it. */
export type NetChooser = (nets: NetRef[], done: (net: NetRef | null) => void) => void;
let netChooser: NetChooser = (nets, done) => {   // Cancel (or Escape) places nothing
  openForm({ title: "Select Net:", fields: [{ k: "net", label: "", type: "radio", value: "0", options: nets.map((n, i) => [String(i), n.name || "<no net>"]) }],
    apply: (v: { net: string }) => { done(nets[+v.net] || null); } });
};
export function setNetChooser(f: NetChooser) { netChooser = f; }
/**
 * VIA_PLACER::PlaceItem ("Place via"): the via takes the net of the track, else the pad, else a netted graphic under it,
 * else of the filled zone there (several: the "Select Net:" menu; then it is a free via); a spot that violates DRC is
 * refused with "Via location violates DRC." unless the router allows violations; the track under the via is broken in
 * two at it (not with Shift held, which turned snapping off).
 */
export function placeVia(ctx: PcbCtx, hv: Hover, mm?: Pt | null, ev?: { shiftKey?: boolean } | null) {
  const doc = ctx.doc, shift = !!(ev && ev.shiftKey);
  const at: Pt = mm ? viaSnapPoint(ctx, mm, shift) : [hv.x, hv.y];
  const v0 = placedVia(ctx);
  const track = viaSnapTrack(doc, at, v0.diameter, v0.layers), pad = track ? null : viaSnapPad(doc, at, v0.layers);
  const shape = track || pad ? null : viaSnapGraphic(doc, at, v0.diameter, v0.layers);
  const shapeNet = shape && K.kid(shape.node, "net") ? netOf(shape.node) : null;
  const finish = (net: NetRef, free: boolean) => {
    const v = placedVia(ctx, net);
    if (viaPlaceHits(ctx, at, v.diameter, v.layers, net).length) {
      ctx.toast("Via location violates DRC.");
      if (!S.rs.can_violate_drc) return;
    }
    const node = viaNode(doc, at[0], at[1], v.diameter, v.drill, net, v.layers);
    if (free) node.splice(node.length - 1, 0, ["free", "yes"]);   // PCB_VIA::SetIsFree: (free yes) ahead of the net
    const changes = [addedChange(doc, node, net)];
    // the track under the via becomes two meeting at it, unless the via sits on one of its ends or off its centreline
    if (track && track.kind === "segment" && !shift) {
      const a = pt(track.node, "start")!, b = pt(track.node, "end")!;
      if (!samePt(at, a) && !samePt(at, b) && distToSeg(at, a, b) <= 1e-6) {
        const first = clone(track.node); K.kid(first, "end")!.splice(1, 2, r6(at[0]), r6(at[1]));
        const second = clone(track.node); K.kid(second, "start")!.splice(1, 2, r6(at[0]), r6(at[1])); const u = K.kid(second, "uuid"); if (u) second.splice(second.indexOf(u), 1);
        changes.push(replacedChange(track, first), addedChange(doc, second, netOf(track.node)));
      }
    }
    ctx.commit(changes, "Place via");
  };
  if (track) return finish(netOf(track.node), false);
  if (pad) return finish(pad.net, false);
  if (shapeNet && hasNet(shapeNet)) return finish(shapeNet, false);
  const zn = viaZoneNets(ctx, at, v0.layers);
  if (zn.length === 1) return finish(zn[0], hasNet(zn[0]));
  if (zn.length > 1) { netChooser(zn, (n) => { if (n) finish(n, hasNet(n)); }); return; }   // cancelled: nothing is placed
  finish({ code: 0, name: "" }, false);
}
/**
 * A layer change while routing (PgUp/PgDn, + / -, Toggle Layer, the layer combo): LINE_PLACER::SetLayer moves the head
 * to the layer when nothing is fixed yet and the route starts on a pad or via that spans it (or on nothing); otherwise
 * a via to that layer is armed, placed on the next click.
 */
export function setLayer(ctx: PcbCtx, layer: string) {
  const rt = S.route;
  if (rt && rt.dp) { dpSetLayer(ctx, layer); return; }
  if (rt) {
    if (layer === rt.layer) return;   // handleLayerSwitch: targetLayer == currentLayer returns, an armed via stays
    const spans = !rt.stages.length && (!rt.startKind || ((rt.startKind === "pad" || rt.startKind === "via") && startSpans(ctx, rt, layer)));
    const afterVia = rt.stages.length && !rt.chained;
    if (!rt.placingVia && (spans || afterVia)) {
      rt.layer = layer; S.layer = layer; sizesOf(ctx).setActiveLayer(layer); rt.obs = null;
      resizeAfterEvent(ctx, rt, layer);   // handleLayerSwitch: SwitchLayer, then updateSizesAfterRouterEvent( targetLayer )
      rt.tracer = newTracer(rt.width, -1, initialDir()); trailAdd(rt.tracer, rt.last); rt.head = [rt.last.slice()]; rt.els = [];
      if (rt.cursor) updateHead(ctx); refreshChip(ctx); ctx.requestRender(); return;
    }
    rt.placingVia = null; toggleViaPlacement(ctx, "through", layer); return;
  }
  if (S.gfxLayer !== layer) S.strokeW = null;   // layerChanged: the drawing tools' stroke takes the new layer's default thickness
  if (S.draw && ctx.showLayer) ctx.showLayer(layer);
  S.layer = layer; S.gfxLayer = layer; sizesOf(ctx).setActiveLayer(layer); refreshChip(ctx); ctx.requestRender();
}
/** Whether the route's start pad / via has copper on `layer`. */
export function startSpans(ctx: PcbCtx, rt: Route, layer: string) {
  const doc = ctx.doc; const p = rt.start; const cu = copperOf(doc);
  for (const it of doc.items.values()) {
    const b = it.bbox; if (b && (p[0] < b[0] - 0.01 || p[0] > b[2] + 0.01 || p[1] < b[1] - 0.01 || p[1] > b[3] + 0.01)) continue;
    if (it.kind === "via") { const a = pt(it.node, "at"); if (a && samePt(a, p) && viaLayers(it.node, cu).has(layer)) return true; }
    else if (it.kind === "footprint") for (const pd of padsOf(it)) if (samePt([pd.x, pd.y], p) && padCopperLayers(pd, cu).has(layer)) return true;
  }
  return false;
}
// The layer picker (PCB_EDIT_FRAME::SelectOneLayer) is DOM; the editor installs the real one, the tests a stub.
export let layerPickerImpl: LayerPicker = function (opts, done) { done(null); };
/** pcb.setLayerPicker: the editor installs the real layer picker. */
export function setLayerPickerImpl(fn: LayerPicker) { layerPickerImpl = fn; }

/**
 * ROUTER::Finish (routerAttemptFinish, F while routing): the head is walked to the nearest ratsnest anchor
 * (GetNearestRatnestAnchor) up to five times while it keeps moving; when it gets there on a layer the anchor has, the
 * route is fixed there and ends (FixRoute).  Otherwise the head stays where the walk got to (KiCad warps the mouse
 * there).  False when nothing is routed or there is no anchor to go to.
 */
export function attemptFinish(ctx: PcbCtx): boolean {
  const rt = S.route; if (!rt || rt.dp) return false;
  leadingRatline(ctx, rt); const a = rt.ratAnchor; if (!a) return false;
  const goal: Pt = a.p.slice();
  for (let tries = 5; tries > 0; tries--) { const before = rt.target.slice(); rt.cursor = goal.slice(); updateHead(ctx); if (samePt(rt.target, before)) break; }
  if (samePt(rt.target, goal) && (a.layers.includes(rt.layer) || a.layers.includes("*.Cu"))) {
    const hv = hoverPoint(ctx, goal, true);
    routeClick(ctx, { x: goal[0], y: goal[1], snap: hv.snap }, goal, { enter: true });
    if (S.route === rt) endRoute(ctx, false);
    return true;
  }
  ctx.requestRender(); return true;
}
/**
 * ROUTER::ContinueFromEnd (routerContinueFromEnd, Ctrl+E while routing): what is fixed is committed, routing restarts at
 * the nearest ratsnest anchor (on the current layer when the anchor has it, else the anchor's first layer) and the
 * head is pulled back to where the route had got to.
 */
export function continueFromEnd(ctx: PcbCtx): boolean {
  const rt = S.route; if (!rt || rt.dp) return false;
  leadingRatline(ctx, rt); const a = rt.ratAnchor; if (!a) return true;   // ShowInfoBarError( FailureReason() ): empty here
  const currentEnd = rt.target.slice(), layer = rt.layer, originalLayer = rt.originalLayer;
  const needsAppend = endRoute(ctx, false) || !!rt.amend;   // HasPlacedAnything: the rest of the route joins the same undo step
  const next = a.layers.includes(layer) || a.layers.includes("*.Cu") || !a.layers.length ? layer : a.layers[0];
  if (next !== S.layer) setLayer(ctx, next);
  const hv = hoverPoint(ctx, a.p.slice(), true);
  routeClick(ctx, { x: a.p[0], y: a.p[1], snap: hv.snap }, a.p.slice());
  const nr = S.route as Route | null; if (!nr) { if (originalLayer) restoreActiveLayer(ctx, { originalLayer } as unknown as Route); return true; }
  nr.originalLayer = originalLayer; nr.amend = needsAppend;
  nr.cursor = currentEnd; updateHead(ctx); ctx.requestRender(); return true;
}
