// _batch.ts — exporting every part to a file of its own in one go: what each file is called (a naming template),
// and the .zip they are handed over in.  Pure; tools/export-all.tsx runs the exports.
//
// The template's words: {document} the part studio's name, {part} the part's name, {n} its number in the list
// (padded so the files sort), {count} how many parts there are, {date} today (2026-03-09).  Anything else stays
// as typed.

export const TEMPLATE_WORDS = ["document", "part", "n", "count", "date"] as const;
export const DEFAULT_TEMPLATE = "{document} - {part}";

export interface NameFacts { document: string; part: string; index: number; count: number; date: string }

/** A name a file system takes: no path separators or reserved marks, no trailing dots or spaces. */
export function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const c = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim();
  return c.slice(0, 120) || "part";
}

export function expandTemplate(template: string, f: NameFacts): string {
  const width = String(Math.max(1, f.count)).length;
  const words: { [key: string]: string } = { document: f.document, part: f.part, n: String(f.index + 1).padStart(width, "0"), count: String(f.count), date: f.date };
  return template.replace(/\{([a-z]+)\}/gi, (whole, key: string) => (key.toLowerCase() in words ? words[key.toLowerCase()] : whole));
}

/** The words of a template that are not ones it knows ("{parts}"), for the dialog to point at. */
export function unknownWords(template: string): string[] {
  const out: string[] = [];
  template.replace(/\{([a-z]+)\}/gi, (whole, key: string) => { if (!(TEMPLATE_WORDS as readonly string[]).includes(key.toLowerCase()) && !out.includes(whole)) out.push(whole); return whole; });
  return out;
}

export const isoDate = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The file name of each part, with the extension.  Two parts that would get the same name (a template without
 * {part} or {n}, two parts called the same) are told apart with " (2)", " (3)": no file overwrites another.
 */
export function batchNames(template: string, document: string, parts: readonly { name: string }[], ext: string, date = isoDate(new Date())): string[] {
  const seen = new Map<string, number>();
  return parts.map((p, index) => {
    const base = cleanName(expandTemplate(template.trim() || DEFAULT_TEMPLATE, { document, part: p.name, index, count: parts.length, date }));
    const key = base.toLowerCase(), n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return `${n > 1 ? `${base} (${n})` : base}${ext}`;
  });
}

// ---------------------------------------------------------------- a .zip, stored (no compression)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry { name: string; data: Uint8Array | string }

/** A .zip of the files as they are (stored: CAD files are opened, not archived, and the browser need not deflate megabytes). */
export function zipStore(files: readonly ZipEntry[], when = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1), date = ((Math.max(1980, when.getFullYear()) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const parts = files.map((f) => { const data = typeof f.data === "string" ? enc.encode(f.data) : f.data; return { name: enc.encode(f.name), data, crc: crc32(data) }; });
  const size = parts.reduce((n, p) => n + 30 + p.name.length + p.data.length + 46 + p.name.length, 22);
  const out = new Uint8Array(size), view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  for (const p of parts) {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true); view.setUint16(at + 4, 20, true); view.setUint16(at + 6, 0x0800, true); view.setUint16(at + 8, 0, true);
    view.setUint16(at + 10, time, true); view.setUint16(at + 12, date, true); view.setUint32(at + 14, p.crc, true);
    view.setUint32(at + 18, p.data.length, true); view.setUint32(at + 22, p.data.length, true); view.setUint16(at + 26, p.name.length, true); view.setUint16(at + 28, 0, true);
    out.set(p.name, at + 30); out.set(p.data, at + 30 + p.name.length);
    at += 30 + p.name.length + p.data.length;
  }
  const dir = at;
  parts.forEach((p, i) => {
    view.setUint32(at, 0x02014b50, true); view.setUint16(at + 4, 20, true); view.setUint16(at + 6, 20, true); view.setUint16(at + 8, 0x0800, true); view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, time, true); view.setUint16(at + 14, date, true); view.setUint32(at + 16, p.crc, true);
    view.setUint32(at + 20, p.data.length, true); view.setUint32(at + 24, p.data.length, true); view.setUint16(at + 28, p.name.length, true);
    view.setUint32(at + 42, offsets[i], true);
    out.set(p.name, at + 46);
    at += 46 + p.name.length;
  });
  view.setUint32(at, 0x06054b50, true); view.setUint16(at + 8, parts.length, true); view.setUint16(at + 10, parts.length, true);
  view.setUint32(at + 12, at - dir, true); view.setUint32(at + 16, dir, true);
  return out;
}
