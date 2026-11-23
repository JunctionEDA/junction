// slider.ts — the Slider mate: the second part slides along the connectors' common axis and does not turn.
import { defineMate } from "../core/mate";
import type { MateSolve } from "../solver/types";
import { DISTANCE, ROTATION, limitDefaults, limitFields, onAxis, placeWith, sameX, sameZ } from "./_residuals";

const solve: MateSolve = {
  values: [DISTANCE],
  residuals(a, b, _params, reach, out) { sameZ(a, b, reach, out); sameX(a, b, reach, out); onAxis(a, b, out); },
};

export default defineMate({
  type: "slider",
  title: "Slider",
  hint: "The second part slides along one axis and does not turn.",
  keywords: "mate joint prismatic slide rail linear guide constrain",
  order: 30,
  icon: '<path d="M2.5 17h19"/><rect class="f" x="8" y="9.5" width="8" height="7.5" rx="1"/><rect x="8" y="9.5" width="8" height="7.5" rx="1"/><path d="M3 5.5h18M5.5 3.3L3 5.5l2.5 2.2M18.5 3.3L21 5.5l-2.5 2.2"/>',
  defaults: () => ({ rotation: 0, ...limitDefaults([DISTANCE]) }),
  schema: [ROTATION, ...limitFields([DISTANCE])],
  freedom: { translation: 1, rotation: 0 },
  place: placeWith(solve),
  solve,
});
