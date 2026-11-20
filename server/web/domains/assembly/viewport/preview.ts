// preview.ts — the small picture of a part, a studio or a board in the Insert dialog.
//
// Drawn from the same meshes the instances are drawn from (the source's pieces), shaded as the viewport shades
// parts, from the viewport's Iso direction and framed on what is drawn.  It borrows the assembly viewport's WebGL
// context (a second context per tab would be wasteful): a render target, read back, the viewport's own state put
// back and its frame drawn again.  A picture is kept per subject, its meshes and the theme, so pointing at a row
// again costs nothing; the meshes are a source's own objects, so a rebuilt part is drawn anew.
import * as THREE from "three";
import { tokenColor, type Viewport3D } from "../../../shared/viewport3d/viewport3d";
import type { BodyMesh } from "../../mechanical/api";
import type { SourcePiece } from "../sources/types";
import { matrixOf } from "./scene";

const KEEP = 48;
const themeStamp = (): string => { const st = getComputedStyle(document.documentElement); return st.getPropertyValue("--paper").trim() + "|" + st.getPropertyValue("--ink").trim(); };

export class PreviewPictures {
  private readonly cache = new Map<string, { meshes: BodyMesh[]; image: ImageData }>();
  constructor(private readonly viewport: Viewport3D) {}

  /** The picture of these pieces at `width` × `height` device pixels, or null when there is nothing to draw. */
  picture(key: string, pieces: readonly SourcePiece[], width: number, height: number): ImageData | null {
    const drawn = pieces.filter((p) => p.mesh.indices.length);
    if (!drawn.length || width < 8 || height < 8) return null;
    const k = `${key}|${width}x${height}|${themeStamp()}`;
    const meshes = drawn.map((p) => p.mesh);
    const hit = this.cache.get(k);
    if (hit && hit.meshes.length === meshes.length && hit.meshes.every((m, i) => m === meshes[i])) { this.cache.delete(k); this.cache.set(k, hit); return hit.image; }
    const image = this.draw(drawn, width, height);
    if (!image) return null;
    this.cache.delete(k); this.cache.set(k, { meshes, image });
    while (this.cache.size > KEEP) this.cache.delete(this.cache.keys().next().value as string);
    return image;
  }

  private draw(pieces: readonly SourcePiece[], W: number, H: number): ImageData | null {
    const renderer = this.viewport.renderer;
    const ink = tokenColor("--ink"), paper = tokenColor("--paper");
    const scene = new THREE.Scene();
    scene.background = paper.clone();
    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const material = new THREE.MeshStandardMaterial({ color: paper.clone().lerp(ink, 0.22), roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const edgeMaterial = new THREE.LineBasicMaterial({ color: ink.clone().lerp(paper, 0.15) });
    const made: THREE.BufferGeometry[] = [];
    const box = new THREE.Box3(), corner = new THREE.Vector3();
    for (const p of pieces) {
      const m = p.mesh, place = p.transform ? matrixOf(p.transform) : new THREE.Matrix4();
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
      g.setIndex(new THREE.BufferAttribute(m.indices, 1));
      const eg = new THREE.BufferGeometry(); eg.setAttribute("position", new THREE.BufferAttribute(m.edges.positions, 3));
      const group = new THREE.Group(); group.matrixAutoUpdate = false; group.matrix.copy(place);
      group.add(new THREE.Mesh(g, material), new THREE.LineSegments(eg, edgeMaterial));
      scene.add(group);
      made.push(g, eg);
      const b = m.bbox;
      for (let c = 0; c < 8; c++) box.expandByPoint(corner.set(c & 1 ? b[3] : b[0], c & 2 ? b[4] : b[1], c & 4 ? b[5] : b[2]).applyMatrix4(place));
    }
    scene.updateMatrixWorld(true);
    // from the front right, above (the viewport's Iso), framed on the box as it looks from there
    const dir = new THREE.Vector3(-1, 1, -1).normalize(), up = new THREE.Vector3(0, 0, 1);
    const sphere = box.getBoundingSphere(new THREE.Sphere()), r = Math.max(sphere.radius, 1e-3);
    const right = new THREE.Vector3().crossVectors(dir, up).normalize(), above = new THREE.Vector3().crossVectors(right, dir);
    let halfW = 1e-3, halfH = 1e-3;
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(sphere.center);
      halfW = Math.max(halfW, Math.abs(c.dot(right))); halfH = Math.max(halfH, Math.abs(c.dot(above)));
    }
    const aspect = W / H, half = Math.max(halfH, halfW / aspect) * 1.15;
    const camera = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, -r * 10, r * 10);
    camera.up.copy(up); camera.position.copy(sphere.center).addScaledVector(dir, -r * 2); camera.lookAt(sphere.center); camera.updateProjectionMatrix();
    const light = new THREE.DirectionalLight(0xffffff, 2.2);
    light.position.copy(camera.position).addScaledVector(new THREE.Vector3(0.4, 0.3, 1), r); light.target.position.copy(sphere.center);
    scene.add(light, light.target);

    const target = new THREE.WebGLRenderTarget(W, H, { samples: 4, colorSpace: THREE.SRGBColorSpace });
    const pixels = new Uint8Array(W * H * 4);
    const was = { target: renderer.getRenderTarget(), viewport: renderer.getViewport(new THREE.Vector4()), scissorTest: renderer.getScissorTest() };
    try {
      renderer.setRenderTarget(target);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, W, H);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, W, H, pixels);
    } finally {
      renderer.setRenderTarget(was.target); renderer.setViewport(was.viewport); renderer.setScissorTest(was.scissorTest);
      target.dispose(); material.dispose(); edgeMaterial.dispose();
      for (const g of made) g.dispose();
      this.viewport.invalidate();          // the render target shared the viewport's context: draw its frame again
    }
    // the target's rows run bottom-up
    const image = new ImageData(W, H);
    for (let y = 0; y < H; y++) image.data.set(pixels.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    return image;
  }

  dispose(): void { this.cache.clear(); }
}
