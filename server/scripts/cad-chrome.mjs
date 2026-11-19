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
  // a face that is turned away cannot be clicked: the studio's own view call is what its click does
  if (view === 'iso' || view === 'fit') { await page.click(`.cad-viewcube [data-view=${view}]`); return; }
  await page.evaluate((view) => window.JunctionPartStudio.viewport.setView(view), view);
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
