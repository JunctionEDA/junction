// FeatureDialog.tsx — the property dialog of a feature, generated from the feature type's schema
// (core/feature.ts ParamField).  A feature file never writes dialog code: it lists its fields.
//
// The dialog edits a draft (studio.getState().editing); the model previews it; Done commits it as one change.
import { useEffect, useState } from "react";
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import { cx } from "../../../shared/util";
import type { ParamField } from "../core/feature";
import { DEFAULT_PLANES, type DefaultPlaneId, type PlaneRef } from "../core/geometry";
import { EXPR_KEY, evaluate, exprsOf, isPlainNumber, variableValues, variablesOf } from "../document/variables";
import { describeTargets, targetsIn } from "../features/_refs";
import { useStudio } from "./hooks";
import { featureDef, type PartStudio } from "./studio";

const row = "grid grid-cols-[104px_minmax(0,1fr)] items-center gap-x-2 gap-y-1 min-h-7";

function NumberField({ field, value, set, expr, setExpr, lookup }: { field: Extract<ParamField, { kind: "number" }>; value: unknown; set(v: number): void; expr?: string; setExpr?(v: number, text: string | null): void; lookup?(name: string): number | undefined }) {
  const shown = expr ?? String(value ?? "");
  const [text, setText] = useState(shown);
  // a number typed as is, or an expression (with variables) when the field takes one
  const read = (t: string): number | null => {
    if (t.trim() === "") return null;
    if (isPlainNumber(t)) return Number(t);
    if (!setExpr) return null;
    try { return evaluate(t, lookup); } catch (e) { return null; }
  };
  useEffect(() => { if (text !== shown && read(text) !== value) setText(shown); /* the draft changed elsewhere */ }, [value, expr]);   // eslint-disable-line react-hooks/exhaustive-deps
  const ok = (v: number | null): v is number => v !== null && Number.isFinite(v) && (field.min === undefined || v >= field.min) && (field.max === undefined || v <= field.max);
  const n = read(text), bad = !ok(n);
  const isExpr = !!setExpr && text.trim() !== "" && !isPlainNumber(text);
  return (
    <span className="flex items-center gap-1.5">
      <input className={cx("input mono w-full", bad && "bad")} inputMode="decimal" value={text} data-param={field.key} aria-label={field.label} title={isExpr && !bad ? `= ${Math.round(n! * 1e6) / 1e6}` : undefined}
        onChange={(ev) => {
          const t = ev.target.value; setText(t);
          const v = read(t); if (!ok(v)) return;
          if (setExpr && (!isPlainNumber(t) || expr !== undefined)) setExpr(v, isPlainNumber(t) ? null : t); else set(v);
        }} />
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
    case "number": {
      const exprs = exprsOf(params);
      const values = variableValues(studio.doc ? variablesOf(studio.doc) : []).values;
      const setExpr = (v: number, text: string | null) => {
        const next = { ...exprs }; if (text === null) delete next[field.key]; else next[field.key] = text;
        studio.setDraft({ params: { [field.key]: v, [EXPR_KEY]: Object.keys(next).length ? next : null } });
      };
      control = <NumberField field={field} value={value} set={set} expr={exprs[field.key]} setExpr={setExpr} lookup={(n) => values.get(n)} />;
      break;
    }
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
      // which of the sketch's regions are used: all of them, or the ones clicked in the viewport
      const chosen = (value as { regions?: string[] | null } | null)?.regions || null;
      const all = cur ? (studio.getState().sketches.find((v) => v.featureId === cur)?.regions.length ?? 0) : 0;
      const used = chosen ? chosen.length : all;
      control = (
        <span className="flex flex-col gap-1 min-w-0">
          <span className={cx("flex rounded-sm", armed && "outline outline-1 outline-blue")}>
            <select className="input w-full" value={cur} data-param={field.key} aria-label={field.label} onFocus={() => { if (!armed) studio.setField(field.key); }}
              onChange={(ev) => set(ev.target.value ? { sketch: ev.target.value, regions: null } : null)}>
              <option value="">{sketches.length ? "Choose a sketch, or click one" : "Draw a sketch first"}</option>
              {sketches.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </span>
          {cur && all > 1 ? (
            <span className="flex items-center gap-1.5 text-xs text-ink-2" data-regions={chosen ? chosen.join(" ") : "all"}>
              <span className="flex-1">{chosen ? `${used} of ${all} regions` : `All ${all} regions`}{armed ? ": click a region to choose" : ""}</span>
              {chosen ? <button type="button" className="btn sm ghost h-5 px-1" data-act="all-regions" onClick={() => set({ sketch: cur, regions: null })}>All</button>
                : !armed ? <button type="button" className="btn sm ghost h-5 px-1" data-act="pick-regions" onClick={() => studio.setField(field.key)}>Choose</button> : null}
            </span>
          ) : null}
        </span>
      );
      break;
    }
    case "plane": {
      const ref = (value as unknown as PlaneRef | undefined) || { kind: "plane", plane: "top" };
      const text = ref.kind === "plane" ? `${DEFAULT_PLANES[ref.plane]?.title || ref.plane} plane` : ref.kind === "datum" ? features.find((f) => f.id === ref.feature)?.name || "A missing plane" : "A face of the model";
      control = (
        <span className="flex flex-col gap-1">
          <PickBox param={field.key} armed={armed} text={text} empty={false} onArm={arm} />
          <span className="seg">{(Object.keys(DEFAULT_PLANES) as DefaultPlaneId[]).map((id) => <button key={id} type="button" data-plane={id} className={cx(ref.kind === "plane" && ref.plane === id && "on")} onClick={() => set({ kind: "plane", plane: id })}>{DEFAULT_PLANES[id].title}</button>)}</span>
        </span>
      );
      break;
    }
    case "refs": {
      const refs = targetsIn(value);
      const wide = !!(field.datums || field.planes || field.sketch);
      const noun = field.of.length === 1 && !wide ? field.of[0] : "item";
      const text = !refs.length ? `Click ${field.single ? "a" : "the"} ${noun}${field.single ? "" : "s"}`
        : wide ? describeTargets(refs, (id) => features.find((f) => f.id === id)?.name)
        : `${refs.length} ${noun}${refs.length === 1 ? "" : "s"}`;
      control = <PickBox param={field.key} armed={armed} empty={!refs.length} text={text} onArm={arm} onClear={() => set(field.single ? null : [])} />;
      if (field.planes) {
        // the default planes are often behind the model: offer them as buttons too
        const add = (id: DefaultPlaneId) => { const t = { kind: "plane", plane: id }; set(field.single ? t : [...refs.filter((r) => !(r.kind === "plane" && r.plane === id)), t]); };
        control = (
          <span className="flex flex-col gap-1">
            {control}
            <span className="seg">{(Object.keys(DEFAULT_PLANES) as DefaultPlaneId[]).map((id) => <button key={id} type="button" data-plane={id} className={cx(refs.some((r) => r.kind === "plane" && r.plane === id) && "on")} onClick={() => add(id)}>{DEFAULT_PLANES[id].title}</button>)}</span>
          </span>
        );
      }
      break;
    }
    case "features": {
      const me = features.findIndex((f) => f.id === draftId);
      const ids = Array.isArray(value) ? (value as string[]) : [];
      const offered = features.filter((f, i) => (me < 0 || i < me) && (!field.types || field.types.includes(f.featureType)) && !(field.exclude || []).includes(f.featureType));
      control = (
        <span className="flex flex-col gap-0.5 max-h-32 overflow-y-auto rounded-sm border border-line bg-panel px-1 py-0.5" data-param={field.key}>
          {offered.length ? offered.map((f) => {
            const at = ids.indexOf(f.id);
            return (
              <button key={f.id} type="button" data-feature-option={f.id} aria-pressed={at >= 0} className={cx("flex items-center gap-1.5 text-left px-1 rounded-sm", at >= 0 ? "bg-sel text-ink" : "text-ink-2")}
                onClick={() => set(at >= 0 ? ids.filter((x) => x !== f.id) : [...ids, f.id])}>
                <span className="w-3 font-mono text-xs text-ink-3">{at >= 0 ? at + 1 : ""}</span><span className="truncate">{f.name}</span>
              </button>
            );
          }) : <span className="text-ink-3">Nothing above this feature to choose.</span>}
        </span>
      );
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
