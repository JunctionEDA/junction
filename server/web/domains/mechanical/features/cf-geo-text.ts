// cf-geo-text.ts — the Text feature: lettering raised from a face, cut into it, or as a body of its own on a
// plane, without drawing a sketch first.  The outlines are the sketcher's font (sketch/curves.ts), as true
// curves.
//
//   flat face, plane   the letters are extruded square to it;
//   cylinder           the text is laid round it: lengths along the baseline become arc lengths, so the letters
//                      keep their widths however far round they go, and the font's curves are carried over
//                      exactly (kernel/ops/cf-geo.ts textOnCylinder);
//   any other face     the letters are projected straight onto it from the plane that touches it at its middle,
//                      and follow the surface to the depth asked.
//
// The text is centred on the face's middle (or the plane's origin) and can be moved and turned from there.
// Names: letter pieces are counted along the text, `<id>:t<n>:<k>`.
import { defineFeature } from "../core/feature";
import { add, cross, dot, normalize, scale, sub, type Frame, type Vec3 } from "../core/geometry";
import { isGeomRef } from "../core/geometry";
import type { Body, EvalContext, Shape } from "../kernel/types";
import { pointOn, surfaceOf, normalAt } from "../kernel/ops/cells";
import { OVERLAP, applyTools, placeOn, prismOf, shifted, tagged, textFaces, textOnCylinder, widthOfText, type ToolOp } from "../kernel/ops/cf-geo";
import type { Tool } from "../kernel/ops/pattern-core";
import { canonical } from "../kernel/ops/ref-geom";
import { compound } from "../kernel/ops/shapes";
import { thickenSheet } from "../kernel/ops/thicken";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TextParams {
  [key: string]: any;
  text: string; target: RefTarget | null; result: "emboss" | "engrave" | "new"; height: number; depth: number;
  bold: boolean; italic: boolean; x: number; y: number; angle: number;
}

/** The typed text with "\n" read as a new line. */
export const linesOf = (text: unknown): string => String(text ?? "").replace(/\\n/g, "\n");

/** A frame for text of this size centred on `frame`'s origin: the baseline's start. */
export function centred(frame: Frame, text: string, style: { height: number; bold?: boolean; italic?: boolean }): Frame {
  const rows = text.split("\n").length;
  const w = widthOfText(text, style), h = style.height * (1 + 1.6 * (rows - 1));
  return { ...frame, origin: add(frame.origin, add(scale(frame.x, -w / 2), scale(frame.y, h / 2 - style.height))) };
}

export default defineFeature<TextParams>({
  type: "cf-geo-text",
  title: "Text",
  hint: "Lettering raised from a face or cut into it, flat or round a cylinder, with no sketch to draw.",
  keywords: "text emboss engrave deboss letters label lettering font stamp name plate curved face cylinder wrap text",
  icon: '<path class="f" d="M5 5h14v3.500h-1.500l-.600-1.500H13.800v10l1.700.600V19h-7v-1.400l1.700-.600V7H7.100l-.600 1.500H5z"/><path d="M5 5h14v3.500h-1.500l-.600-1.500H13.800v10l1.700.600V19h-7v-1.400l1.700-.600V7H7.100l-.600 1.500H5z"/>',
  toolbarOrder: 309, toolbarSection: "library", toolbarMenu: "Patterns & texture", toolbarKeep: 0,
  defaults: () => ({ text: "Junction", target: null, result: "emboss", height: 8, depth: 0.8, bold: false, italic: false, x: 0, y: 0, angle: 0 }),
  schema: [
    { key: "text", label: "Text", kind: "text", hint: "Type \\n for a new line." },
    { key: "result", label: "Result", kind: "enum", options: [{ value: "emboss", label: "Emboss" }, { value: "engrave", label: "Engrave" }, { value: "new", label: "New" }] },
    { key: "target", label: "On", kind: "refs", of: ["face"], single: true, planes: true, datums: ["plane"], hint: "A face, flat or curved (the text is centred on it), or a plane for letters of their own." },
    { key: "height", label: "Height", kind: "number", unit: "mm", min: 0.1, step: 1, hint: "The height of a capital letter." },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0.01, step: 0.1, hint: "How far the letters stand out, or how deep they are cut." },
    { key: "bold", label: "Bold", kind: "boolean" },
    { key: "italic", label: "Italic", kind: "boolean" },
    { key: "x", label: "Move X", kind: "number", unit: "mm", step: 1, hint: "Along the text. Round a cylinder this is a distance round it." },
    { key: "y", label: "Move Y", kind: "number", unit: "mm", step: 1 },
    { key: "angle", label: "Turn", kind: "number", unit: "deg", step: 15 },
  ],

  evaluate(ctx: EvalContext, p: TextParams) {
    const text = linesOf(p.text);
    if (!text.trim()) throw ctx.fail("Type the text.");
    if (text.length > 400) throw ctx.fail("The text is too long (at most 400 characters).");
    if (!(p.height > 0) || !(p.depth > 0)) throw ctx.fail("The height and the depth must be more than zero.");
    if (!p.target) throw ctx.fail("Pick the face to letter, or a plane.");
    const style = { height: p.height, bold: !!p.bold, italic: !!p.italic };
    const op: ToolOp = p.result === "engrave" ? "remove" : p.result === "new" ? "new" : "add";
    const named = (shapes: Shape[]): Tool[] => shapes.map((s, i) => tagged(ctx, s, `t${i + 1}`));
    const need = () => ctx.fail("No letter could be built from this text.");

    const r = isGeomRef(p.target) ? ctx.resolve(p.target) : null;
    if (r && r.kind !== "face") throw ctx.fail("Pick a face to letter.");
    const s = r ? surfaceOf(ctx, r.shape) : { kind: "plane" as const };
    if (s.kind === "plane") {
      const place = placeOn(ctx, p.target, "face or plane");
      if (op !== "new" && !place.body) throw ctx.fail("Emboss and Engrave need a face of a part. Pick a face, or choose New.");
      const frame = centred(shifted(place.frame, p.x, p.y, p.angle), text, style);
      const faces = textFaces(ctx, frame, text, style);
      if (!faces.length) throw need();
      // raised letters start a hair inside the face and cut ones a hair above it, so neither ends exactly on it
      const skin = op === "new" ? 0 : OVERLAP, way = p.result === "engrave" ? -1 : 1;
      const from = movedFaces(ctx, faces, scale(frame.normal, -way * skin));
      applyTools(ctx, named(ctx.k.solids(prismOf(ctx, from, scale(frame.normal, way * (p.depth + skin))))), op, place.body ? [place.body] : [], "Text");
      return;
    }
    const body: Body = r!.body, face = r!.shape;
    // the plane that touches the face at its middle: the text is set on it, then carried to the surface
    const at = pointOn(ctx, face);
    let frame: Frame;
    if (s.kind === "cylinder") {
      if (p.result === "engrave" && s.outward && p.depth >= s.radius) throw ctx.fail("The depth must be less than the cylinder's radius.");
      const A = canonical(normalize(s.dir)), rel = sub(at, s.origin), radial = normalize(sub(rel, scale(A, dot(rel, A))));
      // read from outside a shaft, from inside a bore: the baseline runs round, capitals stand along the axis
      const out = s.outward ? radial : scale(radial, -1);
      frame = { origin: at, x: cross(A, out), y: A, normal: out };
    } else {
      const n = normalAt(ctx, face), y0: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
      const x = normalize(cross(y0, n));
      frame = { origin: at, x, y: cross(n, x), normal: n };
    }
    frame = centred(shifted(frame, p.x, p.y, p.angle), text, style);
    let solids: Shape[];
    if (s.kind === "cylinder") {
      // the letters go away from the axis (raised on a shaft, cut into a bore's wall) or towards it, and reach
      // half a millimetre past the surface on the other side, so that they cross it instead of ending on it
      const away = (p.result === "engrave") !== s.outward, lap = op === "new" ? 0 : Math.min(0.5, s.radius / 4);
      if (!away && p.depth >= s.radius) throw ctx.fail("The depth must be less than the cylinder's radius.");
      solids = textOnCylinder(ctx, { origin: s.origin, dir: s.dir, radius: s.radius }, frame, at, text, style, away ? s.radius - lap : s.radius - p.depth, away ? s.radius + p.depth : s.radius + lap);
      if (!solids.length) throw need();
    } else {
      // straight onto the surface: what of the letters' column lies in a skin of the face `depth` thick
      const faces = textFaces(ctx, frame, text, style);
      if (!faces.length) throw need();
      const reach = 4 * p.depth + 0.5 * Math.hypot(widthOfText(text, style), p.height) + 10;
      const column = prismOf(ctx, movedFaces(ctx, faces, scale(frame.normal, -reach)), scale(frame.normal, 2 * reach));
      let skin: Shape;
      try { skin = p.result === "engrave" ? thickenSheet(ctx, [face], 0, p.depth) : thickenSheet(ctx, [face], p.depth, 0); }
      catch (e) { throw ctx.fail("This face cannot be lettered to that depth. Try less depth, or a flatter face."); }
      const oc = ctx.oc as any;
      const algo = ctx.tmp(new oc.BRepAlgoAPI_Common(column, skin, ctx.tmp(new oc.Message_ProgressRange())));
      algo.Build(ctx.tmp(new oc.Message_ProgressRange()));
      if (!algo.IsDone() || algo.HasErrors()) throw ctx.fail("The text could not be laid on this face.");
      solids = ctx.k.solids(ctx.own(algo.Shape()));
      if (!solids.length) throw ctx.fail("The text does not land on the face. Move it, or make it smaller.");
    }
    applyTools(ctx, named(solids), op, [body], "Text");
  },
});

function movedFaces(ctx: EvalContext, faces: readonly Shape[], by: Vec3): Shape {
  const oc = ctx.oc as any;
  const t = ctx.tmp(new oc.gp_Trsf());
  t.SetTranslation(ctx.tmp(ctx.k.vec(by)));
  const all = faces.length === 1 ? faces[0] : compound(ctx.k, faces, ctx.own);
  return ctx.own(ctx.tmp(new oc.BRepBuilderAPI_Transform(all, t, true, false)).Shape());
}
