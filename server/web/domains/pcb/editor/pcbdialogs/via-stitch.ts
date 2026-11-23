// pcbdialogs/via-stitch — DIALOG_VIA_STITCH_PROPERTIES (dialog_via_stitch_properties.cpp / _base.fbp): Stitch Net,
// Position X / Y (the outline's first corner), Pattern (Normal Grid, Staggered Grid, Poisson), Pitch, Seed, Via
// Properties (Configure: the template via's diameter and hole), Mode (Stitch, Guard) and Guard Net, with the pattern
// preview.  OnUpdateUI: Pattern only in Stitch mode, Guard Net only in Guard mode, Seed only for a Poisson stitch.
// New stitches (Draw Via Stitch area) open it before they are made; Properties on a stitch commits "Edit Via
// Stitching" (PCB_VIA_STITCH::ShowPropertiesDialog) with the stitch updated.  Also VIA_STITCH_TOOL's Exclude From
// Stitching and Clear Via Stitching Exclusions.
import { E } from "../state";
import { selectionIds } from "../gestures";
import { teardropOpts } from "./board-commit";
import { box, coordField, form, h, lenField, openDialog, selectField, subDialog, textField, unitLabel, type Field } from "./ui";

type V = [number, number];
interface Stitch { uuid: string; origin: V; outline: V[]; pitch: number; layout: number; mode: number; seed: number; offset: V; netName: string; guardedNetName: string; exCells: V[]; exPos: V[]; via: SNode; members: string[] }
interface GridConfig { layout: number; mode: number; pitch: number }
interface StitchApi {
  readStitch(n: SNode): Stitch; writeStitch(s: Stitch): SNode; isViaStitch(it: KItem | null | undefined): boolean; gridConfigOf(s: Stitch): GridConfig;
  viaStitchUpdate(doc: KDoc, s: Stitch, o: unknown, prev?: GridConfig | null, isNew?: boolean): { changes: KChange[]; stitch: Stitch; changedVias: boolean };
  excludeViaChanges(doc: KDoc, ids: string[]): KChange[]; clearAllExclusions(s: Stitch): void; hasExclusions(s: Stitch): boolean; stitchOfVia(doc: KDoc, id: string): KItem | null;
  zonesNeedingRefill(doc: KDoc, s: Stitch): string[]; stitchesDirtiedByFill(doc: KDoc, zoneIds: string[]): string[];
}
interface PcbToolsApi { viaStitch: StitchApi; boardNets(doc: KDoc): { name: string }[]; applySelection?(ctx: ToolCtx, ids: string[]): void; removedChange?(it: KItem): KChange }
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;
const VS = (): StitchApi => PT().viaStitch;
const IU = 1e6;
const mmOf = (v: number): number => +(v / IU).toFixed(6);
const kid = (n: SNode, k: string): SNode | null => (KiCadCanvas.kid(n, k) as SNode | null);
const numOf = (n: SNode | null, i = 1): number => (n ? KiCadCanvas.num(n[i]) : 0);
function setKid(n: SNode, key: string, val: SNode): void { const i = n.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === key); if (i > 0) n[i] = val; else n.push(val); }

/** The update options: the project's rules and the board's current via (BOARD_DESIGN_SETTINGS). */
export function stitchOpts(): Record<string, unknown> { const o = teardropOpts(); return { project: o.project, settings: o.settings }; }

// ---------------------------------------------------------------- the preview (DIALOG_VIA_STITCH_PROPERTIES::redrawPreview)
function drawPreview(cv: HTMLCanvasElement, layout: number, mode: number, pitch: number, viaSize: number): void {
  const g = cv.getContext("2d"); if (!g) return;
  const W = cv.width, H = cv.height; const css = getComputedStyle(cv);
  g.fillStyle = css.getPropertyValue("--bg") || "#1b1b1b"; g.fillRect(0, 0, W, H);
  const span = 6 * pitch; const sc = Math.min(W, H) / span; const r = Math.max(1.5, viaSize * sc / 2);
  const dot = (x: number, y: number): void => { g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.fill(); };
  g.fillStyle = "#c8c8c8";
  if (mode === 1) {
    // a guarded track across the window, the vias walked along its envelope
    g.strokeStyle = "#c85050"; g.lineWidth = Math.max(2, 0.25 * pitch * sc);
    const pts: V[] = [[0.12 * W, 0.78 * H], [0.38 * W, 0.78 * H], [0.62 * W, 0.22 * H], [0.88 * W, 0.22 * H]];
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) g.lineTo(p[0], p[1]); g.stroke();
    const off = (viaSize / 2 + 0.6 * pitch / 2) * sc + g.lineWidth / 2; const step = pitch * sc;
    for (const side of [-1, 1]) {
      let carry = step / 2;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy), nx = -dy / len * side, ny = dx / len * side;
        for (let t = carry; t <= len; t += step) dot(a[0] + dx * t / len + nx * off, a[1] + dy * t / len + ny * off);
        carry = (carry - len) % step; if (carry < 0) carry += step;
      }
    }
    return;
  }
  if (layout === 2) {
    // two by two baked tiles (POISSON_TILE_PITCHES pitches each) scaled into the window
    const tile = poisson(); const ts = W / 2;
    for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) for (const s of tile) dot((tx + s[0]) * ts, (ty + s[1]) * ts * H / W);
    return;
  }
  for (let row = 0; row * pitch * sc <= H + pitch * sc; row++) {
    const xo = layout === 1 && row % 2 ? pitch * sc / 2 : 0;
    for (let col = 0; col * pitch * sc <= W + pitch * sc; col++) dot(pitch * sc / 2 + col * pitch * sc + xo, pitch * sc / 2 + row * pitch * sc);
  }
}
let tileCache: [number, number][] | null = null;
function poisson(): [number, number][] {
  if (tileCache) return tileCache;
  const api = (window as unknown as { PcbTools: { viaStitchTile?(): [number, number][] } }).PcbTools;
  tileCache = api.viaStitchTile ? api.viaStitchTile() : []; return tileCache;
}

/** DIALOG_VIA_STITCH_PROPERTIES on a stitch node: `done` gets the edited node, or null on Cancel. */
export function viaStitchDialog(ctx: ToolCtx, node: SNode, done: (n: SNode | null) => void, title = "Via Stitching Properties"): boolean {
  const doc = ctx.doc as KDoc; const st = VS().readStitch(node);
  const nets = PT().boardNets(doc).map((n) => n.name).filter((n) => n);
  const netOpts = (cur: string): [string, string][] => { const l: [string, string][] = [["", "<no net>"], ...nets.map((n): [string, string] => [n, n])]; if (cur && !nets.includes(cur)) l.push([cur, cur]); return l; };
  const via = KiCadCanvas.cloneNode(st.via) as SNode;
  let result: SNode | null = null; let take: (() => void) | null = null;
  const api = openDialog({ title, width: 640,
    build(body) {
      const net = selectField<string>(st.netName, netOpts(st.netName), { key: "stitchNet" });
      const first = st.outline[0] || st.origin;
      const px = coordField(mmOf(first[0]), "x", { key: "posX" }), py = coordField(mmOf(first[1]), "y", { key: "posY" });
      const pattern = selectField<number>(st.layout, [[0, "Normal Grid"], [1, "Staggered Grid"], [2, "Poisson"]], { key: "pattern", onChange: () => sync() });
      const pitch = lenField(mmOf(st.pitch), { key: "pitch", onChange: () => sync() });
      const seed = textField(String(st.seed >>> 0), { key: "seed" });
      const mode = selectField<number>(st.mode, [[0, "Stitch"], [1, "Guard"]], { key: "mode", onChange: () => sync() });
      const guard = selectField<string>(st.guardedNetName, netOpts(st.guardedNetName), { key: "guardNet" });
      const configure = h("button", { class: "btn", type: "button", "data-k": "configure" }, "Configure");
      configure.addEventListener("click", () => {
        // DIALOG_TRACK_VIA_PROPERTIES on the template via: its diameter and hole
        let dia!: Field<number>, drill!: Field<number>;
        subDialog("Via Properties", 360, (b) => {
          dia = lenField(numOf(kid(via, "size")), { key: "viaDiameter" }); drill = lenField(numOf(kid(via, "drill")), { key: "viaHole" });
          b.append(form([["Diameter:", dia.el, unitLabel()], ["Hole:", drill.el, unitLabel()]]));
        }, () => {
          const d = dia.get(), dr = drill.get();
          if (!(d > 0) || !(dr > 0) || dr >= d) { ctx.toast("The via hole must be smaller than its diameter."); return false; }
          setKid(via, "size", ["size", d]); setKid(via, "drill", ["drill", dr]); sync(); return true;
        });
      });
      const cv = h("canvas", { width: 240, height: 240, style: "width:240px;height:240px;border:1px solid var(--line, #555)" }) as HTMLCanvasElement;
      const left = h("div", { style: "flex:1 1 auto" },
        form([["Stitch Net:", net.el], ["Position X:", px.el, unitLabel()], ["Position Y:", py.el, unitLabel()], ["Pattern:", pattern.el], ["Pitch:", pitch.el, unitLabel()], ["Seed:", seed.el],
          ["Via Properties:", configure], ["Mode:", mode.el], ["Guard Net:", guard.el]]));
      body.append(h("div", { style: "display:flex;gap:12px;align-items:flex-start" }, left, box("Preview", cv)));
      const en = (f: { input: HTMLElement }, on: boolean): void => { (f.input as HTMLInputElement).disabled = !on; };
      function sync(): void {
        const m = mode.get(), l = pattern.get();
        en(pattern, m === 0); en(guard, m === 1); en(seed, m === 0 && l === 2);
        const p = Math.max(1, Math.round(pitch.get() * IU)); drawPreview(cv, l, m, p, Math.round(numOf(kid(via, "size")) * IU));
      }
      sync();
      take = () => {
        const s = VS().readStitch(node);
        const nl = pattern.get(), nm = mode.get();
        if (nl !== s.layout || nm !== s.mode) VS().clearAllExclusions(s);   // SetLayout / SetMode
        s.layout = nl; s.mode = nm; s.netName = net.get(); s.guardedNetName = guard.get();
        const p = Math.round(pitch.get() * IU); if (p > 0) s.pitch = p;
        const sv = seed.get().trim(); if (/^\d+$/.test(sv)) s.seed = Number(sv) >>> 0;
        // Position: the outline moved so its first corner lands there (PCB_VIA_STITCH::Move)
        const f = s.outline[0] || s.origin; const dx = Math.round(px.get() * IU) - f[0], dy = Math.round(py.get() * IU) - f[1];
        if (dx || dy) { s.outline = s.outline.map((q) => [q[0] + dx, q[1] + dy] as V); s.origin = [s.origin[0] + dx, s.origin[1] + dy]; }
        s.via = via;
        result = VS().writeStitch(s);
      };
    },
    ok() { if (take) take(); done(result); return true; },
    cancel() { done(null); return true; },
  });
  if (!api) { done(null); return false; }
  return true;
}

/** Draw Via Stitch area's dialog (ZONE_CREATE_HELPER, ZONE_MODE::STITCH). */
export function newViaStitchDialog(ctx: ToolCtx, node: SNode, done: (n: SNode | null) => void): boolean { return viaStitchDialog(ctx, node, done); }

/** PCB_VIA_STITCH::ShowPropertiesDialog: "Edit Via Stitching", the stitch updated with it. */
export function editViaStitch(ctx: ToolCtx, item: KItem): boolean {
  if (ctx.viewOnly) { ctx.toast("This board is read-only"); return true; }
  return viaStitchDialog(ctx, item.node, (n) => {
    if (!n) return;
    const before = VS().readStitch(item.node);
    const res = VS().viaStitchUpdate(ctx.doc as KDoc, VS().readStitch(n), stitchOpts(), VS().gridConfigOf(before));
    commitStitch(ctx, res, "Edit Via Stitching");
  });
}
/** A stitch update committed, the other nets' zones over it refilled when its vias changed. */
export function commitStitch(ctx: ToolCtx, res: { changes: KChange[]; stitch: Stitch; changedVias: boolean }, label: string): void {
  ctx.commit(Object.assign(res.changes, { stitchUpdated: true }), label);
  ctx.requestRender();
  if (res.changedVias) refillAround(ctx, VS().zonesNeedingRefill(ctx.doc as KDoc, res.stitch));
}
/** GENERATOR_TOOL::refillAroundGenerators: the zones the new vias cut into, refilled in the same step. */
function refillAround(ctx: ToolCtx, ids: string[]): void {
  const zf = (window as unknown as { PcbZoneFill?: { run(ctx: ToolCtx, o: Record<string, unknown>): Promise<boolean> } }).PcbZoneFill;
  if (!ids.length || !zf) return;
  const filled = ids.filter((id) => { const it = (ctx.doc as KDoc).items.get(id); return !!it && !!kid(it.node, "filled_polygon"); });
  if (filled.length) void zf.run(ctx, { ids: filled, label: "Fill Zone(s)", amend: true });
}
/** ZONE_FILLER_TOOL::OnZonesFilled → GENERATOR_TOOL::RegenerateDirtyGenerators: the stitches over refilled zones of their net, updated into the fill's step. */
export function regenerateAfterFill(ctx: ToolCtx, zoneIds: string[]): void {
  const doc = ctx.doc as KDoc; if (!doc || doc.type !== "pcb" || ctx.viewOnly) return;
  const refill = new Set<string>(); let all: KChange[] = [];
  for (const id of VS().stitchesDirtiedByFill(doc, zoneIds)) {
    const it = doc.items.get(id); if (!it) continue; const st = VS().readStitch(it.node);
    const res = VS().viaStitchUpdate(doc, st, stitchOpts(), VS().gridConfigOf(VS().readStitch(it.node)));
    if (!res.changedVias && res.changes.length === 1) continue;
    all = all.concat(res.changes);
    if (res.changedVias) for (const z of VS().zonesNeedingRefill(doc, res.stitch)) refill.add(z);
  }
  if (!all.length) return;
  ctx.commit(Object.assign(all, { stitchUpdated: true }), "Fill Zone(s)", { amend: true });
  refillAround(ctx, [...refill].filter((z) => !zoneIds.includes(z)));
}

// ---------------------------------------------------------------- VIA_STITCH_TOOL
/** PCB_ACTIONS::excludeStitchVia: the selected stitch vias removed and kept out ("Exclude Via From Stitching"). */
export function excludeStitchVia(ctx: ToolCtx): boolean {
  const doc = ctx.doc as KDoc; if (!doc || ctx.viewOnly) return false;
  const ids = selectionIds().filter((id) => { const it = doc.items.get(id); return !!it && it.kind === "via" && !!VS().stitchOfVia(doc, id); });
  if (!ids.length) return false;
  const rm = PT().removedChange; if (!rm) return false;
  const changes = VS().excludeViaChanges(doc, ids).concat(ids.map((id) => rm(doc.items.get(id)!)));
  ctx.commit(changes, "Exclude Via From Stitching"); if (PT().applySelection) PT().applySelection!(ctx, []); ctx.requestRender(); return true;
}
/** PCB_ACTIONS::clearStitchViaExclusions: the selected stitches' exclusions cleared and the stitches updated. */
export function clearStitchViaExclusions(ctx: ToolCtx): boolean {
  const doc = ctx.doc as KDoc; if (!doc || ctx.viewOnly) return false;
  let all: KChange[] = []; let changed = false; const refill = new Set<string>();
  for (const id of selectionIds()) {
    const it = doc.items.get(id); if (!it || !VS().isViaStitch(it)) continue;
    const st = VS().readStitch(it.node); if (!VS().hasExclusions(st)) continue;
    const prev = VS().gridConfigOf(st); VS().clearAllExclusions(st);
    const res = VS().viaStitchUpdate(doc, st, stitchOpts(), prev); all = all.concat(res.changes); changed = changed || res.changedVias;
    if (res.changedVias) for (const z of VS().zonesNeedingRefill(doc, res.stitch)) refill.add(z);
  }
  if (!all.length) return false;
  ctx.commit(Object.assign(all, { stitchUpdated: true }), "Clear Via Stitching Exclusions"); ctx.requestRender();
  if (changed) refillAround(ctx, [...refill]);
  return true;
}
/** The selection menu's conditions: a stitch via picked / a stitch with exclusions picked. */
export function stitchMenuState(): { excludable: boolean; clearable: boolean } {
  const doc = E.kdoc as KDoc | null; if (!doc || doc.type !== "pcb" || !PT() || !PT().viaStitch) return { excludable: false, clearable: false };
  let excludable = false, clearable = false;
  for (const id of selectionIds()) {
    const it = doc.items.get(id); if (!it) continue;
    if (it.kind === "via" && VS().stitchOfVia(doc, id)) excludable = true;
    if (VS().isViaStitch(it) && VS().hasExclusions(VS().readStitch(it.node))) clearable = true;
  }
  return { excludable, clearable };
}
