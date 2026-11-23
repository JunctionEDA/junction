// prelude.js — the inside of the sandbox: what a custom feature's script sees (assets/feature-api.d.ts), built on
// the one function the host hands in.  This file runs in the QuickJS interpreter before the script, never in
// the browser's own engine.  Everything crosses to the host as JSON through `__host(op, argsJson)`; bodies,
// faces and edges cross as small tagged objects ({ $b }, { $f }, { $e }) and are only ever names: the script
// holds no kernel object.
(function () {
  "use strict";
  const host = globalThis.__host;
  delete globalThis.__host;

  // --- determinism: no clock, and random numbers that repeat
  let seed = 0x2f6e2b1;
  Math.random = function () { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  let epoch = 0;
  function revive(_k, v) {
    if (v && typeof v === "object") {
      if (typeof v.$b === "string") return new Body(v.$b);
      if (Array.isArray(v.$f)) return new Face(v.$f[0], v.$f[1]);
      if (Array.isArray(v.$e)) return new Edge(v.$e[0], v.$e[1]);
    }
    return v;
  }
  function call(op) {
    const args = Array.prototype.slice.call(arguments, 1);
    let text;
    try { text = JSON.stringify(args); } catch (e) { throw apiError(op + ": the arguments could not be passed (" + e.message + ")"); }
    const out = JSON.parse(host(op, text), revive);
    if (out.e !== undefined) throw out.f ? failure(out.e) : apiError(out.e);
    if (out.m) epoch++;
    return out.v;
  }
  function apiError(message) { const e = new Error(message); e.name = "ApiError"; return e; }
  function failure(message) { const e = new Error(String(message)); e.name = "FeatureFailure"; return e; }

  // a getter that asks the host once per state of the model
  function info(obj, op) {
    if (obj._at !== epoch) { obj._info = call(op, obj); obj._at = epoch; }
    return obj._info;
  }
  function getters(cls, op, keys) {
    for (const k of keys) Object.defineProperty(cls.prototype, k, { get: function () { return info(this, op)[k]; }, enumerable: true });
  }

  class Body {
    constructor(id) { this.id = id; hide(this); }
    toJSON() { return { $b: this.id }; }
    mass(density) { return call("body.mass", this, density); }
    faces(filter) { return call("body.faces", this, filter || null); }
    face(filter) { return call("body.faces", this, filter || null)[0] || null; }
    edges(filter) { return call("body.edges", this, filter || null); }
    holes(filter) { return call("body.holes", this, filter || null); }
    fillet(edges, radius) { return call("body.fillet", this, edges, radius); }
    chamfer(edges, distance) { return call("body.chamfer", this, edges, distance); }
    shell(thickness, open) { return call("body.shell", this, thickness, open || []); }
    copy() { return call("body.copy", this); }
    translate(by) { return call("body.move", this, { translate: by }); }
    rotate(origin, axis, angle) { return call("body.move", this, { origin: origin, axis: axis, angle: angle }); }
    mirror(plane) { return call("body.move", this, { mirror: plane }); }
    remove() { call("body.remove", this); }
  }
  getters(Body, "body.info", ["name", "volume", "area", "centre", "bounds"]);

  class Face {
    constructor(body, id) { this.id = id; this._b = body; hide(this); }
    toJSON() { return { $f: [this._b, this.id] }; }
    get body() { return new Body(this._b); }
    outline() { return call("face.outline", this); }
    holes() { return call("face.holes", this); }
    edges() { return call("face.edges", this); }
    neighbours() { return call("face.neighbours", this); }
    toWorld(p, height) { return call("face.toWorld", this, p, height || 0); }
    toLocal(p) { return call("face.toLocal", this, p); }
    cut(shape, opts) { return call("face.cut", this, shape, opts || {}); }
    add(shape, opts) { return call("face.add", this, shape, opts || {}); }
    hole(at, opts) {
      const o = opts || {}, pts = Array.isArray(at) && Array.isArray(at[0]) ? at : [at];
      if (!(o.diameter > 0)) throw apiError("face.hole needs a diameter above zero.");
      return call("face.cut", this, pts.map(function (p) { return Geo2.circle(p, o.diameter / 2); }), o.depth > 0 && !o.through ? { depth: o.depth } : { through: true });
    }
    label(label) { call("face.label", this, label); }
  }
  getters(Face, "face.info", ["kind", "area", "centre", "normal", "plane", "radius", "axis"]);

  class Edge {
    constructor(body, id) { this.id = id; this._b = body; hide(this); }
    toJSON() { return { $e: [this._b, this.id] }; }
    get body() { return new Body(this._b); }
    faces() { return call("edge.faces", this); }
  }
  getters(Edge, "edge.info", ["kind", "length", "mid", "start", "end", "direction", "centre", "radius"]);

  function hide(o) {
    Object.defineProperty(o, "_at", { value: -1, writable: true, enumerable: false });
    Object.defineProperty(o, "_info", { value: null, writable: true, enumerable: false });
    if ("_b" in o) Object.defineProperty(o, "_b", { enumerable: false });
  }

  function show(v) {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.name + ": " + v.message;
    if (v instanceof Body) return "Body(" + v.id + ")";
    if (v instanceof Face) return "Face(" + v.id + ")";
    if (v instanceof Edge) return "Edge(" + v.id + ")";
    if (typeof v === "function") return "[function]";
    if (typeof v === "number") return String(Math.round(v * 1e6) / 1e6);
    try { const s = JSON.stringify(v, function (_k, x) { return typeof x === "number" ? Math.round(x * 1e4) / 1e4 : x; }); return s === undefined ? String(v) : s.length > 2000 ? s.slice(0, 2000) + "…" : s; } catch (e) { return String(v); }
  }
  function log() { call("log", Array.prototype.map.call(arguments, show).join(" ")); }
  globalThis.console = Object.freeze({ log: log, info: log, debug: log, warn: log, error: log });

  const g = {};
  for (const name of ["rect", "circle", "ngon", "slot", "thicken", "text", "union", "difference", "intersection", "offset", "round", "translate", "rotate", "scale", "mirror", "area", "bounds", "centroid", "contains", "distance", "clearance", "cells", "grid", "outlinePoints", "delaunay", "voronoi", "triangulate"]) {
    g[name] = function () { return call.apply(null, ["g." + name].concat(Array.prototype.slice.call(arguments))); };
  }
  // the simplest shapes need no trip to the host
  g.rect = function (x, y, w, h) { return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]; };
  g.circle = function (c, r) { if (!(r > 0)) throw apiError("Geo2.circle needs a radius above zero."); return [[c[0] + r, c[1], 1], [c[0] - r, c[1], 1]]; };
  globalThis.Geo2 = Object.freeze(g);

  globalThis.V3 = Object.freeze({
    add: function (a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; },
    sub: function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; },
    scale: function (a, s) { return [a[0] * s, a[1] * s, a[2] * s]; },
    dot: function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
    cross: function (a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; },
    length: function (a) { return Math.hypot(a[0], a[1], a[2]); },
    normalize: function (a) { const l = Math.hypot(a[0], a[1], a[2]); if (!l) throw apiError("V3.normalize: the vector has no length."); return [a[0] / l, a[1] / l, a[2] / l]; },
    distance: function (a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); },
  });

  function context(feature) {
    return Object.freeze({
      feature: Object.freeze(feature),
      bodies: function () { return call("bodies"); },
      body: function () { const all = call("bodies"); if (!all.length) throw failure("There is no part to work on yet. Make one first (a sketch and an extrude)."); return all[0]; },
      plane: function (name) { return call("plane", name); },
      planeAt: function (origin, normal, x) { return call("planeAt", origin, normal, x || null); },
      extrude: function (shape, on, opts) { return call("extrude", shape, on, opts || {}); },
      union: function (target) { return call("boolean", "fuse", target, Array.prototype.slice.call(arguments, 1)); },
      subtract: function (target) { return call("boolean", "cut", target, Array.prototype.slice.call(arguments, 1)); },
      intersect: function (target, tool) { return call("boolean", "common", target, [tool]); },
      linearPattern: function (body, direction, count, spacing) { return call("pattern", body, { direction: direction, count: count, spacing: spacing }); },
      circularPattern: function (body, origin, axis, count, angle) { return call("pattern", body, { origin: origin, axis: axis, count: count, angle: angle === undefined ? 360 : angle }); },
      fail: function (message) { return failure(message); },
      warn: function (message) { call("warn", String(message)); },
      report: function (label, value) { call("report", String(label), typeof value === "number" ? String(Math.round(value * 1e4) / 1e4) : String(value)); },
      log: log,
      handle: function (param, origin, direction) { call("handle", String(param), origin, direction); },
    });
  }

  let def = null, calls = 0;
  globalThis.feature = function (d) {
    calls++;
    if (calls > 1) throw apiError("feature(...) was called more than once. A script declares one feature.");
    if (!d || typeof d !== "object") throw apiError("feature(...) needs an object: { title, params, evaluate }.");
    if (typeof d.evaluate !== "function") throw apiError("feature(...) needs an evaluate(ctx, p) function.");
    def = d;
  };

  // what the host calls, kept off the global object once it has read them
  const hooks = {
    describe: function () {
      if (!def) throw apiError("The script never called feature({ title, params, evaluate }).");
      const params = [];
      const src = def.params === undefined ? {} : def.params;
      if (!src || typeof src !== "object" || Array.isArray(src)) throw apiError("params must be an object: { depth: { type: \"length\", label: \"Depth\", default: 3 } }.");
      for (const key of Object.keys(src)) { const p = src[key]; params.push(p && typeof p === "object" ? Object.assign({}, p, { key: key }) : { key: key, type: String(p) }); }
      return JSON.stringify({ title: def.title, description: def.description, icon: def.icon, params: params });
    },
    run: function (featureJson, valuesJson) {
      const values = JSON.parse(valuesJson, revive);
      const out = def.evaluate(context(JSON.parse(featureJson)), values);
      if (out && typeof out.then === "function") throw apiError("evaluate must not be async: nothing in the Feature API waits.");
    },
  };
  globalThis.__hooks = hooks;
})();
