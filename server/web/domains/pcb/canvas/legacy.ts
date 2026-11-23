// canvas/legacy.ts — what KiCad's s-expression parsers change while reading a file of an older format version
// (SCH_IO_KICAD_SEXPR_PARSER / PCB_IO_KICAD_SEXPR_PARSER, every m_requiredVersion gate that rewrites what was read),
// applied in place to the parsed nodes so every reader of the document sees what KiCad sees, and a node written back
// means what KiCad would write.
import { cloneNode, isList, kid, kids, num, str } from "./sexpr";
import { convertToNewOverbarNotation } from "./text";

// ---------------------------------------------------------------- what the parsers change on load in older files
/**
 * The file version the parsers go by: the (version …) child, which every writer puts first.  A board or footprint
 * without one is read as 20201115 (PCB_IO_KICAD_SEXPR_PARSER: "Last version before we started writing version #s in
 * footprint files as well as board files"); a schematic without one as 0 (no gate applies).
 */
export function fileVersionOf(tree: SNode, pcb: boolean): number {
  const v = kid(tree, "version"); return v ? num(v[1], 0) : pcb ? 20201115 : 0;
}

const LOCAL_OVERRIDES = ["solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "solder_paste_ratio", "clearance"];
/** "In pre-9.0 files "0" meant inherit" (parser: footprint and pad, version <= 20240201): the zero overrides are dropped. */
function dropZeroOverrides(node: SNode): void {
  for (let j = node.length - 1; j >= 1; j--) { const c = node[j]; if (isList(c) && LOCAL_OVERRIDES.indexOf(str(c[0])) >= 0 && c.length === 2 && num(c[1], NaN) === 0) node.splice(j, 1); }
}
const overbar = convertToNewOverbarNotation;
/**
 * The pad parser with no (thermal_bridge_angle): a custom pad on a circle anchor is 90° in a 6.0 board (<= 20211014),
 * where the writer's default (DefaultThermalSpokeAngleForShape) is 45°: the angle is written in so it stays 90°.
 */
function legacySpokeAngle(pad: SNode): void {
  if (str(pad[3]) !== "custom" || kid(pad, "thermal_bridge_angle")) return;
  const o = kid(pad, "options"), a = o && kid(o, "anchor");
  if (a && str(a[1]) !== "circle") return;
  const AFTER = ["thermal_gap", "options", "primitives", "teardrops", "tenting", "uuid", "tstamp", "padstack"];
  let at = pad.length; for (let j = 1; j < pad.length; j++) { const c = pad[j]; if (isList(c) && AFTER.indexOf(str(c[0])) >= 0) { at = j; break; } }
  pad.splice(at, 0, ["thermal_bridge_angle", 90]);
}
/** A (key "value" …) child's first atom through fn. */
function mapKidText(node: SNode, key: string, fn: (s: string) => string, slot = 1): void { const c = kid(node, key); if (c && typeof c[slot] === "string") c[slot] = fn(c[slot] as string); }
const PCB_TEXT_SLOT: Record<string, number> = { gr_text: 1, fp_text: 2, property: 2, gr_text_box: 1, fp_text_box: 1 };

/** One board item (or a library footprint's root) as PCB_IO_KICAD_SEXPR_PARSER reads it at file version v. */
export function migrateBoardNode(node: SNode, v: number): void {
  const k = str(node[0]);
  if (v < 20210606) {
    // ConvertToNewOverbarNotation: net names (parseNet / pads) and every text that has (effects …) (parseEDA_TEXT)
    const net = kid(node, "net");
    if (net) { if (typeof net[1] === "string" && net.length === 2) net[1] = overbar(net[1]); else if (typeof net[2] === "string") net[2] = overbar(net[2]); }
    mapKidText(node, "net_name", overbar);
    const slot = PCB_TEXT_SLOT[k];
    if (slot && kid(node, "effects") && typeof node[slot] === "string") node[slot] = overbar(node[slot] as string);
  }
  if (k === "footprint" || k === "module") {
    if (v <= 20240201) dropZeroOverrides(node);
    for (const c of node) if (isList(c)) {
      const ck = str(c[0]);
      if (ck === "pad") { if (v <= 20240201) dropZeroOverrides(c); if (v <= 20211014) legacySpokeAngle(c); if (v < 20210606) migrateBoardNode(c, v); }
      else if (PCB_TEXT_SLOT[ck] || ck === "zone" || ck === "dimension") migrateBoardNode(c, v);
    }
  }
  if (k === "dimension" && v < 20210606) { const t = kid(node, "gr_text"); if (t) migrateBoardNode(t, v); }
}

/** A list's string children from `from` on through fn. */
function mapStrings(node: SNode, from: number, fn: (s: string) => string): void { for (let j = from; j < node.length; j++) if (typeof node[j] === "string") node[j] = fn(node[j] as string); }
const SCH_TEXT_KINDS = new Set(["text", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
const tildeEmpty = (s: string): string => (s === "~" ? "" : s);
/**
 * One schematic item or library symbol as SCH_IO_KICAD_SEXPR_PARSER reads it at file version v: "~" is an empty
 * field / instance value before 20250318, and texts, value fields, sheet pins and pin names / numbers in the old
 * overbar notation are converted before 20210606.
 */
export function migrateSchNode(node: SNode, v: number): void {
  const k = str(node[0]);
  const old = v > 0 && v < 20210606, tilde = v > 0 && v < 20250318;
  if (old && SCH_TEXT_KINDS.has(k) && kid(node, "effects") && typeof node[1] === "string") node[1] = overbar(node[1] as string);
  // parseSchPolyLine: "In 6.0, the default schematic line style was Dashed" (a two-point one, an SCH_LINE, keeps that stroke)
  if (k === "polyline" && v > 0 && v <= 20211123) {
    const st = kid(node, "stroke");
    if (st) { const t = kid(st, "type"); if (!t) { const c = kid(st, "color"); st.splice(c ? st.indexOf(c) : st.length, 0, ["type", "dash"]); } else if (str(t[1]) === "default") t[1] = "dash"; }
  }
  for (const c of node) {
    if (!isList(c)) continue;
    const ck = str(c[0]);
    if (ck === "property" && typeof c[2] === "string") {
      if (tilde) c[2] = tildeEmpty(c[2] as string);
      if (old && str(c[1]) === "Value" && kid(c, "effects") && (k === "symbol")) c[2] = overbar(c[2] as string);
    } else if (ck === "symbol" || ck === "text") migrateSchNode(c, v);   // a library symbol's units and their texts
    else if (ck === "arc" && k === "symbol") migrateSymbolArc(c, v);
    else if (ck === "pin") {
      if (k === "sheet") { if (old && kid(c, "effects") && typeof c[1] === "string") c[1] = overbar(c[1] as string); }
      else for (const key of ["name", "number"]) { const t = kid(c, key); if (!t || typeof t[1] !== "string") continue; if (tilde && t[1] === "~") t[1] = ""; else if (old) t[1] = overbar(t[1]); }
    } else if (ck === "instances" && tilde) {
      const walk = (n: SNode): void => { for (const x of n) if (isList(x)) { if ((x[0] === "value" || x[0] === "footprint") && typeof x[1] === "string") x[1] = tildeEmpty(x[1]); else walk(x); } };
      walk(c);
    }
  }
}

/**
 * Apply, in place, what the KiCad parsers change while reading a file of an older format version, so every reader of
 * the document sees what KiCad sees (and a node written back means what KiCad would write).
 */
export function migrateLegacyTree(tree: SNode, pcb: boolean, v: number): void {
  if (!v) return;
  for (let j = 1; j < tree.length; j++) {
    const c = tree[j]; if (!isList(c)) continue; const k = str(c[0]);
    // KiCad 5 files: (page A3) is the paper (boards up to 20200119, schematics up to 20200506)
    if (k === "page" && (pcb ? v <= 20200119 : v <= 20200506) && c.length >= 2 && !isList(c[1])) { c[0] = "paper"; continue; }
    if (pcb) {
      if (k === "net" && v < 20210606 && typeof c[2] === "string") c[2] = overbar(c[2]);
      else if (k === "net_class" && v < 20210606) { for (const a of kids(c, "add_net")) mapStrings(a, 1, overbar); }
      else migrateBoardNode(c, v);
    } else {
      if (k === "bus_alias" && v < 20210621) { if (typeof c[1] === "string") c[1] = overbar(c[1]); const m = kid(c, "members"); if (m) mapStrings(m, 1, overbar); }
      else if (k === "lib_symbols") { for (const s of kids(c, "symbol")) migrateSchNode(s, v); }
      else if (k === "symbol_instances" && v < 20250318) { for (const p of kids(c, "path")) for (const key of ["value", "footprint"]) mapKidText(p, key, tildeEmpty); }
      else migrateSchNode(c, v);
    }
  }
}


// ---------------------------------------------------------------- library symbol arcs (parseSymbolArc)
type IPt = [number, number];
/** EDA_ANGLE( VECTOR2D ) in degrees, with its exact answers on the axes and diagonals. */
function edaAngle(x: number, y: number): number {
  if (x === 0 && y === 0) return 0;
  if (y === 0) return x >= 0 ? 0 : -180;
  if (x === 0) return y >= 0 ? 90 : -90;
  if (x === y) return x >= 0 ? 45 : -135;
  if (x === -y) return x >= 0 ? -45 : 135;
  return Math.atan2(y, x) * 180 / Math.PI;
}
/** EDA_SHAPE::GetArcAngle (CalcArcAngles: the end angle brought to at least the start one). */
function arcAngle(s: IPt, e: IPt, c: IPt): number {
  const a0 = edaAngle(s[0] - c[0], s[1] - c[1]); let a1 = edaAngle(e[0] - c[0], e[1] - c[1]);
  if (a1 === a0) a1 = a0 + 360;
  while (a1 < a0) a1 += 360;
  return a1 - a0;
}
/** RotatePoint( int*, int*, cx, cy, angle ) (trigo.cpp): KiCad's turn, rounded to integer IU. */
function rotateI(p: IPt, c: IPt, deg: number): IPt {
  let a = deg % 360; if (a < 0) a += 360;
  const x = p[0] - c[0], y = p[1] - c[1]; let q: IPt;
  if (a === 0) q = [x, y]; else if (a === 90) q = [y, -x]; else if (a === 180) q = [-x, -y]; else if (a === 270) q = [-y, x];
  else { const r = a * Math.PI / 180, sn = Math.sin(r), cs = Math.cos(r); q = [Math.round(y * sn + x * cs), Math.round(y * cs - x * sn)]; }
  return [q[0] + c[0], q[1] + c[1]];
}
/** EDA_SHAPE::GetArcMid: the start turned about the centre by minus half the arc angle. */
function arcMidI(s: IPt, e: IPt, c: IPt): IPt { return rotateI(s, c, -arcAngle(s, e, c) / 2); }
/** CalcArcCenter( start, mid, end ) for VECTOR2I: the circumcentre, rounded; null for three collinear points. */
function centerFrom3(s: IPt, m: IPt, e: IPt): IPt | null {
  const bx = m[0] - s[0], by = m[1] - s[1], cx = e[0] - s[0], cy = e[1] - s[1];
  const b2 = bx * bx + by * by, c2 = cx * cx + cy * cy, d = 2 * (bx * cy - by * cx);
  if (d === 0) return null;
  return [Math.round(s[0] + (b2 * cy - c2 * by) / d), Math.round(s[1] + (c2 * bx - b2 * cx) / d)];
}
/** CalcArcCenter( start, end, angle ) (trigo.cpp), rounded to integer IU as SetCenter stores it. */
function centerFromAngle(s0: IPt, e0: IPt, deg: number): IPt {
  let s = s0, e = e0, a = deg;
  if (a < 0) { [s, e] = [e, s]; a = -a; }
  if (a > 180) { [s, e] = [e, s]; a = 360 - a; }
  const chord = Math.hypot(s[0] - e[0], s[1] - e[1]); const sinH = Math.sin(a / 2 * Math.PI / 180);
  if (sinH === 0) return [Math.round((s[0] + e[0]) / 2), Math.round((s[1] + e[1]) / 2)];
  let d = (chord / 2) * Math.cos(a / 2 * Math.PI / 180) / sinH; if (!isFinite(d)) d = 0;
  const dx = e[0] - s[0], dy = e[1] - s[1], len = Math.hypot(dx, dy) || 1;
  // vec2 = (end - start) resized to d, then RotatePoint( vec2, -90° ): (x, y) -> (-y, x)
  const v2: [number, number] = [-(dy / len * d), dx / len * d];
  return [Math.round(s[0] + dx / 2 + v2[0]), Math.round(s[1] + dy / 2 + v2[1])];
}
/**
 * SCH_IO_KICAD_SEXPR_PARSER::parseSymbolArc for an older library symbol arc, rewritten in place as (start) (mid) (end):
 * a (radius (at) (length) (angles)) arc (no mid point) is centred on (at) with its ends swapped unless that sweeps more
 * than 180°; before 20230121 a three-point arc of more than 180° becomes its complement and one of exactly 180° is
 * nudged to 179.5°.  Library coordinates are Y up (parseXY( true )).
 */
export function migrateSymbolArc(node: SNode, v: number): void {
  const s0 = kid(node, "start"), m0 = kid(node, "mid"), e0 = kid(node, "end"), r0 = kid(node, "radius");
  if (!s0 || !e0) return;
  const IU = 1e4;
  const rd = (n: SNode): IPt => [Math.round(num(n[1]) * IU), -Math.round(num(n[2]) * IU)];
  const sp = rd(s0), ep = rd(e0);
  let start: IPt, end: IPt, center: IPt;
  if (m0) {
    if (!(v > 0 && v <= 20230121)) return;
    const mp = rd(m0);
    const c = centerFrom3(sp, mp, ep); if (!c) return;   // IsStraightArc: a line, drawn as one
    start = sp; end = ep; center = c;
    // SetArcGeometry: the winding follows the mid point given
    const nm = arcMidI(start, end, center);
    if ((nm[0] - mp[0]) ** 2 + (nm[1] - mp[1]) ** 2 > (nm[0] - center[0]) ** 2 + (nm[1] - center[1]) ** 2) [start, end] = [end, start];
    const ang = arcAngle(start, end, center);
    if (ang > 180) { start = ep; end = sp; center = centerFromAngle(start, end, 360 - ang); }
    else if (ang === 180) center = centerFromAngle(start, end, 179.5);
    else return;   // nothing changes
  } else {
    const an = r0 && kid(r0, "angles"); if (!r0 || !an) return;
    const at = kid(r0, "at"); center = at ? rd(at) : [0, 0];
    start = ep; end = sp;
    if (arcAngle(start, end, center) > 180) { start = sp; end = ep; }
  }
  const mid = arcMidI(start, end, center);
  const out = (p: IPt): [number, number] => [p[0] / IU, -p[1] / IU || 0];
  s0.splice(1, s0.length - 1, ...out(start)); e0.splice(1, e0.length - 1, ...out(end));
  if (m0) m0.splice(1, m0.length - 1, ...out(mid));
  else { node.splice(node.indexOf(s0) + 1, 0, ["mid", ...out(mid)]); node.splice(node.indexOf(r0!), 1); }
}

// ---------------------------------------------------------------- what the writers leave out in older files
const older = (fileVersion: number, version: number): boolean => fileVersion > 0 && fileVersion < version;
/**
 * A schematic symbol, or a library symbol in (lib_symbols …), as SCH_IO_KICAD_SEXPR / the library cache write it
 * into a schematic kept at file version v (KICAD_FORMAT::WritingOlderThan branches): before 20250827 the body style
 * is (convert N) and only for N > 1, and (body_styles demorgan) is left out; before 20251028 (in_pos_files yes) is
 * left out; before 20250227 (power global) is (power) and (duplicate_pin_numbers_are_jumpers no) is left out.
 * Returns `node` itself when nothing changes, else a changed copy.
 */
export function downgradeSchNode(node: SNode, v: number): SNode {
  if (!older(v, 20251028) || !isList(node) || node[0] !== "symbol") return node;
  const drop = (c: SNode): boolean => {
    const k = str(c[0]), a = c.length > 1 ? str(c[1]) : "";
    if (k === "in_pos_files") return a === "yes";
    if (k === "body_style") return older(v, 20250827) && num(c[1], 1) <= 1;
    if (k === "body_styles") return older(v, 20250827) && a === "demorgan" && c.length === 2;
    if (k === "duplicate_pin_numbers_are_jumpers") return older(v, 20250227) && a === "no";
    return false;
  };
  const rename = (c: SNode): boolean => (str(c[0]) === "body_style" && older(v, 20250827)) || (str(c[0]) === "power" && c.length === 2 && str(c[1]) === "global" && older(v, 20250227));
  if (!node.some((c, j) => j > 0 && isList(c) && (drop(c) || rename(c)))) return node;
  const out = cloneNode(node);
  for (let j = out.length - 1; j >= 1; j--) {
    const c = out[j]; if (!isList(c)) continue;
    if (drop(c)) out.splice(j, 1);
    else if (rename(c)) out[j] = str(c[0]) === "power" ? ["power"] : ["convert", c[1]];
  }
  return out;
}
