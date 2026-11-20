// cf-hw-oring.ts — O-ring: the ring itself, as a body, by AS568 / ISO 3601-1 dash number or by its two
// dimensions.  It lies on the picked plane about the picked point.  Give the diameter it is stretched over to
// see it as installed: the ring grows to that inside diameter and its section thins so that its volume stays.
//
// Names: `<id>:ring`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { ShapeIndex } from "../kernel/occ";
import { apply, spots, type Tool } from "../kernel/ops/cf-hw";
import { HW_SECTION, MENU_ENCLOSURES, oringOf, resultFields, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ORingParams { [key: string]: any; dash: string; inner: number; section: number; installed: number; operation: "new" | "add"; targets: string[] }

export default defineFeature<ORingParams>({
  type: "cf-hw-oring",
  title: "O-ring",
  icon: '<ellipse class="f" cx="12" cy="12" rx="9" ry="6"/><ellipse cx="12" cy="12" rx="9" ry="6"/><ellipse cx="12" cy="12" rx="5.2" ry="2.8"/>',
  hint: "Make an O-ring body by AS568 / ISO 3601 dash number, or by inside diameter and cross-section",
  keywords: "o-ring oring seal ring torus as568 iso 3601 dash rubber gasket body",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_ENCLOSURES, toolbarOrder: 41, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), dash: "214", inner: 25, section: 3.5, installed: 0, operation: "new", targets: [] }),
  schema: [
    { key: "dash", label: "Dash number", kind: "text", hint: "An AS568 size such as 214. Leave empty to give the two dimensions." },
    { key: "inner", label: "Inside Ø", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => !String(p.dash || "").trim() },
    { key: "section", label: "Cross-section Ø", kind: "number", unit: "mm", min: 0.1, step: 0.1, visible: (p) => !String(p.dash || "").trim() },
    { key: "installed", label: "Stretched to Ø", kind: "number", unit: "mm", min: 0, step: 1, hint: "The diameter it is fitted over; 0 shows it free." },
    ...whereFields({ noun: "ring" }),
    ...resultFields,
  ],

  evaluate(ctx: EvalContext, p: ORingParams) {
    const oc = ctx.oc as any, k = ctx.k;
    const typed = String(p.dash || "").trim();
    let inner = Number(p.inner), cs = Number(p.section);
    if (typed) {
      const ring = oringOf(typed);
      if (!ring) throw ctx.fail(`AS568 has no size -${typed.replace(/[^0-9]/g, "")}. The table has -001 to -050, -102 to -178, -201 to -278, -309 to -381 and -425 to -460.`);
      inner = ring.id; cs = ring.cs;
    }
    if (!(inner > 0) || !(cs > 0)) throw ctx.fail("The ring's inside diameter and cross-section must be more than zero.");
    const fitted = Number(p.installed) || 0;
    if (fitted > 0) {
      // the same volume of rubber: (inside + section) × section² stays
      const volume = (inner + cs) * cs * cs;
      let c = cs;
      for (let i = 0; i < 30; i++) c = Math.sqrt(volume / (fitted + c));
      inner = fitted; cs = c;
    }
    const tools: Tool[] = spots(ctx, p).map((s) => {
      const f = s.frame;
      const ax = ctx.tmp(new oc.gp_Ax2(ctx.tmp(k.pnt([f.origin[0] + f.normal[0] * cs / 2, f.origin[1] + f.normal[1] * cs / 2, f.origin[2] + f.normal[2] * cs / 2])), ctx.tmp(k.dir(f.normal)), ctx.tmp(k.dir(f.x))));
      const mk = ctx.tmp(new oc.BRepPrimAPI_MakeTorus(ax, (inner + cs) / 2, cs / 2));
      const shape = ctx.own(mk.Shape());
      const named = new ShapeIndex<string>(k);
      for (const face of k.sub(shape, "face")) named.add(face, `${s.key === "0" ? ctx.feature.id : `${ctx.feature.id}:${s.key}`}:ring`);
      return { shape, names: (face) => named.get(face) ?? null, suffix: s.key };
    });
    apply(ctx, tools, p);
  },
});
