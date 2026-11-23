// diff.ts — the difference between two texts, line by line: what the assistant's proposal changes.  Pure.

export interface DiffLine { kind: "same" | "add" | "del"; text: string; /** line numbers in the old and the new text */ a?: number; b?: number }

/** Lines kept, removed and added, in order (longest common subsequence; scripts are a few hundred lines). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n"), b = after.split("\n");
  // trim what both share at the ends: the table below is only for the middle
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail), y = b.slice(head, b.length - tail);
  const n = x.length, m = y.length;
  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ kind: "same", text: a[i], a: i + 1, b: i + 1 });
  if (n * m > 4_000_000) {
    // too large to align: the whole middle as removed then added
    x.forEach((text, i) => out.push({ kind: "del", text, a: head + i + 1 }));
    y.forEach((text, j) => out.push({ kind: "add", text, b: head + j + 1 }));
  } else {
    const w = m + 1, lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) { out.push({ kind: "same", text: x[i], a: head + i + 1, b: head + j + 1 }); i++; j++; }
      else if (j < m && (i >= n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) { out.push({ kind: "add", text: y[j], b: head + j + 1 }); j++; }
      else { out.push({ kind: "del", text: x[i], a: head + i + 1 }); i++; }
    }
  }
  for (let k = 0; k < tail; k++) out.push({ kind: "same", text: a[a.length - tail + k], a: a.length - tail + k + 1, b: b.length - tail + k + 1 });
  return out;
}

export function diffStat(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of lines) { if (l.kind === "add") added++; else if (l.kind === "del") removed++; }
  return { added, removed };
}

/** The changed lines with a few unchanged ones round them; `gap` marks where lines were left out. */
export function hunks(lines: readonly DiffLine[], context = 3): (DiffLine | { kind: "gap"; count: number })[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => { if (l.kind !== "same") for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = 1; });
  const out: (DiffLine | { kind: "gap"; count: number })[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) { if (skipped) { out.push({ kind: "gap", count: skipped }); skipped = 0; } out.push(l); }
    else skipped++;
  });
  if (skipped) out.push({ kind: "gap", count: skipped });
  return out;
}
