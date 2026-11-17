# Assemblies

Status: **in progress (a stub)**. The assembly document (`.jasm`) exists, has a tab, opens in its own editor
with an empty 3D viewport, and its instance and mate format is fixed. Inserting parts and boards, drawing them
and solving mates are not built.

**Read [../mechanical/CONTRACT.md](../mechanical/CONTRACT.md)**, section "The assembly": the item format
(instances that follow a part studio body, a board, another assembly or a model file; mates between two
connectors that use the mechanical domain's geometry names), the mate registry, and how to draw a part-studio
instance with the mechanical domain's exports.

**Layout.**

```
document/format.ts   the .jasm format
core/mate.ts         the mate contract          core/tool.ts   the toolbar contract
core/transform.ts    placement arithmetic (3 × 4 matrices)
mates/               one file per mate type     (fastened.ts)
tools/               one file per toolbar tool  (none yet)
ui/                  the editor's controller and React frame
index.tsx            the bundle's entry (static/dist/assembly.js)
generated/           written by scripts/gen-cad-registry.mjs; not committed
```

**Reads other domains** only through their documented exports: `../mechanical/api.ts` for part studios. A
board comes in through the electronics domain's 3D model of it; which names a board offers to mates is not
designed yet.

**What it gets from the platform.** The same as the part studio: storage, roles and live co-editing through
`shared/itemdoc`. Its entry in [`../registry.ts`](../registry.ts) says which files it opens.

See [docs/ROADMAP.md](../../../../docs/ROADMAP.md) for the order things are built in.
