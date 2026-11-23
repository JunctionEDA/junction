// dialogs/schematic-setup-pages.ts — the Schematic Setup pages beyond Formatting / Rules / Net Classes:
//   General > Annotation                 PANEL_EESCHEMA_ANNOTATION_OPTIONS (schematic.annotation.*, annotate_start_num,
//                                        subpart_id_separator / subpart_first_id, reuse_designators)
//   Electrical Rules > Compare Symbol    PANEL_SETUP_SYMBOL_PARITY (schematic.compare_symbols.*)
//     with Library
//   Project > Net Chains                 PANEL_SETUP_NET_CHAINS (the root sheet's (net_chain …) items and
//                                        net_settings.net_chain_classes)
//   Schematic Data > Embedded Files      PANEL_EMBEDDED_FILES (the root sheet's (embedded_files …))
// and DIALOG_SCH_IMPORT_SETTINGS (Import Settings from Another Project...), whose sections are copied by
// importSections.  The logic half (annotationOf, separatorChoice, chainsOf, importSections) is plain data.
import { KD, checkbox, h, select, textInput, promptText, confirmBox } from "./dom";
import { messageBox } from "./sch-items";
import { kicadIcon, bitmapButton } from "../../../shared/components/kicon-dom";
import { embeddedFilesPanel } from "../editor/pcbdialogs/fp-3d-panel";
import { checkField } from "../editor/pcbdialogs/ui";
import { decodeEmbedded, embeddedFileNames, embeddedFileNode, fileData } from "../library/embedded-file";
import { PARITY, UNIT_NOTATIONS, validChainName, type AnnotationSettings, type ChainRow, type ChainState } from "./schematic-setup-logic";
export * from "./schematic-setup-logic";

// ---------------------------------------------------------------- Annotation
export function annotationPage(pg: HTMLElement, s: AnnotationSettings, ro: boolean): void {
  const radio = (name: string, on: boolean, label: Node | string, set: () => void, id?: string): HTMLElement => {
    const r = h("input", { type: "radio", name, checked: on, disabled: ro, id }) as HTMLInputElement; r.addEventListener("change", () => { if (r.checked) set(); });
    return h("label", { class: "kd-chk" }, r, label);
  };
  const units = KD().staticBox(pg, "Units");
  units.append(h("div", { class: "kd-row" }, h("label", null, "Symbol unit notation:"), select(UNIT_NOTATIONS.map((n, i) => [String(i), n[0]] as [string, string]), String(s.notation), (v) => { s.notation = +v; }, { id: "kd-ss-unitnotation", disabled: ro, style: "width:90px" })));
  const order = KD().staticBox(pg, "Order");
  order.append(h("div", { class: "kd-row" }, kicadIcon("annotate_down_right", 24), radio("kd-ss-sort", !s.sortY, "Sort symbols by X position", () => { s.sortY = false; }, "kd-ss-sortx")),
    h("div", { class: "kd-row" }, kicadIcon("annotate_right_down", 24), radio("kd-ss-sort", s.sortY, "Sort symbols by Y position", () => { s.sortY = true; }, "kd-ss-sorty")));
  const num = KD().staticBox(pg, "Numbering");
  const after = textInput(String(s.startNum), (v) => { const n = parseInt(v, 10); s.startNum = isFinite(n) && n >= 0 ? n : 0; }, { id: "kd-ss-startnum", disabled: ro, style: "width:70px" });
  num.append(h("div", { class: "kd-row" }, radio("kd-ss-method", s.method === 0, "Use first free number after:", () => { s.method = 0; }, "kd-ss-firstfree"), after),
    radio("kd-ss-method", s.method === 1, "First free after sheet number X 100", () => { s.method = 1; }, "kd-ss-x100"),
    radio("kd-ss-method", s.method === 2, "First free after sheet number X 1000", () => { s.method = 2; }, "kd-ss-x1000"),
    checkbox("Allow reference reuse", s.reuse, (on) => { s.reuse = on; }, { id: "kd-ss-reuse", disabled: ro }));
  const rs = KD().staticBox(pg, "Reused Sheets");
  rs.append(radio("kd-ss-reused", !s.suffixes, "Number each sheet instance separately (R1, R2 ...)", () => { s.suffixes = false; }, "kd-ss-separate"),
    radio("kd-ss-reused", s.suffixes, "Number each file once and add the sheet's reference suffix (R1_M1, R1_M2 ...)", () => { s.suffixes = true; }, "kd-ss-suffix"),
    h("p", { class: "kd-note", style: "margin:2px 0 6px 22px" }, "Repeated instances of one sheet file need distinct full reference suffixes. Set Reference Suffix in Sheet Properties."),
    checkbox("Give pasted sheets the next free reference suffix", s.incrementPasted, (on) => { s.incrementPasted = on; }, { id: "kd-ss-incpasted", disabled: ro }));
  const tip = rs.querySelector("#kd-ss-incpasted"); if (tip && tip.parentElement) tip.parentElement.title = "A pasted sheet whose suffix is already in use continues its series, so _M1 becomes _M4 when _M3 is in use";
}

// ---------------------------------------------------------------- Compare Symbol with Library
export function parityPage(pg: HTMLElement, p: Record<string, boolean>, ro: boolean): void {
  for (const [title, rows] of PARITY) {
    const box = KD().staticBox(pg, title);
    for (const [k, label] of rows) box.append(checkbox(label, p[k], (on) => { p[k] = on; }, { id: "kd-ss-parity-" + k, disabled: ro }));
  }
}

// ---------------------------------------------------------------- Net Chains
/** PANEL_SETUP_NET_CHAINS: the Chains tab (grid, member nets, delete) and the Net Chain Classes tab.  The edits are
 *  buffered in `st` and applied on OK (ApplyEdits); `colorCell` is the dialog's GRID_CELL_COLOR_RENDERER. */
export function netChainsPage(pg: HTMLElement, st: ChainState, netClasses: () => string[], ro: boolean,
  colorCell?: (td: HTMLElement, css: string, ro: boolean, commit: (css: string) => void) => void): void {
  if (!st.classOrig) st.classOrig = st.classes.slice();
  if (!st.deletedClasses) st.deletedClasses = [];
  KD().notebook(pg, [
    { label: "Chains", build(tab) {
      const header = h("div", { id: "kd-ss-chains-header", style: "margin:4px 0 4px 2px" });
      const members = h("div", { class: "kd-list", id: "kd-ss-chain-members", style: "height:240px;overflow:auto;border:1px solid var(--line);border-radius:var(--r-1);background:var(--field)" });
      const mlabel = h("div", { style: "margin:0 0 4px" }, "Member Nets");
      // updateMembersDetail: the row's nets, sorted
      const show = (r: ChainRow | null): void => {
        mlabel.textContent = r ? (r.name ? `Member Nets \u2014 ${r.name} (${r.nets.length})` : `Member Nets (${r.nets.length})`) : "Member Nets";
        members.replaceChildren(...(r ? r.nets.slice().sort() : []).map((n) => h("div", { style: "padding:1px 6px" }, n)));
      };
      // the choice editors allow other text (wxGridCellChoiceEditor( choices, true )): the choices are suggestions
      const classList = "kd-ss-chain-classes", ncList = "kd-ss-chain-netclasses";
      const dlClasses = h("datalist", { id: classList }), dlNc = h("datalist", { id: ncList });
      const fillLists = (): void => {
        dlClasses.replaceChildren(...["", ...st.classes.filter(Boolean)].map((c) => h("option", { value: c })));
        dlNc.replaceChildren(...["", ...netClasses()].map((c) => h("option", { value: c })));
      };
      const view: ChainRow[] = [];
      const lastName = new Map<ChainRow, string>();
      const cols = [
        { key: "name", label: "Name", type: "text" as const },
        { key: "nets", label: "Members", type: "ro" as const, width: 80, format: (v: unknown) => `${(v as string[]).length} nets` },
        { key: "chainClass", label: "Net Chain Class", type: "text" as const, width: 150, list: classList },
        { key: "netClass", label: "Net Class", type: "text" as const, width: 120, list: ncList },
        colorCell ? { key: "color", label: "Colour", width: 140, render: (td: HTMLElement, r: ChainRow, cro: boolean, commit: (v: unknown) => void) => colorCell(td, r.color, cro, (css) => commit(css)) }
          : { key: "color", label: "Colour", type: "ro" as const, width: 140 },
      ];
      let sel = -1;
      const g = KD().grid<ChainRow>(h("div"), cols, view, { readOnly: ro, height: 240,
        onSelect: (r, i) => { sel = r ? i : -1; del.disabled = ro || sel < 0; show(r); },
        onChange: (r, key) => {
          if (key !== "name") return;
          // the Name cell: invalid characters are refused and the old name comes back
          if (!validChainName(r.name)) { const was = lastName.get(r) ?? ""; const bad = r.name; r.name = was; g.refresh(); void messageBox(`Name '${bad}' contains invalid characters.`, "Net Chains"); return; }
          lastName.set(r, r.name); show(r);
        } });
      // rebuildChainsGrid: the rows not pending deletion, the count above them
      const rebuild = (): void => {
        view.splice(0, view.length, ...st.chains.filter((r) => !r.deleted));
        for (const r of view) if (!lastName.has(r)) lastName.set(r, r.name);
        header.textContent = `${view.length} net chain(s)`;
        fillLists(); g.refresh();
        if (sel >= view.length) sel = -1;
        show(sel >= 0 ? view[sel] : null);
      };
      const left = h("div", { style: "flex:3;min-width:0" }, g.el), right = h("div", { style: "flex:1;min-width:140px" }, mlabel, members);
      const del = bitmapButton("small_trash", "Delete the selected committed net chain", async () => {
        if (sel < 0 || sel >= view.length) return;
        const r = view[sel];
        if (!(await confirmBox("Delete Net Chain", `Delete net chain '${r.name}'?`, "Yes"))) return;
        r.deleted = true; sel = -1; rebuild();
      }, { cls: "kd-ss-chain-del" });
      del.disabled = true;
      tab.append(header, h("div", { style: "display:flex;gap:8px" }, left, right), h("div", { class: "kd-row", style: "margin-top:4px" }, del), dlClasses, dlNc);
      rebuild();
      if (view.length) g.select(0); else show(null);
    } },
    { label: "Net Chain Classes", build(tab) {
      const count = (c: string): number => st.chains.filter((r) => !r.deleted && r.chainClass === c).length;
      const rows = st.classes.map((name) => ({ name, members: count(name) }));
      const host = h("div");
      const g = KD().grid<{ name: string; members: number }>(host, [{ key: "name", label: "Class Name", type: "ro" }, { key: "members", label: "Members", type: "ro", width: 90 }], rows, { readOnly: ro, height: 260 });
      const sync = (): void => { st.classes.splice(0, st.classes.length, ...rows.map((r) => r.name)); for (const r of rows) r.members = count(r.name); g.refresh(); };
      const taken = (n: string, except = -1): boolean => !n.trim() || rows.some((r, i) => i !== except && r.name === n.trim());
      const add = bitmapButton("small_plus", "Add a new net chain class", async () => {
        const n = await promptText("Add Class", "New net chain class name:"); if (n === null) return;
        if (taken(n)) { await messageBox("That class name is empty or already in use.", "Add Class"); return; }
        rows.push({ name: n.trim(), members: 0 }); st.classOrig!.push(""); sync(); g.select(rows.length - 1);
      });
      const ren = bitmapButton("small_edit", "Rename the selected class (updates every chain that uses it)", async () => {
        const i = g.selected(); if (i < 0) return; const old = rows[i].name;
        const n = await promptText("Rename Class", "Rename net chain class:", old); if (n === null || n.trim() === old) return;
        if (taken(n, i)) { await messageBox("That class name is empty or already in use.", "Rename Class"); return; }
        rows[i].name = n.trim(); for (const c of st.chains) if (c.chainClass === old) c.chainClass = n.trim(); sync();
      });
      const del = bitmapButton("small_trash", "Delete the selected class (chains revert to no class)", async () => {
        const i = g.selected(); if (i < 0) return;
        if (!(await confirmBox("Delete Class", `Delete net chain class '${rows[i].name}'?  Chains assigned to it will become unclassified.`, "Yes"))) return;
        const old = rows[i].name; rows.splice(i, 1); const o = st.classOrig!.splice(i, 1)[0]; if (o) st.deletedClasses!.push(o);
        for (const c of st.chains) if (c.chainClass === old) c.chainClass = ""; sync();
      });
      for (const b of [add, ren, del]) b.disabled = ro;
      tab.append(h("div", { style: "margin:4px 0 6px 2px" }, "Group net chains under a class label so DRC rules can target the whole group via ", h("code", null, "inNetChainClass('name')"), "."),
        host, h("div", { class: "kd-row", style: "margin-top:4px" }, add, ren, h("span", { style: "width:20px" }), del));
    } },
  ]);
}
// ---------------------------------------------------------------- Embedded Files
/** The root schematic's embedded files as the page opens: its (embedded_files …) and (embedded_fonts …). */
export interface EmbeddedFilesState { files: SNode | null; fonts: boolean }
/** What OK writes into the root schematic (PANEL_EMBEDDED_FILES::TransferDataFromWindow): files put, files removed, Embed fonts. */
export interface EmbeddedFilesEdit { put: string[]; remove: string[]; fonts?: boolean }
/**
 * PANEL_EMBEDDED_FILES over the root schematic's files (the shared panel, pcbdialogs/fp-3d-panel.ts): add (with the
 * Embedded File Conflict question), remove, Embed fonts (onFontEmbedClick over SCHEMATIC::GetFonts()), Export... and the
 * grid's Copy Embedded Reference.  `onEdit` receives the getter OK reads (null: nothing changed).
 */
export function embeddedFilesPage(pg: HTMLElement, load: () => Promise<EmbeddedFilesState>, opts: { ro: boolean; fonts(): Promise<{ name: string; bytes: Uint8Array }[]>; onEdit(get: () => EmbeddedFilesEdit | null): void }): void {
  const host = h("div", null, "Loading...");
  pg.append(host);
  void load().then((st) => {
    host.textContent = "";
    const embed = checkField(st.fonts, "Embed fonts", { ro: opts.ro, key: "embedFonts", tip: "Store a copy of all fonts used" });
    const panel = embeddedFilesPanel({ names: embeddedFileNames(st.files), ro: opts.ro, bytes: (n) => decodeEmbedded(fileData(embeddedFileNode(st.files, n))), embedFonts: embed, fonts: opts.fonts, height: "300px" });
    host.append(panel.el);
    opts.onEdit(() => {
      const put = panel.added().map((a) => a.sexpr), remove = panel.removed(), fonts = embed.get();
      if (!put.length && !remove.length && fonts === st.fonts) return null;
      return fonts === st.fonts ? { put, remove } : { put, remove, fonts };
    });
  }, () => { host.textContent = "The root schematic could not be read."; });
}

// ---------------------------------------------------------------- Import Settings
