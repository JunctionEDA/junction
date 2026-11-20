// _cf-geo-image.ts — a picture as a grid of brightness, for the features that are driven by one (the halftone
// perforation and the lithophane).  The picture is one a sketch holds (the sketcher's Image tool stores it in
// the sketch as a data: URL), so it is part of the document and every collaborator builds the same part.
//
// PNG is decoded here (8 and 16 bits; grey, colour, palette, with or without alpha; not interlaced), the same
// in the page's worker and in node.  Anything else (JPEG) is handed to the browser's own decoder, which a
// worker has (createImageBitmap, OffscreenCanvas) and node has not.
import type { SketchData } from "../sketch/format";

/** Brightness 0 (black) … 1 (white), row 0 at the top. */
export interface Picture { width: number; height: number; gray: Float32Array }

/* eslint-disable @typescript-eslint/no-explicit-any */

function bytesOf(src: string): { bytes: Uint8Array; mime: string } {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(src);
  if (!m) throw new Error("The picture is not stored in the sketch. Place it again with the sketch's Image tool.");
  if (!m[2]) return { bytes: new TextEncoder().encode(decodeURIComponent(m[3])), mime: m[1] };
  const bin = atob(m[3]), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime: m[1] };
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as any).DecompressionStream;
  if (!DS) throw new Error("This browser cannot unpack a PNG picture.");
  const stream = new Blob([data as any]).stream().pipeThrough(new DS("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
export const isPng = (b: Uint8Array): boolean => PNG_SIG.every((v, i) => b[i] === v);

export async function decodePng(b: Uint8Array): Promise<Picture> {
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  let width = 0, height = 0, depth = 8, type = 0, interlace = 0;
  let palette: Uint8Array | null = null, alpha: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let o = 8; o + 8 <= b.length;) {
    const len = u32(o), kind = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]), d = b.subarray(o + 8, o + 8 + len);
    if (kind === "IHDR") { width = u32(o + 8); height = u32(o + 12); depth = d[8]; type = d[9]; interlace = d[12]; }
    else if (kind === "PLTE") palette = d;
    else if (kind === "tRNS") alpha = d;
    else if (kind === "IDAT") idat.push(d);
    else if (kind === "IEND") break;
    o += 12 + len;
  }
  if (!width || !height || !idat.length) throw new Error("The picture is not a PNG that can be read.");
  if (interlace) throw new Error("Interlaced PNG pictures cannot be read. Save the picture without interlacing.");
  if (width * height > 16e6) throw new Error("The picture is too large (more than 16 megapixels).");
  const channels = [1, 0, 3, 1, 2, 0, 4][type];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) throw new Error("The picture is a kind of PNG that cannot be read.");
  const packed = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  idat.reduce((at, c) => { packed.set(c, at); return at + c.length; }, 0);
  const raw = await inflate(packed);
  const bpp = Math.max(1, (channels * depth) >> 3), stride = Math.ceil((width * channels * depth) / 8);
  if (raw.length < (stride + 1) * height) throw new Error("The picture's data is cut short.");
  // undo the per-row filters in place
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), out = px.subarray(y * stride, (y + 1) * stride);
    const up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0, u = up ? up[i] : 0, c = up && i >= bpp ? up[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += u; else if (f === 3) v += (a + u) >> 1;
      else if (f === 4) { const p = a + u - c, pa = Math.abs(p - a), pb = Math.abs(p - u), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? u : c; }
      out[i] = v & 0xff;
    }
  }
  const gray = new Float32Array(width * height);
  const max = depth === 16 ? 65535 : (1 << depth) - 1;
  const sample = (y: number, i: number): number => {   // the i-th sample of row y
    const o = y * stride;
    if (depth === 8) return px[o + i];
    if (depth === 16) return (px[o + 2 * i] << 8) | px[o + 2 * i + 1];
    const bit = i * depth; return (px[o + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let l = 1, a = 1;
    if (type === 3) {
      const i = sample(y, x);
      if (!palette || i * 3 + 2 >= palette.length) throw new Error("The picture's palette is missing a colour.");
      l = (0.2126 * palette[i * 3] + 0.7152 * palette[i * 3 + 1] + 0.0722 * palette[i * 3 + 2]) / 255;
      if (alpha && i < alpha.length) a = alpha[i] / 255;
    } else if (channels <= 2) { l = sample(y, x * channels) / max; if (channels === 2) a = sample(y, x * 2 + 1) / max; }
    else { l = (0.2126 * sample(y, x * channels) + 0.7152 * sample(y, x * channels + 1) + 0.0722 * sample(y, x * channels + 2)) / max; if (channels === 4) a = sample(y, x * 4 + 3) / max; }
    gray[y * width + x] = l * a + (1 - a);   // see-through is white
  }
  return { width, height, gray };
}

/** Decode a picture stored as a data: URL. */
export async function decodePicture(src: string): Promise<Picture> {
  const { bytes, mime } = bytesOf(src);
  if (isPng(bytes)) return decodePng(bytes);
  const g = globalThis as any;
  if (typeof g.createImageBitmap !== "function" || typeof g.OffscreenCanvas !== "function") throw new Error("Only PNG pictures can be read here.");
  let bmp: any;
  try { bmp = await g.createImageBitmap(new Blob([bytes as any], { type: mime || "image/jpeg" })); }
  catch (e) { throw new Error("The picture could not be read. Use a PNG or JPEG."); }
  // large photographs are read at a size that is plenty for a part
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)), width = Math.max(1, Math.round(bmp.width * k)), height = Math.max(1, Math.round(bmp.height * k));
  const canvas = new g.OffscreenCanvas(width, height), c2d = canvas.getContext("2d");
  c2d.fillStyle = "#fff"; c2d.fillRect(0, 0, width, height);
  c2d.drawImage(bmp, 0, 0, width, height);
  const rgba = c2d.getImageData(0, 0, width, height).data as Uint8ClampedArray;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) gray[i] = (0.2126 * rgba[4 * i] + 0.7152 * rgba[4 * i + 1] + 0.0722 * rgba[4 * i + 2]) / 255;
  return { width, height, gray };
}

/** The brightness at (u, v), both 0 … 1 with v = 0 at the top, averaged over a box `du` × `dv` wide round it. */
export function brightness(pic: Picture, u: number, v: number, du = 0, dv = 0): number {
  const x0 = Math.max(0, Math.min(pic.width - 1, Math.floor((u - du / 2) * pic.width))), x1 = Math.max(x0, Math.min(pic.width - 1, Math.floor((u + du / 2) * pic.width)));
  const y0 = Math.max(0, Math.min(pic.height - 1, Math.floor((v - dv / 2) * pic.height))), y1 = Math.max(y0, Math.min(pic.height - 1, Math.floor((v + dv / 2) * pic.height)));
  // at most 8 × 8 samples of the box
  const sx = Math.max(1, Math.ceil((x1 - x0 + 1) / 8)), sy = Math.max(1, Math.ceil((y1 - y0 + 1) / 8));
  let s = 0, n = 0;
  for (let y = y0; y <= y1; y += sy) for (let x = x0; x <= x1; x += sx) { s += pic.gray[y * pic.width + x]; n++; }
  return n ? s / n : 1;
}

export interface SketchPicture { src: string; a: [number, number]; b: [number, number] }

/** The first picture a sketch holds: its data and its two corners in sketch coordinates; null when it has none. */
export function pictureIn(data: SketchData): SketchPicture | null {
  for (const e of Object.values(data.entities || {}) as any[]) {
    if (!e || e.type !== "image" || typeof e.src !== "string") continue;
    const a = data.entities[e.a] as any, b = data.entities[e.b] as any;
    if (a && b && a.type === "point" && b.type === "point") return { src: e.src, a: [a.x, a.y], b: [b.x, b.y] };
  }
  return null;
}
