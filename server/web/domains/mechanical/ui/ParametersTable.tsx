// ParametersTable.tsx — every number that drives the part studio in one window (document/parameters.ts): the
// variables, each feature's number fields, each sketch's driving dimensions.  A row shows what was typed (an
// expression, or the number), the value it comes to, a comment and a star; the expression and the comment are
// changed in place, each one undoable edit seen by everybody.  The box at the top searches names, expressions
// and comments; the star button leaves the starred rows.  A click on a feature's name selects it in the model.
import { useEffect, useMemo, useState } from "react";
import { cx } from "../../../shared/util";
import { editParameter, filterRows, parameterRows, setParamNote, storeSolvedSketch, type ParamRow } from "../document/parameters";
import { formatAngle, formatLength, num } from "../document/units";
import { addVariable, deleteVariable, freeName, setVariable, usersOf } from "../document/variables";
import { loadSolver } from "../sketch/solver/load";
import { useStudio } from "./hooks";
import { Sheet } from "./Sheet";
import { featureDef, type PartStudio } from "./studio";

const STAR = "★", HOLLOW = "☆";

/** Type into a row's expression; resolves with why it could not be done, or null. */
export async function applyParameter(studio: PartStudio, key: string, text: string): Promise<string | null> {
  const doc = studio.doc; if (!doc) return "The part studio has not arrived yet.";
  if (!studio.getState().canEdit) return "You can look at this part studio but not change it.";
  const r = editParameter(doc, key, text, (t) => featureDef(t)?.schema, studio.getState().units);
  if (!r.ok) return r.error;
  if ("changes" in r) { if (r.changes.length) studio.commit(r.changes); return null; }
  // a sketch dimension: the document stores solved coordinates, so the sketch is solved with the new value first
  const solver = await loadSolver();
  const solved = solver.solve(r.solve.data);
  if (!solved.ok) return solved.conflicting.length ? "That value conflicts with the sketch's other constraints." : "The sketch cannot be solved with that value.";
  const now = studio.doc; if (!now) return null;
  const changes = storeSolvedSketch(now, r.solve.featureId, solved.data);
  if (changes.length) studio.commit(changes);
  return null;
}

function Cell({ value, onCommit, onSame, disabled, attr, placeholder, mono }: { value: string; onCommit(text: string): void; /** left as it was (what was typed before was put back) */ onSame?(): void; disabled?: boolean; attr: { [k: string]: string }; placeholder?: string; mono?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input type="text" className={cx("w-full min-w-0 h-6 px-1.5 rounded-sm border border-transparent bg-transparent hover:border-line-2 focus:border-blue focus:bg-panel outline-none text-sm text-ink", mono && "mono")} value={text} disabled={disabled} placeholder={placeholder} spellCheck={false} {...attr}
      onChange={(ev) => setText(ev.target.value)}
      onBlur={() => { if (text !== value) onCommit(text); else onSame?.(); }}
      onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); (ev.target as HTMLInputElement).blur(); } else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); setText(value); setTimeout(() => (ev.target as HTMLInputElement).blur(), 0); } }} />
  );
}

export function ParametersTable({ studio }: { studio: PartStudio }) {
  const open = useStudio(studio, (s) => !!s.ui?.parameters);
  const features = useStudio(studio, (s) => s.features);
  const units = useStudio(studio, (s) => s.units);
  const canEdit = useStudio(studio, (s) => s.canEdit);
  const tick = useStudio(studio, (s) => s.ui?.parametersTick);
  const [q, setQ] = useState("");
  const [starred, setStarred] = useState(false);
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const doc = studio.doc;
  // the variables and the notes are items the studio's state does not hold: any commit bumps the tick (below)
  const rows = useMemo(() => (open ? parameterRows(doc, (t) => featureDef(t)?.schema, units) : []), [open, doc, features, units, tick]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const tap = (msg: Record<string, unknown>) => { if (msg.type === "local_op" || msg.type === "op" || msg.type === "ops" || msg.type === "snapshot") setTimeout(() => studio.setUi({ parametersTick: Date.now() + Math.random() }), 0); };
    studio.session.taps.add(tap);
    return () => { studio.session.taps.delete(tap); };
  }, [open, studio]);
  if (!open || !doc) return null;
  const close = () => { studio.setUi({ parameters: false }); studio.viewport.canvas.focus(); };
  const shown = filterRows(rows, q, starred);
  const groups: { owner: string; ownerId: string; rows: ParamRow[] }[] = [];
  for (const r of shown) { const g = groups[groups.length - 1]; if (g && g.ownerId === r.ownerId && g.owner === r.owner) g.rows.push(r); else groups.push({ owner: r.owner, ownerId: r.ownerId, rows: [r] }); }
  const say = (key: string, error: string | null) => setErrors((e) => { const n = { ...e }; if (error) n[key] = error; else delete n[key]; return n; });
  const commitNote = (key: string, patch: { comment?: string; favourite?: boolean }) => { const c = setParamNote(studio.doc!, key, patch); if (c.length) studio.commit(c); };
  const valueText = (r: ParamRow) => (r.value === null ? "" : r.quantity === "length" ? formatLength(r.value, units) : r.quantity === "angle" ? formatAngle(r.value, units) : num(r.value, 6));
  const addVar = () => { const { changes, variable } = addVariable(studio.doc!, freeName(studio.doc!), `10 ${units.length}`); studio.commit(changes); setQ(""); setStarred(false); setTimeout(() => { const el = document.querySelector<HTMLInputElement>(`[data-param-row="v:${variable.id}"] [data-param-name]`); el?.focus(); el?.select(); }, 60); };
  const counts = { v: rows.filter((r) => r.kind === "variable").length, f: rows.filter((r) => r.kind === "feature").length, d: rows.filter((r) => r.kind === "dimension").length };
  return (
    <Sheet title="Parameters" name="parameters" wide onClose={close} attrs={{ "data-rows": String(rows.length), "data-shown": String(shown.length) }}
      actions={<button type="button" className="btn sm" disabled={!canEdit} data-param-add onClick={addVar}>Add variable</button>}>
      <div className="flex flex-none items-center gap-2 px-3 py-2 border-b border-line">
        <input type="text" className="flex-1 min-w-0" placeholder="Find a parameter, an expression or a comment…" aria-label="Find a parameter" value={q} data-param-search onChange={(ev) => setQ(ev.target.value)} />
        <button type="button" className={cx("btn sm", starred && "on")} aria-pressed={starred} data-param-starred title="Only the starred rows" onClick={() => setStarred(!starred)}>{STAR} Starred</button>
        <span className="text-xs text-ink-3 whitespace-nowrap" data-param-counts={`${counts.v} ${counts.f} ${counts.d}`}>{counts.v} variable{counts.v === 1 ? "" : "s"} · {counts.f} feature value{counts.f === 1 ? "" : "s"} · {counts.d} sketch dimension{counts.d === 1 ? "" : "s"}</span>
      </div>
      <div className="overflow-y-auto min-h-40" role="table" aria-label="Parameters">
        <div className="sticky top-0 z-[1] flex items-center gap-2 px-3 h-7 border-b border-line bg-bench text-2xs uppercase tracking-wide text-ink-3 mono" role="row">
          <span className="w-5" /><span className="w-44">Parameter</span><span className="flex-[2] min-w-0">Expression</span><span className="w-28 text-right">Value</span><span className="flex-[2] min-w-0 pl-1.5">Comment</span><span className="w-6" />
        </div>
        {groups.length ? groups.map((g) => (
          <section key={g.owner + g.ownerId} data-param-group={g.owner}>
            <button type="button" className="appearance-none border-0 m-0 w-full flex items-center gap-2 px-3 h-7 bg-paper text-left text-sm font-semibold text-ink [font-family:inherit] cursor-pointer hover:bg-sel-soft" disabled={!g.ownerId} title={g.ownerId ? "Select this feature in the list" : undefined} onClick={() => { if (g.ownerId) studio.selectFeature(g.ownerId); }}>
              {g.owner}{g.rows[0].suppressed ? <span className="pill">suppressed</span> : null}
            </button>
            {g.rows.map((r) => (
              <div key={r.key} role="row" className="flex items-center gap-2 px-3 min-h-8 border-b border-line" data-param-row={r.key} data-param-kind={r.kind} data-param-label={r.label} data-param-value={r.value === null ? "" : String(r.value)} data-param-text={r.text} data-param-favourite={r.favourite || undefined}>
                <button type="button" className={cx("appearance-none border-0 bg-transparent m-0 p-0 w-5 text-base leading-none cursor-pointer", r.favourite ? "text-[var(--mark)]" : "text-ink-3 hover:text-ink")} aria-pressed={r.favourite} aria-label={r.favourite ? "Remove the star" : "Star this parameter"} disabled={!canEdit} data-param-star onClick={() => commitNote(r.key, { favourite: !r.favourite })}>{r.favourite ? STAR : HOLLOW}</button>
                <span className="w-44 min-w-0" role="cell">
                  {r.kind === "variable"
                    ? <Cell value={r.label} mono disabled={!canEdit} attr={{ "data-param-name": r.label, "aria-label": "Variable name" }} onCommit={(name) => { const id = r.key.slice(2); const c = setVariable(studio.doc!, id, { name }); if (c.length) studio.commit(c); }} />
                    : <span className="block truncate px-1.5 text-ink-2" title={r.label}>{r.label}</span>}
                </span>
                <span className="flex-[2] min-w-0" role="cell">
                  <Cell value={r.text} mono disabled={!canEdit} attr={{ "data-param-expr": r.key, "aria-label": `Expression of ${r.owner} ${r.label}`, ...(errors[r.key] ? { "aria-invalid": "true" } : {}) }} onSame={() => say(r.key, null)} onCommit={(t) => { void applyParameter(studio, r.key, t).then((e) => say(r.key, e)); }} />
                  {errors[r.key] || r.error ? <span className="block px-1.5 pb-0.5 text-xs text-err" data-param-error>{errors[r.key] || r.error}</span> : null}
                </span>
                <span className={cx("w-28 text-right mono whitespace-nowrap", r.expression ? "text-ink" : "text-ink-3")} role="cell" data-param-shown>{valueText(r)}</span>
                <span className="flex-[2] min-w-0" role="cell"><Cell value={r.comment} disabled={!canEdit} placeholder="Add a comment" attr={{ "data-param-comment": r.key, "aria-label": `Comment on ${r.owner} ${r.label}` }} onCommit={(t) => commitNote(r.key, { comment: t })} /></span>
                <span className="w-6 text-right" role="cell">
                  {r.kind === "variable" ? <button type="button" className="btn sm ghost p-0 w-6 justify-center" aria-label={`Delete ${r.label}`} disabled={!canEdit} data-param-delete title={usersOf(studio.doc!, r.label).length ? `Used by ${usersOf(studio.doc!, r.label).length}: they keep their last value` : "Delete this variable"} onClick={() => { const c = deleteVariable(studio.doc!, r.key.slice(2)); if (c.length) studio.commit(c); }}>×</button> : null}
                </span>
              </div>
            ))}
          </section>
        )) : <p className="note px-3 py-2 m-0">{rows.length ? "Nothing matches." : "No parameters yet. Features and sketch dimensions appear here as you make them."}</p>}
      </div>
      <p className="note flex-none m-0 px-3 py-1.5 border-t border-line text-xs">An expression may use variables, arithmetic and units: <span className="mono">wall * 2 + 1 mm</span>, <span className="mono">3/8 in</span>. A bare number is in the document's unit ({units.length}).</p>
    </Sheet>
  );
}
