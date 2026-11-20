// cf-hw-standoff.ts — Standoff: a threaded spacer, hexagonal or round, by screw size and length.  Female at both
// ends, or with a threaded stud at the bottom (male-female).  The holes are drilled to the thread's minor
// diameter and the stud is a plain cylinder, or all of them carry modelled helical threads.
//
// It stands on the picked plane; the stud of a male-female standoff goes into the surface.
// Names: `<id>:flat` (or `:side`), `:top`, `:bottom`, `:bore`, `:stud`, `:stud:tip`, and the threads' when modelled.
import { defineFeature } from "../core/feature";
import type { Frame } from "../core/geometry";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import { toolFaces } from "../kernel/ops/combine";
import { apply, copies, cut, fuse, poly, revolved, spots, type V2 } from "../kernel/ops/cf-hw";
import { boreTool, hexPrism, minorOf, tapped } from "../kernel/ops/cf-hw-fasteners";
import { threadInto } from "../kernel/ops/cf-hw-thread";
import { fastenerOf, form60, HW_SECTION, MENU_THREADS, resultFields, sizeField, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface StandoffParams {
  [key: string]: any;
  body: "hex" | "round"; size: string; length: number; across: number; ends: "ff" | "mf"; stud: number; depth: number;
  thread: "plain" | "modelled"; operation: "new" | "add"; targets: string[];
}

export default defineFeature<StandoffParams>({
  type: "cf-hw-standoff",
  title: "Standoff",
  icon: '<path class="f" d="M7 4h10v12H7z"/><path d="M7 4h10v12H7zM10.3 4v12M13.7 4v12"/><path class="f" d="M10 16h4v5h-4z"/><path d="M10 16v5h4v-5"/><path class="t" d="M10 18.5l4-1"/>',
  hint: "Make a threaded standoff or spacer: hex or round, female-female or male-female, by size and length",
  keywords: "standoff spacer threaded hex pillar male female pcb m2 m2.5 m3 m4 hardware",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_THREADS, toolbarOrder: 23, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), body: "hex", size: "M3", length: 10, across: 0, ends: "ff", stud: 6, depth: 0, thread: "plain", operation: "new", targets: [] }),
  schema: [
    { key: "body", label: "Body", kind: "enum", options: [{ value: "hex", label: "Hex" }, { value: "round", label: "Round" }] },
    sizeField("Thread"),
    { key: "length", label: "Length", kind: "number", unit: "mm", min: 0.5, step: 1 },
    { key: "across", label: "Across flats / Ø", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "0 takes the size of the thread's hexagon nut." },
    { key: "ends", label: "Ends", kind: "enum", options: [{ value: "ff", label: "Female-female" }, { value: "mf", label: "Male-female" }] },
    { key: "stud", label: "Stud length", kind: "number", unit: "mm", min: 0.5, step: 1, visible: (p) => p.ends === "mf" },
    { key: "depth", label: "Thread depth", kind: "number", unit: "mm", min: 0, step: 1, hint: "How deep each hole is tapped; 0 taps right through." },
    { key: "thread", label: "Threads", kind: "enum", options: [{ value: "plain", label: "Plain" }, { value: "modelled", label: "Modelled" }] },
    ...whereFields({ noun: "standoff" }),
    ...resultFields,
  ],

  evaluate(ctx: EvalContext, p: StandoffParams) {
    const f = fastenerOf(p.size);
    if (!f) throw ctx.fail(`The size table has no ${p.size}.`);
    const L = Number(p.length), d = f.d, bore = minorOf(d, f.pitch);
    if (!(L > 0)) throw ctx.fail("The length must be more than zero.");
    const across = p.across > 0 ? Number(p.across) : f.s;
    if (!(across > d + 0.6)) throw ctx.fail(`The body must be wider than the thread: more than ${d + 0.6} mm.`);
    const male = p.ends === "mf", stud = male ? Number(p.stud) : 0;
    if (male && !(stud > 0)) throw ctx.fail("The stud's length must be more than zero.");
    const modelled = p.thread === "modelled";
    // the holes: through, or one from each end (one from the top over a stud)
    const want = Number(p.depth) || 0;
    const through = !male && (want <= 0 || want * 2 >= L);
    const deep = through ? L : Math.min(want > 0 ? want : L * 0.7, male ? L - Math.max(1, 0.15 * L) : L / 2 - 0.25);
    if (!(deep > f.pitch)) throw ctx.fail("The standoff is too short for a thread in it.");
    const build = (frame: Frame, prefix: string): NamedResult => {
      let body = p.body === "round"
        ? revolved(ctx, frame, poly([[0, 0], [across / 2, 0], [across / 2, L], [0, L]] as V2[], ["bottom", "side", "top", null]), prefix)
        : hexPrism(ctx, frame, across, 0, L, prefix, "both");
      if (male) {
        const ch = modelled ? 0 : Math.min(0.6 * f.pitch, d * 0.2);
        const pts: V2[] = ch > 0 ? [[0, 0.01], [d / 2, 0.01], [d / 2, -stud + ch], [d / 2 - ch, -stud], [0, -stud]] : [[0, 0.01], [d / 2, 0.01], [d / 2, -stud], [0, -stud]];
        body = fuse(ctx, body, revolved(ctx, frame, poly(pts, ch > 0 ? [null, "stud", "stud:point", "stud:tip", null] : [null, "stud", "stud:tip", null]), prefix));
      }
      const holes: [number, number, boolean][] = through ? [[0, L, false]] : male ? [[L - deep, L, true]] : [[L - deep, L, true], [0, deep, false]];
      for (const [z0, z1] of holes) body = cut(ctx, body, boreTool(ctx, frame, bore, z0, z1, prefix));
      if (!modelled) return body;
      holes.forEach(([z0, z1, fromHi], i) => { body = tapped(ctx, body, frame, d, f.pitch, z0, z1, through ? true : fromHi, !through, `${prefix}:thread${i + 1}`); });
      if (male) {
        const form = form60(f.pitch);
        body = threadInto(ctx, { shape: body.shape, faces: toolFaces(ctx, body) }, {
          origin: frame.origin, dir: frame.normal, x: frame.x, radius: d / 2, lo: -stud, hi: 0, hole: false,
          pitch: f.pitch, starts: 1, left: false, depth: form.depth, majorFlat: form.majorFlat, minorFlat: form.minorFlat,
          major: d / 2, taper: 0, length: stud, fromHi: false, leadIn: form.depth, runout: f.pitch, prefix: `${prefix}:stud:thread`,
        }).result;
      }
      return body;
    };
    apply(ctx, copies(ctx, spots(ctx, p), build), p);
  },
});
