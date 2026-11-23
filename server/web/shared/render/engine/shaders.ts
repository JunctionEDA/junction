// shaders.ts — the render engine's own GLSL: the changes made to the path tracer's shader (a ground that catches
// shadows, a limit on what one sample may add), the guide buffers and the filter of the denoiser, and the pass
// that develops the picture for the screen.
import { TONEMAP_GLSL } from "../tonemap";

// ---------------------------------------------------------------- the path tracer's shader, changed
//
// three-gpu-pathtracer's fragment shader is taken as it is and a few pieces are put into it:
//
//   backdrop  With a plain backdrop (or none) the camera's ray that hits nothing leaves the pixel empty: coverage
//             0 in the alpha channel.  The backdrop is put behind the picture when it is developed (DISPLAY
//             below), so it is exactly the colour that was chosen and changing it traces nothing again.  A ray
//             that reaches the backdrop through a clear solid brings the backdrop's light with it instead, tinted
//             by the solid (or, with no backdrop, lets through as much as the solid does).
//   ground    When the camera's ray lands on the ground (straight, or through a clear solid), what the pixel
//             shows is not the ground's plain shading but how much of its light the ground keeps there:
//
//               kept = ( bare − blocked + bounced ) / bare
//
//             `bare` is what the ground sends towards the eye with nothing standing on it — known exactly: the
//             tracer's own diffuse reflection integrated over the environment (environments.ts `ground`;
//             `jGroundFlat` and `jGroundGraze` here).  `blocked` is the part of it the model keeps off: each
//             sample of the lights taken at the ground counts in full when something is in its way and not at
//             all when nothing is.  `bounced` is what reaches the ground by way of the model.  Open ground is
//             therefore exactly 1 — no noise at all where there is no shadow, which is most of a picture — and
//             the estimate is unbiased (bare − blocked is the lit part by another name).  As a shadow catcher on
//             a plain backdrop the pixel is left empty but for coverage 1 − kept of black, which developed over
//             the backdrop is the backdrop darkened by the shadow, as a retoucher lays a shadow on white.  Where
//             the backdrop is the environment, or the ground is seen through glass, the backdrop's light is
//             scaled by kept instead.  A glossy floor keeps its own shading (its reflections are not part of
//             `bare`), scaled so that open floor is the backdrop.  The ground fades into the backdrop with
//             distance, so no horizon shows.
//   lights    The tracer samples the lights from a point nudged off the surface towards wherever the surface's
//             own scattered ray happened to go — under the surface, when that ray was one of the rough
//             reflection's that point into it — and a sample of the lights taken from under a surface is
//             shadowed by that surface.  Rough surfaces lost a tenth of their direct light that way.  The lights
//             are sampled from the lit side here, always.
//   clamp     One sample may add no more than `jClamp` to a pixel.  A path that finds a tiny bright light by
//             chance carries a huge value that hundreds of samples do not average away (a firefly); cutting it
//             loses a little energy from such paths and nothing else.  This is the one place the picture is
//             knowingly biased, and the limit is far above anything a surface lit by the studio reflects.
interface Patch { find: RegExp; put: string; where: "before" | "after" | "instead" }
const PATCHES: Patch[] = [
  {
    find: /uniform float opacity;/, where: "after",
    put: `
      uniform int jGroundMaterial;
      uniform int jGroundMode;
      uniform vec3 jGroundFlat;
      uniform vec3 jGroundGraze;
      uniform vec2 jGroundRange;
      uniform int jBackdropMode;
      uniform vec3 jBackdrop;
      uniform float jClamp;
      // what the last sample of the environment would have brought had nothing been in its way, less what it brought
      vec3 jNeeBlocked;
    `,
  },
  // a sample of the environment from a surface: taken whether or not it gets through, so that what was blocked is known
  { find: /vec3 directLightContribution\([^)]*\) \{\s*vec3 result = vec3\( 0\.0 \);/, where: "after", put: `jNeeBlocked = vec3( 0.0 ); bool jShut = false;` },
  { find: /! attenuateHit\( state, envRay, INFINITY, attenuatedColor \)/, where: "instead", put: `( ( jShut = attenuateHit( state, envRay, INFINITY, attenuatedColor ) ) || true )` },
  {
    find: /result = attenuatedColor \* environmentIntensity \* envColor \* state\.throughputColor \* sampleColor \* misWeight \/ envPdf;/, where: "instead",
    put: `
      vec3 jFull = environmentIntensity * envColor * state.throughputColor * sampleColor * misWeight / envPdf;
      result = jShut ? vec3( 0.0 ) : attenuatedColor * jFull;
      jNeeBlocked = jFull - result;
    `,
  },
  {
    find: /RenderState state = initRenderState\(\);/, where: "after",
    put: `
      // jGround: 0 not the ground, 1 the camera's ray landed on it, 2 it was reached through a clear solid
      // jStage: 1 at the ground, 2 its own sample of the lights is taken and its next ray is on its way, 3 past that
      int jGround = 0; int jStage = 0; float jGroundFade = 0.0;
      vec3 jGroundBg = vec3( 0.0 ); vec3 jGroundBare = vec3( 1.0 ); vec3 jBefore = vec3( 0.0 ); vec3 jThrough = vec3( 1.0 );
      vec3 jDirect = vec3( 0.0 ); vec3 jBlocked = vec3( 0.0 );
    `,
  },
  {
    // the backdrop behind everything, and behind glass
    find: /gl_FragColor\.rgb \+= sampleBackground\( ray\.direction, rand2\( 2 \) \) \* state\.throughputColor;\s*gl_FragColor\.a = backgroundAlpha;/, where: "instead",
    put: `
      if ( jBackdropMode == 0 ) {
        gl_FragColor.rgb += sampleBackground( ray.direction, rand2( 2 ) ) * state.throughputColor;
        gl_FragColor.a = backgroundAlpha;
      } else if ( state.firstRay ) {
        gl_FragColor.a = 0.0;
      } else if ( jBackdropMode == 1 ) {
        gl_FragColor.rgb += jBackdrop * state.throughputColor;
      } else {
        gl_FragColor.a = 1.0 - min( 1.0, dot( state.throughputColor, vec3( 0.2126, 0.7152, 0.0722 ) ) );
      }
    `,
  },
  {
    // the ground's next ray got away: the lights it found are the ground's own light
    find: /gl_FragColor\.rgb \+= environmentIntensity \* envColor \* state\.throughputColor \* misWeight;/, where: "instead",
    put: `
      vec3 jFound = environmentIntensity * envColor * state.throughputColor * misWeight;
      gl_FragColor.rgb += jFound;
      if ( jStage == 2 ) { jDirect += jFound; jStage = 3; }
    `,
  },
  {
    find: /if \( material\.matte && state\.firstRay \) \{/, where: "before",
    put: `
      if ( jGround == 0 && ( state.firstRay || state.transmissiveRay ) && int( materialIndex ) == jGroundMaterial ) {
        jGround = state.firstRay ? 1 : 2;
        jStage = 1;
        vec3 jHit = ray.origin + ray.direction * surfaceHit.dist;
        jGroundFade = smoothstep( jGroundRange.x, jGroundRange.y, length( jHit.xz ) );
        jGroundBg = jBackdropMode == 0 ? sampleBackground( ray.direction, rand2( 2 ) ) : jBackdrop;
        jGroundBare = jGroundFlat + pow( 1.0 - min( 1.0, abs( ray.direction.y ) ), 5.0 ) * jGroundGraze;
        jBefore = gl_FragColor.rgb;
        jThrough = state.throughputColor;
      }
    `,
  },
  {
    // the ground's next ray landed on the model: the lights it would have found are blocked
    find: /scatterRec = bsdfSample\( - ray\.direction, surf \);/, where: "before",
    put: `
      if ( jStage == 2 ) {
        vec3 jThere;
        float jPdf = sampleEquirect( envRotation3x3 * ray.direction, jThere );
        jBlocked += environmentIntensity * jThere * state.throughputColor * misHeuristic( scatterRec.pdf, jPdf / lightsDenom );
        jStage = 3;
      }
    `,
  },
  {
    find: /gl_FragColor\.rgb \+= directLightContribution\( - ray\.direction, surf, state, hitPoint \);/, where: "instead",
    put: `
      vec3 jNee = directLightContribution( - ray.direction, surf, state, stepRayOrigin( ray.origin, ray.direction, surf.faceNormal, surfaceHit.dist ) );
      gl_FragColor.rgb += jNee;
      if ( jStage == 1 ) { jDirect += jNee; jBlocked += jNeeBlocked; jStage = 2; }
    `,
  },
  {
    find: /gl_FragColor\.a \*= opacity;/, where: "before",
    put: `
      if ( jGround == 0 ) {
        float jPeak = max( gl_FragColor.r, max( gl_FragColor.g, gl_FragColor.b ) );
        if ( jPeak > jClamp ) gl_FragColor.rgb *= jClamp / jPeak;
      } else {
        vec3 jBare = max( jGroundBare * jThrough, vec3( 1e-5 ) );
        vec3 jGathered = gl_FragColor.rgb - jBefore;
        // what reached the ground by way of the model: a bright speck of it is cut like any other
        vec3 jBounced = max( jGathered - jDirect, vec3( 0.0 ) );
        float jPeak = max( jBounced.r, max( jBounced.g, jBounced.b ) );
        if ( jPeak > jClamp ) jBounced *= jClamp / jPeak;
        vec3 jKept = jGroundMode == 0 ? ( jBare - jBlocked + jBounced ) / jBare : ( jDirect + jBounced ) / jBare;
        if ( jGround == 1 && jGroundMode == 0 && jBackdropMode != 0 ) {
          float jShade = 1.0 - dot( jKept, vec3( 0.2126, 0.7152, 0.0722 ) );
          gl_FragColor = vec4( 0.0, 0.0, 0.0, jShade * ( 1.0 - jGroundFade ) );
        } else {
          vec3 jLight = jGroundBg * jThrough;
          gl_FragColor.rgb = jBefore + mix( jKept * jLight, jLight, jGroundFade );
          if ( jGround == 1 && jBackdropMode != 0 ) gl_FragColor *= 1.0 - jGroundFade;
        }
      }
    `,
  },
];

/** The path tracer's fragment shader with the engine's pieces in.  Throws when the shader is not the one this was written for. */
export function patchPathTracer(source: string): string {
  let out = source;
  for (const p of PATCHES) {
    const found = out.match(new RegExp(p.find.source, "g"));
    if (!found || found.length !== 1) throw new Error(`The path tracer's shader has changed: ${p.find.source} was expected once.`);
    out = out.replace(p.find, (hit) => (p.where === "after" ? hit + "\n" + p.put + "\n" : p.where === "before" ? p.put + "\n" + hit : p.put));
  }
  return out;
}

// ---------------------------------------------------------------- guide buffers
//
// What the camera sees first in each pixel, drawn the ordinary way: the surface's direction and distance in one
// target, its colour and how mirror-like it is in another.  The filter below reads them to know which pixels
// belong together.  Drawn several times with the camera nudged within the pixel and averaged, so an edge in the
// guides is as soft as the edge in the traced picture.
export const GUIDE_VERTEX = /* glsl */`
  precision highp float;
  in vec3 position;
  in vec3 normal;
  uniform mat4 modelMatrix;
  uniform mat4 viewMatrix;
  uniform mat4 projectionMatrix;
  uniform vec2 jitter;
  out vec3 vNormal;
  out float vDepth;
  void main() {
    vec4 world = modelMatrix * vec4( position, 1.0 );
    vec4 view = viewMatrix * world;
    vDepth = - view.z;
    vNormal = mat3( modelMatrix ) * normal;
    gl_Position = projectionMatrix * view;
    gl_Position.xy += jitter * gl_Position.w;
  }
`;
export const GUIDE_FRAGMENT = /* glsl */`
  precision highp float;
  uniform vec3 albedo;
  uniform float sharp;
  in vec3 vNormal;
  in float vDepth;
  layout( location = 0 ) out vec4 outNormalDepth;
  layout( location = 1 ) out vec4 outAlbedo;
  void main() {
    vec3 n = normalize( vNormal );
    if ( ! gl_FrontFacing ) n = - n;
    outNormalDepth = vec4( n, vDepth );
    outAlbedo = vec4( albedo, sharp );
  }
`;
/** Adds one drawing of the guides to their running sum. */
export const GUIDE_SUM_VERTEX = /* glsl */`
  precision highp float;
  in vec3 position;
  void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;
export const GUIDE_SUM_FRAGMENT = /* glsl */`
  precision highp float;
  uniform sampler2D tNormalDepth;
  uniform sampler2D tAlbedo;
  uniform float weight;
  layout( location = 0 ) out vec4 outNormalDepth;
  layout( location = 1 ) out vec4 outAlbedo;
  void main() {
    ivec2 p = ivec2( gl_FragCoord.xy );
    outNormalDepth = texelFetch( tNormalDepth, p, 0 ) * weight;
    outAlbedo = texelFetch( tAlbedo, p, 0 ) * weight;
  }
`;

// ---------------------------------------------------------------- the denoiser
//
// An edge-avoiding À-trous wavelet filter (Dammertz et al. 2010, the spatial half of SVGF): five passes of a
// 5 × 5 B-spline kernel whose taps are 1, 2, 4, 8 and 16 pixels apart, so the last pass reaches 64 pixels for the
// cost of 125 samples.  A neighbour counts for as much as it resembles the pixel in the guides (the same surface
// direction, the depth the pixel's own slope predicts, the same colour of material) and in brightness, where
// "the same brightness" is as wide as the noise still is at that pixel: `MOMENTS` measures the spread of
// brightness among each pixel's neighbours on the same surface first.  So a soft shadow is kept once the noise
// is smaller than the shadow, the filter lets go of the picture as it converges, and a finished render is not
// filtered at all.
// Mirror-like and clear surfaces (`sharp` in the guides) are filtered far less: what shows in them is not
// described by the guides.
//
// Before it, `DESPECKLE` pulls a pixel far brighter than every neighbour down to the brightest of them: a lone
// firefly would otherwise be spread into a disc.
const COMMON = /* glsl */`
  float jLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
  // how bright a pixel will look: its light, and the backdrop showing where it is not covered
  float jLog( vec4 c ) { return log( 1.0 + max( jLum( c.rgb ), 0.0 ) + clamp( 1.0 - c.a, 0.0, 1.0 ) ); }
`;
export const FULLSCREEN_VERTEX = /* glsl */`
  void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;
export const DESPECKLE_FRAGMENT = /* glsl */`
  uniform sampler2D tColor;
  uniform ivec2 size;
  ${COMMON}
  void main() {
    ivec2 p = ivec2( gl_FragCoord.xy );
    vec4 c = texelFetch( tColor, p, 0 );
    float top = 0.0;
    for ( int y = -1; y <= 1; y ++ ) for ( int x = -1; x <= 1; x ++ ) {
      if ( x == 0 && y == 0 ) continue;
      ivec2 q = clamp( p + ivec2( x, y ), ivec2( 0 ), size - 1 );
      top = max( top, jLum( texelFetch( tColor, q, 0 ).rgb ) );
    }
    float l = jLum( c.rgb );
    if ( l > 2.0 * top + 0.02 ) c.rgb *= ( 2.0 * top + 0.02 ) / l;
    gl_FragColor = c;
  }
`;
/** How noisy each pixel still is: the mean and the spread of brightness among its neighbours on the same surface. */
export const MOMENTS_FRAGMENT = /* glsl */`
  uniform sampler2D tColor;
  uniform sampler2D tNormalDepth;
  uniform sampler2D tAlbedo;
  uniform ivec2 size;
  ${COMMON}
  void main() {
    ivec2 p = ivec2( gl_FragCoord.xy );
    vec4 g0 = texelFetch( tNormalDepth, p, 0 );
    vec4 a0 = texelFetch( tAlbedo, p, 0 );
    float sum = 0.0, sq = 0.0, n = 0.0;
    for ( int y = -3; y <= 3; y ++ ) for ( int x = -3; x <= 3; x ++ ) {
      ivec2 q = p + ivec2( x, y );
      if ( q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y ) continue;
      vec4 g = texelFetch( tNormalDepth, q, 0 );
      vec4 a = texelFetch( tAlbedo, q, 0 );
      vec3 dn = g.xyz - g0.xyz, da = a.rgb - a0.rgb;
      float w = exp( - dot( dn, dn ) / 0.05 ) * exp( - dot( da, da ) / 0.012 ) * exp( - abs( g.w - g0.w ) / 0.08 );
      float l = jLog( texelFetch( tColor, q, 0 ) );
      sum += l * w; sq += l * l * w; n += w;
    }
    float mean = sum / max( n, 1e-4 );
    gl_FragColor = vec4( sqrt( max( 0.0, sq / max( n, 1e-4 ) - mean * mean ) ), mean, 0.0, 1.0 );
  }
`;
export const ATROUS_FRAGMENT = /* glsl */`
  uniform sampler2D tMoments;
  uniform sampler2D tColor;
  uniform sampler2D tNormalDepth;
  uniform sampler2D tAlbedo;
  uniform ivec2 size;
  uniform int stride;
  uniform float sigma;
  uniform bool first;
  ${COMMON}
  void main() {
    ivec2 p = ivec2( gl_FragCoord.xy );
    vec4 c0 = texelFetch( tColor, p, 0 );
    vec4 g0 = texelFetch( tNormalDepth, p, 0 );
    vec4 a0 = texelFetch( tAlbedo, p, 0 );
    // how fast depth changes across the pixel: a surface seen at a slant is still one surface
    ivec2 px = clamp( p + ivec2( 1, 0 ), ivec2( 0 ), size - 1 ), mx = clamp( p - ivec2( 1, 0 ), ivec2( 0 ), size - 1 );
    ivec2 py = clamp( p + ivec2( 0, 1 ), ivec2( 0 ), size - 1 ), my = clamp( p - ivec2( 0, 1 ), ivec2( 0 ), size - 1 );
    float zpx = texelFetch( tNormalDepth, px, 0 ).w - g0.w, zmx = g0.w - texelFetch( tNormalDepth, mx, 0 ).w;
    float zpy = texelFetch( tNormalDepth, py, 0 ).w - g0.w, zmy = g0.w - texelFetch( tNormalDepth, my, 0 ).w;
    vec2 slope = vec2( abs( zpx ) < abs( zmx ) ? zpx : zmx, abs( zpy ) < abs( zmy ) ? zpy : zmy );
    // the brightness neighbours are compared with (on the first pass the pixel alone is too noisy to judge by),
    // and how far from it a neighbour may be: as far as the noise here still reaches
    vec4 moments = texelFetch( tMoments, p, 0 );
    float l0 = first ? moments.g : jLog( c0 );
    float s = ( sigma * moments.r + 0.003 ) * ( 1.0 - 0.65 * clamp( a0.w, 0.0, 1.0 ) );
    float kernel[ 3 ];
    kernel[ 0 ] = 0.375; kernel[ 1 ] = 0.25; kernel[ 2 ] = 0.0625;
    vec4 total = vec4( 0.0 );
    float weight = 0.0;
    for ( int y = -2; y <= 2; y ++ ) for ( int x = -2; x <= 2; x ++ ) {
      ivec2 d = ivec2( x, y ) * stride, q = p + d;
      if ( q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y ) continue;
      float k = kernel[ abs( x ) ] * kernel[ abs( y ) ];
      vec4 c = texelFetch( tColor, q, 0 );
      if ( x == 0 && y == 0 ) { total += c * k; weight += k; continue; }
      vec4 g = texelFetch( tNormalDepth, q, 0 );
      vec4 a = texelFetch( tAlbedo, q, 0 );
      vec3 dn = g.xyz - g0.xyz;
      float wn = exp( - dot( dn, dn ) / 0.05 );
      float predicted = g0.w + dot( slope, vec2( d ) );
      float wz = exp( - abs( g.w - predicted ) / ( 0.012 + 0.6 * abs( dot( slope, vec2( d ) ) ) ) );
      vec3 da = a.rgb - a0.rgb;
      float wa = exp( - dot( da, da ) / 0.012 ) * exp( - abs( a.w - a0.w ) / 0.25 );
      float wl = exp( - abs( jLog( c ) - l0 ) / s );
      float w = k * wn * wz * wa * wl;
      total += c * w; weight += w;
    }
    gl_FragColor = total / max( weight, 1e-5 );
  }
`;

// ---------------------------------------------------------------- developing the picture
//
// From light to screen colours: exposure and the filmic curve (tonemap.ts), the backdrop put behind what the
// picture does not cover, the sRGB encoding, then a grain of under one step of the 8 bits a screen shows, so that
// a smooth backdrop does not band.  The traced picture may be coarser than the canvas (a draft, a view in
// motion): it is read with bilinear filtering.
//
//   compose 0   the picture covers everything (the environment is the backdrop)
//           1   over a plain backdrop, `backdrop` in display-linear sRGB
//           2   over nothing: colour beside its coverage, premultiplied
export const DISPLAY_FRAGMENT = /* glsl */`
  uniform sampler2D tColor;
  uniform vec2 sourceSize;
  uniform vec2 targetSize;
  uniform float exposure;
  uniform int tone;
  uniform int compose;
  uniform vec3 backdrop;
  ${TONEMAP_GLSL}
  float jHash( vec2 p ) { vec3 q = fract( vec3( p.xyx ) * 0.1031 ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.x + q.y ) * q.z ); }
  vec4 jFetch( ivec2 p ) { return texelFetch( tColor, clamp( p, ivec2( 0 ), ivec2( sourceSize ) - 1 ), 0 ); }
  void main() {
    vec2 at = gl_FragCoord.xy / targetSize * sourceSize - 0.5;
    ivec2 base = ivec2( floor( at ) );
    vec2 f = fract( at );
    vec4 c = mix( mix( jFetch( base ), jFetch( base + ivec2( 1, 0 ) ), f.x ), mix( jFetch( base + ivec2( 0, 1 ) ), jFetch( base + ivec2( 1, 1 ) ), f.x ), f.y );
    float alpha = compose == 0 ? 1.0 : clamp( c.a, 0.0, 1.0 );
    vec3 light = compose == 0 ? c.rgb : ( alpha > 1e-4 ? c.rgb / alpha : vec3( 0.0 ) );
    vec3 shown = jTone( light, tone, exposure );
    if ( compose == 1 ) { shown = shown * alpha + backdrop * ( 1.0 - alpha ); alpha = 1.0; }
    shown = jSrgb( shown );
    float grain = ( jHash( gl_FragCoord.xy ) + jHash( gl_FragCoord.xy + 17.0 ) - 1.0 ) / 255.0;
    shown = clamp( shown + grain, 0.0, 1.0 );
    gl_FragColor = vec4( shown * alpha, alpha );
  }
`;
