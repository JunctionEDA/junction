// frame-trim.ts — Trim (frame trim): cut frame members back to a flat face or to other parts.  A face trims at
// its plane; parts are cut out of the member.  The larger piece is kept (or the smaller, flipped), and the
// member's length and end angle in the cut list follow.
import { defineFeature } from "../core/feature";
import type { GeomRef, Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { bool } from "../kernel/ops/sheetmetal";
import { cutAngle, cutBeyond, extentAlong, frameStore, keptNames, pickSolid, setItems, type FrameItem } from "../kernel/ops/frame";
import { FRAME_SECTION } from "./_frame";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FrameTrimParams { [key: string]: any; members: string[]; faces: GeomRef[]; tools: string[]; flip: boolean }

export default defineFeature<FrameTrimParams>({
  type: "frame-trim",
  title: "Trim",
  icon: '<path class="f" d="M3 9h12v6H3z"/><path d="M3 9h12v6H3z"/><path class="t" d="M17 4v16"/><path d="M15 9l2 3-2 3"/>',
  hint: "Trim frame members to a face or to other parts",
  keywords: "trim frame member cut to face body cope",
  toolbarSection: FRAME_SECTION, toolbarOrder: 20, toolbarKeep: 48,
  defaults: () => ({ members: [], faces: [], tools: [], flip: false }),
  schema: [
    { key: "members", label: "Members to trim", kind: "bodies" },
    { key: "faces", label: "Trim to faces", kind: "refs", of: ["face"], hint: "Flat faces: the member is cut at their plane." },
    { key: "tools", label: "Trim to parts", kind: "bodies", hint: "Parts cut out of the member." },
    { key: "flip", label: "Keep the other side", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: FrameTrimParams) {
    const k = ctx.k, store = frameStore(ctx);
    if (!p.members || !p.members.length) throw ctx.fail("Pick the frame members to trim.");
    const planes: { at: Vec3; n: Vec3 }[] = [];
    for (const ref of p.faces || []) {
      const fr = k.faceFrame(ctx.resolve(ref).shape as any);
      if (!fr) throw ctx.fail("Trim to flat faces (or pick parts to trim to).");
      planes.push({ at: fr.origin, n: fr.normal });
    }
    const tools = (p.tools || []).filter((t) => !p.members.includes(t)).map((t) => { const b = ctx.body(t); if (!b) throw ctx.fail("A part to trim to is gone. Pick it again."); return b.shape; });
    if (!planes.length && !tools.length) throw ctx.fail("Pick the faces or parts to trim to.");
    const items: FrameItem[] = [];
    for (const id of p.members) {
      const body = ctx.body(id);
      if (!body) throw ctx.fail("A member to trim is gone. Pick it again.");
      let shape = body.shape;
      const item = store[id];
      const angles: [number, number] = item ? [...item.angles] : [0, 0];
      for (const pl of planes) {
        const a = cutBeyond(k, shape, pl.at, pl.n, ctx.own), b = cutBeyond(k, shape, pl.at, [-pl.n[0], -pl.n[1], -pl.n[2]], ctx.own);
        const big = k.volume(a) >= k.volume(b);
        shape = big !== !!p.flip ? a : b;
        if (item?.axis) {
          const ax = item.axis, d: Vec3 = [ax[1][0] - ax[0][0], ax[1][1] - ax[0][1], ax[1][2] - ax[0][2]];
          // which end the plane cut: the one nearer it
          const da = Math.abs((ax[0][0] - pl.at[0]) * pl.n[0] + (ax[0][1] - pl.at[1]) * pl.n[1] + (ax[0][2] - pl.at[2]) * pl.n[2]);
          const db = Math.abs((ax[1][0] - pl.at[0]) * pl.n[0] + (ax[1][1] - pl.at[1]) * pl.n[1] + (ax[1][2] - pl.at[2]) * pl.n[2]);
          angles[da <= db ? 0 : 1] = cutAngle(d, pl.n);
        }
      }
      for (const t of tools) shape = pickSolid(k, bool(k, "cut", shape, t, ctx.own), !!p.flip);
      const next = ctx.replaceBody(body, shape, keptNames(k, body.topo.faces, `${ctx.feature.id}:cut`));
      if (item) {
        let length = item.length;
        if (item.axis) {
          const ax = item.axis, L = Math.hypot(ax[1][0] - ax[0][0], ax[1][1] - ax[0][1], ax[1][2] - ax[0][2]) || 1;
          const d: Vec3 = [(ax[1][0] - ax[0][0]) / L, (ax[1][1] - ax[0][1]) / L, (ax[1][2] - ax[0][2]) / L];
          const [lo, hi] = extentAlong(k, next.shape, ax[0], d);
          length = hi - lo;
        }
        items.push({ ...item, length, angles });
      }
    }
    if (items.length) setItems(ctx, items);
  },
});
