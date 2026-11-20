// cf-fab-nest.ts — Auto layout: lay flat parts out on sheets for cutting.
//
// Each part is laid on its larger flat side on the layout plane and the parts are packed by the rectangle
// around them, largest first, in rows across the sheet, a spacing apart and a margin in from the sheet's edge;
// when a sheet is full the next one starts beside it.  With "Lock the grain" every part keeps its long side
// along the sheet's length; otherwise a part is turned a quarter where that packs tighter.  The parts are
// copied (the model stays as it is) or moved.  Nesting is by rectangle, not by true shape: a part is never put
// inside another's cut-out.
// Bodies: `<id>:<part id>` for a copy (the faces keep the part's names); the sheets are reference bodies
// `<id>:sheet<n>`.
import { defineFeature } from "../core/feature";
import type { Frame, PlaneRef } from "../core/geometry";
import type { Body, EvalContext } from "../kernel/types";
import { scoped } from "../kernel/ops/combine";
import { at, box, frameAt, moved, place, plateOf, positive, type Plate } from "../kernel/ops/cf-fab";
import { LASER } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface NestParams { [key: string]: any; bodies: string[]; plane: PlaneRef; sheetLength: number; sheetWidth: number; spacing: number; margin: number; grain: boolean; move: boolean; sheets: boolean }

export interface Placed { index: number; sheet: number; x: number; y: number; turned: boolean }

/**
 * Pack rectangles (w along the sheet's length, h across) in rows, largest first.  Returns where each one's
 * lower left corner goes, on which sheet, and whether it was turned a quarter; null for one that fits no sheet.
 */
export function packRows(items: readonly { w: number; h: number }[], L: number, W: number, gap: number, margin: number, turn: boolean): (Placed | null)[] {
  const availL = L - 2 * margin, availW = W - 2 * margin;
  const out: (Placed | null)[] = items.map(() => null);
  const order = items.map((it, index) => {
    let { w, h } = it, turned = false;
    // lie along the sheet unless only the other way fits
    if (turn && ((h > w && h <= availL + 1e-9 && w <= availW + 1e-9) || w > availL + 1e-9 || h > availW + 1e-9)) { [w, h] = [h, w]; turned = true; }
    return { index, w, h, turned, fits: w <= availL + 1e-9 && h <= availW + 1e-9 };
  }).sort((a, b) => b.h - a.h || b.w - a.w || a.index - b.index);
  // rows of each sheet: where the next part goes in the row, the row's bottom and height
  const sheets: { rows: { x: number; y: number; h: number }[] }[] = [];
  for (const it of order) {
    if (!it.fits) continue;
    let done = false;
    for (let s = 0; !done; s++) {
      if (!sheets[s]) sheets[s] = { rows: [] };
      const rows = sheets[s].rows;
      for (const row of rows) {
        // the part as it lies, or turned to stand in a row that is tall enough
        const opts = [{ w: it.w, h: it.h, turned: it.turned }];
        if (turn && it.w !== it.h) opts.push({ w: it.h, h: it.w, turned: !it.turned });
        const fit = opts.filter((o) => o.h <= row.h + 1e-9 && row.x + o.w <= availL + 1e-9).sort((a, b) => a.w - b.w)[0];
        if (!fit) continue;
        out[it.index] = { index: it.index, sheet: s, x: margin + row.x, y: margin + row.y, turned: fit.turned };
        row.x += fit.w + gap; done = true; break;
      }
      if (done) break;
      const y = rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h + gap : 0;
      if (y + it.h <= availW + 1e-9) {
        rows.push({ x: it.w + gap, y, h: it.h });
        out[it.index] = { index: it.index, sheet: s, x: margin, y: margin + y, turned: it.turned };
        done = true;
      }
    }
  }
  return out;
}

export default defineFeature<NestParams>({
  type: "cf-fab-nest",
  title: "Auto layout",
  icon: '<path class="t" d="M2 3h20v18H2z"/><path class="f" d="M4 5h9v6H4zM15 5h5v9h-5zM4 13h4v6H4zM10 13h3v6h-3z"/><path d="M4 5h9v6H4zM15 5h5v9h-5zM4 13h4v6H4zM10 13h3v6h-3z"/>',
  hint: "Lay flat parts out on sheets for cutting, with spacing and grain lock",
  keywords: "auto layout nest nesting sheet flat pattern laser cnc cut list arrange pack plywood grain",
  ...LASER, toolbarOrder: 30,
  defaults: () => ({ bodies: [], plane: { kind: "plane", plane: "top" }, sheetLength: 600, sheetWidth: 300, spacing: 3, margin: 5, grain: false, move: false, sheets: true }),
  schema: [
    { key: "bodies", label: "Parts", kind: "bodies", hint: "Leave empty for every body." },
    { key: "plane", label: "Layout plane", kind: "plane", hint: "The parts are laid on this plane, the first sheet's corner at its origin." },
    { key: "sheetLength", label: "Sheet length", kind: "number", unit: "mm", min: 1, step: 10 },
    { key: "sheetWidth", label: "Sheet width", kind: "number", unit: "mm", min: 1, step: 10 },
    { key: "spacing", label: "Spacing", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "Between two parts." },
    { key: "margin", label: "Edge margin", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "Between a part and the sheet's edge." },
    { key: "grain", label: "Lock the grain", kind: "boolean", hint: "Keep every part's long side along the sheet's length." },
    { key: "move", label: "Move the parts", kind: "boolean", hint: "Off: the layout is made of copies and the model stays as it is." },
    { key: "sheets", label: "Show the sheets", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: NestParams) {
    const id = ctx.feature.id;
    const L = positive(ctx, p.sheetLength, "sheet length"), W = positive(ctx, p.sheetWidth, "sheet width");
    const gap = Math.max(0, Number(p.spacing) || 0), margin = Math.max(0, Number(p.margin) || 0);
    if (2 * margin >= Math.min(L, W)) throw ctx.fail("The edge margin leaves nothing of the sheet.");
    const parts = scoped(ctx, p.bodies);
    if (!parts.length) throw ctx.fail("There is no part to lay out.");
    if (parts.length > 300) throw ctx.fail("That is too many parts at once (at most 300).");
    const base = ctx.frameOf(p.plane);
    const flat: { body: Body; plate: Plate }[] = parts.map((body) => ({ body, plate: plateOf(ctx, body) }));
    const where = packRows(flat.map((f) => ({ w: f.plate.size[0], h: f.plate.size[1] })), L, W, gap, margin, !p.grain);
    const lost = where.findIndex((w) => !w);
    if (lost >= 0) { const s = flat[lost].plate.size; throw ctx.fail(`${flat[lost].body.name} (${Math.round(s[0] * 10) / 10} × ${Math.round(s[1] * 10) / 10} mm) is larger than the sheet${p.grain ? " with its long side along the sheet" : ""}.`); }
    const step = L + Math.max(20, L * 0.05);   // sheets lie side by side along the plane's x
    let sheetCount = 0;
    flat.forEach(({ body, plate }, i) => {
      const w = where[i]!;
      sheetCount = Math.max(sheetCount, w.sheet + 1);
      const a = plate.size[0], b = plate.size[1];
      // the part's frame is at the middle of its top; it lands with its bottom on the plane
      const cx = w.sheet * step + w.x + (w.turned ? b : a) / 2, cy = w.y + (w.turned ? a : b) / 2;
      const to: Frame = moved(base, cx, cy, plate.thickness, w.turned ? 90 : 0);
      const names = (f: any) => body.topo.faces.find((n) => n.shape.IsSame(f))?.name ?? null;
      const r = place(ctx, body.shape, names, plate.frame, to);
      if (p.move) ctx.replaceBody(body, r.shape, r.names);
      else ctx.addBody(r.shape, r.names, { suffix: body.id, name: body.name });
    });
    if (p.sheets) for (let s = 0; s < sheetCount; s++) {
      const sheet = box(ctx, frameAt(at(base, s * step, 0, 0), base.x, base.normal), [0, 0, -0.5], [L, W, -0.02], `${id}:sheet${s + 1}`);
      ctx.addBody(sheet.shape, sheet.names, { suffix: `sheet${s + 1}`, name: `Sheet ${s + 1}`, reference: true });
    }
  },
});
