// sm-modify-joint.ts — Modify joint: change a bend's radius and K-factor, or turn it into a rip (closed up to
// the minimal gap, or left open).
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { commit } from "../kernel/ops/sheetmetal";
import { modifyJoint } from "../kernel/ops/sheetmetal-ops";
import { bendFields, bendPicks, kOf, radiusOf, SM_SECTION } from "./_sm";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ModifyJointParams { [key: string]: any; bends: GeomRef[]; jointType: "bend" | "rip"; close: boolean; useModelRadius: boolean; radius: number; useModelK: boolean; kFactor: number }

export default defineFeature<ModifyJointParams>({
  type: "sm-modify-joint",
  title: "Modify joint",
  icon: '<path d="M4 19V8h3v8h10v3H4"/><path class="t" d="M14 4l6 6M20 4l-6 6"/>',
  hint: "Change a bend's radius or K-factor, or turn it into a rip",
  keywords: "modify joint bend radius rip change sheet metal",
  toolbarSection: SM_SECTION, toolbarOrder: 31, toolbarMenu: "Make joint", toolbarKeep: 40,
  defaults: () => ({ bends: [], jointType: "bend", close: true, useModelRadius: false, radius: 2, useModelK: true, kFactor: 0.45 }),
  schema: [
    { key: "bends", label: "Bends", kind: "refs", of: ["face"], hint: "The curved faces of the bends." },
    { key: "jointType", label: "Joint", kind: "enum", options: [{ value: "bend", label: "Bend" }, { value: "rip", label: "Rip" }] },
    { key: "close", label: "Close the corner", kind: "boolean", hint: "Grow the walls to meet, the minimal gap apart.", visible: (p) => p.jointType === "rip" },
    ...bendFields.map((f) => ({ ...f, visible: (p: any) => p.jointType !== "rip" && (!f.visible || f.visible(p)) })),
  ],

  evaluate(ctx: EvalContext, p: ModifyJointParams) {
    let { model: m, bends } = bendPicks(ctx, p.bends);
    for (const b of bends) m = modifyJoint(ctx.k, m, b.id, p.jointType === "rip" ? { type: "rip", close: p.close !== false } : { type: "bend", radius: radiusOf(m, p), k: kOf(m, p) }, ctx.own);
    commit(ctx, m);
  },
});
