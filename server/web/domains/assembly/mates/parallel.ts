// parallel.ts — the Parallel mate: the connectors' primary axes point the same way; nothing else is held.
import { defineMate } from "../core/mate";
import type { MateSolve } from "../solver/types";
import { placeWith, sameZ } from "./_residuals";

const solve: MateSolve = { residuals(a, b, _params, reach, out) { sameZ(a, b, reach, out); } };

export default defineMate({
  type: "parallel",
  title: "Parallel",
  hint: "Two faces or axes stay parallel; the part is otherwise free.",
  keywords: "mate joint align orientation constrain",
  order: 80,
  icon: '<path class="f" d="M3 8.5l6-4v11l-6 4z"/><path d="M3 8.5l6-4v11l-6 4z"/><path class="t" d="M14.5 8.5l6-4v11l-6 4z"/>',
  defaults: () => ({}),
  schema: [],
  freedom: { translation: 3, rotation: 1 },
  place: placeWith(solve),
  solve,
});
