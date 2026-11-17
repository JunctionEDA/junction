// The Sketch panel, and the sketcher's own chrome in the viewport.
//
// The panel (right dock) says how the open sketch stands — free, fully constrained or in conflict, and how many
// degrees of freedom are left — and lists its dimensions and constraints, which can be selected and deleted from
// the list as from the drawing.
//
// While a sketch is open the same component also draws, inside the viewport:
//   • the sketch tool palette: one icon button per tool file tools/sketch-*.ts, grouped as draw, modify,
//     constrain and dimension (by their `order`: 0…, 100…, 200…, 300…).  The part studio's toolbar keeps only
//     "Finish sketch": thirty-five labelled buttons do not fit in it;
//   • the status line: the state of the sketch and what the tool in hand is waiting for.
// Mounting this panel is also what starts the sketch editor (sketch/editor.ts) for the part studio.
import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../../shared/util";
import { definePanel, type ToolDefinition } from "../core/tool";
import { dimensionText } from "../sketch/dims";
import { sketchEditor, type EditorState, type SketchEditor } from "../sketch/editor";
import { isDimension } from "../sketch/refs";
import { Glyph } from "../ui/Glyph";
import { useStudio } from "../ui/hooks";
import type { PartStudio } from "../ui/studio";

function useEditor<T>(ed: SketchEditor, selector: (s: EditorState) => T): T {
  return useSyncExternalStore(ed.subscribe, () => selector(ed.getState()));
}

const SECTIONS: { title: string; from: number; to: number }[] = [
  { title: "Draw", from: 0, to: 100 }, { title: "Modify", from: 100, to: 200 }, { title: "Constrain", from: 200, to: 300 }, { title: "Dimension", from: 300, to: 900 },
];

/** How the sketch stands, in a few words, and the token colour that says it. */
export function standing(s: EditorState): { text: string; detail: string; tone: "ok" | "free" | "bad" | "wait" } {
  if (!s.ready) return { text: "Starting the solver…", detail: "", tone: "wait" };
  if (s.health === "conflict") return { text: "Over-constrained", detail: `${s.conflicting.length} constraint${s.conflicting.length === 1 ? "" : "s"} in conflict, shown in red`, tone: "bad" };
  if (s.health === "unsolved") return { text: "Not solved", detail: "the constraints could not be met; undo the last change", tone: "bad" };
  if (!Object.keys(s.data.entities).length) return { text: "Empty sketch", detail: "", tone: "wait" };
  if (s.dof === 0) return { text: "Fully constrained", detail: s.redundant.length ? `${s.redundant.length} redundant` : "", tone: "ok" };
  return { text: "Under-constrained", detail: `${s.dof} degree${s.dof === 1 ? "" : "s"} of freedom`, tone: "free" };
}
const TONE = { ok: "text-ink", free: "text-teal", bad: "text-err", wait: "text-ink-3" } as const;

function Palette({ studio, ed }: { studio: PartStudio; ed: SketchEditor }) {
  const tool = useEditor(ed, (s) => s.tool);
  const construction = useEditor(ed, (s) => s.construction);
  const canEdit = useStudio(studio, (s) => s.canEdit);
  void tool; void construction;
  const tools = studio.tools().filter((t) => t.group === "sketch" && t.button === false).slice().sort((a, b) => (a.order ?? 1e6) - (b.order ?? 1e6) || a.title.localeCompare(b.title));
  const button = (t: ToolDefinition) => {
    const on = t.active ? t.active(studio) : false;
    const why = !canEdit ? "View-only access" : t.disabled ? t.disabled(studio) : null;
    return (
      <button key={t.id} type="button" className={cx("btn sm ghost cad-sk-tool flex items-center justify-center p-0 w-7 h-7", on && "on", why && "opacity-45")} aria-pressed={on || undefined} aria-disabled={why ? true : undefined} aria-label={t.title}
        title={`${t.title}${t.key ? `  (${t.key.toUpperCase()})` : ""}${why ? `: ${why}` : t.hint ? `\n${t.hint}` : ""}`} data-tool={t.title} data-tool-id={t.id}
        onClick={() => { if (!why) t.run(studio); studio.viewport.canvas.focus(); }}>
        <Glyph svg={t.icon} size={17} />
      </button>
    );
  };
  return (
    <div className="cad-sketch-palette absolute top-2 left-2 z-2 flex flex-wrap items-center max-w-[calc(100%-290px)] bg-panel border border-line rounded-sm shadow-(--shadow) select-none" role="toolbar" aria-label="Sketch tools" data-group="sketch"
      onPointerDown={(e) => e.stopPropagation()}>
      {SECTIONS.map((sec) => {
        const mine = tools.filter((t) => (t.order ?? 0) >= sec.from && (t.order ?? 0) < sec.to);
        return mine.length ? <div key={sec.title} className="flex items-center gap-px px-1 py-0.5 border-r border-line last:border-r-0" role="group" aria-label={sec.title}>{mine.map(button)}</div> : null;
      })}
    </div>
  );
}

function StatusLine({ ed }: { ed: SketchEditor }) {
  const s = useEditor(ed, (x) => x);
  const st = standing(s);
  return (
    <div className="cad-sketch-status absolute left-18 bottom-10 z-2 flex items-center gap-2 max-w-[calc(100%-80px)] px-2 h-6 bg-panel border border-line rounded-sm text-xs select-none pointer-events-none" role="status" data-standing={st.tone} data-dof={s.dof}>
      <span className={cx("font-semibold whitespace-nowrap", TONE[st.tone])}>{st.text}</span>
      {st.detail ? <span className="text-ink-2 whitespace-nowrap">{st.detail}</span> : null}
      {s.construction ? <span className="pill">construction</span> : null}
      {s.hint ? <span className="text-ink-3 truncate border-l border-line pl-2">{s.hint}</span> : null}
    </div>
  );
}

const TITLES: { [type: string]: string } = {
  coincident: "Coincident", horizontal: "Horizontal", vertical: "Vertical", parallel: "Parallel", perpendicular: "Perpendicular", tangent: "Tangent", equal: "Equal",
  midpoint: "Midpoint", concentric: "Concentric", collinear: "Collinear", symmetric: "Symmetric", fix: "Fix", distance: "Distance", radius: "Radius", diameter: "Diameter", angle: "Angle",
};

function SketchPanel({ studio }: { studio: PartStudio }) {
  const ed = sketchEditor(studio);
  useEffect(() => { sketchEditor(studio); }, [studio]);
  const s = useEditor(ed, (x) => x);
  const open = useStudio(studio, (x) => !!x.sketch);
  if (!open || !s.open) return <p className="note px-2 py-1 m-0">Open a sketch to see its dimensions and constraints.</p>;
  const st = standing(s);
  const all = Object.entries(s.data.constraints);
  const dims = all.filter(([, c]) => isDimension(c)), rest = all.filter(([, c]) => !isDimension(c));
  const row = (id: string, label: string, value: string, flag: string | null) => {
    const on = s.selection.includes(id);
    return (
      <div key={id} role="listitem" data-constraint={id} className={cx("group flex items-center gap-1.5 h-6 px-2 cursor-default", on ? "bg-sel" : "hover:bg-sel-soft")}
        onPointerEnter={() => ed.setHover(id)} onPointerLeave={() => ed.setHover(null)} onClick={(e) => (e.shiftKey || e.ctrlKey || e.metaKey ? ed.toggle(id) : ed.select([id]))}
        onDoubleClick={() => { if (value) ed.editDimension(id); }}>
        <span className={cx("truncate", flag === "conflict" && "text-err", flag === "redundant" && "text-warn")}>{label}</span>
        {value ? <span className="mono text-ink-2 ml-auto whitespace-nowrap">{value}</span> : <span className="ml-auto" />}
        {flag ? <span className={cx("pill", flag === "conflict" ? "err" : "warn")}>{flag}</span> : null}
        <button type="button" className="btn sm ghost p-0 w-5 min-h-0 h-5 opacity-0 group-hover:opacity-100 focus:opacity-100" title="Delete" aria-label={`Delete ${label}`} onClick={(e) => { e.stopPropagation(); ed.edit((d) => d.remove([id])); }}>×</button>
      </div>
    );
  };
  const flagOf = (id: string) => (s.conflicting.includes(id) ? "conflict" : s.redundant.includes(id) ? "redundant" : null);
  return (
    <div className="flex flex-col text-sm" data-sketch-panel>
      <div className="px-2 py-1.5 border-b border-line">
        <div className={cx("font-semibold", TONE[st.tone])} data-standing={st.tone}>{st.text}</div>
        {st.detail ? <div className="text-ink-2 text-xs">{st.detail}</div> : null}
      </div>
      <div className="px-2 pt-1.5 pb-0.5 text-2xs uppercase tracking-wide text-ink-3 mono">Dimensions ({dims.length})</div>
      <div role="list" aria-label="Dimensions">
        {dims.length ? dims.map(([id, c]) => row(id, (TITLES[c.type] || c.type) + (c.driving === false ? " (reference)" : ""), dimensionText(s.data, c), flagOf(id))) : <p className="note px-2 py-0.5 m-0">None yet. Press D.</p>}
      </div>
      <div className="px-2 pt-2 pb-0.5 text-2xs uppercase tracking-wide text-ink-3 mono">Constraints ({rest.length})</div>
      <div role="list" aria-label="Constraints">
        {rest.length ? rest.map(([id, c]) => row(id, TITLES[c.type] || c.type, "", flagOf(id))) : <p className="note px-2 py-0.5 m-0">None yet.</p>}
      </div>
    </div>
  );
}

/** The palette and status line live in the viewport; a panel is the one place a tool-less file can mount React. */
function SketchChrome({ studio }: { studio: PartStudio }) {
  const ed = sketchEditor(studio);
  const open = useEditor(ed, (s) => s.open);
  return (
    <>
      <SketchPanel studio={studio} />
      {open ? createPortal(<><Palette studio={studio} ed={ed} /><StatusLine ed={ed} /></>, studio.viewport.host) : null}
    </>
  );
}

export default definePanel({ id: "sketch", title: "Sketch", side: "right", order: 10, render: (studio) => <SketchChrome studio={studio} /> });
