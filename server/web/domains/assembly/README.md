# Assemblies

Status: **planned**. This folder is the place for this domain's web code. Nothing is here yet, and nothing in the
build depends on it.

**Scope.** Parts and boards placed together with mates and joints, interference and clearance checks, exploded views and a combined bill of materials.

**First milestone.** Place a board from the electronics domain and STEP parts into one scene, with fixed positions and a BOM.

**Candidate engines.** Builds on the mechanical domain's kernel; a board comes in through the electronics domain's existing 3D export. Check every library's licence against Junction's GPLv3 before it is added.

**What it gets from the platform.** Projects, sharing and roles, live presence, comments, version history,
GitHub sync and the AI (MCP) connection come from `server/web/platform` and `server/web/shared`, so a domain's
editor only has to supply its documents, its view and its tools. Its entry in
[`../registry.ts`](../registry.ts) says which files it opens and which other domains it reads.

See [docs/ROADMAP.md](../../../../docs/ROADMAP.md) for the order these are built in.
