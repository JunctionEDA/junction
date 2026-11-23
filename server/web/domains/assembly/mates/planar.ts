// planar.ts — the Planar mate: the second part's connector stays in the first one's plane (at an offset),
// facing the same way; it slides in the plane and turns about the plane's normal.  Those three values can be
// limited, typed and animated.
import { defineMate } from "../core/mate";
import { dot, sub } from "../solver/math";
import type { MateSolve, MateValue } from "../solver/types";
import { ANGLE, OFFSET, alongX, inPlane, limitDefaults, limitFields, placeWith, sameZ } from "./_residuals";

const X: MateValue = { key: "x", label: "Along X", unit: "mm", measure: alongX };
const Y: MateValue = { key: "y", label: "Along Y", unit: "mm", measure: (a, b) => dot(sub(b.o, a.o), a.y) };
const VALUES = [X, Y, ANGLE];

const solve: MateSolve = {
  values: VALUES,
  residuals(a, b, _params, reach, out) { sameZ(a, b, reach, out); inPlane(a, b, out); },
};

export default defineMate({
  type: "planar",
  title: "Planar",
  hint: "The second part slides on a plane and turns about its normal.",
  keywords: "mate joint plane flat coincident slide constrain",
  order: 40,
  icon: '<path class="f" d="M2.5 18l5-7h14l-5 7z"/><path d="M2.5 18l5-7h14l-5 7z"/><path d="M12 14.5V3.5M9.8 5.7L12 3.5l2.2 2.2"/>',
  defaults: () => ({ offset: 0, ...limitDefaults(VALUES) }),
  schema: [OFFSET, ...limitFields(VALUES)],
  freedom: { translation: 2, rotation: 1 },
  place: placeWith(solve),
  solve,
});
