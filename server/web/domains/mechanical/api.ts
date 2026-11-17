// api.ts — what other domains may import from the mechanical domain.  Anything not exported here is internal
// and may change without notice (server/web/README.md: a domain never imports another domain's internals).
//
// An assembly uses these to read a part studio and show its bodies: open the document with ItemDocSession
// (web/shared/itemdoc/sync.ts, expectKind PART_STUDIO_KIND), turn it into worker input with `featuresOf` +
// `featureInputs`, regenerate with a KernelClient, and draw the BodyMesh of each BodyResult.
export { PART_STUDIO_EXT, PART_STUDIO_KIND, featureInputs, featuresOf, rollbackIndex, studioOf, type FeatureItem, type StudioItem } from "./document/format";
export { KernelClient, type KernelOptions, type KernelState } from "./kernel/client";
export type { BodyMesh, BodyResult, FeatureInput, FeatureReport, FeatureStatus, RegenResult, SketchView } from "./kernel/protocol";
export { DEFAULT_PLANES, add, cross, dot, isGeomRef, length, normalize, scale, sub, toPlane, toWorld, type DefaultPlaneId, type Frame, type GeomKind, type GeomRef, type PlaneRef, type Vec2, type Vec3 } from "./core/geometry";
export type { ParamField } from "./core/feature";
// Live presence for another domain's 3D editor (who is here, pointers, views, Follow): collab/attach.tsx.
export { mountViewportCollab, type ViewportCollabOptions } from "./collab/attach";
export type { Collab, CollabHost, CollabState, LocalPresence } from "./collab/collab";
export type { CadPresence, Collaborator, SelRef } from "./collab/presence";
