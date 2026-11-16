// Turns the footage in out/ into the demo video: builds the timeline (which take, which part of it,
// how fast, which caption), has compose.html draw every frame in a browser, and encodes with ffmpeg.
// Numbers in the captions are read from what the recorded runs returned (out/state.json), not typed in.
//
//   node render.mjs [--stills]          → out/junction-demo.mp4 and out/junction-demo-poster.jpg (--stills: two frames a scene)
//
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || path.join(here, 'out');
const FPS = 30;
const state = JSON.parse(fs.readFileSync(path.join(OUT, 'state.json'), 'utf8'));
const take = (name) => { const dir = path.join(OUT, name); const m = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8')); return { dir: pathToFileURL(dir).href, ...m }; };
// when the drawing first changes in a take: the first photograph whose JPEG is noticeably larger than the opening one
const firstChange = (name, after) => { const dir = path.join(OUT, name); const m = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8')); const size = (f) => fs.statSync(path.join(dir, f.file)).size; const base = size(m.frames[0]);
  const hit = m.frames.find((f) => f.t >= after && size(f) > base * 1.03); return hit ? hit.t : after; };
const num = (text, re) => { const m = re.exec(text || ''); if (!m) throw new Error(`a caption number is missing: ${re}`); return m.slice(1); };

const ONE = { x: 160, y: 50, w: 1600, h: 900 };
const scenes = []; let at = 0;
const add = (s) => { s.start = +at.toFixed(3); at += s.length; scenes.push(s); return s; };
// a stretch [from, to] of a take, shown for `show` seconds (so its speed is what it has to be)
// several windows of one take, each with its own place on screen (and where it slides from): wins [{ dir, x, y, w, h, from, label, toasts }]
function multi(name, { from, to, show, captions, cutIn, cutOut, wins }) {
  const windows = wins.map((w) => { const t = take(w.dir ? `${name}/${w.dir}` : name); return { ...w, dir: t.dir, frames: t.frames }; });
  const speed = (to - from) / show;
  return add({ kind: 'footage', name, from, speed: +speed.toFixed(3), length: show, windows, cutIn: !!cutIn, cutOut: !!cutOut,
    captions: captions.map((c, i) => ({ text: c, at: (show * i) / captions.length, until: (show * (i + 1)) / captions.length })) });
}
function footage(name, { from, to, show, captions, split, cutIn, cutOut, chat, toasts, zoom }) {
  const takes = split ? split.map((s) => take(`${name}/${s.dir}`)) : [take(name)];
  from = from ?? 0; to = to ?? takes[0].length;
  const windows = split
    ? takes.map((t, i) => ({ x: 10 + i * 956, y: 110, w: 944, h: 800, dir: t.dir, frames: t.frames, label: split[i].label, chat: split[i].chat }))
    : [{ ...ONE, dir: takes[0].dir, frames: takes[0].frames, chat, toasts, zoom }];
  const speed = (to - from) / show;
  // cutIn / cutOut: this stretch continues the one before / after it (same take, another speed), so no fade there
  return add({ kind: 'footage', name, from, speed: +speed.toFixed(3), length: show, windows, cutIn: !!cutIn, cutOut: !!cutOut,
    captions: captions.map((c, i) => ({ text: c, at: (show * i) / captions.length, until: (show * (i + 1)) / captions.length })) });
}

const S = state.schematic, AI = state.ai, R = state.route, H = state.history;
const COL = { ben: '#2a9d63', chloe: '#9a63d1', dev: '#1f9fb8', ada: '#d9822b' };
const NAME = { ben: 'Ben', chloe: 'Chloé', dev: 'Dev' };
const BOARD = { s: 1.12, x: 0.5, y: 0.6 };
const beat = (name, opts) => fs.existsSync(path.join(OUT, name, 'frames.json')) && footage(name, opts);

const SOLO = process.argv.includes('--solo');      // Ada's screen only: Ben's arrival is a card over it, not his window
const LEFT = { x: 10, y: 250, w: 940, h: 529 }, RIGHT = { x: 970, y: 250, w: 940, h: 529 }, OFF = { x: 1930, y: 250, w: 940, h: 529 };
const frameOf = (name, t) => { const m = take(name); const f = m.frames.filter((x) => x.t <= t).pop() || m.frames[m.frames.length - 1]; return `${m.dir}/${f.file}`; };
// Everything plays at the speed it was recorded (1×): the people working together are shown whole, the other
// features are short cuts from the middle of their takes.
const cut = (name, from, len, opts = {}) => { const t = take(name); from = Math.max(0, Math.min(from, t.length - 0.2)); len = Math.min(len, t.length - from); return footage(name, { from, to: from + len, show: len, ...opts }); };
const beatAt = (name, from, len, captions) => fs.existsSync(path.join(OUT, name, 'frames.json')) && cut(name, from, len, { captions });
// cold open: a moment of the four of them routing, then the name
cut('route', R.marks.routed * 0.45, 2.2, { zoom: BOARD, cutOut: true, captions: [''] });
add({ kind: 'title', length: 1.6, title: 'Junction', sub: '' });
// Ada alone; Ben joins (his own window comes in beside hers, or a card on hers); then Chloé and Dev
{
  const jb = S.marks['join-ben'], after = 5.5;
  cut('schematic', 0, jb, { cutOut: true, captions: [''] });
  if (!SOLO && fs.existsSync(path.join(OUT, 'schematic', 'ben', 'frames.json'))) {
    multi('schematic', { from: jb, to: jb + after, show: after, cutIn: true, cutOut: true, captions: ['Ben joins'], wins: [
      { dir: '', ...LEFT, from: ONE, tween: 0.6, label: 'Ada' },
      { dir: 'ben', ...RIGHT, from: OFF, tween: 0.6, label: 'Ben', toasts: [{ at: 0.5, text: 'Ada is here', color: COL.ada }] }] });
    multi('schematic', { from: jb + after, to: jb + after + 0.6, show: 0.6, cutIn: true, cutOut: true, captions: [''], wins: [{ dir: '', ...ONE, from: LEFT, tween: 0.6 }] });
  } else {
    cut('schematic', jb, after, { cutIn: true, cutOut: true, toasts: [{ at: 0.1, text: 'Ben joined', color: COL.ben, big: true, initial: 'B', hold: 2.4 }], captions: [''] });
  }
  const from = jb + after + (SOLO ? 0 : 0.6), len = S.length - from;
  const toasts = ['chloe', 'dev'].filter((w) => S.marks[`join-${w}`] != null && S.marks[`join-${w}`] > from).map((w) => ({ at: S.marks[`join-${w}`] - from, text: `${NAME[w]} joined`, color: COL[w] }));
  cut('schematic', from, len, { cutIn: true, toasts, captions: [''] });
}
// the board takes shape: outline, Update PCB from Schematic; each person probes their blocks from the schematic and
// packs them beside the board; the parts go on; a click on the USB-C connector finds it in the schematic
{
  const PL = state.place, M = PL.marks;
  cut('place', 0, M.updated, { cutOut: true, captions: ['Edge.Cuts', 'Update PCB from Schematic'] });
  multi('place', { from: M.updated, to: M.probed, show: M.probed - M.updated, cutIn: true, cutOut: true, captions: ['Cross-probing'], wins: [
    { dir: 'sch', ...LEFT, from: OFF, tween: 0.5, label: 'Schematic' }, { dir: '', ...RIGHT, from: ONE, tween: 0.5, label: 'Board' }] });
  cut('place', M.probed, M.grouped - M.probed, { cutIn: true, cutOut: true, captions: ['Pack and Move'] });
  cut('place', M.grouped, M.placed - M.grouped, { cutIn: true, cutOut: true, captions: ['Placement'] });
  multi('place', { from: M.placed, to: PL.length, show: PL.length - M.placed, cutIn: true, captions: ['Cross-probing'], wins: [
    { dir: 'sch', ...LEFT, from: OFF, tween: 0.5, label: 'Schematic' }, { dir: '', ...RIGHT, from: ONE, tween: 0.5, label: 'Board' }] });
}
// four people route, then the planes fill
cut('route', 0, R.marks.routed, { cutOut: true, zoom: BOARD, captions: ['Routing'] });
cut('route', R.marks.routed, Math.min(3, R.length - R.marks.routed), { zoom: BOARD, cutIn: true, captions: ['Zone fill'] });
// the rest: short cuts
{
  const from = Math.max(0, AI.marks.ask - 1.2), len = Math.min(AI.length, AI.marks.accept + 3) - from, at = (m) => AI.marks[m] - from;
  cut('ai', from, len, { chat: { x: 1010, y: 560, head: 'AI CHAT', at: 0, until: at('card') - 0.2,
    lines: [{ who: 'Ada', text: 'Can you add the 12 MHz crystal circuit from the RP2040 design guide?', at: at('ask'), typing: 1.4 },
            { who: 'Claude', ai: true, text: 'Here is where it goes. I\'ll propose it for you to check.', at: at('highlight') + 0.3, typing: 0.9 }] },
    captions: ['AI assistant over MCP'] });
}
beatAt('history', 0, state.history.length, ['History']);
beatAt('parts', Math.max(0, (state.parts.marks.search || 0) - 1.5), 8, ['LCSC, Mouser and DigiKey parts']);
beatAt('plugins', 0.5, 8, ['Plugins']);
if (state.websim) beatAt('websim', Math.max(0, state.websim.marks.ran - 4), state.websim.length - Math.max(0, state.websim.marks.ran - 4), ['SPICE simulation']);
beat('github', { show: 7, captions: ['GitHub sync'] });
beatAt('fab', 0, state.fab.length, ['Fabrication outputs']);
beatAt('viewer3d', state.viewer3d.marks.loaded - 0.2, state.viewer3d.length - state.viewer3d.marks.loaded + 0.2, ['3D viewer']);
add({ kind: 'end', length: 3.4, bg: '', title: 'Junction', sub: '', links: ['kicad.notaroomba.dev'] });
const timeline = { length: +at.toFixed(3), fps: FPS, icon: pathToFileURL(path.join(here, '..', '..', 'static', 'icon.svg')).href, scenes };
fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({ ...timeline, scenes: scenes.map((s) => ({ ...s, windows: s.windows && s.windows.map((w) => ({ ...w, frames: w.frames.length })) })) }, null, 1));
console.log(`timeline ${timeline.length.toFixed(1)} s:`, scenes.map((s) => `${s.name || s.kind} ${s.length.toFixed(1)}s${s.speed ? ' ×' + s.speed.toFixed(1) : ''}`).join(', '));

const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: 'dark' })).newPage();
await page.goto(pathToFileURL(path.join(here, 'compose.html')).href);
await page.evaluate((t) => window.load(t), timeline);
const stills = process.argv.includes('--stills');
// the README's poster: a frame of the AI scene (both people and the AI's cursor), with a play button on it
const posterAt = scenes.filter((s) => s.name === 'schematic').pop(); await page.evaluate((t) => window.seek(t), posterAt.start + posterAt.length * 0.8);
await page.evaluate(() => { const d = document.createElement('div'); d.id = 'play'; d.style.cssText = 'position:absolute;left:50%;top:50%;width:150px;height:150px;margin:-75px 0 0 -75px;border-radius:50%;background:rgba(10,10,12,.78);box-shadow:0 0 0 2px rgba(255,255,255,.85)';
  d.innerHTML = '<div style="position:absolute;left:60px;top:45px;border-left:46px solid #fff;border-top:30px solid transparent;border-bottom:30px solid transparent"></div>'; document.getElementById('stage').appendChild(d); });
await page.screenshot({ path: path.join(OUT, 'junction-demo-poster.jpg'), type: 'jpeg', quality: 86 });
await page.evaluate(() => document.getElementById('play').remove());
const mp4 = path.join(OUT, SOLO ? 'junction-demo-solo.mp4' : 'junction-demo.mp4');
if (stills) {
  for (const s of scenes) for (const k of [0.3, 0.75]) { await page.evaluate((t) => window.seek(t), s.start + s.length * k); await page.screenshot({ path: path.join(OUT, `still-${String(scenes.indexOf(s)).padStart(2, '0')}-${k}.jpg`), type: 'jpeg', quality: 80 }); }
} else {
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', process.argv.includes('--final') ? 'slow' : 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = Math.round(timeline.length * FPS);
  for (let i = 0; i < total; i++) {
    await page.evaluate((t) => window.seek(t), i / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 300 === 0) console.log(`  frame ${i} of ${total}`);
  }
  ff.stdin.end(); await new Promise((r) => ff.on('close', r));
  console.log(mp4, (fs.statSync(mp4).size / 1e6).toFixed(1), 'MB');
}
await browser.close();
