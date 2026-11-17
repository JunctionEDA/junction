"""The whole board in one call, and a review that costs few tokens.

`board.design(...)` runs a layout in the order a careful designer works (Phil's Lab's board walk-throughs, and the
order of work in server/docs/pcb-design-rules.md): plan from the netlist, stackup, placement by how critical each
part is, ground on every layer that carries it, antenna keep-outs, routing with the critical nets first and the
supplies last, the copper the physics still owes (fences, thermal vias, a via for every ground pad, stitching),
clean-up, silkscreen, and the review.  It only calls what the harness already has, with the defaults a board should
get, and hands back one short result, so a model does not carry the rules or nine results in its context.

`board.brief()` is the review as one line per finding: the rule, the first sentence and the items.
"""
from __future__ import annotations

import math

from .transport import HarnessError

# what a four-layer board's inner layers carry: signal / ground / ground / signal keeps a tight, unbroken reference
# under both routing layers and gives every via a return path one layer away
INNER_GROUND = ("In1.Cu", "In2.Cu")


def _short(row: str, items: int = 6) -> str:
    """A review finding as one line: "level rule: first sentence. [items]"."""
    head, _, rest = row.partition(": ")
    text, _, tail = rest.partition(" [")
    first = text.split(". ")[0].rstrip(".")
    if tail:
        parts = tail.rstrip("]").split("; ")
        tail = " [" + "; ".join(parts[:items]) + (f"; and {len(parts) - items} more" if len(parts) > items else "") + "]"
    return f"{head}: {first}.{tail}"


def _brief(self, level: str | None = "warning", limit: int = 12, rule: str | None = None) -> dict:
    """The review in as few words as it takes: {"errors", "warnings", "notes", "findings": [one line each]}.  The full
    text of one finding, with the call that fixes it, is board.review(rule="vias.slot")."""
    rv = self.review(level=level, rule=rule, limit=limit)
    return {"errors": rv["errors"], "warnings": rv["warnings"], "notes": rv["notes"], "findings": [_short(f) for f in rv["findings"]]}


def _design(self, outline=None, fab: str = "jlcpcb", layers: int | None = None, edge: str = "top", edges: dict | None = None, near: dict | None = None,
            groups: dict | None = None, fixed: dict | None = None, rotations: dict | None = None, swap: dict | None = None, fit: bool | None = None,
            order: list | None = None, widths: dict | None = None, kinds: dict | None = None, time_s: float | None = None, max_vias: int = 2,
            stitch: float | None = 2.0, name: str | bool | None = None, rev: str | None = None, silk: bool = True, place: bool = True, route: bool = True,
            accept: list | None = None, reroute: bool = False, explain: bool = False, fanout: bool = False,
            free_pins: bool = True) -> dict:
    """Lay the whole board out in one call and say how it came out.

    explain=True adds "reasoning": a list of plain lines saying where every part stands and why (its cluster, the
    pin it serves, how far from it), which parts belong to no cluster, the order the nets were routed in and why,
    and every connection that changed layer, wandered or stayed open, with the cause.  Use it when the person wants
    to check the thinking behind a layout; read it for the line that is wrong and fix that step.

    free_pins=True (the default): connections still open at the end because earlier tracks boxed a pin in are freed one
    pin at a time (board.free_pins); a try that does not help is taken back.  It costs about a minute per open pin.

    fanout=True escapes every fine-pitch chip (20 pins or more, 0.65 mm pitch or finer) to a staggered ring of vias
    before routing (board.fanout): for a dense QFN whose pins are left open because neighbouring tracks box them in.

    reroute=True lays only the copper again on a board somebody placed: every track and via comes up, and the parts,
    the outline, the zones, the rules, the stackup and the silkscreen stay exactly as they are (no sync from the
    schematic either; only a board still on KiCad's stock 0.6/0.3 mm via gets the house 0.5/0.2 mm via, which the
    result's notes say).  It is how scripts/board-bench.py scores the router against a hand-routed board.

    outline: (x0, y0, x1, y1), the largest the board may be (fit=True, the default when an outline is given, pulls it in
    round the parts); leave it out to keep the outline the board has.  edges: {ref: "left"|"right"|"top"|"bottom"} for
    the connectors; near, groups, fixed, rotations go to autoplace on top of what the plan works out; swap: {"U1":
    [nets]} lets those nets trade pins on that chip so they leave side by side (board.swap_pins).  order, widths and
    kinds add to the plan's routing order, widths and net kinds.  place=False keeps the placement, route=False stops
    before routing.  A step that cannot run is listed under "skipped" with the reason and the rest still runs.

    Returns {"size_mm", "layers", "placed", "routed": {"routed", "connections", "vias", "length_mm", "left"},
    "added": {ground vias, fences, thermal vias, stitching}, "drc": {"errors", "by_kind"}, "review": {"errors",
    "warnings", "findings": [one line each]}, "notes": [what the plan could not do], "skipped": {step: why}}.
    Fix what "review" and "left" name and call the single step again; do not run design() twice on one board.

    The result is judged before anyone sees it.  "refused" lists what makes the layout unacceptable: a part off the
    board or on another part, a pin-serving part or crystal away from its pin, a via on a crystal or CC net, a matching
    network away from the radio pin, an open connection, a DRC error, a review error.  While it is not empty the script
    fails at its end and every edit is taken back (a dry run reports it instead), so work in a dry run until "refused"
    is gone.  accept=["rf.feed"] waives the named rules, only for a fault the person has agreed to live with."""
    out: dict = {"skipped": {}}
    import time as _time
    t_start = _time.time(); secs: dict = {}

    def step(what, fn):
        t0 = _time.time()
        try:
            return fn()
        except HarnessError as e:
            out["skipped"][what] = str(e).split("\n")[0][:200]
            return None
        finally:
            secs[what] = round(secs.get(what, 0) + _time.time() - t0, 1)

    if reroute:
        place, silk, outline = False, False, None
        step("take up", lambda: self.unroute(keep=()))
        base = step("drc before", lambda: self.check(limit=0))     # what the parts and rules bring with them: not the routing's doing
        before = {k: v for k, v in ((base or {}).get("by_kind") or {}).items() if k != "unconnected_items"}
    else:
        before = {}
        step("sync", self.sync)
    if outline:
        self.outline(*outline, radius=0 if place else 1.0)      # square while the placement may still pull it in; rounded after
    plan = step("plan", lambda: self.plan(edge=edge)) or {"place": {"near": {}, "edges": {}}, "route": {}, "notes": []}
    out["notes"] = [n.split(". ")[0] for n in plan.get("notes", [])][:6]
    rec = dict((plan.get("stackup") or {}).get("recommended") or {})
    if layers:
        rec["layers"] = layers
    want = int(rec.get("layers") or len(self.info().get("copper_layers") or []) or 2)
    if want > len(self.info().get("copper_layers") or []) and not reroute:
        step("layers", lambda: self.layers(want, planes=list(INNER_GROUND) if want >= 4 else None))
    if not reroute:
        step("stackup", lambda: self.stackup(fab=fab, **rec))
    if place:
        # a board laid out before is laid out again from its parts: its old copper comes up first, so a second run of
        # the script needs no board.clear() (what comes out the same is left alone when the plan is drawn)
        def take_up():
            n = self.unroute(keep=())
            for z in self._call("get_items", kinds=["zone"]).get("items", []):      # the pours and keep-outs are drawn again for the new placement
                self._edit({"op": "remove", "id": z["id"]}); n += 1
            self.flush()
            return n
        step("take up", take_up)
        kw = {"groups": groups, "near": {**plan["place"].get("near", {}), **(near or {})}, "edges": {**plan["place"].get("edges", {}), **(edges or {})},
              "fixed": fixed, "rotations": rotations, "fit": bool(outline) if fit is None else fit}
        if outline:
            kw["outline"] = tuple(outline)
        placed = step("place", lambda: self.autoplace(**kw))
        if placed:
            sc = placed.get("score") or {}
            out["placed"] = {"parts": placed.get("placed"), "clashes": len(sc.get("clashes") or []), "outside": sc.get("outside", 0)}
            if isinstance(placed.get("bypass"), dict):
                out["placed"]["bypass"] = placed["bypass"]
            if isinstance(out["placed"].get("bypass"), dict):      # only the capacitors that still stand in a pin's way
                out["placed"]["bypass"] = {c: {n: v for n, v in caps.items() if v.get("blocks")} for c, caps in out["placed"]["bypass"].items()}
                out["placed"]["bypass"] = {c: v for c, v in out["placed"]["bypass"].items() if v} or None
                if not out["placed"]["bypass"]:
                    del out["placed"]["bypass"]
        for ref, nets in (swap or {}).items():
            got = step(f"swap {ref}", lambda ref=ref, nets=nets: self.swap_pins(ref, list(nets)))
            if got:
                out.setdefault("swapped", {})[ref] = len(got.get("pins") or {})
    # ground on every layer that carries it, before anything is routed: the outer layers, and both inner layers of four
    if not _has_ground(self):
        copper = self.info().get("copper_layers") or ["F.Cu", "B.Cu"]
        names = [c if isinstance(c, str) else c.get("name") for c in copper]
        for layer in names:
            if layer in ("F.Cu", "B.Cu") or layer in INNER_GROUND or len(names) > 4:
                step(f"zone {layer}", lambda layer=layer: self.zone("GND", layer=layer, connect="solid" if layer.startswith("In") else "thermal"))
    if not reroute:
        step("corners", self.round_corners)      # board corners are always rounded
        if place and route:      # pads of one supply or switching net that stand together: a pour joins them, as a wide track would
            pp = step("power pours", self.power_pours)
            if pp:
                out["power_pours"] = pp
    step("prepare", self.prepare)
    if route:
        step("twins", self.bridge_twins)      # a USB-C connector's D+ and D- twins, joined at the pads before anything is routed
        r = dict(plan.get("route") or {})
        r["order"] = list(dict.fromkeys(list(order or []) + list(r.get("order") or [])))
        r["widths"] = {**(r.get("widths") or {}), **(widths or {})}
        r["kinds"] = {**(r.get("kinds") or {}), **(kinds or {})}
        # the clusters: each chip with the parts the plan ties to it (and the caller's own groups); the router wires
        # every cluster inside itself before it runs a track between two of them
        clusters: dict = {}
        near = {**(plan.get("place") or {}).get("near", {}), **(near or {})}
        def owner(ref, seen=()):
            o = near.get(ref)
            return ref if not o or o in seen else owner(o, (*seen, ref))
        for ref in near:
            clusters.setdefault(owner(ref), [owner(ref)]).append(ref)
        for gname, refs in (groups or {}).items():
            clusters[str(gname)] = list(refs)
        if fanout:      # fine-pitch chips escaped to a via ring first, the way they are by hand
            for part in self.geometry()["parts"]:
                if len([q for q in part["pads"] if q[0]]) >= 20:
                    fo = step(f"fanout {part['ref']}", lambda ref=part["ref"]: self.fanout(ref))
                    if fo and fo.get("vias"):
                        out.setdefault("fanout", {})[part["ref"]] = {"vias": fo["vias"], "skipped": len(fo.get("skipped") or {})}
        got = step("route", lambda: self.route(**{k: v for k, v in r.items() if k in ("order", "widths", "kinds") and v}, time_s=time_s, max_vias=max_vias, groups=clusters or None, explain=explain))
        if got:
            out["routed"] = {k: got.get(k) for k in ("routed", "connections", "vias", "length_mm")}
            if got.get("groups"):
                out["routed"]["inside_groups"] = got["groups"]
            if explain:
                try:
                    out["reasoning"] = _reasoning(self, plan, clusters, got)
                except HarnessError as e:
                    out["skipped"]["reasoning"] = str(e)[:120]
            if got.get("unrouted"):
                out["routed"]["why_open"] = [u[:160] for u in got["unrouted"][:8]]
            left = got.get("left") or {}
            if left:      # one more pass at only what is open, as a person goes back over the last few
                more = step("route again", lambda: self.route(nets=list(left), widths=r["widths"], kinds=r["kinds"], time_s=(time_s or 60) / 2, max_vias=max_vias))
                if more:
                    out["routed"]["vias"] = (out["routed"]["vias"] or 0) + (more.get("vias") or 0)
                    left = more.get("left") or {}
            out["routed"]["left"] = left
        fin = step("finish", lambda: self.finish(stitch=stitch))
        if fin:
            out["added"] = {k: (sum(v.values()) if isinstance(v, dict) and all(isinstance(x, (int, float)) for x in v.values()) else v) for k, v in fin.items() if v not in (None, {}, 0)}
        step("cleanup", self.cleanup)
        # what the real fill and the clean-up still leave open gets one last pass: a ground pad cut off from its pour
        # takes a via, anything else is routed again on its own
        still = step("unrouted", self.unrouted) or {}
        if still:
            if any(n.split("/")[-1].upper().endswith("GND") for n in still):
                step("ground pads", self.ground_pads)
            step("route last", lambda: self.route(nets=list(still), widths=r["widths"], kinds=r["kinds"], time_s=30, max_vias=max_vias))
            out["routed"]["left"] = step("unrouted", self.unrouted) or {}
        if (out.get("routed") or {}).get("left") and free_pins:     # pins boxed in by earlier tracks: free each and lay it first, never worse
            fp = step("free pins", lambda: self.free_pins(passes=1))
            if fp:
                out["routed"]["freed"] = f"open {fp['before']} -> {fp['after']}"
                if fp["after"] < fp["before"]:
                    step("finish again", self.finish)
                out["routed"]["left"] = step("unrouted", self.unrouted) or {}
        if silk:
            s = step("silkscreen", lambda: self.silkscreen(name=name, rev=rev))
            if s and s.get("hidden"):
                out["silk_hidden"] = s["hidden"]
    step("thermals", self.fix_thermals)      # a relief the last tracks left with too few spokes joins its pour solidly
    fit = None if reroute else step("3d models", self.align_models)   # every model's pins on its pads (pin 1 and the farthest pad), turned when not
    if fit and (fit.get("turned") or fit.get("misaligned")):
        out["models_3d"] = {k: fit[k] for k in ("turned", "misaligned") if fit.get(k)}
    if route:
        cut = step("corners", self.fix_corners)      # a square corner the router or a repair left: two 45-degree bends
        if cut:
            out.setdefault("added", {})["corners_cut"] = cut
    info = self.info()
    out["size_mm"], out["layers"], out["vias"] = info.get("size_mm"), len(info.get("copper_layers") or []), info.get("vias")
    chk = step("drc", lambda: self.check(limit=4))
    if chk:
        out["drc"] = {"errors": chk["errors"], "by_kind": chk["by_kind"], "first": chk["first"]} if chk["errors"] else {"errors": 0}
    rv = step("review", lambda: _brief(self))
    if rv:
        out["review"] = rv
    # the gate: what nobody should be shown
    waived = {str(a).lower() for a in (accept or [])}; refused: list = []
    def refuse(rule: str, text: str) -> None:
        if rule.lower() not in waived:
            refused.append(f"{rule}: {text}")
    fixed_place = reroute      # the person's placement: report what is wrong with it, never refuse the routing for it
    _refuse = refuse
    def refuse(rule: str, text: str) -> None:   # noqa: F811
        if fixed_place and (rule.startswith("placement") or rule in ("serve.near", "crystal.near", "usb.cc", "rf.match", "assembly.space")):
            out.setdefault("placement_notes", []).append(f"{rule}: {text}")
        else:
            _refuse(rule, text)
    try:
        for a, b, ox, oy in self.clashes():
            refuse("placement.clash", f"{a} stands on {b} (courtyards overlap by {min(ox, oy)} mm). Move one of them or make the board larger.")
    except HarnessError:
        pass
    try:
        for f in self.seating()["findings"]:
            if f.startswith("error "):
                rule, _, text = f[6:].partition(": ")
                refuse(rule, text)
    except HarnessError:
        pass
    if route:
        left = (out.get("routed") or {}).get("left") or {}
        if left:      # the later steps (ground vias, stitching, pours) close ground connections the router left: count what is open now
            try:
                left = self.unrouted()
            except HarnessError:
                pass
        if left:
            refuse("routing.open", f"{sum(left.values())} connections are not routed ({', '.join(f'{n} {c}' for n, c in list(left.items())[:8])}). An open net is a crossing: move or turn the part it starts at, or give swap= more nets, then route again.")
        if (out.get("drc") or {}).get("errors"):
            kinds = {k: v - before.get(k, 0) for k, v in out["drc"]["by_kind"].items() if (k != "unconnected_items" or not left) and v > before.get(k, 0)}
            if before:
                out["drc"]["already_there"] = before      # errors the board had before routing (inside footprints, at the edge): not counted against it
            if kinds:
                refuse("drc", f"{sum(kinds.values())} DRC errors ({', '.join(f'{k} {v}' for k, v in kinds.items())}). First: {'; '.join(out['drc']['first'][:2])}")
        for f in (out.get("review") or {}).get("findings", []):
            if f.startswith("error ") and not f.startswith("error drc"):
                rule, _, text = f[6:].partition(": ")
                refuse(rule, text)
    elif "skipped" in out and out["skipped"].get("place"):
        refuse("placement", out["skipped"]["place"])
    out["seconds"] = {"total": round(_time.time() - t_start, 1), **{k: v for k, v in sorted(secs.items(), key=lambda kv: -kv[1]) if v >= 1}}   # where the time went
    if refused:
        out["refused"] = refused
    self.project.refused = [r for r in self.project.refused if not r.startswith("board ")] + ["board " + r for r in refused]
    if not out["skipped"]:
        del out["skipped"]
    self.project.note(f"board: design() {out.get('routed', {}).get('routed', 0)} connections routed, {out.get('vias')} vias, DRC {out.get('drc', {}).get('errors', '?')} errors, review {out.get('review', {}).get('errors', '?')} errors")
    return out


def _reasoning(self, plan: dict, clusters: dict, got: dict) -> list:
    """The layout's thinking as plain lines: each cluster with where its parts stand and why, the parts in no
    cluster, then the routing order and every connection that did not come out short and flat."""
    import math
    parts = {p["ref"]: p for p in self.parts()}
    why = plan.get("why") or {}
    ex = got.get("explain") or {}
    found = ex.get("clusters") or {}
    lines = ["PLACEMENT, cluster by cluster (a cluster is one chip and the parts that serve it; each part belongs at the pin it serves, about 2 mm away, far end outward):"]
    seen = set()
    names = dict(clusters)
    for g, refs in found.items():      # the engine's own clusters, for parts the plan did not tie to a chip
        names.setdefault(g, [])
        names[g] = list(dict.fromkeys(list(names[g]) + [g] + list(refs)))
    for head, refs in names.items():
        c = parts.get(head)
        at = f"at ({c['x']}, {c['y']}) turned {c['rotation']}" if c else ""
        lines.append(f"Cluster {head} {at}: {len(refs) - (1 if head in refs else 0)} parts round it.")
        seen.add(head)
        for r in refs:
            p = parts.get(r)
            if r == head or not p or r in seen:
                continue
            seen.add(r)
            d = round(math.hypot(p["x"] - c["x"], p["y"] - c["y"]), 1) if c else None
            note = why.get(r) or "shares a net with it and stands closest to it (no rule of the plan placed it)"
            far = "  <-- FAR: more than 6 mm from its chip, check this one" if d is not None and d > 6 else ""
            lines.append(f"  {r} ({p.get('value', '')}) at ({p['x']}, {p['y']}) turned {p['rotation']}, {d} mm from {head}'s centre: {note}.{far}")
    loose = [r for r in parts if r not in seen]
    if loose:
        lines.append("In no cluster (placed by the floor plan, an edge, or left where they were): " + ", ".join(f"{r} at ({parts[r]['x']}, {parts[r]['y']})" for r in loose[:40]) + ".")
    for ref, side in ((plan.get("place") or {}).get("edges") or {}).items():
        lines.append(f"{ref} goes on the {side} edge: {why.get(ref) or 'it must reach the outside (a connector or an antenna)'}.")
    for a, b in plan.get("apart") or []:
        lines.append(f"{a} and {b} are kept apart: one disturbs the other.")
    r = plan.get("route") or {}
    lines.append("ROUTING ORDER: 1. critical nets, short, on one layer, no via (" + (", ".join(ex.get("critical_first") or r.get("order") or []) or "none found") + "); 2. the connections inside each cluster; 3. power (a pin of a net with an inner plane drops straight into it); 4. fine-pitch escapes; 5. the tracks between clusters.")
    g = got.get("groups") or {}
    if g:
        lines.append(f"Inside clusters: {g.get('routed')} of {g.get('inside')} connections made, with {g.get('vias')} vias. A via here means a part of that cluster faces the wrong way or stands too far out.")
    if r.get("widths"):
        lines.append("Widths: " + ", ".join(f"{n} {w} mm" for n, w in r["widths"].items()) + " (supplies wide, RF at its impedance); plain signals 0.2 mm where they fit.")
    for c in ex.get("layer_changes") or []:
        ratio = f", {c['length_mm']} mm for {c['straight_mm']} mm straight" if c.get("straight_mm") else ""
        lines.append(f"Layer change: {c['net']} {c.get('from')} to {c.get('to')} took {c['vias']} via{'s' if c['vias'] != 1 else ''} over {'/'.join(c.get('layers') or [])}{ratio}: no way on one layer within 1.6 times the straight line, so something crosses it between those pads.")
    for c in ex.get("longest_detours") or []:
        lines.append(f"Detour: {c['net']} {c.get('from')} to {c.get('to')} is {c['length_mm']} mm, {c['detour_ratio']} times the straight line: the direct way was taken by earlier tracks or parts.")
    for u in got.get("unrouted") or []:
        lines.append(f"Open: {u}")
    return lines


def _has_ground(self) -> bool:
    from . import physics as _physics
    try:
        return bool(_physics._has_zones(self))
    except HarnessError:
        return False


def _seg_dist(p, a, b) -> float:
    ax, ay = b[0] - a[0], b[1] - a[1]; L = ax * ax + ay * ay
    u = 0.0 if L < 1e-12 else max(0.0, min(1.0, ((p[0] - a[0]) * ax + (p[1] - a[1]) * ay) / L))
    return math.hypot(p[0] - a[0] - u * ax, p[1] - a[1] - u * ay)


def _segs_dist(a, b, c, d) -> float:
    return min(_seg_dist(a, c, d), _seg_dist(b, c, d), _seg_dist(c, a, b), _seg_dist(d, a, b))


def _fanout(self, ref: str, nets: list | None = None, far: float = 4.0, pad_len: float | None = None, apply: bool = True) -> dict:
    """Escape a fine-pitch chip (QFN or QFP, 0.5 mm pitch or finer) the way it is done by hand, before anything else is
    routed: every pin whose net goes far (another pad more than `far` mm away) gets a short stub straight out of its pad
    and a via in a staggered ring of two rows just outside the pin row, the vias in the order of the pins so no two stubs
    cross.  The router then starts those nets from the via, on whichever layer is free, instead of fighting for the
    narrow space in front of the chip, where neighbouring escapes otherwise box pins in.  Supply and ground pins, pins
    whose net stays close (a decoupling capacitor, the crystal) and pins with no free site keep their pads for the router.

    nets: only these (default: every far-going signal net).  apply=False only plans.  Returns {"vias": n, "pins":
    [pin numbers fanned], "skipped": {pin: why}}.  board.design() calls it for every fine-pitch chip unless fanout=False."""
    parts = {p["ref"]: p for p in self.geometry()["parts"]}
    part = parts.get(ref)
    if not part:
        raise HarnessError(f"fanout: no part {ref} on the board")
    pads = [q for q in part["pads"] if q[0]]
    if len(pads) < 20:
        return {"vias": 0, "pins": [], "skipped": {}, "note": f"{ref} has fewer than 20 pins"}
    cx, cy, rot = float(part["x"]), float(part["y"]), math.radians(-float(part["rotation"] or 0))
    normals = [(math.cos(rot + k * math.pi / 2), math.sin(rot + k * math.pi / 2)) for k in range(4)]
    r = (self.project.transport.call("get_board_info", {}).get("design_rules") or {})
    nc = (r.get("net_classes") or {}).get("Default") or {}
    clr = float(nc.get("clearance") or r.get("clearance") or 0.15); vd = float(nc.get("via_diameter") or 0.5); tw = min(0.2, float(nc.get("track_width") or 0.2))
    vr = vd / 2
    sides = {}
    for q in pads:
        dx, dy = q[1] - cx, q[2] - cy
        k = max(range(4), key=lambda i: dx * normals[i][0] + dy * normals[i][1])
        sides.setdefault(k, []).append(q)
    pitch = min((math.hypot(a[1] - b[1], a[2] - b[2]) for s in sides.values() for a, b in zip(sorted(s, key=lambda q: (q[1], q[2])), sorted(s, key=lambda q: (q[1], q[2]))[1:])), default=1)
    if pitch > 0.65:
        return {"vias": 0, "pins": [], "skipped": {}, "note": f"{ref} pitch {pitch:.2f} mm is not fine"}
    half = pad_len / 2 if pad_len else 0.4
    # where every net's pads are, to tell a far-going net from a local one
    where = {}
    for p in parts.values():
        for q in p["pads"]:
            if q[3]:
                where.setdefault(q[3], []).append((q[1], q[2], p["ref"]))
    from .rules import _SUPPLY as _sup
    is_supply = lambda nm: bool(_sup.match(nm.lstrip("/")) or _sup.match(nm))   # noqa: E731
    others = [(q[1], q[2], q[3]) for p in parts.values() if p["ref"] != ref for q in p["pads"]]
    placed_v, placed_s, plan, skipped = [], [], [], {}
    for k, side in sides.items():
        n = normals[k]; tng = (-n[1], n[0])
        proj = max((q[1] - cx) * n[0] + (q[2] - cy) * n[1] for q in side)
        row = [q for q in side if (q[1] - cx) * n[0] + (q[2] - cy) * n[1] > proj - 0.2]
        s_of = lambda x, y: (x - cx) * tng[0] + (y - cy) * tng[1]   # noqa: E731
        want = []
        for q in sorted(row, key=lambda q: s_of(q[1], q[2])):
            net = q[3]
            if not net or (nets and net not in nets and net.lstrip("/") not in nets) or (not nets and (is_supply(net) or net.upper().endswith("GND"))):
                continue
            if not any(math.hypot(x - q[1], y - q[2]) > far for x, y, rr in where.get(net, []) if rr != ref):
                skipped[q[0]] = "net stays close"
                continue
            want.append(q)
        if not want:
            continue
        span = max(abs(s_of(q[1], q[2])) for q in row) + 0.3
        d1 = half + clr + vr + 0.15; d2 = d1 + vd + clr       # two rows of via sites; row two sits in row one's gaps
        P = vd + 2 * clr + tw + 0.05
        sites = []
        j = -int(span / P) - 1
        while j * P <= span + P:
            for s, d in ((j * P, d1), (j * P + P / 2, d2)):
                if abs(s) <= span:
                    sites.append((s, d))
            j += 1
        sites.sort()
        # order-keeping assignment of pins to sites, least total sideways travel; a pin may stay unfanned
        m, ns = len(want), len(sites)
        INF = float("inf")
        best = [[INF] * (ns + 1) for _ in range(m + 1)]; how = [[0] * (ns + 1) for _ in range(m + 1)]
        for jj in range(ns + 1):
            best[0][jj] = 0
        for i in range(1, m + 1):
            si = s_of(want[i - 1][1], want[i - 1][2])
            for jj in range(1, ns + 1):
                skip_site = best[i][jj - 1]
                s, d = sites[jj - 1]; dev = abs(s - si)
                use = best[i - 1][jj - 1] + dev if dev <= d - half - 0.1 else INF
                skip_pin = best[i - 1][jj] + 3.0
                best[i][jj], how[i][jj] = min((skip_site, 0), (use, 1), (skip_pin, 2))
        i, jj, pairs = m, ns, []
        while i > 0 and jj > 0:
            h = how[i][jj]
            if h == 1:
                pairs.append((want[i - 1], sites[jj - 1])); i -= 1; jj -= 1
            elif h == 0:
                jj -= 1
            else:
                skipped[want[i - 1][0]] = "no via site"; i -= 1
        while i > 0:
            skipped[want[i - 1][0]] = "no via site"; i -= 1
        for q, (s, d) in sorted(pairs, key=lambda pq: pq[1][1]):   # inner row first
            si = s_of(q[1], q[2]); dev = s - si
            base = (q[1] - cx) * n[0] + (q[2] - cy) * n[1]
            pt = lambda s_, d_: (cx + n[0] * (proj + d_) + tng[0] * s_, cy + n[1] * (proj + d_) + tng[1] * s_)   # noqa: E731
            exit_ = pt(si, half + 0.05 + (proj - base))
            v = pt(s, d); bend = pt(si, d - abs(dev)) if abs(dev) > 1e-3 else v
            path = [(q[1], q[2]), exit_, bend, v] if abs(dev) > 1e-3 else [(q[1], q[2]), exit_, v]
            segs = list(zip(path[1:], path[2:]))
            ok = True
            for (x, y) in [v]:
                if any(math.hypot(x - a[0], y - a[1]) < 2 * vr + clr - 1e-6 for a in placed_v):
                    ok = False
                if any(math.hypot(x - a[0], y - a[1]) < vr + clr + 0.3 and net_ != q[3] for a in [(o[0], o[1]) for o in others] for net_ in [None]):
                    ok = False
                if any(math.hypot(x - o[1], y - o[2]) < vr + clr + 0.15 for o in pads if o[0] != q[0]):
                    ok = False
                if any(_seg_dist((x, y), a, b) < vr + tw / 2 + clr - 1e-6 for a, b, _ in placed_s):
                    ok = False
            for a, b in segs:
                if any(_seg_dist(c, a, b) < vr + tw / 2 + clr - 1e-6 for c in placed_v):
                    ok = False
                if any(_segs_dist(a, b, c, d) < tw + clr - 1e-6 for c, d, _ in placed_s):
                    ok = False
                if any(_seg_dist((o[1], o[2]), a, b) < pitch / 4 + tw / 2 + clr - 1e-6 for o in pads if o[0] != q[0] and o[0]):
                    ok = False
            if not ok:
                skipped[q[0]] = "too close to a neighbour"
                continue
            placed_v.append(v)
            for a, b in segs:
                placed_s.append((a, b, q[3]))
            plan.append((q, path, v))
    if apply:
        for q, path, v in plan:
            self.track(q[3], [[round(x, 4), round(y, 4)] for x, y in path], layer="F.Cu" if part.get("side", "front") == "front" else "B.Cu", width=tw)
            self.via(q[3], [round(v[0], 4), round(v[1], 4)])
        if plan:
            self.project.note(f"board: fanned out {ref}: {len(plan)} pins to a staggered via ring")
    return {"vias": len(plan), "pins": sorted((q[0] for q, _, _ in plan), key=lambda x: (len(x), x)), "skipped": skipped}


def install(Board) -> None:
    Board.design = _design
    Board.brief = _brief
    Board.fanout = _fanout
