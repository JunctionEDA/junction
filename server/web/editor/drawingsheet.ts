// editor/drawingsheet.ts — the project's drawing sheet file (BASE_SCREEN::m_DrawingSheetFileName, saved in the
// .kicad_pro as schematic.page_layout_descr_file / pcbnew.page_layout_descr_file): which .kicad_wks of the project
// a document's page frame is drawn from.  An empty name (or one not in the project) is KiCad's built-in sheet.
import { E } from "./state";
import { state } from "./appstore";
import { requestRender } from "./view";

import { drawingSheetName, projectWorksheets as worksheetsOf, resolveWorksheet, type WksDocEntry } from "./drawingsheet-model";
export { drawingSheetName, resolveWorksheet, wksKey } from "./drawingsheet-model";
/** The open project's drawing sheet files. */
export const projectWorksheets = (): { docId: string; rel: string }[] => worksheetsOf((state as unknown as { docs?: WksDocEntry[] }).docs || []);

const cache = new Map<string, unknown>();
const loading = new Set<string>();
/** The parsed drawing sheet of a project document, fetched once (null while it loads). */
function sheetOf(docId: string): unknown {
  if (cache.has(docId)) return cache.get(docId);
  if (!loading.has(docId)) {
    loading.add(docId);
    fetch(`/api/docs/${docId}/content`).then((r) => (r.ok ? r.text() : "")).then((t) => {
      cache.set(docId, t ? KiCadCanvas.parseDrawingSheet(t) : null); loading.delete(docId);
      if (E.kdoc) { applyDrawingSheet(E.kdoc as KDoc & { drawingSheet?: unknown }); requestRender(); }
    }, () => { loading.delete(docId); cache.set(docId, null); });
  }
  return null;
}
/** Forget a sheet's text (the file changed). */
export function forgetWorksheet(docId?: string): void { if (docId) cache.delete(docId); else cache.clear(); }

/** Put the project's drawing sheet on a document (or KiCad's default when it names none, or it cannot be had). */
export function applyDrawingSheet(d: KDoc & { drawingSheet?: unknown }): void {
  const sch = d.type === "sch";
  const ws = resolveWorksheet(drawingSheetName(E.proSettings as string | null, sch), projectWorksheets());
  d.drawingSheet = ws ? sheetOf(ws.docId) : null;
}
/** The parsed sheet of a project worksheet when it has loaded (Page Settings' preview), loading it otherwise. */
export function worksheetNow(docId: string): unknown { return sheetOf(docId); }
