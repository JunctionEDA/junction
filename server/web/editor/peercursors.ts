// The other people's pointers, on a layer of their own.
//
// A presence message used to rebuild the whole peer overlay (selection outlines, ghosts, the pointer, its name tag
// with a text measurement) and re-render the people list; a pointer only moved when a message came.  Here each
// person's pointer is one persistent element that is moved by a transform on every display frame, and is rebuilt only
// when its name, colour or note change.  Between messages it is carried on along the way it was going (for at most
// about one message interval, then eased back to where it was last seen), so it moves at the display rate without
// being held back to wait for the next sample: smoothing that waits for a sample adds exactly the lag this is meant
// to take out.
import { NS } from "./dom";
import { E } from "./state";
import { toast } from "./util";

// A peer's pointer and name tag, in screen pixels (the desktop's COLLAB_CURSOR_ITEM uses the same sizes).
const PEER_CURSOR_PX = 24, PEER_TAG_TEXT_PX = 16, PEER_TAG_PAD_PX = 5;
/** The longest a pointer is carried on past its last sample, ms. */
const CARRY_MAX_MS = 60;
/** How quickly the drawn pointer closes on where it should be (time constant, ms): about half a frame. */
const EASE_MS = 7;

interface Cursor {
  g: SVGGElement;
  key: string;
  /** last sample (mm), when it came (performance.now()), the velocity it implies (mm/ms) */
  x: number; y: number; t: number; vx: number; vy: number;
  /** the usual time between samples, ms */
  every: number;
  /** what is drawn (mm) */
  dx: number; dy: number;
  /** the scale the element was last transformed with */
  s: number;
}

const cursors = new Map<string, Cursor>();
let layer: SVGGElement | null = null;
let raf = 0, lastFrame = 0;
let scaleOf: () => number = () => 4;
let onFollow: (cid: string, name: string) => void = () => {};

/** Brightness 0..1 of a #rgb / #rrggbb colour, as COLOR4D::GetBrightness (its weighted W3C formula). */
export function brightness(c: string): number {
  const h = c.replace("#", ""), f = h.length === 3 ? h.split("").map((d) => d + d).join("") : h.slice(0, 6);
  const n = parseInt(f, 16); if (!Number.isFinite(n)) return 0;
  return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.117) / 255;
}

/** Where the layer lives (right above the peer overlay) and how to read the current screen pixels per mm. */
export function initPeerCursors(peersG: SVGGElement, pxPerMm: () => number, follow: (cid: string, name: string) => void) {
  scaleOf = pxPerMm; onFollow = follow;
  if (layer && layer.isConnected) return;
  layer = document.createElementNS(NS, "g") as SVGGElement;
  layer.id = "peerCursorG";
  layer.style.pointerEvents = "none";
  peersG.after(layer);
}

export function clearPeerCursors() {
  for (const c of cursors.values()) c.g.remove();
  cursors.clear();
}

export interface PeerCursorSpec { cid: string; name: string; color: string; note: string; following: boolean; at: number[] }

/** The pointers there should be now (mm), from the presence map. */
export function syncPeerCursors(specs: PeerCursorSpec[]) {
  if (!layer) return;
  const now = performance.now(), keep = new Set<string>();
  for (const sp of specs) {
    keep.add(sp.cid);
    const key = `${sp.name}\u0000${sp.color}\u0000${sp.note}\u0000${sp.following ? 1 : 0}`;
    let c = cursors.get(sp.cid);
    if (!c) {
      const g = document.createElementNS(NS, "g") as SVGGElement;
      g.setAttribute("class", "peer-cursor");
      layer.appendChild(g);
      c = { g, key: "", x: sp.at[0], y: sp.at[1], t: now, vx: 0, vy: 0, every: 16, dx: sp.at[0], dy: sp.at[1], s: 0 };
      cursors.set(sp.cid, c);
    } else {
      sample(c, sp.at[0], sp.at[1], now);
    }
    if (c.key !== key) { c.key = key; build(c, sp); }
  }
  for (const [cid, c] of cursors) if (!keep.has(cid)) { c.g.remove(); cursors.delete(cid); }
  place(true);
  wake();
}

/** One cursor's new sample, straight from a presence message (mm). */
function sample(c: Cursor, x: number, y: number, now: number) {
  if (x === c.x && y === c.y) return;
  const dt = now - c.t;
  // a sample after a long gap is a fresh start, not a speed
  if (dt > 4 && dt < 150) {
    c.vx = (x - c.x) / dt; c.vy = (y - c.y) / dt;
    c.every = c.every * 0.8 + Math.min(dt, 100) * 0.2;
  } else { c.vx = 0; c.vy = 0; }
  // A jump (a peer who zoomed out and back, or was off the page) is shown at once.
  const jump = Math.hypot(x - c.dx, y - c.dy) * scaleOf() > 400;
  c.x = x; c.y = y; c.t = now;
  if (jump) { c.dx = x; c.dy = y; c.vx = 0; c.vy = 0; }
}

/** Where a cursor should be drawn at `now`: carried on along its last velocity until about the next sample is due,
 *  then eased back to the last sample by the same amount of time, so a pointer that stopped ends exactly there. */
function target(c: Cursor, now: number): [number, number] {
  const age = now - c.t, carry = Math.min(CARRY_MAX_MS, c.every * 1.2);
  const k = age <= carry ? age : Math.max(0, 2 * carry - age);
  return [c.x + c.vx * k, c.y + c.vy * k];
}

function place(force: boolean) {
  const now = performance.now(), dt = lastFrame ? Math.min(50, now - lastFrame) : 16; lastFrame = now;
  const s = scaleOf(), a = 1 - Math.exp(-dt / EASE_MS);
  let moving = false;
  for (const c of cursors.values()) {
    const [tx, ty] = target(c, now);
    const ex = tx - c.dx, ey = ty - c.dy;
    if (Math.abs(ex) * s < 0.05 && Math.abs(ey) * s < 0.05) { c.dx = tx; c.dy = ty; }
    else { c.dx += ex * a; c.dy += ey * a; moving = true; }
    if (now - c.t < 2 * Math.min(CARRY_MAX_MS, c.every * 1.2) && (c.vx || c.vy)) moving = true;
    const tf = `translate(${c.dx.toFixed(4)} ${c.dy.toFixed(4)}) scale(${(1 / s).toFixed(6)})`;
    if (force || moving || c.s !== s) { c.g.setAttribute("transform", tf); c.s = s; }
  }
  return moving;
}

function wake() {
  if (raf) return;
  const frame = () => {
    raf = 0;
    if (place(false)) raf = requestAnimationFrame(frame);
    else lastFrame = 0;
  };
  raf = requestAnimationFrame(frame);
}

/** COLLAB_CURSOR_ITEM's pointer and name tag, drawn in screen pixels about the pointer's tip at (0, 0): a triangle in
 *  the peer colour, and below-right of it a chip filled with that colour, the name in black or white on it. */
function build(c: Cursor, sp: PeerCursorSpec) {
  const g = c.g; g.replaceChildren();
  const t = PEER_CURSOR_PX, th = PEER_TAG_TEXT_PX, pad = PEER_TAG_PAD_PX, color = sp.color;
  const tri = document.createElementNS(NS, "path");
  tri.setAttribute("d", `M 0 0 L ${0.38 * t} ${t} L ${t} ${0.38 * t} Z`);
  tri.setAttribute("fill", color); tri.setAttribute("stroke", "white"); tri.setAttribute("stroke-opacity", "0.9"); tri.setAttribute("stroke-width", "1.5");
  tri.setAttribute("stroke-linejoin", "round");
  g.appendChild(tri);
  const tag = document.createElementNS(NS, "g");
  tag.style.pointerEvents = "auto"; tag.style.cursor = "pointer";
  const cx = 0.8 * t, cy = 1.2 * t;
  const chip = document.createElementNS(NS, "rect");
  chip.setAttribute("x", String(cx)); chip.setAttribute("y", String(cy)); chip.setAttribute("height", String(th + 2 * pad)); chip.setAttribute("rx", "2");
  chip.setAttribute("fill", color);
  const label = document.createElementNS(NS, "text");
  label.setAttribute("x", String(cx + pad)); label.setAttribute("y", String(cy + pad + th / 2)); label.setAttribute("dominant-baseline", "central");
  label.setAttribute("font-size", String(th)); label.setAttribute("font-weight", "600"); label.setAttribute("font-family", "system-ui, sans-serif");
  label.setAttribute("fill", brightness(color) > 0.5 ? "#000" : "#fff");
  label.textContent = sp.following ? sp.name + " (following)" : sp.name;
  tag.appendChild(chip); tag.appendChild(label); g.appendChild(tag);
  let tw = 0; try { tw = label.getComputedTextLength(); } catch { /* not laid out */ }
  if (!(tw > 0)) tw = label.textContent.length * 0.6 * th;
  chip.setAttribute("width", String(tw + 2 * pad));
  // what the assistant says about what it is pointing at: a second chip under its name, wrapped to a few lines
  if (sp.note) {
    const lines: string[] = []; let cur = "";
    for (const w of sp.note.split(/\s+/)) { if (cur && (cur + " " + w).length > 38) { lines.push(cur); cur = w; } else cur = cur ? cur + " " + w : w; }
    if (cur) lines.push(cur);
    const lh = th * 1.3, ny = cy + th + 2 * pad + 3, nh = lines.length * lh + 2 * pad;
    const box = document.createElementNS(NS, "rect"), txt = document.createElementNS(NS, "text");
    box.setAttribute("x", String(cx)); box.setAttribute("y", String(ny)); box.setAttribute("height", String(nh)); box.setAttribute("rx", "2");
    box.setAttribute("fill", "#16161a"); box.setAttribute("fill-opacity", "0.94"); box.setAttribute("stroke", color); box.setAttribute("stroke-width", "1");
    txt.setAttribute("font-size", String(th)); txt.setAttribute("font-family", "system-ui, sans-serif"); txt.setAttribute("fill", "#f2f2f4");
    lines.forEach((ln, i) => { const ts = document.createElementNS(NS, "tspan"); ts.setAttribute("x", String(cx + pad)); ts.setAttribute("y", String(ny + pad + lh * i + lh / 2)); ts.setAttribute("dominant-baseline", "central"); ts.textContent = ln; txt.appendChild(ts); });
    const note = document.createElementNS(NS, "g"); note.setAttribute("class", "ai-note"); note.appendChild(box); note.appendChild(txt); g.appendChild(note);
    let nw = 0; try { nw = txt.getBBox().width; } catch { /* not laid out */ }
    if (!(nw > 0)) nw = Math.max(...lines.map((l) => l.length)) * 0.55 * th;
    box.setAttribute("width", String(nw + 2 * pad));
  }
  tag.addEventListener("click", (ev) => { ev.stopPropagation(); onFollow(sp.cid, sp.name); });
}

/** Whether only the pointer or the view of a peer changed between two presence states (then nothing but the
 *  pointer layer needs to move). */
export function onlyPointerMoved(a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined): boolean {
  if (!a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (k === "cursor" || k === "viewport") continue;
    if (!(k in b)) return false;
    const x = a[k], y = b[k];
    if (x === y) continue;
    if (typeof x !== "object" || typeof y !== "object" || JSON.stringify(x) !== JSON.stringify(y)) return false;
  }
  return true;
}

export function toggleFollowToast(cid: string, name: string, render: () => void) {
  E.followPeer = E.followPeer === cid ? null : cid;
  toast(E.followPeer ? `Following ${name}` : "Stopped following");
  render();
}
