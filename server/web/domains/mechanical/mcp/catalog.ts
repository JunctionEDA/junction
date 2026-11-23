// catalog.ts — the feature types as an AI assistant looks them up: a short list it can search by word and by
// family, and one type in full (every parameter with what it stores, and an edit that adds one) on request.
//
// A part studio has well over a hundred feature types; their schemas together are far more than a model should
// read to drill a hole.  So the catalogue is asked in steps: the families and the everyday types first, a search
// ("gear", "thread", "hinge") when something special is wanted, and the full schema of the one type about to be
// used.  Everything comes from the feature registry (core/feature.ts): a feature added under features/ is in
// the catalogue with no edit here.  Pure.
import type { Json, JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { FeatureDefinition, ParamField } from "../core/feature";

type Defs = readonly FeatureDefinition[];

/** One line on the everyday features that carry no hint of their own (the toolbar's are in ui/commands.ts). */
const ABOUT: { [type: string]: string } = {
  sketch: "Draw on a plane or a flat face: the profile most features start from.",
  extrude: "Pull a sketch region or a flat face straight out into a solid, add to a part, or cut with it.",
  revolve: "Turn a sketch region about an axis into a solid, or cut with it.",
  sweep: "Carry a sketch region along a path.",
  loft: "Blend between two or more sketch regions.",
  fillet: "Round edges (or every edge of a face).",
  chamfer: "Bevel edges.",
  draft: "Tilt faces so a moulded part comes out of its tool.",
  shell: "Hollow a part, leaving walls of one thickness; the faces given are opened.",
  hole: "Drill simple, counterbored or countersunk holes at the points of a sketch.",
  boolean: "Join parts, cut one from another, or keep what they share.",
  split: "Cut a part in two with a plane or a face.",
  "delete-body": "Remove a part from the model.",
  transform: "Move, turn or copy a part.",
  "linear-pattern": "Repeat parts or features along one or two directions.",
  "circular-pattern": "Repeat parts or features around an axis.",
  mirror: "Copy parts or features across a plane.",
  plane: "A reference plane: offset from a face, through points, at an angle, mid-way.",
  axis: "A reference axis.",
  point: "A reference point.",
  helix: "A helical curve to sweep along.",
  import: "The solids of a STEP file stored with the project (cad_import adds one).",
  "board-reference": "Show a circuit board of this project in the model, kept current.",
  "board-cutout": "An opening that follows a part of the board.",
  "board-standoffs": "Posts under the board's mounting holes.",
};

/** The families that are listed in full when nothing is asked for: what most parts are made of. */
const EVERYDAY = ["sketch", "solid", "modify", "combine", "pattern"];

export const familyOf = (d: FeatureDefinition): string => (d.toolbarSection === "library" && d.toolbarMenu ? d.toolbarMenu : d.toolbarSection || "solid");
export const aboutOf = (d: FeatureDefinition): string => ABOUT[d.type] || d.hint || "";

const row = (d: FeatureDefinition): JsonObject => ({ type: d.type, title: d.title, family: familyOf(d), about: aboutOf(d) });

const REF_NOTE = " A reference may also be written as a pick, resolved when the edit is applied: { kind, body: <body id, part name or the feature that made it>, pick: \"top\" | { ... } } (cad_reference topic \"references\")";

export function fieldDoc(f: ParamField): JsonObject {
  const out: JsonObject = { key: f.key, label: f.label, kind: f.kind };
  if (f.hint) out.hint = f.hint;
  switch (f.kind) {
    case "number": out.stores = "a number" + (f.unit === "deg" ? " (degrees)" : f.unit === "none" ? "" : " (millimetres)") + "; a string is an expression that may use variables (\"width / 2\")"; if (f.min !== undefined) out.min = f.min; if (f.max !== undefined) out.max = f.max; break;
    case "boolean": out.stores = "true or false"; break;
    case "text": out.stores = "a string"; break;
    case "enum": out.stores = "one of the options"; out.options = f.options.map((o) => o.value); break;
    case "profile":
      out.stores = "{ sketch: <id of an earlier sketch feature>, regions: null (all closed regions) or [region ids] }; the sketch's name, id or $ref alone is accepted too";
      if (f.faces) out.stores += ". Flat faces of bodies can be the profile too, alone or beside a sketch: { sketch: null, faces: [{ kind: \"face\", body, name }] } (names from cad_get_bodies); each face is used with its holes, along its own normal (out of the solid for new and add, into it for remove and intersect). A single face reference, or a list of them, is accepted too";
      break;
    case "plane": out.stores = "{ kind: \"plane\", plane: \"top\" | \"front\" | \"right\" } or { kind: \"face\", ref: { kind: \"face\", body, name } }; \"top\", \"front\" or \"right\" alone is accepted too, and so is a face reference or pick alone"; break;
    case "refs": {
      const forms = f.of.length ? [`{ kind: ${f.of.map((k) => `"${k}"`).join(" | ")}, body, name } (names from cad_get_bodies)`] : [];
      if (f.planes) forms.push(`{ kind: "plane", plane: "top" | "front" | "right" }`);
      if (f.datums && f.datums.length) forms.push(`{ kind: "datum", feature: <id of a ${f.datums.join(" / ")} feature> }`);
      if (f.sketch) forms.push(`{ kind: "sketch", feature: <sketch id>, entity: <curve or point id> }`);
      out.stores = (f.single ? "one of " : "a list of ") + forms.join(" or ") + (f.of.length ? "." + REF_NOTE : "");
      break;
    }
    case "features": out.stores = "a list of earlier features: ids, exact names or $refs" + (f.types && f.types.length ? ` (of type ${f.types.join(", ")})` : ""); break;
    case "bodies": out.stores = "a list of bodies: ids, part names, or the features that made them; empty means every body"; break;
    case "document": out.stores = `the id of a document of the project (${f.docTypes.join(", ")}), or its path`; break;
  }
  return out;
}

export const SKETCH_NOTE = "A sketch stores solved 2D geometry in its plane (x, y in millimetres; top is the XY plane, front is XZ, right is YZ): params.sketch.entities is a map of points { type: \"point\", x, y } and curves that name points by id: { type: \"line\", a, b }, { type: \"circle\", center, r }, { type: \"arc\", center, start, end } (counter-clockwise), { type: \"ellipse\", center, major, minor } (major: a point at the end of the major axis; minor: the other radius), { type: \"ellipticalArc\", center, major, minor, start, end }, { type: \"spline\", points: [ids], closed? } (through the points), { type: \"bspline\", poles: [ids], degree } (control points; degree = poles - 1 is a Bezier curve), { type: \"conic\", start, apex, end, rho }, { type: \"text\", a, b, text, bold?, italic? } (baseline start a; b above it by the height of a capital). Curves that share a point id are joined; a closed loop of lines and arcs, or a circle, is a region an extrude can use, and a loop inside another is a hole. In cad_edit_features give `shapes` instead of writing entities by hand: { type: \"rectangle\", x1, y1, x2, y2 }, { type: \"circle\", cx, cy, r }, { type: \"polygon\", points: [[x, y], ...] } (closed), { type: \"line\", x1, y1, x2, y2 }, { type: \"ellipse\", cx, cy, rx, ry, angle? }, { type: \"regular_polygon\", cx, cy, r, sides, circumscribed? }, { type: \"spline\", points: [[x, y], ...], closed? }, { type: \"bezier\", points: [[x, y], ...] }, { type: \"text\", x, y, height, text, bold?, italic? } (closed letters are regions).";

/** Edits that add one of the everyday types, as an assistant would write them. */
const EXAMPLES: { [type: string]: Json } = {
  sketch: [{ op: "add", type: "sketch", ref: "s", plane: "top", shapes: [{ type: "rectangle", x1: 0, y1: 0, x2: 40, y2: 20 }, { type: "circle", cx: 10, cy: 10, r: 3 }], define: true }],
  extrude: [
    { op: "add", type: "sketch", ref: "s", plane: "top", shapes: [{ type: "rectangle", x1: 0, y1: 0, x2: 40, y2: 20 }] },
    { op: "add", type: "extrude", ref: "block", params: { profile: "$s", depth: 10 } },
    { op: "add", type: "sketch", ref: "p", plane: { kind: "face", body: "$block", pick: "top" }, shapes: [{ type: "circle", cx: 20, cy: 10, r: 4 }] },
    { op: "add", type: "extrude", name: "Pocket", params: { profile: "$p", operation: "remove", depth: 5, flip: true } },
  ],
  revolve: [
    { op: "add", type: "sketch", ref: "s", plane: "front", shapes: [{ type: "polygon", points: [[0, 0], [10, 0], [10, 20], [0, 20]] }] },
    { op: "add", type: "revolve", params: { profile: "$s", axisType: "y" } },
  ],
  fillet: [{ op: "add", type: "fillet", params: { edges: [{ kind: "edge", body: "Extrude 1", pick: { of_face: "top", all: true } }], radius: 2 } }],
  chamfer: [{ op: "add", type: "chamfer", params: { edges: [{ kind: "edge", body: "Extrude 1", pick: { of_face: "bottom", all: true } }], distance: 1 } }],
  shell: [{ op: "add", type: "shell", params: { faces: [{ kind: "face", body: "Extrude 1", pick: "top" }], thickness: 2 } }],
  hole: [
    { op: "add", type: "sketch", ref: "h", plane: { kind: "face", body: "Extrude 1", pick: "top" }, shapes: [{ type: "point", x: 5, y: 5 }, { type: "point", x: 35, y: 5 }] },
    { op: "add", type: "hole", params: { points: "$h", holeType: "cbore", standard: "M3", endType: "through" } },
  ],
  mirror: [{ op: "add", type: "mirror", params: { of: "bodies", bodies: ["Extrude 1"], plane: { kind: "plane", plane: "right" }, merge: true } }],
  "linear-pattern": [{ op: "add", type: "linear-pattern", params: { of: "features", features: ["Pocket"], direction: { kind: "edge", body: "Extrude 1", pick: { parallel_to: "x" } }, spacing: 12, count: 3 } }],
  "circular-pattern": [{ op: "add", type: "circular-pattern", params: { of: "features", features: ["Pocket"], axis: { kind: "face", body: "Extrude 1", pick: { type: "cylinder" } }, count: 6, angle: 360 } }],
  boolean: [{ op: "add", type: "boolean", params: { operation: "subtract", targets: ["Extrude 1"], tools: ["Extrude 2"] } }],
  transform: [{ op: "add", type: "transform", params: { bodies: ["Extrude 1"], dz: 15, copy: true } }],
  plane: [{ op: "add", type: "plane", params: { method: "offset", ref: { kind: "plane", plane: "top" }, distance: 25 } }],
};

function exampleOf(d: FeatureDefinition): Json {
  if (EXAMPLES[d.type]) return EXAMPLES[d.type];
  // an edit that names what the feature must be given; everything else keeps its default
  const params: JsonObject = {};
  for (const f of d.schema) {
    if (f.kind === "profile") params[f.key] = "<a sketch's name, id or $ref>";
    else if (f.kind === "refs" && f.of.length) { const r = { kind: f.of[0], body: "<body>", pick: f.of[0] === "face" ? "top" : f.of[0] === "edge" ? { of_face: "top", all: !f.single } : { nearest: [0, 0, 0] } }; params[f.key] = f.single ? r : [r]; }
    else if (f.kind === "features") params[f.key] = ["<feature name>"];
  }
  return [{ op: "add", type: d.type, params }];
}

/** One type in full: what cad_feature_types answers with `type`. */
export function typeDoc(d: FeatureDefinition): JsonObject {
  const out: JsonObject = { type: d.type, title: d.title, family: familyOf(d), about: aboutOf(d), defaults: d.defaults(), parameters: d.schema.map(fieldDoc), example: exampleOf(d) };
  if (d.type === "sketch") out.note = SKETCH_NOTE;
  return out;
}

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** "gears" finds "gear": a word matches when either begins with the other (three letters or more). */
const alike = (a: string, b: string): boolean => a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)));

/** How many letters must be changed, added or taken away to turn one word into the other. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_v, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** The type names a mistyped or half-remembered one may have meant ("filet", "extrud", "gear"), nearest first. */
export function similarTypes(defs: Defs, word: string, limit = 6): string[] {
  const t = word.trim().toLowerCase();
  if (!t) return [];
  const scored: { type: string; score: number }[] = [];
  for (const d of defs) {
    const names = [d.type, d.title.toLowerCase(), ...words(d.type)];
    let score = Infinity;
    for (const n of names) {
      if (n === t) score = Math.min(score, 0);
      else if (n.includes(t) || t.includes(n)) score = Math.min(score, 1 + Math.abs(n.length - t.length) / 10);
      else { const dist = distance(n, t); if (dist <= Math.max(1, Math.floor(t.length / 3))) score = Math.min(score, 1 + dist); }
    }
    if (Number.isFinite(score)) scored.push({ type: d.type, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.type.length - b.type.length).slice(0, limit).map((x) => x.type);
}

export interface CatalogQuery { query?: string; family?: string; type?: string; detail?: string; limit?: number; offset?: number }

export const UNITS_NOTE = "Lengths are millimetres and angles degrees. Z is up.";
export const NAMES_NOTE = "A body's id is the id of the feature that made it. Faces, edges and vertices have stable names (cad_get_bodies with names: true lists them, cad_find_geometry finds them by description); a feature refers to them as { kind, body, name }, or by a pick that is turned into the name: { kind, body, pick }.";

/**
 * The catalogue.  Nothing asked: the families with what is in each, and the everyday types one line each.
 * `query` and/or `family`: the types that match, one line each.  `type`: that one in full, with an example.
 * `detail: "full"` with any of them gives every listed type in full (large: narrow it first).
 */
export function featureCatalog(defs: Defs, q: CatalogQuery = {}): { result?: Json; error?: string } {
  const families = new Map<string, FeatureDefinition[]>();
  for (const d of defs) { const f = familyOf(d); if (!families.has(f)) families.set(f, []); families.get(f)!.push(d); }
  const familyList = (): string => Array.from(families.keys()).join(", ");

  if (typeof q.type === "string" && q.type.trim()) {
    const t = q.type.trim().toLowerCase();
    const d = defs.find((x) => x.type === t) || defs.find((x) => x.title.toLowerCase() === t);
    if (!d) {
      const near = similarTypes(defs, t, 8);
      return { error: `There is no feature type "${q.type}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} Search with cad_feature_types { query }.` };
    }
    return { result: { feature_types: [typeDoc(d)], units: UNITS_NOTE, names: NAMES_NOTE } };
  }

  let list = defs.slice();
  let note = "";
  const filtered = !!(q.family && q.family.trim()) || !!(q.query && q.query.trim());
  if (q.family && q.family.trim()) {
    const f = q.family.trim().toLowerCase();
    const hit = Array.from(families.keys()).filter((k) => k.toLowerCase() === f || k.toLowerCase().includes(f));
    if (!hit.length) return { error: `There is no family "${q.family}". The families are: ${familyList()}.` };
    list = list.filter((d) => hit.includes(familyOf(d)));
  }
  if (q.query && q.query.trim()) {
    const want = words(q.query);
    const scored = list.map((d) => {
      const name = words(d.type + " " + d.title), rest = words(familyOf(d) + " " + aboutOf(d) + " " + (d.keywords || ""));
      let score = 0;
      for (const w of want) { if (name.some((n) => alike(n, w))) score += 3; else if (rest.some((n) => alike(n, w))) score += 1; else score -= 1; }
      return { d, score };
    }).filter((x) => x.score > 0);
    scored.sort((a, b) => b.score - a.score || a.d.title.localeCompare(b.d.title));
    list = scored.map((x) => x.d);
    if (!list.length) return { result: { feature_types: [], count: 0, note: `Nothing matches "${q.query}". Try one word (a noun: "gear", "thread", "hinge", "pattern"), or a family: ${familyList()}.` } };
  }
  if (!filtered && q.detail !== "full") {
    list = list.filter((d) => EVERYDAY.includes(familyOf(d)));
    note = "These are the everyday types. Every family is listed under families with its types; ask with family or query for the rest, and with type for one type's parameters and an example before using it.";
  }
  const total = list.length;
  const offset = Math.max(0, Math.round(Number(q.offset) || 0)), limit = Math.max(1, Math.min(200, Math.round(Number(q.limit) || (q.detail === "full" ? 200 : 60))));
  const page = list.slice(offset, offset + limit);
  const out: JsonObject = { feature_types: page.map(q.detail === "full" ? typeDoc : row), count: total };
  if (offset + page.length < total) out.next_offset = offset + page.length;
  if (!filtered) out.families = Array.from(families.entries()).map(([family, ds]) => ({ family, count: ds.length, types: ds.map((d) => d.type).join(" ") }));
  out.units = UNITS_NOTE;
  if (note) out.note = note; else if (q.detail !== "full") out.note = "Ask with type for one type's parameters and an example.";
  return { result: out };
}

/** The whole catalogue as text, one line per type under its family: the MCP resource. */
export function catalogText(defs: Defs): string {
  const families = new Map<string, FeatureDefinition[]>();
  for (const d of defs) { const f = familyOf(d); if (!families.has(f)) families.set(f, []); families.get(f)!.push(d); }
  let text = `# Feature types of a Junction part studio (${defs.length})\n\nOne line per type: its type name (what cad_edit_features takes), its title and what it does. cad_feature_types { type } gives one type's parameters and an example.\n`;
  for (const [family, ds] of families) {
    text += `\n## ${family}\n`;
    for (const d of ds) text += `- ${d.type}: ${d.title}${aboutOf(d) ? ". " + aboutOf(d) : ""}\n`;
  }
  return text;
}
