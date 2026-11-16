// The hero's schematic tab: the same three teammates draw the STM32 board's schematic, a block
// each at a time, before the window turns to the board (mini.ts).  Shown whole when the visitor
// opens the tab themselves, and theirs to try: parts and labels drag with their wires attached, the
// finished sheet pans and Ctrl+wheel zooms.  The drawing carries on whatever they do, and a teammate comes
// over and puts back what they moved, as on the board.

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
  // ---- the visitor's hand.  Nothing they do stops the drawing: what they move, a teammate comes over and puts back.
  const GRID = 1.27;
  let box: Box = view.slice() as Box, shown: Box = box, vis: Set<string> = all;
  /** A part or label off its place by `d`: with the wire ends on its pins and what sits right on them. */
  interface Hold { it: any; from: Pt; c: Pt; d: Pt; grab: Pt; ends: { item: any; index: number; from: Pt }[]; rides: { it: any; from: Pt }[] }
  let drag: Hold | null = null, pan: { at: Pt; box: Box } | null = null, lastAct = 0;
  const edits: Hold[] = [];
  /** A teammate undoing one: the reach to it, the grip, the carry home. */
  let fix: { e: Hold; k: number; t0: number; start: Pt; d0: Pt; reach: number } | null = null;
  let gone: { k: number; at: Pt; t0: number } | null = null, handsNow: Pt[] | null = null;
  const GRIP = 220, CARRY = 520, BACK = 350;
  const takes = (id: string | null): boolean => { const it: any = id ? doc.items.get(id) : null; return !!it && (it.kind === "symbol" || /label$/.test(it.kind)); };
  const posOf = (it: any): Pt => { const a = K.atOf(it.node); return [a[0], a[1]]; };
  function shift(h: Hold, dx: number, dy: number): void {
    h.d = [dx, dy];
    K.moveItem(doc, h.it, h.from[0] + dx, h.from[1] + dy, 1e4);
    for (const r of h.rides) K.moveItem(doc, r.it, r.from[0] + dx, r.from[1] + dy, 1e4);
    for (const w of h.ends) {
      const pts: Pt[] = (K.ptsOf(w.item.node) as Pt[]).map((q) => [q[0], q[1]] as Pt);
      pts[w.index] = [w.from[0] + dx, w.from[1] + dy];
      K.setPts(w.item.node, pts); K.buildGeom(doc, w.item);
    }
  }
  function restore(): void {
    if (drag && !edits.includes(drag)) edits.push(drag);
    for (const e of edits) shift(e, 0, 0);
    edits.length = 0; drag = null; pan = null; fix = null; gone = null; box = view.slice() as Box;
  }
  const still = reducedMotion();
  const stage: Stage = makeStage(canvas, (s, _now, dt) => {
    const { ctx, w: W, h: H } = s, now = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const playing = t <= total + HOLD;
    if (playing) t += dt;
    const drawing = t < total;
    const hands: Pt[] | null = !drawing ? null : lanes.map((lane, k) => {
      if (!lane.length) return mid(view);
      let i = lane.findIndex((b) => b.t > t); if (i < 0) i = lane.length - 1;
      const a = i ? lane[i - 1] : { t: 0, at: [view[0] + (view[2] - view[0]) * (0.25 + 0.25 * k), view[3] - 6] as Pt }, b = lane[i];
      // the hand is quick between places and slow on arriving: most of each beat is the click, not the travel
      const u = minJerk(clamp((t - a.t) / Math.max(1, (b.t - a.t) * 0.7)));
      return [lerp(a.at[0], b.at[0], u), lerp(a.at[1], b.at[1], u)];
    });
    // The window follows the drawing, not the teammate who has gone off to put something back.
    const lead: Pt[] | null = hands ? hands.map((h) => [h[0], h[1]] as Pt) : null;

    // ---- a teammate notices what the visitor moved, a moment after they let go
    if (!fix && !drag && edits.length && now - lastAct > 900) {
      const e = edits[0], c: Pt = [e.c[0] + e.d[0], e.c[1] + e.d[1]];
      let k = Math.floor(Math.random() * 3), start: Pt = [clamp(c[0] + 35, view[0], view[2]), view[3] - 2];
      const from = hands || handsNow;
      if (from) { k = 0; for (let i = 1; i < 3; i++) if (Math.hypot(from[i][0] - c[0], from[i][1] - c[1]) < Math.hypot(from[k][0] - c[0], from[k][1] - c[1])) k = i; start = from[k]; }
      fix = { e, k, t0: now, start, d0: [e.d[0], e.d[1]], reach: clamp(420 + Math.hypot(start[0] - c[0], start[1] - c[1]) * 5, 520, 1100) };
    }
    let fixAt: Pt | null = null, held: string | null = drag ? drag.it.id : null;
    if (fix) {
      const u = now - fix.t0, e = fix.e, c0: Pt = [e.c[0] + fix.d0[0], e.c[1] + fix.d0[1]];
      if (u < fix.reach) { const m = minJerk(u / fix.reach); fixAt = [lerp(fix.start[0], c0[0], m), lerp(fix.start[1], c0[1], m)]; }
      else if (u < fix.reach + GRIP) { fixAt = c0; held = e.it.id; }
      else if (u < fix.reach + GRIP + CARRY) {
        const m = 1 - minJerk((u - fix.reach - GRIP) / CARRY);
        shift(e, fix.d0[0] * m, fix.d0[1] * m); fixAt = [e.c[0] + e.d[0], e.c[1] + e.d[1]]; held = e.it.id;
      } else { shift(e, 0, 0); edits.splice(edits.indexOf(e), 1); gone = { k: fix.k, at: [e.c[0], e.c[1]], t0: now }; fixAt = gone.at; fix = null; }
    }
    if (gone && now - gone.t0 > BACK) gone = null;
    const away = fix ? fix.k : gone ? gone.k : -1;

    let v: View;
    if (!drawing) {
      shown = box; vis = all; focus = NaN; handsNow = null;
      v = fit(W, H, s.dpr, box);
      K.render(doc, ctx, v, { ids: all, grid: 1.27, selected: held ? new Set([held]) : null });
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      // nobody else is on the sheet any more: the one who came over is seen coming and going
      if (fixAt && fix) { const p = toPx(v, fixAt[0], fixAt[1]); drawCursor(ctx, p[0], p[1], PEERS[away].name, PEERS[away].color, SANS, clamp((now - fix.t0) / 200)); }
      else if (gone) { const p = toPx(v, gone.at[0], gone.at[1]); drawCursor(ctx, p[0], p[1], PEERS[away].name, PEERS[away].color, SANS, 1 - clamp((now - gone.t0) / BACK)); }
    } else {
      const ids = new Set<string>(), fresh = new Set<string>();
      for (const lane of lanes) for (const b of lane) { if (b.t > t) break; for (const id of b.ids) { ids.add(id); if (t - b.t < 260) fresh.add(id); } }
      if (held) fresh.add(held);
      if (fixAt) hands![away] = fixAt;
      else if (gone) { const m = minJerk((now - gone.t0) / BACK); hands![away] = [lerp(gone.at[0], hands![away][0], m), lerp(gone.at[1], hands![away][1], m)]; }
      handsNow = hands; vis = ids;
      // A narrow window cannot show the whole sheet at a readable size: it shows the sheet's full height and
      // drifts along it with the work.
      let at: Box = view;
      const bw = (view[3] - view[1]) * W / H;
      if (bw < (view[2] - view[0]) * 0.8) {
        const want = clamp((lead![0][0] + lead![1][0] + lead![2][0]) / 3, view[0] + bw / 2, view[2] - bw / 2);
        focus = isNaN(focus) ? want : focus + (want - focus) * Math.min(1, dt / 900);
        at = [focus - bw / 2, view[1], focus + bw / 2, view[3]];
      }
      shown = at;
      v = fit(W, H, s.dpr, at);
      K.render(doc, ctx, v, { ids, grid: 1.27, selected: fresh.size ? fresh : null });
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      hands!.forEach((h, k) => { if (lanes[k].length) { const p = toPx(v, h[0], h[1]); drawCursor(ctx, p[0], p[1], PEERS[k].name, PEERS[k].color, SANS); } });
    }
    const busy = !!drag || !!fix || edits.length > 0;
    // The board does not take over in the middle of a carry.
    if (playing && t > total + HOLD && !ended) { if (busy) t = total + HOLD; else { ended = true; onEnd(); } }
    return playing || busy || !!gone;
  });

  const where = (e: { clientX: number; clientY: number }): Pt => {
    const r = canvas.getBoundingClientRect();
    return toMm(fit(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1, shown), e.clientX - r.left, e.clientY - r.top);
  };
  const under = (at: Pt): string | null => {
    const hit: string | null = K.hitTest(doc, at[0], at[1], 0.6);
    return takes(hit) && vis.has(hit!) && !edits.some((e) => e !== drag && e.rides.some((r) => r.it.id === hit)) ? hit : null;
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const at = where(e), hit = under(at); lastAct = performance.now();
    if (hit) {
      const it: any = doc.items.get(hit), had = edits.find((h) => h.it === it);
      if (had) { if (fix && fix.e === had) fix = null; had.grab = [at[0] - had.d[0], at[1] - had.d[1]]; drag = had; }      // taken out of the teammate's hand
      else {
        // As with KiCad's drag (G): the wire ends on the part's pins come along and the rest of each wire stays; a label
        // or a no-connect mark that sits right on a pin goes with the pin.
        const ends: Hold["ends"] = [], rides: Hold["rides"] = [];
        if (it.kind === "symbol") for (const p of K.pinPoints(doc, it) as { x: number; y: number }[]) {
          for (const w of K.wireEndsAt(doc, p.x, p.y) as any[]) ends.push({ item: w.item, index: w.index, from: [p.x, p.y] });
          for (const o of items) if (o !== it && (/label$/.test(o.kind) || o.kind === "no_connect") && !edits.some((h) => h.it === o)) { const a = posOf(o); if (Math.abs(a[0] - p.x) < 0.01 && Math.abs(a[1] - p.y) < 0.01) rides.push({ it: o, from: a }); }
        }
        drag = { it, from: posOf(it), c: mid(it.bbox), d: [0, 0], grab: at, ends, rides };
      }
      canvas.setPointerCapture(e.pointerId);
    } else if (t >= total) { pan = { at: [e.clientX, e.clientY], box: box.slice() as Box }; canvas.setPointerCapture(e.pointerId); }
    stage.invalidate();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag) {
      const at = where(e), dx = Math.round((at[0] - drag.grab[0]) / GRID) * GRID, dy = Math.round((at[1] - drag.grab[1]) / GRID) * GRID;
      lastAct = performance.now();
      if (Math.abs(drag.d[0] - dx) > 1e-6 || Math.abs(drag.d[1] - dy) > 1e-6) { shift(drag, dx, dy); stage.invalidate(); }
    } else if (pan) {
      const v = fit(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1, pan.box), k = v.ppm * v.zoom;
      const dx = (e.clientX - pan.at[0]) / k, dy = (e.clientY - pan.at[1]) / k;
      box = [pan.box[0] - dx, pan.box[1] - dy, pan.box[2] - dx, pan.box[3] - dy]; stage.invalidate();
    } else canvas.style.cursor = under(where(e)) ? "move" : "";
  });
  const release = (): void => {
    if (drag) {
      const i = edits.indexOf(drag), off = Math.abs(drag.d[0]) > 1e-6 || Math.abs(drag.d[1]) > 1e-6;
      if (off && i < 0) edits.push(drag); else if (!off && i >= 0) edits.splice(i, 1);
      lastAct = performance.now(); stage.invalidate();
    }
    drag = null; pan = null;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;               // a plain wheel scrolls the page
    e.preventDefault(); if (t < total) return;
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
  const says = (drawing: boolean): void => { if (cap) cap.textContent = drawing ? "Mara, Jun and Ada are drawing the schematic. Drag a part: one of them puts it back." : "The schematic the board is made from. Drag a part: one of them puts it back."; };
  function show(v: "sch" | "pcb"): void {
    root.dataset.view = v;
    for (const b of tabs) b.setAttribute("aria-selected", String(b.dataset.tab === v));
    if (app) app.textContent = v === "sch" ? "Schematic Editor" : "PCB Editor";
  }
  for (const b of tabs) b.addEventListener("click", () => { const v = b.dataset.tab as "sch" | "pcb"; if (v === "sch") { sch.whole(); says(false); } show(v); });
  root.addEventListener("hero:sch-done", () => show("pcb"));
  if (auto) {
    root.addEventListener("hero:again", () => { show("sch"); says(true); sch.play(); });
    show("sch"); says(true); sch.play();
  } else { sch.whole(); says(false); show("pcb"); }
}
