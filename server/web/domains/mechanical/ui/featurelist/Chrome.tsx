// Chrome.tsx — what the feature list has around its rows: the search box with its filter menu, the buttons under
// it (errors, new folder, pause regeneration, regeneration times), the paused banner, and the small dialogs the
// rows' menu opens (a folder's name, dynamic suppression, dependencies, regeneration times).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../../../../shared/util";
import { conditionProblem, evaluateCondition } from "../../document/conditions";
import { isFolder, setSuppressIf, suppressItems } from "../../document/folders";
import { isFeature, type FeatureItem } from "../../document/format";
import { lookupOf, variableValues, variablesOf } from "../../document/variables";
import { Glyph } from "../Glyph";
import { useStudio } from "../hooks";
import { featureDef, type PartStudio } from "../studio";
import { hideTip, tipHandlers } from "../Tip";
import { CHECK, CROSS, SEARCH } from "../Toolbar";
import { FILTER_COMMANDS, completions, parseFilter, withCommand } from "./filter";
import { filterText, regenTimes, setListFilter } from "./model";

export const FILTER = '<path d="M4 5.5h16l-6 7.5v5.5l-4 1.5v-7z"/>';
export const FOLDER = '<path class="f" d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.6l2 2.5h8.4A1.5 1.5 0 0 1 21 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.6l2 2.5h8.4A1.5 1.5 0 0 1 21 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>';
const FOLDER_ADD = '<path d="M12.5 19h-8A1.5 1.5 0 0 1 3 17.5v-10A1.5 1.5 0 0 1 4.5 6h4.6l2 2.5h8.4A1.5 1.5 0 0 1 21 10v2.5"/><path d="M18 14.5v6M15 17.5h6"/>';
const PAUSE = '<path d="M8.5 5.5v13M15.5 5.5v13"/>';
const CLOCK = '<circle cx="12" cy="13.5" r="7"/><path d="M12 9.5v4l2.5 2M9.5 3.5h5M12 3.5v3"/>';
const ERROR = '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16v.5"/>';
export const CONDITION = '<path d="M11 5c-2.6 0-3.2 1.4-3.2 3.6V19M5.3 11h5.2M13.5 11.5l5.5 7M19 11.5l-5.5 7"/>';
export const CHEVRON = '<path d="M9 6l6 6-6 6"/>';
const UP = '<path d="M12 19V5M6 11l6-6 6 6"/>';
const DOWN = '<path d="M12 5v14M6 13l6 6 6-6"/>';

const ICON_BTN = "btn sm ghost flex-none p-0 w-7 h-7 min-h-0 justify-center text-ink-2";

/** A menu at a point of the screen, kept inside the window whatever its height. */
export function MenuBox({ x, y, className, attrs, children }: { x: number; y: number; className?: string; attrs?: { [k: string]: string }; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    setAt({ left: Math.max(4, Math.min(x, window.innerWidth - el.offsetWidth - 6)), top: Math.max(4, Math.min(y, window.innerHeight - el.offsetHeight - 6)) });
  }, [x, y]);
  return (
    <div ref={box} className={cx("fixed z-[50] min-w-52 max-h-[90vh] overflow-y-auto py-1 rounded-md border border-line bg-panel shadow-panel text-base", className)} style={at} role="menu" {...attrs}
      onPointerDown={(ev) => ev.stopPropagation()} onContextMenu={(ev) => ev.preventDefault()}>
      {children}
    </div>
  );
}

/** A small dialog beside the list: a title, ✓ (when it can be accepted) and ✗.  Esc closes it, Enter accepts. */
export function Popup({ title, icon, at, width = 300, onClose, onAccept, why, attrs, children }: { title: string; icon?: string; at: { x: number; y: number }; width?: number; onClose(): void; onAccept?(): void; why?: string | null; attrs?: { [k: string]: string | undefined }; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    setPos({ left: Math.max(4, Math.min(at.x, window.innerWidth - el.offsetWidth - 6)), top: Math.max(4, Math.min(at.y, window.innerHeight - el.offsetHeight - 6)) });
  }, [at.x, at.y]);
  return (
    <div ref={box} role="dialog" aria-label={title} className="cad-list-dialog fixed z-[55] flex flex-col max-h-[80vh] rounded-md border border-line bg-bench shadow-panel text-base text-ink" style={{ ...pos, width }} {...attrs}
      onPointerDown={(ev) => ev.stopPropagation()}
      onKeyDown={(ev) => {
        if (ev.key === "Escape") { onClose(); ev.preventDefault(); }
        else if (ev.key === "Enter" && onAccept && !why && (ev.target as HTMLElement).tagName === "INPUT") { onAccept(); ev.preventDefault(); }
        ev.stopPropagation();
      }}>
      <header className="flex flex-none items-center gap-1.5 h-8 pl-2 pr-1 border-b border-line font-semibold select-none">
        {icon ? <Glyph svg={icon} size={16} /> : null}
        <span className="flex-1 truncate">{title}</span>
        {onAccept ? <button type="button" className="btn sm primary p-0 w-7 h-6 min-h-0 justify-center" disabled={!!why} data-accept aria-label="Accept" {...tipHandlers({ title: "Accept", shortcut: "Enter", why })} onClick={onAccept}><Glyph svg={CHECK} size={16} /></button> : null}
        <button type="button" className="btn sm ghost p-0 w-7 h-6 min-h-0 justify-center" data-close aria-label="Close" {...tipHandlers({ title: "Close", shortcut: "Esc" })} onClick={onClose}><Glyph svg={CROSS} size={16} /></button>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto p-2">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- the top of the list

export interface HeaderProps {
  studio: PartStudio;
  shown: number; total: number; below: number; errors: number; warnings: number;
  canEdit: boolean;
  /** what "New folder" would hold (0: nothing is selected) */
  selected: number;
  onNewFolder(): void;
  onTimes(): void;
}

/** The search box with its filter menu, the count, and the list's own buttons. */
export function ListHeader(p: HeaderProps) {
  const { studio } = p;
  const text = useStudio(studio, () => filterText(studio));
  const paused = useStudio(studio, (s) => !!s.pause);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const q = parseFilter(text);
  const offered = q.partial !== null ? completions(q.partial) : open ? FILTER_COMMANDS : [];
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", close); window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("blur", close); };
  }, [open]);
  const choose = (id: (typeof FILTER_COMMANDS)[number]["id"] | null) => { setListFilter(studio, withCommand(text, id)); setOpen(false); input.current?.focus(); };
  return (
    <div className="flex flex-none flex-col gap-1 px-2 py-1.5 border-b border-line bg-paper sticky top-0 z-[2]" data-list-header>
      <div className="relative flex items-center gap-1.5">
        <label className="flex flex-1 min-w-0 items-center gap-1 h-7 pl-0.5 pr-1 rounded-sm border border-line-2 bg-panel text-ink-3 focus-within:border-blue focus-within:outline focus-within:outline-1 focus-within:outline-blue" data-feature-filter-box>
          <button type="button" className={cx("btn sm ghost flex-none p-0 w-6 h-6 min-h-0 justify-center", q.command ? "text-accent" : "text-ink-2")} aria-haspopup="menu" aria-expanded={open} aria-label="Filter by…" data-filter-menu
            {...tipHandlers({ title: "Filter", hint: "Search by name, type, part, folder, variable; show only errors, suppressed or hidden things." })}
            onPointerDown={(ev) => { hideTip(); ev.stopPropagation(); }} onClick={(ev) => { ev.preventDefault(); hideTip(); setOpen(!open); }} onPointerEnter={open ? undefined : tipHandlers({ title: "Filter", hint: "Search by name, type, part, folder, variable; show only errors, suppressed or hidden things." }).onPointerEnter}>
            <Glyph svg={FILTER} size={14} />
          </button>
          <input ref={input} className="appearance-none flex-1 min-w-0 h-full p-0 bg-transparent border-0 outline-none text-base text-ink [font-family:inherit] placeholder:text-ink-3" type="search" placeholder="Filter features…" aria-label="Filter the features and parts by name or type; a colon starts a command" value={text} data-feature-filter
            onChange={(ev) => setListFilter(studio, ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Escape") { if (open) setOpen(false); else setListFilter(studio, ""); ev.stopPropagation(); }
              // Tab or Enter on a half-typed command finishes it
              else if ((ev.key === "Tab" || ev.key === "Enter") && q.partial !== null && offered.length) { choose(offered[0].id); ev.preventDefault(); ev.stopPropagation(); }
            }} />
          {text ? <span className="flex-none text-xs mono text-ink-2" data-filter-count>{p.shown}/{p.total}</span> : <Glyph svg={SEARCH} size={14} />}
        </label>
        {offered.length ? (
          <div className="absolute left-0 right-0 top-full mt-0.5 z-[3] py-1 rounded-md border border-line bg-panel shadow-panel text-base" role="menu" data-filter-options onPointerDown={(ev) => ev.stopPropagation()}>
            {q.partial === null ? <button type="button" role="menuitem" className="appearance-none bg-transparent border-0 m-0 text-inherit [font-family:inherit] [font-size:inherit] cursor-default flex w-full items-center gap-2 text-left px-2.5 h-7 hover:bg-sel-soft" data-filter-option="all" onClick={() => choose(null)}><span className="flex-none w-24">Everything</span><span className="text-xs text-ink-3 truncate">by name or type</span></button> : null}
            {offered.map((c) => (
              <button type="button" role="menuitem" key={c.id} className={cx("appearance-none bg-transparent border-0 m-0 text-inherit [font-family:inherit] [font-size:inherit] cursor-default flex w-full items-center gap-2 text-left px-2.5 h-7 hover:bg-sel-soft", q.command === c.id && "font-medium")} data-filter-option={c.id} title={c.hint} onClick={() => choose(c.id)}>
                <span className="flex-none w-24 mono text-sm">:{c.id}</span><span className="text-xs text-ink-3 truncate">{c.hint}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-0.5 h-7 -mx-0.5">
        <span className="flex-none pl-1 pr-1.5 mono text-sm text-ink-2" data-feature-count {...tipHandlers({ title: `${p.total} feature${p.total === 1 ? "" : "s"}`, hint: p.below > 0 ? `${p.below} below the rollback bar.` : undefined })}>{text && q.partial === null ? `${p.shown}/${p.total}` : p.total}</span>
        {p.errors ? (
          <button type="button" className="pill err cursor-pointer" data-error-badge={p.errors} aria-label={`${p.errors} feature${p.errors === 1 ? "" : "s"} failed. Show ${p.errors === 1 ? "it" : "them"}.`}
            {...tipHandlers({ title: `${p.errors} feature${p.errors === 1 ? "" : "s"} failed`, hint: `${p.warnings ? `${p.warnings} more left a note. ` : ""}Click to show only the failed ones.` })} onClick={() => setListFilter(studio, q.command === "errors" ? "" : ":errors ")}>
            <Glyph svg={ERROR} size={13} />{p.errors}
          </button>
        ) : null}
        <span className="flex-1" />
        <button type="button" className={ICON_BTN} disabled={!p.canEdit || !p.selected} data-new-folder aria-label="Add the selection to a new folder"
          {...tipHandlers({ title: "New folder", hint: "Group the selected features in a folder.", why: !p.canEdit ? "View-only access" : !p.selected ? "Select the features to put in it first" : null })} onClick={p.onNewFolder}>
          <Glyph svg={FOLDER_ADD} size={16} />
        </button>
        <button type="button" className={cx(ICON_BTN, paused && "bg-sel text-ink")} disabled={!p.canEdit && !paused} aria-pressed={paused} data-regen-pause aria-label={paused ? "Regenerate and stop pausing" : "Pause regeneration"}
          {...tipHandlers({ title: paused ? "Regeneration is paused" : "Pause regeneration", hint: paused ? "Click to regenerate and go on as usual." : "Make several edits without waiting for the model to rebuild after each.", why: !p.canEdit && !paused ? "View-only access" : null })}
          onClick={() => (paused ? studio.resumeRegen() : studio.pauseRegen())}>
          <Glyph svg={PAUSE} size={16} />
        </button>
        <button type="button" className={ICON_BTN} data-regen-times aria-label="Show regeneration times" {...tipHandlers({ title: "Regeneration times", hint: "How long each feature takes to rebuild." })} onClick={p.onTimes}>
          <Glyph svg={CLOCK} size={16} />
        </button>
      </div>
    </div>
  );
}

/** While regeneration is paused: what is waiting and the three ways out; after a discard: the way back. */
export function PauseBanner({ studio }: { studio: PartStudio }) {
  const pause = useStudio(studio, (s) => s.pause || null);
  const discarded = useStudio(studio, (s) => s.discarded || 0);
  const canRedo = useStudio(studio, (s) => s.canRedo);
  if (!pause && !(discarded && canRedo)) return null;
  if (!pause) {
    return (
      <div className="flex flex-none items-center gap-2 px-2 py-1 border-b border-line bg-sel-soft text-sm" data-regen-discarded={discarded}>
        <span className="flex-1">{discarded} change{discarded === 1 ? " was" : "s were"} discarded.</span>
        <button type="button" className="btn sm" data-regen-restore onClick={() => studio.restoreDiscarded()}>Restore</button>
      </div>
    );
  }
  return (
    <div className="flex flex-none flex-col gap-1 px-2 py-1.5 border-b border-line bg-sel-soft text-sm" role="status" data-regen-paused={pause.edits}>
      <span><b>Regeneration is paused.</b> {pause.edits ? `${pause.edits} change${pause.edits === 1 ? "" : "s"} of yours ${pause.edits === 1 ? "is" : "are"} not in the model yet.` : "The model on screen waits; your edits are saved as you make them."}</span>
      <div className="flex flex-wrap gap-1">
        <button type="button" className="btn sm" data-regen-now {...tipHandlers({ title: "Regenerate Part Studio", hint: "Rebuild the model now and stay paused." })} onClick={() => studio.regenerateNow()}>Regenerate</button>
        <button type="button" className="btn sm primary" data-regen-exit {...tipHandlers({ title: "Regenerate features and exit", hint: "Rebuild the model and rebuild after every edit again." })} onClick={() => studio.resumeRegen()}>Regenerate and exit</button>
        <button type="button" className="btn sm" disabled={!pause.edits} data-regen-discard {...tipHandlers({ title: "Discard unregenerated changes and exit", hint: "Take back your changes the model does not show yet. Restore brings them back.", why: pause.edits ? null : "Nothing is waiting" })} onClick={() => studio.resumeRegen(true)}>Discard and exit</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the dialogs

/** The name of a new folder. */
export function FolderNameDialog({ at, suggested, count, onAccept, onClose }: { at: { x: number; y: number }; suggested: string; count: number; onAccept(name: string): void; onClose(): void }) {
  const [name, setName] = useState(suggested);
  return (
    <Popup title="Folder name" icon={FOLDER} at={at} width={260} onClose={onClose} onAccept={() => onAccept(name.trim() || suggested)} attrs={{ "data-folder-dialog": "" }}>
      <input autoFocus className="input w-full" aria-label="Folder name" value={name} data-folder-name onFocus={(ev) => ev.target.select()} onChange={(ev) => setName(ev.target.value)} />
      <p className="note m-0 mt-1.5">{count} item{count === 1 ? "" : "s"} will be moved together into it.</p>
    </Popup>
  );
}

/** Dynamic suppression: the condition under which a feature or a folder is not built. */
export function SuppressionDialog({ studio, id, at, onClose }: { studio: PartStudio; id: string; at: { x: number; y: number }; onClose(): void }) {
  useStudio(studio, (s) => s.features);
  const doc = studio.doc, item = doc?.items.get(id);
  const stored = item && (isFeature(item) || isFolder(item)) && typeof item.suppressIf === "string" ? item.suppressIf : "";
  const [text, setText] = useState(stored);
  if (!doc || !item || !(isFeature(item) || isFolder(item))) return null;
  const vars = variablesOf(doc), lookup = lookupOf(variableValues(vars));
  const problem = text.trim() ? conditionProblem(text, lookup) : null;
  let holds = false;
  if (text.trim() && !problem) { try { holds = evaluateCondition(text, lookup); } catch (e) { /* said above */ } }
  const save = (value: string | null) => { const c = setSuppressIf(doc, id, value); if (c.length) studio.commit(c); onClose(); };
  return (
    <Popup title="Dynamic suppression" icon={CONDITION} at={at} width={320} onClose={onClose} onAccept={() => save(text)} why={problem} attrs={{ "data-suppression-dialog": id }}>
      <label className="block text-sm text-ink-2 mb-1">Suppress <b className="text-ink">{String(item.name)}</b> when</label>
      <input autoFocus className="input w-full mono" aria-label="Condition" placeholder="#depth < 12 mm" value={text} data-suppress-if spellCheck={false} onChange={(ev) => setText(ev.target.value)} />
      <p className={cx("note m-0 mt-1.5", problem && "text-err")} data-condition-state={problem ? "error" : !text.trim() ? "empty" : holds ? "suppressed" : "built"}>
        {problem || (!text.trim() ? "A comparison of numbers and variables: <  <=  >  >=  ==  != , joined with && and ||." : holds ? "True now: it is suppressed." : "False now: it is built.")}
      </p>
      {vars.length ? <p className="note m-0 mt-1 truncate" title={vars.map((v) => v.name).join(", ")}>Variables: {vars.slice(0, 8).map((v) => "#" + v.name).join("  ")}{vars.length > 8 ? " …" : ""}</p> : <p className="note m-0 mt-1">This part studio has no variables yet (the Variables panel makes them).</p>}
      {stored ? <button type="button" className="btn sm mt-2" data-remove-condition onClick={() => save(null)}>Remove expression</button> : null}
    </Popup>
  );
}

/** What a feature is built from (above the up arrow) and what is built from it (below the down arrow). */
export function DependenciesDialog({ studio, of, uses, usedBy, at, onClose }: { studio: PartStudio; of: FeatureItem; uses: FeatureItem[]; usedBy: FeatureItem[]; at: { x: number; y: number }; onClose(): void }) {
  const row = (f: FeatureItem, kind: "parent" | "child" | "this") => (
    <button type="button" key={f.id} className={cx("appearance-none bg-transparent border-0 m-0 text-inherit [font-family:inherit] [font-size:inherit] cursor-default flex w-full items-center gap-2 h-7 px-1.5 rounded-sm text-left", kind === "this" ? "bg-sel font-medium cursor-default" : "hover:bg-sel-soft")} data-dep-row={kind} data-dep-id={f.id}
      onPointerEnter={() => studio.setHoverFeature(f.id)} onPointerLeave={() => studio.setHoverFeature(null)} onClick={() => studio.selectFeature(f.id)}>
      <Glyph svg={featureDef(f.featureType)?.icon} size={16} /><span className="flex-1 truncate">{f.name}</span>
    </button>
  );
  const arrow = (svg: string, title: string, hint: string, n: number) => (
    <div className="flex items-center gap-1.5 h-6 px-1.5 text-xs text-ink-3" {...tipHandlers({ title, hint })}><Glyph svg={svg} size={13} /><span>{n ? title : hint}</span></div>
  );
  return (
    <Popup title="Dependencies" at={at} width={280} onClose={onClose} attrs={{ "data-deps": of.id }}>
      {uses.map((f) => row(f, "parent"))}
      {arrow(UP, "Parents", uses.length ? `${of.name} is built from ${uses.length === 1 ? "this" : "these"}.` : "Built from nothing before it", uses.length)}
      {row(of, "this")}
      {arrow(DOWN, "Children", usedBy.length ? `${usedBy.length === 1 ? "This is" : "These are"} built from ${of.name}.` : "Nothing is built from it", usedBy.length)}
      {usedBy.map((f) => row(f, "child"))}
    </Popup>
  );
}

const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);

/** How long each feature took the last time it was built.  The pointer over a row lights the feature up in the model. */
export function RegenTimesDialog({ studio, at, onClose }: { studio: PartStudio; at: { x: number; y: number }; onClose(): void }) {
  const features = useStudio(studio, (s) => s.features);
  const reports = useStudio(studio, (s) => s.reports);
  const canEdit = useStudio(studio, (s) => s.canEdit);
  const times = useStudio(studio, () => regenTimes(studio));
  const known = features.filter((f) => typeof times[f.id] === "number");
  const total = known.reduce((sum, f) => sum + times[f.id], 0), most = Math.max(1, ...known.map((f) => times[f.id]));
  return (
    <Popup title="Regeneration times" icon={CLOCK} at={at} width={340} onClose={onClose} attrs={{ "data-regen-times-dialog": "" }}>
      <p className="note m-0 mb-1.5" data-regen-total={Math.round(total)}>{known.length ? <>The whole part studio: <b className="text-ink">{ms(total)}</b>. Suppress what is slow and not needed just now.</> : "Nothing has been built yet."}</p>
      <div className="flex flex-col" role="list">
        {features.map((f) => {
          const t = times[f.id], state = reports[f.id]?.status || "ok", off = state === "suppressed";
          return (
            <div key={f.id} role="listitem" className={cx("group flex items-center gap-2 h-7 px-1 rounded-sm hover:bg-sel-soft", (off || state === "rolled-back") && "text-ink-3")} data-time-row={f.id} data-ms={typeof t === "number" ? t : undefined}
              onPointerEnter={() => studio.setHoverFeature(f.id)} onPointerLeave={() => studio.setHoverFeature(null)} onClick={() => studio.selectFeature(f.id)}>
              <Glyph svg={featureDef(f.featureType)?.icon} size={16} />
              <span className={cx("flex-none w-28 truncate", off && "line-through")}>{f.name}</span>
              <span className="flex-1 h-1.5 rounded-full bg-line overflow-hidden"><span className="block h-full rounded-full bg-accent" style={{ width: typeof t === "number" && !off ? `${Math.max(2, (t / most) * 100)}%` : 0 }} /></span>
              <span className="flex-none w-14 text-right mono text-sm">{off ? "off" : typeof t === "number" ? ms(t) : "–"}</span>
              {canEdit ? (
                <button type="button" className="btn sm ghost flex-none h-5 min-h-0 px-1 text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100" data-time-suppress onClick={(ev) => { ev.stopPropagation(); const doc = studio.doc; if (doc) studio.commit(suppressItems(doc, [f.id], !f.suppressed)); }}>{f.suppressed ? "Unsuppress" : "Suppress"}</button>
              ) : null}
            </div>
          );
        })}
      </div>
    </Popup>
  );
}
