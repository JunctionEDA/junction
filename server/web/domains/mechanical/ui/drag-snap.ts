// drag-snap.ts — the values a number dragged in the model stops at.
//
// A dragged length goes by steps a person would type: 1, 2 or 5 of a round size (… 0.1, 0.2, 0.5, 1, 2, 5, 10 …),
// the largest that is still no more than about fourteen pixels of travel, so that zoomed out it goes by tens and
// zoomed in by tenths.  Whole tens of that step (10 where the step is 1) hold on a little longer: the common
// values are the easy ones to stop at.  Everything here is in the unit the document is shown in.

/** How far the pointer travels for one step, at most (CSS px). */
export const STEP_PIXELS = 14;
/** How near a whole ten of the step the value must be to stop there (in steps). */
const HOLD = 0.9;

/** The step for a view where one pixel is `perPixel` long: the largest of 1, 2, 5 × 10ⁿ within STEP_PIXELS of travel. */
export function snapStep(perPixel: number, places = 3): number {
  const finest = Math.pow(10, -places);
  const most = perPixel * STEP_PIXELS;
  if (!(most > finest)) return finest;
  const decade = Math.pow(10, Math.floor(Math.log10(most)));
  const m = most / decade;
  const step = (m >= 5 ? 5 : m >= 2 ? 2 : 1) * decade;
  return Math.max(finest, round(step, places));
}

const round = (v: number, places: number): number => { const k = Math.pow(10, Math.min(9, places + 3)); return Math.round(v * k) / k; };

/**
 * A dragged length, stopped at a step.  Never less than one step (a depth of nothing is no depth).  `free`
 * (Alt held) rounds to the places the document shows and no further.
 */
export function snapLength(value: number, perPixel: number, o: { free?: boolean; places?: number } = {}): number {
  const places = o.places ?? 3, finest = Math.pow(10, -places);
  if (o.free) return Math.max(finest, round(Math.round(value / finest) * finest, places));
  const step = snapStep(perPixel, places);
  // a step of 1, 2 or 5: the round values ten 1-steps apart (10 for 1 and 2, 50 for 5) hold on
  const big = step * (round(step / Math.pow(10, Math.floor(Math.log10(step) + 1e-9)), 3) === 2 ? 5 : 10);
  const nearBig = Math.round(value / big) * big;
  if (nearBig > 0 && Math.abs(value - nearBig) <= HOLD * step) return round(nearBig, places);
  return Math.max(step, round(Math.round(value / step) * step, places));
}
