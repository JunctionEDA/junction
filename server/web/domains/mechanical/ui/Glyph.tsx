// Glyph.tsx — an icon given as inline SVG markup (a feature's or a tool's `icon`), drawn in the colour of the
// text around it.
//
// How the part studio's icons are drawn, so that they read at a glance at 20 to 24 pixels:
//   • a 24×24 box; outlines 1.25 screen pixels wide at any size (non-scaling strokes, so they stay sharp however big the icon is drawn) with round ends and joins — the stroke is the same on every icon;
//   • a shape with class "f" is filled with the opaque face colour (--glyph-face in theme.css): the body of a solid, the face a tool
//     acts on.  The tinted mass is what tells Extrude from a rectangle and a Fillet from an arc;
//   • a shape with class "s" is solid: a point, an arrow head, the thing a tool adds;
//   • a shape with class "d" is a dashed outline: what was there before, a construction line, an axis;
//   • a shape with class "t" is a thin outline, for the second thing in an icon (what is acted on, not what acts).
// Every icon has a silhouette of its own; none relies on a detail smaller than two pixels.
export function Glyph({ svg, size = 18 }: { svg?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      className="cad-glyph flex-none fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [&_.f]:[fill:var(--glyph-face)] [&_.s]:fill-current [&_.s]:stroke-none [&_.d]:[stroke-dasharray:2.4_2.6] [&_.t]:[stroke-width:1px] [&_*]:[vector-effect:non-scaling-stroke] [shape-rendering:geometricPrecision]"
      strokeWidth="1.25px" dangerouslySetInnerHTML={{ __html: svg || '<rect x="5" y="5" width="14" height="14" rx="2"/>' }} />
  );
}
