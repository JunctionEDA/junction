// keys.ts — how a hotkey reads on this platform.
//
// The web keeps every hotkey in KiCad's notation ("Ctrl+Shift+Z", "Alt+3", "Del"), the way the action tables
// spell them; this turns one into the text KiCad shows for it.  Elsewhere that text is the notation itself.  On
// a Mac it is what KiCad's macOS build shows (common/hotkeys_basic.cpp, USING_MAC_CMD):
//   • KeyNameFromKeyCode, used for tooltips ("Save  (Cmd+S)"), the hotkey list, status texts and labels:
//     MD_CTRL is wx's WXK_CONTROL, the Command key, written "Cmd+"; MD_ALT is "Option+"; Shift stays "Shift+",
//     in the order Cmd, Option, Shift.  The physical Control key (WXK_RAW_CONTROL) keeps the name "Ctrl".
//   • menus are native NSMenus: AddHotkeyName hands wx "\tCtrl+S" and macOS draws the key equivalent with its
//     glyphs, Control ⌃, Option ⌥, Shift ⇧, Command ⌘ in that order, no "+", the named keys as symbols.
// The key handling matches: Cmd is the Ctrl of the tables (editor/hotkeys.ts comboOf), Option is Alt.

function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  if (nav.platform) return /Mac|iPhone|iPad|iPod/i.test(nav.platform);
  const uad = nav.userAgentData && nav.userAgentData.platform;
  if (uad) return /mac|ios/i.test(uad);
  return /Macintosh|Mac OS X|iPhone|iPad/.test(nav.userAgent || "");
}

/** A Mac (navigator.platform, else navigator.userAgentData, else the user agent). */
export const IS_MAC = detectMac();

/** The modifier prefixes KeyCodeFromKeyName strips ("Cmd+" is Ctrl, "Option+" is Alt as the Mac build writes it). */
const MOD_PREFIXES: [string, "ctrl" | "alt" | "shift" | "rawCtrl" | "meta" | "super" | "altGr"][] = [
  ["RawCtrl+", "rawCtrl"], ["Ctrl+", "ctrl"], ["Cmd+", "ctrl"], ["Alt+", "alt"], ["Option+", "alt"], ["Shift+", "shift"],
  ["Meta+", "meta"], ["Win+", "super"], ["Super+", "super"], ["AltGr+", "altGr"],
];
/** A hotkey in KiCad's notation split into its modifiers and its key ("Ctrl++" is Ctrl and "+", "Num Pad +" one key). */
export function splitKey(key: string): { ctrl: boolean; alt: boolean; shift: boolean; rawCtrl: boolean; meta: boolean; super: boolean; altGr: boolean; key: string } {
  const out = { ctrl: false, alt: false, shift: false, rawCtrl: false, meta: false, super: false, altGr: false, key: "" };
  let k = key;
  for (;;) {
    const m = MOD_PREFIXES.find(([p]) => k.startsWith(p));
    if (!m) break;
    out[m[1]] = true; k = k.slice(m[0].length);
  }
  out.key = k;
  return out;
}

/** hotkeyNameList's names for the keys the web spells otherwise ("Enter" is KiCad's "Return", "Backspace" its "Back"). */
const KICAD_KEY_NAME: Record<string, string> = { Enter: "Return", Backspace: "Back", Delete: "Del", Escape: "Esc", Insert: "Ins", PageUp: "PgUp", PageDown: "PgDn" };
/** A key's name as KiCad writes it. */
export const kicadKeyName = (k: string): string => KICAD_KEY_NAME[k] || k;

/**
 * KeyNameFromKeyCode: the hotkey as text, for tooltips, the hotkey list, labels and messages.  On a Mac
 * "Ctrl+Shift+Z" reads "Cmd+Shift+Z" and "Alt+3" "Option+3"; elsewhere the notation is the text.
 */
export function keyName(key: string | null | undefined): string {
  if (!key) return "";
  const s = splitKey(key);
  // KeyNameFromKeyCode: Ctrl, Alt, Shift, Meta, Win, AltGr, then the key ("Ctrl+Alt+Shift+X")
  const mods: string[] = [];
  if (IS_MAC && s.rawCtrl) mods.push("Ctrl");
  if (s.ctrl || (!IS_MAC && s.rawCtrl)) mods.push(IS_MAC ? "Cmd" : "Ctrl");
  if (s.alt) mods.push(IS_MAC ? "Option" : "Alt");
  if (s.shift) mods.push("Shift");
  if (s.meta) mods.push("Meta");
  if (s.super) mods.push("Win");
  if (s.altGr) mods.push("AltGr");
  return mods.map((m) => m + "+").join("") + kicadKeyName(s.key);
}

/** A modifier key's own name ("Ctrl", "Alt", "Shift" in KiCad's notation): "Cmd" and "Option" on a Mac. */
export function modName(mod: "Ctrl" | "Alt" | "Shift"): string { return keyName(`${mod}+X`).slice(0, -2); }

/** The named keys as a macOS menu draws them (NSMenuItem key equivalents). */
const MAC_MENU_KEYS: Record<string, string> = {
  Del: "⌦", Delete: "⌦", Backspace: "⌫", Back: "⌫", Esc: "⎋", Escape: "⎋", Tab: "⇥", Enter: "↩", Return: "↩",
  Up: "↑", Down: "↓", Left: "←", Right: "→", PgUp: "⇞", PgDn: "⇟", Home: "↖", End: "↘",
};

/**
 * The hotkey beside a menu entry (menu bar, context menus, drop-down menus).  On a Mac the native menu's key
 * equivalent: "Ctrl+Shift+Z" → "⇧⌘Z", "Alt+3" → "⌥3", "Del" → "⌦"; elsewhere the notation ("Ctrl+Shift+Z").
 */
export function menuKey(key: string | null | undefined): string {
  if (!key) return "";
  if (!IS_MAC) return keyName(key);
  const s = splitKey(key);
  return (s.rawCtrl ? "⌃" : "") + (s.alt ? "⌥" : "") + (s.shift ? "⇧" : "") + (s.ctrl ? "⌘" : "") + (MAC_MENU_KEYS[s.key] || s.key);
}

/** Every hotkey written in a sentence ("Press Ctrl+E again", "Ctrl+Enter posts") in this platform's names. */
export function keysInText(text: string): string {
  if (!IS_MAC) return text;
  return text.replace(/\b((?:(?:Ctrl|Alt|Shift)\+)+)(?=\S)/g, (mods) => (/Ctrl|Alt/.test(mods) ? keyName(mods + "x").slice(0, -1) : mods));
}

/** The unshifted and shifted character of each punctuation key on the US layout, by KeyboardEvent.code. */
const PUNCT_CODES: Record<string, [string, string]> = {
  Backquote: ["`", "~"], Minus: ["-", "_"], Equal: ["=", "+"], BracketLeft: ["[", "{"], BracketRight: ["]", "}"], Backslash: ["\\", "|"],
  Semicolon: [";", ":"], Quote: ["'", "\""], Comma: [",", "<"], Period: [".", ">"], Slash: ["/", "?"], IntlBackslash: ["\\", "|"],
};

/**
 * KiCad names a shifted punctuation hotkey by the unshifted key ("Ctrl+Shift+." is Ctrl with Shift and the full stop
 * key, which types ">"): the combination spelled that way, from the physical key, or "" when it is not one.
 */
export function shiftedPunctCombo(ev: { code?: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string {
  const p = ev.shiftKey && ev.code ? PUNCT_CODES[ev.code] : undefined; if (!p) return "";
  const mods: string[] = []; if (ev.ctrlKey || ev.metaKey) mods.push("Ctrl"); mods.push("Shift"); if (ev.altKey) mods.push("Alt");
  return [...mods, p[0]].join("+");
}

/**
 * The key a hotkey names for this event.  Option (Alt) composes another character on a Mac and on some layouts:
 * Option+S types "ß", Option+/ "÷", and Option+` is a dead key ("Dead").  wx matches the key code of the physical
 * key, so this does too: letters and digits always by their code while Alt is held, punctuation when the key
 * typed something else (a dead key or a character outside ASCII).  Null for an event that names no key.
 */
export function hotkeyKey(ev: { key: string; code?: string; altKey: boolean; shiftKey: boolean }): string | null {
  const k = ev.key;
  if (!k || k === "Unidentified") return null;
  if (ev.altKey && ev.code) {
    const m = /^(?:Key|Digit)(.)$/.exec(ev.code); if (m) return m[1];
    const p = PUNCT_CODES[ev.code];
    if (p && (k === "Dead" || k.length !== 1 || k.charCodeAt(0) > 0x7e)) return p[ev.shiftKey ? 1 : 0];
  }
  return k === "Dead" ? null : k;
}

/**
 * hotkeyNameList (common/hotkeys_basic.cpp): every key a hotkey can name besides the printable ASCII characters
 * ('!' to '~'), and the mouse pseudo keys.
 */
export const HOTKEY_NAMES: readonly string[] = [
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  "Esc", "Del", "Tab", "Back", "Ins", "Home", "End", "PgUp", "PgDn", "Up", "Down", "Left", "Right", "Return", "Space",
  ...Array.from({ length: 10 }, (_, i) => `Num Pad ${i}`), "Num Pad +", "Num Pad -", "Num Pad *", "Num Pad /", "Num Pad .", "Num Pad Enter",
  "Num Pad F1", "Num Pad F2", "Num Pad F3", "Num Pad F4", "", "Click", "DblClick", "Wheel",
];
/** KeyNameFromKeyCode( aKey, &exists ): whether the key of a hotkey has a name (a printable character or a listed key). */
export function keyNameExists(key: string): boolean {
  const k = kicadKeyName(splitKey(key).key);
  if (k.length === 1) return k > " " && k < "\x7f";
  return k !== "" && HOTKEY_NAMES.includes(k);
}
/**
 * KeyCodeFromKeyName: a hotkey name read from a user.hotkeys file in this notation, modifiers in KiCad's order.
 * The modifier prefixes are matched as written ("Cmd+" is Ctrl; "Option+" only on a Mac, where it is the Alt
 * prefix); a key of one printable character is taken as it is, a named key in any case ("pgup" is "PgUp").
 * "" for an empty name (no hotkey), null when the key has no name (KEY_NON_FOUND).
 */
export function parseKeyName(name: string): string | null {
  let k = name; const m = { ctrl: false, alt: false, shift: false, meta: false, super: false, altGr: false };
  const prefixes: [string, keyof typeof m][] = [["Ctrl+", "ctrl"], ["Cmd+", "ctrl"], [IS_MAC ? "Option+" : "Alt+", "alt"], ["Shift+", "shift"], ["Meta+", "meta"], ["Win+", "super"], ["Super+", "super"], ["AltGr+", "altGr"]];
  for (;;) { const p = prefixes.find(([x]) => k.startsWith(x)); if (!p) break; m[p[1]] = true; k = k.slice(p[0].length); }
  let key: string | undefined;
  if (k.length === 1 && k > " " && k < "\x7f") key = k;
  else key = HOTKEY_NAMES.find((n) => n.toLowerCase() === k.toLowerCase());
  if (key === undefined) return null;
  if (key === "") return "";   // { "", 0 }: no hotkey
  return (m.ctrl ? "Ctrl+" : "") + (m.alt ? "Alt+" : "") + (m.shift ? "Shift+" : "") + (m.meta ? "Meta+" : "") + (m.super ? "Win+" : "") + (m.altGr ? "AltGr+" : "") + key;
}

/** The number pad's keys by KeyboardEvent.code, as hotkeyNameList names them (WXK_NUMPAD0 … WXK_NUMPAD_ENTER). */
const NUMPAD_CODES: Record<string, string> = {
  NumpadAdd: "Num Pad +", NumpadSubtract: "Num Pad -", NumpadMultiply: "Num Pad *", NumpadDivide: "Num Pad /", NumpadDecimal: "Num Pad .", NumpadEnter: "Num Pad Enter",
};
/**
 * The number pad key of this event ("Num Pad 5", "Num Pad Enter"), or null for any other key.  With Num Lock off
 * the pad's arrows and PgUp / PgDn are the plain keys (TOOL_DISPATCHER translateSpecialCode); its digits and
 * separator then type navigation keys, which are not number pad names either.
 */
export function numpadKey(ev: { key: string; code?: string }): string | null {
  const c = ev.code || ""; if (!c.startsWith("Numpad")) return null;
  const d = /^Numpad(\d)$/.exec(c);
  if (d) return /^\d$/.test(ev.key) ? `Num Pad ${d[1]}` : null;
  if (c === "NumpadDecimal" && ev.key !== "." && ev.key !== ",") return null;
  return NUMPAD_CODES[c] || null;
}
