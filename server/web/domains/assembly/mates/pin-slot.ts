// pin-slot.ts — the Pin slot mate: a pin in a slot.  The second part turns about the connectors' primary axis
// and slides along the first connector's x axis (the slot's direction; "Slot direction" turns it).
import { defineMate } from "../core/mate";
import { dot, sub } from "../solver/math";
import type { MateSolve, MateValue } from "../solver/types";
import { ANGLE, ROTATION, alongX, inPlane, limitDefaults, limitFields, placeWith, sameZ } from "./_residuals";

const TRAVEL: MateValue = { key: "distance", label: "Travel", unit: "mm", measure: alongX };

const solve: MateSolve = {
  values: [TRAVEL, ANGLE],
  residuals(a, b, _params, reach, out) { sameZ(a, b, reach, out); inPlane(a, b, out); out.push(dot(sub(b.o, a.o), a.y)); },
};

export default defineMate({
  type: "pin-slot",
  title: "Pin slot",
  hint: "A pin in a slot: the second part turns about the pin and slides along the slot.",
  keywords: "mate joint slot pin constrain",
  order: 60,
  icon: '<rect x="2.5" y="8" width="19" height="8" rx="4"/><circle class="f" cx="8.5" cy="12" r="2.4"/><circle cx="8.5" cy="12" r="2.4"/><path class="t" d="M13 12h5M16.2 10.2L18 12l-1.8 1.8"/>',
  defaults: () => ({ rotation: 0, ...limitDefaults([TRAVEL, ANGLE]) }),
  schema: [{ ...ROTATION, label: "Slot direction", hint: "Turn the slot's direction about the connector's axis." }, ...limitFields([TRAVEL, ANGLE])],
  freedom: { translation: 1, rotation: 1 },
  place: placeWith(solve),
  solve,
});
