// render.ts — a shaded picture of the bodies of a part studio without a browser: a small software rasteriser
// (orthographic camera, depth buffer, smooth shading from the mesh's own normals under a key and a fill light, the
// bodies' edges drawn over the faces) and a PNG writer.
//
// The tool host runs in Node, where there is no WebGL.  An assistant needs the picture to check its own work
// ("is the hole where I meant it"), not for beauty, so this draws what the viewport draws in its simplest form:
// each body's triangles lit as the viewport's studio lights them (a key above and to the left of the camera, a
// fill at the right, so round faces read as round), its edges as dark lines, a small axis triad in the corner.  It is
// drawn at twice the size asked for and averaged down, which is all the anti-aliasing it has.
import type { BodyMesh } from "../kernel/protocol";
import { cross, dot, normalize, sub, type Vec3 } from "../core/geometry";

declare function require(name: string): any;   // eslint-disable-line @typescript-eslint/no-explicit-any

export type ViewName = "iso" | "top" | "bottom" | "front" | "back" | "left" | "right" | "iso_back" | "iso_left" | "iso_below";
/** `dir` is the way the camera looks, `up` what is up on the picture. */
export const VIEWS: Record<ViewName, { dir: Vec3; up: Vec3 }> = {
  iso: { dir: [-1, 1, -1], up: [0, 0, 1] },       // from the front right, above (the viewport's Iso)
  top: { dir: [0, 0, -1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, 1], up: [0, -1, 0] },
  front: { dir: [0, 1, 0], up: [0, 0, 1] },
  back: { dir: [0, -1, 0], up: [0, 0, 1] },
  right: { dir: [-1, 0, 0], up: [0, 0, 1] },
  left: { dir: [1, 0, 0], up: [0, 0, 1] },
  iso_back: { dir: [1, -1, -1], up: [0, 0, 1] },    // from the back left, above
  iso_left: { dir: [1, 1, -1], up: [0, 0, 1] },     // from the front left, above
  iso_below: { dir: [-1, 1, 1], up: [0, 0, 1] },    // from the front right, below
};

export interface RenderOptions {
  width?: number; height?: number;
  view?: ViewName;
  /** a view direction of its own (the way the camera looks), instead of a named view */
  direction?: Vec3;
  edges?: boolean;
  /** one colour per mesh, 0xRRGGBB; the default palette otherwise */
  colors?: number[];
  background?: number;
  /** where each mesh stands: the rows of a 3 x 4 matrix (an assembly's instances); null or absent is "as it is" */
  transforms?: (readonly number[] | null | undefined)[];
  /** a section: everything on the side the normal points to is cut away, and what the cut opens is drawn dark */
  section?: { point: Vec3; normal: Vec3 };
  /** frame the picture on this box (xmin, ymin, zmin, xmax, ymax, zmax) instead of on everything */
  frame?: readonly number[];
  /** faces and edges to draw in the highlight colour: `mesh` is the index in the list */
  highlight?: { mesh: number; kind: "face" | "edge"; name: string }[];
  /** false leaves the axis triad out */
  triad?: boolean;
}

const HIGHLIGHT = 0xf08a24;

/** A mesh carried by a placement: positions and normals in the space of the picture. */
function placedMesh(m: BodyMesh, t: readonly number[] | null | undefined): BodyMesh {
  if (!t || t.length !== 12 || (t[0] === 1 && t[5] === 1 && t[10] === 1 && !t[3] && !t[7] && !t[11] && !t[1] && !t[2] && !t[4] && !t[6] && !t[8] && !t[9])) return m;
  const move = (src: Float32Array, w: number): Float32Array => {
    const out = new Float32Array(src.length);
    for (let i = 0; i + 2 < src.length; i += 3) {
      const x = src[i], y = src[i + 1], z = src[i + 2];
      out[i] = t[0] * x + t[1] * y + t[2] * z + w * t[3]; out[i + 1] = t[4] * x + t[5] * y + t[6] * z + w * t[7]; out[i + 2] = t[8] * x + t[9] * y + t[10] * z + w * t[11];
    }
    return out;
  };
  return { ...m, positions: move(m.positions, 1), normals: m.normals && m.normals.length === m.positions.length ? move(m.normals, 0) : m.normals, edges: { ...m.edges, positions: move(m.edges.positions, 1) } };
}

export interface Picture { width: number; height: number; rgba: Uint8Array }

const PALETTE = [0x9db4cf, 0xd3b58f, 0xa7c9a1, 0xcfa3b8, 0xb0a8d6, 0xc9c48f];

/** Draw the meshes.  The picture is framed on them with a margin; with nothing to draw it is the background. */
export function renderMeshes(given: readonly BodyMesh[], o: RenderOptions = {}): Picture {
  const meshes = given.map((m, i) => placedMesh(m, o.transforms ? o.transforms[i] : null));
  const cut = o.section ? { p: o.section.point, n: normalize(o.section.normal) } : null;
  const cutAt = (p: Vec3): number => (cut ? dot(sub(p, cut.p), cut.n) : -1);
  const litFaces = new Map<number, Set<number>>(), litEdges = new Map<number, Set<number>>();
  for (const h of o.highlight || []) {
    const m = meshes[h.mesh]; if (!m) continue;
    const at = (h.kind === "face" ? m.faces.names : m.edges.names).indexOf(h.name); if (at < 0) continue;
    const into = h.kind === "face" ? litFaces : litEdges;
    if (!into.has(h.mesh)) into.set(h.mesh, new Set());
    into.get(h.mesh)!.add(at);
  }
  const W = Math.max(64, Math.min(2000, Math.round(o.width || 900))), H = Math.max(64, Math.min(2000, Math.round(o.height || 700)));
  const S = 2, w = W * S, h = H * S;
  const view = o.direction ? { dir: o.direction, up: Math.abs(normalize(o.direction)[2]) > 0.99 ? ([0, 1, 0] as Vec3) : ([0, 0, 1] as Vec3) } : VIEWS[o.view || "iso"] || VIEWS.iso;
  const d = normalize(view.dir), right = normalize(cross(d, view.up)), up = cross(right, d);
  const bg = o.background ?? 0xf3f4f6;
  const color = new Uint8Array(w * h * 3), depth = new Float32Array(w * h).fill(Infinity);
  for (let i = 0; i < w * h; i++) { color[i * 3] = bg >> 16; color[i * 3 + 1] = (bg >> 8) & 255; color[i * 3 + 2] = bg & 255; }

  // the extent of everything on the picture plane
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const grow = (p: Vec3): void => {
    const x = dot(p, right), y = dot(p, up), z = dot(p, d);
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  };
  const f = o.frame && o.frame.length === 6 && o.frame.every((v) => Number.isFinite(v)) ? o.frame : null;
  if (f) for (let c = 0; c < 8; c++) grow([c & 1 ? f[3] : f[0], c & 2 ? f[4] : f[1], c & 4 ? f[5] : f[2]]);
  else for (const m of meshes) for (let i = 0; i < m.positions.length; i += 3) { const p: Vec3 = [m.positions[i], m.positions[i + 1], m.positions[i + 2]]; if (cutAt(p) <= 1e-9) grow(p); }
  // the depth of everything, whatever the picture is framed on (the edges' bias is a part of it)
  for (const m of meshes) for (let i = 0; i < m.positions.length; i += 3) { const z = m.positions[i] * d[0] + m.positions[i + 1] * d[1] + m.positions[i + 2] * d[2]; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  const any = Number.isFinite(x0);
  if (!any) { x0 = y0 = z0 = -10; x1 = y1 = z1 = 10; }
  const margin = 0.08;
  const span = Math.max((x1 - x0) / (w * (1 - 2 * margin)), (y1 - y0) / (h * (1 - 2 * margin)), 1e-9);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const px = (x: number) => (x - cx) / span + w / 2, py = (y: number) => h / 2 - (y - cy) / span;
  const zr = Math.max(z1 - z0, 1e-6);

  // towards the lights, in the model: the key above and left of the camera, the fill low at the right
  const toward = (r: number, u: number, back: number): Vec3 => normalize([-d[0] * back + r * right[0] + u * up[0], -d[1] * back + r * right[1] + u * up[1], -d[2] * back + r * right[2] + u * up[2]]);
  const key = toward(-0.35, 1, 0.6), fill = toward(0.9, 0.1, 0.5);
  const lightOf = (n: Vec3): number => {
    // a face seen from behind (an open surface) is lit as its other side
    const f = dot(n, d) > 0 ? -1 : 1;
    return Math.min(1.08, 0.4 + 0.52 * Math.max(0, f * dot(n, key)) + 0.16 * Math.max(0, f * dot(n, fill)));
  };
  meshes.forEach((m, mi) => {
    const base = (o.colors && o.colors[mi] !== undefined ? o.colors[mi] : PALETTE[mi % PALETTE.length]);
    const br = base >> 16, bgc = (base >> 8) & 255, bb = base & 255;
    const P = m.positions, I = m.indices, N = m.normals;
    const smooth = !!N && N.length === P.length;
    // which triangles are of a highlighted face
    const lit = litFaces.get(mi);
    const hot = lit ? new Uint8Array(I.length / 3) : null;
    if (lit && hot) for (const fi of lit) for (let t = m.faces.start[fi]; t < m.faces.start[fi] + m.faces.count[fi]; t += 3) hot[t / 3] = 1;
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a: Vec3 = [P[I[t] * 3], P[I[t] * 3 + 1], P[I[t] * 3 + 2]], b: Vec3 = [P[I[t + 1] * 3], P[I[t + 1] * 3 + 1], P[I[t + 1] * 3 + 2]], c: Vec3 = [P[I[t + 2] * 3], P[I[t + 2] * 3 + 1], P[I[t + 2] * 3 + 2]];
      const n = normalize(cross(sub(b, a), sub(c, a)));
      const da = cutAt(a), db = cutAt(b), dc = cutAt(c);
      if (cut && da > 0 && db > 0 && dc > 0) continue;
      // seen from behind through a section: the inside of the solid, drawn as the cut
      const inside = !!cut && dot(n, d) > 1e-9;
      const tr = hot && hot[t / 3] ? HIGHLIGHT >> 16 : br, tg = hot && hot[t / 3] ? (HIGHLIGHT >> 8) & 255 : bgc, tb = hot && hot[t / 3] ? HIGHLIGHT & 255 : bb;
      // the light at each corner, from the surface's own normal there: a cylinder shades round
      const la = smooth ? lightOf([N[I[t] * 3], N[I[t] * 3 + 1], N[I[t] * 3 + 2]]) : lightOf(n);
      const lb = smooth ? lightOf([N[I[t + 1] * 3], N[I[t + 1] * 3 + 1], N[I[t + 1] * 3 + 2]]) : la;
      const lc = smooth ? lightOf([N[I[t + 2] * 3], N[I[t + 2] * 3 + 1], N[I[t + 2] * 3 + 2]]) : la;
      const ax = px(dot(a, right)), ay = py(dot(a, up)), az = dot(a, d), bx = px(dot(b, right)), by = py(dot(b, up)), bz = dot(b, d), cx2 = px(dot(c, right)), cy2 = py(dot(c, up)), cz = dot(c, d);
      const area = (bx - ax) * (cy2 - ay) - (cx2 - ax) * (by - ay);
      if (Math.abs(area) < 1e-9) continue;
      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx2))), maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx2)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy2))), maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy2)));
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const sx = x + 0.5, sy = y + 0.5;
          const w0 = ((bx - sx) * (cy2 - sy) - (cx2 - sx) * (by - sy)) / area, w1 = ((cx2 - sx) * (ay - sy) - (ax - sx) * (cy2 - sy)) / area, w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          if (cut && w0 * da + w1 * db + w2 * dc > 0) continue;
          const z = w0 * az + w1 * bz + w2 * cz, i = y * w + x;
          if (z < depth[i]) {
            // a little darker with distance, so that a floor reads as below its rim in a view from straight above
            const shade = (inside ? 0.42 : w0 * la + w1 * lb + w2 * lc) * (1 - 0.2 * Math.min(1, Math.max(0, (z - z0) / zr)));
            depth[i] = z; color[i * 3] = Math.min(255, Math.round(tr * shade)); color[i * 3 + 1] = Math.min(255, Math.round(tg * shade)); color[i * 3 + 2] = Math.min(255, Math.round(tb * shade));
          }
        }
      }
    }
  });

  /** A line with a depth test: it shows where it is not behind a face (a little bias keeps it in front of its own). */
  const line = (a: Vec3, b: Vec3, rgb: number, tested: boolean, thick: number): void => {
    const ax = px(dot(a, right)), ay = py(dot(a, up)), az = dot(a, d), bx = px(dot(b, right)), by = py(dot(b, up)), bz = dot(b, d);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))));
    const bias = zr * 0.004;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
      if (cut && tested && cutAt([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]) > 1e-6) continue;
      for (let oy = 0; oy < thick; oy++) for (let ox = 0; ox < thick; ox++) {
        const xi = Math.round(x) + ox, yi = Math.round(y) + oy;
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
        const i = yi * w + xi;
        if (tested && z - bias > depth[i]) continue;
        color[i * 3] = rgb >> 16; color[i * 3 + 1] = (rgb >> 8) & 255; color[i * 3 + 2] = rgb & 255;
      }
    }
  };
  if (o.edges !== false) {
    for (const m of meshes) {
      const E = m.edges.positions;
      for (let i = 0; i + 5 < E.length; i += 6) line([E[i], E[i + 1], E[i + 2]], [E[i + 3], E[i + 4], E[i + 5]], 0x1f2933, true, S);
    }
  }
  // highlighted edges, over everything: thick, and seen through the part so that a hidden one is still found
  for (const [mi, set] of litEdges) {
    const m = meshes[mi], E = m.edges.positions;
    for (const ei of set) for (let i = m.edges.start[ei]; i + 1 < m.edges.start[ei] + m.edges.count[ei]; i += 2) line([E[i * 3], E[i * 3 + 1], E[i * 3 + 2]], [E[i * 3 + 3], E[i * 3 + 4], E[i * 3 + 5]], HIGHLIGHT, false, S * 2 + 1);
  }
  // the axis triad, bottom left: X red, Y green, Z blue, as the viewport draws them
  if (o.triad !== false) {
    const len = Math.min(w, h) * 0.07 * span;
    const ox = (x0 + x1) / 2 - (w / 2 - w * 0.07) * span, oy = (y0 + y1) / 2 - (h / 2 - h * 0.09) * span;
    const origin: Vec3 = [right[0] * ox + up[0] * oy, right[1] * ox + up[1] * oy, right[2] * ox + up[2] * oy];
    const axes: [Vec3, number][] = [[[1, 0, 0], 0xd64545], [[0, 1, 0], 0x3f9b4b], [[0, 0, 1], 0x3d6fd6]];
    for (const [v, rgb] of axes) line(origin, [origin[0] + v[0] * len, origin[1] + v[1] * len, origin[2] + v[2] * len], rgb, false, S + 1);
  }

  // average the 2 × 2 blocks down
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0;
    for (let oy = 0; oy < S; oy++) for (let ox = 0; ox < S; ox++) { const i = ((y * S + oy) * w + x * S + ox) * 3; r += color[i]; g += color[i + 1]; b += color[i + 2]; }
    const o4 = (y * W + x) * 4, n = S * S;
    rgba[o4] = r / n; rgba[o4 + 1] = g / n; rgba[o4 + 2] = b / n; rgba[o4 + 3] = 255;
  }
  return { width: W, height: H, rgba };
}

/**
 * Several views of the same thing in one picture, side by side in rows (left to right, top to bottom), each framed
 * on its own.  `width` is the whole picture's; the cells share it.  `each` gives a cell options of its own (the
 * placements of one step of a motion).
 */
export function renderSheet(meshes: readonly BodyMesh[], views: readonly (ViewName | Vec3)[], o: RenderOptions = {}, each?: (i: number) => RenderOptions): Picture {
  const n = Math.max(1, views.length), cols = n <= 3 ? n : n === 4 ? 2 : 3, rows = Math.ceil(n / cols);
  const W = Math.max(64, Math.min(2000, Math.round(o.width || 1200))), gap = 4;
  const cw = Math.floor((W - gap * (cols - 1)) / cols), ch = Math.round(cw * 0.8);
  const H = rows * ch + gap * (rows - 1);
  const rgba = new Uint8Array(W * H * 4).fill(255);
  views.forEach((v, i) => {
    const pic = renderMeshes(meshes, { ...o, ...(each ? each(i) : {}), width: cw, height: ch, ...(typeof v === "string" ? { view: v, direction: undefined } : { direction: v }) });
    const ox = (i % cols) * (cw + gap), oy = Math.floor(i / cols) * (ch + gap);
    for (let y = 0; y < pic.height; y++) rgba.set(pic.rgba.subarray(y * pic.width * 4, (y + 1) * pic.width * 4), ((oy + y) * W + ox) * 4);
  });
  return { width: W, height: H, rgba };
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG file of the picture (Node only: it uses node:zlib). */
export function encodePng(pic: Picture): Uint8Array {
  const zlib = require("node:zlib");
  const { width: w, height: h, rgba } = pic;
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
  const data: Uint8Array = zlib.deflateSync(raw, { level: 6 });
  const chunk = (type: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + body.length), dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const head = new Uint8Array(13), hv = new DataView(head.buffer);
  hv.setUint32(0, w); hv.setUint32(4, h); head[8] = 8; head[9] = 6; head[10] = 0; head[11] = 0; head[12] = 0;
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", data), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
