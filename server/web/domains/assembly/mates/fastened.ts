// fastened.ts — the Fastened mate: the two connectors coincide and nothing moves.  The solver welds the two
// instances into one rigid body (`rigid`), so a fastened part costs it nothing.
import { defineMate } from "../core/mate";
import { fromFrame, invert, multiply } from "../core/transform";
import type { MateSolve } from "../solver/types";
import { OFFSET, ROTATION, coincident, sameX, sameZ } from "./_residuals";

const solve: MateSolve = {
  rigid: true,
  residuals(a, b, _params, reach, out) { coincident(a, b, out); sameZ(a, b, reach, out); sameX(a, b, reach, out); },
};

export default defineMate({
  type: "fastened",
  title: "Fastened",
  hint: "Fix two parts to each other: nothing moves between them.",
  keywords: "mate joint rigid weld glue lock constrain fix bond fasten attach",
  order: 10,
  icon: '<rect class="f" x="2.5" y="7" width="8.5" height="10" rx="1"/><rect x="2.5" y="7" width="8.5" height="10" rx="1"/><rect class="t" x="13" y="7" width="8.5" height="10" rx="1"/><path d="M11 10h2M11 14h2"/>',
  defaults: () => ({ offset: 0, rotation: 0 }),
  schema: [OFFSET, ROTATION],
  freedom: { translation: 0, rotation: 0 },
  // b's connector, carried by b, must land on a's: new = A · B⁻¹ · bNow, with A and B the connector frames
  place: (a, b, bNow) => multiply(multiply(fromFrame(a), invert(fromFrame(b))), bNow),
  solve,
});
