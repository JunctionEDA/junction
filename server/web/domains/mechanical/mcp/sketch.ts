// sketch.ts — the sketch shapes an AI assistant draws with, beyond the plain ones of model.ts: slots, centre and
// rounded rectangles, arcs, open paths and points; the constraints and dimensions that make a shape hold its
// size when a person later drags it; constraints given by hand; and what the sketch then is (how many closed
// regions it encloses, whether it is fully defined, what conflicts).
//
// The document stores solved coordinates (CONTRACT.md "The sketch"), so the entities written here are already
// where the constraints want them: the solver (sketch/solver, PlaneGCS) is run to check that and to count the
// freedoms left, never to find the shape.  Without a solver the shapes are written all the same and the report
// leaves the freedoms out.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { SketchConstraint, SketchData, SketchEntity, SketchRef } from "../sketch/format";
import { findRegions } from "../sketch/planar";
import { ORIGIN, measure } from "../sketch/refs";
import type { SketchSolver } from "../sketch/solver/solve";

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const EXTRA_SHAPES = "{ type: \"center_rectangle\", cx, cy, width, height }, { type: \"rounded_rectangle\", x1, y1, x2, y2, radius }, { type: \"slot\", x1, y1, x2, y2, width } (the two end centres), { type: \"arc\", cx, cy, r, start, end } (degrees, counter-clockwise), { type: \"polyline\", points: [[x, y], ...], closed? } (an open path unless closed), { type: \"point\", x, y } (a hole position)";
export const SHAPE_TYPES = ["rectangle", "center_rectangle", "rounded_rectangle", "circle", "slot", "polygon", "polyline", "regular_polygon", "line", "arc", "ellipse", "spline", "bezier", "text", "point"];

/** The constraint types the sketcher knows (CONTRACT.md); a dimension has a value. */
export const CONSTRAINT_TYPES = ["coincident", "horizontal", "vertical", "parallel", "perpendicular", "tangent", "equal", "midpoint", "concentric", "collinear", "symmetric", "fix", "distance", "radius", "diameter", "angle"];
const DIMENSIONS = ["distance", "radius", "diameter", "angle"];

export interface ShapeIds extends JsonObject { shape: number; type: string; points: string[]; curves: string[] }
export interface Builder {
  entities: { [id: string]: SketchEntity };
  constraints: { [id: string]: SketchConstraint };
  shapes: ShapeIds[];
  problems: string[];
}

/** What the shapes of this file make; null for a type model.ts draws itself. */
export function extraShape(s: JsonObject, where: string, id: (prefix: string) => string, out: { [id: string]: SketchEntity }, problems: string[]): boolean {
  const point = (x: number, y: number): string => { const i = id("p"); out[i] = { type: "point", x: round(x), y: round(y) }; return i; };
  const type = s.type;
  if (type === "center_rectangle") {
    if (![s.cx, s.cy, s.width, s.height].every(num) || !((s.width as number) > 0) || !((s.height as number) > 0)) { problems.push(`${where}: a center_rectangle needs cx, cy, and width and height above zero`); return true; }
    const [cx, cy, w, h] = [s.cx, s.cy, s.width, s.height] as number[];
    const pts = [point(cx - w / 2, cy - h / 2), point(cx + w / 2, cy - h / 2), point(cx + w / 2, cy + h / 2), point(cx - w / 2, cy + h / 2)];
    for (let i = 0; i < 4; i++) out[id("l")] = { type: "line", a: pts[i], b: pts[(i + 1) % 4] };
    return true;
  }
  if (type === "rounded_rectangle") {
    if (![s.x1, s.y1, s.x2, s.y2, s.radius].every(num)) { problems.push(`${where}: a rounded_rectangle needs x1, y1, x2, y2 and radius`); return true; }
    const x1 = Math.min(s.x1 as number, s.x2 as number), x2 = Math.max(s.x1 as number, s.x2 as number), y1 = Math.min(s.y1 as number, s.y2 as number), y2 = Math.max(s.y1 as number, s.y2 as number), r = s.radius as number;
    if (!(r > 0) || 2 * r >= Math.min(x2 - x1, y2 - y1)) { problems.push(`${where}: the radius must be above zero and less than half the shorter side (${Math.min(x2 - x1, y2 - y1) / 2})`); return true; }
    // counter-clockwise from the bottom edge; each corner arc runs counter-clockwise from start to end
    const b1 = point(x1 + r, y1), b2 = point(x2 - r, y1), r1 = point(x2, y1 + r), r2 = point(x2, y2 - r), t1 = point(x2 - r, y2), t2 = point(x1 + r, y2), l1 = point(x1, y2 - r), l2 = point(x1, y1 + r);
    const cbr = point(x2 - r, y1 + r), ctr = point(x2 - r, y2 - r), ctl = point(x1 + r, y2 - r), cbl = point(x1 + r, y1 + r);
    out[id("l")] = { type: "line", a: b1, b: b2 }; out[id("a")] = { type: "arc", center: cbr, start: b2, end: r1 };
    out[id("l")] = { type: "line", a: r1, b: r2 }; out[id("a")] = { type: "arc", center: ctr, start: r2, end: t1 };
    out[id("l")] = { type: "line", a: t1, b: t2 }; out[id("a")] = { type: "arc", center: ctl, start: t2, end: l1 };
    out[id("l")] = { type: "line", a: l1, b: l2 }; out[id("a")] = { type: "arc", center: cbl, start: l2, end: b1 };
    return true;
  }
  if (type === "slot") {
    if (![s.x1, s.y1, s.x2, s.y2, s.width].every(num) || !((s.width as number) > 0)) { problems.push(`${where}: a slot needs x1, y1, x2, y2 (the centres of its two ends) and width above zero`); return true; }
    const [x1, y1, x2, y2] = [s.x1, s.y1, s.x2, s.y2] as number[], r = (s.width as number) / 2;
    const l = Math.hypot(x2 - x1, y2 - y1);
    if (l < 1e-9) { problems.push(`${where}: the two ends of the slot are the same point; draw a circle instead`); return true; }
    const nx = -(y2 - y1) / l, ny = (x2 - x1) / l;
    const c1 = point(x1, y1), c2 = point(x2, y2);
    const a = point(x1 - nx * r, y1 - ny * r), b = point(x2 - nx * r, y2 - ny * r), c = point(x2 + nx * r, y2 + ny * r), d = point(x1 + nx * r, y1 + ny * r);
    out[id("l")] = { type: "line", a, b }; out[id("a")] = { type: "arc", center: c2, start: b, end: c };
    out[id("l")] = { type: "line", a: c, b: d }; out[id("a")] = { type: "arc", center: c1, start: d, end: a };
    return true;
  }
  if (type === "arc") {
    if (![s.cx, s.cy, s.r, s.start, s.end].every(num) || !((s.r as number) > 0)) { problems.push(`${where}: an arc needs cx, cy, a radius r above zero, and start and end angles in degrees (counter-clockwise from start to end)`); return true; }
    const [cx, cy, r] = [s.cx, s.cy, s.r] as number[], a0 = ((s.start as number) * Math.PI) / 180, a1 = ((s.end as number) * Math.PI) / 180;
    out[id("a")] = { type: "arc", center: point(cx, cy), start: point(cx + r * Math.cos(a0), cy + r * Math.sin(a0)), end: point(cx + r * Math.cos(a1), cy + r * Math.sin(a1)) };
    return true;
  }
  if (type === "polyline") {
    const pts = s.points;
    if (!Array.isArray(pts) || pts.length < 2 || !pts.every((p) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]))) { problems.push(`${where}: a polyline needs points: [[x, y], ...] with at least two`); return true; }
    const ids = (pts as number[][]).map((p) => point(p[0], p[1]));
    for (let i = 0; i + 1 < ids.length; i++) out[id("l")] = { type: "line", a: ids[i], b: ids[i + 1] };
    if (s.closed && ids.length >= 3) out[id("l")] = { type: "line", a: ids[ids.length - 1], b: ids[0] };
    return true;
  }
  if (type === "point") {
    if (![s.x, s.y].every(num)) { problems.push(`${where}: a point needs x and y`); return true; }
    point(s.x as number, s.y as number);
    return true;
  }
  return false;
}

const round = (v: number): number => { const r = Math.round(v * 1e9) / 1e9; return Object.is(r, -0) ? 0 : r; };

// ---------------------------------------------------------------- constraints that make the shapes hold

/**
 * The constraints and dimensions that define what was drawn: sides square to the axes, sizes as dimensions,
 * positions as distances from the sketch origin, and whatever is left pinned where it is.  The values are
 * measured from the entities, so they hold as drawn.
 */
export function defineShapes(data: SketchData, shapes: readonly ShapeIds[]): { [id: string]: SketchConstraint } {
  const out: { [id: string]: SketchConstraint } = {};
  let n = 0;
  const all = (): SketchData => ({ ...data, constraints: { ...data.constraints, ...out } });
  const add = (c: SketchConstraint): void => {
    if (DIMENSIONS.includes(c.type)) { const v = measure(all(), c); if (v === null || !Number.isFinite(v)) return; c.value = round(v); }
    for (;;) { const id = (DIMENSIONS.includes(c.type) ? "d" : "k") + ++n; if (!(id in data.constraints) && !(id in out)) { out[id] = c; return; } }
  };
  const pt = (id: string): { x: number; y: number } => data.entities[id] as unknown as { x: number; y: number };
  const E = (entity: string, at?: SketchRef["at"]): SketchRef => (at ? { entity, at } : { entity });
  /** a point's place: on the origin, or its distances from it along x and y */
  const place = (p: string): void => {
    const { x, y } = pt(p);
    if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) { add({ type: "coincident", refs: [E(p), E(ORIGIN)] }); return; }
    add({ type: "distance", refs: [E(ORIGIN), E(p)], axis: "x" });
    add({ type: "distance", refs: [E(ORIGIN), E(p)], axis: "y" });
  };
  const pin = (ids: readonly string[]): void => { for (const p of ids) add({ type: "fix", refs: [E(p)] }); };
  for (const s of shapes) {
    const lines = s.curves.filter((c) => data.entities[c]?.type === "line");
    if ((s.type === "rectangle" || s.type === "center_rectangle") && lines.length === 4) {
      lines.forEach((l, i) => add({ type: i % 2 ? "vertical" : "horizontal", refs: [E(l)] }));
      add({ type: "distance", refs: [E(lines[0])] }); add({ type: "distance", refs: [E(lines[1])] });
      place(s.points[0]);
    } else if (s.type === "circle" && s.curves.length === 1) {
      add({ type: "diameter", refs: [E(s.curves[0])] });
      place(s.points[0]);
    } else if (s.type === "point" || s.type === "text") pin(s.points.slice(0, s.type === "text" ? 2 : 1));
    else {
      // every other shape: axis-parallel sides say so, and its points stay where they were drawn
      for (const l of lines) {
        const e = data.entities[l] as { a: string; b: string };
        const a = pt(e.a), b = pt(e.b);
        if (Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.x - b.x) > 1e-9) add({ type: "horizontal", refs: [E(l)] });
        else if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) > 1e-9) add({ type: "vertical", refs: [E(l)] });
      }
      pin(s.points);
    }
  }
  return out;
}

/** Constraints as an assistant writes them, checked and given ids.  `value` may be an expression (`expr`). */
export function userConstraints(data: SketchData, given: unknown, evaluate: (text: string) => number, problems: string[]): { [id: string]: SketchConstraint } {
  const out: { [id: string]: SketchConstraint } = {};
  if (!Array.isArray(given)) { problems.push("constraints must be a list of { type, refs, value? }"); return out; }
  let n = 0;
  given.forEach((raw, i) => {
    const where = `constraint ${i + 1}`;
    if (!isObject(raw) || typeof raw.type !== "string") { problems.push(`${where} needs a type (${CONSTRAINT_TYPES.join(", ")})`); return; }
    if (!CONSTRAINT_TYPES.includes(raw.type)) { problems.push(`${where}: unknown constraint type "${raw.type}" (${CONSTRAINT_TYPES.join(", ")})`); return; }
    if (!Array.isArray(raw.refs) || !raw.refs.length) { problems.push(`${where}: refs must be a list of entity ids, or { entity, at: "start" | "end" | "center" } for a point of a curve; "$origin" is the sketch origin`); return; }
    const refs: SketchRef[] = [];
    for (const r of raw.refs) {
      const ref = typeof r === "string" ? { entity: r } : isObject(r) && typeof r.entity === "string" ? ({ entity: r.entity, ...(typeof r.at === "string" ? { at: r.at } : {}) } as SketchRef) : null;
      if (!ref || (ref.entity !== ORIGIN && !data.entities[ref.entity])) { problems.push(`${where}: there is no entity "${ref ? ref.entity : JSON.stringify(r)}" in the sketch. Its entities are: ${Object.keys(data.entities).slice(0, 60).join(", ")}`); return; }
      if (ref.at && !["start", "end", "center"].includes(ref.at)) { problems.push(`${where}: at is "start", "end" or "center"`); return; }
      refs.push(ref);
    }
    const c: SketchConstraint = { type: raw.type, refs };
    if (raw.axis === "x" || raw.axis === "y") c.axis = raw.axis;
    if (DIMENSIONS.includes(raw.type)) {
      const v = raw.value !== undefined ? raw.value : raw.expr;
      if (typeof v === "string" && v.trim()) { try { c.value = round(evaluate(v)); c.expr = v.trim(); } catch (e) { problems.push(`${where}: "${v}" has no value: ${e instanceof Error ? e.message : String(e)}`); return; } }
      else if (num(v)) c.value = v;
      else { problems.push(`${where}: a ${raw.type} needs a value (millimetres, or degrees for an angle; a string is an expression that may use variables)`); return; }
      if (raw.driving === false) c.driving = false;
    }
    for (;;) { const id = (DIMENSIONS.includes(c.type) ? "d" : "k") + ++n; if (!(id in data.constraints) && !(id in out)) { out[id] = c; break; } }
  });
  return out;
}

// ---------------------------------------------------------------- what a sketch is

export interface SketchReport extends JsonObject {
  entities: number; constraints: number;
  /** closed regions a feature can use as a profile */
  regions: number;
  /** curves that are on no closed loop */
  open_curves?: number;
  /** freedoms left; 0 is fully defined (absent when the solver was not run) */
  freedoms?: number;
  fully_defined?: boolean;
  conflicting?: string[];
  redundant?: string[];
}

/** How a sketch stands.  With a solver also its freedoms and conflicts; `solved` is the sketch as solved. */
export function sketchReport(data: SketchData, solver?: SketchSolver | null): { report: SketchReport; solved: SketchData | null; ok: boolean } {
  let regions = 0, open = 0;
  try { const r = findRegions(data); regions = r.regions.length; open = r.open.length; } catch (e) { /* a sketch the arrangement cannot read has no regions */ }
  const curves = Object.values(data.entities).filter((e) => e.type !== "point").length;
  const report: SketchReport = { entities: Object.keys(data.entities).length, constraints: Object.keys(data.constraints || {}).length, regions };
  if (open) report.open_curves = open;
  if (!curves && !Object.keys(data.entities).length) return { report, solved: null, ok: true };
  if (!solver) return { report, solved: null, ok: true };
  const r = solver.solve(data);
  report.freedoms = r.dof; report.fully_defined = r.ok && r.dof === 0;
  if (r.conflicting.length) report.conflicting = r.conflicting;
  if (r.redundant.length) report.redundant = r.redundant;
  return { report, solved: r.ok ? r.data : null, ok: r.ok };
}
