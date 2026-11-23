# Assemblies

Status: **in progress, usable**. An assembly (`.jasm`) places parts of the project's part studios, and other
assemblies, as instances; mates tie them together; a solver keeps the mates while parts are dragged and while
the part studios change. A board of the project is placed like a part and follows the board editor.

**Read [../mechanical/CONTRACT.md](../mechanical/CONTRACT.md)** first: the item document format, how a change
is committed and synced, geometry names. This file covers what the assembly adds.

## Layout

```
document/format.ts     the .jasm format: instances, mates                                   (shared)
document/edits.ts      every edit as item changes; folders, explicit connectors, named positions
document/extras.ts     relations, rigid groups, instance patterns, saved exploded views, the order of the list
core/mate.ts           the mate contract        core/tool.ts   the toolbar contract         (shared)
core/transform.ts      3 × 4 placement matrices                                             (shared)
mates/                 ONE FILE PER MATE TYPE   (_residuals.ts: what they are made of)
tools/                 ONE FILE PER TOOLBAR TOOL
solver/                math.ts (poses), frames.ts (connector frames), linear.ts, solver.ts, types.ts
connectors/infer.ts    implicit mate connectors from a part's tessellation
model/problem.ts       document + geometry → the solver's input → what to tell a person about each mate
model/relations.ts     ONE ENTRY PER RELATION (gear, rack and pinion, screw, linear)
model/replicate.ts     Replicate: the holes of a part that are like the one a mate is in
sources/               where an instance's geometry comes from: part.ts, subassembly.ts, board.ts,
                       manager.ts (the open source documents), kernels.ts (worker pool), cache.ts (IndexedDB)
services/, panels/     interference and the bill of materials: the logic (pure), and their panels
suppliers/             models from suppliers: model.ts (a search row, what an instance keeps of it), api.ts (the
                       server's search, server/src/models3d), place.ts (fetch, keep in the project, add an instance)
viewport/scene.ts      instances drawn from shared geometry, picking, connector glyphs     triad.ts  the manipulator
viewport/boards.ts     board instances as they look (the mechanical domain's BoardDisplay)
ui/assembly.ts         AssemblyEditor: the object every tool and panel is handed
ui/commands.ts         every tool, mate and relation as one list: the toolbar's sections, the tool search, the keys
ui/Toolbar.tsx         the one-row toolbar, drawn as the part studio's is       ui/keys.ts   a person's own keys
ui/Overlays.tsx        the tool search, the right-click menu and its marking ring, the sheets of keys
ui/Bars.tsx            the exploded view's and the section's strips, the rail of panel buttons at the right edge
ui/forms.ts            the forms tools ask: a relation, a pattern
ui/*.tsx               the frame, the instance tree, the mate features, the mate and Insert dialogs; the view cube is
                       the part studio's (ViewCubeControl from mechanical/api-ui.ts)
panels/                bill of materials, mass properties, measure, animate
generated/             written by scripts/gen-cad-registry.mjs; not committed
```

Tests: `static/tests/assembly-solver.test.js` (the solver and every mate, in node),
`assembly-relations.test.js` (relations, Width, Planar's limits, patterns, exploded views, the list's order, what a
delete takes with it, mass and measure, Replicate), `scripts/cad-assembly-chrome-ui.mjs` (the toolbar, the tool search,
the tree and every new tool, driven in Chromium as a person would),
`assembly-model.test.js` (connectors from the real kernel, edits, an assembly following a rebuilt part),
`assembly-doc.test.js` (the format), `cad-analysis.test.js` (interference and the bill of materials),
`scripts/cad-suppliers-ui.mjs` (the Suppliers tab and the server's providers, against stand-ins),
`models3d.test.js` (the standard parts, built by the kernel), `scripts/cad-assembly-ui.mjs` (the real app in Chromium, two people), `scripts/cad-analysis-ui.mjs` (the
panels) and `scripts/cad-e2e.mjs` (a board fastened in a tray, a hinged lid, a clash found).

## The chrome

Laid out as the part studio is, from the same pieces (`mechanical/api-ui.ts`): one row of icon buttons in sections
(undo redo │ Insert │ the ten mates │ Mate connector, Group, Fix │ Relations ▾ │ Pattern ▾ │ Exploded view, Named
position, Animate │ Bill of materials, Interference, Section view, Measure, Mass properties │ History │ More ▾), each
with a tooltip of its name, key and one line; buttons that do not fit go under More; **Search tools…** at the right
end (S at the pointer, Ctrl+K, Alt+C) finds every tool, mate and relation by name or by another word for it ("joint",
"hinge", "ground", "BOM", "clash"). A tool file says where it goes: `section`, `order`, `keep`, `menu`, `keywords`,
`key` (`core/tool.ts`); a mate has `hint` and `keywords`. A right click in the model opens the menu for the instance
under the pointer with the marking ring of eight tools above it; **?** lists the keys and **Change keys…** rebinds
them (the part studio's `KeymapSheet`; the assembly's keys are its own, `junction.asm.keymap`). Left: **Instances (n)**
with a filter, the assembly, folders, patterns and sub-assemblies that open, and each instance's state (fixed, held,
"n free", in red with the reason when its source failed or a mate on it cannot hold); rows drag to another place or
into a folder; **Mate features (n)** below: mates, relations, groups, patterns, connectors; then named positions and
exploded views. Right edge: a rail of buttons for the panels.

## What a person can do

- **Relations** (Relations ▾): Gear, Rack and pinion, Screw, Linear, between the values of two mates (Screw also on
  one Cylindrical mate). The solver holds them; they count in the freedoms; one that cannot hold is the conflict.
- **Width** mate (two faces on each part: the tab is centred between the walls). **Planar** has limits on its three
  values. Every mate that has a place for one has an **Offset** (X, Y, Z, a turn); **Pick** in the mate dialog
  chooses whether clicks take faces, edges, points.
- **Group**: the selected instances keep their places and move as one. **Fix** as before.
- **Linear and circular instance patterns** whose copies follow their seeds (along X, Y, Z or a clicked edge, face
  or hole); **Replicate** (a part mated in a hole goes in every hole like it, each copy with its mate).
- **Exploded views** kept under names (an even spread, and the manipulator pulls one part further); **Animate** (a
  slider and Play for any mate's value); **Section view** (a cut across X, Y or Z, uncapped); **Measure** (between
  two connectors: distance, deltas, angle, between planes or axes; one round thing: its diameter); **Mass
  properties** (parts only: mass, volume, centre). A **double click** on a part opens its part studio.

- **Insert** parts of any part studio of the project (one, several, the whole studio), other assemblies, and
  the project's boards.  A part studio is read and built without opening its tab, with its variables applied
  and the boards of its Board features supplied (mechanical `studioInputs`), so a studio that shows a board
  offers the board's bodies too.
- **Insert from suppliers** (the Insert dialog's Suppliers tab, `ui/SupplierSearch.tsx`): type a supplier's
  part number or a standard size ("M5x20 socket head", "608 bearing", an LCSC number, a McMaster-Carr number),
  and click a result. The model becomes a part studio of the project (a STEP file in `models/` imported as one
  body, or a part studio the server drew from a standard's dimensions) and an instance of it, which carries
  `supplier: { provider, id, name, partNumber, title, description?, url?, generated? }`. The
  instance list links to the supplier's page and the bill of materials names the part by supplier and part
  number. The server's README lists the providers and the settings each needs.
  A **McMaster-Carr number** only ever places McMaster's own model. On a server without McMaster's API its row
  cannot be clicked: it links to McMaster's page and takes the STEP file the person downloads there ("3-D STEP"),
  dropped on the row or the tab or chosen with "Choose file…". The file is checked to be a STEP file, kept in
  `models/` and placed as that part (`suppliers/place.ts`, `placeModel(…, file)`); the next search for the number
  in that project offers it as "In this project". Nothing is drawn in such a part's place.
- **Instance tree**: rename, hide, suppress, fix, group, copy in a row, replace, delete; each row says how many
  freedoms its mates leave it.
- **Drag** an instance in the viewport, or use the manipulator on the selected one (arrows slide, arcs turn, in
  round steps; Alt for free). Every step goes through the solver, so mates hold and limits stop the motion.
- **Mates**: Fastened, Revolute, Slider, Planar, Cylindrical, Pin slot, Ball, Parallel, Tangent. Pick a mate,
  then click a connector on each of two instances: connectors are inferred under the pointer (face centres,
  hole and shaft axes, circle centres, edge midpoints, corners). Offset, rotation, flip, a quarter turn, limits.
  A mate's value can be typed or animated in its dialog. Nothing is stored until Done.
- **Explicit mate connectors** (Connector tool): a connector kept on a part with its own offset, turn and flip.
- **Named positions**, an **exploded view** (a way of looking: not stored), undo and redo.
- **Interference** (exact overlap volumes between parts and boards, drawn on the model, the clashing instances
  marked; clearance between two) and the **bill of materials** (parts with quantities, and under each board
  its electronic parts; CSV), as docked panels.
- Two people can edit one assembly at once; an assembly open in one window follows a part studio or a board
  edited in another, live.

## For an AI assistant (`mcp/`)

The assembly's tools on the MCP endpoint are `cad_create_assembly`, `cad_get_assembly`, `cad_edit_assembly`,
`cad_search_models` and `cad_get_bom` (`mcp/tools.json`, `mcp/host.ts`); the mechanical domain's looking,
measuring, checking and exporting tools take an assembly too, through the scene `mcp/host.ts` registers (the
instances where the mates put them). They run headless in the server's tool host: `mcp/model.ts` plans a list of
edits into item changes with `document/edits.ts`, solves after each with `model/problem.ts` and the solver, and
writes the solved placements and mate values, as the editor's gestures do. Connectors are picked by description
on the instance where it stands (`{ instance, face: "top" }`, `{ instance, face: { hole: true, diameter: 3 } }`)
and stored as the names the editor stores. The mate types come from `generated/mates.ts` (the same files as the
page's list, without the toolbar's). See "The MCP tools" in the mechanical CONTRACT.md for the rules, and
`scripts/cad-mcp-e2e.mjs` for a mechanism built with them. Not there yet: explicit connectors, named positions
and groups as edits; board and model-file instances are listed but not built.

## For tools and panels (interference, bill of materials, …)

A tool is a file under `tools/` (`defineAssemblyTool`, `core/tool.ts`); its `run(assembly)` gets the
`AssemblyEditor`. There is no panel registry: a tool opens a panel with `assembly.showPanel(...)`.
`tools/interference.ts` and `tools/bom.ts` are the examples: `services/interference-sources.ts` is all they
need of the editor (no session, no worker of their own).

```ts
assembly.placed(): PlacedInstance[]
  // every instance that is not suppressed, as it stands on screen (solved; not exploded):
  //   item       the InstanceItem (id, name, source, fixed, hidden, group)
  //   transform  12 numbers, rows of a 3 × 4 matrix: the instance in assembly space
  //   status     "ready" | "loading" | "error"   (wait for "ready": subscribe and look again)
  //   pieces     [{ id, name, mesh: BodyMesh, transform }]   transform: the PIECE in assembly space
  // A part instance has one piece (the body); a sub-assembly instance has one per part inside it.
  // `mesh` is the mechanical domain's BodyMesh (positions, normals, indices, named faces/edges/vertices,
  // bbox in the mesh's own space).  The same mesh object is shared by every instance of the same part:
  // key work on it (a BVH, a volume) by the object, e.g. in a WeakMap.

assembly.getState()                 // instances, mates, groups, selection, instanceInfo[id].dof, mateInfo[id], dof, …
assembly.subscribe(fn)              // called after every change of state (document, sources, selection)
assembly.transformOf(instanceId)    // one solved placement

assembly.sources.handle(kind, docId)   // the open source document of an instance (kind = item.source.kind):
  .snapshot()                          //   { status, pieces, version }
  .kernel?.()                          //   the KernelClient whose worker holds that source's B-rep, or null
  .ensureKernel?.()                    //   the same, built first when no worker holds it: what an analysis tool awaits
  .doc?.()                             //   a part studio's ItemDoc (its materials, its names)
  .features?.()                        //   { features, rollback }: the source as worker input
  .board?.()                           //   a board source: its reader, and its changes as they arrive
// B-rep.  Each part studio has its own worker (one model per worker), so `kernel().call("mass-properties",
// { body: piece.id })` answers about ONE studio's bodies (piece.id is the body id for a part instance).
// A worker exists only while that studio was built in this session: after a reload the meshes come from the
// cache and kernel() is null until the studio changes; `await ensureKernel()` builds it in the pool when you
// need the B-rep.  A question that needs bodies of two sources in one kernel (exact interference) reads each
// source's bodies as BRep text ("body-brep") and sends them to one of those workers; mesh-level work needs none
// of this.

assembly.scene.setMarked(instanceIds)  // tint instances as a problem (clear with [])
assembly.select(ids)                   // select instances, mates, …
assembly.showPanel({ id, title, side: "right" | "left" | "bottom", render: (assembly) => <ReactNode> })   // "bottom": under the viewport, for a table
assembly.closePanel(id)
assembly.ask({ title, fields: [{ key, label, kind: "number" | "text", value, unit? }], accept(values) })
assembly.commit(changes)               // item changes (document/edits.ts builds them); undoable, shared
assembly.host                          // DocumentHostContext: project, docs, toast(), openDoc()
```

In a panel, read state with `useAssembly(assembly, (s) => s.instances)` (`ui/parts.tsx`).
`window.JunctionAssembly` is the open editor, for tests and the console.

## The document (more)

`document/extras.ts` adds, all optional and kept by a reader that does not know them: `relation` items
(`relationType`, `a` / `b`: `{ mate, key }`, `params`), `rigid` items (`instances`, `places` relative to the first),
`pattern` items (`patternType`, `seeds`, `count`, `spacing` or `angle`, `frames`: the direction or axis in each
seed's own space) whose copies are ordinary instances carrying `pattern`, `seed`, `index`, and `explode` items
(`offsets` by instance). A mate end may carry `ref2` (Width). `buildProblem(…, extras)` takes them: pattern copies
and rigid groups become welds the solver makes for itself (never mates a person sees), relations become
`SolverRelation`s. A relation ties the CHANGE of two values from where the bodies stand when a solve begins, so
angles may go round any number of times; a value typed far away is reached in steps (`solveProblem`).

## The document

`document/format.ts` has the instance and mate items. `document/edits.ts` adds, all optional and all ignored by
a reader that does not know them:

- `group` items and an instance's `group` key (a folder in the list);
- `connector` items (an explicit mate connector owned by an instance: `ref`, `flip`, `offset`, `rotation`) and a
  mate end's `connector` key naming one;
- `position` items (`transforms` by instance id).

A mate's `params` may carry, whatever its type: `offset` (mm along the connector's axis; also `offsetX/Y/Z`),
`rotation` (degrees about it), `reorient` (quarter turns of the second connector), `limits` with
`<value>Min` / `<value>Max` (`angle`, `distance`). `solver/frames.ts` applies them; a mate file does not.

**The document stores solved placements.** After a drag, a mate or a change of a part upstream, an editor
writes the instances' new transforms (the last case without an undo step). A viewer's window solves for itself
and shows the same thing.

## Mates and the solver

A mate file gives `solve: { residuals(a, b, params, reach, out), values?, rigid?, check? }`
(`solver/types.ts`). `mates/revolute.ts` is the example: eight lines of residuals from `_residuals.ts`.
The solver (`solver/solver.ts`, the header says how): welds Fastened parts into rigid groups, splits what is
left into independent components, and solves each by Levenberg–Marquardt on a skyline matrix ordered along
the mates. It reports each mate's residual and values, the freedoms each instance has left (the null space),
and, when the mates cannot all hold, which ones conflict (the later ones: they are added in order).

Measured in node on a loaded machine (`assembly-solver.test.js` prints them): a drag step of 100 separately
hinged lids about 2 ms; of one chain of 300 hinges about 40 ms; a full solve with freedoms of 100 hinges 6 ms.
The solver runs on the page's thread; it has not needed a worker.

## Sources

`source: { kind, docId, … }` on an instance; a kind is a `SourceProvider` (`sources/types.ts`) listed in
`sources/manager.ts`. A provider opens a source document and offers **pieces**: a mesh with stable names, an id
(what a mate's `ref.body` names) and a place.

- `part`: a body of a part studio. The handle joins the studio's session, so every edit arrives; it builds in
  a pooled worker (`kernels.ts`, three kept), or not at all when the cache has this content (`cache.ts`).
- `assembly`: another assembly, rigid. Its own stored placements are used; piece ids are
  `<its instance id>/<piece id>`. An assembly that contains itself is refused.
- `board`: a board of the project. The handle reads the board live (the mechanical domain's `BoardFeed`) and
  builds it in a pooled worker by the same code as a Board feature in a part studio: pieces `board:board` (the
  laminate) and `board:parts` (the parts' envelopes), with the names of
  [`../mechanical/board/README.md`](../mechanical/board/README.md) and `board` as the feature id:
  `board:front`, `board:back`, `board:edge:<uuid>`, `board:hole:H1`, `board:part:J1:top`. They do not change
  when the board is edited. The pieces are **ghosts** (`SourcePiece.ghost`): `viewport/boards.ts` draws the board
  as it looks at the instance's placement, a moved footprint at a time, and the solids are there for the
  pointer, the connectors and the interference check. The geometry is in the sheet's own coordinates (x right,
  y up, z from the back face), so Insert places a new board with its middle at the assembly's origin.
- A part studio that holds a Board feature is built with its board, so "Board 1" and "Board 1 parts" are
  offered among its parts, already where the studio puts them.

## Limits

- **STEP files** (`kind: "file"`) have no provider (import the file into a part studio and instance that).
- **Supplier models** show an outline (drawn parts) or the supplier's photo before they are placed, not a 3D
  preview: the model is fetched on the click. A drawn part has no thread. Without McMaster's API a McMaster-Carr
  model is not fetched: the person downloads the STEP file from McMaster's page and drops it on the row. A
  supplier's STEP file comes in as one body, in the supplier's own frame.
- **A board** inserted before it has been read lands with the sheet's origin, not its middle, at the origin.
  Its part envelopes come from the footprints (courtyards), refined by the 3D models as they load.
- **Interference** does not look inside sub-assemblies yet.
- **Connectors come from the tessellation**, not the B-rep: planes, cylinders, circles, lines and points are
  recognised; a cone, a sphere or a spline face gives its middle and average normal. Tangent works for a plane
  with a cylinder and for two cylinders only.
- **Angles are in (−180°, 180°]**: a limit cannot span more than one turn. A relation keeps no phase of its own:
  it holds from where the parts were put, so mesh the teeth, then add it.
- **Copy in a row** makes plain instances; a pattern's copies follow their seed as one rigid thing with it. A
  pattern has one direction (no second direction, no skipped instances); a copy cannot seed another pattern.
- **Mirror instances** is not there: a mirrored part needs mirrored geometry, which a placement cannot give.
- **Replicate** matches round edges and cylindrical faces of the same size on the same part, by one mate.
- **A saved exploded view** is one offset per instance: no ordered steps, no explode lines.
- **Section view** is not capped; **Mass properties** does not weigh boards or sub-assemblies and gives no inertia;
  **Measure** is between connectors, not the least distance between two faces (Interference has clearance).
- **Mate limits**: Ball has none (no cone angle); Parallel and Tangent take no offset.
- **The tree** has no Origin row and no drag of an instance into another assembly; a sub-assembly opens to show its
  parts' names only.
- **Sub-assemblies are rigid**: their inner freedoms cannot be moved from outside.
- **Freedoms are not counted** for a single connected group of more than 80 moving instances (it still solves).
- **Replace** keeps the mates' names; a mate whose geometry the new part lacks says so and must be re-picked.
- **Versions**: `source.version` is carried and ignored; every instance follows its source live.
- **Presence** (who is dragging what) is not drawn. Two people dragging the same instance: the last drop wins.
- **Each part studio in use costs a worker** while it is being built or was built this session (three kept);
  a project with dozens of studios edited at once has not been profiled.
- The solver's result for under-held assemblies is "the nearest placement": after a part changes upstream, mate
  values are kept where possible (a lid open 45° stays at 45°), but a free part is otherwise left where it was.
