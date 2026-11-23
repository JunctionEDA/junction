// tool.ts — the assembly toolbar contract: one file under tools/ default-exports an AssemblyToolDefinition and
// its button appears in its section of the bar, in the tool search and in the list of keys (ui/commands.ts reads
// the registry; nothing is listed by hand).  Same idea as the part studio's tools.
import type { AssemblyEditor } from "../ui/assembly";

/** The sections of the bar, in the order they stand.  "more" is never on the bar: its tools are under More ▾. */
export const TOOL_SECTIONS = ["edit", "insert", "mate", "connect", "relation", "pattern", "view", "inspect", "file", "more"] as const;
export type ToolSection = (typeof TOOL_SECTIONS)[number];

export interface AssemblyToolDefinition {
  id: string;
  title: string;
  /** one line on what it does: the tooltip and the tool search */
  hint?: string;
  /** inline SVG markup for a 24×24 stroke glyph, drawn as the part studio's are (mechanical ui/Glyph.tsx) */
  icon?: string;
  /** which part of the bar it is in ("more" when not given) */
  section?: ToolSection;
  /** lower first within its section; ties in title order */
  order?: number;
  /** tools of one section that name the same menu share one button with a caret */
  menu?: string;
  /** how long it keeps its place when the window is narrow (higher: longer; default 50; 0: always under More) */
  keep?: number;
  /** its button carries its name (Insert) */
  label?: boolean;
  /** its key when a person has not chosen another (ui/keys.ts): "i", "Shift+G" */
  key?: string;
  /** other words people look for it by, for the tool search */
  keywords?: string;
  disabled?(assembly: AssemblyEditor): string | null;
  active?(assembly: AssemblyEditor): boolean;
  run(assembly: AssemblyEditor): void;
}

export function defineAssemblyTool(def: AssemblyToolDefinition): AssemblyToolDefinition { return def; }
