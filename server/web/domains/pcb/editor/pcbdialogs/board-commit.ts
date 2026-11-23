// pcbdialogs/board-commit — what BOARD_COMMIT::Push does to a board edit before it lands (board_commit.cpp): the
// teardrops of the pads, vias and tracks the edit touched are rebuilt in the same undo step (TEARDROP_MANAGER's
// RemoveTeardrops / UpdateTeardrops), unless the commit says SKIP_TEARDROPS (the array's skipTeardrops flag).
import { E } from "../state";
import { addCommitRewriter } from "../tools";
import { parseProject, toPlain } from "../../canvas/project-file";

interface TdOpts { project?: unknown; settings?: unknown }
interface PcbToolsApi {
  designSettings(src: unknown): unknown;
  teardropCommitChanges(doc: KDoc, changes: KChange[], o: TdOpts): KChange[];
  teardropFullUpdate(doc: KDoc, o: TdOpts): KChange[];
  foldChanges(a: KChange[], b: KChange[]): KChange[];
  teardropAppliedDoc(doc: KDoc, changes: KChange[]): KDoc;
  viaStitch: {
    isViaStitch(it: KItem | null | undefined): boolean; readStitch(n: SNode): unknown; gridConfigOf(s: unknown): unknown; stitchOfVia(doc: KDoc, id: string): KItem | null;
    viaStitchUpdate(doc: KDoc, s: unknown, o: unknown, prev?: unknown, isNew?: boolean): { changes: KChange[] };
  };
}
const PT = (): PcbToolsApi | null => (window as unknown as { PcbTools?: PcbToolsApi }).PcbTools || null;
/** A commit's SKIP_TEARDROPS flag. */
export type TaggedChanges = KChange[] & { skipTeardrops?: boolean };
export function skipTeardrops(changes: KChange[]): TaggedChanges { return Object.assign(changes, { skipTeardrops: true }); }

let cache: { src: string | null; opts: TdOpts } | null = null;
/** The project's teardrop targets and design rules, as the teardrop manager reads them. */
export function teardropOpts(): TdOpts {
  const src = E.proSettings || null; if (cache && cache.src === src) return cache.opts;
  let project: unknown = null; try { project = src ? toPlain(parseProject(src)) : null; } catch (e) { project = null; }
  const pt = PT(); const opts: TdOpts = { project, settings: pt ? pt.designSettings(src) : null };
  cache = { src, opts }; return opts;
}
const boardDoc = (): KDoc | null => { const d = E.kdoc as KDoc | null; return d && d.type === "pcb" && !d.fpEditor ? d : null; };

/** TEARDROP_MANAGER::UpdateTeardrops( forceFullUpdate ) on the open board: the changes, or none. */
export function teardropRebuild(): KChange[] { const doc = boardDoc(), pt = PT(); return doc && pt ? pt.teardropFullUpdate(doc, teardropOpts()) : []; }

/** The BOARD_COMMIT::Push teardrop pass. */
function teardropPass(changes: KChange[]): KChange[] {
  const tag = changes as TaggedChanges; if (tag.skipTeardrops) return changes;
  const doc = boardDoc(), pt = PT(); if (!doc || !pt || E.viewOnly) return changes;
  const more = pt.teardropCommitChanges(doc, changes, teardropOpts());
  return more.length ? pt.foldChanges(changes, more) : changes;
}
/**
 * GENERATOR_TOOL's update of a moved or edited via stitch (genUpdate / PCB_VIA_STITCH::Update): a stitch whose node
 * the edit changed, or one whose via the edit moved, is updated in the same commit (the grid follows a moved via).
 */
function stitchPass(changes: KChange[]): KChange[] {
  const tag = changes as TaggedChanges & { stitchUpdated?: boolean }; if (tag.stitchUpdated) return changes;
  const doc = boardDoc(), pt = PT(); if (!doc || !pt || !pt.viaStitch || E.viewOnly) return changes;
  const vs = pt.viaStitch; const todo = new Map<string, KItem>(); const touched = new Set(changes.map((c) => c.id));
  for (const c of changes) {
    if (c.kind === "REMOVED") continue;
    const it = doc.items.get(c.id); if (!it) continue;
    if (vs.isViaStitch(it)) todo.set(it.id, it);
    else if (it.kind === "via" && c.kind === "MODIFIED") { const g = vs.stitchOfVia(doc, it.id); if (g && !todo.has(g.id) && !(touched.has(g.id) && changes.some((x) => x.id === g.id && x.kind === "REMOVED"))) todo.set(g.id, g); }
  }
  if (!todo.size) return changes;
  let out = changes; const post = pt.teardropAppliedDoc(doc, changes);
  for (const [id, before] of todo) {
    const now = post.items.get(id); if (!now || !vs.isViaStitch(now)) continue;
    const res = vs.viaStitchUpdate(post, vs.readStitch(now.node), { project: teardropOpts().project, settings: teardropOpts().settings }, vs.gridConfigOf(vs.readStitch(before.node)));
    out = pt.foldChanges(out, res.changes);
  }
  return out;
}
let installed = false;
export function installBoardCommitHooks(): void { if (installed) return; installed = true; addCommitRewriter(stitchPass); addCommitRewriter(teardropPass); }
