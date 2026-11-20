// What the *-ui.mjs scripts share about the app's drop-downs.  The app has no native <select>: every drop-down is
// a <k-select> (web/shared/components/kselect.ts), whose list is a .ksel-pop on <body>, so Playwright's
// page.selectOption() does not work on it.  pickOption() chooses an entry the way a person does: a click on the
// control opens the list, a click on the entry picks it.
//
//   await pickOption(page, '[data-param=format]', 'step')     by the option's value
//   await pickOption(page, '#rvDoc', { label: 'board.kicad_pcb' })   by its text

/** Open the drop-down `sel` and click the entry with this value (or { label }); waits for the list to close. */
export async function pickOption(page, sel, want) {
  const control = page.locator(sel).first();
  await control.waitFor({ state: 'visible' });
  const index = await control.evaluate((el, want) => {
    if (el.tagName !== 'K-SELECT') throw new Error(`${el.tagName.toLowerCase()} is not a <k-select>`);
    const os = Array.from(el.options);
    return os.findIndex((o) => (typeof want === 'string' ? o.value === want : (o.label || o.text).trim() === want.label));
  }, want);
  if (index < 0) throw new Error(`${sel} has no entry ${JSON.stringify(want)}`);
  // the list closes when anything under it scrolls, as a native one does: bring the control into view first and
  // let a pane that scrolled to it settle, then open it (again, if a late scroll closed it)
  await control.scrollIntoViewIfNeeded();
  for (let attempt = 0; ; attempt++) {
    await page.waitForTimeout(150);
    await control.click();
    const row = page.locator(`.ksel-pop .ksel-opt[data-i="${index}"]`);
    try { await row.click({ timeout: 3000 }); break; } catch (e) { if (attempt >= 2) throw e; }
    if (await page.locator('.ksel-pop').count()) await page.keyboard.press('Escape');
  }
  await page.locator('.ksel-pop').waitFor({ state: 'detached' });
  // (a pick that navigates, such as a branch, may take the control away: nothing to read then)
  const got = await control.evaluate((el) => el.value, null, { timeout: 1000 }).catch(() => undefined);
  if (typeof want === 'string' && got !== undefined && got !== want) throw new Error(`${sel} shows ${JSON.stringify(got)} after picking ${JSON.stringify(want)}`);
}
