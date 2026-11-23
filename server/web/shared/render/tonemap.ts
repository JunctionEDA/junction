// tonemap.ts — from the light a renderer computed to the colours a screen shows: exposure, a filmic curve, and
// the sRGB encoding.  Pure.  The same arithmetic is here twice, as TypeScript (the tests, and anything that works
// on pixels in JavaScript) and as GLSL (`TONEMAP_GLSL`, what the display pass of the render engine runs), both
// written from the one set of constants below.
//
// The renderer works in linear sRGB primaries, scene-referred: 1 is a white card under the lights, a softbox is
// 10 or more.  Shown as they are, everything brighter than the card would clip to flat white and lose its colour.
// A filmic curve rolls highlights off instead, the way film and a camera's picture profile do:
//
//   agx    Troy Sobotka's AgX as Blender 4 ships it, in the compact form Filament and three.js use: highlights
//          go to white through paler colour, never through a hue shift (a red light does not turn orange).
//          The default.
//   aces   the ACES filmic fit (Stephen Hill): more contrast and saturation, the look of many game engines.
//
// Exposure is in stops: +1 doubles the light.
export type ToneMap = "agx" | "aces";
export const TONE_MAPS: readonly { id: ToneMap; title: string }[] = [{ id: "agx", title: "AgX" }, { id: "aces", title: "ACES" }];

type V3 = [number, number, number];
/** A column-major 3 × 3, as GLSL's mat3( vec3, vec3, vec3 ). */
type M3 = [V3, V3, V3];
const mul = (m: M3, v: V3): V3 => [m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2], m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2], m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2]];
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

const SRGB_TO_REC2020: M3 = [[0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]];
const REC2020_TO_SRGB: M3 = [[1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]];
const AGX_INSET: M3 = [[0.856627153315983, 0.137318972929847, 0.11189821299995], [0.0951212405381588, 0.761241990602591, 0.0767994186031903], [0.0482516061458583, 0.101439036467562, 0.811302368396859]];
const AGX_OUTSET: M3 = [[1.1271005818144368, -0.1413297634984383, -0.14132976349843826], [-0.11060664309660323, 1.157823702216272, -0.11060664309660294], [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405]];
export const AGX_MIN_EV = -12.47393, AGX_MAX_EV = 4.026069;
const ACES_IN: M3 = [[0.59719, 0.07600, 0.02840], [0.35458, 0.90834, 0.13383], [0.04823, 0.01566, 0.83777]];
const ACES_OUT: M3 = [[1.60475, -0.10208, -0.00327], [-0.53108, 1.10813, -0.07276], [-0.07367, -0.00605, 1.07602]];

const agxContrast = (x: number): number => { const x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; };

/** AgX: scene-linear sRGB in, display-linear sRGB (0…1) out. */
export function agx(color: V3): V3 {
  let c = mul(AGX_INSET, mul(SRGB_TO_REC2020, color));
  c = c.map((v) => agxContrast(clamp01((Math.log2(Math.max(v, 1e-10)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV)))) as V3;
  c = mul(AGX_OUTSET, c).map((v) => Math.pow(Math.max(0, v), 2.2)) as V3;
  return mul(REC2020_TO_SRGB, c).map(clamp01) as V3;
}

const rrtOdt = (v: number): number => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
/** The ACES filmic fit: scene-linear sRGB in, display-linear sRGB (0…1) out. */
export function aces(color: V3): V3 {
  const c = mul(ACES_IN, [color[0] / 0.6, color[1] / 0.6, color[2] / 0.6]).map(rrtOdt) as V3;
  return mul(ACES_OUT, c).map(clamp01) as V3;
}

/** The sRGB transfer function: display-linear 0…1 to the encoded value a screen takes. */
export const srgbEncode = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
export const srgbDecode = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

/** How much light a number of stops lets through. */
export const exposureScale = (stops: number): number => Math.pow(2, stops);

/** Scene light to an encoded sRGB colour (0…1 per channel): exposure, the curve, the encoding. */
export function develop(color: V3, tone: ToneMap, stops = 0): V3 {
  const k = exposureScale(stops), c: V3 = [Math.max(0, color[0]) * k, Math.max(0, color[1]) * k, Math.max(0, color[2]) * k];
  return (tone === "aces" ? aces(c) : agx(c)).map(srgbEncode) as V3;
}

/**
 * The scene light that develops to a given colour: what a backdrop must be for the picture to show it as the
 * colour that was chosen.  The curve is not inverted channel by channel (it mixes them): the colour is scaled
 * until the developed picture is as bright as the one asked for, which is exact for greys and close for the
 * rest.  Whites past what the curve reaches come out as its brightest.
 */
export function sceneColorFor(hex: string, tone: ToneMap, stops = 0): V3 {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  const enc: V3 = m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0.5, 0.5, 0.5];
  const lin = enc.map(srgbDecode) as V3, lum = (c: V3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const want = lum(lin);
  if (want <= 1e-5) return [0, 0, 0];
  const shown = (k: number) => lum(develop([lin[0] * k, lin[1] * k, lin[2] * k], tone, stops).map(srgbDecode) as V3);
  let lo = 0, hi = 64;
  if (shown(hi) < want) return [lin[0] * hi, lin[1] * hi, lin[2] * hi];
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (shown(mid) < want) lo = mid; else hi = mid; }
  const k = (lo + hi) / 2;
  return [lin[0] * k, lin[1] * k, lin[2] * k];
}

const glslMat = (m: M3): string => `mat3( ${m.map((c) => `vec3( ${c.join(", ")} )`).join(", ")} )`;
/**
 * The same as GLSL: `vec3 jDevelop( vec3 sceneLinear, int tone, float exposure )` returns encoded sRGB, where
 * tone 0 is AgX and 1 is ACES and `exposure` is the multiplier of `exposureScale`; `jTone` stops before the
 * encoding (display-linear) and `jSrgb` is the encoding.
 */
export const TONEMAP_GLSL = /* glsl */`
  vec3 jAgxContrast( vec3 x ) {
    vec3 x2 = x * x; vec3 x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
  }
  vec3 jAgx( vec3 color ) {
    color = ${glslMat(AGX_INSET)} * ( ${glslMat(SRGB_TO_REC2020)} * color );
    color = log2( max( color, vec3( 1e-10 ) ) );
    color = clamp( ( color - ( ${AGX_MIN_EV} ) ) / ( ${AGX_MAX_EV} - ( ${AGX_MIN_EV} ) ), 0.0, 1.0 );
    color = ${glslMat(AGX_OUTSET)} * jAgxContrast( color );
    color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
    return clamp( ${glslMat(REC2020_TO_SRGB)} * color, 0.0, 1.0 );
  }
  vec3 jAces( vec3 color ) {
    vec3 v = ${glslMat(ACES_IN)} * ( color / 0.6 );
    v = ( v * ( v + 0.0245786 ) - 0.000090537 ) / ( v * ( 0.983729 * v + 0.4329510 ) + 0.238081 );
    return clamp( ${glslMat(ACES_OUT)} * v, 0.0, 1.0 );
  }
  vec3 jSrgb( vec3 v ) {
    return mix( v * 12.92, 1.055 * pow( max( v, vec3( 0.0 ) ), vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), v ) );
  }
  vec3 jTone( vec3 color, int tone, float exposure ) {
    color = max( color, vec3( 0.0 ) ) * exposure;
    return tone == 1 ? jAces( color ) : jAgx( color );
  }
  vec3 jDevelop( vec3 color, int tone, float exposure ) { return jSrgb( jTone( color, tone, exposure ) ); }
`;
