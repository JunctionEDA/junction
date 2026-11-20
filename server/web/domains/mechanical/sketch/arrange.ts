// arrange.ts — copying and moving what is drawn: the sketch's linear pattern, circular pattern and transform
// (translate, rotate, copy).  Select first, then take the tool: it is a ShapeSpec for the engine in
// sketch/draw.ts, so the measures can be typed while the pointer shows the result.
//
// A copy keeps the constraints that lie wholly inside what was copied (a rectangle's copies are rectangles);
// what ties it to the rest of the sketch (a fix, a dimension to the origin) stays with the original.
import type { Vec2 } from "../core/geometry";
import type { PartStudio } from "../ui/studio";
import { startDrawTool, type ShapeSpec } from "./draw";
import { sketchEditor } from "./editor";
import { curvePolylines, type SketchData, type SketchEntity } from "./format";
import type { Draft } from "./model";
import { ORIGIN, mapPoints, pointAt, pointsOf } from "./refs";
import { imageBox } from "./paint";

type Xform = (p: Vec2) => Vec2;
const TAU = Math.PI * 2;
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const len = (a: Vec2): number => Math.hypot(a[0], a[1]);
const deg = (r: number) => (r * 180) / Math.PI, rad = (d: number) => (d * Math.PI) / 180;
const rotate = (c: Vec2, t: number): Xform => (p) => { const x = p[0] - c[0], y = p[1] - c[1]; return [c[0] + x * Math.cos(t) - y * Math.sin(t), c[1] + x * Math.sin(t) + y * Math.cos(t)]; };
const translate = (v: Vec2): Xform => (p) => [p[0] + v[0], p[1] + v[1]];
const round = (v: Vec2): Vec2 => [Math.round(v[0] * 1e9) / 1e9, Math.round(v[1] * 1e9) / 1e9];

/** The entities a selection stands for: its curves and loose points (constraints are not copied by selection). */
function selected(data: SketchData, ids: readonly string[]): string[] {
  return ids.filter((id) => id in data.entities);
}

/** The middle of what is selected, for the rubber band. */
function centreOf(data: SketchData, ids: readonly string[]): Vec2 {
  let x = 0, y = 0, n = 0;
  for (const id of ids) for (const p of [id, ...pointsOf(data.entities[id])]) { const q = data.entities[p]?.type === "point" ? pointAt(data, p) : null; if (q) { x += q[0]; y += q[1]; n++; } }
  return n ? [x / n, y / n] : [0, 0];
}

/** What the selection looks like moved by `f`: polylines, for the rubber band. */
function ghost(data: SketchData, ids: readonly string[], f: Xform): Vec2[][] {
  const out: Vec2[][] = [];
  for (const id of ids) {
    const e = data.entities[id];
    if (e.type === "point") { const p = f([e.x, e.y]), r = 0.0001; out.push([p, [p[0] + r, p[1]]]); continue; }
    if (e.type === "image") { const b = imageBox(data, id); if (b) out.push([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]].map((v) => f(v as Vec2))); continue; }
    for (const poly of curvePolylines(data, e)) out.push(poly.map(f));
  }
  return out;
}

/**
 * Copy entities (and the points they are built on) through `f`, with the constraints wholly among them.
 * Returns the new id of each copied entity.
 */
export function copyEntities(d: Draft, ids: readonly string[], f: Xform): Map<string, string> {
  const data = d.data, map = new Map<string, string>();
  const points = new Set<string>();
  for (const id of ids) { const e = data.entities[id]; if (!e) continue; if (e.type === "point") points.add(id); else for (const p of pointsOf(e)) points.add(p); }
  for (const p of points) { const q = pointAt(data, p); if (q) map.set(p, d.point(round(f(q)))); }
  for (const id of ids) {
    const e = data.entities[id]; if (!e || e.type === "point") continue;
    const copy = mapPoints(e, (p) => map.get(p) || p) as SketchEntity;
    const nid = d.id(id.replace(/[^a-z].*$/i, "") || "e");
    d.set(nid, copy);
    map.set(id, nid);
  }
  for (const c of Object.values({ ...data.constraints })) {
    if (c.type === "fix" || c.type === "pierce" || !(c.refs || []).length) continue;
    if (!c.refs.every((r) => r.entity !== ORIGIN && map.has(r.entity))) continue;
    const { type, refs, ...rest } = c;
    const label = rest.label as { x: number; y: number } | undefined;
    if (label && Number.isFinite(label.x) && Number.isFinite(label.y)) { const q = round(f([label.x, label.y])); rest.label = { x: q[0], y: q[1] }; }
    d.constrain(type, refs.map((r) => ({ ...r, entity: map.get(r.entity)! })), rest.value === undefined ? {} : (rest as never));
  }
  return map;
}

/** Move entities (their points) through `f`. */
export function moveEntities(d: Draft, ids: readonly string[], f: Xform): void {
  const points = new Set<string>();
  for (const id of ids) { const e = d.data.entities[id]; if (!e) continue; if (e.type === "point") points.add(id); else for (const p of pointsOf(e)) points.add(p); }
  for (const p of points) { if (p === ORIGIN) continue; const q = pointAt(d.data, p); if (q) d.move(p, round(f(q))); }
  // a fix holds a point where it was: it moves with it
  for (const [cid, c] of Object.entries(d.data.constraints)) if (c.type === "fix" && c.refs.some((r) => ids.includes(r.entity) || points.has(r.entity))) d.unconstrain(cid);
}

/** Start a tool that needs a selection; with none, say so. */
function withSelection(studio: PartStudio, what: string, spec: (ids: string[]) => ShapeSpec): void {
  const ed = sketchEditor(studio);
  if (!ed.getState().open) return;
  const ids = selected(ed.getState().data, ed.getState().selection);
  if (!ids.length) { studio.host.toast(`Select the sketch entities to ${what} first, then take the tool.`, 3500); return; }
  startDrawTool(studio, spec(ids));
  ed.select(ids);
}

// ---------------------------------------------------------------- linear pattern
let linearCount = 3;
export function runLinearPattern(studio: PartStudio, toolId: string): void {
  withSelection(studio, "pattern", (ids) => {
    const offset = (pts: { p: Vec2 }[], c: Vec2): Vec2 => sub(c, pts[0].p);
    return {
      id: toolId, clicks: 2,
      hint: (n) => (n ? `Click where the first copy goes, or type its distance and angle; N sets the number of instances (${linearCount}).` : "Click a point to measure the pattern from."),
      fields: (pts, c) => { const v = offset(pts, c); return [{ key: "count", label: "N", unit: "n", value: linearCount }, { key: "distance", label: "D", unit: "mm", value: len(v) }, { key: "angle", label: "∠", unit: "deg", value: (deg(Math.atan2(v[1], v[0])) + 360) % 360 }]; },
      constrain(pts, c, typed) {
        if (typed.count !== undefined) linearCount = Math.max(2, Math.min(100, Math.round(typed.count)));
        const v = offset(pts, c), l = typed.distance ?? len(v), t = typed.angle !== undefined ? rad(typed.angle) : Math.atan2(v[1], v[0]);
        return [pts[0].p[0] + l * Math.cos(t), pts[0].p[1] + l * Math.sin(t)];
      },
      preview(pts, c, data) {
        const v = offset(pts, c.p), out: Vec2[][] = [[pts[0].p, c.p]];
        for (let i = 1; i < linearCount; i++) out.push(...ghost(data, ids, translate([v[0] * i, v[1] * i])));
        return out;
      },
      build(d, pts, typed) {
        if (typed.count !== undefined) linearCount = Math.max(2, Math.min(100, Math.round(typed.count)));
        const v = offset(pts, pts[1].p);
        if (len(v) < 1e-9) return false;
        for (let i = 1; i < linearCount; i++) copyEntities(d, ids, translate([v[0] * i, v[1] * i]));
        return {};
      },
    };
  });
}

// ---------------------------------------------------------------- circular pattern
let circularCount = 4;
export function runCircularPattern(studio: PartStudio, toolId: string): void {
  withSelection(studio, "pattern", (ids) => {
    let from: Vec2 = [0, 0];
    const sweep = (pts: { p: Vec2 }[], c: Vec2, typed: { [k: string]: number }): number => {
      if (typed.angle !== undefined) return rad(typed.angle);
      const o = pts[0].p, a = Math.atan2(from[1] - o[1], from[0] - o[0]), b = Math.atan2(c[1] - o[1], c[0] - o[0]);
      let t = b - a; while (t <= 1e-9) t += TAU;
      return t;
    };
    let typedNow: { [k: string]: number } = {};
    return {
      id: toolId, clicks: 2,
      hint: (n) => (n ? `Move round to where the last instance goes and click, or type the total angle (360 for all the way round); N sets the number of instances (${circularCount}).` : "Click the centre of the pattern."),
      accept: (pts, _next, data) => { if (!pts.length) from = centreOf(data, ids); return true; },
      fields: (pts, c) => [{ key: "count", label: "N", unit: "n", value: circularCount }, { key: "angle", label: "∠", unit: "deg", value: deg(sweep(pts, c, {})) }],
      constrain(pts, c, typed) { typedNow = typed; if (typed.count !== undefined) circularCount = Math.max(2, Math.min(360, Math.round(typed.count))); return c; },
      reset: () => { typedNow = {}; },
      preview(pts, c, data) {
        const total = sweep(pts, c.p, typedNow), out: Vec2[][] = [[pts[0].p, c.p]];
        const full = Math.abs(total - TAU) < 1e-6, step = total / (full ? circularCount : circularCount - 1);
        for (let i = 1; i < circularCount; i++) out.push(...ghost(data, ids, rotate(pts[0].p, step * i)));
        return out;
      },
      build(d, pts, typed) {
        if (typed.count !== undefined) circularCount = Math.max(2, Math.min(360, Math.round(typed.count)));
        const total = sweep(pts, pts[1].p, typed), full = Math.abs(total - TAU) < 1e-6, step = total / (full ? circularCount : circularCount - 1);
        if (!(Math.abs(step) > 1e-9)) return false;
        for (let i = 1; i < circularCount; i++) copyEntities(d, ids, rotate(pts[0].p, step * i));
        return {};
      },
    };
  });
}

// ---------------------------------------------------------------- transform
let keepOriginal = false;
export function runTransform(studio: PartStudio, toolId: string): void {
  withSelection(studio, "move", (ids) => {
    let typedNow: { [k: string]: number } = {};
    const xf = (pts: { p: Vec2 }[], c: Vec2, typed: { [k: string]: number }): Xform => {
      const t = translate(sub(c, pts[0].p)), r = rotate(c, rad(typed.rotate || 0));
      return (p) => r(t(p));
    };
    return {
      id: toolId, clicks: 2,
      hint: (n) => (n ? `Click where that point goes, or type the distance; R turns it about there. C: ${keepOriginal ? "a copy (the original stays)" : "move (no copy)"}.` : `Click a point of what is selected to move it by. C: ${keepOriginal ? "copy" : "move"}.`),
      fields: (pts, c) => { const v = sub(c, pts[0].p); return [{ key: "distance", label: "D", unit: "mm", value: len(v) }, { key: "angle", label: "∠", unit: "deg", value: (deg(Math.atan2(v[1], v[0])) + 360) % 360 }, { key: "rotate", label: "R", unit: "deg", value: typedNow.rotate || 0 }]; },
      constrain(pts, c, typed) {
        typedNow = typed;
        const v = sub(c, pts[0].p), l = typed.distance ?? len(v), t = typed.angle !== undefined ? rad(typed.angle) : Math.atan2(v[1], v[0]);
        return [pts[0].p[0] + l * Math.cos(t), pts[0].p[1] + l * Math.sin(t)];
      },
      key: (ev) => { if (ev.key !== "c" && ev.key !== "C") return false; keepOriginal = !keepOriginal; return true; },
      reset: () => { typedNow = {}; },
      preview: (pts, c, data) => [[pts[0].p, c.p], ...ghost(data, ids, xf(pts, c.p, typedNow))],
      build(d, pts, typed) {
        const f = xf(pts, pts[1].p, typed);
        if (keepOriginal) copyEntities(d, ids, f); else moveEntities(d, ids, f);
        return {};
      },
    };
  });
}
