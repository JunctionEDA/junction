// _cf-hw-thread.ts — what the two thread features (cf-hw-thread.ts on a shaft, cf-hw-thread-internal.ts in a
// hole) share: their fields and their evaluation.  The thread itself is kernel/ops/cf-hw-thread.ts.
import type { ParamField } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { cylinderOf } from "../kernel/ops/cf-hw";
import { threadEnds, threadOn } from "../kernel/ops/cf-hw-thread";
import { chosenThread, form60, threadDefaults, threadFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ThreadParams {
  [key: string]: any;
  face: GeomRef | null;
  standard: string; pitch: number;
  full: boolean; length: number; flip: boolean;
  leadIn: boolean; runout: boolean; left: boolean; starts: number;
  /** taken off the diameter of a thread on a shaft, added to one in a hole: room for paint, plating or a printer */
  allowance: number;
}

export const threadParamDefaults = (): ThreadParams => ({ face: null, ...threadDefaults(true), full: true, length: 10, flip: false, leadIn: true, runout: true, left: false, starts: 1, allowance: 0 });

export const threadSchema = (internal: boolean): ParamField[] => [
  { key: "face", label: internal ? "Hole" : "Cylinder", kind: "refs", of: ["face"], single: true, hint: internal ? "The wall of a round hole, drilled to the tap drill size." : "The round face of a shaft or boss, at the thread's major diameter." },
  ...threadFields(true),
  { key: "full", label: "Whole length", kind: "boolean" },
  { key: "length", label: "Length", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => !p.full },
  { key: "flip", label: "Start at the other end", kind: "boolean" },
  { key: "leadIn", label: internal ? "Countersunk start" : "Chamfered start", kind: "boolean", hint: "A 45° lead-in as deep as the thread." },
  { key: "runout", label: "Run-out", kind: "boolean", hint: "Fade the thread out over one turn where it stops short of the end, or against a shoulder." },
  { key: "left", label: "Left-handed", kind: "boolean" },
  { key: "starts", label: "Starts", kind: "number", unit: "none", min: 1, max: 12, step: 1 },
  { key: "allowance", label: "Allowance", kind: "number", unit: "mm", min: 0, step: 0.05, hint: internal ? "Added to the thread's diameter: room for plating, paint or a 3D printer (0.2 to 0.4 for most printers)." : "Taken off the thread's diameter: room for plating, paint or a 3D printer (0.2 to 0.4 for most printers)." },
];

export function evaluateThread(ctx: EvalContext, p: ThreadParams, internal: boolean): void {
  const cyl = cylinderOf(ctx, p.face, internal ? "the wall of a round hole" : "the round face of a shaft");
  if (cyl.hole !== internal) {
    throw ctx.fail(internal ? "That is a shaft, not a hole. Use Thread for a thread on the outside." : "That is a hole, not a shaft. Use Internal thread for a thread in a hole.");
  }
  const chosen = chosenThread(p, cyl.radius * 2, internal);
  if (typeof chosen === "string") throw ctx.fail(chosen);
  const starts = Math.round(Number(p.starts) || 1);
  if (starts < 1 || starts > 12) throw ctx.fail("The number of starts must be between 1 and 12.");
  const allowance = Math.max(0, Number(p.allowance) || 0);
  const form = form60(chosen.pitch);
  const span = cyl.hi - cyl.lo;
  const length = p.full ? span : Number(p.length);
  if (!(length > 0)) throw ctx.fail("The thread's length must be more than zero.");
  if (length > span + 1e-6) ctx.warn(`The ${internal ? "hole" : "cylinder"} is ${Math.round(span * 100) / 100} mm long: the thread stops at its end.`);
  const ends = threadEnds(ctx, cyl, !!p.flip, length);
  // a shaft is threaded at its own diameter when the size was fitted to it; a hole is opened up to the thread's
  const major = chosen.d / 2 + (internal ? allowance / 2 : -allowance / 2);
  threadOn(ctx, cyl, {
    pitch: chosen.pitch, starts, left: !!p.left, depth: form.depth, majorFlat: form.majorFlat, minorFlat: form.minorFlat,
    major, taper: 0, length, fromHi: ends.fromHi,
    leadIn: p.leadIn ? form.depth : 0, runout: p.runout && ends.fades ? chosen.pitch * starts : 0,
  });
}
