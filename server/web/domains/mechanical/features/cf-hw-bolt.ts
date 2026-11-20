// cf-hw-bolt.ts — Bolt: a metric screw by head, size and length: hexagon head (ISO 4014/4017), socket head cap
// (ISO 4762), button head (ISO 7380) or countersunk (ISO 10642), M2 to M24.  The thread is a plain cylinder of
// the major diameter, or modelled as a true helical thread.
//
// It stands on the picked plane where it would be screwed in: the head on the surface, the shank going into it
// (a countersunk head lies flush in the surface).  Put Fastener holes at the same points for the holes.
//
// Names: `<id>:head:flat`, `:head:top`, `:head:side`, `:head:seat`, `:head:cone`, `:key:socket`, `<id>:shank`,
// `<id>:tip`, and `<id>:thread:crest`, … when modelled.  With picked locations each name has the location in it.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { apply, copies, spots } from "../kernel/ops/cf-hw";
import { screwSolid, type HeadKind } from "../kernel/ops/cf-hw-fasteners";
import { fastenerOf, HW_SECTION, MENU_THREADS, resultFields, sizeField, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BoltParams { [key: string]: any; head: HeadKind; size: string; length: number; threaded: number; thread: "plain" | "modelled"; operation: "new" | "add"; targets: string[] }

export default defineFeature<BoltParams>({
  type: "cf-hw-bolt",
  title: "Bolt",
  icon: '<path class="f" d="M6 3h12v5H6zM10 8h4v12l-2 1.5-2-1.5z"/><path d="M6 3h12v5H6zM10 8v12l2 1.5 2-1.5V8M10 3v5M14 3v5"/><path class="t" d="M10 12.5l4-1.2M10 15.5l4-1.2M10 18.5l4-1.2"/>',
  hint: "Make a metric bolt or screw: hex, socket cap, button or countersunk head, by size and length",
  keywords: "bolt screw generator fastener hex socket head cap shcs button countersunk flat machine screw m3 m4 m5 m6 m8 hardware",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_THREADS, toolbarOrder: 20, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), head: "socket", size: "M6", length: 20, threaded: 0, thread: "plain", operation: "new", targets: [] }),
  schema: [
    { key: "head", label: "Head", kind: "enum", options: [{ value: "hex", label: "Hex" }, { value: "socket", label: "Socket" }, { value: "button", label: "Button" }, { value: "flat", label: "Flat" }] },
    sizeField(),
    { key: "length", label: "Length", kind: "number", unit: "mm", min: 1, step: 5, hint: "From under the head; a flat head is measured over the head." },
    { key: "thread", label: "Thread", kind: "enum", options: [{ value: "plain", label: "Plain" }, { value: "modelled", label: "Modelled" }], hint: "Plain: a cylinder of the major diameter. Modelled: the real helical thread (slower)." },
    { key: "threaded", label: "Thread length", kind: "number", unit: "mm", min: 0, step: 5, hint: "0 threads the whole shank.", visible: (p) => p.thread === "modelled" },
    ...whereFields({ noun: "bolt" }),
    ...resultFields,
  ],

  evaluate(ctx: EvalContext, p: BoltParams) {
    const f = fastenerOf(p.size);
    if (!f) throw ctx.fail(`The size table has no ${p.size}.`);
    if (!(p.length > 0)) throw ctx.fail("The length must be more than zero.");
    const head = (["hex", "socket", "button", "flat"].includes(p.head) ? p.head : "socket") as HeadKind;
    const dims = {
      hex: { headSize: f.s, headHeight: f.hexK, key: 0, keyDepth: 0 },
      socket: { headSize: f.capD, headHeight: f.d, key: f.key, keyDepth: f.keyT },
      button: { headSize: f.buttonD, headHeight: f.buttonK, key: f.buttonKey, keyDepth: f.buttonT },
      flat: { headSize: f.flatD, headHeight: f.flatK, key: f.flatKey, keyDepth: f.flatT },
    }[head];
    const screw = { head, d: f.d, pitch: f.pitch, length: p.length, ...dims, threaded: Math.max(0, Number(p.threaded) || 0), modelled: p.thread === "modelled" };
    apply(ctx, copies(ctx, spots(ctx, p), (frame, prefix) => screwSolid(ctx, frame, screw, prefix)), p);
  },
});
