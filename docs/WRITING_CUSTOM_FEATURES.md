<!-- Written by server/scripts/gen-cad-script-assets.mjs from server/web/domains/mechanical/script/assets/prompts/guide.md. Edit that file. -->

# Writing custom features

A custom feature is a feature of a part studio that you write yourself: a short JavaScript file that declares a
title, an icon, a set of parameters and an `evaluate` function. It gets a toolbar entry under **Custom features ▸
This project**, a dialog generated from its parameters, and a row in the feature list like any other feature: it
can be edited, suppressed, reordered and rolled back, and it rebuilds when anything before it changes.

Scripts belong to the project. Everybody in the project sees the same library, every part studio of the project
can use every script, and a script travels with the project's history, archive and GitHub sync. A feature made
from a script carries its own copy of it, so a part keeps building the same when the library changes; the feature
list says when a newer version of its script exists and updates it with one click.

## A first feature

```js
feature({
  title: "Centre hole",
  description: "A round hole in the middle of a flat face.",
  icon: "hole",
  params: {
    face:     { type: "face",   label: "Face", hint: "A flat face. Left empty: the largest flat face." },
    diameter: { type: "length", label: "Diameter", default: 8, min: 0.5 },
    through:  { type: "boolean", label: "Through", default: true },
    depth:    { type: "length", label: "Depth", default: 3, min: 0.1, show: { through: false } },
  },

  evaluate(ctx, p) {
    const face = p.face || ctx.body().face({ kind: "plane" });
    if (!face || !face.plane) throw ctx.fail("Pick a flat face.");
    const middle = Geo2.bounds(face.outline().outer).centre;
    face.cut(Geo2.circle(middle, p.diameter / 2), p.through ? { through: true } : { depth: p.depth });
  },
});
```

`feature({...})` is called once, at the top of the file. `params` become the dialog, in order. `evaluate(ctx, p)`
builds the feature: `p` has one value per parameter, `ctx` is everything the feature may do.

## How to think about it

Most features are 2D work on a flat face followed by one cut or one boss.

1. **Find the face.** Take the one the person picked, or fall back to a sensible guess
   (`ctx.body().face({ kind: "plane" })` is the largest flat face).
2. **Read it as 2D.** `face.outline()` is the face in its own plane: an outer loop and its openings.
   `face.holes()` lists the round ones with their centres and diameters.
3. **Do the geometry with `Geo2`.** Offsets for margins, booleans to combine, `cells` for patterns, `delaunay`
   for trusses, `round` for the corners a cutter leaves. Everything returns regions you can pass on.
4. **Build once.** `face.cut(shape, { depth })`, `face.cut(shape, { through: true })` or
   `face.add(shape, { height })` take any number of regions in one operation. One cut with two hundred pockets
   is far faster and far more robust than two hundred cuts.
5. **Say what happened.** `ctx.report("Mass saved", "31 %")` shows with the feature; `throw ctx.fail("…")`
   fails it with a sentence the person can act on; `ctx.warn("…")` leaves a note.

Coordinates: a face's 2D points are in its own plane (`face.plane`: origin, x, y, and a normal that points out
of the part). `face.toLocal(point3d)` and `face.toWorld(point2d)` go between the two. Lengths are millimetres,
angles degrees.

Arcs: a loop's point may carry a third number, the bulge of the edge that follows it. You rarely write one.
`Geo2.circle`, `Geo2.slot` and `face.outline()` make arcs, and when a solid is built the polygons that offsets,
booleans and `round` return are read back into true arcs, so a rounded pocket has cylindrical walls, not facets.

## Parameters

| `type` | `evaluate` gets | Notes |
|---|---|---|
| `length`, `angle`, `number` | a number | `default` is required; `min`, `max`, `step` optional. Lengths are mm; people may type units and expressions. |
| `integer` | a whole number | |
| `boolean` | `true` / `false` | |
| `enum` | the option's key | `options: { truss: "Truss", hex: "Hex" }` |
| `text` | a string | |
| `face`, `edge` | a `Face` / `Edge`, or `null` | nothing is picked in a new feature: handle `null` |
| `faces`, `edges`, `bodies` | a list, perhaps empty | |
| `body` | a `Body` or `null` | |
| `sketch` | `{ plane, regions }` or `null` | a sketch made earlier, with the regions the person chose |

`show: { through: false }` shows a field only while another parameter has that value (a list of values also
works: `show: { pattern: ["isogrid", "hex"] }`).

Values outside `min`…`max` never reach `evaluate`: the feature fails with a sentence naming the field.

## Results the next feature can use

Faces keep stable names through every operation, as they do for the built-in features: a face a cut leaves alone
keeps its name, and the faces a cut makes are named after this feature (`…:floor`, `…:wall`, numbered in a fixed
order). `face.label("seat")` gives a face a name of your own, `<feature id>:seat`, for a later feature or a mate
to refer to.

## Rules of the sandbox

The script runs in an interpreter of its own inside the modelling worker. It has the JavaScript language and the
Feature API, and nothing else: no network, no DOM, no files, no timers, no `Date`. `Math.random()` gives the same
numbers on every run, because a feature must rebuild the same part every time. `evaluate` must not be `async`.

It is bounded: about half a minute of work, 64 MB of memory, 50 000 calls into the API. A script that runs out
is stopped and the feature fails with "took too long"; the model stays as it was. Do the heavy 2D work in a few
large `Geo2` calls (they run at full speed outside the interpreter) rather than point by point in loops.

Every result is checked: a feature whose part is not a sound solid (faces crossing, a skin left open) fails.
Shapes that touch at a point or overlap by a hair are the usual cause. Leave real clearance (an offset, a
margin) between things that should not meet, and drop slivers before cutting
(`Geo2.offset(Geo2.offset(s, -w, "miter"), w, "miter")` removes everything narrower than `2 w`).

## Patterns worth knowing

- **Margins.** `Geo2.offset(outline.outer, -margin)` is the area that stays clear of the edge;
  `Geo2.offset(outline.holes, boss)` is the material to keep round every opening. Their difference is where you
  may cut.
- **Cell patterns.** `Geo2.cells("tri" | "hex" | "square" | "diamond", area, { pitch, inset })` gives the cells
  of an isogrid, a honeycomb or a grid, already shrunk by `inset` so that walls of `2 × inset` stay between
  them; `Geo2.intersection(cells, area)` cuts them to where they may go.
- **Trusses.** `Geo2.delaunay(points)` triangulates points (hole centres, corners of the outline from
  `Geo2.outlinePoints`); `Geo2.thicken(edges, width)` turns its edges into ribs; the pockets are the area less
  the ribs.
- **Cutter corners.** `Geo2.round(pockets, radius)` rounds every outside corner the way a cutter of that radius
  would, and removes what is too narrow to cut at all.
- **Staying in one piece.** A through cut can free an island. `Geo2.difference(outline, pockets).length` is how
  many pieces the face would be left in: check that it is 1, or fail with a sentence.
- **Guessing well.** A feature that does something sensible with nothing picked (the largest flat face, the two
  nearest holes) is easier to use and easier to try.

## Writing them with the assistant

In the editor, the box under the code takes a description ("pocket the plate between the holes, leave 4 mm
ribs…") or a change to make. The assistant has this page, the API's types and the examples, is told what the
current part looks like, and can run the script on the current part: it gets back errors with their line,
warnings, the volume before and after, whether the result is a sound solid, and a picture. It works until the
result is right and then shows what it would change next to a preview. Nothing is saved until you accept.

The same loop is open to outside agents through the MCP endpoint: `cad_script_guide`, `cad_script_list`,
`cad_script_read`, `cad_script_validate`, `cad_script_run`, `cad_script_write`.

## The examples that ship

The library dialog's **Add an example** puts any of these into the project, to use or to start from:

- **Lighten plate**: pockets a plate between its outline and holes, leaving ribs: a truss from a triangulation
  of the holes, isogrid triangles or hexagons; rounded corners, through or to a depth; reports the mass saved.
- **Hole-to-hole slot**: joins two holes with a slot, or ties them together with a raised bridge.
- **Angle bracket**: an L bracket from nothing, with bolt holes and an optional gusset.
- **Vent pattern**: perforates a region of a face with holes, slots or hexagons.
- **Engrave text**: a part number cut into a face, or raised from it.

## The API

The complete, authoritative list is the type file `feature-api.d.ts`: the editor's completion (Ctrl+Space) and
hover read from it, and so does the assistant.
