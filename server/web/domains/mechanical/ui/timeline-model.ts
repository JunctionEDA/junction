// timeline-model.ts — the features as a strip read from left to right (ui/Timeline.tsx): one cell per feature in
// build order, a folder as a bracket over its features or, folded, as one cell; the marker stands in the gap
// before the first feature that is not built.  Pure: the cells, where the marker is, and what a drag of it means.
import type { FeatureTree, TreeNode } from "../document/folders";

export type TimelineCell =
  | { kind: "feature"; id: string; index: number; /** the open folders it stands under, outermost first */ under: string[] }
  | { kind: "folder"; id: string; name: string; first: number; last: number; count: number; under: string[] };
/** an open folder: a bracket over the cells `from … to` (inclusive) */
export interface TimelineSpan { id: string; name: string; from: number; to: number; depth: number }
export interface TimelineLayout { cells: TimelineCell[]; spans: TimelineSpan[] }

export function timelineOf(tree: FeatureTree, folded: ReadonlySet<string> = new Set()): TimelineLayout {
  const cells: TimelineCell[] = [], spans: TimelineSpan[] = [];
  const walk = (nodes: readonly TreeNode[], under: string[]): void => {
    for (const n of nodes) {
      if (n.kind === "feature") { cells.push({ kind: "feature", id: n.feature.id, index: n.index, under }); continue; }
      if (folded.has(n.folder.id)) { cells.push({ kind: "folder", id: n.folder.id, name: n.folder.name, first: n.first, last: n.last, count: n.last - n.first + 1, under }); continue; }
      const from = cells.length;
      walk(n.children, [...under, n.folder.id]);
      if (cells.length > from) spans.push({ id: n.folder.id, name: n.folder.name, from, to: cells.length - 1, depth: under.length });
    }
  };
  walk(tree.roots, []);
  return { cells, spans };
}

/** the first feature a cell stands for, and one past the last */
const firstOf = (c: TimelineCell): number => (c.kind === "feature" ? c.index : c.first);
const endOf = (c: TimelineCell): number => (c.kind === "feature" ? c.index + 1 : c.last + 1);

/**
 * The gap the marker stands in: 0 before the first cell, `cells.length` after the last.  A rollback inside a
 * folded folder puts the marker before that folder's cell (`inside` says so: the cell is partly built).
 */
export function markerSlot(cells: readonly TimelineCell[], rollback: number): { slot: number; inside: boolean } {
  for (let i = 0; i < cells.length; i++) {
    if (rollback <= firstOf(cells[i])) return { slot: i, inside: false };
    if (rollback < endOf(cells[i])) return { slot: i, inside: true };
  }
  return { slot: cells.length, inside: false };
}

/** How many features are built with the marker in a gap. */
export function rollbackAt(cells: readonly TimelineCell[], slot: number, total: number): number {
  const s = Math.max(0, Math.min(cells.length, Math.round(slot)));
  return s >= cells.length ? total : firstOf(cells[s]);
}

/** The gap nearest a place along the strip: cells are `width` wide and start at `left`. */
export function slotAt(x: number, left: number, width: number, count: number): number {
  return Math.max(0, Math.min(count, Math.round((x - left) / width)));
}

/** Whether a cell is built with `rollback` features built ("part": a folded folder the marker is inside). */
export function cellBuilt(c: TimelineCell, rollback: number): "yes" | "no" | "part" {
  return endOf(c) <= rollback ? "yes" : firstOf(c) >= rollback ? "no" : "part";
}
