// cf-hw-pcb-mounts.ts — PCB mounts: the posts a circuit board is screwed to, in the board's own hole pattern:
// a Raspberry Pi, a Pi Zero, a Pico, an Arduino Uno or Nano, or any rectangle of four holes.  Each post takes a
// screw (a hole for a thread-forming screw or a tap, or for a heat-set insert) or ends in a locating pin that
// goes through the board's hole.  The posts stand on the picked plane and join the bodies they touch.
//
// (Standoffs, in the Board menu, puts posts under the holes of a board that is in the part studio.  This one
// needs no board: the pattern comes from a table.)
//
// Names: `<id>:<place>:m<n>:side`, `:top`, `:bottom`, `:hole`, `:hole:floor`, `:pin`, `:pin:top`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { apply, cornerPoints, frameAt, poly, prefixAt, revolved, spots, type Tool, type V2 } from "../kernel/ops/cf-hw";
import { BOARD_PATTERNS, fastenerOf, fastenerOptions, HW_SECTION, MENU_ENCLOSURES, resultFields, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PcbMountsParams {
  [key: string]: any;
  board: string; dx: number; dy: number; screw: string; height: number; diameter: number;
  top: "tap" | "insert" | "pin"; pinHeight: number; operation: "new" | "add"; targets: string[];
}

export default defineFeature<PcbMountsParams>({
  type: "cf-hw-pcb-mounts",
  title: "PCB mounts",
  icon: '<rect class="f" x="4.5" y="12" width="4" height="8"/><rect class="f" x="15.5" y="12" width="4" height="8"/><path d="M4.5 12v8M8.5 12v8M15.5 12v8M19.5 12v8M2.5 20.5h19"/><path class="d" d="M2.5 9.5h19v-3h-19z"/><path class="t" d="M6.5 12V5M17.5 12V5"/>',
  hint: "Add mounting posts in a circuit board's hole pattern: Raspberry Pi, Arduino, or any rectangle",
  keywords: "pcb standoff mount pattern posts bosses raspberry pi arduino uno nano pico board mounting holes",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_ENCLOSURES, toolbarOrder: 31, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), board: "pi", dx: 50, dy: 30, screw: "auto", height: 5, diameter: 0, top: "tap", pinHeight: 2.5, operation: "add", targets: [] }),
  schema: [
    { key: "board", label: "Board", kind: "enum", options: Object.keys(BOARD_PATTERNS).map((b) => ({ value: b, label: BOARD_PATTERNS[b].label })) },
    { key: "dx", label: "Holes across", kind: "number", unit: "mm", min: 0, step: 1, visible: (p) => p.board === "custom" },
    { key: "dy", label: "Holes up", kind: "number", unit: "mm", min: 0, step: 1, visible: (p) => p.board === "custom" },
    { key: "screw", label: "Screw", kind: "enum", options: [{ value: "auto", label: "The board's" }, ...fastenerOptions().slice(0, 6)] },
    { key: "height", label: "Height", kind: "number", unit: "mm", min: 0.5, step: 1 },
    { key: "diameter", label: "Post Ø", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "0 for twice the screw plus 1 mm." },
    { key: "top", label: "Top", kind: "enum", options: [{ value: "tap", label: "Screw hole" }, { value: "insert", label: "Insert" }, { value: "pin", label: "Pin" }], hint: "A hole for a thread-forming screw or a tap, the hole of a heat-set insert, or a pin that goes through the board." },
    { key: "pinHeight", label: "Pin height", kind: "number", unit: "mm", min: 0.2, step: 0.5, visible: (p) => p.top === "pin" },
    ...whereFields({ angle: true, noun: "set of posts" }),
    ...resultFields,
  ],

  evaluate(ctx: EvalContext, p: PcbMountsParams) {
    const board = BOARD_PATTERNS[p.board];
    if (!board) throw ctx.fail("Pick a board, or Custom rectangle.");
    const holes: V2[] = p.board === "custom" ? cornerPoints(Number(p.dx) || 0, Number(p.dy) || 0) : board.holes;
    const f = fastenerOf(p.screw === "auto" || !p.screw ? board.screw : p.screw);
    if (!f) throw ctx.fail(`The size table has no ${p.screw}.`);
    const H = Number(p.height);
    if (!(H > 0)) throw ctx.fail("The height must be more than zero.");
    const D = p.diameter > 0 ? Number(p.diameter) : (p.top === "insert" ? f.insert[0] + 3 : 2 * f.d + 1);
    const hole = p.top === "insert" ? f.insert : [f.tap, Math.min(H - 0.6, 2.5 * f.d)];
    if (p.top !== "pin" && !(D > hole[0] + 1)) throw ctx.fail(`The post must be at least 1 mm wider than its hole (${hole[0]} mm).`);
    const tools: Tool[] = [];
    for (const s of spots(ctx, p)) {
      const posts = holes.map((q, i) => {
        let pts: V2[], roles: (string | null)[];
        if (p.top === "pin") {
          // the pin is a little thinner than the board's hole, its end chamfered to find it
          const rp = (f.d - 0.2) / 2, hp = Number(p.pinHeight) || 2.5, c = Math.min(0.4, rp / 2);
          pts = [[0, 0], [D / 2, 0], [D / 2, H], [rp, H], [rp, H + hp - c], [rp - c, H + hp], [0, H + hp]];
          roles = ["bottom", "side", "top", "pin", "pin:edge", "pin:top", null];
        } else {
          const depth = Math.min(hole[1], H - 0.4);
          pts = depth > 0.2 ? [[0, 0], [D / 2, 0], [D / 2, H], [hole[0] / 2, H], [hole[0] / 2, H - depth], [0, H - depth]] : [[0, 0], [D / 2, 0], [D / 2, H], [0, H]];
          roles = depth > 0.2 ? ["bottom", "side", "top", "hole", "hole:floor", null] : ["bottom", "side", "top", null];
        }
        return revolved(ctx, frameAt(s.frame, q), poly(pts, roles), `${prefixAt(ctx, s)}:m${i + 1}`);
      });
      posts.forEach((post, i) => tools.push({ ...post, suffix: `${s.key}.m${i + 1}` }));
    }
    // each post is a body of its own, or joins what it stands on
    apply(ctx, tools, p, "add");
  },
});
