// The hero's schematic tab: the same three teammates draw the STM32 board's schematic, a block
// each at a time, before the window turns to the board (mini.ts).  Shown whole when the visitor
// opens the tab themselves.

import { Box, K, PEERS, Pt, clamp, drawCursor, fit, lerp, toPx } from "./demo";
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
  // Framed by what is drawn, not by the A3 page around it: the page border is left out, so the blocks sit centred in the window.
  const view: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const it of items) { view[0] = Math.min(view[0], it.bbox[0]); view[1] = Math.min(view[1], it.bbox[1]); view[2] = Math.max(view[2], it.bbox[2]); view[3] = Math.max(view[3], it.bbox[3]); }
  view[0] -= 5; view[1] -= 5; view[2] += 5; view[3] += 5;

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
  const still = reducedMotion();
  const stage: Stage = makeStage(canvas, (s, _now, dt) => {
    const { ctx, w: W, h: H } = s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const playing = t <= total + HOLD;
    if (playing) t += dt;
    if (t >= total) { K.render(doc, ctx, fit(W, H, s.dpr, view), { ids: all, grid: 1.27, frame: false }); focus = NaN; }
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
      let box = view;
      const bw = (view[3] - view[1]) * W / H;
      if (bw < (view[2] - view[0]) * 0.8) {
        const want = clamp((hands[0][0] + hands[1][0] + hands[2][0]) / 3, view[0] + bw / 2, view[2] - bw / 2);
        focus = isNaN(focus) ? want : focus + (want - focus) * Math.min(1, dt / 900);
        box = [focus - bw / 2, view[1], focus + bw / 2, view[3]];
      }
      const v = fit(W, H, s.dpr, box);
      K.render(doc, ctx, v, { ids, grid: 1.27, frame: false, selected: fresh.size ? fresh : null });
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      hands.forEach((h, k) => { if (lanes[k].length) { const p = toPx(v, h[0], h[1]); drawCursor(ctx, p[0], p[1], PEERS[k].name, PEERS[k].color, SANS); } });
    }
    if (playing && t > total + HOLD && !ended) { ended = true; onEnd(); }
    return playing;
  });
  return {
    symbols: items.filter(real).length,
    play() { if (still) { t = Infinity; ended = true; } else { t = 0; ended = false; } stage.invalidate(); },
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
  const says = (drawing: boolean): void => { if (cap) cap.textContent = drawing ? "Mara, Jun and Ada are drawing the schematic. The board comes next." : "The schematic the board is made from."; };
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
