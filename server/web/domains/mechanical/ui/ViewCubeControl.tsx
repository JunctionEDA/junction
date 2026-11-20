// ViewCubeControl.tsx — the view cube in the top right corner of the viewport, laid out as Onshape's: it turns with the
// model, says which way is up, and is the quickest way to a standard view.
//
//   a face, an edge or a corner        look at the model from there (animated); the region under the pointer lights up
//   the four triangles around it       turn the view 90° about the screen's horizontal or vertical axis
//   the two curved arrows above it     roll the view 90° about the line of sight (left: counter-clockwise)
//   the cube with ▼ below it           the view menu: the standard views, zoom, projection, display mode,
//                                      section view, planes, named views
//
// The cube is page elements turned with CSS 3D (not part of the WebGL scene), so the browser hit-tests it and
// every region is a button: 6 faces, 12 bevelled edges and 8 corner facets, each `data-from` the direction it
// looks from (a face also `data-view`: top, front, …, and `data-face`).  The shading follows the camera, every
// frame, from the region's normal; an edge's strip is shaded from one face's tone to the other's, so the bevel
// reads as rounded.  The axis triad (X red, Y green, Z blue) is drawn over the cube from its back bottom left
// corner, as Onshape draws it.  Front is −Y, Right +X, Top +Z: the part studio's frame (core/geometry.ts).
//
// This is the cube on any Viewport3D, with the standard views, zoom to fit and the projection in its menu (an
// assembly mounts it through api.ts); ViewCube.tsx is the part studio's, whose menu has the rest.
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { cx } from "../../../shared/util";
import { tokenColor, type Viewport3D } from "../../../shared/viewport3d/viewport3d";
import { Glyph } from "./Glyph";
import { tipHandlers } from "./Tip";

/** The whole control, the cube's edge, how deep its bevels are (CSS pixels), and where its middle is in the control. */
const BOX = 184, SIZE = 82, BEVEL = 10, MID: [number, number] = [BOX / 2, BOX / 2 + 4];
const H = SIZE / 2, F = H - BEVEL;
/** How far the triad's arrows reach past the cube. */
const REACH = 6;

type V = [number, number, number];
const add = (a: V, b: V, k = 1): V => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V): V => mul(a, 1 / Math.hypot(a[0], a[1], a[2]));

/** The faces: which way each looks (its outward normal), and the model directions of its text's right and down. */
const FACES: { view: string; label: string; n: V; right: V; down: V }[] = [
  { view: "top", label: "Top", n: [0, 0, 1], right: [1, 0, 0], down: [0, -1, 0] },
  { view: "bottom", label: "Bottom", n: [0, 0, -1], right: [1, 0, 0], down: [0, 1, 0] },
  { view: "front", label: "Front", n: [0, -1, 0], right: [1, 0, 0], down: [0, 0, -1] },
  { view: "back", label: "Back", n: [0, 1, 0], right: [-1, 0, 0], down: [0, 0, -1] },
  { view: "right", label: "Right", n: [1, 0, 0], right: [0, 1, 0], down: [0, 0, -1] },
  { view: "left", label: "Left", n: [-1, 0, 0], right: [0, -1, 0], down: [0, 0, -1] },
];
const AXES: V[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** One clickable piece of the cube: a polygon in model directions (pixels), its normal, and the view it gives. */
interface Region {
  key: string; kind: "face" | "edge" | "corner"; from: V; n: V; right: V; poly: V[];
  /** an edge's two faces, for the shading across its strip */
  faces?: [V, V];
  face?: (typeof FACES)[number];
}

function regions(): Region[] {
  const out: Region[] = [];
  for (const f of FACES) {
    const c = mul(f.n, H);
    const poly: V[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, w]) => add(add(c, f.right, u * F), f.down, w * F));
    out.push({ key: f.view, kind: "face", from: f.n, n: f.n, right: f.right, poly, face: f });
  }
  // an edge between two faces: a strip along the axis they share, bevelled at 45°
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) for (const si of [1, -1]) for (const sj of [1, -1]) {
    const a = mul(AXES[i], si), b = mul(AXES[j], sj), e = AXES[3 - i - j];
    const poly: V[] = [add(add(mul(a, H), b, F), e, -F), add(add(mul(a, H), b, F), e, F), add(add(mul(a, F), b, H), e, F), add(add(mul(a, F), b, H), e, -F)];
    out.push({ key: `e${add(a, b).join(",")}`, kind: "edge", from: add(a, b), n: unit(add(a, b)), right: e, poly, faces: [a, b] });
  }
  // a corner: the triangle where three bevels meet
  for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
    const s: V = [sx, sy, sz];
    const poly: V[] = [0, 1, 2].map((k) => s.map((v, m) => v * (m === k ? H : F)) as V);
    out.push({ key: `c${s.join(",")}`, kind: "corner", from: s, n: unit(s), right: unit(add(poly[1], poly[0], -1)), poly });
  }
  return out;
}
const REGIONS = regions();

/**
 * The CSS that puts a flat polygon of the cube in place: the element's box, its matrix (its right, its down —
 * right × normal, which the page's flipped y turns into the outward side — the normal, and its top left corner),
 * and the clip to the polygon.
 */
function layout(r: Region): { width: number; height: number; transform: string; clip: string; down: V } {
  const down = crossV(r.right, r.n);
  const uw = r.poly.map((p) => [dot(p, r.right), dot(p, down)]);
  const u0 = Math.min(...uw.map((p) => p[0])), u1 = Math.max(...uw.map((p) => p[0])), w0 = Math.min(...uw.map((p) => p[1])), w1 = Math.max(...uw.map((p) => p[1]));
  const n = r.n, tl = add(add(mul(n, dot(r.poly[0], n)), r.right, u0), down, w0);
  const transform = `matrix3d(${r.right.join(",")},0,${down.join(",")},0,${n.join(",")},0,${tl.join(",")},1)`;
  const clip = `polygon(${uw.map(([u, w]) => `${(u - u0).toFixed(2)}px ${(w - w0).toFixed(2)}px`).join(",")})`;
  return { width: u1 - u0, height: w1 - w0, transform, clip, down };
}

/** Look at the model from the direction `from` (a face's normal, or the sum of two or three for an edge or corner). */
function lookFrom(viewport: Viewport3D, from: V): void {
  const dir = new THREE.Vector3(...from).negate();
  const flat = Math.abs(from[0]) < 1e-9 && Math.abs(from[1]) < 1e-9;
  viewport.lookAlong(dir, flat ? new THREE.Vector3(0, from[2] > 0 ? 1 : -1, 0) : new THREE.Vector3(0, 0, 1));
  viewport.canvas.focus();
}

/**
 * The cube's colours, from the theme: its surface is a raised panel a little greyed (a grey-white cube on a light
 * page, a slate one on a dark page), the names are ink, the region under the pointer takes the viewport's
 * pre-selection colour (--mark, the orange the planes and the model light up in).
 */
function palette() {
  const panel = tokenColor("--panel"), ink = tokenColor("--ink"), dark = panel.getHSL({ h: 0, s: 0, l: 0 }).l < 0.5;
  const base = panel.clone().lerp(ink, dark ? 0.32 : 0.035), hover = tokenColor("--mark").lerp(base, 0.4);
  const rgb = (c: THREE.Color) => { const t = { r: 0, g: 0, b: 0 }; c.getRGB(t, THREE.SRGBColorSpace); return [t.r, t.g, t.b].map((v) => Math.round(v * 255)); };
  return { base: rgb(base), hover: rgb(hover), text: "#" + ink.getHexString(THREE.SRGBColorSpace), edgeLine: dark ? "rgba(0,0,0,.4)" : "rgba(0,0,0,.16)" };
}
const LIGHT = new THREE.Vector3(-0.35, 0.6, 0.72).normalize();

const ICON = '<path class="f" d="M12 3.500l7.500 4.200v8.600L12 20.500l-7.500-4.200V7.700z"/><path d="M12 3.500l7.500 4.200v8.600L12 20.500l-7.500-4.200V7.700z"/><path d="M4.500 7.700L12 12l7.500-4.300M12 12v8.500"/>';

/** A row of the view menu: its label, whether it is ticked (null: an action), what it runs; `key` its shortcut, `why` why it cannot run now, `attr` its `data-view-item`. */
export type ViewMenuRow = (label: string, on: boolean | null, run: () => void, o?: { key?: string; why?: string | null; attr?: string }) => ReactNode;
/** What the view menu adds to the standard views, zoom to fit and the projection. */
export interface ViewMenuParts { row: ViewMenuRow; head: (text: string) => ReactNode }

export interface ViewCubeOptions {
  viewport: Viewport3D;
  /** zoom to fit (F) */
  fit: () => void;
  /** the projection as the editor keeps it (default: the viewport's own) */
  perspective?: boolean;
  setPerspective?: (on: boolean) => void;
  /** rows after "Zoom to fit" */
  zoom?: (m: ViewMenuParts) => ReactNode;
  /** sections after the projection */
  more?: (m: ViewMenuParts) => ReactNode;
  /** what the menu button's tooltip lists */
  hint?: string;
}

/** The view cube on a viewport: the cube, the triad, the arrows and the view menu. */
export function ViewCubeControl({ viewport, fit, perspective, setPerspective, zoom, more, hint }: ViewCubeOptions) {
  const cube = useRef<HTMLDivElement>(null);
  const triad = useRef<SVGSVGElement>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const hovered = useRef<string | null>(null);
  const paintRef = useRef<() => void>(() => {});
  const [menu, setMenu] = useState(false);
  const [ownPersp, setOwnPersp] = useState(viewport.projection === "perspective");
  const persp = perspective ?? ownPersp;
  const setPersp = setPerspective ?? ((on: boolean) => { viewport.setProjection(on ? "perspective" : "orthographic"); setOwnPersp(on); });

  // the cube follows the camera: its matrix is the camera's turn, with y flipped for the page (y runs down); each
  // region is shaded for the way it faces now, and the triad is drawn over it
  useEffect(() => {
    let p = palette();
    const readTheme = () => { p = palette(); };
    const inv = new THREE.Quaternion(), nv = new THREE.Vector3();
    const paint = () => {
      const el = cube.current; if (!el) return;
      inv.copy(viewport.camera.quaternion).invert();
      const m = new THREE.Matrix4().makeRotationFromQuaternion(inv).elements;
      // model (x, y, z) → camera (x, y, z) → page (x, −y, z): negate the second row
      el.style.transform = `matrix3d(${m[0]},${-m[1]},${m[2]},0,${m[4]},${-m[5]},${m[6]},0,${m[8]},${-m[9]},${m[10]},0,0,0,0,1)`;
      const tone = (n: V): string => {
        const k = 0.8 + 0.2 * Math.max(0, nv.set(...n).applyQuaternion(inv).dot(LIGHT));
        return `rgb(${p.base.map((c) => Math.round(c * k)).join(",")})`;
      };
      for (const r of REGIONS) {
        const e = els.current.get(r.key); if (!e) continue;
        const over = hovered.current === r.key;
        if (over) e.style.background = `rgb(${p.hover.join(",")})`;
        else if (r.faces) {
          const [a, b] = r.faces, down = crossV(r.right, r.n);
          // the strip runs from one face's tone through its own to the other face's: a rounded edge
          const [top, bottom] = dot(down, add(a, b, -1)) > 0 ? [b, a] : [a, b];
          e.style.background = `linear-gradient(to bottom, ${tone(top)}, ${tone(r.n)}, ${tone(bottom)})`;
        } else e.style.background = tone(r.n);
        e.style.color = p.text;
        if (r.kind === "face") e.style.boxShadow = `inset 0 0 0 0.5px ${p.edgeLine}`;
      }
      // the triad: from the back bottom left corner along +X, +Y and +Z, past the cube
      const svg = triad.current;
      if (svg) {
        const at = (q: V) => { nv.set(...q).applyQuaternion(inv); return [MID[0] + nv.x, MID[1] - nv.y]; };
        const o: V = [-H, H, -H], [ox, oy] = at(o);
        AXES.forEach((ax, i) => {
          const len = SIZE + REACH;
          const [x, y] = at(add(o, ax, len)), [lx, ly] = at(add(o, ax, len + 9));
          const line = svg.querySelector(`[data-axis="${i}"]`) as SVGLineElement | null, text = svg.querySelector(`[data-axis-label="${i}"]`) as SVGTextElement | null;
          if (line) { line.setAttribute("x1", ox.toFixed(1)); line.setAttribute("y1", oy.toFixed(1)); line.setAttribute("x2", x.toFixed(1)); line.setAttribute("y2", y.toFixed(1)); }
          if (text) { text.setAttribute("x", lx.toFixed(1)); text.setAttribute("y", ly.toFixed(1)); }
        });
      }
    };
    paintRef.current = paint;
    const theme = () => { readTheme(); paint(); };
    viewport.onFrame.push(paint);
    viewport.onTheme.push(theme);
    paint();
    return () => {
      for (const list of [viewport.onFrame, viewport.onTheme]) { const i = list.indexOf(list === viewport.onFrame ? paint : theme); if (i >= 0) list.splice(i, 1); }
    };
  }, [viewport]);
  useEffect(() => {
    if (!menu) return;
    const away = () => setMenu(false);
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); setMenu(false); } };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key, true); };
  }, [menu]);

  const hover = (key: string | null) => { hovered.current = key; paintRef.current(); };
  const region = (r: Region) => {
    const l = layout(r), f = r.face;
    const label = f ? `${f.label} view` : r.kind === "edge" ? "View from this edge" : "View from this corner";
    return (
      <button key={r.key} type="button" tabIndex={-1} aria-label={label} data-from={r.from.join(",")} data-region={r.kind}
        data-view={f ? f.view : undefined} data-face={f ? f.view : undefined}
        className={cx("absolute left-0 top-0 appearance-none border-0 m-0 p-0 cursor-pointer [backface-visibility:hidden] [transform-origin:0_0] [font-family:inherit] flex items-center justify-center", f && "text-[18px] font-medium leading-none tracking-[0.01em]")}
        style={{ width: l.width, height: l.height, transform: l.transform, clipPath: r.kind === "face" ? undefined : l.clip }}
        ref={(e) => { if (e) els.current.set(r.key, e); else els.current.delete(r.key); }}
        onPointerEnter={() => hover(r.key)} onPointerLeave={() => { if (hovered.current === r.key) hover(null); }}
        onClick={() => lookFrom(viewport, r.from)}>{f ? f.label : null}</button>
    );
  };
  // what the arrows do is 90° at a time, as in Onshape
  const Q = Math.PI / 2;
  const turn = (yaw: number, pitch: number, roll = 0) => () => { viewport.rotateBy(yaw * Q, pitch * Q, true, roll * Q); viewport.canvas.focus(); };
  const ARROW = "absolute appearance-none border-0 m-0 p-0 bg-transparent cursor-pointer text-ink-3/50 hover:text-ink-2 flex items-center justify-center";
  const tri = (label: string, points: string, style: React.CSSProperties, yaw: number, pitch: number) => (
    <button type="button" tabIndex={-1} className={ARROW} style={{ width: 18, height: 18, ...style }} aria-label={label} data-turn={label} {...tipHandlers({ title: label, hint: "Turns the view 90°. The arrow keys turn it 15°." })} onClick={turn(yaw, pitch)}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><polygon points={points} fill="currentColor" /></svg>
    </button>
  );
  const rollArrow = (label: string, ccw: boolean, style: React.CSSProperties) => (
    <button type="button" tabIndex={-1} className={ARROW} style={{ width: 24, height: 24, ...style }} aria-label={label} data-turn={label} {...tipHandlers({ title: label, hint: "Rolls the view 90° about the line of sight." })} onClick={turn(0, 0, ccw ? 1 : -1)}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" style={{ transform: ccw ? undefined : "scaleX(-1)" }}>
        <path d="M17.500 15.500A7.500 7.500 0 1 0 6 6.300" fill="none" stroke="currentColor" strokeWidth="2.600" strokeLinecap="round" />
        <polygon points="2.500,4 9.500,3.500 6.500,10" fill="currentColor" />
      </svg>
    </button>
  );

  const row: ViewMenuRow = (label, on, run, o = {}) => (
    <button type="button" key={label} role={on === null ? "menuitem" : "menuitemcheckbox"} aria-checked={on === null ? undefined : !!on} aria-disabled={o.why ? true : undefined} data-view-item={o.attr || label}
      className={cx("appearance-none bg-transparent border-0 m-0 text-inherit [font-family:inherit] [font-size:inherit] flex w-full items-center gap-2 px-2.5 h-7 text-left hover:bg-sel-soft", o.why && "opacity-45")}
      onClick={() => { if (o.why) return; setMenu(false); run(); viewport.canvas.focus(); }}>
      <span className="flex-none w-3.5 text-ink-2">{on ? <Glyph svg='<path d="M5 12.5l4.5 4.5L19 7.500"/>' size={13} /> : null}</span>
      <span className="flex-1">{label}</span>{o.key ? <span className="mono text-xs text-ink-3">{o.key}</span> : null}
    </button>
  );
  const head = (text: string): ReactNode => <div key={text} className="px-2.5 pt-1.5 pb-0.5 text-2xs uppercase tracking-wide text-ink-3 mono">{text}</div>;
  const STANDARD = [["iso", "Isometric"], ["front", "Front"], ["back", "Back"], ["left", "Left"], ["right", "Right"], ["top", "Top"], ["bottom", "Bottom"]] as const;
  const shortcut = (v: string) => `Shift+${["front", "back", "left", "right", "top", "bottom", "iso"].indexOf(v) + 1}`;
  const AXIS_COLOR = ["#e0393e", "#22a447", "#2f6fdb"];
  const parts: ViewMenuParts = { row, head };
  return (
    <div className="cad-viewcube v3-views absolute top-1 right-1 z-[2] select-none pointer-events-none [&_button]:pointer-events-auto [&_.cad-view-menu]:pointer-events-auto" style={{ width: BOX, height: BOX }} onPointerDown={(ev) => ev.stopPropagation()} data-projection={persp ? "perspective" : "orthographic"}>
      <div className="absolute" style={{ left: MID[0], top: MID[1], perspective: 1600 }}>
        <div ref={cube} className="[transform-style:preserve-3d]" data-cube>{REGIONS.map(region)}</div>
      </div>
      <svg ref={triad} className="absolute inset-0 pointer-events-none overflow-visible" width={BOX} height={BOX} aria-hidden="true" data-triad>
        {AXES.map((_, i) => <line key={i} data-axis={i} stroke={AXIS_COLOR[i]} strokeWidth="2.200" strokeLinecap="round" />)}
        {AXES.map((_, i) => <text key={i} data-axis-label={i} fill={AXIS_COLOR[i]} fontSize="13" fontWeight="700" textAnchor="middle" dominantBaseline="central" style={{ fontFamily: "inherit" }}>{"XYZ"[i]}</text>)}
      </svg>
      {tri("Turn up", "7,2 13,11 1,11", { left: MID[0] - 9, top: -2 }, 0, -1)}
      {tri("Turn down", "1,3 13,3 7,12", { left: MID[0] - 9, top: BOX - 19 }, 0, 1)}
      {tri("Turn left", "2,7 11,1 11,13", { left: 2, top: MID[1] - 9 }, -1, 0)}
      {tri("Turn right", "3,1 12,7 3,13", { left: BOX - 20, top: MID[1] - 9 }, 1, 0)}
      {rollArrow("Roll left", true, { left: 10, top: 6 })}
      {rollArrow("Roll right", false, { left: BOX - 34, top: 6 })}
      <button type="button" tabIndex={-1} className={cx("absolute appearance-none border-0 m-0 px-0.5 bg-transparent cursor-pointer flex items-center gap-0 rounded-sm text-ink-2 hover:bg-sel-soft hover:text-ink", menu && "bg-sel-soft text-ink")} style={{ right: 2, bottom: 0, height: 22 }}
        aria-label="View options" aria-haspopup="menu" aria-expanded={menu} data-view-menu {...tipHandlers({ title: "View options", hint: hint || "Standard views, zoom to fit, projection." })} onClick={() => setMenu(!menu)}>
        <Glyph svg={ICON} size={18} />
        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><polygon points="1,3 9,3 5,8" fill="currentColor" /></svg>
      </button>
      {menu ? (
        <div className="cad-view-menu absolute right-0 top-full mt-1 z-[50] w-60 max-h-[70vh] overflow-y-auto py-1 rounded-md border border-line bg-panel shadow-panel text-base text-ink" role="menu">
          {head("Views")}
          {STANDARD.map(([v, label]) => row(label, null, () => viewport.setView(v), { key: shortcut(v), attr: "std-" + v }))}
          {head("Zoom")}
          {row("Zoom to fit", null, fit, { key: "F", attr: "fit" })}
          {zoom ? zoom(parts) : null}
          {head("Projection")}
          {row("Orthographic", !persp, () => setPersp(false))}
          {row("Perspective", persp, () => setPersp(true))}
          {more ? more(parts) : null}
        </div>
      ) : null}
    </div>
  );
}

