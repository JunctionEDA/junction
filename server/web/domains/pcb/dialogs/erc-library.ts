// dialogs/erc-library.ts — the library contents the browser's ERC reads before it checks, for ERC_TESTER's library
// tests (tools/sch-tools/erc-library.ts): every symbol's library symbol and every footprint the symbols name, through
// the project's and the global library tables (library/lib-lookup.ts), with LIB_SYMBOL::Compare under the schematic's
// Compare Symbol with Library settings (SCHEMATIC_SETTINGS::SymbolCompareFlags).
import { obj, projectDocs, projectJson } from "./project";
import { defaultSeverity } from "./erc-rules";
import { parityOf } from "./schematic-setup-logic";
import { compareSymbols } from "./diff-symbol-logic";
import { lookupLibraryItems, type LibraryLookup } from "../library/lib-lookup";

/** The ErcOpts.libraries of sch-tools' library tests. */
export interface ErcLibrariesOpt extends LibraryLookup { differs(lib: SNode, embedded: SNode): boolean; enabled(code: string): boolean }
interface SchLib { libraryWants?(docs: KDoc[]): { symbols: Set<string>; footprints: Set<string> } }
const sch = (): SchLib | null => ((window as unknown as { CollabTools?: { sch?: SchLib } }).CollabTools || {}).sch || null;

/** Why the library tests were not made in the last run ("" when they were). */
export let libraryFallback = "";

/** The libraries for a run over `docs` (each sheet once is enough), or null when they cannot be read just now. */
export async function ercLibraries(docs: KDoc[]): Promise<ErcLibrariesOpt | null> {
  const s = sch();
  if (!s || !s.libraryWants) { libraryFallback = "no library tests in this build"; return null; }
  const want = s.libraryWants(Array.from(new Set(docs)));
  const pro = projectJson(), sev = obj(obj(pro.erc).rule_severities) as Record<string, unknown>;
  const enabled = (code: string): boolean => (typeof sev[code] === "string" ? sev[code] : defaultSeverity(code)) !== "ignore";
  let lookup: LibraryLookup;
  try { lookup = await lookupLibraryItems(want, projectDocs() as unknown as { docId: string; path: string }[]); }
  catch (e) { libraryFallback = `the libraries could not be read (${String((e as Error).message || e).slice(0, 120)})`; return null; }
  libraryFallback = "";
  const parity = parityOf(obj(pro.schematic));
  // the flattened library symbol (this) against the schematic's copy, as TestLibSymbolIssues compares them
  return Object.assign(lookup, { differs: (lib: SNode, embedded: SNode) => compareSymbols(lib, embedded, parity, null).length > 0, enabled });
}
