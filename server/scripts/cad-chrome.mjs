// What the cad-*-ui.mjs scripts share about the part studio's chrome: a toolbar button may sit in a drop-down
// (Fillet ▾ holds Fillet, Chamfer and Draft) and a docked panel may be folded.
//
//   await tool(page, 'Chamfer')          click the button, opening its drop-down first when it is in one
//   await toolTitles(page)               every feature and tool the toolbar offers, drop-downs included
//   await openPanel(page, 'comments')    unfold a docked panel (and its dock) if it is folded

/** Click a toolbar button by its title. */
export async function tool(page, title) {
  const sel = `.cad-toolbar [data-group] > [data-tool="${title}"]`;
  if (await page.locator(sel).count()) { await page.click(sel); return; }
  const menu = await page.evaluate((title) => {
    const m = Array.from(document.querySelectorAll('.cad-toolbar [data-menu]')).find((e) => (e.getAttribute('data-items') || '').split('|').includes(title));
    return m ? m.getAttribute('data-menu') : null;
  }, title);
  if (!menu) throw new Error(`The toolbar has no "${title}".`);
  await page.click(`.cad-toolbar [data-menu="${menu}"]`);
  await page.click(`.cad-tb-menu [data-tool="${title}"]`);
}

/** The titles of everything in the toolbar (in one group when given), with what the drop-downs hold. */
export async function toolTitles(page, group = '') {
  return page.evaluate((group) => {
    const out = [];
    for (const g of Array.from(document.querySelectorAll('.cad-toolbar [data-group]'))) {
      if (group && g.getAttribute('data-group') !== group) continue;
      for (const b of Array.from(g.children)) {
        if (b.hasAttribute('data-tool')) out.push(b.getAttribute('data-tool'));
        else if (b.hasAttribute('data-menu')) out.push(...(b.getAttribute('data-items') || '').split('|'));
      }
    }
    return out;
  }, group);
}

/** Unfold a docked panel, and the dock it is in. */
export async function openPanel(page, id) {
  const side = await page.evaluate((id) => { const p = document.querySelector(`.cad-dock [data-panel="${id}"]`); return p ? p.closest('.cad-dock').getAttribute('data-side') : null; }, id);
  if (!side) throw new Error(`There is no "${id}" panel.`);
  if (await page.locator(`.cad-dock[data-side=${side}][data-folded]`).count()) await page.click(`[data-dock-unfold=${side}]`);
  if (!(await page.locator(`.cad-dock [data-panel="${id}"][data-open]`).count())) await page.click(`[data-panel-toggle="${id}"]`);
  await page.waitForSelector(`.cad-dock [data-panel="${id}"][data-open]`);
}
