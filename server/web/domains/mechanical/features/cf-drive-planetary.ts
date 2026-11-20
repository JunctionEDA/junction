// cf-drive-planetary.ts — Planetary gear set: a sun, its planets and the ring, as separate bodies in mesh.
// The ring has sun + 2 × planet teeth.  The planets can be spaced evenly only when (sun + ring) / planets is a
// whole number, and they must clear each other; the feature says so when they do not.  Every gear is turned so
// that the teeth mesh as placed: the sun has a tooth on the plane's x axis.
//
// Bodies: `<id>:sun`, `<id>:planet1` …, `<id>:ring`.  Faces: `<id>:sun:t<n>:a` and so on, as the spur gear's.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { circleLoop, prismOf } from "../kernel/ops/cf-drive";
import { boreOf, externalTeeth, GEARS, gearLoop, moduleOf, placedDefaults, placedFields, positive, SECTION, spaceOf, whole, type Placed } from "./_cf-drive";
import { internalSpaces } from "./cf-drive-internal-gear";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PlanetaryParams extends Placed {
  [key: string]: any;
  system: "module" | "dp"; module: number; dp: number; pressureAngle: number;
  sunTeeth: number; planetTeeth: number; planets: number; width: number; rim: number;
  sunBore: number; planetBore: number; backlash: number; clearance: number;
}

export default defineFeature<PlanetaryParams>({
  type: "cf-planetary",
  title: "Planetary gear set",
  icon: '<circle class="f" cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="9.5"/><circle class="s" cx="12" cy="12" r="2.6"/><circle cx="12" cy="6" r="2.4"/><circle cx="17.2" cy="15" r="2.4"/><circle cx="6.8" cy="15" r="2.4"/>',
  hint: "A sun gear, planets and ring gear in mesh, each a body",
  keywords: "planetary gear set epicyclic sun planet ring annulus gearbox reduction",
  toolbarSection: SECTION, toolbarMenu: GEARS, toolbarOrder: 20, toolbarKeep: 0,
  defaults: () => ({ system: "module", module: 1.5, dp: 16, pressureAngle: 20, sunTeeth: 18, planetTeeth: 15, planets: 3, width: 8, rim: 5, sunBore: 6, planetBore: 5, backlash: 0.05, clearance: 0.25, ...placedDefaults() }),
  schema: [
    { key: "system", label: "Size by", kind: "enum", options: [{ value: "module", label: "Module" }, { value: "dp", label: "Diametral pitch" }] },
    { key: "module", label: "Module", kind: "number", unit: "mm", min: 0.05, step: 0.25, visible: (p) => p.system !== "dp" },
    { key: "dp", label: "Diametral pitch", kind: "number", unit: "none", min: 0.1, step: 1, visible: (p) => p.system === "dp" },
    { key: "sunTeeth", label: "Sun teeth", kind: "number", unit: "none", min: 6, max: 200, step: 1 },
    { key: "planetTeeth", label: "Planet teeth", kind: "number", unit: "none", min: 6, max: 200, step: 1, hint: "The ring has sun + 2 × planet teeth." },
    { key: "planets", label: "Planets", kind: "number", unit: "none", min: 1, max: 12, step: 1 },
    { key: "pressureAngle", label: "Pressure angle", kind: "number", unit: "deg", min: 10, max: 35, step: 0.5 },
    { key: "width", label: "Face width", kind: "number", unit: "mm", min: 0.1, step: 1 },
    { key: "rim", label: "Ring rim", kind: "number", unit: "mm", min: 0.1, step: 1 },
    { key: "sunBore", label: "Sun bore", kind: "number", unit: "mm", min: 0, step: 1 },
    { key: "planetBore", label: "Planet bore", kind: "number", unit: "mm", min: 0, step: 1 },
    { key: "backlash", label: "Backlash", kind: "number", unit: "mm", min: 0, step: 0.02 },
    { key: "clearance", label: "Root clearance", kind: "number", unit: "none", min: 0, max: 0.5, step: 0.05 },
    ...placedFields,
  ],
  evaluate(ctx: EvalContext, p: PlanetaryParams) {
    const id = ctx.feature.id;
    const m = moduleOf(ctx, p);
    const zs = whole(ctx, p.sunTeeth, "The sun's teeth", 6, 200), zp = whole(ctx, p.planetTeeth, "The planets' teeth", 6, 200), n = whole(ctx, p.planets, "The number of planets", 1, 12);
    const zr = zs + 2 * zp;
    const width = positive(ctx, p.width, "The face width"), rim = positive(ctx, p.rim, "The ring's rim");
    if ((zs + zr) % n !== 0) {
      const fits = [2, 3, 4, 5, 6, 7, 8].filter((c) => (zs + zr) % c === 0);
      throw ctx.fail(`${n} planets cannot be spaced evenly: sun + ring teeth (${zs + zr}) must divide by the number of planets.${fits.length ? ` It divides by ${fits.join(", ")}.` : ""} Change a tooth count.`);
    }
    if (n > 1 && (zs + zp) * Math.sin(Math.PI / n) < zp + 2.2) throw ctx.fail(`${n} planets of ${zp} teeth run into each other round a sun of ${zs}. Use fewer planets or a larger sun.`);
    const sp = spaceOf(ctx, p);
    const sun = externalTeeth(ctx, p, m, zs), planet = externalTeeth(ctx, p, m, zp), ring = internalSpaces(ctx, p, m, zr);
    const holes = (bore: number, inside: number) => { const b = boreOf(ctx, { bore }, inside); return b ? [b] : []; };
    const parts: any[] = [];
    parts.push({ ...prismOf(ctx, sp, gearLoop(sun), holes(p.sunBore, sun.r - sun.hf), 0, width, `${id}:sun`), suffix: "sun", name: "Sun" });
    const a = (m * (zs + zp)) / 2;
    for (let i = 0; i < n; i++) {
      const phi = (2 * Math.PI * i) / n;
      // a gap of the planet faces the sun's tooth on the line of centres, turned on by what the sun's teeth are past that line
      const phase = phi + Math.PI + Math.PI / zp + (phi * zs) / zp;
      const at = sp.at([a * Math.cos(phi), a * Math.sin(phi), 0]);
      parts.push({ ...prismOf(ctx, at, gearLoop({ ...planet, phase }), holes(p.planetBore, planet.r - planet.hf), 0, width, `${id}:planet${i + 1}`), suffix: `planet${i + 1}`, name: `Planet ${i + 1}` });
    }
    // a space of the ring holds the first planet's tooth on the x axis
    const ringPhase = ((Math.PI + Math.PI / zp) * zp) / zr;
    parts.push({ ...prismOf(ctx, sp, circleLoop(ring.r + ring.ha + rim, "rim"), [gearLoop({ ...ring, phase: ringPhase })], 0, width, `${id}:ring`), suffix: "ring", name: "Ring" });
    for (const t of parts) ctx.addBody(t.shape, t.names, { suffix: t.suffix, name: `${t.name} (${ctx.feature.name})` });
  },
});
