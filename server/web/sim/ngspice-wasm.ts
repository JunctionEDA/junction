// sim/ngspice-wasm — what the ngspice compiled to WebAssembly (npm eecircuit-engine, plugins/spice.ts) reads
// differently from the desktop ngspice KiCad drives, made up for in the simulator's own copy of the netlist and of
// every library it includes.  The netlist KiCad's exporter writes (Export Netlist, Show SPICE Netlist) is left as it
// is.
//
// * SPICE2 polynomial controlled sources (E/F/G/H … POLY(n) …).  The desktop ngspice reads POLY through XSPICE (its
//   "poly" code model); this build has no XSPICE and stops on a POLY line, yet vendor op-amp macro-models use them
//   all the time.  Each becomes the B source that computes the same polynomial (the SPICE2 coefficient order: P0,
//   the linear terms, then every product of degree 2, 3, … with its factors in non-decreasing order).
// * A .model parameter the device does not have.  The desktop ngspice warns "unrecognized parameter (x) - ignored"
//   and goes on; this build ends with a fatal "strtod: Invalid argument".  Such a parameter is left out, with the
//   desktop's warning.
// * Line ends: a library saved with lone carriage returns reads as one line here.
import { ngspiceModelParamNames } from "../dialogs/sim-model-logic";

/** The terms of the SPICE2 polynomial in `n` variables, in coefficient order after P0: each a list of variable
 *  indices (non-decreasing), degree by degree. */
function polyTerms(n: number, count: number): number[][] {
  const out: number[][] = [];
  for (let degree = 1; out.length < count && degree < 16; degree++) {
    const idx = new Array<number>(degree).fill(0);
    for (;;) {
      out.push(idx.slice());
      if (out.length >= count) break;
      let k = degree - 1;
      while (k >= 0 && idx[k] === n - 1) k--;
      if (k < 0) break;
      idx[k]++;
      for (let j = k + 1; j < degree; j++) idx[j] = idx[k];
    }
  }
  return out;
}

/** One POLY source line (continuations joined) as a B source, or null when it is not one. */
export function polyToB(line: string): string | null {
  const m = /^\s*([EFGHefgh]\S*)\s+(\S+)\s+(\S+)\s+POLY\s*\(\s*(\d+)\s*\)\s*(.*)$/i.exec(line);
  if (!m) return null;
  const [, name, np, nn, nd, rest] = m;
  const n = parseInt(nd, 10); if (!(n >= 1)) return null;
  const kind = name[0].toUpperCase();
  const tok = rest.replace(/[(),]/g, " ").split(/\s+/).filter(Boolean);
  // an initial-condition list (IC=…) at the end does not take part in the polynomial
  const icAt = tok.findIndex((t) => /^ic\s*=/i.test(t)); if (icAt >= 0) tok.splice(icAt);
  const perVar = kind === "E" || kind === "G" ? 2 : 1;
  if (tok.length < n * perVar) return null;
  const vars: string[] = [];
  for (let i = 0; i < n; i++) vars.push(perVar === 2 ? `V(${tok[2 * i]},${tok[2 * i + 1]})` : `I(${tok[i]})`);
  const coeffs = tok.slice(n * perVar);
  if (!coeffs.length) return `B${name} ${np} ${nn} ${kind === "E" || kind === "H" ? "V" : "I"}=0`;
  const terms = polyTerms(n, coeffs.length - 1);
  const parts: string[] = [];
  if (Number(coeffs[0]) !== 0 || !/^[-+0-9.eE]+$/.test(coeffs[0])) parts.push(`(${coeffs[0]})`);
  for (let i = 1; i < coeffs.length; i++) {
    const c = coeffs[i]; if (/^[-+]?0*\.?0*(e[-+]?\d+)?$/i.test(c)) continue;
    parts.push(`(${c})*` + terms[i - 1].map((k) => vars[k]).join("*"));
  }
  const expr = parts.length ? parts.join("+") : "0";
  return `B${name} ${np} ${nn} ${kind === "E" || kind === "H" ? "V" : "I"}=${expr}`;
}

/** The netlist (or library) with every POLY source replaced; everything else as it was. */
export function translatePoly(text: string): string {
  if (!/poly\s*\(/i.test(text)) return text;
  const lines = text.split(/\r?\n/), out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!/^\s*[EFGHefgh]/.test(line)) { out.push(line); continue; }
    // the source with its continuation lines
    let j = i + 1;
    while (j < lines.length && /^\s*\+/.test(lines[j])) { line += " " + lines[j].replace(/^\s*\+/, ""); j++; }
    // an inline comment ($ or ;) is not part of the source
    const code = line.replace(/\s[$;].*$/, "");
    const b = /poly\s*\(/i.test(code) ? polyToB(code) : null;
    if (b) { out.push(b); i = j - 1; } else out.push(lines[i]);
  }
  return out.join("\n");
}

/** Every .model statement (continuations joined) without the parameters its device does not have; each one left
 *  out is reported as the desktop ngspice reports it.  Models of other kinds (subcircuit-defined, R/C/L, switches,
 *  XSPICE) are left as they are. */
export function dropUnknownModelParams(text: string, warn?: (message: string) => void): string {
  if (!/^\s*\.model/im.test(text)) return text;
  const lines = text.split("\n"), out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\.model\s/i.test(lines[i])) { out.push(lines[i]); continue; }
    let stmt = lines[i], j = i + 1;
    while (j < lines.length && /^\s*\+/.test(lines[j])) { stmt += " " + lines[j].replace(/^\s*\+/, ""); j++; }
    const m = /^(\s*\.model\s+\S+\s+)([A-Za-z]+)(.*)$/i.exec(stmt.replace(/\s[$;].*$/, ""));
    if (!m) { out.push(lines[i]); continue; }
    const [, head, typeStr, rest] = m;
    const pair = /([A-Za-z_][\w]*)\s*=\s*(\{[^}]*\}|'[^']*'|"[^"]*"|[^\s,()]+)/g;
    const level = (/\blevel\s*=\s*([\w.]+)/i.exec(rest) || ["", ""])[1], version = (/\bversion\s*=\s*([\w.]+)/i.exec(rest) || ["", ""])[1];
    const known = ngspiceModelParamNames(typeStr, level, version);
    if (!known) { out.push(lines[i]); continue; }
    let dropped = false;
    const kept = rest.replace(pair, (all, name: string) => {
      if (known.has(name.toLowerCase())) return all;
      dropped = true; if (warn) warn(`Warning: Model issue: unrecognized parameter (${name.toLowerCase()}) - ignored`);
      return "";
    });
    if (!dropped) { out.push(lines[i]); continue; }
    out.push(head + typeStr + kept.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")"));
    i = j - 1;
  }
  return out.join("\n");
}

/** A netlist or library as this ngspice reads it best: line ends, POLY sources, unknown model parameters. */
export function forWasmNgspice(text: string, warn?: (message: string) => void): string {
  return dropUnknownModelParams(translatePoly(text.replace(/\r\n?/g, "\n")), warn);
}
