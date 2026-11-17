// The Rectangle sketch tool: two opposite corners, by two clicks or one drag.
import { defineTool } from "../core/tool";
import { fmt, startTwoPointTool } from "../sketch/drawing";
import { rectangleEntities } from "../sketch/format";

export default defineTool({
  id: "sketch-rectangle", title: "Rectangle", hint: "Click two opposite corners, or drag.", group: "sketch", order: 20, key: "r",
  icon: '<rect x="4" y="7" width="16" height="10"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-rectangle",
  run: (studio) => startTwoPointTool(studio, {
    id: "sketch-rectangle",
    build: (sketch, a, b) => (Math.abs(b.p[0] - a.p[0]) < 1e-9 || Math.abs(b.p[1] - a.p[1]) < 1e-9 ? null : { entities: rectangleEntities(sketch, a.p, b.p) }),
    preview: (a, b) => [[a, [b[0], a[1]], b, [a[0], b[1]], a]],
    readout: (a, b) => `${fmt(Math.abs(b[0] - a[0]))} × ${fmt(Math.abs(b[1] - a[1]))} mm`,
  }),
});
