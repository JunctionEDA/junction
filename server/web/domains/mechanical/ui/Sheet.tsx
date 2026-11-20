// Sheet.tsx — a window over the part studio for something with rows to read and change (the keys, the
// parameters, a batch export): a title, Close, a body that scrolls.  Esc and a click beside it close it.
import { useEffect, type ReactNode } from "react";
import { cx } from "../../../shared/util";

export function Sheet({ title, name, onClose, children, actions, wide, attrs }: { title: string; /** the class and aria name: "keymap" → .cad-keymap */ name: string; onClose(): void; children: ReactNode; /** buttons left of Close */ actions?: ReactNode; wide?: boolean; attrs?: { [key: string]: string | undefined } }) {
  useEffect(() => {
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape" && !ev.defaultPrevented) { ev.stopPropagation(); ev.preventDefault(); onClose(); } };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[65] grid place-items-center bg-[var(--scrim)]" onPointerDown={onClose} data-sheet={name}>
      <div className={cx(`cad-${name}`, wide ? "w-[min(1040px,96vw)]" : "w-[min(720px,94vw)]", "max-h-[86vh] flex flex-col rounded-md border border-line bg-bench shadow-panel text-sm text-ink")} role="dialog" aria-label={title} {...attrs} onPointerDown={(ev) => ev.stopPropagation()} onKeyDown={(ev) => { if (ev.key !== "Escape") ev.stopPropagation(); }}>
        <header className="flex flex-none items-center gap-1 h-9 px-3 border-b border-line bg-paper rounded-t-md"><span className="flex-1 font-semibold text-base truncate">{title}</span>{actions}<button type="button" className="btn sm ghost" data-sheet-close onClick={onClose}>Close</button></header>
        {children}
      </div>
    </div>
  );
}
