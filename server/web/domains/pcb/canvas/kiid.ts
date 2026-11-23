// canvas/kiid.ts — KIID helpers shared by Update PCB (pcb-netlist.ts) and File > Import > Netlist
// (editor/pcbdialogs/import-netlist-logic.ts): KIID_PATH steps, KIID::FromName and NETLIST_GROUP's deriveGroupUuid.

// ---------------------------------------------------------------- KIID::FromName (boost name_generator_sha1)
/** SHA-1 of a byte string (FIPS 180-4). */
function sha1(bytes: Uint8Array): Uint8Array {
  const ml = bytes.length, words = (((ml + 8) >> 6) + 1) * 16, w = new Uint32Array(words);
  for (let i = 0; i < ml; i++) w[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  w[ml >> 2] |= 0x80 << (24 - (ml % 4) * 8);
  w[words - 1] = (ml * 8) >>> 0; w[words - 2] = Math.floor((ml * 8) / 0x100000000);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const x = new Uint32Array(80), rol = (v: number, n: number): number => (v << n) | (v >>> (32 - n));
  for (let b = 0; b < words; b += 16) {
    for (let i = 0; i < 16; i++) x[i] = w[b + i];
    for (let i = 16; i < 80; i++) x[i] = rol(x[i - 3] ^ x[i - 8] ^ x[i - 14] ^ x[i - 16], 1);
    let a = h0, bb = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (bb & c) | (~bb & d) : i < 40 ? bb ^ c ^ d : i < 60 ? (bb & c) | (bb & d) | (c & d) : bb ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (rol(a, 5) + f + e + k + x[i]) >>> 0; e = d; d = c; c = rol(bb, 30) >>> 0; bb = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + bb) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  [h0, h1, h2, h3, h4].forEach((h, i) => { out[i * 4] = h >>> 24; out[i * 4 + 1] = (h >>> 16) & 255; out[i * 4 + 2] = (h >>> 8) & 255; out[i * 4 + 3] = h & 255; });
  return out;
}
/** KIID::FromName: the name-based (version 5, SHA-1) uuid of `name` in KiCad's fixed namespace. */
export function kiidFromName(name: string): string {
  const ns = "8b8b58e23d214a249dcf42e0f14001a2", nb = new TextEncoder().encode(name), buf = new Uint8Array(16 + nb.length);
  for (let i = 0; i < 16; i++) buf[i] = parseInt(ns.slice(i * 2, i * 2 + 2), 16);
  buf.set(nb, 16);
  const hsh = sha1(buf).slice(0, 16);
  hsh[8] = (hsh[8] & 0xbf) | 0x80; hsh[6] = (hsh[6] & 0x5f) | 0x50;
  const hex = Array.from(hsh, (v) => v.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** KIID_PATH( text ): its steps, lower case, empty ones dropped. */
export const kiidPath = (t: string): string[] => t.split("/").filter(Boolean).map((x) => x.toLowerCase());
/** NETLIST_GROUP's deriveGroupUuid: an instance path collapses to KIID::FromName( KIID_PATH( path ).AsString() ). */
export function deriveGroupUuid(uuid: string): string {
  return uuid.startsWith("/") ? kiidFromName(kiidPath(uuid).map((x) => "/" + x).join("")) : uuid.toLowerCase();
}
