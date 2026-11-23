// Panel.tsx — Render mode's controls: how far the picture has got, the lights, the ground and backdrop, the
// camera (exposure, depth of field), how long to spend, and saving a still or a turntable film.  One component
// for every editor that has a Render mode; each puts it where its own panels go.
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Select } from "../components/Select";
import { cx } from "../util";
import { ENVIRONMENTS, environmentSpec } from "./environments";
import type { RenderMode } from "./mode";
import { BACKGROUNDS, GROUNDS, IMAGE_SIZES, QUALITIES, TURNTABLE_SIZES, qualityOf } from "./settings";
import { TONE_MAPS } from "./tonemap";
import { turntableTiming } from "./turntable";

const FSTOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22];
const bytes = (n: number): string => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  // not a <label>: a row may hold two controls, and a click on one must not land on the other
  return <div className="flex items-center gap-1.5 text-xs text-ink-2 min-h-6" title={title}><span className="w-16 flex-none">{label}</span>{children}</div>;
}
function Seg<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: readonly { id: T; title: string; hint?: string }[]; onPick(id: T): void }) {
  return (
    <div className="seg flex flex-1 min-w-0" role="radiogroup" aria-label={label}>
      {options.map((o) => <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={cx("flex-1 min-w-0 px-0.5 text-xs whitespace-nowrap", value === o.id && "on")} title={o.hint} data-render-option={o.id} onClick={() => onPick(o.id)}>{o.title}</button>)}
    </div>
  );
}
function Slider({ label, value, min, max, step, show, onChange }: { label: string; value: number; min: number; max: number; step: number; show: string; onChange(v: number): void }) {
  return (
    <Row label={label}>
      <input type="range" className="flex-1 min-w-0" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={() => onChange(label === "Brightness" ? 1 : 0)} />
      <span className="mono w-11 text-right text-ink">{show}</span>
    </Row>
  );
}
function Number_({ label, value, min, max, step, unit, onChange, wide }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange(v: number): void; wide?: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <input key={value} type="number" className={cx("input mono h-6 text-xs", wide ? "w-16" : "w-14")} min={min} max={max} step={step} defaultValue={value} aria-label={label}
        onBlur={(e) => { const v = Number(e.target.value); if (e.target.value !== "" && Number.isFinite(v) && v !== value) onChange(v); }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      {unit ? <span className="text-ink-3">{unit}</span> : null}
    </span>
  );
}
function Head({ children }: { children: ReactNode }) { return <div className="pt-1 text-2xs uppercase tracking-wide text-ink-3 mono">{children}</div>; }

/** The controls.  `onClose` leaves Render mode. */
export function RenderPanel({ mode, onClose }: { mode: RenderMode; onClose?: () => void }) {
  const s = useSyncExternalStore(mode.subscribe, mode.getState);
  const [film, setFilm] = useState(false);
  // folded to its first lines: the picture is what is looked at
  const [folded, setFolded] = useState(false);
  const set = s.settings, t = s.turntable, q = qualityOf(set.quality);
  const persp = mode.viewport.projection === "perspective";
  const busy = !!s.job;
  const status = s.phase === "loading" ? "Fetching the render engine…" : s.phase === "preparing" ? (s.error || "Preparing the model…") : s.phase === "paused" ? "Paused while this tab is hidden" : s.samples < 1 ? "Starting…" : s.phase === "done" ? `Done: ${s.samples} samples` : `${s.samples} of ${s.target} samples`;
  const fraction = s.job ? s.job.fraction : s.target ? Math.min(1, s.samples / s.target) : 0;
  const timing = turntableTiming(t.duration, t.fps);
  const sizeId = TURNTABLE_SIZES.find((x) => x.width === t.width && x.height === t.height);
  const [iw, ih] = mode.imagePixels();
  const motions = mode.source.motions ? mode.source.motions() : [];
  const backdrop = set.backgroundColor || environmentSpec(set.environment).backdrop;
  return (
    <div className="flex flex-col gap-1.5 p-2 pt-0 text-sm" data-render-panel data-phase={s.phase} data-samples={s.samples} role="group" aria-label="Render">
      {/* the title, the progress and Cancel stay in sight while the settings below are scrolled */}
      <div className="sticky top-0 z-[1] -mx-2 flex flex-col gap-1.5 bg-panel px-2 pt-2 pb-0.5">
      <div className="flex items-center gap-1">
        <span className="flex-1 font-semibold text-ink">Render</span>
        <button type="button" className="btn sm ghost h-5 px-1" aria-expanded={!folded} title={folded ? "Show the settings" : "Fold the settings away"} data-render-fold onClick={() => setFolded(!folded)}>{folded ? "Settings" : "Fold"}</button>
        {onClose ? <button type="button" className="btn sm ghost h-5 px-1" title="Leave Render mode" data-render-close onClick={onClose}>Close</button> : null}
      </div>
      <div className="flex flex-col gap-1" aria-live="polite">
        <div className="h-1 rounded-sm bg-bench overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}><div className="h-full bg-mark" style={{ width: `${fraction * 100}%` }} /></div>
        <div className="flex items-center gap-1 text-xs text-ink-2 min-h-5">
          <span className="flex-1 truncate" data-render-status>{s.job ? `${s.job.label}${s.job.eta ? `, about ${s.job.eta} left` : ""}` : status}</span>
          {s.job ? <button type="button" className="btn sm h-5 px-1.5" data-render-cancel onClick={() => mode.cancelJob()}>Cancel</button> : s.size[0] ? <span className="mono text-ink-3">{s.size[0]} × {s.size[1]}</span> : null}
        </div>
        {s.software ? <p className="note m-0 text-xs">Graphics are drawn by the processor here, so rendering is slow.</p> : null}
      </div>
      </div>

      {folded ? null : <>
      <Head>Lights</Head>
      <Select className="input w-full" value={set.environment} label="Lighting environment" data={{ render: "environment" }} disabled={busy} onChange={(v) => mode.setSettings({ environment: v as typeof set.environment })}
        options={ENVIRONMENTS.map((e) => ({ value: e.id, label: e.title, title: e.hint }))} />
      <Slider label="Turn" value={set.rotation} min={0} max={360} step={5} show={`${Math.round(set.rotation)}°`} onChange={(v) => mode.setSettings({ rotation: v })} />
      <Slider label="Brightness" value={set.intensity} min={0.2} max={3} step={0.05} show={`${Math.round(set.intensity * 100)}%`} onChange={(v) => mode.setSettings({ intensity: v })} />
      <label className="flex items-center gap-1.5 text-xs text-ink-2" title="The lights keep their place in the picture as the view turns, as a photographer's do while the model turns on its table"><input type="checkbox" checked={set.follow} onChange={(e) => mode.setSettings({ follow: e.target.checked })} />Lights turn with the view</label>

      <Head>Scene</Head>
      <Row label="Ground"><Seg label="Ground" value={set.ground} options={GROUNDS} onPick={(v) => mode.setSettings({ ground: v })} /></Row>
      <Row label="Backdrop">
        <Select className="input flex-1 min-w-0" value={set.background} label="Backdrop" data={{ render: "background" }} onChange={(v) => mode.setSettings({ background: v as typeof set.background })} options={BACKGROUNDS.map((b) => ({ value: b.id, label: b.title }))} />
        {set.background === "color" ? <input type="color" className="h-6 w-8 flex-none p-0 border border-line rounded-sm bg-transparent" value={backdrop} aria-label="Backdrop colour" title={set.backgroundColor ? "The backdrop's colour (double-click for the one that suits the lights)" : "The backdrop's colour"} data-render-backdrop
          onChange={(e) => mode.setSettings({ backgroundColor: e.target.value })} onDoubleClick={() => mode.setSettings({ backgroundColor: null })} /> : null}
      </Row>

      <Head>Camera</Head>
      <Slider label="Exposure" value={set.exposure} min={-3} max={3} step={0.1} show={`${set.exposure > 0 ? "+" : ""}${set.exposure.toFixed(1)}`} onChange={(v) => mode.setSettings({ exposure: v })} />
      <Row label="Look" title="How bright light is rolled off into the picture's white">
        <Seg label="Tone curve" value={set.tone} options={TONE_MAPS} onPick={(v) => mode.setSettings({ tone: v })} />
      </Row>
      <div className="flex items-center gap-3 text-xs text-ink-2">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={persp} data-render-perspective onChange={(e) => mode.setPerspective(e.target.checked)} />Perspective</label>
        <label className="flex items-center gap-1.5" title="Blur what is nearer or farther than the point in focus, as a lens does"><input type="checkbox" checked={set.dof} data-render-dof onChange={(e) => mode.setSettings({ dof: e.target.checked })} />Depth of field</label>
      </div>
      {set.dof ? (
        <Row label="Aperture" title="A wider aperture (a smaller number) blurs more">
          <Select className="input w-20" value={String(set.fstop)} label="Aperture" data={{ render: "fstop" }} onChange={(v) => mode.setSettings({ fstop: Number(v) })} options={FSTOPS.map((f) => ({ value: String(f), label: `f/${f}` }))} />
          <button type="button" className={cx("btn sm h-6 flex-1", s.focusing && "on")} aria-pressed={s.focusing} data-render-focus title="Then click the point of the model that should be sharp" onClick={() => mode.focusByClick()}>{s.focusing ? "Click the model…" : set.focus ? "Focus elsewhere" : "Pick focus"}</button>
        </Row>
      ) : null}

      <Head>Quality</Head>
      <Seg label="Quality" value={set.quality} options={QUALITIES} onPick={(v) => mode.setSettings({ quality: v })} />
      <label className="flex items-center gap-1.5 text-xs text-ink-2" title="Smooth the noise of a picture that is not finished yet; it lets go as the samples add up"><input type="checkbox" checked={set.denoise} data-render-denoise onChange={(e) => mode.setSettings({ denoise: e.target.checked })} />Denoise</label>

      <Head>Save</Head>
      <div className="flex items-center gap-1.5">
        <Select className="input flex-1 min-w-0" value={s.imageSize} label="Picture size" data={{ render: "image-size" }} disabled={busy} onChange={(v) => mode.setImageSize(v)} options={IMAGE_SIZES.map((x) => ({ value: x.id, label: x.width ? x.title : `${x.title} (${iw} × ${ih})` }))} />
        <button type="button" className="btn sm h-6" disabled={busy || s.phase === "loading" || s.phase === "preparing"} data-render-save title={`Render ${iw} × ${ih} at ${q.samples} samples and save it as a PNG`} onClick={() => void mode.saveImage()}>Save image</button>
      </div>

      <button type="button" className="btn sm ghost h-6 justify-start px-1 text-left" aria-expanded={film} data-render-film-toggle onClick={() => setFilm(!film)}>{film ? "▾" : "▸"} Turntable film</button>
      {film ? (
        <div className="flex flex-col gap-1.5" data-render-film>
          {motions.length ? <Row label="Film"><Select className="input flex-1 min-w-0" value={s.filmOf} label="What to film" data={{ render: "film-of" }} onChange={(v) => mode.setFilmOf(v)} options={[{ value: "turntable", label: "Turntable" }, ...motions.map((m) => ({ value: m.id, label: m.title }))]} /></Row> : null}
          <Row label="Length"><Number_ label="Seconds" value={t.duration} min={0.1} max={120} step={0.5} unit="s" onChange={(v) => mode.setTurntable({ duration: v })} /><Number_ label="Frames per second" value={t.fps} min={1} max={60} step={1} unit="fps" onChange={(v) => mode.setTurntable({ fps: v })} /></Row>
          <Row label="Size"><Select className="input flex-1 min-w-0" value={sizeId ? sizeId.title : "custom"} label="Film size" data={{ render: "film-size" }} onChange={(v) => { const x = TURNTABLE_SIZES.find((y) => y.title === v); if (x) mode.setTurntable({ width: x.width, height: x.height }); }}
            options={[...TURNTABLE_SIZES.map((x) => ({ value: x.title, label: x.title })), ...(sizeId ? [] : [{ value: "custom", label: `${t.width} × ${t.height}` }])]} /></Row>
          <Row label="Samples" title="Samples per pixel in each frame: the denoiser makes few go a long way"><Number_ label="Samples per frame" value={t.samples} min={1} max={4096} step={8} onChange={(v) => mode.setTurntable({ samples: v })} wide /></Row>
          {s.filmOf === "turntable" ? (
            <>
              <Row label="Path"><Seg label="Camera path" value={t.path} options={[{ id: "orbit", title: "Orbit" }, { id: "rise", title: "Orbit and rise" }]} onPick={(v) => mode.setTurntable({ path: v })} /></Row>
              <Row label="Axis" title="The line through the middle of the model that it turns about"><Seg label="Axis" value={t.axis} options={[{ id: "z", title: "Vertical" }, { id: "x", title: "X" }, { id: "y", title: "Y" }]} onPick={(v) => mode.setTurntable({ axis: v })} /></Row>
              <Row label="Elevation" title="How far above the turntable's plane the camera is; empty keeps the view's own">
                <input key={String(t.elevation)} type="number" className="input mono h-6 w-16 text-xs" min={-89} max={89} step={5} defaultValue={t.elevation ?? ""} placeholder="view" aria-label="Elevation in degrees"
                  onBlur={(e) => mode.setTurntable({ elevation: e.target.value === "" ? null : Number(e.target.value) })} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                <span className="text-ink-3">°</span>
                {t.path === "rise" ? <><span className="ml-1">rise</span><Number_ label="Rise in degrees" value={t.rise} min={-89} max={89} step={5} unit="°" onChange={(v) => mode.setTurntable({ rise: v })} /></> : null}
              </Row>
            </>
          ) : null}
          <div className="flex items-center gap-1.5">
            <span className="flex-1 text-xs text-ink-3">{timing.frames} frames, {t.width} × {t.height}</span>
            <button type="button" className="btn sm h-6" disabled={busy || s.phase === "loading" || s.phase === "preparing"} data-render-film-start onClick={() => void mode.renderFilm()}>Render film</button>
          </div>
        </div>
      ) : null}
      </>}
      {s.last ? <p className="m-0 text-xs text-ink-2" data-render-last>Saved {s.last.name} ({bytes(s.last.bytes)}){s.last.note ? `. ${s.last.note}.` : "."}</p> : null}
    </div>
  );
}
