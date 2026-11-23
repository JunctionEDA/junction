// text-eval.ts — EXPRESSION_EVALUATOR (common/text_eval/): the @{…} math expressions of a text.
//
// A port of KiCad's text evaluator: the tokenizer (KIEVAL_TEXT_TOKENIZER, text_eval_wrapper.cpp:482-1160), the lemon
// grammar (text_eval.lemon) as a recursive-descent parser with the same precedence (comparisons < + - < * / % < unary
// minus < ^, ^ right-associative), the evaluator with its functions (EVAL_VISITOR, text_eval_parser.cpp) and the
// number formatting (VALUE_UTILS::ToString).  Evaluate() replaces each @{…} it can evaluate by its value and leaves an
// expression it cannot evaluate (a syntax error, an unknown function, a division by zero, an undefined variable) as
// written (evaluateWithPartialErrorRecovery).  The browser has no git repository, so the vcs…() functions answer as
// KiCad does outside one ("<unknown>", not dirty, distance 0).

type Value = number | string;
class EvalError extends Error {}

// ---------------------------------------------------------------- characters (utf8_utils::CHARACTER_CLASSIFIER)
const WS = new Set([0x20, 0x09, 0x0d, 0x0a, 0x0c, 0x0b, 0xa0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
const isWs = (c: string): boolean => c !== "" && WS.has(c.codePointAt(0)!);
const isDigit = (c: string): boolean => c >= "0" && c <= "9" && c.length === 1;
function isAlpha(c: string): boolean {
  if (!c) return false;
  const cp = c.codePointAt(0)!;
  return (cp >= 0x61 && cp <= 0x7a) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x80 && cp <= 0x10ffff && cp !== 0xfffd && !WS.has(cp));
}
const isAlnum = (c: string): boolean => isAlpha(c) || isDigit(c);

// ---------------------------------------------------------------- units (text_eval_units.h) and SI prefixes
const UNIT_MM: Record<string, number> = { thou: 25.4 / 1000, deg: 1, mm: 1, cm: 10, in: 25.4, mil: 25.4 / 1000, mils: 25.4 / 1000, um: 1 / 1000, ps: 1, fs: 1, "\"": 25.4, "°": 1, "ps/mm": 1, "ps/cm": 1, "ps/in": 1 };
const isUnit = (u: string): boolean => Object.prototype.hasOwnProperty.call(UNIT_MM, u);
/** UnitRegistry::convertToEdaUnits into millimetres (the evaluator's default units). */
const toDefaultUnits = (v: number, u: string): number => v * UNIT_MM[u] * (1 / UNIT_MM.mm);
const SI: Record<string, number> = { a: 1e-18, f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6, m: 1e-3, R: 1, F: 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
const isSi = (c: string): boolean => Object.prototype.hasOwnProperty.call(SI, c);

/** fast_float::from_chars over the whole string (the general format: no leading "+", "inf" / "nan" accepted). */
function fromChars(s: string): number | null {
  if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return parseFloat(s);
  const m = /^(-?)(inf|infinity|nan)$/i.exec(s);
  if (m) return m[2].toLowerCase() === "nan" ? NaN : m[1] ? -Infinity : Infinity;
  return null;
}

// ---------------------------------------------------------------- tokenizer (KIEVAL_TEXT_TOKENIZER)
type Tok = "ENDS" | "LT" | "GT" | "LE" | "GE" | "EQ" | "NE" | "PLUS" | "MINUS" | "MULTIPLY" | "DIVIDE" | "MODULO" | "POWER" | "COMMA"
  | "TEXT" | "AT_OPEN" | "CLOSE_BRACE" | "LPAREN" | "RPAREN" | "NUMBER" | "STRING" | "IDENTIFIER" | "DOLLAR_OPEN";
interface Token { type: Tok; text: string; num: number }
const SINGLE: Record<string, Tok> = { "(": "LPAREN", ")": "RPAREN", "+": "PLUS", "-": "MINUS", "*": "MULTIPLY", "/": "DIVIDE", "%": "MODULO", "^": "POWER", ",": "COMMA", "<": "LT", ">": "GT" };

function tokenize(input: string): Token[] {
  const t = Array.from(input);
  let pos = 0, expr = false, nesting = 0;
  const cur = (): string => (pos < t.length ? t[pos] : "");
  const peek = (o = 1): string => (pos + o < t.length ? t[pos + o] : "");
  const fail = (msg: string): never => { throw new EvalError(msg); };
  const tok = (type: Tok, text = "", num = 0): Token => ({ type, text: text.slice(0, 1023), num });
  const atExponent = (): boolean => {
    const c = cur(); if (c !== "e" && c !== "E") return false;
    let o = 1; if (peek(o) === "+" || peek(o) === "-") ++o;
    return isDigit(peek(o));
  };
  const lookUnit = (): string => { let u = "", p = pos; while (p < t.length && (isAlpha(t[p]) || t[p] === "\"" || t[p] === "'")) u += t[p++]; return u; };
  function stringLiteral(q: string): Token {
    pos++;
    let content = "";
    while (pos < t.length && cur() !== q) {
      const c = cur();
      if (c === "\\" && pos + 1 < t.length) {
        const e = peek(); pos += 2;
        switch (e) {
          case "n": content += "\n"; break;
          case "t": content += "\t"; break;
          case "r": content += "\r"; break;
          case "\\": content += "\\"; break;
          case "\"": content += "\""; break;
          case "'": content += "'"; break;
          case "0": content += "\0"; break;
          case "x": {
            let hex = "";
            for (let i = 0; i < 2 && pos < t.length; ++i) { if (/^[0-9A-Fa-f]$/.test(cur())) { hex += cur(); pos++; } else break; }
            content += hex ? String.fromCodePoint(parseInt(hex, 16)) : "\\x";
            break;
          }
          default: content += "\\" + e;
        }
      } else if (c === "\n") fail("Unterminated string literal");
      else { content += c; pos++; }
    }
    if (pos < t.length && cur() === q) pos++; else fail("Missing closing quote in string literal");
    return tok("STRING", content);
  }
  function number(): Token {
    let text = "", mult = 1, hasPrefix = false;
    // R and F carry no scale, so only accept them as RKM markers, never ahead of a unit like 1Rin
    const canPrefix = (p: string): boolean => (!isSi(p) ? false : p === "R" || p === "F" ? !isAlpha(peek()) && peek() !== "_" : true);
    const takePrefix = (p: string): void => { mult = SI[p]; hasPrefix = true; pos++; };
    while (pos < t.length && isDigit(cur())) text += t[pos++];
    if (pos < t.length) {
      const c = cur();
      if (c === "." || (c === "," && !expr)) { text += "."; pos++; }
      else if (atExponent()) { /* 3E3 is an exponent, not exa */ }
      else if (expr && isAlpha(c)) {
        const u = lookUnit();
        if (u) { if (!isUnit(u) && canPrefix(c)) takePrefix(c); }
        else if (canPrefix(c)) takePrefix(c);
      } else if (canPrefix(c)) takePrefix(c);
      // RKM notation (3k3, 4R7) puts the multiplier where the decimal point goes
      if (hasPrefix && pos < t.length && isDigit(cur())) text += ".";
    }
    while (pos < t.length && isDigit(cur())) text += t[pos++];
    if (atExponent()) {
      text += t[pos++];
      if (pos < t.length && (cur() === "+" || cur() === "-")) text += t[pos++];
      if (pos < t.length && isDigit(cur())) { while (pos < t.length && isDigit(cur())) text += t[pos++]; }
      else fail("Invalid scientific notation: missing exponent digits");
    }
    if (pos < t.length && !hasPrefix) {
      const c = cur();
      if (expr && isAlpha(c)) { const u = lookUnit(); if (u && !isUnit(u) && canPrefix(c)) takePrefix(c); }
      else if (canPrefix(c)) takePrefix(c);
    }
    let value = 0;
    if (text && text !== ".") {
      const v = fromChars(text);
      if (v === null) fail("Invalid number format");
      value = v! * mult;
      if (!isFinite(value)) fail("Number out of range");
    }
    if (pos < t.length && expr) {
      const wsStart = pos;
      while (pos < t.length && isWs(cur())) pos++;
      let u = "";
      while (pos < t.length && (isAlpha(cur()) || cur() === "\"" || cur() === "'")) u += t[pos++];
      if (u && isUnit(u)) value = toDefaultUnits(value, u);
      else pos = wsStart;
    }
    return tok("NUMBER", "", value);
  }
  function identifier(): Token { let s = ""; while (pos < t.length && (isAlnum(cur()) || cur() === "_")) s += t[pos++]; return tok("IDENTIFIER", s); }
  function textContent(): Token {
    let s = "";
    while (pos < t.length) { const c = cur(), n = peek(); if ((c === "@" || c === "$") && n === "{") break; s += c; pos++; }
    return tok("TEXT", s);
  }
  function next(): Token {
    if (pos >= t.length) return tok("ENDS");
    if (expr) { while (pos < t.length && isWs(cur())) pos++; if (pos >= t.length) return tok("ENDS"); }
    const c = cur(), n = peek();
    if ((c === "@" || c === "$") && n === "{") { pos += 2; expr = true; nesting++; return tok(c === "@" ? "AT_OPEN" : "DOLLAR_OPEN"); }
    if (c === "}") { pos++; if (--nesting <= 0) { nesting = 0; expr = false; } return tok("CLOSE_BRACE"); }
    if (c === "<" && n === "=") { pos += 2; return tok("LE"); }
    if (c === ">" && n === "=") { pos += 2; return tok("GE"); }
    if (c === "=" && n === "=") { pos += 2; return tok("EQ"); }
    if (c === "!" && n === "=") { pos += 2; return tok("NE"); }
    if (expr && SINGLE[c]) { pos++; return tok(SINGLE[c], c); }
    if (c === "\"" || c === "'") return stringLiteral(c);
    if (isDigit(c) || (c === "." && isDigit(n))) return number();
    if (isAlpha(c) || c === "_") return expr ? identifier() : textContent();
    const tc = textContent();
    return tc.text === "" ? tok("ENDS") : tc;
  }
  const out: Token[] = [];
  for (;;) { const k = next(); out.push(k); if (k.type === "ENDS" || pos >= t.length) break; }
  if (out[out.length - 1].type !== "ENDS") out.push(tok("ENDS"));
  return out;
}

// ---------------------------------------------------------------- parser (text_eval.lemon)
type Node =
  | { k: "text"; s: string } | { k: "calc"; e: Node } | { k: "num"; v: number } | { k: "str"; v: string } | { k: "var"; name: string }
  | { k: "bin"; op: string; l: Node; r: Node } | { k: "fn"; name: string; args: Node[] };
const CMP: Partial<Record<Tok, string>> = { LT: "<", GT: ">", LE: "<=", GE: ">=", EQ: "==", NE: "!=" };

function parseDoc(tokens: Token[]): Node[] {
  let i = 0;
  const peek = (): Token => tokens[i];
  const take = (type: Tok): Token => { if (tokens[i].type !== type) throw new EvalError("Syntax error"); return tokens[i++]; };
  function variable(): Node { take("DOLLAR_OPEN"); const id = take("IDENTIFIER"); take("CLOSE_BRACE"); return { k: "var", name: id.text }; }
  function primary(): Node {
    const tk = peek();
    switch (tk.type) {
      case "NUMBER": i++; return { k: "num", v: tk.num };
      case "STRING": i++; return { k: "str", v: tk.text };
      case "DOLLAR_OPEN": return variable();
      case "LPAREN": { i++; const e = expression(); take("RPAREN"); return e; }
      case "IDENTIFIER": {
        i++; take("LPAREN");
        const args: Node[] = [];
        if (peek().type !== "RPAREN") { args.push(expression()); while (peek().type === "COMMA") { i++; args.push(expression()); } }
        take("RPAREN");
        return { k: "fn", name: tk.text, args };
      }
      default: throw new EvalError("Syntax error");
    }
  }
  // factor ::= MINUS factor [UMINUS] | PLUS factor | factor POWER factor | …: ^ binds tighter than the unary sign
  function factor(): Node {
    const tk = peek();
    if (tk.type === "MINUS") { i++; return { k: "bin", op: "-", l: { k: "num", v: 0 }, r: factor() }; }
    if (tk.type === "PLUS") { i++; return factor(); }
    const base = primary();
    if (peek().type === "POWER") { i++; return { k: "bin", op: "^", l: base, r: factor() }; }
    return base;
  }
  function term(): Node {
    let l = factor();
    for (;;) { const ty = peek().type; if (ty !== "MULTIPLY" && ty !== "DIVIDE" && ty !== "MODULO") return l; i++; l = { k: "bin", op: ty === "MULTIPLY" ? "*" : ty === "DIVIDE" ? "/" : "%", l, r: factor() }; }
  }
  function additive(): Node {
    let l = term();
    for (;;) { const ty = peek().type; if (ty !== "PLUS" && ty !== "MINUS") return l; i++; l = { k: "bin", op: ty === "PLUS" ? "+" : "-", l, r: term() }; }
  }
  function expression(): Node {
    let l = additive();
    for (;;) { const op = CMP[peek().type]; if (!op) return l; i++; l = { k: "bin", op, l, r: additive() }; }
  }
  const nodes: Node[] = [];
  for (;;) {
    const tk = peek();
    if (tk.type === "ENDS") break;
    if (tk.type === "TEXT") { i++; nodes.push({ k: "text", s: tk.text }); }
    else if (tk.type === "AT_OPEN") { i++; const e = expression(); take("CLOSE_BRACE"); nodes.push({ k: "calc", e }); }
    else if (tk.type === "DOLLAR_OPEN") nodes.push({ k: "calc", e: variable() });
    else throw new EvalError("Syntax error");
  }
  return nodes;
}

// ---------------------------------------------------------------- values (VALUE_UTILS)
function toDouble(v: Value): number {
  if (typeof v === "number") return v;
  const d = fromChars(v);
  if (d === null) throw new EvalError(`Cannot convert '${v}' to number`);
  return d;
}
/** fmt's "{}" for a double: the shortest round-trip digits, exponent form below 1e-4 or from 1e16 ("1e-05", "1.5e+16"). */
function fmtShortest(n: number): string {
  if (!isFinite(n)) return isNaN(n) ? "nan" : n < 0 ? "-inf" : "inf";
  if (n === 0) return Object.is(n, -0) ? "-0" : "0";
  const [mant, e] = n.toExponential().split("e"); const exp = Number(e);
  if (exp < -4 || exp >= 16) return `${mant}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  const neg = mant[0] === "-", digits = mant.replace("-", "").replace(".", "");
  let s: string;
  if (exp >= 0) s = digits.length > exp + 1 ? digits.slice(0, exp + 1) + "." + digits.slice(exp + 1) : digits + "0".repeat(exp + 1 - digits.length);
  else s = "0." + "0".repeat(-exp - 1) + digits;
  return (neg ? "-" : "") + s;
}
/** fmt's "{:.Nf}": round half to even on an exact tie (JavaScript's toFixed rounds such ties up). */
function fmtFixed(v: number, d: number): string {
  if (!isFinite(v)) return isNaN(v) ? "nan" : v < 0 ? "-inf" : "inf";
  if (d < 0 || d > 100) throw new EvalError("Invalid precision");
  const scaled = Math.abs(v) * Math.pow(10, d);
  if (Number.isInteger(scaled * 2) && !Number.isInteger(scaled) && scaled < 9e15) {
    const fl = Math.floor(scaled), even = fl % 2 === 0 ? fl : fl + 1;
    const s = (even / Math.pow(10, d)).toFixed(d);
    return (v < 0 || Object.is(v, -0) ? "-" : "") + s;
  }
  const s = v.toFixed(d);
  return Object.is(v, -0) || (v < 0 && !s.startsWith("-")) ? "-" + s : s;
}
function toStr(v: Value): string {
  if (typeof v === "string") return v;
  const rounded = Math.round(v) === v ? v : Math.sign(v) * Math.round(Math.abs(v));   // std::round: half away from zero
  if (Math.abs(v - rounded) < 1e-10 && Math.abs(rounded) < 1e15) return Object.is(rounded, -0) || (rounded === 0 && v < 0) ? "-0" : rounded.toFixed(0);
  return fmtShortest(v);
}
const toChar = (v: Value): string => { const s = toStr(v); return s ? s[0] : " "; };
const cRound = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));

// ---------------------------------------------------------------- dates (DATE_UTILS)
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInYear = (y: number): number => (isLeap(y) ? 366 : 365);
const daysInMonthFor = (m: number, y: number): number => (m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m - 1]);
const P2 = (n: number): string => String(n).padStart(2, "0"), P4 = (n: number): string => (n < 0 ? "-" + String(-n).padStart(3, "0") : String(n).padStart(4, "0"));
function daysToYmd(days: number): [number, number, number] {
  let year = 1970, rem = days;
  if (rem >= 0) { while (rem >= daysInYear(year)) { rem -= daysInYear(year); year++; } }
  else { while (rem < 0) { year--; rem += daysInYear(year); } }
  let month = 1;
  while (month <= 12 && rem >= daysInMonthFor(month, year)) { rem -= daysInMonthFor(month, year); month++; }
  return [year, month, rem + 1];
}
function ymdToDays(y: number, m: number, d: number): number {
  let total = 0;
  if (y >= 1970) for (let k = 1970; k < y; ++k) total += daysInYear(k); else for (let k = y; k < 1970; ++k) total -= daysInYear(k);
  for (let k = 1; k < m; ++k) total += daysInMonthFor(k, y);
  return total + d - 1;
}
/** std::stoi: leading whitespace, an optional sign and digits; anything else first is an error. */
function stoi(s: string): number { const m = /^\s*([-+]?\d+)/.exec(s); if (!m) throw new EvalError("stoi"); return parseInt(m[1], 10); }
function parseDate(s: string): number | null {
  let parts: number[] = [], sep = "", cjk = false;
  const has = (x: string): boolean => s.indexOf(x) >= 0;
  if ((has("年") || has("년")) && (has("月") || has("월")) && (has("日") || has("일"))) {
    cjk = true;
    // KiCad cuts by UTF-8 byte offsets: every CJK marker is three bytes long
    const bytes = new TextEncoder().encode(s), dec = new TextDecoder();
    const at = (m: string): number => { const i = s.indexOf(m); return new TextEncoder().encode(s.slice(0, i)).length; };
    const yp = at(has("年") ? "年" : "년"), mp = at(has("月") ? "月" : "월"), dp = at(has("日") ? "日" : "일");
    const sub = (a: number, n: number): string => dec.decode(bytes.slice(a, n < 0 ? a : a + n));
    try { parts = [stoi(sub(0, yp)), stoi(sub(yp + 3, mp - yp - 3)), stoi(sub(mp + 3, dp - mp - 3))]; } catch (e) { return null; }
  } else if (has("-")) sep = "-"; else if (has("/")) sep = "/"; else if (has(".")) sep = ".";
  if (sep) {
    // std::getline: a trailing separator gives no empty last field
    const fields = s.split(sep); if (fields.length > 1 && fields[fields.length - 1] === "") fields.pop();
    try { for (const f of fields) parts.push(stoi(f)); } catch (e) { return null; }
  } else if (!cjk && s.length === 8) {
    let n: number; try { n = stoi(s); } catch (e) { return null; }
    return ymdToDays(Math.trunc(n / 10000), Math.trunc(n / 100) % 100, n % 100);
  } else if (!cjk) return null;
  if (!parts.length || parts.length > 3) return null;
  let year: number, month: number, day: number;
  if (parts.length === 1) { year = parts[0]; month = 1; day = 1; }
  else if (parts.length === 2) { year = parts[0]; month = parts[1]; day = 1; }
  else if (cjk) [year, month, day] = parts;
  else if (sep === "/" && parts[0] <= 12 && parts[1] <= 31) { month = parts[0]; day = parts[1]; year = parts[2]; }
  else if (sep === "/" && parts[1] <= 12) { day = parts[0]; month = parts[1]; year = parts[2]; }
  else [year, month, day] = parts;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonthFor(month, year)) return null;
  return ymdToDays(year, month, day);
}
function formatDate(days: number, f: string): string {
  const [y, m, d] = daysToYmd(days);
  if (f === "US" || f === "us") return `${P2(m)}/${P2(d)}/${P4(y)}`;
  if (f === "EU" || f === "european") return `${P2(d)}/${P2(m)}/${P4(y)}`;
  if (f === "long") return `${MONTHS[m - 1]} ${d}, ${y}`;
  if (f === "short") return `${MONTHS3[m - 1]} ${d}, ${y}`;
  if (["Chinese", "chinese", "CN", "cn", "中文", "Japanese", "japanese", "JP", "jp", "日本語"].indexOf(f) >= 0) return `${y}年${P2(m)}月${P2(d)}日`;
  if (["Korean", "korean", "KR", "kr", "한국어"].indexOf(f) >= 0) return `${y}년 ${P2(m)}월 ${P2(d)}일`;
  return `${P4(y)}-${P2(m)}-${P2(d)}`;
}
const weekdayName = (days: number): string => { let w = (days + 3) % 7; if (w < 0) w += 7; return WEEKDAYS[w]; };
function formatTime(ts: number, f: string): string {
  const t = new Date(Math.trunc(ts) * 1000), h = t.getHours(), mi = t.getMinutes(), s = t.getSeconds();
  if (f === "12h") { const h12 = h % 12 || 12; return `${h12}:${P2(mi)}:${P2(s)} ${h >= 12 ? "PM" : "AM"}`; }
  if (f === "HH_MM_SS" || f === "filename") return `${P2(h)}h${P2(mi)}m${P2(s)}s`;
  if (f === "short") return `${P2(h)}:${P2(mi)}`;
  return `${P2(h)}:${P2(mi)}:${P2(s)}`;
}

// ---------------------------------------------------------------- E series (ESERIES_UTILS)
const E24 = [100, 110, 120, 130, 150, 160, 180, 200, 220, 240, 270, 300, 330, 360, 390, 430, 470, 510, 560, 620, 680, 750, 820, 910];
const E192 = [100, 101, 102, 104, 105, 106, 107, 109, 110, 111, 113, 114, 115, 117, 118, 120, 121, 123, 124, 126, 127, 129, 130, 132, 133, 135, 137, 138, 140, 142, 143, 145, 147, 149, 150, 152,
  154, 156, 158, 160, 162, 164, 165, 167, 169, 172, 174, 176, 178, 180, 182, 184, 187, 189, 191, 193, 196, 198, 200, 203, 205, 208, 210, 213, 215, 218, 221, 223, 226, 229, 232, 234,
  237, 240, 243, 246, 249, 252, 255, 258, 261, 264, 267, 271, 274, 277, 280, 284, 287, 291, 294, 298, 301, 305, 309, 312, 316, 320, 324, 328, 332, 336, 340, 344, 348, 352, 357, 361,
  365, 370, 374, 379, 383, 388, 392, 397, 402, 407, 412, 417, 422, 427, 432, 437, 442, 448, 453, 459, 464, 470, 475, 481, 487, 493, 499, 505, 511, 517, 523, 530, 536, 542, 549, 556,
  562, 569, 576, 583, 590, 597, 604, 612, 619, 626, 634, 642, 649, 657, 665, 673, 681, 690, 698, 706, 715, 723, 732, 741, 750, 759, 768, 777, 787, 796, 806, 816, 825, 835, 845, 856,
  866, 876, 887, 898, 909, 920, 931, 942, 953, 965, 976, 988];
const SERIES: Record<string, number> = { E3: 3, e3: 3, E6: 6, e6: 6, E12: 12, e12: 12, E24: 24, e24: 24, E48: 48, e48: 48, E96: 96, e96: 96, E192: 192, e192: 192 };
const seriesValue = (n: number, i: number): number => (n <= 24 ? E24[i * (24 / n)] : E192[i * (192 / n)]);
function eSeries(kind: "enearest" | "eup" | "edown", value: number, s: string): number | null {
  const n = Object.prototype.hasOwnProperty.call(SERIES, s) ? SERIES[s] : -1;
  if (n < 0 || value <= 0) return null;
  const decade = Math.floor(Math.log10(value)), normalized = (value / Math.pow(10, decade)) * 100;
  if (kind === "enearest") {
    let minDiff = Number.MAX_VALUE, nearest = 100;
    for (let i = 0; i < n; ++i) { const v = seriesValue(n, i), diff = Math.abs(normalized - v); if (diff < minDiff) { minDiff = diff; nearest = v; } }
    return (nearest / 100) * Math.pow(10, decade);
  }
  if (kind === "eup") {
    for (let i = 0; i < n; ++i) { const v = seriesValue(n, i); if (v > normalized) return (v / 100) * Math.pow(10, decade); }
    return (seriesValue(n, 0) / 100) * Math.pow(10, decade + 1);
  }
  for (let i = n - 1; i >= 0; --i) { const v = seriesValue(n, i); if (v < normalized) return (v / 100) * Math.pow(10, decade); }
  return (seriesValue(n, n - 1) / 100) * Math.pow(10, decade - 1);
}

// ---------------------------------------------------------------- evaluation (EVAL_VISITOR)
const nowSeconds = (): number => Math.floor(Date.now() / 1000);
function evalNode(n: Node): Value {
  switch (n.k) {
    case "num": return n.v;
    case "str": return n.v;
    // the variables of a text are expanded before it is evaluated: one left here is undefined
    case "var": throw new EvalError(`Undefined variable: ${n.name}`);
    case "bin": {
      const l = evalNode(n.l), r = evalNode(n.r);
      if (n.op === "+" && (typeof l === "string" || typeof r === "string")) return toStr(l) + toStr(r);
      if ((n.op === "==" || n.op === "!=") && typeof l === "string" && typeof r === "string") return (l === r) === (n.op === "==") ? 1 : 0;
      const a = toDouble(l), b = toDouble(r);
      switch (n.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": if (b === 0) throw new EvalError("Division by zero"); return a / b;
        case "%": if (b === 0) throw new EvalError("Modulo by zero"); return a % b;
        case "^": return Math.pow(a, b);
        case "<": return a < b ? 1 : 0;
        case ">": return a > b ? 1 : 0;
        case "<=": return a <= b ? 1 : 0;
        case ">=": return a >= b ? 1 : 0;
        case "==": return a === b ? 1 : 0;
        case "!=": return a !== b ? 1 : 0;
      }
      throw new EvalError("Unknown operator");
    }
    case "fn": return evalFunction(n.name, n.args);
  }
  throw new EvalError("Cannot evaluate this node type");
}
function evalFunction(name: string, args: Node[]): Value {
  if (!args.length) {
    if (name === "today") return Math.floor(nowSeconds() / 86400);
    if (name === "now") return nowSeconds();
    if (name === "random") return Math.random();
  }
  const v = args.map(evalNode), argc = v.length;
  const S = (i: number): string => toStr(v[i]);
  const optInt = (i: number, d: number): number => { if (argc <= i) return d; try { return Math.trunc(toDouble(v[i])); } catch (e) { return d; } };
  const optBool = (i: number): boolean => { if (argc <= i) return false; try { return toDouble(v[i]) !== 0; } catch (e) { return false; } };
  if ((name === "format" || name === "fixed") && argc >= 1) return fmtFixed(toDouble(v[0]), optInt(1, 2));
  if (name === "currency" && argc >= 1) { const amount = toDouble(v[0]); return (argc > 1 ? S(1) : "$") + fmtFixed(amount, 2); }
  if (name === "dateformat" && argc >= 1) return formatDate(Math.trunc(toDouble(v[0])), argc > 1 ? S(1) : "ISO");
  if (name === "datestring" && argc === 1) { const d = parseDate(S(0)); if (d === null) throw new EvalError("Invalid date format: " + S(0)); return d; }
  if (name === "weekdayname" && argc === 1) return weekdayName(Math.trunc(toDouble(v[0])));
  if (name === "timeformat" && argc >= 1) return formatTime(toDouble(v[0]), argc > 1 ? S(1) : "ISO");
  // no repository in the browser: KiCad's answers outside one
  const unknown = "<unknown>";
  if (name === "vcsidentifier" && argc <= 1) { optInt(0, 40); return unknown; }
  if ((name === "vcsnearestlabel") && argc <= 2) return unknown;
  if (name === "vcslabeldistance" && argc <= 2) return "0";
  if (name === "vcsdirty" && argc <= 1) { optBool(0); return "0"; }
  if (name === "vcsdirtysuffix" && argc <= 2) return "";
  if ((name === "vcsauthor" || name === "vcsauthoremail" || name === "vcscommitter" || name === "vcscommitteremail" || name === "vcsbranch") && argc === 0) return unknown;
  if (name === "vcscommitdate" && argc <= 1) return unknown;
  if (name === "vcsfileidentifier" && argc >= 1 && argc <= 2) return unknown;
  if ((name === "vcsfileauthor" || name === "vcsfileauthoremail" || name === "vcsfilecommitter" || name === "vcsfilecommitteremail") && argc === 1) return unknown;
  if (name === "vcsfilecommitdate" && argc >= 1 && argc <= 2) return unknown;
  if (name === "upper" && argc === 1) return S(0).toUpperCase();
  if (name === "lower" && argc === 1) return S(0).toLowerCase();
  if (name === "concat" && argc >= 2) return v.map(toStr).join("");
  if (name === "beforefirst" && argc === 2) { const s = S(0), i = s.indexOf(toChar(v[1])); return i < 0 ? s : s.slice(0, i); }
  if (name === "beforelast" && argc === 2) { const s = S(0), i = s.lastIndexOf(toChar(v[1])); return i < 0 ? "" : s.slice(0, i); }
  if (name === "afterfirst" && argc === 2) { const s = S(0), i = s.indexOf(toChar(v[1])); return i < 0 ? "" : s.slice(i + 1); }
  if (name === "afterlast" && argc === 2) { const s = S(0), i = s.lastIndexOf(toChar(v[1])); return i < 0 ? s : s.slice(i + 1); }
  if (name === "replace" && argc === 3) { const s = S(0), search = S(1); return search ? s.split(search).join(S(2)) : s; }
  if (name === "if" && argc === 3) return toDouble(v[0]) !== 0 ? v[1] : v[2];
  if ((name === "enearest" || name === "eup" || name === "edown") && argc >= 1 && argc <= 2) {
    const value = toDouble(v[0]), series = argc > 1 ? S(1) : "E24", r = eSeries(name, value, series);
    if (r === null) throw new EvalError(`Invalid E-series: ${series}`);
    return r;
  }
  const a = v.map(toDouble);
  if (name === "abs" && argc === 1) return Math.abs(a[0]);
  if (name === "sum" && argc >= 1) return a.reduce((s, x) => s + x, 0);
  if (name === "round" && argc >= 1) { const m = Math.pow(10, argc > 1 ? Math.trunc(a[1]) : 0); return cRound(a[0] * m) / m; }
  if (name === "sqrt" && argc === 1) { if (a[0] < 0) throw new EvalError("Square root of negative number"); return Math.sqrt(a[0]); }
  if (name === "pow" && argc === 2) return Math.pow(a[0], a[1]);
  if (name === "floor" && argc === 1) return Math.floor(a[0]);
  if (name === "ceil" && argc === 1) return Math.ceil(a[0]);
  if (name === "min" && argc >= 1) return a.reduce((m, x) => (x < m ? x : m));
  if (name === "max" && argc >= 1) return a.reduce((m, x) => (m < x ? x : m));
  if (name === "avg" && argc >= 1) return a.reduce((s, x) => s + x, 0) / argc;
  if (name === "shunt" && argc === 2) { const sum = a[0] + a[1]; return sum > 0 ? (a[0] * a[1]) / sum : 0; }
  if (name === "db" && argc === 1) { if (a[0] <= 0) throw new EvalError("db() argument must be positive"); return 10 * Math.log10(a[0]); }
  if (name === "dbv" && argc === 1) { if (a[0] <= 0) throw new EvalError("dbv() argument must be positive"); return 20 * Math.log10(a[0]); }
  if (name === "fromdb" && argc === 1) return Math.pow(10, a[0] / 10);
  if (name === "fromdbv" && argc === 1) return Math.pow(10, a[0] / 20);
  throw new EvalError(`Unknown function: ${name} with ${argc} arguments`);
}

/** evaluateWithFullParser: the whole text through the tokenizer, the grammar and DOC_PROCESSOR::Process; null on any error. */
function evaluateFull(input: string): string | null {
  if (!input) return "";
  try {
    let out = "";
    for (const n of parseDoc(tokenize(input))) out += n.k === "text" ? n.s : toStr(evalNode((n as { e: Node }).e));
    return out;
  } catch (e) { return null; }
}

/**
 * EXPRESSION_EVALUATOR::Evaluate (text_eval_wrapper.cpp:1415-1446, evaluateWithParser and
 * evaluateWithPartialErrorRecovery): each complete @{…} is evaluated on its own, right to left, and replaced by its value
 * when it evaluates; one that does not is left as written.  When none evaluates the whole text is tried at once.
 */
export function evaluateText(input: string): string {
  let result = input;
  const ranges: [number, number][] = [];
  let pos = 0;
  while ((pos = result.indexOf("@{", pos)) >= 0) {
    const exprStart = pos + 2; let depth = 1, p = exprStart;
    while (p < result.length && depth > 0) { if (result[p] === "{") depth++; else if (result[p] === "}") depth--; p++; }
    if (depth === 0) { ranges.push([pos, p]); pos = p; } else pos = exprStart;
  }
  for (let k = ranges.length - 1; k >= 0; k--) {
    const [s, e] = ranges[k];
    const v = evaluateFull("@{" + result.slice(s + 2, e - 1) + "}");
    if (v !== null) result = result.slice(0, s) + v + result.slice(e);
  }
  if (result !== input) return result;
  const full = evaluateFull(input);
  return full === null ? input : full;
}
