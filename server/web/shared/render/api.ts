// api.ts — the line between a 3D editor and the render engine.
//
// The engine (shared/render/engine, the bundle static/dist/cad-render.js) is fetched the first time someone
// turns Render mode on: it carries its own copy of three.js and the path tracer, so nothing that crosses this
// line is a three.js object.  A scene is plain typed arrays and numbers; a camera is the viewport's
// (turntable.ts RenderCamera); the engine draws into a canvas of its own that the editor lays over its viewport.
import type { PhysicalSurface } from "./materials";
import type { RenderSettings } from "./settings";
import type { RenderCamera } from "./turntable";
import type { FilmFormat, FilmPlan } from "./video";

/** One solid as triangles.  The arrays are read, never changed or kept past the next `setScene`. */
export interface RenderMesh {
  positions: Float32Array; normals: Float32Array; indices: Uint32Array;
  /** where it stands: a 4 × 4, column-major as three.js keeps one (absent: where the triangles already are) */
  matrix?: ArrayLike<number> | null;
  /** runs of the index array (in indices, not triangles) and what each is made of; together they cover it */
  groups: { start: number; count: number; surface: PhysicalSurface }[];
}
/** Everything to be drawn, in model space: millimetres, Z up. */
export interface RenderScene { meshes: RenderMesh[] }

export interface RenderSupport {
  ok: boolean;
  /** why not, in words for a person */
  reason?: string;
  /** the graphics are drawn by the processor (no graphics card in use): it works, slowly */
  software: boolean;
  /** what the browser says draws its graphics, when it says */
  renderer: string;
  /** the largest texture side: a tile of a still is never larger */
  maxTexture: number;
}

export interface RenderProgress { samples: number; target: number; done: boolean; /** pixels traced each way */ width: number; height: number }

export interface StillOptions {
  width: number; height: number; samples: number;
  /** the camera of this picture (absent: the live one) */
  camera?: RenderCamera;
  /** called as it goes: 0…1 */
  onProgress?: (fraction: number) => void;
  /** set `cancelled` to stop: the promise then rejects with an Error named "AbortError" */
  signal?: { cancelled: boolean };
}

export interface RenderEngine {
  /** Replace what is drawn.  Rejects with a message for a person when the scene is too large to trace. */
  setScene(scene: RenderScene): Promise<void>;
  setCamera(camera: RenderCamera): void;
  setSettings(settings: RenderSettings): void;
  /** The canvas's size in CSS pixels and the device's pixel ratio. */
  resize(width: number, height: number, pixelRatio: number): void;
  /** Trace a little more and show it.  Call once per animation frame while the picture is on screen. */
  step(): RenderProgress;
  /** The view moved or is moving: the picture restarts, coarser until `moving` is false again. */
  restart(moving?: boolean): void;
  /** A picture at any size, traced apart from the live one (in tiles when large) and returned as a canvas. */
  renderStill(options: StillOptions): Promise<HTMLCanvasElement>;
  /** Triangles in the scene and the bytes of graphics memory the live picture holds, roughly. */
  stats(): { triangles: number; bytes: number };
  /** Called when the graphics context is lost: the engine is dead, make another. */
  onLost: (() => void) | null;
  dispose(): void;
}

export interface FilmSink { readonly plan: FilmPlan; add(canvas: HTMLCanvasElement): Promise<void>; finish(): Promise<Blob>; cancel(): void }

/** What the bundle puts on `window.JunctionRender`. */
export interface RenderBundle {
  version: number;
  /** Whether this browser and machine can trace at all.  `force` accepts graphics drawn by the processor. */
  support(force?: boolean): RenderSupport;
  create(canvas: HTMLCanvasElement): RenderEngine;
  planFilm(width: number, height: number, fps: number, allow?: readonly FilmFormat[]): Promise<FilmPlan>;
  film(plan: FilmPlan): FilmSink;
}

/** The most triangles a scene may have: beyond it the acceleration structure and its textures outgrow what browsers give a page. */
export const MAX_TRIANGLES = 6_000_000;
