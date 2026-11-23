// MateDialog.tsx — making or editing a mate: its two connectors (click in the model; which kinds of geometry a
// click takes), which way they face, the fields its type lists (limits …), an offset between the two connectors
// (every mate that has a place for one), and the values it leaves free, which can be typed or animated.
// Nothing is in the document until Done; the model shows the draft solved.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import { cx } from "../../../shared/util";
import { Select } from "../../../shared/components/Select";
import type { ParamField } from "../../mechanical/api";
import type { MateConnector } from "../document/format";
import { useState } from "react";
import { mateDef, type AssemblyEditor, type MateField } from "./assembly";
import { Glyph, ICONS, NumberInput, useAssembly } from "./parts";

const row = "grid grid-cols-[104px_minmax(0,1fr)] items-center gap-x-2 gap-y-1 min-h-7";
/** The offset between a mate's two connectors, along the first connector's own axes and about its axis (solver/frames.ts). */
const OFFSETS: ParamField[] = [
  { key: "offsetX", label: "Offset X", kind: "number", unit: "mm" }, { key: "offsetY", label: "Offset Y", kind: "number", unit: "mm" },
  { key: "offset", label: "Offset Z", kind: "number", unit: "mm", hint: "Along the connector's axis." }, { key: "rotation", label: "Turn about Z", kind: "number", unit: "deg" },
];

function ConnectorBox({ assembly, side, field = side, end, armed, label }: { assembly: AssemblyEditor; side: "a" | "b"; /** the draft's field this box fills: the side itself, or its second face (Width) */ field?: MateField; end: MateConnector | null; armed: boolean; label: string }) {
  const name = useAssembly(assembly, (s) => (end ? s.instances.find((i) => i.id === end.instance)?.name || "a deleted instance" : ""));
  const explicit = useAssembly(assembly, (s) => (end && typeof end.connector === "string" ? s.connectors.find((c) => c.id === end.connector)?.name || "a deleted connector" : ""));
  const pair = field !== side, ref = end ? (pair ? end.ref2 : end.ref) : undefined;
  const what = end && ref ? `${name}: ${explicit || (ref.kind === "face" ? "face" : ref.kind === "edge" ? "edge" : "point")}${end.flip && !pair ? " (flipped)" : ""}` : armed ? (field.length === 2 ? "Click the opposite face" : "Click a face, an edge or a point") : "Not chosen";
  return (
    <div className={row}>
      <span className="text-ink-2 truncate">{label}</span>
      <span className="flex items-center gap-1 min-w-0">
        <span className={cx("flex flex-1 min-w-0 items-center min-h-6 px-1.5 rounded-sm border bg-panel cursor-pointer", armed ? "border-blue" : "border-line")} data-connector={field} data-armed={armed || undefined} data-set={!!ref || undefined}
          title={armed ? "Click in the model to choose" : "Click here, then in the model"} onClick={() => assembly.setMateDraft({ field: armed ? null : field })}>
          <span className={cx("flex-1 truncate", !ref && "text-ink-3")}>{what}</span>
        </span>
        {pair || field.length === 2 ? null : <button type="button" className={cx("btn sm ghost px-1", end?.flip && "on")} disabled={!end} title="Flip: face the other way" aria-label={`Flip ${label.toLowerCase()}`} data-flip={side} onClick={() => assembly.flipMate(side)}><Glyph svg={ICONS.flip} size={15} /></button>}
      </span>
    </div>
  );
}

function Field({ field, params, set }: { field: ParamField; params: JsonObject; set(v: JsonObject[string]): void }) {
  const value = params[field.key];
  let control: JSX.Element | null = null;
  if (field.kind === "number") control = <NumberInput value={typeof value === "number" ? value : 0} set={set} unit={field.unit} min={field.min} max={field.max} label={field.label} param={field.key} />;
  else if (field.kind === "boolean") control = <input type="checkbox" checked={!!value} data-param={field.key} aria-label={field.label} onChange={(ev) => set(ev.target.checked)} />;
  else if (field.kind === "text") control = <input className="input w-full" value={String(value ?? "")} data-param={field.key} aria-label={field.label} onChange={(ev) => set(ev.target.value)} />;
  else if (field.kind === "enum") control = <span className="seg" data-param={field.key}>{field.options.map((o) => <button key={o.value} type="button" className={cx(value === o.value && "on")} onClick={() => set(o.value)}>{o.label}</button>)}</span>;
  if (!control) return null;
  return <label className={row} title={field.hint}><span className="text-ink-2 truncate">{field.label}</span>{control}</label>;
}

export function MateDialog({ assembly }: { assembly: AssemblyEditor }) {
  const d = useAssembly(assembly, (s) => s.mating);
  const info = useAssembly(assembly, (s) => (s.mating ? s.mateInfo[s.mating.id] : undefined));
  const animating = useAssembly(assembly, (s) => s.animating);
  const filter = useAssembly(assembly, (s) => s.filter);
  const [offsetOpen, setOffsetOpen] = useState(false);
  if (!d) return null;
  const def = mateDef(d.mateType);
  const fields = def ? def.schema.filter((f) => !f.visible || f.visible(d.params)) : [];
  const values = def?.solve?.values || [];
  const pairs = !!def?.pairs;
  const ready = !!d.a && !!d.b && (!pairs || (!!d.a.ref2 && !!d.b.ref2));
  // the offset every mate may carry (solver/frames.ts): the fields its own schema does not already list
  const offsets: ParamField[] = pairs || d.mateType === "parallel" || d.mateType === "tangent" ? [] : OFFSETS.filter((f) => !def || !def.schema.some((x) => x.key === f.key));
  const offsetSet = offsets.some((f) => !!d.params[f.key]);
  const failed = ready && info && (info.state === "conflict" || info.state === "error");
  return (
    <form className="cad-dialog absolute left-2 top-2 z-[4] w-[310px] max-h-[calc(100%-16px)] flex flex-col rounded-md border border-line bg-bench shadow-panel text-sm" data-mate-dialog={d.mateType}
      onSubmit={(ev) => { ev.preventDefault(); assembly.acceptMate(); }} onKeyDown={(ev) => { if (ev.key === "Escape") { ev.stopPropagation(); assembly.cancelMate(); } }}>
      <header className="flex items-center gap-2 h-8 px-2 border-b border-line bg-paper rounded-t-md">
        <Glyph svg={def?.icon} />
        <input className="flex-1 min-w-0 bg-transparent border-0 outline-none font-semibold text-ink text-base" value={d.name} aria-label="Mate name" onChange={(ev) => assembly.setMateDraft({ name: ev.target.value })} />
      </header>
      <div className="flex flex-col gap-1.5 p-2 overflow-y-auto">
        <label className={row}>
          <span className="text-ink-2">Type</span>
          <Select className="input w-full" value={d.mateType} label="Mate type" data={{ param: "mateType" }} onChange={(v) => { const next = mateDef(v); if (next) assembly.setMateDraft({ mateType: next.type, params: { ...next.defaults(), ...d.params } }, true); }}
            options={[...assembly.mateTypes().slice().sort((p, q) => (p.order ?? 1e6) - (q.order ?? 1e6)).map((m) => ({ value: m.type, label: m.title })), ...(!def ? [{ value: d.mateType, label: d.mateType }] : [])]} />
        </label>
        {pairs ? <>
          <ConnectorBox assembly={assembly} side="a" end={d.a} armed={d.field === "a"} label="Slot, first wall" />
          <ConnectorBox assembly={assembly} side="a" field="a2" end={d.a} armed={d.field === "a2"} label="Slot, second wall" />
          <ConnectorBox assembly={assembly} side="b" end={d.b} armed={d.field === "b"} label="Tab, first side" />
          <ConnectorBox assembly={assembly} side="b" field="b2" end={d.b} armed={d.field === "b2"} label="Tab, second side" />
        </> : <>
          <ConnectorBox assembly={assembly} side="a" end={d.a} armed={d.field === "a"} label="First connector" />
          <ConnectorBox assembly={assembly} side="b" end={d.b} armed={d.field === "b"} label="Second connector" />
          <div className={row}>
            <span className="text-ink-2" title="Which geometry a click in the model takes">Pick</span>
            <span className="seg justify-self-start" data-pick-filter>
              {(["face", "edge", "vertex"] as const).map((k) => <button key={k} type="button" className={cx(filter[k] && "on")} aria-pressed={filter[k]} data-filter={k} title={`${filter[k] ? "Stop taking" : "Take"} ${k === "face" ? "faces" : k === "edge" ? "edges" : "points"}`} onClick={() => assembly.setFilter({ [k]: !filter[k] })}>{k === "face" ? "Faces" : k === "edge" ? "Edges" : "Points"}</button>)}
            </span>
          </div>
          <div className={row}>
            <span className="text-ink-2">Facing</span>
            <button type="button" className="btn sm justify-self-start flex items-center gap-1.5" disabled={!ready} data-reorient title="Turn the second part a quarter about the connector's axis" onClick={() => assembly.reorientMate()}><Glyph svg={ICONS.turn} size={15} /><span>Turn a quarter</span></button>
          </div>
        </>}
        {fields.map((f) => <Field key={f.key} field={f} params={d.params} set={(v) => assembly.setMateDraft({ params: { [f.key]: v } })} />)}
        {offsets.length ? <>
          <label className={row} title="Set the second connector apart from the first: along the connector's own axes, and turned about its axis.">
            <span className="text-ink-2 truncate">Offset</span>
            <input type="checkbox" checked={offsetOpen || offsetSet} data-param="offsets" aria-label="Offset" onChange={(ev) => { setOffsetOpen(ev.target.checked); if (!ev.target.checked && offsetSet) assembly.setMateDraft({ params: Object.fromEntries(offsets.map((f) => [f.key, 0])) }, true); }} />
          </label>
          {offsetOpen || offsetSet ? offsets.map((f) => <Field key={f.key} field={f} params={d.params} set={(v) => assembly.setMateDraft({ params: { [f.key]: v } }, true)} />) : null}
        </> : null}
        {ready && values.length && info && info.state === "ok" ? (
          <fieldset className="flex flex-col gap-1.5 m-0 p-0 pt-1.5 border-0 border-t border-line">
            {values.map((v) => {
              const on = !!animating && animating.mate === d.id && animating.key === v.key;
              return (
                <div key={v.key} className={row} data-value={v.key}>
                  <span className="text-ink-2 truncate" title="The value now. Type one to move the parts there, or drag a part in the model.">{v.label} now</span>
                  <span className="flex items-center gap-1 min-w-0">
                    <span className="flex-1 min-w-0"><NumberInput value={info.values[v.key] ?? 0} set={(n) => assembly.driveMate(d.id, v.key, n)} unit={v.unit} label={`${v.label} now`} param={`value-${v.key}`} /></span>
                    <button type="button" className={cx("btn sm ghost px-1", on && "on")} title={on ? "Stop" : "Animate: sweep this value"} aria-label={on ? "Stop the animation" : `Animate ${v.label.toLowerCase()}`} data-animate={v.key} onClick={() => assembly.animateMate(d.id, v.key)}><Glyph svg={on ? ICONS.stop : ICONS.play} size={15} /></button>
                  </span>
                </div>
              );
            })}
          </fieldset>
        ) : null}
        {failed ? <p className="callout err m-0" role="status" data-mate-error>{info!.message}</p> : null}
        {!def ? <p className="note m-0">This Junction does not know the mate type “{d.mateType}”.</p> : null}
        {!ready ? <p className="note m-0">{pairs ? "Click the two walls of the slot on one part, then the two sides of the tab on the other: the tab is centred between the walls." : "Hover a part to see its connectors: face centres, hole axes, edge midpoints, circle centres and corners."}</p> : null}
      </div>
      <footer className="flex justify-end gap-1.5 p-2 border-t border-line">
        <button type="button" className="btn sm" data-cancel onClick={() => assembly.cancelMate()}>Cancel</button>
        <button type="submit" className="btn sm primary" data-accept disabled={!ready}>Done</button>
      </footer>
    </form>
  );
}
