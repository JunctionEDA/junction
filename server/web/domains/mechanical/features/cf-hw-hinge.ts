// cf-hw-hinge.ts — Hinge: a butt hinge from its numbers: two leaves whose knuckles interleave round a pin, with
// countersunk screw holes.  Length, leaf width and thickness, pin diameter, number of knuckles, the gaps that let
// it turn, and the angle it is drawn open at.
//
// It lies on the picked plane, the pin along the plane's second direction, leaf A to one side and leaf B to the
// other; at 180° it is laid flat open.  Bodies: Leaf A, Leaf B and Pin, so an assembly can put a revolute mate
// on the pin.
//
// Names: `<id>:a:plate:…`, `<id>:a:k<n>:barrel`, `:bore`, `:ear`, `<id>:a:h<n>:…`, the same under `<id>:b:`, `<id>:pin:side`.
import { defineFeature } from "../core/feature";
import { add, scale, type Frame } from "../core/geometry";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import { circle, cut, drill, extruded, frameAt, fuse, lift, moved, poly, spots, together, type Loop, type V2 } from "../kernel/ops/cf-hw";
import { fastenerOf, fastenerOptions, HW_SECTION, MENU_ENCLOSURES, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HingeParams {
  [key: string]: any;
  length: number; leaf: number; thickness: number; pinDiameter: number; knuckles: number; gap: number; pinClearance: number;
  open: number; holes: number; screw: string; countersunk: boolean; pin: "separate" | "none";
}

export default defineFeature<HingeParams>({
  type: "cf-hw-hinge",
  title: "Hinge",
  icon: '<path class="f" d="M2.5 8h8v10h-8zM13.5 8h8v10h-8z"/><path d="M2.5 8h8v10h-8zM13.5 8h8v10h-8z"/><rect class="f" x="10.5" y="5" width="3" height="16" rx="1.5"/><rect x="10.5" y="5" width="3" height="16" rx="1.5"/><path class="t" d="M10.5 9.5h3M10.5 13h3M10.5 16.5h3"/><circle class="s" cx="6.5" cy="13" r="1"/><circle class="s" cx="17.5" cy="13" r="1"/>',
  hint: "Make a butt hinge: two leaves with interleaved knuckles, a pin and screw holes",
  keywords: "hinge butt hinge knuckle pin leaf door lid generator print in place pivot",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_ENCLOSURES, toolbarOrder: 64, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), length: 40, leaf: 18, thickness: 2, pinDiameter: 3, knuckles: 5, gap: 0.3, pinClearance: 0.3, open: 180, holes: 2, screw: "M3", countersunk: true, pin: "separate" }),
  schema: [
    { key: "length", label: "Length", kind: "number", unit: "mm", min: 2, step: 5, hint: "Along the pin." },
    { key: "leaf", label: "Leaf width", kind: "number", unit: "mm", min: 2, step: 1, hint: "From the pin's axis to a leaf's edge." },
    { key: "thickness", label: "Leaf thickness", kind: "number", unit: "mm", min: 0.3, step: 0.5 },
    { key: "pinDiameter", label: "Pin Ø", kind: "number", unit: "mm", min: 0.5, step: 0.5 },
    { key: "knuckles", label: "Knuckles", kind: "number", unit: "none", min: 2, max: 21, step: 1 },
    { key: "gap", label: "Gap", kind: "number", unit: "mm", min: 0, step: 0.05, hint: "Between one knuckle and the next, and between a knuckle and the other leaf." },
    { key: "pinClearance", label: "Pin clearance", kind: "number", unit: "mm", min: 0, step: 0.05, hint: "Added to the pin's diameter for the knuckles' bore." },
    { key: "open", label: "Opened to", kind: "number", unit: "deg", min: 0, max: 270, step: 15, hint: "180: flat open. 0: folded shut." },
    { key: "holes", label: "Screws per leaf", kind: "number", unit: "none", min: 0, max: 8, step: 1 },
    { key: "screw", label: "Screw", kind: "enum", options: fastenerOptions().slice(0, 7), visible: (p) => Number(p.holes) > 0 },
    { key: "countersunk", label: "Countersunk", kind: "boolean", visible: (p) => Number(p.holes) > 0 },
    { key: "pin", label: "Pin", kind: "enum", options: [{ value: "separate", label: "A body" }, { value: "none", label: "None" }] },
    ...whereFields({ angle: true, noun: "hinge" }),
  ],

  evaluate(ctx: EvalContext, p: HingeParams) {
    const L = Number(p.length), leaf = Number(p.leaf), t = Number(p.thickness), pd = Number(p.pinDiameter);
    const gap = Math.max(0, Number(p.gap) || 0), n = Math.round(Number(p.knuckles) || 0);
    if (!(L > 0 && leaf > 0 && t > 0 && pd > 0)) throw ctx.fail("The hinge's sizes must be more than zero.");
    if (n < 2 || n > 21) throw ctx.fail("A hinge has between 2 and 21 knuckles.");
    const bore = (pd + Math.max(0, Number(p.pinClearance) || 0)) / 2, rb = bore + t;   // the barrel wraps the pin in one leaf thickness
    const edge = rb + gap;    // where a leaf's plate begins, clear of the other leaf's knuckles
    if (!(leaf > edge + 1)) throw ctx.fail(`The leaves are narrower than the barrel: make them wider than ${Math.round((edge + 1) * 10) / 10} mm.`);
    const each = (L - (n - 1) * gap) / n;
    if (!(each > 0.5)) throw ctx.fail("The knuckles are too short: use fewer of them, or a longer hinge.");
    const holes = Math.round(Number(p.holes) || 0), screw = fastenerOf(p.screw);
    if (holes > 0 && !screw) throw ctx.fail(`The size table has no ${p.screw}.`);
    const open = Math.max(0, Math.min(270, Number(p.open)));
    const places = spots(ctx, p);
    places.forEach((s, at) => {
      const f = s.frame, id = places.length > 1 ? `${ctx.feature.id}:${s.key}` : ctx.feature.id;
      // one leaf, on the side `sign` of the pin
      const leafOf = (sign: number, tag: string, mine: (i: number) => boolean): NamedResult => {
        const prefix = `${id}:${tag}`;
        const x0 = sign * edge, x1 = sign * leaf;
        let body = extruded(ctx, f, poly([[Math.min(x0, x1), -L / 2], [Math.max(x0, x1), -L / 2], [Math.max(x0, x1), L / 2], [Math.min(x0, x1), L / 2]] as V2[], "plate"), [], 0, t, `${prefix}:plate`);
        // a knuckle, seen along the pin: the barrel, and an ear that carries it out from the plate
        const xl = Math.sqrt(Math.max(0, rb * rb - (rb - t) * (rb - t)));
        const outline: Loop = { start: [sign * edge, 0], segs: [
          { to: [0, 0], role: "ear" }, { to: [sign * xl, t], via: [0, 2 * rb], role: "barrel" }, { to: [sign * edge, t], role: "ear" }, { to: [sign * edge, 0], role: null },
        ] };
        const knuckles: NamedResult[] = [];
        for (let i = 0; i < n; i++) {
          if (!mine(i)) continue;
          const y0 = -L / 2 + i * (each + gap);
          const side: Frame = { origin: add(f.origin, scale(f.y, y0)), x: f.x, y: f.normal, normal: f.y };
          knuckles.push(extruded(ctx, side, outline, [circle([0, rb], bore, "bore")], 0, each, `${prefix}:k${i + 1}`));
        }
        if (knuckles.length) body = fuse(ctx, body, together(ctx, knuckles));
        if (holes > 0 && screw) {
          const x = sign * (edge + leaf) / 2;
          const d = screw.clearance[1];
          if (Math.abs(leaf - edge) < d + 2) throw ctx.fail("The leaves are too narrow for these screws.");
          const tools = Array.from({ length: holes }, (_, i) => drill(ctx, frameAt(f, [x, (L * (i + 0.5)) / holes - L / 2], t), p.countersunk && t > 0.8
            ? { kind: "csink", diameter: d, csinkDiameter: Math.min(screw.flatD + 0.4, d + 2 * (t - 0.3)), csinkAngle: 90, depth: t + 1 }
            : { diameter: d, depth: t + 1 }, `${prefix}:h${i + 1}`));
          body = cut(ctx, body, together(ctx, tools));
        }
        return body;
      };
      const a = leafOf(-1, "a", (i) => i % 2 === 0);
      let b = leafOf(1, "b", (i) => i % 2 === 1);
      // leaf B swings about the pin: flat open at 180°, folded onto A at 0°
      const axis = { origin: lift(f, [0, 0], rb), dir: f.y };
      if (Math.abs(open - 180) > 1e-9) b = moved(ctx, b, { axis, angle: -(180 - open) });
      const name = (base: string) => (at ? `${base} ${at + 1}` : base);
      ctx.addBody(a.shape, a.names, { suffix: places.length > 1 ? `${s.key}.a` : "a", name: name("Leaf A") });
      ctx.addBody(b.shape, b.names, { suffix: places.length > 1 ? `${s.key}.b` : "b", name: name("Leaf B") });
      if (p.pin !== "none") {
        const side: Frame = { origin: add(f.origin, scale(f.y, -L / 2)), x: f.x, y: f.normal, normal: f.y };
        const pin = extruded(ctx, side, circle([0, rb], pd / 2, "side"), [], 0, L, `${id}:pin`);
        ctx.addBody(pin.shape, pin.names, { suffix: places.length > 1 ? `${s.key}.pin` : "pin", name: name("Pin") });
      }
    });
  },
});
