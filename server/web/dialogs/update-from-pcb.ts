// dialogs/update-from-pcb.ts — Tools > Update Schematic from PCB... (DIALOG_UPDATE_FROM_PCB, BACK_ANNOTATE):
// "Re-link footprints to schematic symbols based on their reference designators", the Update checkboxes (Reference
// designators, Footprint assignments, Values, Net names, Attributes, Other fields; the unit / pin swap preferences
// with them) and the "Changes to Be Applied" report, refreshed as a dry run on every option change.  "Update
// Schematic" writes the symbols (each sheet one undo step, the open one through the editor), the renamed net labels,
// and with re-linking the new symbol paths of the footprints on the board.
import { E, appState, pushUndoFor, toolCtx } from "./editor";
import { KD, checkbox, h } from "./dom";
import { messageBox } from "./sch-items";
import { submitDocOp } from "./project";
import { liveDocument, projectDocs } from "../editor/projectfile";
import { projectNetlist } from "../editor/pcbdialogs/update-pcb";
import { reportPanel, type ReportLine } from "../editor/pcbdialogs/ui";
import { backAnnotate, fpData, type BaOptions, type FpData, type SymRef } from "./update-from-pcb-logic";
import type { NetEntry, SheetFile } from "../canvas/pcb-netlist";

type N = SNode;
const K = (): typeof KiCadCanvas => KiCadCanvas;
const sv = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const remembered: BaOptions & { unitSwaps: boolean; pinSwaps: boolean } = { relink: false, references: true, footprints: true, values: true, netNames: true, attributes: true, otherFields: true, unitSwaps: true, pinSwaps: true };

interface Loaded {
  syms: SymRef[]; fps: FpData[];
  /** symbol path -> where its item is */
  where: Map<string, { file: string; id: string; instPath: string }>;
  files: Map<string, SheetFile>; netMap: Map<string, NetEntry> | undefined; instFiles: string[];
  board: { docId: string; doc: KDoc } | null;
}
async function load(): Promise<Loaded | { error: string }> {
  const res = await projectNetlist();
  if ("error" in res) return res;
  const docs = projectDocs();
  const pcb = docs.find((d) => d.docType === "kicad_pcb");
  if (!pcb) return { error: "This project has no board." };
  const live = await liveDocument(pcb.docId);
  const bdoc = K().parseDoc(live.file, "kicad_pcb") as KDoc;
  for (const op of live.ops) for (const c of op.changes || []) { try { K().applyChange(bdoc, c, 1e6); } catch { /* an op this reader cannot take */ } }
  const fps: FpData[] = [];
  for (const it of bdoc.items.values()) if (it.kind === "footprint") fps.push(fpData(it.node));
  const where = new Map<string, { file: string; id: string; instPath: string }>();
  const insts = res.netlist.instances || [];
  for (const inst of insts) {
    const f = res.files.get(inst.file); if (!f) continue;
    for (const it of f.doc.items.values()) {
      if (it.kind !== "symbol") continue;
      const u = K().kid(it.node, "uuid") as N | null; if (!u) continue;
      where.set("/" + inst.uuidPath.slice(1).concat(sv(u[1])).join("/"), { file: inst.file, id: it.id, instPath: "/" + inst.uuidPath.join("/") });
    }
  }
  const syms: SymRef[] = [];
  for (const c of res.netlist.components) {
    const w = where.get(c.paths[0]); if (!w) continue;
    const f = res.files.get(w.file)!, item = f.doc.items.get(w.id)!;
    const posN = K().kid(item.node, "in_pos_files") as N | null;
    const fields = new Map<string, string>(); for (const [k, v] of Object.entries(c.fields || {})) fields.set(k, v);
    const pins = new Map<string, string>(); for (const [pad, p] of c.pins) pins.set(pad, p.net);
    syms.push({ key: c.paths[0], keys: c.paths.slice(), ref: c.ref, power: false, value: c.value, footprint: c.footprint, dnp: c.dnp, inBom: !c.excludeFromBom, inPos: !posN || sv(posN[1]) !== "no", onBoard: !c.excludeFromBoard, fields, pins });
  }
  return { syms, fps, where, files: res.files, netMap: res.netlist.netMap, instFiles: insts.map((i) => i.file), board: { docId: pcb.docId, doc: bdoc } };
}

const setProp = (node: N, name: string, val: string): void => { const p = (K().kids(node, "property") as N[]).find((x) => sv(x[1]) === name); if (p) p[2] = val; };
const setYesNo = (node: N, key: string, on: boolean): void => {
  const i = node.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === key);
  if (i > 0) (node[i] as N)[1] = on ? "yes" : "no";
  else { const at = node.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "uuid"); node.splice(at > 0 ? at : node.length, 0, [key, on ? "yes" : "no"] as unknown as N); }
};

export function openUpdateFromPcb(): void {
  if (!E.kdoc || E.kdoc.type !== "sch") return;
  const o = remembered;
  let data: Loaded | null = null, report: ReturnType<typeof reportPanel> | null = null;
  const boxes = new Map<string, HTMLInputElement>();
  const refresh = async (): Promise<void> => {
    if (!report) return;
    if (!data) { const d = await load(); if ("error" in d) { report.set([{ severity: "error", text: d.error }]); return; } data = d; }
    const r = backAnnotate(data.syms, data.fps, o);
    const lines: ReportLine[] = r.lines.slice();
    lines.push({ severity: "info", text: `Total warnings: ${r.lines.filter((l) => l.severity === "warning").length}, errors: ${r.lines.filter((l) => l.severity === "error").length}.` });
    report.set(lines);
  };
  const run = async (): Promise<void> => {
    if (!data || E.viewOnly) return;
    const r = backAnnotate(data.syms, data.fps, o);
    const per = new Map<string, { changes: KChange[]; inverse: KChange[] }>();
    const editItem = (file: string, id: string, fn: (n: N) => void): void => {
      const f = data!.files.get(file); if (!f) return;
      const cur = file === currentPath() ? (E.kdoc as KDoc) : f.doc;
      const it = cur.items.get(id); if (!it) return;
      const acc = per.get(file) || { changes: [], inverse: [] }; per.set(file, acc);
      const prev = acc.changes.findIndex((c) => c.id === id);
      const base = prev >= 0 ? (K().parse(((acc.changes[prev] as KChange & { sexpr: string }).sexpr)) as N) : (K().cloneNode as (n: N) => N)(it.node);
      fn(base);
      const ch = K().replaceChange(cur, Object.assign({}, it, { node: base, geom: [], bbox: null }) as KItem) as KChange;
      if (prev >= 0) acc.changes[prev] = ch; else { acc.changes.push(ch); acc.inverse.push(K().replaceChange(cur, it) as KChange); }
    };
    for (const e of r.edits) {
      const s = data.syms.find((x) => x.key === e.key); if (!s) continue;
      for (const k of s.keys) {
        const w = data.where.get(k); if (!w) continue;
        editItem(w.file, w.id, (n) => {
          if (e.ref !== undefined) {
            setProp(n, "Reference", e.ref);
            const inst = K().kid(n, "instances") as N | null;
            if (inst) for (const pr of K().kids(inst, "project") as N[]) for (const p of K().kids(pr, "path") as N[]) if (sv(p[1]) === w.instPath) { const rf = K().kid(p, "reference") as N | null; if (rf) rf[1] = e.ref; }
          }
          if (e.footprint !== undefined) setProp(n, "Footprint", e.footprint);
          if (e.value !== undefined) setProp(n, "Value", e.value);
          if (e.dnp !== undefined) setYesNo(n, "dnp", e.dnp);
          if (e.inBom !== undefined) setYesNo(n, "in_bom", e.inBom);
          if (e.inPos !== undefined) setYesNo(n, "in_pos_files", e.inPos);
          for (const [name, val] of e.setFields) setProp(n, name, val);
          for (const name of e.deleteFields) { const i = n.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "property" && sv((c as N)[1]) === name); if (i > 0) n.splice(i, 1); }
          const at = (K().kid(n, "at") as N | null) || ["at", 0, 0];
          for (const [name, val] of e.addFields) {
            const q = (x: string): string => '"' + x.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
            const p = K().parse(`(property ${q(name)} ${q(val)} (at ${sv(at[1])} ${sv(at[2])} 0) (hide yes) (effects (font (size 1.27 1.27))))`) as N;
            const last = n.reduce((m: number, c, j) => (Array.isArray(c) && c[0] === "property" ? j : m), -1);
            n.splice(last > 0 ? last + 1 : n.length, 0, p as unknown as N);
          }
        });
      }
    }
    // net names: the labels that name the old net take the board's name
    if (data.netMap) for (const l of r.labels) {
      const entry = data.netMap.get(l.from); if (!entry) continue;
      const short = l.to.slice(l.to.lastIndexOf("/") + 1);
      for (const m of entry.members) {
        if (m.kind !== "label" && m.kind !== "global_label" && m.kind !== "hierarchical_label") continue;
        const file = data.instFiles[m.inst]; if (!file) continue;
        editItem(file, m.id, (n) => { n[1] = short; });
      }
    }
    const label = "Update Schematic from PCB";
    const docs = projectDocs();
    for (const [file, acc] of per) {
      if (file === currentPath()) { toolCtx().commit(acc.changes, label); continue; }
      const d = docs.find((x) => x.path === file); if (!d) continue;
      try { await submitDocOp(d.docId, acc.changes); pushUndoFor(d.docId, { label, changes: acc.changes, inverse: acc.inverse }); }
      catch (e) { await messageBox(`Could not update ${file}: ${(e as Error).message}`); }
    }
    // PushNewLinksToPCB: the footprints take the paths of the symbols they were re-linked to
    if (o.relink && r.relinks.length && data.board) {
      const b = data.board, changes: KChange[] = [];
      for (const rl of r.relinks) for (const it of b.doc.items.values()) {
        if (it.kind !== "footprint" || fpData(it.node).ref !== rl.fpRef) continue;
        const n = (K().cloneNode as (x: N) => N)(it.node); const p = K().kid(n, "path") as N | null;
        if (p) p[1] = rl.path; else n.splice(2, 0, ["path", rl.path] as unknown as N);
        changes.push(K().replaceChange(b.doc, Object.assign({}, it, { node: n, geom: [], bbox: null }) as KItem) as KChange);
      }
      if (changes.length) { try { await submitDocOp(b.docId, changes); } catch (e) { await messageBox(`Could not update the board: ${(e as Error).message}`); } }
    }
    data = null;
    await refresh();
    const ok = document.getElementById("kd-ufp-update") as HTMLButtonElement | null; if (ok) ok.disabled = true;
  };
  KD().open({
    title: "Update Schematic from PCB", width: 720, geomKey: "DIALOG_UPDATE_FROM_PCB",
    build(body) {
      const cb = (key: keyof typeof o, label: string, tip: string): HTMLLabelElement => {
        const row = checkbox(label, !!o[key], (on) => { (o as unknown as Record<string, boolean>)[key] = on; sync(); void refresh(); }, { id: "kd-ufp-" + key, title: tip });
        boxes.set(key, row.querySelector("input") as HTMLInputElement); return row;
      };
      const sync = (): void => {
        const ref = boxes.get("references"); if (ref) { if (o.relink) { ref.checked = false; o.references = false; } ref.disabled = o.relink; }
      };
      const opts = KD().staticBox(body, "Options");
      opts.append(cb("relink", "Re-link footprints to schematic symbols based on their reference designators", "Normally footprints are linked to their symbols via their Unique IDs.  Select this option only if you want to reset the footprint linkages based on their reference designators."));
      const up = KD().staticBox(body, "Update");
      up.append(h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:2px 16px" },
        cb("references", "Reference designators", "Update references of symbols that have been changed in the PCB editor."),
        cb("footprints", "Footprint assignments", "Update footprint associations of symbols whose footprints have been replaced with different footprints in PCB."),
        cb("values", "Values", "Update symbols values that have been replaced in the PCB editor."),
        cb("netNames", "Net names", "Update schematic net labels to match net names from the PCB editor."),
        cb("attributes", "Attributes", "Update symbol attribute flags like Do Not Populate to match the footprint."),
        cb("unitSwaps", "Prefer symbol unit swaps over label swaps", "When possible, detect footprint gate swaps and apply corresponding symbol unit swaps instead of changing net labels."),
        cb("otherFields", "Other fields", "Update all other fields in the symbol from the footprint"),
        cb("pinSwaps", "Prefer symbol pin swaps over label swaps", "When possible, swap symbol pins to match footprint pad net swaps instead of changing net labels.")));
      sync();
      body.append(h("div", { style: "font-weight:600;margin:8px 0 4px" }, "Changes to Be Applied"));
      report = reportPanel("240px", { fileName: "report.txt" });
      report.el.id = "kd-ufp-report";
      body.append(report.el);
      void refresh();
    },
    buttons: [
      { label: "Close", close: true },
      { label: "Update Schematic", primary: true, isDefault: true, id: "kd-ufp-update", fn: () => { void run(); } },
    ],
  });
}
function currentPath(): string { const d = projectDocs().find((x) => x.docId === appState.docId); return d ? d.path : ""; }
