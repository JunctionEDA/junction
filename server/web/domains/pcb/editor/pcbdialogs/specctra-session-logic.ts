// pcbdialogs/specctra-session-logic.ts — File > Import > Specctra Session... without the DOM: SPECCTRA_DB::LoadSESSION's
// reading of a .ses file (the DSN lexer: parentheses, symbols, numbers, strings in the quote character a (parser
// (string_quote …)) names) and FromSESSION (pcbnew/specctra_import_export/specctra_import.cpp): the unlocked tracks and
// vias removed, the (placement) moving, flipping and turning footprints, every (routes (network_out (net …))) wire
// path / qarc and via made anew in the route resolution, vias from their (library_out (padstack …)) circles (through,
// blind, buried or micro by the layers they span; the drill from KiCad's own "Via[0-1]_800:400_um" name), the
// skipped items counted.  The sections the import does not read (history, structure, was_is, structure_out, rules,
// windows) are read as balanced lists and left alone.
type N = SNode;

/** A DSN token: "(" / ")", a string (quoted), a number or a symbol, with where it starts */
interface Tok { t: "(" | ")" | "str" | "num" | "sym" | "eof"; v: string; line: number; col: number }

/** IO_ERROR's text: what went wrong, where */
export class SesError extends Error {}
function lex(text: string, source: string): Tok[] {
  const out: Tok[] = []; let i = 0, line = 1, lineStart = 0, quote = '"', prevSym = "";
  const n = text.length;
  const at = (): { line: number; col: number } => ({ line, col: i - lineStart + 1 });
  while (i < n) {
    const c = text[i];
    if (c === "\n") { i++; line++; lineStart = i; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    // DSNLEXER: a line whose first non-blank character is '#' is a comment
    if (c === "#" && /^[ \t]*$/.test(text.slice(lineStart, i))) { while (i < n && text[i] !== "\n") i++; continue; }
    const pos = at();
    // (string_quote ") : the next character is the quote itself (T_QUOTE_DEF)
    if (prevSym === "string_quote") { out.push({ t: "sym", v: c, ...pos }); prevSym = ""; i++; continue; }
    if (c === "(" || c === ")") { out.push({ t: c, v: c, ...pos }); i++; prevSym = ""; continue; }
    if (c === quote) {
      let j = i + 1; let s = "";
      while (j < n && text[j] !== quote) { if (text[j] === "\n") throw new SesError(`Un-terminated delimited string in input/source\n'${source}'\nline ${pos.line}\noffset ${pos.col}`); s += text[j]; j++; }
      if (j >= n) throw new SesError(`Un-terminated delimited string in input/source\n'${source}'\nline ${pos.line}\noffset ${pos.col}`);
      out.push({ t: "str", v: s, ...pos }); i = j + 1; prevSym = ""; continue;
    }
    let j = i; while (j < n && !/[\s()]/.test(text[j])) j++;
    const word = text.slice(i, j);
    const isNum = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(word);
    out.push({ t: isNum ? "num" : "sym", v: word, ...pos });
    prevSym = isNum ? "" : word;
    i = j;
    // (string_quote X) changes the delimiter for what follows: done when the list closes
    if (out.length >= 3 && out[out.length - 2].v === "string_quote" && out[out.length - 3].t === "(") quote = word;
  }
  out.push({ t: "eof", v: "", line, col: i - lineStart + 1 });
  return out;
}

/** UNIT_RES: the engineering units and the resolution value (units per the unit) */
export interface UnitRes { units: "inch" | "mil" | "cm" | "mm" | "um"; value: number }
/** UNIT_RES::Default: inch, 2540000 */
export const DEFAULT_RES: UnitRes = { units: "inch", value: 2540000 };
export interface SesPlace { ref: string; vertex: [number, number] | null; side: "front" | "back"; rotation: number }
export interface SesPath { kind: "path" | "polygon"; layer: string; width: number; points: [number, number][] }
export interface SesQarc { kind: "qarc"; layer: string; width: number; vertex: [[number, number], [number, number], [number, number]] }
export interface SesWire { shape: SesPath | SesQarc | { kind: "rect" | "circle" }; type: string }
export interface SesVia { padstack: string; vertexes: [number, number][]; type: string }
export interface SesNet { id: string; wires: SesWire[]; vias: SesVia[] }
export interface SesPadstack { id: string; shapes: { kind: string; layer: string; diameter: number }[] }
export interface Session {
  id: string; placementUnits: UnitRes | null; places: SesPlace[] | null;
  routes: { resolution: UnitRes | null; library: SesPadstack[] | null; nets: SesNet[] } | null;
}

/** SPECCTRA_DB::LoadSESSION: the session's parts the import uses; a malformed file throws SesError with its place. */
export function parseSession(text: string, source: string): Session {
  const toks = lex(text, source); let p = 0;
  const err = (what: string, t: Tok): never => { throw new SesError(`${what} in input/source\n'${source}'\nline ${t.line}\noffset ${t.col}`); };
  const next = (): Tok => toks[Math.min(p++, toks.length - 1)];
  const cur = (): Tok => toks[Math.max(0, p - 1)];
  const expecting = (what: string): never => err(`Expecting ${what}`, cur());
  const unexpected = (t: Tok = cur()): never => err(`Unexpected '${t.v}'`, t);
  const isSymbol = (t: Tok): boolean => t.t === "sym" || t.t === "str";
  const needRight = (): void => { if (next().t !== ")") expecting("')'"); };
  const needSymbol = (): string => { const t = next(); if (!isSymbol(t)) expecting("a symbol"); return t.v; };
  const needSymbolOrNumber = (): string => { const t = next(); if (!isSymbol(t) && t.t !== "num") expecting("a symbol or number"); return t.v; };
  const number = (what = "a number"): number => { const t = next(); if (t.t !== "num") expecting(what); return parseFloat(t.v); };
  /** a list the import does not read: skipped to its closing parenthesis */
  const skipList = (): void => { let depth = 1; while (depth > 0) { const t = next(); if (t.t === "eof") unexpected(t); if (t.t === "(") depth++; else if (t.t === ")") depth--; } };
  const doResolution = (): UnitRes => {
    const u = next().v.toLowerCase();
    if (!["inch", "mil", "cm", "mm", "um"].includes(u)) expecting("inch|mil|cm|mm|um");
    const v = next(); if (v.t !== "num") expecting("a number");
    needRight();
    return { units: u as UnitRes["units"], value: parseInt(v.v, 10) };
  };
  const doUnit = (): UnitRes => {
    const u = next().v;
    if (!["inch", "mil", "cm", "mm", "um"].includes(u)) expecting("inch|mil|cm|mm|um");
    needRight();
    return { units: u as UnitRes["units"], value: 2540000 };   // UNIT_RES( parent, T_unit ) keeps the default value
  };
  const doPath = (kind: "path" | "polygon"): SesPath => {
    const lt = next(); if (!isSymbol(lt) && lt.t !== "num") expecting("layer_id");
    const width = number("aperture_width");
    const pts: [number, number][] = [];
    let t = next();
    do {
      if (t.t !== "num") expecting("a number");
      const x = parseFloat(t.v); const y = number();
      pts.push([x, y]);
      t = next();
    } while (t.t !== ")" && t.t !== "(");
    if (t.t === "(") { if (next().v !== "aperture_type") expecting("aperture_type"); const a = next().v; if (a !== "round" && a !== "square") expecting("round|square"); needRight(); needRight(); }
    return { kind, layer: lt.v, width, points: pts };
  };
  const doQarc = (): SesQarc => {
    const layer = needSymbol(); const width = number();
    const v: [number, number][] = [];
    for (let i = 0; i < 3; i++) { const x = number(); const y = number(); v.push([x, y]); }
    needRight();
    return { kind: "qarc", layer, width, vertex: [v[0], v[1], v[2]] };
  };
  const doCircle = (): { layer: string; diameter: number } => {
    const layer = needSymbolOrNumber(); const diameter = number();
    let t = next();
    if (t.t === "num") { number(); t = next(); }
    if (t.t !== ")") expecting("')'");
    return { layer, diameter };
  };
  const doWire = (): SesWire => {
    let shape: SesWire["shape"] | null = null; let type = "";
    let t: Tok;
    while ((t = next()).t !== ")") {
      if (t.t !== "(") expecting("'('");
      const k = next().v;
      if (k === "rect") { if (shape) unexpected(); shape = { kind: "rect" }; skipList(); }
      else if (k === "circle") { if (shape) unexpected(); doCircle(); shape = { kind: "circle" }; }
      else if (k === "path" || k === "polyline_path") { if (shape) unexpected(); shape = doPath("path"); }
      else if (k === "polygon" || k === "poly") { if (shape) unexpected(); shape = doPath("polygon"); }
      else if (k === "qarc") { if (shape) unexpected(); shape = doQarc(); }
      else if (k === "net") { needSymbolOrNumber(); needRight(); }
      else if (k === "turret") { number(); needRight(); }
      else if (k === "type") { type = next().v; if (!["fix", "route", "normal", "protect"].includes(type)) expecting("fix|route|normal|protect"); needRight(); }
      else if (k === "attr") { const a = next().v; if (!["test", "fanout", "bus", "jumper"].includes(a)) expecting("test|fanout|bus|jumper"); needRight(); }
      else if (k === "shield") { needSymbol(); needRight(); }
      else if (k === "window" || k === "connect") skipList();
      else if (k === "supply") needRight();
      else unexpected(cur());
    }
    if (!shape) throw new SesError("Session wire has no shape");
    return { shape, type };
  };
  const doWireVia = (): SesVia => {
    const padstack = needSymbol(); const vertexes: [number, number][] = []; let type = "";
    let t = next();
    while (t.t === "num") { const x = parseFloat(t.v); const y = number("vertex.y"); vertexes.push([x, y]); t = next(); }
    while (t.t !== ")") {
      if (t.t !== "(") expecting("'('");
      const k = next().v;
      if (k === "net") { needSymbol(); needRight(); }
      else if (k === "via_number") { number("<via#>"); needRight(); }
      else if (k === "type") { type = next().v; if (!["fix", "route", "normal", "protect"].includes(type)) expecting("fix|route|normal|protect"); needRight(); }
      else if (k === "attr") { const a = next().v; if (!["test", "fanout", "jumper", "virtual_pin"].includes(a)) expecting("test|fanout|jumper|virtual_pin"); if (a === "virtual_pin") needSymbol(); needRight(); }
      else if (k === "contact") { let c = next(); if (!isSymbol(c)) expecting("a symbol"); while (isSymbol(c)) c = next(); if (c.t !== ")") expecting("')'"); }
      else if (k === "supply") needRight();
      else unexpected(cur());
      t = next();
    }
    return { padstack, vertexes, type };
  };
  const doNetOut = (): SesNet => {
    const net: SesNet = { id: needSymbolOrNumber(), wires: [], vias: [] };
    let t: Tok;
    while ((t = next()).t !== ")") {
      if (t.t !== "(") expecting("'('");
      const k = next().v;
      if (k === "unassigned") needRight();
      else if (k === "net_number") { number(); needRight(); }
      else if (k === "rule" || k === "supply_pin") skipList();
      else if (k === "wire") net.wires.push(doWire());
      else if (k === "via") net.vias.push(doWireVia());
      else unexpected(cur());
    }
    return net;
  };
  const doPadstack = (): SesPadstack => {
    const idt = next(); if (!isSymbol(idt) && idt.t !== "num") expecting("m_padstack_id");
    const ps: SesPadstack = { id: idt.v, shapes: [] };
    let t: Tok;
    while ((t = next()).t !== ")") {
      if (t.t !== "(") expecting("'('");
      const k = next().v;
      if (k === "unit") doUnit();
      else if (k === "rotate" || k === "absolute") { const v = next().v; if (v !== "on" && v !== "off") expecting("on|off"); needRight(); }
      else if (k === "shape") {
        // doSHAPE: one shape descriptor, then (connect …) / (window …)
        let shape: { kind: string; layer: string; diameter: number } | null = null; let s: Tok;
        while ((s = next()).t !== ")") {
          if (s.t !== "(") expecting("'('");
          const sk = next().v;
          if (sk === "circle") { const c = doCircle(); shape = { kind: "circle", ...c }; }
          else if (sk === "rect" || sk === "path" || sk === "polygon" || sk === "poly" || sk === "qarc" || sk === "polyline_path") { const layer = next().v; skipList(); shape = { kind: sk === "poly" ? "polygon" : sk === "polyline_path" ? "path" : sk, layer, diameter: 0 }; }
          else if (sk === "connect" || sk === "window") skipList();
          else unexpected(cur());
        }
        if (shape) ps.shapes.push(shape);
      } else if (k === "attach") {
        const v = next().v; if (v !== "off" && v !== "on") expecting("off|on");
        const t2 = next(); if (t2.t === "(") { if (next().v !== "use_via") expecting("use_via"); needSymbol(); needRight(); needRight(); }
      } else if (k === "rule") skipList();
      else unexpected(cur());
    }
    return ps;
  };
  const doRoutes = (): NonNullable<Session["routes"]> => {
    const r: NonNullable<Session["routes"]> = { resolution: null, library: null, nets: [] };
    let t: Tok;
    while ((t = next()).t !== ")") {
      if (t.t !== "(") expecting("'('");
      const kt = next(), k = kt.v;
      if (k === "resolution") { if (r.resolution) unexpected(kt); r.resolution = doResolution(); }
      else if (k === "parser" || k === "structure_out") skipList();
      else if (k === "library_out") {
        if (r.library) unexpected(kt);
        r.library = [];
        let l: Tok;
        while ((l = next()).t !== ")") {
          if (l.t !== "(") expecting("'('");
          const lk = next().v;
          if (lk === "unit") doUnit();
          else if (lk === "padstack") r.library.push(doPadstack());
          else if (lk === "image") skipList();
          else unexpected(cur());
        }
      } else if (k === "network_out") {
        let n: Tok;
        while ((n = next()).t !== ")") {
          if (n.t !== "(") expecting("'('");
          const nk = next();
          // NET_OUT: (net …), or Allegro PCB Router's (Net …)
          if (nk.v !== "net" && nk.v !== "Net") unexpected(nk);
          r.nets.push(doNetOut());
        }
      } else if (k === "test_points") { const x = next(); if (x.t !== ")") unexpected(x); }
      else unexpected(kt);
    }
    return r;
  };

  if (next().t !== "(") expecting("'('");
  if (next().v !== "session") expecting("session");
  const s: Session = { id: "", placementUnits: null, places: null, routes: null };
  // the session id can be several tokens when its path has spaces in it (TopoR)
  const first = next(); if (!isSymbol(first)) expecting("a symbol");
  const parts = [first.v]; let t: Tok;
  while ((t = next()).t !== "(") { if (t.t === "eof") unexpected(t); parts.push(t.v); }
  s.id = parts.join(" ");
  do {
    if (t.t !== "(") expecting("'('");
    const kt = next(), k = kt.v;
    if (k === "base_design") { needSymbol(); needRight(); }
    else if (k === "history" || k === "structure" || k === "was_is") skipList();
    else if (k === "placement") {
      if (s.places) unexpected(kt);
      s.places = [];
      let pt: Tok;
      while ((pt = next()).t !== ")") {
        if (pt.t === "eof") unexpected(pt);
        if (pt.t !== "(") expecting("'('");
        const pk = next().v;
        if (pk === "unit") s.placementUnits = doUnit();
        else if (pk === "resolution") s.placementUnits = doResolution();
        else if (pk === "place_control") skipList();
        else if (pk === "component") {
          const img = next(); if (!isSymbol(img) && img.t !== "num") expecting("image_id");
          let ct: Tok;
          while ((ct = next()).t !== ")") {
            if (ct.t !== "(") expecting("'('");
            if (next().v !== "place") unexpected(cur());
            // doPLACE
            const ref = next(); if (!isSymbol(ref)) expecting("component_id");
            const place: SesPlace = { ref: ref.v, vertex: null, side: "front", rotation: 0 };
            let q = next();
            if (q.t === "num") {
              const x = parseFloat(q.v), y = number(); place.vertex = [x, y];
              const side = next().v; if (side !== "front" && side !== "back") expecting("front|back");
              place.side = side as "front" | "back";
              place.rotation = number("rotation");
              q = next();
            }
            while (q.t !== ")") { if (q.t !== "(") expecting("'('"); next(); skipList(); q = next(); }
            s.places.push(place);
          }
        } else unexpected(cur());
      }
    } else if (k === "routes") { if (s.routes) unexpected(kt); s.routes = doRoutes(); }
    else unexpected(kt);
  } while ((t = next()).t !== ")");
  return s;
}

// ---------------------------------------------------------------- FromSESSION
/** scale(): a distance in the session's units to internal units (nm, KiROUND), returned in mm */
export function scaleOf(distance: number, r: UnitRes): number {
  const factor = r.units === "mil" ? 25.4e3 : r.units === "cm" ? 1e7 : r.units === "mm" ? 1e6 : r.units === "um" ? 1e3 : 25.4e6;
  return Math.round(factor * distance / r.value) / 1e6;
}
const mapPt = (p: [number, number], r: UnitRes): [number, number] => [scaleOf(p[0], r), -scaleOf(p[1], r) || 0];
/** CalcArcMid( start, end, centre ): the point half way round the arc from start to end (the shorter way) */
function arcMid(s: [number, number], e: [number, number], c: [number, number]): [number, number] {
  const r = Math.hypot(s[0] - c[0], s[1] - c[1]);
  const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]), a1 = Math.atan2(e[1] - c[1], e[0] - c[0]);
  let d = a1 - a0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
  const am = a0 + d / 2;
  return [Math.round((c[0] + r * Math.cos(am)) * 1e6) / 1e6, Math.round((c[1] + r * Math.sin(am)) * 1e6) / 1e6];
}

export interface ImportEnv {
  /** the board's copper layers top down and their names (BOARD::GetLayerName): the session's layer ids */
  copper: string[]; layerName(layer: string): string;
  /** the board's nets by name (BOARD::FindNet); the node a new item carries */
  hasNet(name: string): boolean; netNode(name: string): N;
  /** NETCLASS via drill of the Default class, mm (the drill a "Via…:<drill>_um" name means when it equals it) */
  defaultViaDrill: number;
  /** the via drill (micro or not) of the net's effective class, mm: GetDrillValue for a via without its own drill */
  viaDrillFor(net: string, micro: boolean): number;
  newUuid(): string;
  /** FOOTPRINT::Flip about its position, FOOTPRINT::SetOrientation: the file-level footprint operations */
  flip(n: N): void; rotate(n: N, deg: number): void; setPosition(n: N, x: number, y: number): void;
}
export interface ImportPlan { removed: string[]; modified: Map<string, N>; added: N[]; skipped: number }
/** FOOTPRINT::GetReference: the Reference property, or a legacy board's (fp_text reference …) */
function fpRef(it: KItem): string {
  if (it.ref) return it.ref;
  for (const c of it.node as N) if (Array.isArray(c) && ((c[0] === "property" && KiCadCanvas.str(c[1]) === "Reference") || (c[0] === "fp_text" && KiCadCanvas.str(c[1]) === "reference"))) return KiCadCanvas.str(c[2]);
  return "";
}
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** SPECCTRA_DB::FromSESSION over the board's items. */
export function fromSession(items: Iterable<KItem>, s: Session, env: ImportEnv): ImportPlan {
  if (!s.routes) throw new SesError('Session file is missing the "routes" section');
  if (!s.routes.library) throw new SesError('Session file is missing the "library_out" section');
  const plan: ImportPlan = { removed: [], modified: new Map(), added: [], skipped: 0 };
  const all = [...items];
  const locked = (n: N): boolean => n.some((c) => c === "locked" || (Array.isArray(c) && c[0] === "locked" && (c.length < 2 || c[1] === "yes")));
  for (const it of all) if ((it.kind === "segment" || it.kind === "arc" || it.kind === "via") && !locked(it.node)) plan.removed.push(it.id);
  // buildLayerMaps
  const layerIds = env.copper.map((l) => env.layerName(l));
  const findLayer = (id: string): number => layerIds.indexOf(id);
  const n = env.copper.length;

  if (s.places) {
    const res = s.placementUnits || DEFAULT_RES;
    for (const place of s.places) {
      const fp = all.find((it) => it.kind === "footprint" && fpRef(it) === place.ref);
      if (!fp) { plan.skipped++; continue; }
      if (!place.vertex) continue;
      const node = (plan.modified.get(fp.id) || KiCadCanvas.parse(KiCadCanvas.serialize(fp.node))) as N;
      const [x, y] = mapPt(place.vertex, res);
      env.setPosition(node, x, y);
      const side = String(((KiCadCanvas.kid(node, "layer") as N | null) || [])[1] || "F.Cu");
      if (place.side === "front" ? side !== "F.Cu" : side !== "B.Cu") env.flip(node);
      // EDA_ANGLE( rotation ) on the front, rotation + 180 on the back; the file keeps it within ±180
      let target = place.side === "front" ? place.rotation : place.rotation + 180;
      target = ((target % 360) + 360) % 360; if (target > 180) target -= 360;
      const cur = (KiCadCanvas.atOf(node) as [number, number, number])[2] || 0;
      if (Math.abs(target - cur) > 1e-9) env.rotate(node, target - cur);
      plan.modified.set(fp.id, node);
    }
  }

  const res = s.routes.resolution || DEFAULT_RES;
  const lib = s.routes.library;
  for (const net of s.routes.nets) {
    const netName = net.id && env.hasNet(net.id) ? net.id : "";
    for (const wire of net.wires) {
      try {
        const sh = wire.shape;
        if (sh.kind === "path") {
          const li = findLayer(sh.layer); if (li < 0) throw new SesError(`Session file uses invalid layer id '${sh.layer}'.`);
          for (let i = 0; i < sh.points.length - 1; i++) {
            const a = mapPt(sh.points[i], res), b = mapPt(sh.points[i + 1], res);
            // PCB_IO_KICAD_SEXPR: (locked yes) before the layer
            const seg: N = ["segment", ["start", a[0], a[1]], ["end", b[0], b[1]], ["width", scaleOf(sh.width, res)], ...(wire.type === "fix" ? [["locked", "yes"] as N] : []), ["layer", env.copper[li]], env.netNode(netName), ["uuid", env.newUuid()]];
            plan.added.push(seg);
          }
        } else if (sh.kind === "qarc") {
          const li = findLayer(sh.layer); if (li < 0) throw new SesError(`Session file uses invalid layer id '${sh.layer}'.`);
          const a = mapPt(sh.vertex[0], res), b = mapPt(sh.vertex[1], res), c = mapPt(sh.vertex[2], res);
          const m = arcMid(a, b, c);
          const arc: N = ["arc", ["start", a[0], a[1]], ["mid", r6(m[0]), r6(m[1])], ["end", b[0], b[1]], ["width", scaleOf(sh.width, res)], ...(wire.type === "fix" ? [["locked", "yes"] as N] : []), ["layer", env.copper[li]], env.netNode(netName), ["uuid", env.newUuid()]];
          plan.added.push(arc);
        } else if (sh.kind === "polygon") {
          // zone fills from FreeRouter / Specctra: the board keeps its own zones
        } else throw new SesError(`Unsupported wire shape: '${sh.kind}' for net: '${net.id}'`);
      } catch (e) { if (e instanceof SesError) plan.skipped++; else throw e; }
    }
    for (const wv of net.vias) {
      try {
        const ps = lib.find((x) => x.id === wv.padstack);
        if (!ps) throw new SesError(`A wire_via refers to missing padstack '${wv.padstack}'.`);
        for (const v of wv.vertexes) plan.added.push(makeVia(wv, ps, v, netName, res, env, n, findLayer));
      } catch (e) { if (e instanceof SesError) plan.skipped++; else throw e; }
    }
  }
  return plan;
}

/** SPECCTRA_DB::makeVIA */
function makeVia(wv: SesVia, ps: SesPadstack, pt: [number, number], net: string, res: UnitRes, env: ImportEnv, copperCount: number, findLayer: (id: string) => number): N {
  // the drill is in the name when pcbnew wrote the DSN: after the colon, before the last '_' (um)
  let drill: number | null = null;
  const colon = ps.id.indexOf(":");
  if (colon >= 0) {
    const end = ps.id.lastIndexOf("_");
    if (end >= 0) {
      const um = parseFloat(ps.id.slice(colon + 1, end).trim());
      const iu = Math.trunc((isNaN(um) ? 0 : um) * 1000);
      drill = iu === Math.round(env.defaultViaDrill * 1e6) ? null : iu / 1e6;
    }
  }
  const count = ps.shapes.length;
  if (count === 0) throw new SesError("Session via padstack has no shapes");
  const [x, y] = mapPt(pt, res);
  let layers = [env.copper[0], env.copper[copperCount - 1]], type = "";
  let diam: number;
  if (count === 1 || count === copperCount) {
    const sh = ps.shapes[0];
    if (sh.kind !== "circle") throw new SesError(`Unsupported via shape: ${sh.kind}.`);
    diam = scaleOf(sh.diameter, res);
  } else {
    let top = -1, bot = Number.MAX_SAFE_INTEGER; diam = -1;
    for (const sh of ps.shapes) {
      if (sh.kind !== "circle") throw new SesError(`Unsupported via shape: ${sh.kind}`);
      const li = findLayer(sh.layer);
      if (li < 0) throw new SesError(`Session file uses invalid layer id '${sh.layer}'`);
      if (li > top) top = li; if (li < bot) bot = li;
      if (diam === -1) diam = scaleOf(sh.diameter, res);
    }
    if ((top === 0 && bot === 1) || (top === copperCount - 2 && bot === copperCount - 1)) type = "micro";
    else if (top > 0 && bot < copperCount - 1) type = "blind";   // VIATYPE::BURIED: KiCad 10 writes a buried via as blind with its inner pair
    else type = "blind";
    if (top < 0) top = 0;
    // SetLayerPair( top, bottom ): written from the upper copper layer down
    layers = [env.copper[bot], env.copper[top]];
  }
  // PCB_IO_KICAD_SEXPR writes GetDrillValue: the class's drill for a via without one of its own
  const d = drill !== null && drill > 0 ? drill : env.viaDrillFor(net, type === "micro");
  const node: N = ["via"];
  if (type) node.push(type);
  node.push(["at", x, y], ["size", diam], ["drill", r6(d)], ["layers", ...layers]);
  if (wv.type === "fix") node.push(["locked", "yes"]);
  node.push(env.netNode(net), ["uuid", env.newUuid()]);
  return node;
}
