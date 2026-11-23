// revolute.ts — the Revolute mate: a hinge.  The connectors' origins coincide and their primary axes line up;
// the second part turns about that axis.  The angle can be limited, dragged and animated.
//
// The shape of a mate file: `solve.residuals` says when the mate holds, `solve.values` names what it leaves
// free, and the schema lists the dialog's fields.  The solver does the rest (solver/solver.ts).
import { defineMate } from "../core/mate";
import type { MateSolve } from "../solver/types";
import { ANGLE, OFFSET, coincident, limitDefaults, limitFields, placeWith, sameZ } from "./_residuals";

const solve: MateSolve = {
  values: [ANGLE],
  residuals(a, b, _params, reach, out) { coincident(a, b, out); sameZ(a, b, reach, out); },
};

export default defineMate({
  type: "revolute",
  title: "Revolute",
  hint: "A hinge: the second part turns about one axis.",
  keywords: "mate joint hinge pivot rotate turn axle pin constrain",
  order: 20,
  icon: '<circle class="f" cx="12" cy="13.5" r="3"/><circle cx="12" cy="13.5" r="3"/><path d="M12 2.5v8"/><path d="M5.6 9.6a7.5 7.5 0 1 0 12.8 0"/><path d="M15.6 9.2l2.9.3.5-2.8"/>',
  defaults: () => ({ offset: 0, ...limitDefaults([ANGLE]) }),
  schema: [OFFSET, ...limitFields([ANGLE])],
  freedom: { translation: 0, rotation: 1 },
  place: placeWith(solve),
  solve,
});
