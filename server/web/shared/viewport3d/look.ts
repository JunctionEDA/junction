// look.ts — how the 3D viewport looks: the studio the model stands in.
//
//   light        a small photographic studio rendered once into an environment map (a pale dome, a large key
//                softbox above and to the left, a fill at the right, a strip behind for the rim) that turns with
//                the camera, so a part is lit the same from every side; one soft directional key for form
//   background   a quiet vertical gradient from the theme's paper colour
//   contact      shading where surfaces meet (screen-space ambient occlusion) and a hairline round every part's
//                silhouette, both from one depth pre-pass of the solids
//   ground       a soft shadow where the model stands
//   glow         a soft halo round whatever is highlighted (hovered, selected), drawn from the domain's own
//                highlight objects
//
// A domain marks the meshes that are solid parts with `userData.solid = true`, hands its highlight groups to
// `glowFrom`, and calls `contentChanged()` when the parts changed.  Everything here draws only when the viewport
// draws a frame (on demand).  On a slow or software GPU the screen-space passes and the shadow are left out and
// the environment map (the costly part of shading a pixel) gives way to three plain lights placed as the studio's
// are: a frame then costs what a flat-lit one does.  The gradient, the palette and the edges stay.
import * as THREE from "three";
import { forcedQuality, getViewPrefs, subscribeViewPrefs } from "./viewprefs";

export type Quality = "high" | "low";

/** The layer the depth pre-pass draws: the solids of this frame. */
const SOLID_LAYER = 20;

// ---------------------------------------------------------------- colours
/** The colours parts are told apart by when nobody gave them one: the first is the neutral every lone part has. */
const PALETTE_LIGHT = ["#ccd0d4", "#aebcce", "#d0c3ac", "#afc4b6", "#cbb1ab", "#b9b5cd", "#a7c3c4", "#c9bbc7", "#c7c9ad", "#b9bfc6"];
const PALETTE_DARK = ["#acb0b6", "#95a6bc", "#bfb196", "#96afa0", "#b99b95", "#a39ebb", "#8faeb0", "#b5a5b2", "#b2b596", "#9da4ac"];
/** The colour of the `index`th part nobody coloured. */
export function partColor(index: number, dark: boolean): THREE.Color {
  const p = dark ? PALETTE_DARK : PALETTE_LIGHT;
  return new THREE.Color(p[((index % p.length) + p.length) % p.length]);
}
/** The colour of a part's edges when it is shaded: a dark hairline, whatever the theme. */
export function edgeColor(dark: boolean): THREE.Color { return new THREE.Color(dark ? "#0b0c0f" : "#1c2027"); }

// ---------------------------------------------------------------- materials
const SHOULDER = "{ float m_ = max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b)); if (m_ > 0.72) gl_FragColor.rgb *= (0.72 + (m_ - 0.72) / (1.0 + (m_ - 0.72) / 0.28)) / m_; }\n#include <tonemapping_fragment>";
function shoulder(shader: { fragmentShader: string }): void { shader.fragmentShader = shader.fragmentShader.replace("#include <tonemapping_fragment>", SHOULDER); }
/**
 * Dress a part's material for the studio: a satin surface that takes the softboxes without glare, and a soft
 * shoulder so a highlight never burns out to flat white (the part keeps its hue).
 */
export function studioSurface<M extends THREE.MeshStandardMaterial>(m: M): M {
  m.roughness = 0.52; m.metalness = 0.02; m.envMapIntensity = 1;
  m.onBeforeCompile = shoulder;
  return m;
}

const FRESNEL = "#include <dithering_fragment>\n{ float f_ = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition))), 2.5); gl_FragColor.a = clamp(gl_FragColor.a * (0.55 + 2.6 * f_), 0.0, 1.0); gl_FragColor.rgb = mix(gl_FragColor.rgb, diffuseColor.rgb * 1.25 + 0.12, 0.6 * f_); }";
function fresnel(shader: { fragmentShader: string }): void { shader.fragmentShader = shader.fragmentShader.replace("#include <dithering_fragment>", FRESNEL); }
/**
 * Dress a material as a preview of what is not there yet (an insert about to be placed): glass in the colour it
 * is given, clear where it faces the eye and brighter and denser where it turns away.
 */
export function ghostSurface<M extends THREE.MeshStandardMaterial>(m: M): M {
  m.roughness = 0.35; m.metalness = 0; m.transparent = true; m.depthWrite = false;
  m.onBeforeCompile = fresnel;
  return m;
}

// ---------------------------------------------------------------- edges: sharp and tangent
const edgeShadeCache = new WeakMap<Float32Array, Float32Array>();
/** How much of a tangent edge (where two faces meet smoothly: the ends of a fillet, a cylinder's seam) is drawn. */
const TANGENT_ALPHA = 0.26;
/**
 * A colour per edge vertex (white, with an alpha) that draws tangent edges lighter than sharp ones.  An edge is
 * tangent when the faces that meet along it have the same normal there: the mesh has one vertex per face at each
 * point of an edge, so the normals at a point say it.
 */
export function edgeShades(mesh: { positions: Float32Array; normals: Float32Array; edges: { positions: Float32Array; start: Uint32Array; count: Uint32Array } }): Float32Array {
  const E = mesh.edges.positions;
  const hit = edgeShadeCache.get(E);
  if (hit) return hit;
  const n = E.length / 3, out = new Float32Array(n * 4).fill(1);
  const P = mesh.positions, N = mesh.normals;
  if (n && P.length <= 3 * 400000) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < P.length; i++) { if (P[i] < lo) lo = P[i]; if (P[i] > hi) hi = P[i]; }
    const q = 1 / Math.max((hi - lo) * 2e-6, 1e-9);
    const key = (x: number, y: number, z: number): string => `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    const at = new Map<string, number[]>();
    for (let i = 0; i < P.length; i += 3) { const k = key(P[i], P[i + 1], P[i + 2]); const l = at.get(k); if (l) l.push(i); else at.set(k, [i]); }
    for (let e = 0; e < mesh.edges.start.length; e++) {
      const s = mesh.edges.start[e], c = mesh.edges.count[e];
      let judged = 0, sharp = false;
      for (let k = s; k < s + c && !sharp; k++) {
        const l = at.get(key(E[k * 3], E[k * 3 + 1], E[k * 3 + 2]));
        if (!l || l.length < 2) continue;
        judged++;
        const a = l[0];
        for (let j = 1; j < l.length; j++) { const b = l[j]; if (N[a] * N[b] + N[a + 1] * N[b + 1] + N[a + 2] * N[b + 2] < 0.985) { sharp = true; break; } }
      }
      if (judged && !sharp) for (let k = s; k < s + c; k++) out[k * 4 + 3] = TANGENT_ALPHA;
    }
  }
  edgeShadeCache.set(E, out);
  return out;
}
/** Give an edge geometry the per-vertex shades of `edgeShades` (the material must have `vertexColors` and be transparent). */
export function shadeEdges(geometry: THREE.BufferGeometry, mesh: Parameters<typeof edgeShades>[0]): void {
  geometry.setAttribute("color", new THREE.BufferAttribute(edgeShades(mesh), 4));
}
/** The material of a part's edge lines: hairlines that take `shadeEdges`. */
export function edgeLineMaterial(o: THREE.LineBasicMaterialParameters = {}): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, ...o });
}

// ---------------------------------------------------------------- points
let dot: THREE.Texture | null = null;
/** The material of a highlighted point (a vertex under the pointer, a chosen one): a round dot with a pale rim, the same size at any zoom, over everything. */
export function dotMaterial(color: THREE.Color, size: number): THREE.PointsMaterial {
  if (!dot) {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d");
    if (g) {
      g.fillStyle = "rgba(255,255,255,0.55)"; g.beginPath(); g.arc(32, 32, 31, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#fff"; g.beginPath(); g.arc(32, 32, 23, 0, Math.PI * 2); g.fill();
    }
    dot = new THREE.CanvasTexture(c); dot.colorSpace = THREE.SRGBColorSpace;
  }
  return new THREE.PointsMaterial({ color, map: dot, size: size * 1.3, sizeAttenuation: false, depthTest: false, transparent: true, alphaTest: 0.05 });
}

// ---------------------------------------------------------------- the studio (an environment map)
const DOME_FRAG = `
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y * 0.5 + 0.5;
  // a pale room: brighter overhead, a soft floor bounce below, a little brighter behind the viewer
  float v = mix(0.30, 0.86, smoothstep(0.0, 1.0, h)) + 0.10 * max(0.0, d.z);
  gl_FragColor = vec4(vec3(v) * vec3(0.985, 0.995, 1.02), 1.0);
}`;
const DOME_VERT = "varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }";

const environments = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();
/** The studio's environment map for this renderer (made once, kept with it).  It is in the camera's own frame: see `aimEnvironment`. */
export function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const had = environments.get(renderer);
  if (had) return had;
  const scene = new THREE.Scene();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.ShaderMaterial({ vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, side: THREE.BackSide, depthWrite: false, toneMapped: false }));
  scene.add(dome);
  const box = (x: number, y: number, z: number, w: number, h: number, power: number, tint = 0xffffff) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(tint).multiplyScalar(power), side: THREE.DoubleSide, toneMapped: false }));
    m.position.set(x, y, z); m.lookAt(0, 0, 0);
    scene.add(m);
  };
  // the viewer stands at +z looking at the part at the origin; y is up
  box(-14, 20, 16, 22, 22, 3.4, 0xfff8ef);     // key: a large softbox above, to the left, on the viewer's side
  box(22, 3, 10, 14, 18, 1.0, 0xeaf1ff);       // fill: lower at the right, cooler
  box(0, 16, -24, 44, 7, 2.6);                 // rim: a strip behind and above
  box(-26, -2, -6, 8, 20, 0.9);                // a kicker at the far left
  const was = { target: renderer.getRenderTarget(), auto: renderer.autoClear };
  const pmrem = new THREE.PMREMGenerator(renderer);
  renderer.autoClear = true;
  const texture = pmrem.fromScene(scene, 0.03, 1, 200).texture;
  renderer.autoClear = was.auto; renderer.setRenderTarget(was.target);
  pmrem.dispose();
  scene.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
  environments.set(renderer, texture);
  return texture;
}
const qInv = new THREE.Quaternion();
/** Turn a scene's environment so that the studio stands where this camera stands. */
export function aimEnvironment(scene: THREE.Scene, camera: THREE.Camera): void {
  scene.environmentRotation.setFromQuaternion(qInv.copy(camera.quaternion).invert());
}
/** Where the directional key stands, in the camera's frame (towards the viewer, up and to the left). */
export const KEY_OFFSET: THREE.Vector3Tuple = [-0.35, 1, 0.6];
export const KEY_INTENSITY = 1.9;

/**
 * The studio without its environment map, for a GPU that cannot afford one: the dome as a sky and ground light
 * and the fill softbox as a second directional light, both in the camera's frame like the key.
 */
export class PlainRig {
  readonly dome = new THREE.HemisphereLight(0xffffff, 0xa3aab3, 1.75);
  readonly fill = new THREE.DirectionalLight(0xeaf1ff, 0.95);
  constructor(readonly scene: THREE.Scene) { scene.add(this.dome, this.fill, this.fill.target); }
  /** Stand the lights where this camera stands, lighting what is at `focus`. */
  aim(camera: THREE.Camera, focus: THREE.Vector3): void {
    this.dome.position.set(0, 0.9, 0.45).applyQuaternion(camera.quaternion);
    this.fill.position.copy(focus).addScaledVector(new THREE.Vector3(0.9, 0.1, 0.5).applyQuaternion(camera.quaternion), 2e4);
    this.fill.target.position.copy(focus); this.fill.target.updateMatrixWorld();
  }
  dispose(): void { this.scene.remove(this.dome, this.fill, this.fill.target); }
}

/**
 * Light a scene that is drawn once from a fixed camera (a thumbnail, a preview) as the viewport lights its own:
 * the studio's environment (or its plain lights), turned to that camera, and the key.
 */
export function lightAsStudio(scene: THREE.Scene, renderer: THREE.WebGLRenderer, camera: THREE.Camera, focus: THREE.Vector3, radius: number): void {
  camera.updateMatrixWorld();
  if (qualityOf(renderer) === "high") { scene.environment = studioEnvironment(renderer); aimEnvironment(scene, camera); }
  else new PlainRig(scene).aim(camera, focus);
  const key = new THREE.DirectionalLight(0xffffff, KEY_INTENSITY);
  key.position.copy(focus).addScaledVector(new THREE.Vector3(...KEY_OFFSET).applyQuaternion(camera.quaternion), Math.max(radius, 1) * 4);
  key.target.position.copy(focus);
  scene.add(key, key.target);
}

/** The backdrop: a vertical gradient from the theme's paper colour, with a grain too fine to see that keeps it from banding. */
export function backdropTexture(paper: THREE.Color, ink: THREE.Color): THREE.Texture {
  const dark = paper.getHSL({ h: 0, s: 0, l: 0 }).l < 0.5;
  const top = dark ? paper.clone().lerp(new THREE.Color("#3a4150"), 0.42) : new THREE.Color("#ffffff").lerp(paper, 0.35);
  const bottom = dark ? paper.clone().lerp(new THREE.Color("#000000"), 0.38) : paper.clone().lerp(new THREE.Color("#8d9bb0"), 0.26);
  void ink;
  const W = 8, H = 512;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  if (g) {
    const img = g.createImageData(W, H);
    const a = [top.r, top.g, top.b], b = [bottom.r, bottom.g, bottom.b];
    const s = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
    const ta = a.map(s), tb = b.map(s);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    for (let y = 0; y < H; y++) {
      // most of the change happens in the lower half: a horizon, not a ramp
      const t = y / (H - 1), k = t * t * (3 - 2 * t);
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4, n = rnd() * 1.2;
        for (let ch = 0; ch < 3; ch++) img.data[i + ch] = Math.max(0, Math.min(255, Math.round((ta[ch] + (tb[ch] - ta[ch]) * k) * 255 + n)));
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
  return t;
}

// ---------------------------------------------------------------- full-screen passes
const QUAD_VERT = "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
const quadGeometry = new THREE.PlaneGeometry(2, 2);
const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
function pass(fragmentShader: string, uniforms: { [k: string]: THREE.IUniform }, o: THREE.ShaderMaterialParameters = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false, ...o });
}

const AO_FRAG = `
uniform sampler2D tDepth; uniform sampler2D tNormal; uniform mat4 proj; uniform mat4 projInv; uniform float radius; uniform float strength;
varying vec2 vUv;
vec3 viewPos(vec2 uv) { float d = texture2D(tDepth, uv).x; vec4 v = projInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return v.xyz / v.w; }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec4 nt = texture2D(tNormal, vUv);
  if (nt.a < 0.5) { gl_FragColor = vec4(1.0); return; }
  vec3 n = normalize(nt.xyz * 2.0 - 1.0);
  vec3 p = viewPos(vUv);
  float turn = ign(gl_FragCoord.xy) * 6.2831853, sum = 0.0;
  const int N = 14;
  for (int i = 0; i < N; i++) {
    float a = turn + float(i) * 2.3999632, r = sqrt((float(i) + 0.5) / float(N)) * radius;
    vec4 c = proj * vec4(p + vec3(cos(a), sin(a), 0.0) * r, 1.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (texture2D(tNormal, uv).a < 0.5) continue;
    vec3 v = viewPos(uv) - p;
    float vv = dot(v, v), vn = dot(v, n);
    sum += max(0.0, vn - 0.03 * radius) / (vv + 0.0004 * radius * radius) * radius * (1.0 - smoothstep(radius * radius, 4.0 * radius * radius, vv));
  }
  gl_FragColor = vec4(vec3(clamp(1.0 - strength * sum / float(N), 0.0, 1.0)), 1.0);
}`;
const AO_BLUR_FRAG = `
uniform sampler2D tAO; uniform sampler2D tDepth; uniform vec2 step_; uniform float tolerance;
varying vec2 vUv;
void main() {
  float d0 = texture2D(tDepth, vUv).x, sum = texture2D(tAO, vUv).r, w = 1.0;
  for (int i = 1; i <= 4; i++) {
    for (int s = -1; s <= 1; s += 2) {
      vec2 uv = vUv + step_ * float(i * s);
      float k = (1.0 - float(i) * 0.18) * step(abs(texture2D(tDepth, uv).x - d0), tolerance);
      sum += texture2D(tAO, uv).r * k; w += k;
    }
  }
  gl_FragColor = vec4(vec3(sum / w), 1.0);
}`;
/** Drawn in the scene after the opaque parts and before anything translucent: it darkens what is there. */
const CONTACT_FRAG = `
uniform sampler2D tAO; uniform sampler2D tDepth; uniform mat4 projInv; uniform vec2 texel; uniform float ao; uniform float outline; uniform float pixel; uniform float ortho;
varying vec2 vUv;
float eyeZ(vec2 uv) { float d = texture2D(tDepth, uv).x; vec4 v = projInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return -v.z / v.w; }
void main() {
  float zc = eyeZ(vUv);
  float a = mix(1.0, texture2D(tAO, vUv).r, ao);
  // a hairline on the near side of every step in depth: the silhouette of each part, and where one hides another
  float zl = eyeZ(vUv - vec2(texel.x, 0.0)), zr = eyeZ(vUv + vec2(texel.x, 0.0)), zd = eyeZ(vUv - vec2(0.0, texel.y)), zu = eyeZ(vUv + vec2(0.0, texel.y));
  float px = mix(zc * pixel, pixel, ortho);
  float e = max(max(zl - zc, zr - zc) - max(0.0, max(zc - zl, zc - zr)) , max(zd - zc, zu - zc) - max(0.0, max(zc - zd, zc - zu)));
  float line = smoothstep(2.5 * px, 6.0 * px, e) * outline;
  gl_FragColor = vec4(vec3(a * (1.0 - line)), 1.0);
}`;
const GAUSS_FRAG = `
uniform sampler2D tMap; uniform vec2 step_;
varying vec2 vUv;
void main() {
  vec4 sum = texture2D(tMap, vUv) * 0.2270270;
  sum += (texture2D(tMap, vUv + step_ * 1.3846154) + texture2D(tMap, vUv - step_ * 1.3846154)) * 0.3162162;
  sum += (texture2D(tMap, vUv + step_ * 3.2307692) + texture2D(tMap, vUv - step_ * 3.2307692)) * 0.0702703;
  gl_FragColor = sum;
}`;
/** The halo: the highlights, blurred, laid over the picture; fainter where the highlight itself already is. */
const GLOW_FRAG = `
uniform sampler2D tBlur; uniform sampler2D tSharp; uniform float strength;
varying vec2 vUv;
void main() {
  vec4 b = texture2D(tBlur, vUv); float s = texture2D(tSharp, vUv).a;
  float a = clamp(b.a * 1.9, 0.0, 1.0) * strength * mix(1.0, 0.3, clamp(s * 2.0, 0.0, 1.0));
  gl_FragColor = vec4(b.rgb / max(b.a, 1e-4), a);
}`;
const SHADOW_CAST_FRAG = "uniform float reach; varying float vH; void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0 - smoothstep(0.0, 1.0, vH / reach)); }";
const SHADOW_CAST_VERT = "uniform float ground; varying float vH; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vH = w.z - ground; gl_Position = projectionMatrix * viewMatrix * w; }";
const GROUND_FRAG = `
uniform sampler2D tShadow; uniform float opacity; uniform vec3 tint;
varying vec2 vUv;
void main() {
  vec2 c = abs(vUv - 0.5) * 2.0;
  float fade = (1.0 - smoothstep(0.75, 1.0, c.x)) * (1.0 - smoothstep(0.75, 1.0, c.y));
  gl_FragColor = vec4(tint, texture2D(tShadow, vec2(1.0 - vUv.x, vUv.y)).a * opacity * fade);
}`;
const GROUND_VERT = "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }";

/** What a viewport tells its look each frame. */
export interface LookFrame { camera: THREE.Camera; target: THREE.Vector3; width: number; height: number; pixelRatio: number; pixelSize: number; navigating: boolean }

export class StudioLook {
  readonly quality: { level: Quality; forced: boolean };
  /** the soft directional key (the viewport places it each frame) */
  readonly key = new THREE.DirectionalLight(0xffffff, KEY_INTENSITY);
  /** Shading where surfaces meet and the silhouette hairline, from 0 (none) to 1: a domain turns it down for a display mode that is line work. */
  contact = 1;
  /** the highlight groups a halo is drawn round */
  private glowSources: THREE.Object3D[] = [];
  private backdrop: THREE.Texture | null = null;
  private dark = false;
  private prefs = getViewPrefs();
  private readonly offPrefs: () => void;
  private disposed = false;

  // the depth pre-pass and what is made from it
  private depth: THREE.WebGLRenderTarget | null = null;
  private aoA: THREE.WebGLRenderTarget | null = null;
  private aoB: THREE.WebGLRenderTarget | null = null;
  private glowA: THREE.WebGLRenderTarget | null = null;
  private glowB: THREE.WebGLRenderTarget | null = null;
  private glowSharp: THREE.WebGLRenderTarget | null = null;
  private readonly normalMaterial = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  private readonly occluder = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  private readonly prepassCamera = new THREE.OrthographicCamera();
  private readonly aoPass = pass(AO_FRAG, { tDepth: { value: null }, tNormal: { value: null }, proj: { value: new THREE.Matrix4() }, projInv: { value: new THREE.Matrix4() }, radius: { value: 1 }, strength: { value: 1 } });
  private readonly aoBlur = pass(AO_BLUR_FRAG, { tAO: { value: null }, tDepth: { value: null }, step_: { value: new THREE.Vector2() }, tolerance: { value: 0.01 } });
  private readonly gauss = pass(GAUSS_FRAG, { tMap: { value: null }, step_: { value: new THREE.Vector2() } });
  private readonly quad = new THREE.Mesh(quadGeometry, this.aoPass);
  private readonly contactQuad: THREE.Mesh;
  private readonly contactPass = pass(CONTACT_FRAG, { tAO: { value: null }, tDepth: { value: null }, projInv: { value: new THREE.Matrix4() }, texel: { value: new THREE.Vector2() }, ao: { value: 1 }, outline: { value: 1 }, pixel: { value: 1 }, ortho: { value: 1 } },
    { transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
  private readonly glowQuad: THREE.Mesh;
  private readonly glowPass = pass(GLOW_FRAG, { tBlur: { value: null }, tSharp: { value: null }, strength: { value: 0.8 } }, { transparent: true });

  // the ground
  private readonly ground: THREE.Mesh;
  private readonly groundPass = new THREE.ShaderMaterial({ vertexShader: GROUND_VERT, fragmentShader: GROUND_FRAG, uniforms: { tShadow: { value: null }, opacity: { value: 0.3 }, tint: { value: new THREE.Color(0x000000) } }, transparent: true, depthWrite: false, toneMapped: false });
  private readonly shadowCast = new THREE.ShaderMaterial({ vertexShader: SHADOW_CAST_VERT, fragmentShader: SHADOW_CAST_FRAG, uniforms: { reach: { value: 1 }, ground: { value: 0 } }, side: THREE.DoubleSide });
  private shadowA: THREE.WebGLRenderTarget | null = null;
  private shadowB: THREE.WebGLRenderTarget | null = null;
  private readonly shadowCamera = new THREE.OrthographicCamera();
  private shadowDirty = true;
  private shadowKey = "";
  private slow = 0;
  /** the lights that stand in for the environment map on a slow GPU */
  private plain: PlainRig | null = null;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene, private readonly invalidate: () => void) {
    this.quality = { level: qualityOf(renderer), forced: forcedQuality() !== null };
    if (this.quality.level === "high") scene.environment = studioEnvironment(renderer); else this.plain = new PlainRig(scene);
    scene.add(this.key, this.key.target);
    const overlay = (m: THREE.Material, order: number): THREE.Mesh => {
      const q = new THREE.Mesh(quadGeometry, m);
      q.frustumCulled = false; q.renderOrder = order; q.visible = false; q.matrixAutoUpdate = false;
      q.raycast = () => {};
      scene.add(q);
      return q;
    };
    this.contactQuad = overlay(this.contactPass, -1000);
    this.glowQuad = overlay(this.glowPass, 9);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.groundPass);
    this.ground.renderOrder = -900; this.ground.visible = false; this.ground.raycast = () => {};
    scene.add(this.ground);
    this.quad.frustumCulled = false;
    this.offPrefs = subscribeViewPrefs(() => { this.prefs = getViewPrefs(); this.shadowDirty = true; this.invalidate(); });
  }

  /** Draw a halo round whatever is in this group (a domain's hover and selection highlights). */
  glowFrom(group: THREE.Object3D): void { this.glowSources.push(group); }
  /** The solids changed (were rebuilt, moved, hidden): the ground shadow is drawn again. */
  contentChanged(): void { this.shadowDirty = true; }

  setTheme(paper: THREE.Color, ink: THREE.Color): void {
    this.dark = paper.getHSL({ h: 0, s: 0, l: 0 }).l < 0.5;
    this.backdrop?.dispose();
    this.backdrop = backdropTexture(paper, ink);
    this.scene.background = this.backdrop;
    this.groundPass.uniforms.opacity.value = this.dark ? 0.55 : 0.36;
    this.groundPass.uniforms.tint.value.set(this.dark ? "#000000" : "#1a2433");
  }
  get isDark(): boolean { return this.dark; }

  dispose(): void {
    this.disposed = true;
    this.offPrefs();
    this.plain?.dispose();
    this.backdrop?.dispose();
    for (const t of [this.depth, this.aoA, this.aoB, this.glowA, this.glowB, this.glowSharp, this.shadowA, this.shadowB]) t?.dispose();
    for (const m of [this.normalMaterial, this.occluder, this.aoPass, this.aoBlur, this.gauss, this.contactPass, this.glowPass, this.groundPass, this.shadowCast]) m.dispose();
    this.ground.geometry.dispose();
    this.scene.remove(this.contactQuad, this.glowQuad, this.ground, this.key, this.key.target);
  }

  private target(old: THREE.WebGLRenderTarget | null, w: number, h: number, o: THREE.RenderTargetOptions = {}): THREE.WebGLRenderTarget {
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    if (old && old.width === w && old.height === h) return old;
    if (old) { old.dispose(); old.depthTexture?.dispose(); }
    return new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, ...o });
  }
  private draw(material: THREE.ShaderMaterial, to: THREE.WebGLRenderTarget): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(to);
    this.renderer.setClearColor(0x000000, 0); this.renderer.clear();
    this.renderer.render(this.quad, quadCamera);
  }

  /**
   * Before the viewport draws its frame: mark this frame's solids, and make what the overlays in the scene show
   * (the contact shading and outline, the halo, the ground shadow).
   */
  prepare(f: LookFrame): void {
    if (this.disposed) return;
    const high = this.quality.level === "high";
    if (!high) { this.plain?.aim(f.camera, f.target); return; }
    aimEnvironment(this.scene, f.camera);
    // this frame's solids, their box, and whether a section view cuts them
    const box = new THREE.Box3(), b = new THREE.Box3();
    let solids = 0, clipped = false, stamp = "";
    this.scene.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.userData.solid) return;
      const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material | undefined;
      const solid = !!mat && !mat.transparent && m.layers.isEnabled(0);
      if (solid) {
        m.layers.enable(SOLID_LAYER); solids++;
        if (mat!.clippingPlanes && mat!.clippingPlanes.length) clipped = true;
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        b.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld); box.union(b);
        stamp += m.geometry.id + ":" + m.matrixWorld.elements[12].toFixed(2) + "," + m.matrixWorld.elements[13].toFixed(2) + "," + m.matrixWorld.elements[14].toFixed(2) + ";";
      } else m.layers.disable(SOLID_LAYER);
    });
    const size = box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length();
    const contact = high && this.prefs.ao && solids > 0 && !clipped ? this.contact : 0;
    const glow = high && this.glowSources.some((g) => g.visible && g.children.length > 0);
    this.contactQuad.visible = contact > 0;
    this.glowQuad.visible = glow;
    const was = { target: this.renderer.getRenderTarget(), color: this.renderer.getClearColor(new THREE.Color()), alpha: this.renderer.getClearAlpha(), over: this.scene.overrideMaterial, back: this.scene.background, mask: f.camera.layers.mask };
    const t0 = performance.now();
    const W = f.width * f.pixelRatio, H = f.height * f.pixelRatio;
    try {
      this.scene.background = null;
      if (contact > 0) {
        // the solids alone, as depth and normals, with the depth range drawn tight round them
        this.depth = this.target(this.depth, W, H, { depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
        if (!this.depth.depthTexture) { this.depth.depthTexture = new THREE.DepthTexture(this.depth.width, this.depth.height); this.depth.depthTexture.type = THREE.FloatType; }
        const cam = this.tightCamera(f.camera, box);
        cam.layers.set(SOLID_LAYER);
        this.scene.overrideMaterial = this.normalMaterial;
        this.renderer.setRenderTarget(this.depth); this.renderer.setClearColor(0x000000, 0); this.renderer.clear();
        this.renderer.render(this.scene, cam);
        this.scene.overrideMaterial = null;
        // ambient occlusion at half size, then smoothed along both axes without crossing a step in depth
        this.aoA = this.target(this.aoA, W / 2, H / 2); this.aoB = this.target(this.aoB, W / 2, H / 2);
        const radius = Math.max(size * 0.05, f.pixelSize * 6);
        const u = this.aoPass.uniforms;
        u.tDepth.value = this.depth.depthTexture; u.tNormal.value = this.depth.texture; u.proj.value.copy(cam.projectionMatrix); u.projInv.value.copy(cam.projectionMatrixInverse); u.radius.value = radius; u.strength.value = 1.15;
        this.draw(this.aoPass, this.aoA);
        const ub = this.aoBlur.uniforms;
        ub.tDepth.value = this.depth.depthTexture; ub.tolerance.value = 0.02;
        ub.tAO.value = this.aoA.texture; ub.step_.value.set(1 / this.aoA.width, 0); this.draw(this.aoBlur, this.aoB);
        ub.tAO.value = this.aoB.texture; ub.step_.value.set(0, 1 / this.aoA.height); this.draw(this.aoBlur, this.aoA);
        const uc = this.contactPass.uniforms;
        uc.tAO.value = this.aoA.texture; uc.tDepth.value = this.depth.depthTexture; uc.projInv.value.copy(cam.projectionMatrixInverse); uc.texel.value.set(1 / this.depth.width, 1 / this.depth.height);
        uc.ao.value = 0.62 * contact; uc.outline.value = (this.dark ? 0.75 : 0.55) * contact;
        const persp = (f.camera as THREE.PerspectiveCamera).isPerspectiveCamera;
        uc.ortho.value = persp ? 0 : 1;
        uc.pixel.value = persp ? (2 * Math.tan(((f.camera as THREE.PerspectiveCamera).fov * Math.PI) / 360)) / H : f.pixelSize / f.pixelRatio;
      }
      if (glow) {
        // the highlights as they are drawn, hidden where a solid is in front, then blurred
        const w = W / 2, h = H / 2;
        this.glowSharp = this.target(this.glowSharp, w, h, { depthBuffer: true }); this.glowA = this.target(this.glowA, w, h); this.glowB = this.target(this.glowB, w, h);
        this.renderer.setRenderTarget(this.glowSharp); this.renderer.setClearColor(0x000000, 0); this.renderer.clear();
        if (solids) { f.camera.layers.set(SOLID_LAYER); this.scene.overrideMaterial = this.occluder; this.renderer.render(this.scene, f.camera); this.scene.overrideMaterial = null; f.camera.layers.mask = was.mask; }
        for (const g of this.glowSources) if (g.visible && g.children.length) this.renderer.render(g, f.camera);
        const ug = this.gauss.uniforms;
        const spread = 1.6;
        ug.tMap.value = this.glowSharp.texture; ug.step_.value.set(spread / w, 0); this.draw(this.gauss, this.glowA);
        ug.tMap.value = this.glowA.texture; ug.step_.value.set(0, spread / h); this.draw(this.gauss, this.glowB);
        ug.tMap.value = this.glowB.texture; ug.step_.value.set(spread * 2 / w, 0); this.draw(this.gauss, this.glowA);
        ug.tMap.value = this.glowA.texture; ug.step_.value.set(0, spread * 2 / h); this.draw(this.gauss, this.glowB);
        this.glowPass.uniforms.tBlur.value = this.glowB.texture; this.glowPass.uniforms.tSharp.value = this.glowSharp.texture;
      }
      // the ground shadow: only when the solids changed
      const ground = high && this.prefs.ground && solids > 0 && !clipped;
      this.ground.visible = ground;
      if (ground && (this.shadowDirty || stamp !== this.shadowKey)) { this.shadowDirty = false; this.shadowKey = stamp; this.castShadow(box, f.camera); }
    } finally {
      f.camera.layers.mask = was.mask;
      this.scene.overrideMaterial = was.over; this.scene.background = was.back;
      this.renderer.setRenderTarget(was.target); this.renderer.setClearColor(was.color, was.alpha);
    }
    // a GPU that cannot keep up while the view is turned loses the screen-space passes for good
    if (high && !this.quality.forced && f.navigating && (contact > 0 || glow)) {
      this.slow = performance.now() - t0 > 28 ? this.slow + 1 : Math.max(0, this.slow - 1);
      if (this.slow > 12) {
        this.quality.level = "low"; qualities.set(this.renderer, "low");
        this.contactQuad.visible = false; this.glowQuad.visible = false; this.ground.visible = false;
        this.scene.environment = null; this.plain = new PlainRig(this.scene); this.plain.aim(f.camera, f.target);
      }
    }
  }

  /** The frame's camera with its near and far planes drawn in round the solids: all of the depth buffer's precision on the model. */
  private tightCamera(camera: THREE.Camera, box: THREE.Box3): THREE.Camera {
    const o = camera as THREE.OrthographicCamera;
    if (!o.isOrthographicCamera || box.isEmpty()) return camera;
    const c = this.prepassCamera;
    c.left = o.left; c.right = o.right; c.top = o.top; c.bottom = o.bottom; c.zoom = o.zoom;
    c.position.copy(o.position); c.quaternion.copy(o.quaternion);
    const s = box.getBoundingSphere(new THREE.Sphere());
    const mid = s.center.clone().sub(o.position).dot(new THREE.Vector3(0, 0, -1).applyQuaternion(o.quaternion));
    c.near = mid - s.radius * 1.05 - 1e-3; c.far = mid + s.radius * 1.05 + 1e-3;
    c.updateProjectionMatrix(); c.updateMatrixWorld();
    return c;
  }

  /** Draw the shadow the solids throw on the ground they stand on: darkest where they touch it, gone a little way up. */
  private castShadow(box: THREE.Box3, camera: THREE.Camera): void {
    const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
    const side = Math.max(size.x, size.y, size.z * 0.5, 1e-3) * 1.7;
    const reach = Math.max(Math.max(size.x, size.y) * 0.22, size.z * 0.12, 1e-3);
    const R = 512;
    this.shadowA = this.target(this.shadowA, R, R, { depthBuffer: true }); this.shadowB = this.target(this.shadowB, R, R);
    const c = this.shadowCamera;
    c.left = -side / 2; c.right = side / 2; c.top = side / 2; c.bottom = -side / 2; c.near = 0; c.far = reach + 1e-3;
    c.up.set(0, 1, 0); c.position.set(centre.x, centre.y, box.min.z - 1e-3); c.lookAt(centre.x, centre.y, box.min.z + 1);
    c.updateProjectionMatrix(); c.updateMatrixWorld();
    c.layers.set(SOLID_LAYER);
    this.shadowCast.uniforms.reach.value = reach; this.shadowCast.uniforms.ground.value = box.min.z;
    this.scene.overrideMaterial = this.shadowCast;
    this.renderer.setRenderTarget(this.shadowA); this.renderer.setClearColor(0x000000, 0); this.renderer.clear();
    this.renderer.render(this.scene, c);
    this.scene.overrideMaterial = null;
    const u = this.gauss.uniforms;
    for (const spread of [1.2, 2.4, 4]) {
      u.tMap.value = this.shadowA.texture; u.step_.value.set(spread / R, 0); this.draw(this.gauss, this.shadowB);
      u.tMap.value = this.shadowB.texture; u.step_.value.set(0, spread / R); this.draw(this.gauss, this.shadowA);
    }
    this.groundPass.uniforms.tShadow.value = this.shadowA.texture;
    this.ground.scale.set(side, side, 1);
    this.ground.position.set(centre.x, centre.y, box.min.z - Math.max(size.length() * 2e-4, 1e-4));
    this.ground.updateMatrixWorld();
    void camera;
  }
}

const qualities = new WeakMap<THREE.WebGLRenderer, Quality>();
/** What this renderer's GPU can afford (worked out once; a viewport that proves too slow lowers it). */
export function qualityOf(renderer: THREE.WebGLRenderer): Quality {
  let q = qualities.get(renderer);
  if (!q) { q = detectQuality(renderer); qualities.set(renderer, q); }
  return q;
}
function detectQuality(renderer: THREE.WebGLRenderer): Quality {
  const forced = forcedQuality();
  if (forced) return forced;
  try {
    const gl = renderer.getContext(), ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    if (/swiftshader|llvmpipe|software|softpipe|basic render/i.test(name)) return "low";
  } catch { /* no name: assume a real GPU */ }
  return "high";
}
