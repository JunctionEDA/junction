// api-ui.ts — the React pieces other domains may mount (their own 3D editors), kept apart from api.ts so that a
// bundle that only reads part studios (the board editor) pulls in no React.
//
// The view cube (Onshape's: faces, edges and corners, 90° arrows, roll, the view menu) on any Viewport3D, and the
// tooltip host its buttons use: ui/ViewCubeControl.tsx.  Make the viewport with { viewButtons: false, triad: false }.
export { ViewCubeControl, type ViewCubeOptions, type ViewMenuParts } from "./ui/ViewCubeControl";
export { TipHost } from "./ui/Tip";
