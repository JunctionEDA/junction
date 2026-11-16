// The hero's schematic tab: the same three teammates draw the STM32 board's schematic, a block
// each at a time, before the window turns to the board (mini.ts).  Shown whole when the visitor
// opens the tab themselves, and theirs to try: parts and labels drag with their wires attached, the
// empty sheet pans, Ctrl+wheel zooms.  What they moved is put back when the schematic is drawn again.

import { Box, K, PEERS, Pt, View, clamp, drawCursor, fit, lerp, toMm, toPx } from "./demo";
import { SANS, Stage, makeStage, reducedMotion } from "./stage";
import { schText } from "./hero";

/** One thing a teammate does: the pointer travels to `at`, then `ids` are on the sheet. */
interface Beat { t: number; at: Pt; ids: string[] }
const HOLD = 1500;                                   // ms the finished schematic is left up before the board takes over
const minJerk = (u: number): number => u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (10 - 15 * u + 6 * u * u);
const mid = (b: number[]): Pt => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const inside = (b: number[], r: number[]): boolean => { const c = mid(b); return c[0] >= r[0] && c[0] <= r[2] && c[1] >= r[1] && c[1] <= r[3]; };

export interface SchScene { /** Draw it again from an empty sheet. */ play(): void; /** Show it complete. */ whole(): void; symbols: number }

export function startSch(canvas: HTMLCanvasElement, onEnd: () => void): SchScene {
  const doc: KDoc = K.parseDoc(schText);
  const items = [...doc.items.values()].filter((it: any) => it.bbox) as any[];
  const real = (it: any): boolean => it.kind === "symbol" && !/^#/.test(it.ref || "");
  // Framed by what is drawn, not by the A3 page around it.
  const view: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const it of items) { view[0] = Math.min(view[0], it.bbox[0]); view[1] = Math.min(view[1], it.bbox[1]); view[2] = Math.max(view[2], it.bbox[2]); view[3] = Math.max(view[3], it.bbox[3]); }
  view[0] -= 8; view[1] -= 8; view[2] += 8; view[3] += 8;

  // Each dashed block with what is inside it: its title, its parts, then the wiring around them.
  const blocks = items.filter((it) => it.kind === "rectangle").sort((a, b) => a.bbox[0] - b.bbox[0] || a.bbox[1] - b.bbox[1]);
  const taken = new Set<string>(blocks.map((b) => b.id));
  const lanes: Beat[][] = [[], [], []], load = [0, 0, 0], at: Pt[] = [mid(view), mid(view), mid(view)];
  const beat = (k: number, dur: number, to: Pt, ids: string[]): void => { load[k] += dur; lanes[k].push({ t: load[k], at: to, ids }); at[k] = to; };
  blocks.forEach((b, bi) => {
    const mine = items.filter((it) => !taken.has(it.id) && inside(it.bbox, b.bbox)); for (const it of mine) taken.add(it.id);
    const k = load.indexOf(Math.min(...load));
    const title = mine.filter((it) => it.kind === "text").sort((p, q) => p.bbox[1] - q.bbox[1]);
    beat(k, 620 + (bi ? Math.hypot(b.bbox[0] - at[k][0], b.bbox[1] - at[k][1]) * 2 : 0), [b.bbox[0] + 6, b.bbox[1] + 5], [b.id, ...title.slice(0, 1).map((t) => t.id)]);
    const parts = mine.filter(real).sort((p, q) => p.bbox[0] - q.bbox[0] || p.bbox[1] - q.bbox[1]);
    for (const p of parts) beat(k, 360 + Math.random() * 220, mid(p.bbox), [p.id]);
    // the wiring: a few items at a time, working outwards from each part in turn
    const rest = mine.filter((it) => !real(it) && it !== title[0]).sort((p, q) => p.bbox[0] - q.bbox[0] || p.bbox[1] - q.bbox[1]);
    for (let i = 0; i < rest.length; i += 4) { const g = rest.slice(i, i + 4); beat(k, 230 + Math.random() * 130, mid(g[g.length - 1].bbox), g.map((it) => it.id)); }
  });
  // what stands outside every block (the supply table) goes on last, by whoever is free first
  const loose = items.filter((it) => !taken.has(it.id));
  if (loose.length) { const k = load.indexOf(Math.min(...load)); beat(k, 700, mid(loose[0].bbox), loose.map((it) => it.id)); }
  const total = Math.max(...load);
  const all = new Set(items.map((it) => it.id));

  let t = Infinity, ended = true, focus = NaN;
  // ---- the visitor's hand
  const GRID = 1.27;
  let box: Box = view.slice() as Box, shown: Box = box, selected: string | null = null;
  interface Hold { it: any; from: Pt; grab: Pt; ends: { item: any; index: number; from: Pt }[]; rides: { it: any; from: Pt }[]; moved: boolean }
  let drag: Hold | null = null, pan: { at: Pt; box: Box } | null = null;
  const was = new Map<string, Pt>(), ran = new Map<string, Pt[]>();        // where each moved thing and each stretched wire first was
  const takes = (id: string | null): boolean => { const it: any = id ? doc.items.get(id) : null; return !!it && (it.kind === "symbol" || /label$/.test(it.kind)); };
  const posOf = (it: any): Pt => { const a = K.atOf(it.node); return [a[0], a[1]]; };
  function restore(): void {
    for (const [id, pts] of ran) { const it: any = doc.items.get(id); if (it) { K.setPts(it.node, pts); K.buildGeom(doc, it); } }
    for (const [id, p] of was) { const it: any = doc.items.get(id); if (it) K.moveItem(doc, it, p[0], p[1], 1e4); }
    ran.clear(); was.clear(); selected = null; drag = null; pan = null; box = view.slice() as Box;
  }
  const still = reducedMotion();
  const stage: Stage = makeStage(canvas, (s, _now, dt) => {
    const { ctx, w: W, h: H } = s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const playing = t <= total + HOLD;
    if (playing) t += dt;
    if (t >= total) { shown = box; K.render(doc, ctx, fit(W, H, s.dpr, box), { ids: all, grid: 1.27, selected: selected ? new Set([selected]) : null }); focus = NaN; }
    else {
      const ids = new Set<string>(), fresh = new Set<string>();
      for (const lane of lanes) for (const b of lane) { if (b.t > t) break; for (const id of b.ids) { ids.add(id); if (t - b.t < 260) fresh.add(id); } }
      const hands: Pt[] = lanes.map((lane, k) => {
        if (!lane.length) return mid(view);
        let i = lane.findIndex((b) => b.t > t); if (i < 0) i = lane.length - 1;
        const a = i ? lane[i - 1] : { t: 0, at: [view[0] + (view[2] - view[0]) * (0.25 + 0.25 * k), view[3] - 6] as Pt }, b = lane[i];
        // the hand is quick between places and slow on arriving: most of each beat is the click, not the travel
        const u = minJerk(clamp((t - a.t) / Math.max(1, (b.t - a.t) * 0.7)));
        return [lerp(a.at[0], b.at[0], u), lerp(a.at[1], b.at[1], u)];
      });
      // A narrow window cannot show the whole sheet at a readable size: it shows the sheet's full height and
      // drifts along it with the work.
      let box: Box = view;
      const bw = (view[3] - view[1]) * W / H;
      if (bw < (view[2] - view[0]) * 0.8) {
        const want = clamp((hands[0][0] + hands[1][0] + hands[2][0]) / 3, view[0] + bw / 2, view[2] - bw / 2);
        focus = isNaN(focus) ? want : focus + (want - focus) * Math.min(1, dt / 900);
        box = [focus - bw / 2, view[1], focus + bw / 2, view[3]];
      }
      shown = box;
      const v = fit(W, H, s.dpr, box);
      K.render(doc, ctx, v, { ids, grid: 1.27, selected: fresh.size ? fresh : null });
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      hands.forEach((h, k) => { if (lanes[k].length) { const p = toPx(v, h[0], h[1]); drawCursor(ctx, p[0], p[1], PEERS[k].name, PEERS[k].color, SANS); } });
    }
    if (playing && t > total + HOLD && !ended) { ended = true; onEnd(); }
    return playing;
  });

  const now = (): View => fit(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1, box);
  const where = (e: { clientX: number; clientY: number }): Pt => { const r = canvas.getBoundingClientRect(); return toMm(now(), e.clientX - r.left, e.clientY - r.top); };
  /** The visitor takes over: the drawing is finished at once, where it was being looked at, and stays up. */
  function hold(): void {
    if (t <= total + HOLD) { box = (t < total ? shown : view).slice() as Box; t = Infinity; ended = true; }
    canvas.dispatchEvent(new CustomEvent("hero:sch-held", { bubbles: true }));
  }
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    hold();
    const at = where(e), hit: string | null = K.hitTest(doc, at[0], at[1], 0.6);
    if (takes(hit)) {
      const it: any = doc.items.get(hit!);
      // As with KiCad's drag (G): the wire ends on the part's pins come along and the rest of each wire stays; a label
      // or a no-connect mark that sits right on a pin goes with the pin.
      const ends: Hold["ends"] = [], rides: Hold["rides"] = [];
      if (it.kind === "symbol") for (const p of K.pinPoints(doc, it) as any[]) {
        const q: Pt = Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y];
        for (const w of K.wireEndsAt(doc, q[0], q[1]) as any[]) ends.push({ item: w.item, index: w.index, from: q });
        for (const o of items) if (o !== it && (/label$/.test(o.kind) || o.kind === "no_connect")) { const a = posOf(o); if (Math.abs(a[0] - q[0]) < 0.01 && Math.abs(a[1] - q[1]) < 0.01) rides.push({ it: o, from: a }); }
      }
      selected = hit; drag = { it, from: posOf(it), grab: at, ends, rides, moved: false };
      canvas.setPointerCapture(e.pointerId);
    } else {
      selected = null; pan = { at: [e.clientX, e.clientY], box: box.slice() as Box };
      canvas.setPointerCapture(e.pointerId);
    }
    stage.invalidate();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag) {
      const at = where(e), dx = Math.round((at[0] - drag.grab[0]) / GRID) * GRID, dy = Math.round((at[1] - drag.grab[1]) / GRID) * GRID;
      const x = drag.from[0] + dx, y = drag.from[1] + dy, p = posOf(drag.it);
      if (Math.abs(p[0] - x) < 1e-6 && Math.abs(p[1] - y) < 1e-6) return;
      if (!was.has(drag.it.id)) was.set(drag.it.id, drag.from);
      K.moveItem(doc, drag.it, x, y, 1e4); drag.moved = true;
      for (const r of drag.rides) { if (!was.has(r.it.id)) was.set(r.it.id, r.from); K.moveItem(doc, r.it, r.from[0] + dx, r.from[1] + dy, 1e4); }
      for (const w of drag.ends) {
        const pts: Pt[] = (K.ptsOf(w.item.node) as Pt[]).map((q) => [q[0], q[1]] as Pt);
        if (!ran.has(w.item.id)) ran.set(w.item.id, pts.map((q) => [q[0], q[1]] as Pt));
        pts[w.index] = [w.from[0] + dx, w.from[1] + dy];
        K.setPts(w.item.node, pts); K.buildGeom(doc, w.item);
      }
      stage.invalidate();
    } else if (pan) {
      const v = fit(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1, pan.box), k = v.ppm * v.zoom;
      const dx = (e.clientX - pan.at[0]) / k, dy = (e.clientY - pan.at[1]) / k;
      box = [pan.box[0] - dx, pan.box[1] - dy, pan.box[2] - dx, pan.box[3] - dy]; stage.invalidate();
    } else if (t > total) {
      const at = where(e); canvas.style.cursor = takes(K.hitTest(doc, at[0], at[1], 0.6)) ? "move" : "";
    }
  });
  const release = (): void => { drag = null; pan = null; };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;               // a plain wheel scrolls the page
    e.preventDefault(); hold();
    const at = where(e), f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    if ((box[2] - box[0]) * f > (view[2] - view[0]) * 1.5 || (box[2] - box[0]) * f < 25) return;
    box = [at[0] + (box[0] - at[0]) * f, at[1] + (box[1] - at[1]) * f, at[0] + (box[2] - at[0]) * f, at[1] + (box[3] - at[1]) * f];
    stage.invalidate();
  }, { passive: false });

  return {
    symbols: items.filter(real).length,
    play() { restore(); if (still) { t = Infinity; ended = true; } else { t = 0; ended = false; } stage.invalidate(); },
    whole() { t = Infinity; ended = true; stage.invalidate(); },
  };
}

/** The hero window's two tabs.  It opens on the schematic being drawn, turns to the board when
 *  that is done, and comes back to the schematic each time the teammates start the board over. */
export function startTabs(root: HTMLElement, sch: SchScene, auto: boolean): void {
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-tab]"));
  const app = root.querySelector<HTMLElement>("[data-app]"), stat = root.querySelector<HTMLElement>("[data-sch-counts]");
  if (stat) stat.textContent = `Symbols ${sch.symbols}`;
  const cap = root.querySelector<HTMLElement>("[data-sch-cap]");
  const says = (drawing: boolean): void => { if (cap) cap.textContent = drawing ? "Mara, Jun and Ada are drawing the schematic. The board comes next." : "The schematic the board is made from. Drag a part to move it."; };
  function show(v: "sch" | "pcb"): void {
    root.dataset.view = v;
    for (const b of tabs) b.setAttribute("aria-selected", String(b.dataset.tab === v));
    if (app) app.textContent = v === "sch" ? "Schematic Editor" : "PCB Editor";
  }
  // Once the visitor has their hands on the schematic it stays theirs until they change tab.
  let held = false;
  for (const b of tabs) b.addEventListener("click", () => { const v = b.dataset.tab as "sch" | "pcb"; held = false; if (v === "sch") { sch.whole(); says(false); } show(v); });
  root.addEventListener("hero:sch-held", () => { held = true; if (cap) cap.textContent = "Yours to try: drag a part and its wires follow."; });
  root.addEventListener("hero:sch-done", () => { if (!held) show("pcb"); });
  if (auto) {
    root.addEventListener("hero:again", () => { if (held && root.dataset.view === "sch") return; show("sch"); says(true); sch.play(); });
    show("sch"); says(true); sch.play();
  } else { sch.whole(); says(false); show("pcb"); }
}
