// _cf-geo-code.ts — QR codes and Data Matrix codes as grids of dark and light modules, for the QR code feature
// (features/cf-geo-qr-code.ts).  Pure.  Written from the standards' published rules:
//
//   QR code (ISO/IEC 18004), versions 1 to 10 (21 to 57 modules a side), byte mode, error correction L M Q H:
//   Reed–Solomon over GF(256) with x⁸+x⁴+x³+x²+1, blocks interleaved, the mask with the lowest penalty chosen.
//   Text is UTF-8.  Version 10-L holds 271 bytes.
//
//   Data Matrix ECC 200 (ISO/IEC 16022), square symbols of one Reed–Solomon block: 10 × 10 to 48 × 48 (3 to 174
//   codewords), ASCII encodation (digit pairs packed, bytes above 127 through upper shift), Latin-1 text.
//
// Both are checked against an independent reader in static/tests/cad-cf-geo.test.js (the module grids of known
// texts are compared with ones a decoder has read back).

export interface CodeMatrix { size: number; dark: boolean[][] }   // dark[row][column], row 0 at the top

const utf8 = (text: string): number[] => Array.from(new TextEncoder().encode(text));

// ---------------------------------------------------------------- Reed–Solomon

function gfMul(x: number, y: number, poly: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * poly); z ^= ((y >>> i) & 1) * x; }
  return z & 0xff;
}

/** The generator polynomial ∏ (x − αⁱ), i from `first` to `first + degree − 1`, highest power first, without its leading 1. */
function rsDivisor(degree: number, poly: number, first: number): number[] {
  const out = new Array<number>(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < first; i++) root = gfMul(root, 2, poly);
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) { out[j] = gfMul(out[j], root, poly); if (j + 1 < degree) out[j] ^= out[j + 1]; }
    root = gfMul(root, 2, poly);
  }
  return out;
}

function rsRemainder(data: readonly number[], divisor: readonly number[], poly: number): number[] {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (out.shift() as number);
    out.push(0);
    divisor.forEach((c, i) => { out[i] ^= gfMul(c, factor, poly); });
  }
  return out;
}

// ---------------------------------------------------------------- QR

export type QrLevel = "L" | "M" | "Q" | "H";
const QR_ECC: { [l in QrLevel]: number[] } = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18], M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24], H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const QR_BLOCKS: { [l in QrLevel]: number[] } = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4], M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5], Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8], H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
const QR_FORMAT: { [l in QrLevel]: number } = { L: 1, M: 0, Q: 3, H: 2 };
export const QR_MAX_VERSION = 10;

function qrRawModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const a = Math.floor(ver / 7) + 2; n -= (25 * a - 10) * a - 55; if (ver >= 7) n -= 36; }
  return n;
}
const qrDataCodewords = (ver: number, level: QrLevel): number => Math.floor(qrRawModules(ver) / 8) - QR_ECC[level][ver - 1] * QR_BLOCKS[level][ver - 1];

/** How many bytes of text a QR code of this error correction can hold at most (version 10). */
export const qrCapacity = (level: QrLevel): number => Math.floor((qrDataCodewords(QR_MAX_VERSION, level) * 8 - 4 - 16) / 8);

/** A QR code for a text: the smallest version (up to 10) that holds it at this error correction. */
export function qrCode(text: string, level: QrLevel = "M"): CodeMatrix & { version: number; mask: number } {
  const bytes = utf8(text);
  let ver = 1;
  const need = (v: number) => 4 + (v < 10 ? 8 : 16) + 8 * bytes.length;
  while (ver <= QR_MAX_VERSION && need(ver) > qrDataCodewords(ver, level) * 8) ver++;
  if (ver > QR_MAX_VERSION) throw new Error(`The text is too long for a QR code here: ${bytes.length} bytes, and at most ${qrCapacity(level)} fit at error correction ${level}. Shorten it or lower the error correction.`);
  // the bit stream: mode, count, bytes, terminator, padding
  const bits: number[] = [];
  const put = (value: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = qrDataCodewords(ver, level) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));

  // error correction per block, then the blocks interleaved
  const blocks = QR_BLOCKS[level][ver - 1], eccLen = QR_ECC[level][ver - 1], raw = Math.floor(qrRawModules(ver) / 8);
  const short = blocks - (raw % blocks), shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen, 0x11d, 0);
  const parts: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor, 0x11d);
    if (i < short) dat.push(0);
    parts.push(dat.concat(ecc));
  }
  const all: number[] = [];
  for (let i = 0; i < parts[0].length; i++) parts.forEach((b, j) => { if (i !== shortLen - eccLen || j >= short) all.push(b[i]); });

  // the symbol
  const size = ver * 4 + 17;
  const m: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { m[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
    if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
  }
  const align: number[] = [];
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2, step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
    for (let pos = size - 7; align.length < n - 1; pos -= step) align.unshift(pos);
    align.unshift(6);
  }
  align.forEach((ax, i) => align.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const format = (mask: number) => {
    const d = (QR_FORMAT[level] << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((d << 10) | rem) ^ 0x5412, bit = (i: number) => ((b >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) { const dark = ((b >>> i) & 1) !== 0, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, dark); set(c, a, dark); }
  }
  // the codewords, zigzagging up and down in column pairs from the right
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fn[y][x] && i < all.length * 8) { m[y][x] = ((all[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
    }
  }
  const MASKS: ((x: number, y: number) => boolean)[] = [
    (x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const apply = (mask: number) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x]; };
  const penalty = (): number => {
    let p = 0;
    const line = (get: (a: number, b: number) => boolean) => {
      for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b <= size; b++) {
          if (b < size && get(a, b) === get(a, b - 1)) { run++; continue; }
          if (run >= 5) p += run - 2;
          run = 1;
        }
        // 1 : 1 : 3 : 1 : 1 with four light modules on a side, as a finder pattern reads
        for (let b = 0; b + 10 < size + 0; b++) {
          const s = Array.from({ length: 11 }, (_v, k) => (get(a, b + k) ? 1 : 0)).join("");
          if (s === "10111010000" || s === "00001011101") p += 40;
        }
      }
    };
    line((a, b) => m[a][b]); line((a, b) => m[b][a]);
    for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
    let darkN = 0; for (const row of m) for (const c of row) if (c) darkN++;
    p += Math.floor(Math.abs(darkN * 20 - size * size * 10) / (size * size)) * 10;
    return p;
  };
  let best = 0, least = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    apply(mask); format(mask);
    const p = penalty();
    if (p < least) { least = p; best = mask; }
    apply(mask);
  }
  apply(best); format(best);
  return { size, dark: m, version: ver, mask: best };
}

// ---------------------------------------------------------------- Data Matrix

/** side, data codewords, error codewords, data regions a side */
const DM_SIZES: [number, number, number, number][] = [
  [10, 3, 5, 1], [12, 5, 7, 1], [14, 8, 10, 1], [16, 12, 12, 1], [18, 18, 14, 1], [20, 22, 18, 1], [22, 30, 20, 1], [24, 36, 24, 1], [26, 44, 28, 1],
  [32, 62, 36, 2], [36, 86, 42, 2], [40, 114, 48, 2], [44, 144, 56, 2], [48, 174, 68, 2],
];
export const DM_CAPACITY = 174;

/** A Data Matrix (ECC 200) for a text: the smallest square symbol, up to 48 × 48, that holds it. */
export function dataMatrix(text: string): CodeMatrix {
  // without an ECI a Data Matrix is read as ISO 8859-1 (Latin-1): one byte a character
  const bytes = Array.from(text).map((ch) => {
    const c = ch.codePointAt(0) as number;
    if (c > 255) throw new Error(`A Data Matrix holds Latin-1 characters only, and “${ch}” is not one. Use a QR code for other alphabets.`);
    return c;
  });
  const cw: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i], d = bytes[i + 1];
    const digit = (x: number) => x >= 48 && x <= 57;
    if (digit(c) && d !== undefined && digit(d)) { cw.push(130 + (c - 48) * 10 + (d - 48)); i++; }
    else if (c < 128) cw.push(c + 1);
    else { cw.push(235); cw.push(c - 127); }
  }
  const spec = DM_SIZES.find((s) => s[1] >= cw.length);
  if (!spec) throw new Error(`The text is too long for a Data Matrix here: it needs ${cw.length} codewords and at most ${DM_CAPACITY} fit. Shorten it.`);
  const [side, nData, nEcc, regions] = spec;
  if (cw.length < nData) cw.push(129);
  while (cw.length < nData) { const v = 129 + ((149 * (cw.length + 1)) % 253) + 1; cw.push(v > 254 ? v - 254 : v); }
  const all = cw.concat(rsRemainder(cw, rsDivisor(nEcc, 0x12d, 1), 0x12d));

  // where each bit of each codeword goes in the mapping grid (the standard's placement, annex F)
  const n = side - 2 * regions, grid = new Array<number>(n * n).fill(0);
  const module = (r: number, c: number, chr: number, bit: number) => {
    if (r < 0) { r += n; c += 4 - ((n + 4) % 8); }
    if (c < 0) { c += n; r += 4 - ((n + 4) % 8); }
    grid[r * n + c] = 10 * chr + bit;
  };
  const utah = (r: number, c: number, chr: number) => {
    module(r - 2, c - 2, chr, 1); module(r - 2, c - 1, chr, 2); module(r - 1, c - 2, chr, 3); module(r - 1, c - 1, chr, 4);
    module(r - 1, c, chr, 5); module(r, c - 2, chr, 6); module(r, c - 1, chr, 7); module(r, c, chr, 8);
  };
  const corner = (cells: [number, number][], chr: number) => cells.forEach(([r, c], i) => module(r, c, chr, i + 1));
  let chr = 1, row = 4, col = 0;
  do {
    if (row === n && col === 0) corner([[n - 1, 0], [n - 1, 1], [n - 1, 2], [0, n - 2], [0, n - 1], [1, n - 1], [2, n - 1], [3, n - 1]], chr++);
    if (row === n - 2 && col === 0 && n % 4) corner([[n - 3, 0], [n - 2, 0], [n - 1, 0], [0, n - 4], [0, n - 3], [0, n - 2], [0, n - 1], [1, n - 1]], chr++);
    if (row === n - 2 && col === 0 && n % 8 === 4) corner([[n - 3, 0], [n - 2, 0], [n - 1, 0], [0, n - 2], [0, n - 1], [1, n - 1], [2, n - 1], [3, n - 1]], chr++);
    if (row === n + 4 && col === 2 && !(n % 8)) corner([[n - 1, 0], [n - 1, n - 1], [0, n - 3], [0, n - 2], [0, n - 1], [1, n - 3], [1, n - 2], [1, n - 1]], chr++);
    do { if (row < n && col >= 0 && !grid[row * n + col]) utah(row, col, chr++); row -= 2; col += 2; } while (row >= 0 && col < n);
    row += 1; col += 3;
    do { if (row >= 0 && col < n && !grid[row * n + col]) utah(row, col, chr++); row += 2; col -= 2; } while (row < n && col >= 0);
    row += 3; col += 1;
  } while (row < n || col < n);
  if (!grid[n * n - 1]) { grid[n * n - 1] = 1; grid[n * n - n - 2] = 1; }

  const dark: boolean[][] = Array.from({ length: side }, () => new Array<boolean>(side).fill(false));
  const per = n / regions;   // data modules a side in one region
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const v = grid[r * n + c];
    const on = v === 1 || (v > 1 && ((all[Math.floor(v / 10) - 1] >>> (8 - (v % 10))) & 1) !== 0);
    dark[r + 1 + 2 * Math.floor(r / per)][c + 1 + 2 * Math.floor(c / per)] = on;
  }
  // each region's frame: solid along its left and bottom, alternating along its top and right
  const span = per + 2;
  for (let R = 0; R < regions; R++) for (let C = 0; C < regions; C++) for (let i = 0; i < span; i++) {
    const r0 = R * span, c0 = C * span;
    dark[r0 + i][c0] = true; dark[r0 + span - 1][c0 + i] = true;
    dark[r0][c0 + i] = i % 2 === 0; dark[r0 + i][c0 + span - 1] = i % 2 === 1;
  }
  return { size: side, dark };
}

// ---------------------------------------------------------------- modules → rectangles

/**
 * The dark modules gathered into rectangles (x, y, width, height in modules, y down from the top): each run of
 * a row is grown downwards while the rows below have the same run, so a code is a few hundred boxes at most.
 */
export function moduleRectangles(m: CodeMatrix, dark = true): [number, number, number, number][] {
  const used = m.dark.map((r) => r.map(() => false)), out: [number, number, number, number][] = [];
  for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) {
    if (used[y][x] || m.dark[y][x] !== dark) continue;
    let w = 1; while (x + w < m.size && !used[y][x + w] && m.dark[y][x + w] === dark) w++;
    let h = 1;
    for (; y + h < m.size; h++) { let ok = true; for (let k = 0; k < w && ok; k++) ok = !used[y + h][x + k] && m.dark[y + h][x + k] === dark; if (!ok) break; }
    for (let j = 0; j < h; j++) for (let k = 0; k < w; k++) used[y + j][x + k] = true;
    out.push([x, y, w, h]);
  }
  return out;
}
