// frame.ts — Frame: sweep a standard profile from the library (tubes, angles, channels, I-beams, T-slot
// extrusions) along sketch segments or edges, one part per segment.  Where two segments meet, the members are
// mitred, butted (the earlier one runs through) or left as they are.  Every member is recorded for Trim, Gusset,
// End cap and Cut list (kernel/ops/frame.ts).
//
// Names: `<member>:start`, `<member>:end` for the end faces, `<member>:side@<angle>:<distance>` for the others,
// by where they lie around the member's axis; `<member>` is `<id>.m<n>`.
import { defineFeature } from "../core/feature";
import { isGeomRef } from "../core/geometry";
import type { EvalContext, Shape } from "../kernel/types";
import { buildMembers, FAMILIES, localOf, profileDef, profileFrame, profileHalf, segmentOf, setItems, SIZES, type FrameItem, type MemberOptions, type Segment } from "../kernel/ops/frame";
import { chainOf, sketchEdge } from "../kernel/ops/sweep-path";
import type { RefTarget } from "./_refs";
import { FRAME_SECTION } from "./_frame";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FrameParams {
  [key: string]: any;
  path: RefTarget[]; family: string;
  angle: number; mirror: boolean; align: string; corner: "miter" | "butt" | "none";
}

/** The parameter that holds the size of a family's profile (one per family, so each has its own list). */
export const sizeKey = (family: string): string => `size_${family.replace(/-/g, "_")}`;

export const FRAME_ICON = '<path class="f" d="M4 20V5h4v11h12v4z"/><path d="M4 20V5h4v11h12v4zM4 20l4-4"/>';

export default defineFeature<FrameParams>({
  type: "frame",
  title: "Frame",
  icon: FRAME_ICON,
  hint: "Sweep a standard profile along sketch segments or edges, one part per segment",
  keywords: "frame weldment structural member profile tube beam angle channel t-slot extrusion",
  toolbarSection: FRAME_SECTION, toolbarOrder: 10, toolbarKeep: 60,
  defaults: () => ({ path: [], family: "square-tube", ...Object.fromEntries(FAMILIES.map((f) => [sizeKey(f.id), SIZES[f.id][0]])), angle: 0, mirror: false, align: "center", corner: "miter" }),
  schema: [
    { key: "path", label: "Segments", kind: "refs", of: ["edge"], datums: ["curve"], sketch: true, hint: "Sketch segments (the segments joined to one come too) or edges." },
    { key: "family", label: "Profile", kind: "enum", options: FAMILIES.map((f) => ({ value: f.id, label: f.label })) },
    ...FAMILIES.map((f) => ({ key: sizeKey(f.id), label: "Size", kind: "enum" as const, options: SIZES[f.id].map((s) => ({ value: s, label: s.replace(/x/g, " × ") })), visible: (p: any) => (p.family || "square-tube") === f.id })),
    { key: "align", label: "Profile position", kind: "enum", options: ["center", "top", "bottom", "left", "right", "bottom-left", "top-left", "bottom-right", "top-right"].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1).replace("-", " ") })), hint: "Which point of the profile lies on the path." },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", step: 15, hint: "Turn the profile about the path." },
    { key: "mirror", label: "Mirror profile", kind: "boolean" },
    { key: "corner", label: "Corners", kind: "enum", options: [{ value: "miter", label: "Miter" }, { value: "butt", label: "Butt" }, { value: "none", label: "None" }] },
  ],

  evaluate(ctx: EvalContext, p: FrameParams) {
    const k = ctx.k, oc = ctx.oc as any, id = ctx.feature.id;
    const family = p.family || "square-tube";
    const sizes = SIZES[family] || [];
    const want = p[sizeKey(family)] ?? p.size;
    const prof = profileDef(family, sizes.includes(want) ? want : sizes[0]);
    const o: MemberOptions = { profile: prof, angle: p.angle || 0, mirror: !!p.mirror, align: p.align || "center", corner: p.corner || "miter" };
    const targets = Array.isArray(p.path) ? p.path : [];
    if (!targets.length) throw ctx.fail("Pick the sketch segments or edges the frame follows.");
    const segs: Segment[] = [];
    const bySketch = new Map<string, string[]>();
    for (const t of targets) {
      if (t.kind === "sketch") { bySketch.set(t.feature, [...(bySketch.get(t.feature) || []), t.entity]); continue; }
      if (t.kind === "datum") {
        const d = ctx.datum(t.feature);
        if (d.kind !== "curve" || !d.shape) throw ctx.fail("A frame follows curves and edges.");
        for (const e of k.sub(d.shape, "edge")) segs.push(segmentOf(k, e, null));
        continue;
      }
      if (isGeomRef(t) && t.kind === "edge") { segs.push(segmentOf(k, ctx.resolve(t).shape, null)); continue; }
      throw ctx.fail("A frame follows curves and edges.");
    }
    for (const [sk, picked] of bySketch) {
      const s = ctx.sketch(sk);
      for (const e of chainOf(s.data, picked)) {
        const edge = sketchEdge(ctx, sk, e);
        if (edge.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE) throw ctx.fail("A frame follows lines and arcs: that curve kind is not supported yet.");
        segs.push(segmentOf(k, edge, s.frame.normal));
      }
    }
    // closed curves (a circle) are one member of their own
    const members = buildMembers(k, segs, o, ctx.own);
    const items: FrameItem[] = [];
    members.forEach((mb, i) => {
      const pre = `${id}.m${i + 1}`, F = profileFrame(mb.seg, o);
      const names = (f: Shape): string => {
        const c = localOf(F, k.centre(f, "face")), fr = k.faceFrame(f as any);
        const len = mb.seg.straight ? Math.hypot(mb.seg.b[0] - mb.seg.a[0], mb.seg.b[1] - mb.seg.a[1], mb.seg.b[2] - mb.seg.a[2]) : Infinity;
        if (fr) {
          const n = [F[2] * fr.normal[0] + F[6] * fr.normal[1] + F[10] * fr.normal[2]];
          if (Math.abs(n[0]) > 0.3 && c[2] < len / 2) return `${pre}:start`;
          if (Math.abs(n[0]) > 0.3) return `${pre}:end`;
        }
        return `${pre}:side@${Math.round((Math.atan2(c[1], c[0]) * 180) / Math.PI)}:${Math.round(Math.hypot(c[0], c[1]) * 100) / 100}`;
      };
      const body = ctx.addBody(mb.shape, (f) => names(f), { suffix: `m${i + 1}`, name: `${prof.label} (${ctx.feature.name}, ${i + 1})` });
      items.push({ body: body.id, feature: id, kind: "member", label: prof.label, length: mb.length, angles: mb.angles, axis: mb.seg.straight ? [mb.seg.a, mb.seg.b] : undefined, half: profileHalf(prof) });
    });
    setItems(ctx, items);
  },
});
