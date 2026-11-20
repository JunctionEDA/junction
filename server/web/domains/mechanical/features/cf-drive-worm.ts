// cf-drive-worm.ts — Worm and worm wheel: a screw-shaped worm, the wheel it drives, or both in mesh on shafts at
// 90°.  The module is the worm's axial module, which is the wheel's transverse module: the worm's axial pitch
// is π × module, its lead that times the number of starts, and the wheel's pitch diameter is teeth × module.
//
// The worm is a ZA worm: straight-sided in the section through its axis (flank angle = the pressure angle), so
// in a section square to the axis each flank is an Archimedean spiral; that section is swept along the axis,
// turning once per lead.  The wheel is an involute helical gear whose helix angle is the worm's lead angle and
// whose hand is the worm's.  It is not throated: its teeth are not hollowed round the worm, which is how
// printed and light-duty wheels are made; a hobbed, enveloping wheel is not modelled.
//
// Placed: the wheel stands on the plane like any gear; the worm lies along the plane's y axis, level with the
// middle of the wheel's face, at the centre distance along x (alone, it lies along y through the origin).
//
// Bodies: the worm is the feature's body (or `<id>:worm` beside a wheel), the wheel `<id>:wheel`.
// Names: `<id>:worm:s<n>:a` / `:b` / `:tip` / `:root` per start and turn, `<id>:wheel:t<n>:…` as a helical gear.
import { defineFeature } from "../core/feature";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import { Pen, polar, Space, turnLoop, twistOf, type Loop, type P2 } from "../kernel/ops/cf-drive";
import { boreOf, externalTeeth, GEARS, gearLoop, moduleOf, num, placedDefaults, placedFields, positive, rad, SECTION, spaceOf, wheel, whole, type Placed } from "./_cf-drive";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface WormParams extends Placed {
  [key: string]: any;
  make: "worm" | "wheel" | "both";
  system: "module" | "dp"; module: number; dp: number; starts: number; diameter: number; length: number; pressureAngle: number; left: boolean;
  wormBore: number; wheelTeeth: number; wheelWidth: number; wheelBore: number; backlash: number; clearance: number;
}

/** The worm's section square to its axis: `starts` threads, each flank a spiral from the root to the tip circle. */
function wormSection(starts: number, lead: number, r: number, ha: number, hf: number, tan: number, backlash: number): Loop {
  const px = lead / starts, k = (2 * Math.PI) / lead;
  const half = px / 4 - backlash / 2;
  const at = (half - ha * tan) * k, ar = (half + hf * tan) * k, step = (2 * Math.PI) / starts, N = 6;
  const spiral = (a0: number, r0: number, a1: number, r1: number): P2[] => Array.from({ length: N }, (_, i) => polar(r0 + ((r1 - r0) * (i + 1)) / N, a0 + ((a1 - a0) * (i + 1)) / N));
  const pen = new Pen(polar(r - hf, -ar));
  for (let i = 0; i < starts; i++) {
    const a = i * step, n = `s${i + 1}`;
    pen.spline(spiral(a - ar, r - hf, a - at, r + ha), `${n}:a`).arcAbout([0, 0], polar(r + ha, a + at), `${n}:tip`, true)
      .spline(spiral(a + at, r + ha, a + ar, r - hf), `${n}:b`).arcAbout([0, 0], i === starts - 1 ? pen.start : polar(r - hf, a + step - ar), `${n}:root`, true);
  }
  return pen.close("root");
}

export default defineFeature<WormParams>({
  type: "cf-worm",
  title: "Worm and wheel",
  icon: '<path class="f" d="M3 4h18v7H3z"/><path d="M3 4h18v7H3zM6 4l2 7M10 4l2 7M14 4l2 7M18 4l2 7"/><path class="f" d="M5 21a7 7 0 0 1 14 0z"/><path d="M5 21a7 7 0 0 1 14 0zM12 14v-1.5M8.5 15l-1-1.2M15.5 15l1-1.2"/>',
  hint: "A worm, its worm wheel, or the pair in mesh on shafts at 90°",
  keywords: "worm gear worm wheel worm drive screw gear self locking reduction",
  toolbarSection: SECTION, toolbarMenu: GEARS, toolbarOrder: 16, toolbarKeep: 0,
  defaults: () => ({ make: "both", system: "module", module: 2, dp: 12, starts: 1, diameter: 20, length: 30, pressureAngle: 20, left: false, wormBore: 0, wheelTeeth: 30, wheelWidth: 14, wheelBore: 8, backlash: 0.05, clearance: 0.25, ...placedDefaults() }),
  schema: [
    { key: "make", label: "Make", kind: "enum", options: [{ value: "both", label: "Both" }, { value: "worm", label: "Worm" }, { value: "wheel", label: "Wheel" }] },
    { key: "system", label: "Size by", kind: "enum", options: [{ value: "module", label: "Module" }, { value: "dp", label: "Diametral pitch" }] },
    { key: "module", label: "Module", kind: "number", unit: "mm", min: 0.05, step: 0.25, hint: "The worm's axial module: its axial pitch over π.", visible: (p) => p.system !== "dp" },
    { key: "dp", label: "Diametral pitch", kind: "number", unit: "none", min: 0.1, step: 1, visible: (p) => p.system === "dp" },
    { key: "starts", label: "Starts", kind: "number", unit: "none", min: 1, max: 8, step: 1, hint: "Threads on the worm. The ratio is wheel teeth over starts." },
    { key: "diameter", label: "Worm pitch diameter", kind: "number", unit: "mm", min: 0.1, step: 1 },
    { key: "length", label: "Worm length", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => p.make !== "wheel" },
    { key: "wormBore", label: "Worm bore", kind: "number", unit: "mm", min: 0, step: 1, visible: (p) => p.make !== "wheel" },
    { key: "left", label: "Left-handed", kind: "boolean" },
    { key: "wheelTeeth", label: "Wheel teeth", kind: "number", unit: "none", min: 8, max: 300, step: 1, visible: (p) => p.make !== "worm" },
    { key: "wheelWidth", label: "Wheel face width", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => p.make !== "worm" },
    { key: "wheelBore", label: "Wheel bore", kind: "number", unit: "mm", min: 0, step: 1, visible: (p) => p.make !== "worm" },
    { key: "pressureAngle", label: "Pressure angle", kind: "number", unit: "deg", min: 10, max: 30, step: 0.5 },
    { key: "backlash", label: "Backlash", kind: "number", unit: "mm", min: 0, step: 0.02 },
    { key: "clearance", label: "Root clearance", kind: "number", unit: "none", min: 0, max: 0.5, step: 0.05 },
    ...placedFields,
  ],
  evaluate(ctx: EvalContext, p: WormParams) {
    const id = ctx.feature.id;
    const m = moduleOf(ctx, p), starts = whole(ctx, p.starts, "The number of starts", 1, 8);
    const d1 = positive(ctx, p.diameter, "The worm's pitch diameter"), r1 = d1 / 2;
    const alpha = rad(num(p.pressureAngle, 20));
    if (!(alpha >= rad(10) && alpha <= rad(30))) throw ctx.fail("The pressure angle must be between 10° and 30°.");
    const c = Math.max(0, num(p.clearance, 0.25)), ha = m, hf = m * (1 + c), backlash = Math.max(0, num(p.backlash));
    const lead = Math.PI * m * starts, gamma = Math.atan(lead / (Math.PI * d1));
    if (!(r1 - hf > 0.5 * m)) throw ctx.fail(`The worm's pitch diameter must be more than ${(2 * (hf + 0.5 * m)).toFixed(2)} mm for this module.`);
    if (gamma > rad(40)) throw ctx.fail("The lead angle is over 40°: use fewer starts or a larger worm diameter.");
    if (!(Math.PI * m / 4 - backlash / 2 - ha * Math.tan(alpha) > 0.02 * m)) throw ctx.fail("The thread comes to a point: use a smaller pressure angle.");
    const hand = p.left ? -1 : 1, make = p.make === "worm" || p.make === "wheel" ? p.make : "both";
    const sp = spaceOf(ctx, p);
    const z2 = make === "worm" ? 0 : whole(ctx, p.wheelTeeth, "The wheel's number of teeth", 8, 300);
    const width = make === "worm" ? 0 : positive(ctx, p.wheelWidth, "The wheel's face width");
    const centres = make === "both" ? r1 + (m * z2) / 2 : 0;
    if (make !== "wheel") {
      const length = positive(ctx, p.length, "The worm's length");
      // the worm's own space: its axis along the plane's y, its angle 0 towards the wheel
      const origin = sp.at([centres, 0, make === "both" ? width / 2 : 0]);
      const ws = new Space(origin.o, [-sp.x[0], -sp.x[1], -sp.x[2]], sp.z, sp.y);
      // a turn per step, so no face goes more than once round
      const turns = length / lead, n = Math.max(1, Math.ceil(turns));
      const steps = Array.from({ length: n }, () => ({ h: length / n, turn: (hand * 2 * Math.PI * turns) / n }));
      // a thread is centred on angle 0 at the middle of the worm
      const section = turnLoop(wormSection(starts, lead, r1, ha, hf, Math.tan(alpha), backlash), (-hand * Math.PI * turns));
      const bore = boreOf(ctx, { bore: p.wormBore }, r1 - hf);
      const worm: NamedResult = twistOf(ctx, ws, section, bore ? [bore] : [], -length / 2, steps, r1, make === "both" ? `${id}:worm` : id);
      ctx.addBody(worm.shape, worm.names, make === "both" ? { suffix: "worm", name: `Worm (${ctx.feature.name})` } : {});
    }
    if (make !== "worm") {
      const t = externalTeeth(ctx, { pressureAngle: num(p.pressureAngle, 20), backlash, clearance: c }, m * Math.cos(gamma), z2, gamma);
      const turn = (hand * width * Math.tan(gamma)) / t.r;
      // a gap faces the worm at the middle of the face, where the worm's thread is centred
      const loop = gearLoop({ ...t, phase: Math.PI / z2 - turn / 2 });
      const body = wheel(ctx, sp, loop, { thickness: width, inside: t.r - t.hf, prefix: make === "both" ? `${id}:wheel` : id, twist: { steps: [{ h: width, turn }], guide: t.r } }, { bore: p.wheelBore });
      ctx.addBody(body.shape, body.names, make === "both" ? { suffix: "wheel", name: `Wheel (${ctx.feature.name})` } : {});
    }
  },
});
