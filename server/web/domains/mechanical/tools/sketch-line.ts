// The Line sketch tool: click, click; each line starts where the last ended until Esc.
import { defineTool } from "../core/tool";
import { fmt, startTwoPointTool } from "../sketch/drawing";
import { lineEntities } from "../sketch/format";

export default defineTool({
  id: "sketch-line", title: "Line", hint: "Click two points. Esc ends the chain.", group: "sketch", order: 10, key: "l",
  icon: '<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-line",
  run: (studio) => startTwoPointTool(studio, {
    id: "sketch-line",
    build: (sketch, a, b) => {
      if (Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]) < 1e-9) return null;
      const made = lineEntities(sketch, a.p, b.p, { a: a.id, b: b.id });
      return { entities: made.entities, next: { p: b.p, id: made.b } };
    },
    preview: (a, b) => [[a, b]],
    readout: (a, b) => `${fmt(Math.hypot(b[0] - a[0], b[1] - a[1]))} mm`,
  }),
});
