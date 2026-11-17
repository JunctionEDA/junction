// FeatureDialog.tsx — the property dialog of a feature, generated from the feature type's schema
// (core/feature.ts ParamField).  A feature file never writes dialog code: it lists its fields.
//
// The dialog edits a draft (studio.getState().editing); the model previews it; Done commits it as one change.
import { useEffect, useState } from "react";
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import { cx } from "../../../shared/util";
import type { ParamField } from "../core/feature";
import { DEFAULT_PLANES, type DefaultPlaneId, type GeomRef, type PlaneRef } from "../core/geometry";
import { useStudio } from "./hooks";
import { featureDef, type PartStudio } from "./studio";

const row = "grid grid-cols-[104px_minmax(0,1fr)] items-center gap-x-2 gap-y-1 min-h-7";

function NumberField({ field, value, set }: { field: Extract<ParamField, { kind: "number" }>; value: unknown; set(v: number): void }) {
  const [text, setText] = useState(String(value ?? ""));
  useEffect(() => { if (Number(text) !== value) setText(String(value ?? "")); /* the draft changed elsewhere */ }, [value]);   // eslint-disable-line react-hooks/exhaustive-deps
  const n = Number(text), bad = text.trim() === "" || !Number.isFinite(n) || (field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max);
  return (
    <span className="flex items-center gap-1.5">
      <input className={cx("input mono w-full", bad && "bad")} inputMode="decimal" value={text} data-param={field.key} aria-label={field.label}
        onChange={(ev) => { setText(ev.target.value); const v = Number(ev.target.value); if (ev.target.value.trim() !== "" && Number.isFinite(v) && (field.min === undefined || v >= field.min) && (field.max === undefined || v <= field.max)) set(v); }} />
      {field.unit && field.unit !== "none" ? <span className="text-ink-3 font-mono text-xs">{field.unit === "deg" ? "°" : field.unit}</span> : null}
    </span>
  );
}

/** A field that is filled by clicking in the viewport: shows what it holds, and is "armed" while it listens. */
function PickBox({ armed, text, empty, onArm, onClear, param }: { armed: boolean; text: string; empty: boolean; onArm(): void; onClear?(): void; param: string }) {
  return (
    <span className={cx("flex items-center min-h-6 px-1.5 rounded-sm border bg-panel cursor-pointer", armed ? "border-blue" : "border-line")} data-param={param} data-armed={armed || undefined}
      onClick={onArm} title={armed ? "Click in the model to choose" : "Click here, then in the model"}>
      <span className={cx("flex-1 truncate", empty && "text-ink-3")}>{text}</span>
      {!empty && onClear ? <button type="button" className="btn sm ghost px-1" title="Clear" onClick={(ev) => { ev.stopPropagation(); onClear(); }}>×</button> : null}
    </span>
  );
}

function Field({ studio, field, params }: { studio: PartStudio; field: ParamField; params: JsonObject }) {
  const armed = useStudio(studio, (s) => s.editing?.field === field.key);
  const features = useStudio(studio, (s) => s.features);
  const bodies = useStudio(studio, (s) => s.bodies);
  const draftId = useStudio(studio, (s) => s.editing?.draft.id);
  const value = params[field.key];
  const set = (v: JsonObject[string]) => studio.setDraft({ params: { [field.key]: v } });
  const arm = () => studio.setField(armed ? null : field.key);
  let control: JSX.Element;
  switch (field.kind) {
    case "number": control = <NumberField field={field} value={value} set={set} />; break;
    case "boolean": control = <input type="checkbox" checked={!!value} data-param={field.key} aria-label={field.label} onChange={(ev) => set(ev.target.checked)} />; break;
    case "text": control = <input className="input w-full" value={String(value ?? "")} data-param={field.key} aria-label={field.label} onChange={(ev) => set(ev.target.value)} />; break;
    case "enum":
      control = field.options.length <= 4
        ? <span className="seg" data-param={field.key}>{field.options.map((o) => <button key={o.value} type="button" className={cx(value === o.value && "on")} onClick={() => set(o.value)}>{o.label}</button>)}</span>
        : <select className="input w-full" value={String(value ?? "")} data-param={field.key} onChange={(ev) => set(ev.target.value)}>{field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
      break;
    case "profile": {
      const me = features.findIndex((f) => f.id === draftId);
      const sketches = features.filter((f, i) => f.featureType === "sketch" && (me < 0 || i < me));
      const cur = (value as { sketch?: string } | null)?.sketch || "";
      control = (
        <span className={cx("flex rounded-sm", armed && "outline outline-1 outline-blue")}>
          <select className="input w-full" value={cur} data-param={field.key} aria-label={field.label} onFocus={() => { if (!armed) studio.setField(field.key); }}
            onChange={(ev) => set(ev.target.value ? { sketch: ev.target.value, regions: null } : null)}>
            <option value="">{sketches.length ? "Choose a sketch, or click one" : "Draw a sketch first"}</option>
            {sketches.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </span>
      );
      break;
    }
    case "plane": {
      const ref = (value as unknown as PlaneRef | undefined) || { kind: "plane", plane: "top" };
      const text = ref.kind === "plane" ? `${DEFAULT_PLANES[ref.plane]?.title || ref.plane} plane` : "A face of the model";
      control = (
        <span className="flex flex-col gap-1">
          <PickBox param={field.key} armed={armed} text={text} empty={false} onArm={arm} />
          <span className="seg">{(Object.keys(DEFAULT_PLANES) as DefaultPlaneId[]).map((id) => <button key={id} type="button" data-plane={id} className={cx(ref.kind === "plane" && ref.plane === id && "on")} onClick={() => set({ kind: "plane", plane: id })}>{DEFAULT_PLANES[id].title}</button>)}</span>
        </span>
      );
      break;
    }
    case "refs": {
      const refs: GeomRef[] = Array.isArray(value) ? (value as GeomRef[]) : value ? [value as GeomRef] : [];
      const noun = field.of.length === 1 ? field.of[0] : "item";
      control = <PickBox param={field.key} armed={armed} empty={!refs.length} text={refs.length ? `${refs.length} ${noun}${refs.length === 1 ? "" : "s"}` : `Click ${field.single ? "a" : "the"} ${noun}${field.single ? "" : "s"}`} onArm={arm} onClear={() => set(field.single ? null : [])} />;
      break;
    }
    case "document": {
      const docs = studio.host.docs.filter((d) => field.docTypes.includes(d.docType));
      const title = (path: string) => (path.split("/").pop() || path).replace(/\.[^.]+$/, "");
      control = (
        <select className="input w-full" value={typeof value === "string" ? value : ""} data-param={field.key} aria-label={field.label} onChange={(ev) => set(ev.target.value || null)}>
          <option value="">{docs.length ? "Choose…" : "The project has none"}</option>
          {docs.map((d) => <option key={d.docId} value={d.docId}>{title(d.path)}</option>)}
        </select>
      );
      break;
    }
    case "bodies": {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      const names = ids.map((id) => bodies.find((b) => b.id === id)?.name || "missing body");
      control = <PickBox param={field.key} armed={armed} empty={!ids.length} text={ids.length ? names.join(", ") : "Every body"} onArm={arm} onClear={() => set([])} />;
      break;
    }
  }
  return (
    <label className={row} title={field.hint} onClick={(ev) => { if (field.kind !== "boolean" && field.kind !== "number" && field.kind !== "text") ev.preventDefault(); }}>
      <span className="text-ink-2 truncate">{field.label}</span>
      {control}
    </label>
  );
}

export function FeatureDialog({ studio }: { studio: PartStudio }) {
  const editing = useStudio(studio, (s) => s.editing);
  const report = useStudio(studio, (s) => (s.editing ? s.reports[s.editing.draft.id] : undefined));
  if (!editing) return null;
  const def = featureDef(editing.draft.featureType);
  const params = editing.draft.params;
  const fields = def ? def.schema.filter((f) => !f.visible || f.visible(params)) : [];
  const failed = report && report.status === "error";
  return (
    <form className="cad-dialog absolute left-2 top-2 z-[4] w-[300px] max-h-[calc(100%-16px)] flex flex-col rounded-md border border-line bg-bench shadow-panel text-sm" data-feature={editing.draft.featureType}
      onSubmit={(ev) => { ev.preventDefault(); studio.acceptFeature(); }} onKeyDown={(ev) => { if (ev.key === "Escape") { ev.stopPropagation(); studio.cancelFeature(); } }}>
      <header className="flex items-center gap-2 h-8 px-2 border-b border-line bg-paper rounded-t-md">
        <input className="flex-1 min-w-0 bg-transparent border-0 outline-none font-semibold text-ink text-base" value={editing.draft.name} aria-label="Feature name" onChange={(ev) => studio.setDraft({ name: ev.target.value })} />
      </header>
      <div className="flex flex-col gap-1.5 p-2 overflow-y-auto">
        {def ? fields.map((f) => <Field key={f.key} studio={studio} field={f} params={params} />) : <p className="note">This Junction does not know the feature type “{editing.draft.featureType}”.</p>}
        {report && report.message ? <p className={cx("callout m-0", failed ? "err" : "warn")} role="status">{report.message}</p> : null}
      </div>
      <footer className="flex justify-end gap-1.5 p-2 border-t border-line">
        <button type="button" className="btn sm" onClick={() => studio.cancelFeature()}>Cancel</button>
        <button type="submit" className="btn sm primary" data-accept>Done</button>
      </footer>
    </form>
  );
}
