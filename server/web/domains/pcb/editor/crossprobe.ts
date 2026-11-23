// editor/crossprobe.ts — cross-probing between a project's schematic and its board, as Eeschema and Pcbnew do
// over KIWAY mail (SCH_EDIT_FRAME::SendSelectItemsToPcb, PCB_EDIT_FRAME::SendSelectItemsToSch and the SyncSelection /
// HighlightNets handlers each side runs on the other's message).
//
// Selecting symbols, pins or sheets in a schematic window selects their footprints / pads in a board window of the
// same project, and the other way round.  The windows are tabs of one browser, so the message goes over a
// BroadcastChannel named for the project; it carries references, pad numbers and sheet paths, never the other side's
// ids.  The sender always sends (an empty selection never); what the receiving side does follows its Preferences: the
// schematic's Cross-probing (select, center, zoom, highlight nets, flash) and the board's (on selection, center on
// items, zoom to fit, auto highlight, flash).  "Select on PCB" / "Select on Schematic" in the context menus are
// explicit probes, which the receiver takes even when its "on selection" is off.  Switching editors in the same tab
// carries the selection directly.
import { E } from "./state";
import { state } from "./appstore";
import { clearAllSelection, pcbState, selectedAnywhere, selectionChanged, selectionHooks } from "./gestures";
import { fitBox, isSch, pxPerMm, stage } from "./view";
import { prefs } from "../dialogs/prefs";
import { expandStacked } from "../canvas/stacked-pins";
import { highlightRemote, loadSheets, netMap, currentInstance, goTo, netProbe } from "./schnets";
import { toolCtx } from "./tools";

/** A SelectionSpec: a footprint (symbol) by reference, a pad (pin) by reference and number, a sheet by its full path. */
interface Spec { footprint?: string; pad?: { ref: string; number: string }; sheetPath?: string[] }
/** SyncSelection (items, SSC_EXPLICIT / SSC_IMPLICIT) or HighlightNets (nets). */
interface Probe { from: "sch" | "pcb"; items: Spec[]; explicit: boolean; window: string; nets?: string[] }
type Box = [number, number, number, number];

const WINDOW = Math.random().toString(36).slice(2);
let channel: BroadcastChannel | null = null, channelFor = "", lastSent = "", applying = false;

function projectId(): string | null {
  const p = state.project as { projectId?: string } | null;
  if (p && p.projectId) return p.projectId;
  const m = location.pathname.match(/^\/p\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}
function bus(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const id = projectId(); if (!id) return null;
  if (channel && channelFor === id) return channel;
  if (channel) channel.close();
  channel = new BroadcastChannel("kc-crossprobe:" + id); channelFor = id;
  channel.onmessage = (ev: MessageEvent<Probe>) => { if (ev.data && ev.data.window !== WINDOW) void receiveProbe(ev.data); };
  return channel;
}

const schMod = (): { _?: Record<string, unknown> } | undefined => CollabTools.sch as unknown as { _?: Record<string, unknown> } | undefined;
const pcbTools = (): Record<string, unknown> | undefined => (window as unknown as { PcbTools?: Record<string, unknown> }).PcbTools;
const K = (): typeof KiCadCanvas => KiCadCanvas;

/**
 * The selection as SendSelectItemsToPcb / SendSelectItemsToSch pack it: on the schematic every symbol (by its
 * reference on this sheet), every sheet (this sheet's path plus its uuid) and every pin (its symbol's reference and
 * each pad its number expands to); on the board every footprint and pad, groups expanded.
 */
function selectionSpecs(): Spec[] {
  if (!E.kdoc) return [];
  const doc = E.kdoc as KDoc, out: Spec[] = [];
  if (isSch()) {
    const base = String(doc.instancePath || "").split("/").filter(Boolean);
    for (const id of selectedAnywhere()) {
      const it = doc.items.get(id); if (!it) continue;
      if (it.kind === "symbol") out.push({ footprint: it.ref || "" });
      else if (it.kind === "sheet") { const u = K().kid(it.node, "uuid") as SNode | null; out.push({ sheetPath: [...base, K().str(u ? u[1] : "")] }); }
    }
    for (const p of (E.selPins || []) as { id: string; number: string }[]) {
      const it = doc.items.get(p.id); if (!it) continue;
      for (const pad of expandStacked(p.number).pins) out.push({ pad: { ref: it.ref || "", number: pad } });
    }
    return out;
  }
  const P = CollabTools.pcb as unknown as { selectedPadKeys?: () => string[] } | undefined;
  const ids = new Set([...selectedAnywhere()].filter((id) => !id.includes("#")));
  const keys: string[] = [];
  const add = (it: KItem | undefined): void => {
    if (!it) return;
    if (it.kind === "group") { for (const m of K().kids(it.node, "members") as SNode[]) for (const u of m.slice(1)) add(doc.items.get(K().str(u))); }
    else if (it.kind === "footprint") keys.push(it.id);
  };
  for (const id of ids) add(doc.items.get(id));
  for (const k of P && P.selectedPadKeys ? P.selectedPadKeys() : []) keys.push(k);
  for (const k of keys) {
    const h = k.lastIndexOf("#");
    if (h < 0) { const it = doc.items.get(k); if (it) out.push({ footprint: it.ref || "" }); continue; }
    const fp = doc.items.get(k.slice(0, h)); const pads = fp ? padsOfFp(fp) : [];
    const pad = pads[+k.slice(h + 1)]; if (fp && pad) out.push({ pad: { ref: fp.ref || "", number: pad.number } });
  }
  return out;
}
function padsOfFp(fp: KItem): { number: string }[] { return (K().kids(fp.node, "pad") as SNode[]).map((p) => ({ number: K().str(p[1]) })); }
const specKey = (items: Spec[]): string => JSON.stringify(items);

export function probeForSwitch(nextType: string): Probe | null {
  if (!E.kdoc || !state.doc || E.DOC_TYPE === nextType) return null;
  if (E.DOC_TYPE !== "kicad_sch" && E.DOC_TYPE !== "kicad_pcb" || nextType !== "kicad_sch" && nextType !== "kicad_pcb") return null;
  const items = selectionSpecs();
  return items.length ? { from: isSch() ? "sch" : "pcb", items, explicit: false, window: WINDOW } : null;
}

export function selectedSchematicFile(): string | null {
  if (!E.kdoc || E.DOC_TYPE !== "kicad_pcb" || prefs().schDisplay.crossProbeSelect === false) return null;
  const doc = E.kdoc as KDoc, files = new Set<string>();
  for (const id of selectedAnywhere()) { const it = doc.items.get(id.split("#")[0]); if (it && it.kind === "footprint") files.add(K().str(K().kid(it.node, "sheetfile")?.[1])); }
  return files.size === 1 ? [...files][0] || null : null;
}

/** Tell the other editor of this project what is selected here (force: the Select on PCB / Schematic actions). */
export function sendSelection(force = false): void {
  if (applying || !E.kdoc || E.DOC_TYPE !== "kicad_sch" && E.DOC_TYPE !== "kicad_pcb" || (E.kdoc as KDoc & { fpEditor?: unknown }).fpEditor) return;
  const items = selectionSpecs();
  if (!items.length) { if (!flashTimer) lastSent = ""; return; }   // sync.items_size() == 0: nothing is sent, the other side keeps its selection (a flash's hidden phase is no new selection)
  const key = specKey(items);
  if (!force && key === lastSent) return;
  lastSent = key;
  const b = bus(); if (b) b.postMessage({ from: isSch() ? "sch" : "pcb", items, explicit: force, window: WINDOW } as Probe);
}

/** SendCrossProbeNetName / SetCrossProbeConnection: the net highlighted here (none: the highlight was cleared). */
function sendNets(names: string[]): void {
  if (applying || !E.kdoc) return;
  const b = bus(); if (b) b.postMessage({ from: isSch() ? "sch" : "pcb", items: [], explicit: false, window: WINDOW, nets: names } as Probe);
}

function crossOpts(sch: boolean): { select: boolean; center: boolean; zoom: boolean; highlight: boolean; flash: boolean } {
  if (sch) { const d = prefs().schDisplay; return { select: d.crossProbeSelect !== false, center: d.crossProbeCenter !== false, zoom: d.crossProbeZoom !== false, highlight: d.crossProbeHighlight !== false, flash: d.crossProbeFlash === true }; }
  const x = prefs().pcbDisplay.crossProbing || { onSelection: true, centerOnItems: true, zoomToFit: true, autoHighlight: true, flashSelection: false };
  return { select: x.onSelection !== false, center: x.centerOnItems !== false, zoom: x.zoomToFit !== false, highlight: x.autoHighlight !== false, flash: x.flashSelection === true };
}
const union = (b: Box | null, q: number[] | null | undefined): Box | null => (q ? (b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : [q[0], q[1], q[2], q[3]]) : b);

/**
 * The tail of SyncSelection / doSyncSelection: with "center on items" (and a box of some width and height) the
 * scale follows ZoomFitCrossProbeBBox when "zoom to fit" is set, then the view centres on the box (FocusOnLocation).
 */
function centerOn(b: Box | null, o: { center: boolean; zoom: boolean }, ratioOf: ((w: number, h: number, vw: number, vh: number) => number | null) | undefined): void {
  if (!b || b[2] - b[0] === 0 || b[3] - b[1] === 0 || !o.center) return;
  const ppm = pxPerMm(); let w = stage.clientWidth / ppm, h = stage.clientHeight / ppm;
  const ratio = o.zoom && ratioOf ? ratioOf(b[2] - b[0], b[3] - b[1], w, h) : null;
  if (ratio) { w *= ratio; h *= ratio; }
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2; fitBox([cx - w / 2, cy - h / 2, w, h]);
}

/** EDA_ITEM::IsMoving for the board: a move or drag of the selection is under way. */
const boardMoving = (): boolean => { const p = pcbState(); return !!(p && (p.move || p.drag)) || !!(E as unknown as { drag?: unknown }).drag; };

// ---------------------------------------------------------------- flash (StartCrossProbeFlash)
let flashTimer = 0;
/** The cross-probed selection is hidden and shown every 0.5 s for six phases, then left selected. */
function startFlash(restore: () => void): void {
  if (!isSch() && boardMoving()) return;
  if (flashTimer) { clearInterval(flashTimer); flashTimer = 0; }
  let phase = 0;
  flashTimer = window.setInterval(() => {
    if (!isSch() && boardMoving()) { clearInterval(flashTimer); flashTimer = 0; return; }
    applying = true;
    try {
      if (phase % 2 === 0) { clearAllSelection(false); selectionChanged(); } else restore();
      phase++;
      if (phase > 6) { restore(); clearInterval(flashTimer); flashTimer = 0; }
    } finally { applying = false; }
  }, 500);
}

// ---------------------------------------------------------------- the schematic side
interface SchFound { inst: number; symbols: string[]; pins: { id: string; number: string }[]; sheets: string[] }
/**
 * findItemsFromSyncSelection: the sheet on screen first, then every sheet of the hierarchy; the first sheet with a
 * wanted symbol (or pin) is the one shown, with its wanted symbols, pins and the sheet symbols on it whose whole
 * contents are wanted (sheetContainsOnlyWantedItems).
 */
function findSchItems(items: Spec[]): SchFound | null {
  const c = netMap(); const m = schMod(); const _ = (m && m._) || {};
  const refOn = _.refOn as ((n: SNode, path: string | null) => string) | undefined;
  const symbolPins = _.symbolPins as ((d: KDoc, it: KItem) => { number: string }[]) | undefined;
  const isPower = _.isPowerSymbol as ((d: KDoc, lib: string) => boolean) | undefined;
  if (!c || !refOn || !symbolPins) return null;
  const symWanted = new Set<string>(), pinWanted = new Map<string, Set<string>>();
  for (const s of items) {
    if (s.footprint !== undefined) symWanted.add(s.footprint);
    else if (s.pad) { if (!pinWanted.has(s.pad.ref)) pinWanted.set(s.pad.ref, new Set()); pinWanted.get(s.pad.ref)!.add(s.pad.number); }
  }
  const cur = currentInstance(c);
  const ordered = cur ? [cur, ...c.instances.filter((i) => i.index !== cur.index)] : c.instances.slice();
  const pathOf = (u: string[]): string => "/" + u.join("/");
  const symbolsOf = (inst: { file: string; uuidPath: string[] }): { it: KItem; ref: string; doc: KDoc }[] => {
    const doc = c.docs.get(inst.file); if (!doc) return [];
    const out: { it: KItem; ref: string; doc: KDoc }[] = [];
    for (const it of doc.items.values()) {
      if (it.kind !== "symbol") continue;
      if (isPower && isPower(doc, K().str((K().kid(it.node, "lib_id") || [])[1]))) continue;   // SYMBOL_FILTER_NON_POWER
      out.push({ it, ref: refOn(it.node, pathOf(inst.uuidPath)), doc });
    }
    return out;
  };
  const cache = new Map<string, boolean>();
  const fullyWanted = (u: string[]): boolean => {
    const key = u.join("/"); if (cache.has(key)) return cache.get(key)!;
    const done = (v: boolean): boolean => { cache.set(key, v); return v; };
    for (const ch of c.instances) if (ch.uuidPath.length === u.length + 1 && ch.uuidPath.slice(0, u.length).join("/") === key && !fullyWanted(ch.uuidPath)) return done(false);
    const inst = c.instances.find((i) => i.uuidPath.join("/") === key); if (!inst) return done(false);
    const refs = symbolsOf(inst); if (!refs.length) return done(false);
    for (const r of refs) {
      if (r.ref.startsWith("#") || r.ref.endsWith("?")) continue;
      if (!symWanted.has(r.ref) || pinWanted.has(r.ref)) return done(false);
    }
    return done(true);
  };
  for (const inst of ordered) {
    const found: SchFound = { inst: inst.index, symbols: [], pins: [], sheets: [] };
    for (const r of symbolsOf(inst)) {
      if (symWanted.has(r.ref)) { found.symbols.push(r.it.id); continue; }   // the whole footprint: no pins
      const want = pinWanted.get(r.ref); if (!want) continue;
      const hit = new Set<string>();
      for (const p of symbolPins(r.doc, r.it)) for (const pad of expandStacked(p.number).pins) if (want.has(pad) && !hit.has(pad)) { hit.add(pad); found.pins.push({ id: r.it.id, number: p.number }); break; }
    }
    if (!found.symbols.length && !found.pins.length) continue;
    const doc = c.docs.get(inst.file);
    if (doc) for (const it of doc.items.values()) if (it.kind === "sheet") { const u = K().kid(it.node, "uuid") as SNode | null; if (u && fullyWanted([...inst.uuidPath, K().str(u[1])])) found.sheets.push(it.id); }
    return found;
  }
  return null;
}

async function receiveSch(p: Probe, o: ReturnType<typeof crossOpts>): Promise<void> {
  await loadSheets();
  const found = findSchItems(p.items); if (!found) return;
  const c = netMap(), cur = currentInstance(c);
  if (!cur || cur.index !== found.inst) { await goTo(found.inst, null); if (!E.kdoc || !isSch()) return; }
  const doc = E.kdoc as KDoc;
  const select = (): void => {
    clearAllSelection(false);
    E.selection = new Set([...found.symbols, ...found.sheets].filter((id) => doc.items.has(id)));
    E.selPins = found.pins.filter((q) => doc.items.has(q.id)) as typeof E.selPins;
    lastSent = specKey(selectionSpecs());
    selectionChanged();
  };
  applying = true;
  try {
    select();
    const sm = schMod(), _ = (sm && sm._) || {};
    const candBox = _.candBox as ((d: KDoc, c: unknown) => number[]) | undefined;
    const symbolPins = _.symbolPins as ((d: KDoc, it: KItem) => { number: string }[]) | undefined;
    let b: Box | null = null;
    for (const id of E.selection) { const it = doc.items.get(id)!; let q: number[] | null = it.bbox; try { if (candBox) q = candBox(doc, { key: id, kind: "item", item: it }); } catch { q = it.bbox; } b = union(b, q); }
    for (const q of E.selPins as { id: string; number: string }[]) {
      const it = doc.items.get(q.id)!; const pin = symbolPins ? symbolPins(doc, it).find((x) => x.number === q.number) : undefined;
      try { if (candBox && pin) b = union(b, candBox(doc, { key: q.id + "#pin:" + q.number, kind: "pin", item: it, pin })); } catch { /* no box for the pin */ }
    }
    centerOn(b, o, _.crossProbeZoomRatio as ((w: number, h: number, vw: number, vh: number) => number | null) | undefined);
  } finally { applying = false; }
  if (o.flash && (E.selection.size || E.selPins.length)) startFlash(select);
}

// ---------------------------------------------------------------- the board side
function padBox(fp: KItem, index: number): Box | null {
  let b: Box | null = null;
  for (const g of fp.geom || []) { const pg = g as KGeom & { padIndex?: number; pad?: boolean; hole?: boolean }; if (pg.padIndex === index && !pg.hole) { try { b = union(b, (K() as unknown as { geomBox(g: KGeom): number[] | null }).geomBox(g)); } catch { /* a shape without a box */ } } }
  return b;
}
function receivePcb(p: Probe, o: ReturnType<typeof crossOpts>): void {
  if (boardMoving()) return;   // doSyncSelection: nothing changes while the selection or an incoming item is moving
  const T = pcbTools(); const find = T && T.findItemsFromSyncSelection as ((d: KDoc, s: Spec[]) => string[]) | undefined;
  if (!find) return;
  const doc = E.kdoc as KDoc, ids = find(doc, p.items);
  const fps = ids.filter((id) => !id.includes("#")), pads = ids.filter((id) => id.includes("#"));
  const select = (): void => {
    clearAllSelection(false);
    E.selection = new Set(fps);
    const s = pcbState() as unknown as { padSel?: string | null; padAlso?: { anchor: string; keys: string[] } | null } | null;
    if (s) { s.padSel = pads.length ? pads[0] : null; s.padAlso = pads.length > 1 ? { anchor: pads[0], keys: pads.slice(1) } : null; }
    lastSent = specKey(selectionSpecs());
    selectionChanged();
  };
  applying = true;
  try {
    select();
    let b: Box | null = null;
    for (const id of fps) b = union(b, doc.items.get(id)?.bbox);
    for (const k of pads) { const h = k.lastIndexOf("#"), fp = doc.items.get(k.slice(0, h)); if (fp) b = union(b, padBox(fp, +k.slice(h + 1))); }
    centerOn(b, o, T && T.crossProbeZoomRatio as ((w: number, h: number, vw: number, vh: number) => number | null) | undefined);
  } finally { applying = false; }
  if (o.flash && ids.length) startFlash(select);
}

/** HighlightNets: with "highlight cross-probed nets" on, the other editor's highlighted net is highlighted here. */
function receiveNets(names: string[], o: ReturnType<typeof crossOpts>): void {
  if (!o.highlight) return;
  applying = true;
  try {
    if (isSch()) {
      // SCH_EDIT_FRAME::HandleRemoteNetHighlight: the first name, when the schematic has that net
      const net = names.length ? names[0] : "", c = netMap();
      highlightRemote(net && c && c.map.has(net) ? net : null);
      return;
    }
    const pcb = CollabTools.pcb as unknown as { remoteNetHighlight?: (ctx: unknown, n: string[]) => Box | null } | undefined;
    if (!pcb || !pcb.remoteNetHighlight) return;
    const b = pcb.remoteNetHighlight(toolCtx(), names);
    centerOn(b, o, pcbTools()?.crossProbeZoomRatio as ((w: number, h: number, vw: number, vh: number) => number | null) | undefined);
  } finally { applying = false; }
}

export async function receiveProbe(p: Probe): Promise<void> {
  if (!E.kdoc || (p.from === "sch") === isSch() || (E.kdoc as KDoc & { fpEditor?: unknown }).fpEditor) return;
  const sch = isSch(), o = crossOpts(sch);
  if (p.nets) { receiveNets(p.nets, o); return; }
  if (!o.select && !p.explicit) return;   // CPS_DISABLED: implicit selection sync disabled by the user
  if (!p.items || !p.items.length) return;
  if (sch) await receiveSch(p, o); else receivePcb(p, o);
}

export function installCrossProbe(): void {
  // A selection made with the mouse or keys settles after the event; selectionChanged() covers the rest.
  selectionHooks.push(() => sendSelection());
  const later = (): void => { setTimeout(() => sendSelection(), 0); };
  window.addEventListener("pointerup", later, true); window.addEventListener("keyup", later, true);
  // a net highlighted (or cleared) by the user goes to the other editor
  netProbe.send = (names) => { if (isSch()) sendNets(names); };
  const hooks = ((E as unknown as { hooks: Record<string, unknown> }).hooks);
  hooks.netHighlighted = (names: string[]) => { if (!isSch()) sendNets(names); };
  // listen from the start: a window that has selected nothing yet still has to take the other's selection
  const listen = window.setInterval(() => { if (E.kdoc && bus()) window.clearInterval(listen); }, 500);
}
