// import-fp-assignments.ts — File > Import > Footprint Assignments... (SCH_EDITOR_CONTROL::ImportFPAssignments and
// processCmpToFootprintLinkFile, eeschema/tools/assign_footprints.cpp): a .cmp symbol-footprint link file is read, the
// visibility choice is asked ("Change Visibility"), and every non-power symbol whose reference on a sheet instance is
// one the file names takes the file's footprint (all units of a package: the search does not stop at the first hit).
import { h, KD } from "./dom";
import * as L from "./sch-items-logic";

/** One BeginCmp … EndCmp block: the Reference and IdModule values, stored between '=' and the last ';', trimmed. */
export interface CmpEntry { reference: string; footprint: string }
export function parseCmpFile(text: string): CmpEntry[] {
  const lines = text.split(/\r\n|\n|\r/), out: CmpEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const buffer = lines[i++];
    if (!buffer.startsWith("BeginCmp")) continue;
    let reference = "", footprint = "";
    while (i < lines.length) {
      const b = lines[i++];
      if (b.startsWith("EndCmp")) break;
      // AfterFirst( '=' ) then BeforeLast( ';' ): with no ';' BeforeLast gives an empty string
      const eq = b.indexOf("="), after = eq < 0 ? "" : b.slice(eq + 1), semi = after.lastIndexOf(";");
      const value = (semi < 0 ? "" : after.slice(0, semi)).trim();
      if (b.startsWith("Reference")) reference = value;
      else if (b.startsWith("IdModule")) footprint = value;
    }
    out.push({ reference, footprint });
  }
  return out;
}

/** The visibility choice: 0 keeps each footprint field's own, 1 shows them all, 2 hides them all. */
export type VisibilityChoice = 0 | 1 | 2;
/** A non-power symbol on a sheet instance (SCH_REFERENCE): its document, item and composed reference there. */
export interface CmpSymbolRef { docId: string; id: string; ref: string }
/**
 * processCmpToFootprintLinkFile's edits: for each block with a reference, every symbol whose composed reference is that
 * one gets SetFootprintFieldText( footprint ) (an empty footprint too), and with a forced visibility its footprint
 * field shown or hidden.  Returns the edited symbol nodes by document and item id (later blocks win, as in KiCad).
 */
export function cmpEdits(entries: CmpEntry[], refs: CmpSymbolRef[], nodeOf: (docId: string, id: string) => SNode | null, vis: VisibilityChoice): Map<string, Map<string, SNode>> {
  const out = new Map<string, Map<string, SNode>>();
  for (const e of entries) {
    if (!e.reference) continue;
    for (const r of refs) {
      if (r.ref !== e.reference) continue;
      let m = out.get(r.docId); if (!m) { m = new Map(); out.set(r.docId, m); }
      const base = m.get(r.id) || nodeOf(r.docId, r.id); if (!base) continue;
      const n = L.clone(base);
      let p = L.kids(n, "property").find((q) => L.fieldName(q) === "Footprint") || null;
      if (!p) { p = ["property", "Footprint", "", ["at", 0, 0, 0], ["hide", "yes"]] as unknown as SNode; n.push(p); }
      const row = L.rowFromField(p, [0, 0], true);
      row.value = e.footprint;
      if (vis !== 0) row.show = vis === 1;
      const next = L.fieldFromRow(row, [0, 0]);
      for (let j = 1; j < n.length; j++) if (n[j] === p) n[j] = next;
      m.set(r.id, n);
    }
  }
  return out;
}

/** wxFileDialog "Load Symbol Footprint Link File" (FootprintAssignmentFileWildcard: *.cmp). */
export function pickCmpFile(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept: ".cmp", style: "display:none" }) as HTMLInputElement;
    let settled = false;
    const done = (v: { name: string; text: string } | null) => { if (settled) return; settled = true; input.remove(); resolve(v); };
    input.addEventListener("change", () => {
      const f = input.files && input.files[0]; if (!f) { done(null); return; }
      f.text().then((text) => done({ name: f.name, text }), () => done({ name: f.name, text: "\u0000" }));
    });
    input.addEventListener("cancel", () => done(null));
    document.body.append(input); input.click();
  });
}

/** wxSingleChoiceDialog "Change Visibility": "Select the footprint field visibility setting." and the three choices
 *  (a list with the first selected; a double-click picks one and closes). */
export function askVisibility(): Promise<VisibilityChoice | null> {
  const choices = ["Keep existing footprint field visibility", "Show all footprint fields", "Hide all footprint fields"];
  return new Promise((resolve) => {
    let pick = 0, settled = false;
    const finish = (v: VisibilityChoice | null) => { if (settled) return; settled = true; resolve(v); };
    const list = h("div", { class: "kd-choice-list", tabindex: "0", style: "display:flex;flex-direction:column;margin-top:6px;border:1px solid var(--color-line);padding:1px;outline:none" });
    const rows = choices.map((c, i) => { const r = h("div", { class: "kd-choice", "data-choice": String(i), style: "padding:2px 6px;cursor:default" }, c); list.append(r); return r; });
    const paint = () => rows.forEach((r, i) => { r.classList.toggle("on", i === pick); r.style.background = i === pick ? "var(--color-sel)" : ""; });
    const api = KD().open({ title: "Change Visibility", width: 360, fixedSize: true,
      build(b) {
        b.append(h("p", { style: "margin:4px 0" }, "Select the footprint field visibility setting."), list); paint();
        rows.forEach((r, i) => { r.addEventListener("click", () => { pick = i; paint(); }); r.addEventListener("dblclick", () => { pick = i; finish(pick as VisibilityChoice); api.close(); }); });
        list.addEventListener("keydown", (ev) => {
          if (ev.key === "ArrowDown") { pick = Math.min(choices.length - 1, pick + 1); paint(); ev.preventDefault(); }
          else if (ev.key === "ArrowUp") { pick = Math.max(0, pick - 1); paint(); ev.preventDefault(); }
        });
        setTimeout(() => list.focus(), 0);
      },
      ok() { finish(pick as VisibilityChoice); },
      cancel() { finish(null); },
    });
  });
}
