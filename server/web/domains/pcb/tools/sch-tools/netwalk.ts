import type { SchCtx, Pt } from "./types";
import { root } from "../root";
import { symbolIsPower, symbolPins } from "./autoplace";
import { cursorOf, selectedItems, setSelectionIds } from "./commands";
import { connPoints, isNetLine } from "./drag";
import { collectHits, narrowCands, selectableItem } from "./guess";
import { netItems, pickNet } from "./highlight";
import { hitNonSymbol } from "./hit";
import { selectThreshold } from "./line-ends";
import { S, atOf, kid, num, ptsOf } from "./state";
import { onSegMid, r4, same, segs } from "./util";

// ---------------------------------------------------------------- select connection / node, net walking
type StopAt = "junction" | "pin" | "never";
/** A walk node: a connectable document item, or one pin of a symbol (SCH_PIN). */
interface Node { item: KItem; pin?: Pt; key: string }
const CONNECTABLE = new Set(["wire", "bus", "junction", "no_connect", "bus_entry", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
const STOP_KINDS = new Set(["label", "global_label", "hierarchical_label", "netclass_flag", "directive_label", "no_connect"]);
const pk = (p: Pt) => r4(p[0]) + "," + r4(p[1]);
/** Selectable( item ) && itemPassesFilter( item ). */
let walkDoc: KDoc | null = null;
const allowed = (it: KItem) => { const a = root.CollabEditor && root.CollabEditor.pickAllowed; return (!walkDoc || selectableItem(walkDoc, it)) && (!a || a(it)); };
/**
 * SCH_SELECTION_TOOL::expandConnectionWithGraph: a breadth-first walk over what is connected (SCH_ITEM::ConnectedItems)
 * from the start items (a symbol starts from its pins).  A line passes the walk on only through its ends that are not
 * stop points: a pin position (STOP_AT_PIN and STOP_AT_JUNCTION), and for STOP_AT_JUNCTION also a junction, label,
 * sheet pin or no-connect; STOP_NEVER adds the whole net.  A pin reached pulls its symbol in, at the junction stage
 * only when the walk started from a symbol.  Returns the ids added.
 */
export function expandConnectionWithGraph(doc: KDoc, starts: KItem[], startPins: { item: KItem; at: Pt }[], stop: StopAt, cursor?: Pt | null): Set<string> {
  walkDoc = doc;
  const added = new Set<string>(), nodes: Node[] = [], at = new Map<string, Node[]>();
  const put = (n: Node, p: Pt) => { const k = pk(p); let l = at.get(k); if (!l) at.set(k, l = []); l.push(n); };
  const pinPositions = new Set<string>(), stopPoints = new Set<string>(), pinNodes = new Map<string, Node>();
  for (const it of doc.items.values()) {
    if (it.kind === "symbol") { for (const p of connPoints(doc, it)) { const n: Node = { item: it, pin: p, key: it.id + "#" + pk(p) }; nodes.push(n); put(n, p); pinPositions.add(pk(p)); pinNodes.set(n.key, n); } continue; }
    if (it.kind === "sheet") { for (const p of connPoints(doc, it)) stopPoints.add(pk(p)); continue; }   // a sheet pin stops the junction stage
    if (!CONNECTABLE.has(it.kind)) continue;
    const n: Node = { item: it, key: it.id }; nodes.push(n);
    for (const p of connPoints(doc, it)) { put(n, p); if (it.kind === "junction" || STOP_KINDS.has(it.kind)) stopPoints.add(pk(p)); }
  }
  // SCH_SCREEN::IsJunction: three or more line ends, or an end on another line's middle, also stop the junction stage
  const lines = nodes.filter((n) => isNetLine(n.item.kind));
  const ends = new Map<string, number>(); for (const n of lines) for (const p of connPoints(doc, n.item)) ends.set(pk(p), (ends.get(pk(p)) || 0) + 1);
  for (const [k, c] of ends) if (c >= 3) stopPoints.add(k);
  const midOf = (p: Pt) => lines.filter((n) => segs(n.item).some(([a, b]) => onSegMid(p, a, b)));
  const isStop = (p: Pt): boolean => {
    if (stop === "never") return false;
    if (pinPositions.has(pk(p))) return true;
    if (stop === "pin") return false;
    return stopPoints.has(pk(p)) || midOf(p).length > 0;
  };
  const ptsOfNode = (n: Node): Pt[] => (n.pin ? [n.pin] : connPoints(doc, n.item));
  // SCH_ITEM::ConnectedItems: whatever shares a connection point, and a line a point-like item sits on
  const neighbors = (n: Node): Node[] => {
    const out = new Set<Node>();
    for (const p of ptsOfNode(n)) { for (const o of at.get(pk(p)) || []) if (o !== n) out.add(o); for (const o of midOf(p)) if (o !== n) out.add(o); }
    if (isNetLine(n.item.kind)) for (const o of nodes) { if (o === n || out.has(o)) continue; if (ptsOfNode(o).some((p) => segs(n.item).some(([a, b]) => onSegMid(p, a, b)))) out.add(o); }
    return [...out];
  };
  const connectedAt = (n: Node, p: Pt) => ptsOfNode(n).some((q) => same(q, p)) || (isNetLine(n.item.kind) && segs(n.item).some(([a, b]) => onSegMid(p, a, b)));
  const startNodes: Node[] = [], startSymbols = new Set<string>();
  for (const it of starts) {
    if (it.kind === "symbol") { for (const n of nodes) if (n.item === it && n.pin) startNodes.push(n); startSymbols.add(it.id); }
    else { const n = nodes.find((q) => q.item === it && !q.pin); if (n) startNodes.push(n); }
  }
  for (const sp of startPins) { const n = pinNodes.get(sp.item.id + "#" + pk(sp.at)); if (n) { startNodes.push(n); startSymbols.add(sp.item.id); } }
  if (!startNodes.length) return added;
  const pullInSymbol = stop !== "junction" || startSymbols.size > 0;
  const queue: Node[] = [], visited = new Set<Node>();
  const enqueue = (n: Node) => { if (!visited.has(n)) { visited.add(n); queue.push(n); } };
  for (const n of startNodes) enqueue(n);
  if (stop === "never") {
    // NAVIGATION_QUERY::WholeNetItems: everything on the nets of the start items (labels of the same name included)
    for (const s of startNodes) for (const id of netItems(doc, s.item, s.pin || cursor || null)) {
      const it = doc.items.get(id); if (!it) continue;
      if (it.kind === "symbol") { if (allowed(it)) added.add(id); continue; }
      const n = nodes.find((q) => q.item === it && !q.pin); if (n) enqueue(n); else if (allowed(it) && it.kind !== "sheet") added.add(id);
    }
  }
  while (queue.length) {
    const n = queue.shift()!;
    if (n.pin) { if (pullInSymbol && allowed(n.item)) added.add(n.item.id); }
    const line = isNetLine(n.item.kind) && !n.pin, open: Pt[] = [];
    if (line && stop !== "never") for (const p of connPoints(doc, n.item)) if (!isStop(p)) open.push(p);
    for (const o of neighbors(n)) {
      if (line && stop !== "never" && !open.some((p) => connectedAt(o, p))) continue;
      enqueue(o);
    }
    if (n.pin || !allowed(n.item)) continue;   // a pin stands for its symbol in this selection model
    added.add(n.item.id);
  }
  return added;
}
/** SCH_SCREEN::MarkConnections' end points of a graphic item: a line's ends, a rectangle's corners, a polygon's points, an arc's or curve's ends. */
function graphicEnds(it: KItem): Pt[] {
  if (it.kind === "wire" || it.kind === "bus" || it.kind === "polyline") { const p = ptsOf(it.node); return p.length === 2 ? [p[0], p[1]] : p; }
  if (it.kind === "rectangle") { const s = kid(it.node, "start"), e = kid(it.node, "end"); if (!s || !e) return []; const x0 = num(s[1]), y0 = num(s[2]), x1 = num(e[1]), y1 = num(e[2]); return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
  if (it.kind === "arc") { const s = kid(it.node, "start"), e = kid(it.node, "end"); return s && e ? [[num(s[1]), num(s[2])], [num(e[1]), num(e[2])]] : []; }
  if (it.kind === "bezier") { const p = ptsOf(it.node); return p.length > 1 ? [p[0], p[p.length - 1]] : []; }
  return [];
}
/** The item's layer for MarkConnections: wires, buses and everything graphic (LAYER_NOTES) only join their own. */
const graphicLayer = (it: KItem) => (it.kind === "wire" || it.kind === "bus" ? it.kind : "notes");
/**
 * SCH_SELECTION_TOOL::expandConnectionGraphically (SCH_SCREEN::MarkConnections): lines and shapes on the same layer
 * that share an end point with the item, followed from each one found; a connectable start item also takes the
 * junctions at the shared points.
 */
export function expandConnectionGraphically(doc: KDoc, starts: KItem[]): Set<string> {
  walkDoc = doc;
  const added = new Set<string>();
  for (const start of starts) {
    if (!graphicEnds(start).length) continue;
    const second = start.kind === "wire" || start.kind === "bus", done = new Set<KItem>(), todo = [start];
    while (todo.length) {
      const it = todo.pop()!; if (done.has(it)) continue; done.add(it);
      const mine = graphicEnds(it);
      for (const c of doc.items.values()) {
        if (done.has(c) || graphicLayer(c) !== graphicLayer(it)) continue;
        const ends = graphicEnds(c); if (!ends.length) continue;
        const shared = ends.filter((p) => mine.some((q) => same(p, q))); if (!shared.length) continue;
        if (second) for (const p of shared) for (const j of doc.items.values()) if (j.kind === "junction" && same(atOf(j.node), p) && allowed(j)) added.add(j.id);
        todo.push(c); if (allowed(c)) added.add(c.id);
      }
    }
  }
  return added;
}
/**
 * SCH_SELECTION_TOOL::SelectConnection: staged.  The connectable items of the selection (or the item under the
 * cursor) grow first to the junctions, then to the pins, then to the whole net; a stage is skipped when it adds
 * nothing that was not selected already, so repeated presses grow the selection step by step.  Graphic lines and
 * shapes grow through touching end points.  What was selected stays selected.
 */
export function selectConnection(ctx: SchCtx) {
  const doc = ctx.doc; let original = selectedItems(ctx);
  const ed = root.CollabEditor as unknown as { selPins?: { id: string; number: string }[] } | undefined;
  const startPins: { item: KItem; at: Pt }[] = [];
  for (const r of (ed && ed.selPins) || []) { const it = doc.items.get(r.id); const pin = it ? symbolPins(doc, it).find((q) => q.number === r.number) : null; if (it && pin) startPins.push({ item: it, at: [r4(pin.x), r4(pin.y)] }); }
  if (!original.length && !startPins.length) {   // RequestSelection( expandConnectionGraphTypes ): the hover selection
    const pick = pickNet(ctx, cursorOf(ctx));
    if (pick && pick.item.kind === "symbol" && pick.pin === undefined) startPins.push({ item: pick.item, at: [r4(pick.at[0]), r4(pick.at[1])] });
    else if (pick) original = [pick.item];
    else { const c = cursorOf(ctx), g = hitNonSymbol(doc, c[0], c[1], selectThreshold(ctx)); if (g) original = [g]; }
  }
  if (!original.length && !startPins.length) return false;
  const graphical = original.filter((it) => it.kind === "polyline" || it.kind === "rectangle" || it.kind === "arc" || it.kind === "bezier" || it.kind === "circle");
  const connectable = original.filter((it) => !graphical.includes(it));
  const origIds = new Set(connectable.map((it) => it.id));
  let graphAdded = new Set<string>();
  if (connectable.length || startPins.length) {
    for (const stop of ["junction", "pin", "never"] as StopAt[]) {
      graphAdded = expandConnectionWithGraph(doc, connectable, startPins, stop, cursorOf(ctx));
      if ([...graphAdded].some((id) => !origIds.has(id))) break;
    }
  }
  const graphicalAdded = expandConnectionGraphically(doc, !graphAdded.size && connectable.length ? [...connectable, ...graphical] : graphical);
  const ids = new Set<string>([...graphAdded, ...graphicalAdded, ...original.map((it) => it.id)]);
  if (!ids.size) return false;
  setSelectionIds(ctx, ids); return true;
}
/** connectedTypes (sch_selection_tool.cpp): what Select Node picks. */
const NODE_KINDS = new Set(["wire", "bus", "bus_entry", "junction", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
/**
 * SCH_SELECTION_TOOL::SelectNode: SelectPoint( cursor, connectedTypes ): a wire, bus, bus entry, junction or label of
 * any kind under the cursor, else a pin's symbol (this selection keeps a pin as its symbol) or a power symbol.
 */
export function selectNode(ctx: SchCtx) {
  const c = cursorOf(ctx);
  // the collector scans connectedTypes only; the filter and GuessSelectionCandidates then run as for any click, so an
  // exact pin or junction wins over the wire ends on it
  const scan = collectHits(ctx, c).filter((q) => q.kind === "pin" || (q.kind === "item" && (NODE_KINDS.has(q.item.kind) || (q.item.kind === "symbol" && symbolIsPower(ctx.doc, q.item)))));
  const win = narrowCands(ctx, scan, c).cands[0];
  if (!win || win.kind === "field" || !allowed(win.item)) return false;
  setSelectionIds(ctx, [win.item.id]); return true;
}
/**
 * SCH_SELECTION_TOOL::SelectNext / SelectPrevious: only while the first selected item is on the highlighted net
 * (IsNetHighlighted); the next item comes from the net navigator's order when the editor publishes it, else this
 * sheet's items of the highlighted net in sheet order (top to bottom, left to right).
 */
export function stepNetItem(ctx: SchCtx, dir: number) {
  const items = selectedItems(ctx); if (!items.length) return false;
  const hl = S.highlight as Set<string> | null; if (!hl || !hl.has(items[0].id)) return false;
  const nav = (root.CollabEditor as unknown as { netNavigatorOrder?: () => string[] } | undefined);
  let ids: string[] = []; try { ids = nav && nav.netNavigatorOrder ? nav.netNavigatorOrder().filter((id) => ctx.doc.items.has(id)) : []; } catch (e) { ids = []; }
  if (ids.length < 2) {
    const pos = (id: string): Pt => { const it = ctx.doc.items.get(id)!, b = it.bbox; return b ? [b[0], b[1]] : atOf(it.node); };
    ids = [...hl].filter((id) => ctx.doc.items.has(id)).sort((a, b) => { const p = pos(a), q = pos(b); return p[1] - q[1] || p[0] - q[0] || (a < b ? -1 : 1); });
  }
  if (ids.length < 2) return false;
  const i = ids.indexOf(items[0].id), next = ids[((i < 0 ? 0 : i) + dir + ids.length) % ids.length];
  setSelectionIds(ctx, [next]); return true;
}
export function unselectAll(ctx: SchCtx) { setSelectionIds(ctx, []); return true; }
