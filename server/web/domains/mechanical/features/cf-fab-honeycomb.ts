// cf-fab-honeycomb.ts — Honeycomb pockets: a pattern of hexagonal pockets in a flat face that takes weight out
// and leaves a web of ribs.
//
// Pick the face.  The hexagons are a given size across their flats with a rib of the given thickness between
// neighbours, laid out from the middle of the face and turned by the angle; they stay a border away from the
// face's outline and from its holes.  At the border either only whole cells are kept, or the cells are trimmed
// to it so the pattern fills the face.  The pockets go to a depth or through the part.  All of them are cut in
// one operation.
// Names: `<id>:c<column>.<row>:s<n>` (a pocket's walls), `:end` (its floor); trimmed cells also have
// `<id>:border…` walls.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext, Shape } from "../kernel/types";
import { reachPast } from "../kernel/ops/shapes";
import { bool, boundary2d, change, edgeFace, inside2d, moved, offsetLoops, polyPrism, positive, segDistance, sweepFace, together, type P2 } from "../kernel/ops/cf-fab";
import { PRINT, pickedFace } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HoneycombParams { [key: string]: any; face: GeomRef | null; size: number; wall: number; border: number; through: boolean; depth: number; edge: "whole" | "trim"; angle: number }

const MAX_CELLS = 700;

export default defineFeature<HoneycombParams>({
  type: "cf-fab-honeycomb",
  title: "Honeycomb pockets",
  icon: '<path class="t" d="M2 3h20v18H2z"/><path class="f" d="M8 5l3 1.7v3.5L8 12 5 10.2V6.7zM16 5l3 1.7v3.5L16 12l-3-1.8V6.7zM12 12l3 1.7v3.5L12 19l-3-1.8v-3.5z"/><path d="M8 5l3 1.7v3.5L8 12 5 10.2V6.7zM16 5l3 1.7v3.5L16 12l-3-1.8V6.7zM12 12l3 1.7v3.5L12 19l-3-1.8v-3.5z"/>',
  hint: "A pattern of hexagonal pockets in a face: lighter, with a web of ribs left",
  keywords: "honeycomb hex pocket lightening pattern hexagon grid isogrid weight reduction ribs perforation",
  ...PRINT, toolbarOrder: 52,
  defaults: () => ({ face: null, size: 8, wall: 1.5, border: 3, through: false, depth: 2, edge: "whole", angle: 0 }),
  schema: [
    { key: "face", label: "Face", kind: "refs", of: ["face"], single: true, hint: "The flat face the pockets are cut into." },
    { key: "size", label: "Cell size", kind: "number", unit: "mm", min: 0.5, step: 1, hint: "Across the flats of a hexagon." },
    { key: "wall", label: "Rib", kind: "number", unit: "mm", min: 0.1, step: 0.5, hint: "The material left between two cells." },
    { key: "border", label: "Border", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "The material left along the face's outline and round its holes." },
    { key: "through", label: "Through", kind: "boolean" },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0.01, step: 0.5, visible: (p) => !p.through },
    { key: "edge", label: "At the border", kind: "enum", options: [{ value: "whole", label: "Whole cells" }, { value: "trim", label: "Trim cells" }] },
    { key: "angle", label: "Turn", kind: "number", unit: "deg", step: 15 },
  ],

  evaluate(ctx: EvalContext, p: HoneycombParams) {
    const k = ctx.k, id = ctx.feature.id;
    const f = pickedFace(ctx, p.face, "the flat face to pocket");
    const size = positive(ctx, p.size, "cell size"), wall = positive(ctx, p.wall, "rib"), border = Math.max(0, Number(p.border) || 0);
    if (!p.through && !(p.depth > 0)) throw ctx.fail("The depth must be more than zero.");
    const ef = edgeFace(ctx, f.shape);
    const g = moved(ef.frame, 0, 0, 0, Number(p.angle) || 0);
    const depth = p.through ? reachPast(k, [f.body.shape], ef.frame.origin) : p.depth;
    // a hexagon with a corner up: columns a pitch apart, rows closer and shifted by half a pitch
    const pitch = size + wall, row = (pitch * Math.sqrt(3)) / 2, rc = size / Math.sqrt(3);
    const reach = Math.hypot(ef.long, ef.short) / 2 + pitch;
    const cols = Math.ceil(reach / pitch), rows = Math.ceil(reach / row);
    if ((ef.long * ef.short) / (pitch * row) > MAX_CELLS * 1.5) throw ctx.fail(`That is too many cells (more than ${MAX_CELLS}). Use larger cells.`);
    const outline = boundary2d(ctx, f.shape, g);
    const trim = p.edge === "trim";
    const cells: { key: string; pts: P2[] }[] = [];
    for (let j = -rows; j <= rows; j++) for (let i = -cols; i <= cols; i++) {
      const cx = (i + (j % 2 ? 0.5 : 0)) * pitch, cy = j * row;
      const pts: P2[] = Array.from({ length: 6 }, (_, n) => { const a = Math.PI / 6 + (n * Math.PI) / 3; return [cx + rc * Math.cos(a), cy + rc * Math.sin(a)] as P2; });
      // how near the cell comes to the outline, and whether it is on the face at all
      let near = Infinity;
      for (const [a, b] of outline) { if (Math.abs((a[0] + b[0]) / 2 - cx) > rc + border + Math.hypot(a[0] - b[0], a[1] - b[1]) / 2 + 1e-6) continue; for (let n = 0; n < 6; n++) near = Math.min(near, segDistance(pts[n], pts[(n + 1) % 6], a, b)); }
      const centreIn = inside2d(outline, [cx, cy]);
      if (trim ? !(centreIn || near <= 1e-9 || pts.some((q) => inside2d(outline, q))) : !(centreIn && near >= border - 1e-9)) continue;
      cells.push({ key: `c${i}.${j}`, pts });
    }
    if (!cells.length) throw ctx.fail("No cell fits on the face inside the border. Use smaller cells or a narrower border.");
    if (cells.length > MAX_CELLS) throw ctx.fail(`That is too many cells (${cells.length}; at most ${MAX_CELLS}). Use larger cells.`);
    let tool: NamedResult = together(ctx, cells.map((c) => polyPrism(ctx, g, c.pts, 0, -depth, `${id}:${c.key}`, ["s1", "s2", "s3", "s4", "s5", "s6"])));
    if (trim) {
      // what is left of the face a border in from its outline, as a solid: the cells are kept only inside it
      const loops = offsetLoops(ctx, f.shape, -border || -1e-6, "the face");
      const solids = loops.map((l, n) => sweepFace(ctx, ef.frame, { face: l.face, edges: k.sub(l.wire, "edge").map((e: Shape, m: number) => ({ name: `w${n + 1}.${m + 1}`, edge: e })) }, -depth, `${id}:border`));
      const core = solids.length > 1 ? bool(ctx, "cut", solids[0], together(ctx, solids.slice(1))) : solids[0];
      tool = bool(ctx, "common", tool, core);
      if (!(k.volume(tool.shape) > 1e-9)) throw ctx.fail("The border leaves nothing of the face to pocket.");
    }
    const before = ctx.bodies().length;
    change(ctx, f.body, "cut", tool);
    if (ctx.bodies().length !== before) throw ctx.fail("The pockets cut the part into pieces. Use a wider border or rib, or pockets that do not go through.");
  },
});
