// model.ts — a part studio as an AI assistant reads and edits it: the feature types and their parameters taken
// from the feature registry, the feature tree as JSON, and a list of edits turned into the item changes that make
// them (document/edits.ts), validated against the registry first.
//
// Pure: no kernel, no network.  mcp/host.ts opens the document, commits what this plans and asks the kernel
// what the result is; the node tests (static/tests/cad-mcp.test.js, cad-mcp-tools.test.js) drive this file
// directly.  The catalogue is catalog.ts, the sketch shapes and constraints sketch.ts, picking geometry by
// description select.ts.
import { applyChanges, invertChange, newId, type ItemChange, type ItemDoc, type Json, type JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { FeatureDefinition } from "../core/feature";
import { isGeomRef } from "../core/geometry";
import { profileFaces } from "../features/_profile";
import { isColor, setBodyLook } from "../document/appearance-items";
import * as edits from "../document/edits";
import { featuresOf, nextName, orderAt, rollbackIndex, studioOf, type FeatureItem } from "../document/format";
import { assignMaterial, materialOf, materialsOf } from "../document/mass-materials";
import { partNamesOf, updatePart } from "../document/part-items";
import { EXPR_KEY, addVariable, deleteVariable, evaluate, isPlainNumber, lookupOf, nameProblem, setVariable, usersOf, variableValues, variablesOf } from "../document/variables";
import type { BodyMesh, FeatureReport } from "../kernel/protocol";
import { emptySketch, type SketchConstraint, type SketchData, type SketchEntity } from "../sketch/format";
import type { SketchSolver } from "../sketch/solver/solve";
import { NAMES_NOTE, UNITS_NOTE, fieldDoc, similarTypes, typeDoc } from "./catalog";
import { PickError, pickGeometry, type GeoKind } from "./select";
import { EXTRA_SHAPES, SHAPE_TYPES, defineShapes, extraShape, sketchReport, userConstraints, type ShapeIds, type SketchReport } from "./sketch";

type Defs = readonly FeatureDefinition[];
const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ---------------------------------------------------------------- the feature types

/** Every registered feature type in full (the catalogue with `detail: "full"`); catalog.ts answers in steps. */
export function featureTypes(defs: Defs): Json {
  return { feature_types: defs.map(typeDoc), units: UNITS_NOTE, names: NAMES_NOTE };
}

// ---------------------------------------------------------------- reading the tree

function sketchSummary(data: SketchData | undefined): JsonObject {
  const count: { [k: string]: number } = {};
  for (const e of Object.values((data && data.entities) || {})) count[e.type] = (count[e.type] || 0) + 1;
  const out: JsonObject = { points: count.point || 0, lines: count.line || 0, circles: count.circle || 0, arcs: count.arc || 0 };
  const other = Object.keys(count).filter((k) => !["point", "line", "circle", "arc"].includes(k)).reduce((n, k) => n + count[k], 0);
  if (other) out.other_curves = other;
  const constraints = Object.keys((data && data.constraints) || {}).length;
  if (constraints) out.constraints = constraints;
  return out;
}

export interface TreeOptions {
  /** every sketch's points and curves in full instead of a count */
  entities?: boolean;
  /** leave the parameters out: index, id, name, type and status only */
  compact?: boolean;
  /** only this feature (its id), in full */
  only?: string;
  offset?: number; limit?: number;
}

/** The variables of a part studio with their values. */
export function variablesJson(doc: ItemDoc): JsonObject[] {
  const vars = variablesOf(doc), vv = variableValues(vars);
  return vars.map((v) => {
    const o: JsonObject = { name: v.name, expr: v.expr };
    if (vv.values.has(v.name) && !vv.errors.has(v.id)) o.value = vv.values.get(v.name) as number; else o.error = vv.errors.get(v.id) || "It has no value.";
    const users = usersOf(doc, v.name).length;
    if (users) o.used_by = users;
    return o;
  });
}

/** The feature tree as an assistant reads it.  `reports` are the kernel's, when the model was rebuilt. */
export function treeOf(doc: ItemDoc, reports: readonly FeatureReport[] | null, o: TreeOptions = {}): JsonObject {
  const features = featuresOf(doc), rollback = rollbackIndex(doc, features);
  const by = new Map((reports || []).map((r) => [r.id, r]));
  const rows = features.map((f, i) => {
    const r = by.get(f.id);
    const out: JsonObject = { index: i, id: f.id, name: f.name, type: f.featureType };
    if (f.suppressed) out.suppressed = true;
    if (r) { out.status = r.status; if (r.message) out.message = r.message; } else if (i >= rollback) out.status = "rolled-back";
    if (o.compact && o.only !== f.id) return out;
    if (f.featureType === "sketch" && !o.entities && o.only !== f.id) {
      const { sketch, ...rest } = f.params as { sketch?: SketchData };
      out.params = { ...rest, sketch: sketchSummary(sketch) };
    } else out.params = f.params;
    return out;
  });
  let list = o.only ? rows.filter((r) => r.id === o.only) : rows;
  const total = list.length;
  const offset = Math.max(0, Math.round(o.offset || 0));
  if (o.offset || o.limit) list = list.slice(offset, offset + Math.max(1, Math.round(o.limit || total)));
  const out: JsonObject = {
    units: studioOf(doc).units,
    rollback_before: rollback < features.length ? features[rollback].name : null,
    features: list,
  };
  if (!o.only && list.length < total) { out.feature_count = total; if (offset + list.length < total) out.next_offset = offset + list.length; }
  const vars = variablesJson(doc);
  if (vars.length) out.variables = vars;
  return out;
}

// ---------------------------------------------------------------- sketch shapes

/** Entities for the shapes an assistant gives, with short ids in sequence (p1, l1, c1): they appear in face names. */
export function shapesToEntities(shapes: unknown, into: { [id: string]: SketchEntity } = {}): { entities: { [id: string]: SketchEntity }; problems: string[]; shapes: ShapeIds[] } {
  const out: { [id: string]: SketchEntity } = {}, problems: string[] = [], made: ShapeIds[] = [];
  const counters: { [prefix: string]: number } = {};
  const id = (prefix: string): string => { for (;;) { const n = (counters[prefix] = (counters[prefix] || 0) + 1); const i = prefix + n; if (!(i in into) && !(i in out)) return i; } };
  const point = (x: number, y: number): string => { const i = id("p"); out[i] = { type: "point", x, y }; return i; };
  if (!Array.isArray(shapes)) return { entities: out, problems: ["shapes must be a list"], shapes: made };
  shapes.forEach((s, n) => {
    const where = `shape ${n + 1}`;
    if (!isObject(s) || typeof s.type !== "string") { problems.push(`${where} needs a type`); return; }
    const before = new Set(Object.keys(out));
    if (s.type === "rectangle") {
      if (![s.x1, s.y1, s.x2, s.y2].every(num)) { problems.push(`${where}: a rectangle needs x1, y1, x2, y2`); return; }
      const [x1, y1, x2, y2] = [s.x1, s.y1, s.x2, s.y2] as number[];
      if (x1 === x2 || y1 === y2) { problems.push(`${where}: the rectangle has no area`); return; }
      const pts = [point(x1, y1), point(x2, y1), point(x2, y2), point(x1, y2)];
      for (let i = 0; i < 4; i++) out[id("l")] = { type: "line", a: pts[i], b: pts[(i + 1) % 4] };
    } else if (s.type === "circle") {
      if (![s.cx, s.cy, s.r].every(num) || !((s.r as number) > 0)) { problems.push(`${where}: a circle needs cx, cy and a radius r above zero`); return; }
      out[id("c")] = { type: "circle", center: point(s.cx as number, s.cy as number), r: s.r as number };
    } else if (s.type === "polygon") {
      const pts = s.points;
      if (!Array.isArray(pts) || pts.length < 3 || !pts.every((p) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]))) { problems.push(`${where}: a polygon needs points: [[x, y], ...] with at least three`); return; }
      const ids = (pts as number[][]).map((p) => point(p[0], p[1]));
      for (let i = 0; i < ids.length; i++) out[id("l")] = { type: "line", a: ids[i], b: ids[(i + 1) % ids.length] };
    } else if (s.type === "line") {
      if (![s.x1, s.y1, s.x2, s.y2].every(num)) { problems.push(`${where}: a line needs x1, y1, x2, y2`); return; }
      out[id("l")] = { type: "line", a: point(s.x1 as number, s.y1 as number), b: point(s.x2 as number, s.y2 as number) };
    } else if (s.type === "ellipse") {
      if (![s.cx, s.cy, s.rx, s.ry].every(num) || !((s.rx as number) > 0) || !((s.ry as number) > 0)) { problems.push(`${where}: an ellipse needs cx, cy and radii rx, ry above zero (angle: degrees, optional)`); return; }
      const big = Math.max(s.rx as number, s.ry as number), small = Math.min(s.rx as number, s.ry as number);
      const t = ((num(s.angle) ? (s.angle as number) : 0) * Math.PI) / 180 + ((s.ry as number) > (s.rx as number) ? Math.PI / 2 : 0);
      const cx = s.cx as number, cy = s.cy as number;
      out[id("e")] = { type: "ellipse", center: point(cx, cy), major: point(cx + big * Math.cos(t), cy + big * Math.sin(t)), minor: small };
    } else if (s.type === "regular_polygon") {
      const sides = Math.round(Number(s.sides));
      if (![s.cx, s.cy, s.r].every(num) || !((s.r as number) > 0) || !(sides >= 3 && sides <= 64)) { problems.push(`${where}: a regular_polygon needs cx, cy, r above zero and sides from 3 to 64 (circumscribed: true puts its sides on the circle)`); return; }
      const R = s.circumscribed ? (s.r as number) / Math.cos(Math.PI / sides) : (s.r as number), a0 = s.circumscribed ? Math.PI / sides : 0;
      const ids: string[] = [];
      for (let i = 0; i < sides; i++) ids.push(point((s.cx as number) + R * Math.cos(a0 + (2 * Math.PI * i) / sides), (s.cy as number) + R * Math.sin(a0 + (2 * Math.PI * i) / sides)));
      for (let i = 0; i < sides; i++) out[id("l")] = { type: "line", a: ids[i], b: ids[(i + 1) % sides] };
    } else if (s.type === "spline" || s.type === "bezier") {
      const pts = s.points, min = s.type === "bezier" ? 3 : 2;
      if (!Array.isArray(pts) || pts.length < min || !pts.every((p) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]))) { problems.push(`${where}: a ${s.type} needs points: [[x, y], ...] with at least ${min}`); return; }
      const ids = (pts as number[][]).map((p) => point(p[0], p[1]));
      if (s.type === "spline") out[id("s")] = s.closed && ids.length >= 3 ? { type: "spline", points: ids, closed: true } : { type: "spline", points: ids };
      else out[id("z")] = { type: "bspline", poles: ids, degree: ids.length - 1 };
    } else if (s.type === "text") {
      if (![s.x, s.y, s.height].every(num) || !((s.height as number) > 0) || typeof s.text !== "string" || !s.text.trim()) { problems.push(`${where}: text needs x, y (the start of its baseline), height (of a capital, mm) and text`); return; }
      out[id("t")] = { type: "text", a: point(s.x as number, s.y as number), b: point(s.x as number, (s.y as number) + (s.height as number)), text: s.text, ...(s.bold ? { bold: true } : {}), ...(s.italic ? { italic: true } : {}) };
    } else if (!extraShape(s, where, id, out, problems)) { problems.push(`${where}: unknown shape type "${s.type}" (${SHAPE_TYPES.join(", ")})`); return; }
    const added = Object.keys(out).filter((k) => !before.has(k));
    if (!added.length) return;
    // construction geometry is drawn and can be constrained to, but encloses no region
    if (s.construction === true) for (const k of added) if (out[k].type !== "point") out[k] = { ...out[k], construction: true } as SketchEntity;
    made.push({ shape: n + 1, type: s.type, points: added.filter((k) => out[k].type === "point"), curves: added.filter((k) => out[k].type !== "point") });
  });
  return { entities: out, problems, shapes: made };
}

function checkEntities(entities: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(entities)) return ["sketch.entities must be a map of id to entity"];
  const isPoint = (id: unknown) => typeof id === "string" && isObject(entities[id]) && (entities[id] as JsonObject).type === "point";
  for (const [id, e] of Object.entries(entities)) {
    if (e === null) continue;
    if (!isObject(e)) { problems.push(`entity ${id} is not an object`); continue; }
    if (e.type === "point") { if (!num(e.x) || !num(e.y)) problems.push(`point ${id} needs numbers x and y`); }
    else if (e.type === "line") { if (!isPoint(e.a) || !isPoint(e.b)) problems.push(`line ${id}: a and b must be ids of points in the sketch`); }
    else if (e.type === "circle") { if (!isPoint(e.center) || !num(e.r) || !(e.r > 0)) problems.push(`circle ${id}: center must be a point id and r above zero`); }
    else if (e.type === "arc") { if (!isPoint(e.center) || !isPoint(e.start) || !isPoint(e.end)) problems.push(`arc ${id}: center, start and end must be point ids`); }
    else if (e.type === "ellipse" || e.type === "ellipticalArc") { if (!isPoint(e.center) || !isPoint(e.major) || !num(e.minor) || !(e.minor > 0) || (e.type === "ellipticalArc" && (!isPoint(e.start) || !isPoint(e.end)))) problems.push(`${e.type} ${id}: center and major must be point ids${e.type === "ellipticalArc" ? ", start and end too" : ""}, and minor above zero`); }
    else if (e.type === "spline") { if (!Array.isArray(e.points) || e.points.length < 2 || !e.points.every(isPoint)) problems.push(`spline ${id}: points must be a list of two or more point ids`); }
    else if (e.type === "bspline") { if (!Array.isArray(e.poles) || e.poles.length < 2 || !e.poles.every(isPoint)) problems.push(`bspline ${id}: poles must be a list of two or more point ids`); }
    else if (e.type === "conic") { if (!isPoint(e.start) || !isPoint(e.apex) || !isPoint(e.end) || !num(e.rho) || !(e.rho > 0 && e.rho < 1)) problems.push(`conic ${id}: start, apex and end must be point ids and rho between 0 and 1`); }
    else if (e.type === "text") { if (!isPoint(e.a) || !isPoint(e.b) || typeof e.text !== "string") problems.push(`text ${id}: a and b must be point ids (the baseline start, and a capital's height above it) and text a string`); }
  }
  return problems;
}

// ---------------------------------------------------------------- planning edits

export interface Plan {
  /** the item changes that make the edits, in order; empty when there is a problem */
  changes: ItemChange[];
  /** what undoes them, to be applied in this order */
  inverse: ItemChange[];
  /** one sentence per edit */
  done: string[];
  /** why nothing can be applied; empty when all is well */
  problems: string[];
  /** the document as it will be */
  after: ItemDoc;
  /** how each sketch that was drawn or changed stands (regions, freedoms), by the sketch's name */
  sketches: { [name: string]: SketchReport & { shapes?: string[] } };
  /** the features the edits added or changed, by id */
  touched: string[];
}

/** A body as the edits may name it: by id, by its part name, or by the feature that made it. */
export interface KnownBody { id: string; name: string; createdBy: string; mesh?: BodyMesh }

export interface PlanOptions {
  /** `$ref` names of features added by edits planned before these (a batch planned in stages) */
  refs?: Map<string, string>;
  /** how many edits came before these, for the numbering of problems */
  offset?: number;
  /** the sketch solver, when it is running: constraints are checked and freedoms counted */
  solver?: SketchSolver | null;
  /** the bodies of the model as built, so that parts can be named and bodies given by name */
  bodies?: readonly KnownBody[];
}

const copyDoc = (doc: ItemDoc): ItemDoc => ({ ...doc, head: { ...doc.head }, items: new Map(doc.items) });

function validate(def: FeatureDefinition, params: JsonObject, features: FeatureItem[], selfIndex: number): string[] {
  const problems: string[] = [];
  for (const f of def.schema) {
    const v = params[f.key];
    if (v === undefined || v === null) continue;
    if (f.kind === "number") {
      if (!num(v)) problems.push(`${f.key} must be a number`);
      else if (f.min !== undefined && v < f.min) problems.push(`${f.key} must be at least ${f.min}`);
      else if (f.max !== undefined && v > f.max) problems.push(`${f.key} must be at most ${f.max}`);
    } else if (f.kind === "boolean") { if (typeof v !== "boolean") problems.push(`${f.key} must be true or false`); }
    else if (f.kind === "text") { if (typeof v !== "string") problems.push(`${f.key} must be a string`); }
    else if (f.kind === "enum") { if (!f.options.some((o) => o.value === v)) problems.push(`${f.key} must be one of ${f.options.map((o) => o.value).join(", ")}`); }
    else if (f.kind === "profile") {
      const id = isObject(v) ? v.sketch : null;
      const at = features.findIndex((x) => x.id === id);
      // a field that takes faces may hold faces alone (sketch: null), or faces beside a sketch
      const given = isObject(v) && v.faces !== undefined && v.faces !== null;
      const faces = isObject(v) && Array.isArray(v.faces) ? v.faces : [];
      if (given && !f.faces) problems.push(`${f.key}.faces: this feature takes a sketch only`);
      else if (given && !(Array.isArray((v as JsonObject).faces) && faces.length === profileFaces(v).length)) problems.push(`${f.key}.faces must be a list of { kind: "face", body, name }`);
      const facesOnly = !!f.faces && faces.length > 0 && (id === null || id === undefined);
      if (facesOnly) { /* nothing more to check: the kernel says when a face is gone or not flat */ }
      else if (at < 0 || features[at].featureType !== "sketch") problems.push(`${f.key}.sketch must be the id of a sketch feature` + (f.faces ? `, or give flat faces of a body instead: { sketch: null, faces: [{ kind: "face", body, name }] }` : ""));
      else if (selfIndex >= 0 && at >= selfIndex) problems.push(`${f.key}: the sketch "${features[at].name}" comes after this feature in the tree; a feature can only use what is above it`);
      if (isObject(v) && v.regions !== null && v.regions !== undefined && !(Array.isArray(v.regions) && v.regions.every((r) => typeof r === "string"))) problems.push(`${f.key}.regions must be null or a list of region ids`);
    } else if (f.kind === "plane") {
      const ok = isObject(v) && ((v.kind === "plane" && ["top", "front", "right"].includes(v.plane as string)) || (v.kind === "face" && isObject(v.ref) && typeof v.ref.name === "string") || (v.kind === "datum" && typeof v.feature === "string"));
      if (!ok) problems.push(`${f.key} must be "top", "front", "right", a face ({ kind: "face", body, name } or a pick), or { kind: "datum", feature: <a plane feature> }`);
    } else if (f.kind === "refs") {
      const list = f.single ? [v] : v;
      // besides faces, edges and vertices, a field may take a default plane, reference geometry or a sketch curve
      const ok = (r: unknown) => isObject(r) && ((typeof r.name === "string" && f.of.includes(r.kind as never))
        || (!!f.planes && r.kind === "plane" && ["top", "front", "right"].includes(r.plane as string))
        || (!!f.datums && f.datums.length > 0 && r.kind === "datum" && typeof r.feature === "string")
        || (!!f.sketch && r.kind === "sketch" && typeof r.feature === "string" && typeof r.entity === "string"));
      if (!Array.isArray(list) || !list.every(ok)) problems.push(`${f.key} must be ${f.single ? "a reference" : "a list of references"}: ${fieldDoc(f).stores}`);
    } else if (f.kind === "bodies") { if (!Array.isArray(v) || !v.every((b) => typeof b === "string")) problems.push(`${f.key} must be a list of body ids`); }
    else if (f.kind === "features") {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) problems.push(`${f.key} must be a list of feature ids or names`);
      else for (const id of v as string[]) {
        const at = features.findIndex((x) => x.id === id);
        if (at < 0) problems.push(`${f.key}: there is no feature "${id}". The features are: ${features.map((x) => x.name).join(", ") || "(none)"}`);
        else if (selfIndex >= 0 && at >= selfIndex) problems.push(`${f.key}: "${features[at].name}" comes after this feature in the tree; a feature can only use what is above it`);
      }
    }
  }
  if (def.type === "sketch") {
    const sk = params.sketch;
    if (!isObject(sk)) problems.push("a sketch needs params.sketch (or shapes)"); else problems.push(...checkEntities(sk.entities));
  }
  return problems;
}

/** The ops of cad_edit_features, for the message of an unknown one. */
export const EDIT_OPS = ["add", "set", "rename", "delete", "suppress", "move", "rollback", "set_variable", "delete_variable", "set_part"];

/**
 * Turn a list of edits into item changes.  Each edit sees the document as the ones before it left it; if any is
 * wrong nothing is planned and every problem is listed.  The edits:
 *   { op: "add", type, name?, params?, ref?, after? | before? | index? }      sketch: plane?, shapes?, define?, constraints?
 *   { op: "set", feature, params? }                                            sketch: plane?, shapes?, entities?, define?, constraints?
 *   { op: "rename", feature, name } · { op: "delete", feature } · { op: "suppress", feature, suppressed }
 *   { op: "move", feature, index? | before? | after? } · { op: "rollback", before: feature | null }
 *   { op: "set_variable", name, value, rename? } · { op: "delete_variable", name }
 *   { op: "set_part", body, name?, material?, color?, description? }
 * `feature` is an id, an exact name, or "$ref" of an add earlier in the list.  A number parameter given as a
 * string is an expression kept with the feature ("width / 2").  References written as picks must have been
 * resolved first (`planStaged`).
 */
export function planEdits(doc: ItemDoc, defs: Defs, list: unknown, o: PlanOptions = {}): Plan {
  const work = copyDoc(doc);
  const changes: ItemChange[] = [], inverse: ItemChange[] = [], done: string[] = [], problems: string[] = [];
  const refs = o.refs || new Map<string, string>();
  const sketches: Plan["sketches"] = {};
  const touched = new Set<string>();
  const empty = (): Plan => ({ changes: [], inverse: [], done: [], problems, after: doc, sketches: {}, touched: [] });
  if (!Array.isArray(list) || !list.length) { problems.push("edits must be a list with at least one edit"); return empty(); }

  const take = (cs: ItemChange[]): void => {
    for (const c of cs) { const inv = invertChange(work, c); if (applyChanges(work, [c]).size) { changes.push(c); if (inv) inverse.unshift(inv); } }
  };
  const subst = (v: Json | undefined): Json | undefined => {
    if (typeof v === "string" && v.startsWith("$") && refs.has(v.slice(1))) return refs.get(v.slice(1))!;
    if (Array.isArray(v)) return v.map((x) => subst(x) as Json);
    if (isObject(v)) { const out: JsonObject = {}; for (const [k, x] of Object.entries(v)) out[k] = subst(x); return out; }
    return v;
  };

  list.forEach((raw, n) => {
    const e = raw as JsonObject;
    const where = `edit ${n + 1 + (o.offset || 0)}` + (isObject(e) && typeof e.op === "string" ? ` (${e.op})` : "");
    const bad = (m: string): void => { problems.push(`${where}: ${m}`); };
    if (!isObject(e) || typeof e.op !== "string") { bad(`needs an op (${EDIT_OPS.join(", ")})`); return; }
    const features = featuresOf(work);
    const byKey = (key: string): FeatureItem | undefined => {
      const k = key.startsWith("$") && refs.has(key.slice(1)) ? refs.get(key.slice(1))! : key;
      return features.find((f) => f.id === k) || features.find((f) => f.name === k) || features.find((f) => f.name.toLowerCase() === k.toLowerCase());
    };
    const find = (key: unknown, what = "feature"): FeatureItem | null => {
      if (typeof key !== "string" || !key) { bad(`${what} is required: a feature's id or name`); return null; }
      const hit = byKey(key);
      if (!hit) bad(`there is no feature "${key}". The features are: ${features.map((f) => f.name).join(", ") || "(none)"}`);
      return hit || null;
    };
    const lookup = () => lookupOf(variableValues(variablesOf(work)));
    /** the ids of the bodies a word names: a body's id or part name, or the feature that made it */
    const bodyIds = (key: string): string[] => {
      const known = o.bodies || [], names = partNamesOf(work), low = key.toLowerCase();
      const k = key.startsWith("$") && refs.has(key.slice(1)) ? refs.get(key.slice(1))! : key;
      const direct = known.filter((b) => b.id === k);
      if (direct.length) return [direct[0].id];
      const named = known.filter((b) => (names[b.id] || b.name).toLowerCase() === low || b.name.toLowerCase() === low);
      if (named.length) return named.map((b) => b.id);
      const f = byKey(key);
      if (f) { const made = known.filter((b) => b.createdBy === f.id); return made.length ? made.map((b) => b.id) : [f.id]; }
      return [k];
    };
    /** params as given, with the shorthands a model may use made into what the document stores */
    const normal = (def: FeatureDefinition, base: JsonObject, given: JsonObject, name: string): JsonObject | null => {
      const params: JsonObject = { ...base, ...(subst(isObject(given.params) ? given.params : {}) as JsonObject) };
      const exprs: { [k: string]: string } = { ...(isObject(base[EXPR_KEY]) ? (base[EXPR_KEY] as { [k: string]: string }) : {}) };
      let failed = false;
      for (const f of def.schema) {
        const asked = isObject(given.params) && f.key in given.params;
        if (f.kind === "plane") {
          if (given.plane !== undefined && !asked) params[f.key] = subst(given.plane as Json);
          const pv = params[f.key];
          if (typeof pv === "string") { const hit = ["top", "front", "right"].includes(pv.toLowerCase()) ? null : byKey(pv); params[f.key] = hit ? { kind: "datum", feature: hit.id } : { kind: "plane", plane: pv.toLowerCase() }; }
          else if (isGeomRef(pv) && pv.kind === "face") params[f.key] = { kind: "face", ref: pv };
        }
        const v = params[f.key];
        if (f.kind === "number" && typeof v === "string" && asked) {
          // a number typed as text: a plain number is stored as one, anything else as the expression it is
          if (isPlainNumber(v)) { params[f.key] = Number(v); delete exprs[f.key]; }
          else { try { params[f.key] = evaluate(v, lookup()); exprs[f.key] = v.trim(); } catch (err) { bad(`${f.key}: "${v}" has no value: ${err instanceof Error ? err.message : String(err)}. Variables are set with { op: "set_variable", name, value }`); failed = true; } }
        } else if (f.kind === "number" && asked) delete exprs[f.key];
        // a face reference alone, or a list of them, is a profile of faces
        const asFaces = f.kind === "profile" && f.faces ? (Array.isArray(v) ? v : isObject(v) && v.kind === "face" ? [v] : null) : null;
        if (asFaces) params[f.key] = { sketch: null, regions: null, faces: asFaces };
        else if (f.kind === "profile" && (typeof v === "string" || (isObject(v) && typeof v.sketch === "string"))) {
          const key = typeof v === "string" ? v : (v.sketch as string);
          const hit = features.find((x) => x.id === key) || features.find((x) => x.name === key) || features.find((x) => x.name.toLowerCase() === key.toLowerCase());
          params[f.key] = { sketch: hit ? hit.id : key, regions: isObject(v) && Array.isArray(v.regions) ? v.regions : null, ...(isObject(v) && v.faces !== undefined && v.faces !== null ? { faces: v.faces } : {}) };
        }
        if (f.kind === "features" && asked) { const l = typeof v === "string" ? [v] : v; if (Array.isArray(l)) params[f.key] = l.map((x): Json => (typeof x === "string" ? (byKey(x) || { id: x }).id : x)); }
        if (f.kind === "bodies" && asked) { const l = typeof v === "string" ? [v] : v; if (Array.isArray(l)) params[f.key] = l.flatMap((x): Json[] => (typeof x === "string" ? bodyIds(x) : [x])); }
        if (f.kind === "refs" && f.single && Array.isArray(v) && v.length === 1 && asked) params[f.key] = v[0];
        if (f.kind === "refs" && !f.single && isObject(v) && asked) params[f.key] = [v];
      }
      if (failed) return null;
      if (Object.keys(exprs).length) params[EXPR_KEY] = exprs; else delete params[EXPR_KEY];
      if (def.type === "sketch") {
        const was = isObject(params.sketch) ? (params.sketch as SketchData) : emptySketch();
        let entities: { [id: string]: SketchEntity } = { ...(isObject(was.entities) ? was.entities : {}) };
        let constraints: { [id: string]: SketchConstraint } = { ...(isObject(was.constraints) ? was.constraints : {}) };
        let ids: ShapeIds[] = [];
        if (given.shapes !== undefined) {
          const made = shapesToEntities(given.shapes);
          if (made.problems.length) { made.problems.forEach(bad); return null; }
          entities = made.entities; ids = made.shapes;   // shapes replace what the sketch held, and what was said about it
          constraints = {};
        }
        if (isObject(given.entities)) for (const [id, ent] of Object.entries(given.entities)) { if (ent === null) delete entities[id]; else entities[id] = ent as SketchEntity; }
        const entityIssues = checkEntities(entities);
        if (entityIssues.length) { entityIssues.forEach(bad); return null; }
        let data: SketchData = { version: was.version || 1, entities, constraints };
        const constrained = given.define === true || given.constraints !== undefined;
        if (given.define === true) {
          if (!ids.length) { bad("define: true constrains the shapes drawn in the same edit; give shapes too"); return null; }
          data = { ...data, constraints: { ...data.constraints, ...defineShapes(data, ids) } };
        }
        if (given.constraints !== undefined) {
          const issues: string[] = [];
          const more = userConstraints(data, given.constraints, (t) => evaluate(t, lookup()), issues);
          if (issues.length) { issues.forEach(bad); return null; }
          data = { ...data, constraints: { ...data.constraints, ...more } };
        }
        if (given.shapes !== undefined || constrained || isObject(given.entities)) {
          const r = sketchReport(data, constrained ? o.solver : null);
          if (constrained && o.solver && !r.ok) { bad(`the sketch's constraints cannot all hold${r.report.conflicting ? ` (${r.report.conflicting.join(", ")} conflict)` : ""}. Nothing was changed: give fewer constraints, or values that agree with the shapes`); return null; }
          if (r.solved) data = r.solved;
          // each shape's entity ids, in a line: "rectangle: p1 p2 p3 p4 | l1 l2 l3 l4"
          sketches[name] = ids.length ? { ...r.report, shapes: ids.map((s) => `${s.type}: ${s.points.join(" ")}${s.curves.length ? " | " + s.curves.join(" ") : ""}`) } : r.report;
          if (r.report.regions === 0 && Object.values(data.entities).some((x) => x.type !== "point")) sketches[name].note = "The sketch encloses no region: an extrude of it will fail. Close the outline (lines that share end points, or a rectangle, circle or polygon).";
        }
        params.sketch = data;
      }
      return params;
    };
    const place = (moving?: string): number | null => {
      const rest = features.filter((f) => f.id !== moving);
      if (e.before !== undefined && e.before !== null) { const f = find(e.before, "before"); if (!f) return null; return rest.findIndex((x) => x.id === f.id); }
      if (e.after !== undefined && e.after !== null) { const f = find(e.after, "after"); if (!f) return null; return rest.findIndex((x) => x.id === f.id) + 1; }
      if (e.index !== undefined) { if (!num(e.index)) { bad("index must be a number"); return null; } return Math.max(0, Math.min(Math.round(e.index), rest.length)); }
      return -1;
    };

    switch (e.op) {
      case "add": {
        const def = defs.find((d) => d.type === e.type);
        if (!def) {
          const near = similarTypes(defs, String(e.type || ""));
          bad(`unknown feature type "${String(e.type)}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} cad_feature_types lists them (${defs.length}; search with query)`);
          return;
        }
        let at = place(); if (at === null) return;
        if (at < 0) at = rollbackIndex(work, features);
        const name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : nextName(features, def.title);
        const params = normal(def, def.defaults(), e, name); if (!params) return;
        const issues = validate(def, params, features, at);
        if (issues.length) { issues.forEach(bad); return; }
        const feature: FeatureItem = { id: newId(), type: "feature", featureType: def.type, name, order: orderAt(features, at), params };
        take([{ id: feature.id, kind: "ADDED", typeName: "feature", item: feature }]);
        if (typeof e.ref === "string" && e.ref) refs.set(e.ref.replace(/^\$/, ""), feature.id);
        touched.add(feature.id);
        done.push(`added ${def.title.toLowerCase()} "${name}" (${feature.id})`);
        return;
      }
      case "set": {
        const f = find(e.feature); if (!f) return;
        const def = defs.find((d) => d.type === f.featureType);
        if (!def) { bad(`"${f.name}" is of a type this server does not know (${f.featureType})`); return; }
        if (isObject(e.params)) { const unknown = Object.keys(e.params).filter((k) => !k.startsWith("$") && k !== "sketch" && !def.schema.some((s) => s.key === k) && !(k in f.params)); if (unknown.length) { bad(`"${f.name}" (${def.type}) has no parameter ${unknown.map((k) => `"${k}"`).join(", ")}. Its parameters are: ${def.schema.map((s) => s.key).join(", ")}`); return; } }
        const params = normal(def, f.params, e, f.name); if (!params) return;
        const issues = validate(def, params, features, features.findIndex((x) => x.id === f.id));
        if (issues.length) { issues.forEach(bad); return; }
        const cs = edits.setParams(work, f.id, params);
        if (!cs.length) { done.push(`"${f.name}" already has those parameters`); return; }
        const paths = cs.flatMap((c) => (c.kind === "MODIFIED" ? c.props.map((p) => p.path.slice(1, 4).join(".")) : []));
        take(cs);
        touched.add(f.id);
        done.push(`set ${Array.from(new Set(paths)).slice(0, 8).join(", ")} of "${f.name}"`);
        return;
      }
      case "rename": {
        const f = find(e.feature); if (!f) return;
        if (typeof e.name !== "string" || !e.name.trim()) { bad("name is required"); return; }
        take(edits.renameFeature(work, f.id, e.name)); done.push(`renamed "${f.name}" to "${e.name.trim()}"`);
        return;
      }
      case "delete": {
        const f = find(e.feature); if (!f) return;
        const users = features.filter((x) => x.id !== f.id && JSON.stringify(x.params).includes(f.id)).map((x) => x.name);
        take(edits.deleteFeature(work, f.id));
        done.push(`deleted "${f.name}"` + (users.length ? ` (${users.join(", ")} used it and will report an error)` : ""));
        return;
      }
      case "suppress": {
        const f = find(e.feature); if (!f) return;
        const on = e.suppressed !== false;
        take(edits.suppressFeature(work, f.id, on)); touched.add(f.id); done.push(`${on ? "suppressed" : "unsuppressed"} "${f.name}"`);
        return;
      }
      case "move": {
        const f = find(e.feature); if (!f) return;
        const at = place(f.id); if (at === null) return;
        if (at < 0) { bad("say where: index, before or after"); return; }
        take(edits.moveFeature(work, f.id, at)); touched.add(f.id); done.push(`moved "${f.name}" to position ${at}`);
        return;
      }
      case "rollback": {
        if (e.before === null || e.before === undefined || e.before === "end") { take(edits.setRollback(work, null)); done.push("moved the rollback bar to the end"); return; }
        const f = find(e.before, "before"); if (!f) return;
        take(edits.setRollback(work, f.id)); done.push(`moved the rollback bar above "${f.name}"`);
        return;
      }
      case "set_variable": {
        if (typeof e.name !== "string" || !e.name.trim()) { bad("name is required"); return; }
        const name = e.name.trim().replace(/^#/, ""), vars = variablesOf(work);
        const expr = num(e.value) ? String(e.value) : typeof e.value === "string" ? e.value.trim() : "";
        const has = vars.find((v) => v.name === name);
        if (!has) {
          const why = nameProblem(name, vars.map((v) => v.name));
          if (why) { bad(why); return; }
          if (!expr) { bad("value is required: a number (millimetres or degrees) or an expression (\"40 mm + 2 * wall\")"); return; }
        }
        const rename = typeof e.rename === "string" && e.rename.trim() ? e.rename.trim() : undefined;
        if (rename && rename !== name) { const why = nameProblem(rename, vars.filter((v) => v.name !== name).map((v) => v.name)); if (why) { bad(why); return; } }
        if (expr) {
          // the expression must have a value with the variables as they will be
          const others = vars.filter((v) => v.name !== name);
          const vv = variableValues([...others, { id: "~new", type: "variable", name, expr, order: "~" }]);
          if (vv.errors.has("~new")) { bad(`"${expr}" has no value: ${vv.errors.get("~new")}`); return; }
        }
        if (has) {
          const cs = setVariable(work, has.id, { ...(expr ? { expr } : {}), ...(rename ? { name: rename } : {}) });
          if (!cs.length) { done.push(`variable "${name}" already has that value`); return; }
          for (const c of cs) if (c.typeName === "feature") touched.add(c.id);
          take(cs); done.push(`set variable "${rename || name}"${expr ? ` to ${expr}` : ""}`);
        } else { take(addVariable(work, name, expr).changes); done.push(`added variable "${name}" = ${expr}`); }
        return;
      }
      case "delete_variable": {
        const name = typeof e.name === "string" ? e.name.trim().replace(/^#/, "") : "";
        const v = variablesOf(work).find((x) => x.name === name);
        if (!v) { bad(`there is no variable "${name}". The variables are: ${variablesOf(work).map((x) => x.name).join(", ") || "(none)"}`); return; }
        const users = usersOf(work, name).length;
        take(deleteVariable(work, v.id)); done.push(`deleted variable "${name}"` + (users ? ` (${users} feature${users === 1 ? "" : "s"} used it and keep the number they had)` : ""));
        return;
      }
      case "set_part": {
        if (typeof e.body !== "string" || !e.body) { bad("body is required: a body's id, its part name, or the feature that made it"); return; }
        const known = o.bodies || [];
        const ids = bodyIds(e.body).filter((id) => !known.length || known.some((b) => b.id === id));
        if (!ids.length) { bad(`there is no body "${e.body}". The bodies are: ${known.map((b) => `${partNamesOf(work)[b.id] || b.name} (${b.id})`).join(", ") || "(none)"}`); return; }
        const said: string[] = [];
        if (e.name !== undefined || e.description !== undefined) {
          if (e.name !== undefined && (typeof e.name !== "string" || ids.length > 1)) { bad(ids.length > 1 ? `"${e.body}" names ${ids.length} bodies; name them one at a time by id` : "name must be a string"); return; }
          for (const id of ids) take(updatePart(work, id, { ...(typeof e.name === "string" ? { name: e.name, fallback: known.find((b) => b.id === id)?.name || "" } : {}), ...(typeof e.description === "string" ? { description: e.description } : {}) }));
          if (typeof e.name === "string") said.push(`named "${e.name.trim()}"`);
          if (typeof e.description === "string") said.push("described");
        }
        if (e.material !== undefined) {
          const lib = materialsOf(work).library;
          const key = e.material === null ? null : String(e.material).trim().toLowerCase();
          const id = key === null ? null : Object.keys(lib).find((k) => k === key || lib[k].name.toLowerCase() === key);
          if (id === undefined) { bad(`there is no material "${String(e.material)}". The materials are: ${Object.keys(lib).map((k) => `${k} (${lib[k].density} g/cm3)`).join(", ")}; null takes the material away`); return; }
          take(assignMaterial(work, ids, id)); said.push(id ? `made of ${lib[id].name}` : "given no material");
        }
        if (e.color !== undefined) {
          if (e.color !== null && !isColor(e.color)) { bad("color is \"#rrggbb\", or null for the default"); return; }
          take(setBodyLook(work, ids, { color: e.color as string | null })); said.push(e.color ? `coloured ${e.color}` : "given the default colour");
        }
        if (!said.length) { bad("give name, material, color or description"); return; }
        done.push(`part ${ids.join(", ")}: ${said.join(", ")}`);
        return;
      }
      default: bad(`unknown op "${e.op}" (${EDIT_OPS.join(", ")})`);
    }
  });
  if (problems.length) return empty();
  return { changes, inverse, done, problems, after: work, sketches, touched: Array.from(touched) };
}

// ---------------------------------------------------------------- picks: references by description

const hasPick = (v: unknown): boolean => {
  if (Array.isArray(v)) return v.some(hasPick);
  if (!isObject(v)) return false;
  if (v.pick !== undefined && (v.kind === "face" || v.kind === "edge" || v.kind === "vertex")) return true;
  return Object.values(v).some(hasPick);
};
/** Whether an edit can only be planned against the model as built (it picks geometry, or names a part). */
export const needsModel = (e: unknown): boolean => isObject(e) && (e.op === "set_part" || hasPick(e));

/** The body a reference names among the built ones; throws a PickError that lists them. */
export function findBody(bodies: readonly KnownBody[], key: unknown, features: readonly FeatureItem[], refs: ReadonlyMap<string, string>, names: { [id: string]: string } = {}): KnownBody {
  const listed = () => bodies.map((b) => `${names[b.id] || b.name} (made by ${features.find((f) => f.id === b.createdBy)?.name || b.createdBy})`).join(", ") || "(none: nothing has been built yet)";
  if (key === undefined || key === null || key === "") {
    if (bodies.length === 1) return bodies[0];
    throw new PickError(`Say which body: ${listed()}.`);
  }
  if (typeof key !== "string") throw new PickError("body is a body's id, its part name, or the name of the feature that made it.");
  const k = key.startsWith("$") && refs.has(key.slice(1)) ? refs.get(key.slice(1))! : key, low = k.toLowerCase();
  const f = features.find((x) => x.id === k) || features.find((x) => x.name.toLowerCase() === low);
  const hit = bodies.find((b) => b.id === k) || bodies.find((b) => (names[b.id] || "").toLowerCase() === low) || bodies.find((b) => b.name.toLowerCase() === low)
    || (f ? bodies.find((b) => b.createdBy === f.id) || bodies.find((b) => b.id.startsWith(f.id)) : undefined);
  if (!hit) throw new PickError(`There is no body "${key}"${f ? ` (the feature "${f.name}" made none: it may have failed, or changed a body another feature made)` : ""}. The bodies are: ${listed()}.`);
  return hit;
}

/** An edit with every pick turned into the name it finds on the bodies as built.  Throws a PickError. */
export function resolvePicks(edit: Json, bodies: readonly KnownBody[], features: readonly FeatureItem[], refs: ReadonlyMap<string, string>, names: { [id: string]: string } = {}): Json {
  const one = (v: JsonObject): JsonObject[] => {
    const body = findBody(bodies, v.body, features, refs, names);
    if (!body.mesh) throw new PickError(`The body "${body.name}" has no geometry to pick from.`);
    const found = pickGeometry(body.mesh, v.kind as GeoKind, v.pick);
    return found.map((g) => ({ kind: v.kind, body: body.id, name: g.name }));
  };
  const walk = (v: Json): Json => {
    if (Array.isArray(v)) return v.flatMap((x) => (isObject(x) && x.pick !== undefined && (x.kind === "face" || x.kind === "edge" || x.kind === "vertex") ? (one(x) as Json[]) : [walk(x)]));
    if (!isObject(v)) return v;
    if (v.pick !== undefined && (v.kind === "face" || v.kind === "edge" || v.kind === "vertex")) {
      const found = one(v);
      if (found.length !== 1) throw new PickError(`${JSON.stringify(v.pick)} finds ${found.length} ${v.kind}s, and one is wanted here. Leave "all" out, or narrow it (nearest: [x, y, z]).`);
      return found[0];
    }
    const out: JsonObject = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x as Json);
    return out;
  };
  return walk(edit);
}

/**
 * Plan a batch whose edits may pick geometry of the model: the edits before a pick are planned, the document as
 * it would then be is built (`build`), the pick is resolved on those bodies, and planning goes on.  So one call
 * can extrude a block and sketch on its top face.  Nothing is changed: the result is one Plan for the whole
 * batch, or the problems.
 */
export async function planStaged(doc: ItemDoc, defs: Defs, list: unknown, o: PlanOptions, build: (doc: ItemDoc) => Promise<{ bodies: KnownBody[]; failed: { name: string; message: string }[] }>): Promise<Plan> {
  if (!Array.isArray(list) || !list.length || !list.some(needsModel)) return planEdits(doc, defs, list, o);
  const refs = o.refs || new Map<string, string>();
  const total: Plan = { changes: [], inverse: [], done: [], problems: [], after: doc, sketches: {}, touched: [] };
  const fail = (problems: string[]): Plan => ({ changes: [], inverse: [], done: [], problems, after: doc, sketches: {}, touched: [] });
  let work = doc, at = 0;
  const run = (edits: unknown[], bodies?: readonly KnownBody[]): string[] | null => {
    if (!edits.length) return null;
    const p = planEdits(work, defs, edits, { ...o, refs, offset: at, bodies: bodies || o.bodies });
    if (p.problems.length) return p.problems;
    total.changes.push(...p.changes); total.inverse.unshift(...p.inverse); total.done.push(...p.done);
    Object.assign(total.sketches, p.sketches); total.touched.push(...p.touched);
    work = p.after; at += edits.length;
    return null;
  };
  let pending: unknown[] = [];
  for (const e of list) {
    if (!needsModel(e)) { pending.push(e); continue; }
    const bad = run(pending); pending = [];
    if (bad) return fail(bad);
    const built = await build(work);
    let resolved: Json;
    try { resolved = resolvePicks(e as Json, built.bodies, featuresOf(work), refs, partNamesOf(work)); }
    catch (err) {
      if (!(err instanceof PickError)) throw err;
      const why = built.failed.length ? ` (${built.failed.map((f) => `"${f.name}" failed: ${f.message}`).join("; ")})` : "";
      return fail([`edit ${at + 1} (${String((e as JsonObject).op)}): ${err.message}${why}`]);
    }
    const bad2 = run([resolved], built.bodies);
    if (bad2) return fail(bad2);
  }
  const bad = run(pending);
  if (bad) return fail(bad);
  total.after = work; total.touched = Array.from(new Set(total.touched));
  return total;
}

/** What undoes `changes` on `doc` as it is now, and the document afterwards. */
export function applyRecorded(doc: ItemDoc, changes: readonly ItemChange[]): { applied: ItemChange[]; inverse: ItemChange[] } {
  const work = copyDoc(doc), applied: ItemChange[] = [], inverse: ItemChange[] = [];
  for (const c of changes) { const inv = invertChange(work, c); if (applyChanges(work, [c]).size) { applied.push(c); if (inv) inverse.unshift(inv); } }
  return { applied, inverse };
}

export { materialOf };
export { EXTRA_SHAPES };
