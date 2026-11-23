// Junction Feature API, version 1.
//
// A custom feature is one JavaScript file that calls `feature({...})` once.  It runs in a sandbox: there is no
// network, no DOM, no timers, no `Date`, and `Math.random()` gives the same numbers on every run.  Everything
// it can do to the model is on the `ctx` object its `evaluate` is handed, and all the 2D work is in `Geo2`.
//
// Units: lengths are millimetres, angles degrees, 3D points are [x, y, z], 2D points are [x, y].
// This file is the single description of the API: the editor's completion, the documentation and the
// assistant all read it.

// ------------------------------------------------------------------ declaring the feature

/** Declare the feature.  Call it once, at the top level of the script. */
declare function feature(def: FeatureDef): void;

interface FeatureDef {
  /** The name people see: the toolbar entry, and the stem of a new feature's name ("Lighten plate 1"). */
  title: string;
  /** One line on what it does, for the tooltip and the tool search. */
  description?: string;
  /** A named icon, or your own outline as SVG path data in a 24 × 24 box (drawn as a thin line). */
  icon?: IconName | { path: string };
  /** The parameters, in the order the dialog shows them.  The key is the name `evaluate` reads the value by. */
  params: { [key: string]: Param };
  /**
   * Build the feature.  `p` holds one value per parameter (see each parameter type for what it is).
   * Must not be async.  Throwing `ctx.fail("…")` fails the feature with that sentence and leaves the model as it was.
   */
  evaluate(ctx: Context, p: { [key: string]: any }): void;
}

type IconName = "pockets" | "truss" | "isogrid" | "hex" | "slot" | "bracket" | "vent" | "text" | "plate" | "hole" | "gear" | "rib" | "frame" | "wave" | "star" | "cube";

type Param = LengthParam | AngleParam | NumberParam | IntegerParam | BooleanParam | EnumParam | TextParam | PickParam;

interface ParamBase {
  /** The field's label in the dialog. */
  label: string;
  /** A line of help under the label. */
  hint?: string;
  /**
   * Show the field only while other parameters have these values: `{ through: false }`,
   * `{ pattern: ["truss", "hex"] }`.  A hidden field keeps its value.
   */
  show?: { [otherKey: string]: boolean | string | string[] };
}
/** A length in mm.  `evaluate` gets a number.  People may type units and expressions ("1/4 in", "#wall * 2"). */
interface LengthParam extends ParamBase { type: "length"; default: number; min?: number; max?: number; step?: number }
/** An angle in degrees.  `evaluate` gets a number. */
interface AngleParam extends ParamBase { type: "angle"; default: number; min?: number; max?: number; step?: number }
/** A number without a unit.  `evaluate` gets a number. */
interface NumberParam extends ParamBase { type: "number"; default: number; min?: number; max?: number; step?: number }
/** A whole number.  `evaluate` gets an integer. */
interface IntegerParam extends ParamBase { type: "integer"; default: number; min?: number; max?: number }
/** A checkbox.  `evaluate` gets true or false. */
interface BooleanParam extends ParamBase { type: "boolean"; default: boolean }
/** One of a few choices: `options: { truss: "Truss", hex: "Hexagons" }`.  `evaluate` gets the key. */
interface EnumParam extends ParamBase { type: "enum"; options: { [value: string]: string }; default: string }
/** A line of text.  `evaluate` gets a string. */
interface TextParam extends ParamBase { type: "text"; default: string }
/**
 * Something the person picks in the model.  `evaluate` gets:
 *   "face" → Face | null        "faces" → Face[]
 *   "edge" → Edge | null        "edges" → Edge[]
 *   "body" → Body | null        "bodies" → Body[]   (empty when nothing was picked)
 *   "sketch" → Sketch | null    (a sketch made earlier, with the regions the person chose)
 * Nothing is picked in a new feature: say what to pick with `ctx.fail("Pick the face to pocket.")`, or fall
 * back to a sensible guess (the largest flat face of the only body).
 */
interface PickParam extends ParamBase { type: "face" | "faces" | "edge" | "edges" | "body" | "bodies" | "sketch" }

// ------------------------------------------------------------------ the context

type Vec3 = [number, number, number];
type Pt = [number, number];

/** A plane to build on: a point of it, its x and y directions, and its normal (x × y). */
interface Plane { origin: Vec3; x: Vec3; y: Vec3; normal: Vec3 }
interface Box3 { min: Vec3; max: Vec3; size: Vec3; centre: Vec3 }

interface Context {
  /** This feature in the feature list. */
  readonly feature: { id: string; name: string };

  // --- query
  /** The solid parts as they are now, in the order they were made. */
  bodies(): Body[];
  /** The only part, or the first when there are several; fails with a sentence when there is none. */
  body(): Body;
  /** A default plane: "top" is XY (normal +Z), "front" is XZ (normal −Y), "right" is YZ (normal +X). */
  plane(name: "top" | "front" | "right"): Plane;
  /** A plane through `origin` with this normal (and, when it matters, this x direction). */
  planeAt(origin: Vec3, normal: Vec3, x?: Vec3): Plane;

  // --- build
  /**
   * A new part: the 2D shape, drawn in the plane's coordinates, pulled `height` along the plane's normal
   * (negative: the other way).  `offset` starts it that far along the normal; `both` pulls it both ways.
   * On a Face the plane is the face's own (`face.plane`), whose normal points out of the part.
   */
  extrude(shape: Shape2, on: Plane | Face, opts: { height: number; offset?: number; both?: boolean }): Body;
  /** Join `tools` onto `target`.  The tools are used up. */
  union(target: Body, ...tools: Body[]): Body;
  /** Cut `tools` out of `target`.  The tools are used up. */
  subtract(target: Body, ...tools: Body[]): Body;
  /** Keep only what `target` and `tool` share.  The tool is used up. */
  intersect(target: Body, tool: Body): Body;
  /** Copies of a part stepped along a direction: `count` parts in all, `spacing` apart.  Returns the copies (not the original). */
  linearPattern(body: Body, direction: Vec3, count: number, spacing: number): Body[];
  /** Copies of a part turned about an axis: `count` parts in all over `angle` degrees (360 by default).  Returns the copies. */
  circularPattern(body: Body, origin: Vec3, axis: Vec3, count: number, angle?: number): Body[];

  // --- results
  /** Fail the feature with a sentence the person can act on: `throw ctx.fail("Pick a flat face.")`. */
  fail(message: string): Error;
  /** Leave a note on the feature without failing it. */
  warn(message: string): void;
  /** A result worth showing: `ctx.report("Mass saved", "31 %")`.  Shown with the feature and returned to whoever ran the script. */
  report(label: string, value: string | number): void;
  /** Console output, for working on the script. `console.log` does the same. */
  log(...args: any[]): void;
  /**
   * Put a drag arrow in the model for a length parameter while the feature's dialog is open: it stands at
   * `origin + direction × value` and dragging it changes the parameter.
   */
  handle(param: string, origin: Vec3, direction: Vec3): void;
}

// ------------------------------------------------------------------ bodies, faces, edges

interface Body {
  /** Stable across rebuilds. */
  readonly id: string;
  readonly name: string;
  /** mm³ */
  readonly volume: number;
  /** mm² */
  readonly area: number;
  /** The centre of mass. */
  readonly centre: Vec3;
  readonly bounds: Box3;
  /** The mass in grams for a density in g/cm³ (aluminium 2.70, steel 7.85, PLA 1.24). */
  mass(density: number): number;

  /** The faces, largest first.  A filter narrows them. */
  faces(filter?: FaceFilter): Face[];
  /** The largest face that passes the filter, or null. */
  face(filter?: FaceFilter): Face | null;
  edges(filter?: EdgeFilter): Edge[];
  /** Round holes: cylindrical faces that look inwards, each hole once (a hole made of two half cylinders is one hole). */
  holes(filter?: { minDiameter?: number; maxDiameter?: number }): Hole[];

  /** Round edges of this part. */
  fillet(edges: Edge[], radius: number): Body;
  /** Bevel edges of this part. */
  chamfer(edges: Edge[], distance: number): Body;
  /** Hollow the part to walls of `thickness`, with the `open` faces removed. */
  shell(thickness: number, open: Face[]): Body;
  /** A copy as a new part. */
  copy(): Body;
  /** Move the part. */
  translate(by: Vec3): Body;
  /** Turn the part `angle` degrees about the axis through `origin` along `axis`. */
  rotate(origin: Vec3, axis: Vec3, angle: number): Body;
  /** Mirror the part in a plane. */
  mirror(plane: Plane): Body;
  /** Take the part out of the model. */
  remove(): void;
}

interface FaceFilter {
  kind?: "plane" | "cylinder" | "cone" | "sphere" | "torus" | "other";
  /** Flat faces whose outward normal is this direction (within `tolerance` degrees, 1 by default). */
  normal?: Vec3;
  /** Flat faces parallel to this direction's plane either way round: normal or its opposite. */
  parallelTo?: Vec3;
  tolerance?: number;
  minArea?: number;
  maxArea?: number;
}
interface EdgeFilter {
  kind?: "line" | "circle" | "ellipse" | "spline" | "other";
  /** Straight edges along this direction (either way, within `tolerance` degrees, 1 by default). */
  parallelTo?: Vec3;
  tolerance?: number;
  minLength?: number;
  maxLength?: number;
}

interface Face {
  /** The face's stable name: later features and the next rebuild find it by this. */
  readonly id: string;
  readonly body: Body;
  readonly kind: "plane" | "cylinder" | "cone" | "sphere" | "torus" | "other";
  readonly area: number;
  readonly centre: Vec3;
  /** A flat face's normal, pointing out of the part; null on a curved face. */
  readonly normal: Vec3 | null;
  /** A flat face's plane (its normal points out of the part); null on a curved face.  2D shapes for `cut`, `add` and `outline` are in its x, y. */
  readonly plane: Plane | null;
  /** A cylinder's or sphere's radius; otherwise null. */
  readonly radius: number | null;
  /** A cylinder's axis; otherwise null. */
  readonly axis: { origin: Vec3; direction: Vec3 } | null;

  /** The flat face as a 2D region in its own plane: the outer boundary and its openings, arcs kept as arcs. */
  outline(): Region;
  /** The round openings of a flat face (drilled holes seen from this side), in the face's 2D coordinates. */
  holes(): FaceHole[];
  edges(): Edge[];
  /** The faces that share an edge with this one. */
  neighbours(): Face[];
  /** A 2D point of the face's plane in the model; `height` lifts it along the normal. */
  toWorld(p: Pt, height?: number): Vec3;
  /** A model point dropped onto the face's plane, in its 2D coordinates. */
  toLocal(p: Vec3): Pt;

  /**
   * Cut a 2D shape (in this face's plane) into the part: `{ depth }` mm deep, or `{ through: true }` right
   * through it.  All the regions are cut in one operation.  Arcs in the shape become cylindrical walls.
   */
  cut(shape: Shape2, opts: { depth: number } | { through: true }): Body;
  /** Raise a 2D shape (in this face's plane) from the face by `height`, joined to the part. */
  add(shape: Shape2, opts: { height: number }): Body;
  /** Drill round holes at 2D points of the face. */
  hole(at: Pt | Pt[], opts: { diameter: number; depth?: number; through?: boolean }): Body;
  /** Give the face a name of your own.  It becomes `<feature id>:<label>`, the same on every rebuild. */
  label(label: string): void;
}

interface FaceHole {
  /** In the face's 2D coordinates. */
  centre: Pt;
  diameter: number;
  /** The same centre in the model. */
  centre3: Vec3;
}

interface Hole {
  /** The middle of the hole's axis. */
  centre: Vec3;
  axis: Vec3;
  diameter: number;
  depth: number;
  faces: Face[];
}

interface Edge {
  readonly id: string;
  readonly body: Body;
  readonly kind: "line" | "circle" | "ellipse" | "spline" | "other";
  readonly length: number;
  readonly mid: Vec3;
  /** The ends; null for a closed edge (a full circle). */
  readonly start: Vec3 | null;
  readonly end: Vec3 | null;
  /** A straight edge's direction. */
  readonly direction: Vec3 | null;
  /** A circular edge's centre and radius. */
  readonly centre: Vec3 | null;
  readonly radius: number | null;
  /** The faces that meet at this edge. */
  faces(): Face[];
}

/** A sketch made earlier in the feature list, as picked in a "sketch" parameter. */
interface Sketch {
  /** The sketch's plane. */
  plane: Plane;
  /** The closed regions the person chose (all of them when none was singled out), in the plane's 2D coordinates. */
  regions: Region[];
}

// ------------------------------------------------------------------ 2D geometry

/**
 * A closed loop of 2D points.  A third number on a point is the bulge of the edge from it to the next point:
 * 0 or absent is a straight edge, 1 is a half circle turning counter-clockwise, -1 one turning clockwise,
 * tan(angle / 4) in general (as in DXF).
 * You rarely write bulges yourself: `Geo2.circle`, `Geo2.slot`, `Geo2.round` and `face.outline()` make them,
 * and the polygons that offsets and booleans return are read back into arcs when a solid is built from them.
 */
type Loop = ([number, number] | [number, number, number])[];
/** An outer loop (counter-clockwise) and the holes in it. */
interface Region { outer: Loop; holes: Loop[] }
/** Anything the 2D functions and the builders take: one loop, one region, or a list of either. */
type Shape2 = Loop | Region | (Loop | Region)[];

declare const Geo2: {
  // --- shapes
  rect(x: number, y: number, width: number, height: number): Loop;
  circle(centre: Pt, radius: number): Loop;
  /** A regular polygon: `radius` to its corners, the first corner at `angle` degrees. */
  ngon(centre: Pt, radius: number, sides: number, angle?: number): Loop;
  /** The shape a round cutter of `width` leaves going from `a` to `b`. */
  slot(a: Pt, b: Pt, width: number): Loop;
  /** Line segments, each [[x1, y1], [x2, y2]], given a width with round ends and merged: ribs along the edges of a triangulation. */
  thicken(segments: number[][][], width: number): Region[];
  /** Text outlines.  `size` is the height of a capital letter, `at` the start of the baseline. */
  text(text: string, opts: { size: number; at?: Pt; angle?: number; align?: "left" | "centre" | "right" }): Region[];

  // --- combine
  /** Merge shapes into clean regions (overlaps joined). */
  union(a: Shape2, b?: Shape2): Region[];
  /** `a` with `b` cut out. */
  difference(a: Shape2, b: Shape2): Region[];
  /** What `a` and `b` share. */
  intersection(a: Shape2, b: Shape2): Region[];
  /** Grow (distance > 0) or shrink (< 0).  Outside corners are made round unless `join` says "miter" or "square". */
  offset(shape: Shape2, distance: number, join?: "round" | "miter" | "square"): Region[];
  /**
   * Round the corners that point outwards with `radius`: what a cutter of that radius leaves in a pocket.
   * Parts narrower than twice the radius disappear.  `reflex` also rounds the corners that point inwards.
   */
  round(shape: Shape2, radius: number, reflex?: number): Region[];
  translate(shape: Shape2, by: Pt): Region[];
  rotate(shape: Shape2, angle: number, about?: Pt): Region[];
  scale(shape: Shape2, factor: number, about?: Pt): Region[];
  /** Mirror in the line through two points. */
  mirror(shape: Shape2, a: Pt, b: Pt): Region[];

  // --- measure
  /** mm², holes taken off. */
  area(shape: Shape2): number;
  bounds(shape: Shape2): { min: Pt; max: Pt; size: Pt; centre: Pt };
  centroid(shape: Shape2): Pt;
  /** Whether the point is in the shape's material (not in a hole). */
  contains(shape: Shape2, p: Pt): boolean;
  /** From a point to the nearest edge of the shape. */
  distance(shape: Shape2, p: Pt): number;
  /** The smallest gap between two shapes; 0 when they touch or overlap. */
  clearance(a: Shape2, b: Shape2): number;

  // --- patterns
  /**
   * The cells of a regular pattern covering the box round `within`:
   *   "tri"     equilateral triangles of side `pitch` (an isogrid)
   *   "hex"     hexagons `pitch` across flats
   *   "square"  squares of side `pitch`;  "diamond"  the same turned 45°
   * `inset` shrinks every cell by that much on each side, leaving walls 2 × inset wide.  Cut the cells to a
   * boundary with `Geo2.intersection(cells, boundary)`.
   */
  cells(kind: "tri" | "hex" | "square" | "diamond", within: Shape2, opts: { pitch: number; inset?: number; angle?: number; origin?: Pt }): Loop[];
  /** Grid points inside `within`.  `stagger` shifts every other row half a step; `margin` keeps them that far from the edge. */
  grid(within: Shape2, opts: { dx: number; dy?: number; stagger?: boolean; angle?: number; origin?: Pt; margin?: number }): Pt[];
  /**
   * The significant corners of a shape's outer boundary, in order round it: the boundary simplified to within
   * `tolerance` (3 % of its size by default), so a rounded corner gives a point or two.  With `spacing`, points
   * that far apart along the runs between corners as well.  Anchors for ribs.
   */
  outlinePoints(shape: Shape2, opts?: { spacing?: number; tolerance?: number }): Pt[];
  /** The Delaunay triangulation of points: triangles and edges as indices into `points`. */
  delaunay(points: Pt[]): { triangles: [number, number, number][]; edges: [number, number][] };
  /** The Voronoi cell of each point, cut to `within`: a list of regions per point. */
  voronoi(points: Pt[], within: Shape2): Region[][];
  /** A shape as triangles. */
  triangulate(shape: Shape2): Pt[][];
};

/** Small vector helpers. */
declare const V3: {
  add(a: Vec3, b: Vec3): Vec3;
  sub(a: Vec3, b: Vec3): Vec3;
  scale(a: Vec3, s: number): Vec3;
  dot(a: Vec3, b: Vec3): number;
  cross(a: Vec3, b: Vec3): Vec3;
  length(a: Vec3): number;
  normalize(a: Vec3): Vec3;
  distance(a: Vec3, b: Vec3): number;
};

declare const console: { log(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void };
