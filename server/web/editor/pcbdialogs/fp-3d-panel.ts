// pcbdialogs/fp-3d-panel — the Embedded Files notebook page both Footprint Properties dialogs share
// (PANEL_EMBEDDED_FILES: Filename / Embedded Reference, the delete bitmap button, Embed fonts, Export...).  The 3D
// Models page is model3d.ts' models3dPanel; the node work is pcb-tools' (fp-models.ts).
import { zstdDecompress } from "../../dialogs/zstd";
import { bitmapButton, errorMessage, grid, h, type CellValue, type Field } from "./ui";

/** EMBEDDED_FILES::DecompressAndDecode of a footprint's file `name`: base64, then the zstd frame. */
export function embeddedFileBytes(fp: SNode, name: string): Uint8Array | null {
  const ef = KiCadCanvas.kid(fp, "embedded_files"); if (!ef) return null;
  const f = (KiCadCanvas.kids(ef, "file") as SNode[]).find((x) => String((KiCadCanvas.kid(x, "name") || [])[1] ?? "") === name); if (!f) return null;
  const d = KiCadCanvas.kid(f, "data"); if (!d) return null;
  const b64 = d.slice(1).map((x) => String(x)).join("").replace(/[|\s]/g, "");
  try { const bin = atob(b64); const raw = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i); return zstdDecompress(raw); } catch { return null; }
}

/** PANEL_EMBEDDED_FILES over a footprint's files: get() is the names kept (only removal happens here). */
export function embeddedFilesPanel(opts: { names: string[]; ro: boolean; bytes(name: string): Uint8Array | null; embedFonts?: Field<boolean> }): { el: HTMLElement; get(): string[] } {
  const rows: Record<string, CellValue>[] = opts.names.map((n) => ({ name: n, ref: "kicad-embed://" + n }));
  const g = grid([{ label: "Filename", key: "name", readOnly: () => true }, { label: "Embedded Reference", key: "ref", readOnly: () => true }], rows, { ro: true, height: "260px", key: "embeddedFiles" });
  const del = bitmapButton("small_trash", "Remove embedded file", () => { const i = g.selected(); const r = g.rows(); if (i < 0 || i >= r.length) return; r.splice(i, 1); g.refresh(); if (r.length) g.select(Math.min(i, r.length - 1)); }, { key: "efDelete", disabled: opts.ro });
  const exp = h("button", { type: "button", class: "btn", "data-k": "efExport" }, "Export...") as HTMLButtonElement;
  exp.addEventListener("click", () => {
    const r = g.rows(), i = g.selected(); const names = i >= 0 && i < r.length ? [String(r[i].name)] : r.map((x) => String(x.name));
    for (const n of names) {
      const b = opts.bytes(n); if (!b) { errorMessage(`Could not read the embedded file '${n}'.`); continue; }
      const a = h("a", { href: URL.createObjectURL(new Blob([b as BlobPart], { type: "application/octet-stream" })), download: n }) as HTMLAnchorElement;
      document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
  });
  const el = h("div", null, g.el, h("div", { class: "pd-row", style: "margin-top:6px;gap:8px" }, del, h("span", { style: "flex:1" }), opts.embedFonts ? opts.embedFonts.el : null, exp));
  return { el, get: () => g.rows().map((r) => String(r.name)) };
}
