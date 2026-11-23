// Node test for the pure parts of Render mode (web/shared/render): the lighting environments made in code, the
// tone curves and their GLSL twin, the materials a document's looks become (old documents without a stored
// finish included), the turntable's camera path, the film containers muxed from a few tiny frames, the zip of
// PNG frames, the settings and the picking of a focus point.  The path tracer itself needs a graphics card and is
// checked in the browser (scripts/cad-render-ui.mjs).
// Run: node server/static/tests/cad-render.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./cad-load");

const E = load("shared/render/environments.ts");
const T = load("shared/render/tonemap.ts");
const M = load("shared/render/materials.ts");
const TT = load("shared/render/turntable.ts");
const V = load("shared/render/video.ts");
const Z = load("shared/render/zip.ts");
const S = load("shared/render/settings.ts");
const P = load("shared/render/pick.ts");
const L = load("domains/mechanical/document/materials-library.ts");
const A = load("domains/mechanical/document/appearance-items.ts");
const D = load("shared/itemdoc/itemdoc.ts");

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

// ---------------------------------------------------------------- environments
test("every environment is built in code, finite, under a half float's range and levelled to its design", () => {
  assert.deepEqual(E.ENVIRONMENTS.map((e) => e.id), ["softbox", "overhead", "three-point", "white", "dark", "sky"]);
  for (const spec of E.ENVIRONMENTS) {
    const img = E.buildEnvironment(spec.id, 256);
    assert.equal(img.width, 256); assert.equal(img.height, 128); assert.equal(img.data.length, 256 * 128 * 4);
    let min = Infinity;
    for (let i = 0; i < img.data.length; i++) { assert.ok(Number.isFinite(img.data[i]), `${spec.id}: a pixel is not a number`); if (i % 4 !== 3) min = Math.min(min, img.data[i]); }
    assert.ok(min >= 0, `${spec.id}: negative light`);
    assert.ok(img.peak <= E.MAX_RADIANCE && img.peak < 65504, `${spec.id}: peak ${img.peak}`);
    // a white card lying flat reflects the set-up's level: its irradiance over π
    near(lum(img.irradianceUp) / Math.PI, spec.level, spec.level * 0.03, `${spec.id} level`);
    // the ground's reflection (what the shadow catcher divides by) is close to a Lambertian card's
    near(lum(img.ground.flat), lum(img.irradianceUp) / Math.PI, lum(img.irradianceUp) / Math.PI * 0.25, `${spec.id} ground`);
    // the same call returns the same image (it is cached)
    assert.equal(E.buildEnvironment(spec.id, 256), img);
  }
});

test("the lights are where they are designed to be, and the moods differ as designed", () => {
  const px = (img, d) => { const [u, v] = E.uvOf(d); const x = Math.min(img.width - 1, Math.floor(u * img.width)), y = Math.min(img.height - 1, Math.floor(v * img.height)); const at = (y * img.width + x) * 4; return [img.data[at], img.data[at + 1], img.data[at + 2]]; };
  const softbox = E.buildEnvironment("softbox", 512), spec = E.environmentSpec("softbox");
  const key = spec.emitters[0];
  const onKey = lum(px(softbox, E.directionOf(key.azimuth, key.elevation)));
  const beside = lum(px(softbox, E.directionOf(key.azimuth + 90, key.elevation)));
  assert.ok(onKey > 20 * beside, `the key softbox (${onKey}) outshines the dome beside it (${beside})`);
  // warm key: more red than blue
  const k = px(softbox, E.directionOf(key.azimuth, key.elevation));
  assert.ok(k[0] > k[2]);
  // the sky: blue overhead, the sun far brighter than the sky round it
  const sky = E.buildEnvironment("sky", 512), up = px(sky, [0, 1, 0]);
  assert.ok(up[2] > up[0] * 1.5, `the zenith is blue: ${up}`);
  const sun = E.environmentSpec("sky").emitters[0];
  assert.ok(lum(px(sky, E.directionOf(sun.azimuth, sun.elevation))) > 100 * lum(up));
  // the dark studio is dark between its strips; seamless white is bright everywhere above the horizon
  const dark = E.buildEnvironment("dark", 256), white = E.buildEnvironment("white", 256);
  assert.ok(lum(px(dark, E.directionOf(0, 10))) < 0.05);
  assert.ok(lum(px(white, E.directionOf(150, 10))) > 0.5);
  // each has a backdrop colour; the dark one asks for the glossy floor
  for (const e of E.ENVIRONMENTS) assert.match(e.backdrop, /^#[0-9a-f]{6}$/);
  assert.equal(E.environmentSpec("dark").ground, "glossy");
  assert.equal(E.environmentSpec("nonsense").id, "softbox");
});

test("panorama directions and their pixels are each other's inverse", () => {
  for (const [u, v] of [[0.1, 0.2], [0.5, 0.5], [0.77, 0.9], [0.31, 0.03]]) {
    const [u2, v2] = E.uvOf(E.directionAt(u, v));
    near(u2, u, 1e-9, "u"); near(v2, v, 1e-9, "v");
  }
  const d = E.directionOf(30, 40);
  near(Math.hypot(...d), 1, 1e-12, "unit");
  near(d[1], Math.sin(40 * Math.PI / 180), 1e-12, "elevation");
});

// ---------------------------------------------------------------- tone mapping
test("AgX and ACES map scene light to the screen: black to black, monotonic, highlights roll off to white", () => {
  for (const curve of [T.agx, T.aces]) {
    const black = curve([0, 0, 0]);
    assert.ok(black.every((v) => v < 0.01), `black: ${black}`);
    let last = -1;
    for (let x = 0.001; x < 200; x *= 1.5) { const y = lum(curve([x, x, x])); assert.ok(y >= last - 1e-6, `not monotonic at ${x}`); last = y; }
    const hot = curve([200, 200, 200]);
    assert.ok(hot.every((v) => v > 0.95 && v <= 1), `white: ${hot}`);
    // greys stay grey
    const g = curve([0.18, 0.18, 0.18]);
    assert.ok(Math.max(...g) - Math.min(...g) < 0.01, `a grey is tinted: ${g}`);
  }
  // AgX takes a bright red towards white through paler red, not through orange: green and blue rise nearly together
  const red = T.agx([3, 0.15, 0.15]);
  assert.ok(red[0] > 0.8 && red[1] < red[0] * 0.75 && Math.abs(red[1] - red[2]) < 0.1, `bright red: ${red}`);
  const hotter = T.agx([60, 3, 3]);
  assert.ok(hotter.every((v) => v > 0.85) && Math.abs(hotter[1] - hotter[2]) < 0.06, `very bright red: ${hotter}`);
  // middle grey is a middle grey on screen
  const mid = T.develop([0.18, 0.18, 0.18], "agx")[0];
  assert.ok(mid > 0.35 && mid < 0.6, `0.18 develops to ${mid}`);
  // a stop is twice the light
  assert.equal(T.exposureScale(1), 2); assert.equal(T.exposureScale(-2), 0.25);
  assert.ok(T.develop([0.1, 0.1, 0.1], "agx", 1)[0] > T.develop([0.1, 0.1, 0.1], "agx", 0)[0]);
});

test("sRGB encoding round-trips, and a backdrop colour is found that develops to itself", () => {
  for (let v = 0; v <= 1; v += 0.05) near(T.srgbDecode(T.srgbEncode(v)), v, 1e-9, "sRGB");
  for (const hex of ["#e6e7e9", "#8f9298", "#0c0c0e", "#b4cbea"]) {
    for (const tone of ["agx", "aces"]) {
      const scene = T.sceneColorFor(hex, tone, 0), shown = T.develop(scene, tone, 0);
      const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      near(lum(shown), lum(want), 0.02, `${hex} under ${tone}`);
    }
  }
});

test("the GLSL tone curves are written from the same constants", () => {
  assert.match(T.TONEMAP_GLSL, /vec3 jAgx\( vec3 color \)/);
  assert.match(T.TONEMAP_GLSL, /vec3 jAces\( vec3 color \)/);
  assert.ok(T.TONEMAP_GLSL.includes(String(T.AGX_MIN_EV)) && T.TONEMAP_GLSL.includes(String(T.AGX_MAX_EV)));
  assert.ok(T.TONEMAP_GLSL.includes("0.856627153315983"));
  assert.equal(T.TONEMAP_GLSL.split("(").length, T.TONEMAP_GLSL.split(")").length, "balanced brackets");
});

// ---------------------------------------------------------------- materials
test("a library finish is cleaned: known keys only, each in range", () => {
  assert.equal(M.cleanFinish(null), null);
  assert.equal(M.cleanFinish({ nonsense: 3 }), null);
  assert.deepEqual(M.cleanFinish({ clearcoat: 2, ior: 0.5, transmission: "1", depth: 6, extra: 1 }), { clearcoat: 1, ior: 1, depth: 6 });
});

test("library appearances render as what they are: metals, moulded and printed plastics, real clear dielectrics, rubber, paint, glass", () => {
  const surf = (id) => { const ap = L.appearanceOf(id); assert.ok(ap, id); return M.physicalSurface({ color: ap.color, metalness: ap.metalness, roughness: ap.roughness, opacity: ap.opacity, finish: ap.finish }); };
  const al = surf("aluminium-brushed");
  assert.equal(al.metalness, 1); assert.equal(al.transmission, 0);
  const steel = surf("steel-stainless");
  assert.ok(steel.roughness < al.roughness);
  const abs = surf("abs-black");
  assert.equal(abs.metalness, 0); assert.equal(abs.transmission, 0); near(abs.ior, 1.53, 1e-9, "ABS ior");
  const pla = surf("pla-red");
  assert.ok(pla.color[0] > pla.color[1] * 5);
  for (const [id, ior] of [["acrylic-clear", 1.49], ["polycarbonate-smoke", 1.585], ["glass", 1.52], ["petg-clear", 1.57]]) {
    const s = surf(id);
    assert.ok(s.transmission >= 0.95, `${id} transmits (${s.transmission})`);
    near(s.ior, ior, 1e-9, `${id} ior`);
    assert.ok(Number.isFinite(s.attenuationDistance) && s.attenuationDistance > 0, `${id} takes its colour on with depth`);
    // the skin is nearly colourless: the colour is in the solid
    assert.ok(Math.min(...s.color) > 0.9, `${id} skin ${s.color}`);
  }
  const smoke = surf("polycarbonate-smoke");
  assert.ok(Math.max(...smoke.attenuationColor) < 0.2, "smoked polycarbonate darkens what goes through it");
  const rubber = surf("rubber-black");
  assert.ok(rubber.roughness >= 0.85 && rubber.sheen > 0);
  const paint = surf("paint-gloss-red");
  assert.equal(paint.clearcoat, 1); assert.ok(paint.clearcoatRoughness < 0.1);
  const anodised = surf("aluminium-anodised-blue");
  assert.ok(anodised.clearcoat > 0 && anodised.metalness === 1);
  // nothing is a perfect mirror
  for (const ap of L.APPEARANCES) assert.ok(surf(ap.id).roughness >= M.MIN_ROUGHNESS);
});

test("an old document (an appearance's id, no stored finish) renders with the library's finish; a hand-mixed see-through colour becomes a dielectric", () => {
  const old = { color: "#f2f8fa", metalness: 0, roughness: 0.04, opacity: 0.3, appearance: "acrylic-clear" };
  assert.deepEqual(L.finishOf(old), L.appearanceOf("acrylic-clear").finish);
  const s = M.physicalSurface(L.surfaceLookOf(old, "#888888"));
  assert.equal(s.transmission, 1); near(s.ior, 1.49, 1e-9, "acrylic");
  // a stored finish wins over the library's
  assert.deepEqual(L.finishOf({ ...old, finish: { ior: 1.6 } }), { ior: 1.6 });
  // no appearance, no finish: a colour mixed by hand, made see-through
  const mixed = M.physicalSurface({ color: "#3366cc", metalness: 0, roughness: 0.2, opacity: 0.5 });
  assert.ok(mixed.transmission > 0.8); near(mixed.ior, 1.5, 1e-9, "implied ior");
  // made opaque again: opaque in the picture too, whatever the finish says
  assert.equal(M.physicalSurface({ ...old, opacity: 1, finish: L.appearanceOf("acrylic-clear").finish }).transmission, 0);
  // a metal never transmits
  assert.equal(M.physicalSurface({ color: "#cccccc", metalness: 1, opacity: 0.4 }).transmission, 0);
  // a part with no look at all is the matt plastic of the colour it is drawn in
  const bare = M.physicalSurface(L.surfaceLookOf(undefined, "#b9bdc2"));
  assert.equal(bare.metalness, 0); assert.equal(bare.transmission, 0);
  // colours are linear
  near(M.linearOf("#808080")[0], 0.2158605, 1e-6, "linear 0x80");
});

test("dressing a part stores the finish beside the four numbers every reader knows; documents without one still read", () => {
  const doc = D.newItemDoc("part-studio", [{ id: "studio", type: "studio" }]);
  D.applyChanges(doc, L.applyAppearance(doc, [{ kind: "body", body: "b1" }], "paint-gloss-red"));
  const look = A.looksOf(doc).b1;
  assert.equal(look.color, "#b3201c"); assert.equal(look.metalness, 0); assert.equal(look.roughness, 0.15); assert.equal(look.appearance, "paint-gloss-red");
  assert.deepEqual(look.finish, { clearcoat: 1, clearcoatRoughness: 0.03 });
  // a reader that ignores `finish` sees exactly what it saw before
  const { finish, ...rest } = look; void finish;
  assert.deepEqual(rest, { color: "#b3201c", metalness: 0, roughness: 0.15, appearance: "paint-gloss-red" });
  // a stored look of the old form, and a junk finish, read cleanly
  const old = D.newItemDoc("part-studio", [{ id: "appearance", type: "appearance", bodies: { a: { color: "#c8ccd0", metalness: 1, roughness: 0.38, appearance: "aluminium-brushed" }, b: { color: "#ffffff", finish: { ior: "x", bogus: 1 } } } }]);
  const looks = A.looksOf(old);
  assert.equal(looks.a.finish, undefined); assert.equal(looks.b.finish, undefined);
  assert.equal(L.appearanceOfBody(old, "a").id, "aluminium-brushed");
});

// ---------------------------------------------------------------- the turntable
const RAD = Math.PI / 180;
test("the turntable's camera goes round the axis through the model's middle, at one distance and height, and loops", () => {
  const start = { projection: "perspective", quaternion: TT.lookFrom([1, -1, 0.6], [0, 0, 1]), target: [10, 0, 5], height: 80, fov: 30 };
  const spec = { axis: [0, 0, 1], centre: [0, 0, 5], frames: 48, turns: 1, elevation: null, path: "orbit", rise: 0 };
  const eye = (c) => TT.cameraPosition(c);
  const e0 = eye(start), f0 = TT.turntableCamera(start, spec, 0);
  for (let i = 0; i < 3; i++) near(eye(f0)[i], e0[i], 1e-9, "frame 0 is the view itself");
  const r0 = Math.hypot(e0[0], e0[1]);
  let lastAngle = Math.atan2(e0[1], e0[0]);
  for (let i = 1; i < 48; i++) {
    const c = TT.turntableCamera(start, spec, i), e = eye(c);
    near(Math.hypot(e[0], e[1]), r0, 1e-6, `radius at frame ${i}`);
    near(e[2], e0[2], 1e-6, `height at frame ${i}`);
    const a = Math.atan2(e[1], e[0]);
    let step = a - lastAngle; while (step < -Math.PI) step += 2 * Math.PI; while (step > Math.PI) step -= 2 * Math.PI;
    near(step, (2 * Math.PI) / 48, 1e-6, `even steps at frame ${i}`);
    lastAngle = a;
    // the picture stays upright: the camera's up has no part across the axis' plane that tilts it
    const right = TT.rotate(c.quaternion, [1, 0, 0]);
    near(right[2], 0, 1e-9, "level horizon");
  }
  // frame 48 would be frame 0 again
  const full = TT.turntableCamera(start, spec, 48);
  for (let i = 0; i < 3; i++) near(eye(full)[i], e0[i], 1e-6, "loops");
});

test("elevation, rise, other axes and the timing", () => {
  const start = { projection: "orthographic", quaternion: TT.lookFrom([0, -1, 0], [0, 0, 1]), target: [0, 0, 0], height: 50, fov: 30 };
  const spec = { axis: [0, 0, 1], centre: [0, 0, 0], frames: 10, turns: 1, elevation: 30, path: "orbit", rise: 0 };
  for (const i of [0, 3, 7]) near(TT.elevationOf(TT.turntableCamera(start, spec, i), spec.axis), 30, 1e-6, "elevation");
  const rise = { ...spec, path: "rise", rise: 20 };
  near(TT.elevationOf(TT.turntableCamera(start, rise, 0), rise.axis), 10, 1e-6, "rise starts lower");
  near(TT.elevationOf(TT.turntableCamera(start, rise, 9), rise.axis), 30, 1e-6, "and ends at the elevation");
  // about X: the camera stays in planes across X
  const x = { ...spec, axis: [1, 0, 0], elevation: 0 };
  for (const i of [1, 4, 8]) near(TT.rotate(TT.turntableCamera(start, x, i).quaternion, [0, 0, 1])[0], 0, 1e-9, "about X");
  // looking straight down the axis does not flip from frame to frame
  const down = { ...start, quaternion: TT.lookFrom([0, 0, 1], [0, 1, 0]) };
  const q = [0, 1, 2].map((i) => TT.turntableCamera(down, { ...spec, elevation: null }, i).quaternion);
  assert.ok(q.every((v) => v.every(Number.isFinite)));
  assert.deepEqual(TT.turntableTiming(1, 8), { frames: 8, frameMicros: 125000, seconds: 1 });
  assert.equal(TT.turntableTiming(6, 30).frames, 180);
  assert.equal(TT.formatEta(42), "42 s"); assert.equal(TT.formatEta(200), "3 min 20 s"); assert.equal(TT.formatEta(7300), "2 h 01 min"); assert.equal(TT.formatEta(NaN), "");
});

// ---------------------------------------------------------------- films
// An H.264 decoder configuration record (avcC) for a 160 × 120 Baseline stream, and three "frames" of bytes:
// the containers do not decode what they carry, so this is enough to check what they write around it.
const AVCC = Uint8Array.from([0x01, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0x00, 0x0b, 0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x02, 0x83, 0xf6, 0x02, 0x20, 0x00, 0x01, 0x00, 0x04, 0x68, 0xce, 0x3c, 0x80]);
const boxes = (buf, from = 0, to = buf.length) => { const out = []; let at = from; while (at + 8 <= to) { const size = buf.readUInt32BE(at), type = buf.toString("latin1", at + 4, at + 8); if (size < 8) break; out.push({ type, at, size }); at += size; } return out; };

test("a few tiny frames are muxed into an MP4 a player can read: ftyp, moov before mdat, one sample per frame", () => {
  const w = new V.ContainerWriter({ format: "mp4", codec: "avc1.42c01e", width: 160, height: 120, fps: 8 });
  for (let i = 0; i < 3; i++) w.addRaw(Uint8Array.from([0, 0, 0, 2, i === 0 ? 0x65 : 0x41, i]), i === 0 ? "key" : "delta", i * 125000, 125000, i === 0 ? AVCC : undefined);
  const file = Buffer.from(w.finish());
  const top = boxes(file);
  assert.deepEqual(top.map((b) => b.type).filter((t) => t !== "free"), ["ftyp", "moov", "mdat"]);
  assert.equal(top.reduce((n, b) => n + b.size, 0), file.length, "the boxes cover the file");
  const text = file.toString("latin1");
  for (const box of ["mvhd", "trak", "avc1", "avcC", "stts", "stsz"]) assert.ok(text.includes(box), `has ${box}`);
  // stsz: three samples
  const stsz = text.indexOf("stsz");
  assert.equal(file.readUInt32BE(stsz + 12), 3);
  // the track says 160 × 120 (tkhd width and height are 16.16 fixed point)
  const tkhd = text.indexOf("tkhd");
  assert.equal(file.readUInt32BE(tkhd + 4 + 76) >>> 16, 160);
  assert.equal(file.readUInt32BE(tkhd + 4 + 80) >>> 16, 120);
});

test("the same frames muxed into a WebM: an EBML header, a VP9 track and three blocks", () => {
  const w = new V.ContainerWriter({ format: "webm", codec: "vp09.00.10.08", width: 160, height: 120, fps: 8 });
  for (let i = 0; i < 3; i++) w.addRaw(Uint8Array.from([0x82, 0x49, 0x83, 0x42, i]), i === 0 ? "key" : "delta", i * 125000, 125000);
  const file = Buffer.from(w.finish());
  assert.equal(file.readUInt32BE(0), 0x1a45dfa3, "EBML magic");
  assert.ok(file.toString("latin1").includes("webm"), "doc type webm");
  assert.ok(file.toString("latin1").includes("V_VP9"), "a VP9 track");
  let blocks = 0; for (let i = 0; i < file.length; i++) if (file[i] === 0xa3) blocks++;
  assert.ok(blocks >= 3, `simple blocks: ${blocks}`);
});

test("where there is no video encoder the plan is a zip of PNG frames, and the zip is a valid archive", async () => {
  const plan = await V.planFilm(161, 121, 8);
  assert.equal(plan.format, "png-zip"); assert.equal(plan.extension, "zip");
  assert.equal(plan.width, 162); assert.equal(plan.height, 122, "even sizes");
  assert.match(plan.note, /no video encoder/);
  const entries = [{ name: "frame-0001.png", data: Uint8Array.from([1, 2, 3]) }, { name: "frame-0002.png", data: new Uint8Array(1000).fill(7) }];
  const zip = Buffer.from(Z.zipStore(entries));
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50); assert.equal(zip.readUInt16LE(end + 10), 2);
  let p = zip.readUInt32LE(end + 16); const names = [];
  for (let i = 0; i < 2; i++) { assert.equal(zip.readUInt32LE(p), 0x02014b50); const n = zip.readUInt16LE(p + 28); assert.equal(zip.readUInt32LE(p + 16), Z.crc32(entries[i].data)); names.push(zip.toString("utf8", p + 46, p + 46 + n)); p += 46 + n; }
  assert.deepEqual(names, ["frame-0001.png", "frame-0002.png"]);
  assert.equal(Z.crc32(Buffer.from("123456789")), 0xcbf43926, "the standard check value");
});

test("H.264 levels and codec strings follow the size and rate", () => {
  assert.equal(V.avcLevel(160, 120, 8), 0x1e);
  assert.equal(V.avcLevel(1280, 720, 30), 0x1f);
  assert.equal(V.avcLevel(1920, 1080, 30), 0x28);
  assert.equal(V.avcLevel(3840, 2160, 30), 0x33);
  assert.deepEqual(V.avcCodecs(1920, 1080, 30), ["avc1.640028", "avc1.4d0028", "avc1.420028"]);
  assert.equal(V.evenSize(161), 162); assert.equal(V.evenSize(1), 2);
});

// ---------------------------------------------------------------- settings and picking
test("settings from anything are checked field by field", () => {
  assert.deepEqual(S.cleanSettings(null), S.DEFAULT_SETTINGS);
  const s = S.cleanSettings({ environment: "dark", rotation: -90, intensity: 99, ground: "lava", background: "transparent", backgroundColor: "#ABCDEF", exposure: 2.5, tone: "aces", dof: true, fstop: 0.1, focus: [1, 2, 3], quality: "high", denoise: false });
  assert.equal(s.environment, "dark"); assert.equal(s.rotation, 270); assert.equal(s.intensity, 8); assert.equal(s.ground, "shadow");
  assert.equal(s.background, "transparent"); assert.equal(s.backgroundColor, "#abcdef"); assert.equal(s.tone, "aces");
  assert.equal(s.fstop, 0.7); assert.deepEqual(s.focus, [1, 2, 3]); assert.equal(s.quality, "high"); assert.equal(s.denoise, false);
  assert.equal(S.qualityOf("nope").id, "standard");
  const t = S.cleanTurntable({ duration: -1, fps: 500, width: 99999, samples: 0, axis: "q", turns: 0 });
  assert.equal(t.duration, 0.1); assert.equal(t.fps, 60); assert.equal(t.width, S.MAX_IMAGE_SIDE); assert.equal(t.samples, 1); assert.equal(t.axis, "z"); assert.equal(t.turns, 1);
});

test("the box of a scene and the first point a ray meets, through each mesh's placement", () => {
  // a unit square in z = 0 as two triangles, placed 10 up and 5 along x
  const mesh = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), normals: new Float32Array(12), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]), matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 10, 1], groups: [] };
  const scene = { meshes: [mesh] };
  assert.deepEqual(P.sceneBox(scene), [[5, 0, 10], [6, 1, 10]]);
  assert.deepEqual(P.boxCentre(P.sceneBox(scene)), [5.5, 0.5, 10]);
  const hit = P.pickPoint(scene, [5.25, 0.5, 50], [0, 0, -1]);
  assert.deepEqual(hit.map((v) => Math.round(v * 1e6) / 1e6), [5.25, 0.5, 10]);
  assert.equal(P.pickPoint(scene, [0, 0, 50], [0, 0, -1]), null);
  assert.equal(P.sceneBox({ meshes: [] }), null);
});
