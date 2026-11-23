// pcbdialogs/import-netlist — File > Import > Netlist... (PCB_EDIT_FRAME::InstallNetlistFrame, DIALOG_IMPORT_NETLIST,
// pcbnew/dialogs/dialog_import_netlist.cpp): a netlist file read as NETLIST_READER reads it (import-netlist-logic.ts),
// "Load and Test Netlist" running BOARD_NETLIST_UPDATER as a dry run and "Update PCB" for real (canvas/pcb-netlist.ts's
// planUpdate, the updater Update PCB from Schematic uses), the report in "Changes to Be Applied" / "Changes Applied to
// PCB".  The file comes from the browser's file chooser (the dialog's browse button).
import { E } from "../state";
import { NL } from "./canvas";
import { box, checkField, h, messageBox, openDialog, radioBox, reportPanel, textField } from "./ui";
import { store } from "../appstore";
import { messageText } from "../../../../shared/units";
import type { Netlist, ReportLine, UpdateOptions, UpdatePlan } from "../../canvas/pcb-netlist";
import { boardFootprintIds, fabTextStyle, fetchFootprints, libCache, planChanges } from "./update-pcb";
import { readNetlistFile } from "./import-netlist-logic";

/** LAST_PATH_NETLIST and the file read for it */
let last: { name: string; text: string } | null = null;
const PREFS = "kicad.import-netlist";
type Prefs = { byRef: boolean; deleteExtra: boolean; replace: boolean; groups: boolean; locks: boolean };
function loadPrefs(): Prefs {
  const def: Prefs = { byRef: false, deleteExtra: false, replace: true, groups: true, locks: false };
  try { return Object.assign(def, JSON.parse(localStorage.getItem(PREFS) || "{}")); } catch { return def; }
}
function savePrefs(p: Prefs): void { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* this session only */ } }

function pickNetlistFile(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept: ".net,.xml", style: "display:none" }) as HTMLInputElement;
    let settled = false;
    const done = (v: { name: string; text: string } | null): void => { if (settled) return; settled = true; input.remove(); resolve(v); };
    input.addEventListener("change", () => { const f = input.files && input.files[0]; if (!f) { done(null); return; } f.text().then((text) => done({ name: f.name, text }), () => done(null)); });
    input.addEventListener("cancel", () => done(null));
    document.body.append(input); input.click();
  });
}

export function openImportNetlist(ctx: ToolCtx): void {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") return;
  const p = loadPrefs();
  const file = textField(last ? last.name : "", { key: "netlist-file" });
  (file.input as HTMLInputElement).readOnly = true;
  const match = radioBox("Link Method", ["Link footprints using component tstamps (unique ids)", "Link footprints using reference designators"], p.byRef ? 1 : 0, { key: "link-method" });
  match.el.title = "Select whether to update footprint references to match their currently-assigned symbols, or to re-assign footprints to symbols which match their current references.";
  const del = checkField(p.deleteExtra, "Delete footprints with no components in netlist", { key: "delete-extra" });
  const rep = checkField(p.replace, "Replace footprints with those specified in netlist", { key: "replace" });
  const grp = checkField(p.groups, "Group footprints based on symbol group", { key: "groups" });
  const locks = checkField(p.locks, "Delete/replace footprints even if locked", { key: "locks" });
  const report = reportPanel("260px", { fileName: "report.txt" });
  const reportBox = box("Changes to Be Applied", report.el);
  const vp = (store.get() as { viewport?: { units?: Parameters<typeof messageText>[1] } }).viewport || {};
  let newFootprints: string[] = [];

  const options = (applied: boolean): UpdateOptions => {
    const st = fabTextStyle();
    return { newUuid: () => KiCadCanvas.newUuid(), footprintFor: (fpid) => { const v = libCache.get(fpid); return v && v !== "missing" ? NL().footprintFromLibrary(v, fpid, () => KiCadCanvas.newUuid()) : v === undefined ? null : v; },
      fieldSize: st.size, fieldSizeV: st.sizeV, fieldThickness: st.thick, fieldItalic: st.italic, fieldUpright: st.upright, formatLength: (mm) => messageText(mm, vp.units || "mm", "pcb"),
      relinkByRef: match.get() === 1, deleteUnused: del.get(), replaceFootprints: rep.get(), transferGroups: grp.get(), overrideLocks: locks.get(), updateFields: true, applied };
  };
  /** DIALOG_IMPORT_NETLIST::loadNetlist */
  const loadNetlist = async (dryRun: boolean): Promise<void> => {
    if (!last) return;
    savePrefs({ byRef: match.get() === 1, deleteExtra: del.get(), replace: rep.get(), groups: grp.get(), locks: locks.get() });
    const head: ReportLine[] = [{ severity: "info", text: `Reading netlist file '${last.name}'.` },
      { severity: "info", text: match.get() === 1 ? "Using reference designators to match symbols and footprints." : "Using tstamps (unique IDs) to match symbols and footprints." }];
    report.set(head);
    const res = readNetlistFile(last.text, last.name);
    if ("error" in res) { messageBox("Error", res.error); return; }
    const netlist: Netlist = res.netlist;
    // LoadNetlistFootprints: the footprints the netlist names that the board does not have yet
    const have = boardFootprintIds(doc);
    await fetchFootprints(Array.from(new Set(netlist.components.map((c) => c.footprint).filter((f) => f && !have.has(f)))));
    const plan: UpdatePlan = NL().planUpdate(doc, netlist, options(!dryRun));
    report.set([...head, ...plan.report]);
    if (dryRun || E.viewOnly) return;
    // PerformUpdate: the selection is cleared, and the new footprints are spread (SpreadFootprints) before Move
    if (E.tool !== "select") void import("../tools").then((T) => T.setTool("select"));
    (ctx as unknown as { setSelection?(ids: string[]): void }).setSelection?.([]);
    const fresh = plan.added.filter((n) => n[0] === "footprint");
    const pt = (window as unknown as { PcbTools?: { packNodes?(d: { items: Map<string, KItem> }, ids: string[], o: { target: [number, number]; groupBySheet: boolean }): Map<string, SNode> } }).PcbTools;
    if (fresh.length && pt && pt.packNodes) {
      const items = new Map<string, KItem>();
      for (const n of fresh) { const it = KiCadCanvas.createItem(doc, n); if (it) items.set(it.id, it); }
      const packed = pt.packNodes({ items }, Array.from(items.keys()), { target: [0, 0], groupBySheet: true });
      for (const n of fresh) { const id = String(((KiCadCanvas.kid(n, "uuid") as SNode | null) || [])[1]); const q = packed.get(id); if (q) { n.length = 0; n.push(...q); } }
    }
    const added: string[] = [];
    const changes = planChanges(doc, plan, added);
    if (changes.length) { ctx.commit(changes, "Update Netlist"); newFootprints = added; }
  };
  const onChange = (): void => { if (last) void loadNetlist(true); };
  for (const f of [del, rep, grp, locks]) f.input.addEventListener("change", onChange);
  match.input.closest("fieldset")?.addEventListener("change", onChange);

  openDialog({ title: "Import Netlist", width: 640, okLabel: "Update PCB", cancelLabel: "Close", readOnly: !!E.viewOnly, noEnter: true,
    extra: [{ label: "Load and Test Netlist", fn: () => { void loadNetlist(true); } }],
    build(body) {
      const browse = h("button", { class: "btn", type: "button", "data-k": "browse", title: "Browse" }, "…");
      browse.addEventListener("click", () => { void pickNetlistFile().then((f) => { if (!f) return; last = f; file.set(f.name); void loadNetlist(true); }); });
      file.el.style.flex = "1";
      body.append(h("div", { style: "display:flex;gap:6px;align-items:center;margin-bottom:8px" }, h("span", { class: "pd-lbl" }, "Netlist file:"), file.el, browse),
        h("div", { class: "pd-cols2" }, match.el, box("Options", del.el, rep.el, grp.el, locks.el)), reportBox);
    },
    ok() {
      // onUpdatePCB
      if (!last) { messageBox("Import Netlist", "Please choose a valid netlist file."); return false; }
      reportBox.firstElementChild!.textContent = "Changes Applied to PCB";
      void loadNetlist(false);
      return false;
    },
    cancel() {
      // ~DIALOG_IMPORT_NETLIST: m_runDragCommand hands the new footprints to the move tool
      if (!newFootprints.length || E.viewOnly) return;
      const ids = newFootprints.slice();
      window.setTimeout(() => { void import("../tools").then((T) => {
        const m = CollabTools.pcb as unknown as { moveFromReference?(c: unknown, ids: string[], origin: [number, number]): boolean } | undefined;
        if (m && m.moveFromReference) m.moveFromReference(T.toolCtx(), ids, [0, 0]);
        else { (ctx as unknown as { setSelection(ids: string[]): void }).setSelection(ids); T.runModuleAction("move"); }
      }); }, 0);
    } });
}
