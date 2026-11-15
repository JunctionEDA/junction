// library/embedded-file — EMBEDDED_FILES::AddFile and WriteEmbeddedFiles for one file (common/embedded_files.cpp):
//   embeddedFileType    the (type …) AddFile picks from the extension (model / font / datasheet / worksheet / other)
//   mmh3Hash            MMH3_HASH( EMBEDDED_FILES::Seed() ) over the bytes, HASH_128::ToString's 32 upper-case hex digits
//   zstdStore           a zstd frame holding the bytes in raw blocks, with the content size KiCad's reader requires
//                       (ZSTD_getFrameContentSize); KiCad compresses at level 15, any valid frame reads back the same
//   embeddedFileSexpr   the (file (name …) (type …) (data |…|) (checksum …)) form, the data in MIME_BASE64_LENGTH lines

/** EMBEDDED_FILES::Seed */
export const EMBED_SEED = 0xabba2345;
/** MIME_BASE64_LENGTH: the width of one line of (data …) */
const LINE = 76;

/** EMBEDDED_FILES::AddFile: the file type from its extension. */
export function embeddedFileType(name: string): "model" | "font" | "datasheet" | "worksheet" | "other" {
  const ext = (/\.([^./\\]+)$/.exec(name) || ["", ""])[1].toUpperCase();
  if (["STP", "STPZ", "STEP", "WRL", "WRZ"].includes(ext)) return "model";
  if (["WOFF", "WOFF2", "TTF", "OTF"].includes(ext)) return "font";
  if (ext === "PDF") return "datasheet";
  if (ext === "KICAD_WKS") return "worksheet";
  return "other";
}

const M64 = (1n << 64n) - 1n;
const rotl = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & M64;
const fmix = (k: bigint): bigint => {
  k ^= k >> 33n; k = (k * 0xff51afd7ed558ccdn) & M64; k ^= k >> 33n; k = (k * 0xc4ceb9fe1a85ec53n) & M64; k ^= k >> 33n; return k;
};
/** MurmurHash3_x64_128 (MMH3_HASH::addData, then digest) as HASH_128::ToString writes it. */
export function mmh3Hash(data: Uint8Array, seed = EMBED_SEED): string {
  const C1 = 0x87c37b91114253d5n, C2 = 0x4cf5ad432745937fn;
  let h1 = BigInt(seed >>> 0), h2 = BigInt(seed >>> 0);
  const le64 = (p: number, n: number): bigint => { let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(data[p + i]); return v; };
  const nblocks = Math.floor(data.length / 16);
  for (let b = 0; b < nblocks; b++) {
    let k1 = le64(b * 16, 8), k2 = le64(b * 16 + 8, 8);
    k1 = (k1 * C1) & M64; k1 = rotl(k1, 31n); k1 = (k1 * C2) & M64; h1 ^= k1;
    h1 = rotl(h1, 27n); h1 = (h1 + h2) & M64; h1 = (h1 * 5n + 0x52dce729n) & M64;
    k2 = (k2 * C2) & M64; k2 = rotl(k2, 33n); k2 = (k2 * C1) & M64; h2 ^= k2;
    h2 = rotl(h2, 31n); h2 = (h2 + h1) & M64; h2 = (h2 * 5n + 0x38495ab5n) & M64;
  }
  const t = nblocks * 16, rest = data.length & 15;
  if (rest > 8) { let k2 = le64(t + 8, rest - 8); k2 = (k2 * C2) & M64; k2 = rotl(k2, 33n); k2 = (k2 * C1) & M64; h2 ^= k2; }
  if (rest > 0) { let k1 = le64(t, Math.min(rest, 8)); k1 = (k1 * C1) & M64; k1 = rotl(k1, 31n); k1 = (k1 * C2) & M64; h1 ^= k1; }
  const len = BigInt(data.length >>> 0);   // MMH3_HASH::len is a uint32_t
  h1 ^= len; h2 ^= len; h1 = (h1 + h2) & M64; h2 = (h2 + h1) & M64;
  h1 = fmix(h1); h2 = fmix(h2); h1 = (h1 + h2) & M64; h2 = (h2 + h1) & M64;
  return (h1.toString(16).padStart(16, "0") + h2.toString(16).padStart(16, "0")).toUpperCase();
}

/** A single-segment zstd frame with an 8-byte content size and the data in raw blocks of at most 128 KiB. */
export function zstdStore(data: Uint8Array): Uint8Array {
  const BLOCK = 128 * 1024, n = data.length;
  const blocks = Math.max(1, Math.ceil(n / BLOCK));
  const out = new Uint8Array(4 + 1 + 8 + blocks * 3 + n);
  out.set([0x28, 0xb5, 0x2f, 0xfd, 0xe0], 0);   // magic; FHD: FCS 8 bytes, single segment
  let size = n; for (let i = 0; i < 8; i++) { out[5 + i] = size % 256; size = Math.floor(size / 256); }
  let p = 13;
  for (let b = 0; b < blocks; b++) {
    const len = Math.min(BLOCK, n - b * BLOCK), hdr = (len << 3) | (b === blocks - 1 ? 1 : 0);   // raw block, last flag
    out[p] = hdr & 0xff; out[p + 1] = (hdr >> 8) & 0xff; out[p + 2] = (hdr >> 16) & 0xff; p += 3;
    out.set(data.subarray(b * BLOCK, b * BLOCK + len), p); p += len;
  }
  return out;
}

function base64(bytes: Uint8Array): string {
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}
const quote = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';

/** WriteEmbeddedFiles for one file: the form to put in (embedded_files …). */
export function embeddedFileSexpr(name: string, data: Uint8Array): string {
  const enc = base64(zstdStore(data)), lines: string[] = [];
  for (let i = 0; i < enc.length; i += LINE) lines.push(enc.slice(i, i + LINE));
  return `(file (name ${quote(name)}) (type ${embeddedFileType(name)}) (data |${lines.join("\n")}|) (checksum ${quote(mmh3Hash(data))}))`;
}
