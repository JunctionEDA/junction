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

import contextlib
import math
import re

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
            free_pins: bool = True, chip_escapes: bool = False, unbox: bool = False, keep_rules: bool = False, gate: bool = True, keepouts: list | None = None, escapes=None, plan=None, ripup: str | None = None) -> dict:
    """Lay the whole board out in one call and say how it came out.

    gate=True (the default): every repair stage after the routing (clean-up, ground pads, last route, finish again,
    stitch removal, corners) is kept only if it leaves no more connections open and no more rules errors; a stage taken
    back is listed under "gated".

    keep_rules=True never touches the design rules (no house via either), for a person who said not to change them;
    otherwise any change is listed under "rules_changed".  layers=["F.Cu", "B.Cu", ...] names the routing layers (an
    inner ground plane left whole costs open connections on a dense board: measured 9 to 12 on Cyberboard, 13 to 29
    on Ember); a number is how many copper layers the board should have.

    keepouts=[{"box": [x0, y0, x1, y1], "layers": [...]}] holds the first routing pass out of areas: no via in the box,
    and no track on the named layers (all when none named).  For a fine-pitch chip routed the owner's way: a box round
    it with layers=[every layer but the chip's own], so its escapes leave as buses on its layer and change layer only
    outside; the later passes may go in again to finish what is left.

    explain=True adds "reasoning": a list of plain lines saying where every part stands and why (its cluster, the
    pin it serves, how far from it), which parts belong to no cluster, the order the nets were routed in and why,
    and every connection that changed layer, wandered or stayed open, with the cause.  Use it when the person wants
    to check the thinking behind a layout; read it for the line that is wrong and fix that step.

    free_pins=True (the default): connections still open at the end because earlier tracks boxed a pin in are freed one
    pin at a time (board.free_pins); a try that does not help is taken back.  It stops starting new pins after twice
    time_s (at least two minutes), so the whole call stays within about four times time_s.

    chip_escapes=True (off by default: it pushed the Ember benchmark past two hours for one connection): what is still open on the finished board (after the corners are cut) on a fine-pitch chip's pins gets the AI's hand fan-out
    (board.escape_chips): side by side, a dogbone for each open pin where the fewest tracks are in the way, then a
    dogbone ring with its neighbours, then a bus with staggered vias at the lane ends, the moved nets routed again,
    each try kept only when fewer connections are open (Ember 11 -> 9, Cyberboard 6 -> 5 open on the benchmark routed copies).  It stops
    starting new tries after twice time_s (at least ten minutes).  Better: call board.escape_chips(refs=[...]) yourself on the chip that is still open.

    unbox=True (off by default: minutes per chip): what fine-pitch chips still leave open at the end gets board.unbox(),
    the routing AI's staggered dogbone trios with the copper in their way cleared, keep-best (Cyberboard 6 -> 2 open,
    score 75 -> 90, in nine minutes on the benchmark's routed copy).  Better: call board.unbox(refs=["U4"]) yourself.

    fanout=True escapes every fine-pitch chip (20 pins or more, 0.65 mm pitch or finer) to a staggered ring of vias
    before routing (board.fanout): for a dense QFN whose pins are left open because neighbouring tracks box them in.
    fanout={"U4": [nets]} drops only those pins to a via straight out (radial, rows staggered), the way the person's
    boards do it: name the pins whose other end lies behind the chip or across the other escapes.

    escapes (on by default, board.route(escapes=...)): each routing pass is routed once without escapes; where that
    leaves pins of a fine-pitch row open, those rows get Copper's analytic escapes (each connected pin leaves on its
    own layer as a stub, a 45-degree leg or a via where its net must change layer, closing no other pin's way out)
    and the pass is routed again from them, kept only when fewer connections are left open (Cyberboard 11 -> 9 open;
    Ledify, whose chips escape anyway, comes out unchanged).  escapes=False routes once without.

    plan=True plans every connection on a coarse tile graph before each routing pass (board.route(plan=...)): congestion
    negotiated over the tiles, forced crossings found, layers assigned along each coarse path; the connections it fought
    over are laid and taken up first, and those it moved off their direct path are steered into their corridors and
    onto the planned layers.  On by default in design() (plan=False turns it off); board.route() leaves it off.

    ripup="mincut" takes up only the cheapest set of routes in an open connection's way when the router repairs what
    its passes left open (a minimum cut, after Copper), and keeps the result only when fewer are open (board.route).
    ripup="ladder" runs Copper's whole repair ladder on what is left open: rescue (one extra via, half pitch, neck
    width, the other escape side; it moves nothing else), the min-cut rip, permutation of the routes fighting for the
    channel, and, with plan=True, feedback into the plan; each rung kept only when fewer are open and nothing routed
    is lost (board.route).  The result's routed.ladder counts what each rung laid.  design() uses the ladder by default.
    With gate=True (the default) and plan or ripup given, the board is routed both plainly and with them and the
    better of the two stays (fewer open, then fewer errors): out["variants"] says which won.  It costs a second route.

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

    def standing():
        """(open connections, rules errors other than open ones) with the pours filled: what a stage is judged by."""
        with contextlib.suppress(HarnessError):
            self.fill()
        by = (self.check(limit=0, refill=False) or {}).get("by_kind") or {}
        return (int(self.info().get("unrouted_connections") or 0), sum(v for k, v in by.items() if k != "unconnected_items"))

    def gated(what, fn):
        """Keep-best (as Copper's engine gates every stage): the stage's copper stays only when it leaves no more
        connections open and, at the same count, no more rules errors; otherwise every track and via goes back."""
        if not gate:
            return step(what, fn)
        before = standing()
        with self.trial() as t:
            res = step(what, fn)
            after = standing()
            t.keep = after[0] < before[0] or (after[0] == before[0] and after[1] <= before[1])
        if not t.keep:
            out.setdefault("gated", {})[what] = f"taken back: open {before[0]} -> {after[0]}, errors {before[1]} -> {after[1]}"
            return None
        return res

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
    global_plan = plan      # the router's global plan option; `plan` below is the board's layout plan
    if gate and global_plan is None:      # on by default: with the gate the board is also routed without it and the better run stays
        global_plan = True
    if gate and ripup is None:
        ripup = "ladder"
    plan = step("plan", lambda: self.plan(edge=edge)) or {"place": {"near": {}, "edges": {}}, "route": {}, "notes": []}
    out["notes"] = [n.split(". ")[0] for n in plan.get("notes", [])][:6]
    rec = dict((plan.get("stackup") or {}).get("recommended") or {})
    all_layers = layers == "all"
    route_layers = list(layers) if isinstance(layers, (list, tuple)) else None
    if route_layers or all_layers:
        layers = None
    if layers:
        rec["layers"] = layers
    have_layers = len(self.info().get("copper_layers") or [])
    want = int(rec.get("layers") or have_layers or 2)
    if not layers and want < have_layers:       # never take copper layers off a board unless the caller asked for fewer
        want = rec["layers"] = have_layers
    if want > len(self.info().get("copper_layers") or []) and not reroute:
        step("layers", lambda: self.layers(want, planes=list(INNER_GROUND) if want >= 4 else None))
    if not reroute:
        step("stackup", lambda: self.stackup(fab=fab, rules=not keep_rules, **rec))
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
        if "place" in out["skipped"]:      # routing an old placement wastes the whole run: stop here and say why
            raise HarnessError("design: placement failed, nothing was routed: " + out["skipped"]["place"])
        if placed:
            sc = placed.get("score") or {}
            out["placed"] = {"parts": placed.get("placed"), "clashes": len(sc.get("clashes") or []), "outside": sc.get("outside", 0)}
            if placed.get("motion_sensors"):      # IMUs square to the board, their axes said so the firmware can map them
                out["placed"]["motion_sensors"] = placed["motion_sensors"]
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
            inner = [x for x in names if x.startswith("In")]
            # four layers: both inner layers ground; six and up: the inner layer next to each outer one, the middle ones left for power and signals
            if layer in ("F.Cu", "B.Cu") or (len(names) <= 4 and layer in INNER_GROUND) or (len(names) > 4 and inner and layer in (inner[0], inner[-1])):
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
                if (part["ref"] in fanout) if isinstance(fanout, dict) else len([q for q in part["pads"] if q[0]]) >= 20:
                    fo = step(f"fanout {part['ref']}", lambda ref=part["ref"]: self.fanout(ref, nets=fanout.get(ref), style="radial") if isinstance(fanout, dict) else self.fanout(ref))
                    if fo and fo.get("vias"):
                        out.setdefault("fanout", {})[part["ref"]] = {"vias": fo["vias"], "skipped": len(fo.get("skipped") or {})}
        auto_layers = False
        if route_layers is None and not all_layers:      # six layers and up: the inner planes stay whole, signals keep to the other layers
            route_layers, planes = signal_layers(self)
            if route_layers:
                out.setdefault("notes", []).append(f"routed on {', '.join(route_layers)}: {', '.join(sorted(planes))} kept whole as planes (layers= to route on them)")
        def lay(**over):
            kw = dict(time_s=time_s, max_vias=max_vias, groups=clusters or None, explain=explain, layers=route_layers, keep_rules=keep_rules, keepouts=keepouts, escapes=escapes, plan=global_plan, ripup=ripup)
            kw.update(over)
            return self.route(**{k: v for k, v in r.items() if k in ("order", "widths", "kinds") and v}, **kw)
        if gate and (global_plan or ripup):
            # keep-best between variants (as Copper's engine keeps the better of two opinions): the board is routed with
            # the plan / repair ladder asked for, then again the plain way, and the one leaving fewer connections open
            # (then fewer rules errors) stays; a tie goes to the plain way.  A board those options make worse comes out as without them.
            ids0 = {it["id"] for it in self._all_items(["segment", "arc", "via"])}
            alt = step("route with options", lambda: lay())
            opts_st = standing()
            with self.trial() as t:      # the plain way second, on the same bare board, so a plain win is that run as it came
                for it in self._all_items(["segment", "arc", "via"]):
                    if it["id"] not in ids0:
                        self._edit({"op": "remove", "id": it["id"]})
                self.flush()
                got = step("route", lambda: lay(plan=None, ripup=None))
                plain = standing()
                t.keep = not (opts_st[0] < plain[0] or (opts_st[0] == plain[0] and opts_st[1] < plain[1]))
            out["variants"] = {"plain": {"open": plain[0], "errors": plain[1]}, "options": {"open": opts_st[0], "errors": opts_st[1]}, "kept": "plain" if t.keep else "options"}
            if t.keep:      # the later route calls go the way that won
                global_plan = ripup = None
            else:
                got = alt
        else:
            got = step("route", lambda: lay())
        if got and got.get("rules_changed"):
            out["rules_changed"] = got["rules_changed"]
        if got:
            out["routed"] = {k: got.get(k) for k in ("routed", "connections", "vias", "length_mm")}
            if got.get("groups"):
                out["routed"]["inside_groups"] = got["groups"]
            if got.get("fanout"):
                out["routed"]["fanout"] = got["fanout"]
            if got.get("plan"):
                out["routed"]["plan"] = got["plan"]
            if got.get("ladder"):
                out["routed"]["ladder"] = got["ladder"]
            if explain:
                try:
                    out["reasoning"] = _reasoning(self, plan, clusters, got)
                except HarnessError as e:
                    out["skipped"]["reasoning"] = str(e)[:120]
            if got.get("unrouted"):
                out["routed"]["why_open"] = [u[:160] for u in got["unrouted"][:8]]
            left = got.get("left") or {}
            if left:      # one more pass at only what is open, as a person goes back over the last few
                more = step("route again", lambda: self.route(nets=list(left), widths=r["widths"], kinds=r["kinds"], time_s=(time_s or 60) / 2, max_vias=max_vias, layers=None if auto_layers else route_layers, keep_rules=True, escapes=escapes, plan=global_plan, ripup=ripup))
                if more:
                    out["routed"]["vias"] = (out["routed"]["vias"] or 0) + (more.get("vias") or 0)
                    left = more.get("left") or {}
            out["routed"]["left"] = left
        rf = step("rf feeds", self.rf_feeds)      # every antenna feed to 50 ohm from the stackup: width, planes cut away under it, arcs, fence
        if rf and any(f.get("width") for f in rf.get("feeds", [])):
            out["rf_feeds"] = [{k: f[k] for k in ("net", "width", "impedance", "reference", "voided") if k in f} | ({"fence_vias": f["fence"].get("vias")} if isinstance(f.get("fence"), dict) else {}) for f in rf["feeds"] if f.get("width")]
        fin = step("finish", lambda: self.finish(stitch=stitch))
        if fin:
            out["added"] = {k: (sum(v.values()) if isinstance(v, dict) and all(isinstance(x, (int, float)) for x in v.values()) else v) for k, v in fin.items() if v not in (None, {}, 0)}
        gated("cleanup", self.cleanup)
        # what the real fill and the clean-up still leave open gets one last pass: a ground pad cut off from its pour
        # takes a via, anything else is routed again on its own
        still = step("unrouted", self.unrouted) or {}
        if still:
            if any(n.split("/")[-1].upper().endswith("GND") for n in still):
                gated("ground pads", self.ground_pads)
            gated("route last", lambda: self.route(nets=list(still), widths=r["widths"], kinds=r["kinds"], time_s=30, max_vias=max_vias, layers=None if auto_layers else route_layers, keep_rules=True, escapes=escapes, plan=global_plan, ripup=ripup))
            out["routed"]["left"] = step("unrouted", self.unrouted) or {}
        if (out.get("routed") or {}).get("left") and free_pins:     # pins boxed in by earlier tracks: free each and lay it first, never worse
            fp = step("free pins", lambda: self.free_pins(passes=1, keep_rules=True, layers=None if auto_layers else route_layers, time_s=min(60, max(20, (time_s or 60) / 3)), budget_s=max(120, 2 * (time_s or 60))))
            if fp:
                out["routed"]["freed"] = f"open {fp['before']} -> {fp['after']}"
                if fp["after"] < fp["before"]:
                    gated("finish again", self.finish)
                out["routed"]["left"] = step("unrouted", self.unrouted) or {}
        if silk:
            s = step("silkscreen", lambda: self.silkscreen(name=name, rev=rev))
            if s and s.get("hidden"):
                out["silk_hidden"] = s["hidden"]
    if route:
        dropped = gated("bad stitches", lambda: _drop_bad_stitches(self))      # a stitching or fence via the later passes routed against
        if dropped:
            out.setdefault("added", {})["stitches_dropped"] = dropped
    step("thermals", self.fix_thermals)      # a relief the last tracks left with too few spokes joins its pour solidly
    fit = None if reroute else step("3d models", self.align_models)   # every model's pins on its pads (pin 1 and the farthest pad), turned when not
    if fit and (fit.get("turned") or fit.get("misaligned")):
        out["models_3d"] = {k: fit[k] for k in ("turned", "misaligned") if fit.get(k)}
    if route:
        cut = gated("corners", self.fix_corners)      # a square corner the router or a repair left: two 45-degree bends
        if cut:
            out.setdefault("added", {})["corners_cut"] = cut
        # a fine-pitch chip's pins still boxed in: the AI's hand fan-out, keep-best.  On the finished copper (bad
        # stitches dropped, corners cut), where the same tries land better than before them (Cyberboard 6 -> 5 here,
        # nothing found when it ran right after free pins)
        if (out.get("routed") or {}).get("left") and chip_escapes:
            def _escape():
                try:
                    return self.escape_chips(time_s=min(60, max(30, (time_s or 60) / 3)), layers=None if auto_layers else route_layers,
                                             keep_rules=True, budget_s=max(600, 2 * (time_s or 60)), cc_vias=reroute)      # on the person's placement a CC via is a note, an open CC line is not
                except HarnessError:
                    raise
                except Exception as e:      # noqa: BLE001  a repair stage never costs the layout: every try is taken back
                    raise HarnessError(f"escape chips: {type(e).__name__}: {e}") from e
            ce = step("escape chips", _escape)
            if ce and ce.get("tried"):
                out["routed"]["chip_escapes"] = {"open": f"{ce['before']} -> {ce['after']}", "kept": ce["kept"]}
                if ce["after"] < ce["before"]:
                    gated("finish again", self.finish)
                    step("thermals again", self.fix_thermals)
                    gated("corners again", self.fix_corners)
                out["routed"]["left"] = step("unrouted", self.unrouted) or {}
        # the routing AI's dogbone trios on what fine-pitch chips still leave open (board.unbox), keep-best
        if (out.get("routed") or {}).get("left") and unbox:
            def _unbox():
                try:
                    return self.unbox(budget_s=max(600, 2 * (time_s or 60)), layers=None if auto_layers else route_layers)
                except HarnessError:
                    raise
                except Exception as e:      # noqa: BLE001  every try is taken back
                    raise HarnessError(f"unbox: {type(e).__name__}: {e}") from e
            ub = step("unbox", _unbox)
            if ub and ub.get("tried"):
                out["routed"]["unbox"] = {"open": f"{ub['before']} -> {ub['after']}", "tries": len(ub["tried"])}
                if ub["after"] < ub["before"]:
                    gated("finish again", self.finish)
                    step("thermals again", self.fix_thermals)
                    gated("corners again", self.fix_corners)
                out["routed"]["left"] = step("unrouted", self.unrouted) or {}
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
    # the verdict first, the long explanations last: a printed result that gets cut keeps what matters
    head = ("refused", "rules_changed", "routed", "drc", "seconds")
    out = {**{k: out[k] for k in head if k in out}, **{k: v for k, v in out.items() if k not in head and k != "reasoning"}, **({"reasoning": out["reasoning"]} if "reasoning" in out else {})}
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


def signal_layers(self) -> tuple:
    """On six copper layers and up: the layers signals may use, and the inner layers kept whole as planes (an inner
    layer with a single-layer pour over 60% of the outline).  (None, set()) when every layer may carry signals."""
    with contextlib.suppress(HarnessError):
        names = [c if isinstance(c, str) else c.get("name") for c in (self.info().get("copper_layers") or [])]
        ob = self.geometry().get("outline")
        if len(names) > 4 and ob:
            area = abs((ob[2] - ob[0]) * (ob[3] - ob[1])) or 1
            planes = {l for z in self.zones() if not z.get("keepout") and z.get("box") and (z["box"][2] - z["box"][0]) * (z["box"][3] - z["box"][1]) > 0.6 * area
                      for l in z["layers"] if l.startswith("In") and len(z["layers"]) == 1}
            if planes and len(names) - len(planes) >= 2:
                return [l for l in names if l not in planes], planes
    return None, set()


def _drop_bad_stitches(self) -> int:
    """Ground vias with no track of their own (stitching, fences) that a rules error now sits on: taken out, since the
    router's later passes may have laid tracks past them and a stitch is worth less than a clean board."""
    gone = 0
    for v in self._fresh_checks().get("violations", []):
        if v.get("severity") != "error" or v.get("code") not in ("clearance", "shorting_items", "hole_clearance", "copper_edge_clearance", "tracks_crossing", "hole_to_hole"):
            continue
        items = self.whats_at((v["x"], v["y"]), radius=0.5)
        for it in items:
            if it.get("kind") != "via" or not re.fullmatch(r"/?(A|D|P)?(GND|VSS)\w*", it.get("net") or "", re.I):
                continue
            at = it.get("at") or [v["x"], v["y"]]
            own = [t for t in self.whats_at(at, radius=float((it.get("size")[0] if isinstance(it.get("size"), list) else it.get("size")) or 0.5) / 2) if t.get("kind") in ("track", "segment", "arc") and t.get("net") == it.get("net")]
            if own:
                continue
            with contextlib.suppress(HarnessError):
                self.remove(it["id"]); gone += 1
            break
    if gone:
        self.flush()
    return gone


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


def _fanout(self, ref: str, nets: list | None = None, far: float = 4.0, pad_len: float | None = None, apply: bool = True,
            rows: int | None = None, first: float | None = None, style: str = "ring", length: float = 1.5, spacing: float | None = None,
            turn: str | None = None, toward=None, vias: bool = False, via: tuple | None = None) -> dict:
    """Escape a fine-pitch chip (QFN or QFP, 0.5 mm pitch or finer) the way it is done by hand, before anything else is
    routed: every pin whose net goes far (another pad more than `far` mm away) gets a short stub straight out of its pad
    and a via in a staggered ring of two rows just outside the pin row, the vias in the order of the pins so no two stubs
    cross.  The router then starts those nets from the via, on whichever layer is free, instead of fighting for the
    narrow space in front of the chip, where neighbouring escapes otherwise box pins in.  Supply and ground pins, pins
    whose net stays close (a decoupling capacitor, the crystal) and pins with no free site keep their pads for the router.

    style="ring" (default) assigns pins to staggered via sites in pin order; style="radial" puts each via straight out
    from its own pin, the rows staggered (needs a via, a stub and the clearance to fit in one pin pitch: at 0.4 mm
    pitch with 0.15 mm clearance it does not, and every other pin is skipped); style="bus" is the owner's Ember
    escape: no vias, every far pin straight out `first` mm (0.3) past its pad, then the side's bus turns 45 degrees
    towards where its nets go, lanes `spacing` mm apart (default track + clearance, the tightest the rules allow), and runs on `length` mm (1.5) for the router to carry on
    from (layer changes then happen out there, where the bus has room).

    Bus options: turn="cw"|"ccw" turns the whole side one way round the chip (clockwise as seen on screen, Y down)
    instead of towards the nets, for when that way runs into a capacitor or a supply track; toward=(x, y) turns each
    side towards that point instead of the nets' own pads.  vias=True ends every lane in a via, staggered: the lane on
    the outside of the turn (away from the chip) stops first and each next lane runs on one via pitch further, every
    via stepped outwards just enough to clear the lane beside it, the way the owner's Ember drops its buses.
    via=(0.4, 0.2) sets that via's size and drill (default the net class's; 0.4/0.2 is what fits beside 0.4 mm pitch
    lanes when the rules allow it).  At 0.4 mm pitch two neighbouring pins can never both drop to vias straight out:
    the deeper stub passes the shallower via closer than via/2 + clearance + track/2, so let the bus turn first.

    On a board that already has copper each lane stops short of other nets' tracks and vias on its way (and of other
    parts' pads), a via goes only where it keeps the copper and the hole clearance to everything there, and the
    vias stay staggered (a lane cut too short for its via is carried on by the router).  After drawing, each new rules
    error is blamed on the one escape nearest it: its via goes first, then the lane is cut back to the stub out of
    its pad, and only then is it taken back (the result's "cut_back" lists those pins).

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
    if via:
        vd = float(via[0])
    vr = vd / 2
    vdrill = float(via[1]) if via else float(nc.get("via_drill") or 0.2)
    hclr = float(r.get("hole_clearance") or 0.25)      # KiCad's board-setup hole clearance (0.25 mm unless the rules say)
    vreach = max(vr + clr, vdrill / 2 + hclr)          # a via's centre to another net's copper edge
    if style in ("radial", "bus"):
        tw = min(tw, 0.15)      # a stub passes a neighbour's via 0.4 mm away on a 0.4 mm pitch
    sides = {}
    for q in pads:
        dx, dy = q[1] - cx, q[2] - cy
        k = max(range(4), key=lambda i: dx * normals[i][0] + dy * normals[i][1])
        sides.setdefault(k, []).append(q)
    pitch = min((d_ for s in sides.values() for a, b in zip(sorted(s, key=lambda q: (q[1], q[2])), sorted(s, key=lambda q: (q[1], q[2]))[1:])
                 for d_ in [math.hypot(a[1] - b[1], a[2] - b[2])] if d_ > 0.05), default=1)      # pads drawn twice on one spot are one pad
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
    cu = None
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
        if style == "bus":
            # the person's Ember escape: every far-going pin leaves straight out on the chip's own layer, side by side
            # at the pin pitch, then the bus turns 45 degrees towards where its nets go (the side splits where the
            # destinations do) and runs on `length` mm, with no via near the chip; the bends of each half lie on the
            # line that keeps the lanes one pin pitch apart through the turn (the inside lane turns first, each lane
            # further out (sqrt(2) - 1) x its distance later), and the router carries on from the bus ends
            # lanes `spacing` apart after the turn (default: track width + clearance, the tightest the rules allow)
            sp = max(spacing if spacing else tw + clr, tw + clr)
            T = math.sqrt(2) * sp / pitch - 1
            obst = [(q[1], q[2], q[3], (max(q[4], q[5]) / 2 if len(q) > 5 and q[4] else 0.4)) for pp in parts.values() if pp["ref"] != ref for q in pp["pads"]]
            if cu is None:      # the copper already on the board round the chip: a lane stops short of it, a via keeps clear of it
                cu = {"segs": [], "vias": []}
                reach = max(math.hypot(q[1] - cx, q[2] - cy) for q in pads) + length + 8.0
                with contextlib.suppress(HarnessError):
                    for it in self.whats_at((cx, cy), radius=reach):
                        if it["kind"] in ("segment", "arc") and it.get("start"):
                            cu["segs"].append((tuple(it["start"]), tuple(it["end"]), float(it.get("width") or 0.2) / 2, it["net"], it["layer"]))
                        elif it["kind"] == "via" and it.get("at"):
                            cu["vias"].append((it["at"][0], it["at"][1], float(it.get("size") or 0.5) / 2, it["net"]))
            lay_l = "F.Cu" if part.get("side", "front") == "front" else "B.Cu"
            def blocked_lane(px, py, net):      # a lane's centre line at (px, py) comes too close to other copper on its layer
                return (any(nt != net and _seg_dist((px, py), A, B) < w_ + clr + tw / 2 for A, B, w_, nt, ly in cu["segs"] if ly == lay_l)
                        or any(nt != net and math.hypot(px - vx, py - vy) < vr_ + clr + tw / 2 for vx, vy, vr_, nt in cu["vias"]))
            def via_ok(v, net):      # a through via of `net` at v keeps every rule to what is there and what this fan-out laid
                return not (any(nt != net and math.hypot(v[0] - ox, v[1] - oy) < rr_ + vreach for ox, oy, nt, rr_ in obst)
                            or any(o[3] != net and math.hypot(v[0] - o[1], v[1] - o[2]) < (max(o[4], o[5]) / 2 if len(o) > 5 and o[4] else 0.4) + vreach for o in pads)
                            or any(nt != net and _seg_dist(v, A, B) < w_ + vreach for A, B, w_, nt, ly in cu["segs"])
                            or any(nt != net and math.hypot(v[0] - vx, v[1] - vy) < max(vr_ + vr + clr, vdrill + hclr) for vx, vy, vr_, nt in cu["vias"])
                            or any(math.hypot(v[0] - x_[0], v[1] - x_[1]) < max(vd + clr, vdrill + hclr) - 1e-6 for x_ in placed_v)
                            or any(nt != net and _seg_dist(v, A, B) < vreach + tw / 2 for A, B, nt in placed_s))
            def toward_(q):
                pts = [tuple(toward)] if toward else [(x, y) for x, y, rr in where.get(q[3], []) if rr != ref]
                if not pts:
                    return 0.0
                mx, my = sum(x for x, _ in pts) / len(pts), sum(y for _, y in pts) / len(pts)
                return (mx - q[1]) * tng[0] + (my - q[2]) * tng[1]
            order_ = sorted(want, key=lambda q: s_of(q[1], q[2]))
            # the split: pins before it turn to -t, from it on to +t, with the fewest pins turned against their net
            best_k, best_bad = 0, None
            for k in range(len(order_) + 1):
                bad = sum(1 for q in order_[:k] if toward_(q) > 0) + sum(1 for q in order_[k:] if toward_(q) < 0)
                if best_bad is None or bad < best_bad:
                    best_k, best_bad = k, bad
            groups = [(order_[:best_k], -1), (order_[best_k:], 1)]
            if turn in ("cw", "ccw"):      # tng points clockwise round the chip on screen (Y down)
                groups = [(order_, 1 if turn == "cw" else -1)]
            d0 = proj + half + (first if first is not None else 0.3)
            run = length
            for grp, sg in groups:
                if not grp:
                    continue
                ss = [s_of(q[1], q[2]) for q in grp]; inner = max(ss) if sg > 0 else min(ss)
                vstep = vd + clr + 0.05                            # how much further each next lane runs before its via
                jog = max(0.0, vreach + tw / 2 - sp) + 0.01        # how far a via steps out to clear the lane beside it (copper and hole clearance)
                rank = {si: k for k, si in enumerate(sorted(ss, key=lambda x_: sg * x_))}     # 0: the lane outside the turn
                last_rl = None      # how far after its bend the last lane that took a via ran
                pt = lambda s_, d_: (cx + n[0] * d_ + tng[0] * s_, cy + n[1] * d_ + tng[1] * s_)   # noqa: E731
                far_ = max(abs(inner - x_) for x_ in ss)
                # outside lane first: each next lane runs at least one via pitch further than the last one that took a
                # via, so the vias stagger even where other copper cuts the lanes short (a lane that cannot run that far
                # ends without a via and the router carries it on, on the chip's layer)
                for q, si in sorted(zip(grp, ss), key=lambda qs: rank[qs[1]]):
                    D = d0 + T * abs(inner - si) - min(0.0, T * far_)      # the bend line; never inside the first ring
                    a, bnd = (q[1], q[2]), pt(si, D)
                    rl = max(run, last_rl + vstep) if vias and last_rl is not None else run
                    end = pt(si + sg * rl / math.sqrt(2), D + rl / math.sqrt(2))
                    path = [a, bnd, end] if rl > 0 else [a, bnd]
                    if vias and jog > 0.011:       # a short step straight out from the chip puts the via clear of the next lane
                        path.append(pt(si + sg * rl / math.sqrt(2), D + rl / math.sqrt(2) + math.sqrt(2) * jog))
                    full = len(path)
                    # a lane stops short of another part's pad or other copper in its way (a capacitor, a passing track)
                    cut = []
                    for x0, x1 in zip(path, path[1:]):
                        L_ = math.hypot(x1[0] - x0[0], x1[1] - x0[1]); steps = max(1, int(L_ / 0.05)); stop = None
                        for k in range(steps + 1):
                            t_ = k / steps; px, py = x0[0] + (x1[0] - x0[0]) * t_, x0[1] + (x1[1] - x0[1]) * t_
                            if any(nt != q[3] and math.hypot(px - ox, py - oy) < rr_ + clr + tw / 2 for ox, oy, nt, rr_ in obst) or blocked_lane(px, py, q[3]):
                                stop = max(0.0, t_ - 0.1 / max(L_, 1e-6)); break
                        if not cut:
                            cut.append(x0)
                        if stop is None:
                            cut.append(x1); continue
                        if stop > 0:
                            cut.append((x0[0] + (x1[0] - x0[0]) * stop, x0[1] + (x1[1] - x0[1]) * stop))
                        break
                    whole = len(cut) == full and math.hypot(cut[-1][0] - path[-1][0], cut[-1][1] - path[-1][1]) < 1e-6
                    path = cut
                    if len(path) < 2 or math.hypot(path[-1][0] - a[0], path[-1][1] - a[1]) < half + 0.3:
                        skipped[q[0]] = "no room: another part's pad stands in front of it"; continue
                    # the via: at the lane's end when the lane ran its whole way (cut short, it sits beside the next lane)
                    v_at = path[-1] if vias and whole and via_ok(path[-1], q[3]) else None
                    if vias and not whole and v_at is None and len(path) >= 3:
                        # cut short on its leg after the bend: step back along the leg and jog straight out from the chip
                        # to a via there, still one via pitch past the last lane's via, clear of everything
                        e0, b0 = path[-1], path[1]
                        Lg = math.hypot(e0[0] - b0[0], e0[1] - b0[1])
                        ux, uy = ((e0[0] - b0[0]) / Lg, (e0[1] - b0[1]) / Lg) if Lg > 1e-6 else (0.0, 0.0)
                        back = 0.0
                        while Lg - back > 0.2 and v_at is None:
                            e1 = (e0[0] - ux * back, e0[1] - uy * back); rl_at = Lg - back
                            if last_rl is not None and rl_at < last_rl + vstep - 1e-6:
                                break
                            j = (e1[0] + n[0] * math.sqrt(2) * jog, e1[1] + n[1] * math.sqrt(2) * jog)
                            if via_ok(j, q[3]) and not any(blocked_lane(e1[0] + (j[0] - e1[0]) * t_ / 4, e1[1] + (j[1] - e1[1]) * t_ / 4, q[3]) for t_ in range(5)):
                                path = path[:-1] + [e1, j] if back > 0 else path + [j]
                                v_at = j; rl = rl_at
                            back += 0.15
                    segs = list(zip(path, path[1:]))
                    why = ""
                    for x0, x1 in segs:
                        if any(_seg_dist((o[1], o[2]), x0, x1) < pitch / 4 + tw / 2 + clr - 1e-6 for o in pads if o[0] != q[0] and o[0]):
                            why = why or "stub by a pin"
                        if any(_segs_dist(x0, x1, c, d) < tw + clr - 1e-6 for c, d, _ in placed_s):
                            why = why or "stub by a stub"
                    if why:
                        skipped[q[0]] = "too close: " + why; continue
                    for x0, x1 in segs:
                        placed_s.append((x0, x1, q[3]))
                    if v_at is not None:
                        placed_v.append(v_at); last_rl = rl
                    plan.append((q, path, v_at))
            continue
        span = max(abs(s_of(q[1], q[2])) for q in row) + 0.3
        # rows of via sites, each row in the gaps of the one inside it; as many rows as the pin pitch needs (a 0.4 mm
        # QFN with 0.45 mm vias takes three, as the person's Cyberboard does), the first row 1.3 mm out like theirs
        P = vd + 2 * clr + tw + 0.05
        nrows = rows or max(2, math.ceil(P / max(pitch, 0.1) - 1e-6))
        step_s = P / nrows
        gap = max(vd + clr, math.sqrt(max(0.0, (vd + clr) ** 2 - step_s ** 2)) + vd / 2)
        d1 = max(half + clr + vr + 0.15, first or 0.0)
        sites = []
        j = -int(span / P) - 1
        while j * P <= span + P:
            for k in range(nrows):
                s_, d_ = j * P + k * step_s, d1 + k * gap
                if abs(s_) <= span:
                    sites.append((s_, d_))
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
        if style == "radial":
            # the person's Cyberboard escape: each via straight out from its own pin (no sideways jog), the rows
            # 1.3 mm and further out, a pin next to another diving pin going one row further so the vias stagger
            pairs = []; last = []   # (tangent, row) of the pins placed so far on this side
            rowgap = vd + clr
            for q in want:
                si = s_of(q[1], q[2])
                busy = {k for (t, k) in last if abs(t - si) < vd + clr + 0.05}
                k = next((k for k in range(nrows) if k not in busy), None)
                if k is None:
                    skipped[q[0]] = "no via site"
                    continue
                last.append((si, k))
                pairs.append((q, (si, max(d1, 1.3) + k * rowgap)))
        for q, (s, d) in sorted(pairs, key=lambda pq: pq[1][1]):   # inner row first
            si = s_of(q[1], q[2]); dev = s - si
            base = (q[1] - cx) * n[0] + (q[2] - cy) * n[1]
            pt = lambda s_, d_: (cx + n[0] * (proj + d_) + tng[0] * s_, cy + n[1] * (proj + d_) + tng[1] * s_)   # noqa: E731
            exit_ = pt(si, half + 0.05 + (proj - base))
            v = pt(s, d); bend = pt(si, d - abs(dev)) if abs(dev) > 1e-3 else v
            path = [(q[1], q[2]), exit_, bend, v] if abs(dev) > 1e-3 else [(q[1], q[2]), exit_, v]
            segs = list(zip(path[1:], path[2:]))
            why = ""
            for (x, y) in [v]:
                if any(math.hypot(x - a[0], y - a[1]) < 2 * vr + clr - 1e-6 for a in placed_v):
                    why = why or "via by a via"
                if any(math.hypot(x - o[0], y - o[1]) < vr + clr + 0.3 for o in others):
                    why = why or "via by another part's pad"
                if any(math.hypot(x - o[1], y - o[2]) < vr + clr + 0.15 for o in pads if o[0] != q[0]):
                    why = why or "via by a pin"
                if any(_seg_dist((x, y), a, b) < vr + tw / 2 + clr - 1e-6 for a, b, _ in placed_s):
                    why = why or "via by a stub"
            for a, b in segs:
                if any(_seg_dist(c, a, b) < vr + tw / 2 + clr - 1e-6 for c in placed_v):
                    why = why or "stub by a via"
                if any(_segs_dist(a, b, c, d) < tw + clr - 1e-6 for c, d, _ in placed_s):
                    why = why or "stub by a stub"
                if any(_seg_dist((o[1], o[2]), a, b) < pitch / 4 + tw / 2 + clr - 1e-6 for o in pads if o[0] != q[0] and o[0]):
                    why = why or "stub by a pin"
            if why:
                skipped[q[0]] = "too close: " + why
                continue
            placed_v.append(v)
            for a, b in segs:
                placed_s.append((a, b, q[3]))
            plan.append((q, path, v))
    if apply and plan:
        # on a board that already has copper a stub or via can land on another net's track: each pin's escape is laid,
        # the rules checked, and any escape a new error sits on is taken out again, so fanout never adds a DRC error
        before = {(v["code"], round(v["x"], 2), round(v["y"], 2)) for v in self._call("run_checks").get("violations", []) if v.get("severity") == "error"}
        laid = []
        for q, path, v in plan:
            self.track(q[3], [[round(x, 4), round(y, 4)] for x, y in path], layer="F.Cu" if part.get("side", "front") == "front" else "B.Cu", width=tw)
            if v is not None:
                self.via(q[3], [round(v[0], 4), round(v[1], 4)], size=via[0] if via else None, drill=via[1] if via else None)
            res = self.flush() or {}
            laid.append((q, path, list(res.get("added") or [])))
        # each new error is blamed on the one escape nearest to it (not on every escape within reach: one lane that
        # runs into a track would otherwise take its whole bus back); a blamed escape is first cut back to the
        # straight stub out of its pad, and taken back only when the stub alone still breaks a rule
        lay_layer = "F.Cu" if part.get("side", "front") == "front" else "B.Cu"
        gone, short, cutback = {}, set(), {}
        for _round in range(4):
            with contextlib.suppress(Exception):
                self.fill()          # a pour filled before the escapes were drawn would sit on them: refill, then judge
            blame = {}
            for e in self._call("run_checks").get("violations", []):
                if e.get("severity") != "error" or e.get("code") in ("unconnected_items", "track_right_angle") or (e["code"], round(e["x"], 2), round(e["y"], 2)) in before:
                    continue
                best_i, best_d = None, 0.6
                for i, (q, path, _) in enumerate(laid):
                    if i in gone:
                        continue
                    d = min([_seg_dist((e["x"], e["y"]), a, b) for a, b in zip(path, path[1:])]
                            + ([math.hypot(e["x"] - plan[i][2][0], e["y"] - plan[i][2][1])] if plan[i][2] is not None else []))
                    if d < best_d:
                        best_i, best_d = i, d
                if best_i is not None:
                    blame.setdefault(best_i, (e.get("message") or e.get("code") or "")[:120] + (f" {e.get('refs')}" if e.get("refs") else "") + f" at ({round(e['x'], 2)}, {round(e['y'], 2)})")
            if not blame:
                break
            for i, why in blame.items():
                q, path, items = laid[i]
                for item in items:
                    self._edit({"op": "remove", "id": item})
                stub = path[:2]
                if plan[i][2] is not None:      # first the via alone goes: the lane stays for the router to carry on
                    self.track(q[3], [[round(x, 4), round(y, 4)] for x, y in path], layer=lay_layer, width=tw)
                    res = self.flush() or {}
                    laid[i] = (q, path, list(res.get("added") or []))
                    plan[i] = (q, path, None)
                    cutback[q[0]] = "via dropped: " + why
                elif i not in short and (len(path) > 2 or plan[i][2] is not None) and math.hypot(stub[1][0] - stub[0][0], stub[1][1] - stub[0][1]) >= half + 0.3:
                    self.track(q[3], [[round(x, 4), round(y, 4)] for x, y in stub], layer=lay_layer, width=tw)
                    res = self.flush() or {}
                    laid[i] = (q, stub, list(res.get("added") or []))
                    plan[i] = (q, stub, None)
                    short.add(i); cutback[q[0]] = why
                else:
                    gone[i] = why
                    skipped[q[0]] = "taken back: " + why
            self.flush()
        else:
            for i, (q, path, items) in enumerate(laid):      # still breaking a rule after four rounds: take back every shortened one
                if i in short and i not in gone:
                    for item in items:
                        self._edit({"op": "remove", "id": item})
                    gone[i] = "taken back: still breaks a rule when cut back"; skipped[q[0]] = gone[i]
            self.flush()
        plan = [p for i, p in enumerate(plan) if i not in gone]
        if plan:
            self.project.note(f"board: fanned out {ref}: {len(plan)} pins " + ("as a bus of stubs" if style == "bus" else "to a staggered via ring"))
    return {"vias": sum(1 for p in plan if p[2] is not None), "stubs": len(plan), "pins": sorted((q[0] for q, _, _ in plan), key=lambda x: (len(x), x)), "skipped": skipped,
            **({"cut_back": cutback} if apply and plan and cutback else {})}


_GROUNDISH = re.compile(r"^/?(A|D|P)?(GND|VSS)\w*$", re.I)
_NO_FAN = re.compile(r"(^|[/_(-])(RF\w*|ANT\w*|XIN|XOUT|HXIN|HXOUT|LXIN|LXOUT|OSC\w*|XTAL\w*|XI|XO)\)?$", re.I)      # antenna feeds and crystal lines: no via, no fan-out
_CC = re.compile(r"(^|[-_(/])CC[12]?\b", re.I)      # a USB-C CC line: no via (review usb.cc), unless escape_chips(cc_vias=True)


def _standing(self) -> tuple:
    """(open connections, rules errors other than open ones) with the pours filled: what a keep-best step is judged by."""
    with contextlib.suppress(HarnessError):
        self.fill()
    by = (self.check(limit=0, refill=False) or {}).get("by_kind") or {}
    return (int(self.info().get("unrouted_connections") or 0), sum(v for k, v in by.items() if k != "unconnected_items"))


def _chip_frame(part: dict):
    """A fine-pitch chip's frame: (centre, the four outward normals, {side: [pads]}, pitch) or None when the part is
    not one (fewer than 20 connected pads, or a pitch coarser than 0.65 mm)."""
    pads = [q for q in part["pads"] if q[0]]
    if len([q for q in pads if q[3]]) < 20:
        return None
    cx, cy, rot = float(part["x"]), float(part["y"]), math.radians(-float(part["rotation"] or 0))
    normals = [(math.cos(rot + k * math.pi / 2), math.sin(rot + k * math.pi / 2)) for k in range(4)]
    sides: dict = {}
    for q in pads:
        dx, dy = q[1] - cx, q[2] - cy
        if math.hypot(dx, dy) < 0.5:
            continue
        k = max(range(4), key=lambda i: dx * normals[i][0] + dy * normals[i][1])
        sides.setdefault(k, []).append(q)
    rows = {}
    for k, side in sides.items():      # the outer pin row of each side (an exposed pad or a middle pad is not in it)
        n = normals[k]
        proj = max((q[1] - cx) * n[0] + (q[2] - cy) * n[1] for q in side)
        rows[k] = [q for q in side if (q[1] - cx) * n[0] + (q[2] - cy) * n[1] > proj - 0.2]
    gaps = []
    for row in rows.values():
        k_ = sorted(row, key=lambda q: (q[1], q[2]))
        gaps += [d_ for a, b in zip(k_, k_[1:]) for d_ in [math.hypot(a[1] - b[1], a[2] - b[2])] if d_ > 0.05]
    pitch = min(gaps, default=1.0)
    if pitch > 0.65 or not rows:
        return None
    return (cx, cy), normals, rows, pitch


def _escape_chips(self, refs: list | None = None, time_s: float = 40, layers: list | None = None, keep_rules: bool = True,
                  budget_s: float | None = None, recipes: list | None = None, band: float = 2.5, log=None, sideways: int = 3, cc_vias: bool = False) -> dict:
    """Escape the pins of a fine-pitch chip that routing left boxed in, the way the AI's hand-routed boards do it (the
    person's Cyberboard U4 dogbone ring, the AI's Ember U9 buses), as a keep-best repair after the routing.

    For each fine-pitch chip (20 connected pins or more, 0.65 mm pitch or finer) that still has a pin open, side by side
    (the side with the most open pins first), the recipes in order, the least disturbance first:
    - "dogbone": each open pin gets a stub straight out (or a 45-degree leg) to a via at the spot within `band` mm of
      its pad where the fewest other tracks stand in the way (board.fits judges each spot); only those come up; with
      several open pins on the side, all at once first, then each pin alone (one pin's via can take another's room);
    - "dogbone ring": the same, and the two far-going neighbours either side of each open pin are dropped to staggered
      vias too (the person's Cyberboard U4);
    - a fan-out dict (board.fanout options): the copper in the band in front of the side (every net but ground: the
      chip's escapes and whatever runs across them) comes up and the side's far-going pins get that fan-out; the
      default is a bus on the chip's layer turned towards where its nets go with a staggered via at each lane end (the
      AI's Ember U9); {"style": "bus", "vias": True, "turn": "cw"} or {"style": "radial"} can be added;
    - None: the same clean band with no fan-out (the router's own escapes, now with room).
    Every net that came up is routed again, the open ones first.  Pins whose net stays close (a crystal, a decoupling
    capacitor) keep their pads, ground copper is never moved, and a lane stops short of other parts' pads and copper,
    so the sides facing a crystal, the USB pair or an RF feed keep those routes.  Each try runs inside board.trial()
    and stays only when fewer connections are open (at the same count, fewer rules errors); the first that helps on a
    side is kept and the next side is tried.  sideways=3 also keeps up to that many tries that leave as many open and
    no more errors but other pins open (never a set of open nets seen before), so the next try can work on the pins
    the blockage moved to; the board never ends worse than it started.

    A USB-C CC line gets no via (the review's usb.cc) unless cc_vias=True; design(reroute=True) passes it, since on
    the person's placement that is only a note and an open connection is worse.
    budget_s stops starting new tries after that many seconds.  Returns {"before": n, "after": n, "tried": [one line
    per try], "kept": [...]}."""
    import time as _t
    t0 = _t.time()
    if recipes is None:
        # measured on the benchmark's routed Cyberboard and Ember: only the dogbones ever closed a connection there; the
        # bus turned towards the nets is kept as the one fan-out try (turned cw / ccw and the radial ring did worse on
        # every side, 6 -> 7 to 14 open), the clean band with no fan-out last
        recipes = ["dogbone", "dogbone ring", {"style": "bus", "vias": True, "length": 0.6}, None]
    rules = (self.project.transport.call("get_board_info", {}).get("design_rules") or {})
    vmin = float(rules.get("min_via_diameter") or 0)
    start = best = _standing(self)
    tried, kept = [], []
    parts = {p["ref"]: p for p in self.geometry()["parts"]}
    chips = {}
    for ref, part in parts.items():
        if refs and ref not in refs:
            continue
        fr = _chip_frame(part)
        if fr:
            chips[ref] = fr
    done = set()
    seen = {frozenset(self.unrouted())}      # the sets of open nets the board has been through
    while chips and (budget_s is None or _t.time() - t0 < budget_s):
        # what is open now, pin by pin, on a chip's outer rows
        left = {}
        for v in self._call("run_checks").get("violations", []):
            if v.get("code") != "unconnected_items":
                continue
            m = re.search(r"net '((?:[^'\\]|\\.)*)'", v.get("message", ""))
            if m:
                left[m.group(1)] = left.get(m.group(1), set()) | set(v.get("refs") or [])
        work = []
        for ref, (c, normals, rows, pitch) in chips.items():
            for k, row in rows.items():
                pins = [q for q in row if q[3] in left and ref in left[q[3]] and not _GROUNDISH.match(q[3]) and not _NO_FAN.search(q[3])
                        and (cc_vias or not _CC.search(q[3]))]
                if pins and (ref, k, frozenset(q[0] for q in pins)) not in done:
                    work.append((len(pins), ref, k, pins))
        if not work:
            break
        work.sort(key=lambda w: -w[0])
        _, ref, k, pins = work[0]
        done.add((ref, k, frozenset(q[0] for q in pins)))
        c, normals, rows, pitch = chips[ref]
        n = normals[k]; tng = (-n[1], n[0]); row = rows[k]
        proj = max((q[1] - c[0]) * n[0] + (q[2] - c[1]) * n[1] for q in row)
        half = max(max(q[4], q[5]) / 2 if len(q) > 5 and q[4] else 0.4 for q in row)
        ss = [(q[1] - c[0]) * tng[0] + (q[2] - c[1]) * tng[1] for q in row]
        lo, hi = min(ss) - 0.6, max(ss) + 0.6
        d_lo, d_hi = proj - half - 0.1, proj + half + band

        def in_band(x, y):
            dx, dy = x - c[0], y - c[1]
            d, s = dx * n[0] + dy * n[1], dx * tng[0] + dy * tng[1]
            return d_lo <= d <= d_hi and lo - (d - proj) <= s <= hi + (d - proj)      # widening outwards at 45 degrees

        side_nets = sorted({q[3] for q in row if q[3] and not _GROUNDISH.match(q[3]) and not _sup_name(q[3]) and not q[3].startswith("unconnected-")
                            and not _NO_FAN.search(q[3]) and (cc_vias or not _CC.search(q[3]))})
        open_nets = [q[3] for q in pins]
        side_step = None      # the first try that left as many open (no more errors) but other pins open
        # a dogbone for all the side's open pins at once, then (when there are several) for each alone: one pin's via
        # can take the room another one needed
        plan_ = []
        for r_ in recipes:
            plan_.append((r_, False, None))
            if r_ == "dogbone" and len(pins) > 1:
                plan_ += [(r_, False, q) for q in pins]
        i_ = 0
        while i_ < len(plan_):
            rec, again, only = plan_[i_]; i_ += 1
            if budget_s is not None and _t.time() - t0 > budget_s:
                tried.append(f"{ref} side {k}: budget spent")
                break
            t1 = _t.time()
            try:
                with self.trial() as tr:
                    taken = set(open_nets)
                    fo = None
                    if rec in ("dogbone", "dogbone ring"):
                        # the least disturbance first: each open pin gets a stub straight out (or a 45-degree leg) to a via at
                        # the nearest spot where moving the fewest other tracks makes it legal; only those come up.  "dogbone
                        # ring" also drops the two far-going neighbours on either side of each open pin to staggered vias
                        # (their escapes near the chip come up first), the person's Cyberboard U4 ring
                        todo = [only] if only is not None else list(pins)
                        if rec == "dogbone ring":
                            srt = sorted(row, key=lambda q: (q[1] - c[0]) * tng[0] + (q[2] - c[1]) * tng[1])
                            idx = {q[0]: i for i, q in enumerate(srt)}
                            for q in pins:
                                for j in (-2, -1, 1, 2):
                                    o = srt[idx[q[0]] + j] if 0 <= idx[q[0]] + j < len(srt) else None
                                    if o and o[3] and o[3] in side_nets and not o[3].startswith("unconnected-") and o not in todo:
                                        todo.append(o)
                            for o in todo[len(pins):]:
                                for it in self.whats_at((o[1], o[2]), radius=half + band):
                                    if it["kind"] in ("segment", "arc", "via") and it.get("net") == o[3]:
                                        with contextlib.suppress(HarnessError):
                                            self._edit({"op": "remove", "id": it["id"]})
                                taken.add(o[3])
                            self.flush()
                        fo = _dogbones(self, chip=parts[ref], c=c, n=n, tng=tng, pins=todo, half=half, band=band, rules=rules, taken=taken, ordered=True)
                        name = rec + (f" {ref}.{only[0]} alone" if only is not None else "")
                    else:
                        for it in self.whats_at(c, radius=proj + half + band + 2.0):
                            if it["kind"] not in ("segment", "arc", "via") or not it.get("net") or _GROUNDISH.match(it["net"]):
                                continue
                            pts = [it["at"]] if it["kind"] == "via" else [it["start"], it["end"]]
                            if it["kind"] != "via":
                                a, b = it["start"], it["end"]; L = math.hypot(b[0] - a[0], b[1] - a[1]); m_ = max(1, int(L / 0.2))
                                pts = [(a[0] + (b[0] - a[0]) * i / m_, a[1] + (b[1] - a[1]) * i / m_) for i in range(m_ + 1)]
                            if any(in_band(x, y) for x, y in pts):
                                with contextlib.suppress(HarnessError):
                                    self._edit({"op": "remove", "id": it["id"]}); taken.add(it["net"])
                        self.flush()
                        if rec is not None:
                            opts = dict(rec)
                            if opts.get("vias") and "via" not in opts and vmin and vmin <= 0.4 + 1e-9:
                                opts["via"] = (0.4, max(0.2, float(rules.get("min_via_drill") or 0.2)))     # what fits beside 0.4 mm pitch lanes
                            with contextlib.suppress(HarnessError):
                                fo = self.fanout(ref, nets=[q[3] for q in row if q[3] in side_nets], **opts)
                        name = "band cleared, no fan-out" if rec is None else "band cleared, " + ",".join(f"{a}={b}" for a, b in rec.items())
                    with contextlib.suppress(HarnessError):
                        self.route(nets=sorted(taken), order=open_nets, fill=False, time_s=time_s, keep_rules=keep_rules, layers=layers, ground_vias=False)
                    now = _standing(self)
                    tr.keep = now[0] < best[0] or (now[0] == best[0] and now[1] < best[1])
                    if not tr.keep and sideways > 0 and now[0] == best[0] and now[1] <= best[1]:
                        # as many open, no more errors, but other pins open now: a sideways step (a few at most, never
                        # back to a set of open nets seen before) lets the next try work on the pins it moved the blockage
                        # to.  Taken only when no recipe on this side does better: the try is laid again after the others
                        shape = frozenset(self.unrouted())
                        if shape not in seen:
                            if again:
                                seen.add(shape); sideways -= 1; tr.keep = True
                            elif side_step is None:
                                side_step = (rec, only)
                    tried.append(f"{ref} side {k} ({len(pins)} open, {len(taken)} nets taken up) {name}: "
                                 f"{(fo or {}).get('stubs', 0)} escapes, {(fo or {}).get('vias', 0)} vias; open {best[0]} -> {now[0]}, errors {best[1]} -> {now[1]} ({round(_t.time() - t1)} s)")
                    if log:
                        log(tried[-1])

            except Exception as e:      # noqa: BLE001  one try that fails is taken back by the trial; the next one still runs
                tried.append(f"{ref} side {k} {rec}: failed, taken back ({type(e).__name__}: {str(e)[:120]})")
                if log:
                    log(tried[-1])
                continue
            if tr.keep:
                kept.append(tried[-1]); best = now
                break
            if i_ == len(plan_) and side_step is not None and not again:
                plan_.append((side_step[0], True, side_step[1]))
    self.project.note(f"board: escaped boxed-in chip pins, open connections {start[0]} -> {best[0]}")
    return {"before": start[0], "after": best[0], "tried": tried, "kept": kept}


def _dogbones(self, chip: dict, c, n, tng, pins: list, half: float, band: float, rules: dict, taken: set, ordered: bool = False) -> dict:
    """A dogbone for each boxed-in pin of one side of a fine-pitch chip, as the person's Cyberboard U4 has them: a stub
    straight out of the pad (or out past the pad tip and on at 45 degrees either way) to a via, at the spot from 0.5 mm
    past the pad to `band` mm out where the fewest other tracks and vias stand in the way (board.fits judges each spot
    by the real rules: copper and hole clearance, by net class).  A spot blocked by a pad or by ground copper is never
    taken.  The copper in the way comes up and its nets are added to `taken`, for the caller to route again."""
    layer = "F.Cu" if chip.get("side", "front") == "front" else "B.Cu"
    nc = (rules.get("net_classes") or {}).get("Default") or {}
    tw = min(0.15, float(nc.get("track_width") or 0.2))
    out = {"vias": 0, "stubs": 0, "removed": 0, "skipped": {}}
    for q in (pins if ordered else sorted(pins, key=lambda q: (q[1] - c[0]) * tng[0] + (q[2] - c[1]) * tng[1])):
        p = (q[1], q[2]); net = q[3]
        tip = half + 0.15
        exit_ = (p[0] + n[0] * tip, p[1] + n[1] * tip)
        best = None
        d = half + 0.5
        while d <= half + band + 1e-9:
            L = d - tip
            shapes = [[p, (p[0] + n[0] * d, p[1] + n[1] * d)]]
            for sg in (1, -1):
                shapes.append([p, exit_, (exit_[0] + (n[0] + sg * tng[0]) * L / math.sqrt(2), exit_[1] + (n[1] + sg * tng[1]) * L / math.sqrt(2))])
            for pts in shapes:
                v = pts[-1]
                try:
                    blk = (self.fits(net, via=v).get("blocked_by") or []) + (self.fits(net, track=list(pts), layer=layer, width=tw).get("blocked_by") or [])
                except HarnessError:
                    continue
                if any(b_.get("kind") not in ("segment", "arc", "via") or _GROUNDISH.match(b_.get("net") or "") or b_.get("net") == net for b_ in blk):
                    continue
                ids = {b_["id"]: b_.get("net") for b_ in blk}
                cost = len(ids) + 0.2 * d + (0.05 if len(pts) > 2 else 0.0)
                if best is None or cost < best[0]:
                    best = (cost, pts, ids)
            if best is not None and best[0] < 1:      # a free spot: nothing nearer can be cheaper by much
                break
            d += 0.15
        if best is None:
            out["skipped"][q[0]] = "no spot without a pad or ground copper in the way"
            continue
        _, pts, ids = best
        for i, nt in ids.items():
            with contextlib.suppress(HarnessError):
                self._edit({"op": "remove", "id": i})
            taken.add(nt)
        out["removed"] += len(ids)
        self.flush()
        self.track(net, [[round(x, 4), round(y, 4)] for x, y in pts], layer=layer, width=tw)
        self.via(net, [round(pts[-1][0], 4), round(pts[-1][1], 4)])
        self.flush()
        out["vias"] += 1; out["stubs"] += 1
    return out


# ---------------------------------------------------------------- the routing AI's own plan for a crowded chip

def _channels(self, ref: str | None = None, box=None, depths=None, plan=None, margin: float = 4.0, layers: list | None = None) -> dict:
    """Read the routing problem round a chip before writing a plan for it (nothing is laid; a few seconds).

    For each pin row (side N, E, S, W, or NE, SE, SW, NW on a chip turned 45 degrees) of `ref`: its pins ("12 GPIO20*": pad, net, * where a connection from it is open,
    - for no net); per routing layer, at each depth past the pads (0.3, 1, 2, 3 mm by default), how many tracks of
    the board's usual width still cross a line parallel to the row ("1mm 4": four fit; the gaps are the router's own
    free cells) and whose copper lies on that line ("GPIO21 2" crosses it twice; "U4 pads" are the chip's own pads);
    and how many vias still fit in front of the row.  Then every open connection with an end within `margin` mm of
    the chip, with the global plan's coarse path for it (corners and layer changes: "F(120.25,40.75) B(...)") and the
    plan's overflow on it, and the tile borders the plan still overflows there ("hot": layer, where, by how many mm,
    the nets on it).  box=[x0, y0, x1, y1] looks at an area instead of a chip.

    plan={"paths": {...}} previews a plan you wrote (as board.route(plan=...) takes it): the plan is negotiated round
    your paths and the open list and "hot" show what is left, so a plan can be tried in seconds before the route
    that takes minutes.  Use it to find the side whose channel is full (0 tracks at 1 mm while pins there are open)
    and the nets in it, then write paths that send the crowded nets out where there is room."""
    self.flush()
    view: dict = {}
    if ref:
        view["ref"] = ref
    if box:
        view["box"] = [float(v) for v in box]
    if depths:
        view["depths"] = [float(d) for d in depths]
    if margin is not None:
        view["margin"] = float(margin)
    e: dict = {"op": "autoroute", "view": view, "time_s": 5}
    if layers:
        e["layers"] = list(layers)
    p = _plan_for_engine(self, plan if isinstance(plan, dict) else {}) if plan is not False else None
    e["plan"] = p if p else True
    self._edit(e)
    try:
        res = self.flush() or {}
    except HarnessError as err:
        raise HarnessError(f"channels: {str(err).split('(autoroute): ')[-1][:300]}") from err
    d = next((x["autoroute"] for x in res.get("details") or [] if "autoroute" in x), {})
    v = d.get("view") or {}
    out: dict = {}
    if ref:
        out["chip"] = ref
    out["box"] = v.get("box")
    sides = {}
    for sd in v.get("sides") or []:
        pins = " ".join(f"{p[0]} {p[1] or '-'}{'*' if p[2] else ''}" for p in sd.get("pins") or [])
        free = {}
        for layer, rows in (sd.get("channels") or {}).items():
            parts = []
            for dep, tracks, _mm, nets in rows:
                who = ", ".join(f"{n} {c}" if c > 1 else n for n, c in sorted(nets.items(), key=lambda kv: -kv[1])[:6])
                parts.append(f"{dep:g}mm {tracks}" + (f" ({who})" if who else ""))
            free[layer] = "; ".join(parts)
        key = sd["side"] if sd["side"] not in sides else sd["side"] + "2"
        sides[key] = {"layer": sd.get("layer"), "pitch": sd.get("pitch"), "pins": pins, "free_tracks": free, "via_sites": sd.get("viaSites")}
    if sides:
        out["sides"] = sides
    short = lambda l: (l or "")[:1] if l in ("F.Cu", "B.Cu") else (l or "").replace(".Cu", "")      # noqa: E731
    out["open"] = [f"{o['net']}: {o['from']} -> {o['to']} {o['mm']}mm" + (" plan " + " ".join(f"{short(q[2])}({q[0]:g},{q[1]:g})" for q in o["plan"]) if o.get("plan") else "")
                   + (f" over {o['over']}mm" if o.get("over") else "") for o in v.get("open") or []]
    if v.get("hot"):      # the overflowing borders, one line per layer and set of nets (a run of tiles is one line)
        groups: dict = {}
        for h in v["hot"]:
            g = groups.setdefault((h["layer"], ",".join(h["nets"][:5])), [0.0, []])
            g[0] = max(g[0], h["over"])
            g[1].append(h["at"])
        out["hot"] = [f"{layer} {nets or '(vias)'} +{over}mm at " + (f"({pts[0][0]:g},{pts[0][1]:g})" if len(pts) == 1 else
                      f"({min(q[0] for q in pts):g}..{max(q[0] for q in pts):g}, {min(q[1] for q in pts):g}..{max(q[1] for q in pts):g})")
                      for (layer, nets), (over, pts) in groups.items()]
    out["plan_overflow_mm"] = v.get("overflow")
    pl = d.get("plan") or {}
    if pl.get("given") or pl.get("given_missed"):
        out["your_paths"] = {"used": pl.get("given") or 0, **({"not_used": pl["given_missed"]} if pl.get("given_missed") else {})}
    return out


def _plan_for_engine(self, plan: dict) -> dict:
    """board.route()'s plan dict as the engine takes it: net names fixed, points as [x, y, layer]; "order" and
    "escapes" are the harness's and are taken out by the caller."""
    p = {k: v for k, v in plan.items() if k not in ("order", "escapes")}
    if p.get("paths"):
        paths = {}
        for net, lists in p["paths"].items():
            if lists and isinstance(lists[0], (list, tuple)) and lists[0] and not isinstance(lists[0][0], (list, tuple)):
                lists = [lists]      # one path given bare
            paths[self._net(net)] = [[[float(q[0]), float(q[1]), str(q[2]) if len(q) > 2 else "F.Cu"] for q in pts] for pts in lists]
        p["paths"] = paths
    return p


_D = math.sqrt(0.5)
_COMPASS = {"N": (0.0, -1.0), "S": (0.0, 1.0), "E": (1.0, 0.0), "W": (-1.0, 0.0), "NE": (_D, -_D), "SE": (_D, _D), "SW": (-_D, _D), "NW": (-_D, -_D)}


def _side_of(n) -> str:
    """The way a pin row faces (y down), one of eight as board.channels names it: a chip turned 45 degrees has NE,
    SE, SW and NW sides."""
    return ["E", "SE", "S", "SW", "W", "NW", "N", "NE"][round(math.atan2(n[1], n[0]) / (math.pi / 4)) % 8]


def _escape(self, spec: dict, width: float | None = None) -> dict:
    """Lay the escapes you chose for a chip's pins before routing: which way each pin leaves.

    spec: {"U4.12": "via 1.2", "U4.13": "via 0.6", "U4.14": "out 0.8", "U4.15": "via 1.0 E", "U4:S": "via stagger"}
    - "via D": a stub straight out of the pad to a via D mm past the pad's end (default 0.6), or where that is blocked a
      45-degree leg either way to the via (a dogbone); the net then goes on from the via on any layer;
    - "thin" after either: straight out only, on a 0.1 mm stub (what passes beside a neighbour's via at 0.4 mm pitch),
      as a side rule lays each pin;
    - "clear" after either: where no spot is free, the one with the fewest tracks and vias of other nets in the way is
      taken and those come up (their nets are listed in "moved" and board.route(plan=...) lays them again);
    - "out D": a stub straight out on the chip's layer, D mm past the pad (default 0.5), no via;
    - a compass direction (N, E, S, W, NE, SE, SW, NW) across the pad after either bends the stub 45 degrees that way after the pad (a dogbone leg);
    - {"to": [x, y], "via": true}: a stub from the pad to that point (a via there with "via");
    - "U4:S" (a whole side, named as board.channels names it): "via stagger" gives every pin of that side whose net leaves the chip area and is
      still open a via, in two staggered rows (0.5 and 1.1 mm past the pads; "via stagger3" adds a row at 1.7), the
      person's dogbone ring; "out" a stub each.
    - "small" after any of them: the via is 0.4 on 0.2 mm where the rules allow it (what fits beside a 0.4 mm pitch
      row: the AI's Ember U9 ring), not the net class's.
    Each escape is checked against the rules first (board.fits); a spot that does not fit is moved out 0.15 mm at a
    time (up to 1 mm), and a pin with no legal spot is skipped and named with what is in the way.  Ground and supply
    pins are never escaped by a side rule.  Returns {"laid": n, "skipped": {pin: why}, "moved": [nets taken up]}.  Lay them after taking up the
    copper round the chip (board.unroute(near="U4", attached=True)) and before board.route; board.route(plan=
    {"escapes": spec, ...}) does both in one call."""
    rules = (self.project.transport.call("get_board_info", {}).get("design_rules") or {})
    nc = (rules.get("net_classes") or {}).get("Default") or {}
    tw = width or min(0.15, float(nc.get("track_width") or 0.2))
    parts = {p["ref"]: p for p in self.geometry()["parts"]}
    open_nets = set(self.unrouted())
    jobs = []      # (ref, pad, n, kind, depth, turn, to)
    clear = set()      # pins whose escape may take up the tracks and vias in its way (their nets go in out["moved"])
    small = set()      # pins whose via is the smallest that fits a 0.4 mm pitch row (0.4 / 0.2 mm) where the rules allow it
    vmin, dmin = float(rules.get("min_via_diameter") or 0), float(rules.get("min_via_drill") or 0)
    small_via = (max(0.4, vmin), max(0.2, dmin)) if vmin <= 0.4 + 1e-9 and float(nc.get("via_diameter") or 0) > 0.4 + 1e-9 else None
    for key, val in spec.items():
        if ":" in key:
            ref, side = key.split(":", 1)
            part = parts.get(ref)
            fr = _chip_frame(part) if part else None
            if not fr:
                raise HarnessError(f"escape: {ref} is not a fine-pitch chip (20 pins or more, 0.65 mm pitch or finer)")
            c, normals, rows, pitch = fr
            words = str(val).split()
            for k, row in rows.items():
                if _side_of(normals[k]) != side.upper():
                    continue
                srt = sorted(row, key=lambda q: (q[1] - c[0]) * -normals[k][1] + (q[2] - c[1]) * normals[k][0])
                deps = [0.5, 1.1, 1.7] if "stagger3" in words else [0.5, 1.1]
                j = 0
                for q in srt:
                    net = q[3]
                    if not net or net.startswith("unconnected-") or _GROUNDISH.match(net) or _sup_name(net) or _NO_FAN.search(net) or net not in open_nets:
                        j += 1
                        continue
                    kind = "out" if words and words[0] == "out" else "via"
                    if "small" in words:
                        small.add(f"{ref}.{q[0]}")
                    dep = deps[j % len(deps)] if "stagger" in str(val) else (float(words[1]) if len(words) > 1 and _isnum(words[1]) else (0.6 if kind == "via" else 0.5))
                    jobs.append((ref, q, normals[k], kind, dep, "thin", None))
                    j += 1
            continue
        ref, _, num = key.partition(".")
        part = parts.get(ref)
        if not part:
            raise HarnessError(f"escape: there is no part {ref}")
        q = next((q for q in part["pads"] if str(q[0]) == num), None)
        if not q:
            raise HarnessError(f"escape: {ref} has no pad {num}")
        fr = _chip_frame(part)
        if fr:
            c, normals, rows, _ = fr
            n = next((normals[k] for k, row in rows.items() if any(r[0] == q[0] for r in row)), None)
        else:
            n = None
        if n is None:      # not a fine-pitch chip: out along the pad's long side, away from the part's middle
            dx, dy = q[1] - float(part["x"]), q[2] - float(part["y"])
            if len(q) > 5 and q[4] and abs(q[4] - q[5]) > 1e-6:
                a = math.radians(-(float(q[6]) if len(q) > 6 and q[6] else 0.0)) + (0.0 if q[4] > q[5] else math.pi / 2)
                ax = (math.cos(a), math.sin(a))
                sg = 1.0 if dx * ax[0] + dy * ax[1] >= 0 else -1.0
                n = (sg * ax[0], sg * ax[1])
            else:
                L = math.hypot(dx, dy) or 1.0
                n = (dx / L, dy / L)
        if isinstance(val, dict):
            jobs.append((ref, q, n, "via" if val.get("via") else "out", 0.0, None, val.get("to")))
            continue
        words = str(val).split()
        kind = words[0] if words and words[0] in ("via", "out") else "via"
        dep = next((float(w) for w in words[1:] if _isnum(w)), 0.6 if kind == "via" else 0.5)
        turn = next((w.upper() for w in words[1:] if w.upper() in _COMPASS), "thin" if "thin" in words else None)
        if "clear" in words:
            clear.add(f"{ref}.{q[0]}")
        if "small" in words:
            small.add(f"{ref}.{q[0]}")
        jobs.append((ref, q, n, kind, dep, turn, None))
    out = {"laid": 0, "skipped": {}, "moved": []}
    thin = max(0.1, float(rules.get("min_track_width") or 0))
    before = {it["id"] for it in self._all_items(["segment", "arc", "via"])} if clear else set()      # "clear" never takes up an escape of this call
    for ref, q, n, kind, dep, turn, to in jobs:
        w_ = min(tw, thin) if turn == "thin" else tw      # a stub that runs beside a staggered via at 0.4 mm pitch: 0.1 mm where the rules allow (0.12 falls 0.01 mm short of a 0.2 mm drill hole clearance)
        side_job = turn == "thin"
        turn = None if side_job else turn
        layer = "F.Cu" if parts[ref].get("side", "front") == "front" else "B.Cu"
        p = (q[1], q[2]); net = q[3]
        half = (max(q[4], q[5]) / 2) if len(q) > 5 and q[4] else 0.4
        pin = f"{ref}.{q[0]}"
        if not net:
            out["skipped"][pin] = "no net"
            continue
        tries = []
        if to is not None:
            tries.append([p, (float(to[0]), float(to[1]))])
        else:
            for extra in (0.0, 0.15, 0.3, 0.45, 0.6, 0.8, 1.0):
                d = dep + extra
                if turn:
                    u = _COMPASS[turn]
                    exit_ = (p[0] + n[0] * (half + 0.15), p[1] + n[1] * (half + 0.15))
                    L = max(0.1, d - 0.15)
                    tries.append([p, exit_, (exit_[0] + (n[0] + u[0]) * L, exit_[1] + (n[1] + u[1]) * L)] if abs(n[0] * u[0] + n[1] * u[1]) < 0.5 else [p, (p[0] + n[0] * (half + d), p[1] + n[1] * (half + d))])
                else:      # straight out first; where that is blocked, a 45-degree leg either way (a dogbone), one depth at a time
                    tries.append([p, (p[0] + n[0] * (half + d), p[1] + n[1] * (half + d))])
                    if kind == "via" and not side_job:      # a side rule keeps every pin on its own lane: no leg across a neighbour
                        exit_ = (p[0] + n[0] * (half + 0.15), p[1] + n[1] * (half + 0.15)); L = max(0.1, d - 0.15)
                        for sg in (1, -1):
                            tries.append([p, exit_, (exit_[0] + (n[0] - sg * n[1]) * L, exit_[1] + (n[1] + sg * n[0]) * L)])
        why = None; cheapest = None
        vs = small_via if pin in small and small_via else (None, None)
        for i_, pts in enumerate(tries):
            pts = [(round(x, 4), round(y, 4)) for x, y in pts]
            try:
                ft = self.fits(net, track=list(pts), layer=layer, width=w_)
                fv = self.fits(net, via=pts[-1], size=vs[0], drill=vs[1]) if kind == "via" else {"fits": True}
            except HarnessError as e:
                why = str(e)[:120]
                continue
            if ft.get("fits") and fv.get("fits"):
                self.track(net, [list(x) for x in pts], layer=layer, width=w_)
                if kind == "via":
                    self.via(net, list(pts[-1]), size=vs[0], drill=vs[1])
                self.flush()
                out["laid"] += 1
                why = None
                break
            blk = (ft.get("blocked_by") or []) + (fv.get("blocked_by") or [])
            why = "blocked by " + ", ".join(sorted({(b.get("ref") or b.get("net") or b.get("kind") or "?") for b in blk})[:4])
            if pin in clear and blk and all(b.get("kind") in ("segment", "arc", "via") and b.get("net") != net and b.get("id") in before and not _kept_net(b.get("net") or "") for b in blk):
                ids = {b["id"]: b.get("net") for b in blk}
                cost = len(ids) + 0.1 * i_
                if cheapest is None or cost < cheapest[0]:
                    cheapest = (cost, pts, ids)
        if why and cheapest is not None:      # "clear": the spot with the fewest tracks and vias in the way; those come up
            _, pts, ids = cheapest
            for i_, nt in ids.items():
                with contextlib.suppress(HarnessError):
                    self._edit({"op": "remove", "id": i_})
                if nt and nt not in out["moved"]:
                    out["moved"].append(nt)
            self.flush()
            self.track(net, [list(x) for x in pts], layer=layer, width=w_)
            if kind == "via":
                self.via(net, list(pts[-1]), size=vs[0], drill=vs[1])
            self.flush()
            out["laid"] += 1
            why = None
        if why:
            out["skipped"][pin] = why
    self._geom = None
    return out


_PAIR = re.compile(r"(^|[/_(-])(D[PN]|D[+-]|USB_?D[PN+-]|[A-Z0-9]+_[PN])\)?$", re.I)


def _kept_net(net: str) -> bool:
    """Copper an escape never takes up: ground, supplies (they join on their own layer before dropping to a plane),
    differential pairs, crystal and antenna lines."""
    return not net or bool(_GROUNDISH.match(net)) or _sup_name(net) or bool(_PAIR.search(net)) or bool(_NO_FAN.search(net))


def _isnum(w: str) -> bool:
    try:
        float(w)
        return True
    except ValueError:
        return False


def _unbox(self, refs: list | None = None, budget_s: float = 900, time_s: float = 40, sideways: int = 3, layers: list | None = None,
           keep_rules: bool = True, log=None) -> dict:
    """Free the pins of fine-pitch chips that routing left boxed in, with dogbones the way the routing AI lays them
    by hand (keep-best).  For each open pin of a chip (20 connected pins or more, 0.65 mm pitch or finer), in turn:
    - a dogbone trio: the pin to a via 0.5 mm past its pad and its two neighbours to vias 1.1 mm out, staggered, on
      0.1 mm stubs straight out (what passes beside a via at 0.4 mm pitch), the tracks and vias in the way taken up;
    - the same the other way round (the pin out at 1.1, its neighbours at 0.5);
    - the pin alone, to a via 0.6 then 1.0 mm out (straight, or a 45-degree leg), clearing its way;
    - when the open gap lies away from the pin (between two pieces of the net's copper), the net taken up whole and
      laid again from a trio;
    then only the try's own nets are routed again, the pin's first: the trio's nets, what an escape took up and what
    the try left open (board.route(nets=..., plan={"escapes": ..., "order": [...]}, ripup="ladder")); the other open
    nets stay as they are, so a try on a large board costs seconds of routing, not a whole-board pass.  A try stays when fewer connections are open (at the same count, fewer
    rules errors); up to `sideways` tries that leave as many open, no more than two errors more, and a set of open
    nets never seen before also stay, so the next try can work on the pin the blockage moved to.  Neighbours on ground,
    a supply, a differential pair, a crystal or an antenna line are left alone, and so is their copper.
    Measured on the benchmark's routed Cyberboard (U4, STM32WB QFN-68 at 0.4 mm, turned 45 degrees): 6 -> 3 open in
    12 tries, 7.5 minutes.  Returns {"before", "after", "tried": [one line per try], "kept": [...]}."""
    import time as _t
    t0 = _t.time()
    start = best = _standing(self)
    seen = {frozenset(self.unrouted())}
    tried, kept, done = [], [], set()
    parts = {p["ref"]: p for p in self.geometry()["parts"]}
    chips = {}
    for ref, part in parts.items():
        if refs and ref not in refs:
            continue
        fr = _chip_frame(part)
        if not fr:
            continue
        c, normals, rows, _ = fr
        for k, row in rows.items():
            srt = sorted(row, key=lambda q: (q[1] - c[0]) * -normals[k][1] + (q[2] - c[1]) * normals[k][0])
            for i, q in enumerate(srt):
                chips.setdefault(ref, {})[q[0]] = (i, srt)
    say = log or (lambda s: None)
    while chips and _t.time() - t0 < budget_s:
        left = set(self.unrouted())
        cands = []
        for v in self._call("run_checks").get("violations", []):
            if v.get("code") != "unconnected_items":
                continue
            m = re.search(r"net '((?:[^'\\]|\\.)*)'", v.get("message", ""))
            if not m or _kept_net(m.group(1)):
                continue
            # the chip pins of the open net, whether the gap is at the pin or between two pieces of its copper
            for r in chips:
                for num, (i, srt) in chips[r].items():
                    if srt[i][3] != m.group(1):
                        continue
                    net = srt[i][3]
                    nb = [srt[j] for j in (i - 1, i + 1) if 0 <= j < len(srt) and srt[j][3] and not _kept_net(srt[j][3]) and not srt[j][3].startswith("unconnected-")]
                    for mid, side in ((0.5, 1.1), (1.1, 0.5)):
                        if nb:
                            cands.append(({f"{r}.{num}": f"via {mid} thin clear", **{f"{r}.{q[0]}": f"via {side} thin clear" for q in nb}}, [net] + [q[3] for q in nb]))
                    for d in (0.6, 1.0):
                        cands.append(({f"{r}.{num}": f"via {d} clear"}, [net]))
                    if not (set(v.get("refs") or []) & {r}) and nb:      # the gap is away from the pin: the net comes up whole and leaves by a trio
                        cands.append(({f"{r}.{num}": "via 0.5 thin clear", **{f"{r}.{q[0]}": "via 1.1 thin clear" for q in nb}, "take up": net}, [net] + [q[3] for q in nb]))
        shape0 = frozenset(left)
        cands = [cd for cd in cands if (shape0, tuple(sorted(cd[0].items()))) not in done]
        if not cands:
            break
        moved = False
        for esc, order in cands:
            if _t.time() - t0 > budget_s:
                tried.append("budget spent")
                break
            done.add((shape0, tuple(sorted(esc.items()))))
            t1 = _t.time()
            try:
                with self.trial() as tr:
                    esc_ = {k: v for k, v in esc.items() if k != "take up"}
                    if esc.get("take up"):
                        self.unroute(esc["take up"])
                    with contextlib.suppress(HarnessError):
                        self.route(nets=sorted(set(order) | (set(self.unrouted()) - left)), fill=False, keep_rules=keep_rules, layers=layers, ground_vias=False, time_s=time_s,
                                   ripup="ladder", plan={"escapes": esc_, "order": order})
                    now = _standing(self); shape = frozenset(self.unrouted())
                    tr.keep = now[0] < best[0] or (now[0] == best[0] and now[1] < best[1])
                    side = not tr.keep and sideways > 0 and now[0] == best[0] and now[1] <= best[1] + 2 and shape not in seen
                    if side:
                        tr.keep = True; sideways -= 1
                    tried.append(f"{', '.join(f'{k} {v}' for k, v in esc.items())}: open {best[0]} -> {now[0]}, errors {best[1]} -> {now[1]}"
                                 + (" (sideways)" if side else "") + f" ({round(_t.time() - t1)} s)")
                    say(tried[-1])
            except Exception as e:      # noqa: BLE001  a try that fails is taken back by the trial
                tried.append(f"{esc}: failed, taken back ({type(e).__name__}: {str(e)[:120]})")
                say(tried[-1])
                continue
            if tr.keep:
                kept.append(tried[-1]); best = now; seen.add(shape); moved = True
                break
        if not moved:
            break
    self.project.note(f"board: unboxed fine-pitch chip pins, open connections {start[0]} -> {best[0]}")
    return {"before": start[0], "after": best[0], "tried": tried, "kept": kept}


def _sup_name(net: str) -> bool:
    from .rules import _SUPPLY
    return bool(_SUPPLY.match(net) or _SUPPLY.match(net.lstrip("/")))


def _partner(net: str, nets) -> str | None:
    """The other line of a differential pair (DP / DN, D+ / D-, X_P / X_N), when the board has it."""
    for a, c in (("DP", "DN"), ("D+", "D-"), ("_P", "_N"), ("P", "N")):
        for x, y in ((a, c), (c, a)):
            if net.endswith(x) and net[: -len(x)] + y in nets:
                return net[: -len(x)] + y
    return None


# the tries board.untangle() makes round one open end, the least disturbance first: (radius mm, what may come up
# besides signals within the radius: "supplies" (their copper there too), "pairs" (a differential pair in reach, whole,
# laid again coupled), "net" (the open net whole: a piece left dangling elsewhere comes up too); the escape laid for
# the open pin or None)
UNTANGLE_TIERS = (
    (1.0, "", None),
    (1.5, "supplies", None),
    (1.5, "supplies net", None),
    (1.5, "supplies pairs", None),
    (1.5, "supplies net", "via 0.6 clear small"),
    (1.5, "supplies net", "via 1.1 clear small"),
    (2.5, "supplies pairs net", None),
    (2.5, "supplies net", "via 0.8 clear small"),
)


def _open_ends(self) -> list:
    """Every open connection as the rules check reports it: (net, x, y, refs)."""
    out = []
    for v in self._call("run_checks").get("violations", []):
        if v.get("code") != "unconnected_items":
            continue
        m = re.search(r"net '((?:[^'\\]|\\.)*)'", v.get("message", ""))
        if m and v.get("x") is not None:
            out.append((m.group(1), float(v["x"]), float(v["y"]), list(v.get("refs") or [])))
    return out


def _untangle(self, nets: list | None = None, refs: list | None = None, budget_s: float = 600, time_s: float = 8, tiers=None,
              sideways: int = 2, follow: int = 2, keep_rules: bool = True, layers: list | None = None, ripup: str | None = None, log=None) -> dict:
    """Close the connections a finished board still leaves open by laying the copper round each open end again,
    locally: a try takes up only the copper within a few mm of the open end and routes only the nets it took up (and
    the open one, first), so it costs seconds, not a whole-board route (Ember: 15 to 40 s a try against 100 s).

    For each open end (the rules check's spot; refs= or nets= narrow it), the tries in UNTANGLE_TIERS, the least
    disturbance first: the signal copper within 1 mm; within 1.5 mm with the supplies' escapes too (a supply's stub
    and via between two signal pins is what boxes them in on a 0.4 mm QFN: Cyberboard's SWDIO between +3.3V and the
    USB pair); the same with a differential pair in reach taken up whole and laid again coupled; the open pin's own
    escape to a via 0.6 or 1.1 mm out, clearing what is in the way (board.escape "via D clear"); then 2.5 mm.  Ground
    copper never comes up.  Each try runs in board.trial() and stays only when fewer connections are open (at the same
    count, fewer rules errors); up to `sideways` tries that leave as many open but a set of open nets not seen before
    also stay, so the next pass works on where the blockage moved.  Rules errors are counted (a DRC, ~10 s) only for a
    try that is not already worse.  It loops until a pass keeps nothing or budget_s is spent.

    tiers=[(radius, "" | "supplies" | "pairs", escape or None), ...] replaces the default tries.  time_s is the
    router's budget per try (work done, not the clock).  Returns {"before", "after", "tried": [one line per try],
    "kept": [...]}; call board.fix_corners() and board.finish() after it, as after any routing."""
    import time as _t
    t0 = _t.time()
    tiers = list(tiers or UNTANGLE_TIERS)
    say = log or (lambda s: None)
    all_nets = set(self.nets())
    want_nets = {self._net(n) for n in nets} if nets else None

    def count():
        with contextlib.suppress(HarnessError):
            self.fill()
        return int(self.info().get("unrouted_connections") or 0)

    def errors():
        by = (self.check(limit=0, refill=False) or {}).get("by_kind") or {}
        return sum(v for k, v in by.items() if k != "unconnected_items")

    def ends_of(net, x, y, rs):
        """The open end the check names, then the net's other pads on the parts it names within 4 mm (a connection
        between two pins of one chip is open at both): [(x, y, pin or None)], the spot first."""
        pads = []
        for r in rs:
            with contextlib.suppress(HarnessError):
                pads += [(math.hypot(q["x"] - x, q["y"] - y), q["x"], q["y"], f"{r}.{q['number']}") for q in self.pads(r) if q.get("net") == net]
        pads.sort()
        out = [(x, y, pads[0][3] if pads and pads[0][0] < 0.5 else None)]
        out += [(px, py, pin) for d, px, py, pin in pads if 0.5 <= d <= 4.0][:2]
        return out

    def lay_round(net, x, y, pin, radius, extra, esc, protect=()):
        """One local try: take up the copper round (x, y) (what `extra` allows), lay `esc` for the pin, route the nets
        taken up with `net` first.  Returns (nets routed, nets taken up whole, ids removed)."""
        taken, whole, ids = {net}, set(), []
        for it in self.whats_at((x, y), radius=radius):
            n = it.get("net")
            if it["kind"] not in ("segment", "arc", "via") or not n or _GROUNDISH.match(n) or n in protect:
                continue
            if _PAIR.search(n):
                if "pairs" in extra:
                    whole.add(n)
                    if _partner(n, all_nets):
                        whole.add(_partner(n, all_nets))
                continue
            if _kept_net(n) and not ("supplies" in extra and _sup_name(n)):
                continue
            ids.append(it["id"]); taken.add(n)
        for i in ids:
            with contextlib.suppress(HarnessError):
                self._edit({"op": "remove", "id": i})
        self.flush()
        if "net" in extra and not _kept_net(net):
            whole.add(net)
        if whole:
            self.unroute(*sorted(whole), keep=())
            taken |= whole
        if esc and pin:
            with contextlib.suppress(HarnessError):
                taken |= set(_escape(self, {pin: esc}).get("moved") or [])
        with contextlib.suppress(HarnessError):
            self.route(nets=sorted(taken), order=sorted(whole - {net}) + [net], fill=False, keep_rules=keep_rules, layers=layers,
                       ground_vias=False, time_s=time_s, ripup=ripup)
        return taken, whole, ids

    start = best = (count(), errors())
    seen = {frozenset(self.unrouted())}
    tried, kept, done = [], [], set()
    while _t.time() - t0 < budget_s:
        moved = False
        for net, x, y, rs in _open_ends(self):
            if _GROUNDISH.match(net) or (want_nets and net not in want_nets) or (refs and not set(rs) & set(refs)):
                continue
            shape0 = frozenset(self.unrouted())
            for (x, y, pin), (radius, extra, esc) in ((e, t) for e in ends_of(net, x, y, rs) for t in tiers):
                if _t.time() - t0 > budget_s:
                    break
                if esc and not pin:
                    continue
                key = (shape0, net, round(x, 2), round(y, 2), radius, extra, esc)
                if key in done:
                    continue
                done.add(key)
                t1 = _t.time()
                try:
                    with self.trial() as tr:
                        taken, whole, ids = lay_round(net, x, y, pin, radius, extra, esc, protect=())
                        # what the try left open that was routed before gets one follow-up of its own (its end, 1 mm,
                        # signals and supplies, the net this try freed left alone): a depth-two search, still local
                        for _ in range(follow):
                            fresh = set(self.unrouted()) - shape0
                            if not fresh:
                                break
                            for n2, x2, y2, rs2 in _open_ends(self):
                                if n2 in fresh:
                                    t2, w2, i2 = lay_round(n2, x2, y2, None, 1.0, "supplies", None, protect={net})
                                    ids += i2; taken |= t2
                                    break
                        n_open = count()
                        shape = frozenset(self.unrouted())
                        now = (n_open, errors() if n_open <= best[0] else None)
                        better = now[1] is not None and (now[0] < best[0] or (now[0] == best[0] and now[1] < best[1]))
                        side = (not better and sideways > 0 and now[1] is not None and now[0] == best[0] and now[1] <= best[1] + 1 and shape not in seen)
                        tr.keep = better or side
                        line = (f"{net} at ({x:g}, {y:g}){' ' + pin if pin else ''}: {radius:g} mm{' + ' + extra if extra else ''}{', ' + esc if esc else ''}, "
                                f"{len(ids)} items{' + ' + ','.join(sorted(whole)) if whole else ''} up, {len(taken)} nets routed: open {best[0]} -> {now[0]}"
                                f"{' (' + ','.join(sorted(shape)) + ')' if shape and len(shape) <= 4 else ''}"
                                f", errors {best[1]} -> {now[1] if now[1] is not None else '-'}{' (sideways)' if side else ''} ({round(_t.time() - t1)} s)")
                        tried.append(line); say(line)
                except Exception as e:      # noqa: BLE001  a try that fails is taken back by the trial
                    tried.append(f"{net} {radius} {extra} {esc}: failed, taken back ({type(e).__name__}: {str(e)[:120]})")
                    say(tried[-1])
                    continue
                if tr.keep:
                    if side:
                        sideways -= 1
                    kept.append(line); best = (now[0], now[1]); seen.add(shape); moved = True
                    break
            if moved:
                break      # the open list changed: read it again
        if not moved:
            break
    self.project.note(f"board: untangled open ends locally, open connections {start[0]} -> {best[0]}")
    return {"before": start[0], "after": best[0], "tried": tried, "kept": kept}


def install(Board) -> None:
    Board.design = _design
    Board.brief = _brief
    Board.fanout = _fanout
    Board.escape_chips = _escape_chips
    Board.channels = _channels
    Board.escape = _escape
    Board.unbox = _unbox
    Board.untangle = _untangle
