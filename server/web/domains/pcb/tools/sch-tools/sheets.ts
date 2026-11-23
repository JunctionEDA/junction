import type { SchCtx, Pt, SAtom, SheetJob, SheetPinPlace } from "./types";
import { GENERATOR_VERSION, SEXPR_SCHEMATIC_FILE_VERSION } from "../../canvas/format-version";
import { root } from "../root";
import { labelDefaults } from "./dom";
import { PIN_SIDE, sheetNode, sheetPinNode } from "./nodes";
import { rememberPlaced } from "./repeat";
import { mmPerPx } from "./snap";
import { K, S, atOf, kid, kids, num, str } from "./state";
import { addNode, deep, ghost, modChange, r4, segDist } from "./util";
import { strNumCmp, subsheetDoc } from "./erc";
import { switchTool } from "./junction";

// ---------------------------------------------------------------- hierarchical sheets (the sheet file lives on the server first)
export const SHEET_EXT = ".kicad_sch";
export const baseName = (p: SAtom | undefined) => str(p).split("/").pop()!;   // split always yields one part
export const dirName = (p: SAtom | undefined) => { const s = str(p).split("/"); s.pop(); return s.join("/"); };
export function joinPath(dir: string, file: string): string {
  const parts: string[] = [];
  for (const p of (dir + "/" + file).split("/")) {
    if (p === "..") parts.pop();
    else if (p && p !== ".") parts.push(p);
  }
  return parts.join("/");
}
function existingSheet(ctx: SchCtx, target: string, file: string) {
  const docs = schDocs(ctx), exact = docs.find(d => d.path === target) || docs.find(d => d.path === file);
  if (exact || file.includes("/")) return exact;
  const matches = docs.filter(d => baseName(d.path) === file);
  return matches.length === 1 ? matches[0] : undefined;
}
// Relative path from directory `dir` to `path` (both project-relative, "/" separated) — what Sheetfile holds.
export function relPath(dir: string, path: string) {
  const a = dir ? dir.split("/") : [], b = path.split("/"); let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}
export function schDocs(ctx: SchCtx) { return (ctx.docs || []).filter((d) => d && d.docType === "kicad_sch"); }
// The schematic doc being edited: ctx.docId when the app says, else the project's root sheet.
export function currentDoc(ctx: SchCtx) {
  const docs = schDocs(ctx);
  if (ctx.docId) { const d = docs.find((x) => x.docId === ctx.docId); if (d) return d; }
  if (ctx.docPath) return { path: ctx.docPath };
  const pro = (ctx.docs || []).find((d) => d && d.docType === "kicad_pro"), stem = pro ? baseName(pro.path).replace(/\.kicad_pro$/, "") : null;
  return (stem && docs.find((d) => baseName(d.path) === stem + SHEET_EXT)) || docs.slice().sort((x, y) => x.path.split("/").length - y.path.split("/").length || x.path.length - y.path.length)[0] || null;
}
export function normSheetFile(file: string) { file = str(file).trim().replace(/\\/g, "/").replace(/^\/+/, ""); if (!file) return ""; if (!/\.kicad_sch$/i.test(file)) file += SHEET_EXT; return file; }
export function sheetFileFor(name: string) { return normSheetFile(str(name).trim().replace(/[\\/:*?"<>|]+/g, "_")); }
/** A new sheet file: written at the root sheet's version, as SCH_IO_KICAD_SEXPR does for a sheet never loaded (0: current). */
export function emptySheetDoc(version = 0) { return `(kicad_sch (version ${version || SEXPR_SCHEMATIC_FILE_VERSION}) (generator "eeschema") (generator_version "${GENERATOR_VERSION}") (uuid "${K.newUuid()}") (paper "A4") (lib_symbols) (sheet_instances (path "/" (page "1"))))\n`; }
// Reference the project doc for a sheet file, creating it (POST …/docs, then snapshot 0) when there is none.
export async function ensureSheetDoc(ctx: SchCtx, file: string) {
  file = normSheetFile(file); if (!file) throw new Error("no sheet file name");
  const cur = currentDoc(ctx), dir = cur ? dirName(cur.path) : "", target = joinPath(dir, file);
  const found = existingSheet(ctx, target, file);
  if (found) return { file: relPath(dir, found.path), docId: found.docId, created: false };
  if (typeof ctx.api !== "function" || !ctx.project || !ctx.project.projectId) throw new Error("this session cannot create sheet files");
  // the server's reply: the new (or existing) document's id and path
  const res = (await ctx.api(`/api/projects/${ctx.project.projectId}/docs`, { method: "POST", body: JSON.stringify({ path: target, docType: "kicad_sch" }) })) as { docId?: string; path?: string; existing?: boolean } | null;
  if (!res || !res.docId) throw new Error("no document id returned");
  if (!res.existing) await ctx.api(`/api/docs/${res.docId}/snapshots?seq=0`, { method: "POST", headers: { "content-type": "text/plain" }, body: emptySheetDoc(Number((ctx.doc as { version?: number } | null)?.version) || 0) });   // the open sheet's version: the project's
  const entry = { docId: res.docId as string, path: res.path || target, docType: "kicad_sch" };
  if (Array.isArray(ctx.docs) && !ctx.docs.some((d) => d && d.docId === entry.docId)) ctx.docs.push(entry);
  return { file, docId: entry.docId, created: !res.existing };
}
// The sheet path and project name this screen's symbols and sheets record in their instance data:
// a sheet's instance path is the path of the sheet *containing* it, the same path its symbols use.
export function sheetPathHere(doc: KDoc) {
  const paths = new Map<string, number>(), names = new Map<string, number>(), vote = (m: Map<string, number>, k: string) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol" && it.kind !== "sheet") continue;
    for (const inst of kids(it.node, "instances")) for (const pr of kids(inst, "project")) { vote(names, str(pr[1])); for (const pa of kids(pr, "path")) vote(paths, str(pa[1])); }
  }
  const top = (m: Map<string, number>) => { let best: string | null = null, bn = 0; for (const [k, n] of m) if (n > bn) { bn = n; best = k; } return best; };
  return { path: top(paths), project: top(names) };
}
// SCH_SHEET_LIST::GetNextPageNumber: the smallest positive integer no sheet instance of the hierarchy has as its page
// (pages that are not numbers do not count).  The hierarchy's pages come from the editor (S.hierarchyPages); without
// them, the pages this screen and its loaded sub-sheets record stand in.
export function nextPage(ctx: SchCtx, doc: KDoc) {
  const used = new Set<number>(), take = (t: string) => { if (/^\s*[+-]?\d+\s*$/.test(t)) { const n = parseInt(t, 10); if (n > 0) used.add(n); } };
  const pagesOf = (d: KDoc) => { for (const it of d.items.values()) if (it.kind === "sheet") for (const inst of kids(it.node, "instances")) for (const pr of kids(inst, "project")) for (const pa of kids(pr, "path")) { const pg = kid(pa, "page"); if (pg) take(str(pg[1])); } };
  let all: string[] | null = null; try { all = S.hierarchyPages ? S.hierarchyPages() : null; } catch (e) { all = null; }
  if (all) for (const p of all) take(p);
  else {
    take(str((doc as KDoc & { pageNumber?: string }).pageNumber || "1"));
    const subs = ctx.sheetDocs ? (ctx.sheetDocs instanceof Map ? [...ctx.sheetDocs.values()] : Object.values(ctx.sheetDocs)) : [];
    for (const d of subs) if (d && typeof d !== "string") pagesOf(d);
  }
  pagesOf(doc);   // the sheets drawn since the hierarchy was read
  let n = 1;
  while (used.has(n)) n++;
  return n;
}
export function sheetInstance(ctx: SchCtx, doc: KDoc, page: number) {
  const { path, project } = sheetPathHere(doc);
  const pro = (ctx.docs || []).find((d) => d && d.docType === "kicad_pro");
  const name = project || (pro ? baseName(pro.path).replace(/\.kicad_pro$/, "") : "") || (ctx.project && ctx.project.name) || "";
  if (!path || !name) return null;
  return ["instances", ["project", name, ["path", path, ["page", String(page)]]]];
}
// Place a sheet: make sure its file is a project doc, then commit the sheet node.  One at a time;
// clicks are ignored while the request is out, and a document switch drops the result.
export function placeSheet(ctx: SchCtx, a: Pt, b: Pt, name: string, file: string) {
  const label = "Draw Sheet";
  if (S.sheetJob) { ctx.toast("Still creating the previous sheet…"); return S.sheetJob.promise; }
  const doc = ctx.doc, job: SheetJob = { doc, promise: null }; S.sheetJob = job;
  job.promise = (async () => {
    try {
      const ref = await ensureSheetDoc(ctx, normSheetFile(file));
      if (S.sheetJob !== job || ctx.doc !== doc) return null;
      const node = sheetNode(a, b, name, ref.file);
      const inst = sheetInstance(ctx, doc, nextPage(ctx, doc)); if (inst) node.push(inst);
      const { item, change } = addNode(doc, node);
      ctx.commit([change], label, { newSheet: true });
      rememberPlaced(item.kind, item.node);
      ctx.setSelected({ id: item.id });
      return item;
    } catch (e) { ctx.toast("Could not create the sheet: " + ((e && (e as Error).message) || e), 4000); return null; }
    finally { if (S.sheetJob === job) S.sheetJob = null; ctx.requestRender(); }
  })();
  return job.promise;
}
// The sheet from DIALOG_SHEET_PROPERTIES: its file is linked (after asking, when it exists) or created, then the sheet is added.
export function placeSheetNode(ctx: SchCtx, node: SNode, file: string, label = "Draw Sheet") {
  if (S.sheetJob) { ctx.toast("Still creating the previous sheet…"); return S.sheetJob.promise; }
  const doc = ctx.doc, job: SheetJob = { doc, promise: null }; S.sheetJob = job;
  job.promise = (async () => {
    try {
      file = normSheetFile(file);
      const cur = currentDoc(ctx), dir = cur ? dirName(cur.path) : "", target = joinPath(dir, file);
      const exists = existingSheet(ctx, target, file);
      if (exists && root.KDialogs && root.KDialogs.confirm && !(await root.KDialogs.confirm("Confirmation", `'${baseName(file)}' already exists.\n\nLink '${target}' to this file?`))) return null;
      const ref = await ensureSheetDoc(ctx, file);
      if (S.sheetJob !== job || ctx.doc !== doc) return null;
      const fp = kids(node, "property").find((q) => /^Sheet ?file$/i.test(str(q[1]))); if (fp) fp[2] = ref.file;
      const { item, change } = addNode(doc, node);
      ctx.commit([change], label, { newSheet: true });
      rememberPlaced(item.kind, item.node);
      ctx.setSelected({ id: item.id });
      return item;
    } catch (e) { ctx.toast("Could not create the sheet: " + ((e && (e as Error).message) || e), 4000); return null; }
    finally { if (S.sheetJob === job) S.sheetJob = null; ctx.requestRender(); }
  })();
  return job.promise;
}
/** A sheet border near a point: the sheet, the side, the distance and the sheet's box. */
export interface SheetEdge { item: KItem; side: string; d: number; x: number; y: number; w: number; h: number }
// The sheet border within tol of p and its nearest side (SCH_SHEET_PIN::ConstrainOnEdge's NearestSegment).
export function sheetEdgeAt(doc: KDoc, p: Pt, tol: number) {
  let best: SheetEdge | null = null;
  for (const it of doc.items.values()) {
    if (it.kind !== "sheet") continue;
    const [x, y] = atOf(it.node), s = kid(it.node, "size"), w = num(s && s[1], 0), h = num(s && s[2], 0);
    const edges: Record<string, Pt[]> = { top: [[x, y], [x + w, y]], right: [[x + w, y], [x + w, y + h]], bottom: [[x, y + h], [x + w, y + h]], left: [[x, y], [x, y + h]] };
    for (const side of ["top", "right", "bottom", "left"]) { const d = segDist(p, edges[side][0], edges[side][1]); if (d <= tol && (!best || d < best.d)) best = { item: it, side, d, x, y, w, h }; }
  }
  return best;
}
// The pin sits on the edge, its free coordinate grid-snapped and clamped to the edge (ConstrainOnEdge).
export function sheetPinPoint(ctx: SchCtx, edge: SheetEdge, p: Pt) {
  const g = ctx.snap([p[0], p[1]]), clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  if (edge.side === "left") return [r4(edge.x), r4(clamp(g[1], edge.y, edge.y + edge.h))];
  if (edge.side === "right") return [r4(edge.x + edge.w), r4(clamp(g[1], edge.y, edge.y + edge.h))];
  if (edge.side === "top") return [r4(clamp(g[0], edge.x, edge.x + edge.w)), r4(edge.y)];
  return [r4(clamp(g[0], edge.x, edge.x + edge.w)), r4(edge.y + edge.h)];
}
/** The sheet under a point (SCH_SELECTION_TOOL::SelectPoint for SCH_SHEET_T: anywhere over its body or border). */
export function sheetAt(doc: KDoc, p: Pt, tol: number): KItem | null {
  let best: KItem | null = null, area = Infinity;
  for (const it of doc.items.values()) {
    if (it.kind !== "sheet") continue;
    const [x, y] = atOf(it.node), s = kid(it.node, "size"), w = num(s && s[1], 0), h = num(s && s[2], 0);
    if (p[0] < x - tol || p[0] > x + w + tol || p[1] < y - tol || p[1] > y + h + tol) continue;
    if (w * h < area) { best = it; area = w * h; }   // the smallest of nested boxes
  }
  return best;
}
/** SCH_SHEET_PIN::ConstrainOnEdge( pos, true ): the nearest side of this sheet and the point on it. */
export function constrainOnEdge(ctx: SchCtx, sheet: KItem, p: Pt): { p: Pt; side: string } {
  const [x, y] = atOf(sheet.node), s = kid(sheet.node, "size"), w = num(s && s[1], 0), h = num(s && s[2], 0);
  const edges: Record<string, Pt[]> = { top: [[x, y], [x + w, y]], right: [[x + w, y], [x + w, y + h]], bottom: [[x, y + h], [x + w, y + h]], left: [[x, y], [x, y + h]] };
  let side = "left", d = Infinity;
  for (const k of ["left", "right", "top", "bottom"]) { const e = segDist(p, edges[k][0], edges[k][1]); if (e < d) { d = e; side = k; } }
  const edge: SheetEdge = { item: sheet, side, d, x, y, w, h };
  return { p: sheetPinPoint(ctx, edge, p) as Pt, side };
}
/**
 * SCH_DRAWING_TOOLS::importHierLabel: the sub-sheet's hierarchical labels by StrNumCmp (ignoring case), the first
 * one the sheet has no pin for; null when every label has one.
 */
export function importHierLabel(sheet: KItem, sub: KDoc): { name: string; shape: string } | null {
  const have = new Set<string>(kids(sheet.node, "pin").map((p) => str(p[1])));
  const labels = Array.from(sub.items.values()).filter((o) => o.kind === "hierarchical_label").map((o) => { const sh = kid(o.node, "shape"); return { name: str(o.node[1]), shape: sh ? str(sh[1]) : "input" }; });
  labels.sort((a, b) => strNumCmp(a.name.toUpperCase(), b.name.toUpperCase()));
  return labels.find((l) => !have.has(l.name)) || null;
}
/** The sheet's sub-sheet document: from ctx.sheetDocs at once, else read through ctx.loadSheetDoc. */
function sheetDocOf(ctx: SchCtx, sheet: KItem): KDoc | Promise<KDoc | null> | null {
  const d = ctx.sheetDocs ? subsheetDoc(ctx.sheetDocs, sheet) : null; if (d) return d;
  return ctx.loadSheetDoc ? ctx.loadSheetDoc(sheet) : null;
}
/**
 * Place Sheet Pins (SCH_DRAWING_TOOLS::TwoClickPlace, isSheetPin): the first click over a sheet (or the selected
 * sheet) takes its next unplaced hierarchical label and a pin of that name and shape rides the sheet's edge with the
 * cursor; the next click places it and the following label comes up, until "No new hierarchical labels found.".
 */
export function sheetPinClick(ctx: SchCtx, mm: Pt) {
  if (S.pinPlace) { placePinPlace(ctx, mm); return null; }
  let sheet = S.pinSheet ? ctx.doc.items.get(S.pinSheet) || null : null;
  if (!sheet) sheet = sheetAt(ctx.doc, mm, Math.max(0.5, 4 * mmPerPx(ctx)));
  if (!sheet) { ctx.toast("Click over a sheet.", 2000); return null; }
  S.pinSheet = sheet.id;
  beginPinPlace(ctx, sheet, mm);
  return sheet;
}
export function beginPinPlace(ctx: SchCtx, sheet: KItem, mm: Pt): void {
  const got = sheetDocOf(ctx, sheet);
  const go = (sub: KDoc | null): void => {
    if (S.tool !== "sheetpin" || S.pinPlace) return;
    const cur = ctx.doc.items.get(sheet.id); if (!cur) return;
    if (!sub) { ctx.toast("The sheet's file is not loaded", 2000); return; }
    const label = importHierLabel(cur, sub);
    // the message, then `break` out of TwoClickPlace's event loop: the tool ends and selection resumes
    if (!label) { ctx.toast("No new hierarchical labels found.", 2000); S.pinSheet = null; switchTool(ctx, "select"); ctx.requestRender(); return; }
    S.pinPlace = { sheetId: cur.id, name: label.name, shape: label.shape, node: cur.node, item: null, p: [0, 0], side: "left" };
    movePinPlace(ctx, S.cursor || mm);
  };
  if (got && typeof (got as Promise<KDoc | null>).then === "function") (got as Promise<KDoc | null>).then(go, () => go(null)); else go(got as KDoc | null);
}
/** The pin follows the cursor along the sheet's edge (SCH_SHEET_PIN::ConstrainOnEdge); its ghost is the sheet with it. */
export function movePinPlace(ctx: SchCtx, mm: Pt): void {
  const pp = S.pinPlace; if (!pp) return;
  const sheet = ctx.doc.items.get(pp.sheetId); if (!sheet) { S.pinPlace = null; ctx.requestRender(); return; }
  const at = constrainOnEdge(ctx, sheet, mm);
  if (pp.item && pp.p[0] === at.p[0] && pp.p[1] === at.p[1] && pp.side === at.side) return;
  const ts = labelDefaults().textSize;   // createNewSheetPin: m_DefaultTextSize
  let node: SNode;
  if (pp.move) node = movedPinNode(pp.move.orig, pp.move.index, at.p, at.side);
  else {
    node = deep(sheet.node); const pin = sheetPinNode(pp.name, at.p, at.side, ts); pin[2] = pp.shape;
    const i = node.findIndex((c) => Array.isArray(c) && c[0] === "instances"); if (i >= 0) node.splice(i, 0, pin); else node.push(pin);
  }
  // the ghost is the sheet with the new pin, under a uuid of its own so it never stands in for the real sheet
  const g = deep(node); const u = g.findIndex((c) => Array.isArray(c) && c[0] === "uuid"); if (u >= 0) g.splice(u, 1);
  pp.node = node; pp.p = at.p; pp.side = at.side; pp.item = ghost(ctx.doc, g);
  ctx.requestRender();
}
export function cancelPinPlace(ctx: SchCtx): void {
  const pp = S.pinPlace; S.pinPlace = null;
  if (pp && pp.move) endPinMove(ctx, pp, null);
  ctx.requestRender();
}
/** The sheet node with its pin `index` moved to p on `side` (SCH_SHEET_PIN::SetPosition + SetSide: angle and spin style). */
export function movedPinNode(orig: SNode, index: number, p: Pt, side: string): SNode {
  const node = deep(orig), pin = kids(node, "pin")[index]; if (!pin) return node;
  const [rot, just] = PIN_SIDE[side] || PIN_SIDE.left;
  K.setAt(pin, r4(p[0]), r4(p[1]), rot);
  let ef = kid(pin, "effects"); if (!ef) { ef = ["effects"]; pin.push(ef); }
  const j = kid(ef, "justify"), extra = j ? j.slice(1).filter((v) => v !== "left" && v !== "right") : [], nj: SNode = ["justify", just, ...extra];
  const ji = ef.findIndex((c) => Array.isArray(c) && c[0] === "justify"); if (ji >= 0) ef[ji] = nj; else ef.push(nj);
  return node;
}
/**
 * SCH_MOVE_TOOL with a sheet pin selected (Move, Drag, or a held-button drag of the selected pin): the pin rides the
 * sheet's edge with the cursor (SCH_SHEET_PIN::ConstrainOnEdge), the sheet shown without it meanwhile; a click (or
 * the release of the button) places it.  Drag takes the wire ends on the pin along.  Returns false when there is no
 * such pin.
 */
export function beginSheetPinMove(ctx: SchCtx, sheetId: string, name: string, mm: Pt, byPointer = false, drag = S.dragMode === "drag"): boolean {
  if (ctx.viewOnly) { ctx.toast("View-only access"); return false; }
  const sheet = ctx.doc.items.get(sheetId); if (!sheet || sheet.kind !== "sheet") return false;
  const pins = kids(sheet.node, "pin"), index = pins.findIndex((q) => str(q[1]) === name); if (index < 0) return false;
  const orig = deep(sheet.node), pin = pins[index], a = atOf(pin);
  switchTool(ctx, "sheetpin");
  // the sheet without the pin while it moves (restored before the commit, as the drag engine does)
  const at0: Pt = [a[0], a[1]];
  const rest = deep(orig), ri = rest.indexOf(kids(rest, "pin")[index]); rest.splice(ri, 1);
  sheet.node.length = 0; for (const c of rest) sheet.node.push(c); K.replaceChange(ctx.doc, sheet);
  S.pinPlace = { sheetId, name, shape: str(pin[2] || "input"), node: orig, item: null, p: at0, side: "", move: { orig, index, byPointer, drag, at0 } };
  movePinPlace(ctx, byPointer ? mm : at0);
  return true;
}
function endPinMove(ctx: SchCtx, pp: SheetPinPlace, place: { p: Pt; side: string } | null): void {
  const mv = pp.move!, sheet = ctx.doc.items.get(pp.sheetId);
  if (sheet) { sheet.node.length = 0; for (const c of deep(mv.orig)) sheet.node.push(c); K.replaceChange(ctx.doc, sheet); }
  if (sheet && place && (place.p[0] !== mv.at0[0] || place.p[1] !== mv.at0[1] || PIN_SIDE[place.side][0] !== (atOf(kids(mv.orig, "pin")[mv.index])[2] || 0))) {
    const changes = [modChange(ctx.doc, sheet, movedPinNode(mv.orig, mv.index, place.p, place.side))];
    // Drag: the wire ends on the pin follow it (getConnectedDragItems)
    if (mv.drag) for (const it of ctx.doc.items.values()) {
      if (it.kind !== "wire" && it.kind !== "bus") continue;
      const q = K.ptsOf(it.node); if (q.length !== 2) continue;
      const hit = q.map((v: number[]) => Math.abs(v[0] - mv.at0[0]) < 1e-4 && Math.abs(v[1] - mv.at0[1]) < 1e-4);
      if (!hit[0] && !hit[1]) continue;
      const n = deep(it.node), np = q.map((v: number[], i: number) => (hit[i] ? [r4(place.p[0]), r4(place.p[1])] : v.slice())); K.setPts(n, np); changes.push(modChange(ctx.doc, it, n));
    }
    ctx.commit(changes, mv.drag ? "Drag" : "Move");
  }
  switchTool(ctx, "select");
  // the pin stays selected (finalizeMoveOperation)
  const sel = (ctx as SchCtx & { selectPins?: (p: { id: string; number: string }[]) => void }).selectPins;
  if (sel && ctx.doc.items.get(pp.sheetId)) sel([{ id: pp.sheetId, number: pp.name }]);
}
function placePinPlace(ctx: SchCtx, mm: Pt): void {
  const pp = S.pinPlace; if (!pp) return;
  if (pp.move) { movePinPlace(ctx, mm); const q = S.pinPlace; S.pinPlace = null; if (q) endPinMove(ctx, q, { p: q.p, side: q.side }); ctx.requestRender(); return; }
  movePinPlace(ctx, mm);
  const sheet = ctx.doc.items.get(pp.sheetId); S.pinPlace = null; if (!sheet) return;
  // commit.Modify( sheet ); sheet->AddPin( pin )
  const node = deep(sheet.node), pin = deep(kids(pp.node, "pin").find((q) => str(q[1]) === pp.name && !kids(sheet.node, "pin").some((o) => str(o[1]) === pp.name && uuidOfNode(o) === uuidOfNode(q)))!);
  const i = node.findIndex((c) => Array.isArray(c) && c[0] === "instances"); if (i >= 0) node.splice(i, 0, pin); else node.push(pin);
  ctx.commit([modChange(ctx.doc, sheet, node)], "Add Sheet Pin");
  // the next unplaced label follows the cursor
  const cur = ctx.doc.items.get(pp.sheetId); if (cur) beginPinPlace(ctx, cur, S.cursor || mm);
  ctx.requestRender();
}
const uuidOfNode = (n: SNode): string => { const u = kid(n, "uuid"); return u ? str(u[1]) : ""; };
// The pin goes into a clone of the sheet node after the fields (before instance data), committed as a whole-item change.
export function placeSheetPin(ctx: SchCtx, sheet: KItem, name: string, p: Pt, side: string) {
  const node = deep(sheet.node), pin = sheetPinNode(name, p, side);
  const at = node.findIndex((c) => Array.isArray(c) && c[0] === "instances");
  if (at >= 0) node.splice(at, 0, pin); else node.push(pin);
  ctx.commit([modChange(ctx.doc, sheet, node)], "Add Sheet Pin");
  ctx.requestRender();
  return pin;
}
