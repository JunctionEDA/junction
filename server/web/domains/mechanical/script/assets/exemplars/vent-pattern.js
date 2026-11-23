// Vent pattern: perforate a region of a flat face with round holes, slots or hexagons on a grid.
// The region is a sketch drawn on the face, or the whole face less a margin.
feature({
  title: "Vent pattern",
  description: "Perforate a region of a flat face with holes, slots or hexagons.",
  icon: "vent",
  params: {
    face: { type: "face", label: "Face", hint: "A flat face. Left empty: the largest flat face." },
    region: { type: "sketch", label: "Region", hint: "A sketch on the face. Left empty: the whole face less the margin." },
    shape: { type: "enum", label: "Openings", options: { round: "Round", slot: "Slots", hex: "Hexagons" }, default: "round" },
    size: { type: "length", label: "Opening size", default: 4, min: 0.3 },
    length: { type: "length", label: "Slot length", default: 16, min: 0.5, show: { shape: "slot" } },
    gap: { type: "length", label: "Gap between openings", default: 2.5, min: 0.3 },
    stagger: { type: "boolean", label: "Stagger rows", default: true },
    margin: { type: "length", label: "Margin", default: 6, min: 0 },
    angle: { type: "angle", label: "Pattern angle", default: 0, min: -180, max: 180 },
    through: { type: "boolean", label: "Through", default: true },
    depth: { type: "length", label: "Depth", default: 1, min: 0.05, show: { through: false } },
  },

  evaluate(ctx, p) {
    const face = p.face || ctx.body().face({ kind: "plane" });
    if (!face || !face.plane) throw ctx.fail("Pick a flat face to perforate.");
    const outline = face.outline();

    // the region, in the face's own coordinates, never nearer the face's edges and openings than the margin
    let area = Geo2.difference(Geo2.offset(outline.outer, -p.margin), Geo2.offset(outline.holes, p.margin));
    if (p.region) {
      const sk = p.region.plane;
      const onFace = (pt) => face.toLocal(V3.add(sk.origin, V3.add(V3.scale(sk.x, pt[0]), V3.scale(sk.y, pt[1]))));
      const drawn = p.region.regions.map((r) => ({ outer: r.outer.map(onFace), holes: r.holes.map((h) => h.map(onFace)) }));
      area = Geo2.intersection(area, drawn);
    }
    if (!area.length) throw ctx.fail("There is no room for openings: the region is empty or the margin too wide.");

    const long = p.shape === "slot" ? Math.max(p.length, p.size) : p.size;
    const dx = long + p.gap, dy = (p.shape === "hex" ? p.size : p.size) + p.gap;
    // every opening must lie wholly inside the region: keep its centre half its size away from the edge
    const centres = Geo2.grid(area, { dx: dx, dy: p.stagger ? dy * Math.sqrt(3) / 2 : dy, stagger: p.stagger, angle: p.angle, margin: long / 2 });
    if (!centres.length) throw ctx.fail("No opening fits. Use a smaller size or margin.");
    if (centres.length > 2500) throw ctx.fail("That would be " + centres.length + " openings. Use a larger size or gap.");

    const t = p.angle * Math.PI / 180, ux = Math.cos(t), uy = Math.sin(t);
    const openings = centres.map((c) => {
      if (p.shape === "hex") return Geo2.ngon(c, p.size / Math.sqrt(3), 6, p.angle + 30);
      if (p.shape === "slot" && long > p.size) {
        const h = (long - p.size) / 2;
        return Geo2.slot([c[0] - ux * h, c[1] - uy * h], [c[0] + ux * h, c[1] + uy * h], p.size);
      }
      return Geo2.circle(c, p.size / 2);
    });

    face.cut(openings, p.through ? { through: true } : { depth: p.depth });
    ctx.report("Openings", centres.length);
    ctx.report("Open area", (100 * Geo2.area(openings) / Geo2.area(area)).toFixed(0) + " % of the region");
  },
});
