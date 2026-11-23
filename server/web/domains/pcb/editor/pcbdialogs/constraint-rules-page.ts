// pcbdialogs/constraint-rules-page — one Board Setup > Design Rules > <family> > <section> page
// (PANEL_SETUP_CONSTRAINT_RULES): the section's board defaults with their warnings and the "Used where no rule below
// matches" note, the "Rules" heading with "Edit net classes", the evaluation-order note, and CONSTRAINT_RULES_LIST: the
// net class rows above the rules of the type (#, Name, Condition, Layers, Constraint), Move Up / Move Down / Duplicate /
// Remove, and the rule form (PANEL_DRC_RULE_EDITOR, opened in place) with Add Rule / Apply and New Rule.  Every page
// edits the one RuleDocument; the board defaults go to the staged settings the Constraints and Solder Mask/Paste
// pages share.  The override popup of the Constraints page is here too (OVERRIDING_RULES_POPUP).
import { bitmapButton, checkField, fmtLen, fmtLenU, h, lenField, messageBox, numField, parseLen, selectField, textField, unitName, type Field, type Warning } from "./ui";
import { kicadIcon } from "../../../../shared/components/kicon-dom";
import { ruleText, typeById, type Cond, type CondKind, type Rule } from "./drc-rule-model";
import { constraintText, copyRule, entryCondition, entryLayer, layerChoices, layersText, newRule, netclassOrder, netclassValue, overrideNote, severityText, validateRule,
  type NetclassLike, type RuleDocument, type Section } from "./constraint-rules";

/** The board defaults the rule pages, the Constraints page and the Solder Mask/Paste page share (m_stagedSettings). */
export interface StagedSettings { values: Map<string, number>; issues(values: Record<string, number>): { errors: { setting: string; message: string }[]; warnings: { setting: string; message: string }[] } }
export interface RulePageCtx {
  doc: RuleDocument; staged: StagedSettings; ro: boolean;
  /** the board has no project, so it has no rules file (GetDesignRulesPath() is empty) */
  noProject: boolean;
  netclasses(): NetclassLike[];
  showPage(title: string): void;
  /** SetChangeCallback: the document changed, every open rule page reads it again */
  changed(): void;
  setError(msg: string, ctrl?: HTMLElement | null): void;
  /** ShowMatches: how many board items the rule matches, selecting them; -1 when it does not compile */
  showMatches(ruleText: string, name: string): number;
  checkSyntax(ruleText: string): string[];
  syntaxHelp(): void;
  enabledLayers(): string[]; layerName(l: string): string; netNames(): string[]; areaNames(): string[];
}
export interface RulePage {
  build(el: HTMLElement): void;
  refreshDefaults(): void; refreshFromDocument(): void;
  /** applyDefaults: the defaults written to the staged settings, or the first value out of range */
  applyDefaults(): { msg: string; ctrl: HTMLElement } | null;
  hasPendingRule(): boolean;
  /** ConfirmPendingRule: done(true) once the form's rule is added, applied or discarded, done(false) on Cancel */
  confirmPendingRule(done: (ok: boolean) => void): void;
  showRule(type: string, index: number): void;
}

const CSS = `
.crp-head { font-weight: 600; margin: 8px 0; }
.crp-defaults { display: grid; grid-template-columns: max-content 130px max-content; gap: 4px 8px; align-items: center; margin: 0 5px 4px 13px; font-size: 12px; }
.crp-defaults .fld { display: inline-flex; align-items: center; }
.crp-note { font-style: italic; font-size: 12px; color: var(--ink-2); margin: 2px 13px 6px; white-space: pre-wrap; }
.crp-rulesrow { display: flex; align-items: center; margin: 8px 0 0 8px; } .crp-rulesrow .sp { flex: 1; } .crp-rulesrow a { font-size: 12px; margin: 0 12px; }
.crp-sep { border: 0; border-top: 1px solid var(--line); margin: 6px 5px; }
.crp-list { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 4px; table-layout: auto; }
.crp-list th, .crp-list td { border-bottom: 1px solid var(--line); padding: 2px 6px; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; }
.crp-list td.n { text-align: right; width: 36px; } .crp-list tr.nc td { color: var(--ink-3, #888); }
.crp-list tbody tr { cursor: default; } .crp-list tbody tr.sel td { background: var(--sel); }
.crp-empty { font-style: italic; font-size: 12px; margin: 4px; }
.crp-btns { display: flex; gap: 4px; margin: 4px 0; flex-wrap: wrap; }
.crp-form { margin-top: 8px; border-top: 1px solid var(--line); padding-top: 6px; }
.crp-form .hd { font-weight: 600; margin: 10px 0 2px; display: flex; gap: 8px; align-items: center; } .crp-form .hd a { font-weight: 400; margin-left: auto; }
.crp-form .ov { font-style: italic; font-size: 12px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.crp-grid { display: grid; grid-template-columns: max-content 140px max-content; gap: 5px 8px; align-items: center; }
.crp-cond { display: flex; gap: 6px; align-items: center; margin: 4px 0; } .crp-cond > .grow { flex: 1 1 auto; min-width: 120px; } .crp-cond .grow > * { width: 100%; }
.crp-msg { white-space: pre-wrap; font-size: 12px; color: var(--ink-2); } .crp-msg.err { color: var(--err, #c33); }
.crp-custom { width: 100%; height: 180px; font-family: var(--mono, monospace); font-size: 12px; }
.crp-link { display: inline-flex; cursor: pointer; margin-left: 2px; }
.crp-pop { position: fixed; z-index: 10040; background: var(--panel); border: 1px solid var(--line); box-shadow: 0 4px 14px rgba(0,0,0,.25); padding: 8px; max-width: 720px; max-height: 360px; overflow-y: auto; font-size: 12px; }
.crp-pop .ph { font-weight: 600; margin-top: 10px; } .crp-pop .ph:first-child { margin-top: 0; }
.crp-pop .pr { display: flex; gap: 8px; margin-top: 3px; align-items: center; white-space: nowrap; } .crp-pop .pr span { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.crp-pop .pl { display: block; margin-top: 10px; }
`;
let cssDone = false;
const ensureCrpCss = (): void => { if (cssDone || typeof document === "undefined") return; cssDone = true; document.head.append(h("style", null, CSS)); };

/** The value of a board default as the page shows it (StringFromValue with units, or a plain count) */
const shownValue = (v: number, count: boolean): string => (count ? String(Math.round(v)) : fmtLenU(v));

/** PANEL_SETUP_CONSTRAINT_RULES */
export function constraintRulesPage(ctx: RulePageCtx, section: Section): RulePage {
  ensureCrpCss();
  const type = section.ruleType, doc = ctx.doc;
  interface DefaultCtl { setting: string; f: Field<number>; warn: Warning; loaded: number; count: boolean; label: string }
  const defaults: DefaultCtl[] = [];
  let built = false;
  // CONSTRAINT_RULES_LIST state
  let heading: HTMLElement | null = null, tbody: HTMLTableSectionElement | null = null, table: HTMLTableElement | null = null, empty: HTMLElement | null = null;
  let upB: HTMLButtonElement, downB: HTMLButtonElement, dupB: HTMLButtonElement, rmB: HTMLButtonElement, primary: HTMLButtonElement, newB: HTMLButtonElement;
  let formHost: HTMLElement | null = null, tableButtons: HTMLElement | null = null, formButtons: HTMLElement | null = null;
  let rowToIndex: number[] = [];
  let selectedRow = -1;
  /** m_editingData: the document's rule the form edits (null for a new rule), and the draft the form writes */
  let editing: Rule | null = null, draft: Rule = newRule(type, ""), modified = false;
  let refreshing = false;
  let noteEl: HTMLElement | null = null, validation: HTMLElement | null = null;

  const indexOf = (r: Rule | null): number => (r ? doc.entries.indexOf(r) : -1);
  const editingIndex = (): number => indexOf(editing);
  const selectedIndex = (): number => (selectedRow >= 0 && selectedRow < rowToIndex.length ? rowToIndex[selectedRow] : -1);
  const notify = (): void => ctx.changed();

  // ---------------------------------------------------------------- the defaults
  const values = (): Record<string, number> => { const o: Record<string, number> = {}; for (const [k, v] of ctx.staged.values) o[k] = v; for (const d of defaults) o[d.setting] = d.f.get(); return o; };
  const updateWarnings = (): void => {
    if (!defaults.length) return;
    const { errors, warnings } = ctx.staged.issues(values()), msgs = new Map<string, string>();
    for (const i of [...errors, ...warnings]) msgs.set(i.setting, (msgs.has(i.setting) ? msgs.get(i.setting) + "\n" : "") + i.message);
    for (const d of defaults) d.warn.set(msgs.get(d.setting) || null);
    showOverrideNote();
  };
  const refreshDefaults = (): void => {
    for (const d of defaults) { d.loaded = ctx.staged.values.get(d.setting) ?? 0; d.f.set(d.loaded); }
    updateWarnings();
  };
  const applyDefaults = (): { msg: string; ctrl: HTMLElement } | null => {
    if (!defaults.length) return null;
    // a page reports only the values it edits
    const { errors } = ctx.staged.issues(values());
    for (const e of errors) { const d = defaults.find((x) => x.setting === e.setting); if (d) return { msg: e.message, ctrl: d.f.input }; }
    // a field the user did not touch here must not write back over an edit made on another page
    for (const d of defaults) { const v = d.f.get(); if (v !== d.loaded) { ctx.staged.values.set(d.setting, v); d.loaded = v; } }
    return null;
  };

  // ---------------------------------------------------------------- the rule list
  const addNetclassRows = (): number => {
    if (!section.netclass || !tbody) return 0;
    let row = 0;
    for (const c of netclassOrder(ctx.netclasses())) {
      const v = netclassValue(c, section.netclass); if (v === null) continue;
      const tr = h("tr", { class: "nc", "data-row": "netclass" }, h("td", { class: "n" }, ""), h("td", null, `Net class '${c.name}'`), h("td", null, `A.hasExactNetclass('${c.name}')`),
        h("td", null, "Any"), h("td", null, `(${section.part} ${fmtLenU(v)})`));
      const r = row;
      tr.addEventListener("click", () => select(r));
      tr.addEventListener("dblclick", () => ctx.showPage("Net Classes"));
      tbody.append(tr); rowToIndex.push(-1); row++;
    }
    return row;
  };
  const select = (row: number): void => {
    if (refreshing) return;
    const idx = row >= 0 && row < rowToIndex.length ? rowToIndex[row] : -1;
    const apply = (): void => { selectedRow = row; paintSelection(); updateButtons(); };
    if (idx >= 0 && idx !== editingIndex()) {
      // wxEVT_LIST_ITEM_SELECTED: opening another rule asks about one left in the form first
      editRule(idx, (ok) => { if (!ok) { selectedRow = rowOfIndex(editingIndex()); paintSelection(); updateButtons(); } });
      return;
    }
    apply();
  };
  const rowOfIndex = (i: number): number => (i < 0 ? -1 : rowToIndex.indexOf(i));
  const paintSelection = (): void => { if (!tbody) return; Array.from(tbody.children).forEach((tr, i) => tr.classList.toggle("sel", i === selectedRow)); };
  const refreshRules = (): void => {
    if (!built || !tbody || !table || !empty || !heading) return;
    const blocker = ctx.noProject ? "Design rules cannot be added without a project" : doc.hasUnparsedText() ? "The custom rules text does not parse. Fix it on the Custom Rules page first." : "";
    refreshing = true;
    tbody.replaceChildren(); rowToIndex = [];
    let row = addNetclassRows(), rules = 0;
    if (!blocker) {
      for (const index of doc.indicesFor(type)) {
        const r = doc.entries[index]; const n = ++rules;
        const tr = h("tr", { "data-row": "rule" }, h("td", { class: "n" }, String(n)), h("td", { title: r.name }, r.name), h("td", { title: entryCondition(r) }, entryCondition(r)), h("td", null, layersText(r)),
          h("td", null, constraintText(r, type, fmtLenU) + severityText(r)));
        const rr = row;
        tr.addEventListener("click", () => select(rr));
        tbody.append(tr); rowToIndex.push(index); row++;
      }
    }
    const anyRows = rowToIndex.length > 0, anyRules = rules > 0;
    heading.textContent = anyRules ? `${section.title} (${rules})` : section.title;
    empty.textContent = blocker || "No rules yet.";
    table.style.display = anyRows ? "" : "none"; empty.style.display = anyRows ? "none" : "";
    if (formHost) formHost.style.display = blocker ? "none" : "";
    if (formButtons) formButtons.style.display = blocker ? "none" : "";
    for (const b of [upB, downB, dupB, rmB]) b.style.display = anyRules ? "" : "none";
    if (editingIndex() >= 0) {
      // a sibling page may have changed the rule since the form was filled
      if (!modified) { draft = copyRule(editing as Rule); buildForm(); }
      selectedRow = rowOfIndex(editingIndex());
    } else if (editing) {
      showNewRule();
    } else selectedRow = -1;
    refreshing = false;
    paintSelection(); updateButtons();
  };
  const updateButtons = (): void => {
    const existing = editingIndex() >= 0, sel = selectedIndex() >= 0;
    primary.textContent = existing ? "Apply" : "Add Rule";
    primary.title = existing ? "Save the form back to the selected rule." : "Check the form and add it to the list of rules above.";
    newB.disabled = !existing || ctx.ro;
    for (const b of [upB, downB, dupB, rmB]) b.disabled = !sel || ctx.ro;
    primary.disabled = ctx.ro;
  };

  // ---------------------------------------------------------------- the form (PANEL_DRC_RULE_EDITOR)
  const showOverrideNote = (): void => {
    if (!noteEl) return;
    const ds: [string, string][] = section.defaults.map((d, i): [string, string] => {
      const name = section.defaults.length > 1 ? d.label.replace(/:$/, "") : section.title;
      const c = defaults[i]; return [name, c ? shownValue(c.f.get(), c.count) : ""];
    });
    const idx = editingIndex();
    const text = !ds.length || draft.type === "CUSTOM_RULE" || idx < 0 ? "" : overrideNote(ds, entryCondition(draft), entryLayer(draft));
    noteEl.textContent = text; noteEl.title = text; noteEl.style.display = text ? "" : "none";
  };
  const touched = (): void => { modified = true; showOverrideNote(); if (validation) { validation.textContent = ""; validation.classList.remove("err"); } };
  const lenIn = (k: string): HTMLInputElement => {
    const v = draft.v[k];
    const inp = h("input", { type: "text", "data-k": k, value: v === null || v === undefined ? "" : fmtLen(Number(v)), disabled: ctx.ro }) as HTMLInputElement;
    inp.addEventListener("change", () => { const x = parseLen(inp.value); draft.v[k] = isNaN(x) ? null : x; if (!isNaN(x)) inp.value = fmtLen(x); touched(); });
    return inp;
  };
  const numIn = (k: string): HTMLInputElement => {
    const v = draft.v[k];
    const inp = h("input", { type: "text", "data-k": k, value: v === null || v === undefined ? "" : String(v), disabled: ctx.ro }) as HTMLInputElement;
    inp.addEventListener("change", () => { const x = parseFloat(inp.value); draft.v[k] = isNaN(x) ? null : x; touched(); });
    return inp;
  };
  const chk = (k: string, label: string): HTMLElement => checkField(!!draft.v[k], label, { ro: ctx.ro, key: k, onChange: (v) => { draft.v[k] = v; touched(); } }).el;
  const constraintPanel = (): HTMLElement => {
    const dt = typeById(draft.type), u = (): HTMLElement => h("span", { class: "unit" }, unitName());
    const row = (label: string, ctl: HTMLElement, unit?: HTMLElement | null): HTMLElement[] => [h("label", null, label), ctl, unit || h("span")];
    const g3 = (...rows: HTMLElement[][]): HTMLElement => h("div", { class: "crp-grid" }, ...rows.flat());
    const mom = (p: string, q: string): HTMLElement => g3(row(`Minimum ${q}:`, lenIn(p + "min"), u()), row(`Preferred ${q}:`, lenIn(p + "opt"), u()), row(`Maximum ${q}:`, lenIn(p + "max"), u()));
    switch (dt.panel) {
      case "num": return g3(row(`${dt.label}:`, lenIn("value"), u()));
      case "int": return g3(row(`${dt.label}:`, numIn("value"), null));
      case "minmax": return g3(row("Minimum length:", lenIn("min"), u()), row("Maximum length:", lenIn("max"), u()));
      case "minoptmax": return mom("", "width");
      case "viastyle": return h("div", { style: "display:flex;gap:24px;flex-wrap:wrap" }, mom("d", "via diameter"), mom("h", "hole size"));
      case "text": return g3(row("Minimum text height:", lenIn("height"), u()), row("Minimum text thickness:", lenIn("thickness"), u()));
      case "diffpair": return h("div", null, h("div", { style: "display:flex;gap:24px;flex-wrap:wrap" }, mom("w", "width"), mom("g", "gap")), h("div", { style: "margin-top:6px" }, g3(row("Maximum uncoupled length:", lenIn("uncoupled"), u()))));
      case "matchlen": return h("div", null, mom("", "length"), h("div", { style: "margin-top:6px" }, g3(row("Maximum skew:", lenIn("skew"), u()))), h("div", { style: "margin-top:6px" }, chk("within", "Within diff pairs")));
      case "layers": return h("div", null, chk("top", "Top layer"), chk("bottom", "Bottom layer"));
      case "orient": return h("div", { style: "display:flex;gap:16px" }, ...[0, 90, 180, 270].map((d) => chk("o" + d, `${d}°`)));
      case "smdvias": return h("div", null, chk("through", "Through vias"), chk("micro", "Micro vias"), chk("blind", "Blind vias"), chk("buried", "Buried vias"));
      default: {
        const ta = h("textarea", { class: "crp-custom", "data-k": "customRule", spellcheck: false }) as HTMLTextAreaElement; ta.value = draft.text; ta.disabled = ctx.ro;
        ta.addEventListener("input", () => { draft.text = ta.value; const m = /^\(rule\s+("([^"]*)"|[^\s()]+)/.exec(ta.value.trim()); if (m) draft.name = m[2] !== undefined ? m[2] : m[1]; touched(); });
        return ta;
      }
    }
  };
  const conditionsPanel = (): HTMLElement => {
    const two = typeById(draft.type).two, host = h("div", { "data-k": "conditions" });
    const draw = (): void => {
      if (!draft.conds.length) draft.conds.push({ op: "&&", obj: "A", kind: "any", value: "" });
      const rows = draft.conds.map((c, i) => {
        const parts: HTMLElement[] = [];
        if (i > 0) parts.push(selectField<string>(c.op, [["&&", "AND"], ["||", "OR"], ["&& !", "AND NOT"], ["|| !", "OR NOT"]], { ro: ctx.ro, key: "op" + i, onChange: (v) => { c.op = v as Cond["op"]; touched(); } }).el);
        if (two) parts.push(selectField<string>(c.obj, [["A", "Object A"], ["B", "Object B"]], { ro: ctx.ro, key: "obj" + i, onChange: (v) => { c.obj = v as "A" | "B"; touched(); } }).el);
        parts.push(selectField<string>(c.kind, [["any", "Any"], ["net", "Net"], ["netclass", "Netclass"], ["area", "Within Area"], ["custom", "Custom Query"]], { ro: ctx.ro, key: "cond" + i, onChange: (v) => { c.kind = v as CondKind; c.value = ""; draw(); touched(); } }).el);
        let val: Field<string> | null = null;
        const pick = (names: string[]): Field<string> => selectField<string>(c.value, [["", ""], ...names.map((x): [string, string] => [x, x])], { ro: ctx.ro, key: "val" + i });
        if (c.kind === "net") val = pick(ctx.netNames());
        else if (c.kind === "netclass") val = pick(netclassOrder(ctx.netclasses()).map((x) => x.name));
        else if (c.kind === "area") val = pick(ctx.areaNames());
        else if (c.kind === "custom") val = textField(c.value, { ro: ctx.ro, key: "query" + i, placeholder: "A.Type == 'Via'" });
        if (val) { const f = val; const on = (): void => { c.value = f.get(); touched(); }; f.input.addEventListener("change", on); f.input.addEventListener("input", on); parts.push(h("div", { class: "grow" }, f.el)); }
        else parts.push(h("div", { class: "grow" }));
        parts.push(bitmapButton("small_trash", "Remove this condition", () => { draft.conds.splice(i, 1); draw(); touched(); }, { key: "removeCond" + i, disabled: ctx.ro || draft.conds.length < 2 }));
        return h("div", { class: "crp-cond" }, ...parts);
      });
      host.replaceChildren(h("div", { class: "pd-lbl" }, two ? "Where conditions match:" : "Where object matches:"), ...rows,
        bitmapButton("small_plus", "Add another condition", () => { draft.conds.push({ op: "&&", obj: "A", kind: "any", value: "" }); draw(); touched(); }, { key: "addCond", disabled: ctx.ro }));
    };
    draw(); return host;
  };
  const buildForm = (): void => {
    if (!formHost) return;
    const dt = typeById(draft.type), custom = dt.panel === "custom";
    noteEl = h("div", { class: "ov", "data-k": "overrideNote" });
    const name = textField(draft.name, { ro: ctx.ro || custom, key: "ruleName" }), comment = textField(draft.comment, { ro: ctx.ro || custom, key: "ruleComment" });
    name.input.title = "Name of this rule, must be unique"; comment.input.title = "Optional comment stored with the rule";
    name.input.addEventListener("input", () => { draft.name = name.get(); touched(); }); comment.input.addEventListener("input", () => { draft.comment = comment.get(); touched(); });
    const help = h("a", { href: "#", "data-k": "syntaxHelp" }, "Syntax help"); help.addEventListener("click", (ev) => { ev.preventDefault(); ctx.syntaxHelp(); });
    const report = h("div", { class: "crp-msg", "data-k": "syntaxReport", style: "flex:1" });
    const text = (): string => (custom ? draft.text : ruleText(draft));
    const check = bitmapButton("drc", "Check rule syntax", () => { const e = ctx.checkSyntax(text()); report.textContent = e.length ? e.join("\n") : "No errors found."; report.classList.toggle("err", e.length > 0); }, { key: "checkSyntax" });
    const matchReport = h("span", { class: "crp-msg", "data-k": "matchReport" });
    const show = h("button", { type: "button", class: "btn", "data-k": "showMatches" }, "Show Matches");
    show.addEventListener("click", () => {
      const n = ctx.showMatches(text(), draft.name);
      matchReport.textContent = n < 0 ? "The rule does not compile." : n === 0 ? "No board items match." : n === 1 ? "1 board item matches." : `${n} board items match.`;
      matchReport.title = matchReport.textContent;
    });
    validation = h("div", { class: "crp-msg err", "data-k": "validation" });
    const out = h("div", { "data-k": "ruleForm" },
      h("div", { style: "display:grid;grid-template-columns:max-content 1fr max-content 1fr;gap:5px 8px;align-items:center" }, h("label", null, "Name:"), name.el, h("label", null, "Comment:"), comment.el),
      h("div", { class: "hd" }, "Constraint"), noteEl, constraintPanel());
    if (!custom) {
      out.append(h("div", { class: "hd" }, "Conditions", help), conditionsPanel());
      const choices = layerChoices(draft.type, ctx.enabledLayers(), ctx.layerName);
      if (choices.length) {
        const opts: [string, string][] = [["", "Any"], ...choices];
        if (draft.layer && !opts.some(([k]) => k === draft.layer)) opts.push([draft.layer, draft.layer]);
        const layer = selectField<string>(draft.layer, opts, { ro: ctx.ro, key: "ruleLayer", onChange: (v) => { draft.layer = v; touched(); } });
        layer.input.title = "Layers this rule applies to";
        out.append(h("div", { class: "hd" }, "Layer"), layer.el);
      }
    } else out.querySelector(".hd")?.append(help);
    out.append(h("div", { style: "display:flex;gap:6px;align-items:flex-start;margin-top:10px" }, check, report, h("span", { style: "display:flex;flex-direction:column;align-items:flex-end;gap:2px" }, show, matchReport)), validation);
    // OnEnterKey: Enter in a field saves the rule
    out.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target instanceof HTMLInputElement) { ev.preventDefault(); ev.stopPropagation(); (ev.target as HTMLInputElement).dispatchEvent(new Event("change")); save(); } });
    formHost.replaceChildren(out);
    showOverrideNote();
  };
  const reportError = (msg: string): void => { if (validation) { validation.textContent = msg; validation.classList.add("err"); } ctx.setError(msg.trim(), null); };
  const showNewRule = (): void => {
    editing = null; draft = newRule(type, doc.uniqueRuleName(section.title)); modified = false;
    buildForm(); selectedRow = -1; paintSelection(); if (primary) updateButtons();
  };
  const showRule = (i: number): void => {
    if (i < 0 || i >= doc.entries.length) return;
    editing = doc.entries[i]; draft = copyRule(editing); modified = false;
    buildForm(); updateButtons();
  };
  /** ValidateRule + addRule / applyRule */
  const save = (): boolean => {
    if (ctx.ro) return false;
    const msg = validateRule(draft, doc.isRuleNameUnique(draft.name, draft.type, editingIndex()));
    if (msg) { reportError(msg); return false; }
    const idx = editingIndex();
    if (idx >= 0) {
      // a rule applied with nothing changed stays as it was read
      if (!modified) return true;
      const r = copyRule(draft); doc.update(idx, r); editing = r;
    } else {
      const r = copyRule(draft); delete r.raw; delete r.gen; delete r.lead;
      doc.add(r); editing = r;
    }
    modified = false; notify();
    return true;
  };
  const confirmPendingRule = (done: (ok: boolean) => void): void => {
    if (!modified) { done(true); return; }
    const existing = editingIndex() >= 0;
    messageBox(existing ? "Rule Not Applied" : "Rule Not Added",
      existing ? "Changes to this rule are still in the form. Only the rules in the list apply." : "This rule is still in the form. Only the rules in the list apply.",
      [{ label: "Cancel", fn: () => done(false) }, { label: "Discard", fn: () => { discardPendingRule(); done(true); } }, { label: existing ? "Apply" : "Add Rule", fn: () => done(save()) }], 0);
  };
  const discardPendingRule = (): void => { const i = editingIndex(); if (i >= 0) showRule(i); else showNewRule(); };
  const editRule = (i: number, done?: (ok: boolean) => void): void => {
    if (i < 0 || i >= doc.entries.length) { if (done) done(false); return; }
    const target = doc.entries[i];
    const open = (): void => { const j = indexOf(target); showRule(j); selectedRow = rowOfIndex(j); paintSelection(); updateButtons(); if (done) done(true); };
    if (target !== editing) confirmPendingRule((ok) => { if (ok) open(); else if (done) done(false); });
    else open();
  };
  const moveSelected = (d: number): void => {
    const i = selectedIndex(); if (i < 0) return;
    const r = doc.entries[i];
    if (doc.move(i, d, type)) { notify(); selectedRow = rowOfIndex(indexOf(r)); paintSelection(); updateButtons(); }
  };
  const duplicate = (): void => {
    const i = selectedIndex(); if (i < 0) return;
    const src = doc.entries[i];
    confirmPendingRule((ok) => {
      if (!ok) return;
      const copy = doc.duplicate(indexOf(src)); if (copy < 0) return;
      showRule(copy); notify();
    });
  };
  const remove = (): void => {
    const i = selectedIndex(); if (i < 0 || ctx.ro) return;
    const r = doc.entries[i];
    const q = typeById(r.type).panel === "custom" ? `Delete rule '${r.name}'? It is a text rule and every constraint it sets goes with it.` : `Delete rule '${r.name}'?`;
    messageBox("Confirmation", q, [{ label: "No" }, { label: "Yes", fn: () => { doc.remove(indexOf(r)); showNewRule(); notify(); } }], 0);
  };

  const build = (el: HTMLElement): void => {
    heading = h("div", { class: "crp-head", "data-k": "sectionTitle" }, section.title);
    el.append(heading);
    for (const d of section.defaults) {
      const count = d.value === "count", v0 = ctx.staged.values.get(d.setting) ?? 0;
      const f = count ? numField(v0, { ro: ctx.ro, key: d.setting, digits: 0 }) : lenField(v0, { ro: ctx.ro, key: d.setting });
      const warn = (f as Field<number> & { warn?: Warning }).warn || (() => { const w = h("span", { class: "pd-warnicon", hidden: true }); return { el: w, set(m: string | null) { w.hidden = !m; w.title = m || ""; } }; })();
      defaults.push({ setting: d.setting, f, warn, loaded: v0, count, label: d.label });
    }
    let timer = 0;
    if (defaults.length) {
      const grid = h("div", { class: "crp-defaults", "data-k": "defaults" });
      for (const c of defaults) {
        grid.append(h("label", null, c.label), h("span", { class: "fld" }, c.f.el, c.warn.el), h("span", { class: "unit" }, c.count ? "" : unitName()));
        // debounced so a half-typed value does not flash a warning
        c.f.input.addEventListener("input", () => { if (timer) clearTimeout(timer); timer = window.setTimeout(updateWarnings, 250); });
        c.f.input.addEventListener("change", updateWarnings);
      }
      el.append(grid, h("div", { class: "crp-note" }, "Used where no rule below matches. Kept with the board, not in the rules file."), h("hr", { class: "crp-sep" }));
    }
    if (defaults.length || section.netclass) {
      const row = h("div", { class: "crp-rulesrow" });
      if (defaults.length) row.append(h("b", null, "Rules"));
      row.append(h("span", { class: "sp" }));
      if (section.netclass) { const a = h("a", { href: "#", "data-k": "editNetclasses" }, "Edit net classes"); a.addEventListener("click", (ev) => { ev.preventDefault(); ctx.showPage("Net Classes"); }); row.append(a); }
      el.append(row);
    }
    el.append(h("div", { class: "crp-note", style: "margin-top:8px" }, "The rules below are read from top to bottom and the last one that matches decides the value. A value a net class sets is read before any of them."));
    tbody = h("tbody");
    table = h("table", { class: "crp-list", "data-k": "ruleList", tabIndex: 0 }, h("thead", null, h("tr", null, h("th", null, "#"), h("th", null, "Name"), h("th", null, "Condition"), h("th", null, "Layers"), h("th", null, "Constraint"))), tbody);
    table.addEventListener("keydown", (ev) => { if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); remove(); } });
    empty = h("div", { class: "crp-empty", "data-k": "emptyLabel" }, "No rules yet.");
    const TIP = "Rules are read from top to bottom and the last one that matches decides the value, so a rule lower down wins.";
    const btn = (label: string, icon: string, tip: string, fn: () => void, key: string): HTMLButtonElement => { const b = h("button", { type: "button", class: "btn", title: tip, "data-k": key }, kicadIcon(icon, 16), " " + label) as HTMLButtonElement; b.addEventListener("click", fn); return b; };
    upB = btn("Move Up", "small_up", "Move the selected rule one place earlier. " + TIP, () => moveSelected(-1), "moveUp");
    downB = btn("Move Down", "small_down", "Move the selected rule one place later. " + TIP, () => moveSelected(1), "moveDown");
    dupB = btn("Duplicate", "duplicate", "Copy the selected rule and place the copy after it.", duplicate, "duplicate");
    rmB = btn("Remove", "small_trash", "Delete the selected rule.", remove, "remove");
    tableButtons = h("div", { class: "crp-btns" }, upB, downB, dupB, rmB);
    formHost = h("div", { class: "crp-form" });
    primary = h("button", { type: "button", class: "btn primary", "data-k": "primary" }, "Add Rule") as HTMLButtonElement;
    primary.addEventListener("click", () => { save(); });
    newB = h("button", { type: "button", class: "btn", "data-k": "newRule", title: "Empty the form so another rule can be written. Anything typed and not added is discarded." }, "New Rule") as HTMLButtonElement;
    newB.addEventListener("click", () => confirmPendingRule((ok) => { if (ok) { showNewRule(); refreshRules(); } }));
    formButtons = h("div", { class: "crp-btns", style: "margin-top:6px" }, primary, newB);
    el.append(h("div", { style: "margin:0 8px 8px" }, table, empty, tableButtons, formHost, formButtons));
    built = true;
    showNewRule();
    refreshRules();
    refreshDefaults();
  };

  return {
    build, refreshDefaults: () => { if (built) refreshDefaults(); }, refreshFromDocument: refreshRules, applyDefaults,
    hasPendingRule: () => modified,
    confirmPendingRule,
    showRule: (ty, i) => { if (built && ty === type) editRule(i); },
  };
}

// ---------------------------------------------------------------- the Constraints page's override popup
export interface PopupRow { heading?: string; name?: string; detail?: string; link?: string; open?: () => void }
let openPopup: { el: HTMLElement; anchor: HTMLElement; close(): void } | null = null;
/** OVERRIDING_RULES_POPUP: headings, a link per rule or class with what it sets beside it, and "Edit on the … page" */
export function overridingRulesPopup(anchor: HTMLElement, rows: PopupRow[], fromHover: boolean): void {
  ensureCrpCss();
  if (openPopup) openPopup.close();
  if (!rows.length) return;
  const el = h("div", { class: "crp-pop", "data-k": "overridePopup" });
  const close = (): void => { el.remove(); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", esc, true); if (timer) clearInterval(timer); if (openPopup && openPopup.el === el) openPopup = null; };
  const outside = (ev: Event): void => { if (!el.contains(ev.target as Node) && ev.target !== anchor && !anchor.contains(ev.target as Node)) close(); };
  const esc = (ev: KeyboardEvent): void => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } };
  const link = (text: string, open?: () => void, tip?: string): HTMLElement => { const a = h("a", { href: "#", title: tip || null }, text.length > 60 ? text.slice(0, 60) + "..." : text); a.addEventListener("click", (ev) => { ev.preventDefault(); close(); if (open) open(); }); return a; };
  for (const r of rows) {
    if (r.heading) el.append(h("div", { class: "ph" }, r.heading));
    else if (r.link) { const a = link(r.link, r.open); a.classList.add("pl"); el.append(a); }
    else el.append(h("div", { class: "pr" }, link(r.name || "", r.open, (r.name || "").length > 60 ? r.name : undefined), h("span", { title: r.detail || "" }, r.detail || "")));
  }
  document.body.append(el);
  const b = anchor.getBoundingClientRect();
  el.style.left = Math.max(4, Math.min(b.left, window.innerWidth - el.offsetWidth - 4)) + "px";
  el.style.top = (b.bottom + 2) + "px";
  document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", esc, true);
  // a popup a click opened stays until it is dismissed; one a hover opened follows the pointer
  let timer = 0, lastX = -1, lastY = -1;
  const track = (ev: PointerEvent): void => { lastX = ev.clientX; lastY = ev.clientY; };
  if (fromHover) {
    document.addEventListener("pointermove", track, true);
    timer = window.setInterval(() => {
      if (lastX < 0) return;
      const under = document.elementFromPoint(lastX, lastY);
      if (!under || (!el.contains(under) && under !== anchor && !anchor.contains(under))) { document.removeEventListener("pointermove", track, true); close(); }
    }, 250);
  }
  openPopup = { el, anchor, close };
}
/** The small_new_window icon at a field's edge that opens the popup, on a click or after hovering 400 ms */
export function overrideIcon(rows: () => PopupRow[], tip?: string): HTMLElement {
  ensureCrpCss();
  const icon = h("span", { class: "crp-link", "data-k": "overrideIcon", title: tip || " " }); icon.append(kicadIcon("small_new_window", 14));
  let hover = 0;
  icon.addEventListener("click", (ev) => { ev.preventDefault(); if (hover) clearTimeout(hover); hover = 0; overridingRulesPopup(icon, rows(), false); });
  icon.addEventListener("pointerenter", () => { if (openPopup && openPopup.anchor === icon) return; hover = window.setTimeout(() => { hover = 0; overridingRulesPopup(icon, rows(), true); }, 400); });
  icon.addEventListener("pointerleave", () => { if (hover) clearTimeout(hover); hover = 0; });
  return icon;
}
/** LinkToPage: "Also on the %s page. Click to open it." at a field's edge */
export function linkToPage(page: string, open: () => void): HTMLElement {
  ensureCrpCss();
  const icon = h("span", { class: "crp-link", "data-k": "pageLink", title: `Also on the ${page} page. Click to open it.` }); icon.append(kicadIcon("small_new_window", 14));
  icon.addEventListener("click", (ev) => { ev.preventDefault(); open(); });
  return icon;
}
