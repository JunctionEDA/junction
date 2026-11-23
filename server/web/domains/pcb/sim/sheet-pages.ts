// sheet-pages.ts — the page numbers eeschema shows after loading a schematic: SCHEMATIC::BuildSheetListSortedByPageNumbers
// (each top-level sheet's hierarchy walked on its own, then SCH_SHEET_LIST::SortByPageNumbers) followed by
// SCH_SHEET_LIST::SetInitialPageNumbers / RepairPageNumbers (files-io.cpp, eeschema_helpers.cpp).  A file that stores
// the same page twice ("#" on every top-level sheet of an Altium import) is shown with the duplicates renumbered.
import { comparePageNum } from "./netlist-kicad";

/** One sheet instance: the uuids of its path (top-level sheet first, then each sheet symbol), the page number the files
 *  give it and its virtual page number (1 for a top-level sheet, then the depth-first walk below it). */
export interface PageSheet { uuids: string[]; page: string; virt: number }

const M64 = (1n << 64n) - 1n, GOLDEN = 0x9e3779b9n;
/** hash_combine( seed, v ): seed ^= v + 0x9e3779b9 + ( seed << 6 ) + ( seed >> 2 ), in size_t. */
const combine = (seed: bigint, v: bigint): bigint => (seed ^ ((v + GOLDEN + ((seed << 6n) & M64) + (seed >> 2n)) & M64)) & M64;
/** KIID::Hash, boost::uuids::hash_value (Boost before 1.86, the Linux release's): the 16 bytes combined in order. */
function uuidHash(u: string): bigint {
  const hex = u.replace(/-/g, ""); let seed = 0n;
  for (let i = 0; i + 1 < hex.length && i < 32; i += 2) seed = combine(seed, BigInt(parseInt(hex.slice(i, i + 2), 16) || 0));
  return seed;
}
/** SCH_SHEET_PATH::GetCurrentHash: the path's sheet uuids combined. */
export function pathHash(uuids: string[]): bigint { let h = 0n; for (const u of uuids) h = combine(h, uuidHash(u)); return h; }

/**
 * The sheets in SortByPageNumbers order (page, then virtual page, then path hash) and the page each shows once loaded:
 * all empty -> 1, 2, 3 … in that order; otherwise the first sheet to claim a page keeps it and every later duplicate
 * or empty one takes the lowest unused number.  `pages[i]` is the shown page of `list[i]`.
 */
export function repairPageNumbers(list: PageSheet[]): { pages: string[]; order: number[] } {
  const hashes = list.map((s) => pathHash(s.uuids));
  const order = list.map((_s, i) => i).sort((a, b) => comparePageNum(list[a].page, list[b].page) || list[a].virt - list[b].virt || (hashes[a] < hashes[b] ? -1 : hashes[a] > hashes[b] ? 1 : 0));
  const pages = list.map((s) => s.page);
  if (list.every((s) => !s.page)) { order.forEach((i, k) => { pages[i] = String(k + 1); }); return { pages, order }; }
  const reserved = new Set(list.map((s) => s.page).filter((p) => !!p)), assigned = new Set<string>();
  let next = 1;
  for (const i of order) {
    const p = list[i].page;
    if (p && !assigned.has(p)) { assigned.add(p); continue; }
    while (reserved.has(String(next)) || assigned.has(String(next))) next++;
    pages[i] = String(next); assigned.add(pages[i]); next++;
  }
  return { pages, order };
}

/** A node of the sheet tree (the hierarchy navigator's): its name, page number and children; `virtual` marks the hidden project root. */
export interface PageTreeNode<T> { name: string; page: string; children: T[]; virtual?: boolean }
/**
 * SCHEMATIC::Hierarchy(): every sheet instance in the walk's order, sorted by page number
 * (SCH_SHEET_LIST::SortByPageNumbers: ComparePageNum, then the virtual page number).  `human` is the instance's path.
 */
export function sheetsByPage<T extends PageTreeNode<T>>(tree: T | null): { node: T; human: string }[] {
  const list: { node: T; human: string }[] = [], chain: string[] = [];
  const walk = (n: T): void => {
    if (!n.virtual) list.push({ node: n, human: "/" + chain.map((x) => x + "/").join("") });
    for (const c of n.children) { chain.push(c.name); walk(c); chain.pop(); }
  };
  if (tree) walk(tree);
  return list.map((x, i) => ({ x, i })).sort((a, b) => comparePageNum(a.x.node.page || "", b.x.node.page || "") || a.i - b.i).map((e) => e.x);
}

/**
 * HIERARCHY_TREE::OnCompareItems under HIERARCHY_PANE::buildHierarchyTree's SortChildren: the sub-sheets of every sheet
 * in page order (SCH_SHEET_PATH::ComparePageNum: integers numerically and before any other page, the rest by
 * StrNumCmp), sheets on the same page keeping the order of the file.  The top-level sheets under the hidden project
 * root are not sorted (UpdateHierarchyTree appends them in the project's order).  Sorts in place.
 */
export function sortTreeByPage<T extends PageTreeNode<T>>(tree: T | null): T | null {
  const walk = (n: T): void => {
    if (!n.virtual && n.children.length > 1) n.children = n.children.map((c, i) => ({ c, i })).sort((a, b) => comparePageNum(a.c.page || "", b.c.page || "") || a.i - b.i).map((e) => e.c);
    for (const c of n.children) walk(c);
  };
  if (tree) walk(tree);
  return tree;
}
