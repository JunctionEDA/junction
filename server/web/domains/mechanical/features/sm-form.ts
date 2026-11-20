// sm-form.ts — Form: press a dimple or a louver into a sheet metal wall at sketch points (or vertices) on one
// of its faces.  The form is part of the definition: it moves with its wall and is marked in the flat pattern.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { commit, type SMModel } from "../kernel/ops/sheetmetal";
import type { RefTarget } from "./_refs";
import { pickedPoints, SM_SECTION, wallAtPoint } from "./_sm";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FormParams { [key: string]: any; points: RefTarget[]; formType: "dimple" | "louver"; size: number; width: number; height: number; angle: number; flip: boolean }

export default defineFeature<FormParams>({
  type: "sm-form",
  title: "Form",
  icon: '<path d="M2 17h5l2-5h6l2 5h5"/><path class="t" d="M9 12l-2 5M15 12l2 5"/>',
  hint: "Press a dimple or a louver into a sheet metal wall at sketch points",
  keywords: "form dimple louver emboss stamp press sheet metal",
  toolbarSection: SM_SECTION, toolbarOrder: 25, toolbarKeep: 42,
  defaults: () => ({ points: [], formType: "dimple", size: 10, width: 4, height: 2, angle: 0, flip: false }),
  schema: [
    { key: "points", label: "Locations", kind: "refs", of: ["vertex"], sketch: true, hint: "Sketch points on a wall's face." },
    { key: "formType", label: "Form", kind: "enum", options: [{ value: "dimple", label: "Dimple" }, { value: "louver", label: "Louver" }] },
    { key: "size", label: "Diameter / length", kind: "number", unit: "mm", min: 0.1, step: 1 },
    { key: "width", label: "Width", kind: "number", unit: "mm", min: 0.1, step: 0.5, visible: (p) => p.formType === "louver" },
    { key: "height", label: "Height", kind: "number", unit: "mm", min: 0.01, step: 0.5 },
    { key: "angle", label: "Orientation", kind: "number", unit: "deg", step: 15, visible: (p) => p.formType === "louver" },
    { key: "flip", label: "Opposite direction", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: FormParams) {
    const pts = pickedPoints(ctx, p.points);
    if (!pts.length) throw ctx.fail("Pick sketch points on a wall where the forms go.");
    if (!(p.size > 0) || !(p.height > 0)) throw ctx.fail("The form's size and height must be more than zero.");
    const changed = new Map<string, SMModel>();
    pts.forEach((pt, i) => {
      const hit = wallAtPoint(ctx, pt);
      const m = changed.get(hit.model.id) || hit.model;
      const up = hit.top !== !!p.flip;
      changed.set(m.id, { ...m, seq: m.seq + 1, forms: [...m.forms, { id: `${ctx.feature.id}.f${i}`, wall: hit.wall.id, at: hit.at, turn: p.angle || 0, up, type: p.formType === "louver" ? "louver" : "dimple", size: p.size, width: p.width || 4, height: p.height }] });
    });
    for (const m of changed.values()) commit(ctx, m);
  },
});
