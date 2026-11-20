// cf-fab-box.ts — Box generator: a finger-jointed box from sheet material, each panel a body ready to cut.
//
// The box stands on the plane, centred on its origin; width is along the plane's x, depth along its y.  Every
// edge where two panels meet is divided into an odd number of fingers as near the asked width as fits, and the
// panels take them in turn: front and back keep the ends of every edge (and the corners), then left and right,
// then bottom and lid.  Kerf widens every finger by the width of the cut so the joints are tight off the laser.
// Lid: none (open top), jointed (a sixth panel, glued in), or lift-off (a plate on top with a smaller one under
// it that sits inside the walls).
// Bodies: `<id>:front`, `:back`, `:left`, `:right`, `:bottom`, `:lid`, `:lid-key`.  Faces: `<id>:<panel>:start`
// (inside), `:end` (outside; for the bottom and lid: start is below), and `<id>:<panel>:s<n>` round the outline.
import { defineFeature } from "../core/feature";
import type { Frame, PlaneRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { at, box, fingers, frameAt, polyPrism, positive, type P2 } from "../kernel/ops/cf-fab";
import { LASER } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BoxParams { [key: string]: any; plane: PlaneRef; width: number; depth: number; height: number; inside: boolean; thickness: number; fingerWidth: number; kerf: number; lid: "none" | "jointed" | "liftoff"; lidClearance: number }

/** One side of a panel: how long, whether this panel keeps the first and last finger, or no joint at all. */
export interface PanelEdge { len: number; first: boolean; plain?: boolean }

/**
 * The outline of a panel a × b whose four sides (bottom, right, top, left, going round anticlockwise) are finger
 * jointed.  `corners[i]` says whether the panel keeps the square at the start of side i.  A finger the panel
 * keeps reaches the panel's edge; one it gives up is cut back by the thickness `t`.  `grow` widens every kept
 * finger at each of its ends by half of it (the kerf).
 */
export function panelOutline(a: number, b: number, t: number, edges: readonly PanelEdge[], corners: readonly boolean[], width: number, grow: number): P2[] {
  const map: ((s: number, d: number) => P2)[] = [(s, d) => [s, d], (s, d) => [a - d, s], (s, d) => [a - s, b - d], (s, d) => [d, b - s]];
  const pts: P2[] = [];
  const push = (q: P2) => { const l = pts[pts.length - 1]; if (!l || Math.abs(l[0] - q[0]) > 1e-9 || Math.abs(l[1] - q[1]) > 1e-9) pts.push(q); };
  // each side as runs of [from, to, kept]
  const sides = edges.map((e, i) => {
    const mid = e.plain ? [0, e.len - 2 * t] : fingers(e.len - 2 * t, width);
    const runs: { s0: number; s1: number; own: boolean }[] = [{ s0: 0, s1: t, own: corners[i] }];
    for (let j = 0; j + 1 < mid.length; j++) runs.push({ s0: t + mid[j], s1: t + mid[j + 1], own: e.plain ? true : (j % 2 === 0) === e.first });
    runs.push({ s0: e.len - t, s1: e.len, own: corners[(i + 1) % 4] });
    // a kept finger grows into the gap beside it
    for (let j = 0; j + 1 < runs.length; j++) if (runs[j].own !== runs[j + 1].own) { const d = runs[j].own ? grow / 2 : -grow / 2; runs[j].s1 += d; runs[j + 1].s0 += d; }
    return runs;
  });
  sides.forEach((runs, i) => {
    const prev = sides[(i + 3) % 4], next = sides[(i + 1) % 4];
    const body = runs.slice(1, -1);
    // a corner the panel does not keep: the notch's inner corner, where this side's cut meets the neighbour's
    if (!corners[i]) push(map[i](runs[0].s1, edges[(i + 3) % 4].len - prev[prev.length - 1].s0)); else { push(map[i](0, 0)); push(map[i](runs[0].s1, 0)); }
    for (const r of body) { const d = r.own ? 0 : t; push(map[i](r.s0, d)); push(map[i](r.s1, d)); }
    if (!corners[(i + 1) % 4]) push(map[i](runs[runs.length - 1].s0, next[0].s1)); else { push(map[i](runs[runs.length - 1].s0, 0)); push(map[i](edges[i].len, 0)); }
  });
  if (pts.length > 1 && Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-9 && Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-9) pts.pop();
  // drop points on a straight run
  const out: P2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[(i + pts.length - 1) % pts.length], p1 = pts[i], p2 = pts[(i + 1) % pts.length];
    const cr = (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]);
    if (Math.abs(cr) > 1e-9) out.push(p1);
  }
  return out;
}

export default defineFeature<BoxParams>({
  type: "cf-fab-box",
  title: "Box generator",
  icon: '<path class="f" d="M3 8l9-4 9 4v9l-9 4-9-4z"/><path d="M3 8l9-4 9 4v9l-9 4-9-4zM3 8l9 4 9-4"/><path d="M12 12v1.8h1.6v1.8H12v1.8h1.6v1.8H12V21"/>',
  hint: "A finger-jointed box from sheet material, panel by panel, with lid options",
  keywords: "box generator finger joint laser cut box maker enclosure panels plywood tabbed box lid kerf",
  ...LASER, toolbarOrder: 32,
  defaults: () => ({ plane: { kind: "plane", plane: "top" }, width: 100, depth: 60, height: 40, inside: false, thickness: 3, fingerWidth: 10, kerf: 0, lid: "none", lidClearance: 0.3 }),
  schema: [
    { key: "plane", label: "Stands on", kind: "plane" },
    { key: "width", label: "Width", kind: "number", unit: "mm", min: 1, step: 5 },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 1, step: 5 },
    { key: "height", label: "Height", kind: "number", unit: "mm", min: 1, step: 5 },
    { key: "inside", label: "Sizes are inside", kind: "boolean", hint: "Off: width, depth and height are the outside of the box." },
    { key: "thickness", label: "Material thickness", kind: "number", unit: "mm", min: 0.1, step: 0.5 },
    { key: "fingerWidth", label: "Finger width", kind: "number", unit: "mm", min: 0.5, step: 1 },
    { key: "kerf", label: "Kerf", kind: "number", unit: "mm", step: 0.05, hint: "The width of the cut: every finger is drawn wider by it. Negative for a looser fit." },
    { key: "lid", label: "Lid", kind: "enum", options: [{ value: "none", label: "None" }, { value: "jointed", label: "Jointed" }, { value: "liftoff", label: "Lift-off" }] },
    { key: "lidClearance", label: "Lid clearance", kind: "number", unit: "mm", min: 0, step: 0.1, hint: "Room round the plate that holds a lift-off lid in place.", visible: (p) => p.lid === "liftoff" },
  ],

  evaluate(ctx: EvalContext, p: BoxParams) {
    const id = ctx.feature.id;
    const t = positive(ctx, p.thickness, "material thickness"), fw = positive(ctx, p.fingerWidth, "finger width");
    const kerf = Number(p.kerf) || 0;
    if (Math.abs(kerf) > 2) throw ctx.fail("The kerf must be small (at most 2 mm).");
    const lid = p.lid === "jointed" || p.lid === "liftoff" ? p.lid : "none", closed = lid === "jointed";
    const grow = p.inside ? 2 * t : 0;
    const W = positive(ctx, p.width, "width") + grow, D = positive(ctx, p.depth, "depth") + grow, H = positive(ctx, p.height, "height") + (p.inside ? (closed ? 2 * t : t) : 0);
    const least = 2 * t + 3 * Math.max(1, Math.abs(kerf) * 2);
    if (Math.min(W, D, H) < least) throw ctx.fail(`The box is too small for material ${t} mm thick: every side must be at least ${Math.round(least * 10) / 10} mm on the outside.`);
    const base = ctx.frameOf(p.plane);
    // which panel wins an edge: front and back, then left and right, then bottom and lid
    const rank = { y: 3, x: 2, z: 1 };
    const edge = (len: number, mine: number, theirs: number, there = true): PanelEdge => (there ? { len, first: mine > theirs } : { len, first: true, plain: true });
    const make = (name: string, title: string, frame: Frame, a: number, b: number, edges: PanelEdge[], corners: boolean[]) => {
      const r = polyPrism(ctx, frame, panelOutline(a, b, t, edges, corners, fw, kerf), 0, t, `${id}:${name}`);
      ctx.addBody(r.shape, r.names, { suffix: name, name: title });
    };
    const all = [true, true, true, true], none = [false, false, false, false];
    // front and back: u along the width, v up; they keep every corner
    const fb = [edge(W, rank.y, rank.z), edge(H, rank.y, rank.x), edge(W, rank.y, rank.z, closed), edge(H, rank.y, rank.x)];
    make("front", "Front", frameAt(at(base, -W / 2, -D / 2 + t, 0), base.x, [-base.y[0], -base.y[1], -base.y[2]]), W, H, fb, all);
    make("back", "Back", frameAt(at(base, -W / 2, D / 2, 0), base.x, [-base.y[0], -base.y[1], -base.y[2]]), W, H, fb, all);
    // left and right: u along the depth, v up
    const lr = [edge(D, rank.x, rank.z), edge(H, rank.x, rank.y), edge(D, rank.x, rank.z, closed), edge(H, rank.x, rank.y)];
    make("left", "Left", frameAt(at(base, -W / 2, -D / 2, 0), base.y, base.x), D, H, lr, none);
    make("right", "Right", frameAt(at(base, W / 2 - t, -D / 2, 0), base.y, base.x), D, H, lr, none);
    // bottom and lid: u along the width, v along the depth
    const bl = [edge(W, rank.z, rank.y), edge(D, rank.z, rank.x), edge(W, rank.z, rank.y), edge(D, rank.z, rank.x)];
    make("bottom", "Bottom", frameAt(at(base, -W / 2, -D / 2, 0), base.x, base.normal), W, D, bl, none);
    if (closed) make("lid", "Lid", frameAt(at(base, -W / 2, -D / 2, H - t), base.x, base.normal), W, D, bl, none);
    if (lid === "liftoff") {
      const c = Math.max(0, Number(p.lidClearance) || 0);
      if (W - 2 * t - 2 * c <= 1 || D - 2 * t - 2 * c <= 1) throw ctx.fail("The lid clearance leaves nothing of the plate inside the walls.");
      const plate = box(ctx, base, [-W / 2, -D / 2, H], [W / 2, D / 2, H + t], `${id}:lid`);
      ctx.addBody(plate.shape, plate.names, { suffix: "lid", name: "Lid" });
      const key = box(ctx, base, [-W / 2 + t + c, -D / 2 + t + c, H - t], [W / 2 - t - c, D / 2 - t - c, H], `${id}:lid-key`);
      ctx.addBody(key.shape, key.names, { suffix: "lid-key", name: "Lid key" });
    }
  },
});
