// editor/kicad-check.ts — Run DRC and Run ERC through KiCad itself.
//
// The server writes the project out as it is now and runs Junction desktop's own kicad-cli on it
// (server/src/kicad_check.rs), so the dialogs list exactly what the desktop's checkers report.  The
// browser's TypeScript checks (pcb-tools drc*.ts, sch-tools erc*.ts) stay as the instant checks while
// editing and as the fallback when the server cannot run kicad-cli (no kicad-cli installed, offline, a
// failure).  The report is kicad-cli's JSON (`--format json --units <the editor's units> --severity-all`): its
// messages read in the frame's units as KiCad's dialogs do, and its positions are taken back to mm here.
import { api } from "./util";

export interface CliItem { description: string; pos?: { x: number; y: number }; uuid?: string }
export interface CliViolation { type: string; severity: string; description: string; items: CliItem[]; pos?: { x: number; y: number }; layer?: string; excluded?: boolean; comment?: string }
export interface DrcReport { violations?: CliViolation[]; unconnected_items?: CliViolation[]; schematic_parity?: CliViolation[]; kicad_version?: string; coordinate_units?: string }
export interface ErcReport { sheets?: { path: string; uuid_path: string; violations: CliViolation[] }[]; kicad_version?: string; coordinate_units?: string }

/** kicad-cli's `--units` for the editor's units ("mm", "in", "mil"). */
export function cliUnits(units: string | undefined): "mm" | "in" | "mil" { return units === "in" || units === "mil" ? units : "mm"; }
/** Millimetres per unit of a report's positions (its `coordinate_units`: EDA_UNIT_UTILS::GetLabel, "mm" / "in" / "mils"). */
export function reportScale(rep: { coordinate_units?: string } | null | undefined): number {
  const u = rep && rep.coordinate_units;
  return u === "in" ? 25.4 : u === "mils" || u === "mil" ? 0.0254 : 1;
}

/** Why the last server check did not run, for the dialog's status line ("" when it ran). */
export let lastFallback = "";

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T | null> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) { lastFallback = "offline"; return null; }
  try {
    const r = await api(path, { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) }) as { report?: T };
    lastFallback = "";
    return r && r.report ? r.report : null;
  } catch (e) {
    const msg = String((e as Error).message || e);
    lastFallback = /^501\b/.test(msg) ? "no kicad-cli on this server" : msg.replace(/^\d+\s*/, "").slice(0, 200);
    return null;
  }
}

function failed(msg: string): null {
  // a 501 is "no kicad-cli" unless the server names another reason (a kicad-cli without the option asked for)
  let reason = ""; try { const j = JSON.parse(msg.replace(/^\d+\s*/, "")) as { error?: string; message?: string }; if (j && j.error && j.error !== "no_kicad_cli" && j.message) reason = j.message; } catch { /* plain text */ }
  lastFallback = reason ? reason.slice(0, 200) : /^501\b/.test(msg) ? "no kicad-cli on this server" : msg.replace(/^\d+\s*/, "").slice(0, 200);
  return null;
}

/** KiCad's DRC of the board document `docId`, or null when the server could not run it. */
export function serverDrc(docId: string, o: { parity: boolean; refill: boolean; allTrackErrors?: boolean; units?: string; signal?: AbortSignal }): Promise<DrcReport | null> {
  return post<DrcReport>(`/api/docs/${encodeURIComponent(docId)}/drc`, { parity: o.parity, refill: o.refill, allTrackErrors: !!o.allTrackErrors, units: cliUnits(o.units) }, o.signal);
}
/** KiCad's ERC of the project's whole hierarchy, asked from schematic `docId`, or null.  `showAllErrors` is the
 *  dialog's "Show all errors" (ERC_TESTER( sch, showAllErrors )); `onPhase` gets each test phase kicad-cli starts
 *  ("Checking conflicts..."), as DIALOG_ERC's reporter does, from the server's stream of JSON lines; aborting
 *  `signal` (the dialog's Cancel) closes the request, which stops kicad-cli on the server. */
export async function serverErc(docId: string, o: { showAllErrors?: boolean; units?: string; onPhase?: (msg: string) => void; signal?: AbortSignal } = {}): Promise<ErcReport | null> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) { lastFallback = "offline"; return null; }
  const body = { showAllErrors: !!o.showAllErrors, units: cliUnits(o.units), progress: true };
  let r: Response;
  try {
    r = await fetch(`/api/docs/${encodeURIComponent(docId)}/erc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(o.signal ? { signal: o.signal } : {}) });
  } catch (e) { return failed(String((e as Error).message || e)); }
  if (!r.ok) { const t = await r.text().catch(() => ""); return failed(`${r.status} ${t || r.statusText}`); }
  let report: ErcReport | null = null, error = "";
  const take = (text: string): void => {
    const t = text.trim(); if (!t) return;
    let v: { phase?: string; report?: ErcReport; error?: string; message?: string; status?: number };
    try { v = JSON.parse(t); } catch { return; }
    if (typeof v.phase === "string") { if (o.onPhase) o.onPhase(v.phase); }
    else if (v.report) report = v.report;
    else if (v.error) error = `${v.status || ""} ${v.message || v.error}`.trim();
  };
  try {
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("ndjson")) {   // a server that answers in one piece
      const v = await r.json() as { report?: ErcReport }; lastFallback = ""; return v && v.report ? v.report : null;
    }
    const reader = r.body && typeof r.body.getReader === "function" ? r.body.getReader() : null;
    if (!reader) { for (const l of (await r.text()).split("\n")) take(l); }
    else {
      const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buf += dec.decode(value, { stream: !done });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) { take(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
        if (done) break;
      }
      take(buf);
    }
  } catch (e) { return failed(String((e as Error).message || e)); }
  if (report) { lastFallback = ""; return report; }
  return failed(error || "the check ended without a report");
}

/** Every uuid in a document mapped to the id of the item that holds it (a pad's or a pin's uuid to its footprint or symbol). */
export function uuidIndex(doc: KDoc): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: SNode, owner: string): void => {
    if (!Array.isArray(n)) return;
    if ((n[0] === "uuid" || n[0] === "tstamp") && typeof n[1] === "string") { if (!out.has(n[1])) out.set(n[1], owner); return; }
    for (const c of n) if (Array.isArray(c)) walk(c as SNode, owner);
  };
  for (const [id, it] of doc.items) { out.set(id, id); walk(it.node, id); }
  return out;
}

/** A kicad-cli violation as a dialog marker: its rule, severity, message, place and the items it names. */
export function toMarker(v: CliViolation, ids: Map<string, string>, scale = 1): { code: string; severity: string; x: number; y: number; text: string; ids: string[]; kiids: string[]; descs: string[]; layer?: string; excluded?: boolean; comment?: string; items: { x: number; y: number; desc: string; id?: string; uuid?: string }[] } {
  // the report's positions are in its coordinate_units; the editor's are mm
  const mm = (p: { x: number; y: number }): { x: number; y: number } => ({ x: p.x * scale, y: p.y * scale });
  const items = (v.items || []).map((i) => (i.pos ? { ...i, pos: mm(i.pos) } : i));
  const at = (v.pos && mm(v.pos)) || (items[0] && items[0].pos) || { x: 0, y: 0 };
  const found = items.map((i) => (i.uuid ? ids.get(i.uuid) || "" : "")).filter((x) => x);
  return {
    code: v.type, severity: v.severity === "error" ? "error" : v.severity === "warning" ? "warning" : v.severity,
    x: at.x, y: at.y, text: v.description, ...(v.layer ? { layer: v.layer } : {}), ids: Array.from(new Set(found)), kiids: items.map((i) => i.uuid || "").filter((u) => u), descs: items.map((i) => i.description),
    // each item with its own uuid (a pin's) and the id of the item that holds it, for the report and the cross-probe
    items: items.map((i) => ({ x: i.pos ? i.pos.x : at.x, y: i.pos ? i.pos.y : at.y, desc: i.description, ...(i.uuid ? { uuid: i.uuid, ...(ids.get(i.uuid) ? { id: ids.get(i.uuid) } : {}) } : {}) })),
    ...(v.excluded ? { excluded: true, comment: v.comment || "" } : {}),
  };
}
