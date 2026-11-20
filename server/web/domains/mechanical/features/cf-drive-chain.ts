// cf-drive-chain.ts — Roller chain: a closed chain round two sprockets, drawn link by link (rollers, and the
// inner and outer link plates), as one body.  Sprocket 1 is at the plane's origin, sprocket 2 along x.  Sized
// by the number of links (the centre distance follows) or by a centre distance (the chain takes the nearest
// even number of links and the centres move to suit).  The body is named after what came out:
// "Chain 08B, 62 links, centres 233.75 mm" — put sprocket 2 there.
//
// The rollers are exactly one pitch apart, chord to chord, along the pitch circles and the tangents between
// them: on a sprocket that is one tooth, so they sit in the seats of a sprocket made with the Chain sprocket
// feature (a roller sits in sprocket 1's seat nearest the −x axis).  The centre distance is the one at which
// the chain closes on itself.  A real chain's free strands run straight from seat to seat, a little inside the
// tangent (by the chordal rise, pitch radius × (1 − cos(180° / teeth))); the drawn strand is on the tangent,
// which puts the centre distance within a few hundredths of a millimetre of the seated one.
//
// Names: `<id>:r<n>:…` (roller n: `side`, `bottom`, `top`), `<id>:l<n>:a:…` / `:b:…` (the two plates of link n).
import { defineFeature } from "../core/feature";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import { circleLoop, Pen, prismOf, Space, together, type P2 } from "../kernel/ops/cf-drive";
import { DRIVES, num, placedDefaults, placedFields, positive, SECTION, spaceOf, whole, type Placed } from "./_cf-drive";
import { CHAINS } from "./_cf-drive-data";
import { centresFor, loopPath, type LoopPath } from "./_cf-drive-path";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ChainParams extends Placed { [key: string]: any; chain: string; teeth1: number; teeth2: number; sizeBy: "links" | "centres"; links: number; centres: number; plates: boolean; lift: number }

/** Where the rollers are: `n` points one pitch apart (chord) along the path from `s0`, and how far past the start the last step ends. */
function march(path: LoopPath, s0: number, pitch: number, n: number): { at: P2[]; over: number } {
  const at: P2[] = [];
  let s = s0;
  for (let i = 0; i < n; i++) {
    const a = path.at(s).p; at.push(a);
    let lo = s + pitch * 0.999, hi = s + pitch * 1.6;
    for (let j = 0; j < 44; j++) { const m = (lo + hi) / 2, q = path.at(m).p; if (Math.hypot(q[0] - a[0], q[1] - a[1]) < pitch) lo = m; else hi = m; }
    s = (lo + hi) / 2;
  }
  return { at, over: s - s0 - path.length };
}

export default defineFeature<ChainParams>({
  type: "cf-chain",
  title: "Roller chain",
  icon: '<path class="f" d="M5 9.5h5a2.5 2.5 0 0 1 0 5H5a2.5 2.5 0 0 1 0-5zM14 9.5h5a2.5 2.5 0 0 1 0 5h-5a2.5 2.5 0 0 1 0-5z"/><path d="M5 9.5h5a2.5 2.5 0 0 1 0 5H5a2.5 2.5 0 0 1 0-5zM14 9.5h5a2.5 2.5 0 0 1 0 5h-5a2.5 2.5 0 0 1 0-5z"/><path class="t" d="M10 11h4M10 13h4"/><circle class="s" cx="5" cy="12" r="1"/><circle class="s" cx="10" cy="12" r="1"/><circle class="s" cx="14" cy="12" r="1"/><circle class="s" cx="19" cy="12" r="1"/>',
  hint: "A closed roller chain round two sprockets, link by link, by links or centre distance",
  keywords: "roller chain chain path chain loop links ANSI ISO 08B bike chain drive chain length",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 21, toolbarKeep: 0,
  defaults: () => ({ chain: "08B", teeth1: 18, teeth2: 18, sizeBy: "links", links: 40, centres: 140, plates: true, lift: 3.6, ...placedDefaults() }),
  schema: [
    { key: "chain", label: "Chain", kind: "enum", options: Object.entries(CHAINS).map(([value, c]) => ({ value, label: c.label })) },
    { key: "teeth1", label: "Sprocket 1 teeth", kind: "number", unit: "none", min: 6, max: 200, step: 1 },
    { key: "teeth2", label: "Sprocket 2 teeth", kind: "number", unit: "none", min: 6, max: 200, step: 1 },
    { key: "sizeBy", label: "Size by", kind: "enum", options: [{ value: "links", label: "Links" }, { value: "centres", label: "Centre distance" }] },
    { key: "links", label: "Links", kind: "number", unit: "none", min: 8, max: 400, step: 2, hint: "An even number: an odd one needs an offset link.", visible: (p) => p.sizeBy !== "centres" },
    { key: "centres", label: "Centre distance", kind: "number", unit: "mm", min: 1, step: 5, hint: "The chain takes the nearest even number of links; the body's name says where the centres end up.", visible: (p) => p.sizeBy === "centres" },
    { key: "plates", label: "Link plates", kind: "boolean", hint: "Off draws the rollers alone, which is quicker." },
    { key: "lift", label: "Height above the plane", kind: "number", unit: "mm", step: 0.5, hint: "Of the chain's middle: half the sprocket's thickness puts it on sprockets standing on the same plane." },
    ...placedFields,
  ],
  evaluate(ctx: EvalContext, p: ChainParams) {
    const id = ctx.feature.id;
    const c = CHAINS[p.chain];
    if (!c) throw ctx.fail("Pick a chain size.");
    const z1 = whole(ctx, p.teeth1, "Sprocket 1's number of teeth", 6, 200), z2 = whole(ctx, p.teeth2, "Sprocket 2's number of teeth", 6, 200);
    const r1 = c.p / (2 * Math.sin(Math.PI / z1)), r2 = c.p / (2 * Math.sin(Math.PI / z2));
    const least = r1 + r2 + c.p;
    let n: number;
    if (p.sizeBy === "centres") {
      const want = positive(ctx, p.centres, "The centre distance");
      if (want < least) throw ctx.fail(`The sprockets would overlap: the centre distance must be at least ${least.toFixed(1)} mm.`);
      n = 2 * Math.round(loopPath(r1, r2, want).length / c.p / 2);
    } else n = whole(ctx, p.links, "The number of links", 8, 400);
    if (n > 400) throw ctx.fail("That chain has more than 400 links. Bring the sprockets closer.");
    if (n % 2) ctx.warn("An odd number of links needs an offset (cranked) link to close; the chain is drawn with plain links.");
    // the centre distance at which n links close: near the one whose pitch-circle path is n pitches long
    const guess = centresFor(r1, r2, n * c.p);
    if (guess === null || guess < least - c.p) throw ctx.fail(`A chain of ${n} links is too short to go round these sprockets.`);
    const seat = (Math.round(z1 / 2) * 2 * Math.PI) / z1;
    const over = (centres: number) => { const path = loopPath(r1, r2, centres); return march(path, path.onWheel1(seat), c.p, n).over; };
    let lo = Math.max(Math.abs(r2 - r1) + 0.01, guess - c.p), hi = guess + c.p;
    if (!(over(lo) > 0 && over(hi) < 0)) throw ctx.fail("The chain could not be closed round these sprockets. Try another number of links.");
    for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (over(m) > 0) lo = m; else hi = m; }
    const centres = (lo + hi) / 2;
    if (centres < least) throw ctx.fail(`A chain of ${n} links is too short: the sprockets would overlap. Use at least ${2 * Math.ceil(loopPath(r1, r2, least).length / c.p / 2)} links.`);
    const path = loopPath(r1, r2, centres), at = march(path, path.onWheel1(seat), c.p, n).at;

    const sp = spaceOf(ctx, p).at([0, 0, num(p.lift)]), t = Math.round(c.p * 12.5) / 100;
    const parts: NamedResult[] = [];
    // a link plate: a slot shape round two rollers, drawn from the first towards the second along x
    const half = c.h / 2, pen = new Pen([0, -half]);
    pen.line([c.p, -half], "under").arc([c.p + half, 0], [c.p, half], "end2").line([0, half], "over").arc([-half, 0], [0, -half], "end1");
    const plate = pen.close("end1");
    at.forEach((q, i) => {
      const here = sp.at([q[0], q[1], 0]);
      parts.push(prismOf(ctx, here, circleLoop(c.d1 / 2, "side"), [], -c.b1 / 2, c.b1, `${id}:r${i + 1}`));
      if (!p.plates) return;
      const next = at[(i + 1) % n], a = Math.atan2(next[1] - q[1], next[0] - q[0]);
      const along: Space = here.rotZ(a), off = c.b1 / 2 + (i % 2 ? t : 0) + 0.02;
      parts.push(prismOf(ctx, along, plate, [], off, t, `${id}:l${i + 1}:a`), prismOf(ctx, along, plate, [], -off - t, t, `${id}:l${i + 1}:b`));
    });
    const all = together(ctx, parts);
    ctx.addBody(all.shape, all.names, { name: `Chain ${p.chain}, ${n} links, centres ${centres.toFixed(2)} mm (${ctx.feature.name})` });
  },
});
