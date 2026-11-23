// cylindrical.ts — the Cylindrical mate: a shaft in a hole.  The axes line up; the second part slides along
// the axis and turns about it.
import { defineMate } from "../core/mate";
import type { MateSolve } from "../solver/types";
import { ANGLE, DISTANCE, limitDefaults, limitFields, onAxis, placeWith, sameZ } from "./_residuals";

const solve: MateSolve = {
  values: [DISTANCE, ANGLE],
  residuals(a, b, _params, reach, out) { sameZ(a, b, reach, out); onAxis(a, b, out); },
};

export default defineMate({
  type: "cylindrical",
  title: "Cylindrical",
  hint: "The second part slides along an axis and turns about it: a shaft in a hole.",
  keywords: "mate joint axis concentric shaft sleeve hole constrain",
  order: 50,
  icon: '<path class="f" d="M7 7.5v10a5 2.2 0 0 0 10 0v-10z"/><path d="M7 7.5v10a5 2.2 0 0 0 10 0v-10"/><ellipse cx="12" cy="7.5" rx="5" ry="2.2"/><path d="M12 1.5v6M10 3.5l2-2 2 2"/>',
  defaults: () => limitDefaults([DISTANCE, ANGLE]),
  schema: limitFields([DISTANCE, ANGLE]),
  freedom: { translation: 1, rotation: 1 },
  place: placeWith(solve),
  solve,
});
