// engine.ts — the render engine: a scene of plain triangles and physical surfaces, path traced on the graphics
// card into a canvas, a little more each animation frame.
//
// The tracing itself is three-gpu-pathtracer (Garrett Johnson, MIT) over three-mesh-bvh: an unbiased path tracer
// in a fragment shader, with multiple importance sampling of the surface and of the environment, the full
// glTF physical material (metals, rough and clear dielectrics that refract and absorb, clearcoat, sheen,
// emission) and a thin-lens camera.  What is added here:
//
//   the scene      built from the editor's arrays, turned Y up and scaled so the model is one unit in radius
//                  (the tracer's ray offsets and the lens are in scene units), standing on a ground
//   the ground     a shadow catcher or a glossy floor that fades into the backdrop (shaders.ts)
//   the lights     the environments of environments.ts as an HDR panorama, turned with the view or left fixed
//   the denoiser   guide buffers and an edge-avoiding À-trous filter (shaders.ts)
//   the picture    exposure, AgX or ACES, sRGB and a dither, in one pass to the canvas (tonemap.ts)
//   stills         any size, traced a tile at a time so the graphics memory in use does not grow with it
//
// Nothing here knows of parts, assemblies or the editor: shared/render/api.ts is the whole contract.
import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { PhysicalCamera, WebGLPathTracer } from "three-gpu-pathtracer";
import { MAX_TRIANGLES, type RenderEngine, type RenderProgress, type RenderScene, type RenderSupport, type StillOptions } from "../api";
import { buildEnvironment, environmentSpec, type EnvironmentImage } from "../environments";
import type { PhysicalSurface } from "../materials";
import { DEFAULT_SETTINGS, qualityOf, type RenderSettings } from "../settings";
import { exposureScale, sceneColorFor } from "../tonemap";
import { cameraPosition, rotate, type RenderCamera, type Vec3 } from "../turntable";
import { ATROUS_FRAGMENT, DESPECKLE_FRAGMENT, MOMENTS_FRAGMENT, DISPLAY_FRAGMENT, FULLSCREEN_VERTEX, GUIDE_FRAGMENT, GUIDE_SUM_FRAGMENT, GUIDE_SUM_VERTEX, GUIDE_VERTEX, patchPathTracer } from "./shaders";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The most pixels the live picture is traced at (each holds about 100 bytes of graphics memory across the targets). */
const LIVE_PIXELS = 1_600_000;
/** A still is traced in tiles no larger than this each way. */
const TILE = 1024;
/** Pixels of overlap round a tile, so the denoiser sees past its edge and no seam shows. */
const TILE_PAD = 24;
/**
 * How far the ground reaches, in model radii: past where it has faded into the backdrop.  It is a grid of small
 * triangles, not two huge ones: where a ray meets a triangle hundreds of units across is not known to the
 * precision a shadow ray leaving that point needs, and the ground would shadow itself in specks.
 */
const GROUND_SIZE = 40;
const GROUND_GRID = 56;
/** The 35 mm film frame's height, millimetres: what an f-number is turned into an aperture with. */
const SENSOR = 24;
/** How many nudged drawings the guides are averaged over. */
const GUIDE_TAPS = 8;

export function support(force = false): RenderSupport {
  const fail = (reason: string, renderer = "", software = false): RenderSupport => ({ ok: false, reason, software, renderer, maxTexture: 0 });
  let gl: WebGL2RenderingContext | null = null;
  try { gl = document.createElement("canvas").getContext("webgl2") as WebGL2RenderingContext | null; } catch { gl = null; }
  if (!gl) return fail("This browser has no WebGL 2, which rendering needs.");
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String((info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || "");
  const software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  const maxTexture = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
  const float = !!gl.getExtension("EXT_color_buffer_float");
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  if (!float) return fail("The graphics driver cannot draw into floating-point textures, which rendering needs.", renderer, software);
  if (software && !force) return fail("Graphics are drawn by the processor here (no graphics card is in use), which is too slow to render with. Turn on hardware acceleration in the browser's settings.", renderer, true);
  return { ok: true, software, renderer, maxTexture };
}

const Y_UP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const surfaceKey = (s: PhysicalSurface): string => JSON.stringify(s);
const yieldNow = (): Promise<void> => new Promise((done) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); done(); }; c.port2.postMessage(0); });
/**
 * Let the page draw a frame (the progress bar, a click on Cancel): a message only yields to other tasks, and
 * the browser may put off painting behind a stream of them.  A hidden tab has no frames: a timer then stands in.
 */
const breathe = (): Promise<void> => new Promise((done) => { let over = false; const end = (): void => { if (!over) { over = true; done(); } }; requestAnimationFrame(() => setTimeout(end, 0)); setTimeout(end, 50); });

interface Camera { pt: THREE.Camera; guide: THREE.Camera; azimuth: number; below: boolean }

export class Engine implements RenderEngine {
  onLost: (() => void) | null = null;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly pt: WebGLPathTracer;
  /** the tracer's own renderer object: its size, its targets, its sample count */
  private readonly inner: any;
  private readonly scene = new THREE.Scene();
  private readonly guideScene = new THREE.Scene();
  private readonly root = new THREE.Group();
  private readonly guideRoot = new THREE.Group();
  private ground: THREE.Mesh | null = null;
  private groundMaterial = new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide });
  private guideGround: THREE.Mesh | null = null;
  private groundIndex = -1;
  private groundY = 0;
  private envTexture: THREE.DataTexture | null = null;
  private envImage: EnvironmentImage | null = null;
  private settings: RenderSettings = { ...DEFAULT_SETTINGS };
  private camera: RenderCamera | null = null;
  private built: Camera | null = null;
  private centre = new THREE.Vector3();
  private scale = 1;
  private triangles = 0;
  private hasScene = false;
  private css = { w: 1, h: 1, ratio: 1 };
  private trace = { w: 0, h: 0 };
  private moving = false;
  private dirty = { camera: true, settings: true, size: true, guides: true };
  private shown = -1;
  private busy = false;
  private lost = false;
  private last = 0;
  private tiles = 2;
  private readonly floatBlend: boolean;

  // the denoiser and the display
  private guideTemp: THREE.WebGLRenderTarget | null = null;
  private guideSum: THREE.WebGLRenderTarget | null = null;
  private ping: THREE.WebGLRenderTarget | null = null;
  private pong: THREE.WebGLRenderTarget | null = null;
  private momentsTarget: THREE.WebGLRenderTarget | null = null;
  private out8: THREE.WebGLRenderTarget | null = null;
  private readonly guideMaterials = new Map<string, THREE.RawShaderMaterial>();
  private readonly sumQuad: FullScreenQuad;
  private readonly despeckle: FullScreenQuad;
  private readonly atrous: FullScreenQuad;
  private readonly moments: FullScreenQuad;
  private readonly display: FullScreenQuad;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = false;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.floatBlend = !!this.renderer.extensions.get("EXT_float_blend");
    this.renderer.extensions.get("OES_texture_float_linear");
    canvas.addEventListener("webglcontextlost", this.contextLost);

    // the tracer says on the console that its WebGL form will give way to a WebGPU one; nothing for a person to do
    const warn = console.warn; console.warn = () => { /* quiet */ };
    try { this.pt = new WebGLPathTracer(this.renderer); } finally { console.warn = warn; }
    this.pt.renderToCanvas = false; this.pt.renderDelay = 0; this.pt.minSamples = 0; this.pt.fadeDuration = 0;
    this.pt.synchronizeRenderSize = false; this.pt.dynamicLowRes = false; this.pt.rasterizeScene = false;
    this.inner = (this.pt as any)._pathTracer;
    const material = this.inner.material as THREE.ShaderMaterial;
    material.fragmentShader = patchPathTracer(material.fragmentShader);
    Object.assign(material.uniforms, {
      jGroundMaterial: { value: -1 }, jGroundMode: { value: 0 }, jGroundFlat: { value: new THREE.Vector3(1, 1, 1) }, jGroundGraze: { value: new THREE.Vector3() },
      jGroundRange: { value: new THREE.Vector2(8, 20) }, jBackdropMode: { value: 1 }, jBackdrop: { value: new THREE.Vector3(1, 1, 1) }, jClamp: { value: 48 },
    });
    // The tracer compiles its shader again whenever one of its switches changes (a lens with an aperture, a
    // backdrop that is a picture), which takes seconds on a good machine and a minute on a slow one.  The
    // switches are held where they are instead: the lens code with an aperture of nothing is a pinhole, and
    // the backdrop's picture is only read when the backdrop is the environment.
    (material as unknown as { onBeforeRender: () => void }).onBeforeRender = function (this: { setDefine(name: string, value: number): void }) {
      this.setDefine("FEATURE_DOF", 1); this.setDefine("FEATURE_BACKGROUND_MAP", 1); this.setDefine("FEATURE_FOG", 0);
    };
    material.needsUpdate = true;

    this.root.matrixAutoUpdate = false; this.guideRoot.matrixAutoUpdate = false;
    this.scene.add(this.root); this.guideScene.add(this.guideRoot);

    const raw = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>): FullScreenQuad => new FullScreenQuad(new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending }));
    this.sumQuad = new FullScreenQuad(new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: GUIDE_SUM_VERTEX, fragmentShader: GUIDE_SUM_FRAGMENT, depthTest: false, depthWrite: false,
      uniforms: { tNormalDepth: { value: null }, tAlbedo: { value: null }, weight: { value: 1 } },
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    }));
    this.despeckle = raw(DESPECKLE_FRAGMENT, { tColor: { value: null }, size: { value: new THREE.Vector2() } });
    this.moments = raw(MOMENTS_FRAGMENT, { tColor: { value: null }, tNormalDepth: { value: null }, tAlbedo: { value: null }, size: { value: new THREE.Vector2() } });
    this.atrous = raw(ATROUS_FRAGMENT, { tMoments: { value: null }, tColor: { value: null }, tNormalDepth: { value: null }, tAlbedo: { value: null }, size: { value: new THREE.Vector2() }, stride: { value: 1 }, sigma: { value: 1 }, first: { value: false } });
    this.display = raw(DISPLAY_FRAGMENT, { tColor: { value: null }, sourceSize: { value: new THREE.Vector2() }, targetSize: { value: new THREE.Vector2() }, exposure: { value: 1 }, tone: { value: 0 }, compose: { value: 1 }, backdrop: { value: new THREE.Vector3(1, 1, 1) } });
  }

  private contextLost = (ev: Event): void => {
    ev.preventDefault();
    this.lost = true;
    if (this.onLost) this.onLost();
  };

  // ---------------------------------------------------------------- the scene
  async setScene(data: RenderScene): Promise<void> {
    if (this.lost) throw new Error("The graphics context was lost.");
    let triangles = 0;
    for (const m of data.meshes) triangles += m.indices.length / 3;
    if (triangles > MAX_TRIANGLES) throw new Error(`This model is ${(triangles / 1e6).toFixed(1)} million triangles; rendering takes up to ${MAX_TRIANGLES / 1e6} million. Hide some parts and try again.`);
    this.clearScene();
    this.triangles = triangles;

    // what is drawn, and its box in model space
    const box = new THREE.Box3(), one = new THREE.Box3(), matrix = new THREE.Matrix4();
    const materials = new Map<string, THREE.MeshPhysicalMaterial>();
    const geometries = new Map<Float32Array, THREE.BufferGeometry>();
    for (const m of data.meshes) {
      if (!m.indices.length || !m.positions.length) continue;
      // instances of one part share its arrays: one geometry on the card for the guides
      let g = geometries.get(m.positions);
      if (!g) {
        g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
        g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
        g.setIndex(new THREE.BufferAttribute(m.indices, 1));
        g.computeBoundingBox();
        geometries.set(m.positions, g);
      }
      // groups differ from instance to instance; the attributes stay shared
      const own = new THREE.BufferGeometry();
      own.setAttribute("position", g.getAttribute("position")); own.setAttribute("normal", g.getAttribute("normal")); own.setIndex(g.getIndex());
      own.boundingBox = g.boundingBox; own.boundingSphere = g.boundingSphere;
      const mats: THREE.MeshPhysicalMaterial[] = [], guides: THREE.RawShaderMaterial[] = [];
      const groups = m.groups.length ? m.groups : [];
      for (const gr of groups) {
        const key = surfaceKey(gr.surface);
        let mat = materials.get(key);
        if (!mat) { mat = this.material(gr.surface); materials.set(key, mat); }
        let at = mats.indexOf(mat);
        if (at < 0) { at = mats.length; mats.push(mat); guides.push(this.guideMaterial(gr.surface)); }
        own.addGroup(gr.start, gr.count, at);
      }
      if (!mats.length) continue;
      const mesh = new THREE.Mesh(own, mats.length > 1 ? mats : mats[0]);
      if (mats.length === 1) own.clearGroups();
      const guide = new THREE.Mesh(own, guides.length > 1 ? guides : guides[0]);
      if (m.matrix) matrix.fromArray(Array.from(m.matrix)); else matrix.identity();
      mesh.matrixAutoUpdate = false; mesh.matrix.copy(matrix);
      guide.matrixAutoUpdate = false; guide.matrix.copy(matrix);
      this.root.add(mesh); this.guideRoot.add(guide);
      box.union(one.copy(g.boundingBox!).applyMatrix4(matrix));
    }
    this.hasScene = !box.isEmpty();
    if (!this.hasScene) { this.dirty.camera = true; return; }

    // turned Y up and scaled to a radius of one about its middle
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.centre.copy(sphere.center); this.scale = 1 / Math.max(sphere.radius, 1e-6);
    const place = new THREE.Matrix4().makeRotationFromQuaternion(Y_UP).multiply(new THREE.Matrix4().makeScale(this.scale, this.scale, this.scale)).multiply(new THREE.Matrix4().makeTranslation(-this.centre.x, -this.centre.y, -this.centre.z));
    this.root.matrix.copy(place); this.guideRoot.matrix.copy(place);
    this.groundY = (box.min.z - this.centre.z) * this.scale;
    // attenuation distances were given in millimetres
    for (const mat of materials.values()) if (Number.isFinite(mat.userData.depth)) mat.attenuationDistance = mat.userData.depth * this.scale;

    const plane = new THREE.PlaneGeometry(GROUND_SIZE * 2, GROUND_SIZE * 2, GROUND_GRID, GROUND_GRID).rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(plane, this.groundMaterial);
    this.ground.position.y = this.groundY;
    this.scene.add(this.ground);
    this.guideGround = new THREE.Mesh(plane, this.guideMaterial(null));
    this.guideGround.position.y = this.groundY;
    this.guideScene.add(this.guideGround);
    this.dirty.settings = true; this.dirty.camera = true; this.dirty.guides = true;
    this.rebuild();
  }

  private clearScene(): void {
    const seen = new Set<THREE.BufferGeometry | THREE.Material>();
    const drop = (o: THREE.Object3D): void => {
      const m = o as THREE.Mesh;
      if (m.geometry && !seen.has(m.geometry)) { seen.add(m.geometry); m.geometry.dispose(); }
      for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) if (mat !== this.groundMaterial && !seen.has(mat)) { seen.add(mat); mat.dispose(); }
    };
    for (const group of [this.root, this.guideRoot]) { group.traverse(drop); group.clear(); }
    if (this.ground) { this.scene.remove(this.ground); this.ground.geometry.dispose(); this.ground = null; }
    if (this.guideGround) { this.guideScene.remove(this.guideGround); this.guideGround = null; }
    this.guideMaterials.clear();
    this.hasScene = false; this.groundIndex = -1;
  }

  private material(s: PhysicalSurface): THREE.MeshPhysicalMaterial {
    const clear = s.transmission > 0;
    const m = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color().setRGB(s.color[0], s.color[1], s.color[2], THREE.LinearSRGBColorSpace), metalness: s.metalness, roughness: s.roughness,
      transmission: s.transmission, ior: Math.max(1, Math.min(2.333, s.ior)),
      // a thickness makes it a solid that refracts, not a film
      thickness: clear ? 1 : 0, attenuationColor: new THREE.Color().setRGB(s.attenuationColor[0], s.attenuationColor[1], s.attenuationColor[2], THREE.LinearSRGBColorSpace),
      clearcoat: s.clearcoat, clearcoatRoughness: s.clearcoatRoughness,
      sheen: s.sheen, sheenRoughness: s.sheenRoughness, sheenColor: new THREE.Color().setRGB(s.sheenColor[0], s.sheenColor[1], s.sheenColor[2], THREE.LinearSRGBColorSpace),
      specularIntensity: s.specular,
      emissive: new THREE.Color().setRGB(s.emissive[0], s.emissive[1], s.emissive[2], THREE.LinearSRGBColorSpace), emissiveIntensity: s.emissiveIntensity,
      side: THREE.DoubleSide,
    });
    m.userData.depth = clear ? s.attenuationDistance : Infinity;
    return m;
  }

  /** The guide material of a surface (null: the ground). */
  private guideMaterial(s: PhysicalSurface | null): THREE.RawShaderMaterial {
    const key = s ? surfaceKey(s) : "ground";
    let m = this.guideMaterials.get(key);
    if (!m) {
      // how mirror-like: what shows in a polished metal or through a clear solid is not this surface
      const sharp = s ? Math.max(s.transmission, s.metalness * (1 - Math.min(1, s.roughness / 0.35)), s.clearcoat * 0.5 * (1 - s.roughness)) : 0;
      m = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: GUIDE_VERTEX, fragmentShader: GUIDE_FRAGMENT, side: THREE.DoubleSide,
        uniforms: { albedo: { value: new THREE.Vector3(...(s ? s.color : [0.5, 0.5, 0.5])) }, sharp: { value: sharp }, jitter: { value: new THREE.Vector2() } },
      });
      this.guideMaterials.set(key, m);
    }
    return m;
  }

  /** Hand the scene to the tracer (again): the acceleration structure, the materials, the lights. */
  private rebuild(): void {
    if (!this.hasScene) return;
    this.applySettings();
    const camera = this.buildCamera(this.camera, this.css.w / Math.max(1, this.css.h));
    this.built = camera;
    if (this.ground) this.ground.visible = this.groundOn(camera);
    this.scene.updateMatrixWorld(true); this.guideScene.updateMatrixWorld(true);
    const results = this.pt.setScene(this.scene, camera.pt) as any;
    this.groundIndex = results && Array.isArray(results.materials) ? results.materials.indexOf(this.groundMaterial) : -1;
    this.useCamera(camera);
    this.dirty.camera = false; this.dirty.settings = false;
    this.pt.reset(); this.shown = -1;
  }

  // ---------------------------------------------------------------- the camera
  setCamera(camera: RenderCamera): void { this.camera = camera; this.dirty.camera = true; }

  private buildCamera(c: RenderCamera | null, aspect: number, offset?: { fullW: number; fullH: number; x: number; y: number; w: number; h: number }): Camera {
    const cam: RenderCamera = c || { projection: "perspective", quaternion: [0, 0, 0, 1], target: [this.centre.x, this.centre.y, this.centre.z], height: 2.6 / this.scale, fov: 30 };
    const s = this.scale, toScene = (p: Vec3): THREE.Vector3 => new THREE.Vector3(p[0], p[1], p[2]).sub(this.centre).multiplyScalar(s).applyQuaternion(Y_UP);
    const target = toScene(cam.target), reach = target.length() + 4;
    const eye = toScene(cameraPosition(cam, (reach + 2) / s));
    const q = Y_UP.clone().multiply(new THREE.Quaternion(cam.quaternion[0], cam.quaternion[1], cam.quaternion[2], cam.quaternion[3]));
    const back = new THREE.Vector3(...rotate(cam.quaternion, [0, 0, 1])).applyQuaternion(Y_UP);
    const distance = eye.distanceTo(target);
    let pt: THREE.Camera, guide: THREE.Camera;
    if (cam.projection === "perspective") {
      const p = new PhysicalCamera(cam.fov, aspect, 1e-3, 40 * GROUND_SIZE);
      const set = this.settings;
      if (set.dof) {
        const focus = set.focus ? toScene(set.focus) : target;
        const focal = SENSOR / 2 / Math.tan((cam.fov * Math.PI) / 360);
        p.focusDistance = Math.max(1e-3, eye.distanceTo(focus));
        // the tracer takes the aperture's diameter in thousandths of a scene unit
        p.bokehSize = (focal / Math.max(0.5, set.fstop)) * s * 1e3;
      } else p.bokehSize = 0;
      const g = new THREE.PerspectiveCamera(cam.fov, aspect, Math.max(0.02, distance - reach), distance + reach + 60);
      pt = p; guide = g;
    } else {
      const hh = (cam.height / 2) * s, hw = hh * aspect;
      pt = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 0, distance + 40 * GROUND_SIZE);
      guide = new THREE.OrthographicCamera(-hw, hw, hh, -hh, Math.max(0, distance - reach), distance + reach + 60);
    }
    for (const k of [pt, guide] as (THREE.PerspectiveCamera | THREE.OrthographicCamera)[]) {
      k.position.copy(eye); k.quaternion.copy(q);
      if (offset) k.setViewOffset(offset.fullW, offset.fullH, offset.x, offset.y, offset.w, offset.h);
      k.updateProjectionMatrix(); k.updateMatrixWorld(true);
    }
    // seen from under the ground there is no ground: it would hide the model
    const below = cam.projection === "perspective" ? eye.y < this.groundY + 1e-4 : back.y < -1e-4;
    return { pt, guide, azimuth: Math.atan2(back.x, back.z), below };
  }

  private applyCamera(): void {
    if (!this.hasScene) return;
    const camera = this.buildCamera(this.camera, this.css.w / Math.max(1, this.css.h));
    this.useCamera(camera);
  }
  private useCamera(camera: Camera): void {
    this.built = camera;
    this.pt.setCamera(camera.pt);
    this.applyLights(camera);
    this.applyGround();
    this.dirty.guides = true;
    this.shown = -1;
  }

  // ---------------------------------------------------------------- lights, backdrop, ground
  setSettings(settings: RenderSettings): void {
    const was = this.settings;
    this.settings = { ...settings };
    // exposure and the curve only develop the picture differently: nothing is traced again
    const same = (["environment", "rotation", "intensity", "follow", "ground", "background", "backgroundColor", "dof", "fstop", "quality"] as const).every((k) => was[k] === settings[k])
      && JSON.stringify(was.focus) === JSON.stringify(settings.focus) && (settings.background !== "color" || was.tone === settings.tone);
    if (!same) this.dirty.settings = true;
    this.shown = -1;
  }

  private applySettings(): void {
    const set = this.settings, q = qualityOf(set.quality);
    this.pt.bounces = q.bounces; this.pt.transmissiveBounces = q.transmissiveBounces;
    this.pt.filterGlossyFactor = 0.25;
    const image = buildEnvironment(set.environment);
    if (image !== this.envImage) {
      this.envImage = image;
      this.envTexture?.dispose();
      const t = new THREE.DataTexture(image.data, image.width, image.height, THREE.RGBAFormat, THREE.FloatType);
      t.mapping = THREE.EquirectangularReflectionMapping; t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
      t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.colorSpace = THREE.LinearSRGBColorSpace; t.needsUpdate = true;
      this.envTexture = t;
    }
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = set.intensity;
    const u = (this.inner.material as THREE.ShaderMaterial).uniforms;
    u.jClamp.value = q.clamp * Math.max(1, set.intensity);
    u.jBackdropMode.value = set.background === "environment" ? 0 : set.background === "color" ? 1 : 2;
  }

  private backdropHex(): string { return this.settings.backgroundColor || environmentSpec(this.settings.environment).backdrop; }
  /** The backdrop colour as light: what develops to the colour that was chosen (what a clear solid in front of it is lit by). */
  private backdrop(): THREE.Color {
    const c = sceneColorFor(this.backdropHex(), this.settings.tone, 0);
    return new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
  }

  private applyLights(camera: Camera): void {
    const set = this.settings;
    const turn = (set.rotation * Math.PI) / 180 + (set.follow ? camera.azimuth : 0);
    this.scene.environmentRotation.set(0, turn, 0);
    this.scene.backgroundRotation.set(0, turn, 0);
    // a plain backdrop is put behind the picture when it is developed: the tracer leaves those pixels empty
    this.scene.background = set.background === "environment" ? this.envTexture : null;
    this.scene.backgroundIntensity = set.intensity;
    this.pt.updateEnvironment();
    this.inner.alpha = set.background !== "environment" || !this.floatBlend;
  }

  private groundOn(camera: Camera | null): boolean { return this.settings.ground !== "none" && !(camera && camera.below); }

  private applyGround(): void {
    const set = this.settings, camera = this.built, image = this.envImage;
    if (!this.ground || !image) return;
    const on = this.groundOn(camera);
    const u = (this.inner.material as THREE.ShaderMaterial).uniforms;
    // what a white matt ground sends back under these lights with nothing standing on it
    const e = image.ground.flat.map((v) => v * set.intensity) as Vec3, graze = image.ground.graze.map((v) => v * set.intensity) as Vec3;
    // the ground is as light as makes it, unshadowed, the colour of the backdrop: what bounces off it onto the model is then right too
    const back = set.background === "color" ? this.backdrop() : new THREE.Color(0.5, 0.5, 0.5).multiplyScalar(Math.max(e[0], e[1], e[2]));
    // through glass a plain backdrop is this light; with no backdrop the ground shows as it is lit
    const through = set.background === "color" ? back : new THREE.Color(1, 1, 1);
    const albedo = [back.r / Math.max(e[0], 1e-4), back.g / Math.max(e[1], 1e-4), back.b / Math.max(e[2], 1e-4)].map((v) => Math.max(0.03, Math.min(0.92, v)));
    const glossy = set.ground === "glossy";
    const m = this.groundMaterial;
    m.color.setRGB(albedo[0], albedo[1], albedo[2], THREE.LinearSRGBColorSpace);
    // the shadow catcher is matt and nothing else (an index of 1 reflects nothing): what it sends back is then known exactly
    m.roughness = glossy ? 0.16 : 1; m.metalness = 0; m.ior = glossy ? 1.5 : 1;
    m.specularIntensity = glossy ? 1 : 0; m.clearcoat = glossy ? 0.35 : 0; m.clearcoatRoughness = 0.08;
    const moved = this.ground.visible !== on;
    this.ground.visible = on;
    if (this.guideGround) {
      this.guideGround.visible = on;
      const gm = this.guideGround.material as THREE.RawShaderMaterial;
      (gm.uniforms.albedo.value as THREE.Vector3).set(albedo[0], albedo[1], albedo[2]); gm.uniforms.sharp.value = glossy ? 0.55 : 0;
    }
    u.jGroundMaterial.value = on ? this.groundIndex : -1;
    u.jGroundMode.value = glossy ? 1 : 0;
    (u.jGroundFlat.value as THREE.Vector3).set(albedo[0] * e[0], albedo[1] * e[1], albedo[2] * e[2]);
    (u.jGroundGraze.value as THREE.Vector3).set(albedo[0] * graze[0], albedo[1] * graze[1], albedo[2] * graze[2]);
    if (set.background === "color") (u.jBackdrop.value as THREE.Vector3).set(through.r, through.g, through.b); else (u.jBackdrop.value as THREE.Vector3).copy(u.jGroundFlat.value as THREE.Vector3);
    (u.jGroundRange.value as THREE.Vector2).set(glossy ? 5 : 9, glossy ? 16 : 26);
    if (moved) {
      // the tracer holds the scene's triangles: a ground taken away or put back is a new scene
      const results = this.pt.setScene(this.scene, (this.built || this.buildCamera(this.camera, 1)).pt) as any;
      this.groundIndex = results && Array.isArray(results.materials) ? results.materials.indexOf(this.groundMaterial) : -1;
      u.jGroundMaterial.value = on ? this.groundIndex : -1;
      if (camera) this.applyLights(camera);
    } else this.pt.updateMaterials();
  }

  // ---------------------------------------------------------------- the live picture
  resize(width: number, height: number, pixelRatio: number): void {
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height)), ratio = Math.max(0.5, Math.min(2, pixelRatio || 1));
    if (w === this.css.w && h === this.css.h && ratio === this.css.ratio) return;
    this.css = { w, h, ratio };
    this.dirty.size = true; this.dirty.camera = true;
  }

  restart(moving = false): void {
    if (this.moving !== moving) { this.moving = moving; this.dirty.size = true; }
    this.dirty.camera = true;
  }

  private liveSize(): { w: number; h: number; cw: number; ch: number } {
    const cw = Math.max(1, Math.round(this.css.w * this.css.ratio)), ch = Math.max(1, Math.round(this.css.h * this.css.ratio));
    let k = qualityOf(this.settings.quality).scale * (this.moving ? 0.4 : 1);
    k = Math.min(k, Math.sqrt(LIVE_PIXELS / (cw * ch)));
    return { w: Math.max(8, Math.round(cw * k)), h: Math.max(8, Math.round(ch * k)), cw, ch };
  }

  private setTraceSize(w: number, h: number): void {
    if (this.trace.w === w && this.trace.h === h) return;
    this.trace = { w, h };
    this.inner.setSize(w, h);
    const half = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false };
    for (const t of [this.guideTemp, this.guideSum, this.ping, this.pong, this.momentsTarget]) t?.dispose();
    this.guideTemp = new THREE.WebGLRenderTarget(w, h, { ...half, count: 2, depthBuffer: true });
    this.guideSum = new THREE.WebGLRenderTarget(w, h, { ...half, count: 2 });
    this.ping = new THREE.WebGLRenderTarget(w, h, half);
    this.pong = new THREE.WebGLRenderTarget(w, h, half);
    this.momentsTarget = new THREE.WebGLRenderTarget(w, h, half);
    this.dirty.guides = true;
  }

  step(): RenderProgress {
    const target = qualityOf(this.settings.quality).samples;
    const progress = (): RenderProgress => ({ samples: Math.floor(this.inner.samples), target, done: this.inner.samples >= target, width: this.trace.w, height: this.trace.h });
    if (this.lost || this.busy || !this.hasScene) return { samples: 0, target, done: false, width: this.trace.w, height: this.trace.h };
    const now = performance.now(), dt = this.last ? now - this.last : 16; this.last = now;
    if (this.dirty.size) {
      const s = this.liveSize();
      if (this.canvas.width !== s.cw || this.canvas.height !== s.ch) this.renderer.setSize(s.cw, s.ch, false);
      this.setTraceSize(s.w, s.h);
      this.dirty.size = false; this.dirty.camera = true;
    }
    if (this.dirty.settings) { this.applySettings(); this.dirty.settings = false; this.dirty.camera = true; }
    if (this.dirty.camera) { this.applyCamera(); this.dirty.camera = false; this.tiles = this.moving ? 1 : Math.max(1, this.tiles); }
    if (this.inner.samples < target) {
      // each call traces one tile of one sample; fewer, larger tiles while frames come quickly
      if (!this.moving) { if (dt > 70) this.tiles = Math.min(8, this.tiles + 1); else if (dt < 24) this.tiles = Math.max(1, this.tiles - 1); }
      this.inner.tiles.set(this.tiles, this.tiles);
      this.pt.renderSample();
      if (dt < 12 && this.tiles === 1 && this.inner.samples < target) this.pt.renderSample();
    }
    const whole = Math.floor(this.inner.samples);
    if (whole >= 1 && whole !== this.shown) { this.present(null, this.canvas.width, this.canvas.height); this.shown = whole; }
    return progress();
  }

  /** The traced picture, denoised when asked, developed into `target` (null: the canvas). */
  private present(target: THREE.WebGLRenderTarget | null, width: number, height: number): void {
    const r = this.renderer, set = this.settings, samples = Math.max(1, this.inner.samples);
    let source: THREE.Texture = (this.pt.target as THREE.WebGLRenderTarget).texture;
    const w = this.trace.w, h = this.trace.h;
    // past a few thousand samples the noise is under what the filter could tell from detail
    if (set.denoise && samples < 4000 && this.guideSum && this.ping && this.pong && this.momentsTarget) {
      if (this.dirty.guides) this.drawGuides();
      const size = new THREE.Vector2(w, h);
      const d = this.despeckle.material as THREE.ShaderMaterial;
      d.uniforms.tColor.value = source; d.uniforms.size.value = size;
      r.setRenderTarget(this.ping); this.despeckle.render(r);
      const mo = this.moments.material as THREE.ShaderMaterial;
      mo.uniforms.tColor.value = this.ping.texture; mo.uniforms.tNormalDepth.value = this.guideSum.textures[0]; mo.uniforms.tAlbedo.value = this.guideSum.textures[1]; mo.uniforms.size.value = size;
      r.setRenderTarget(this.momentsTarget); this.moments.render(r);
      const a = this.atrous.material as THREE.ShaderMaterial;
      a.uniforms.tMoments.value = this.momentsTarget.texture;
      a.uniforms.tNormalDepth.value = this.guideSum.textures[0]; a.uniforms.tAlbedo.value = this.guideSum.textures[1]; a.uniforms.size.value = size;
      // each pass leaves about half the noise the one before it found; depth of field blurs what the guides
      // show sharp, so the filter is gentler then
      const wide = set.dof && this.camera?.projection === "perspective" ? 1.0 : 1.6;
      let from = this.ping, to = this.pong;
      for (let i = 0; i < 5; i++) {
        a.uniforms.tColor.value = from.texture; a.uniforms.stride.value = 1 << i; a.uniforms.first.value = i === 0;
        a.uniforms.sigma.value = wide * Math.pow(0.55, i);
        r.setRenderTarget(to); this.atrous.render(r);
        const t = from; from = to; to = t;
      }
      source = from.texture;
    }
    const m = this.display.material as THREE.ShaderMaterial;
    m.uniforms.tColor.value = source; (m.uniforms.sourceSize.value as THREE.Vector2).set(w, h); (m.uniforms.targetSize.value as THREE.Vector2).set(width, height);
    m.uniforms.exposure.value = exposureScale(set.exposure); m.uniforms.tone.value = set.tone === "aces" ? 1 : 0; m.uniforms.compose.value = set.background === "environment" ? 0 : set.background === "color" ? 1 : 2;
    const shown = new THREE.Color(this.backdropHex());
    (m.uniforms.backdrop.value as THREE.Vector3).set(shown.r, shown.g, shown.b);
    r.setRenderTarget(target);
    r.setViewport(0, 0, width, height);
    r.setClearColor(0x000000, 0); r.clear(true, false, false);
    this.display.render(r);
    r.setRenderTarget(null);
  }

  /** What the camera sees first, for the filter: drawn a few times a fraction of a pixel apart and averaged. */
  private drawGuides(): void {
    const r = this.renderer, camera = this.built;
    if (!camera || !this.guideTemp || !this.guideSum) return;
    const w = this.trace.w, h = this.trace.h, taps = this.floatBlend ? GUIDE_TAPS : 1;
    const sum = this.sumQuad.material as THREE.RawShaderMaterial;
    r.setRenderTarget(this.guideSum); r.setClearColor(0x000000, 0); r.clear(true, false, false);
    for (let i = 0; i < taps; i++) {
      // the Halton points 2 and 3, centred: the same spread a tent filter gives the traced samples
      const jx = taps > 1 ? halton(i + 1, 2) - 0.5 : 0, jy = taps > 1 ? halton(i + 1, 3) - 0.5 : 0;
      for (const m of this.guideMaterials.values()) (m.uniforms.jitter.value as THREE.Vector2).set((2 * jx) / w, (2 * jy) / h);
      r.setRenderTarget(this.guideTemp); r.setClearColor(0x000000, 0); r.clear(true, true, false);
      r.render(this.guideScene, camera.guide);
      sum.uniforms.tNormalDepth.value = this.guideTemp.textures[0]; sum.uniforms.tAlbedo.value = this.guideTemp.textures[1]; sum.uniforms.weight.value = 1 / taps;
      r.setRenderTarget(this.guideSum); this.sumQuad.render(r);
    }
    r.setRenderTarget(null);
    this.dirty.guides = false;
  }

  // ---------------------------------------------------------------- stills
  async renderStill(o: StillOptions): Promise<HTMLCanvasElement> {
    if (this.lost) throw new Error("The graphics context was lost.");
    if (!this.hasScene) throw new Error("There is nothing to render.");
    if (this.busy) throw new Error("A render is already running.");
    this.busy = true;
    const W = Math.max(2, Math.round(o.width)), H = Math.max(2, Math.round(o.height)), samples = Math.max(1, Math.round(o.samples));
    const cam = o.camera || this.camera;
    const was = { moving: this.moving, tiles: this.tiles };
    this.moving = false;
    try {
      if (this.dirty.settings) { this.applySettings(); this.dirty.settings = false; }
      const pad = this.settings.denoise ? TILE_PAD : 0;
      const side = Math.min(TILE, Math.max(64, this.renderer.capabilities.maxTextureSize - 2 * pad));
      const nx = Math.ceil(W / side), ny = Math.ceil(H / side), tw = Math.ceil(W / nx), th = Math.ceil(H / ny);
      const pixels = new Uint8ClampedArray(W * H * 4);
      const total = nx * ny * samples;
      let done = 0;
      for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
        const x0 = tx * tw, y0 = ty * th, cw = Math.min(tw, W - x0), ch = Math.min(th, H - y0);
        const rw = cw + 2 * pad, rh = ch + 2 * pad;
        this.setTraceSize(rw, rh);
        if (!this.out8 || this.out8.width !== rw || this.out8.height !== rh) { this.out8?.dispose(); this.out8 = new THREE.WebGLRenderTarget(rw, rh, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false }); }
        const whole = nx === 1 && ny === 1 && pad === 0;
        this.useCamera(this.buildCamera(cam, W / H, whole ? undefined : { fullW: W, fullH: H, x: x0 - pad, y: y0 - pad, w: rw, h: rh }));
        this.pt.reset();
        // enough tiles inside the tracer that one call does not stall the page for long
        const split = Math.max(1, Math.min(6, Math.round(Math.sqrt((rw * rh) / 160000))));
        this.inner.tiles.set(split, split);
        let lap = performance.now(), painted = lap, before = 0;
        do {
          this.pt.renderSample();
          if (o.signal?.cancelled) { const e = new Error("The render was stopped."); e.name = "AbortError"; throw e; }
          if (this.lost) throw new Error("The graphics context was lost.");
          const now = Math.min(samples, this.inner.samples);
          if (performance.now() - lap > 24) {
            if (performance.now() - painted > 150) { await breathe(); painted = performance.now(); } else await yieldNow();
            lap = performance.now(); if (o.onProgress) o.onProgress((done + now) / total);
          }
          before = now;
        } while (this.inner.samples < samples);
        done += samples; void before;
        this.present(this.out8, rw, rh);
        const buf = new Uint8Array(rw * rh * 4);
        this.renderer.readRenderTargetPixels(this.out8, 0, 0, rw, rh, buf);
        // rows come back bottom first; the tile's own pixels are inside the overlap
        for (let y = 0; y < ch; y++) {
          const srcRow = rh - 1 - (y + pad), at = (srcRow * rw + pad) * 4;
          pixels.set(buf.subarray(at, at + cw * 4), ((y0 + y) * W + x0) * 4);
        }
        if (o.onProgress) o.onProgress(done / total);
        await breathe();
      }
      // the canvas wants colour that is not multiplied by its coverage
      if (this.settings.background === "transparent") for (let i = 0; i < pixels.length; i += 4) { const a = pixels[i + 3]; if (a > 0 && a < 255) { pixels[i] = Math.min(255, (pixels[i] * 255) / a); pixels[i + 1] = Math.min(255, (pixels[i + 1] * 255) / a); pixels[i + 2] = Math.min(255, (pixels[i + 2] * 255) / a); } }
      const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
      const g = canvas.getContext("2d");
      if (!g) throw new Error("The picture could not be put together.");
      g.putImageData(new ImageData(pixels, W, H), 0, 0);
      return canvas;
    } finally {
      this.busy = false; this.moving = was.moving; this.tiles = was.tiles;
      // the live picture starts again at its own size
      this.dirty.size = true; this.dirty.camera = true; this.trace = { w: 0, h: 0 };
    }
  }

  stats(): { triangles: number; bytes: number } {
    const px = this.trace.w * this.trace.h;
    // the tracer's three float targets, the guides (two pairs) and the filter's two, half floats
    return { triangles: this.triangles, bytes: px * (3 * 16 + 4 * 8 + 3 * 8) + this.triangles * 3 * 4 * 12 };
  }

  dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.contextLost);
    this.clearScene();
    for (const t of [this.guideTemp, this.guideSum, this.ping, this.pong, this.momentsTarget, this.out8]) t?.dispose();
    for (const q of [this.sumQuad, this.despeckle, this.moments, this.atrous, this.display]) { (q.material as THREE.Material).dispose(); q.dispose(); }
    this.envTexture?.dispose(); this.groundMaterial.dispose();
    try { this.pt.dispose(); } catch { /* a lost context has nothing left to free */ }
    this.renderer.dispose();
    // give the graphics memory back now, not when the collector gets to it
    this.renderer.forceContextLoss();
  }
}

function halton(i: number, base: number): number {
  let f = 1, r = 0;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}
