import { api as fab } from "../fab/index";
import type { FabContext } from "../fab/index";
import { buildNetlist, type NetlistHelpers } from "../canvas/pcb-netlist";
import { foldOps } from "./compact";

interface BoardTools {
  designSettings: typeof import("../tools/pcb-tools/drc").designSettings;
  netclassOf: typeof import("../tools/pcb-tools/drc").netclassOf;
  netlist: typeof import("../tools/pcb-tools/netlist").netlist;
}

/** Repair only the split ground introduced by updating the original demo PCB in the web editor. */
export async function repairDemoGround(
  K: typeof import("../canvas/index").api,
  h: { symbolPins: NetlistHelpers["symbolPins"]; isPowerSymbol(doc: KDoc, id: string): boolean },
  P: BoardTools,
  boardText: string,
  schematicText: string,
  project: string,
) {
  const board = K.parseDoc(boardText, "kicad_pcb"), schematic = K.parseDoc(schematicText, "kicad_sch");
  if (board.items.get("4a4bed39-1791-4bb3-a387-a23b13ba6008")?.ref !== "U8") return null;
  const uuid = K.str(K.kid(K.parse(schematicText)!, "uuid")?.[1]);
  if (!uuid || [...schematic.items.values()].some((item) => item.kind === "sheet")) return null;
  const netlist = buildNetlist({ doc: schematic as unknown as KDoc, uuid, file: "Devboard_Demo.kicad_sch" }, () => null, {
    symbolPins: h.symbolPins,
    isPower: (doc, item) => h.isPowerSymbol(doc, K.str(K.kid(item.node, "lib_id")?.[1])),
  }, "Devboard_Demo");
  if (!netlist.nets.has("GND") || netlist.nets.has("/GND")) return null;

  const components = new Map(netlist.components.map((component) => [component.ref, component]));
  const changes: KChange[] = [], zones: string[] = [];
  let pads = 0;
  for (const item of board.items.values()) {
    if (item.kind === "footprint") {
      const original = K.kids(item.node, "pad");
      const split = original.filter((pad) => K.kid(pad, "net")?.[1] === "/GND");
      if (!split.length) continue;
      const component = components.get(item.ref || "");
      if (!component || split.some((pad) => component.pins.get(K.str(pad[1]))?.net !== "GND")) return null;
      const node = K.cloneNode(item.node);
      for (const pad of K.kids(node, "pad")) {
        const net = K.kid(pad, "net");
        if (net?.[1] === "/GND") { net[1] = "GND"; pads++; }
      }
      changes.push(K.replaceChange(board, { ...item, node }));
    } else {
      const net = K.kid(item.node, "net")?.[1];
      if (item.kind === "zone" && net === "GND") zones.push(item.id);
      if (net !== "/GND") continue;
      if (!["segment", "arc", "via"].includes(item.kind)) return null;
      const node = K.cloneNode(item.node);
      K.kid(node, "net")![1] = "GND";
      changes.push(K.replaceChange(board, { ...item, node }));
    }
  }
  if (!pads || !zones.length) return null;

  for (const change of changes) if (!K.applyChange(board, change, 1e6)) throw new Error("Could not apply the ground repair");
  const settings = P.designSettings(project || null);
  const setup = K.kid(K.parse(boardText)!, "setup");
  const fills = await fab.fillZones({ doc: board, setup } as unknown as FabContext, {
    netClearance: (net) => P.netclassOf(settings, net)?.clearance ?? settings.clearance,
    minClearance: settings.minClearance || 0, holeClearance: settings.holeClearance || 0, edgeClearance: settings.edgeClearance,
  }, zones);
  if (!fills?.length) throw new Error("Could not refill the repaired ground zones");
  for (const fill of fills) {
    const item = board.items.get(fill.id)!;
    const node = fab.filledZoneNode(item.node, fill, board.copper, K.cloneNode);
    changes.push(K.replaceChange(board, { ...item, node }));
  }
  const folded = foldOps(K, "kicad_pcb", boardText, [{ changes }]);
  if (!folded.ok) throw new Error("Could not fold the ground repair");
  const verified = K.parseDoc(folded.text, "kicad_pcb");
  const gnd = P.netlist(verified as unknown as KDoc).nets.get("GND");
  if (!gnd || gnd.clusters.filter((cluster) => cluster.items.some((item) => item.kind === "pad")).length !== 1)
    throw new Error("Repaired ground pads do not form one connected group");
  return { text: folded.text, pads };
}
