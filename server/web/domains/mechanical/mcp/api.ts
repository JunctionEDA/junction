// mcp/api.ts — what the mechanical domain's AI tools offer another domain's (the assembly's mcp/host.ts): the
// headless part studio, the scene the looking and checking tools work on, picking geometry by description, the
// reference pages.  Import from here, not from the files beside it; the one exception is select.ts (picking
// geometry by description), which is pure and is imported as it is by code that must stay pure itself
// (assembly/mcp/model.ts).
export {
  OpenDoc, OpenStudio, addSceneKind, api, createDocument, findDocument, freePath, kernel, needProject, needWrite, pickFields, renderScene, standingMesh, studioOf, studioParts,
  undoRecorded, type Built, type Scene, type SceneKind, type ScenePart,
} from "./host";
export { fieldDoc } from "./catalog";
export { looksOf } from "../document/appearance-items";
export { placedBox } from "./describe";
export { applyRecorded } from "./model";
export { addReference } from "./reference";
