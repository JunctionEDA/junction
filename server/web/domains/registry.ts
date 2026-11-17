// registry.ts — the engineering domains Junction covers or plans to cover, and what each one claims.
//
// A domain is one kind of design work with its own documents, editor and tools: electronics (schematic and
// board), mechanical CAD, assemblies, physics simulation, chip design, robotics and manufacturing.  Everything a
// domain shares with the others (projects, sharing, roles, presence, comments, version history, GitHub sync, the
// AI connection) lives outside domains/, in platform/ and shared/.  See server/web/README.md and docs/ROADMAP.md.
//
// The platform reads it to know what a project may hold without knowing any one domain: the document tabs
// (web/platform/doctabs) list the documents whose kind is here, offer the kinds that can be created, and the
// shell loads the bundle a kind names when its tab is opened (web/platform/documents/host.ts).

/** Where a domain is in its life. */
export type DomainStatus = "shipped" | "in-progress" | "planned";

/** One kind of document a project can hold, as the document tabs and the shell need to know it. */
export interface DocumentKind {
  /** the server's document type (server/src/http.rs doc_type_for) */
  docType: string;
  /** the file extension, with the dot */
  ext: string;
  /** what a tab of this kind is called when its file name says nothing ("Board") and what "+" offers */
  title: string;
  /** inline SVG markup for a 24×24 stroke glyph (currentColor), shown on the tab */
  icon: string;
  /**
   * The script that holds this kind's editor, loaded when a tab of this kind is first opened; it registers a
   * DocumentEditorFactory (web/platform/documents/host.ts).  Absent: the shell draws the document itself (KiCad's).
   */
  bundle?: string;
  /** The stem of a new document's name ("Part Studio" gives "Part Studio 1.jpart").  Absent: not offered by "+". */
  newName?: string;
  /** The text of a new, empty document of this kind: what is uploaded as its first snapshot. */
  newText?: string;
}

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
  /** The documents of this domain that get a tab in an open project.  Other files of the domain ride along. */
  documents?: DocumentKind[];
}

export const DOMAINS: readonly DomainDescriptor[] = [
  {
    id: "pcb",
    title: "Electronics",
    status: "shipped",
    summary: "Schematics, symbols, footprints and circuit boards, through to fabrication outputs and SPICE.",
    fileTypes: [".kicad_pro", ".kicad_sch", ".kicad_pcb", ".kicad_sym", ".kicad_mod", ".kicad_wks"],
    reads: [],
    documents: [
      { docType: "kicad_sch", ext: ".kicad_sch", title: "Schematic", icon: '<path d="M3 12h5"/><path d="M16 12h5"/><rect x="8" y="8" width="8" height="8"/><path d="M12 4v4"/><path d="M12 16v4"/>' },
      { docType: "kicad_pcb", ext: ".kicad_pcb", title: "Board", icon: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><circle cx="8.5" cy="9.5" r="1.2"/><circle cx="15.5" cy="14.5" r="1.2"/><path d="M9.5 10.5l5 3"/>' },
    ],
  },
  {
    id: "mechanical",
    title: "Mechanical CAD",
    status: "in-progress",
    summary: "Parametric solid parts: sketches, features and a history tree on a B-rep kernel.",
    // .jpart is the part studio (web/domains/mechanical/CONTRACT.md); STEP and IGES are what it will import and export
    fileTypes: [".jpart", ".step", ".stp", ".iges", ".igs"],
    reads: [],
    documents: [
      {
        docType: "part_studio", ext: ".jpart", title: "Part Studio", bundle: "/static/dist/mechanical.js", newName: "Part Studio",
        icon: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/>',
        // the same text as web/domains/mechanical/document/format.ts newPartStudioText() (a test compares them)
        newText: '{"junction":"part-studio","version":1,"items":[\n{"id":"studio","rollback":null,"type":"studio","units":"mm"}\n]}\n',
      },
    ],
  },
  {
    id: "assembly",
    title: "Assemblies",
    status: "in-progress",
    summary: "Parts and boards put together with mates and joints, with interference checks and a bill of materials.",
    fileTypes: [".jasm"],
    reads: ["mechanical", "pcb"],
    documents: [
      {
        docType: "assembly", ext: ".jasm", title: "Assembly", bundle: "/static/dist/assembly.js", newName: "Assembly",
        icon: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/><path d="M11 7.5h5.5V13"/>',
        // the same text as web/domains/assembly/document/format.ts newAssemblyText() (a test compares them)
        newText: '{"junction":"assembly","version":1,"items":[\n{"id":"assembly","type":"assembly","units":"mm"}\n]}\n',
      },
    ],
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

/** Every kind of document that gets a tab, across the domains. */
export const DOCUMENT_KINDS: readonly DocumentKind[] = DOMAINS.flatMap((d) => d.documents || []);

/** The tab kind of a server document type, or undefined for a file that has no tab (a library, a 3D model). */
export function documentKind(docType: string): DocumentKind | undefined {
  return DOCUMENT_KINDS.find((k) => k.docType === docType);
}
