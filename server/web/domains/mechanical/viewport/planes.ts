// planes.ts — the default geometry of a part studio in the viewport: the origin and the Top, Front and Right
// planes, and the names of every plane in the scene (the default ones and reference planes).
//
//   • A plane is as large as the model needs: its rectangle reaches a little past the model's box on its two
//     axes (never smaller than `MIN_HALF`), and grows and shrinks as the model does.
//   • A plane is a translucent sheet with a border.  The three cut each other along the axes, so each is drawn
//     as its four quarters: no two quarters cross, and drawn from the back to the front they blend in the right
//     order — where one plane is behind another the tint is deeper, and it never comes out as one flat blob.
//     The side of a plane that faces the camera is tinted a little more than its back, and each plane has a tint
//     of its own within one family of colour, so three sheets seen from a corner are three sheets.
//   • A plane's name lies IN the plane, as text on its surface near a corner: it foreshortens and turns with the
//     plane.  It is never mirrored and never upside down: seen from behind, or from below, it is turned over
//     and moves to the corner that is then at the top left.  Its height follows the size of the plane (kept
//     readable, and no larger than a heading, at any zoom), and it fades away as the plane turns edge-on.
//   • Each of the four can be hidden on its own (the feature list's eye); a hidden plane is not picked.
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

const MIN_HALF = 30;
const GROW = 1.2;
/** How strongly a plane is tinted, seen from its front and from its back. */
const FILL_FRONT = 0.15, FILL_BACK = 0.09;
/** A name's letters are this tall, as a share of the shorter side of its plane; and this far in from the corner, in letter heights. */
const LABEL_SHARE = 0.07, LABEL_INSET = 0.55;
/**
 * … but on screen never smaller than a person can read nor larger than a heading, whatever the zoom (pixels,
 * for a plane seen face-on), and never more than this share of its plane.
 */
const LABEL_MIN_PX = 13, LABEL_MAX_PX = 30, LABEL_MOST = 0.22;
/** The canvas a name is drawn on: the letter height in pixels (the text is then scaled down by the scene, so it stays sharp). */
const LABEL_PX = 72;
/** How each default plane's tint differs from the family's: a small turn of hue, nothing loud. */
const HUE_SHIFT: Record<DefaultPlaneId, number> = { top: 0, front: 0.07, right: -0.09 };

type Fat = (color: THREE.Color, width: number, o?: Partial<{ dashed: boolean; depthTest: boolean }>) => LineMaterial;

interface PlaneObjects {
  id: DefaultPlaneId; frame: Frame; half: [number, number];
  /** the four quarters that are drawn */
  quarters: THREE.Mesh[]; fill: THREE.MeshBasicMaterial;
  /** the whole rectangle, never drawn: what the pointer hits and what a highlight is drawn with */
  hit: THREE.Mesh;
  border: LineSegments2; line: LineMaterial;
  shown: boolean;
}
interface Label {
  key: string; text: string; mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; texture: THREE.CanvasTexture; aspect: number;
  /** the rectangle it names: its middle, its two axes (unit) and half sizes, its normal */
  centre: THREE.Vector3; x: THREE.Vector3; y: THREE.Vector3; hx: number; hy: number; normal: THREE.Vector3;
  visible: boolean;
  /** which way it was last laid: +1 or -1 along each axis, kept until another way is clearly better */
  sx: number; sy: number; opacity: number;
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
}

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);
const arr = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
const corner = (f: Frame, u: number, v: number) => v3(f.origin).addScaledVector(v3(f.x), u).addScaledVector(v3(f.y), v);

export class PlaneLayer {
  readonly group = new THREE.Group();
  private planes: PlaneObjects[] = [];
  private origin: THREE.Points;
  private labels = new Map<string, Label>();
  private hidden = new Set<string>();
  private strong = new Set<string>();
  private soft = new Set<string>();
  private colors = { line: new THREE.Color(), label: new THREE.Color(), strong: new THREE.Color(), ink: new THREE.Color() };

  constructor(private readonly viewport: Viewport3D, fat: Fat) {
    for (const id of Object.keys(DEFAULT_PLANES) as DefaultPlaneId[]) {
      const fill = new THREE.MeshBasicMaterial({ transparent: true, opacity: FILL_FRONT, side: THREE.DoubleSide, depthWrite: false });
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
      this.planes.push({ id, frame: DEFAULT_PLANES[id].frame, half: [0, 0], quarters, fill, hit, border, line, shown: true });
    }
    this.origin = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]), new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, depthTest: false }));
    this.origin.renderOrder = 6;
    this.group.add(this.origin);
    this.setExtent(null);
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
   * The theme's colours: `tint` is the family every plane is tinted in (each default plane a little apart from
   * it), `label` the names, `select` what is selected, `ink` the name of a plane under the pointer.
   */
  setColors(c: { tint: THREE.Color; label: THREE.Color; select: THREE.Color; ink: THREE.Color }): void {
    this.colors.line.copy(c.tint); this.colors.label.copy(c.label); this.colors.strong.copy(c.select); this.colors.ink.copy(c.ink);
    for (const p of this.planes) p.fill.color.copy(c.tint).offsetHSL(HUE_SHIFT[p.id], 0, 0);
    (this.origin.material as THREE.PointsMaterial).color.copy(c.label);
    this.restyle();
  }
  /** The border colour of a default plane: its tint, darker. */
  private lineOf(p: PlaneObjects): THREE.Color { return this.colors.line.clone().offsetHSL(HUE_SHIFT[p.id], 0, 0); }

  /** Size the planes for a model that fills `box` (null: no model yet). */
  setExtent(box: THREE.Box3 | null): void {
    const reach = (axis: THREE.Vector3): number => {
      if (!box || box.isEmpty()) return MIN_HALF;
      const lo = box.min.dot(axis), hi = box.max.dot(axis);
      return Math.max(MIN_HALF, Math.max(Math.abs(lo), Math.abs(hi)) * GROW);
    };
    for (const p of this.planes) {
      const f = p.frame;
      // the frames' axes are world axes, so the box's reach along one is the dot with its corners' extremes
      const hx = reach(v3(f.x).set(Math.abs(f.x[0]), Math.abs(f.x[1]), Math.abs(f.x[2]))), hy = reach(v3(f.y).set(Math.abs(f.y[0]), Math.abs(f.y[1]), Math.abs(f.y[2])));
      if (p.half[0] === hx && p.half[1] === hy) continue;
      p.half = [hx, hy];
      const pts = [corner(f, -hx, -hy), corner(f, hx, -hy), corner(f, hx, hy), corner(f, -hx, hy)];
      const ha = p.hit.geometry.getAttribute("position") as THREE.BufferAttribute;
      pts.forEach((q, i) => ha.setXYZ(i, q.x, q.y, q.z));
      ha.needsUpdate = true; p.hit.geometry.computeBoundingSphere(); p.hit.geometry.computeBoundingBox();
      // a quarter is placed at its own middle, so the scene sorts the twelve of them from the back to the front
      const x = v3(f.x), y = v3(f.y);
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([su, sv], i) => {
        const q = p.quarters[i], a = q.geometry.getAttribute("position") as THREE.BufferAttribute;
        q.position.copy(corner(f, (su * hx) / 2, (sv * hy) / 2));
        [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([u, v], k) => { const c = x.clone().multiplyScalar((u * hx) / 2).addScaledVector(y, (v * hy) / 2); a.setXYZ(k, c.x, c.y, c.z); });
        a.needsUpdate = true; q.geometry.computeBoundingSphere(); q.geometry.computeBoundingBox();
      });
      const seg: number[] = [];
      for (let i = 0; i < 4; i++) { const a = pts[i], b = pts[(i + 1) % 4]; seg.push(a.x, a.y, a.z, b.x, b.y, b.z); }
      p.border.geometry.dispose();
      p.border.geometry = new LineSegmentsGeometry().setPositions(seg);
      this.setLabel("plane:" + p.id, DEFAULT_PLANES[p.id].title, pts, v3(f.normal));
    }
    this.apply();
  }
  /** How far a default plane reaches from the origin along its two axes. */
  halfOf(id: DefaultPlaneId): [number, number] { return this.planes.find((p) => p.id === id)?.half || [MIN_HALF, MIN_HALF]; }

  // ---------------------------------------------------------------- names
  /**
   * A name for a rectangle in the scene (a default plane, a reference plane), given its four corners in order
   * round the rectangle, starting where both of its own axes are least.
   */
  setLabel(key: string, text: string, corners: readonly THREE.Vector3[], normal: THREE.Vector3): void {
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
      l = { key, text: "", mesh, material, texture, aspect: 1, centre: new THREE.Vector3(), x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), hx: 1, hy: 1, normal: new THREE.Vector3(0, 0, 1), visible: true, sx: 1, sy: 1, opacity: 0 };
      this.labels.set(key, l);
    }
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
   * ones and those a dialog holds, `soft` the one under the pointer.
   */
  setMarked(strong: ReadonlySet<string>, soft: ReadonlySet<string> = new Set()): void {
    this.strong = new Set(strong); this.soft = new Set(soft);
    this.restyle();
  }
  private restyle(): void {
    for (const p of this.planes) {
      const key = "plane:" + p.id, on = this.strong.has(key), over = this.soft.has(key);
      p.line.color.copy(on ? this.colors.strong : this.lineOf(p));
      p.line.linewidth = on ? 2.5 : over ? 2 : 1.5;
      p.line.opacity = on || over ? 1 : 0.8;
    }
    for (const l of this.labels.values()) l.material.color.copy(this.strong.has(l.key) || this.soft.has(l.key) ? this.colors.ink : this.colors.label);
    this.viewport.invalidate();
  }
  /** The names as they are drawn in this frame's view: for tests, and for anything that wants to know where they are. */
  labelInfo(): PlaneLabelInfo[] {
    this.place();
    return Array.from(this.labels.values()).map((l) => {
      const m = l.mesh.matrix.elements;
      const right = new THREE.Vector3(m[0], m[1], m[2]), up = new THREE.Vector3(m[4], m[5], m[6]), normal = new THREE.Vector3(m[8], m[9], m[10]);
      const height = up.length() / 1.3;
      return { key: l.key, text: l.text, shown: l.mesh.visible, opacity: l.mesh.visible ? l.opacity : 0, marked: this.strong.has(l.key) || this.soft.has(l.key), right: arr(right.normalize()), up: arr(up.normalize()), normal: arr(normal.normalize()), height };
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
    this.origin.visible = !this.hidden.has("origin");
    this.viewport.invalidate();
  }

  /** The default plane's rectangle, for the highlight (null when it is hidden). */
  quadOf(id: DefaultPlaneId): THREE.Mesh | null { const p = this.planes.find((x) => x.id === id); return p && p.shown ? p.hit : null; }
  /** The rectangles the pointer can hit. */
  pickable(): THREE.Object3D[] { return this.planes.filter((p) => p.shown).map((p) => p.hit); }

  // ---------------------------------------------------------------- every frame
  /** Towards the camera from `at`, as a unit vector: the same everywhere in a parallel view. */
  private toCamera(at: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const cam = this.viewport.activeCamera;
    if (this.viewport.projection === "perspective") return out.copy(cam.position).sub(at).normalize();
    return out.set(0, 0, 1).applyQuaternion(cam.quaternion);
  }
  /** Tint each plane for the side that is seen, and lay every name the right way round for this view.  Called before each frame. */
  private place = (): void => {
    const cam = this.viewport.activeCamera;
    const to = new THREE.Vector3(), o = new THREE.Vector3();
    for (const p of this.planes) {
      if (!p.shown) continue;
      const front = this.toCamera(o.set(...p.frame.origin), to).dot(o.set(...p.frame.normal)) >= 0;
      const key = "plane:" + p.id, more = this.strong.has(key) ? 0.05 : this.soft.has(key) ? 0.03 : 0;
      p.fill.opacity = (front ? FILL_FRONT : FILL_BACK) + more;
    }
    if (!this.labels.size) return;
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion), camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const right = new THREE.Vector3(), up = new THREE.Vector3(), n = new THREE.Vector3(), at = new THREE.Vector3();
    const px = this.viewport.pixelSize();
    for (const l of this.labels.values()) {
      this.toCamera(l.centre, to);
      const facing = Math.abs(l.normal.dot(to));
      // edge-on, the rectangle is a sliver and its name a smear
      const alpha = l.visible ? Math.max(0, Math.min(1, (facing - 0.12) / 0.22)) : 0;
      if (alpha <= 0.01) { l.mesh.visible = false; l.opacity = 0; continue; }
      // Seen from the side its own normal (x × y) points to, the text runs along +x with +y up, or along -x with
      // -y up; from the other side, along +x with -y up or along -x with +y up: never mirrored.  Of the two, the
      // one that is upright on screen — and it stays as it is until the other is clearly the better.
      const side = n.crossVectors(l.x, l.y).dot(to) >= 0 ? 1 : -1;
      const score = (sx: number) => { const sy = sx * side; const u = l.y.dot(camUp) * sy, r = l.x.dot(camRight) * sx; return u * 2 + r; };
      let sx = l.sx * l.sy === side ? l.sx : 0;
      if (sx === 0) sx = score(1) >= score(-1) ? 1 : -1;
      else if (score(-sx) > score(sx) + 0.25) sx = -sx;
      const sy = sx * side;
      l.sx = sx; l.sy = sy;
      right.copy(l.x).multiplyScalar(sx); up.copy(l.y).multiplyScalar(sy); n.crossVectors(right, up);
      const side2 = Math.min(l.hx, l.hy) * 2;
      const height = Math.min(side2 * LABEL_MOST, Math.max(LABEL_MIN_PX * px, Math.min(LABEL_MAX_PX * px, side2 * LABEL_SHARE)));
      const h = height * 1.3, w = h * l.aspect, inset = height * LABEL_INSET;
      // inside the corner that is at the top left as the text reads
      at.copy(l.centre).addScaledVector(right, -l.hx + inset + w / 2).addScaledVector(up, l.hy - inset - h / 2);
      l.mesh.matrix.makeBasis(right.clone().multiplyScalar(w), up.clone().multiplyScalar(h), n).setPosition(at);
      l.mesh.matrixWorldNeedsUpdate = true;
      l.mesh.visible = true;
      l.opacity = Math.round(alpha * (this.strong.has(l.key) || this.soft.has(l.key) ? 1 : 0.9) * 100) / 100;
      l.material.opacity = l.opacity;
    }
  };
}
