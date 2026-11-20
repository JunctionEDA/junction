// cf-hw-fasteners.ts — the solids of screws, nuts and standoffs (features/cf-hw-bolt.ts, -nut.ts, -standoff.ts,
// -knob.ts): hexagons with their chamfers, heads with their key sockets, and a modelled thread where asked for.
// Worker side.  Everything is built in a frame whose normal is the fastener's axis.
import { scale, type Frame } from "../../core/geometry";
import type { NamedResult } from "../occ";
import type { EvalContext } from "../types";
import { toolFaces } from "./combine";
import { circle, common, cut, extruded, fuse, ngon, poly, revolved, type Loop, type V2 } from "./cf-hw";
import { threadInto } from "./cf-hw-thread";

const COS30 = Math.cos(Math.PI / 6), TAN30 = Math.tan(Math.PI / 6);

/**
 * A hexagonal prism `across` flats from `z0` up by `height`, its corners chamfered at 30° as bar stock is turned:
 * at the top, at both ends, or not at all.  Faces `<prefix>:flat`, `:top`, `:bottom`, `:chamfer`.
 */
export function hexPrism(ctx: EvalContext, f: Frame, across: number, z0: number, height: number, prefix: string, chamfer: "top" | "both" | "none" = "top", sides = 6): NamedResult {
  const prism = extruded(ctx, f, ngon([0, 0], sides, across, 0, "flat"), [], z0, height, prefix);
  if (chamfer === "none") return prism;
  // the turned envelope: a cylinder just outside the corners, coned down to a circle inside the flats
  const corner = (across / 2 / Math.cos(Math.PI / sides)) * 1.02, land = (across / 2) * 0.95;
  const c = Math.min((corner - land) * TAN30, height * 0.3), z1 = z0 + height;
  const pts: V2[] = chamfer === "both"
    ? [[0, z0], [land, z0], [corner, z0 + c], [corner, z1 - c], [land, z1], [0, z1]]
    : [[0, z0], [corner, z0], [corner, z1 - c], [land, z1], [0, z1]];
  const roles = chamfer === "both" ? ["bottom", "chamfer", null, "chamfer", "top", null] : ["bottom", null, "chamfer", "top", null];
  return common(ctx, prism, revolved(ctx, f, poly(pts, roles), prefix));
}

/** The hexagonal socket a key goes in: `key` across flats, `depth` down from height `top`. */
export function keySocket(ctx: EvalContext, f: Frame, key: number, top: number, depth: number, prefix: string): NamedResult {
  return extruded(ctx, f, ngon([0, 0], 6, key, 0, "socket"), [], top - depth, depth + 1e-3, `${prefix}:key`);
}

export type HeadKind = "hex" | "socket" | "button" | "flat";
export interface Screw {
  head: HeadKind; d: number; pitch: number;
  /** from under the head to the tip; for a countersunk head, from its top */
  length: number;
  /** hexagon head: across flats; other heads: diameter */
  headSize: number; headHeight: number;
  key: number; keyDepth: number;
  /** length of thread from the tip; the whole shank when 0 or more than it */
  threaded: number;
  /** model the thread (60° profile); otherwise the shank is a plain cylinder of the major diameter */
  modelled: boolean;
}

/**
 * A screw standing in the frame: the plane is the surface it is screwed into, the head above it, the shank going
 * down against the normal.  A countersunk head lies below the plane, its top flush.
 * Faces `<prefix>:head…`, `:shank`, `:tip`, and the thread's when modelled.
 */
export function screwSolid(ctx: EvalContext, f: Frame, s: Screw, prefix: string): NamedResult {
  const r = s.d / 2, k = s.headHeight, R = s.headSize / 2;
  if (!(s.length > 0)) throw ctx.fail("The screw's length must be more than zero.");
  const flat = s.head === "flat";
  const under = flat ? -k : 0;                 // where the shank begins
  const tip = flat ? -s.length : -s.length;    // a countersunk screw is measured over its head
  if (!(under - tip > 0.5 * s.pitch)) throw ctx.fail("The screw is too short for its head.");
  const ch = s.modelled ? 0 : Math.min(0.6 * s.pitch, r * 0.4);   // a plain shank gets the point a thread would have
  const shank: V2[] = [[r, under], [r, tip + ch], [r - ch, tip], [0, tip]];
  const shankRoles = ["shank", ...(ch > 0 ? ["point"] : []), "tip", null];
  const down = ch > 0 ? shank : [shank[0], [r, tip] as V2, shank[3]];
  let body: NamedResult;
  if (s.head === "hex") {
    const stem = revolved(ctx, f, poly([[0, 0], ...down], [null, ...shankRoles]), prefix);
    // the washer face under a hexagon head is left out: the head sits flat
    body = fuse(ctx, hexPrism(ctx, f, s.headSize, 0, k, `${prefix}:head`, "top"), stem);
  } else if (s.head === "socket") {
    const e = Math.min(0.1 * k, 0.4);
    body = revolved(ctx, f, poly([[0, k], [R - e, k], [R, k - e], [R, 0], ...down], ["head:top", "head:edge", "head:side", "head:seat", ...shankRoles]), prefix);
  } else if (s.head === "button") {
    // a dome: part of a sphere from a low edge to a small flat on top
    const e = Math.min(0.15 * k, 0.4), rt = Math.max(s.key * 0.62, R * 0.3);
    const zc = (R * R + e * e - rt * rt - k * k) / (2 * (e - k)), rs = Math.hypot(R, e - zc);
    const a1 = Math.atan2(R, e - zc), a2 = Math.atan2(rt, k - zc), am = (a1 + a2) / 2;
    const dome: Loop = {
      start: [0, k], segs: [
        { to: [rt, k], role: "head:top" }, { to: [R, e], via: [rs * Math.sin(am), zc + rs * Math.cos(am)], role: "head:dome" }, { to: [R, 0], role: "head:side" },
        { to: down[0], role: "head:seat" }, ...down.slice(1).map((to, i) => ({ to, role: shankRoles[i] })), { to: [0, k], role: null },
      ],
    };
    body = revolved(ctx, f, dome, prefix);
  } else {
    // 90° countersunk: a cone from the shank up to the head's diameter, with what height is left as a land
    const cone = Math.min(k, R - r), land = Math.max(0, k - cone);
    const pts: V2[] = [[0, 0], [R, 0], ...(land > 1e-6 ? [[R, -land] as V2] : []), ...down];
    body = revolved(ctx, f, poly(pts, ["head:top", ...(land > 1e-6 ? ["head:side"] : []), "head:cone", ...shankRoles]), prefix);
  }
  if (s.head !== "hex" && s.key > 0 && s.keyDepth > 0) body = cut(ctx, body, keySocket(ctx, f, s.key, flat ? 0 : k, s.keyDepth, prefix));
  if (!s.modelled) return body;
  const shankLength = under - tip;
  const threaded = s.threaded > 0 && s.threaded < shankLength - 1e-6 ? s.threaded : shankLength;
  const depth = (5 / 8) * (Math.sqrt(3) / 2) * s.pitch;
  const { result } = threadInto(ctx, { shape: body.shape, faces: toolFaces(ctx, body) }, {
    origin: f.origin, dir: f.normal, x: f.x, radius: r, lo: tip, hi: under, hole: false,
    pitch: s.pitch, starts: 1, left: false, depth, majorFlat: s.pitch / 8, minorFlat: s.pitch / 4,
    major: r, taper: 0, length: threaded, fromHi: false, leadIn: depth, runout: s.pitch, prefix: `${prefix}:thread`,
  });
  return result;
}

/** A round hole through a solid along the frame's axis from `z0` to `z1`, as a tool (a little longer at both ends). */
export function boreTool(ctx: EvalContext, f: Frame, diameter: number, z0: number, z1: number, prefix: string): NamedResult {
  return extruded(ctx, f, circle([0, 0], diameter / 2, "bore"), [], z0 - 1e-3, z1 - z0 + 2e-3, prefix);
}

/** A modelled 60° internal thread in a hole of a solid, drilled to the minor diameter, from `lo` to `hi` along the axis. */
export function tapped(ctx: EvalContext, body: NamedResult, f: Frame, d: number, pitch: number, lo: number, hi: number, fromHi: boolean, blind: boolean, prefix: string): NamedResult {
  const depth = (5 / 8) * (Math.sqrt(3) / 2) * pitch;
  return threadInto(ctx, { shape: body.shape, faces: toolFaces(ctx, body) }, {
    origin: f.origin, dir: f.normal, x: f.x, radius: d / 2 - depth, lo, hi, hole: true,
    pitch, starts: 1, left: false, depth, majorFlat: pitch / 8, minorFlat: pitch / 4,
    major: d / 2, taper: 0, length: hi - lo, fromHi, leadIn: depth, runout: blind ? pitch : 0, prefix,
  }).result;
}

/** The minor diameter of a 60° thread: what a nut or a tapped hole is drilled to when its thread is not modelled. */
export const minorOf = (d: number, pitch: number): number => d - 2 * (5 / 8) * (Math.sqrt(3) / 2) * pitch;
export { COS30, scale };
