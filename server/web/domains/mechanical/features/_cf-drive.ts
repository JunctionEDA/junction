// _cf-drive.ts — what the power transmission features (cf-drive-*.ts) share: where a part is placed, the
// involute tooth, the body of a wheel (teeth, bore, keyway, hub), and how the result joins the model.
//
// Placement: every feature that makes a part stands on a plane (a default plane, a reference plane or a flat
// face), `x`, `y` across it and turned by `angle`; the part's axis is the plane's normal.
//
// The involute: a tooth flank is the involute of the base circle (radius r·cos α), drawn through points of the
// true curve.  The tooth is as thick at the pitch circle as the standard says (half the pitch, more by the
// profile shift, less by the backlash), the root is rounded by an arc tangent to the flank and to the root
// circle, and below the base circle (few teeth) the flank goes on as a radial line.
import type { ParamField } from "../core/feature";
import { add, scale, type GeomRef, type PlaneRef } from "../core/geometry";
import type { NamedResult } from "../kernel/occ";
import type { Body, EvalContext } from "../kernel/types";
import { combine, type Operation } from "../kernel/ops/combine";
import { bool, circleLoop, isBore, Pen, polar, prismOf, Space, stackOf, twistOf, type Loop, type P2 } from "../kernel/ops/cf-drive";
import { extentAlong } from "../kernel/ops/frame";
import { canonical, faceInfo } from "../kernel/ops/ref-geom";
import { keyFor } from "./_cf-drive-data";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const SECTION = "library" as const;
export const GEARS = "Gears";
export const DRIVES = "Power transmission";

export const rad = (deg: number) => (deg * Math.PI) / 180;
export const deg = (r: number) => (r * 180) / Math.PI;
export const num = (v: unknown, d = 0) => (typeof v === "number" && isFinite(v) ? v : d);

// ------------------------------------------------------------------ placement and result

export interface Placed { plane: PlaneRef; x: number; y: number; angle: number }
export const placedDefaults = (): Placed => ({ plane: { kind: "plane", plane: "top" }, x: 0, y: 0, angle: 0 });
export const placedFields: ParamField[] = [
  { key: "plane", label: "On", kind: "plane", hint: "The plane or flat face it stands on; its axis is the normal." },
  { key: "x", label: "X", kind: "number", unit: "mm", step: 1 },
  { key: "y", label: "Y", kind: "number", unit: "mm", step: 1 },
  { key: "angle", label: "Turned", kind: "number", unit: "deg", step: 5 },
];
export function spaceOf(ctx: EvalContext, p: Partial<Placed>): Space {
  const f = ctx.frameOf(p.plane || { kind: "plane", plane: "top" });
  return Space.of(f).at([num(p.x), num(p.y), 0]).rotZ(rad(num(p.angle)));
}

export const makeField: ParamField = { key: "operation", label: "Result", kind: "enum", options: [{ value: "new", label: "New" }, { value: "add", label: "Add" }] };
export const cutField: ParamField = { key: "operation", label: "Result", kind: "enum", options: [{ value: "new", label: "New" }, { value: "add", label: "Add" }, { value: "remove", label: "Remove" }] };
/** Put what a feature made into the model: new bodies, joined to what they touch, or cut away. */
export function finish(ctx: EvalContext, parts: readonly (NamedResult & { suffix?: string; name?: string })[], operation: unknown): void {
  const op: Operation = operation === "add" || operation === "remove" ? operation : "new";
  if (op === "new") { parts.forEach((t) => ctx.addBody(t.shape, t.names, { suffix: parts.length > 1 ? t.suffix : undefined })); return; }
  combine(ctx, parts, op, []);
}

/** Fail with a sentence unless a number is a positive size. */
export function positive(ctx: EvalContext, v: unknown, what: string): number {
  if (!(typeof v === "number" && isFinite(v) && v > 0)) throw ctx.fail(`${what} must be more than zero.`);
  return v;
}
export function whole(ctx: EvalContext, v: unknown, what: string, min: number, max: number): number {
  const n = Math.round(num(v, NaN));
  if (!(n >= min && n <= max)) throw ctx.fail(`${what} must be a whole number from ${min} to ${max}.`);
  return n;
}

// ------------------------------------------------------------------ the involute tooth

export const inv = (a: number) => Math.tan(a) - a;

/** One gear's teeth in its transverse plane. */
export interface Teeth {
  /** number of teeth */
  z: number;
  /** pitch radius */
  r: number;
  /** transverse pressure angle (radians) */
  alpha: number;
  /** tooth height above and below the pitch circle */
  ha: number; hf: number;
  /** tooth thickness along the pitch circle */
  s: number;
  /** root fillet radius (0: a sharp root) */
  fillet: number;
  /** the angle tooth 1 is centred on (radians) */
  phase?: number;
}

/** Half the angle a tooth takes up at radius `rho`. */
export function halfAngle(t: Teeth, rho: number): number {
  const rb = t.r * Math.cos(t.alpha);
  const psi = t.s / (2 * t.r) + inv(t.alpha);
  return rho <= rb ? psi : psi - inv(Math.acos(Math.min(1, rb / rho)));
}

/** The tip radius the teeth can have: the nominal one, or less where the flanks would cross (a pointed tooth). */
export function tipRadius(t: Teeth): { ra: number; pointed: boolean } {
  const ra = t.r + t.ha, land = 0.02 * t.s / t.r;
  if (halfAngle(t, ra) > land) return { ra, pointed: false };
  let lo = t.r, hi = ra;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (halfAngle(t, m) > land) lo = m; else hi = m; }
  return { ra: lo, pointed: true };
}

/**
 * The outline of a gear's teeth, counter-clockwise.  Labels: `t<n>:a` and `:b` the two flanks, `:tip`, `:root`
 * (the root land after the tooth), `:fa` / `:fb` the root fillets, `:ua` / `:ub` the radial part below the base
 * circle.
 */
export function gearLoop(t: Teeth): Loop {
  const rb = t.r * Math.cos(t.alpha), rf = t.r - t.hf, { ra } = tipRadius(t);
  const step = (2 * Math.PI) / t.z, half = step / 2;
  const flank = (rho: number): P2 => polar(rho, halfAngle(t, rho));   // the left flank of a tooth centred on angle 0
  // the root fillet: a circle of radius q that touches the root circle and the flank
  let q = Math.max(0, t.fillet), phiC = halfAngle(t, rf), touch = rf;
  if (q > 1e-6) {
    const nearest = (c: P2): { d: number; rho: number } => {
      let lo = rf, hi = Math.min(ra, rf + 4 * q + t.hf);
      const d = (rho: number) => { const f = flank(rho); return Math.hypot(f[0] - c[0], f[1] - c[1]); };
      for (let i = 0; i < 48; i++) { const a = lo + (hi - lo) * 0.382, b = lo + (hi - lo) * 0.618; if (d(a) < d(b)) hi = b; else lo = a; }
      return { d: d((lo + hi) / 2), rho: (lo + hi) / 2 };
    };
    // no room for the fillet in the gap: the largest that fits, leaving a sliver of root land
    const room = nearest(polar(rf + q, half)).d;
    if (room < q) {
      let lo = 0, hi = q;
      for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (nearest(polar(rf + m, half * 0.995)).d >= m) lo = m; else hi = m; }
      q = lo;
    }
    if (q > 1e-6) {
      let lo = halfAngle(t, rf), hi = half;
      for (let i = 0; i < 48; i++) { const m = (lo + hi) / 2; if (nearest(polar(rf + q, m)).d < q) lo = m; else hi = m; }
      phiC = (lo + hi) / 2; touch = nearest(polar(rf + q, phiC)).rho;
    }
  }
  if (!(q > 1e-6)) { q = 0; phiC = halfAngle(t, rf); touch = rf; }
  // the involute from where it starts (the base circle, or the fillet) to the tip, by roll angle
  const from = Math.max(rb, touch), N = 8;
  const t0 = Math.sqrt(Math.max(0, (from / rb) ** 2 - 1)), t1 = Math.sqrt(Math.max(0, (ra / rb) ** 2 - 1));
  const inv0: P2[] = [];
  for (let i = 0; i <= N; i++) { const u = t0 + ((t1 - t0) * i) / N; inv0.push(flank(i === N ? ra : i === 0 ? from : rb * Math.sqrt(1 + u * u))); }
  const mirror = (p: P2): P2 => [p[0], -p[1]];
  const turn = (p: P2, a: number): P2 => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]; };
  const phase = t.phase || 0;
  const pen = new Pen(turn(polar(rf, -phiC), phase));
  for (let i = 0; i < t.z; i++) {
    const a = phase + i * step, n = `t${i + 1}`;
    const L = (p: P2) => turn(p, a), R = (p: P2) => turn(mirror(p), a);
    // up the right side
    if (q) pen.arcAbout(R(polar(rf + q, phiC)), R(flank(touch)), `${n}:fa`);
    if (touch < rb - 1e-9) pen.line(R(flank(rb)), `${n}:ua`);
    pen.spline(inv0.slice(1).map(R), `${n}:a`);
    pen.arcAbout(turn([0, 0], 0), L(flank(ra)), `${n}:tip`, true);
    // down the left side
    pen.spline(inv0.slice(0, -1).reverse().map(L), `${n}:b`);
    if (touch < rb - 1e-9) pen.line(L(flank(touch)), `${n}:ub`);
    if (q) pen.arcAbout(L(polar(rf + q, phiC)), L(polar(rf, phiC)), `${n}:fb`);
    const next = i === t.z - 1 ? pen.start : turn(polar(rf, -phiC), a + step);
    pen.arcAbout([0, 0], next, `${n}:root`, true);
  }
  return pen.close("root");
}

/** The parameters every involute gear dialog has. */
export interface GearSize { system: "module" | "dp"; module: number; dp: number; teeth: number; pressureAngle: number; shift: number; backlash: number; clearance: number }
export const gearSizeDefaults = (teeth = 20): GearSize => ({ system: "module", module: 2, dp: 12, teeth, pressureAngle: 20, shift: 0, backlash: 0, clearance: 0.25 });
export const gearSizeFields: ParamField[] = [
  { key: "system", label: "Size by", kind: "enum", options: [{ value: "module", label: "Module" }, { value: "dp", label: "Diametral pitch" }] },
  { key: "module", label: "Module", kind: "number", unit: "mm", min: 0.05, step: 0.25, hint: "Pitch diameter over the number of teeth.", visible: (p) => p.system !== "dp" },
  { key: "dp", label: "Diametral pitch", kind: "number", unit: "none", min: 0.1, step: 1, hint: "Teeth per inch of pitch diameter.", visible: (p) => p.system === "dp" },
  { key: "teeth", label: "Teeth", kind: "number", unit: "none", min: 4, max: 400, step: 1 },
  { key: "pressureAngle", label: "Pressure angle", kind: "number", unit: "deg", min: 10, max: 35, step: 0.5 },
];
export const gearFineFields: ParamField[] = [
  { key: "shift", label: "Profile shift", kind: "number", unit: "none", min: -1, max: 1, step: 0.05, hint: "In modules: positive thickens the tooth and avoids undercut on few teeth." },
  { key: "backlash", label: "Backlash", kind: "number", unit: "mm", min: 0, step: 0.02, hint: "Taken off the tooth's thickness at the pitch circle." },
  { key: "clearance", label: "Root clearance", kind: "number", unit: "none", min: 0, max: 0.5, step: 0.05, hint: "In modules: the dedendum is 1 + this." },
];
/** The module of a gear dialog's size (mm), checked. */
export function moduleOf(ctx: EvalContext, p: Partial<GearSize>): number {
  if (p.system === "dp") return 25.4 / positive(ctx, p.dp, "The diametral pitch");
  return positive(ctx, p.module, "The module");
}
/**
 * The teeth of an external involute gear: normal module `mn`, helix angle `beta` (radians; 0 for a spur gear).
 * The standard proportions: addendum one module, dedendum 1 + clearance, both moved by the profile shift.
 */
export function externalTeeth(ctx: EvalContext, p: Partial<GearSize>, mn: number, z: number, beta = 0): Teeth {
  const an = rad(num(p.pressureAngle, 20));
  if (!(an >= rad(10) && an <= rad(35))) throw ctx.fail("The pressure angle must be between 10° and 35°.");
  const x = num(p.shift), c = Math.max(0, num(p.clearance, 0.25));
  const mt = mn / Math.cos(beta), alpha = Math.atan(Math.tan(an) / Math.cos(beta));
  const r = (mt * z) / 2;
  const s = mt * (Math.PI / 2 + 2 * x * Math.tan(alpha)) - Math.max(0, num(p.backlash)) / Math.cos(beta);
  const hf = mn * (1 + c - x);
  if (!(r - hf > 0.05 * mn)) throw ctx.fail("With so few teeth nothing is left inside the roots. Use more teeth or a positive profile shift.");
  if (!(s > 0.05 * mt)) throw ctx.fail("The backlash and profile shift leave no tooth. Use less of either.");
  return { z, r, alpha, ha: mn * (1 + x), hf, s, fillet: 0.38 * mn * Math.min(1, c / 0.25) };
}

// ------------------------------------------------------------------ bores and wheels

export interface Bore { bore: number; keyway: boolean; hubDiameter: number; hubLength: number }
export const boreDefaults = (bore = 8): Bore => ({ bore, keyway: false, hubDiameter: 0, hubLength: 0 });
export const boreFields: ParamField[] = [
  { key: "bore", label: "Bore", kind: "number", unit: "mm", min: 0, step: 1, hint: "0 for none." },
  { key: "keyway", label: "Keyway", kind: "boolean", hint: "A keyway in the bore, sized by DIN 6885 for the bore's diameter (6 to 150 mm).", visible: (p) => Number(p.bore) > 0 },
  { key: "hubDiameter", label: "Hub diameter", kind: "number", unit: "mm", min: 0, step: 1, hint: "0 for no hub." },
  { key: "hubLength", label: "Hub length", kind: "number", unit: "mm", min: 0, step: 1, hint: "How far the hub stands out of the face.", visible: (p) => Number(p.hubDiameter) > 0 },
];

/** The outline of a bore of radius `R`, with a keyway at +y when a key is given: width b, depth t into the hub. */
export function boreLoop(R: number, key?: { b: number; t: number } | null): Loop {
  if (!key) return circleLoop(R, "bore");
  const yc = Math.sqrt(R * R - (key.b * key.b) / 4);
  const pen = new Pen([key.b / 2, yc]);
  pen.arc([0, -R], [-key.b / 2, yc], "bore").line([-key.b / 2, R + key.t], "key:a").line([key.b / 2, R + key.t], "key:floor");
  return pen.close("key:b");
}
/** The bore's outline from a dialog's fields (null when there is no bore), the keyway checked against the table. */
export function boreOf(ctx: EvalContext, p: Partial<Bore>, inside: number): Loop | null {
  const d = num(p.bore);
  if (!(d > 0)) return null;
  if (d >= 2 * inside) throw ctx.fail(`The bore (${d} mm) does not fit: there are only ${(2 * inside).toFixed(2)} mm inside the part.`);
  if (!p.keyway) return boreLoop(d / 2);
  const key = keyFor(d);
  if (!key) throw ctx.fail("DIN 6885 has keys for bores over 6 mm up to 150 mm. Turn the keyway off, or change the bore.");
  if (d / 2 + key.t2 >= inside) throw ctx.fail("The keyway would cut through the part. Use a smaller bore, or no keyway.");
  return boreLoop(d / 2, { b: key.b, t: key.t2 });
}

/**
 * A wheel: an outline extruded to `thickness` from z = 0 (twisted when `twist` says by how much), with the
 * dialog's bore and keyway through it and its hub on top.  `inside` is the radius the bore must stay within.
 */
export function wheel(ctx: EvalContext, sp: Space, outer: Loop, o: { thickness: number; inside: number; prefix: string; holes?: Loop[]; twist?: { steps: { h: number; turn: number }[]; guide: number } }, p: Partial<Bore>): NamedResult {
  const hubD = num(p.hubDiameter), hubL = hubD > 0 ? num(p.hubLength) : 0;
  const bore = boreOf(ctx, p, hubD > 0 && hubL > 0 ? Math.min(o.inside, hubD / 2) : o.inside);
  if (hubD > 0 && hubL > 0 && hubD / 2 > o.inside + 1e-6) throw ctx.fail(`The hub (${hubD} mm) is wider than the part inside its teeth (${(2 * o.inside).toFixed(2)} mm).`);
  const holes = [...(o.holes || []), ...(bore ? [bore] : [])];
  const hub = hubD > 0 && hubL > 0;
  if (!o.twist) {
    if (!hub) return prismOf(ctx, sp, outer, holes, 0, o.thickness, o.prefix);
    if (o.holes && o.holes.length) throw ctx.fail("A hub cannot be put on a part with holes beside its bore.");
    return stackOf(ctx, sp, [{ loop: outer, h: o.thickness, size: 2 }, { loop: circleLoop(hubD / 2, "side"), h: hubL, size: 1, name: "hub" }], holes, 0, o.prefix);
  }
  let body = twistOf(ctx, sp, outer, holes, 0, o.twist.steps, o.twist.guide, o.prefix);
  if (hub) {
    const top = prismOf(ctx, sp, circleLoop(hubD / 2, "side"), bore ? [bore] : [], o.thickness, hubL, `${o.prefix}:hub`);
    const names = top.names; top.names = (f, i) => { const n = names(f, i); return n ? n.replace(":hub:bore", ":bore").replace(":hub:key", ":key") : n; };
    body = bool(ctx, "fuse", body, top);
  }
  return body;
}

// ------------------------------------------------------------------ features on a shaft or in a bore

/** A cylindrical face a feature works on: a shaft's surface or a bore's wall. */
export interface Round {
  /** origin on the axis at the end the feature measures from, z along the axis into the face's length, x where its angle starts */
  space: Space;
  radius: number;
  /** how long the cylindrical face is along its axis */
  length: number;
  /** true for the wall of a hole */
  bore: boolean;
  body: Body;
}
export const roundField: ParamField = { key: "face", label: "Cylindrical face", kind: "refs", of: ["face"], single: true, hint: "The surface of a shaft, or the wall of a bore." };
/**
 * The cylinder a picked face lies on, measured from one of its ends, turned by `angle` degrees.  The end is the
 * one the axis leaves from when its largest component is taken as positive (the lower end of an upright shaft);
 * `flip` measures from the other.
 */
export function roundOf(ctx: EvalContext, ref: GeomRef | GeomRef[] | null | undefined, flip: unknown, angle: unknown): Round {
  const one = Array.isArray(ref) ? ref[0] : ref;
  if (!one) throw ctx.fail("Pick the cylindrical face of a shaft or of a bore.");
  const r = ctx.resolve(one);
  const info = faceInfo(ctx, r.shape);
  if (r.kind !== "face" || info.kind !== "cylinder" || !info.axis || !info.radius) throw ctx.fail("That face is not cylindrical. Pick the round surface of a shaft or of a bore.");
  // the kernel's own direction for the axis is arbitrary: the end to measure from must not depend on it
  const axis = canonical(info.axis.dir);
  const [lo, hi] = extentAlong(ctx.k, r.shape, info.axis.origin, axis);
  const dir = flip ? scale(axis, -1) : axis;
  const origin = add(info.axis.origin, scale(axis, flip ? hi : lo));
  // the angle starts from a direction that depends on the axis alone, so it stays put when the face is cut about
  const ref0 = Space.about(origin, axis);
  const space = new Space(origin, ref0.x, flip ? scale(ref0.y, -1) : ref0.y, dir).rotZ(rad(num(angle)));
  return { space, radius: info.radius, length: hi - lo, bore: isBore(ctx, r.shape, info.axis.origin), body: r.body };
}

/** Cut a tool from the one body a feature works on. */
export function cutFrom(ctx: EvalContext, body: Body, tool: NamedResult): void { combine(ctx, [tool], "remove", [body.id]); }
