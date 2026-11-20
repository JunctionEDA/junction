// cf-geo-voronoi.ts — the Voronoi pattern: cut a flat face into cells with walls of one width between them, as
// a honeycomb grown from scattered points.  The points are scattered from a seed number (the same number, the
// same pattern), optionally evened out (each point moved to the middle of its cell, a few times over), and each
// cell is every place nearer its point than any other, pulled in by half the wall.  Cells keep a margin from
// the face's edges and holes, their corners can be rounded, and the cut goes through the part or to a depth.
//
// Names: on a face that is a plain rectangle a cell's faces are `<id>:c<n>:<k>` (n: the cell's point, in the
// order scattered); on any other face the cells are trimmed to it together and are `<id>:cells:<k>`.
import { defineFeature } from "../core/feature";
import { add, scale, type GeomRef, type Vec2 } from "../core/geometry";
import type { EvalContext, Shape } from "../kernel/types";
import { OVERLAP, applyTools, clipToFace, depthBehind, faceOfWires, flatFace, isRectangle, prismOf, roundedWire, tagged } from "../kernel/ops/cf-geo";
import type { Tool } from "../kernel/ops/pattern-core";
import { compound } from "../kernel/ops/shapes";
import { centroid, inRegion, rng, scatter, tidyLoop, voronoiCells } from "./_cf-geo";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface VoronoiParams { [key: string]: any; face: GeomRef | null; cells: number; seed: number; relax: number; wall: number; margin: number; radius: number; through: boolean; depth: number }

export default defineFeature<VoronoiParams>({
  type: "cf-geo-voronoi",
  title: "Voronoi pattern",
  hint: "Cut a flat face into organic cells with walls of one width between them.",
  keywords: "voronoi cells organic honeycomb lattice lightweight cutout pattern random foam giraffe",
  icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><path class="f" d="M5.5 5.5h5l1.5 4-3 3-3.5-1.5zM13 5.5h5.500v5l-4.500 1zM5.500 13.500l3 1.500.5 3.500h-3.500zM11 14l3.500-2 4 1.500v5h-7z"/><path class="t" d="M5.5 5.5h5l1.5 4-3 3-3.5-1.5zM13 5.5h5.500v5l-4.500 1zM5.500 13.500l3 1.500.5 3.500h-3.500zM11 14l3.500-2 4 1.500v5h-7z"/>',
  toolbarOrder: 306, toolbarSection: "library", toolbarMenu: "Patterns & texture", toolbarKeep: 0,
  defaults: () => ({ face: null, cells: 24, seed: 1, relax: 2, wall: 2, margin: 3, radius: 1, through: true, depth: 2 }),
  schema: [
    { key: "face", label: "Face", kind: "refs", of: ["face"], single: true, hint: "A flat face to cut the cells into." },
    { key: "cells", label: "Cells", kind: "number", unit: "none", min: 2, max: 400, step: 5 },
    { key: "seed", label: "Seed", kind: "number", unit: "none", step: 1, hint: "Another whole number gives another pattern." },
    { key: "relax", label: "Evenness", kind: "number", unit: "none", min: 0, max: 10, step: 1, hint: "0 leaves the cells as scattered; each step makes them more alike in size." },
    { key: "wall", label: "Wall", kind: "number", unit: "mm", min: 0.01, step: 0.5, hint: "The width of the material left between cells." },
    { key: "margin", label: "Margin", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "Left solid along the face's edges and round its holes." },
    { key: "radius", label: "Corner radius", kind: "number", unit: "mm", min: 0, step: 0.25 },
    { key: "through", label: "Through", kind: "boolean", hint: "Cut through the whole part." },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0.001, step: 0.5, visible: (p) => !p.through },
  ],

  evaluate(ctx: EvalContext, p: VoronoiParams) {
    const n = Math.round(Number(p.cells));
    if (!(n >= 2) || n > 400) throw ctx.fail("The number of cells is between 2 and 400.");
    if (!(p.wall > 0)) throw ctx.fail("The wall must be wider than zero.");
    if (!(p.margin >= 0) || !(p.radius >= 0)) throw ctx.fail("The margin and the corner radius cannot be less than zero.");
    if (!p.through && !(p.depth > 0)) throw ctx.fail("The depth must be more than zero.");
    const f = flatFace(ctx, p.face);
    const [x0, y0, x1, y1] = f.box;
    if (x1 - x0 <= 2 * p.margin || y1 - y0 <= 2 * p.margin) throw ctx.fail("The margin leaves nothing of the face. Use a smaller one.");
    let sites = scatter(f.region, n, 0, p.margin, rng(p.seed));
    if (sites.length < 2) throw ctx.fail("The face is too small for cells with this margin.");
    // the box the cells are cut from: the face's, less the margin (voronoiCells takes half a wall more off)
    const h = p.wall / 2, box: [number, number, number, number] = [x0 + p.margin - h, y0 + p.margin - h, x1 - p.margin + h, y1 - p.margin + h];
    for (let i = Math.min(10, Math.max(0, Math.round(Number(p.relax) || 0))); i > 0; i--) {
      const cells = voronoiCells(sites, box, 0);
      sites = sites.map((s, j): Vec2 => { if (cells[j].length < 3) return s; const c = centroid(cells[j]); return inRegion(f.region, c, p.margin) ? c : s; });
    }
    const cells = voronoiCells(sites, box, p.wall).map((c) => tidyLoop(c, 1e-6));
    const depth = p.through ? depthBehind(ctx, f.body, f.frame.origin, f.frame.normal) : p.depth;
    // the cells start a hair above the face, so that they do not end exactly on it
    const up = { ...f.frame, origin: add(f.frame.origin, scale(f.frame.normal, OVERLAP)) }, down = scale(f.frame.normal, -depth - OVERLAP);
    const faces: { shape: Shape; i: number }[] = [];
    cells.forEach((c, i) => { if (c.length >= 3) faces.push({ shape: faceOfWires(ctx, up, roundedWire(ctx, up, c, p.radius)), i }); });
    if (!faces.length) throw ctx.fail("No cell is left: the wall is too wide for this many cells. Use fewer cells or a thinner wall.");
    let tools: Tool[];
    if (isRectangle(f)) tools = faces.map((c) => tagged(ctx, prismOf(ctx, c.shape, down), `c${c.i + 1}`));
    else tools = [tagged(ctx, clipToFace(ctx, prismOf(ctx, compound(ctx.k, faces.map((c) => c.shape), ctx.own), down), f, p.margin, -depth, OVERLAP), "cells")];
    if (faces.length < n) ctx.warn(`${n - faces.length} of ${n} cells are too small for this wall and were left out.`);
    applyTools(ctx, tools, "remove", [f.body]);
  },
});
