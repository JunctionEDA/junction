// filter.ts — what the search box of the feature list shows.  No React and no studio: it is given the list and
// answers which rows match, so it is tested in node (static/tests/cad-featurelist.test.js).
//
// Plain text matches a feature, a folder or a part by a piece of its name or of its type ("ext" finds Extrude 1
// and every extrude, however it was renamed).  A command, a colon and a word, narrows it; what follows the
// command is the text to look for (none: everything the command covers):
//
//   :part text         parts with that name, and the features that made or changed them
//   :type text         features and parts of that type
//   :name text         by name only
//   :errors text       features that failed
//   :warnings text     features that left a note
//   :folder text       folders with that name (and what they hold)
//   :variable text     features that use a variable (the name as written: capitals matter)
//   :suppressed text   features that are not built because they are suppressed
//   :hidden text       sketches, planes and parts that are hidden
//   :shown text        what is not hidden
//
// Not here, because Junction has no part numbers or revisions: Onshape's :partnumber and :revision.

export type FilterCommand = "part" | "type" | "name" | "errors" | "warnings" | "folder" | "variable" | "suppressed" | "hidden" | "shown";

export const FILTER_COMMANDS: readonly { id: FilterCommand; title: string; hint: string }[] = [
  { id: "part", title: "Part", hint: "Parts by name, and the features that made or changed them" },
  { id: "type", title: "Type", hint: "Features and parts of a type: extrude, sketch, surface" },
  { id: "name", title: "Name", hint: "By name only" },
  { id: "errors", title: "Errors", hint: "Features that failed" },
  { id: "warnings", title: "Warnings", hint: "Features that left a note" },
  { id: "folder", title: "Folder", hint: "Folders by name, with what they hold" },
  { id: "variable", title: "Variable", hint: "Features that use a variable (capitals matter)" },
  { id: "suppressed", title: "Suppressed", hint: "Features that are suppressed" },
  { id: "hidden", title: "Hidden", hint: "Sketches, planes and parts that are hidden" },
  { id: "shown", title: "Shown", hint: "What is not hidden" },
];

export interface FilterQuery {
  /** the command, when the text starts with one */
  command: FilterCommand | null;
  /** what to look for, lower case except for :variable */
  text: string;
  /** a colon and the start of a command, still being typed: nothing is filtered yet */
  partial: string | null;
}

/** Read what was typed into the box. */
export function parseFilter(input: string): FilterQuery {
  const raw = input.replace(/^\s+/, "");
  if (!raw.startsWith(":")) return { command: null, text: raw.trim().toLowerCase(), partial: null };
  const m = /^:([A-Za-z]*)(\s+([\s\S]*))?$/.exec(raw);
  if (!m) return { command: null, text: raw.trim().toLowerCase(), partial: null };
  const word = m[1].toLowerCase(), rest = (m[3] || "").trim();
  const cmd = FILTER_COMMANDS.find((c) => c.id === word);
  if (cmd) return { command: cmd.id, text: cmd.id === "variable" ? rest : rest.toLowerCase(), partial: null };
  // ":pa" is on its way to ":part": show everything until it is one
  if (m[2] === undefined && FILTER_COMMANDS.some((c) => c.id.startsWith(word))) return { command: null, text: "", partial: word };
  return { command: null, text: raw.trim().toLowerCase(), partial: null };
}

/** The commands a half-typed one could become. */
export const completions = (partial: string | null): typeof FILTER_COMMANDS => (partial === null ? [] : FILTER_COMMANDS.filter((c) => c.id.startsWith(partial)));

export interface FilterFeature {
  id: string; name: string;
  /** the registered type ("extrude") and its title ("Extrude") */
  type: string; typeTitle: string;
  status: "ok" | "warning" | "error" | "suppressed" | "rolled-back";
  suppressed: boolean;
  /** null: not something that is hidden or shown (a solid feature) */
  hidden: boolean | null;
  /** the variables its expressions name */
  variables: readonly string[];
  /** the folders it is in, outermost first */
  folders: readonly string[];
}
export interface FilterBody {
  id: string; name: string;
  /** "part", "surface", "curve", "mesh", "composite", "reference" */
  kind: string;
  hidden: boolean;
  /** the features that made or changed it */
  features: readonly string[];
}
export interface FilterFolder { id: string; name: string; parent: string | null }
export interface FilterInput { features: readonly FilterFeature[]; bodies: readonly FilterBody[]; folders: readonly FilterFolder[] }

export interface FilterResult {
  /** false: nothing is filtered, everything is shown */
  active: boolean;
  features: Set<string>;
  bodies: Set<string>;
  /** folders that match by themselves (the folders around a matching feature are shown too: the list sees to that) */
  folders: Set<string>;
}

const has = (hay: string, needle: string): boolean => !needle || hay.toLowerCase().includes(needle);

/** Which features, parts and folders the query shows. */
export function runFilter(q: FilterQuery, list: FilterInput): FilterResult {
  const out: FilterResult = { active: false, features: new Set(), bodies: new Set(), folders: new Set() };
  if (q.partial !== null || (!q.command && !q.text)) return out;
  out.active = true;
  const t = q.text;
  const feature = (test: (f: FilterFeature) => boolean) => { for (const f of list.features) if (test(f)) out.features.add(f.id); };
  const body = (test: (b: FilterBody) => boolean) => { for (const b of list.bodies) if (test(b)) out.bodies.add(b.id); };
  switch (q.command) {
    case null:
      feature((f) => has(f.name, t) || has(f.typeTitle, t) || has(f.type, t));
      body((b) => has(b.name, t) || has(b.kind, t));
      for (const d of list.folders) if (has(d.name, t)) out.folders.add(d.id);
      break;
    case "name":
      feature((f) => has(f.name, t)); body((b) => has(b.name, t));
      for (const d of list.folders) if (has(d.name, t)) out.folders.add(d.id);
      break;
    case "type":
      feature((f) => has(f.typeTitle, t) || has(f.type, t)); body((b) => has(b.kind, t));
      break;
    case "part": {
      body((b) => has(b.name, t));
      const made = new Set<string>();
      for (const b of list.bodies) if (out.bodies.has(b.id)) for (const id of b.features) made.add(id);
      feature((f) => made.has(f.id));
      break;
    }
    case "errors": feature((f) => f.status === "error" && has(f.name, t)); break;
    case "warnings": feature((f) => f.status === "warning" && has(f.name, t)); break;
    case "suppressed": feature((f) => f.suppressed && has(f.name, t)); break;
    case "hidden": feature((f) => f.hidden === true && has(f.name, t)); body((b) => b.hidden && has(b.name, t)); break;
    case "shown": feature((f) => f.hidden !== true && has(f.name, t)); body((b) => !b.hidden && has(b.name, t)); break;
    case "variable": feature((f) => (t ? f.variables.some((v) => v.includes(t)) : f.variables.length > 0)); break;
    case "folder": {
      const inside = new Set<string>();
      for (const d of list.folders) if (has(d.name, t)) { out.folders.add(d.id); inside.add(d.id); }
      feature((f) => f.folders.some((id) => inside.has(id)));
      break;
    }
  }
  return out;
}

/** The text of the box after a command was chosen from the drop-down: the command, then what was being looked for. */
export function withCommand(input: string, command: FilterCommand | null): string {
  const q = parseFilter(input);
  const rest = q.partial !== null ? "" : q.command === "variable" ? q.text : input.replace(/^\s*:[A-Za-z]*\s*/, "").trim();
  return command ? `:${command} ${rest}` : rest;
}
