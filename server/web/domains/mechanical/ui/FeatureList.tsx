// FeatureList.tsx — the feature list: the search box and the list's buttons, the default geometry (origin and
// planes), then every feature in build order, gathered in folders, with its state, and the rollback bar.
//
//   click selects (Ctrl adds, Shift takes the range) · double-click edits · F2 or a second slow click renames
//   while a dialog's field listens, a click on a sketch or a reference plane's row gives it to the field
//   right-click: the menu (Edit, Rename, Suppress, Dynamic suppression, Roll to here, Hide, Zoom to, Show
//     dependencies, folders, Copy and Paste sketch, Add comment, Delete); on the bar: Roll to end
//   the eye (on hover) hides and shows a plane, a sketch or reference geometry, for this person only
//   the pointer over a row lights up what the feature made, and over the model marks the row that made it;
//     what is selected in the model marks the rows of the features behind it
//   drag a row, or every selected row, to reorder: between rows, or onto a folder to put it inside
//   drag the bar to roll the model back (or select it and press ↑ ↓); the rows under it are not built
//   the box at the top filters by name and type, and by a command (:part :errors :folder …: featurelist/filter.ts)
//
// The pieces around the rows are in featurelist/ (Chrome.tsx: header, banner, dialogs; model.ts: what is worked
// out from the studio; filter.ts: the search).  Folders and suppression are document/folders.ts.
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../../shared/util";
import * as folderEdits from "../document/folders";
import { featureTree, foldersOf, type FolderItem, type TreeNode } from "../document/folders";
import type { FeatureItem } from "../document/format";
import { DEFAULT_GEOMETRY, type DefaultGeometryId } from "../viewport/planes";
import type { Pick } from "../viewport/modelview";
import { CHEVRON, CONDITION, DependenciesDialog, FOLDER, FolderNameDialog, ListHeader, MenuBox, PauseBanner, RegenTimesDialog, SuppressionDialog } from "./featurelist/Chrome";
import { parseFilter } from "./featurelist/filter";
import { HIDEABLE, copiedSketch, copySketch, crossFeatures, filterText, pasteSketch, setListFilter, suppressionFor, useListFilter, useSketchFreedoms } from "./featurelist/model";
import { Glyph } from "./Glyph";
import { useStudio } from "./hooks";
import { FEATURE_ROW_SLOTS } from "./slots";
import { featureDef, type PartStudio } from "./studio";
import { tipHandlers } from "./Tip";
import { exportDrawing } from "../tools/export-all";

interface Menu { x: number; y: number; id: string; kind: "feature" | "folder" | "bar" }
/** One row on screen: a feature, or a folder's header.  `first` … `last` are the features it stands for. */
interface Row { id: string; kind: "feature" | "folder"; depth: number; first: number; last: number; parent: string | null; feature?: FeatureItem; folder?: FolderItem; open?: boolean }
/** Where a dragged row would land: before the row `before` ("end": after the last), or inside the folder `into`. */
interface Drop { before: string | null; into: string | null; index: number; folder: string | null; depth: number }
type Dialog = { kind: "folder"; ids: string[] } | { kind: "suppress"; id: string } | { kind: "deps"; id: string } | { kind: "times" };

export const EYE = '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>';
export const EYE_OFF = '<path d="M4 4l16 16"/><path d="M10 5.7a9 9 0 0 1 2-.2c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.8 3.6M6.4 7.5A16.6 16.6 0 0 0 2.5 12s3.5 6.5 9.5 6.5c1.2 0 2.3-.25 3.3-.65"/>';
const PLANE_ICON = '<path class="f" d="M2.5 16l4.5-8h14.5l-4.5 8z"/><path d="M2.5 16l4.5-8h14.5l-4.5 8z"/>';
const ORIGIN_ICON = '<circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>';
const INDENT = 14;

/** The eye at the right of a row: shown while the pointer is over the row, and always while the thing is hidden. */
export function Eye({ shown, label, onToggle }: { shown: boolean; label: string; onToggle(): void }) {
  return (
    <button type="button" className={cx("btn sm ghost flex-none p-0 w-6 h-6 min-h-0 justify-center", shown ? "text-ink-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" : "text-ink-3")} aria-pressed={shown} aria-label={`${shown ? "Hide" : "Show"} ${label}`} data-eye={shown ? "shown" : "hidden"}
      {...tipHandlers({ title: shown ? "Hide" : "Show", hint: "Only in your view: nobody else's changes." })} onClick={(ev) => { ev.stopPropagation(); onToggle(); }} onDoubleClick={(ev) => ev.stopPropagation()}>
      <Glyph svg={shown ? EYE : EYE_OFF} size={16} />
    </button>
  );
}

const foldKey = (docId: string | number): string => `junction.cad.folders.${docId}`;
function readFolded(docId: string | number): Set<string> {
  try { const v = JSON.parse(localStorage.getItem(foldKey(docId)) || "[]"); return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []); } catch (e) { return new Set(); }
}

export function FeatureList({ studio }: { studio: PartStudio }) {
  const features = useStudio(studio, (s) => s.features);
  const rollback = useStudio(studio, (s) => s.rollback);
  const ownRollback = useStudio(studio, (s) => !!s.ownRollback);
  const reports = useStudio(studio, (s) => s.reports);
  const selected = useStudio(studio, (s) => s.selectedFeatures);
  const sketch = useStudio(studio, (s) => s.sketch?.featureId);
  const editing = useStudio(studio, (s) => s.editing?.draft);
  const listening = useStudio(studio, (s) => !!s.editing?.field);
  const canEdit = useStudio(studio, (s) => s.canEdit);
  const loaded = useStudio(studio, (s) => s.loaded);
  const selection = useStudio(studio, (s) => s.selection);
  const hover = useStudio(studio, (s) => s.hover);
  const datums = useStudio(studio, (s) => s.datums);
  const armedPlane = useStudio(studio, (s) => !!s.ui?.pickingPlane || (!!s.editing?.field && (studio.pickFilter() || []).includes("plane")));
  const renameAsk = useStudio(studio, (s) => (s.ui?.renaming as string | undefined) || null);
  const text = useStudio(studio, () => filterText(studio));
  useStudio(studio, (s) => s.visibility);
  const filter = useListFilter(studio);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);           // where the dragged rows would land
  const [barAt, setBarAt] = useState<number | null>(null);       // where the dragged rollback bar is
  const [geometryOpen, setGeometryOpen] = useState(true);
  const [folded, setFolded] = useState<Set<string>>(() => readFolded(studio.host.doc.docId));
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const dragIds = useRef<string[] | null>(null);
  const anchor = useRef<string | null>(null);                    // where a Shift-click's range starts
  const slow = useRef<{ id: string; t: number; timer: number }>({ id: "", t: 0, timer: 0 });
  const refocusBar = useRef(false);
  const dofOf = useSketchFreedoms(features, sketch);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close); window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("blur", close); };
  }, [menu]);
  // F2 in the viewport asks for the selected row to be renamed
  useEffect(() => { if (renameAsk) { if (canEdit) setRenaming(renameAsk); studio.setUi({ renaming: null }); } }, [renameAsk]);   // eslint-disable-line react-hooks/exhaustive-deps
  // the arrow keys moved the bar, and with it its place in the list: it keeps the keyboard
  useEffect(() => { if (refocusBar.current) { refocusBar.current = false; list.current?.querySelector<HTMLElement>("[data-rollback]")?.focus(); } }, [rollback]);
  const fold = (ids: readonly string[], shut: boolean) => {
    const next = new Set(folded);
    for (const id of ids) { if (shut) next.add(id); else next.delete(id); }
    setFolded(next);
    try { if (next.size) localStorage.setItem(foldKey(studio.host.doc.docId), JSON.stringify(Array.from(next))); else localStorage.removeItem(foldKey(studio.host.doc.docId)); } catch (e) { /* private mode: it lasts as long as the page */ }
  };

  const doc = () => studio.doc!;
  const q = parseFilter(text);
  const filtering = filter.active;
  const folders = useMemo(() => (studio.doc ? foldersOf(studio.doc) : new Map<string, FolderItem>()), [features]);   // eslint-disable-line react-hooks/exhaustive-deps
  const tree = useMemo(() => featureTree(features, folders), [features, folders]);
  const why = useMemo(() => (studio.doc ? suppressionFor(studio.doc, features) : new Map()), [features]);   // eslint-disable-line react-hooks/exhaustive-deps
  const shownBar = barAt ?? rollback;

  // ---------------------------------------------------------------- the rows, top to bottom
  const rows: Row[] = [];
  const walk = (nodes: readonly TreeNode[]) => {
    for (const n of nodes) {
      if (n.kind === "feature") {
        if (!filtering || filter.features.has(n.feature.id)) rows.push({ id: n.feature.id, kind: "feature", depth: n.depth, first: n.index, last: n.index, parent: n.parent, feature: n.feature });
        continue;
      }
      const holds = filtering && features.slice(n.first, n.last + 1).some((f) => filter.features.has(f.id));
      if (filtering && !holds && !filter.folders.has(n.folder.id)) continue;
      // a folder the bar is inside is open, whatever was chosen: the bar is never out of sight
      const open = filtering ? holds : !folded.has(n.folder.id) || (shownBar > n.first && shownBar <= n.last);
      rows.push({ id: n.folder.id, kind: "folder", depth: n.depth, first: n.first, last: n.last, parent: n.parent, folder: n.folder, open });
      if (open) walk(n.children);
    }
  };
  walk(tree.roots);
  const rowIds = rows.map((r) => r.id);

  const rowEls = (): HTMLElement[] => Array.from(list.current?.querySelectorAll<HTMLElement>("[data-row]") || []);
  /** The gap (0 … n) nearest a pointer position, as a feature index: 0 is above the first feature. */
  const gapAt = (clientY: number): number => {
    const els = rowEls();
    for (let i = 0; i < els.length; i++) { const r = els[i].getBoundingClientRect(), row = rows[Number(els[i].dataset.row)]; if (row && clientY < r.top + r.height / 2) return row.first; }
    return features.length;
  };
  /** Where dragged rows would land for a pointer position. */
  const dropAt = (clientY: number): Drop => {
    const els = rowEls();
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect(), row = rows[Number(els[i].dataset.row)];
      if (!row) continue;
      if (row.kind === "feature") { if (clientY < r.top + r.height / 2) return { before: row.id, into: null, index: row.first, folder: row.parent, depth: row.depth }; continue; }
      if (clientY < r.top + r.height * 0.3) return { before: row.id, into: null, index: row.first, folder: row.parent, depth: row.depth };
      if (clientY >= r.bottom) continue;
      // the middle of a folder's header puts it inside, at the end; so does its lower edge, unless its first row is right below
      const next = rows[Number(els[i].dataset.row) + 1];
      if (clientY < r.top + r.height * 0.7 || !next || next.parent !== row.id) return { before: null, into: row.id, index: row.last + 1, folder: row.id, depth: row.depth + 1 };
    }
    return { before: "end", into: null, index: features.length, folder: null, depth: 0 };
  };
  const setBar = (gap: number) => studio.rollTo(gap >= features.length ? null : features[Math.max(0, gap)].id);

  const dragBar = (ev: React.PointerEvent) => {
    if (ev.button !== 0 || filtering) return;
    ev.preventDefault();
    (ev.currentTarget as HTMLElement).focus();
    const move = (e: PointerEvent) => setBarAt(gapAt(e.clientY));
    const up = (e: PointerEvent) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); const g = gapAt(e.clientY), moved = Math.abs(e.clientY - ev.clientY) > 3; setBarAt(null); if (moved && g !== rollback) { refocusBar.current = true; setBar(g); } };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  /** With the bar selected, ↑ and ↓ roll back and forward one feature; Home and End go to the ends. */
  const barKey = (ev: React.KeyboardEvent) => {
    const to = ev.key === "ArrowUp" ? rollback - 1 : ev.key === "ArrowDown" ? rollback + 1 : ev.key === "Home" ? 0 : ev.key === "End" ? features.length : null;
    if (to === null || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    ev.preventDefault(); ev.stopPropagation();
    if (to < 0 || to > features.length || to === rollback) return;
    refocusBar.current = true;
    setBar(to);
  };

  const usesOf = (f: FeatureItem): FeatureItem[] => { const params = JSON.stringify(f.params); return features.filter((g) => g.id !== f.id && params.includes(g.id)); };
  const usedBy = (id: string): FeatureItem[] => features.filter((g) => g.id !== id && JSON.stringify(g.params).includes(id));
  /** What a click on a feature's row gives a dialog field that is listening: a sketch, a reference plane, axis or point. */
  const asPick = (f: FeatureItem): Pick | null => {
    if (f.featureType === "sketch") return { kind: "sketch", featureId: f.id, entity: null, region: null, point: [0, 0, 0] };
    const d = datums.find((x) => x.featureId === f.id);
    return d ? { kind: "datum", featureId: f.id, datum: d.kind, point: [0, 0, 0] } : null;
  };
  const clickRow = (row: Row, ev: React.MouseEvent) => {
    if (row.feature && listening && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) { const p = asPick(row.feature); if (p) { studio.pickFromList(p, ev); return; } }
    if (ev.shiftKey && anchor.current) {
      const a = rowIds.indexOf(anchor.current), b = rowIds.indexOf(row.id);
      if (a >= 0 && b >= 0) { studio.selectFeatures(rowIds.slice(Math.min(a, b), Math.max(a, b) + 1)); return; }
    }
    const add = ev.ctrlKey || ev.metaKey;
    // a second, unhurried click on the one selected row renames it, as in a file list
    const now = performance.now(), alone = selected.length === 1 && selected[0] === row.id;
    clearTimeout(slow.current.timer);
    if (!add && alone && canEdit && slow.current.id === row.id && now - slow.current.t > 500 && now - slow.current.t < 2500 && (ev.target as HTMLElement).closest("[data-row-name]")) {
      slow.current = { id: "", t: 0, timer: window.setTimeout(() => setRenaming(row.id), 250) };
      return;
    }
    slow.current = { id: row.id, t: now, timer: 0 };
    anchor.current = row.id;
    if (!(alone && !add)) studio.selectFeature(row.id, add);
  };
  const dialogAt = (): { x: number; y: number } => { const r = (list.current?.closest(".cad-dock") || list.current)?.getBoundingClientRect(); return { x: (r ? r.right : 240) + 10, y: (r ? r.top : 90) + 6 }; };
  const commit = (changes: ReturnType<typeof folderEdits.moveItems>) => { if (changes.length) studio.commit(changes); };

  // ---------------------------------------------------------------- the default geometry
  const hoverKey = hover ? (hover.kind === "plane" ? hover.plane : null) : null;
  const made = studio.hoveredFeature();
  const cross = crossFeatures(studio);
  const geometryMatch = (g: (typeof DEFAULT_GEOMETRY)[number]): boolean => {
    if (!filtering) return true;
    const t = q.text, named = !t || g.title.toLowerCase().includes(t);
    if (q.command === null || q.command === "name") return named;
    if (q.command === "type") return (g.id === "origin" ? "origin point" : "plane").includes(t);
    if (q.command === "hidden") return !studio.isVisible(g.id) && named;
    if (q.command === "shown") return studio.isVisible(g.id) && named;
    return false;
  };
  const geometry = DEFAULT_GEOMETRY.filter(geometryMatch).map((g) => {
    const shown = studio.isVisible(g.id);
    const pick: Pick | null = g.id === "origin" ? null : { kind: "plane", plane: g.id, point: [0, 0, 0] };
    const on = !!pick && selection.some((p) => p.kind === "plane" && p.plane === g.id);
    return (
      <div key={g.id} role="option" aria-selected={on} data-default-geometry={g.id} data-visible={shown} className={cx("group flex items-center gap-2 h-7 pl-7 pr-1.5 cursor-default select-none", on ? "bg-sel font-medium" : hoverKey === g.id ? "bg-sel-soft" : "hover:bg-sel-soft", !shown && "text-ink-3", armedPlane && pick && "cursor-pointer")}
        onClick={(ev) => { if (pick) studio.pickFromList(pick, ev); }}
        onPointerEnter={() => studio.view.setFeatureHover(pick && shown ? [pick] : null)} onPointerLeave={() => studio.view.setFeatureHover(null)}
        onContextMenu={(ev) => { ev.preventDefault(); studio.toggleVisible(g.id); }}>
        <Glyph svg={g.id === "origin" ? ORIGIN_ICON : PLANE_ICON} size={18} />
        <span className="flex-1 truncate">{g.title}</span>
        <Eye shown={shown} label={g.title} onToggle={() => studio.toggleVisible(g.id as DefaultGeometryId)} />
      </div>
    );
  });

  // ---------------------------------------------------------------- the features, the folders and the bar
  const rowsOut: JSX.Element[] = [];
  const hiddenBelow = features.length - rollback;
  const deps = dialog && dialog.kind === "deps" ? features.find((x) => x.id === dialog.id) : undefined;
  const depUses = deps ? usesOf(deps).map((x) => x.id) : [], depUsedBy = deps ? usedBy(deps.id).map((x) => x.id) : [];
  const bar = (live: boolean) => (
    <div key="bar" className={cx("cad-rollback group/bar relative flex items-center h-2.5 mx-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-blue focus:bg-sel-soft", live && !filtering && "cursor-row-resize")} data-rollback={live || undefined} data-rolled={live && hiddenBelow > 0 ? hiddenBelow : undefined} data-own={ownRollback || undefined}
      role="slider" tabIndex={live ? 0 : -1} aria-label="Rollback bar" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={features.length} aria-valuenow={rollback} aria-valuetext={hiddenBelow > 0 ? `${hiddenBelow} of ${features.length} features are not built` : "At the end: every feature is built"}
      {...(live ? tipHandlers({ title: "Rollback bar", shortcut: "↑ ↓", hint: `${hiddenBelow > 0 ? `${hiddenBelow} feature${hiddenBelow === 1 ? "" : "s"} below it ${hiddenBelow === 1 ? "is" : "are"} not built. Drag it down, or right-click it and choose Roll to end.` : "Drag it up to see the model as it was at an earlier feature; or click it and press ↑ and ↓."}${ownRollback ? " This is your own bar: the document's is not moved." : ""}` }) : {})}
      onPointerDown={live ? dragBar : undefined} onKeyDown={live ? barKey : undefined}
      onContextMenu={(ev) => { ev.preventDefault(); if (live) setMenu({ x: ev.clientX, y: ev.clientY, id: "", kind: "bar" }); }}>
      <span className={cx("flex-1 h-[3px] rounded-full", live ? (hiddenBelow > 0 || barAt !== null ? "bg-accent" : "bg-line-2 group-hover/bar:bg-accent group-focus/bar:bg-accent") : "bg-line-2")} />
      {live ? <span className={cx("flex-none ml-1 w-3 h-2.5 rounded-sm border", hiddenBelow > 0 || barAt !== null ? "border-accent bg-accent" : "border-line-2 bg-panel group-hover/bar:border-accent group-focus/bar:border-accent")} aria-hidden="true" /> : null}
    </div>
  );
  const dropLine = (depth: number) => <div key="drop" className="h-0.5 mr-1 bg-blue" style={{ marginLeft: 4 + depth * INDENT }} data-drop-line />;
  const nameOrInput = (id: string, name: string, cls: string, label: string) => (renaming === id
    ? <input autoFocus className="input flex-1 min-w-0 h-5" defaultValue={name} aria-label={label} onFocus={(ev) => ev.target.select()} onClick={(ev) => ev.stopPropagation()} onDoubleClick={(ev) => ev.stopPropagation()}
        onBlur={(ev) => { commit(folderEdits.renameItem(doc(), id, ev.target.value)); setRenaming(null); }}
        onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); if (ev.key === "Escape") setRenaming(null); ev.stopPropagation(); }} />
    : <span data-row-name className={cx("flex-1 truncate", cls)}>{name}</span>);
  const conditionMark = (id: string, name: string, condition: unknown) => {
    if (typeof condition !== "string" || !condition) return null;
    const s = why.get(id);
    return (
      <button type="button" className={cx("btn sm ghost flex-none p-0 w-5 h-5 min-h-0 justify-center", s?.conditionError ? "text-err" : s?.byCondition ? "text-accent" : "text-ink-2")} data-suppress-if={condition} data-condition={s?.conditionError ? "error" : s?.byCondition ? "true" : "false"} aria-label={`Dynamic suppression of ${name}: ${condition}`}
        {...tipHandlers({ title: "Dynamic suppression", hint: `Suppressed when ${condition}. ${s?.conditionError ? s.conditionError : s?.byCondition ? "True now." : "False now."} Click to edit.` })} onClick={(ev) => { ev.stopPropagation(); setDialog({ kind: "suppress", id }); }} onDoubleClick={(ev) => ev.stopPropagation()}>
        <Glyph svg={CONDITION} size={14} />
      </button>
    );
  };
  const draftRow = () => {
    if (!editing || features.some((f) => f.id === editing.id)) return null;
    return (
      <div key={editing.id} data-feature-type={editing.featureType} data-state="ok" data-draft role="option" aria-selected={false} className="group flex items-center gap-2 h-7 pl-2.5 pr-1.5 cursor-default select-none bg-sel font-medium italic">
        <Glyph svg={featureDef(editing.featureType)?.icon} size={18} />
        <span data-row-name className="flex-1 truncate">{editing.name}</span>
      </div>
    );
  };
  const rowDrag = (row: Row) => ({
    draggable: canEdit && renaming !== row.id && !filtering,
    onDragStart: (ev: React.DragEvent) => {
      // every selected row goes with the one that is dragged, in the order they are in the list
      dragIds.current = selected.includes(row.id) && selected.length > 1 ? rowIds.filter((id) => selected.includes(id)).concat(selected.filter((id) => !rowIds.includes(id))) : [row.id];
      ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", row.id);
    },
    onDragEnd: () => { dragIds.current = null; setDrop(null); },
  });
  let barDone = filtering, shownRows = 0;
  rows.forEach((row, i) => {
    if (!barDone && row.first === shownBar) { const d = draftRow(); if (d) rowsOut.push(d); rowsOut.push(bar(barAt === null)); barDone = true; }
    if (drop && drop.before === row.id) rowsOut.push(dropLine(drop.depth));
    const pad = { paddingLeft: 10 + row.depth * INDENT };
    if (row.kind === "folder") {
      const d = row.folder!, s = why.get(d.id), off = !!s?.suppressed, count = row.last - row.first + 1;
      const below = row.first >= rollback, on = selected.includes(d.id);
      const inside = features.slice(row.first, row.last + 1);
      const crossed = !row.open && inside.some((f) => cross.has(f.id) || made === f.id);
      const failed = !row.open ? inside.filter((f, k) => row.first + k < rollback && reports[f.id]?.status === "error" && !why.get(f.id)?.suppressed).length : 0;
      rowsOut.push(
        <div key={d.id} data-row={i} data-folder-row={d.id} data-depth={row.depth} data-open={row.open || undefined} data-state={off ? "suppressed" : below ? "rolled-back" : "ok"} data-cross={crossed || undefined} data-drop-into={drop?.into === d.id || undefined} role="option" aria-selected={on} aria-expanded={!!row.open}
          className={cx("group flex items-center gap-1.5 h-7 pr-1.5 cursor-default select-none", on ? "bg-sel font-medium" : crossed ? "bg-sel-soft" : "hover:bg-sel-soft", (below || off) && "text-ink-3", drop?.into === d.id && "outline outline-2 -outline-offset-2 outline-blue")} style={{ paddingLeft: 2 + row.depth * INDENT }}
          {...rowDrag(row)}
          onClick={(ev) => clickRow(row, ev)} onDoubleClick={() => { clearTimeout(slow.current.timer); if (!filtering) fold([d.id], !!row.open); }}
          onContextMenu={(ev) => { ev.preventDefault(); if (!selected.includes(d.id)) studio.selectFeature(d.id); setMenu({ x: ev.clientX, y: ev.clientY, id: d.id, kind: "folder" }); }}>
          <button type="button" className="appearance-none bg-transparent border-0 m-0 p-0 flex-none grid place-items-center w-5 h-6 text-ink-2 cursor-pointer" aria-label={row.open ? `Collapse ${d.name}` : `Expand ${d.name}`} data-folder-toggle disabled={filtering}
            onClick={(ev) => { ev.stopPropagation(); fold([d.id], !!row.open); }} onDoubleClick={(ev) => ev.stopPropagation()}>
            <span className={cx("transition-transform", row.open && "rotate-90")}><Glyph svg={CHEVRON} size={14} /></span>
          </button>
          <Glyph svg={FOLDER} size={18} />
          {nameOrInput(d.id, d.name, off ? "line-through" : "", "Folder name")}
          {failed ? <span className="pill err" data-folder-errors={failed}>{failed}</span> : null}
          {off ? <span className="text-xs" title={s?.byFolder ? "The folder around it is suppressed" : s?.byCondition ? "Its condition holds" : undefined}>off</span> : null}
          {conditionMark(d.id, d.name, d.suppressIf)}
          <span className="flex-none mono text-xs text-ink-3" data-folder-count={count}>{count}</span>
        </div>,
      );
      return;
    }
    const f = row.feature!;
    shownRows++;
    const def = featureDef(f.featureType);
    const rep = reports[f.id], s = why.get(f.id);
    const below = row.first >= rollback;
    const off = !!s?.suppressed;
    const state = off ? "suppressed" : below ? "rolled-back" : rep ? rep.status : "ok";
    const on = selected.includes(f.id) || sketch === f.id;
    const hideable = HIDEABLE.has(f.featureType);
    const shown = hideable ? studio.isVisible(f.id) : true;
    const dep = deps ? (deps.id === f.id ? "this" : depUses.includes(f.id) ? "uses" : depUsedBy.includes(f.id) ? "used by" : null) : null;
    const crossed = cross.has(f.id);
    const dof = f.featureType === "sketch" && state === "ok" ? dofOf(f.id) : null;
    rowsOut.push(
      <div key={f.id} data-row={i} data-feature-row={f.id} data-feature-type={f.featureType} data-state={state} data-depth={row.depth} data-folder={row.parent || undefined} data-message={rep && rep.message ? rep.message : undefined} data-made-hover={made === f.id || undefined} data-cross={crossed || undefined} role="option" aria-selected={selected.includes(f.id)}
        className={cx("group flex items-center gap-2 h-7 pr-1.5 cursor-default select-none", on ? "bg-sel font-medium" : made === f.id || crossed ? "bg-sel-soft" : "hover:bg-sel-soft", crossed && "shadow-[inset_2px_0_0_var(--color-accent)]", (below || off) && "text-ink-3", listening && asPick(f) && "cursor-pointer")} style={pad}
        {...rowDrag(row)}
        onClick={(ev) => clickRow(row, ev)}
        onDoubleClick={() => { clearTimeout(slow.current.timer); studio.editFeature(f.id); }}
        onPointerEnter={() => studio.setHoverFeature(f.id)} onPointerLeave={() => studio.setHoverFeature(null)}
        onContextMenu={(ev) => { ev.preventDefault(); if (!selected.includes(f.id)) studio.selectFeature(f.id); setMenu({ x: ev.clientX, y: ev.clientY, id: f.id, kind: "feature" }); }}>
        <Glyph svg={def?.icon} size={18} />
        {nameOrInput(f.id, f.name, cx(off && "line-through", !shown && "text-ink-3"), "Feature name")}
        {dep && dep !== "this" ? <span className="pill info" data-dep={dep}>{dep}</span> : null}
        {dof ? <span className="flex-none w-2 h-2 rounded-full bg-blue" data-underdefined={dof} role="img" aria-label="Not fully defined" {...tipHandlers({ title: "Not fully defined", hint: `${dof} degree${dof === 1 ? "" : "s"} of freedom left: something in this sketch can still move.` })} /> : null}
        {state === "error" || state === "warning" ? (
          <button type="button" className={cx("pill cursor-pointer", state === "error" ? "err" : "warn")} data-problem={state} aria-label={`${state === "error" ? "Error" : "Note"}: ${rep?.message || ""} Show it.`}
            {...tipHandlers({ title: state === "error" ? "This feature failed" : "A note on this feature", hint: `${rep?.message || ""} Click to look at it.` })} onClick={(ev) => { ev.stopPropagation(); studio.selectFeature(f.id); studio.zoomToFeature(f.id); }}>
            {state === "error" ? "error" : "note"}
          </button>
        ) : state === "suppressed" ? <span className="text-xs" data-off={s?.own ? "own" : s?.byCondition ? "condition" : "folder"} title={s?.own ? undefined : s?.byCondition ? "Its condition holds" : "Its folder is suppressed"}>off</span> : null}
        {conditionMark(f.id, f.name, f.suppressIf)}
        {FEATURE_ROW_SLOTS.map((Slot, k) => <Slot key={k} studio={studio} featureId={f.id} />)}
        {hideable ? <Eye shown={shown} label={f.name} onToggle={() => studio.toggleVisible(f.id)} /> : null}
      </div>,
    );
  });
  if (!barDone) { const d = draftRow(); if (d) rowsOut.push(d); rowsOut.push(bar(barAt === null)); }
  else if (filtering) { const d = draftRow(); if (d) rowsOut.push(d); }
  if (drop && drop.before === "end") rowsOut.push(dropLine(0));

  // ---------------------------------------------------------------- the menu
  const mf = menu && menu.kind === "feature" ? features.find((x) => x.id === menu.id) : undefined;
  const md = menu && menu.kind === "folder" ? folders.get(menu.id) : undefined;
  const targets = menu && menu.kind !== "bar" ? (selected.includes(menu.id) && selected.length > 1 ? selected.slice() : [menu.id]) : [];
  const many = targets.length > 1;
  const item = (label: string, run: () => void, o: { danger?: boolean; key?: string } = {}) => (
    <button type="button" key={label} role="menuitem" data-menu-item={label} className={cx("appearance-none bg-transparent border-0 m-0 text-inherit [font-family:inherit] [font-size:inherit] cursor-default flex items-center w-full text-left px-3 h-7 hover:bg-sel-soft", o.danger && "text-err")} onPointerDown={(ev) => ev.stopPropagation()} onClick={() => { setMenu(null); run(); }}>
      <span className="flex-1 truncate">{label}</span>{o.key ? <span className="mono text-xs text-ink-3 ml-4">{o.key}</span> : null}
    </button>
  );
  const sep = (key: string) => <div key={key} className="my-1 border-t border-line" role="separator" />;
  const commentTool = studio.tools().find((t) => t.id === "comment");
  const inFolder = targets.some((id) => (tree.paths.get(id) || []).length > 0 || !!tree.nodes.get(id)?.parent);
  const folderEntries = (): JSX.Element[] => {
    if (!canEdit) return [];
    const out: JSX.Element[] = [item(many ? "Add selection to folder…" : "Add to folder…", () => setDialog({ kind: "folder", ids: targets }))];
    if (inFolder) out.push(item("Move out of folder", () => commit(folderEdits.moveToFolder(doc(), targets, null))));
    const here = new Set(targets.map((id) => (tree.nodes.has(id) ? tree.nodes.get(id)!.parent : (tree.paths.get(id) || []).slice(-1)[0]) || ""));
    for (const d of Array.from(tree.nodes.values()).filter((n) => !targets.includes(n.folder.id) && !(here.size === 1 && here.has(n.folder.id))).slice(0, 8)) {
      out.push(item(`Move to “${d.folder.name}”`, () => commit(folderEdits.moveToFolder(doc(), targets, d.folder.id))));
    }
    return out;
  };
  const suppressEntries = (id: string, suppressed: boolean, condition: unknown): (JSX.Element | null)[] => (!canEdit ? [] : [
    item(suppressed ? "Unsuppress" : "Suppress", () => commit(folderEdits.suppressItems(doc(), targets, !suppressed))),
    !many ? item(typeof condition === "string" && condition ? "Edit dynamic suppression…" : "Add dynamic suppression…", () => setDialog({ kind: "suppress", id })) : null,
    !many && typeof condition === "string" && condition ? item("Remove dynamic suppression", () => commit(folderEdits.setSuppressIf(doc(), id, null))) : null,
  ]);
  const allFolders = Array.from(tree.nodes.keys());
  const errors = features.filter((f, i) => i < rollback && reports[f.id]?.status === "error" && !why.get(f.id)?.suppressed).length;
  const warnings = features.filter((f, i) => i < rollback && reports[f.id]?.status === "warning" && !why.get(f.id)?.suppressed).length;
  const selectedRows = selected.filter((id) => features.some((f) => f.id === id) || folders.has(id));
  return (
    <div ref={list} className="cad-features flex flex-col text-base min-h-full" role="listbox" aria-label="Features" aria-multiselectable="true"
      onDragOver={(ev) => { if (dragIds.current) { ev.preventDefault(); const d = dropAt(ev.clientY); if (!drop || d.before !== drop.before || d.into !== drop.into) setDrop(d); } }}
      onDrop={(ev) => {
        ev.preventDefault();
        const ids = dragIds.current, d = dropAt(ev.clientY); dragIds.current = null; setDrop(null);
        if (ids && ids.length) commit(folderEdits.moveItems(doc(), ids, d.index, d.folder));
      }}>
      <ListHeader studio={studio} shown={shownRows} total={features.length} below={hiddenBelow} errors={errors} warnings={warnings} canEdit={canEdit} selected={selectedRows.length}
        onNewFolder={() => setDialog({ kind: "folder", ids: selectedRows })} onTimes={() => setDialog(dialog?.kind === "times" ? null : { kind: "times" })} />
      <PauseBanner studio={studio} />
      {geometry.length ? (
        <div data-default-group>
          <button type="button" className="appearance-none bg-transparent border-0 m-0 p-0 text-inherit [font-family:inherit] [font-size:inherit] flex w-full items-center gap-1.5 h-7 px-2 text-left text-ink font-medium hover:bg-sel-soft cursor-pointer" aria-expanded={geometryOpen} data-default-toggle onClick={() => setGeometryOpen(!geometryOpen)}>
            <span className={cx("flex-none text-ink-2 transition-transform", geometryOpen && "rotate-90")}><Glyph svg={CHEVRON} size={14} /></span>
            <span className="flex-1 truncate">Default geometry</span>
          </button>
          {geometryOpen || filtering ? geometry : null}
        </div>
      ) : null}
      <div className="flex flex-col pb-1">{rowsOut}</div>
      {loaded && !features.length && !editing ? <p className="note px-3 py-1 m-0 leading-snug" data-empty>No features yet. Choose <b>Sketch</b>, click a plane, and draw a profile; then <b>Extrude</b> it.</p> : null}
      {loaded && features.length > 0 && filtering && !rows.length && !geometry.length ? <p className="note px-2 m-0" data-no-match>Nothing matches “{text.trim()}”. <button type="button" className="btn sm ghost h-5 min-h-0 px-1" onClick={() => setListFilter(studio, "")}>Show everything</button></p> : null}
      {!loaded ? <p className="note px-2 m-0">Loading…</p> : null}
      {dialog && dialog.kind === "folder" ? (
        <FolderNameDialog at={dialogAt()} suggested={folderEdits.nextFolderName(doc())} count={dialog.ids.length} onClose={() => setDialog(null)}
          onAccept={(name) => { const made = folderEdits.addToFolder(doc(), dialog.ids, name); setDialog(null); if (made.folder && studio.commit(made.changes)) studio.selectFeature(made.folder.id); }} />
      ) : null}
      {dialog && dialog.kind === "suppress" ? <SuppressionDialog key={dialog.id} studio={studio} id={dialog.id} at={dialogAt()} onClose={() => setDialog(null)} /> : null}
      {deps ? <DependenciesDialog studio={studio} of={deps} uses={usesOf(deps)} usedBy={usedBy(deps.id)} at={dialogAt()} onClose={() => setDialog(null)} /> : null}
      {dialog && dialog.kind === "times" ? <RegenTimesDialog studio={studio} at={dialogAt()} onClose={() => setDialog(null)} /> : null}
      {menu && menu.kind === "bar" ? (
        <MenuBox x={menu.x} y={menu.y} className="cad-feature-menu" attrs={{ "data-menu-for": "bar" }}>
          {item("Roll to end", () => setBar(features.length), { key: "End" })}
          {rollback > 0 ? item("Roll to start", () => setBar(0), { key: "Home" }) : null}
          {ownRollback ? item("Follow the document's bar", () => studio.followRollback()) : null}
        </MenuBox>
      ) : null}
      {menu && mf ? (
        <MenuBox x={menu.x} y={menu.y} className="cad-feature-menu" attrs={{ "data-menu-for": "feature" }}>
          {many ? <div className="px-3 h-6 text-xs text-ink-3 flex items-center">{targets.length} selected</div> : null}
          {!many ? item(mf.featureType === "sketch" ? "Edit sketch" : "Edit…", () => studio.editFeature(mf.id), { key: "double-click" }) : null}
          {canEdit && !many ? item("Rename", () => setRenaming(mf.id), { key: "F2" }) : null}
          {suppressEntries(mf.id, !!mf.suppressed, mf.suppressIf)}
          {sep("s1")}
          {!many ? item("Roll to here", () => setBar(features.findIndex((x) => x.id === mf.id) + 1)) : null}
          {rollback < features.length ? item("Roll to end", () => setBar(features.length)) : null}
          {HIDEABLE.has(mf.featureType) ? item(studio.isVisible(mf.id) ? "Hide" : "Show", () => studio.setVisible(targets.filter((id) => HIDEABLE.has(features.find((x) => x.id === id)?.featureType || "")), !studio.isVisible(mf.id))) : null}
          {!many ? item("Zoom to", () => studio.zoomToFeature(mf.id)) : null}
          {!many ? item("Show dependencies…", () => setDialog({ kind: "deps", id: mf.id })) : null}
          {canEdit ? sep("s2") : null}
          {folderEntries()}
          {!many && mf.featureType === "sketch" ? item("Copy sketch", () => copySketch(studio, mf.id)) : null}
          {!many && mf.featureType === "sketch" ? item("Export as DXF", () => { void exportDrawing(studio, { kind: "sketch", featureId: mf.id }, "dxf", mf.name); }) : null}
          {!many && mf.featureType === "sketch" ? item("Export as SVG", () => { void exportDrawing(studio, { kind: "sketch", featureId: mf.id }, "svg", mf.name); }) : null}
          {canEdit && copiedSketch() ? item("Paste sketch", () => pasteSketch(studio)) : null}
          {!many && commentTool && !(commentTool.disabled && commentTool.disabled(studio)) ? item("Add comment…", () => { studio.select([]); studio.selectFeature(mf.id); commentTool.run(studio); }) : null}
          {canEdit ? sep("s3") : null}
          {canEdit ? item(many ? `Delete ${targets.length} features` : "Delete", () => commit(folderEdits.deleteItems(doc(), targets)), { danger: true, key: "Del" }) : null}
        </MenuBox>
      ) : null}
      {menu && md ? (
        <MenuBox x={menu.x} y={menu.y} className="cad-feature-menu" attrs={{ "data-menu-for": "folder" }}>
          {many ? <div className="px-3 h-6 text-xs text-ink-3 flex items-center">{targets.length} selected</div> : null}
          {canEdit && !many ? item("Rename", () => setRenaming(md.id), { key: "F2" }) : null}
          {suppressEntries(md.id, md.suppressed === true, md.suppressIf)}
          {sep("s1")}
          {item(folded.has(md.id) ? "Expand" : "Collapse", () => fold(many ? targets : [md.id], !folded.has(md.id)))}
          {item("Expand all", () => fold(allFolders, false))}
          {item("Collapse all", () => fold(allFolders, true))}
          {!many && tree.nodes.get(md.id) ? item("Roll to here", () => setBar(tree.nodes.get(md.id)!.last + 1)) : null}
          {rollback < features.length ? item("Roll to end", () => setBar(features.length)) : null}
          {canEdit ? sep("s2") : null}
          {folderEntries()}
          {canEdit && !many ? item("Unpack folder", () => commit(folderEdits.unpackFolder(doc(), md.id))) : null}
          {canEdit ? sep("s3") : null}
          {canEdit ? item(many ? `Delete ${targets.length} selected` : "Delete folder and what is in it", () => commit(folderEdits.deleteItems(doc(), targets)), { danger: true, key: "Del" }) : null}
        </MenuBox>
      ) : null}
    </div>
  );
}
