// cf-drive-timing-belt.ts — Timing belt: a closed toothed belt round two pulleys of the same profile.  Pulley 1
// is at the plane's origin, pulley 2 along x.  Sized by the belt's number of teeth (the centre distance follows)
// or by a centre distance (the belt gets the nearest whole number of teeth and the centres move to suit).  The
// body is named after what came out: "Belt 100T, centres 67.89 mm" — put pulley 2 there.
//
// The belt's pitch line runs round the pulleys' pitch circles and straight between them; each tooth is the
// profile's own (the shape a pulley's groove is cut to), laid along the pitch line, a tooth centred on the
// plane's −x axis at pulley 1, where a pulley made with these features has a groove when turned 180° / teeth
// for an odd tooth count (even counts already have one there).
//
// Names: `<id>:back:…` (the smooth outside), `<id>:t<n>:a` / `:b` / `:floor` / `:land`, `<id>:bottom`, `<id>:top`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { Pen, prismOf, type P2 } from "../kernel/ops/cf-drive";
import { DRIVES, num, placedDefaults, placedFields, positive, SECTION, spaceOf, whole, type Placed } from "./_cf-drive";
import { BELTS } from "./_cf-drive-data";
import { centresFor, loopPath, toothShape } from "./_cf-drive-path";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TimingBeltParams extends Placed { [key: string]: any; profile: string; teeth1: number; teeth2: number; sizeBy: "teeth" | "centres"; beltTeeth: number; centres: number; width: number; lift: number }

export default defineFeature<TimingBeltParams>({
  type: "cf-timing-belt",
  title: "Timing belt",
  icon: '<path class="f" d="M7 6.5h10a5.5 5.5 0 0 1 0 11H7a5.5 5.5 0 0 1 0-11z"/><path d="M7 6.5h10a5.5 5.5 0 0 1 0 11H7a5.5 5.5 0 0 1 0-11z"/><circle cx="7" cy="12" r="2.6"/><circle cx="17" cy="12" r="2.6"/><path class="t" d="M9 8.6v1.2M12 8.6v1.2M15 8.6v1.2M9 14.2v1.2M12 14.2v1.2M15 14.2v1.2"/>',
  hint: "A closed toothed belt round two pulleys, by belt teeth or centre distance",
  keywords: "timing belt toothed belt GT2 GT3 HTD T5 synchronous belt loop closed belt length",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 11, toolbarKeep: 0,
  defaults: () => ({ profile: "GT2", teeth1: 20, teeth2: 40, sizeBy: "teeth", beltTeeth: 100, centres: 70, width: 6, lift: 1.5, ...placedDefaults() }),
  schema: [
    { key: "profile", label: "Profile", kind: "enum", options: Object.entries(BELTS).map(([value, b]) => ({ value, label: b.label })) },
    { key: "teeth1", label: "Pulley 1 teeth", kind: "number", unit: "none", min: 8, max: 400, step: 1 },
    { key: "teeth2", label: "Pulley 2 teeth", kind: "number", unit: "none", min: 8, max: 400, step: 1 },
    { key: "sizeBy", label: "Size by", kind: "enum", options: [{ value: "teeth", label: "Belt teeth" }, { value: "centres", label: "Centre distance" }] },
    { key: "beltTeeth", label: "Belt teeth", kind: "number", unit: "none", min: 10, max: 2000, step: 1, visible: (p) => p.sizeBy !== "centres" },
    { key: "centres", label: "Centre distance", kind: "number", unit: "mm", min: 1, step: 1, hint: "The belt takes the nearest whole number of teeth; the body's name says where the centres end up.", visible: (p) => p.sizeBy === "centres" },
    { key: "width", label: "Belt width", kind: "number", unit: "mm", min: 0.5, step: 1 },
    { key: "lift", label: "Height above the plane", kind: "number", unit: "mm", step: 0.5, hint: "A flanged pulley made here carries its belt half a millimetre above its lower flange." },
    ...placedFields,
  ],
  evaluate(ctx: EvalContext, p: TimingBeltParams) {
    const id = ctx.feature.id;
    const belt = BELTS[p.profile];
    if (!belt) throw ctx.fail("Pick a belt profile.");
    const z1 = whole(ctx, p.teeth1, "Pulley 1's number of teeth", 8, 400), z2 = whole(ctx, p.teeth2, "Pulley 2's number of teeth", 8, 400);
    const width = positive(ctx, p.width, "The belt width");
    const pitch = belt.pitch, r1 = (z1 * pitch) / (2 * Math.PI), r2 = (z2 * pitch) / (2 * Math.PI);
    const least = r1 + r2 + 2 * belt.back + pitch;   // the pulleys must not touch
    let n: number;
    if (p.sizeBy === "centres") {
      const want = positive(ctx, p.centres, "The centre distance");
      if (want < least) throw ctx.fail(`The pulleys would overlap: the centre distance must be at least ${least.toFixed(1)} mm.`);
      n = Math.round(loopPath(r1, r2, want).length / pitch);
    } else n = whole(ctx, p.beltTeeth, "The belt's number of teeth", 10, 2000);
    if (n > 2000) throw ctx.fail("That belt has more than 2000 teeth. Bring the pulleys closer.");
    const centres = centresFor(r1, r2, n * pitch);
    if (centres === null || centres < least) {
      const min = Math.ceil(loopPath(r1, r2, least).length / pitch);
      throw ctx.fail(`A belt of ${n} teeth is too short to go round these pulleys: it needs at least ${min}.`);
    }
    const path = loopPath(r1, r2, centres), tooth = toothShape(belt.tooth);
    // the smooth back: the path moved out
    const out = belt.back - belt.pld, off = (s: number, d: number): P2 => { const q = path.at(s); return [q.p[0] + q.n[0] * d, q.p[1] + q.n[1] * d]; };
    const [a1, l1, a2] = path.pieces, ends = [0, a1, a1 + l1, a1 + l1 + a2, path.length];
    const back = new Pen(off(0, out));
    back.arc(off(a1 / 2, out), off(a1, out), "back:wheel1").line(off(ends[2], out), "back:span1").arc(off(ends[2] + a2 / 2, out), off(ends[3], out), "back:wheel2");
    const outer = back.close("back:span2");
    // the teeth: each drawn along the pitch line, a tooth centred where pulley 1 points along −x
    const s0 = path.onWheel1(Math.PI) % pitch;
    const place = (sc: number) => (q: P2): P2 => off(sc + q[0], -(belt.pld - q[1]));
    const pen = new Pen(place(s0)(tooth.start));
    for (let i = 0; i < n; i++) {
      const sc = s0 + i * pitch, t = `t${i + 1}`;
      pen.append(tooth.start, tooth.segs, place(sc), (l) => `${t}:${l}`);
      // the land to the next tooth: straight on a span, an arc on a pulley
      const from = sc + tooth.w, to = sc + pitch - tooth.w;
      const next = i === n - 1 ? pen.start : place(sc + pitch)(tooth.start);
      pen.arc(off((from + to) / 2, -belt.pld), next, `${t}:land`);
    }
    const body = prismOf(ctx, spaceOf(ctx, p), outer, [pen.close("land")], num(p.lift), width, id);
    ctx.addBody(body.shape, body.names, { name: `Belt ${n}T, centres ${centres.toFixed(2)} mm (${ctx.feature.name})` });
  },
});
