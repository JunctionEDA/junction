// width.ts — the Width mate: a tab centred in a slot.  Each side is two faces of one part (the two walls of the
// slot; the two flanks of the tab); the plane half-way between the tab's flanks lies in the plane half-way
// between the slot's walls.  The tab still slides along the slot and turns in that plane, as with Planar.
//
// Its connectors carry a second face each (`ref2` on a mate end, document/format.ts); model/problem.ts makes the
// middle frame of the two, so here it is the Planar condition between two middle planes.
import { defineMate } from "../core/mate";
import type { MateSolve } from "../solver/types";
import { cross } from "../solver/math";
import { inPlane, placeWith } from "./_residuals";

const solve: MateSolve = {
  check(a, b) { return a.surface === "plane" && b.surface === "plane" ? null : "Width needs two flat faces on each part: the two walls of the slot, then the two sides of the tab."; },
  // a middle plane has no front or back: the two normals are along one line, either way round
  residuals(a, b, _params, reach, out) { const c = cross(a.z, b.z); out.push(reach * c[0], reach * c[1], reach * c[2]); inPlane(a, b, out); },
};

export default defineMate({
  type: "width",
  title: "Width",
  hint: "Centre a tab between the two walls of a slot: two faces on each part.",
  keywords: "mate joint centre center symmetric middle tab slot constrain",
  order: 95,
  pairs: true,
  icon: '<path d="M4 5v14"/><path d="M20 5v14"/><rect class="f" x="9" y="8" width="6" height="8"/><path class="t" d="M4 12h5M15 12h5"/>',
  defaults: () => ({}),
  schema: [],
  freedom: { translation: 2, rotation: 1 },
  place: placeWith(solve),
  solve,
});
