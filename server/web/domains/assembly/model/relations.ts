// relations.ts — the relations between mates: Gear, Rack and pinion, Screw, Linear.  A relation ties a value of
// one mate to a value of another (an angle to an angle, a distance to an angle, …) so that the parts move
// together; the solver holds it (solver/types.ts SolverRelation, solver/solver.ts).
//
// A relation item names two mates and which value of each ("angle", "distance") and carries its own numbers.
// What it ties is the change of the two values, so parts mesh as they were assembled: put the teeth together,
// then add the relation.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { ParamField } from "../../mechanical/api";

export interface RelationDefinition {
  /** stored as `relationType`; never rename one that has shipped */
  type: string;
  title: string;
  hint: string;
  icon: string;
  /** other words people look for it by */
  keywords: string;
  /** what each side must be: a mate with an angle (a hinge, a cylinder) or with a distance (a slide) */
  a: { unit: "deg" | "mm"; label: string };
  b: { unit: "deg" | "mm"; label: string };
  /** true when one mate may be both sides (Screw on a Cylindrical mate: its distance and its angle) */
  sameMate?: boolean;
  defaults(): JsonObject;
  schema: ParamField[];
  /** how much a changes per unit of b: millimetres or RADIANS per millimetre or RADIAN */
  ratio(params: JsonObject): number;
  /** the relation in a few words, for the list: "2 : 1", "5 mm per turn" */
  describe(params: JsonObject): string;
}

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const sign = (p: JsonObject): number => (p.reverse ? -1 : 1);
const REVERSE: ParamField = { key: "reverse", label: "Reverse", kind: "boolean", hint: "Turn the second one the other way." };
const trim = (v: number): string => String(Math.round(v * 1000) / 1000);

export const RELATIONS: readonly RelationDefinition[] = [
  {
    type: "gear", title: "Gear", hint: "Two hinges turn together, in a ratio: pick two mates that turn.", keywords: "gears teeth ratio mesh pulley belt chain sprocket transmission relation",
    icon: '<circle cx="8.5" cy="12" r="4.5"/><circle cx="17.5" cy="12" r="2.8"/><path class="t" d="M8.5 5.5v2M8.5 16.5v2M2 12h2M17.5 7.6v1.6M17.5 14.8v1.6M21.9 12h-1.6"/>',
    a: { unit: "deg", label: "First mate (turns)" }, b: { unit: "deg", label: "Second mate (turns)" },
    defaults: () => ({ ratio: 1, reverse: true }),
    schema: [{ key: "ratio", label: "Turns of first", kind: "number", unit: "none", hint: "How many turns the first makes for one turn of the second: the second's teeth over the first's." }, REVERSE],
    ratio: (p) => sign(p) * num(p.ratio, 1),
    describe: (p) => `${trim(num(p.ratio, 1))} : 1${p.reverse ? ", reversed" : ""}`,
  },
  {
    type: "rack", title: "Rack and pinion", hint: "A slide moves as a hinge turns: pick a mate that slides and a mate that turns.", keywords: "rack pinion linear rotary steering relation",
    icon: '<path d="M3 17h18"/><path class="t" d="M5 17v-2M8 17v-2M11 17v-2M14 17v-2M17 17v-2M20 17v-2"/><circle cx="12" cy="9" r="4.5"/><circle class="s" cx="12" cy="9" r="1"/>',
    a: { unit: "mm", label: "Mate that slides" }, b: { unit: "deg", label: "Mate that turns" },
    defaults: () => ({ travel: 20, reverse: false }),
    schema: [{ key: "travel", label: "Travel per turn", kind: "number", unit: "mm", hint: "How far the rack moves for one turn of the pinion: the pinion's pitch circumference." }, REVERSE],
    ratio: (p) => (sign(p) * num(p.travel, 20)) / (2 * Math.PI),
    describe: (p) => `${trim(num(p.travel, 20))} mm per turn${p.reverse ? ", reversed" : ""}`,
  },
  {
    type: "screw", title: "Screw", hint: "A part advances as it turns: pick a Cylindrical mate, or a slide and a hinge.", keywords: "thread lead pitch helix bolt nut leadscrew relation",
    icon: '<path d="M9 3h6v3H9z"/><path d="M10 6v15M14 6v15"/><path class="t" d="M10 9l4-1.5M10 12.5l4-1.5M10 16l4-1.5M10 19.5l4-1.5"/>',
    a: { unit: "mm", label: "Mate that advances" }, b: { unit: "deg", label: "Mate that turns" }, sameMate: true,
    defaults: () => ({ pitch: 1, reverse: false }),
    schema: [{ key: "pitch", label: "Lead per turn", kind: "number", unit: "mm", hint: "How far it advances in one turn: the thread's lead." }, { ...REVERSE, label: "Left-handed" }],
    ratio: (p) => (sign(p) * num(p.pitch, 1)) / (2 * Math.PI),
    describe: (p) => `${trim(num(p.pitch, 1))} mm per turn${p.reverse ? ", left-handed" : ""}`,
  },
  {
    type: "linear", title: "Linear", hint: "Two slides move together, in a ratio: pick two mates that slide.", keywords: "linear slide couple telescopic drawer scissor relation",
    icon: '<path d="M3 8h18M3 16h18"/><rect class="f" x="5" y="5.5" width="6" height="5"/><rect class="f" x="11" y="13.5" width="8" height="5"/>',
    a: { unit: "mm", label: "First mate (slides)" }, b: { unit: "mm", label: "Second mate (slides)" },
    defaults: () => ({ ratio: 1, reverse: false }),
    schema: [{ key: "ratio", label: "Travel of first", kind: "number", unit: "none", hint: "How far the first moves for each millimetre of the second." }, REVERSE],
    ratio: (p) => sign(p) * num(p.ratio, 1),
    describe: (p) => `${trim(num(p.ratio, 1))} : 1${p.reverse ? ", reversed" : ""}`,
  },
];

export const relationDef = (type: string): RelationDefinition | undefined => RELATIONS.find((r) => r.type === type);
