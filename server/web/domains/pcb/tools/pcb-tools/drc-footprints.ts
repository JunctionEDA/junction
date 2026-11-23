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
import type { Pt } from "./types";
import type { Prim, Pt as FabPt } from "../../fab/prims";
import { copperCtx, shapePolys, type CopperCtx } from "./drc-sliver";
import { geomShapes } from "./drc-silk";
import { padPrims } from "../../fab/plot";
import { primPolys, union } from "../../fab/poly";
import { arcPoints, nearestOnSeg, polyPointDist, polyPolyDist } from "./distances";
import type { CopperShape } from "./types";
import { pointInPoly } from "./hit";

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
  let cc: CopperCtx | null = null;
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
    if (groups.length && on("shorting_items")) {   // FOOTPRINT_UTILS::CheckNetTies (the footprint's copper may join only pads of one group)
      if (!cc) cc = copperCtx(doc);
      for (const sh of checkNetTies(doc, fp, groups, cc)) { const m = withKiids(marker("shorting_items", def("shorting_items"), sh.pos[0], sh.pos[1], title("shorting_items"), [fp.id]), sh.kiids) as DrcMarker & { netTie?: boolean }; m.layer = layer; m.netTie = true; out.push(m); }
    }
    if (groups.length && on("footprint")) {
      const numbers = Array.from(new Set(([] as string[]).concat(...groups))).sort();
      for (const num of numbers) if (!pads.some((p) => p.number === num)) fpMarker("footprint", `(net-tie pad group contains unknown pad number ${num})`);
    }
  }
  return out;
}

/** A footprint graphic as copper shapes in board coordinates: its stroke, and its area when filled (PCB_SHAPE::TransformShapeToPolygon). */
export function fpShapeOutline(g: SNode, kind: string, tf: (x: number, y: number) => Pt): CopperShape[] {
  const st = K.kid(g, "stroke"), wn = st ? K.kid(st, "width") : K.kid(g, "width"); const r = (wn ? K.num(wn[1], 0) : 0) / 2;
  const fl = K.kid(g, "fill"); const ft = fl && (Array.isArray(fl[1]) ? K.kid(fl, "type") : fl); const filled = !!ft && ["yes", "solid", "hatch", "reverse_hatch", "cross_hatch"].includes(K.str(ft[1]));
  const P = (k: string): Pt | null => { const c = K.kid(g, k); return c ? tf(K.num(c[1], 0), K.num(c[2], 0)) : null; };
  const closed = (pts: Pt[]): CopperShape[] => { const out: CopperShape[] = []; if (filled && pts.length > 2) out.push({ t: "poly", pts }); if (r > 0) out.push({ t: "path", pts: pts.concat([pts[0]]), r }); return out; };
  if (kind === "line") { const a = P("start"), b = P("end"); return a && b ? [{ t: "seg", a, b, r }] : []; }
  if (kind === "arc") { const a = P("start"), m = P("mid"), b = P("end"); if (!a || !m || !b) return []; const c = K.arcFrom3(a, m, b); return [{ t: "path", pts: c ? arcPoints(c, a, b) : [a, b], r }]; }
  if (kind === "circle") {
    const c = P("center"), e = P("end"); if (!c || !e) return []; const R = Math.hypot(e[0] - c[0], e[1] - c[1]);
    if (filled) return [{ t: "circle", x: c[0], y: c[1], r: R + r }];
    const pts: Pt[] = []; for (let i = 0; i <= 64; i++) pts.push([c[0] + R * Math.cos(i * Math.PI / 32), c[1] + R * Math.sin(i * Math.PI / 32)]); return r > 0 ? [{ t: "path", pts, r }] : [];
  }
  if (kind === "rect") {
    const s0 = K.kid(g, "start"), e0 = K.kid(g, "end"); if (!s0 || !e0) return [];
    const x0 = K.num(s0[1], 0), y0 = K.num(s0[2], 0), x1 = K.num(e0[1], 0), y1 = K.num(e0[2], 0);
    return closed([tf(x0, y0), tf(x1, y0), tf(x1, y1), tf(x0, y1)]);
  }
  if (kind === "poly") { const ps = K.kid(g, "pts"); return closed(ps ? (K.ptsOf(g) as Pt[]).map((q) => tf(q[0], q[1])) : []); }
  if (kind === "curve") { const q = K.bezierPts(K.ptsOf(g)).map((v: number[]) => tf(v[0], v[1])); return q.length > 1 ? [{ t: "path", pts: q, r }] : []; }
  return [];
}
/**
 * FOOTPRINT_UTILS::CheckNetTies: on each copper layer the footprint's own copper (its graphics, non-rule-area zones
 * and fields on copper) is merged into outlines; every outline touching two pads that are not in one net-tie pad group
 * shorts them.  The marker sits on the outline nearest the pads' midpoint, naming the shorting item when one is
 * there and the two pads.
 */
export function checkNetTies(doc: BoardDoc, fp: KItem, groups: string[][], cc: CopperCtx): { pos: Pt; kiids: string[] }[] {
  const out: { pos: Pt; kiids: string[] }[] = [];
  const fm = cc.m.footprints.find((f) => f.node === fp.node); if (!fm) return out;
  const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const cuOf = (ls: string[]) => { const r = new Set<string>(); for (const l of ls) { if (l === "*.Cu" || l === "F&B.Cu") (l === "*.Cu" ? copper : ["F.Cu", "B.Cu"]).forEach((c) => r.add(c)); else if (copper.includes(l)) r.add(l); } return r; };
  const groupOf = new Map<string, number>(); for (const p of fm.pads) groupOf.set(p.number, -1);   // MapPadNumbersToNetTieGroups
  groups.forEach((g, i) => { for (const n of g) groupOf.set(n, i); });
  // the copper items: their layers and their outline on a layer (TransformShapeToPolygon)
  interface CuItem { uuid: string; layers: Set<string>; polys: (l: string) => Pt[][] }
  const items: CuItem[] = []; const n = fp.node;
  for (let j = 2; j < n.length; j++) {
    const g = n[j]; if (!Array.isArray(g)) continue; const gk = String(g[0]);
    const m = /^fp_(line|rect|circle|arc|poly|curve)$/.exec(gk);
    if (m) {
      const ls = K.kid(g, "layers"); const lays = cuOf(ls ? ls.slice(1).map(K.str) : [layerOf(g, "F.SilkS")]); if (!lays.size) continue;
      const shapes = fpShapeOutline(g, m[1], fm.tf);
      items.push({ uuid: K.uuidOf(g) || "", layers: lays, polys: () => shapes.flatMap(shapePolys) });
    } else if (gk === "zone" && !K.kid(g, "keepout")) {
      const lays = new Set<string>(); const zl = K.kid(g, "layers") || K.kid(g, "layer"); if (zl) cuOf(zl.slice(1).map(K.str)).forEach((l) => lays.add(l)); if (!lays.size) continue;
      items.push({ uuid: K.uuidOf(g) || "", layers: lays, polys: (l) => K.kids(g, "filled_polygon").filter((f) => layerOf(f, "") === l).map((f) => K.ptsOf(f) as Pt[]).filter((q) => q.length > 2) });
    } else if (gk === "property") {
      const l = layerOf(g, ""); if (!copper.includes(l)) continue; const name = K.str(g[1]);
      items.push({ uuid: K.uuidOf(g) || "", layers: new Set([l]), polys: (L) => geomShapes(fp.geom.filter((q) => (q as { field?: string }).field === name), L).flatMap(shapePolys) });
    }
  }
  const layers = new Set<string>(); for (const it of items) it.layers.forEach((l) => layers.add(l));
  for (const p of fm.pads) cuOf([...p.layers]).forEach((l) => layers.add(l));
  for (const layer of copper.filter((l) => layers.has(l))) {   // CuStack
    const merged = union(items.filter((it) => it.layers.has(layer)).flatMap((it) => it.polys(layer)) as FabPt[][]) as Pt[][];
    const outlines = merged.filter((P, i) => !merged.some((Q, k) => k !== i && pointInPoly(Q, P[0][0], P[0][1]) && !pointInPoly(P, Q[0][0], Q[0][1])));   // the outer contours
    const padsOf = new Map<number, typeof fm.pads>();
    for (const p of fm.pads) {
      if (!cuOf([...p.layers]).has(layer)) continue;
      const prims: Prim[] = []; padPrims(p, layer, cc.m, prims); const pp = prims.flatMap(primPolys);
        outlines.forEach((O, ii) => { if (pp.some((P) => polyPolyDist(P, O) <= 1e-9)) { const l = padsOf.get(ii); if (l) l.push(p); else padsOf.set(ii, [p]); } });
    }
    for (const [ii, pads] of [...padsOf.entries()].sort((a, b) => a[0] - b[0])) {
      if (pads.length < 2) continue;
      const first = pads[0], g0 = groupOf.get(first.number) ?? -1;
      for (let k = 1; k < pads.length; k++) {
        const pad = pads[k], gi = groupOf.get(pad.number) ?? -1;
        if (gi >= 0 && gi === g0) continue;
        const mid: Pt = [(first.x + pad.x) / 2, (first.y + pad.y) / 2]; const O = outlines[ii];
        let pos = O[0], best = Infinity;   // SHAPE_LINE_CHAIN::NearestPoint
        for (let e = 0; e < O.length; e++) { const q = nearestOnSeg(mid, O[e], O[(e + 1) % O.length]); const d = Math.hypot(q[0] - mid[0], q[1] - mid[1]); if (d < best) { best = d; pos = q as Pt; } }
        const shorting = items.find((it) => it.layers.has(layer) && it.polys(layer).some((P) => polyPointDist(P, pos) <= 1e-6));
        const pk = (q: typeof pad) => K.uuidOf(q.node) || "";
        out.push({ pos: [pos[0], pos[1]], kiids: shorting ? [shorting.uuid, pk(first), pk(pad)] : [pk(first), pk(pad)] });
      }
    }
  }
  return out;
}
