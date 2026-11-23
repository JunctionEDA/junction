// mode.ts — Render mode for a 3D viewport: the model as a photograph instead of a drawing.
//
// Turned on, a canvas of the render engine's is laid over the viewport and shows what the viewport shows, path
// traced: the same camera, the model's own materials, studio lights and a ground.  The picture refines while
// nothing moves and starts again when the view, the model or a setting changes.  The viewport underneath keeps
// working — the pointer still turns and zooms it, and it is what is seen while the view is in motion on a machine
// too slow to trace as it moves.  From here a still is saved at any size and a turntable film is rendered.
//
// It knows nothing of parts or assemblies: an editor hands it a `RenderSource` (what to draw, and when that
// changed).  The engine is fetched on first use (loader.ts); a browser or machine that cannot run it gets a
// sentence saying why and keeps the ordinary viewport.
import type { Viewport3D } from "../viewport3d/viewport3d";
import type { FilmSink, RenderBundle, RenderEngine, RenderScene } from "./api";
import { environmentSpec } from "./environments";
import { loadRenderBundle, renderForced } from "./loader";
import { boxCentre, pickPoint, sceneBox } from "./pick";
import { DEFAULT_TURNTABLE, IMAGE_SIZES, MAX_IMAGE_SIDE, cleanSettings, cleanTurntable, loadSettings, qualityOf, storeSettings, type RenderSettings, type TurntableSettings } from "./settings";
import { formatEta, turntableCamera, turntableTiming, type RenderCamera, type TurntableSpec, type Vec3 } from "./turntable";
import type { FilmFormat } from "./video";

/** Something an editor can film besides turning the model round: an exploded view coming apart, a mechanism moving. */
export interface RenderMotion {
  id: string; title: string;
  /** Put the model where it is at `t` (0 … 1) of the motion. */
  pose(t: number): void | Promise<void>;
  /** Put it back as it was. */
  restore(): void | Promise<void>;
}

export interface RenderSource {
  /** What is on screen now, as triangles and surfaces. */
  scene(): RenderScene | Promise<RenderScene>;
  /** Call `changed` whenever `scene()` would return something else.  Returns how to stop. */
  subscribe(changed: () => void): () => void;
  /** A message for the person. */
  toast(text: string, ms?: number): void;
  /** What the saved files are called (the document's name), without an extension. */
  name(): string;
  /** The projection was changed from here (depth of field needs a perspective view): keep the editor's own switch in step. */
  projectionChanged?(): void;
  /** Motions of the model that can be filmed. */
  motions?(): RenderMotion[];
}

export type RenderPhase = "off" | "loading" | "preparing" | "rendering" | "done" | "paused";
export interface RenderJob { kind: "image" | "film"; label: string; fraction: number; eta: string }
export interface RenderModeState {
  on: boolean; phase: RenderPhase;
  /** why it could not start, or what went wrong */
  error: string;
  samples: number; target: number;
  /** pixels the live picture is traced at */
  size: [number, number];
  triangles: number;
  settings: RenderSettings;
  turntable: TurntableSettings;
  /** which of IMAGE_SIZES a still is saved at */
  imageSize: string;
  /** what a film is of: "turntable", or a motion's id */
  filmOf: string;
  job: RenderJob | null;
  /** waiting for a click on the model: the point to focus on */
  focusing: boolean;
  /** graphics are drawn by the processor: it works, slowly */
  software: boolean;
  /** what the last finished job produced */
  last: { name: string; bytes: number; note: string } | null;
}

const TURNTABLE_KEY = "junction.cad.render.turntable";

const ids = new WeakMap<object, number>();
let lastId = 0;
const idOf = (o: object): number => { let i = ids.get(o); if (!i) { i = ++lastId; ids.set(o, i); } return i; };
/**
 * What a scene is, as a string: the same arrays in the same places with the same surfaces give the same one.  An
 * editor says "changed" more often than anything changed (a selection redraws); only a scene that differs is
 * traced again.
 */
export function sceneSignature(scene: RenderScene): string {
  return scene.meshes.map((m) => `${idOf(m.positions)}/${idOf(m.indices)}/${m.matrix ? Array.from(m.matrix, (v) => v.toFixed(4)).join(",") : ""}/${m.groups.map((g) => `${g.start}+${g.count}:${JSON.stringify(g.surface)}`).join(";")}`).join("|");
}
const modes = new WeakMap<Viewport3D, RenderMode>();
/** The viewport's Render mode (one each), made on first use. */
export function renderModeOf(viewport: Viewport3D, source: () => RenderSource): RenderMode {
  let m = modes.get(viewport);
  if (!m) { m = new RenderMode(viewport, source()); modes.set(viewport, m); }
  return m;
}
/** The viewport's Render mode if it has ever been made. */
export const renderModeIfAny = (viewport: Viewport3D): RenderMode | null => modes.get(viewport) || null;

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name; a.hidden = true;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export class RenderMode {
  private state: RenderModeState;
  private listeners = new Set<() => void>();
  private bundle: RenderBundle | null = null;
  private engine: RenderEngine | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private scene: RenderScene | null = null;
  private frame = 0;
  private stop: (() => void)[] = [];
  private signature = "";
  private lastMove = 0;
  private moving = false;
  /** frames come quickly enough while tracing that the view can be traced as it moves */
  private brisk = false;
  private lastStep = 0;
  private sceneDirty = false;
  private sceneChecked = 0;
  private sceneBusy = false;
  /** the scene being traced, and one seen since that differs from it (traced once it stops changing) */
  private sceneSig = "";
  private pendingSig: string | null = null;
  private entering = 0;
  private cancel: { cancelled: boolean } | null = null;

  constructor(readonly viewport: Viewport3D, readonly source: RenderSource) {
    let turntable = DEFAULT_TURNTABLE;
    try { turntable = cleanTurntable(JSON.parse(localStorage.getItem(TURNTABLE_KEY) || "{}")); } catch { /* the defaults */ }
    this.state = { on: false, phase: "off", error: "", samples: 0, target: 0, size: [0, 0], triangles: 0, settings: loadSettings(), turntable, imageSize: "fhd", filmOf: "turntable", job: null, focusing: false, software: false, last: null };
  }

  getState = (): RenderModeState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<RenderModeState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of Array.from(this.listeners)) fn();
  }

  toggle(): void { if (this.state.on) this.exit(); else void this.enter(); }

  // ---------------------------------------------------------------- on and off
  async enter(): Promise<void> {
    if (this.state.on) return;
    const token = ++this.entering;
    this.set({ on: true, phase: "loading", error: "", samples: 0, last: null });
    try {
      const bundle = await loadRenderBundle();
      if (token !== this.entering || !this.state.on) return;
      const support = bundle.support(renderForced());
      if (!support.ok) return this.fail(support.reason || "This browser cannot render.");
      this.bundle = bundle;
      const canvas = document.createElement("canvas");
      // over the viewport's own canvas and under everything the editor lays over it; the pointer goes through
      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;z-index:1;opacity:0;transition:opacity 120ms";
      canvas.dataset.renderCanvas = "";
      this.viewport.canvas.after(canvas);
      this.canvas = canvas;
      let engine: RenderEngine;
      try { engine = bundle.create(canvas); } catch (e) { canvas.remove(); this.canvas = null; return this.fail(`Rendering could not start: ${e instanceof Error ? e.message : String(e)}`); }
      this.engine = engine;
      engine.onLost = () => this.fail("The graphics card stopped answering (its context was lost), so Render mode was turned off. Turn it on again to carry on.");
      engine.setSettings(this.state.settings);
      this.resize();
      this.signature = ""; this.syncCamera();
      const onFrame = (): void => this.syncCamera();
      this.viewport.onFrame.push(onFrame);
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(this.viewport.host);
      const visible = (): void => { if (this.state.on && !this.state.job) this.set({ phase: document.hidden ? "paused" : this.state.samples >= this.state.target && this.state.target > 0 ? "done" : "rendering" }); };
      document.addEventListener("visibilitychange", visible);
      const unsub = this.source.subscribe(() => { this.sceneDirty = true; });
      this.stop = [() => { const i = this.viewport.onFrame.indexOf(onFrame); if (i >= 0) this.viewport.onFrame.splice(i, 1); }, () => ro.disconnect(), () => document.removeEventListener("visibilitychange", visible), unsub];
      this.set({ phase: "preparing", software: support.software });
      (window as unknown as { JunctionRenderMode?: RenderMode }).JunctionRenderMode = this;
      await this.loadScene(true);
      if (token !== this.entering || !this.state.on) return;
      this.loop();
    } catch (e) {
      if (token === this.entering) this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  /** Stop with a reason: the ordinary viewport is back, and the reason is there to read. */
  private fail(message: string): void {
    this.teardown();
    this.set({ on: false, phase: "off", error: message, job: null, focusing: false });
    this.source.toast(message, 7000);
  }

  exit(): void {
    if (!this.state.on) return;
    this.entering++;
    if (this.cancel) this.cancel.cancelled = true;
    this.teardown();
    this.set({ on: false, phase: "off", job: null, focusing: false, samples: 0 });
  }

  private teardown(): void {
    cancelAnimationFrame(this.frame); this.frame = 0;
    for (const fn of this.stop) { try { fn(); } catch { /* already gone */ } }
    this.stop = [];
    this.endFocus();
    if (this.engine) { this.engine.onLost = null; try { this.engine.dispose(); } catch { /* a lost context */ } this.engine = null; }
    this.canvas?.remove(); this.canvas = null;
    this.scene = null; this.sceneBusy = false; this.sceneDirty = false; this.sceneSig = ""; this.pendingSig = null;
    this.viewport.invalidate();
  }

  // ---------------------------------------------------------------- keeping up with the viewport
  /** The viewport's camera, as the engine takes one. */
  camera(): RenderCamera {
    const v = this.viewport, q = v.camera.quaternion, t = v.target;
    return { projection: v.projection, quaternion: [q.x, q.y, q.z, q.w], target: [t.x, t.y, t.z], height: (v.camera.top - v.camera.bottom) / v.camera.zoom, fov: v.perspectiveCamera.fov };
  }

  private syncCamera(): void {
    if (!this.engine) return;
    const c = this.camera();
    const sig = `${c.projection}|${c.quaternion.map((x) => x.toFixed(6)).join(",")}|${c.target.map((x) => x.toFixed(4)).join(",")}|${c.height.toFixed(4)}`;
    if (sig === this.signature) return;
    const first = this.signature === "";
    this.signature = sig;
    this.engine.setCamera(c);
    if (first) return;
    this.lastMove = performance.now();
    this.moving = true;
    this.engine.restart(true);
    if (this.state.samples) this.set({ samples: 0, phase: "rendering" });
  }

  private resize(): void {
    if (!this.engine) return;
    this.engine.resize(this.viewport.width, this.viewport.height, Math.min(2, window.devicePixelRatio || 1));
  }

  /**
   * Look at the model again.  A scene that is what is being traced changes nothing.  One that differs hides the
   * picture (the viewport shows the model as it changes) and is traced when it is the same twice running: a
   * drag or a mechanism playing is not traced frame by frame.  `now` skips the wait.
   */
  private async loadScene(now = false): Promise<void> {
    if (!this.engine || this.sceneBusy) return;
    this.sceneBusy = true; this.sceneDirty = false;
    try {
      const scene = await this.source.scene();
      if (!this.engine) return;
      const sig = sceneSignature(scene);
      if (!now) {
        if (sig === this.sceneSig) { this.pendingSig = null; return; }
        if (sig !== this.pendingSig) {
          // changed once: the picture stays until the new one is ready; still changing: the viewport takes over
          if (this.pendingSig !== null && this.canvas) this.canvas.style.opacity = "0";
          this.pendingSig = sig; this.sceneDirty = true; return;
        }
      }
      this.pendingSig = null;
      await this.engine.setScene(scene);
      this.scene = scene; this.sceneSig = sig;
      this.set({ triangles: this.engine.stats().triangles, samples: 0, phase: scene.meshes.length ? "rendering" : "preparing", error: scene.meshes.length ? "" : "There is nothing to render yet." });
    } catch (e) {
      // a scene that cannot be traced (too large) leaves Render mode: the viewport is the picture
      this.fail(e instanceof Error ? e.message : String(e));
    } finally { this.sceneBusy = false; }
  }

  private loop = (): void => {
    this.frame = 0;
    const engine = this.engine;
    if (!engine || !this.state.on) return;
    this.frame = requestAnimationFrame(this.loop);
    if (document.hidden || this.state.job) return;
    const now = performance.now();
    if (this.sceneDirty && !this.sceneBusy && now - this.sceneChecked > 150) { this.sceneChecked = now; void this.loadScene(); return; }
    // the model is changing (a rebuild, a drag, a mechanism playing): the viewport shows it until it rests
    if (this.sceneBusy || this.pendingSig !== null) return;
    if (this.moving && now - this.lastMove > 160) { this.moving = false; engine.restart(false); }
    // a machine that traces slowly shows the ordinary viewport while the view moves, and traces when it rests
    if (this.moving && !this.brisk) { if (this.canvas) this.canvas.style.opacity = "0"; return; }
    const dt = this.lastStep ? now - this.lastStep : 0; this.lastStep = now;
    const p = engine.step();
    if (!this.moving && p.samples >= 2 && p.samples < p.target && dt > 0) this.brisk = dt < 45;
    if (this.canvas) this.canvas.style.opacity = p.samples >= 1 ? "1" : this.canvas.style.opacity;
    const phase: RenderPhase = p.done ? "done" : "rendering";
    const s = this.state;
    if (p.samples !== s.samples || p.target !== s.target || phase !== s.phase || p.width !== s.size[0] || p.height !== s.size[1]) this.set({ samples: p.samples, target: p.target, phase, size: [p.width, p.height] });
  };

  // ---------------------------------------------------------------- settings
  setSettings(patch: Partial<RenderSettings>): void {
    let next = cleanSettings({ ...this.state.settings, ...patch });
    // an environment brings the ground that suits it, unless the ground is what was just chosen
    if (patch.environment && patch.environment !== this.state.settings.environment && !patch.ground) {
      const suited = environmentSpec(patch.environment).ground || "shadow";
      if (this.state.settings.ground !== "none") next = { ...next, ground: suited };
    }
    // depth of field is a lens's: it needs a perspective view
    if (next.dof && this.viewport.projection !== "perspective") this.setPerspective(true);
    storeSettings(next);
    this.set({ settings: next });
    this.engine?.setSettings(next);
  }
  setTurntable(patch: Partial<TurntableSettings>): void {
    const next = cleanTurntable({ ...this.state.turntable, ...patch });
    try { localStorage.setItem(TURNTABLE_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    this.set({ turntable: next });
  }
  setImageSize(id: string): void { if (IMAGE_SIZES.some((s) => s.id === id)) this.set({ imageSize: id }); }
  setFilmOf(id: string): void { this.set({ filmOf: id }); }
  setPerspective(on: boolean): void {
    this.viewport.setProjection(on ? "perspective" : "orthographic");
    if (this.source.projectionChanged) this.source.projectionChanged();
    if (!on && this.state.settings.dof) this.setSettings({ dof: false }); else this.set({});
  }

  // ---------------------------------------------------------------- focus
  /** Wait for a click on the model: that point is what the lens focuses on. */
  focusByClick(): void {
    if (!this.state.on || this.state.focusing) { this.endFocus(); return; }
    const host = this.viewport.host;
    const down = (ev: PointerEvent): void => {
      if (ev.button !== 0 || ev.target !== this.viewport.canvas) return;
      ev.preventDefault(); ev.stopPropagation();
      const ray = this.viewport.ray(ev);
      const hit = this.scene ? pickPoint(this.scene, [ray.origin.x, ray.origin.y, ray.origin.z], [ray.direction.x, ray.direction.y, ray.direction.z]) : null;
      this.endFocus();
      if (!hit) { this.source.toast("Click on the model to focus there.", 2500); return; }
      this.setSettings({ dof: true, focus: hit });
    };
    const key = (ev: KeyboardEvent): void => { if (ev.key === "Escape") { ev.stopPropagation(); this.endFocus(); } };
    host.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    host.style.cursor = "crosshair";
    this.focusOff = () => { host.removeEventListener("pointerdown", down, true); window.removeEventListener("keydown", key, true); host.style.cursor = ""; };
    this.set({ focusing: true });
  }
  private focusOff: (() => void) | null = null;
  private endFocus(): void {
    if (this.focusOff) { this.focusOff(); this.focusOff = null; }
    if (this.state.focusing) this.set({ focusing: false });
  }

  // ---------------------------------------------------------------- a still
  /** The size a still would be saved at now. */
  imagePixels(): [number, number] {
    const s = IMAGE_SIZES.find((x) => x.id === this.state.imageSize);
    if (s && s.width) return [s.width, s.height];
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    return [Math.min(MAX_IMAGE_SIDE, Math.round(this.viewport.width * ratio)), Math.min(MAX_IMAGE_SIDE, Math.round(this.viewport.height * ratio))];
  }

  /** Render a still at the chosen size (or the one given) and hand it to the browser's downloads.  Resolves with the PNG. */
  async saveImage(size?: { width: number; height: number; samples?: number }): Promise<Blob | null> {
    const engine = this.engine;
    if (!engine || this.state.job) return null;
    const [w, h] = size ? [size.width, size.height] : this.imagePixels();
    const samples = size?.samples ?? qualityOf(this.state.settings.quality).samples;
    const signal = (this.cancel = { cancelled: false }), started = performance.now();
    this.set({ job: { kind: "image", label: `${w} × ${h}`, fraction: 0, eta: "" }, last: null });
    try {
      const canvas = await engine.renderStill({ width: w, height: h, samples, signal, onProgress: (f) => this.progress("image", `${w} × ${h}`, f, started) });
      const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
      if (!blob) throw new Error("The picture could not be saved as a PNG.");
      const name = `${this.source.name()}.png`;
      download(blob, name);
      this.set({ last: { name, bytes: blob.size, note: "" } });
      return blob;
    } catch (e) {
      if (!(e instanceof Error && e.name === "AbortError")) this.source.toast(e instanceof Error ? e.message : String(e), 6000);
      return null;
    } finally { this.cancel = null; if (this.state.on) this.set({ job: null, samples: 0, phase: "rendering" }); }
  }

  private progress(kind: RenderJob["kind"], label: string, fraction: number, started: number): void {
    const elapsed = (performance.now() - started) / 1000;
    const eta = fraction > 0.02 && elapsed > 1.5 ? formatEta((elapsed * (1 - fraction)) / fraction) : "";
    this.set({ job: { kind, label, fraction, eta } });
  }

  cancelJob(): void { if (this.cancel) this.cancel.cancelled = true; }

  // ---------------------------------------------------------------- a film
  /** The centre of what is drawn: where the turntable's axis stands. */
  centre(): Vec3 { const box = this.scene ? sceneBox(this.scene) : null; return box ? boxCentre(box) : [this.viewport.target.x, this.viewport.target.y, this.viewport.target.z]; }

  /** The turntable as the camera path it is. */
  turntableSpec(frames: number): TurntableSpec {
    const t = this.state.turntable;
    return { axis: t.axis === "x" ? [1, 0, 0] : t.axis === "y" ? [0, 1, 0] : [0, 0, 1], centre: this.centre(), frames, turns: t.turns, elevation: t.elevation, path: t.path, rise: t.rise };
  }

  /**
   * Render the film that is set up (a turntable, or one of the editor's motions) frame by frame and hand it to the
   * browser's downloads.  `allow` narrows the formats (a test asks for the fallbacks).  Resolves with the file.
   */
  async renderFilm(allow?: readonly FilmFormat[]): Promise<Blob | null> {
    const engine = this.engine, bundle = this.bundle;
    if (!engine || !bundle || this.state.job) return null;
    const t = this.state.turntable, timing = turntableTiming(t.duration, t.fps);
    const motion = this.state.filmOf === "turntable" ? null : (this.source.motions ? this.source.motions() : []).find((m) => m.id === this.state.filmOf) || null;
    const signal = (this.cancel = { cancelled: false }), started = performance.now();
    const label = motion ? motion.title : "Turntable";
    let sink: FilmSink | null = null;
    this.set({ job: { kind: "film", label, fraction: 0, eta: "" }, last: null });
    try {
      const plan = await bundle.planFilm(t.width, t.height, t.fps, allow);
      sink = bundle.film(plan);
      const start = this.camera(), spec = this.turntableSpec(timing.frames), n = timing.frames;
      for (let i = 0; i < n; i++) {
        if (signal.cancelled) { const e = new Error("stopped"); e.name = "AbortError"; throw e; }
        let camera = start;
        if (motion) {
          await motion.pose(n > 1 ? i / (n - 1) : 0);
          const scene = await this.source.scene();
          await engine.setScene(scene); this.scene = scene; this.sceneSig = sceneSignature(scene);
        } else camera = turntableCamera(start, spec, i);
        const canvas = await engine.renderStill({ width: plan.width, height: plan.height, samples: t.samples, camera, signal, onProgress: (f) => this.progress("film", `${label}: frame ${i + 1} of ${n}`, (i + f) / n, started) });
        await sink.add(canvas);
      }
      const blob = await sink.finish();
      const name = `${this.source.name()}-${motion ? motion.id : "turntable"}.${plan.extension}`;
      download(blob, name);
      this.set({ last: { name, bytes: blob.size, note: plan.note || "" } });
      if (plan.note) this.source.toast(plan.note + ".", 6000);
      return blob;
    } catch (e) {
      sink?.cancel();
      if (!(e instanceof Error && e.name === "AbortError")) this.source.toast(e instanceof Error ? e.message : String(e), 6000);
      return null;
    } finally {
      this.cancel = null;
      if (motion) { try { await motion.restore(); } catch { /* the editor's own state */ } this.sceneDirty = true; }
      if (this.state.on) this.set({ job: null, samples: 0, phase: "rendering" });
    }
  }
}
