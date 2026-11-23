// pcb-tools/netlist.ts — connectivity: netlist, clusters, ratsnest, net inspector.
import type { Anchor, BoardDoc, Cluster, Conductor, ConductorInit, NetEntry, NetRef, Netlist, PcbCtx, PolyShape, Pt } from "./types";
import { arcLength, arcPoints, padCopperLayers, padShape, shapeBBox, shapeGap, shareLayer, viaLayers } from "./distances";
import { selectedItems } from "./groups";
import { netOf } from "./nets";
import { zoneLayers } from "./nodes";
import { padsOf } from "./route-geom";
import { K } from "./state";
import { pointInPoly } from "./hit";
import { EPS } from "./transforms";
import { layerOf, pt, r6, widthOf } from "./util";

// ---------------------------------------------------------------- connectivity: netlist, clusters, ratsnest, net inspector
/** Net names for both file styles: (net "GND") inline, or (net 3) resolved through the pads' (net 3 "GND"). */
export function netTable(doc: BoardDoc) {
  const byCode = new Map<number, string>(), byName = new Map<string, NetRef>();
  for (const it of doc.items.values()) {
    const probe = it.kind === "footprint" ? K.kids(it.node, "pad") : [it.node];
    for (const p of probe) { const n = netOf(p); if (n.code > 0 && n.name) byCode.set(n.code, n.name); if (n.name && !byName.has(n.name)) byName.set(n.name, n); }
    if (it.kind === "zone") { const nn = K.kid(it.node, "net_name"), n = netOf(it.node); if (nn && n.code > 0 && !byCode.has(n.code)) byCode.set(n.code, K.str(nn[1])); }
  }
  return { byCode, byName, key(net: NetRef | null | undefined) { if (!net) return ""; if (net.name) return net.name; if (net.code > 0) return byCode.get(net.code) || "#" + net.code; return ""; } };
}
/** Every piece of copper on the board as a shape on a layer set with a net: pads, tracks, arcs, vias and zone fills. */
export function conductors(doc: BoardDoc) {
  const NT = netTable(doc); const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; const out: Conductor[] = [];
  const push = (c: ConductorInit) => { (c as Conductor).bbox = shapeBBox(c.shape); out.push(c as Conductor); };
  for (const it of doc.items.values()) {
    const n = it.node;
    if (it.kind === "footprint") {
      padsOf(it).forEach((p) => {
        const layers = padCopperLayers(p, copper); if (!layers.size || p.type === "np_thru_hole") return;
        push({ id: it.id, kind: "pad", item: it, pad: p, index: p.index, net: NT.key(p.net), netObj: p.net, layers, shape: padShape(p), anchors: [[p.x, p.y]] });
      });
    } else if (it.kind === "segment") {
      const a = pt(n, "start"), b = pt(n, "end"); if (!a || !b) continue; const w = widthOf(n, 0.25);
      push({ id: it.id, kind: "segment", item: it, net: NT.key(netOf(n)), netObj: netOf(n), layers: new Set([layerOf(n)]), shape: { t: "seg", a, b, r: w / 2 }, anchors: [a, b], length: Math.hypot(b[0] - a[0], b[1] - a[1]), width: w });
    } else if (it.kind === "arc") {
      const a = pt(n, "start"), m = pt(n, "mid"), b = pt(n, "end"); if (!a || !m || !b) continue; const w = widthOf(n, 0.25); const arc = K.arcFrom3(a, m, b);
      push({ id: it.id, kind: "arc", item: it, net: NT.key(netOf(n)), netObj: netOf(n), layers: new Set([layerOf(n)]), shape: { t: "path", pts: arc ? arcPoints(arc, a, b) : [a, b], r: w / 2 }, anchors: [a, b], length: arc ? arcLength(arc) : Math.hypot(b[0] - a[0], b[1] - a[1]), width: w });
    } else if (it.kind === "via") {
      const a = pt(n, "at"); if (!a) continue; const size = K.num((K.kid(n, "size") || [0, 0.8])[1], 0.8), drill = K.num((K.kid(n, "drill") || [0, 0.4])[1], 0.4);
      push({ id: it.id, kind: "via", item: it, net: NT.key(netOf(n)), netObj: netOf(n), layers: viaLayers(n, copper), shape: { t: "circle", x: a[0], y: a[1], r: size / 2 }, anchors: [a], size, drill });
    } else if (it.kind === "zone" && !K.kid(n, "keepout")) {
      const net = NT.key(netOf(n)); const zl = zoneLayers(n);
      for (const fp of K.kids(n, "filled_polygon")) { const pts = K.ptsOf(fp); if (pts.length < 3) continue; push({ id: it.id, kind: "zone", item: it, net, netObj: netOf(n), layers: new Set([layerOf(fp, zl[0] || "F.Cu")]), shape: { t: "poly", pts }, anchors: [] }); }
    }
  }
  return out;
}
/** Union-find over touching copper on a shared layer; nets must agree, but net-less copper joins whatever it touches (KiCad's propagation). */
/** CN_VISITOR::checkZoneZoneConnection: two fills of one net connect when a corner of one lies in the other. */
function zonesTouch(a: Conductor, b: Conductor): boolean {
  if ((a.net || "") !== (b.net || "") || a.item === b.item) return false;   // one zone's outlines never touch each other
  const P = (a.shape as PolyShape).pts, Q = (b.shape as PolyShape).pts; const ba = a.bbox, bb = b.bbox;
  const inBox = (p: Pt, bx: number[]) => p[0] >= bx[0] - EPS && p[0] <= bx[2] + EPS && p[1] >= bx[1] - EPS && p[1] <= bx[3] + EPS;
  for (const p of P) if (inBox(p, bb) && pointInPoly(Q, p[0], p[1])) return true;
  for (const q of Q) if (inBox(q, ba) && pointInPoly(P, q[0], q[1])) return true;
  return false;
}
export function clusterRoots(conds: Conductor[]) {
  const parent = conds.map((_, i: number) => i); const find = (i: number) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const order = conds.map((_, i: number) => i).sort((i: number, j: number) => conds[i].bbox[0] - conds[j].bbox[0]);
  for (let ii = 0; ii < order.length; ii++) {
    const i = order[ii], a = conds[i];
    for (let jj = ii + 1; jj < order.length; jj++) {
      const j = order[jj], b = conds[j]; if (b.bbox[0] > a.bbox[2] + EPS) break;
      if (a.net && b.net && a.net !== b.net) continue;
      if (b.bbox[1] > a.bbox[3] + EPS || b.bbox[3] < a.bbox[1] - EPS || !shareLayer(a.layers, b.layers)) continue;
      if (find(i) === find(j)) continue;
      if (a.kind === "zone" && b.kind === "zone" ? zonesTouch(a, b) : shapeGap(a.shape, b.shape) <= EPS) parent[find(i)] = find(j);
    }
  }
  return conds.map((_, i: number) => find(i));
}
/**
 * The board's connectivity: nets → their pads / tracks / vias / zones and geometric clusters (islands of copper
 * that touch).  A cluster's ratsnest anchors are its pad and via centres, else its track ends, else fill corners.
 */
export function netlist(doc: BoardDoc) {
  const conds = conductors(doc); const roots = clusterRoots(conds);
  const byRoot = new Map<number, Cluster>();
  conds.forEach((c, i) => { let cl = byRoot.get(roots[i]); if (!cl) { cl = { items: [], nets: new Set(), net: "", anchors: [] }; byRoot.set(roots[i], cl); } cl.items.push(c); if (c.net) cl.nets.add(c.net); });
  const NT = netTable(doc); const nets = new Map<string, NetEntry>();
  const netEntry = (key: string) => { let e = nets.get(key); if (!e) { const n = NT.byName.get(key); e = { key, name: key, code: n && n.code > 0 ? n.code : 0, pads: [], tracks: [], vias: [], zones: [], clusters: [], shorts: [] }; nets.set(key, e); } return e; };
  for (const c of conds) if (c.net) { const e = netEntry(c.net); (c.kind === "pad" ? e.pads : c.kind === "via" ? e.vias : c.kind === "zone" ? e.zones : e.tracks).push(c); }
  const clusters: Cluster[] = [];
  for (const cl of byRoot.values()) {
    const padNet = cl.items.find((c) => c.kind === "pad" && c.net); cl.net = padNet ? padNet.net : (cl.nets.values().next().value || "");
    const pick = (kinds: string[]) => { const out: Anchor[] = []; for (const c of cl.items) if (kinds.includes(c.kind)) for (const p of c.anchors) out.push({ p, id: c.id, c }); return out; };
    let anchors = pick(["pad", "via", "segment", "arc"]);
    if (!anchors.length) for (const c of cl.items) if (c.kind === "zone") { const zp = (c.shape as PolyShape).pts; const step = Math.max(1, Math.ceil(zp.length / 32)); for (let i = 0; i < zp.length; i += step) anchors.push({ p: zp[i], id: c.id, c }); }
    cl.anchors = anchors; clusters.push(cl);
    if (cl.net) { const e = netEntry(cl.net); e.clusters.push(cl); if (cl.nets.size > 1) e.shorts.push(cl); }
  }
  for (const e of nets.values()) e.unconnected = Math.max(0, e.clusters.filter((c) => c.anchors.length).length - 1);
  return { conductors: conds, clusters, nets, table: NT };
}
export function nearestAnchors(c1: Cluster, c2: Cluster) {
  let best: [number, Anchor | null, Anchor | null] = [Infinity, null, null];
  for (const a of c1.anchors) for (const b of c2.anchors) { const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]); if (d < best[0]) best = [d, a, b]; }
  return best;
}
/** KiCad's ratsnest: per net, the minimum spanning tree over its clusters through their nearest anchors. */
export function ratsnest(doc: BoardDoc, nl?: Netlist | null) {
  nl = nl || netlist(doc); const lines: { net: string; code: number; name: string; a: Pt; b: Pt; ids: string[]; length: number; layersA: string[]; layersB: string[] }[] = [];
  for (const net of nl.nets.values()) {
    const cls = net.clusters.filter((c) => c.anchors.length); if (cls.length < 2) continue;
    const inTree = cls.map(() => false), best = cls.map((): { d: number; a: Anchor | null; b: Anchor | null; k: number } => ({ d: Infinity, a: null, b: null, k: -1 }));
    const update = (k: number) => { for (let j = 0; j < cls.length; j++) { if (inTree[j]) continue; const [d, a, b] = nearestAnchors(cls[k], cls[j]); if (d < best[j].d) best[j] = { d, a, b, k }; } };
    inTree[0] = true; update(0);
    for (let n = 1; n < cls.length; n++) {
      let j = -1; for (let i = 0; i < cls.length; i++) if (!inTree[i] && (j < 0 || best[i].d < best[j].d)) j = i;
      inTree[j] = true; const e = best[j];
      const [pa, pb, la, lb] = optimizeZoneEnds(e.a!, cls[e.k], e.b!, cls[j]);
      lines.push({ net: net.key, code: net.code, name: net.name, a: pa.slice(), b: pb.slice(), ids: [e.a!.id, e.b!.id], length: Math.hypot(pb[0] - pa[0], pb[1] - pa[1]), layersA: la, layersB: lb }); update(j);
    }
  }
  return lines;
}
/**
 * RATSNEST_VIEW_ITEM::ViewDraw with RATSNEST_MODE::VISIBLE: a line is drawn only when each end's layers meet the
 * visible copper layers (with inactive layers hidden, `only`: the active layer alone).  An end with no layer facts counts.
 */
export function ratsnestLineVisible(l: { layersA?: string[]; layersB?: string[] }, hidden: Set<string> | null, only: string | null): boolean {
  const vis = (ls: string[] | undefined) => !ls || ls.some((x) => /\.Cu$/.test(x) && (only !== null ? x === only : !(hidden && hidden.has(x))));
  return vis(l.layersA) && vis(l.layersB);
}
/** Whether a fill touches a conductor of its net (CN_ITEM::ConnectedItems): itself, or touching on a shared layer. */
function zoneTouches(z: Conductor, c: Conductor): boolean { return z === c || (z.net === c.net && shareLayer(z.layers, c.layers) && shapeGap(z.shape, c.shape) <= EPS); }
/** The closest points of two outlines (SHAPE_LINE_CHAIN::ClosestSegmentsFast): a vertex of one to a side of the other. */
function closestOutlinePoints(a: Pt[], b: Pt[]): [Pt, Pt] | null {
  let bd = Infinity, best: [Pt, Pt] | null = null;
  const scan = (p: Pt[], q: Pt[], swap: boolean) => {
    for (const v of p) for (let i = 0, k = q.length - 1; i < q.length; k = i++) {
      const s0 = q[k], s1 = q[i], dx = s1[0] - s0[0], dy = s1[1] - s0[1], l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((v[0] - s0[0]) * dx + (v[1] - s0[1]) * dy) / l)) : 0;
      const c: Pt = [s0[0] + t * dx, s0[1] + t * dy], d = (v[0] - c[0]) ** 2 + (v[1] - c[1]) ** 2;
      if (d < bd) { bd = d; best = swap ? [c, v] : [v, c]; }
    }
  };
  scan(a, b, false); scan(b, a, true);
  return best;
}
/**
 * RN_NET::OptimizeRNEdges: an edge from a lone item (nothing connected to it) to an item on a fill ends at the fill
 * outline vertex nearest the lone item (optimizeZoneAnchor, a fill on a layer the lone item is on); an edge between two
 * items on fills joins the closest points of two fills on one layer (optimizeZoneToZoneAnchors).  Returns both ends and
 * the copper layers each end is on.
 */
export function optimizeZoneEnds(a: Anchor, ca: Cluster, b: Anchor, cb: Cluster): [Pt, Pt, string[], string[]] {
  let pa = a.p, pb = b.p, la = a.c ? [...a.c.layers] : [], lb = b.c ? [...b.c.layers] : [];
  if (!a.c || !b.c) return [pa, pb, la, lb];
  const toZone = (lone: Anchor, other: Anchor, oc: Cluster): [Pt, string[]] | null => {
    let bd = (other.p[0] - lone.p[0]) ** 2 + (other.p[1] - lone.p[1]) ** 2, best: [Pt, string[]] | null = null;
    for (const z of oc.items) {
      if (z.kind !== "zone" || z.net !== other.c!.net || !shareLayer(z.layers, lone.c!.layers) || !zoneTouches(z, other.c!)) continue;
      for (const p of (z.shape as PolyShape).pts) { const d = (p[0] - lone.p[0]) ** 2 + (p[1] - lone.p[1]) ** 2; if (d < bd) { bd = d; best = [p, [...z.layers]]; } }
    }
    return best;
  };
  if (ca.items.length === 1) { const r = toZone(a, b, cb); if (r) { pb = r[0]; lb = r[1]; } }
  else if (cb.items.length === 1) { const r = toZone(b, a, ca); if (r) { pa = r[0]; la = r[1]; } }
  else {
    for (const za of ca.items) {
      if (za.kind !== "zone" || !zoneTouches(za, a.c)) continue;
      const zb = cb.items.find((z) => z.kind === "zone" && zoneTouches(z, b.c!) && shareLayer(z.layers, za.layers));
      if (!zb) continue;
      const r = closestOutlinePoints((za.shape as PolyShape).pts, (zb.shape as PolyShape).pts);   // the first layer both fills are on
      if (r) { pa = r[0]; pb = r[1]; la = [...za.layers]; lb = [...zb.layers]; }
      break;
    }
  }
  return [pa, pb, la, lb];
}
/** The ratsnest lines that reach a footprint's pads (what KiCad shows while it moves). */
export function localRatsnest(doc: BoardDoc, footprintId: string, nl?: Netlist | null) { return ratsnest(doc, nl).filter((l) => l.ids.includes(footprintId)); }
/** PCB_NET_INSPECTOR_PANEL's rows: per net the pad and via counts, the routed length (arcs by arc length) and the missing connections. */
export function netInspector(doc: BoardDoc, nl?: Netlist | null) {
  nl = nl || netlist(doc); const rows: { name: string; code: number; padCount: number; viaCount: number; trackLength: number; zoneCount: number; unconnected?: number }[] = [];
  for (const net of nl.nets.values()) rows.push({ name: net.name, code: net.code, padCount: net.pads.length, viaCount: net.vias.length, trackLength: r6(net.tracks.reduce((s, c) => s + (c as Extract<Conductor, { length: number }>).length, 0)), zoneCount: new Set(net.zones.map((z) => z.id)).size, unconnected: net.unconnected });
  return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
/** Ids of everything on a net: its tracks, arcs, vias, zones and the footprints owning its pads. */
export function netItemIds(doc: BoardDoc, key: string, nl?: Netlist | null) {
  nl = nl || netlist(doc); const net = nl.nets.get(key); const ids = new Set<string>(); if (!net) return ids;
  for (const list of [net.pads, net.tracks, net.vias, net.zones]) for (const c of list) ids.add(c.id);
  return ids;
}
/** What a net highlight brightens (PCB_PAINTER by netcode): the net's tracks, vias and zones by id and each of its
 *  pads as "footprintId#padIndex", so the footprint's other pads and its silk stay dark. */
export function netHighlightIds(doc: BoardDoc, key: string, nl?: Netlist | null) {
  nl = nl || netlist(doc); const net = nl.nets.get(key); const ids = new Set<string>(); if (!net) return ids;
  for (const c of net.pads) ids.add(c.id + "#" + (c as Extract<Conductor, { kind: "pad" }>).index);
  for (const list of [net.tracks, net.vias, net.zones]) for (const c of list) ids.add(c.id);
  return ids;
}
/** Nets of the selection: connected items give theirs, a footprint every net of its pads. */
export function selectionNets(ctx: PcbCtx, nl: Netlist) {
  const keys = new Set<string>();
  for (const it of selectedItems(ctx)) {
    if (it.kind === "footprint") { for (const p of padsOf(it)) { const k = nl.table.key(p.net); if (k) keys.add(k); } }
    else if (K.kid(it.node, "net")) { const k = nl.table.key(netOf(it.node)); if (k) keys.add(k); }
  }
  return keys;
}
/** Segments and vias touching the clusters that hold any of the seed items (a pad's footprint counts): KiCad's "Unroute". */
export function connectedCopperIds(nl: Netlist, seedIds: Set<string>) {
  const out = new Set<string>();
  for (const cl of nl.clusters) if (cl.items.some((c) => seedIds.has(c.id))) for (const c of cl.items) if (c.kind === "segment" || c.kind === "arc" || c.kind === "via") out.add(c.id);
  return out;
}
/**
 * DIALOG_TRACK_VIA_PROPERTIES::TransferDataFromWindow's net change.  `connected`: the selected tracks / arcs / vias
 * and every track, arc and via connected to them through copper, vias and pads, zones left out (GetConnectedItems(
 * track, EXCLUDE_ZONES ) on the board as it was).  Then, with the dialog's edits (`staged` nodes by id) in place, each
 * connected track is collided with the board's tracks and pads: a track of another net than its own and the new one
 * shorts that net; a pad of the track's own net is a pad that changes with it, a pad of another net shorts it
 * (the nets compared before any net is changed).  Shorting nets in board order, pads in board order.
 */
export function trackNetChangePlan(doc: BoardDoc, selectedIds: string[], staged: Map<string, SNode>, newNet: string) {
  const sel = new Set(selectedIds);
  // the connectivity of the board as it was, without zones
  const conds0 = conductors(doc).filter((c) => c.kind !== "zone"), roots0 = clusterRoots(conds0);
  const seedRoots = new Set<number>(); conds0.forEach((c, i) => { if (sel.has(c.id) && c.kind !== "pad") seedRoots.add(roots0[i]); });
  const connected = new Set<string>(selectedIds.filter((id) => { const it = doc.items.get(id); return !!it && (it.kind === "segment" || it.kind === "arc" || it.kind === "via"); }));
  conds0.forEach((c, i) => { if (seedRoots.has(roots0[i]) && (c.kind === "segment" || c.kind === "arc" || c.kind === "via")) connected.add(c.id); });
  // the board with the dialog's edits
  const items = new Map(doc.items); for (const [id, node] of staged) { const it = items.get(id); if (it) items.set(id, { ...it, node }); }
  const after = conductors({ ...doc, items } as BoardDoc).filter((c) => c.kind !== "zone");
  const byId = new Map<string, Conductor>(); for (const c of after) if (c.kind !== "pad") byId.set(c.id, c);
  const collide = (a: Conductor, b: Conductor): boolean => shareLayer(a.layers, b.layers) && !(b.bbox[0] > a.bbox[2] + EPS || b.bbox[2] < a.bbox[0] - EPS || b.bbox[1] > a.bbox[3] + EPS || b.bbox[3] < a.bbox[1] - EPS) && shapeGap(a.shape, b.shape) <= EPS;
  // a track carrying only its net code is keyed "#code": name it from the board's net table
  const netsTable = (doc as unknown as { nets?: Map<number, string> }).nets;
  const nameOf = (k: string | undefined): string => (k && k[0] === "#" && netsTable instanceof Map ? netsTable.get(Number(k.slice(1))) || k : k || "");
  const shorting: string[] = [], pads: { fpId: string; index: number; ref: string; number: string }[] = [], padKeys = new Set<string>();
  for (const id of connected) {
    const t = byId.get(id); if (!t) continue;
    const own = nameOf(t.net);
    for (const o of after) {
      if (o.kind === "pad") {
        const pn = nameOf(o.net); if (pn === newNet) continue;
        if (!collide(t, o)) continue;
        if (pn === own) {
          const k = o.id + "#" + o.index; if (padKeys.has(k)) continue; padKeys.add(k);
          const ref = (K.kids(o.item.node, "property") as SNode[]).find((p) => K.str(p[1]) === "Reference");
          pads.push({ fpId: o.id, index: o.index, ref: ref ? K.str(ref[2]) : "", number: o.pad.number });
        } else if (!shorting.includes(pn)) shorting.push(pn);
      } else {
        const on = nameOf(o.net); if (on === own || on === newNet) continue;
        if (collide(t, o) && !shorting.includes(on)) shorting.push(on);
      }
    }
  }
  return { connected: Array.from(connected), changingPads: pads, shortingNets: shorting };
}
