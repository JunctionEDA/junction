// The hero: a cut-down board editor the visitor can use.  It is the demo board with
// nothing on it yet but its outline, painted by the editor's renderer, with just enough tools to finish
// it: move a footprint or a text, route a track, drop a via, switch layer, undo.  Three scripted
// collaborators design the board from scratch as teammates would in a real project: they take
// the parts out of the pile and place them, route every connection, add the labels and pour
// the ground plane, and then review it: redo a track, try a part somewhere else, drag selection boxes and pin comments, each
// with a pointer that moves like a hand on a mouse and never does the same thing twice.  When
// the visitor has changed something one of them comes over and puts it back by hand.

import {
  BOARD, Box, HIDDEN, K, PEERS, boardText, Pt, Rat, View, clamp, clash, copperAt, dist, drawCursor, fit, lerp, loadPcb, loadPcbOpen, meta, mixBox, ratsnest, toMm, toPx, trackAt,
} from "./demo";
import { keysInText } from "../keys";
import { SANS, Stage, makeStage, reducedMotion } from "./stage";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tool = "select" | "route" | "via";
type Layer = "F.Cu" | "B.Cu";
const GRID = 0.25, VIA = { size: 0.6, drill: 0.3 };
/** The board's net class clearance: new copper keeps this far from every other net. */
const CLEARANCE = 0.2;
const LAYER_COLOR: Record<Layer, string> = { "F.Cu": "#C83434", "B.Cu": "#4D7FC4" };
const HOME: Box = [BOARD.x - 3, BOARD.y - 3, BOARD.x + BOARD.w + 3, BOARD.y + BOARD.h + 3];
/** The view while the board is being built: the board and, beside it, the pile its parts start in. */
/** Where a part waits in the pile: the demo's pile, spread a little so the big parts do not overlap. */
const pileAt = (p: { pile: Pt }): Pt => [175 + (p.pile[0] - 175) * 1.3, p.pile[1]];
const BUILD: Box = [HOME[0], HOME[1], Math.max(...meta.parts.map((p) => pileAt(p)[0])) + 4.5, HOME[3]];
/** For each connection, the earlier ones it starts or ends on (a via, a track it tees into):
 *  those have to be on the board before it can be routed. */
const NEEDS: number[][] = meta.routes.map((r, j) => {
  const ends = [r.pts[0], r.pts[r.pts.length - 1]];
  const on = (e: Pt, a: Pt, b: Pt): boolean => { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy, t = l ? clamp(((e[0] - a[0]) * dx + (e[1] - a[1]) * dy) / l) : 0; return Math.hypot(e[0] - a[0] - t * dx, e[1] - a[1] - t * dy) < 0.01; };
  return meta.routes.map((_, i) => i).filter((i) => i < j && ends.some((e) => meta.routes[i].pts.some((p, k, all) => k > 0 && on(e, all[k - 1], p))));
});
/** Connections the board always starts without: the output, the LED, its ground, and the
 *  back-layer jumper. */
const OPEN = [26, 27, 28, 20];
/** Connections that stand on their own (pad to pad, or pad to a via into the pour), so one can
 *  be taken out and laid again without leaving another track hanging.  A few more of these are
 *  open at the start, different ones each visit, and the teammates redo one now and then. */
const LOOSE = [0, 1, 2, 3, 6, 10, 11, 12, 13, 14, 15, 17, 18, 21, 22, 23, 24, 25];
const REDO = [...LOOSE, 26, 27, 28];
const PARTS = new Set(meta.parts.map((p) => p.id));
const snap = (v: number, o: number): number => o + Math.round((v - o) / GRID) * GRID;

/** What a scripted teammate can be busy with.  All up to "nudge" change the board and are seen
 *  through to the end; the rest can be dropped when the visitor's change needs taking back. */
type Task = "undo" | "place" | "route" | "label" | "pour" | "redo" | "nudge" | "look" | "sweep" | "note" | "rest";
const HARD = new Set<Task>(["undo", "place", "route", "label", "pour", "redo", "nudge"]);
/** How each of them handles a mouse: Mara is quick and overshoots, Jun is slower and exact. */
const HANDS = [{ tempo: 0.86, miss: 1.3 }, { tempo: 1.2, miss: 0.55 }, { tempo: 1, miss: 1 }];
/** Review comments they leave on parts, as in a real project. */
const NOTES: [string, string][] = [
  ["R5", "330R puts about 9 mA through the LED"], ["C2", "Could C2 move closer to pin 8?"], ["J1", "5k1 on both CC pins, checked"],
  ["R4", "47k with 10u blinks at about 1.4 Hz"], ["D1", "Is D1 the right way round?"], ["U1", "Pin 5 has its 10n"], ["C3", "Timing cap, keep it near pin 6"],
  ["R3", "10k is fine here"], ["C1", "Bulk cap could be 0805"],
];
/** A change the visitor made, kept so that it can be taken back: by them, or by a teammate. */
type Edit = { kind: "move"; id: string; from: Pt } | { kind: "add"; ids: string[] } | { kind: "del"; item: any };
/** One stretch of a teammate's pointer: to `to` in `dur` seconds, along a curve when `c` gives
 *  its two control points.  `skew` bends the speed (fast away, slow in), `wob` is how far the
 *  hand strays sideways on a drag. */
interface Step { dur: number; to: Pt; c?: [Pt, Pt]; skew?: number; wob?: number; ph?: number; start?: () => void; tick?: (at: Pt) => void; end?: () => void }
/** A track being pulled out by a teammate: from `a` towards `b`, so far up to `at`. */
interface Pull { a: Pt; b: Pt; at: Pt; layer: Layer; w: number }
interface Actor {
  who: number; at: Pt; from: Pt; steps: Step[]; i: number; t0: number; task: Task; last: Task;
  marks: string[]; held: string | null; pull: Pull | null; poly: Pt[] | null; box: [Pt, Pt] | null; boxed: string[];
  move: { id: string; from: Pt } | null; route: number | null;
}
interface Note { who: number; at: Pt; text: string; n: number; born: number; dies: number }
const IDLE = 2200, GAP = 900;                       // ms the visitor is left alone before, and between, undos
const minJerk = (u: number): number => u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (10 - 15 * u + 6 * u * u);
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
const chance = (p: number): boolean => Math.random() < p;
/** Roughly -1 to 1, bunched around 0. */
const gauss = (): number => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const any1 = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

export function startMini(root: HTMLElement): void {
  const canvas = root.querySelector("canvas")!;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const xy = q("[data-xy]"), zoomOut = q("[data-z]"), counts = q("[data-counts]"), unrouted = q("[data-unrouted]"), toolName = q("[data-toolname]");
  const still = reducedMotion();
  /** `/?hero=alone` leaves the visitor the board to themselves, with the same four connections
   *  open every time: scripts/onboarding-ui.mjs routes one of them and carries the board over. */
  const alone = /[?&]hero=alone\b/.test(location.search);

  let doc = loadPcbOpen();
  let tool: Tool = "select", layer: Layer = "F.Cu", box: Box = HOME.slice() as Box;
  let view: View | null = null, selected: string | null = null, hover: Pt | null = null;
  let rats: Rat[] = [], dirty = true, touched = false;
  let drag: { id: string; from: Pt; grab: Pt; moved: boolean } | null = null;
  let pan: { at: Pt; box: Box } | null = null;
  let route: { net: number; from: Pt; layer: Layer; made: string[] } | null = null;
  const edits: Edit[] = [];
  const actors: Actor[] = []; const gone = new Set<number>();
  let note: Note | null = null;
  let lastAct = 0, nextUndo = 0, nextRedo = 0, nextNote = 0, stillTimer = 0, blocked: number | null = null;
  let base: HTMLCanvasElement | null = null, t0 = 0, serial = 0;

  /** The tracks and vias taken off the board at the start, for the teammates to lay again. */
  const spare = new Map<string, any>();
  /** Takes a connection's tracks and via off the board and keeps them for laying again. */
  function lift(i: number): void {
    const r = meta.routes[i];
    for (const id of [...r.ids, ...(r.via ? [r.via] : [])]) { const it = doc.items.get(id); if (it) { spare.set(id, it); doc.items.delete(id); } }
    gone.add(i);
  }
  /** Parts still in the pile, and the labels and the ground pour not yet made: the teammates
   *  start from the bare outline and design the board while the visitor watches. */
  const unplaced = new Set<string>(), shelf = new Map<string, any>();
  let poured = true, fitTo: Box = HOME, own = false, glide: { from: Box; t0: number } | null = null;
  /** The parts each connection reaches, which have to be placed before it is routed. */
  const reaches: string[][] = (() => {
    const full = loadPcb();
    return meta.routes.map((r) => { const ids = new Set<string>(); for (const p of r.pts) { const c = copperAt(full, p[0], p[1], r.layer); if (c && c.kind === "pad") ids.add(c.id); } return [...ids]; });
  })();
  function open(): void {
    spare.clear(); gone.clear(); unplaced.clear(); shelf.clear(); poured = true; fitTo = HOME; own = false; glide = null;
    if (still) return;                                   // without motion the board is simply complete
    if (alone) { for (const i of OPEN) lift(i); return; }
    meta.routes.forEach((_, i) => lift(i));
    for (const q of meta.parts) { const it = doc.items.get(q.id); if (it) { const at = pileAt(q); K.moveItem(doc, it, at[0], at[1], 1e6); unplaced.add(q.id); } }
    for (const it of [...doc.items.values()]) if (it.kind === "gr_text" || it.id === meta.zone) { shelf.set(it.id, it); doc.items.delete(it.id); }
    poured = false; fitTo = BUILD;
  }
  open(); box = fitTo.slice() as Box;

  const netName = (net: number): string => { const n = (doc as any).nets && (doc as any).nets.get ? (doc as any).nets.get(net) : null; return typeof n === "string" && n ? n : `net ${net}`; };
  const netWidth = (net: number): number => net === 1 || net === 2 ? 0.4 : 0.25;
  const newId = (): string => `mini-${++serial}-${Math.random().toString(36).slice(2, 8)}`;
  const f3 = (v: number): number => Math.round(v * 1000) / 1000;
  function addSegment(a: Pt, b: Pt, net: number, on: Layer): string {
    const id = newId();
    K.addItem(doc, K.parse(`(segment (start ${f3(a[0])} ${f3(a[1])}) (end ${f3(b[0])} ${f3(b[1])}) (width ${netWidth(net)}) (layer "${on}") (net ${net}) (uuid "${id}"))`));
    return id;
  }
  function addVia(at: Pt, net: number): string {
    const id = newId();
    K.addItem(doc, K.parse(`(via (at ${f3(at[0])} ${f3(at[1])}) (size ${VIA.size}) (drill ${VIA.drill}) (layers "F.Cu" "B.Cu") (net ${net}) (uuid "${id}"))`));
    return id;
  }
  const posOf = (it: any): Pt => { const at = K.atOf(it.node); return [at[0], at[1]]; };
  /** What a press with the arrow tool takes hold of: the item under it, and a text anywhere in its box. */
  function pick(at: Pt): string | null {
    const hit: string | null = K.hitTest(doc, at[0], at[1], 0.3, { hidden: HIDDEN });
    // A track or via under the pointer beats a part that is only hit by its outline, as in
    // PCB_SELECTION_TOOL::GuessSelectionCandidates: on a pad the part still wins.
    if (hit && PARTS.has(hit)) {
      const tr = trackAt(doc, at[0], at[1], 0), it = tr ? doc.items.get(tr) : null;
      if (it) { const on = it.kind === "via" ? layer : (it.geom as any[])[0].layer, c = copperAt(doc, at[0], at[1], on); if (!c || c.kind !== "pad") return tr; }
    }
    if (hit && (PARTS.has(hit) || doc.items.get(hit)?.kind === "gr_text")) return hit;
    for (const it of doc.items.values()) if (it.kind === "gr_text" && it.bbox && at[0] >= it.bbox[0] && at[0] <= it.bbox[2] && at[1] >= it.bbox[1] && at[1] <= it.bbox[3]) return it.id;
    return hit;
  }
  /** The other net whose copper is under the pointer while a track is being laid, if any. */
  function foreign(at: Pt | null): number | null {
    if (!route || !at) return null;
    const c = copperAt(doc, at[0], at[1], route.layer);
    return c && c.net !== route.net ? c.net : null;
  }
  const movable = (id: string | null): boolean => !!id && (PARTS.has(id) || doc.items.get(id)?.kind === "gr_text");
  /** One undo step that takes back everything added since `made` was started. */
  function remember(made: string[]): void { if (made.length) edits.push({ kind: "add", ids: made }); }
  function revert(e: Edit): void {
    if (e.kind === "move") { const it = doc.items.get(e.id); if (it) K.moveItem(doc, it, e.from[0], e.from[1], 1e6); }
    else if (e.kind === "add") { for (const id of e.ids) doc.items.delete(id); }
    else doc.items.set(e.item.id, e.item);
  }
  function redraw(): void { dirty = true; stage.invalidate(); sync(); }
  function change(): void {
    touched = true; lastAct = performance.now(); redraw();
    // Without motion nobody walks over: the change is simply taken back after a moment.
    if (still) { clearTimeout(stillTimer); stillTimer = window.setTimeout(stillUndo, IDLE + 600); }
  }
  function stillUndo(): void {
    if (drag || route) { stillTimer = window.setTimeout(stillUndo, GAP); return; }
    const e = edits.pop(); if (!e) return;
    revert(e); selected = null; redraw();
    if (edits.length) stillTimer = window.setTimeout(stillUndo, GAP + 300);
  }

  // ------------------------------------------------------------------ teammates

  const refId = (ref: string): string | undefined => meta.parts.find((p) => p.ref === ref)?.id;
  const inset = (m: number): Pt => [rnd(BOARD.x + m, BOARD.x + BOARD.w - m), rnd(BOARD.y + m, BOARD.y + BOARD.h - m)];
  /** The point of the line a-b nearest the pointer, on the grid along it; a little past `b` is
   *  allowed, since a hand runs over the corner before it comes back to click. */
  function along(a: Pt, b: Pt, c: Pt): Pt {
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy); if (len < 1e-6) return a;
    const t = clamp(((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / (len * len), 0, 1 + 0.6 / len), s = Math.round((t * len) / GRID) * GRID;
    return [a[0] + (dx / len) * s, a[1] + (dy / len) * s];
  }
  /** Where a step's pointer is at `u` (0 to 1) of its time. */
  function spot(from: Pt, st: Step, u: number): Pt {
    const k = minJerk(st.skew ? Math.pow(u, st.skew) : u), j = 1 - k;
    let x = lerp(from[0], st.to[0], k), y = lerp(from[1], st.to[1], k);
    if (st.c) {
      const [p, q] = st.c;
      x = j * j * j * from[0] + 3 * j * j * k * p[0] + 3 * j * k * k * q[0] + k * k * k * st.to[0];
      y = j * j * j * from[1] + 3 * j * j * k * p[1] + 3 * j * k * k * q[1] + k * k * k * st.to[1];
    }
    if (st.wob) {
      const dx = st.to[0] - from[0], dy = st.to[1] - from[1], d = Math.hypot(dx, dy) || 1, s = st.wob * Math.sin((st.ph || 0) + u * 9) * Math.sin(Math.PI * u);
      x -= (dy / d) * s; y += (dx / d) * s;
    }
    return [x, y];
  }
  /**
   * Writes a teammate's pointer the way a hand moves a mouse.  A reach takes longer the further
   * it goes (Fitts's law) and never the same time twice; it follows a bent path, leaves fast and
   * comes in slowly, often lands a little past or short of the target and is then corrected, and
   * on a long way it may stop once to look.  While waiting the hand shifts now and then.
   */
  function plan(who: number, from: Pt) {
    const h = HANDS[who], steps: Step[] = []; let at = from;
    const curve = (to: Pt, dur: number, bend: number): void => {
      const dx = to[0] - at[0], dy = to[1] - at[1], d = Math.hypot(dx, dy) || 1, nx = -dy / d, ny = dx / d;
      const b1 = gauss() * d * 0.17 * bend, b2 = (chance(0.8) ? b1 : -b1) * rnd(0.3, 1.1), k1 = rnd(0.18, 0.42), k2 = rnd(0.58, 0.86);
      steps.push({ dur, to, skew: rnd(0.7, 0.98), c: [[at[0] + dx * k1 + nx * b1, at[1] + dy * k1 + ny * b1], [at[0] + dx * k2 + nx * b2, at[1] + dy * k2 + ny * b2]] });
      at = to;
    };
    const reach = (to: Pt): void => {
      const d = dist(at, to); if (d < 0.02) return;
      const dx = (to[0] - at[0]) / d, dy = (to[1] - at[1]) / d;
      const T = (0.17 + 0.15 * Math.log2(1 + d / 1.5)) * rnd(0.82, 1.3) * h.tempo;
      if (d > 14 && chance(0.2)) {                         // a stop on the way, to find the thing
        const k = rnd(0.35, 0.68), off = gauss() * d * 0.07;
        curve([at[0] + dx * d * k - dy * off, at[1] + dy * d * k + dx * off], T * (0.35 + k * 0.65), 1);
        steps.push({ dur: rnd(0.16, 0.55), to: at });
        reach(to); return;
      }
      if (d > 5 && chance(0.5 * h.miss)) {                 // past it or short of it, then corrected
        const over = (chance(0.75) ? 1 : -1) * Math.min(1.6, d * rnd(0.03, 0.075)), side = gauss() * Math.min(0.9, d * 0.035);
        curve([to[0] + dx * over - dy * side, to[1] + dy * over + dx * side], T, 1);
        steps.push({ dur: rnd(0.04, 0.13), to: at });
        curve(to, rnd(0.13, 0.24) * h.tempo, 0.4);
      } else curve(to, T, 1);
    };
    const p = {
      steps,
      get at(): Pt { return at; },
      /** Stay exactly here, then do `fn`. */
      wait(sec: number, fn?: () => void) { steps.push({ dur: sec, to: at, end: fn }); return p; },
      /** Stay around here: still for a while, a small shift, still again. */
      rest(sec: number) {
        let left = sec;
        while (left > 0) {
          const s = Math.min(left, rnd(0.45, 1.5)); steps.push({ dur: s, to: at }); left -= s;
          if (left > 0.25 && chance(0.55)) { const t = rnd(0.12, 0.3); curve([at[0] + gauss() * 0.5, at[1] + gauss() * 0.5], t, 0.3); left -= t; }
        }
        return p;
      },
      /** Reach for a point. */
      go(to: Pt) { reach(to); return p; },
      /** The beat on a point before the button goes down, then `fn`. */
      click(fn: () => void) { steps.push({ dur: rnd(0.07, 0.17), to: at, end: fn }); return p; },
      /** Drag to a point with the button held: nearly straight, at `speed` mm a second, with
       *  a pause on the way now and then. */
      pull(to: Pt, speed: number, tick: (at: Pt) => void, lo = 0.3, hi = 3) {
        const d = dist(at, to), sec = clamp(d / speed, lo, hi) * h.tempo, wob = (): number => Math.min(0.32, d * 0.05) * rnd(0.3, 1);
        if (d > 4 && chance(0.2)) {
          const k = rnd(0.3, 0.7), mid: Pt = [lerp(at[0], to[0], k), lerp(at[1], to[1], k)];
          steps.push({ dur: sec * k + 0.08, to: mid, wob: wob(), ph: rnd(0, 6), skew: rnd(0.8, 1), tick });
          steps.push({ dur: rnd(0.15, 0.5), to: mid, tick });
          steps.push({ dur: sec * (1 - k) + 0.08, to, wob: wob(), ph: rnd(0, 6), skew: rnd(0.8, 1), tick });
        } else steps.push({ dur: sec, to, wob: wob(), ph: rnd(0, 6), skew: rnd(0.8, 1), tick });
        at = to;
        return p;
      },
    };
    return p;
  }
  type Plan = ReturnType<typeof plan>;

  /** Puts the three of them on the board, each waiting a different moment before starting. */
  function cast(now: number): void {
    actors.length = 0; note = null; nextRedo = now + 6000; nextNote = now + 5000;
    if (alone) return;
    const at: Pt[] = unplaced.size ? [[179, BOARD.y + 5], [187, BOARD.y + 17], [177, BOARD.y + 23]] : [[BOARD.x + 11, BOARD.y + 12], [BOARD.x + 36, BOARD.y + 13], [BOARD.x + 21, BOARD.y + 22]];
    PEERS.forEach((_, who) => {
      const p: Pt = still ? at[who] : [at[who][0] + gauss() * 3, at[who][1] + gauss() * 2];
      actors.push({ who, at: p, from: p, steps: [{ dur: 0.5 + who * 0.8 + rnd(0, 0.5), to: p }], i: 0, t0: now, task: "rest", last: "rest", marks: [], held: null, pull: null, poly: null, box: null, boxed: [], move: null, route: null });
    });
  }
  /** Lets go of whatever a teammate holds or shows. */
  function drop(a: Actor, now: number): void {
    if (a.task === "note" && note && note.who === a.who) note.dies = Math.min(note.dies, now + 300);
    if (a.task === "undo") nextUndo = now + GAP;
    a.last = a.task; a.task = "rest"; a.steps = []; a.i = 0; a.t0 = now; a.from = a.at;
    a.marks = []; a.held = null; a.pull = null; a.poly = null; a.box = null; a.boxed = []; a.move = null; a.route = null;
  }
  /** Moves a teammate along to `now`, running what their steps do, and has them pick the next
   *  thing when one is finished. */
  function run(a: Actor, now: number): void {
    for (;;) {
      const st = a.steps[a.i];
      if (!st) { drop(a, now); think(a, now); if (!a.steps.length) return; continue; }
      const u = st.dur > 0 ? (now - a.t0) / (st.dur * 1000) : 1;
      if (st.start) { st.start(); st.start = undefined; }
      a.at = spot(a.from, st, clamp(u));
      if (st.tick) st.tick(a.at);
      if (u < 1) return;
      a.at = st.to; if (st.end) st.end();
      if (a.steps[a.i] !== st) return;                      // what it did ended the task
      a.from = st.to; a.t0 += st.dur * 1000; a.i++;
    }
  }
  /** Carries an item with the pointer, on the grid measured from `home`. */
  function carry(it: any, c: Pt, home: Pt): void {
    const x = snap(c[0], home[0]), y = snap(c[1], home[1]), q = posOf(it);
    if (q[0] !== x || q[1] !== y) { K.moveItem(doc, it, x, y, 1e6); dirty = true; }
  }

  /** Takes back the visitor's latest change the way a person would: over to it, press, and
   *  slowly back to where it was. */
  function planUndo(a: Actor, p: Plan, e: Edit): boolean {
    if (e.kind === "move") {
      const it = doc.items.get(e.id); if (!it) return false;
      const at = posOf(it), home = e.from; if (dist(at, home) < 1e-6) return false;
      a.move = { id: e.id, from: home };
      p.go(at).click(() => { a.marks = [e.id]; });
      p.pull(home, rnd(4, 6), (c) => carry(it, c, home), 1, 3.2);
      p.wait(0.05, () => { K.moveItem(doc, it, home[0], home[1], 1e6); redraw(); });
      p.wait(0.3, () => { a.marks = []; a.move = null; });
    } else if (e.kind === "add") {
      // Last placed first, one piece at a time, as repeated undo would.
      for (const id of e.ids.slice().reverse()) {
        const it = doc.items.get(id), g = it && (it.geom as any[])[0]; if (!g) continue;
        const c: Pt = it!.kind === "via" ? [g.x, g.y] : [lerp(g.x1, g.x2, rnd(0.3, 0.7)), lerp(g.y1, g.y2, rnd(0.3, 0.7))];
        p.go(c).click(() => { a.marks = [id]; });
        p.wait(rnd(0.2, 0.4), () => { doc.items.delete(id); a.marks = []; redraw(); });
      }
    } else {
      // Something the visitor deleted is laid again.
      const it = e.item, g = (it.geom as any[])[0];
      if (it.kind === "via" || !g) { if (g) p.go([g.x, g.y]); p.click(() => { doc.items.set(it.id, it); redraw(); }); }
      else {
        const s: Pt = [g.x1, g.y1], t: Pt = [g.x2, g.y2];
        p.go(s).click(() => { a.pull = { a: s, b: t, at: s, layer: g.layer, w: g.w }; });
        p.pull(t, rnd(5.5, 8.5), (c) => { if (a.pull) a.pull.at = along(s, t, c); }, 0.45, 1.6);
        p.click(() => { a.pull = null; doc.items.set(it.id, it); redraw(); });
      }
    }
    p.rest(rnd(0.2, 0.5));
    return p.steps.length > 1;
  }
  /** Routes an open connection as the router does it: click on the pad, pull the track out,
   *  click at each corner, and the via drops where it ends. */
  function planRoute(a: Actor, p: Plan, ri: number): boolean {
    const r = meta.routes[ri], pts = r.pts as Pt[], on = r.layer as Layer;
    const out = (i: number): Pull | null => { const it = spare.get(r.ids[i]); return it ? { a: pts[i], b: pts[i + 1], at: pts[i], layer: on, w: (it.geom as any[])[0].w } : null; };
    a.route = ri;
    p.go(pts[0]).click(() => { a.pull = out(0); });
    for (let i = 1; i < pts.length; i++) {
      const s = pts[i - 1], t = pts[i], id = r.ids[i - 1], last = i === pts.length - 1, d = dist(s, t) || 1;
      const tick = (c: Pt): void => { if (a.pull) a.pull.at = along(s, t, c); };
      if (d > 1.5 && chance(0.3 * HANDS[a.who].miss)) {     // runs over the corner and comes back
        const o = rnd(0.25, 0.6);
        p.pull([t[0] + ((t[0] - s[0]) / d) * o, t[1] + ((t[1] - s[1]) / d) * o], rnd(5, 9), tick, 0.3, 1.5).wait(rnd(0.04, 0.1));
        p.pull(t, 4, tick, 0.12, 0.2);
      } else p.pull(t, rnd(5, 9), tick, 0.3, 1.5);
      p.click(() => {
        const it = spare.get(id); if (it) { doc.items.set(id, it); spare.delete(id); }
        if (last) { a.pull = null; const v = r.via ? spare.get(r.via) : null; if (v) { doc.items.set(v.id, v); spare.delete(v.id); } gone.delete(ri); } else a.pull = out(i);
        redraw();
      });
      if (!last && chance(0.3)) p.wait(rnd(0.15, 0.5));       // looks where it goes next
    }
    p.rest(rnd(0.3, 0.9));
    return true;
  }
  /** Selects a finished connection, deletes it, thinks, and routes it again. */
  function planRedo(a: Actor, p: Plan, ri: number): boolean {
    const r = meta.routes[ri], pts = r.pts as Pt[], ids = [...r.ids, ...(r.via ? [r.via] : [])];
    let k = 0; for (let i = 1; i < pts.length - 1; i++) if (dist(pts[i], pts[i + 1]) > dist(pts[k], pts[k + 1])) k = i;
    const u = rnd(0.3, 0.7);
    a.route = ri;
    p.go([lerp(pts[k][0], pts[k + 1][0], u), lerp(pts[k][1], pts[k + 1][1], u)]).click(() => { a.marks = ids; });
    p.wait(rnd(0.4, 1), () => { a.marks = []; lift(ri); redraw(); });
    p.rest(rnd(0.5, 1.5));
    return planRoute(a, p, ri);
  }
  /** Tries a part or a label a little to one side, looks, and puts it back. */
  function planNudge(a: Actor, p: Plan, id: string): boolean {
    const it = doc.items.get(id); if (!it) return false;
    const home = posOf(it), ang = rnd(0, Math.PI * 2), far = rnd(0.75, 2);
    const to: Pt = [snap(home[0] + Math.cos(ang) * far, home[0]), snap(home[1] + Math.sin(ang) * far, home[1])];
    a.move = { id, from: home };
    p.go(home).click(() => { a.held = id; });
    p.pull(to, rnd(2.5, 4), (c) => carry(it, c, home), 0.5, 1.4);
    p.rest(rnd(0.5, 1.4));
    if (chance(0.55)) p.pull(home, rnd(3, 5), (c) => carry(it, c, home), 0.4, 1.2);
    p.wait(0.06, () => { K.moveItem(doc, it, home[0], home[1], 1e6); redraw(); });
    p.wait(rnd(0.2, 0.5), () => { a.held = null; a.move = null; });
    return true;
  }
  /** Takes a part out of the pile and puts it in its place, sometimes a little off first. */
  function planPlace(a: Actor, p: Plan, id: string): boolean {
    const it = doc.items.get(id), q = meta.parts.find((x) => x.id === id); if (!it || !q) return false;
    const home: Pt = [q.x, q.y], tick = (c: Pt): void => carry(it, c, home);
    a.move = { id, from: home };
    p.go(posOf(it)).click(() => { a.held = id; });
    if (chance(0.35 * HANDS[a.who].miss)) {
      p.pull([home[0] + gauss() * 1.6, home[1] + gauss() * 1.2], rnd(26, 36), tick, 0.6, 1.7).rest(rnd(0.2, 0.6));
      p.pull(home, 3, tick, 0.25, 0.6);
    } else p.pull(home, rnd(26, 36), tick, 0.6, 1.7);
    p.click(() => { K.moveItem(doc, it, home[0], home[1], 1e6); unplaced.delete(id); a.held = null; a.move = null; redraw(); });
    p.rest(rnd(0.1, 0.5));
    return true;
  }
  /** Adds one of the silkscreen texts: it appears on the pointer and is set down where it goes. */
  function planLabel(a: Actor, p: Plan, id: string): boolean {
    const it = shelf.get(id); if (!it) return false;
    const home = posOf(it), from: Pt = [home[0] + rnd(-7, 7), home[1] + rnd(3, 6) * (home[1] > BOARD.y + BOARD.h / 2 ? -1 : 1)];
    p.go(from).wait(rnd(0.3, 0.7), () => { shelf.delete(id); doc.items.set(id, it); carry(it, from, home); a.held = id; a.move = { id, from: home }; redraw(); });
    p.pull(home, rnd(7, 10), (c) => carry(it, c, home), 0.5, 1.4);
    p.click(() => { K.moveItem(doc, it, home[0], home[1], 1e6); a.held = null; a.move = null; redraw(); });
    p.rest(rnd(0.2, 0.6));
    return true;
  }
  /** Draws the ground plane: a click in each corner of the board on the back layer, and the
   *  zone fills when its outline closes. */
  function planPour(a: Actor, p: Plan): boolean {
    const z = shelf.get(meta.zone); if (!z) return false;
    const B = BOARD, c: Pt[] = [[B.x, B.y], [B.x + B.w, B.y], [B.x + B.w, B.y + B.h], [B.x, B.y + B.h]];
    const k = Math.floor(rnd(0, 4)), ring = chance(0.5) ? [0, 1, 2, 3, 4] : [0, 3, 2, 1, 4], at = (i: number): Pt => c[(k + ring[i]) % 4];
    p.go(at(0)).rest(rnd(0.3, 0.8)).go(at(0)).click(() => { a.poly = [at(0)]; a.pull = { a: at(0), b: at(1), at: at(0), layer: "B.Cu", w: 0.2 }; });
    for (let i = 1; i <= 4; i++) {
      const s = at(i - 1), t = at(i);
      p.pull(t, rnd(16, 24), (q) => { if (a.pull) a.pull.at = along(s, t, q); }, 0.5, 1.6);
      p.click(() => {
        if (i < 4) { a.poly!.push(t); a.pull = { a: t, b: at(i + 1), at: t, layer: "B.Cu", w: 0.2 }; return; }
        a.poly = null; a.pull = null; shelf.delete(z.id); doc.items.set(z.id, z); poured = true; redraw();
      });
      if (i < 4 && chance(0.3)) p.wait(rnd(0.15, 0.4));
    }
    p.rest(rnd(0.8, 1.6));
    return true;
  }
  /** Goes to a part and looks it over, selected or just under the pointer. */
  function planLook(a: Actor, p: Plan, id: string): boolean {
    const it = doc.items.get(id); if (!it) return false;
    const at = posOf(it);
    p.go([at[0] + gauss() * 0.5, at[1] + gauss() * 0.4]);
    if (chance(0.65)) p.click(() => { a.held = id; });
    p.rest(rnd(1.1, 3.2));
    return true;
  }
  /** Drags a selection box over a part and its neighbours, then lets the selection go. */
  function planSweep(a: Actor, p: Plan, id: string): boolean {
    const me = doc.items.get(id); if (!me || !me.bbox) return false;
    const near = meta.parts.map((q) => doc.items.get(q.id)).filter((it) => it && it.bbox && it.id !== id && dist(posOf(it), posOf(me)) < 8.5) as any[];
    const b = me.bbox.slice() as Box, m = rnd(0.6, 1.5);
    for (const it of near.slice(0, chance(0.5) ? 1 : 2)) { b[0] = Math.min(b[0], it.bbox[0]); b[1] = Math.min(b[1], it.bbox[1]); b[2] = Math.max(b[2], it.bbox[2]); b[3] = Math.max(b[3], it.bbox[3]); }
    const left = chance(0.6), top = chance(0.7);
    const c0: Pt = [left ? b[0] - m : b[2] + m, top ? b[1] - m : b[3] + m], c1: Pt = [left ? b[2] + m : b[0] - m, top ? b[3] + m : b[1] - m];
    const inside = (c: Pt): string[] => {
      const x0 = Math.min(c0[0], c[0]), x1 = Math.max(c0[0], c[0]), y0 = Math.min(c0[1], c[1]), y1 = Math.max(c0[1], c[1]);
      return meta.parts.filter((q) => { const it = doc.items.get(q.id), bb = it && it.bbox; return bb && bb[0] >= x0 && bb[2] <= x1 && bb[1] >= y0 && bb[3] <= y1; }).map((q) => q.id);
    };
    p.go(c0).click(() => { a.box = [c0, c0]; });
    p.pull(c1, rnd(9, 14), (c) => { if (a.box) { a.box = [c0, c]; a.boxed = inside(c); } }, 0.45, 1.3);
    p.click(() => { a.box = null; });
    p.rest(rnd(0.8, 2.2));
    p.go([c1[0] + rnd(1, 3) * (left ? 1 : -1), c1[1] + gauss() * 2]).click(() => { a.boxed = []; });
    return true;
  }
  /** Pins a comment on a part and types it. */
  function planNote(a: Actor, p: Plan, ref: string, text: string): boolean {
    const it = doc.items.get(refId(ref) || ""); if (!it) return false;
    const c = posOf(it), at: Pt = [c[0] + gauss() * 0.3, c[1] + gauss() * 0.3];
    const n: Note = { who: a.who, at, text, n: 0, born: 0, dies: Infinity };
    p.go(at).click(() => { n.born = performance.now(); note = n; });
    p.wait(rnd(0.4, 0.9));                                    // hands go to the keyboard
    for (let i = 0; i < text.length; i++) p.wait((/[ ,?]/.test(text[i]) ? rnd(0.09, 0.22) : rnd(0.035, 0.1)) * (chance(0.06) ? 4 : 1), () => { n.n = i + 1; });
    p.wait(rnd(2, 3.2), () => { n.dies = performance.now() + 350; });
    return true;
  }

  /** What a teammate turns to next: open connections first, otherwise whatever a person
   *  reviewing a board might do, picked by weighted chance and rarely the same thing twice. */
  function think(a: Actor, now: number): void {
    const others = actors.filter((o) => o !== a), doing = (t: Task): boolean => others.some((o) => o.task === t);
    const building = unplaced.size > 0 || !poured;
    const quiet = !edits.length && !drag && !route && !pan && now - lastAct > 1200 && others.filter((o) => HARD.has(o.task)).length < (building ? 3 : 2);
    const open = [...gone].filter((i) => !others.some((o) => o.route === i) && NEEDS[i].every((k) => !gone.has(k)) && reaches[i].every((id) => !unplaced.has(id)));
    const whole = REDO.filter((i) => !gone.has(i) && meta.routes[i].ids.every((id) => doc.items.has(id)));
    const taken = new Set<string>(); for (const o of others) { if (o.held) taken.add(o.held); if (o.move) taken.add(o.move.id); for (const id of o.boxed) taken.add(id); }
    const pile = meta.parts.filter((q) => unplaced.has(q.id) && !taken.has(q.id) && !(drag && drag.id === q.id)).slice(0, 3);
    const texts = [...shelf.values()].filter((it) => it.kind === "gr_text").map((it) => it.id);
    const parts = meta.parts.filter((q) => !taken.has(q.id) && !unplaced.has(q.id)), small = parts.filter((q) => /^[RCD]/.test(q.ref));
    const labels = [...doc.items.values()].filter((it) => it.kind === "gr_text").map((it) => it.id);
    const opts: [Task, number][] = [["look", building ? 0.5 : 2], ["rest", building ? 0.3 : 0.7]];
    if (quiet && pile.length) opts.push(["place", 10]);
    if (quiet && open.length) opts.push(["route", 9]);
    if (quiet && !unplaced.size && texts.length && !doing("label")) opts.push(["label", 3]);
    if (quiet && !unplaced.size && !gone.size && !poured && !doing("pour")) opts.push(["pour", 40]);
    if (quiet && !building && !open.length && gone.size < 2 && whole.length && !doing("redo") && now > nextRedo) opts.push(["redo", 3]);
    if (quiet && !building && !doing("nudge") && small.length) opts.push(["nudge", 0.8]);
    if (!doing("sweep") && parts.length) opts.push(["sweep", 0.9]);
    if (!note && now > nextNote) opts.push(["note", 1.1]);
    let sum = 0; for (const o of opts) { if (o[0] === a.last && o[0] !== "route" && o[0] !== "place") o[1] *= 0.2; sum += o[1]; }
    let pick = Math.random() * sum, task: Task = "look";
    for (const o of opts) { pick -= o[1]; if (pick <= 0) { task = o[0]; break; } }

    const p = plan(a.who, a.at); let ok = false;
    if (!HARD.has(a.last) || chance(0.5)) p.rest(rnd(0.15, 0.8));
    if (task === "place") ok = planPlace(a, p, any1(pile).id);
    else if (task === "label") ok = planLabel(a, p, any1(texts));
    else if (task === "pour") ok = planPour(a, p);
    else if (task === "route") ok = planRoute(a, p, any1(open));
    else if (task === "redo") { ok = planRedo(a, p, any1(whole)); nextRedo = now + rnd(5000, 11000); }
    else if (task === "nudge") ok = planNudge(a, p, chance(0.25) && labels.length ? any1(labels) : any1(small).id);
    else if (task === "sweep") ok = planSweep(a, p, any1(parts).id);
    else if (task === "note") { const free = NOTES.filter(([ref]) => !taken.has(refId(ref) || "") && !unplaced.has(refId(ref) || "")); ok = free.length > 0 && (() => { const n = any1(free); return planNote(a, p, n[0], n[1]); })(); nextNote = now + rnd(9000, 16000); }
    else if (task === "look" && parts.length) ok = planLook(a, p, any1(parts).id);
    if (!ok) { task = "rest"; p.go(inset(4)).rest(rnd(1, 3)); }
    a.task = task; a.steps = p.steps; a.i = 0; a.t0 = now; a.from = a.at;
  }
  /** One of those not in the middle of board work comes over to take back the visitor's change. */
  function sendUndo(now: number): void {
    const free = actors.filter((a) => !HARD.has(a.task)); if (!free.length) return;
    const a = any1(free);
    while (edits.length) {
      const e = edits.pop()!; drop(a, now);
      const p = plan(a.who, a.at);
      if (planUndo(a, p, e)) { a.task = "undo"; a.steps = p.steps; return; }
    }
    drop(a, now); sync();
  }
  /** The visitor took hold of what a teammate was carrying: the teammate lets go, and the
   *  item still has to get home some time. */
  function yieldTo(id: string): void {
    const a = actors.find((o) => o.move && o.move.id === id); if (!a || !a.move) return;
    if (!unplaced.has(id) && !edits.some((e) => e.kind === "move" && e.id === id)) edits.push({ kind: "move", id, from: a.move.from });
    drop(a, performance.now());
  }
  cast(performance.now());

  // "Keep going in a real project": the board as it stands is left for the app (web/onboarding/state.ts
  // reads it under this key), which makes a project of it with its schematic and opens it.  Signed
  // out, sign-in comes first and returns to the same place.
  const keep = document.querySelector<HTMLAnchorElement>("[data-keep]");   // under the window, beside the caption
  if (keep) {
    const next = "/?start=mini";
    keep.href = document.documentElement.dataset.me ? next : "/auth/github/login?next=" + encodeURIComponent(next);
    keep.addEventListener("click", () => {
      endRoute();
      try { localStorage.setItem("kc.onboard.mini", JSON.stringify({ board: boardText(doc), at: Date.now() })); } catch { /* without it the project starts from the same board, some connections open */ }
    });
  }

  /** KiCad's two-leg track: straight along the longer axis, then 45 degrees into the target. */
  function legs(a: Pt, b: Pt): Pt[] {
    const dx = b[0] - a[0], dy = b[1] - a[1], ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < 1e-3 || ay < 1e-3 || Math.abs(ax - ay) < 1e-3) return [a, b];
    const d = Math.min(ax, ay);
    const mid: Pt = ax > ay ? [b[0] - Math.sign(dx) * d, a[1]] : [a[0], b[1] - Math.sign(dy) * d];
    return [a, mid, b];
  }
  /** The same two legs the other way round: 45 degrees first, then straight. */
  function legsAlt(a: Pt, b: Pt): Pt[] {
    const p = legs(b, a); return p.length === 3 ? [a, p[1], b] : p;
  }
  /** How far along `pts` a track of `net` can be laid before it would come too close to
   *  another net's copper: the points of the part that may be placed. */
  function clear(pts: Pt[], net: number, on: Layer): { pts: Pt[]; whole: boolean; len: number } {
    const w = netWidth(net), out: Pt[] = [pts[0]]; let len = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], d = dist(a, b);
      if (!clash(doc, a, b, w, [on], net, CLEARANCE)) { out.push(b); len += d; continue; }
      let ok = 0;
      for (let s = 0.05; s < d; s += 0.05) { const p: Pt = [lerp(a[0], b[0], s / d), lerp(a[1], b[1], s / d)]; if (clash(doc, a, p, w, [on], net, CLEARANCE)) break; ok = s; }
      if (ok > 0) { out.push([lerp(a[0], b[0], ok / d), lerp(a[1], b[1], ok / d)]); len += ok; }
      return { pts: out, whole: false, len };
    }
    return { pts: out, whole: true, len };
  }
  /** The track from the last placed point towards `to`, as far as the net rule lets it go.
   *  A track belongs to the net it started on and never touches another one's copper. */
  function reach(from: Pt, to: Pt, net: number, on: Layer): { pts: Pt[]; whole: boolean } {
    const a = clear(legs(from, to), net, on); if (a.whole) return a;
    const b = clear(legsAlt(from, to), net, on);
    return b.whole || b.len > a.len + 1e-6 ? b : a;
  }
  const viaFits = (at: Pt, net: number): boolean => !clash(doc, at, at, VIA.size, null, net, CLEARANCE);
  /** Where a click lands while a tool is active: copper of the right net if there is some, else the grid. */
  function target(at: Pt, net: number | null): { at: Pt; net: number; onCopper: boolean } {
    const c = copperAt(doc, at[0], at[1], layer);
    if (c && (net === null || net === 0 || c.net === net)) return { at: [c.x, c.y], net: c.net, onCopper: true };
    return { at: [snap(at[0], BOARD.x), snap(at[1], BOARD.y)], net: net || 0, onCopper: false };
  }

  function setTool(t: Tool): void {
    if (route && t !== "route") endRoute();
    tool = t; if (t !== "select") selected = null;
    sync(); stage.invalidate();
  }
  function setLayer(l: Layer): void {
    if (l === layer) return;
    // Changing layer mid-track drops a via, as the router does.
    if (route && hover) {
      const made = route.made, t = target(hover, route.net), r = reach(route.from, t.at, route.net, route.layer), end = r.pts[r.pts.length - 1];
      if (!viaFits(end, route.net)) return;                // no room for the via here: stay on this layer
      for (let i = 1; i < r.pts.length; i++) made.push(addSegment(r.pts[i - 1], r.pts[i], route.net, route.layer));
      made.push(addVia(end, route.net)); route = { net: route.net, from: end, layer: l, made };
    }
    layer = l; dirty = true; sync(); stage.invalidate();
  }
  function endRoute(): void { if (route) { remember(route.made); route = null; change(); } }
  function reset(): void {
    doc = loadPcbOpen(); open(); edits.length = 0; cast(performance.now()); clearTimeout(stillTimer); route = null; drag = null; selected = null; box = fitTo.slice() as Box; tool = "select"; layer = "F.Cu";
    dirty = true; touched = false; nextUndo = performance.now() + 1800; sync(); stage.invalidate();
  }
  function zoom(k: number, about?: Pt): void {
    const cx = about ? about[0] : (box[0] + box[2]) / 2, cy = about ? about[1] : (box[1] + box[3]) / 2;
    const w = clamp((box[2] - box[0]) * k, (HOME[2] - HOME[0]) / 6, (HOME[2] - HOME[0]) * 1.5), r = w / (box[2] - box[0]);
    box = [cx - (cx - box[0]) * r, cy - (cy - box[1]) * r, cx + (box[2] - cx) * r, cy + (box[3] - cy) * r];
    own = true; glide = null; dirty = true; stage.invalidate();
  }
  function removeSelected(): void {
    if (!selected) return;
    const it = doc.items.get(selected); if (!it || (it.kind !== "segment" && it.kind !== "via")) return;
    doc.items.delete(it.id);
    // Taking out a piece the visitor laid themselves is not a change of its own: it just shortens that one.
    const own = edits.find((e) => e.kind === "add" && e.ids.includes(it.id));
    if (own && own.kind === "add") { own.ids.splice(own.ids.indexOf(it.id), 1); if (!own.ids.length) edits.splice(edits.indexOf(own), 1); }
    else edits.push({ kind: "del", item: it });
    selected = null; change();
  }

  /** Status bar, toolbar states. */
  function sync(): void {
    root.dataset.tool = tool; root.dataset.layer = layer;
    root.querySelectorAll<HTMLElement>("[data-tool-btn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.toolBtn === tool)));
    root.querySelectorAll<HTMLElement>("[data-layer-btn]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.layerBtn === layer)));
    const u = q<HTMLButtonElement>("[data-act=undo]"); if (u) u.disabled = !edits.length && !route;
    const r = q<HTMLButtonElement>("[data-act=reset]"); if (r) r.disabled = !touched;
    if (toolName) toolName.textContent = tool === "route" ? (route ? (foreign(hover) !== null ? `Route Tracks: ${netName(route.net)} cannot connect to ${netName(foreign(hover)!)}` : `Route Tracks: ${netName(route.net)}, click to place, double-click to finish`) : "Route Tracks: click a pad or a track to start") : tool === "via" ? "Add Via" : "Select item(s)";
    if (dirty) rats = ratsnest(doc, { poured: poured ? 1 : 0 });
    if (counts) {
      let vias = 0, segs = 0; for (const it of doc.items.values()) { if (it.kind === "via") vias++; else if (it.kind === "segment") segs++; }
      counts.textContent = `Pads 42   Vias ${vias}   Track Segments ${segs}   Nets 9`;
      if (unrouted) { unrouted.textContent = `Unrouted ${rats.length}`; unrouted.classList.toggle("ok", rats.length === 0); }
    }
  }

  const stage: Stage = makeStage(canvas, (s, now) => {
    if (!t0) { t0 = now; nextUndo = now + 1800; }
    const { ctx, w: W, h: H, dpr } = s;
    // Once the pile is empty the view closes in on the board, unless the visitor has set their own.
    if (!unplaced.size && fitTo !== HOME) { fitTo = HOME; if (!own) glide = { from: box.slice() as Box, t0: now }; }
    if (glide) { const k = minJerk((now - glide.t0) / 1400); box = mixBox(glide.from, HOME, k); dirty = true; if (k >= 1) glide = null; }
    view = fit(W, H, dpr, box);
    if (!base) base = document.createElement("canvas");
    if (base.width !== canvas.width || base.height !== canvas.height) { base.width = canvas.width; base.height = canvas.height; dirty = true; }
    if (dirty) {
      rats = ratsnest(doc, { poured: poured ? 1 : 0 });
      K.render(doc, base.getContext("2d")!, view, { hidden: HIDDEN, grid: 1, ratsnest: rats, selected: selected ? new Set([selected]) : null, zoneFill: true, activeLayer: layer });
      dirty = false;
      if (zoomOut) zoomOut.textContent = `Z ${(view.ppm / 3.78).toFixed(2)}`;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const px = (p: Pt): Pt => toPx(view!, p[0], p[1]);

    // The track being routed and the via that a layer change would drop.
    if (route && hover) {
      const t = target(hover, route.net), pts = reach(route.from, t.at, route.net, route.layer).pts.map(px);
      ctx.strokeStyle = LAYER_COLOR[route.layer]; ctx.globalAlpha = 0.85; ctx.lineWidth = Math.max(1.5, netWidth(route.net) * view.ppm); ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (tool === "via" && hover) {
      const t = target(hover, null), c = px(t.at);
      ctx.globalAlpha = viaFits(t.at, t.net) ? 0.8 : 0.22; ctx.fillStyle = "#ECECEC"; ctx.beginPath(); ctx.arc(c[0], c[1], VIA.size / 2 * view.ppm, 0, 6.3); ctx.fill();
      ctx.fillStyle = "#001023"; ctx.beginPath(); ctx.arc(c[0], c[1], VIA.drill / 2 * view.ppm, 0, 6.3); ctx.fill(); ctx.globalAlpha = 1;
    }
    if (tool !== "select" && hover) {
      // The snapped point, as the editor's crosshair shows it.
      const t = target(hover, route ? route.net : null), c = px(t.at);
      ctx.strokeStyle = "#FFFFFFB0"; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(Math.round(c[0]) + 0.5, c[1] - 9); ctx.lineTo(Math.round(c[0]) + 0.5, c[1] + 9); ctx.moveTo(c[0] - 9, Math.round(c[1]) + 0.5); ctx.lineTo(c[0] + 9, Math.round(c[1]) + 0.5); ctx.stroke();
      if (t.onCopper) { ctx.beginPath(); ctx.arc(c[0], c[1], 6, 0, 6.3); ctx.stroke(); }
    }

    // The scripted collaborators: a pointer each, and what each of them holds, pulls or selects.
    if (!still) {
      if (edits.length && !drag && !route && !pan && now - lastAct > IDLE && now > nextUndo && !actors.some((a) => a.task === "undo")) sendUndo(now);
      for (const a of actors) run(a, now);
    }
    const frame = (id: string, color: string): void => {
      const it = doc.items.get(id), g = it && (it.geom as any[])[0]; if (!it) return;
      ctx.strokeStyle = color; ctx.lineCap = "round";
      if ((it.kind === "segment" || it.kind === "via") && g) {
        const s = it.kind === "via" ? px([g.x, g.y]) : px([g.x1, g.y1]), t = it.kind === "via" ? s : px([g.x2, g.y2]);
        ctx.globalAlpha = 0.75; ctx.lineWidth = (it.kind === "via" ? g.r * 2 : g.w) * view!.ppm + 4; ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(t[0], t[1] + 0.01); ctx.stroke(); ctx.globalAlpha = 1;
      } else if (it.bbox) { const p0 = px([it.bbox[0], it.bbox[1]]), p1 = px([it.bbox[2], it.bbox[3]]); ctx.lineWidth = 1.5; ctx.strokeRect(p0[0] - 3, p0[1] - 3, p1[0] - p0[0] + 6, p1[1] - p0[1] + 6); }
    };
    for (const a of actors) {
      const color = PEERS[a.who].color;
      for (const id of a.marks) frame(id, color);
      for (const id of a.boxed) frame(id, color);
      if (a.held) frame(a.held, color);
      if (a.poly) {
        // The zone outline drawn so far.
        ctx.strokeStyle = LAYER_COLOR["B.Cu"]; ctx.globalAlpha = 0.85; ctx.lineWidth = Math.max(1.5, 0.2 * view.ppm); ctx.lineJoin = "round";
        ctx.beginPath(); a.poly.forEach((q, i) => { const c = px(q); if (i) ctx.lineTo(c[0], c[1]); else ctx.moveTo(c[0], c[1]); }); ctx.stroke(); ctx.globalAlpha = 1;
      }
      if (a.pull) {
        const s = px(a.pull.a), t = px(a.pull.at);
        ctx.strokeStyle = LAYER_COLOR[a.pull.layer] || LAYER_COLOR["F.Cu"]; ctx.globalAlpha = 0.85; ctx.lineWidth = Math.max(1.5, a.pull.w * view.ppm); ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(t[0], t[1]); ctx.stroke(); ctx.globalAlpha = 1;
      }
      if (a.box) {
        const s = px(a.box[0]), t = px(a.box[1]);
        ctx.fillStyle = color; ctx.globalAlpha = 0.12; ctx.fillRect(s[0], s[1], t[0] - s[0], t[1] - s[1]);
        ctx.globalAlpha = 1; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(Math.round(s[0]) + 0.5, Math.round(s[1]) + 0.5, Math.round(t[0] - s[0]), Math.round(t[1] - s[1]));
      }
    }
    if (note && now >= note.dies) note = null;
    if (note) {
      // A comment pinned to a part, typed as its author writes it.
      const peer = PEERS[note.who], c = px(note.at), typing = note.n < note.text.length;
      const text = note.text.slice(0, note.n) + (typing && Math.floor(now / 400) % 2 ? "|" : "");
      ctx.save(); ctx.globalAlpha = clamp(Math.min((now - note.born) / 160, (note.dies - now) / 350));
      ctx.font = `12px ${SANS}`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
      const w = Math.max(30, ctx.measureText(note.text.slice(0, note.n) + "|").width) + 42, hgt = 28;
      const x = Math.round(c[0] + 12 + w > W - 6 ? c[0] - 12 - w : c[0] + 12), y = Math.round(Math.max(6, c[1] - hgt - 8));
      ctx.beginPath(); ctx.arc(c[0], c[1], 5, 0, 6.3); ctx.fillStyle = peer.color; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.4; ctx.stroke(); ctx.fill();
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x + 0.5, y + 0.5, w, hgt, 8); else ctx.rect(x + 0.5, y + 0.5, w, hgt);
      ctx.fillStyle = "#111113"; ctx.fill(); ctx.strokeStyle = "#FFFFFF3D"; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath(); ctx.arc(x + 15, y + hgt / 2 + 0.5, 8, 0, 6.3); ctx.fillStyle = peer.color; ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = `600 10px ${SANS}`; ctx.textAlign = "center"; ctx.fillText(peer.name[0], x + 15, y + hgt / 2 + 1);
      ctx.fillStyle = "#FAFAFA"; ctx.font = `12px ${SANS}`; ctx.textAlign = "left"; ctx.fillText(text, x + 30, y + hgt / 2 + 1);
      ctx.restore();
    }
    for (const a of actors) { const c = px(a.at); drawCursor(ctx, c[0], c[1], PEERS[a.who].name, PEERS[a.who].color, SANS); }
    return !still;
  });

  // ------------------------------------------------------------------ input

  function where(e: { clientX: number; clientY: number }): Pt | null {
    if (!view) return null;
    const r = canvas.getBoundingClientRect();
    return toMm(view, e.clientX - r.left, e.clientY - r.top);
  }
  canvas.addEventListener("pointerdown", (e) => {
    const at = where(e); if (!at || e.button !== 0) return;
    canvas.focus({ preventScroll: true }); hover = at; lastAct = performance.now();
    if (tool === "select") {
      const hit = pick(at);
      if (movable(hit)) {
        const it = doc.items.get(hit!)!; selected = hit; yieldTo(hit!);
        drag = { id: hit!, from: posOf(it), grab: at, moved: false };
        canvas.setPointerCapture(e.pointerId);
      } else {
        selected = trackAt(doc, at[0], at[1], 0.25);
        if (!selected) { pan = { at: [e.clientX, e.clientY], box: box.slice() as Box }; own = true; glide = null; canvas.setPointerCapture(e.pointerId); }
      }
      dirty = true; stage.invalidate();
    } else if (tool === "via") {
      const t = target(at, null);
      if (viaFits(t.at, t.net)) { remember([addVia(t.at, t.net)]); change(); }
    } else if (!route) {
      // A track takes its net from the copper it starts on, so it has to start on some.
      const t = target(at, null);
      if (t.onCopper) { route = { net: t.net, from: t.at, layer, made: [] }; sync(); stage.invalidate(); }
    } else {
      if (foreign(at) !== null) return;                     // another net's copper: the track may not land on it
      const t = target(at, route.net);
      if (dist(route.from, t.at) < 1e-6) { endRoute(); return; }
      const r = reach(route.from, t.at, route.net, route.layer);
      for (let i = 1; i < r.pts.length; i++) route.made.push(addSegment(r.pts[i - 1], r.pts[i], route.net, route.layer));
      route.from = r.pts[r.pts.length - 1];
      if (t.onCopper && r.whole) endRoute(); else change();
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const at = where(e); if (!at) return;
    hover = at;
    if (xy) xy.textContent = `X ${(at[0] - BOARD.x).toFixed(2)}  Y ${(at[1] - BOARD.y).toFixed(2)}`;
    if (drag) {
      const dx = Math.round((at[0] - drag.grab[0]) / GRID) * GRID, dy = Math.round((at[1] - drag.grab[1]) / GRID) * GRID;
      const it = doc.items.get(drag.id)!, x = drag.from[0] + dx, y = drag.from[1] + dy;
      const p = posOf(it); lastAct = performance.now();
      if (p[0] !== x || p[1] !== y) { K.moveItem(doc, it, x, y, 1e6); drag.moved = true; dirty = true; }
    } else if (pan && view) {
      const dx = (e.clientX - pan.at[0]) / view.ppm, dy = (e.clientY - pan.at[1]) / view.ppm;
      box = [pan.box[0] - dx, pan.box[1] - dy, pan.box[2] - dx, pan.box[3] - dy]; dirty = true;
    } else if (route) {
      const f = foreign(at); if (f !== blocked) { blocked = f; sync(); }
    } else if (tool === "select") {
      canvas.style.cursor = movable(pick(at)) ? "move" : "";
    }
    stage.invalidate();
  });
  const release = () => {
    if (drag && drag.moved) {
      // One entry per item, holding where it first was, so it goes all the way home in one carry.
      // A part still waiting in the pile has no place to go back to: a teammate places it from wherever it was left.
      const d = drag; if (!unplaced.has(d.id) && !edits.some((e) => e.kind === "move" && e.id === d.id)) edits.push({ kind: "move", id: d.id, from: d.from });
      change();
    }
    drag = null; pan = null;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", () => { if (!drag && !pan) { hover = null; if (xy) xy.textContent = "X --.--  Y --.--"; stage.invalidate(); } });
  canvas.addEventListener("dblclick", () => { if (route) endRoute(); });
  canvas.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;               // a plain wheel scrolls the page
    e.preventDefault(); const at = where(e); zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, at || undefined);
  }, { passive: false });
  canvas.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase(); lastAct = performance.now();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); act("undo"); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === "escape") { if (route) endRoute(); else if (tool !== "select") setTool("select"); else { selected = null; dirty = true; stage.invalidate(); } }
    else if (k === "x") setTool("route");
    else if (k === "v") { if (route) setLayer(layer === "F.Cu" ? "B.Cu" : "F.Cu"); else setTool("via"); }
    else if (k === "pageup") { e.preventDefault(); setLayer("F.Cu"); }
    else if (k === "pagedown") { e.preventDefault(); setLayer("B.Cu"); }
    else if (k === "delete" || k === "backspace") { e.preventDefault(); removeSelected(); }
    else if (k === "+" || k === "=") zoom(1 / 1.25);
    else if (k === "-") zoom(1.25);
    else if (k === "home") { e.preventDefault(); box = fitTo.slice() as Box; own = false; glide = null; dirty = true; stage.invalidate(); }
  });

  function act(name: string): void {
    if (name === "undo") {
      if (route) { for (const id of route.made) doc.items.delete(id); route = null; change(); }
      else { const u = edits.pop(); if (u) { revert(u); selected = null; change(); } }
    } else if (name === "zoom-in") zoom(1 / 1.25);
    else if (name === "zoom-out") zoom(1.25);
    else if (name === "zoom-fit") { box = fitTo.slice() as Box; own = false; glide = null; dirty = true; stage.invalidate(); }
    else if (name === "reset") reset();
  }
  root.querySelectorAll<HTMLElement>("[data-tool-btn]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.toolBtn as Tool)));
  root.querySelectorAll<HTMLElement>("[data-layer-btn]").forEach((b) => b.addEventListener("click", () => setLayer(b.dataset.layerBtn as Layer)));
  root.querySelectorAll<HTMLElement>("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act!)));
  // the page spells hotkeys as KiCad's tables do ("Undo (Ctrl+Z)"): a Mac reads them with its own names ("Cmd+Z")
  root.querySelectorAll<HTMLElement>("[title]").forEach((b) => { b.title = keysInText(b.title); });
  sync();
}
