# Mechanical CAD: the contract

This is the document to read before adding anything to the mechanical or assembly domains. It says what the
formats and interfaces are, how to add a feature, a tool, a panel, a worker service or a mate without editing a
shared file, and which folder each piece of future work belongs in.

Everything here is implemented and tested unless a line says otherwise. The limits are listed at the end; read
them before promising something to a user.

## The picture

```
project (Postgres: documents, snapshots, ops)
 ├─ *.kicad_sch, *.kicad_pcb      drawn by the electronics editor (web/domains/pcb)
 ├─ *.jpart   part studio         drawn by web/domains/mechanical   (static/dist/mechanical.js)
 └─ *.jasm    assembly            drawn by web/domains/assembly     (static/dist/assembly.js)

page                                             worker (static/dist/cad-worker.js)
 document tabs (web/platform/doctabs)             OpenCascade (occ-kernel.wasm, fetched on first use)
 └─ PartStudio (ui/studio.ts)                     RegenEngine (kernel/regen.ts)
     ├─ ItemDocSession  ⇄ /ws ⇄ server             ├─ features/*.ts  evaluate()
     ├─ KernelClient    ⇄ postMessage ⇄            └─ services/*.ts  run()
     ├─ ModelView on Viewport3D (three.js)
     └─ React: toolbar, panels, feature dialog
```

A part studio is a list of features. The page holds the document and sends the feature list to the worker; the
worker runs each feature's `evaluate` in order on the kernel and sends back triangles, edge lines and names; the
page draws them. The page never touches the kernel and the worker never touches the document.

## Where things are

| Path (under `server/web/`) | What |
|---|---|
| `shared/itemdoc/itemdoc.ts` | JSON item documents: file format, item changes, order keys. Pure. |
| `shared/itemdoc/sync.ts` | `ItemDocSession`: a live document over the collaboration socket, with undo. |
| `shared/viewport3d/viewport3d.ts` | `Viewport3D`: canvas, orthographic camera, orbit/pan/zoom, standard views, theme colours. |
| `platform/documents/host.ts` | How the shell hands a document to a domain's editor. |
| `platform/doctabs/` | The document tabs. |
| `domains/registry.ts` | Which document kinds exist, which bundle opens them, what a new one contains. |
| `domains/mechanical/core/` | Contracts: `feature.ts`, `tool.ts`, `geometry.ts`. |
| `domains/mechanical/document/` | The `.jpart` format (`format.ts`) and every edit as item changes (`edits.ts`). |
| `domains/mechanical/sketch/` | Sketch data format, region finding, the two-point drawing engine. |
| `domains/mechanical/kernel/` | Worker side: OpenCascade helpers, regeneration, tessellation, protocol, the page's client. |
| `domains/mechanical/features/` | **One file per feature type.** |
| `domains/mechanical/tools/` | **One file per toolbar tool.** |
| `domains/mechanical/panels/` | **One file per docked panel.** |
| `domains/mechanical/services/` | **One file per worker service.** |
| `domains/mechanical/viewport/modelview.ts` | Bodies, planes, sketches, highlighting and picking in the viewport. |
| `domains/mechanical/ui/` | The part studio controller (`studio.ts`) and its React frame. |
| `domains/mechanical/api.ts` | What other domains may import from this one. |
| `domains/assembly/` | The `.jasm` format, the mate registry (`mates/`, **one file per mate type**), the editor stub. |

Server: `server/src/itemdoc.rs` (the document types and the fold), `dockind.rs` (how each document type behaves
for history, merging, folding and thumbnails), `itemmerge.rs` (the three-way merge), two lines each in `http.rs`
(`doc_type_for`, `allowed_file`, `doc_is_movable`), `compact.rs`, `pcm.rs` (serves the `.wasm`), `pages.rs` and
`main.rs` (serve the bundles).

## Adding things without colliding

Features, tools, panels, services and mates are **found by folder**. `scripts/gen-cad-registry.mjs` lists the
files of `features/`, `tools/`, `panels/`, `services/` (mechanical) and `mates/`, `tools/` (assembly) and writes
`generated/page.ts` and `generated/worker.ts`, which are not committed. `npm run check`, `npm run build` and the
tests run it first. So:

- **Add a file with a default export. Do not edit an index, a toolbar or a list.**
- A file whose name starts with `_` or ends in `.test.ts` is skipped: use `_helpers.ts` for code shared by a few
  files of one folder.
- After adding a file, run `npm run gen:cad` (or `npm run check`) so the type-checker sees it.

### Which folder for which piece of work

| Work | Put new files in | Registers through |
|---|---|---|
| Sketcher and constraint solver | `mechanical/sketch/` (solver, constraint UI, new entity kinds), `mechanical/tools/sketch-*.ts` | tools; the sketch format below |
| More features (fillet, chamfer, shell, revolve, patterns, …) | `mechanical/features/<type>.ts`; shared kernel code in `mechanical/kernel/ops/` (new folder) | features |
| Live collaboration on the feature tree (presence, cursors, who edits what) | `mechanical/collab/` (new), `mechanical/panels/` | `ItemDocSession.setPresence`, `onPeers`; panels |
| Live PCB board model in CAD | `mechanical/features/board-reference.ts`, `mechanical/board/` (new) | features; `pcb` domain's documented exports |
| Assemblies and mates | `assembly/mates/`, `assembly/tools/`, `assembly/solver/` (new), `assembly/ui/` | mates, assembly tools |
| Measurement, section, mass properties | `mechanical/services/`, `mechanical/tools/`, `mechanical/panels/` | services, tools, panels |
| Export and import (STEP, STL, 3MF) | `mechanical/services/export-*.ts`, `mechanical/tools/export-*.ts`, `mechanical/features/import-*.ts` | services, tools, features |
| Variables, configurations, materials | new item types in the `.jpart` (see "Unknown items"), `mechanical/document/` in new files | — |

### Shared files: do not edit without need

A change to one of these touches everybody. If you must change one, make the change additive (a new optional
field, a new method) and say so in your pull request.

- `shared/itemdoc/itemdoc.ts`, `shared/itemdoc/sync.ts` and their mirror `server/src/itemdoc.rs`
- `shared/viewport3d/viewport3d.ts`
- `platform/documents/host.ts`, `platform/doctabs/*`, `domains/registry.ts`
- `mechanical/core/*`, `mechanical/kernel/{types,protocol,regen,occ,tessellate,worker,client}.ts`
- `mechanical/document/{format,edits}.ts`, `mechanical/sketch/{format,profiles}.ts`
- `mechanical/ui/{studio.ts,PartStudioView.tsx,Toolbar.tsx,FeatureDialog.tsx,FeatureList.tsx}`,
  `mechanical/viewport/modelview.ts`, `mechanical/api.ts`
- `assembly/core/*`, `assembly/document/format.ts`
- `scripts/gen-cad-registry.mjs`, `server/package.json` (the `build:cad` and `test` entries), `static/app.html`
- `web/domains/pcb/editor/{dochost,doc,home}.ts` (the shell's side of the tabs)

Likely needs, and where they go instead of an edit:

- *A new dialog field kind*: add a member to `ParamField` in `core/feature.ts` and a `case` in
  `ui/FeatureDialog.tsx`. Additive; coordinate if two people need one at once.
- *A new kernel helper*: a new file under `kernel/ops/`, taking the `Kernel` as an argument. Do not grow `occ.ts`.
- *A new pick kind in the viewport*: additive member of `Pick` in `viewport/modelview.ts`.
- *A feature that needs its own editor* (as Sketch has `openSketch` / `finishSketch`): tools in `tools/` drive
  it; if `studio.ts` lacks a method you need, add one rather than special-casing the feature inside existing ones.

## Documents

### JSON item documents (`shared/itemdoc/itemdoc.ts`)

Both new document kinds are one JSON object:

```json
{"junction":"part-studio","version":1,"items":[
{"id":"studio","rollback":null,"type":"studio","units":"mm"},
{"featureType":"sketch","id":"3f0c…","name":"Sketch 1","order":"V","params":{…},"type":"feature"}
]}
```

- `junction` is the kind (`"part-studio"`, `"assembly"`), `version` the format version (1).
- `items` is unordered. Every item has a stable string `id`, unique in the document, and a `type`.
- The file is written one item per line, in id order, with sorted keys, so a line diff shows the items that
  changed. Never compare files byte for byte: the server and the browser print numbers differently.
- **Unknown items.** A reader keeps item types and keys it does not know, and writes them back. Add data by
  adding item types or keys, never by changing the meaning of an existing key. Bump `version` only for a change
  an old reader would get wrong, and then old readers refuse the file.
- **Order.** A list whose members are separate items keeps each member's place in a string `order` key
  (`orderBetween(a, b)` gives a key between two others; `byOrder(items)` sorts, ties by id). Moving a member
  changes one key.

### Changes

A document changes only by item changes, the same wire shape KiCad documents use (`id`, `kind`), so the existing
collaboration path carries them unchanged:

```ts
{ id, kind: "ADDED",    typeName, item }      // the whole item; an existing id is replaced
{ id, kind: "MODIFIED", typeName, props }     // props: [{ path: ["params","depth"], value }, { path, del: true }]
{ id, kind: "REMOVED",  typeName }
```

Applied in the server's sequence order; **the last writer of a path wins**; a change to an id that is not there
does nothing (a delete beats a concurrent modify). A path is a list of object keys; arrays are single values.
So design data as maps keyed by id wherever two people might edit different members at once (the sketch does).

Helpers: `addedChange(item)`, `removedChange(item)`, `modifiedChange(before, after)` (sends only the paths that
differ), `diffProps`, `invertChange`, `applyChanges`.

### How a change is committed and synced

```ts
studio.commit(changes)        // PartStudio → ItemDocSession.commit
```

`commit` applies the changes locally at once, journals them, sends one `op` over `/ws`, and pushes one undo
step. The server sequences and stores the op and broadcasts it to everyone else in the document; their sessions
apply it and their models regenerate. An op that is not acknowledged yet is replayed after a reconnect, and
stays on top of whatever arrives before its ack. `studio.undo()` / `redo()` send ordinary changes, so everyone
sees an undo. A viewer's `commit` returns false with a notice.

**Use `document/edits.ts`** for the edits it has (`addFeature`, `setParams`, `setParamPath`, `renameFeature`,
`suppressFeature`, `moveFeature`, `deleteFeature`, `setRollback`); each returns changes and applies nothing.
Build your own changes the same way for anything else. Never mutate `session.doc` directly.

A dialog does not commit while it is open: it edits a draft (`studio.getState().editing.draft`) that the worker
previews, and Done commits once.

What the platform gives these documents today, and what it does not:

| Works | How |
|---|---|
| Storage, roles (viewer / commenter / editor), share links | the existing `documents`, `ops`, `snapshots` tables and `access.rs` |
| Live co-editing, item by item, property by property | the existing `/ws` op path; verified with two browsers |
| Presence transport | `session.setPresence(state)` / `onPeers`; **nothing draws it yet** |
| The stored file kept current | `compact.rs` folds the ops into a snapshot on the server (`itemdoc.rs`), with no client involved |
| Project archive, clone, GitHub sync | they read the folded file like any other; a pull with changes on both sides merges item by item (`itemmerge.rs`) |
| Create, rename, delete from the tabs | `POST /api/projects/{id}/docs`, `PATCH` / `DELETE /api/docs/{id}` |
| Version history, restore, looking at an earlier version | the History drawer (`platform/history`, the part studio's is `mechanical/history`); see "Platform features" below |
| Compare two versions | the Compare window with the domain's renderer (`platform/review/renderers.ts`, `mechanical/compare`) |
| Branches and merging, conflicts put to a choice | `versions.rs` with `itemmerge.rs`; the drawer's merge dialog |
| Thumbnails | `platform/documents/thumbnail.ts`, `mechanical/thumbnail.ts` (part studios; an assembly draws nothing yet) |
| MCP tools for an AI assistant | `mechanical/mcp` (part studios); see "Platform features" below |

| Does not work yet | |
|---|---|
| Comments pinned to geometry | the comments API is per document and would work; no UI in the part studio |
| Tabs appearing for others without a reload | the tab list is fetched on open and when the window regains focus; there is no push |
| An earlier version of an assembly on screen, comparing assemblies, MCP tools for assemblies | the assembly editor has no read-only view of another state and registers no compare renderer; the server side is the same as for a part studio |

### Platform features, and how another kind of document gets them

The server asks `server/src/dockind.rs` how a document type behaves (journalled as ops or stored whole, who
folds its journal, how a branch merges, how two files merge, whether its picture can stand for the project). A
new JSON item document kind is one line there and gets history, branches, merging and GitHub sync with it.

- **History** (`platform/history/`): `api.ts` is the server's versions, timeline, branches and merge as plain
  calls; `HistoryDrawer.tsx` is the drawer, handed a `HistoryHost` (`viewing`, `view(at | null)`, `compare?`,
  `canEdit`, `navigate`, `toast`). The part studio's host is `mechanical/history/index.tsx`: `view` fetches the
  document at that point (`itemDocAt`) and calls `studio.showPast(doc, label)`; `showPast(null)` brings the live
  document back. While a past document is on screen `studio.getState().past` is set, `canEdit` is false and
  `commit` refuses. The toolbar button is `tools/history.ts`. `platform/history/request.ts` lets another editor
  (the electronics History pane) ask for a point to be shown.
- **Merging** (`server/src/itemmerge.rs`): each side's work since the two last met becomes one net effect per
  item (added or replaced whole, removed, or paths set or deleted). Different items never conflict, nor do
  different paths of one item; the same path set to the same value is not a conflict; the same path set
  differently, or a path inside a path the other side set, conflicts at the shorter path; removed against
  changed conflicts on the item. `POST /api/projects/{branch}/merge` reports the conflicts (`dryRun`) and takes
  `choices: { <conflict id>: "incoming" | "current" }`. So, again: keep data that two people may change apart in
  maps keyed by id, not in arrays.
- **Compare** (`platform/review/renderers.ts`): `registerCompareRenderer({ docTypes, mount(ctx) })` from the
  domain's bundle; `ctx` has an empty element, the two files as text (`ctx.a.text`, `ctx.b.text`) and
  `setSummary`. The part studio's (`mechanical/compare/`) is `diff.ts` (features matched by id, parameters named
  by the registry's labels) and the worker service `compare-versions` (both versions built by engines of their
  own, compared by booleans: common, added, removed, each tessellated).
- **Thumbnails** (`platform/documents/thumbnail.ts`): `new ThumbnailPusher(docId, () => canvas | null)`, then
  `dirty()` when the document changes. `mechanical/thumbnail.ts` draws the bodies into a render target on the
  viewport's own WebGL context.
- **AI tools** (`platform/mcp/host.ts`): a domain's `mcp/host.ts` exports an `McpDomainTools` table and
  `mcp/tools.json` lists the tools; add the table to `domains/mcp-tools.ts` and the JSON to `DOMAIN_TOOLS` in
  `server/src/mcp.rs`. They run in the same Node host as the electronics tools (`npm run build:mcp`). The part
  studio's are `cad_feature_types` (from the feature registry), `cad_get_features`, `cad_get_bodies`,
  `cad_edit_features`, `cad_render_view`, `cad_create_part_studio`; edits are planned and validated in
  `mcp/model.ts` against each feature's `schema`, so a new feature type is editable by an assistant with no
  further work as long as its parameters are described by its schema.
- **Interface state of a tool or panel**: `studio.setUi({ myKey: value })` keeps it in `getState().ui` and
  redraws the toolbar, so a tool's `active` can read it (the History button does).

### The part studio (`.jpart`, `document/format.ts`)

```ts
// one step of the history tree
{ id, type: "feature", featureType: "extrude", name: "Extrude 1", order: "V", suppressed?: true, params: {…} }
// one item, id "studio"
{ id: "studio", type: "studio", units: "mm", rollback: <feature id> | null }
```

- The tree is the feature items sorted by `order`.
- `featureType` names a registered feature; `params` is that feature's own data, described by its schema.
- `rollback` is the first feature that is **not** built (the bar sits above it); `null` is the end. It is in the
  document, so it is shared and stored. A bar on a feature that no longer exists reads as the end.
- Lengths are millimetres and angles degrees, whatever `units` says; `units` only chooses how lengths are shown
  (nothing reads it yet).
- Feature ids are UUIDs. A body's id is the id of the feature that made it (with a suffix when one feature
  made several), so body ids survive rebuilds.

### The sketch (`sketch/format.ts`), stored in a sketch feature's `params`

```ts
params: {
  plane: { kind: "plane", plane: "top" | "front" | "right" } | { kind: "face", ref: GeomRef },
  sketch: {
    version: 1,
    entities: {                                  // a map, keyed by short ids
      p1: { type: "point", x: 0, y: 0 },         // sketch-plane coordinates, mm
      l1: { type: "line", a: "p1", b: "p2" },    // curves refer to points by id
      c1: { type: "circle", center: "p3", r: 5 },
      a1: { type: "arc", center: "p3", start: "p4", end: "p5" },   // counter-clockwise from start to end
    },
    constraints: {                               // a map; nothing reads it yet
      k1: { type: "horizontal", refs: [{ entity: "l1" }] },
      d1: { type: "distance", refs: [{ entity: "l1", at: "start" }, { entity: "l1", at: "end" }], value: 40,
            driving: true, expr: "width", label: { x: 20, y: -5 } },
    },
  },
}
```

Rules that are fixed now:

- **Points are entities and curves refer to them by id.** Two curves that share a point id are joined there. A
  rectangle is four points and four lines.
- **The document always stores solved coordinates.** A tool or a solver writes the resulting positions and radii
  into the entities; the kernel builds geometry from the entities alone and never solves. A reader that does not
  know a constraint type keeps it and ignores it. This is what lets a solver arrive without changing the format
  or the kernel.
- A dimension is a constraint with a `value` (mm, or degrees for an angle). `driving: false` is a reference
  dimension. `expr` is the text it was typed as, for when variables exist. `label` is where its text sits.
- `construction: true` on an entity keeps it out of profiles.
- Reserved constraint type names: `coincident`, `horizontal`, `vertical`, `parallel`, `perpendicular`,
  `tangent`, `equal`, `midpoint`, `concentric`, `symmetric`, `fix`, `distance`, `radius`, `diameter`, `angle`.
- A sketch edit is one `MODIFIED` change on the feature item with one prop per entity
  (`sketchEntitiesChange(featureId, { id: entity | null })` in `sketch/drawing.ts`).
- New entity kinds (ellipse, spline, text) are new `type` values; `sketch/format.ts curvePoints` and
  `features/sketch.ts edgeFor` are the two places that must learn them.

Sketch planes: `top` is XY (normal +Z), `front` is XZ (normal −Y), `right` is YZ (normal +X). The ids are
stored; never rename them. On a face, the frame comes from `Kernel.faceFrame`: the normal points out of the
solid, x is the surface's own first direction, and the origin is the point of the plane nearest the world origin.

Regions (`sketch/profiles.ts findRegions`): a closed loop is a chain of lines and arcs in which every point
joins exactly two curves (by shared id or by position), or a circle. A loop inside another is a hole; a loop
inside a hole is a region again. A region's id is the smallest entity id on its outer loop; treat it as opaque.

## Features

### The registry API (`core/feature.ts`)

```ts
export interface FeatureDefinition<P> {
  type: string;                 // stable id, stored as featureType: never rename
  title: string;                // "Extrude"; new features are named "Extrude 1", …
  icon?: string;                // inline SVG markup, 24×24 stroke glyph, currentColor
  defaults(): P;                // parameters of a new feature (a fresh object each call)
  schema: ParamField[];         // the dialog's fields, in order
  evaluate(ctx: EvalContext, params: P): void | Promise<void>;   // runs in the worker
  toolbar?: boolean;            // false: no toolbar button
  toolbarOrder?: number;
}
```

`ParamField` is `{ key, label, hint?, visible?(params) }` plus one of:

| `kind` | Stores | Dialog |
|---|---|---|
| `number` (`unit`, `min`, `max`, `step`) | a number | a number field |
| `boolean` | a boolean | a checkbox |
| `text` | a string | a text field |
| `enum` (`options`) | a string | a segmented control, or a select above four options |
| `profile` | `{ sketch: <feature id>, regions: null \| string[] }` | a list of earlier sketches; click one in the viewport |
| `plane` | a `PlaneRef` | Top / Front / Right, or click a planar face |
| `refs` (`of: GeomKind[]`, `single?`) | `GeomRef[]` (or one) | click faces, edges or vertices in the viewport |
| `bodies` | `string[]` of body ids; empty means every body | click a body |

A feature file is bundled into both the page and the worker. **It must not touch the DOM, three.js or React at
module level**, and `evaluate` must use only its context.

### `EvalContext` (`kernel/types.ts`)

```ts
ctx.oc                         // the raw OpenCascade bindings (typed: OpenCascadeInstance)
ctx.k                          // helpers: sub(), list(), prism(), boolean(), carryNames(), faceFrame(), volume(), …
ctx.feature                    // { id, type, name }
ctx.bodies(), ctx.body(id)
ctx.addBody(shape, names, { suffix?, name? })      // names: (face, index) => string | null
ctx.replaceBody(body, shape, names)                // keeps the body's id and name
ctx.removeBody(body)
ctx.sketch(featureId)          // SketchGeometry: frame, regions (kernel faces with their edges), open curves
ctx.setSketch(sketch)
ctx.resolve(ref)               // GeomRef → { kind, body, shape, name }, or a FeatureError
ctx.frameOf(planeRef)
ctx.own(obj)                   // delete obj when this feature's cached result is dropped
ctx.tmp(obj)                   // delete obj when evaluate returns
throw ctx.fail("Pick an edge to fillet.")          // a message a person can act on
ctx.warn("…")                  // a note on the feature; it still succeeds
```

Rules:

- The model a feature sees is a working copy. If `evaluate` throws, the model stays as the feature found it,
  the feature shows the message, and later features still run.
- **Name every face you make**, through `ctx.k.carryNames(resultShape, builder, inputFaces, ctx.feature.id)` for
  an operation with history (any `BRepBuilderAPI_MakeShape`: fillet, chamfer, shell, booleans), or with your own
  `FaceNamer`. Edge and vertex names follow from the faces automatically.
- Kernel objects are embind handles. `ctx.k.sub()` and `ctx.k.list()` track what they hand out; anything you
  make with `new oc.X()` goes through `ctx.tmp()` or `ctx.own()`. A shape you pass to `addBody` /
  `replaceBody` is owned for you.
- Do not keep state between evaluations in module variables: results are cached and replayed.
- Parameters are JSON. Validate them and fail with a sentence, not an exception from the kernel.

### Worked example: a Fillet feature

Create `features/fillet.ts`. Nothing else changes: the toolbar button, the dialog, the regeneration, the sync
and the undo all come from this file.

```ts
// fillet.ts — round the picked edges of a body.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";

export interface FilletParams { [key: string]: any; edges: GeomRef[]; radius: number }

export default defineFeature<FilletParams>({
  type: "fillet",
  title: "Fillet",
  icon: '<path d="M5 19V11a6 6 0 0 1 6-6h8"/>',
  toolbarOrder: 30,
  defaults: () => ({ edges: [], radius: 1 }),
  schema: [
    { key: "edges", label: "Edges", kind: "refs", of: ["edge"] },
    { key: "radius", label: "Radius", kind: "number", unit: "mm", min: 0.001 },
  ],
  evaluate(ctx: EvalContext, p: FilletParams) {
    if (!p.edges.length) throw ctx.fail("Pick the edges to round.");
    if (!(p.radius > 0)) throw ctx.fail("The radius must be more than zero.");
    const oc = ctx.oc as any;
    // group the picked edges by the body they are on
    const byBody = new Map<string, ReturnType<EvalContext["resolve"]>[]>();
    for (const ref of p.edges) { const r = ctx.resolve(ref); byBody.set(r.body.id, [...(byBody.get(r.body.id) || []), r]); }
    for (const [bodyId, edges] of byBody) {
      const body = ctx.body(bodyId)!;
      const mk = ctx.own(new oc.BRepFilletAPI_MakeFillet(body.shape, oc.ChFi3d_FilletShape.ChFi3d_Rational));
      for (const e of edges) mk.Add(p.radius, oc.TopoDS.Edge(e.shape));
      mk.Build();
      if (!mk.IsDone()) throw ctx.fail("The fillet could not be built. Try a smaller radius.");
      const shape = ctx.own(mk.Shape());
      // old faces keep their names; each new blend face is named after the edge it replaced
      const names = ctx.k.carryNames(shape, mk, body.topo.faces, ctx.feature.id, edges.map((e) => ({ name: e.name, shape: e.shape })));
      ctx.replaceBody(body, shape, names);
    }
  },
});
```

Then `npm run gen:cad && npm run check`, and add a case to `static/tests/mechanical-kernel.test.js` (or a test
file of your own: copy its first twenty lines for the loader).

(Check the enum and constructor names against `node_modules/replicad-opencascadejs/dist/replicad_single.d.ts`
before relying on them: the example has not been run.)

### Regeneration (`kernel/regen.ts`)

- The worker is sent every feature and the number to build (`rollback`).
- A feature is evaluated again only if it, or a feature before it, changed: id, type, `suppressed` or `params`.
  A rename changes nothing. Editing feature 10 of 20 evaluates 10 to 20.
- Results beyond the rollback bar stay cached while nothing before them changes, so moving the bar is free.
- A suppressed feature is skipped; one that depended on it fails with its own message.
- Each feature reports `ok`, `warning`, `error`, `suppressed` or `rolled-back`, a message, and its time.
- A body has a `rev` that changes when its shape does. The page says which revisions it holds and is sent
  meshes only for the others.
- While a dialog is open the page sends the draft in place of (or inserted among) the document's features, and
  while a sketch is open it sends the list rolled back to that sketch. That is local: the document's `rollback`
  is not touched.

## Geometry names

Features and mates refer to faces, edges and vertices by **name**, never by index:

```ts
interface GeomRef { kind: "face" | "edge" | "vertex"; body: string; name: string }
```

`ctx.resolve(ref)` looks the name up on every rebuild, in `ref.body` first and then in every body (a body that
was merged into another keeps its faces' names).

How names are made:

| Geometry | Name |
|---|---|
| Extrude cap | `<feature id>:start:<region id>`, `<feature id>:end:<region id>` |
| Extrude side | `<feature id>:side:<sketch entity id>` (the curve that swept it) |
| A face an operation left alone or modified | the name it had |
| One named face split into several | the first keeps the name; the others get `name~2`, `name~3`, … |
| A face generated from a named input (a fillet from an edge) | `<feature id>:from(<that name>)` |
| A face with no history | `<feature id>:new#<n>` |
| A face an extrusion stops on (up to face, up to next) | its end cap, `<feature id>:end:<region id>` |
| Thin extrude wall offset from a side | `<feature id>:side:<entity>:inner` / `:outer` |
| Revolve | as Extrude: `:side:<entity>`, and `:start:` / `:end:<region>` when not a full turn |
| Shell or thin wall face | `<feature id>:from(<the face it is offset from>)`; an opening's rim keeps the removed face's name |
| Drafted face, moved or copied body (Transform) | the name it had |
| Hole | `<feature id>:<sketch point id>:wall`, `:floor`, `:cbore`, `:cbore-floor`, `:csink` |
| Split | the new flat face on each piece is `<feature id>:cut` |
| Edge | `edge(<face>\|<face>)`: the names of the faces it lies between, sorted |
| Vertex | `vertex(<face>\|<face>\|<face>)`: the faces that meet there, sorted |
| Several edges or vertices with the same faces | `…~2`, `…~3` |

Names are opaque strings to everything but the kernel helpers. Do not parse them.

**What is stable.** A reference survives any change upstream that keeps the creating feature, the sketch entity
and the face's identity: changing a depth, moving sketch points, adding features in between, adding or removing
material elsewhere on the body. Tested: `static/tests/mechanical-kernel.test.js`.

**What is not, honestly:**

- `~n` and `#n` suffixes are assigned in geometric order (by centre of mass: x, then y, then z). They appear
  when one face is split into several, and when several edges lie between the same two faces (a slot cut across
  a face meets it in two edges with the same pair of names). An edit that moves such siblings past each other
  can swap their names, and a reference to one may then jump to the other.
- When a boolean merges two coplanar faces, the merged face keeps the name of the body being changed; the
  tool's cap name disappears. A reference to the lost name fails with "no longer exists".
- Deleting and redrawing a sketch curve gives it a new entity id, so the faces it sweeps get new names.
- Redrawing a region so that a different curve has the smallest id changes the region id, and the cap names.
- A sketch on a face takes its x direction from the surface's own parametrisation, which is stable for planes
  made by Extrude but is not guaranteed for every operation; a sketch may turn in its plane after an upstream
  feature is replaced by a different kind.
- Names are unique within a body, not across bodies made by patterns or copies: a pattern feature must add the
  instance to the names it makes.
- There is no persistent-id service beyond this: no geometric matching of a lost reference to the nearest
  survivor.

## The worker

### Protocol (`kernel/protocol.ts`)

```
page → worker   { t: "init", wasmUrl }
                { t: "regen", seq, features: FeatureInput[], rollback: number, have: number[] }
                { t: "call", seq, service: string, args: Json }
worker → page   { t: "ready", ms } | { t: "failed", message }
                { t: "progress", seq, index, total, featureId }
                { t: "regen", seq, result: RegenResult }
                { t: "call", seq, ok: true, value } | { t: "call", seq, ok: false, error }
```

`FeatureInput` is `{ id, type, name, suppressed, params }`. `RegenResult` is
`{ features: FeatureReport[], bodies: BodyResult[], sketches: SketchView[], rebuiltFrom, ms }`. A `BodyResult`
is `{ id, name, createdBy, rev, mesh? }`, and a `BodyMesh` is typed arrays, transferred:

```ts
positions, normals: Float32Array; indices: Uint32Array;
faces:    { names: string[]; start, count: Uint32Array }              // ranges of `indices`
edges:    { names: string[]; positions: Float32Array; start, count }  // line segments, two points each
vertices: { names: string[]; positions: Float32Array }
bbox:     [xmin, ymin, zmin, xmax, ymax, zmax]
```

Messages are handled one at a time, in order; a regeneration is skipped when a newer one is already waiting.
`KernelClient` (`kernel/client.ts`) is the page's end: `regenerate(features, rollback)` resolves with the
result, or null when a newer request overtook it; `call(service, args)` resolves with the service's JSON.
Nothing is loaded until the first regeneration: opening a board never fetches the kernel.

### Services (`kernel/service.ts`)

A question about the model that is not a feature (measure, section, mass properties, export) is a file under
`services/`:

```ts
export default defineService({
  name: "mass-properties",
  run(ctx, args) { /* ctx.oc, ctx.k, ctx.state.bodies, throw ctx.fail("…") */ return { volume, area, centre }; },
});
// page:  const mass = await studio.kernel.call("mass-properties", { body: bodyId });
```

`ctx.state` is the model the page is showing (after the last regeneration). The result is JSON; to return large
binary data (an STL), return a base64 string for now, or extend the protocol with a transferable result
(additive: a `buffers` field on the `call` reply).

### The kernel

`replicad-opencascadejs` 1.2.1 from npm: OpenCascade 7 compiled to WebAssembly, LGPL-2.1 with the Open CASCADE
exception (the same kernel licence the desktop app already links; compatible with GPLv3). Only its bindings are
used, not the replicad library. The `.wasm` is 23 MB (about 7 MB compressed), copied to
`static/dist/pyodide/occ-kernel.wasm` by `scripts/build-python.mjs` (that folder is not committed and is served
from disk at `/static/pyodide/`), and fetched by the worker on first use. Its JavaScript half is bundled into
`cad-worker.js`.

The build exposes a subset of OpenCascade (about 500 classes): primitives, sweeps, booleans, fillet, chamfer,
offset, thick solid, draft, loft, pipe, STEP read and write, `GProp`, `BRepExtrema`. It does **not** expose
`TopTools_IndexedMapOfShape`, `TopExp::MapShapesAndAncestors` or `TShape()`; use `Kernel.sub()` and `ShapeIndex`
(hash + `IsSame`) instead. Check the `.d.ts` before designing around a class. Overloads are real overloads
(`new oc.BRepPrimAPI_MakePrism(face, vec, false, true)`), not the `_1`, `_2` suffixes of older opencascade.js.

## The toolbar and panels

### Tools (`core/tool.ts`)

```ts
export default defineTool({
  id: "measure", title: "Measure", hint: "Click two things", icon: "<path …/>",
  group: "inspect",            // "edit" | "sketch" | "feature" | "inspect" | "view" | "file"
  order: 10, key: "m",
  disabled: (studio) => (studio.getState().bodies.length ? null : "Nothing to measure"),
  active: (studio) => false,
  run: (studio) => { … },
});
```

Every feature type gets a button in the `feature` group for free. Tools in `sketch` show only while a sketch is
open, and the feature buttons are hidden meanwhile. `key` runs the tool while the viewport has the keyboard.

A tool that takes over the pointer (a sketch tool, a measure tool) sets `studio.view.pointerTool = { down, move,
up }` and `studio.keyHandler`, and draws its rubber band with `studio.view.setOverlay(segments, dots)`. The
two-point sketch tools share `sketch/drawing.ts startTwoPointTool`; `tools/sketch-rectangle.ts` is nine lines.

### Panels

```ts
export default definePanel({ id: "measure", title: "Measure", side: "right", order: 10, render: (studio) => <Measure studio={studio} /> });
```

A panel is a React component that reads the studio with `useStudio(studio, (s) => s.bodies)` (`ui/hooks.ts`).

### `PartStudio` (`ui/studio.ts`)

What tools, panels and dialogs are handed:

```ts
studio.getState()              // StudioState: features, rollback, reports, bodies, sketches, selection, hover,
                               //   editing, sketch, kernel, peers, canEdit, canUndo, canRedo, …
studio.subscribe(fn)
studio.doc                     // the ItemDoc (read only; change it with commit)
studio.commit(changes)         // see "How a change is committed"
studio.undo(), studio.redo()
studio.kernel.call(name, args)
studio.view                    // ModelView: pick(ev), planePoint(ev, frame), setOverlay, setFilter, sketchFrame, pointerTool
studio.viewport                // Viewport3D: fit(), setView(), lookAlong(), ray(ev), project(p), pixelSize(), scene
studio.select(picks), studio.selectFeature(id)
studio.startFeature(type), studio.editFeature(id), studio.setDraft(patch), studio.acceptFeature(), studio.cancelFeature()
studio.openSketch(id), studio.finishSketch(), studio.setSketchTool(id)
studio.host                    // DocumentHostContext: project, doc, docs, toast(), openDoc()
```

`window.JunctionPartStudio` is the open studio, for tests and the console.

### Picking (`viewport/modelview.ts`)

```ts
type Pick =
  | { kind: "face" | "edge" | "vertex"; body: string; name: string; point: Vec3 }
  | { kind: "plane"; plane: "top" | "front" | "right"; point: Vec3 }
  | { kind: "sketch"; featureId: string; entity: string | null; region: string | null; point: Vec3 };
```

A vertex wins over an edge wins over a face when the pointer is within a few pixels; a body wins over a sketch
wins over a plane. Hover and selection are highlighted from the same picks. Turn a pick into a stored reference
with `{ kind, body, name }`.

Viewport navigation: right-drag orbits, middle-drag or Shift + right-drag pans, the wheel zooms about the
pointer, the buttons at the top right give Top / Front / Right / Iso / Fit. Model space is millimetres, Z up.
Colours come from the theme tokens (`tokenColor("--mark")`); do not write colour literals.

## Document tabs and the shell

- `domains/registry.ts` lists the document kinds: `docType`, `ext`, `title`, `icon`, and for kinds a domain's
  own editor draws, `bundle`, `newName` and `newText`. A new kind of document is an entry there, two lines in
  `server/src/http.rs` (`doc_type_for`, `allowed_file`) and one in `itemdoc.rs` (`is_item_doc`).
- The tabs (`platform/doctabs`) show the root schematic, each board, and every document whose kind has
  `newName`. "+" offers the kinds with `newText`. Rename and delete are offered for those kinds only: a
  project's schematic and board stay put.
- Opening a tab dispatches `openDoc`. For a kind with a `bundle`, the shell (`pcb/editor/dochost.ts`) leaves the
  KiCad document, shows the `cad` view, loads the bundle once, and calls the `DocumentEditorFactory` it
  registered (`platform/documents/host.ts`):

```ts
registerDocumentEditor({
  docTypes: ["part_studio"],
  open(ctx) { /* ctx.el, ctx.project, ctx.doc, ctx.docs, ctx.signedIn, ctx.setConnection, ctx.toast, ctx.openDoc */
    return { close() { … } };
  },
});
```

- The address is `/p/<project>/edit?doc=<document id>` for every kind.
- The menu bar shows the project name and role in the `cad` view and no KiCad menus. A domain that needs menus
  should get them through an interface on the menu bar, not by importing into `shared/` (see the roadmap).

## The assembly (`.jasm`, `assembly/document/format.ts`)

```ts
{ id: "assembly", type: "assembly", units: "mm" }
{ id, type: "instance", name, order, source, transform, fixed?, suppressed?, hidden? }
{ id, type: "mate", mateType: "fastened", name, order, a, b, params, suppressed? }
```

- `source` is `{ kind: "part", docId, body }`, `{ kind: "board", docId }`, `{ kind: "assembly", docId }` or
  `{ kind: "file", docId }`, each with an optional `version` to pin it. An instance copies no geometry: the
  assembly follows the source document.
- `transform` is twelve numbers, the rows of a 3 × 4 matrix (rotation and translation, mm).
  **The document always stores solved placements**, as the sketch stores solved coordinates.
- A mate ties connector `a` to connector `b`: `{ instance, ref: GeomRef, flip? }`. The `ref` uses the geometry
  names above, in the instance's source body. For a board, the electronics domain must define the names it
  offers (mounting holes, connector faces); that is not designed yet.
- Mate types are files under `assembly/mates/` (`core/mate.ts`):

```ts
export default defineMate({
  type: "revolute", title: "Revolute", icon: "…", defaults: () => ({ offset: 0 }),
  schema: [{ key: "offset", label: "Offset", kind: "number", unit: "mm" }],
  freedom: { translation: 0, rotation: 1 },
  place(a, b, bNow, params) { /* frames in assembly space → b's new Transform */ },
});
```

  `place` answers one mate alone. A solver for several mates at once is not built; when it is, it reads the
  same definitions and adds its own hook beside `place`.

What exists: the document kind, its tab, the editor frame (`assembly/ui`) with the instance and mate lists and
an empty viewport, a toolbar drawn from `assembly/tools/*.ts` (none yet), `mates/fastened.ts`, placement
arithmetic (`core/transform.ts`). What does not: inserting anything, drawing instances, connectors, solving.

To draw a part-studio instance: open its document with `ItemDocSession` (`expectKind: PART_STUDIO_KIND`), turn
it into worker input with `featuresOf` and `featureInputs`, regenerate with a `KernelClient`, and draw each
`BodyMesh` (all exported from `mechanical/api.ts`). One worker can serve several documents only one at a time
(the engine caches one feature list); use one `KernelClient` per source document, or extend the protocol with a
document key (additive).

## Running and testing

```sh
cd server
npm ci
npm run check                      # generates the registries, then tsc
npm run build                      # every bundle; static/dist/{mechanical,assembly,cad-worker}.js are committed
node scripts/ci-web-tests.mjs      # all web tests, including the five below
cargo test --locked && cargo clippy --locked --all-targets
```

Tests for this work, each runnable alone with `node static/tests/<name>.test.js`:

| Test | Covers |
|---|---|
| `itemdoc` | file format, change rules, order keys, the session against a scripted socket |
| `doctabs` | which documents get tabs, new names, renames, the registry's document kinds |
| `mechanical-doc` | the `.jpart` format, every edit, sketch helpers, region finding |
| `mechanical-kernel` | **the real kernel in node**: sketch → extrude, booleans, names across rebuilds, cache, rollback, errors |
| `assembly-doc` | the `.jasm` format, the mate registry, Fastened |
| `cargo test itemdoc` | the server's fold of ops into the stored file |
| `cargo test itemmerge`, `cargo test dockind` | the merge rules for item documents, and what each document kind answers |
| `cad-history` | the feature diff, the 3D diff in the real kernel, the history list |
| `cad-mcp` | the AI tools' planning and validation, a plan built in the real kernel, the software render |

Against a running server: `scripts/cad-history-ui.mjs` (history, compare, branches and merge, thumbnails, in
Chromium), `scripts/cad-history-mcp.mjs` (a JSON-RPC session on `/mcp` that makes and edits a part) and
`scripts/cad-history-github.mjs` (push, pull and merge against `scripts/fake-github.mjs`).

`static/tests/cad-load.js` bundles a module for a node test: `const { load } = require("./cad-load"); const F =
load("domains/mechanical/document/format.ts");`. New test files must be added to the `for t in …` list of the
`test` script in `package.json` to run in CI.

To run the app: Postgres, then

```sh
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/db JWT_SECRET=dev PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 \
  KC_DEV_LOGIN=1 cargo run
```

`scripts/cad-ui.mjs` drives the real app in Chromium against such a server (Playwright, and `psql` to make its
two test users): tabs, sketch, extrude, picking, tab switching, two people editing, a sketch on a face, the
rollback bar, the error state, the server's fold. Run it after any change to the shell, the session or the
studio; add to it when you add something a person does:

```sh
E2E_PG_URL=postgres://user:pass@127.0.0.1:5432/db E2E_JWT_SECRET=dev SHOTS=/tmp/shots node scripts/cad-ui.mjs
```

With `KC_DEV_LOGIN=1`, `/auth/dev?jwt=<token>&next=/` signs a browser in with a JWT signed by `JWT_SECRET`
(`{ sub: <users.id>, login, iat, exp }`, HS256); insert the user row first. In a browser test, wait on
`window.JunctionPartStudio.getState()` (for example `kernel.state === "ready"`) rather than on timers, and
start Chromium with `--use-gl=swiftshader --enable-unsafe-swiftshader` when there is no GPU.

## Reference geometry, patterns and variables

Features `plane`, `axis`, `point` and `helix` make **datums**: reference geometry kept in the model
(`ModelState.datums`, by feature id), sent to the page as `RegenResult.datums` (`DatumView`: a plane's frame,
centre and size; an axis' origin, direction and length; a point; a curve as a polyline), drawn and picked by
`viewport/datums.ts` as `Pick { kind: "datum", featureId, datum }`.

- A sketch can lie on a reference plane: `PlaneRef` has a third member `{ kind: "datum", feature }`, and
  `frameOf` resolves it. Selecting a reference plane and pressing Sketch starts one there.
- In `evaluate`: `ctx.datum(id)`, `ctx.setDatum(d)`, and `ctx.history(id)`, the model just before and just after
  an earlier feature (what patterns and mirrors read).
- A `refs` field may also take `datums: ["plane" | "axis" | "point" | "curve"]`, `planes: true` (the default
  planes, also offered as buttons) and `sketch: true` (sketch curves). Those picks are stored as the `RefTarget`s
  of `features/_refs.ts`: `{ kind: "plane", plane }`, `{ kind: "datum", feature }`, `{ kind: "sketch", feature,
  entity }`, besides GeomRefs. `kernel/ops/ref-geom.ts` turns any of them into a plane, axis, point or curve.
  A straight edge's or a cylinder's direction is made canonical (its largest component positive), because the
  kernel may reverse an edge on a rebuild.
- A `features` field stores earlier feature ids in the order picked (`types` / `exclude` filter the list).

**Patterns and Mirror** (`linear-pattern`, `circular-pattern`, `mirror`; `kernel/ops/pattern-core.ts`) copy
bodies, or what earlier features did: the seed's effect on each body is read from `ctx.history` as two tools,
removed (before − after) and added (after − before); every copy is that tool moved, and all copies go into one
cut and one fuse per body. A seed that made a body has the body copied. A copy's faces are named
`<pattern id>:<key>:<seed face name>`, the key naming the copy by its place: `i<n>.<m>` (n-th along the first
direction, m-th along the second, the seed is `i1.1`; a circular pattern uses `i<n>.1`), `m` for a mirror.
Exact for features whose effect does not depend on where they are; a copy of, say, a fillet keeps the seed's
shape. **Sweep** and **Loft** name faces `<id>:start…`, `<id>:end…`, `<id>:side:<sketch entity>`.

**Variables** are items `{ id, type: "variable", name, expr, order }` (`document/variables.ts`, the Variables
panel). A number field accepts an expression; the feature keeps the number and the text under
`params.$expr = { <key>: "<text>" }`. The page evaluates every `$expr` again before each regeneration
(`resolveInputs`, in `studio.ts`), and editing a variable rewrites the stored numbers that depend on it in the same
change. A reader of a `.jpart` that does not know variables sees plain numbers. Anything else that regenerates a
part studio (an assembly drawing an instance) should call `resolveInputs` too.

## Limits, in one place

- **No constraint solver, no dimensions.** Sketch tools snap to existing points, to the origin and to round
  numbers (1-2-5 steps that depend on the zoom). There is no way to type a size while drawing.
- **Sketch tools:** line, rectangle, circle, select, delete. No arc tool (arcs in the data are built and tested),
  no trim, no drag to move a point, no construction toggle.
- **Regions** are simple closed loops with even-odd nesting. Crossing curves and T-junctions make no region.
  Extrude takes all regions of a sketch or the ones listed in `regions`; the dialog cannot pick single regions yet.
- **Solid features** (`features/`, shared kernel code in `kernel/ops/`, tested by `static/tests/mechanical-features.test.js`
  and `scripts/cad-features-ui.mjs`): Extrude (depth, symmetric, through all, up to face, up to next, second
  direction, draft, thin; new / add / remove / intersect), Revolve, Fillet, Chamfer, Shell, Draft, Hole, Boolean,
  Delete body, Split, Transform.  Not done: up to face with an offset, up to a vertex or body; a fillet with a
  variable radius or one that stops tangent propagation; hole threads (a tapped hole is its tap drill); thicken
  and offset face.  "Up to face" on a curved face stops at that face's body (as Up to next, against one body).
  Revolve's axis is a loose line of the sketch, the sketch's X or Y, or a straight edge: the dialog cannot pick
  one sketch line among several (the first loose line is used, with a warning).
- **Geometry names** have the limits listed under "Geometry names".
- **One kernel thread, no cancellation.** A long evaluation blocks the next; the page stays responsive.
- **Kernel memory** is released per cached feature; a very long session on a very large model has not been profiled.
- **The feature dialog** has no expression input and no units other than millimetres and degrees.
- **Collaboration:** edits merge per path, last writer wins. Two people editing one parameter at once: the later
  one wins, silently. Presence is carried but not drawn. There is no lock on a feature someone else has open.
- **Platform gaps** for these documents: comments UI, live tab list, and for assemblies an earlier version on
  screen, compare and MCP tools (see the tables under "How a change is committed and synced").
- **Merging** keeps the journal's rule that a delete beats a modify: a conflict "removed here, changed there"
  resolved for the changed side keeps the item only on the side that still has it. Arrays merge as one value.
- **The assistant's picture** (`cad_render_view`) is a software render: flat shading, no sketches or planes.
- **Bundles:** `mechanical.js` and `assembly.js` each bundle three.js and React (about 0.8 MB and 0.7 MB
  minified), loaded on demand. Sharing them with `viewer3d.js` and `ui.js` is not done.
- **Assembly** is a stub, as described above.
- **Narrow windows:** the part studio's docks do not collapse; it has not been laid out for phones.
