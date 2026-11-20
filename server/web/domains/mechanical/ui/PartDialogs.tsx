// PartDialogs.tsx — the dialogs the parts list's menu opens: Properties (name, description and fields of a
// person's own, with what the model says about the entry), Assign material (the document's library, or a new
// material) and Edit appearance (colour and opacity).  Each is one undoable edit of the document, made when the
// dialog is accepted; everything they write is described in document/part-items.ts, mass-materials.ts and
// appearance-items.ts.
import { useEffect, useState } from "react";
import { applyChanges, type ItemChange, type ItemDoc } from "../../../shared/itemdoc/itemdoc";
import { Select } from "../../../shared/components/Select";
import { resetLook, setBodyLook } from "../document/appearance-items";
import { assignMaterial, defineMaterial, materialOf, materialsOf } from "../document/mass-materials";
import { MAX_PART_FIELDS, MAX_PART_NAME, partPropsOf, updatePart } from "../document/part-items";
import { displayOf } from "../inspect/appearance-display";
import { kg, mm2, mm3 } from "../inspect/measure-format";
import type { MassBody } from "../services/mass-properties";
import { openDialog, type DialogHandle } from "../tools/_dialog";
import { SECTIONS, type PartEntry } from "./parts-model";
import type { PartStudio } from "./studio";

const row = "grid grid-cols-[104px_minmax(0,1fr)] items-center gap-x-2 min-h-7";
const NEW = "+new";

/** A dialog whose body is drawn again whenever `draw` is called. */
function formDialog(o: { title: string; width?: number; okLabel?: string; body(redraw: () => void): JSX.Element; valid?(): boolean; ok(): void }): void {
  const draw = (h: DialogHandle) => { if (h.okButton) h.okButton.disabled = !!o.valid && !o.valid(); h.render(o.body(() => draw(h))); };
  openDialog({
    title: o.title, width: o.width || 420, okLabel: o.okLabel || "OK",
    render: (h) => { setTimeout(() => draw(h), 0); return o.body(() => draw(h)); },
    ok(h) { if (o.valid && !o.valid()) return; o.ok(); h.close(); },
  });
}

// ---------------------------------------------------------------- properties
/** What the worker says about a body: its volume and area, and its mass when it has a material. */
function Measured({ studio, entry }: { studio: PartStudio; entry: PartEntry }) {
  const [m, setM] = useState<MassBody | null>(null);
  useEffect(() => {
    let live = true;
    if (!entry.body) return;
    const mat = materialOf(studio.doc, entry.body);
    studio.kernel.call("mass-properties", { bodies: [entry.body], density: mat ? { [entry.body]: mat.density } : {} } as never)
      .then((r) => { const part = (r as unknown as { parts?: MassBody[] }).parts?.[0]; if (live && part) setM(part); }, () => { /* the model is busy: the dialog does without */ });
    return () => { live = false; };
  }, [studio, entry.body]);
  if (!m) return null;
  return (
    <>
      {entry.kind !== "surface" ? <div className={row}><span className="text-ink-2">Volume</span><span className="mono" data-prop="volume">{mm3(m.volume)}</span></div> : null}
      <div className={row}><span className="text-ink-2">Surface area</span><span className="mono" data-prop="area">{mm2(m.area)}</span></div>
      {m.mass !== null ? <div className={row}><span className="text-ink-2">Mass</span><span className="mono" data-prop="mass">{kg(m.mass)}</span></div> : null}
    </>
  );
}

export function openPartProperties(studio: PartStudio, entry: PartEntry): void {
  const s = studio.getState(), doc = studio.doc;
  const stored = partPropsOf(doc)[entry.id] || {};
  const canEdit = s.canEdit;
  let name = entry.name, description = stored.description || "";
  let fields: { label: string; value: string }[] = Object.entries(stored.fields || {}).map(([label, value]) => ({ label, value }));
  const made = s.features.find((f) => f.id === entry.featureId);
  const mat = entry.body ? materialOf(doc, entry.body) : null;
  const kind = SECTIONS.find((x) => x.kind === entry.kind)!.one;
  const labels = () => fields.map((f) => f.label.trim()).filter(Boolean);
  const valid = () => !!name.trim() && new Set(labels()).size === labels().length;
  formDialog({
    title: `Properties of ${entry.name}`, width: 440, valid, okLabel: canEdit ? "OK" : "Close",
    body: (redraw) => (
      <div className="flex flex-col gap-1.5 text-sm" data-part-properties={entry.id}>
        <label className={row}><span className="text-ink-2">Name</span>
          <input className="input w-full" value={name} maxLength={MAX_PART_NAME} disabled={!canEdit || entry.reference} data-prop="name" autoFocus onChange={(ev) => { name = ev.target.value; redraw(); }} />
        </label>
        <label className={row + " items-start"}><span className="text-ink-2 pt-1">Description</span>
          <textarea className="input w-full min-h-16 py-1 resize-y [font-family:inherit]" value={description} disabled={!canEdit} data-prop="description" placeholder="What it is, or what it is for" onChange={(ev) => { description = ev.target.value; redraw(); }} />
        </label>
        {fields.map((f, i) => (
          <div key={i} className="grid grid-cols-[104px_minmax(0,1fr)_auto] items-center gap-x-2 min-h-7" data-prop-field={f.label}>
            <input className="input w-full" value={f.label} disabled={!canEdit} aria-label="Property" placeholder="Property" onChange={(ev) => { fields[i] = { ...f, label: ev.target.value }; redraw(); }} />
            <input className="input w-full" value={f.value} disabled={!canEdit} aria-label={`Value of ${f.label || "the property"}`} placeholder="Value" onChange={(ev) => { fields[i] = { ...f, value: ev.target.value }; redraw(); }} />
            <button type="button" className="btn sm ghost h-6 w-6 p-0 justify-center" disabled={!canEdit} aria-label={`Remove ${f.label || "the property"}`} title="Remove" onClick={() => { fields = fields.filter((_x, j) => j !== i); redraw(); }}>×</button>
          </div>
        ))}
        {canEdit && fields.length < MAX_PART_FIELDS ? <button type="button" className="btn sm self-start" data-prop-add onClick={() => { fields = [...fields, { label: "", value: "" }]; redraw(); }}>Add a property</button> : null}
        {!valid() && name.trim() ? <p className="note m-0 text-xs text-err">Two properties have the same name.</p> : null}
        <div className="flex flex-col border-t border-line pt-1.5 mt-0.5 text-ink">
          <div className={row}><span className="text-ink-2">Type</span><span data-prop="type">{kind[0].toUpperCase() + kind.slice(1)}{entry.reference ? " (reference geometry)" : ""}</span></div>
          {made ? <div className={row}><span className="text-ink-2">Made by</span><span className="truncate" data-prop="made-by">{made.name}</span></div> : null}
          {entry.body && (entry.kind === "part" || entry.kind === "composite") ? <div className={row}><span className="text-ink-2">Material</span><span data-prop="material">{mat ? `${mat.name} (${mat.density} g/cm³)` : "None"}</span></div> : null}
          <Measured studio={studio} entry={entry} />
        </div>
      </div>
    ),
    ok() {
      if (!canEdit || !studio.doc) return;
      const now = partPropsOf(studio.doc)[entry.id]?.fields || {};
      const next: { [label: string]: string | null } = {};
      for (const label of Object.keys(now)) next[label] = null;
      for (const f of fields) if (f.label.trim()) next[f.label.trim()] = f.value;
      // a curve without a name of its own is called after its feature
      const fallback = entry.body ? "" : made?.name || "";
      const changes = updatePart(studio.doc, entry.id, { ...(entry.reference || name.trim() === entry.name ? {} : { name, fallback }), description, fields: next });
      if (changes.length) studio.commit(changes);
    },
  });
}

// ---------------------------------------------------------------- material
/** Changes made one after the other as one edit: each is worked out on the document as the ones before leave it. */
function inOrder(doc: ItemDoc, steps: ((doc: ItemDoc) => ItemChange[])[]): ItemChange[] {
  const scratch: ItemDoc = { ...doc, items: new Map(doc.items) };
  const out: ItemChange[] = [];
  for (const step of steps) { const c = step(scratch); applyChanges(scratch, c); out.push(...c); }
  return out;
}

const slug = (name: string, taken: (id: string) => boolean): string => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "material";
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
};

export function openPartMaterial(studio: PartStudio, entries: readonly PartEntry[]): void {
  const doc = studio.doc; if (!doc || !entries.length) return;
  const ids = entries.map((e) => e.body!).filter(Boolean);
  const { library, assign } = materialsOf(doc);
  const first = assign[ids[0]] || "";
  let choice = ids.every((id) => (assign[id] || "") === first) ? first : "";
  let fresh = { name: "", density: "", color: "#9aa3ad" };
  const names = Object.entries(library).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const density = () => Number(fresh.density.replace(",", "."));
  const valid = () => choice !== NEW || (!!fresh.name.trim() && density() > 0 && Number.isFinite(density()));
  formDialog({
    title: entries.length === 1 ? `Material of ${entries[0].name}` : `Material of ${entries.length} parts`, valid, okLabel: "Assign",
    body: (redraw) => {
      const m = choice && choice !== NEW ? library[choice] : null;
      return (
        <div className="flex flex-col gap-1.5 text-sm" data-part-material>
          <label className={row}><span className="text-ink-2">Material</span>
            <Select className="input w-full" value={choice} label="Material" data={{ param: "material" }} onChange={(v) => { choice = v; redraw(); }}
              options={[{ value: "", label: "No material" }, ...names.map(([id, x]) => ({ value: id, label: x.name })), { value: "sep", label: "", sep: true }, { value: NEW, label: "A new material…" }]} />
          </label>
          {m ? (
            <>
              <div className={row}><span className="text-ink-2">Density</span><span className="mono" data-material-density>{m.density} g/cm³</span></div>
              <div className={row}><span className="text-ink-2">Colour</span><span className="flex items-center gap-1.5"><i className="inline-block w-4 h-4 rounded-sm border border-line" style={{ background: m.color }} /><span className="text-ink-3 text-xs">unless the part has a colour of its own</span></span></div>
            </>
          ) : null}
          {choice === NEW ? (
            <>
              <label className={row}><span className="text-ink-2">Name</span><input className="input w-full" value={fresh.name} data-param="material-name" placeholder="PETG" autoFocus onChange={(ev) => { fresh = { ...fresh, name: ev.target.value }; redraw(); }} /></label>
              <label className={row}><span className="text-ink-2">Density</span><span className="flex items-center gap-1.5"><input className="input mono w-full" inputMode="decimal" value={fresh.density} data-param="material-density" placeholder="1.27" onChange={(ev) => { fresh = { ...fresh, density: ev.target.value }; redraw(); }} /><span className="text-ink-3 font-mono text-xs">g/cm³</span></span></label>
              <label className={row}><span className="text-ink-2">Colour</span><input type="color" className="w-7 h-6 p-0 border border-line rounded-sm bg-panel cursor-pointer" value={fresh.color} data-param="material-color" aria-label="Colour of the material" onChange={(ev) => { fresh = { ...fresh, color: ev.target.value }; redraw(); }} /></label>
              <p className="note m-0 text-xs text-ink-3">The material is added to this document's library, for every part and everyone working in it.</p>
            </>
          ) : null}
          {!choice ? <p className="note m-0 text-xs text-ink-3">Without a material a part has a volume but no mass.</p> : null}
        </div>
      );
    },
    ok() {
      const d = studio.doc; if (!d) return;
      let changes: ItemChange[];
      if (choice === NEW) {
        const id = slug(fresh.name, (x) => !!materialsOf(d).library[x]);
        changes = inOrder(d, [(x) => defineMaterial(x, id, { name: fresh.name.trim(), density: density(), color: fresh.color }), (x) => assignMaterial(x, ids, id)]);
      } else changes = assignMaterial(d, ids, choice || null);
      if (changes.length) studio.commit(changes);
    },
  });
}

// ---------------------------------------------------------------- appearance
export function openPartAppearance(studio: PartStudio, entries: readonly PartEntry[]): void {
  const doc = studio.doc; if (!doc || !entries.length) return;
  const ids = entries.map((e) => e.body!).filter(Boolean);
  const display = displayOf(studio);
  const look = display.lookOf(ids[0]);
  let color = display.hexOf(ids[0]), opacity = display.opacityOf(ids[0]);
  let own = !!look.color, touched = false;
  formDialog({
    title: entries.length === 1 ? `Appearance of ${entries[0].name}` : `Appearance of ${entries.length} items`, width: 380,
    body: (redraw) => (
      <div className="flex flex-col gap-1.5 text-sm" data-part-appearance>
        <label className={row}><span className="text-ink-2">Colour</span>
          <span className="flex items-center gap-2">
            <input type="color" className="w-9 h-6 p-0 border border-line rounded-sm bg-panel cursor-pointer" value={color} data-param="color" aria-label="Colour" onChange={(ev) => { color = ev.target.value; own = true; touched = true; redraw(); }} />
            <span className="mono text-xs text-ink-2">{own ? color : "the material's, or the default"}</span>
          </span>
        </label>
        <label className={row}><span className="text-ink-2">Opacity</span>
          <span className="flex items-center gap-2">
            <input type="range" min={0.1} max={1} step={0.05} value={opacity} className="flex-1 min-w-0" data-param="opacity" aria-label="Opacity" onChange={(ev) => { opacity = Number(ev.target.value); touched = true; redraw(); }} />
            <span className="mono w-9 text-right">{Math.round(opacity * 100)}%</span>
          </span>
        </label>
        <div className={row}><span /><button type="button" className="btn sm self-start justify-self-start" data-appearance-reset disabled={!own && opacity === 1 && !look.faces} title="Back to the material's or the default colour, fully opaque; coloured faces too"
          onClick={() => { own = false; opacity = 1; touched = true; redraw(); }}>Reset</button></div>
        <p className="note m-0 text-xs text-ink-3">Stored in the document: everyone sees it. To look through a part only in your own view, use Make transparent.</p>
      </div>
    ),
    ok() {
      const d = studio.doc; if (!d || !touched) return;
      const changes = !own && opacity === 1 ? resetLook(d, ids) : setBodyLook(d, ids, { color: own ? color : null, opacity });
      if (changes.length) studio.commit(changes);
    },
  });
}
