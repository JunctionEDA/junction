# Mechanical CAD: the contract

This is the document to read before adding anything to the mechanical or assembly domains. It says what the
formats and interfaces are, how to add a feature, a tool, a panel, a worker service or a mate without editing a
shared file, how the pieces built by different people fit together, and where each piece of future work belongs.

It is the one entry point. The parts with a README of their own are linked from here and not repeated:

| Part | README |
|---|---|
| Assemblies: instances, mates, the solver, sources | [`../assembly/README.md`](../assembly/README.md) |
| A board shown in a part studio (PCB → CAD) | [`board/README.md`](board/README.md) |
| A part studio driving a board (CAD → PCB), the part studio's half | [`boardlink/README.md`](boardlink/README.md) |
| … and the board editor's half | [`../pcb/mech/README.md`](../pcb/mech/README.md) |

Everything here is implemented and tested unless a line says otherwise. The limits are listed at the end; read
them before promising something to a user.

## The picture

```
project (Postgres: documents, snapshots, ops)
 ├─ *.kicad_sch, *.kicad_pcb      drawn by the electronics editor (web/domains/pcb)
 ├─ *.jpart   part studio         drawn by web/domains/mechanical   (static/dist/mechanical.js)
 ├─ *.jasm    assembly            drawn by web/domains/assembly     (static/dist/assembly.js)
 └─ models/*.step                 files an Import feature reads

page                                             worker (static/dist/cad-worker.js)
 document tabs (web/platform/doctabs)             OpenCascade (occ-kernel.wasm; compiled once per page,
 └─ PartStudio (ui/studio.ts)                       handed to every worker)
     ├─ ItemDocSession  ⇄ /ws ⇄ server             RegenEngine (kernel/regen.ts)
     ├─ KernelClient    ⇄ postMessage ⇄             ├─ features/*.ts  evaluate()
     ├─ ModelView on Viewport3D (three.js)          └─ services/*.ts  run()
     ├─ SketchEditor (sketch/editor.ts, PlaneGCS)
     └─ React: toolbar (by mode), docks, the feature's or sketch's dialog, view cube, status bar
```

A part studio is a list of features. The page holds the document and sends the feature list to the worker; the
worker runs each feature's `evaluate` in order on the kernel and sends back triangles, edge lines and names; the
page draws them. The page never touches the kernel and the worker never touches the document.

Three things cross between documents, and each has one place:

```
board (.kicad_pcb) ──read live──▶ Board feature in a part studio      board/        (BoardLink on the page, BoardFeed elsewhere)
part studio ──link item, solved──▶ the board's outline, holes, keep-outs   boardlink/ + pcb/mech/
part studio, board, assembly ──read live──▶ instances of an assembly   assembly/sources/
```

## Mechanical CAD is a setting

CAD is something each person turns on for themselves. It is a setting of the account (`users.cad_enabled`,
`migrations/0252_user_cad.sql`), **off by default**: `GET /api/me` says `cad`, `PUT /api/me/cad { enabled }`
changes it. The switch, "Mechanical CAD (part studios and assemblies)", is in the account menu on the projects
page (`platform/home/Home.tsx`) and in the editor's Junction menu (`shared/components/MenuBar.tsx`); it takes
effect at once, without a reload.

**The setting carries the project shell too.** Part studios and assemblies live in the shell (the Home tab, the tab
bar with "+", several PCBs and assemblies in one project, a PCB's BOM as a tab, who is on which tab), so the shell
comes with CAD. With CAD off, and for a signed-out visitor, Junction is the PCB design software alone, as it was
before CAD: a project opens straight into the schematic and board editor, with no tab bar and no Home tab.

Every caller asks `shared/cad.ts`: `cadEnabled()` (or `useApp(cadEnabled)` in a component), `setCadEnabled(on)`
(which dispatches `setCad`; `pcb/editor/cad-setting.ts` sends the request, updates the store's `me` and draws again
what is open: a CAD tab as its editor or its note, and with CAD off Home or a BOM tab gives way to the PCB). Which
kinds are CAD is the registry's `cad: true` (`isCadDocType`, `kindAvailable`). A new CAD kind is marked there and
nothing else changes. On the server, `persist::cad_enabled` is the same setting.

| With CAD off | Where |
|---|---|
| no tab bar: no Home tab, no "+", no tab manager, no project document joined, no room (presence by tab) | `doctabs/DocTabs.tsx` (`open` needs `cad`) |
| a project opens on its PCB's root schematic (or its board), and `?doc=` opens the sheet or board it names; `?doc=home` or a BOM tab opens what the project opens on; with no PCB at all the editor says "This project has no board or schematic yet" | `pcb/editor/doc.ts` (`shellOn`, `openPcbOnly`, `openDocId`, `setProjectDocs`) |
| a project with several PCBs (made by somebody with CAD on): the editor works on the one a link names, else the one this page worked on before, else the one at the root, else the first by folder, and a toast says how many there are; the others open by their links | `pcb/editor/doc.ts` (`plainPcb`) |
| the address names the document only when the PCB has more than one to open, or is in a folder; going back to a sheet fits it again (no remembered view) | `pcb/editor/doc.ts openDoc` |
| a blank project is a schematic and a board (a `.kicad_pro`, `.kicad_sch` and `.kicad_pcb` at the root); the new-project dialog says so | `server/src/http.rs blank_template`, `platform/home/UploadDialog.tsx` |
| the theme's default is the system's (light with CAD on); a person's own choice wins either way | `shared/theme.ts` (`followCadSetting`, the `kui.cad` hint the pages' first-paint scripts read) |
| opening a part studio or an assembly by a link (`/p/<project>/edit?doc=<id>`) shows a note, a button that turns CAD on and opens it, and one that opens the PCB instead; no bundle is loaded | `pcb/editor/dochost.ts` |
| Compare of a part studio says the same instead of loading its renderer | `review/renderers.ts` |
| on a board: no "Used in" button, no board-link badge or panel, no reconciler, no height check, no enclosure in the 3D viewer, and no part studio is read | `pcb/editor/cad-usage.ts`, `pcb/mech/sync.ts` (the badge, panel and enclosure follow its state) |
| the MCP endpoint lists no `cad_*` tool and refuses one called by name; its instructions, the `document` argument and `get_project`'s note say nothing of part studios or several PCBs | `server/src/mcp.rs` (`listed`, `def_for`, `cad_on`) |
| the public project page shows no picture of a part studio for a project without a board | `server/src/pages.rs project_page` |

With CAD on, Home's create buttons, "+" and the tab manager offer part studios and assemblies, and a dropped STEP
file becomes a part studio (`doctabs/actions.ts creatables(…, cad)`, `importFiles`); Home lists every document.

What does not change: **no document is hidden or refused**. The server takes CAD documents and further PCBs from
anybody (a collaborator with CAD on adds them to a shared project), keeps the project's own document and the tab
order with their places, and the electronics editor of a person with CAD off still keeps to one PCB of such a
project (`pcb/editor/pcbscope.ts`), so it never mixes two PCBs' files. The assistant's electronics tools do the same
for everybody (`pcb/mcp/host.ts scopeToPcb`; each answer names the PCB it worked on). A board driven by somebody's
part studio keeps its driven items exactly as they are stored for a person with CAD off: locked and grouped under
the part studio's name; their page writes nothing to them and releases nothing (a link is released only by a page
with CAD on, when it is really gone). They can still unlock a driven item by hand as any locked item; the next page
with CAD on puts it back.

A signed-out visitor has no account and so no CAD: a public project opens on its PCB, and its part studios show
the note.

Browser scripts that work with part studios or the shell turn CAD on for their users first:
`scripts/cad-setting.mjs` `setCad(BASE, jwt(uid, login))`, through the same request the switch sends.
`scripts/cad-setting-ui.mjs` is the setting itself, both ways; `e2e.mjs` and `home-ui.mjs` are the PCB app with it
off.

## Where things are

| Path (under `server/web/`) | What |
|---|---|
| `shared/itemdoc/itemdoc.ts` | JSON item documents: file format, item changes, order keys. Pure. |
| `shared/itemdoc/sync.ts` | `ItemDocSession`: a live document over the collaboration socket, with undo. |
| `shared/viewport3d/viewport3d.ts` | `Viewport3D`: canvas, camera, orbit/pan/zoom, standard views, theme colours. |
| `shared/viewport3d/look.ts`, `viewprefs.ts` | How every viewport looks (`viewport.look`): the studio light, the backdrop, contact shading and outline, the ground shadow, the halo round highlights, the part palette; and what one person chose of it. See "How the viewport looks". |
| `platform/documents/host.ts` | How the shell hands a document to a domain's editor. |
| `platform/doctabs/`, `platform/projecthome/` | The project shell: the tab bar, the Home tab, what a PCB is (`pcbs.ts`); `room.ts` is who is on which tab. See "Document tabs and the shell". |
| `platform/history/`, `platform/review/renderers.ts`, `platform/mcp/host.ts` | Version history, Compare, the assistant's tools: what a domain plugs into. |
| `domains/registry.ts` | Which document kinds exist, which bundle opens them, what a new one contains. |
| `domains/mechanical/core/` | Contracts: `feature.ts`, `tool.ts`, `geometry.ts`. |
| `domains/mechanical/document/` | The `.jpart` format (`format.ts`), every edit as item changes (`edits.ts`), the document's units (`units.ts`), the default planes' sizes (`plane-sizes.ts`), variables, materials, appearance, and **`inputs.ts`: a document as the worker's input**. |
| `domains/mechanical/sketch/` | The sketcher: format, the solver (PlaneGCS), tools, dimensions, painting, regions. |
| `domains/mechanical/kernel/` | Worker side: OpenCascade helpers (`occ.ts`, `ops/`), regeneration, tessellation, protocol, the page's client. |
| `domains/mechanical/features/` | **One file per feature type.** |
| `domains/mechanical/tools/` | **One file per toolbar tool.** |
| `domains/mechanical/panels/` | **One file per docked panel.** |
| `domains/mechanical/services/` | **One file per worker service.** |
| `domains/mechanical/viewport/` | Bodies, the default planes with their corner handles and the names painted on every plane (`planes.ts`), sketches, reference geometry, highlighting, picking and box selection. |
| `domains/mechanical/ui/` | The part studio controller (`studio.ts`) and its React frame: the toolbar and everything that can be started (`commands.ts`), the dialogs (`DialogShell`, `FeatureDialog`, `SketchDialog`; `fields.ts` is what a click means to a field), the feature list, the view cube, the status bar, the tool search and menus (`Overlays.tsx`; `search.ts` is how a tool is found), the docks (`panels.ts`), a person's preferences (`prefs.ts`), how an icon is drawn (`Glyph.tsx`). |
| `domains/mechanical/collab/` | Presence, Follow, two people in one feature, comments pinned to geometry. |
| `domains/mechanical/inspect/` | Measure, section view, mass properties, appearance and display modes. |
| `domains/mechanical/board/` | A board in a part studio: reading it live, its picture, its solids, `BoardFeed`. |
| `domains/mechanical/boardlink/` | The link item with which a part studio drives a board. |
| `domains/mechanical/history/`, `compare/`, `mcp/`, `thumbnail.ts` | The part studio's side of the platform's history, Compare, assistant tools and thumbnails. |
| `domains/mechanical/api.ts`, `api-ui.ts` | What other domains may import from this one (`api-ui.ts`: React pieces, the view cube, and the pieces of the chrome the assembly's toolbar is made of: `Glyph`, the tooltip, the tool search's matching, the marking menu's geometry, the rules of rebinding keys and `KeymapSheet`). |
| `domains/assembly/` | The assembly editor: see its README. |
| `domains/pcb/mech/` | The board editor's side of the board link. |
| `domains/pcb/exports/` | What the electronics domain offers the others (the board as geometry, as 3D pieces). |

Server: `server/src/itemdoc.rs` (the document types and the fold), `dockind.rs` (how each document type behaves
for history, merging, folding and thumbnails), `itemmerge.rs` (the three-way merge), `http.rs` (`doc_type_for`,
`allowed_file`, `doc_is_movable`, and `notify_docs`: the notice that a project's documents changed),
`compact.rs`, `pcm.rs` (serves the `.wasm`), `pages.rs` and `main.rs` (serve the bundles), `mcp.rs` (the
assistant's tool catalogue).

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
| A sketch tool, a constraint, a new entity kind | `mechanical/sketch/`, `mechanical/tools/sketch-*.ts` | tools (group `sketch`); the sketch format below |
| A feature | `mechanical/features/<type>.ts`; shared kernel code in `mechanical/kernel/ops/` | features (`toolbarSection`, `toolbarOrder`, `toolbarMenu`, `toolbarKeep`) |
| Something that lives as long as a studio is open (a link to another document, a presence layer) | a file a panel or tool imports, pushing onto `studioExtensions` (`ui/studio.ts`) | studio extensions |
| Data a feature needs that is not in the document | an input filter (`studio.inputFilters`), and the same data outside the page (see "Building a part studio outside its page") | `document/inputs.ts` |
| A measurement, a check, an export | `mechanical/services/`, `mechanical/tools/`, `mechanical/panels/` | services, tools, panels |
| A mate, an assembly tool, a kind of instance source | `assembly/mates/`, `assembly/tools/`, `assembly/sources/` | mates, assembly tools, the provider list in `sources/manager.ts` |
| New data in a `.jpart` (as variables, materials, appearance and board links are) | new item types (see "Unknown items"), in a new file under `mechanical/document/` or the folder that owns them | — |

### Shared files: do not edit without need

A change to one of these touches everybody. If you must change one, make the change additive (a new optional
field, a new method) and say so in your pull request.

- `shared/itemdoc/itemdoc.ts`, `shared/itemdoc/sync.ts` (and `journal.ts`, what a session's journal is) and their mirror `server/src/itemdoc.rs`
- `shared/viewport3d/viewport3d.ts`
- `platform/documents/host.ts`, `platform/doctabs/*`, `domains/registry.ts`, `shared/cad.ts`
- `mechanical/core/*`, `mechanical/kernel/{types,protocol,regen,occ,tessellate,worker,client,load,wasm}.ts`
- `mechanical/document/{format,edits,inputs}.ts`, `mechanical/sketch/{format,profiles,planar}.ts`
- `mechanical/ui/{studio.ts,PartStudioView.tsx,Toolbar.tsx,commands.ts,fields.ts,DialogShell.tsx,panels.ts,FeatureDialog.tsx,FeatureList.tsx}`,
  `mechanical/viewport/{modelview,planes}.ts`, `mechanical/document/units.ts`, `mechanical/api.ts`
- `assembly/core/*`, `assembly/document/format.ts`, `assembly/sources/types.ts`, `assembly/ui/assembly.ts`
- `scripts/gen-cad-registry.mjs`, `server/package.json` (the `build:cad` and `test` entries), `static/app.html`
- `web/domains/pcb/editor/{dochost,doc,home}.ts` (the shell's side of the tabs)

Likely needs, and where they go instead of an edit:

- *A new dialog field kind*: add a member to `ParamField` in `core/feature.ts` and a `case` in
  `ui/FeatureDialog.tsx`. Additive; coordinate if two people need one at once.
- *A new kernel helper*: a new file under `kernel/ops/`, taking the `Kernel` as an argument. Do not grow `occ.ts`.
- *A new pick kind in the viewport*: additive member of `Pick` in `viewport/modelview.ts`.
- *A feature that needs its own editor* (as Sketch has `openSketch` / `finishSketch`): tools in `tools/` drive
  it; if `studio.ts` lacks a method you need, add one rather than special-casing the feature inside existing ones.
- *A global for tests and the console*: `window.Junction<YourThing>`, a name nobody else has. Two slices once
  both took `JunctionBoardLink`; the page is one page for every tab. In use: `JunctionPartStudio`,
  `JunctionSketch`, `JunctionCadCollab`, `JunctionBoardLink` (a studio's boards), `JunctionBoardMech` (the board
  editor's link side), `JunctionAssembly`, `JunctionRoom`.

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

What the platform gives these documents:

| Works | How |
|---|---|
| Storage, roles (viewer / commenter / editor), share links | the existing `documents`, `ops`, `snapshots` tables and `access.rs` |
| Live co-editing, item by item, property by property | the existing `/ws` op path |
| Presence: who is here, pointers, views, selections, Follow | `mechanical/collab/` over `session.setPresence` / `peerList()`; see "Collaboration" |
| Comments pinned to a feature, a face, an edge or a vertex | the platform's comments (`/api/docs/{id}/comments`), anchored by geometry name; see "Collaboration" |
| Tabs appearing, renaming and going for everybody without a reload | the server's `docs` notice (below); who is on which tab is the project room (`platform/doctabs/room.ts`) |
| The stored file kept current | `compact.rs` folds the ops into a snapshot on the server (`itemdoc.rs`), with no client involved |
| Project archive, clone, GitHub sync | they read the folded file like any other; a pull with changes on both sides merges item by item (`itemmerge.rs`) |
| Create, rename, delete from the tabs | `POST /api/projects/{id}/docs`, `PATCH` / `DELETE /api/docs/{id}` |
| Version history, restore, looking at an earlier version | the History drawer (`platform/history`); the part studio's host is `mechanical/history` |
| Compare two versions | the Compare window with the domain's renderer (`platform/review/renderers.ts`, `mechanical/compare`) |
| Branches and merging, conflicts put to a choice | `versions.rs` with `itemmerge.rs`; the drawer's merge dialog |
| Thumbnails | `platform/documents/thumbnail.ts`, `mechanical/thumbnail.ts` (part studios) |
| MCP tools for an AI assistant | `mechanical/mcp` (part studios) |

| Does not work yet | |
|---|---|
| An earlier version of an assembly on screen, comparing assemblies, MCP tools and thumbnails for assemblies | the assembly editor has a History tool for versions and branches but no read-only view of another state, and registers no compare renderer; the server side is the same as for a part studio |

**The `docs` notice.** When a document of a project is created, renamed or deleted (`http.rs` `create_doc`,
`move_doc`, `delete_doc`), the server sends every open document of that project
`{ type: "docs", docId, projectId, n, change: "added" | "renamed" | "deleted", from, doc: { docId, path, docType },
by: { userId, login, name } }`. A page may hear it on several sockets (its editor's, the room's);
`platform/doctabs/roomapi.ts tellDocsChanged` hands each notice on once, as the window event the tabs listen
for. So a document made by anything (the tabs, an upload, an assistant) appears for everybody at once, and no
page polls.

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
  studio's and the assembly's are the `cad_` tools: see "The MCP tools (`mcp/`)" below. Edits are planned and
  validated in `mcp/model.ts` against each feature's `schema`, so a new feature type is editable by an assistant
  with no further work as long as its parameters are described by its schema. They are listed only to a person
  who has Mechanical CAD on (see "Mechanical CAD is a setting").
- **Interface state of a tool or panel**: `studio.setUi({ myKey: value })` keeps it in `getState().ui` and
  redraws the toolbar, so a tool's `active` can read it (the History button does).

### The part studio (`.jpart`, `document/format.ts`)

```ts
// one step of the history tree
{ id, type: "feature", featureType: "extrude", name: "Extrude 1", order: "V", suppressed?: true, params: {…},
  folder?: <folder id>, suppressIf?: "#depth < 10 mm" }
// a folder of the feature list (document/folders.ts)
{ id, type: "folder", name: "Mounting holes", parent?: <folder id>, suppressed?: true, suppressIf?: "…" }
// one item, id "studio"
{ id: "studio", type: "studio", units: "mm", angleUnits?: "deg", precision?: 3, rollback: <feature id> | null,
  planeSizes?: { top?: 120, front?: 80, right?: 60 } }
```

- The tree is the feature items sorted by `order`.
- `featureType` names a registered feature; `params` is that feature's own data, described by its schema.
- `rollback` is the first feature that is **not** built (the bar sits above it); `null` is the end. It is in the
  document, so it is shared and stored. A bar on a feature that no longer exists reads as the end.
- Lengths are millimetres and angles degrees, whatever the units say. `units` (mm, cm, m, in, ft), `angleUnits`
  (deg, rad) and `precision` (decimal places) say how the document is read and written: see "Units".
- `planeSizes` is the side (mm) of a default plane a person resized by dragging its corner
  (`document/plane-sizes.ts`: `planeSizesOf`, `setPlaneSize`). Each plane is its own path, so two people
  resizing two planes both win, and a resize is undone like any edit. A plane it does not name grows with the
  model.
- **Folders** (`document/folders.ts`). A folder has no place of its own: a feature names its innermost folder in
  `folder`, a folder its parent in `parent`, and the list draws a folder where its features are. **The build
  order is always the features' `order`**, so a reader that ignores folders builds the same model. The edits
  (`addToFolder`, `moveItems`, `moveToFolder`, `unpackFolder`, `deleteItems`, `renameItem`) keep a folder's
  features next to each other and remove a folder nothing is in any more; `edits.addFeature` and `moveFeature`
  put a feature into the folder its two neighbours share. When a folder's features are not together all the same
  (two people at once, a tool that knows no folders), `featureTree` shows the first run as the folder and the
  rest outside it, where they are built: nothing is reordered. Several rows move as one change (`moveItems`).
- **Suppression** is worked out in one place, `suppressionOf` (`document/folders.ts`), and applied by
  `studioInputs`, so the page, an assembly, Compare, History and the assistant's host all agree. A feature is
  not built when its own `suppressed` is set, when its `suppressIf` holds (dynamic suppression: a condition of
  `document/conditions.ts` — two expressions of `document/variables.ts` compared with `< <= > >= == !=`, joined
  with `&&`, `||`, `!` and brackets — evaluated with the document's variables), or when a folder around it is
  suppressed either way. A folder is suppressed as one thing: its features keep their own `suppressed`. A
  condition that cannot be read suppresses nothing and the list says why.
- Feature ids are UUIDs. A body's id is the id of the feature that made it (with a suffix when one feature
  made several), so body ids survive rebuilds.
- **What people say about the parts** is one item, `parts` (`document/part-items.ts`):

  ```ts
  { id: "parts", type: "parts",
    names: { "<entry id>": "Bracket" },                       // the name a person gave; absent: the kernel's
    props: { "<entry id>": { description?: "…", fields?: { "Vendor": "Acme" } } } }
  ```

  An entry id is a body's id, or `curve:<feature id>` for a curve of the parts list. Both maps are keyed by
  entry and a property's fields by their label, so two people naming or describing different parts at once both
  win. `renamePart`, `setPartProps` and `updatePart` (a name and properties in one change) return item changes;
  `partNamesOf`, `partPropsOf` read. **The kernel does not know these names**: a `BodyResult` carries the
  kernel's ("Part 1"). Whatever shows a studio's bodies by name passes a regeneration's bodies through
  `namedBodies(doc, bodies)` (exported from `api.ts`): the part studio's page does (`studio.getState().bodies`
  are named), an assembly's part source does, and an export sends the names along (`ExportSelection.names`).
  The assistant's host and Compare still show the kernel's names.

### The sketch (`sketch/format.ts`), stored in a sketch feature's `params`

```ts
params: {
  plane: { kind: "plane", plane: "top" | "front" | "right" } | { kind: "face", ref: GeomRef } | { kind: "datum", feature },
  sketch: {
    version: 1,
    entities: {                                  // a map, keyed by short ids
      p1: { type: "point", x: 0, y: 0 },         // sketch-plane coordinates, mm
      l1: { type: "line", a: "p1", b: "p2" },    // curves refer to points by id
      c1: { type: "circle", center: "p3", r: 5 },
      a1: { type: "arc", center: "p3", start: "p4", end: "p5" },   // counter-clockwise from start to end
    },
    constraints: {                               // a map
      k1: { type: "horizontal", refs: [{ entity: "l1" }] },
      d1: { type: "distance", refs: [{ entity: "l1", at: "start" }, { entity: "l1", at: "end" }], value: 40,
            driving: true, expr: "width", label: { x: 20, y: -5 } },
    },
  },
}
```

Rules that are fixed:

- **Points are entities and curves refer to them by id.** Two curves that share a point id are joined there. A
  rectangle is four points and four lines.
- **The document always stores solved coordinates.** The sketcher solves every edit before committing it (the
  solver is PlaneGCS compiled to WebAssembly, embedded in the page's bundle; `sketch/solver`) and writes the
  resulting positions and radii into the entities; the kernel builds geometry from the entities alone and never
  solves. A reader that does not know a constraint type keeps it and ignores it.
- A dimension is a constraint with a `value` (mm, or degrees for an angle). `driving: false` is a reference
  dimension. `expr` is the text it was typed as (`sketch/expr.ts`: arithmetic, units, variables). `label` is
  where its text sits.
- `construction: true` on an entity keeps it out of profiles. `from: GeomRef` on an entity says which edge of
  the model it was projected from (Use edge).
- Constraint type names: `coincident`, `horizontal`, `vertical`, `parallel`, `perpendicular`, `tangent`,
  `equal`, `midpoint`, `concentric`, `collinear`, `symmetric`, `fix`, `normal`, `curvature`, `pierce`,
  `distance`, `radius`, `diameter`, `angle`. `sketch/refs.ts` says what their references mean; `pierce` also
  stores the place (`x`, `y`) and the model edge (`from`) it was worked out from, like Use edge a copy.
- A sketch edit is one `MODIFIED` change on the feature item with one prop per entity or constraint that
  changed (`sketch/model.ts` `Draft`; the editor's `edit((draft) => …)` is the one way a tool changes a sketch).
- The free-form curves are `ellipse`, `ellipticalArc`, `spline` (through points, optional end handles),
  `bspline` (control points; a Bézier curve when degree = poles − 1), `conic` and `text` (outlines in a font,
  `scripts/gen-sketch-font.mjs`); `image` is a reference picture with no geometry. `sketch/curves.ts` turns each
  into NURBS pieces that drawing, regions (`sketch/planar.ts`), the solver (PlaneGCS holds ellipses; a
  spline's points are its unknowns) and the kernel (`kernel/ops/sketch-curves.ts`, one edge per knot span)
  all share. A new kind is a new `type`: `sketch/refs.ts pointsOf/mapPoints`, `sketch/curves.ts` and the
  solver's translation are the places that must learn it.

Sketch planes: `top` is XY (normal +Z), `front` is XZ (normal −Y), `right` is YZ (normal +X). The ids are
stored; never rename them. On a face, the frame comes from `Kernel.faceFrame`: the normal points out of the
solid, x is the surface's own first direction, and the origin is the point of the plane nearest the world origin.

**Regions** (`sketch/planar.ts`, with `sketch/profiles.ts` for the types): the closed regions of the planar
arrangement of the sketch's curves, so curves may cross: two overlapping circles enclose three regions, a line
across a rectangle splits it. A region's id is made from the curves on its boundary; treat it as opaque. A
`profile` parameter is `{ sketch, regions: null | string[] }`: `null` is every region. In a dialog, the first
click on a sketch takes all of it; clicks inside its regions then choose among them (from "all", a click leaves
just that region, further clicks add and take away, "All" puts every region back).

**A face as a profile** (`features/_profile.ts` for the stored shape, `kernel/ops/profile.ts` for the kernel
side). A `profile` field that says `faces: true` also takes flat faces of the bodies already there, as Onshape's
Extrude does: the value gains `faces: GeomRef[]` (ordinary face references, so the feature survives edits
upstream), and `sketch` is `null` when there are only faces. A value with a sketch alone is stored exactly as
before. Extrude, Revolve and Sweep take faces; the other features with a `profile` field are a sketch's alone.
`resolveProfile(ctx, params.profile, "extrude")` gives a feature its regions whatever they came from: each is a
`SketchRegion` with the `frame` of its plane, so a feature loops over regions and never asks which kind it has.

- A face is one region, holes and all. Its frame is `Kernel.faceFrame`: the normal points out of the solid.
- **Direction.** A sketch region goes along the sketch's normal. A face goes out of its solid for New and Add
  and into it for Remove and Intersect, so a face picked with Remove cuts without flipping anything;
  "Opposite direction" turns either round. Revolve by an angle starts the same way.
- Several faces, and a sketch with faces, may be in one feature; each region goes along its own normal.
- Revolve: a face has no sketch line, so the axis is Picked (an edge of the face itself will do) or the X or Y
  of the face's plane. With Surface, the edges round the face are what is swept.
- **In the dialog**: while the profile listens the viewport offers sketches and faces; a click on a face adds
  it, a click on one it holds takes it out, and a face that is not flat is refused with a toast. Faces selected
  before the tool is started (Shift+E) are the profile. The sketch a new feature only guessed (the newest one
  nothing uses) gives way to the first face clicked; a sketch the person chose stays and the face joins it.
  While such a dialog is open a sketch lying on a face is picked before the face under it
  (`view.sketchFirst`), so regions drawn on a face can still be chosen.
- A face that is gone fails with "no longer exists", a curved one with "must be flat".

**The sketcher** (`sketch/editor.ts`, one `SketchEditor` per studio, `window.JunctionSketch` while a sketch is
open) owns the pointer and the keys while a sketch is open and draws the sketch itself on a 2D canvas over the
viewport. Its tools are the toolbar while a sketch is open (see "The toolbar"); the sketch has a dialog of its
own (`ui/SketchDialog.tsx`: the plane, which can be changed; ✓ and ✗); the Sketch panel in the right dock lists
the dimensions and constraints; the status bar says how the sketch stands. Esc and a right click put a tool
down, Esc again clears the selection; neither ever leaves the sketch. ✓ (Finish sketch) keeps it; ✗ (Cancel
sketch) puts it back as it was when it was opened, and takes a sketch made by that visit away again, as one
undoable step (`studio.cancelSketch`).

- **Starting one.** Sketch with a plane or a flat face selected starts drawing at once. With nothing selected
  **no plane is chosen for the person**: the sketch's dialog opens with its plane field empty and listening
  ("Select a plane or planar face") and waits. Nothing is in the document yet (`studio.getState().editing` holds
  the draft with `params.plane: null`; `awaitsPlane(state)` in `ui/studio.ts` says so), the toolbar shows the
  sketch tools greyed, and ✓ and Enter do nothing. A click on a plane or a flat face in the model, or on a
  plane's row in the feature list, fills the field and drawing starts; Esc or ✗ makes no sketch.
- **The plane field** (`ui/SketchDialog.tsx`) shows the plane with a × beside it. A click on it makes it listen
  for another plane; × empties it and it waits (the sketch stays where it is until a plane is clicked; Esc
  leaves it there).
- **The view.** Opening a sketch turns the view to face its plane when the person likes it so (a preference,
  `ui/prefs.ts sketchNormal`, in the sketch's dialog; N does it at any time), and finishing turns it back to
  where it was.
- **Features from inside a sketch.** Extrude and Revolve are in the sketch toolbar, and Shift+E / Shift+W work in
  a sketch: the feature takes that sketch (`studio.startFeature` finishes the sketch and uses it as the profile).

- Drawing tools (`sketch/shapes.ts` and `sketch/curve-shapes.ts`, engine `sketch/draw.ts`): line, rectangle,
  centre rectangle, aligned rectangle, circle, 3-point circle, three kinds of arc, inscribed and circumscribed
  polygon, ellipse, partial ellipse, conic, spline, control point spline, Bézier curve, slot, point; text and
  image (`sketch/insert.ts`); inference while drawing (`sketch/infer.ts`); a measure typed while drawing becomes
  a dimension.
- Arrange (`sketch/arrange.ts`): linear pattern, circular pattern and transform (translate, rotate, copy) of a
  selection; a copy keeps the constraints wholly inside it.
- Modify (`sketch/ops.ts`): fillet, trim, extend, split, offset, mirror, construction, **Intersection** (the
  `sketch-intersect` service: the curves where the sketch plane cuts a face or a part, pinned), and **Use edge**
  (`sketch/modify.ts`, the `sketch-project` service): an edge or a corner of the model drawn in the sketch,
  projected onto its plane and fixed there. Any edge of the model as it is at that point of the tree can be
  used, including a Board feature's outline and hole rims when the Board feature comes before the sketch (its
  solids are hidden under the board's picture but are there for the pointer).
- Constraints (`sketch/constrain.ts`) and dimensions (`sketch/dimension.ts`): select then press, or press then
  click. The status line says under-constrained with the freedoms left, fully constrained, or names what
  conflicts.

## Features

## Features

### The registry API (`core/feature.ts`)

```ts
export interface FeatureDefinition<P> {
  type: string;                 // stable id, stored as featureType: never rename
  title: string;                // "Extrude"; new features are named "Extrude 1", …
  icon?: string;                // inline SVG markup in a 24×24 box, currentColor (see "Icons" below)
  defaults(): P;                // parameters of a new feature (a fresh object each call)
  schema: ParamField[];         // the dialog's fields, in order
  evaluate(ctx: EvalContext, params: P): void | Promise<void>;   // runs in the worker
  toolbar?: boolean;            // false: no toolbar button
  toolbarOrder?: number;
  toolbarSection?: "sketch" | "solid" | "modify" | "combine" | "pattern" | "surface" | "reference" | "board";   // which part of the toolbar ("solid")
  toolbarMenu?: string;         // variants of one thing share one button and its caret ("Pattern")
  toolbarKeep?: number;         // how long it stays on the bar in a narrow window (50; 0: always under More)
}
```

`ParamField` is `{ key, label, hint?, visible?(params) }` plus one of:

| `kind` | Stores | Dialog |
|---|---|---|
| `number` (`unit`, `min`, `max`, `step`) | a number (mm, degrees) | a number field showing the document's unit; takes a unit typed with the number, expressions and variables; ↑ ↓ and dragging the label step it |
| `boolean` | a boolean | a checkbox |
| `text` | a string | a text field |
| `enum` (`options`) | a string | a segmented control, or a select above four options |
| `profile` (`faces?`) | `{ sketch: <feature id> \| null, regions: null \| string[], faces?: GeomRef[] }` | a list of earlier sketches; click one in the viewport, then its regions to choose among them. With `faces: true` (Extrude, Revolve, Sweep) flat faces of parts too, alone or beside the sketch, listed under it each with a × |
| `plane` | a `PlaneRef` | Top / Front / Right (buttons, their rows in the feature list, or the planes in the model), or click a planar face or a reference plane |
| `refs` (`of: GeomKind[]`, `single?`, `datums?`, `planes?`, `sketch?`) | `GeomRef[]` (or one); a `RefTarget` (`features/_refs.ts`) for a default plane, reference geometry or a sketch curve | a list that listens: click faces, edges or vertices in the viewport to add, again to take out; with the options, reference geometry, the default planes (also buttons) and sketch curves |
| `features` (`types?`, `exclude?`) | `string[]` of earlier feature ids, in the order picked | a list of the earlier features |
| `bodies` | `string[]` of body ids; empty means every body | click a body |
| `document` (`docTypes`) | another document's id | a list of the project's documents of those types |

A number field accepts an expression (see "Variables") and units (see "Units").

**How a field that takes geometry behaves** (`ui/fields.ts`, pure and tested by `cad-fields.test.js`;
`studio.ts` applies it). While a field listens (it is outlined; `editing.field`), the viewport's filter is the
kinds it takes, the pre-highlight is exactly what a click will take, and
- a click adds; a click on something the field holds takes it out; a click on nothing changes nothing;
- a selection box adds only; × takes one thing out, Clear all;
- a field that holds one thing is replaced by the click, and the next empty field then listens;
- what was selected before the tool was started fills the first fields that take it, each pick once;
- Tab goes round the fields that take geometry; Esc puts the listening field down, then cancels; Enter accepts;
- a click in the model while no field listens goes to the first field that takes it (never to a selection the
  dialog cannot use).

What the fields hold stays highlighted while the dialog is open (`view.setMarks`): the listening field's as a
selection, the others' quieter. A feature consumes what it is given (a filleted edge is not an edge of the
preview), so the page asks the worker what such a pick looked like before the feature (the `ref-geometry`
service) and keeps drawing it; a click on it takes it out. The dialog's frame is `ui/DialogShell.tsx`: it is
dragged by its title, folds to it, and the next dialog opens where the last was left; ✓ and ✗ are at the right
of the title for every dialog. Editing a feature that is not the last, **Final** shows the model with the later
features built (`studio.setFinal`).

A feature file is bundled into both the page and the worker. **It must not touch the DOM, three.js or React at
module level**, and `evaluate` must use only its context.

### `EvalContext` (`kernel/types.ts`)

```ts
ctx.oc                         // the raw OpenCascade bindings (typed: OpenCascadeInstance)
ctx.k                          // helpers: sub(), list(), prism(), boolean(), carryNames(), faceFrame(), volume(), …
ctx.feature                    // { id, type, name }
ctx.bodies(), ctx.body(id)     // bodies() leaves out reference bodies (a Board feature's board) and surfaces; body(id) finds any
ctx.allBodies()
ctx.addBody(shape, names, { suffix?, name?, reference? })   // names: (face, index) => string | null
ctx.datum(id), ctx.setDatum(d) // reference planes, axes, points, curves
ctx.history(id)                // the model just before and just after an earlier feature (patterns, mirror)
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
  icon: '<path class="f" d="M4 20v-8a8 8 0 0 1 8-8h8v16z"/><path d="M4 20v-8a8 8 0 0 1 8-8h8M4 20h16V4"/>',
  toolbarOrder: 30, toolbarSection: "modify", toolbarKeep: 94,
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
- A body may be a **reference body** (`Body.reference`, `BodyResult.reference`): there to be referred to and
  drawn, not a part. Features that act on "every body" leave it alone, mass properties leave it out by default,
  the Parts panel marks it, and the board editor's enclosure does not draw it.

- A body may be a **surface** (`Body.sheet`, `BodyResult.sheet`): a body with no solid in it, one face or faces
  sewn into a sheet. The engine sets the flag from the shape each time a body is added or replaced; a feature
  never sets it. `ctx.bodies()` leaves surfaces out, so Add, Remove and "every body" act on parts only; a
  feature that is given a surface finds it with `ctx.body(id)`. The Parts panel lists surfaces after the parts
  under "Surfaces" and names them Surface 1, 2, …; they are drawn, picked, hidden, transformed, deleted and
  exported (STEP as shells) like parts, and their volume is zero. Extrude, Revolve, Sweep and Loft make them
  with **Creates: Surface** (`bodyType`, `kernel/ops/surface-sweeps.ts`), from a sketch's curves, open or
  closed. The surface features (`toolbarSection: "surface"`: Offset surface, Boundary surface, Fill, Move
  boundary, Ruled surface, Mutual trim, Constrained surface) share `kernel/ops/surface.ts` and one button, Surface ▾. A feature may give
  its own tooltip line and search words (`hint`, `keywords`) instead of adding to `ui/commands.ts` and
  `ui/search.ts`.

### Building a part studio outside its page (`document/inputs.ts`)

A part studio is built in many places besides its own tab: an assembly drawing an instance, Compare, the
history view, the assistant's host, the board editor's enclosure, the interference check. **All of them turn the
document into the worker's input with one function**, so they all build the same model:

```ts
import { studioInputs, BoardFeed } from "mechanical/api";
const feed = new BoardFeed({ signedIn, changed: () => rebuild() });       // only if the studio may hold a Board feature
const { features, rollback } = studioInputs(doc, { filters: [feed.filter] });
const result = await kernel.regenerate(features, rollback);
```

`studioInputs` takes the features in order, replaces numbers typed as expressions by their values under the
document's variables (`document/variables.ts resolveInputs`), then runs the input filters. A filter supplies
what a feature needs that is not in the document. There is one today: a Board feature's board (`$board`),
which is read live from the board document and never stored. On the studio's own page the filter is
`board/link.ts` (which also draws the board); everywhere else it is `board/feed.ts` `BoardFeed`, which opens the
boards it meets on the collaboration socket, read-only, and calls `changed` when a board arrives or an edit of
it changes what a feature is built from. A caller that builds once awaits `feed.settled()` first.

| Who builds a part studio | Where | How |
|---|---|---|
| Its own page | `ui/studio.ts regen` | `studioInputs` with `studio.inputFilters` (the dialog's draft laid over the features) |
| An assembly instance of a part | `assembly/sources/part.ts` | `studioInputs` + a `BoardFeed` per studio; rebuilt when the studio or its boards change |
| The interference check, the bill of materials | `assembly/services/interference-sources.ts` | nothing of its own: the editor's handles and workers (`handle.ensureKernel()`) |
| Compare | `compare/index.tsx` | `studioInputs` + a `BoardFeed` per side, awaited |
| An earlier version on screen | `studio.showPast(doc)` | the page's own path |
| The assistant | `mcp/host.ts` | `studioInputs` + a `BoardFeed` on the host's socket |
| The board editor's 3D enclosure | `pcb/mech/enclosure.ts` | `studioInputs` + a `BoardFeed`; reference bodies are not drawn |
| Thumbnails, exports | the page | the page's own model |

A board is not part of a version: an earlier version of a part studio is built with the board as it is now.

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
| Made from a face used as a profile | as from a sketch region, with `faceRegionId(ref)` (`face.<hash of body and name>`) for the region id and `faceEdgeId(<edge name>)` (`edge.<hash>`) for the sketch entity (`features/_profile.ts`): `<feature id>:end:face.1x2y3z`, `<feature id>:side:edge.4a5b6c` |
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
page → worker   { t: "init", wasmUrl, module? }      // module: the kernel as the page compiled it
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
Nothing is loaded until the first regeneration: opening a board never fetches the kernel. The kernel's module
is compiled once per page (`kernel/wasm.ts`, retried when a download is cut short) and handed to every worker
the page starts, so an assembly's second and third worker do not download or compile 23 MB again.

**Meshes** (`kernel/tessellate.ts qualityFor`). A body is meshed for the screen with a chord tolerance of half a
thousandth of its diagonal (between 0.01 and 0.5 mm) and an angular tolerance of 0.3 rad, loosened to 0.5 on a
body of more than 150 faces and 0.8 on one of more than 300. The angle is what decides how many segments a
small hole or fillet gets, and the mesher's time grows faster than the number of points on a face's
boundaries: a 200 mm plate with 400 holes took 4.0 s to mesh at the former fixed 0.05 mm / 0.3 rad and 0.6 s
now (the whole rebuild 5.8 s → 1.8 s; measured in node). Exports mesh at their own resolution.

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

`ctx.state` is the model the page is showing (after the last regeneration). The result is JSON, and may hold
typed arrays (an exported file): they are transferred (`kernel/ops/exchange-export.ts transferables`).

`ctx.before(featureId)` is the model just before a feature was built (null when it is not built; present only
in the page's own worker).

Services today: `mass-properties`, `measure-entities`, `measure-clearance`, `interference` and `clearance`
(shapes sent as BRep text, for the assembly), `body-brep`, `export-step`, `export-mesh`, `export-outline`,
`export-convert`, `sketch-project`, `compare-versions`, `board-placement`, `boardlink-solve`, `ref-geometry`
(what named faces, edges and vertices looked like before a feature consumed them).

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

### The frame (`ui/PartStudioView.tsx`)

```
the toolbar            the tools of the mode the studio is in
left dock │ viewport │ right dock      over the viewport: the dialog of the feature or sketch being edited (top left,
                                       movable), the view cube (top right), the measure readout (bottom right)
the status bar         kernel and hints · how the open sketch stands · what a click picks · the units · ?
```

### The toolbar (`ui/Toolbar.tsx`, `ui/commands.ts`)

Drawn from the registries; nothing is listed by hand. It shows the tools of the **mode** and nothing else
(`data-mode` on `.cad-toolbar`), in the order an Onshape user's hands know, the most used first:

```
model    undo redo │ Sketch │ Extrude Revolve Sweep Loft Thicken Enclose │ Fillet▾ Chamfer Draft Rib Shell Hole │ Boolean Split Transform▾ Wrap Composite part │ Direct edit▾ │ Pattern▾ Mirror │ Surface▾ │ Plane▾ Curve▾ Mate connector Variable │ Frames▾ │ Sheet metal▾ │ Board▾ │ Measure Section │ History │ More▾   [Search tools… S]
sketch   undo redo │ Line Rectangle▾ Circle Arc▾ Slot Point Construction │ Sketch fillet Offset Use edge Mirror Trim Extend │ the twelve constraints │ Dimension │ Extrude Revolve │ More▾   [Search tools… S]  ✓ Finish sketch  ✗
dialog   <icon> <name>  <what the listening field wants> │ More▾                                              [Search tools… S]  ✓  ✗
view     (no edit rights) Measure Section │ History │ More▾                                                    [Search tools… S]
```

- **One button is one tool, drawn as its icon** (22 px; only Sketch carries its name). A **feature** says which
  section it is in (`toolbarSection`: sketch │ solid │ modify │ combine │ pattern │ surface │ reference │ board; "solid"
  when absent) and where in it (`toolbarOrder`).
- **A tool with variants is one button and a caret** (`toolbarMenu`, a tool's `menu`): Transform ▾ holds
  Transform and Delete body; Pattern ▾ Linear and Circular pattern; Surface ▾ Offset surface,
  Boundary surface, Fill, Move boundary, Ruled surface, Mutual trim and Constrained surface; Reference ▾ Plane, Axis, Point and Helix;
  Board ▾ Board, Opening and Standoffs; in a sketch Rectangle ▾ and Arc ▾. The face runs the variant used last
  (kept in the browser, `ui/prefs.ts`), the caret opens the list. A family of one is a plain button. Things
  that are not variants of each other (Fillet, Chamfer, Draft; Sweep, Loft; Boolean, Split) have a button each.
  In the DOM the face is `[data-tool][data-variant]`, the caret `[data-menu][data-items]`, the open list
  `.cad-tb-menu[data-menu-of]`.
- **A specialist section is one button and a caret**, as Onshape groups them (`commands.ts GROUPS`): Direct edit ▾
  (Modify fillet, Delete face, Move face, Replace face), Surface ▾, Frames ▾ (Frame, Trim, Gusset, End cap, Cut
  list) and Sheet metal ▾ (every sheet metal feature and Flat pattern, its families — Make joint, Corner — kept
  together between rules in the drop-down). Its face runs the tool used last, like a family's. A feature only says
  its `toolbarSection`; the section decides. A family keeps its own `toolbarMenu` (the joints, the corners), which
  matters where the section is not grouped. Curve ▾ (in Reference) is a family of eight and works the same way.
- A **tool** (`core/tool.ts`) names its group (`edit`, `sketch`, `feature`, `inspect`, `view`, `file`). Tools in
  `sketch` are the sketch toolbar, in the parts their `order` puts them in (draw below 100, modify below 200,
  constraints below 300, dimension from 300). A tool with `button: false` has no button (Select, Hide, Isolate)
  but is in the tool search.
- **The bar never scrolls and never crams; what does not fit is under "More ▾"** at the end of the tools
  (`[data-menu=More]`, with `data-items` and, beside it, each item's group in `data-item-groups`). Every button
  says how long it keeps its place (`toolbarKeep` on a feature, `keep` on a tool; 50 when absent, 100 never
  leaves): when the window is too narrow, the buttons with the lowest number go under More first, and come
  back when there is room. The tools a part is mostly made with keep their buttons longest (Sketch, Extrude,
  Revolve, Fillet … 75 and up, Measure 80, Section 79, History 77), then Transform, Draft and Split, then the
  grouped sections and Curve ▾ alike (`GROUP_KEEP`, 55; Board 60), then the single specialist buttons (Thicken,
  Enclose, Rib, Wrap, Composite part, Mate connector, Variable). So at 1500 px the bar has everything but those
  single specialist buttons (they are under More), every group button included, and at 1920 px everything; the
  search field narrows below 1700 px before a tool leaves. `keep: 0` is always under More: the `view` group (Planes, Display, Perspective —
  the view cube's menu has them too), the `file` group unless a tool gives itself a `keep` (History does: its
  button shows that its drawer is open; Import and Export do not), Comment and Delete. At
  1100 px the part studio keeps Sketch, Extrude, Revolve, Sweep, Loft, Fillet ▾, Chamfer, Shell, Hole, Boolean,
  Transform ▾, Pattern ▾, Mirror, Plane ▾, Measure, Section and History on the bar; a sketch keeps the draw and modify tools,
  Coincident, Horizontal, Vertical and Dimension. More lists what it holds under the sections' names.
- **The tool search** is a field at the right end of the bar (`[data-tool-search]`, showing its key): a click
  opens the search in the field's place; **S** opens it at the pointer, **Ctrl/Cmd+K** in the middle
  (`ui/Overlays.tsx CommandPalette`). It lists everything `commands.ts allCommands` returns for the mode — in a
  sketch the sketch tools first — and finds a tool by its name, by a word of its name, by its initials, or by
  **another word for it** (`ui/search.ts KEYWORDS`: "round" finds Fillet, "bevel" Chamfer, "hollow" Shell).
  A feature whose `operation` field offers results is also listed once per result ("Extrude: remove"), found
  by what people call it ("cut", "pocket", "boss": `RESULT_WORDS`). ↑ ↓ choose, Enter runs. Add the words for a
  new tool or feature to `KEYWORDS` under its id (`f:<type>` for a feature). The feature list has a box of its
  own, which filters the features already made. **?** opens the sheet of keys, read from the same registries.
- **Every button has a tooltip** with its name, its key and one line on what it does (`ui/Tip.tsx`; a tool's
  `hint`, a feature's line in `commands.ts FEATURE_HINTS`); it opens after a fifth of a second, and at once
  when moving along the bar. Buttons carry no `title`.
- In a script, click a button with `scripts/cad-chrome.mjs` `tool(page, "Chamfer")`, which opens the drop-down
  or More when the button is in one; `toolTitles(page)` lists everything the bar offers.

**Icons** (`ui/Glyph.tsx`). A feature's or tool's `icon` is SVG markup in a 24×24 box, drawn in the colour of
the text around it, so it is right in both themes. They are Junction's own drawings, made to be told apart at
20 to 24 px: outlines 1.75 wide with round ends; a shape with class `f` is filled with a tint of the same
colour (the body of a solid, the face a tool acts on), `s` is solid (a point, the thing a tool adds), `d` is
dashed (what was there before, an axis, construction), `t` is a thin outline (the second thing in an icon).
The feature list shows the same icon as the toolbar. A new icon needs a silhouette no other has; look at it at
22 px in both themes beside its neighbours before committing it.

```ts
export default defineTool({
  id: "measure", title: "Measure", hint: "Click two things", icon: "<path …/>",
  group: "inspect", order: 10, key: "m",
  disabled: (studio) => (studio.getState().bodies.length ? null : "Nothing to measure"),
  active: (studio) => false,
  run: (studio) => { … },
});
```

**Keys.** A person can give any tool or feature another key, or none (`ui/keymap.ts`; see "What people miss in
browser CAD"): what follows are the defaults. `key` runs the tool wherever the keyboard is in the part studio except in a field being typed into
(`studio.ts onKey`, `onKeyElsewhere`). While a sketch is open the sketcher gets every key first and looks only
among the `sketch` tools, so a letter may mean one thing in a sketch and another outside it. Taken today:

| | Outside a sketch | In a sketch |
|---|---|---|
| M | Measure | Mirror |
| Q | Press/Pull | Construction |
| X | Section view | Extend |
| H / I | Hide / Isolate the selected parts | Horizontal / Coincident |
| F / Z | Zoom to fit / to the selection | Sketch fillet / — |
| W, P, N, S, ? | Display mode, planes on and off, view normal to, tool search, the sheet of keys | the same |
| Shift+1 … 7 | Front, back, left, right, top, bottom, isometric | the same |
| ← ↑ → ↓ | Turn the view 15° (Shift: 90°) | the same |
| Ctrl/Cmd + ← → | Roll the view 15° about the line of sight (Shift: 90°) | the same |
| Shift+S E W F C H P | Sketch, Extrude, Revolve, Fillet, Chamfer, Hole, Plane (`studio.ts FEATURE_KEYS`) | the same, but Sketch; Extrude and Revolve take the open sketch |
| L R C A, Q, T O U, V B E D | — | Line, Rectangle, Circle, Arc; Construction; Trim, Offset, Use edge; Vertical, Parallel, Equal, Dimension |
| Del, Esc, Enter, Tab, F2, Ctrl+Z / Y, Ctrl+K | delete the selected features; step back (field → dialog → selection); accept the dialog; the next field; rename; undo / redo; tool search | delete; put the tool down, then clear the selection; accept a typed value; —; —; undo / redo; tool search |

The view keys (arrows, Ctrl/Cmd + ← →, Shift + 1 … 7) are Onshape's and live in `ui/viewkeys.ts` (`viewKey`, and
`VIEW_KEYS` for the sheet of keys), which the assembly takes too (`api.ts`); they are not taken while a text field,
a menu or a slider has the keyboard. Do not give a tool outside the `sketch` group a letter another such tool has (`static/tests/mechanical-doc.test.js`
checks it), nor one of the letters `studio.ts` takes itself (F, Z, N, S). The assembly's keys are its own
(I Insert, F Fix, E Explode), with the view keys above.

A tool that takes over the pointer sets `studio.view.pointerTool = { down, move, up }` and `studio.keyHandler`,
and draws its rubber band with `studio.view.setOverlay(segments, dots)`.

### Panels and docks (`core/tool.ts`, `ui/panels.ts`)

```ts
export default definePanel({
  id: "mass-properties", title: "Mass properties", side: "right", order: 20,
  open: false,                                       // or (studio) => boolean; open when absent
  count: (studio) => 3,                              // a number beside the title (null: none)
  visible: (studio) => true,                         // in its dock only while this holds
  render: (studio) => <MassProperties studio={studio} />,
});
```

A panel is a React component that reads the studio with `useStudio(studio, (s) => s.bodies)` (`ui/hooks.ts`).
`side: "overlay"` is drawn over the viewport with no frame (the measure readout, the section controls).

- **Every panel folds** by its header, and each dock folds to a rail; what a person chose is remembered in the
  browser. A panel the person has not touched follows `open`: the Board panel unfolds when the part studio has a
  Board feature or a link. `showPanel(id)` (`ui/panels.ts`) unfolds a panel from a tool (Comment does).
- **A folded panel stays mounted**: some panels keep a part of the studio alive (the Collaborators panel the
  collaboration layer, the Sketch panel the sketch editor). A panel whose content costs something to keep
  current asks `usePanelOpen(studio, id)` and does nothing while folded (mass properties does).
- Left dock: Features (not while the timeline stands in for it), Parts. Right dock: Sketch (while a sketch is
  open), Variables, Mass properties (folded), Appearance (folded), Appearance library (folded), Board (unfolds
  itself), Collaborators, History of edits (folded), Comments (folded). Over the viewport: the offline banner.
- **The feature list** (`ui/FeatureList.tsx`, with `ui/featurelist/`: `Chrome.tsx` the header, banner and
  dialogs, `model.ts` what is worked out from the studio, `filter.ts` the search, `DockSeparator.tsx` the bar
  under it). It follows Onshape's "Features and Parts Lists":
  - **Top.** The search box filters by a piece of a name or a type, and by a command (`:part :type :name
    :errors :warnings :folder :variable :suppressed :hidden :shown`; the filter button lists them, a half-typed
    one completes with Tab). The text is `getState().ui.featureFilter`; **the parts list filters by the same
    box**: `listFilter(studio)` / `useListFilter(studio)` (`featurelist/model.ts`) answer `{ active, features,
    bodies, folders }` (sets of ids), `setListFilter(studio, text)` types into it. Under the box: the number of
    features, the number that failed (a click filters to them), New folder, Pause regeneration, Regeneration times.
  - **Rows.** The **default geometry** (Origin, Top, Front, Right: rows that select and hide like any other, and
    that a listening plane field takes a click on), then the features in build order, in their folders. Ctrl and
    Shift select several rows (features and folders: `selectedFeatures` holds both kinds of id); F2 or a second
    slow click renames; the eye hides and shows a plane, a sketch or reference geometry (`studio.setVisible`:
    this person's view, kept in the browser per document, never in the document). The pointer over a row lights
    up what the feature made, the pointer over the model marks the row that made the face, and **what is
    selected in the model marks the rows of every feature behind it** (`data-cross`; `crossFeatures`). While a
    dialog's field listens, a click on a sketch's or a reference plane's row fills it. A row, or every selected
    row, is dragged to another place (between rows, or onto a folder to go inside), one undoable change. A failed
    feature's mark shows its message and a click looks at it; a sketch that is not fully defined has a blue dot
    that says how many degrees of freedom are left (the sketch solver, asked in idle moments).
  - **The rollback bar** is always there: drag it, or select it and press ↑ ↓ (Home, End); "Roll to here" on a
    feature or a folder, "Roll to end" on the bar's own menu. `studio.rollTo(featureId | null)` is what they
    call: an edit of the document for someone who can edit; for someone who cannot, **a bar of their own**
    (`getState().ownRollback`, until `studio.followRollback()`). A folder the bar is inside is drawn open.
  - **The menu** of a feature: Edit, Rename, Suppress, Add / Edit / Remove dynamic suppression, Roll to here,
    Roll to end, Hide / Show, Zoom to, Show dependencies (a dialog: parents above, children below), Add to
    folder, Move out of folder, Move to a folder, Copy sketch, Paste sketch (a new sketch with the copied curves,
    in another part studio too), Add comment, Delete. Of a folder: Rename, Suppress, dynamic suppression,
    Expand, Collapse, Expand all, Collapse all, Roll to here, the folder entries, Unpack folder, Delete folder
    and what is in it. Which folders are collapsed is this person's, kept in the browser per document.
  - **Pausing regeneration** (`studio.pauseRegen()`, `regenerateNow()`, `resumeRegen(discard?)`,
    `restoreDiscarded()`; `getState().pause`, `.discarded`). While paused, edits are committed as ever (stored,
    shared, undoable) and only this person's model waits; "Discard and exit" undoes this person's edits made
    since the last Regenerate, "Restore" redoes them. A sketch cannot be opened meanwhile. **Regeneration
    times** lists what each feature's last build took (`FeatureReport.ms`, kept across cached rebuilds).
  - **The separator** between the feature list and the panel under it (the parts list) is dragged to share the
    room; each scrolls by itself; the height is kept in the browser, a double click gives it back. The button at
    the right of the Features header folds the whole dock away.
  **Parts** (`panels/parts.tsx`): click selects the part, the eye hides it, the menu
  isolates, zooms, opens Appearance, deletes.
- **The feature list** (`ui/FeatureList.tsx`) starts with the **default geometry** (Origin, Top, Front, Right:
  rows that select and hide like any other, and that a listening plane field takes a click on), then the
  features. The box at its top ("Filter features…") filters them by name; Ctrl and Shift select several; F2 or a second slow click renames; the eye
  hides and shows a plane, a sketch or reference geometry (`studio.setVisible`: this person's view, kept in the
  browser per document, never in the document); the pointer over a row lights up what the feature made and the
  pointer over the model marks the row that made the face; the rollback bar is always there to drag and says
  how many features are below it; the menu has Edit, Rename, Suppress, Roll back to here, Roll to end, Hide,
  Zoom to, what it uses and what uses it, Delete (several at once); a failed feature's mark shows its message
  and a click looks at it.
- **The parts list** (`ui/PartsList.tsx`, mounted by `panels/parts.tsx`; what it shows and offers is worked out
  in `ui/parts-model.ts`, pure and tested, and done by `ui/part-actions.ts`; its dialogs are
  `ui/PartDialogs.tsx`). Sections **Parts, Surfaces, Curves, Composite parts**, each with its icon and count
  (`[data-section=part|surface|curve|composite]`; the heading's text, "Surfaces (2)", is `[data-group=surfaces]`
  with `data-count`); a heading folds its section (kept in the browser) and its eye hides or shows the section. A
  row is `[data-entry=<entry id>]` (`data-body` for a body, `data-kind` part, reference, surface, composite or
  curve, `data-visible`, `data-hover` while the pointer is on the entry in the model).
  - A click selects the entry in the model (a body is every face of it, a curve its datum pick), Ctrl adds,
    Shift takes the range, Ctrl+A everything, ↑ ↓ move; the model's selection marks the rows. The pointer over a
    row lights the entry up; over a **hidden** entry's row it draws the entry's outline. While a dialog is open
    a click on a row is given to the listening field (or to the dialog's first `bodies` field).
  - The features that made or changed what is selected (a whole part, a face, a curve) are marked in the
    feature list (`[data-part-cross]`, a feature row slot from `panels/parts.tsx`; `crossFeatures(studio)`).
  - F2 or a double click renames in place; Del starts Delete part.
  - The menu of a row, for every selected row at once (`.cad-parts-menu`, items `[data-command]`): Rename,
    Properties…, Assign material… (the document's library, or a new material), Edit appearance… (colour,
    opacity), Move or copy… (the Transform feature), Export… (the Export dialog on those parts), Hide / Show,
    Hide other items, Hide all, Show all, Isolate / Exit isolate, Make transparent / Make opaque, Show / Hide
    centre of mass (parts with a material), Add comment… (pinned to the part), Zoom to selection, Delete…
    (the Delete part feature). What does not apply to a kind is left out (a surface has no material, a curve
    is renamed, described, hidden, commented on and looked at); what cannot run now is greyed and says why.
  - A heading's menu: hide, show or select its section, fold it, and **Show parts list properties** (each
    part's material and description beside its name; kept in the browser).
  - Names, properties, materials and colours are the document's: one undoable change each, seen by everyone.
    Hidden, isolated and **transparent** (`displayOf(studio).setTransparent(ids, on)`: `inspect/appearance-display.ts`)
    are this person's view and are not kept over a reload.
  - Not there, because Junction has no such thing: releases and revision history, part numbers, revisions and
    states (so "parts list properties" shows material and description), configurations, drawings ("Create
    drawing"), a clipboard for parts ("Copy" to paste elsewhere), mesh bodies (no Meshes section). Isolate
    hides the other parts; it does not grow by distance or connectivity.
- In a script, `scripts/cad-chrome.mjs` `openPanel(page, id)` unfolds one.

### `PartStudio` (`ui/studio.ts`)

What tools, panels and dialogs are handed:

```ts
studio.getState()              // StudioState: features, rollback, reports, bodies, sketches, selection, hover,
                               //   editing, sketch, kernel, peers, canEdit, canUndo, canRedo, units, visibility,
                               //   selectedFeature(s), hoverFeature, …
studio.subscribe(fn)
studio.doc                     // the ItemDoc (read only; change it with commit)
studio.commit(changes)         // see "How a change is committed"
studio.undo(), studio.redo()
studio.rollTo(featureId | null), studio.followRollback()      // the rollback bar (see "The feature list")
studio.pauseRegen(), studio.regenerateNow(), studio.resumeRegen(discard?), studio.restoreDiscarded()
studio.kernel.call(name, args)
studio.view                    // ModelView: pick(ev), planePoint(ev, frame), setOverlay, setFilter, sketchFrame, pointerTool,
                               //   setMarks, boxOf(picks), normalOf(pick), picksOfFeature(id), planeLayer (halfOf(id), labelInfo())
studio.viewport                // Viewport3D: fit(), setView(), lookAlong(), rotateBy(), ray(ev), project(p), pixelSize(), scene
studio.select(picks), studio.selectFeature(id, add?), studio.selectFeatures(ids), studio.pickFromList(pick)
studio.startFeature(type), studio.editFeature(id), studio.setDraft(patch), studio.acceptFeature(), studio.cancelFeature()
studio.setField(key), studio.fillField(key, pick), studio.clearField(key, index?), studio.setFinal(on), studio.pickFilter()
studio.openSketch(id), studio.finishSketch(), studio.cancelSketch(), studio.setSketchTool(id), studio.setSketchPlane(ref), studio.pickSketchPlane(on, cleared?)
studio.isVisible(id), studio.setVisible(ids, on), studio.setPlanesVisible(on)   // "origin", "top", "front", "right", feature ids
studio.setUnits({ length?, angle?, places? })
studio.fit(), studio.zoomToSelection(), studio.zoomToFeature(id), studio.normalTo()
studio.host                    // DocumentHostContext: project, doc, docs, toast(), openDoc()
studio.inputFilters            // what is added to the worker's input before every regeneration (never stored)
studio.onRegen                 // called after every regeneration whose result was shown
studio.scheduleRegen()         // an input filter's data changed: build again
studio.showPast(doc, label)    // an earlier version in place of the live document (null: back)
studio.setUi({ key: value })   // interface state of a tool or panel, kept in getState().ui
```

`studioExtensions.push((studio) => stop)` registers something that lives as long as each studio is open.

`window.JunctionPartStudio` is the open studio, for tests and the console.

### Picking (`viewport/modelview.ts`)

```ts
type Pick =
  | { kind: "face" | "edge" | "vertex"; body: string; name: string; point: Vec3 }
  | { kind: "plane"; plane: "top" | "front" | "right"; point: Vec3 }
  | { kind: "sketch"; featureId: string; entity: string | null; region: string | null; point: Vec3 }
  | { kind: "datum"; featureId: string; datum: "plane" | "axis" | "point" | "curve"; point: Vec3 };
```

A vertex wins over an edge wins over a face when the pointer is within a few pixels; a body wins over a sketch
wins over a plane (but for a sketch lying on the face under the pointer while `view.sketchFirst()` says so: a
dialog whose profile takes sketches and faces). A body that is drawn in another way (`view.bodyStyle` returns `faces: false`: a Board
feature's solids under the board's picture) is still found by the pointer; anything that sets a body's
visibility (display modes do) must ask `bodyStyle` first. Hover and selection are highlighted from the same picks. Turn a pick into a stored reference
with `{ kind, body, name }`. A plane or reference geometry a person has hidden is neither drawn nor picked.

- **A drag with the left button on nothing draws a box** (`view.onBox`): from left to right it takes the faces
  and edges wholly inside it, from right to left (dashed) whatever it touches, of the kinds the filter allows;
  what is behind other geometry counts too. Shift or Ctrl adds to the selection; into a listening field it
  adds only.
- **A right click that did not turn the view** (`view.onContext`) opens the menu for what is under it
  (`ui/Overlays.tsx ContextMenu`); in a sketch it first puts the tool down.
- **The default planes** (`viewport/planes.ts`) look as Onshape's: three squares centred on the origin, the same
  pale blue translucent sheet with a thin blue outline. Each is drawn as its four quarters, so the three, which
  cut each other along the axes, blend from the back to the front and are a little deeper where they overlap.
  The plane under the pointer gets an orange outline and nothing else; a selected one the selection's colour
  (`--mark`) and a tint. The origin is a small circle with a dot, the same size at any zoom, drawn over
  everything. The planes' blues and the hover orange are Onshape's, kept in `planes.ts` (one set for a light
  page, one for a dark one) — the theme has no blue; everything else takes the theme's tokens.
- **A plane's size**: a plane nobody resized starts at 60 mm and grows to reach a little past the model on its
  two axes. **A corner is a handle**: within a few pixels of a corner of a shown plane the pointer shows a
  resize cursor and a dot, and a drag resizes the square about the origin (`planeLayer.cornerAt`,
  `setDragSize`); letting go commits the side to the document (`planeSizes`, above), after which the plane no
  longer grows with the model. Only someone who can edit can resize; a drag on the rest of a plane is a click
  or a selection box as before.
- **A plane's name is painted on the plane**, as Onshape does: text on its surface at a corner, in the scene, so
  it turns and foreshortens with the plane and seen from behind reads mirrored. "Top" sits at the corner of
  −X −Y reading along +X, "Front" at −X +Z along +X, "Right" ending at +Y +Z along +Y (so in the isometric view,
  reading plainly, Top is at the left corner, Front at the top left, and Right at the top right). Its height
  follows the plane's size, and it fades out as the plane turns edge-on. Reference planes carry their feature's
  name the same way, in their own frame (`planeLayer.setLabel`). `planeLayer.labelInfo()` says how each name is
  drawn in the current view (its axes in the model, its opacity), for tests.
- **A view with nothing built** is the start view (`viewport3d.ts START_VIEW`: from the front right top, turned towards
  the front and lower than isometric, so the planes read as three planes rather than a star) with the three planes filling the middle two thirds of
  it (`studio.fit()`), as a new Onshape part studio opens.

Viewport navigation: right-drag turns, middle-drag or Shift / Ctrl + right-drag slides, the wheel zooms about
the pointer, a double click with the middle button or F fits. The **view cube** (`ui/ViewCube.tsx`, top right,
about 180 px with its controls; the element is also `.v3-views`; the cube itself is `ui/ViewCubeControl.tsx`,
which an assembly mounts too, through `api-ui.ts`) is laid out as Onshape's: a grey-white cube
with bevelled edges, turning with the camera, its faces named in plain ink so the names foreshorten with them.
Its 6 faces, 12 edges and 8 corners are each a target (`data-region`, `data-from`: the direction it looks
from; a face also `data-face` and `data-view`) that turns the view to look from there. **A corner or an edge is a
zone, not only its bevel**: a corner is its bevel, the ends of its three edges and a square of each of its three
faces (`ZONE` px), an edge its bevel and a strip of each face beside it, and a face keeps the middle of itself, as
the ViewCube of other CAD programs has it; so every corner is about 30 px across on screen. Each zone is pieces in
their planes (`[data-piece]`, hit-tested by the browser in 3D), so what is in front wins. The zone under the
pointer lights up in `--mark` and a hint under the cube names it (`data-cube-hint`: "Front Right Top corner",
with Shift+7 for the isometric one; "Front view Shift+1"). In a script, `cad-chrome.mjs cubeAt(page, from, { on })`
says where a zone is on screen and `cubeClick` clicks it with the pointer. The axis triad (X red, Y green, Z blue, with letters) is drawn over it from its
back bottom left corner; the viewport's own corner triad is off in a part studio. Around it the four triangles
turn the view 90° about the screen's axes (`data-turn`: Turn up, down, left, right; Shift + the arrow keys do
the same, the arrow keys alone turn 15°) and the two curved arrows roll it 90° (Roll left, Roll right; Ctrl/Cmd +
Shift + ← →, and 15° without Shift); their tooltips say so. The cube with ▼ below it opens the view menu
(`data-view-menu`; items `data-view-item`): the standard views (`std-iso`, `std-front`, …), zoom to fit (`fit`),
to selection and normal to, the projection, the display modes, the planes, the section view and the named
views. Model space is millimetres, Z up; Front looks from −Y, Right from +X, Top from +Z with +Y up.
Colours come from the theme tokens (`tokenColor("--mark")`); do not write colour literals — but for the
planes' Onshape blues and orange (above), the triad's axis colours, and the part palette and edge hairlines of
`shared/viewport3d/look.ts`.

### How the viewport looks (`shared/viewport3d/look.ts`)

Every `Viewport3D` has a `look` (a `StudioLook`), the same for a part studio, an assembly and Compare:

- **Light.** A small studio (a pale dome, a key softbox above left, a fill, a rim strip) is rendered once per
  renderer into an environment map (`studioEnvironment`) and turned with the camera each frame, with one
  directional key: a part is lit the same from every side. Dress a part's material with `studioSurface(new
  THREE.MeshStandardMaterial(…))`; a preview of what is not there yet with `ghostSurface` (glass with a brighter
  rim; the assembly's insert preview). A scene drawn once off screen (a thumbnail, the insert picture) is lit the
  same by `lightAsStudio(scene, renderer, camera, focus, radius)`.
- **Colours.** A part nobody coloured takes `partColor(index, dark)`: the first is the neutral, the rest a quiet
  palette, in the order of the parts list (an assembly: of the geometries it draws). A colour or a material in
  the document wins. Shaded parts carry dark hairline edges whatever the theme (`edgeColor`); wireframe and
  hidden-edge line work is drawn in the theme's ink.
- **Edges.** `shadeEdges(edgeGeometry, mesh)` with `edgeLineMaterial()` draws tangent edges (the ends of a
  fillet, a cylinder's seam) lighter than sharp ones; which is which is worked out on the page from the mesh's
  normals, so nothing in the kernel's protocol changed.
- **Solids.** A domain marks the meshes that are parts with `userData.solid = true` and calls
  `look.contentChanged()` when they change. From one depth pre-pass of the solids of a frame the look draws the
  shading where surfaces meet (screen-space ambient occlusion), a hairline round each part's silhouette, and the
  soft shadow on the ground under the model. Translucent parts, hidden parts and a section view are left out.
  `look.contact` (0…1) turns the first two down for a display mode that is line work.
- **Highlights.** `look.glowFrom(group)` draws a soft halo round whatever the group holds (the hover and
  selection highlights), hidden where a solid is in front. A selected instance of an assembly keeps its colour
  under a veil of the selection's.
- **Quality.** `look.quality.level` is `high` or `low`. On a software or slow GPU (SwiftShader, llvmpipe; or
  frames that take too long while the view turns) the screen-space passes and the shadow are left out, and
  the environment map gives way to three plain lights placed as the studio's are (`PlainRig`), so a frame costs
  no more than a flat-lit one; the backdrop, palette and edges stay. That is what the browser tests run with.
  `localStorage["junction.cad.quality"] = "high" | "low"` forces one. Nothing here draws unless the viewport
  draws a frame, and the viewport draws only when asked (`invalidate`).
- **Motion.** `fit`, the standard views, the cube and named views ease out. `viewport.target` and
  `camera.zoom` hold where a fit is going from the moment it is asked for (so `project`, `ray` and a test agree
  at once); only the frames on the way are eased. Nothing moves by itself under `prefers-reduced-motion`.
- **A person's choices** (`viewprefs.ts`, `localStorage["junction.cad.view"]`): the display mode (Shaded with
  edges, Shaded, Wireframe, Hidden edges removed, Translucent), and in the view menu's Scene section the ground
  shadow, the contact shading and whether the view drifts on after an orbit (`scene-ground`, `scene-contact`,
  `scene-inertia`; off by default).

## Collaboration (`mechanical/collab/`, `platform/doctabs/room.ts`)

Everything here sits on the document session and changes nothing on the server.

**Presence.** `collab/collab.ts` (`Collab`) sends a small state on the session's presence lane, at most twenty
times a second and only when it changed (`collab/presence.ts`): `cam` (orientation, target, zoom, aspect), `cur`
(the model point under the pointer), `sel` (picks as `["f"|"e"|"v", body, name]`, `["p", plane]`,
`["s", sketch, entity, region]`), `feat` (the selected row), `edit` (`{ id, kind: "dialog" | "sketch", isNew?,
name? }`), `fol` (whom this person follows), and `key` / `col` (the person's window and colour, the same on every
tab). `collab/overlay.ts` draws the others in the viewport; `panels/collab.tsx` lists them; `ui/slots.ts`
`addFeatureRowSlot` is how they get into the feature list (a slot is a component at the right end of every row;
use it for your own marks too). The part studio's layer is `studioCollab(studio)` (`collab/studio-collab.ts`):
`{ collab, guard, comments, meshes }`, alive while the Collaborators panel is mounted;
`window.JunctionCadCollab` is the open one, for tests.

- A feature with an editor of its own needs nothing: presence reads `studio.getState().editing` and `.sketch`.
- Another 3D editor gets presence with one call, `mountViewportCollab({ session, viewport, ctx, local, subscribe })`
  (exported from `mechanical/api.ts`; the assembly uses it): avatars, pointers, views, Follow. Pass `sources`
  to have other people's selected faces and edges drawn on your meshes.
- Presence never rebuilds anything. A window that is hidden does not rebuild on other people's edits; it
  rebuilds once when it is shown again (`studio.scheduleRegen`).

**Follow.** `collab.follow(key)` eases the camera to the other person's each time theirs moves; turning, panning
or zooming one's own view, a standard-view button, or starting to edit stops it. When the person goes to another
tab the follower is taken there and the follow carries over (to an editor that has presence).

**Two people in one feature** (`collab/guard.ts`, `collab/merge.ts`). The document merges per path, so:

- a dialog's draft is rebased whenever its feature changes in the document: values the other person changed and
  this one did not appear in the open dialog and its preview; a value both changed stays this person's, and the
  dialog says whose value Done will replace and offers theirs;
- a feature deleted under an open dialog or sketch, or while an edit to it was on its way (or was made offline),
  is offered back with this person's values ("Put it back": an `ADDED` of the item, for everybody);
- two people in one sketch both draw: entities are separate paths. Two people moving the same point at once: the
  later one wins, and both see it happen.

Do not commit "the draft as it is" from code that keeps a draft: diff against what the document holds now, after
a rebase (`rebase(base, mine, theirs)`), or the other person's edit is undone without a word.

**The session** (`shared/itemdoc/sync.ts`) has two additions for this: `session.taps` (a set of listeners shown
every message for the document before it is handled, and the session's own edits as `local_op`) and
`session.peerList()`. It also recognises an op of its own in the catch-up after a reconnect (the server stored it,
the ack was lost), so that op is not put back on top of what others did after it; `static/tests/mechanical-collab`
runs several sessions against a sequencing server in every delivery order and checks they end on the server's fold.

**The project room** (`platform/doctabs/room.ts`, started by the tabs; `projectRoom()` in `roomapi.ts` for a
bundle) is who is in the project and on which tab. Presence on the server is per document, so every page opens
one more socket, joins the project's first four part studios and assemblies (by id) with it, and says there
which tab the person is on (a document id, `home`, or `bom:<PCB key>`). The room joins the project's own document
first (`project.jproj`, see "Document tabs and the shell"), so every project that has one has a room; an older
project with neither that document, a part studio nor an assembly has none, and nobody is shown on its tabs.
That the project's documents changed is not the room's business: the server says so (the `docs` notice, under
"How a change is committed and synced").

**Comments** (`collab/comments.ts`, `collab/anchor.ts`). A thread's anchor is the platform's `{ kind: "item",
id, label, item }`: `id` is a feature id, or `face:<name>` / `edge:<name>` / `vertex:<name>` with the body id in
`item`. The pin is drawn at the middle of that geometry as it is now, so it follows rebuilds; `x`, `y` carry
the point the thread was started at (micrometres, packed: `packPoint3`), where the pin stays when the geometry
is gone. A name over 300 characters falls back to the feature that made the body. The project's review list
(`/api/projects/{id}/comments`) includes these threads; the electronics editor's Comments pane lists them under
their document but cannot jump to the geometry.

Not done: a thread on a sketch entity or on an assembly instance; mentions; a pin hidden behind the model is
still drawn; the presence of a person on a schematic or board tab is their tab only, not their pointer.

## Document tabs and the shell

A project is a set of **elements**, each one tab: any number of PCBs, part studios and assemblies, after a first
tab, **Home**, that is always there. Everything else in the project is a file: a library, a 3D model, a STEP
file, the sheets of a PCB. The shell is `platform/doctabs` (the tab bar and what both it and Home do),
`platform/projecthome` (Home) and, on the electronics editor's side, `pcb/editor/{dochost,doc,pcbscope}.ts`.

| File | What |
|---|---|
| `platform/doctabs/pcbs.ts` | **Which PCBs a project holds and what each one's editor may see.** Pure. Read it first. |
| `platform/doctabs/elements.ts` | Elements, their order, folders, the rows of Home's tree. Pure. |
| `platform/doctabs/actions.ts` | Create, rename, duplicate, move, delete (with a few seconds to undo), import: the same ones for the bar and for Home. |
| `platform/doctabs/api.ts`, `server/src/shell.rs` | The requests, and the routes that answer them. |
| `platform/doctabs/shell.ts`, `useshell.ts` | The project's own document, live; the project as the React parts read it (`useProjectShell()`). |
| `platform/doctabs/DocTabs.tsx`, `platform/projecthome/ProjectHome.tsx` | The bar (with the tab manager and "+"); Home. |
| `pcb/editor/pcbscope.ts` | The PCB the schematic and board editor is on, and what keeps it inside that PCB. |
| `pcb/parts/bomview.ts` | A PCB's bill of materials as a view. |

### Elements, and what a PCB is

- `domains/registry.ts` lists the document kinds: `docType`, `ext`, `title`, `icon`, `tint`, and for kinds a
  domain's own editor draws, `bundle`, `newName` and `newText`. A new kind of document is an entry there, two
  lines in `server/src/http.rs` (`doc_type_for`, `allowed_file`) and one in `itemdoc.rs` (`is_item_doc`). It then
  has a tab, a row on Home, a place in "+" and in Home's create buttons, with nothing else to write.
  `PCB_ELEMENT` in the same file describes the one kind of element that is more than one document.
- **A PCB is a KiCad project in a folder of its own**: `<name>/<name>.kicad_pro`, `.kicad_sch`, `.kicad_pcb`, its
  other sheets, its `fp-lib-table`, its libraries. Its name is the folder's. The folder is a valid KiCad project
  on disk and in a GitHub repository. `POST /api/projects/{id}/pcbs` makes one; renaming, moving, copying and
  deleting a PCB are folder operations (`/folders/move`, `/duplicate`, `/folders/delete`), and a rename or a
  copy gives the PCB's own three files the new name (`shell.rs` `restem`), so a board is always called what its
  PCB is called wherever boards are listed by file name (the assembly's Insert, a part studio's Board feature
  and board link).
- **A project from before** (KiCad's files at the project's root) is one PCB whose folder is the root. Nothing
  about it changes and nothing is added to it: its editor gets the very document list it always got, it opens on
  its root schematic, and the shell does not offer to rename, move or delete it. More PCBs can be added beside it.
- Which document belongs to which PCB (`pcbsOf`): the PCB whose folder is the longest that contains it. A
  schematic or board outside every PCB folder rides with the project's only PCB, or, when there are several,
  makes a PCB at the root. A part studio, a model or a library outside every PCB folder belongs to none.
- A PCB's `key` is the id of its project file: it survives a rename, and is what the tab order and
  `bom:<key>` are keyed by.

### One PCB at a time: how the editor is kept inside it

The schematic and board editor finds "the" project file, root sheet, board, rules and library tables by
looking through the project's documents, in more than a hundred places, and remembers a good deal per project.
Pairing a schematic with another PCB's board would be silent and serious, so the rule is structural:

- `state.project.docs` (and `state.docs`, and `store.project.docs`) is the **scoped view**: the documents of the
  bound PCB and of no other, with paths relative to its folder, plus what belongs to no PCB at `../…`
  (`scopedDocs`). Inside it, `fp-lib-table` is the PCB's own and `${KIPRJMOD}` is the PCB's folder.
  `state.project.allDocs` is the whole project with real paths: **shell code and other domains read `allDocs`**
  (`DocumentHostContext.docs` is `allDocs`). Document ids are the same in both.
- The editor names files it makes as it sees them. `installPathScope` wraps `fetch` for exactly two requests
  (`POST /api/projects/{id}/docs`, `PATCH /api/docs/{id}`) and puts the folder in front of `path` on the way out
  and takes it off the answer. Shell code sends real paths through `rawFetch()` (`platform/documents/rawfetch.ts`).
  A new project-level request that carries a path needs the same treatment there.
- **One PCB per page.** Opening a document of another PCB than the one this page has bound loads the page again
  at that document (`bindPcb` answers `"reload"`), and so does the bound PCB being renamed under the page.
  Moving between the views of one PCB, or between a PCB and a part studio, an assembly or Home, stays in the
  page. This costs a second when switching PCBs and removes a class of stale-cache bugs; lifting it means
  auditing every per-project cache of the editor.
- The assistant's electronics tools are narrowed the same way (`pcb/mcp/host.ts` `scopeToPcb`): a call names its
  PCB in `document` (`"Motor driver/board"`, or a path as `get_project` lists it); one that names none works on
  the PCB used last and says so in its result (`pcb`, `pcbs`). The other domains' tools see the whole project.
- Server routes that pick a board or schematic for a whole project (`preview.svg`, `first-doc`) only choose a
  picture or a first guess the editor checks; `board-items` takes `?doc=`.

### Tabs

- The bar shows Home, then one tab per element in the project's order. A PCB's tab holds its views:
  **Schematic** (any sheet of it; a caret lists the sheets when there are several), **Board** (one per board),
  **BOM**, and, on the board, **3D** and **Outputs** (the 3D viewer and the fabrication outputs, which are the
  board editor's own dialogs). The views show on the open PCB's tab, and always in a project with one PCB.
- A tab id is what `openDoc` takes, what the address carries (`/p/<project>/edit?doc=<id>`) and what the room
  says: a document id, `home`, or `bom:<PCB key>`. A link to a sheet or board opens its PCB on that view. With
  no `doc`, a project with a PCB at its root opens on that PCB's root schematic and any other project on Home.
- Home and the BOM are opened like documents: `dochost.ts` gives the `cad` view to the editor registered for
  `@home` (`ProjectHome.tsx`) or `@bom` (`bomview.ts`). A view of the shell's own is a `registerDocumentEditor`
  with a doc type that starts with `@` and no bundle.
- Each sheet and board remembers where it was being looked at (`doc.ts` `viewMemo`), for the page's life.
- **The project's own document**, `project.jproj` (type `project_shell`, a JSON item document like a part studio),
  holds what is shared about the shell: `{ id: "tab:<key>", type: "tab", order }` for each tab somebody placed,
  and `{ id: "folder:<uuid>", type: "folder", path }` for a folder that is still empty. A blank project is made
  with it; an older project gets it the first time somebody reorders a tab or makes a folder (`POST …/shell`).
  It is also what the project room joins first, so every project that has it shows who is on which tab.
- Folders are paths. A part studio in `Enclosure/` is `Enclosure/Lid.jpart`; tabs of one folder stand together
  in the bar behind the folder's name. A PCB's own folder is not a folder to put things in.
- Opening a hosted kind: the shell leaves the KiCad document, shows the `cad` view, loads the bundle once, and
  calls the `DocumentEditorFactory` it registered (`platform/documents/host.ts`):

```ts
registerDocumentEditor({
  docTypes: ["part_studio"],
  open(ctx) { /* ctx.el, ctx.project, ctx.doc, ctx.docs, ctx.signedIn, ctx.setConnection, ctx.toast, ctx.openDoc */
    return { close() { … } };
  },
});
```

- The menu bar shows the project name and role in the `cad` view and no KiCad menus. A domain that needs menus
  should get them through an interface on the menu bar, not by importing into `shared/` (see the roadmap).

### Testing the shell

`node static/tests/project-shell.test.js` covers the model: PCBs and the scoped view (including "no PCB's editor
sees another's files"), paths both ways, binding, tab order, Home's tree, what dropped files become.
`cargo test shell` covers the folder routes' planning. `scripts/shell-ui.mjs` is two people in the browser: a
blank project, two PCBs, a part studio and an assembly, an imported KiCad folder, the views of a PCB, **Update PCB
from Schematic in one PCB leaving the other's board alone**, reorder, rename, duplicate, folders, the tab manager,
delete and undo, deep links, and a project from before. Its header says how to start the server for it
(`KC_LIBS_FOOTPRINTS_URL=$PWD/scripts/fixtures/shell-ui/footprints`). `scripts/shell-mcp.mjs` calls the
assistant's tools over `/mcp` in a project with two PCBs: each reads and edits the PCB it names and no other.

### Not done

- Opening another PCB reloads the page (above). Deleting is undone within six seconds or not at all: the server
  deletes a document with its history.
- A PCB at the project's root cannot be renamed, moved, duplicated or deleted from the shell.
- Home's rows are dragged onto folders; tab order is changed in the tab bar, not on Home.
- A project from before has no room (nobody is shown on its tabs) until it has the project's own document, a
  part studio or an assembly.
- The desktop app sees a multi-PCB project as folders of KiCad projects; it has not been taught to pick one.
- GitHub sync carries the folders as they are (paths are paths to it); it has not been run against a project
  with several PCBs.

## Boards (`board/`, `boardlink/`, `../pcb/mech/`)

Two directions, each with its README; what joins them is here.

- **PCB → CAD.** The Board feature (`features/board-reference.ts`) shows a board of the project in a part
  studio as two reference bodies with stable names (`<feature>:front`, `:hole:H1`, `:part:J1:top`, …) under a
  picture of the board as it looks, and follows the board while it is edited. Opening and Standoffs hang off
  those names. [`board/README.md`](board/README.md).
- **CAD → PCB.** A `board-link` item per board says what the model drives on it: the outline, mounting holes,
  keep-outs with height limits. The part studio's page solves the drives into board geometry and stores the
  answer in the link; the board editor writes the items. [`boardlink/README.md`](boardlink/README.md),
  [`../pcb/mech/README.md`](../pcb/mech/README.md).
- **One placement.** A board that is both shown in a part studio and driven by it lies in one place: where its
  Board feature puts it. The link names the feature (`feature: <id>`); its own `plane`, `lift`, `anchor` and
  `rotation` are then not used. The worker takes the frame the feature was built with, and the feature's
  `origin` as the sheet point at that frame's origin (`boardlink/solve.ts`); the answer carries them
  (`solved.frame`, `solved.anchor`, `solved.rotation`), which is what the board editor reads (`placementOf`).
  In the Board panel either way is one step: **Link this board** on a studio that shows the board makes a link
  placed by the feature; **Show the board in the model** on a link without one adds a Board feature exactly
  where the link has the board (the link's plane and lift, its sheet anchor as the feature's origin, the
  opposite turn) and hands the placement to it. A link with no Board feature keeps its own four values.
- **One panel.** "Board" in the right dock lists the boards the studio shows and the board it drives.
- The loop is closed and stable: the tray drives the outline, the outline changes the board, the Board feature
  is rebuilt from the board, the link is solved again and gives the same answer.

## Assemblies (`.jasm`)

[`../assembly/README.md`](../assembly/README.md) is the contract: the document, mates and the solver, sources,
what a tool is handed. In short:

```ts
{ id: "assembly", type: "assembly", units: "mm" }
{ id, type: "instance", name, order, source, transform, fixed?, suppressed?, hidden?, group? }
{ id, type: "mate", mateType: "fastened", name, order, a, b, params, suppressed? }
```

- `source` is `{ kind: "part", docId, body }`, `{ kind: "board", docId }` or `{ kind: "assembly", docId }`
  (`{ kind: "file" }` is carried and has no provider). An instance copies no geometry: the assembly follows the
  source document, live.
- `transform` is twelve numbers, the rows of a 3 × 4 matrix. **The document stores solved placements.**
- A mate ties connector `a` to connector `b`: `{ instance, ref: GeomRef, flip? }`, by the geometry names above.
- **A part studio that holds a Board feature** is built with its board (see "Building a part studio outside its
  page"), so its board bodies can be instanced like any part.
- **A board itself** (`sources/board.ts`) is built by the same code as a Board feature, as a studio of one Board
  feature with id `board` on the Top plane and the sheet's origin as its origin: pieces `board:board` and
  `board:parts`, faces `board:front`, `board:back`, `board:hole:H1`, `board:part:J1:top`. The pieces are ghosts:
  the editor draws the board as it looks (`viewport/boards.ts`) and the solids are there for the pointer, the
  mates and the checks. Insert puts a new one with its middle at the origin.
- **Interference and the bill of materials** (`tools/interference.ts`, `tools/bom.ts`) read the editor's own
  instances, placements, source handles and workers (`assembly.placed()`, `handle.ensureKernel()`), open as
  docked panels (`assembly.showPanel`; the table at the bottom), and mark the instances that clash
  (`scene.setMarked`). Parts and boards are checked exactly; the parts inside a sub-assembly are not yet.

## The MCP tools (`mcp/`, `../assembly/mcp/`)

What an AI assistant connected to the MCP endpoint (`server/src/mcp.rs`) has for mechanical design. The aim: a
model that has never seen Junction designs a multi-part mechanism from the tool descriptions alone, cheaply in
tokens, and sees what it made. `scripts/cad-mcp-e2e.mjs` is the proof: a hinged box with a lid, a pin and two
screws, made, checked, rendered and exported by MCP calls only.

**Where they run.** Headless, in the Node tool host the server starts per person (`server/src/mcp_host.rs`,
bundle `static/dist/mcp-host.js`, embedded in the server binary: rebuild the server after `npm run build:mcp`).
Nothing has to be open in a browser. A document is joined over the collaboration socket as the person
(`OpenDoc`: an `ItemDocSession`), so an edit is committed, journalled and shown to everybody in the document like
a person's; the model is built by the same `RegenEngine` on the same OpenCascade build as the page's worker
(`OpenStudio.regen`), one kernel for every document the process has open; sketches are solved by the same
PlaneGCS build. What the host needs: `node` on the server's PATH (`KC_NODE`) and the kernel's
`occ-kernel.wasm` (beside the Python runtime, or `KC_OCC_WASM`). Board instances and model-file instances of an
assembly are not built by the host (they are listed, and left out of pictures and checks with a note).

| Tool | |
|---|---|
| `cad_reference` | short pages: `guide` (the workflow, a part in one call), `sketch`, `references` (names and picks), `variables` (also parts and materials), `mates`, `features` (every type, a line each) |
| `cad_feature_types` | the feature catalogue in steps: families and the everyday types; `query` / `family` to search; `type` for one type's parameters and an example edit |
| `cad_describe` | a part studio or an assembly in a few lines of text: sizes, positions, holes by diameter, features, mates, freedoms |
| `cad_get_features` | the tree with each feature's state (and a hint when it failed), the variables, the bodies; `feature` for one in full (a sketch's entities, regions, definedness); `compact`, `fields`, `offset`, `limit` |
| `cad_get_bodies` | volume, area, centre of mass, box, material and mass; `names` for face and edge names |
| `cad_find_geometry` | faces, edges, vertices by description, with what each is and the reference to use; works on an assembly's instances as placed |
| `cad_edit_features` | add, set, rename, delete, suppress, move, rollback, `set_variable`, `delete_variable`, `set_part`; one change, all or nothing; `dry_run`, `atomic`; sketch `shapes`, `define`, `constraints`; references as picks |
| `cad_measure` | volume, mass, centre of mass, overall box; faces and edges (and two together: distance, angle); the clearance between two parts |
| `cad_check` | `validity`, `interference` (exact, mm3), `clearance`, `thickness` (the thinnest wall, sampled) as findings |
| `cad_render_view` | a shaded picture: named views or a direction, `views` (several in one picture), `section`, `zoom_to`, `highlight`, an assembly's `explode` and `drive` (a motion as cells) |
| `cad_export` | STEP, BREP, STL, 3MF, OBJ, GLB of a part studio or a whole assembly; DXF or SVG of a flat face or a sketch; a download link and an MCP resource |
| `cad_import` | a STEP file (already in the project, or its text) as a new part studio |
| `cad_create_part_studio`, `cad_create_assembly` | new documents |
| `cad_get_assembly` | instances with placements and freedoms, mates with state and values, the solve report |
| `cad_edit_assembly` | insert (a part studio's bodies, another assembly, `standard` hardware, a supplier's `model`), move, fix, copy, rename, suppress, hide, delete, `mate`, `set_mate`, `drive`; solved after each edit; `dry_run` |
| `cad_search_models` | the server's supplier search (`server/src/models3d`): standard parts and suppliers' models |
| `cad_get_bom` | the assembly's bill of materials (also CSV) |

`undo_changes` / `redo_changes` take back any `cad_` change by its `change_id` (the record carries the inverse
item changes and the domain, `mechanical` or `assembly`).

The files:

```
mcp/tools.json     the tools as the server lists them (name, title, description, input_schema; write, destructive,
                   idempotent, open_world become the MCP annotations)
mcp/host.ts        the tools; OpenDoc / OpenStudio; scenes (below); the kernel's services called headless
mcp/model.ts       pure: the tree as JSON, planEdits (edits → item changes, validated), planStaged (picks), variables, parts
mcp/catalog.ts     pure: the catalogue in steps, one type's doc and example, similar names for a mistyped type
mcp/sketch.ts      pure: the extra shapes, define (constraints that hold shapes as drawn), constraints by hand, the sketch report
mcp/select.ts      pure: what a face or an edge is, from the tessellation; picks ("top", { hole, diameter, nearest })
mcp/describe.ts    pure: a part and a feature in words; the thinnest wall
mcp/render.ts      the software renderer: views, a sheet of views, section, highlight, placements; the PNG writer
mcp/reference.ts   the pages of cad_reference (and of the junction://cad/… resources); addReference for other domains
mcp/api.ts         what another domain's tools import (the assembly's): OpenDoc, scenes, studioOf, …; select.ts,
                   being pure, is imported directly by the assembly's pure planner
```

Rules the tools keep, and a new tool should:

- **Small answers.** A list is compact first and detailed on request (`cad_feature_types` → `type`,
  `cad_get_features` → `feature`); an edit answers with a line per feature, not its parameters; long lists page
  (`offset`, `limit`, `next_offset`) and take `fields` (the keys to keep of each row, `pickFields`). `static/tests/cad-mcp-tools.test.js` holds the sizes down.
- **Errors say what to do next.** An unknown name lists the names there are (or the similar ones); a failed
  feature carries a hint (`hintFor`); a pick that finds nothing says what the body has. An error a model can act
  on is an `McpToolError`; "Nothing was changed." starts every refused edit.
- **All or nothing.** `planEdits` plans on a copy; any problem and no change is made. `atomic` extends that to
  features that would newly fail in the kernel; `dry_run` reports the model as it would be.
- **Units in every description**: millimetres, degrees, grams, mm3. Z is up.
- **References by description.** A reference may be `{ kind, body, pick }` wherever `{ kind, body, name }` goes.
  `planStaged` plans the edits before a pick, builds the planned document, resolves the pick on those bodies
  (`select.ts pickGeometry`) and stores the NAME, so the feature then survives rebuilds like one a person
  clicked, and one call can extrude a block and sketch on its top face. A pick is a word (`top`, `bottom`,
  `front`, `back`, `left`, `right`, `largest`, `all`) or conditions (`side`, `normal`, `type`, `hole`, `radius`,
  `diameter`, `length`, `min_area`, `parallel_to`, `of_face`, `nearest`, `all`). An edge with the same face on
  both sides (a cylinder's seam) is never picked. In an assembly a pick is evaluated in assembly space, on the
  instance where it stands.
- **Scenes.** The tools that look at "what is there" (`cad_render_view`, `cad_describe`, `cad_check`,
  `cad_measure`, `cad_find_geometry`, `cad_export`) work on a `Scene`: parts with a mesh, the kernel's shape and
  a placement. A kind of document registers how its scene is made (`addSceneKind`); the part studio's is its
  bodies, the assembly's its instances as solved. A new kind of document that registers one gets those six tools.
- **Sketches** are written solved: shapes give exact coordinates; `define: true` adds the constraints and
  dimensions that hold them (`defineShapes`), `constraints` are checked by the solver and a conflict refuses the
  edit; the answer says how many regions a sketch has and whether it is fully defined.

The server side (`server/src/mcp.rs`): the `instructions` gain a CAD paragraph, the prompts `design_part`,
`design_bracket` and `make_assembly`, and the resources `junction://cad/guide`, `…/sketch`, `…/references`,
`…/variables`, `…/mates`, `…/features` (answered by the host's `cad_reference`, so there is one text) for a
person who has Mechanical CAD on, and nothing of them for anybody else; `junction://exports/{id}` reads a file a
tool exported (a member of its project, as the download link asks). A tool's reply may carry `links`, which
become `resource_link` content.

Tests: `static/tests/cad-mcp.test.js` and `cad-mcp-tools.test.js` (the pure parts against the real kernel and
solver: catalogue, shapes and constraints, picks, staged batches, variables, parts, describing, the picture, an
assembly planned, mated, driven and refused), the server's `mcp::tests`, and against a running server
`scripts/cad-history-mcp.mjs` and `scripts/cad-mcp-e2e.mjs`.

Not done: explicit mate connectors, named positions and groups have no edit op; board and model-file instances
are not built headless; `thickness` is an estimate; a supplier's model fetched for an insert stays in the
project as a part studio when the rest of that call is refused.

## Running and testing

```sh
cd server
npm ci
npm run check                      # generates the registries, then tsc
npm run build                      # every bundle; the outputs under static/ are committed
node scripts/ci-web-tests.mjs      # all web tests, including the ones below
cargo test --locked && cargo clippy --locked --all-targets
```

Tests, each runnable alone with `node static/tests/<name>.test.js`:

| Test | Covers |
|---|---|
| `itemdoc`, `doctabs` | file format, change rules, order keys, the session against a scripted socket; the tabs |
| `mechanical-doc` | the `.jpart` format, every edit, sketch helpers, region finding, the toolbar's keys |
| `cad-units`, `cad-fields` | the document's units: formatting, what is typed into a field, expressions that keep their unit; what a click means to a listening dialog field; how the tool search finds a tool by name and by synonym |
| `cad-partslist` | the parts list: names and properties as item changes (one path each, undone, two people at once, nonsense in the file), `namedBodies`; the sections and counts, which rows a click selects, which features made a part, the menu for a part, a surface, a curve, several rows, a viewer |
| `cad-gripes` | a person's keys (chords, contexts, conflicts, what is refused), Press/Pull, the marking menu's directions, flick and placement, the timeline's layout, the parameters table (every kind of row read and changed), export names and the .zip, the appearance library, selection sets and the filter, a second unit, the words of the history of edits, the offline journal and banner |
| `mechanical-kernel` | **the real kernel in node**: sketch → extrude, booleans, names across rebuilds, cache, rollback, errors |
| `mechanical-features`, `mechanical-patterns` | every solid feature; reference geometry, patterns, sweep, loft, variables |
| `mechanical-collab` | presence, the draft's rebase, comment anchors, the project room, the `docs` notice, sessions under concurrent edits |
| `mechanical-board`, `cad-boardlink`, `pcb-mech` | the board reader and its solids; the link, its transform and solver; the board editor's reconciler and check |
| `mechanical-exchange`, `cad-analysis` | import (with its cache) and every export; measure, section, mass, interference, the bill of materials |
| `assembly-doc`, `assembly-solver`, `assembly-model` | the `.jasm` format; every mate and the solver; connectors, an assembly following a rebuilt part |
| `cad-history`, `cad-mcp` | the feature diff and the 3D diff; the assistant's planning and a plan built in the real kernel |
| `cargo test itemdoc`, `itemmerge`, `dockind` | the server's fold, merge rules, and what each document kind answers |

`static/tests/cad-load.js` bundles a module for a node test: `const { load } = require("./cad-load"); const F =
load("domains/mechanical/document/format.ts");`. New test files must be added to the `for t in …` list of the
`test` script in `package.json` to run in CI.

To run the app: Postgres, then

```sh
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/db JWT_SECRET=dev PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 \
  KC_DEV_LOGIN=1 cargo run
```

**Browser scripts**, against such a server (Playwright, and `psql` to make their test users; each header says
what it needs):

```sh
E2E_PG_URL=postgres://user:pass@127.0.0.1:5432/db E2E_JWT_SECRET=dev E2E_BASE=http://127.0.0.1:8099 SHOTS=/tmp/shots \
  node scripts/cad-e2e.mjs
```

| Script | What a person does in it |
|---|---|
| **`cad-e2e`** | **the whole story, two people, one project**: a constrained tray, shell, fillet, patterned bosses, the board in the tray, the tray driving the board, an opening following a connector, an assembly with a hinged lid and the board, interference, the bill of materials, measure, versions compared, STEP. Run it after any change that crosses folders. |
| `cad-ui` | tabs, sketch, extrude, picking, two people editing, rollback, the stored file |
| `cad-featurelist-ui` | the feature list against Onshape's "Features and Parts Lists": the count, the search box, its filter menu and every command, the error count; the rollback bar dragged, moved with the arrow keys, Roll to here, Roll to end, a viewer's own bar; a face marking its feature's row, a row filling a listening field, several rows dragged as one step; folders (make, nest, collapse, drag into, move out, rename, suppress, unpack, delete, seen by a second person); the feature menu (dynamic suppression, dependencies, copy and paste sketch, comment); pausing regeneration with its three ways out and Restore, regeneration times, the not-fully-defined mark; the separator and the dock fold (with `SHOTS`: `flist-*.png`). The logic under it is `static/tests/cad-featurelist.test.js` |
| `cad-planes-ui` | the default planes and the view cube as Onshape's: the isometric start, names painted on the planes, the orange outline under the pointer, a corner dragged to resize a plane (undone, kept over a reload, seen by a second person), the cube's faces, edges and every visible corner clicked with the pointer where they are on screen (bevel and the face beside it), its hover hint, arrows, roll and menu; Onshape's view keys (arrows, Shift, Ctrl + ← →, Shift + 1 … 7, F, N; none in a text field) and where they are told (with `SHOTS`: planes and cube, a corner under the pointer, light and dark) |
| `cad-partslist-ui` | the parts list: sections, icons and counts, folding, selecting with Ctrl, Shift and the arrows, the model marking the rows and the features that made the selection, hiding and a hidden part's outline, every item of the menu and its dialogs, names and properties stored, undone, seen by a second person and kept over a reload, a viewer |
| `cad-gripes-ui` | what people miss in browser CAD (`ONLY=keys,presspull,marking,timeline,parameters,export,appearance,selection,dual,history,progress,offline`): keys changed, refused, taken, reset and kept over a reload; Press/Pull on a face and an edge; the marking menu, a click in a direction, a flick; the timeline's marker dragged and stepped, a folder folded; the parameters table changing a feature, a variable and a sketch dimension; every part exported into a .zip that opens, a face as DXF and a sketch as SVG from the menus; a swatch dragged onto a part and, with Shift, a face; the selection filter, a set had again after a rebuild, Select other; a second unit; the history of edits clicked back and forward; the rebuild's progress; the connection dropped, edits kept over a closed tab and sent, Save a copy (with `SHOTS`: `gripes-*.png`) |
| `cad-ux-ui` | **how it feels**: light by default, planes with their names painted on them and hidden, a new sketch waiting for its plane, the toolbar following the mode, fitting 1100 px, and at 1500 and 1920 px keeping the most used tools with each specialist section one button, the tool search by name and synonym, units and typed conversions, a fillet's field that keeps adding, dialogs that stay put, the feature list, the view cube, box selection, the menus (with `SHOTS`: light and dark, 1500 and 1100 px) |
| `cad-sketch-ui` | the sketcher: every tool, constraints, dimensions, conflicts |
| `cad-features-ui`, `cad-patterns-ui` | the solid features; reference geometry, patterns, sweep, variables |
| `cad-collab-ui` | presence, Follow, two people in one dialog, the live tab list, comments (`ONLY=tabs,comments`) |
| `cad-board-ui`, `cad-boardlink-ui` | a board in a part studio following the board editor; a part studio driving a board |
| `cad-assembly-ui`, `cad-analysis-ui`, `cad-exchange-ui` | assemblies and mates; inspection, interference, the bill of materials; import and export |
| `cad-history-ui`, `cad-history-mcp`, `cad-history-github` | history, compare, branches; the assistant's tools over `/mcp`; GitHub sync against `scripts/fake-github.mjs` |
| `cad-setting-ui` | the setting: a person with CAD off sees no CAD entries, tabs or requests, a note on a CAD link and on Home's rows, a driven board left as it is; on and off again from the account menu and the app menu without a reload; the MCP list following it |

`scripts/cad-chrome.mjs` is what they share about the chrome (`tool`, `toolTitles`, `toolbarMode`, `openPanel`,
`viewFrom`, `sketchOn`); `scripts/cad-ux-lib.mjs` has signing in, a new part studio, and where a named face or
edge is on screen; `scripts/cad-setting.mjs` turns Mechanical CAD on for a script's user (it is off for a new
account). Each script makes its own users (distinct `github_id`s: give a new script its own range; two
scripts with one id see each other's user and fail in ways that look like presence bugs).

The server embeds the browser bundles when it is compiled, so a change under `server/web` does not show in a
server that is already built: `npm run build`, then `cargo build`. While working, `scripts/cad-static-proxy.mjs`
stands in front of a built server and answers the bundle requests from `server/static` on disk: start the
server on another port with `PUBLIC_URL` set to the proxy's address, then `PORT=8099
UPSTREAM=http://127.0.0.1:18099 node scripts/cad-static-proxy.mjs` and point the browser or the scripts at it.

With `KC_DEV_LOGIN=1`, `/auth/dev?jwt=<token>&next=/` signs a browser in with a JWT signed by `JWT_SECRET`
(`{ sub: <users.id>, login, iat, exp }`, HS256); insert the user row first. In a browser test, wait on
`window.JunctionPartStudio.getState()` (for example `kernel.state === "ready"`) rather than on timers, and
start Chromium with `--use-gl=swiftshader --enable-unsafe-swiftshader` when there is no GPU.

## Reference geometry, patterns and variables

Features `plane`, `axis`, `point`, `helix`, `mate-connector` and the curve features make **datums**: reference geometry kept in the model
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
- **Curves** (the Curve ▾ button: `fit-spline`, `projected-curve`, `bridging-curve`, `composite-curve`,
  `intersection-curve`, `trim-curve`, `isocline`, `routing-curve`) hand their result to `setCurve` in
  `kernel/ops/curves.ts`: one wire when the edges join end to end, else a compound of wires, drawn as one polyline
  with a NaN point between the pieces (`viewport/datums.ts` skips a segment that touches one). Sweep, the curve
  pattern and the other curve features take them as `{ kind: "datum", feature }`.
- A **mate connector** is a datum of kind "plane" with `mate: true` (drawn with its three axes); a sketch, a
  plane field or an axis field takes it like any reference plane.
- The **direct-editing** features (`modify-fillet`, `delete-face`, `move-face`, `replace-face`, toolbar section
  "direct") work on the faces whatever made them: they rebuild the body from the cells its faces' surfaces cut
  space into (`kernel/ops/cells.ts`), so a face moved or removed takes the faces around it along.

**Patterns and Mirror** (`linear-pattern`, `circular-pattern`, `mirror`; `kernel/ops/pattern-core.ts`) copy
bodies, or what earlier features did: the seed's effect on each body is read from `ctx.history` as two tools,
removed (before − after) and added (after − before); every copy is that tool moved, and all copies go into one
cut and one fuse per body. A seed that made a body has the body copied. A copy's faces are named
`<pattern id>:<key>:<seed face name>`, the key naming the copy by its place: `i<n>.<m>` (n-th along the first
direction, m-th along the second, the seed is `i1.1`; a circular pattern uses `i<n>.1`), `m` for a mirror.
Exact for features whose effect does not depend on where they are; a copy of, say, a fillet keeps the seed's
shape. **Sweep** and **Loft** name faces `<id>:start…`, `<id>:end…`, `<id>:side:<sketch entity>`.

**Units** (`document/units.ts`; `studio.getState().units`; the control at the right of the status bar). The
studio item's `units`, `angleUnits` and `precision` say how the document is read and written, for everybody
working on it; the model stays millimetres and degrees, and changing them moves nothing. Everything that writes
a number for a person formats through `units.ts` (`formatLength`, `formatAngle`, `formatArea`, `formatVolume`):
dialogs, sketch dimensions (`sketch/dims.ts setSketchUnits`), the measure readout and what it copies, mass
properties (`inspect/measure-format.ts setMeasureUnits`). Everything typed goes through `parseField`: a bare
number is in the document's unit, a unit typed with it wins ("1 in", "25.4 mm", "3/8 in + 2 mm": a unit follows
a whole product), and expressions and variables work as below. The expression reader knows whether a value
carries a unit, so a variable `width = 40 mm` is 40 mm in a document in inches while `n = 4` is a plain number
that takes the unit of the field it is used in. A stored expression records the unit its bare numbers were
typed in, `params.$unit = { <key>: "in" }` (absent: mm, degrees), so changing the document's units never
changes a size; a sketch dimension's `expr` and a variable's are read in the document's units as they are now.

**Variables** are items `{ id, type: "variable", name, expr, order }` (`document/variables.ts`, the Variables
panel). A number field accepts an expression; the feature keeps the number and the text under
`params.$expr = { <key>: "<text>" }`. The page evaluates every `$expr` again before each regeneration
(`resolveInputs`, in `studio.ts`), and editing a variable rewrites the stored numbers that depend on it in the same
change. A reader of a `.jpart` that does not know variables sees plain numbers. Everything else that builds a part
studio applies them through `studioInputs` (see "Building a part studio outside its page").

**Import** (`features/import-file.ts`, the Import tool, "+" › Import files…) reads a STEP or BREP file stored
with the project into real bodies; faces are named `<feature>:s<solid>:f<face>` by their place in the file.
What was read is kept in the browser as BREP (`kernel/ops/exchange-cache.ts`, IndexedDB, keyed by the file's
document id, size and path; the newest six): the next evaluation in that browser reads the BREP back and does
not download the file. Measured on the 4.4 MB, 22-part demo STEP in Chromium (software WebGL, a busy machine;
`scripts/cad-exchange-ui.mjs` prints it): the Import feature 7.6 s reading the file, 0.5 s from the kept B-rep;
from page load to the model on screen 14.4 s and 7.0 s.

## Custom features: fabrication (`features/cf-fab-*.ts`)

Twenty-five features for laser cutting, CNC routing, woodworking joints and 3D printing, in the Custom features
part of the toolbar (`toolbarSection: "library"`, under More) as two families, "Laser & CNC" and "3D printing".
They are ordinary feature files; what they share is `kernel/ops/cf-fab.ts` (solids drawn from an outline or a
half profile in a frame with every face named, finger spacing, a body read as a plate, an edge face read as a
rectangle, one boolean for many tools, offsetting a face's outline) and `features/_cf-fab.ts` (the two menus,
the clearance and kerf fields, the finger joint). Tested by `static/tests/cad-cf-fab.test.js` (each with its
defaults and with other values, measured) and in the browser by `scripts/cad-cf-fab-ui.mjs`.

Conventions they keep:

- **Fit.** `clearance` opens a joint and `kerf` closes it by what the cutter removes; a joint's openings grow by
  clearance − kerf. Plates that are to be jointed are modelled running through each other (each as long as the
  outside of the corner); the feature shares the overlap out.
- **Where a detail goes.** Joints on a board's end take that face (`refs`, one face) and read it as a rectangle:
  long side, short side, outward normal. Printed details take a sketch's points as Hole does (loose points and
  circle centres) and grow out of the sketch's plane, or into it for holes.
- **Names.** `<id>:<what><n>:<role>` (`<id>:tab2:end`, `<id>:h1:pilot`), `<id>:<sketch point>:<role>` for what
  stands on a sketch point; the faces a body had keep their names.

| Type | Title | What it does |
|---|---|---|
| `cf-fab-laser-joint` | Laser joint | Finger joints wherever flat plates overlap (every pair), fingers as near a width as an odd count allows; a plate that carries on past the joint keeps the ends. |
| `cf-fab-box-joint` | Box joint | A counted row of fingers between two boards at a corner, with a glue gap. |
| `cf-fab-tab-slot` | Tab and slot | Tabs on a plate's edge face, the slots for them in the plates against it. |
| `cf-fab-tslot` | T-slot joint | The captive nut joint: a T through the plate for bolt and nut (ISO 4032 sizes M2–M8), a clearance hole in the plate against the edge. |
| `cf-fab-dogbone` | Dogbone | Dogbone or T-bone relief of the cutter's diameter in every inside corner along the cutter. |
| `cf-fab-kerf` | Kerf compensation | Moves every cut edge of a flat plate into the waste by half the kerf (outline out, holes in), names kept. |
| `cf-fab-living-hinge` | Living hinge | Rows of staggered slits through a plate across a band. |
| `cf-fab-nest` | Auto layout | Lays flat parts on sheets in rows by their rectangles, with spacing, margin and grain lock; copies or moves; the sheets are reference bodies. Not true-shape nesting. |
| `cf-fab-box` | Box generator | A finger-jointed box, one body a panel, from inside or outside sizes; lid none, jointed or lift-off. |
| `cf-fab-fit-comb` | Press-fit test comb | A strip of slots a step apart round the material's thickness. |
| `cf-fab-puzzle` | Puzzle joint | Splits a plate along a seam of jigsaw knobs that point to alternate sides. |
| `cf-fab-mortise-tenon` | Mortise and tenon | A tenon on a board's end, the mortise (clearance, glue gap, round ends) in the board it meets. |
| `cf-fab-dovetail` | Dovetail joint | Through dovetails between two boards at a right-angled corner: tails by count, slope and pin width. |
| `cf-fab-dowel` | Dowel / biscuit holes | Matching dowel holes, or the slots of a 100 mm plate joiner for #0, #10, #20 biscuits, in both boards. |
| `cf-fab-pocket-hole` | Pocket hole | The stepped hole of a pocket-hole jig, at 15° through the middle of a board's end. |
| `cf-fab-snap-hook` | Snap-fit hook | A cantilever hook with lead-in and return angles and a root fillet; warns when the root strain 1.5·t·y/L² passes a limit. |
| `cf-fab-snap-annular` | Annular snap fit | A round plug with a bead (hollow, slit), or the socket with its groove; the same numbers make a pair. |
| `cf-fab-heat-insert` | Heat-set insert hole | The hole for a brass insert from a table M2–M8, deeper than the insert, with a lead-in and an optional screw hole below. |
| `cf-fab-screw-boss` | Screw boss | A boss for a thread-forming screw, pilot and boss diameters from the screw and the plastic, with relief, draft and gussets. |
| `cf-fab-pip-hinge` | Print-in-place hinge | Two leaves with interleaved knuckles on 45° cone pivots, printed flat and assembled. |
| `cf-fab-split-pins` | Split with pins | Splits a part with a plane and adds pins and sockets (or holes for loose pins) at sketch points or automatically. |
| `cf-fab-teardrop` | Teardrop hole | A horizontal hole with a 45° roof, pointed or flat, for a given print direction. |
| `cf-fab-elephant-foot` | Elephant-foot chamfer | A chamfer (inset × height) round the outline, and the holes, of the face on the print bed. |
| `cf-fab-lattice` | Lattice infill | Replaces a part's inside with struts (cubic, body-diagonal or both; square or round), with an optional skin. |
| `cf-fab-honeycomb` | Honeycomb pockets | Hexagonal pockets in a flat face, a border in from its outline and holes; whole cells, or trimmed to the border. |

Limits: the joints want plates that meet square (Laser joint also takes other angles; Dovetail refuses them).
Kerf compensation and the plate features need a flat part of one thickness with square edges. Auto layout packs
bounding rectangles. Lattice infill is bounded (150 struts along the axes, 64 diagonals) and has no gyroid; its
skin needs a part the kernel can offset inward. Split with pins handles a cut that leaves two pieces.
## What people miss in browser CAD, and where it is here

The complaints people most often have about browser CAD, and the things they miss from desktop CAD, each have
one place. All of it is the part studio's (the assembly editor has none of it yet).

| What | Where | How it works |
|---|---|---|
| **Keys a person can change** | `ui/keymap.ts` (pure), `ui/keymap-store.ts`, `ui/KeymapDialog.tsx` | Every tool (by its id) and feature (`f:<type>`) is a command with a default chord (`key`, Shift + letter). A person's overrides, `{ <id>: "<chord>" \| null }`, are kept in the browser (`junction.cad.keymap`) and can be saved to and loaded from a file. `studio.ts onKey` and the sketcher ask `commandForEvent(ev, inSketch)`; the toolbar, the tool search and the sheet of keys show `shortcutOf(id)`. A chord may mean one thing in a sketch and another outside (contexts `sketch`, `model`, `any`); two commands that hear a chord at once are a conflict, shown in the dialog; taking a chord another command has is offered, not done silently; the part studio's own keys (`RESERVED`) and the browser's are refused. Opened from the sheet of keys (**?** › Change keys…) or the tool search. The sheet itself is `KeymapSheet`, which takes any editor's keys as a `KeymapStore` (`keymap-store.ts`; the part studio's is `partStudioKeys`): the assembly passes its own (`assembly/ui/keys.ts`, kept apart in `junction.asm.keymap`, with its own reserved chords through `chordProblem(chord, context, reserved, owner)`). |
| **Press/Pull (Q)** | `ui/press-pull.ts` (pure), `tools/press-pull.ts` | One tool: a flat face or a sketch region starts Extrude with it, a curved face Move face (offset), an edge (or several) Fillet, with the distance field focused. With nothing selected it waits for the next click (`ui.pressPull`; Esc puts it down). |
| **Marking menu** | `ui/marking.ts` (pure), `ui/MarkingMenu.tsx` | A right click puts eight tools round the pointer (`[data-marking]`, items `[data-marking-item=N\|NE\|…]`), chosen by the mode (`markingSlots`): up is the tool started last, again; left is undo; down ends the mode. The ordinary menu hangs clear of it (`markingPlace`). A click in a direction runs that direction's tool. **Flick**: with the preference on, a right drag shorter than 260 ms, between 44 and 420 px and straight runs the tool in that direction and puts the view back; a slower drag turns the view as ever. Both are preferences (`prefs.markingMenu`, on; `prefs.flick`, off), changed from the menu itself. |
| **Timeline** | `ui/timeline-model.ts` (pure), `ui/Timeline.tsx`, `tools/timeline.ts` | The features as a strip along the bottom (`[data-timeline]`): a cell per feature in build order, a folder as a bracket that folds into one cell, a marker that is the rollback bar (drag, the step buttons, ← → Home End; all through `studio.rollTo`). Click selects, double click edits, the pointer over a cell lights up what it made. List / Both / Timeline (`setHistoryView`; `prefs.timeline`, `prefs.featureList`); the button is in the status bar. |
| **Parameters table** | `document/parameters.ts` (pure), `ui/ParametersTable.tsx`, `tools/parameters.ts` | Every variable, every visible number field of every feature and every driving sketch dimension as rows of one window: the expression (edited in place, stored exactly as the feature's own dialog stores it: the number, `$expr`, `$unit`), the value, a comment and a star. A sketch dimension is solved with the new value before it is stored (`applyParameter`). Comments and stars are one item, `{ id: "parameter-notes", type: "parameter-notes", comments: { <row key>: "…" }, favourites: { <row key>: true } }`; a row key is `v:<variable id>`, `f:<feature id>:<param>` or `d:<feature id>:<constraint id>`. |
| **Working offline** | `shared/itemdoc/journal.ts`, `ui/offline.ts` (pure), `panels/offline.tsx`, `tools/save-copy.ts`, `tools/project-backup.ts` | The model is built in the browser and an edit is applied at once, so work goes on when the connection drops; the session already replayed unacknowledged edits after a reconnect. Now they also outlive the tab: `SessionOptions.journal` (a `SessionJournal`; the part studio passes `storedJournal(docId)`, `localStorage` key `junction.itemdoc.pending.<docId>`, 2 MB) is written on every change of the pending list and read by the next session on the document, which sends what was left (`session.restored`). A banner (`[data-offline=offline\|sent\|restored]`) says how many edits wait and when they were sent; **Try now** is `session.reconnectNow()`, also called when the browser says the network is back. **Save a copy** writes the document as it is here to a `.jpart`; **Back up the project** downloads the server's archive. |
| **History of edits** | `ui/undo-labels.ts` (pure), `panels/undo-history.tsx` | `session.history()` is the undo stack (`done`) and what was undone (`undone`); the panel (right dock, folded) lists the steps in words and a click goes to just after one (`goToStep`: so many undos or redos). The words come from the changes alone, with the present document for names. |
| **A rebuild that says how far it is** | `studio.regenProgress`, `ui/StatusBar.tsx` | The worker's `progress` messages reach the status bar: "Rebuilding 5 of 20: Fillet 2" and a bar (`[data-regen-progress]`). A store of its own, so a step redraws the status bar only. |
| **Selection filter, sets, Select other** | `document/selection-sets.ts` (pure), `ui/SelectionControl.tsx`, `ModelView.pickAll` | "Select: All ▾" in the status bar: which kinds a click and a box take (`ui.selectionFilter`, this person's, for the tab's life; a listening dialog field still decides for itself), and selections kept by name: `{ id, type: "selection-set", name, order, picks: [["f"\|"e"\|"v", body, name], ["p", plane], ["d", feature, datum]] }`, by geometry name, so a set follows rebuilds; what is gone is left out and counted. **Select other…** in the right-click menu lists everything on the line of sight, front to back (`pickAll`). |
| **Appearance library** | `document/materials-library.ts` (pure), `panels/appearance-library.tsx` | Thirty-odd standard looks (metals, plastics, others). A swatch dragged onto a part dresses the part, with Shift the face under the pointer; a click dresses what is selected. Stored on the body's look as `color`, `metalness`, `roughness`, optional `opacity`, and `appearance` (the library id): `setBodyAppearance` in `appearance-items.ts`. `appearance-display.ts` hands `metalness` and `roughness` to the material (metalness scaled down while the scene has no environment map, or a metal would be drawn black). |
| **Export every part** | `tools/_batch.ts` (pure), `tools/export-all.tsx` | Each part (or each selected part) to a file of its own, STEP, STL or 3MF, named by a template (`{document} {part} {n} {count} {date}`; equal names get " (2)"), as one stored `.zip` or separate downloads. **A sketch or a flat face as DXF or SVG** straight from the right-click menu and the feature list's menu (`exportDrawing`). |
| **A second unit** | `document/dual-units.ts` | "Also in" in the units control: a second unit in brackets after sketch dimensions and measurements (`25.4 mm [1 in]`), as fine as the first. A person's preference (`prefs.dualUnit`), not the document's. |

Already there before, and so not built again: numbers typed while drawing with Tab between them (`sketch/draw.ts`),
constraint marks and the count of freedoms left, a unit typed with any number, named views, the export dialog's
resolution for meshes, pinned measurements.
## Custom features: power transmission (`features/cf-drive-*.ts`)

Gears, belt and chain drives, mechanisms, shaft details and springs, each an ordinary feature file in the Custom
features part of the toolbar (`toolbarSection: "library"`, `toolbarMenu` "Gears" or "Power transmission",
`toolbarKeep: 0`), found in the tool search by the names people know. Shared code: `features/_cf-drive.ts`
(placement, the involute tooth, a wheel's bore, keyway and hub, features on a cylindrical face),
`_cf-drive-data.ts` (the standards' tables), `_cf-drive-path.ts` (the path round two wheels, belt teeth),
`_cf-drive-spring.ts`, and `kernel/ops/cf-drive.ts` (outlines of lines, arcs and splines built in a `Space`;
extruded, twisted, turned, stacked or sewn into solids with every face named). Tested by
`static/tests/cad-cf-drive.test.js` and, in the browser, `scripts/cad-cf-drive-ui.mjs`.

A part stands on a plane (`plane`, `x`, `y`, `angle`; its axis is the normal). Features on a shaft take its
cylindrical face (`face`) and measure from the end the axis leaves from (`flip`: the other).

| Type | What it makes |
|---|---|
| `cf-spur-gear` | Involute spur gear by module or diametral pitch: profile shift, backlash, root fillet, bore, DIN 6885 keyway, hub |
| `cf-helical-gear` | Helical gear (normal module, helix angle, hand); the flanks are involute helicoids |
| `cf-herringbone-gear` | Double helical gear, the two hands meeting mid-face |
| `cf-internal-gear` | Ring gear with involute teeth inside |
| `cf-rack` | Straight rack for a gear of the same module; its pitch line is the plane's x axis |
| `cf-bevel-gear` | Straight bevel gear (Tredgold's tooth, tapering to the apex) from two tooth counts and a shaft angle; optionally its mate, in mesh |
| `cf-worm` | ZA worm, its wheel (a helical gear at the lead angle, not throated), or both in mesh |
| `cf-planetary` | Sun, planets and ring as bodies, in mesh; refuses sets that cannot be assembled |
| `cf-cycloidal` | Cycloidal reducer disc from its pin ring and eccentricity, output holes, optionally the pins |
| `cf-timing-pulley` | Timing pulley: GT2, GT3, HTD 3M/5M/8M, T2.5/T5/T10; flanges, bore, keyway, hub |
| `cf-timing-belt` | Closed toothed belt round two pulleys, by belt teeth or centre distance (the body's name gives the centres) |
| `cf-v-pulley` | V-belt sheave, Z/A/B/C and SPZ…SPC grooves by ISO 4183, one or several |
| `cf-sprocket` | Roller chain sprocket, ANSI 25…100 and ISO 04B…20B, ISO 606 tooth form |
| `cf-chain` | Closed roller chain round two sprockets, link by link (one body of many solids) |
| `cf-ratchet` | Ratchet wheel and its pawl |
| `cf-geneva` | Geneva wheel and its crank with pin and locking disc |
| `cf-cam` | Plate cam from rise, dwell and fall with a motion law, or a table of lifts; knife or roller follower |
| `cf-spline` | Involute (DIN 5480 proportions) or straight-sided (ISO 14) spline: a shaft, or with Remove a hub's bore |
| `cf-keyway` | Keyseat in a shaft or keyway in a bore, DIN 6885 by the picked face's diameter |
| `cf-stepped-shaft` | Shaft from a table of steps ("20 x 30, 25 x 50"), end chamfers, shoulder fillets, hole through |
| `cf-d-cut` | Flat on a shaft, or a double D |
| `cf-bearing-seat` | Housing bore and shoulder for a ball bearing by its number, and a stand-in for the bearing |
| `cf-ring-groove` | Retaining ring groove, DIN 471 on a shaft or DIN 472 in a bore, by the picked face's diameter |
| `cf-compression-spring` | Compression spring: open, closed or closed and ground ends, to a free length |
| `cf-extension-spring` | Close-wound extension spring with machine hooks |
| `cf-torsion-spring` | Torsion spring with tangent legs |

Not done, honestly: no throated (enveloping) worm wheel; the chain's free strands lie on the tangents, not
seat to seat; bevel gears have no root fillet and no keyway; an involute spline cut from a body (Remove) takes
several seconds, as does adding a gear to a body, because each flank is cut by the kernel's general
intersection; springs take about a second (the wire is swept along a spline); a bearing is rings and shields
without balls; the timing belt profiles are drawn from the published tooth dimensions, not from a maker's
pulley drawings.
## Custom features: threads, fasteners, enclosures and hardware (`features/cf-hw-*.ts`)

Twenty-six features in the toolbar's Custom features ▾ drop-down (`toolbarSection: "library"`), in two families
(`toolbarMenu`): **Threads & fasteners** and **Enclosures & hardware**. They are ordinary feature files; nothing
else knows about them. Tests: `static/tests/cad-cf-hw.test.js` (every feature with its defaults and in one other
case, measured against the real kernel); in the browser, `scripts/cad-cf-hw-ui.mjs`.

| Type | Title | What it does |
|---|---|---|
| `cf-hw-thread` | Thread | a modelled helical thread on a shaft: ISO metric coarse and fine, UNC, UNF, or any pitch; chamfered start, run-out, left hand, several starts, allowance |
| `cf-hw-thread-internal` | Internal thread | the same in a hole (fitted to the tap drill, or opened up to the size picked); countersunk mouth, fades out at the bottom of a blind hole |
| `cf-hw-pipe-thread` | Pipe thread | a tapered pipe thread, NPT or BSPT, on a pipe's end or in a hole; it vanishes into the pipe's surface |
| `cf-hw-thread-cosmetic` | Cosmetic thread | a helix curve of the thread's pitch and length on the face (a reference curve), no faces |
| `cf-hw-bolt` | Bolt | hex, socket cap, button or countersunk screw, M2 to M24 by length; plain shank or modelled thread |
| `cf-hw-nut` | Nut | hex, self-locking, square or wing nut; plain hole or modelled thread |
| `cf-hw-washer` | Washer | plain (ISO 7089), large (ISO 7093), spring (DIN 127) by size, or any ring |
| `cf-hw-standoff` | Standoff | hex or round spacer, female-female or male-female; plain or modelled threads |
| `cf-hw-fastener-holes` | Fastener holes | one screw's holes through a stack of parts: head seat in the first, clearance between, tapped or insert hole in the last |
| `cf-hw-nut-pocket` | Nut pocket | a hexagon or square recess for a captive nut, or a side slot the nut slides into, with the bolt hole |
| `cf-hw-knurl` | Knurl | a diamond or straight knurl in place of a round face |
| `cf-hw-enclosure` | Enclosure | a box in two bodies, Base and Lid: wall, corner radius, locating lip, screw bosses |
| `cf-hw-lip-groove` | Lip and groove | a lip along the rim of one half of a housing and its groove in the other |
| `cf-hw-pcb-mounts` | PCB mounts | posts in a board's hole pattern (Raspberry Pi, Arduino, any rectangle): screw hole, insert hole or pin |
| `cf-hw-oring-groove` | O-ring groove | the gland for an AS568 / ISO 3601-1 ring round a shaft, in a bore or in a flat face; static or dynamic |
| `cf-hw-oring` | O-ring | the ring as a body, by dash number or dimensions, free or stretched |
| `cf-hw-gasket` | Gasket | a flat gasket in the shape of a face, holes and all, optionally drawn back from the edge |
| `cf-hw-bearing-pocket` | Bearing pocket | the seat for a ball bearing by designation (608, 6204 …) with its shoulder |
| `cf-hw-magnet-pocket` | Magnet pocket | a press-fit pocket with crush ribs for a disc or block magnet |
| `cf-hw-mount-pattern` | Mount pattern | NEMA 8 to 34 motor faces and VESA 75 to 400 display mounts; slots for belt tension |
| `cf-hw-vents` | Vents | a field of slots, slanted louvres, round holes or a hexagon honeycomb, as one cut |
| `cf-hw-cable-gland` | Cable gland hole | the hole for a PG or metric cable gland (clearance or tapped, D flat, seat), or a grommet with its body |
| `cf-hw-feet` | Feet | four feet at the corners of a rectangle, or recesses for stick-on bumpers |
| `cf-hw-din-clip` | DIN rail clip | a clip that snaps onto 35 mm top-hat rail, with screw holes |
| `cf-hw-hinge` | Hinge | a butt hinge: two leaves with interleaved knuckles and a pin, three bodies, drawn at any opening |
| `cf-hw-knob` | Knob | a lobed, knurled or round hand knob with a stem and a bore for a nut, a bolt head, a D shaft or an insert |

**Where one goes.** The features that stand on something share three fields (`features/_cf-hw.ts whereFields`,
`kernel/ops/cf-hw.ts spots`): *Locations* (sketch points, vertices, round edges for their centres, reference
points; one copy at each), *Plane or face* (what it stands on; sketch points bring their sketch's plane), and
*Turn* / *Opposite side*. With no location it goes to the middle of the picked face, or the plane's origin. The
features that work on a cylinder (the threads, Knurl, a radial O-ring groove) take its face instead and find
out for themselves whether it is a shaft or a hole.

**Names.** `kernel/ops/cf-hw.ts` builds solids from outlines (`extruded`, `revolved`) and names each face after
the piece of outline that swept it: `<id>:<role>`, with `<id>:<location>:<role>` when locations are picked
(the location is the sketch point's id or the picked geometry's name, so a name survives other locations being
added or removed). Faces with the same role are numbered by the engine (`~2`, `~3`, geometric order). Each
feature file lists its names at its top.

**The tables** are in `features/_cf-hw.ts`, with their sources: thread sizes (ISO 261/262, ASME B1.1, ASME
B1.20.1, ISO 7-1), fastener, nut and washer dimensions M2 to M24 (the holes for M2 to M12 are the Hole feature's
own table, `kernel/ops/holes.ts`), AS568 O-rings by dash number (generated from the standard's rule, -001 to
-050, -102 to -178, -201 to -278, -309 to -381, -425 to -460) with Parker's industrial gland dimensions, ball
bearings (ISO 15), NEMA and VESA patterns, cable gland threads, and the hole patterns of a few circuit boards.

**The modelled thread** (`kernel/ops/cf-hw-thread.ts`) is not a sweep and not a boolean with a helix: both are
slow in this kernel (seconds for a few turns) and fragile. The thread's surface is written down directly. Its
axial profile is a trapezoid (root flat, flank, crest flat, flank; ISO 68-1's flats of P/4 and P/8 and depth of
5/8 H for the 60° forms); each of the four pieces, wound round the axis, is a surface of its own, sampled every
12° and fitted with a cubic B-spline surface through the samples (`surfaceThrough`: an interpolation with even
parameters, so that two neighbouring pieces get the very same curve where they meet). The result is within a
tenth of a micrometre of the true helicoid at M8, and a rod threaded this way has the profile's exact section
(tested: its volume to 2 parts in 10 000, and the number of turns a bar along the axis crosses). Because the
surface is a formula, taper, the chamfered start, the run-out and a pipe thread vanishing into its pipe are the
same code: `clip` says how much of the profile's height exists at each place along the axis.

Putting it on a body (`threadInto`, and `boreStock` + `graft`, which Knurl also uses): the stock the thread lies
in is removed with a plain tube (an ordinary cut), which leaves a round wall and a circle on each end face; the
wall is thrown away, each circle is replaced by the thread's own end curve, and the thread's faces are sewn in.
No boolean ever sees the thread. If the end faces are not what a tube leaves, it falls back to joining a
threaded sleeve with a boolean (slow, and not met in the tests).

Limits of the hardware features, honestly:

- **Thread forms.** The 60° forms are the basic profile: flat crests and roots, no root radius, no tolerance
  class (`Allowance` moves the whole profile). BSPT's rounded crests and roots are modelled as flats of P/6 at
  the right height and flank angle. No trapezoidal (Tr, Acme) or buttress forms yet, though `threadSurface`
  would take them (they are a depth and two flats).
- **A thread's faces are B-spline surfaces**, not cylinders: a crest cannot be picked as a cylinder (for an
  axis, a concentric mate). The rest of the body keeps its faces and names.
- **Where a thread ends against the shaft's own surface** (part-length threads, a pipe thread) it stops 0.02 mm
  (or 3 % of its depth) short of that surface, leaving a ring that narrow, so that no face is degenerate.
- **Speed.** A thread costs about 25 ms a turn plus 150 ms (M8 × 16: 0.4 to 0.6 s); a diamond knurl about 1 ms
  a facet (Ø20 × 10 at 2 mm pitch: 750 facets, 0.8 s); the default Enclosure about 1 s (fifteen booleans).
  Everything else is well under half a second. Modelled threads on a Bolt, a Nut or a Standoff are opt-in
  for that reason; the default is a plain cylinder of the major (or minor) diameter.
- **Knurl** needs a plain round face ending in flat faces, chamfers or steps; its facets are flat. It replaces
  the whole face (no partial length).
- **Fastener tables** stop at M24 and are nominal sizes; the wing nut follows DIN 315's proportions, not its
  table; the heat-set insert holes are typical brass inserts (check the maker's sheet). Unified (inch) sizes
  are in the thread features only, not in Bolt, Nut or Fastener holes.
- **O-ring glands** are Parker's for the five AS568 cross-sections; other sections are scaled from the nearest.
  ISO 3601's metric-only sizes (class B) are not in the table: give the two dimensions.
- **Cosmetic thread** is a reference curve; it does not mark the face as threaded for a drawing or an export.
- **Enclosure** is a rectangular box with four corner bosses. Lip and groove follows the outside edge of one
  flat face (not a split line that steps or curves out of plane). Vents with a louvre angle cut slanted slots;
  they do not form a raised hood.
- **DIN rail clip** is rigid plastic with a ramped latch: it relies on the material's give, there is no
  separate spring arm.
## Custom features: patterns, texture, geometry and utilities (`cf-geo-*`)

Twenty-six features of the Custom features drop-down (`toolbarSection: "library"`), in two families:
`toolbarMenu: "Patterns & texture"` and `"Geometry & utilities"`. They are ordinary feature files,
`features/cf-geo-<name>.ts`; what they share is in `features/_cf-geo*.ts` (pure: lattices, Voronoi cells, seeded
random numbers, an expression reader, NACA sections, the catenary, QR and Data Matrix encoders, a PNG reader, a
convex hull) and `kernel/ops/cf-geo*.ts` (a flat face as a region of its plane, text as faces, pipes, many tools
into a body in one boolean). Tests: `static/tests/cad-cf-geo.test.js` (the real kernel; every feature with its
defaults and another setting); in the app: `scripts/cad-cf-geo-ui.mjs`.

**Patterns & texture**

| Type | What it makes |
|---|---|
| `cf-geo-attractor-pattern` | a grid of copies whose size and turn follow their distance from a point or curve |
| `cf-geo-fill-pattern` | copies on a grid, hex or staggered lattice wherever it lies on a flat face, a margin from its edges |
| `cf-geo-scatter-pattern` | copies at seeded random places on a flat face, kept apart, optionally turned and sized at random |
| `cf-geo-phyllotaxis-pattern` | copies on the sunflower spiral: place n at spacing·√n and n golden angles |
| `cf-geo-surface-pattern` | copies spread over a face in its own two directions, each standing on the surface |
| `cf-geo-voronoi` | a flat face cut into Voronoi cells with walls of one width, through or to a depth |
| `cf-geo-halftone` | holes over a flat face whose sizes follow a gradient or a picture a sketch holds |
| `cf-geo-texture` | domes, dimples, hex studs, pyramids or ribs over a flat face; all but ribs round a whole cylinder |
| `cf-geo-text` | lettering raised from or cut into a flat face, laid round a cylinder, or projected onto another face |
| `cf-geo-text-on-curve` | lettering whose baseline follows a path, extruded as a body, added or cut |
| `cf-geo-qr-code` | a QR code (versions 1 to 10) or Data Matrix (to 48 × 48) of a text, raised, cut, or as a tile |
| `cf-geo-lithophane` | a plate whose thickness follows a picture, or an equation z(x, y): one smooth surface, not facets |

**Geometry & utilities**

| Type | What it makes |
|---|---|
| `cf-geo-equation-curve` | a reference curve from x(t), y(t), z(t) (or r, θ, z); radians |
| `cf-geo-point-curve` | a reference curve through x y z points pasted from a table, smooth or straight |
| `cf-geo-airfoil` | a wing lofted between NACA four-digit sections or pasted coordinates: taper, sweep, dihedral, twist |
| `cf-geo-tube` | a round tube or bar along a path, with one bend radius at the corners of straight runs |
| `cf-geo-cable` | a cable hung between points as a catenary, by slack or by sag; a body or its centre line |
| `cf-geo-spiral` | a flat (Archimedean), conical or logarithmic spiral: a curve, or a coil of wire |
| `cf-geo-stock` | the block or round bar round bodies, with an allowance, rounded up to stock sizes |
| `cf-geo-centre-of-mass` | a reference point, or a mate connector, at the bodies' centre of mass |
| `cf-geo-measure` | a distance, angle, length, area, volume or extent, written into a variable for later features |
| `cf-geo-convex-hull` | the convex hull of bodies: exact for flat faces, facets within an accuracy of round ones |
| `cf-geo-hollow` | a solid hollowed to a wall, drain holes through its low side, optionally split along a plane |
| `cf-geo-auto-fillet` | every edge of a body that passes a filter (outside or inside corner, sharpness) rounded or bevelled |
| `cf-geo-slice` | sections of bodies on parallel planes, as flat surfaces (profiles for Extrude) or as curves |
| `cf-geo-scale` | bodies scaled evenly, or by a factor each along X, Y and Z |

What is particular to them:

- **Copies with a size** (`copySites`, `kernel/ops/cf-geo.ts`). The attractor, scatter and Fibonacci patterns
  size their copies. A seed that is a straight extrusion square to the pattern (a hole through a plate, a
  pocket, a boss) is sized across the pattern only: the copy is the seed's cross-section, sized, pushed through
  the seed's own height, so a hole stays through. Any other seed is sized evenly in every direction. Names are
  the patterns' own, `<id>:<key>:<seed face name>`, the key a place (`i3.2`, `g-1.4`, `f17`) or, for a scatter,
  an order (`r5`).
- **Tools on a face** are named `<id>:<tag>:<n>`: the tag a lattice place, a cell, a letter's index, a module of
  a code; n counts the tool's own faces. Raised shapes start 0.01 mm inside the face and cut ones 0.01 mm above
  it (`OVERLAP`), so that nothing ends exactly on the face; all of a feature's tools go into one boolean.
- **Pictures** (`_cf-geo-image.ts`) are ones a sketch holds (the sketcher's Image tool), named by a `features`
  field of type `sketch`, and are read where the sketch shows them. PNG is decoded in the worker and in node
  alike; JPEG by the browser's decoder, which node has not.
- **Measure to variable** has a page half, `tools/cf-geo-measure-sync.ts`: the feature leaves
  `measure: { name, value, unit }` on its datum, and after each regeneration the page writes the values into the
  document's variables (`features/_cf-geo-measured.ts`; added if missing, rewritten if changed, not undoable,
  never from a dialog's draft, an open sketch or an earlier version). Features below that use the variable are
  rebuilt in the regeneration that follows. Outside the page (an assembly, the assistant's host) the variable has
  the value the page last wrote.
- **Limits.** Uneven scaling refuses a body with a face that goes all the way round (a plain hole, a shaft):
  such a face does not come back sound (flat, blended and free-form bodies are stretched; even scaling takes
  anything). A texture or text on a cylinder costs about 50 ms a shape or letter in the kernel's boolean. A
  wing's skin is one face per span of its outline, and a height map's relief many knots in one face, because the
  kernel's mass properties are poor across a curve's inner knots. Slices are surfaces or curves, not sketches:
  the profile field lists Sketch features only, and takes a slice as a flat face.

## Custom features people write (`script/`)

A person (or the assistant, or an agent over MCP) can write a feature as a short JavaScript file: a title, an
icon, parameters and an `evaluate`. The page people read is [`docs/WRITING_CUSTOM_FEATURES.md`](../../../../docs/WRITING_CUSTOM_FEATURES.md)
(written from `script/assets/prompts/guide.md`, which is also what the assistant reads); the API is
`script/assets/feature-api.d.ts`, **the one description of it**: the editor's completion and hover
(`script/apidoc.ts`), the guide and the assistant all read that file, and a test type-checks every shipped
example against it and checks the sandbox defines every name in it.

| File (under `mechanical/`) | What |
|---|---|
| `script/assets/feature-api.d.ts`, `prelude.js` | The API as types, and its inside-the-sandbox half (the `ctx`, `Body`, `Face`, `Edge`, `Geo2`, `V3` a script sees). |
| `script/assets/exemplars/*.js` | The features that ship as scripts: Lighten plate (truss, isogrid, hex), Hole-to-hole slot, Angle bracket, Vent pattern, Engrave text. |
| `script/assets/prompts/*.md` | The guide, the assistant's instructions, each tool's description. Improve these, not code. |
| `script/sandbox.ts`, `limits.ts` | The QuickJS interpreter a script runs in, its limits, its errors. |
| `script/host.ts` | The fixed table of operations a script can ask for, on the feature's `EvalContext`. |
| `script/geom2d.ts` | `Geo2`: regions, offsets and booleans (Clipper2), rounding, arcs read back from polygons, Delaunay, Voronoi, cell patterns, text. Pure. |
| `script/run.ts`, `runner.ts`, `features/script.ts` | Building a `script:…` feature in the worker. |
| `script/report.ts`, `report-text.ts`, `png.ts` | Running a script on a part studio and saying what came of it (the one report the editor, the assistant and MCP read); what a part looks like to a script's author. |
| `script/manifest.ts` | What a script declares, as data: types, the checks on stored data, the dialog's schema from it. Pure. |
| `script/library.ts`, `store.ts` | The project's library: where scripts are kept and every edit of them; the page's live view of it. |
| `script/ui/` | The editor (`EditorPanel`, `CodeEditor`, `editor-state`), the library dialog, the assistant's box, the difference view. |
| `script/assistant/` | The assistant's loop (`loop.ts`) and the model client (`client.ts`). |
| `services/script-*.ts` | `script-describe`, `script-last-run`, `script-run`, `script-part-summary`. |
| `mcp/script-host.ts`, `mcp/script-tools.json` | The `cad_script_*` tools. |
| `panels/script-editor.tsx`, `tools/script-new.ts`, `tools/script-library.ts` | Where the page picks all of this up. |

`scripts/gen-cad-script-assets.mjs` (run by `gen-cad-registry.mjs`) writes the assets and the interpreter's
`.wasm` into `generated/` as modules, and the docs page.

### Where a script lives, and what a feature made from it is

- **The library is the project's own document** (`project.jproj`): one item per script,
  `{ id: "cfs:<id>", type: "feature-script", name, source, manifest, order }`, beside the tab order. So scripts
  are shared live with everybody in the project, versioned, archived and synced with it, and offered in every
  part studio of it. The source is one value: two people saving one script at once, the later wins, and the
  editor says when the script changed under it.
- **A feature made from a script is an ordinary feature item** whose `featureType` is
  `script:<script id>.<hash of the source>` and whose `params` hold the script under `$script`
  (`{ id, name, hash, source, manifest }`) and one value per parameter beside it. **It carries its own copy**:
  a part studio builds the same wherever it is built (an assembly, Compare, an earlier version, the assistant's
  host) and whatever happens to the library, with no input filter. `library.ts versionOf` says how the copy
  stands against the library; the feature's row says "update" (one click, `updatedFeature`: the new type and
  script, the values kept, new parameters at their defaults) or "own copy" when the script is gone.
- **In the worker** `kernel/regen.ts` hands a type `x:y` it has no definition for to the definition `x`:
  `features/script.ts` builds every `script:…` feature from the source it carries.
- **On the page** `featureDef` and `studio.definitions()` also ask `core/dynamic.ts`, where `script/store.ts`
  answers with a definition per script version (the library's, the editor's working ones, the ones the open
  studio's features carry): title, icon, schema and defaults from the manifest. That is why the dialog, the
  toolbar (Custom features ▸ **This project**), the tool search, the feature list, the Parameters table and
  the collaboration guard need no case for scripts.
- **A stored manifest is somebody else's data.** It is read only through `manifest.ts cleanManifest` /
  `cleanScriptRef`, which keep what they recognise. An icon is a name from `ICONS` or path data checked
  character by character; it is never markup from a document (`Glyph` sets innerHTML). The worker never reads
  the stored manifest at all: it reads the source again in the sandbox.

### The sandbox: what the isolation is

Scripts are shared, so one person's script runs in another person's browser, and on the server in the
assistant's host. A script is **never given to the JavaScript engine of the page, the worker or node**. It is
text handed to QuickJS compiled to WebAssembly (`quickjs-emscripten`), which has the language and nothing else:
no `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `postMessage`, `self`, `indexedDB`, DOM, `process`,
`require`, module loader, timers or clock. The only way out is one function taking two strings and returning
one (`__host(op, argsJson)`), answered from a fixed table (`host.ts`); values cross as JSON, and bodies, faces
and edges cross as names. A script can therefore read the model of its own part studio at its place in the
feature list and change that working copy, and nothing else: not another document, the page, cookies, the
network or the kernel's raw bindings.

Bounds: 64 MB of interpreter memory, a capped stack, 50 000 API calls, and a time allowance that is counted in
interpreter work (the same script stops at the same place on any machine) with a wall-clock limit of 30 s
behind it; each API call is bounded in what it may bring (regions, points, bodies). A fresh interpreter per
evaluation. No `Date`, and `Math.random` repeats, so a feature rebuilds the same. Whatever a script does wrong
ends as a `FeatureError` with a sentence and, where there is one, the line; the engine leaves the model as the
feature found it and the next features run. **The soundness check of `regen.ts` applies to script features as
to any other.**

What it does not protect against: one kernel call cannot be interrupted, so a script can spend its whole
allowance in a few heavy operations (the page stays responsive; the worker is busy, as for any slow feature); a
script can make a wrong or ugly part; and a bug in QuickJS or in the engine's WebAssembly is outside it. If
the engine under the interpreter throws (its own stack, an abort), that instance is dropped and the next run
gets a fresh one (`loadSandbox`).

### The editor, and writing with the assistant

- **The preview is a real feature draft** (`studio.startFeature` / `setDraft({ featureType })`): the generated
  dialog is the real dialog, the preview the real regeneration, "Add to part" the dialog's ✓. Each pause in
  typing asks `script-describe`; a script that reads moves the draft to the new version, one that does not
  leaves the last good preview up with the problem on its line. Console output and reports come from
  `script-last-run`. Nothing reaches the project until Save. `window.JunctionScriptEditor` while it is open.
- **The assistant** (`assistant/loop.ts`) is a plain tool loop: `run_script` (build a candidate on the part on
  an engine of the worker's own, answer with the report and a picture), `get_part`, `propose_script` (refused
  unless that exact source has just built a sound result). The proposal is shown as a difference with the
  preview moved to it; Accept changes the buffer, Discard puts the preview back.
- **The model is the person's own.** The server holds no model key (`server/src/ai.rs`): the person pastes an
  API key and picks a model from the list the key can use (`assistant/client.ts`, the official SDK, called
  from the browser). Both are kept in that browser's localStorage, so any script running on this site could
  read them: the settings say to use a key made for this, with a spending limit. No model is named in code.
  A page may set `window.JunctionScriptAssistant.model` to another `ModelClient` (the browser test's scripted
  one).
- **Over MCP** an outside agent has the same loop: `cad_script_guide` (the guide, the types, the examples),
  `cad_script_list`, `cad_script_read`, `cad_script_validate`, `cad_script_run` (a trial; the same report and
  picture), `cad_script_write` (save to the library; with `add_to` also add the feature to a part studio when it
  builds a sound result there).

### Adding to the API

Add the function to `feature-api.d.ts` with its comment, to `prelude.js` (a method that calls the host), and
to `host.ts` (the operation: check every argument, bound what it may bring, fail with a sentence). A `Geo2`
function goes in `geom2d.ts` and the list in `prelude.js`. `cad-script-api.test.js` fails if the three disagree.
Keep it small and stable: scripts in people's projects are written against it, and a feature's own copy of its
script is run as it is for as long as the part exists. A change that old scripts would get wrong needs a new
function, not a new meaning.

Tests: `cad-script-sandbox`, `cad-script-api`, `cad-script-exemplars`, `cad-script-library` (node, the real
kernel and interpreter), `scripts/cad-script-ui.mjs` (the browser, two people), `scripts/cad-script-mcp.mjs`
(the MCP endpoint).

## Limits, in one place

- **Custom features people write.** A script's own copy in a feature is not merged: updating takes the
  library's version whole. The editor's completion knows the API's names and the type of a few usual variable
  names (`ctx`, `face`, `body`, `Geo2`), not the types of expressions. The assistant needs the person's own API
  key, kept in their browser. One kernel call inside a script cannot be interrupted. `face.outline()` gives
  lines and circular arcs; any other curve comes as points. Text is set in one font.

- **Sketcher.** No ellipse, spline or text. Use edge takes straight and circular edges, and what it draws does
  not follow the model afterwards (the source is recorded as `from`). A sketch cannot use a feature that comes
  after it in the tree: to project a board's outline, the Board feature must come first.
- **Regions** come from the curves as drawn: a region id may change when the curves around it are redrawn, and a
  feature that listed it then says its regions are gone.
- **Solid features.** Not done: up to face with an offset, up to a vertex or body; a fillet that stops tangent
  propagation, a conic or curvature-continuous cross section, a partial fillet (the kernel's fillet builder makes
  circular sections over whole edges only); hole threads (a tapped hole is its tap drill); offset face. Move
  face's offset and Replace face take flat and cylindrical faces only; Trim curve works on a curve of one edge and
  extends it straight; Isocline samples each face on a 48 × 48 grid of its parameters. "Up to face" on a curved face stops at that face's body. Revolve's axis is a loose line of its
  sketch, the sketch's X or Y, or anything picked: an edge, a line of any sketch, a reference axis.
- **Patterns** copy what a feature did, moved; a copy of a feature whose shape depends on where it is (a fillet
  meeting other geometry) keeps the seed's shape.
- **Feature list.** Of Onshape's "Features and Parts Lists" page, not done because Junction has no such thing:
  the configuration drop-down, release marks, `:partnumber` and `:revision`, part properties. A folder cannot be
  empty (the last thing moved out removes it). Paste sketch makes a new sketch; it does not paste into the open
  one. Regeneration times are of each feature's last build in this browser; there is no "rebuild everything to
  time it". While regeneration is paused, edits other people make are not rebuilt either, and are not counted
  among "yours". The yellow "missing selections" mark is the ordinary error mark: a lost reference is an error.
- **Geometry names** have the limits listed under "Geometry names".
- **One kernel thread per worker, no cancellation.** A long evaluation blocks the next; the page stays responsive.
- **Meshes** are per body, not per view: a small hole on a large part with hundreds of faces is an octagon when
  zoomed into (see "Meshes"); there is no refinement on zoom.
- **Kernel memory** is released per cached feature; a very long session on a very large model has not been profiled.
- **Import.** The cache is per browser: every collaborator's browser reads a file once. A file replaced under
  the same document id and size would be served from the cache; uploads never do that. Reading a large STEP for
  the first time is as slow as it was (the 24 MB module of the demos took about a minute and a half to first
  draw before the cache existed; with it only the first read in a browser pays that, and that file has not been
  timed again).
- **Boards.** See the READMEs. Here: a board is not part of a version (an earlier version shows the board as it
  is now); outside the studio's own page part envelopes come from the footprints, not the 3D models, so a tall
  connector's box may differ slightly between an assembly and the studio (names do not); a board lying parts
  side down can be shown but the height limits of a link assume the front faces away from the plane.
- **Assemblies.** See the README. Here: the parts inside a sub-assembly are not checked for interference; a
  board inserted before it has been read is placed at the sheet's origin, not its middle; no earlier version on
  screen, no Compare, no MCP tools, no thumbnail.
- **Collaboration.** Edits merge per path, last writer wins; two direct commits to one parameter: the later one
  wins, silently. No lock on a feature someone else has open, by design. Not done: a thread on a sketch entity
  or an assembly instance; mentions; a pin hidden behind the model is still drawn. Who is on which tab is only
  shown in projects that have the project's own document (every project made blank, and any project once a tab
  was reordered or a folder made), a part studio or an assembly.
- **Merging** keeps the journal's rule that a delete beats a modify: a conflict "removed here, changed there"
  resolved for the changed side keeps the item only on the side that still has it. Arrays merge as one value.
- **The assistant's picture** (`cad_render_view`) is a software render: orthographic, smooth shading from the
  mesh's normals, edges, a section that discards what is cut away (the cut is not capped: the inside is drawn
  dark), no sketches or planes, no perspective, no text in the picture.
- **Bundles:** `mechanical.js` and `assembly.js` each bundle three.js and React, loaded on demand. Sharing them
  with `viewer3d.js` and `ui.js` is not done.
- **What people miss in browser CAD.** A person's keys, the marking menu, flick and the timeline are kept per
  browser, not per account (Save… and Load… carry the keys); the assembly editor has none of them. A flick is a
  matter of timing (260 ms). The timeline has no menu of its own and does not reorder features. The parameters
  table lists number fields only (no checkboxes or choices), and a sketch dimension is solved by the page (the
  solver must load). The offline journal holds 2 MB per document, is per browser, and an edit whose
  acknowledgement was lost is sent again by the next visit: the server drops an edit it knows by id only while it
  remembers it. A page cannot be opened without the connection: only a page that is already open goes on
  working. A face dressed from the appearance library gets the colour only. Selection sets keep no sketch
  regions; a selection filter lasts for the tab. There is no paint selection, no saved section views, no
  curvature or draft analysis, and no direct-edit mode without history.
- **Windows narrower than about 1000 px:** the toolbar scrolls sideways; the docks fold by hand, not by
  themselves; nothing is laid out for phones.
- **The part studio's interface, not done:** folders in the feature list; the assistant's tools and Compare show a part
  under the kernel's name, not the one a person gave it (`document/part-items.ts`); the parts list's rows are
  not filtered by the feature list's search box; undo and redo do not bring back the
  selection or an open dialog; the mouse buttons cannot be remapped; the kernel's download shows a spinner, not
  how far it is; a plane's name is drawn over the model when its corner is behind it; inference lines cannot be
  turned off (constraint marks can); a sketch dimension's expression with bare numbers, and a variable's, follow
  the document's units when those change (a feature's number field does not: it records its unit); the section
  view's offset field is in millimetres whatever the units; the highlight of what a dialog's fields hold cannot
  be had for a feature that is suppressed or failed before it was built.
