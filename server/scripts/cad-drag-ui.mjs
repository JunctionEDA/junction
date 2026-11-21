// Browser check of the drag arrow on an extrusion (ui/DragHandles.tsx, ui/drag-snap.ts): with Extrude open on a
// sketch, an arrow stands where the extrusion ends; dragged along its direction the depth follows by round steps
// and the preview with it; Alt drags freely; pulled back through the sketch it turns the direction over; ✓ keeps
// the dragged depth.
//
// Setup as scripts/cad-ui.mjs:
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=testsecret E2E_BASE=http://127.0.0.1:8099 [SHOTS=/some/dir] node scripts/cad-drag-ui.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import { S, launch, newPartStudio, previewed, settled, signedIn, user } from './cad-ux-lib.mjs';

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };

const rect = (x0, y0, x1, y1) => ({
  p1: { type: 'point', x: x0, y: y0 }, p2: { type: 'point', x: x1, y: y0 }, p3: { type: 'point', x: x1, y: y1 }, p4: { type: 'point', x: x0, y: y1 },
  la: { type: 'line', a: 'p1', b: 'p2' }, lb: { type: 'line', a: 'p2', b: 'p3' }, lc: { type: 'line', a: 'p3', b: 'p4' }, ld: { type: 'line', a: 'p4', b: 'p1' },
});
const draft = (page) => S(page, () => { const e = window.JunctionPartStudio.getState().editing; return e ? { depth: e.draft.params.depth, flip: !!e.draft.params.flip, id: e.draft.id } : null; });
/** The arrow on the screen: where to take hold of it and which way it points. */
const arrow = (page) => page.evaluate(() => {
  const g = document.querySelector('.cad-drag-handle[data-handle="depth"]');
  if (!g || g.style.display === 'none') return null;
  const m = g.getScreenCTM(), at = (x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
  const a = at(0, 0), b = at(100, 0);
  return { grip: at(30, 0), ux: (b.x - a.x) / 100, uy: (b.y - a.y) / 100 };
});
async function pull(page, by, o = {}) {
  const a = await arrow(page);
  await page.mouse.move(a.grip.x, a.grip.y);
  await page.mouse.down();
  if (o.alt) await page.keyboard.down('Alt');
  for (let i = 1; i <= 8; i++) await page.mouse.move(a.grip.x + (a.ux * by * i) / 8, a.grip.y + (a.uy * by * i) / 8);
  if (o.shot) { await page.waitForTimeout(600); await page.screenshot({ path: `${SHOTS}/drag-${o.shot}.png` }); }
  await page.mouse.up();
  if (o.alt) await page.keyboard.up('Alt');
  await previewed(page);
}

const uid = user('cad-drag-alice', 991481);
const browser = await launch();
try {
  const page = await signedIn(browser, uid, 'cad-drag-alice');
  await newPartStudio(page, 'Drag arrow');
  const sk = crypto.randomUUID();
  await S(page, (f) => window.JunctionPartStudio.commit([{ id: f.id, kind: 'ADDED', typeName: 'feature', item: { ...f, type: 'feature' } }]), { id: sk, featureType: 'sketch', name: 'Sketch 1', order: 'a1', params: { plane: { kind: 'plane', plane: 'top' }, sketch: { version: 1, entities: rect(-30, -20, 30, 20), constraints: {} } } });
  await settled(page, 1);

  await S(page, (sk) => { const s = window.JunctionPartStudio; s.startFeature('extrude'); s.setDraft({ params: { profile: { sketch: sk, regions: null } } }); }, sk);
  await previewed(page);
  await page.waitForSelector('.cad-drag-handle[data-handle="depth"]');
  await page.waitForTimeout(400);
  const a0 = await arrow(page), d0 = await draft(page);
  check('with Extrude open on a sketch an arrow stands in the model', !!a0 && d0.depth === 10, JSON.stringify(d0));
  check('… pointing up the screen, the way the extrusion goes', !!a0 && a0.uy < -0.5, a0 ? `${a0.ux.toFixed(2)}, ${a0.uy.toFixed(2)}` : '');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/drag-arrow.png` });

  // ---- pulled out: the depth follows, by round steps
  await pull(page, 83, { shot: SHOTS ? 'pulling' : '' });
  const d1 = await draft(page);
  const step = await S(page, () => window.JunctionPartStudio.viewport.pixelSize());
  check('pulled out, the depth grows', d1.depth > 10, `${d1.depth} (a pixel is ${step.toFixed(3)} mm)`);
  check('… and stops at a round value', Math.abs(d1.depth * 2 - Math.round(d1.depth * 2)) < 1e-9, String(d1.depth));
  const a1 = await arrow(page);
  check('the arrow went with it', !!a1 && Math.hypot(a1.grip.x - a0.grip.x, a1.grip.y - a0.grip.y) > 30);
  const built = await S(page, (id) => window.JunctionPartStudio.getState().reports[id]?.status, d1.id);
  check('the preview is built at the new depth', built === 'ok', String(built));

  // ---- Alt: no steps
  await pull(page, 23.7, { alt: true });
  const d2 = await draft(page);
  check('with Alt it goes freely', d2.depth > d1.depth && Math.abs(d2.depth - Math.round(d2.depth)) > 1e-6, String(d2.depth));

  // ---- pulled back through the sketch: the other direction
  const a2 = await arrow(page);
  const perMm = Math.hypot(a2.ux, a2.uy) / step;   // screen pixels a millimetre along the arrow covers (at most 1 / step)
  await pull(page, -(d2.depth + 12) * Math.max(0.2, perMm));
  const d3 = await draft(page);
  check('pulled back through the sketch it extrudes the other way', d3.flip === true && d3.depth > 0, JSON.stringify(d3));
  const a3 = await arrow(page);
  check('… and the arrow points down the screen', !!a3 && a3.uy > 0.5, a3 ? a3.uy.toFixed(2) : '');

  // ---- accepted
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 2);
  const kept = await S(page, () => { const s = window.JunctionPartStudio.getState(); const f = s.features[s.features.length - 1]; return { depth: f.params.depth, flip: !!f.params.flip, status: s.reports[f.id]?.status }; });
  check('✓ keeps what was dragged', kept.depth === d3.depth && kept.flip && kept.status === 'ok', JSON.stringify(kept));
  check('and the arrow is gone with the dialog', (await page.locator('.cad-drag-handle').count()) === 0);
  check('no errors on the page', page.errors.length === 0, page.errors.join(' | '));
} finally { await browser.close(); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
