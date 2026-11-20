// search.ts — how the tool search finds a tool: by its name, or by another word people call it ("cut" finds
// Extrude: remove, "round" finds Fillet).  Pure, so static/tests/cad-fields.test.js can check it; the search box
// itself is in Overlays.tsx and the list it searches comes from commands.ts.

/** What can be searched: anything with a name and, perhaps, other words for it. */
export interface Searchable { title: string; keywords?: string }

/** The other words people look for a feature or a tool by (the tool search), by its id. */
export const KEYWORDS: { [id: string]: string } = {
  "f:sketch": "draw profile 2d",
  "f:extrude": "pull pad boss protrude extend solid",
  "f:revolve": "turn lathe spin rotate",
  "f:sweep": "path pipe follow",
  "f:loft": "blend transition between profiles",
  "f:fillet": "round blend radius edge",
  "f:chamfer": "bevel break edge",
  "f:draft": "taper angle mould mold",
  "f:shell": "hollow wall thickness",
  "f:hole": "drill bore counterbore countersink tapped thread",
  "f:boolean": "union join merge subtract cut intersect combine",
  "f:split": "divide cut in two slice",
  "f:delete-body": "remove part delete",
  "f:transform": "move rotate translate copy",
  "f:linear-pattern": "array repeat copy grid",
  "f:circular-pattern": "array repeat polar radial",
  "f:mirror": "reflect symmetric copy",
  "f:plane": "datum offset workplane reference",
  "f:axis": "datum centreline reference",
  "f:point": "datum reference",
  "f:helix": "spiral coil spring thread",
  "f:board-reference": "pcb circuit electronics",
  "f:board-cutout": "pcb cutout connector hole",
  "f:board-standoffs": "pcb posts mounting bosses",
  "sketch-line": "segment polyline",
  "sketch-rectangle": "corner box square",
  "sketch-center-rectangle": "center box square",
  "sketch-circle": "round hole",
  "sketch-arc-3point": "three point curve",
  "sketch-arc-center": "center point curve",
  "sketch-arc-tangent": "curve",
  "sketch-slot": "obround oblong",
  "sketch-point": "vertex dot hole centre",
  "sketch-construction": "reference helper centreline dashed",
  "sketch-fillet": "round corner radius",
  "sketch-trim": "cut remove erase",
  "sketch-extend": "lengthen",
  "sketch-offset": "parallel copy inset",
  "sketch-mirror": "reflect symmetric copy",
  "sketch-use": "project convert edge silhouette",
  "sketch-dimension": "smart size distance length radius diameter angle",
  "sketch-coincident": "constraint relation join on",
  "sketch-horizontal": "constraint relation level",
  "sketch-vertical": "constraint relation upright",
  "sketch-parallel": "constraint relation",
  "sketch-perpendicular": "constraint relation square normal",
  "sketch-tangent": "constraint relation smooth",
  "sketch-equal": "constraint relation same length radius",
  "sketch-midpoint": "constraint relation middle centre",
  "sketch-concentric": "constraint relation same centre",
  "sketch-collinear": "constraint relation in line",
  "sketch-symmetric": "constraint relation mirror",
  "sketch-fix": "constraint relation lock anchor ground",
  "sketch-finish": "done accept close exit",
  "sketch-aligned-rectangle": "rotated angled box square three point",
  "sketch-circle-3point": "three point round",
  "sketch-polygon": "inscribed hexagon pentagon octagon regular sides",
  "sketch-polygon-circumscribed": "hexagon pentagon octagon regular sides",
  "sketch-ellipse": "oval elliptical",
  "sketch-partial-ellipse": "elliptical arc oval",
  "sketch-conic": "rho parabola hyperbola curve",
  "sketch-spline": "curve interpolate fit freeform handles nurbs",
  "sketch-control-spline": "curve control points bspline nurbs freeform",
  "sketch-bezier": "curve bezier control points freeform",
  "sketch-text": "font letters lettering engrave emboss",
  "sketch-image": "picture photo trace reference insert canvas",
  "sketch-intersection": "section slice plane",
  "sketch-split": "break divide",
  "sketch-linear-pattern": "array repeat copy row",
  "sketch-circular-pattern": "array repeat copy polar radial",
  "sketch-transform": "move translate rotate copy",
  "sketch-normal": "constraint relation perpendicular square",
  "sketch-curvature": "constraint relation g2 continuity smooth",
  "sketch-pierce": "constraint relation path through plane",
  measure: "distance length angle radius area",
  "section-view": "cross-section cut view slice",
  comment: "note annotate review",
  "toggle-planes": "hide show default planes origin",
  "appearance-view-mode": "shaded wireframe hidden line edges render",
  "appearance-projection": "orthographic parallel perspective camera",
  "appearance-hide": "invisible",
  "appearance-isolate": "only solo",
  history: "versions branches compare restore",
  import: "open upload step stp iges stl file",
  export: "save download step stp stl iges 3mf file",
  delete: "remove erase",
  undo: "back", redo: "again forward",
};
/** What a feature's result choices are also called, for "cut", "boss", "pocket" in the tool search. */
export const RESULT_WORDS: { [value: string]: string } = { add: "boss pad join", remove: "cut pocket subtract", intersect: "common keep shared", subtract: "cut difference", union: "join merge add" };

/**
 * How well `q` finds an entry: lower is better; -1 is no match.  Its name counts most (the start of the name,
 * then the start of a word of it), then the other words it is known by ("cut" finds Extrude: remove), then
 * those letters anywhere in the name, then the first letters of its words.
 */
export function matchScore(title: string, q: string, keywords = ""): number {
  const t = title.toLowerCase(), s = q.trim().toLowerCase();
  if (!s) return 0;
  if (t.startsWith(s)) return 0;
  const word = t.split(/[\s:-]+/).findIndex((w) => w.startsWith(s));
  if (word >= 0) return 1 + word;
  const known = keywords.toLowerCase().split(/\s+/).filter(Boolean);
  if (known.includes(s)) return 5;
  if (s.length >= 2 && known.some((w) => w.startsWith(s))) return 7;
  const at = t.indexOf(s);
  if (at >= 0) return 10 + at;
  // the first letters of its words: "cr" finds Centre rectangle
  return s.length >= 2 && t.split(/[\s:-]+/).map((w) => w[0] || "").join("").startsWith(s) ? 50 : -1;
}
/**
 * The entries `q` finds, best first; the keyword that found one (when its name did not) comes with it.  Letters
 * found only in the middle of a name ("cut" in Keyboard shortcuts) count when nothing is found any better way.
 */
export function searchCommands<E extends Searchable>(all: readonly E[], q: string, limit = 12): { entry: E; by: string | null }[] {
  const s = q.trim().toLowerCase();
  let found = all.map((entry, i) => ({ entry, i, score: matchScore(entry.title, q, entry.keywords) })).filter((x) => x.score >= 0);
  if (s && found.some((x) => x.score < 10)) found = found.filter((x) => x.score < 10);
  return found.sort((a, b) => a.score - b.score || a.i - b.i).slice(0, s ? limit : 80)
    .map((x) => ({ entry: x.entry, by: s && (x.score === 5 || x.score === 7) ? (x.entry.keywords || "").split(/\s+/).find((w) => w.toLowerCase().startsWith(s)) || null : null }));
}
