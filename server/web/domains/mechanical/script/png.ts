// png.ts — a picture as a PNG file, where there is no node:zlib: the modelling worker.  The compression is the
// platform's own CompressionStream ("deflate" is the zlib stream a PNG wants), which browsers, workers and Node
// all have; so the report of a script's run (script/report.ts) carries its picture the same way everywhere.
import type { Picture } from "../mcp/render";

let table: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!table) { table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const CS = (globalThis as { CompressionStream?: new (format: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } }).CompressionStream;
  if (!CS) throw new Error("This runtime cannot compress a picture.");
  const cs = new CS("deflate");
  const writer = cs.writable.getWriter();
  void writer.write(raw); void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export async function pngOf(pic: Picture): Promise<Uint8Array> {
  const { width: w, height: h, rgba } = pic;
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
  const data = await deflate(raw);
  const chunk = (type: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + body.length), dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const head = new Uint8Array(13), hv = new DataView(head.buffer);
  hv.setUint32(0, w); hv.setUint32(4, h); head[8] = 8; head[9] = 6;
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", data), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
