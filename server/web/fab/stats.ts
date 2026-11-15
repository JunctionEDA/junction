// web/fab/stats — the area figures of Inspect > Board Statistics (ComputeBoardStatistics in
// pcbnew/board_statistics_report.cpp): the board area (outlines, less their cut-outs and the drilled holes when
// "Subtract holes from board area" is set), the front and back copper areas (everything plotted on F.Cu / B.Cu,
// merged, less the holes when "Subtract holes from copper areas" is set) and the front and back footprint areas (the
// courtyards merged, with each through-hole pad's copper and each NPTH hole, which take room on both sides).
import { boardHoles, boardShape } from "../viewer3d/outline";
import { type BoardModel } from "./model";
import { PlotLog, plotLayer, type PlotOptions } from "./plot";
import { primPolys, subtract, union } from "./poly";
import { type Pt, area } from "./prims";

export interface StatAreas { hasOutline: boolean; boardArea: number; frontCopper: number; backCopper: number; frontCourtyard: number; backCourtyard: number }
// signed: a merged set's holes run the other way round from its outlines
const total = (polys: Pt[][]): number => Math.abs(polys.reduce((s, p) => s + area(p), 0));

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const kidOf = (n: SNode, k: string): SNode | null => (n.find((c) => Array.isArray(c) && c[0] === k) as SNode | undefined) || null;
/** The pad holes' and via drills' area: SEG length × width plus a round end pair for a slot, π d² / 4 for a round hole. */
export function drilledArea(doc: KDoc): number {
  let a = 0;
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") {
      for (const p of it.node) {
        if (!Array.isArray(p) || p[0] !== "pad") continue;
        const dr = kidOf(p as SNode, "drill"); if (!dr) continue;
        const nums = dr.slice(1).filter((v) => !Array.isArray(v) && isFinite(num(v)) && v !== "oval").map(num);
        const x = nums[0] || 0, y = dr.includes("oval") && nums.length > 1 ? nums[1] : x;
        if (!(x > 0) || !(y > 0)) continue;
        const w = Math.min(x, y), len = Math.abs(x - y);
        a += len * w + Math.PI * 0.25 * w * w;
      }
    } else if (it.kind === "via") {
      const dr = kidOf(it.node, "drill"); const d = dr ? num(dr[1]) : 0;
      if (d > 0) a += Math.PI * 0.25 * d * d;
    }
  }
  return a;
}

export function statAreas(m: BoardModel, o: { subtractHolesFromBoard: boolean; subtractHolesFromCopper: boolean; courtyards?: (fp: KItem) => Record<string, Pt[][]> }): StatAreas {
  const doc = m.doc as unknown as KDoc;
  const shape = boardShape(doc), holes = boardHoles(doc);
  const hasOutline = !shape.fallback && shape.outlines.length > 0;
  let boardArea = 0;
  if (hasOutline) {
    for (const ol of shape.outlines) {
      boardArea += Math.abs(area(ol.contour));
      if (o.subtractHolesFromBoard) for (const c of ol.cutouts) boardArea -= Math.abs(area(c));
    }
    // a pad's hole (a slot: its length by its width, and the round ends) and a via's drill, as KiCad reckons them
    if (o.subtractHolesFromBoard) boardArea -= drilledArea(doc);
  }
  const opt: PlotOptions = { plotReference: true, plotValue: true, subtractMaskFromSilk: false };
  const log = new PlotLog();
  const layerPolys = (layer: string): Pt[][] => {
    let have: Pt[][] = [], add: Pt[][] = [];
    const flush = (): void => { if (add.length) { have = union(have.concat(add)); add = []; } };
    for (const p of plotLayer(m, layer, opt, log)) {
      const polys = primPolys(p); if (!polys.length) continue;
      if (p.clear) { flush(); have = subtract(have, union(polys)); } else add.push(...polys);
    }
    flush(); return have;
  };
  const holePolys = holes.map((h) => h.pts);
  let front = layerPolys("F.Cu"), back = layerPolys("B.Cu");
  if (o.subtractHolesFromCopper) { front = subtract(front, holePolys); back = subtract(back, holePolys); }
  // courtyards, and the through-hole pads' copper and the NPTH holes on both sides
  const fc: Pt[][] = [], bc: Pt[][] = [];
  if (o.courtyards) for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue;
    const c = o.courtyards(it);
    for (const l of c["F.CrtYd"] || []) if (l.length > 2) fc.push(l);
    for (const l of c["B.CrtYd"] || []) if (l.length > 2) bc.push(l);
  }
  for (const h of holes) if (!h.via) { fc.push(h.pts); bc.push(h.pts); }
  return { hasOutline, boardArea, frontCopper: total(front), backCopper: total(back), frontCourtyard: total(union(fc)), backCourtyard: total(union(bc)) };
}
