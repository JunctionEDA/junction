// MateList.tsx — "Mate features (n)": the mates with their state (the value a mate has now, a conflict or a lost
// reference in red with the reason, suppressed), then the relations between them, the rigid groups, the instance
// patterns and the explicit mate connectors.  A click selects a row and lights up its instances in the model; a
// double click edits; a right click offers the rest.  Below it, when there are any: the named positions and the
// saved exploded views.
import { useState } from "react";
import { cx } from "../../../shared/util";
import type { MateItem } from "../document/format";
import type { MateInfo } from "../model/problem";
import { relationDef } from "../model/relations";
import { openAnimate } from "../panels/animate";
import { mateDef, type AssemblyEditor } from "./assembly";
import { askEditPattern, askRelation } from "./forms";
import { NameField } from "./InstanceList";
import { getPrefs, setPrefs, usePref } from "./keys";
import { Caption, ContextMenu, Glyph, ICONS, useAssembly, type MenuState } from "./parts";

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

function valueText(m: MateItem, info: MateInfo | undefined): string {
  const values = mateDef(m.mateType)?.solve?.values;
  // a mate with one or two values shows them; with more (Planar) the row would be all numbers
  if (!info || !values || values.length > 2 || info.state !== "ok") return "";
  return values.map((v) => (v.unit === "deg" ? `${round(info.values[v.key] ?? 0, 1)}°` : `${round(info.values[v.key] ?? 0, 2)} mm`)).join("  ");
}

/** A section of the dock that folds: its heading with a count, remembered folded or open in this browser. */
function Fold({ id, title, count, right, children, grow }: { id: string; title: string; count: number; right?: React.ReactNode; children: React.ReactNode; grow?: boolean }) {
  const folded = !!usePref("folded")[id];
  return (
    <section className={cx("flex flex-col min-h-0 border-b border-line last:border-b-0", folded ? "flex-none" : grow ? "flex-[1_1_0]" : "flex-[0_1_auto] max-h-[30%]")} data-panel={id} data-folded={folded || undefined}>
      <Caption right={right}>
        <button type="button" className="appearance-none bg-transparent border-0 p-0 m-0 text-inherit [font:inherit] flex items-center gap-1 cursor-pointer" aria-expanded={!folded} onClick={() => setPrefs({ folded: { ...getPrefs().folded, [id]: !folded } })}>
          <span className={cx("flex transition-transform", !folded && "rotate-90")}><Glyph svg={ICONS.chevron} size={12} /></span>{title} <span className="font-normal text-ink-3" data-count>({count})</span>
        </button>
      </Caption>
      {folded ? null : children}
    </section>
  );
}

const ROW = "flex items-center gap-1.5 h-6.5 px-2 cursor-default";

export function MateList({ assembly }: { assembly: AssemblyEditor }) {
  const s = useAssembly(assembly, (x) => x);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const selected = new Set(s.selection);
  const ro = !s.canEdit;
  const troubled = (info: MateInfo | undefined) => !!info && (info.state === "conflict" || info.state === "error");
  const bad = s.mates.filter((m) => troubled(s.mateInfo[m.id])).length + s.relations.filter((r) => troubled(s.relationInfo[r.id])).length;
  const name = (id: string, text: string, strike = false) => (s.renaming === id ? <NameField name={text} done={(n) => (n === null ? assembly.startRename(null) : assembly.rename(id, n))} /> : <span className={cx("flex-1 truncate", strike && "line-through")}>{text}</span>);
  const rename = (id: string) => () => { if (!ro) assembly.startRename(id); };
  const at = (ev: React.MouseEvent) => ({ x: ev.clientX, y: ev.clientY });
  const openMenu = (m: MateItem, ev: React.MouseEvent) => {
    ev.preventDefault();
    if (!selected.has(m.id)) assembly.select(m.id);
    const ids = selected.has(m.id) ? s.selection.filter((x) => s.mates.some((y) => y.id === x)) : [m.id];
    const drivable = !!mateDef(m.mateType)?.solve?.values?.length && s.mateInfo[m.id]?.state === "ok";
    setMenu({ ...at(ev), items: [
      { label: "Edit…", run: () => assembly.editMate(m.id), disabled: ro },
      { label: "Rename", run: () => assembly.startRename(m.id), disabled: ro },
      { label: m.suppressed ? "Unsuppress" : "Suppress", run: () => assembly.setMateSuppressed(ids, !m.suppressed), disabled: ro },
      { label: "Animate", run: () => openAnimate(assembly, m.id), disabled: !drivable },
      { label: "Select its instances", run: () => assembly.select([m.a.instance, m.b.instance]) },
      { label: "Delete", run: () => assembly.remove(ids), danger: true, disabled: ro, rule: true },
    ] });
  };
  const count = s.mates.length + s.relations.length + s.rigids.length + s.patterns.length + s.connectors.length;
  return (
    <>
      <Fold id="mates" title="Mate features" count={count} grow right={bad ? <span className="font-normal text-err text-xs" data-conflicts>{bad} with a problem</span> : null}>
        <div className="flex-1 min-h-0 overflow-y-auto bg-paper py-1 text-sm outline-none" role="listbox" tabIndex={0} aria-label="Mate features" onClick={(ev) => { if (ev.target === ev.currentTarget) assembly.select(null); }}>
          {s.mates.map((m) => {
            const def = mateDef(m.mateType), info = s.mateInfo[m.id], st = info?.state, problem = troubled(info);
            return (
              <div key={m.id} role="option" aria-selected={selected.has(m.id)} data-mate={m.name} data-state={st} title={info?.message || def?.title || m.mateType}
                className={cx(ROW, selected.has(m.id) ? "bg-sel" : "hover:bg-sel-soft", (m.suppressed || st === "inactive") && "text-ink-3", problem && "text-err")}
                onClick={(ev) => assembly.select(m.id, { toggle: ev.ctrlKey || ev.metaKey })} onDoubleClick={() => assembly.editMate(m.id)} onContextMenu={(ev) => openMenu(m, ev)}>
                <Glyph svg={def?.icon} size={15} />
                {name(m.id, m.name, !!m.suppressed)}
                <span className="flex-none text-xs font-mono text-ink-3" data-value>{valueText(m, info)}</span>
                {problem ? <span className="flex-none text-xs font-semibold" data-problem>{st === "conflict" ? "conflict" : "!"}</span> : null}
                {st === "unknown-type" || st === "inactive" || st === "pending" ? <span className="flex-none text-xs text-ink-3">{st === "pending" ? "…" : st === "inactive" ? "off" : "?"}</span> : null}
              </div>
            );
          })}
          {s.relations.map((r) => {
            const def = relationDef(r.relationType), info = s.relationInfo[r.id], st = info?.state, problem = troubled(info);
            return (
              <div key={r.id} role="option" aria-selected={selected.has(r.id)} data-relation={r.name} data-state={st} title={info?.message || def?.hint || r.relationType}
                className={cx(ROW, selected.has(r.id) ? "bg-sel" : "hover:bg-sel-soft", (r.suppressed || st === "inactive") && "text-ink-3", problem && "text-err")}
                onClick={() => assembly.select(r.id)} onDoubleClick={() => { if (!ro) askRelation(assembly, r.relationType, r); }}
                onContextMenu={(ev) => { ev.preventDefault(); assembly.select(r.id); setMenu({ ...at(ev), items: [
                  { label: "Edit…", run: () => askRelation(assembly, r.relationType, r), disabled: ro || !def },
                  { label: "Rename", run: () => assembly.startRename(r.id), disabled: ro },
                  { label: r.suppressed ? "Unsuppress" : "Suppress", run: () => assembly.setMateSuppressed([r.id], !r.suppressed), disabled: ro },
                  { label: "Delete", run: () => assembly.remove([r.id]), danger: true, disabled: ro, rule: true },
                ] }); }}>
                <Glyph svg={def?.icon} size={15} />
                {name(r.id, r.name, !!r.suppressed)}
                <span className="flex-none text-xs text-ink-3 truncate max-w-[50%]" data-value>{def ? def.describe(r.params || {}) : ""}</span>
                {problem ? <span className="flex-none text-xs font-semibold" data-problem>{st === "conflict" ? "conflict" : "!"}</span> : null}
              </div>
            );
          })}
          {s.rigids.map((g) => (
            <div key={g.id} role="option" aria-selected={selected.has(g.id)} data-rigid={g.name} title="A group: these instances keep their places relative to one another and move as one."
              className={cx(ROW, selected.has(g.id) ? "bg-sel" : "hover:bg-sel-soft", g.suppressed && "text-ink-3")} onClick={() => assembly.select(g.id)} onDoubleClick={rename(g.id)}
              onContextMenu={(ev) => { ev.preventDefault(); assembly.select(g.id); setMenu({ ...at(ev), items: [
                { label: "Rename", run: () => assembly.startRename(g.id), disabled: ro },
                { label: "Select its instances", run: () => assembly.select(g.instances) },
                { label: g.suppressed ? "Unsuppress" : "Suppress", run: () => assembly.setMateSuppressed([g.id], !g.suppressed), disabled: ro },
                { label: "Ungroup", run: () => assembly.remove([g.id]), danger: true, disabled: ro, rule: true },
              ] }); }}>
              <Glyph svg={ICONS.rigid} size={15} />
              {name(g.id, g.name, !!g.suppressed)}
              <span className="flex-none text-xs text-ink-3">{g.instances.filter((id) => s.instances.some((i) => i.id === id)).length} instances</span>
            </div>
          ))}
          {s.patterns.map((p) => (
            <div key={p.id} role="option" aria-selected={selected.has(p.id)} data-pattern-row={p.name} title="An instance pattern: its copies go where their seed goes."
              className={cx(ROW, selected.has(p.id) ? "bg-sel" : "hover:bg-sel-soft", p.suppressed && "text-ink-3")} onClick={() => assembly.select(p.id)} onDoubleClick={() => { if (!ro) askEditPattern(assembly, p); }}
              onContextMenu={(ev) => { ev.preventDefault(); assembly.select(p.id); setMenu({ ...at(ev), items: [
                { label: "Edit…", run: () => askEditPattern(assembly, p), disabled: ro },
                { label: "Rename", run: () => assembly.startRename(p.id), disabled: ro },
                { label: "Dissolve", run: () => assembly.dissolvePattern(p.id), disabled: ro },
                { label: "Delete", run: () => assembly.remove([p.id]), danger: true, disabled: ro, rule: true },
              ] }); }}>
              <Glyph svg={ICONS.pattern} size={15} />
              {name(p.id, p.name, !!p.suppressed)}
              <span className="flex-none text-xs text-ink-3">{p.patternType === "linear" ? `${p.count} × ${round(p.spacing || 0, 2)} mm` : `${p.count} × ${round(p.angle || 0, 2)}°`}</span>
            </div>
          ))}
          {s.connectors.map((c) => {
            const owner = s.instances.find((i) => i.id === c.instance), o = c.offset || [0, 0, 0];
            return (
              <div key={c.id} role="option" aria-selected={selected.has(c.id)} data-connector-row={c.name} className={cx(ROW, selected.has(c.id) ? "bg-sel" : "hover:bg-sel-soft")}
                title="An explicit mate connector: click its mark in the model when making a mate" onClick={() => assembly.select(c.id)} onDoubleClick={rename(c.id)}
                onContextMenu={(ev) => { ev.preventDefault(); assembly.select(c.id); setMenu({ ...at(ev), items: [
                  { label: "Move or turn…", disabled: ro, run: () => assembly.ask({ title: c.name, fields: [{ key: "x", label: "Along X", kind: "number", value: o[0], unit: "mm" }, { key: "y", label: "Along Y", kind: "number", value: o[1], unit: "mm" }, { key: "z", label: "Along its axis", kind: "number", value: o[2], unit: "mm" }, { key: "r", label: "Turn", kind: "number", value: c.rotation || 0, unit: "°" }], accept: (v) => assembly.editConnector(c.id, { offset: [Number(v.x), Number(v.y), Number(v.z)], rotation: Number(v.r) }) }) },
                  { label: c.flip ? "Unflip" : "Flip", disabled: ro, run: () => assembly.editConnector(c.id, { flip: !c.flip }) },
                  { label: "Rename", disabled: ro, run: () => assembly.startRename(c.id) },
                  { label: "Delete", danger: true, disabled: ro, run: () => assembly.remove([c.id]), rule: true },
                ] }); }}>
                <Glyph svg={ICONS.connector} size={15} />
                {name(c.id, c.name)}
                <span className="flex-none text-xs text-ink-3 truncate max-w-[45%]">{owner ? owner.name : "?"}</span>
              </div>
            );
          })}
          {s.loaded && !count ? <p className="note px-2 m-0">No mates yet. Choose a mate in the toolbar, then click a connector on each of two instances.</p> : null}
        </div>
      </Fold>
      {s.positions.length ? (
        <Fold id="positions" title="Named positions" count={s.positions.length}>
          <div className="min-h-0 overflow-y-auto bg-paper py-1 text-sm" role="listbox" aria-label="Named positions">
            {s.positions.map((p) => (
              <div key={p.id} role="option" aria-selected={selected.has(p.id)} data-position={p.name} className={cx(ROW, selected.has(p.id) ? "bg-sel" : "hover:bg-sel-soft")}
                title="Click to move the instances to this position" onClick={() => assembly.applyPosition(p.id)} onDoubleClick={rename(p.id)}
                onContextMenu={(ev) => { ev.preventDefault(); setMenu({ ...at(ev), items: [{ label: "Go to this position", run: () => assembly.applyPosition(p.id), disabled: ro }, { label: "Rename", run: () => assembly.startRename(p.id), disabled: ro }, { label: "Delete", run: () => assembly.remove([p.id]), danger: true, disabled: ro, rule: true }] }); }}>
                <Glyph svg={ICONS.bookmark} size={14} />
                {name(p.id, p.name)}
              </div>
            ))}
          </div>
        </Fold>
      ) : null}
      {s.explodes.length ? (
        <Fold id="explodes" title="Exploded views" count={s.explodes.length}>
          <div className="min-h-0 overflow-y-auto bg-paper py-1 text-sm" role="listbox" aria-label="Exploded views">
            {s.explodes.map((e) => (
              <div key={e.id} role="option" aria-selected={s.explodeView === e.id} data-explode-row={e.name} className={cx(ROW, s.explodeView === e.id ? "bg-sel" : "hover:bg-sel-soft")}
                title="Click to show this exploded view; again to put the assembly back together" onClick={() => (s.explodeView === e.id ? assembly.setExploding(false) : assembly.openExplode(e.id))} onDoubleClick={rename(e.id)}
                onContextMenu={(ev) => { ev.preventDefault(); setMenu({ ...at(ev), items: [{ label: "Show", run: () => assembly.openExplode(e.id) }, { label: "Rename", run: () => assembly.startRename(e.id), disabled: ro }, { label: "Delete", run: () => assembly.remove([e.id]), danger: true, disabled: ro, rule: true }] }); }}>
                <Glyph svg={ICONS.explode} size={14} />
                {name(e.id, e.name)}
                <span className="flex-none text-xs text-ink-3">{Object.keys(e.offsets).length} moved</span>
              </div>
            ))}
          </div>
        </Fold>
      ) : null}
      <ContextMenu menu={menu} close={() => setMenu(null)} />
    </>
  );
}
