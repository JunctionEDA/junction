// ball.ts — the Ball mate: a ball joint.  The connectors' origins coincide; the second part turns freely.
import { defineMate } from "../core/mate";
import type { MateSolve } from "../solver/types";
import { coincident, placeWith } from "./_residuals";

const solve: MateSolve = { residuals(a, b, _params, _reach, out) { coincident(a, b, out); } };

export default defineMate({
  type: "ball",
  title: "Ball",
  hint: "A ball in a socket: the second part turns any way about one point.",
  keywords: "mate joint spherical socket constrain",
  order: 70,
  icon: '<circle class="f" cx="12" cy="9.5" r="5"/><circle cx="12" cy="9.5" r="5"/><path d="M4.5 11a7.5 7.5 0 0 0 15 0"/><path d="M12 18.5v3.5"/>',
  defaults: () => ({}),
  schema: [],
  freedom: { translation: 0, rotation: 3 },
  place: placeWith(solve),
  solve,
});
