// forms.ts — the small forms the assembly's tools ask (ui/assembly.ts `ask`, drawn by AssemblyView's FormDialog):
// a relation between two mates, an instance pattern.  Each builds its fields from what is in the assembly now
// and, accepted, calls the editor.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { Vec3 } from "../../mechanical/api";
import type { PatternItem, RelationItem } from "../document/extras";
import { relationDef } from "../model/relations";
import type { AssemblyEditor, FormField } from "./assembly";

const AXES: { [k: string]: Vec3 } = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Make a relation of this type, or change one: which two mates, and its numbers. */
export function askRelation(a: AssemblyEditor, type: string, editing?: RelationItem): void {
  const def = relationDef(type);
  if (!def) return;
  const first = a.matesWith(def.a.unit), second = a.matesWith(def.b.unit);
  if (!first.length || !second.length) { a.host.toast(`${def.title}: ${def.hint}`, 5000); return; }
  const value = (x: { mate: { id: string }; key: string }) => `${x.mate.id}|${x.key}`;
  // what is selected in the list goes in first: select two hinges, then Gear
  const sel = a.getState().selection;
  const pick = (list: typeof first, not?: string) => list.find((x) => sel.includes(x.mate.id) && value(x) !== not) || list.find((x) => value(x) !== not) || list[0];
  const a0 = editing ? `${editing.a.mate}|${editing.a.key}` : value(pick(first));
  const b0 = editing ? `${editing.b.mate}|${editing.b.key}` : value(pick(second, def.sameMate || def.a.unit !== def.b.unit ? undefined : a0));
  const params: JsonObject = { ...def.defaults(), ...(editing ? editing.params : {}) };
  const fields: FormField[] = [
    { key: "a", label: def.a.label, kind: "choice", value: a0, options: first.map((x) => ({ value: value(x), label: x.label })) },
    { key: "b", label: def.b.label, kind: "choice", value: b0, options: second.map((x) => ({ value: value(x), label: x.label })) },
    ...def.schema.map((f): FormField => (f.kind === "boolean" ? { key: f.key, label: f.label, kind: "boolean", value: !!params[f.key], hint: f.hint } : { key: f.key, label: f.label, kind: "number", value: Number(params[f.key]) || 0, unit: f.kind === "number" && f.unit && f.unit !== "none" ? f.unit : undefined, hint: f.hint })),
  ];
  a.ask({
    title: editing ? editing.name : `${def.title} relation`, acceptLabel: editing ? "Done" : "Add", fields, note: def.hint,
    accept: (v) => {
      const end = (s: string) => { const [mate, key] = String(s).split("|"); return { mate, key }; };
      const ea = end(String(v.a)), eb = end(String(v.b));
      if (ea.mate === eb.mate && ea.key === eb.key) { a.host.toast("A relation ties two different mates. Choose another for one side.", 4000); return; }
      const p: JsonObject = {};
      for (const f of def.schema) p[f.key] = v[f.key];
      if (editing) a.editRelation(editing.id, { a: ea, b: eb, params: p }); else a.addRelation(type, ea, eb, p);
    },
  });
}

/** A linear or a circular pattern of the selected instances. */
export function askPattern(a: AssemblyEditor, type: "linear" | "circular"): void {
  const seeds = a.selectedInstances().map((i) => i.id);
  if (!seeds.length) { a.host.toast("Select the instances to repeat first.", 3000); return; }
  const linear = type === "linear";
  a.ask({
    title: linear ? "Linear pattern" : "Circular pattern", acceptLabel: "Add",
    note: linear ? "The copies go where their seed goes. Change the count later from the pattern's menu." : "The copies turn about the axis with their seed.",
    fields: [
      { key: "count", label: "Instances", kind: "number", value: linear ? 3 : 6, hint: "How many in all, the seed included." },
      linear ? { key: "spacing", label: "Distance", kind: "number", value: 50, unit: "mm", hint: "From one to the next." } : { key: "angle", label: "Angle", kind: "number", value: 60, unit: "°", hint: "From one to the next. 360 over the count goes all the way round." },
      { key: "along", label: linear ? "Direction" : "Axis", kind: "choice", value: linear ? "x" : "z", options: [{ value: "x", label: linear ? "Along X" : "X, through the origin" }, { value: "y", label: linear ? "Along Y" : "Y, through the origin" }, { value: "z", label: linear ? "Along Z" : "Z, through the origin" }, { value: "pick", label: linear ? "An edge or a face I click" : "A hole or a round edge I click" }] },
    ],
    accept: (v) => {
      const count = Math.floor(Number(v.count));
      if (!(count >= 2)) { a.host.toast("A pattern has two instances or more.", 3000); return; }
      const make = (at: { direction?: Vec3; origin?: Vec3; axis?: Vec3 }) => a.addPattern(type, seeds, { count, spacing: Number(v.spacing) || 0, angle: Number(v.angle) || 0, ...at });
      if (v.along !== "pick") { make(linear ? { direction: AXES[String(v.along)] } : { origin: [0, 0, 0], axis: AXES[String(v.along)] }); return; }
      a.pick(linear ? "Click a straight edge or a flat face: the copies go along it. Esc to stop." : "Click a hole, a shaft or a round edge: the copies go round its axis. Esc to stop.", (_pick, frame) => { make(linear ? { direction: frame.z } : { origin: frame.o, axis: frame.z }); });
    },
  });
}

/** Change a pattern's count and its distance or angle. */
export function askEditPattern(a: AssemblyEditor, p: PatternItem): void {
  const linear = p.patternType === "linear";
  a.ask({
    title: p.name, fields: [
      { key: "count", label: "Instances", kind: "number", value: p.count },
      linear ? { key: "spacing", label: "Distance", kind: "number", value: p.spacing || 0, unit: "mm" } : { key: "angle", label: "Angle", kind: "number", value: p.angle || 0, unit: "°" },
    ],
    accept: (v) => a.editPattern(p.id, linear ? { count: Number(v.count), spacing: Number(v.spacing) } : { count: Number(v.count), angle: Number(v.angle) }),
  });
}
