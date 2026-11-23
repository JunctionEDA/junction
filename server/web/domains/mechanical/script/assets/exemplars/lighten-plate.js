// Lighten plate: pocket a flat plate between its outline and its holes, leaving ribs.
//
// How it works, all in the face's own 2D plane:
//   1. field   = the outline shrunk by the edge margin, less every opening grown by its own margin
//   2. pockets = the field less the ribs (truss), or the cells of a pattern cut to the field (isogrid, hex)
//   3. round the pocket corners, drop slivers, check the plate stays in one piece, cut once.
feature({
  title: "Lighten plate",
  description: "Pocket a flat plate between its outline and holes, leaving ribs and a margin round every hole.",
  icon: "truss",
  params: {
    face: { type: "face", label: "Face to pocket", hint: "A flat face of the plate. Left empty: the largest flat face." },
    pattern: { type: "enum", label: "Pattern", options: { truss: "Truss", isogrid: "Isogrid", hex: "Hex" }, default: "truss" },
    rib: { type: "length", label: "Rib width", default: 4, min: 0.5 },
    margin: { type: "length", label: "Margin at edges", default: 5, min: 0.5 },
    boss: { type: "length", label: "Margin round holes", default: 4, min: 0.5 },
    pitch: { type: "length", label: "Cell size", default: 24, min: 3, show: { pattern: ["isogrid", "hex"] } },
    angle: { type: "angle", label: "Pattern angle", default: 0, min: -180, max: 180, show: { pattern: ["isogrid", "hex"] } },
    anchors: { type: "length", label: "Rib spacing along edges", hint: "0 ties the ribs to the corners only.", default: 0, min: 0, show: { pattern: "truss" } },
    narrowest: { type: "length", label: "Narrowest pocket", hint: "Pockets, and parts of pockets, narrower than this are left solid.", default: 8, min: 0 },
    fillet: { type: "length", label: "Corner radius", default: 2, min: 0 },
    through: { type: "boolean", label: "Through", default: true },
    depth: { type: "length", label: "Pocket depth", default: 3, min: 0.1, show: { through: false } },
  },

  evaluate(ctx, p) {
    const face = p.face || ctx.body().face({ kind: "plane" });
    if (!face || !face.plane) throw ctx.fail("Pick a flat face of the plate to pocket.");
    const before = face.body.volume;
    const outline = face.outline();

    // 1. where pockets may go
    const inside = Geo2.offset(outline.outer, -p.margin);
    if (!inside.length) throw ctx.fail("The edge margin is wider than the plate. Use a smaller margin.");
    const bosses = outline.holes.length ? Geo2.offset(outline.holes, p.boss) : [];
    const field = Geo2.difference(inside, bosses);
    if (!field.length) throw ctx.fail("The margins leave no room for pockets. Use smaller margins.");

    // 2. the pattern
    let pockets;
    if (p.pattern === "truss") {
      // ribs along a triangulation of the openings' centres and of points on the outline
      // (an outline point right beside an opening is left out: the opening is the anchor there)
      const centres = outline.holes.map((h) => Geo2.centroid(h));
      const near = p.margin + p.boss + 2 * p.rib;
      const anchors = Geo2.outlinePoints(outline.outer, p.anchors > 0 ? { spacing: p.anchors } : {})
        .filter((a) => !outline.holes.some((h) => Geo2.distance(h, a) < near));
      const points = centres.concat(anchors);
      const ribs = Geo2.delaunay(points).edges
        .filter(([i, j]) => i < centres.length || j < centres.length || !neighbours(i - centres.length, j - centres.length, anchors.length))
        .map(([i, j]) => [points[i], points[j]])
        .filter(([a, b]) => Geo2.contains(outline.outer, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]));
      pockets = ribs.length ? Geo2.difference(field, Geo2.thicken(ribs, p.rib)) : field;
    } else {
      const cells = Geo2.cells(p.pattern === "hex" ? "hex" : "tri", inside, { pitch: p.pitch, inset: p.rib / 2, angle: p.angle });
      pockets = Geo2.intersection(cells, field);
    }

    // 3. no slivers (shrink and grow back: what is narrower than the limit does not come back), then corners
    //    a cutter can make
    pockets = tidy(pockets, p);
    if (p.through) pockets = keepInOnePiece(ctx, outline, pockets, p);
    if (!pockets.length) throw ctx.fail("No pocket fits with these sizes. Use a narrower rib, smaller margins or a larger cell.");

    face.cut(pockets, p.through ? { through: true } : { depth: p.depth });

    const after = face.body.volume;
    ctx.report("Pockets", pockets.length);
    ctx.report("Mass saved", (100 * (before - after) / before).toFixed(1) + " %");
  },
});

function tidy(pockets, p) {
  const w = Math.max(p.narrowest, 2 * p.fillet) / 2;
  if (w > 0) pockets = Geo2.offset(Geo2.offset(pockets, -w, "miter"), w, "miter");
  // the spikes of material that point into a pocket are rounded too, by less than half a rib so that no rib is eaten
  return Geo2.round(pockets, p.fillet, Math.min(p.fillet, 0.4 * p.rib));
}

// Two anchors next to each other on the outline: the edge between them runs along the margin, not across the plate.
function neighbours(i, j, n) {
  const d = Math.abs(i - j);
  return d === 1 || d === n - 1;
}

// A through pocket that surrounds an island (a boss the pattern's ribs miss) would cut it loose: give each
// island three spokes, and refuse if the plate would still come apart.
function keepInOnePiece(ctx, outline, pockets, p) {
  const spokes = [];
  for (const pocket of pockets) {
    for (const island of pocket.holes) {
      const c = Geo2.centroid(island), reach = Geo2.bounds(pocket).size[0] + Geo2.bounds(pocket).size[1];
      for (const deg of [90, 210, 330]) {
        const t = (deg + (p.angle || 0)) * Math.PI / 180;
        spokes.push([c, [c[0] + reach * Math.cos(t), c[1] + reach * Math.sin(t)]]);
      }
    }
  }
  let out = pockets;
  if (spokes.length) out = tidy(Geo2.difference(pockets, Geo2.thicken(spokes, p.rib)), p);
  const pieces = Geo2.difference(outline, out).length;
  if (pieces > 1) throw ctx.fail("With these sizes the pockets would cut the plate into " + pieces + " pieces. Use a wider rib or margin, or a pocket depth instead of Through.");
  return out;
}
