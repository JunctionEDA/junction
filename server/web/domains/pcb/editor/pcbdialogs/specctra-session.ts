// pcbdialogs/specctra-session — File > Import > Specctra Session... (BOARD_EDITOR_CONTROL::ImportSpecctraSession,
// PCB_EDIT_FRAME::ImportSpecctraSession): the "Specctra Session File" (*.ses) chosen, read and merged as one
// commit "Import Specctra Session" (specctra-session-logic.ts); a file that cannot be read leaves the board as it was
// with "Board may be corrupted, do not save it. Fix problem and try again" and the reason; done, the status bar says
// "Session file imported and merged OK.", and items the session names but the board cannot take are counted in a
// warning (wxLogWarning).
import { E } from "../state";
import { h, messageBox } from "./ui";
import { clearDrcMarkers } from "./inspect";
import { fromSession, parseSession, SesError, type ImportEnv } from "./specctra-session-logic";

function pickSession(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept: ".ses", style: "display:none" }) as HTMLInputElement;
    let settled = false;
    const done = (v: { name: string; text: string } | null): void => { if (settled) return; settled = true; input.remove(); resolve(v); };
    input.addEventListener("change", () => { const f = input.files && input.files[0]; if (!f) { done(null); return; } f.text().then((text) => done({ name: f.name, text }), () => done(null)); });
    input.addEventListener("cancel", () => done(null));
    document.body.append(input); input.click();
  });
}

/** The board's names and rules the import reads. */
function importEnv(doc: KDoc): ImportEnv {
  const copper = (doc.copper && doc.copper.length ? doc.copper.slice() : ["F.Cu", "B.Cu"]).sort((a, b) => (a === "F.Cu" ? -1 : b === "F.Cu" ? 1 : a === "B.Cu" ? 1 : b === "B.Cu" ? -1 : Number(a.slice(2, -3)) - Number(b.slice(2, -3))));
  const names = new Set<string>(); const codes = new Map<string, number>();
  for (const [code, name] of doc.nets) { names.add(String(name)); codes.set(String(name), code); }
  const version = Number((doc as KDoc & { version?: number }).version) || 0;
  let byName = version >= 20251028 || version === 0;
  if (!byName) { for (const it of doc.items.values()) { if (it.kind !== "segment" && it.kind !== "via" && it.kind !== "arc") continue; const nn = KiCadCanvas.kid(it.node, "net") as SNode | null; if (nn) { byName = typeof nn[1] !== "number"; break; } } }
  const PS = (KiCadCanvas as unknown as { pcbSizes?: { boardSizes(src: unknown): unknown; effectiveNetclass(s: unknown, net: string): { name: string; via_drill: number } } }).pcbSizes;
  const sizes = PS ? PS.boardSizes(E.proSettings || null) : null;
  let classes: { name?: string; via_drill?: number; microvia_drill?: number }[] = [];
  try { const pro = JSON.parse(String(E.proSettings || "{}")) as { net_settings?: { classes?: typeof classes } }; classes = (pro.net_settings && Array.isArray(pro.net_settings.classes)) ? pro.net_settings.classes : []; } catch { classes = []; }
  const cls = (name: string) => classes.find((c) => c && c.name === name);
  const def = cls("Default");
  const defaultDrill = def && typeof def.via_drill === "number" ? def.via_drill : 0.3;
  return {
    copper, layerName: (l) => { const info = doc.layers.get(l) as { userName?: string } | undefined; return (info && info.userName) || l; },
    hasNet: (n) => names.has(n),
    netNode: (n) => (byName ? ["net", n] : ["net", codes.get(n) || 0]),
    defaultViaDrill: defaultDrill,
    viaDrillFor: (net, micro) => {
      const eff = PS && sizes ? PS.effectiveNetclass(sizes, net) : null;
      if (!micro) return eff ? eff.via_drill : defaultDrill;
      const c = eff ? cls(eff.name) : null;
      return c && typeof c.microvia_drill === "number" ? c.microvia_drill : def && typeof def.microvia_drill === "number" ? def.microvia_drill : 0.1;
    },
    newUuid: () => KiCadCanvas.newUuid(),
    flip: (n) => { const P = (window as unknown as { PcbTools?: { flipFootprintNode?(n: SNode): void } }).PcbTools; if (P && P.flipFootprintNode) P.flipFootprintNode(n); },
    rotate: (n, deg) => { const P = (window as unknown as { PcbTools?: { rotateFootprintNode?(n: SNode, d: number): void } }).PcbTools; if (P && P.rotateFootprintNode) P.rotateFootprintNode(n, deg); },
    setPosition: (n, x, y) => { const at = KiCadCanvas.kid(n, "at") as SNode | null; if (at) { at[1] = x; at[2] = y; } },
  };
}

export async function importSpecctraSession(ctx: ToolCtx): Promise<void> {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb" || E.viewOnly) return;
  const f = await pickSession(); if (!f) return;
  // selectionClear: the tracks and vias the import removes may be selected
  (ctx as unknown as { setSelection?(ids: string[]): void }).setSelection?.([]);
  let plan;
  try { plan = fromSession(doc.items.values(), parseSession(f.text, f.name), importEnv(doc)); }
  catch (e) {
    if (!(e instanceof SesError)) throw e;
    messageBox("Error", `Board may be corrupted, do not save it.\n Fix problem and try again\n\n${e.message}`);
    return;
  }
  const changes: KChange[] = [];
  for (const id of plan.removed) { const it = doc.items.get(id); if (it) changes.push(KiCadCanvas.removeChange(it)); }
  for (const [id, node] of plan.modified) { const it = doc.items.get(id); if (it) changes.push(KiCadCanvas.replaceChange(doc, { ...it, node })); }
  for (const node of plan.added) { const it = KiCadCanvas.createItem(doc, node); if (it) changes.push(KiCadCanvas.addChange(doc, it)); }
  if (changes.length) ctx.commit(changes, "Import Specctra Session");
  // BOARD::DeleteMARKERs: the DRC markers go with the routing they described
  clearDrcMarkers(ctx);
  ctx.toast("Session file imported and merged OK.");
  if (plan.skipped > 0) messageBox("Warning", `${plan.skipped} session item(s) were skipped due to unresolved reference, layer, or padstack.`);
}
