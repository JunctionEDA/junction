# Mechanical CAD

Status: **in progress**. The part studio: a parametric modeller in the browser, on OpenCascade compiled to
WebAssembly, with the history tree synchronized item by item like every other document.

**Read [CONTRACT.md](CONTRACT.md) before adding anything.** It has the document formats, the feature, tool,
panel and service registries (one file each, found by folder, no shared index to edit), the worker protocol,
the geometry naming scheme and its limits, how changes are committed and synced, how to run and test, and
which folder each piece of future work belongs in.

**What works.** A project holds part studios (`.jpart`) beside its schematic and board, as tabs. In a part
studio: sketch lines, rectangles and circles on a plane or a planar face; extrude as a new body, added or
removed; a feature list with edit, rename, suppress, reorder, delete, a rollback bar and an error state per
feature; regeneration in a worker that rebuilds only from the first changed feature; a 3D viewport with
orbit, pan, zoom, standard views, and hover and selection of faces, edges and vertices; live co-editing; undo.

**What does not, yet.** Sketch constraints and dimensions, every feature but Sketch and Extrude, measurement,
import and export. CONTRACT.md lists the limits in one place.

**Layout.**

```
core/        the contracts: feature.ts, tool.ts, geometry.ts
document/    the .jpart format and every edit as item changes
sketch/      sketch data format, region finding, the drawing engine
kernel/      worker side: OpenCascade helpers, regeneration, tessellation, the protocol, the page's client
features/    one file per feature type          (sketch.ts, extrude.ts)
tools/       one file per toolbar tool
panels/      one file per docked panel
services/    one file per worker service        (mass-properties.ts)
viewport/    bodies, planes, sketches, highlighting and picking, on shared/viewport3d
ui/          the part studio controller and its React frame
api.ts       what other domains may import
index.tsx    the bundle's entry (static/dist/mechanical.js); kernel/worker.ts is static/dist/cad-worker.js
generated/   written by scripts/gen-cad-registry.mjs; not committed
```

**Kernel.** npm `replicad-opencascadejs` (OpenCascade, LGPL-2.1 with the Open CASCADE exception): bindings
only. The 23 MB `.wasm` is fetched by the worker the first time a part studio regenerates.

**What it gets from the platform.** Projects, sharing and roles, the collaboration socket and storage come
from `server/web/platform`, `server/web/shared` and the server, through `shared/itemdoc`. Version history,
comments and the AI (MCP) connection are not wired to these documents yet (CONTRACT.md says exactly what is).
Its entry in [`../registry.ts`](../registry.ts) says which files it opens.

See [docs/ROADMAP.md](../../../../docs/ROADMAP.md) for the order things are built in.
