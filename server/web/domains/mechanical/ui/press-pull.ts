// press-pull.ts — one tool for the commonest edits, chosen by what it is pointed at (Q): a flat face or a
// sketch region is extruded, a curved face is offset, an edge is rounded.  Pure: what a pick means.  The tool
// (tools/press-pull.ts) starts the feature, whose dialog then holds the pick and is an ordinary feature dialog.

/** The little of a pick this needs to know (viewport/modelview.ts Pick). */
export interface PulledPick { kind: string; region?: string | null; entity?: string | null }
export type Pull =
  | { feature: string; /** parameters the new feature starts with, over its defaults */ params?: { [key: string]: unknown }; says: string }
  | { why: string };

export const PRESS_PULL_HINT = "Press/Pull: click a face, an edge or a sketch region.";

/** What Press/Pull does with a pick.  `flat`: the face is planar.  `has(type)`: the feature exists in this build. */
export function pullFor(pick: PulledPick, flat: boolean, has: (type: string) => boolean = () => true): Pull {
  if (pick.kind === "face") {
    if (flat) return { feature: "extrude", says: "Extrude this face: drag or type how far." };
    if (has("move-face")) return { feature: "move-face", params: { type: "offset" }, says: "Offset this face." };
    return { why: "A curved face cannot be pulled here." };
  }
  if (pick.kind === "edge") return { feature: "fillet", says: "Round this edge: type the radius." };
  if (pick.kind === "sketch") return pick.region || !pick.entity ? { feature: "extrude", says: "Extrude this sketch." } : { why: "Click inside a closed region of the sketch, not on a curve." };
  if (pick.kind === "vertex") return { why: "Press/Pull takes a face, an edge or a sketch region, not a corner." };
  return { why: "Press/Pull takes a face, an edge or a sketch region." };
}
