// cf-drive-ratchet.ts — Ratchet wheel and pawl: a wheel of saw teeth that turns one way only, and the pawl that
// stops it going back.  Each tooth has a steep face (radial, or raked under by the rake angle so the pawl is
// drawn in) and a sloping back the pawl rides up.  The wheel turns freely counter-clockwise seen from above
// (clockwise with "Opposite direction").
//
// The pawl is a second body: its nose rests against the face of the tooth on the plane's x axis, its pivot
// lies back from there by the pawl's length, far enough out that its underside clears the next tooth's back.
//
// Names: `<id>:t<n>:face`, `<id>:t<n>:back`, `<id>:bottom`, `<id>:top`, `<id>:bore`, `<id>:key:…`, `<id>:hub:…`;
// the pawl's `<id>:pawl:nose`, `:pawl:over`, `:pawl:boss`, `:pawl:under`, `:pawl:pivot`, `:pawl:bottom`, `:pawl:top`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { circleLoop, Pen, polar, prismOf, type P2 } from "../kernel/ops/cf-drive";
import { boreDefaults, boreFields, DRIVES, num, placedDefaults, placedFields, positive, rad, SECTION, spaceOf, wheel, whole, type Bore, type Placed } from "./_cf-drive";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RatchetParams extends Bore, Placed { [key: string]: any; teeth: number; diameter: number; toothHeight: number; rake: number; thickness: number; reverse: boolean; pawl: boolean; pawlLength: number; pawlPivot: number }

export default defineFeature<RatchetParams>({
  type: "cf-ratchet",
  title: "Ratchet and pawl",
  icon: '<path class="f" d="M11 5.5v3l4.2-.7-1.7 2.5 4 1.3-2.8 1.6 2.3 3.5-3.4-.9.2 4.2-2.5-2.7-2 3.7-.9-4.1-3.7 2 1.5-3.3-4.2.2 3-2.6-3.5-2.3h3.9l-1.4-3.7 3.2 1.6z"/><path d="M11 5.5v3l4.2-.7-1.7 2.5 4 1.3-2.8 1.6 2.3 3.5-3.4-.9.2 4.2-2.5-2.7-2 3.7-.9-4.1-3.7 2 1.5-3.3-4.2.2 3-2.6-3.5-2.3h3.9l-1.4-3.7 3.2 1.6z"/><path class="s" d="M21.5 3.5l-6.2 3.3.9 1.6 6.3-2.4z"/>',
  hint: "A ratchet wheel with saw teeth and the pawl that holds it",
  keywords: "ratchet wheel pawl saw teeth one way click detent escapement winch",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 30, toolbarKeep: 0,
  defaults: () => ({ teeth: 16, diameter: 50, toothHeight: 4, rake: 5, thickness: 6, reverse: false, pawl: true, pawlLength: 22, pawlPivot: 4, ...boreDefaults(8), ...placedDefaults() }),
  schema: [
    { key: "teeth", label: "Teeth", kind: "number", unit: "none", min: 4, max: 200, step: 1 },
    { key: "diameter", label: "Outside diameter", kind: "number", unit: "mm", min: 1, step: 1 },
    { key: "toothHeight", label: "Tooth height", kind: "number", unit: "mm", min: 0.1, step: 0.5 },
    { key: "rake", label: "Rake", kind: "number", unit: "deg", min: 0, max: 20, step: 1, hint: "How far the tooth's face leans under its tip, which pulls the pawl in." },
    { key: "thickness", label: "Thickness", kind: "number", unit: "mm", min: 0.1, step: 1 },
    { key: "reverse", label: "Opposite direction", kind: "boolean" },
    ...boreFields,
    { key: "pawl", label: "With a pawl", kind: "boolean" },
    { key: "pawlLength", label: "Pawl length", kind: "number", unit: "mm", min: 1, step: 1, hint: "From its nose to its pivot.", visible: (p) => !!p.pawl },
    { key: "pawlPivot", label: "Pawl pivot hole", kind: "number", unit: "mm", min: 0, step: 0.5, visible: (p) => !!p.pawl },
    ...placedFields,
  ],
  evaluate(ctx: EvalContext, p: RatchetParams) {
    const id = ctx.feature.id;
    const z = whole(ctx, p.teeth, "The number of teeth", 4, 200);
    const ra = positive(ctx, p.diameter, "The outside diameter") / 2, h = positive(ctx, p.toothHeight, "The tooth height");
    const thickness = positive(ctx, p.thickness, "The thickness"), rake = rad(Math.min(20, Math.max(0, num(p.rake))));
    const rf = ra - h, step = (2 * Math.PI) / z;
    if (!(rf > 0.2 * ra)) throw ctx.fail("The teeth are too tall for this diameter.");
    // the face of tooth n runs from the root to the tip; raked, its root is turned back under the tip
    const under = Math.asin(Math.min(0.9, (ra / rf) * Math.sin(rake))) - rake;   // the angle at the centre between the tip and the foot of a raked face
    if (under > step * 0.6) throw ctx.fail("The rake undercuts the teeth away. Use less rake or fewer teeth.");
    const m = p.reverse ? -1 : 1, flip = (q: P2): P2 => [q[0], m * q[1]];
    const pen = new Pen(flip(polar(rf, under)));
    for (let i = 0; i < z; i++) {
      const a = i * step, n = `t${i + 1}`;
      pen.line(flip(polar(ra, a)), `${n}:face`).line(i === z - 1 ? pen.start : flip(polar(rf, a + step + under)), `${n}:back`);
    }
    const sp = spaceOf(ctx, p);
    const body = wheel(ctx, sp, pen.close("back"), { thickness, inside: rf, prefix: id }, p);
    ctx.addBody(body.shape, body.names);
    if (!p.pawl) return;
    const L = positive(ctx, p.pawlLength, "The pawl's length"), gap = 0.05;
    const hole = Math.max(0, num(p.pawlPivot)), boss = Math.max(hole / 2 + 1.5, h * 0.9);
    // the nose lies on the face of tooth 1 (which is on the x axis), a hair off it; the pawl leaves it rising more steeply than the next tooth's back
    const F = polar(rf, under), T: P2 = [ra, 0], len = Math.hypot(T[0] - F[0], T[1] - F[1]);
    const f: P2 = [(T[0] - F[0]) / len, (T[1] - F[1]) / len], off: P2 = [f[1], -f[0]];   // along the face, and out of it into the gap
    const on = (along: number): P2 => [F[0] + f[0] * along + off[0] * gap, F[1] + f[1] * along + off[1] * gap];
    const foot = on(0.15 * h), tip = on(len + 0.1 * h), mid = on(len / 2);
    const backSlope = Math.atan2(h, rf * step), climb = backSlope + rad(12);
    const d: P2 = [Math.sin(climb), -Math.cos(climb)];   // from the nose to the pivot: back along the rim, and outwards
    const pivot: P2 = [mid[0] + d[0] * L, mid[1] + d[1] * L], nrm: P2 = [d[1], -d[0]];
    if (!(L > boss + h)) throw ctx.fail(`The pawl must be longer than ${(boss + h).toFixed(1)} mm.`);
    const out = new Pen(flip(foot));
    out.line(flip(tip), "nose").line(flip([pivot[0] - nrm[0] * boss, pivot[1] - nrm[1] * boss]), "over")
      .arc(flip([pivot[0] + d[0] * boss, pivot[1] + d[1] * boss]), flip([pivot[0] + nrm[0] * boss, pivot[1] + nrm[1] * boss]), "boss");
    const pawl = prismOf(ctx, sp, out.close("under"), hole > 0 ? [circleLoop(hole / 2, "pivot", flip(pivot))] : [], 0, thickness, `${id}:pawl`);
    ctx.addBody(pawl.shape, pawl.names, { suffix: "pawl", name: `Pawl (${ctx.feature.name})` });
  },
});
