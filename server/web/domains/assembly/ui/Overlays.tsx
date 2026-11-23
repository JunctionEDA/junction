// Overlays.tsx — what opens over the assembly for a moment and goes again, as in the part studio:
//
//   CommandPalette   the tool search: the field at the right of the toolbar opens it in its own place, S at the
//                    pointer, Ctrl/Cmd+K and Alt+C in the middle.  Type a few letters of any tool, or another
//                    word for it ("joint", "hinge", "ground", "BOM"); Enter runs the first; ↑ ↓ choose.
//   ContextMenu      a right click in the viewport that did not turn the view: what can be done with the
//                    instance under the pointer, with the marking menu's ring of eight tools above it.
//   Shortcuts        the sheet of every key (?), and from it the dialog that changes them (the part studio's).
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../../shared/util";
import { DIRECTIONS, Glyph, KeymapSheet, VIEW_KEYS, markingPlace, searchCommands, wedgeAt, wedgePlace, type Entry } from "../../mechanical/api-ui";
import type { AssemblyEditor, PaletteAt } from "./assembly";
import { allCommands, markingEntries } from "./commands";
import { assemblyKeys, setPrefs, shortcutOf, usePref } from "./keys";
import { useAssembly } from "./parts";
import { SEARCH } from "./Toolbar";

const BARE = "appearance-none bg-transparent border-0 m-0 text-inherit [font-family:inherit] [font-size:inherit]";

export function CommandPalette({ assembly }: { assembly: AssemblyEditor }) {
  const at = useAssembly(assembly, (s) => s.ui.palette || null);
  // a search starts empty every time it is opened
  return at ? <Palette assembly={assembly} at={at} /> : null;
}

function Palette({ assembly, at }: { assembly: AssemblyEditor; at: PaletteAt }) {
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const close = () => { assembly.setUi({ palette: null }); assembly.viewport.canvas.focus(); };
  useEffect(() => { input.current?.focus(); }, [at]);
  const all = useMemo(() => allCommands(assembly), [at, assembly]);   // eslint-disable-line react-hooks/exhaustive-deps
  const found = searchCommands(all, q);
  const run = (e: Entry | undefined) => { if (!e || e.why) return; close(); e.run(); };
  const w = at.under ? Math.max(340, at.under.width) : 340, h = 420;
  const left = at.under ? Math.max(8, Math.min(at.under.right - w, window.innerWidth - w - 8)) : at.x === null ? Math.round(window.innerWidth / 2 - w / 2) : Math.max(8, Math.min(at.x - 20, window.innerWidth - w - 8));
  const top = at.under ? at.under.top - 1 : at.y === null ? Math.round(window.innerHeight * 0.2) : Math.max(8, Math.min(at.y - 18, window.innerHeight - h - 8));
  return (
    <div className="fixed inset-0 z-[60]" onPointerDown={close} data-palette-scrim>
      <div className="cad-palette absolute flex flex-col rounded-md border border-line-2 bg-panel shadow-panel text-base text-ink overflow-hidden" style={{ left, top, width: w, maxHeight: h }} role="dialog" aria-label="Search tools" data-palette-mode="assembly" onPointerDown={(ev) => ev.stopPropagation()}>
        <label className="flex flex-none items-center gap-2 h-9 pl-2.5 pr-2 border-b border-line text-ink-2">
          <Glyph svg={SEARCH} size={16} />
          <input ref={input} autoFocus className="appearance-none flex-1 min-w-0 h-full bg-transparent border-0 outline-none p-0 text-base text-ink [font-family:inherit] placeholder:text-ink-3" type="text" role="combobox" aria-expanded="true" aria-controls="asm-palette-list" placeholder="Search tools…" aria-label="Search tools" value={q} data-palette-input
            onChange={(ev) => { setQ(ev.target.value); setIndex(0); }}
            onKeyDown={(ev) => {
              ev.stopPropagation();
              if (ev.key === "Escape") { ev.preventDefault(); close(); }
              else if (ev.key === "Enter") { ev.preventDefault(); run(found[index]?.entry); }
              else if (ev.key === "ArrowDown") { ev.preventDefault(); setIndex(Math.min(found.length - 1, index + 1)); }
              else if (ev.key === "ArrowUp") { ev.preventDefault(); setIndex(Math.max(0, index - 1)); }
            }} />
          <span className="kbd flex-none">Esc</span>
        </label>
        <div id="asm-palette-list" className="overflow-y-auto py-1" role="listbox">
          {found.length ? found.map(({ entry: e, by }, i) => (
            <button key={e.id} type="button" role="option" aria-selected={i === index} aria-disabled={e.why ? true : undefined} data-command={e.title} data-command-id={e.id} ref={i === index ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
              className={cx("appearance-none border-0 m-0 text-inherit [font-family:inherit] [font-size:inherit] flex w-full items-center gap-2.5 px-3 h-8 text-left cursor-pointer", i === index ? "bg-sel font-medium" : "bg-transparent hover:bg-sel-soft", e.why && "opacity-40")} title={e.why || e.hint}
              onPointerMove={() => { if (i !== index) setIndex(i); }} onClick={() => run(e)}>
              <Glyph svg={e.icon} size={20} /><span className="flex-1 truncate">{e.title}{by ? <span className="text-ink-3" data-command-by={by}> · {by}</span> : null}</span>{e.shortcut ? <span className="kbd">{e.shortcut}</span> : null}
            </button>
          )) : <p className="note px-3 py-1 m-0">Nothing is called that.</p>}
        </div>
        <div className="flex flex-none items-center gap-3 h-7 px-3 border-t border-line text-xs text-ink-3"><span><span className="kbd">↑</span> <span className="kbd">↓</span> choose</span><span><span className="kbd">Enter</span> run</span><span className="flex-1" /><span>Tools, mates and relations</span></div>
      </div>
    </div>
  );
}

/** The right-click menu of the viewport, and round the pointer the marking menu's ring. */
export function ContextMenu({ assembly }: { assembly: AssemblyEditor }) {
  const at = useAssembly(assembly, (s) => s.ui.menu || null);
  const marking = usePref("markingMenu");
  const [hot, setHot] = useState(-1);
  const close = () => assembly.setUi({ menu: null });
  const listHeight = useRef(0);
  const place = at ? markingPlace(at.x, at.y, window.innerWidth, window.innerHeight, listHeight.current) : null;
  useEffect(() => {
    if (!at) return;
    setHot(-1);
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } };
    const away = () => close();
    const move = (ev: PointerEvent) => { if (marking && place) setHot(wedgeAt(ev.clientX - place.cx, ev.clientY - place.cy)); };
    document.addEventListener("keydown", key, true); document.addEventListener("pointerdown", away); window.addEventListener("blur", away); document.addEventListener("pointermove", move);
    return () => { document.removeEventListener("keydown", key, true); document.removeEventListener("pointerdown", away); window.removeEventListener("blur", away); document.removeEventListener("pointermove", move); };
  }, [at, marking]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!at) return null;
  const s = assembly.getState(), ro = !s.canEdit;
  const inst = at.instance ? s.instances.find((i) => i.id === at.instance) : undefined;
  const ids = inst ? (s.selection.includes(inst.id) ? assembly.selectedInstances().map((i) => i.id) : [inst.id]) : [];
  const items: ({ label: string; key?: string; why?: string | null; run(): void } | null)[] = [];
  const add = (label: string, run: () => void, key?: string, why?: string | null) => items.push({ label, run, key, why });
  if (s.mating) { add("Done", () => assembly.acceptMate(), "Enter"); add("Cancel", () => assembly.cancelMate(), "Esc"); }
  else if (inst) {
    const info = s.instanceInfo[inst.id];
    add(inst.source.kind === "part" ? "Edit the part" : inst.source.kind === "board" ? "Open the board" : "Open the sub-assembly", () => assembly.openSource(inst.id));
    items.push(null);
    add(inst.fixed ? "Unfix" : "Fix", () => assembly.setFixed(ids, !inst.fixed), shortcutOf("fix"), ro ? "View-only access" : null);
    add(inst.hidden ? "Show" : "Hide", () => assembly.setHidden(ids, !inst.hidden), shortcutOf("hide"), ro ? "View-only access" : null);
    add("Suppress", () => assembly.setSuppressed(ids, true), undefined, ro ? "View-only access" : null);
    if (ids.length >= 2) add("Group", () => assembly.groupRigid(ids), shortcutOf("group"), ro ? "View-only access" : null);
    add("Rename", () => assembly.startRename(inst.id), "F2", ro ? "View-only access" : null);
    add("Replace…", () => assembly.openInsert(inst.id), undefined, ro ? "View-only access" : null);
    if (info && info.status === "ready") add("Zoom to it", () => assembly.zoomTo(ids));
    items.push(null);
    add("Delete", () => assembly.remove(ids), "Del", ro ? "View-only access" : null);
  } else {
    add("Insert…", () => assembly.openInsert(), shortcutOf("insert"), ro ? "View-only access" : null);
    add("Zoom to fit", () => assembly.fit(), shortcutOf("fit"));
    if (s.instances.some((i) => i.hidden)) add("Show all", () => assembly.setHidden(s.instances.filter((i) => i.hidden).map((i) => i.id), false), undefined, ro ? "View-only access" : null);
    if (s.selection.length) add("Clear the selection", () => assembly.select(null), "Esc");
  }
  items.push(null);
  add("Search tools…", () => assembly.setUi({ palette: { x: at.x, y: at.y } }), "S");
  add(marking ? "Hide the marking menu" : "Show the marking menu", () => setPrefs({ markingMenu: !marking }));
  const shown = items.filter((x, i) => x || (i > 0 && items[i - 1] && i < items.length - 1));
  listHeight.current = shown.length * 28 + 12;
  const ring = marking ? markingPlace(at.x, at.y, window.innerWidth, window.innerHeight, listHeight.current) : null;
  const entries = marking ? markingEntries(assembly, !!inst) : [];
  const run = (e: Entry | null) => { if (!e || e.why) return; close(); e.run(); assembly.viewport.canvas.focus(); };
  return (
    <>
      {ring ? (
        <div className="cad-marking fixed z-[56] w-0 h-0" style={{ left: ring.cx, top: ring.cy }} role="menu" aria-label="Marking menu" data-marking data-hot={hot >= 0 ? DIRECTIONS[hot] : undefined} onContextMenu={(ev) => ev.preventDefault()}>
          <div className="absolute rounded-full border border-line bg-panel/60 shadow-panel" style={{ left: -34, top: -34, width: 68, height: 68 }} data-marking-ring
            onPointerDown={(ev) => { const i = wedgeAt(ev.clientX - ring.cx, ev.clientY - ring.cy); if (i >= 0 && entries[i] && !entries[i]!.why) { ev.stopPropagation(); run(entries[i]); } }}>
            {hot >= 0 && entries[hot] ? <span className="absolute left-1/2 top-1/2 w-0.5 h-8 -ml-px origin-top bg-[var(--mark)] rounded" style={{ transform: `rotate(${hot * 45 + 180}deg)` }} aria-hidden="true" /> : null}
            <span className="absolute left-1/2 top-1/2 w-1.5 h-1.5 -ml-[3px] -mt-[3px] rounded-full bg-ink-2" aria-hidden="true" />
          </div>
          {entries.map((e, i) => {
            if (!e) return null;
            const p = wedgePlace(i);
            const anchor = p.x > 8 ? "translate(0,-50%)" : p.x < -8 ? "translate(-100%,-50%)" : "translate(-50%,-50%)";
            return (
              <button key={DIRECTIONS[i]} type="button" role="menuitem" aria-disabled={e.why ? true : undefined} title={e.why || e.hint} data-marking-item={DIRECTIONS[i]} data-marking-id={e.id} data-marking-title={e.title}
                className={cx("appearance-none m-0 [font-family:inherit] absolute flex items-center gap-1.5 h-8 px-2.5 whitespace-nowrap rounded-md border text-base text-ink shadow-panel cursor-pointer", hot === i && !e.why ? "border-[var(--mark)] bg-sel font-medium" : "border-line bg-panel hover:bg-sel-soft", e.why && "opacity-45")}
                style={{ left: p.x, top: p.y, transform: anchor }} onPointerDown={(ev) => ev.stopPropagation()} onClick={() => run(e)}>
                <Glyph svg={e.icon} size={18} /><span>{e.title}</span>{e.shortcut ? <span className="kbd ml-1">{e.shortcut}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="cad-context-menu fixed z-[55] min-w-52 py-1 rounded-md border border-line bg-panel shadow-panel text-base text-ink" role="menu" data-view-menu style={ring ? { left: ring.listLeft, top: ring.listTop } : { left: Math.min(at.x, window.innerWidth - 230), top: Math.min(at.y, window.innerHeight - listHeight.current) }} onPointerDown={(ev) => ev.stopPropagation()} onContextMenu={(ev) => ev.preventDefault()}>
        {shown.map((x, i) => x ? (
          <button key={x.label} type="button" role="menuitem" aria-disabled={x.why ? true : undefined} data-menu-item={x.label} className={cx(BARE, "flex w-full items-center px-3 h-7 text-left cursor-pointer hover:bg-sel-soft", x.why && "opacity-45")} title={x.why || undefined}
            onClick={() => { if (x.why) return; close(); x.run(); }}>
            <span className="flex-1">{x.label}</span>{x.key ? <span className="mono text-xs text-ink-3 ml-4">{x.key}</span> : null}
          </button>
        ) : <div key={"sep" + i} className="my-1 border-t border-line" role="separator" />)}
      </div>
    </>
  );
}

const MOUSE: [string, string][] = [
  ["Right drag", "Turn the view"], ["Middle drag", "Slide the view (also Ctrl + right drag)"], ["Wheel", "Zoom about the pointer"],
  ["Click", "Select an instance; Shift or Ctrl adds"], ["Drag a part", "Move it as its mates allow"], ["Double click a part", "Open its part studio"],
  ["Double click beside the model", "Zoom to fit"], ["Right click", "The menu for what is under the pointer"],
];

export function Shortcuts({ assembly }: { assembly: AssemblyEditor }) {
  const open = useAssembly(assembly, (s) => !!s.ui.help), keysOpen = useAssembly(assembly, (s) => !!s.ui.keys);
  const bindings = assemblyKeys.use();
  const close = () => { assembly.setUi({ help: false }); assembly.viewport.canvas.focus(); };
  useEffect(() => {
    if (!open) return;
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape" || ev.key === "?") { ev.stopPropagation(); ev.preventDefault(); close(); } };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  const rows = (test: (id: string) => boolean): [string, string][] => bindings.filter((b) => b.chord && test(b.id)).map((b) => [b.chord!, b.title]);
  const groups: { title: string; rows: [string, string][] }[] = [
    { title: "Mouse", rows: MOUSE },
    { title: "View", rows: VIEW_KEYS.map(([k, what]): [string, string] => [k, what]) },
    { title: "Assembly", rows: [["S", "Search tools, at the pointer"], ["Ctrl+K / Alt+C", "Search tools"], ...rows((id) => !id.startsWith("m:") && !id.startsWith("r:")), ["Del", "Delete what is selected"], ["F2", "Rename"], ["Ctrl+Z / Ctrl+Y", "Undo / redo"], ["?", "This sheet"]] },
    { title: "Mates", rows: [...rows((id) => id.startsWith("m:") || id.startsWith("r:")), ["Enter", "Keep the mate"], ["Esc", "Cancel"]] },
  ];
  return (
    <>
      {open ? (
        <div className="fixed inset-0 z-[65] grid place-items-center bg-[var(--scrim)]" onPointerDown={close} data-shortcuts>
          <div className="cad-shortcuts w-[min(880px,94vw)] max-h-[86vh] flex flex-col rounded-md border border-line bg-bench shadow-panel text-sm text-ink" role="dialog" aria-label="Keyboard shortcuts" onPointerDown={(ev) => ev.stopPropagation()}>
            <header className="flex items-center h-9 px-3 border-b border-line bg-paper rounded-t-md"><span className="flex-1 font-semibold text-base">Keys and mouse</span><button type="button" className="btn sm mr-1" data-keymap-open onClick={() => { close(); assembly.setUi({ keys: true }); }}>Change keys…</button><button type="button" className="btn sm ghost" onClick={close}>Close</button></header>
            <div className="overflow-y-auto p-3 columns-1 sm:columns-2 lg:columns-3 gap-5">
              {groups.map((g) => (
                <section key={g.title} className="break-inside-avoid mb-3">
                  <h3 className="m-0 mb-1 text-2xs uppercase tracking-wide text-ink-3 mono font-normal">{g.title}</h3>
                  {g.rows.map(([key, what]) => <div key={key + what} className="flex items-baseline gap-2 py-0.5"><span className="flex-none min-w-16"><span className="kbd">{key}</span></span><span className="text-ink-2">{what}</span></div>)}
                </section>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      <KeymapSheet open={keysOpen} store={assemblyKeys} close={() => { assembly.setUi({ keys: false }); assembly.viewport.canvas.focus(); }} toast={(text, ms) => assembly.host.toast(text, ms)} where={{ model: "Assembly", any: "Everywhere", sketch: "" }} file="junction-assembly-keys"
        note="These are the assembly's keys; the part studio has its own. They are kept in this browser; Save… and Load… carry them to another." />
    </>
  );
}
