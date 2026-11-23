// Angle bracket: an L of two legs with a rounded inside corner, bolt holes in each leg and an optional gusset.
// Made from nothing: it needs no part to start from.
feature({
  title: "Angle bracket",
  description: "An L bracket with bolt holes in both legs and an optional gusset.",
  icon: "bracket",
  params: {
    base: { type: "length", label: "Base leg", default: 60, min: 5 },
    upright: { type: "length", label: "Upright leg", default: 45, min: 5 },
    width: { type: "length", label: "Width", default: 40, min: 5 },
    thickness: { type: "length", label: "Thickness", default: 5, min: 0.5 },
    corner: { type: "length", label: "Inside radius", default: 4, min: 0 },
    hole: { type: "length", label: "Hole diameter", default: 5.5, min: 0 },
    holes: { type: "integer", label: "Holes per leg", default: 2, min: 0, max: 6 },
    gusset: { type: "boolean", label: "Gusset", default: true },
    gussetThickness: { type: "length", label: "Gusset thickness", default: 4, min: 0.5, show: { gusset: true } },
  },

  evaluate(ctx, p) {
    const t = p.thickness;
    if (t >= Math.min(p.base, p.upright)) throw ctx.fail("The thickness must be less than both legs.");
    // the L in the Front plane (x to the right, y up), its inside corner rounded
    const profile = Geo2.round([[0, 0], [p.base, 0], [p.base, t], [t, t], [t, p.upright], [0, p.upright]], 0, p.corner);
    const front = ctx.plane("front");
    let bracket = ctx.extrude(profile, front, { height: p.width });

    if (p.gusset) {
      const reach = Math.min(p.base, p.upright) - t;
      if (p.gussetThickness >= p.width) throw ctx.fail("The gusset is thicker than the bracket is wide.");
      if (reach > 2) {
        const web = ctx.extrude([[t, t], [t + reach, t], [t, t + reach]], front, { height: p.gussetThickness, offset: (p.width - p.gussetThickness) / 2 });
        bracket = ctx.union(bracket, web);
      }
    }

    if (p.hole > 0 && p.holes > 0) {
      // the Front plane's normal is −Y, so the bracket runs from y = 0 to y = −width
      const rows = spread(p.holes);
      const drill = (face, along, from, to) => {
        const points = [];
        // with a gusset the holes sit either side of it, otherwise on the centre line
        const across = p.gusset ? [0.2, 0.8] : [0.5];
        for (const r of rows) for (const w of across) points.push(face.toLocal(along(from + (to - from) * r, -p.width * w)));
        face.hole(points, { diameter: p.hole, through: true });
      };
      const clear = t + (p.gusset ? 0 : p.corner);
      const baseTop = bracket.face({ kind: "plane", normal: [0, 0, 1] });
      drill(baseTop, (s, y) => [s, y, t], clear + p.hole, p.base - p.hole);
      const inside = bracket.face({ kind: "plane", normal: [1, 0, 0], minArea: 1 });
      drill(inside, (s, y) => [t, y, s], clear + p.hole, p.upright - p.hole);
    }
    ctx.report("Mass in steel", bracket.mass(7.85).toFixed(1) + " g");
  },
});

// n positions spread evenly between 0 and 1 (one: the middle)
function spread(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(n === 1 ? 0.5 : i / (n - 1));
  return out;
}
