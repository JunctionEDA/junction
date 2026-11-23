// rescue-symbols-logic.ts — Tools > Rescue Symbols... (SCH_EDITOR_CONTROL::RescueSymbols → RescueSymbolLibTableProject,
// eeschema/project_rescue.cpp) as plain functions over parsed nodes (no DOM), so the node tests can run them;
// editor/rescue-symbols.ts is DIALOG_RESCUE_EACH and the writes.
//
//   RESCUE_SYMBOL_LIB_TABLE_CANDIDATE::FindRescues: the schematic's symbols grouped by LIB_ID (getSymbols sorts them);
//   per group the cache library's symbol (the project's "<project>-cache.lib", a legacy .lib: findSymbol by the id's
//   Format(), then by "<nickname>-<item>") and the library table's symbol (its root symbol when it is derived).  A
//   group whose item name holds no illegal LIB_ID character is left alone when both exist and their pins do not
//   conflict (PinsConflictWith numbers, names, types, orientations), or when only the library has it; a group found
//   nowhere is left alone too.  Each candidate renames the symbol to "<project>-rescue:<item>-<nickname>".
//   The cache library is read by a port of SCH_IO_KICAD_LEGACY_LIB_CACHE's reader (Load / LoadPart / loadField /
//   loadDrawEntries / loadArc / loadCircle / loadText / loadRect / loadPin / loadPolyLine / loadBezier /
//   loadFootprintFilters / loadAliases / loadDocs), producing the s-expression symbols SCH_IO_KICAD_SEXPR writes.
import { symbolInstanceRef } from "./panels/search-model";
import { compareLibIds, splitLibId } from "./export-symbols-logic";
import { convertToNewOverbarNotation } from "../canvas/text";
import { escapeLibId, unescapeLibId, fmt, parseLibrary, serializeLibrary, NEW_LIBRARY_TEXT, q } from "../symedit/model";

type N = SNode;
const K = (): KiCadCanvasApi => (globalThis as unknown as { KiCadCanvas: KiCadCanvasApi }).KiCadCanvas;
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

// ---------------------------------------------------------------- the legacy symbol library reader
/** SCH_PARSE_ERROR: what the reader stops on (the line number counts from 1). */
export class LegacyLibError extends Error { constructor(msg: string, public line: number) { super(`${msg} at line ${line}`); } }

/** One line under a cursor: the legacy helpers parseInt / parseChar / parseQuotedString / parseUnquotedString. */
class Cursor {
  constructor(public s: string, public pos: number, private lineNo: number) {}
  err(msg: string): never { throw new LegacyLibError(msg, this.lineNo); }
  ws(): void { while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++; }
  eol(): boolean { return this.pos >= this.s.length || this.s[this.pos] === "\r" || this.s[this.pos] === "\n"; }
  /** *line != 0: something left on the line */
  more(): boolean { return this.pos < this.s.length; }
  peek(): string { return this.s[this.pos] || ""; }
  /** parseInt: strtol, then the white space after it */
  int(): number {
    const m = /^\s*([+-]?\d+)/.exec(this.s.slice(this.pos));
    if (!m) this.err("expecting integer value");
    this.pos += m[0].length; this.ws();
    return parseInt(m[1], 10);
  }
  /** parseChar: one character followed by white space or the end of the line */
  char(): string {
    this.ws();
    if (!this.more()) this.err("unexpected end of line");
    const c = this.s[this.pos++];
    if (this.more() && !/\s/.test(this.s[this.pos])) this.err("expecting single character token");
    this.ws();
    return c;
  }
  /** parseQuotedString: the text between the quotes, a backslash taking the next character as it is */
  quoted(canBeEmpty = false): string {
    this.ws();
    if (!this.more()) { if (canBeEmpty) return ""; this.err("unexpected end of line"); }
    if (this.s[this.pos] !== '"') this.err("expecting opening quote");
    this.pos++;
    let out = "";
    while (this.pos < this.s.length) {
      const c = this.s[this.pos];
      if (c === "\\") { this.pos++; if (this.pos >= this.s.length) this.err("unexpected end of line"); out += this.s[this.pos++]; continue; }
      if (c === '"') break;
      out += c; this.pos++;
    }
    if (this.s[this.pos] !== '"') this.err("expecting closing quote");
    this.pos++;
    if (!out && !canBeEmpty) this.err("expected quoted string");
    this.ws();
    return out;
  }
  /** parseUnquotedString */
  unquoted(canBeEmpty = false): string {
    this.ws();
    let out = "";
    while (this.pos < this.s.length && !/\s/.test(this.s[this.pos])) out += this.s[this.pos++];
    if (!out && !canBeEmpty) this.err("expected unquoted string");
    this.ws();
    return out;
  }
  /** strCompare: the token at the cursor (then white space), advancing past it when it matches */
  word(w: string): boolean {
    this.ws();
    if (!this.s.startsWith(w, this.pos)) return false;
    const after = this.s[this.pos + w.length];
    if (after !== undefined && !/\s/.test(after)) return false;
    this.pos += w.length; this.ws();
    return true;
  }
}

/** schIUScale.MilsToIU: a legacy mil value in internal units (100 nm). */
const IU = (mils: number): number => mils * 254;
/** A position or size in internal units as the s-expression writer formats it (FormatInternalUnits, mm). */
const mm = (iu: number): string => fmt(iu / 10000);
const LIB_VERSION = (major: number, minor: number): number => major * 100 + minor;

interface LField { id: number; name: string; text: string; x: number; y: number; size: number; vertical: boolean; visible: boolean; h: string; v: string; italic: boolean; bold: boolean }
interface LItem { unit: number; body: number; sexpr: string; pin?: boolean; order: number }
export interface LSymbol {
  name: string; pinNameOffset: number; showNumbers: boolean; showNames: boolean; unitCount: number; locked: boolean; power: boolean;
  fields: LField[]; items: LItem[]; fpFilters: string[]; description: string; keywords: string;
  /** an ALIAS: the root symbol it derives from and its own mandatory fields */
  parent?: LSymbol;
}

function newField(id: number, name: string): LField { return { id, name, text: "", x: 0, y: 0, size: IU(50), vertical: false, visible: true, h: "C", v: "C", italic: false, bold: false }; }
const MANDATORY = ["Reference", "Value", "Footprint", "Datasheet", "Description"];

/** FILL_T as the writer names it (SCH_IO_KICAD_SEXPR_UTILS fillType). */
function fillOf(c: Cursor): string {
  if (!c.more()) return "none";
  switch (c.char()) {
    case "F": return "outline";
    case "f": return "background";
    case "N": return "none";
    default: return c.err("invalid fill type, expected f, F, or N");
  }
}
const strokeFill = (width: number, fill: string): string => ` (stroke (width ${mm(width)}) (type solid)) (fill (type ${fill}))`;

/** EDA_ANGLE in tenths kept in [0, 3600) (NORMALIZE_ANGLE_POS). */
const normPos = (a: number): number => { while (a < 0) a += 3600; while (a >= 3600) a -= 3600; return a; };
const kiRound = (v: number): number => (v < 0 ? -Math.round(-v) : Math.round(v));
/** MapAnglesV6: the 6.0 reader's arc angle mapping; true when start and end are to be swapped. */
function mapAnglesV6(a: { a1: number; a2: number }): boolean {
  const rad = (d: number): number => (d * Math.PI) / 1800;
  const delta = a.a2 - a.a1; let swap = false;
  if (delta >= 1800) { a.a1 -= 1; a.a2 += 1; }
  a.a1 = kiRound((Math.atan2(-Math.sin(rad(a.a1)), Math.cos(rad(a.a1))) * 1800) / Math.PI);
  a.a2 = kiRound((Math.atan2(-Math.sin(rad(a.a2)), Math.cos(rad(a.a2))) * 1800) / Math.PI);
  a.a1 = normPos(a.a1); a.a2 = normPos(a.a2);
  if (a.a2 < a.a1) a.a2 += 3600;
  if (a.a2 - a.a1 > 1800) {
    const t = a.a1; a.a1 = a.a2; a.a2 = t;
    a.a1 = normPos(a.a1); a.a2 = normPos(a.a2);
    if (a.a2 < a.a1) a.a2 += 3600;
    swap = true;
  }
  if (delta >= 1800) { a.a1 += 1; a.a2 -= 1; }
  return swap;
}
/** RotatePoint( p, angle in tenths ) about the origin (internal coordinates, Y down), rounded like VECTOR2I's. */
function rotate(x: number, y: number, tenths: number): [number, number] {
  const t = normPos(tenths);
  if (t === 0) return [x, y];
  if (t === 900) return [y, -x];
  if (t === 1800) return [-x, -y];
  if (t === 2700) return [-y, x];
  const r = (t * Math.PI) / 1800, s = Math.sin(r), c = Math.cos(r);
  return [kiRound(x * c + y * s), kiRound(y * c - x * s)];
}

function loadArc(c: Cursor): Omit<LItem, "order"> {
  const cx = IU(c.int()), cy = -IU(c.int());
  const radius = IU(c.int());
  const ang = { a1: normPos(c.int()), a2: normPos(c.int()) };
  const unit = c.int(), body = c.int(), width = IU(c.int());
  const fill = c.more() ? fillOf(c) : "none";
  let sx: number, sy: number, ex: number, ey: number;
  if (c.more()) { sx = IU(c.int()); sy = -IU(c.int()); ex = IU(c.int()); ey = -IU(c.int()); }
  else {
    const s = rotate(radius, 0, ang.a1), e = rotate(radius, 0, ang.a2);
    sx = s[0] + cx; sy = s[1] + cy; ex = e[0] + cx; ey = e[1] + cy;
  }
  if (mapAnglesV6(ang)) { [sx, sy, ex, ey] = [ex, ey, sx, sy]; }
  // SetArcGeometry( start, GetArcMid(), end ): the mid point half way along the arc (CalcArcAngles, RotatePoint)
  let as = (Math.atan2(sy - cy, sx - cx) * 180) / Math.PI, ae = (Math.atan2(ey - cy, ex - cx) * 180) / Math.PI;
  if (ae === as) ae = as + 360;
  while (ae < as) ae += 360;
  const half = ((ae - as) / 2) * 10;
  const m = rotate(sx - cx, sy - cy, -half);
  const mx = m[0] + cx, my = m[1] + cy;
  return { unit, body, sexpr: `(arc (start ${mm(sx)} ${mm(-sy)}) (mid ${mm(mx)} ${mm(-my)}) (end ${mm(ex)} ${mm(-ey)})${strokeFill(width, fill)})` };
}
function loadCircle(c: Cursor): Omit<LItem, "order"> {
  const x = IU(c.int()), y = -IU(c.int()), r = IU(c.int());
  const unit = c.int(), body = c.int(), width = IU(c.int());
  const fill = c.more() ? fillOf(c) : "none";
  return { unit, body, sexpr: `(circle (center ${mm(x)} ${mm(-y)}) (radius ${mm(r)})${strokeFill(width, fill)})` };
}
function loadRect(c: Cursor): Omit<LItem, "order"> {
  const x = IU(c.int()), y = -IU(c.int()), ex = IU(c.int()), ey = -IU(c.int());
  const unit = c.int(), body = c.int(), width = IU(c.int());
  const fill = c.more() ? fillOf(c) : "none";
  return { unit, body, sexpr: `(rectangle (start ${mm(x)} ${mm(-y)}) (end ${mm(ex)} ${mm(-ey)})${strokeFill(width, fill)})` };
}
function loadPolyLine(c: Cursor): Omit<LItem, "order"> {
  const points = c.int(), unit = c.int(), body = c.int(), width = IU(c.int());
  const pts: string[] = [];
  for (let i = 0; i < points; i++) { const x = IU(c.int()), y = -IU(c.int()); pts.push(`(xy ${mm(x)} ${mm(-y)})`); }
  const fill = c.more() ? fillOf(c) : "none";
  return { unit, body, sexpr: `(polyline (pts ${pts.join(" ")})${strokeFill(width, fill)})` };
}
function loadBezier(c: Cursor): Omit<LItem, "order"> {
  const points = c.int();
  if (points !== 4) c.err("Invalid Bezier curve definition");
  const unit = c.int(), body = c.int(), width = IU(c.int());
  const pts: string[] = [];
  for (let i = 0; i < 4; i++) { const x = IU(c.int()), y = -IU(c.int()); pts.push(`(xy ${mm(x)} ${mm(-y)})`); }
  const fill = c.more() ? fillOf(c) : "none";
  return { unit, body, sexpr: `(bezier (pts ${pts.join(" ")})${strokeFill(width, fill)})` };
}
const effects = (size: number, italic: boolean, bold: boolean, h: string, v: string): string => {
  let s = `(effects (font (size ${mm(size)} ${mm(size)})${italic ? " (italic yes)" : ""}${bold ? " (bold yes)" : ""})`;
  const j: string[] = [];
  if (h === "L") j.push("left"); else if (h === "R") j.push("right");
  if (v === "T") j.push("top"); else if (v === "B") j.push("bottom");
  return s + (j.length ? ` (justify ${j.join(" ")})` : "") + ")";
};
function loadText(c: Cursor, major: number, minor: number, sym: LSymbol): Omit<LItem, "order"> | null {
  const angle = c.int();
  const x = IU(c.int()), y = -IU(c.int());
  const size = IU(c.int());
  const visible = !c.int();
  const unit = c.int(), body = c.int();
  let text: string;
  if (c.peek() === '"') text = convertToNewOverbarNotation(c.quoted(true));
  else text = c.unquoted().replace(/~/g, " ");
  if (text) text = text.replace(/''/g, '"');
  let italic = false, bold = false, h = "C", v = "C";
  if (LIB_VERSION(major, minor) > 0 && LIB_VERSION(major, minor) > LIB_VERSION(2, 0) && !c.eol()) {
    if (c.word("Italic")) italic = true;
    else if (!c.word("Normal")) c.err("invalid eda_text stype, expected 'Normal' or 'Italic'");
    if (c.int() > 0) bold = true;
    if (!c.eol()) {
      h = c.char(); if (!"LCR".includes(h)) c.err("invalid horizontal eda_text justication; expected L, C, or R");
      v = c.char(); if (!"TCB".includes(v)) c.err("invalid vertical eda_text justication; expected T, C, or B");
    }
  }
  if (!visible) {
    // an invisible text is read as a user field (SCH_FIELD( nullptr, FIELD_T::USER )) whose text is never set
    const f = newField(-1, ""); f.x = x; f.y = y; f.size = size; f.visible = false; f.vertical = normPos(angle) === 900 || normPos(angle) === 2700;
    f.italic = italic; f.bold = bold; f.h = h; f.v = v;
    sym.fields.push(f);
    return null;
  }
  return { unit, body, sexpr: `(text ${q(text)} (at ${mm(x)} ${mm(-y)} ${angle}) ${effects(size, italic, bold, h, v)})` };
}
const PIN_TYPES: Record<string, string> = { I: "input", O: "output", B: "bidirectional", T: "tri_state", P: "passive", U: "unspecified", W: "power_in", w: "power_out", C: "open_collector", E: "open_emitter", N: "no_connect" };
const ORIENT: Record<string, number> = { U: 90, D: 270, L: 180, R: 0 };
function loadPin(rest: string, lineNo: number): Omit<LItem, "order"> {
  const err = (m: string): never => { throw new LegacyLibError(m, lineNo); };
  const t = rest.split(/[ \t\r\n]+/).filter((s) => s);
  if (t.length < 11) err("invalid pin definition");
  const int = (s: string, what: string): number => { if (!/^[+-]?\d+$/.test(s)) err("invalid pin " + what); return parseInt(s, 10); };
  const name = t[0], number = t[1];
  const x = IU(int(t[2], "X coordinate")), y = -IU(int(t[3], "Y coordinate")), length = IU(int(t[4], "length"));
  if (t[5].length > 1) err("invalid pin orientation");
  const orient = ORIENT[t[5]] !== undefined ? ORIENT[t[5]] : 0;
  const numSize = IU(int(t[6], "number text size")), nameSize = IU(int(t[7], "name text size"));
  const unit = int(t[8], "unit"), body = int(t[9], "body style");
  if (t[10].length !== 1) err("invalid pin type");
  const type = PIN_TYPES[t[10]]; if (!type) err("unknown pin type");
  let shape = "line", hidden = false;
  if (t.length > 11) {
    const INVERTED = 1, CLOCK = 2, LOWLEVEL_IN = 4, LOWLEVEL_OUT = 8, FALLING_EDGE = 16, NONLOGIC = 32;
    let flags = 0;
    for (let j = t[11].length; j > 0;) {
      switch (t[11][--j]) {
        case "~": break;
        case "N": hidden = true; break;
        case "I": flags |= INVERTED; break;
        case "C": flags |= CLOCK; break;
        case "L": flags |= LOWLEVEL_IN; break;
        case "V": flags |= LOWLEVEL_OUT; break;
        case "F": flags |= FALLING_EDGE; break;
        case "X": flags |= NONLOGIC; break;
        default: err("invalid pin attribut");
      }
    }
    const SHAPES: Record<number, string> = { 0: "line", [INVERTED]: "inverted", [CLOCK]: "clock", [INVERTED | CLOCK]: "inverted_clock", [LOWLEVEL_IN]: "input_low",
      [LOWLEVEL_IN | CLOCK]: "clock_low", [LOWLEVEL_OUT]: "output_low", [FALLING_EDGE]: "edge_clock_high", [NONLOGIC]: "non_logic" };
    if (SHAPES[flags] === undefined) err("pin attributes do not define a valid pin shape");
    shape = SHAPES[flags];
  }
  const nm = convertToNewOverbarNotation(name), no = convertToNewOverbarNotation(number);
  return { unit, body, pin: true, sexpr: `(pin ${type} ${shape} (at ${mm(x)} ${mm(-y)} ${orient}) (length ${mm(length)})${hidden ? " (hide yes)" : ""} (name ${q(nm)} (effects (font (size ${mm(nameSize)} ${mm(nameSize)})))) (number ${q(no)} (effects (font (size ${mm(numSize)} ${mm(numSize)})))))` };
}
function loadField(c: Cursor, sym: LSymbol): void {
  const m = /^F(\d+)/.exec(c.s.slice(c.pos)); if (!m) c.err("invalid field ID");
  const legacyId = parseInt(m[1], 10);
  const id = legacyId <= 3 ? legacyId : -1;
  let field: LField;
  if (id >= 0) field = sym.fields.find((f) => f.id === id)!;
  else { field = newField(-1, ""); sym.fields.push(field); }
  while (c.pos < c.s.length && c.s[c.pos] !== '"') c.pos++;
  if (c.pos >= c.s.length) c.err("unexpected end of line");
  const text = c.quoted(true);
  field.text = text === "~" ? "" : convertToNewOverbarNotation(text);
  field.x = IU(c.int()); field.y = -IU(c.int());
  field.size = IU(c.int());
  const o = c.char(); if (o === "H") field.vertical = false; else if (o === "V") field.vertical = true; else c.err("invalid field text orientation parameter");
  const vis = c.char(); if (vis === "V") field.visible = true; else if (vis === "I") field.visible = false; else c.err("invalid field text visibility parameter");
  if (c.more() && c.peek() !== '"') {
    const h = c.char(); if (!"CLR".includes(h)) c.err("invalid field text horizontal justification");
    field.h = h;
    const attrs = c.unquoted(true);
    if (!(attrs.length === 3 || attrs.length === 1)) c.err("invalid field text attributes size");
    if (!"CBT".includes(attrs[0])) c.err("invalid field text vertical justification");
    field.v = attrs[0];
    if (attrs.length === 3) {
      if (attrs[1] === "I") field.italic = true; else if (attrs[1] !== "N") c.err("invalid field text italic parameter");
      if (attrs[2] === "B") field.bold = true; else if (attrs[2] !== "N") c.err("invalid field text bold parameter");
    }
  }
  if (id >= 0) {
    field.name = MANDATORY[id];
    if (id === 1) field.text = sym.name;
  } else {
    const name = c.more() ? c.quoted(true) : "";
    if (!name) return;
    let cand = name, suffix = 0;
    while (sym.fields.some((f) => f !== field && f.name === cand)) cand = `${name}_${++suffix}`;
    field.name = cand;
  }
}

/** The symbols of a legacy .lib (and its .dcm, the old document file) by name: LIB_SYMBOL_MAP after Load. */
export function parseLegacyLibrary(text: string, dcm?: string | null): Map<string, LSymbol> {
  const lines = text.split(/\r?\n/);
  let i = 0;
  const out = new Map<string, LSymbol>();
  const head = new Cursor(lines[0] || "", 0, 1);
  if (!lines.length || !lines[0]) throw new LegacyLibError("Unexpected end of file.", 1);
  if (!head.word("EESchema-LIBRARY") && !head.word("EESchema-LIB")) head.err("file is not a valid symbol or symbol library file");
  if (!head.word("Version")) head.err("file is not a valid symbol or symbol library file");
  let major = head.int(), minor: number;
  if (head.peek() === "/") { major = 2; minor = 3; }
  else { if (head.peek() !== ".") head.err("invalid file version formatting in header"); head.pos++; minor = head.int(); }
  if (major < 1 || minor < 0 || minor > 99) head.err("invalid file version in header");
  const lt = head.word("SYMBOL") ? "symbol" : "eeschema";
  for (i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line[0] === "#" || /\s/.test(line[0])) continue;
    if (lt === "eeschema" && /^\$HEADER\b/.test(line)) {
      for (i++; i < lines.length && !/^\$ENDHEADER\b/.test(lines[i]); i++) { /* TimeStamp, ignored */ }
      if (i >= lines.length) throw new LegacyLibError("$ENDHEADER not found", i);
      continue;
    }
    if (/^DEF\b/.test(line)) i = loadPart(lines, i, major, minor, out);
  }
  if (LIB_VERSION(major, minor) <= LIB_VERSION(2, 4) && dcm) loadDocs(dcm, out);
  return out;
}

/** UnescapeString (common/string_utils.cpp) for the names the legacy files escaped. */
const unescape = unescapeLibId;

function loadPart(lines: string[], start: number, major: number, minor: number, map: Map<string, LSymbol>): number {
  let i = start;
  const rest = lines[i].replace(/^DEF\s*/, "");
  const t = rest.split(/[ \t\r\n]+/).filter((s) => s);
  const err = (m: string): never => { throw new LegacyLibError(m, i + 1); };
  if (t.length < 8) err("invalid symbol definition");
  let name = t[0]; if (name !== unescape(name)) name = unescape(name);
  const prefix = t[1];
  if (!/^[+-]?\d+$/.test(t[3])) err("invalid pin offset");
  if (!(t[4] === "Y" || t[4] === "N") || !(t[5] === "Y" || t[5] === "N")) err("expected Y or N");
  if (!/^[+-]?\d+$/.test(t[6])) err("invalid unit count");
  const sym: LSymbol = { name: "", pinNameOffset: IU(parseInt(t[3], 10)), showNumbers: t[4] !== "N", showNames: t[5] !== "N", unitCount: Math.max(1, parseInt(t[6], 10)),
    locked: false, power: false, fields: MANDATORY.map((n, k) => newField(k, n)), items: [], fpFilters: [], description: "", keywords: "" };
  const value = sym.fields[1], reference = sym.fields[0];
  if (!name) sym.name = "~";
  else if (name[0] !== "~") sym.name = name;
  else { sym.name = name.slice(1); value.visible = false; }
  if (prefix === "~") { reference.text = ""; reference.visible = false; } else reference.text = prefix;
  let k = 7;
  if (LIB_VERSION(major, minor) > 0 && LIB_VERSION(major, minor) <= LIB_VERSION(2, 2)) k++;
  else {
    const l = t[k++];
    if (l === "L") sym.locked = true; else if (l === "F" || l === "0") sym.locked = false; else err("expected L, F, or 0");
  }
  if (k < t.length) { if (t[k] === "P") sym.power = true; else if (t[k] !== "N") err("expected P or N"); }
  value.text = sym.name;
  let order = 0;
  for (i++; i < lines.length; i++) {
    const line = lines[i];
    const c = new Cursor(line, 0, i + 1);
    if (line[0] === "#") continue;
    if (c.word("Ti")) continue;
    if (c.word("ALIAS")) {
      for (const alias of c.s.slice(c.pos).split(/[ \t\r\n]+/).filter((s) => s)) {
        // loadAliases: a derived symbol with copies of the parent's mandatory fields, its value its own name
        const a: LSymbol = { ...sym, name: alias, fields: sym.fields.slice(0, 5).map((f) => ({ ...f })), items: [], fpFilters: [], description: "", keywords: "", parent: sym };
        a.fields[1].text = alias;
        map.set(alias, a);
      }
      continue;
    }
    if (line[0] === "F") { loadField(c, sym); continue; }
    if (c.word("DRAW")) {
      for (i++; i < lines.length; i++) {
        const d = new Cursor(lines[i], 0, i + 1);
        if (d.word("ENDDRAW")) break;
        const kind = lines[i][0] || "";
        const body = new Cursor(lines[i], 1, i + 1); body.ws();
        let item: Omit<LItem, "order"> | null = null;
        switch (kind) {
          case "A": item = loadArc(body); break;
          case "C": item = loadCircle(body); break;
          case "T": item = loadText(body, major, minor, sym); break;
          case "S": item = loadRect(body); break;
          case "X": item = loadPin(lines[i].slice(1), i + 1); break;
          case "P": item = loadPolyLine(body); break;
          case "B": item = loadBezier(body); break;
          case "#": case "\n": case "\r": case "": break;
          default: throw new LegacyLibError("undefined DRAW entry", i + 1);
        }
        if (item) sym.items.push({ ...item, order: order++ });
      }
      if (i >= lines.length) throw new LegacyLibError("File ended prematurely loading symbol draw element.", i);
      continue;
    }
    if (c.word("$FPLIST")) {
      for (i++; i < lines.length; i++) {
        const f = new Cursor(lines[i], 0, i + 1);
        if (f.word("$ENDFPLIST")) break;
        sym.fpFilters.push(f.unquoted());
      }
      if (i >= lines.length) throw new LegacyLibError("File ended prematurely while loading footprint filters.", i);
      continue;
    }
    if (c.word("ENDDEF")) { map.set(sym.name, sym); return i; }
  }
  throw new LegacyLibError("missing ENDDEF", i);
}

function loadDocs(text: string, map: Map<string, LSymbol>): void {
  const lines = text.split(/\r?\n/);
  if (!lines.length || !lines[0]) throw new LegacyLibError("symbol document library file is empty", 1);
  if (!lines[0].startsWith("EESchema-DOCLIB  Version 2.0")) throw new LegacyLibError("invalid document library file version formatting in header", 1);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line[0] === "#") continue;
    if (!line) continue;
    if (!/^\$CMP\b/.test(line)) throw new LegacyLibError("$CMP command expected", i + 1);
    const sym = map.get(line.slice(4).trim()) || null;
    for (i++; i < lines.length; i++) {
      const l = lines[i];
      if (/^\$ENDCMP\b/.test(l)) break;
      const t = l.slice(2).trim();
      switch (l[0] || "") {
        case "D": if (sym) sym.description = t; break;
        case "K": if (sym) sym.keywords = t; break;
        case "F": if (sym) sym.fields[3].text = t; break;
        case "": case "\n": case "\r": case "#": break;
        default: throw new LegacyLibError("expected token in symbol definition", i + 1);
      }
    }
  }
}

function fieldText(f: LField, name: string): string {
  return `(property ${q(name)} ${q(f.text)} (at ${mm(f.x)} ${mm(-f.y)} ${f.vertical ? 90 : 0}) (show_name no) (do_not_autoplace no)${f.visible ? "" : " (hide yes)"} ${effects(f.size, f.italic, f.bold, f.h, f.v)})`;
}

/**
 * A legacy symbol as SCH_IO_KICAD_SEXPR_LIB_CACHE::SaveSymbol writes it once flattened (LIB_SYMBOL::Flatten): an alias
 * takes its parent's body with its own mandatory fields.  `name` is the name it is written under.
 */
export function legacySymbolNode(sym: LSymbol, name = sym.name): N {
  const root = sym.parent || sym;
  const fields = sym.parent ? sym.fields.concat(root.fields.slice(5)) : sym.fields;
  let s = `(symbol ${q(name)}`;
  if (root.power) s += " (power global)";
  const demorgan = root.items.some((it) => it.body > 1);
  if (demorgan) s += " (body_styles demorgan)";
  if (!root.showNumbers) s += " (pin_numbers (hide yes))";
  const DEF_OFFSET = IU(20);
  if (root.pinNameOffset !== DEF_OFFSET || !root.showNames) s += " (pin_names" + (root.pinNameOffset !== DEF_OFFSET ? ` (offset ${mm(root.pinNameOffset)})` : "") + (root.showNames ? "" : " (hide yes)") + ")";
  s += " (exclude_from_sim no) (in_bom yes) (on_board yes) (in_pos_files yes) (duplicate_pin_numbers_are_jumpers no)";
  const descr = sym.parent ? sym.description || root.description : sym.description;
  for (const f of fields) {
    if (f.id === 4) { const d = { ...f, text: descr, visible: false }; s += " " + fieldText(d, "Description"); continue; }
    s += " " + fieldText(f, f.id >= 0 ? MANDATORY[f.id] : f.name || "Field42");
  }
  if (root.locked) s += ` (property "ki_locked" "" (at 0 0 0) (show_name no) (do_not_autoplace no) ${effects(IU(50), false, false, "C", "C")})`;
  const kw = sym.parent ? sym.keywords || root.keywords : sym.keywords;
  if (kw) s += ` (property "ki_keywords" ${q(kw)} (at 0 0 0) (show_name no) (do_not_autoplace no) (hide yes) ${effects(IU(50), false, false, "C", "C")})`;
  if (root.fpFilters.length) s += ` (property "ki_fp_filters" ${q(root.fpFilters.join(" "))} (at 0 0 0) (show_name no) (do_not_autoplace no) (hide yes) ${effects(IU(50), false, false, "C", "C")})`;
  // GetUnitDrawItems: the drawing grouped by unit and body style
  const groups = new Map<string, LItem[]>();
  for (const it of root.items) { const key = `${it.unit}_${it.body}`; const g = groups.get(key) || []; g.push(it); groups.set(key, g); }
  const keys = Array.from(groups.keys()).sort((a, b) => { const [ua, ba] = a.split("_").map(Number), [ub, bb] = b.split("_").map(Number); return ua - ub || ba - bb; });
  const sub = name.indexOf(":") >= 0 ? name.slice(name.indexOf(":") + 1) : name;
  for (const k of keys) s += ` (symbol ${q(`${sub}_${k}`)} ${groups.get(k)!.map((it) => it.sexpr).join(" ")})`;
  s += " (embedded_fonts no))";
  const n = K().parse(s);
  if (!n) throw new Error("bad symbol " + name);
  return n;
}

// ---------------------------------------------------------------- PinsConflictWith
interface PinInfo { unit: number; body: number; x: number; y: number; number: string; name: string; type: string; orient: number; length: number }
/** LIB_SYMBOL::GetGraphicalPins of a (flattened) s-expression symbol: every pin with its unit and body style. */
export function graphicalPins(sym: N): PinInfo[] {
  const out: PinInfo[] = [];
  for (const u of K().kids(sym, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(str(u[1])); const unit = m ? +m[1] : 0, body = m ? +m[2] : 0;
    for (const p of K().kids(u, "pin")) {
      const at = K().kid(p, "at") || [], len = K().kid(p, "length") || [];
      out.push({ unit, body, x: Math.round(Number(at[1]) * 10000), y: Math.round(Number(at[2]) * 10000), orient: Math.round(Number(at[3]) || 0),
        number: str((K().kid(p, "number") || [])[1]), name: str((K().kid(p, "name") || [])[1]), type: str(p[1]), length: Math.round(Number(len[1]) * 10000) });
    }
  }
  return out;
}
/** LIB_SYMBOL::PinsConflictWith: true when one of this symbol's pins has no identical pin (by the tests asked for) at its place in the other. */
export function pinsConflictWith(a: N, b: N, nums: boolean, names: boolean, type: boolean, orient: boolean, length: boolean): boolean {
  const other = graphicalPins(b);
  for (const p of graphicalPins(a)) {
    const found = other.some((o) => o.unit === p.unit && o.body === p.body && o.x === p.x && o.y === p.y
      && (!nums || o.number === p.number) && (!names || o.name === p.name) && (!type || o.type === p.type)
      && (!orient || o.orient === p.orient) && (!length || o.length === p.length));
    if (!found) return true;
  }
  return false;
}

// ---------------------------------------------------------------- the rescuer
/** One schematic symbol as getSymbols lists it. */
export interface RescueSymbol { docId: string; id: string; libId: string; unit: number; bodyStyle: number; node: N }
/** RESCUE_SYMBOL_LIB_TABLE_CANDIDATE */
export interface RescueCandidate { requestedId: string; newId: string; cache: N | null; lib: N | null; unit: number; bodyStyle: number }

/** LIB_ID::HasIllegalChars: the item name holds one of GetLibIdForbiddenChars. */
export const hasIllegalChars = (item: string): boolean => /[<>"\\:\t\n\r]/.test(item);

/** getSymbols: every symbol of every screen, sorted by LIB_ID (std::sort over LIB_ID operator<). */
export function rescueSymbols(screens: { docId: string; doc: KDoc }[]): RescueSymbol[] {
  const out: RescueSymbol[] = [];
  for (const s of screens) for (const it of s.doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const n = it.node as N;
    const unit = Number((K().kid(n, "unit") || [])[1]) || 1;
    const bs = K().kid(n, "body_style") || K().kid(n, "convert");
    out.push({ docId: s.docId, id: it.id, libId: str((K().kid(n, "lib_id") || [])[1]), unit, bodyStyle: bs ? Number(bs[1]) || 1 : 1, node: n });
  }
  return out.sort((a, b) => compareLibIds(a.libId, b.libId));
}

/**
 * RESCUE_SYMBOL_LIB_TABLE_CANDIDATE::FindRescues.  `cacheFind` is findSymbol( name, LegacySchLibs, true ) (null when
 * the project has no cache library); `libFind` the library table's symbol and its root (SchGetLibSymbol, GetRootSymbol)
 * or null; `rescueNick` the rescue library's name (GetRescueLibraryFileName: "<schematic>-rescue").
 */
export function findRescues(symbols: RescueSymbol[], cacheFind: (name: string) => N | null, libFind: (libId: string) => { symbol: N | null; root: N | null } | null, rescueNick: string): RescueCandidate[] {
  const map = new Map<string, RescueCandidate>();
  let old: string | null = null;
  for (const s of symbols) {
    if (old === s.libId) continue;
    old = s.libId;
    const { nick, item } = splitLibId(s.libId);
    let cache = cacheFind(s.libId);
    if (!cache) cache = cacheFind(`${nick}-${item}`);
    const found = libFind(s.libId);
    let lib = found && found.symbol ? found.symbol : null;
    if (!cache && !lib) continue;
    // a derived symbol: its root symbol's pins are tested
    if (lib && K().kid(lib, "extends")) lib = found && found.root ? found.root : null;
    else if (lib && found && found.root) lib = found.root;
    if (!hasIllegalChars(item)) {
      if (cache && lib && !pinsConflictWith(cache, lib, true, true, true, true, false)) continue;
      if (!cache && lib) continue;
    }
    const newId = `${rescueNick}:${escapeLibId(item)}-${nick}`;
    map.set(s.libId, { requestedId: s.libId, newId, cache, lib, unit: s.unit, bodyStyle: s.bodyStyle });
  }
  return Array.from(map.values()).sort((a, b) => compareLibIds(a.requestedId, b.requestedId));
}

/** RESCUE_SYMBOL_LIB_TABLE_CANDIDATE::GetActionDescription */
export function actionDescription(c: RescueCandidate): string {
  if (!c.cache && !c.lib) return `Cannot rescue symbol ${unescapeLibId(splitLibId(c.requestedId).item)} which is not available in any library or the cache.`;
  if (c.cache && !c.lib) return `Rescue symbol ${unescapeLibId(c.requestedId)} found only in cache library to ${unescapeLibId(c.newId)}.`;
  return `Rescue modified symbol ${unescapeLibId(c.requestedId)} to ${unescapeLibId(c.newId)}`;
}

/** RESCUER::RemoveDuplicates: the first candidate of each requested name. */
export function removeDuplicates(cands: RescueCandidate[]): RescueCandidate[] {
  const seen = new Set<string>();
  return cands.filter((c) => (seen.has(c.requestedId) ? false : (seen.add(c.requestedId), true)));
}

/** The symbol PerformAction adds to the rescue library: ( cache ?: lib )->Flatten() named after the new id; null when neither exists (the rescue then fails). */
export function rescuedSymbol(c: RescueCandidate): N | null {
  const src = c.cache || c.lib; if (!src) return null;
  const n = K().cloneNode(src) as N;
  const was = str(n[1]), wasItem = was.indexOf(":") >= 0 ? was.slice(was.indexOf(":") + 1) : was;
  const item = splitLibId(c.newId).item;
  n[1] = item;
  for (const sub of K().kids(n, "symbol")) { const s = str(sub[1]); if (s.startsWith(wasItem + "_")) sub[1] = item + s.slice(wasItem.length); }
  return n;
}

/**
 * The rescue library as SYMBOL_LIB_TABLE_RESCUER::WriteRescueLibrary saves it: the symbols an earlier rescue left in
 * it (OpenRescueLibrary) and the new ones, one per name (SaveSymbol replaces a symbol of the same name).
 */
export function rescueLibraryText(existing: string | null, added: N[]): string {
  let lib;
  try { lib = parseLibrary(existing || NEW_LIBRARY_TEXT); } catch { lib = parseLibrary(NEW_LIBRARY_TEXT); }
  for (const n of added) lib.symbols.set(str(n[1]), n);
  return serializeLibrary(lib);
}

/** The instances list of the dialog (PopulateInstanceList): reference (GetRef on the current sheet) and value of every symbol of the requested id. */
export function instanceRows(symbols: RescueSymbol[], requestedId: string, instPath: string): string[][] {
  const out: string[][] = [];
  for (const s of symbols) {
    if (s.libId !== requestedId) continue;
    const value = K().kids(s.node, "property").find((p) => str(p[1]) === "Value");
    out.push([symbolInstanceRef(s.node, instPath).ref, value ? str(value[2]) : ""]);
  }
  return out;
}
