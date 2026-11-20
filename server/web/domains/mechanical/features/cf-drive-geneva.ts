// cf-drive-geneva.ts — Geneva wheel (Maltese cross): a wheel with radial slots that a crank's pin turns one
// step per revolution and a locking disc holds still in between; and the crank, as a second body.
//
// From the number of slots n and the centre distance c: the crank's pin runs on radius a = c·sin(180° / n), the
// wheel's radius is b = c·cos(180° / n), so the pin enters and leaves each slot along the slot.  The slots are
// as wide as the pin plus the clearance and reach in to c − a (the pin's nearest approach) plus half a pin.
// The crank's locking disc fits the hollows between the slots; it is cut away where the wheel's arms pass.
//
// Placed: the wheel at the plane's origin with a slot along x, the crank at (c, 0) with its pin in that slot
// (the middle of a step).  The wheel and the locking disc share a layer; the crank's plate lies under it.
//
// Names: `<id>:slot<n>:a` / `:b` / `:end`, `<id>:rim<n>:a` / `:b`, `<id>:lock<n>` (the hollow after slot n),
// `<id>:bottom`, `<id>:top`, `<id>:bore`; the crank's `<id>:crank:plate:…`, `:crank:lock:…`, `:crank:pin:…`,
// `:crank:bore`.  Nothing is cut: the wheel's outline is drawn whole and the crank is sewn from its faces.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { circleLoop, faceOf, Pen, polar, prismOf, rot2, sewSolid, wallOf, type Loop, type NamedFace, type P2 } from "../kernel/ops/cf-drive";
import { boreOf, DRIVES, num, placedDefaults, placedFields, positive, SECTION, spaceOf, whole, type Placed } from "./_cf-drive";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface GenevaParams extends Placed { [key: string]: any; slots: number; centres: number; pin: number; clearance: number; thickness: number; plate: number; bore: number; crankBore: number; crank: boolean }

export default defineFeature<GenevaParams>({
  type: "cf-geneva",
  title: "Geneva wheel",
  icon: '<path class="f" d="M12 3l1.2 5.5a4 4 0 0 1 2.3 2.3L21 12l-5.5 1.2a4 4 0 0 1-2.3 2.3L12 21l-1.2-5.5a4 4 0 0 1-2.3-2.3L3 12l5.5-1.2a4 4 0 0 1 2.3-2.3z"/><path d="M12 3l1.2 5.5a4 4 0 0 1 2.3 2.3L21 12l-5.5 1.2a4 4 0 0 1-2.3 2.3L12 21l-1.2-5.5a4 4 0 0 1-2.3-2.3L3 12l5.5-1.2a4 4 0 0 1 2.3-2.3z"/><circle class="s" cx="19.5" cy="5" r="1.6"/>',
  hint: "A Geneva (Maltese cross) wheel and its crank: one step per turn, locked in between",
  keywords: "geneva wheel geneva drive maltese cross intermittent indexing mechanism crank pin",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 31, toolbarKeep: 0,
  defaults: () => ({ slots: 6, centres: 50, pin: 5, clearance: 0.2, thickness: 6, plate: 4, bore: 6, crankBore: 6, crank: true, ...placedDefaults() }),
  schema: [
    { key: "slots", label: "Slots", kind: "number", unit: "none", min: 3, max: 18, step: 1 },
    { key: "centres", label: "Centre distance", kind: "number", unit: "mm", min: 1, step: 1, hint: "From the wheel's axis to the crank's." },
    { key: "pin", label: "Pin diameter", kind: "number", unit: "mm", min: 0.1, step: 0.5 },
    { key: "clearance", label: "Clearance", kind: "number", unit: "mm", min: 0, max: 2, step: 0.05, hint: "Between the pin and the slot, and between the locking disc and the wheel." },
    { key: "thickness", label: "Thickness", kind: "number", unit: "mm", min: 0.1, step: 1 },
    { key: "bore", label: "Wheel bore", kind: "number", unit: "mm", min: 0, step: 1 },
    { key: "crank", label: "With the crank", kind: "boolean" },
    { key: "plate", label: "Crank plate thickness", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => !!p.crank },
    { key: "crankBore", label: "Crank bore", kind: "number", unit: "mm", min: 0, step: 1, visible: (p) => !!p.crank },
    ...placedFields,
  ],
  evaluate(ctx: EvalContext, p: GenevaParams) {
    const id = ctx.feature.id;
    const n = whole(ctx, p.slots, "The number of slots", 3, 18);
    const c = positive(ctx, p.centres, "The centre distance"), pin = positive(ctx, p.pin, "The pin diameter"), thickness = positive(ctx, p.thickness, "The thickness");
    const clr = Math.min(2, Math.max(0, num(p.clearance)));
    const a = c * Math.sin(Math.PI / n), b = c * Math.cos(Math.PI / n);
    const lock = a - 1.5 * pin;   // the locking disc's radius, the classic proportion
    const slotW = pin + 2 * clr, inner = c - a - pin / 2 - clr;   // where the slot's round end stops
    if (!(lock > c - b + 0.5 * pin)) throw ctx.fail(`The pin is too thick for ${n} slots at this centre distance: the locking disc would not reach the wheel. Use a pin under ${Math.max(0, (a - (c - b)) / 2).toFixed(1)} mm.`);
    if (!(inner > 0.6 * pin)) throw ctx.fail("The slots would meet at the centre. Use a larger centre distance or a thinner pin.");
    const bore = boreOf(ctx, { bore: p.bore }, inner - 0.5);
    const sp = spaceOf(ctx, p);
    // the wheel's outline, slot by slot: down one side of the slot, round its end, back up, along the rim, round the hollow the locking disc turns in, along the rim again
    const L = lock + clr, half = Math.PI / n, sigma = Math.asin(slotW / (2 * b)), delta = Math.acos((b * b + c * c - L * L) / (2 * b * c));
    if (!(sigma < half - delta - 1e-3)) throw ctx.fail("The locking disc would cut into the slots. Use a thicker pin or a smaller clearance.");
    const xr = Math.sqrt(b * b - (slotW * slotW) / 4);
    const pen = new Pen([xr, -slotW / 2]);
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / n, T = (q: P2) => rot2(q, t), s = `slot${i + 1}`;
      pen.line(T([inner + slotW / 2, -slotW / 2]), `${s}:a`).arc(T([inner, 0]), T([inner + slotW / 2, slotW / 2]), `${s}:end`).line(T([xr, slotW / 2]), `${s}:b`)
        .arcAbout([0, 0], polar(b, t + half - delta), `rim${i + 1}:a`, true).arc(polar(c - L, t + half), polar(b, t + half + delta), `lock${i + 1}`)
        .arcAbout([0, 0], i === n - 1 ? pen.start : rot2([xr, -slotW / 2], t + 2 * half), `rim${i + 1}:b`, true);
    }
    const wheelBody = prismOf(ctx, sp, pen.close("rim"), bore ? [bore] : [], 0, thickness, id);
    ctx.addBody(wheelBody.shape, wheelBody.names);
    if (!p.crank) return;
    const plate = positive(ctx, p.plate, "The crank plate's thickness");
    const at = sp.at([c, 0, 0]);
    const cb = boreOf(ctx, { bore: p.crankBore }, lock - 0.5), through = cb ? [cb] : [];
    // the locking disc, cut away by a circle of the wheel's radius about the wheel's axis (at (−c, 0) from here)
    const x = (lock * lock - (b + clr) * (b + clr) + c * c) / (2 * c), y = Math.sqrt(Math.max(0, lock * lock - x * x));
    const disc = new Pen([-x, y]);
    disc.arc([lock, 0], [-x, -y], "side").arc([-c + b + clr, 0], [-x, y], "relief");
    const lockLoop: Loop = disc.close("relief"), plateLoop = circleLoop(a + pin, "side"), pinLoop = circleLoop(pin / 2, "side", [-a, 0]);
    // the crank is sewn from its faces: the plate, and on it the locking disc and the pin
    const faces: NamedFace[] = [
      ...wallOf(ctx, at, plateLoop, -plate, plate, (l) => `${id}:crank:plate:${l}`),
      { face: faceOf(ctx, at, plateLoop, through, -plate).face, name: `${id}:crank:plate:bottom` },
      { face: faceOf(ctx, at, plateLoop, [lockLoop, pinLoop], 0).face, name: `${id}:crank:plate:top` },
      ...wallOf(ctx, at, lockLoop, 0, thickness, (l) => `${id}:crank:lock:${l}`),
      { face: faceOf(ctx, at, lockLoop, through, thickness).face, name: `${id}:crank:lock:top` },
      ...wallOf(ctx, at, pinLoop, 0, thickness, (l) => `${id}:crank:pin:${l}`),
      { face: faceOf(ctx, at, pinLoop, [], thickness).face, name: `${id}:crank:pin:top` },
      ...(cb ? wallOf(ctx, at, cb, -plate, plate + thickness, () => `${id}:crank:bore`) : []),
    ];
    const crank = sewSolid(ctx, faces, "crank");
    ctx.addBody(crank.shape, crank.names, { suffix: "crank", name: `Crank (${ctx.feature.name})` });
  },
});
