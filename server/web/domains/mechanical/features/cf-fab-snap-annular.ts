// cf-fab-snap-annular.ts — Annular snap fit: a round plug with a bead near its tip, and the socket whose groove
// the bead snaps into.
//
// One feature makes either half; give both the same numbers and they fit.  The plug stands at each point of
// the sketch: a shaft of the nominal diameter with a ring (the bead) that is higher by the undercut, a lead-in
// slope toward the tip and a return slope behind it.  It can be hollow and slit so its tongues give.  The
// socket is a sleeve whose bore is the shaft plus the clearance, with the bead's groove where the bead sits
// when the plug's foot is against the sleeve's rim.
// Names: `<id>:<point>:shaft`, `:return`, `:bead`, `:lead`, `:tip`, `:top`, `:bore`, `:slot<n>:…` (plug);
// `:outer`, `:rim`, `:entry`, `:bore`, `:catch`, `:groove`, `:lead` (socket).
import { defineFeature } from "../core/feature";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import type { Tool } from "../kernel/ops/combine";
import { box, frameAt, moved, positive, revolve, shape, sketchPoints, type P2 } from "../kernel/ops/cf-fab";
import { finish, PRINT, resultFields } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SnapAnnularParams { [key: string]: any; points: { sketch: string; regions: string[] | null } | null; part: "plug" | "socket"; diameter: number; height: number; undercut: number; fromTip: number; lead: number; back: number; clearance: number; bore: number; slots: number; slotWidth: number; slotDepth: number; wall: number; flip: boolean; operation: "new" | "add"; targets: string[] }

export default defineFeature<SnapAnnularParams>({
  type: "cf-fab-snap-annular",
  title: "Annular snap fit",
  icon: '<path class="f" d="M9 21V8.5L7.5 7V5.5L9.5 3h5l2 2.5V7L15 8.5V21z"/><path d="M9 21V8.5L7.5 7V5.5L9.5 3h5l2 2.5V7L15 8.5V21zM3 21h18"/><path class="t" d="M12 3v8"/>',
  hint: "A round snap plug with a bead, or the socket with the groove it snaps into",
  keywords: "annular snap fit ring snap bead groove plug socket cap round snap-fit 3d print",
  ...PRINT, toolbarOrder: 12,
  defaults: () => ({ points: null, part: "plug", diameter: 10, height: 8, undercut: 0.4, fromTip: 1.5, lead: 30, back: 45, clearance: 0.15, bore: 6, slots: 2, slotWidth: 1.2, slotDepth: 6, wall: 2, flip: false, operation: "add", targets: [] }),
  schema: [
    { key: "points", label: "Sketch with points", kind: "profile", hint: "One at each loose point and at the centre of each circle." },
    { key: "part", label: "Make", kind: "enum", options: [{ value: "plug", label: "Plug" }, { value: "socket", label: "Socket" }] },
    { key: "diameter", label: "Diameter", kind: "number", unit: "mm", min: 0.5, step: 0.5, hint: "Of the plug's shaft; the socket's bore is this plus the clearance." },
    { key: "height", label: "Height", kind: "number", unit: "mm", min: 0.5, step: 0.5 },
    { key: "undercut", label: "Undercut", kind: "number", unit: "mm", min: 0.05, step: 0.05, hint: "How far the bead stands out from the shaft." },
    { key: "fromTip", label: "Bead from the tip", kind: "number", unit: "mm", min: 0, step: 0.5 },
    { key: "lead", label: "Lead-in angle", kind: "number", unit: "deg", min: 10, max: 80, step: 5 },
    { key: "back", label: "Return angle", kind: "number", unit: "deg", min: 20, max: 90, step: 5, hint: "90° holds for good; 45° lets the joint be pulled apart." },
    { key: "clearance", label: "Clearance", kind: "number", unit: "mm", min: 0, step: 0.05, hint: "Between shaft and bore, on the radius.", visible: (p) => p.part === "socket" },
    { key: "wall", label: "Sleeve wall", kind: "number", unit: "mm", min: 0.2, step: 0.2, visible: (p) => p.part === "socket" },
    { key: "bore", label: "Hollow", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "The diameter of the hole down the plug; 0 for a solid one.", visible: (p) => p.part !== "socket" },
    { key: "slots", label: "Slits", kind: "number", unit: "none", min: 0, max: 4, step: 1, hint: "Cuts across the plug that divide it into tongues: 1 makes two, 2 four.", visible: (p) => p.part !== "socket" },
    { key: "slotWidth", label: "Slit width", kind: "number", unit: "mm", min: 0.1, step: 0.1, visible: (p) => p.part !== "socket" && Number(p.slots) > 0 },
    { key: "slotDepth", label: "Slit depth", kind: "number", unit: "mm", min: 0.1, step: 0.5, visible: (p) => p.part !== "socket" && Number(p.slots) > 0 },
    { key: "flip", label: "Opposite side", kind: "boolean" },
    ...resultFields,
  ],

  evaluate(ctx: EvalContext, p: SnapAnnularParams) {
    const R = positive(ctx, p.diameter, "diameter") / 2, h = positive(ctx, p.height, "height"), u = positive(ctx, p.undercut, "undercut");
    const lead = Number(p.lead), back = Number(p.back), ft = Math.max(0, Number(p.fromTip) || 0);
    if (!(lead >= 10 && lead <= 80)) throw ctx.fail("The lead-in angle must be between 10° and 80°.");
    if (!(back >= 20 && back <= 90)) throw ctx.fail("The return angle must be between 20° and 90°.");
    if (u > R / 2) throw ctx.fail("The undercut is too large for this diameter.");
    // the bead along the plug, from its foot (0) to its tip (h): return face, land, lead-in
    const z3 = h - ft, z2 = z3 - u / Math.tan((lead * Math.PI) / 180), z1 = z2 - (0.4 * u + 0.2), z0 = z1 - (back >= 90 ? 0 : u / Math.tan((back * Math.PI) / 180));
    if (!(z0 > 0.4)) throw ctx.fail("The bead does not fit on a plug this short. Make it taller or the undercut smaller.");
    const { frame, points } = sketchPoints(ctx, p.points, "snap fits");
    const base = p.flip ? frameAt(frame.origin, frame.x, [-frame.normal[0], -frame.normal[1], -frame.normal[2]]) : frame;
    const id = ctx.feature.id;
    const tools: Tool[] = points.map((pt) => {
      const f = moved(base, pt.at[0], p.flip ? -pt.at[1] : pt.at[1]);
      const key = `${id}:${pt.id}`;
      let made: NamedResult;
      if (p.part === "socket") {
        const c = Math.max(0, Number(p.clearance) || 0), wall = positive(ctx, p.wall, "sleeve wall");
        const Ri = R + c, Ro = Ri + u + wall, ch = Math.min(0.5, z0 / 2);
        const pts: P2[] = [[Ri, 0], [Ro, 0], [Ro, h], [Ri + ch, h], [Ri, h - ch], [Ri, h - z0], [Ri + u, h - z1], [Ri + u, h - z2], [Ri, h - z3]];
        made = revolve(ctx, f, pts, ["base", "outer", "rim", "entry", "bore-top", "catch", "groove", "lead", "bore"], key);
      } else {
        const rb = Math.max(0, Number(p.bore) || 0) / 2, ch = Math.min(ft / 2, R * 0.3);
        if (rb > 0 && rb > R - ch - 0.4) throw ctx.fail("The hole down the plug leaves no wall. Make it smaller.");
        const outer: P2[] = [[R, 0], [R, z0], [R + u, z1], [R + u, z2], [R, z3], [R, h - ch], [R - ch, h]];
        const roles = ["shaft", "return", "bead", "lead", "tip", "chamfer", "top"];
        made = rb > 0 ? revolve(ctx, f, [[rb, 0], ...outer, [rb, h]], ["base", ...roles, "bore"], key) : revolve(ctx, f, [[0, 0], ...outer, [0, h]], ["base", ...roles, null], key);
        const n = Math.round(Number(p.slots) || 0);
        if (n < 0 || n > 4) throw ctx.fail("The plug takes up to 4 slits.");
        if (n > 0) {
          const sw = positive(ctx, p.slotWidth, "slit width"), sd = positive(ctx, p.slotDepth, "slit depth");
          if (sd >= h) throw ctx.fail("The slits are deeper than the plug is tall.");
          if (sw * n > R) throw ctx.fail("The slits are too wide for this diameter.");
          const reach = R + u + 1;
          made = shape(ctx, "cut", made, Array.from({ length: n }, (_, i) => box(ctx, moved(f, 0, 0, 0, (180 * i) / n), [-reach, -sw / 2, h - sd], [reach, sw / 2, h + 1], `${key}:slot${i + 1}`)));
        }
      }
      return { ...made, suffix: pt.id };
    });
    finish(ctx, tools, p);
  },
});
