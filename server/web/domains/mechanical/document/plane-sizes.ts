// plane-sizes.ts — the size of the default planes, as a person set it by dragging a plane's corner.  Pure: reads
// the document and returns item changes, like units.ts.
//
//   { id: "studio", type: "studio", …, planeSizes: { top: 120, right: 80 } }
//
// Each number is the side of that plane's square in millimetres; the square stays centred on the origin.  A plane
// with no size grows with the model (viewport/planes.ts).  Each plane is its own path of the studio item, so two
// people resizing two planes at once both win, and a resize is undone like any other edit.  static/tests/cad-plane-sizes.test.js.
import type { ItemChange, ItemDoc } from "../../../shared/itemdoc/itemdoc";
import type { DefaultPlaneId } from "../core/geometry";
import { STUDIO_ITEM_ID } from "./format";

export const PLANE_IDS: readonly DefaultPlaneId[] = ["top", "front", "right"];
/** Sides outside this range (mm) are not taken from the document. */
export const MIN_PLANE_SIZE = 2, MAX_PLANE_SIZE = 1e6;

/** The sides of the default planes the document sets (mm), by plane; a plane it does not set is left out. */
export function planeSizesOf(doc: ItemDoc | null | undefined): Partial<Record<DefaultPlaneId, number>> {
  const s = doc ? (doc.items.get(STUDIO_ITEM_ID) as { planeSizes?: unknown } | undefined) : undefined;
  const out: Partial<Record<DefaultPlaneId, number>> = {};
  const raw = s && s.planeSizes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const id of PLANE_IDS) {
    const v = (raw as Record<string, unknown>)[id];
    if (typeof v === "number" && Number.isFinite(v) && v >= MIN_PLANE_SIZE && v <= MAX_PLANE_SIZE) out[id] = v;
  }
  return out;
}

/** A side as it is stored: to a hundredth of a millimetre, within the range. */
export const cleanPlaneSize = (mm: number): number => Math.round(Math.max(MIN_PLANE_SIZE, Math.min(MAX_PLANE_SIZE, mm)) * 100) / 100;

/** Changes that set a default plane's side (mm), or with null let it grow with the model again. */
export function setPlaneSize(doc: ItemDoc, id: DefaultPlaneId, size: number | null): ItemChange[] {
  if (!PLANE_IDS.includes(id)) return [];
  const now = planeSizesOf(doc)[id];
  if (size === null) {
    if (now === undefined) return [];
    return [{ id: STUDIO_ITEM_ID, kind: "MODIFIED", typeName: "studio", props: [{ path: ["planeSizes", id], del: true }] }];
  }
  if (!Number.isFinite(size)) return [];
  const value = cleanPlaneSize(size);
  if (now === value) return [];
  if (!doc.items.get(STUDIO_ITEM_ID)) {
    return [{ id: STUDIO_ITEM_ID, kind: "ADDED", typeName: "studio", item: { id: STUDIO_ITEM_ID, type: "studio", units: "mm", rollback: null, planeSizes: { [id]: value } } }];
  }
  return [{ id: STUDIO_ITEM_ID, kind: "MODIFIED", typeName: "studio", props: [{ path: ["planeSizes", id], value }] }];
}
