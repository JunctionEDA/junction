// theme.ts — the one owner of the UI theme (light / dark chrome).  The mode is "light", "dark" or "system";
// a person's choice is stored in localStorage under "kui.theme" ("light" | "dark" | "system") and shown as
// <html data-theme="light|dark|system">, which is what the tokens in static/theme.css key on (no attribute draws
// light, so a page with no script is light whatever the system says).
//
// With nothing chosen the default follows the Mechanical CAD setting (web/shared/cad.ts): light for a person who
// has CAD on (the part studio's readability pass), the system's for everybody else (signed out too), as the PCB
// editor has always been.  The pages' inline scripts cannot ask the server, so the page keeps a hint of the
// setting in localStorage ("kui.cad" = "1" while it is on; `followCadSetting`), and they read that.
// Every page applies the mode with a tiny inline script before the first paint (static/app.html and the other
// static pages, server/src/pages.rs THEME_BOOT; keep them in step with `stored` below), so a reload never flashes
// the other theme.  Both bundles (editor, ui) import this module; the state lives in the DOM and storage, so the
// two copies agree, and `subscribe` hears changes made by either.
export type ThemeMode = "light" | "dark" | "system";
export type Theme = "light" | "dark";

const KEY = "kui.theme";
/** "1" while the signed-in person has Mechanical CAD on: the default is light then (see the top of this file) */
const CAD_HINT = "kui.cad";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The mode when the person has chosen none: light with Mechanical CAD on, else the system's. */
export function defaultThemeMode(): ThemeMode {
  let cad = false;
  try { cad = localStorage.getItem(CAD_HINT) === "1"; } catch (e) { /* no storage */ }
  return cad ? "light" : "system";
}

function stored(): ThemeMode {
  let v: string | null = null;
  try { v = localStorage.getItem(KEY); } catch (e) { /* no storage */ }
  return v === "light" || v === "dark" || v === "system" ? v : defaultThemeMode();
}

/** The chosen mode (what the Appearance menu shows checked). */
export function getThemeMode(): ThemeMode {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" || t === "system" ? t : stored();
}

/** The theme in effect right now: the explicit choice, else the system's. */
export function effectiveTheme(): Theme {
  const m = getThemeMode();
  if (m !== "system") return m;
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function apply(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
}

/** Choose a mode, remember it, and tell the subscribers. */
export function setThemeMode(mode: ThemeMode): void {
  try { localStorage.setItem(KEY, mode); } catch (e) { /* no storage */ }
  apply(mode);
}

/**
 * The page learned whether the signed-in person has Mechanical CAD on (signed out: off), or it changed: remember
 * it for the pages' first paint and, when the person has chosen no theme, show the default that goes with it.
 */
export function followCadSetting(on: boolean): void {
  try { if (on) localStorage.setItem(CAD_HINT, "1"); else localStorage.removeItem(CAD_HINT); } catch (e) { /* no storage */ }
  apply(stored());
}

/** Flip between light and dark (the old "Toggle Dark Theme" entry): an explicit choice opposite to what shows now. */
export function toggleTheme(): void { setThemeMode(effectiveTheme() === "dark" ? "light" : "dark"); }

/**
 * Hear every change of the effective theme or the mode: a choice made here or in the other bundle (the attribute
 * changes), in another tab (storage), or by the system while the mode is "system".  Returns the unsubscribe.
 */
export function subscribeTheme(fn: (theme: Theme, mode: ThemeMode) => void): () => void {
  let last = "";
  const fire = () => { const t = effectiveTheme(), m = getThemeMode(), k = t + "/" + m; if (k !== last) { last = k; fn(t, m); } };
  const mo = new MutationObserver(fire);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const mq = typeof matchMedia === "function" ? matchMedia(DARK_QUERY) : null;
  if (mq) mq.addEventListener("change", fire);
  const onStorage = (ev: StorageEvent) => { if (ev.key === KEY || ev.key === CAD_HINT || ev.key === null) apply(stored()); };
  window.addEventListener("storage", onStorage);
  last = effectiveTheme() + "/" + getThemeMode();
  return () => { mo.disconnect(); if (mq) mq.removeEventListener("change", fire); window.removeEventListener("storage", onStorage); };
}

/** Make sure the page shows the stored mode (the inline script normally did already). */
export function initTheme(): void { apply(stored()); }
