// cf-drive-sprocket.ts — Roller chain sprocket for ANSI (25 to 100) and ISO B series (04B to 20B) chain.  The
// pitch diameter is pitch / sin(180° / teeth).  The tooth form is ISO 606's: each roller sits in an arc of
// radius 0.505 × roller diameter about its place on the pitch circle, opening by the seating angle
// (130° − 90° / teeth, the middle of the standard's range); from each end of that arc a flank arc of radius
// 0.12 × roller diameter × (teeth + 2) runs tangent out to the tip circle (pitch diameter + (1 − 1.6 / teeth) ×
// pitch − roller diameter, more where the flanks would otherwise not meet it).  The plate is as thick as the
// chain takes: 0.93 × the chain's inner width up to 1/2 inch pitch, 0.95 × above.
//
// Names: `<id>:t<n>:seat` (the roller seat before tooth n), `:a` / `:b` (its flanks), `:tip`, `<id>:bottom`,
// `<id>:top`, `<id>:bore`, `<id>:key:…`, `<id>:hub:…`.  A roller seat is centred on the plane's x axis.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { Pen, rot2, type Loop, type P2 } from "../kernel/ops/cf-drive";
import { boreDefaults, boreFields, DRIVES, finish, makeField, num, placedDefaults, placedFields, rad, SECTION, spaceOf, wheel, whole, type Bore, type Placed } from "./_cf-drive";
import { CHAINS } from "./_cf-drive-data";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SprocketParams extends Bore, Placed { [key: string]: any; chain: string; teeth: number; thickness: number; operation: string }

/** The outline of a sprocket's teeth and the radius of its roots. */
export function sprocketLoop(pitch: number, d1: number, z: number): { loop: Loop; root: number; tip: number; pitchRadius: number } {
  const R = pitch / (2 * Math.sin(Math.PI / z)), ri = 0.505 * d1, re = 0.12 * d1 * (z + 2), seat = rad(130 - 90 / z) / 2;
  const step = (2 * Math.PI) / z;
  // a seat centred on angle 0: the end of its arc on the +y side, and the flank arc's centre beyond
  const end: P2 = [R - ri * Math.cos(seat), ri * Math.sin(seat)];
  const fc: P2 = [R + (re - ri) * Math.cos(seat), -(re - ri) * Math.sin(seat)];
  // along the flank arc, from the seat's end outwards, until the tip circle or the middle of the tooth
  const want = R + ((1 - 1.6 / z) * pitch - d1) / 2;
  const a0 = Math.atan2(end[1] - fc[1], end[0] - fc[0]);
  const on = (a: number): P2 => [fc[0] + re * Math.cos(a), fc[1] + re * Math.sin(a)];
  const out = (a: number) => { const q = on(a); return Math.hypot(q[0], q[1]) >= want || Math.atan2(q[1], q[0]) >= step / 2; };
  let lo = a0, hi = a0 - Math.PI / 2;   // the flank turns clockwise about its centre as it climbs
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (out(m)) hi = m; else lo = m; }
  const top = on(lo), tip = Math.hypot(top[0], top[1]), topAngle = Math.atan2(top[1], top[0]);
  const mirror = (q: P2): P2 => [q[0], -q[1]];
  const pen = new Pen(mirror(end));
  for (let i = 0; i < z; i++) {
    const a = i * step, n = `t${i + 1}`, T = (q: P2) => rot2(q, a), T1 = (q: P2) => rot2(q, a + step);
    pen.arc(T([R - ri, 0]), T(end), `${n}:seat`).arc(T(on((a0 + lo) / 2)), T(top), `${n}:a`);
    if (step / 2 - topAngle > 1e-6) pen.arcAbout([0, 0], T1(mirror(top)), `${n}:tip`, true);
    pen.arc(T1(mirror(on((a0 + lo) / 2))), i === z - 1 ? pen.start : T1(mirror(end)), `${n}:b`);
  }
  return { loop: pen.close("seat"), root: R - ri, tip, pitchRadius: R };
}

export default defineFeature<SprocketParams>({
  type: "cf-sprocket",
  title: "Chain sprocket",
  icon: '<path class="f" d="M12 2.5l1.8 2.3 2.8-1 .6 2.9 2.9.6-1 2.8 2.3 1.8-2.3 1.8 1 2.8-2.9.6-.6 2.9-2.8-1-1.8 2.3-1.8-2.3-2.8 1-.6-2.9-2.9-.6 1-2.8-2.3-1.8 2.3-1.8-1-2.8 2.9-.6.6-2.9 2.8 1z"/><path d="M12 2.5l1.8 2.3 2.8-1 .6 2.9 2.9.6-1 2.8 2.3 1.8-2.3 1.8 1 2.8-2.9.6-.6 2.9-2.8-1-1.8 2.3-1.8-2.3-2.8 1-.6-2.9-2.9-.6 1-2.8-2.3-1.8 2.3-1.8-1-2.8 2.9-.6.6-2.9 2.8 1z"/><circle cx="12" cy="12" r="2"/><circle class="s" cx="12" cy="6.6" r="1"/><circle class="s" cx="12" cy="17.4" r="1"/><circle class="s" cx="6.6" cy="12" r="1"/><circle class="s" cx="17.4" cy="12" r="1"/>',
  hint: "A roller chain sprocket: ANSI 25 to 100 or ISO 04B to 20B, ISO 606 tooth form",
  keywords: "sprocket roller chain chainwheel chainring ANSI ISO 606 08B 06B #25 #35 #40 #50 bike",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 20, toolbarKeep: 0,
  defaults: () => ({ chain: "08B", teeth: 18, thickness: 0, ...boreDefaults(12), ...placedDefaults(), operation: "new" }),
  schema: [
    { key: "chain", label: "Chain", kind: "enum", options: Object.entries(CHAINS).map(([value, c]) => ({ value, label: c.label })) },
    { key: "teeth", label: "Teeth", kind: "number", unit: "none", min: 6, max: 200, step: 1 },
    { key: "thickness", label: "Thickness", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "0 takes what the chain's width allows." },
    ...boreFields, ...placedFields, makeField,
  ],
  evaluate(ctx: EvalContext, p: SprocketParams) {
    const id = ctx.feature.id;
    const c = CHAINS[p.chain];
    if (!c) throw ctx.fail("Pick a chain size.");
    const z = whole(ctx, p.teeth, "The number of teeth", 6, 200);
    const widest = (c.p <= 12.7 ? 0.93 : 0.95) * c.b1;
    const given = num(p.thickness), thickness = given > 0 ? given : Math.round(widest * 100) / 100;
    if (given > c.b1) ctx.warn(`This chain is ${c.b1} mm wide between its inner plates: a sprocket ${given} mm thick does not go in.`);
    const s = sprocketLoop(c.p, c.d1, z);
    const body = wheel(ctx, spaceOf(ctx, p), s.loop, { thickness, inside: s.root, prefix: id }, p);
    finish(ctx, [body], p.operation);
  },
});
