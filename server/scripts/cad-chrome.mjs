// What the cad-*-ui.mjs scripts share about the part studio's chrome.  The toolbar shows the tools of the mode
// the studio is in (modelling, a sketch, a dialog); a family of tools is a split button whose face runs the
// variant used last and whose caret opens the list (Rectangle ▾ holds Rectangle and Centre rectangle); what is
// used less, and in a narrow window whatever has no room, is under "More ▾" at the end of the tools; a docked
// panel may be folded.
//
//   await tool(page, 'Chamfer')          click the button, opening its drop-down first when it is in one
//   await toolTitles(page)               every feature and tool the toolbar offers, drop-downs included
//   await openPanel(page, 'comments')    unfold a docked panel (and its dock) if it is folded
//   await viewFrom(page, 'top')          a face of the view cube; 'iso' and 'fit' are the buttons under it
//   await cubeClick(page, [1, -1, 1])    click a zone of the view cube with the pointer, where it is on screen

/** Click a toolbar button by its title: a sketch tool while a sketch is open, a feature or a tool otherwise. */
export async function tool(page, title) {
  // a plain button, or the face of a split button that shows this variant just now
  const sel = `.cad-toolbar [data-group] [data-tool="${title}"]`;
  if (await page.locator(sel).count()) { await page.click(sel); return; }
  const menu = await page.evaluate((title) => {
    const m = Array.from(document.querySelectorAll('.cad-toolbar [data-menu]')).find((e) => (e.getAttribute('data-items') || '').split('|').includes(title));
    return m ? m.getAttribute('data-menu') : null;
  }, title);
  if (!menu) throw new Error(`The toolbar has no "${title}".`);
  await page.click(`.cad-toolbar [data-menu="${menu}"]`);
  await page.click(`.cad-tb-menu[data-menu-of="${menu}"] [data-tool="${title}"]`);
}

/**
 * The titles of everything the toolbar offers (in one group when given), with what the drop-downs hold and what
 * is under More; `onBar` leaves out what is under More.
 */
export async function toolTitles(page, group = '', onBar = false) {
  return page.evaluate(([group, onBar]) => {
    const out = [];
    for (const g of Array.from(document.querySelectorAll('.cad-toolbar [data-group]'))) {
      const of = g.getAttribute('data-group');
      if (of === 'more') {
        // More says which group each of its tools belongs to
        const m = g.querySelector('[data-menu]');
        const items = (m.getAttribute('data-items') || '').split('|'), groups = (m.getAttribute('data-item-groups') || '').split('|');
        if (!onBar) items.forEach((t, i) => { if (t && (!group || groups[i] === group)) out.push(t); });
        continue;
      }
      if (group && of !== group) continue;
      // the face of a split button repeats one of its drop-down's items: the drop-down lists them all
      for (const b of Array.from(g.querySelectorAll('[data-tool]:not([data-variant]), [data-menu]'))) {
        if (b.hasAttribute('data-menu')) out.push(...(b.getAttribute('data-items') || '').split('|'));
        else out.push(b.getAttribute('data-tool'));
      }
    }
    return out;
  }, [group, onBar]);
}

/** The mode the toolbar is in: "model", "sketch", "dialog" or "view" (no edit rights). */
export const toolbarMode = (page) => page.getAttribute('.cad-toolbar', 'data-mode');

/** Unfold a docked panel, and the dock it is in. */
export async function openPanel(page, id) {
  const side = await page.evaluate((id) => { const p = document.querySelector(`.cad-dock [data-panel="${id}"]`); return p ? p.closest('.cad-dock').getAttribute('data-side') : null; }, id);
  if (!side) throw new Error(`There is no "${id}" panel.`);
  if (await page.locator(`.cad-dock[data-side=${side}][data-folded]`).count()) await page.click(`[data-dock-unfold=${side}]`);
  if (!(await page.locator(`.cad-dock [data-panel="${id}"][data-open]`).count())) await page.click(`[data-panel-toggle="${id}"]`);
  await page.waitForSelector(`.cad-dock [data-panel="${id}"][data-open]`);
}

/** Turn the view with the view cube: 'top', 'front', 'right', 'back', 'left', 'bottom', or 'iso' / 'fit'. */
export async function viewFrom(page, view) {
  // the isometric view and zoom to fit are in the view cube's menu
  if (view === 'iso' || view === 'fit') { await viewMenu(page, view === 'iso' ? 'std-iso' : 'fit'); return; }
  // a face that is turned away cannot be clicked: the studio's own view call is what its click does
  await page.evaluate((view) => window.JunctionPartStudio.viewport.setView(view), view);
}

/**
 * Where a zone of the view cube is on screen, for a real pointer: `from` is a face's name ('top') or the direction
 * the zone looks from ([1, -1, 1]: the front right top corner).  The point is the zone's middle (a face's, an
 * edge's bevel, a corner's bevel), or with `on` ('top') the part of an edge's or corner's zone that lies on that
 * face, `inset` pixels from the face's border (the generous part of the zone, away from its bevel).
 */
export async function cubeAt(page, from, o = {}) {
  return page.evaluate(([from, on, inset]) => {
    const cube = document.querySelector('.cad-viewcube [data-cube]');
    const H = Number(cube.dataset.size) / 2, F = H - Number(cube.dataset.bevel), Z = Number(cube.dataset.zone);
    const FACE = { top: [0, 0, 1], bottom: [0, 0, -1], front: [0, -1, 0], back: [0, 1, 0], right: [1, 0, 0], left: [-1, 0, 0] };
    const d = typeof from === 'string' ? FACE[from] : from, count = d.filter((v) => v).length;
    let q;
    if (on) {
      const n = FACE[on], k = inset == null ? Z / 2 : inset;
      q = n.map((v, i) => (v ? v * H : d[i] * (F - k)));
    } else if (count === 1) q = d.map((v) => v * H);
    else if (count === 2) q = d.map((v) => v * (H + F) / 2);
    else q = d.map((v) => v * (H + 2 * F) / 3);
    const m = new DOMMatrix(getComputedStyle(cube).transform), o = cube.parentElement.getBoundingClientRect();
    const r = m.transformPoint(new DOMPoint(q[0], q[1], q[2])), persp = parseFloat(getComputedStyle(cube.parentElement).perspective) || 0;
    const k = persp ? persp / (persp - r.z) : 1;
    return { x: o.left + r.x * k, y: o.top + r.y * k };
  }, [from, o.on || null, o.inset ?? null]);
}

/** Click a zone of the view cube with the pointer, where it is on screen (see cubeAt). */
export async function cubeClick(page, from, o = {}) {
  const at = await cubeAt(page, from, o);
  await page.mouse.move(at.x, at.y, { steps: 2 });
  await page.mouse.click(at.x, at.y);
  return at;
}

/** Run an item of the view cube's menu, by its `data-view-item` ('std-iso', 'fit', 'Perspective', …). */
export async function viewMenu(page, item) {
  if (!(await page.locator('.cad-view-menu').count())) await page.click('.cad-viewcube [data-view-menu]');
  await page.click(`.cad-view-menu [data-view-item="${item}"]`);
}

/**
 * Start a sketch on a default plane ('top', 'front', 'right'): the Sketch button, which opens the sketch's dialog
 * with its plane field empty and listening, then the plane's row in the feature list.
 */
export async function sketchOn(page, plane = 'top') {
  await tool(page, 'Sketch');
  await page.waitForSelector('.cad-sketch-dialog[data-sketch-waiting] [data-sketch-plane][data-armed]');
  await page.click(`.cad-features [data-default-geometry=${plane}]`);
  await page.waitForFunction(() => window.JunctionSketch && window.JunctionSketch.getState().ready, null, { timeout: 30000 });
}
