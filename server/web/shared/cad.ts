// cad.ts — whether the signed-in person works with Mechanical CAD: part studios, assemblies, the board link and
// the CAD hooks of the board editor.  It is a setting of the person's account (users.cad_enabled, off by default;
// GET /api/me says `cad`, PUT /api/me/cad changes it), and every caller asks this one file:
//
//   cadEnabled()                     now, anywhere (the page's store)
//   useApp(cadEnabled)               in a React component, which then follows the setting
//   setCadEnabled(on)                change it; the page follows at once (web/domains/pcb/editor/cad-setting.ts)
//
// Only what the person is offered follows it.  A project's documents are never hidden or refused: with CAD off
// the Home tab still lists a collaborator's part studio, with a way to turn CAD on and open it, and a board driven
// by a part studio keeps its driven items, locked, as they are stored.  Which document kinds are CAD is said by
// the registry (web/domains/registry.ts `cad`), not here.
//
// No React here (only types from the store): the editor's modules and the headless bundles import this too.
import type { AppState } from "./store";

/** The switch, as the account menu and the editor's app menu show it. */
export const CAD_SETTING_LABEL = "Mechanical CAD (part studios and assemblies)";
/** The line under it: what turning it on does. */
export const CAD_SETTING_NOTE = "Adds part studios, assemblies and the board link to your projects. Takes effect at once.";
/** What a CAD document says to somebody who has CAD turned off. */
export const CAD_OFF_NOTE = "Turn on Mechanical CAD in your settings to open";

/** Whether the signed-in person has Mechanical CAD turned on (false when signed out, and before the page knows). */
export function cadEnabled(state?: Pick<AppState, "me"> | null): boolean {
  const s = state === undefined && typeof window !== "undefined" && window.CollabApp ? window.CollabApp.getState() : state;
  return !!(s && s.me && s.me.cad);
}

/** Turn Mechanical CAD on or off for the signed-in person. */
export function setCadEnabled(enabled: boolean): void {
  if (typeof window !== "undefined" && window.CollabApp) window.CollabApp.dispatch({ type: "setCad", on: enabled });
}
