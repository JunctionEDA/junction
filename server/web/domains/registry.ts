// registry.ts — the engineering domains Junction covers or plans to cover, and what each one claims.
//
// A domain is one kind of design work with its own documents, editor and tools: electronics (schematic and
// board), mechanical CAD, assemblies, physics simulation, chip design, robotics and manufacturing.  Everything a
// domain shares with the others (projects, sharing, roles, presence, comments, version history, GitHub sync, the
// AI connection) lives outside domains/, in platform/ and shared/.  See server/web/README.md and docs/ROADMAP.md.
//
// Nothing reads this table yet: it is the contract new domains are written against, so the platform can later
// pick an editor by file type and list what a project may contain without knowing any one domain.

/** Where a domain is in its life. */
export type DomainStatus = "shipped" | "in-progress" | "planned";

export interface DomainDescriptor {
  /** Stable id, also the folder under server/web/domains/. */
  id: string;
  /** The name people see. */
  title: string;
  status: DomainStatus;
  /** One sentence on what the domain designs. */
  summary: string;
  /** File extensions (with the dot) whose documents this domain opens. */
  fileTypes: string[];
  /** Other domains whose documents this one reads (an assembly reads parts and boards, CAM reads parts). */
  reads: string[];
}

export const DOMAINS: readonly DomainDescriptor[] = [
  {
    id: "pcb",
    title: "Electronics",
    status: "shipped",
    summary: "Schematics, symbols, footprints and circuit boards, through to fabrication outputs and SPICE.",
    fileTypes: [".kicad_pro", ".kicad_sch", ".kicad_pcb", ".kicad_sym", ".kicad_mod", ".kicad_wks"],
    reads: [],
  },
  {
    id: "mechanical",
    title: "Mechanical CAD",
    status: "planned",
    summary: "Parametric solid parts: sketches, features and a history tree on a B-rep kernel.",
    fileTypes: [".step", ".stp", ".iges", ".igs"],
    reads: [],
  },
  {
    id: "assembly",
    title: "Assemblies",
    status: "planned",
    summary: "Parts and boards put together with mates and joints, with interference checks and a bill of materials.",
    fileTypes: [],
    reads: ["mechanical", "pcb"],
  },
  {
    id: "physics",
    title: "Physics simulation",
    status: "planned",
    summary: "Structural, thermal and rigid-body analysis of parts and assemblies.",
    fileTypes: [],
    reads: ["mechanical", "assembly", "pcb"],
  },
  {
    id: "silicon",
    title: "IC and chip design",
    status: "planned",
    summary: "RTL, synthesis, place and route and layout of digital and analog chips on open PDKs.",
    fileTypes: [".v", ".sv", ".vhd", ".gds", ".lef", ".def"],
    reads: [],
  },
  {
    id: "robotics",
    title: "Robotics simulation",
    status: "planned",
    summary: "Robots built from assemblies, with actuators, sensors and controllers simulated together.",
    fileTypes: [".urdf", ".sdf", ".mjcf"],
    reads: ["assembly", "pcb", "physics"],
  },
  {
    id: "manufacturing",
    title: "Manufacturing and CAM",
    status: "planned",
    summary: "Toolpaths for milling, turning and cutting, slicing for printing, and setup sheets.",
    fileTypes: [".nc", ".gcode"],
    reads: ["mechanical", "assembly", "pcb"],
  },
];

/** The domain that opens a file, by its extension, or undefined. */
export function domainForFile(name: string): DomainDescriptor | undefined {
  const lower = name.toLowerCase();
  return DOMAINS.find((d) => d.fileTypes.some((ext) => lower.endsWith(ext)));
}
