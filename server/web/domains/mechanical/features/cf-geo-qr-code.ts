// cf-geo-qr-code.ts — the QR code feature: a QR code or a Data Matrix of a text, raised from a flat face, sunk
// into it, or as a tile of its own on a plane.  The code is worked out here from the text (features/
// _cf-geo-code.ts), so it follows the text when a variable or a revision changes it; a phone reads the part.
// The dark modules are what is raised (or sunk); Invert makes it the light ones, for a part that is dark where
// it is high.  A quiet zone of plain surface is kept round the code by the tile, and is the user's to keep on a
// face.
//
// Names: the dark modules are gathered into rectangles, and a rectangle's faces are `<id>:m<column>.<row>:<k>`,
// by the module at its top left corner; the tile's are `<id>:tile:<k>`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { OVERLAP, applyTools, boxIn, placeOn, shifted, tagged, type ToolOp } from "../kernel/ops/cf-geo";
import type { Tool } from "../kernel/ops/pattern-core";
import { dataMatrix, moduleRectangles, qrCode, type CodeMatrix, type QrLevel } from "./_cf-geo-code";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface QrCodeParams {
  [key: string]: any;
  text: string; kind: "qr" | "datamatrix"; level: QrLevel; target: RefTarget | null; result: "emboss" | "engrave" | "new";
  size: number; depth: number; x: number; y: number; angle: number; invert: boolean; tile: number; quiet: number;
}

export default defineFeature<QrCodeParams>({
  type: "cf-geo-qr-code",
  title: "QR code",
  hint: "A QR code or Data Matrix of a text, raised from a face, cut into it, or as its own tile.",
  keywords: "qr code data matrix datamatrix barcode 2d code emboss engrave label serial number url scan part marking",
  icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect class="s" x="5.300" y="5.300" width="2.400" height="2.400"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect class="s" x="16.300" y="5.300" width="2.400" height="2.400"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect class="s" x="5.300" y="16.300" width="2.400" height="2.400"/><path class="s" d="M13.500 13.500h2.500v2.500h-2.500zM18.500 13.500h2.500v2.500h-2.500zM16 16h2.500v2.500H16zM13.500 18.500h2.500V21h-2.500zM18.500 18.500h2.500V21h-2.500z"/>',
  toolbarOrder: 310, toolbarSection: "library", toolbarMenu: "Patterns & texture", toolbarKeep: 0,
  defaults: () => ({ text: "https://example.com", kind: "qr", level: "M", target: null, result: "emboss", size: 25, depth: 0.6, x: 0, y: 0, angle: 0, invert: false, tile: 1.2, quiet: 4 }),
  schema: [
    { key: "text", label: "Text", kind: "text", hint: "What a reader gets: a web address, a serial number, any text." },
    { key: "kind", label: "Code", kind: "enum", options: [{ value: "qr", label: "QR code" }, { value: "datamatrix", label: "Data Matrix" }] },
    { key: "level", label: "Error correction", kind: "enum", options: [{ value: "L", label: "L 7%" }, { value: "M", label: "M 15%" }, { value: "Q", label: "Q 25%" }, { value: "H", label: "H 30%" }], hint: "How much of the code may be damaged and still read. More makes a denser code.", visible: (p) => p.kind !== "datamatrix" },
    { key: "result", label: "Result", kind: "enum", options: [{ value: "emboss", label: "Emboss" }, { value: "engrave", label: "Engrave" }, { value: "new", label: "New tile" }] },
    { key: "target", label: "On", kind: "refs", of: ["face"], single: true, planes: true, datums: ["plane"], hint: "A flat face (the code is centred on it), or a plane for a tile." },
    { key: "size", label: "Size", kind: "number", unit: "mm", min: 1, step: 1, hint: "The side of the code, without the quiet zone round it." },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0.01, step: 0.1, hint: "How far the modules stand out, or how deep they are cut." },
    { key: "x", label: "Move X", kind: "number", unit: "mm", step: 1 },
    { key: "y", label: "Move Y", kind: "number", unit: "mm", step: 1 },
    { key: "angle", label: "Turn", kind: "number", unit: "deg", step: 15 },
    { key: "invert", label: "Invert", kind: "boolean", hint: "Raise (or cut) the light modules instead of the dark ones." },
    { key: "tile", label: "Tile thickness", kind: "number", unit: "mm", min: 0.01, step: 0.2, visible: (p) => p.result === "new" },
    { key: "quiet", label: "Quiet zone", kind: "number", unit: "none", min: 0, max: 20, step: 1, hint: "Plain modules round the code: a QR code wants 4, a Data Matrix 1.", visible: (p) => p.result === "new" },
  ],

  evaluate(ctx: EvalContext, p: QrCodeParams) {
    const text = String(p.text ?? "");
    if (!text) throw ctx.fail("Type the text the code should hold.");
    if (!(p.size > 0) || !(p.depth > 0)) throw ctx.fail("The size and the depth must be more than zero.");
    let code: CodeMatrix;
    try { code = p.kind === "datamatrix" ? dataMatrix(text) : qrCode(text, (["L", "M", "Q", "H"].includes(p.level) ? p.level : "M") as QrLevel); }
    catch (e) { throw ctx.fail(e instanceof Error ? e.message : String(e)); }
    const place = placeOn(ctx, p.target, p.result === "new" ? "face or plane for the tile" : "face for the code");
    if (p.result !== "new" && !place.body) throw ctx.fail("Emboss and Engrave need a face of a part. Pick a flat face, or choose New tile.");
    const frame = shifted(place.frame, p.x, p.y, p.angle);
    const m = p.size / code.size, half = p.size / 2;
    if (m < 0.1) ctx.warn(`The modules are ${m.toFixed(2)} mm wide: too fine to make or to read. Use a larger size or a shorter text.`);
    // the modules stand on the face (emboss, tile) or go down from it (engrave), starting a hair on its other side
    const lo = p.result === "engrave" ? -p.depth : -OVERLAP, hi = p.result === "engrave" ? OVERLAP : p.depth;
    const rects = moduleRectangles(code, !p.invert);
    if (!rects.length) throw ctx.fail("The code has no modules to make.");
    const tools: Tool[] = rects.map(([cx, cy, w, h]) => tagged(ctx, boxIn(ctx, frame, -half + cx * m, half - (cy + h) * m, -half + (cx + w) * m, half - cy * m, lo, hi), `m${cx}.${cy}`));
    if (p.result === "new") {
      if (!(p.tile > 0)) throw ctx.fail("The tile's thickness must be more than zero.");
      const q = Math.max(0, Number(p.quiet) || 0) * m + half;
      tools.unshift(tagged(ctx, boxIn(ctx, frame, -q, -q, q, q, -p.tile, 0), "tile"));
      // one body: the tile with the modules joined to it
      const tile = ctx.addBody(tools[0].shape, (f) => tools[0].faces.find((x) => x.shape.IsSame(f))?.name ?? null, { name: p.kind === "datamatrix" ? "Data Matrix" : "QR code" });
      applyTools(ctx, tools.slice(1), "add", [tile]);
      return;
    }
    const op: ToolOp = p.result === "engrave" ? "remove" : "add";
    applyTools(ctx, tools, op, [place.body!]);
  },
});
