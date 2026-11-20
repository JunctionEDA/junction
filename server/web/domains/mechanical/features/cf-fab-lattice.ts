// cf-fab-lattice.ts — Lattice infill: replace the inside of a part with a lattice of struts, with or without a
// skin, to save weight and material.
//
// The lattice is a grid of cells a given size, with a node at the middle of the part's box: "cubic" has struts
// along the three axes through every node; "diagonal" has the four body diagonals of every cell (a body-centred
// lattice: its struts rise only 35° from the bed, so it suits resin and powder printers more than filament);
// "both" has the two together.  With a skin the part keeps a wall of that thickness and only what is inside it
// becomes lattice; without, the part's own shape trims the lattice.
// Struts are square (fast to build and to slice) or round.
//
// Bounded: the struts along the axes are cut in one boolean and each of the four families of diagonals in one
// more, and a lattice of more than 150 struts along the axes or 64 diagonals is refused with a sentence rather
// than left to run for minutes (the default, 27 struts in a 30 mm cube, takes about half a second; diagonals are
// several times slower per strut, because four of them cross in one point).  A true gyroid (a triply periodic
// surface) is not offered: the kernel would have to carry thousands of spline faces for what a slicer's infill
// does better.
// Names: the part's faces keep theirs; struts are `<id>:x<j>.<k>:…`, `:y…`, `:z…`, `:dpp<i>.<j>.<k>:…` (and `dpn`, `dnp`, `dnn`).  Pieces of
// lattice that the part's shape leaves loose are dropped.
import { defineFeature } from "../core/feature";
import { add, scale, type Frame, type Vec3 } from "../core/geometry";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext, Shape } from "../kernel/types";
import { bbox } from "../kernel/ops/shapes";
import { bool, boolMany, box, cylinder, facesOf, frameAt, positive, together } from "../kernel/ops/cf-fab";
import { PRINT } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface LatticeParams { [key: string]: any; bodies: string[]; kind: "cubic" | "diagonal" | "both"; cell: number; strut: number; section: "square" | "round"; skin: number }

const MAX_STRAIGHT = 150, MAX_SLANTED = 64;

export default defineFeature<LatticeParams>({
  type: "cf-fab-lattice",
  title: "Lattice infill",
  icon: '<path class="t" d="M3 3h18v18H3z"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/><path class="t" d="M3 3l18 18M21 3L3 21"/><circle class="s" cx="9" cy="9" r="1.3"/><circle class="s" cx="15" cy="9" r="1.3"/><circle class="s" cx="9" cy="15" r="1.3"/><circle class="s" cx="15" cy="15" r="1.3"/>',
  hint: "Replace the inside of a part with a strut lattice, cubic or diagonal, with an optional skin",
  keywords: "lattice infill strut cubic bcc octet gyroid lightweight scaffold cellular 3d print fill",
  ...PRINT, toolbarOrder: 50,
  defaults: () => ({ bodies: [], kind: "cubic", cell: 10, strut: 2, section: "square", skin: 0 }),
  schema: [
    { key: "bodies", label: "Part", kind: "bodies", hint: "The part to fill with lattice. Leave empty when there is only one." },
    { key: "kind", label: "Lattice", kind: "enum", options: [{ value: "cubic", label: "Cubic" }, { value: "diagonal", label: "Diagonal" }, { value: "both", label: "Both" }] },
    { key: "cell", label: "Cell size", kind: "number", unit: "mm", min: 0.5, step: 1 },
    { key: "strut", label: "Strut thickness", kind: "number", unit: "mm", min: 0.1, step: 0.2 },
    { key: "section", label: "Struts", kind: "enum", options: [{ value: "square", label: "Square" }, { value: "round", label: "Round" }] },
    { key: "skin", label: "Skin", kind: "number", unit: "mm", min: 0, step: 0.2, hint: "The wall the part keeps; 0 leaves only lattice." },
  ],

  evaluate(ctx: EvalContext, p: LatticeParams) {
    const k = ctx.k, oc = ctx.oc as any, id = ctx.feature.id;
    const cell = positive(ctx, p.cell, "cell size"), strut = positive(ctx, p.strut, "strut thickness"), skin = Math.max(0, Number(p.skin) || 0);
    if (strut >= cell * 0.6) throw ctx.fail("The struts are too thick for the cell: they would fill it. Use a larger cell or thinner struts.");
    const list = Array.isArray(p.bodies) ? p.bodies : [];
    const parts = list.length ? ctx.bodies().filter((b) => list.includes(b.id)) : ctx.bodies().slice();
    if (parts.length !== 1) throw ctx.fail(list.length ? "Pick one part to fill with lattice." : "Pick the part to fill with lattice.");
    const body = parts[0];
    const bb = bbox(k, [body.shape])!;
    const lo: Vec3 = [bb[0], bb[1], bb[2]], hi: Vec3 = [bb[3], bb[4], bb[5]];
    const mid: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    // the nodes: whole cells either way from the middle, as far as the part's box reaches
    const n = [0, 1, 2].map((a) => Math.floor((hi[a] - mid[a] - 1e-5) / cell));   // the box is a hair larger than the part
    const cubic = p.kind !== "diagonal", diagonal = p.kind === "diagonal" || p.kind === "both";
    const world: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };
    const h = strut / 2, pad = 1;
    // plan the bars before building any: what, where, and which family of parallel bars each belongs to
    interface Bar { from: Vec3; dir: Vec3; len: number; key: string }
    const straight: Bar[] = [], slanted: Bar[][] = [];
    if (cubic) {
      const axes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      for (let a = 0; a < 3; a++) {
        const b = (a + 1) % 3, c = (a + 2) % 3;
        for (let j = -n[b]; j <= n[b]; j++) for (let m = -n[c]; m <= n[c]; m++) {
          const from: Vec3 = [0, 0, 0];
          from[a] = lo[a] - pad; from[b] = mid[b] + j * cell; from[c] = mid[c] + m * cell;
          straight.push({ from, dir: axes[a], len: hi[a] - lo[a] + 2 * pad, key: `${"xyz"[a]}${j}.${m}` });
        }
      }
    }
    if (diagonal) {
      // the body diagonals of every cell: lines through the nodes along (±1, ±1, 1); one bar per line, from where
      // it enters the box of nodes (a cell beyond the part) to where it leaves
      const m = [n[0] + 1, n[1] + 1, n[2] + 1];
      for (const sx of [1, -1]) for (const sy of [1, -1]) {
        const d: Vec3 = [sx, sy, 1], family: Bar[] = [];
        for (let i = -m[0]; i <= m[0]; i++) for (let j = -m[1]; j <= m[1]; j++) for (let q = -m[2]; q <= m[2]; q++) {
          // a line starts at a node whose neighbour before it is outside the box
          if (Math.abs(i - sx) <= m[0] && Math.abs(j - sy) <= m[1] && q - 1 >= -m[2]) continue;
          let steps = 0;
          while (Math.abs(i + sx * (steps + 1)) <= m[0] && Math.abs(j + sy * (steps + 1)) <= m[1] && q + steps + 1 <= m[2]) steps++;
          if (!steps) continue;
          const from = add(mid, scale([i, j, q], cell)), to = add(from, scale(d, steps * cell));
          // leave out a bar that never comes near the part's box
          if ([0, 1, 2].some((a) => Math.min(from[a], to[a]) > hi[a] + h || Math.max(from[a], to[a]) < lo[a] - h)) continue;
          family.push({ from, dir: scale(d, 1 / Math.sqrt(3)), len: steps * cell * Math.sqrt(3), key: `d${sx > 0 ? "p" : "n"}${sy > 0 ? "p" : "n"}${i}.${j}.${q}` });
        }
        slanted.push(family);
      }
    }
    const slantedCount = slanted.reduce((a, f) => a + f.length, 0);
    if (!straight.length && !slantedCount) throw ctx.fail("The part is smaller than one cell. Use a smaller cell.");
    if (straight.length > MAX_STRAIGHT) throw ctx.fail(`That lattice would have ${straight.length} struts along the axes (at most ${MAX_STRAIGHT}). Use a larger cell.`);
    if (slantedCount > MAX_SLANTED) throw ctx.fail(`That lattice would have ${slantedCount} diagonal struts (at most ${MAX_SLANTED}). Use a larger cell.`);
    const bar = (b: Bar): NamedResult => {
      const f = frameAt(b.from, Math.abs(b.dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], b.dir);
      return p.section === "round" ? cylinder(ctx, f, [0, 0], h, 0, b.len, `${id}:${b.key}`) : box(ctx, f, [-h, -h, 0], [h, h, b.len], `${id}:${b.key}`);
    };

    // The part less its hollow, where the hollow is everything inside (a skin in from the faces, or the whole of
    // the part's box when there is no skin) that no strut fills, and then one cut of the part.
    let inside: Shape;
    if (skin > 0) {
      const mk = ctx.own(new oc.BRepOffsetAPI_MakeOffsetShape());
      let inner: Shape | null = null;
      try {
        mk.PerformByJoin(body.shape, -skin, 1e-4, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Intersection, false, ctx.tmp(new oc.Message_ProgressRange()));
        if (mk.IsDone()) inner = ctx.own(mk.Shape());
      } catch (x) { inner = null; }
      const solid = inner ? k.solids(inner) : [];
      if (solid.length !== 1 || !(k.volume(solid[0]) > 1e-6) || !(k.volume(solid[0]) < k.volume(body.shape))) throw ctx.fail("A skin of that thickness could not be offset inward from this part. Use a thinner skin, or none.");
      inside = solid[0];
    } else inside = box(ctx, world, [lo[0] - pad / 2, lo[1] - pad / 2, lo[2] - pad / 2], [hi[0] + pad / 2, hi[1] + pad / 2, hi[2] + pad / 2], `${id}:box`).shape;
    // the bars along the axes in one cut; each family of diagonals (parallel, apart from one another) in its own
    let hollow: NamedResult = { shape: inside, names: () => null };
    if (straight.length) hollow = boolMany(ctx, "cut", { shape: inside, faces: k.namedFaces(inside, () => null, `${id}:inside`) }, straight.map(bar));
    for (const family of slanted) if (family.length) hollow = bool(ctx, "cut", hollow, together(ctx, family.map(bar)));
    const result: NamedResult = k.boolean("cut", { shape: body.shape, faces: body.topo.faces }, { shape: hollow.shape, faces: facesOf(ctx, hollow) }, id, ctx.own);
    const pieces = k.solids(result.shape).map((s) => ({ s, v: k.volume(s) })).sort((a, b) => b.v - a.v);
    if (!pieces.length || !(pieces[0].v > 1e-9)) throw ctx.fail("Nothing of the part is left: no strut passes through it. Use a smaller cell.");
    ctx.replaceBody(body, pieces[0].s, result.names);
  },
});
