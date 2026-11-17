// Toolbar.tsx — the part studio's toolbar, drawn from the registries: one button per feature type
// (features/*.ts) and one per tool (tools/*.ts), in the tool groups' order.  Nothing is listed here by hand.
import { TOOL_GROUPS, type ToolDefinition } from "../core/tool";
import { cx } from "../../../shared/util";
import { Glyph } from "./Glyph";
import { useStudio } from "./hooks";
import type { PartStudio } from "./studio";

function Button({ title, hint, icon, label, on, why, run }: { title: string; hint?: string; icon?: string; label?: boolean; on?: boolean; why?: string | null; run(): void }) {
  return (
    <button type="button" className={cx("btn sm ghost cad-tb flex items-center gap-1.5 px-1.5", on && "on", why && "opacity-45")} aria-pressed={on || undefined} aria-disabled={why ? true : undefined}
      title={why ? `${title}: ${why}` : hint ? `${title}\n${hint}` : title} data-tool={title} onClick={() => { if (!why) run(); }}>
      <Glyph svg={icon} />{label === false ? null : <span>{title}</span>}
    </button>
  );
}

export function Toolbar({ studio }: { studio: PartStudio }) {
  // every slice a button's `disabled` / `active` may read: the toolbar redraws when one changes
  const sketch = useStudio(studio, (s) => s.sketch);
  const canEdit = useStudio(studio, (s) => s.canEdit);
  const editing = useStudio(studio, (s) => !!s.editing);
  useStudio(studio, (s) => s.selection); useStudio(studio, (s) => s.selectedFeature);
  useStudio(studio, (s) => s.canUndo); useStudio(studio, (s) => s.canRedo); useStudio(studio, (s) => s.planesVisible);

  const features = studio.definitions().filter((f) => f.toolbar !== false).slice().sort((a, b) => (a.toolbarOrder ?? 1e6) - (b.toolbarOrder ?? 1e6) || a.title.localeCompare(b.title));
  const tools = (group: string): ToolDefinition[] => studio.tools().filter((t) => t.group === group && t.button !== false).slice().sort((a, b) => (a.order ?? 1e6) - (b.order ?? 1e6) || a.title.localeCompare(b.title));
  const groups: JSX.Element[] = [];
  for (const g of TOOL_GROUPS) {
    if (g === "sketch" && !sketch) continue;
    const buttons: JSX.Element[] = [];
    if (g === "feature" && !sketch) {
      for (const f of features) buttons.push(<Button key={"f:" + f.type} title={f.title} icon={f.icon} why={canEdit ? (editing ? "Finish the open dialog first" : null) : "View-only access"} run={() => studio.startFeature(f.type)} />);
    }
    for (const t of tools(g)) {
      if (g === "feature" && sketch) continue;
      buttons.push(<Button key={t.id} title={t.title} hint={t.hint} icon={t.icon} label={g !== "edit"} on={t.active ? t.active(studio) : false} why={t.disabled ? t.disabled(studio) : null} run={() => { t.run(studio); studio.viewport.canvas.focus(); }} />);
    }
    if (buttons.length) groups.push(<div key={g} className="flex items-center gap-0.5 px-1.5 border-r border-line last:border-r-0" data-group={g}>{buttons}</div>);
  }
  return <div className="cad-toolbar flex items-center h-9 bg-bench border-b border-line overflow-x-auto select-none" role="toolbar" aria-label="Part studio tools">{groups}</div>;
}
