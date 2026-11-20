// cf-hw-knob.ts — Knob: a hand knob from its numbers.  The grip is lobed (a star knob: round lobes with
// scallops between for the fingers), knurled (straight ridges all round) or plain round; its top is crowned and
// its edges broken.  A stem under it stands it off the part.  The bore takes what it turns: a plain hole, a
// captive hexagon nut pressed in from below, a bolt whose head sinks into the top, a D shaft, or a heat-set
// insert.
//
// It stands on the picked plane, stem down.  Names: `<id>:grip` (numbered round the knob), `<id>:top`,
// `<id>:crown`, `<id>:under`, `<id>:stem`, `<id>:stem:bottom`, `<id>:bore`, `<id>:pocket:flat`, `<id>:flat`.
import { defineFeature } from "../core/feature";
import type { Frame } from "../core/geometry";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import { apply, circle, common, copies, cut, extruded, fuse, ngon, poly, revolved, spots, type Loop, type Seg, type V2 } from "../kernel/ops/cf-hw";
import { fastenerOf, fastenerOptions, HW_SECTION, MENU_ENCLOSURES, resultFields, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface KnobParams {
  [key: string]: any;
  style: "lobed" | "knurled" | "round"; diameter: number; height: number; lobes: number; grip: number; crown: number;
  stemDiameter: number; stemHeight: number;
  bore: "hole" | "nut" | "head" | "d" | "insert"; screw: string; shaft: number; shaftFlat: number; boreDepth: number;
  operation: "new" | "add"; targets: string[];
}

export default defineFeature<KnobParams>({
  type: "cf-hw-knob",
  title: "Knob",
  icon: '<path class="f" d="M12 2.5c1.6 0 2.2 1.6 3.4 2s2.8-.4 3.9.7.3 2.7.7 3.9 2 1.800 2 3.400-1.600 2.200-2 3.400.400 2.800-.700 3.900-2.700.300-3.900.700-1.800 2-3.400 2-2.200-1.600-3.400-2-2.800.400-3.900-.700-.300-2.700-.700-3.900-2-1.800-2-3.400 1.600-2.200 2-3.400-.400-2.800.700-3.900 2.700-.300 3.900-.700 1.800-2 3.400-2z"/><path d="M12 2.500c1.600 0 2.200 1.600 3.400 2s2.800-.4 3.900.7.3 2.700.7 3.900 2 1.800 2 3.400-1.600 2.200-2 3.400.4 2.800-.7 3.900-2.700.3-3.900.7-1.800 2-3.400 2-2.200-1.600-3.400-2-2.800.4-3.900-.7-.3-2.700-.7-3.900-2-1.800-2-3.400 1.600-2.200 2-3.400-.4-2.800.7-3.900 2.700-.3 3.900-.7 1.800-2 3.400-2z"/><path d="M12 9.200l2.400 1.400v2.800L12 14.800l-2.400-1.400v-2.800z"/>',
  hint: "Make a hand knob: lobed, knurled or round, with a bore for a nut, a bolt head, a D shaft or an insert",
  keywords: "knob handle star knob lobed knurled thumb wheel hand wheel clamping knob insert d-shaft potentiometer",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_ENCLOSURES, toolbarOrder: 65, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), style: "lobed", diameter: 32, height: 12, lobes: 5, grip: 4, crown: 1.5, stemDiameter: 14, stemHeight: 6, bore: "hole", screw: "M6", shaft: 6, shaftFlat: 4.5, boreDepth: 0, operation: "new", targets: [] }),
  schema: [
    { key: "style", label: "Grip", kind: "enum", options: [{ value: "lobed", label: "Lobed" }, { value: "knurled", label: "Knurled" }, { value: "round", label: "Round" }] },
    { key: "diameter", label: "Diameter", kind: "number", unit: "mm", min: 2, step: 2 },
    { key: "height", label: "Height", kind: "number", unit: "mm", min: 1, step: 1, hint: "Of the grip, without the stem." },
    { key: "lobes", label: "Lobes", kind: "number", unit: "none", min: 3, max: 12, step: 1, visible: (p) => p.style === "lobed" },
    { key: "grip", label: "Grip depth", kind: "number", unit: "mm", min: 0.1, step: 0.5, hint: "How deep the scallops (or the knurl's ridges) are.", visible: (p) => p.style !== "round" },
    { key: "crown", label: "Crown", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "How much higher the middle of the top is than its edge." },
    { key: "stemDiameter", label: "Stem Ø", kind: "number", unit: "mm", min: 0, step: 1 },
    { key: "stemHeight", label: "Stem height", kind: "number", unit: "mm", min: 0, step: 1, hint: "0 for no stem." },
    { key: "bore", label: "Bore", kind: "enum", options: [{ value: "hole", label: "Hole" }, { value: "nut", label: "Captive nut" }, { value: "head", label: "Bolt head" }, { value: "d", label: "D shaft" }, { value: "insert", label: "Insert" }] },
    { key: "screw", label: "Screw", kind: "enum", options: fastenerOptions().slice(0, 9), visible: (p) => p.bore !== "d" },
    { key: "shaft", label: "Shaft Ø", kind: "number", unit: "mm", min: 0.5, step: 0.5, visible: (p) => p.bore === "d" },
    { key: "shaftFlat", label: "Across the flat", kind: "number", unit: "mm", min: 0.2, step: 0.5, hint: "From the shaft's flat to its far side.", visible: (p) => p.bore === "d" },
    { key: "boreDepth", label: "Bore depth", kind: "number", unit: "mm", min: 0, step: 1, hint: "From the bottom; 0 goes right through (an insert's hole is as deep as the insert).", visible: (p) => p.bore === "hole" || p.bore === "d" },
    ...whereFields({ noun: "knob" }),
    ...resultFields,
  ],

  evaluate(ctx: EvalContext, p: KnobParams) {
    const D = Number(p.diameter), H = Number(p.height), R = D / 2;
    if (!(D > 0) || !(H > 0)) throw ctx.fail("The knob's diameter and height must be more than zero.");
    const stemH = Math.max(0, Number(p.stemHeight) || 0), stemR = Number(p.stemDiameter) / 2;
    if (stemH > 0 && !(stemR > 0 && stemR < R)) throw ctx.fail("The stem must be thinner than the knob.");
    const g = p.style === "round" ? 0 : Number(p.grip);
    if (p.style !== "round" && !(g > 0 && g < R * 0.6)) throw ctx.fail("The grip depth must be more than zero and less than a third of the diameter.");
    const crown = Math.max(0, Math.min(Number(p.crown) || 0, H * 0.4));
    const total = stemH + H;
    // ---- the grip's outline
    let outline: Loop;
    if (p.style === "lobed") {
      const n = Math.round(Number(p.lobes) || 0);
      if (n < 3 || n > 12) throw ctx.fail("A lobed knob has between 3 and 12 lobes.");
      // each scallop is an arc of a circle that takes a bit more than half the room between two lobes
      const phi = (0.55 * Math.PI) / n, down = R * Math.cos(phi) - (R - g);
      if (!(down > 1e-6)) throw ctx.fail(`With ${n} lobes the grip must be deeper than ${Math.round(R * (1 - Math.cos(phi)) * 100) / 100} mm.`);

      const at = (a: number, r: number): V2 => [r * Math.cos(a), r * Math.sin(a)];
      const segs: Seg[] = [];
      for (let i = 0; i < n; i++) {
        const a0 = (2 * Math.PI * i) / n, a1 = (2 * Math.PI * (i + 1)) / n;
        segs.push({ to: at(a1 - phi, R), via: at((a0 + a1) / 2, R), role: "grip" });          // a lobe
        segs.push({ to: at(a1 + phi, R), via: at(a1, R - g), role: "grip" });                 // the scallop after it
      }
      outline = { start: at(phi, R), segs };
    } else if (p.style === "knurled") {
      const n = Math.max(8, Math.round((2 * Math.PI * R) / Math.max(1, 2.2 * g)));
      outline = poly(Array.from({ length: 2 * n }, (_, i) => { const a = (Math.PI * i) / n, r = i % 2 ? R - g : R; return [r * Math.cos(a), r * Math.sin(a)] as V2; }), "grip");
    } else outline = circle([0, 0], R, "grip");
    // ---- the bore
    const f = p.bore === "d" ? null : fastenerOf(p.screw);
    if (p.bore !== "d" && !f) throw ctx.fail(`The size table has no ${p.screw}.`);
    const build = (frame: Frame, prefix: string): NamedResult => {
      let knob = extruded(ctx, frame, outline, [], stemH, H, prefix);
      // turned: the top crowned, the top and bottom edges broken
      const e = Math.min(1, H * 0.12), rim = total - crown;
      const zc = crown > 1e-6 ? (R * R + rim * rim - total * total) / (2 * (rim - total)) : 0, rs = total - zc;
      const envelope: Loop = { start: [0, stemH], segs: [
        { to: [R - e, stemH], role: "under" }, { to: [R + 0.01, stemH + e + 0.01], role: "edge" }, { to: [R + 0.01, rim - e - 0.01], role: null }, { to: [R - e, rim], role: "edge" },
        crown > 1e-6 ? { to: [0, total], via: [rs * Math.sin(Math.asin((R - e) / rs) / 2), zc + rs * Math.cos(Math.asin((R - e) / rs) / 2)], role: "crown" } : { to: [0, total], role: "top" },
        { to: [0, stemH], role: null },
      ] };
      knob = common(ctx, knob, revolved(ctx, frame, envelope, prefix));
      if (stemH > 0) knob = fuse(ctx, knob, revolved(ctx, frame, poly([[0, 0], [stemR, 0], [stemR, stemH + 0.01], [0, stemH + 0.01]] as V2[], ["stem:bottom", "stem", null, null]), prefix));
      const through = (d: number, z0 = -0.01, z1 = total + 0.01) => extruded(ctx, frame, circle([0, 0], d / 2, "bore"), [], z0, z1 - z0, prefix);
      if (p.bore === "d") {
        const rsh = Number(p.shaft) / 2, across = Number(p.shaftFlat);
        if (!(rsh > 0) || !(across > rsh && across < 2 * rsh)) throw ctx.fail("A D shaft's flat lies between its middle and its far side: give a value between half the diameter and the diameter.");
        if (!(rsh < (stemH > 0 ? stemR : R) - 1)) throw ctx.fail("The shaft is too thick for the knob.");
        const x = across - rsh, y = Math.sqrt(rsh * rsh - x * x);
        const depth = p.boreDepth > 0 ? Math.min(Number(p.boreDepth), total - 1) : total + 0.02;
        knob = cut(ctx, knob, extruded(ctx, frame, { start: [x, y], segs: [{ to: [x, -y], via: [-rsh, 0], role: "bore" }, { to: [x, y], role: "flat" }] }, [], -0.01, depth, prefix));
        return knob;
      }
      const s = f!;
      if (!(s.clearance[1] / 2 < (stemH > 0 ? stemR : R) - 1)) throw ctx.fail("The screw is too thick for the knob. Use a smaller one, or a thicker stem.");
      if (p.bore === "insert") knob = cut(ctx, knob, through(s.insert[0], -0.01, Math.min(s.insert[1], total - 1)));
      else if (p.bore === "hole" && p.boreDepth > 0) knob = cut(ctx, knob, through(s.clearance[1], -0.01, Math.min(Number(p.boreDepth), total - 1)));
      else knob = cut(ctx, knob, through(s.clearance[1]));
      if (p.bore === "nut" || p.bore === "head") {
        // a hexagon pocket: for a nut, pressed in from below; for a bolt's head, sunk into the top
        const deep = Math.min((p.bore === "nut" ? s.nutM : s.hexK) + 0.5, total - 1.5);
        if (!(s.s / Math.cos(Math.PI / 6) / 2 < (p.bore === "nut" && stemH > 0 ? stemR : R - g) - 0.8)) throw ctx.fail("The nut is too large for the knob. Use a smaller screw, or a thicker stem.");
        knob = cut(ctx, knob, extruded(ctx, frame, ngon([0, 0], 6, s.s + 0.2, 0, "flat"), [], p.bore === "nut" ? -0.01 : total - deep, deep + 0.01, `${prefix}:pocket`));
      }
      return knob;
    };
    apply(ctx, copies(ctx, spots(ctx, p), build), p);
  },
});
