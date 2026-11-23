// pick.ts — the box of a scene, and the point of it a ray hits first: what the turntable turns about and what
// "focus here" focuses on.  Pure: it works on the arrays handed to the render engine (api.ts RenderScene), so it
// needs nothing of the editor that made them.
import type { RenderMesh, RenderScene } from "./api";
import type { Vec3 } from "./turntable";

const at = (m: ArrayLike<number> | null | undefined, x: number, y: number, z: number): Vec3 => (m ? [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]] : [x, y, z]);

/** The box of everything in a scene: [min, max], or null when it is empty. */
export function sceneBox(scene: RenderScene): [Vec3, Vec3] | null {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const m of scene.meshes) {
    const p = m.positions;
    if (!m.indices.length) continue;
    // the mesh's own box first, then its eight corners where it stands
    const a: Vec3 = [Infinity, Infinity, Infinity], b: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) { const v = p[i + c]; if (v < a[c]) a[c] = v; if (v > b[c]) b[c] = v; }
    for (let k = 0; k < 8; k++) {
      const q = at(m.matrix, k & 1 ? b[0] : a[0], k & 2 ? b[1] : a[1], k & 4 ? b[2] : a[2]);
      for (let c = 0; c < 3; c++) { if (q[c] < lo[c]) lo[c] = q[c]; if (q[c] > hi[c]) hi[c] = q[c]; }
    }
  }
  return lo[0] <= hi[0] ? [lo, hi] : null;
}
export const boxCentre = (box: [Vec3, Vec3]): Vec3 => [(box[0][0] + box[1][0]) / 2, (box[0][1] + box[1][1]) / 2, (box[0][2] + box[1][2]) / 2];

function hitMesh(m: RenderMesh, o: Vec3, d: Vec3, best: number): number {
  const p = m.positions, ix = m.indices, mat = m.matrix;
  const v = (i: number): Vec3 => at(mat, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  for (let t = 0; t + 2 < ix.length; t += 3) {
    // Möller–Trumbore, both faces
    const a = v(ix[t]), b = v(ix[t + 1]), c = v(ix[t + 2]);
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2], e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det, tx = o[0] - a[0], ty = o[1] - a[1], tz = o[2] - a[2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const w = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (w < 0 || u + w > 1) continue;
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (dist > 1e-9 && dist < best) best = dist;
  }
  return best;
}

/** Where a ray (origin and direction, model space) first meets the scene, or null when it misses. */
export function pickPoint(scene: RenderScene, origin: Vec3, direction: Vec3): Vec3 | null {
  let best = Infinity;
  for (const m of scene.meshes) best = hitMesh(m, origin, direction, best);
  return Number.isFinite(best) ? [origin[0] + direction[0] * best, origin[1] + direction[1] * best, origin[2] + direction[2] * best] : null;
}
