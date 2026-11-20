// cf-drive-timing-pulley.ts — Timing belt pulley: GT2, GT3, HTD 3M / 5M / 8M and T2.5 / T5 / T10 profiles, with
// flanges, bore, keyway and hub.  The pitch diameter is teeth × pitch / π and the outside diameter is that less
// twice the profile's pitch line differential; the grooves are the belt's tooth (_cf-drive-data.ts BELTS,
// _cf-drive-path.ts toothShape), widened and deepened by the fit clearance.
//
// It stands on the plane: lower flange, teeth, upper flange, hub.  A groove is centred on the plane's x axis.
//
// Names: `<id>:g<n>:a` / `:b` / `:floor` / `:ra` / `:rb` (groove n), `:land` (the land after it), `<id>:bottom`,
// `<id>:top`, `<id>:bore`, `<id>:key:…`, `<id>:flange:rim` / `:bottom` / `:top`, `<id>:flange2:…`, `<id>:hub:side` / `:top`.
import { defineFeature } from "../core/feature";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import { circleLoop, Pen, rot2, stackOf, type Layer, type Loop, type P2 } from "../kernel/ops/cf-drive";
import { boreDefaults, boreFields, boreOf, DRIVES, finish, makeField, num, placedDefaults, placedFields, positive, SECTION, spaceOf, wheel, whole, type Bore, type Placed } from "./_cf-drive";
import { BELTS } from "./_cf-drive-data";
import { grooveOn, toothShape } from "./_cf-drive-path";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TimingPulleyParams extends Bore, Placed { [key: string]: any; profile: string; teeth: number; beltWidth: number; flanges: "both" | "one" | "none"; flangeHeight: number; flangeThickness: number; clearance: number; operation: string }

/** The outline of a pulley's teeth: `z` grooves in a circle of the outside radius. */
export function pulleyLoop(profile: string, z: number, clearance: number): { loop: Loop; outside: number; root: number } {
  const belt = BELTS[profile], tooth = toothShape(belt.tooth, clearance);
  const outside = (z * belt.pitch) / (2 * Math.PI) - belt.pld, step = (2 * Math.PI) / z;
  // the groove stands square to its centre line, as deep there as the tooth is high; its corners end on the outside circle
  const g = grooveOn(tooth, outside);
  const place = (a: number) => (q: P2): P2 => rot2([outside + q[1], q[0]], a);
  const pen = new Pen(place(0)(g.start));
  for (let i = 0; i < z; i++) {
    const n = `g${i + 1}`;
    pen.append(g.start, g.segs, place(i * step), (l) => `${n}:${l}`);
    pen.arcAbout([0, 0], i === z - 1 ? pen.start : place((i + 1) * step)(g.start), `${n}:land`, true);
  }
  return { loop: pen.close("land"), outside, root: outside - tooth.h };
}

export default defineFeature<TimingPulleyParams>({
  type: "cf-timing-pulley",
  title: "Timing pulley",
  icon: '<path class="f" d="M5 6h14v12H5z"/><path d="M3 4h18v2H3zM3 18h18v2H3zM5 6v12M19 6v12M8.5 6v12M12 6v12M15.5 6v12"/>',
  hint: "A toothed belt pulley: GT2, GT3, HTD or T profile, with flanges, bore and hub",
  keywords: "timing pulley belt pulley toothed pulley GT2 GT3 HTD T5 T2.5 T10 synchronous sprocket 3M 5M 8M",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 10, toolbarKeep: 0,
  defaults: () => ({ profile: "GT2", teeth: 20, beltWidth: 6, flanges: "both", flangeHeight: 1.5, flangeThickness: 1, clearance: 0.05, ...boreDefaults(5), ...placedDefaults(), operation: "new" }),
  schema: [
    { key: "profile", label: "Profile", kind: "enum", options: Object.entries(BELTS).map(([value, b]) => ({ value, label: b.label })) },
    { key: "teeth", label: "Teeth", kind: "number", unit: "none", min: 8, max: 400, step: 1 },
    { key: "beltWidth", label: "Belt width", kind: "number", unit: "mm", min: 0.5, step: 1, hint: "The toothed part is a millimetre wider." },
    { key: "flanges", label: "Flanges", kind: "enum", options: [{ value: "both", label: "Both" }, { value: "one", label: "One" }, { value: "none", label: "None" }] },
    { key: "flangeHeight", label: "Flange height", kind: "number", unit: "mm", min: 0.1, step: 0.5, hint: "How far a flange stands above the teeth.", visible: (p) => p.flanges !== "none" },
    { key: "flangeThickness", label: "Flange thickness", kind: "number", unit: "mm", min: 0.1, step: 0.5, visible: (p) => p.flanges !== "none" },
    ...boreFields,
    { key: "clearance", label: "Fit clearance", kind: "number", unit: "mm", min: 0, max: 0.5, step: 0.05, hint: "Widens and deepens the grooves, for printed pulleys." },
    ...placedFields, makeField,
  ],
  evaluate(ctx: EvalContext, p: TimingPulleyParams) {
    const id = ctx.feature.id;
    const belt = BELTS[p.profile];
    if (!belt) throw ctx.fail("Pick a belt profile.");
    const z = whole(ctx, p.teeth, "The number of teeth", 8, 400);
    const width = positive(ctx, p.beltWidth, "The belt width") + 1;
    const clearance = Math.min(0.5, Math.max(0, num(p.clearance)));
    const { loop, outside, root } = pulleyLoop(p.profile, z, clearance);
    if (!(root > 0.3 * belt.pitch)) throw ctx.fail("So few teeth leave nothing inside the grooves. Use more teeth.");
    const sp = spaceOf(ctx, p);
    const flanges = p.flanges === "none" ? 0 : p.flanges === "one" ? 1 : 2;
    let body: NamedResult;
    if (!flanges) body = wheel(ctx, sp, loop, { thickness: width, inside: root, prefix: id }, p);
    else {
      const tf = positive(ctx, p.flangeThickness, "The flange thickness"), rf = outside + positive(ctx, p.flangeHeight, "The flange height");
      const hubD = num(p.hubDiameter), hubL = hubD > 0 ? num(p.hubLength) : 0, rh = hubL > 0 ? hubD / 2 : 0;
      if (rh && rh > rf) throw ctx.fail("The hub must be no wider than the flange.");
      const bore = boreOf(ctx, p, rh ? Math.min(rh, root) : root);
      const layers: Layer[] = [{ loop: circleLoop(rf, "rim"), h: tf, size: 3, name: "flange" }, { loop, h: width, size: 2 }];
      if (flanges === 2) layers.push({ loop: circleLoop(rf, "rim"), h: tf, size: 3, name: "flange2" });
      if (rh) layers.push({ loop: circleLoop(rh, "side"), h: hubL, size: flanges === 2 ? 1 : rh > outside ? 2.5 : 1, name: "hub" });
      if (rh && flanges === 1 && rh > root && rh < outside + 1e-6) throw ctx.fail("On the side without a flange the hub must fit inside the grooves or be wider than the teeth.");
      body = stackOf(ctx, sp, layers, bore ? [bore] : [], 0, id);
    }
    finish(ctx, [body], p.operation);
  },
});
