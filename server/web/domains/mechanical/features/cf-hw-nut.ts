// cf-hw-nut.ts — Nut: a metric nut by kind and size: hexagon (ISO 4032), self-locking with a collar (ISO 10511 /
// DIN 985), square (DIN 562, thin) or wing (the proportions of DIN 315).  The hole is drilled to the thread's
// minor diameter, or carries a modelled helical thread.  It lies on the picked plane, its axis along the normal.
//
// Names: `<id>:flat`, `:top`, `:bottom`, `:chamfer`, `:bore`, `:collar`, `:wing`, and the thread's when modelled.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { apply, copies, cut, extruded, fuse, poly, revolved, spots, type V2 } from "../kernel/ops/cf-hw";
import { boreTool, hexPrism, minorOf, tapped } from "../kernel/ops/cf-hw-fasteners";
import { add, scale, type Frame } from "../core/geometry";
import type { NamedResult } from "../kernel/occ";
import { fastenerOf, HW_SECTION, MENU_THREADS, resultFields, sizeField, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface NutParams { [key: string]: any; kind: "hex" | "nyloc" | "square" | "wing"; size: string; thread: "plain" | "modelled"; operation: "new" | "add"; targets: string[] }

export default defineFeature<NutParams>({
  type: "cf-hw-nut",
  title: "Nut",
  icon: '<path class="f" d="M7.5 4h9l4.5 8-4.5 8h-9L3 12z"/><path d="M7.5 4h9l4.5 8-4.5 8h-9L3 12z"/><circle cx="12" cy="12" r="3.6"/>',
  hint: "Make a metric nut: hex, self-locking (nyloc), square or wing, by size",
  keywords: "nut generator hex nyloc nylock lock square wing fastener m3 m4 m5 m6 m8 hardware",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_THREADS, toolbarOrder: 21, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), kind: "hex", size: "M6", thread: "plain", operation: "new", targets: [] }),
  schema: [
    { key: "kind", label: "Kind", kind: "enum", options: [{ value: "hex", label: "Hex" }, { value: "nyloc", label: "Nyloc" }, { value: "square", label: "Square" }, { value: "wing", label: "Wing" }] },
    sizeField(),
    { key: "thread", label: "Thread", kind: "enum", options: [{ value: "plain", label: "Plain" }, { value: "modelled", label: "Modelled" }], hint: "Plain: a hole of the minor diameter. Modelled: the real helical thread (slower)." },
    ...whereFields({ noun: "nut" }),
    ...resultFields,
  ],

  evaluate(ctx: EvalContext, p: NutParams) {
    const f = fastenerOf(p.size);
    if (!f) throw ctx.fail(`The size table has no ${p.size}.`);
    const d = f.d, bore = minorOf(d, f.pitch);
    const build = (frame: Frame, prefix: string): NamedResult => {
      let body: NamedResult, height: number, threadTop: number;
      if (p.kind === "square") {
        height = threadTop = f.squareM;
        body = hexPrism(ctx, frame, f.s, 0, height, prefix, "top", 4);
      } else if (p.kind === "nyloc") {
        // two thirds hexagon, the rest a round collar that holds the nylon ring; the thread stops under the ring
        height = f.nylocM; threadTop = f.nutM * 0.85;
        const hex = hexPrism(ctx, frame, f.s, 0, height * 0.68, prefix, "none");
        const rc = f.s * 0.46, e = Math.min(0.5, height * 0.08);
        const collar = revolved(ctx, frame, poly([[0, height * 0.6], [rc, height * 0.6], [rc, height - e], [rc - e, height], [0, height]] as V2[], [null, "collar", "collar:edge", "top", null]), prefix);
        body = fuse(ctx, hex, collar);
      } else if (p.kind === "wing") {
        // a boss with two wings, in the proportions of DIN 315
        height = threadTop = 0.8 * d;
        const rb = d, span = 2.6 * d, tall = 2.2 * d, thick = Math.max(1, 0.28 * d);
        const boss = revolved(ctx, frame, poly([[0, 0], [rb, 0], [rb * 0.82, height], [0, height]] as V2[], ["bottom", "boss", "top", null]), prefix);
        body = boss;
        for (const side of [1, -1]) {
          // each wing is a plate standing in the plane of the axis
          const wf: Frame = { origin: add(frame.origin, scale(frame.y, -thick / 2)), x: scale(frame.x, side), y: frame.normal, normal: frame.y };
          const outline = poly([[rb * 0.55, 0.05 * height], [span * 0.72, tall * 0.5], [span, tall * 0.72], [span, tall], [span * 0.62, tall], [rb * 0.55, height * 0.95]] as V2[], "wing");
          body = fuse(ctx, body, extruded(ctx, wf, outline, [], 0, thick, `${prefix}:wing${side > 0 ? 1 : 2}`));
        }
      } else {
        height = threadTop = f.nutM;
        body = hexPrism(ctx, frame, f.s, 0, height, prefix, "both");
      }
      body = cut(ctx, body, boreTool(ctx, frame, bore, 0, threadTop, prefix));
      // above the thread a self-locking nut is open to the bolt's full diameter
      if (threadTop < height - 1e-6) body = cut(ctx, body, boreTool(ctx, frame, d * 1.02, threadTop, height, `${prefix}:ring`));
      if (p.thread === "modelled") body = tapped(ctx, body, frame, d, f.pitch, 0, threadTop, false, false, `${prefix}:thread`);
      return body;
    };
    apply(ctx, copies(ctx, spots(ctx, p), build), p);
  },
});
