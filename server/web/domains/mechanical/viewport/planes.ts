// planes.ts — the default geometry of a part studio in the viewport: the origin and the Top, Front and Right
// planes, and the names of every plane in the scene (the default ones and reference planes).
//
//   • A default plane is a square centred on the origin.  Its size is the document's when a person has dragged
//     one of its corners (`setSizes`, from the studio item: document/plane-sizes.ts); otherwise it starts at
//     `DEFAULT_HALF` and grows to reach a little past the model on its two axes.  A corner drag shows the new
//     size at once (`setDragSize`) and the studio commits it when the button comes up.
//   • A plane is a pale translucent sheet with a thin outline, the three alike.  The three cut each other along
//     the axes, so each is drawn as its four quarters: no two quarters cross, and drawn from the back to the
//     front they blend in the right order — where one plane is behind another the tint is deeper.  The plane
//     under the pointer gets an orange outline and nothing else; a selected one the selection's colour.
//   • A plane's name is text drawn ON the plane, at one corner of it, as Onshape does: it foreshortens and turns
//     with the plane, and seen from behind it reads mirrored.  "Top" lies at the corner of −X −Y reading along
//     +X, "Front" at −X +Z reading along +X, and "Right" at +Y +Z reading along −Y (so it is mirrored in the
//     isometric view, as in Onshape).  A reference plane's name sits the same way in its own frame.  Its height
//     follows the size of the plane (kept readable, and no larger than a heading, at any zoom), and it fades away
//     as the plane turns edge-on.
//   • The origin is a small circle with a dot, the same size on screen at any zoom, drawn over everything.
//   • Each of the four can be hidden on its own (the feature list's eye); a hidden plane is neither drawn, picked
//     nor resized.
//
// ModelView (modelview.ts) owns one PlaneLayer; it holds no document state.
import * as THREE from "three";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { Viewport3D } from "../../../shared/viewport3d/viewport3d";
import { DEFAULT_PLANES, type DefaultPlaneId, type Frame, type Vec3 } from "../core/geometry";

/** The ids of the default geometry, as the feature list and the hidden set know them. */
export type DefaultGeometryId = "origin" | DefaultPlaneId;
export const DEFAULT_GEOMETRY: readonly { id: DefaultGeometryId; title: string }[] = [
  { id: "origin", title: "Origin" }, { id: "top", title: "Top" }, { id: "front", title: "Front" }, { id: "right", title: "Right" },
];

/** Half the side of a default plane nobody has resized, with no model (mm). */
export const DEFAULT_HALF = 30;
/** The smallest half side a corner drag leaves a plane with (mm). */
export const MIN_HALF = 1;
const GROW = 1.2;
/** A name's letters are this tall, as a share of the side of its plane; and this far in from the corner, in letter heights. */
const LABEL_SHARE = 0.05, LABEL_INSET = 0.5;
/**
 * … but on screen never smaller than a person can read nor larger than a heading, whatever the zoom (pixels,
 * for a plane seen face-on), and never more than this share of its plane.
 */
const LABEL_MIN_PX = 12, LABEL_MAX_PX = 20, LABEL_MOST = 0.22;
/** The canvas a name is drawn on: the letter height in pixels (the text is then scaled down by the scene, so it stays sharp). */
const LABEL_PX = 72;
/** How near (CSS pixels) the pointer must be to a corner to take hold of it. */
export const CORNER_REACH = 9;
/** The origin's mark, and a corner's handle, on screen (CSS pixels). */
const ORIGIN_PX = 13, HANDLE_PX = 11;

/**
 * How each default plane's name lies, as in Onshape: the direction the text runs (`x` of the plane's frame, or
 * its reverse; its up is always `y`) and the corner it sits in as the text reads, top left or bottom left.  In
 * the isometric view that puts "Top" at the plane's left corner, "Front" at its top left and "Right" (written
 * along −Y, so mirrored from +X) at its top right.
 */
const LABEL_LAY: Record<DefaultPlaneId, { run: 1 | -1; low: boolean }> = { top: { run: 1, low: true }, front: { run: 1, low: false }, right: { run: -1, low: false } };

/** The planes' colours for a light and a dark theme. */
const PALETTE = {
  light: { fill: "#91a9d0", fillOpacity: 0.12, line: "#a9bcdc", label: "#3a5fb0", hover: "#f0b97a", origin: "#1b1d21", handle: "#f0a04b" },
  dark: { fill: "#7d9ad0", fillOpacity: 0.1, line: "#5d77a6", label: "#93b3ee", hover: "#e9a25e", origin: "#e8eaee", handle: "#f0a04b" },
};

type Fat = (color: THREE.Color, width: number, o?: Partial<{ dashed: boolean; depthTest: boolean }>) => LineMaterial;

interface PlaneObjects {
  id: DefaultPlaneId; frame: Frame;
  /** half the side of the square, as drawn */
  half: number;
  /** the four quarters that are drawn */
  quarters: THREE.Mesh[]; fill: THREE.MeshBasicMaterial;
  /** the whole square, never drawn: what the pointer hits and what a highlight is drawn with */
  hit: THREE.Mesh;
  border: LineSegments2; line: LineMaterial;
  shown: boolean;
}
interface Label {
  key: string; text: string; mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; texture: THREE.CanvasTexture; aspect: number;
  /** the rectangle it names: its middle, its two axes (unit) and half sizes, its normal */
  centre: THREE.Vector3; x: THREE.Vector3; y: THREE.Vector3; hx: number; hy: number; normal: THREE.Vector3;
  /** the text runs along +x (1) or −x (−1); it sits in the corner at the bottom (`low`) or the top as it reads */
  run: 1 | -1; low: boolean;
  visible: boolean; opacity: number;
}
/** What a test, or anything else, may ask about a name on a plane. */
export interface PlaneLabelInfo {
  key: string; text: string;
  /** drawn at all, and how opaque (0: hidden, edge-on or its plane is hidden) */
  shown: boolean; opacity: number; marked: boolean;
  /** the name's own axes in the model: the way the text runs, its up, and the normal of the surface it is drawn on */
  right: Vec3; up: Vec3; normal: Vec3;
  /** the letter height in model units */
  height: number;
  /** the middle of the text, in the model */
  at: Vec3;
}
/** A corner of a default plane: its plane and its signs along the plane's two axes. */
export interface PlaneCorner { plane: DefaultPlaneId; su: 1 | -1; sv: 1 | -1 }

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);
const arr = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
const corner = (f: Frame, u: number, v: number) => v3(f.origin).addScaledVector(v3(f.x), u).addScaledVector(v3(f.y), v);

/** A round mark on a canvas, white on nothing (the material's colour is its colour): a ring with a dot, or a disc with a ring. */
function markTexture(kind: "origin" | "handle"): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = "#fff"; g.strokeStyle = "#fff";
    if (kind === "origin") {
      g.lineWidth = 7; g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(32, 32, 9, 0, Math.PI * 2); g.fill();
    } else { g.beginPath(); g.arc(32, 32, 28, 0, Math.PI * 2); g.fill(); }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class PlaneLayer {
  readonly group = new THREE.Group();
  private planes: PlaneObjects[] = [];
  private origin: THREE.Points;
  private handle: THREE.Points;
  private handleAt: PlaneCorner | null = null;
  private labels = new Map<string, Label>();
  private hidden = new Set<string>();
  private strong = new Set<string>();
  private soft = new Set<string>();
  /** the sizes the document gives (half sides), and the one a corner drag is showing */
  private sizes: Partial<Record<DefaultPlaneId, number>> = {};
  private drag: { id: DefaultPlaneId; half: number } | null = null;
  private box: THREE.Box3 | null = null;
  private colors = { line: new THREE.Color(), label: new THREE.Color(), strong: new THREE.Color(), hover: new THREE.Color() };
  private fillOpacity = PALETTE.light.fillOpacity;

  constructor(private readonly viewport: Viewport3D, fat: Fat) {
    for (const id of Object.keys(DEFAULT_PLANES) as DefaultPlaneId[]) {
      const fill = new THREE.MeshBasicMaterial({ transparent: true, opacity: this.fillOpacity, side: THREE.DoubleSide, depthWrite: false });
      const quarters: THREE.Mesh[] = [];
      for (let i = 0; i < 4; i++) {
        const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3)); g.setIndex([0, 1, 2, 0, 2, 3]);
        const q = new THREE.Mesh(g, fill);
        q.userData.planeQuarter = id;
        quarters.push(q);
      }
      const hg = new THREE.BufferGeometry(); hg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3)); hg.setIndex([0, 1, 2, 0, 2, 3]);
      const hit = new THREE.Mesh(hg, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
      hit.userData.plane = id;
      const line = fat(new THREE.Color(), 1.5);
      const border = new LineSegments2(new LineSegmentsGeometry(), line);
      border.renderOrder = 2;
      this.group.add(...quarters, hit, border);
      this.planes.push({ id, frame: DEFAULT_PLANES[id].frame, half: 0, quarters, fill, hit, border, line, shown: true });
    }
    const mark = (kind: "origin" | "handle", order: number) => {
      const p = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]), new THREE.PointsMaterial({ map: markTexture(kind), size: 1, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, alphaTest: 0.05 }));
      p.renderOrder = order; p.frustumCulled = false;
      this.group.add(p);
      return p;
    };
    this.origin = mark("origin", 6);
    this.handle = mark("handle", 7); this.handle.visible = false;
    this.resize();
    viewport.onFrame.push(this.place);
    // the names are drawn with the page's own type: once it has arrived, draw them again
    const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
    if (fonts && fonts.ready) void fonts.ready.then(() => { for (const l of this.labels.values()) this.paint(l); this.viewport.invalidate(); });
  }

  dispose(): void {
    const i = this.viewport.onFrame.indexOf(this.place); if (i >= 0) this.viewport.onFrame.splice(i, 1);
    for (const l of this.labels.values()) { l.texture.dispose(); l.material.dispose(); l.mesh.geometry.dispose(); }
    this.labels.clear();
  }

  /**
   * The theme's colours.  The planes keep Onshape's pale blue whatever the theme's accent: `dark` picks the
   * set made for a dark background; `select` is what is selected.
   */
  setColors(c: { dark: boolean; select: THREE.Color }): void {
    const p = c.dark ? PALETTE.dark : PALETTE.light;
    this.colors.line.set(p.line); this.colors.label.set(p.label); this.colors.strong.copy(c.select); this.colors.hover.set(p.hover);
    this.fillOpacity = p.fillOpacity;
    for (const pl of this.planes) { pl.fill.color.set(p.fill); pl.fill.opacity = p.fillOpacity; }
    (this.origin.material as THREE.PointsMaterial).color.set(p.origin);
    (this.handle.material as THREE.PointsMaterial).color.set(p.handle);
    this.restyle();
  }

  // ---------------------------------------------------------------- size
  /** Size the planes nobody resized for a model that fills `box` (null: no model yet). */
  setExtent(box: THREE.Box3 | null): void { this.box = box && !box.isEmpty() ? box.clone() : null; this.resize(); }
  /** The sizes the document stores, as half sides (mm), by plane; a plane left out grows with the model. */
  setSizes(sizes: Partial<Record<DefaultPlaneId, number>>): void { this.sizes = { ...sizes }; this.resize(); }
  /** Show a plane at this half side while its corner is dragged (null: the drag is over). */
  setDragSize(id: DefaultPlaneId | null, half = 0): void { this.drag = id ? { id, half: Math.max(MIN_HALF, half) } : null; this.resize(); }
  /** Has a person set this plane's size (it no longer grows with the model)? */
  isSized(id: DefaultPlaneId): boolean { return typeof this.sizes[id] === "number"; }

  /** The half side a plane nobody resized takes: a little past the model on both of its axes, never under the default. */
  private autoHalf(f: Frame): number {
    const box = this.box;
    if (!box) return DEFAULT_HALF;
    let reach = 0;
    for (const axis of [f.x, f.y]) {
      const a = new THREE.Vector3(Math.abs(axis[0]), Math.abs(axis[1]), Math.abs(axis[2]));
      reach = Math.max(reach, Math.abs(box.min.dot(a)), Math.abs(box.max.dot(a)));
    }
    return Math.max(DEFAULT_HALF, reach * GROW);
  }

  private resize(): void {
    for (const p of this.planes) {
      const f = p.frame;
      const h = this.drag && this.drag.id === p.id ? this.drag.half : this.sizes[p.id] ?? this.autoHalf(f);
      if (p.half === h) continue;
      p.half = h;
      const pts = [corner(f, -h, -h), corner(f, h, -h), corner(f, h, h), corner(f, -h, h)];
      const ha = p.hit.geometry.getAttribute("position") as THREE.BufferAttribute;
      pts.forEach((q, i) => ha.setXYZ(i, q.x, q.y, q.z));
      ha.needsUpdate = true; p.hit.geometry.computeBoundingSphere(); p.hit.geometry.computeBoundingBox();
      // a quarter is placed at its own middle, so the scene sorts the twelve of them from the back to the front
      const x = v3(f.x), y = v3(f.y);
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([su, sv], i) => {
        const q = p.quarters[i], a = q.geometry.getAttribute("position") as THREE.BufferAttribute;
        q.position.copy(corner(f, (su * h) / 2, (sv * h) / 2));
        [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([u, v], k) => { const c = x.clone().multiplyScalar((u * h) / 2).addScaledVector(y, (v * h) / 2); a.setXYZ(k, c.x, c.y, c.z); });
        a.needsUpdate = true; q.geometry.computeBoundingSphere(); q.geometry.computeBoundingBox();
      });
      const seg: number[] = [];
      for (let i = 0; i < 4; i++) { const a = pts[i], b = pts[(i + 1) % 4]; seg.push(a.x, a.y, a.z, b.x, b.y, b.z); }
      p.border.geometry.dispose();
      p.border.geometry = new LineSegmentsGeometry().setPositions(seg);
      this.setLabel("plane:" + p.id, DEFAULT_PLANES[p.id].title, pts, v3(f.normal), LABEL_LAY[p.id].run, LABEL_LAY[p.id].low);
    }
    if (this.handleAt) this.showHandle(this.handleAt);
    this.apply();
  }
  /** How far a default plane reaches from the origin along its two axes. */
  halfOf(id: DefaultPlaneId): [number, number] { const h = this.planes.find((p) => p.id === id)?.half || DEFAULT_HALF; return [h, h]; }

  // ---------------------------------------------------------------- corners
  /** The corner of a shown default plane within `reach` CSS pixels of a point on the canvas, the nearest. */
  cornerAt(x: number, y: number, reach = CORNER_REACH): PlaneCorner | null {
    let best: { c: PlaneCorner; d: number } | null = null;
    const to = new THREE.Vector3(), o = new THREE.Vector3();
    for (const p of this.planes) {
      if (!p.shown) continue;
      // a plane seen edge-on has no corner to take hold of
      if (Math.abs(this.toCamera(o.set(0, 0, 0), to).dot(v3(p.frame.normal))) < 0.15) continue;
      for (const su of [-1, 1] as const) for (const sv of [-1, 1] as const) {
        const s = this.viewport.project(corner(p.frame, su * p.half, sv * p.half));
        const d = Math.hypot(s.x - x, s.y - y);
        if (d <= reach && (!best || d < best.d)) best = { c: { plane: p.id, su, sv }, d };
      }
    }
    return best ? best.c : null;
  }
  /** Where a corner is, in the model. */
  cornerPoint(c: PlaneCorner): THREE.Vector3 { const p = this.planes.find((x) => x.id === c.plane)!; return corner(p.frame, c.su * p.half, c.sv * p.half); }
  /** Draw the handle on a corner (null: none). */
  showHandle(c: PlaneCorner | null): void {
    this.handleAt = c;
    this.handle.visible = !!c;
    if (c) { const at = this.cornerPoint(c); this.handle.position.copy(at); this.handle.updateMatrixWorld(); }
    this.viewport.invalidate();
  }

  // ---------------------------------------------------------------- names
  /**
   * A name for a rectangle in the scene (a default plane, a reference plane), given its four corners in order
   * round the rectangle, starting where both of its own axes are least.  `run` −1 writes it along −x; `low` puts it
   * in the bottom left corner instead of the top left.
   */
  setLabel(key: string, text: string, corners: readonly THREE.Vector3[], normal: THREE.Vector3, run: 1 | -1 = 1, low = false): void {
    let l = this.labels.get(key);
    if (!l) {
      const canvas = document.createElement("canvas");
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = this.viewport.renderer.capabilities.getMaxAnisotropy();
      const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      mesh.matrixAutoUpdate = false; mesh.renderOrder = 1; mesh.userData.planeLabel = key;
      this.group.add(mesh);
      l = { key, text: "", mesh, material, texture, aspect: 1, centre: new THREE.Vector3(), x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), hx: 1, hy: 1, normal: new THREE.Vector3(0, 0, 1), run, low, visible: true, opacity: 0 };
      this.labels.set(key, l);
    }
    l.run = run; l.low = low;
    if (l.text !== text) { l.text = text; this.paint(l); }
    const ex = corners[1].clone().sub(corners[0]), ey = corners[3].clone().sub(corners[0]);
    l.hx = ex.length() / 2; l.hy = ey.length() / 2;
    l.x.copy(ex).normalize(); l.y.copy(ey).normalize();
    l.centre.copy(corners[0]).add(corners[2]).multiplyScalar(0.5);
    l.normal.copy(normal).normalize();
    this.restyle();
    this.viewport.invalidate();
  }
  /** Draw a name's text on its canvas: white on nothing, so the material's colour is the colour of the text. */
  private paint(l: Label): void {
    const canvas = l.texture.image as HTMLCanvasElement, ctx = canvas.getContext("2d"); if (!ctx) return;
    const font = `500 ${LABEL_PX}px "IBM Plex Sans", system-ui, sans-serif`;
    ctx.font = font;
    const pad = Math.round(LABEL_PX * 0.12);
    const w = Math.max(8, Math.ceil(ctx.measureText(l.text).width) + pad * 2), h = Math.round(LABEL_PX * 1.3);
    canvas.width = w; canvas.height = h;
    ctx.font = font; ctx.textBaseline = "middle"; ctx.fillStyle = "#fff";
    ctx.clearRect(0, 0, w, h);
    ctx.fillText(l.text, pad, h / 2 + LABEL_PX * 0.04);
    l.aspect = w / h;
    // a canvas of another size is another texture
    l.texture.dispose(); l.texture.needsUpdate = true;
  }
  /** Drop the labels whose key starts with `prefix` and is not in `keep`. */
  pruneLabels(prefix: string, keep: ReadonlySet<string>): void {
    for (const [key, l] of Array.from(this.labels)) {
      if (!key.startsWith(prefix) || keep.has(key)) continue;
      this.group.remove(l.mesh); l.texture.dispose(); l.material.dispose(); l.mesh.geometry.dispose();
      this.labels.delete(key);
    }
  }
  setLabelVisible(key: string, on: boolean): void { const l = this.labels.get(key); if (l && l.visible !== on) { l.visible = on; this.viewport.invalidate(); } }
  /**
   * Draw these planes strongly, by their label keys ("plane:top", "datum:<feature id>"): `strong` the selected
   * ones and those a dialog holds, `soft` the one under the pointer (an orange outline, nothing else).
   */
  setMarked(strong: ReadonlySet<string>, soft: ReadonlySet<string> = new Set()): void {
    this.strong = new Set(strong); this.soft = new Set(soft);
    this.restyle();
  }
  /** The outline of a default plane as it is drawn now: its colour as "#rrggbb" and its width in pixels (for tests). */
  outlineOf(id: DefaultPlaneId): { color: string; width: number } {
    const p = this.planes.find((x) => x.id === id)!;
    return { color: "#" + p.line.color.getHexString(), width: p.line.linewidth };
  }
  private restyle(): void {
    for (const p of this.planes) {
      const key = "plane:" + p.id, on = this.strong.has(key), over = this.soft.has(key);
      p.line.color.copy(on ? this.colors.strong : over ? this.colors.hover : this.colors.line);
      p.line.linewidth = on ? 2.5 : over ? 2.5 : 1.5;
      p.line.opacity = 1;
    }
    for (const l of this.labels.values()) l.material.color.copy(this.colors.label);
    this.viewport.invalidate();
  }
  /** The names as they are drawn in this frame's view: for tests, and for anything that wants to know where they are. */
  labelInfo(): PlaneLabelInfo[] {
    this.place();
    return Array.from(this.labels.values()).map((l) => {
      const m = l.mesh.matrix.elements;
      const right = new THREE.Vector3(m[0], m[1], m[2]), up = new THREE.Vector3(m[4], m[5], m[6]), normal = new THREE.Vector3(m[8], m[9], m[10]);
      const height = up.length() / 1.3;
      return { key: l.key, text: l.text, shown: l.mesh.visible, opacity: l.mesh.visible ? l.opacity : 0, marked: this.strong.has(l.key) || this.soft.has(l.key), right: arr(right.normalize()), up: arr(up.normalize()), normal: arr(normal.normalize()), height, at: [m[12], m[13], m[14]] };
    });
  }

  // ---------------------------------------------------------------- what is hidden
  /** Which of the default geometry is hidden. */
  setHidden(ids: ReadonlySet<string>): void { this.hidden = new Set(ids); this.apply(); }
  isShown(id: DefaultGeometryId): boolean { return !this.hidden.has(id); }
  private apply(): void {
    for (const p of this.planes) {
      p.shown = !this.hidden.has(p.id);
      for (const q of p.quarters) q.visible = p.shown;
      p.border.visible = p.shown;
      this.setLabelVisible("plane:" + p.id, p.shown);
    }
    if (this.handleAt && this.hidden.has(this.handleAt.plane)) this.showHandle(null);
    this.origin.visible = !this.hidden.has("origin");
    this.viewport.invalidate();
  }

  /** The default plane's square, for the highlight (null when it is hidden). */
  quadOf(id: DefaultPlaneId): THREE.Mesh | null { const p = this.planes.find((x) => x.id === id); return p && p.shown ? p.hit : null; }
  /** The squares the pointer can hit. */
  pickable(): THREE.Object3D[] { return this.planes.filter((p) => p.shown).map((p) => p.hit); }

  // ---------------------------------------------------------------- every frame
  /** Towards the camera from `at`, as a unit vector: the same everywhere in a parallel view. */
  private toCamera(at: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const cam = this.viewport.activeCamera;
    if (this.viewport.projection === "perspective") return out.copy(cam.position).sub(at).normalize();
    return out.set(0, 0, 1).applyQuaternion(cam.quaternion);
  }
  /** Lay every name on its plane for this view, and size the marks for the screen.  Called before each frame. */
  private place = (): void => {
    const ratio = this.viewport.renderer.getPixelRatio();
    (this.origin.material as THREE.PointsMaterial).size = ORIGIN_PX * ratio;
    (this.handle.material as THREE.PointsMaterial).size = HANDLE_PX * ratio;
    if (!this.labels.size) return;
    const to = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(), n = new THREE.Vector3(), at = new THREE.Vector3();
    const px = this.viewport.pixelSize();
    for (const l of this.labels.values()) {
      this.toCamera(l.centre, to);
      const facing = Math.abs(l.normal.dot(to));
      // edge-on, the rectangle is a sliver and its name a smear
      const alpha = l.visible ? Math.max(0, Math.min(1, (facing - 0.12) / 0.22)) : 0;
      if (alpha <= 0.01) { l.mesh.visible = false; l.opacity = 0; continue; }
      // the text lies on the plane as written: from behind it reads mirrored, as a name painted on glass does
      right.copy(l.x).multiplyScalar(l.run); up.copy(l.y); n.crossVectors(right, up);
      const side2 = Math.min(l.hx, l.hy) * 2;
      const height = Math.min(side2 * LABEL_MOST, Math.max(LABEL_MIN_PX * px, Math.min(LABEL_MAX_PX * px, side2 * LABEL_SHARE)));
      const h = height * 1.3, w = h * l.aspect, inset = height * LABEL_INSET;
      // inside the corner that is at the top left (or bottom left) as the text reads
      at.copy(l.centre).addScaledVector(right, -l.hx + inset + w / 2).addScaledVector(up, l.low ? -l.hy + inset + h / 2 : l.hy - inset - h / 2);
      l.mesh.matrix.makeBasis(right.clone().multiplyScalar(w), up.clone().multiplyScalar(h), n).setPosition(at);
      l.mesh.matrixWorldNeedsUpdate = true;
      l.mesh.visible = true;
      l.opacity = Math.round(alpha * 100) / 100;
      l.material.opacity = l.opacity;
    }
  };
}
