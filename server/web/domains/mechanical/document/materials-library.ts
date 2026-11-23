// materials-library.ts — the appearance library: ready-made looks (metals, plastics, rubber, wood, glass) that
// are put on a part by dragging one onto it, in place of mixing a colour by hand each time.  Pure.
//
// An appearance is a base colour and the two numbers every physically based renderer takes: `metalness` (0 a
// dielectric, 1 a metal) and `roughness` (0 a mirror, 1 chalk); a few are see-through (`opacity`).  Putting one
// on a part stores exactly that on the part's look in the document's `appearance` item (appearance-items.ts
// `setBodyAppearance`), with the library's id beside it:
//
//   bodies: { "<body id>": { color: "#c8ccd0", metalness: 1, roughness: 0.35, appearance: "aluminium-brushed" } }
//
// so a reader that knows nothing of the library still draws the part right, and one that does can say what it
// is made to look like.  An entry may also carry a `finish`: the numbers a rendered picture needs on top of those
// (a clear coat, light going through a clear solid and bending, sheen; shared/render/materials.ts).  It is stored
// beside the rest (`finish: { transmission: 1, ior: 1.585, depth: 6 }`), the shaded viewport ignores it, and a
// document written before there was one is rendered from the library's by its id (`finishOf`).  Dropped on one face it colours that face (a face has a colour only).  This is how a
// part looks, not what it is made of: the material that gives a part its mass is document/mass-materials.ts.
import type { ItemChange, ItemDoc } from "../../../shared/itemdoc/itemdoc";
import { cleanFinish, type SurfaceFinish, type SurfaceLook } from "../../../shared/render/materials";
import { looksOf, setBodyAppearance, setFaceColor, type BodyLook } from "./appearance-items";

export interface Appearance { id: string; name: string; group: string; color: string; metalness: number; roughness: number; opacity?: number; finish?: SurfaceFinish }

const a = (group: string, id: string, name: string, color: string, metalness: number, roughness: number, opacity?: number | null, finish?: SurfaceFinish): Appearance => ({ id, name, group, color, metalness, roughness, ...(typeof opacity === "number" ? { opacity } : {}), ...(finish ? { finish } : {}) });
// Finishes.  Anodising and lacquer are a thin clear layer over the metal or the paint; a clear plastic is a solid
// of its own index of refraction that takes its colour on with depth (`depth` millimetres to the full colour).
const ANODISED: SurfaceFinish = { clearcoat: 0.35, clearcoatRoughness: 0.25 };
const MOULDED: SurfaceFinish = { ior: 1.53, clearcoat: 0.08, clearcoatRoughness: 0.3 };
const PRINTED: SurfaceFinish = { ior: 1.46, clearcoat: 0.25, clearcoatRoughness: 0.2 };
export const APPEARANCES: readonly Appearance[] = [
  a("Metal", "aluminium-brushed", "Aluminium, brushed", "#c8ccd0", 1, 0.38),
  a("Metal", "aluminium-polished", "Aluminium, polished", "#d6d9dc", 1, 0.12),
  a("Metal", "aluminium-anodised-black", "Aluminium, black anodised", "#26282b", 1, 0.45, null, ANODISED),
  a("Metal", "aluminium-anodised-blue", "Aluminium, blue anodised", "#2f5fa8", 1, 0.4, null, ANODISED),
  a("Metal", "steel", "Steel", "#8d9297", 1, 0.42),
  a("Metal", "steel-stainless", "Stainless steel", "#b9bcc0", 1, 0.25),
  a("Metal", "steel-black-oxide", "Steel, black oxide", "#2b2c2e", 0.9, 0.6, null, { sheen: 0.15, sheenRoughness: 0.5 }),
  a("Metal", "brass", "Brass", "#c9a44c", 1, 0.3),
  a("Metal", "copper", "Copper", "#c0733f", 1, 0.3),
  a("Metal", "titanium", "Titanium", "#8a8680", 1, 0.45),
  a("Metal", "zinc-plated", "Zinc plated", "#a9b3bd", 1, 0.35, null, { clearcoat: 0.2, clearcoatRoughness: 0.15 }),
  a("Metal", "gold", "Gold", "#d9b24a", 1, 0.2),
  a("Plastic", "abs-black", "ABS, black", "#1f1f21", 0, 0.55, null, MOULDED),
  a("Plastic", "abs-white", "ABS, white", "#eeeeea", 0, 0.5, null, MOULDED),
  a("Plastic", "abs-grey", "ABS, grey", "#8c8f93", 0, 0.55, null, MOULDED),
  a("Plastic", "pla-red", "PLA, red", "#c8372d", 0, 0.45, null, PRINTED),
  a("Plastic", "pla-blue", "PLA, blue", "#2c66c4", 0, 0.45, null, PRINTED),
  a("Plastic", "pla-green", "PLA, green", "#3f9a4a", 0, 0.45, null, PRINTED),
  a("Plastic", "pla-orange", "PLA, orange", "#e8822a", 0, 0.45, null, PRINTED),
  a("Plastic", "nylon", "Nylon, natural", "#e6e0d0", 0, 0.7, null, { ior: 1.53, sheen: 0.35, sheenRoughness: 0.6 }),
  a("Plastic", "petg-clear", "PETG, clear", "#dfeef2", 0, 0.1, 0.4, { transmission: 0.97, ior: 1.57, depth: 30 }),
  a("Plastic", "polycarbonate-smoke", "Polycarbonate, smoked", "#4a4f55", 0, 0.08, 0.5, { transmission: 0.98, ior: 1.585, depth: 9 }),
  a("Plastic", "acrylic-clear", "Acrylic, clear", "#f2f8fa", 0, 0.04, 0.3, { transmission: 1, ior: 1.49, depth: 60 }),
  a("Other", "rubber-black", "Rubber, black", "#1a1a1a", 0, 0.9, null, { ior: 1.52, specular: 0.5, sheen: 0.2, sheenRoughness: 0.7 }),
  a("Other", "silicone-white", "Silicone, white", "#e9e9e4", 0, 0.8, null, { ior: 1.41, sheen: 0.25, sheenRoughness: 0.6 }),
  a("Other", "glass", "Glass", "#e8f3f5", 0, 0.02, 0.25, { transmission: 1, ior: 1.52, depth: 80 }),
  a("Other", "wood-birch", "Birch plywood", "#d8b98a", 0, 0.75, null, { specular: 0.6 }),
  a("Other", "wood-walnut", "Walnut", "#6b4a32", 0, 0.7, null, { specular: 0.7, clearcoat: 0.15, clearcoatRoughness: 0.35 }),
  a("Other", "fr4-green", "Circuit board green", "#1f6b3a", 0.1, 0.5, null, { clearcoat: 0.7, clearcoatRoughness: 0.12 }),
  a("Other", "carbon-fibre", "Carbon fibre", "#232427", 0.3, 0.4, null, { clearcoat: 1, clearcoatRoughness: 0.04 }),
  a("Other", "paint-matt-white", "Paint, matt white", "#f2f2ee", 0, 0.9),
  a("Other", "paint-gloss-red", "Paint, gloss red", "#b3201c", 0, 0.15, null, { clearcoat: 1, clearcoatRoughness: 0.03 }),
];
export const APPEARANCE_GROUPS: readonly string[] = Array.from(new Set(APPEARANCES.map((x) => x.group)));
export const appearanceOf = (id: unknown): Appearance | undefined => APPEARANCES.find((x) => x.id === id);

/** The library, narrowed by what was typed: every word in the name or the group. */
export function findAppearances(query: string): Appearance[] {
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  return APPEARANCES.filter((x) => words.every((w) => `${x.name} ${x.group}`.toLowerCase().includes(w)));
}

/** Where an appearance was dropped (or what is selected when one is clicked). */
export type AppearanceTarget = { kind: "body"; body: string } | { kind: "face"; body: string; name: string };

/** Put an appearance on parts and faces: one change, undone as one. */
export function applyAppearance(doc: ItemDoc, targets: readonly AppearanceTarget[], id: string): ItemChange[] {
  const ap = appearanceOf(id);
  if (!ap || !targets.length) return [];
  const bodies = Array.from(new Set(targets.filter((t) => t.kind === "body").map((t) => t.body)));
  // a face of a part that gets the appearance whole needs nothing of its own
  const faces = targets.filter((t): t is Extract<AppearanceTarget, { kind: "face" }> => t.kind === "face" && !bodies.includes(t.body));
  const out: ItemChange[] = [];
  if (bodies.length) out.push(...setBodyAppearance(doc, bodies, { color: ap.color, metalness: ap.metalness, roughness: ap.roughness, opacity: ap.opacity ?? null, appearance: ap.id, finish: ap.finish }));
  if (faces.length) {
    // the second change is worked out on the document as the first leaves it: both write the one appearance item
    if (!out.length) return setFaceColor(doc, faces, ap.color);
    return setBodyAppearance(doc, bodies, { color: ap.color, metalness: ap.metalness, roughness: ap.roughness, opacity: ap.opacity ?? null, appearance: ap.id, finish: ap.finish }, faces.map((f) => ({ ...f, color: ap.color })));
  }
  return out;
}

/** The library appearance a part has, when what is stored is still exactly that. */
export function appearanceOfBody(doc: ItemDoc | null, bodyId: string): Appearance | undefined {
  const look = looksOf(doc)[bodyId], ap = look ? appearanceOf(look.appearance) : undefined;
  return ap && look && look.color === ap.color ? ap : undefined;
}

/**
 * The finish a part is rendered with: its own when the document stores one, else the library's for the
 * appearance it names (a document from before finishes were stored), else none (the renderer then goes by the
 * colour, metalness, roughness and opacity alone).
 */
export function finishOf(look: BodyLook | undefined): SurfaceFinish | null {
  if (!look) return null;
  return cleanFinish(look.finish) || appearanceOf(look.appearance)?.finish || null;
}

/** A part's look as the renderer takes one.  `color` is what the part is drawn in when it stores none (its material's, or the palette's). */
export function surfaceLookOf(look: BodyLook | undefined, color: string): SurfaceLook {
  return { color: look?.color || color, metalness: look?.metalness, roughness: look?.roughness, opacity: look?.opacity, finish: finishOf(look) };
}
