// web/domains/pcb/fab/hyperlynx — File > Export > Hyperlynx... (HYPERLYNX_EXPORTER, pcbnew/exporters/export_hyperlynx.cpp):
// the .hyp file — {VERSION=2.14} {UNITS=ENGLISH LENGTH}, the BOARD perimeter, the STACKUP (copper, dielectrics and
// solder masks, from the board's (stackup …) or BuildDefaultStackupList), the DEVICES, one PADSTACK per distinct pad
// or via geometry, then each net by name with its PINs, VIAs, SEGs, ARCs and zone fill POLYGONs / POLYVOIDs, and the
// unconnected copper as EmptyNet0, EmptyNet1 … .  Lengths are inches (iu2hyp), y up.
import { arcFrom3, atOf, isList, kid, kids, num, polyPtsOf, str } from "../canvas/sexpr";
import { type BoardModel, type FabDoc, type Node, type Pad, type PadShape, expandLayers, padShapeOn } from "./model";
import { union } from "./poly";
import { type Pt, area } from "./prims";
import { boardShape } from "../viewer3d/outline";

const K = (n: Node | null, key: string): Node | null => (n ? (kid(n, key) as Node | null) : null);
/** mm on pcbnew's nanometre grid, as the integer internal units the exporter reads */
const iu = (mm: number): number => Math.round(mm * 1e6);
/** iu2hyp: internal units to inches */
const hyp = (u: number): number => u / 1e9 / 0.0254;
const f = (v: number, d: number): string => v.toFixed(d);
/** printf's %g (six significant digits, trailing zeros dropped, an exponent of two digits at least) */
export function fmtG(v: number): string {
  if (v === 0 || !isFinite(v)) return v === 0 ? "0" : String(v);
  const e = Math.floor(Math.log10(Math.abs(+v.toPrecision(6))));
  const strip = (s: string): string => (s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (e < -4 || e >= 6) {
    const [m, x] = v.toExponential(5).split("e");
    const n = Number(x);
    return strip(m) + "e" + (n < 0 ? "-" : "+") + String(Math.abs(n)).padStart(2, "0");
  }
  return strip(v.toFixed(Math.max(0, 5 - e)));
}
/** %.Ns: at most N characters */
const cut = (s: string, n: number): string => Array.from(s).slice(0, n).join("");

/** PCB_LAYER_ID order (LSET::Seq): F.Cu, B.Cu, In1.Cu, In2.Cu … */
const layerRank = (l: string): number => (l === "F.Cu" ? 0 : l === "B.Cu" ? 2 : /^In(\d+)\.Cu$/.test(l) ? 2 + 2 * Number(/^In(\d+)\.Cu$/.exec(l)![1]) : 1000);
const bySeq = (a: string, b: string): number => layerRank(a) - layerRank(b) || (a < b ? -1 : a > b ? 1 : 0);

interface HypShape { shape: string; sx: number; sy: number }
interface PadStack { id: number; drill: number; angle: number; layers: string[]; through: boolean; shapes: Map<string, HypShape> }
const sameStack = (a: PadStack, b: PadStack): boolean => {
  if (a.through !== b.through) return false;
  if (a.through && b.through && a.drill !== b.drill) return false;
  if (a.shapes.size !== b.shapes.size) return false;
  for (const [l, s] of a.shapes) { const t = b.shapes.get(l); if (!t || t.shape !== s.shape || t.sx !== s.sx || t.sy !== s.sy) return false; }
  if (a.layers.length !== b.layers.length || a.layers.some((l, i) => l !== b.layers[i])) return false;
  return a.angle === b.angle;
};

export interface HyperlynxOptions {
  /** BOARD::GetFileName, written in the BOARD record */
  fileName: string;
  /** BOARD::GetLayerName */
  layerName(layer: string): string;
}
export interface HyperlynxResult { text: string; warnings: string[]; errors: string[] }

/** The board's physical stackup items in order, as BOARD_STACKUP holds them (the file's, else the default one). */
interface StackItem { type: "copper" | "dielectric" | "soldermask" | "other"; layer: string; subs: { thickness: number; epsilonR: number; material: string }[] }
function stackupItems(doc: FabDoc, setup: Node | null, copper: string[]): StackItem[] {
  const st = K(setup, "stackup");
  if (st) {
    const out: StackItem[] = [];
    for (const l of kids(st, "layer") as Node[]) {
      const name = str(l[1]);
      const groups: Node[] = [["layer", name] as Node];
      for (let j = 2; j < l.length; j++) { const c = l[j]; if (c === "addsublayer") groups.push(["layer", name] as Node); else if (isList(c)) (groups[groups.length - 1] as Node).push(c); }
      const type = str((K(groups[0], "type") || [])[1]);
      const kind: StackItem["type"] = type === "copper" ? "copper" : /^dielectric \d+$/.test(name) ? "dielectric" : /Solder Mask$/i.test(type) || /\.Mask$/.test(name) ? "soldermask" : "other";
      const subs = groups.map((g, gi) => {
        const th = K(g, "thickness"), er = K(g, "epsilon_r"), mat = K(g, "material");
        // the item's own defaults for its first sub-layer (BOARD_STACKUP_ITEM's constructor), DIELECTRIC_PRMS' for the rest
        const dTh = gi ? 0 : kind === "copper" ? 0.035 : kind === "soldermask" ? 0.01 : 0;
        const dEr = gi ? 1 : kind === "dielectric" ? 4.5 : kind === "soldermask" ? 3.3 : 1;
        const dMat = gi ? "" : kind === "dielectric" ? "FR4" : "Not specified";
        return { thickness: th ? num(th[1], 0) : dTh, epsilonR: er ? num(er[1], dEr) : dEr, material: mat ? str(mat[1]) : dMat };
      });
      out.push({ type: kind, layer: name, subs });
    }
    return out;
  }
  // BuildDefaultStackupList
  const masks = ["F.Mask", "B.Mask"].filter((l) => doc.layers.has(l));
  const thick = iu(doc.thickness || 1.6);
  const diel = Math.trunc((thick - iu(0.035) * copper.length - iu(0.01) * masks.length) / Math.max(1, copper.length - 1)) / 1e6;
  const out: StackItem[] = [];
  if (masks.includes("F.Mask")) out.push({ type: "soldermask", layer: "F.Mask", subs: [{ thickness: 0.01, epsilonR: 3.3, material: "Not specified" }] });
  copper.forEach((l, i) => {
    out.push({ type: "copper", layer: l, subs: [{ thickness: 0.035, epsilonR: 1, material: "" }] });
    if (i < copper.length - 1) out.push({ type: "dielectric", layer: "", subs: [{ thickness: diel, epsilonR: 4.5, material: "FR4" }] });
  });
  if (masks.includes("B.Mask")) out.push({ type: "soldermask", layer: "B.Mask", subs: [{ thickness: 0.01, epsilonR: 3.3, material: "Not specified" }] });
  return out;
}

/** Outlines and their holes from a flat union (SHAPE_POLY_SET::Simplify): each hole goes to the smallest outline around it. */
function outlinesWithHoles(paths: Pt[][]): { outline: Pt[]; holes: Pt[][] }[] {
  if (!paths.length) return [];
  const areas = paths.map(area);
  let big = 0; areas.forEach((a, i) => { if (Math.abs(a) > Math.abs(areas[big])) big = i; });
  const sign = Math.sign(areas[big]) || 1;
  const outs = paths.map((p, i) => ({ p, a: areas[i] })).filter((x) => Math.sign(x.a) === sign).map((x) => ({ outline: x.p, holes: [] as Pt[][], a: Math.abs(x.a) }));
  const inside = (pts: Pt[], x: number, y: number): boolean => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  paths.forEach((p, i) => {
    if (Math.sign(areas[i]) === sign) return;
    const owner = outs.filter((o) => inside(o.outline, p[0][0], p[0][1])).sort((a, b) => a.a - b.a)[0];
    if (owner) owner.holes.push(p);
  });
  return outs.map((o) => ({ outline: o.outline, holes: o.holes }));
}

/** HYPERLYNX_EXPORTER::Run */
export function writeHyperlynx(m: BoardModel, setup: Node | null, o: HyperlynxOptions): HyperlynxResult {
  const doc = m.doc, out: string[] = [], warnings: string[] = [], errors: string[] = [];
  const pr = (indent: number, s: string): void => { out.push("  ".repeat(indent) + s); };
  const copper = m.copper.slice();
  const allCu = new Set(copper);
  const L = (l: string): string => o.layerName(l);

  // generateHeaders
  pr(0, "{VERSION=2.14}\n"); pr(0, "{UNITS=ENGLISH LENGTH}\n\n");

  // writeBoardInfo
  pr(0, `{BOARD "${o.fileName}"\n`);
  const shape = boardShape(doc);
  let boardOk = true;
  if (shape.fallback && [...doc.items.values()].some((it) => (it.geom || []).some((g) => (g as { layer?: string }).layer === "Edge.Cuts"))) {
    // GetBoardPolygonOutlines failed: the outline's drawings do not close
    errors.push("Board outline is malformed. Run DRC for a full analysis.");
    boardOk = false;
  }
  if (boardOk) {
    for (const ol of shape.outlines) {
      const c = ol.contour;
      for (let i = 0; i < c.length; i++) {
        const a = c[i], b = c[(i + 1) % c.length];
        pr(1, `(PERIMETER_SEGMENT X1=${f(hyp(iu(a[0])), 9)} Y1=${f(hyp(-iu(a[1])), 9)} X2=${f(hyp(iu(b[0])), 9)} Y2=${f(hyp(-iu(b[1])), 9)})\n`);
      }
    }
    pr(0, "}\n\n");
  }

  // writeStackupInfo
  pr(0, "{STACKUP\n");
  let layerName = "";
  for (const it of stackupItems(doc, setup, copper)) {
    if (it.type === "copper") {
      layerName = L(it.layer);
      pr(1, `(SIGNAL T=${fmtG(hyp(iu(it.subs[0].thickness)))} P=${fmtG(hyp(0))} C=${fmtG(1.724e-8)} L="${cut(layerName, 20)}" M=COPPER)\n`);
    } else if (it.type === "dielectric") {
      if (it.subs.length < 2) pr(1, `(DIELECTRIC T=${fmtG(hyp(iu(it.subs[0].thickness)))} C=${fmtG(it.subs[0].epsilonR)} L="DE_${cut(layerName, 17)}" M="${cut(it.subs[0].material, 20)}")\n`);
      else it.subs.forEach((s, idx) => pr(1, `(DIELECTRIC T=${fmtG(hyp(iu(s.thickness)))} C=${fmtG(s.epsilonR)} L="DE${idx}_${cut(layerName, 16)}" M="${cut(s.material, 20)}")\n`));
    } else if (it.type === "soldermask") {
      let material = it.subs[0].material;
      if (!material || material === "Not specified" || material === "undefined") material = "Solder Mask";   // IsPrmSpecified
      pr(1, `(DIELECTRIC T=${fmtG(hyp(iu(it.subs[0].thickness)))} C=${fmtG(it.subs[0].epsilonR)} L="${cut(L(it.layer), 20)}" M="${cut(material, 20)}")\n`);
    }
  }
  pr(0, "}\n\n");

  // writeDevices
  pr(0, "{DEVICES\n");
  for (const fp of m.footprints) pr(1, `(? REF="${fp.ref || "EMPTY"}" L="${L(fp.side)}")\n`);
  pr(0, "}\n\n");

  // writePadStacks
  const stacks: PadStack[] = [];
  const add = (s: PadStack): PadStack => { for (const p of stacks) if (sameStack(p, s)) return p; s.id = stacks.length; stacks.push(s); return s; };
  const padMap = new Map<Pad, PadStack>();
  for (const fp of m.footprints) for (const pad of fp.pads) {
    let angle = 180 - pad.rot; if (angle < 0) angle += 360;
    const layers = [...pad.layers].sort(bySeq);
    const shapes = new Map<string, HypShape>();
    for (const l of layers.filter((x) => allCu.has(x))) { const s: PadShape = padShapeOn(pad, l, copper); shapes.set(l, { shape: s.shape, sx: iu(s.w), sy: iu(s.h) }); }
    padMap.set(pad, add({ id: 0, drill: pad.drill ? iu(pad.drill.w) : 0, angle, layers, through: true, shapes }));
  }
  const viaMap = new Map<string, PadStack>();
  for (const v of m.vias) {
    const layers = v.layers.slice().sort(bySeq);
    const shapes = new Map<string, HypShape>();
    for (const l of layers.filter((x) => allCu.has(x))) { const w = iu(v.sizes ? v.sizes.get(l) ?? v.size : v.size); shapes.set(l, { shape: "circle", sx: w, sy: w }); }
    if (v.id) viaMap.set(v.id, add({ id: 0, drill: iu(v.drill), angle: 0, layers, through: true, shapes }));
  }
    let unsupported = false;
  const formatPadShape = (s: HypShape, angle: number): string => {
    let id = 0;
    if (s.shape === "circle" || s.shape === "oval") id = 0;
    else if (s.shape === "roundrect") id = 2;
    else if (s.shape === "rect") id = 1;
    else { unsupported = true; id = 0; }
    return `${id}, ${f(hyp(s.sx), 9)}, ${f(hyp(s.sy), 9)}, ${f(angle, 1)}, M`;
  };
  for (const st of stacks) {
    const outLayers = st.layers.filter((l) => allCu.has(l));
    if (!outLayers.length) continue;
    const first = st.shapes.get(outLayers[0])!;
    const uniform = [...st.shapes.values()].every((s) => s.shape === first.shape && s.sx === first.sx && s.sy === first.sy);
    pr(0, st.drill > 0 ? `{PADSTACK=${st.id}, ${f(hyp(st.drill), 9)}\n` : `{PADSTACK=${st.id}\n`);
    if (outLayers.length === copper.length && uniform) pr(1, `("MDEF", ${formatPadShape(first, st.angle)})\n`);
    else for (const l of outLayers) pr(1, `("${L(l)}", ${formatPadShape(st.shapes.get(l)!, st.angle)})\n`);
    pr(0, "}\n\n");
  }
  if (unsupported) warnings.push("File contains pad shapes that are not supported by the Hyperlynx exporter (supported shapes are oval, rectangle, rounded rectangle, and circle).", "They have been exported as oval pads.");

  // writeNets: the board's nets by name, each with its pads, tracks (in the board's order) and zones
  type Obj = { kind: "pad"; pad: Pad } | { kind: "via" | "track" | "arc"; node: Node; id: string } | { kind: "zone"; node: Node };
  const netOf = (n: Node): string => { const nn = K(n, "net"); if (!nn) return ""; return typeof nn[1] === "number" ? (nn.length > 2 ? str(nn[2]) : str(doc.nets.get(nn[1] as number) || "")) : str(nn[1]); };
  const objects: { net: string; obj: Obj }[] = [];
  for (const fp of m.footprints) for (const pad of fp.pads) if ([...pad.layers].some((l) => /\.Cu$/.test(l))) objects.push({ net: pad.net, obj: { kind: "pad", pad } });
  for (const it of doc.items.values()) {
    if (it.kind !== "segment" && it.kind !== "arc" && it.kind !== "via") continue;
    const n = it.node;
    const ls = K(n, "layers"), l1 = K(n, "layer");
    const layers = it.kind === "via" ? ["F.Cu"] : (ls ? ls.slice(1).map(str) : [l1 ? str(l1[1]) : "F.Cu"]);
    if (!layers.some((l) => /\.Cu$/.test(l))) continue;
    objects.push({ net: netOf(n), obj: { kind: it.kind === "segment" ? "track" : it.kind === "arc" ? "arc" : "via", node: n, id: it.id } });
  }
  for (const it of doc.items.values()) {
    if (it.kind !== "zone") continue;
    const n = it.node; const single = K(n, "layer"), multi = K(n, "layers");
    const layers = expandLayers(single ? [str(single[1])] : multi ? multi.slice(1).map(str) : [], copper);
    if (!layers.some((l) => /\.Cu$/.test(l))) continue;
    objects.push({ net: K(n, "keepout") ? "" : netOf(n), obj: { kind: "zone", node: n } });
  }
  let polyId = 1;
  const writeObjects = (objs: Obj[]): void => {
    for (const ob of objs) {
      if (ob.kind === "pad") {
        const ps = padMap.get(ob.pad); if (!ps) continue;
        pr(1, `(PIN X=${f(hyp(iu(ob.pad.x)), 10)} Y=${f(hyp(-iu(ob.pad.y)), 10)} R="${ob.pad.fp.ref || "EMPTY"}.${ob.pad.number || "1"}" P=${ps.id})\n`);
      } else if (ob.kind === "via") {
        const ps = viaMap.get(ob.id); if (!ps) continue;
        const [x, y] = atOf(ob.node) as [number, number, number];
        pr(1, `(VIA X=${f(hyp(iu(x)), 10)} Y=${f(hyp(-iu(y)), 10)} P=${ps.id})\n`);
      } else if (ob.kind === "track") {
        const s = K(ob.node, "start"), e = K(ob.node, "end"), w = K(ob.node, "width"), l = K(ob.node, "layer");
        if (!s || !e) continue;
        pr(1, `(SEG X1=${f(hyp(iu(num(s[1]))), 10)} Y1=${f(hyp(-iu(num(s[2]))), 10)} X2=${f(hyp(iu(num(e[1]))), 10)} Y2=${f(hyp(-iu(num(e[2]))), 10)} W=${f(hyp(iu(w ? num(w[1], 0) : 0)), 10)} L="${L(l ? str(l[1]) : "F.Cu")}")\n`);
      } else if (ob.kind === "arc") {
        const s = K(ob.node, "start"), md = K(ob.node, "mid"), e = K(ob.node, "end"), w = K(ob.node, "width"), l = K(ob.node, "layer");
        if (!s || !md || !e) continue;
        let a: Pt = [iu(num(s[1])), iu(num(s[2]))], b: Pt = [iu(num(e[1])), iu(num(e[2]))];
        const mid: Pt = [iu(num(md[1])), iu(num(md[2]))];
        const c = arcFrom3([num(s[1]), num(s[2])], [num(md[1]), num(md[2])], [num(e[1]), num(e[2])]) as { x: number; y: number; r: number } | null;
        if (!c) continue;
        // PCB_ARC::IsCCW: the arc's angle from start through mid to end is negative (y down)
        const cross = (mid[0] - a[0]) * (b[1] - mid[1]) - (mid[1] - a[1]) * (b[0] - mid[0]);
        if (!(cross < 0)) { const t = a; a = b; b = t; }
        pr(1, `(ARC X1=${f(hyp(a[0]), 10)} Y1=${f(hyp(-a[1]), 10)} X2=${f(hyp(b[0]), 10)} Y2=${f(hyp(-b[1]), 10)} XC=${f(hyp(iu(c.x)), 10)} YC=${f(hyp(-iu(c.y)), 10)} R=${f(hyp(iu(c.r)), 10)} W=${f(hyp(iu(w ? num(w[1], 0) : 0)), 10)} L="${L(l ? str(l[1]) : "F.Cu")}")\n`);
      } else {
        const n = ob.node; const single = K(n, "layer"), multi = K(n, "layers");
        const layers = expandLayers(single ? [str(single[1])] : multi ? multi.slice(1).map(str) : [], copper).sort(bySeq);
        for (const layer of layers) {
          const polys = (kids(n, "filled_polygon") as Node[]).filter((fp) => { const fl = K(fp, "layer"); return (fl ? str(fl[1]) : layers[0]) === layer; }).map((fp) => polyPtsOf(fp) as Pt[]).filter((p) => p.length >= 3);
          if (!polys.length) continue;
          for (const { outline, holes } of outlinesWithHoles(union(polys))) {
            const p0 = outline[0];
            pr(1, `{POLYGON T=POUR L="${L(layer)}" ID=${polyId} X=${f(hyp(iu(p0[0])), 10)} Y=${f(hyp(-iu(p0[1])), 10)}\n`);
            for (const p of outline) pr(2, `(LINE X=${f(hyp(iu(p[0])), 10)} Y=${f(hyp(-iu(p[1])), 10)})\n`);
            pr(2, `(LINE X=${f(hyp(iu(p0[0])), 10)} Y=${f(hyp(-iu(p0[1])), 10)})\n`);
            pr(1, "}\n");
            for (const hole of holes) {
              const h0 = hole[0];
              pr(1, `{POLYVOID ID=${polyId} X=${f(hyp(iu(h0[0])), 10)} Y=${f(hyp(-iu(h0[1])), 10)}\n`);
              for (const p of hole) pr(2, `(LINE X=${f(hyp(iu(p[0])), 10)} Y=${f(hyp(-iu(p[1])), 10)})\n`);
              pr(2, `(LINE X=${f(hyp(iu(h0[0])), 10)} Y=${f(hyp(-iu(h0[1])), 10)})\n`);
              pr(1, "}\n");
            }
            polyId++;
          }
        }
      }
    }
  };
  // NETINFO_LIST iterates by name (std::map<wxString>)
  const names = [...new Set([...doc.nets.values()].map(String).concat(objects.map((x) => x.net)))].filter((n) => n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    const objs = objects.filter((x) => x.net === name).map((x) => x.obj);
    if (!objs.length) continue;
    pr(0, `{NET="${name}"\n`); writeObjects(objs); pr(0, "}\n\n");
  }
  let idx = 0;
  for (const x of objects.filter((y) => !y.net)) { pr(0, `{NET="EmptyNet${idx}"\n`); writeObjects([x.obj]); pr(0, "}\n\n"); idx++; }
  return { text: out.join(""), warnings, errors };
}
