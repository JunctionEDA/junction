// cf-hw-enclosure.ts — Enclosure: a box in two parts, a base and a lid, from a handful of numbers: outside size,
// wall, corner radius, where it splits.  The two halves locate on a lip: the inner half of the base's wall stands
// up into a rebate in the lid (with a flat lid, a rim under the lid drops inside the base).  Four screw bosses in
// the corners take the lid's screws: the lid has counterbored clearance holes, the base a hole for a
// thread-forming screw or a tap, or for a heat-set insert.
//
// It stands on the picked plane, centred on the picked point, base down.  Two bodies: Base and Lid.
// Names: `<id>:base:outer:front` (`:right`, `:back`, `:left`, `:corner`), `:base:outer:bottom`, `:base:inner:…`,
// `:base:floor`, `:base:rim`, `:base:lip:…`, `:base:boss<n>:…`, and the same under `<id>:lid:…` (`:lid:outer:top`).
import { defineFeature } from "../core/feature";
import type { Frame } from "../core/geometry";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import { cut, extruded, frameAt, fuse, poly, revolved, roundRect, spots, together, type V2 } from "../kernel/ops/cf-hw";
import { fastenerOf, fastenerOptions, HW_SECTION, MENU_ENCLOSURES, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface EnclosureParams {
  [key: string]: any;
  length: number; width: number; height: number; wall: number; floor: number; radius: number; lidHeight: number;
  lip: boolean; lipHeight: number; clearance: number;
  bosses: boolean; screw: string; baseHole: "tap" | "insert"; counterbore: boolean;
}

export default defineFeature<EnclosureParams>({
  type: "cf-hw-enclosure",
  title: "Enclosure",
  icon: '<path class="f" d="M3 10l5-3h13v9l-5 3H3z"/><path d="M3 10l5-3h13v9l-5 3H3zM3 10h13l5-3M16 10v9"/><path class="f" d="M3 6l5-3h13l-5 3z"/><path d="M3 6l5-3h13l-5 3z"/>',
  hint: "Make a box with a lid: wall, corner radius, locating lip and screw bosses",
  keywords: "enclosure box case housing project box lid generator screw bosses lip snap electronics parametric box",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_ENCLOSURES, toolbarOrder: 10, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), length: 100, width: 60, height: 40, wall: 2, floor: 2, radius: 5, lidHeight: 10, lip: true, lipHeight: 2, clearance: 0.2, bosses: true, screw: "M3", baseHole: "tap", counterbore: true }),
  schema: [
    { key: "length", label: "Length", kind: "number", unit: "mm", min: 1, step: 5, hint: "Outside, along the plane's first direction." },
    { key: "width", label: "Width", kind: "number", unit: "mm", min: 1, step: 5 },
    { key: "height", label: "Height", kind: "number", unit: "mm", min: 1, step: 5, hint: "Outside, base and lid together." },
    { key: "wall", label: "Wall", kind: "number", unit: "mm", min: 0.2, step: 0.5 },
    { key: "floor", label: "Floor and top", kind: "number", unit: "mm", min: 0.2, step: 0.5 },
    { key: "radius", label: "Corner radius", kind: "number", unit: "mm", min: 0, step: 1 },
    { key: "lidHeight", label: "Lid height", kind: "number", unit: "mm", min: 0.2, step: 1, hint: "How much of the height is the lid. As thick as the top makes it a flat lid." },
    { key: "lip", label: "Locating lip", kind: "boolean" },
    { key: "lipHeight", label: "Lip height", kind: "number", unit: "mm", min: 0.2, step: 0.5, visible: (p) => !!p.lip },
    { key: "clearance", label: "Lip clearance", kind: "number", unit: "mm", min: 0, step: 0.05, hint: "The gap between the lip and its rebate.", visible: (p) => !!p.lip },
    { key: "bosses", label: "Screw bosses", kind: "boolean" },
    { key: "screw", label: "Screw", kind: "enum", options: fastenerOptions().slice(0, 7), visible: (p) => !!p.bosses },
    { key: "baseHole", label: "Hole in the base", kind: "enum", options: [{ value: "tap", label: "Screw / tap" }, { value: "insert", label: "Heat-set insert" }], visible: (p) => !!p.bosses },
    { key: "counterbore", label: "Counterbore the lid", kind: "boolean", hint: "Sink the screws' heads into the lid.", visible: (p) => !!p.bosses },
    ...whereFields({ angle: true, noun: "enclosure" }),
  ],

  evaluate(ctx: EvalContext, p: EnclosureParams) {
    const L = Number(p.length), W = Number(p.width), H = Number(p.height), w = Number(p.wall), t = Number(p.floor);
    if (!(L > 0 && W > 0 && H > 0 && w > 0 && t > 0)) throw ctx.fail("The enclosure's sizes must be more than zero.");
    if (!(L > 2 * w + 1 && W > 2 * w + 1)) throw ctx.fail("The walls are thicker than the box is wide.");
    const r = Math.max(0, Math.min(Number(p.radius) || 0, Math.min(L, W) / 2 - 0.01));
    const lidH = Number(p.lidHeight);
    if (!(lidH >= t - 1e-9)) throw ctx.fail("The lid cannot be thinner than the top.");
    const baseH = H - lidH;
    if (!(baseH > t + 0.5)) throw ctx.fail("The lid is as tall as the whole box: there is no base left.");
    const flatLid = lidH < t + 0.5;
    const c = Math.max(0, Number(p.clearance) || 0), lipH = p.lip ? Number(p.lipHeight) : 0;
    if (p.lip && !(lipH > 0)) throw ctx.fail("The lip's height must be more than zero.");
    const lipW = w / 2;
    if (p.lip && !flatLid && lipH + c > lidH - t) throw ctx.fail("The lip is taller than the lid's wall. Make it lower, or the lid taller.");
    if (p.lip && flatLid && lipH > baseH - t) throw ctx.fail("The lip is taller than the base is deep.");
    const screw = fastenerOf(p.screw);
    if (p.bosses && !screw) throw ctx.fail(`The size table has no ${p.screw}.`);
    const places = spots(ctx, p);
    places.forEach((s, n) => {
      const f: Frame = s.frame, id = places.length > 1 ? `${ctx.feature.id}:${s.key}` : ctx.feature.id;
      const out = (grow: number, role: string) => roundRect([0, 0], L + 2 * grow, W + 2 * grow, Math.max(0, r + grow), 0, role);
      // ---- base
      let base: NamedResult = extruded(ctx, f, out(0, "outer"), [], 0, baseH, `${id}:base`);
      base = cut(ctx, base, rename(extruded(ctx, f, out(-w, "inner"), [], t, baseH - t + 0.01, `${id}:base:cavity`), { bottom: `${id}:base:floor` }, `${id}:base:cavity:`, `${id}:base:`));
      // ---- lid
      let lid: NamedResult = extruded(ctx, f, out(0, "outer"), [], baseH, lidH, `${id}:lid`);
      if (!flatLid) lid = cut(ctx, lid, rename(extruded(ctx, f, out(-w, "inner"), [], baseH - 0.01, lidH - t + 0.01, `${id}:lid:cavity`), { top: `${id}:lid:ceiling` }, `${id}:lid:cavity:`, `${id}:lid:`));
      // ---- the lip
      if (p.lip && !flatLid) {
        // the inner half of the base's wall stands up; the lid's wall is rebated for it
        base = fuse(ctx, base, extruded(ctx, f, out(-(w - lipW), "side"), [out(-w, "inner")], baseH - 0.01, lipH + 0.01, `${id}:base:lip`));
      } else if (p.lip) {
        // a rim under a flat lid drops inside the base
        lid = fuse(ctx, lid, extruded(ctx, f, out(-w - c, "side"), [out(-w - c - Math.max(lipW, 1), "inner")], baseH - lipH, lipH + 0.01, `${id}:lid:lip`));
      }
      // ---- screw bosses
      if (p.bosses && screw) {
        const hole = p.baseHole === "insert" ? screw.insert : [screw.tap, Math.min(baseH - t - 0.5, 3 * screw.d)];
        const D = Math.max(hole[0] + 2.4, 2 * screw.d + 1);
        const lidD = Math.max(D, (p.counterbore ? screw.cbore[0] : screw.clearance[1]) + 2);
        // in each corner: overlapping the wall so that it joins it, clear of a flat lid's rim, and far enough in
        // that the post stays inside a rounded corner's outside
        const widest = flatLid ? D : lidD, keep = Math.min(0.5, w / 3);
        const corner = widest / 2 + keep >= r ? widest / 2 + keep : r - (r - keep - widest / 2) / Math.SQRT2;
        const inset = Math.max(w + (p.lip && flatLid ? c + Math.max(lipW, 1) : 0) + D / 2 - Math.min(0.3 * D, w * 0.6), corner);
        const cx = L / 2 - inset, cy = W / 2 - inset;
        if (!(cx > D / 2 && cy > D / 2)) throw ctx.fail("The box is too small for screw bosses of this size. Use a smaller screw, or turn the bosses off.");
        const corners: V2[] = [[-cx, -cy], [cx, -cy], [cx, cy], [-cx, cy]];
        const top = flatLid && p.lip ? baseH - lipH - c : baseH;
        const depth = Math.min(hole[1], top - t - 0.4);
        if (!(depth > 1)) throw ctx.fail("The base is too shallow for the screws' holes.");
        const posts = corners.map((q, i) => revolved(ctx, frameAt(f, q), poly([[0, t - 0.01], [D / 2, t - 0.01], [D / 2, top], [0, top]] as V2[], [null, "side", "top", null]), `${id}:base:boss${i + 1}`));
        base = fuse(ctx, base, together(ctx, posts));
        base = cut(ctx, base, together(ctx, corners.map((q, i) => revolved(ctx, frameAt(f, q), poly([[0, top + 0.01], [hole[0] / 2, top + 0.01], [hole[0] / 2, top - depth], [0, top - depth]] as V2[], [null, "hole", "hole:floor", null]), `${id}:base:boss${i + 1}`))));
        const clear = screw.clearance[1], headD = screw.cbore[0], headH = Math.min(screw.cbore[1], lidH - 0.8);
        if (!flatLid) {
          const lidPosts = corners.map((q, i) => revolved(ctx, frameAt(f, q), poly([[0, baseH], [lidD / 2, baseH], [lidD / 2, H - t + 0.01], [0, H - t + 0.01]] as V2[], ["bottom", "side", null, null]), `${id}:lid:boss${i + 1}`));
          lid = fuse(ctx, lid, together(ctx, lidPosts));
        }
        const sunk = p.counterbore && headH > 0.3;
        lid = cut(ctx, lid, together(ctx, corners.map((q, i) => revolved(ctx, frameAt(f, q), poly(sunk
          ? [[0, baseH - lipH - 1], [clear / 2, baseH - lipH - 1], [clear / 2, H - headH], [headD / 2, H - headH], [headD / 2, H + 0.01], [0, H + 0.01]] as V2[]
          : [[0, baseH - lipH - 1], [clear / 2, baseH - lipH - 1], [clear / 2, H + 0.01], [0, H + 0.01]] as V2[],
        sunk ? [null, "hole", "seat", "counterbore", null, null] : [null, "hole", null, null]), `${id}:lid:boss${i + 1}`))));
      }
      // the rebate for the base's lip, last: it also clears the lid's bosses off the lip
      if (p.lip && !flatLid) lid = cut(ctx, lid, extruded(ctx, f, out(-(w - lipW) + c, "side"), [out(-w - c, "inner")], baseH - 0.01, lipH + c + 0.01, `${id}:lid:rebate`));
      ctx.addBody(base.shape, base.names, { suffix: places.length > 1 ? `${s.key}.base` : "base", name: n ? `Base ${n + 1}` : "Base" });
      ctx.addBody(lid.shape, lid.names, { suffix: places.length > 1 ? `${s.key}.lid` : "lid", name: n ? `Lid ${n + 1}` : "Lid" });
    });
  },
});

/** A tool's faces under other names: whole names in `map` by their last word, and a prefix swapped for another. */
function rename(r: NamedResult, map: { [last: string]: string }, from: string, to: string): NamedResult {
  return { shape: r.shape, names: (face, i) => {
    const name = r.names(face, i);
    if (name === null) return null;
    const last = name.slice(name.lastIndexOf(":") + 1);
    return map[last] || (name.startsWith(from) ? to + name.slice(from.length) : name);
  } };
}
