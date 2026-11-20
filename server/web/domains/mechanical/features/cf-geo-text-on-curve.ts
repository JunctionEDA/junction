// cf-geo-text-on-curve.ts — Text on a curve: lettering whose baseline follows a path (an arc round a dial, a
// spline along a handle).  Each letter is set whole at its place along the path, by length, and turned to the
// path's direction there; the letters stand in a plane (the path's sketch plane, or one picked) and are
// extruded square to it, as a body of their own, added to bodies, or cut from them.
//
// Names: a letter's pieces are `<id>:c<n>:<k>` (n: the character's place in the text, counting from 1), so a
// reference to a letter stays on it when the text before it keeps its length.
import { defineFeature } from "../core/feature";
import { add, cross, dot, length, normalize, scale, sub, type Frame, type Vec3 } from "../core/geometry";
import type { EvalContext, Shape } from "../kernel/types";
import { samplePoints } from "../kernel/ops/curves";
import { applyTools, prismOf, scopeOf, tagged, textFaces, widthOfText, TOOL_OPS, type ToolOp } from "../kernel/ops/cf-geo";
import type { Tool } from "../kernel/ops/pattern-core";
import { planeOf } from "../kernel/ops/ref-geom";
import { pathWire } from "../kernel/ops/sweep-path";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TextOnCurveParams {
  [key: string]: any;
  text: string; path: RefTarget[]; plane: RefTarget | null; operation: ToolOp; bodies: string[]; height: number; depth: number;
  bold: boolean; italic: boolean; align: "start" | "middle" | "end"; spacing: number; offset: number; below: boolean; flip: boolean;
}

export default defineFeature<TextOnCurveParams>({
  type: "cf-geo-text-on-curve",
  title: "Text on curve",
  hint: "Lettering whose baseline follows a path: round an arc, along a spline.",
  keywords: "text along curve path arc circle circular text follow spline lettering dial engrave emboss",
  icon: '<path class="d t" d="M3 17c2-10 16-10 18 0"/><path d="M4.200 13.500l1.800-3.600 2.400 3M5 12.300l2.200.300"/><path d="M10 5.500h4M12 5.500v4.300"/><path d="M16.300 9.800l1.300 3.400 2.600-2"/>',
  toolbarOrder: 309.5, toolbarSection: "library", toolbarMenu: "Patterns & texture", toolbarKeep: 0,
  defaults: () => ({ text: "Junction", path: [], plane: null, operation: "new", bodies: [], height: 6, depth: 1, bold: false, italic: false, align: "middle", spacing: 0, offset: 0, below: false, flip: false }),
  schema: [
    { key: "text", label: "Text", kind: "text" },
    { key: "path", label: "Path", kind: "refs", of: ["edge"], datums: ["curve"], sketch: true, hint: "A sketch curve (the curves joined to it come too), edges, or a curve." },
    { key: "plane", label: "Plane", kind: "refs", of: ["face"], single: true, planes: true, datums: ["plane"], hint: "The plane the letters stand in. Leave empty for the path's own sketch plane (or Top)." },
    { key: "operation", label: "Result", kind: "enum", options: TOOL_OPS },
    { key: "bodies", label: "Bodies", kind: "bodies", hint: "Leave empty for every body.", visible: (p) => p.operation !== "new" },
    { key: "height", label: "Height", kind: "number", unit: "mm", min: 0.1, step: 1, hint: "The height of a capital letter." },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0.01, step: 0.5, hint: "How far the letters are extruded from the plane." },
    { key: "flip", label: "Extrude the other way", kind: "boolean" },
    { key: "bold", label: "Bold", kind: "boolean" },
    { key: "italic", label: "Italic", kind: "boolean" },
    { key: "align", label: "Align", kind: "enum", options: [{ value: "start", label: "Start" }, { value: "middle", label: "Middle" }, { value: "end", label: "End" }] },
    { key: "spacing", label: "Letter spacing", kind: "number", unit: "mm", step: 0.25, hint: "Added between letters." },
    { key: "offset", label: "Offset from the path", kind: "number", unit: "mm", step: 0.5, hint: "Lifts the baseline off the path, towards the tops of the letters." },
    { key: "below", label: "Other side of the path", kind: "boolean", hint: "The letters stand on the path's other side and run the other way along it (inside an arc instead of outside)." },
  ],

  evaluate(ctx: EvalContext, p: TextOnCurveParams) {
    const text = String(p.text ?? "");
    if (!text.trim()) throw ctx.fail("Type the text.");
    if (text.length > 200) throw ctx.fail("The text is too long (at most 200 characters).");
    if (!(p.height > 0) || !(p.depth > 0)) throw ctx.fail("The height and the depth must be more than zero.");
    const picks = Array.isArray(p.path) ? p.path : [];
    const wire = pathWire(ctx, picks);
    // the plane the letters stand in
    const firstSketch = picks.find((t) => t.kind === "sketch") as { feature: string } | undefined;
    const base: Frame = p.plane ? planeOf(ctx, p.plane, "plane") : firstSketch ? ctx.sketch(firstSketch.feature).frame : { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };
    const N = base.normal;

    // the path by length, flattened into that plane
    const flat = (q: Vec3): Vec3 => sub(q, scale(base.normal, dot(sub(q, base.origin), base.normal)));
    let pts = samplePoints(ctx, wire, 600).map(flat);
    // on the other side of the path the text runs the other way along it, so that it still reads from the same side
    if (p.below) pts = pts.reverse();
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + length(sub(pts[i], pts[i - 1])));
    const total = cum[cum.length - 1];
    if (!(total > 1e-6)) throw ctx.fail("The path has no length in the letters' plane. Pick another plane.");
    const closed = length(sub(pts[0], pts[pts.length - 1])) < 1e-6;
    const at = (s: number): { at: Vec3; t: Vec3 } => {
      let d = closed ? ((s % total) + total) % total : s;
      // past an open path's ends the text carries straight on
      if (d <= 0) { const t = normalize(sub(pts[1], pts[0])); return { at: add(pts[0], scale(t, d)), t }; }
      if (d >= total) { const n = pts.length - 1, t = normalize(sub(pts[n], pts[n - 1])); return { at: add(pts[n], scale(t, d - total)), t }; }
      let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
      const f = (d - cum[lo]) / (cum[hi] - cum[lo] || 1);
      d = 0;
      return { at: add(pts[lo], scale(sub(pts[hi], pts[lo]), f)), t: normalize(sub(pts[Math.min(pts.length - 1, lo + 2)], pts[Math.max(0, lo - 1)])) };
    };
    const style = { height: p.height, bold: !!p.bold, italic: !!p.italic };
    const chars = Array.from(text), gap = Number(p.spacing) || 0;
    const widths = chars.map((c) => widthOfText(c, style) || (c === " " ? p.height * 0.3 : 0));
    const run = widths.reduce((a, b) => a + b, 0) + gap * (chars.length - 1);
    if (closed && run > total) ctx.warn("The text is longer than the path is round: it overlaps itself.");
    let s = p.align === "start" ? 0 : p.align === "end" ? total - run : (total - run) / 2;
    const along = scale(N, p.flip ? -p.depth : p.depth);
    const tools: Tool[] = [];
    chars.forEach((c, i) => {
      const w = widths[i];
      if (c.trim() && w > 0) {
        const here = at(s + w / 2), x = here.t, y = cross(N, x);
        const frame: Frame = { origin: add(add(here.at, scale(x, -w / 2)), scale(y, Number(p.offset) || 0)), x, y, normal: N };
        const faces: Shape[] = textFaces(ctx, frame, c, style);
        faces.forEach((f, j) => tools.push(tagged(ctx, prismOf(ctx, f, along), faces.length > 1 ? `c${i + 1}.${j + 1}` : `c${i + 1}`)));
      }
      s += w + gap;
    });
    if (!tools.length) throw ctx.fail("No letter could be built from this text.");
    applyTools(ctx, tools, p.operation === "add" || p.operation === "remove" ? p.operation : "new", p.operation === "new" ? [] : scopeOf(ctx, p.bodies, null), "Text");
  },
});
