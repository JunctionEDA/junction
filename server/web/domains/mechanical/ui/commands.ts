// commands.ts — everything a person can start in a part studio, as one list: the feature types (features/*.ts)
// and the tools (tools/*.ts), with their names, keys, one-line descriptions, the other words people look for
// them by, and whether they can run just now.  The toolbar (Toolbar.tsx) draws the part of it that fits the mode
// the studio is in; the tool search (Overlays.tsx) and the shortcut sheet read all of it.  Nothing is listed by
// hand: a feature or a tool says where it goes (its section, its order, how long it keeps its place).
//
// The modes, and what the toolbar shows in each (the order an Onshape user's hands know):
//
//   model    undo redo │ Sketch │ Extrude Revolve Sweep Loft │ Fillet Chamfer Draft Shell Hole │ Boolean Split
//            Transform ▾ │ Pattern ▾ Mirror │ Plane ▾ │ Board ▾ │ Measure Section │ History │ More ▾  Search tools… S
//   sketch   undo redo │ Line Rectangle ▾ Circle Arc ▾ Slot Point Construction │ Fillet Offset Use Mirror Trim
//            Extend │ the constraints │ Dimension │ Extrude Revolve │ More ▾      Search tools… S  ✓ Finish  ✗
//   dialog   what is being edited and what a click will pick │ More ▾                 Search tools… S  ✓  ✗
//   view     (no edit rights) Measure Section │ More ▾                                  Search tools… S
//
// "More ▾" holds what is used less (the view options, import and export, comments, delete) and, in a window too
// narrow for the rest, the buttons that keep their place least (`keep`), so the bar never scrolls.
import { FEATURE_SECTIONS, type FeatureDefinition } from "../core/feature";
import type { ToolDefinition } from "../core/tool";
import { getPrefs, setPrefs } from "./prefs";
import { KEYWORDS, RESULT_WORDS } from "./search";
import { FEATURE_KEYS, awaitsPlane, type PartStudio } from "./studio";

export interface Entry {
  id: string; title: string;
  /** one line on what it does */
  hint?: string;
  icon?: string;
  /** as shown: "L", "Shift+E", "Del" */
  shortcut?: string;
  /** other words people look for it by, for the tool search: "cut pocket" */
  keywords?: string;
  /** drawn pressed */
  on?: boolean;
  /** why it cannot run just now (null: it can) */
  why?: string | null;
  run(): void;
}
/** One place in the bar: a button, or a family of variants (one button and a caret). */
export interface Slot {
  key: string;
  /** the family's name; null: a single button */
  menu: string | null;
  entries: Entry[];
  /** how long it keeps its place when the bar is too narrow (higher: longer); 0: it is always under More */
  keep: number;
}
export interface Section {
  id: string; group: string;
  /** the heading of its part of the More menu */
  title: string;
  slots: Slot[];
  /** its buttons carry their names (Sketch) */
  labelled?: boolean;
}
export type Mode = "model" | "sketch" | "dialog" | "view";

export const modeOf = (studio: PartStudio): Mode => {
  const s = studio.getState();
  return s.sketch || awaitsPlane(s) ? "sketch" : s.editing ? "dialog" : s.canEdit ? "model" : "view";
};

/** What each feature does, in a line (the tooltip and the tool search). */
const FEATURE_HINTS: { [type: string]: string } = {
  sketch: "Draw on a plane or a flat face: the profile most features start from.",
  extrude: "Pull a sketch region straight out into a solid, or cut with it.",
  revolve: "Turn a sketch region about an axis into a solid, or cut with it.",
  sweep: "Carry a sketch region along a path.",
  loft: "Blend between two or more sketch regions.",
  fillet: "Round the picked edges.",
  chamfer: "Bevel the picked edges.",
  draft: "Tilt faces so a moulded part comes out of its tool.",
  shell: "Hollow a part, leaving walls of one thickness; the picked faces are opened.",
  hole: "Drill simple, counterbored or countersunk holes at sketch points.",
  boolean: "Join parts, cut one from another, or keep what they share.",
  split: "Cut a part in two with a plane or a face.",
  "delete-body": "Remove a part from the model.",
  transform: "Move, turn or copy a part.",
  "linear-pattern": "Repeat parts or features along one or two directions.",
  "circular-pattern": "Repeat parts or features around an axis.",
  mirror: "Copy parts or features across a plane.",
  plane: "A reference plane: offset, through points, at an angle, mid-way.",
  axis: "A reference axis.",
  point: "A reference point.",
  helix: "A helical curve to sweep along.",
  "board-reference": "Show a circuit board of this project in the model, kept current.",
  "board-cutout": "An opening that follows a part of the board.",
  "board-standoffs": "Posts under the board's mounting holes.",
};

const keyText = (key: string | undefined): string | undefined => (!key ? undefined : key.length === 1 ? key.toUpperCase() : key === "Delete" ? "Del" : key);
const byOrder = <T extends { title: string }>(order: (x: T) => number | undefined) => (a: T, b: T) => (order(a) ?? 1e6) - (order(b) ?? 1e6) || a.title.localeCompare(b.title);

export function toolEntry(studio: PartStudio, t: ToolDefinition): Entry {
  return {
    id: t.id, title: t.title, hint: t.hint, icon: t.icon, shortcut: keyText(t.key), keywords: KEYWORDS[t.id],
    on: t.active ? t.active(studio) : false, why: t.disabled ? t.disabled(studio) : null,
    run: () => { t.run(studio); studio.viewport.canvas.focus(); },
  };
}
export function featureEntry(studio: PartStudio, f: FeatureDefinition): Entry {
  const s = studio.getState();
  const key = Object.keys(FEATURE_KEYS).find((k) => FEATURE_KEYS[k] === f.type);
  return {
    id: "f:" + f.type, title: f.title, hint: FEATURE_HINTS[f.type] ?? f.hint, icon: f.icon, shortcut: key ? `Shift+${key.toUpperCase()}` : undefined, keywords: KEYWORDS["f:" + f.type] ?? f.keywords,
    why: s.canEdit ? null : "View-only access", run: () => { studio.startFeature(f.type); studio.viewport.canvas.focus(); },
  };
}

/**
 * A feature started with one of its result choices already made: "Extrude: remove" is what a person who types
 * "cut" or "pocket" is looking for.  One per choice of a feature's `operation` field other than the default.
 */
function presetEntries(studio: PartStudio, f: FeatureDefinition): Entry[] {
  const field = f.schema.find((x) => x.key === "operation" && x.kind === "enum");
  if (!field || field.kind !== "enum") return [];
  const usual = (f.defaults() as { operation?: string }).operation;
  const base = featureEntry(studio, f);
  return field.options.filter((o) => o.value !== usual && RESULT_WORDS[o.value]).map((o) => ({
    ...base, id: `${base.id}:${o.value}`, title: `${f.title}: ${o.label.toLowerCase()}`, shortcut: undefined, keywords: RESULT_WORDS[o.value],
    hint: `${f.title} with its result set to ${o.label.toLowerCase()}.`,
    run: () => { studio.startFeature(f.type); if (studio.getState().editing?.draft.featureType === f.type) studio.setDraft({ params: { operation: o.value } }); studio.viewport.canvas.focus(); },
  }));
}

const DEFAULT_KEEP = 50;
function slotsOf<T>(list: T[], menuOf: (x: T) => string | undefined, entry: (x: T) => Entry, keepOf: (x: T) => number | undefined, prefix: string): Slot[] {
  const slots: Slot[] = [];
  for (const x of list) {
    const menu = menuOf(x) || null, e = entry(x), keep = keepOf(x) ?? DEFAULT_KEEP;
    const have = menu ? slots.find((s) => s.menu === menu) : undefined;
    // a family keeps its place as long as the member that keeps it longest
    if (have) { have.entries.push(e); have.keep = Math.max(have.keep, keep); }
    else slots.push({ key: `${prefix}/${menu || e.id}`, menu, entries: [e], keep });
  }
  // a family of one is a plain button
  return slots.map((s) => (s.menu !== null && s.entries.length === 1 ? { ...s, menu: null } : s));
}

/** The parts of the sketch toolbar, by the tools' `order`: draw, modify, constrain, dimension. */
const SKETCH_PARTS: { id: string; title: string; from: number; to: number }[] = [
  { id: "sketch-draw", title: "Draw", from: 1, to: 100 }, { id: "sketch-modify", title: "Modify", from: 100, to: 200 },
  { id: "sketch-constrain", title: "Constrain", from: 200, to: 300 }, { id: "sketch-dimension", title: "Dimension", from: 300, to: 900 },
];
const SECTION_TITLES: { [id: string]: string } = { edit: "Edit", sketch: "Sketch", solid: "Create", modify: "Modify", combine: "Combine", direct: "Direct editing", pattern: "Pattern", reference: "Reference geometry", board: "Circuit board", inspect: "Inspect", view: "View", file: "File" };

/** The toolbar for the mode the studio is in. */
export function toolbarSections(studio: PartStudio): Section[] {
  const mode = modeOf(studio), s = studio.getState();
  const out: Section[] = [];
  const features = studio.definitions().filter((f) => f.toolbar !== false).slice().sort(byOrder((f) => f.toolbarOrder));
  const tools = (group: string): ToolDefinition[] => studio.tools().filter((t) => t.group === group && t.button !== false).slice().sort(byOrder((t) => t.order));
  const te = (t: ToolDefinition) => toolEntry(studio, t), fe = (f: FeatureDefinition) => featureEntry(studio, f);
  const section = (id: string, group: string, slots: Slot[], labelled = false): Section => ({ id, group, title: SECTION_TITLES[id] || id, slots, labelled });
  const ofTools = (id: string, list: ToolDefinition[], keep?: (t: ToolDefinition) => number): Section => section(id, list[0]?.group || id, slotsOf(list, (t) => t.menu, te, keep || ((t) => t.keep), id));
  // what is used less is under More: the view options always (the view cube's menu has them too), the file
  // commands unless one asks for a place (History, whose button shows that its drawer is open)
  const less = () => { out.push(ofTools("view", tools("view"), () => 0), ofTools("file", tools("file"), (t) => t.keep ?? 0)); };

  if (mode === "sketch") {
    // until the new sketch has its plane there is nothing to draw on
    const waiting = awaitsPlane(s);
    const wait = (e: Entry): Entry => (waiting ? { ...e, on: false, why: "Select the sketch plane first" } : e);
    out.push(ofTools("edit", tools("edit").filter((t) => t.id !== "delete")));
    const sk = tools("sketch");
    for (const part of SKETCH_PARTS) out.push({ ...section(part.id, "sketch", slotsOf(sk.filter((t) => (t.order ?? 0) >= part.from && (t.order ?? 0) < part.to), (t) => t.menu, (t) => wait(te(t)), (t) => t.keep, part.id)), title: part.title });
    // what a finished profile is usually for: started from here, the feature takes this sketch
    out.push({ ...section("sketch-use", "feature", slotsOf(features.filter((f) => f.type === "extrude" || f.type === "revolve"), () => undefined, (f) => wait(fe(f)), (f) => Math.min(f.toolbarKeep ?? DEFAULT_KEEP, 45), "sketch-use")), title: "Use the sketch" });
    return out.filter((x) => x.slots.length);
  }
  if (mode === "dialog") {
    // tools that need the pointer for themselves (measure, section) would fight the dialog's picking
    out.push(ofTools("view", tools("view"), () => 0));
    return out.filter((x) => x.slots.length);
  }
  if (mode === "model") {
    out.push(ofTools("edit", tools("edit")));
    for (const sec of FEATURE_SECTIONS) {
      const slots = slotsOf(features.filter((f) => (f.toolbarSection || "solid") === sec), (f) => f.toolbarMenu, fe, (f) => f.toolbarKeep, sec);
      // tools that put themselves among the features follow that section's features (the solids', if they do not say)
      slots.push(...slotsOf(tools("feature").filter((t) => (t.section || "solid") === sec), (t) => t.menu, te, (t) => t.keep, sec));
      out.push(section(sec, "feature", slots, sec === "sketch"));
    }
  }
  out.push(ofTools("inspect", tools("inspect")));
  less();
  return out.filter((x) => x.slots.length);
}

/** Everything that can be started, for the tool search: the tools of this mode first, in toolbar order. */
export function allCommands(studio: PartStudio): Entry[] {
  const s = studio.getState(), sketch = !!s.sketch;
  const tools = studio.tools().slice().sort(byOrder((t) => t.order));
  const out: Entry[] = [];
  if (sketch) out.push(...tools.filter((t) => t.group === "sketch").map((t) => toolEntry(studio, t)));
  // the features in the order the toolbar has them: section by section
  const place = (f: FeatureDefinition) => FEATURE_SECTIONS.indexOf(f.toolbarSection || "solid") * 1e4 + (f.toolbarOrder ?? 9999);
  for (const f of studio.definitions().filter((x) => x.toolbar !== false).slice().sort(byOrder(place))) out.push(featureEntry(studio, f), ...presetEntries(studio, f));
  out.push(...tools.filter((t) => t.group !== "sketch").map((t) => toolEntry(studio, t)));
  out.push(...viewCommands(studio));
  return out;
}

/** What has no tool file of its own: the views and the ways of looking the keys and the view cube also reach. */
export function viewCommands(studio: PartStudio): Entry[] {
  const v = (id: string, title: string, shortcut: string | undefined, hint: string, run: () => void): Entry => ({ id: "view:" + id, title, shortcut, hint, run: () => { run(); studio.viewport.canvas.focus(); } });
  const view = (name: "front" | "back" | "left" | "right" | "top" | "bottom" | "iso", n: number) => v(name, name === "iso" ? "Isometric view" : `${name[0].toUpperCase()}${name.slice(1)} view`, `Shift+${n}`, "Turn the view.", () => studio.viewport.setView(name));
  return [
    v("fit", "Zoom to fit", "F", "Everything in view. Also a double click with the middle button.", () => studio.fit()),
    v("zoom-selection", "Zoom to selection", "Z", "Bring what is selected into view.", () => studio.zoomToSelection()),
    v("normal", "View normal to", "N", "Look straight at the selected flat face or plane, or at the open sketch.", () => studio.normalTo()),
    view("front", 1), view("back", 2), view("left", 3), view("right", 4), view("top", 5), view("bottom", 6), view("iso", 7),
    v("shortcuts", "Keyboard shortcuts", "?", "Every key the part studio answers to.", () => studio.setUi({ help: true })),
  ];
}

/** The entry of a drop-down that its button runs: the one used last (remembered in this browser), else the first. */
export function lastUsed(menuKey: string, entries: readonly Entry[]): Entry {
  const id = getPrefs().toolVariant[menuKey];
  return entries.find((e) => e.id === id) || entries[0];
}
export function rememberUsed(menuKey: string, entry: Entry): void {
  if (getPrefs().toolVariant[menuKey] !== entry.id) setPrefs({ toolVariant: { ...getPrefs().toolVariant, [menuKey]: entry.id } });
}
