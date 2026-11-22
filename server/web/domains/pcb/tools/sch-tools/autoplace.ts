import type { SchCtx, Pt, Box } from "./types";
import { carried, editable, selectedItems } from "./commands";
import { isPowerSymbol } from "./dom";
import { isLockedNode } from "./lock";
import { isNetLine } from "./drag";
import { autoplaceSheetFields, fontNode } from "./nodes";
import { K, S, atOf, kid, kids, num, ptsOf, str } from "./state";
import { deep, dropKid, modChange, r4, replaceKid } from "./util";

// ---------------------------------------------------------------- symbol pins with their electrical type (lib symbol + transform)
/** A symbol pin on the sheet: its connection point, the root at the body, number, name, electrical type and side. */
export interface SymPin { x: number; y: number; root: Pt; number: string; name: string; type: string; hidden: boolean; len: number; side: string; shape?: string; libRot?: number }
export function symbolPins(doc: KDoc, item: Pick<KItem, "node">): SymPin[] {
  const n = item.node, out: SymPin[] = [];
  const libId = str((kid(n, "lib_name") || kid(n, "lib_id") || [])[1]);
  const lib = K.resolveLib(doc, libId) || K.resolveLib(doc, str((kid(n, "lib_id") || [])[1])); if (!lib) return out;
  const [ax, ay, rot] = atOf(n), mN = kid(n, "mirror"), T = K.symbolTransform(rot, mN ? str(mN[1]) : "");
  const unit = kid(n, "unit") ? num(kid(n, "unit")![1], 1) : 1, styleN = kid(n, "body_style") || kid(n, "convert"), style = styleN ? num(styleN[1], 1) : 1;
  const tf = (lx: number, ly: number): Pt => [r4(ax + T[0] * lx + T[1] * ly), r4(ay + T[2] * lx + T[3] * ly)];
  for (const sub of kids(lib, "symbol")) {
    const m = str(sub[1]).match(/_(\d+)_(\d+)$/); const u = m ? +m[1] : 0, s = m ? +m[2] : 1;
    if ((u !== 0 && u !== unit) || (m && s !== 0 && s !== style)) continue;   // unit 0 / body style 0 = common to all
    for (const g of kids(sub, "pin")) {
      const [px, py, pr] = atOf(g), lenN = kid(g, "length"), len = lenN ? num(lenN[1]) : 2.54;
      const dir = ((Math.round(pr) % 360) + 360) % 360, d = dir === 0 ? [1, 0] : dir === 90 ? [0, 1] : dir === 180 ? [-1, 0] : [0, -1];
      const pos = tf(px, py), root = tf(px + d[0] * len, py + d[1] * len);
      const h = kid(g, "hide"); const hidden = h ? str(h[1]) !== "no" : g.includes("hide");
      let ox = pos[0] - root[0], oy = pos[1] - root[1]; const ol = Math.hypot(ox, oy) || 1; ox = Math.round(ox / ol); oy = Math.round(oy / ol);
      if (!ox && !oy) { const tip = tf(px - d[0], py - d[1]); ox = Math.sign(tip[0] - pos[0]); oy = Math.sign(tip[1] - pos[1]); }
      out.push({ x: pos[0], y: pos[1], root, number: str((kid(g, "number") || [])[1]), name: str((kid(g, "name") || [])[1]), type: str(g[1]) || "passive", hidden, len,
        side: ox > 0 ? "right" : ox < 0 ? "left" : oy < 0 ? "top" : "bottom", shape: str(g[2]) || "line", libRot: dir });
    }
  }
  return out;
}
export function symbolLibId(node: SNode) { return str((kid(node, "lib_id") || [])[1]); }
export function symbolIsPower(doc: KDoc, item: Pick<KItem, "node">) { const ln = kid(item.node, "lib_name"); return (!!ln && isPowerSymbol(doc, str(ln[1]))) || isPowerSymbol(doc, symbolLibId(item.node)); }
// SCH_PIN::IsGlobalPower: a power input of a global power symbol, or (legacy) a hidden power input of any symbol
// that is not a local power symbol ((power local) in KiCad 10).
export function globalPowerPin(doc: KDoc, item: KItem, pin: SymPin) {
  if (pin.type !== "power_in") return false;
  const lib = K.resolveLib(doc, symbolLibId(item.node)) || doc.lib.get(symbolLibId(item.node)), pw = lib && kid(lib, "power");
  if (pw && pw.includes("local")) return false;
  if (pw) return true;
  return !!pin.hidden;
}

// ---------------------------------------------------------------- autoplace fields (eeschema/autoplace_fields.cpp)
// Worked in KiCad's schematic internal units (100 nm) with its integer arithmetic (int division truncates, KiROUND
// rounds half away from zero), so the fields land on exactly the coordinates the desktop writes.
export const AP_HPADDING = 0.635, AP_VPADDING = 0.381, AP_GRID = 1.27, AP_WIRE_V = 2.54, AP_FIELD_PADDING = 0.381;
const IU = 1e4, HPAD = 6350, VPAD = 3810, GRID50 = 12700, WIRE_V = 25400;
export const SIDES: Record<string, Pt> = { right: [1, 0], top: [0, -1], left: [-1, 0], bottom: [0, 1] };
const kiround = (v: number) => (v < 0 ? -Math.round(-v) : Math.round(v));
const toIU = (mm: number) => kiround(mm * IU);
const idiv = (a: number, b: number) => Math.trunc(a / b);
const mmOf = (v: number) => r4(v / IU);
// round_n: up or down to the next multiple of n (C++ % and / on ints)
const roundIU = (v: number, n: number, up: boolean) => (v % n ? n * (idiv(v, n) + (up ? 1 : 0)) : v);
export function roundN(v: number, n: number, up: boolean) { return mmOf(roundIU(toIU(v), toIU(n), up)); }
export function fieldHidden(p: SNode) { const h = kid(p, "hide"); if (h) return str(h[1]) !== "no"; const ef = kid(p, "effects"); return !!(ef && (ef.includes("hide") || (kid(ef, "hide") && str(kid(ef, "hide")![1]) !== "no"))); }
const yesFlag = (n: SNode | undefined | null, key: string) => !!n && (n.includes(key) || (!!kid(n, key) && str(kid(n, key)![1]) !== "no"));
export function fieldFont(p: SNode) { const ef = kid(p, "effects"), f = ef && kid(ef, "font"), s = f && kid(f, "size"), th = f && kid(f, "thickness"); const size = s ? num(s[2], num(s[1], 1.27)) : 1.27; const bold = yesFlag(f, "bold"); const thick = th && num(th[1]) > 0.001 ? num(th[1]) : Math.min(bold ? size / 5 : size / 8, size / 4); return { size, thick, bold }; }
/** EDA_TEXT::GetEffectiveTextPenWidth (default pen 0) in IU. */
export function textPenIU(p: SNode): number {
  const ef = kid(p, "effects"), f = ef && kid(ef, "font"), s = f && kid(f, "size"), th = f && kid(f, "thickness");
  const h = toIU(s ? num(s[1], 1.27) : 1.27), w = toIU(s ? num(s[2], num(s[1], 1.27)) : 1.27), bold = yesFlag(f, "bold");
  let pen = th ? toIU(num(th[1])) : 0;
  if (pen <= 1) pen = bold ? kiround(w / 5) : kiround(w / 8);
  else if (bold) pen = kiround(pen * 1.6);
  return Math.min(pen, kiround(Math.min(Math.abs(w), Math.abs(h)) * 0.25));
}
/** EDA_TEXT::GetTextBox size for the stroke font, single line, in IU: StringBoundaryLimits (glyph advances, each
 *  KiROUNDed, less the inter-character gap, grown by 1.5 pen each side), 17% taller, plus the overbar offset. */
export function textBoxIU(p: SNode, text?: string): { w: number; h: number } {
  const ef = kid(p, "effects"), f = ef && kid(ef, "font"), s = f && kid(f, "size");
  const h = toIU(s ? num(s[1], 1.27) : 1.27), w = toIU(s ? num(s[2], num(s[1], 1.27)) : 1.27), pen = textPenIU(p);
  const t = K.parseMarkup(text != null ? text : str(p[2])).text, adv = K.strokeAdvance;
  let cur = 0; for (const ch of t) { if (ch === "\t") continue; cur += kiround((ch === " " ? adv(" ") : adv(ch)) * w); }
  const grow = 2 * kiround(pen * 1.5), ex = Math.abs(cur - kiround(w * 0.2)) + grow, ey = h + grow;

  return { w: ex, h: ey + kiround(ey * 0.17) + ((text != null ? text : str(p[2])).includes("~{") ? idiv(ey, 6) : 0) };
}
// EDA_TEXT::GetTextBox for the stroke font, in mm (kept for the other users of the field's extent).
export function fieldExtent(p: SNode) { const b = textBoxIU(p); return { w: mmOf(b.w), h: mmOf(b.h) }; }
type BoxIU = [number, number, number, number];
const merge = (b: BoxIU | null, x0: number, y0: number, x1: number, y1: number): BoxIU => (b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1]);
/** The lib symbol's units and body styles this symbol draws (unit 0 / body style 0 are common to all). */
function drawnSubs(lib: SNode, n: SNode, allUnits: boolean): SNode[] {
  const unit = kid(n, "unit") ? num(kid(n, "unit")![1], 1) : 1, styleN = kid(n, "body_style") || kid(n, "convert"), style = styleN ? num(styleN[1], 1) : 1;
  return kids(lib, "symbol").filter((sub) => { const m = str(sub[1]).match(/_(\d+)_(\d+)$/); const u = m ? +m[1] : 0, s = m ? +m[2] : 1; return allUnits || !((u !== 0 && u !== unit) || (m && s !== 0 && s !== style)); });
}
/** LIB_SYMBOL::GetBodyBoundingBox( unit, bodyStyle, false, false ) turned by the symbol's transform and placed: every
 *  drawing's box grown by half its stroke (EDA_SHAPE::getBoundingBox), the roots of the visible pins, no fields. In IU. */
function bodyBoxIU(doc: KDoc, item: Pick<KItem, "node">): BoxIU {
  const n = item.node, libId = str((kid(n, "lib_name") || kid(n, "lib_id") || [])[1]);
  const lib = K.resolveLib(doc, libId) || K.resolveLib(doc, symbolLibId(n));
  const [ax, ay, rot] = atOf(n), mN = kid(n, "mirror"), T = K.symbolTransform(rot, mN ? str(mN[1]) : "");
  // lib coordinates as KiCad holds them (IU, Y down)
  let b: BoxIU | null = null;
  const pt = (x: number, y: number): [number, number] => [toIU(x), -toIU(y)];
  const take = (pts: [number, number][], grow: number) => { for (const [x, y] of pts) b = merge(b, x - grow, y - grow, x + grow, y + grow); };
  const half = (g: SNode) => { const st = kid(g, "stroke"), w = st && kid(st, "width"); return idiv(Math.max(0, w ? toIU(num(w[1])) : 0), 2); };
  if (lib) for (const sub of drawnSubs(lib, n, false)) for (const g of sub.slice(2)) {
    if (!Array.isArray(g) || yesFlag(g, "private")) continue;
    const gk = g[0];
    if (gk === "rectangle") { const a = kid(g, "start"), e = kid(g, "end"); if (a && e) take([pt(num(a[1]), num(a[2])), pt(num(e[1]), num(e[2]))], half(g)); }
    else if (gk === "circle") { const c = kid(g, "center"), r = toIU(num((kid(g, "radius") || [])[1])); if (c) { const [x, y] = pt(num(c[1]), num(c[2])); take([[x - r, y - r], [x + r, y + r]], half(g)); } }
    else if (gk === "arc") {
      const s0 = kid(g, "start"), m0 = kid(g, "mid"), e0 = kid(g, "end"); if (!s0 || !e0) continue;
      const P = [s0, m0 || s0, e0].map((k) => pt(num(k[1]), num(k[2])));
      const pts: [number, number][] = [P[0], P[2]];
      const arc = m0 && K.arcFrom3 ? K.arcFrom3(P[0], P[1], P[2]) : null;
      if (arc && isFinite(arc.r)) {
        // EDA_SHAPE::computeArcBBox: the ends plus every axis point the sweep (start -> mid -> end) passes
        const ang = (q: [number, number]) => Math.atan2(q[1] - arc.y, q[0] - arc.x), norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const a0 = ang(P[0]), am = norm(ang(P[1]) - a0), ae = norm(ang(P[2]) - a0), ccw = am <= ae, sweep = ccw ? ae : 2 * Math.PI - ae;
        for (let q = 0; q < 4; q++) { const a = q * Math.PI / 2, d = ccw ? norm(a - a0) : norm(a0 - a); if (d > 0 && d < sweep) pts.push([kiround(arc.x + arc.r * Math.cos(a)), kiround(arc.y + arc.r * Math.sin(a))]); }
      } else pts.push(P[1]);
      take(pts, half(g));
    }
    else if (gk === "polyline") take(ptsOf(g).map(([x, y]) => pt(x, y)), half(g));
    else if (gk === "bezier") { const c = ptsOf(g); const curve = c.length >= 3 ? K.bezierPts(c) : c; take(curve.map(([x, y]: number[]) => pt(x, y)), half(g)); }
    else if (gk === "text" || gk === "text_box") {
      const [tx, ty] = atOf(g); if (fieldHidden(g)) continue;
      if (gk === "text_box") { const sz = kid(g, "size"); if (sz) take([pt(tx, ty), pt(tx + num(sz[1]), ty + num(sz[2]))], 0); continue; }
      const tb = textBoxIU(g, str(g[1])), [x, y] = pt(tx, ty), vert = Math.round(num(atOf(g)[2])) % 180 !== 0;
      const hw = idiv(vert ? tb.h : tb.w, 2), hh = idiv(vert ? tb.w : tb.h, 2); take([[x - hw, y - hh], [x + hw, y + hh]], 0);
    }
    else if (gk === "pin") {
      if (yesFlag(g, "hide")) continue;
      const [px, py, pr] = atOf(g), lenN = kid(g, "length"), len = lenN ? num(lenN[1]) : 2.54;
      const dir = ((Math.round(pr) % 360) + 360) % 360, d = dir === 0 ? [1, 0] : dir === 90 ? [0, 1] : dir === 180 ? [-1, 0] : [0, -1];
      const [x, y] = pt(px, py), L = toIU(len); take([[x + d[0] * L, y - d[1] * L]], 0);
    }
  }
  const ox = toIU(ax), oy = toIU(ay);
  if (!b) return [ox, oy, ox, oy];
  const Ti = [T[0], -T[1], T[2], -T[3]];   // KiCad's TRANSFORM on its Y-down lib coordinates
  const tc = (x: number, y: number) => [Ti[0] * x + Ti[1] * y, Ti[2] * x + Ti[3] * y];
  const [p0, p1] = [tc(b[0], b[1]), tc(b[2], b[3])];
  return [Math.min(p0[0], p1[0]) + ox, Math.min(p0[1], p1[1]) + oy, Math.max(p0[0], p1[0]) + ox, Math.max(p0[1], p1[1]) + oy];
}
// The body box (SCH_SYMBOL::GetBodyBoundingBox): the library drawing (no pins, no fields) plus the visible pin roots, on the sheet.
export function bodyBox(doc: KDoc, item: Pick<KItem, "node">): Box { return bodyBoxIU(doc, item).map(mmOf) as Box; }
export const boxW = (b: Box) => b[2] - b[0], boxH = (b: Box) => b[3] - b[1];
export function boxesIntersect(a: Box | null, b: Box | null) { return a && b && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }
/** Every pin of every unit and body style (SCH_SYMBOL::GetGraphicalPins( ALL_UNITS, ALL_BODY_STYLES )), with its side. */
function allPinsIU(doc: KDoc, n: SNode): { side: string; hidden: boolean; pos: [number, number]; root: [number, number] }[] {
  const lib = K.resolveLib(doc, str((kid(n, "lib_name") || kid(n, "lib_id") || [])[1])) || K.resolveLib(doc, symbolLibId(n)); if (!lib) return [];
  const [ax, ay, rot] = atOf(n), mN = kid(n, "mirror"), T = K.symbolTransform(rot, mN ? str(mN[1]) : ""), ox = toIU(ax), oy = toIU(ay);
  const tf = (x: number, y: number): [number, number] => [ox + T[0] * x + T[1] * y, oy + T[2] * x + T[3] * y];   // file lib coordinates (IU, Y up) -> sheet
  const out: { side: string; hidden: boolean; pos: [number, number]; root: [number, number] }[] = [];
  for (const sub of drawnSubs(lib, n, true)) for (const g of kids(sub, "pin")) {
    const [px, py, pr] = atOf(g), lenN = kid(g, "length"), L = toIU(lenN ? num(lenN[1]) : 2.54);
    const dir = ((Math.round(pr) % 360) + 360) % 360, d = dir === 0 ? [1, 0] : dir === 90 ? [0, 1] : dir === 180 ? [-1, 0] : [0, -1];
    const x = toIU(px), y = toIU(py), pos = tf(x, y), root = tf(x + d[0] * L, y + d[1] * L);
    // PinDrawOrient: the direction from the connection point into the body; the pin sits on the opposite side
    const v = [T[0] * d[0] + T[1] * d[1], T[2] * d[0] + T[3] * d[1]];
    const side = v[0] > 0 ? "left" : v[0] < 0 ? "right" : v[1] > 0 ? "top" : "bottom";
    out.push({ side, hidden: yesFlag(g, "hide"), pos, root });
  }
  return out;
}
/** SCH_SYMBOL::GetFields( visible only ): shown, non-empty, in ordinal order (the mandatory fields first). */
const MANDATORY = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
function autoplaceFields(node: SNode): SNode[] {
  const all = kids(node, "property").filter((p) => !fieldHidden(p) && !str(p[1]).startsWith("ki_") && str(p[2]) !== "");
  const ord = (p: SNode) => { const i = MANDATORY.indexOf(str(p[1])); return i >= 0 ? i : MANDATORY.length; };
  return all.map((p, i) => ({ p, i })).sort((a, b) => ord(a.p) - ord(b.p) || a.i - b.i).map((e) => e.p);
}
// Fields placed by "O" in this session (AUTOPLACE_MANUAL); the file only says "yes", which loads as AUTOPLACE_AUTO.
export const manualAutoplaced = new Set<string>();
/** The algorithm a symbol's own edits re-run (GetFieldsAutoplaced): null when its fields are not autoplaced. */
export function autoplaceAlgo(item: Pick<KItem, "node"> & { id?: string }): { manual: boolean } | null {
  const fa = kid(item.node, "fields_autoplaced"); if (!fa || str(fa[1]) === "no") return null;
  return { manual: !!item.id && manualAutoplaced.has(item.id) };
}
/** EESCHEMA_SETTINGS m_AutoplaceFields (Preferences > Schematic Editor > Editing Options), pushed in by the prefs. */
export function apPrefs(): { enable: boolean; justify: boolean; align: boolean } {
  const a = S.autoplace; return { enable: !a || a.enable !== false, justify: !a || a.justify !== false, align: !a || a.align !== false };
}
export function autoplaceNode(doc: KDoc, item: KItem, opts?: { manual?: boolean } | null) {
  // no algorithm given: the one the symbol's fields were last placed with (SCH_ITEM::GetFieldsAutoplaced): AUTO after a
  // load, a placement or a copy, MANUAL once Autoplace Fields (O) ran on it here; edits re-autoplace with it
  opts = opts || {};
  const manual = opts.manual === undefined ? !!item.id && manualAutoplaced.has(item.id) : opts.manual !== false, prefs = apPrefs();
  const node = deep(item.node);
  // AUTOPLACER: m_is_power_symbol = !m_symbol->IsInNetlist(), i.e. the reference on this sheet path starts with '#'
  const inst = K.symbolInstance(item.node, doc.instancePath), refP = kids(item.node, "property").find((p) => str(p[1]) === "Reference");
  const power = (inst ? inst.ref : refP ? str(refP[2]) : "").startsWith("#");
  const fields = autoplaceFields(node).filter((p) => !yesFlag(p, "do_not_autoplace"));
  if (!fields.length) return null;
  const [, , rot] = atOf(node), mN = kid(node, "mirror"), mirror = mN ? str(mN[1]) : "", T = K.symbolTransform(rot, mirror);
  const fieldRot = T[1] !== 0 ? 90 : 0;                          // vertical storage counters the transform: fields always display horizontally
  const flipStored = (T[1] !== 0 ? T[1] : T[0]) < 0;             // the canvas (and IsHorizJustifyFlipped) render the stored justify flipped
  const body = bodyBoxIU(doc, { node }), symW = body[2] - body[0], symH = body[3] - body[1];
  // the boxes are those of the shown text (SCH_FIELD::GetBoundingBox -> GetShownText): unit suffix on the reference,
  // variables resolved, "Name: " prefix; the canvas geometry holds exactly that text
  const shownText = new Map<string, string>();
  for (const g of item.geom || []) if (g.t === "text" && g.field && typeof g.field === "string" && typeof g.text === "string" && !shownText.has(g.field)) shownText.set(g.field, g.text);
  const ext = fields.map((p) => textBoxIU(p, shownText.get(str(p[1]))));
  const pins = allPinsIU(doc, node).filter((p) => !p.hidden || power);
  // computeFBoxSize( dynamic )
  let fbox = { w: Math.max(...ext.map((e) => e.w)), h: ext.reduce((t, e) => t + (prefs.align ? roundIU(e.h, GRID50, true) : e.h + VPAD), 0) };
  const pinsOn = (side: string) => pins.filter((p) => p.side === side).length;
  // getPreferredSides
  let sides = ["right", "top", "left", "bottom"].map((s) => ({ side: s, pins: pinsOn(s) }));
  const swap = (i: number, j: number) => { const t = sides[i]; sides[i] = sides[j]; sides[j] = t; };
  const orient = ((Math.round(rot) % 360) + 360) % 360;
  if (power) { if (orient === 0) { swap(0, 1); swap(1, 3); } else if (orient === 90) { swap(0, 2); swap(1, 2); } else if (orient === 180) swap(0, 3); else if (orient === 270) swap(1, 2); }
  else { if (mirror === "x" && (orient === 0 || orient === 180)) swap(0, 2); if (symW / symH > 3.0) { swap(0, 1); swap(1, 3); } }
  // fieldBoxPlacement
  const place = (sp: { side: string; pins: number }, size: { w: number; h: number }): [number, number] => {
    const [sx, sy] = SIDES[sp.side], cx = body[0] + idiv(symW, 2), cy = body[1] + idiv(symH, 2);
    let ox = idiv(symW + size.w, 2), oy = idiv(symH + size.h, 2); if (sx) ox += HPAD; else if (sy) oy += VPAD;
    let x = cx + sx * ox - idiv(size.w, 2), y = cy + sy * oy - idiv(size.h, 2);
    if (sp.pins > 0) {
      let pb: BoxIU | null = null; for (const p of pins) if (p.side === sp.side) for (const q of [p.pos, p.root]) pb = merge(pb, q[0], q[1], q[0], q[1]);
      if (pb) { if (sy) x = pb[2] + 2 * HPAD; else y = pb[1] - (size.h + 2 * VPAD); }
    }
    return [x, y];
  };
  // chooseSideForFields (manual: sides whose field box collides with other items go last)
  // getPossibleCollisions / filterCollisions: another symbol counts with its body-and-pins box and each of its visible
  // fields on its own; every SCH_LINE (wire, bus, two-point graphic line) is a line; the rest by bounding box
  type Collider = { box: BoxIU; line: Pt[] | null };
  const colliders: Collider[] = [];
  for (const it of doc.items.values()) {
    if (it === item || it.id === item.id || !it.bbox) continue;
    if (it.kind === "symbol") {
      let sb: BoxIU | null = bodyBoxIU(doc, it); for (const p of allPinsIU(doc, it.node)) for (const q of [p.pos, p.root]) sb = merge(sb, q[0], q[1], q[0], q[1]);
      if (sb) colliders.push({ box: sb, line: null });
      for (const f of K.fieldBoxes(it)) { const xs = f.pts.map((q) => toIU(q[0])), ys = f.pts.map((q) => toIU(q[1])); colliders.push({ box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], line: null }); }
      continue;
    }
    const pts = ptsOf(it.node), line = isNetLine(it.kind) || (it.kind === "polyline" && pts.length === 2);
    colliders.push({ box: (it.bbox as number[]).map(toIU) as BoxIU, line: line ? pts : null });
  }
  const hits = (box: BoxIU) => colliders.filter((c) => { const b = c.box; return b[0] <= box[2] && b[2] >= box[0] && b[1] <= box[3] && b[3] >= box[1]; });
  const horiz = (c: Collider) => !!c.line && c.line.length > 1 && toIU(c.line[0][1]) === toIU(c.line[c.line.length - 1][1]);
  // getDrawableArea: the page inside the drawing sheet's margins; a field box that leaves it collides
  const page = doc.page, ds = (doc as { drawingSheet?: { setup?: { left: number; right: number; top: number; bottom: number } } | null }).drawingSheet, su = (ds && ds.setup) || { left: 10, right: 10, top: 10, bottom: 10 };   // DS_DATA_MODEL default margins
  const area: BoxIU | null = page ? [toIU(su.left), toIU(su.top), toIU(page[0] - su.right), toIU(page[1] - su.bottom)] : null;
  const checkArea = !!area && area[2] - area[0] > 0 && area[3] - area[1] > 0;
  const collision = (sp: { side: string; pins: number }) => {
    const [x, y] = place(sp, fbox), box: BoxIU = [x, y, x + fbox.w, y + fbox.h]; let coll = "none";
    for (const c of hits(box)) { if (c.line && !SIDES[sp.side][0]) coll = horiz(c) && coll !== "objects" ? "hwires" : "objects"; else coll = "objects"; }
    if (checkArea && !(box[0] >= area![0] && box[1] >= area![1] && box[2] <= area![2] && box[3] <= area![3])) coll = "objects";
    return coll;
  };
  sides.reverse();
  let side = { side: "right", pins: Infinity };
  if (manual) {
    const colliding = new Map<string, string>(); for (const s of ["right", "top", "left", "bottom"]) { const c = collision({ side: s, pins: pinsOn(s) }); if (c !== "none") colliding.set(s, c); }
    for (const kind of ["objects", "hwires"]) sides = sides.filter((sp) => { if (colliding.get(sp.side) !== kind) return true; if (sp.pins <= side.pins) side = { side: sp.side, pins: sp.pins }; return false; });
  }
  let chosen: { side: string; pins: number } | null = null;
  for (let i = sides.length - 1; i >= 0; i--) if (!sides[i].pins) { chosen = sides[i]; break; }
  if (!chosen) { for (const sp of sides) if (sp.pins <= side.pins) side = { side: sp.side, pins: sp.pins }; chosen = side; }
  let [bx, by] = place(chosen, fbox);
  const [sx, sy] = SIDES[chosen.side];
  // fitFieldsBetweenWires: only horizontal wires in the way -> fixed 100 mil rows on the wire pitch
  let wireSpacing = false;
  if (manual && sy) {
    const found = hits([bx, by, bx + fbox.w, by + fbox.h]);
    if (found.length && found.every(horiz)) {
      const offs = new Set(found.map((c) => 3 * WIRE_V / 2 - (toIU(c.line![0][1]) % WIRE_V)));
      if (offs.size === 1) { wireSpacing = true; fbox = { w: fbox.w, h: fields.length * WIRE_V }; by = roundIU(by, WIRE_V, chosen.side === "bottom"); }
    }
  }
  // move the fields
  let lastY = by;
  fields.forEach((p, i) => {
    let ef = kid(p, "effects"); if (!ef) { ef = ["effects", fontNode(1.27)]; p.push(ef); }
    const cur = kid(ef, "justify"), curH = cur ? (cur.includes("left") ? "left" : cur.includes("right") ? "right" : "center") : "center";
    let hj: string;   // the justification as displayed
    if (prefs.justify) { hj = sx ? (sx > 0 ? "left" : "right") : "center"; if (chosen!.pins > 0) hj = sy ? "left" : "center"; }
    else hj = flipStored ? (curH === "left" ? "right" : curH === "right" ? "left" : "center") : curH;
    let x = hj === "left" ? bx : hj === "right" ? bx + fbox.w : bx + idiv(fbox.w, 2);
    const fh = wireSpacing ? WIRE_V / 2 : ext[i].h, pad = wireSpacing ? WIRE_V / 2 : prefs.align ? roundIU(fh, GRID50, true) - fh : VPAD;
    let y = lastY + idiv(pad, 2) + idiv(fh, 2); lastY += pad + fh;
    if (prefs.align) { if (sx) x = roundIU(x, GRID50, sx >= 0); if (sy) y = roundIU(y, GRID50, sy >= 0); }
    const a = kid(p, "at"); const keep = a ? a.slice(4) : [];
    replaceKid(p, ["at", mmOf(x), mmOf(y), fieldRot, ...keep]);
    if (prefs.justify) {
      const stored = flipStored ? (hj === "left" ? "right" : hj === "right" ? "left" : "center") : hj;
      const rest = cur ? cur.slice(1).filter((t) => t === "mirror") : [];
      if (stored === "center" && !rest.length) dropKid(ef, "justify"); else replaceKid(ef, ["justify", ...(stored === "center" ? [] : [stored]), ...rest]);
    }
  });
  dropKid(node, "fields_autoplaced");
  const ui = node.findIndex((c) => Array.isArray(c) && c[0] === "uuid");
  node.splice(ui >= 0 ? ui : node.length, 0, ["fields_autoplaced", "yes"]);
  if (item.id) { if (manual) manualAutoplaced.add(item.id); else manualAutoplaced.delete(item.id); }
  return node;
}
export function autoplaceSelection(ctx: SchCtx, opts?: { manual?: boolean } | null) {
  if (!editable(ctx)) return false;
  const cr = carried(ctx);   // the symbol being placed
  if (cr) { if (cr.item.kind !== "symbol") return false; const n = autoplaceNode(ctx.doc, cr.item, opts || { manual: true }); if (n) cr.write(n); return !!n; }
  const changes: KChange[] = [];
  // SCH_EDIT_TOOL::AutoplaceFields skips the items that IsLocked()
  for (const it of selectedItems(ctx)) {
    if (isLockedNode(it.node)) continue;
    if (it.kind === "sheet") {   // SCH_SHEET::AutoplaceFields, then the item is flagged autoplaced
      const n = deep(it.node); autoplaceSheetFields(n);
      const fa = kid(n, "fields_autoplaced"); if (fa) fa[1] = "yes"; else { const ui = n.findIndex(c => Array.isArray(c) && c[0] === "stroke"); n.splice(ui >= 0 ? ui : n.length, 0, ["fields_autoplaced", "yes"]); }
      if (JSON.stringify(n) !== JSON.stringify(it.node)) changes.push(modChange(ctx.doc, it, n));
      continue;
    }
    if (it.kind !== "symbol") continue;
    const n = autoplaceNode(ctx.doc, it, opts || { manual: true }); if (n) changes.push(modChange(ctx.doc, it, n));
  }
  if (!changes.length) return false;
  ctx.commit(changes, "autoplace fields"); return true;
}

/**
 * SCH_LABEL_BASE::AutoplaceFields (a label dropped by TwoClickPlace, AUTOPLACE_AUTO): every field takes the angle and
 * the horizontal justification of the label's spin style; the Intersheetrefs field goes beside the body (labelLen, the
 * longer side of the body box, plus twice the text offset), any other field half a text height (and, on a global
 * label, its frame) to the side.  Null when the label has no fields.
 */
export function autoplaceLabelNode(kind: string, src: SNode, labelLen = 0): SNode | null {
  if (!kids(src, "property").length) return null;
  const node = deep(src), [lx, ly, lr] = atOf(node);
  const ef = kid(node, "effects"), f = ef && kid(ef, "font"), sz = f && kid(f, "size");
  const textH = toIU(sz ? num(sz[1], 1.27) : 1.27);
  const margin = kiround(K.schFormat.textOffsetRatio * textH) * 2, len = toIU(labelLen);
  let accumulated = idiv(textH, 2);
  if (kind === "global_label") accumulated += margin + textPenIU(node) + margin;
  const spin = ((Math.round(lr || 0) % 360) + 360) % 360;   // 0 right, 90 up, 180 left, 270 bottom
  for (const p of kids(node, "property")) {
    const pf = kid(p, "effects"), pfont = pf && kid(pf, "font"), ps = pfont && kid(pfont, "size");
    const fh = toIU(ps ? num(ps[1], 1.27) : 1.27), inter = /^intersheet ?refs$/i.test(str(p[1]));
    let ox = 0, oy = 0, angle = 0, hj = "left";
    if (spin === 90) { angle = 90; hj = "left"; if (inter) oy = -(len + margin); else ox = accumulated + idiv(fh, 2); }
    else if (spin === 0) { angle = 0; hj = "left"; if (inter) ox = len + margin; else oy = accumulated + idiv(fh, 2); }
    else if (spin === 270) { angle = 90; hj = "right"; if (inter) oy = len + margin; else ox = accumulated + idiv(fh, 2); }
    else { angle = 0; hj = "right"; if (inter) ox = -(len + margin); else oy = accumulated + idiv(fh, 2); }
    const a = kid(p, "at"), keep = a ? a.slice(4) : [];
    replaceKid(p, ["at", mmOf(toIU(lx) + ox), mmOf(toIU(ly) + oy), angle, ...keep]);
    let e = kid(p, "effects"); if (!e) { e = ["effects", fontNode(1.27)]; p.push(e); }
    const cur = kid(e, "justify"), rest = cur ? cur.slice(1).filter((t) => t !== "left" && t !== "right") : [];
    replaceKid(e, ["justify", hj, ...rest]);
    if (inter) accumulated += fh + margin;
  }
  dropKid(node, "fields_autoplaced");
  const ui = node.findIndex((c) => Array.isArray(c) && c[0] === "uuid");
  node.splice(ui >= 0 ? ui : node.length, 0, ["fields_autoplaced", "yes"]);
  return node;
}
