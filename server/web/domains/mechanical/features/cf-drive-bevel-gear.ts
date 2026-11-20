// cf-drive-bevel-gear.ts — Bevel gear (straight teeth): a gear on a cone, for shafts that cross.  The pitch
// cone comes from the two tooth counts and the shaft angle; "With its mate" makes the second gear too, in mesh,
// both cones meeting at the apex.
//
// The tooth: Tredgold's construction.  The involute tooth of the equivalent spur gear (pitch radius r / cos δ)
// is laid on the back cone at the large end, and every point of it is joined to the pitch apex by a straight
// line, so the tooth tapers to the apex as a cut bevel gear's does.  The module is the one at the large end.
//
// How it is built: the tooth outline is drawn on the back cone at the large end and again, smaller, at the
// small end; ruled faces between the two are the flanks, tips and roots (each a piece of a cone through the
// apex).  The ends of the teeth are ruled from each outline down to a circle on the same cone, and flat faces,
// the bore and the hub close the solid.  The faces are sewn: no boolean is involved.
//
// Names: `<id>:t<n>:a` / `:b`, `:tip`, `:root`; the large and small ends of the teeth `<id>:back:t<n>:…` and
// `<id>:front:t<n>:…`; `<id>:back`, `:front`, `:bore`, `:hub`, `:hub:end`; the mate's are `<id>:mate:…`, its
// body `<id>:mate`.
import { defineFeature } from "../core/feature";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import type { Vec3 } from "../core/geometry";
import { circleLoop, faceOf, Pen, polar, ruledBetween, sewSolid, wallOf, wire3, wireOf, type Loop, type NamedFace, type Space } from "../kernel/ops/cf-drive";
import { GEARS, halfAngle, moduleOf, num, placedDefaults, placedFields, positive, rad, SECTION, spaceOf, tipRadius, whole, type Placed, type Teeth } from "./_cf-drive";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BevelGearParams extends Placed {
  [key: string]: any;
  system: "module" | "dp"; module: number; dp: number; teeth: number; mateTeeth: number; shaftAngle: number; pressureAngle: number;
  width: number; bore: number; hubDiameter: number; hubLength: number; backlash: number; clearance: number; mate: boolean; mateBore: number;
}

interface Cone { z: number; delta: number; R: number; m: number; width: number; teeth: Teeth; bore: number; hubD: number; hubL: number }

/** One bevel gear in a space whose origin is the pitch apex and whose z points from the gear to the apex. */
function bevel(ctx: EvalContext, apex: Space, c: Cone, phase: number, prefix: string): NamedResult {
  const t = c.teeth, rv = t.r, cd = Math.cos(c.delta), sd = Math.sin(c.delta);
  const rf = rv - t.hf, { ra } = tipRadius(t), rbase = rv * Math.cos(t.alpha);
  const under = t.hf + 1.25 * c.m, inner = (c.R - c.width) / c.R;
  // a point of the equivalent spur gear (radius rho) at angle theta about the axis, on the back cone; `f` scales it towards the apex
  const radius = (rho: number) => c.R * sd + (rho - rv) * cd, height = (rho: number) => -c.R * cd + (rho - rv) * sd;
  const at = (rho: number, theta: number, f: number): Vec3 => [radius(rho) * f * Math.cos(theta), radius(rho) * f * Math.sin(theta), height(rho) * f];
  const rB = rv - under, sB = radius(rB), zB = height(rB), sD = sB * inner, zD = zB * inner;
  if (!(height(ra) * inner < -1e-6)) throw ctx.fail("The teeth would pass the apex of the cone. Use more teeth on the mate, or a smaller shaft angle.");
  const rb = c.bore / 2, rh = c.hubD > 0 && c.hubL > 0 ? c.hubD / 2 : 0, hubL = rh ? c.hubL : 0;
  if (!(sD > rb + 0.25 * c.m)) throw ctx.fail(`The bore (${c.bore} mm) leaves nothing under the teeth. Use a smaller bore, a smaller face width or more teeth.`);
  if (rh && !(rh > rb && rh <= sB)) throw ctx.fail(`The hub must be wider than the bore and no wider than the back of the gear (${(2 * sB).toFixed(2)} mm).`);
  // radii along a flank, by roll angle above the base circle and evenly below it
  const rhos: number[] = [];
  if (rf < rbase - 1e-9) { rhos.push(rf); if (rbase - rf > 0.2 * c.m) rhos.push((rf + rbase) / 2); }
  const from = Math.max(rbase, rf), N = 6, t0 = Math.sqrt(Math.max(0, (from / rbase) ** 2 - 1)), t1 = Math.sqrt(Math.max(0, (ra / rbase) ** 2 - 1));
  for (let i = 0; i <= N; i++) { const u = t0 + ((t1 - t0) * i) / N; rhos.push(i === 0 ? from : i === N ? ra : rbase * Math.sqrt(1 + u * u)); }
  const phi = (rho: number) => halfAngle(t, rho) / cd, step = (2 * Math.PI) / c.z;
  // the tooth outline at the large end (on the back cone) and the small end, and the circles under them
  const toothed = (f: number) => {
    const edges: { label: string; pts: Vec3[]; arc?: boolean }[] = [];
    for (let i = 0; i < c.z; i++) {
      const a = phase + i * step, n = `t${i + 1}`;
      edges.push({ label: `${n}:a`, pts: rhos.map((r) => at(r, a - phi(r), f)) });
      edges.push({ label: `${n}:tip`, pts: [at(ra, a - phi(ra), f), at(ra, a, f), at(ra, a + phi(ra), f)], arc: true });
      edges.push({ label: `${n}:b`, pts: rhos.slice().reverse().map((r) => at(r, a + phi(r), f)) });
      edges.push({ label: `${n}:root`, pts: [at(rf, a + phi(rf), f), at(rf, a + step / 2, f), at(rf, a + step - phi(rf), f)], arc: true });
    }
    return wire3(ctx, apex, edges);
  };
  const circle = (f: number): Loop => {
    const pen = new Pen(polar(sB * f, phase - phi(rf)));
    for (let i = 0; i < c.z; i++) {
      const a = phase + i * step, n = `t${i + 1}`;
      pen.arcAbout([0, 0], polar(sB * f, a - phi(ra)), `${n}:a`, true).arcAbout([0, 0], polar(sB * f, a + phi(ra)), `${n}:tip`, true)
        .arcAbout([0, 0], polar(sB * f, a + phi(rf)), `${n}:b`, true).arcAbout([0, 0], i === c.z - 1 ? pen.start : polar(sB * f, a + step - phi(rf)), `${n}:root`, true);
    }
    return pen.close("root");
  };
  const large = toothed(1), small = toothed(inner), backLoop = circle(1), frontLoop = circle(inner);
  const faces: NamedFace[] = [];
  faces.push(...ruledBetween(ctx, large, small, (l) => `${prefix}:${l}`));
  faces.push(...ruledBetween(ctx, large, wireOf(ctx, apex, backLoop, zB), (l) => `${prefix}:back:${l}`));
  faces.push(...ruledBetween(ctx, small, wireOf(ctx, apex, frontLoop, zD), (l) => `${prefix}:front:${l}`));
  const hole = rb > 0 ? [circleLoop(rb, "bore")] : [];
  faces.push({ face: faceOf(ctx, apex, backLoop, rh ? [circleLoop(rh, "hub")] : hole, zB).face, name: `${prefix}:back` });
  faces.push({ face: faceOf(ctx, apex, frontLoop, hole, zD).face, name: `${prefix}:front` });
  if (rh) {
    faces.push(...wallOf(ctx, apex, circleLoop(rh, "hub"), zB - hubL, hubL, () => `${prefix}:hub`));
    faces.push({ face: faceOf(ctx, apex, circleLoop(rh, "hub"), hole, zB - hubL).face, name: `${prefix}:hub:end` });
  }
  if (rb > 0) faces.push(...wallOf(ctx, apex, circleLoop(rb, "bore"), zB - hubL, zD - zB + hubL, () => `${prefix}:bore`));
  return sewSolid(ctx, faces, "gear");
}

export default defineFeature<BevelGearParams>({
  type: "cf-bevel-gear",
  title: "Bevel gear",
  icon: '<path class="f" d="M8 4h8l5 13H3z"/><path d="M8 4h8l5 13H3zM3 17v3h18v-3M9.5 4L6.5 17M12 4v13M14.5 4l3 13"/>',
  hint: "A straight bevel gear for crossing shafts, alone or with its mate in mesh",
  keywords: "bevel gear miter mitre gear cone gear angle gear right angle straight bevel",
  toolbarSection: SECTION, toolbarMenu: GEARS, toolbarOrder: 15, toolbarKeep: 0,
  defaults: () => ({ system: "module", module: 2, dp: 12, teeth: 20, mateTeeth: 30, shaftAngle: 90, pressureAngle: 20, width: 8, bore: 6, hubDiameter: 0, hubLength: 0, backlash: 0, clearance: 0.25, mate: false, mateBore: 8, ...placedDefaults() }),
  schema: [
    { key: "system", label: "Size by", kind: "enum", options: [{ value: "module", label: "Module" }, { value: "dp", label: "Diametral pitch" }] },
    { key: "module", label: "Module", kind: "number", unit: "mm", min: 0.05, step: 0.25, hint: "At the large end of the teeth.", visible: (p) => p.system !== "dp" },
    { key: "dp", label: "Diametral pitch", kind: "number", unit: "none", min: 0.1, step: 1, visible: (p) => p.system === "dp" },
    { key: "teeth", label: "Teeth", kind: "number", unit: "none", min: 6, max: 200, step: 1 },
    { key: "mateTeeth", label: "Mate's teeth", kind: "number", unit: "none", min: 6, max: 200, step: 1, hint: "With the shaft angle it sets the cone: equal counts at 90° make a mitre gear." },
    { key: "shaftAngle", label: "Shaft angle", kind: "number", unit: "deg", min: 30, max: 150, step: 5 },
    { key: "pressureAngle", label: "Pressure angle", kind: "number", unit: "deg", min: 10, max: 35, step: 0.5 },
    { key: "width", label: "Face width", kind: "number", unit: "mm", min: 0.1, step: 1, hint: "Along the cone; usually no more than a third of the cone distance." },
    { key: "bore", label: "Bore", kind: "number", unit: "mm", min: 0, step: 1 },
    { key: "hubDiameter", label: "Hub diameter", kind: "number", unit: "mm", min: 0, step: 1, hint: "0 for no hub." },
    { key: "hubLength", label: "Hub length", kind: "number", unit: "mm", min: 0, step: 1, visible: (p) => Number(p.hubDiameter) > 0 },
    { key: "mate", label: "With its mate", kind: "boolean", hint: "Also make the mating gear, in mesh, as a second body." },
    { key: "mateBore", label: "Mate's bore", kind: "number", unit: "mm", min: 0, step: 1, visible: (p) => !!p.mate },
    { key: "backlash", label: "Backlash", kind: "number", unit: "mm", min: 0, step: 0.02 },
    { key: "clearance", label: "Root clearance", kind: "number", unit: "none", min: 0, max: 0.5, step: 0.05 },
    ...placedFields,
  ],
  evaluate(ctx: EvalContext, p: BevelGearParams) {
    const id = ctx.feature.id;
    const m = moduleOf(ctx, p);
    const z1 = whole(ctx, p.teeth, "The number of teeth", 6, 200), z2 = whole(ctx, p.mateTeeth, "The mate's number of teeth", 6, 200);
    const sigma = rad(num(p.shaftAngle, 90));
    if (!(sigma >= rad(30) && sigma <= rad(150))) throw ctx.fail("The shaft angle must be between 30° and 150°.");
    const alpha = rad(num(p.pressureAngle, 20));
    if (!(alpha >= rad(10) && alpha <= rad(35))) throw ctx.fail("The pressure angle must be between 10° and 35°.");
    const width = positive(ctx, p.width, "The face width");
    const d1 = Math.atan2(Math.sin(sigma), z2 / z1 + Math.cos(sigma)), d2 = sigma - d1;
    if (!(d1 > rad(3) && d1 < rad(85) && d2 > rad(3) && d2 < rad(85))) throw ctx.fail("These tooth counts and shaft angle make a cone too flat or too sharp to build. Bring the tooth counts closer together.");
    const R = (m * z1) / (2 * Math.sin(d1));
    if (!(width < 0.6 * R)) throw ctx.fail(`The face width must be less than ${(0.6 * R).toFixed(2)} mm (0.6 of the cone distance, ${R.toFixed(2)} mm).`);
    if (width > R / 3 + 1e-9) ctx.warn(`The face width is more than a third of the cone distance (${(R / 3).toFixed(2)} mm): the small end of the teeth gets thin.`);
    const c = Math.max(0, num(p.clearance, 0.25));
    const cone = (z: number, delta: number, bore: number, hubD: number, hubL: number): Cone => ({
      z, delta, R, m, width, bore: Math.max(0, num(bore)), hubD: num(hubD), hubL: num(hubL),
      teeth: { z: z / Math.cos(delta), r: (m * z) / 2 / Math.cos(delta), alpha, ha: m, hf: m * (1 + c), s: (Math.PI * m) / 2 - Math.max(0, num(p.backlash)), fillet: 0 },
    });
    const c1 = cone(z1, d1, p.bore, p.hubDiameter, p.hubLength);
    // the gear rests on the plane: its back (or its hub's end) at height 0, the apex above
    const under = c1.teeth.hf + 1.25 * m;
    const lowest = -R * Math.cos(d1) - under * Math.sin(d1) - (c1.hubD > 0 ? c1.hubL : 0);
    const apex = spaceOf(ctx, p).at([0, 0, -lowest]);
    const g1 = bevel(ctx, apex, c1, 0, id);
    ctx.addBody(g1.shape, g1.names);
    if (p.mate) {
      // the mate's axis leans over by the shaft angle; the cones touch along the line at angle 0 of this gear, which is angle 180° of the mate, where a gap of the mate meets this gear's tooth
      const g2 = bevel(ctx, apex.rotY(-sigma), cone(z2, d2, p.mateBore, 0, 0), Math.PI + Math.PI / z2, `${id}:mate`);
      ctx.addBody(g2.shape, g2.names, { suffix: "mate", name: `Mate (${ctx.feature.name})` });
    }
  },
});
