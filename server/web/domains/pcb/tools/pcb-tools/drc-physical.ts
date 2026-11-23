// pcb-tools/drc-physical.ts — DRC_TEST_PROVIDER_PHYSICAL_CLEARANCE (pcbnew/drc/drc_test_provider_physical_clearance.cpp):
// physical_clearance / physical_hole_clearance rules between any two physical items whatever their nets (clearance and
// hole_clearance markers), items against zones, and the "Internal clearance violation" of a polygon, curve or arc on
// copper and of a zone's fill.  The implicit "barcode visual separation default" rule (1 mm, A.Type == 'Barcode')
// is one of the rules, so a board with a barcode always runs it.
import type { BoardDoc, Box, CopperShape, DesignSettings, DrcMarker, Pt } from "./types";
import type { DruRule } from "./dru";
import type { RuleItem } from "./dru-eval";
import { DRC_ITEMS } from "../../canvas/drc-items";
import { courtyards, marker, mmPair, ruled, withKiids } from "./drc";
import { holeShape, padHole, viaHole, type Hole } from "./drc-more";
import { geomShapes } from "./drc-silk";
import { fpShapeOutline } from "./drc-footprints";
import { unflashedLayers } from "./drc-flash";
import { SLIVER } from "./drc-sliver";
import { boxGrid, collisionPoint, nearestOnSeg, padShape, segSegDist, shapeBBox, shapeGap, viaLayers } from "./distances";
import { evalRules, itemLayerSet, resolveItem, type ResolveCtx } from "./inspect-resolve";
import { conductors } from "./netlist";
import { padsOf } from "./route-geom";
import { K } from "./state";
import { DRC_EPS } from "./transforms";
import { layerOf, rotator } from "./util";
import { union } from "../../fab/poly";
import type { Pt as FabPt } from "../../fab/prims";
import { pointInPoly } from "./hit";

/** One physical item: its rule item, its layers (GetLayerSet), the layers it is indexed on, and its shape on a layer. */
interface PItem { kiid: string; ids: string[]; ri: RuleItem; layers: string[]; tree: Set<string>; shapes: (l: string) => CopperShape[]; hole: Hole | null; barcode: boolean; box: Box }

const FRONT_TECH = ["F.SilkS", "F.Mask", "F.Paste", "F.Adhes"], BACK_TECH = ["B.SilkS", "B.Mask", "B.Paste", "B.Adhes"];
const solid = (s: CopperShape): CopperShape => (s.t === "poly" ? { t: "poly", pts: s.pts, solid: true } : s);
const title = (code: string) => (DRC_ITEMS.find((i) => i[1] === code) || [code])[0];
const defSev = (code: string) => (DRC_ITEMS.find((i) => i[1] === code) || ["", "", "error"])[2];
const boxOfShapes = (ss: CopperShape[]): Box => {
  let b: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of ss) { const q = shapeBBox(s); b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])]; }
  return b;
};
/** The smallest gap between two shape lists and where SHAPE::Collide puts it. */
function gapOf(A: CopperShape[], B: CopperShape[]): { gap: number; pos: Pt } | null {
  let best: { gap: number; pos: Pt } | null = null;
  for (const a of A) for (const b of B) { const g = shapeGap(a, b); if (!best || g < best.gap) best = { gap: g, pos: collisionPoint(a, b) }; }
  return best;
}

/** The board's physical items (forEachGeometryItem over the provider's item types; invisible fields left out). */
function physicalItems(doc: BoardDoc): PItem[] {
  const out: PItem[] = []; const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const physical = [...copper, ...FRONT_TECH, ...BACK_TECH];
  const conds = conductors(doc).filter((c) => c.kind !== "zone"); const unfl = unflashedLayers(conds, copper);
  const treeOf = (layers: string[], hole: boolean, edge: boolean): Set<string> => {
    const t = new Set(layers);
    if (hole) {   // holes pierce the technical layers of the sides they reach, and every copper layer between
      if (t.has("F.Cu")) { FRONT_TECH.forEach((l) => t.add(l)); t.add("F.CrtYd"); }
      if (t.has("B.Cu")) { BACK_TECH.forEach((l) => t.add(l)); t.add("B.CrtYd"); }
      if (t.has("F.Cu") && t.has("B.Cu")) copper.forEach((l) => t.add(l));
    } else if (edge) { physical.forEach((l) => t.add(l)); t.add("F.CrtYd"); t.add("B.CrtYd"); }
    return t;
  };
  const push = (p: Omit<PItem, "tree" | "box"> & { edge?: boolean }) => {
    const all = new Set<string>([...p.layers, ...(p.hole ? copper : [])]); const ss: CopperShape[] = []; for (const l of all) ss.push(...p.shapes(l));
    if (p.hole) ss.push(holeShape(p.hole));
    if (!ss.length) return;
    out.push({ kiid: p.kiid, ids: p.ids, ri: p.ri, layers: p.layers, tree: treeOf(p.layers, !!p.hole, !!p.edge), shapes: p.shapes, hole: p.hole, barcode: p.barcode, box: boxOfShapes(ss) });
  };
  for (const it of doc.items.values()) {
    const n = it.node;
    if (it.kind === "segment" || it.kind === "arc" || it.kind === "via") {
      const c = conds.find((q) => q.item === it); if (!c) continue; const u = unfl.get(c); const hole = it.kind === "via" ? viaHole(it) : null;
      const layers = it.kind === "via" ? [...viaLayers(n, copper)] : [layerOf(n)];
      push({ kiid: K.uuidOf(n) || it.id, ids: [it.id], ri: resolveItem(doc, it.id) as RuleItem, layers, hole, barcode: false,
        shapes: (l) => (c.layers.has(l) ? [(u && u.get(l)) || c.shape] : hole ? [holeShape(hole)] : []) });
    } else if (it.kind === "footprint") {
      const cy = courtyards(it); const cl = ["F.CrtYd", "B.CrtYd"].filter((l) => cy[l] && cy[l].length);
      if (cl.length) push({ kiid: K.uuidOf(n) || it.id, ids: [it.id], ri: resolveItem(doc, it.id) as RuleItem, layers: cl, hole: null, barcode: false, shapes: (l) => (cy[l] && cy[l].length ? [{ t: "poly", pts: cy[l][0], solid: true }] : []) });
      const pads = padsOf(it);
      pads.forEach((p, i) => {
        const id = it.id + "#" + i; const ri = resolveItem(doc, id); if (!ri) return; const hole = padHole(it, p);
        const layers = [...itemLayerSet(doc, ri)]; const c = conds.find((q) => q.kind === "pad" && q.id === it.id && q.index === i); const u = c && unfl.get(c);
        push({ kiid: K.uuidOf(p.node) || id, ids: [it.id], ri, layers, hole, barcode: false,
          shapes: (l) => { if (layers.includes(l) && !(u && u.get(l)) && (p.type !== "np_thru_hole" || !copper.includes(l))) return [padShape(p)]; return hole ? [holeShape(hole)] : []; } });
      });
      const [fx, fy, frot] = K.atOf(n); const R = rotator(frot); const tf = (x: number, y: number): Pt => { const [dx, dy] = R(x, y); return [fx + dx, fy + dy]; };
      for (let j = 2; j < n.length; j++) {
        const g = n[j]; if (!Array.isArray(g)) continue; const gk = String(g[0]);
        const m = /^fp_(line|rect|circle|arc|poly|curve)$/.exec(gk);
        if (m) {
          const ls = K.kid(g, "layers"); const layers = ls ? ls.slice(1).map(K.str) : [layerOf(g, "F.SilkS")]; const sh = fpShapeOutline(g, m[1], tf).map(solid);
          push({ kiid: K.uuidOf(g) || "", ids: [it.id], ri: { kind: gk, node: g, parent: it, layer: layers[0] } as RuleItem, layers, hole: null, barcode: false, edge: layers.includes("Edge.Cuts"), shapes: () => sh });
        } else if (gk === "property") {
          const hidden = !!K.kid(g, "hide") && K.str((K.kid(g, "hide") || [])[1]) !== "no"; const ef = K.kid(g, "effects");
          if (hidden || (ef && ef.some((x) => x === "hide" || (Array.isArray(x) && x[0] === "hide" && K.str(x[1]) !== "no")))) continue;   // isInvisibleText
          const l = layerOf(g, ""); const name = K.str(g[1]); if (!l) continue;
          const sh = geomShapes(it.geom.filter((q) => (q as { field?: string }).field === name), l).map(solid);
          push({ kiid: K.uuidOf(g) || "", ids: [it.id], ri: resolveItem(doc, it.id + "@field:" + name) as RuleItem, layers: [l], hole: null, barcode: false, shapes: (L) => (L === l ? sh : []) });
        }
      }
    } else if (/^gr_/.test(it.kind) || it.kind === "gr_text" || it.kind === "gr_text_box" || it.kind === "table" || it.kind === "dimension" || it.kind === "barcode") {
      const layers = Array.from(new Set(it.geom.filter((g) => g.layer && !g.hiddenText).map((g) => g.layer)));
      const edge = layers.includes("Edge.Cuts"); const cache = new Map<string, CopperShape[]>();
      const shapes = (l: string) => { const key = edge ? "Edge.Cuts" : l; let v = cache.get(key); if (!v) { v = (edge || layers.includes(l) ? geomShapes(it.geom, key) : []).map(solid); cache.set(key, v); } return v; };
      push({ kiid: K.uuidOf(n) || it.id, ids: [it.id], ri: resolveItem(doc, it.id) as RuleItem, layers, hole: null, barcode: it.kind === "barcode", edge, shapes });
    }
  }
  return out;
}

/** GetArcToSegmentCount: segments for an arc of `angle` degrees at radius r within maxError. */
const arcSegments = (r: number, err: number, deg: number): number => {
  if (r <= err) return 1; const per = 2 * Math.acos(1 - err / r) * 180 / Math.PI; return Math.max(1, Math.ceil(Math.abs(deg) / Math.max(per, 1e-9)));
};

export function physicalClearanceMarkers(doc: BoardDoc, s: DesignSettings, rules: DruRule[]): DrcMarker[] {
  const out: DrcMarker[] = [];
  const userMax = Math.max(0, ...rules.flatMap((r) => r.constraints.filter((c) => c.type === "physical_clearance" || c.type === "physical_hole_clearance").map((c) => c.min || 0)));
  const hasBarcode = [...doc.items.values()].some((it) => it.kind === "barcode");
  // m_DRCMaxPhysicalClearance: the implicit barcode rule only reaches pairs with a barcode in them
  const maxPhys = Math.max(userMax, hasBarcode ? 1 : 0);
  if (maxPhys <= 0) return out;
  const ctx: ResolveCtx = { doc, s, rules, fmt: (v) => String(v) };
  const sevOf = (code: string) => s.severities[code] || defSev(code);
  const items = physicalItems(doc); const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const grid = boxGrid(items, (p) => p.box, 2);
  const checked = new Map<string, Set<string>>(); const done = new Set<string>();
  const report = (code: string, A: PItem, B: PItem | null, layer: string, pos: Pt, text: string, sev: string | null | undefined, extra?: string[]) => {
    if (sevOf(code) === "ignore") return;
    const m = ruled(withKiids(marker(code, sevOf(code), pos[0], pos[1], text, B ? [...A.ids, ...B.ids] : A.ids), [A.kiid, ...(B ? [B.kiid] : []), ...(extra || [])]), sev); m.layer = layer; out.push(m);
  };
  const detail = (code: string, name: string, clr: number, actual: number) => { const [c, a] = mmPair(clr, actual); return `${title(code)} (${name} clearance ${c}; actual ${a})`; };
  const zones = [...doc.items.values()].filter((z) => z.kind === "zone" && !K.kid(z.node, "keepout"));
  // between items
  for (const A of items) {
    for (const layer of A.layers) {   // a footprint's are its courtyards
      const aShapes = A.shapes(layer);
      for (const B of grid.query(A.box, maxPhys)) {
        if (B === A || !B.tree.has(layer)) continue;
        if (!userMax && !A.barcode && !B.barcode) continue;   // only the barcode rule can apply
        const key = A.kiid < B.kiid ? A.kiid + "|" + B.kiid : B.kiid + "|" + A.kiid;
        if (done.has(key)) continue;
        const seen = checked.get(key) || new Set<string>(); if (seen.has(layer)) continue; seen.add(layer); checked.set(key, seen);
        let violations = 0; const bShapes = B.shapes(layer);
        const c = evalRules(ctx, "physical_clearance", A.ri, B.ri, layer, null); const clr = c.min || 0;
        if (c.severity !== "ignore" && clr > 0) {
          const [P, Q, ps, qs] = A.kiid > B.kiid ? [B, A, bShapes, aShapes] : [A, B, aShapes, bShapes];   // a well-defined order
          const g = gapOf(ps, qs);
          if (g && g.gap < clr) { report("clearance", P, Q, layer, g.pos, detail("clearance", c.name, clr, g.gap), c.severity); violations++; }
        }
        const aHole = A.hole ? holeShape(A.hole) : null, bHole = B.hole ? holeShape(B.hole) : null;
        if (aHole || bHole) {
          const h = evalRules(ctx, "physical_hole_clearance", B.ri, A.ri, layer, null); const hc = h.min || 0;
          if (h.severity !== "ignore" && hc > 0) {
            const g1 = aHole ? gapOf([aHole], bShapes) : null;
            if (g1 && g1.gap < hc) { report("hole_clearance", A, B, layer, g1.pos, detail("hole_clearance", h.name, hc, g1.gap), h.severity); violations++; }
            const g2 = bHole ? gapOf([bHole], aShapes) : null;
            if (g2 && g2.gap < hc) { report("hole_clearance", A, B, layer, g2.pos, detail("hole_clearance", h.name, hc, g2.gap), h.severity); violations++; }
          }
        }
        if (violations) done.add(key);
      }
      // testItemAgainstZones
      for (const z of zones) {
        const zl = new Set<string>(); const zls = K.kid(z.node, "layers") || K.kid(z.node, "layer"); if (zls) zls.slice(1).map(K.str).forEach((l) => zl.add(l));
        if (!zl.has(layer)) continue;
        const zb = z.bbox; if (zb && (A.box[2] + maxPhys < zb[0] || zb[2] + maxPhys < A.box[0] || A.box[3] + maxPhys < zb[1] || zb[3] + maxPhys < A.box[1])) continue;
        const ZR = resolveItem(doc, z.id) as RuleItem;
        const zShapes: CopperShape[] = copper.includes(layer)
          ? K.kids(z.node, "filled_polygon").filter((f) => layerOf(f, "") === layer).map((f) => ({ t: "poly", pts: K.ptsOf(f) as Pt[], solid: true }) as CopperShape)
          : [{ t: "poly", pts: K.ptsOf(K.kid(z.node, "polygon") || []) as Pt[], solid: true }];
        const zk = { kiid: K.uuidOf(z.node) || z.id, ids: [z.id] } as PItem;
        const c = evalRules(ctx, "physical_clearance", A.ri, ZR, layer, null); const clr = c.min || 0;
        if (c.severity !== "ignore" && clr > 0 && (userMax || A.barcode)) {
          const g = gapOf(aShapes, zShapes);
          if (g && g.gap < clr) report("clearance", A, zk, layer, g.pos, detail("clearance", c.name, clr, g.gap), c.severity);
        }
        if (A.hole && (A.ri.kind !== "via" || A.layers.includes(layer))) {
          const h = evalRules(ctx, "physical_hole_clearance", A.ri, ZR, layer, null); const hc = h.min || 0;
          if (h.severity !== "ignore" && hc > 0) { const g = gapOf([holeShape(A.hole)], zShapes); if (g && g.gap < hc) report("hole_clearance", A, zk, layer, g.pos, detail("hole_clearance", h.name, hc, g.gap), h.severity); }
        }
      }
    }
  }
  if (!userMax) return out;
  // within polygonal items: an outline closing in on itself (testShapeLineChain) and a zone fill's islands and holes (testZoneLayer)
  const angleTol = (180 - SLIVER.angleTolerance) * Math.PI / 180;
  const angleDiff = (a: number, b: number) => { if (a > b) [a, b] = [b, a]; const d = b - a; return d > Math.PI ? 2 * Math.PI - d : d; };
  const testChain = (pts: Pt[], closed: boolean, width: number, layer: string, item: PItem, c: { min: number | null; name: string; severity?: string | null }, fpOffset: ((p: Pt) => Pt) | null) => {
    const clr = c.min || 0; if (c.severity === "ignore" || clr - DRC_EPS <= 0) return;
    const segs: [Pt, Pt][] = []; for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]); if (closed && pts.length > 2) segs.push([pts[pts.length - 1], pts[0]]);
    const count = segs.length; const angles: number[] = [];
    const ang = (s: [Pt, Pt]) => Math.atan2(s[1][1] - s[0][1], s[1][0] - s[0][0]);
    const long = (s: [Pt, Pt]) => Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]) > DRC_EPS * 2;
    for (let i = 0; i < count; i++) {
      if (long(segs[i])) angles.push(ang(segs[i]));
      else if (i > 0) angles.push(angles[angles.length - 1]);
      else { for (let j = 1; j < count; j++) if (long(segs[j]) || j === count - 1) { angles.push(ang(segs[j])); break; } if (!angles.length) angles.push(0); }
    }
    const hits: [Pt, number][] = [];
    for (let i = 0; i < count; i++) {
      const seg = segs[i], a0 = angles[i]; let first = i + 1, last = count - 1;
      while (first < count && angleDiff(a0, angles[first]) < angleTol) first++;
      if (closed) {
        if (i > 0) last = i - 1;
        while (last !== Math.min(first, count - 1)) { if (angleDiff(a0, angles[last]) < angleTol) last = last === 0 ? count - 1 : last - 1; else break; }
      }
      if (last < i) last = count - 1;
      for (let j = first; j <= last; j++) {
        const cand = segs[j]; const actual = segSegDist(seg[0], seg[1], cand[0], cand[1]);
        if (actual < clr + width - DRC_EPS) {
          const p1 = nearestOnSegToSeg(seg, cand), p2 = nearestOnSegToSeg(cand, seg); const pos: Pt = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
          if (hits.length && Math.hypot(pos[0] - hits[hits.length - 1][0][0], pos[1] - hits[hits.length - 1][0][1]) < clr * 2) { if (actual < hits[hits.length - 1][1]) hits[hits.length - 1] = [pos, actual]; continue; }
          hits.push([pos, actual]);
        }
      }
    }
    for (const [p, actual] of hits) {
      const pt = fpOffset ? fpOffset(p) : p; const [cs, as] = mmPair(clr, actual);
      report("clearance", item, null, layer, pt, `Internal clearance violation (${c.name} clearance ${cs}; actual ${as})`, c.severity);
    }
  };
  for (const it of items) {
    const kind = it.ri.kind; const m = /^(?:gr|fp)_(poly|curve|arc)$/.exec(kind); if (!m) continue;
    const n = it.ri.node; const st = K.kid(n, "stroke"), wn = st ? K.kid(st, "width") : K.kid(n, "width"); const w = wn ? K.num(wn[1], 0) : 0;
    const fp = it.ri.parent || null; let off: ((p: Pt) => Pt) | null = null; let tf = (x: number, y: number): Pt => [x, y];
    if (fp) {
      const [fx, fy, frot] = K.atOf(fp.node); const R = rotator(frot); tf = (x, y) => { const [dx, dy] = R(x, y); return [fx + dx, fy + dy]; };
      off = (p) => { const [dx, dy] = R(p[0], p[1]); return [fx + dx, fy + dy]; };   // the marker point is turned and moved by the parent footprint again
    }
    for (const layer of it.layers.filter((l) => copper.includes(l))) {
      const c = evalRules(ctx, "physical_clearance", it.ri, null, layer, null);
      if (m[1] === "poly") { const pts = (K.ptsOf(n) as Pt[]).map((q) => tf(q[0], q[1])); if (pts.length) testChain(pts, true, w, layer, it, c, off); }
      else if (m[1] === "curve") { const pts = K.bezierPts(K.ptsOf(n)).map((q: number[]) => tf(q[0], q[1])); testChain(pts, false, w, layer, it, c, off); }
      else {
        const a = K.kid(n, "start"), mid = K.kid(n, "mid"), b = K.kid(n, "end"); if (!a || !mid || !b) continue;
        const A0 = tf(K.num(a[1]), K.num(a[2])), M0 = tf(K.num(mid[1]), K.num(mid[2])), B0 = tf(K.num(b[1]), K.num(b[2])); const arc = K.arcFrom3(A0, M0, B0); if (!arc) continue;
        let sweep = arc.anticlockwise ? arc.a0 - arc.a1 : arc.a1 - arc.a0; sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); const dir = arc.anticlockwise ? -1 : 1;
        const steps = arcSegments(arc.r, 0.005, sweep * 180 / Math.PI); const pts: Pt[] = [A0];
        for (let k = 1; k <= steps; k++) { const t = arc.a0 + dir * sweep * k / steps; pts.push([arc.x + arc.r * Math.cos(t), arc.y + arc.r * Math.sin(t)]); }
        testChain(pts, false, w, layer, it, c, off);
      }
    }
  }
  for (const z of zones) {
    const zk = { kiid: K.uuidOf(z.node) || z.id, ids: [z.id], ri: resolveItem(doc, z.id) as RuleItem } as PItem;
    for (const layer of copper) {
      const fills = K.kids(z.node, "filled_polygon").filter((f) => layerOf(f, "") === layer).map((f) => K.ptsOf(f) as Pt[]).filter((q) => q.length > 2); if (!fills.length) continue;
      const c = evalRules(ctx, "physical_clearance", zk.ri, null, layer, null); const clr = c.min || 0; if (c.severity === "ignore" || clr - DRC_EPS <= 0) continue;
      const polys = union(fills as FabPt[][]) as Pt[][]; const depth = (P: Pt[]) => polys.filter((Q) => Q !== P && pointInPoly(Q, P[0][0], P[0][1])).length;
      const outers = polys.filter((P) => depth(P) % 2 === 0), holes = polys.filter((P) => depth(P) % 2 === 1);
      outers.forEach((O, oi) => {
        for (let k = oi + 1; k < outers.length; k++) {
          const S = outers[k];
          for (let j = 0; j < S.length; j++) {
            const a = S[j], b = S[(j + 1) % S.length]; let best = Infinity, pos: Pt = a;
            for (let e = 0; e < O.length; e++) { const d = segSegDist(O[e], O[(e + 1) % O.length], a, b); if (d < best) { best = d; pos = nearestOnSegToSeg([O[e], O[(e + 1) % O.length]], [a, b]); } }
            if (best < clr - DRC_EPS) report("clearance", zk, null, layer, pos, detail("clearance", c.name, clr, best), c.severity);
          }
        }
        for (const H of holes) if (pointInPoly(O, H[0][0], H[0][1])) testChain(H, true, 0, layer, zk, c, null);
      });
    }
  }
  return out;
}
/** SEG::NearestPoint( SEG ): the point of `s` nearest the other segment (their crossing when they cross). */
function nearestOnSegToSeg(s: [Pt, Pt], o: [Pt, Pt]): Pt {
  const cands: [Pt, Pt][] = [[s[0], nearestOnSeg(s[0], o[0], o[1])], [s[1], nearestOnSeg(s[1], o[0], o[1])], [nearestOnSeg(o[0], s[0], s[1]), o[0]], [nearestOnSeg(o[1], s[0], s[1]), o[1]]];
  let best = cands[0], bd = Infinity; for (const c of cands) { const d = Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]); if (d < bd) { bd = d; best = c; } }
  if (segSegDist(s[0], s[1], o[0], o[1]) === 0) {   // they cross
    const d1 = [s[1][0] - s[0][0], s[1][1] - s[0][1]], d2 = [o[1][0] - o[0][0], o[1][1] - o[0][1]]; const den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) > 1e-12) { const t = ((o[0][0] - s[0][0]) * d2[1] - (o[0][1] - s[0][1]) * d2[0]) / den; return [s[0][0] + t * d1[0], s[0][1] + t * d1[1]]; }
  }
  return best[0];
}
