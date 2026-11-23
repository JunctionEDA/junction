// CodeEditor.tsx — the text editor of the custom feature editor: CodeMirror 6 with JavaScript colouring,
// completion and hover drawn from the Feature API's type file (script/apidoc.ts), and problems marked on
// their lines.  It knows nothing of scripts beyond that: text in, text out.
import { autocompletion, snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { API_DTS } from "../../generated/script-assets";
import { parseApi, receiverType, unionValues, type ApiIndex, type ApiMember } from "../apidoc";

let api: ApiIndex | null = null;
const index = (): ApiIndex => api || (api = parseApi(API_DTS));

/** the members a name before a dot may have: its own type's when the name says it, else every body, face and edge member */
function membersAfter(receiver: string): ApiMember[] {
  const idx = index(), type = receiverType(receiver);
  if (type && idx.types[type]) return idx.types[type];
  const seen = new Set<string>(), out: ApiMember[] = [];
  for (const owner of ["Face", "Body", "Edge", "Hole", "FaceHole", "Plane", "Region", "Sketch", "Box3"]) for (const m of idx.types[owner] || []) { if (!seen.has(m.name)) { seen.add(m.name); out.push(m); } }
  return out;
}
const firstLine = (doc: string): string => doc.split("\n")[0] || "";
const option = (m: ApiMember): Completion => ({ label: m.name, type: m.kind === "method" ? "function" : "property", detail: m.owner || undefined, info: `${m.signature}\n\n${m.doc}`.trim(), apply: m.name });

function complete(ctx: CompletionContext): CompletionResult | null {
  const dotted = ctx.matchBefore(/[A-Za-z_$][\w$]*\.\w*$/);
  if (dotted) {
    const at = dotted.text.lastIndexOf(".");
    return { from: dotted.from + at + 1, options: membersAfter(dotted.text.slice(0, at)).map(option), validFor: /^\w*$/ };
  }
  // inside quotes after `type:` or `icon:`, the values the API allows
  const quoted = ctx.matchBefore(/\b(type|icon|kind):\s*"[\w-]*$/);
  if (quoted) {
    const key = /^(\w+)/.exec(quoted.text)![1], from = quoted.from + quoted.text.lastIndexOf('"') + 1;
    const values = key === "icon" ? unionValues(API_DTS, "IconName") : key === "type" ? ["length", "angle", "number", "integer", "boolean", "enum", "text", "face", "faces", "edge", "edges", "body", "bodies", "sketch"] : ["plane", "cylinder", "cone", "sphere", "torus", "line", "circle"];
    return { from, options: values.map((v) => ({ label: v, type: "constant" })), validFor: /^[\w-]*$/ };
  }
  const word = ctx.matchBefore(/[A-Za-z_$][\w$]*$/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const globals: Completion[] = index().globals.map((m) => ({ label: m.name, type: m.kind === "method" ? "function" : "variable", info: `${m.signature}\n\n${m.doc}`.trim() }));
  const snippets: Completion[] = [
    snippetCompletion('feature({\n  title: "${1:My feature}",\n  icon: "${2:pockets}",\n  params: {\n    ${3:depth}: { type: "length", label: "${4:Depth}", default: ${5:3}, min: 0.1 },\n  },\n\n  evaluate(ctx, p) {\n    ${6}\n  },\n});', { label: "feature", detail: "a whole feature", type: "keyword" }),
    snippetCompletion('${1:name}: { type: "length", label: "${2:Label}", default: ${3:5}, min: ${4:0} },', { label: "param length", type: "keyword" }),
    snippetCompletion('${1:name}: { type: "enum", label: "${2:Label}", options: { ${3:a}: "${4:A}", ${5:b}: "${6:B}" }, default: "${3:a}" },', { label: "param enum", type: "keyword" }),
    snippetCompletion('${1:name}: { type: "boolean", label: "${2:Label}", default: ${3:true} },', { label: "param boolean", type: "keyword" }),
    snippetCompletion('${1:face}: { type: "face", label: "${2:Face}" },', { label: "param face", type: "keyword" }),
    snippetCompletion('throw ctx.fail("${1:What to do about it.}");', { label: "fail", detail: "fail with a sentence", type: "keyword" }),
  ];
  return { from: word.from, options: [...globals, { label: "ctx", type: "variable", info: "The context evaluate is handed: everything the feature may do." }, ...snippets], validFor: /^[\w$]*$/ };
}

const hover = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos), text = line.text, at = pos - line.from;
  let a = at, b = at;
  while (a > 0 && /[\w$]/.test(text[a - 1])) a--;
  while (b < text.length && /[\w$]/.test(text[b])) b++;
  if (a === b) return null;
  const word = text.slice(a, b), before = /([A-Za-z_$][\w$]*)\.$/.exec(text.slice(0, a));
  const idx = index();
  let found: ApiMember[] = [];
  if (before) { const own = membersAfter(before[1]).filter((m) => m.name === word); found = own.length ? own : idx.byName[word] || []; }
  else found = idx.globals.filter((m) => m.name === word);
  if (!found.length) return null;
  return {
    pos: line.from + a, end: line.from + b, above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "cf-hover";
      for (const m of found.slice(0, 3)) {
        const sig = document.createElement("code"); sig.textContent = (m.owner && !before ? "" : m.owner ? `${m.owner}.` : "") + m.signature;
        const doc = document.createElement("p"); doc.textContent = m.doc || firstLine(m.doc);
        dom.append(sig, doc);
      }
      return { dom };
    },
  };
});

// colours from the app's own theme (static/theme.css), so the editor follows light and dark with everything else
const look = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--panel)", color: "var(--ink)" },
  ".cm-scroller": { fontFamily: "var(--mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)", lineHeight: "1.5" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--ink-3)", border: "0", borderRight: "1px solid var(--line)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--ink) 4%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink)" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--ink)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", color: "var(--ink)", border: "1px solid var(--line-2)", borderRadius: "3px", boxShadow: "0 2px 8px rgb(0 0 0 / 0.12)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--sel, color-mix(in srgb, var(--accent) 18%, transparent))", color: "var(--ink)" },
  ".cm-completionInfo": { whiteSpace: "pre-wrap", maxWidth: "420px", padding: "6px 8px", fontSize: "12px" },
  ".cm-completionDetail": { color: "var(--ink-3)", fontStyle: "normal", marginLeft: "8px" },
  ".cf-hover": { maxWidth: "460px", padding: "6px 8px", fontSize: "12px" },
  ".cf-hover code": { display: "block", fontFamily: "var(--mono, ui-monospace, monospace)", whiteSpace: "pre-wrap", color: "var(--ink)" },
  ".cf-hover p": { margin: "3px 0 6px", whiteSpace: "pre-wrap", color: "var(--ink-2)" },
  ".cm-lintRange-error": { backgroundImage: "none", borderBottom: "2px solid var(--err)" },
  ".cf-error-line": { backgroundColor: "color-mix(in srgb, var(--err) 10%, transparent)" },
  ".cm-diagnostic": { fontSize: "12px", padding: "4px 8px" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--err)" },
});
const colours = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--accent)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--ok)" },
  { tag: [t.number, t.bool, t.null], color: "var(--copper, var(--warn))" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--ink-3)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--blue)" },
  { tag: [t.propertyName], color: "var(--ink)" },
  { tag: [t.definition(t.variableName)], color: "var(--ink)" },
]);

export interface Marker { line?: number; message: string }

export function CodeEditor({ value, onChange, markers, readOnly, onSave }: { value: string; onChange(text: string): void; markers: Marker[]; readOnly?: boolean; onSave?(): void }) {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onSave }); cb.current = { onChange, onSave };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup, javascript(), indentUnit.of("  "), EditorState.tabSize.of(2),
          keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { cb.current.onSave?.(); return true; } }, indentWithTab]),
          autocompletion({ override: [complete], icons: false }), hover, lintGutter(), look, syntaxHighlighting(colours),
          EditorView.editable.of(!readOnly), EditorState.readOnly.of(!!readOnly),
          EditorView.updateListener.of((u) => { if (u.docChanged) cb.current.onChange(u.state.doc.toString()); }),
          EditorView.contentAttributes.of({ "aria-label": "The feature's script", spellcheck: "false", "data-script-text": "" }),
        ],
      }),
    });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // the editor is made once; the text and the markers are pushed into it below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // text that changed outside (a script was loaded, the assistant's change accepted)
  useEffect(() => {
    const v = view.current; if (!v) return;
    const now = v.state.doc.toString();
    if (now !== value) v.dispatch({ changes: { from: 0, to: now.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const v = view.current; if (!v) return;
    const doc = v.state.doc;
    const diags: Diagnostic[] = markers.map((m) => {
      const line = doc.line(Math.max(1, Math.min(doc.lines, m.line || 1)));
      const from = line.from + (line.text.length - line.text.trimStart().length);
      return { from: m.line ? from : 0, to: m.line ? Math.max(from + 1, line.to) : Math.min(doc.length, 1), severity: "error", message: m.message };
    });
    v.dispatch(setDiagnostics(v.state, diags));
  }, [markers, value]);

  return <div ref={host} className="cf-code h-full min-h-0 overflow-hidden" data-script-editor-code />;
}
