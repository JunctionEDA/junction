// tools/sch-tools/erc-library.ts — the ERC_TESTER tests that compare the schematic with its libraries
// (eeschema/erc/erc.cpp): TestLibSymbolIssues (lib_symbol_issues, lib_symbol_mismatch), TestPinMap (pin_map_stale_pin,
// pin_map_duplicate_pad, pin_map_bad_pad, pin_map_unmapped_pin) and TestFootprintLinkIssues (footprint_link_issues).
// The library contents come with the run (ErcOpts.libraries): the ERC dialog reads them before it checks
// (library/lib-lookup.ts), as KiCad's adapters have them loaded.  Without them these tests do not run.
import type { Pt, ErcMarker } from "./types";
import { type SymPin, symbolLibId, symbolPins } from "./autoplace";
import { danglingEnds } from "./dangling";
import { K, atOf, kid, kids, str } from "./state";
import { r4 } from "./util";
import { unescapeText } from "../../canvas/text";
import { expandStacked } from "../../canvas/stacked-pins";
import { effectivePadNumber, hasIdentityPad, pinMapOverrideOf, type PadResolution } from "../../canvas/variant-model";
import type { ErcItemRef, ErcTerm } from "./erc";

/** One library item as the configuration has it (library/lib-lookup.ts LibState). */
export interface ErcLibItem { state: "ok" | "missing" | "disabled" | "not_loaded"; uri: string; library: string; name: string }
export interface ErcLibraries {
  /** lib id -> the library symbol (flattened, embedded under the lib id) or null when the library has none */
  symbols: Map<string, ErcLibItem & { symbol: SNode | null }>;
  /** FPID -> the library footprint or null */
  footprints: Map<string, ErcLibItem & { footprint: SNode | null }>;
  /** LIB_SYMBOL::Compare( embedded, SCHEMATIC_SETTINGS::SymbolCompareFlags() ) != 0 */
  differs(lib: SNode, embedded: SNode): boolean;
  /** ERC_SETTINGS::IsTestEnabled */
  enabled(code: string): boolean;
}
export interface ErcLibInstance { doc: KDoc }

const fieldText = (n: SNode, name: string): string => { const p = kids(n, "property").find((q) => str(q[1]) === name); return p ? str(p[2]) : ""; };
const flagOn = (n: SNode | null, key: string): boolean => { const k = n && kid(n, key); return !!k && (k.length < 2 || str(k[1]) !== "no"); };

/** Every pin of a library symbol with its unit and body style (GetGraphicalPins( 0, 0 )). */
function libPins(lib: SNode): { number: string; unit: number; body: number; node: SNode }[] {
  const out: { number: string; unit: number; body: number; node: SNode }[] = [];
  for (const sub of kids(lib, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(str(sub[1]));
    for (const p of kids(sub, "pin")) { const n = kid(p, "number"); out.push({ number: n ? str(n[1]) : "", unit: m ? +m[1] : 0, body: m ? +m[2] : 0, node: p }); }
  }
  return out;
}

/** CheckDuplicatePins( embedded ) found something: two pins (or stacked pin numbers) of one number in a body style. */
export function hasDuplicatePins(lib: SNode): boolean {
  const logical: { pin: number; number: string; unit: number; body: number }[] = [];
  libPins(lib).forEach((p, i) => { const e = expandStacked(p.number); if (!e.valid || !e.pins.length) logical.push({ pin: i, number: p.number, unit: p.unit, body: p.body }); else for (const n of e.pins) logical.push({ pin: i, number: n, unit: p.unit, body: p.body }); });
  logical.sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0) || a.body - b.body || a.unit - b.unit || a.pin - b.pin);
  for (let i = 1; i < logical.length; i++) {
    const prev = logical[i - 1], next = logical[i];
    if (prev.number !== next.number || prev.pin === next.pin) continue;
    // pins are not duplicated only when they are in different body styles
    if (prev.body !== 0 && next.body !== 0 && prev.body !== next.body) continue;
    return true;
  }
  return false;
}

interface PinMapDef { name: string; entries: [string, string][] }
/** LIB_SYMBOL::GetEffectivePinMaps / GetEffectiveAssociatedFootprints / JumperPinGroups of the embedded symbol. */
function pinMapFacts(lib: SNode): { maps: PinMapDef[]; footprints: { footprint: string; map: string }[]; jumpers: string[][] } {
  const pm = kid(lib, "pin_maps"), af = kid(lib, "associated_footprints"), jg = kid(lib, "jumper_pin_groups");
  return {
    maps: pm ? kids(pm, "pin_map").map((m) => ({ name: str(m[1]), entries: kids(m, "entry").map((e) => [str(e[1]), str(e[2])] as [string, string]) })) : [],
    footprints: af ? kids(af, "footprint").map((f) => { const m = kid(f, "map"); return { footprint: str(f[1]), map: m ? str(m[1]) : "" }; }) : [],
    jumpers: jg ? (jg.slice(1).filter(Array.isArray) as SNode[]).map((g) => g.map(str)) : [],
  };
}

export { hasIdentityPad };
/** SCH_PIN::GetEffectivePadNumber with the footprint's pads (canvas/variant-model.ts): the pad and whether the pin is
 *  MAPPED, IDENTITY or UNMAPPED under the symbol's own (pin_map_override …). */
export function effectivePad(lib: SNode, inst: SNode, footprintId: string, pinNumber: string, pads: Set<string>): { pad: string; state: PadResolution } {
  return effectivePadNumber(lib, pinMapOverrideOf(inst), footprintId, pinNumber, pads);
}

/**
 * The library tests over every sheet instance (`insts`, the hierarchy in order).  A marker of a shared screen (the
 * pin map tests, which look only at library data) goes to the first instance of that sheet, as
 * SHEETLIST_ERC_ITEMS_PROVIDER lists a marker that is not sheet specific once; the others belong to their instance.
 */
export function libraryTests(insts: ErcLibInstance[], lib: ErcLibraries, itemRef: (doc: KDoc, it: KItem) => ErcItemRef, pinRef: (t: ErcTerm & { pin: SymPin }) => ErcItemRef): ErcMarker[][] {
  const out: ErcMarker[][] = insts.map(() => []);
  const mark = (i: number, code: string, p: Pt, text: string, it: KItem, ref: ErcItemRef): void => { out[i].push({ code, severity: "warning", x: r4(p[0]), y: r4(p[1]), text, ids: [it.id], items: [Object.assign(ref, { sheet: i })] } as ErcMarker); };
  const on = (code: string): boolean => lib.enabled(code);
  const fpPads = (id: string): Set<string> | null => {
    const f = lib.footprints.get(id); if (!f || !f.footprint) return null;
    const s = new Set<string>(); for (const p of kids(f.footprint, "pad")) { const n = str(p[1]); if (n) s.add(n); } return s;
  };

  // ---- TestPinMap: one pass per screen (the pin maps are library-symbol properties)
  if (on("pin_map_stale_pin") || on("pin_map_duplicate_pad") || on("pin_map_bad_pad") || on("pin_map_unmapped_pin")) {
    const seen = new Set<KDoc>();
    insts.forEach((s, i) => {
      if (seen.has(s.doc)) return; seen.add(s.doc);
      for (const it of s.doc.items.values()) {
        if (it.kind !== "symbol") continue;
        const ls = K.resolveLib(s.doc, str((kid(it.node, "lib_name") || kid(it.node, "lib_id") || [])[1])) || K.resolveLib(s.doc, symbolLibId(it.node)); if (!ls) continue;
        const f = pinMapFacts(ls); if (!f.maps.length && !f.footprints.length) continue;
        const pins = new Set(libPins(ls).map((p) => p.number)), at = atOf(it.node);
        const sharesJumper = (a: string, b: string): boolean => f.jumpers.some((g) => g.includes(a) && g.includes(b));
        for (const map of f.maps) {
          if (on("pin_map_stale_pin")) for (const [pin] of map.entries) if (!pins.has(pin)) mark(i, "pin_map_stale_pin", at, `Pin map '${map.name}' references unknown symbol pin '${pin}'`, it, itemRef(s.doc, it));
          // a single pin stacked across several pads is allowed; two pins on one pad is not
          if (on("pin_map_duplicate_pad")) {
            const padToPin = new Map<string, string>();
            for (const pin of Array.from(pins).sort()) if (!map.entries.some((e) => e[0] === pin)) padToPin.set(pin, pin);
            for (const [pin, padText] of map.entries) for (const pad of expandStacked(padText).pins) {
              const had = padToPin.get(pad);
              if (had === undefined) padToPin.set(pad, pin);
              else if (had !== pin && !sharesJumper(had, pin)) mark(i, "pin_map_duplicate_pad", at, `Symbol pins '${had}' and '${pin}' both map to pad '${pad}'`, it, itemRef(s.doc, it));
            }
          }
        }
        if (on("pin_map_bad_pad")) for (const assoc of f.footprints) {
          const bound = f.maps.find((m) => m.name === assoc.map); if (!bound) continue;
          const pads = fpPads(assoc.footprint); if (!pads || !pads.size) continue;
          for (const [, padText] of bound.entries) for (const pad of expandStacked(padText).pins)
            if (!pads.has(pad)) mark(i, "pin_map_bad_pad", at, `Pin map '${bound.name}' references pad '${pad}' not present on footprint '${assoc.footprint}'`, it, itemRef(s.doc, it));
        }
      }
    });
    // pins that are connected and that the footprint has no pad for, on each sheet instance
    if (on("pin_map_unmapped_pin")) insts.forEach((s, i) => {
      const dangling = danglingEnds(s.doc).filter((d) => d.what === "pin");
      for (const it of s.doc.items.values()) {
        if (it.kind !== "symbol") continue;
        const ls = K.resolveLib(s.doc, str((kid(it.node, "lib_name") || kid(it.node, "lib_id") || [])[1])) || K.resolveLib(s.doc, symbolLibId(it.node));
        if (!ls || !pinMapFacts(ls).footprints.length) continue;
        const fp = fieldText(it.node, "Footprint"); if (!fp) continue;
        const pads = fpPads(fp); if (!pads || !pads.size) continue;
        for (const q of symbolPins(s.doc, it)) {
          if (dangling.some((d) => d.item === it && Math.abs(d.p[0] - q.x) < 1e-6 && Math.abs(d.p[1] - q.y) < 1e-6)) continue;
          if (effectivePad(ls, it.node, fp, q.number, pads).state !== "unmapped") continue;
          const term = { item: it, p: [q.x, q.y] as Pt, net: "wire", pin: q } as unknown as ErcTerm & { pin: SymPin };
          mark(i, "pin_map_unmapped_pin", [q.x, q.y], `Pin '${q.number}' is connected but maps to no pad on footprint '${fp}'`, it, pinRef(term));
        }
      }
    });
  }

  // ---- TestLibSymbolIssues: one lookup per screen and symbol, a marker on every instance
  if (on("lib_symbol_issues") || on("lib_symbol_mismatch")) {
    const results = new Map<string, { code: string; text: string }[]>();
    insts.forEach((s, i) => {
      for (const it of s.doc.items.values()) {
        if (it.kind !== "symbol") continue;
        const embedded = K.resolveLib(s.doc, str((kid(it.node, "lib_name") || kid(it.node, "lib_id") || [])[1])) || K.resolveLib(s.doc, symbolLibId(it.node));
        if (!embedded) continue;
        const key = insts.findIndex((x) => x.doc === s.doc) + "|" + it.id;
        let issues = results.get(key);
        if (!issues) {
          issues = [];
          const e = lib.symbols.get(symbolLibId(it.node));
          if (e) {
            const libName = unescapeText(e.library), symName = unescapeText(e.name);
            if (e.state === "missing" || e.state === "disabled") { if (on("lib_symbol_issues")) issues.push({ code: "lib_symbol_issues", text: `The current configuration does not include the symbol library '${libName}'` }); }
            else if (e.state === "not_loaded") { if (on("lib_symbol_issues")) issues.push({ code: "lib_symbol_issues", text: `The symbol library '${libName}' was not found at '${e.uri}'` }); }
            else if (!e.symbol) { if (on("lib_symbol_issues")) issues.push({ code: "lib_symbol_issues", text: `Symbol '${symName}' not found in symbol library '${libName}'` }); }
            else if (on("lib_symbol_mismatch")) {
              // duplicate pins can be valid on the same net; TestDuplicatePinNets checks their nets
              const dup = !flagOn(embedded, "duplicate_pin_numbers_are_jumpers") && hasDuplicatePins(embedded);
              if (!dup && lib.differs(e.symbol, embedded)) issues.push({ code: "lib_symbol_mismatch", text: `Symbol '${symName}' doesn't match copy in library '${libName}'` });
            }
          }
          results.set(key, issues);
        }
        for (const x of issues) mark(i, x.code, atOf(it.node), x.text, it, itemRef(s.doc, it));
      }
    });
  }

  // ---- TestFootprintLinkIssues: every symbol's footprint against the footprint library table (cvpcb testFootprintLink)
  if (on("footprint_link_issues")) insts.forEach((s, i) => {
    for (const it of s.doc.items.values()) {
      if (it.kind !== "symbol") continue;
      const fp = fieldText(it.node, "Footprint"); if (!fp) continue;
      const e = lib.footprints.get(fp); if (!e) continue;
      const text = e.state === "missing" ? `The current configuration does not include the footprint library '${e.library}'`
        : e.state === "disabled" ? `The footprint library '${e.library}' is not enabled in the current configuration`
        : !e.footprint ? `Footprint '${e.name}' not found in library '${e.library}'` : "";
      if (text) mark(i, "footprint_link_issues", atOf(it.node), text, it, itemRef(s.doc, it));
    }
  });
  return out;
}

/** What the run has to read from the libraries: every symbol's lib id, every footprint a symbol names (its Footprint
 *  field and its library symbol's associated footprints). */
export function libraryWants(docs: KDoc[]): { symbols: Set<string>; footprints: Set<string> } {
  const symbols = new Set<string>(), footprints = new Set<string>();
  for (const doc of docs) for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const id = symbolLibId(it.node); if (id) symbols.add(id);
    const fp = fieldText(it.node, "Footprint"); if (fp) footprints.add(fp);
    const ls = K.resolveLib(doc, str((kid(it.node, "lib_name") || kid(it.node, "lib_id") || [])[1])) || K.resolveLib(doc, id);
    if (ls) for (const a of pinMapFacts(ls).footprints) if (a.footprint) footprints.add(a.footprint);
  }
  return { symbols, footprints };
}
