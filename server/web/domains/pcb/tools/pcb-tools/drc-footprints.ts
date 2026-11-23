// pcb-tools/drc-footprints.ts — DRC_TEST_PROVIDER_FOOTPRINT_CHECKS (pcbnew/drc/drc_test_provider_footprint_checks.cpp)
// on the board's footprints: FOOTPRINT_UTILS::CheckFootprintAttributes (footprint_type_mismatch), a scaled footprint
// with pads (footprint_scaled_with_pads), FOOTPRINT_UTILS::CheckPads through ConvertPadCheckToDrcCode (padstack,
// padstack_invalid, through_hole_pad_without_hole) and, on a net tie, CheckNetTiePadGroups (footprint).
import type { BoardDoc, DesignSettings, DrcMarker } from "./types";
import { DRC_ITEMS } from "../../canvas/drc-items";
import { marker, withKiids } from "./drc";
import { checkPad } from "./fp-check";
import { padsOf } from "./route-geom";
import { K } from "./state";
import { layerOf } from "./util";

/** ConvertPadCheckToDrcCode: PAD_SIZE_NOT_POSITIVE, UNEXPECTED_HOLE and NON_COMPONENT_NO_COPPER are padstack_invalid. */
function padCode(code: string, msg: string): string {
  if (code !== "padstack") return code;
  return msg === "Pad size must be greater than zero" || / pad has a hole$/.test(msg) || / pad has no copper layers$/.test(msg) ? "padstack_invalid" : "padstack";
}
const title = (code: string) => (DRC_ITEMS.find((i) => i[1] === code) || [code])[0];
/** DRC_ITEM's message: the title, then the error detail when there is one. */
const text = (code: string, detail: string) => (detail ? `${title(code)} ${detail}` : title(code));

export function footprintCheckMarkers(doc: BoardDoc, s: DesignSettings): DrcMarker[] {
  const out: DrcMarker[] = [];
  const def = (code: string) => (DRC_ITEMS.find((i) => i[1] === code) || ["", "", "error"])[2];
  const on = (code: string) => (s.severities[code] || def(code)) !== "ignore";
  for (const fp of doc.items.values()) {
    if (fp.kind !== "footprint") continue;
    const n = fp.node, [x, y] = K.atOf(n) as number[], layer = layerOf(n, "F.Cu"), uuid = K.uuidOf(n) || fp.id;
    const attrs = (K.kid(n, "attr") || []).slice(1).map((a: unknown) => String(a));
    const pads = padsOf(fp);
    const fpMarker = (code: string, detail: string) => { const m = withKiids(marker(code, def(code), x, y, text(code, detail), [fp.id]), [uuid]); m.layer = layer; out.push(m); };
    // CheckFootprintAttributes: GetLikelyAttribute against the FP_SMD / FP_THROUGH_HOLE attribute
    if (on("footprint_type_mismatch")) {
      const likely = pads.some((p) => p.type === "thru_hole") ? "through_hole" : pads.some((p) => p.type === "smd") ? "smd" : "";
      const set = attrs.includes("smd") ? "smd" : attrs.includes("through_hole") ? "through_hole" : "";
      if (set && likely && set !== likely) fpMarker("footprint_type_mismatch", `(expected '${likely === "smd" ? "SMD" : "Through hole"}'; actual '${set === "smd" ? "SMD" : "Through hole"}')`);
    }
    // !GetTransform().HasUnitScale() with pads
    if (on("footprint_scaled_with_pads") && pads.length) {
      const t = K.kid(n, "transform"), sc = t && K.kid(t, "scale");
      if (sc && (K.num(sc[1], 1) !== 1 || K.num(sc[2], K.num(sc[1], 1)) !== 1)) fpMarker("footprint_scaled_with_pads", "");
    }
    // CheckPads: each pad at its board position on its principal layer
    for (const p of pads) {
      const cu = p.layers.filter((l) => /\.Cu$/.test(l));
      const principal = cu.some((l) => l === "F.Cu" || l === "*.Cu" || l === "F&B.Cu") ? "F.Cu" : cu.includes("B.Cu") ? "B.Cu" : cu[0] || p.layers[0] || layer;
      for (const r of checkPad(p.node)) {
        const code = padCode(r.code, r.msg); if (!on(code)) continue;
        const m = withKiids(marker(code, def(code), p.x, p.y, text(code, r.msg ? `(${r.msg})` : ""), [fp.id]), [K.uuidOf(p.node) || uuid]); m.layer = principal; out.push(m);
      }
    }
    // a net tie: CheckNetTiePadGroups over MapPadNumbersToNetTieGroups (one entry per pad number, in order)
    const groups = (K.kid(n, "net_tie_pad_groups") || []).slice(1).map((g: unknown) => String(g).split(/[,\s]+/).filter(Boolean));
    if (groups.length && on("footprint")) {
      const numbers = Array.from(new Set(([] as string[]).concat(...groups))).sort();
      for (const num of numbers) if (!pads.some((p) => p.number === num)) fpMarker("footprint", `(net-tie pad group contains unknown pad number ${num})`);
    }
  }
  return out;
}
