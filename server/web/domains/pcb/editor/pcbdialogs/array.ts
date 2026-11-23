// pcbdialogs/array — Create Array (DIALOG_CREATE_ARRAY) for the board editor, run by ARRAY_TOOL::CreateArray.
// The layout follows dialog_create_array_base: a Grid Array page (Grid Array Size, Items Spacing, Stagger Settings,
// Grid Position) and a Circular Array page (Center position with Select Point... / Select Item..., Duplication
// Settings), then Item Source (Duplicate / Arrange selection) and Footprint Annotation (hidden when arranging).  In
// the footprint editor the pad numbering panels show instead of Footprint Annotation (setControlEnablement): the
// grid's Renumber pads, Numbering Direction, Initial Pad Number, Pad Numbering Scheme and the primary / secondary axis
// alphabets, starts and increments, and the circular page's Numbering Options.  The settings outlive the
// dialog for the session (s_arrayOptions) and are kept only on a successful OK.  OK runs TransferDataFromWindow: the
// counts and stagger must be whole numbers ("Bad numeric value for %s: %s"), and an array that would stack copies on
// one another asks "Confirm Array" first.  The copies themselves are PcbTools.arrayChanges (ARRAY_TOOL::onDialogClosed).
import { checkField, form, h, lenField, messageBox, notebook, numField, openDialog, radioBox, selectField, textField, unitLabel, type Field } from "./ui";

/** The dialog's settings (mm, degrees; counts as typed). */
export interface ArrayEntries {
  gridNx: string; gridNy: string; gridDx: number; gridDy: number; gridOffsetX: number; gridOffsetY: number; gridStagger: string; gridStaggerRows: boolean;
  gridCentred: boolean; circCentreX: number; circCentreY: number; circAngle: number; circClockwise: boolean; circOffsetAngle: number; circCount: string;
  circFullCircle: boolean; circRotate: boolean; tab: number; arrange: boolean; reannotate: boolean;
  gridRenumberPads: boolean; gridNumberingAxis: number; gridNumReverseAlt: boolean; gridNumStartSet: number; grid2dArrayNumbering: number;
  gridPrimaryAxisScheme: number; gridSecondaryAxisScheme: number; gridPrimaryNumOffset: string; gridSecondaryNumOffset: string;
  gridPrimaryAxisStep: string; gridSecondaryAxisStep: string;
  circNumStartSet: number; circNumScheme: number; circNumberingOffset: string; circNumberingStep: string;
}

/** CREATE_ARRAY_DIALOG_ENTRIES' defaults. */
export const ARRAY_DEFAULTS: ArrayEntries = {
  gridNx: "5", gridNy: "5", gridDx: 2.54, gridDy: 2.54, gridOffsetX: 0, gridOffsetY: 0, gridStagger: "1", gridStaggerRows: true, gridCentred: true,
  circCentreX: 0, circCentreY: 0, circAngle: 90, circClockwise: true, circOffsetAngle: 0, circCount: "4", circFullCircle: false, circRotate: false,
  tab: 0, arrange: false, reannotate: true,
  gridRenumberPads: true, gridNumberingAxis: 0, gridNumReverseAlt: false, gridNumStartSet: 1, grid2dArrayNumbering: 0,
  gridPrimaryAxisScheme: 0, gridSecondaryAxisScheme: 0, gridPrimaryNumOffset: "1", gridSecondaryNumOffset: "1", gridPrimaryAxisStep: "1", gridSecondaryAxisStep: "1",
  circNumStartSet: 1, circNumScheme: 0, circNumberingOffset: "1", circNumberingStep: "1",
};
let saved: ArrayEntries = { ...ARRAY_DEFAULTS };   // s_arrayOptions: the session's last accepted settings
export const resetArrayEntries = (): void => { saved = { ...ARRAY_DEFAULTS }; };

/** wxString::ToLong: the whole text an integer. */
function toLong(text: string): number | null { return /^\s*[+-]?\d+$/.test(text) ? parseInt(text, 10) : null; }

/** numberingTypeData: the numbering scheme choices, in ARRAY_AXIS::NUMBERING_TYPE order. */
export const NUMBERING_TYPES = ["Numerals (0,1,2,...,9,10)", "Hexadecimal (0,1,...,F,10,...)", "Alphabet, minus IOSQXZ", "Alphabet, full 26 characters"];

interface ArrayAxis { type: number; offset: number; step: number; lower?: boolean }
export interface ArrayOpts {
  type: "grid" | "circular"; nx?: number; ny?: number; dx?: number; dy?: number; offX?: number; offY?: number; stagger?: number; staggerRows?: boolean;
  centred?: boolean; hThenV?: boolean; reverseAlt?: boolean; centre?: [number, number]; angle?: number; angleOffset?: number; clockwise?: boolean;
  count?: number; rotateItems?: boolean; arrange?: boolean; keepRefs?: boolean;
  shouldNumber?: boolean; numberingStartSpecified?: boolean; twoD?: boolean; pri?: ArrayAxis; sec?: ArrayAxis;
}

/**
 * validateAxisOptions: the axis's alphabet and start ("Could not determine numbering start from '%s': expected value
 * consistent with alphabet '%s'.") and its step ("step value").
 */
function validateAxis(offsetText: string, scheme: number, stepText: string, errors: string[]): ArrayAxis | null {
  const P = PT(); const axis: ArrayAxis = { type: scheme, offset: 0, step: 1 };
  if (!P.axisSetOffset(axis, offsetText)) { errors.push(`Could not determine numbering start from '${offsetText}': expected value consistent with alphabet '${P.axisAlphabet(scheme)}'.`); return null; }
  const step = toLong(stepText); if (step === null) { errors.push(`Bad numeric value for step value: ${stepText}`); return null; }
  axis.step = step; return axis;
}

/** TransferDataFromWindow's settings: the ARRAY_OPTIONS, or the errors wxMessageBox shows.  fpEditor numbers the pads. */
export function arrayOptions(v: ArrayEntries, fpEditor = false): { opts: ArrayOpts | null; errors: string[] } {
  const errors: string[] = [];
  const long = (text: string, what: string): number | null => { const n = toLong(text); if (n === null) errors.push(`Bad numeric value for ${what}: ${text}`); return n; };
  const linear = (): ArrayAxis => ({ type: 0, offset: 1, step: 1 });   // the artificial linear numeric scheme from 1
  let opts: ArrayOpts | null = null;
  if (v.tab === 0) {
    const nx = long(v.gridNx, "horizontal count"), ny = long(v.gridNy, "vertical count"), st = long(v.gridStagger, "stagger");
    const g: ArrayOpts = { type: "grid", nx: nx ?? 0, ny: ny ?? 0, dx: v.gridDx, dy: v.gridDy, offX: v.gridOffsetX, offY: v.gridOffsetY, stagger: st ?? 0, staggerRows: v.gridStaggerRows, centred: v.gridCentred,
      hThenV: v.gridNumberingAxis === 0, reverseAlt: v.gridNumReverseAlt, shouldNumber: fpEditor && v.gridRenumberPads };
    let ok = nx !== null && ny !== null && st !== null;
    if (fpEditor) {
      g.numberingStartSpecified = v.gridNumStartSet === 1;
      if (g.shouldNumber && g.numberingStartSpecified) {
        g.twoD = v.grid2dArrayNumbering !== 0;
        const pri = validateAxis(v.gridPrimaryNumOffset, v.gridPrimaryAxisScheme, v.gridPrimaryAxisStep, errors);
        const sec = g.twoD ? validateAxis(v.gridSecondaryNumOffset, v.gridSecondaryAxisScheme, v.gridSecondaryAxisStep, errors) : null;
        if (pri) g.pri = pri; if (sec) g.sec = sec;
        ok = ok && !!pri && (!g.twoD || !!sec);
      } else { g.twoD = false; g.pri = linear(); }
    }
    if (ok) opts = g;
  } else {
    const n = long(v.circCount, "point count");
    const c: ArrayOpts = { type: "circular", centre: [v.circCentreX, v.circCentreY], angle: v.circAngle, angleOffset: v.circOffsetAngle, clockwise: v.circClockwise, count: n ?? 0, rotateItems: v.circRotate, shouldNumber: fpEditor };
    let ok = n !== null;
    if (fpEditor) {
      c.numberingStartSpecified = v.circNumStartSet === 1;
      if (c.numberingStartSpecified) { const a = validateAxis(v.circNumberingOffset, v.circNumScheme, v.circNumberingStep, errors); if (a) c.pri = a; ok = ok && !!a; }
      else c.pri = linear();
    }
    if (ok) opts = c;
  }
  if (opts) { opts.arrange = v.arrange; opts.keepRefs = !v.reannotate; }
  return { opts, errors };
}

/** The confirmation for an array that stacks copies (arrayHasStackedPositions). */
export const stackedMessage = (n: number): string =>
  `The array configuration would place ${n} items at the same position and rotation, stacking them on top of one another.\n\nProceed anyway?`;

interface ArrayApi {
  arrayChanges(doc: KDoc, ids: string[], o: ArrayOpts): { changes: KChange[]; ids: string[]; label: string };
  arraySize(o: ArrayOpts): number; arrayStacked(o: ArrayOpts, pos: [number, number]): boolean; arrayOrigin(doc: KDoc, ids: string[]): [number, number];
  applySelection(ctx: ToolCtx, ids: string[]): void; anchorOf(item: KItem): [number, number];
  pickInteractively(ctx: ToolCtx, mode: "point" | "item", prompt: string, done: (r: [number, number] | KItem | null) => void): void;
  requestSelection(ctx: ToolCtx, opts: { locks?: boolean; rerun(c: ToolCtx): void }): { ids: string[] } | null;
  axisSetOffset(axis: ArrayAxis, text: string): boolean; axisAlphabet(type: number): string; axisItemNumber(axis: ArrayAxis, n: number): string; axisTypeIsNumeric(type: number): boolean;
}
const PT = (): ArrayApi => (window as unknown as { PcbTools: ArrayApi }).PcbTools;

/**
 * OnAxisNumberingChange: on an alphabet change a start text the new alphabet cannot read becomes its first value
 * ("1" for the numeric schemes, "A" for the alphabetic ones).
 */
export function startForScheme(scheme: number, text: string): string {
  const P = PT(); const axis: ArrayAxis = { type: scheme, offset: 0, step: 1 };
  if (P.axisSetOffset(axis, text)) return text;
  axis.offset = P.axisTypeIsNumeric(scheme) ? 1 : 0; axis.lower = false;
  return P.axisItemNumber(axis, 0);
}

/** The ids Create Array works on: PCB_SELECTION_TOOL::RequestSelection (the selection, else the item under the cursor). */
function selectedIds(ctx: ToolCtx): string[] | null {
  // ARRAY_TOOL::CreateArray's filter drops markers and children only: locked items are arrayed like any other
  const sel = PT().requestSelection(ctx, { locks: false, rerun: (c: ToolCtx) => { createArrayDialog(c); } });
  return sel && sel.ids.length ? sel.ids : null;
}

/** ARRAY_TOOL::CreateArray: the dialog over the selection, then the array. */
export function createArrayDialog(ctx: ToolCtx): boolean {
  const doc = ctx.doc as KDoc; if (!doc || ctx.viewOnly) return false;
  const ids = selectedIds(ctx); if (!ids) return true;   // nothing to array: RequestSelection came back empty
  const origin = PT().arrayOrigin(doc, ids);
  const fpEditor = !!(doc as KDoc & { fpEditor?: boolean }).fpEditor;   // ARRAY_TOOL: enableArrayNumbering = m_isFootprintEditor
  const v0 = { ...saved };
  const f: Record<string, Field<string | number | boolean>> = {};
  const reg = <T extends string | number | boolean>(k: string, x: Field<T>): Field<T> => { f[k] = x as unknown as Field<string | number | boolean>; return x; };
  const radios: Record<string, HTMLInputElement> = {};
  const radio = (name: string, key: string, label: string, on: boolean, tip?: string): HTMLElement => {
    const input = h("input", { type: "radio", name: "kd-arr-" + name, checked: on, "data-k": key }); radios[key] = input;
    return h("label", { class: "pd-check", title: tip }, input, label);
  };
  let book: { show(i: number): void; current(): number } | null = null;
  let annotBox: HTMLElement | null = null, gridNumPanel: HTMLElement | null = null, circNumPanel: HTMLElement | null = null;
  const rb: Record<string, Field<number> & { enable(on: boolean): void }> = {};
  const current = (): ArrayEntries => ({
    gridNx: String(f.gridNx.get()), gridNy: String(f.gridNy.get()), gridDx: Number(f.gridDx.get()), gridDy: Number(f.gridDy.get()), gridOffsetX: Number(f.gridOffsetX.get()), gridOffsetY: Number(f.gridOffsetY.get()),
    gridStagger: String(f.gridStagger.get()), gridStaggerRows: radios.staggerRows.checked, gridCentred: radios.centred.checked,
    circCentreX: Number(f.circCentreX.get()), circCentreY: Number(f.circCentreY.get()), circAngle: Number(f.circAngle.get()), circClockwise: radios.clockwise.checked,
    circOffsetAngle: Number(f.circOffsetAngle.get()), circCount: String(f.circCount.get()), circFullCircle: !!f.circFullCircle.get(), circRotate: !!f.circRotate.get(),
    tab: book ? book.current() : v0.tab, arrange: radios.arrange.checked, reannotate: radios.unique.checked,
    gridRenumberPads: !!f.gridRenumberPads.get(), gridNumberingAxis: rb.gridNumberingAxis.get(), gridNumReverseAlt: !!f.gridNumReverseAlt.get(),
    gridNumStartSet: rb.gridNumStartSet.get(), grid2dArrayNumbering: rb.grid2dArrayNumbering.get(),
    gridPrimaryAxisScheme: Number(f.gridPrimaryAxisScheme.get()), gridSecondaryAxisScheme: Number(f.gridSecondaryAxisScheme.get()),
    gridPrimaryNumOffset: String(f.gridPrimaryNumOffset.get()), gridSecondaryNumOffset: String(f.gridSecondaryNumOffset.get()),
    gridPrimaryAxisStep: String(f.gridPrimaryAxisStep.get()), gridSecondaryAxisStep: String(f.gridSecondaryAxisStep.get()),
    circNumStartSet: rb.circNumStartSet.get(), circNumScheme: Number(f.circNumScheme.get()), circNumberingOffset: String(f.circNumberingOffset.get()), circNumberingStep: String(f.circNumberingStep.get()),
  });
  // setControlEnablement + calculateCircularArrayProperties
  const update = (): void => {
    const full = !!f.circFullCircle.get();
    f.circAngle.input.disabled = full;
    if (full) { const n = toLong(String(f.circCount.get())); if (n) f.circAngle.set(360 / n); }
    if (fpEditor) {
      // In no pad re-numbering, everything is disabled
      const renumber = !!f.gridRenumberPads.get();
      rb.gridNumberingAxis.enable(renumber); f.gridNumReverseAlt.input.disabled = !renumber; rb.gridNumStartSet.enable(renumber);
      // a set start number unlocks the other options, otherwise it is a hardcoded linear array
      const setStart = renumber && rb.gridNumStartSet.get() === 1, num2d = rb.grid2dArrayNumbering.get() !== 0;
      rb.grid2dArrayNumbering.enable(setStart);
      f.gridPrimaryAxisScheme.input.disabled = !setStart; f.gridSecondaryAxisScheme.input.disabled = !(setStart && num2d);
      f.gridPrimaryNumOffset.input.disabled = !setStart; f.gridPrimaryAxisStep.input.disabled = !setStart;
      f.gridSecondaryNumOffset.input.disabled = !(setStart && num2d); f.gridSecondaryAxisStep.input.disabled = !(setStart && num2d);
      for (const [k, on] of [["priLabel", setStart], ["secLabel", setStart && num2d], ["startLabel", setStart], ["stepLabel", setStart]] as [string, boolean][]) {
        const el = gridNumPanel && gridNumPanel.querySelector(`[data-l="${k}"]`); if (el) el.classList.toggle("disabled", !on);
      }
      // the circular number offset in the same way
      f.circNumberingOffset.input.disabled = !(renumber && rb.circNumStartSet.get() === 1);
    }
    if (gridNumPanel) gridNumPanel.style.display = fpEditor ? "" : "none";
    if (circNumPanel) circNumPanel.style.display = fpEditor ? "" : "none";
    if (annotBox) annotBox.style.display = fpEditor || radios.arrange.checked ? "none" : "";
  };
  // OnAxisNumberingChange: keep a start the new alphabet can read, else its first value
  const onScheme = (offsetKey: string) => (scheme: string | number): void => { f[offsetKey].set(startForScheme(Number(scheme), String(f[offsetKey].get()))); };
  let api: { close(): void; dialog: HTMLElement } | null = null;
  const pick = (mode: "point" | "item"): void => {   // OnSelectCenterButton: the dialog steps aside while the canvas is clicked
    if (!api) return; const ov = api.dialog.parentElement as HTMLElement; ov.style.display = "none";
    PT().pickInteractively(ctx, mode, mode === "item" ? "Select center item..." : "Select center point...", (r) => {
      ov.style.display = "";
      if (r) { const p = Array.isArray(r) ? r : PT().anchorOf(r); f.circCentreX.set(p[0]); f.circCentreY.set(p[1]); }   // UpdatePickedItem: the item's position
    });
  };
  api = openDialog({ title: "Create Array", width: fpEditor ? 900 : 640,
    build(body) {
      reg("gridNx", textField(v0.gridNx, { key: "gridNx" })); reg("gridNy", textField(v0.gridNy, { key: "gridNy" }));
      reg("gridDx", lenField(v0.gridDx, { key: "gridDx" })); reg("gridDy", lenField(v0.gridDy, { key: "gridDy" }));
      reg("gridOffsetX", lenField(v0.gridOffsetX, { key: "gridOffsetX" })); reg("gridOffsetY", lenField(v0.gridOffsetY, { key: "gridOffsetY" }));
      reg("gridStagger", textField(v0.gridStagger, { key: "gridStagger" }));
      reg("circCentreX", lenField(v0.circCentreX, { key: "circCentreX" })); reg("circCentreY", lenField(v0.circCentreY, { key: "circCentreY" }));
      reg("circAngle", numField(v0.circAngle, { key: "circAngle", digits: 4 })); reg("circOffsetAngle", numField(v0.circOffsetAngle, { key: "circOffsetAngle", digits: 4 }));
      reg("circCount", textField(v0.circCount, { key: "circCount" }));
      reg("circFullCircle", checkField(v0.circFullCircle, "Full circle", { key: "circFullCircle", onChange: update }));
      reg("circRotate", checkField(v0.circRotate, "Rotate items", { key: "circRotate", tip: "Rotate the item as well as move it - multi-selections will be rotated together" }));
      f.circCount.input.addEventListener("input", update);
      // the pad numbering panels (the footprint editor's)
      const schemes = NUMBERING_TYPES.map((label, i) => [i, label] as [number, string]);
      reg("gridRenumberPads", checkField(v0.gridRenumberPads, "Renumber pads", { key: "gridRenumberPads", onChange: update }));
      rb.gridNumberingAxis = radioBox("Numbering Direction", ["Horizontal, then vertical", "Vertical, then horizontal"], v0.gridNumberingAxis, { key: "gridNumberingAxis" });
      reg("gridNumReverseAlt", checkField(v0.gridNumReverseAlt, "Reverse numbering on alternate rows/columns", { key: "gridNumReverseAlt" }));
      rb.gridNumStartSet = radioBox("Initial Pad Number", ["Use first free number", "From start value"], v0.gridNumStartSet, { key: "gridNumStartSet", onChange: update });
      rb.grid2dArrayNumbering = radioBox("Pad Numbering Scheme", ["Continuous (1, 2, 3...)", "Coordinate (A1, A2, ... B1, ...)"], v0.grid2dArrayNumbering, { key: "grid2dArrayNumbering", onChange: update });
      reg("gridPrimaryAxisScheme", selectField(v0.gridPrimaryAxisScheme, schemes, { key: "gridPrimaryAxisScheme", onChange: onScheme("gridPrimaryNumOffset") }));
      reg("gridSecondaryAxisScheme", selectField(v0.gridSecondaryAxisScheme, schemes, { key: "gridSecondaryAxisScheme", onChange: onScheme("gridSecondaryNumOffset") }));
      reg("gridPrimaryNumOffset", textField(v0.gridPrimaryNumOffset, { key: "gridPrimaryNumOffset" })); reg("gridSecondaryNumOffset", textField(v0.gridSecondaryNumOffset, { key: "gridSecondaryNumOffset" }));
      reg("gridPrimaryAxisStep", textField(v0.gridPrimaryAxisStep, { key: "gridPrimaryAxisStep" })); reg("gridSecondaryAxisStep", textField(v0.gridSecondaryAxisStep, { key: "gridSecondaryAxisStep" }));
      rb.circNumStartSet = radioBox("Initial Pad Number:", ["Use first free number", "From start value"], v0.circNumStartSet, { key: "circNumStartSet", onChange: update });
      reg("circNumScheme", selectField(v0.circNumScheme, schemes, { key: "circNumScheme", onChange: onScheme("circNumberingOffset") }));
      reg("circNumberingOffset", textField(v0.circNumberingOffset, { key: "circNumberingOffset" })); reg("circNumberingStep", textField(v0.circNumberingStep, { key: "circNumberingStep" }));
      const lbl = (k: string, text: string): HTMLElement => h("label", { "data-l": k }, text);
      const gridNum = gridNumPanel = h("div", { "data-k": "gridPadNumbering", style: "flex:1;display:flex;flex-direction:column;gap:4px" },
        f.gridRenumberPads.el, rb.gridNumberingAxis.el, f.gridNumReverseAlt.el, rb.gridNumStartSet.el, rb.grid2dArrayNumbering.el,
        lbl("priLabel", "Primary axis numbering:"), f.gridPrimaryAxisScheme.el, lbl("secLabel", "Secondary axis numbering:"), f.gridSecondaryAxisScheme.el,
        h("div", { style: "display:grid;grid-template-columns:1fr 72px 72px;gap:4px;align-items:center" },
          lbl("startLabel", "Pad numbering start:"), f.gridPrimaryNumOffset.el, f.gridSecondaryNumOffset.el,
          lbl("stepLabel", "Pad numbering increment:"), f.gridPrimaryAxisStep.el, f.gridSecondaryAxisStep.el));
      const circNum = circNumPanel = h("div", { class: "pd-box", "data-k": "circularPadNumbering" }, h("div", { class: "hd" }, "Numbering Options"),
        rb.circNumStartSet.el, h("label", null, "Pad Numbering:"), f.circNumScheme.el,
        form([["Pad numbering start:", f.circNumberingOffset.el], ["Pad numbering increment:", f.circNumberingStep.el]], true));
      f.circAngle.input.title = "Positive angles represent an anti-clockwise rotation. An angle of 0 will produce a full circle divided evenly into \"Count\" portions.";
      f.circCount.input.title = "How many items in the array."; f.circOffsetAngle.input.title = "Angle offset of the first item in the array";
      f.gridStagger.input.title = "Value -1,  0 or 1 disable this option.";
      const ptBtn = h("button", { type: "button", class: "btn", "data-k": "selectPoint" }, "Select Point..."); ptBtn.addEventListener("click", () => pick("point"));
      const itBtn = h("button", { type: "button", class: "btn", "data-k": "selectItem" }, "Select Item..."); itBtn.addEventListener("click", () => pick("item"));
      const rStRows = radio("stagger", "staggerRows", "Rows", v0.gridStaggerRows), rStCols = radio("stagger", "staggerCols", "Columns", !v0.gridStaggerRows);
      const rInPlace = radio("gridpos", "inPlace", "Source items remain in place", !v0.gridCentred), rCentred = radio("gridpos", "centred", "Centre on source items", v0.gridCentred);
      const rCw = radio("dir", "clockwise", "Clockwise", v0.circClockwise), rCcw = radio("dir", "anticlockwise", "Anti-clockwise", !v0.circClockwise);
      const B = (title: string, ...kids: (HTMLElement | null)[]): HTMLElement => h("div", { class: "pd-box" }, h("div", { class: "hd" }, title), ...kids.filter((k): k is HTMLElement => !!k));
      const nb = notebook([
        { label: "Grid Array", build(el) {
          el.append(h("div", { style: "display:flex;gap:16px;align-items:flex-start" }, h("div", { class: "pd-cols2", style: "flex:2" },
            h("div", null,
              B("Grid Array Size", form([["Horizontal count:", f.gridNx.el, null, "Number of columns"], ["Vertical count:", f.gridNy.el, null, "Number of rows"]], true)),
              B("Stagger Settings", form([["Stagger:", f.gridStagger.el, null, "Value -1,  0 or 1 disable this option."]], true),
                h("div", { class: "pd-inline", style: "gap:12px;margin-top:4px" }, rStRows, rStCols))),
            h("div", null,
              B("Items Spacing", form([["Horizontal spacing:", f.gridDx.el, unitLabel(), "Distance between columns"], ["Vertical spacing:", f.gridDy.el, unitLabel(), "Distance between rows"],
                ["Horizontal offset:", f.gridOffsetX.el, unitLabel(), "Offset added to the next row position."], ["Vertical offset:", f.gridOffsetY.el, unitLabel(), "Offset added to the next column position"]], true)),
              B("Grid Position", h("div", { style: "display:flex;flex-direction:column;gap:4px" },
                rInPlace, rCentred)))), gridNum));
        } },
        { label: "Circular Array", build(el) {
          el.append(h("div", { class: "pd-cols2" },
            B("Center position", form([["Center pos X:", f.circCentreX.el, unitLabel()], ["Center pos Y:", f.circCentreY.el, unitLabel()]], true),
              h("div", { class: "pd-inline", style: "gap:8px;margin-top:6px" }, ptBtn, itBtn)),
            B("Duplication Settings", f.circFullCircle.el,
              h("div", { class: "pd-inline", style: "gap:12px;margin:4px 0" }, h("span", null, "Direction"), rCw, rCcw),
              form([["Angle between items:", f.circAngle.el, unitLabel("deg")], ["Item count:", f.circCount.el, null, "How many items in the array."],
                ["First item angle:", f.circOffsetAngle.el, unitLabel("deg"), "Angle offset of the first item in the array"]], true),
              f.circRotate.el)), circNum);
        } },
      ], { start: v0.tab });
      book = nb;
      const tip = "This can conflict with reference designators in the schematic that have not yet been synchronized with the board.";
      const src = B("Item Source", h("div", { style: "display:flex;flex-direction:column;gap:4px" },
        radio("src", "duplicate", "Duplicate selection", !v0.arrange), radio("src", "arrange", "Arrange selection", v0.arrange, tip)));
      annotBox = B("Footprint Annotation", h("div", { style: "display:flex;flex-direction:column;gap:4px" },
        radio("annot", "keep", "Keep existing reference designators", !v0.reannotate), radio("annot", "unique", "Assign unique reference designators", v0.reannotate, tip)));
      radios.duplicate.addEventListener("change", update); radios.arrange.addEventListener("change", update);
      body.append(nb.el, h("div", { class: "pd-cols2", style: "margin-top:8px" }, src, annotBox));
      update();
    },
    ok() {
      const v = current();
      const { opts, errors } = arrayOptions(v, fpEditor);
      if (!opts) { messageBox("Message", errors.length ? errors.join("\n") : "Bad parameters"); return false; }
      const run = (): void => {
        saved = v;   // m_cfg_persister.ReadConfigFromControls
        const r = PT().arrayChanges(doc, ids, opts);
        if (r.changes.length) ctx.commit(r.changes, r.label);
        if (!opts.arrange) PT().applySelection(ctx, r.ids);
      };
      const n = PT().arraySize(opts);
      if (n > 1 && PT().arrayStacked(opts, origin)) {
        messageBox("Confirm Array", stackedMessage(n), [{ label: "No" }, { label: "Yes", fn: () => { run(); if (api) api.close(); } }]);
        return false;
      }
      run(); return true;
    } });
  return !!api;
}
