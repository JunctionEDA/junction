// thumbnail.ts — the part studio's picture for the project page, the project's card and the document tabs.
//
// Drawn here, from the bodies the kernel built, into a small off-screen scene of its own: an isometric view
// framed on the part, on the paper colour, lit and coloured as the viewport's studio (shared/viewport3d/look.ts),
// without the planes, sketches and selection the viewport shows.  It
// uses the viewport's WebGL context (a second context per tab would be wasteful), renders into a render target
// and leaves the viewport's own picture untouched.  Sent through web/platform/documents/thumbnail.ts, shortly
// after the model settles; only by someone who may edit, and never while an earlier version is on screen.
import * as THREE from "three";
import { THUMB_LONG_SIDE, ThumbnailPusher } from "../../platform/documents/thumbnail";
import { edgeColor, edgeLineMaterial, lightAsStudio, partColor, shadeEdges, studioSurface } from "../../shared/viewport3d/look";
import { tokenColor } from "../../shared/viewport3d/viewport3d";
import type { BodyResult } from "./kernel/protocol";
import type { PartStudio } from "./ui/studio";

const W = THUMB_LONG_SIDE, H = Math.round(THUMB_LONG_SIDE * 0.625);

/** Draw the bodies into a canvas of the thumbnail's size.  Null when there is nothing to draw. */
export function drawThumbnail(renderer: THREE.WebGLRenderer, bodies: readonly BodyResult[]): HTMLCanvasElement | null {
  const meshes = bodies.filter((b) => b.mesh && b.mesh.indices.length);
  if (!meshes.length) return null;
  const scene = new THREE.Scene();
  const paper = tokenColor("--paper"), dark = paper.getHSL({ h: 0, s: 0, l: 0 }).l < 0.5;
  scene.background = paper;
  const dir = new THREE.Vector3(-1, 1, -1).normalize(), up = new THREE.Vector3(0, 0, 1);
  // each part in the colour the viewport tells it apart by
  const materials: THREE.Material[] = [];
  const surface = (i: number): THREE.Material => {
    const m = studioSurface(new THREE.MeshStandardMaterial({ color: partColor(i, dark), side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    materials.push(m);
    return m;
  };
  const edgeMaterial = edgeLineMaterial({ color: edgeColor(dark) });
  const made: THREE.BufferGeometry[] = [];
  const box = new THREE.Box3();
  let part = 0;
  for (const b of meshes) {
    const m = b.mesh!;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    const eg = new THREE.BufferGeometry(); eg.setAttribute("position", new THREE.BufferAttribute(m.edges.positions, 3));
    shadeEdges(eg, m);
    scene.add(new THREE.Mesh(g, surface(b.reference ? 0 : part++)), new THREE.LineSegments(eg, edgeMaterial));
    made.push(g, eg);
    box.union(new THREE.Box3(new THREE.Vector3(m.bbox[0], m.bbox[1], m.bbox[2]), new THREE.Vector3(m.bbox[3], m.bbox[4], m.bbox[5])));
  }
  const sphere = box.getBoundingSphere(new THREE.Sphere()), r = Math.max(sphere.radius, 1e-3);
  // frame the box as it looks from the camera, not its bounding sphere: a flat plate would be a speck in it
  const right = new THREE.Vector3().crossVectors(dir, up).normalize(), above = new THREE.Vector3().crossVectors(right, dir);
  let halfW = 1e-3, halfH = 1e-3;
  for (let i = 0; i < 8; i++) {
    const c = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(sphere.center);
    halfW = Math.max(halfW, Math.abs(c.dot(right))); halfH = Math.max(halfH, Math.abs(c.dot(above)));
  }
  const aspect = W / H, half = Math.max(halfH, halfW / aspect) * 1.12;
  const camera = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, -r * 10, r * 10);
  camera.up.copy(up); camera.position.copy(sphere.center).addScaledVector(dir, -r * 2); camera.lookAt(sphere.center); camera.updateProjectionMatrix();
  lightAsStudio(scene, renderer, camera, sphere.center, r);

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
    target.dispose(); edgeMaterial.dispose();
    for (const m of materials) m.dispose();
    for (const g of made) g.dispose();
  }
  // the target's rows run bottom-up
  const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
  const c2 = canvas.getContext("2d"); if (!c2) return null;
  const image = c2.createImageData(W, H);
  for (let y = 0; y < H; y++) image.data.set(pixels.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  c2.putImageData(image, 0, 0);
  return canvas;
}

/** Keep the part studio's picture on the server current while it is open.  Returns what stops it. */
export function attachThumbnail(studio: PartStudio): () => void {
  let revs = "";
  const pusher = new ThumbnailPusher(
    studio.host.doc.docId,
    () => {
      const s = studio.getState();
      if (!s.status.canEdit || s.past || s.editing || s.sketch || s.kernel.working) return null;
      const canvas = drawThumbnail(studio.viewport.renderer, s.bodies);
      studio.viewport.invalidate();          // the render target shared the viewport's context: draw its frame again
      return canvas;
    },
    () => revs,
  );
  const off = studio.subscribe(() => {
    const s = studio.getState();
    if (s.past || !s.status.canEdit) return;
    const now = s.bodies.map((b) => b.rev).join(",");
    if (now !== revs) { revs = now; if (s.bodies.length) pusher.dirty(); }
  });
  (studio as unknown as { thumbnail?: ThumbnailPusher }).thumbnail = pusher;   // for tests: `await studio.thumbnail.send()`
  return () => { off(); pusher.stop(); };
}
