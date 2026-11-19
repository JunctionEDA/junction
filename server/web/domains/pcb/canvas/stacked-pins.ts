/** KiCad stacked pin numbers share escaping between their display and their footprint pad list. */
// Bound range expansion before allocating entries from an imported library.
const MAX_EXPANDED_PADS = 65536;
const special = "[],-\\";
const escapedAt = (s: string, i: number) => s[i] === "\\" && i + 1 < s.length && special.includes(s[i + 1]);
export const unescapePin = (s: string): string => s.replace(/\\([\[\],\\-])/g, "$1");

/** Return the authored items, keeping escapes so an escaped dash stays distinguishable from a range. */
export function stackedItems(number: string): string[] | null {
  if (!number.startsWith("[") || !number.endsWith("]")) return null;
  const parts: string[] = [], inner = number.slice(1, -1);
  let part = "";
  for (let i = 0; i < inner.length; i++) {
    if (escapedAt(inner, i)) part += inner[i] + inner[++i];
    else if (inner[i] === ",") { parts.push(part.trim()); part = ""; }
    else part += inner[i];
  }
  parts.push(part.trim());
  return parts;
}

/** ExpandStackedPinNotation: "[1,3-5,A1-A3]" (\, and \- escaped) → its pads; `valid` false for broken brackets or ranges. */
export function expandStacked(pad: string): { pins: string[]; valid: boolean } {
  const parts = stackedItems(pad);
  if (!parts) return { pins: [pad], valid: !pad.includes("[") && !pad.includes("]") };
  const alnum = (s: string): [string, number] => { const m = /^(.*?)(\d+)$/.exec(s); return m ? [m[1], Number(m[2])] : [s, -1]; };
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    let dash = -1; for (let i = 0; i < part.length; i++) { if (escapedAt(part, i)) { i++; continue; } if (part[i] === "-") { dash = i; break; } }
    if (dash >= 0) {
      const [sp, sv] = alnum(unescapePin(part.slice(0, dash)).trim()), [ep, ev] = alnum(unescapePin(part.slice(dash + 1)).trim());
      if (sp !== ep || sv === -1 || ev === -1 || sv > ev || !Number.isSafeInteger(ev) || ev - sv + out.length >= MAX_EXPANDED_PADS) return { pins: [pad], valid: false };
      for (let v = sv; v <= ev; v++) out.push(sp + v);
    } else out.push(unescapePin(part));
  }
  return out.length ? { pins: out, valid: true } : { pins: [pad], valid: false };
}
