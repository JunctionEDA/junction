// loader.ts — fetches the render engine (static/dist/cad-render.js) the first time it is wanted.  The engine is
// three.js again, a path tracer and two film writers: most of a megabyte that nobody who only models should pay
// for, so it is not part of the editors' bundles.
import type { RenderBundle } from "./api";

let loading: Promise<RenderBundle> | null = null;
const found = (): RenderBundle | null => (window as unknown as { JunctionRender?: RenderBundle }).JunctionRender || null;

export function loadRenderBundle(): Promise<RenderBundle> {
  const have = found();
  if (have) return Promise.resolve(have);
  if (!loading) {
    loading = new Promise<RenderBundle>((resolve, reject) => {
      const v = (globalThis as { __kcAssetV?: string }).__kcAssetV;
      const s = document.createElement("script");
      s.src = "/static/dist/cad-render.js" + (v ? "?v=" + v : "");
      s.onload = () => { const b = found(); if (b) resolve(b); else reject(new Error("The render engine did not start.")); };
      s.onerror = () => reject(new Error("The render engine could not be fetched. Check the connection and try again."));
      document.head.appendChild(s);
    });
    // a failed fetch may be tried again
    loading.catch(() => { loading = null; });
  }
  return loading;
}

/** True when a person (or a test) asked for rendering even where graphics are drawn by the processor. */
export function renderForced(): boolean {
  try { return localStorage.getItem("junction.cad.render.force") === "1" || localStorage.getItem("junction.cad.quality") === "high"; } catch { return false; }
}
