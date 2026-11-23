// pcb-tools/nets.ts — nets as items reference them.
import type { NetRef } from "./types";
import { K } from "./state";

// ---------------------------------------------------------------- nets
// Boards from this build reference nets by name — (net "GND") — while older
// ones carry (net 3 "GND") on pads and (net 3) on tracks; both are understood
// and new items are written in the form of the document's file version.
export function netOf(node: SNode | null | undefined): NetRef {
  const n = node && K.kid(node, "net"); if (!n) return { code: 0, name: "" };
  if (typeof n[1] === "number") return { code: n[1], name: n.length > 2 ? K.str(n[2]) : "" };
  return { code: -1, name: K.str(n[1]) };
}
export const NET_STYLE = new WeakMap<KDoc, string>();
export function netStyle(doc: KDoc) {
  // PCB_IO_KICAD_SEXPR::formatNetRef: a board kept at a version before 20251028 is written with net codes, a newer one by name
  // (a pre-20251028 file whose items are already written by name, which KiCad's reader would refuse, keeps that form
  // rather than getting codes mixed into it)
  const v = Number((doc as KDoc & { version?: number }).version) || 0;
  if (v >= 20251028) return "name";
  if (NET_STYLE.has(doc)) return NET_STYLE.get(doc);
  let style: string | null = null;
  for (const it of doc.items.values()) {
    const probe = it.kind === "footprint" ? K.kid(it.node, "pad") : (it.kind === "segment" || it.kind === "via" || it.kind === "arc") ? it.node : null;
    const n = probe && K.kid(probe, "net"); if (!n) continue;
    style = typeof n[1] === "number" ? "code" : "name"; break;
  }
  if (!style) return v > 0 ? "code" : "name";   // nothing on a net yet: the version's form, else: this build's own form, and not remembered, so the first netted item decides
  NET_STYLE.set(doc, style); return style;
}
export function netNode(doc: KDoc, net: NetRef | null | undefined): SNode { return netStyle(doc) === "name" ? ["net", net && net.name ? net.name : ""] : ["net", net && net.code > 0 ? net.code : 0]; }
export const hasNet = (n: NetRef | null | undefined): n is NetRef => !!(n && (n.name || n.code > 0));
export const sameNet = (a: NetRef | null | undefined, b: NetRef | null | undefined) => hasNet(a) && hasNet(b) && (a.name && b.name ? a.name === b.name : a.code === b.code);

// ---------------------------------------------------------------- net chains (NETINFO_ITEM::GetNetChain / GetTerminalPad)
interface BoardChain { chain: string; pads: [string | null, string | null] }
interface ChainsApi { parseBoardChains(node: SNode | null | undefined, nets: Map<number, string>): Map<string, BoardChain> }
const CHAINS = new WeakMap<KDoc, { node: SNode | null | undefined; size: number; map: Map<string, BoardChain> }>();
/** The board's nets with a chain or a terminal pad, by net name (the (net_chains …) section as the parser reads it). */
export function boardChains(doc: KDoc): Map<string, BoardChain> {
  const node = (doc as KDoc & { netChainsNode?: SNode | null }).netChainsNode, nets = (doc.nets || new Map()) as Map<number, string>;
  const was = CHAINS.get(doc); if (was && was.node === node && was.size === nets.size) return was.map;
  const api = (K as unknown as { netChains?: ChainsApi }).netChains;
  const map = api && node ? api.parseBoardChains(node, nets) : new Map<string, BoardChain>();
  CHAINS.set(doc, { node, size: nets.size, map });
  return map;
}
/** NETINFO_ITEM::GetNetChain of the net named `net`: "" when it is on none. */
export function netChainOf(doc: KDoc | null | undefined, net: string): string {
  if (!doc || !net) return ""; const c = boardChains(doc).get(net); return c ? c.chain : "";
}
/** The board's nets whose chain is `chain`, in net-code order (BOARD::GetNetInfo). */
export function chainNets(doc: KDoc, chain: string): string[] {
  if (!chain) return [];
  const m = boardChains(doc), out: string[] = [];
  for (const [, name] of [...((doc.nets || new Map()) as Map<number, string>)].sort((a, b) => a[0] - b[0])) { const c = m.get(name); if (c && c.chain === chain) out.push(name); }
  return out;
}
