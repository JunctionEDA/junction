// pcbdialogs/import-netlist-logic.ts — File > Import > Netlist...'s reading of the netlist file (NETLIST_READER::
// GetNetlistReader / GuessNetlistFileType, KICAD_NETLIST_PARSER and LEGACY_NETLIST_READER, pcbnew/netlist_reader/) into
// the NETLIST that BOARD_NETLIST_UPDATER takes (canvas/pcb-netlist.ts's Netlist, which planUpdate reads).  Plain
// functions over the file's text, so the node tests can run them; pcbdialogs/import-netlist.ts is the dialog.
import type { Netlist, NetComponent, NetVariant } from "../../canvas/pcb-netlist";
import { deriveGroupUuid, kiidFromName, kiidPath } from "../../canvas/kiid";

type N = SNode;
const K = (): KiCadCanvasApi => (globalThis as unknown as { KiCadCanvas: KiCadCanvasApi }).KiCadCanvas;
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const isList = (v: unknown): v is N => Array.isArray(v);

/** NETLIST_READER::NETLIST_FILE_T */
export type NetlistFileType = "LEGACY" | "KICAD" | "ORCAD" | "UNKNOWN";
/** GuessNetlistFileType: the first line that names a format. */
export function guessNetlistFileType(text: string): NetlistFileType {
  for (const line of text.split(/\r?\n/)) {
    if (/#[ \t]+EESchema[ \t]+Netlist[ \t]+/i.test(line)) return "LEGACY";
    if (/[ ]*\(export(\s+\(version)?/.test(line)) return "KICAD";
    if (/[ ]*\([ \t]+{+/i.test(line)) return "ORCAD";
  }
  return "UNKNOWN";
}

export { kiidPath, kiidFromName, deriveGroupUuid };

// ---------------------------------------------------------------- KICAD_NETLIST_PARSER
const kidText = (n: N, key: string): string => { const k = K().kid(n, key); return k ? str(k[1]) : ""; };
/** The text children of a node (its non-list values after the key). */
const texts = (n: N): string[] => n.slice(1).filter((x) => !isList(x)).map(str);

/** The variant property value as parseComponent reads it (propBool). */
function propBool(v: string | null): boolean {
  if (v === null) return true;
  const l = v.toLowerCase();
  if (l === "0" || l === "false") return false;
  if (l === "1" || l === "true") return true;
  return v !== "";
}

/** KICAD_NETLIST_PARSER::Parse into a NETLIST (components in file order, their nets, groups applied). */
export function parseKicadNetlist(text: string): Netlist {
  const tree = K().parse(text);
  if (!tree || tree[0] !== "export") throw new Error("Expecting 'export'");
  const components: NetComponent[] = [];
  const byRef = new Map<string, NetComponent>();
  const props = new Map<NetComponent, Map<string, string>>();
  const nets = new Map<string, { ref: string; pin: string }[]>();
  const groups: { name: string; uuid: string; members: string[] }[] = [];
  for (const sec of tree.slice(1)) {
    if (!isList(sec)) continue;
    const head = str(sec[0]);
    if (head === "components") for (const c of K().kids(sec, "comp")) {
      const comp = parseComponent(c, props);
      components.push(comp);
      if (!byRef.has(comp.ref)) byRef.set(comp.ref, comp);
    } else if (head === "groups") for (const g of K().kids(sec, "group")) {
      const members = K().kids(K().kid(g, "members") || ["members"], "member").map((m) => kidText(m, "uuid"));
      groups.push({ name: kidText(g, "name"), uuid: kidText(g, "uuid"), members });
    } else if (head === "nets") for (const n of K().kids(sec, "net")) {
      const code = kidText(n, "code");
      let name = kidText(n, "name");
      for (const node of K().kids(n, "node")) {
        const comp = byRef.get(kidText(node, "ref")); if (!comp) continue;
        if ((parseInt(code, 10) || 0) < 1) continue;
        if (!name) name = "N-00000" + code;    // a dummy net name like N-000009
        const pin = kidText(node, "pin");
        // COMPONENT::AddNet; GetNet finds the first net of a pin
        if (!comp.pins.has(pin)) comp.pins.set(pin, { net: name, name: kidText(node, "pinfunction"), type: kidText(node, "pintype") });
        const list = nets.get(name) || []; list.push({ ref: comp.ref, pin }); nets.set(name, list);
      }
    }
  }
  // NETLIST::ApplyGroupMembership: an instance path names one instance, a bare uuid any unit of a symbol
  for (const g of groups) {
    const group = { uuid: deriveGroupUuid(g.uuid), name: g.name };
    for (const member of g.members) {
      const p = kiidPath(member);
      let comp: NetComponent | undefined;
      if (p.length > 1) { const want = "/" + p.join("/"); comp = components.find((c) => c.paths.some((x) => x.toLowerCase() === want)); }
      else if (p.length === 1) comp = components.find((c) => c.paths.some((x) => x.toLowerCase().split("/").pop() === p[0]));
      if (comp) comp.group = group;
    }
  }
  return { components, nets, warnings: [] };
}

function parseComponent(c: N, propsOf: Map<NetComponent, Map<string, string>>): NetComponent {
  const properties = new Map<string, string>();
  const fields: Record<string, string> = {};
  let sheetPath: string[] = [], human = "", uuids: string[] = [], library = "", part = "";
  let dup = false; const jumperGroups: string[][] = []; const units: { name: string; pins: string[] }[] = []; const variants: NetVariant[] = [];
  for (const k of c.slice(1)) {
    if (!isList(k)) continue;
    switch (str(k[0])) {
      case "libsource": library = kidText(k, "lib"); part = kidText(k, "part"); break;
      case "property": { const name = kidText(k, "name"); if (name) properties.set(name, kidText(k, "value")); break; }
      case "fields": for (const f of K().kids(k, "field")) { const name = kidText(f, "name"); if (name) fields[name] = texts(f)[0] || ""; } break;
      case "sheetpath": human = kidText(k, "names"); sheetPath = kiidPath(kidText(k, "tstamps")); break;
      case "tstamps": uuids = texts(k).map((u) => u.trim().toLowerCase()).filter((u) => u); break;
      case "units": for (const u of K().kids(k, "unit")) units.push({ name: kidText(u, "name"), pins: K().kids(K().kid(u, "pins") || ["pins"], "pin").map((p) => kidText(p, "num")).filter((x) => x) }); break;
      case "duplicate_pin_numbers_are_jumpers": dup = str(k[1]) === "1"; break;
      case "jumper_pin_groups": for (const g of K().kids(k, "group")) { const pins = Array.from(new Set(K().kids(g, "pin").map((p) => str(p[1])))).sort(); if (pins.length > 1) jumperGroups.push(pins); } break;
      case "variants": for (const v of K().kids(k, "variant")) {
        const nv: NetVariant = { name: kidText(v, "name"), fields: new Map() };
        for (const p of K().kids(v, "property")) {
          const name = kidText(p, "name"); if (!name) continue;
          const vk = K().kid(p, "value"), b = propBool(vk ? str(vk[1]) : null), l = name.toLowerCase();
          if (l === "dnp") nv.dnp = b; else if (l === "exclude_from_bom") nv.excludedFromBOM = b; else if (l === "exclude_from_sim") nv.excludedFromSim = b; else if (l === "exclude_from_pos_files") nv.excludedFromPosFiles = b;
        }
        for (const f of K().kids(K().kid(v, "fields") || ["fields"], "field")) { const name = kidText(f, "name"); if (!name) continue; const vk = K().kid(f, "value"); nv.fields.set(name, vk ? str(vk[1]) : texts(f)[0] || ""); }
        if (nv.name) variants.push(nv);
      } break;
      default: break;
    }
  }
  const footprint = kidText(c, "footprint");
  if (footprint && /[\t\n\r"<>\\]/.test(footprint)) throw new Error("Invalid footprint ID in\nfile: ''\nline: 0\noffset: 0");
  const own: Record<string, string> = {};
  for (const [name, v] of Object.entries(fields)) if (name !== "Reference" && name !== "Value" && name !== "Footprint") own[name] = v;
  const base = sheetPath.map((u) => "/" + u).join("");
  const comp: NetComponent = {
    ref: kidText(c, "ref"), value: kidText(c, "value"), footprint, libId: library || part ? `${library}:${part}` : "",
    paths: uuids.map((u) => `${base}/${u}`), fields: own,
    sheetName: human || properties.get("Sheetname") || "", sheetFile: properties.get("Sheetfile") || "",
    dnp: properties.has("dnp"), excludeFromBom: properties.has("exclude_from_bom"), excludeFromBoard: properties.has("exclude_from_board"),
    excludeFromSim: properties.has("exclude_from_sim"), excludeFromPosFiles: properties.has("exclude_from_pos_files"), pins: new Map(),
  };
  if (properties.has("ki_fp_filters")) comp.fpFilters = properties.get("ki_fp_filters");
  if (dup) comp.dupPinsAreJumpers = true;
  if (jumperGroups.length) comp.jumperPinGroups = jumperGroups;
  if (units.length) comp.unitInfo = units;
  if (variants.length) comp.variants = variants;
  propsOf.set(comp, properties);
  return comp;
}

// ---------------------------------------------------------------- LEGACY_NETLIST_READER
/** LEGACY_NETLIST_READER::LoadNetlist: "( /path fp ref value {Lib=name}" component lines and "( pin net )" pad lines. */
export function parseLegacyNetlist(text: string): Netlist {
  const components: NetComponent[] = [];
  const nets = new Map<string, { ref: string; pin: string }[]>();
  let state = 0, comment = false, comp: NetComponent | null = null;
  const lines = text.split(/\r?\n/);
  const tok = (s: string): string[] => s.split(/[ ()\t\n]+/).filter((x) => x);
  for (let i = 0; i < lines.length; i++) {
    let line: string | null = lines[i].trim();
    if (comment) { const at = line.indexOf("}"); if (at < 0) continue; line = line.slice(at); comment = false; }
    if (line[0] === "{") {
      comment = true;
      if (state === 0 && /^\{ Allowed footprints/i.test(line)) {
        // loadFootprintFilters
        let cur: NetComponent | null = null; const filters: string[] = [];
        for (i++; i < lines.length; i++) {
          const l = lines[i];
          if (/^\$endlist/i.test(l)) { if (cur) cur.fpFilters = filters.join(" "); cur = null; filters.length = 0; continue; }
          if (/^\$end/i.test(l)) break;
          if (/^\$component/i.test(l)) {
            const ref = l.slice(11).trim();
            cur = components.find((c) => c.ref === ref) || null;
            if (!cur) throw new Error(`Cannot find symbol ${ref} in footprint filter section of netlist.`);
          } else filters.push(l.slice(1).trim());
        }
        continue;
      }
      const at = line.indexOf("}"); if (at < 0) continue;
      line = line.slice(at); comment = false;
    }
    if (line[0] === "(") state++;
    if (line[0] === ")") state--;
    if (state === 2) {
      const t = tok(line);
      if (t.length < 1) throw new Error("Cannot parse time stamp in symbol section of netlist.");
      if (t.length < 2) throw new Error("Cannot parse footprint name in symbol section of netlist.");
      if (t.length < 3) throw new Error("Cannot parse reference designator in symbol section of netlist.");
      if (t.length < 4) throw new Error("Cannot parse value in symbol section of netlist.");
      const fp = t[1] === "$noname" ? "" : t[1];
      const path = kiidPath(t[0]).map((u) => "/" + u).join("");
      comp = { ref: t[2], value: t[3], footprint: fp, libId: "", paths: path ? [path] : [], fields: {}, sheetName: "", sheetFile: "", dnp: false, excludeFromBom: false, excludeFromBoard: false, pins: new Map() };
      components.push(comp);
      continue;
    }
    if (state >= 3) {
      if (!comp) throw new Error("Cannot parse pin name in symbol net section of netlist.");
      const t = tok(line);
      if (t.length < 1) throw new Error("Cannot parse pin name in symbol net section of netlist.");
      if (t.length < 2) throw new Error("Cannot parse net name in symbol net section of netlist.");
      const net = t[1][0] === "?" ? "" : t[1];
      if (!comp.pins.has(t[0])) comp.pins.set(t[0], { net, name: "", type: "" });
      if (net) { const list = nets.get(net) || []; list.push({ ref: comp.ref, pin: t[0] }); nets.set(net, list); }
      state--;
    }
  }
  return { components, nets, warnings: [] };
}

/** NETLIST_READER::GetNetlistReader + LoadNetlist: the netlist of a file, or the reason it cannot be read. */
export function readNetlistFile(text: string, fileName: string): { netlist: Netlist } | { error: string } {
  const type = guessNetlistFileType(text);
  try {
    if (type === "KICAD") return { netlist: parseKicadNetlist(text) };
    if (type === "LEGACY") return { netlist: parseLegacyNetlist(text) };
  } catch (e) { return { error: `Error loading netlist.\n${String((e as Error).message || e)}` }; }
  return { error: `Cannot open netlist file '${fileName}'.` };
}
