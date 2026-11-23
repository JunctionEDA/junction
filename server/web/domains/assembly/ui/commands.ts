// commands.ts — everything a person can start in an assembly, as one list: the tools (tools/*.ts), the mates
// (mates/*.ts) and the relations (model/relations.ts), each with its name, its key, one line on what it does,
// the other words people look for it by, and whether it can run just now.  The toolbar (Toolbar.tsx) draws it,
// the tool search and the marking menu (Overlays.tsx) read it, and the keys (keys.ts) are bound to it.  Nothing
// is listed by hand: a tool says which section it is in and how long it keeps its place on a narrow bar.
//
// The bar, in the order an Onshape user's hands know:
//
//   undo redo │ Insert │ Fastened Revolute Slider Planar Cylindrical Pin slot Ball Parallel Tangent Width │
//   Mate connector Group Fix │ Relations ▾ │ Pattern ▾ │ Exploded view Named position Animate │
//   Bill of materials Interference Section view Measure Mass properties │ History │ More ▾     Search tools… S
//
// The same shapes as the part studio's (mechanical ui/commands.ts: Entry, Slot, Section), so both bars are drawn alike.
import type { Entry, KeyCommand, Section, Slot } from "../../mechanical/api-ui";
import { TOOL_SECTIONS, type AssemblyToolDefinition, type ToolSection } from "../core/tool";
import type { MateDefinition } from "../core/mate";
import { RELATIONS, type RelationDefinition } from "../model/relations";
import type { AssemblyEditor } from "./assembly";
import { askRelation } from "./forms";
import { commandForEvent, getPrefs, setKeyCommands, setPrefs, shortcutOf } from "./keys";
import { MATES, TOOLS } from "../generated/page";

const byOrder = <T extends { title: string; order?: number }>(a: T, b: T): number => (a.order ?? 1e6) - (b.order ?? 1e6) || a.title.localeCompare(b.title);
/** keys that are not a person's to change: shown in the tooltips, handled by the editor itself */
const FIXED_KEYS: { [id: string]: string } = { undo: "Ctrl+Z", redo: "Ctrl+Y" };
/** the mates a person reaches for most keep their buttons longest */
const MATE_KEEP: { [type: string]: number } = { fastened: 95, revolute: 92, slider: 90, planar: 88, cylindrical: 86, "pin-slot": 66, ball: 66, parallel: 64, tangent: 64, width: 62 };
const MATE_KEYS: { [type: string]: string } = { fastened: "Shift+F", revolute: "Shift+R", slider: "Shift+S", planar: "Shift+P", cylindrical: "Shift+C" };
const SECTION_TITLES: { [s in ToolSection]: string } = { edit: "Edit", insert: "Insert", mate: "Mates", connect: "Connect", relation: "Relations", pattern: "Pattern", view: "Views", inspect: "Inspect", file: "File", more: "View" };

export function toolEntry(a: AssemblyEditor, t: AssemblyToolDefinition): Entry {
  return {
    id: t.id, title: t.title, hint: t.hint, icon: t.icon, shortcut: FIXED_KEYS[t.id] || shortcutOf(t.id), keywords: t.keywords,
    on: t.active ? t.active(a) : false, why: t.disabled ? t.disabled(a) : null,
    run: () => { t.run(a); },
  };
}
export function mateEntry(a: AssemblyEditor, m: MateDefinition): Entry {
  const s = a.getState(), on = !!s.mating && s.mating.isNew && s.mating.mateType === m.type;
  return {
    id: "m:" + m.type, title: m.title, hint: `${m.hint || "A mate."} Then click a connector on each of two instances.`, icon: m.icon, shortcut: shortcutOf("m:" + m.type), keywords: m.keywords || "mate joint constrain", meaning: "mate",
    on, why: s.canEdit ? (s.instances.length >= 2 ? null : "Place two instances first") : "View-only access",
    run: () => { if (on) a.cancelMate(); else { if (a.getState().mating) a.cancelMate(); a.startMate(m.type); } },
  };
}
export function relationEntry(a: AssemblyEditor, r: RelationDefinition): Entry {
  const s = a.getState();
  const can = a.matesWith(r.a.unit).length && a.matesWith(r.b.unit).length && (r.sameMate || r.a.unit !== r.b.unit || a.matesWith(r.a.unit).length >= 2);
  return {
    id: "r:" + r.type, title: `${r.title} relation`, hint: r.hint, icon: r.icon, shortcut: shortcutOf("r:" + r.type), keywords: r.keywords, meaning: "relation",
    why: !s.canEdit ? "View-only access" : s.mating ? "Finish the mate first" : can ? null : `Needs ${r.a.unit === "deg" ? "a mate that turns" : "a mate that slides"} and ${r.b.unit === "deg" ? (r.a.unit === "deg" ? "another" : "a mate that turns") : r.a.unit === "mm" ? "another" : "a mate that slides"}: make the mates first`,
    run: () => askRelation(a, r.type),
  };
}

const mates = (): MateDefinition[] => MATES.filter((m) => m.solve).slice().sort(byOrder);
const tools = (section: ToolSection): AssemblyToolDefinition[] => TOOLS.filter((t) => (t.section || "more") === section).slice().sort(byOrder);

function slotsOf(a: AssemblyEditor, list: AssemblyToolDefinition[], prefix: string): Slot[] {
  const slots: Slot[] = [];
  for (const t of list) {
    const menu = t.menu || null, e = toolEntry(a, t), keep = t.keep ?? 50;
    const have = menu ? slots.find((s) => s.menu === menu) : undefined;
    if (have) { have.entries.push(e); have.keep = Math.max(have.keep, keep); }
    else slots.push({ key: `${prefix}/${menu || e.id}`, menu, entries: [e], keep });
  }
  return slots.map((s) => (s.menu !== null && s.entries.length === 1 ? { ...s, menu: null } : s));
}

/** The toolbar: every section that has something in it. */
export function toolbarSections(a: AssemblyEditor): Section[] {
  const out: Section[] = [];
  for (const id of TOOL_SECTIONS) {
    let slots: Slot[];
    if (id === "mate") slots = mates().map((m) => ({ key: "mate/" + m.type, menu: null, entries: [mateEntry(a, m)], keep: MATE_KEEP[m.type] ?? 60 }));
    else if (id === "relation") slots = [{ key: "relation/Relations", menu: "Relations", entries: RELATIONS.map((r) => relationEntry(a, r)), keep: 60 }];
    else slots = slotsOf(a, tools(id), id).map((s) => (id === "more" ? { ...s, keep: 0 } : s));
    if (slots.length) out.push({ id, group: id, title: SECTION_TITLES[id], slots, labelled: id === "insert" });
  }
  return out;
}

/** Everything that can be started, for the tool search, in toolbar order; then what has no button of its own. */
export function allCommands(a: AssemblyEditor): Entry[] {
  const out: Entry[] = toolbarSections(a).flatMap((s) => s.slots.flatMap((x) => x.entries));
  const s = a.getState(), sel = a.selectedInstances(), ro = s.canEdit ? null : "View-only access";
  const own = (id: string, title: string, hint: string, keywords: string, why: string | null, run: () => void): Entry => ({ id, title, hint, keywords, why, run });
  out.push(
    own("folder", "New folder", "A folder in the instance list, for the selected instances.", "folder organise organize tree", ro, () => a.newFolder(sel.map((i) => i.id))),
    own("suppress", sel.length && sel.every((i) => i.suppressed) ? "Unsuppress" : "Suppress", "Take the selected instances out of the assembly without deleting them; their mates are not applied.", "disable turn off exclude", ro || (sel.length ? null : "Select an instance first"), () => a.setSuppressed(sel.map((i) => i.id), !sel.every((i) => i.suppressed))),
    own("open-source", "Edit the part", "Open the part studio, board or sub-assembly the selected instance comes from. Also a double click on it.", "edit in context open part studio source", sel.length === 1 ? null : "Select one instance first", () => a.openSource(sel[0].id)),
    own("delete", "Delete", "Remove what is selected.", "remove erase", ro || (s.selection.length ? null : "Nothing is selected"), () => a.remove()),
    own("keys", "Change keys…", "Give any tool the key you like.", "rebind keymap hotkeys customise customize", null, () => a.setUi({ keys: true })),
  );
  return out;
}

/** The entry of a drop-down that its button runs: the one used last (remembered in this browser), else the first. */
export function lastUsed(menuKey: string, entries: readonly Entry[]): Entry { const id = getPrefs().toolVariant[menuKey]; return entries.find((e) => e.id === id) || entries[0]; }
export function rememberUsed(menuKey: string, entry: Entry): void { if (getPrefs().toolVariant[menuKey] !== entry.id) setPrefs({ toolVariant: { ...getPrefs().toolVariant, [menuKey]: entry.id } }); }

// ---------------------------------------------------------------- keys
/** Every command that may have a key: the tools, the mates and the relations. */
setKeyCommands((): KeyCommand[] => [
  ...TOOLS.filter((t) => !FIXED_KEYS[t.id]).map((t) => ({ id: t.id, title: t.title, context: "model" as const, chord: t.key || null })),
  ...mates().map((m) => ({ id: "m:" + m.type, title: `${m.title} mate`, context: "model" as const, chord: MATE_KEYS[m.type] || null })),
  ...RELATIONS.map((r) => ({ id: "r:" + r.type, title: `${r.title} relation`, context: "model" as const, chord: null })),
]);

/** Hand the editor the way a key starts a command (the editor does not import the commands: they import it). */
export function bindKeys(a: AssemblyEditor): void {
  a.runKey = (ev) => {
    const b = commandForEvent(ev);
    const e = b && allCommands(a).find((x) => x.id === b.id);
    if (!e) return false;
    if (e.why) a.host.toast(`${e.title}: ${e.why}`, 2500); else e.run();
    return true;
  };
}

// ---------------------------------------------------------------- the marking menu
/** The eight tools round the pointer, N first and clockwise (null: an empty direction).  Up is the last mate again; undo is to the left. */
export function markingEntries(a: AssemblyEditor, onInstance: boolean): (Entry | null)[] {
  const all = allCommands(a), by = (id: string) => all.find((e) => e.id === id) || null;
  const s = a.getState();
  if (s.mating) {
    const own = (id: string, title: string, icon: string, run: () => void): Entry => ({ id, title, icon, run });
    return [own("@accept", "Done", '<path d="M5 12.5l4.5 4.5L19 7.5"/>', () => a.acceptMate()), null, null, null, own("@cancel", "Cancel", '<path d="M6 6l12 12M18 6L6 18"/>', () => a.cancelMate()), null, null, null];
  }
  const again = a.lastMate ? by("m:" + a.lastMate) : null;
  return [
    again ? { ...again, id: "@repeat", title: `Again: ${again.title}` } : by("m:fastened"),
    by("insert"), by("m:fastened"), by("m:revolute"), by("measure"), onInstance ? by("fix") : by("m:slider"), by("undo"), onInstance ? by("hide") : by("redo"),
  ];
}
