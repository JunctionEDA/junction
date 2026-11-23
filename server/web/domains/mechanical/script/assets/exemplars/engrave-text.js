// Engrave text: a part number or a serial cut into a flat face, or raised from it.
feature({
  title: "Engrave text",
  description: "Cut a line of text into a flat face, or raise it.",
  icon: "text",
  params: {
    face: { type: "face", label: "Face", hint: "A flat face. Left empty: the largest flat face." },
    text: { type: "text", label: "Text", default: "PN-1001 A" },
    size: { type: "length", label: "Letter height", default: 6, min: 0.5 },
    raised: { type: "boolean", label: "Raised", default: false },
    depth: { type: "length", label: "Depth", default: 0.4, min: 0.02 },
    x: { type: "length", label: "Across", hint: "From the middle of the face.", default: 0 },
    y: { type: "length", label: "Up", default: 0 },
    angle: { type: "angle", label: "Angle", default: 0, min: -180, max: 180 },
  },

  evaluate(ctx, p) {
    const face = p.face || ctx.body().face({ kind: "plane" });
    if (!face || !face.plane) throw ctx.fail("Pick a flat face for the text.");
    if (!p.text.trim()) throw ctx.fail("Type the text to engrave.");
    const outline = face.outline();
    const middle = Geo2.bounds(outline.outer).centre;

    // set the text about the origin, then put its middle where it was asked for
    let letters = Geo2.text(p.text, { size: p.size, align: "centre" });
    if (!letters.length) throw ctx.fail("None of these characters can be drawn.");
    const box = Geo2.bounds(letters);
    letters = Geo2.translate(letters, [-box.centre[0], -box.centre[1]]);
    letters = Geo2.translate(Geo2.rotate(letters, p.angle), [middle[0] + p.x, middle[1] + p.y]);

    // letters that hang over the edge or over a hole would leave slivers
    if (Geo2.difference(letters, outline).length) throw ctx.fail("The text does not fit on the face there. Use smaller letters or move it.");

    if (p.raised) face.add(letters, { height: p.depth });
    else face.cut(letters, { depth: p.depth });
    ctx.report("Text width", box.size[0].toFixed(1) + " mm");
  },
});
