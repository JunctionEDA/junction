// dialogs/maintenance.ts — Preferences > Common > Maintenance (common/dialogs/panel_maintenance.cpp) for the browser:
// what KiCad keeps in its settings files is this browser's localStorage, so "Reset All Dialogs to Defaults" forgets
// every dialog's remembered size and control state (DIALOG_SHIM's saved state), and "Reset All Program Settings to
// Defaults" (SETTINGS_MANAGER::ResetToDefaults) forgets every user setting the web editor keeps.  Nothing on the
// server — no design, project or account data — is touched.

/** DIALOG_SHIM's remembered geometry and control values: kicad-dialogs' kd.geom / kd.state, the props dialogs' pd.state. */
const DIALOG_PREFIXES = ["kd.geom.", "kd.state.", "pd.state."];
/** Every per-user program setting: the editor's (kui.*), the tools' (kc.*), the fabrication outputs' and the library choosers'. */
const SETTING_PREFIXES = ["kui.", "kc.", "kd.", "pd.", "kicad.", "kicad-collab:"];
/** Kept by a program reset: browser hints that are not settings (which documents are boards, the onboarding guide's progress). */
const KEEP = ["kui.boardDocs", "kc.onboard."];

/** The stored keys that are dialog state. */
export function dialogStateKeys(keys: string[]): string[] { return keys.filter((k) => DIALOG_PREFIXES.some((p) => k.startsWith(p))); }
/** The stored keys that are program settings, dialog state included. */
export function programSettingKeys(keys: string[]): string[] {
  return keys.filter((k) => SETTING_PREFIXES.some((p) => k.startsWith(p)) && !KEEP.some((p) => k === p || (p.endsWith(".") && k.startsWith(p))));
}

function storedKeys(): string[] {
  const out: string[] = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k !== null) out.push(k); } } catch (e) { /* no storage */ }
  return out;
}
function removeKeys(keys: string[]): number { let n = 0; for (const k of keys) { try { localStorage.removeItem(k); n++; } catch (e) { /* no storage */ } } return n; }

/** PANEL_MAINTENANCE::doClearDialogState: the number of entries removed. */
export function clearDialogState(): number { return removeKeys(dialogStateKeys(storedKeys())); }
/** PANEL_MAINTENANCE::onResetAll's settings half: the number of entries removed. */
export function resetProgramSettings(): number { return removeKeys(programSettingKeys(storedKeys())); }
