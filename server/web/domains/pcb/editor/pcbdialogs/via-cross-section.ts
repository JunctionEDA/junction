// pcbdialogs/via-cross-section — the schematic via cross section of the via properties dialog and Board Setup's Board
// Finish page: VIA_CROSS_SECTION_GEOMETRY (the shapes, worked out with no drawing surface so they can be checked
// without one) and VIA_CROSS_SECTION_PREVIEW (the painter).  The drawing sits on a grid GRID_W wide and gridHeight
// tall, y downwards, scaled to the widget.  Layer positions and cut depths are to scale with the board thickness and
// widths are relative to the hole; copper and mask thickness are exaggerated.  A value left undefined in the state is
// mixed across a selection, and the shapes it produces are marked mixed so they are drawn hatched.
import type { StackupLayer } from "../../canvas/board-setup";
import { effectiveTheme, subscribeTheme } from "../../../../shared/theme";

export type PostMachiningMode = "none" | "countersink" | "counterbore";
/** POST_MACHINING: a cut at the mouth of the hole, its width relative to the hole and its depth to the board */
export interface PostMachiningCut { mode: PostMachiningMode | undefined; widthRatio: number; depthFraction: number }
export interface ViaSectionState {
  tentFront?: boolean; tentBack?: boolean; coverFront?: boolean; coverBack?: boolean; plugFront?: boolean; plugBack?: boolean; filled?: boolean; capped?: boolean;
  /** depth of each copper layer centre and its thickness, as fractions of the board thickness, front to back; empty for even spacing */
  layerDepths: number[]; layerThicknesses: number[]; innerLayers: number;
  /** the copper layers the via spans, as ordinals (0 the front layer); an undefined bottom is the back layer */
  topLayer: number; bottomLayer?: number;
  /** which spanned copper layers keep an annular ring; empty for all of them */
  ringLayers: boolean[];
  padRatio: number;
  /** copper layers removed from that side by the backdrill (0 for none, undefined when mixed), and its width over the hole */
  backdrillFrontLayers: number | undefined; backdrillBackLayers: number | undefined; backdrillFrontWidthRatio: number; backdrillBackWidthRatio: number;
  postMachiningFront: PostMachiningCut; postMachiningBack: PostMachiningCut;
}
export const newCut = (): PostMachiningCut => ({ mode: "none", widthRatio: 2.0, depthFraction: 0.1 });
/** STATE's defaults: every protection feature mixed, two inner layers, a through via */
export function newViaSectionState(): ViaSectionState {
  return { layerDepths: [], layerThicknesses: [], innerLayers: 2, topLayer: 0, ringLayers: [], padRatio: 2.8, backdrillFrontLayers: 0, backdrillBackLayers: 0,
    backdrillFrontWidthRatio: 1.6, backdrillBackWidthRatio: 1.6, postMachiningFront: newCut(), postMachiningBack: newCut() };
}

/** VIA_PROTECTION_RULES: which IPC-4761 features can be built together */
export const capAllowed = (filled: boolean): boolean => filled;
export const plugAllowed = (filled: boolean): boolean => !filled;
export const coverAllowed = (filled: boolean, tented: boolean, plugged: boolean): boolean => filled || tented || plugged;

export type Material = "SOLDER_MASK" | "CORE" | "PLUG" | "COPPER" | "COVER";
/** UNDER_MASK bodies lose the bores and cuts, OVER_MASK ones the cuts only */
export type Clip = "UNDER_MASK" | "OVER_MASK";
export interface Point { x: number; y: number }
/** A rectangle holds its top left and bottom right corners, a polygon its outline */
export interface Piece { rect: boolean; points: Point[]; mixed: boolean }
export interface Body { material: Material; clip: Clip; pieces: Piece[] }

export const GRID_W = 220.0;
const OUTER_TOP = 20.0, LAYER_PITCH = 10.0;
const COPPER_THICKNESS = 8.0, MASK_THICKNESS = 8.0, COVER_THICKNESS = 6.0, INNER_THICKNESS = 4.0;
// BOARD_LEFT and BOARD_RIGHT sit slightly off view so the left and right ends are clipped, like a sectional drawing
const BOARD_LEFT = -2.0, BOARD_RIGHT = GRID_W + 4.0;
const HOLE_LEFT = GRID_W / 2 - 17.0, HOLE_RIGHT = GRID_W / 2 + 17.0, BARREL_LEFT = HOLE_LEFT - 5.0, BARREL_RIGHT = HOLE_RIGHT + 5.0;
const MAX_HALF_WIDTH = 60.0, MASK_CLEARANCE = 12.0, COVER_OVERHANG = 4.0, RING_GAP = 10.0, PLUG_DEPTH = 34.0, PLUG_ROUND = 12.0;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const innerLayersOf = (s: ViaSectionState): number => (s.layerDepths.length >= 2 ? s.layerDepths.length - 2 : Math.max(0, s.innerLayers));
const coreHeightFor = (inner: number): number => Math.max(76.0, LAYER_PITCH * (inner + 1));
const rect = (l: number, t: number, r: number, b: number, mixed = false): Piece => ({ rect: true, points: [{ x: l, y: t }, { x: r, y: b }], mixed });
const polygon = (points: Point[], mixed = false): Piece => ({ rect: false, points, mixed });
export const gridHeightFor = (inner: number): number => coreHeightFor(inner) + 2 * (OUTER_TOP + COPPER_THICKNESS);

/** The copper and dielectric items of a stackup, enabled ones only (BOARD_STACKUP::GetList) */
export interface StackupItem { copper: boolean; thicknesses: number[] }
/** SetLayersFromStackup: the depths and thicknesses, left empty when the stackup does not match the copper count; the board thickness */
export function setLayersFromStackup(state: ViaSectionState, stackup: StackupItem[], copperLayerCount: number): number {
  const centres: number[] = [], thicknesses: number[] = [];
  let total = 0;
  for (const item of stackup) {
    if (item.copper) { const t = item.thicknesses[0] || 0; centres.push(total + t / 2); thicknesses.push(t); total += t; }
    else for (const t of item.thicknesses) total += t;
  }
  state.layerDepths = []; state.layerThicknesses = [];
  if (total > 0 && centres.length === copperLayerCount) for (let i = 0; i < centres.length; i++) { state.layerDepths.push(centres[i] / total); state.layerThicknesses.push(thicknesses[i] / total); }
  return total;
}
/** The stackup as the file has it, or BOARD_STACKUP::BuildDefaultStackupList when it has none (GetStackupOrDefault) */
export function stackupItems(layers: StackupLayer[], copperLayerCount: number, boardThickness: number): StackupItem[] {
  const out: StackupItem[] = [];
  for (const l of layers) {
    if (l.type === "copper") out.push({ copper: true, thicknesses: [l.thickness || 0] });
    else if (l.type === "core" || l.type === "prepreg") out.push({ copper: false, thicknesses: [l.thickness || 0, ...(l.subs || []).map((s) => s.thickness)] });
  }
  if (out.some((x) => x.copper)) return out;
  // BuildDefaultStackupList: 35 um copper, the two masks 10 um, the dielectrics share what is left
  const cu = Math.max(2, copperLayerCount), copper = 0.035, mask = 0.01;
  const diel = Math.max(0, (boardThickness - copper * cu - mask * 2) / (cu - 1));
  const def: StackupItem[] = [];
  for (let i = 0; i < cu; i++) { def.push({ copper: true, thicknesses: [copper] }); if (i < cu - 1) def.push({ copper: false, thicknesses: [diel] }); }
  return def;
}

/** VIA_CROSS_SECTION_GEOMETRY */
export class ViaSectionGeometry {
  readonly innerLayers: number;
  readonly gridHeight: number;
  private centres: number[] = [];
  bores: Piece[] = [];
  cuts: Piece[] = [];
  bodies: Body[] = [];
  constructor(state: ViaSectionState) { this.innerLayers = innerLayersOf(state); this.gridHeight = gridHeightFor(this.innerLayers); this.build(state); }
  /** LayerCentre: the grid height of a copper layer's centre, by ordinal */
  layerCentre(ordinal: number): number { return this.centres[clamp(ordinal, 0, this.innerLayers + 1)]; }
  body(m: Material): Body { return this.bodies.find((b) => b.material === m) as Body; }

  private build(s: ViaSectionState): void {
    const depths = s.layerDepths, thicknesses = s.layerThicknesses;
    const realDepths = depths.length >= 2, realThickness = realDepths && thicknesses.length === depths.length;
    const innerLayers = this.innerLayers, lastOrdinal = innerLayers + 1;
    const boardHeight = coreHeightFor(innerLayers) + 2 * COPPER_THICKNESS;
    const shown = (f: boolean | undefined): boolean => f === undefined || f;
    const mixed = (f: boolean | undefined): boolean => f === undefined;
    // copper is drawn at its stackup thickness when known, with a floor so it stays visible under the outlines
    const copperThickness = (ordinal: number, fallback: number): number => (!realThickness ? fallback : Math.max(Math.min(4.0, fallback), boardHeight * thicknesses[ordinal]));
    const outerTop = OUTER_TOP, outerBottom = OUTER_TOP + boardHeight;
    const coreTop = outerTop + copperThickness(0, COPPER_THICKNESS), coreBottom = outerBottom - copperThickness(lastOrdinal, COPPER_THICKNESS);
    const maskTop = outerTop - MASK_THICKNESS, maskBottom = outerBottom + MASK_THICKNESS;
    const coverTop = maskTop - COVER_THICKNESS, coverBottom = maskBottom + COVER_THICKNESS;
    // widths are multiples of the hole, clamped so the picture fits; the mask opening surrounds a backdrill's bore
    const centre = (HOLE_LEFT + HOLE_RIGHT) / 2, holeHalf = (HOLE_RIGHT - HOLE_LEFT) / 2;
    const padHalf = clamp(holeHalf * s.padRatio, BARREL_RIGHT - centre + 4, MAX_HALF_WIDTH);
    const boreHalf = (ratio: number): number => clamp(holeHalf * ratio, holeHalf + 2, MAX_HALF_WIDTH);
    // inner layers sit at their real depth when the stackup is known, evenly spaced otherwise
    this.centres = [];
    for (let o = 0; o <= lastOrdinal; o++) {
      if (o === 0) this.centres.push((outerTop + coreTop) / 2);
      else if (o === lastOrdinal) this.centres.push((coreBottom + outerBottom) / 2);
      else if (realDepths) this.centres.push(clamp(outerTop + boardHeight * depths[o], coreTop + INNER_THICKNESS, coreBottom - INNER_THICKNESS));
      else this.centres.push(coreTop + (coreBottom - coreTop) * o / (innerLayers + 1));
    }
    const lc = (o: number): number => this.layerCentre(o);
    let spacing = coreBottom - coreTop;
    for (let i = 0; i <= innerLayers; i++) spacing = Math.min(spacing, lc(i + 1) - lc(i));
    const innerThickness = (o: number): number => copperThickness(o, clamp(spacing / 2, 1.0, INNER_THICKNESS));
    // a surface the via does not reach has no pad and nothing done to the hole there
    const viaTopOrdinal = clamp(s.topLayer, 0, lastOrdinal);
    const viaBottomOrdinal = clamp(s.bottomLayer === undefined ? lastOrdinal : s.bottomLayer, viaTopOrdinal, lastOrdinal);
    const reachesFront = viaTopOrdinal === 0, reachesBack = viaBottomOrdinal === lastOrdinal;
    const viaTop = reachesFront ? outerTop : lc(viaTopOrdinal) - innerThickness(viaTopOrdinal) / 2;
    const viaBottom = reachesBack ? outerBottom : lc(viaBottomOrdinal) + innerThickness(viaBottomOrdinal) / 2;
    const hasRing = (o: number): boolean => s.ringLayers.length !== lastOrdinal + 1 || s.ringLayers[o];
    const throughVia = reachesFront && reachesBack;
    const frontRemoved = throughVia ? clamp(s.backdrillFrontLayers ?? 0, 0, lastOrdinal) : 0;
    const backRemoved = throughVia ? clamp(s.backdrillBackLayers ?? 0, 0, lastOrdinal) : 0;
    const frontBored = frontRemoved > 0, backBored = backRemoved > 0;
    const frontBoreHalf = boreHalf(s.backdrillFrontWidthRatio), backBoreHalf = boreHalf(s.backdrillBackWidthRatio);
    const frontOpenHalf = Math.max(padHalf, frontBored ? frontBoreHalf : 0) + MASK_CLEARANCE;
    const backOpenHalf = Math.max(padHalf, backBored ? backBoreHalf : 0) + MASK_CLEARANCE;
    // a backdrill takes the pad and the barrel with it, and a fab wants mask clearance around the bore
    const frontOpen = reachesFront && !frontBored, backOpen = reachesBack && !backBored;
    // the features a fab can build together, a mixed value taken as present
    const filled = shown(s.filled);
    const capped = shown(s.capped) && capAllowed(filled);
    const plugFront = shown(s.plugFront) && plugAllowed(filled), plugBack = shown(s.plugBack) && plugAllowed(filled);
    const coverFront = shown(s.coverFront) && coverAllowed(filled, shown(s.tentFront), plugFront);
    const coverBack = shown(s.coverBack) && coverAllowed(filled, shown(s.tentBack), plugBack);

    // backdrills reach from the cover surface to half way between the last removed layer and the first one kept
    this.bores = [];
    if (frontBored) this.bores.push(rect(centre - frontBoreHalf, coverTop, centre + frontBoreHalf, (lc(frontRemoved - 1) + lc(frontRemoved)) / 2));
    if (backBored) { const last = innerLayers + 1 - backRemoved; this.bores.push(rect(centre - backBoreHalf, (lc(last) + lc(last + 1)) / 2, centre + backBoreHalf, coverBottom)); }

    this.cuts = [];
    const postMachining = (cut: PostMachiningCut, front: boolean): void => {
      if (cut.mode === undefined) return;
      const halfWidth = clamp(holeHalf * cut.widthRatio, holeHalf, MAX_HALF_WIDTH);
      const depth = clamp(boardHeight * cut.depthFraction, 2.0, boardHeight - 2);
      const surface = front ? outerTop : outerBottom, edge = front ? coverTop - 2 : coverBottom + 2, floor = front ? surface + depth : surface - depth;
      if (cut.mode === "counterbore") this.cuts.push(rect(centre - halfWidth, Math.min(edge, floor), centre + halfWidth, Math.max(edge, floor)));
      else if (cut.mode === "countersink") this.cuts.push(polygon([{ x: centre - halfWidth, y: edge }, { x: centre + halfWidth, y: edge }, { x: centre + halfWidth, y: surface },
        { x: centre + holeHalf, y: floor }, { x: centre - holeHalf, y: floor }, { x: centre - halfWidth, y: surface }]));
    };
    if (reachesFront) postMachining(s.postMachiningFront, true);
    if (reachesBack) postMachining(s.postMachiningBack, false);

    this.bodies = [];
    const body = (material: Material, clip: Clip): Piece[] => { const b: Body = { material, clip, pieces: [] }; this.bodies.push(b); return b.pieces; };
    const tentShape = (front: boolean, mx: boolean): Piece => (front ? rect(centre - frontOpenHalf, maskTop, centre + frontOpenHalf, outerTop, mx) : rect(centre - backOpenHalf, outerBottom, centre + backOpenHalf, maskBottom, mx));

    // solder mask on the outer copper, an opening around the pad that a tent bridges; painted first so the copper's
    // outline lands on the mask and not the reverse
    {
      const mask = body("SOLDER_MASK", "OVER_MASK");
      if (reachesFront) {
        mask.push(rect(BOARD_LEFT, maskTop, centre - frontOpenHalf, outerTop), rect(centre + frontOpenHalf, maskTop, BOARD_RIGHT, outerTop));
        if (frontOpen && shown(s.tentFront)) mask.push(tentShape(true, mixed(s.tentFront)));
      } else mask.push(rect(BOARD_LEFT, maskTop, BOARD_RIGHT, outerTop));
      if (reachesBack) {
        mask.push(rect(BOARD_LEFT, outerBottom, centre - backOpenHalf, maskBottom), rect(centre + backOpenHalf, outerBottom, BOARD_RIGHT, maskBottom));
        if (backOpen && shown(s.tentBack)) mask.push(tentShape(false, mixed(s.tentBack)));
      } else mask.push(rect(BOARD_LEFT, outerBottom, BOARD_RIGHT, maskBottom));
    }
    {
      const core = body("CORE", "UNDER_MASK");
      core.push(rect(BOARD_LEFT, coreTop, BARREL_LEFT, coreBottom), rect(BARREL_RIGHT, coreTop, BOARD_RIGHT, coreBottom));
      if (!reachesFront) core.push(rect(BARREL_LEFT, coreTop, BARREL_RIGHT, viaTop));
      if (!reachesBack) core.push(rect(BARREL_LEFT, viaBottom, BARREL_RIGHT, coreBottom));
      // a buried hole fills with laminate resin at lamination, it is never left empty
      if (!reachesFront && !reachesBack && !filled) core.push(rect(HOLE_LEFT, viaTop, HOLE_RIGHT, viaBottom));
    }
    // plugs are rounded blobs from each side; a fill supersedes them and stops at a cap
    const plugShape = (front: boolean, mx: boolean): Piece => {
      const mouth = front ? viaTop : viaBottom;
      const flat = front ? Math.min(viaTop + PLUG_DEPTH, viaBottom - PLUG_ROUND - 2) : Math.max(viaBottom - PLUG_DEPTH, viaTop + PLUG_ROUND + 2);
      const tip = front ? flat + PLUG_ROUND : flat - PLUG_ROUND;
      const pts: Point[] = [{ x: HOLE_LEFT, y: mouth }, { x: HOLE_RIGHT, y: mouth }, { x: HOLE_RIGHT, y: flat }];
      for (let i = 1; i < 8; i++) {
        const t = i / 8.0;
        pts.push({ x: (1 - t) * (1 - t) * HOLE_RIGHT + 2 * (1 - t) * t * centre + t * t * HOLE_LEFT, y: (1 - t) * (1 - t) * flat + 2 * (1 - t) * t * tip + t * t * flat });
      }
      pts.push({ x: HOLE_LEFT, y: flat });
      return polygon(pts, mx);
    };
    {
      const plug = body("PLUG", "UNDER_MASK");
      if (filled) plug.push(rect(HOLE_LEFT, capped && frontOpen ? coreTop : viaTop, HOLE_RIGHT, capped && backOpen ? coreBottom : viaBottom, mixed(s.filled)));
      else {
        if (frontOpen && plugFront) plug.push(plugShape(true, mixed(s.plugFront)));
        if (backOpen && plugBack) plug.push(plugShape(false, mixed(s.plugBack)));
      }
    }
    // the outer layers, the barrel, the inner rings and a cap are one copper body
    {
      const copper = body("COPPER", "UNDER_MASK");
      if (reachesFront) copper.push(rect(BOARD_LEFT, outerTop, BARREL_LEFT, coreTop), rect(BARREL_RIGHT, outerTop, BOARD_RIGHT, coreTop));
      else copper.push(rect(BOARD_LEFT, outerTop, BOARD_RIGHT, coreTop));
      if (reachesBack) copper.push(rect(BOARD_LEFT, coreBottom, BARREL_LEFT, outerBottom), rect(BARREL_RIGHT, coreBottom, BOARD_RIGHT, outerBottom));
      else copper.push(rect(BOARD_LEFT, coreBottom, BOARD_RIGHT, outerBottom));
      copper.push(rect(BARREL_LEFT, viaTop, HOLE_LEFT, viaBottom), rect(HOLE_RIGHT, viaTop, BARREL_RIGHT, viaBottom));
      // an inner layer outside the span runs across, one without a ring keeps clear
      for (let i = 1; i <= innerLayers; i++) {
        const t = innerThickness(i), y = lc(i) - t / 2;
        if (i < viaTopOrdinal || i > viaBottomOrdinal) copper.push(rect(BOARD_LEFT, y, BOARD_RIGHT, y + t));
        else { const gap = hasRing(i) ? 0.0 : RING_GAP; copper.push(rect(BOARD_LEFT, y, BARREL_LEFT - gap, y + t), rect(BARREL_RIGHT + gap, y, BOARD_RIGHT, y + t)); }
      }
      if (capped) {
        if (frontOpen) copper.push(rect(BARREL_LEFT, outerTop, BARREL_RIGHT, coreTop, mixed(s.capped)));
        if (backOpen) copper.push(rect(BARREL_LEFT, coreBottom, BARREL_RIGHT, outerBottom, mixed(s.capped)));
      }
    }
    // a cover is a second coat over the tent; over a plug or a fill on an untented side it bridges the opening itself
    const coverShape = (front: boolean, mx: boolean): Piece => (front
      ? rect(centre - frontOpenHalf - COVER_OVERHANG, coverTop, centre + frontOpenHalf + COVER_OVERHANG, maskTop, mx)
      : rect(centre - backOpenHalf - COVER_OVERHANG, maskBottom, centre + backOpenHalf + COVER_OVERHANG, coverBottom, mx));
    {
      const cover = body("COVER", "OVER_MASK");
      if (frontOpen && coverFront) { cover.push(coverShape(true, mixed(s.coverFront))); if (!(s.tentFront ?? false)) cover.push(tentShape(true, mixed(s.coverFront))); }
      if (backOpen && coverBack) { cover.push(coverShape(false, mixed(s.coverBack))); if (!(s.tentBack ?? false)) cover.push(tentShape(false, mixed(s.coverBack))); }
    }
  }
}

// ---------------------------------------------------------------- VIA_CROSS_SECTION_PREVIEW
const COLORS = (dark: boolean): Record<Material, [string, string]> => ({
  SOLDER_MASK: dark ? ["#f2647e", "#bf2641"] : ["#2e8b2e", "#145214"],
  CORE: dark ? ["#5f5a47", "#8e866a"] : ["#e9e1c6", "#9c926e"],
  PLUG: dark ? ["#a9a9a9", "#d8d8d8"] : ["#c4c4c4", "#6e6e6e"],
  COPPER: ["#f29100", dark ? "#bf2641" : "#8c5a00"],
  COVER: ["#42b8eb", "#1a81c4"],
});
/** wxBRUSHSTYLE_CROSSDIAG_HATCH in the fill colour over nothing */
function hatch(ctx: CanvasRenderingContext2D, color: string): CanvasPattern | string {
  if (typeof document === "undefined") return color;
  const c = document.createElement("canvas"); c.width = 8; c.height = 8;
  const g = c.getContext("2d"); if (!g) return color;
  g.strokeStyle = color; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(8, 8); g.moveTo(8, 0); g.lineTo(0, 8); g.stroke();
  return ctx.createPattern(c, "repeat") || color;
}
/** Paints the geometry on a canvas of the given device size (onPaint) */
export function paintViaSection(canvas: HTMLCanvasElement, state: ViaSectionState, width: number, height: number, dark: boolean): void {
  const ratio = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
  const out = canvas.getContext("2d"); if (!out) return;
  out.setTransform(ratio, 0, 0, ratio, 0, 0); out.clearRect(0, 0, width, height);
  const geo = new ViaSectionGeometry(state);
  const scaleX = width / GRID_W;
  // the aspect ratio pinned at no more than the golden mean
  const scaleY = Math.min(height / geo.gridHeight, 1.618 * scaleX);
  const ox = (width - GRID_W * scaleX) / 2, oy = (height - geo.gridHeight * scaleY) / 2;
  const P = (p: Point): [number, number] => [Math.round(ox + p.x * scaleX), Math.round(oy + p.y * scaleY)];
  const path = (g: CanvasRenderingContext2D, pc: Piece, grow: number): void => {
    g.beginPath();
    if (pc.rect) { const [l, t] = P(pc.points[0]), [r, b] = P(pc.points[1]); g.rect(l - grow, t - grow, r - l + 2 * grow, b - t + 2 * grow); }
    else { pc.points.forEach((pt, i) => { const [x, y] = P(pt); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.closePath(); }
  };
  const colors = COLORS(dark);
  const layer = document.createElement("canvas"); layer.width = canvas.width; layer.height = canvas.height;
  const g = layer.getContext("2d"); if (!g) return;
  for (const b of geo.bodies) {
    g.setTransform(ratio, 0, 0, ratio, 0, 0); g.globalCompositeOperation = "source-over"; g.clearRect(0, 0, width, height);
    const [fill, edge] = colors[b.material];
    // every piece in the edge colour a pixel larger, then every piece filled, so touching pieces merge into one outline
    g.fillStyle = edge;
    for (const pc of b.pieces) {
      if (pc.rect) { path(g, pc, 1); g.fill(); }
      else { path(g, pc, 0); g.strokeStyle = edge; g.lineWidth = 3; g.lineJoin = "miter"; g.stroke(); g.fill(); }
    }
    const solid = fill, hatched = hatch(g, fill);
    for (const pc of b.pieces) {
      // a hatch brush paints its lines only, over the edge pass
      path(g, pc, 0); g.fillStyle = pc.mixed ? hatched : solid; g.fill();
    }
    // air is never painted: the bores (under the mask) and the cuts are taken out, so the dialog shows through
    g.globalCompositeOperation = "destination-out"; g.fillStyle = "#000";
    for (const pc of [...(b.clip === "UNDER_MASK" ? geo.bores : []), ...geo.cuts]) { path(g, pc, 0); g.fill(); }
    out.setTransform(1, 0, 0, 1, 0, 0); out.drawImage(layer, 0, 0); out.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
}
export const VIA_SECTION_TIP = "Schematic cross section. Layer positions and cut depths are to scale with the board thickness, widths are relative to the hole. Copper and mask thickness are exaggerated.";
/** VIA_CROSS_SECTION_PREVIEW: a panel at least 150 × 300 that repaints on SetState, on resize and on a theme change */
export function viaSectionPreview(fixed?: { width: number; height: number }): { el: HTMLElement; setState(s: ViaSectionState): void; state(): ViaSectionState } {
  const el = document.createElement("div");
  el.className = "pd-viasection"; el.dataset.k = "viaPreview"; el.title = VIA_SECTION_TIP;
  // the via dialog's grows with it from 150 x 300; Board Finish's is held at 240 x 120 (SetMinSize = SetMaxSize)
  el.style.cssText = fixed ? `width:${fixed.width}px;height:${fixed.height}px;position:relative;flex:0 0 auto;margin:0 20px` : "min-width:150px;min-height:300px;position:relative;flex:1 1 150px;align-self:stretch";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
  el.append(canvas);
  let cur = newViaSectionState();
  const paint = (): void => { const w = el.clientWidth || 150, ht = el.clientHeight || 300; paintViaSection(canvas, cur, w, ht, effectiveTheme() === "dark"); };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => paint()).observe(el);
  const unsub = subscribeTheme(() => { if (!el.isConnected) { unsub(); return; } paint(); });
  return { el, setState(s) { cur = s; paint(); }, state: () => cur };
}
