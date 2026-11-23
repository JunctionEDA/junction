// zip.ts — a zip archive of files that are already compressed (the PNG frames of a film where no video encoder
// is to be had): each is stored as it is, so writing one is a checksum and a few headers.  Pure.
export interface ZipEntry { name: string; data: Uint8Array }

let table: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The archive as bytes.  Names are UTF-8; nothing is compressed. */
export function zipStore(entries: readonly ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const names = entries.map((e) => enc.encode(e.name));
  const size = entries.reduce((n, e, i) => n + 30 + names[i].length + e.data.length + 46 + names[i].length, 22);
  const out = new Uint8Array(size), view = new DataView(out.buffer);
  const offsets: number[] = [], sums: number[] = [];
  let at = 0;
  entries.forEach((e, i) => {
    offsets.push(at); sums.push(crc32(e.data));
    view.setUint32(at, 0x04034b50, true); view.setUint16(at + 4, 20, true); view.setUint16(at + 6, 0x0800, true); view.setUint16(at + 8, 0, true);
    view.setUint16(at + 10, 0, true); view.setUint16(at + 12, 0x21, true);
    view.setUint32(at + 14, sums[i], true); view.setUint32(at + 18, e.data.length, true); view.setUint32(at + 22, e.data.length, true);
    view.setUint16(at + 26, names[i].length, true); view.setUint16(at + 28, 0, true);
    out.set(names[i], at + 30); out.set(e.data, at + 30 + names[i].length);
    at += 30 + names[i].length + e.data.length;
  });
  const dir = at;
  entries.forEach((e, i) => {
    view.setUint32(at, 0x02014b50, true); view.setUint16(at + 4, 20, true); view.setUint16(at + 6, 20, true); view.setUint16(at + 8, 0x0800, true); view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, 0, true); view.setUint16(at + 14, 0x21, true);
    view.setUint32(at + 16, sums[i], true); view.setUint32(at + 20, e.data.length, true); view.setUint32(at + 24, e.data.length, true);
    view.setUint16(at + 28, names[i].length, true);
    view.setUint32(at + 42, offsets[i], true);
    out.set(names[i], at + 46);
    at += 46 + names[i].length;
  });
  view.setUint32(at, 0x06054b50, true); view.setUint16(at + 8, entries.length, true); view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - dir, true); view.setUint32(at + 16, dir, true);
  return out;
}
