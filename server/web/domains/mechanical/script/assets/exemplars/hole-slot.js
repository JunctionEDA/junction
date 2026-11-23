// Slot or bridge between two holes: join two round holes with a slot cut through the part, or tie them
// together with a raised bridge that leaves both holes open.
feature({
  title: "Hole-to-hole slot",
  description: "Join two holes with a slot, or tie them together with a raised bridge.",
  icon: "slot",
  params: {
    walls: { type: "faces", label: "Two holes", hint: "Click inside each hole. Left empty: the two holes nearest to each other." },
    kind: { type: "enum", label: "Make", options: { slot: "Slot", bridge: "Bridge" }, default: "slot" },
    width: { type: "length", label: "Width", hint: "0 makes the slot as wide as the smaller hole.", default: 0, min: 0, show: { kind: "slot" } },
    rim: { type: "length", label: "Rim round the holes", default: 3, min: 0.5, show: { kind: "bridge" } },
    height: { type: "length", label: "Bridge height", default: 3, min: 0.1, show: { kind: "bridge" } },
  },

  evaluate(ctx, p) {
    const pair = twoHoles(ctx, p.walls);
    const body = pair[0].faces[0].body;
    // the flat face both holes open on: square to their axis, the larger of the two sides
    const face = body.faces({ kind: "plane", parallelTo: pair[0].axis }).find((f) => {
      const local = pair.map((h) => f.toLocal(h.centre));
      return f.holes().filter((o) => local.some((c) => Math.hypot(o.centre[0] - c[0], o.centre[1] - c[1]) < 1e-3)).length === 2;
    });
    if (!face) throw ctx.fail("The two holes do not open on the same flat face.");
    const a = face.toLocal(pair[0].centre), b = face.toLocal(pair[1].centre);

    if (p.kind === "slot") {
      const width = p.width > 0 ? p.width : Math.min(pair[0].diameter, pair[1].diameter);
      if (width > Math.max(pair[0].diameter, pair[1].diameter) + 1e-6) ctx.warn("The slot is wider than both holes.");
      face.cut(Geo2.slot(a, b, width), { through: true });
      ctx.report("Slot length", Math.hypot(b[0] - a[0], b[1] - a[1]).toFixed(2) + " mm");
    } else {
      const widest = Math.max(pair[0].diameter, pair[1].diameter) + 2 * p.rim;
      const pad = Geo2.difference(Geo2.slot(a, b, widest), [Geo2.circle(a, pair[0].diameter / 2), Geo2.circle(b, pair[1].diameter / 2)]);
      face.add(Geo2.intersection(pad, face.outline().outer), { height: p.height });
    }
  },
});

function twoHoles(ctx, walls) {
  if (walls.length) {
    const holes = walls[0].body.holes().filter((h) => h.faces.some((f) => walls.some((w) => w.id === f.id)));
    if (holes.length !== 2) throw ctx.fail("Pick the walls of exactly two round holes (" + holes.length + " picked).");
    return holes;
  }
  const holes = ctx.body().holes();
  if (holes.length < 2) throw ctx.fail("The part needs two round holes to join.");
  let best = null;
  for (let i = 0; i < holes.length; i++) for (let j = i + 1; j < holes.length; j++) {
    const d = V3.distance(holes[i].centre, holes[j].centre);
    if (!best || d < best.d) best = { d: d, pair: [holes[i], holes[j]] };
  }
  return best.pair;
}
