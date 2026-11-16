# Mechanical CAD

Status: **planned**. This folder is the place for this domain's web code. Nothing is here yet, and nothing in the
build depends on it.

**Scope.** Parametric solid modelling: 2D sketches with constraints, features (extrude, revolve, fillet, shell, pattern) and an editable history tree.

**First milestone.** Open and view STEP files in the browser with the OpenCascade build the 3D viewer already ships (`occt-import-js`).

**Candidate engines.** OpenCascade (LGPL 2.1, compiled to WebAssembly) for the B-rep kernel; a 2D constraint solver such as PlaneGCS (LGPL) for sketches. Check every library's licence against Junction's GPLv3 before it is added.

**What it gets from the platform.** Projects, sharing and roles, live presence, comments, version history,
GitHub sync and the AI (MCP) connection come from `server/web/platform` and `server/web/shared`, so a domain's
editor only has to supply its documents, its view and its tools. Its entry in
[`../registry.ts`](../registry.ts) says which files it opens and which other domains it reads.

See [docs/ROADMAP.md](../../../../docs/ROADMAP.md) for the order these are built in.
