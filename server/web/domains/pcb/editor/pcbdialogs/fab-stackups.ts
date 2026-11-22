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
const six = (outer: Gap, middle: Gap, centre: Gap) => [outer, middle, centre, middle, outer];

interface Build {
  id: string; vendor: "JLCPCB" | "PCBWay"; type: "rigid" | "flex"; nominal: number;
  /** one dielectric per copper gap, or the sheets pressed into that gap top to bottom (KiCad sublayers) */
  copper: number[]; gaps: (Gap | Gap[])[]; coverlay?: number; source: string;
}
function rigid(id: string, vendor: Build["vendor"], nominal: number, inner: number, gaps: Gap[], outer = 0.035): Build {
  return { id, vendor, type: "rigid", nominal, copper: [outer, ...gaps.slice(1).map(() => inner), outer],
    gaps, source: vendor === "JLCPCB" ? jlc : pcbway };
}

// JLCPCB's published impedance stackups (jlcpcb.com/impedance), every 4- and 6-layer build it lists, rows verbatim:
// 1 oz outer and 0.5 oz (0.0152 mm finished) inner copper, prepreg Er 7628 4.4 / 3313 4.1 / 1080 3.91 / 2116 4.16,
// core Er 4.6.  "|" separates the copper gaps, "," the sheets pressed into one gap; "c" a core (dielectric only, the
// page's "with copper" figure minus the foil), a style name a prepreg sheet.  The page gives no Er for 2313: it
// takes KiCad's FR4 default (4.5).  The page names no board thickness per build; the "161" in the id is 1.6 mm.
const JLC_ER: Record<string, number> = { "7628": 4.4, "3313": 4.1, "1080": 3.91, "2116": 4.16, "2313": 4.5 };
function jlcBuild(id: string, rows: string): Build {
  const gaps = rows.split("|").map((gap) => gap.split(",").map((sheet): Gap => {
    const [kind, t] = sheet.trim().split(" "); const th = Number(t);
    return kind === "c" ? core(th) : pp(kind, th, JLC_ER[kind]);
  })).map((g) => (g.length === 1 ? g[0] : g));
  return { id, vendor: "JLCPCB", type: "rigid", nominal: 1.6, copper: [0.035, ...gaps.slice(1).map(() => 0.0152), 0.035], gaps, source: jlc };
}
const JLC_BUILDS: [string, string][] = [
  ["JLC04161H-7628", "7628 0.2104 | c 1.065 | 7628 0.2104"],
  ["JLC04161H-3313", "3313 0.0994 | c 1.265 | 3313 0.0994"],
  ["JLC04161H-1080", "1080 0.0764 | c 1.265 | 1080 0.0764"],
  ["JLC04161H-2116", "2116 0.1164 | c 1.265 | 2116 0.1164"],
  ["JLC04161H-7628A", "7628 0.218, 1080 0.0764 | c 0.865 | 1080 0.0764, 7628 0.218"],
  ["JLC04161H-3313A", "3313 0.107, 3313 0.0994 | c 1.065 | 3313 0.0994, 3313 0.107"],
  ["JLC04161H-1080A", "1080 0.084, 1080 0.0764 | c 1.065 | 1080 0.0764, 1080 0.084"],
  ["JLC04161H-7628B", "7628 0.218, 7628 0.218, 2116 0.1164 | c 0.4 | 2116 0.1164, 7628 0.218, 7628 0.218"],
  ["JLC04161H-2116A", "2116 0.124, 7628 0.218, 2116 0.1164 | c 0.6 | 2116 0.1164, 7628 0.218, 2116 0.124"],
  ["JLC04161H-2116B", "2116 0.124, 7628 0.2104 | c 0.865 | 7628 0.2104, 2116 0.124"],
  ["JLC04161H-2116C", "2116 0.124, 1080 0.0764 | c 1.065 | 1080 0.0764, 2116 0.124"],
  ["JLC04161H-1080B", "1080 0.084, 1080 0.084, 1080 0.0764 | c 1.065 | 1080 0.0764, 1080 0.084, 1080 0.084"],
  ["JLC04161H-7628G", "7628 0.218, 7628 0.218, 1080 0.0764 | c 0.5 | 1080 0.0764, 7628 0.218, 7628 0.218"],
  ["JLC04161H-7628E", "7628 0.218, 7628 0.2104 | c 0.6 | 7628 0.2104, 7628 0.218"],
  ["JLC04161H-2116D", "2116 0.124, 7628 0.2104 | c 0.7 | 7628 0.2104, 2116 0.124"],
  ["JLC04161H-7628F", "7628 0.218, 7628 0.218, 7628 0.2104 | c 0.25 | 7628 0.2104, 7628 0.218, 7628 0.218"],
  ["JLC04161H-2116E", "2116 0.124, 2116 0.1164 | c 0.865 | 2116 0.1164, 2116 0.124"],
  ["JLC04161H-7628C", "7628 0.218, 7628 0.218, 7628 0.2104 | c 0.15 | 7628 0.2104, 7628 0.218, 7628 0.218"],
  ["JLC06161H-3313", "3313 0.0994 | c 0.55 | 2116 0.1088 | c 0.55 | 3313 0.0994"],
  ["JLC06161H-3313A", "3313 0.0994 | c 0.55 | 2116 0.1088 | c 0.55 | 3313 0.0994"],
  ["JLC06161H-7628", "7628 0.2104 | c 0.4 | 7628 0.2028 | c 0.4 | 7628 0.2104"],
  ["JLC06161H-7628D", "7628 0.218, 7628 0.2104 | c 0.2 | 7628 0.2028 | c 0.2 | 7628 0.2104, 7628 0.218"],
  ["JLC06161H-1080", "1080 0.0764 | c 0.55 | 7628 0.2104 | c 0.55 | 1080 0.0764"],
  ["JLC06161H-2116A", "2116 0.1164 | c 0.13 | 2116 0.1164, c 0.7, 2116 0.1164 | c 0.13 | 2116 0.1164"],
  ["JLC06161H-1080A", "1080 0.0764 | c 0.6 | 3313 0.0994 | c 0.6 | 1080 0.0764"],
  ["JLC06161H-3313C", "3313 0.107, 1080 0.0764 | c 0.4 | 1080 0.0764, 1080 0.0764 | c 0.4 | 1080 0.0784, 3313 0.107"],
  ["JLC06161H-1080B", "1080 0.0764 | c 0.1 | 7628 0.2104, c 0.7, 7628 0.2104 | c 0.1 | 1080 0.0764"],
  ["JLC06161H-3313B", "3313 0.0994 | c 0.4 | 7628 0.2104, 7628 0.2104 | c 0.4 | 3313 0.0994"],
  ["JLC06161H-3313E", "3313 0.0994 | c 0.1 | 7628 0.2104, c 0.7, 7628 0.2104 | c 0.1 | 3313 0.0994"],
  ["JLC06161H-1080C", "1080 0.0764 | c 0.075 | 7628 0.2104, c 0.7, 7628 0.2104 | c 0.075 | 1080 0.0764"],
  ["JLC06161H-2116B", "2116 0.1164 | c 0.5 | 1080 0.0764, 1080 0.0764 | c 0.5 | 2116 0.1164"],
  ["JLC06161H-2116", "2116 0.127, 2313 0.0964 | c 0.3 | 7628 0.2084, 7628 0.2084 | c 0.3 | 2313 0.0964, 2116 0.127"],
  ["JLC06161H-7628B", "7628 0.218, 1080 0.0764 | c 0.35 | 1080 0.0764, 1080 0.0764 | c 0.35 | 1080 0.0764, 7628 0.218"],
  ["JLC06161H-3313D", "3313 0.107, 1080 0.0764 | c 0.25 | 7628 0.2104, 2116 0.124, 7628 0.2104 | c 0.25 | 1080 0.0764, 3313 0.107"],
  ["JLC06161H-2116C", "2116 0.127, 2116 0.1194 | c 0.3 | 2116 0.1194, 2116 0.127, 2116 0.1194 | c 0.3 | 2116 0.1194, 2116 0.127"],
  ["JLC06161H-7628A", "7628 0.218, 7628 0.218, 1080 0.0764 | c 0.1 | 2116 0.1164, 2116 0.1164 | c 0.1 | 1080 0.0764, 7628 0.218, 7628 0.218"],
];

// PCBWay's laminated structures (pcbway.com/multi-layer-laminated-structure.html), every 4-layer build it lists
// (#57 repeats #55 and is left out): [id, nominal mm, outer finished copper, inner copper, the prepreg sheets of one
// outer gap top to bottom as [style, laminated thickness, Er], FR4 core].  The builds are symmetric.  Where the page
// presses two or three sheets into a gap it gives the gap's laminated thickness once; it is shared out here in
// proportion to the sheets' thickness before lamination.
type PcbwayRow = [id: string, nominal: number, outer: number, inner: number, sheets: [string, number, number][], core: number];
function pcbway4(id: string, nominal: number, outer: number, inner: number, sheets: [string, number, number][], c: number): Build {
  const top = sheets.map(([m, t, er]) => pp(m, t, er));
  const gap = (g: Gap[]): Gap | Gap[] => (g.length === 1 ? g[0] : g);
  return { id, vendor: "PCBWay", type: "rigid", nominal, copper: [outer, inner, inner, outer],
    gaps: [gap(top), core(c), gap(top.slice().reverse())], source: pcbway };
}
const PCBWAY_BUILDS: PcbwayRow[] = [
  ["PCBWay 4L #1 · 70% residual copper", 1.6, 0.035, 0.035, [["7628 RC46%", 0.1855, 4.74]], 1.03],
  ["PCBWay 4L #2 · 50% residual copper", 1.6, 0.035, 0.035, [["7628 RC46%", 0.1785, 4.74]], 1.03],
  ["PCBWay 4L #3 · 30% residual copper", 1.6, 0.035, 0.035, [["7628 RC46%", 0.1715, 4.74]], 1.03],
  ["PCBWay 4L #4 · 70% residual copper", 1.6, 0.07, 0.035, [["7628 RC46%", 0.1855, 4.74]], 0.93],
  ["PCBWay 4L #5 · 50% residual copper", 1.6, 0.07, 0.035, [["7628 RC46%", 0.1785, 4.74]], 0.93],
  ["PCBWay 4L #6 · 30% residual copper", 1.6, 0.07, 0.035, [["7628 RC46%", 0.1715, 4.74]], 0.93],
  ["PCBWay 4L #7 · 70% residual copper", 1.6, 0.07, 0.0525, [["7628 RC46%", 0.1803, 4.74]], 0.895],
  ["PCBWay 4L #8 · 70% residual copper", 2.4, 0.035, 0.035, [["2116 RC58%", 0.1195, 4.45]], 1.93],
  ["PCBWay 4L #9 · 50% residual copper", 2.4, 0.035, 0.035, [["7628 RC46%", 0.1785, 4.74]], 1.87],
  ["PCBWay 4L #10 · 30% residual copper", 2.4, 0.035, 0.035, [["7628 RC46%", 0.1715, 4.74]], 1.87],
  ["PCBWay 4L #11 · 70% residual copper", 2.0, 0.035, 0.035, [["2116 RC58%", 0.1195, 4.45]], 1.53],
  ["PCBWay 4L #12 · 50% residual copper", 2.0, 0.035, 0.035, [["2116 RC58%", 0.1125, 4.45]], 1.53],
  ["PCBWay 4L #13 · 30% residual copper", 2.0, 0.035, 0.035, [["7628 RC46%", 0.1715, 4.74]], 1.43],
  ["PCBWay 4L #14 · 70% residual copper", 2.0, 0.07, 0.035, [["2116 RC58%", 0.1195, 4.45]], 1.53],
  ["PCBWay 4L #15 · 50% residual copper", 2.0, 0.07, 0.035, [["2116 RC58%", 0.1125, 4.45]], 1.53],
  ["PCBWay 4L #16 · 30% residual copper", 2.0, 0.07, 0.035, [["7628 RC46%", 0.1715, 4.74]], 1.43],
  ["PCBWay 4L #17 · 70% residual copper", 1.2, 0.035, 0.035, [["7628 RC46%", 0.1855, 4.74]], 0.63],
  ["PCBWay 4L #18 · 50% residual copper", 1.2, 0.035, 0.035, [["7628 RC46%", 0.1785, 4.74]], 0.63],
  ["PCBWay 4L #19 · 30% residual copper", 1.2, 0.035, 0.035, [["7628 RC46%", 0.1715, 4.74]], 0.63],
  ["PCBWay 4L #20 · 70% residual copper", 1.2, 0.07, 0.035, [["2116 RC58%", 0.1195, 4.45]], 0.73],
  ["PCBWay 4L #21 · 50% residual copper", 1.2, 0.07, 0.035, [["7628 RC46%", 0.1785, 4.74]], 0.63],
  ["PCBWay 4L #22 · 30% residual copper", 1.2, 0.07, 0.035, [["7628 RC46%", 0.1715, 4.74]], 0.63],
  ["PCBWay 4L #23 · 70% residual copper", 1.0, 0.035, 0.035, [["7628 RC46%", 0.1855, 4.74]], 0.43],
  ["PCBWay 4L #24 · 50% residual copper", 1.0, 0.035, 0.035, [["7628 RC46%", 0.1785, 4.74]], 0.43],
  ["PCBWay 4L #25 · 30% residual copper", 1.0, 0.035, 0.035, [["7628 RC46%", 0.1715, 4.74]], 0.43],
  ["PCBWay 4L #26 · 70% residual copper", 1.0, 0.07, 0.035, [["3313 RC58%", 0.0925, 4.45]], 0.53],
  ["PCBWay 4L #27 · 50% residual copper", 1.0, 0.07, 0.035, [["2116 RC58%", 0.1125, 4.45]], 0.53],
  ["PCBWay 4L #28 · 30% residual copper", 1.0, 0.07, 0.035, [["2116 RC58%", 0.1055, 4.45]], 0.53],
  ["PCBWay 4L #29 · 70% residual copper", 0.8, 0.035, 0.035, [["7628 RC46%", 0.1855, 4.74]], 0.23],
  ["PCBWay 4L #30 · 50% residual copper", 0.8, 0.035, 0.035, [["7628 RC46%", 0.1785, 4.74]], 0.23],
  ["PCBWay 4L #31 · 30% residual copper", 0.8, 0.035, 0.035, [["7628 RC46%", 0.1715, 4.74]], 0.23],
  ["PCBWay 4L #32 · 70% residual copper", 0.8, 0.07, 0.035, [["7628 RC46%", 0.1855, 4.74]], 0.23],
  ["PCBWay 4L #33 · 50% residual copper", 0.8, 0.07, 0.035, [["7628 RC46%", 0.1785, 4.74]], 0.23],
  ["PCBWay 4L #34 · 30% residual copper", 0.8, 0.07, 0.035, [["7628 RC46%", 0.1715, 4.74]], 0.23],
  ["PCBWay 4L #35 · 70% residual copper", 0.6, 0.035, 0.035, [["3313 RC58%", 0.0925, 4.45]], 0.23],
  ["PCBWay 4L #36 · 50% residual copper", 0.6, 0.035, 0.035, [["3313 RC58%", 0.0855, 4.45]], 0.23],
  ["PCBWay 4L #37 · 70% residual copper", 0.6, 0.07, 0.035, [["3313 RC58%", 0.0925, 4.45]], 0.13],
  ["PCBWay 4L #38 · 50% residual copper", 0.6, 0.07, 0.035, [["2116 RC58%", 0.1125, 4.45]], 0.13],
  ["PCBWay 4L #39 · 30% residual copper", 0.6, 0.07, 0.035, [["2116 RC58%", 0.1055, 4.45]], 0.13],
  ["PCBWay 4L #40 · 70% residual copper", 0.4, 0.035, 0.035, [["1080 RC68%", 0.0705, 4.21]], 0.065],
  ["PCBWay 4L #41 · 50% residual copper", 0.4, 0.035, 0.035, [["1080 RC68%", 0.0635, 4.21]], 0.065],
  ["PCBWay 4L #42 · 30% residual copper", 0.4, 0.035, 0.035, [["1080 RC68%", 0.0565, 4.21]], 0.065],
  ["PCBWay 4L #43 · 50% residual copper", 2.4, 0.07, 0.035, [["2116 RC58%", 0.1125, 4.45]], 1.93],
  ["PCBWay 4L #44 · 50% residual copper", 1.6, 0.07, 0.0525, [["2116 RC58%", 0.1169, 4.45], ["2116 RC58%", 0.1169, 4.45]], 0.795],
  ["PCBWay 4L #45 · 30% residual copper", 1.6, 0.07, 0.0525, [["1080 RC68%", 0.0703, 4.21], ["7628 RC46%", 0.17, 4.74]], 0.795],
  ["PCBWay 4L #46 · 70% residual copper", 1.6, 0.07, 0.07, [["2116 RC58%", 0.1216, 4.45], ["7628 RC46%", 0.1834, 4.74]], 0.63],
  ["PCBWay 4L #47 · 50% residual copper", 1.6, 0.07, 0.07, [["2116 RC58%", 0.116, 4.45], ["7628 RC46%", 0.175, 4.74]], 0.63],
  ["PCBWay 4L #48 · 30% residual copper", 1.6, 0.07, 0.07, [["7628 RC46%", 0.1715, 4.74], ["7628 RC46%", 0.1715, 4.74]], 0.63],
  ["PCBWay 4L #49 · 90% residual copper", 1.6, 0.105, 0.105, [["2116 RC58%", 0.1247, 4.45], ["2116 RC58%", 0.1247, 4.45]], 0.59],
  ["PCBWay 4L #50 · 90% residual copper", 1.6, 0.105, 0.105, [["7628 RC46%", 0.1908, 4.74], ["7628 RC46%", 0.1908, 4.74]], 0.34],
  ["PCBWay 4L #51 · 90% residual copper", 1.6, 0.105, 0.105, [["2116 RC58%", 0.1258, 4.45], ["7628 RC46%", 0.1897, 4.74]], 0.47],
  ["PCBWay 4L #52 · 90% residual copper", 1.6, 0.14, 0.14, [["7628 RC46%", 0.189, 4.74], ["7628 RC46%", 0.189, 4.74]], 0.23],
  ["PCBWay 4L #53 · 90% residual copper", 1.6, 0.14, 0.14, [["3313 RC58%", 0.0968, 4.45], ["2116 RC58%", 0.1222, 4.45]], 0.52],
  ["PCBWay 4L #54 · 90% residual copper", 1.6, 0.14, 0.14, [["2116 RC58%", 0.1244, 4.45], ["7628 RC46%", 0.1876, 4.74]], 0.32],
  ["PCBWay 4L #55 · 90% residual copper", 1.6, 0.175, 0.175, [["3313 RC58%", 0.1008, 4.45], ["7628 RC46%", 0.1847, 4.74]], 0.32],
  ["PCBWay 4L #56 · 90% residual copper", 1.6, 0.175, 0.175, [["3313 RC58%", 0.0993, 4.45], ["2116 RC58%", 0.1272, 4.45]], 0.45],
  ["PCBWay 4L #58 · 70% residual copper", 2.4, 0.07, 0.035, [["3313 RC58%", 0.0994, 4.45], ["7628 RC46%", 0.1891, 4.74]], 1.53],
  ["PCBWay 4L #59 · 50% residual copper", 2.4, 0.07, 0.035, [["2116 RC58%", 0.123, 4.45], ["7628 RC46%", 0.1855, 4.74]], 1.53],
  ["PCBWay 4L #60 · 30% residual copper", 2.4, 0.07, 0.035, [["2116 RC58%", 0.1202, 4.45], ["7628 RC46%", 0.1813, 4.74]], 1.53],
  ["PCBWay 4L #61 · 70% residual copper", 2.4, 0.07, 0.0525, [["7628 RC46%", 0.1882, 4.74], ["7628 RC46%", 0.1882, 4.74]], 1.395],
  ["PCBWay 4L #62 · 50% residual copper", 2.4, 0.07, 0.0525, [["7628 RC46%", 0.1829, 4.74], ["7628 RC46%", 0.1829, 4.74]], 1.395],
  ["PCBWay 4L #63 · 30% residual copper", 2.4, 0.07, 0.0525, [["2116 RC58%", 0.1154, 4.45], ["7628 RC46%", 0.1739, 4.74]], 1.535],
  ["PCBWay 4L #64 · 70% residual copper", 2.4, 0.07, 0.07, [["1080 RC68%", 0.0762, 4.21], ["1080 RC68%", 0.0762, 4.21], ["7628 RC46%", 0.1845, 4.74]], 1.4],
  ["PCBWay 4L #65 · 50% residual copper", 2.4, 0.07, 0.07, [["3313 RC58%", 0.0909, 4.45], ["7628 RC46%", 0.1731, 4.74]], 1.53],
  ["PCBWay 4L #66 · 30% residual copper", 2.4, 0.07, 0.07, [["1080 RC68%", 0.0699, 4.21], ["1080 RC68%", 0.0699, 4.21], ["7628 RC46%", 0.1692, 4.74]], 1.43],
  ["PCBWay 4L #67 · 90% residual copper", 2.4, 0.105, 0.105, [["1080 RC68%", 0.0779, 4.21], ["7628 RC46%", 0.1886, 4.74]], 1.39],
  ["PCBWay 4L #68 · 90% residual copper", 2.4, 0.105, 0.105, [["1080 RC68%", 0.077, 4.21], ["2116 RC58%", 0.1235, 4.45]], 1.52],
  ["PCBWay 4L #69 · 90% residual copper", 2.4, 0.14, 0.14, [["3313 RC58%", 0.0982, 4.45], ["7628 RC46%", 0.1868, 4.74]], 1.22],
];

export const FAB_STACKUPS: Build[] = [
  ...JLC_BUILDS.map(([id, rows]) => jlcBuild(id, rows)),
  ...PCBWAY_BUILDS.map((r) => pcbway4(...r)),
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
          const sheets = (Array.isArray(gap[0]) ? gap : [gap]) as Gap[];
          const [type, material, thickness, epsilonR] = sheets[0];
          const layer: StackupLayer = { name: `dielectric ${index + 1}`, type, material, thickness, epsilonR };
          // DIELECTRIC_PRMS sublayers: the other sheets of the gap (BOARD_STACKUP_ITEM::AddDielectricPrms)
          if (sheets.length > 1) layer.subs = sheets.slice(1).map(([kind, m, t, er]) => ({ thickness: t, material: m, epsilonR: er ?? 4.5, lossTangent: 0.02 }));
          layers.push(layer);
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
    .map((l) => {
      // a gap of several sheets: their total thickness, and the thickness-weighted Er
      const sheets = [{ t: l.thickness ?? 0, er: l.epsilonR ?? 1 }, ...(l.subs || []).map((x) => ({ t: x.thickness, er: x.epsilonR }))];
      const t = sheets.reduce((a, x) => a + x.t, 0);
      return { name: l.name, copper: l.type === "copper", thickness: t, er: t ? sheets.reduce((a, x) => a + x.t * x.er, 0) / t : 1 };
    });
  const trace = traceOn({ layers, assumed: false }, "F.Cu");
  return trace ? widthFor(trace, 50) : null;
}
