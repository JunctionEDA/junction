// components/msgbox.ts — KIDIALOG / IsOK for every bundle (the React chrome, the GitHub panel, the plug-in manager):
// a themed message over the page with its buttons, never the browser's native confirm().  The overlay and dialog
// classes are theme.css's (.kd-overlay, .kd-dialog), so it needs no editor module.

function trapTab(ev: KeyboardEvent, root: HTMLElement): void {
  const f = Array.from(root.querySelectorAll<HTMLElement>("button,input,select,textarea,[tabindex]:not([tabindex='-1'])")).filter((e) => !(e as HTMLButtonElement).disabled);
  if (!f.length) return;
  const i = f.indexOf(document.activeElement as HTMLElement);
  const next = ev.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i >= f.length - 1 ? 0 : i + 1);
  ev.preventDefault(); f[next].focus();
}

/**
 * A question with a Cancel and an OK button (KIDIALOG::DoNotShowCheckbox-less, SetOKCancelLabels): resolves true
 * for OK.  `danger` draws the OK button as a destructive action.  Escape is Cancel, Enter is OK.
 */
export function askConfirm(title: string, message: string, opts: { ok?: string; cancel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") { resolve(false); return; }
    const ov = document.createElement("div"); ov.className = "kd-overlay"; ov.style.zIndex = "10050"; ov.dataset.k = "confirm";
    const dlg = document.createElement("div"); dlg.className = "kd-dialog"; dlg.setAttribute("role", "alertdialog"); dlg.setAttribute("aria-label", title);
    dlg.style.cssText = "width:max-content;min-width:400px;max-width:min(600px, calc(100vw - 32px))";
    const head = document.createElement("div"); head.className = "kd-title"; const t = document.createElement("span"); t.textContent = title; head.append(t);
    const body = document.createElement("div"); body.className = "kd-body";
    const p = document.createElement("p"); p.style.cssText = "margin:4px 0 6px;white-space:pre-wrap"; p.textContent = message; body.append(p);
    const foot = document.createElement("div"); foot.className = "kd-foot";
    const spacer = document.createElement("span"); spacer.className = "spacer";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn"; cancel.textContent = opts.cancel || "Cancel"; cancel.dataset.k = "confirm-cancel";
    const ok = document.createElement("button"); ok.type = "button"; ok.className = opts.danger ? "btn danger solid" : "btn primary"; ok.textContent = opts.ok || "OK"; ok.dataset.k = "confirm-ok";
    foot.append(spacer, cancel, ok);
    dlg.append(head, body, foot); ov.append(dlg);
    const done = (v: boolean): void => { ov.remove(); resolve(v); };
    cancel.addEventListener("click", () => done(false)); ok.addEventListener("click", () => done(true));
    ov.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Tab") trapTab(ev, ov);
      else if (ev.key === "Escape") { ev.preventDefault(); done(false); }
      else if (ev.key === "Enter" && !(ev.target instanceof HTMLButtonElement)) { ev.preventDefault(); done(true); }
    });
    document.body.append(ov); ok.focus();
  });
}

/**
 * A question with a few named ways to go on (wxRadioBox above OK/Cancel, as KiCad's own multi-way questions are):
 * resolves the chosen id, or null for Cancel.  The first choice starts selected; each choice may carry a line saying
 * what it does.
 */
export function askChoice(title: string, message: string, choices: { id: string; label: string; detail?: string }[],
  opts: { ok?: string; cancel?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined" || !choices.length) { resolve(null); return; }
    const ov = document.createElement("div"); ov.className = "kd-overlay"; ov.style.zIndex = "10050"; ov.dataset.k = "choice";
    const dlg = document.createElement("div"); dlg.className = "kd-dialog"; dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-label", title);
    dlg.style.cssText = "width:max-content;min-width:420px;max-width:min(620px, calc(100vw - 32px))";
    const head = document.createElement("div"); head.className = "kd-title"; const t = document.createElement("span"); t.textContent = title; head.append(t);
    const body = document.createElement("div"); body.className = "kd-body";
    const p = document.createElement("p"); p.style.cssText = "margin:4px 0 10px;white-space:pre-wrap"; p.textContent = message; body.append(p);
    const name = "kchoice" + Math.random().toString(36).slice(2);
    let picked = choices[0].id;
    choices.forEach((c, i) => {
      const row = document.createElement("label"); row.style.cssText = "display:flex;gap:8px;align-items:flex-start;margin:6px 0;cursor:pointer";
      const r = document.createElement("input"); r.type = "radio"; r.name = name; r.value = c.id; r.checked = i === 0; r.dataset.k = "choice-" + c.id;
      r.style.marginTop = "3px";
      r.addEventListener("change", () => { if (r.checked) picked = c.id; });
      const txt = document.createElement("span");
      const b = document.createElement("b"); b.textContent = c.label; txt.append(b);
      if (c.detail) { const d = document.createElement("div"); d.className = "muted"; d.style.cssText = "font-size:12px;opacity:.8"; d.textContent = c.detail; txt.append(d); }
      row.append(r, txt); body.append(row);
    });
    const foot = document.createElement("div"); foot.className = "kd-foot";
    const spacer = document.createElement("span"); spacer.className = "spacer";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn"; cancel.textContent = opts.cancel || "Cancel"; cancel.dataset.k = "choice-cancel";
    const ok = document.createElement("button"); ok.type = "button"; ok.className = "btn primary"; ok.textContent = opts.ok || "OK"; ok.dataset.k = "choice-ok";
    foot.append(spacer, cancel, ok);
    dlg.append(head, body, foot); ov.append(dlg);
    const done = (v: string | null): void => { ov.remove(); resolve(v); };
    cancel.addEventListener("click", () => done(null)); ok.addEventListener("click", () => done(picked));
    ov.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Tab") trapTab(ev, ov);
      else if (ev.key === "Escape") { ev.preventDefault(); done(null); }
      else if (ev.key === "Enter" && !(ev.target instanceof HTMLButtonElement)) { ev.preventDefault(); done(picked); }
    });
    document.body.append(ov); ok.focus();
  });
}
