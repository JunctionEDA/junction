// turntable.ts — where the camera is in each frame of a turntable film: the model seen from all round, as if it
// stood on a turning table in front of a fixed camera.  Pure.
//
// A camera here is what the viewport's is (shared/viewport3d): the point it looks at, which way it is turned, and
// how tall the view is at that point.  A frame's camera is the first one carried round an axis through a centre
// (by default the vertical through the middle of the model): the point it looks at goes round with it, so a
// model framed off-centre stays framed as it was.
//
//   orbit   round at one height
//   rise    round while climbing: the camera starts `rise` degrees lower than it ends, easing in and out
//
// `elevation` puts the camera that many degrees above the plane the table turns in before it sets off (null:
// where it already is).  Frame `frames` would be frame 0 again, so the film loops (an orbit; a rise does not).
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface RenderCamera {
  projection: "orthographic" | "perspective";
  /** x, y, z, w: the camera looks along its own −Z with +Y up, as three.js cameras do */
  quaternion: Quat;
  /** the point it looks at, model space (millimetres, Z up) */
  target: Vec3;
  /** how tall the view is at the target, millimetres */
  height: number;
  /** vertical field of view in degrees (perspective) */
  fov: number;
}

export type TurntablePath = "orbit" | "rise";
export interface TurntableSpec {
  /** the direction of the axis the table turns about */
  axis: Vec3;
  /** a point on it */
  centre: Vec3;
  frames: number;
  /** how many times round (negative: the other way) */
  turns: number;
  /** degrees above the table's plane, or null to keep the camera's own */
  elevation: number | null;
  path: TurntablePath;
  /** degrees climbed over the film, for "rise" */
  rise: number;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3, fallback: Vec3 = [0, 0, 1]): Vec3 => { const l = len(a); return l > 1e-12 ? scale(a, 1 / l) : fallback; };

/** A vector turned by a quaternion. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q, u: Vec3 = [x, y, z], t = scale(cross(u, v), 2);
  return add(add(v, scale(t, w)), cross(u, t));
}
/** A vector turned by `angle` radians about a unit axis (Rodrigues). */
export function turn(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
}
/** The turn of a camera that sits along `back` from what it looks at, with `up` towards the top of the picture. */
export function lookFrom(back: Vec3, up: Vec3): Quat {
  const z = unit(back);
  let x = cross(up, z);
  // looking straight along the axis: any horizontal will do, and it must not flip from frame to frame
  if (len(x) < 1e-6) x = cross(Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], z);
  x = unit(x);
  const y = cross(z, x);
  // the rotation matrix with columns x, y, z as a quaternion
  const m00 = x[0], m11 = y[1], m22 = z[2], tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, s / 4]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s, (z[0] - x[2]) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4, (x[1] - y[0]) / s]; }
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

const RAD = Math.PI / 180;
const ease = (t: number): number => t * t * (3 - 2 * t);

/** How far above the table's plane a camera is, degrees. */
export function elevationOf(camera: RenderCamera, axis: Vec3): number {
  return Math.asin(Math.max(-1, Math.min(1, dot(rotate(camera.quaternion, [0, 0, 1]), unit(axis))))) / RAD;
}

/** The angle the table has turned by at a frame, radians. */
export const turntableAngle = (spec: TurntableSpec, frame: number): number => (2 * Math.PI * spec.turns * frame) / Math.max(1, spec.frames);

/** The camera of one frame (0 … frames − 1) of a turntable that starts from `start`. */
export function turntableCamera(start: RenderCamera, spec: TurntableSpec, frame: number): RenderCamera {
  const axis = unit(spec.axis), n = Math.max(1, spec.frames), t = n > 1 ? frame / (n - 1) : 0;
  const back = rotate(start.quaternion, [0, 0, 1]);
  // the part of the camera's direction that lies in the table's plane: where "round" starts from
  let flat = sub(back, scale(axis, dot(back, axis)));
  if (len(flat) < 1e-6) flat = cross(axis, Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  flat = unit(flat);
  let elevation = spec.elevation ?? elevationOf(start, axis);
  if (spec.path === "rise") elevation += spec.rise * (ease(t) - 1);
  elevation = Math.max(-89, Math.min(89, elevation));
  const angle = turntableAngle(spec, frame);
  const dir = turn(add(scale(flat, Math.cos(elevation * RAD)), scale(axis, Math.sin(elevation * RAD))), axis, angle);
  const target = add(spec.centre, turn(sub(start.target, spec.centre), axis, angle));
  return { ...start, quaternion: lookFrom(dir, axis), target };
}

/** Where a camera stands: back from its target along its line of sight (an orthographic one is put far enough to see everything). */
export function cameraPosition(camera: RenderCamera, orthoDistance = 2e4): Vec3 {
  const back = rotate(camera.quaternion, [0, 0, 1]);
  const d = camera.projection === "perspective" ? camera.height / 2 / Math.tan((camera.fov * RAD) / 2) : orthoDistance;
  return add(camera.target, scale(back, d));
}

/** Frames, their length and the seconds a film of them lasts. */
export function turntableTiming(duration: number, fps: number): { frames: number; frameMicros: number; seconds: number } {
  const rate = Math.max(1, Math.min(120, Math.round(fps))), frames = Math.max(1, Math.round(Math.max(0.05, duration) * rate));
  return { frames, frameMicros: Math.round(1e6 / rate), seconds: frames / rate };
}

/** "3 min 20 s" from seconds: what is left of a render. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}
