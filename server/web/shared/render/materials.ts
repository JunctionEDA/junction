// materials.ts — what a surface is made of, as a path tracer takes it.  Pure.
//
// A document says how a part looks with four numbers every reader understands: a colour, `metalness`,
// `roughness` and `opacity`.  That is enough for the shaded viewport and not enough for a photograph: clear
// polycarbonate is not "40 % opaque grey", it is a solid that bends light and darkens it with depth; gloss paint
// is a rough coloured layer under a smooth clear one.  The extra numbers are a `finish`, and every one is
// optional:
//
//   clearcoat, clearcoatRoughness   a clear layer over the surface (lacquer, anodising, solder mask)
//   transmission                    how much light goes through the solid instead of being scattered back
//   ior                             its index of refraction (1.49 acrylic, 1.52 glass, 1.585 polycarbonate)
//   depth                           millimetres of the solid that tint the light to its colour (Beer-Lambert)
//   sheen, sheenRoughness           the soft glow at grazing angles of fibres and rubber
//   specular                        the strength of the mirror-like reflection of a non-metal (1 is the usual)
//   emissive                        light the surface gives off itself, in its colour (1: as bright as a white card)
//
// `physicalSurface` turns a look into the full set.  A look with no finish (an older document, or a colour
// mixed by hand) gets the finish its four numbers imply: a see-through non-metal becomes a real dielectric of
// index 1.5 that transmits as much as it was transparent.  Light goes through only what the document calls
// see-through (`opacity` under 1): a part made opaque again is opaque in the picture too.
export interface SurfaceFinish {
  clearcoat?: number; clearcoatRoughness?: number;
  transmission?: number; ior?: number; depth?: number;
  sheen?: number; sheenRoughness?: number;
  specular?: number; emissive?: number;
}
export const FINISH_KEYS: readonly (keyof SurfaceFinish)[] = ["clearcoat", "clearcoatRoughness", "transmission", "ior", "depth", "sheen", "sheenRoughness", "specular", "emissive"];
const LIMITS: Record<keyof SurfaceFinish, [number, number]> = {
  clearcoat: [0, 1], clearcoatRoughness: [0, 1], transmission: [0, 1], ior: [1, 2.6], depth: [0.01, 1e5], sheen: [0, 1], sheenRoughness: [0, 1], specular: [0, 1], emissive: [0, 1000],
};

/** A finish as stored, cleaned: only the known keys, each a finite number inside its range; null when nothing is left. */
export function cleanFinish(raw: unknown): SurfaceFinish | null {
  if (!raw || typeof raw !== "object") return null;
  const out: SurfaceFinish = {};
  for (const k of FINISH_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.max(LIMITS[k][0], Math.min(LIMITS[k][1], v));
  }
  return Object.keys(out).length ? out : null;
}

/** How a part looks, as a document stores it. */
export interface SurfaceLook { color: string; metalness?: number; roughness?: number; opacity?: number; finish?: SurfaceFinish | null }

export type LinearRgb = [number, number, number];
/** Everything a physically based renderer wants to know about a surface.  Colours are linear sRGB. */
export interface PhysicalSurface {
  color: LinearRgb; metalness: number; roughness: number;
  transmission: number; ior: number;
  /** the colour light takes on inside the solid, fully after `attenuationDistance` millimetres (Infinity: none) */
  attenuationColor: LinearRgb; attenuationDistance: number;
  clearcoat: number; clearcoatRoughness: number;
  sheen: number; sheenRoughness: number; sheenColor: LinearRgb;
  specular: number;
  emissive: LinearRgb; emissiveIntensity: number;
}

const decode = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
/** "#rrggbb" as linear sRGB; mid grey when it is not a colour. */
export function linearOf(hex: string): LinearRgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return [0.5, 0.5, 0.5];
  return [decode(parseInt(m[1], 16) / 255), decode(parseInt(m[2], 16) / 255), decode(parseInt(m[3], 16) / 255)];
}
const unit = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d);

/**
 * The finish a look's four numbers imply when it carries none: a see-through non-metal is a dielectric that
 * transmits what it does not hide (opacity 0.4, as clear PETG was stored, transmits nearly all of it).
 */
export function impliedFinish(look: SurfaceLook): SurfaceFinish {
  const opacity = unit(look.opacity, 1), metal = unit(look.metalness, 0);
  if (opacity < 1 && metal < 0.5) return { transmission: Math.min(1, (1 - opacity) * 1.7), ior: 1.5, depth: 12 };
  return {};
}

/** The least rough a surface is traced: a perfect mirror makes paths no sampler finds (and nothing made is one). */
export const MIN_ROUGHNESS = 0.015;

export function physicalSurface(look: SurfaceLook): PhysicalSurface {
  // what the four numbers imply, then whatever the finish says outright
  const f: SurfaceFinish = { ...impliedFinish(look), ...(cleanFinish(look.finish) || {}) };
  const base = linearOf(look.color), metalness = unit(look.metalness, 0);
  // a metal lets no light through, whatever else is stored; nor does a part somebody made opaque again
  const transmission = metalness >= 0.5 || unit(look.opacity, 1) >= 1 ? 0 : unit(f.transmission, 0);
  const clear = transmission > 0;
  // through a clear solid the colour is taken on with depth, not at the skin: the skin itself is colourless,
  // as much as the solid transmits (what it does not transmit it scatters back in its colour)
  const skin: LinearRgb = clear ? [base[0] + (1 - base[0]) * transmission, base[1] + (1 - base[1]) * transmission, base[2] + (1 - base[2]) * transmission] : base;
  return {
    color: skin, metalness, roughness: Math.max(MIN_ROUGHNESS, unit(look.roughness, 0.5)),
    transmission, ior: f.ior ?? 1.5,
    attenuationColor: clear ? [Math.max(base[0], 1e-3), Math.max(base[1], 1e-3), Math.max(base[2], 1e-3)] : [1, 1, 1],
    attenuationDistance: clear ? f.depth ?? 12 : Infinity,
    clearcoat: unit(f.clearcoat, 0), clearcoatRoughness: unit(f.clearcoatRoughness, 0.05),
    sheen: unit(f.sheen, 0), sheenRoughness: unit(f.sheenRoughness, 0.5), sheenColor: [1, 1, 1],
    specular: unit(f.specular, 1),
    emissive: base, emissiveIntensity: Math.max(0, f.emissive ?? 0),
  };
}
