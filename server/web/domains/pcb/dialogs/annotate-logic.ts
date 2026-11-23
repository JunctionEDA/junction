// dialogs/annotate-logic.ts — the Annotate dialog's sheet walk (Recurse into subsheets), kept free of the editor.

/** The sheet files a sheet's (sheet …) items name (Sheetfile), as project paths next to the sheet that holds them. */
export function subsheetFiles(doc: KDoc, dir: string, only?: Set<string> | null): string[] {
  const out: string[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "sheet" || (only && !only.has(it.id))) continue;
    const p = (it.node as SNode[]).find((c) => Array.isArray(c) && c[0] === "property" && (c[1] === "Sheetfile" || c[1] === "Sheet file"));
    const f = p ? String(p[2]) : ""; if (!f) continue;
    const parts = (dir ? dir + "/" + f : f).split("/"), norm: string[] = [];
    for (const x of parts) { if (x === "..") norm.pop(); else if (x && x !== ".") norm.push(x); }
    out.push(norm.join("/"));
  }
  return out;
}


/** SCHEMATIC_SETTINGS m_AnnotateSortOrder / m_AnnotateMethod / m_AnnotateStartNum as the .kicad_pro keeps them. */
export interface AnnotateProjectSettings { sortY: boolean; method: 0 | 1 | 2; startNum: number }
type ProSch = { annotation?: { sort_order?: unknown; method?: unknown } | null; annotate_start_num?: unknown };
/** DIALOG_ANNOTATE::TransferDataToWindow's project half (anything else is the default: by X, first free, 0). */
export function annotateSettingsFromProject(sch: ProSch): AnnotateProjectSettings {
  const a = sch && sch.annotation && typeof sch.annotation === "object" ? sch.annotation : {};
  const m = a.method === 1 || a.method === 2 ? a.method : 0;
  return { sortY: a.sort_order === 1, method: m as 0 | 1 | 2, startNum: sch && typeof sch.annotate_start_num === "number" && sch.annotate_start_num >= 0 ? Math.floor(sch.annotate_start_num) : 0 };
}
/** ~DIALOG_ANNOTATE: the keys whose value differs from the project's ("modified"), or null when none does. */
export function annotateProjectChanges(sch: ProSch, now: AnnotateProjectSettings): { sort_order?: number; method?: number; annotate_start_num?: number } | null {
  const was = annotateSettingsFromProject(sch), out: { sort_order?: number; method?: number; annotate_start_num?: number } = {};
  if (was.sortY !== now.sortY) out.sort_order = now.sortY ? 1 : 0;
  if (was.method !== now.method) out.method = now.method;
  if (was.startNum !== now.startNum) out.annotate_start_num = now.startNum;
  return Object.keys(out).length ? out : null;
}

/**
 * SCHEMATIC_SETTINGS::m_refDesTracker as the project file keeps it (used_designators): the string to write when the
 * designators handed out since (placing, pasting, repeating) are not all in it yet, else null.  KiCad writes the
 * tracker with the project settings; the web project has no Save, so the tracker goes in as soon as it grows.
 */
export function trackerToStore(stored: string, live: Iterable<string>, ser: (used: Iterable<string>) => string, deser: (data: string) => Set<string>): string | null {
  const used = deser(stored); let grew = false;
  for (const d of live) if (d && !used.has(d)) { used.add(d); grew = true; }
  return grew ? ser(used) : null;
}
