// node server/static/tests/no-native-select.test.js — no native <select> in the browser app.
// A <select> opens the operating system's own popup (a macOS menu, a GTK list), which ignores the theme and is
// clipped or misplaced in panes.  The app draws its drop-downs with <k-select> (web/shared/components/kselect.ts)
// or its React face <Select> (web/shared/components/Select.tsx).  This reads every source under server/web and
// the hand-written pages in server/static, and fails on a <select> in JSX, markup or a template string, and on
// createElement("select") / h("select").  Comments are left out, so prose may still say "<select>".
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { WEB } = require("./web-path");

const STATIC = path.join(__dirname, "..");
/** kselect.ts is the stand-in itself; Select.tsx only names <select> in prose. */
const ALLOWED = new Set([path.join(WEB, "shared", "components", "kselect.ts")]);

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok  ", name); } catch (e) { failed++; console.error("FAIL", name + ":", e.message); } }

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "generated") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(tsx?|jsx?|mjs|html)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The text with comments blanked (newlines kept, so line numbers hold).  A `//` counts only at the start of a
 *  line or after whitespace or punctuation, so "https://" in a string is not taken for one. */
function stripComments(src, html) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  if (html) s = s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  return s.replace(/(^|[\s;,{}()])\/\/.*$/gm, "$1");
}

const PATTERNS = [
  /<select[\s>/]/,                                              // JSX, markup, innerHTML and template strings
  /createElement\(\s*["'`]select["'`]/,                         // document.createElement("select"), React.createElement
  /\b(?:h|el|jsxs?|jsxDEV)\(\s*["'`]select["'`]\s*[,)]/,        // the dialogs' h("select", …) and compiled JSX
];

function offenders(files) {
  const hits = [];
  for (const f of files) {
    if (ALLOWED.has(f)) continue;
    const lines = stripComments(fs.readFileSync(f, "utf8"), f.endsWith(".html")).split("\n");
    lines.forEach((l, i) => { if (PATTERNS.some((re) => re.test(l))) hits.push(`${path.relative(path.join(STATIC, ".."), f)}:${i + 1}: ${l.trim().slice(0, 160)}`); });
  }
  return hits;
}

test("the patterns catch each way a native select is written, and not prose or k-select", () => {
  const caught = (src) => PATTERNS.some((re) => stripComments(src, false).split("\n").some((l) => re.test(l)));
  for (const src of ['<select className="input">', 'el.innerHTML = `<select id="x">`', 'document.createElement("select")', "createElement('select', null)", 'h("select", { id: "a" })', 'jsx("select", { children: o })'])
    assert.ok(caught(src), src);
  for (const src of ['<k-select class="input">', "// a <select> opens the OS popup", "/* <select> */", 'h("k-select")', 'setTool("select")', 'type: "select"', 'const url = "https://x"; // <select>'])
    assert.ok(!caught(src), src);
});

test("no source under server/web renders a native <select>: use <k-select> or <Select>", () => {
  const hits = offenders(walk(WEB, []));
  assert.deepStrictEqual(hits, [], "\n" + hits.join("\n"));
});

test("no hand-written page in server/static has a native <select>", () => {
  const pages = fs.readdirSync(STATIC).filter((n) => n.endsWith(".html")).map((n) => path.join(STATIC, n));
  assert.ok(pages.length > 0);
  const hits = offenders(pages);
  assert.deepStrictEqual(hits, [], "\n" + hits.join("\n"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
