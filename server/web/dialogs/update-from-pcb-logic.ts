// dialogs/update-from-pcb-logic.ts — BACK_ANNOTATE (eeschema/tools/backannotate.cpp) on plain data: the board's
// footprints matched to the schematic's symbols by their path (or, re-linking, by reference designator), and the
// changes Tools > Update Schematic from PCB... lists and applies: references, footprint assignments, values, the
// attribute flags, the other fields, and the net labels whose net was renamed on the board.

export interface BaOptions {
  relink: boolean; references: boolean; footprints: boolean; values: boolean; netNames: boolean; attributes: boolean; otherFields: boolean;
}
/** A footprint as PCB_EDIT_FRAME's back-annotation netlist describes it. */
export interface FpData {
  ref: string; path: string; fpid: string; value: string;
  dnp: boolean; excludeFromBom: boolean; excludeFromPos: boolean;
  /** every field except Reference and Value */
  fields: Map<string, string>;
  /** pad number -> board net name */
  pads: Map<string, string>;
}
/** One schematic symbol instance (all units share it; `units` are the items to edit). */
export interface SymRef {
  /** the first unit's path ("/<sheet uuid>…/<symbol uuid>"), what a footprint's (path) names; `keys` every unit's */
  key: string; keys: string[]; ref: string; power: boolean;
  value: string; footprint: string; dnp: boolean; inBom: boolean; inPos: boolean; onBoard: boolean;
  /** non-mandatory fields */
  fields: Map<string, string>;
  /** pin number -> schematic net name */
  pins: Map<string, string>;
}
export interface BaLine { severity: "error" | "warning" | "action" | "info"; text: string }
export interface SymEdit {
  key: string; ref?: string; footprint?: string; value?: string; dnp?: boolean; inBom?: boolean; inPos?: boolean;
  setFields: Map<string, string>; addFields: Map<string, string>; deleteFields: string[];
}
export interface LabelEdit { from: string; to: string; ref: string; pin: string }

const MANDATORY = new Set(["Reference", "Value", "Footprint", "Datasheet", "Description"]);
const hasVars = (s: string): boolean => /\$\{[^}]*\}/.test(s);
const tf = (b: boolean): string => (b ? "true" : "false");
/** DescribeRef: "R1", or "<no reference designator>" */
export const describeRef = (r: string): string => (r ? r : "<no reference designator>");
/** A board net named after a pad ("Net-(R1-Pad2)", "unconnected-(…)") was not named by anyone. */
const autoNet = (n: string): boolean => /^(Net-\(|unconnected-\()/.test(n) || n === "";

/** BackAnnotateSymbols: the report and the edits, for the dry run and the update alike. */
export function backAnnotate(syms: SymRef[], fps: FpData[], o: BaOptions): { lines: BaLine[]; edits: SymEdit[]; labels: LabelEdit[]; relinks: { fpRef: string; path: string }[]; changes: number } {
  const lines: BaLine[] = [], edits: SymEdit[] = [], labels: LabelEdit[] = [], relinks: { fpRef: string; path: string }[] = [];
  let changes = 0;
  if (!o.relink && !o.values && !o.footprints && !o.references && !o.netNames && !o.attributes && !o.otherFields) {
    lines.push({ severity: "error", text: "Select at least one property to back annotate." });
    return { lines, edits, labels, relinks, changes };
  }
  const refs = syms.filter((s) => !s.power);
  const byKey = new Map<string, SymRef>(); for (const s of refs) for (const k of s.keys) byKey.set(k, s);
  const byRef = new Map<string, SymRef>(); for (const s of refs) if (!byRef.has(s.ref)) byRef.set(s.ref, s);
  // getPcbModulesFromString / getChangeList
  const linked = new Map<SymRef, FpData>();
  const used = new Map<SymRef, FpData>();
  for (const fp of fps) {
    const path = o.relink ? fp.ref : fp.path;
    if (!path) { lines.push({ severity: "warning", text: `Footprint '${describeRef(fp.ref)}' has no assigned symbol.` }); continue; }
    const s = o.relink ? byRef.get(fp.ref) : byKey.get(fp.path);
    if (!s) { lines.push({ severity: "error", text: `Cannot find symbol for footprint '${describeRef(fp.ref)}'.` }); continue; }
    const other = used.get(s);
    if (other) { lines.push({ severity: "error", text: `Footprints '${describeRef(other.ref)}' and '${describeRef(fp.ref)}' linked to same symbol.` }); continue; }
    used.set(s, fp); linked.set(s, fp);
    if (o.relink && fp.path !== s.key) relinks.push({ fpRef: fp.ref, path: s.key });
  }
  // checkForUnusedSymbols
  for (const s of refs) if (!linked.has(s) && s.onBoard) lines.push({ severity: "warning", text: `Footprint '${describeRef(s.ref)}' is not present on PCB. Corresponding symbols in schematic must be manually deleted (if desired).` });
  // applyChangelist
  // the references after the update: a footprint's new reference may not land on another symbol's
  const finalRef = new Map<SymRef, string>(); for (const s of refs) finalRef.set(s, o.references && !o.relink && linked.has(s) ? linked.get(s)!.ref : s.ref);
  const count = new Map<string, number>(); for (const r of finalRef.values()) count.set(r, (count.get(r) || 0) + 1);
  for (const [s, fp] of linked) {
    const e: SymEdit = { key: s.key, setFields: new Map(), addFields: new Map(), deleteFields: [] };
    let any = false;
    if (o.references && !o.relink && s.ref !== fp.ref && !hasVars(s.ref)) {
      if ((count.get(fp.ref) || 0) > 1) lines.push({ severity: "error", text: `Cannot change ${s.ref} to '${fp.ref}', because the change will cause duplicated references.` });
      else { changes++; any = true; e.ref = fp.ref; lines.push({ severity: "action", text: `Change ${describeRef(s.ref)} reference designator to '${fp.ref}'.` }); }
    }
    const R = s.ref;
    if (o.footprints && s.footprint !== fp.fpid && !hasVars(s.footprint)) { changes++; any = true; e.footprint = fp.fpid; lines.push({ severity: "action", text: `Change ${describeRef(R)} footprint assignment from '${s.footprint}' to '${fp.fpid}'.` }); }
    if (o.values && s.value !== fp.value && !hasVars(s.value)) { changes++; any = true; e.value = fp.value; lines.push({ severity: "action", text: `Change ${describeRef(R)} value from '${s.value}' to '${fp.value}'.` }); }
    if (o.attributes && s.dnp !== fp.dnp) { changes++; any = true; e.dnp = fp.dnp; lines.push({ severity: "action", text: `Change ${describeRef(R)} 'Do not populate' from '${tf(s.dnp)}' to '${tf(fp.dnp)}'.` }); }
    if (o.attributes && !s.inBom !== fp.excludeFromBom) { changes++; any = true; e.inBom = !fp.excludeFromBom; lines.push({ severity: "action", text: `Change ${describeRef(R)} 'Exclude from bill of materials' from '${tf(!s.inBom)}' to '${tf(fp.excludeFromBom)}'.` }); }
    if (o.attributes && !s.inPos !== fp.excludeFromPos) { changes++; any = true; e.inPos = !fp.excludeFromPos; lines.push({ severity: "action", text: `Change ${describeRef(R)} 'Exclude from position files' from '${tf(!s.inPos)}' to '${tf(fp.excludeFromPos)}'.` }); }
    if (o.netNames) {
      for (const [pad, boardNet] of fp.pads) {
        const schNet = s.pins.get(pad);
        if (schNet === undefined) continue;
        if (schNet === boardNet || autoNet(boardNet) || autoNet(schNet) || labels.some((l) => l.from === schNet)) continue;
        changes++; labels.push({ from: schNet, to: boardNet, ref: R, pin: pad });
        lines.push({ severity: "action", text: `Change ${describeRef(R)} pin ${pad} net label from '${schNet}' to '${boardNet}'.` });
      }
    }
    if (o.otherFields) {
      for (const [name, val] of fp.fields) {
        if (name === "Reference" || name === "Value" || name === "Footprint") continue;
        const cur = s.fields.get(name);
        if (cur !== undefined && !hasVars(cur) && cur !== val) { changes++; any = true; e.setFields.set(name, val); lines.push({ severity: "action", text: `Change ${describeRef(R)} field '${name}' value to '${val}'.` }); }
        if (cur === undefined && !MANDATORY.has(name)) { changes++; any = true; e.addFields.set(name, val); lines.push({ severity: "action", text: `Add ${describeRef(R)} field '${name}' with value '${val}'.` }); }
      }
      for (const name of s.fields.keys()) if (!MANDATORY.has(name) && !fp.fields.has(name)) { changes++; any = true; e.deleteFields.push(name); lines.push({ severity: "action", text: `Delete ${describeRef(R)} field '${name}.'` }); }
    }
    if (any) edits.push(e);
  }
  return { lines, edits, labels, relinks, changes };
}

// ---------------------------------------------------------------- reading the board
type N = SNode;
const isList = Array.isArray;
const sv = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const kid = (n: N, k: string): N | null => { for (let i = 1; i < n.length; i++) { const c = n[i]; if (isList(c) && c[0] === k) return c as N; } return null; };
const kids = (n: N, k: string): N[] => n.filter((c) => isList(c) && c[0] === k) as N[];
/** The footprint's data the back-annotation reads (its (path), fpid, fields, attributes and pad nets). */
export function fpData(fp: N): FpData {
  const fields = new Map<string, string>();
  let ref = "", value = "";
  for (const p of kids(fp, "property")) { const name = sv(p[1]), val = sv(p[2]); if (name === "Reference") ref = val; else if (name === "Value") value = val; else if (!/^ki_/.test(name) && !/^Sheet ?(file|name)$/i.test(name)) fields.set(name, val); }
  for (const t of kids(fp, "fp_text")) { if (sv(t[1]) === "reference" && !ref) ref = sv(t[2]); if (sv(t[1]) === "value" && !value) value = sv(t[2]); }
  const attr = kid(fp, "attr"), flags = attr ? attr.slice(1).map(sv) : [];
  const pads = new Map<string, string>();
  for (const pad of kids(fp, "pad")) { const num = sv(pad[1]), net = kid(pad, "net"); if (!num || !net) continue; const name = sv(net.length > 2 ? net[2] : net[1]); if (!pads.has(num)) pads.set(num, name); }
  const path = kid(fp, "path");
  return { ref, path: path ? sv(path[1]) : "", fpid: sv(fp[1]), value, dnp: flags.includes("dnp"), excludeFromBom: flags.includes("exclude_from_bom"), excludeFromPos: flags.includes("exclude_from_pos_files"), fields, pads };
}
