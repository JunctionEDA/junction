// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/domains/pcb/canvas/index.ts — edit these modules, not the bundle).
import { PCB_KINDS, SCH_KINDS, addItem } from "./doc";
import { FP_KINDS, applyFootprintHeader } from "./footprint-doc";
import { buildGeom } from "./geom";
import { atOf, isList, kid, kids, num, parseAll, ptsOf, rotator, str, uuidOf } from "./sexpr";
import { shiftTable } from "./tables-images";
import type { Doc, WireChange } from "./types";
// ---------------------------------------------------------------- ops
export function fragmentItems(doc: Doc, sexpr: string): SNode[] {
  const out: SNode[] = [];
  for (const tree of parseAll(sexpr)) {
    if (tree[0] === "kicad_sch" || tree[0] === "kicad_pcb") {
      const ls = kid(tree, "lib_symbols"); if (ls) for (const s of kids(ls, "symbol")) doc.lib.set(str(s[1]), s);
      for (const c of tree.slice(1)) if (isList(c) && (doc.type === "sch" ? SCH_KINDS.has(c[0]) : doc.fpEditor ? FP_KINDS.has(c[0] as string) : PCB_KINDS.has(c[0]))) out.push(c);
    } else if (tree[0] === "lib_symbols") { for (const s of kids(tree, "symbol")) doc.lib.set(str(s[1]), s); }
    else out.push(tree);
  }
  return out;
}

export function setAt(node: SNode, x: number | undefined, y: number | undefined, rot?: number): void {
  const t = kid(node, "transform");
  if (t) {
    let tr = kid(t, "translate"); if (!tr) { tr = ["translate", 0, 0]; t.push(tr); }
    let ro = kid(t, "rotate"); if (!ro) { ro = ["rotate", 0]; t.push(ro); }
    if (x !== undefined) tr[1] = x; if (y !== undefined) tr[2] = y; if (rot !== undefined) ro[1] = rot;
    return;
  }
  let a = kid(node, "at");
  if (!a) { a = ["at", 0, 0]; node.splice(2, 0, a); }
  if (x !== undefined) a[1] = x; if (y !== undefined) a[2] = y;
  if (rot !== undefined) { if (a.length >= 4) a[3] = rot; else a.push(rot); }
}

/** Apply one wire-format change {id, kind, sexpr?, itemSexpr?, properties?} (IU per mm given). */
/** The schematic-only library copy a symbol names with (lib_name …), or null. */
function libNameOf(doc: Doc, id: string): string | null {
  const it = doc.type === "sch" ? doc.items.get(id) : null; if (!it || it.kind !== "symbol") return null;
  const n = kid(it.node, "lib_name"); return n ? str(n[1]) : null;
}
/**
 * SCH_SCREEN::Remove -> PruneUnusedLibSymbol for a split-off library copy (a symbol's (lib_name "R_1")): once no
 * symbol on the sheet names it any more, it leaves (lib_symbols).  Copies named by their lib_id stay, as other
 * edits in flight (a symbol being placed) rely on them.
 */
function pruneLibName(doc: Doc, name: string | null): void {
  if (!name || !doc.lib || !doc.lib.has(name)) return;
  for (const it of doc.items.values()) if (it.kind === "symbol") { const n = kid(it.node, "lib_name") || kid(it.node, "lib_id"); if (n && str(n[1]) === name) return; }
  doc.lib.delete(name);
}
export function applyChange(doc: Doc, change: WireChange, IU: number): boolean {
  const id = str(change.id), kind = str(change.kind).toUpperCase();
  // the Footprint Editor's footprint itself (its name, attributes, description, models …): the header node
  if (doc.fpEditor && id === "footprint") { const frag = change.sexpr || change.itemSexpr; return kind !== "REMOVED" && !!frag && applyFootprintHeader(doc, frag); }
  const oldLib = libNameOf(doc, id);
  if (kind === "REMOVED") {
    const r = doc.items.delete(id); pruneLibName(doc, oldLib);
    // the file had another board item with this id (parseDoc dupItems): it is the one the id names now
    const d = doc.dupItems ? doc.dupItems.findIndex((x) => x.id === id) : -1;
    if (r && d >= 0) { const [next] = doc.dupItems!.splice(d, 1); addItem(doc, next.node); }
    return r;
  }
  const frag = change.sexpr || change.itemSexpr;
  if (frag) {
    const nodes = fragmentItems(doc, frag);
    let applied = false;
    for (const node of nodes) {
      const nid = uuidOf(node) || id;
      if (nid !== id && nodes.length > 1) continue;
      if (!uuidOf(node)) node.push(["uuid", id]);
      doc.items.delete(nid);
      const it = addItem(doc, node); if (it) { applied = true; }
    }
    if (applied) { pruneLibName(doc, oldLib); return true; }
  }
  const item = doc.items.get(id);
  if (!item) return false;
  if (kind === "MODIFIED" && Array.isArray(change.properties) && change.properties.length) {
    let nx: number | undefined, ny: number | undefined, nrot: number | undefined, changed = false;
    const p2 = ptsOf(item.node);
    for (const p of change.properties) {
      const after = p.after && p.after.v;
      if (after === undefined || after === null) continue;
      const v = Number(after);
      switch (p.name) {
      case "Position X": nx = v / IU; break;
      case "Position Y": ny = v / IU; break;
      case "Orientation": case "Rotation": nrot = v; break;
      case "Start X": if (p2[0]) { p2[0][0] = v / IU; changed = true; } break;
      case "Start Y": if (p2[0]) { p2[0][1] = v / IU; changed = true; } break;
      case "End X": if (p2[1]) { p2[1][0] = v / IU; changed = true; } break;
      case "End Y": if (p2[1]) { p2[1][1] = v / IU; changed = true; } break;
      case "Value": case "Reference": case "Text":
        if (doc.type === "sch" && item.kind === "symbol") { for (const pr of kids(item.node, "property")) if (str(pr[1]) === p.name) { pr[2] = String(after); changed = true; } }
        else if (typeof item.node[1] === "string") { item.node[1] = String(after); changed = true; }
        break;
      default: break;
      }
    }
    if (changed && p2.length) setPts(item.node, p2);
    if (nx !== undefined || ny !== undefined || nrot !== undefined) {
      const ox = item.x !== undefined ? item.x : atOf(item.node)[0], oy = item.y !== undefined ? item.y : atOf(item.node)[1];
      const dx = nx !== undefined ? nx - ox : 0, dy = ny !== undefined ? ny - oy : 0;
      const was = atOf(item.node);
      if (item.kind === "table") shiftTable(item.node, dx, dy);
      else if (item.kind === "drill_map") { const o = kid(item.node, "offset"); if (o) { o[1] = num(o[1]) + dx; o[2] = num(o[2]) + dy; } }   // PCB_DRILL_MAP: its offset is its position
      else setAt(item.node, nx, ny, nrot);
      if (doc.type === "pcb" && item.kind === "footprint") refitLegacyFootprintFrame(doc, item.node, was);
      if (doc.type === "sch" && item.kind === "symbol" && (dx || dy)) for (const p of kids(item.node, "property")) { const a = kid(p, "at"); if (a) { a[1] = num(a[1]) + dx; a[2] = num(a[2]) + dy; } }
      changed = true;
    }
    if (changed) { buildGeom(doc, item); return true; }
  }
  return false;
}

/**
 * Boards before FIRST_FP_AFFINE_TRANSFORM (20260616) keep a footprint's zone outlines and (point …) positions in the
 * board frame (pcb_io_kicad_sexpr.cpp writes them through the footprint transform only from that version on).  After
 * the footprint's placement changed from `was` ([x, y, angle]) to what its node now says, carry them along.
 */
export function refitLegacyFootprintFrame(doc: Pick<Doc, "version">, node: SNode, was: readonly number[]): void {
  if (!(doc.version > 0 && doc.version < 20260616)) return;
  const [x1, y1, a1] = atOf(node), [x0, y0, a0] = was;
  if (x0 === x1 && y0 === y1 && a0 === a1) return;
  const toLocal = rotator(-a0), toBoard = rotator(a1);
  const r = (v: number): number => Math.round(v * 1e6) / 1e6;
  const map = (x: number, y: number): [number, number] => { const [lx, ly] = toLocal(x - x0, y - y0); const [bx, by] = toBoard(lx, ly); return [r(x1 + bx), r(y1 + by)]; };
  for (const z of kids(node, "zone")) for (const poly of [z, ...kids(z, "polygon"), ...kids(z, "filled_polygon")]) {
    const p = kid(poly, "pts"); if (p) for (const q of kids(p, "xy")) { const [x, y] = map(num(q[1]), num(q[2])); q[1] = x; q[2] = y; }
  }
  for (const pt of kids(node, "point")) { const a = kid(pt, "at"); if (a) { const [x, y] = map(num(a[1]), num(a[2])); a[1] = x; a[2] = y; } }
}

export function setPts(node: SNode, pts: readonly (readonly number[])[]): void {
  let p = kid(node, "pts"); if (!p) { p = ["pts"]; node.splice(1, 0, p); }
  p.length = 1; for (const [x, y] of pts) p.push(["xy", +x.toFixed(4), +y.toFixed(4)]);
}
