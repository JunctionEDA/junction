// thicken.ts — the Thicken feature: give faces thickness, to one side, the other, or both, as a new body, added
// to the bodies it touches, or removed from them.  Faces that join along edges are thickened as one sheet.
//
// Names: the faces of the new solid are `<id>:new#<n>`; faces of bodies it is added to keep theirs.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { Body, EvalContext, Shape } from "../kernel/types";
import { combine, OPERATION_OPTIONS, type Operation, type Tool } from "../kernel/ops/combine";
import { thickenSheet } from "../kernel/ops/thicken";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ThickenParams { [key: string]: any; faces: GeomRef[]; thickness: number; thickness2: number; midplane: boolean; operation: Operation; targets: string[] }

export default defineFeature<ThickenParams>({
  type: "thicken",
  title: "Thicken",
  hint: "Give faces thickness: a solid from a surface.",
  keywords: "thick sheet surface offset solid wall",
  icon: '<path class="f" d="M3.5 15.5c5-6 12-6 17 0v-5c-5-6-12-6-17 0z"/><path d="M3.5 15.5c5-6 12-6 17 0v-5c-5-6-12-6-17 0z"/><path class="t" d="M12 2.5v3.5M12 13v8"/>',
  toolbarOrder: 26, toolbarSection: "solid", toolbarKeep: 46,
  defaults: () => ({ faces: [], thickness: 2, thickness2: 0, midplane: false, operation: "new", targets: [] }),
  schema: [
    { key: "operation", label: "Result", kind: "enum", options: OPERATION_OPTIONS },
    { key: "faces", label: "Faces to thicken", kind: "refs", of: ["face"], hint: "Faces that join along an edge are thickened as one sheet." },
    { key: "midplane", label: "Symmetric", kind: "boolean", hint: "Half the thickness to each side of the faces." },
    { key: "thickness", label: "Thickness", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "Along the faces' outward side." },
    { key: "thickness2", label: "Thickness 2", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "To the other side.", visible: (p) => !p.midplane },
    { key: "targets", label: "Bodies to change", kind: "bodies", hint: "Leave empty for every body.", visible: (p) => p.operation !== "new" },
  ],

  evaluate(ctx: EvalContext, p: ThickenParams) {
    if (!p.faces || !p.faces.length) throw ctx.fail("Pick the faces to thicken.");
    const t1 = Number(p.thickness) || 0, t2 = p.midplane ? 0 : Number(p.thickness2) || 0;
    if (t1 < 0 || t2 < 0 || !(t1 + t2 > 0)) throw ctx.fail("The thickness must be more than zero.");
    const front = p.midplane ? t1 / 2 : t1, back = p.midplane ? t1 / 2 : t2;
    const byBody = new Map<Body, Shape[]>();
    for (const ref of p.faces) {
      const r = ctx.resolve(ref);
      if (r.kind !== "face") throw ctx.fail("Pick faces to thicken.");
      byBody.set(r.body, [...(byBody.get(r.body) || []), r.shape]);
    }
    const tools: Tool[] = [];
    let n = 0;
    for (const faces of byBody.values()) {
      // one sheet when the faces join; else each on its own
      let solids: Shape[];
      try { solids = [thickenSheet(ctx, faces, front, back)]; }
      catch (e) { if (faces.length < 2) throw e; solids = faces.map((f) => thickenSheet(ctx, [f], front, back)); }
      for (const s of solids) tools.push({ shape: s, names: () => null, suffix: `s${++n}` });
    }
    combine(ctx, tools, p.operation || "new", p.targets);
  },
});
