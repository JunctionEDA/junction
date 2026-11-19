// Published construction dimensions are in mm. Nominal order thickness can differ from the sum.
import { copperNames, type StackupLayer } from "../../canvas/board-setup";
import { traceOn, widthFor } from "../../router/impedance";

const jlc = "https://jlcpcb.com/impedance/";
const pcbway = "https://www.pcbway.com/multi-layer-laminated-structure.html";
const jlcFlex = "https://jlcpcb.com/blog/fpc-thickness-guide";
const pcbwayFlex = "https://www.pcbway.com/pcb_prototype/Stack_up_for_FPC.html";
export const BOARD_TYPES = [
  ["rigid", "Rigid FR-4", jlc, pcbway],
  ["flex", "Flexible", jlcFlex, pcbwayFlex],
  ["hdi", "HDI", "https://jlcpcb.com/pcb-fabrication/hdi-pcb", "https://www.pcbway.com/hdi-pcb.html"],
  ["metal", "Aluminum / metal core", "https://jlcpcb.com/pcb-fabrication/metal-core-pcb", "https://www.pcbway.com/aluminum-pcb.html"],
  ["rigid-flex", "Rigid-flex", "", "https://www.pcbway.com/rigid-flex-pcb.html"],
  ["rf", "RF / high frequency", "https://jlcpcb.com/pcb-fabrication/high-frequency-pcb", "https://www.pcbway.com/capabilities.html"],
] as const;

type Gap = [type: "core" | "prepreg", material: string, thickness: number, epsilonR?: number];
const core = (thickness: number): Gap => ["core", "FR4", thickness, 4.6];
const pp = (material: string, thickness: number, epsilonR: number): Gap => ["prepreg", material, thickness, epsilonR];
const pi = (thickness: number): Gap => ["core", "Polyimide", thickness, 3.3];
const sym = (outer: Gap, centre: Gap) => [outer, centre, outer];
const six = (outer: Gap, middle: Gap, centre: Gap) => [outer, middle, centre, middle, outer];

interface Build {
  id: string; vendor: "JLCPCB" | "PCBWay"; type: "rigid" | "flex"; nominal: number;
  copper: number[]; gaps: Gap[]; coverlay?: number; source: string;
}
function rigid(id: string, vendor: Build["vendor"], nominal: number, inner: number, gaps: Gap[], outer = 0.035): Build {
  return { id, vendor, type: "rigid", nominal, copper: [outer, ...gaps.slice(1).map(() => inner), outer],
    gaps, source: vendor === "JLCPCB" ? jlc : pcbway };
}

export const FAB_STACKUPS: Build[] = [
  rigid("JLC04161H-7628", "JLCPCB", 1.6, 0.0152, sym(pp("7628", 0.2104, 4.4), core(1.065))),
  rigid("JLC04161H-2116", "JLCPCB", 1.6, 0.0152, sym(pp("2116", 0.1164, 4.16), core(1.265))),
  rigid("JLC04161H-3313", "JLCPCB", 1.6, 0.0152, sym(pp("3313", 0.0994, 4.1), core(1.265))),
  rigid("JLC04161H-1080", "JLCPCB", 1.6, 0.0152, sym(pp("1080", 0.0764, 3.91), core(1.265))),
  rigid("JLC06161H-3313", "JLCPCB", 1.6, 0.0152, six(pp("3313", 0.0994, 4.1), core(0.55), pp("2116", 0.1088, 4.16))),
  rigid("PCBWay 4L #1 · 70% residual copper", "PCBWay", 1.6, 0.035, sym(pp("7628 RC46%", 0.1855, 4.74), core(1.03))),
  rigid("PCBWay 4L #2 · 50% residual copper", "PCBWay", 1.6, 0.035, sym(pp("7628 RC46%", 0.1785, 4.74), core(1.03))),
  rigid("PCBWay 6L #4 · 2 oz outer copper", "PCBWay", 1.6, 0.035,
    six(pp("2116 RC58%", 0.1125, 4.45), core(0.43), pp("2116 RC58% ×2", 0.225, 4.45)), 0.07),
  { id: "JLCPCB 2L polyimide · 18 µm copper", vendor: "JLCPCB", type: "flex", nominal: 0.12,
    copper: [0.018, 0.018], gaps: [pi(0.025)], coverlay: 0.0275, source: jlcFlex },
  { id: "PCBWay 2L polyimide · 18 µm finished copper", vendor: "PCBWay", type: "flex", nominal: 0.1,
    copper: [0.018, 0.018], gaps: [pi(0.025)], coverlay: 0.0275, source: pcbwayFlex },
  { id: "PCBWay 2L polyimide · 24 µm finished copper", vendor: "PCBWay", type: "flex", nominal: 0.12,
    copper: [0.024, 0.024], gaps: [pi(0.025)], coverlay: 0.0275, source: pcbwayFlex },
];

export function applyFabStackup(build: Build, current: StackupLayer[]): StackupLayer[] {
  const names = copperNames(build.copper.length);
  const layers: StackupLayer[] = [];
  for (const side of ["F", "B"]) {
    if (side === "B") {
      names.forEach((name, index) => {
        layers.push({ name, type: "copper", thickness: build.copper[index] });
        const gap = build.gaps[index];
        if (gap) {
          const [type, material, thickness, epsilonR] = gap;
          layers.push({ name: `dielectric ${index + 1}`, type, material, thickness, epsilonR });
        }
      });
    }
    const front = side === "F";
    const prefix = front ? "Top" : "Bottom";
    const mask = current.find((l) => l.name === `${side}.Mask`);
    const cover: StackupLayer = build.coverlay === undefined
      ? { name: `${side}.Mask`, type: `${prefix} Solder Mask`, ...mask }
      : { name: `${side}.Mask`, type: `${prefix} Solder Mask`, material: "Polyimide coverlay + adhesive", thickness: build.coverlay };
    const outer = current.filter((l) => l.name.startsWith(side + ".") && /Silk|Paste/.test(l.type));
    layers.push(...(front ? [...outer, cover] : [cover, ...outer]));
  }
  return layers;
}

export function outer50Ohm(build: Build): number | null {
  const layers = applyFabStackup(build, []).filter((l) => l.type === "copper" || l.name.startsWith("dielectric "))
    .map((l) => ({ name: l.name, copper: l.type === "copper", thickness: l.thickness ?? 0, er: l.epsilonR ?? 1 }));
  const trace = traceOn({ layers, assumed: false }, "F.Cu");
  return trace ? widthFor(trace, 50) : null;
}
