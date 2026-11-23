// pcb-tools/array.ts — Create Array / Arrange: ARRAY_OPTIONS and ARRAY_TOOL in nanometres.
import type { BoardDoc, PcbChange, Pt } from "./types";

/** ARRAY_OPTIONS as the dialog fills it in: a grid's or a circular array's fields (see arrayTransform), and the tool's own. */
export interface ArrayOpts {
  type: string; nx?: number; ny?: number; dx?: number; dy?: number; offX?: number; offY?: number; stagger?: number; staggerRows?: boolean;
  centred?: boolean; hThenV?: boolean; reverseAlt?: boolean;
  centre?: Pt; angle?: number; angleOffset?: number; clockwise?: boolean; count?: number; rotateItems?: boolean;
  arrange?: boolean; keepRefs?: boolean;
  /** ARRAY_OPTIONS::ShouldNumberItems / GetNumberingStartIsSpecified (the footprint editor's pad numbering) */
  shouldNumber?: boolean; numberingStartSpecified?: boolean;
  /** ARRAY_GRID_OPTIONS::m_2dArrayNumbering, m_pri_axis, m_sec_axis; a circular array numbers along `pri` (m_axis) */
  twoD?: boolean; pri?: ArrayAxis; sec?: ArrayAxis;
}
/** ARRAY_AXIS: the numbering type (NUMBERING_NUMERIC, _HEX, _ALPHA_NO_IOSQXZ, _ALPHA_FULL), offset, step, lowercase output. */
export interface ArrayAxis { type: number; offset: number; step: number; lower?: boolean }
/** One copy's move: the offset in mm and the rotation in degrees. */
export interface ArrayStep { offset: Pt; rot: number }
import { duplicateChanges, refProp } from "./clipboard";
import { expandGroups, groupMembers, parentOf } from "./groups";
import { K } from "./state";
import { anchorOf, rotateNode, selectionCenter, transformChanges, translateNode } from "./transforms";
import { r6, rotator } from "./util";
import { canHaveNumber } from "./pad-tool";

// ---------------------------------------------------------------- ARRAY_OPTIONS (common/array_options.cpp), in nanometres
export const AIU = 1e6;
/** ARRAY_OPTIONS::GetArraySize. */
export const arraySize = (o: ArrayOpts) => o.type === "circular" ? Math.max(0, Math.trunc(o.count!)) : Math.max(0, Math.trunc(o.nx!)) * Math.max(0, Math.trunc(o.ny!));
/** ARRAY_GRID_OPTIONS::getGridCoords. */
export function arrayGridCoords(o: ArrayOpts, n: number) {
  const axis = (o.hThenV ? o.nx : o.ny)!; let x = n % axis; const y = Math.trunc(n / axis);
  if (o.reverseAlt && (y % 2)) x = axis - x - 1;
  return [x, y];
}
/**
 * ARRAY_OPTIONS::GetTransform( n, aPos ): { offset (mm), rot (degrees) } for the n-th copy of an item whose position
 * (GetPosition) is pos.  Grid: o = { type: "grid", nx, ny, dx, dy, offX, offY (mm), stagger, staggerRows, centred, hThenV,
 * reverseAlt }; circular: o = { type: "circular", centre (mm), angle, angleOffset (degrees), clockwise, count, rotateItems }.
 */
export function arrayTransform(o: ArrayOpts, n: number, pos: Pt): ArrayStep {
  const iu = (v: number | undefined) => Math.round((v || 0) * AIU);
  if (o.type === "circular") {
    let a = !o.angle ? 360 * n / o.count! : o.angle * n;
    a += o.angleOffset || 0; if (o.clockwise) a = -a;
    const p = [iu(pos[0]), iu(pos[1])], c = [iu(o.centre![0]), iu(o.centre![1])];
    const [rx, ry] = rotator(a)(p[0] - c[0], p[1] - c[1]); const np = [Math.round(c[0] + rx), Math.round(c[1] + ry)];   // RotatePoint: KiROUND
    return { offset: [(np[0] - p[0]) / AIU, (np[1] - p[1]) / AIU], rot: o.rotateItems ? a : 0 };
  }
  let [cx, cy] = arrayGridCoords(o, n); if (!o.hThenV) [cx, cy] = [cy, cx];
  const dx = iu(o.dx), dy = iu(o.dy), ox = iu(o.offX), oy = iu(o.offY);
  let x = cx * dx + cy * ox, y = cy * dy + cx * oy;
  const st = Math.trunc(o.stagger || 0);
  if (Math.abs(st) > 1) {
    const S_ = Math.abs(st), sr = !!o.staggerRows, idx = (sr ? cy : cx) % S_, f = Math.sign(st) * idx;
    // VECTOR2I * double, then / int: each step truncates toward zero
    x += Math.trunc(Math.trunc((sr ? dx : ox) * f) / S_); y += Math.trunc(Math.trunc((sr ? oy : dy) * f) / S_);
  }
  if (o.centred) {
    const ex = (o.nx! - 1) * dx + (o.ny! - 1) * ox, ey = (o.ny! - 1) * dy + (o.nx! - 1) * oy;
    x -= Math.trunc(ex / 2); y -= Math.trunc(ey / 2);
  }
  return { offset: [x / AIU, y / AIU], rot: 0 };
}
/** arrayHasStackedPositions: two copies would land on the same offset and rotation. */
export function arrayStacked(o: ArrayOpts, pos: Pt) {
  const seen = new Set<string>();
  for (let i = 0; i < arraySize(o); i++) { const t = arrayTransform(o, i, pos); const k = `${Math.round(t.offset[0] * AIU)},${Math.round(t.offset[1] * AIU)},${r6(t.rot)}`; if (seen.has(k)) return true; seen.add(k); }
  return false;
}
// ---------------------------------------------------------------- ARRAY_AXIS (common/array_axis.cpp)
export const NUMBERING_NUMERIC = 0, NUMBERING_HEX = 1, NUMBERING_ALPHA_NO_IOSQXZ = 2, NUMBERING_ALPHA_FULL = 3;
/** ARRAY_AXIS::TypeIsNumeric. */
export const axisTypeIsNumeric = (type: number) => type === NUMBERING_NUMERIC || type === NUMBERING_HEX;
/** ARRAY_AXIS::GetAlphabet. */
export function axisAlphabet(type: number): string {
  switch (type) {
  case NUMBERING_HEX: return "0123456789ABCDEF";
  case NUMBERING_ALPHA_NO_IOSQXZ: return "ABCDEFGHJKLMNPRTUVWY";
  case NUMBERING_ALPHA_FULL: return "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  default: return "0123456789";
  }
}
/** schemeNonUnitColsStartAt0: the alphabetic schemes count A, B, … Z, AA (not BA) after Z. */
const nonUnitColsStartAt0 = (type: number) => type === NUMBERING_ALPHA_FULL || type === NUMBERING_ALPHA_NO_IOSQXZ;
/** AlphabeticFromIndex( size_t aN, aAlphabet, aZeroBasedNonUnitCols ) (common/increment.cpp); aN is unsigned, as the size_t is. */
export function alphabeticFromIndex(n: number, alphabet: string, zeroBasedNonUnitCols: boolean): string {
  let N = BigInt.asUintN(64, BigInt(Math.trunc(n))); const radix = BigInt(alphabet.length); let out = "", first = true;
  do {
    let modN = Number(N % radix);
    if (zeroBasedNonUnitCols && !first) modN--;   // start the "tens" column at Ax, not Bx
    out = alphabet[(modN + alphabet.length) % alphabet.length] + out;
    N /= radix; first = false;
  } while (N);
  return out;
}
/** ARRAY_AXIS::getNumberingOffset: the index a start text names in the axis's alphabet (null when it names none). */
export function axisNumberingOffset(type: number, str: string): number | null {
  if (!str.length) return null;
  const alphabet = axisAlphabet(type), radix = alphabet.length; let offset = 0;
  for (let i = 0; i < str.length; i++) {
    let ch = str[i];
    if (!axisTypeIsNumeric(type) && ch >= "a" && ch <= "z") ch = ch.toUpperCase();   // lowercase letters are accepted
    let chIndex = alphabet.indexOf(ch); if (chIndex < 0) return null;
    if (nonUnitColsStartAt0(type) && i < str.length - 1) chIndex++;   // "AA" is index 26, not 0
    offset = offset * radix + chIndex;
  }
  return offset;
}
/** ARRAY_AXIS::SetOffset( const wxString& ): false when the text does not decode; a lowercase start gives lowercase numbers. */
export function axisSetOffset(axis: ArrayAxis, text: string): boolean {
  const off = axisNumberingOffset(axis.type, text); if (off === null) return false;
  axis.lower = !axisTypeIsNumeric(axis.type) && !!text.length && text[0] >= "a" && text[0] <= "z";
  axis.offset = off; return true;
}
/** ARRAY_AXIS::GetItemNumber( n ): the name of the n-th point along the axis. */
export function axisItemNumber(axis: ArrayAxis, n: number): string {
  const r = alphabeticFromIndex(axis.offset + axis.step * n, axisAlphabet(axis.type), nonUnitColsStartAt0(axis.type));
  return axis.lower ? r.toLowerCase() : r;
}
/** ARRAY_GRID_OPTIONS::GetItemNumber / ARRAY_CIRCULAR_OPTIONS::GetItemNumber. */
export function arrayItemNumber(o: ArrayOpts, n: number): string {
  const pri = o.pri || { type: NUMBERING_NUMERIC, offset: 0, step: 1 };
  if (o.type !== "circular" && o.twoD) { const [x, y] = arrayGridCoords(o, n); return axisItemNumber(pri, x) + axisItemNumber(o.sec || { type: NUMBERING_NUMERIC, offset: 0, step: 1 }, y); }
  return axisItemNumber(pri, n);
}
/**
 * ARRAY_PAD_NUMBER_PROVIDER: the next item number not among `existing` (the numbers of the footprint's unselected pads),
 * counting from the first; a specified start (GetNumberingStartIsSpecified) reserves nothing.
 */
export function arrayPadNumberProvider(existing: Iterable<string>, o: ArrayOpts) {
  const reserved = new Set<string>(o.shouldNumber && o.numberingStartSpecified ? [] : existing); let index = 0;
  return { next(): string { let num: string; do { num = arrayItemNumber(o, index); index++; } while (reserved.has(num)); return num; } };
}

/** ARRAY_TOOL's origin: a lone item's position, else the selection's centre. */
export function arrayOrigin(doc: BoardDoc, ids: string[]) { const items = ids.map((id: string) => doc.items.get(id)).filter(Boolean) as KItem[]; return items.length === 1 ? anchorOf(items[0]) : selectionCenter(items); }
/** TransformItem: Move by the offset, then Rotate about the item's (new) position. */
export function arrayApply(node: SNode, t: ArrayStep, pos: Pt) { if (t.offset[0] || t.offset[1]) translateNode(node, t.offset[0], t.offset[1]); if (t.rot) rotateNode(node, pos[0] + t.offset[0], pos[1] + t.offset[1], t.rot); }
/** StrNumCmp( a, b, CMP_T::IGNORE_CASE ): digit runs compare as numbers, the rest letter by letter without case. */
export function strNumCmp(a: string, b: string): number {
  let i = 0, j = 0; const dig = (c: string) => c >= "0" && c <= "9";
  while (i < a.length && j < b.length) {
    if (dig(a[i]) && dig(b[j])) {
      let x = 0, y = 0; while (i < a.length && dig(a[i])) x = x * 10 + +a[i++]; while (j < b.length && dig(b[j])) y = y * 10 + +b[j++];
      if (x !== y) return x < y ? -1 : 1; continue;
    }
    const ca = a[i].toUpperCase(), cb = b[j].toUpperCase(); if (ca !== cb) return ca < cb ? -1 : 1; i++; j++;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}
/**
 * BOARD_REANNOTATE_TOOL::ReannotateDuplicates as ARRAY_TOOL calls it, block by block: `blocks` holds, per array cell in
 * the order the tool builds them, the block's footprints ({ key, ref, pos }); `used` maps a reference to the keys of
 * the footprints that carry it (the board's, then every block already built).  A footprint whose reference another
 * one carries counts up from its own number (UTIL::GetRefDesNumber, -1 without digits: 1 first) until it is free.
 * `skip` blocks are not reannotated (the first block built, or all of them with "keep").  Returns key -> reference.
 */
export function reannotateBlocks(used: Map<string, Set<string>>, blocks: { skip: boolean; fps: { key: string; ref: string; pos: Pt }[] }[]) {
  const out = new Map<string, string>(); const add = (ref: string, key: string) => { if (!used.has(ref)) used.set(ref, new Set()); used.get(ref)!.add(key); };
  for (const b of blocks) {
    if (!b.skip) {
      const fps = b.fps.slice().sort((p, q) => strNumCmp(p.ref, q.ref) || (p.pos[1] === q.pos[1] ? p.pos[0] - q.pos[0] : q.pos[1] - p.pos[1]));
      for (const fp of fps) {
        const m = /^(.*?)(\d*)$/.exec(fp.ref)!; const stem = m[1]; let value = m[2] ? parseInt(m[2], 10) : -1, ref = fp.ref, duplicate = false;
        while (used.has(ref)) {
          for (const k of used.get(ref)!) if (k !== fp.key) { duplicate = true; break; }
          if (!duplicate) break;
          value = value < 0 ? 1 : value + 1; ref = stem + value;
        }
        if (duplicate) add(ref, fp.key);
        fp.ref = ref;
      }
    }
    for (const fp of b.fps) { add(fp.ref, fp.key); out.set(fp.key, fp.ref); }
  }
  return out;
}
/**
 * ARRAY_TOOL::onDialogClosed.  Duplicate (o.arrange false): the tool runs the cells backwards so the originals go last:
 * a copy of the selection (BOARD_ITEM::Duplicate / PCB_GROUP::DeepDuplicate, copies in a group join it) lands in each
 * of the cells 0 … N-2 — the copy in cell 0 stays where the original was and keeps its reference — and the originals
 * themselves move to the last cell (TransformItem( arraySize - 1 )).  Unless o.keepRefs, every block but the first one
 * built is reannotated (ReannotateDuplicates), so the copies count up through the cells and the originals take the
 * last numbers.  "Create Array", the copies and the originals selected.  Arrange (o.arrange): the selected items, in
 * order, go one to a cell; each later item is first put where the first item now is (after its own transform), as
 * item->SetPosition( firstItem->GetPosition() ) does — "Arrange selection".  Returns { changes, ids, label }.
 */
export function arrayChanges(doc: BoardDoc, ids: string[], o: ArrayOpts) {
  const N = arraySize(o); const sel = new Set(ids); const out: { changes: PcbChange[]; ids: string[]; label: string } = { changes: [], ids: [], label: o.arrange ? "Arrange selection" : "Create Array" };
  // a generator (a tuning pattern) is a root like a group: PCB_GROUP::DeepDuplicate copies it with its members
  const coveredByGroup = (id: string) => { for (let g = parentOf(doc, id); g; g = parentOf(doc, g.id)) if (sel.has(g.id)) return true; return false; };
  const roots = ids.map((id: string) => doc.items.get(id)).filter((it: KItem | undefined) => it && !coveredByGroup(it.id)) as KItem[];
  const moveRoot = (it: KItem, fn: (n: SNode, it: KItem) => unknown) => { const members = Array.from(expandGroups(doc, [it.id])); out.changes.push(...transformChanges(doc, members, fn)); };
  if (o.arrange) {
    const first = roots[0]; if (!first) return out; const p0 = anchorOf(first), t0 = arrayTransform(o, 0, p0);
    roots.slice(0, N).forEach((it: KItem, i: number) => {
      const base: Pt = i === 0 ? p0 : [p0[0] + t0.offset[0], p0[1] + t0.offset[1]];
      const pos = anchorOf(it), t = i === 0 ? t0 : arrayTransform(o, i, base), d = [base[0] - pos[0], base[1] - pos[1]];
      if (!t.offset[0] && !t.offset[1] && !t.rot && !d[0] && !d[1]) return;
      moveRoot(it, (n: SNode) => { translateNode(n, d[0], d[1]); arrayApply(n, t, base); });
    });
    out.ids = roots.map((it: KItem) => it.id);
    return out;
  }
  const posOf = new Map(roots.map((it: KItem) => [it.id, anchorOf(it)] as [string, Pt]));
  // the footprints of each block (a root footprint, or one inside a root group), cell by cell in the tool's order
  const fpsOf = (it: KItem, acc: { fp: KItem; root: KItem }[], root: KItem) => { if (it.kind === "footprint") acc.push({ fp: it, root }); else if (it.kind === "group" || it.kind === "generated") for (const m of groupMembers(it.node)) { const c = doc.items.get(m); if (c) fpsOf(c, acc, root); } return acc; };
  const fps = roots.flatMap((it) => fpsOf(it, [], it));
  const used = new Map<string, Set<string>>(); for (const it of doc.items.values()) if (it.kind === "footprint") { const r = it.ref || ""; if (!used.has(r)) used.set(r, new Set()); used.get(r)!.add(it.id); }
  const blocks: Parameters<typeof reannotateBlocks>[1] = [];
  for (let k = 0; k < N; k++) blocks.push({ skip: !!o.keepRefs || k === 0, fps: fps.map(({ fp, root }) => {
    const rp = posOf.get(root.id)!, t = arrayTransform(o, k, rp), a = anchorOf(fp); let p: Pt = [a[0] + t.offset[0], a[1] + t.offset[1]];
    if (t.rot && fp !== root) { const [rx, ry] = rotator(t.rot)(p[0] - rp[0] - t.offset[0], p[1] - rp[1] - t.offset[1]); p = [rp[0] + t.offset[0] + rx, rp[1] + t.offset[1] + ry]; }
    return { key: k === N - 1 ? fp.id : `${k}:${fp.id}`, ref: fp.ref || "", pos: p };   // the last cell holds the originals themselves
  }) });
  const refs = reannotateBlocks(used, blocks);
  // ShouldNumberItems (footprint editor): each cell's pads, in the tool's order (the copies cell by cell, the originals
  // last), take ARRAY_PAD_NUMBER_PROVIDER's next number; the numbers of the unselected pads stay reserved
  const padNums = new Map<string, string>();
  if (o.shouldNumber && doc.fpEditor) {
    const selected = expandGroups(doc, ids), unchanging: string[] = [];
    for (const it of doc.items.values()) if (it.kind === "pad" && !selected.has(it.id)) unchanging.push(String(it.node[1] ?? ""));
    const provider = arrayPadNumberProvider(unchanging, o);
    for (let k = 0; k < N; k++) for (const it of roots) if (it.kind === "pad" && canHaveNumber(it.node)) padNums.set(k === N - 1 ? it.id : `${k}:${it.id}`, provider.next());
  }
  const setPadNum = (n: SNode, num: string | undefined) => { if (num !== undefined && n[0] === "pad") n[1] = num; };
  const setRef = (n: SNode, ref: string | undefined) => { if (ref === undefined || n[0] !== "footprint") return; const p = refProp(n); if (p && K.str(p[2]) !== ref) p[2] = ref; };
  for (let k = 0; k < N - 1; k++) {
    const r = duplicateChanges(doc, roots.map((it: KItem) => it.id), null, { annotations: "keep",
      xform: (n, root, src) => { const pos = posOf.get(root.id)!; arrayApply(n, arrayTransform(o, k, pos), pos); if (src && src.kind === "footprint") setRef(n, refs.get(`${k}:${src.id}`)); if (src === root) setPadNum(n, padNums.get(`${k}:${root.id}`)); } });
    out.changes.push(...r.changes); out.ids.push(...r.ids);
  }
  if (N >= 1) for (const it of roots) {
    const pos = posOf.get(it.id)!, t = arrayTransform(o, N - 1, pos); const renamed = fpsOf(it, [], it).some(({ fp }) => refs.get(fp.id) !== (fp.ref || ""));
    const num = padNums.get(it.id), renumbered = num !== undefined && num !== String(it.node[1] ?? "");
    if (t.offset[0] || t.offset[1] || t.rot || renamed || renumbered) moveRoot(it, (n: SNode, m: KItem) => { arrayApply(n, t, pos); if (m.kind === "footprint") setRef(n, refs.get(m.id)); if (m === it) setPadNum(n, num); });
  }
  out.ids.push(...roots.map((it: KItem) => it.id));
  return out;
}
