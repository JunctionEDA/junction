// apidoc.ts — the Feature API's type file (assets/feature-api.d.ts) read into an index: every interface and
// global with its members, each with its signature and the comment above it.  The editor's completion and
// hover are drawn from this, so they say exactly what the type file says.  Pure.

export interface ApiMember { name: string; signature: string; doc: string; owner: string; kind: "method" | "property" }
export interface ApiIndex {
  /** interfaces and `declare const` objects by name */
  types: { [name: string]: ApiMember[] };
  /** what a script sees at the top level: feature, Geo2, V3, console */
  globals: ApiMember[];
  /** every member name → where it is */
  byName: { [name: string]: ApiMember[] };
}

/** What a name before a dot is, when the name says it: `ctx.` is the Context, `face.` a Face. */
const RECEIVERS: { [name: string]: string } = { ctx: "Context", Geo2: "Geo2", V3: "V3", console: "console", face: "Face", f: "Face", body: "Body", b: "Body", edge: "Edge", e: "Edge", plate: "Body", part: "Body" };
export const receiverType = (name: string): string | null => RECEIVERS[name] || null;

const cleanDoc = (lines: string[]): string => lines.map((l) => l.replace(/^\s*\/\*\*\s?|^\s*\*\/\s*$|^\s*\*\s?|\s*\*\/\s*$/g, "")).join("\n").trim();

export function parseApi(dts: string): ApiIndex {
  const types: ApiIndex["types"] = {}, globals: ApiMember[] = [], byName: ApiIndex["byName"] = {};
  const lines = dts.split("\n");
  let current: string | null = null, doc: string[] = [], inDoc = false;
  const add = (owner: string | null, name: string, signature: string, kind: ApiMember["kind"]) => {
    const m: ApiMember = { name, signature: signature.trim().replace(/;$/, ""), doc: cleanDoc(doc), owner: owner || "", kind };
    if (owner) (types[owner] = types[owner] || []).push(m); else globals.push(m);
    (byName[name] = byName[name] || []).push(m);
  };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const t = line.trim();
    if (inDoc) { doc.push(line); if (t.includes("*/")) inDoc = false; continue; }
    if (t.startsWith("/**")) { doc = [line]; inDoc = !t.includes("*/"); continue; }
    if (!t || t.startsWith("//")) { if (!t) doc = []; continue; }
    let m: RegExpExecArray | null;
    if (!current) {
      // (an interface written on one line has no members of its own to list)
      if ((m = /^interface (\w+)/.exec(t))) { types[m[1]] = types[m[1]] || []; if (!/\}$/.test(t)) current = m[1]; doc = []; continue; }
      if ((m = /^declare const (\w+): \{$/.exec(t))) { current = m[1]; types[current] = []; add(null, m[1], `const ${m[1]}`, "property"); doc = []; continue; }
      if ((m = /^declare function (\w+)(\(.*)$/.exec(t))) { add(null, m[1], `${m[1]}${m[2]}`, "method"); doc = []; continue; }
      if ((m = /^declare const (\w+): (.*)$/.exec(t))) { add(null, m[1], `${m[1]}: ${m[2]}`, "property"); doc = []; continue; }
      doc = [];
      continue;
    }
    if (/^\};?$/.test(t)) { current = null; doc = []; continue; }
    // members sit two spaces in; deeper lines belong to a member's own type
    if (!/^ {2}\S/.test(line)) continue;
    if ((m = /^(?:readonly )?(\w+)\??(\(.*)$/.exec(t))) add(current, m[1], `${m[1]}${m[2]}`, "method");
    else if ((m = /^(?:readonly )?(\w+)\??: (.*)$/.exec(t))) add(current, m[1], `${m[1]}: ${m[2]}`, "property");
    doc = [];
  }
  return { types, globals, byName };
}

/** The parameter types and the names of the icons, for completion inside a declaration. */
export function unionValues(dts: string, typeName: string): string[] {
  const m = new RegExp(`type ${typeName} = ([^;]+);`).exec(dts);
  return m ? Array.from(m[1].matchAll(/"([^"]+)"/g), (x) => x[1]) : [];
}
