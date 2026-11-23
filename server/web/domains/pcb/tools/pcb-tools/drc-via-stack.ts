// pcb-tools/drc-via-stack.ts — DRC_TEST_PROVIDER_VIA_STACK (pcbnew/drc/drc_test_provider_via_stack.cpp): microvia
// stack spans (malformed_microvia_stack_span), stacked microvia columns (microvia_stack_depth from the custom rules,
// microvia_stack_not_filled), and whether the copper can be built: hole_aspect_ratio for every plated hole (custom
// rules only), microvia_crosses_core and microvia_spans_dielectrics from the board stackup (or the default one).
import type { BoardDoc, DesignSettings, DrcMarker } from "./types";
import type { DruRule } from "./dru";
import type { RuleItem } from "./dru-eval";
import { evalRuleConstraint } from "./dru";
import { marker, ruled, withKiids } from "./drc";
import { groupMembers } from "./groups";
import { copperStack, stackupItems } from "./net-lengths";
import type { StackItem } from "./net-lengths";
import { padsOf } from "./route-geom";
import { viaTypeOf } from "./dru-eval";
import { K } from "./state";
import { pt } from "./util";
import { boardFillsVias, isSpanValid, isViaStack, layerRange, viaStackInfo } from "./via-stack";

/** BOARD::GetStackupOrDefault's copper and dielectric items (net-lengths.ts stackupItems). */
export type StackupEntry = StackItem;
export const stackupEntries = (setup: SNode | null, general: SNode | null, copper: string[]): StackupEntry[] => stackupItems(general, setup, copper);
/** stackThickness: the dielectrics (every sub-layer) and copper of items [first, last). */
function stackThickness(stack: StackupEntry[], first: number, last: number) { let t = 0; for (let i = first; i < last; i++) { const it = stack[i]; t += it.kind === "dielectric" ? it.th.reduce((a, b) => a + b, 0) : it.th[0]; } return t; }

const viaLayers = (n: SNode) => (K.kid(n, "layers") || []).slice(1).map((x) => K.str(x));
const drillOf = (n: SNode) => K.num((K.kid(n, "drill") || [0, 0])[1], 0);
const outer = (l: string | null) => l === "F.Cu" || l === "B.Cu";
const yes = (n: SNode, k: string): boolean | null => { const c = K.kid(n, k); return c ? K.str(c[1]) === "yes" : null; };
const viaMarker = (code: string, sev: string, it: KItem, text: string) => { const p = pt(it.node, "at") || [0, 0]; return withKiids(marker(code, sev, p[0], p[1], text, [it.id]), [it.id]); };

/** PCB_VIA::CollectMicroviaColumns: microvias resting on one another (holes touching across a landing layer), top down. */
export function microviaColumns(doc: BoardDoc, copper: string[]): KItem[][] {
  const ord = new Map<string, number>(); copperStack(copper).forEach((l, i) => ord.set(l, i));
  const vias: { it: KItem; up: number; low: number; at: number[]; drill: number }[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "via" || viaTypeOf(it.node) !== "micro") continue;
    const ls = viaLayers(it.node); const a = ord.get(ls[0]), b = ord.get(ls[ls.length - 1]);
    if (a === undefined || b === undefined || a === b) continue;
    vias.push({ it, up: Math.min(a, b), low: Math.max(a, b), at: pt(it.node, "at") || [0, 0], drill: drillOf(it.node) });
  }
  type V = typeof vias[number];
  const below = (v: V): V | null => { for (const o of vias) if (o !== v && o.up === v.low && Math.hypot(v.at[0] - o.at[0], v.at[1] - o.at[1]) <= (v.drill + o.drill) / 2 + 1e-9) return o; return null; };
  const carried = new Set<V>(); for (const v of vias) { const u = below(v); if (u) carried.add(u); }
  const cols: KItem[][] = [], taken = new Set<V>();
  for (const v of vias) {
    if (carried.has(v)) continue;
    const col: KItem[] = []; let lands = false;
    for (let s: V | null = v; s; s = below(s)) { if (taken.has(s)) { lands = true; break; } taken.add(s); col.push(s.it); if (col.length > ord.size) break; }
    if (col.length > 1 || lands) cols.push(col);
  }
  return cols;
}

/** DRC_TEST_PROVIDER_VIA_STACK::Run. */
export function viaStackMarkers(doc: BoardDoc, s: DesignSettings, rules: DruRule[], setup: SNode | null, general: SNode | null): DrcMarker[] {
  const out: DrcMarker[] = [], copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const sevOf = (code: string, d: string) => (s.severities && s.severities[code]) || d;
  const on = (code: string, d: string) => sevOf(code, d) !== "ignore";
  const ruleOfItem = (type: string, A: RuleItem) => (rules.length ? evalRuleConstraint(rules, type, doc, s, A, null) : null);
  const ruleOf = (type: string, it: KItem) => ruleOfItem(type, { kind: it.kind, node: it.node, layer: null, item: it, id: it.id });
  // checkSpan: a stack's hops must still tile the span it declares, one layer step each
  if (on("malformed_microvia_stack_span", "error")) for (const gen of doc.items.values()) {
    if (!isViaStack(gen)) continue;
    const vias = groupMembers(gen.node).map((id) => doc.items.get(id)).filter((m): m is KItem => !!m && m.kind === "via" && viaTypeOf(m.node) === "micro");
    if (!vias.length) continue;
    const st = viaStackInfo(doc, gen.node);
    const bad = () => out.push(withKiids(marker("malformed_microvia_stack_span", "error", st.origin[0], st.origin[1], "Microvia stack has malformed span", [gen.id]), [gen.id]));
    if (!isSpanValid(doc, st.start, st.end)) { bad(); continue; }
    const idx = new Map<string, number>(); layerRange(doc, st.start, st.end).forEach((l, i) => idx.set(l, i));
    const covered = new Set<number>(); let broken = false;
    for (const v of vias) {
      const ls = viaLayers(v.node), t = idx.get(ls[0]), b = idx.get(ls[ls.length - 1]);
      if (t === undefined || b === undefined || Math.abs(t - b) !== 1) { broken = true; break; }
      const m = Math.min(t, b); if (covered.has(m)) { broken = true; break; } covered.add(m);
    }
    if (broken || covered.size !== idx.size - 1) bad();
  }
  // checkLooseMicrovias / checkColumn: the depth rule on each column's top via, then every via of it unfilled
  if (on("microvia_stack_depth", "error") || on("microvia_stack_not_filled", "warning")) {
    const fills = boardFillsVias(Object.assign({}, doc, { setupNode: setup }) as BoardDoc);
    for (const col of microviaColumns(doc, copper)) {
      const top = col[0]; const h = ruleOf("microvia_stack_depth", top);
      if (on("microvia_stack_depth", "error") && h && h.severity !== "ignore" && h.max != null && col.length > h.max) {
        const m = viaMarker("microvia_stack_depth", "error", top, `Microvia stack too deep (Stack is ${col.length} hops deep, limit is ${Math.trunc(h.max)})`);
        m.rule = h.name.replace(/^rule '([\s\S]*)'$/, "$1"); out.push(ruled(m, h.severity));
      }
      if (on("microvia_stack_not_filled", "warning")) for (const v of col) { const f = yes(v.node, "filling"); if (!(f !== null ? f : fills)) out.push(viaMarker("microvia_stack_not_filled", "warning", v, "Microvia under microvia not filled")); }
    }
  }
  // checkConstructability
  const checkRatio = on("hole_aspect_ratio", "error") && rules.some((r) => r.constraints.some((c) => c.type === "hole_aspect_ratio"));
  const checkCore = on("microvia_crosses_core", "warning"), checkDiel = on("microvia_spans_dielectrics", "warning");
  if (!checkRatio && !checkCore && !checkDiel) return out;
  const stack = stackupEntries(setup, general, copper);
  const ratioMarker = (it: KItem, x: number, y: number, ratio: number) => {
    const h = ruleOf("hole_aspect_ratio", it); if (!h || h.severity === "ignore" || h.max == null) return;
    const limit = h.max; if (!(limit > 0) || ratio <= limit) return;
    const m = withKiids(marker("hole_aspect_ratio", "error", x, y, `Hole too deep for its diameter (Aspect ratio ${ratio.toFixed(2)} exceeds the ${limit.toFixed(2)} limit)`, [it.id]), [it.id]);
    m.rule = h.name.replace(/^rule '([\s\S]*)'$/, "$1"); out.push(ruled(m, h.severity));
  };
  for (const it of doc.items.values()) {
    if (it.kind !== "via") continue;
    const ls = viaLayers(it.node), top = ls[0], bot = ls[ls.length - 1];
    let first = -1, last = -1;
    stack.forEach((e, i) => { if (e.kind === "copper" && (e.layer === top || e.layer === bot)) { if (first < 0) first = i; else last = i; } });
    if (first < 0 || last < 0) continue;
    const micro = viaTypeOf(it.node) === "micro";
    if (micro && checkCore) for (let i = first + 1; i < last; i++) if (stack[i].kind === "dielectric" && stack[i].typeName === "core") { out.push(viaMarker("microvia_crosses_core", "warning", it, `Microvia crosses core material (The stackup gives the dielectric between ${top} and ${bot} as core)`)); break; }
    if (micro && checkDiel) {
      let n = 0; for (let i = first + 1; i < last; i++) if (stack[i].kind === "dielectric") n++;
      if (n > 1) out.push(viaMarker("microvia_spans_dielectrics", "warning", it, `Microvia spans more than one dielectric (The stackup gives ${n} dielectrics between ${top} and ${bot})`));
    }
    const drill = drillOf(it.node); if (!checkRatio || drill <= 0) continue;
    const topExt = outer(stack[first].layer), botExt = outer(stack[last].layer), fromBack = botExt && !topExt;
    let thickness = stackThickness(stack, first + 1, last) + stack[fromBack ? last : first].th[0];
    if (!micro && topExt === botExt) thickness += stack[fromBack ? first : last].th[0];
    const p = pt(it.node, "at") || [0, 0]; ratioMarker(it, p[0], p[1], thickness / drill);
  }
  if (!checkRatio) return out;
  const depth = stackThickness(stack, 0, stack.length);
  for (const fp of doc.items.values()) {
    if (fp.kind !== "footprint") continue;
    for (const pad of padsOf(fp)) {
      if (pad.type !== "thru_hole") continue;
      const d = K.kid(pad.node, "drill"); if (!d) continue;
      const nums = d.slice(1).filter((x) => !Array.isArray(x) && x !== "oval").map((x) => K.num(x, 0));
      const drill = nums.length > 1 ? Math.min(nums[0], nums[1]) : nums.length ? nums[0] : 0; if (drill <= 0) continue;   // a slot: its narrow side
      const h = ruleOfItem("hole_aspect_ratio", { kind: "pad", node: pad.node, layer: null, parent: fp }); if (!h || h.severity === "ignore" || h.max == null) continue;
      const limit = h.max, ratio = depth / drill; if (!(limit > 0) || ratio <= limit) continue;
      const m = withKiids(marker("hole_aspect_ratio", "error", pad.x, pad.y, `Hole too deep for its diameter (Aspect ratio ${ratio.toFixed(2)} exceeds the ${limit.toFixed(2)} limit)`, [fp.id]), [fp.id]);
      m.rule = h.name.replace(/^rule '([\s\S]*)'$/, "$1"); out.push(ruled(m, h.severity));
    }
  }
  return out;
}
