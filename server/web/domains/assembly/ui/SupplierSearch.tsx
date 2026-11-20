// SupplierSearch.tsx — the Insert dialog's "Suppliers" tab: type a supplier's part number or a standard size, see
// the models that match with a picture of each, and click one to place it.
//
// The search is the server's (suppliers/api.ts, server/src/models3d): standard hardware Junction draws itself,
// McMaster-Carr, LCSC, KiCad's 3D library, the FreeCAD library, TraceParts, a library of one's own.  A click
// fetches the model, keeps it in the project and adds an instance (suppliers/place.ts); the row says what it is
// doing meanwhile.  A provider without credentials is named at the foot as not connected: it is not an error.
//
// InsertDialog.tsx mounts two things from here and nothing else: <SupplierTabs> in its header and
// <SupplierSearch> in place of its list.
import { useEffect, useRef, useState } from "react";
import { cx } from "../../../shared/util";
import { searchModels } from "../suppliers/api";
import { sizeText, supplierInfo, type ModelHit, type ModelSearch } from "../suppliers/model";
import { placeModel } from "../suppliers/place";
import type { AssemblyEditor } from "./assembly";
import { Glyph, type MenuItem } from "./parts";

export type InsertTab = "project" | "suppliers";

/** The two halves of Insert: what the project has, and what suppliers have. */
export function SupplierTabs({ tab, setTab }: { tab: InsertTab; setTab(t: InsertTab): void }) {
  return (
    <span className="seg ml-auto text-sm font-normal" role="tablist" aria-label="Where to insert from">
      {(["project", "suppliers"] as const).map((t) => (
        <button key={t} type="button" role="tab" aria-selected={tab === t} data-insert-tab={t} className={cx("!min-h-0 !py-0 h-5.5 !px-2", tab === t && "on")} onClick={() => setTab(t)}>{t === "project" ? "Project" : "Suppliers"}</button>
      ))}
    </span>
  );
}

const EXAMPLES = ["M5x20 socket head", "DIN 912 M3x8", "1/4-20 x 1 button head", "M4 nut", "608 bearing", "2020 extrusion 300", "91251A431 1/4-20 x 1"];
const LINK = '<path d="M10 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4"/><path d="M14 4h6v6"/><path d="M20 4l-9 9"/>';
const BOX = '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/>';

/** In the instance list: the link from an instance placed from a supplier to that supplier's page of the part. */
export function SupplierMark({ instance }: { instance: object }) {
  const s = supplierInfo(instance);
  if (!s) return null;
  const what = `${s.title}${s.equivalent ? " (a generated equivalent, not the supplier's own model)" : s.generated ? " (drawn by Junction from the standard)" : ""}`;
  if (!s.url) return <span className="flex-none text-ink-3" title={what} data-supplier={s.title}><Glyph svg={BOX} size={12} /></span>;
  return <a href={s.url} target="_blank" rel="noopener noreferrer" className="flex-none text-ink-3 hover:text-ink" title={`${what}\nOpen ${s.name}'s page`} aria-label={`Open ${s.name}'s page of ${s.partNumber}`} data-supplier={s.title} data-supplier-link onClick={(ev) => ev.stopPropagation()}><Glyph svg={LINK} size={12} /></a>;
}

/** The instance's context menu entry for the same link. */
export function supplierMenu(instance: object | null | undefined): MenuItem[] {
  const s = supplierInfo(instance);
  return s && s.url ? [{ label: `Open ${s.name}'s page`, run: () => { window.open(s.url, "_blank", "noopener,noreferrer"); } }] : [];
}

/** A row's picture: the outline of a part Junction draws, the supplier's photo, or a plain box. */
function Thumb({ hit }: { hit: ModelHit }) {
  const [broken, setBroken] = useState(false);
  const frame = "flex-none w-10 h-10 rounded-sm border border-line bg-panel flex items-center justify-center overflow-hidden";
  if (hit.thumb && hit.thumb.d) {
    const [x, y, w, h] = hit.thumb.box, pad = Math.max(w, h) * 0.08 || 1;
    return (
      <span className={frame} data-thumb="outline">
        <svg width={34} height={34} viewBox={`${x - pad} ${y - pad} ${w + 2 * pad} ${h + 2 * pad}`} aria-hidden="true">
          <path d={hit.thumb.d} fillRule="evenodd" className="fill-[var(--line-2)] stroke-[var(--ink-2)]" strokeWidth={1.2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (hit.image && !broken) return <span className={frame} data-thumb="photo"><img src={hit.image} alt="" loading="lazy" className="max-w-full max-h-full object-contain" onError={() => setBroken(true)} /></span>;
  return <span className={cx(frame, "text-ink-3")} data-thumb="none"><Glyph svg={BOX} size={20} /></span>;
}

function Row({ hit, busy, say, pick, refine }: { hit: ModelHit; busy: boolean; say: string; pick(): void; refine(q: string): void }) {
  const can = !!hit.format;
  const kind = !can ? "" : hit.generated ? (hit.equivalent ? "Generated equivalent" : "Generated") : hit.format.toUpperCase();
  const tip = [hit.title, hit.description, hit.note, hit.license ? `Licence: ${hit.license}` : ""].filter(Boolean).join("\n");
  const act = () => { if (busy) return; if (can) pick(); else if (hit.hint) refine(hit.hint); };
  return (
    <div role="option" aria-selected={false} aria-disabled={!can && !hit.hint} tabIndex={0} data-model={hit.title} data-provider={hit.provider} data-format={hit.format} data-busy={busy || undefined} title={tip}
      className={cx("flex items-start gap-2 px-2 py-1.5 border-b border-line last:border-b-0 outline-none", can || hit.hint ? "cursor-default hover:bg-sel-soft focus-visible:bg-sel-soft" : "text-ink-2", busy && "bg-sel")}
      onClick={act} onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); act(); } }}>
      <Thumb hit={hit} />
      <span className="flex-1 min-w-0 flex flex-col">
        <span className="flex items-center gap-1">
          <span className="flex-1 truncate font-medium" data-title>{hit.title}</span>
          {hit.url ? <a href={hit.url} target="_blank" rel="noopener noreferrer" className="flex-none text-ink-3 hover:text-ink" title={`Open ${hit.supplier}'s page of ${hit.part_number}`} aria-label={`Open ${hit.supplier}'s page of ${hit.part_number}`} data-supplier-link onClick={(ev) => ev.stopPropagation()}><Glyph svg={LINK} size={13} /></a> : null}
        </span>
        <span className="text-xs text-ink-2 line-clamp-2">{hit.description}</span>
        {busy ? <span className="text-xs text-ink-2 flex items-center gap-1.5 mt-0.5" data-placing><span className="spinner" />{say || "Placing…"}</span> : (
          <span className="flex flex-wrap items-center gap-x-1.5 text-2xs text-ink-3 mt-0.5">
            {kind ? <span className={cx("px-1 rounded-[2px] border border-line font-mono uppercase", hit.equivalent && "text-warn border-current")} data-kind>{kind}</span> : null}
            {hit.size ? <span className="font-mono">{sizeText(hit.size)}</span> : null}
            {!can && hit.note ? <span className="text-xs text-ink-2 normal-case whitespace-normal" data-note>{hit.note}</span> : null}
            {can && hit.equivalent ? <span className="text-xs text-ink-2 whitespace-normal" data-note>Not {hit.supplier}'s own model.</span> : null}
          </span>
        )}
      </span>
    </div>
  );
}

export function SupplierSearch({ assembly }: { assembly: AssemblyEditor }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [found, setFound] = useState<ModelSearch | null>(null);
  const [error, setError] = useState("");
  const [placing, setPlacing] = useState<{ key: string; say: string } | null>(null);
  const [failed, setFailed] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; input.current?.focus(); return () => { alive.current = false; }; }, []);

  // search as the person types, a moment after they stop; a search typed past is dropped
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setState("idle"); setFound(null); setError(""); return; }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      setState("searching");
      searchModels(q, ctl.signal).then(
        (r) => { if (!ctl.signal.aborted) { setFound(r); setState("done"); setError(""); } },
        (e) => { if (!ctl.signal.aborted) { setError((e as Error).message || "The search failed."); setState("error"); } },
      );
    }, 250);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [query]);

  const key = (h: ModelHit) => `${h.provider}:${h.id}`;
  const pick = (hit: ModelHit) => {
    if (placing) return;
    setFailed(""); setPlacing({ key: key(hit), say: "" });
    placeModel(assembly, hit, (say) => { if (alive.current) setPlacing({ key: key(hit), say }); }).then(
      () => { if (alive.current) setPlacing(null); assembly.host.toast(`Placed ${hit.title}${hit.equivalent ? " (a generated equivalent)" : ""}.`, 3000); },
      (e) => { if (alive.current) { setPlacing(null); setFailed(`${hit.title}: ${(e as Error).message || "it could not be placed."}`); } else assembly.host.toast(`${hit.title}: ${(e as Error).message || "it could not be placed."}`, 6000); },
    );
  };
  const off = (found?.providers || []).filter((p) => !p.configured);
  const results = found?.results || [];
  return (
    <div className="flex flex-col min-h-[160px] flex-1 overflow-hidden bg-paper" data-supplier-search data-state={state}>
      <div className="flex-none p-2 border-b border-line">
        <input ref={input} className="input w-full" type="search" value={query} placeholder="Part number or size: 91251A431, M5x20 socket head…" aria-label="Search suppliers" data-supplier-query spellCheck={false} autoComplete="off"
          onChange={(ev) => setQuery(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter") ev.preventDefault(); if (ev.key === "Escape" && query) { ev.stopPropagation(); setQuery(""); } }} />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto" role="listbox" aria-label="Models">
        {state === "idle" ? (
          <div className="p-2 flex flex-col gap-1.5">
            <p className="note m-0">Type a supplier's part number, or a standard size. Click a result to place it.</p>
            <div className="flex flex-wrap gap-1">
              {EXAMPLES.map((e) => <button key={e} type="button" className="btn sm ghost h-5.5 px-1.5 border border-line font-mono text-xs" data-example onClick={() => { setQuery(e); input.current?.focus(); }}>{e}</button>)}
            </div>
          </div>
        ) : null}
        {state === "searching" && !results.length ? <p className="note m-0 p-2 flex items-center gap-1.5"><span className="spinner" />Searching…</p> : null}
        {state === "error" ? <p className="callout err m-2">{error}</p> : null}
        {failed ? <p className="callout err m-2" data-place-error>{failed}</p> : null}
        {results.map((h) => <Row key={key(h)} hit={h} busy={placing?.key === key(h)} say={placing?.key === key(h) ? placing.say : ""} pick={() => pick(h)} refine={(q) => { setQuery(q); input.current?.focus(); }} />)}
        {state === "done" && !results.length ? <p className="note m-0 p-2" data-empty>Nothing matches “{found?.query}”. Try a part number, or a size such as “M5x20 socket head”.</p> : null}
        {state !== "idle" ? (found?.errors || []).map((e) => <p key={e.provider} className="note m-0 px-2 py-1 border-t border-line" data-provider-error={e.provider}>{e.name}: {e.message}</p>) : null}
      </div>
      {off.length && state !== "idle" ? (
        <p className="flex-none m-0 px-2 py-1 border-t border-line text-xs text-ink-3" data-not-configured title={off.map((p) => `${p.name}: set ${p.needs.join(", ")} on the server${p.signup ? ` (${p.signup})` : ""}`).join("\n")}>
          Not connected on this server: {off.map((p) => p.name).join(", ")}
        </p>
      ) : null}
    </div>
  );
}
