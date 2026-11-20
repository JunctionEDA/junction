// modify.ts — the pointer side of the tools that change what is drawn: trim, extend, fillet, offset, mirror,
// and using the model's edges in the sketch.  The geometry is in sketch/ops.ts; this is when each is run.
import type { GeomRef, Vec2 } from "../core/geometry";
import type { PartStudio } from "../ui/studio";
import type { Pick } from "../viewport/modelview";
import { lenText, typedFactor } from "./dims";
import { sketchEditor, type SketchEditor } from "./editor";
import { tryEvaluate } from "./expr";
import { curvePoints, type SketchData } from "./format";
import { gridStep, nearestOn } from "./infer";
import { Draft } from "./model";
import { chainOf, extend, fillet, mirror, offset, split, trim } from "./ops";
import { pointAt, resolveEntity } from "./refs";
import type { Projected } from "../services/sketch-project";
import type { SketchEntity } from "./format";

/** Run an operation as one edit; a sentence back from it is shown and nothing changes. */
function apply(ed: SketchEditor, op: (d: Draft) => string | null): boolean {
  let why: string | null = null;
  const ok = ed.edit((d) => { why = op(d); return why ? false : undefined; });
  if (why) ed.studio.host.toast(why, 3500);
  return ok;
}

/** Collects a typed number while a tool is in hand, and shows it in the hint line. */
function numberEntry(ed: SketchEditor, hint: (typing: string) => string, done: (value: number) => void) {
  let buffer = "";
  const show = () => ed.setHint(hint(buffer));
  show();
  return {
    show,
    key(ev: KeyboardEvent): boolean {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
      if (ev.key === "Enter" && buffer) {
        const v = tryEvaluate(buffer, "length", typedFactor(false));
        if (!v || !(v.value > 0)) { ed.studio.host.toast("Type a length, like 5 or 0.25 in.", 2500); return true; }
        buffer = ""; done(v.value); show(); return true;
      }
      if (ev.key === "Escape" && buffer) { buffer = ""; show(); return true; }
      if (ev.key === "Backspace" && buffer) { buffer = buffer.slice(0, -1); show(); return true; }
      if (ev.key.length === 1 && (buffer ? /[0-9a-z.+\-*/^()"' ]/i.test(ev.key) : /[0-9.(]/.test(ev.key))) { buffer += ev.key; show(); return true; }
      return false;
    },
  };
}

// ---------------------------------------------------------------- trim, extend
export function runTrim(studio: PartStudio, toolId: string): void {
  const ed = sketchEditor(studio);
  ed.select([]);
  ed.useTool(toolId, {
    move(ev) { const t = ed.hit(ev, { boxes: false, points: false }); ed.setHover(t ? t.id : null); },
    down(ev) { const t = ed.hit(ev, { boxes: false, points: false }); if (t) { ed.setHover(null); apply(ed, (d) => trim(d, t.id, t.p)); } },
    stop() { ed.setHover(null); },
  }, "Click the part of a curve to cut away, up to where other curves cross it.");
}

export function runExtend(studio: PartStudio, toolId: string): void {
  const ed = sketchEditor(studio);
  ed.select([]);
  ed.useTool(toolId, {
    move(ev) { const t = ed.hit(ev, { boxes: false, points: false }); ed.setHover(t ? t.id : null); },
    down(ev) { const t = ed.hit(ev, { boxes: false, points: false }); if (t) apply(ed, (d) => extend(d, t.id, t.p)); },
    stop() { ed.setHover(null); },
  }, "Click near the end of a line or an arc to lengthen it to the next curve.");
}

export function runSplit(studio: PartStudio, toolId: string): void {
  const ed = sketchEditor(studio);
  ed.select([]);
  ed.useTool(toolId, {
    move(ev) { const t = ed.hit(ev, { boxes: false, points: false }); ed.setHover(t ? t.id : null); },
    down(ev) { const t = ed.hit(ev, { boxes: false, points: false }); if (t) { ed.setHover(null); apply(ed, (d) => split(d, t.id, t.p)); } },
    stop() { ed.setHover(null); },
  }, "Click a line or an arc where it should be split in two.");
}

// ---------------------------------------------------------------- fillet
let filletRadius = 5;
export function runFillet(studio: PartStudio, toolId: string): void {
  const ed = sketchEditor(studio);
  const entry = numberEntry(ed, (typing) => `Click a corner to round it. Radius ${typing ? typing + "▏" : lenText(filletRadius)} (type a number and press Enter to change it).`, (v) => { filletRadius = v; });
  // a corner that was selected before the tool was taken is rounded at once
  const pre = ed.getState().selection.filter((id) => ed.getState().data.entities[id]?.type === "point");
  ed.select([]);
  for (const id of pre) apply(ed, (d) => fillet(d, id, filletRadius));
  ed.useTool(toolId, {
    move(ev) { const t = ed.hit(ev, { boxes: false, curves: false }); ed.setHover(t ? t.id : null); },
    down(ev) { const t = ed.hit(ev, { boxes: false, curves: false }); if (t) { ed.setHover(null); apply(ed, (d) => fillet(d, t.id, filletRadius)); } },
    key: entry.key,
    stop() { ed.setHover(null); },
  });
  entry.show();
}

// ---------------------------------------------------------------- offset
export function runOffset(studio: PartStudio, toolId: string): void {
  const ed = sketchEditor(studio);
  const curvesOf = (ids: readonly string[]) => ids.filter((id) => { const e = ed.getState().data.entities[id]; return e && e.type !== "point"; });
  let ids = curvesOf(ed.getState().selection);
  let typed: number | null = null;
  ed.select(ids);
  const entry = numberEntry(ed, (typing) => (ids.length ? `Move to the side to offset to and click. Distance ${typing ? typing + "▏" : typed !== null ? lenText(typed) : "follows the pointer"} (or type it and press Enter).` : "Click a curve to offset; curves joined to it come along."), (v) => { typed = v; preview(ed.lastPointer); });
  /** The distance from the pointer to the nearest of the curves being offset, tidied. */
  const reach = (p: Vec2): number => {
    let best = Infinity;
    for (const id of ids) { const r = resolveEntity(ed.getState().data, id); const n = r && r.kind !== "point" ? nearestOn(r, p) : null; if (n && n.d < best) best = n.d; }
    const step = gridStep(ed.px);
    return Math.max(step, Math.round(best / step) * step);
  };
  const made = (data: SketchData, p: Vec2): { draft: Draft; why: string | null } => { const d = new Draft(data); return { draft: d, why: offset(d, ids, typed ?? reach(p), p) }; };
  function preview(ev: PointerEvent | null): void {
    const p = ev ? ed.planePoint(ev) : null;
    if (!p || !ids.length) { ed.setPreview(null); return; }
    const data = ed.getState().data, { draft, why } = made(data, p);
    if (why) { ed.setPreview(null); return; }
    const lines: Vec2[][] = [];
    for (const [id, e] of Object.entries(draft.data.entities)) if (!(id in data.entities) && e.type !== "point") lines.push(curvePoints(draft.data, e, 96));
    ed.setPreview({ lines });
  }
  ed.useTool(toolId, {
    move(ev) {
      if (!ids.length) { const t = ed.hit(ev, { boxes: false, points: false }); ed.setHover(t ? t.id : null); return; }
      preview(ev);
    },
    down(ev) {
      const p = ed.planePoint(ev); if (!p) return;
      if (!ids.length) {
        const t = ed.hit(ev, { boxes: false, points: false }); if (!t) return;
        ids = chainOf(ed.getState().data, t.id).map((c) => c.id);
        ed.setHover(null); ed.select(ids); entry.show();
        return;
      }
      if (apply(ed, (d) => offset(d, ids, typed ?? reach(p), p))) { ids = []; typed = null; ed.select([]); ed.setPreview(null); entry.show(); }
    },
    key(ev) {
      if (ev.key === "Escape" && ids.length && !ev.ctrlKey) { ids = []; typed = null; ed.select([]); ed.setPreview(null); entry.show(); return true; }
      return entry.key(ev);
    },
    stop() { ed.setPreview(null); ed.setHover(null); },
  });
  entry.show();
}

// ---------------------------------------------------------------- mirror
export function runMirror(studio: PartStudio, toolId: string): void {
  const ed = sketchEditor(studio);
  const pre = ed.getState().selection.filter((id) => !!ed.getState().data.entities[id]);
  let axis: string | null = null;
  const hint = () => ed.setHint(pre.length ? "Click the line to mirror the selection about." : axis ? "Click each curve to mirror. Esc when done." : "Click the line to mirror about, then the curves to mirror.");
  ed.useTool(toolId, {
    move(ev) { const t = ed.hit(ev, { boxes: false, points: false }); ed.setHover(t ? t.id : null); },
    down(ev) {
      const t = ed.hit(ev, { boxes: false, points: false }); if (!t) return;
      const e = ed.getState().data.entities[t.id];
      if (pre.length) {
        if (!e || e.type !== "line") { studio.host.toast("Click a line to mirror about.", 2500); return; }
        if (apply(ed, (d) => mirror(d, pre, t.id))) { ed.select([]); ed.useSelect(); }
        return;
      }
      if (!axis) {
        if (!e || e.type !== "line") { studio.host.toast("Click a line to mirror about.", 2500); return; }
        axis = t.id; ed.select([axis]); hint();
        return;
      }
      if (t.id !== axis) apply(ed, (d) => mirror(d, [t.id], axis!));
    },
    key(ev) { if (ev.key === "Escape" && axis && !pre.length) { axis = null; ed.select([]); hint(); return true; } return false; },
    stop() { ed.setHover(null); },
  });
  ed.select(pre);
  hint();
}

// ---------------------------------------------------------------- using the model's edges
/**
 * Use: click an edge or a vertex of the model and it is drawn in the sketch, projected onto the sketch plane
 * and pinned there.  The copy does not follow the model if the model later changes (the source is recorded on
 * the entity as `from`, for when it can).
 */
export function runUse(studio: PartStudio, toolId: string): void {
  const ed = sketchEditor(studio);
  const view = studio.view;
  const pickAt = (ev: PointerEvent): Extract<Pick, { body: string }> | null => {
    view.setFilter(["edge", "vertex"]);
    const p = view.pick(ev);
    view.setFilter(["sketch"]);
    return p && (p.kind === "edge" || p.kind === "vertex") ? p : null;
  };
  let busy = false;
  ed.select([]);
  ed.useTool(toolId, {
    move(ev) { const p = pickAt(ev); view.setSelection(p ? [p] : []); },
    down(ev) {
      const p = pickAt(ev), frame = ed.frame;
      if (!p || !frame || busy) { if (!p) studio.host.toast("Click an edge or a corner of the model. There is nothing there to use.", 2500); return; }
      const ref: GeomRef = { kind: p.kind, body: p.body, name: p.name };
      busy = true;
      void studio.kernel.call("sketch-project", { refs: [ref], frame } as never).then((answer) => {
        busy = false;
        const a = answer as unknown as { curves: Projected[]; skipped: { why: string }[] };
        if (a.skipped.length) studio.host.toast(a.skipped[0].why, 4500);
        if (!a.curves.length || !ed.getState().open) return;
        ed.edit((d) => { drawCurves(d, a.curves); });
      }, (err) => { busy = false; studio.host.toast(String((err && (err as Error).message) || err), 4500); });
    },
    stop() { view.setSelection([]); },
  }, "Click an edge or a corner of the model to draw it in the sketch.");
}

/** Add curves the kernel worked out (Use edge, Intersection) to a sketch, each pinned where it is. */
export function drawCurves(d: Draft, curves: readonly Projected[]): string[] {
  const out: string[] = [];
  for (const c of curves) {
    let id: string;
    if (c.type === "point") id = d.point(c.p);
    else if (c.type === "line") id = d.line(d.point(c.a), d.point(c.b));
    else if (c.type === "circle") id = d.circle(d.point(c.c), c.r);
    else if (c.type === "arc") id = d.arc(d.point(c.c), d.point(c.s), d.point(c.e));
    else if (c.type === "ellipse") { id = d.id("e"); d.set(id, { type: "ellipse", center: d.point(c.c), major: d.point(c.m), minor: c.minor } as SketchEntity); }
    else if (c.type === "ellipticalArc") { id = d.id("e"); d.set(id, { type: "ellipticalArc", center: d.point(c.c), major: d.point(c.m), minor: c.minor, start: d.point(c.s), end: d.point(c.e) } as SketchEntity); }
    else { id = d.id("s"); d.set(id, { type: "spline", points: c.points.map((p) => d.point(p)), ...(c.closed ? { closed: true } : {}) } as SketchEntity); }
    d.set(id, { ...d.data.entities[id], from: c.from });
    d.constrain("fix", [id]);
    out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------- intersection
/**
 * Intersection: click a face of the model and the curves where the sketch plane cuts it are drawn in the
 * sketch, pinned; Shift and a click takes the whole part.  As with Use edge, the curves are a copy.
 */
export function runIntersection(studio: PartStudio, toolId: string): void {
  const ed = sketchEditor(studio);
  const view = studio.view;
  const pickAt = (ev: PointerEvent): Extract<Pick, { body: string }> | null => {
    view.setFilter(["face"]);
    const p = view.pick(ev);
    view.setFilter(["sketch"]);
    return p && p.kind === "face" ? p : null;
  };
  let busy = false;
  ed.select([]);
  ed.useTool(toolId, {
    move(ev) { const p = pickAt(ev); view.setSelection(p ? [p] : []); },
    down(ev) {
      const p = pickAt(ev), frame = ed.frame;
      if (!p || !frame || busy) { if (!p) studio.host.toast("Click a face of the model where the sketch plane cuts it.", 2500); return; }
      const args = ev.shiftKey ? { bodies: [p.body], frame } : { refs: [{ kind: "face", body: p.body, name: p.name }], frame };
      busy = true;
      void studio.kernel.call("sketch-intersect", args as never).then((answer) => {
        busy = false;
        const a = answer as unknown as { curves: Projected[]; skipped: { why: string }[] };
        if (!a.curves.length) { studio.host.toast(a.skipped.length ? a.skipped[0].why : "The sketch plane does not cut that.", 4000); return; }
        if (ed.getState().open) ed.edit((d) => { drawCurves(d, a.curves); });
      }, (err) => { busy = false; studio.host.toast(String((err && (err as Error).message) || err), 4500); });
    },
    stop() { view.setSelection([]); },
  }, "Click a face to draw where the sketch plane cuts it (Shift: the whole part).");
}

// ---------------------------------------------------------------- pierce
/**
 * Pierce: a point of the sketch where an edge of the model (a path, an edge of a part) passes through the
 * sketch plane.  Click the point (or select it first), then the edge.  Like Use edge, the place is worked out
 * when the constraint is made and kept.
 */
export function runPierce(studio: PartStudio, toolId: string): void {
  const ed = sketchEditor(studio);
  const view = studio.view;
  const pre = ed.getState().selection.filter((id) => ed.getState().data.entities[id]?.type === "point");
  let point: string | null = pre[0] || null;
  const hint = () => ed.setHint(point ? "Click the edge of the model that pierces the sketch plane." : "Click a point of the sketch, then an edge of the model that passes through the sketch plane.");
  const pickEdge = (ev: PointerEvent): Extract<Pick, { body: string }> | null => {
    view.setFilter(["edge"]);
    const p = view.pick(ev);
    view.setFilter(["sketch"]);
    return p && p.kind === "edge" ? p : null;
  };
  let busy = false;
  ed.select(point ? [point] : []);
  ed.useTool(toolId, {
    move(ev) {
      if (!point) { const t = ed.hit(ev, { boxes: false, curves: false }); ed.setHover(t ? t.id : null); return; }
      const p = pickEdge(ev); view.setSelection(p ? [p] : []);
    },
    down(ev) {
      if (!point) {
        const t = ed.hit(ev, { boxes: false, curves: false });
        if (t && t.id !== "$origin") { point = t.id; ed.setHover(null); ed.select([point]); hint(); }
        return;
      }
      const p = pickEdge(ev), frame = ed.frame;
      if (!p || !frame || busy) { if (!p) studio.host.toast("Click an edge of the model.", 2500); return; }
      const ref: GeomRef = { kind: "edge", body: p.body, name: p.name };
      busy = true;
      const target = point;
      void studio.kernel.call("sketch-pierce", { ref, frame } as never).then((answer) => {
        busy = false;
        const a = answer as unknown as { points: Vec2[]; why?: string };
        if (!a.points.length) { studio.host.toast(a.why || "That edge does not pass through the sketch plane.", 4000); return; }
        const at = pointAt(ed.getState().data, target) || [0, 0];
        const best = a.points.reduce((x, y) => (Math.hypot(y[0] - at[0], y[1] - at[1]) < Math.hypot(x[0] - at[0], x[1] - at[1]) ? y : x));
        if (ed.edit((d) => { d.constrain("pierce", [target], { x: best[0], y: best[1], from: ref } as never); })) { point = null; ed.select([]); view.setSelection([]); hint(); }
      }, (err) => { busy = false; studio.host.toast(String((err && (err as Error).message) || err), 4500); });
    },
    key(ev) { if (ev.key === "Escape" && point && !pre.length) { point = null; ed.select([]); hint(); return true; } return false; },
    stop() { view.setSelection([]); ed.setHover(null); },
  });
  hint();
}
