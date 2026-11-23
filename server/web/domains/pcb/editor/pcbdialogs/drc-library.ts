// pcbdialogs/drc-library.ts — DRC_TEST_PROVIDER_LIBRARY_PARITY::Run in the browser's DRC: every board footprint
// against the footprint library table (library/lib-lookup.ts: the project's fp-lib-table, its own .pretty folders,
// the server's official libraries), then FOOTPRINT::FootprintNeedsUpdate( lib, COMPARE_FLAGS::DRC ) on the ones found.
// The libraries are read in one request; when they cannot be, the provider reports that it was skipped.
import { lookupLibraryItems } from "../../library/lib-lookup";
import { parseLibId } from "../../library/core";
import { unescapeText } from "../../canvas/text";

export interface ParityMarker { code: string; severity: string; x: number; y: number; text: string; ids: string[]; message: true }

/** The markers of the library parity provider for `doc`; `severity` is each code's severity ("ignore" turns a test
 *  off), `diff` FootprintNeedsUpdate's lines with the DRC flags. */
export async function libraryParityMarkers(doc: KDoc, docs: { docId: string; path: string }[], severity: (code: string) => string,
  diff: (boardFp: SNode, libFp: SNode, drc: boolean) => string[]): Promise<{ markers: ParityMarker[]; skipped: string }> {
  const issues = severity("lib_footprint_issues"), mismatch = severity("lib_footprint_mismatch");
  if (issues === "ignore" && mismatch === "ignore") return { markers: [], skipped: "" };
  const fps: KItem[] = []; for (const it of doc.items.values()) if (it.kind === "footprint") fps.push(it);
  // a footprint without a library nickname: not much can be done
  const ids = fps.map((it) => String(it.node[1] || "")).filter((id) => parseLibId(id).lib);
  let look;
  try { look = await lookupLibraryItems({ symbols: [], footprints: ids }, docs); }
  catch (e) { return { markers: [], skipped: `the footprint libraries could not be read (${String((e as Error).message || e).slice(0, 120)})` }; }
  const out: ParityMarker[] = [];
  for (const it of fps) {
    const id = String(it.node[1] || ""), { lib, name } = parseLibId(id); if (!lib) continue;
    const e = look.footprints.get(id); if (!e) continue;
    // FOOTPRINT::GetCenter: the middle of its bounding box
    const b = it.bbox, x = b ? (b[0] + b[2]) / 2 : it.x || 0, y = b ? (b[1] + b[3]) / 2 : it.y || 0;
    const push = (code: string, sev: string, text: string): void => { if (sev !== "ignore") out.push({ code, severity: sev, x, y, text, ids: [it.id], message: true }); };
    if (e.state === "missing") push("lib_footprint_issues", issues, `The current configuration does not include the footprint library '${unescapeText(lib)}'`);
    else if (e.state === "disabled") push("lib_footprint_issues", issues, `The footprint library '${unescapeText(lib)}' is not enabled in the current configuration`);
    else if (e.state === "not_loaded") push("lib_footprint_issues", issues, `The footprint library '${unescapeText(lib)}' was not found at '${e.uri}'`);
    else if (!e.footprint) push("lib_footprint_issues", issues, `Footprint '${name}' not found in library '${lib}'`);
    else if (mismatch !== "ignore" && diff(it.node, e.footprint, true).length) push("lib_footprint_mismatch", mismatch, `Footprint '${name}' does not match copy in library '${lib}'`);
  }
  return { markers: out, skipped: "" };
}
