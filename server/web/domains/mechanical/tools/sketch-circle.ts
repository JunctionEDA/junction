// The Circle sketch tool: the centre, then a point on the circle.
import { defineTool } from "../core/tool";
import type { Vec2 } from "../core/geometry";
import { fmt, startTwoPointTool } from "../sketch/drawing";
import { circleEntities } from "../sketch/format";

const ring = (c: Vec2, r: number): Vec2[] => { const out: Vec2[] = []; for (let i = 0; i <= 64; i++) { const t = (i / 64) * Math.PI * 2; out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); } return out; };

export default defineTool({
  id: "sketch-circle", title: "Circle", hint: "Click the centre, then a point on the circle.", group: "sketch", order: 30, key: "c",
  icon: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="1"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-circle",
  run: (studio) => startTwoPointTool(studio, {
    id: "sketch-circle",
    build: (sketch, a, b) => { const r = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]); return r < 1e-9 ? null : { entities: circleEntities(sketch, a.p, Math.round(r * 1e6) / 1e6) }; },
    preview: (a, b) => [ring(a, Math.hypot(b[0] - a[0], b[1] - a[1])), [a, b]],
    readout: (a, b) => `R ${fmt(Math.hypot(b[0] - a[0], b[1] - a[1]))} mm`,
  }),
});
