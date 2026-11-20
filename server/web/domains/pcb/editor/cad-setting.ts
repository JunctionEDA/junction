// cad-setting.ts — the page's end of the Mechanical CAD setting (web/shared/cad.ts): the request that changes it,
// the store's `me` that every part of the page reads it from, and what an open tab does when it changes.  The
// chrome asks for it with dispatch({ type: "setCad", on }) (the account menu, the app menu, a CAD document's note).
//
// The page follows without a reload: the tabs, "+", Home and the board editor's CAD hooks (cad-usage.ts,
// web/domains/pcb/mech) read the setting from the store, and a part studio or an assembly that is open is drawn
// again, as its editor or as the note that CAD is off.
import { isCadDocType } from "../../registry";
import { state, store } from "./appstore";
import { openDocId } from "./doc";
import { api, toast } from "./util";

let asked = 0;

function apply(on: boolean): void {
  if (!state.me || !!state.me.cad === on) return;
  state.me = { ...state.me, cad: on };
  store.set({ me: state.me });
  if (state.view === "cad" && state.doc && isCadDocType(state.doc.docType)) openDocId(state.doc.docId);
}

/** Turn Mechanical CAD on or off for the signed-in person (PUT /api/me/cad). */
export async function setCad(on: boolean): Promise<void> {
  if (!state.me) { toast("Sign in to turn on Mechanical CAD"); return; }
  const was = !!state.me.cad;
  if (was === on) return;
  const mine = ++asked;
  apply(on);   // at once: the request only confirms it
  try {
    const me = await api("/api/me/cad", { method: "PUT", body: JSON.stringify({ enabled: on }) }) as { cad?: boolean };
    if (mine !== asked) return;
    apply(!!me.cad);
    toast(me.cad ? "Mechanical CAD is on" : "Mechanical CAD is off");
  } catch (e) {
    if (mine !== asked) return;
    apply(was);
    toast("The setting could not be changed: " + (e as Error).message, 4000);
  }
}
