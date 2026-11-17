// modelview.ts — a part studio in the 3D viewport: bodies with their edges, the default planes and origin,
// sketches, hover and selection highlighting, and picking of faces, edges and vertices by their stable names.
//
// It draws what it is given and reports what the pointer is over; it holds no document state.  The part studio
// controller (ui/studio.ts) feeds it regeneration results and listens to `onPick` / `onHover`.
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { tokenColor, type Viewport3D } from "../../../shared/viewport3d/viewport3d";
import { DEFAULT_PLANES, toPlane, type DefaultPlaneId, type Frame, type Vec2, type Vec3 } from "../core/geometry";
import type { BodyResult, SketchView } from "../kernel/protocol";

/** Something in the viewport that can be hovered or selected. */
export type Pick =
  | { kind: "face" | "edge" | "vertex"; body: string; name: string; point: Vec3 }
  | { kind: "plane"; plane: DefaultPlaneId; point: Vec3 }
  | { kind: "sketch"; featureId: string; entity: string | null; region: string | null; point: Vec3 };

export const pickKey = (p: Pick): string => (p.kind === "plane" ? `plane:${p.plane}` : p.kind === "sketch" ? `sketch:${p.featureId}:${p.entity || ""}:${p.region || ""}` : `${p.kind}:${p.body}:${p.name}`);

export type PickKind = Pick["kind"];

interface BodyObjects { rev: number; group: THREE.Group; mesh: THREE.Mesh; edges: THREE.LineSegments; points: THREE.Points; result: BodyResult }
interface SketchObjects { group: THREE.Group; view: SketchView; lines: LineSegments2; fills: THREE.Mesh[] }

const PLANE_SIZE = 60;

export class ModelView {
  private readonly root = new THREE.Group();
  private readonly planes = new THREE.Group();
  private readonly highlight = new THREE.Group();
  private readonly overlay = new THREE.Group();
  private readonly bodies = new Map<string, BodyObjects>();
  private readonly sketches = new Map<string, SketchObjects>();
  private readonly raycaster = new THREE.Raycaster();
  private colors = { body: new THREE.Color(), edge: new THREE.Color(), hover: new THREE.Color(), select: new THREE.Color(), sketch: new THREE.Color(), plane: new THREE.Color(), dim: new THREE.Color() };
  private bodyMaterial = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  private edgeMaterial = new THREE.LineBasicMaterial();
  private pointMaterial = new THREE.PointsMaterial({ size: 1, sizeAttenuation: false, transparent: true, opacity: 0 });
  private fat: LineMaterial[] = [];
  private hover: Pick | null = null;
  private selection: Pick[] = [];
  private filter: Set<PickKind> | null = null;
  private activeSketch: string | null = null;
  private hiddenSketch: string | null = null;
  /** The pointer moved onto something else (or nothing). */
  onHover: (pick: Pick | null) => void = () => {};
  /** A left click, with what was under it. */
  onPick: (pick: Pick | null, ev: PointerEvent) => void = () => {};
  /** While set, left-button pointer events go here instead of picking (a sketch tool is drawing). */
  pointerTool: { down?(ev: PointerEvent): void; move?(ev: PointerEvent): void; up?(ev: PointerEvent): void } | null = null;
  private downAt: { x: number; y: number } | null = null;

  constructor(readonly viewport: Viewport3D) {
    viewport.scene.add(this.root, this.planes, this.highlight, this.overlay);
    this.buildPlanes();
    viewport.onTheme.push(() => this.readColors());
    viewport.onFrame.push(() => { for (const m of this.fat) m.resolution.set(viewport.width, viewport.height); });
    this.readColors();
    const c = viewport.canvas;
    c.addEventListener("pointermove", this.onMove);
    c.addEventListener("pointerdown", this.onDown);
    c.addEventListener("pointerup", this.onUp);
    c.addEventListener("pointerleave", () => this.setHover(null, true));
  }

  private fatMaterial(color: THREE.Color, width: number, o: Partial<{ dashed: boolean; depthTest: boolean }> = {}): LineMaterial {
    const m = new LineMaterial({ color: color.getHex(), linewidth: width, dashed: !!o.dashed, dashSize: 2, gapSize: 1.5, depthTest: o.depthTest !== false, transparent: true });
    m.resolution.set(this.viewport.width, this.viewport.height);
    this.fat.push(m);
    return m;
  }

  private readColors(): void {
    const ink = tokenColor("--ink"), paper = tokenColor("--paper");
    this.colors.body.copy(paper).lerp(ink, 0.22);
    this.colors.edge.copy(ink);
    // --mark is the theme's colour for annotations on a canvas; the chrome's own selection colour is a neutral
    // that would not show on a grey solid
    this.colors.select.copy(tokenColor("--mark"));
    this.colors.hover.copy(this.colors.select).lerp(this.colors.body, 0.45);
    this.colors.sketch.copy(tokenColor("--ink-2"));
    this.colors.plane.copy(tokenColor("--ink-3"));
    this.colors.dim.copy(ink).lerp(paper, 0.6);
    this.bodyMaterial.color.copy(this.colors.body);
    this.edgeMaterial.color.copy(this.colors.edge);
    this.planes.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material & { color?: THREE.Color }; if (m && m.color) m.color.copy(this.colors.plane); });
    for (const s of this.sketches.values()) this.styleSketch(s);
    this.drawHighlight();
  }

  // ---------------------------------------------------------------- default planes and origin
  private buildPlanes(): void {
    for (const id of Object.keys(DEFAULT_PLANES) as DefaultPlaneId[]) {
      const f = DEFAULT_PLANES[id].frame, s = PLANE_SIZE / 2;
      const corner = (u: number, v: number) => new THREE.Vector3(f.origin[0] + u * f.x[0] + v * f.y[0], f.origin[1] + u * f.x[1] + v * f.y[1], f.origin[2] + u * f.x[2] + v * f.y[2]);
      const pts = [corner(-s, -s), corner(s, -s), corner(s, s), corner(-s, s)];
      const g = new THREE.BufferGeometry().setFromPoints(pts); g.setIndex([0, 1, 2, 0, 2, 3]);
      const quad = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }));
      quad.userData.plane = id;
      const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 }));
      this.planes.add(quad, outline);
    }
    const dot = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]), new THREE.PointsMaterial({ size: 6, sizeAttenuation: false }));
    this.planes.add(dot);
  }
  setPlanesVisible(on: boolean): void { this.planes.visible = on; this.viewport.invalidate(); }

  // ---------------------------------------------------------------- bodies
  /** Show these bodies (the result of a regeneration).  A body whose revision is unchanged is left as it is. */
  setBodies(results: readonly BodyResult[]): void {
    const seen = new Set<string>();
    for (const r of results) {
      seen.add(r.id);
      const old = this.bodies.get(r.id);
      if (old && old.rev === r.rev) { old.result = r; continue; }
      if (old) this.removeBody(old);
      if (!r.mesh) continue;
      const m = r.mesh;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
      g.setIndex(new THREE.BufferAttribute(m.indices, 1));
      g.computeBoundingBox(); g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this.bodyMaterial);
      mesh.userData.fit = true;
      const eg = new THREE.BufferGeometry(); eg.setAttribute("position", new THREE.BufferAttribute(m.edges.positions, 3));
      const edges = new THREE.LineSegments(eg, this.edgeMaterial);
      const pg = new THREE.BufferGeometry(); pg.setAttribute("position", new THREE.BufferAttribute(m.vertices.positions, 3));
      const points = new THREE.Points(pg, this.pointMaterial);
      const group = new THREE.Group(); group.add(mesh, edges, points);
      this.root.add(group);
      this.bodies.set(r.id, { rev: r.rev, group, mesh, edges, points, result: r });
    }
    for (const [id, b] of Array.from(this.bodies)) if (!seen.has(id)) { this.removeBody(b); this.bodies.delete(id); }
    this.drawHighlight();
    this.viewport.invalidate();
  }
  private removeBody(b: BodyObjects): void {
    this.root.remove(b.group);
    b.mesh.geometry.dispose(); b.edges.geometry.dispose(); b.points.geometry.dispose();
  }
  /** True when at least one body is on screen. */
  get hasBodies(): boolean { return this.bodies.size > 0; }

  // ---------------------------------------------------------------- sketches
  /** Show these sketches.  `active` is the one being edited: it is drawn stronger and its regions are filled. */
  setSketches(views: readonly SketchView[], visible: ReadonlySet<string>, active: string | null): void {
    this.activeSketch = active;
    for (const s of this.sketches.values()) { this.root.remove(s.group); s.lines.geometry.dispose(); for (const f of s.fills) f.geometry.dispose(); }
    this.sketches.clear();
    for (const v of views) {
      if (!visible.has(v.featureId) && v.featureId !== active) continue;
      const group = new THREE.Group();
      const seg: number[] = [];
      for (const c of v.curves) for (let i = 0; i + 5 < c.points.length; i += 3) seg.push(c.points[i], c.points[i + 1], c.points[i + 2], c.points[i + 3], c.points[i + 4], c.points[i + 5]);
      const lg = new LineSegmentsGeometry(); lg.setPositions(seg.length ? seg : [0, 0, 0, 0, 0, 0]);
      const lines = new LineSegments2(lg, this.fatMaterial(this.colors.sketch, 1.5, { depthTest: false }));
      lines.renderOrder = 5; lines.visible = seg.length > 0;
      lines.userData.fit = seg.length > 0;
      group.add(lines);
      const fills: THREE.Mesh[] = [];
      for (const r of v.regions) {
        const shape = new THREE.Shape(pairs(r.outer).map(([x, y]) => new THREE.Vector2(x, y)));
        for (const h of r.holes) shape.holes.push(new THREE.Path(pairs(h).map(([x, y]) => new THREE.Vector2(x, y))));
        const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
        fill.applyMatrix4(frameMatrix(v.frame));
        fill.userData.region = r.id;
        fills.push(fill); group.add(fill);
      }
      group.visible = v.featureId !== this.hiddenSketch;
      this.root.add(group);
      const s: SketchObjects = { group, view: v, lines, fills };
      this.sketches.set(v.featureId, s);
      this.styleSketch(s);
    }
    this.drawHighlight();
    this.viewport.invalidate();
  }
  private styleSketch(s: SketchObjects): void {
    const active = s.view.featureId === this.activeSketch;
    (s.lines.material as LineMaterial).color.copy(active ? this.colors.edge : this.colors.sketch);
    (s.lines.material as LineMaterial).linewidth = active ? 2 : 1.5;
    for (const f of s.fills) (f.material as THREE.MeshBasicMaterial).color.copy(this.colors.edge);
  }
  /**
   * Keep a sketch but do not draw it (null: draw them all).  The sketch editor draws the open sketch itself
   * (sketch/paint.ts), so that it follows a drag without waiting for the worker; its frame is still answered.
   */
  setSketchHidden(featureId: string | null): void {
    this.hiddenSketch = featureId;
    for (const s of this.sketches.values()) s.group.visible = s.view.featureId !== featureId;
    this.viewport.invalidate();
  }
  /** The frame of a sketch on screen, or null. */
  sketchFrame(featureId: string): Frame | null { return this.sketches.get(featureId)?.view.frame || null; }

  // ---------------------------------------------------------------- hover and selection
  /** Restrict picking to these kinds (null: everything). */
  setFilter(kinds: readonly PickKind[] | null): void { this.filter = kinds ? new Set(kinds) : null; }
  setSelection(picks: readonly Pick[]): void { this.selection = picks.slice(); this.drawHighlight(); }
  private setHover(p: Pick | null, tell: boolean): void {
    if ((p ? pickKey(p) : "") === (this.hover ? pickKey(this.hover) : "")) return;
    this.hover = p; this.drawHighlight();
    if (tell) this.onHover(p);
  }

  private drawHighlight(): void {
    for (const o of this.highlight.children.slice()) { this.highlight.remove(o); const m = o as THREE.Mesh; if (m.userData.own) m.geometry.dispose(); }
    const selected = new Set(this.selection.map(pickKey));
    const draw = (p: Pick, color: THREE.Color, strong: boolean) => {
      if (p.kind === "plane") {
        const quad = this.planes.children.find((o) => o.userData.plane === p.plane) as THREE.Mesh | undefined;
        if (quad) { const m = new THREE.Mesh(quad.geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: strong ? 0.3 : 0.18, side: THREE.DoubleSide, depthWrite: false })); this.highlight.add(m); }
        return;
      }
      if (p.kind === "sketch") {
        const s = this.sketches.get(p.featureId); if (!s) return;
        if (p.region) { const f = s.fills.find((x) => x.userData.region === p.region); if (f) { const m = new THREE.Mesh(f.geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: strong ? 0.45 : 0.3, side: THREE.DoubleSide, depthWrite: false, depthTest: false })); m.position.copy(f.position); m.quaternion.copy(f.quaternion); m.scale.copy(f.scale); this.highlight.add(m); } }
        const c = p.entity ? s.view.curves.find((x) => x.entity === p.entity) : null;
        if (c) this.addFat(Array.from(polylineSegments(c.points)), color, 3.5);
        const pt = p.entity ? s.view.points.find((x) => x.entity === p.entity) : null;
        if (pt) this.addDot(pt.position, color);
        return;
      }
      const b = this.bodies.get(p.body); if (!b || !b.result.mesh) return;
      const mesh = b.result.mesh;
      if (p.kind === "face") {
        const i = mesh.faces.names.indexOf(p.name); if (i < 0) return;
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", b.mesh.geometry.getAttribute("position"));
        g.setIndex(b.mesh.geometry.getIndex());
        g.setDrawRange(mesh.faces.start[i], mesh.faces.count[i]);
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: strong ? 0.6 : 0.4, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
        this.highlight.add(m);
      } else if (p.kind === "edge") {
        const i = mesh.edges.names.indexOf(p.name); if (i < 0) return;
        this.addFat(Array.from(mesh.edges.positions.subarray(mesh.edges.start[i] * 3, (mesh.edges.start[i] + mesh.edges.count[i]) * 3)), color, 4);
      } else {
        const i = mesh.vertices.names.indexOf(p.name); if (i < 0) return;
        this.addDot([mesh.vertices.positions[i * 3], mesh.vertices.positions[i * 3 + 1], mesh.vertices.positions[i * 3 + 2]], color);
      }
    };
    for (const p of this.selection) draw(p, this.colors.select, true);
    if (this.hover && !selected.has(pickKey(this.hover))) draw(this.hover, this.colors.hover, false);
    this.viewport.invalidate();
  }
  private addFat(segments: number[], color: THREE.Color, width: number): void {
    if (segments.length < 6) return;
    const g = new LineSegmentsGeometry(); g.setPositions(segments);
    const l = new LineSegments2(g, this.fatMaterial(color, width, { depthTest: false }));
    l.renderOrder = 10; l.userData.own = true;
    this.highlight.add(l);
  }
  private addDot(at: Vec3, color: THREE.Color): void {
    const p = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...at)]), new THREE.PointsMaterial({ color, size: 9, sizeAttenuation: false, depthTest: false }));
    p.renderOrder = 11; p.userData.own = true;
    this.highlight.add(p);
  }

  /** Lines drawn over everything, in model space, as point pairs: a tool's rubber band.  Null clears them. */
  setOverlay(segments: number[] | null, dots: Vec3[] = []): void {
    for (const o of this.overlay.children.slice()) { this.overlay.remove(o); (o as THREE.Mesh).geometry.dispose(); }
    if (segments && segments.length >= 6) {
      const g = new LineSegmentsGeometry(); g.setPositions(segments);
      const l = new LineSegments2(g, this.fatMaterial(this.colors.select, 2, { depthTest: false })); l.renderOrder = 12;
      this.overlay.add(l);
    }
    for (const d of dots) { const p = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...d)]), new THREE.PointsMaterial({ color: this.colors.select, size: 8, sizeAttenuation: false, depthTest: false })); p.renderOrder = 13; this.overlay.add(p); }
    this.viewport.invalidate();
  }

  // ---------------------------------------------------------------- picking
  /** What is under the pointer: a vertex before an edge before a face, a body before a sketch before a plane. */
  pick(ev: { clientX: number; clientY: number }): Pick | null {
    const ray = this.viewport.ray(ev), px = this.viewport.pixelSize();
    const rc = this.raycaster; rc.ray.copy(ray); rc.near = 0; rc.far = Infinity;
    const want = (k: PickKind) => !this.filter || this.filter.has(k);
    const at = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
    let best: { pick: Pick; d: number } | null = null;
    const offer = (pick: Pick, d: number, bias: number) => { if (!best || d - bias < best.d) best = { pick, d: d - bias }; };

    let faceD = Infinity;
    for (const [id, b] of this.bodies) {
      const mesh = b.result.mesh; if (!mesh) continue;
      const hit = rc.intersectObject(b.mesh, false)[0];
      if (hit && hit.faceIndex != null) {
        faceD = Math.min(faceD, hit.distance);
        const i = rangeOf(mesh.faces.start, mesh.faces.count, hit.faceIndex * 3);
        if (i >= 0 && want("face")) offer({ kind: "face", body: id, name: mesh.faces.names[i], point: at(hit.point) }, hit.distance, 0);
      }
    }
    // edges and vertices win over the face behind them when the pointer is within a few pixels, unless hidden by a nearer face
    const slack = 6 * px;
    for (const [id, b] of this.bodies) {
      const mesh = b.result.mesh; if (!mesh) continue;
      if (want("edge")) {
        rc.params.Line = { threshold: 5 * px };
        const hit = rc.intersectObject(b.edges, false).sort((p, q) => (p.distanceToRay ?? 0) - (q.distanceToRay ?? 0))[0];
        if (hit && hit.index != null && hit.distance <= faceD + slack) {
          const i = rangeOf(mesh.edges.start, mesh.edges.count, hit.index);
          if (i >= 0) offer({ kind: "edge", body: id, name: mesh.edges.names[i], point: at(hit.point) }, hit.distance, 1e4);
        }
      }
      if (want("vertex")) {
        rc.params.Points = { threshold: 6 * px };
        const hit = rc.intersectObject(b.points, false).sort((p, q) => (p.distanceToRay ?? 0) - (q.distanceToRay ?? 0))[0];
        if (hit && hit.index != null && hit.distance <= faceD + slack) offer({ kind: "vertex", body: id, name: mesh.vertices.names[hit.index], point: at(hit.point) }, hit.distance, 2e4);
      }
    }
    if (best) return (best as { pick: Pick }).pick;

    if (want("sketch")) {
      let found: { pick: Pick; d: number } | null = null;
      for (const [id, s] of this.sketches) {
        const p2 = this.planePoint(ev, s.view.frame); if (!p2) continue;
        const w = new THREE.Vector3(...worldOf(s.view.frame, p2));
        let entity: string | null = null, near = 6 * px;
        for (const c of s.view.curves) { const d = distanceToPolyline(w, c.points); if (d < near) { near = d; entity = c.entity; } }
        for (const pt of s.view.points) { const d = w.distanceTo(new THREE.Vector3(...pt.position)); if (d < 7 * px) { near = -1; entity = pt.entity; } }
        let region: string | null = null;
        if (!entity) for (const r of s.view.regions) if (inside(p2, r.outer) && !r.holes.some((h) => inside(p2, h))) region = r.id;
        if (entity || region) { const d = ray.origin.distanceTo(w); if (!found || d < found.d) found = { pick: { kind: "sketch", featureId: id, entity, region, point: at(w) }, d }; }
      }
      if (found) return (found as { pick: Pick }).pick;
    }
    if (want("plane") && this.planes.visible) {
      const hit = rc.intersectObjects(this.planes.children.filter((o) => o.userData.plane), false)[0];
      if (hit) return { kind: "plane", plane: hit.object.userData.plane, point: at(hit.point) };
    }
    return null;
  }

  /** Where the pointer's ray meets a sketch plane, in the plane's own coordinates; null when it runs along it. */
  planePoint(ev: { clientX: number; clientY: number }, frame: Frame): Vec2 | null {
    const ray = this.viewport.ray(ev);
    const n = new THREE.Vector3(...frame.normal), o = new THREE.Vector3(...frame.origin);
    const denom = ray.direction.dot(n);
    if (Math.abs(denom) < 1e-9) return null;
    const t = o.clone().sub(ray.origin).dot(n) / denom;
    const p = ray.origin.clone().addScaledVector(ray.direction, t);
    return toPlane(frame, [p.x, p.y, p.z]);
  }

  private onMove = (ev: PointerEvent): void => {
    if (this.viewport.navigating) return;
    if (this.pointerTool) { this.pointerTool.move?.(ev); return; }
    this.setHover(this.pick(ev), true);
  };
  private onDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    this.viewport.canvas.focus();
    if (this.pointerTool) { this.pointerTool.down?.(ev); return; }
    this.downAt = { x: ev.clientX, y: ev.clientY };
  };
  private onUp = (ev: PointerEvent): void => {
    if (ev.button !== 0) return;
    if (this.pointerTool) { this.pointerTool.up?.(ev); return; }
    const d = this.downAt; this.downAt = null;
    if (d && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 5) this.onPick(this.pick(ev), ev);
  };

  dispose(): void {
    const c = this.viewport.canvas;
    c.removeEventListener("pointermove", this.onMove); c.removeEventListener("pointerdown", this.onDown); c.removeEventListener("pointerup", this.onUp);
    this.viewport.scene.remove(this.root, this.planes, this.highlight, this.overlay);
  }
}

// ---------------------------------------------------------------- small geometry helpers
function pairs(a: Float32Array): Vec2[] { const out: Vec2[] = []; for (let i = 0; i + 1 < a.length; i += 2) out.push([a[i], a[i + 1]]); return out; }
function* polylineSegments(p: Float32Array): Generator<number> { for (let i = 0; i + 5 < p.length; i += 3) { yield p[i]; yield p[i + 1]; yield p[i + 2]; yield p[i + 3]; yield p[i + 4]; yield p[i + 5]; } }
function worldOf(f: Frame, p: Vec2): Vec3 { return [f.origin[0] + p[0] * f.x[0] + p[1] * f.y[0], f.origin[1] + p[0] * f.x[1] + p[1] * f.y[1], f.origin[2] + p[0] * f.x[2] + p[1] * f.y[2]]; }
function frameMatrix(f: Frame): THREE.Matrix4 {
  return new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.x), new THREE.Vector3(...f.y), new THREE.Vector3(...f.normal)).setPosition(new THREE.Vector3(...f.origin));
}
/** The index of the range [start[i], start[i] + count[i]) that holds `at`, or -1. */
function rangeOf(start: Uint32Array, count: Uint32Array, at: number): number {
  for (let i = 0; i < start.length; i++) if (at >= start[i] && at < start[i] + count[i]) return i;
  return -1;
}
function distanceToPolyline(p: THREE.Vector3, pts: Float32Array): number {
  let best = Infinity;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), line = new THREE.Line3(), c = new THREE.Vector3();
  for (let i = 0; i + 5 < pts.length; i += 3) {
    a.set(pts[i], pts[i + 1], pts[i + 2]); b.set(pts[i + 3], pts[i + 4], pts[i + 5]);
    line.set(a, b).closestPointToPoint(p, true, c);
    best = Math.min(best, c.distanceTo(p));
  }
  return best;
}
function inside(p: Vec2, poly: Float32Array): boolean {
  let inn = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const ax = poly[i], ay = poly[i + 1], bx = poly[j], by = poly[j + 1];
    if ((ay > p[1]) !== (by > p[1]) && p[0] < ((bx - ax) * (p[1] - ay)) / (by - ay) + ax) inn = !inn;
  }
  return inn;
}
