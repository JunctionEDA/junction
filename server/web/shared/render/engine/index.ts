// index.ts — the render engine's bundle (static/dist/cad-render.js): three.js, the path tracer, the denoiser and
// the film writers, fetched the first time Render mode is turned on (shared/render/loader.ts) and never before.
// It puts `JunctionRender` on the window: shared/render/api.ts says what that is.
import "./prelude";
import type { RenderBundle } from "../api";
import { FilmWriter, planFilm } from "../video";
import { Engine, support } from "./engine";

const bundle: RenderBundle = {
  version: 1,
  support,
  create: (canvas) => new Engine(canvas),
  planFilm,
  film: (plan) => new FilmWriter(plan),
};
(window as unknown as { JunctionRender: RenderBundle }).JunctionRender = bundle;
// the editor's three.js mark, set aside by prelude.ts
const w = window as unknown as { __THREE__?: string; __junctionThree?: string };
if (w.__junctionThree) { w.__THREE__ = w.__junctionThree; delete w.__junctionThree; }
