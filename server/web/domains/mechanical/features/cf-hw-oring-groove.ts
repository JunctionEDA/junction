// cf-hw-oring-groove.ts — O-ring groove: the gland for an O-ring of the AS568 / ISO 3601-1 series, cut where you
// pick.
//   a shaft's round face   a groove round the shaft (a piston seal: the ring is stretched into it)
//   a hole's wall          a groove in the bore (a rod seal: the ring is squeezed into it)
//   a flat face            a ring-shaped groove in the face (a face seal), about a picked point
// The ring is the dash number you type, or, left empty, the one of the chosen cross-section that fits the
// diameter: stretched 1 to 5 % on a shaft, a little oversize in a bore.  The gland's depth, width and corner
// radius follow the Parker O-Ring Handbook's industrial glands for that cross-section, static or dynamic.
//
// Names: `<id>:floor`, `<id>:side` (two), `<id>:corner` (two).
import { defineFeature } from "../core/feature";
import { add, cross, isGeomRef, scale, type Frame, type GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { changeBody, cylinderOf, revolved, type Loop } from "../kernel/ops/cf-hw";
import { faceInfo, onPlane, pointOf } from "../kernel/ops/ref-geom";
import type { RefTarget } from "./_refs";
import { glandFor, HW_SECTION, MENU_ENCLOSURES, oringOf, ORINGS, type ORing } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ORingGrooveParams {
  [key: string]: any;
  face: GeomRef | null; dash: string; series: string; service: "static" | "dynamic";
  centred: boolean; offset: number; flip: boolean; gap: number;
  centre: RefTarget | null; diameter: number; pressure: "inside" | "outside";
}

export const ORING_SERIES = [{ value: "1.78", label: "1.78 (-0xx)" }, { value: "2.62", label: "2.62 (-1xx)" }, { value: "3.53", label: "3.53 (-2xx)" }, { value: "5.33", label: "5.33 (-3xx)" }, { value: "6.99", label: "6.99 (-4xx)" }];
/** The ring of a series whose inside diameter is nearest `want`, among those `ok` allows. */
export function nearestRing(series: unknown, want: number, ok: (o: ORing) => boolean = () => true): ORing | null {
  const cs = Number(series) || 2.62;
  const pool = ORINGS.filter((o) => Math.abs(o.cs - cs) < 0.05 && ok(o));
  return pool.length ? pool.reduce((a, b) => (Math.abs(b.id - want) < Math.abs(a.id - want) ? b : a)) : null;
}

export default defineFeature<ORingGrooveParams>({
  type: "cf-hw-oring-groove",
  title: "O-ring groove",
  icon: '<path class="f" d="M3 5h18v14H3z"/><path d="M3 5h18v14H3z"/><path d="M3 9.5h3v5H3M21 9.5h-3v5h3"/><circle class="s" cx="4.6" cy="12" r="1.5"/><circle class="s" cx="19.4" cy="12" r="1.5"/>',
  hint: "Cut the gland for a standard O-ring: round a shaft, in a bore, or in a flat face",
  keywords: "o-ring oring groove gland seal as568 iso 3601 dash piston rod face seal static dynamic",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_ENCLOSURES, toolbarOrder: 40, toolbarKeep: 0,
  defaults: () => ({ face: null, dash: "", series: "2.62", service: "static", centred: true, offset: 5, flip: false, gap: 0.05, centre: null, diameter: 30, pressure: "inside" }),
  schema: [
    { key: "face", label: "Shaft, bore or flat face", kind: "refs", of: ["face"], single: true },
    { key: "dash", label: "Dash number", kind: "text", hint: "An AS568 size such as 214. Leave empty to fit the diameter." },
    { key: "series", label: "Cross-section", kind: "enum", options: ORING_SERIES, hint: "Which series to pick from when the dash number is empty.", visible: (p) => !String(p.dash || "").trim() },
    { key: "service", label: "Service", kind: "enum", options: [{ value: "static", label: "Static" }, { value: "dynamic", label: "Dynamic" }], hint: "Dynamic: the parts slide; the ring is squeezed less. A face seal is always static." },
    { key: "centred", label: "Middle of the face", kind: "boolean", hint: "For a shaft or a bore: put the groove half way along it." },
    { key: "offset", label: "From the end", kind: "number", unit: "mm", min: 0, step: 1, hint: "To the middle of the groove.", visible: (p) => !p.centred },
    { key: "flip", label: "From the other end", kind: "boolean", visible: (p) => !p.centred },
    { key: "gap", label: "Radial clearance", kind: "number", unit: "mm", min: 0, step: 0.01, hint: "Between the shaft and its bore: the groove is cut that much shallower." },
    { key: "centre", label: "Centre (flat face)", kind: "refs", of: ["vertex", "edge"], single: true, sketch: true, datums: ["point"], hint: "For a flat face: the middle of the ring. Empty: the middle of the face." },
    { key: "diameter", label: "Diameter (flat face)", kind: "number", unit: "mm", min: 1, step: 1, hint: "For a flat face with no dash number: the groove's middle diameter." },
    { key: "pressure", label: "Pressure from (flat face)", kind: "enum", options: [{ value: "inside", label: "Inside" }, { value: "outside", label: "Outside" }], hint: "The ring sits against the wall away from the pressure." },
  ],

  evaluate(ctx: EvalContext, p: ORingGrooveParams) {
    if (!p.face || !isGeomRef(p.face)) throw ctx.fail("Pick the round face of a shaft, the wall of a bore, or a flat face.");
    const r = ctx.resolve(p.face);
    const info = faceInfo(ctx, r.shape);
    const typed = String(p.dash || "").trim();
    let ring = typed ? oringOf(typed) : null;
    if (typed && !ring) throw ctx.fail(`AS568 has no size -${typed.replace(/[^0-9]/g, "")}. The table has -001 to -050, -102 to -178, -201 to -278, -309 to -381 and -425 to -460.`);
    const gapR = Math.max(0, Number(p.gap) || 0);
    let frame: Frame, outline: Loop;
    const rounded = (inner: number, outer: number, lo: number, hi: number, rad: number, openAt: "outer" | "inner" | "top"): Loop => {
      // a rectangle in (radius, height) with the two corners of its floor rounded; `openAt` is the side left open
      const q = rad * (1 - Math.SQRT1_2);
      if (openAt === "outer") return { start: [outer, lo], segs: [{ to: [inner + rad, lo], role: "side" }, { to: [inner, lo + rad], via: [inner + q, lo + q], role: "corner" }, { to: [inner, hi - rad], role: "floor" }, { to: [inner + rad, hi], via: [inner + q, hi - q], role: "corner" }, { to: [outer, hi], role: "side" }, { to: [outer, lo], role: null }] };
      if (openAt === "inner") return { start: [inner, hi], segs: [{ to: [outer - rad, hi], role: "side" }, { to: [outer, hi - rad], via: [outer - q, hi - q], role: "corner" }, { to: [outer, lo + rad], role: "floor" }, { to: [outer - rad, lo], via: [outer - q, lo + q], role: "corner" }, { to: [inner, lo], role: "side" }, { to: [inner, hi], role: null }] };
      return { start: [inner, hi], segs: [{ to: [inner, lo + rad], role: "side" }, { to: [inner + rad, lo], via: [inner + q, lo + q], role: "corner" }, { to: [outer - rad, lo], role: "floor" }, { to: [outer, lo + rad], via: [outer - q, lo + q], role: "corner" }, { to: [outer, hi], role: "side" }, { to: [inner, hi], role: null }] };
    };
    if (info.kind === "cylinder") {
      const cyl = cylinderOf(ctx, p.face, "the face");
      const D = cyl.radius * 2;
      const depthOf = (cs: number) => { const g = glandFor(cs); return (p.service === "dynamic" ? g.dynamicDepth : g.staticDepth) - gapR; };
      if (!ring) {
        // on a shaft the ring is stretched 1 to 5 % over the groove's floor; in a bore its outside is up to 3 % over the groove's
        const cs = Number(p.series) || 2.62, floor = cyl.hole ? D + 2 * depthOf(cs) : D - 2 * depthOf(cs);
        ring = cyl.hole ? nearestRing(p.series, floor - 2 * cs, (o) => o.id + 2 * o.cs >= floor && o.id + 2 * o.cs <= floor * 1.03 + 0.3)
          : nearestRing(p.series, floor / 1.02, (o) => o.id <= floor * 0.995 && o.id >= floor * 0.94);
        if (!ring) throw ctx.fail(`No ${cs} mm O-ring fits a ${cyl.hole ? "bore" : "shaft"} of ${Math.round(D * 100) / 100} mm. Try another cross-section, or type a dash number.`);
      }
      const g = glandFor(ring.cs), depth = depthOf(ring.cs), width = g.radialWidth;
      if (!(depth > 0.1)) throw ctx.fail("The radial clearance is as large as the gland is deep.");
      const span = cyl.hi - cyl.lo;
      const at = p.centred ? (cyl.lo + cyl.hi) / 2 : p.flip ? cyl.lo + Number(p.offset) : cyl.hi - Number(p.offset);
      if (at - width / 2 < cyl.lo - 1e-6 || at + width / 2 > cyl.hi + 1e-6) throw ctx.fail(`The groove is ${Math.round(width * 100) / 100} mm wide and does not fit on the face there (the face is ${Math.round(span * 100) / 100} mm long).`);
      if (!cyl.hole && depth >= cyl.radius) throw ctx.fail("The shaft is thinner than the groove is deep.");
      frame = { origin: add(cyl.origin, scale(cyl.dir, at)), x: cyl.x, y: cross(cyl.dir, cyl.x), normal: cyl.dir };
      const over = Math.max(0.05, 0.02 * cyl.radius), rad = Math.min(g.radius, depth / 3, width / 3);
      outline = cyl.hole ? rounded(cyl.radius - over, cyl.radius + depth, -width / 2, width / 2, rad, "inner") : rounded(cyl.radius - depth, cyl.radius + over, -width / 2, width / 2, rad, "outer");
      changeBody(ctx, cyl.body, "cut", revolved(ctx, frame, outline, ctx.feature.id));
      return;
    }
    if (info.kind !== "plane" || !info.frame) throw ctx.fail("Pick the round face of a shaft, the wall of a bore, or a flat face.");
    // a face seal: the ring lies against the groove's wall that is away from the pressure
    if (!ring) {
      const cs = Number(p.series) || 2.62;
      if (!(p.diameter > 2 * cs)) throw ctx.fail("The groove's diameter must be more than twice the O-ring's cross-section.");
      ring = nearestRing(p.series, Number(p.diameter) - cs);
      if (!ring) throw ctx.fail("No O-ring of that cross-section is in the table. Type a dash number.");
    }
    const g = glandFor(ring.cs);
    const centre = onPlane(info.frame, p.centre ? pointOf(ctx, p.centre, "centre") : info.centre);
    frame = { ...info.frame, origin: centre };
    // pressure inside: the groove's outer wall is the ring's outside (1 % squeezed); outside: its inner wall is the ring's inside
    const outer = p.pressure === "outside" ? ring.id / 2 + g.faceWidth : (ring.id + 2 * ring.cs) / 2 * 0.99;
    const inner = outer - g.faceWidth;
    if (!(inner > 0.2)) throw ctx.fail(`The -${ring.dash} ring is too small for a face groove.`);
    const rad = Math.min(g.radius, g.faceDepth / 3, g.faceWidth / 3);
    outline = rounded(inner, outer, -g.faceDepth, 0.01, rad, "top");
    if (!changeBody(ctx, r.body, "cut", revolved(ctx, frame, outline, ctx.feature.id))) ctx.warn("Nothing was cut: the groove does not lie on the face.");
  },
});
