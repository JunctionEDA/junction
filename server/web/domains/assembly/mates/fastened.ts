// fastened.ts — the Fastened mate: the two connectors coincide and nothing moves.  The reference mate: it shows
// the shape of a mate file and is the one `place` that needs no solver.
import { defineMate } from "../core/mate";
import { fromFrame, invert, multiply } from "../core/transform";

export default defineMate({
  type: "fastened",
  title: "Fastened",
  icon: '<rect x="4" y="8" width="7" height="8"/><rect x="13" y="8" width="7" height="8"/><path d="M9 12h6"/>',
  defaults: () => ({}),
  schema: [],
  freedom: { translation: 0, rotation: 0 },
  // b's connector, carried by b, must land on a's: new = A · B⁻¹ · bNow, with A and B the connector frames
  place: (a, b, bNow) => multiply(multiply(fromFrame(a), invert(fromFrame(b))), bNow),
});
