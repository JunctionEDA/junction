// tutorial.ts — Help > Make an LED Board: starts a blank project with the LED board walkthrough
// (platform/onboarding/Guide.tsx draws it), and works out what the walkthrough watches for in the
// open project: the parts on the schematic, their wiring, names and footprints, whether the board
// has them, its outline, where the footprints sit and what is left to route.  It only reads the
// design; every step is done by the person with the editor's own tools.
import { state, store } from "./appstore";
import { E } from "./state";
import { navigate } from "./home";
import { toast } from "./util";
import { pendingBoardUpdates, projectBoard } from "./attention";
import { projectNetlist } from "./pcbdialogs/update-pcb";
import type { TutorialFacts } from "../../../shared/store";

const KEY = "kc.guide";

interface Guide { projectId: string; kind?: string }
function guide(): Guide | null {
  try { const g = JSON.parse(localStorage.getItem(KEY) || "null") as Guide | null; return g && typeof g.projectId === "string" ? g : null; }
  catch { return null; }
}
const running = (): boolean => { const g = guide(); return !!g && g.kind === "led" && !!state.project && g.projectId === state.project.projectId; };

/** Help > Make an LED Board: a new blank project (schematic and board), with the walkthrough on. */
export async function startLedTutorial(): Promise<void> {
  if (!state.me) { toast("Sign in to start the tutorial"); return; }
  try {
    const r = await fetch("/api/projects/blank", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `LED board ${new Date().toISOString().slice(0, 10)}`, template: "pcb" }) });
    const j = await r.json() as { projectId?: string; message?: string };
    if (!r.ok || !j.projectId) throw new Error(j.message || `HTTP ${r.status}`);
    try { localStorage.setItem(KEY, JSON.stringify({ projectId: j.projectId, from: "home", kind: "led", done: {} })); } catch { /* private mode */ }
    window.dispatchEvent(new CustomEvent("kc:guide"));
    navigate(`/p/${j.projectId}/edit`);
  } catch (e) { toast("Could not start the tutorial: " + (e as Error).message, 4000); }
}

// ---------------------------------------------------------------- what the walkthrough watches
const isR = (libId: string, ref: string): boolean => /(^|:)R(_|$)/.test(libId) || /^R[0-9?]*$/.test(ref);
const isLed = (libId: string, ref: string): boolean => /LED/i.test(libId) || (/^D[0-9?]*$/.test(ref) && /LED/i.test(libId));
const isConn = (libId: string, ref: string): boolean => /^Connector/i.test(libId) || /^(J|P)[0-9?]*$/.test(ref);

export async function tutorialFacts(): Promise<TutorialFacts | null> {
  const res = await projectNetlist(); if ("error" in res) return null;
  const comps = res.netlist.components.filter((c) => !c.ref.startsWith("#"));
  const r = comps.find((c) => isR(c.libId, c.ref)), led = comps.find((c) => isLed(c.libId, c.ref)), conn = comps.find((c) => isConn(c.libId, c.ref));
  const parts = [r, led, conn].filter((c): c is NonNullable<typeof c> => !!c);
  // which components each net reaches
  const reach = new Map<string, Set<string>>();
  for (const [net, pins] of res.netlist.nets) reach.set(net, new Set(pins.map((p) => p.ref)));
  const wiredPart = (c: (typeof parts)[number]): boolean => {
    const pins = Array.from(c.pins.values()); if (pins.length < 2) return false;
    const nets = pins.map((p) => p.net);
    // every pin to another part, and not two pins of one part on one net (that would short it)
    return nets.every((n) => !!n && (reach.get(n)?.size || 0) >= 2) && new Set(nets).size === nets.length;
  };
  const facts: TutorialFacts = {
    r: !!r, led: !!led, conn: !!conn,
    wired: parts.filter(wiredPart).length,
    named: parts.length === 3 && parts.every((c) => !c.ref.includes("?")),
    footprints: parts.length === 3 && parts.every((c) => !!c.footprint),
    onBoard: 0, stale: false, outline: false, inside: 0, open: null,
  };
  const board = await projectBoard().catch(() => null);
  if (!board) return facts;
  const fps = Array.from(board.items.values()).filter((it) => it.kind === "footprint");
  const want = new Set(parts.map((c) => c.ref));
  const mine = fps.filter((it) => it.ref && want.has(it.ref));
  facts.onBoard = mine.length;
  facts.stale = !!(await pendingBoardUpdates(board).catch(() => null));
  const layerOf = (it: KItem): string => { if (it.layer) return it.layer; const l = KiCadCanvas.kid(it.node, "layer"); return l ? String(l[1]) : ""; };
  const edges = Array.from(board.items.values()).filter((it) => it.kind !== "footprint" && it.bbox && layerOf(it) === "Edge.Cuts");
  if (edges.length) {
    const box = edges.reduce((b, it) => [Math.min(b[0], it.bbox![0]), Math.min(b[1], it.bbox![1]), Math.max(b[2], it.bbox![2]), Math.max(b[3], it.bbox![3])], [Infinity, Infinity, -Infinity, -Infinity]);
    facts.outline = box[2] - box[0] > 1 && box[3] - box[1] > 1;
    const inBox = (it: KItem): boolean => { const b = it.bbox; const x = it.x ?? (b ? (b[0] + b[2]) / 2 : NaN), y = it.y ?? (b ? (b[1] + b[3]) / 2 : NaN); return x > box[0] && x < box[2] && y > box[1] && y < box[3]; };
    facts.inside = facts.outline ? mine.filter(inBox).length : 0;
  }
  const tools = (window as unknown as { PcbTools?: { ratsnest(d: KDoc): unknown[] } }).PcbTools;
  try { if (tools && mine.length) facts.open = tools.ratsnest(board).length; } catch { /* a board mid-load */ }
  return facts;
}

let timer = 0, lastKey = "", quiet = 0, lastRun = 0, busy = false;
async function check(): Promise<void> {
  if (busy || document.hidden) return;
  busy = true; lastRun = Date.now();
  try { const f = await tutorialFacts(); if (f && running()) store.set({ tutorial: f }); }
  catch (e) { /* a document that cannot be read now: the next change looks again */ }
  finally { busy = false; }
}

/** While the LED tutorial runs in the open project: look again a moment after edits stop, on a tab change, and every 15 s. */
export function watchTutorial(): void {
  if (timer) return;
  timer = window.setInterval(() => {
    if (state.view !== "editor" || !running()) { if (store.get().tutorial) store.set({ tutorial: undefined }); lastKey = ""; return; }
    const key = `${state.project!.projectId}|${state.docId}|${E.editsSeen}`;
    if (key !== lastKey) { lastKey = key; quiet = Date.now(); return; }
    if ((quiet && Date.now() - quiet > 1200) || Date.now() - lastRun > 15000) { quiet = 0; void check(); }
  }, 600);
}
