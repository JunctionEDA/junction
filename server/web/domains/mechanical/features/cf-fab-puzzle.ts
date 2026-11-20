// cf-fab-puzzle.ts — Puzzle joint: split a plate that is too large for the machine along a seam of
// jigsaw-like knobs, so the pieces lock together again in the plane.
//
// Pick the flat side of the plate.  The seam crosses it at an offset from its middle; knobs are spaced evenly
// along the seam and point to alternate sides, each a round head on a narrower neck, so the joint holds against
// pulling apart either way.  Clearance opens the sockets (use the kerf's negative for a press fit off a laser).
// The piece on the plate's low side keeps the body; the other is `<id>:<body>.b`.
// Names: `<id>:seam`, `<id>:k<n>:neck-l`, `:head`, `:neck-r` on both pieces.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import { bool, box, frameAt, at, plateOf, positive, prism, shape, whole, type P2, type Seg } from "../kernel/ops/cf-fab";
import { LASER, pickedFace } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PuzzleParams { [key: string]: any; face: GeomRef | null; across: "long" | "short"; offset: number; count: number; neck: number; head: number; reach: number; clearance: number }

export default defineFeature<PuzzleParams>({
  type: "cf-fab-puzzle",
  title: "Puzzle joint",
  icon: '<path class="f" d="M2 5h9v4.5a2.2 2.2 0 1 1 0 5V19H2z"/><path d="M2 5h9v4.5a2.2 2.2 0 1 1 0 5V19H2z"/><path class="t" d="M11 5h11v14H11"/>',
  hint: "Split an oversize plate along a seam of jigsaw knobs that lock the pieces together",
  keywords: "puzzle joint jigsaw split sheet oversize plate knob interlock seam bow tie laser cnc",
  ...LASER, toolbarOrder: 36,
  defaults: () => ({ face: null, across: "long", offset: 0, count: 3, neck: 6, head: 10, reach: 8, clearance: 0 }),
  schema: [
    { key: "face", label: "Plate face", kind: "refs", of: ["face"], single: true, hint: "The flat side of the plate to split." },
    { key: "across", label: "Seam across", kind: "enum", options: [{ value: "long", label: "Long side" }, { value: "short", label: "Short side" }], hint: "Which side of the plate the seam cuts in two." },
    { key: "offset", label: "From the middle", kind: "number", unit: "mm", step: 1 },
    { key: "count", label: "Knobs", kind: "number", unit: "none", min: 1, step: 1 },
    { key: "neck", label: "Neck width", kind: "number", unit: "mm", min: 0.1, step: 0.5 },
    { key: "head", label: "Head diameter", kind: "number", unit: "mm", min: 0.1, step: 0.5 },
    { key: "reach", label: "Head from the seam", kind: "number", unit: "mm", min: 0.1, step: 0.5, hint: "From the seam to the middle of a knob's head." },
    { key: "clearance", label: "Clearance", kind: "number", unit: "mm", step: 0.05, hint: "Room round each knob in its socket. Negative for a press fit." },
  ],

  evaluate(ctx: EvalContext, p: PuzzleParams) {
    const k = ctx.k, id = ctx.feature.id;
    const f = pickedFace(ctx, p.face, "the flat side of the plate to split");
    const count = whole(ctx, p.count, "number of knobs", 1, 200);
    const neck = positive(ctx, p.neck, "neck width"), head = positive(ctx, p.head, "head diameter"), reach = positive(ctx, p.reach, "distance of the head from the seam");
    const c = Number(p.clearance) || 0;
    if (Math.abs(c) > 2) throw ctx.fail("The clearance must be small (at most 2 mm).");
    if (head <= neck + Math.abs(c) * 2 + 0.2) throw ctx.fail("The head must be wider than the neck, or the knob does not lock.");
    const pl = plateOf(ctx, f.body, f.shape);
    // u along the seam, v across it; the plate's first piece is on the v < 0 side
    const long = p.across !== "short";
    const offset = Number(p.offset) || 0;
    const g = long ? frameAt(at(pl.frame, offset, 0, 0), pl.frame.y, pl.frame.normal) : frameAt(at(pl.frame, 0, offset, 0), pl.frame.x, pl.frame.normal);
    const seam = long ? pl.size[1] : pl.size[0], span = long ? pl.size[0] : pl.size[1];
    if (Math.abs(offset) + reach + head / 2 + 1 > span / 2) throw ctx.fail("The seam and its knobs do not fit on the plate there. Move the seam toward the middle.");
    const pitch = seam / count;
    if (head + Math.abs(c) * 2 + 2 > pitch) throw ctx.fail("The knobs do not fit along the seam. Use fewer or smaller knobs.");
    const R0 = head / 2;
    const w0 = -pl.thickness - 1, h = pl.thickness + 2;
    /** A knob at `u`, pointing to +v (dir 1) or −v, grown by `grow` all round; it starts a little behind the seam. */
    const knob = (i: number, grow: number): NamedResult => {
      const u = -seam / 2 + pitch * (i + 0.5), dir = i % 2 === 0 ? 1 : -1;
      const hn = neck / 2 + grow, R = R0 + grow;
      const y1 = reach - Math.sqrt(R * R - hn * hn);   // where the neck meets the head
      if (!(y1 > 0.05)) throw ctx.fail("The head sits on the seam: move it farther away or make it smaller.");
      const q = (x: number, y: number): P2 => [u + x * dir, y * dir];   // mirrored for a knob pointing the other way
      const segs: Seg[] = [{ to: q(hn, -1), name: "back" }, { to: q(hn, y1), name: "neck-r" }, { to: q(-hn, y1), via: q(0, reach + R), name: "head" }, { to: q(-hn, -1), name: "neck-l" }];
      return prism(ctx, g, q(-hn, -1), segs, w0, h, `${id}:k${i + 1}`);
    };
    const idx = Array.from({ length: count }, (_, i) => i);
    const side = (grow: number): NamedResult => {
      const half = box(ctx, g, [-seam / 2 - 1, -span - Math.abs(offset) - 1, w0], [seam / 2 + 1, 0, w0 + h], `${id}:half`);
      const named: NamedResult = { shape: half.shape, names: (face, i) => { const n = half.names(face, i); return n === `${id}:half:v1` ? `${id}:seam` : n; } };
      // the first piece keeps the even knobs and gives up the sockets of the odd ones
      const withKnobs = shape(ctx, "fuse", named, idx.filter((i) => i % 2 === 0).map((i) => knob(i, grow)));
      return shape(ctx, "cut", withKnobs, idx.filter((i) => i % 2 === 1).map((i) => knob(i, -grow)));
    };
    const body = f.body;
    const first = bool(ctx, "common", body, side(0));
    const second = bool(ctx, "cut", body, c ? side(c) : side(0));
    const a = k.solids(first.shape), b = k.solids(second.shape);
    if (a.length !== 1 || b.length !== 1) throw ctx.fail("The seam does not cut the plate into two pieces. Check that it crosses the whole plate and clears its holes.");
    ctx.replaceBody(body, a[0], first.names);
    ctx.addBody(b[0], second.names, { suffix: `${body.id}.b`, name: `${body.name} (2)` });
  },
});
