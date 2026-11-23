// api-ui.ts — the React pieces other domains may mount (their own 3D editors), kept apart from api.ts so that a
// bundle that only reads part studios (the board editor) pulls in no React.
//
// The view cube (Onshape's: faces, edges and corners, 90° arrows, roll, the view menu) on any Viewport3D, and the
// tooltip host its buttons use: ui/ViewCubeControl.tsx.  Make the viewport with { viewButtons: false, triad: false }.
export { ViewCubeControl, type ViewCubeOptions, type ViewMenuParts } from "./ui/ViewCubeControl";
export { TipHost } from "./ui/Tip";
// Onshape's keys for turning the view of any Viewport3D (arrows, Shift + arrows, Ctrl/Cmd + ← → roll, Shift + 1 … 7):
// ui/viewkeys.ts.  The assembly takes them as the part studio does.
export { VIEW_KEYS, viewKey, viewShortcut } from "./ui/viewkeys";
// The pieces of the part studio's chrome another editor's toolbar is made of, so both look and behave alike
// (the assembly's ui/Toolbar.tsx, ui/Overlays.tsx): an icon, the tooltip of a tool, how the tool search finds a
// tool, where the marking menu's wedges are, the rules of rebinding keys and the sheet that changes them.
export { Glyph } from "./ui/Glyph";
export { hideTip, tipHandlers, tipText, type TipContent } from "./ui/Tip";
export { matchScore, searchCommands, type Searchable } from "./ui/search";
export type { Entry, Section, Slot } from "./ui/commands";
export { DIRECTIONS, flickWedge, markingPlace, wedgeAt, wedgePlace } from "./ui/marking";
export { bindingsOf, chordOf, chordProblem, cleanOverrides, commandFor, rebind, resetBinding, type Binding, type KeyCommand, type KeyContext, type Overrides } from "./ui/keymap";
export type { KeymapStore } from "./ui/keymap-store";
export { KeymapSheet } from "./ui/KeymapDialog";
export { Sheet } from "./ui/Sheet";
