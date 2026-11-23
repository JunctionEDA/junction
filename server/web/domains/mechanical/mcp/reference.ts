// reference.ts — what an AI assistant reads before it models: a short guide to working in Junction, and one page
// per subject it can ask for when it needs it (sketches, references and picks, variables and materials).  The
// cad_reference tool and the MCP resources (junction://cad/guide, …) both answer from here, so there is one text.
//
// Another domain adds its own pages with `addReference` (the assembly domain's are mates and assemblies).
import { CONSTRAINT_TYPES, EXTRA_SHAPES } from "./sketch";
import { PICK_HELP } from "./select";
import { STARTER_MATERIALS } from "../document/mass-materials";

const GUIDE = `# Modelling in Junction over MCP

Junction holds mechanical designs beside electronics. A **part studio** (a .jpart document) is a list of features
built in order by a modelling kernel into solid bodies: sketch, extrude, fillet, hole, and about 170 more. An
**assembly** (a .jasm document) places bodies of part studios as instances and ties them with mates.
Lengths are millimetres, angles degrees, Z is up. The tools run on the server: nothing has to be open in a
browser, and people who do have the document open see every change as it is made.

## The loop
1. list_projects, get_project: find the project and its documents. cad_create_part_studio / cad_create_assembly add one.
2. cad_describe: a few lines on what is there (cheap). cad_get_features for the tree; { feature } for one in full.
3. cad_feature_types: the everyday types; { query } to search ("gear", "thread"); { type } for one type's
   parameters and an example. Read a type's parameters before the first time you use it.
4. cad_edit_features: several edits in one call, applied together. dry_run: true rebuilds without changing
   anything; atomic: true refuses the whole call if a feature would newly fail. Each call returns a change_id
   that undo_changes takes.
5. Check: every edit returns each feature's status and the bodies. cad_measure for distances and angles,
   cad_check for interference, clearance, thin walls and validity, cad_render_view to look (views: [...] puts
   several in one picture; highlight shows where a face is; section cuts it open).
6. cad_export for STEP, STL, 3MF, DXF; cad_import brings a STEP file in.

## A part in one call
\`\`\`json
{ "edits": [
  { "op": "add", "type": "sketch", "ref": "s", "plane": "top", "shapes": [{ "type": "rectangle", "x1": 0, "y1": 0, "x2": 60, "y2": 40 }] },
  { "op": "add", "type": "extrude", "ref": "box", "params": { "profile": "$s", "depth": 20 } },
  { "op": "add", "type": "shell", "params": { "faces": [{ "kind": "face", "body": "$box", "pick": "top" }], "thickness": 2 } },
  { "op": "add", "type": "fillet", "params": { "edges": [{ "kind": "edge", "body": "$box", "pick": { "parallel_to": "z", "all": true } }], "radius": 3 } }
] }
\`\`\`
"ref" names a new feature inside the call; "$ref" uses it. A pick ("the top face", "every vertical edge") is
resolved against the model as it stands at that edit and stored as a stable name.

## Rules that save time
- A feature can only use what is above it in the tree. New features go at the rollback bar (the end, usually).
- A sketch is 2D in its plane: top is XY, front is XZ (x right, y up = model Z), right is YZ. On a face, x and y
  are the face's own; draw, then render to see which way they run.
- An extrude goes along the sketch plane's normal (top: +Z); flip: true turns it. operation is new (a new part),
  add, remove or intersect.
- Holes, slots and pockets: sketch on the face, extrude with operation "remove" and flip: true (into the solid),
  or use the hole feature with sketch points.
- When a feature fails, its message says why and the result adds a hint. Fix the feature (op "set"); do not
  pile new features on a broken tree.
- One part studio may hold several bodies; give each a name and a material with { op: "set_part" }. Mass needs a material.
- For an assembly: one part per body, the first instance fixed, then one mate per joint (cad_reference topic "mates").
- Ask for little: cad_describe before cad_get_features, compact: true and fields where offered, one feature at a time.
`;

const SKETCH = `# Sketches

In cad_edit_features a sketch is added or changed with these keys beside op/type:

- plane: "top" | "front" | "right", a face ({ kind: "face", body, name } or a pick: { kind: "face", body, pick: "top" }),
  or the name of a plane feature.
- shapes: the geometry, replacing what the sketch held. Coordinates are millimetres in the plane.
  { type: "rectangle", x1, y1, x2, y2 }, { type: "circle", cx, cy, r }, { type: "polygon", points: [[x, y], ...] } (closed),
  { type: "line", x1, y1, x2, y2 }, { type: "ellipse", cx, cy, rx, ry, angle? },
  { type: "regular_polygon", cx, cy, r, sides, circumscribed? }, { type: "spline", points, closed? },
  { type: "bezier", points }, { type: "text", x, y, height, text, bold?, italic? },
  ${EXTRA_SHAPES}.
  Any shape takes construction: true (drawn, encloses nothing).
- define: true adds the constraints and dimensions that hold the shapes as drawn (sides square to the axes, sizes
  and positions as dimensions, the rest pinned), so the sketch is fully defined for a person who opens it.
- constraints: [{ type, refs, value?, axis? }] by hand. Types: ${CONSTRAINT_TYPES.join(", ")}.
  refs are entity ids, or { entity, at: "start" | "end" | "center" } for a point of a curve; "$origin" is the
  sketch origin. A distance takes one line (its length), two points (axis: "x" | "y" for the horizontal or vertical
  distance), or a point and a line; radius and diameter take a circle or an arc; angle takes two lines (degrees).
  value may be an expression with variables ("width / 2"). The sketch is solved; if the constraints cannot all
  hold nothing is changed and the conflicting ones are named.
- entities: { id: entity | null } changes single points and curves (op "set").

Entity ids are short and in sequence per kind (p1, p2 … points, l1 … lines, c1 … circles, a1 … arcs), in the order
the shapes are given; the result of the edit lists each shape's ids under sketches.<name>.shapes. A rectangle is
p1..p4 (corners, from x1,y1 counter-clockwise when x2 > x1 and y2 > y1) and l1..l4 (l1 is the first side, p1 to p2).

A closed loop of lines and arcs that share end points, or a circle, is a region. A loop inside another is a hole,
so a rectangle with a circle in it extrudes to a plate with a hole. The result says how many regions a sketch
has: 0 means an extrude of it will fail. The faces an extrude makes are named after the sketch curves, so
redrawing a sketch (shapes) renames them; changing sizes with entities or dimensions keeps the names.
`;

const REFERENCES = `# References: naming faces, edges and vertices

A feature refers to geometry as { kind: "face" | "edge" | "vertex", body, name }. Names are stable across rebuilds
(they come from the feature and the sketch curve that made the face) and are opaque: do not parse or guess them.
Two ways to get one:

1. cad_find_geometry { kind, body?, pick? } lists matches with what each is (flat face and its normal, hole and
   its diameter, edge length, where it is) and the ref to use.
2. Write a pick in place of the name, anywhere a reference goes: { kind, body, pick }. It is resolved when the
   edit is applied, against the model as built up to that edit, and the name it finds is what is stored.

body is a body's id, its part name, the name of the feature that made it, or "$ref" of an add in the same call
(a body's id is the id of the feature that made it). It may be left out when there is one body.

${PICK_HELP}.

Examples: the top face { kind: "face", body: "$box", pick: "top" }; every edge round it
{ kind: "edge", body: "$box", pick: { of_face: "top", all: true } }; the four vertical edges
{ kind: "edge", body: "$box", pick: { parallel_to: "z", type: "line", all: true } }; the 5 mm hole nearest a point
{ kind: "face", body: "$box", pick: { hole: true, diameter: 5, nearest: [10, 10, 0] } }.
In an assembly a mate's connector is picked the same way on an instance, in assembly space as placed.

A reference is lost ("no longer exists") when the face it named is removed or its sketch curve redrawn; the
feature then reports an error. Set the reference again with a pick.
`;

const VARIABLES = `# Variables, expressions, parts and materials

- { op: "set_variable", name: "wall", value: 2 } adds or changes a variable (value: a number, or an expression
  such as "40 mm + 2 * wall"; rename: "newName" renames it everywhere). { op: "delete_variable", name }.
- Any number parameter may be given as a string: an expression kept with the feature and evaluated again whenever
  a variable changes ("width / 2", "#wall * 3"). Units mm cm m in ft deg rad; + - * / ^ ( ); pi; sin cos tan asin
  acos atan atan2 (degrees) sqrt abs min max floor ceil round.
- cad_get_features lists the variables with their values.
- { op: "set_part", body, name?, material?, color?, description? } names a body as a part, says what it is made
  of and colours it. body is a body id, part name or the feature that made it. color is "#rrggbb".
  Materials (density g/cm3): ${Object.keys(STARTER_MATERIALS).map((k) => `${k} ${STARTER_MATERIALS[k].density}`).join(", ")}.
  With a material cad_get_bodies and cad_describe give the mass.
`;

const PAGES = new Map<string, { title: string; text: () => string }>([
  ["guide", { title: "How to model in Junction", text: () => GUIDE }],
  ["sketch", { title: "Sketch shapes, entities and constraints", text: () => SKETCH }],
  ["references", { title: "Naming and picking faces, edges and vertices", text: () => REFERENCES }],
  ["variables", { title: "Variables, expressions, parts and materials", text: () => VARIABLES }],
]);

/** Add a page (another domain's subject).  The same topic again replaces it. */
export function addReference(topic: string, title: string, text: () => string): void { PAGES.set(topic, { title, text }); }

export const referenceTopics = (): { topic: string; title: string }[] => Array.from(PAGES.entries()).map(([topic, p]) => ({ topic, title: p.title }));

/** A page's text, or null for a topic nobody wrote. */
export function reference(topic: string): string | null {
  const p = PAGES.get(topic.trim().toLowerCase());
  return p ? p.text() : null;
}
