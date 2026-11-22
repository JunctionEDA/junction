import type { SchCtx, Pt } from "./types";
import { root } from "../root";
import { commitSchArc, schArcClick } from "./arcs";
import { closePrompt, labelDefaults, promptImpl } from "./dom";
import { bezierNode, circleNode, ellipseArcAngles, ellipseFromBox, ellipseNode, polygonNode, polylineNode, rectangleNode, ruleAreaNode, sheetCorner, sheetNode, drawTableNode, textBoxNode } from "./nodes";
import { rememberPlaced } from "./repeat";
import { SHEET_EXT, nextPage, placeSheet, placeSheetNode, sheetFileFor, sheetInstance } from "./sheets";
import { K, S, kids, str } from "./state";
import { addNode, r4, same } from "./util";
import { simplify } from "./wire";

// ---------------------------------------------------------------- graphic shapes (KiCad's two/three-click drawing)
// S.draw = { shape, pts (fixed clicks), cur (cursor) }: rect and textbox take two corners, circle its
// centre then a radius point, arc its start, end and then a point on the arc, lines any number of
// points until Enter, a double click or a click on the last point.
export function drawPoint(ctx: SchCtx, mm: Pt) { return ctx.snap([mm[0], mm[1]]).map(r4); }
export function startDraw(ctx: SchCtx, shape: string, p: Pt) { S.draw = { shape, pts: [p], cur: p.slice() }; ctx.requestRender(); }
export function cancelDraw(ctx: SchCtx) { S.draw = null; closePrompt(); ctx.requestRender(); }
export function undoDrawPoint(ctx: SchCtx) { const d = S.draw; if (!d) return; if (d.pts.length > 1) d.pts.pop(); else S.draw = null; ctx.requestRender(); }
// ---- POLYGON_GEOM_MANAGER for the rule area (SCH_DRAWING_TOOLS::DrawRuleArea): unless the line mode is Free the
// outline reaches the cursor through a 45-degree leader that bends once, and a loop line of the same kind runs back
// to the first corner (build45DegLeader, updateTemporaryLines).
const snap45 = (v: Pt): Pt => {   // GetVectorSnapped45
  const ax = Math.abs(v[0]), ay = Math.abs(v[1]), T = Math.tan(Math.PI / 8);
  if (ay < ax * T) return [v[0], 0];
  if (ax < ay * T) return [0, v[1]];
  const m = Math.min(ax, ay); return [Math.sign(v[0]) * m, Math.sign(v[1]) * m];
};
const norm180 = (a: number) => { while (a <= -180) a += 360; while (a > 180) a -= 360; return a; };
const norm90 = (a: number) => { while (a < -90) a += 180; while (a > 90) a -= 180; return a; };
const deg = (v: Pt) => Math.atan2(v[1], v[0]) * 180 / Math.PI;
export function build45Leader(end: Pt, pts: Pt[]): Pt[] {
  if (!pts.length) return [];
  const last = pts[pts.length - 1], v: Pt = [end[0] - last[0], end[1] - last[1]];
  if (pts.length < 2) { const s = snap45(v); return [last, [r4(last[0] + s[0]), r4(last[1] + s[1])]]; }
  const prev = pts[pts.length - 2], lineA = deg(v), prevA = deg(snap45([last[0] - prev[0], last[1] - prev[1]]));
  const vertical = Math.abs(v[1]) > Math.abs(v[0]), horizontal = Math.abs(v[1]) < Math.abs(v[0]);
  const angDiff = Math.abs(norm180(lineA - prevA));
  let bendEnd = angDiff < 45 || (angDiff > 90 && angDiff < 135);
  if (Math.abs(Math.abs(norm90(prevA)) - 45) < 1e-9) bendEnd = !bendEnd;
  let mid: Pt = end;
  if (bendEnd) {
    if (vertical) mid = [last[0], v[1] > 0 ? end[1] - Math.abs(v[0]) : end[1] + Math.abs(v[0])];
    else if (horizontal) mid = [v[0] > 0 ? end[0] - Math.abs(v[1]) : end[0] + Math.abs(v[1]), last[1]];
  } else {
    if (vertical) mid = [end[0], v[1] > 0 ? last[1] + Math.abs(v[0]) : last[1] - Math.abs(v[0])];
    else if (horizontal) mid = [v[0] > 0 ? last[0] + Math.abs(v[1]) : last[0] - Math.abs(v[1]), end[1]];
  }
  return [last, [r4(mid[0]), r4(mid[1])], end];
}
/** The rule area's leader and loop lines for the cursor at `end`: { leader, loop } (loop empty in the Free line mode). */
export function ruleAreaLeader(pts: Pt[], end: Pt): { leader: Pt[]; loop: Pt[] } {
  if (!pts.length) return { leader: [], loop: [] };
  if (S.lineMode === "free") return { leader: [pts[pts.length - 1], end], loop: [] };
  return { leader: build45Leader(end, pts), loop: build45Leader(end, pts.slice().reverse()).reverse() };
}
/** RULE_AREA_CREATE_HELPER::OnComplete: the locked corners, in the 45 mode the leader and loop corners too, simplified as a closed outline. */
export function ruleAreaOutline(pts: Pt[], cur: Pt): Pt[] {
  if (pts.length < 3) return [];                    // "Just scrap the rule area in progress"
  const out = pts.map((p) => p.slice());
  if (S.lineMode !== "free") {
    const { leader, loop } = ruleAreaLeader(pts, cur);
    for (let i = 1; i < leader.length; i++) out.push(leader[i]);
    for (let i = 1; i < loop.length - 1; i++) out.push(loop[i]);
  }
  // SHAPE_LINE_CHAIN::Simplify on the closed outline, then the start point when it lies between its neighbours
  let ring = out.filter((p, i) => i === 0 || !same(p, out[i - 1]));
  while (ring.length > 1 && same(ring[ring.length - 1], ring[0])) ring.pop();
  for (let changed = true; changed && ring.length >= 3;) {
    changed = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]), dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
      if (same(a, b) || (Math.abs(cross) < 1e-9 && dot >= 0)) { ring.splice(i, 1); changed = true; break; }
    }
  }
  if (ring.length < 3) ring = [];
  return ring;
}
export function drawClick(ctx: SchCtx, shape: string, p: Pt, dbl = false) {
  if (shape === "arc") { schArcClick(ctx, p); return; }   // EE_GRAPHIC_TOOL::DrawArc and its five drawing modes
  const d = S.draw;
  if (shape === "sheet" && !d) {
    // DrawSheet: with the sheet just drawn still selected, a click on it is ignored and a double click enters it
    const sel = ctx.selected ? ctx.doc.items.get(ctx.selected.id) : null;
    const many = ctx.selection && ctx.selection.size > 1;
    if (sel && sel.kind === "sheet" && !many && sel.bbox && p[0] >= sel.bbox[0] && p[0] <= sel.bbox[2] && p[1] >= sel.bbox[1] && p[1] <= sel.bbox[3]) {
      if (dbl && sel.file && ctx.enterSheet) { S.internalSwitch = true; try { ctx.setTool("select"); } finally { S.internalSwitch = false; } ctx.enterSheet(sel.file); }
      return;
    }
  }
  if (!d || d.shape !== shape) { startDraw(ctx, shape, p); return; }
  d.cur = p.slice();
  const last = d.pts[d.pts.length - 1];
  if (shape === "rulearea") {
    // a double click or a click back on the first corner ends the outline (NewPointClosesOutline); any other click
    // locks the leader's corners in (POLYGON_GEOM_MANAGER::AddPoint)
    if (dbl || same(p, d.pts[0])) { finishDraw(ctx); return; }
    const { leader } = ruleAreaLeader(d.pts, p);
    if (leader.length > 1) d.pts.push(leader[leader.length - 2].slice(), leader[leader.length - 1].slice()); else d.pts.push(p);
    ctx.requestRender(); return;
  }
  if (shape === "lines" || shape === "polygon" || shape === "rulearea") {
    if (same(p, last)) { finishDraw(ctx); return; }
    if (shape !== "lines" && d.pts.length >= 3 && same(p, d.pts[0])) { finishDraw(ctx); return; }   // back on the first point closes it
    d.pts.push(p); ctx.requestRender(); return;
  }
  if (shape === "ellipse_arc") {                   // the box's two corners, then the start and end points (ELLIPSE_GEOM_MANAGER)
    if (d.pts.length === 1 && same(p, d.pts[0])) return;
    d.pts.push(p); if (d.pts.length === 4) finishDraw(ctx); else ctx.requestRender(); return;
  }
  if (shape === "bezier") {                        // start, control 1, end, then the far handle (BEZIER_GEOM_MANAGER)
    if (d.pts.length === 2 && same(p, d.pts[0])) { ctx.toast("The curve's end must differ from its start"); return; }
    d.pts.push(p); if (d.pts.length === 4) finishDraw(ctx); else ctx.requestRender(); return;
  }
  if (shape === "sheet") { d.pts.push(sheetCorner(d.pts[0], p, ctx.gridPitch)); finishDraw(ctx); return; }   // sizeSheet: never smaller than the minimum
  if (same(p, last) && shape !== "table") return;   // a zero-size shape is not a shape (a table is at least one cell)
  d.pts.push(p); finishDraw(ctx);
}
export function finishDraw(ctx: SchCtx) {
  const d = S.draw; if (!d) return;
  const doc = ctx.doc, pts = d.pts; let node = null, label = d.shape;
  if (d.shape === "rect") node = rectangleNode(pts[0], pts[1]), label = "rectangle";
  else if (d.shape === "ellipse") { node = ellipseNode(ellipseFromBox(pts[0], pts[1]), false); label = "Draw Ellipse"; }
  else if (d.shape === "ellipse_arc") { if (pts.length === 4) { const e = ellipseFromBox(pts[0], pts[1]); Object.assign(e, ellipseArcAngles(e, pts[2], pts[3])); node = ellipseNode(e, true); } label = "Draw Elliptical Arc"; }
  else if (d.shape === "circle") node = circleNode(pts[0], Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]));
  else if (d.shape === "arc") { commitSchArc(ctx, d, false); ctx.requestRender(); return; }
  else if (d.shape === "lines") { const p = simplify(pts); if (p.length >= 2) node = polylineNode(p); label = "lines"; }
  else if (d.shape === "polygon") { const p = simplify(pts); if (p.length >= 3) node = polygonNode(p); }
  else if (d.shape === "rulearea") { const p = ruleAreaOutline(pts, d.cur); if (p.length >= 3) node = ruleAreaNode(p); label = "Draw Rule Area"; }
  else if (d.shape === "bezier") {
    // KiCad's fourth click is the handle beyond the end: control 2 is its reflection over the end point
    if (pts.length === 4) { const e = pts[2], c2 = [r4(2 * e[0] - pts[3][0]), r4(2 * e[1] - pts[3][1])]; node = bezierNode(pts[0], pts[1], c2, e); }
  }
  else if (d.shape === "table") {
    // SCH_DRAWING_TOOLS::DrawTable: the second click fixes the table sized by the drag, then DIALOG_TABLE_PROPERTIES
    // opens on it; OK adds it ("Draw Table") and selects it, Cancel drops it
    const node = drawTableNode(pts[0], pts[1], ctx.gridPitch, labelDefaults().textSize);
    d.await = true; ctx.requestRender();
    const done = (n: SNode | null) => { if (S.draw !== d) return; S.draw = null; if (n) commitShape(ctx, n, "Draw Table"); ctx.requestRender(); };
    const T = root.CollabTableCells;
    if (T && T.newSchTableDialog && !ctx.viewOnly) { T.newSchTableDialog(ctx, node, done); return; }
    done(node); return;
  }
  else if (d.shape === "sheet") {
    // the rectangle is fixed; DIALOG_SHEET_PROPERTIES opens on "Untitled Sheet" / "untitled.kicad_sch", then the file is made
    d.await = true; ctx.requestRender();
    const KD = typeof root.KDialogs !== "undefined" ? root.KDialogs : null;
    if (KD && KD.schItemDialog && !ctx.viewOnly) {
      const pre = S.sheetPreset; S.sheetPreset = null;
      const sn = pre ? sheetNode(pts[0], pts[1], pre.name, pre.file) : sheetNode(pts[0], pts[1], "Untitled Sheet", "untitled" + SHEET_EXT);
      const inst = sheetInstance(ctx, ctx.doc, nextPage(ctx, ctx.doc)); if (inst) sn.push(inst);
      const it = { id: "", kind: "sheet", node: sn, geom: [], bbox: null };
      KD.schItemDialog(ctx, it, { cancel() { if (S.draw === d) { S.draw = null; ctx.requestRender(); } }, onCreate(staged) {
        if (S.draw !== d) return; S.draw = null;
        const fp = kids(staged, "property").find((q) => /^Sheet ?file$/i.test(str(q[1])));
        placeSheetNode(ctx, staged, fp ? str(fp[2]) : "untitled" + SHEET_EXT, pre ? "Import Sheet Copy" : "Draw Sheet");
      } });
      return;
    }
    promptImpl("Sheet name", "", S.cursorClient, (name) => {
      if (S.draw !== d) return;
      if (!name) { S.draw = null; ctx.requestRender(); return; }
      promptImpl("Sheet file", sheetFileFor(name), S.cursorClient, (file) => {
        if (S.draw !== d) return; S.draw = null;
        if (file) placeSheet(ctx, pts[0], pts[1], name, file); else ctx.requestRender();
      });
    });
    return;
  }
  else if (d.shape === "textbox") {
    // the box is fixed; DIALOG_TEXT_PROPERTIES opens for its text, Cancel drops the box
    d.await = true; ctx.requestRender();
    const KD = typeof root.KDialogs !== "undefined" ? root.KDialogs : null;
    if (KD && (KD.openNew as typeof KD.openNew | undefined) && !ctx.viewOnly) {
      const tb = textBoxNode("", pts[0], pts[1]);
      KD.openItem(ctx, { id: "", kind: "text_box", node: tb, geom: [], bbox: null }, { generic: true, cancel() { if (S.draw === d) { S.draw = null; ctx.requestRender(); } },
        onCreate(staged) { if (S.draw !== d) return; S.draw = null; commitShape(ctx, staged, "text box"); ctx.requestRender(); } });
      return;
    }
    promptImpl("Text box", "", S.cursorClient, (text) => { if (S.draw !== d) return; S.draw = null; if (text) commitShape(ctx, textBoxNode(text, pts[0], pts[1]), "text box"); ctx.requestRender(); });
    return;
  }
  S.draw = null;
  if (node) commitShape(ctx, node, label);
  ctx.requestRender();
}
export function commitShape(ctx: SchCtx, node: SNode, label: string) {
  const { item, change } = addNode(ctx.doc, node);
  ctx.commit([change], label);
  rememberPlaced(item.kind, item.node);
  S.sel = item.id; ctx.setSelected(null);
  return item;
}
