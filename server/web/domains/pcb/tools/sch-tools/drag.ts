import { applyAxisLock, axisLockKey, keyboardCursorKey, newAxisLock } from "../axis-lock";
import type { Anchor, Box, Mods, OrthoConn, OrthoLine, OrthoSim, PartialLine, Rider, SchCtx, SchDrag, Pt } from "./types";
import { symbolLibId } from "./autoplace";
import { autoRotateChanges } from "./autorotate";
import { collisionCursor, collisionInit } from "./collision";
import { setSelectionIds } from "./commands";
import { breakLinesAt, junctionAt, lineEndsAt, lineMidsAt, pinsAt } from "./connect";
import { analyzePoint, editTxn, explicitJunctionNeeded, screenConnections, txnAddJunction, txnCleanUpAll } from "./junction";
import { lineNode } from "./nodes";
import { txnTrimOverlapping } from "./repeat";
import { anchorOf, shiftNode } from "./orient";
import { mmPerPx } from "./snap";
import { K, LINE_KINDS, POINT_KINDS, S, atOf, kid, kids, num, ptsOf, setPts, str, uuidOf } from "./state";
import { endBreak } from "./transforms";
import { addNode, deep, itemSexpr, modChange, r4, same, segDist, segs, typeNameFor } from "./util";
import { wireModeChanged, mergeOverlap } from "./wire";
import { isLockedItem } from "./lock";

// ---------------------------------------------------------------- drag (KiCad's "drag": attached ends stretch)
// ---------------------------------------------------------------- connected drag (eeschema/tools/sch_move_tool.cpp)
// KiCad's DRAG keeps the moved item's connections: a wire end sitting on a moved
// connection point stretches (in 90° / 45° mode orthoLineDrag keeps it orthogonal: a
// connected line slides, or a bend is added), a fixed pin, junction, label or sheet pin sitting on the
// point gets a brand-new wire, and no-connects ride along.  Afterwards junctions are
// added or dropped and collinear wires merged the way AddJunctionsIfNeeded and
// SCHEMATIC::CleanUp do on the desktop.  MOVE (M) is KiCad's plain move: the item
// goes, its connections stay where they were.
S.dragMode = "drag";                       // "drag" (G) | "move" (M): the mode of the drag in progress
// What a mouse drag does (Preferences > Editing Options "Mouse drag performs Drag (G) operation", input.drag_is_move
// inverted).  G and M choose for their own drag only: SCH_ACTIONS::drag and ::move are separate actions in KiCad.
S.mouseDragMode = "drag";
S.lineMode = "90";                         // "90" | "45" | "free"  (eeschema's LINE_MODE)
export const LINE_MODES = ["90", "45", "free"];
export const LINE_MODE_LABEL: Record<string, string> = { "90": "90°", "45": "45°", free: "free" };
export const LABEL_KINDS = new Set(["label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
export const RIDER_KINDS = new Set(["junction", "no_connect", "bus_entry", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
export const DRAG_KINDS = new Set(["symbol", "sheet", "wire", "bus", "polyline", "junction", "no_connect", "bus_entry", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label", "text",
  "text_box", "rectangle", "circle", "arc", "ellipse", "ellipse_arc", "bezier", "rule_area", "table", "image"]);
export const isNetLine = (k: string) => k === "wire" || k === "bus";

export function modeText() { return `${S.dragMode === "drag" ? "drag keeps connections (G)" : "move leaves connections (M)"} · wires ${LINE_MODE_LABEL[S.lineMode]} (Shift+Space)`; }
export function announceModes(ctx: SchCtx) {
  if (ctx && ctx.setStatus) ctx.setStatus(modeText());
  if (typeof document !== "undefined") { const b = document.querySelector<HTMLElement>("[data-act=linemode]"); if (b) { b.textContent = LINE_MODE_LABEL[S.lineMode]; b.title = `Wire angle mode: ${LINE_MODE_LABEL[S.lineMode]} (Shift+Space)`; } }
}
export function setLineMode(ctx: SchCtx, mode: string) {
  if (!LINE_MODES.includes(mode)) return S.lineMode;
  const from = S.lineMode; S.lineMode = mode; announceModes(ctx);
  if (S.drag) { applyDrag(ctx.doc, S.drag, S.drag.last[0], S.drag.last[1]); ctx.requestRender(); }
  else if (S.wire) { wireModeChanged(ctx, from, mode); ctx.requestRender(); }
  return mode;
}
export function cycleLineMode(ctx: SchCtx) { return setLineMode(ctx, LINE_MODES[(LINE_MODES.indexOf(S.lineMode) + 1) % LINE_MODES.length]); }
/** The mouse-drag preference (input.drag_is_move); a drag in progress keeps its own mode. */
export function setMouseDragMode(ctx: SchCtx, mode: string) {
  S.mouseDragMode = mode === "move" ? "move" : "drag";
  if (!S.drag) { S.dragMode = S.mouseDragMode; announceModes(ctx); }
  return S.mouseDragMode;
}
/**
 * The mode of the drag in flight, else of the next one.  `once`: for the next keyboard Move / Drag (M / G) only; without
 * it an idle call is the mouse-drag mode too (setMouseDragMode), so a pointer drag after an M is a drag again.
 */
export function setDragMode(ctx: SchCtx, mode: string, once?: boolean) {
  S.dragMode = mode === "move" ? "move" : "drag";
  if (!S.drag && !once) S.mouseDragMode = S.dragMode;
  announceModes(ctx);
  if (S.drag) { applyDrag(ctx.doc, S.drag, S.drag.last[0], S.drag.last[1]); ctx.requestRender(); }
  return S.dragMode;
}

// Connection points of an item (mm): symbol pins, sheet pins, bus-entry ends, net-line ends, anchors.
const CONN_CACHE = new WeakMap<object, { key: string; lib: unknown; pts: Pt[] }>();
export function connPoints(doc: KDoc, item: Pick<KItem, "kind" | "node"> & { id?: string }): Pt[] {
  const k = item.kind, n = item.node;
  if (k === "symbol") {
    // kept per node while its library symbol, position, orientation, unit and body style are unchanged: the move
    // previews ask for every symbol's points on each mouse move
    const at = kid(n, "at"), mi = kid(n, "mirror"), un = kid(n, "unit"), bs = kid(n, "body_style") || kid(n, "convert");
    const lid = kid(n, "lib_name") || kid(n, "lib_id"), lib = lid ? K.resolveLib(doc, str(lid[1])) : null;
    const key = (at ? at.slice(1).join(",") : "") + "|" + (mi ? str(mi[1]) : "") + "|" + (un ? str(un[1]) : "") + "|" + (bs ? str(bs[1]) : "") + "|" + (lid ? str(lid[1]) : "");
    const hit = CONN_CACHE.get(n as object);
    if (hit && hit.key === key && hit.lib === lib) return hit.pts.map((p) => p.slice());
    const pts: Pt[] = K.pinPoints(doc, item).map((p) => [r4(p.x), r4(p.y)]);
    CONN_CACHE.set(n as object, { key, lib, pts }); return pts.map((p) => p.slice());
  }
  if (k === "sheet") return kids(n, "pin").map((p) => atOf(p).slice(0, 2).map(r4));
  if (k === "bus_entry") { const [x, y] = atOf(n), s = kid(n, "size"); return [[r4(x), r4(y)], [r4(x + num(s && s[1], 2.54)), r4(y + num(s && s[2], 2.54))]]; }
  if (isNetLine(k)) { const p = ptsOf(n); return p.length > 1 ? [p[0].slice(), p[p.length - 1].slice()] : []; }
  if (POINT_KINDS.has(k) || LABEL_KINDS.has(k)) return [atOf(n).slice(0, 2).map(r4)];
  return [];
}
export function labelsAt(doc: KDoc, p: Pt, skip?: KItem) { const out: KItem[] = []; for (const it of doc.items.values()) if (LABEL_KINDS.has(it.kind) && it !== skip && same(atOf(it.node), p)) out.push(it); return out; }
export function sheetPinsAt(doc: KDoc, p: Pt, skip?: KItem) { const out: KItem[] = []; for (const it of doc.items.values()) if (it.kind === "sheet" && it !== skip) for (const pin of kids(it.node, "pin")) if (same(atOf(pin), p)) { out.push(it); break; } return out; }
export function noConnectsAt(doc: KDoc, p: Pt, skip?: KItem) { const out: KItem[] = []; for (const it of doc.items.values()) if (it.kind === "no_connect" && it !== skip && same(atOf(it.node), p)) out.push(it); return out; }
export function busEntriesAt(doc: KDoc, p: Pt, skip?: KItem) { const out: KItem[] = []; for (const it of doc.items.values()) if (it.kind === "bus_entry" && it !== skip && connPoints(doc, it).some((q) => same(q, p))) out.push(it); return out; }
// Which net lines a dragged item attaches to at a point (SCH_LINE::CanConnect: symbol pins and no-connects take
// wires only, sheets and their pins wires and buses).
export function lineKindsFor(item: KItem) { return item.kind === "bus" ? ["bus"] : item.kind === "symbol" || item.kind === "wire" || item.kind === "no_connect" ? ["wire"] : ["wire", "bus"]; }

// One anchor per connection point: the line ends that stretch, the stub wire to create and the
// no-connects that follow.  `moving` holds the ids travelling with the drag; they never anchor.
export function makeAnchor(doc: KDoc, item: KItem, p: Pt, moving: Set<string>): Anchor {
  const a: Anchor = { p: [r4(p[0]), r4(p[1])], ends: [], stub: null, followers: [] };
  const j = junctionAt(doc, p[0], p[1]);
  const fixedJunction = j && !moving.has(j.id) ? j : null;
  const ends = [];
  for (const kd of lineKindsFor(item)) for (const e of lineEndsAt(doc, p[0], p[1], kd)) if (!moving.has(e.item.id) && ptsOf(e.item.node).length > 1) ends.push(e);
  // An unselected junction on the point isolates the lines from the drag: the junction itself
  // gets the new stub wire and the lines stay put (getConnectedDragItems' ptHasUnselectedJunction).
  if (fixedJunction) a.stub = { from: a.p, kind: item.kind === "bus" || ends.some((e) => e.item.kind === "bus") ? "bus" : "wire" };
  else for (const e of ends) a.ends.push({ item: e.item, index: e.index, orig: ptsOf(e.item.node).map((q) => q.slice()) });
  if (!a.stub) {
    const fixed = pinsAt(doc, p[0], p[1]).some((q) => !moving.has(q.item.id))
      || labelsAt(doc, a.p, item).some((l) => !moving.has(l.id))
      || sheetPinsAt(doc, a.p, item).some((s) => !moving.has(s.id))
      || (item.kind !== "bus_entry" && busEntriesAt(doc, a.p, item).some((b) => !moving.has(b.id)));
    if (fixed) a.stub = { from: a.p, kind: item.kind === "bus" ? "bus" : "wire" };
    else if (LABEL_KINDS.has(item.kind) || item.kind === "bus_entry") {   // a label or bus entry dragged off the middle of a line splits it (KiCad adds the junction)
      for (const kd of ["wire", "bus"]) { const mids = lineMidsAt(doc, p[0], p[1], kd).filter((m) => !moving.has(m.id) && ptsOf(m.node).length === 2); if (mids.length) { a.stub = { from: a.p, kind: kd, split: mids[0] }; break; } }
    }
  }
  if (item.kind !== "no_connect") for (const nc of noConnectsAt(doc, a.p, item)) if (!moving.has(nc.id)) a.followers.push({ item: nc, orig: atOf(nc.node).slice(0, 2) });
  return a;
}
// Items riding on a dragged net line: labels, junctions, entries and no-connects sitting on it.
// A junction at an end of the line is not a rider — it stays and gets a stub wire instead.
export function ridersOf(doc: KDoc, item: KItem) {
  const out: Rider[] = []; if (!isNetLine(item.kind)) return out;
  const pts = ptsOf(item.node); if (pts.length < 2) return out;
  const endsP = [pts[0], pts[pts.length - 1]], sg = segs(item);
  for (const it of doc.items.values()) {
    if (!RIDER_KINDS.has(it.kind) || it === item) continue;
    const cps = it.kind === "bus_entry" ? connPoints(doc, it) : [atOf(it.node).slice(0, 2)];
    if (!cps.some((c) => sg.some(([a, b]) => segDist(c, a, b) <= 1e-3))) continue;
    if (it.kind === "junction" && endsP.some((e) => same(e, atOf(it.node)))) continue;
    out.push({ item: it, orig: atOf(it.node).slice(0, 2) });
  }
  return out;
}

// ---------------------------------------------------------------- orthoLineDrag (eeschema/tools/sch_move_tool.cpp)
// A line that follows the drag by one end (an attached wire, or a line the user selected by one end) is kept
// orthogonal in the 90° and 45° line modes.  KiCad does this incrementally: every mouse event is split into an X and
// a Y move (and at a sign change of the total offset into the part back to zero and the rest), and for each part that
// is not parallel to the line the unselected end is dealt with: a connected line running the way of the move is
// stretched and the dragged line slides; a junction alone gets one new line; anything else gets two new lines, the
// bend, one grid before the moved end (one grid further for each line bent in the same event); with nothing attached
// the whole line moves.  A bend whose cross piece shrinks back to nothing is merged away again.  The result depends
// on the path the mouse took, so the state lives on the drag (d.sim) between events.
const nulLine = (l: OrthoLine) => same(l.pts[0], l.pts[1], 1e-5);
const vecOf = (l: OrthoLine): Pt => [l.pts[1][0] - l.pts[0][0], l.pts[1][1] - l.pts[0][1]];
/** EDA_ANGLE( splitDelta ).IsParallelTo( angle of v ): a null vector has the angle 0. */
const parallelTo = (s: Pt, v: Pt) => Math.abs(v[0]) <= 1e-5 && Math.abs(v[1]) <= 1e-5 ? Math.abs(s[1]) <= 1e-5 : Math.abs(s[0] * v[1] - s[1] * v[0]) <= 1e-6;
const plus = (p: Pt, s: Pt): Pt => [r4(p[0] + s[0]), r4(p[1] + s[1])];
const sgn = (v: number) => (Math.abs(v) <= 1e-5 ? 0 : v < 0 ? -1 : 1);
/** performItemMove's split of one axis: a move through zero goes back to zero first. */
const splitMove = (off: number, dl: number): Pt => ((off < 0) !== (r4(off + dl) < 0) ? [r4(-off), r4(dl + off)] : [dl, 0]);

/** getConnectedItems: the m_lineConnectionCache entry of a line, read before anything has moved. */
function simCache(doc: KDoc, sim: OrthoSim, L: OrthoLine, whole: Set<string>, lineOf: (item: KItem) => OrthoLine): OrthoConn[] {
  const out: OrthoConn[] = [], net = isNetLine(L.kind);
  for (const P of L.pts) {
    // on a junction a line is connected to the junction alone; a junction on a pin is the pin (it gets the bend)
    const j = junctionAt(doc, P[0], P[1]), sym = pinsAt(doc, P[0], P[1]).length > 0;
    if (j && sym) { out.push({}); continue; }
    if (j) { out.push({ junction: true }); continue; }
    if (sym && L.kind === "wire") out.push({});
    for (const it of doc.items.values()) {
      if (it === L.item) continue;
      if (it.kind === L.kind) {
        const q = ptsOf(it.node); if (q.length !== 2 || !(same(q[0], P) || same(q[1], P))) continue;
        // only what sits on an unselected end counts: fully moved lines and the dragged end of another line do not
        if (whole.has(it.id)) continue;
        const o = sim.byId.get(it.id); if (o && o.sel >= 0 && same(o.pts[o.sel], P)) continue;
        out.push({ line: lineOf(it) });
      } else if (!net) continue;
      else if (it.kind === "sheet") { if (kids(it.node, "pin").some((pin) => same(atOf(pin), P))) out.push({}); }
      else if (it.kind === "no_connect") { if (L.kind === "wire" && same(atOf(it.node), P)) out.push({}); }
      else if (LABEL_KINDS.has(it.kind)) { if (segDist(atOf(it.node), L.pts[0], L.pts[1]) <= 1e-3) out.push({ label: it }); }
      else if (it.kind === "bus_entry") { if (connPoints(doc, it).some((c) => segDist(c, L.pts[0], L.pts[1]) <= 1e-3)) out.push({}); }
    }
  }
  return out;
}
/** The simulation for a drag, built while the document still has everything where it was. */
function simBuild(doc: KDoc, d: SchDrag): OrthoSim {
  const sim: OrthoSim = { src: d.anchors, lines: [], drag: [], labels: [], byId: new Map(), at: [0, 0], grid: d.grid || 1.27 };
  const lineOf = (item: KItem, pts?: Pt[]): OrthoLine => {
    let l = sim.byId.get(item.id);
    if (!l) {
      const p = (pts || ptsOf(item.node)).map((q) => q.slice());
      l = { item, kind: item.kind, pts: [p[0], p[1]], orig: [p[0].slice(), p[1].slice()], sel: -1, isNew: false, stored: [p[1][0] - p[0][0], p[1][1] - p[0][1]], cache: null, cache0: null, p0: [0, 0], off: [0, 0] };
      sim.byId.set(item.id, l); sim.lines.push(l);
    }
    return l;
  };
  const dragLine = (item: KItem, index: number, pts: Pt[], target: (dx: number, dy: number) => Pt) => {
    const l = lineOf(item, pts); if (l.sel >= 0) return;
    l.sel = index; l.p0 = l.pts[index].slice(); l.target = target; sim.drag.push(l);
  };
  for (const a of d.anchors) for (const e of a.ends) if (e.orig.length === 2) dragLine(e.item, e.index, e.orig, (dx, dy) => anchorTo(d, a.p, dx, dy));
  for (const e of d.ends || []) dragLine(e.item, e.index, e.orig, (dx, dy) => [r4(e.orig[e.index][0] + dx), r4(e.orig[e.index][1] + dy)]);
  const whole = new Set(d.items.filter((e) => LINE_KINDS.has(e.kind)).map((e) => e.item.id));
  for (const L of sim.drag.slice()) { L.cache = d.mode ? [] : simCache(doc, sim, L, whole, lineOf); L.cache0 = L.cache.slice(); }
  for (const s of d.onLine || []) {
    const L = sim.byId.get(s.line.id); if (!L) continue;
    sim.labels.push({ item: s.item, orig: s.orig.slice(), pos: s.orig.slice(), line: L, line0: L, ls: L.pts[0].slice(), le: L.pts[1].slice(), track: false, owner: L });
  }
  return sim;
}
/** Back to the state before the first move (KiCad restarts the operation when G / M changes the mode). */
function simReset(sim: OrthoSim) {
  sim.lines = sim.lines.filter((l) => !l.isNew);
  for (const l of sim.lines) { l.pts = [l.orig![0].slice(), l.orig![1].slice()]; l.cache = l.cache0 ? l.cache0.slice() : null; l.off = [0, 0]; l.dead = false; }
  for (const lb of sim.labels) { lb.pos = lb.orig.slice(); lb.line = lb.line0; lb.ls = lb.line0.orig![0].slice(); lb.le = lb.line0.orig![1].slice(); lb.track = false; }
  sim.at = [0, 0]; sim.map = undefined;
}
/** SCH_MOVE_TOOL::orthoLineDrag for one split move `s` of the line's selected end (applied by the caller afterwards). */
export function orthoLineDrag(sim: OrthoSim, line: OrthoLine, s: Pt, bend: { x: number; y: number }) {
  if (parallelTo(s, vecOf(line)) && !nulLine(line)) return;
  const u = line.sel === 0 ? 1 : 0, U = line.pts[u].slice(), Sel = line.pts[line.sel].slice();
  const fresh = (a: Pt, b: Pt): OrthoLine => { const l: OrthoLine = { item: null, kind: line.kind, pts: [a.slice(), b.slice()], orig: null, sel: -1, isNew: true, stored: [0, 0], cache: null, cache0: null, p0: [0, 0], off: [0, 0] }; sim.lines.push(l); return l; };
  // look for pre-existing lines we can drag with us instead of creating new ones
  let attached = false, junction = false, found: OrthoLine | null = null;
  for (const c of line.cache || []) {
    attached = true;
    if (c.line) {
      if (parallelTo(s, vecOf(c.line)) && !nulLine(c.line)) found = c.line;      // lengthen / shorten works
      if (!found && nulLine(c.line)) found = c.line;                             // one this drag shortened to nothing
    } else if (c.junction) junction = true;
  }
  let preferOriginal = false;
  if (found && nulLine(found) && nulLine(line) && parallelTo(s, line.stored)) preferOriginal = true;
  else if (!found && junction) {
    // a junction alone gets a single new line from it instead of a bend
    found = fresh(U, U); found.cache = line.cache || []; line.cache = [{ line: found }];
  }
  if (found && !preferOriginal) {
    if (same(found.pts[0], U, 1e-5)) found.pts[0] = plus(found.pts[0], s);
    else if (same(found.pts[1], U, 1e-5)) found.pts[1] = plus(found.pts[1], s);
    const first = found.cache && found.cache.length ? found.cache[0].line : undefined, bendLine = first && !first.dead ? first : null;
    if (found.isNew && nulLine(found) && bendLine && bendLine.isNew) {
      // the bend's cross piece is back to nothing: the two added lines are merged away again
      line.pts[u] = bendLine.pts[1].slice();
      for (const lb of sim.labels) if (lb.line === bendLine || lb.line === found) { lb.line = line; lb.ls = line.pts[0].slice(); lb.le = line.pts[1].slice(); }
      line.cache = bendLine.cache || []; bendLine.cache = []; found.cache = [];
      bendLine.dead = found.dead = true;
    } else line.pts[u] = plus(line.pts[u], s);
  } else if (nulLine(line)) {
    // nothing to lengthen but the zero-length original line itself: the caller's move of the selected end does it
  } else if (attached && (Math.abs(U[0] - Sel[0]) <= 1e-5 || Math.abs(U[1] - Sel[1]) <= 1e-5)) {
    // two new lines keep the unselected end connected: `a` along the old axis, `b` across by the move
    const g = sim.grid;
    const xMove = r4((Math.abs(U[0] - Sel[0]) - bend.x * g) * sgn(Sel[0] - U[0])), yMove = r4((Math.abs(U[1] - Sel[1]) - bend.y * g) * sgn(Sel[1] - U[1]));
    const a = fresh([r4(U[0] + xMove), r4(U[1] + yMove)], U);
    const b = fresh(plus(a.pts[0], s), a.pts[0]);
    bend.x += s[1] ? 1 : 0; bend.y += s[0] ? 1 : 0;
    line.pts[u] = [r4(U[0] + (s[0] ? s[0] : xMove)), r4(U[1] + (s[1] ? s[1] : yMove))];
    // the drag labels stay on the line left behind; one on the moved end goes with it
    for (const c of line.cache || []) {
      const lb = c.label ? sim.labels.find((x) => x.item === c.label) : null; if (!lb) continue;
      if (same(lb.pos, Sel, 1e-5)) lb.track = true; else { lb.line = a; lb.ls = a.pts[0].slice(); lb.le = a.pts[1].slice(); }
    }
    a.cache = line.cache || []; b.cache = [{ line: a }]; line.cache = [{ line: b }];
  } else if (!attached) line.pts[u] = plus(line.pts[u], s);       // nothing holds the other end: it just moves
}
/** performItemMove: the selected ends go to where the drag has them for the total offset (dx, dy). */
function simAdvance(d: SchDrag, sim: OrthoSim, dx: number, dy: number, constrained: boolean) {
  const phases = new Map<OrthoLine, Pt[]>(); let lead: Pt | null = null;
  for (const L of sim.drag) {
    const t = L.target!(dx, dy), tot: Pt = [r4(t[0] - L.p0[0]), r4(t[1] - L.p0[1])], dl: Pt = [r4(tot[0] - L.off[0]), r4(tot[1] - L.off[1])];
    const xs = splitMove(L.off[0], dl[0]), ys = splitMove(L.off[1], dl[1]);
    phases.set(L, [[xs[0], 0], [xs[1], 0], [0, ys[0]], [0, ys[1]]]); L.off = tot;
    if (!lead && (dl[0] || dl[1])) lead = dl;
  }
  const ltr = !lead || lead[0] >= 0, ttb = !lead || lead[1] >= 0;
  const mid = (l: OrthoLine) => [(l.pts[0][0] + l.pts[1][0]) / 2, (l.pts[0][1] + l.pts[1][1]) / 2];
  // GetItemsSortedByTypeAndXY( delta.x >= 0, delta.y >= 0 )
  const order = (a: OrthoLine, b: OrthoLine) => {
    const p = mid(a), q = mid(b);
    if (Math.abs(p[0] - q[0]) > 1e-5) return ltr ? p[0] - q[0] : q[0] - p[0];
    if (Math.abs(p[1] - q[1]) > 1e-5) return ttb ? p[1] - q[1] : q[1] - p[1];
    return a.item!.id < b.item!.id ? -1 : a.item!.id > b.item!.id ? 1 : 0;
  };
  const bend = { x: 1, y: 1 };                  // how far off each elbow goes: one grid more per line bent in this event
  for (let ph = 0; ph < 4; ph++) {
    let any = false;
    for (const L of sim.drag.slice().sort(order)) {
      const s = phases.get(L)![ph]; if (!s[0] && !s[1]) continue; any = true;
      if (constrained) orthoLineDrag(sim, L, s, bend);
      L.pts[L.sel] = plus(L.pts[L.sel], s);
    }
    if (!any) continue;
    // the labels on a stretched line stay on it (m_specialCaseLabels)
    for (const lb of sim.labels) {
      const ln = lb.line, st = ln.pts[0], en = ln.pts[1], s = phases.get(lb.owner)![ph];
      if (lb.track) {
        lb.pos = plus(lb.pos, s);
        if (!nulLine(ln) && segDist(lb.orig, st, en) <= 1e-3 && !same(lb.orig, st, 1e-5) && !same(lb.orig, en, 1e-5)) { lb.track = false; lb.pos = lb.orig.slice(); lb.ls = st.slice(); lb.le = en.slice(); }
        continue;
      }
      const ds: Pt = [r4(st[0] - lb.ls[0]), r4(st[1] - lb.ls[1])], de: Pt = [r4(en[0] - lb.le[0]), r4(en[1] - lb.le[1])];
      if (same(ds, de, 1e-5)) { lb.pos = plus(lb.orig, ds); continue; }
      const startDrags = ln.sel === 0;
      lb.pos = plus(lb.orig, startDrags ? de : ds);
      // a line that shrank keeps the label: it goes to the nearest point, and rides the moving end once it is there
      if (segDist(lb.pos, st, en) > 1e-3) {
        const vx = en[0] - st[0], vy = en[1] - st[1], l2 = vx * vx + vy * vy, t = l2 ? Math.max(0, Math.min(1, ((lb.pos[0] - st[0]) * vx + (lb.pos[1] - st[1]) * vy) / l2)) : 0;
        lb.pos = [r4(st[0] + t * vx), r4(st[1] + t * vy)];
        if (same(lb.pos, startDrags ? st : en, 1e-5)) lb.track = true;
      }
    }
  }
  sim.at = [dx, dy]; sim.map = d.mapPt;
}
/** The simulation at the total offset (dx, dy); `doc` must still hold the pre-drag geometry when it is first built. */
function simAt(doc: KDoc, d: SchDrag, dx: number, dy: number): OrthoSim {
  if (!d.sim || d.sim.src !== d.anchors) d.sim = simBuild(doc, d);
  const sim = d.sim;
  if (sim.at[0] !== dx || sim.at[1] !== dy || sim.map !== d.mapPt) simAdvance(d, sim, dx, dy, !d.mode && S.lineMode !== "free");
  return sim;
}
function simWrite(doc: KDoc, d: SchDrag, sim: OrthoSim, pristine?: boolean) {
  for (const l of sim.lines) {
    if (l.item) { setPts(l.item.node, pristine ? l.orig! : l.pts); K.replaceChange(doc, l.item); }
    else if (!pristine && !l.dead && !nulLine(l)) d.preview.push({ kind: l.kind, pts: [l.pts[0], l.pts[1]] });
  }
  for (const lb of sim.labels) { const to = pristine ? lb.orig : lb.pos, [cx, cy] = atOf(lb.item.node); shiftNode(lb.item.kind, lb.item.node, r4(to[0] - cx), r4(to[1] - cy)); K.replaceChange(doc, lb.item); }
}
export function restoreNode(node: SNode, orig: SNode) { node.length = 0; for (const c of deep(orig)) node.push(c); }
export function lineCovers(doc: KDoc, kind: string, a: Pt, b: Pt) {                   // an existing collinear line already spans a-b
  for (const it of doc.items.values()) { if (it.kind !== kind) continue; for (const [s, e] of segs(it)) if (segDist(a, s, e) <= 1e-3 && segDist(b, s, e) <= 1e-3) return true; }
  return false;
}

// One item or a list of them (a multi-selection): every connection point of every moved item is an
// anchor, riders of every moved net line come along, and a line whose ends all sit on moved items
// (a wire between two dragged symbols) is promoted into the moved set so it just moves.
export function beginDrag(ctx: SchCtx, items: KItem | KItem[], mm: Pt, byPointer?: boolean, opts?: { plain?: boolean }) {
  const doc = ctx.doc, seen = new Set<string>(), list: KItem[] = [], partial: PartialLine[] = [];
  // SCH_MOVE_TOOL: FilterSelectionForLockedItems first (a pasted or repeated item is new, never locked)
  for (const it of Array.isArray(items) ? items : [items]) if (it && DRAG_KINDS.has(it.kind) && !seen.has(it.id) && !isLockedItem(doc, it)) {
    seen.add(it.id);
    // a line selected by one end (STARTPOINT / ENDPOINT): SCH_MOVE_TOOL::moveItem moves that end only
    const e = !(opts && opts.plain) && S.selEnds ? S.selEnds.get(it.id) : undefined, pts = e === 0 || e === 1 ? ptsOf(it.node) : null;
    if (pts && pts.length === 2) partial.push({ item: it, index: e!, orig: pts.map((q) => q.slice()) }); else list.push(it);
  }
  if (!list.length && !partial.length) return null;
  if (S.drag) endDrag(ctx, false);
  if (byPointer) S.dragMode = S.mouseDragMode || "drag";   // a mouse drag follows the preference, whatever G / M did last
  const item = list[0] || partial[0].item, anchor0 = list.length ? anchorOf(item.kind, item.node) : partial[0].orig[partial[0].index].slice();
  const d: SchDrag = { items: list.map((it) => ({ item: it, kind: it.kind, orig: deep(it.node) })), item, kind: item.kind, orig: null, anchor0, grab: [mm[0] - anchor0[0], mm[1] - anchor0[1]],
    last: [0, 0], applied: [0, 0], moved: false, byPointer: !!byPointer, riders: [], anchors: [], preview: [], grid: ctx.gridPitch || 1.27 };
  if (partial.length) d.ends = partial;
  const onLine = new Map<string, { item: KItem; orig: Pt; line: KItem }>();   // the labels kept on a stretched line
  d.orig = d.items.length ? d.items[0].orig : deep(item.node);
  for (let pass = 0; pass < 8 && !(opts && opts.plain); pass++) {   // plain: new items (a paste) carry nothing along                   // re-resolve after each promotion, the moved set grew
    const moving = new Set([...d.items.map((e) => e.item.id), ...partial.map((e) => e.item.id), ...onLine.keys()]);
    d.riders = [];
    for (const e of d.items) for (const r of ridersOf(doc, e.item)) if (!moving.has(r.item.id)) { moving.add(r.item.id); d.riders.push(r); }
    d.anchors = [];
    for (const e of d.items) for (const p of connPoints(doc, e.item)) d.anchors.push(makeAnchor(doc, e.item, p, moving));
    for (const e of partial) if (isNetLine(e.item.kind)) d.anchors.push(makeAnchor(doc, e.item, e.orig[e.index], moving));
    for (const r of d.riders) {
      if (r.item.kind === "junction") d.anchors.push(makeAnchor(doc, r.item, r.orig, moving));
      else if (r.item.kind === "bus_entry") for (const p of connPoints(doc, r.item)) d.anchors.push(makeAnchor(doc, r.item, p, moving));
    }
    const seenEnd = new Set<string>();                              // a line end belongs to one anchor only
    for (const a of d.anchors) a.ends = a.ends.filter((e) => { const k = e.item.id + ":" + e.index; if (seenEnd.has(k)) return false; seenEnd.add(k); return true; });
    const spanned: KItem[] = [], idx = new Map<string, Set<number>>();
    for (const a of d.anchors) for (const e of a.ends) { if (!idx.has(e.item.id)) idx.set(e.item.id, new Set()); idx.get(e.item.id)!.add(e.index); }
    for (const [id, ends] of idx) { const it = doc.items.get(id); const n = it ? ptsOf(it.node).length : 0; if (it && n > 1 && ends.has(0) && ends.has(n - 1)) spanned.push(it); }
    if (!spanned.length) {
      // getConnectedDragItems: every unselected label lying on a line that follows by one end joins the drag and is kept
      // on that line (m_specialCaseLabels); on a line the user selected by one end, not the ones on its fixed end
      let grew = false;
      const take = (line: KItem, pts: Pt[], fixed: Pt | null) => {
        if (!isNetLine(line.kind) || pts.length !== 2) return;
        for (const it of doc.items.values()) {
          if (!LABEL_KINDS.has(it.kind) || moving.has(it.id)) continue;
          const at = atOf(it.node).slice(0, 2);
          if (segDist(at, pts[0], pts[1]) > 1e-3 || (fixed && same(at, fixed))) continue;
          onLine.set(it.id, { item: it, orig: at, line }); moving.add(it.id); grew = true;
        }
      };
      for (const a of d.anchors) for (const e of a.ends) take(e.item, e.orig, null);
      for (const e of partial) take(e.item, e.orig, e.orig[e.index === 0 ? 1 : 0]);
      if (grew) continue;                                           // the anchors see them as moving now
      for (const a of d.anchors) for (const f of a.followers) moving.add(f.item.id);
      break;
    }
    for (const it of spanned) d.items.push({ item: it, kind: it.kind, orig: deep(it.node) });
  }
  // SCH_MOVE_TOOL: a SCH_DRAG_NET_COLLISION_MONITOR for any selection that is not graphics only
  d.onLine = Array.from(onLine.values());
  if (!(opts && opts.plain)) recordRedundantJunctions(doc, d);
  d.collision = d.items.some((e) => connPoints(doc, e.item).length) ? collisionInit(doc, d, !!(opts && opts.plain)) : null;
  S.drag = d; announceModes(ctx); return d;
}
/**
 * SCH_MOVE_TOOL::recordRedundantJunctions: a junction on an end of a line that moves, which is no junction once the
 * moving items are taken away, is hidden for the duration of the move (the painter gets no geometry for it) and
 * remembered with that line end; cleanupAt moves the same junction to where the end lands when one is needed there
 * (migrateHiddenJunctions), so it keeps its diameter and colour.
 */
export function recordRedundantJunctions(doc: KDoc, d: SchDrag) {
  const moving = new Set<string>(), lines: KItem[] = [];
  for (const e of d.items) { moving.add(e.item.id); if (LINE_KINDS.has(e.kind)) lines.push(e.item); }
  for (const r of d.riders) moving.add(r.item.id);
  for (const e of d.ends || []) { moving.add(e.item.id); lines.push(e.item); }
  for (const a of d.anchors) { for (const e of a.ends) { moving.add(e.item.id); lines.push(e.item); } for (const f of a.followers) moving.add(f.item.id); }
  for (const l of d.onLine || []) moving.add(l.item.id);
  d.hiddenJunctions = [];
  for (const line of lines) {
    const p = ptsOf(line.node); if (p.length !== 2) continue;
    for (let i = 0; i < 2; i++) {
      const j = junctionAt(doc, p[i][0], p[i][1]);
      if (!j || moving.has(j.id) || d.hiddenJunctions.some((h) => h.item === j)) continue;
      if (analyzePoint(doc, p[i], false, null, moving).isJunction) continue;
      d.hiddenJunctions.push({ item: j, line, index: i }); (j as { geom: unknown[] }).geom = [];
    }
  }
}
// Live preview: the moved items and stretched ends are edited in place (restored by endDrag),
// stub wires are drawn from d.preview by the overlay.
export function applyDrag(doc: KDoc, d: SchDrag, dx: number, dy: number, pristine?: boolean) {
  const connected = S.dragMode === "drag";
  // the orthoLineDrag state is built before anything moves; `pristine` (the originals go back before a commit) keeps it
  if (connected && !pristine && (!d.sim || d.sim.src !== d.anchors)) d.sim = simBuild(doc, d);
  for (const e of d.items) {
    if (e.base) { restoreNode(e.item.node, e.base); if (dx || dy) shiftNode(e.kind, e.item.node, dx, dy); }
    else if (!dx && !dy) restoreNode(e.item.node, e.orig);
    else shiftNode(e.kind, e.item.node, r4(dx - d.applied[0]), r4(dy - d.applied[1]));
    K.replaceChange(doc, e.item);
  }
  d.applied = [dx, dy];
  for (const r of d.riders) { if (r.base) restoreNode(r.item.node, r.base); const [cx, cy] = atOf(r.item.node); shiftNode(r.item.kind, r.item.node, r4(r.orig[0] + dx - cx), r4(r.orig[1] + dy - cy)); K.replaceChange(doc, r.item); }
  d.preview = [];
  // MOVE: nothing connected follows; a mode change restarts the operation (SCH_MOVE_TOOL::restartMoveOperation)
  if (!connected && d.sim) { simWrite(doc, d, d.sim, true); simReset(d.sim); }
  const sim = connected && !pristine ? simAt(doc, d, dx, dy) : null;
  for (const e of d.ends || []) {
    if (sim && sim.byId.has(e.item.id)) continue;
    // In MOVE mode, both endpoints always move (SCH_MOVE_TOOL::moveItem)
    const pts = e.orig.map((q) => (connected || pristine ? q.slice() : [r4(q[0] + dx), r4(q[1] + dy)]));
    setPts(e.item.node, pts); K.replaceChange(doc, e.item);
  }
  for (const a of d.anchors) {
    const Pn = anchorTo(d, a.p, dx, dy);
    for (const e of a.ends) {
      if (sim && sim.byId.has(e.item.id)) continue;
      const pts = e.orig.map((q: Pt) => q.slice());
      if (connected && !pristine) pts[e.index] = Pn;
      setPts(e.item.node, pts); K.replaceChange(doc, e.item);
    }
    for (const f of a.followers) { const to = connected ? Pn : f.orig; const [cx, cy] = atOf(f.item.node); shiftNode(f.item.kind, f.item.node, r4(to[0] - cx), r4(to[1] - cy)); K.replaceChange(doc, f.item); }
    if (connected && a.stub && !same(a.p, Pn)) d.preview.push({ kind: a.stub.kind, pts: [a.p, Pn] });
  }
  if (sim) simWrite(doc, d, sim);
  else if (pristine && d.sim) simWrite(doc, d, d.sim, true);
}
/** Where a connection point found before the drag is now: turned with the drag's R / X / Y, then moved. */
export function anchorTo(d: SchDrag, p: Pt, dx: number, dy: number): Pt { const q = d.mapPt ? d.mapPt(p) : p; return [r4(q[0] + dx), r4(q[1] + dy)]; }
/** The nodes as they were before the drag (a drag turned with R keeps its turned copies in `base`). */
export function restorePristine(doc: KDoc, d: SchDrag) {
  for (const e of d.items) if (e.base) { restoreNode(e.item.node, e.orig); K.replaceChange(doc, e.item); }
  for (const r of d.riders) if (r.node0) { restoreNode(r.item.node, r.node0); K.replaceChange(doc, r.item); }
  if (d.mapPt) for (const a of d.anchors) {                // the wires stretched to the turned pins go back too
    for (const e of a.ends) { setPts(e.item.node, e.orig.map((q: Pt) => q.slice())); K.replaceChange(doc, e.item); }
    for (const f of a.followers) { const [cx, cy] = atOf(f.item.node); shiftNode(f.item.kind, f.item.node, r4(f.orig[0] - cx), r4(f.orig[1] - cy)); K.replaceChange(doc, f.item); }
  }
  if (d.sim) simWrite(doc, d, d.sim, true);
}
/** The connection point of an item that is not moving nearest to p within the snap range (EE_GRID_HELPER's anchors). */
export function dragSnapAnchor(ctx: SchCtx, d: SchDrag, p: Pt): Pt | null {
  const r = Math.max((ctx.gridPitch || 1.27) * 0.45, 6 * mmPerPx(ctx)), moving = new Set<string>();
  for (const e of d.items) moving.add(e.item.id); for (const x of d.riders) moving.add(x.item.id); for (const e of d.ends || []) moving.add(e.item.id);
  for (const a of d.anchors) { for (const e of a.ends) moving.add(e.item.id); for (const f of a.followers) moving.add(f.item.id); }
  for (const l of d.onLine || []) moving.add(l.item.id);
  if (d.sim) for (const l of d.sim.lines) if (l.item) moving.add(l.item.id);
  let best: Pt | null = null, bd = r;
  for (const it of ctx.doc.items.values()) {
    if (moving.has(it.id)) continue;
    if (it.bbox && (p[0] < it.bbox[0] - r || p[0] > it.bbox[2] + r || p[1] < it.bbox[1] - r || p[1] > it.bbox[3] + r)) continue;
    for (const c of connPoints(ctx.doc, it)) { const dist = Math.hypot(c[0] - p[0], c[1] - p[1]); if (dist < bd) { bd = dist; best = c; } }
  }
  return best ? [r4(best[0]), r4(best[1])] : null;
}
/**
 * The pointer moved.  As in SCH_MOVE_TOOL's loop, Shift turns the snap to other items' anchors off
 * (grid.SetSnap( !MD_SHIFT )) and Ctrl the grid (SetUseGrid), except the Ctrl still held from the Ctrl+V of a paste.
 */
export function moveDrag(ctx: SchCtx, mm: Pt, ev?: Mods | null) {
  const d = S.drag; if (!d) return;
  const ctrl = !!(ev && (ev.ctrlKey || ev.metaKey)); d.lastCtrl = ctrl;
  if (d.pasted && d.ctrlAtStart === undefined) d.ctrlAtStart = true;
  if (d.ctrlAtStart && ev && !ctrl) d.ctrlAtStart = false;
  const raw: Pt = [mm[0] - d.grab[0], mm[1] - d.grab[1]];
  const snapped = (): Pt => {
    const hit = ev && !ev.shiftKey ? dragSnapAnchor(ctx, d, raw) : null;
    if (hit) return hit;
    return ctrl && !d.ctrlAtStart ? [r4(raw[0]), r4(raw[1])] : ctx.snap(raw);
  };
  // an arrow key locks the move to its axis, for the mouse too, until the opposite key (tools/axis-lock.ts)
  const key = keyboardCursorKey(); if (key) d.axis = axisLockKey(d.axis || newAxisLock(), key);
  const prev = [d.anchor0[0] + d.last[0], d.anchor0[1] + d.last[1]];
  const t = applyAxisLock(d.axis ? d.axis.lock : "", snapped(), prev);
  const dx = r4(t[0] - d.anchor0[0]), dy = r4(t[1] - d.anchor0[1]);
  if (dx === d.last[0] && dy === d.last[1]) return;
  d.last = [dx, dy]; d.moved = true;
  applyDrag(ctx.doc, d, dx, dy);
  d.hoverSheet = findTargetSheet(ctx, d, mm, ctrl);
  ctx.requestRender();
}
/** isGraphicItemForDrop: shapes, images, texts, text boxes and graphic lines. */
const GRAPHIC_DROP = new Set(["rectangle", "circle", "arc", "ellipse", "ellipse_arc", "bezier", "image", "text", "text_box", "polyline"]);
/**
 * SCH_MOVE_TOOL::findTargetSheet (MOVE mode only): the sheet the moving selection would be dropped into.  The sheet
 * under the cursor, else the first unselected sheet whose body holds the selection's box or its centre; never a
 * selected sheet, never when a connection point of the selection lands on one of that sheet's pins (the user is
 * connecting to the pin), never when the drop would recurse, and a graphics-only selection only with Ctrl held.
 */
export function findTargetSheet(ctx: SchCtx, d: SchDrag, cursor: Pt, ctrl: boolean): KItem | null {
  if (S.dragMode !== "move" || d.brk || !ctx.dropIntoSheet) return null;
  const doc = ctx.doc, sel = [...d.items.map((e) => e.item), ...(d.ends || []).map((e) => e.item)]; if (!sel.length) return null;
  const ids = new Set(sel.map((it) => it.id));
  const body = (it: KItem): Box => { const [x, y] = atOf(it.node), s = kid(it.node, "size"); return [x, y, x + num(s && s[1], 0), y + num(s && s[2], 0)]; };
  const holds = (b: Box, p: Pt) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
  let sheet: KItem | null = null;
  for (const it of doc.items.values()) if (it.kind === "sheet" && holds(body(it), cursor)) { sheet = it; break; }
  if (sheet && ids.has(sheet.id)) sheet = null;                 // never target a selected sheet
  if (!sheet) {
    let box: Box | null = null;
    for (const it of sel) { const b = it.bbox; if (b) box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : [b[0], b[1], b[2], b[3]]; }
    if (box && box[2] > box[0] && box[3] > box[1]) {
      const centre: Pt = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
      for (const it of doc.items.values()) {
        if (it.kind !== "sheet" || ids.has(it.id)) continue;
        const b = body(it);
        if ((b[0] <= box[0] && b[1] <= box[1] && b[2] >= box[2] && b[3] >= box[3]) || holds(b, centre)) { sheet = it; break; }
      }
    }
  }
  if (!sheet) return null;
  const pins = kids(sheet.node, "pin").map((p) => atOf(p));
  for (const it of sel) for (const p of connPoints(doc, it)) if (pins.some((q) => same(q, p))) return null;
  // dropWouldRecurse: a moved sheet that shows the destination's own file would put the file inside itself
  for (const it of sel) if (it.kind === "sheet" && it.file && it.file === sheet.file) return null;
  if (sel.every((it) => GRAPHIC_DROP.has(it.kind)) && !ctrl) return null;
  return sheet;
}
/**
 * SCH_MOVE_TOOL::moveSelectionToSheet: the moved items leave this sheet and are appended to the target's sub-sheet,
 * offset so the selection's box starts at the origin and stepped by 50 mil until it overlaps nothing there.
 */
function dropIntoSheet(ctx: SchCtx, d: SchDrag, sheet: KItem, dx: number, dy: number) {
  const doc = ctx.doc, sel = [...d.items.map((e) => ({ item: e.item, kind: e.kind })), ...(d.ends || []).map((e) => ({ item: e.item, kind: e.item.kind }))];
  // the items as the move left them (the document still shows them there), their box, and where they were
  let box: Box | null = null; const touched: Pt[] = [], nodes: { kind: string; node: SNode }[] = [];
  for (const { item, kind } of sel) {
    const b = item.bbox; if (b) box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : [b[0], b[1], b[2], b[3]];
    nodes.push({ kind, node: deep(item.node) });
  }
  applyDrag(doc, d, 0, 0, true); restorePristine(doc, d);
  for (const { item } of sel) touched.push(...connPoints(doc, item));
  const out = sel.map(({ item }) => K.removeChange(item));
  const changes = foldChanges(out, cleanupAt(doc, out, touched, new Set<string>(), ctx.IU || 1e4));
  ctx.commit(changes, "Move");
  setSelectionIds(ctx, []);                                     // ACTIONS::selectionClear
  const b0 = box || [0, 0, 0, 0];
  ctx.dropIntoSheet!(sheet, "Move", (sub: KDoc) => {
    let ox = -b0[0], oy = -b0[1];
    const hit = () => { const m = [b0[0] + ox, b0[1] + oy, b0[2] + ox, b0[3] + oy]; for (const it of sub.items.values()) { const e = it.bbox; if (e && m[0] <= e[2] && m[2] >= e[0] && m[1] <= e[3] && m[3] >= e[1]) return true; } return false; };
    for (let guard = 0; hit() && guard < 100000; guard++) { ox += 1.27; oy += 1.27; }
    ox = r4(ox); oy = r4(oy);
    return nodes.map(({ kind, node }) => { shiftNode(kind, node, ox, oy); const id = uuidOf(node); return { id, kind: "ADDED", typeName: typeNameFor({ kind }), sexpr: itemSexpr(doc, kind, node) } as KChange; });
  });
}
export function endDrag(ctx: SchCtx, commit: boolean) {
  const d = S.drag; S.drag = null; collisionCursor(ctx.stage, false); if (!d) return;
  for (const h of d.hiddenJunctions || []) if (ctx.doc.items.get(h.item.id) === h.item) K.replaceChange(ctx.doc, h.item);   // m_view->Hide( jct, false )
  // only a drag that really moved (or a key-started move) eats the following double click; an unmoved
  // press/release on a selected item must leave the dblclick to open its properties (SCH_SELECTION_TOOL::Main)
  if (d.moved || !d.byPointer) S.dragEndedAt = Date.now();
  const [dx, dy] = d.last, doc = ctx.doc;
  applyDrag(doc, d, 0, 0, true);                // originals back first, so commit() records a true inverse
  // the dangling-end cache was rebuilt with the items in flight: a cancel that drops or restores them leaves no commit
  // behind to bump the generation, so bump it here (KiCad's revert recomputes the screen's dangling state) and drop
  // the autostart cursor the in-flight ends gave
  const done = () => { S.docGen++; S.autoCursor = null; if (d.restoreMode) { S.dragMode = d.restoreMode; announceModes(ctx); } ctx.requestRender(); };
  if (d.brk) { endBreak(ctx, d, commit); done(); return; }
  if (d.local) {                                // a paste / duplicate in flight: never committed yet
    if (!commit) { dropLocal(ctx, d); done(); return; }
    const changes = dragChanges(ctx, d, dx, dy, true);
    for (const id of d.local) ctx.doc.items.delete(id);
    if (changes.length) ctx.commit(changes, d.label || "Paste");
    setSelectionIds(ctx, d.hover ? [] : Array.from(d.local).filter((id) => ctx.doc.items.has(id)));   // SetIsHover( m_duplicateIsHoverSelection )
    done(); return;
  }
  const turned = !!d.mapPt;
  if (!commit || (!turned && (!d.moved || (!dx && !dy)))) { restorePristine(doc, d); done(); return; }
  // only a committed move drops into a sheet; a graphics-only selection needs Ctrl still held (lastCtrlDown)
  const target = S.dragMode === "move" && d.hoverSheet && doc.items.get(d.hoverSheet.id) && (d.lastCtrl || ![...d.items.map((e) => e.kind), ...(d.ends || []).map((e) => e.item.kind)].every((k) => GRAPHIC_DROP.has(k))) ? d.hoverSheet : null;
  if (target) { applyDrag(doc, d, dx, dy); dropIntoSheet(ctx, d, target, dx, dy); done(); return; }
  const changes = dragChanges(ctx, d, dx, dy, true);
  if (changes.length) ctx.commit(changes, S.dragMode === "drag" ? "Drag" : "Move");   // SCH_MOVE_TOOL::Main's commit names
  done();
}
// The local items of a paste in flight go, with the library symbols the paste brought in.
export function dropLocal(ctx: SchCtx, d: SchDrag) {
  for (const id of d.local!) ctx.doc.items.delete(id);
  for (const name of d.libs || []) if (!Array.from(ctx.doc.items.values()).some((it) => it.kind === "symbol" && symbolLibId(it.node) === name)) ctx.doc.lib.delete(name);
  setSelectionIds(ctx, []);
}
export function cancelDrag(ctx: SchCtx) { if (S.drag) endDrag(ctx, false); }

// The committed change set for a finished drag, built from cloned nodes.
export function dragChanges(ctx: SchCtx, d: SchDrag, dx: number, dy: number, pristine = false) {
  const doc = ctx.doc, connected = S.dragMode === "drag", out = new Map<string, KChange>();
  // a turned drag builds from the turned copies, then hands the document its pre-drag nodes back so the commit's undo is true
  const res = dragChangeList(ctx, d, dx, dy, connected, out);
  if (pristine) restorePristine(doc, d);
  return res;
}
function dragChangeList(ctx: SchCtx, d: SchDrag, dx: number, dy: number, connected: boolean, out: Map<string, KChange>) {
  const doc = ctx.doc;
  const put = (c: KChange) => {
    const prev = out.get(c.id);
    if (prev && prev.kind === "ADDED" && c.kind === "REMOVED") { out.delete(c.id); doc.items.delete(c.id); return; }
    if (prev && prev.kind === "ADDED" && c.kind === "MODIFIED") c = Object.assign({}, c, { kind: "ADDED" });
    out.set(c.id, c);
  };
  const touched: Pt[] = [];
  for (const e of d.items) { const n = deep(e.item.node); shiftNode(e.kind, n, dx, dy); const c = modChange(doc, e.item, n); put(d.local && d.local.has(e.item.id) ? Object.assign(c, { kind: "ADDED" }) : c); }
  for (const r of d.riders) { const n = deep(r.item.node); shiftNode(r.item.kind, n, dx, dy); put(modChange(doc, r.item, n)); }
  // a pasted item the drag does not move (the group an import puts the new items in) is added as it is
  if (d.local) for (const id of d.local) { if (out.has(id)) continue; const it = doc.items.get(id); if (it && !DRAG_KINDS.has(it.kind)) put(Object.assign(modChange(doc, it, deep(it.node)), { kind: "ADDED" })); }
  // the lines that follow by one end, as orthoLineDrag left them, the lines it made and the labels it kept on them
  const sim = connected ? simAt(doc, d, dx, dy) : null;
  if (sim) {
    for (const l of sim.lines) {
      if (l.dead) continue;
      if (!l.item) { if (!nulLine(l)) { put(addNode(doc, lineNode(l.kind, l.pts[0], l.pts[1])).change); touched.push(...l.pts); } continue; }
      if (same(l.pts[0], l.orig![0], 1e-5) && same(l.pts[1], l.orig![1], 1e-5)) { if (l.sel >= 0) touched.push(...l.orig!); continue; }
      touched.push(...l.orig!, ...l.pts);
      if (nulLine(l)) put(K.removeChange(l.item)); else { const n = deep(l.item.node); setPts(n, l.pts); put(modChange(doc, l.item, n)); }
    }
    for (const lb of sim.labels) {
      if (same(lb.pos, lb.orig, 1e-5)) continue;
      const n = deep(lb.item.node), [cx, cy] = atOf(n); shiftNode(lb.item.kind, n, r4(lb.pos[0] - cx), r4(lb.pos[1] - cy)); put(modChange(doc, lb.item, n)); touched.push(lb.orig, lb.pos);
    }
  }
  for (const e of d.ends || []) {
    if (sim && sim.byId.has(e.item.id)) continue;
    // In MOVE mode, both endpoints always move (SCH_MOVE_TOOL::moveItem)
    const pts = e.orig.map((q) => [r4(q[0] + dx), r4(q[1] + dy)]);
    touched.push(...e.orig, ...pts);
    const n = deep(e.item.node); setPts(n, pts); put(modChange(doc, e.item, n));
  }
  for (const e of d.items) for (const p of (d.local && isNetLine(e.kind) ? ptsOf(e.item.node) : connPoints(doc, e.item))) { if (!d.local) touched.push(p); touched.push([r4(p[0] + dx), r4(p[1] + dy)]); }
  for (const p of d.touched0 || []) touched.push(p);
  if (connected) for (const a of d.anchors) {
    const Pn = anchorTo(d, a.p, dx, dy); touched.push(a.p, Pn);
    for (const e of a.ends) {
      if (sim && sim.byId.has(e.item.id)) continue;
      const pts = e.orig.map((q: Pt) => q.slice()); pts[e.index] = Pn;
      const n = deep(e.item.node); setPts(n, pts); put(modChange(doc, e.item, n));
    }
    for (const f of a.followers) { const n = deep(f.item.node), [cx, cy] = atOf(n); shiftNode(f.item.kind, n, r4(Pn[0] - cx), r4(Pn[1] - cy)); put(modChange(doc, f.item, n)); }
    if (a.stub && !same(a.p, Pn)) {
      if (a.stub.split) {                        // the line the label sat on becomes two lines meeting at the stub
        const m = a.stub.split, mp = ptsOf(m.node), n = deep(m.node);
        setPts(n, [mp[0], a.p]); put(modChange(doc, m, n));
        put(addNode(doc, lineNode(m.kind, a.p, mp[1])).change);
      }
      if (!lineCovers(doc, a.stub.kind, a.p, Pn)) put(addNode(doc, lineNode(a.stub.kind, a.p, Pn)).change);
    }
  }
  const keep = new Set([...d.items.map((e) => e.item.id), ...d.riders.map((r) => r.item.id), ...(d.ends || []).map((e) => e.item.id)]);
  if (connected) for (const a of d.anchors) { for (const e of a.ends) keep.add(e.item.id); for (const f of a.followers) keep.add(f.item.id); }   // SELECTED_BY_DRAG
  for (const c of cleanupAt(doc, Array.from(out.values()), touched, keep, ctx.IU || 1e4, d.hiddenJunctions)) put(c);
  for (const c of out.values()) if (c.kind === "ADDED") doc.items.delete(c.id);   // commit re-adds them from the fragments
  return autoRotateChanges(doc, Array.from(out.values()), ctx.IU || 1e4);
}
// What finalizeMoveOperation does after a move, evaluated on a dry run of the changes (applied, inspected, then put
// back so the document is untouched): TrimOverLappingWires for the changed items, AddJunctionsIfNeeded (AddJunction
// where IsExplicitJunctionNeeded says so, at the touched points and at every connection point lying on a changed
// line) and SCHEMATIC::CleanUp over the whole sheet.  `keep` holds the selected items: CleanUp leaves their junctions.
// The changes returned may name an id that `changes` already has (a moved line merged or split): fold them in with
// foldChanges.
export function cleanupAt(doc: KDoc, changes: KChange[], touched: Pt[], keep: Set<string>, IU: number, hidden?: { item: KItem; line: KItem; index: number }[] | null) {
  const saved = new Map<string, KItem | null>(); for (const c of changes) if (!saved.has(c.id)) saved.set(c.id, doc.items.get(c.id) || null);
  for (const c of changes) K.applyChange(doc, c, IU);
  const t = editTxn(doc, IU), base = new Map(changes.map((c) => [c.id, c.kind]));
  try {
    const moved: KItem[] = []; for (const c of changes) { const it = c.kind === "REMOVED" ? null : doc.items.get(c.id); if (it) moved.push(it); }
    txnTrimOverlapping(t, doc, moved);
    // migrateHiddenJunctions: the junction the move made redundant goes to its line's end when one is needed there
    for (const h of hidden || []) {
      const j = doc.items.get(h.item.id), line = doc.items.get(h.line.id); if (!j || !line || ptsOf(line.node).length !== 2) continue;
      const at = atOf(j.node).slice(0, 2), to = ptsOf(line.node)[h.index];
      if (same(to, at) || analyzePoint(doc, at, false).allows || !explicitJunctionNeeded(doc, to)) continue;
      const n = deep(j.node), a = kid(n, "at")!; a[1] = r4(to[0]); a[2] = r4(to[1]); t.modify(j, n);
    }
    const pts: Pt[] = [], seen = new Set<string>(), push = (p: Pt) => { const k = r4(p[0]) + "," + r4(p[1]); if (!seen.has(k)) { seen.add(k); pts.push(p); } };
    for (const p of touched) push(p);
    const conns = screenConnections(doc);
    for (const it of moved) if (isNetLine(it.kind)) for (const [a, b] of segs(it)) for (const c of conns) if (segDist(c, a, b) <= 1e-3) push(c);
    for (const p of pts) if (explicitJunctionNeeded(doc, p)) txnAddJunction(t, doc, p);
    txnCleanUpAll(t, doc, keep);
  } finally {
    t.restore();
    for (const [id, obj] of saved) { if (obj) doc.items.set(id, obj); else doc.items.delete(id); }
  }
  // an item the changes add and the cleanup then edits is still an addition
  return t.changes().map((c) => (base.get(c.id) === "ADDED" && c.kind === "MODIFIED" ? Object.assign({}, c, { kind: "ADDED" }) : c));
}
/** `base` with the cleanup's changes folded in: one change per item, an addition that was cleaned away again gone. */
export function foldChanges(base: KChange[], extra: KChange[]): KChange[] {
  const out = new Map<string, KChange>(); for (const c of base) out.set(c.id, c);
  for (const c of extra) {
    const prev = out.get(c.id);
    if (prev && prev.kind === "ADDED" && c.kind === "REMOVED") out.delete(c.id);
    else out.set(c.id, prev && prev.kind === "ADDED" && c.kind === "MODIFIED" ? Object.assign({}, c, { kind: "ADDED" }) : c);
  }
  return Array.from(out.values());
}
/**
 * AddJunction's BreakSegments on a dry run: the wires and buses running through p split there, applied to the doc
 * (`saved` keeps what to put back) so a later point on the same line splits the right half; `inFlight` lines are
 * left alone.  A line already split here replaces its earlier change in `out`.
 */
export function breakInto(doc: KDoc, p: Pt, saved: Map<string, KItem | null>, inFlight: Set<string>, out: KChange[], IU: number) {
  for (const kd of ["wire", "bus"]) for (const c of breakLinesAt(doc, p, kd)) {
    if (inFlight.has(c.id)) continue;
    if (!saved.has(c.id)) saved.set(c.id, doc.items.get(c.id) || null);
    K.applyChange(doc, c, IU);
    const i = out.findIndex((o) => o.id === c.id); if (i < 0) out.push(c); else out[i] = out[i].kind === "ADDED" ? Object.assign({}, c, { kind: "ADDED" }) : c;   // a piece split again stays an addition
  }
}
/**
 * SCH_EDIT_FRAME::DeleteJunction's line pass at p, the junction already gone: every pair of two-point wires / buses
 * ending there that are parallel is looked at; a line identical to another goes, lines that MergeOverlap become one
 * (which is paired again with the rest).  Returns each touched line's new segment, or null for a line to remove.
 */
export function junctionMerges(doc: KDoc, p: Pt): { id: string; seg: Pt[] | null }[] {
  interface L { item: KItem; seg: Pt[]; dead: boolean; made: boolean }
  const lines: L[] = [];
  for (const it of doc.items.values()) {
    if (!isNetLine(it.kind)) continue; const q = ptsOf(it.node); if (q.length !== 2) continue;
    if (same(q[0], p) || same(q[1], p)) lines.push({ item: it, seg: [q[0].slice(), q[1].slice()], dead: false, made: false });
  }
  const parallel = (a: Pt[], b: Pt[]) => Math.abs((a[1][0] - a[0][0]) * (b[1][1] - b[0][1]) - (a[1][1] - a[0][1]) * (b[1][0] - b[0][0])) <= 1e-9;
  const isEnd = (s: Pt[], q: Pt) => same(s[0], q) || same(s[1], q);
  const strokeOf = (it: KItem) => { const st = kid(it.node, "stroke"); return st ? K.serialize(st) : ""; };
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const a = lines[i], b = lines[j];
    if (a.dead || b.dead || !parallel(a.seg, b.seg)) continue;
    if (isEnd(a.seg, b.seg[0]) && isEnd(a.seg, b.seg[1])) { a.dead = true; continue; }       // identical lines: one goes
    if (a.item.kind !== b.item.kind || strokeOf(a.item) !== strokeOf(b.item)) continue;        // MergeOverlap: same layer and stroke
    const m = mergeOverlap([b.seg[0], b.seg[1]], [a.seg[0], a.seg[1]], null); if (!m) continue;
    a.dead = true; b.dead = true; lines.push({ item: b.item, seg: m, dead: false, made: true });
  }
  const last = new Map<string, L>(); for (const l of lines) last.set(l.item.id, l);
  const out: { id: string; seg: Pt[] | null }[] = [];
  for (const [id, l] of last) { if (l.dead) out.push({ id, seg: null }); else if (l.made) out.push({ id, seg: l.seg }); }
  return out;
}

