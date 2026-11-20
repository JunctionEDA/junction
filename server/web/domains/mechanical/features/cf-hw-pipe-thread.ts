// cf-hw-pipe-thread.ts — Pipe thread: a modelled tapered pipe thread, NPT (ASME B1.20.1) or BSPT (ISO 7-1, R and
// Rc), on the end of a pipe or in a hole.  The diameter grows 1 in 16 along the thread; on a pipe the crests are
// cut off at the pipe's own surface, so the thread vanishes into it as a die leaves it.
//
// NPT is modelled with its 60° profile and flats of 0.038 P.  BSPT is modelled with its 55° flanks and height
// (0.6403 P); its rounded crests and roots are modelled as flats of P/6.
//
// Names: as Thread (`<id>:crest`, `:root`, `:flank`, `:flank-back`).
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { cylinderOf } from "../kernel/ops/cf-hw";
import { threadEnds, threadOn } from "../kernel/ops/cf-hw-thread";
import { HW_SECTION, MENU_THREADS, options, PIPE_TAPER, PIPE_THREADS } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PipeThreadParams {
  [key: string]: any;
  face: GeomRef | null; standard: "npt" | "bspt"; size_npt: string; size_bspt: string;
  standardLength: boolean; length: number; flip: boolean; leadIn: boolean;
}

const AUTO = [{ value: "auto", label: "Fit the diameter" }];

export default defineFeature<PipeThreadParams>({
  type: "cf-hw-pipe-thread",
  title: "Pipe thread",
  icon: '<path class="f" d="M7 3h10l-1.5 18h-7z"/><path d="M7 3h10l-1.5 18h-7z"/><path d="M7.4 7.5l9.1-2M7.8 11.5l8.4-2M8.1 15.5l7.7-2M8.4 19.5l7-2"/>',
  hint: "Model a tapered pipe thread (NPT or BSPT) on a pipe's end or in a hole",
  keywords: "pipe thread tapered npt bspt bsp r rc taper fitting plumbing national pipe",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_THREADS, toolbarOrder: 12, toolbarKeep: 0,
  defaults: () => ({ face: null, standard: "npt", size_npt: "auto", size_bspt: "auto", standardLength: true, length: 12, flip: false, leadIn: true }),
  schema: [
    { key: "face", label: "Pipe or hole", kind: "refs", of: ["face"], single: true, hint: "The round outside of a pipe's end, or the wall of a hole." },
    { key: "standard", label: "Standard", kind: "enum", options: Object.keys(PIPE_THREADS).map((s) => ({ value: s, label: PIPE_THREADS[s].label })) },
    { key: "size_npt", label: "Size", kind: "enum", options: options(PIPE_THREADS.npt.sizes.map((s) => s.id), AUTO), visible: (p) => p.standard === "npt" },
    { key: "size_bspt", label: "Size", kind: "enum", options: options(PIPE_THREADS.bspt.sizes.map((s) => s.id), AUTO), visible: (p) => p.standard === "bspt" },
    { key: "standardLength", label: "Standard length", kind: "boolean", hint: "The standard's length of effective thread." },
    { key: "length", label: "Length", kind: "number", unit: "mm", min: 0.5, step: 1, visible: (p) => !p.standardLength },
    { key: "flip", label: "Start at the other end", kind: "boolean" },
    { key: "leadIn", label: "Chamfered start", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: PipeThreadParams) {
    const std = PIPE_THREADS[p.standard];
    if (!std) throw ctx.fail("Pick NPT or BSPT.");
    const cyl = cylinderOf(ctx, p.face, "the round outside of a pipe, or the wall of a hole");
    const want = p[`size_${p.standard}`];
    let size = std.sizes.find((s) => s.id === want);
    if (!size) {
      if (want && want !== "auto") throw ctx.fail(`The ${std.label} table has no ${want}.`);
      // a pipe is as thick as the size's pipe; a hole is drilled to about the thread's minor diameter at its mouth
      const d = cyl.radius * 2;
      const off = (s: typeof std.sizes[number]) => Math.abs((cyl.hole ? s.majorMouth - 2 * std.form(s.pitch).depth : s.od) - d);
      size = std.sizes.reduce((a, b) => (off(b) < off(a) ? b : a));
      if (off(size) > 0.08 * d + 0.3) throw ctx.fail(`No ${std.label} size fits a ${cyl.hole ? "hole" : "pipe"} of ${Math.round(d * 100) / 100} mm. Pick a size.`);
    }
    const form = std.form(size.pitch);
    const length = p.standardLength ? size.length : Number(p.length);
    if (!(length > 0)) throw ctx.fail("The thread's length must be more than zero.");
    const ends = threadEnds(ctx, cyl, !!p.flip, length);
    threadOn(ctx, cyl, {
      pitch: size.pitch, starts: 1, left: false, depth: form.depth, majorFlat: form.majorFlat, minorFlat: form.minorFlat,
      // outside, the thread grows from the pipe's end; inside, it shrinks from the mouth
      major: (cyl.hole ? size.majorMouth : size.majorTip) / 2, taper: cyl.hole ? -PIPE_TAPER : PIPE_TAPER,
      length, fromHi: ends.fromHi, leadIn: p.leadIn ? form.depth : 0, runout: ends.fades ? size.pitch : 0,
    });
  },
});
